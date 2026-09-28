/**
 * Corpus sources for the QA suite.
 *
 * Two kinds, deliberately kept apart:
 *
 * 1. `tests/fixtures/corpus-sample.json` — 31 real ayahs (orchestrator-owned,
 *    read-only for QA) with English + Persian translations. Small, fast, and
 *    the shared truth for refrain/similarity behaviour.
 * 2. `data/raw/quran-com/*.json` — the build-time provider captures
 *    (6236 ayahs, 114 chapters, per-verse juz/page/hizb divisions, word lists,
 *    per-chapter translation spot-checks). Used where a test or a measurement
 *    genuinely needs the whole mushaf.
 *
 * Nothing here invents content: mushaf metadata (juz, hizb, page) and word rows
 * come from the captured provider responses, and the authoritative text is
 * copied byte-for-byte. `word_count` and `normalized_hash` are recomputed with
 * `core/src/normalize/arabic.ts`, exactly as the pipeline does.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { Ayah, Surah, Translation, VerseKey } from '../../core/src/contracts/quran';
import { normalizedFingerprint, wordCount } from '../../core/src/normalize/arabic';
import { CORPUS_FIXTURE_PATH, RAW_MANIFEST_PATH, clearJsonCache, rawFile, readJsonIfExists } from './repo';

/**
 * Provider captures are parsed once per process (`readJsonIfExists` caches by
 * path) — several suites build the same fixture database and re-reading the
 * division and word files was the difference between a 3s and a 12s hook.
 */
export function clearRawCache(): void {
  clearJsonCache();
}

export interface FixtureAyah {
  verseKey: VerseKey;
  chapter: number;
  verse: number;
  textUthmani: string;
  translationEn: string;
  translationFa: string;
  normalized: string;
}

export interface CorpusFixture {
  generatedFrom: string;
  note: string;
  ayahs: FixtureAyah[];
}

/** Pack ids the pipeline assigns to the captured translation resources. */
export const TRANSLATION_PACKS = {
  85: { packId: 'tr-en-85', language: 'en', title: 'M.A.S. Abdel Haleem' },
  135: { packId: 'tr-fa-135', language: 'fa', title: 'Persian — IslamHouse' },
  29: { packId: 'tr-fa-29', language: 'fa', title: 'Persian — Hussein Taji Kal Dari' },
} as const;

export const TAFSIR_PACKS = {
  16: { packId: 'tafsir-ar-16', language: 'ar', title: 'Tafsir Muyassar' },
  169: { packId: 'tafsir-en-169', language: 'en', title: 'Ibn Kathir (English)' },
} as const;

export const CORE_PACK_ID = 'quran-core-uthmani';

/**
 * QA's own pack ids, keyed by provider resource id. The pipeline's real packs
 * are named differently (`content/index.json`: `tr-en-abdulhaleem`), so the
 * lookup lives here and in `packs.ts`, not in the app's code: an integration
 * test that seeds one of these ids can read it back out of whatever the app
 * wrote, without duplicating the table name or the column name.
 */
export const PACK_ID_BY_RESOURCE: Record<number, string> = {
  85: TRANSLATION_PACKS[85].packId,
  135: TRANSLATION_PACKS[135].packId,
  29: TRANSLATION_PACKS[29].packId,
  16: TAFSIR_PACKS[16].packId,
  169: TAFSIR_PACKS[169].packId,
};

export function packIdOfResource(resourceId: number): string {
  const id = PACK_ID_BY_RESOURCE[resourceId];
  if (!id) throw new Error(`packIdOfResource: no QA pack for provider resource ${resourceId}`);
  return id;
}

/** Translation pack metadata for any QA-registered resource id. */
export function translationPackOf(resourceId: number): { packId: string; language: string; title: string } {
  const pack = TRANSLATION_PACKS[resourceId as keyof typeof TRANSLATION_PACKS];
  if (!pack) throw new Error(`translationPackOf: resource ${resourceId} is not a QA translation pack`);
  return pack;
}

