import test from 'node:test';
import assert from 'node:assert/strict';
import { companyNameFromSettings, DEFAULT_COMPANY_NAME, DEFAULT_OWNER_NAME, loadCompanyName, renderCompanyName,
  normalizeCompanySettings, loadCompanySettings, saveCompanySettings, renderCompanySettings } from './company-settings.ts';

test('company settings default safely when no usable local name is supplied', () => {
  for (const settings of [null, undefined, [], 'sample', {}, { companyName: 42 }, { companyName: '  \n ' }]) {
    assert.equal(companyNameFromSettings(settings), DEFAULT_COMPANY_NAME);
  }
  assert.equal(companyNameFromSettings({ companyName: '  예시 스튜디오  ' }), '예시 스튜디오');
  assert.equal(companyNameFromSettings({ companyName: '예시\n스튜디오' }), '예시 스튜디오');
  assert.equal([...companyNameFromSettings({ companyName: '봄'.repeat(90) })].length, 80);
});

test('runtime name comes from the local GET settings endpoint and failures keep the generic name', async () => {
  const received = [];
  const name = await loadCompanyName(async (url, init) => {
    received.push({ url, method: init.method });
    return { ok: true, json: async () => ({ companyName: '예시 스튜디오' }) };
  });
  assert.equal(name, '예시 스튜디오');
  assert.deepEqual(received, [{ url: '/api/settings', method: 'GET' }]);
  assert.equal(await loadCompanyName(async () => ({ ok: false, json: async () => ({ companyName: 'unused' }) })), DEFAULT_COMPANY_NAME);
  assert.equal(await loadCompanyName(async () => { throw new Error('connection unavailable'); }), DEFAULT_COMPANY_NAME);
  assert.equal(await loadCompanyName(async () => ({ ok: true, json: async () => { throw new SyntaxError('invalid JSON'); } })), DEFAULT_COMPANY_NAME);
});

test('company names render only through text and attributes, never executable HTML', () => {
  const name = '<img src=x onerror="globalThis.compromised=true">';
  const element = () => ({ textContent: '', attributes: {}, set innerHTML(_) { throw new Error('HTML insertion is forbidden'); }, setAttribute(key, value) { this.attributes[key] = value; } });
  const brand = element();
  const heading = element();
  const owner = element();
  const home = element();
  const selectors = { '[data-company-name]': [brand, heading], '[data-company-owner]': [owner], '[data-company-home]': [home] };
  renderCompanyName({ querySelectorAll: selector => selectors[selector] }, name);
  assert.equal(brand.textContent, name);
  assert.equal(heading.textContent, name);
  assert.equal(owner.textContent, `${name} 사장님`);
  assert.equal(home.attributes['aria-label'], `${name} 홈`);
  assert.equal(globalThis.compromised, undefined);
});

test('personal settings migrate company-only responses and bound the owner display name', async () => {
  assert.deepEqual(normalizeCompanySettings({ companyName: '예시 회사', secret: 'private' }), { companyName: '예시 회사', ownerName: DEFAULT_OWNER_NAME });
  assert.equal([...normalizeCompanySettings({ ownerName: '🌱'.repeat(50) }).ownerName].length, 40);
  assert.deepEqual(await loadCompanySettings(async () => ({ ok: true, json: async () => ({ companyName: '예시 회사', ownerName: '가람' }) })),
    { companyName: '예시 회사', ownerName: '가람' });
  assert.deepEqual(await loadCompanySettings(async () => { throw new Error('Unavailable'); }),
    { companyName: DEFAULT_COMPANY_NAME, ownerName: DEFAULT_OWNER_NAME });
  const current = { companyName: '예시 회사', ownerName: '가람' };
  for (const request of [async () => { throw new TypeError('Offline'); }, async () => ({ ok: false, json: async () => ({}) })]) {
    const refreshed = await loadCompanySettings(request, current);
    assert.deepEqual(refreshed, current, 'a window refresh during connection loss keeps the last saved display names');
    assert.notEqual(refreshed, current, 'callers receive a separate settings value');
  }
});

test('saving preferences sends only the edited fields and rejects failures without inventing defaults', async () => {
  const calls = [];
  const request = async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body), type: init.headers['Content-Type'] });
    return { ok: true, json: async () => ({ companyName: '예시 회사', ownerName: '가람' }) };
  };
  assert.deepEqual(await saveCompanySettings({ ownerName: '  가람 ' }, request), { companyName: '예시 회사', ownerName: '가람' });
  assert.deepEqual(calls, [{ url: '/api/settings', method: 'PATCH', body: { ownerName: '가람' }, type: 'application/json' }]);
  for (const input of [{}, { ownerName: '' }, { ownerName: '가'.repeat(41) }, { ownerName: '가\n람' }, { companyName: '예시', secret: 'private' }]) {
    await assert.rejects(saveCompanySettings(input, request));
  }
  assert.equal(calls.length, 1, 'invalid input is not sent');
  for (const response of [{ ok: false, json: async () => ({}) }, { ok: true, json: async () => ({ companyName: '예시' }) },
    { ok: true, json: async () => ({ companyName: '예시', ownerName: '' }) }]) {
    await assert.rejects(saveCompanySettings({ ownerName: '가람' }, async () => response));
  }
  await assert.rejects(saveCompanySettings({ ownerName: '가람' }, async () => { throw new Error('Unavailable'); }));
});

test('owner and company displays are independent and use textContent for untrusted names', () => {
  const element = () => ({ textContent: '', attributes: {}, set innerHTML(_) { throw new Error('HTML insertion is forbidden'); }, setAttribute(key, value) { this.attributes[key] = value; } });
  const company = element(), owner = element(), ownerTitle = element(), companyOwner = element(), home = element();
  const selectors = { '[data-company-name]': [company], '[data-company-owner]': [companyOwner], '[data-company-home]': [home],
    '[data-owner-name]': [owner], '[data-owner-title], [data-company-owner]': [ownerTitle, companyOwner] };
  const name = '<img src=x onerror=alert(1)>';
  renderCompanySettings({ querySelectorAll: selector => selectors[selector] }, { companyName: '예시 회사', ownerName: name });
  assert.equal(company.textContent, '예시 회사');
  assert.equal(owner.textContent, name);
  assert.equal(ownerTitle.textContent, `${name} 사장님`);
  assert.equal(companyOwner.textContent, `${name} 사장님`);
  assert.equal(home.attributes['aria-label'], '예시 회사 홈');
});
