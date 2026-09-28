/**
 * Pure assembly of the display string for one mushaf page.
 *
 * Byte-preservation is the whole point: revealed text may not be altered,
 * "fixed", rejoined or normalised on the way to the screen. The provider's
 * Uthmani rows are not Unicode NFC (combining marks arrive shadda-then-fatha,
 * `0651 064E`, and NFC would reorder them), so any normalisation here would
 * silently rewrite the script form.
 *
 * `renderPage` therefore only ever *inserts whitespace* between tokens: word
 * separators inside a line, line separators between lines. Every token's code
 * points travel untouched, which `tests/mushaf/render.test.ts` proves by
 * stripping the inserted whitespace and comparing with the original token list
 * element by element.
 */

import type { VerseKey } from '../contracts/quran.js';
import type { LayoutWord, MushafPage, WordRef } from './layout.js';
import { parseVerseKey } from './layout.js';

export interface RenderSeparators {
  word: string;
  line: string;
}

export interface RenderOptions {
  /**
   * Inserted between words of one line. Must be whitespace only; anything else
   * would break byte preservation and is refused (diagnostic + default).
   * Default `' '`.
   */
  wordSeparator?: string;
  /** Inserted between lines. Must be whitespace only. Default `'\n'`. */
  lineSeparator?: string;
}

export interface RenderIssue {
  code: string;
  severity: 'info' | 'warning' | 'fatal';
  subject: string;
  detail: string;
}

export interface RenderedWord {
  verseKey: VerseKey;
  position: number;
  /** Verbatim provider text. Never normalised, trimmed or rejoined. */
  text: string;
  isEndOfAyahMark: boolean;
  /** For an end-of-ayah mark: the ayah number the sign stands for, from the verse key. */
  ayahNumber: number | null;
  chapter: number | null;
  /** Provider line number this token sits on. */
  line: number;
}

export interface RenderedLine {
  pageNumber: number;
  lineNumber: number;
  /** Grid lines with no words immediately before this line (surah heading band). */
  gapLinesBefore: number[];
  words: RenderedWord[];
  /** `words` joined by the word separator. */
  text: string;
}

export interface RenderedPage {
  pageNumber: number;
  lines: RenderedLine[];
  /** Every line's text joined by the line separator — the page as one string. */
  text: string;
  /** Token texts in reading order — the byte-preservation comparison basis. */
  tokensInOrder: string[];
  tokenCount: number;
  /** References on the page whose word row was not in the supplied words. */
  missingWords: WordRef[];
  separators: RenderSeparators;
  issues: RenderIssue[];
}

const DEFAULT_SEPARATORS: RenderSeparators = { word: ' ', line: '\n' };

function isWhitespaceOnly(value: string): boolean {
  if (value.length === 0) return true;
  return /^[\s\u00A0\u2028\u2029]*$/u.test(value);
}

/** All whitespace removed — used to prove rendering inserted only whitespace. */
export function removeWhitespace(text: string): string {
  return text.replace(/[\s\u00A0\u2028\u2029]/gu, '');
}

function wordIndex(
  words: readonly LayoutWord[],
  issues: RenderIssue[],
): Map<string, LayoutWord> {
  const index = new Map<string, LayoutWord>();
  for (const word of words) {
    const key = `${word.verseKey}:${word.position}`;
    if (index.has(key)) {
      issues.push({
        code: 'ambiguous-word-row',
        severity: 'warning',
        subject: key,
        detail: 'two word rows share verse key + position; the first was rendered',
      });
      continue;
    }
    index.set(key, word);
  }
  return index;
}

/**
 * Render one page. `words` is the same row set the layout was built from (the
 * page holds references only, so the text has to come from the rows).
 */
export function renderPage(
  page: MushafPage,
  words: readonly LayoutWord[],
  options: RenderOptions = {},
): RenderedPage {
  const issues: RenderIssue[] = [];
  const separators: RenderSeparators = { ...DEFAULT_SEPARATORS };

  const requested: RenderSeparators = {
    word: options.wordSeparator ?? DEFAULT_SEPARATORS.word,
    line: options.lineSeparator ?? DEFAULT_SEPARATORS.line,
  };
  for (const [name, value] of [['wordSeparator', requested.word], ['lineSeparator', requested.line]] as const) {
    if (!isWhitespaceOnly(value)) {
      issues.push({
        code: 'separator-not-whitespace',
        severity: 'fatal',
        subject: name,
        detail: JSON.stringify(value) +
          ' contains non-whitespace; inserting it would alter the revealed text, so the default was used',
      });
    } else {
      separators[name === 'wordSeparator' ? 'word' : 'line'] = value;
    }
  }

  const index = wordIndex(words, issues);
  const missingWords: WordRef[] = [];
  const tokensInOrder: string[] = [];
  const lines: RenderedLine[] = [];
  const emptyLines = new Set(page.emptyLineNumbers);
  let pendingGaps: number[] = [];

  for (const line of page.lines) {
    for (let gap = line.lineNumber - 1; gap >= 1 && emptyLines.has(gap); gap--) {
      if (!pendingGaps.includes(gap)) pendingGaps.unshift(gap);
    }
    pendingGaps.sort((a, b) => a - b);

    const renderedWords: RenderedWord[] = [];
    const parts: string[] = [];
    for (const ref of line.refs) {
      const row = index.get(`${ref.verseKey}:${ref.position}`);
      if (!row) {
        missingWords.push({ verseKey: ref.verseKey, position: ref.position });
        continue;
      }
      const parsed = parseVerseKey(String(ref.verseKey));
      const rendered: RenderedWord = {
        verseKey: ref.verseKey,
        position: ref.position,
        text: row.textUthmani,
        isEndOfAyahMark: row.isEndOfAyahMark,
        ayahNumber: row.isEndOfAyahMark ? (parsed?.verse ?? null) : null,
        chapter: parsed?.chapter ?? null,
        line: line.lineNumber,
      };
      renderedWords.push(rendered);
      parts.push(rendered.text);
      tokensInOrder.push(rendered.text);
    }

    lines.push({
      pageNumber: page.pageNumber,
      lineNumber: line.lineNumber,
      gapLinesBefore: pendingGaps,
      words: renderedWords,
      text: parts.join(separators.word),
    });
    pendingGaps = [];
  }

  if (missingWords.length > 0) {
    issues.push({
      code: 'unresolvable-reference',
      severity: 'fatal',
      subject: `page:${page.pageNumber}`,
      detail: `${missingWords.length} reference(s) have no word row: ${missingWords
        .slice(0, 5)
        .map((r) => `${r.verseKey}:${r.position}`)
        .join(', ')}`,
    });
  }

  return {
    pageNumber: page.pageNumber,
    lines,
    text: lines.map((l) => l.text).join(separators.line),
    tokensInOrder,
    tokenCount: tokensInOrder.length,
    missingWords,
    separators,
    issues,
  };
}

/** Render a whole layout, page by page, reusing one word index per call. */
export function renderPages(
  pages: readonly MushafPage[],
  words: readonly LayoutWord[],
  options: RenderOptions = {},
): RenderedPage[] {
  return pages.map((page) => renderPage(page, words, options));
}

/**
 * The reading-order token texts of a page, straight from the rows — the "before"
 * side of the byte-preservation comparison.
 */
export function pageTokenTexts(page: MushafPage, words: readonly LayoutWord[]): string[] {
  const index = wordIndex(words, []);
  const out: string[] = [];
  for (const line of page.lines) {
    for (const ref of line.refs) {
      const row = index.get(`${ref.verseKey}:${ref.position}`);
      if (row) out.push(row.textUthmani);
    }
  }
  return out;
}
