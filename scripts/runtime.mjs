import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultDataDir } from '../server/settings.mjs';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function createSupervisor({ root = projectRoot, nodePath = process.execPath, env = process.env,
  spawnProcess = spawn, schedule = setTimeout, cancel = clearTimeout, retryMs = 30_000,
  parentInput = process.stdin,
  log = message => console.error(message), onStop = code => { process.exitCode = code; } } = {}) {
  env = { ...env, AGENT_OFFICE_DATA_DIR: env.AGENT_OFFICE_DATA_DIR || defaultDataDir(),
    AGENT_OFFICE_INSTANCE_ID: env.AGENT_OFFICE_INSTANCE_ID || randomUUID() };
  const children = new Map();
  let detachParent = () => {};
  let closing = false, retryTimer, usageRetryTimer, claudeRetryTimer, claudeObserverRetryTimer, killTimer, exitCode = 0, finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (killTimer) cancel(killTimer);
    detachParent();
    onStop(exitCode);
  };
  function stop(code = 0) {
    if (closing) return;
    closing = true; exitCode = code;
    if (retryTimer) cancel(retryTimer);
    if (usageRetryTimer) cancel(usageRetryTimer);
    if (claudeRetryTimer) cancel(claudeRetryTimer);
    if (claudeObserverRetryTimer) cancel(claudeObserverRetryTimer);
    for (const child of children.values()) child.kill('SIGTERM');
    if (!children.size) return finish();
    killTimer = schedule(() => {
      for (const child of children.values()) child.kill('SIGKILL');
      finish();
    }, 4500);
    killTimer.unref?.();
  }
  function retryObserver() {
    if (closing || retryTimer) return;
    log('Codex 관측기를 연결하지 못했습니다. 사무실은 유지하며 30초 후 다시 확인합니다.');
    retryTimer = schedule(() => { retryTimer = undefined; startObserver(); }, Math.max(1000, retryMs));
  }
  function retryUsage() {
    if (closing || usageRetryTimer) return;
    usageRetryTimer = schedule(() => { usageRetryTimer = undefined; startUsage(); }, Math.max(1000, retryMs));
  }
  function retryClaudeModels() {
    if (closing || claudeRetryTimer) return;
    claudeRetryTimer = schedule(() => { claudeRetryTimer = undefined; startClaudeModels(); }, Math.max(1000, retryMs));
  }
  function retryClaudeObserver() {
    if (closing || claudeObserverRetryTimer) return;
    claudeObserverRetryTimer = schedule(() => { claudeObserverRetryTimer = undefined; startClaudeObserver(); }, Math.max(1000, retryMs));
  }
  function start(role, script) {
    if (closing || children.has(role)) return;
    let child;
    try { child = spawnProcess(nodePath, [join(root, script)], { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'] }); }
    catch { if (role === 'observer') retryObserver(); else if (role === 'usage') retryUsage(); else if (role === 'claude-models') retryClaudeModels(); else if (role === 'claude-observer') retryClaudeObserver(); else stop(1); return; }
    children.set(role, child);
    let handled = false;
    const ended = code => {
      if (handled) return;
      handled = true; children.delete(role);
      if (closing) { if (!children.size) finish(); return; }
      if (role === 'observer') retryObserver();
      else if (role === 'usage') retryUsage();
      else if (role === 'claude-models') retryClaudeModels();
      else if (role === 'claude-observer') retryClaudeObserver();
      else { log('Agent Office 서버가 종료되었습니다.'); stop(code || 1); }
    };
    child.once('error', () => ended(1));
    child.once('exit', ended);
  }
  function startObserver() {
    if (env.AGENT_OFFICE_DISABLE_OBSERVER !== '1') start('observer', 'scripts/codex-observer.mjs');
  }
  function startUsage() {
    if (env.AGENT_OFFICE_DISABLE_USAGE !== '1' && env.AGENT_OFFICE_DISABLE_OBSERVER !== '1') start('usage', 'scripts/codex-usage.mjs');
  }
  function startClaudeModels() {
    if (env.AGENT_OFFICE_DISABLE_CLAUDE_MODELS !== '1') start('claude-models', 'scripts/claude-models.mjs');
  }
  function startClaudeObserver() {
    if (env.AGENT_OFFICE_DISABLE_CLAUDE_OBSERVER !== '1') start('claude-observer', 'scripts/claude-observer.mjs');
  }
  if (env.AGENT_OFFICE_MANAGED_DESKTOP === '1') {
    // The app keeps its write end open for exactly the lifetime of this runtime.
    // Only our child processes are stopped when that parent pipe disappears.
    const disconnected = () => stop();
    for (const event of ['end', 'close', 'error']) parentInput.once(event, disconnected);
    detachParent = () => {
      for (const event of ['end', 'close', 'error']) parentInput.removeListener(event, disconnected);
      parentInput.destroy?.();
    };
    parentInput.resume();
    if (parentInput.readableEnded || parentInput.destroyed) stop();
  }
  return { startBridge: () => start('bridge', 'server/index.mjs'), startObserver, startUsage, startClaudeModels, startClaudeObserver, stop,
    get instanceId() { return env.AGENT_OFFICE_INSTANCE_ID; },
    get closing() { return closing; }, get children() { return children; } };
}

export async function waitForBridge(supervisor, { fetchImpl = fetch,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), attempts = 30 } = {}) {
  for (let attempt = 0; attempt < attempts && !supervisor.closing; attempt++) {
    try {
      const response = await fetchImpl('http://127.0.0.1:4780/api/health', { signal: AbortSignal.timeout(700), redirect: 'error' });
      const health = response.ok ? await response.json() : null;
      if (!response.ok) await response.body?.cancel();
      if (health?.ok === true && health.service === 'agent-office' && health.instanceId === supervisor.instanceId && !supervisor.closing) {
        supervisor.startObserver(); supervisor.startUsage(); supervisor.startClaudeModels(); supervisor.startClaudeObserver(); return true;
      }
    } catch { /* 로컬 HTTP 수신기가 준비될 때까지 기다립니다. */ }
    if (attempt === attempts - 1) supervisor.stop(1);
    else if (!supervisor.closing) await wait(300);
  }
  return false;
}

export async function main() {
  const supervisor = createSupervisor();
  process.once('SIGINT', () => supervisor.stop());
  process.once('SIGTERM', () => supervisor.stop());
  supervisor.startBridge();
  await waitForBridge(supervisor);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
