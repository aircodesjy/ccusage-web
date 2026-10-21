import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens'];
const DAY = 86_400_000;
export const SCHEMA_VERSION = 4;

/**
 * Coding agents collected, by ccusage subcommand (same ids as AGENTS in server/src/ingest.js). Claude Code is
 * required; any other agent that fails is left out of the report, so the server keeps its earlier days.
 */
export const AGENTS = [
  // Session start: the first message.
  { id: 'claude', label: 'Claude Code', required: true, startDate: (s) => s.firstActivity ?? s.lastActivity },
  // Codex sessions have no first activity, but live in sessions/YYYY/MM/DD named by their local start date.
  { id: 'codex', label: 'Codex', required: false, startDate: (s) => (/^\d{4}\/\d{2}\/\d{2}$/.test(s.directory ?? '') ? s.directory.replaceAll('/', '-') : s.lastActivity) },
];

/** The ccusage CLI bundled as a dependency (version pinned in package.json). */
export function ccusageInfo() {
  const packageFile = require.resolve('ccusage/package.json');
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.ccusage;
  return { version: pkg.version, bin: path.join(path.dirname(packageFile), bin) };
}

function runCcusage(agent, args) {
  const { bin } = ccusageInfo();
  const command = `ccusage ${agent} ${args.join(' ')}`;
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [bin, agent, ...args],
      { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 300_000, env: { ...process.env, NO_COLOR: '1' } },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(`${command} 실행 실패: ${(stderr || error.message).trim().slice(0, 500)}`));
        const start = stdout.indexOf('{'); // some versions print log lines before the JSON document
        if (start < 0) return reject(new Error(`${command} 결과에 JSON이 없습니다`));
        try {
          resolve(JSON.parse(stdout.slice(start)));
        } catch (parseError) {
          reject(new Error(`${command} 결과를 해석하지 못했습니다: ${parseError.message}`));
        }
      },
    );
  });
}

export const localTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** YYYY-MM-DD of an instant in the local timezone (the same grouping ccusage uses). */
const localDate = (value) => new Date(value).toLocaleDateString('en-CA');

const addDays = (isoDate, days) => new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/** One agent's per-day token totals and started sessions over [since, end], with its period total. */
async function collectAgent(agent, since, end) {
  const compact = (d) => d.replaceAll('-', '');
  const [daily, sessions] = await Promise.all([
    runCcusage(agent.id, ['daily', '--json', '--offline', '--since', compact(since), '--until', compact(end)]),
    // ccusage's own date filter drops sessions, so fetch all and count by local start date here.
    runCcusage(agent.id, ['session', '--json', '--offline']),
  ]);

  const started = new Map();
  for (const session of sessions.sessions ?? []) {
    const first = agent.startDate(session);
    if (!first) continue;
    const date = first.includes('T') ? localDate(first) : first.slice(0, 10);
    started.set(date, (started.get(date) ?? 0) + 1);
  }

  // Token fields mean the same for every agent: input excludes cached input, and Codex's reasoning tokens are
  // already part of its output, so the four fields add up to ccusage's totalTokens.
  const byDate = new Map((daily.daily ?? []).map((row) => [row.date, row]));
  const dailyTotals = [];
  for (let date = since; date <= end; date = addDays(date, 1)) {
    const row = byDate.get(date) ?? {};
    const tokens = Object.fromEntries(TOKEN_FIELDS.map((f) => [f, row[f] ?? 0]));
    dailyTotals.push({
      date,
      ...tokens,
      totalTokens: TOKEN_FIELDS.reduce((sum, f) => sum + tokens[f], 0),
      sessions: started.get(date) ?? 0,
    });
  }

  const sum = (field) => dailyTotals.reduce((total, d) => total + d[field], 0);
  const totals = Object.fromEntries([...TOKEN_FIELDS, 'totalTokens', 'sessions'].map((f) => [f, sum(f)]));
  const cacheBase = totals.cacheReadTokens + totals.cacheCreationTokens + totals.inputTokens;
  return {
    agent: agent.id,
    periodTotal: {
      ...totals,
      activeDays: dailyTotals.filter((d) => d.totalTokens > 0).length,
      cacheHitRate: cacheBase ? totals.cacheReadTokens / cacheBase : 0,
    },
    dailyTotals,
  };
}

/**
 * Collects the last `days` days (ending `until`, default today) for every agent and builds the upload body.
 * Only aggregate token and session counts leave the machine: no cost, models, projects or session details.
 * An optional agent that fails is reported through `warn` and left out.
 */
export async function buildReport({ days, until, identity, warn = () => {} }) {
  if (!Number.isInteger(days) || days < 1) throw new Error('--days는 1 이상의 정수여야 합니다');
  const end = until ?? localDate(Date.now());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new Error('--until은 YYYY-MM-DD 형식이어야 합니다');
  const since = addDays(end, -(days - 1));

  const results = await Promise.allSettled(AGENTS.map((agent) => collectAgent(agent, since, end)));
  const agents = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') agents.push(result.value);
    else if (AGENTS[i].required) throw result.reason;
    else warn(`${AGENTS[i].label} 사용량을 읽지 못해 이번 전송에서 뺐습니다: ${result.reason.message}`);
  });
  const timezone = localTimezone();

  return {
    schemaVersion: SCHEMA_VERSION,
    user: identity.user,
    ...(identity.name ? { name: identity.name } : {}),
    machineId: identity.machineId,
    hostname: os.hostname(),
    timezone,
    meta: { generatedAt: new Date().toISOString(), ccusageVersion: ccusageInfo().version, timezone },
    range: { since, until: end, days },
    agents,
  };
}

/** Totals across the report's agents, for the send summary and `status`. */
export function reportSummary(payload) {
  const agents = payload.agents.map(({ agent, periodTotal }) => ({ agent, totalTokens: periodTotal.totalTokens, sessions: periodTotal.sessions }));
  const activeDates = new Set(payload.agents.flatMap((a) => a.dailyTotals.filter((d) => d.totalTokens > 0).map((d) => d.date)));
  return {
    range: payload.range,
    totalTokens: agents.reduce((n, a) => n + a.totalTokens, 0),
    activeDays: activeDates.size,
    sessions: agents.reduce((n, a) => n + a.sessions, 0),
    agents,
  };
}
