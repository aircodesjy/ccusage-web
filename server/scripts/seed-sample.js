#!/usr/bin/env node
/**
 * Sends realistic sample usage for fake users through POST /api/reports, for checking the UI.
 * Sample users all use the `@sample.local` domain; data is deterministic, so re-running replaces it.
 *
 * Each user gets a persona (heavy / regular / light), a usage trend over the period (rising, steady, falling),
 * weekday/weekend rhythm, occasional days off, and 1-3 machines. Some users join partway through or go on
 * leave near the end. Reports are uploaded like a weekly cron job: consecutive 7-day windows per machine,
 * the last one ending today.
 *
 *   node server/scripts/seed-sample.js [--users 40] [--days 90] [--server http://localhost:3000] [--token TOKEN]
 *   node server/scripts/seed-sample.js --clean     # delete every @sample.local record from MongoDB
 */
import { parseArgs } from 'node:util';
import { MongoClient } from 'mongodb';
import { config, MISSING_MONGO_URI } from '../src/config.js';
import { clientOptions } from '../src/db.js';

const SAMPLE_DOMAIN = 'sample.local';

const { values: args } = parseArgs({
  options: {
    server: { type: 'string', default: `http://localhost:${config.port}` },
    users: { type: 'string', default: '40' },
    days: { type: 'string', default: '90' },
    token: { type: 'string', default: process.env.INGEST_TOKEN ?? '' },
    clean: { type: 'boolean', default: false },
  },
});

if (args.clean) {
  if (!config.mongoUri) throw new Error(MISSING_MONGO_URI);
  const client = await new MongoClient(config.mongoUri, clientOptions).connect();
  try {
    const db = client.db(config.mongoDb);
    const filter = { user: { $regex: `@${SAMPLE_DOMAIN.replace('.', '\\.')}$` } };
    for (const name of ['reports', 'daily', 'users']) {
      const { deletedCount } = await db.collection(name).deleteMany(filter);
      console.log(`${name}: deleted ${deletedCount}`);
    }
  } finally {
    await client.close();
  }
  process.exit(0);
}

// ------------------------------------------------------------------ deterministic randomness

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260916);
const between = (min, max) => min + rand() * (max - min);
const int = (min, max) => Math.floor(between(min, max + 1));
const chance = (p) => rand() < p;
const logNormal = (median, spread) =>
  median * Math.exp(spread * Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand()));

function pick(weighted) {
  let r = rand();
  for (const [value, weight] of weighted) {
    if ((r -= weight) < 0) return value;
  }
  return weighted.at(-1)[0];
}

// ------------------------------------------------------------------ people

const NAMES = [
  'minji.kim', 'jiho.lee', 'seoyeon.park', 'hyunwoo.choi', 'jiwon.jung', 'dohyun.kang', 'sujin.yoon', 'taeyang.jang',
  'yuna.lim', 'junseo.han', 'eunji.oh', 'sungmin.seo', 'hayoung.shin', 'jaewon.kwon', 'dahye.hwang', 'minho.ahn',
  'soyeon.song', 'kyungmin.jeon', 'nari.hong', 'woojin.go', 'chaewon.moon', 'seungho.yang', 'bora.son', 'jinwoo.bae',
  'yerin.baek', 'donghyun.heo', 'gaeun.yoo', 'hyejin.nam', 'siwoo.noh', 'arin.ha',
  'jihoon.kwak', 'subin.seong', 'yejin.cha', 'hyunjun.joo', 'somin.woo', 'taemin.min', 'jiyoung.ryu', 'sanghoon.na',
  'eunseo.jin', 'kihyun.ji', 'mirae.cho', 'jaehyuk.byun', 'dasom.eom', 'wonjae.chae', 'haeun.won',
];

