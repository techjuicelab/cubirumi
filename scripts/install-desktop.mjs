#!/usr/bin/env node
import { mkdir, writeFile, cp, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDesktopBundle } from './desktop-bundle.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const identifier = 'io.agent-office.desktop';
const command = process.argv[2] ?? 'install';
if (process.platform !== 'darwin' || !['install', 'build'].includes(command)) {
  console.error('macOS에서 node scripts/install-desktop.mjs install|build를 실행하세요.'); process.exit(1);
}
const output = join(root, 'artifacts', 'Agent Office.app');
const contents = join(output, 'Contents');
await mkdir(join(contents, 'MacOS'), { recursive: true });
await mkdir(join(contents, 'Resources'), { recursive: true });
await cp(join(root, 'desktop/macos/Assets/AppIcon.icns'), join(contents, 'Resources/AppIcon.icns'));
const swiftFiles = (await readdir(join(root, 'desktop/macos'))).filter(name => name.endsWith('.swift')).sort().map(name => join(root, 'desktop/macos', name));
const result = spawnSync('xcrun', ['swiftc', '-parse-as-library', ...swiftFiles, '-O',
  '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`,
  '-framework', 'AppKit', '-framework', 'WebKit', '-o', join(contents, 'MacOS/AgentOffice')], { stdio: 'inherit' });
if (result.error || result.status !== 0) process.exit(result.status || 1);
await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>AgentOffice</string>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleName</key><string>Agent Office</string>
<key>CFBundleDisplayName</key><string>Agent Office</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundleShortVersionString</key><string>0.2.0</string>
<key>CFBundleVersion</key><string>2</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
<key>NSHumanReadableCopyright</key><string>Agent Office contributors · MIT</string>
</dict></plist>\n`);
const signed = spawnSync('codesign', ['--force', '--sign', '-', output], { stdio: 'inherit' });
if (signed.error || signed.status !== 0) process.exit(signed.status || 1);
if (command === 'install') {
  const destination = join(homedir(), 'Applications', 'Agent Office.app');
  await installDesktopBundle({ source: output, destination, identifier,
    backupDirectory: join(homedir(), 'Library/Application Support/AgentOffice/desktop-backups') });
  console.log(`Agent Office 앱 설치 완료: ${destination}`);
} else console.log(`Agent Office 앱 빌드 완료: ${output}`);