/* --------------------------------------------------------------- small fixture */

let cachedFixture: CorpusFixture | null = null;

export function loadCorpusFixture(): CorpusFixture {
  if (cachedFixture) return cachedFixture;
  const parsed = JSON.parse(readFileSync(CORPUS_FIXTURE_PATH, 'utf-8')) as CorpusFixture;
  cachedFixture = parsed;
  return parsed;
}

export function fixtureAyahs(): FixtureAyah[] {
  return loadCorpusFixture().ayahs;
}

export function fixtureVerseKeys(): VerseKey[] {
  return fixtureAyahs().map((a) => a.verseKey);
}

export function fixtureChapters(): number[] {
  return [...new Set(fixtureAyahs().map((a) => a.chapter))].sort((x, y) => x - y);
}

/* ------------------------------------------------------------------- raw data */

export function rawCorpusStatus(): { ok: boolean; reason: string } {
  const needed = ['chapters.json', 'verses-uthmani.json', 'divisions-1.json'];
  for (const n of needed) {
    if (!existsSync(rawFile(n))) {
      return { ok: false, reason: `provider capture missing: data/raw/quran-com/${n} (run the content pipeline fetch)` };
    }
  }
  return { ok: true, reason: '' };
}

interface RawChapter {
  id: number;
  revelation_place: 'makkah' | 'madinah';
  revelation_order: number;
  bismillah_pre: boolean;
  name_simple: string;
  name_complex: string;
  name_arabic: string;
  verses_count: number;
  pages: [number, number];
  translated_name?: { name?: string };
}

interface RawDivisionVerse {
  id: number;
  verse_number: number;
  verse_key: string;
  hizb_number: number | null;
  rub_el_hizb_number: number | null;
  ruku_number: number | null;
  manzil_number: number | null;
  sajdah_number: number | null;
  page_number: number;
  juz_number: number;
  text_uthmani: string;
}

interface RawUthmaniVerse {
  id: number;
  verse_key: string;
  text_uthmani: string;
}

export function rawManifest(): { base: string; files: Record<string, { url: string; sha256: string; bytes: number; fetchedAt: string }> } {
  return readJsonIfExists(RAW_MANIFEST_PATH) ?? { base: '', files: {} };
}

/** 114 surah rows straight from `chapters.json`. */
export function buildSurahs(): Surah[] {
  const chapters = readJsonIfExists<{ chapters: RawChapter[] }>(rawFile('chapters.json'));
  if (!chapters) throw new Error('buildSurahs: data/raw/quran-com/chapters.json is not readable');
  return chapters.chapters.map((c) => ({
    number: c.id,
    nameArabic: c.name_arabic,
    nameSimple: c.name_simple,
    nameTransliterated: c.name_complex,
    translationFa: null,
    translationEn: c.translated_name?.name ?? null,
    revelationPlace: c.revelation_place,
    revelationOrder: c.revelation_order,
    ayahCount: c.verses_count,
    pagesFrom: c.pages[0],
    pagesTo: c.pages[1],
    firstVerseKey: `${c.id}:1` as VerseKey,
    lastVerseKey: `${c.id}:${c.verses_count}` as VerseKey,
    bismillahPre: c.bismillah_pre,
  }));
}

/** Surah rows limited to the chapters a fixture actually needs. */
export function buildSurahsFor(chapters: readonly number[]): Surah[] {
  const wanted = new Set(chapters);
  return buildSurahs().filter((s) => wanted.has(s.number));
}

export function divisionsForChapter(chapter: number): RawDivisionVerse[] {
  const parsed = readJsonIfExists<{ verses: RawDivisionVerse[] }>(rawFile(`divisions-${chapter}.json`));
  if (!parsed) {
    throw new Error(`divisionsForChapter: data/raw/quran-com/divisions-${chapter}.json is not readable`);
  }
  return parsed.verses;
}

