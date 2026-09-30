/* global Chart */

const SLOTS = 8;
const DAY_MS = 86_400_000;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ------------------------------------------------------------------ formatting

const intFmt = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 1 });
const pct = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });

const tokens = (v) => compact.format(v ?? 0);
const int = (v) => intFmt.format(v ?? 0);

function isoDate(d) {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function dateRange(since, until) {
  const out = [];
  for (let t = Date.parse(`${since}T00:00:00Z`); t <= Date.parse(`${until}T00:00:00Z`); t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

const shortDate = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const dateTime = (v) =>
  v ? new Date(v).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–';

// ------------------------------------------------------------------ state

const form = $('#filters');
const state = { users: [], names: new Map(), stats: null };
const charts = new Map();
let requestSeq = 0;

function readFilters() {
  const preset = form.preset.value;
  let { value: since } = form.since;
  let { value: until } = form.until;
  if (preset !== 'custom') {
    until = isoDate(new Date());
    since = isoDate(new Date(Date.now() - (Number(preset) - 1) * DAY_MS));
  }
  if (since > until) [since, until] = [until, since];
  return { preset, since, until, user: form.user.value };
}

function writeUrl({ preset, since, until, user }) {
  const params = new URLSearchParams();
  if (preset !== '30') params.set('range', preset);
  if (preset === 'custom') {
    params.set('since', since);
    params.set('until', until);
  }
  if (user) params.set('user', user);
  const query = params.toString();
  history.replaceState(null, '', query ? `?${query}` : location.pathname);
}

function restoreFromUrl() {
  const params = new URLSearchParams(location.search);
  const range = params.get('range');
  if (range && $(`input[name="preset"][value="${CSS.escape(range)}"]`)) form.preset.value = range;
  form.since.value = params.get('since') ?? isoDate(new Date(Date.now() - 29 * DAY_MS));
  form.until.value = params.get('until') ?? isoDate(new Date());
  return params.get('user') ?? '';
}

// ------------------------------------------------------------------ user names

// The user id (email) identifies a person; the optional display name (e.g. 조휘열) is what people recognize.
const displayName = (user) => state.names.get(user) || user;
const fullLabel = (user) => (state.names.get(user) ? `${state.names.get(user)} (${user})` : user);

function rememberNames(rows) {
  for (const { user, name } of rows) if (name) state.names.set(user, name);
}

// ------------------------------------------------------------------ colors (follow the entity, never its rank)

/**
 * Maps every known entity to a categorical slot. The server lists entities by all-time tokens, so the biggest
 * get the leading slots; the mapping is fixed for the page, so filtering never repaints anyone. With more
 * than 8 entities the first 7 keep a slot and the rest fold into "Other".
 */
function slotMap(all) {
  const map = new Map();
  const fold = all.length > SLOTS;
  all.forEach((name, i) => map.set(name, fold && i >= SLOTS - 1 ? null : i + 1));
  return map;
}

const colorOf = (slot) => (slot ? css(`--series-${slot}`) : css('--other'));

// ------------------------------------------------------------------ chart helpers

function baseOptions({ stacked = false, horizontal = false, legend = false, valueFormat = tokens, tickFormat = tokens } = {}) {
  const grid = css('--grid');
  const muted = css('--text-muted');
  const valueAxis = {
    stacked,
    beginAtZero: true,
    border: { display: false },
    grid: { color: grid, lineWidth: 1, drawTicks: false },
    ticks: { color: muted, padding: 8, maxTicksLimit: 6, callback: (v) => tickFormat(v) },
  };
  const categoryAxis = {
    stacked,
    border: { color: css('--axis') },
    grid: { display: false },
    // Horizontal bars name every row; dates on a vertical chart may skip to avoid collisions.
    ticks: { color: muted, padding: 6, autoSkip: !horizontal, autoSkipPadding: 12, maxRotation: 0 },
  };
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 250 },
    indexAxis: horizontal ? 'y' : 'x',
    interaction: horizontal ? { mode: 'nearest', axis: 'y', intersect: false } : { mode: 'index', intersect: false },
    layout: { padding: { top: 4, right: 8 } },
    scales: horizontal ? { x: valueAxis, y: categoryAxis } : { x: categoryAxis, y: valueAxis },
    plugins: {
      legend: {
        display: legend,
        position: 'top',
        align: 'start',
        labels: {
          color: css('--text-secondary'),
          boxWidth: 10,
          boxHeight: 10,
          padding: 12,
          useBorderRadius: true,
          borderRadius: 2,
          generateLabels: (chart) =>
            Chart.defaults.plugins.legend.labels.generateLabels(chart).map((item) => {
              const color = chart.data.datasets[item.datasetIndex].seriesColor;
              return { ...item, fillStyle: color, strokeStyle: color, lineWidth: 0 };
            }),
        },
      },
      tooltip: {
        backgroundColor: css('--surface'),
        titleColor: css('--text-secondary'),
        titleFont: { weight: '500' },
        bodyColor: css('--text-primary'),
        footerColor: css('--text-secondary'),
        borderColor: css('--border'),
        borderWidth: 1,
        padding: 10,
        boxWidth: 12,
        boxHeight: 2,
        boxPadding: 6,
        itemSort: (a, b) => b.raw - a.raw,
        filter: (item) => item.raw > 0,
        callbacks: {
          // Values lead, labels follow.
          label: (item) => (item.chart.data.datasets.length > 1 ? `${valueFormat(item.raw)}  ${item.dataset.label}` : valueFormat(item.raw)),
          labelColor: (item) => ({ borderColor: item.dataset.seriesColor, backgroundColor: item.dataset.seriesColor }),
          footer: (items) =>
            items[0]?.chart.data.datasets.length > 1 ? `합계 ${valueFormat(items.reduce((sum, i) => sum + i.raw, 0))}` : '',
        },
      },
    },
  };
}

function barDataset(label, data, color, { stacked = false } = {}) {
  return {
    label,
    data,
    seriesColor: color,
    backgroundColor: color,
    hoverBackgroundColor: color,
    // A 2px surface gap separates stacked segments; the rounded 4px end sits away from the baseline.
    borderColor: css('--surface'),
    borderWidth: stacked ? { top: 2 } : 0,
    borderSkipped: 'start',
    borderRadius: 4,
    maxBarThickness: 24,
    categoryPercentage: 0.8,
    barPercentage: 0.9,
  };
}

function areaDataset(label, data, color, index) {
  return {
    type: 'line',
    label,
    data,
    seriesColor: color,
    borderColor: color,
    backgroundColor: withAlpha(color, 0.14),
    borderWidth: 2,
    borderJoinStyle: 'round',
    borderCapStyle: 'round',
    fill: index === 0 ? 'origin' : '-1', // each band fills down to the series below it
    cubicInterpolationMode: 'monotone',
    pointRadius: 0,
    pointHitRadius: 12,
    pointHoverRadius: 4,
    pointHoverBorderWidth: 2,
    pointHoverBorderColor: css('--surface'),
    pointHoverBackgroundColor: color,
  };
}

function withAlpha(hex, alpha) {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Vertical hairline that snaps to the hovered date on line/area charts. */
const crosshair = {
  id: 'crosshair',
  afterDatasetsDraw(chart) {
    const active = chart.tooltip?.getActiveElements();
    if (!active?.length) return;
    const { ctx, chartArea } = chart;
    const x = Math.round(active[0].element.x) + 0.5;
    ctx.save();
    ctx.strokeStyle = css('--axis');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

function renderChart(name, config) {
  const card = $(`[data-chart="${name}"]`);
  let existing = charts.get(name);
  if (existing && existing.config.type !== config.type) {
    existing.destroy(); // Chart.js cannot switch chart type in place
    charts.delete(name);
    existing = null;
  }
  if (existing) {
    existing.data = config.data;
    existing.options = config.options;
    existing.update();
  } else {
    charts.set(name, new Chart($('canvas', card), config));
  }
  if ($('.chart-body', card).classList.contains('as-table')) renderChartTable(name);
}

/** Table view: the accessible twin of every chart, built from the chart's own data. */
function renderChartTable(name) {
  const card = $(`[data-chart="${name}"]`);
  const body = $('.chart-body', card);
  const chart = charts.get(name);
  $('table', body)?.remove();
  if (!chart) return;
  const { labels } = chart.data;
  const datasets = chart.data.datasets.filter((d) => !d.trendLine);
  const header = [card.dataset.labelHeader ?? '', ...datasets.map((d) => d.label)];
  if (datasets.length > 1) header.push('합계');
  const rows = labels.map((label, i) => {
    const values = datasets.map((d) => d.data[i] ?? 0);
    return [label, ...values.map(int), ...(datasets.length > 1 ? [int(values.reduce((a, b) => a + b, 0))] : [])];
  });
  body.append(buildTable(header, rows, { numeric: (col) => col > 0 }));
}

function buildTable(header, rows, { numeric = () => false, swatches = [] } = {}) {
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  header.forEach((text, col) => {
    const th = document.createElement('th');
    th.textContent = text;
    if (numeric(col)) th.className = 'num';
    head.append(th);
  });
  const tbody = table.createTBody();
  rows.forEach((cells, r) => {
    const tr = tbody.insertRow();
    cells.forEach((text, col) => {
      const td = tr.insertCell();
      if (col === 0 && swatches[r]) {
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = swatches[r];
        td.append(swatch);
      }
      td.append(document.createTextNode(text ?? '–'));
      if (numeric(col)) td.className = 'num';
    });
  });
  return table;
}

// ------------------------------------------------------------------ renderers

const OTHER = Symbol('기타');

function stackedDaily(dates, rows, key, allNames, { value = 'totalTokens', kind = 'bar', fold = true, labelOf = (k) => k } = {}) {
  const slots = slotMap(allNames);
  const series = new Map(); // entity id (or OTHER) -> { slot, values }
  const index = new Map(dates.map((d, i) => [d, i]));
  for (const row of rows) {
    // Unknown (new since page load) or folded entities go to "기타", unless one entity is shown on its own.
    const slot = slots.get(row[key]) ?? (fold ? null : 1);
    const id = slot ? row[key] : OTHER;
    if (!series.has(id)) series.set(id, { slot, values: new Array(dates.length).fill(0) });
    series.get(id).values[index.get(row.date)] += row[value];
  }
  const ordered = [...series.entries()].sort(([, x], [, y]) => (x.slot ?? 99) - (y.slot ?? 99));
  return ordered.map(([id, { slot, values }], i) => {
    const label = id === OTHER ? '기타' : labelOf(id);
    return kind === 'area'
      ? areaDataset(label, values, colorOf(slot), i)
      : barDataset(label, values, colorOf(slot), { stacked: true });
  });
}

function renderKpis(stats) {
  const t = stats.totals;
  const days = dateRange(stats.range.since, stats.range.until).length;
  const set = (key, text) => {
    const el = $(`[data-kpi="${key}"]`);
    el.textContent = text;
    el.title = text;
  };
  set('totalTokens', tokens(t.totalTokens));
  set('range', `${stats.range.since} – ${stats.range.until} · ${days}일 · 출력 ${tokens(t.outputTokens)}`);
  set('activeUsers', int(t.activeUsers));
  set('activeDays', `사용한 날 ${t.activeDays}일`);
  set('sessions', int(t.sessions));
  set('tokensPerSession', t.sessions ? `세션당 ${tokens(t.totalTokens / t.sessions)} 토큰` : '');
  set('cacheHitRate', pct.format(t.cacheHitRate));
}

function renderCharts(stats) {
  renderTokenChart(stats);
  renderTrend(stats);

  // A one-bar chart says nothing: only show "tokens by user" when there is more than one user to compare.
  const usersCard = $('[data-chart="users"]');
  const showUsers = !stats.user && stats.users.length > 1;
  usersCard.hidden = !showUsers;
  // Many users: grow the ranking so every user keeps a readable, labelled bar.
  $('.chart-body', usersCard).style.height = stats.users.length > 10 ? `${stats.users.length * 26 + 40}px` : '';
  if (showUsers) {
    renderChart('users', {
      type: 'bar',
      data: {
        labels: stats.users.map((u) => displayName(u.user)),
        datasets: [barDataset('토큰', stats.users.map((u) => u.totalTokens), css('--series-1'))],
      },
      options: (() => {
        const options = baseOptions({ horizontal: true });
        // Bars are labelled by name; the tooltip adds the id so people with the same name stay distinguishable.
        options.plugins.tooltip.callbacks.title = (items) => fullLabel(stats.users[items[0].dataIndex].user);
        return options;
      })(),
    });
  }
}

function renderTokenChart(stats, dates = dateRange(stats.range.since, stats.range.until), labels = dates.map(shortDate)) {
  const kind = $('input[name="tokenChartType"]:checked').value;
  const card = $('[data-chart="dailyTokens"]');
  $('h2', card).textContent = stats.user ? `일별 토큰 · ${fullLabel(stats.user)}` : '일별 토큰';
  $('p', card).textContent = stats.user
    ? '하루 토큰 수 (입력·출력·캐시 생성·캐시 읽기), 모든 머신 합산'
    : '하루 토큰 수 (입력·출력·캐시 생성·캐시 읽기), 사용자별 누적';
  const datasets = stackedDaily(dates, stats.byDateUser, 'user', state.users, { value: 'totalTokens', kind, fold: !stats.user, labelOf: displayName });
  renderChart('dailyTokens', {
    type: kind === 'area' ? 'line' : 'bar',
    data: { labels, datasets },
    options: baseOptions({ stacked: true, legend: datasets.length > 1 }),
    plugins: kind === 'area' ? [crosshair] : [],
  });
}

// ------------------------------------------------------------------ usage trend

const TREND_GROUPS = [
  { key: 'increasing', label: '증가', color: () => css('--series-1') },
  { key: 'steady', label: '일정', color: () => css('--other') },
  { key: 'decreasing', label: '감소', color: () => css('--series-8') },
];

/** Trailing average over up to `window` days (fewer at the start of the range). */
function movingAverage(values, window) {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - window + 1), i + 1);
    return Math.round(slice.reduce((a, b) => a + b, 0) / slice.length);
  });
}

