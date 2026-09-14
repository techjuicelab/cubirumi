import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, symlink, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { companyName, readSettings, writeSettings, normalizeSettingsPatch, createSettingsStore } from '../server/settings.mjs';
import { createOfficeServer } from '../server/bridge.mjs';

function get(port, path, headers = {}, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { Host: '127.0.0.1:4780', ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('company preferences expose only a validated display name and never extra local fields', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'office-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(readSettings(dir), { companyName: '나의 회사', ownerName: '나' });
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ companyName: '예시 스튜디오', apiKey: 'PRIVATE-FIXTURE' }));
  assert.deepEqual(readSettings(dir), { companyName: '예시 스튜디오', ownerName: '나' });
  const server = createOfficeServer({ dataDir: dir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await get(server.address().port, '/api/settings');
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.text), { companyName: '예시 스튜디오', ownerName: '나' });
  const denied = await get(server.address().port, '/api/settings', { Origin: 'https://outside.example' });
  assert.equal(denied.status, 403);
  await writeFile(join(dir, 'settings.json'), '{broken');
  assert.deepEqual(readSettings(dir), { companyName: '나의 회사', ownerName: '나' });
  for (const name of [null, '', 'x'.repeat(81), 'name\nsecret']) assert.equal(companyName(name), '나의 회사');
});

test('the settings endpoint updates the owner while preserving the existing company', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'office-settings-update-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ companyName: '예시 스튜디오' }));
  const server = createOfficeServer({ dataDir: dir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await get(server.address().port, '/api/settings', { 'Content-Type': 'application/json' },
    { method: 'PATCH', body: { ownerName: '가람' } });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.text), { companyName: '예시 스튜디오', ownerName: '가람' });
  assert.deepEqual(readSettings(dir), JSON.parse(response.text));
  assert.equal((await stat(join(dir, 'settings.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
});

test('settings validation permits bounded Unicode names and rejects extra keys or control characters', () => {
  assert.deepEqual(normalizeSettingsPatch({ companyName: '  예시 회사  ', ownerName: ' 가람 ' }), { companyName: '예시 회사', ownerName: '가람' });
  assert.equal([...normalizeSettingsPatch({ ownerName: '🌱'.repeat(40) }).ownerName].length, 40);
  for (const input of [null, [], {}, { ownerName: 42 }, { ownerName: ' ' }, { ownerName: '🌱'.repeat(41) },
    { companyName: '가'.repeat(81) }, { ownerName: '가\n람' }, { ownerName: '가\u0085람' }, { ownerName: '가\u2028람' },
    { ownerName: '가람', apiKey: 'private' }, JSON.parse('{"__proto__":"private"}')]) assert.throws(() => normalizeSettingsPatch(input));
  const memory = createSettingsStore();
  const before = memory.update({ ownerName: '가람' });
  assert.throws(() => memory.update({ ownerName: '' }));
  assert.deepEqual(memory.state(), before);
});

test('settings writes preserve the old file on partial-write or publication failure and remove only their own temporary', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'office-settings-atomic-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'settings.json');
  const original = `${JSON.stringify({ companyName: '예시 회사', ownerName: '가람' })}\n`;
  await writeFile(path, original);
  await writeFile(join(dir, 'settings.json.unrelated.tmp'), 'keep');
  for (const operations of [
    { writeFileSync: descriptor => { writeFileSync(descriptor, 'partial'); throw new Error('Injected write failure'); } },
    { renameSync: () => { throw new Error('Injected rename failure'); } },
  ]) {
    assert.throws(() => writeSettings(dir, { ownerName: '솔' }, { operations }), /Injected/);
    assert.equal(await readFile(path, 'utf8'), original);
    assert.deepEqual((await readdir(dir)).sort(), ['settings.json', 'settings.json.unrelated.tmp']);
  }
  assert.deepEqual(writeSettings(dir, { companyName: '새 예시 회사' }), { companyName: '새 예시 회사', ownerName: '가람' });
  assert.deepEqual(createSettingsStore({ dataDir: dir }).state(), { companyName: '새 예시 회사', ownerName: '가람' });
});

test('an external settings update during publication is retained instead of being overwritten', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'office-settings-race-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'settings.json');
  writeSettings(dir, { companyName: '예시 회사', ownerName: '가람' });
  const external = { companyName: '다른 예시 회사', ownerName: '솔' };
  assert.throws(() => writeSettings(dir, { ownerName: '새 이름' }, { operations: {
    writeFileSync(descriptor, text) { writeFileSync(descriptor, text); writeFileSync(path, JSON.stringify(external)); },
  } }), /다른 작업/);
  assert.deepEqual(readSettings(dir), external);
  assert.deepEqual(await readdir(dir), ['settings.json']);
});

test('unreadable and linked preferences fail closed without changing the file they refer to', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'office-settings-links-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outside = join(dir, 'outside.json'), target = join(dir, 'preferences');
  await mkdir(target);
  const original = JSON.stringify({ companyName: '예시 회사', ownerName: '가람' });
  await writeFile(outside, original);
  await symlink(outside, join(target, 'settings.json'));
  assert.throws(() => writeSettings(target, { ownerName: '솔' }));
  assert.equal(await readFile(outside, 'utf8'), original);
  await rm(join(target, 'settings.json'));
  await writeFile(join(target, 'settings.json'), '{broken');
  assert.throws(() => writeSettings(target, { ownerName: '솔' }));
  assert.equal(await readFile(join(target, 'settings.json'), 'utf8'), '{broken');
  const linkedDirectory = join(dir, 'linked-preferences');
  await symlink(target, linkedDirectory);
  assert.throws(() => writeSettings(linkedDirectory, { ownerName: '솔' }));
});

