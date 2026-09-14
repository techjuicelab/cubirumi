import test from 'node:test';
import assert from 'node:assert/strict';
import { officeBounds } from '../src/office-layout.ts';
import { estimateTextWidth, fitNameLabel, routerReconnectFlash, ROUTER_FLASH_SECONDS, ROUTER_PULSE_GAP_SECONDS, windowLightAt, WINDOW_LIGHT,
  registerOwnerClick, OWNER_ACTION_RANK, OWNER_ACTION_SECONDS, CALL_ENTER_SECONDS, CALL_TURN_RADIANS, CALL_WAVE_BARS, CALL_WAVE_STEP_SECONDS,
  callWaveLevel } from '../src/office-effects.ts';

test('owner clicks ask for a chair spin only on the fifth click within three seconds', () => {
  let times = [];
  for (const at of [10, 10.5, 11, 11.5]) {
    const result = registerOwnerClick(times, at);
    times = result.times;
    assert.equal(result.spin, false);
  }
  const fifth = registerOwnerClick(times, 12);
  assert.equal(fifth.spin, true);
  assert.deepEqual(fifth.times, [], 'a spin starts a new count');
  let spins = 0;
  times = [];
  for (let at = 20; at < 30; at += 1) {
    const result = registerOwnerClick(times, at);
    times = result.times; spins += Number(result.spin);
  }
  assert.equal(spins, 0, 'clicks a second apart never reach five within three seconds');
  let edge = [10, 10.75, 11.5, 12.25];
  assert.equal(registerOwnerClick(edge, 12.99).spin, true);
  assert.equal(registerOwnerClick(edge, 13).spin, false, 'a click exactly three seconds old has left the window');
  assert.deepEqual(registerOwnerClick([1, 2, 3, 4.5], 7).times, [4.5, 7]);
  assert.deepEqual(registerOwnerClick([8, Number.NaN], 7).times, [7], 'future and malformed times are dropped');
  edge = [1];
  assert.deepEqual(registerOwnerClick(edge, Number.NaN), { times: [1], spin: false });
  assert.deepEqual(edge, [1], 'the input is never modified');
});

test('owner moments keep the agreed order and durations', () => {
  assert.deepEqual(Object.entries(OWNER_ACTION_RANK).sort((a, b) => b[1] - a[1]).map(([kind]) => kind), ['finish', 'instruct', 'click', 'spin']);
  assert.equal(OWNER_ACTION_RANK.click, OWNER_ACTION_RANK.spin);
  assert.equal(OWNER_ACTION_SECONDS.click, 1.4, 'decision 45: about 1.4s click reaction');
});

test('the owner-only room reserves one desk column, so the first worker keeps the room size', () => {
  assert.equal(officeBounds(1).maxX, 3.6);
  assert.deepEqual(officeBounds(2), officeBounds(1));
  assert.equal(officeBounds(3).maxX, 5.85 + 3.6);
  assert.equal(officeBounds(6).maxX, 4 * 5.85 + 3.6);
  assert.equal(officeBounds(513).maxX, officeBounds(6).maxX);
  // A whiteboard tray reaching x 3.15 always fits the minimum wall.
  assert.ok(officeBounds(1).maxX >= 2 + 2.3 / 2);
});

