import { dayCount, isCalendarDate } from './dates.js';
import { db } from './db.js';

export const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens'];
// Coding agents a report may carry (client/src/usage.js AGENTS; labels repeated in public/app.js and export.js).
// Reports before schemaVersion 4 only covered Claude Code.
export const AGENTS = ['claude', 'codex'];
export const LEGACY_AGENT = 'claude';
// Same rule as client/src/identity.js and public/app.js.
const USER_RE = /^[\w.%+@-]{1,200}$/;
const MACHINE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const NAME_MAX = 50;
const CONTROL_RE = /[\p{Cc}\p{Cf}]/u;
const MAX_ROWS = 5000;

export class ValidationError extends Error {}

const fail = (message) => {
  throw new ValidationError(message);
};

function str(value, name, { max = 300, optional = false } = {}) {
  if (value == null && optional) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max || CONTROL_RE.test(value)) {
    fail(`${name} must be a non-empty string (<= ${max} chars) without control characters`);
  }
  return value.trim();
}

/** Non-negative count (a safe integer by default), so totals can never overflow to Infinity. */
function num(value, name, { integer = true, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = value ?? 0;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > max || (integer && !Number.isInteger(n))) {
    fail(`${name} must be a non-negative ${integer ? 'integer' : 'number'} (<= ${max})`);
  }
  return n;
}

/** Required display name such as a Korean name ("조휘열"): NFC-normalized, whitespace collapsed. */
function normalizeName(value) {
  if (value == null) fail('name is required (set it with: cc-usage setup --name <이름>)');
  if (typeof value !== 'string') fail('name must be a string');
  const name = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (!name) fail('name is required (set it with: cc-usage setup --name <이름>)');
  if ([...name].length > NAME_MAX || CONTROL_RE.test(name)) fail(`name must be at most ${NAME_MAX} characters without control characters`);
  return name;
}

function day(value, name) {
  if (!isCalendarDate(value)) fail(`${name} must be a valid YYYY-MM-DD date`);
  return value;
}

function list(value, name) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_ROWS) fail(`${name} must be an array (<= ${MAX_ROWS} items)`);
  return value;
}

function usage(row, name) {
  if (!row || typeof row !== 'object') fail(`${name} must be an object`);
  const out = {};
  for (const f of TOKEN_FIELDS) out[f] = num(row[f], `${name}.${f}`);
  out.totalTokens = TOKEN_FIELDS.reduce((sum, f) => sum + out[f], 0);
  if (!Number.isSafeInteger(out.totalTokens)) fail(`${name} token total is too large`);
  return out;
}

function timestamp(value, name) {
  if (value == null) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) fail(`${name} must be a date`);
  return d;
}

/** One agent's per-day totals and period total, checked against the report window. */
function agentUsage(source, name, { since, until, schemaVersion }) {
  const dailyTotals = list(source.dailyTotals, `${name}dailyTotals`).map((d, i) => {
    const at = `${name}dailyTotals[${i}]`;
    if (!d || typeof d !== 'object' || Array.isArray(d)) fail(`${at} must be an object`);
    const date = day(d.date, `${at}.date`);
    if (date < since || date > until) fail(`${at}.date is outside range`);
    return { date, ...usage(d, at), sessions: num(d.sessions, `${at}.sessions`) };
  });
  if (new Set(dailyTotals.map((d) => d.date)).size !== dailyTotals.length) fail(`${name}dailyTotals has duplicate dates`);

  const pt = source.periodTotal;
  const periodTotal = {
    ...usage(pt, `${name}periodTotal`),
    activeDays: num(pt.activeDays, `${name}periodTotal.activeDays`),
    cacheHitRate: num(pt.cacheHitRate, `${name}periodTotal.cacheHitRate`, { integer: false, max: 1 }),
    sessions: schemaVersion >= 2 ? num(pt.sessions, `${name}periodTotal.sessions`) : dailyTotals.reduce((n, d) => n + d.sessions, 0),
  };
  return { periodTotal, dailyTotals };
}

/** The report's period total over all of its agents (active days counted once). */
function combinedTotal(agents) {
  const total = Object.fromEntries([...TOKEN_FIELDS, 'totalTokens', 'sessions'].map((f) => [f, agents.reduce((n, a) => n + a.periodTotal[f], 0)]));
  if (!Number.isSafeInteger(total.totalTokens)) fail('token total is too large');
  const cacheBase = total.cacheReadTokens + total.cacheCreationTokens + total.inputTokens;
  return {
    ...total,
    activeDays: new Set(agents.flatMap((a) => a.dailyTotals.filter((d) => d.totalTokens > 0).map((d) => d.date))).size,
    cacheHitRate: cacheBase ? total.cacheReadTokens / cacheBase : 0,
  };
}

/**
 * Validates the body produced by the cc-usage client. Only aggregate token and session counts are accepted:
 *   v4:   { schemaVersion, user, name, machineId, hostname, timezone, meta, range, agents: [{ agent, periodTotal, dailyTotals[] }] }
 *   v1-3: the same with a single top-level periodTotal / dailyTotals[], which are Claude Code usage.
 * Cost and the detail sections sent by older clients (models, projects, sessions, billing blocks) are ignored,
 * never stored.
 */
