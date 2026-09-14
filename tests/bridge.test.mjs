import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOfficeServer, normalizeEvent } from '../server/bridge.mjs';

const sample = (overrides = {}) => ({
  source: 'manual', type: 'agent.started', agentId: 'developer',
  agentName: '개발 직원', status: 'working', title: '사무실 화면 구현',
  ...overrides,
});

async function fixture(t, options) {
  const server = createOfficeServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return server.address().port;
}

function request(port, path, { method = 'GET', headers = {}, body, chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const content = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: {
        Host: '127.0.0.1:4780',
        ...(content === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(!chunked && content !== undefined ? { 'Content-Length': Buffer.byteLength(content) } : {}),
        ...headers,
      },
      agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text,
          json: text && res.headers['content-type']?.startsWith('application/json') ? JSON.parse(text) : null });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (chunked && content !== undefined) {
      for (let offset = 0; offset < content.length; offset += 1024) req.write(content.slice(offset, offset + 1024));
      req.end();
    } else {
      req.end(content);
    }
  });
}

function openStream(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: '127.0.0.1', port, path: '/api/events',
      headers: { Host: '127.0.0.1:4780', ...headers }, agent: false,
    }, (res) => {
      const events = [];
      let buffer = '';
      const pending = new Set();
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split('\n').find((line) => line.startsWith('data: '));
          if (data) {
            assert.equal(frame.includes('\nevent:'), false, 'SSE should use the default message event');
            events.push(JSON.parse(data.slice(6)));
          }
        }
        for (const check of pending) check();
      });
      resolve({
        status: res.statusCode, headers: res.headers, events,
        close: () => req.destroy(),
        waitFor(count) {
          if (events.length >= count) return Promise.resolve(events);
          return new Promise((done, fail) => {
            const timeout = setTimeout(() => {
              pending.delete(check);
              fail(new Error(`Expected ${count} SSE events; received ${events.length}`));
            }, 2_000);
            const check = () => {
              if (events.length < count) return;
              clearTimeout(timeout);
              pending.delete(check);
              done(events);
            };
            pending.add(check);
          });
        },
      });
    });
    req.on('error', reject);
  });
}

test('normalization generates metadata and excludes unknown sensitive fields', () => {
  const event = normalizeEvent(sample({ prompt: 'DO NOT STORE', output: 'DO NOT STORE', title: '  공개 작업명  ' }));
  assert.match(event.id, /^[a-f\d-]{36}$/u);
  assert.equal(new Date(event.timestamp).toISOString(), event.timestamp);
  assert.equal(event.title, '공개 작업명');
  assert.equal('prompt' in event, false);
  assert.equal('output' in event, false);
  assert.ok(Object.isFrozen(event));
  assert.equal(normalizeEvent(sample({ timestamp: '2026-09-12T09:00:00+09:00' })).timestamp, '2026-09-12T00:00:00.000Z');
});

test('HTTP rejects far-future lifecycle and model evidence without locking normal updates', async t => {
  const port = await fixture(t);
  const now = Date.now();
  for (const fields of [
    { timestamp: new Date(now + 120_000).toISOString() },
    { modelEvidence: 'reported', model: 'reported-model', modelObservedAt: new Date(now + 120_000).toISOString() },
  ]) {
    const rejected = await request(port, '/api/events', { method: 'POST', body: sample(fields) });
    assert.equal(rejected.status, 400);
  }
  assert.equal((await request(port, '/api/state')).json.agents.length, 0);
  assert.equal((await request(port, '/api/events', { method: 'POST', body: sample({ timestamp: new Date(now + 30_000).toISOString() }) })).status, 202,
    'small local clock skew remains accepted');
  const old = sample({ agentId: 'history-worker', timestamp: '2020-01-01T00:00:00.000Z' });
  assert.equal((await request(port, '/api/events', { method: 'POST', body: old })).status, 202);
  assert.equal(normalizeEvent(sample({ timestamp: '2099-01-01T00:00:00.000Z' })).timestamp, '2099-01-01T00:00:00.000Z',
    'historical normalization is independent of the HTTP receipt clock');
});

