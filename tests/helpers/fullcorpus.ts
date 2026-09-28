/**
 * Full-mushaf database for integration and performance work.
 *
 * The 31-ayah fixture proves behaviour; it does not prove behaviour at
 * 6 236 ayahs / 114 surahs, which is the only size the mushaf invariants in
 * `core/src/integrity/verify.ts` are written for. This builds the whole corpus
 * into a real temp SQLite file from the provider captures in `data/raw` — the
 * same bytes the content pipeline builds its packs from, so QA's "full corpus"
 * and the app's "full corpus" are the same data, not two approximations.
 *
 * Insertion is deliberately bulk (`prepare` once, bind many, one transaction):
 * a row-by-row `h.run()` of 6 236 ayahs plus 83 665 word rows spends its time
 * in statement preparation and per-statement autocommit, not in SQLite.
 */
import { existsSync } from 'node:fs';

import type { Ayah, Surah, Translation } from '../../core/src/contracts/quran';
import { normalizeWord, normalizedText } from '../../core/src/normalize/arabic';
import type { TestHandle } from './db';
import { insertContentPack } from './db';
import {
  buildFullAyahs,
  buildSurahs,
  buildWordRows,
  bulkTranslationArray,
  packIdOfResource,
  sampledChaptersFor,
  sampledTranslations,
  tafsirForChapter,
  TAFSIR_PACKS,
  TRANSLATION_PACKS,
} from './corpus';
import { rawFile } from './repo';

export interface FullCorpus {
  surahs: Surah[];
  ayahs: Ayah[];
  /** Verse key → the same sha-style fingerprint the ayah rows store. */
  fingerprints: Map<string, string>;
}

let cache: FullCorpus | null = null;

/** Whole mushaf in canonical order, built once per worker process. */
export function fullCorpus(): FullCorpus {
  if (cache) return cache;
  const ayahs = buildFullAyahs();
  const surahs = buildSurahs();
  cache = {
    surahs,
    ayahs,
    fingerprints: new Map(ayahs.map((a) => [a.verseKey, a.normalizedHash])),
  };
  return cache;
}

