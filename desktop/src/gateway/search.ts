/**
 * Search — one interface, three possible backends.
 *
 *   `core-engine`  the deterministic index in `core/src/search` (owned by the
 *                  search agent). Adopted automatically when `@quran/core`
 *                  exports `createSearchEngine`; nothing else changes.
 *   `sqlite-fts5`  the shipped desktop backend: the `ayah_search` FTS5 virtual
 *                  table created from `core/src/contracts/db.sql`.
 *   `like`         same table set, no FTS5 module in SQLite: normalised token
 *                  LIKE matching. Labelled in the UI, never presented as FTS.
 *   `dev-index`    in-browser dev shell only: the same normalisation over the
 *                  in-memory rows.
 *
 * Every backend receives the raw user query and normalises it with the single
 * definition of "same word" from `core/src/normalize/arabic.ts`.
 */
import { normalizedText } from '@quran/core';
import type { Bookmark, Note, VerseKey } from '@quran/core';
import type { AyahRow, SearchDocRow, SearchHit, SearchOptions } from './types';

export type SearchBackend = 'core-engine' | 'sqlite-fts5' | 'like' | 'dev-index';

export interface SearchService {
  readonly backend: SearchBackend;
  /** Reason a higher-preference backend was skipped, shown in Data health. */
  readonly note: string | null;
  search(query: string, options?: SearchOptions): Promise<SearchHit[]>;
}

const DEFAULT_LIMIT = 40;

/** Tokens the user actually typed, in the same normalised space as the index. */
export function queryTokens(query: string): string[] {
  const clean = query.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  return normalizedText(clean)
    .split(' ')
    .filter((t) => t.length > 0);
}

/** Excerpt around the first hit, with the raw display text (never the index form). */
export function excerptFor(haystack: string, needle: string, radius = 90): string {
  if (haystack === '') return '';
  if (needle === '') return truncate(haystack, radius * 2);
  const lower = haystack.toLowerCase();
  const at = lower.indexOf(needle.toLowerCase());
  if (at < 0) return truncate(haystack, radius * 2);
  const from = Math.max(0, at - radius);
  const to = Math.min(haystack.length, at + needle.length + radius);
  return `${from > 0 ? '…' : ''}${haystack.slice(from, to).trim()}${to < haystack.length ? '…' : ''}`;
}

