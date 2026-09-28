/**
 * Madani mushaf page layout engine (604 pages).
 *
 * The Madani mushaf is a fixed grid: at most `MAX_MUSHAF_LINES` lines per page
 * and every word sits on one specific page and line. A reader that re-flows the
 * text with font metrics produces a *different* book, so this engine never
 * guesses: it groups the tokens by the mushaf metadata the content pipeline
 * captured from the provider's mushaf rows (`page_number`, `line_number`).
 *
 * Two metadata sources exist and they disagree on 56 of 6236 ayahs:
 *   - the word row's own `page_number` (with a `line_number` relative to some
 *     page), and
 *   - `Ayah.page`, the per-ayah page from the divisions rows.
 * The line numbers only make sense against one of them, and the tie-breaker is
 * the mushaf's own reading order: tokens must never go backwards through
 * (page, line) as the verses advance. Anchoring each ayah's tokens on `Ayah.page`
 * (and only then falling back to the word row's page) yields zero reading-order
 * inversions across all 83 665 provider tokens; using the word rows' page
 * blindly yields 25 (see `docs/mushaf-layout.md`). So the default policy is
 * `anchor`, every correction is reported as a diagnostic, and no token is ever
 * moved, dropped or appended silently — words that cannot be placed land in
 * `unplaced` with a reason.
 *
 * Pure and framework-free: no clock, no randomness, no DOM, no fs. Inputs are
 * `AyahWord[]` (+ mushaf metadata) and `Ayah[]`; outputs are plain data, so the
 * same code serves desktop, web and the later Dart port.
 */

import type { Ayah, AyahWord, VerseKey } from '../contracts/quran.js';
import { PAGE_COUNT } from '../contracts/quran.js';

/** Madani mushaf page count — the contract constant, not a local guess. */
export const MUSHAF_PAGE_COUNT = PAGE_COUNT;

/**
 * Maximum lines on one mushaf page.
 *
 * Sourced, not invented: over all 604 pages of the provider mushaf rows
 * (`data/raw/quran-com/words-*.json`, 83 665 word tokens measured 2026-09-28)
 * the highest `line_number` observed is 15, and 488 of 604 pages use exactly 15
 * lines. That matches the printed Mushaf al-Madani, which is set on a 15-line
 * grid. See `docs/mushaf-layout.md` for the distribution.
 */
export const MAX_MUSHAF_LINES = 15;

/** Basmalah as the provider spells it — only 1:1 may carry it as word tokens. */
const BASMALAH_FIRST_TOKEN = 'بِسْمِ';

/* -------------------------------------------------------------------------- */
/* input shapes                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Mushaf metadata a word row may carry. The contract `AyahWord` now ships
 * `pageNumber` / `lineNumber` (the packs carry them, the `ayah_word` table has
 * columns for them), but the engine still has to cope with rows that do not:
 * a hand-fed row, a legacy pack or a corrupt capture is reported in `unplaced`
 * with a reason rather than crashing the build. So the input type *widens* the
 * contract's two fields back to "maybe absent, maybe null, maybe the pack's
 * snake_case spelling" instead of trusting them.
 */
export interface MushafWordMetadata {
  pageNumber?: number | string | null;
  page_number?: number | string | null;
  lineNumber?: number | string | null;
  line_number?: number | string | null;
}

export type LayoutWord = Omit<AyahWord, 'pageNumber' | 'lineNumber'> & MushafWordMetadata;

/** Where the pack says the word sits, before the layout resolves it. */
export interface WordDeclaration {
  page: number | null;
  line: number | null;
}

/* -------------------------------------------------------------------------- */
/* output shapes                                                              */
/* -------------------------------------------------------------------------- */

/** Minimal, stable reference the UI renders. Never an array index. */
export interface WordRef {
  verseKey: VerseKey;
  position: number;
}

/** A `WordRef` plus the provenance needed to audit the placement. */
export interface PlacedWord extends WordRef {
  /** Page the token was actually placed on. */
  page: number;
  /** Line from the provider row (lines are never rewritten). */
  line: number;
  /** Page/line exactly as the word row declared them. */
  declaredPage: number | null;
  declaredLine: number | null;
  /** True when the token was moved onto its ayah's page anchor. */
  pageCorrected: boolean;
  isEndOfAyahMark: boolean;
}

export interface MushafLine {
  pageNumber: number;
  lineNumber: number;
  /** Ordered word references in reading order (RTL display order, provider rows). */
  refs: WordRef[];
  /** Same tokens with provenance, index-aligned with `refs`. */
  words: PlacedWord[];
  /** Distinct verse keys on the line, reading order. */
  verseKeys: VerseKey[];
}

/** Where a surah's first ayah begins on this page. */
export interface SurahStartOnPage {
  chapter: number;
  verseKey: VerseKey;
  /** First line carrying this surah's words. */
  lineNumber: number;
  /** Grid lines above it with no words: the surah title / basmalah band. */
  headingBandLines: number[];
}

