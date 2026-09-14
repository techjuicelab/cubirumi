import { execFileSync } from 'node:child_process';

// Inspect exactly the index that will be committed, not ignored local files.
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
if (!files.length) throw new Error('공개 검사할 Git 추적 파일이 없습니다. 먼저 공개 파일을 stage 하세요.');
const deniedPaths = /(^|\/)(?:node_modules|dist|artifacts|screenshots|coverage|\.local|\.codex|\.claude)(\/|$)|(^|\/)\.env(?:\.|$)|\.(?:sqlite[^/]*|db|jsonl|log|plist)$|(^|\/)(?:settings|agents|observer-[^/]+)\.json$/u;
const checks = [
  ['개인 홈 절대 경로', /\/(?:Users|home)\/(?!example(?:\/|$))[A-Za-z0-9_.-]+\//u],
  ['실제 형식 세션 식별자', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu],
  ['개인 키', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  ['GitHub 토큰', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/u],
  ['서비스 비밀 키', /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16})\b/u],
];
// Personal exclusions are supplied locally. Never put private names in this source.
const privateTerms = (process.env.PUBLIC_DENY_TERMS || '').split(',').map(term => term.trim().toLowerCase()).filter(Boolean);
// A literal control character in a source fixture must not hide the rest of that file.
const textPaths = /\.(?:[cm]?js|jsx|tsx?|json|md|mdx|txt|html|css|scss|sass|svg|swift|py|sh|toml|ya?ml|xml)$/iu;
const failures = [];
for (const file of files) {
  if (deniedPaths.test(file)) { failures.push(`${file}: 공개 제외 경로`); continue; }
  const mode = execFileSync('git', ['ls-files', '-s', '--', file], { encoding: 'utf8' }).slice(0, 6);
  if (mode === '120000') { failures.push(`${file}: 심볼릭 링크는 공개 묶음에서 제외하세요`); continue; }
  const body = execFileSync('git', ['show', `:${file}`], { maxBuffer: 16 * 1024 * 1024 });
  if (body.includes(0) && !textPaths.test(file)) continue;
  const text = body.toString('utf8');
  for (const [reason, pattern] of checks) if (pattern.test(text)) failures.push(`${file}: ${reason}`);
  if (privateTerms.some(term => text.toLowerCase().includes(term))) failures.push(`${file}: 로컬 비공개 금지어`);
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else console.log(`공개 대상 ${files.length}개 파일 검사 통과`);