test('invalid schema and ambiguous handoffs are rejected', () => {
  for (const invalid of [
    null, [], 'event', {}, sample({ source: 'unknown' }), sample({ type: 'thinking.raw' }),
    sample({ agentId: '' }), sample({ title: 'x'.repeat(161) }), sample({ agentName: 123 }),
    sample({ status: 'running' }), sample({ id: 'first\nsecond' }),
    sample({ type: 'handoff' }), sample({ type: 'handoff', toAgentId: '' }),
    sample({ timestamp: 'tomorrow' }), sample({ timestamp: '2026-09-12' }),
    sample({ timestamp: '2026-02-30T00:00:00Z' }), sample({ timestamp: '2026-09-12T24:00:00Z' }),
  ]) assert.throws(() => normalizeEvent(invalid));
  const event = normalizeEvent(sample({ type: 'handoff', toAgentId: 'reviewer' }));
  assert.equal(event.toAgentId, 'reviewer');
});

test('health and history describe actual accepted events; duplicate IDs do not mutate them', async (t) => {
  const port = await fixture(t);
  const health = await request(port, '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal(health.json.service, 'agent-office');
  assert.equal('instanceId' in health.json, false);
  assert.equal(health.json.eventCount, 0);
  const first = await request(port, '/api/events', { method: 'POST', body: sample({ id: 'stable-id', prompt: 'private content' }) });
  assert.equal(first.status, 202);
  assert.equal(first.json.duplicate, false);
  assert.equal(first.text.includes('private content'), false);
  const duplicate = await request(port, '/api/events', { method: 'POST', body: sample({ id: 'stable-id', title: 'changed title' }) });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.json.duplicate, true);
  assert.deepEqual(duplicate.json.event, first.json.event);
  const history = await request(port, '/api/history');
  assert.deepEqual(history.json.events, [first.json.event]);
  assert.equal((await request(port, '/api/health')).json.eventCount, 1);
});

test('health reports the configured runtime instance without adding it to office state', async t => {
  const port = await fixture(t, { instanceId: 'desktop-instance', service: 'agent-office' });
  const health = (await request(port, '/api/health')).json;
  assert.equal(health.service, 'agent-office');
  assert.equal(health.instanceId, 'desktop-instance');
  assert.equal('instanceId' in (await request(port, '/api/state')).json, false);
});

test('history is bounded to 200, while SSE replays the latest 100 and continues live', async (t) => {
  const port = await fixture(t);
  for (let index = 0; index < 205; index += 1) {
    const result = await request(port, '/api/events', { method: 'POST', body: sample({ id: `event-${index}` }) });
    assert.equal(result.status, 202);
  }
  const history = (await request(port, '/api/history')).json.events;
  assert.equal(history.length, 200);
  assert.equal(history[0].id, 'event-5');
  const stream = await openStream(port);
  t.after(stream.close);
  assert.equal(stream.status, 200);
  assert.match(stream.headers['content-type'], /^text\/event-stream/u);
  await stream.waitFor(100);
  assert.equal(stream.events[0].id, 'event-105');
  assert.equal(stream.events.at(-1).id, 'event-204');
  assert.equal((await request(port, '/api/health')).json.connections, 1);
  await request(port, '/api/events', { method: 'POST', body: sample({ id: 'event-205', type: 'handoff', toAgentId: 'reviewer' }) });
  await stream.waitFor(101);
  assert.equal(stream.events.at(-1).toAgentId, 'reviewer');
  await request(port, '/api/events', { method: 'POST', body: sample({ id: 'event-205' }) });
  await request(port, '/api/events', { method: 'POST', body: sample({ id: 'event-206' }) });
  await stream.waitFor(102);
  assert.equal(stream.events.at(-1).id, 'event-206', 'duplicate was not broadcast');
});

