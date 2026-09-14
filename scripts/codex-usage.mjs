import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { normalizeUsage } from '../server/usage.mjs';

export const USAGE_POLL_MS = 60_000;
const knownBuckets = ['codex', 'codex_bengalfox'];
const unknown = reason => ({ provider: 'codex', source: 'codex-app-server', status: 'unavailable', updatedAt: null, reason, windows: [] });
const numberOrNull = (value, maximum, integer = false) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum && (!integer || Number.isInteger(value)) ? value : null;

/** Read only numeric fields from known quota buckets. Account/credit metadata is never returned. */
export function codexUsageSnapshot(result, { now = Date.now() } = {}) {
  const windows = [];
  const hasMultiple = result?.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === 'object';
  for (const id of knownBuckets) {
    const bucket = hasMultiple ? result.rateLimitsByLimitId[id]
      : id === 'codex' && (!result?.rateLimits?.limitId || result.rateLimits.limitId === 'codex') ? result?.rateLimits : undefined;
    for (const position of ['primary', 'secondary']) {
      const window = bucket?.[position];
      if (!window || typeof window !== 'object') continue;
      windows.push({ id: `${id}:${position}`, usedPercent: numberOrNull(window.usedPercent, 100),
        windowMinutes: numberOrNull(window.windowDurationMins, 525600, true) || null,
        resetsAt: numberOrNull(window.resetsAt, 4102444800, true) });
    }
  }
  if (!windows.some(window => window.usedPercent !== null)) return unknown('not-observed');
  return normalizeUsage({ provider: 'codex', status: 'live', source: 'codex-app-server',
    updatedAt: new Date(now).toISOString(), windows }, { now });
}

function rpcFailure(error) {
  if (error?.code === -32601) return 'unsupported';
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/auth|login|sign.in|unauthor|chatgpt account|api.key/i.test(message)) return 'authentication-required';
  return 'read-failed';
}

/** Only initialize/initialized/account/rateLimits/read are sent; no thread or work commands. */
export function readCodexUsage({ command = process.env.AGENT_OFFICE_CODEX_BIN || 'codex',
  spawnProcess = spawn, timeoutMs = 15_000, now = Date.now, signal } = {}) {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(unknown('read-failed')); return; }
    let child, done = false, requested = false, buffer = '', bytes = 0, killTimer;
    const timeout = setTimeout(() => finish(unknown('timeout')), Math.max(50, timeoutMs));
    function finish(value) {
      if (done) return;
      done = true; clearTimeout(timeout); signal?.removeEventListener('abort', abort);
      if (child) {
        child.stdin?.end(); child.kill('SIGTERM');
        if (child.exitCode === null) { killTimer = setTimeout(() => child.kill('SIGKILL'), 1000); killTimer.unref?.(); }
      }
      resolve(value);
    }
    const abort = () => finish(unknown('read-failed'));
    function send(message) { try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { finish(unknown('read-failed')); } }
    try { child = spawnProcess(command, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { finish(unknown('collector-unavailable')); return; }
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', () => finish(unknown('collector-unavailable')));
    child.once('exit', () => { clearTimeout(killTimer); finish(unknown('read-failed')); });
    child.stdin.on('error', () => finish(unknown('read-failed')));
    child.stdout.on('data', chunk => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) { finish(unknown('read-failed')); return; }
      buffer += chunk.toString('utf8');
      let boundary;
      while (!done && (boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1 && !requested) {
          if (message.error) { finish(unknown(rpcFailure(message.error))); return; }
          requested = true;
          send({ method: 'initialized', params: {} });
          send({ id: 2, method: 'account/rateLimits/read' });
        } else if (message.id === 2 && requested) {
          finish(message.error ? unknown(rpcFailure(message.error)) : codexUsageSnapshot(message.result, { now: now() }));
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent_office_usage', version: '0.3.0' } } });
  });
}

export async function postCodexUsage(snapshot, { endpoint = 'http://127.0.0.1:4780/api/usage', fetchImpl = fetch, signal } = {}) {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '4780'
    || url.pathname !== '/api/usage' || url.username || url.password || url.search || url.hash) throw new Error('Usage endpoint must be the local bridge');
  const response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(normalizeUsage(snapshot)), redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000) });
  await response.body?.cancel();
  if (!response.ok) throw new Error('Usage receiver is unavailable');
}

/** Serial minute polling; failures back off without overlapping reads. */
export function createUsageCollector({ read = readCodexUsage, post = postCodexUsage, schedule = setTimeout,
  cancel = clearTimeout, intervalMs = USAGE_POLL_MS, onResult = () => {} } = {}) {
  let stopped = false, running = false, timer, failures = 0;
  const controller = new AbortController();
  async function poll() {
    if (stopped || running) return;
    running = true;
    let snapshot, delivered = false;
    try { snapshot = await read({ signal: controller.signal }); } catch { snapshot = unknown('read-failed'); }
    if (!stopped) {
      try { await post(snapshot, { signal: controller.signal }); delivered = true; } catch { /* Keep retrying; the bridge ages its last successful sample. */ }
      failures = snapshot.status === 'live' ? 0 : Math.min(3, failures + 1);
      onResult({ status: snapshot.status, delivered });
    }
    running = false;
    if (!stopped) {
      const delay = delivered ? Math.min(30 * 60_000, Math.max(1000, intervalMs) * 2 ** Math.max(0, failures - 1)) : Math.min(60_000, Math.max(1000, intervalMs));
      timer = schedule(poll, delay);
    }
  }
  return { start: poll, stop() { stopped = true; if (timer) cancel(timer); controller.abort(); },
    get running() { return running; } };
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--once')) {
    const snapshot = await readCodexUsage();
    if (args.includes('--dry-run')) console.log(JSON.stringify(snapshot));
    else { try { await postCodexUsage(snapshot); } catch { process.exitCode = 1; } }
    return;
  }
  const collector = createUsageCollector();
  process.once('SIGINT', () => collector.stop()); process.once('SIGTERM', () => collector.stop());
  await collector.start();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
