/**
 * Deterministic, framework-free search over the Quran corpus.
 *
 * The module is pure: all content arrives as arguments to `buildSearchIndex`,
 * so the whole system is testable with fixture arrays. No clock, no
 * randomness, no network, no `RegExp` built from user input (queries are
 * matched literally, token by token — regex metacharacters in a query are
 * inert by construction).
 *
 * Normalisation is never re-implemented here: Arabic-script comparison uses
 * `normalizeWord` / `tokenizeWords` / `searchKey` from `../normalize/arabic`,
 * which is the single place where "the same word" is defined. The only local
 * normalisation is the Latin script path (`latinKey`/`latinTokensLower`),
 * because the Arabic path intentionally discards non-Arabic characters and
 * therefore cannot index English text. Latin normalisation is *not* Arabic
 * normalisation: it never touches Quran text.
 *
 * See `docs/search-system.md` for the ranking model, thresholds and limits.
 */

import type {
  Ayah,
  AyahWord,
  Bookmark,
  Concept,
  ConceptAyahLink,
  Note,
  Translation,
  VerseKey,
} from '../contracts/quran';
import { normalizeWord, searchKey, tokenizeWords } from '../normalize/arabic';

/* ------------------------------------------------------------------ */
/* Named constants — documented in docs/search-system.md              */
/* ------------------------------------------------------------------ */

/** Queries longer than this are rejected before any scanning happens. */
export const MAX_QUERY_CHARS = 512;
/** Queries with more tokens than this are rejected (pathological input guard). */
export const MAX_QUERY_TOKENS = 32;
/** Maximum hits returned by `search` when no explicit limit is given. */
export const DEFAULT_RESULT_LIMIT = 200;
/** Hard ceiling for an explicit limit — keeps the response bounded. */
export const MAX_RESULT_LIMIT = 2000;

/* Ranking weights (additive; see docs for the worked explanation). */
export const WEIGHT_TOKEN_MATCH = 1;
export const WEIGHT_COVERAGE = 4;
export const WEIGHT_CONTIGUOUS_PHRASE = 2;
/** Earlier matches get a bounded bonus: WEIGHT_POSITION / (1 + firstTokenIndex). */
export const WEIGHT_POSITION = 1;
export const WEIGHT_FIELD_ARABIC = 3;
export const WEIGHT_FIELD_TRANSLATION = 2;
export const WEIGHT_FIELD_CONCEPT_LABEL = 2;
export const WEIGHT_FIELD_CONCEPT_DESCRIPTION = 1;
export const WEIGHT_FIELD_USER = 1;
/**
 * Scattered (non-contiguous) matching for translation/concept/user-text
 * queries must cover at least this fraction of query tokens, otherwise a
 * single common word would drag unrelated ayahs into the results.
 */
export const MIN_SCATTER_COVERAGE = 0.5;

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export type SearchLanguage = 'ar' | 'fa' | 'en';

export type SearchHitField =
  | 'arabic'
  | 'word'
  | 'root'
  | 'translation-fa'
  | 'translation-en'
  | 'concept'
  | 'note'
  | 'bookmark';

export type SearchRejectReason =
  /** Query was empty or whitespace/punctuation only. */
  | 'empty-query'
  /** Query produced no matchable token (e.g. diacritics-only input). */
  | 'empty-after-normalization'
  | 'query-too-long'
  | 'query-too-many-tokens'
  /** Root query but the corpus carries no root data — return nothing, never guess. */
  | 'roots-unavailable'
  /** Concept query but no concept pack was attached. */
  | 'no-concept-pack'
  /** User-text query but no notes/bookmarks were attached. */
  | 'no-user-data';

/** Half-open UTF-16 code-unit range into `SearchHit.rawText`, logical order. */
export interface MatchRange {
  start: number;
  end: number;
}

export interface SearchQueryBase {
  limit?: number;
}

/**
 * Query kinds. Each is matched with documented, literal semantics:
 *
 * - `arabic-phrase` `exact`: the query tokens appear as a contiguous run of
 *   normalised ayah tokens. `prefix`: same run, but each query token may be a
 *   prefix of the ayah token (diacritic-insensitive stem-ish matching).
 * - `arabic-word`: one normalised token, matched exactly wherever it occurs.
 * - `root`: matched against `AyahWord.root` under normalised equality only.
 * - `translation`: query tokens matched against translations of one language.
 *   `fa`/`ar` use the Arabic normalisation path; `en` uses the Latin path.
 * - `concept`: matched against Concept labels/descriptions of the attached pack.
 * - `user-text`: matched against Note bodies and Bookmark labels.
 */
