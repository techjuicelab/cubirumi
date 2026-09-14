#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile, rename, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { releaseConfig, desktopPlist, prepareTools, run, SPARKLE, NODE_VERSION, sha256 } from './release-core.mjs';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const runtimeFiles = [
  'scripts/runtime.mjs', 'scripts/codex-observer.mjs', 'scripts/codex-usage.mjs',
  'scripts/claude-observer.mjs', 'scripts/claude-models.mjs', 'scripts/claude-statusline.mjs',
  'scripts/install-claude.mjs',
  'server/index.mjs', 'server/bridge.mjs', 'server/settings.mjs', 'server/static.mjs', 'server/store.mjs', 'server/usage.mjs',
  '.claude-plugin/marketplace.json', 'integrations/claude-plugin/.claude-plugin/plugin.json',
  'integrations/claude-plugin/hooks/hooks.json', 'integrations/claude-plugin/scripts/adapter-core.mjs',
  'integrations/claude-plugin/scripts/activity-kind.mjs', 'integrations/claude-plugin/scripts/claude-hook.mjs',
];

export function packageArguments(args) {
  let arch = process.arch, release = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--release') release = true;
    else if (args[index] === '--arch' && ['arm64', 'x64'].includes(args[index + 1])) arch = args[++index];
    else throw new Error('사용법: npm run desktop:package -- [--arch arm64|x64] [--release]');
  }
  return { arch, release };
}

export async function copyRuntime(root, destination) {
  for (const name of runtimeFiles) {
    const source = join(root, name), target = join(destination, name);
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('런타임 원본은 일반 파일이어야 합니다.');
    await mkdir(dirname(target), { recursive: true }); await cp(source, target);
  }
}

async function signFramework(framework) {
  const version = join(framework, 'Versions/B');
  // The non-sandboxed application uses only the standard installer and updater.
  const services = join(version, 'XPCServices');
  for (const name of await readdir(services)) {
    if (name.endsWith('.xpc')) run('/usr/bin/codesign', ['--force', '--sign', '-', join(services, name)]);
  }
  run('/usr/bin/codesign', ['--force', '--sign', '-', join(version, 'Autoupdate')]);
  run('/usr/bin/codesign', ['--force', '--sign', '-', join(version, 'Updater.app')]);
  run('/usr/bin/codesign', ['--force', '--sign', '-', framework]);
}

export async function packageDesktop({ root = projectRoot, arch = process.arch, release = false } = {}) {
  if (process.platform !== 'darwin') throw new Error('macOS에서 패키지를 빌드하세요.');
  const config = releaseConfig(JSON.parse(await readFile(join(root, 'desktop/release.json'), 'utf8')), { requireUpdates: release });
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const tools = await prepareTools(join(root, 'artifacts/download-cache'), arch);
  const packages = join(root, 'artifacts/packages'); await mkdir(packages, { recursive: true });
  const temporary = await mkdtemp(join(packages, '.build-'));
  const app = join(temporary, `${config.productName}.app`), contents = join(app, 'Contents');
  let published;
  try {
    const runtime = join(contents, 'Resources/runtime');
    await mkdir(join(contents, 'MacOS'), { recursive: true });
    await mkdir(join(contents, 'Helpers'), { recursive: true });
    await mkdir(join(contents, 'Frameworks'), { recursive: true });
    await copyRuntime(root, runtime);
    // Build in this invocation's staging directory, leaving a running source checkout's dist untouched.
    run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit'], { cwd: root });
    run(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', join(runtime, 'dist'), '--emptyOutDir'], { cwd: root });
    await cp(join(tools.node, 'bin/node'), join(contents, 'Helpers/node'));
    await cp(join(root, 'desktop/macos/Assets/AppIcon.icns'), join(contents, 'Resources/AppIcon.icns'));
    const framework = join(contents, 'Frameworks/Sparkle.framework');
    await cp(join(tools.sparkle, 'Sparkle.framework'), framework, { recursive: true, verbatimSymlinks: true });
    const licenses = join(contents, 'Resources/Licenses'); await mkdir(licenses);
    await cp(join(root, 'LICENSE'), join(licenses, 'AgentOffice-MIT.txt'));
    await cp(join(tools.node, 'LICENSE'), join(licenses, 'Node.txt'));
    await cp(join(tools.sparkle, 'LICENSE'), join(licenses, 'Sparkle.txt'));
    await cp(join(root, 'public/THIRD_PARTY_NOTICES.txt'), join(licenses, 'Web.txt'));
    const swift = (await readdir(join(root, 'desktop/macos'))).filter(name => name.endsWith('.swift')).sort().map(name => join(root, 'desktop/macos', name));
    run('xcrun', ['swiftc', '-parse-as-library', ...swift, '-O', '-target', `${arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx${config.minimumSystemVersion}`,
      '-F', tools.sparkle, '-framework', 'AppKit', '-framework', 'WebKit', '-framework', 'Sparkle',
      '-Xlinker', '-rpath', '-Xlinker', '@executable_path/../Frameworks', '-o', join(contents, 'MacOS/AgentOffice')]);
    await writeFile(join(contents, 'Info.plist'), desktopPlist(config, { version, arch }));
    // Keep production trust settings unchanged; an ad-hoc signature is not Apple notarization.
    await signFramework(framework);
    run('/usr/bin/codesign', ['--force', '--sign', '-', join(contents, 'Helpers/node')]);
    run('/usr/bin/codesign', ['--force', '--sign', '-', app]);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    const name = `${config.productName.replaceAll(' ', '-')}-${version}-macos-${arch}`;
    const archive = join(temporary, `${name}.zip`);
    run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
    const bytes = await readFile(archive);
    const manifest = { productName: config.productName, version, arch, minimumSystemVersion: config.minimumSystemVersion,
      repository: config.repository, updatesEnabled: config.updatesEnabled,
      nodeVersion: NODE_VERSION, sparkleVersion: SPARKLE.version, archive: `${name}.zip`, sha256: sha256(bytes), length: bytes.length };
    await writeFile(join(temporary, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    // Allocate a new result directory; never delete a previous build, installed app, or runtime.
    published = await mkdtemp(join(packages, `${name}-`));
    for (const file of await readdir(temporary)) await rename(join(temporary, file), join(published, file));
    console.log(`다운로드용 앱 패키지: ${published}`);
    console.log(config.updatesEnabled ? '서명된 업데이트 확인이 설정되어 있습니다.' : '로컬 검증용입니다. 저장소·공개키를 설정한 뒤 --release로 다시 빌드하세요.');
    return { directory: published, manifest, config };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await packageDesktop(packageArguments(process.argv.slice(2)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