function truncate(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max).trimEnd()}…`;
}

/**
 * The core search engine (`core/src/search`) as a `SearchService`.
 *
 * This is the drop-in that replaces SQLite FTS5 wherever the corpus is already
 * in memory — the browser dev shell uses it, which is how the shipped search
 * ranking gets exercised before the SQLite path is the only one left. The
 * corpus is handed over as plain contract rows; `buildSearchIndex` is called
 * once, lazily, and every query goes through core's documented ranking.
 */
import {
  buildSearchIndex,
  search as coreSearch,
  textScripts,
  type SearchIndex,
  type SearchQuery,
  type SearchHit as CoreHit,
  type Translation,
  type AyahWord,
} from '@quran/core';

export interface CoreSearchCorpus {
  ayahs: () => AyahRow[];
  translations: () => { verseKey: VerseKey; packId: string; text: string }[];
  words: () => AyahWord[];
  notes?: () => Note[];
  bookmarks?: () => Bookmark[];
}

/** Excerpt centred on the engine's own match ranges — never re-parsed here. */
function excerptFromRanges(rawText: string, ranges: { start: number; end: number }[]): string {
  if (rawText === '') return '';
  if (ranges.length === 0) return truncate(rawText, 160);
  const first = ranges[0]!;
  const last = ranges[ranges.length - 1]!;
  const from = Math.max(0, first.start - 70);
  const to = Math.min(rawText.length, last.end + 70);
  return `${from > 0 ? '…' : ''}${rawText.slice(from, to).trim()}${to < rawText.length ? '…' : ''}`;
}

function fieldOf(hit: CoreHit): SearchHit['field'] {
  if (hit.field === 'translation-fa') return 'translation-fa';
  if (hit.field === 'translation-en') return 'translation-en';
  return 'arabic';
}

export class CoreEngineSearchService implements SearchService {
  readonly backend = 'core-engine' as const;
  readonly note: string | null;
  private index: SearchIndex | null = null;

  constructor(
    private readonly corpus: CoreSearchCorpus,
    note: string | null = 'core/src/search ranking (buildSearchIndex + search)',
  ) {
    this.note = note;
  }

  /** Rebuild from scratch when the corpus changes (a pack import). */
  reset(): void {
    this.index = null;
  }

  private ensureIndex(): SearchIndex {
    if (this.index === null) {
      this.index = buildSearchIndex(
        this.corpus.ayahs(),
        this.corpus.translations() as Translation[],
        this.corpus.words(),
        { notes: this.corpus.notes?.() ?? [], bookmarks: this.corpus.bookmarks?.() ?? [] },
      );
    }
    return this.index;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const text = query.trim();
    if (text.length === 0) return [];
    const index = this.ensureIndex();
    if (index.ayahCount === 0) return [];

    const arabic = textScripts.hasArabicScript(text);
    const kinds: SearchQuery[] = [];
    if (options.field === undefined) {
      if (arabic) {
        kinds.push({ type: 'arabic-phrase', text, match: 'exact' });
        kinds.push({ type: 'arabic-phrase', text, match: 'prefix' });
      }
      kinds.push({ type: 'translation', language: 'en', text });
      kinds.push({ type: 'translation', language: 'fa', text });
      if (index.userDataAvailable) kinds.push({ type: 'user-text', text });
    } else if (options.field === 'arabic') {
      kinds.push({ type: 'arabic-phrase', text, match: 'exact' });
      kinds.push({ type: 'arabic-phrase', text, match: 'prefix' });
    } else {
      kinds.push({
        type: 'translation',
        language: options.field === 'translation-fa' ? 'fa' : 'en',
        text,
      });
    }

    const ayahByVerse = new Map<string, AyahRow>(index.docs.map((d) => [d.ayah.verseKey, d.ayah as AyahRow]));
    const seen = new Map<string, SearchHit>();
    for (const q of kinds) {
      const response = coreSearch(index, q);
      for (const hit of response.hits) {
        if (hit.verseKey === null) continue;
        const ayah = ayahByVerse.get(hit.verseKey);
        if (!ayah) continue;
        const field = fieldOf(hit);
        const key = `${hit.verseKey}|${field}`;
        const mapped: SearchHit = {
          verseKey: ayah.verseKey,
          chapter: ayah.chapter,
          verse: ayah.verse,
          page: ayah.page,
          textUthmani: ayah.textUthmani,
          field,
          excerpt: excerptFromRanges(hit.rawText, hit.ranges),
          rank: -hit.score,
        };
        const previous = seen.get(key);
        if (previous === undefined || previous.rank > mapped.rank) seen.set(key, mapped);
      }
    }
    return [...seen.values()].sort((a, b) => a.rank - b.rank || a.chapter - b.chapter || a.verse - b.verse).slice(0, limit);
  }
}

// ------------------------------------------------------------------ SQLite

export interface SqlReader {
  select<TRow>(sql: string, params?: unknown[]): Promise<TRow[]>;
}

interface FtsRow {
  verse_key: string;
  chapter: number;
  verse: number;
  page: number;
  text_uthmani: string;
  translation_en: string | null;
  translation_fa: string | null;
  score: number;
}

/** Escape a token for the FTS5 MATCH syntax: quoted, internal quotes doubled. */
function ftsPhrase(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

export class SqliteSearchService implements SearchService {
  constructor(
    private readonly client: SqlReader,
    readonly backend: 'sqlite-fts5' | 'like',
    readonly note: string | null = null,
  ) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const tokens = queryTokens(query);
    if (tokens.length === 0) return [];
    return this.backend === 'sqlite-fts5'
      ? this.searchFts(tokens, limit, options.field)
      : this.searchLike(tokens, limit, options.field);
  }

  private async searchFts(tokens: string[], limit: number, field?: SearchOptions['field']): Promise<SearchHit[]> {
    const match = tokens.map(ftsPhrase).join(' AND ');
    const column = field === 'translation-en' ? 'translation_en' : field === 'translation-fa' ? 'translation_fa' : null;
    const where = column ? `s.${column} MATCH ?` : 's MATCH ?';
    const sql = `
      SELECT s.verse_key            AS verse_key,
             a.chapter              AS chapter,
             a.verse                AS verse,
             a.page                 AS page,
             a.text_uthmani         AS text_uthmani,
             s.translation_en       AS translation_en,
             s.translation_fa       AS translation_fa,
             ifnull(rank, 0)        AS score
      FROM ayah_search AS s
      JOIN ayah a ON a.verse_key = s.verse_key
      WHERE ${where}
      ORDER BY rank
      LIMIT ?`;
    const rows = await this.client.select<FtsRow>(sql, column ? [match, limit] : [match, limit]);
    return rows.map((row) => hitFromRow(row, tokens));
  }

  private async searchLike(tokens: string[], limit: number, field?: SearchOptions['field']): Promise<SearchHit[]> {
    // Normalised-space LIKE: the `arabic` column already stores the core
    // normalisation, and diacritics are stripped again by the comparison below.
    const clauses = tokens.map(() => '(s.arabic LIKE ? OR s.translation_en LIKE ? OR s.translation_fa LIKE ?)');
    const params: unknown[] = [];
    for (const token of tokens) params.push(`%${token}%`, `%${token}%`, `%${token}%`);
    const sql = `
      SELECT s.verse_key      AS verse_key,
             a.chapter        AS chapter,
             a.verse          AS verse,
             a.page           AS page,
             a.text_uthmani   AS text_uthmani,
             s.translation_en AS translation_en,
             s.translation_fa AS translation_fa
      FROM ayah_search AS s
      JOIN ayah a ON a.verse_key = s.verse_key
      WHERE ${clauses.join(' AND ')}
      LIMIT ?`;
    const rows = await this.client.select<Omit<FtsRow, 'score'>>(sql, [...params, limit]);
    return rows
      .map((row) => hitFromRow({ ...row, score: 0 }, tokens))
      .filter((hit) => (field ? hit.field === field : true))
      .slice(0, limit);
  }
}

function hitFromRow(row: FtsRow, tokens: string[]): SearchHit {
  const verseKey = row.verse_key as VerseKey;
  const en = row.translation_en ?? '';
  const fa = row.translation_fa ?? '';
  const matched =
    tokens.find((t) => fa.toLowerCase().includes(t.toLowerCase())) !== undefined
      ? 'translation-fa'
      : tokens.find((t) => en.toLowerCase().includes(t.toLowerCase())) !== undefined
        ? 'translation-en'
        : 'arabic';
  const sourceText = matched === 'translation-fa' ? fa : matched === 'translation-en' ? en : row.text_uthmani;
  return {
    verseKey,
    chapter: row.chapter,
    verse: row.verse,
    page: row.page,
    textUthmani: row.text_uthmani,
    field: matched,
    excerpt: excerptFor(sourceText, tokens[0] ?? ''),
    rank: row.score,
  };
}

// -------------------------------------------------------------- dev shell

export class MemorySearchService implements SearchService {
  readonly backend = 'dev-index' as const;
  readonly note: string | null;

  constructor(
    private readonly docs: () => SearchDocRow[],
    private readonly ayahs: () => AyahRow[],
    note: string | null = 'browser dev shell index — not the shipped SQLite path',
  ) {
    this.note = note;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const tokens = queryTokens(query);
    if (tokens.length === 0) return [];
    const ayahByVerse = new Map(this.ayahs().map((a) => [a.verseKey, a]));
    const hits: SearchHit[] = [];
    for (const doc of this.docs()) {
      const en = doc.translationEn.toLowerCase();
      const fa = doc.translationFa.toLowerCase();
      const ar = doc.arabic.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        const t = token.toLowerCase();
        if (t.length === 0) continue;
        if (ar.includes(t)) score += 3;
        if (en.includes(t) || fa.includes(t)) score += 2;
      }
      if (score === 0) continue;
      const ayah = ayahByVerse.get(doc.verseKey);
      if (!ayah) continue;
      const field: SearchHit['field'] = fa.includes(tokens[0] ?? '') && !ar.includes(tokens[0] ?? '')
        ? 'translation-fa'
        : en.includes(tokens[0] ?? '') && !ar.includes(tokens[0] ?? '')
          ? 'translation-en'
          : 'arabic';
      const sourceText = field === 'translation-fa' ? doc.translationFa : field === 'translation-en' ? doc.translationEn : ayah.textUthmani;
      hits.push({
        verseKey: ayah.verseKey,
        chapter: ayah.chapter,
        verse: ayah.verse,
        page: ayah.page,
        textUthmani: ayah.textUthmani,
        field,
        excerpt: excerptFor(sourceText, tokens[0] ?? ''),
        rank: -score,
      });
    }
    return hits.sort((a, b) => a.rank - b.rank).slice(0, limit);
  }
}
