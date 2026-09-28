import { describe, expect, it } from 'vitest';
import type { VerseKey } from '../../src/contracts/quran';
import {
  buildMushafLayout,
  type LayoutWord,
  type MushafPage,
} from '../../src/mushaf/layout';
import {
  pageTokenTexts,
  removeWhitespace,
  renderPage,
  renderPages,
  type RenderedPage,
} from '../../src/mushaf/render';
import { buildFixture, miniMushaf, type AyahFixtureOptions } from './fixtures';

/**
 * Byte preservation is the contract under test: `renderPage` may only insert
 * whitespace between tokens. Every proof below compares raw code points — the
 * provider's Uthmani rows are deliberately not NFC, so any normalisation would
 * rewrite the revealed script form.
 */

const corpus = miniMushaf();
const layout = buildMushafLayout(corpus.words, corpus.ayahs);
const renderedAll = renderPages(layout.pages, corpus.words);

function pageAt(n: number): MushafPage {
  const found = layout.pages.find((p) => p.pageNumber === n);
  if (!found) throw new Error(`fixture has no page ${n}`);
  return found;
}
function renderedAt(n: number): RenderedPage {
  const found = renderedAll.find((p) => p.pageNumber === n);
  if (!found) throw new Error(`no rendered page ${n}`);
  return found;
}

const codePoints = (text: string): string =>
  [...text].map((c) => c.codePointAt(0)!.toString(16).toUpperCase()).join(' ');

/** shadda-then-fatha (`0651 064E`) exactly as the provider emits it. */
const NON_NFC_ALLAH = '\u0671\u0644\u0644\u0651\u064E\u0647\u064F';

describe('renderPage — byte preservation', () => {
  it('returns the page token texts in reading order, untouched', () => {
    for (const page of layout.pages) {
      const rendered = renderPage(page, corpus.words);
      expect(rendered.tokensInOrder).toEqual(pageTokenTexts(page, corpus.words));
    }
  });

  it('inserts nothing but whitespace: strip it and the tokens match element by element', () => {
    for (const page of layout.pages) {
      const rendered = renderPage(page, corpus.words);
      const joined = removeWhitespace(rendered.text);
      const original = removeWhitespace(rendered.tokensInOrder.join(''));
      expect(joined).toBe(original);

      // same proof per line, so an inserted line break cannot hide a mutation
      let offset = 0;
      for (const line of rendered.lines) {
        const tokens = rendered.tokensInOrder.slice(offset, offset + line.words.length);
        offset += line.words.length;
        expect(removeWhitespace(line.text)).toBe(removeWhitespace(tokens.join('')));
      }
    }
  });

  it('does not normalise, rejoin or trim a single code point', () => {
    const meta = new Map<string, AyahFixtureOptions>([['1:1', { page: 1 }]]);
    const part = buildFixture(
      [
        {
          page: 1,
          line: 1,
          tokens: [
            ['1:1', NON_NFC_ALLAH],
            ['1:1', 'ٱلْرَّحْمَـٰنِ'],
            ['1:1', '١', true],
          ],
        },
      ],
      meta,
    );
    const pages = buildMushafLayout(part.words, part.ayahs).pages;
    const rendered = renderPage(pages[0]!, part.words);

    expect(codePoints(rendered.tokensInOrder[0]!)).toBe('671 644 644 651 64E 647 64F');
    expect(rendered.tokensInOrder[0]).toBe(NON_NFC_ALLAH);
    // NFC would reorder the marks — the rendered page must not contain that form
    expect(NON_NFC_ALLAH).not.toBe(NON_NFC_ALLAH.normalize('NFC'));
    expect(rendered.text).toContain(NON_NFC_ALLAH);
    expect(rendered.text).not.toContain(NON_NFC_ALLAH.normalize('NFC'));
    // a token carrying an internal space + waqf sign travels as one piece
    expect(rendered.tokensInOrder[1]).toBe('ٱلْرَّحْمَـٰنِ');
    expect(rendered.issues).toEqual([]);
  });

  it('keeps rendered words index-aligned with the page refs', () => {
    for (const page of layout.pages) {
      const rendered = renderPage(page, corpus.words);
      expect(rendered.lines.map((l) => l.lineNumber)).toEqual(page.lines.map((l) => l.lineNumber));
      rendered.lines.forEach((line, i) => {
        const source = page.lines[i]!;
        expect(line.words.map((w) => [w.verseKey, w.position])).toEqual(
          source.refs.map((r) => [r.verseKey, r.position]),
        );
        expect(line.words.every((w) => w.line === source.lineNumber)).toBe(true);
        expect(line.pageNumber).toBe(page.pageNumber);
      });
      expect(rendered.tokenCount).toBe(page.tokenCount);
    }
  });
});