export type DiagnosticSeverity = 'info' | 'warning' | 'fatal';

export interface LayoutDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  /** `page:62`, `page:62/line:9`, `5:77` or `5:77:3` — enough to find the row. */
  subject: string;
  detail: string;
}

export type UnplacedReason =
  /** Neither the word row nor its ayah supplied a usable page. */
  | 'missing-page-metadata'
  /** Page known, line number absent: no grid slot exists for it. */
  | 'missing-line-metadata'
  | 'page-out-of-range'
  | 'line-not-positive'
  | 'duplicate-reference'
  | 'invalid-position'
  /** Placing it would read backwards through the mushaf. */
  | 'reading-order-conflict';

/**
 * A token the engine refused to place. These words are *never* appended to the
 * end of a page — that would corrupt the mushaf. The UI must treat a non-empty
 * bucket as an integrity error on the affected pages.
 */
export interface UnplacedWord {
  reason: UnplacedReason;
  verseKey: VerseKey;
  position: number;
  /** The original row, untouched, so the pack can be fixed upstream. */
  word: LayoutWord;
  detail: string;
}

export interface MushafPage {
  pageNumber: number;
  /** Lines carrying words, ascending. Lines the grid has but the rows do not fill are in `emptyLineNumbers`. */
  lines: MushafLine[];
  /**
   * Line numbers between 1 and the last used line that carry no words. In the
   * real mushaf every one of these blocks is a surah heading band (title row +
   * basmalah), which the provider word rows do not emit — see `surahStarts`.
   */
  emptyLineNumbers: number[];
  /** Verse keys on this page, reading order, deduplicated. */
  verseKeys: VerseKey[];
  /** First verse key on the page, or null for an empty page. */
  firstVerseKey: VerseKey | null;
  /** First verse key on the page when it started on an earlier page, else null. */
  continuesVerseFromPreviousPage: VerseKey | null;
  surahStarts: SurahStartOnPage[];
  /** Distinct juz numbers touching this page, ascending. Two entries = a juz boundary page. */
  juzNumbers: number[];
  /** Tokens placed here (word tokens + end-of-ayah marks). */
  tokenCount: number;
  /** Diagnostics scoped to this page. */
  diagnostics: LayoutDiagnostic[];
  /**
   * False when this page has a fatal/warning diagnostic: unplaced words of its
   * own verses, an over-long line, an unexplained line gap. The UI must show an
   * integrity error rather than reflowing.
   */
  isComplete: boolean;
}

export interface MushafLayoutStats {
  /** Rows handed to the engine, end-of-ayah marks included. */
  tokensInInput: number;
  wordTokensInInput: number;
  endMarksInInput: number;
  tokensPlaced: number;
  wordsPlaced: number;
  endMarksPlaced: number;
  tokensUnplaced: number;
  distinctPages: number;
  /** Total lines carrying at least one token, over all pages. */
  distinctLines: number;
  maxLinesOnOnePage: number;
  maxLineNumberObserved: number;
  versesInInput: number;
  ayahsSupplied: number;
  /** Ayahs supplied that received no token at all. */
  ayahsWithoutWords: number;
  /** Word rows whose page was overridden by the ayah anchor. */
  pageCorrections: number;
}

export interface MushafLayout {
  /** Pages carrying at least one token, ascending. See `emptyPages` for the rest. */
  pages: MushafPage[];
  unplaced: UnplacedWord[];
  diagnostics: LayoutDiagnostic[];
  stats: MushafLayoutStats;
  /** In-range page numbers that received no token (expected for partial corpora). */
  emptyPages: number[];
}

export interface BuildLayoutOptions {
  /**
   * `anchor` (default): an ayah's tokens are placed on `Ayah.page` when the word
   * row's own page disagrees and the anchor keeps reading order intact.
   * `word`: trust the word row's page, but still fall back to the anchor when
   * the declared page would read backwards.
   * `word-strict`: trust the word row's page only. Kept for auditing — it is how
   * the provider rows look if the anchor is ignored, and on the real corpus it
   * leaves 25 verses' tokens unplaced instead of corrected.
   */
  pagePolicy?: 'anchor' | 'word' | 'word-strict';
  /** Grid height. Defaults to the sourced `MAX_MUSHAF_LINES`. */
  maxLines?: number;
  /** Grid width. Defaults to the contract's `PAGE_COUNT` (604). */
  pageCount?: number;
  /**
   * When true, pages with no tokens are reported as `empty-page` warnings.
   * Default false: a single-chapter build legitimately has 603 empty pages.
   */
  expectFullCorpus?: boolean;
}

/* -------------------------------------------------------------------------- */
/* small pure helpers                                                         */
/* -------------------------------------------------------------------------- */

function toPositiveInt(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return null;
  return Number.isInteger(n) ? n : Math.trunc(n);
}

