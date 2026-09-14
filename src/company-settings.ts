export const DEFAULT_COMPANY_NAME = '나의 회사';
export const DEFAULT_OWNER_NAME = '나';
export interface CompanySettings { companyName: string; ownerName: string }
const defaults = (): CompanySettings => ({ companyName: DEFAULT_COMPANY_NAME, ownerName: DEFAULT_OWNER_NAME });
const controlPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

type SettingsResponse = { ok: boolean; json(): Promise<unknown> };
type SettingsRequest = (input: string, init?: RequestInit) => Promise<SettingsResponse>;

function displayName(value: unknown, maximum: number, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const name = value.replace(controlPattern, ' ').trim();
  return name ? [...name].slice(0, maximum).join('') : fallback;
}

export function companyNameFromSettings(settings: unknown): string {
  if (!settings || typeof settings !== 'object' || !('companyName' in settings)) return DEFAULT_COMPANY_NAME;
  return displayName(settings.companyName, 80, DEFAULT_COMPANY_NAME);
}

export function ownerNameFromSettings(settings: unknown): string {
  if (!settings || typeof settings !== 'object' || !('ownerName' in settings)) return DEFAULT_OWNER_NAME;
  return displayName(settings.ownerName, 40, DEFAULT_OWNER_NAME);
}

export function normalizeCompanySettings(settings: unknown): CompanySettings {
  return { companyName: companyNameFromSettings(settings), ownerName: ownerNameFromSettings(settings) };
}

export function validateCompanySettingsPatch(input: unknown): Partial<CompanySettings> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('설정은 객체여야 합니다.');
  const entries = Object.entries(input);
  if (!entries.length || entries.some(([key]) => key !== 'companyName' && key !== 'ownerName')) throw new Error('회사명과 사장 이름만 변경할 수 있습니다.');
  const patch: Partial<CompanySettings> = {};
  for (const [key, value] of entries) {
    const field = key as keyof CompanySettings;
    const maximum = field === 'companyName' ? 80 : 40;
    if (typeof value !== 'string' || value.match(controlPattern) || !value.trim() || [...value.trim()].length > maximum) {
      throw new Error(`${field === 'companyName' ? '회사명' : '사장 이름'}은 줄바꿈 없이 1~${maximum}자로 입력해 주세요.`);
    }
    patch[field] = value.trim();
  }
  return patch;
}

export async function loadCompanySettings(request: SettingsRequest = fetch, fallback: CompanySettings = defaults()): Promise<CompanySettings> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await request('/api/settings', { method: 'GET', signal: controller.signal });
    return response.ok ? normalizeCompanySettings(await response.json()) : { ...fallback };
  } catch {
    return { ...fallback };
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadCompanyName(request: SettingsRequest = fetch): Promise<string> {
  return (await loadCompanySettings(request)).companyName;
}

/** Reject failed or malformed saves so the caller can retain the currently rendered values. */
export async function saveCompanySettings(input: Partial<CompanySettings>, request: SettingsRequest = fetch): Promise<CompanySettings> {
  const patch = validateCompanySettingsPatch(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await request('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch), signal: controller.signal });
    if (!response.ok) throw new Error('설정을 저장하지 못했습니다. 기존 이름을 유지합니다.');
    const saved = validateCompanySettingsPatch(await response.json());
    if (saved.companyName === undefined || saved.ownerName === undefined) throw new Error('저장된 설정을 확인하지 못했습니다.');
    return { companyName: saved.companyName, ownerName: saved.ownerName };
  } finally { clearTimeout(timeout); }
}

export function renderCompanyName(root: ParentNode, name: string): void {
  // Local configuration is untrusted text. Never insert company names as HTML.
  root.querySelectorAll('[data-company-name]').forEach(element => { element.textContent = name; });
  root.querySelectorAll('[data-company-owner]').forEach(element => { element.textContent = `${name} 사장님`; });
  root.querySelectorAll('[data-company-home]').forEach(element => { element.setAttribute('aria-label', `${name} 홈`); });
}

export function renderCompanySettings(root: ParentNode, settings: CompanySettings): void {
  const clean = normalizeCompanySettings(settings);
  renderCompanyName(root, clean.companyName);
  root.querySelectorAll('[data-owner-name]').forEach(element => { element.textContent = clean.ownerName; });
  root.querySelectorAll('[data-owner-title], [data-company-owner]').forEach(element => { element.textContent = `${clean.ownerName} 사장님`; });
}
