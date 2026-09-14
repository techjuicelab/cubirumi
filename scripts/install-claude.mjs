#!/usr/bin/env node
import { mkdir, readFile, writeFile, rename, chmod, lstat, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginId = 'agent-office@agent-office-local';
const managedMarker = '.cubirumi-managed.json';
const managedFiles = ['.claude-plugin/marketplace.json',
  'integrations/claude-plugin/.claude-plugin/plugin.json', 'integrations/claude-plugin/hooks/hooks.json',
  'integrations/claude-plugin/scripts/adapter-core.mjs', 'integrations/claude-plugin/scripts/activity-kind.mjs',
  'integrations/claude-plugin/scripts/claude-hook.mjs'];
export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export const claudeConfigDir = () => resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'));
export const privateDataDir = () => resolve(process.env.AGENT_OFFICE_DATA_DIR || (process.platform === 'darwin'
  ? join(homedir(), 'Library', 'Application Support', 'AgentOffice') : join(homedir(), '.local', 'share', 'agent-office')));

async function optionalText(path) {
  try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function privateDirectory(path) { await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700); }
async function privateWrite(path, text) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}
async function backupSettings(settingsPath, dataDir) {
  const original = await optionalText(settingsPath);
  if (original === null) return null;
  const backups = join(dataDir, 'claude-backups');
  await privateDirectory(backups);
  const path = join(backups, `settings-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.json`);
  await writeFile(path, original, { flag: 'wx', mode: 0o600 });
  return path;
}

export function claudeMarketplaceRoot({ root = projectRoot, nodePath = process.execPath, dataDir = privateDataDir() } = {}) {
  return resolve(nodePath) === resolve(root, '../../Helpers/node') ? join(dataDir, 'claude-integration') : root;
}