/** Page/line as the word row declared them, tolerating camelCase and snake_case. */
export function declaredPlacement(word: LayoutWord): WordDeclaration {
  return {
    page: toPositiveInt(firstDefined(word.pageNumber, word.page_number)),
    line: toPositiveInt(firstDefined(word.lineNumber, word.line_number)),
  };
}

function firstDefined<T>(...values: (T | undefined)[]): T | undefined {
  for (const v of values) if (v !== undefined) return v;
  return undefined;
}

/** `112:3` → `{ chapter: 112, verse: 3 }`; null when the key is malformed. */
export function parseVerseKey(key: string): { chapter: number; verse: number } | null {
  const match = /^(\d+):(\d+)$/.exec(key.trim());
  if (!match) return null;
  const chapter = Number.parseInt(match[1]!, 10);
  const verse = Number.parseInt(match[2]!, 10);
  if (!Number.isFinite(chapter) || !Number.isFinite(verse)) return null;
  return { chapter, verse };
}

function compareVerseKeys(a: string, b: string): number {
  const pa = parseVerseKey(a);
  const pb = parseVerseKey(b);
  if (!pa && !pb) return a < b ? -1 : a > b ? 1 : 0;
  if (!pa) return -1;
  if (!pb) return 1;
  return pa.chapter - pb.chapter || pa.verse - pb.verse || (a < b ? -1 : a > b ? 1 : 0);
}

/** Lexicographic compare of grid positions — the mushaf reading order. */
function comparePageLine(aPage: number, aLine: number, bPage: number, bLine: number): number {
  return aPage - bPage || aLine - bLine;
}

function refKey(verseKey: string, position: number): string {
  return `${verseKey}:${position}`;
}

/* -------------------------------------------------------------------------- */
/* build                                                                      */
/* -------------------------------------------------------------------------- */

interface VerseInput {
  verseKey: string;
  tokens: LayoutWord[];
}

/**
 * Group the word rows into mushaf pages and lines.
 *
 * Never throws: every structural problem is a diagnostic or an entry in
 * `unplaced`, so a partly-broken pack still renders the pages it can prove.
 */