function simpleTextMap(): Map<string, string> {
  const parsed = readJsonIfExists<{ verses: RawUthmaniVerse[] }>(rawFile('verses-uthmani-simple.json'));
  const map = new Map<string, string>();
  for (const v of parsed?.verses ?? []) map.set(v.verse_key, v.text_uthmani);
  return map;
}

/**
 * Ayah contract objects for the given chapters, from the authoritative captures.
 * Metadata (juz/hizb/page/…) is the provider's; `wordCount` and
 * `normalizedHash` are recomputed here the same way the pipeline computes them.
 */
export function buildAyahsForChapters(chapters: readonly number[]): Ayah[] {
  const uthmani = readJsonIfExists<{ verses: RawUthmaniVerse[] }>(rawFile('verses-uthmani.json'));
  if (!uthmani) throw new Error('buildAyahsForChapters: verses-uthmani.json is not readable');
  const wanted = new Set(chapters);
  const byKey = new Map<string, string>();
  for (const v of uthmani.verses) {
    const chapter = Number(v.verse_key.split(':')[0]);
    if (wanted.has(chapter)) byKey.set(v.verse_key, v.text_uthmani);
  }
  const simple = simpleTextMap();
  const out: Ayah[] = [];
  for (const chapter of [...wanted].sort((a, b) => a - b)) {
    for (const d of divisionsForChapter(chapter)) {
      const text = byKey.get(d.verse_key) ?? d.text_uthmani;
      out.push(toAyah(d, text, simple.get(d.verse_key) ?? null));
    }
  }
  return out.sort((a, b) => a.chapter - b.chapter || a.verse - b.verse);
}

/** The whole mushaf: 6236 ayahs in canonical (chapter, verse) order. */
export function buildFullAyahs(): Ayah[] {
  const uthmani = readJsonIfExists<{ verses: RawUthmaniVerse[] }>(rawFile('verses-uthmani.json'));
  if (!uthmani) throw new Error('buildFullAyahs: verses-uthmani.json is not readable');
  const simple = simpleTextMap();
  const byKey = new Map<string, string>();
  for (const v of uthmani.verses) byKey.set(v.verse_key, v.text_uthmani);
  const out: Ayah[] = [];
  for (let chapter = 1; chapter <= 114; chapter++) {
    for (const d of divisionsForChapter(chapter)) {
      out.push(toAyah(d, byKey.get(d.verse_key) ?? d.text_uthmani, simple.get(d.verse_key) ?? null));
    }
  }
  return out.sort((a, b) => a.chapter - b.chapter || a.verse - b.verse);
}

function toAyah(d: RawDivisionVerse, textUthmani: string, simpleText: string | null): Ayah {
  const [chapter, verse] = d.verse_key.split(':');
  return {
    verseKey: d.verse_key as VerseKey,
    chapter: Number(chapter),
    verse: Number(verse),
    sourceId: d.id,
    juz: d.juz_number ?? 1,
    hizb: d.hizb_number ?? 1,
    rubElHizb: d.rub_el_hizb_number ?? 1,
    sajda: d.sajdah_number ?? null,
    ruku: d.ruku_number ?? null,
    manzil: d.manzil_number ?? null,
    page: d.page_number,
    textUthmani,
    textUthmaniSimple: simpleText && simpleText !== textUthmani ? simpleText : null,
    wordCount: wordCount(textUthmani),
    normalizedHash: normalizedFingerprint(textUthmani),
  };
}

/**
 * The 31 fixture ayahs promoted to full `Ayah` rows, using the provider's real
 * juz/hizb/page metadata for each verse key. Fixture text wins for
 * `textUthmani` so the suite keeps comparing against the bytes QA already
 * trusts.
 */