test('SSE reconnect uses Last-Event-ID and server shutdown closes streams', async (t) => {
  const server = createOfficeServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const port = server.address().port;
  for (const id of ['one', 'two', 'three']) {
    await request(port, '/api/events', { method: 'POST', body: sample({ id }) });
  }
  const stream = await openStream(port, { 'Last-Event-ID': 'two' });
  t.after(stream.close);
  await stream.waitFor(1);
  assert.deepEqual(stream.events.map((event) => event.id), ['three']);
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  assert.equal(server.listening, false);
});

test('Host and Origin protections permit local tools and reject foreign sites', async (t) => {
  const port = await fixture(t);
  for (const headers of [
    { Host: 'attacker.example:4780' }, { Host: 'localhost.attacker.example:4780' },
    { Host: '127.0.0.1:9999' }, { Origin: 'https://attacker.example' },
    { Origin: 'null' }, { Origin: 'http://localhost:5173.attacker.example' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    const result = await request(port, '/api/events', { method: 'POST', headers, body: sample() });
    assert.equal(result.status, 403);
    assert.equal(result.headers['access-control-allow-origin'], undefined);
  }
  for (const origin of ['http://localhost:5173', 'http://127.0.0.1:4173', 'http://127.0.0.1:4780']) {
    const result = await request(port, '/api/health', { headers: { Origin: origin } });
    assert.equal(result.status, 200);
    assert.equal(result.headers['access-control-allow-origin'], origin);
    assert.equal(result.headers.vary, 'Origin');
  }
  const options = await request(port, '/api/events', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } });
  assert.equal(options.status, 204);
  assert.equal(options.headers['access-control-allow-headers'], 'Content-Type, Last-Event-ID');
  assert.equal((await request(port, '/api/history')).json.events.length, 0);
});

test('POST enforces JSON and 16 KiB for declared and chunked payloads without leaking rejected data', async (t) => {
  const port = await fixture(t);
  assert.equal((await request(port, '/api/events', { method: 'POST', body: '{invalid' })).status, 400);
  assert.equal((await request(port, '/api/events', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: sample() })).status, 415);
  for (const chunked of [false, true]) {
    const result = await request(port, '/api/events', { method: 'POST', body: sample({ prompt: 'secret'.repeat(4_000) }), chunked });
    assert.equal(result.status, 413);
    assert.equal(result.text.includes('secret'), false);
  }
  const invalid = await request(port, '/api/events', { method: 'POST', body: sample({ source: 'secret-source' }) });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.text.includes('secret-source'), false);
  assert.equal((await request(port, '/api/history')).json.events.length, 0);
  assert.equal((await request(port, '/api/health', { method: 'POST' })).status, 405);
  assert.equal((await request(port, '/missing')).status, 404);
});

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-office-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('v0.2 metadata is allowlisted and an unreported model stays unknown', () => {
  const metadata = {
    projectId: 'project-001', projectName: '작은회사', sessionId: 'session-001', sessionName: '첫 번째 채팅',
    parentAgentId: 'parent-001', model: 'reported-model', modelEvidence: 'reported', observation: 'hook', toolName: 'Read',
  };
  const event = normalizeEvent(sample({ ...metadata, agentId: 'a'.repeat(160), type: 'user.instruction' }));
  for (const [key, value] of Object.entries(metadata)) assert.equal(event[key], value);
  for (const type of ['agent.retired', 'session.ended']) assert.equal(normalizeEvent(sample({ type })).type, type);
  assert.equal(normalizeEvent(sample({ source: 'codex', observation: 'codex-log' })).observation, 'codex-log');
  const unknown = normalizeEvent(sample({ model: 'selected-but-unconfirmed', selectedModel: 'private-selection' }));
  assert.equal(unknown.modelEvidence, 'unknown');
  assert.equal('model' in unknown, false);
  assert.equal('selectedModel' in unknown, false);
  for (const invalid of [
    { modelEvidence: 'guessed' }, { modelEvidence: 'reported' }, { observation: 'inferred' },
    { agentId: 'a'.repeat(161) }, { projectId: 'a'.repeat(121) }, { projectName: 'a'.repeat(101) },
    { sessionId: 'a'.repeat(121) }, { sessionName: 'a'.repeat(161) }, { parentAgentId: 'a'.repeat(121) },
    { model: 'a'.repeat(101), modelEvidence: 'reported' }, { toolName: 'a'.repeat(101) },
  ]) assert.throws(() => normalizeEvent(sample(invalid)));
});

