#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const documents = new Set([
  'ACTIVITY_ANIMATIONS.md', 'CLAUDE_SETUP_PROMPT.md', 'CLAUDE_VERIFY_PROMPT.md',
  'COMMUNICATION.md', 'DESKTOP.md', 'INTEGRATIONS.md', 'USAGE.md', 'RELEASING.md',
]);
const rootFiles = new Set(['.gitignore', 'CONTRIBUTING.md', 'LICENSE', 'README.md', 'SECURITY.md',
  'index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts']);
const roots = new Set(['.agents', '.claude-plugin', '.github', 'design', 'desktop', 'integrations', 'plugins', 'public', 'scripts', 'server', 'src', 'tests']);

// Export current source through an explicit boundary. Never copy Git history, ignored runtime data, or internal review documents.
const candidates = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const files = [...new Set(candidates)].filter(file => {
  const [first, ...rest] = file.split('/');
  if (first === 'docs') return rest.length === 1 && documents.has(rest[0]);
  if (first === 'env') return file === 'env/release.op.env.example';
  return rootFiles.has(file) || roots.has(first);
}).sort();
const destinationRoot = join(root, 'artifacts/public-source');
await mkdir(destinationRoot, { recursive: true });
const output = await mkdtemp(join(destinationRoot, 'cubirumi-'));
for (const file of files) {
  const source = join(root, file), target = join(output, file);
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`일반 파일만 내보낼 수 있습니다: ${file}`);
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target);
}
await writeFile(join(destinationRoot, 'latest-export.json'), JSON.stringify({ output, files }, null, 2) + '\n');
console.log(`공개 소스 후보 ${files.length}개 파일: ${output}`);
console.log('Git 이력을 포함하지 않습니다. 별도 저장소에서 stage 후 check:public을 실행하고 공개하세요.');
