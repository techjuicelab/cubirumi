#!/usr/bin/env node
import { mkdir, mkdtemp, copyFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = resolve(root, process.argv[2] ?? 'design/icons/production/C-white-sky-transparent-source.png');
if (process.platform !== 'darwin') throw new Error('아이콘 재생성에는 macOS의 sips와 iconutil이 필요합니다. 생성된 아이콘 파일은 저장소에 포함됩니다.');
const signature = await readFile(source);
if (!signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('원본은 PNG여야 합니다.');
if (signature.readUInt32BE(16) !== signature.readUInt32BE(20) || signature.readUInt32BE(16) < 1024) throw new Error('원본은 1024px 이상의 정사각형이어야 합니다.');
const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(result.stderr || result.error?.message || '아이콘 변환에 실패했습니다.');
  return result.stdout;
};
if (!/hasAlpha: yes/.test(run('/usr/bin/sips', ['-g', 'hasAlpha', source]))) throw new Error('투명 배경을 포함한 PNG 원본이 필요합니다.');
await mkdir(join(root, 'artifacts'), { recursive: true });
const temporary = await mkdtemp(join(root, 'artifacts', 'icon-build-'));
try {
  const iconset = join(temporary, 'AppIcon.iconset');
  await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      run('/usr/bin/sips', ['-z', String(size * scale), String(size * scale), source, '--out',
        join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)]);
    }
  }
  const icns = join(temporary, 'AppIcon.icns');
  run('/usr/bin/iconutil', ['--convert', 'icns', iconset, '--output', icns]);
  const output = [[1024, 'public/app-icon.png'], [512, 'public/icons/app-icon-512.png'],
    [192, 'public/icons/app-icon-192.png'], [180, 'public/icons/apple-touch-icon.png'], [32, 'public/icons/favicon-32.png']];
  for (const [size] of output) run('/usr/bin/sips', ['-z', String(size), String(size), source, '--out', join(temporary, `${size}.png`)]);
  // Finish conversion before replacing any shipped resources. Originals remain in design/icons.
  for (const [size, path] of output) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await copyFile(join(temporary, `${size}.png`), join(root, path));
  }
  await mkdir(join(root, 'desktop/macos/Assets'), { recursive: true });
  await copyFile(icns, join(root, 'desktop/macos/Assets/AppIcon.icns'));
  console.log('macOS ICNS와 웹 아이콘 5개를 생성했습니다.');
} finally { await rm(temporary, { recursive: true, force: true }); }
