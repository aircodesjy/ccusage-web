import ExcelJS from 'exceljs';
import { config } from './config.js';
import { dateRange } from './dates.js';
import { db } from './db.js';
import { AGENTS, LEGACY_AGENT } from './ingest.js';
import { getStats, keepUsage, sumUsage, TREND_THRESHOLD, USAGE_FIELDS } from './stats.js';

const TOKEN_COLUMNS = [
  { header: '전체 토큰', key: 'totalTokens' },
  { header: '입력 토큰', key: 'inputTokens' },
  { header: '출력 토큰', key: 'outputTokens' },
  { header: '캐시 생성 토큰', key: 'cacheCreationTokens' },
  { header: '캐시 읽기 토큰', key: 'cacheReadTokens' },
];
const GROUP_LABEL = { increasing: '증가', steady: '일정', decreasing: '감소' };
// Same labels as AGENT_LABEL in public/app.js.
const AGENT_LABEL = { claude: 'Claude Code', codex: 'Codex' };
const agentLabel = (agent) => AGENT_LABEL[agent] ?? agent;
const INTEGER = '#,##0';
const PERCENT = '0.0%';
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEC' } };

const REPORT_HISTORY_LIMIT = 20_000; // keeps one export's memory bounded
const timezone = config.reportTimezone;
const localTime = (value) => (value ? new Date(value).toLocaleString('sv-SE', { timeZone: timezone }) : '');

/**
 * Adds a sheet with a styled, frozen, filterable header. `columns` entries: { header, key, width, numFmt }.
 */
function addTable(workbook, name, columns, rows) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = columns.map(({ header, key, width, numFmt }) => ({
    header,
    key,
    width: width ?? Math.max(12, [...header].length * 2 + 2),
    style: numFmt ? { numFmt } : {},
  }));
  sheet.addRows(rows);
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.fill = HEADER_FILL;
  header.alignment = { vertical: 'middle' };
  if (rows.length) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return sheet;
}

const tokenColumns = () => TOKEN_COLUMNS.map((c) => ({ ...c, numFmt: INTEGER, width: 16 }));

