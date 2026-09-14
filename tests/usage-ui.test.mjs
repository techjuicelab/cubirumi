import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { parseUsage } from '../src/usage-view.ts';
import { renderEnergyCards, renderUsageDetails, usageSectionId, CLAUDE_USAGE_URL } from '../src/usage-ui.ts';

const now = Date.parse('2026-09-13T12:35:00.000Z');
const observedAt = new Date(now - 2 * 3600_000).toISOString();
const windows = [
  { id: 'five_hour', label: 'Claude 5시간', usedPercent: 3, resetsAt: now / 1000 + 300 },
  { id: 'seven_day', label: 'Claude 주간', usedPercent: 34, resetsAt: now / 1000 + 7 * 86400 },
];
const data = (changes = {}) => parseUsage({ providers: [{ provider: 'claude', source: 'claude-statusline', status: 'live', updatedAt: observedAt, windows, ...changes }] });
function mount(t, html) {
  const window = new Window();
  t.after(() => window.happyDOM.close());
  window.document.body.innerHTML = html;
  return window.document;
}

test('an old quota is marked next to its percentage, retains the observation time, and never mutates on refresh or receiver failure', t => {
  const providers = data();
  const before = structuredClone(providers);
  const document = mount(t, renderEnergyCards(providers, { now }));
  const card = document.querySelector('.energy-tank.claude');
  assert.equal(card.querySelector('.energy-tank-amount').textContent, '66%마지막 기록');
  assert.match(card.getAttribute('aria-label'), /최신 아님/);
  const observed = card.querySelector('.energy-observed').textContent;
  document.body.innerHTML = renderEnergyCards(providers, { now: now + 60_000, receiverUnavailable: true });
  const failed = document.querySelector('.energy-tank.claude');
  assert.equal(failed.querySelector('.energy-tank-amount').textContent, '66%마지막 기록');
  assert.equal(failed.querySelector('.energy-observed').textContent, observed);
  assert.match(failed.textContent, /수신기 연결 확인 필요/);
  assert.deepEqual(providers, before);
  document.body.innerHTML = renderUsageDetails(providers, { now: now + 24 * 3600_000 });
  assert.match(document.querySelector('.provider-usage.claude .provider-usage-heading').textContent, /9\. 13\./, 'a previous day cannot look like a recent same-day reading');
});

test('expired quotas stay historical in detail, missing windows stay unknown, and neither becomes a full tank', t => {
  const providers = data({ windows: [windows[0], { ...windows[1], usedPercent: null }] });
  const later = now + 301_000;
  const document = mount(t, renderEnergyCards(providers, { now: later }) + renderUsageDetails(providers, { now: later }));
  assert.equal(document.querySelector('.energy-tank.claude b').textContent, '—');
  assert.equal(document.querySelector('.energy-tank.claude .energy-record-tag'), null);
  const [expired, missing] = document.querySelectorAll('.provider-usage.claude .quota-window');
  assert.equal(expired.querySelector('.quota-value strong').textContent, '97%');
  assert.match(expired.textContent, /마지막 기록/);
  assert.match(expired.textContent, /새 사용량을 기다리는 중/);
  assert.equal(missing.querySelector('.quota-value strong').textContent, '—');
  assert.match(missing.querySelector('.quota-title').textContent, /미확인/);
  assert.doesNotMatch(missing.textContent, /마지막 기록|마지막 보고/);
});

test('each card targets its accessible provider section, and the Claude official link is fixed while received labels are escaped', t => {
  const providers = data({ updatedAt: new Date(now).toISOString(), windows: [{ ...windows[0], label: '<img src=x onerror=alert(1)>' }] });
  const document = mount(t, renderEnergyCards(providers, { now }) + renderUsageDetails(providers, { now }));
  for (const provider of ['codex', 'claude']) {
    const card = document.querySelector(`[data-usage-provider="${provider}"]`);
    const section = document.getElementById(usageSectionId(provider));
    assert.equal(card.id, `usage-card-${provider}`);
    assert.equal(card.getAttribute('aria-controls'), section.id);
    assert.equal(section.getAttribute('tabindex'), '-1');
    assert.equal(document.getElementById(section.getAttribute('aria-labelledby')).tagName, 'H3');
  }
  const claude = document.getElementById(usageSectionId('claude'));
  const link = claude.querySelector('a');
  assert.equal(link.id, 'claude-usage-external-link');
  assert.equal(link.href, CLAUDE_USAGE_URL);
  assert.equal(link.target, '_blank');
  assert.ok(link.relList.contains('noopener'));
  assert.ok(link.relList.contains('noreferrer'));
  assert.match(claude.textContent, /새로고침은 원격 한도를 조회하지 않아요/);
  assert.equal(document.querySelector('img'), null);
  assert.match(claude.querySelector('h4').textContent, /<img/);
  assert.equal(document.querySelector('.energy-tank.claude .energy-record-tag'), null, 'fresh measurements are not labelled historical');
  const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
  assert.equal(new Set(ids).size, ids.length, 'focus restoration always has a unique target');
});