export type SearchQuery =
  | (SearchQueryBase & { type: 'arabic-phrase'; text: string; match: 'exact' | 'prefix' })
  | (SearchQueryBase & { type: 'arabic-word'; text: string })
  | (SearchQueryBase & { type: 'root'; text: string })
  | (SearchQueryBase & { type: 'translation'; language: 'fa' | 'en'; text: string })
  | (SearchQueryBase & { type: 'concept'; text: string })
  | (SearchQueryBase & { type: 'user-text'; text: string });

export interface IndexedTranslation {
  packId: string;
  language: SearchLanguage;
  /** Raw translation text — `ranges` from hits index into this string. */
  text: string;
  normalizedTokens: string[];
}

export interface IndexedWord {
  position: number;
  /** Raw surface form as it appears in `textUthmani`. */
  raw: string;
  /** `normalizeWord(raw)` — the single canonical identity of the word. */
  normalized: string;
  /** Half-open range of the word inside the parent ayah's `textUthmani`. */
  range: MatchRange;
  root: string | null;
  /** Normalised root key, or null when the data does not provide one. */
  rootKey: string | null;
  translationEn: string | null;
  transliteration: string | null;
}

export interface SearchAyahDoc {
  ayah: Ayah;
  /** Raw whitespace-split tokens with offsets (display slicing source). */
  rawTokens: { text: string; start: number }[];
  /** Canonical token stream: `tokenizeWords(textUthmani)` then `normalizeWord`. */
  normalizedTokens: string[];
  translations: IndexedTranslation[];
  words: IndexedWord[];
}

export interface SearchConceptEntry {
  concept: Concept;
  verseKeys: VerseKey[];
}

export interface SearchIndexOptions {
  concepts?: Concept[];
  conceptLinks?: ConceptAyahLink[];
  notes?: Note[];
  bookmarks?: Bookmark[];
}

export interface SearchHit {
  verseKey: VerseKey | null;
  field: SearchHitField;
  score: number;
  /** Fraction of query tokens matched, 0..1. */
  coverage: number;
  /** Match ranges into `rawText`, ascending, half-open, UTF-16 code units. */
  ranges: MatchRange[];
  /** The exact string the ranges index into — the UI never re-parses. */
  rawText: string;
  conceptId: string | null;
  conceptVerseKeys: VerseKey[] | null;
  noteId: string | null;
}

export interface SearchResponse {
  queryType: SearchQuery['type'];
  hits: SearchHit[];
  /** Non-null when the query was rejected before matching (hits is then []). */
  rejected: SearchRejectReason | null;
  /** Extra machine-readable note, e.g. `index-uses-default-normalization`. */
  notes: string[];
}

export interface SearchIndex {
  version: number;
  ayahCount: number;
  hasRoots: boolean;
  docs: SearchAyahDoc[];
  /** verseKey → doc, for callers that hold a key. */
  byVerseKey: Map<VerseKey, SearchAyahDoc>;
  /** Normalised root key → occurrences. Empty when the data has no roots. */
  rootBuckets: Map<string, { verseKey: VerseKey; word: IndexedWord }[]>;
  conceptEntries: SearchConceptEntry[];
  conceptAvailable: boolean;
  notes: Note[];
  bookmarks: Bookmark[];
  userDataAvailable: boolean;
}

/* ------------------------------------------------------------------ */
/* Script handling: latin path + safe per-character mapping           */
/* ------------------------------------------------------------------ */

/** A character is handled by the Arabic-script normalisation path when
 * normalizeWord keeps it and it is not an ASCII digit the path folds away. */
function isArabicScriptChar(ch: string): boolean {
  const n = normalizeWord(ch);
  if (n.length !== 1) return false;
  const cp = n.charCodeAt(0);
  if (cp >= 0x30 && cp <= 0x39) return false; // folded digit — not Arabic text
  return (cp >= 0x0600 && cp <= 0x06ff) || (cp >= 0xfb50 && cp <= 0xfdff);
}

function hasArabicScript(text: string): boolean {
  for (const ch of text) if (isArabicScriptChar(ch)) return true;
  return false;
}

function hasLatinScript(text: string): boolean {
  return /[A-Za-z]/.test(text);
}