describe('renderPage — grouping and separators', () => {
  it('joins words with the word separator and lines with the line separator', () => {
    const page107 = renderedAt(107);
    expect(page107.separators).toEqual({ word: ' ', line: '\n' });
    expect(page107.lines.map((l) => l.text)).toEqual([
      'يَـٰٓأَيُّهَا ٱلَّذِينَ ءَامَنُوا۟ لَا تُحِلُّوا۟',
      'شَعَـٰٓئِرَ ٱللَّهِ وَلَا ٱلشَّهْرَ',
      'ٱلْحَرَامَ ٢',
    ]);
    expect(page107.text.split('\n')).toHaveLength(3);
    const tabbed = renderPage(pageAt(107), corpus.words, { lineSeparator: '\n\n', wordSeparator: '  ' });
    expect(tabbed.text.split('\n\n')).toHaveLength(3);
    expect(tabbed.lines[0]!.text).toContain('  ');
  });

  it('reports the surah heading band as gapLinesBefore', () => {
    const lines = new Map(renderedAt(106).lines.map((l) => [l.lineNumber, l]));
    expect(lines.get(1)!.gapLinesBefore).toEqual([]);
    expect(lines.get(8)!.gapLinesBefore).toEqual([6, 7]);
    const p604 = new Map(renderedAt(604).lines.map((l) => [l.lineNumber, l]));
    expect(p604.get(3)!.gapLinesBefore).toEqual([1, 2]);
    expect(p604.get(7)!.gapLinesBefore).toEqual([5, 6]);
    expect(p604.get(12)!.gapLinesBefore).toEqual([10, 11]);
  });

  it('refuses a separator that is not whitespace and falls back to the default', () => {
    const rendered = renderPage(pageAt(107), corpus.words, { wordSeparator: ' | ' });
    expect(rendered.issues.map((i) => [i.code, i.severity, i.subject])).toEqual([
      ['separator-not-whitespace', 'fatal', 'wordSeparator'],
    ]);
    expect(rendered.separators.word).toBe(' ');
    expect(rendered.text).not.toContain('|');
    // the refusal is not a silent rewrite: the bytes still round-trip
    expect(removeWhitespace(rendered.text)).toBe(removeWhitespace(rendered.tokensInOrder.join('')));

    const nbspLine = renderPage(pageAt(107), corpus.words, { lineSeparator: '\u00A0' });
    expect(nbspLine.issues).toEqual([]);
    expect(nbspLine.separators.line).toBe('\u00A0');
  });
});

describe('renderPage — end-of-ayah marks', () => {
  it('renders the ayah-number sign verbatim and carries the number it stands for', () => {
    const marks = renderedAll
      .flatMap((p) => p.lines.flatMap((l) => l.words))
      .filter((w) => w.isEndOfAyahMark);
    expect(marks.length).toBe(corpus.words.filter((w) => w.isEndOfAyahMark).length);
    const byVerse = new Map(marks.map((w) => [String(w.verseKey), w]));
    expect(byVerse.get('4:176')!.ayahNumber).toBe(176);
    expect(byVerse.get('4:176')!.text).toBe('١٧٦');
    expect(byVerse.get('112:3')!.ayahNumber).toBe(3);
    expect(byVerse.get('114:6')!.ayahNumber).toBe(6);
    expect(byVerse.get('114:6')!.chapter).toBe(114);
    // the sign's own code points are untouched too (Arabic-Indic digits)
    expect(codePoints(byVerse.get('4:176')!.text)).toBe('661 667 666');
    // word tokens never claim an ayah number
    const words = renderedAll.flatMap((p) => p.lines.flatMap((l) => l.words)).filter((w) => !w.isEndOfAyahMark);
    expect(words.every((w) => w.ayahNumber === null)).toBe(true);
  });

  it('puts the mark last in its line group, as the provider rows do', () => {
    const line = renderedAt(106).lines.find((l) => l.lineNumber === 5)!;
    expect(line.words.map((w) => w.isEndOfAyahMark)).toEqual([true]);
    expect(line.text).toBe('١٧٦');
  });
});

describe('renderPage — unresolvable references', () => {
  it('names the refs whose word row is missing instead of rendering nothing', () => {
    const page = pageAt(107);
    const without = corpus.words.filter(
      (w) => !(w.verseKey === ('5:2' as VerseKey) && w.position === 3),
    );
    const rendered = renderPage(page, without);
    expect(rendered.missingWords).toEqual([{ verseKey: '5:2', position: 3 }]);
    expect(rendered.issues.map((i) => [i.code, i.severity])).toEqual([['unresolvable-reference', 'fatal']]);
    expect(rendered.issues[0]!.detail).toContain('5:2:3');
    expect(rendered.tokenCount).toBe(page.tokenCount - 1);
    expect(rendered.lines[0]!.words.some((w) => w.position === 3)).toBe(false);
  });

  it('warns when two rows claim the same {verseKey, position}', () => {
    const dupe: LayoutWord = {
      ...corpus.words.find((w) => w.verseKey === ('5:2' as VerseKey) && w.position === 1)!,
      id: 999_003,
      textUthmani: 'خَلَفًا۟',
    };
    const rendered = renderPage(pageAt(107), [...corpus.words, dupe]);
    expect(rendered.issues.map((i) => i.code)).toEqual(['ambiguous-word-row']);
    expect(rendered.issues[0]!.severity).toBe('warning');
    expect(rendered.lines[0]!.words[0]!.text).toBe('يَـٰٓأَيُّهَا');
  });
});

describe('renderPages', () => {
  it('renders every page, in order, and the tokens add up', () => {
    expect(renderedAll.map((p) => p.pageNumber)).toEqual(layout.pages.map((p) => p.pageNumber));
    expect(renderedAll.reduce((n, p) => n + p.tokenCount, 0)).toBe(layout.stats.tokensPlaced);
  });
});

describe('removeWhitespace', () => {
  it('strips every kind of whitespace it may have inserted', () => {
    expect(removeWhitespace('a b\u00A0c\nd\ne\u2028f\u2029g')).toBe('abcdefg');
    expect(removeWhitespace('')).toBe('');
    expect(removeWhitespace('   ')).toBe('');
  });
});
