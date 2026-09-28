/**
 * Integration: a Persian-first product must answer a Persian query, in both
 * gateway implementations, against the real corpus.
 *
 * Nothing here is mocked:
 * - the database is a temp file created from the authoritative
 *   `core/src/contracts/db.sql`, so `ayah_search` is the real FTS5 virtual
 *   table, loaded with the whole 6,236-ayah mushaf and all three bundled
 *   translation packs from the provider captures in `data/raw` (the same bytes
 *   `content/tr-fa-*.jsonl` is built from);
 * - the index is written by the shipped writer (`collectRawSearchDocs` →
 *   `buildSearchIndexRows` → `writeSearchIndexRows`) — what
 *   `TauriGateway.writePlan` calls;
 * - queries go through the shipped readers: `SqliteSearchService` under both its
 *   `sqlite-fts5` and `like` identities, and `MemorySearchService`, the dev
 *   shell's backend.
 *
 * Every expected set is computed independently in JS over the same rows, so an
 * assertion means "the verses whose bundled Persian translation contains this
 * query came back" — not "the function returned an array".
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MemorySearchService,
  SEARCH_INDEX_VERSION,
  SqliteSearchService,
  buildSearchIndexRows,
  collectRawSearchDocs,
  ensureSearchIndexForm,
  writeSearchIndexRows,
  type RawSearchDoc,
} from '../../desktop/src/gateway/search';
import { matchKey, matchTokens } from '../../core/src/search/index';
import { normalizedText } from '../../core/src/normalize/arabic';
import type { AyahRow, SearchHit } from '../../desktop/src/gateway/types';
import { createTempDb, type TestHandle } from '../helpers/db';
import { createFullCorpusDb, fullCorpus, fullTranslationRows } from '../helpers/fullcorpus';
import { TRANSLATION_PACKS } from '../helpers/corpus';

const EN = 85 as const;
const FA_ISLAMHOUSE = 135 as const;
const FA_KALDARI = 29 as const;
const RESOURCES = [EN, FA_ISLAMHOUSE, FA_KALDARI] as const;

const MEASURED: { indexBuildMs: number; verses: number; queries: { query: string; ms: number; hits: number }[] } = {
  indexBuildMs: 0,
  verses: 0,
  queries: [],
};
const LEGACY_MEASURED: { repairMs: number; beforeHits: number; truth: number; beforeCounts: Record<string, number> } = {
  repairMs: 0,
  beforeHits: 0,
  truth: 0,
  beforeCounts: {},
};

/** The async SQLite surface the gateway code is written against. */
function client(handle: TestHandle) {
  return {
    select: async <TRow>(sql: string, params: unknown[] = []): Promise<TRow[]> => handle.all<TRow>(sql, params),
    execute: async (sql: string, params: unknown[] = []): Promise<number> => {
      handle.run(sql, params);
      return 0;
    },
  };
}

function packRows(handle: TestHandle) {
  return handle.all<{ id: string; kind: string; language: string }>(
    "SELECT id, kind, language FROM content_pack WHERE kind = 'translation' ORDER BY id",
  ).map((r) => ({ id: r.id, kind: r.kind as 'translation', language: r.language }));
}

function translationRows(handle: TestHandle) {
  return handle.all<{ verse_key: string; pack_id: string; text: string }>(
    `SELECT t.verse_key AS verse_key, t.pack_id AS pack_id, t.text AS text
     FROM translation t
     JOIN content_pack p ON p.id = t.pack_id
     WHERE p.kind = 'translation' AND p.language IN ('fa','en')
     ORDER BY t.verse_key, p.id`,
  ).map((r) => ({ verseKey: r.verse_key as `${number}:${number}`, packId: r.pack_id, text: r.text }));
}

/** The dev shell's raw index input, straight from the stored rows. */
function rawDocs(handle: TestHandle): RawSearchDoc[] {
  return collectRawSearchDocs(fullCorpus().ayahs, translationRows(handle), packRows(handle));
}