export function buildMushafLayout(
  words: readonly LayoutWord[],
  ayahs: readonly Ayah[],
  options: BuildLayoutOptions = {},
): MushafLayout {
  const maxLines = options.maxLines ?? MAX_MUSHAF_LINES;
  const pageCount = options.pageCount ?? MUSHAF_PAGE_COUNT;
  const policy = options.pagePolicy ?? 'anchor';
  const expectFullCorpus = options.expectFullCorpus ?? false;

  const diagnostics: LayoutDiagnostic[] = [];
  const unplaced: UnplacedWord[] = [];

  /* ---- index the ayahs ---- */
  const ayahIndex = new Map<string, Ayah>();
  for (const ayah of ayahs) {
    const key = String(ayah.verseKey);
    if (ayahIndex.has(key)) {
      diagnostics.push({
        code: 'duplicate-ayah',
        severity: 'fatal',
        subject: key,
        detail: 'two ayah rows share this verse key; the second was ignored',
      });
      continue;
    }
    ayahIndex.set(key, ayah);
  }

  const pageOfAnchor = (key: string): number | null => {
    const ayah = ayahIndex.get(key);
    if (!ayah) return null;
    const page = toPositiveInt(ayah.page);
    if (page === null) return null;
    if (page < 1 || page > pageCount) {
      diagnostics.push({
        code: 'ayah-page-out-of-range',
        severity: 'warning',
        subject: key,
        detail: `ayah page ${page} is outside 1..${pageCount}`,
      });
      return null;
    }
    return page;
  };

  /* ---- group rows by verse ---- */
  const verses = new Map<string, VerseInput>();
  let endMarksInInput = 0;
  let wordTokensInInput = 0;
  for (const word of words) {
    const key = String(word.verseKey);
    if (word.isEndOfAyahMark) endMarksInInput++;
    else wordTokensInInput++;
    let bucket = verses.get(key);
    if (!bucket) {
      bucket = { verseKey: key, tokens: [] };
      verses.set(key, bucket);
    }
    bucket.tokens.push(word);
    if (!ayahIndex.has(key)) {
      diagnostics.push({
        code: 'word-without-ayah',
        severity: 'warning',
        subject: key,
        detail: `word row at position ${word.position} belongs to an ayah that was not supplied`,
      });
    }
  }

  /* ---- place, verse by verse, in mushaf reading order ---- */
  /** page -> line -> placed tokens, in insertion (reading) order */
  const grid = new Map<number, Map<number, PlacedWord[]>>();
  const verseFirstPlacement = new Map<string, { page: number; line: number }>();
  const seenRefs = new Set<string>();
  const correctedVerses = new Set<string>();
  let tokensPlaced = 0;
  let wordsPlaced = 0;
  let endMarksPlaced = 0;
  let cursorPage = 0;
  let cursorLine = 0;

  const lineOf = (page: number, line: number): PlacedWord[] => {
    let byLine = grid.get(page);
    if (!byLine) {
      byLine = new Map<number, PlacedWord[]>();
      grid.set(page, byLine);
    }
    let bucket = byLine.get(line);
    if (!bucket) {
      bucket = [];
      byLine.set(line, bucket);
    }
    return bucket;
  };

  const orderedVerseKeys = [...verses.keys()].sort(compareVerseKeys);

  for (const verseKey of orderedVerseKeys) {
    const bucket = verses.get(verseKey);
    if (!bucket) continue;
    const parsed = parseVerseKey(verseKey);

    /* Deterministic intra-verse order: provider position, then row id, then
     * input index. Position IS the mushaf order inside an ayah; sorting by it
     * never re-orders a word relative to the pack. */
    const tokens = bucket.tokens.map((word, index) => ({ word, index }));
    tokens.sort((a, b) => {
      const pa = toPositiveInt(a.word.position) ?? Number.MAX_SAFE_INTEGER;
      const pb = toPositiveInt(b.word.position) ?? Number.MAX_SAFE_INTEGER;
      return pa - pb || a.word.id - b.word.id || a.index - b.index;
    });

    /* Declared pages of this verse, first-seen order. */
    const declaredPages: number[] = [];
    for (const { word } of tokens) {
      const p = declaredPlacement(word).page;
      if (p !== null && !declaredPages.includes(p)) declaredPages.push(p);
    }
    const anchor = pageOfAnchor(verseKey);
    const firstLine = (() => {
      for (const { word } of tokens) {
        const l = declaredPlacement(word).line;
        if (l !== null) return l;
      }
      return null;
    })();

    /* Candidate pages, in preference order for this policy. */
    const candidates: (number | null)[] = [];
    const push = (value: number | null): void => {
      if (value !== null && !candidates.includes(value)) candidates.push(value);
    };
    if (policy === 'anchor') {
      push(anchor);
      for (const p of declaredPages) push(p);
    } else if (policy === 'word') {
      for (const p of declaredPages) push(p);
      push(anchor);
    } else {
      /* word-strict: no anchor fallback at all */
      for (const p of declaredPages) push(p);
    }

    const orderOk = (page: number): boolean =>
      firstLine === null || comparePageLine(page, firstLine, cursorPage, cursorLine) >= 0;

    let chosen: number | null = null;
    for (const candidate of candidates) {
      if (candidate === null) continue;
      if (candidate < 1 || candidate > pageCount) continue;
      if (orderOk(candidate)) {
        chosen = candidate;
        break;
      }
    }

    if (declaredPages.length > 1) {
      diagnostics.push({
        code: 'verse-spans-pages',
        severity: 'info',
        subject: verseKey,
        detail: `word rows declare lines on ${declaredPages.join(', ')}; each token keeps its own declared page`,
      });
    }
    if (anchor !== null && declaredPages.length <= 1 && (declaredPages[0] ?? null) !== anchor) {
      const declared = declaredPages[0] ?? null;
      let code: string;
      let severity: DiagnosticSeverity;
      let detail: string;
      if (declared === null) {
        code = chosen === null ? 'missing-page-metadata' : 'word-page-from-ayah';
        severity = chosen === null ? 'warning' : 'info';
        detail =
          chosen === null
            ? 'word rows carry no page and no ayah row anchors this verse'
            : `word rows carry no page; the tokens were placed from the ayah's page ${anchor}`;
      } else if (chosen === anchor) {
        code = 'word-page-corrected';
        severity = 'info';
        detail = `word rows say page ${declared}, the ayah's page is ${anchor}; line numbers kept, tokens anchored on ${anchor}`;
      } else if (chosen === declared) {
        code = 'word-page-anchor-disagrees';
        severity = 'info';
        detail = `word rows say page ${declared}, the ayah's page is ${anchor}; the declared page keeps mushaf reading order, so it was used`;
      } else {
        code = 'word-page-conflict';
        severity = 'warning';
        detail = `word rows say page ${declared}, the ayah's page is ${anchor}; neither keeps mushaf reading order from page ${cursorPage} line ${cursorLine}`;
      }
      diagnostics.push({ code, severity, subject: verseKey, detail });
    }

    /* Per token placement. */
    let lastPosition: number | null = null;
    let positionGapReported = false;
    for (const { word } of tokens) {
      const position = toPositiveInt(word.position);
      const declared = declaredPlacement(word);
      const key = refKey(verseKey, position ?? -1);

      if (position === null || position < 1) {
        unplaced.push({
          reason: 'invalid-position',
          verseKey: verseKey as VerseKey,
          position: position ?? 0,
          word,
          detail: 'position must be a positive integer',
        });
        continue;
      }
      if (seenRefs.has(key)) {
        unplaced.push({
          reason: 'duplicate-reference',
          verseKey: verseKey as VerseKey,
          position,
          word,
          detail: `${key} is already placed; a mushaf token may appear exactly once`,
        });
        diagnostics.push({
          code: 'duplicate-reference',
          severity: 'fatal',
          subject: key,
          detail: 'two word rows share verse key + position; the later one was not placed',
        });
        continue;
      }
      if (!positionGapReported && lastPosition !== null && position !== lastPosition + 1) {
        diagnostics.push({
          code: 'position-sequence-gap',
          severity: 'warning',
          subject: verseKey,
          detail: `positions jump from ${lastPosition} to ${position}`,
        });
        positionGapReported = true;
      }
      lastPosition = position;

      if (declared.line === null) {
        const noPageEither = declared.page === null && chosen === null;
        unplaced.push({
          reason: noPageEither ? 'missing-page-metadata' : 'missing-line-metadata',
          verseKey: verseKey as VerseKey,
          position,
          word,
          detail: noPageEither
            ? 'word row carries neither page nor line metadata, and no ayah row anchors it'
            : declared.page === null
              ? `line number absent; the ayah's page ${chosen ?? '-'} would have placed it`
              : `word row has page ${declared.page} but no line number`,
        });
        continue;
      }
      if (declared.line < 1) {
        unplaced.push({
          reason: 'line-not-positive',
          verseKey: verseKey as VerseKey,
          position,
          word,
          detail: `line number ${declared.line} is not on the mushaf grid`,
        });
        continue;
      }

      /* Which page? A verse whose rows are declared on several pages keeps its
       * own page per token (the provider's own split is the layout signal);
       * otherwise use the verse-level choice, falling back to the declaration. */
      let page: number | null;
      if (declaredPages.length > 1) page = declared.page;
      else if (chosen !== null) page = chosen;
      else page = declared.page ?? candidates[0] ?? null;

      if (page === null) {
        unplaced.push({
          reason: 'missing-page-metadata',
          verseKey: verseKey as VerseKey,
          position,
          word,
          detail: 'neither the word row nor its ayah supplies a page number',
        });
        continue;
      }
      if (page < 1 || page > pageCount) {
        unplaced.push({
          reason: 'page-out-of-range',
          verseKey: verseKey as VerseKey,
          position,
          word,
          detail: `page ${page} is outside 1..${pageCount}`,
        });
        diagnostics.push({
          code: 'page-out-of-range',
          severity: 'warning',
          subject: `${verseKey}:${position}`,
          detail: `page ${page} is outside 1..${pageCount}`,
        });
        continue;
      }
      if (comparePageLine(page, declared.line, cursorPage, cursorLine) < 0) {
        /* Would read backwards: refuse the token instead of appending it. */
        unplaced.push({
          reason: 'reading-order-conflict',
          verseKey: verseKey as VerseKey,
          position,
          word,
          detail: `placed at page ${page} line ${declared.line}, behind the cursor at page ${cursorPage} line ${cursorLine}`,
        });
        diagnostics.push({
          code: 'reading-order-conflict',
          severity: 'fatal',
          subject: `${verseKey}:${position}`,
          detail: `page ${page} line ${declared.line} is behind page ${cursorPage} line ${cursorLine} in mushaf reading order`,
        });
        continue;
      }

      const placed: PlacedWord = {
        verseKey: verseKey as VerseKey,
        position,
        page,
        line: declared.line,
        declaredPage: declared.page,
        declaredLine: declared.line,
        pageCorrected: declared.page !== null && page !== declared.page,
        isEndOfAyahMark: word.isEndOfAyahMark,
      };
      if (placed.pageCorrected) correctedVerses.add(verseKey);
      if (declared.line > maxLines) {
        diagnostics.push({
          code: 'line-exceeds-max',
          severity: 'warning',
          subject: `page:${page}/line:${declared.line}`,
          detail: `${verseKey}:${position} declares line ${declared.line}; the mushaf grid is ${maxLines} lines tall`,
        });
      }
      lineOf(page, declared.line).push(placed);
      seenRefs.add(key);
      if (!verseFirstPlacement.has(verseKey)) {
        verseFirstPlacement.set(verseKey, { page, line: declared.line });
      }
      cursorPage = page;
      cursorLine = declared.line;
      tokensPlaced++;
      if (word.isEndOfAyahMark) endMarksPlaced++;
      else wordsPlaced++;
    }
  }

  /* ---- assemble pages ---- */
  const pages: MushafPage[] = [];
  const pagesWithData = [...grid.keys()].sort((a, b) => a - b);
  for (const pageNumber of pagesWithData) {
    const byLine = grid.get(pageNumber);
    if (!byLine) continue;
    const lineNumbers = [...byLine.keys()].sort((a, b) => a - b);
    const lastLine = lineNumbers.length > 0 ? (lineNumbers[lineNumbers.length - 1] ?? 0) : 0;
    const emptyLineNumbers: number[] = [];
    for (let line = 1; line <= lastLine; line++) if (!byLine.has(line)) emptyLineNumbers.push(line);

    const lines: MushafLine[] = [];
    const verseKeys: VerseKey[] = [];
    const seenVerseOnPage = new Set<string>();
    let tokensOnPage = 0;
    for (const lineNumber of lineNumbers) {
      const bucket = byLine.get(lineNumber) ?? [];
      const refs: WordRef[] = [];
      const lineVerseKeys: VerseKey[] = [];
      for (const placed of bucket) {
        refs.push({ verseKey: placed.verseKey, position: placed.position });
        if (!lineVerseKeys.includes(placed.verseKey)) lineVerseKeys.push(placed.verseKey);
        if (!seenVerseOnPage.has(placed.verseKey)) {
          seenVerseOnPage.add(placed.verseKey);
          verseKeys.push(placed.verseKey);
        }
      }
      lines.push({
        pageNumber,
        lineNumber,
        refs,
        words: bucket.slice(),
        verseKeys: lineVerseKeys,
      });
      tokensOnPage += bucket.length;
    }

    /* Surah starts on this page, with their heading bands. */
    const surahStarts: SurahStartOnPage[] = [];
    for (const verseKey of verseKeys) {
      const parsed = parseVerseKey(verseKey);
      if (!parsed || parsed.verse !== 1) continue;
      const first = verseFirstPlacement.get(verseKey);
      if (!first || first.page !== pageNumber) continue;
      const headingBandLines = emptyLineNumbers.filter((line) => line < first.line);
      surahStarts.push({
        chapter: parsed.chapter,
        verseKey: verseKey as VerseKey,
        lineNumber: first.line,
        headingBandLines,
      });
    }

    /* juz numbers touching the page */
    const juzSet = new Set<number>();
    for (const verseKey of verseKeys) {
      const juz = ayahIndex.get(verseKey)?.juz;
      if (typeof juz === 'number') juzSet.add(juz);
    }

    const pageDiagnostics: LayoutDiagnostic[] = [];

    /* Line contiguity: every gap must be the band above a surah start. */
    if (emptyLineNumbers.length > 0) {
      const blocks: number[][] = [];
      let current: number[] = [];
      for (const line of emptyLineNumbers) {
        if (current.length === 0 || line === (current[current.length - 1] ?? 0) + 1) current.push(line);
        else {
          blocks.push(current);
          current = [line];
        }
      }
      if (current.length > 0) blocks.push(current);
      const usedLines = lineNumbers;
      for (const block of blocks) {
        const nextUsed = usedLines.find((line) => line > (block[block.length - 1] ?? 0));
        const start = surahStarts.find((s) => s.lineNumber === nextUsed);
        const explained = Boolean(start);
        pageDiagnostics.push({
          code: explained ? 'surah-heading-band' : 'line-gap',
          severity: explained ? 'info' : 'warning',
          subject: `page:${pageNumber}/line:${block.join(',')}`,
          detail: explained
            ? `lines ${block.join('-')} carry no word rows: the band above surah ${start?.chapter} starting at line ${nextUsed}`
            : `lines ${block.join('-')} carry no word rows and the next used line ${nextUsed ?? '-'} is not a surah start`,
        });
      }
    }

    /* Grid height: a page whose lines fall outside the sourced grid cannot be
     * laid out, and the reader must see an integrity error, not a tall page. */
    const overTallLines = lines.filter((l) => l.lineNumber > maxLines).map((l) => l.lineNumber);
    if (overTallLines.length > 0) {
      pageDiagnostics.push({
        code: 'line-exceeds-max',
        severity: 'warning',
        subject: `page:${pageNumber}/line:${overTallLines.join(',')}`,
        detail: `line ${overTallLines.join('/')} is below the ${maxLines}-line grid floor`,
      });
    }
    if (lines.length > maxLines) {
      pageDiagnostics.push({
        code: 'page-too-tall',
        severity: 'warning',
        subject: `page:${pageNumber}`,
        detail: `${lines.length} lines carry word rows; the mushaf grid is ${maxLines} lines tall`,
      });
    }

    pages.push({
      pageNumber,
      lines,
      emptyLineNumbers,
      verseKeys,
      firstVerseKey: verseKeys[0] ?? null,
      continuesVerseFromPreviousPage: (() => {
        const first = verseKeys[0];
        if (!first) return null;
        const origin = verseFirstPlacement.get(first);
        return origin && origin.page < pageNumber ? first : null;
      })(),
      surahStarts,
      juzNumbers: [...juzSet].sort((a, b) => a - b),
      tokenCount: tokensOnPage,
      diagnostics: pageDiagnostics,
      isComplete: pageDiagnostics.every((d) => d.severity === 'info'),
    });
  }

  /* ---- cross-verse invariants ---- */
  for (const [verseKey, bucket] of verses) {
    const marks = bucket.tokens.filter((t) => t.isEndOfAyahMark);
    if (bucket.tokens.length === 0) continue;
    const placedHere = bucket.tokens.filter((t) => seenRefs.has(refKey(verseKey, toPositiveInt(t.position) ?? -1)));
    if (endMarksInInput > 0 && marks.length === 0 && placedHere.length > 0) {
      diagnostics.push({
        code: 'end-mark-missing',
        severity: 'warning',
        subject: verseKey,
        detail: 'the pack carries end-of-ayah marks for other ayahs but not for this one',
      });
    }
    if (marks.length > 1) {
      diagnostics.push({
        code: 'end-mark-multiple',
        severity: 'fatal',
        subject: verseKey,
        detail: `${marks.length} end-of-ayah marks; the mushaf has exactly one per ayah`,
      });
    }
    if (marks.length === 1 && placedHere.length > 0) {
      const mark = marks[0]!;
      const markPos = toPositiveInt(mark.position) ?? 0;
      const maxWordPos = Math.max(
        ...placedHere.filter((t) => !t.isEndOfAyahMark).map((t) => toPositiveInt(t.position) ?? 0),
        0,
      );
      if (markPos < maxWordPos) {
        diagnostics.push({
          code: 'end-mark-not-last',
          severity: 'warning',
          subject: verseKey,
          detail: `end-of-ayah mark at position ${markPos} precedes word position ${maxWordPos}`,
        });
      }
    }
    /* The basmalah is a mushaf row the provider does not emit as words. A pack
     * that synthesises it into every surah would shift every line. */
    const parsed = parseVerseKey(verseKey);
    if (parsed && parsed.chapter !== 1 && parsed.verse === 1) {
      const firstWord = [...bucket.tokens]
        .filter((t) => !t.isEndOfAyahMark)
        .sort((a, b) => (toPositiveInt(a.position) ?? 0) - (toPositiveInt(b.position) ?? 0))[0];
      if (firstWord && firstWord.textUthmani.trimStart().startsWith(BASMALAH_FIRST_TOKEN)) {
        diagnostics.push({
          code: 'unexpected-basmalah-token',
          severity: 'warning',
          subject: verseKey,
          detail: 'the basmalah appears as a word row; the provider puts it in the heading band, not in the words',
        });
      }
    }
  }

  const emptyPages: number[] = [];
  for (let page = 1; page <= pageCount; page++) {
    if (grid.has(page)) continue;
    emptyPages.push(page);
    if (expectFullCorpus) {
      diagnostics.push({
        code: 'empty-page',
        severity: 'warning',
        subject: `page:${page}`,
        detail: 'full-corpus build with no word rows on this page',
      });
    }
  }

  const maxLinesOnOnePage = pages.reduce((acc, p) => Math.max(acc, p.lines.length), 0);
  const maxLineNumberObserved = pages.reduce(
    (acc, p) => Math.max(acc, ...p.lines.map((l) => l.lineNumber), 0),
    0,
  );
  let ayahsWithoutWords = 0;
  for (const key of ayahIndex.keys()) if (!verses.has(key)) ayahsWithoutWords++;

  const stats: MushafLayoutStats = {
    tokensInInput: words.length,
    wordTokensInInput,
    endMarksInInput,
    tokensPlaced,
    wordsPlaced,
    endMarksPlaced,
    tokensUnplaced: unplaced.length,
    distinctPages: pages.length,
    distinctLines: pages.reduce((acc, p) => acc + p.lines.length, 0),
    maxLinesOnOnePage,
    maxLineNumberObserved,
    versesInInput: verses.size,
    ayahsSupplied: ayahIndex.size,
    ayahsWithoutWords,
    pageCorrections: correctedVerses.size,
  };

  return { pages, unplaced, diagnostics, stats, emptyPages };
}

