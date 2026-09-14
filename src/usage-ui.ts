import {
  mainEnergy, lastKnownEnergy, observedLabel, percentLabel, resetLabel,
  usageStatusCaption, usageStatusDetail, windowLive,
  type ProviderUsage, type UsageProviderId,
} from './usage-view.ts';

export interface UsageRenderOptions {
  receiverUnavailable?: boolean;
  now?: number;
}

export const CLAUDE_USAGE_URL = 'https://claude.ai/settings/usage';
export const usageSectionId = (provider: UsageProviderId): string => `usage-provider-${provider}`;
const escape = (text: string): string => text.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]!));
const effectiveUsage = (provider: ProviderUsage, receiverUnavailable: boolean): ProviderUsage =>
  receiverUnavailable && provider.status !== 'unavailable' ? { ...provider, status: 'stale' } : provider;

/** Render received evidence only. Opening a panel or rendering again never changes its observation time. */
export function renderEnergyCards(providers: readonly ProviderUsage[], { receiverUnavailable = false, now = Date.now() }: UsageRenderOptions = {}): string {
  return providers.map(raw => {
    const provider = effectiveUsage(raw, receiverUnavailable);
    const energy = mainEnergy(provider, now);
    const name = provider.provider === 'codex' ? 'Codex' : 'Claude';
    const aged = energy.remaining === null ? lastKnownEnergy(provider, now) : null;
    const amount = energy.remaining ?? aged?.remaining ?? null;
    const isAged = aged !== null && aged.remaining !== null;
    const observed = isAged ? observedLabel(aged.observedAt, now) : '';
    const status = receiverUnavailable ? '수신기 연결 확인 필요' : usageStatusCaption(provider, now);
    const agedLead = isAged && !receiverUnavailable && aged.window ? aged.window.label.replace(/^(?:Codex|Claude)\s*/, '') : status;
    const caption = isAged ? `${escape(agedLead)}${observed ? ` · <span class="energy-observed">${escape(observed)}</span>` : ''}` : escape(status);
    const tone = amount === null ? 'unknown' : isAged ? 'aged' : amount < 15 ? 'low' : '';
    const label = amount === null ? '미확인' : isAged ? `최신 아님, ${observed || '관측 시각 미상'} ${percentLabel(amount)} 남음` : `${percentLabel(amount)} 남음`;
    const recordTag = isAged ? '<span class="energy-record-tag">마지막 기록</span>' : '';
    return `<button id="usage-card-${provider.provider}" class="energy-tank ${provider.provider} ${tone}" data-open="usage" data-usage-provider="${provider.provider}" aria-controls="${usageSectionId(provider.provider)}" aria-label="${name} 공용 에너지 ${escape(label)}"><span class="energy-tank-head"><strong>${name}</strong><span class="energy-tank-amount"><b>${percentLabel(amount)}</b>${recordTag}</span></span><span class="energy-track" aria-hidden="true"><i style="width:${amount ?? 0}%"></i></span><small>${caption}</small></button>`;
  }).join('');
}

export function renderUsageDetails(providers: readonly ProviderUsage[], { receiverUnavailable = false, now = Date.now() }: UsageRenderOptions = {}): string {
  return providers.map(raw => {
    const provider = effectiveUsage(raw, receiverUnavailable);
    const name = provider.provider === 'codex' ? 'Codex' : 'Claude Code';
    const observed = observedLabel(provider.updatedAt, now).replace(/ 기준$/, '');
    const updated = observed ? `마지막 확인 ${observed}` : '아직 사용량을 받지 못했어요';
    const windows = provider.windows.map(window => {
      const known = window.usedPercent !== null && window.remainingPercent !== null;
      const fresh = windowLive(provider, window, now);
      const recordTag = !fresh && known ? '<span class="quota-record-tag">마지막 기록</span>' : '';
      const caption = fresh ? '남은 에너지' : known ? '마지막 기록' : '미확인';
      const detail = !known ? '공식 사용 비율을 아직 받지 못했어요.' : fresh ? escape(resetLabel(window.resetsAt, now))
        : `현재 남은 양은 새 조회가 필요해요.<br>마지막 보고: ${escape(resetLabel(window.resetsAt, now))}`;
      return `<article class="quota-window ${fresh ? '' : known ? 'stale' : 'unknown'}"><div class="quota-title"><h4>${escape(window.label)}</h4><span>${caption}</span></div><div class="quota-value"><div class="quota-value-amount"><strong>${percentLabel(window.remainingPercent)}</strong>${recordTag}</div><span>사용 ${percentLabel(window.usedPercent)}</span></div><div class="quota-track" aria-hidden="true"><i style="width:${window.remainingPercent ?? 0}%"></i></div><p>${detail}</p></article>`;
    }).join('');
    const waiting = `<div class="usage-waiting"><strong>남은 사용량 미확인</strong><p>${provider.provider === 'claude' ? '연결된 Claude Code 터미널에서 실제 응답을 받은 뒤 공식 한도가 도착하면 표시됩니다.' : 'Codex 연결과 로그인 상태를 확인해주세요.'}</p></div>`;
    const footnote = provider.provider === 'codex'
      ? '<p class="panel-footnote">일반 Codex와 Spark의 별도 한도를 분리해서 표시해요.</p>'
      : `<div class="usage-provider-actions"><a id="claude-usage-external-link" class="usage-external-link secondary-button" href="${CLAUDE_USAGE_URL}" target="_blank" rel="noopener noreferrer" aria-label="Claude 공식 사용량 페이지 열기 (새 창)">Claude 사용량 열기</a><p class="panel-footnote">현재 한도는 Claude 공식 페이지에서 확인할 수 있어요. 이곳의 수치는 Claude Code 터미널 상태줄에서 새 응답 후 전달되며, 수신 내용 새로고침은 원격 한도를 조회하지 않아요.</p></div>`;
    const id = usageSectionId(provider.provider);
    const detail = receiverUnavailable ? '로컬 수신기에 연결하지 못했어요. 연결되면 다시 확인합니다.' : usageStatusDetail(provider, now);
    return `<section id="${id}" class="provider-usage ${provider.provider}" tabindex="-1" aria-labelledby="${id}-title"><div class="provider-usage-heading"><h3 id="${id}-title">${name}</h3><span>${escape(updated)}</span></div><p class="usage-status-detail">${escape(detail)}</p>${windows || waiting}${footnote}</section>`;
  }).join('');
}