/**
 * Independent ground truth: the verses whose bundled translation of one language
 * holds every query token, computed in JS with no SQL and no index.
 *
 * Memoised because several tests ask the same question; the fold over 6 236
 * translation rows is the slow part of this file, not SQLite.
 */
const truthCache = new Map<string, Set<string>>();
const joinedCache = new Map<'fa' | 'en', Map<string, string>>();

/** Every verse's bundled translation text for one language, packs joined. */
function joinedByLanguage(language: 'fa' | 'en'): Map<string, string> {
  let joined = joinedCache.get(language);
  if (!joined) {
    joined = new Map<string, string>();
    for (const resourceId of RESOURCES) {
      if (TRANSLATION_PACKS[resourceId].language !== language) continue;
      for (const row of fullTranslationRows(resourceId)) {
        joined.set(row.verseKey, `${joined.get(row.verseKey) ?? ''} ${row.text}`);
      }
    }
    joinedCache.set(language, joined);
  }
  return joined;
}

function truthFor(query: string, language: 'fa' | 'en'): Set<string> {
  const cacheKey = `${language}|${query}`;
  const cached = truthCache.get(cacheKey);
  if (cached) return cached;
  const tokens = matchTokens(query);
  const out = new Set<string>();
  for (const [verseKey, text] of joinedByLanguage(language)) {
    const key = matchKey(text);
    if (tokens.every((token) => key.includes(token))) out.add(verseKey);
  }
  truthCache.set(cacheKey, out);
  return out;
}

const ayahsAsRows = fullCorpus().ayahs as unknown as AyahRow[];