const KOREAN_NAMES = {
  'minji.kim': '김민지', 'jiho.lee': '이지호', 'seoyeon.park': '박서연', 'hyunwoo.choi': '최현우', 'jiwon.jung': '정지원',
  'dohyun.kang': '강도현', 'sujin.yoon': '윤수진', 'taeyang.jang': '장태양', 'yuna.lim': '임유나', 'junseo.han': '한준서',
  'eunji.oh': '오은지', 'sungmin.seo': '서성민', 'hayoung.shin': '신하영', 'jaewon.kwon': '권재원', 'dahye.hwang': '황다혜',
  'minho.ahn': '안민호', 'soyeon.song': '송소연', 'kyungmin.jeon': '전경민', 'nari.hong': '홍나리', 'woojin.go': '고우진',
  'chaewon.moon': '문채원', 'seungho.yang': '양승호', 'bora.son': '손보라', 'jinwoo.bae': '배진우', 'yerin.baek': '백예린',
  'donghyun.heo': '허동현', 'gaeun.yoo': '유가은', 'hyejin.nam': '남혜진', 'siwoo.noh': '노시우', 'arin.ha': '하아린',
  'jihoon.kwak': '곽지훈', 'subin.seong': '성수빈', 'yejin.cha': '차예진', 'hyunjun.joo': '주현준', 'somin.woo': '우소민',
  'taemin.min': '민태민', 'jiyoung.ryu': '류지영', 'sanghoon.na': '나상훈', 'eunseo.jin': '진은서', 'kihyun.ji': '지기현',
  'mirae.cho': '조미래', 'jaehyuk.byun': '변재혁', 'dasom.eom': '엄다솜', 'wonjae.chae': '채원재', 'haeun.won': '원하은',
};

// Daily token volume on a working day (median, log-normal spread) and how often they work.
// Based on real Claude Code usage: tens to hundreds of millions of tokens a day, ~97% cache reads.
const PERSONAS = {
  heavy: { weekday: 0.93, weekend: 0.3, medianTokens: 160e6, spread: 0.35 },
  regular: { weekday: 0.85, weekend: 0.12, medianTokens: 55e6, spread: 0.4 },
  light: { weekday: 0.6, weekend: 0.04, medianTokens: 12e6, spread: 0.5 },
};

// Usage multiplier at the first and the last day of the period.
const TRENDS = {
  rising: () => [between(0.45, 0.7), between(1.3, 1.9)],
  steady: () => {
    const level = between(0.9, 1.1);
    return [level, level * between(0.92, 1.08)];
  },
  falling: () => [between(1.3, 1.8), between(0.4, 0.7)],
};

const SHARE = { inputTokens: 0.00006, outputTokens: 0.0068, cacheCreationTokens: 0.0243, cacheReadTokens: 0.96884 };
const TOKEN_KEYS = Object.keys(SHARE);
const ZERO = Object.fromEntries([...TOKEN_KEYS, 'totalTokens', 'sessions'].map((k) => [k, 0]));

function splitTokens(total) {
  const row = {};
  for (const [field, share] of Object.entries(SHARE)) row[field] = Math.round(total * share * between(0.8, 1.2));
  row.totalTokens = TOKEN_KEYS.reduce((sum, k) => sum + row[k], 0);
  return row;
}

function buildPerson(name, index, days) {
  const personaName = pick([['heavy', 0.2], ['regular', 0.5], ['light', 0.3]]);
  const trendName = pick([['rising', 0.35], ['steady', 0.4], ['falling', 0.25]]);
  const machineCount = pick([[1, 0.62], [2, 0.3], [3, 0.08]]);
  return {
    user: `${name}@${SAMPLE_DOMAIN}`,
    // The client requires a display name, so every sample person has one.
    name: KOREAN_NAMES[name] ?? name,
    persona: PERSONAS[personaName],
    personaName,
    trendName,
    trend: TRENDS[trendName](),
    // A few people join partway through; a couple are on leave for the last stretch.
    startDay: index % 13 === 5 ? int(Math.floor(days * 0.45), Math.floor(days * 0.8)) : 0,
    leaveFrom: index % 17 === 8 ? days - int(8, 14) : Infinity,
    machines: Array.from({ length: machineCount }, (_, i) => ({
      machineId: `sample-${name.replace('.', '-')}-${i + 1}`,
      hostname: `${name.split('.')[0]}-${['mbp', 'desktop', 'devbox'][i]}.local`,
      // The main laptop carries most of the work; extra machines are used now and then.
      share: i === 0 ? 1 : between(0.15, 0.45),
      useRate: i === 0 ? 1 : between(0.2, 0.5),
    })),
  };
}

