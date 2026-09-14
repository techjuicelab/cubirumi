import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('../scripts/check-public.mjs', import.meta.url));
const denyTerm = 'example-private-marker';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'office-public-scan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = args => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '--quiet']);
  const scan = () => spawnSync(process.execPath, [checker], {
    cwd: directory, encoding: 'utf8', env: { ...process.env, PUBLIC_DENY_TERMS: denyTerm },
  });
  return { directory, git, scan };
}

test('a NUL byte cannot hide private terms elsewhere in tracked source or documentation', async t => {
  const { directory, git, scan } = await fixture(t);
  for (const name of ['fixture.mjs', 'fixture.swift', 'fixture.md', 'fixture.json']) {
    await writeFile(join(directory, name), `benign${String.fromCharCode(0)}fixture\n${denyTerm}\n`);
    git(['add', '--', name]);
  }
  const result = scan();
  assert.equal(result.status, 1);
  for (const name of ['fixture.mjs', 'fixture.swift', 'fixture.md', 'fixture.json']) {
    assert.ok(result.stderr.includes(`${name}: 로컬 비공개 금지어`));
  }
  assert.equal(result.stderr.includes(denyTerm), false, 'reports disclose only the path and finding type');
});

test('public scanning checks staged content even when the working copy differs', async t => {
  const { directory, git, scan } = await fixture(t);
  const path = join(directory, 'fixture.mjs');
  await writeFile(path, `${denyTerm}\n`); git(['add', '--', 'fixture.mjs']);
  await writeFile(path, 'export const safe = true;\n');
  assert.equal(scan().status, 1, 'an unstaged cleanup must not hide the staged private content');
  git(['add', '--', 'fixture.mjs']);
  await writeFile(path, `${denyTerm}\n`);
  assert.equal(scan().status, 0, 'unstaged local content is outside the committed public snapshot');
});