/**
 * Latin-script key: lowercase, everything that is not a latin letter or digit
 * becomes a separator, apostrophes dropped. This exists ONLY for non-Arabic
 * text (English translations, user notes); Quran text is never run through a
 * Latin normaliser. It is deliberately not a re-implementation of Arabic
 * normalisation — for Arabic input it yields nothing useful, and callers must
 * route Arabic through `normalizeWord`/`searchKey`.
 */
export function latinKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/['\u2018\u2019\u02BC]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Latin token stream aligned to `latinKey` semantics. */
export function latinTokensLower(text: string): string[] {
  const k = latinKey(text);
  return k.length === 0 ? [] : k.split(' ');
}

/**
 * For each character that survives `normalizeWord(input)`, the index of the
 * matching UTF-16 code unit in `input`.
 *
 * This does not re-implement normalisation: it asks `normalizeWord` about one
 * character at a time. That composes because every rule in
 * `../normalize/arabic` rewrites or deletes a single code unit — none of them
 * spans two characters — so filtering raw characters by
 * `normalizeWord(ch) === norm[i]` reproduces the whole-word result exactly.
 */
function normalizedCharOffsets(input: string, norm: string): number[] {
  const out: number[] = [];
  let i = 0;
  for (let r = 0; r < input.length && i < norm.length; r++) {
    const ch = input[r]!;
    if (i < norm.length && norm[i] === normalizeWord(ch)) {
      out.push(r);
      i++;
    }
  }
  return out;
}

/**
 * Raw tokens with offsets, aligned with `normalizedTokens` (the canonical
 * stream from `tokenizeWords` + `normalizeWord`). A raw token is assigned to
 * normalizedTokens[i] when the normalized stream can be consumed as an
 * ordered subsequence starting at that token — this tolerates rare
 * multi-code-unit rewrites while keeping the canonical stream authoritative.
 */
function alignRawTokens(text: string, normalizedTokens: string[]): { text: string; start: number }[] {
  const raws: { text: string; start: number }[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) raws.push({ text: m[0], start: m.index });

  let consumed = 0;
  let cursor = 0; // number of normalized tokens already assigned
  const aligned: ({ text: string; start: number } | null)[] = raws.map(() => null);
  for (let k = 0; k < raws.length; k++) {
    if (cursor >= normalizedTokens.length) break;
    consumed += raws[k]!.text.length;
    const remaining = normalizedTokens.length - cursor;
    const rawLeft = raws.length - k;
    if (rawLeft === remaining) {
      // Forced alignment: one raw token per remaining normalized token.
      for (let j = k; j < raws.length; j++) aligned[j] = raws[j]!;
      break;
    }
    if (normalizedCharOffsets(raws[k]!.text, normalizedTokens[cursor]!).length > 0) {
      aligned[k] = raws[k]!;
      cursor++;
    }
    // else: ornamental stop mark or fully-discarded token — skipped, exactly
    // like tokenizeWords would skip it.
  }
  const out: { text: string; start: number }[] = [];
  for (const a of aligned) if (a !== null) out.push(a);
  // Defensive: keep the arrays parallel even if alignment somehow fell short.
  while (out.length < normalizedTokens.length) {
    out.push({ text: normalizedTokens[out.length]!, start: consumed });
  }
  return out.slice(0, normalizedTokens.length);
}

/* ------------------------------------------------------------------ */
/* Index building                                                     */
/* ------------------------------------------------------------------ */

function translationLanguage(packId: string): SearchLanguage {
  if (/-fa-/.test(packId)) return 'fa';
  if (/-ar-/.test(packId)) return 'ar';
  return 'en';
}

function buildAyahDoc(ayah: Ayah, translations: Translation[], words: AyahWord[]): SearchAyahDoc {
  const normalizedTokens = tokenizeWords(ayah.textUthmani).map(normalizeWord);
  const rawTokens = alignRawTokens(ayah.textUthmani, normalizedTokens);

  const trs: IndexedTranslation[] = [];
  for (const t of translations) {
    const language = translationLanguage(t.packId);
    const tokens =
      language === 'en' ? latinTokensLower(t.text) : tokenizeWords(t.text).map(normalizeWord);
    trs.push({ packId: t.packId, language, text: t.text, normalizedTokens: tokens });
  }

  const ayahWords: IndexedWord[] = [];
  // Word rows arrive with 1-based positions; sort so positional range
  // assignment is correct even for unordered input.
  const sortedWords = [...words].sort(
    (a, b) => a.position - b.position || a.id - b.id,
  );
  const contentWords = sortedWords.filter((w) => !w.isEndOfAyahMark);
  const positional = contentWords.length === rawTokens.length;
  contentWords.forEach((w, i) => {
    const normalized = normalizeWord(w.textUthmani);
    let range: MatchRange = { start: -1, end: -1 };
    const rt = positional ? rawTokens[i] : rawTokens.find((r) => normalizeWord(r.text) === normalized);
    if (rt !== undefined) {
      // Highlight span = the whole raw token including its harakat: a
      // memoriser must see the exact vocalised word, and trimming would
      // produce UTF-16 offsets that cut through the written form.
      range = { start: rt.start, end: rt.start + rt.text.length };
    }
    ayahWords.push({
      position: w.position,
      raw: w.textUthmani,
      normalized,
      range,
      root: w.root,
      rootKey: w.root === null ? null : normalizeWord(w.root),
      translationEn: w.translationEn,
      transliteration: w.transliteration,
    });
  });

  return {
    ayah,
    rawTokens,
    normalizedTokens,
    translations: trs,
    words: ayahWords,
  };
}

/**
 * Build the search index. All content arrives as arguments; the index holds
 * raw text plus canonical token streams per ayah and is serialisable (plain
 * objects, Maps converted by the caller) for SQLite FTS5 or in-memory use.
 *
 * `concepts`/`conceptLinks` attach a concept pack; `notes`/`bookmarks` attach
 * user text. Without them the corresponding query kinds return a rejected,
 * empty response with a machine-readable reason.
 */
export function buildSearchIndex(
  ayahs: Ayah[],
  translations: Translation[] = [],
  words: AyahWord[] = [],
  options: SearchIndexOptions = {},
): SearchIndex {
  const docs = ayahs.map((a) =>
    buildAyahDoc(
      a,
      translations.filter((t) => t.verseKey === a.verseKey),
      words.filter((w) => w.verseKey === a.verseKey),
    ),
  );

  const byVerseKey = new Map<VerseKey, SearchAyahDoc>();
  for (const d of docs) byVerseKey.set(d.ayah.verseKey, d);

  const rootBuckets = new Map<string, { verseKey: VerseKey; word: IndexedWord }[]>();
  let hasRoots = false;
  for (const d of docs) {
    for (const w of d.words) {
      if (w.rootKey === null || w.rootKey.length === 0) continue;
      hasRoots = true;
      const list = rootBuckets.get(w.rootKey);
      if (list) list.push({ verseKey: d.ayah.verseKey, word: w });
      else rootBuckets.set(w.rootKey, [{ verseKey: d.ayah.verseKey, word: w }]);
    }
  }

  const linkMap = new Map<string, VerseKey[]>();
  for (const l of options.conceptLinks ?? []) {
    const list = linkMap.get(l.conceptId);
    if (list) list.push(l.verseKey);
    else linkMap.set(l.conceptId, [l.verseKey]);
  }
  const conceptEntries: SearchConceptEntry[] = (options.concepts ?? []).map((c) => ({
    concept: c,
    verseKeys: (linkMap.get(c.id) ?? []).slice().sort(compareVerseKeyText),
  }));

  return {
    version: 1,
    ayahCount: docs.length,
    hasRoots,
    docs,
    byVerseKey,
    rootBuckets,
    conceptEntries,
    conceptAvailable: conceptEntries.length > 0,
    notes: options.notes ?? [],
    bookmarks: options.bookmarks ?? [],
    userDataAvailable: (options.notes?.length ?? 0) > 0 || (options.bookmarks?.length ?? 0) > 0,
  };
}

/* ------------------------------------------------------------------ */
/* Query normalisation and guards                                     */
/* ------------------------------------------------------------------ */

interface PreparedQuery {
  tokens: { ar: string; latin: string }[];
}

function prepareTokens(text: string): { tokens: PreparedQuery['tokens']; reason: SearchRejectReason | null } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { tokens: [], reason: 'empty-query' };
  if (trimmed.length > MAX_QUERY_CHARS) return { tokens: [], reason: 'query-too-long' };
  const raws = trimmed.split(/\s+/).filter((t) => t.length > 0);
  if (raws.length > MAX_QUERY_TOKENS) return { tokens: [], reason: 'query-too-many-tokens' };

  const tokens: PreparedQuery['tokens'] = [];
  for (const raw of raws) {
    // Both script paths run on the SAME raw token so positional alignment is
    // kept for mixed-script queries; empty keys simply never match.
    const ar = normalizeWord(raw);
    const latRaw = latinTokensLower(raw);
    const latin = latRaw.length === 1 ? latRaw[0]! : latRaw.join('');
    if (ar.length > 0 || latin.length > 0) tokens.push({ ar, latin });
  }
  if (tokens.length === 0) return { tokens: [], reason: 'empty-after-normalization' };
  return { tokens, reason: null };
}

