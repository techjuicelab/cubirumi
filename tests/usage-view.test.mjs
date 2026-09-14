import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUsage, mainEnergy, lastKnownEnergy, observedLabel, windowLive, usageStatusCaption, usageStatusDetail } from '../src/usage-view.ts';
const now = Date.parse('2026-01-01T10:00:00Z');
const window = (id, usedPercent, resetsAt = now / 1000 + 3600) => ({ id, label: id, usedPercent, resetsAt });
const input = (windows, extra = {}) => ({ providers: [{ provider: 'codex', status: 'live', updatedAt: new Date(now).toISOString(), windows, ...extra }] });
test('Spark is a separate pool and cannot empty the ordinary Codex energy tank', () => {
  const [provider] = parseUsage(input([window('codex:primary', 24), window('codex_bengalfox:primary', 100)]));
  assert.equal(mainEnergy(provider, now).remaining, 76);
});
test('unknown, old and reset-passed windows never become a fictional full or empty tank', () => {
  assert.equal(mainEnergy(parseUsage(null)[0], now).remaining, null);
  assert.equal(mainEnergy(parseUsage(input([window('codex:primary', null)]))[0], now).remaining, null);
  assert.equal(mainEnergy(parseUsage(input([window('codex:primary', 30, now / 1000)]))[0], now).remaining, null);
  const [provider] = parseUsage(input([window('codex:primary', 30)]));
  assert.equal(windowLive(provider, provider.windows[0], now + 16 * 60_000), false);
});
test('remaining is computed from a valid provider percentage and each provider stays independent', () => {
  const [provider, claude] = parseUsage(input([{ ...window('codex:primary', 100), remainingPercent: 100 }]));
  assert.equal(mainEnergy(provider, now).remaining, 0);
  assert.equal(mainEnergy(claude, now).remaining, null);
  assert.equal(mainEnergy(parseUsage(input([window('codex:primary', 0)]))[0], now).remaining, 100);
});

test('Claude captions distinguish missing connection, absent quota, old measurements, and an elapsed reset', () => {
  const absent = parseUsage(null)[1];
  assert.equal(usageStatusCaption(absent, now), '상태줄 연결 대기');
  assert.match(usageStatusDetail(absent, now), /터미널/);
  assert.equal(usageStatusCaption({ ...absent, source: 'claude-statusline' }, now), '공식 사용량 수신 대기');
  const [_, provider] = parseUsage({ providers: [{ provider: 'claude', status: 'live', source: 'claude-statusline', updatedAt: new Date(now).toISOString(),
    windows: [{ ...window('five_hour', 10), label: 'Claude 5시간' }] }] });
  assert.equal(usageStatusCaption(provider, now), '5시간');
  assert.equal(usageStatusCaption(provider, now + 16 * 60_000), '마지막 수치 오래됨');
  assert.equal(usageStatusCaption(provider, now + 61 * 60_000), '새 응답 후 갱신');
  assert.match(usageStatusDetail(provider, now + 61 * 60_000), /100%/);
});

test('aged measurements stay visible with their observation time; reset-passed, absent and Spark-only values do not', () => {
  const observedAt = new Date(now).toISOString();
  const claude = parseUsage({ providers: [{ provider: 'claude', status: 'live', source: 'claude-statusline', updatedAt: observedAt,
    windows: [{ ...window('five_hour', 14), label: 'Claude 5시간' }, { ...window('seven_day', 27, now / 1000 + 86400), label: 'Claude 주간' }] }] })[1];
  const later = now + 16 * 60_000;
  assert.equal(mainEnergy(claude, later).remaining, null, '15분이 지나면 현재 값으로 취급하지 않는다');
  const aged = lastKnownEnergy(claude, later);
  assert.equal(aged.remaining, 73, '가장 적게 남은 창의 마지막 값');
  assert.equal(aged.window.id, 'seven_day');
  assert.equal(aged.observedAt, observedAt);
  assert.match(observedLabel(aged.observedAt, later), /^\d{2}:\d{2} 기준$/);
  assert.match(observedLabel(aged.observedAt, now + 26 * 3600_000), /^\d{1,2}\. \d{1,2}\. \d{2}:\d{2} 기준$/, '다른 날의 관측이면 날짜를 붙인다');
  assert.equal(observedLabel(null), '');
  assert.equal(observedLabel('not-a-date'), '');
  const fiveHourOnly = parseUsage({ providers: [{ provider: 'claude', status: 'live', source: 'claude-statusline', updatedAt: observedAt,
    windows: [{ ...window('five_hour', 14), label: 'Claude 5시간' }] }] })[1];
  assert.equal(lastKnownEnergy(fiveHourOnly, now + 61 * 60_000).remaining, null, '회복 시각이 지난 창은 오래된 값도 보여주지 않는다');
  assert.equal(lastKnownEnergy(parseUsage(null)[1], now).remaining, null);
  assert.equal(lastKnownEnergy(parseUsage(input([window('codex:primary', null)]))[0], now).remaining, null);
  assert.equal(lastKnownEnergy(parseUsage(input([window('codex_bengalfox:primary', 100)]))[0], later).remaining, null, 'Spark만으로 일반 Codex 탱크를 채우지 않는다');
});