test('state preserves quiet agents and distinguishes response completion, retirement, and session ending', async (t) => {
  const port = await fixture(t, { initialEvents: [sample({
    id: 'quiet-start', agentId: 'quiet', projectId: 'p1', projectName: '프로젝트',
    sessionId: 's1', model: 'observed-model', modelEvidence: 'reported', observation: 'hook',
  })] });
  for (let index = 0; index < 201; index++) {
    await request(port, '/api/events', { method: 'POST', body: sample({ id: `active-${index}`, agentId: 'active', sessionId: 's1', projectId: 'p1' }) });
  }
  let state = (await request(port, '/api/state')).json;
  assert.equal(state.events.length, 200);
  assert.ok(state.agents.some(agent => agent.agentId === 'quiet'));
  assert.equal(state.projects[0].agentCount, 2);
  assert.equal(state.projects[0].sessionCount, 1);
  await request(port, '/api/events', { method: 'POST', body: sample({ type: 'agent.completed', agentId: 'quiet', status: 'done' }) });
  state = (await request(port, '/api/state')).json;
  const completed = state.agents.find(agent => agent.agentId === 'quiet');
  assert.equal(completed.status, 'idle');
  assert.equal(completed.retired, false);
  assert.equal(completed.model, 'observed-model');
  assert.equal(completed.modelEvidence, 'reported');
  assert.equal(state.events.at(-1).status, 'done', 'original protocol events stay backward compatible');
  await request(port, '/api/events', { method: 'POST', body: sample({ type: 'session.ended', agentId: 'active', sessionId: 's1' }) });
  state = (await request(port, '/api/state')).json;
  assert.ok(state.agents.every(agent => agent.status === 'idle' && agent.sessionEnded && !agent.retired));
  await request(port, '/api/events', { method: 'POST', body: sample({ type: 'agent.retired', agentId: 'quiet' }) });
  state = (await request(port, '/api/state')).json;
  assert.equal(state.agents.find(agent => agent.agentId === 'quiet').retired, true);
  await request(port, '/api/events', { method: 'POST', body: sample({ type: 'agent.started', agentId: 'quiet' }) });
  state = (await request(port, '/api/state')).json;
  assert.equal(state.agents.find(agent => agent.agentId === 'quiet').retired, false);
  assert.equal(state.agents.find(agent => agent.agentId === 'quiet').sessionEnded, false);
  assert.equal((await request(port, '/api/health')).json.persistence.enabled, false);
});