function tokenMatches(docKey: { ar: string; latin: string }, q: { ar: string; latin: string }, prefix: boolean): boolean {
  if (q.ar.length > 0) {
    if (prefix ? docKey.ar.startsWith(q.ar) : docKey.ar === q.ar) return true;
  }
  if (q.latin.length > 0) {
    if (prefix ? docKey.latin.startsWith(q.latin) : docKey.latin === q.latin) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Matching                                                           */
/* ------------------------------------------------------------------ */

interface BestRun {
  start: number;
  end: number;
  coverage: number;
  contiguous: boolean;
  matched: number;
  /** When set (scattered match), the matched doc token indexes to highlight. */
  indices: number[] | null;
}

function findContiguousRun(
  docKeys: { ar: string; latin: string }[],
  q: PreparedQuery['tokens'],
  prefix: boolean,
): BestRun | null {
  const qn = q.length;
  for (let i = 0; i + qn <= docKeys.length; i++) {
    let ok = true;
    for (let j = 0; j < qn; j++) {
      if (!tokenMatches(docKeys[i + j]!, q[j]!, prefix)) {
        ok = false;
        break;
      }
    }
    if (ok) return { start: i, end: i + qn, coverage: 1, contiguous: true, matched: qn, indices: null };
  }
  return null;
}

/**
 * Match strategy shared by every query kind:
 * 1. a contiguous run under strict normalised equality;
 * 2. if `prefix`, a contiguous run under prefix equality;
 * 3. unless `requireContiguous`, an order-preserving greedy subsequence
 *    (partial coverage allowed), whose reported ranges are the longest
 *    contiguous window inside it.
 */
function bestRun(
  docKeys: { ar: string; latin: string }[],
  q: PreparedQuery['tokens'],
  opts: { prefix: boolean; requireContiguous: boolean },
): BestRun | null {
  const strict = findContiguousRun(docKeys, q, false);
  if (strict) return strict;
  if (opts.prefix) {
    const pref = findContiguousRun(docKeys, q, true);
    if (pref) return pref;
  }
  if (opts.requireContiguous) return null;

  const qn = q.length;
  const matchedIdx: number[] = [];
  let qj = 0;
  for (let i = 0; i < docKeys.length && qj < qn; i++) {
    if (tokenMatches(docKeys[i]!, q[qj]!, opts.prefix)) {
      matchedIdx.push(i);
      qj++;
    }
  }
  if (matchedIdx.length === 0) return null;
  // Longest contiguous sub-window of the matched positions (for ranges).
  let bestS = matchedIdx[0]!;
  let bestLen = 1;
  let runS = matchedIdx[0]!;
  let prev = matchedIdx[0]!;
  for (let k = 1; k < matchedIdx.length; k++) {
    const cur = matchedIdx[k]!;
    if (cur === prev + 1) {
      prev = cur;
      if (prev - runS + 1 > bestLen) {
        bestLen = prev - runS + 1;
        bestS = runS;
      }
    } else {
      runS = cur;
      prev = cur;
    }
  }
  const coverage = matchedIdx.length / qn;
  if (coverage < MIN_SCATTER_COVERAGE) return null;
  return {
    start: bestS,
    end: bestS + bestLen,
    coverage,
    contiguous: matchedIdx.length === qn && bestLen === qn,
    matched: matchedIdx.length,
    indices: matchedIdx,
  };
}

interface MatchableKey {
  ar: string;
  latin: string;
  /** Display range for highlighting: whole raw token for Arabic-script
   * tokens, trimmed of surrounding punctuation for latin tokens. */
  range: MatchRange;
}

/** Trim surrounding non-alphanumeric code points from a raw token span.
 * Tokens containing Arabic-script characters are NEVER trimmed: their edge
 * characters are letters or harakat that belong to the word. For latin
 * tokens this only strips punctuation (commas, question marks). */
function trimTokenSpan(raw: string, start: number): MatchRange {
  for (const ch of raw) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x0600 && cp <= 0x06ff) return { start, end: start + raw.length };
  }
  let s = 0;
  while (s < raw.length && !/[\p{L}\p{N}]/u.test(raw[s]!)) s++;
  let e = raw.length;
  while (e > s && !/[\p{L}\p{N}]/u.test(raw[e - 1]!)) e--;
  if (s >= e) return { start, end: start + raw.length };
  return { start: start + s, end: start + e };
}

