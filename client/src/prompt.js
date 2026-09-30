import readline from 'node:readline';
import { defaultUser, normalizeName, validateUser } from './identity.js';
import { parseTime } from './schedule.js';
import { clientInfo } from './server-api.js';

export class SetupCancelled extends Error {}

/**
 * Asks one question at a time on the terminal. Answers are read line by line, so pasted or piped input works
 * too; Ctrl+C / end of input cancels the setup.
 */
function createAsker() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let muted = false;
  // _writeToOutput is internal to readline; if a Node version drops it, secrets are simply not hidden.
  const write = rl._writeToOutput?.bind(rl);
  // Hide typed characters for secrets, like sudo (readline has no built-in password mode).
  if (write) rl._writeToOutput = (text) => {
    if (!muted) write(text);
  };

  let closed = false;
  rl.on('close', () => {
    closed = true;
  });
  rl.on('SIGINT', () => rl.close());

  const ask = (question, { secret = false } = {}) =>
    new Promise((resolve, reject) => {
      if (closed) return reject(new SetupCancelled());
      const onClose = () => reject(new SetupCancelled());
      rl.once('close', onClose);
      rl.question(question, (answer) => {
        rl.off('close', onClose);
        if (secret) {
          muted = false;
          write?.('\n');
        }
        resolve(answer.trim());
      });
      muted = secret;
    });

  return { ask, close: () => rl.close() };
}

async function askUntilValid(ask, question, parse, askOptions) {
  for (;;) {
    try {
      return await parse(await ask(question, askOptions));
    } catch (error) {
      if (error instanceof SetupCancelled) throw error;
      console.log(`  ${error.message}`);
    }
  }
}

/** Y/n question; Enter means `fallback`. Anything that is not yes or no is asked again. */
const askYesNo = (ask, question, fallback) =>
  askUntilValid(ask, question, (answer) => {
    if (answer === '') return fallback;
    if (/^(y|yes|예|네|ㅇ)$/i.test(answer)) return true;
    if (/^(n|no|아니오|아니요|ㄴ)$/i.test(answer)) return false;
    throw new Error('y 또는 n으로 답해 주세요.');
  });
const hint = (value) => (value ? ` [${value}]` : '');

/**
 * Interactive `cc-usage setup`: every value is asked, with saved settings as defaults.
 * Returns options in the same shape as the command-line flags.
 */
export async function promptSetup({ config, state, normalizeServer }) {
  const { ask, close } = createAsker();
  try {
    console.log('cc-usage 설정을 시작합니다. [ ] 안의 값은 Enter를 누르면 그대로 사용합니다. 취소하려면 Ctrl+C를 누르세요.\n');

    let info;
    const server = await askUntilValid(ask, `서버 주소${hint(config.server) || ' (예: http://usage.example.com:3200)'}: `, async (answer) => {
      const value = normalizeServer(answer || config.server);
      if (!value) throw new Error('서버 주소를 입력하세요.');
      process.stdout.write('  연결 확인 중… ');
      try {
        info = await clientInfo(value, 10_000);
      } catch (error) {
        console.log('실패');
        throw error;
      }
      console.log(`확인했습니다${info.client?.version ? ` (최신 클라이언트 ${info.client.version})` : ''}`);
      return value;
    });

    const suggestedUser = config.user || defaultUser();
    const user = await askUntilValid(ask, `사용자 ID(이메일)${hint(suggestedUser)}: `, (answer) => {
      const value = answer || suggestedUser;
      if (!value) throw new Error('사용자 ID를 입력하세요.');
      return validateUser(value);
    });

    const name = await askUntilValid(
      ask,
      `이름 (대시보드 표시용, 예: 홍길동)${hint(config.name)}: `,
      (answer) => {
        const value = normalizeName(answer || config.name);
        if (!value) throw new Error('이름을 입력하세요.');
        return value;
      },
    );

    let token;
    if (info.tokenRequired) {
      token = await askUntilValid(ask, `업로드 토큰 (이 서버는 토큰이 필요합니다)${config.token ? ' [저장된 토큰 사용]' : ''}: `, async (answer) => {
        const value = answer || config.token;
        if (!value) throw new Error('토큰을 입력하세요. 관리자에게 받을 수 있습니다.');
        return value;
      }, { secret: true });
    }

    const schedule = await askYesNo(ask, '매일 자동으로 보낼까요? (Y/n): ', true);
    let time;
    if (schedule) {
      const savedTime = state.schedule?.time ?? '13:00';
      time = await askUntilValid(ask, `자동 전송 시각 HH:MM${hint(savedTime)}: `, (answer) => parseTime(answer || savedTime).text);
    }

    console.log('\n설정 내용');
    console.log(`  서버       ${server}`);
    console.log(`  사용자     ${name} <${user}>`);
    if (info.tokenRequired) console.log('  토큰       입력함');
    console.log(`  자동 전송  ${schedule ? `매일 ${time}` : '사용 안 함 (설치 후 필요할 때 cc-usage send로 보냄)'}`);
    if (!(await askYesNo(ask, '\n이대로 진행할까요? (Y/n): ', true))) throw new SetupCancelled();
    console.log('');

    return { server, user, name, ...(token ? { token } : {}), ...(schedule ? { time } : { 'no-schedule': true }) };
  } finally {
    close();
  }
}
