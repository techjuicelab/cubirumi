#!/usr/bin/env node
import { readFile, writeFile, mkdir, mkdtemp, cp, stat } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { releaseConfig, verifyArchiveSignature, appcast, sha256, SPARKLE, downloadVerified, run, validateVersion, feedURL, BUNDLE_IDENTIFIER } from './release-core.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export function verifyPackagedConfiguration(archive, config, manifest) {
  const { SPARKLE_PRIVATE_KEY: _secret, ...env } = process.env;
  const extracted = spawnSync('/usr/bin/unzip', ['-p', archive, `${config.productName}.app/Contents/Info.plist`], { env, maxBuffer: 256 * 1024 });
  if (extracted.error || extracted.status !== 0) throw new Error('ZIP 내부 앱 설정을 읽지 못했습니다.');
  const converted = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], { env, input: extracted.stdout, encoding: 'utf8', maxBuffer: 256 * 1024 });
  if (converted.error || converted.status !== 0) throw new Error('ZIP 내부 앱 설정 형식이 올바르지 않습니다.');
  let plist;
  try { plist = JSON.parse(converted.stdout); } catch { throw new Error('ZIP 내부 앱 설정 형식이 올바르지 않습니다.'); }
  const expected = { CFBundleIdentifier: BUNDLE_IDENTIFIER, CFBundleName: config.productName,
    CFBundleShortVersionString: manifest.version, CFBundleVersion: manifest.version,
    SUPublicEDKey: config.publicEDKey, SUFeedURL: feedURL(config, manifest.arch),
    AgentOfficeRepositoryURL: `https://github.com/${config.repository}`,
    LSMinimumSystemVersion: config.minimumSystemVersion, SUVerifyUpdateBeforeExtraction: true, SURequireSignedFeed: true };
  if (Object.entries(expected).some(([key, value]) => plist[key] !== value)) throw new Error('ZIP 내부 앱의 버전·공개키·업데이트 주소가 현재 배포 설정과 다릅니다. 다시 빌드하세요.');
}

export async function prepareRelease(directory, { env = process.env } = {}) {
  const config = releaseConfig(JSON.parse(await readFile(join(root, 'desktop/release.json'), 'utf8')), { requireUpdates: true });
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  validateVersion(manifest.version);
  if (manifest.repository !== config.repository || manifest.productName !== config.productName || !manifest.updatesEnabled
    || !['arm64', 'x64'].includes(manifest.arch) || typeof manifest.archive !== 'string' || basename(manifest.archive) !== manifest.archive) throw new Error('현재 배포 설정으로 만든 공개 패키지가 아닙니다.');
  const archive = join(directory, manifest.archive), bytes = await readFile(archive);
  if (sha256(bytes) !== manifest.sha256 || bytes.length !== manifest.length) throw new Error('빌드 후 패키지가 변경되었습니다.');
  verifyPackagedConfiguration(archive, config, manifest);
  const privateKey = env.SPARKLE_PRIVATE_KEY?.trim();
  if (!privateKey || !/^[A-Za-z0-9+/]+={0,2}$/.test(privateKey)) throw new Error('1Password/CI에서 SPARKLE_PRIVATE_KEY를 주입하세요. 키 값을 명령 인수나 저장소에 넣지 마세요.');
  const { SPARKLE_PRIVATE_KEY: _secret, ...childEnv } = env;
  const toolCache = join(root, 'artifacts/release-signing-tools'); await mkdir(toolCache, { recursive: true });
  const toolArchive = join(toolCache, `Sparkle-${SPARKLE.version}.tar.xz`);
  await downloadVerified(SPARKLE.url, toolArchive, SPARKLE.sha256);
  const tools = await mkdtemp(join(toolCache, 'verified-'));
  run('/usr/bin/tar', ['-xJf', toolArchive, '-C', tools], { env: childEnv });
  const sign = (file, args = []) => {
    // Only the signer receives the key, via stdin. No keychain mutation or plaintext file.
    const result = spawnSync(join(tools, 'bin/sign_update'), ['--ed-key-file', '-', ...args, file],
      { input: `${privateKey}\n`, env: childEnv, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error('Sparkle 서명에 실패했습니다. 키와 패키지 설정을 확인하세요.');
    return result.stdout.trim();
  };
  const signature = sign(archive, ['-p']);
  verifyArchiveSignature(bytes, signature, config.publicEDKey);
  const releases = join(root, 'artifacts/releases'); await mkdir(releases, { recursive: true });
  const output = await mkdtemp(join(releases, `v${manifest.version}-${manifest.arch}-`));
  await cp(archive, join(output, manifest.archive));
  const feed = join(output, `appcast-${manifest.arch}.xml`);
  await writeFile(feed, appcast(config, { ...manifest, filename: manifest.archive, signature }));
  sign(feed);
  sign(feed, ['--verify']);
  await writeFile(join(output, `SHA256SUMS-${manifest.arch}.txt`), `${manifest.sha256}  ${manifest.archive}\n${sha256(await readFile(feed))}  ${basename(feed)}\n`);
  console.log(`서명된 공개 후보: ${output}`);
  console.log('ZIP·appcast·SHA256SUMS를 같은 GitHub Release에 함께 올리세요. 이 명령은 게시하지 않습니다.');
  return { output, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('사용법: npm run release:prepare -- <패키지 결과 폴더>');
    const directory = resolve(process.argv[2]);
    if (!(await stat(directory)).isDirectory()) throw new Error('패키지 폴더가 필요합니다.');
    await prepareRelease(directory);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
