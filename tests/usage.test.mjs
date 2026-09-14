import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOfficeServer } from '../server/bridge.mjs';
import { createUsageStore, normalizeUsage, usageView, USAGE_STALE_MS } from '../server/usage.mjs';

const now = Date.parse('2026-01-01T00:00:00Z');
const sample = (overrides = {}) => ({ provider: 'codex', status: 'live', source: 'codex-app-server', updatedAt: new Date(now).toISOString(),
  windows: [{ id: 'codex:primary', usedPercent: 27, remainingPercent: 100, windowMinutes: 10080, resetsAt: now / 1000 + 600 }], ...overrides });
function temporary(t) { const dir = mkdtempSync(join(tmpdir(), 'agent-office-usage-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }

test('usage normalization derives labels and remaining values, drops account/auth/credit fields, and preserves null', () => {
  const value = normalizeUsage(sample({ accountId: 'private', auth: 'private', credits: { id: 'private' },
    windows: [{ ...sample().windows[0], label: 'private account name', account: 'private' },
      { id: 'codex_bengalfox:primary', usedPercent: null, windowMinutes: null, resetsAt: null }] }), { now });
  assert.equal(value.windows[0].remainingPercent, 73); assert.equal(value.windows[0].label, 'Codex 주간');
  assert.equal(value.windows[1].remainingPercent, null); assert.equal(value.windows[1].windowMinutes, null);
  assert.equal(JSON.stringify(value).includes('private'), false);
  assert.equal(usageView(value, now).windows[1].status, 'unavailable');
});

test('invalid numeric values, duplicated IDs, arbitrary strings and invented live measurements are rejected', () => {
  for (const changes of [{ provider: 'other' }, { source: 'private' }, { reason: 'private' }, { updatedAt: 'private' },
    { updatedAt: new Date(now + 120000).toISOString() }, { windows: [] }, { windows: [sample().windows[0], sample().windows[0]] },
    { windows: [{ ...sample().windows[0], usedPercent: '0' }] }, { windows: [{ ...sample().windows[0], usedPercent: -1 }] },
    { windows: [{ ...sample().windows[0], usedPercent: 101 }] }, { windows: [{ ...sample().windows[0], windowMinutes: 0 }] },
    { windows: [{ ...sample().windows[0], id: 'private-id' }] }, { windows: [{ ...sample().windows[0], resetsAt: now }] }]) {
    assert.throws(() => normalizeUsage(sample(changes), { now }));
  }
});

test('age and collector failure mark snapshots stale; an expired Spark window does not stale the normal Codex pool', () => {
  const value = normalizeUsage(sample({ windows: [...sample().windows,
    { id: 'codex_bengalfox:primary', usedPercent: 90, windowMinutes: 300, resetsAt: now / 1000 - 1 }] }), { now });
  const current = usageView(value, now);
  assert.equal(current.status, 'live'); assert.equal(current.windows[0].status, 'live');
  assert.equal(current.windows[1].status, 'stale'); assert.equal(current.windows[1].remainingPercent, 10);
  const old = usageView(value, now + USAGE_STALE_MS + 1);
  assert.equal(old.status, 'stale'); assert.equal(old.windows[0].remainingPercent, 73);
  assert.equal(usageView({ ...value, status: 'unavailable' }, now).status, 'stale');
});

test('an empty Claude session report cannot invalidate another session quota or refresh its original age', () => {
  let clock = now;
  const store = createUsageStore({ now: () => clock });
  store.update(sample());
  const codex = store.state().providers[0];
  const claude = store.update({ provider: 'claude', source: 'claude-statusline', status: 'live', updatedAt: new Date(now).toISOString(),
    windows: [{ id: 'five_hour', usedPercent: 23.5, windowMinutes: 300, resetsAt: now / 1000 + 3600 }] });
  const empty = { provider: 'claude', source: 'claude-statusline', status: 'unavailable', updatedAt: null, reason: 'not-observed', windows: [] };
  clock += 1000;
  assert.deepEqual(store.update(empty), claude);
  assert.deepEqual(store.state().providers[0], codex);
  clock = now + USAGE_STALE_MS + 1;
  const aged = store.update(empty);
  assert.equal(aged.status, 'stale'); assert.equal(aged.updatedAt, claude.updatedAt);
  assert.equal(aged.windows[0].remainingPercent, 76.5);
});

test('persisted measurements survive restart privately; failures retain the last measured values and older writes cannot replace them', t => {
  const dataDir = temporary(t);
  const first = createUsageStore({ dataDir, now: () => now }); first.update(sample());
  const failed = first.update({ provider: 'codex', source: 'codex-app-server', status: 'unavailable', updatedAt: null, reason: 'read-failed', windows: [] });
  assert.equal(failed.status, 'stale'); assert.equal(failed.windows[0].remainingPercent, 73);
  assert.equal(failed.updatedAt, sample().updatedAt);
  const second = createUsageStore({ dataDir, now: () => now + 1000 });
  assert.equal(second.state().providers[0].status, 'stale');
  second.update(sample({ updatedAt: new Date(now - 1000).toISOString() }));
  assert.equal(second.state().providers[0].status, 'stale');
  assert.equal(second.state().providers[1].status, 'unavailable');
  assert.equal(statSync(dataDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dataDir, 'usage.json')).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'usage.json'), 'utf8')).providers.length, 2);
});

test('usage persistence refuses symlink escapes and corrupt files never imply available quota', t => {
  const dataDir = temporary(t), outside = join(temporary(t), 'outside.json');
  writeFileSync(outside, '{}'); symlinkSync(outside, join(dataDir, 'usage.json'));
  assert.throws(() => createUsageStore({ dataDir }));
  const broken = temporary(t); writeFileSync(join(broken, 'usage.json'), '{bad');
  assert.equal(createUsageStore({ dataDir: broken }).state().providers.every(provider => provider.status === 'unavailable'), true);
});

function request(port, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const value = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/usage', method,
      headers: { Host: '127.0.0.1:4780', 'Content-Type': 'application/json', ...headers }, agent: false }, res => {
      let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null, headers: res.headers }));
    }); req.on('error', reject); req.end(value);
  });
}
test('usage HTTP endpoint enforces existing localhost, origin, media type, and body limits', async t => {
  const server = createOfficeServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve))); const port = server.address().port;
  assert.equal((await request(port)).body.providers.every(value => value.status === 'unavailable'), true);
  for (const headers of [{ Host: 'evil.example:4780' }, { Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await request(port, { method: 'POST', headers, body: sample() })).status, 403);
  }
  assert.equal((await request(port, { method: 'POST', body: sample({ secret: 'x'.repeat(17000) }) })).status, 413);
  assert.equal((await request(port, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: sample() })).status, 415);
  assert.equal((await request(port, { method: 'POST', body: sample({ source: 'secret' }) })).status, 400);
  const accepted = await request(port, { method: 'POST', headers: { Origin: 'http://localhost:5173' }, body: sample() });
  assert.equal(accepted.status, 202); assert.equal(accepted.body.provider.windows[0].remainingPercent, 73);
  assert.equal((await request(port, { method: 'DELETE' })).status, 405);
  assert.equal((await request(port, { method: 'OPTIONS' })).status, 204);
});
