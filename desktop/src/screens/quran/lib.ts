/**
 * Small pure helpers shared by the Quran reader screens.
 *
 * Nothing here touches the gateway or the DOM: verse-key maths and parameter
 * parsing are the two places where a hash path can hand the UI garbage
 * (`/quran/surah/999`, `/quran/ayah/abc`), so the guard lives in one file and
 * every screen uses it.
 */
import { JUZ_COUNT, PAGE_COUNT, SURAH_COUNT, declaredPlacement, parseVerseKey } from '@quran/core';
import type { AyahWord, LayoutWord, RevelationPlace, VerseKey } from '@quran/core';

import type { Tr } from '../../app/app-state';

export { JUZ_COUNT, PAGE_COUNT, SURAH_COUNT, parseVerseKey };
export type { LayoutWord };

/** A `:number`/`:juz`/`:pageNumber` segment as a bounded integer, or null. */
export function asInt(raw: string | undefined, min: number, max: number): number | null {
  if (raw === undefined || raw === '') return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

/** A `:verseKey` segment (`112:1`) as a `VerseKey`, or null when malformed. */
export function asVerseKey(raw: string | undefined): VerseKey | null {
  if (raw === undefined) return null;
  const parsed = parseVerseKey(raw);
  if (!parsed) return null;
  if (parsed.chapter < 1 || parsed.chapter > SURAH_COUNT) return null;
  if (parsed.verse < 1) return null;
  return `${parsed.chapter}:${parsed.verse}` as VerseKey;
}

export function keyOf(chapter: number, verse: number): VerseKey {
  return `${chapter}:${verse}` as VerseKey;
}

/**
 * The mushaf grid slot a word row declares, through the core layout engine's own
 * reader (it accepts both camelCase and the pack's snake_case spellings). The
 * contract `AyahWord` has no page or line field, so a row that carries none
 * simply reports `null` — the page screen then says the columns are missing
 * instead of inventing a layout.
 */
export function declaredOf(word: AyahWord): { page: number | null; line: number | null } {
  return declaredPlacement(word as LayoutWord);
}

export function chapterOf(key: VerseKey): number {
  return parseVerseKey(key)?.chapter ?? 0;
}

export function verseOf(key: VerseKey): number {
  return parseVerseKey(key)?.verse ?? 0;
}

export function revelationLabel(tr: Tr, place: RevelationPlace): string {
  return place === 'makkah' ? tr('مکی', 'Makkan') : tr('مدنی', 'Madinan');
}

/**
 * Language-appropriate surah meaning. `null` when the pack has none — a missing
 * translation is stated as missing, never filled in. `rtl` tells the caller
 * which typographic column the string belongs to.
 */
export function surahMeaning(
  lang: 'fa' | 'en',
  surah: { translationFa: string | null; translationEn: string | null },
): { text: string; rtl: boolean } | null {
  const primary = nonEmpty(lang === 'fa' ? surah.translationFa : surah.translationEn);
  const secondary = nonEmpty(lang === 'fa' ? surah.translationEn : surah.translationFa);
  if (primary) return { text: primary, rtl: lang === 'fa' };
  if (secondary) return { text: secondary, rtl: lang === 'en' };
  return null;
}

function nonEmpty(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** The mushaf's own end-of-ayah sign sits in the word rows, not the ayah text. */
export function licenseLabel(tr: Tr, status: 'clear' | 'attribution-required' | 'unresolved'): string {
  if (status === 'clear') return tr('مجوز روشن', 'Clear');
  if (status === 'attribution-required') return tr('نیازمند ذکر منبع', 'Attribution required');
  return tr('مجوز نامشخص', 'Licence unresolved');
}

export function licenseTone(status: 'clear' | 'attribution-required' | 'unresolved'): 'neutral' | 'warn' | 'danger' {
  if (status === 'clear') return 'neutral';
  return status === 'attribution-required' ? 'warn' : 'danger';
}

/** Scroll one ayah into view without jumping the whole document. */
export function scrollAyahIntoView(verseKey: VerseKey): boolean {
  const selector = `[data-verse-key="${CSS.escape(verseKey)}"]`;
  const node = document.querySelector<HTMLElement>(selector);
  if (!node) return false;
  node.scrollIntoView({ behavior: 'auto', block: 'start' });
  return true;
}

/**
 * Fraction of the document already scrolled, 0..1. `1` for a page that does
 * not overflow, where a fraction would otherwise divide by zero.
 */
export function scrollFraction(): number {
  const doc = document.documentElement;
  const max = doc.scrollHeight - doc.clientHeight;
  if (max <= 0) return 1;
  return Math.max(0, Math.min(1, doc.scrollTop / max));
}

/**
 * Copy the ayah text out of the app. The webview clipboard API is preferred and
 * the legacy selection path is the fallback; `false` means nothing was copied,
 * which the caller reports instead of pretending success.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the selection path */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.setAttribute('aria-hidden', 'true');
    area.style.position = 'fixed';
    area.style.insetInlineStart = '0';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
