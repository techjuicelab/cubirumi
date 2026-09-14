import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { installDesktopBundle } from '../scripts/desktop-bundle.mjs';

const identifier = 'io.agent-office.desktop';
const plist = (id = identifier, extra = '') => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>${extra}</dict></plist>`;
async function bundle(path, version, manifest = plist()) {
  await mkdir(join(path, 'Contents'), { recursive: true });
  await writeFile(join(path, 'Contents/Info.plist'), manifest);
  await writeFile(join(path, 'Contents/version'), version);
}
const version = path => readFile(join(path, 'Contents/version'), 'utf8');
async function fixture(t, { installed = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-office-bundle-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = { source: join(directory, 'build/Agent Office.app'), destination: join(directory, 'Applications/Agent Office.app'),
    backupDirectory: join(directory, 'private/backups') };
  await bundle(paths.source, 'new');
  if (installed) await bundle(paths.destination, 'old');
  await mkdir(dirname(paths.destination), { recursive: true });
  await writeFile(join(dirname(paths.destination), '.agent-office-install-other'), 'unrelated temporary');
  await mkdir(paths.backupDirectory, { recursive: true });
  await writeFile(join(paths.backupDirectory, 'existing-backup'), 'unrelated backup');
  return paths;
}
async function assertScopedCleanup(paths, installed = true) {
  assert.deepEqual((await readdir(dirname(paths.destination))).sort(),
    ['.agent-office-install-other', ...(installed ? ['Agent Office.app'] : [])].sort());
  assert.equal(await readFile(join(dirname(paths.destination), '.agent-office-install-other'), 'utf8'), 'unrelated temporary');
  assert.equal(await readFile(join(paths.backupDirectory, 'existing-backup'), 'utf8'), 'unrelated backup');
}

test('first install publishes the bundle and preserves unrelated temporary files', async t => {
  const paths = await fixture(t, { installed: false });
  const result = await installDesktopBundle(paths);
  assert.equal(await version(paths.destination), 'new');
  assert.equal(result.backupPath, null);
  await assertScopedCleanup(paths);
});

test('reinstall retains the old application in its own backup', async t => {
  const paths = await fixture(t);
  const result = await installDesktopBundle(paths);
  assert.equal(await version(paths.destination), 'new');
  assert.equal(await version(result.backupPath), 'old');
  await bundle(paths.source, 'newer');
  const next = await installDesktopBundle(paths);
  assert.notEqual(next.backupPath, result.backupPath);
  assert.equal(await version(paths.destination), 'newer');
  assert.equal(await version(next.backupPath), 'new');
  assert.equal(await version(result.backupPath), 'old');
  await assertScopedCleanup(paths);
});

test('a related string cannot authorize replacing a different bundle identifier', async t => {
  const paths = await fixture(t);
  await bundle(paths.destination, 'other', plist('io.other.application', `<key>RelatedApplication</key><string>${identifier}</string>`));
  await assert.rejects(installDesktopBundle(paths), /보존|identifier/i);
  assert.equal(await version(paths.destination), 'other');
  await assertScopedCleanup(paths);
});

test('an existing bundle with a missing or binary manifest is preserved', async t => {
  const paths = await fixture(t);
  await rm(join(paths.destination, 'Contents/Info.plist'));
  await assert.rejects(installDesktopBundle(paths));
  assert.equal(await version(paths.destination), 'old');
  await writeFile(join(paths.destination, 'Contents/Info.plist'), Buffer.from('bplist00fixture'));
  await assert.rejects(installDesktopBundle(paths));
  assert.equal(await version(paths.destination), 'old');
  await assertScopedCleanup(paths);
});

test('duplicate keys, nested identifiers, malformed XML, and symlink manifests fail closed', async t => {
  const paths = await fixture(t);
  for (const manifest of [
    plist(identifier, '<key>CFBundleIdentifier</key><string>io.other.application</string>'),
    plist('io.other.application', `<key>Related</key><dict><key>CFBundleIdentifier</key><string>${identifier}</string></dict>`),
    plist(identifier).replace('</plist>', ''),
    `${plist(identifier)}<`,
    plist('io.other.application', `<!-- <key>CFBundleIdentifier</key><string>${identifier}</string> -->`),
  ]) {
    await writeFile(join(paths.destination, 'Contents/Info.plist'), manifest);
    await assert.rejects(installDesktopBundle(paths), /보존|identifier/i);
    assert.equal(await version(paths.destination), 'old');
  }
  await rm(join(paths.destination, 'Contents/Info.plist'));
  await symlink(join(paths.source, 'Contents/Info.plist'), join(paths.destination, 'Contents/Info.plist'));
  await assert.rejects(installDesktopBundle(paths), /보존|identifier/i);
  assert.equal(await version(paths.destination), 'old');
  await assertScopedCleanup(paths);
});

test('a partial copy failure leaves the installed application and cleans only its own staging', async t => {
  const paths = await fixture(t);
  await assert.rejects(installDesktopBundle({ ...paths, operations: { cp: async (...args) => {
    await cp(...args); throw new Error('Injected copy failure');
  } } }), /Injected copy failure/);
  assert.equal(await version(paths.destination), 'old');
  await assertScopedCleanup(paths);
});

test('a final rename failure restores the original application before rejecting', async t => {
  const paths = await fixture(t);
  await assert.rejects(installDesktopBundle({ ...paths, operations: { rename: async (from, to) => {
    if (to === paths.destination && from.endsWith('bundle.app')) throw new Error('Injected publish failure');
    return rename(from, to);
  } } }), /Injected publish failure/);
  assert.equal(await version(paths.destination), 'old');
  await assertScopedCleanup(paths);
  assert.deepEqual(await readdir(paths.backupDirectory), ['existing-backup']);
});

test('a failed first install leaves no destination or staging application', async t => {
  const paths = await fixture(t, { installed: false });
  await assert.rejects(installDesktopBundle({ ...paths, operations: { cp: async (...args) => {
    await cp(...args); throw new Error('Injected copy failure');
  } } }), /Injected copy failure/);
  await assertScopedCleanup(paths, false);
  assert.deepEqual(await readdir(paths.backupDirectory), ['existing-backup']);
});

test('a backup rename failure preserves the installed application and removes its empty reservation', async t => {
  const paths = await fixture(t);
  await assert.rejects(installDesktopBundle({ ...paths, operations: { rename: async (from, to) => {
    if (from === paths.destination) throw new Error('Injected backup failure');
    return rename(from, to);
  } } }), /Injected backup failure/);
  assert.equal(await version(paths.destination), 'old');
  await assertScopedCleanup(paths);
  assert.deepEqual(await readdir(paths.backupDirectory), ['existing-backup']);
});

test('if rollback itself fails, the old bundle remains in the reported backup and staging is removed', async t => {
  const paths = await fixture(t);
  let failure;
  await assert.rejects(installDesktopBundle({ ...paths, operations: { rename: async (from, to) => {
    if (to === paths.destination) throw new Error('Injected destination failure');
    return rename(from, to);
  } } }), error => { failure = error; return error instanceof AggregateError && typeof error.backupPath === 'string'; });
  assert.equal(await version(failure.backupPath), 'old');
  assert.equal(failure.errors.length, 2);
  await assertScopedCleanup(paths, false);
});

test('rollback preserves a different application that appears at the destination during failure', async t => {
  const paths = await fixture(t);
  let failure;
  await assert.rejects(installDesktopBundle({ ...paths, operations: { rename: async (from, to) => {
    if (to === paths.destination && from.endsWith('bundle.app')) {
      await bundle(paths.destination, 'other', plist('io.other.application'));
      throw new Error('Injected concurrent publish failure');
    }
    return rename(from, to);
  } } }), error => { failure = error; return error instanceof AggregateError; });
  assert.equal(await version(paths.destination), 'other');
  assert.equal(await version(failure.backupPath), 'old');
  await assertScopedCleanup(paths);
});