export function fixtureAyahRecords(): Ayah[] {
  const cache = new Map<number, RawDivisionVerse[]>();
  const out: Ayah[] = [];
  for (const f of fixtureAyahs()) {
    let rows = cache.get(f.chapter);
    if (!rows) {
      rows = divisionsForChapter(f.chapter);
      cache.set(f.chapter, rows);
    }
    const d = rows.find((r) => r.verse_key === f.verseKey);
    if (!d) {
      throw new Error(`fixtureAyahRecords: no provider division row for ${f.verseKey}`);
    }
    const [chapter, verse] = f.verseKey.split(':');
    out.push({
      verseKey: f.verseKey as VerseKey,
      chapter: Number(chapter),
      verse: Number(verse),
      sourceId: d.id,
      juz: d.juz_number ?? 1,
      hizb: d.hizb_number ?? 1,
      rubElHizb: d.rub_el_hizb_number ?? 1,
      sajda: d.sajdah_number ?? null,
      ruku: d.ruku_number ?? null,
      manzil: d.manzil_number ?? null,
      page: d.page_number,
      textUthmani: f.textUthmani,
      textUthmaniSimple: null,
      wordCount: wordCount(f.textUthmani),
      normalizedHash: normalizedFingerprint(f.textUthmani),
    });
  }
  return out.sort((a, b) => a.chapter - b.chapter || a.verse - b.verse);
}

/* ------------------------------------------------------------- word-level rows */

export interface RawWordRow {
  verseKey: VerseKey;
  position: number;
  /** Madani mushaf page 1..604, straight from the provider capture. */
  pageNumber: number;
  /** Line on that page, 1..15. */
  lineNumber: number;
  textUthmani: string;
  translationEn: string | null;
  transliteration: string | null;
  isEndOfAyahMark: boolean;
}

interface RawWordVerse {
  verse_key: string;
  words?: {
    position: number;
    char_type_name: string;
    page_number?: number;
    line_number?: number;
    text_uthmani: string | null;
    translation?: { text?: string } | null;
    transliteration?: { text?: string } | null;
  }[];
}

/** Word-by-word rows for a chapter, word tokens and end-of-ayah marks alike. */
export function buildWordRows(chapter: number): RawWordRow[] {
  const parsed = readJsonIfExists<{ verses: RawWordVerse[] }>(rawFile(`words-${chapter}.json`));
  if (!parsed) throw new Error(`buildWordRows: data/raw/quran-com/words-${chapter}.json is not readable`);
  const rows: RawWordRow[] = [];
  for (const v of parsed.verses) {
    for (const w of v.words ?? []) {
      // `ayah_word.page_number` / `line_number` are NOT NULL: the grid is the
      // provider's data, so a capture row that lost it stops QA loudly instead
      // of inserting a word with a guessed mushaf position.
      if (!Number.isInteger(w.page_number) || !Number.isInteger(w.line_number)) {
        throw new Error(
          `buildWordRows: ${v.verse_key} word at position ${w.position} has no mushaf ` +
            `page_number/line_number in data/raw/quran-com/words-${chapter}.json`,
        );
      }
      rows.push({
        verseKey: v.verse_key as VerseKey,
        position: w.position,
        pageNumber: w.page_number as number,
        lineNumber: w.line_number as number,
        textUthmani: w.text_uthmani ?? '',
        translationEn: w.translation?.text ?? null,
        transliteration: w.transliteration?.text ?? null,
        isEndOfAyahMark: w.char_type_name !== 'word',
      });
    }
  }
  return rows;
}

/* ---------------------------------------------------------------- translations */

interface BulkTranslationRow {
  resource_id: number;
  text: string;
}

/**
 * Bulk translation capture: an ordered array with **no** verse key
 * (docs/current-state.md known issue). Position is not an id — it may only be
 * used once alignment has been proven against a keyed response.
 */
export function bulkTranslationArray(resourceId: 85 | 135 | 29): BulkTranslationRow[] {
  const parsed = readJsonIfExists<{ translations: BulkTranslationRow[] }>(
    rawFile(`translation-${resourceId}.json`),
  );
  if (!parsed) throw new Error(`bulkTranslationArray: translation-${resourceId}.json is not readable`);
  return parsed.translations;
}

