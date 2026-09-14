import * as filesystem from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const invalidBundle = () => new Error('앱의 CFBundleIdentifier를 확인할 수 없어 기존 파일을 보존했습니다.');

// Parse a deliberately small XML plist subset without expanding entities or DTDs.
// Binary, malformed, ambiguous, and unsupported manifests fail closed.
function bundleIdentifier(input) {
  if (input.length > 256 * 1024) throw invalidBundle();
  const xml = input.replace(/^\uFEFF/, '').trim()
    .replace(/<!--(?:[^-]|-(?!-))*-->/g, '')
    .replace(/^<\?xml\s[^?]*\?>\s*/, '')
    .replace(/^<!DOCTYPE plist PUBLIC "[^"<>\[\]]+" "[^"<>\[\]]+">\s*/, '');
  if (xml.includes('<!') || xml.includes('<?')) throw invalidBundle();
  const tokens = xml.match(/<[^>]*>|[^<]+/g) ?? [];
  if (tokens.join('') !== xml) throw invalidBundle();
  let index = 0;
  const skip = () => { while (tokens[index]?.trim() === '') index++; };
  const next = () => { skip(); return tokens[index++]; };
  const expect = token => { if (next() !== token) throw invalidBundle(); };
  function value(depth = 0) {
    if (depth > 32) throw invalidBundle();
    const token = next();
    if (token === '<dict>') {
      const entries = new Map();
      while (true) {
        skip();
        if (tokens[index] === '</dict>') { index++; return { type: 'dict', entries }; }
        const key = value(depth + 1);
        if (key.type !== 'key' || key.text.includes('&') || entries.has(key.text)) throw invalidBundle();
        const entry = value(depth + 1);
        if (entry.type === 'key') throw invalidBundle();
        entries.set(key.text, entry);
      }
    }
    if (token === '<array>') {
      while (true) {
        skip();
        if (tokens[index] === '</array>') { index++; return { type: 'array' }; }
        if (value(depth + 1).type === 'key') throw invalidBundle();
      }
    }
    if (/^<(?:true|false)\s*\/>$/.test(token ?? '')) return { type: 'boolean' };
    const primitive = /^<(key|string|integer|real|date|data)>$/.exec(token ?? '');
    if (!primitive) throw invalidBundle();
    const type = primitive[1];
    const text = tokens[index] && !tokens[index].startsWith('<') ? tokens[index++] : '';
    if (tokens[index++] !== `</${type}>`) throw invalidBundle();
    return { type, text };
  }
  if (!/^<plist(?:\s+version=(?:"1\.0"|'1\.0'))?\s*>$/.test(next() ?? '')) throw invalidBundle();
  const root = value();
  expect('</plist>'); skip();
  const identifier = root.type === 'dict' ? root.entries.get('CFBundleIdentifier') : undefined;
  if (index !== tokens.length || identifier?.type !== 'string') throw invalidBundle();
  return identifier.text;
}

const contains = (parent, child) => {
  const path = relative(parent, child);
  return !path || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

export async function installDesktopBundle({ source, destination, backupDirectory, identifier = 'io.agent-office.desktop', operations = {} }) {
  const io = { ...filesystem, ...operations };
  source = resolve(source); destination = resolve(destination); backupDirectory = resolve(backupDirectory);
  if (contains(source, destination) || contains(destination, source)
    || contains(source, backupDirectory) || contains(destination, backupDirectory)) throw new Error('앱과 백업 경로는 서로 포함할 수 없습니다.');
  async function statIfPresent(path) {
    try { return await io.lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function verifyBundle(path) {
    const stat = await io.lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalidBundle();
    const manifest = join(path, 'Contents/Info.plist');
    const manifestStat = await io.lstat(manifest);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 256 * 1024) throw invalidBundle();
    if (bundleIdentifier(await io.readFile(manifest, 'utf8')) !== identifier) throw invalidBundle();
  }
  await verifyBundle(source);
  const previous = await statIfPresent(destination);
  if (previous) await verifyBundle(destination);
  await io.mkdir(dirname(destination), { recursive: true });
  let temporary, backupContainer, backupPath = null, backedUp = false, failure;
  try {
    temporary = await io.mkdtemp(join(dirname(destination), '.agent-office-install-'));
    const staged = join(temporary, 'bundle.app');
    // Complete and validate the copy before moving the installed application.
    await io.cp(source, staged, { recursive: true, force: false, errorOnExist: true });
    await verifyBundle(staged);
    const current = await statIfPresent(destination);
    if (!!current !== !!previous || (current && (current.dev !== previous.dev || current.ino !== previous.ino))) {
      throw new Error('설치 중 대상 앱이 변경되어 기존 파일을 보존했습니다.');
    }
    if (current) {
      await verifyBundle(destination);
      await io.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
      backupContainer = await io.mkdtemp(join(backupDirectory, 'install-'));
      backupPath = join(backupContainer, 'Agent Office.app');
      await io.rename(destination, backupPath);
      backedUp = true;
    }
    await io.rename(staged, destination);
  } catch (error) {
    failure = error;
    if (backedUp) {
      try {
        // Never overwrite an application installed by somebody else during a failure.
        if (await statIfPresent(destination)) throw new Error('복구 대상 위치에 다른 파일이 있어 백업을 보존했습니다.');
        await io.rename(backupPath, destination);
        backedUp = false;
        backupPath = null;
      } catch (rollbackError) {
        failure = new AggregateError([error, rollbackError], `앱 설치와 복구에 실패했습니다. 기존 앱 백업: ${backupPath}`, { cause: error });
        failure.backupPath = backupPath;
      }
    }
  }
  try {
    // These paths were allocated by this invocation. No wildcard or shared directory cleanup.
    if (temporary) await io.rm(temporary, { recursive: true, force: true });
    if (backupContainer && !backedUp) await io.rmdir(backupContainer);
  } catch (cleanupError) {
    if (failure) throw new AggregateError([failure, cleanupError], '앱 설치 실패 후 임시 폴더 정리에도 실패했습니다.', { cause: failure });
    throw cleanupError;
  }
  if (failure) throw failure;
  return { destination, backupPath };
}
