import { ObjectId } from 'mongodb';
import { dateRange } from './dates.js';
import { db } from './db.js';
import { LEGACY_AGENT, TOKEN_FIELDS } from './ingest.js';

// Shared with export.js so every sheet sums exactly the same fields as the dashboard.
export const USAGE_FIELDS = [...TOKEN_FIELDS, 'totalTokens', 'sessions'];
export const sumUsage = () => Object.fromEntries(USAGE_FIELDS.map((f) => [f, { $sum: `$${f}` }]));
export const keepUsage = () => Object.fromEntries(USAGE_FIELDS.map((f) => [f, 1]));

// Usage trend: slope of a least-squares line through each user's daily tokens. A trend line that rises or falls
// by at least this share of the user's average daily usage over the range counts as increasing / decreasing.
export const TREND_THRESHOLD = 0.2;
// Fewer days than this give no meaningful line.
const TREND_MIN_DAYS = 3;

// Report metadata without the per-day arrays.
const REPORT_LIST_PROJECTION = {
  user: 1, machineId: 1, hostname: 1, receivedAt: 1, generatedAt: 1, timezone: 1, ccusageVersion: 1,
  since: 1, until: 1, periodTotal: 1, 'agents.agent': 1, 'agents.periodTotal': 1,
};

/** Reports stored before agents existed carry only Claude Code usage. */
const withAgents = (report) => ({ ...report, agents: report.agents ?? [{ agent: LEGACY_AGENT, periodTotal: report.periodTotal }] });

/**
 * All dashboard statistics for [since, until] (inclusive, YYYY-MM-DD), optionally for one user and one agent.
 * Everything is derived from per-day totals; usage from all of a user's machines (and agents, unless one is
 * picked) is summed. Machines list every machine whatever the agent filter.
 */
export async function getStats({ since, until, user, agent }) {
  const userMatch = user ? { user } : {};
  const dailyMatch = { $match: { ...userMatch, ...(agent ? { agent } : {}), date: { $gte: since, $lte: until } } };
  const daily = db.collection('daily');

  const [totals, byDateUser, users, machines, names, byAgent, byUserAgent] = await Promise.all([
    daily
      .aggregate([
        dailyMatch,
        {
          $group: {
            _id: null,
            ...sumUsage(),
            users: { $addToSet: '$user' },
            dates: { $addToSet: '$date' },
          },
        },
        { $project: { _id: 0, ...keepUsage(), activeUsers: { $size: '$users' }, activeDays: { $size: '$dates' } } },
      ])
      .toArray(),
    daily
      .aggregate([
        dailyMatch,
        { $group: { _id: { date: '$date', user: '$user' }, totalTokens: { $sum: '$totalTokens' } } },
        { $project: { _id: 0, date: '$_id.date', user: '$_id.user', totalTokens: 1 } },
        { $sort: { date: 1, user: 1 } },
      ])
      .toArray(),
    daily
      .aggregate([
        dailyMatch,
        { $group: { _id: '$user', ...sumUsage(), dates: { $addToSet: '$date' }, machines: { $addToSet: { machineId: '$machineId', hostname: '$hostname' } }, hostnames: { $addToSet: '$hostname' }, lastDate: { $max: '$date' } } },
        { $project: { _id: 0, user: '$_id', ...keepUsage(), activeDays: { $size: '$dates' }, machines: { $size: '$machines' }, hostnames: 1, lastDate: 1 } },
        { $sort: { totalTokens: -1 } },
      ])
      .toArray(),
    db
      .collection('reports')
      .aggregate([
        { $match: userMatch },
        // Same order as the { user, machineId, hostname, receivedAt } index, so $first is still each machine's latest report.
        { $sort: { user: 1, machineId: 1, hostname: 1, receivedAt: -1 } },
        { $project: REPORT_LIST_PROJECTION },
        { $group: { _id: { user: '$user', machineId: '$machineId', hostname: '$hostname' }, last: { $first: '$$ROOT' }, count: { $sum: 1 } } },
        { $replaceRoot: { newRoot: { $mergeObjects: ['$last', { reports: '$count' }] } } },
        { $sort: { user: 1, receivedAt: -1 } },
      ])
      .toArray(),
    nameMap(userMatch),
    daily
      .aggregate([
        dailyMatch,
        { $group: { _id: '$agent', ...sumUsage(), users: { $addToSet: '$user' } } },
        { $project: { _id: 0, agent: '$_id', ...keepUsage(), activeUsers: { $size: '$users' } } },
        { $sort: { totalTokens: -1 } },
      ])
      .toArray(),
    daily
      .aggregate([
        dailyMatch,
        { $group: { _id: { user: '$user', agent: '$agent' }, totalTokens: { $sum: '$totalTokens' } } },
      ])
      .toArray(),
  ]);
  const withName = (row) => ({ ...row, name: names.get(row.user) ?? null });
  // user id -> { agent: tokens } over the range.
  const agentTokens = new Map();
  for (const { _id, totalTokens } of byUserAgent) {
    if (!agentTokens.has(_id.user)) agentTokens.set(_id.user, {});
    agentTokens.get(_id.user)[_id.agent] = totalTokens;
  }
  const trend = userTrends(byDateUser, since, until);

  const t = totals[0] ?? { ...Object.fromEntries(USAGE_FIELDS.map((f) => [f, 0])), activeUsers: 0, activeDays: 0 };
  const cacheBase = t.cacheReadTokens + t.cacheCreationTokens + t.inputTokens;

  return {
    range: { since, until },
    user: user ?? null,
    agent: agent ?? null,
    totals: {
      ...t,
      cacheHitRate: cacheBase ? t.cacheReadTokens / cacheBase : 0,
    },
    byDateUser,
    byAgent,
    users: users.map((u) => ({ ...withName(u), agents: agentTokens.get(u.user) ?? {} })),
    machines: machines.map((m) => withAgents(withName(m))),
    trend: trend && { ...trend, users: trend.users.map(withName) },
  };
}

