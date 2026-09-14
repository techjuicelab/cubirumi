import { mkdir, readFile, writeFile, stat, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const SERVICE_LABEL = 'io.agent-office.runtime';
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export function createLaunchAgent({ root = projectRoot, nodePath = process.execPath, home = homedir(), env = process.env } = {}) {
  const dataDir = env.AGENT_OFFICE_DATA_DIR ? resolve(env.AGENT_OFFICE_DATA_DIR) : join(home, 'Library', 'Application Support', 'AgentOffice');
  const environment = { AGENT_OFFICE_DATA_DIR: dataDir,
    PATH: [...new Set([dirname(nodePath), ...(env.PATH || '/usr/local/bin:/usr/bin:/bin').split(':')])].join(':') };
  if (env.CODEX_HOME) environment.CODEX_HOME = resolve(env.CODEX_HOME);
  if (env.CLAUDE_CONFIG_DIR) environment.CLAUDE_CONFIG_DIR = resolve(env.CLAUDE_CONFIG_DIR);
  if (env.AGENT_OFFICE_DISABLE_CLAUDE_MODELS === '1') environment.AGENT_OFFICE_DISABLE_CLAUDE_MODELS = '1';
  if (env.AGENT_OFFICE_DISABLE_CLAUDE_OBSERVER === '1') environment.AGENT_OFFICE_DISABLE_CLAUDE_OBSERVER = '1';
  if (env.AGENT_OFFICE_DISABLE_OBSERVER === '1') environment.AGENT_OFFICE_DISABLE_OBSERVER = '1';
  if (env.AGENT_OFFICE_DISABLE_USAGE === '1') environment.AGENT_OFFICE_DISABLE_USAGE = '1';
  if (env.AGENT_OFFICE_CODEX_BIN) environment.AGENT_OFFICE_CODEX_BIN = env.AGENT_OFFICE_CODEX_BIN;
  const plistPath = join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>${xml(join(root, 'scripts', 'runtime.mjs'))}</string></array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key,value]) => `<key>${key}</key><string>${xml(value)}</string>`).join('')}</dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(join(dataDir, 'runtime.stdout.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(dataDir, 'runtime.stderr.log'))}</string>
</dict></plist>\n`;
  return { plist, plistPath, dataDir, nodePath, runtimePath: join(root, 'scripts', 'runtime.mjs') };
}

export async function main(command = process.argv[2] || 'status') {
  if (process.platform !== 'darwin') {
    throw new Error('자동 실행 등록은 macOS용입니다. Linux에서는 node scripts/runtime.mjs로 실행하세요. Windows 실행은 아직 실험적입니다.');
  }
  const domain = `gui/${process.getuid()}`;
  const launchctl = (args, optional = false) => {
    const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
    if ((result.error || result.status !== 0) && !optional) throw new Error('launchctl 실행 실패');
    return result;
  };
  if (command === 'status') {
    const result = launchctl(['print', `${domain}/${SERVICE_LABEL}`], true);
    console.log(result.status === 0 ? 'Agent Office 자동 실행이 등록되어 있습니다.' : 'Agent Office 자동 실행이 등록되어 있지 않습니다.');
    return;
  }
  if (command === 'stop') {
    launchctl(['bootout', `${domain}/${SERVICE_LABEL}`], true);
    console.log('Agent Office 자동 실행을 현재 로그인 세션에서 중지했습니다.');
    return;
  }
  if (command !== 'install') throw new Error('사용법: node scripts/install-runtime.mjs install|status|stop');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 18)) throw new Error('Node.js 22.18 이상으로 설치 명령을 실행해 주세요.');
  const config = createLaunchAgent();
  await stat(join(projectRoot, 'dist', 'index.html'));
  await stat(join(projectRoot, 'scripts', 'codex-observer.mjs'));
  await stat(config.nodePath);
  let existing;
  try { existing = await readFile(config.plistPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing && !existing.includes(xml(config.runtimePath))) throw new Error('같은 이름의 다른 자동 실행 설정이 있습니다. 기존 설정을 보존했습니다.');
  await mkdir(dirname(config.plistPath), { recursive: true });
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await chmod(config.dataDir, 0o700);
  for (const name of ['runtime.stdout.log', 'runtime.stderr.log']) {
    const path = join(config.dataDir, name);
    await writeFile(path, '', { flag: 'a', mode: 0o600 });
    await chmod(path, 0o600);
  }
  const removed = launchctl(['bootout', `${domain}/${SERVICE_LABEL}`], true);
  if (removed.status === 0) await new Promise(resolve => setTimeout(resolve, 1200));
  await writeFile(config.plistPath, config.plist, { mode: 0o600 });
  await chmod(config.plistPath, 0o600);
  let started;
  for (let attempt = 0; attempt < 8; attempt++) {
    started = launchctl(['bootstrap', domain, config.plistPath], true);
    if (started.status === 0) break;
    if (attempt < 7) await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (started.status !== 0) throw new Error('자동 실행 등록 실패');
  console.log(`Agent Office 자동 실행 설치 완료: ${config.plistPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