test('private JSONL persistence survives an actual server restart, bounds history, and restores quiet snapshots', async (t) => {
  const root = temporaryDirectory(t);
  const dataDir = join(root, 'private');
  const initialEvents = [sample({ id: 'quiet-old-event', agentId: 'quiet', projectId: 'project', modelEvidence: 'reported', model: 'observed-model' })];
  for (let index = 0; index < 5100; index++) initialEvents.push(sample({ id: `busy-${index}`, agentId: 'busy', projectId: 'project' }));
  const first = createOfficeServer({ dataDir, initialEvents });
  first.listen(0, '127.0.0.1');
  await once(first, 'listening');
  const firstPort = first.address().port;
  const accepted = await request(firstPort, '/api/events', { method: 'POST', body: sample({
    id: 'persistent-live', agentId: 'busy', type: 'agent.completed', status: 'done', prompt: 'NEVER STORE RAW PROMPT',
  }) });
  assert.equal(accepted.status, 202);
  const health = (await request(firstPort, '/api/health')).json;
  assert.equal(health.persistence.enabled, true);
  assert.equal(health.persistence.retainedEventCount, 5000);
  assert.ok(health.lastReceivedAt);
  await new Promise((resolve, reject) => first.close(error => error ? reject(error) : resolve()));
  const secondPort = await fixture(t, { dataDir });
  const state = (await request(secondPort, '/api/state')).json;
  assert.equal(state.events.length, 200);
  assert.equal(state.events.at(-1).id, 'persistent-live');
  assert.equal(state.agents.find(agent => agent.agentId === 'quiet').model, 'observed-model');
  assert.equal(state.agents.find(agent => agent.agentId === 'busy').status, 'idle');
  const duplicate = await request(secondPort, '/api/events', { method: 'POST', body: sample({ id: 'busy-101' }) });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.json.duplicate, true, 'persistent archive IDs also deduplicate after restart');
  const journal = readFileSync(join(dataDir, 'events.jsonl'), 'utf8');
  assert.equal(journal.trim().split('\n').length, 5000);
  assert.equal(journal.includes('NEVER STORE RAW PROMPT'), false);
  assert.equal(statSync(dataDir).mode & 0o777, 0o700);
  for (const name of ['events.jsonl', 'agents.json']) assert.equal(statSync(join(dataDir, name)).mode & 0o777, 0o600);
});

test('registry is bounded and damaged journal lines are recovered without reflecting unknown fields', async (t) => {
  const root = temporaryDirectory(t);
  const dataDir = join(root, 'private');
  mkdirSync(dataDir);
  const rows = Array.from({ length: 520 }, (_, index) => JSON.stringify(sample({ id: `event-${index}`, agentId: `agent-${index}` })));
  rows.push('{broken record', JSON.stringify(sample({ id: 'sanitized', agentId: 'agent-519', prompt: 'PRIVATE_TEXT' })));
  writeFileSync(join(dataDir, 'events.jsonl'), rows.join('\n'));
  const port = await fixture(t, { dataDir });
  const state = (await request(port, '/api/state')).json;
  assert.equal(state.agents.length, 512);
  assert.equal(state.agents.some(agent => agent.agentId === 'agent-0'), false);
  assert.equal(state.events.at(-1).id, 'sanitized');
  assert.equal(readFileSync(join(dataDir, 'events.jsonl'), 'utf8').includes('PRIVATE_TEXT'), false);
  assert.equal((await request(port, '/api/health')).json.persistence.recoveredRecords, 1);
});

