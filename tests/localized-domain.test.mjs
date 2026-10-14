import test from 'node:test';
import assert from 'node:assert/strict';
import { getLanguage, setLanguage } from '../src/i18n.ts';
import { STATUS_STYLE, UNCONFIRMED_STYLE, externalCallLabel, isExternalCall } from '../src/status-style.ts';
import { activityNames, statusNames, sourceNames, observationNames } from '../src/protocol.ts';
import { activityMessage } from '../src/activity-bubble.ts';
import { parseUsage, usageStatusCaption, usageStatusDetail, usageWindowLabel, resetLabel } from '../src/usage-view.ts';
import { renderEnergyCards, renderUsageDetails } from '../src/usage-ui.ts';
import { floorSummary } from '../src/building-overview.ts';

test('domain labels start in English and change together without changing tool identity or raw tasks', t => {
  t.after(() => setLanguage('en'));
  assert.equal(getLanguage(), 'en');
  assert.equal(STATUS_STYLE.working.label, 'Working');
  assert.equal(statusNames.approval, 'Approval needed');
  assert.equal(activityNames.documents, 'Documents');
  assert.equal(sourceNames.manual, 'Manual');
  assert.equal(observationNames.hook, 'App activity notification');
  assert.equal(UNCONFIRMED_STYLE.label, 'Current status unknown');
  const observed = { status: 'working', toolName: 'MCP 도구', activityKind: 'research' };
  assert.equal(isExternalCall(observed), true);
  assert.equal(activityMessage(observed).fullText, externalCallLabel());
  assert.equal(activityMessage({ status: 'working', task: '사용자 원문 <literal>' }).fullText, '사용자 원문 <literal>');
  assert.equal(floorSummary({ working: 1, approval: 2, error: 0, quiet: 0, unconfirmed: 0 }), 'Working 1 · Approval 2');
  setLanguage('ko');
  assert.equal(STATUS_STYLE.working.label, '작업 중');
  assert.equal(statusNames.approval, '확인 요청');
  assert.equal(activityNames.documents, '문서 정리');
  assert.equal(sourceNames.manual, '직접 전송');
  assert.equal(observationNames.hook, '앱 작업 알림');
  assert.equal(UNCONFIRMED_STYLE.label, '현재 상태 미확인');
  assert.equal(activityMessage(observed).fullText, '외부 서비스 연동 중');
  assert.equal(activityMessage({ status: 'working', activityKind: 'documents' }).fullText, '문서 정리 중');
  assert.equal(observed.toolName, 'MCP 도구');
  assert.equal(floorSummary({ working: 1, approval: 2, error: 0, quiet: 0, unconfirmed: 0 }), '작업 1 · 확인 요청 2');
  setLanguage('en');
  assert.equal(activityMessage({ status: 'working', activityKind: 'documents' }).fullText, 'Documents in progress');
});

test('quota labels and explanations follow the language while received measurements remain untouched', t => {
  t.after(() => setLanguage('en'));
  setLanguage('en');
  const now = Date.parse('2026-10-14T00:00:00Z');
  const providers = parseUsage({ providers: [{ provider: 'claude', status: 'live', source: 'claude-statusline', updatedAt: new Date(now).toISOString(),
    windows: [{ id: 'five_hour', label: 'Claude 5시간', windowMinutes: 300, usedPercent: 25, resetsAt: now / 1000 + 3600 }] }] });
  const provider = providers[1];
  const original = JSON.stringify(provider);
  assert.equal(usageWindowLabel(provider.windows[0], 'claude'), 'Claude 5-hour');
  assert.equal(usageStatusCaption(provider, now), '5-hour');
  assert.match(renderEnergyCards(providers, { now }), /75% remaining/);
  assert.match(renderUsageDetails(providers, { now }), /Open Claude usage/);
  assert.match(resetLabel(now / 1000 + 3600, now), /^Resets /);
  assert.match(usageStatusDetail(provider, now + 3600_001), /not assumed to be 100%/);
  setLanguage('ko');
  assert.equal(usageStatusCaption(provider, now), '5시간');
  assert.match(renderUsageDetails(providers, { now }), /Claude 사용량 열기/);
  assert.match(usageStatusDetail(provider, now + 3600_001), /100%로 가정하지/);
  assert.equal(JSON.stringify(provider), original);
});