/** Everything the dashboard shows for [since, until] (and optional user and agent), as a multi-sheet workbook. */
export async function buildWorkbook({ since, until, user, agent }) {
  const userMatch = user ? { user } : {};
  const match = { ...userMatch, ...(agent ? { agent } : {}), date: { $gte: since, $lte: until } };
  const dates = dateRange(since, until);

  const [stats, userDaily, dateTotals, reports, dateAgentTotals] = await Promise.all([
    getStats({ since, until, user, agent }),
    db
      .collection('daily')
      .aggregate([
        { $match: match },
        { $group: { _id: { date: '$date', user: '$user' }, ...sumUsage(), machines: { $addToSet: { machineId: '$machineId', hostname: '$hostname' } } } },
        { $project: { _id: 0, date: '$_id.date', user: '$_id.user', ...keepUsage(), machines: { $size: '$machines' } } },
        { $sort: { date: 1, user: 1 } },
      ])
      .toArray(),
    db
      .collection('daily')
      .aggregate([
        { $match: match },
        { $group: { _id: '$date', ...sumUsage(), users: { $addToSet: '$user' } } },
        { $project: { _id: 0, date: '$_id', ...keepUsage(), activeUsers: { $size: '$users' } } },
      ])
      .toArray(),
    db
      .collection('reports')
      .find({ ...userMatch, since: { $lte: until }, until: { $gte: since } }, { projection: { dailyTotals: 0, 'agents.dailyTotals': 0 } })
      .sort({ receivedAt: -1 })
      .limit(REPORT_HISTORY_LIMIT + 1)
      .toArray(),
    db
      .collection('daily')
      .aggregate([
        { $match: match },
        { $group: { _id: { date: '$date', agent: '$agent' }, ...sumUsage(), users: { $addToSet: '$user' } } },
        { $project: { _id: 0, date: '$_id.date', agent: '$_id.agent', ...keepUsage(), activeUsers: { $size: '$users' } } },
        { $sort: { date: 1, agent: 1 } },
      ])
      .toArray(),
  ]);
  const historyTruncated = reports.length > REPORT_HISTORY_LIMIT;
  if (historyTruncated) reports.length = REPORT_HISTORY_LIMIT;

  const names = new Map(stats.users.map((u) => [u.user, u.name]));
  for (const m of stats.machines) if (m.name) names.set(m.user, m.name);
  const nameOf = (id) => names.get(id) ?? '';
  const trendOf = new Map((stats.trend?.users ?? []).map((t) => [t.user, t]));
  const t = stats.totals;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'cc-usage server';
  workbook.created = new Date();

  // 1. Summary
  const groupCounts = Object.fromEntries(Object.keys(GROUP_LABEL).map((g) => [g, (stats.trend?.users ?? []).filter((u) => u.group === g).length]));
  const summary = workbook.addWorksheet('요약');
  summary.columns = [
    { header: '항목', key: 'label', width: 28 },
    { header: '값', key: 'value', width: 40 },
  ];
  const summaryRows = [
    ['기간', `${since} ~ ${until} (${dates.length}일)`],
    ['사용자 필터', user ? `${nameOf(user) ? `${nameOf(user)} ` : ''}<${user}>` : '전체 사용자'],
    ['에이전트 필터', agent ? agentLabel(agent) : `전체 에이전트 (${AGENTS.map(agentLabel).join(', ')})`],
    ['생성 시각', `${localTime(Date.now())} (${timezone})`],
    [],
    ['전체 토큰', t.totalTokens, INTEGER],
    ['입력 토큰', t.inputTokens, INTEGER],
    ['출력 토큰', t.outputTokens, INTEGER],
    ['캐시 생성 토큰', t.cacheCreationTokens, INTEGER],
    ['캐시 읽기 토큰', t.cacheReadTokens, INTEGER],
    ...stats.byAgent.map((a) => [`${agentLabel(a.agent)} 토큰`, a.totalTokens, INTEGER]),
    ['캐시 적중률 (캐시 읽기 / 전체 입력)', t.cacheHitRate, PERCENT],
    ['세션 (기간 중 시작)', t.sessions, INTEGER],
    ['활성 사용자', t.activeUsers, INTEGER],
    ['사용 기록이 있는 날', t.activeDays, INTEGER],
    [],
    ['추세 기준', stats.trend ? `사용자별 일별 토큰의 추세선(선형 회귀) 변화가 일평균 대비 ±${Math.round(TREND_THRESHOLD * 100)}%` : '기간이 3일 미만이라 계산하지 않음'],
    ['추세: 증가', groupCounts.increasing, INTEGER],
    ['추세: 일정', groupCounts.steady, INTEGER],
    ['추세: 감소', groupCounts.decreasing, INTEGER],
    [],
    ['참고', '비용, 프로젝트, 모델, 세션 내용은 수집하지 않습니다.'],
    ...(historyTruncated ? [['보고 이력', `최근 ${REPORT_HISTORY_LIMIT.toLocaleString('ko-KR')}건만 포함했습니다.`]] : []),
  ];
  for (const [label, value, numFmt] of summaryRows) {
    const row = summary.addRow({ label, value });
    if (numFmt) row.getCell('value').numFmt = numFmt;
    row.getCell('value').alignment = { horizontal: 'left' };
  }
  summary.getRow(1).font = { bold: true };
  summary.getRow(1).fill = HEADER_FILL;
  summary.getColumn('label').font = { bold: true };

  // 2. Users
  addTable(
    workbook,
    '사용자별',
    [
      { header: '이름', key: 'name', width: 14 },
      { header: '사용자 ID', key: 'user', width: 30 },
      ...tokenColumns(),
      ...AGENTS.map((a) => ({ header: `${agentLabel(a)} 토큰`, key: `agent_${a}`, numFmt: INTEGER, width: 18 })),
      { header: '세션', key: 'sessions', numFmt: INTEGER },
      { header: '사용한 날', key: 'activeDays', numFmt: INTEGER },
      { header: '사용일당 토큰', key: 'perActiveDay', numFmt: INTEGER, width: 16 },
      { header: '머신 수', key: 'machines', numFmt: INTEGER },
      { header: '호스트', key: 'hostnames', width: 30 },
      { header: '마지막 사용일', key: 'lastDate', width: 14 },
      { header: '추세', key: 'group' },
      { header: '추세 일평균 토큰', key: 'mean', numFmt: INTEGER, width: 18 },
      { header: '추세 기울기 (토큰/일)', key: 'slope', numFmt: INTEGER, width: 20 },
      { header: '추세 변화율', key: 'change', numFmt: PERCENT },
    ],
    stats.users.map((u) => {
      const trend = trendOf.get(u.user);
      return {
        ...u,
        ...Object.fromEntries(AGENTS.map((a) => [`agent_${a}`, u.agents[a] ?? 0])),
        name: u.name ?? '',
        perActiveDay: u.activeDays ? Math.round(u.totalTokens / u.activeDays) : 0,
        hostnames: u.hostnames.filter(Boolean).join(', '),
        group: trend ? GROUP_LABEL[trend.group] : '',
        mean: trend ? Math.round(trend.mean) : null,
        slope: trend ? Math.round(trend.slope) : null,
        change: trend ? trend.changePct / 100 : null,
      };
    }),
  );

  // 3. Daily totals (every day of the range, zero days included)
  const byDate = new Map(dateTotals.map((d) => [d.date, d]));
  addTable(
    workbook,
    '일별 합계',
    [{ header: '날짜', key: 'date', width: 12 }, ...tokenColumns(), { header: '세션', key: 'sessions', numFmt: INTEGER }, { header: '활성 사용자', key: 'activeUsers', numFmt: INTEGER }],
    dates.map((date) => byDate.get(date) ?? { date, activeUsers: 0, ...Object.fromEntries(USAGE_FIELDS.map((f) => [f, 0])) }),
  );

  // 3b. Agent x day, long format (days without usage left out)
  addTable(
    workbook,
    '에이전트별 일별',
    [
      { header: '날짜', key: 'date', width: 12 },
      { header: '에이전트', key: 'agent', width: 14 },
      ...tokenColumns(),
      { header: '세션', key: 'sessions', numFmt: INTEGER },
      { header: '활성 사용자', key: 'activeUsers', numFmt: INTEGER },
    ],
    dateAgentTotals.map((r) => ({ ...r, agent: agentLabel(r.agent) })),
  );

  // 4. User x day, long format for pivot tables
  addTable(
    workbook,
    '사용자별 일별',
    [
      { header: '날짜', key: 'date', width: 12 },
      { header: '이름', key: 'name', width: 14 },
      { header: '사용자 ID', key: 'user', width: 30 },
      ...tokenColumns(),
      { header: '세션', key: 'sessions', numFmt: INTEGER },
      { header: '머신 수', key: 'machines', numFmt: INTEGER },
    ],
    userDaily.map((r) => ({ ...r, name: nameOf(r.user) })),
  );

  // 5. Matrix: users x dates (total tokens)
  const matrix = new Map();
  for (const r of userDaily) {
    if (!matrix.has(r.user)) matrix.set(r.user, {});
    matrix.get(r.user)[r.date] = r.totalTokens;
  }
  addTable(
    workbook,
    '일별 토큰표',
    [
      { header: '이름', key: 'name', width: 14 },
      { header: '사용자 ID', key: 'user', width: 30 },
      { header: '합계', key: 'total', numFmt: INTEGER, width: 16 },
      ...dates.map((date) => ({ header: date.slice(5), key: date, numFmt: INTEGER, width: 13 })),
    ],
    stats.users.map((u) => ({ name: u.name ?? '', user: u.user, total: u.totalTokens, ...Object.fromEntries(dates.map((d) => [d, matrix.get(u.user)?.[d] ?? 0])) })),
  ).views = [{ state: 'frozen', xSplit: 3, ySplit: 1 }];

  // 6. Trend groups
  const order = { increasing: 0, steady: 1, decreasing: 2 };
  addTable(
    workbook,
    '추세 그룹',
    [
      { header: '추세', key: 'group' },
      { header: '이름', key: 'name', width: 14 },
      { header: '사용자 ID', key: 'user', width: 30 },
      { header: '일평균 토큰', key: 'mean', numFmt: INTEGER, width: 16 },
      { header: '기울기 (토큰/일)', key: 'slope', numFmt: INTEGER, width: 18 },
      { header: '변화율', key: 'change', numFmt: PERCENT },
    ],
    [...(stats.trend?.users ?? [])]
      .sort((a, b) => order[a.group] - order[b.group] || (a.group === 'decreasing' ? a.changePct - b.changePct : b.changePct - a.changePct))
      .map((u) => ({ group: GROUP_LABEL[u.group], name: u.name ?? '', user: u.user, mean: Math.round(u.mean), slope: Math.round(u.slope), change: u.changePct / 100 })),
  );

  // 7. Machines (latest report per machine)
  addTable(
    workbook,
    '머신',
    [
      { header: '이름', key: 'name', width: 14 },
      { header: '사용자 ID', key: 'user', width: 30 },
      { header: '호스트', key: 'hostname', width: 22 },
      { header: '머신 ID', key: 'machineId', width: 36 },
      { header: '마지막 보고', key: 'receivedAt', width: 20 },
      { header: '보고 기간 시작', key: 'since', width: 14 },
      { header: '보고 기간 끝', key: 'until', width: 14 },
      { header: '보고 횟수', key: 'reports', numFmt: INTEGER },
      { header: '마지막 보고 토큰', key: 'periodTokens', numFmt: INTEGER, width: 18 },
      { header: '수집 에이전트', key: 'agents', width: 20 },
      { header: 'ccusage', key: 'ccusageVersion' },
      { header: '시간대', key: 'timezone', width: 16 },
    ],
    stats.machines.map((m) => ({
      ...m,
      agents: m.agents.map((a) => agentLabel(a.agent)).join(', '),
      name: m.name ?? '',
      hostname: m.hostname ?? '',
      receivedAt: localTime(m.receivedAt),
      periodTokens: m.periodTotal?.totalTokens ?? 0,
      ccusageVersion: m.ccusageVersion ?? '',
      timezone: m.timezone ?? '',
    })),
  );

  // 8. Upload history overlapping the range (with an agent filter: the reports covering that agent, and its numbers)
  const reportUsage = (r) => {
    if (!agent) return r.periodTotal;
    const agents = r.agents ?? [{ agent: LEGACY_AGENT, periodTotal: r.periodTotal }];
    return agents.find((a) => a.agent === agent)?.periodTotal;
  };
  addTable(
    workbook,
    '보고 이력',
    [
      { header: '받은 시각', key: 'receivedAt', width: 20 },
      { header: '이름', key: 'name', width: 14 },
      { header: '사용자 ID', key: 'user', width: 30 },
      { header: '호스트', key: 'hostname', width: 22 },
      { header: '머신 ID', key: 'machineId', width: 36 },
      { header: '기간 시작', key: 'since', width: 12 },
      { header: '기간 끝', key: 'until', width: 12 },
      { header: '전체 토큰', key: 'totalTokens', numFmt: INTEGER, width: 16 },
      { header: '세션', key: 'sessions', numFmt: INTEGER },
      { header: '사용한 날', key: 'activeDays', numFmt: INTEGER },
      { header: '에이전트', key: 'agents', width: 20 },
      { header: 'ccusage', key: 'ccusageVersion' },
    ],
    reports.filter(reportUsage).map((r) => ({
      receivedAt: localTime(r.receivedAt),
      name: r.name ?? nameOf(r.user),
      user: r.user,
      hostname: r.hostname ?? '',
      machineId: r.machineId,
      since: r.since,
      until: r.until,
      totalTokens: reportUsage(r).totalTokens ?? 0,
      sessions: reportUsage(r).sessions ?? 0,
      activeDays: reportUsage(r).activeDays ?? 0,
      agents: (r.agents?.map((a) => a.agent) ?? [LEGACY_AGENT]).map(agentLabel).join(', '),
      ccusageVersion: r.ccusageVersion ?? '',
    })),
  );

  return workbook;
}