export function parseReport(body) {
  if (!body || typeof body !== 'object') fail('body must be a JSON object');
  const { schemaVersion } = body;
  if (![1, 2, 3, 4].includes(schemaVersion)) fail('unsupported schemaVersion (expected 4)');
  const user = str(body.user, 'user', { max: 200 });
  if (!USER_RE.test(user)) fail('user may only contain letters, digits and . _ % + @ - (e.g. name@example.com)');
  const machineId = str(body.machineId, 'machineId', { max: 128 });
  if (!MACHINE_ID_RE.test(machineId)) fail('machineId must be 8-128 chars of [A-Za-z0-9_-]');
  const name = normalizeName(body.name);

  const since = day(body.range?.since, 'range.since');
  const until = day(body.range?.until, 'range.until');
  if (since > until) fail('range.since must be <= range.until');
  // Bounded window: storing a report replaces this machine's days in the range, so an unbounded range could wipe
  // its whole history. Real clients send at most a few hundred days.
  if (dayCount(since, until) > MAX_ROWS) fail(`range must be at most ${MAX_ROWS} days`);

  const window = { since, until, schemaVersion };
  let agents;
  if (schemaVersion >= 4) {
    if (!Array.isArray(body.agents) || !body.agents.length || body.agents.length > AGENTS.length) {
      fail(`agents must be a non-empty array (<= ${AGENTS.length} items)`);
    }
    agents = body.agents.map((a, i) => {
      if (!a || typeof a !== 'object' || Array.isArray(a)) fail(`agents[${i}] must be an object`);
      if (!AGENTS.includes(a.agent)) fail(`agents[${i}].agent must be one of ${AGENTS.join(', ')}`);
      return { agent: a.agent, ...agentUsage(a, `agents[${i}].`, window) };
    });
    if (new Set(agents.map((a) => a.agent)).size !== agents.length) fail('agents has duplicate agents');
  } else {
    agents = [{ agent: LEGACY_AGENT, ...agentUsage(body, '', window) }];
  }

  return {
    user,
    name,
    machineId,
    hostname: str(body.hostname, 'hostname', { max: 200, optional: true }),
    timezone: str(body.timezone, 'timezone', { max: 100, optional: true }),
    ccusageVersion: str(body.meta?.ccusageVersion, 'meta.ccusageVersion', { max: 50, optional: true }),
    generatedAt: timestamp(body.meta?.generatedAt, 'meta.generatedAt'),
    since,
    until,
    periodTotal: combinedTotal(agents),
    agents,
  };
}

/**
 * Stores a parsed report in three collections:
 * - `reports`: every submission is kept as received (period total over all agents, and each agent's period and
 *   per-day totals) as history. Reports stored before agents existed have top-level dailyTotals instead.
 * - `users`: each user's latest reported display name.
 * - `daily`: the current view used for statistics, keyed by user + machine (machineId + hostname) + agent, so each
 *   computer and agent a user reports from is kept separately and statistics sum them. The hostname is part of
 *   the key because cloned Linux images share /etc/machine-id. For a given machine and agent the most recently
 *   submitted window is authoritative for its days; an agent missing from a report keeps its days.
 */
export async function storeReport(report) {
  const { user, name, machineId, hostname, since, until } = report;
  const now = new Date();
  // null, not undefined, so reports without a hostname all match the same key.
  const machine = { user, machineId, hostname: hostname ?? null };

  const { insertedId } = await db.collection('reports').insertOne({
    ...machine,
    name,
    receivedAt: now,
    generatedAt: report.generatedAt,
    timezone: report.timezone,
    ccusageVersion: report.ccusageVersion,
    since,
    until,
    periodTotal: report.periodTotal,
    agents: report.agents,
  });

  // Every report carries a name; the latest one a user reported is the one shown.
  await db.collection('users').updateOne({ user }, { $set: { name, updatedAt: now } }, { upsert: true });

  // One ordered round trip: per agent, upsert the active days first, then remove days in the window that are now
  // zero. If the request fails part-way, a stale zero day may linger until the next upload, but no data is lost.
  const operations = [];
  for (const { agent, dailyTotals } of report.agents) {
    const key = { ...machine, agent };
    const active = dailyTotals.filter((d) => d.totalTokens > 0);
    operations.push(
      ...active.map((d) => ({
        replaceOne: {
          filter: { ...key, date: d.date },
          replacement: { ...key, ...d, reportId: insertedId, updatedAt: now },
          upsert: true,
        },
      })),
      { deleteMany: { filter: { ...key, date: { $gte: since, $lte: until, $nin: active.map((d) => d.date) } } } },
    );
  }
  await db.collection('daily').bulkWrite(operations, { ordered: true });

  return {
    reportId: insertedId,
    user,
    name,
    machineId,
    hostname,
    since,
    until,
    days: dayCount(since, until),
    activeDays: report.periodTotal.activeDays,
    sessions: report.periodTotal.sessions,
    totalTokens: report.periodTotal.totalTokens,
    agents: report.agents.map(({ agent, periodTotal }) => ({ agent, totalTokens: periodTotal.totalTokens, sessions: periodTotal.sessions })),
  };
}
