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
/** The receiver's stable quota IDs and durations are metadata; their display labels follow this window's language. */
export function usageWindowLabel(window: UsageWindow, provider: UsageProviderId): string {
  const known = provider === 'claude' ? ['five_hour', 'seven_day'].includes(window.id)
    : /^(?:codex|codex_bengalfox):(?:primary|secondary)$/.test(window.id);
  if (!known) return window.label;
  const minutes = window.windowMinutes ?? (window.id === 'five_hour' ? 300 : window.id === 'seven_day' ? 10080 : null);
  const name = provider === 'claude' ? 'Claude' : window.id.startsWith('codex_bengalfox:') ? 'Codex Spark' : 'Codex';
  const duration = minutes === 300 ? msg('5-hour', '5시간') : minutes === 10080 ? msg('Weekly', '주간')
    : minutes === null ? msg('Unknown period', '기간 미확인') : msg('{minutes} min', '{minutes}분', { minutes });
  return `${name} ${duration}`;
}
function usageEvidence(provider: ProviderUsage, now: number): 'live' | 'expired' | 'aged' | 'statusline' | 'official' | 'connection' | 'unknown' {
  if (mainEnergy(provider, now).remaining !== null) return 'live';
  const windows = provider.windows.filter(window => provider.provider === 'claude' || window.id.startsWith('codex:'));
  if (windows.some(window => window.usedPercent !== null && window.resetsAt !== null && window.resetsAt * 1000 <= now)) return 'expired';
  if (windows.some(window => window.usedPercent !== null)) return 'aged';
  if (provider.provider === 'claude') return provider.source === 'none' ? 'statusline' : 'official';
  return provider.source === 'none' ? 'connection' : 'unknown';
}
/** Describe evidence already received, without implying a remote quota request is running. */
export function usageStatusCaption(provider: ProviderUsage, now = Date.now()): string {
  switch (usageEvidence(provider, now)) {
    case 'live': return usageWindowLabel(mainEnergy(provider, now).window!, provider.provider).replace(/^(?:Codex|Claude)\s*/, '');
    case 'expired': return provider.provider === 'claude' ? msg('Updates after a new response', '새 응답 후 갱신') : msg('Waiting for a new measurement', '새 수치 수신 대기');
    case 'aged': return msg('Last measurement is outdated', '마지막 수치 오래됨');
    case 'statusline': return msg('Waiting for status line', '상태줄 연결 대기');
    case 'official': return msg('Waiting for official usage', '공식 사용량 수신 대기');
    case 'connection': return msg('Waiting for usage connection', '사용량 연결 대기');
    case 'unknown': return msg('Account limit unknown', '일반 한도 미확인');
  }
}
export function usageStatusDetail(provider: ProviderUsage, now = Date.now()): string {
  switch (usageEvidence(provider, now)) {
    case 'statusline': return msg('No report has arrived from the Claude Code terminal status line. Check Desktop usage separately.', 'Claude Code 터미널 상태줄에서 아직 보고를 받지 못했습니다. Desktop의 사용량 표시는 별도로 확인해야 합니다.');
    case 'official': return msg('The status line is connected, but official usage fields have not arrived. Try again after a real response on a supported account.', '상태줄은 연결됐지만 공식 사용량 필드가 아직 없습니다. 지원되는 계정에서 실제 응답을 받은 뒤 다시 확인하세요.');
    case 'expired': return msg('The reset time has passed. Remaining usage is not assumed to be 100% until a new official measurement arrives.', '회복 시각이 지났습니다. 새 공식 수치를 받기 전에는 남은 사용량을 100%로 가정하지 않습니다.');
    case 'aged': return msg('The last report is over 15 minutes old or the latest check failed. Previous values are shown for reference.', '마지막 수신 후 15분이 지났거나 최근 조회에 실패했습니다. 이전 수치는 참고용으로만 표시합니다.');
    case 'live': return provider.provider === 'claude'
      ? msg('Account usage reported by the Claude Code status line. Refreshing this screen does not query remote usage.', 'Claude Code 상태줄이 전달한 계정 사용량입니다. 화면 새로고침은 원격 사용량을 새로 조회하지 않습니다.')
      : msg('Codex account usage is checked periodically. Spark has a separate usage limit.', 'Codex 계정 사용량을 주기적으로 조회합니다. Spark는 별도의 사용 한도로 표시합니다.');
    default: return msg('Official account limit measurements have not arrived. Unknown values are not counted as remaining usage.', '일반 계정 한도의 공식 수치를 아직 받지 못했습니다. 미확인 값은 남은 사용량으로 계산하지 않습니다.');
  }
}
export function resetLabel(seconds: number | null, now = Date.now()): string {
  if (seconds === null) return msg('Reset time unknown', '회복 시각 미확인');
  if (seconds * 1000 <= now) return msg('Waiting for new usage', '새 사용량을 기다리는 중');
  const date = new Date(seconds * 1000);
  const when = `${date.toLocaleDateString(locale(), { month: 'numeric', day: 'numeric' })} ${date.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hour12: false })}`;
  return msg('Resets {when}', '{when} 회복', { when });
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
export function observedLabel(updatedAt: string | null, now = Date.now(), withQualifier = true): string {
  if (updatedAt === null || !Number.isFinite(Date.parse(updatedAt))) return '';
  const date = new Date(updatedAt);
  const clock = date.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hour12: false });
  const sameDay = date.toDateString() === new Date(now).toDateString();
  const when = sameDay ? clock : `${date.toLocaleDateString(locale(), { month: 'numeric', day: 'numeric' })} ${clock}`;
  return withQualifier ? msg('As of {when}', '{when} 기준', { when }) : when;
}
import { locale, msg } from './i18n.ts';
