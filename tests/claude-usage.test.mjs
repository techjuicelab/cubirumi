import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lastResponseAt, normalizeClaudeUsage, reportClaudeUsage, usageEndpoint } from '../scripts/claude-statusline.mjs';
import { installStatusline, shellQuote } from '../scripts/install-claude.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = {
  rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 2000000000 }, seven_day: { used_percentage: 0, resets_at: 2000600000 } },
  session_id: 'PRIVATE SESSION', transcript_path: '/private/PRIVATE.jsonl', cwd: '/private/PRIVATE',
  prompt: 'PRIVATE PROMPT', auth: 'PRIVATE TOKEN', model: { id: 'PRIVATE MODEL' },
};
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-office-claude-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function receiver(t) {
  let receive;
  const received = new Promise(resolve => { receive = resolve; });
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    receive({ path: request.url, method: request.method, body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.writeHead(200); response.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { endpoint: `http://127.0.0.1:${server.address().port}/api/usage`, received };
}
function run(input, configPath, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/claude-statusline.mjs', '--config', configPath], { cwd: root, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Statusline process timeout')); }, 3000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}
async function waitForReport(received) {
  let timer;
  try { return await Promise.race([received, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Usage report timeout')), 2500); })]); }
  finally { clearTimeout(timer); }
}

test('Claude quota normalization keeps only valid official rate-limit numbers', () => {
  const result = normalizeClaudeUsage(fixture, 1800000000000);
  assert.deepEqual(result.windows, [
    { id: 'five_hour', label: '5시간', usedPercent: 23.5, windowMinutes: 300, resetsAt: 2000000000 },
    { id: 'seven_day', label: '주간', usedPercent: 0, windowMinutes: 10080, resetsAt: 2000600000 },
  ]);
  assert.equal(result.source, 'claude-statusline'); assert.equal(result.status, 'live');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|session|transcript|auth|model|prompt/u);
  for (const rate_limits of [undefined, {}, { five_hour: { used_percentage: '25' } }, { five_hour: { used_percentage: -1 } }, { seven_day: { used_percentage: 101 } }]) {
    assert.deepEqual(normalizeClaudeUsage({ rate_limits }), { provider: 'claude', status: 'unavailable', updatedAt: null,
      source: 'claude-statusline', reason: 'not-observed', windows: [] });
  }
  assert.equal(normalizeClaudeUsage({ rate_limits: { five_hour: { used_percentage: 5, resets_at: 'PRIVATE' } } }).windows[0].resetsAt, null);
});

test('usage reports use real local HTTP with safe payloads and refuse non-local destinations', async t => {
  for (const endpoint of ['https://example.com/api/usage', 'http://127.0.0.1:4780/api/events', 'http://user:secret@localhost/api/usage', 'http://localhost/api/usage?token=x']) assert.throws(() => usageEndpoint(endpoint));
  const target = await receiver(t);
  assert.equal(await reportClaudeUsage(fixture, target.endpoint), true);
  const report = await target.received;
  assert.equal(report.path, '/api/usage'); assert.equal(report.method, 'POST');
  assert.equal(report.body.provider, 'claude'); assert.equal(report.body.windows[0].usedPercent, 23.5);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|transcript|prompt/u);
  assert.equal(await reportClaudeUsage(fixture, 'http://127.0.0.1:1/api/usage'), false);
});

test('detached reports retain the original observation time instead of looking fresh after a delayed launch', async t => {
  const target = await receiver(t);
  const observedAt = '2026-01-01T00:00:00.000Z';
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/claude-statusline.mjs', '--report'], {
      cwd: root, env: { ...process.env, AGENT_OFFICE_USAGE_ENDPOINT: target.endpoint }, stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Reporter exited')));
    child.stdin.end(JSON.stringify({ rate_limits: fixture.rate_limits, observedAt }));
  });
  assert.equal((await waitForReport(target.received)).body.updatedAt, observedAt);
});

test('invalid or future observation timestamps cannot become a fresh quota report', async t => {
  const target = await receiver(t);
  for (const observedAt of ['invalid', '2026-01-01', 1234, new Date(Date.now() + 120_000).toISOString()]) {
    assert.equal(await reportClaudeUsage(fixture, target.endpoint, { observedAt }), false);
  }
});

