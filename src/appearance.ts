/**
 * One stable look per agent id, shared by the 3D office, the distant LOD, the building view and card portraits.
 * A look never follows a desk: compaction, re-entry or figure reuse must not give a person another face.
 */
export type Variation = 0 | 1 | 2 | 3 | 4 | 5;
export type Glasses = 'none' | 'round' | 'square';
export type Headwear = 'cap-bangs' | 'buns' | 'curly' | 'ponytail' | 'small-cap' | 'beanie';
export type Outfit = 'boss-turtleneck' | 'plain' | 'round-collar-lanyard' | 'round-collar' | 'hoodie' | 'vest-watch' | 'check-shirt';
export interface Appearance {
  isBoss: boolean;
  variation: Variation;
  skin: string;
  hair: string;
  /** Default only: a reported agent.color still paints the actual shirt. */
  seatShirt: string;
  glasses: Glasses;
  headwear: Headwear;
  headphones: boolean;
  outfit: Outfit;
}
type SeatLook = Omit<Appearance, 'isBoss' | 'variation'>;

export const BOSS_ID = 'boss';
export const VARIATION_COUNT = 6;
/** The owner's minimal look: dark navy turtleneck, jeans, thin round glasses and white sneakers. */
export const BOSS_SHIRT = '#31495e';

/** Index = variation. The same table dresses seat furniture (chair, mug) through seatPosition. */
export const SEAT_LOOKS: readonly Readonly<SeatLook>[] = Object.freeze([
  { seatShirt: '#97b3a2', skin: '#f0c29e', hair: '#4d4035', glasses: 'none', headwear: 'cap-bangs', headphones: false, outfit: 'plain' },
  { seatShirt: '#b6a4d4', skin: '#efc5a4', hair: '#594943', glasses: 'none', headwear: 'buns', headphones: false, outfit: 'round-collar-lanyard' },
  // Seat 2 gave its turtleneck and round glasses to the owner: round collar and square frames instead.
  { seatShirt: '#e2bd6f', skin: '#b17d60', hair: '#49372f', glasses: 'square', headwear: 'curly', headphones: false, outfit: 'round-collar' },
  { seatShirt: '#e1a38f', skin: '#f2c6a8', hair: '#794e3e', glasses: 'none', headwear: 'ponytail', headphones: false, outfit: 'hoodie' },
  { seatShirt: '#91b9ce', skin: '#e3ad89', hair: '#363c3c', glasses: 'round', headwear: 'small-cap', headphones: true, outfit: 'vest-watch' },
  { seatShirt: '#a9bd88', skin: '#edc0a1', hair: '#5d4840', glasses: 'none', headwear: 'beanie', headphones: false, outfit: 'check-shirt' },
].map(look => Object.freeze(look as SeatLook)));

const SEAT_APPEARANCES: readonly Appearance[] = SEAT_LOOKS.map((look, variation) =>
  Object.freeze({ ...look, isBoss: false, variation: variation as Variation }));
const BOSS_APPEARANCE: Appearance = Object.freeze({
  ...SEAT_LOOKS[0]!, isBoss: true, variation: 0, seatShirt: BOSS_SHIRT, glasses: 'round', outfit: 'boss-turtleneck',
});

/** FNV-1a over code points with a murmur3 finalizer, so sequential ids ("agent-1", "agent-2") still spread evenly. */
export function appearanceHash(agentId: string): number {
  let hash = 2166136261;
  for (const character of agentId) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  hash ^= hash >>> 16; hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13; hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/** Shared frozen objects: read them, never mutate them. */
export function appearanceFor(agentId: string): Appearance {
  if (agentId === BOSS_ID) return BOSS_APPEARANCE;
  return SEAT_APPEARANCES[appearanceHash(agentId) % VARIATION_COUNT]!;
}

/** Two ids with the same key render identically, so a reused figure only needs new parts when the key changes. */
export function appearanceKey(appearance: Appearance): string {
  return appearance.isBoss ? BOSS_ID : `seat-${appearance.variation}`;
}