/** Daily rows for every machine of a person over the whole period. */
function buildDaily(person, dates) {
  const perMachine = person.machines.map(() => []);
  let vacation = 0;
  dates.forEach((date, d) => {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    if (vacation === 0 && !weekend && chance(0.006)) vacation = int(1, 4); // occasional days off
    const off = vacation > 0 || d < person.startDay || d >= person.leaveFrom;
    if (vacation > 0) vacation -= 1;

    const [from, to] = person.trend;
    const level = from + (to - from) * (dates.length > 1 ? d / (dates.length - 1) : 1);
    const works = !off && chance(weekend ? person.persona.weekend : person.persona.weekday);

    person.machines.forEach((machine, m) => {
      if (!works || (m > 0 && !chance(machine.useRate))) {
        perMachine[m].push({ date, ...ZERO });
        return;
      }
      const total = Math.min(logNormal(person.persona.medianTokens * level, person.persona.spread) * machine.share, 900e6);
      const row = splitTokens(total);
      row.sessions = Math.max(1, Math.round(row.totalTokens / between(15e6, 35e6)));
      perMachine[m].push({ date, ...row });
    });
  });
  return perMachine;
}

/** The same body the cc-usage client uploads for one machine and one window. */
function report(person, machine, daily) {
  const totals = Object.fromEntries([...TOKEN_KEYS, 'totalTokens', 'sessions'].map((k) => [k, daily.reduce((s, r) => s + r[k], 0)]));
  const cacheBase = totals.cacheReadTokens + totals.cacheCreationTokens + totals.inputTokens;
  return {
    schemaVersion: 3,
    user: person.user,
    name: person.name,
    machineId: machine.machineId,
    hostname: machine.hostname,
    timezone: 'Asia/Seoul',
    meta: { generatedAt: new Date().toISOString(), ccusageVersion: '20.0.20', timezone: 'Asia/Seoul' },
    range: { since: daily[0].date, until: daily.at(-1).date, days: daily.length },
    periodTotal: {
      ...totals,
      activeDays: daily.filter((r) => r.totalTokens > 0).length,
      cacheHitRate: cacheBase ? totals.cacheReadTokens / cacheBase : 0,
    },
    dailyTotals: daily,
  };
}

// ------------------------------------------------------------------ send

const userCount = Math.min(Number.parseInt(args.users, 10), NAMES.length);
const weeks = Math.ceil(Number.parseInt(args.days, 10) / 7);
const todayKst = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
const end = Date.parse(`${todayKst}T00:00:00Z`);
const dates = Array.from({ length: weeks * 7 }, (_, i) => new Date(end - (weeks * 7 - 1 - i) * 86_400_000).toISOString().slice(0, 10));
const url = `${args.server.replace(/\/$/, '')}/api/reports`;
const headers = { 'Content-Type': 'application/json', ...(args.token ? { Authorization: `Bearer ${args.token}` } : {}) };
const eok = (tokens) => `${(tokens / 1e8).toFixed(1)}억`;

let sent = 0;
let grandTotal = 0;
const counts = { heavy: 0, regular: 0, light: 0, rising: 0, steady: 0, falling: 0, machines: 0 };
for (let i = 0; i < userCount; i += 1) {
  const person = buildPerson(NAMES[i], i, dates.length);
  const perMachine = buildDaily(person, dates);
  counts[person.personaName] += 1;
  counts[person.trendName] += 1;
  counts.machines += person.machines.length;

  let personTotal = 0;
  for (const [m, machine] of person.machines.entries()) {
    // Weekly uploads, oldest first: consecutive 7-day windows like a cron job running every week.
    for (let w = 0; w < weeks; w += 1) {
      const body = report(person, machine, perMachine[m].slice(w * 7, (w + 1) * 7));
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) {
        console.error(`${person.user} ${machine.machineId}: HTTP ${res.status} ${await res.text()}`);
        process.exit(1);
      }
      sent += 1;
      personTotal += body.periodTotal.totalTokens;
    }
  }
  grandTotal += personTotal;
  const notes = [person.startDay ? `joined ${dates[person.startDay]}` : '', Number.isFinite(person.leaveFrom) ? `on leave from ${dates[person.leaveFrom]}` : '']
    .filter(Boolean)
    .join(', ');
  console.log(
    `${person.user.padEnd(28)} ${(person.name ?? '-').padEnd(4)} ${person.personaName.padEnd(8)} ${person.trendName.padEnd(8)} ` +
      `${person.machines.length} machine(s) ${eok(personTotal).padStart(8)} ${notes}`,
  );
}
console.log(
  `\nsent ${sent} weekly reports for ${userCount} sample users on ${counts.machines} machines, ${dates[0]} ~ ${dates.at(-1)}, ` +
    `total ${eok(grandTotal)} tokens\npersonas: heavy ${counts.heavy}, regular ${counts.regular}, light ${counts.light} · ` +
    `trends: rising ${counts.rising}, steady ${counts.steady}, falling ${counts.falling}\nremove with: npm run seed:clean`,
);
