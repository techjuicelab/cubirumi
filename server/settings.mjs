import * as filesystem from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const DEFAULT_COMPANY_NAME = '나의 회사';
export const DEFAULT_OWNER_NAME = '나';
const defaults = () => ({ companyName: DEFAULT_COMPANY_NAME, ownerName: DEFAULT_OWNER_NAME });
const limits = { companyName: 80, ownerName: 40 };
const controls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export class SettingsValidationError extends Error {
  constructor(message) { super(message); this.name = 'SettingsValidationError'; this.statusCode = 400; }
}
function validName(value, maximum) {
  return typeof value === 'string' && !controls.test(value) && value.trim().length > 0 && [...value.trim()].length <= maximum;
}
export function normalizeSettingsPatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SettingsValidationError('설정은 객체여야 합니다.');
  const keys = Object.keys(input);
  if (!keys.length || keys.some(key => !Object.hasOwn(limits, key))) throw new SettingsValidationError('회사명과 사장 이름만 변경할 수 있습니다.');
  const patch = {};
  for (const key of keys) {
    if (!validName(input[key], limits[key])) throw new SettingsValidationError(`${key === 'companyName' ? '회사명' : '사장 이름'}은 줄바꿈 없이 1~${limits[key]}자로 입력해 주세요.`);
    patch[key] = input[key].trim();
  }
  return patch;
}

export function defaultDataDir() {
  return process.env.AGENT_OFFICE_DATA_DIR || (process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'AgentOffice')
    : join(homedir(), '.local', 'share', 'agent-office'));
}

export function companyName(value) {
  return validName(value, limits.companyName) ? value.trim() : DEFAULT_COMPANY_NAME;
}
export function ownerName(value) { return validName(value, limits.ownerName) ? value.trim() : DEFAULT_OWNER_NAME; }

function readRecord(dataDir, io) {
  if (!dataDir) return { settings: defaults(), text: null };
  const path = join(dataDir, 'settings.json');
  let info;
  try { info = io.lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return { settings: defaults(), text: null }; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096) throw new Error('설정 파일을 안전하게 읽을 수 없습니다.');
  const text = io.readFileSync(path, 'utf8');
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('설정 파일 형식을 확인할 수 없습니다.');
  return { settings: { companyName: companyName(value.companyName), ownerName: ownerName(value.ownerName) }, text };
}
export function readSettings(dataDir) {
  try { return readRecord(dataDir, filesystem).settings; } catch { return defaults(); }
}

/** Merge only display preferences, then publish an owner-only file atomically. */
export function writeSettings(dataDir, input, { operations = {} } = {}) {
  const patch = normalizeSettingsPatch(input);
  if (!dataDir) throw new Error('설정 저장 폴더가 필요합니다.');
  const io = { ...filesystem, ...operations };
  const directory = resolve(dataDir);
  io.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = io.lstatSync(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('설정 폴더는 실제 디렉터리여야 합니다.');
  io.chmodSync(directory, 0o700);
  const previous = readRecord(directory, io);
  const settings = { ...previous.settings, ...patch };
  const path = join(directory, 'settings.json');
  const temporary = `${path}.${randomUUID()}.tmp`;
  let descriptor, created = false;
  try {
    descriptor = io.openSync(temporary, filesystem.constants.O_CREAT | filesystem.constants.O_EXCL | filesystem.constants.O_WRONLY
      | (filesystem.constants.O_NOFOLLOW ?? 0), 0o600);
    created = true;
    io.fchmodSync(descriptor, 0o600);
    io.writeFileSync(descriptor, `${JSON.stringify(settings)}\n`);
    io.fsyncSync(descriptor);
    io.closeSync(descriptor); descriptor = undefined;
    if (readRecord(directory, io).text !== previous.text) throw new Error('다른 작업이 설정을 변경하여 덮어쓰지 않았습니다.');
    io.renameSync(temporary, path);
    return settings;
  } finally {
    if (descriptor !== undefined) io.closeSync(descriptor);
    if (created && io.existsSync(temporary)) io.unlinkSync(temporary);
  }
}

export function createSettingsStore({ dataDir } = {}) {
  let current = readSettings(dataDir);
  return {
    state() {
      if (dataDir) {
        try { current = readRecord(dataDir, filesystem).settings; } catch { /* Keep the last usable values if storage becomes unreadable. */ }
      }
      return { ...current };
    },
    update(input) {
      const next = dataDir ? writeSettings(dataDir, input) : { ...current, ...normalizeSettingsPatch(input) };
      current = next;
      return { ...current };
    },
  };
}