/**
 * Convenience wrapper for callers that only want the grid. Use
 * `buildMushafLayout` when you also need `unplaced` and the diagnostics — the
 * UI must not ignore them.
 */
export function buildMushafPages(
  words: readonly LayoutWord[],
  ayahs: readonly Ayah[],
  options: BuildLayoutOptions = {},
): MushafPage[] {
  return buildMushafLayout(words, ayahs, options).pages;
}

/* -------------------------------------------------------------------------- */
/* navigation                                                                 */
/* -------------------------------------------------------------------------- */

/** Pre-indexed navigation: build once per layout and reuse. */
export interface MushafNavigation {
  pageOfVerseKey(verseKey: string): number | null;
  page(number: number): MushafPage | null;
  versesOnPage(number: number): VerseKey[];
  firstVerseOnPage(number: number): VerseKey | null;
  lastVerseOnPage(number: number): VerseKey | null;
  /** True when the page's first verse began on an earlier page. */
  pageContinuesVerse(number: number): boolean;
  verseKeysOnLine(verseKey: string, position: number): { page: number; line: number } | null;
  placementOf(verseKey: string, position: number): PlacedWord | null;
  pageRangeOfSurah(chapter: number): { from: number; to: number } | null;
  /** Verses of a surah on one page, reading order. */
  versesOfSurahOnPage(chapter: number, pageNumber: number): VerseKey[];
  surahStartOnPage(pageNumber: number): SurahStartOnPage[];
  juzBoundaryPages: number[];
  pageCount: number;
}

