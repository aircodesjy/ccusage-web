import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, INSTALLED_ENTRY, USER_BIN_DIR, WRAPPER_FILE } from './paths.js';

const isWindows = process.platform === 'win32';
const WRAPPER_MARK = 'cc-usage-client wrapper';

/** npm that belongs to the running node (npx sets npm_execpath; otherwise npm sits next to node). */
function npmCommand() {
  const execPath = process.env.npm_execpath;
  if (execPath?.endsWith('.js')) {
    // Older npm (e.g. Ubuntu's npm 9.2.0) points npm_execpath at npx-cli.js, which would run `install` as a command.
    const npmCli = path.basename(execPath) === 'npx-cli.js' ? path.join(path.dirname(execPath), 'npm-cli.js') : execPath;
    if (fs.existsSync(npmCli)) return { command: process.execPath, prefix: [npmCli] };
  }
  const npm = path.join(path.dirname(process.execPath), isWindows ? 'npm.cmd' : 'npm');
  return { command: fs.existsSync(npm) ? npm : isWindows ? 'npm.cmd' : 'npm', prefix: [] };
}

/**
 * Installs the client package from the server into a stable folder, so the daily job does not rely on the
 * temporary npx cache. Returns the installed entry script.
 */
export function installFromServer(tarballUrl) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const { command, prefix } = npmCommand();
  const args = [...prefix, 'install', '--prefix', DATA_DIR, '--no-audit', '--no-fund', '--omit=dev', '--loglevel=error', tarballUrl];
  // .cmd files can only be started through a shell on Windows.
  const result = isWindows && command.endsWith('.cmd')
    ? spawnSync(`"${command}" ${args.map((a) => `"${a}"`).join(' ')}`, { encoding: 'utf8', shell: true })
    : spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`클라이언트 설치 실패: ${(result.stderr || result.error?.message || '').trim().slice(0, 500)}`);
  }
  if (!fs.existsSync(INSTALLED_ENTRY)) throw new Error(`설치 후 ${INSTALLED_ENTRY}을(를) 찾을 수 없습니다`);
  return INSTALLED_ENTRY;
}

export function installedVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(INSTALLED_ENTRY)), 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

const isOurWrapper = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').includes(WRAPPER_MARK);
  } catch {
    return false;
  }
};

/** Short `cc-usage` command pointing at the stable install. Never overwrites someone else's file. */
export function writeWrapper(entry) {
  if (fs.existsSync(WRAPPER_FILE) && !isOurWrapper(WRAPPER_FILE)) return null;
  fs.mkdirSync(USER_BIN_DIR, { recursive: true });
  if (isWindows) {
    fs.writeFileSync(WRAPPER_FILE, `@rem ${WRAPPER_MARK}\r\n@"${process.execPath}" "${entry}" %*\r\n`);
  } else {
    fs.writeFileSync(WRAPPER_FILE, `#!/bin/sh\n# ${WRAPPER_MARK}\nexec "${process.execPath}" "${entry}" "$@"\n`, { mode: 0o755 });
  }
  const onPath = (process.env.PATH ?? '').split(path.delimiter).some((dir) => path.resolve(dir) === path.resolve(USER_BIN_DIR));
  return { file: WRAPPER_FILE, onPath };
}

export function removeInstall() {
  const removed = [];
  if (isOurWrapper(WRAPPER_FILE)) {
    fs.rmSync(WRAPPER_FILE, { force: true });
    removed.push(WRAPPER_FILE);
  }
  if (fs.existsSync(DATA_DIR)) {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    removed.push(DATA_DIR);
  }
  return removed;
}
