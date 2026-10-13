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

test('quiet floors rest after an hour by default, and only the offered limits are kept', () => {
  assert.equal(normalizeViewSettings(null).dormantFloorMinutes, 60);
  for (const minutes of [0, 30, 60, 180, 360, 720, 1440, 4320, 10080]) assert.equal(normalizeViewSettings({ dormantFloorMinutes: minutes }).dormantFloorMinutes, minutes);
  // Number(null), Number('') and Number(false) are 0, which would silently keep every floor.
  for (const invalid of [null, '', false, '30', 1, -60, 60.5, NaN, Infinity, [60], {}]) {
    assert.equal(normalizeViewSettings({ dormantFloorMinutes: invalid }).dormantFloorMinutes, 60, String(invalid));
  }
  let stored;
  const storage = { getItem() { return stored ?? null; }, setItem(_key, value) { stored = value; } };
  const settings = readViewSettings(storage);
  settings.dormantFloorMinutes = 0;
  assert.equal(saveViewSettings(storage, settings), true);
  assert.equal(readViewSettings(storage).dormantFloorMinutes, 0, 'choosing to keep every floor survives a reload');
  assert.equal(readViewSettings({ getItem() { return JSON.stringify({ labels: false }); } }).dormantFloorMinutes, 60, 'older saved settings gain the default');
});

test('the first, hour-based limit of a day is not carried over, so its saved default cannot keep a crowded building', () => {
  let stored = JSON.stringify({ labels: false, dormantFloorHours: 24 });
  const storage = { getItem() { return stored; }, setItem(_key, value) { stored = value; } };
  const settings = readViewSettings(storage);
  assert.equal(settings.dormantFloorMinutes, 60);
  assert.equal(Object.hasOwn(settings, 'dormantFloorHours'), false);
  assert.equal(saveViewSettings(storage, settings), true);
  assert.equal(Object.hasOwn(JSON.parse(stored), 'dormantFloorHours'), false);
});

test('the building shows at most eight floors by default, and only the offered floor limits are kept', () => {
  assert.equal(normalizeViewSettings(null).maxFloors, 8);
  for (const floors of [0, 4, 6, 8, 10, 12]) assert.equal(normalizeViewSettings({ maxFloors: floors }).maxFloors, floors);
  for (const invalid of [null, '', false, '6', 1, 7, -8, 8.5, NaN, Infinity, [8], {}]) {
    assert.equal(normalizeViewSettings({ maxFloors: invalid }).maxFloors, 8, String(invalid));
  }
  let stored;
  const storage = { getItem() { return stored ?? null; }, setItem(_key, value) { stored = value; } };
  const settings = readViewSettings(storage);
  settings.maxFloors = 0;
  assert.equal(saveViewSettings(storage, settings), true);
  assert.equal(readViewSettings(storage).maxFloors, 0, 'choosing no floor limit survives a reload');
});
