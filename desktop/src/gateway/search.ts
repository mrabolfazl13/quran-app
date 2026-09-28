/**
 * Search — one interface, the backends a gateway can actually report.
 *
 *   `sqlite-fts5`  the shipped desktop backend. Two statements, because SQLite
 *                  forbids `MATCH` and `LIKE` in the same WHERE clause
 *                  (`unable to use function MATCH in the requested context`):
 *                    1. `ayah_search LIKE` over the normalised `arabic` column,
 *                       ordered by bm25 where the query is Arabic-script; and
 *                    2. `ayah_search LIKE` over the normalised translation
 *                       columns.
 *                  The merged list is ordered by `compareMatchedHits`.
 *   `like`         the same table and the same matching, on a SQLite build that
 *                  has no FTS5 module (statement 1 is the one that differs).
 *   `memory-index` the browser build (web and dev shell): the identical keys
 *                  and the identical substring rule, held in memory.
 *
 * Both sides of every comparison use ONE normalisation: `matchKey` from
 * `core/src/search`, which is `searchKey` from `core/src/normalize/arabic` — the
 * same definition of "same word" the memory engine and the integrity checks
 * use. Index columns store `matchKey` output; `ayah.text_uthmani` and
 * `translation.text` stay byte-exact and are what an excerpt shows.
 *
 * Why translations are matched as substrings instead of FTS5 tokens, measured on
 * the real bundled corpus (6,236 ayahs, both Persian packs joined per verse,
 * `node:sqlite` with the shipped DDL; recomputed by
 * `tests/integration/persian-search.test.ts`, which prints these tables):
 *
 *   query    FTS5 whole-token hits   substring hits
 *   نماز                  90                     103
 *   بیمار                14                      36
 *   بهشت                158                     196
 *   آتش                 184                     250
 *   روزى                 256                     325
 *
 * FTS5 loses the verses where the query only appears inside a longer Persian
 * word (`نماز` in `نمازهای`, `بیمار` in `بیماران`) — only a stemmer would recover
 * those, and there is no Persian stemmer here, deliberately: no new dependency,
 * and at this corpus size the substring scan answers in 20–35 ms end to end.
 *
 * The other half of the fix is the *stored* form: an index whose translation
 * columns hold raw bytes answers `آتش` (query folded to `اتش`) in 31 of the 250
 * verses that truly contain it, because the pack spells most of them with the
 * alef-madda. That is why `ayah_search` is rebuilt on open when its `meta`
 * version marker is missing or older — see `ensureSearchIndexForm`.
 */
import {
  MATCH_FIELD_PRIORITY,
  SEARCH_INDEX_KEY_VERSION,
  compareMatchedHits,
  matchKey,
  matchTokens,
  type MatchField,
} from '@quran/core';
import type { VerseKey } from '@quran/core';
import { META_KEYS } from '../db/schema';
import type {
  AyahRow,
  PackRow,
  SearchBackend,
  SearchDocRow,
  SearchHit,
  SearchNoteId,
  SearchOptions,
  TranslationRow,
} from './types';

export type { SearchBackend };

/** `meta` key whose stored value says which normalisation the columns use. */
const META_KEY_SEARCH_INDEX = META_KEYS.searchIndexKeyVersion;

const DEFAULT_LIMIT = 40;

/**
 * Candidate rows pulled out of SQLite before ranking. A whole-corpus Persian
 * word returns a few hundred ayahs, so this cap is not why a hit is missing; it
 * exists so one pathological query cannot stream the entire mushaf across the
 * Tauri IPC boundary.
 */
const CANDIDATE_CAP = 1000;

/** Verses per multi-value INSERT while writing the index. */
const INDEX_WRITE_CHUNK = 200;

/** The `ayah_search` column holding each field's `matchKey` text. */
const COLUMN_FOR_FIELD: Record<MatchField, string> = {
  arabic: 'arabic',
  'translation-fa': 'translation_fa',
  'translation-en': 'translation_en',
};

/** The `translation`/`content_pack` language a field's column is built from. */
const LANGUAGE_FOR_FIELD: Partial<Record<MatchField, 'fa' | 'en'>> = {
  'translation-fa': 'fa',
  'translation-en': 'en',
};