test('statusline wrapper preserves exact stdin and existing stdout while sending quota separately', async t => {
  const directory = await temporary(t);
  const target = await receiver(t);
  const previous = join(directory, 'previous.mjs');
  await writeFile(previous, "import { createHash } from 'node:crypto'; const chunks=[]; for await(const chunk of process.stdin)chunks.push(chunk); process.stdout.write('\\u001b[32mExisting\\u001b[0m '+createHash('sha256').update(Buffer.concat(chunks)).digest('hex'));\n");
  const configPath = join(directory, 'statusline.json');
  await writeFile(configPath, JSON.stringify({ endpoint: target.endpoint, previousStatusLine: { type: 'command', command: `${shellQuote(process.execPath)} ${shellQuote(previous)}` } }));
  const input = Buffer.from(`${JSON.stringify(fixture, null, 2)}\n`);
  const result = await run(input, configPath);
  assert.deepEqual(result, { code: 0, stdout: `\u001b[32mExisting\u001b[0m ${createHash('sha256').update(input).digest('hex')}`, stderr: '' });
  const report = await waitForReport(target.received);
  assert.equal(report.body.windows[1].usedPercent, 0);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE/u);
  await writeFile(configPath, JSON.stringify({ endpoint: 'http://127.0.0.1:1/api/usage' }));
  const unknown = await run('{}', configPath);
  assert.deepEqual(unknown, { code: 0, stdout: 'Agent Office · 사용 한도 미확인\n', stderr: '' });
});

test('the statusline environment endpoint overrides the saved receiver without exposing input', async t => {
  const directory = await temporary(t);
  const target = await receiver(t);
  const configPath = join(directory, 'statusline.json');
  await writeFile(configPath, JSON.stringify({ endpoint: 'http://127.0.0.1:1/api/usage' }));
  const result = await run(JSON.stringify(fixture), configPath, { AGENT_OFFICE_USAGE_ENDPOINT: target.endpoint });
  assert.equal(result.code, 0);
  const report = await waitForReport(target.received);
  assert.equal(report.body.windows[0].usedPercent, 23.5);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE/u);
});

test('an idle session refresh reports when its numbers were received, not when the status line re-ran', async t => {
  const directory = await temporary(t);
  const transcript = join(directory, 'session.jsonl');
  const lastResponse = '2026-01-02T03:04:05.000Z';
  await writeFile(transcript, [
    JSON.stringify({ type: 'assistant', timestamp: '2026-01-02T03:00:00.000Z', message: { content: 'PRIVATE OLDER' } }),
    JSON.stringify({ type: 'assistant', timestamp: lastResponse, message: { content: 'PRIVATE OUTPUT' } }),
    JSON.stringify({ type: 'user', timestamp: '2026-01-02T03:08:00.000Z', message: { content: 'PRIVATE PROMPT' } }),
    JSON.stringify({ type: 'progress', timestamp: '2026-01-02T03:09:00.000Z' }),
  ].join('\n') + '\n');
  assert.equal(await lastResponseAt(transcript), Date.parse(lastResponse));
  assert.equal(await lastResponseAt(join(directory, 'missing.jsonl')), null);
  assert.equal(await lastResponseAt('relative.jsonl'), null);
  assert.equal(await lastResponseAt(join(directory, 'not-a-transcript.txt')), null);
  const target = await receiver(t);
  const configPath = join(directory, 'statusline.json');
  await writeFile(configPath, JSON.stringify({ endpoint: target.endpoint }));
  const result = await run(JSON.stringify({ ...fixture, transcript_path: transcript }), configPath);
  assert.equal(result.code, 0);
  const report = await waitForReport(target.received);
  assert.equal(report.body.updatedAt, lastResponse);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE/u);
});

test('statusline installer preserves unrelated settings and original command on repeated installs', async t => {
  const directory = await temporary(t);
  const configDir = join(directory, 'claude'); const dataDir = join(directory, 'private');
  await mkdir(configDir);
  const original = { enabledPlugins: { 'other@existing': true }, env: { EXAMPLE: 'PRIVATE FIXTURE' },
    statusLine: { type: 'command', command: 'printf existing', padding: 2, refreshInterval: 9 } };
  await writeFile(join(configDir, 'settings.json'), JSON.stringify(original));
  const first = await installStatusline({ root, configDir, dataDir });
  const settings = JSON.parse(await readFile(first.settingsPath, 'utf8'));
  assert.deepEqual(settings.enabledPlugins, original.enabledPlugins); assert.deepEqual(settings.env, original.env);
  assert.equal(settings.statusLine.padding, 2); assert.equal(settings.statusLine.refreshInterval, 9);
  assert.match(settings.statusLine.command, /claude-statusline\.mjs/u);
  assert.deepEqual(JSON.parse(await readFile(first.backupPath, 'utf8')), original);
  assert.deepEqual(JSON.parse(await readFile(first.configPath, 'utf8')).previousStatusLine, original.statusLine);
  await installStatusline({ root, configDir, dataDir });
  assert.deepEqual(JSON.parse(await readFile(first.configPath, 'utf8')).previousStatusLine, original.statusLine, 'reinstall does not nest wrappers');
  for (const path of [first.settingsPath, first.backupPath, first.configPath]) assert.equal((await stat(path)).mode & 0o777, 0o600);
});
