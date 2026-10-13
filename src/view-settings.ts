export interface ViewSettings {
  labels: boolean;
  bubbles: boolean;
  autoRotate: boolean;
  followWork: boolean;
  cycle: boolean;
  cycleSeconds: number;
  powerSaving: boolean;
  /** Minutes a project floor may stay quiet before the building leaves it out; 0 keeps every floor. */
  dormantFloorMinutes: number;
  /** Most project floors the building shows, keeping the ones reported from most recently; 0 shows every floor. */
  maxFloors: number;
  reducedMotion: boolean;
  reducedMotionOverride: boolean | null;
}
export const VIEW_SETTINGS_KEY = 'agent-office.view.v1';
export const DORMANT_FLOOR_MINUTES = [0, 30, 60, 180, 360, 720, 1440, 4320, 10080];
export const MAX_FLOOR_CHOICES = [0, 4, 6, 8, 10, 12];
export function defaultViewSettings(reducedMotion = false): ViewSettings {
  return { labels: true, bubbles: true, autoRotate: true, followWork: true, cycle: true, cycleSeconds: 25, powerSaving: true, dormantFloorMinutes: 60, maxFloors: 8, reducedMotion, reducedMotionOverride: null };
}
export function normalizeViewSettings(value: unknown, reducedMotion = false): ViewSettings {
  const result = defaultViewSettings(reducedMotion);
  if (!value || typeof value !== 'object') return result;
  for (const key of ['labels', 'bubbles', 'autoRotate', 'followWork', 'cycle', 'powerSaving'] as const) {
    if (key in value && typeof (value as ViewSettings)[key] === 'boolean') result[key] = (value as ViewSettings)[key];
  }
  if ('reducedMotionOverride' in value) {
    if (typeof value.reducedMotionOverride === 'boolean') result.reducedMotionOverride = value.reducedMotionOverride;
  } else if ('reducedMotion' in value && typeof value.reducedMotion === 'boolean') {
    // Legacy settings did not record whether the value was inherited. Preserve it until the user chooses system defaults.
    result.reducedMotionOverride = value.reducedMotion;
  }
  result.reducedMotion = result.reducedMotionOverride ?? reducedMotion;
  if ('cycleSeconds' in value && [15, 25, 45, 60].includes(Number(value.cycleSeconds))) result.cycleSeconds = Number(value.cycleSeconds);
  if ('maxFloors' in value && typeof value.maxFloors === 'number' && MAX_FLOOR_CHOICES.includes(value.maxFloors)) result.maxFloors = value.maxFloors;
  if ('dormantFloorMinutes' in value && typeof value.dormantFloorMinutes === 'number' && DORMANT_FLOOR_MINUTES.includes(value.dormantFloorMinutes)) result.dormantFloorMinutes = value.dormantFloorMinutes;
  return result;
}
export function readViewSettings(storage: Pick<Storage, 'getItem'>, reducedMotion = false): ViewSettings {
  try { return normalizeViewSettings(JSON.parse(storage.getItem(VIEW_SETTINGS_KEY) ?? 'null'), reducedMotion); }
  catch { return defaultViewSettings(reducedMotion); }
}
export function saveViewSettings(storage: Pick<Storage, 'setItem'>, settings: ViewSettings): boolean {
  try {
    const saved = { ...normalizeViewSettings(settings) };
    const { reducedMotion: _inherited, ...preferences } = saved;
    storage.setItem(VIEW_SETTINGS_KEY, JSON.stringify(preferences)); return true;
  }
  catch { return false; }
}
