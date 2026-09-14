export const CAMERA_LIMITS = { minZoom: .45, maxZoom: 4, minElevation: .2, maxElevation: 1.42 } as const;

export function clampZoom(value: number): number {
  return Math.max(CAMERA_LIMITS.minZoom, Math.min(CAMERA_LIMITS.maxZoom, Number.isFinite(value) ? value : 1));
}

export function orbitAngles(yaw: number, elevation: number, dx: number, dy: number): { yaw: number; elevation: number } {
  const turn = Math.PI * 2;
  // Wrapping prevents precision loss after hours of rotation without limiting the view angle.
  const nextYaw = yaw - dx * .005;
  return {
    yaw: ((nextYaw + Math.PI) % turn + turn) % turn - Math.PI,
    elevation: Math.max(CAMERA_LIMITS.minElevation, Math.min(CAMERA_LIMITS.maxElevation, elevation + dy * .004)),
  };
}

type Contact = { x: number; y: number; startX: number; startY: number; moved: boolean; pan: boolean };
export type CameraGesture = { orbitX: number; orbitY: number; panX: number; panY: number; zoomRatio: number };

/** Pointer bookkeeping is independent of the DOM so interrupted gestures can be exercised directly. */
export class CameraPointers {
  private readonly contacts = new Map<number, Contact>();

  get ids(): number[] { return [...this.contacts.keys()]; }
  get active(): boolean { return this.contacts.size > 0; }
  has(id: number): boolean { return this.contacts.has(id); }

  begin(id: number, x: number, y: number, pan = false): void {
    this.contacts.set(id, { x, y, startX: x, startY: y, moved: pan, pan });
    if (this.contacts.size > 1) for (const contact of this.contacts.values()) contact.moved = true;
  }

  move(id: number, x: number, y: number): CameraGesture | null {
    const contact = this.contacts.get(id);
    if (!contact) return null;
    const pair = [...this.contacts.values()].slice(0, 2);
    const first = pair[0]!;
    const second = pair[1];
    const beforeX = second ? (first.x + second.x) / 2 : first.x;
    const beforeY = second ? (first.y + second.y) / 2 : first.y;
    const beforeDistance = second ? Math.hypot(first.x - second.x, first.y - second.y) : 0;
    const dx = x - contact.x;
    const dy = y - contact.y;
    contact.x = x;
    contact.y = y;
    if (Math.hypot(x - contact.startX, y - contact.startY) > 5) contact.moved = true;
    if (second) {
      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      return { orbitX: 0, orbitY: 0,
        panX: (first.x + second.x) / 2 - beforeX, panY: (first.y + second.y) / 2 - beforeY,
        zoomRatio: beforeDistance > 2 && distance > 2 ? distance / beforeDistance : 1 };
    }
    if (!contact.moved) return null;
    return { orbitX: contact.pan ? 0 : dx, orbitY: contact.pan ? 0 : dy,
      panX: contact.pan ? dx : 0, panY: contact.pan ? dy : 0, zoomRatio: 1 };
  }

  end(id: number): boolean {
    const contact = this.contacts.get(id);
    const click = !!contact && !contact.moved && this.contacts.size === 1;
    this.contacts.delete(id);
    // Releasing one finger cannot turn the remaining half of a pinch into an accidental click.
    for (const remaining of this.contacts.values()) {
      remaining.startX = remaining.x;
      remaining.startY = remaining.y;
      remaining.moved = true;
    }
    return click;
  }

  cancel(): number[] {
    const ids = this.ids;
    this.contacts.clear();
    return ids;
  }
}
