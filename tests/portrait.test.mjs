import test from 'node:test';
import assert from 'node:assert/strict';
import { appearanceFor, BOSS_SHIRT, SEAT_LOOKS } from '../src/appearance.ts';
import { STATUS_STYLE } from '../src/status-style.ts';
import { portraitSVG, portraitShirt, statusShapeSVG, normalizeHex, shade, tint } from '../src/portrait.ts';

const idFor = variation => {
  for (let index = 0; index < 500; index++) if (!appearanceFor(`portrait-${index}`).isBoss && appearanceFor(`portrait-${index}`).variation === variation) return `portrait-${index}`;
  throw new Error(`no id for variation ${variation}`);
};

test('portraits are drawn from the shared appearance record, so one id keeps one face', () => {
  for (const id of ['boss', 'planner', 'worker-live', 'claude:abc', ...[0, 1, 2, 3, 4, 5].map(idFor)]) {
    const look = appearanceFor(id);
    const svg = portraitSVG(id, '#80afcb');
    assert.equal(svg, portraitSVG(id, '#80afcb'), 'the same id and shirt always give the same markup');
    assert.match(svg, /^<svg class="portrait-art" viewBox="0 0 100 100" aria-hidden="true" focusable="false">/u);
    assert.ok(svg.includes(`fill="${look.skin}"`), `${id} uses its skin tone`);
    assert.ok(svg.includes(`fill="${look.hair}"`), `${id} uses its hair color`);
    assert.ok(svg.includes(`fill="${shade(look.skin, .9)}"`), 'the clay shadow is derived from the same skin');
  }
});

test('each seat look and the owner look draw their own distinguishing parts', () => {
  const boss = portraitSVG('boss', '#eab65e');
  assert.ok(boss.includes(`fill="${BOSS_SHIRT}"`), 'the owner always wears the navy turtleneck');
  assert.ok(!boss.includes('#eab65e'), 'a reported color does not repaint the owner look');
  assert.match(boss, /M41\.5 71\.5 L58\.5 71\.5/u, 'turtleneck ribs');
  assert.match(boss, /stroke="#31495e" stroke-width="1\.1"/u, 'thin navy round glasses');
  assert.doesNotMatch(boss, /r="5\.4"/u, 'the owner has a side part, not the seat bangs');

  const parts = [
    [0, [/r="5\.4"/u], [/<rect x="35\.2"/u, /stroke="#5b6455"/u]],
    [1, [/cx="21\.5" cy="59" r="7\.5"/u, /#8197ad/u], [/stroke="#5b6455"/u]],
    [2, [/<rect x="35\.2" y="43\.6" width="11\.6" height="9\.8" rx="2\.4"/u, /M39\.5 75\.5 Q50 83 60\.5 75\.5/u], [/<circle cx="41" cy="48\.5" r="5\.[58]"/u, /#8197ad/u]],
    [3, [/transform="rotate\(-16 78 60\)"/u, /#eed58e/u, /stroke-width="6"/u], [/stroke="#5b6455"/u]],
    [4, [/M21\.5 46 C20 7 80 7 78\.5 46/u, /r="5\.8" fill="#fffdf5" fill-opacity="\.14" stroke="#5b6455"/u, /#5f7d8f/u], [/<rect x="35\.2"/u]],
    [5, [/#9dbdaa/u, /rotate\(-32 80 44\)/u, /M19\.5 86 L80\.5 86/u], [/stroke="#5b6455"/u]],
  ];
  for (const [variation, present, absent] of parts) {
    const svg = portraitSVG(idFor(variation), SEAT_LOOKS[variation].seatShirt);
    for (const pattern of present) assert.match(svg, pattern, `variation ${variation} draws ${pattern}`);
    for (const pattern of absent) assert.doesNotMatch(svg, pattern, `variation ${variation} does not draw ${pattern}`);
  }
});

test('shirts follow the reported color only when it is a real hex value', () => {
  const id = idFor(1);
  assert.equal(portraitShirt(id, '#ABC'), '#aabbcc');
  assert.equal(portraitShirt(id, '#80afcb'), '#80afcb');
  for (const unsafe of ['red', '#12345', '#80afcb" onload="x', undefined]) {
    assert.equal(portraitShirt(id, unsafe), SEAT_LOOKS[1].seatShirt);
    assert.doesNotMatch(portraitSVG(id, unsafe), /onload|red"/u);
  }
  assert.equal(portraitShirt('boss', '#80afcb'), BOSS_SHIRT);
  assert.equal(normalizeHex('<b>'), undefined);
  assert.equal(shade('#97b3a2', .9), '#88a192');
  assert.equal(tint('#49372f', .12), '#5f4f48');
});

test('status shapes use the shared status table, so color is never the only cue', () => {
  const expected = { working: 'ring', thinking: 'dashed-ring', reviewing: 'dashed-ring', approval: 'diamond', error: 'triangle', done: 'check', idle: 'bar', waiting: 'bar' };
  for (const [status, shape] of Object.entries(expected)) {
    const svg = statusShapeSVG(status, 12);
    assert.equal(STATUS_STYLE[status].shape, shape);
    assert.match(svg, new RegExp(`data-shape="${shape}"`, 'u'));
    assert.ok(svg.includes(STATUS_STYLE[status].color), `${status} uses ${STATUS_STYLE[status].color}`);
    assert.match(svg, /width="12" height="12" aria-hidden="true"/u);
  }
  assert.match(statusShapeSVG('thinking'), /stroke-dasharray/u);
  assert.doesNotMatch(statusShapeSVG('working'), /stroke-dasharray/u);
  assert.match(statusShapeSVG('__proto__'), /data-shape="bar"/u, 'unknown status reads as quiet, never as work');
});
