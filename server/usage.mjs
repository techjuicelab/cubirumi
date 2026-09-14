import { chmodSync, closeSync, constants, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const USAGE_STALE_MS = 15 * 60_000;
const providers = ['codex', 'claude'];
const statuses = new Set(['live', 'stale', 'unavailable']);
const sources = { codex: new Set(['codex-app-server', 'codex-log', 'none']), claude: new Set(['claude-statusline', 'none']) };
const reasons = new Set(['not-observed', 'unsupported', 'authentication-required', 'read-failed', 'expired', 'outdated', 'timeout', 'collector-unavailable']);
const ids = { codex: new Set(['codex:primary', 'codex:secondary', 'codex_bengalfox:primary', 'codex_bengalfox:secondary']), claude: new Set(['five_hour', 'seven_day']) };

export class UsageValidationError extends Error {
  constructor(message) { super(message); this.name = 'UsageValidationError'; this.statusCode = 400; }
}
const fail = message => { throw new UsageValidationError(message); };
function nullableNumber(value, name, maximum, integer = false) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum || (integer && !Number.isInteger(value))) fail(`${name} is invalid`);
  return value;
}
function observedAt(value, now) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) fail('updatedAt is invalid');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time > now + 60_000) fail('updatedAt is invalid');
  return new Date(time).toISOString();
}
function windowLabel(provider, id, minutes) {
  const name = provider === 'claude' ? 'Claude' : id.startsWith('codex_bengalfox:') ? 'Codex Spark' : 'Codex';
  const duration = minutes === 300 ? '5시간' : minutes === 10080 ? '주간' : minutes === null ? '기간 미확인' : `${minutes}분`;
  return `${name} ${duration}`;
}

/** Only anonymous quota measurements survive normalization; labels and remaining values are derived. */
export function normalizeUsage(input, { now = Date.now() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('usage must be an object');
  const provider = input.provider;
  if (!providers.includes(provider)) fail('provider is not supported');
  if (!statuses.has(input.status)) fail('status is not supported');
  if (!sources[provider].has(input.source)) fail('source is not supported');
  if (input.reason !== undefined && !reasons.has(input.reason)) fail('reason is not supported');
  if (!Array.isArray(input.windows) || input.windows.length > 4) fail('windows must be a bounded array');
  const updatedAt = observedAt(input.updatedAt, now);
  const seen = new Set();
  const windows = input.windows.map(window => {
    if (!window || typeof window !== 'object' || !ids[provider].has(window.id) || seen.has(window.id)) fail('window id is invalid or duplicated');
    seen.add(window.id);
    const usedPercent = nullableNumber(window.usedPercent, 'usedPercent', 100);
    const windowMinutes = nullableNumber(window.windowMinutes, 'windowMinutes', 525600, true);
    if (windowMinutes === 0) fail('windowMinutes must be positive');
    const resetsAt = nullableNumber(window.resetsAt, 'resetsAt', 4102444800, true);
    return { id: window.id, label: windowLabel(provider, window.id, windowMinutes), usedPercent,
      remainingPercent: usedPercent === null ? null : Math.max(0, Math.min(100, 100 - usedPercent)), windowMinutes, resetsAt };
  });
  if (windows.length && !updatedAt) fail('observed windows require updatedAt');
  if (input.status === 'live' && (!updatedAt || !windows.some(window => window.usedPercent !== null))) fail('live usage requires a measured window');
  if (input.source === 'none' && (windows.length || input.status !== 'unavailable')) fail('unobserved usage cannot contain measurements');
  return { provider, status: input.status, updatedAt, source: input.source,
    ...(input.reason === undefined ? {} : { reason: input.reason }), windows };
}

function unavailable(provider) { return { provider, status: 'unavailable', updatedAt: null, source: 'none', reason: 'not-observed', windows: [] }; }
export function usageView(snapshot, now = Date.now()) {
  const hasValues = snapshot.windows.some(window => window.usedPercent !== null);
  const aged = snapshot.updatedAt !== null && now - Date.parse(snapshot.updatedAt) > USAGE_STALE_MS;
  const status = !hasValues ? 'unavailable' : snapshot.status !== 'live' || aged ? 'stale' : 'live';
  const result = { ...snapshot, status, ...(aged ? { reason: 'outdated' } : {}), windows: snapshot.windows.map(window => ({ ...window,
    status: window.usedPercent === null ? 'unavailable' : status !== 'live' || (window.resetsAt !== null && window.resetsAt * 1000 <= now) ? 'stale' : 'live',
  })) };
  return result;
}

function assertPrivateFile(path) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Usage storage must be a private regular file');
}

/** Optional persistence for only the most recent sanitized snapshot per provider. */
export function createUsageStore({ dataDir, now = Date.now } = {}) {
  const snapshots = new Map(providers.map(provider => [provider, unavailable(provider)]));
  let path;
  if (dataDir) {
    const directory = resolve(dataDir);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error('Usage storage requires a private directory');
    chmodSync(directory, 0o700);
    path = join(directory, 'usage.json');
    assertPrivateFile(path);
    if (existsSync(path)) {
      chmodSync(path, 0o600);
      if (lstatSync(path).size <= 16 * 1024) {
        try {
          const saved = JSON.parse(readFileSync(path, 'utf8'));
          for (const value of Array.isArray(saved.providers) ? saved.providers.slice(0, 2) : []) {
            try { const clean = normalizeUsage(value, { now: now() }); snapshots.set(clean.provider, clean); } catch { /* Ignore malformed local measurements. */ }
          }
        } catch { /* An unreadable snapshot is not evidence of a full quota. */ }
      }
    }
  }
  function persist(next) {
    if (!path) return;
    assertPrivateFile(path);
    const temporary = `${path}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      fchmodSync(fd, 0o600);
      writeFileSync(fd, JSON.stringify({ providers: [...next.values()] }));
      fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, path);
    } finally { if (fd !== undefined) closeSync(fd); if (existsSync(temporary)) unlinkSync(temporary); }
  }
  return {
    state: () => ({ providers: providers.map(provider => usageView(snapshots.get(provider), now())) }),
    update(input) {
      let value = normalizeUsage(input, { now: now() });
      const previous = snapshots.get(value.provider);
      if (value.updatedAt && previous.updatedAt && Date.parse(value.updatedAt) < Date.parse(previous.updatedAt)) return usageView(previous, now());
      // A newly opened Claude session can omit rate_limits before its first API
      // response. That absence says nothing about another session's observation.
      if (value.provider === 'claude' && value.source === 'claude-statusline'
        && value.status === 'unavailable' && value.reason === 'not-observed'
        && !value.windows.length && previous.windows.length) return usageView(previous, now());
      // A failed poll changes freshness, never overwrites known values with a fabricated full tank.
      if (!value.windows.length && previous.windows.length) value = { ...previous, status: 'stale', reason: value.reason ?? 'read-failed' };
      const next = new Map(snapshots); next.set(value.provider, value);
      persist(next); snapshots.set(value.provider, value);
      return usageView(value, now());
    },
  };
}