/**
 * All-time usage per user, split by calendar month (YYYY-MM), optionally for one user and one agent (without it,
 * all agents summed). Independent of the dashboard's date range: it answers "how much has each person used since
 * they started". `start` is the user's first month with usage; the dashboard groups people by it.
 */
export async function getCumulative({ user, agent }) {
  const userMatch = user ? { user } : {};
  const [rows, names] = await Promise.all([
    db
      .collection('daily')
      .aggregate([
        { $match: { ...userMatch, ...(agent ? { agent } : {}), totalTokens: { $gt: 0 } } },
        {
          $group: {
            _id: { user: '$user', month: { $substrBytes: ['$date', 0, 7] } },
            totalTokens: { $sum: '$totalTokens' },
            firstDate: { $min: '$date' },
            lastDate: { $max: '$date' },
          },
        },
      ])
      .toArray(),
    nameMap(userMatch),
  ]);

  const byUser = new Map();
  for (const { _id, totalTokens, firstDate, lastDate } of rows) {
    if (!byUser.has(_id.user)) byUser.set(_id.user, { user: _id.user, months: {}, totalTokens: 0, firstDate, lastDate });
    const u = byUser.get(_id.user);
    u.months[_id.month] = totalTokens;
    u.totalTokens += totalTokens;
    if (firstDate < u.firstDate) u.firstDate = firstDate;
    if (lastDate > u.lastDate) u.lastDate = lastDate;
  }
  const users = [...byUser.values()]
    .map((u) => ({ ...u, name: names.get(u.user) ?? null, start: u.firstDate.slice(0, 7) }))
    .sort((a, b) => a.start.localeCompare(b.start) || b.totalTokens - a.totalTokens || a.user.localeCompare(b.user));

  const firstDate = users.reduce((m, u) => (!m || u.firstDate < m ? u.firstDate : m), null);
  const lastDate = users.reduce((m, u) => (!m || u.lastDate > m ? u.lastDate : m), null);
  return { user: user ?? null, agent: agent ?? null, firstDate, lastDate, months: firstDate ? monthRange(firstDate, lastDate) : [], users };
}