describe('the shipped SQLite search path', () => {
  let handle: TestHandle;

  beforeAll(async () => {
    handle = createTempDb({ name: 'persian-search' });
    createFullCorpusDb(handle, { translations: [...RESOURCES] });
    const docs = rawDocs(handle);
    const started = Date.now();
    await writeSearchIndexRows(client(handle), buildSearchIndexRows(docs));
    MEASURED.indexBuildMs = Date.now() - started;
    MEASURED.verses = docs.length;
    handle.run(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ['search_index_key_version', String(SEARCH_INDEX_VERSION)],
    );
  }, 180_000);

  afterAll(() => handle?.dispose());

  it('loads the corpus it claims to: 6 236 verses, three translation packs', () => {
    expect(handle.count('ayah')).toBe(6236);
    expect(handle.count('translation')).toBe(6236 * 3);
    expect(handle.count('ayah_search')).toBe(6236);
    expect(MEASURED.verses).toBe(6236);
  });

  it('indexes every bundled Persian pack, not the one the loader saw last', () => {
    // البسملة: the IslamHouse pack never says `خدا` in 1:1, the Kaldari pack
    // does. An index built from a single Persian pack cannot answer this query.
    const stored = handle.get<{ translation_fa: string }>(
      'SELECT translation_fa FROM ayah_search WHERE verse_key = ?',
      ['1:1'],
    )!;
    expect(fullTranslationRows(FA_KALDARI).find((r) => r.verseKey === '1:1')!.text).toContain('خدا');
    expect(fullTranslationRows(FA_ISLAMHOUSE).find((r) => r.verseKey === '1:1')!.text).not.toContain('خدا');

    // The column holds *both* packs' text for the verse, in pack-id order, folded
    // into the matching space — exactly what the shipped writer promises.
    const faTexts = handle
      .all<{ text: string }>(
        `SELECT t.text AS text
         FROM translation t
         JOIN content_pack p ON p.id = t.pack_id
         WHERE t.verse_key = '1:1' AND p.language = 'fa'
         ORDER BY p.id`,
      )
      .map((row) => row.text);
    expect(faTexts).toHaveLength(2);
    expect(stored.translation_fa).toBe(matchKey(faTexts.join(' ')));
    for (const token of matchTokens('خدا')) expect(stored.translation_fa).toContain(token);
  });

  it('answers a Persian query with exactly the verses whose translation contains it', async () => {
    const service = new SqliteSearchService(client(handle), 'sqlite-fts5');
    for (const query of ['آتش', 'نماز', 'بیمار', 'روزى', 'پرهیزگاری', 'بخشنده', 'ستایش']) {
      const hits = await service.search(query, { field: 'translation-fa', limit: 900 });
      const expected = truthFor(query, 'fa');
      const got = new Set(hits.map((hit) => hit.verseKey));
      const state = { query, expected: expected.size, got: got.size, missing: [...expected].filter((k) => !got.has(k)).slice(0, 3) };
      expect(state, `${query}: expected ${expected.size} verses, got ${got.size}`).toEqual({
        query,
        expected: expected.size,
        got: expected.size,
        missing: [],
      });
      for (const hit of hits) expect(hit.field).toBe('translation-fa');
    }
  }, 120_000);

  it('matches the Persian forms FTS5 whole-token indexing used to lose', async () => {
    const service = new SqliteSearchService(client(handle), 'sqlite-fts5');
    const truth = truthFor('بیمار', 'fa');
    expect(truth.size).toBeGreaterThan(0);
    const hits = await service.search('بیمار', { field: 'translation-fa', limit: 900 });
    expect(new Set(hits.map((hit) => hit.verseKey))).toEqual(truth);

    // What FTS5 alone would have answered on this same table: whole tokens only,
    // so a verse whose translation says `بیماران` is invisible there.
    const wholeTokens = handle
      .all<{ verse_key: string }>('SELECT verse_key FROM ayah_search WHERE ayah_search MATCH ?', [
        'translation_fa: "بيمار"',
      ])
      .map((row) => row.verse_key);
    expect(wholeTokens.length).toBeLessThan(truth.size);

    // The verses FTS5 missed are real substring matches, not noise.
    const recovered = [...truth].filter((verseKey) => !wholeTokens.includes(verseKey));
    expect(recovered.length).toBeGreaterThan(0);
    for (const verseKey of recovered.slice(0, 5)) {
      const stored = handle.get<{ translation_fa: string }>(
        'SELECT translation_fa FROM ayah_search WHERE verse_key = ?',
        [verseKey],
      )!;
      expect(stored.translation_fa).toContain('بيمار');
      expect(stored.translation_fa).toMatch(/بيمار\S/); // inside a longer word
    }
  });

  it('measures what FTS5 whole-token matching would have answered on this table', async () => {
    // The recall numbers quoted in `docs/search-system.md`, recomputed here from
    // the shipped index: `MATCH` sees only whole indexed tokens, the substring
    // rule sees every verse whose translation contains the query.
    const service = new SqliteSearchService(client(handle), 'sqlite-fts5');
    const table: { query: string; ftsTokens: number; substring: number }[] = [];
    for (const query of ['نماز', 'بیمار', 'بهشت', 'آتش', 'روزى']) {
      const [token] = matchTokens(query);
      expect(token, query).toBeTruthy();
      const ftsTokens = handle
        .all<{ n: number }>('SELECT COUNT(*) AS n FROM ayah_search WHERE ayah_search MATCH ?', [
          `translation_fa: "${token}"`,
        ])[0]!.n;
      const truth = truthFor(query, 'fa');
      const hits = await service.search(query, { field: 'translation-fa', limit: 900 });
      expect(new Set(hits.map((hit) => hit.verseKey)), query).toEqual(truth);
      table.push({ query, ftsTokens, substring: truth.size });
    }
    console.log('[persian-search] recall (FTS5 whole-token vs substring)', JSON.stringify(table));
    for (const row of table) {
      expect(row.substring, row.query).toBeGreaterThan(0);
      expect(row.ftsTokens, `${row.query}: FTS5-token recall should not beat substring`).toBeLessThanOrEqual(
        row.substring,
      );
    }
  }, 120_000);

  it('still answers an Arabic query pasted with its diacritics', async () => {
    const service = new SqliteSearchService(client(handle), 'sqlite-fts5');
    const fatiha = fullCorpus().ayahs.find((a) => a.verseKey === '1:1')!;
    expect(fatiha.textUthmani).toMatch(/[\u064B-\u065F\u0670]/); // carries harakat / superscript alef
    const whole = await service.search(fatiha.textUthmani, { limit: 50 });
    expect(whole.map((hit) => hit.verseKey)).toContain('1:1');
    expect(whole.find((hit) => hit.verseKey === '1:1')!.field).toBe('arabic');

    const word = await service.search('ٱلرَّحْمَـٰنِ', { field: 'arabic', limit: 900 });
    expect(word.map((hit) => hit.verseKey)).toContain('1:1');
    expect(word.length).toBeGreaterThan(0);

    // The old tokeniser shattered this into one-letter tokens; it must not.
    expect(matchTokens(fatiha.textUthmani).every((t) => t.length > 1)).toBe(true);
  });

  it('answers an English query', async () => {
    const service = new SqliteSearchService(client(handle), 'sqlite-fts5');
    const hits = await service.search('mercy', { field: 'translation-en', limit: 900 });
    expect(new Set(hits.map((hit) => hit.verseKey))).toEqual(truthFor('mercy', 'en'));
    expect(hits.length).toBeGreaterThan(0);
  });

  it('shows the byte-exact translation in an excerpt, never the index form', async () => {
    const service = new SqliteSearchService(client(handle), 'sqlite-fts5');
    const hits = await service.search('آتش', { field: 'translation-fa', limit: 900 });
    const withRawAlef = hits.filter((hit) => hit.excerpt.includes('آتش'));
    expect(withRawAlef.length).toBeGreaterThan(0);
    // The column that matched holds the folded form; the excerpt holds the bytes.
    const stored = handle.get<{ translation_fa: string }>(
      'SELECT translation_fa FROM ayah_search WHERE verse_key = ?',
      [withRawAlef[0]!.verseKey],
    )!;
    expect(stored.translation_fa).not.toContain('آتش');
    expect(withRawAlef[0]!.excerpt).toContain('آتش');
    expect(withRawAlef[0]!.textUthmani).not.toBe(withRawAlef[0]!.excerpt);
  });

  it('gives the same verses with or without the FTS5 module', async () => {
    const fts = await new SqliteSearchService(client(handle), 'sqlite-fts5').search('نماز', { limit: 900 });
    const like = await new SqliteSearchService(client(handle), 'like').search('نماز', { limit: 900 });
    expect(new Set(like.map((hit) => hit.verseKey))).toEqual(new Set(fts.map((hit) => hit.verseKey)));
  });

  it('agrees with the dev shell backend, verse for verse', async () => {
    const docs = rawDocs(handle);
    const memory = new MemorySearchService(() => docs, () => ayahsAsRows);
    const sqlite = new SqliteSearchService(client(handle), 'sqlite-fts5');
    for (const query of ['آتش', 'خدا', 'mercy', 'نماز']) {
      const dev = await memory.search(query, { limit: 900 });
      const db = await sqlite.search(query, { limit: 900 });
      expect(
        new Set(dev.map((hit: SearchHit) => hit.verseKey)),
        `${query}: the dev shell and SQLite disagree`,
      ).toEqual(new Set(db.map((hit: SearchHit) => hit.verseKey)));
    }
    // The dev shell keeps the raw text for its excerpt too.
    const dev = await memory.search('آتش', { field: 'translation-fa', limit: 10 });
    expect(dev.some((hit) => hit.excerpt.includes('آتش'))).toBe(true);
  }, 120_000);

  it('measures the index build and the query latency it promises', async () => {
    const service = new SqliteSearchService(client(handle), 'sqlite-fts5');
    for (const query of ['آتش', 'نماز', 'بیمار', 'خدا', 'ستایش', 'mercy']) {
      const start = performance.now();
      const hits = await service.search(query, { limit: 40 });
      const ms = performance.now() - start;
      MEASURED.queries.push({ query, ms, hits: hits.length });
      expect(ms, `${query} took ${ms.toFixed(1)} ms`).toBeLessThan(250);
    }
    console.log('[persian-search] measured', JSON.stringify(MEASURED));
    expect(MEASURED.indexBuildMs).toBeLessThan(15_000);
  });
});