function docKeysForText(text: string): MatchableKey[] {
  const out: MatchableKey[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const lat = latinTokensLower(m[0]);
    out.push({
      ar: normalizeWord(m[0]),
      latin: lat.length === 1 ? lat[0]! : lat.join(''),
      range: trimTokenSpan(m[0], m.index),
    });
  }
  return out;
}

function rangesForWindow(keys: MatchableKey[], run: BestRun): MatchRange[] {
  const indexes = run.indices ?? Array.from({ length: run.end - run.start }, (_, i) => run.start + i);
  const ranges: MatchRange[] = [];
  for (const i of indexes.sort((a, b) => a - b)) {
    const k = keys[i];
    if (k) ranges.push({ ...k.range });
  }
  return ranges;
}

function scoreFor(
  coverage: number,
  matchedTokens: number,
  contiguous: boolean,
  firstTokenIndex: number,
  fieldWeight: number,
): number {
  return (
    WEIGHT_TOKEN_MATCH * matchedTokens +
    WEIGHT_COVERAGE * coverage +
    (contiguous ? WEIGHT_CONTIGUOUS_PHRASE : 0) +
    WEIGHT_POSITION / (1 + Math.max(0, firstTokenIndex)) +
    fieldWeight
  );
}

function compareHit(a: SearchHit, b: SearchHit): number {
  if (b.score !== a.score) return b.score - a.score;
  // Deterministic tie-break: canonical pair order of verseKey, then field,
  // then concept/note id. `verseKey` is `chapter:verse` — compared as text it
  // is not numeric order, so split it.
  const ka = parseKeyForSort(a.verseKey);
  const kb = parseKeyForSort(b.verseKey);
  if (ka[0] !== kb[0]) return ka[0] - kb[0];
  if (ka[1] !== kb[1]) return ka[1] - kb[1];
  if (a.field !== b.field) return a.field < b.field ? -1 : 1;
  const ia = a.conceptId ?? a.noteId ?? '';
  const ib = b.conceptId ?? b.noteId ?? '';
  if (ia !== ib) return ia < ib ? -1 : 1;
  return 0;
}