test('window light switches at 06, 10, 17 and 20 local time with ten-minute blends from the previous period', () => {
  const at = (hour, minute, smooth) => windowLightAt(hour * 60 + minute, smooth);
  assert.deepEqual(at(5, 59), { from: 'evening', to: 'night', blend: 1 });
  assert.deepEqual(at(6, 0), { from: 'night', to: 'morning', blend: 0 });
  assert.deepEqual(at(6, 5), { from: 'night', to: 'morning', blend: .5 });
  assert.deepEqual(at(6, 10), { from: 'night', to: 'morning', blend: 1 });
  assert.deepEqual(at(10, 0), { from: 'morning', to: 'day', blend: 0 });
  assert.deepEqual(at(16, 59), { from: 'morning', to: 'day', blend: 1 });
  assert.deepEqual(at(17, 3), { from: 'day', to: 'evening', blend: .3 });
  assert.deepEqual(at(20, 0), { from: 'evening', to: 'night', blend: 0 });
  assert.deepEqual(at(23, 59), { from: 'evening', to: 'night', blend: 1 });
  assert.deepEqual(at(6, 1, false), { from: 'night', to: 'morning', blend: 1 }, 'without ambient motion a boundary switches at once');
  assert.deepEqual(windowLightAt(-1), at(23, 59));
  assert.deepEqual(windowLightAt(24 * 60), at(0, 0));
  assert.deepEqual(windowLightAt(6 * 60 + 5.9), at(6, 5), 'only whole minutes change the light');
  assert.equal(windowLightAt(Number.NaN).to, 'day');
  for (const period of Object.values(WINDOW_LIGHT)) {
    assert.match(period.glass, /^#[\da-f]{6}$/);
    assert.ok(period.patchOpacity > 0 && period.patchOpacity <= .5);
  }
});

test('reconnection blinks twice and single event flashes are short and at most twice per second', () => {
  assert.equal(ROUTER_FLASH_SECONDS, .15);
  assert.ok(1 / ROUTER_PULSE_GAP_SECONDS <= 2);
  const samples = [-.01, 0, .1, .15, .2, .3, .4, .45, .5, .6, 5].map(routerReconnectFlash);
  assert.deepEqual(samples, [false, true, true, false, false, true, true, false, false, false, false]);
  assert.equal(routerReconnectFlash(Number.POSITIVE_INFINITY), false);
});

test('name labels keep the suffix whole, shorten long names at the end and never split a character', () => {
  const measure = text => [...text].length * 10;
  assert.equal(fitNameLabel('Example Studio', '대표실', 200, measure), 'Example Studio 대표실');
  assert.equal(fitNameLabel('   ', '대표실', 200, measure), '대표실');
  assert.equal(fitNameLabel(' 우리   회사 ', '대표실', 200, measure), '우리 회사 대표실');
  assert.equal(fitNameLabel('a\u0000b\u0007c', '대표', 200, measure), 'abc 대표');
  const long = fitNameLabel('가나다라마바사아자차카타파하', '대표실', 100, measure);
  assert.equal(long, '가나다라마… 대표실');
  assert.ok(measure(long) <= 100);
  assert.equal(fitNameLabel('가나다라', '대표실', 30, measure), '… 대표실', 'an impossible width still keeps the suffix');
  assert.equal(fitNameLabel('😀😀😀😀😀', '대표', 60, measure), '😀😀… 대표');
  assert.equal(fitNameLabel('<img src=x onerror=alert(1)>', '대표', 1000, measure), '<img src=x onerror=alert(1)> 대표', 'markup is plain canvas text');
});

test('text width estimates treat Hangul as full width and Latin as about half', () => {
  assert.equal(estimateTextWidth('대표', 40), 80);
  assert.ok(Math.abs(estimateTextWidth('TJ', 40) - 44.8) < 1e-9);
  assert.equal(estimateTextWidth('', 40), 0);
});

test('call motion uses the agreed timings and a nine-bar waveform that is still or steps deterministically', () => {
  assert.equal(CALL_ENTER_SECONDS, .6);
  assert.equal(CALL_WAVE_STEP_SECONDS, .4);
  assert.ok(Math.abs(Math.abs(CALL_TURN_RADIANS) * 180 / Math.PI - 20) < 1, 'the chair turns about 20°');
  assert.equal(CALL_WAVE_BARS.length, 9);
  assert.equal(Math.max(...CALL_WAVE_BARS), 1);
  assert.deepEqual(CALL_WAVE_BARS.map((_, bar) => callWaveLevel(bar, -1)), CALL_WAVE_BARS, 'the still waveform follows the design');
  assert.deepEqual(CALL_WAVE_BARS.map((_, bar) => callWaveLevel(bar, NaN)), CALL_WAVE_BARS);
  const patterns = new Set();
  for (let step = 0; step < 40; step++) {
    const levels = CALL_WAVE_BARS.map((_, bar) => callWaveLevel(bar, step));
    assert.ok(levels.every(level => level >= .18 && level <= 1), `step ${step}: ${levels}`);
    assert.deepEqual(levels, CALL_WAVE_BARS.map((_, bar) => callWaveLevel(bar, step)), 'a step always draws the same heights');
    patterns.add(levels.map(level => level.toFixed(3)).join());
  }
  assert.ok(patterns.size > 30, 'the heights change from step to step');
  assert.equal(callWaveLevel(9, 3), callWaveLevel(0, 3), 'bar indices wrap');
  assert.equal(callWaveLevel(-1, 3), callWaveLevel(8, 3));
});
