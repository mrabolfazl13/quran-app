/**
 * Layout validation: the audit report the reader needs before it trusts a page.
 *
 * Everything here is a count or a named defect against a page / line / verse
 * key. Nothing throws, because a partly valid mushaf is still readable page by
 * page — but `ok === false` means the UI must show an integrity error instead of
 * reflowing the page into something that only looks like a mushaf.
 *
 * Sourced thresholds: the 15-line page height comes from the provider mushaf
 * rows themselves (max observed `line_number` = 15 over all 604 pages; see
 * `MAX_MUSHAF_LINES` and `docs/mushaf-layout.md`), the 604-page width comes from
 * the shared contract constant `PAGE_COUNT`.
 */

import type { Ayah } from '../contracts/quran.js';
import type {
  LayoutDiagnostic,
  MushafLayout,
  MushafPage,
  PlacedWord,
  UnplacedWord,
} from './layout.js';
import {
  MAX_MUSHAF_LINES,
  MUSHAF_PAGE_COUNT,
  parseVerseKey,
} from './layout.js';

export type DefectSeverity = 'info' | 'warning' | 'fatal';

export interface LayoutDefect {
  code: string;
  severity: DefectSeverity;
  /** Human-locatable subject: `page:121`, `page:121/line:12`, `5:77`, `5:77:3`. */
  subject: string;
  detail: string;
  page: number | null;
  line: number | null;
  verseKey: string | null;
}

export interface ValidationCounts {
  /** Rows the layout was built from (word tokens + end-of-ayah marks). */
  tokensInInput: number | null;
  tokensPlaced: number;
  /** Word tokens only, end-of-ayah marks excluded. */
  wordsPlaced: number;
  endMarksPlaced: number;
  tokensUnplaced: number;
  unplacedByReason: Record<string, number>;
  distinctPages: number;
  /** Lines carrying at least one token, summed over pages. */
  distinctLines: number;
  maxLinesOnOnePage: number;
  /** Grid slots that carry no words (surah heading bands). */
  emptyLineSlots: number;
  /** Of those, the ones directly above a surah start, i.e. explained. */
  explainedEmptyLineSlots: number;
  /** Word rows moved onto their ayah's page anchor. */
  pageCorrections: number;
  /** Sum of `Ayah.wordCount` over the supplied ayahs — the tokeniser's answer. */
  tokenisedWordsExpected: number;
  /** `tokenisedWordsExpected - wordsPlaced`; non-zero means text and rows disagree. */
  wordTotalDelta: number;
  ayahsSupplied: number;
  versesWithPlacedWords: number;
  duplicateReferences: number;
  readingOrderInversions: number;
  pagesWithDefects: number;
}

export interface LayoutValidationReport {
  ok: boolean;
  counts: ValidationCounts;
  defects: LayoutDefect[];
  fatalCount: number;
  warningCount: number;
  infoCount: number;
}

export interface ValidateLayoutOptions {
  /** Layout's own `unplaced` bucket, when only the pages were passed in. */
  unplaced?: readonly UnplacedWord[];
  maxLines?: number;
  pageCount?: number;
  /**
   * Require every page 1..pageCount to exist and every supplied ayah to have
   * words. Off by default so a single-chapter fixture validates cleanly; the
   * reader sets it true once the full corpus is loaded.
   */
  expectFullCorpus?: boolean;
  /**
   * Compare `wordsPlaced` with the sum of `Ayah.wordCount`. Default true —
   * the provider rows disagree with the authoritative text on 4 ayahs, which is
   * reported as warnings naming each verse key, never as a silent pass.
   */
  checkTokenisedTotals?: boolean;
}

/** Either a full layout (preferred) or its pages. */
export type ValidatableLayout = MushafLayout | readonly MushafPage[];

function isMushafLayout(input: ValidatableLayout): input is MushafLayout {
  return Array.isArray((input as MushafLayout).pages);
}

