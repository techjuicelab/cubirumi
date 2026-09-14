#!/usr/bin/env node
import { open, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ownPath = fileURLToPath(import.meta.url);
const DEFAULT_ENDPOINT = 'http://127.0.0.1:4780/api/usage';
const windows = [['five_hour', '5시간', 300], ['seven_day', '주간', 10080]];
const TRANSCRIPT_TAIL_BYTES = 1024 * 1024;

/**
 * Rate limits in the status line come from the session's most recent API response, and a refresh only
 * re-sends them. Read just the timestamp of the last assistant record so an idle session never looks fresh.
 */
export async function lastResponseAt(transcriptPath, now = Date.now()) {
  if (typeof transcriptPath !== 'string' || !transcriptPath.startsWith('/') || !transcriptPath.endsWith('.jsonl')
    || [...transcriptPath].some(character => character.charCodeAt(0) < 32)) return null;
  let handle;
  try {
    handle = await open(transcriptPath, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    if (!length) return null;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    for (let index = lines.length - 1; index >= 0; index--) {
      if (!lines[index].includes('"assistant"')) continue;
      let record;
      try { record = JSON.parse(lines[index]); } catch { continue; }
      if (record?.type !== 'assistant' || typeof record.timestamp !== 'string') continue;
      const time = Date.parse(record.timestamp);
      if (Number.isFinite(time) && time <= now + 60_000) return Math.min(time, now);
    }
    return null;
  } catch { return null; } finally { await handle?.close().catch(() => {}); }
}

export function normalizeClaudeUsage(input, now = Date.now()) {
  const limits = input && typeof input === 'object' ? input.rate_limits : undefined;
  const reported = windows.flatMap(([id, label, windowMinutes]) => {
    const value = limits?.[id];
    const used = value?.used_percentage;
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) return [];
    const reset = value.resets_at;
    const resetsAt = typeof reset === 'number' && Number.isSafeInteger(reset) && reset > 0 ? reset : null;
    return [{ id, label, usedPercent: used, windowMinutes, resetsAt }];
  });
  return { provider: 'claude', status: reported.length ? 'live' : 'unavailable',
    updatedAt: reported.length ? new Date(now).toISOString() : null, source: 'claude-statusline',
    ...(reported.length ? {} : { reason: 'not-observed' }), windows: reported };
}

export function usageEndpoint(value = DEFAULT_ENDPOINT) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/api/usage' || url.search || url.hash) throw new Error('Local usage endpoint required');
  return url.href;
}

export async function reportClaudeUsage(input, endpoint = process.env.AGENT_OFFICE_USAGE_ENDPOINT || DEFAULT_ENDPOINT, { observedAt } = {}) {
  try {
    let observedTime = Date.now();
    if (observedAt !== undefined && observedAt !== null) {
      if (typeof observedAt !== 'string' || observedAt.length > 40
        || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(observedAt)) return false;
      observedTime = Date.parse(observedAt);
      if (!Number.isFinite(observedTime) || observedTime > Date.now() + 60_000) return false;
    }
    const response = await fetch(usageEndpoint(endpoint), { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(normalizeClaudeUsage(input, observedTime)),
      signal: AbortSignal.timeout(700) });
    await response.body?.cancel();
    return response.ok;
  } catch { return false; }
}

function startReporter(usage, endpoint) {
  // Only allowlisted numbers and their observation time enter the detached process. The original statusline
  // JSON, transcript path, model, account, and workspace fields never leave here.
  const rate_limits = Object.fromEntries(usage.windows.map(window => [window.id,
    { used_percentage: window.usedPercent, resets_at: window.resetsAt }]));
  try {
    const child = spawn(process.execPath, [ownPath, '--report'], {
      detached: true, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
      env: { ...process.env, AGENT_OFFICE_USAGE_ENDPOINT: usageEndpoint(endpoint) },
    });
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ rate_limits, observedAt: usage.updatedAt }));
    child.unref();
  } catch { /* An unavailable office must never break the existing status line. */ }
}

export async function runStatusline(input, config = {}) {
  let parsed;
  try { parsed = JSON.parse(input.toString('utf8')); } catch { parsed = {}; }
  // Stamp the numbers with the response they came from; fall back to now only when the session record is unreadable.
  const hasLimits = normalizeClaudeUsage(parsed).windows.length > 0;
  const responseAt = hasLimits ? await lastResponseAt(parsed?.transcript_path) : null;
  const usage = normalizeClaudeUsage(parsed, responseAt ?? Date.now());
  startReporter(usage, process.env.AGENT_OFFICE_USAGE_ENDPOINT || config.endpoint || DEFAULT_ENDPOINT);
  const command = config.previousStatusLine?.command;
  if (typeof command !== 'string' || !command.trim()) {
    process.stdout.write(usage.windows.length
      ? `Agent Office · ${usage.windows.map(window => `${window.label} ${Math.round((100 - window.usedPercent) * 10) / 10}% 남음`).join(' · ')}\n`
      : 'Agent Office · 사용 한도 미확인\n');
    return 0;
  }
  return await new Promise(resolve => {
    const child = spawn(command, { shell: true, windowsHide: true, stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', () => resolve(0));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.once('exit', code => resolve(code ?? 0));
  });
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = Buffer.concat(chunks);
  if (process.argv.includes('--report')) {
    let parsed; try { parsed = JSON.parse(input.toString('utf8')); } catch { return; }
    await reportClaudeUsage(parsed, undefined, { observedAt: parsed.observedAt });
    return;
  }
  const configIndex = process.argv.indexOf('--config');
  const config = configIndex >= 0 ? JSON.parse(await readFile(process.argv[configIndex + 1], 'utf8')) : {};
  process.exitCode = await runStatusline(input, config);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); } catch { /* Fail open, without printing session input or configuration. */ }
}