const navigationCache = new WeakMap<readonly MushafPage[], MushafNavigation>();

/** Index every page/line/verse relationship once, in O(tokens). */
export function createMushafNavigation(pages: readonly MushafPage[]): MushafNavigation {
  const cached = navigationCache.get(pages);
  if (cached) return cached;

  const byNumber = new Map<number, MushafPage>();
  const versePage = new Map<string, number>();
  const surahPages = new Map<number, { min: number; max: number }>();
  const placement = new Map<string, { page: number; line: number; placed: PlacedWord }>();
  const surahStartsByPage = new Map<number, SurahStartOnPage[]>();
  const juzBoundaryPages: number[] = [];

  for (const page of pages) {
    byNumber.set(page.pageNumber, page);
    if (page.juzNumbers.length > 1) juzBoundaryPages.push(page.pageNumber);
    if (page.surahStarts.length > 0) surahStartsByPage.set(page.pageNumber, page.surahStarts.slice());
    for (const line of page.lines) {
      for (const word of line.words) {
        placement.set(refKey(word.verseKey, word.position), {
          page: word.page,
          line: word.line,
          placed: word,
        });
        const previous = versePage.get(word.verseKey);
        // A verse may legitimately span pages: keep the earliest page it starts on.
        if (previous === undefined || page.pageNumber < previous) versePage.set(word.verseKey, page.pageNumber);
        const parsed = parseVerseKey(word.verseKey);
        if (parsed) {
          const range = surahPages.get(parsed.chapter);
          if (!range) surahPages.set(parsed.chapter, { min: page.pageNumber, max: page.pageNumber });
          else {
            range.min = Math.min(range.min, page.pageNumber);
            range.max = Math.max(range.max, page.pageNumber);
          }
        }
      }
    }
  }

  const navigation: MushafNavigation = {
    pageOfVerseKey(verseKey) {
      return versePage.get(String(verseKey)) ?? null;
    },
    page(number) {
      return byNumber.get(number) ?? null;
    },
    versesOnPage(number) {
      return byNumber.get(number)?.verseKeys.slice() ?? [];
    },
    firstVerseOnPage(number) {
      return byNumber.get(number)?.firstVerseKey ?? null;
    },
    lastVerseOnPage(number) {
      const keys = byNumber.get(number)?.verseKeys;
      return keys && keys.length > 0 ? keys[keys.length - 1]! : null;
    },
    pageContinuesVerse(number) {
      const found = byNumber.get(number);
      return Boolean(found && found.continuesVerseFromPreviousPage);
    },
    verseKeysOnLine(verseKey, position) {
      const found = placement.get(refKey(String(verseKey), position));
      return found ? { page: found.page, line: found.line } : null;
    },
    placementOf(verseKey, position) {
      return placement.get(refKey(String(verseKey), position))?.placed ?? null;
    },
    pageRangeOfSurah(chapter) {
      const range = surahPages.get(chapter);
      return range ? { from: range.min, to: range.max } : null;
    },
    versesOfSurahOnPage(chapter, pageNumber) {
      const page = byNumber.get(pageNumber);
      if (!page) return [];
      return page.verseKeys.filter((key) => parseVerseKey(key)?.chapter === chapter);
    },
    surahStartOnPage(pageNumber) {
      return surahStartsByPage.get(pageNumber)?.slice() ?? [];
    },
    juzBoundaryPages,
    pageCount: byNumber.size,
  };

  navigationCache.set(pages, navigation);
  return navigation;
}

/** `Ayah.page`-independent: where does this verse's first word actually sit? */
export function pageOfVerseKey(pages: readonly MushafPage[], verseKey: string): number | null {
  return createMushafNavigation(pages).pageOfVerseKey(verseKey);
}

export function versesOnPage(pages: readonly MushafPage[], pageNumber: number): VerseKey[] {
  return createMushafNavigation(pages).versesOnPage(pageNumber);
}

export function firstVerseOnPage(pages: readonly MushafPage[], pageNumber: number): VerseKey | null {
  return createMushafNavigation(pages).firstVerseOnPage(pageNumber);
}

export function pageRangeOfSurah(
  pages: readonly MushafPage[],
  chapter: number,
): { from: number; to: number } | null {
  return createMushafNavigation(pages).pageRangeOfSurah(chapter);
}