describe('a database imported before the translation columns were normalised', () => {
  let legacy: TestHandle;

  beforeAll(() => {
    legacy = createTempDb({ name: 'persian-search-legacy' });
    createFullCorpusDb(legacy, { translations: [...RESOURCES] });
    // Exactly what the shipped writer used to store: Arabic keyed, translations
    // raw, one Persian pack per verse, and no version marker in `meta`.
    const en = new Map(fullTranslationRows(EN).map((r) => [r.verseKey, r.text]));
    const fa = new Map(fullTranslationRows(FA_ISLAMHOUSE).map((r) => [r.verseKey, r.text]));
    legacy.exec('DELETE FROM ayah_search');
    legacy.tx(() => {
      const stmt = legacy.db.prepare(
        'INSERT INTO ayah_search (verse_key, arabic, translation_en, translation_fa) VALUES (?,?,?,?)',
      );
      for (const ayah of fullCorpus().ayahs) {
        stmt.run(ayah.verseKey, normalizedText(ayah.textUthmani), en.get(ayah.verseKey) ?? '', fa.get(ayah.verseKey) ?? '');
      }
    });
    LEGACY_MEASURED.beforeCounts = legacy.rowCounts();
  }, 180_000);

  afterAll(() => legacy?.dispose());

  it('serves fewer Persian hits until the index is rebuilt, then all of them', async () => {
    const service = new SqliteSearchService(client(legacy), 'sqlite-fts5');
    const truth = truthFor('آتش', 'fa');
    LEGACY_MEASURED.truth = truth.size;
    const before = await service.search('آتش', { field: 'translation-fa', limit: 900 });
    const beforeKeys = new Set(before.map((hit) => hit.verseKey));
    // A raw translation column answers only the verses whose Persian text happens
    // to be spelled without the alef-madda (`اتش` instead of `آتش`) — a handful,
    // and it indexes one Persian pack instead of both.
    expect(beforeKeys.size).toBeGreaterThan(0);
    expect(beforeKeys.size).toBeLessThan(truth.size);
    for (const verseKey of beforeKeys) expect(truth.has(verseKey), verseKey).toBe(true);
    LEGACY_MEASURED.beforeHits = beforeKeys.size;

    const repair = await ensureSearchIndexForm(client(legacy));
    expect(repair.rebuilt).toBe(true);
    expect(repair.verses).toBe(6236);
    LEGACY_MEASURED.repairMs = repair.ms;

    const after = await service.search('آتش', { field: 'translation-fa', limit: 900 });
    expect(new Set(after.map((hit) => hit.verseKey))).toEqual(truth);
    expect(
      legacy.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', ['search_index_key_version'])?.value,
    ).toBe(String(SEARCH_INDEX_VERSION));

    // A second open does no work: the marker now matches.
    const again = await ensureSearchIndexForm(client(legacy));
    expect(again.rebuilt).toBe(false);
  }, 180_000);

  it('touches nothing but the derived index and its marker', () => {
    const after = legacy.rowCounts();
    expect(Object.keys(after).sort()).toEqual(Object.keys(LEGACY_MEASURED.beforeCounts).sort());
    for (const table of ['ayah', 'ayah_word', 'translation', 'content_pack', 'note', 'bookmark', 'hifz_item']) {
      expect(after[table], table).toBe(LEGACY_MEASURED.beforeCounts[table]);
    }
    console.log('[persian-search] legacy rebuild', JSON.stringify(LEGACY_MEASURED));
  });
});
