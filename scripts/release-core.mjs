import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Official release artifacts, pinned independently of the developer's Node installation.
export const SPARKLE = {
  version: '2.10.0',
  url: 'https://github.com/sparkle-project/Sparkle/releases/download/2.10.0/Sparkle-2.10.0.tar.xz',
  sha256: 'c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c',
};
export const NODE_VERSION = '24.20.0';
export const NODE_SHA256 = {
  arm64: '40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8',
  x64: '9e5b2644cf107befb6aefca676b96d3296bc10138096f022ed378d6233ed81f4',
};
export const BUNDLE_IDENTIFIER = 'io.agent-office.desktop';
export const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export const sha256 = data => createHash('sha256').update(data).digest('hex');

export function releaseConfig(input, { requireUpdates = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('배포 설정이 필요합니다.');
  const { productName, repository, publicEDKey, minimumSystemVersion = '13.5' } = input;
  if (typeof productName !== 'string' || !/^[A-Za-z][A-Za-z0-9 -]{1,48}$/.test(productName) || productName.trim() !== productName) throw new Error('앱 이름은 영문·숫자·공백·하이픈으로 지정하세요.');
  if (repository != null && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository)) throw new Error('GitHub 저장소는 owner/repository 형식이어야 합니다.');
  if (publicEDKey != null && (typeof publicEDKey !== 'string' || Buffer.from(publicEDKey, 'base64').length !== 32 || Buffer.from(publicEDKey, 'base64').toString('base64') !== publicEDKey)) throw new Error('Sparkle 공개키는 32바이트 Ed25519 공개키여야 합니다.');
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(minimumSystemVersion) || Number(minimumSystemVersion.split('.')[0]) < 13 || (minimumSystemVersion.startsWith('13.') && Number(minimumSystemVersion.split('.')[1]) < 5)) throw new Error('내장 Node는 macOS 13.5 이상이 필요합니다.');
  if (requireUpdates && (!repository || !publicEDKey)) throw new Error('공개 배포에는 GitHub 저장소와 Sparkle 공개키가 모두 필요합니다.');
  return { productName, repository, publicEDKey, minimumSystemVersion, updatesEnabled: Boolean(repository && publicEDKey) };
}

export function validateVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('배포 버전은 major.minor.patch 형식이어야 합니다.');
  return version;
}

export function feedURL(config, arch) {
  if (!Object.hasOwn(NODE_SHA256, arch)) throw new Error('지원하는 아키텍처는 arm64와 x64입니다.');
  return config.repository ? `https://github.com/${config.repository}/releases/latest/download/appcast-${arch}.xml` : null;
}