/** Tokens the user typed, in the index's own normalised space. */
export function queryTokens(query: string): string[] {
  return matchTokens(query);
}

/**
 * Excerpt around the first needle that actually occurs in the raw text.
 *
 * Needles are tried in order because the matching token is normalised and the
 * displayed text is not: `اتش` is what matched, `آتش` is what is on screen.
 * Never called with index text — display bytes only.
 */
export function excerptFor(haystack: string, needles: string | readonly string[], radius = 90): string {
  if (haystack === '') return '';
  const list = (typeof needles === 'string' ? [needles] : [...needles]).filter((n) => n.length > 0);
  if (list.length === 0) return truncate(haystack, radius * 2);
  const lower = haystack.toLowerCase();
  for (const needle of list) {
    const at = lower.indexOf(needle.toLowerCase());
    if (at < 0) continue;
    const from = Math.max(0, at - radius);
    const to = Math.min(haystack.length, at + needle.length + radius);
    return `${from > 0 ? '…' : ''}${haystack.slice(from, to).trim()}${to < haystack.length ? '…' : ''}`;
  }
  return truncate(haystack, radius * 2);
}

function truncate(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max).trimEnd()}…`;
}

/* ----------------------------------------------------------- index building */

/**
 * The raw material of the index for one verse: the display text of every
 * bundled translation pack for that language, concatenated in pack-id order.
 *
 * This is why `plan.searchDocs` is not used for the language columns: the
 * content layer keeps one translation per verse there, and a Persian phrase that
 * only exists in the second Persian pack would be unsearchable. Both shells
 * collect through this function, so their coverage is identical.
 */
export interface RawSearchDoc {
  verseKey: VerseKey;
  textUthmani: string;
  translationEn: string;
  translationFa: string;
}

export function collectRawSearchDocs(
  ayahs: readonly Pick<AyahRow, 'verseKey' | 'textUthmani'>[],
  translations: readonly TranslationRow[],
  packs: readonly Pick<PackRow, 'id' | 'kind' | 'language'>[],
): RawSearchDoc[] {
  const languageOf = new Map<string, string>();
  for (const pack of packs) {
    if (pack.kind !== 'translation') continue;
    if (pack.language === 'fa' || pack.language === 'en') languageOf.set(pack.id, pack.language);
  }
  const byVerse = new Map<string, { en: string[]; fa: string[] }>();
  for (const row of translations) {
    const language = languageOf.get(row.packId);
    if (!language) continue;
    const bucket = byVerse.get(row.verseKey) ?? { en: [], fa: [] };
    (language === 'en' ? bucket.en : bucket.fa).push(row.text);
    byVerse.set(row.verseKey, bucket);
  }
  return ayahs.map((ayah) => {
    const bucket = byVerse.get(ayah.verseKey);
    return {
      verseKey: ayah.verseKey,
      textUthmani: ayah.textUthmani,
      translationEn: (bucket?.en ?? []).join(' '),
      translationFa: (bucket?.fa ?? []).join(' '),
    };
  });
}

/** The `ayah_search` rows for those documents: every column in `matchKey` form. */
export function buildSearchIndexRows(docs: readonly RawSearchDoc[]): SearchDocRow[] {
  return docs.map((doc) => ({
    verseKey: doc.verseKey,
    arabic: matchKey(doc.textUthmani),
    translationEn: matchKey(doc.translationEn),
    translationFa: matchKey(doc.translationFa),
  }));
}

export interface SqlWriter {
  execute(sql: string, params?: unknown[]): Promise<unknown>;
}

/** Both halves of a SQLite connection: what the index needs to read and write. */
export interface SearchIndexClient extends SqlReader, SqlWriter {}

/**
 * Write index rows in chunks, so importing 6,236 ayahs costs ~32 statements
 * instead of 6,236 IPC round trips.
 */
export async function writeSearchIndexRows(client: SqlWriter, rows: readonly SearchDocRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += INDEX_WRITE_CHUNK) {
    const chunk = rows.slice(i, i + INDEX_WRITE_CHUNK);
    const params: unknown[] = [];
    for (const row of chunk) params.push(row.verseKey, row.arabic, row.translationEn, row.translationFa);
    await client.execute(
      `INSERT INTO ayah_search (verse_key, arabic, translation_en, translation_fa) VALUES ${chunk
        .map(() => '(?,?,?,?)')
        .join(',')}`,
      params,
    );
  }
}

/**
 * The version marker this writer stamps into `meta`. Kept here so the gateway
 * that writes it and the gateway that checks it cannot disagree.
 */
export const SEARCH_INDEX_VERSION = SEARCH_INDEX_KEY_VERSION;

/**
 * Re-derive the index rows from the content SQLite already stores: `ayah` for
 * the Arabic, `translation` joined to `content_pack` for each language, packs in
 * id order.
 *
 * The three reads are issued one after another on purpose, not with
 * `Promise.all`: this runs inside the gateway's statement queue, where the client
 * handed to it is the unqueued one (see the module header of `tauriGateway.ts`).
 * Overlapping them would ask the plugin for a second connection in the middle of
 * the transaction that rebuilds the index.
 */
export async function searchIndexRowsFromContent(client: SqlReader): Promise<SearchDocRow[]> {
  const ayahs = await client.select<{ verse_key: string; text_uthmani: string }>(
    'SELECT verse_key, text_uthmani FROM ayah ORDER BY chapter, verse',
  );
  const translations = await client.select<{ verse_key: string; pack_id: string; text: string }>(
    `SELECT t.verse_key AS verse_key, t.pack_id AS pack_id, t.text AS text
     FROM translation t
     JOIN content_pack p ON p.id = t.pack_id
     WHERE p.kind = 'translation' AND p.language IN ('fa','en')
     ORDER BY t.verse_key, p.id`,
  );
  const packs = await client.select<{ id: string; kind: string; language: string }>(
    "SELECT id, kind, language FROM content_pack WHERE kind = 'translation'",
  );
  return buildSearchIndexRows(
    collectRawSearchDocs(
      ayahs.map((row) => ({ verseKey: row.verse_key as VerseKey, textUthmani: row.text_uthmani })),
      translations.map((row) => ({ verseKey: row.verse_key as VerseKey, packId: row.pack_id, text: row.text })),
      packs.map((row) => ({ id: row.id, kind: row.kind as PackRow['kind'], language: row.language })),
    ),
  );
}

export interface SearchIndexRepair {
  /** False when the stored index was already in the current matching form. */
  rebuilt: boolean;
  /** Verses in the index afterwards (0 when nothing is imported yet). */
  verses: number;
  /** Wall time of the rebuild, 0 when there was nothing to do. */
  ms: number;
}

/**
 * Self-heal an `ayah_search` written before the translation columns were put
 * into the matching space.
 *
 * The index is derived data: `ayah.text_uthmani` and `translation.text` hold the
 * bytes, so a stale index can always be rebuilt from them. Without this a
 * database imported before the fix would keep serving a Persian query as zero
 * hits forever, because its stored translation column is raw text while the
 * query arrives normalised. Nothing but `ayah_search` and the `meta` marker is
 * written — no content row, no user row.
 */
export async function ensureSearchIndexForm(client: SearchIndexClient): Promise<SearchIndexRepair> {
  // Sequential, for the same reason as `searchIndexRowsFromContent` below: the
  // caller holds the only connection, and `BEGIN` must not have to share it.
  const versionRows = await client.select<{ value: string }>('SELECT value FROM meta WHERE key = ?', [
    META_KEY_SEARCH_INDEX,
  ]);
  const countRows = await client.select<{ n: number }>('SELECT COUNT(*) AS n FROM ayah_search');
  const verses = countRows[0]?.n ?? 0;
  const stored = Number.parseInt(versionRows[0]?.value ?? '', 10);
  if (stored === SEARCH_INDEX_VERSION) return { rebuilt: false, verses, ms: 0 };
  if (verses === 0) return { rebuilt: false, verses: 0, ms: 0 }; // nothing imported yet

  const started = Date.now();
  const rows = await searchIndexRowsFromContent(client);
  await client.execute('BEGIN');
  try {
    await client.execute('DELETE FROM ayah_search');
    await writeSearchIndexRows(client, rows);
    await client.execute(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [META_KEY_SEARCH_INDEX, String(SEARCH_INDEX_VERSION)],
    );
    await client.execute('COMMIT');
  } catch (err) {
    await client.execute('ROLLBACK').catch(() => undefined);
    throw err;
  }
  return { rebuilt: true, verses: rows.length, ms: Date.now() - started };
}

/* ----------------------------------------------------------------- internals */

/** One candidate row with the key form of every field it matched. */
interface Candidate {
  verseKey: VerseKey;
  chapter: number;
  verse: number;
  page: number;
  textUthmani: string;
  keys: Record<MatchField, string>;
}

/**
 * Fields of a candidate that hold EVERY query token, i.e. the fields the query
 * genuinely matched. All-tokens is the rule: a two-word Persian query that hits
 * one word in forty ayahs is noise, and the shipped dev shell already behaved
 * this way for its scored fields.
 */
function matchedFields(keys: Record<MatchField, string>, tokens: string[]): MatchField[] {
  return MATCH_FIELD_PRIORITY.filter((field) => {
    const key = keys[field];
    return key !== '' && tokens.every((token) => key.includes(token));
  });
}

/**
 * Which stored translation of a verse to show: the first pack (pack-id order)
 * whose text holds every token, else the first holding the first token, else the
 * first pack. Deterministic, and it never invents a "best" translation.
 */
function pickRawTranslation(candidates: readonly string[], tokens: string[]): string {
  const keys = candidates.map((text) => matchKey(text));
  for (let i = 0; i < candidates.length; i += 1) {
    if (tokens.every((token) => keys[i]!.includes(token))) return candidates[i]!;
  }
  for (let i = 0; i < candidates.length; i += 1) {
    if (tokens[0] !== undefined && keys[i]!.includes(tokens[0])) return candidates[i]!;
  }
  return candidates[0] ?? '';
}

// ------------------------------------------------------------------ SQLite

export interface SqlReader {
  select<TRow>(sql: string, params?: unknown[]): Promise<TRow[]>;
}

export interface SearchService {
  readonly backend: SearchBackend;
  /** Reason a higher-preference backend was skipped, shown in Data health. */
  readonly noteId: SearchNoteId | null;
  search(query: string, options?: SearchOptions): Promise<SearchHit[]>;
}

/** Escape a token for FTS5 MATCH syntax: quoted, internal quotes doubled. */
function ftsPhrase(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

const KEY_SELECT = `
      SELECT s.verse_key            AS verse_key,
             a.chapter              AS chapter,
             a.verse                AS verse,
             a.page                 AS page,
             a.text_uthmani         AS text_uthmani,
             s.arabic               AS k_arabic,
             s.translation_en       AS k_en,
             s.translation_fa       AS k_fa
      FROM ayah_search AS s
      JOIN ayah a ON a.verse_key = s.verse_key`;

interface KeyRow {
  verse_key: string;
  chapter: number;
  verse: number;
  page: number;
  text_uthmani: string;
  k_arabic: string;
  k_en: string;
  k_fa: string;
}

/**
 * The SQLite backend: normalised substring matching over `ayah_search`, with
 * the Arabic column additionally ordered by FTS5 bm25 when the module is there.
 */
export class SqliteSearchService implements SearchService {
  constructor(
    private readonly client: SqlReader,
    readonly backend: 'sqlite-fts5' | 'like',
    readonly noteId: SearchNoteId | null = null,
  ) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const tokens = queryTokens(query);
    if (tokens.length === 0) return [];
    const wanted = options.field ? [options.field] : [...MATCH_FIELD_PRIORITY];

    const candidates = await this.scanCandidates(tokens, wanted);
    const bm25 =
      this.backend === 'sqlite-fts5' && wanted.includes('arabic')
        ? await this.arabicRanks(tokens, limit)
        : new Map<string, number>();

    const scored: {
      candidate: Candidate;
      field: MatchField;
      bm25?: number;
    }[] = [];
    for (const candidate of candidates) {
      for (const field of matchedFields(candidate.keys, tokens)) {
        scored.push({ candidate, field, bm25: bm25.get(candidate.verseKey) });
      }
    }
    scored.sort((a, b) =>
      compareMatchedHits(
        { field: a.field, bm25: a.bm25, chapter: a.candidate.chapter, verse: a.candidate.verse },
        { field: b.field, bm25: b.bm25, chapter: b.candidate.chapter, verse: b.candidate.verse },
      ),
    );

    const page: typeof scored = [];
    const seen = new Set<string>();
    for (const row of scored) {
      if (seen.has(row.candidate.verseKey)) continue; // one verse, its best field
      seen.add(row.candidate.verseKey);
      page.push(row);
      if (page.length >= limit) break;
    }

    const raws = await this.rawTranslations(page, tokens);
    return page.map((row, index) => {
      const language = LANGUAGE_FOR_FIELD[row.field];
      const display =
        language === undefined ? row.candidate.textUthmani : (raws.get(`${row.candidate.verseKey}|${language}`) ?? '');
      return {
        verseKey: row.candidate.verseKey,
        chapter: row.candidate.chapter,
        verse: row.candidate.verse,
        page: row.candidate.page,
        textUthmani: row.candidate.textUthmani,
        field: row.field,
        excerpt: excerptFor(display === '' ? row.candidate.textUthmani : display, [...rawQueryForms(query), ...tokens]),
        rank: index,
      };
    });
  }

  /** Substring scan of the requested columns; every token must appear. */
  private async scanCandidates(tokens: string[], wanted: MatchField[]): Promise<Candidate[]> {
    const columns = wanted.map((field) => COLUMN_FOR_FIELD[field]);
    const perToken = columns.map((column) => `s.${column} LIKE ?`).join(' OR ');
    const params: unknown[] = [];
    for (const token of tokens) for (const _column of columns) params.push(`%${token}%`);
    params.push(CANDIDATE_CAP);
    const rows = await this.client.select<KeyRow>(
      `${KEY_SELECT} WHERE ${tokens.map(() => `(${perToken})`).join(' AND ')}
      ORDER BY a.chapter, a.verse
      LIMIT ?`,
      params,
    );
    return rows.map((row) => ({
      verseKey: row.verse_key as VerseKey,
      chapter: row.chapter,
      verse: row.verse,
      page: row.page,
      textUthmani: row.text_uthmani,
      keys: { arabic: row.k_arabic, 'translation-fa': row.k_fa, 'translation-en': row.k_en },
    }));
  }

  /**
   * FTS5 over the normalised Arabic column, used only for its bm25 ordering of
   * the Arabic hits. Averse absent from this map still appears if the substring
   * scan found it, which is what keeps the two statements from disagreeing.
   */
  private async arabicRanks(tokens: string[], limit: number): Promise<Map<string, number>> {
    const ranks = new Map<string, number>();
    try {
      const rows = await this.client.select<{ verse_key: string; rank: number }>(
        `SELECT s.verse_key AS verse_key, ifnull(rank, 0) AS rank
         FROM ayah_search AS s
         WHERE s MATCH ?
         ORDER BY rank
         LIMIT ?`,
        [tokens.map((token) => `arabic: ${ftsPhrase(token)}`).join(' AND '), Math.max(limit, 1)],
      );
      for (const row of rows) ranks.set(row.verse_key, row.rank);
    } catch {
      // FTS5 module missing, or a MATCH string SQLite refused to parse: the
      // substring scan already covered the Arabic column.
    }
    return ranks;
  }

  /** Byte-exact translation text for the page, so an excerpt is never key form. */
  private async rawTranslations(
    hits: readonly { candidate: Candidate; field: MatchField }[],
    tokens: string[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const languages = new Set(hits.map((h) => LANGUAGE_FOR_FIELD[h.field]).filter((l) => l !== undefined));
    const keys = [...new Set(hits.map((h) => h.candidate.verseKey))];
    if (keys.length === 0 || languages.size === 0) return out;
    const rows = await this.client.select<{ verse_key: string; language: string; text: string }>(
      `SELECT t.verse_key AS verse_key, p.language AS language, t.text AS text
       FROM translation t
       JOIN content_pack p ON p.id = t.pack_id
       WHERE p.kind = 'translation' AND p.language IN (${[...languages]
         .map(() => '?')
         .join(',')}) AND t.verse_key IN (${keys.map(() => '?').join(',')})
       ORDER BY t.verse_key, p.id`,
      [...languages, ...keys],
    );
    const grouped = new Map<string, string[]>();
    for (const row of rows) {
      const bucket = grouped.get(`${row.verse_key}|${row.language}`) ?? [];
      bucket.push(row.text);
      grouped.set(`${row.verse_key}|${row.language}`, bucket);
    }
    for (const hit of hits) {
      const language = LANGUAGE_FOR_FIELD[hit.field];
      if (language === undefined) continue;
      const bucketKey = `${hit.candidate.verseKey}|${language}`;
      const candidates = grouped.get(bucketKey);
      if (!candidates || candidates.length === 0) continue;
      out.set(bucketKey, pickRawTranslation(candidates, tokens));
    }
    return out;
  }
}

/** The words as the user typed them — the needles an excerpt looks for on screen. */
function rawQueryForms(query: string): string[] {
  return query
    .split(/\s+/)
    .map((token) => token.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, ''))
    .filter((token) => token.length > 0);
}

/* -------------------------------------------------------------- dev shell */

/**
 * The dev shell's index: the same `matchKey` space and the same
 * substring rule as SQLite, over the rows the dev loader already holds.
 *
 * Excerpts come from the raw document text, never from the key form, so the
 * mushaf and the translation appear exactly as stored.
 */
interface KeyedEntry {
  doc: RawSearchDoc;
  ayah: AyahRow | undefined;
  keys: Record<MatchField, string>;
}

export class MemorySearchService implements SearchService {
  readonly backend = 'memory-index' as const;
  readonly noteId: SearchNoteId;
  private keyed: KeyedEntry[] | null = null;

  constructor(
    private readonly docs: () => RawSearchDoc[],
    private readonly ayahs: () => AyahRow[],
    noteId: SearchNoteId = 'memory-index-dev',
  ) {
    this.noteId = noteId;
  }

  /** Drop the built keys after an import replaced the content rows. */
  reset(): void {
    this.keyed = null;
  }

  private ensureKeys(): KeyedEntry[] {
    if (this.keyed === null) {
      const byVerse = new Map(this.ayahs().map((ayah) => [ayah.verseKey, ayah]));
      this.keyed = this.docs().map((doc) => ({
        doc,
        ayah: byVerse.get(doc.verseKey),
        keys: {
          arabic: matchKey(doc.textUthmani),
          'translation-fa': matchKey(doc.translationFa),
          'translation-en': matchKey(doc.translationEn),
        },
      }));
    }
    return this.keyed;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const tokens = queryTokens(query);
    if (tokens.length === 0) return [];
    const wanted = options.field ? [options.field] : [...MATCH_FIELD_PRIORITY];
    const scored: { entry: KeyedEntry; field: MatchField }[] = [];
    for (const entry of this.ensureKeys()) {
      if (!entry.ayah) continue;
      for (const field of matchedFields(entry.keys, tokens)) {
        if (wanted.includes(field)) scored.push({ entry, field });
      }
    }
    scored.sort((a, b) =>
      compareMatchedHits({
        field: a.field,
        chapter: a.entry.ayah!.chapter,
        verse: a.entry.ayah!.verse,
      }, {
        field: b.field,
        chapter: b.entry.ayah!.chapter,
        verse: b.entry.ayah!.verse,
      }),
    );
    const out: SearchHit[] = [];
    const seen = new Set<string>();
    for (const row of scored) {
      const ayah = row.entry.ayah!;
      const marker = `${ayah.verseKey}|${row.field}`;
      if (seen.has(marker)) continue;
      seen.add(marker);
      const language = LANGUAGE_FOR_FIELD[row.field];
      const display =
        language === undefined
          ? ayah.textUthmani
          : language === 'fa'
            ? row.entry.doc.translationFa
            : row.entry.doc.translationEn;
      out.push({
        verseKey: ayah.verseKey,
        chapter: ayah.chapter,
        verse: ayah.verse,
        page: ayah.page,
        textUthmani: ayah.textUthmani,
        field: row.field,
        excerpt: excerptFor(display === '' ? ayah.textUthmani : display, [...rawQueryForms(query), ...tokens]),
        rank: out.length,
      });
      if (out.length >= limit) break;
    }
    return out;
  }
}