export function insertSurahsBulk(h: TestHandle, surahs: readonly Surah[]): void {
  const stmt = h.db.prepare(
    `INSERT INTO surah (number, name_arabic, name_simple, name_transliterated, translation_fa,
        translation_en, revelation_place, revelation_order, ayah_count, pages_from, pages_to,
        first_verse_key, last_verse_key, bismillah_pre)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  h.tx(() => {
    for (const s of surahs) {
      stmt.run(
        s.number, s.nameArabic, s.nameSimple, s.nameTransliterated, s.translationFa, s.translationEn,
        s.revelationPlace, s.revelationOrder, s.ayahCount, s.pagesFrom, s.pagesTo, s.firstVerseKey,
        s.lastVerseKey, s.bismillahPre ? 1 : 0,
      );
    }
  });
}

export function insertAyahsBulk(h: TestHandle, ayahs: readonly Ayah[]): void {
  const stmt = h.db.prepare(
    `INSERT INTO ayah (verse_key, chapter, verse, source_id, juz, hizb, rub_el_hizb, sajda, ruku,
        manzil, page, text_uthmani, text_uthmani_simple, word_count, normalized_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  h.tx(() => {
    for (const a of ayahs) {
      stmt.run(
        a.verseKey, a.chapter, a.verse, a.sourceId, a.juz, a.hizb, a.rubElHizb, a.sajda, a.ruku,
        a.manzil, a.page, a.textUthmani, a.textUthmaniSimple, a.wordCount, a.normalizedHash,
      );
    }
  });
}

/**
 * `ayah_word.id` is an INTEGER PRIMARY KEY, so ids are positional counters,
 * never the uuid-style strings the user tables use.
 */
export interface WordSeed {
  id?: number;
  verseKey: string;
  position: number;
  /** Madani mushaf page 1..604 — `ayah_word.page_number` is NOT NULL. */
  pageNumber: number;
  /** Line on that page, 1..15 — `ayah_word.line_number` is NOT NULL. */
  lineNumber: number;
  textUthmani: string;
  translationEn: string | null;
  transliteration: string | null;
  root?: string | null;
  morphology?: string | null;
  isEndOfAyahMark: boolean;
  normalized?: string;
}

export function insertWordsBulk(h: TestHandle, words: readonly WordSeed[]): void {
  const stmt = h.db.prepare(
    `INSERT INTO ayah_word (id, verse_key, position, page_number, line_number, text_uthmani,
        translation_en, transliteration, root, morphology, is_end_of_ayah_mark, normalized)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  let nextId = Number(h.get<{ m: number | null }>('SELECT MAX(id) AS m FROM ayah_word')?.m ?? 0) + 1;
  h.tx(() => {
    for (const w of words) {
      stmt.run(
        w.id ?? nextId++, w.verseKey, w.position, w.pageNumber, w.lineNumber, w.textUthmani,
        w.translationEn, w.transliteration,
        w.root ?? null, w.morphology ?? null, w.isEndOfAyahMark ? 1 : 0,
        w.normalized ?? normalizeWord(w.textUthmani),
      );
    }
  });
}

export function insertTranslationsBulk(h: TestHandle, rows: readonly Translation[]): void {
  const stmt = h.db.prepare('INSERT INTO translation (verse_key, pack_id, text) VALUES (?,?,?)');
  h.tx(() => {
    for (const t of rows) stmt.run(t.verseKey, t.packId, t.text);
  });
}

/**
 * Every word row of the mushaf. The provider only ships per-chapter word files,
 * so this walks 1..114; ids are assigned by the bulk inserter.
 */
export function fullWordRows(): WordSeed[] {
  const out: WordSeed[] = [];
  for (let chapter = 1; chapter <= 114; chapter += 1) {
    for (const w of buildWordRows(chapter)) out.push({ ...w });
  }
  return out;
}

/**
 * Translations for the whole mushaf, one pack at a time, from the bulk
 * provider arrays. `alignment.test.ts` is what proves this positional join is
 * legitimate; until a row is checked this function throws rather than guessing.
 */
export function fullTranslationRows(resourceId: 85 | 135 | 29): Translation[] {
  const pack = TRANSLATION_PACKS[resourceId];
  const rows = bulkTranslationArray(resourceId);
  const ayahs = fullCorpus().ayahs;
  if (rows.length !== ayahs.length) {
    throw new Error(
      `fullTranslationRows(${resourceId}): bulk array has ${rows.length} rows but the corpus has ${ayahs.length}`,
    );
  }
  const out: Translation[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const text = rows[i]?.text ?? '';
    out.push({ verseKey: ayahs[i]!.verseKey, packId: pack.packId, text });
  }
  return out;
}

/**
 * Cross-check the positional join wherever the provider *does* give keyed
 * rows: the per-chapter sample captures cover 12 chapters and carry
 * `verse_key`. Any disagreement is a hard failure — this is the guard that
 * keeps `fullTranslationRows` honest.
 */
export function assertAlignmentAgainstKeyedCaptures(resourceId: 85 | 135): { checked: number; mismatches: string[] } {
  const keyed = new Map<string, string>();
  for (const chapter of sampledChaptersFor(resourceId)) {
    for (const row of sampledTranslations(resourceId as 85 | 135, chapter)) keyed.set(row.verseKey, row.text);
  }
  const byKey = new Map(fullTranslationRows(resourceId).map((t) => [t.verseKey, t.text]));
  const mismatches: string[] = [];
  for (const [verseKey, text] of keyed) {
    if (byKey.get(verseKey) !== text) mismatches.push(verseKey);
  }
  return { checked: keyed.size, mismatches };
}

export interface FullDbOptions {
  /** Insert all 83 665 `ayah_word` rows (slow; only where words are needed). */
  words?: boolean;
  /** Translation resource ids to load, e.g. `[85, 135]`. */
  translations?: (85 | 135 | 29)[];
  /** Tafsir resource ids to load. */
  tafsirs?: (16 | 169)[];
  /** Build the `ayah_search` FTS rows for the corpus. */
  searchIndex?: boolean;
}

/** Load the whole corpus into a fresh temp database and return the handle. */
export function createFullCorpusDb(h: TestHandle, options: FullDbOptions = {}): TestHandle {
  const { surahs, ayahs } = fullCorpus();
  const translations = options.translations ?? [];
  const tafsirs = options.tafsirs ?? [];
  registerQaPacks(h, { translations, tafsirs });
  insertSurahsBulk(h, surahs);
  insertAyahsBulk(h, ayahs);
  if (options.words) insertWordsBulk(h, fullWordRows());
  for (const resourceId of translations) insertTranslationsBulk(h, fullTranslationRows(resourceId));
  for (const resourceId of tafsirs) insertTafsirsBulk(h, resourceId);
  for (const resourceId of translations) {
    const packId = packIdOfResource(resourceId);
    h.run(
      'UPDATE content_pack SET record_count = (SELECT COUNT(*) FROM translation WHERE pack_id = ?) WHERE id = ?',
      [packId, packId],
    );
  }
  for (const resourceId of tafsirs) {
    const packId = packIdOfResource(resourceId);
    h.run(
      'UPDATE content_pack SET record_count = (SELECT COUNT(*) FROM tafsir WHERE pack_id = ?) WHERE id = ?',
      [packId, packId],
    );
  }
  if (options.searchIndex) indexSearchRows(h, ayahs, translations);
  return h;
}

/** Every tafsir passage of one resource that the provider captured for the mushaf. */
export function fullTafsirRows(resourceId: 16 | 169): { verseKey: string; packId: string; text: string }[] {
  const pack = TAFSIR_PACKS[resourceId];
  const present = new Set(fullCorpus().ayahs.map((a) => a.verseKey));
  const out: { verseKey: string; packId: string; text: string }[] = [];
  for (let chapter = 1; chapter <= 114; chapter += 1) {
    if (!existsSync(rawFile(`tafsir-${resourceId}-${chapter}.json`))) continue;
    for (const row of tafsirForChapter(resourceId, chapter)) {
      if (present.has(row.verseKey)) out.push({ verseKey: row.verseKey, packId: pack.packId, text: row.text });
    }
  }
  return out;
}

function insertTafsirsBulk(
  h: TestHandle,
  resourceId: 16 | 169,
): void {
  const stmt = h.db.prepare(
    'INSERT INTO tafsir (verse_key, pack_id, text, covers_verse_keys) VALUES (?,?,?,?)',
  );
  h.tx(() => {
    for (const t of fullTafsirRows(resourceId)) {
      stmt.run(t.verseKey, t.packId, t.text, JSON.stringify([t.verseKey]));
    }
  });
}

/**
 * Fill `ayah_search` exactly the way the contract's derived index expects:
 * verse_key UNINDEXED, Arabic stored *normalised* (`normalizedText`, not the
 * raw Uthmani bytes) and one column per language. Where several Persian packs
 * are loaded, the first listed pack wins — this is QA's choice, and it is
 * recorded here so a search hit is reproducible.
 */
export function indexSearchRows(
  h: TestHandle,
  ayahs: readonly Ayah[],
  resourceIds: readonly (85 | 135 | 29)[] = [],
): number {
  const en = new Map<string, string>();
  const fa = new Map<string, string>();
  for (const resourceId of resourceIds) {
    const pack = TRANSLATION_PACKS[resourceId];
    const target = pack.language === 'en' ? en : pack.language === 'fa' ? fa : null;
    if (!target) continue;
    for (const row of fullTranslationRows(resourceId)) {
      if (!target.has(row.verseKey)) target.set(row.verseKey, row.text);
    }
  }
  const stmt = h.db.prepare(
    'INSERT INTO ayah_search (verse_key, arabic, translation_en, translation_fa) VALUES (?,?,?,?)',
  );
  h.tx(() => {
    for (const a of ayahs) {
      stmt.run(
        a.verseKey,
        normalizedText(a.textUthmani),
        en.get(a.verseKey) ?? '',
        fa.get(a.verseKey) ?? '',
      );
    }
  });
  return ayahs.length;
}

/**
 * `translation.pack_id` and `tafsir.pack_id` reference `content_pack`, so a
 * corpus database that loads packs must register them first. Ids come from
 * `corpus.ts` so every QA suite agrees on what a pack is called.
 */
export function registerQaPacks(
  h: TestHandle,
  options: { translations?: readonly (85 | 135 | 29)[]; tafsirs?: readonly (16 | 169)[] } = {},
): void {
  for (const resourceId of options.translations ?? []) {
    const pack = TRANSLATION_PACKS[resourceId];
    insertContentPack(h, {
      id: pack.packId,
      kind: 'translation',
      version: '1.0.0',
      language: pack.language,
      title: pack.title,
      source: 'data/raw/quran-com provider capture',
      licenseName: 'Attribution required — see the content pack manifest',
      licenseStatus: 'attribution-required',
      licenseNotes: 'QA fixture pack row; licensing is unresolved for offline bundling',
      attribution: pack.title,
      checksum: '0'.repeat(64),
      payloadBytes: 0,
      recordCount: 0,
    });
  }
  for (const resourceId of options.tafsirs ?? []) {
    const pack = TAFSIR_PACKS[resourceId];
    insertContentPack(h, {
      id: pack.packId,
      kind: 'tafsir',
      version: '1.0.0',
      language: pack.language,
      title: pack.title,
      source: 'data/raw/quran-com provider capture',
      licenseName: pack.title,
      licenseStatus: 'attribution-required',
      licenseNotes: 'QA fixture pack row',
      attribution: 'King Fahd Complex, via the provider capture',
      checksum: '0'.repeat(64),
      payloadBytes: 0,
      recordCount: 0,
    });
  }
}

/** Count of word rows the provider captures hold for the whole mushaf. */
export function fullWordRowCount(): number {
  return fullWordRows().length;
}