/** Every YYYY-MM from the month of `since` to the month of `until`, inclusive (months without usage included). */
function monthRange(since, until) {
  const months = [];
  let [y, m] = since.split('-').map(Number);
  const end = until.slice(0, 7);
  for (;;) {
    const month = `${y}-${String(m).padStart(2, '0')}`;
    months.push(month);
    if (month >= end) return months;
    if (++m > 12) [y, m] = [y + 1, 1];
  }
}

/**
 * Least-squares line through daily values (x = day index 0..n-1). Returns the slope per day and the line's
 * rise over the whole range relative to the average day (`change`, e.g. 0.35 = +35%).
 * public/app.js linearFit() draws the same line on the dashboard; change both together.
 */
function linearTrend(values) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const xMean = (n - 1) / 2;
  let sxy = 0;
  let sxx = 0;
  values.forEach((y, x) => {
    sxy += (x - xMean) * (y - mean);
    sxx += (x - xMean) ** 2;
  });
  const slope = sxx ? sxy / sxx : 0;
  return { slope, mean, change: mean ? (slope * (n - 1)) / mean : 0 };
}

/** Classifies each user by the trend line through their daily tokens (days without usage count as 0). */
function userTrends(byDateUser, since, until) {
  const dates = dateRange(since, until);
  if (dates.length < TREND_MIN_DAYS) return null;
  const index = new Map(dates.map((d, i) => [d, i]));
  const series = new Map();
  for (const row of byDateUser) {
    if (!series.has(row.user)) series.set(row.user, new Array(dates.length).fill(0));
    series.get(row.user)[index.get(row.date)] += row.totalTokens;
  }
  const users = [...series.entries()]
    .map(([user, values]) => {
      const { slope, mean, change } = linearTrend(values);
      const group = change >= TREND_THRESHOLD ? 'increasing' : change <= -TREND_THRESHOLD ? 'decreasing' : 'steady';
      return { user, mean, slope, changePct: change * 100, group };
    })
    .sort((a, b) => b.changePct - a.changePct || a.user.localeCompare(b.user));
  return { threshold: TREND_THRESHOLD, since, until, days: dates.length, users };
}

export async function listReports({ user, machineId, limit }) {
  const match = { ...(user ? { user } : {}), ...(machineId ? { machineId } : {}) };
  const reports = await db.collection('reports').find(match, { projection: REPORT_LIST_PROJECTION }).sort({ receivedAt: -1 }).limit(limit).toArray();
  return reports.map(withAgents);
}

export async function getReport(id) {
  if (!ObjectId.isValid(id)) return null;
  return db.collection('reports').findOne({ _id: new ObjectId(id) });
}

/**
 * The stored user id that belongs to a signed-in email. Ids are kept exactly as typed at setup, so the match
 * ignores case; an email nobody reported with maps to itself (and so to no data).
 */
export async function userIdForEmail(email) {
  const ids = await db.collection('reports').distinct('user');
  return ids.find((id) => id === email) ?? ids.find((id) => id.toLowerCase() === email) ?? email;
}

/** user id -> latest display name. */
async function nameMap(match = {}) {
  const rows = await db.collection('users').find(match, { projection: { _id: 0, user: 1, name: 1 } }).toArray();
  return new Map(rows.map((r) => [r.user, r.name]));
}

/**
 * Every user that ever reported with their display name, by all-time tokens - the stable order the dashboard
 * assigns colors from.
 */
export async function listUsers() {
  const [ranked, all, names] = await Promise.all([
    db
      .collection('daily')
      // Sorting by user first lets { user, totalTokens } answer the grouping from the index alone.
      .aggregate([{ $sort: { user: 1 } }, { $group: { _id: '$user', totalTokens: { $sum: '$totalTokens' } } }, { $sort: { totalTokens: -1, _id: 1 } }])
      .toArray(),
    db.collection('reports').distinct('user'),
    nameMap(),
  ]);
  const ids = ranked.map((r) => r._id);
  return [...ids, ...all.filter((u) => !ids.includes(u)).sort((a, b) => a.localeCompare(b))].map((user) => ({
    user,
    name: names.get(user) ?? null,
  }));
}