function parseKeyForSort(key: VerseKey | null): [number, number] {
  if (key === null) return [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
  const [c, v] = key.split(':');
  return [Number(c), Number(v)];
}

function compareVerseKeyText(a: VerseKey, b: VerseKey): number {
  const [ca, va] = a.split(':');
  const [cb, vb] = b.split(':');
  const cn = Number(ca) - Number(cb);
  if (cn !== 0) return cn;
  return Number(va) - Number(vb);
}

/* ------------------------------------------------------------------ */
/* Query implementations                                              */
/* ------------------------------------------------------------------ */

function searchArabicLike(
  index: SearchIndex,
  q: PreparedQuery['tokens'],
  opts: { prefix: boolean; requireContiguous: boolean },
  field: 'arabic' | 'word',
): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const doc of index.docs) {
    const keys: MatchableKey[] = doc.normalizedTokens.map((ar, i) => {
      const rt = doc.rawTokens[i];
      return {
        ar,
        latin: '',
        range: { start: rt?.start ?? 0, end: (rt?.start ?? 0) + (rt?.text.length ?? 0) },
      };
    });
    const run = bestRun(keys, q, opts);
    if (!run) continue;
    hits.push({
      verseKey: doc.ayah.verseKey,
      field,
      conceptId: null,
      conceptVerseKeys: null,
      noteId: null,
      score: scoreFor(run.coverage, run.matched, run.contiguous, run.start, WEIGHT_FIELD_ARABIC),
      coverage: run.coverage,
      ranges: rangesForWindow(keys, run),
      rawText: doc.ayah.textUthmani,
    });
  }
  return hits;
}

