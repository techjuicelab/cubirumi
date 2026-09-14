export interface ViewSettings {
  labels: boolean;
  bubbles: boolean;
  autoRotate: boolean;
  followWork: boolean;
  cycle: boolean;
  cycleSeconds: number;
  powerSaving: boolean;
  reducedMotion: boolean;
  reducedMotionOverride: boolean | null;
}
export const VIEW_SETTINGS_KEY = 'agent-office.view.v1';
export function defaultViewSettings(reducedMotion = false): ViewSettings {
  return { labels: true, bubbles: true, autoRotate: true, followWork: true, cycle: true, cycleSeconds: 25, powerSaving: true, reducedMotion, reducedMotionOverride: null };
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
