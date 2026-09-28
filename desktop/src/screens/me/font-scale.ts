/**
 * Runtime application of the two font-scale settings.
 *
 * `styles/tokens.css` declares the type steps in `rem`, so scaling the app is
 * a matter of rewriting the custom properties on `<html>` — every component
 * already reads them through `var()`, and nothing has to re-render. The values
 * are read back from the stylesheet the first time (so tokens.css stays the
 * source of truth for the *unscaled* sizes) and only fall back to the literals
 * below if the sheet has not applied yet.
 *
 * The last applied scales are mirrored into `localStorage` because the DB is
 * only reachable asynchronously: `screens/me/index.tsx` applies that mirror at
 * module load — before React paints — so a fresh launch shows the reader's
 * chosen size instead of the default one. The Me screens then re-apply the
 * authoritative value from the `settings` table.
 */

const UI_TOKENS = [
  '--fs-100',
  '--fs-200',
  '--fs-300',
  '--fs-400',
  '--fs-500',
  '--fs-600',
  '--fs-700',
  '--fs-800',
  '--fs-900',
] as const;

/** Quran-script tokens scale with `quranFontScale`, not with the chrome scale. */
const QURAN_TOKENS = ['--mushaf-size', '--arabic-size'] as const;

/** Matches `styles/tokens.css`; used only when the sheet cannot be read. */
const FALLBACK: Readonly<Record<string, number>> = {
  '--fs-100': 0.75,
  '--fs-200': 0.8125,
  '--fs-300': 0.875,
  '--fs-400': 0.9375,
  '--fs-500': 1,
  '--fs-600': 1.125,
  '--fs-700': 1.375,
  '--fs-800': 1.75,
  '--fs-900': 2.25,
  '--mushaf-size': 2,
  '--arabic-size': 1.375,
};

export const FONT_SCALE_CACHE = 'quran.fontScale';
export const QURAN_FONT_SCALE_CACHE = 'quran.quranFontScale';

type TokenName = (typeof UI_TOKENS)[number] | (typeof QURAN_TOKENS)[number];
type Base = { value: number; unit: string };

let captured: Map<TokenName, Base> | null = null;

function parsePxish(raw: string, fallback: number): Base {
  const match = /^\s*(\d*\.?\d+)\s*(rem|em|px)\s*$/.exec(raw);
  if (!match) return { value: fallback, unit: 'rem' };
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return { value: fallback, unit: 'rem' };
  return { value, unit: match[2] ?? 'rem' };
}

/** Read the unscaled token values once, before any override is applied. */
function captureBase(): Map<TokenName, Base> {
  const styles = getComputedStyle(document.documentElement);
  const read = (name: TokenName): Base =>
    parsePxish(styles.getPropertyValue(name) ?? '', FALLBACK[name] ?? 1);
  const map = new Map<TokenName, Base>();
  for (const name of UI_TOKENS) map.set(name, read(name));
  for (const name of QURAN_TOKENS) map.set(name, read(name));
  return map;
}

function clampScale(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(max, Math.max(min, value));
}

/**
 * Apply both scales to `<html>`. `1` removes the override so the stylesheet
 * value shows through again, which keeps the devtools view honest.
 */
export function applyFontScales(uiScale: number, quranScale: number): void {
  captured ??= captureBase();
  const root = document.documentElement;
  const ui = clampScale(uiScale, 0.5, 3);
  const quran = clampScale(quranScale, 0.5, 4);
  for (const [scale, names] of [
    [ui, UI_TOKENS as readonly TokenName[]],
    [quran, QURAN_TOKENS as readonly TokenName[]],
  ] as const) {
    for (const name of names) {
      const base = captured.get(name);
      if (!base) continue;
      if (Math.abs(scale - 1) < 1e-6) root.style.removeProperty(name);
      else root.style.setProperty(name, `${Number((base.value * scale).toFixed(4))}${base.unit}`);
    }
  }
}

/** Remember the scales for the next launch's pre-paint pass. */
export function cacheFontScales(uiScale: number, quranScale: number): void {
  try {
    window.localStorage.setItem(FONT_SCALE_CACHE, String(uiScale));
    window.localStorage.setItem(QURAN_FONT_SCALE_CACHE, String(quranScale));
  } catch {
    /* storage disabled — the scale still applies for this session */
  }
}

/** Read a cached number, or null when nothing usable is stored. */
function cachedScale(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Pre-paint application from the cache; called once when the Me area loads. */
export function applyCachedFontScales(): void {
  const ui = cachedScale(FONT_SCALE_CACHE);
  const quran = cachedScale(QURAN_FONT_SCALE_CACHE);
  if (ui === null && quran === null) return;
  applyFontScales(ui ?? 1, quran ?? 1);
}