export function desktopPlist(config, { version, arch }) {
  validateVersion(version);
  const entries = {
    CFBundleExecutable: 'AgentOffice', CFBundleIdentifier: BUNDLE_IDENTIFIER,
    CFBundleName: config.productName, CFBundleDisplayName: config.productName,
    CFBundlePackageType: 'APPL', CFBundleIconFile: 'AppIcon',
    CFBundleShortVersionString: version, CFBundleVersion: version,
    LSMinimumSystemVersion: config.minimumSystemVersion,
    NSHumanReadableCopyright: 'Agent Office contributors · MIT',
  };
  if (config.updatesEnabled) Object.assign(entries, {
    AgentOfficeRepositoryURL: `https://github.com/${config.repository}`,
    SUFeedURL: feedURL(config, arch), SUPublicEDKey: config.publicEDKey,
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n${Object.entries(entries).map(([k,v]) => `<key>${k}</key><string>${xml(v)}</string>`).join('\n')}
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
${config.updatesEnabled ? '<key>SUEnableAutomaticChecks</key><true/>\n<key>SUAutomaticallyUpdate</key><true/>\n<key>SUVerifyUpdateBeforeExtraction</key><true/>\n<key>SURequireSignedFeed</key><true/>\n<key>SUSignedFeedFailureExpirationInterval</key><integer>0</integer>\n<key>SUEnableSystemProfiling</key><false/>\n<key>SUEnableJavaScript</key><false/>' : ''}
</dict></plist>\n`;
}

export async function downloadVerified(url, destination, expected, { fetchImpl = fetch } = {}) {
  if (!url.startsWith('https://') || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('HTTPS 주소와 SHA-256이 필요합니다.');
  try { const existing = await readFile(destination); if (sha256(existing) === expected) return destination; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || (response.url && !response.url.startsWith('https://'))) throw new Error('공식 배포 파일을 내려받지 못했습니다.');
  const chunks = []; let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 256 * 1024 * 1024) throw new Error('배포 파일 크기가 제한을 넘었습니다.');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (sha256(bytes) !== expected) throw new Error('공식 배포 파일 SHA-256 검증에 실패했습니다.');
  const temporary = `${destination}.${process.pid}.tmp`;
  try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, destination); }
  finally { await rm(temporary, { force: true }); }
  return destination;
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw new Error(`${command.split('/').at(-1)} 실행 실패`);
  return result;
}

export async function prepareTools(cache, arch) {
  if (!Object.hasOwn(NODE_SHA256, arch)) throw new Error('지원하는 아키텍처는 arm64와 x64입니다.');
  await mkdir(cache, { recursive: true });
  const nodeArchive = `node-v${NODE_VERSION}-darwin-${arch}.tar.gz`;
  await Promise.all([
    downloadVerified(SPARKLE.url, join(cache, `Sparkle-${SPARKLE.version}.tar.xz`), SPARKLE.sha256),
    downloadVerified(`https://nodejs.org/dist/v${NODE_VERSION}/${nodeArchive}`, join(cache, nodeArchive), NODE_SHA256[arch]),
  ]);
  // Always re-extract verified archives so an altered cache directory is never a trust source.
  const sparkle = join(cache, `Sparkle-${SPARKLE.version}`);
  const node = join(cache, `node-v${NODE_VERSION}-darwin-${arch}`);
  await rm(sparkle, { recursive: true, force: true }); await rm(node, { recursive: true, force: true });
  await mkdir(sparkle, { recursive: true });
  run('/usr/bin/tar', ['-xJf', join(cache, `Sparkle-${SPARKLE.version}.tar.xz`), '-C', sparkle]);
  run('/usr/bin/tar', ['-xzf', join(cache, nodeArchive), '-C', cache]);
  return { sparkle, node };
}

export function verifyArchiveSignature(bytes, signature, publicKey) {
  if (typeof signature !== 'string' || Buffer.from(signature, 'base64').length !== 64) throw new Error('업데이트 서명 형식이 올바르지 않습니다.');
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey, 'base64')]), format: 'der', type: 'spki' });
  if (!verify(null, bytes, key, Buffer.from(signature, 'base64'))) throw new Error('업데이트 파일의 서명이 앱에 포함된 공개키와 일치하지 않습니다.');
}

export function appcast(config, { version, arch, filename, length, signature, date = new Date() }) {
  validateVersion(version);
  if (!config.updatesEnabled || !Object.hasOwn(NODE_SHA256, arch)) throw new Error('업데이트 설정이 완성되지 않았습니다.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]+\.zip$/.test(filename) || !Number.isSafeInteger(length) || length <= 0 || Buffer.from(signature, 'base64').length !== 64) throw new Error('업데이트 파일 정보가 올바르지 않습니다.');
  return `<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel>
<title>${xml(config.productName)} updates</title><link>https://github.com/${xml(config.repository)}</link>
<item><title>${xml(config.productName)} ${version}</title><pubDate>${date.toUTCString()}</pubDate>
<sparkle:version>${version}</sparkle:version><sparkle:shortVersionString>${version}</sparkle:shortVersionString>
<sparkle:minimumSystemVersion>${config.minimumSystemVersion}</sparkle:minimumSystemVersion>
<enclosure url="https://github.com/${xml(config.repository)}/releases/download/v${version}/${filename}" length="${length}" type="application/octet-stream" sparkle:edSignature="${xml(signature)}"/>
</item></channel></rss>\n`;
}