function searchRoot(index: SearchIndex, qText: string): { hits: SearchHit[]; rejected: SearchRejectReason | null } {
  if (!index.hasRoots) return { hits: [], rejected: 'roots-unavailable' };
  const target = normalizeWord(qText);
  if (target.length === 0) return { hits: [], rejected: 'empty-after-normalization' };
  const hits: SearchHit[] = [];
  for (const doc of index.docs) {
    let matched = 0;
    let firstWordPos = Number.MAX_SAFE_INTEGER;
    const ranges: MatchRange[] = [];
    for (const w of doc.words) {
      if (w.rootKey !== null && w.rootKey === target) {
        matched++;
        firstWordPos = Math.min(firstWordPos, w.position);
        if (w.range.start >= 0) ranges.push({ ...w.range });
      }
    }
    if (matched === 0) continue;
    const coverage = doc.words.length > 0 ? matched / doc.words.length : 0;
    hits.push({
      verseKey: doc.ayah.verseKey,
      field: 'root',
      conceptId: null,
      conceptVerseKeys: null,
      noteId: null,
      score: scoreFor(coverage, matched, false, firstWordPos, WEIGHT_FIELD_ARABIC),
      coverage,
      ranges: ranges.sort((a, b) => a.start - b.start),
      rawText: doc.ayah.textUthmani,
    });
  }
  return { hits, rejected: null };
}

function searchTranslations(index: SearchIndex, language: 'fa' | 'en', q: PreparedQuery['tokens']): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const doc of index.docs) {
    for (const tr of doc.translations) {
      if (tr.language !== language) continue;
      const keys = docKeysForText(tr.text);
      // For 'en' the Arabic keys are empty (normalizeWord discards latin
      // letters), so matching falls out to the latin keys automatically.
      const run = bestRun(keys, q, { prefix: false, requireContiguous: false });
      if (!run) continue;
      hits.push({
        verseKey: doc.ayah.verseKey,
        field: language === 'fa' ? 'translation-fa' : 'translation-en',
        conceptId: null,
        conceptVerseKeys: null,
        noteId: null,
        score: scoreFor(run.coverage, run.matched, run.contiguous, run.start, WEIGHT_FIELD_TRANSLATION),
        coverage: run.coverage,
        ranges: rangesForWindow(keys, run),
        rawText: tr.text,
      });
    }
  }
  return hits;
}

interface ConceptField {
  label: 'labelArabic' | 'labelFa' | 'labelEn' | 'descriptionFa';
  weight: number;
}

const CONCEPT_FIELDS: ConceptField[] = [
  { label: 'labelArabic', weight: WEIGHT_FIELD_CONCEPT_LABEL },
  { label: 'labelFa', weight: WEIGHT_FIELD_CONCEPT_LABEL },
  { label: 'labelEn', weight: WEIGHT_FIELD_CONCEPT_LABEL },
  { label: 'descriptionFa', weight: WEIGHT_FIELD_CONCEPT_DESCRIPTION },
];

function conceptText(c: Concept, label: ConceptField['label']): string {
  switch (label) {
    case 'labelArabic':
      return c.labelArabic;
    case 'labelFa':
      return c.labelFa;
    case 'labelEn':
      return c.labelEn;
    case 'descriptionFa':
      return c.descriptionFa;
  }
}

function searchConcepts(index: SearchIndex, q: PreparedQuery['tokens']): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const entry of index.conceptEntries) {
    for (const f of CONCEPT_FIELDS) {
      const text = conceptText(entry.concept, f.label);
      if (text.length === 0) continue;
      const keys = docKeysForText(text);
      const run = bestRun(keys, q, { prefix: false, requireContiguous: false });
      if (!run) continue;
      hits.push({
        verseKey: null,
        field: 'concept',
        conceptId: entry.concept.id,
        conceptVerseKeys: entry.verseKeys,
        noteId: null,
        score: scoreFor(run.coverage, run.matched, run.contiguous, run.start, f.weight),
        coverage: run.coverage,
        ranges: rangesForWindow(keys, run),
        rawText: text,
      });
    }
  }
  return hits;
}

