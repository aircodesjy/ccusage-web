import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, loadState, resolveSettings, saveConfig, updateState } from './config.js';
import { defaultUser, machineId, normalizeName, validateUser } from './identity.js';
import { installFromServer, installedVersion, removeInstall, writeWrapper } from './install.js';
import { CONFIG_FILE, INSTALLED_ENTRY, LAST_UPLOAD_FILE, LOG_FILE, STATE_FILE, WRAPPER_FILE } from './paths.js';
import { promptSetup, SetupCancelled } from './prompt.js';
import { parseTime, scheduler } from './schedule.js';
import { clientInfo, packageUrl, uploadReport } from './server-api.js';
import { buildReport, ccusageInfo } from './usage.js';

const CLIENT_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const DEFAULT_DAYS = 7;
const DEFAULT_TIME = '13:00';

const HELP = `cc-usage ${CLIENT_VERSION} — Claude Code 사용량을 팀 사용량 서버로 보냅니다

사용법
  cc-usage setup
      옵션 없이 실행하면 서버 주소, 사용자 ID, 이름, 자동 전송 시각을 차례로 물어봅니다.
  cc-usage setup --user <이메일> --name <이름> --server <서버 주소> [--token <토큰>] [--time HH:MM]
      설정 저장, 이 컴퓨터에 설치, 첫 전송, 매일 자동 전송 등록을 한 번에 합니다.
      --time        자동 전송 시각 (기본 ${DEFAULT_TIME}, 꺼져 있던 경우 macOS는 켜질 때 보냅니다)
      --no-schedule 자동 전송을 쓰지 않습니다 (이미 등록되어 있으면 해제). 설치와 첫 전송은 합니다
      --dry-run     아무것도 바꾸지 않고 할 일만 보여줍니다
  cc-usage send [--days ${DEFAULT_DAYS}] [--until YYYY-MM-DD] [--dry-run]
      최근 N일 사용량을 보냅니다. 같은 기간을 다시 보내도 서버에서 중복되지 않습니다.
      --dry-run     보내지 않고 보낼 내용을 출력합니다
  cc-usage status
      설정, 자동 전송 등록 여부, 마지막 전송 결과를 보여줍니다.
  cc-usage uninstall [--purge]
      자동 전송을 해제하고 설치본을 지웁니다. --purge는 설정 파일도 지웁니다.

보내는 정보: 사용자 ID, 이름, 머신 ID(OS 식별자의 해시), 호스트 이름, 날짜별 토큰 수와 세션 수.
비용, 프로젝트, 모델, 대화 내용은 보내지 않습니다. 마지막으로 보낸 내용: ${LAST_UPLOAD_FILE}
`;

