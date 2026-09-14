import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { releaseConfig, desktopPlist, downloadVerified, sha256, verifyArchiveSignature, appcast } from '../scripts/release-core.mjs';
import { packageArguments } from '../scripts/package-desktop.mjs';
import { verifyPackagedConfiguration } from '../scripts/prepare-release.mjs';

function fixtureKey() {
  const pair = generateKeyPairSync('ed25519');
  return { ...pair, raw: pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64') };
}
const input = key => ({ productName: 'Example Office', repository: 'example/example-office', publicEDKey: key, minimumSystemVersion: '13.5' });
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'office-release-test-'));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}

test('release builds require a real public key and repository; local builds do not enable an unconfigured updater', () => {
  const local = releaseConfig({ ...input(null), repository: null });
  assert.equal(local.updatesEnabled, false);
  assert.doesNotMatch(desktopPlist(local, { version: '0.3.0', arch: 'arm64' }), /SUFeedURL|SUPublicEDKey|SUAutomaticallyUpdate/);
  assert.throws(() => releaseConfig(input(null), { requireUpdates: true }));
  assert.throws(() => releaseConfig({ ...input(fixtureKey().raw), repository: 'https://example.test/repo' }));
  assert.throws(() => releaseConfig({ ...input(fixtureKey().raw), productName: '../Office' }));
  assert.throws(() => releaseConfig({ ...input(fixtureKey().raw), minimumSystemVersion: '13.0' }));
});

test('each architecture has its own GitHub release feed and the bundled updater requires signed archives and feeds', () => {
  const config = releaseConfig(input(fixtureKey().raw), { requireUpdates: true });
  for (const arch of ['arm64', 'x64']) {
    const plist = desktopPlist(config, { version: '0.3.0', arch });
    assert.ok(plist.includes(`/releases/latest/download/appcast-${arch}.xml`));
    assert.match(plist, /<key>SUVerifyUpdateBeforeExtraction<\/key><true\/>/);
    assert.match(plist, /<key>SURequireSignedFeed<\/key><true\/>/);
    assert.match(plist, /<key>SUSignedFeedFailureExpirationInterval<\/key><integer>0<\/integer>/);
    assert.match(plist, /<key>SUAutomaticallyUpdate<\/key><true\/>/);
    assert.match(plist, /<key>SUEnableSystemProfiling<\/key><false\/>/);
  }
});

test('unrecognized package arguments cannot silently create a non-release build', () => {
  assert.deepEqual(packageArguments(['--arch', 'x64', '--release']), { arch: 'x64', release: true });
  for (const args of [['--releas'], ['--arch'], ['--arch', 'invalid'], ['--release', 'extra']]) assert.throws(() => packageArguments(args));
});

test('downloads reject altered data without replacing an existing cache file', async t => {
  const dir = await temporary(t), target = join(dir, 'artifact');
  await writeFile(target, 'old');
  await assert.rejects(downloadVerified('https://example.test/release', target, sha256('expected'), {
    fetchImpl: async () => new Response('tampered') }), /SHA-256/);
  assert.equal(await readFile(target, 'utf8'), 'old');
  assert.deepEqual(await readdir(dir), ['artifact']);
  await downloadVerified('https://example.test/release', target, sha256('expected'), { fetchImpl: async () => new Response('expected') });
  assert.equal(await readFile(target, 'utf8'), 'expected');
  await downloadVerified('https://example.test/release', target, sha256('expected'), { fetchImpl: async () => { throw new Error('cache should be reused'); } });
});

test('update verification rejects tampering and signatures made with a different release key', () => {
  const first = fixtureKey(), second = fixtureKey(), archive = Buffer.from('synthetic archive');
  const signature = sign(null, archive, first.privateKey).toString('base64');
  verifyArchiveSignature(archive, signature, first.raw);
  assert.throws(() => verifyArchiveSignature(Buffer.from('altered archive'), signature, first.raw));
  assert.throws(() => verifyArchiveSignature(archive, signature, second.raw));
});

test('feed download URL identifies the signed version and rejects traversal and invalid versions', () => {
  const key = fixtureKey(), config = releaseConfig(input(key.raw));
  const fields = { version: '0.3.0', arch: 'arm64', filename: 'Example-Office-0.3.0-macos-arm64.zip', length: 42, signature: sign(null, Buffer.from('fixture'), key.privateKey).toString('base64') };
  const feed = appcast(config, fields);
  assert.ok(feed.includes('/releases/download/v0.3.0/Example-Office-0.3.0-macos-arm64.zip'));
  assert.throws(() => appcast(config, { ...fields, filename: '../archive.zip' }));
  assert.throws(() => appcast(config, { ...fields, version: 'latest' }));
});

test('release signing rejects a ZIP built with an old public key, version, or feed', { skip: process.platform !== 'darwin' }, async t => {
  const dir = await temporary(t), key = fixtureKey(), config = releaseConfig(input(key.raw));
  const contents = join(dir, 'Example Office.app/Contents'); await mkdir(contents, { recursive: true });
  const manifest = { version: '0.3.0', arch: 'arm64' };
  await writeFile(join(contents, 'Info.plist'), desktopPlist(config, manifest));
  const archive = join(dir, 'fixture.zip');
  assert.equal(spawnSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', join(dir, 'Example Office.app'), archive]).status, 0);
  verifyPackagedConfiguration(archive, config, manifest);
  assert.throws(() => verifyPackagedConfiguration(archive, { ...config, publicEDKey: fixtureKey().raw }, manifest));
  assert.throws(() => verifyPackagedConfiguration(archive, config, { ...manifest, version: '0.4.0' }));
  assert.throws(() => verifyPackagedConfiguration(archive, config, { ...manifest, arch: 'x64' }));
});
