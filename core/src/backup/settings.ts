/**
 * Typed application settings registry.
 *
 * A backup file carries a free-form `settings` record. It must never be able
 * to inject an arbitrary key into the app: every key is checked against this
 * allowlist, and every value is coerced and range-checked against the key's
 * declared type before the app sees it. Anything unknown or malformed is
 * dropped (and reported), never silently stored.
 *
 * To add a setting: append a `SettingDef` to `SETTING_DEFS` with a unique
 * key. Restoring, validating and the desktop settings screen all pick it up
 * from this single source of truth.
 */

export type SettingPrimitive = string | number | boolean;

export type SettingDef =
  | { key: string; type: 'enum'; choices: readonly string[]; default: string; label: string }
  | { key: string; type: 'number'; default: number; min: number; max: number; label: string }
  | { key: string; type: 'boolean'; default: boolean; label: string }
  | { key: string; type: 'string'; default: string; pattern?: RegExp; max: number; label: string };

const PACK_ID_RE = /^$|^[a-z0-9][a-z0-9._-]{0,63}$/;

export const SETTING_DEFS: readonly SettingDef[] = [
  {
    key: 'theme',
    type: 'enum',
    choices: ['light', 'dark', 'system'] as const,
    default: 'system',
    label: 'Colour theme',
  },
  {
    key: 'interfaceLanguage',
    type: 'enum',
    choices: ['fa', 'en'] as const,
    default: 'fa',
    label: 'Interface language',
  },
  {
    key: 'translationPack',
    type: 'string',
    default: '',
    pattern: PACK_ID_RE,
    max: 64,
    label: 'Preferred translation pack id (empty = none)',
  },
  {
    key: 'readingMode',
    type: 'enum',
    choices: ['mushaf', 'ayah'] as const,
    default: 'mushaf',
    label: 'Mushaf page vs scrolling ayah mode',
  },
  {
    key: 'fontScale',
    type: 'number',
    default: 1,
    min: 0.5,
    max: 3,
    label: 'Global font scale',
  },
  {
    key: 'quranFontScale',
    type: 'number',
    default: 1,
    min: 0.5,
    max: 4,
    label: 'Quran text font scale',
  },
  {
    key: 'hifzSessionNewItemTarget',
    type: 'number',
    default: 3,
    min: 0,
    max: 50,
    label: 'Hifz session: new ayahs to attempt per session',
  },
  {
    key: 'hifzSessionReviewCap',
    type: 'number',
    default: 20,
    min: 0,
    max: 200,
    label: 'Hifz session: review items cap per session',
  },
  {
    key: 'hifzSessionDefaultMode',
    type: 'enum',
    choices: ['segment', 'full-ayah', 'full-sequence', 'transition', 'random'] as const,
    default: 'segment',
    label: 'Hifz session: default recall mode',
  },
  {
    key: 'hifzAutoAudio',
    type: 'boolean',
    default: false,
    label: 'Hifz session: play audio before recall prompts',
  },
];

const BY_KEY = new Map(SETTING_DEFS.map((d) => [d.key, d]));

/** Every settings key the app accepts. Anything else in a file is rejected. */
export function settingKeys(): string[] {
  return [...BY_KEY.keys()];
}

export function settingDef(key: string): SettingDef | undefined {
  return BY_KEY.get(key);
}

export function defaultSettings(): Record<string, SettingPrimitive> {
  const out: Record<string, SettingPrimitive> = {};
  for (const def of SETTING_DEFS) out[def.key] = def.default;
  return out;
}

export type CoerceResult =
  | { ok: true; value: SettingPrimitive }
  | { ok: false; reason: string };

/**
 * Coerce a raw (possibly stringly-typed, possibly hostile) value to the
 * declared type of `key`. DB layers store everything as TEXT, so numbers and
 * booleans may arrive as strings; we accept those, and nothing else.
 */
export function coerceSetting(key: string, raw: unknown): CoerceResult {
  const def = BY_KEY.get(key);
  if (!def) return { ok: false, reason: `unknown setting key "${key}"` };
  switch (def.type) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
      if (!Number.isFinite(n)) return { ok: false, reason: 'not a finite number' };
      if (n < def.min || n > def.max) return { ok: false, reason: `out of range ${def.min}..${def.max}` };
      return { ok: true, value: n };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (raw === 'true') return { ok: true, value: true };
      if (raw === 'false') return { ok: true, value: false };
      return { ok: false, reason: 'not a boolean' };
    }
    case 'enum': {
      if (typeof raw !== 'string' || !def.choices.includes(raw)) {
        return { ok: false, reason: `must be one of: ${def.choices.join(', ')}` };
      }
      return { ok: true, value: raw };
    }
    case 'string': {
      if (typeof raw !== 'string') return { ok: false, reason: 'not a string' };
      if (raw.length > def.max) return { ok: false, reason: `longer than ${def.max} characters` };
      // Control characters (including NUL) have no business in a setting.
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, reason: 'contains control characters' };
      if (def.pattern && !def.pattern.test(raw)) return { ok: false, reason: 'bad format' };
      return { ok: true, value: raw };
    }
  }
}

export interface SanitizeResult {
  /** Only allowlisted, coerced entries; unknown/invalid ones are dropped. */
  settings: Record<string, SettingPrimitive>;
  /** Allowlisted keys missing from the input, filled with their defaults. */
  defaulted: string[];
  /** Keys dropped, with the reason. */
  rejected: { key: string; reason: string }[];
}

/**
 * Filter a hostile/arbitrary record through the allowlist. Used by restore
 * (before writing the `settings` table) and by the app when reading settings
 * back from a backup.
 */
export function sanitizeSettings(
  record: Record<string, unknown>,
  opts: { applyDefaults?: boolean } = {},
): SanitizeResult {
  const settings: Record<string, SettingPrimitive> = {};
  const rejected: { key: string; reason: string }[] = [];
  for (const [key, raw] of Object.entries(record)) {
    const coerced = coerceSetting(key, raw);
    if (coerced.ok) settings[key] = coerced.value;
    else rejected.push({ key, reason: coerced.reason });
  }
  const defaulted: string[] = [];
  if (opts.applyDefaults) {
    for (const def of SETTING_DEFS) {
      if (!(def.key in settings)) {
        settings[def.key] = def.default;
        defaulted.push(def.key);
      }
    }
  }
  return { settings, defaulted, rejected };
}