const OPTIONS = {
  user: { type: 'string' },
  name: { type: 'string' },
  server: { type: 'string' },
  token: { type: 'string' },
  'machine-id': { type: 'string' },
  days: { type: 'string' },
  until: { type: 'string' },
  time: { type: 'string' },
  log: { type: 'string' },
  'no-schedule': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  purge: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

const formatTime = (iso) => (iso ? new Date(iso).toLocaleString('ko-KR') : '–');
const count = (n) => Number(n ?? 0).toLocaleString('ko-KR');

function logger(logFile) {
  if (!logFile) return { info: (m) => console.log(m), error: (m) => console.error(m) };
  try {
    if (fs.statSync(logFile).size > 1024 * 1024) fs.renameSync(logFile, `${logFile}.1`);
  } catch {
    // no log yet
  }
  const write = (level, message) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${level} ${message}\n`);
  return { info: (m) => write('INFO', m), error: (m) => write('ERROR', m) };
}

function normalizeServer(server) {
  if (!server) return null;
  const value = server.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+/.test(value)) throw new Error(`서버 주소는 http:// 또는 https://로 시작해야 합니다: ${server}`);
  return value;
}

function parseDays(value) {
  const days = Number(value ?? DEFAULT_DAYS);
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error('--days는 1~366 사이의 정수여야 합니다');
  return days;
}

// ------------------------------------------------------------------ send

async function send(options, log = logger(options.log)) {
  const config = loadConfig();
  const settings = resolveSettings(options, config);
  const server = normalizeServer(settings.server);
  if (!server) {
    log.error('서버가 설정되지 않았습니다. 먼저 cc-usage setup --user <이메일> --server <서버 주소>를 실행하세요.');
    return 2;
  }
  const identity = {
    user: validateUser(settings.user || defaultUser()),
    name: normalizeName(settings.name),
    machineId: settings.machineId || machineId(config),
  };
  if (!identity.name) {
    log.error('이름이 설정되지 않았습니다. cc-usage setup --name <이름>으로 이름을 등록하세요 (예: --name 홍길동).');
    return 2;
  }
  const days = parseDays(options.days);
  const who = `${identity.name} <${identity.user}>`;

  updateState({ lastRunAt: new Date().toISOString() });
  try {
    const payload = await buildReport({ days, until: options.until, identity });
    if (options['dry-run']) {
      console.log(JSON.stringify(payload, null, 2));
      return 0;
    }
    await uploadReport(server, settings.token, payload);
    fs.writeFileSync(LAST_UPLOAD_FILE, `${JSON.stringify(payload, null, 2)}\n`);
    const summary = {
      range: payload.range,
      totalTokens: payload.periodTotal.totalTokens,
      activeDays: payload.periodTotal.activeDays,
      sessions: payload.periodTotal.sessions,
    };
    updateState({ lastSuccessAt: new Date().toISOString(), lastResult: summary, lastError: null });
    log.info(
      `전송 완료: ${who} (머신 ${identity.machineId.slice(0, 8)}) → ${server} · ${payload.range.since}~${payload.range.until} · ` +
        `토큰 ${count(summary.totalTokens)} · 사용한 날 ${summary.activeDays}일 · 세션 ${summary.sessions}개`,
    );
    return 0;
  } catch (error) {
    updateState({ lastError: { at: new Date().toISOString(), message: error.message } });
    log.error(`전송 실패: ${error.message}`);
    return 2;
  }
}

// ------------------------------------------------------------------ setup

// Options that describe the setup itself; without any of them `setup` asks interactively.
const SETUP_VALUES = ['user', 'name', 'server', 'token', 'machine-id', 'days', 'time', 'no-schedule'];

async function setup(cliOptions) {
  let options = cliOptions;
  const config = loadConfig();
  if (SETUP_VALUES.every((key) => cliOptions[key] === undefined) && process.stdin.isTTY && process.stdout.isTTY) {
    try {
      options = { ...cliOptions, ...(await promptSetup({ config, state: loadState(), normalizeServer })) };
    } catch (error) {
      if (!(error instanceof SetupCancelled)) throw error;
      console.log('\n설정을 취소했습니다. 아무것도 바꾸지 않았습니다.');
      return 130;
    }
  }
  const env = (name) => process.env[name] || undefined;
  const server = normalizeServer(options.server ?? env('CCUSAGE_SERVER') ?? config.server);
  if (!server) throw new Error('--server <서버 주소>가 필요합니다 (예: --server http://usage.example.com:3200)');
  const user = validateUser(options.user ?? env('CCUSAGE_USER') ?? config.user ?? defaultUser());
  const name = options.name !== undefined ? normalizeName(options.name) : normalizeName(env('CCUSAGE_NAME') ?? config.name);
  if (!name) throw new Error('--name <이름>이 필요합니다 (예: --name 홍길동). 대시보드에 이 이름으로 표시됩니다.');
  const token = options.token ?? env('CCUSAGE_TOKEN') ?? config.token;
  const machineIdOverride = options['machine-id'] ?? env('CCUSAGE_MACHINE_ID');
  const schedule = !options['no-schedule'];
  const time = parseTime(options.time ?? loadState().schedule?.time ?? DEFAULT_TIME);
  const days = parseDays(options.days);
  const steps = 4;

  console.log(`[1/${steps}] 서버 확인: ${server}`);
  const info = await clientInfo(server);
  if (info.tokenRequired && !token) throw new Error('이 서버는 업로드 토큰이 필요합니다. 관리자에게 받은 토큰을 --token으로 넣어 주세요.');

  const nextConfig = { ...config, server, user, name, ...(token ? { token } : {}), ...(machineIdOverride ? { machineId: machineIdOverride } : {}) };
  // The install URL ends up on a command line (and in a Windows shell), so accept only the expected shape.
  const packagePathFromServer = info.client?.package;
  if (packagePathFromServer !== undefined && !/^\/client\/cc-usage-client(-[\w.-]+)?\.tgz$/.test(packagePathFromServer)) {
    throw new Error(`서버가 올바르지 않은 패키지 경로를 보냈습니다: ${packagePathFromServer}`);
  }
  const tarball = packageUrl(server, packagePathFromServer);
  if (!/^https?:\/\/[\w.:[\]@/%~-]+\.tgz$/.test(tarball)) throw new Error(`설치 주소에 허용되지 않는 문자가 있습니다: ${tarball}`);

  if (options['dry-run']) {
    const { token: savedToken, ...shown } = nextConfig;
    console.log(`\n저장할 설정 (${CONFIG_FILE}):\n${JSON.stringify({ ...shown, ...(savedToken ? { token: '***' } : {}) }, null, 2)}`);
    console.log(`\n설치: ${tarball} → ${INSTALLED_ENTRY}`);
    if (schedule) console.log(`\n자동 전송 (${scheduler().kind}, 매일 ${time.text}):\n${scheduler().preview(INSTALLED_ENTRY, time)}`);
    else console.log('\n자동 전송: 사용 안 함 (등록되어 있으면 해제)');
    console.log('\n--dry-run이라 아무것도 바꾸지 않았습니다.');
    return 0;
  }

  saveConfig(nextConfig);
  console.log(`      설정 저장: ${CONFIG_FILE}`);

  // Always install and create the `cc-usage` command, so status/send/uninstall work with or without the schedule.
  console.log(`[2/${steps}] 이 컴퓨터에 설치: ${tarball}`);
  const entry = installFromServer(tarball);
  const wrapper = writeWrapper(entry);
  console.log(`      설치 위치: ${entry}`);

  console.log(`[3/${steps}] 최근 ${days}일 사용량 전송`);
  const sendCode = await send({ days: String(days) }, logger());

  let scheduleError = null;
  if (schedule) {
    console.log(`[4/${steps}] 자동 전송 등록: 매일 ${time.text} (${scheduler().kind})`);
    try {
      scheduler().register(entry, time);
      updateState({ schedule: { kind: scheduler().kind, time: time.text, entry, registeredAt: new Date().toISOString() } });
    } catch (error) {
      scheduleError = error;
      console.error(`      자동 전송 등록 실패: ${error.message}`);
    }
  } else {
    // Choosing no schedule also removes an earlier registration, so the choice matches what actually runs.
    console.log(`[4/${steps}] 자동 전송: 사용 안 함`);
    if (scheduler().unregister()) console.log('      기존 자동 전송 등록을 해제했습니다.');
    updateState({ schedule: null });
  }

  const command = wrapper?.onPath ? 'cc-usage' : wrapper ? wrapper.file : `"${process.execPath}" "${entry}"`;
  console.log('\n설정을 마쳤습니다.');
  console.log(`  사용자     ${name} <${user}>`);
  console.log(`  서버       ${server}`);
  console.log(
    `  자동 전송  ${
      !schedule
        ? `사용 안 함 (필요할 때 ${command} send로 보내세요)`
        : scheduleError
          ? '등록 안 됨 (위 오류 참고, 해결 후 setup을 다시 실행하세요)'
          : `매일 ${time.text}, 로그 ${LOG_FILE}`
    }`,
  );
  console.log(`  관리 명령  ${command} status | send | uninstall`);
  if (wrapper && !wrapper.onPath) {
    const dir = path.dirname(wrapper.file);
    console.log(
      process.platform === 'win32'
        ? `\n짧게 cc-usage로 실행하려면 ${dir} 폴더를 PATH 환경 변수에 추가하세요.`
        : `\n짧게 cc-usage로 실행하려면 셸 설정 파일(~/.zshrc 또는 ~/.bashrc)에 다음 줄을 추가하고 새 터미널을 여세요:\n  export PATH="${dir}:$PATH"`,
    );
  } else if (!wrapper) {
    console.log(`\n${WRAPPER_FILE}에 다른 파일이 있어 cc-usage 명령을 만들지 않았습니다. 위 관리 명령의 전체 경로를 사용하세요.`);
  }
  if (sendCode !== 0) console.log('\n첫 전송은 실패했습니다. 위 오류를 확인한 뒤 send를 다시 실행하세요.');
  return sendCode || (scheduleError ? 1 : 0);
}

// ------------------------------------------------------------------ status / uninstall

async function status() {
  const config = loadConfig();
  const settings = resolveSettings({}, config);
  const state = loadState();
  const sched = scheduler();
  const installed = installedVersion();

  const rows = [
    ['설정 파일', fs.existsSync(CONFIG_FILE) ? CONFIG_FILE : `${CONFIG_FILE} (없음)`],
    ['사용자', settings.user ? (settings.name ? `${settings.name} <${settings.user}>` : settings.user) : '설정 안 됨'],
    ['머신 ID', settings.machineId || machineId(config)],
    ['서버', settings.server ?? '설정 안 됨'],
    ['토큰', settings.token ? '저장됨' : '없음'],
    ['클라이언트', `실행 중 ${CLIENT_VERSION} · 설치본 ${installed ? `${installed} (${INSTALLED_ENTRY})` : '없음'}`],
    ['ccusage', ccusageInfo().version],
    ['자동 전송', sched.registered() ? `등록됨 · 매일 ${state.schedule?.time ?? '?'} (${sched.kind})` : '등록 안 됨'],
    ['로그', LOG_FILE],
    ['마지막 실행', formatTime(state.lastRunAt)],
    [
      '마지막 성공',
      state.lastSuccessAt
        ? `${formatTime(state.lastSuccessAt)} · ${state.lastResult.range.since}~${state.lastResult.range.until} · 토큰 ${count(state.lastResult.totalTokens)}`
        : '–',
    ],
  ];
  if (state.lastError) rows.push(['마지막 오류', `${formatTime(state.lastError.at)} · ${state.lastError.message}`]);

  if (settings.server) {
    try {
      const info = await clientInfo(normalizeServer(settings.server), 5000);
      const latest = info.client?.version;
      if (latest) rows.push(['서버의 최신 버전', latest === (installed ?? CLIENT_VERSION) ? `${latest} (최신)` : `${latest} · setup을 다시 실행하면 업데이트됩니다`]);
    } catch (error) {
      rows.push(['서버 연결', `실패 (${error.message})`]);
    }
  }

  // Hangul takes two terminal columns; pad by display width so values line up.
  const displayWidth = (text) => [...text].reduce((w, ch) => w + (ch.codePointAt(0) >= 0x1100 ? 2 : 1), 0);
  const width = Math.max(...rows.map(([label]) => displayWidth(label)));
  for (const [label, value] of rows) console.log(`${label}${' '.repeat(width - displayWidth(label) + 2)}${value}`);
  return 0;
}

function uninstall(options) {
  const removedSchedule = scheduler().unregister();
  console.log(removedSchedule ? '자동 전송을 해제했습니다.' : '등록된 자동 전송이 없습니다.');
  for (const file of removeInstall()) console.log(`삭제: ${file}`);
  updateState({ schedule: null });
  if (options.purge) {
    for (const file of [CONFIG_FILE, STATE_FILE, LAST_UPLOAD_FILE]) {
      if (fs.existsSync(file)) {
        fs.rmSync(file);
        console.log(`삭제: ${file}`);
      }
    }
  } else {
    console.log(`설정은 남겨 두었습니다 (${CONFIG_FILE}). 모두 지우려면 --purge를 사용하세요.`);
  }
  return 0;
}

// ------------------------------------------------------------------ entry

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    console.error(`${error.message}\n\n${HELP}`);
    return 1;
  }
  const { values: options, positionals } = parsed;
  if (options.version) {
    console.log(CLIENT_VERSION);
    return 0;
  }
  const command = positionals[0] ?? 'help';
  if (options.help || command === 'help') {
    console.log(HELP);
    return 0;
  }
  switch (command) {
    case 'setup':
      return setup(options);
    case 'send':
      return send(options);
    case 'status':
      return status();
    case 'uninstall':
      return uninstall(options);
    default:
      console.error(`알 수 없는 명령: ${command}\n\n${HELP}`);
      return 1;
  }
}