interface SampleVerse {
  verse_key: string;
  translations?: { resource_id: number; text: string }[];
}

/** Keyed spot-check capture for one chapter of one translation resource. */
export function sampledTranslations(
  resourceId: 85 | 135 | 29,
  chapter: number,
): { verseKey: VerseKey; text: string }[] {
  const parsed = readJsonIfExists<{ verses: SampleVerse[] }>(
    rawFile(`sample-translation-${resourceId}-${chapter}.json`),
  );
  if (!parsed) {
    throw new Error(
      `sampledTranslations: sample-translation-${resourceId}-${chapter}.json is not readable`,
    );
  }
  const out: { verseKey: VerseKey; text: string }[] = [];
  for (const v of parsed.verses) {
    for (const t of v.translations ?? []) {
      if (t.resource_id === resourceId) out.push({ verseKey: v.verse_key as VerseKey, text: t.text });
    }
  }
  return out;
}

export function sampledChaptersFor(resourceId: 85 | 135 | 29): number[] {
  const chapters: number[] = [];
  for (let c = 1; c <= 114; c++) {
    if (existsSync(rawFile(`sample-translation-${resourceId}-${c}.json`))) chapters.push(c);
  }
  return chapters;
}

/**
 * Translation rows for the fixture ayahs.
 *
 * The fixture itself carries the English and Persian text (it was lifted from
 * the captured responses together with the ayah text), so it is the primary
 * source. Where a keyed per-chapter spot-check capture exists it is used as a
 * cross-check: a disagreement means the fixture and the provider no longer
 * describe the same row, and the test suite must know.
 */
export function fixtureTranslations(resourceId: 85 | 135): Translation[] {
  const pack = TRANSLATION_PACKS[resourceId];
  const byField = resourceId === 85 ? 'translationEn' : 'translationFa';
  const keyed = new Map<string, string>();
  for (const chapter of sampledChaptersFor(resourceId)) {
    for (const row of sampledTranslations(resourceId, chapter)) keyed.set(row.verseKey, row.text);
  }
  const mismatches: string[] = [];
  const out: Translation[] = [];
  for (const a of fixtureAyahs()) {
    const text = a[byField];
    const captured = keyed.get(a.verseKey);
    if (captured !== undefined && captured !== text) mismatches.push(a.verseKey);
    out.push({ verseKey: a.verseKey, packId: pack.packId, text });
  }
  if (mismatches.length > 0) {
    throw new Error(
      `fixtureTranslations(${resourceId}): fixture text differs from the keyed capture for ${mismatches.join(', ')}`,
    );
  }
  return out;
}

/** Verse keys whose translation has an independently keyed capture. */
export function capturedTranslationVerseKeys(resourceId: 85 | 135 | 29): Map<VerseKey, string> {
  const map = new Map<VerseKey, string>();
  for (const chapter of sampledChaptersFor(resourceId)) {
    for (const row of sampledTranslations(resourceId, chapter)) map.set(row.verseKey, row.text);
  }
  return map;
}

/* --------------------------------------------------------------------- tafsir */

interface RawTafsir {
  verse_key: string;
  resource_id: number;
  text: string;
}

/** Tafsir passages for one chapter from the captured per-chapter response. */
export function tafsirForChapter(resourceId: 16 | 169, chapter: number): { verseKey: VerseKey; text: string }[] {
  const parsed = readJsonIfExists<{ tafsirs: RawTafsir[] }>(rawFile(`tafsir-${resourceId}-${chapter}.json`));
  if (!parsed) throw new Error(`tafsirForChapter: tafsir-${resourceId}-${chapter}.json is not readable`);
  return parsed.tafsirs
    .filter((t) => t.resource_id === resourceId && t.text.trim().length > 0)
    .map((t) => ({ verseKey: t.verse_key as VerseKey, text: t.text }));
}
