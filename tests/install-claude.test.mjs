import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeMarketplaceRoot, prepareBundledClaudeMarketplace } from '../scripts/install-claude.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cubirumi-claude-install-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function runHook(command, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Hook process timeout')); }, 5000);
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'fixture-session', cwd: '/fixture/project' }));
  });
}

test('a cached bundled Claude hook runs without PATH Node and leaves source hooks unchanged', { timeout: 10000 }, async t => {
  const directory = await temporary(t), dataDir = join(directory, 'private');
  const nodePath = join(directory, "Cubirumi's App.app/Contents/Helpers/node");
  await mkdir(join(nodePath, '..'), { recursive: true }); await symlink(process.execPath, nodePath);
  const bundledRoot = resolve(nodePath, '../../Resources/runtime');
  assert.equal(claudeMarketplaceRoot({ root: bundledRoot, nodePath, dataDir }), join(dataDir, 'claude-integration'));
  assert.equal(claudeMarketplaceRoot({ root, nodePath: process.execPath, dataDir }), root, 'source installations retain their original marketplace');
  const original = await readFile(join(root, 'integrations/claude-plugin/hooks/hooks.json'), 'utf8');
  const marketplace = await prepareBundledClaudeMarketplace({ root, nodePath, dataDir });
  const cache = join(directory, "Claude's plugin cache");
  await cp(join(marketplace, 'integrations/claude-plugin'), cache, { recursive: true });
  const copied = JSON.parse(await readFile(join(cache, 'hooks/hooks.json'), 'utf8'));
  const command = copied.hooks.SessionStart[0].hooks[0].command;
  const received = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    received.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.writeHead(200); response.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const env = { PATH: '', CLAUDE_PLUGIN_ROOT: cache, AGENT_OFFICE_ENDPOINT: `http://127.0.0.1:${server.address().port}/api/events` };
  const legacy = await runHook(JSON.parse(original).hooks.SessionStart[0].hooks[0].command, env);
  assert.equal(legacy.code, 127, 'the former PATH-based command reproduces the failure');
  const result = await runHook(command, env);
  assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
  assert.equal(received.length, 1); assert.equal(received[0].path, '/api/events');
  assert.equal(received[0].body.type, 'agent.started'); assert.equal(received[0].body.source, 'claude');
  assert.equal(await readFile(join(root, 'integrations/claude-plugin/hooks/hooks.json'), 'utf8'), original);
  await prepareBundledClaudeMarketplace({ root, nodePath, dataDir });
  assert.equal((await readdir(join(dataDir, 'claude-backups'))).length, 1, 'reinstall preserves the previous managed copy');
});

test('bundled Claude preparation preserves an unrelated destination', async t => {
  const dataDir = await temporary(t), destination = join(dataDir, 'claude-integration');
  await mkdir(destination); await writeFile(join(destination, 'user-file.txt'), 'preserve');
  await assert.rejects(prepareBundledClaudeMarketplace({ root, dataDir }));
  assert.deepEqual(await readdir(destination), ['user-file.txt']);
  assert.equal(await readFile(join(destination, 'user-file.txt'), 'utf8'), 'preserve');
});
