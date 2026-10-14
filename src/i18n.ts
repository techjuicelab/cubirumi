export type Language = 'en' | 'ko';

let language: Language = 'en';

/** Only explicit, supported choices are accepted; a first visit always starts in English. */
export function normalizeLanguage(value: unknown): Language {
  return value === 'ko' ? 'ko' : 'en';
}

export function getLanguage(): Language { return language; }
export function setLanguage(value: Language): void { language = normalizeLanguage(value); }
export function locale(): 'en-US' | 'ko-KR' { return language === 'ko' ? 'ko-KR' : 'en-US'; }

/** Interpolate plain text. Callers rendering HTML must escape any untrusted values. */
export function msg(english: string, korean: string, values: Record<string, string | number> = {}): string {
  return (language === 'ko' ? korean : english).replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g,
    (placeholder, key: string) => Object.hasOwn(values, key) ? String(values[key]) : placeholder);
}

export function localizedNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(locale(), options).format(value);
}
