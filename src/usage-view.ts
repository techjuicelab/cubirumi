export type UsageProviderId = 'codex' | 'claude';
export type UsageStatus = 'live' | 'stale' | 'unavailable';
export interface UsageWindow {
  id: string; label: string; usedPercent: number | null; remainingPercent: number | null;
  windowMinutes: number | null; resetsAt: number | null; status?: UsageStatus;
}
export interface ProviderUsage {
  provider: UsageProviderId; status: UsageStatus; updatedAt: string | null; source: string;
  reason?: string; windows: UsageWindow[];
}
export const unavailableUsage = (): ProviderUsage[] => (['codex', 'claude'] as const).map(provider => ({ provider, status: 'unavailable', updatedAt: null, source: 'none', windows: [] }));
const percentage = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
export function parseUsage(input: unknown): ProviderUsage[] {
  if (!input || typeof input !== 'object' || !('providers' in input) || !Array.isArray(input.providers)) return unavailableUsage();
  const providers = input.providers;
  return unavailableUsage().map(fallback => {
    const entry = providers.find((value: unknown) => !!value && typeof value === 'object' && 'provider' in value && value.provider === fallback.provider);
    if (!entry || !['live', 'stale', 'unavailable'].includes(entry.status)) return fallback;
    return { ...fallback, status: entry.status,
      updatedAt: typeof entry.updatedAt === 'string' && Number.isFinite(Date.parse(entry.updatedAt)) ? entry.updatedAt : null,
      source: typeof entry.source === 'string' ? entry.source.slice(0, 60) : 'none',
      reason: typeof entry.reason === 'string' ? entry.reason.slice(0, 100) : undefined,
      windows: (Array.isArray(entry.windows) ? entry.windows : []).slice(0, 16).flatMap((window: Record<string, unknown>) => {
        if (!window || typeof window !== 'object' || typeof window.id !== 'string' || typeof window.label !== 'string') return [];
        const usedPercent = percentage(window.usedPercent);
        return [{ id: window.id.slice(0, 80), label: window.label.slice(0, 80), usedPercent,
          remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
          windowMinutes: typeof window.windowMinutes === 'number' && window.windowMinutes > 0 ? window.windowMinutes : null,
          resetsAt: typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt) && window.resetsAt > 0 ? window.resetsAt : null,
          status: ['live', 'stale', 'unavailable'].includes(String(window.status)) ? window.status as UsageStatus : undefined }];
      }) };
  });
}
export function windowLive(provider: ProviderUsage, window: UsageWindow, now = Date.now()): boolean {
  return provider.status === 'live' && window.status !== 'stale' && window.status !== 'unavailable'
    && provider.updatedAt !== null && now - Date.parse(provider.updatedAt) <= 15 * 60_000
    && window.usedPercent !== null && (window.resetsAt === null || window.resetsAt * 1000 > now);
}
/** The account pool and Spark pool are distinct; never let a Spark limit impersonate the shared account. */
export function mainEnergy(provider: ProviderUsage, now = Date.now()): { remaining: number | null; window: UsageWindow | null; stale: boolean } {
  const windows = provider.windows.filter(window => provider.provider === 'claude' || window.id.startsWith('codex:'));
  const valid = windows.filter(window => windowLive(provider, window, now));
  const limiting = [...valid].sort((a, b) => a.remainingPercent! - b.remainingPercent!)[0];
  return limiting ? { remaining: limiting.remainingPercent, window: limiting, stale: false }
    : { remaining: null, window: windows[0] ?? null, stale: provider.status === 'stale' || windows.length > 0 };
}
/** Describe evidence already received, without implying a remote quota request is running. */
export function usageStatusCaption(provider: ProviderUsage, now = Date.now()): string {
  const energy = mainEnergy(provider, now);
  if (energy.remaining !== null) return energy.window!.label.replace(/^(?:Codex|Claude)\s*/, '');
  const windows = provider.windows.filter(window => provider.provider === 'claude' || window.id.startsWith('codex:'));
  if (windows.some(window => window.usedPercent !== null && window.resetsAt !== null && window.resetsAt * 1000 <= now)) {
    return provider.provider === 'claude' ? '새 응답 후 갱신' : '새 수치 수신 대기';
  }
  if (windows.some(window => window.usedPercent !== null)) return '마지막 수치 오래됨';
  if (provider.provider === 'claude') return provider.source === 'none' ? '상태줄 연결 대기' : '공식 사용량 수신 대기';
  return provider.source === 'none' ? '사용량 연결 대기' : '일반 한도 미확인';
}
export function usageStatusDetail(provider: ProviderUsage, now = Date.now()): string {
  const caption = usageStatusCaption(provider, now);
  if (caption === '상태줄 연결 대기') {
    return 'Claude Code 터미널 상태줄에서 아직 보고를 받지 못했습니다. Desktop의 사용량 표시는 별도로 확인해야 합니다.';
  }
  if (caption === '공식 사용량 수신 대기') {
    return '상태줄은 연결됐지만 공식 사용량 필드가 아직 없습니다. 지원되는 계정에서 실제 응답을 받은 뒤 다시 확인하세요.';
  }
  if (caption === '새 응답 후 갱신' || caption === '새 수치 수신 대기') {
    return '회복 시각이 지났습니다. 새 공식 수치를 받기 전에는 남은 사용량을 100%로 가정하지 않습니다.';
  }
  if (caption === '마지막 수치 오래됨') {
    return '마지막 수신 후 15분이 지났거나 최근 조회에 실패했습니다. 이전 수치는 참고용으로만 표시합니다.';
  }
  if (mainEnergy(provider, now).remaining !== null) {
    return provider.provider === 'claude'
      ? 'Claude Code 상태줄이 전달한 계정 사용량입니다. 화면 새로고침은 원격 사용량을 새로 조회하지 않습니다.'
      : 'Codex 계정 사용량을 주기적으로 조회합니다. Spark는 별도의 사용 한도로 표시합니다.';
  }
  return '일반 계정 한도의 공식 수치를 아직 받지 못했습니다. 미확인 값은 남은 사용량으로 계산하지 않습니다.';
}
export function resetLabel(seconds: number | null, now = Date.now()): string {
  if (seconds === null) return '회복 시각 미확인';
  if (seconds * 1000 <= now) return '새 사용량을 기다리는 중';
  const date = new Date(seconds * 1000);
  return `${date.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })} ${date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })} 회복`;
}
export function percentLabel(value: number | null): string { return value === null ? '—' : `${Number(value.toFixed(1))}%`; }
/** The latest measurement that is still meaningful: an aged value stays visible, a window whose reset passed does not. */
export function lastKnownEnergy(provider: ProviderUsage, now = Date.now()): { remaining: number | null; window: UsageWindow | null; observedAt: string | null } {
  const windows = provider.windows.filter(window => provider.provider === 'claude' || window.id.startsWith('codex:'));
  const known = windows.filter(window => window.usedPercent !== null && window.remainingPercent !== null && (window.resetsAt === null || window.resetsAt * 1000 > now));
  const limiting = [...known].sort((a, b) => a.remainingPercent! - b.remainingPercent!)[0];
  return limiting ? { remaining: limiting.remainingPercent, window: limiting, observedAt: provider.updatedAt } : { remaining: null, window: null, observedAt: null };
}
/** Time of the observation an aged value belongs to; carries the date once it is no longer today. Empty when the bridge never stamped one. */
export function observedLabel(updatedAt: string | null, now = Date.now()): string {
  if (updatedAt === null || !Number.isFinite(Date.parse(updatedAt))) return '';
  const date = new Date(updatedAt);
  const clock = date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  const sameDay = date.toDateString() === new Date(now).toDateString();
  return sameDay ? `${clock} 기준` : `${date.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })} ${clock} 기준`;
}