test('the company CLI changes only the company and preserves the saved owner', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'office-settings-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  writeSettings(dir, { companyName: '예시 회사', ownerName: '가람' });
  const cli = new URL('../scripts/set-company.mjs', import.meta.url);
  const run = name => spawnSync(process.execPath, [cli.pathname, name], { encoding: 'utf8', env: { ...process.env, AGENT_OFFICE_DATA_DIR: dir } });
  assert.equal(run('다른 예시 회사').status, 0);
  assert.deepEqual(readSettings(dir), { companyName: '다른 예시 회사', ownerName: '가람' });
  assert.equal(run('bad\nname').status, 1);
  assert.deepEqual(readSettings(dir), { companyName: '다른 예시 회사', ownerName: '가람' });
});

test('settings mutations retain localhost, JSON, size, method, and allowlist protections', async t => {
  const server = createOfficeServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const update = (body, headers = {}, method = 'PATCH') => get(port, '/api/settings', { 'Content-Type': 'application/json', ...headers }, { method, body });
  for (const headers of [{ Host: 'outside.example:4780' }, { Origin: 'https://outside.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await update({ ownerName: '가람' }, headers)).status, 403);
  }
  assert.equal((await update({ ownerName: '가람' }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await update({ ownerName: 'x'.repeat(17000) })).status, 413);
  for (const body of [{}, { ownerName: '' }, { ownerName: '가람', secret: 'private' }]) assert.equal((await update(body)).status, 400);
  const accepted = await update({ ownerName: '가람' }, { Origin: 'http://localhost:5173' });
  assert.equal(accepted.status, 200);
  assert.deepEqual(JSON.parse(accepted.text), { companyName: '나의 회사', ownerName: '가람' });
  assert.equal((await update({ companyName: '예시 회사' }, {}, 'POST')).status, 200);
  assert.deepEqual(JSON.parse((await get(port, '/api/settings')).text), { companyName: '예시 회사', ownerName: '가람' });
  const options = await get(port, '/api/settings', { Origin: 'http://localhost:5173' }, { method: 'OPTIONS' });
  assert.equal(options.status, 204); assert.match(options.headers['access-control-allow-methods'], /PATCH/);
  const denied = await update(undefined, {}, 'DELETE');
  assert.equal(denied.status, 405); assert.match(denied.headers.allow, /PATCH/);
});

test('published license notices are readable while arbitrary text stays private', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'office-notices-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'fonts', 'example-font'), { recursive: true });
  await writeFile(join(dir, 'THIRD_PARTY_NOTICES.txt'), 'Attribution fixture');
  await writeFile(join(dir, 'fonts', 'example-font', 'LICENSE.txt'), 'Font license fixture');
  await writeFile(join(dir, 'private.txt'), 'Do not serve');
  const server = createOfficeServer({ staticDir: dir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const path of ['/THIRD_PARTY_NOTICES.txt', '/fonts/example-font/LICENSE.txt']) {
    const response = await get(server.address().port, path);
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], /^text\/plain/u);
  }
  assert.equal((await get(server.address().port, '/private.txt')).status, 404);
});