export async function prepareBundledClaudeMarketplace({ root = projectRoot, nodePath = process.execPath, dataDir = privateDataDir() } = {}) {
  const destination = join(dataDir, 'claude-integration');
  let previous;
  try { previous = await lstat(destination); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous) {
    if (!previous.isDirectory() || previous.isSymbolicLink()) throw new Error('기존 Claude 연결 폴더를 보존했습니다.');
    const marker = JSON.parse(await readFile(join(destination, managedMarker), 'utf8'));
    if (marker.managedBy !== 'cubirumi' || marker.version !== 1) throw new Error('직접 관리하지 않는 Claude 연결 폴더를 보존했습니다.');
  }
  await privateDirectory(dataDir);
  const staging = join(dataDir, `.claude-integration-${randomUUID()}`);
  let backup;
  try {
    await privateDirectory(staging);
    for (const name of managedFiles) {
      const source = join(root, name), target = join(staging, name);
      const info = await lstat(source);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Claude 연결 원본은 일반 파일이어야 합니다.');
      await privateDirectory(dirname(target));
      await writeFile(target, await readFile(source), { flag: 'wx', mode: 0o600 });
    }
    const hooksPath = join(staging, 'integrations/claude-plugin/hooks/hooks.json');
    const hooks = JSON.parse(await readFile(hooksPath, 'utf8'));
    for (const groups of Object.values(hooks.hooks)) for (const group of groups) for (const hook of group.hooks) {
      if (hook.type !== 'command' || hook.command !== 'node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-hook.mjs"') throw new Error('지원하지 않는 Claude hook 명령을 보존했습니다.');
      hook.command = `${shellQuote(nodePath)} "\${CLAUDE_PLUGIN_ROOT}/scripts/claude-hook.mjs"`;
    }
    await writeFile(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`, { mode: 0o600 });
    await writeFile(join(staging, managedMarker), `${JSON.stringify({ managedBy: 'cubirumi', version: 1, root, nodePath }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    if (previous) {
      const backups = join(dataDir, 'claude-backups'); await privateDirectory(backups);
      backup = join(backups, `marketplace-${randomUUID()}`);
      await rename(destination, backup);
    }
    try { await rename(staging, destination); }
    catch (error) { if (backup) await rename(backup, destination); throw error; }
    return destination;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export async function installStatusline({ root = projectRoot, nodePath = process.execPath,
  configDir = claudeConfigDir(), dataDir = privateDataDir() } = {}) {
  const settingsPath = join(configDir, 'settings.json');
  try { if ((await lstat(settingsPath)).isSymbolicLink()) throw new Error('연결된 settings.json은 자동으로 교체하지 않습니다.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const original = await optionalText(settingsPath);
  const settings = original === null ? {} : JSON.parse(original);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('사용자 설정 형식을 확인해 주세요.');
  const configPath = join(dataDir, 'claude-statusline.json');
  const wrapperCommand = `${shellQuote(nodePath)} ${shellQuote(join(root, 'scripts', 'claude-statusline.mjs'))} --config ${shellQuote(configPath)}`;
  const installedText = await optionalText(configPath);
  const installed = installedText === null ? null : JSON.parse(installedText);
  let previousStatusLine = settings.statusLine ?? null;
  if (installed && settings.statusLine?.command === installed.wrapperCommand) previousStatusLine = installed.previousStatusLine ?? null;
  else if (settings.statusLine?.command?.includes('claude-statusline.mjs')) throw new Error('기존 Agent Office 표시줄 설정을 보존했습니다. 연결 파일을 먼저 확인해 주세요.');
  if (previousStatusLine !== null && (previousStatusLine.type !== 'command' || typeof previousStatusLine.command !== 'string')) throw new Error('지원하지 않는 기존 표시줄 설정을 보존했습니다.');
  await privateDirectory(dataDir);
  const backupPath = await backupSettings(settingsPath, dataDir);
  await privateWrite(configPath, `${JSON.stringify({ version: 1, wrapperCommand, previousStatusLine, endpoint: 'http://127.0.0.1:4780/api/usage' }, null, 2)}\n`);
  const updated = { ...settings, statusLine: { ...(settings.statusLine ?? {}), type: 'command', command: wrapperCommand } };
  if (await optionalText(settingsPath) !== original) throw new Error('설정이 다른 작업에서 변경되어 덮어쓰지 않았습니다. 다시 실행해 주세요.');
  await mkdir(configDir, { recursive: true });
  await privateWrite(settingsPath, `${JSON.stringify(updated, null, 2)}\n`);
  return { settingsPath, configPath, backupPath, previousStatusLinePreserved: previousStatusLine !== null };
}

async function main() {
  const command = process.argv[2] || 'status';
  if (command === 'status') {
    const text = await optionalText(join(claudeConfigDir(), 'settings.json'));
    const settings = text === null ? {} : JSON.parse(text);
    console.log(JSON.stringify({ pluginEnabled: settings.enabledPlugins?.[pluginId] === true,
      statuslineConnected: Boolean(settings.statusLine?.command?.includes('claude-statusline.mjs')) }));
    return;
  }
  if (command !== 'install') throw new Error('사용법: node scripts/install-claude.mjs install|status');
  if (process.platform === 'win32') throw new Error('이 설치기는 macOS/Linux용입니다. Windows 설정은 수동으로 검토해 주세요.');
  const dataDir = privateDataDir();
  const marketplaceRoot = claudeMarketplaceRoot({ dataDir });
  const marketplacesText = await optionalText(join(claudeConfigDir(), 'plugins', 'known_marketplaces.json'));
  const existingMarketplace = marketplacesText ? JSON.parse(marketplacesText)['agent-office-local'] : null;
  if (existingMarketplace && (existingMarketplace.source?.source !== 'directory'
    || resolve(existingMarketplace.source.path) !== marketplaceRoot)) throw new Error('같은 이름의 다른 marketplace를 보존했습니다. 출처를 먼저 확인해 주세요.');
  await privateDirectory(dataDir);
  if (marketplaceRoot !== projectRoot) await prepareBundledClaudeMarketplace({ dataDir });
  await backupSettings(join(claudeConfigDir(), 'settings.json'), dataDir);
  const installedText = await optionalText(join(claudeConfigDir(), 'plugins', 'installed_plugins.json'));
  const installed = installedText ? JSON.parse(installedText).plugins?.[pluginId] : null;
  const hasUserInstall = Array.isArray(installed) && installed.some(entry => entry.scope === 'user');
  const commands = [
    ...(!existingMarketplace ? [['plugin', 'marketplace', 'add', marketplaceRoot, '--scope', 'user']] : []),
    ...(existingMarketplace ? [['plugin', 'marketplace', 'update', 'agent-office-local']] : []),
    ['plugin', hasUserInstall ? 'update' : 'install', pluginId, '--scope', 'user'],
  ];
  for (const args of commands) {
    const result = spawnSync('claude', args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.error || result.status !== 0) throw new Error(`Claude 플러그인 ${args[1]} 단계가 완료되지 않았습니다. 사용자 표시줄은 변경하지 않았습니다.`);
  }
  const result = await installStatusline({ dataDir });
  console.log(`Claude Code 사용자 플러그인과 사용량 표시줄을 연결했습니다. 기존 표시줄 ${result.previousStatusLinePreserved ? '보존' : '없음'}.`);
  console.log('새 Claude Code 세션에서 적용을 확인해 주세요. AI 모델 호출은 실행하지 않았습니다.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); } catch (error) {
    console.error(error instanceof SyntaxError ? '설정 JSON을 읽지 못했습니다. 기존 파일을 보존했습니다.' : error.message);
    process.exitCode = 1;
  }
}
