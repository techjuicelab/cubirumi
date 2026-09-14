import { SEAT_LOOKS } from './appearance.ts';
export const MAX_OFFICE_AGENTS = 512;
export type FloorPoint = { x: number; z: number };

/**
 * Five seats per row: growing preserves desks; the scene compacts vacant seats when staff leave.
 * Seat colors only dress furniture (chair, mug); a person's look follows appearanceFor(agent.id).
 */
export function seatPosition(index: number) {
  const look = SEAT_LOOKS[index % SEAT_LOOKS.length]!;
  return { id: index === 0 ? 'boss' : `seat-${index}`,
    x: index === 0 ? -10 : ((index - 1) % 5) * 5.85,
    z: index === 0 ? -3.45 : -3.45 + Math.floor((index - 1) / 5) * 5.45,
    color: look.seatShirt, skin: look.skin, hair: look.hair };
}

export function officeBounds(capacity: number) {
  const workers = Math.max(0, Math.min(MAX_OFFICE_AGENTS, Math.floor(capacity) - 1));
  const columns = Math.min(5, workers);
  const rows = Math.max(1, Math.ceil(workers / 5));
  // The owner wing, reception, wall decor and right strip need one desk column of width even with no workers:
  // the first desk slot is reserved, so the first employee does not widen the room.
  const minX = -14.5, maxX = (Math.max(1, columns) - 1) * 5.85 + 3.6;
  const minZ = -7.85, maxZ = Math.max(6.5, -3.45 + (rows - 1) * 5.45 + 3.25);
  return { minX, maxX, minZ, maxZ, centerX: (minX + maxX) / 2, centerZ: (minZ + maxZ) / 2,
    width: maxX - minX, depth: maxZ - minZ };
}

const corridorX = -4.7;
export function routeBetweenSeats(from: number, to: number): FloorPoint[] {
  const a = seatPosition(from), b = seatPosition(to);
  const backA = a.z + (from === 0 ? 2.7 : 1.25), backB = b.z + (to === 0 ? 2.7 : 1.25);
  const exitA = a.x + (from === 0 ? 2.45 : 1.15), exitB = b.x + (to === 0 ? 2.45 : 1.15);
  const points = [{ x: a.x, z: a.z }, { x: exitA, z: a.z }, { x: exitA, z: backA }];
  if (Math.abs(backA - backB) > .01) points.push({ x: corridorX, z: backA }, { x: corridorX, z: backB });
  points.push({ x: exitB, z: backB }, { x: exitB, z: b.z + .45 });
  return points.filter((point, i, all) => i === 0 || point.x !== all[i - 1]!.x || point.z !== all[i - 1]!.z);
}

/** Approval visitors use the empty reception area, never the owner's chair or desk. */
export function approvalSpot(slot: number): FloorPoint {
  return { x: -11.5 + slot % 3 * 1.5, z: -.75 + Math.floor(slot / 3) * 1.35 };
}

export function routeToApproval(from: number, slot: number): FloorPoint[] {
  const a = seatPosition(from), spot = approvalSpot(slot);
  return [{ x: a.x, z: a.z }, { x: a.x + 1.15, z: a.z }, { x: a.x + 1.15, z: a.z + 1.25 }, { x: corridorX, z: a.z + 1.25 },
    { x: corridorX, z: spot.z }, spot];
}
