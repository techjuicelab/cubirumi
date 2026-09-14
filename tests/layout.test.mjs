import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_OFFICE_AGENTS, officeBounds, seatPosition, routeBetweenSeats, routeToApproval, approvalSpot } from '../src/office-layout.ts';

function crossesDesk(a, b, index) {
  const seat = seatPosition(index);
  const deskZ = seat.z + (index === 0 ? 1.12 : -1.12);
  const minX = seat.x - 1.975, maxX = seat.x + 1.975;
  const minZ = deskZ - .925, maxZ = deskZ + .925;
  if (Math.abs(a.x - b.x) < .0001) {
    return a.x > minX && a.x < maxX && Math.max(a.z, b.z) > minZ && Math.min(a.z, b.z) < maxZ;
  }
  assert.ok(Math.abs(a.z - b.z) < .0001, 'all walking segments use the marked orthogonal aisles');
  return a.z > minZ && a.z < maxZ && Math.max(a.x, b.x) > minX && Math.min(a.x, b.x) < maxX;
}

test('one to 512 observed workers fit persistent five-column rows and a separate owner wing', () => {
  assert.equal(MAX_OFFICE_AGENTS, 512);
  for (const count of [1, 6, 12, 30, 60, 513]) {
    const bounds = officeBounds(count);
    const locations = new Set();
    for (let index = 0; index < count; index++) {
      const seat = seatPosition(index);
      assert.ok(seat.x - 2 >= bounds.minX && seat.x + 2 <= bounds.maxX);
      assert.ok(seat.z - 2 >= bounds.minZ && seat.z + 2 <= bounds.maxZ);
      locations.add(`${seat.x}/${seat.z}`);
    }
    assert.equal(locations.size, count);
  }
  assert.ok(seatPosition(0).x < seatPosition(1).x - 8);
  assert.equal(seatPosition(1).x, seatPosition(6).x);
  assert.equal(seatPosition(6).z - seatPosition(1).z, 5.45);
});

test('handoffs between the owner and distant rows never cross any desk footprint', () => {
  const seats = [0, 1, 2, 5, 6, 12, 30, 60, 256, 512];
  for (const from of seats) for (const to of seats) {
    if (from === to) continue;
    const route = routeBetweenSeats(from, to);
    assert.deepEqual(route[0], { x: seatPosition(from).x, z: seatPosition(from).z });
    for (let segment = 1; segment < route.length; segment++) {
      for (let desk = 0; desk <= 512; desk++) {
        assert.equal(crossesDesk(route[segment - 1], route[segment], desk), false,
          `route ${from} -> ${to}, segment ${segment}, desk ${desk}`);
      }
    }
  }
});

test('nine consultation spots are unique and every approach stays outside desks and the owner glass wall', () => {
  const spots = new Set();
  for (let slot = 0; slot < 9; slot++) {
    const spot = approvalSpot(slot);
    spots.add(`${spot.x}/${spot.z}`);
    assert.ok(spot.x < -6.15 && spot.z > -1.1 && spot.z < 3.5);
    for (const from of [1, 5, 6, 30, 60, 512]) {
      const route = routeToApproval(from, slot);
      assert.deepEqual(route.at(-1), spot);
      for (let segment = 1; segment < route.length; segment++) {
        const a = route[segment - 1], b = route[segment];
        for (let desk = 0; desk <= 512; desk++) assert.equal(crossesDesk(a, b, desk), false);
        if (Math.min(a.x, b.x) < -6.15 && Math.max(a.x, b.x) > -6.15) assert.ok(a.z > -3, 'the reception doorway bypasses the glass');
      }
    }
  }
  assert.equal(spots.size, 9);
});