function defect(
  code: string,
  severity: DefectSeverity,
  subject: string,
  detail: string,
  parts: { page?: number | null; line?: number | null; verseKey?: string | null } = {},
): LayoutDefect {
  return {
    code,
    severity,
    subject,
    detail,
    page: parts.page ?? null,
    line: parts.line ?? null,
    verseKey: parts.verseKey ?? null,
  };
}

/**
 * Audit a built layout against the ayah list it was built from.
 *
 * Checks that matter (all reported, none enforced by exception):
 *  - no `{verseKey, position}` appears twice anywhere in the mushaf;
 *  - placed word tokens vs the tokenised total over the authoritative text;
 *  - no page taller than the documented 15-line grid, page numbers 1..604;
 *  - every line gap is a surah heading band, otherwise it is a defect;
 *  - mushaf reading order never goes backwards;
 *  - every ayah's tokens are present, positions contiguous, one end mark last;
 *  - nothing sits in `unplaced`.
 */
export function validateLayout(
  input: ValidatableLayout,
  ayahs: readonly Ayah[],
  options: ValidateLayoutOptions = {},
): LayoutValidationReport {
  const maxLines = options.maxLines ?? MAX_MUSHAF_LINES;
  const pageCount = options.pageCount ?? MUSHAF_PAGE_COUNT;
  const expectFullCorpus = options.expectFullCorpus ?? false;
  const checkTokenisedTotals = options.checkTokenisedTotals ?? true;

  const pages: readonly MushafPage[] = isMushafLayout(input) ? input.pages : input;
  const unplaced: readonly UnplacedWord[] =
    options.unplaced ?? (isMushafLayout(input) ? input.unplaced : []);

  const defects: LayoutDefect[] = [];
  const ayahIndex = new Map<string, Ayah>();
  for (const ayah of ayahs) {
    if (ayahIndex.has(String(ayah.verseKey))) {
      defects.push(
        defect(
          'duplicate-ayah-row',
          'fatal',
          String(ayah.verseKey),
          'two ayah rows share this verse key',
          { verseKey: String(ayah.verseKey) },
        ),
      );
      continue;
    }
    ayahIndex.set(String(ayah.verseKey), ayah);
  }

  /* ---- walk the grid once, in reading order ---- */
  const seenRefs = new Map<string, { page: number; line: number }>();
  const verseTokens = new Map<string, PlacedWord[]>();
  const pageNumbers = new Set<number>();
  const duplicateRefs = new Set<string>();
  let tokensPlaced = 0;
  let wordsPlaced = 0;
  let endMarksPlaced = 0;
  let distinctLines = 0;
  let maxLinesOnOnePage = 0;
  let emptyLineSlots = 0;
  let explainedEmptyLineSlots = 0;
  let pageCorrections = 0;
  let readingOrderInversions = 0;

  let cursor: { chapter: number; verse: number; position: number } | null = null;
  let previousGrid: { page: number; line: number } | null = null;

  for (const page of pages) {
    pageNumbers.add(page.pageNumber);

    if (page.pageNumber < 1 || page.pageNumber > pageCount) {
      defects.push(
        defect(
          'page-out-of-range',
          'fatal',
          `page:${page.pageNumber}`,
          `page number is outside 1..${pageCount}`,
          { page: page.pageNumber },
        ),
      );
    }
    if (page.lines.length > maxLines) {
      defects.push(
        defect(
          'page-too-tall',
          'fatal',
          `page:${page.pageNumber}`,
          `${page.lines.length} lines with words; the mushaf grid is ${maxLines} lines tall`,
          { page: page.pageNumber },
        ),
      );
    }
    maxLinesOnOnePage = Math.max(maxLinesOnOnePage, page.lines.length);

    /* line numbers on the grid, ascending and inside the page height */
    let previousLine = 0;
    for (const line of page.lines) {
      if (line.lineNumber <= previousLine) {
        defects.push(
          defect(
            'line-out-of-order',
            'fatal',
            `page:${page.pageNumber}/line:${line.lineNumber}`,
            `line ${line.lineNumber} follows ${previousLine}; lines must ascend`,
            { page: page.pageNumber, line: line.lineNumber },
          ),
        );
      }
      if (line.lineNumber > maxLines) {
        defects.push(
          defect(
            'line-exceeds-max',
            'fatal',
            `page:${page.pageNumber}/line:${line.lineNumber}`,
            `line ${line.lineNumber} is below the ${maxLines}-line grid floor`,
            { page: page.pageNumber, line: line.lineNumber },
          ),
        );
      }
      previousLine = line.lineNumber;
      distinctLines++;

      /* line contiguity, with the heading-band explanation */
      const gapBlock: number[] = [];
      for (let gap = previousLine - 1; gap >= 1; gap--) {
        if (page.emptyLineNumbers.includes(gap)) gapBlock.unshift(gap);
        else break;
      }
      if (gapBlock.length > 0) {
        emptyLineSlots += gapBlock.length;
        const isHeadingBand = page.surahStarts.some((s) => s.lineNumber === previousLine);
        if (isHeadingBand) explainedEmptyLineSlots += gapBlock.length;
        else {
          defects.push(
            defect(
              'line-gap',
              'warning',
              `page:${page.pageNumber}/line:${gapBlock.join(',')}`,
              `lines ${gapBlock.join('-')} carry no word rows and line ${previousLine} is not a surah start`,
              { page: page.pageNumber, line: gapBlock[0] ?? null },
            ),
          );
        }
      }

      for (const ref of line.refs) {
        const key = `${ref.verseKey}:${ref.position}`;
        const placed = line.words.find(
          (w) => w.verseKey === ref.verseKey && w.position === ref.position,
        );
        if (!placed) {
          defects.push(
            defect(
              'ref-without-token',
              'fatal',
              key,
              `line ${page.pageNumber}/${line.lineNumber} references ${key} with no placed token`,
              {
                page: page.pageNumber,
                line: line.lineNumber,
                verseKey: String(ref.verseKey),
              },
            ),
          );
          continue;
        }

        if (seenRefs.has(key)) {
          const first = seenRefs.get(key)!;
          duplicateRefs.add(key);
          defects.push(
            defect(
              'duplicate-reference',
              'fatal',
              key,
              `also placed at page ${first.page} line ${first.line}; a mushaf token appears exactly once`,
              {
                page: page.pageNumber,
                line: line.lineNumber,
                verseKey: String(ref.verseKey),
              },
            ),
          );
          continue;
        }
        seenRefs.set(key, { page: page.pageNumber, line: line.lineNumber });
        tokensPlaced++;
        if (placed.isEndOfAyahMark) endMarksPlaced++;
        else wordsPlaced++;
        if (placed.pageCorrected) pageCorrections++;

        const bucket = verseTokens.get(String(ref.verseKey));
        if (bucket) bucket.push(placed);
        else verseTokens.set(String(ref.verseKey), [placed]);

        const parsed = parseVerseKey(String(ref.verseKey));
        if (parsed) {
          const current = { chapter: parsed.chapter, verse: parsed.verse, position: ref.position };
          if (cursor && compareTokens(current, cursor) <= 0) {
            readingOrderInversions++;
            defects.push(
              defect(
                'reading-order-inversion',
                'fatal',
                key,
                `follows ${cursor.chapter}:${cursor.verse}:${cursor.position} on page ${page.pageNumber} line ${line.lineNumber}`,
                {
                  page: page.pageNumber,
                  line: line.lineNumber,
                  verseKey: String(ref.verseKey),
                },
              ),
            );
          }
          cursor = current;
        }
      }
    }

    if (previousGrid && page.pageNumber < previousGrid.page) {
      defects.push(
        defect(
          'page-out-of-order',
          'fatal',
          `page:${page.pageNumber}`,
          `page ${page.pageNumber} follows page ${previousGrid.page} in the layout array`,
          { page: page.pageNumber },
        ),
      );
    }
    previousGrid = { page: page.pageNumber, line: previousLine };
  }

  /* ---- totals against the authoritative text ---- */
  let tokenisedWordsExpected = 0;
  for (const ayah of ayahIndex.values()) {
    tokenisedWordsExpected += Number.isFinite(ayah.wordCount) ? ayah.wordCount : 0;
  }
  const wordTotalDelta = tokenisedWordsExpected - wordsPlaced;

  if (checkTokenisedTotals && wordTotalDelta !== 0) {
    defects.push(
      defect(
        'word-total-vs-tokenised',
        'warning',
        'corpus',
        `${wordsPlaced} word tokens placed but the authoritative texts tokenise to ${tokenisedWordsExpected} (delta ${wordTotalDelta}); the provider word rows and the ayah text disagree`,
      ),
    );
  }

  /* ---- per-verse completeness ---- */
  const endMarksExist = endMarksPlaced > 0;
  for (const [verseKey, tokens] of verseTokens) {
    const ayah = ayahIndex.get(verseKey);
    const positions = tokens.map((t) => t.position).sort((a, b) => a - b);
    for (let expected = 1; expected <= (positions[positions.length - 1] ?? 0); expected++) {
      if (!positions.includes(expected)) {
        defects.push(
          defect(
            'position-gap',
            'warning',
            verseKey,
            `no token at position ${expected}; placed positions are ${positions.join(',')}`,
            { verseKey, page: tokens[0]?.page ?? null, line: tokens[0]?.line ?? null },
          ),
        );
        break;
      }
    }
    const marks = tokens.filter((t) => t.isEndOfAyahMark);
    if (marks.length > 1) {
      defects.push(
        defect(
          'end-mark-multiple',
          'fatal',
          verseKey,
          `${marks.length} end-of-ayah marks placed; the mushaf has exactly one per ayah`,
          { verseKey },
        ),
      );
    }
    if (endMarksExist && marks.length === 0) {
      defects.push(
        defect(
          'end-mark-missing',
          'warning',
          verseKey,
          'this ayah has no end-of-ayah mark while other ayahs do',
          { verseKey },
        ),
      );
    }
    if (ayah && marks.length === 1) {
      const mark = marks[0]!;
      const lastWord = tokens
        .filter((t) => !t.isEndOfAyahMark)
        .reduce((acc, t) => Math.max(acc, t.position), 0);
      if (mark.position < lastWord) {
        defects.push(
          defect(
            'end-mark-not-last',
            'warning',
            verseKey,
            `end-of-ayah mark at position ${mark.position} precedes word position ${lastWord}`,
            { verseKey, page: mark.page, line: mark.line },
          ),
        );
      }
    }
    if (ayah && checkTokenisedTotals) {
      const words = tokens.filter((t) => !t.isEndOfAyahMark).length;
      if (words !== ayah.wordCount) {
        defects.push(
          defect(
            'verse-word-count',
            'warning',
            verseKey,
            `word rows place ${words} tokens but the ayah text tokenises to ${ayah.wordCount}`,
            { verseKey, page: tokens[0]?.page ?? null, line: tokens[0]?.line ?? null },
          ),
        );
      }
    }
  }

  for (const [verseKey, ayah] of ayahIndex) {
    if (!verseTokens.has(verseKey)) {
      defects.push(
        defect(
          expectFullCorpus ? 'verse-not-placed' : 'verse-not-placed-partial',
          expectFullCorpus ? 'fatal' : 'warning',
          verseKey,
          `ayah supplied but none of its ${ayah.wordCount} words were placed`,
          { verseKey, page: ayah.page },
        ),
      );
    }
  }

  /* ---- page coverage ---- */
  if (expectFullCorpus) {
    const missing: number[] = [];
    for (let page = 1; page <= pageCount; page++) if (!pageNumbers.has(page)) missing.push(page);
    if (missing.length > 0) {
      defects.push(
        defect(
          'missing-pages',
          'fatal',
          `pages:1-${pageCount}`,
          `${missing.length} page(s) have no words: ${formatRun(missing)}`,
        ),
      );
    }
  }

  /* ---- unplaced bucket ---- */
  const unplacedByReason: Record<string, number> = {};
  for (const entry of unplaced) {
    unplacedByReason[entry.reason] = (unplacedByReason[entry.reason] ?? 0) + 1;
    defects.push(
      defect(
        `unplaced-${entry.reason}`,
        'fatal',
        `${entry.verseKey}:${entry.position}`,
        entry.detail,
        { verseKey: String(entry.verseKey) },
      ),
    );
  }
  if (unplaced.length === 0 && isMushafLayout(input) && input.stats.tokensInInput !== undefined) {
    if (input.stats.tokensPlaced !== input.stats.tokensInInput) {
      defects.push(
        defect(
          'token-count-mismatch',
          'fatal',
          'corpus',
          `${input.stats.tokensInInput} rows in, ${input.stats.tokensPlaced} placed, ${unplaced.length} reported unplaced`,
        ),
      );
    }
  }

  /* ---- layout diagnostics the audit above cannot recompute ---- */
  const passthrough = new Set([
    'word-page-conflict',
    'ayah-page-out-of-range',
    'word-without-ayah',
    'unexpected-basmalah-token',
  ]);
  if (isMushafLayout(input)) {
    for (const d of input.diagnostics as readonly LayoutDiagnostic[]) {
      if (d.severity === 'info') continue;
      if (!passthrough.has(d.code)) continue;
      defects.push(
        defect(d.code, d.severity, d.subject, d.detail, {
          verseKey: parseVerseKey(d.subject) ? d.subject : null,
        }),
      );
    }
  }

  const fatalCount = defects.filter((d) => d.severity === 'fatal').length;
  const warningCount = defects.filter((d) => d.severity === 'warning').length;
  const infoCount = defects.filter((d) => d.severity === 'info').length;
  const pagesWithDefects = new Set(
    defects.filter((d) => d.page !== null && d.severity !== 'info').map((d) => d.page as number),
  ).size;

  const counts: ValidationCounts = {
    tokensInInput: isMushafLayout(input) ? input.stats.tokensInInput : null,
    tokensPlaced,
    wordsPlaced,
    endMarksPlaced,
    tokensUnplaced: unplaced.length,
    unplacedByReason,
    distinctPages: pageNumbers.size,
    distinctLines,
    maxLinesOnOnePage,
    emptyLineSlots,
    explainedEmptyLineSlots,
    pageCorrections,
    tokenisedWordsExpected,
    wordTotalDelta,
    ayahsSupplied: ayahIndex.size,
    versesWithPlacedWords: verseTokens.size,
    duplicateReferences: duplicateRefs.size,
    readingOrderInversions,
    pagesWithDefects,
  };

  return {
    ok: fatalCount === 0,
    counts,
    defects,
    fatalCount,
    warningCount,
    infoCount,
  };
}

function compareTokens(
  a: { chapter: number; verse: number; position: number },
  b: { chapter: number; verse: number; position: number },
): number {
  return a.chapter - b.chapter || a.verse - b.verse || a.position - b.position;
}

/** `[1,2,3,7]` → `1-3, 7` — keeps long defect lists readable. */
function formatRun(values: readonly number[]): string {
  if (values.length === 0) return '';
  const parts: string[] = [];
  let start = values[0]!;
  let previous = values[0]!;
  for (const value of values.slice(1)) {
    if (value === previous + 1) {
      previous = value;
      continue;
    }
    parts.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = value;
    previous = value;
  }
  parts.push(start === previous ? `${start}` : `${start}-${previous}`);
  return parts.join(', ');
}