const signedPct = (v) => `${v >= 0.5 ? '+' : v <= -0.5 ? '−' : ''}${Math.abs(Math.round(v))}%`;
const mmdd = (iso) => iso.slice(5).replace('-', '/');

/** Least-squares line through daily values: the same method as linearTrend() in server/src/stats.js; change both together. */
function linearFit(values) {
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
  return values.map((_, x) => Math.max(0, Math.round(mean + slope * (x - xMean))));
}

const perDay = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${tokens(Math.abs(v))}/일`;

function renderTrend(stats) {
  const trend = stats.trend;
  const card = $('[data-chart="trend"]');
  const groupsSection = $('#trend-groups');
  card.hidden = !trend;
  groupsSection.hidden = !trend;
  if (!trend) return;

  const pctRule = Math.round(trend.threshold * 100);
  const basis = `${mmdd(trend.since)}–${mmdd(trend.until)} 일별 토큰의 추세선(선형 회귀)이 기간 동안 일평균 대비`;
  const rules = {
    increasing: `${basis} +${pctRule}% 이상 상승`,
    steady: `${basis} −${pctRule}% ~ +${pctRule}% 사이`,
    decreasing: `${basis} −${pctRule}% 이하 하락`,
  };

  // Group tables: one per trend, listing user ids.
  for (const group of TREND_GROUPS) {
    const section = $(`[data-trend-group="${group.key}"]`);
    const members = trend.users.filter((u) => u.group === group.key);
    if (group.key === 'decreasing') members.reverse(); // steepest decline first
    $('.swatch', section).style.background = group.color();
    $('.count', section).textContent = `${members.length}명`;
    $('.trend-rule', section).textContent = rules[group.key];
    const holder = $('.table-scroll', section);
    holder.replaceChildren();
    if (!members.length) {
      holder.append(Object.assign(document.createElement('p'), { className: 'empty-note', textContent: '해당 사용자 없음' }));
    } else {
      holder.append(
        buildTable(
          ['이름', '사용자', '일평균', '추세 기울기', '추세 변화율'],
          members.map((u) => [u.name ?? '–', u.user, tokens(u.mean), perDay(u.slope), signedPct(u.changePct)]),
          { numeric: (c) => c > 1 },
        ),
      );
    }
  }

  // Each group's tokens per day (a 7-day average from 14 days on, since weekends swing daily totals) plus the
  // group's straight trend line in line mode.
  const kind = $('input[name="trendChartType"]:checked').value;
  const dates = dateRange(stats.range.since, stats.range.until);
  const index = new Map(dates.map((d, i) => [d, i]));
  const groupOf = new Map(trend.users.map((u) => [u.user, u.group]));
  const smooth = dates.length >= 14;
  $('.trend-description', card).textContent =
    `추세 그룹별 ${smooth ? '일별 토큰 7일 이동평균' : '일별 토큰'}${kind === 'line' ? '과 추세선' : ''} · ` +
    `사용자마다 기간 내 일별 토큰의 추세선 기울기로 분류 (일평균 대비 ±${pctRule}%)`;

  const datasets = [];
  TREND_GROUPS.forEach((group, i) => {
    const daily = new Array(dates.length).fill(0);
    for (const row of stats.byDateUser) if (groupOf.get(row.user) === group.key) daily[index.get(row.date)] += row.totalTokens;
    const count = trend.users.filter((u) => u.group === group.key).length;
    const dataset = areaDataset(`${group.label} (${count}명)`, smooth ? movingAverage(daily, 7) : daily, group.color(), i);
    if (kind === 'area') {
      datasets.push(dataset);
      return;
    }
    Object.assign(dataset, { fill: false, backgroundColor: group.color() });
    datasets.push(dataset, {
      ...areaDataset(`${group.label} 추세선`, linearFit(daily), group.color(), i),
      trendLine: true,
      fill: false,
      borderWidth: 1.5,
      borderColor: withAlpha(group.color(), 0.55),
      cubicInterpolationMode: 'default',
      tension: 0,
      pointHoverRadius: 0,
      pointHitRadius: 0,
    });
  });

  const options = baseOptions({ stacked: kind === 'area', legend: true });
  options.plugins.legend.labels.filter = (item, data) => !data.datasets[item.datasetIndex].trendLine;
  const tooltipFilter = options.plugins.tooltip.filter;
  options.plugins.tooltip.filter = (item) => !item.dataset.trendLine && tooltipFilter(item);
  renderChart('trend', {
    type: 'line',
    data: { labels: dates.map(shortDate), datasets },
    options,
    plugins: [crosshair],
  });
}

function renderTables(stats) {
  const slots = slotMap(state.users);
  const usersTable = buildTable(
    ['이름', '사용자', '전체 토큰', '출력 토큰', '캐시 읽기', '세션', '사용한 날', '머신', '마지막 사용일'],
    stats.users.map((u) => [
      u.name ?? '–',
      u.user,
      int(u.totalTokens),
      int(u.outputTokens),
      int(u.cacheReadTokens),
      int(u.sessions),
      int(u.activeDays),
      `${u.machines} (${u.hostnames.filter(Boolean).join(', ') || '–'})`,
      u.lastDate,
    ]),
    { numeric: (c) => c >= 2 && c <= 6, swatches: stats.users.map((u) => colorOf(slots.get(u.user))) },
  );
  $('#users-table').replaceWith(Object.assign(usersTable, { id: 'users-table' }));

  const machinesTable = buildTable(
    ['이름', '사용자', '호스트', '머신 ID', '마지막 보고', '보고 기간', '보고 횟수', 'ccusage'],
    stats.machines.map((m) => [
      m.name ?? '–',
      m.user,
      m.hostname ?? '–',
      m.machineId.slice(0, 12),
      dateTime(m.receivedAt),
      `${m.since} – ${m.until}`,
      int(m.reports),
      m.ccusageVersion ?? '–',
    ]),
    { numeric: (c) => c === 6 },
  );
  $('#machines-table').replaceWith(Object.assign(machinesTable, { id: 'machines-table' }));
}

function render(stats) {
  const empty = stats.totals.totalTokens === 0;
  $('#empty').hidden = !empty;
  $('#kpis').hidden = empty;
  $('#charts').hidden = empty;
  $('#trend-groups').hidden = empty;
  renderKpis(stats);
  if (!empty) renderCharts(stats);
  renderTables(stats);
  $('#meta').textContent = `${new Date().toLocaleTimeString('ko-KR')} 업데이트`;
}

// ------------------------------------------------------------------ client setup guide

const USER_ID_RE = /^[\w.%+@-]{1,200}$/; // same rule as the client and the server

/** Quotes a value for a POSIX shell only when needed (e.g. a Korean name with spaces). */
const shellQuote = (value) => (/^[\w@.%+\-/:=]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const isLoopbackHost = (host) => LOOPBACK_HOSTS.has(host) || host.startsWith('127.');

/** This dashboard's URL with another host (same protocol, port and reverse-proxy sub-path), no trailing slash. */
function dashboardUrlWithHost(host) {
  const url = new URL('.', location.href);
  if (host) url.hostname = host;
  return url.href.replace(/\/+$/, '');
}

/**
 * Server addresses to offer in the setup guide, best first:
 * 1. PUBLIC_URL configured on the server,
 * 2. when the page was opened as localhost, this machine's network addresses (reported only to local browsers),
 * 3. the address the dashboard was opened with.
 */
function serverCandidates(server) {
  const current = dashboardUrlWithHost();
  const local = isLoopbackHost(location.hostname);
  const candidates = [];
  if (server?.publicUrl) candidates.push({ url: server.publicUrl, source: 'public', label: '서버 설정(PUBLIC_URL)' });
  if (local) {
    for (const address of server?.addresses ?? []) candidates.push({ url: dashboardUrlWithHost(address), source: 'network', label: '네트워크 주소' });
    if (server?.hostname) candidates.push({ url: dashboardUrlWithHost(server.hostname), source: 'network', label: '호스트 이름' });
  }
  candidates.push({ url: current, source: local ? 'loopback' : 'current', label: local ? '이 컴퓨터에서만 접속 가능' : '지금 접속한 주소' });
  const seen = new Set();
  return candidates.filter((c) => !seen.has(c.url) && seen.add(c.url));
}

/** Explains where the shown server address came from, or what is wrong with a typed one. */
function serverNote(url, candidates) {
  if (!/^https?:\/\/[^/\s]+/.test(url)) return { warning: true, text: 'http:// 또는 https://로 시작하는 서버 주소를 입력하세요.' };
  const host = new URL(url).hostname;
  const match = candidates.find((c) => c.url === url);
  if (isLoopbackHost(host)) {
    return { warning: true, text: `${host}는 서버 컴퓨터에서만 쓸 수 있습니다. 다른 컴퓨터에서 설치하려면 그 컴퓨터에서 접속할 수 있는 서버 주소로 바꾸세요.` };
  }
  switch (match?.source) {
    case 'public':
      return { text: '서버에 설정된 주소(PUBLIC_URL)입니다.' };
    case 'network':
      return {
        text: `이 대시보드를 서버 컴퓨터에서(${location.hostname}) 열어, 다른 컴퓨터가 접속할 수 있는 ${match.label}로 바꿔 표시했습니다. 다른 주소를 쓰려면 칸을 눌러 고르거나 직접 입력하세요.`,
      };
    case 'current':
      return { text: '지금 이 대시보드에 접속한 주소입니다. 다른 컴퓨터에서 이 주소로 접속할 수 없다면 직접 바꾸세요.' };
    default:
      return { text: '직접 입력한 주소로 명령을 만들었습니다.' };
  }
}

function setupCommands({ user, name, tokenRequired, client, serverUrl }) {
  // serverUrl: base URL of this server as other computers reach it, including a reverse-proxy sub-path.
  const origin = serverUrl.replace(/\/+$/, '');
  const setup = client === undefined
    ? '설치 명령을 불러오는 중입니다…'
    : client
    ? [
        `npx --yes ${origin}${client.package} setup`,
        `--user ${shellQuote(user || 'you@example.com')}`,
        `--name ${shellQuote(name || '홍길동')}`,
        `--server ${origin}`,
        ...(tokenRequired ? ['--token YOUR_TOKEN'] : []),
      ].join(' ')
    : '클라이언트 패키지를 준비하지 못했습니다. 서버 로그를 확인하세요.';
  return {
    // One line on purpose: backslash continuations do not work in PowerShell.
    setup,
    manage: [
      'cc-usage status       # 설정, 자동 전송, 마지막 전송 결과',
      'cc-usage send         # 지금 최근 7일 보내기 (--days 30)',
      'cc-usage uninstall    # 자동 전송 해제 (--purge: 설정까지 삭제)',
    ].join('\n'),
  };
}

/**
 * Shows a command with each word kept whole: browsers may break a line after "-", which would split options
 * like --user across lines. Copying still reads the plain text.
 */
function setCode(code, text) {
  code.replaceChildren(
    ...text.split(/(\s+)/).map((part) =>
      /^\s*$/.test(part) ? document.createTextNode(part) : Object.assign(document.createElement('span'), { className: 'word', textContent: part }),
    ),
  );
}

async function copyText(text) {
  try {
    // writeText can stay pending when the page lacks focus or permission; don't leave the button hanging.
    await Promise.race([
      navigator.clipboard.writeText(text),
      new Promise((_, reject) => setTimeout(() => reject(new Error('clipboard timeout')), 1000)),
    ]);
    return true;
  } catch {
    // Clipboard API unavailable (e.g. plain http from another host): fall back to a hidden textarea.
    const area = Object.assign(document.createElement('textarea'), { value: text });
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

function initSetupDialog() {
  const dialog = $('#setup-dialog');
  const userInput = $('#setup-user');
  const nameInput = $('#setup-name');
  const note = $('#setup-user-note');
  const defaultNote = note.innerHTML;
  const serverInput = $('#setup-server');
  const serverOptions = $('#setup-server-options');
  const serverNoteEl = $('#setup-server-note');
  const info = { tokenRequired: false, client: undefined, server: null }; // client undefined: loading, null: unavailable
  let candidates = serverCandidates(null);
  let serverEdited = false;
  serverInput.value = candidates[0].url;

  const fillServerCandidates = () => {
    candidates = serverCandidates(info.server);
    serverOptions.replaceChildren(...candidates.map((c) => Object.assign(document.createElement('option'), { value: c.url, label: c.label })));
    if (!serverEdited) serverInput.value = candidates[0].url; // keep what the user typed
  };

  // Code blocks with a copy button; the text is filled in by render().
  for (const block of $$('[data-code]', dialog)) {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    pre.append(code);
    const button = Object.assign(document.createElement('button'), { type: 'button', className: 'button copy', textContent: '복사' });
    button.addEventListener('click', async () => {
      button.textContent = (await copyText(code.textContent)) ? '복사됨' : '복사 실패';
      setTimeout(() => (button.textContent = '복사'), 1500);
    });
    block.append(pre, button);
  }

  const render = () => {
    const user = userInput.value.trim();
    const name = nameInput.value.normalize('NFC').trim().replace(/\s+/gu, ' ');
    const invalid = user !== '' && !USER_ID_RE.test(user);
    // The name is required: the command only works once a real name replaces the placeholder.
    const nameMissing = user !== '' && name === '';
    userInput.setAttribute('aria-invalid', String(invalid));
    nameInput.setAttribute('aria-invalid', String(nameMissing));
    note.classList.toggle('error', invalid || nameMissing);
    if (invalid) note.textContent = '사용자 ID에는 영문, 숫자와 . _ % + @ - 만 쓸 수 있습니다. 한글 이름은 이름 칸에 입력하세요.';
    else if (nameMissing) note.textContent = '이름은 필수입니다. 대시보드에 표시될 이름(예: 홍길동)을 입력하세요.';
    else note.innerHTML = defaultNote;
    const typedServer = serverInput.value.trim();
    const serverHint = serverNote(typedServer, candidates);
    serverNoteEl.textContent = serverHint.text;
    serverNoteEl.classList.toggle('warning', Boolean(serverHint.warning));
    serverInput.setAttribute('aria-invalid', String(!/^https?:\/\/[^/\s]+/.test(typedServer)));
    // An unusable typed value falls back to the detected address so the commands stay valid.
    const serverUrl = /^https?:\/\/[^/\s]+/.test(typedServer) ? typedServer : candidates[0].url;
    const commands = setupCommands({ user: invalid ? '' : user, name, ...info, serverUrl });
    for (const block of $$('[data-code]', dialog)) setCode($('code', block), commands[block.dataset.code]);
    $('#setup-token-hint').hidden = !info.tokenRequired;
  };

  userInput.addEventListener('input', render);
  nameInput.addEventListener('input', render);
  serverInput.addEventListener('input', () => {
    serverEdited = true;
    render();
  });
  $$('[data-open-setup]').forEach((button) =>
    button.addEventListener('click', () => {
      render();
      dialog.showModal();
      userInput.focus();
    }),
  );
  $('[data-close-setup]', dialog).addEventListener('click', () => dialog.close());
  // Clicking the dimmed backdrop (outside the panel) closes the dialog; Esc is handled by <dialog> itself.
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    const inside = event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
    if (!inside) dialog.close();
  });

  getJson('api/client-info')
    .then((result) => {
      info.tokenRequired = Boolean(result.tokenRequired);
      info.client = result.client;
      info.server = result.server ?? null;
      fillServerCandidates();
      render();
    })
    .catch(() => {
      info.client = null;
      render();
    });
  render();
}

// ------------------------------------------------------------------ data

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function load() {
  const filters = readFilters();
  $('#custom-range').hidden = filters.preset !== 'custom';
  writeUrl(filters);
  const seq = ++requestSeq;
  document.body.classList.add('loading'); // keep the previous render, dimmed, while refetching
  try {
    const params = new URLSearchParams({ since: filters.since, until: filters.until });
    if (filters.user) params.set('user', filters.user);
    $('#export-link').href = `api/export.xlsx?${params}`; // the download follows the current filters
    const stats = await getJson(`api/stats?${params}`);
    if (seq !== requestSeq) return;
    state.stats = stats;
    rememberNames(stats.users);
    render(stats);
  } catch (err) {
    $('#meta').textContent = `불러오기 실패: ${err.message}`;
  } finally {
    if (seq === requestSeq) document.body.classList.remove('loading');
  }
}

/** Remembers a radio choice (chart type) per browser and re-renders its chart when it changes. */
function persistChoice(name, allowed, render) {
  const key = `cc-usage.${name}`;
  try {
    const saved = localStorage.getItem(key);
    if (allowed.includes(saved)) $(`input[name="${name}"][value="${saved}"]`).checked = true;
  } catch {
    // storage unavailable: keep the default choice
  }
  $$(`input[name="${name}"]`).forEach((input) => {
    input.addEventListener('change', () => {
      try {
        localStorage.setItem(key, input.value);
      } catch {
        // not persisted; the choice still applies to this page
      }
      if (state.stats && state.stats.totals.totalTokens > 0) render(state.stats);
    });
  });
}

async function init() {
  initSetupDialog();
  const wantedUser = restoreFromUrl();
  const users = await getJson('api/users');
  state.users = users.map((u) => u.user);
  rememberNames(users);
  // Named people first, sorted the Korean way; then ids without a name.
  const byLabel = [...users].sort((a, b) => (!a.name - !b.name) || (a.name ?? a.user).localeCompare(b.name ?? b.user, 'ko'));
  for (const { user } of byLabel) form.user.add(new Option(fullLabel(user), user));
  if (state.users.includes(wantedUser)) form.user.value = wantedUser;

  Chart.defaults.font.family = css('--font') || 'system-ui, sans-serif';
  Chart.defaults.font.size = 12;

  form.addEventListener('change', load);
  form.addEventListener('submit', (e) => e.preventDefault());

  persistChoice('tokenChartType', ['area', 'bar'], renderTokenChart);
  persistChoice('trendChartType', ['line', 'area'], renderTrend);

  $$('.view-toggle').forEach((button) => {
    button.addEventListener('click', () => {
      const card = button.closest('[data-chart]');
      const body = $('.chart-body', card);
      const asTable = body.classList.toggle('as-table');
      button.setAttribute('aria-pressed', String(asTable));
      if (asTable) renderChartTable(card.dataset.chart);
      else $('table', body)?.remove();
    });
  });

  // Dark mode uses its own validated steps: rebuild the charts from the current data when it flips.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    for (const chart of charts.values()) chart.destroy();
    charts.clear();
    if (state.stats) render(state.stats);
  });

  await load();
}

init().catch((err) => {
  $('#meta').textContent = `시작 실패: ${err.message}`;
});
