import test from 'node:test';
import assert from 'node:assert/strict';
import { appearanceFor, appearanceHash, appearanceKey, SEAT_LOOKS, BOSS_ID, BOSS_SHIRT, VARIATION_COUNT } from '../src/appearance.ts';
import { seatPosition } from '../src/office-layout.ts';

test('the same agent id always receives the same shared, frozen look', () => {
  for (const id of ['planner', 'worker-live', 'claude:abc', '']) {
    assert.equal(appearanceFor(id), appearanceFor(id));
    assert.ok(Object.isFrozen(appearanceFor(id)));
  }
  // Pinned so a refactor cannot silently give every existing employee another face in 3D, cards and the building.
  assert.deepEqual(['boss', 'planner', 'designer', 'developer', 'reviewer', 'researcher', 'worker-live', 'claude:abc']
    .map(id => appearanceFor(id).variation), [0, 0, 5, 2, 5, 5, 2, 2]);
  assert.equal(appearanceHash('worker-live'), 3295042760);
  assert.ok(Number.isInteger(appearanceHash('')) && appearanceHash('') >= 0);
});

test('different ids spread evenly over all six looks, including sequential and session-like ids', () => {
  for (const make of [i => `agent-${i}`, i => `019${(Math.imul(i, 2654435761) >>> 0).toString(16)}-session-${i}`]) {
    const counts = Array(VARIATION_COUNT).fill(0);
    for (let i = 0; i < 6000; i++) counts[appearanceFor(make(i)).variation]++;
    for (const count of counts) assert.ok(count > 900 && count < 1100, `uneven look distribution ${counts}`);
  }
});

test('only the owner wears the owner look, and seat 2 gave up the turtleneck and round glasses', () => {
  const boss = appearanceFor(BOSS_ID);
  assert.deepEqual({ ...boss }, { isBoss: true, variation: 0, skin: SEAT_LOOKS[0].skin, hair: SEAT_LOOKS[0].hair,
    seatShirt: BOSS_SHIRT, glasses: 'round', headwear: 'cap-bangs', headphones: false, outfit: 'boss-turtleneck' });
  assert.equal(BOSS_SHIRT, '#31495e');
  assert.equal(appearanceKey(boss), 'boss');
  for (const id of ['Boss', ' boss', 'boss ', 'seat-0']) assert.equal(appearanceFor(id).isBoss, false, id);
  assert.ok(SEAT_LOOKS.every(look => look.outfit !== 'boss-turtleneck'));
  assert.equal(SEAT_LOOKS[2].outfit, 'round-collar');
  assert.equal(SEAT_LOOKS[2].glasses, 'square');
  const firstByVariation = new Map();
  for (let i = 0; i < 600; i++) {
    const look = appearanceFor(`agent-${i}`);
    assert.equal(look.isBoss, false);
    assert.equal(appearanceKey(look), `seat-${look.variation}`);
    // Ids sharing a variation share one frozen look, so nothing can be tweaked for one person only.
    if (!firstByVariation.has(look.variation)) firstByVariation.set(look.variation, look);
    assert.equal(look, firstByVariation.get(look.variation));
  }
  assert.equal(firstByVariation.size, VARIATION_COUNT);
});

test('seat looks keep the established palette, distinct silhouettes and seat-based furniture colors', () => {
  assert.equal(SEAT_LOOKS.length, VARIATION_COUNT);
  assert.ok(Object.isFrozen(SEAT_LOOKS) && SEAT_LOOKS.every(look => Object.isFrozen(look)));
  assert.deepEqual(SEAT_LOOKS.map(look => look.seatShirt), ['#97b3a2', '#b6a4d4', '#e2bd6f', '#e1a38f', '#91b9ce', '#a9bd88']);
  assert.deepEqual(SEAT_LOOKS.map(look => look.skin), ['#f0c29e', '#efc5a4', '#b17d60', '#f2c6a8', '#e3ad89', '#edc0a1']);
  assert.deepEqual(SEAT_LOOKS.map(look => look.hair), ['#4d4035', '#594943', '#49372f', '#794e3e', '#363c3c', '#5d4840']);
  assert.deepEqual(SEAT_LOOKS.map(look => look.headwear), ['cap-bangs', 'buns', 'curly', 'ponytail', 'small-cap', 'beanie']);
  assert.deepEqual(SEAT_LOOKS.map(look => look.outfit), ['plain', 'round-collar-lanyard', 'round-collar', 'hoodie', 'vest-watch', 'check-shirt']);
  assert.deepEqual(SEAT_LOOKS.map(look => look.glasses), ['none', 'none', 'square', 'none', 'round', 'none']);
  assert.deepEqual(SEAT_LOOKS.map(look => look.headphones), [false, false, false, false, true, false]);
  for (const look of SEAT_LOOKS) for (const color of [look.seatShirt, look.skin, look.hair]) assert.match(color, /^#[\da-f]{6}$/u);
  for (let index = 0; index < 18; index++) {
    const seat = seatPosition(index), look = SEAT_LOOKS[index % VARIATION_COUNT];
    assert.deepEqual([seat.color, seat.skin, seat.hair], [look.seatShirt, look.skin, look.hair], `seat ${index} furniture colors`);
  }
});