function searchUserData(index: SearchIndex, q: PreparedQuery['tokens']): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const note of index.notes) {
    const keys = docKeysForText(note.body);
    const run = bestRun(keys, q, { prefix: false, requireContiguous: false });
    if (!run) continue;
    hits.push({
      verseKey: note.verseKey,
      field: 'note',
      conceptId: null,
      conceptVerseKeys: null,
      noteId: note.id,
      score: scoreFor(run.coverage, run.matched, run.contiguous, run.start, WEIGHT_FIELD_USER),
      coverage: run.coverage,
      ranges: rangesForWindow(keys, run),
      rawText: note.body,
    });
  }
  for (const bm of index.bookmarks) {
    if (bm.label === null || bm.label.trim().length === 0) continue;
    const keys = docKeysForText(bm.label);
    const run = bestRun(keys, q, { prefix: false, requireContiguous: false });
    if (!run) continue;
    hits.push({
      verseKey: bm.verseKey,
      field: 'bookmark',
      conceptId: null,
      conceptVerseKeys: null,
      noteId: bm.id,
      score: scoreFor(run.coverage, run.matched, run.contiguous, run.start, WEIGHT_FIELD_USER),
      coverage: run.coverage,
      ranges: rangesForWindow(keys, run),
      rawText: bm.label,
    });
  }
  return hits;
}

/* ------------------------------------------------------------------ */
/* Public query entry                                                 */
/* ------------------------------------------------------------------ */

/**
 * Run a query against the index. Never throws: pathological input (empty,
 * diacritics-only, absurdly long, regex metacharacters) produces an empty
 * hit list with a machine-readable `rejected` reason.
 */
export function search(index: SearchIndex, query: SearchQuery): SearchResponse {
  const notesOut: string[] = [];
  if (index.docs.length > 0 && index.docs.every((d) => d.words.length === 0)) {
    notesOut.push('no-word-level-data');
  }

  const base = (rejected: SearchRejectReason | null, hits: SearchHit[] = []): SearchResponse => ({
    queryType: query.type,
    hits: rejected !== null ? [] : hits,
    rejected,
    notes: notesOut,
  });

  let limit = query.limit ?? DEFAULT_RESULT_LIMIT;
  if (!Number.isFinite(limit) || limit < 0) limit = 0;
  limit = Math.min(limit, MAX_RESULT_LIMIT);

  switch (query.type) {
    case 'root': {
      const trimmed = query.text.trim();
      if (trimmed.length === 0) return base('empty-query');
      if (trimmed.length > MAX_QUERY_CHARS) return base('query-too-long');
      if (!index.hasRoots) return base('roots-unavailable');
      const res = searchRoot(index, trimmed);
      if (res.rejected !== null) return base(res.rejected);
      const sorted = res.hits.sort(compareHit).slice(0, limit);
      return base(null, sorted);
    }
    case 'concept': {
      if (!index.conceptAvailable) return base('no-concept-pack');
      const prep = prepareTokens(query.text);
      if (prep.reason !== null) return base(prep.reason);
      const sorted = searchConcepts(index, prep.tokens).sort(compareHit).slice(0, limit);
      return base(null, sorted);
    }
    case 'user-text': {
      if (!index.userDataAvailable) return base('no-user-data');
      const prep = prepareTokens(query.text);
      if (prep.reason !== null) return base(prep.reason);
      const sorted = searchUserData(index, prep.tokens).sort(compareHit).slice(0, limit);
      return base(null, sorted);
    }
    case 'translation': {
      const prep = prepareTokens(query.text);
      if (prep.reason !== null) return base(prep.reason);
      const sorted = searchTranslations(index, query.language, prep.tokens).sort(compareHit).slice(0, limit);
      return base(null, sorted);
    }
    case 'arabic-word': {
      const prep = prepareTokens(query.text);
      if (prep.reason !== null) return base(prep.reason);
      if (prep.tokens.length !== 1) return base('query-too-many-tokens');
      const sorted = searchArabicLike(index, prep.tokens, { prefix: false, requireContiguous: true }, 'word')
        .sort(compareHit)
        .slice(0, limit);
      return base(null, sorted);
    }
    case 'arabic-phrase': {
      const prep = prepareTokens(query.text);
      if (prep.reason !== null) return base(prep.reason);
      const sorted = searchArabicLike(index, prep.tokens, { prefix: query.match === 'prefix', requireContiguous: true }, 'arabic')
        .sort(compareHit)
        .slice(0, limit);
      return base(null, sorted);
    }
  }
}

/** Exported so tests and docs can point at the canonical key builder. */
export function ayahSearchKey(textUthmani: string): string {
  return searchKey(textUthmani);
}

/** Script helper exported for UI callers that must choose a render path. */
export const textScripts = {
  hasArabicScript,
  hasLatinScript,
};