test('static UI serves only public build files and blocks traversal, private files, and symlink escapes', async (t) => {
  const root = temporaryDirectory(t);
  const staticDir = join(root, 'dist');
  const dataDir = join(root, 'private');
  mkdirSync(join(staticDir, 'assets'), { recursive: true });
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>작은회사</title>');
  writeFileSync(join(staticDir, 'assets', 'app.js'), 'window.office = true;');
  writeFileSync(join(staticDir, '.env'), 'PRIVATE_ENV');
  writeFileSync(join(root, 'outside.json'), '{"private":"OUTSIDE_SECRET"}');
  symlinkSync(join(root, 'outside.json'), join(staticDir, 'leak.json'));
  symlinkSync(root, join(staticDir, 'escape'));
  const port = await fixture(t, { staticDir, dataDir });
  const page = await request(port, '/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/u);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/u);
  assert.match(page.text, /작은회사/u);
  const asset = await request(port, '/assets/app.js?v=1');
  assert.equal(asset.status, 200);
  assert.equal(asset.text, 'window.office = true;');
  assert.equal((await request(port, '/assets/app.js', { method: 'HEAD' })).text, '');
  for (const path of ['/../outside.json', '/%2e%2e/outside.json', '/assets/%2e%2e/%2e%2e/outside.json',
    '/leak.json', '/escape/outside.json', '/.env', '/%2eenv', '/server/bridge.mjs',
    '/events.jsonl', '/agents.json', '/api/missing', '/assets%5c..%5coutside.json']) {
    const result = await request(port, path);
    assert.equal(result.status, 404, path);
    assert.equal(result.text.includes('OUTSIDE_SECRET'), false);
    assert.equal(result.text.includes('PRIVATE_ENV'), false);
  }
  assert.equal((await request(port, '/api/health')).json.ok, true);
  assert.throws(() => createOfficeServer({ dataDir: join(staticDir, 'data'), staticDir }));
});

test('a redirected data file cannot receive events or silently pass persistence health', async (t) => {
  const root = temporaryDirectory(t);
  const dataDir = join(root, 'private');
  const port = await fixture(t, { dataDir });
  const outside = join(root, 'outside.json');
  writeFileSync(outside, 'DO NOT MODIFY');
  unlinkSync(join(dataDir, 'events.jsonl'));
  symlinkSync(outside, join(dataDir, 'events.jsonl'));
  const result = await request(port, '/api/events', { method: 'POST', body: sample() });
  assert.equal(result.status, 500);
  assert.equal(readFileSync(outside, 'utf8'), 'DO NOT MODIFY');
  assert.equal((await request(port, '/api/history')).json.events.length, 0);
  assert.equal((await request(port, '/api/health')).json.persistence.healthy, false);
});

test('a new unknown turn drops the old model while repeated child hooks preserve observed root grouping across restart', async (t) => {
  const root = temporaryDirectory(t);
  const dataDir = join(root, 'private');
  const first = createOfficeServer({ dataDir });
  first.listen(0, '127.0.0.1');
  await once(first, 'listening');
  const port = first.address().port;
  const post = body => request(port, '/api/events', { method: 'POST', body: sample({ source: 'codex', agentId: 'child', ...body }) });
  await post({ observation: 'codex-log', sessionId: 'root-session', sessionName: '상위 채팅', parentAgentId: 'parent',
    taskId: 'child-turn-1', model: 'turn-one-model', modelEvidence: 'reported' });
  for (let index = 0; index < 2; index++) await post({ observation: 'hook', sessionId: 'child-session',
    type: 'agent.status', taskId: 'child-turn-1', modelEvidence: 'unknown' });
  let child = (await request(port, '/api/state')).json.agents[0];
  assert.equal(child.sessionId, 'root-session');
  assert.equal(child.sessionObservation, 'codex-log');
  assert.equal(child.observation, 'hook');
  assert.equal(child.model, 'turn-one-model', 'same-turn missing model keeps direct earlier evidence');
  await post({ observation: 'codex-log', sessionId: 'root-session', taskId: 'child-turn-2', modelEvidence: 'unknown' });
  child = (await request(port, '/api/state')).json.agents[0];
  assert.equal(child.modelEvidence, 'unknown');
  assert.equal('model' in child, false, 'another turn must not inherit the previous model');
  await new Promise((resolve, reject) => first.close(error => error ? reject(error) : resolve()));
  const secondPort = await fixture(t, { dataDir });
  await request(secondPort, '/api/events', { method: 'POST', body: sample({ source: 'codex', agentId: 'child',
    observation: 'hook', sessionId: 'child-session', type: 'agent.status' }) });
  child = (await request(secondPort, '/api/state')).json.agents[0];
  assert.equal(child.sessionId, 'root-session');
  assert.equal(child.sessionObservation, 'codex-log');
  assert.equal(child.parentAgentId, 'parent');
  assert.equal(child.modelEvidence, 'unknown');
});
