import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeViewSettings, readViewSettings, saveViewSettings } from '../src/view-settings.ts';

test('view preferences reject invalid values and honor reduced motion on first visit', () => {
  const settings = normalizeViewSettings({ cycleSeconds: 0, labels: 'false', autoRotate: true, powerSaving: null }, true);
  assert.equal(settings.cycleSeconds, 25);
  assert.equal(settings.labels, true);
  assert.equal(settings.reducedMotion, true);
  assert.equal(settings.powerSaving, true);
  assert.equal(settings.autoRotate, true);
});
test('unavailable or damaged storage never prevents the office opening', () => {
  assert.equal(readViewSettings({ getItem() { throw Error('blocked'); } }, true).reducedMotion, true);
  assert.equal(readViewSettings({ getItem() { return '{bad'; } }).cycle, true);
  assert.equal(saveViewSettings({ setItem() { throw Error('full'); } }, normalizeViewSettings(null)), false);
});
test('only display choices persist, without agent or company information', () => {
  let stored;
  const settings = normalizeViewSettings({ cycleSeconds: 45, reducedMotion: false, companyName: 'private', agents: ['private'] });
  assert.equal(saveViewSettings({ setItem(_key, value) { stored = value; } }, settings), true);
  assert.deepEqual(readViewSettings({ getItem() { return stored; } }), settings);
  assert.equal(stored.includes('private'), false);
});
test('legacy away CCTV preferences are ignored and removed when settings are saved', () => {
  for (const awayCctv of [true, false]) {
    const settings = readViewSettings({ getItem() { return JSON.stringify({ awayCctv, labels: false, cycleSeconds: 45 }); } });
    assert.equal(Object.hasOwn(settings, 'awayCctv'), false);
    assert.equal(settings.labels, false);
    assert.equal(settings.cycleSeconds, 45);
    let stored;
    assert.equal(saveViewSettings({ setItem(_key, value) { stored = value; } }, settings), true);
    assert.equal(Object.hasOwn(JSON.parse(stored), 'awayCctv'), false);
  }
});

test('saving ordinary display preferences does not freeze the inherited OS motion preference across visits', () => {
  let stored;
  const storage = { getItem() { return stored ?? null; }, setItem(_key, value) { stored = value; } };
  const settings = readViewSettings(storage, true);
  settings.labels = false;
  assert.equal(saveViewSettings(storage, settings), true);
  assert.equal(Object.hasOwn(JSON.parse(stored), 'reducedMotion'), false);
  assert.equal(readViewSettings(storage, false).reducedMotion, false);
  assert.equal(readViewSettings(storage, true).reducedMotion, true);
  assert.equal(readViewSettings(storage, true).labels, false);
});

test('explicit and legacy motion choices survive OS changes until system defaults are requested', () => {
  let stored = JSON.stringify({ reducedMotion: false });
  const storage = { getItem() { return stored; }, setItem(_key, value) { stored = value; } };
  const settings = readViewSettings(storage, true);
  assert.equal(settings.reducedMotion, false, 'legacy storage cannot distinguish a direct choice from an inherited value');
  assert.equal(saveViewSettings(storage, settings), true);
  assert.equal(readViewSettings(storage, true).reducedMotion, false);
  settings.reducedMotionOverride = null;
  assert.equal(saveViewSettings(storage, settings), true);
  assert.equal(readViewSettings(storage, true).reducedMotion, true);
  settings.reducedMotionOverride = true;
  assert.equal(saveViewSettings(storage, settings), true);
  assert.equal(readViewSettings(storage, false).reducedMotion, true);
});
