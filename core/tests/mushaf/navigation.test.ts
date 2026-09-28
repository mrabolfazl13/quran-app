import { describe, expect, it } from 'vitest';
import type { VerseKey } from '../../src/contracts/quran';
import {
  buildMushafLayout,
  createMushafNavigation,
  firstVerseOnPage,
  pageOfVerseKey,
  pageRangeOfSurah,
  versesOnPage,
  type MushafPage,
} from '../../src/mushaf/layout';
import { anchorConflictFixture, buildFixture, miniMushaf, type AyahFixtureOptions } from './fixtures';

/**
 * Navigation helpers, with the emphasis on the seams: the last ayah of a page,
 * the first ayah of the next, a surah starting mid-page, two juz meeting on one
 * page, and a verse the provider itself splits over two pages.
 */

const corpus = miniMushaf();
const layout = buildMushafLayout(corpus.words, corpus.ayahs);
const nav = createMushafNavigation(layout.pages);

/** A verse that legitimately keeps reading across the page seam (2 → 3). */
function spanningMushaf(): { pages: MushafPage[] } {
  const meta = new Map<string, AyahFixtureOptions>([
    ['2:1', { page: 2, juz: 1 }],
    ['2:2', { page: 2, juz: 1 }],
    ['2:3', { page: 3, juz: 2 }],
  ]);
  const part = buildFixture(
    [
      { page: 2, line: 14, tokens: [['2:1', 'الٓمٓ'], ['2:1', '١', true]] },
      { page: 2, line: 15, tokens: [['2:2', 'ذَٰلِكَ'], ['2:2', 'ٱلْكِتَـٰبُ']] },
      { page: 3, line: 1, tokens: [['2:2', 'مُبِينًۭا'], ['2:2', '٢', true], ['2:3', 'ٱلَّذِينَ']] },
      { page: 3, line: 2, tokens: [['2:3', 'يُؤْمِنُونَ'], ['2:3', '٣', true]] },
    ],
    meta,
  );
  return { pages: buildMushafLayout(part.words, part.ayahs).pages };
}

describe('navigation — verse → page', () => {
  it('resolves each verse to the page its first word actually sits on', () => {
    expect(nav.pageOfVerseKey('4:176')).toBe(106);
    expect(nav.pageOfVerseKey('5:1')).toBe(106);
    expect(nav.pageOfVerseKey('5:2')).toBe(107);
    expect(nav.pageOfVerseKey('5:82')).toBe(121);
    expect(nav.pageOfVerseKey('114:6')).toBe(604);
  });

  it('returns null rather than a guess for an unknown verse key', () => {
    expect(nav.pageOfVerseKey('77:7')).toBeNull();
    expect(nav.pageOfVerseKey('')).toBeNull();
    expect(pageOfVerseKey(layout.pages, '2:200')).toBeNull();
  });

  it('reports the page a verse starts on when it continues on the next', () => {
    const span = createMushafNavigation(spanningMushaf().pages);
    expect(span.pageOfVerseKey('2:2')).toBe(2);
    expect(span.pageOfVerseKey('2:3')).toBe(3);
    expect(span.verseKeysOnLine('2:2', 2)).toEqual({ page: 2, line: 15 });
    expect(span.verseKeysOnLine('2:2', 3)).toEqual({ page: 3, line: 1 });
  });

  it('follows the ayah anchor when the word rows lag a page behind', () => {
    const conflict = buildMushafLayout(anchorConflictFixture().words, anchorConflictFixture().ayahs);
    const n = createMushafNavigation(conflict.pages);
    expect(n.pageOfVerseKey('5:77')).toBe(121);
    expect(n.verseKeysOnLine('5:77', 1)).toEqual({ page: 121, line: 1 });
    expect(n.pageRangeOfSurah(5)).toEqual({ from: 120, to: 121 });
  });
});

describe('navigation — page → verses', () => {
  it('lists a page’s verses in reading order, deduplicated', () => {
    expect(nav.versesOnPage(106)).toEqual(['4:176', '5:1']);
    expect(nav.versesOnPage(107)).toEqual(['5:2']);
    expect(nav.versesOnPage(121)).toEqual(['5:80', '5:81', '5:82']);
    expect(nav.versesOnPage(604)).toEqual([
      '112:1',
      '112:2',
      '112:3',
      '112:4',
      '113:1',
      '113:2',
      '113:3',
      '113:4',
      '113:5',
      '114:1',
      '114:2',
      '114:3',
      '114:4',
      '114:5',
      '114:6',
    ]);
  });

  it('gives the empty list for a page the corpus does not have', () => {
    expect(nav.versesOnPage(1)).toEqual([]);
    expect(nav.firstVerseOnPage(1)).toBeNull();
    expect(nav.lastVerseOnPage(1)).toBeNull();
    expect(nav.pageContinuesVerse(1)).toBe(false);
    expect(nav.page(1)).toBeNull();
    expect(nav.page(106)!.pageNumber).toBe(106);
    expect(nav.pageCount).toBe(4);
  });

  it('answers the boundary questions: last ayah here, first ayah next page', () => {
    expect(nav.firstVerseOnPage(106)).toBe('4:176');
    expect(nav.lastVerseOnPage(106)).toBe('5:1');
    expect(nav.firstVerseOnPage(107)).toBe('5:2');
    expect(nav.lastVerseOnPage(604)).toBe('114:6');
    expect(nav.firstVerseOnPage(604)).toBe('112:1');

    // the standalone helpers agree with the indexed navigation
    expect(versesOnPage(layout.pages, 106)).toEqual(nav.versesOnPage(106));
    expect(firstVerseOnPage(layout.pages, 107)).toEqual('5:2');
    expect(pageOfVerseKey(layout.pages, '5:1')).toEqual(nav.pageOfVerseKey('5:1'));
    expect(pageRangeOfSurah(layout.pages, 5)).toEqual(nav.pageRangeOfSurah(5));
  });

  it('flags a page whose first verse began earlier', () => {
    const span = spanningMushaf();
    const n = createMushafNavigation(span.pages);
    expect(n.pageContinuesVerse(2)).toBe(false);
    expect(n.pageContinuesVerse(3)).toBe(true);
    expect(span.pages[1]!.continuesVerseFromPreviousPage).toBe('2:2');
    expect(n.firstVerseOnPage(3)).toBe('2:2');
    expect(n.lastVerseOnPage(2)).toBe('2:2');
  });

  it('scopes a surah’s verses to one page', () => {
    expect(nav.versesOfSurahOnPage(5, 106)).toEqual(['5:1']);
    expect(nav.versesOfSurahOnPage(5, 121)).toEqual(['5:80', '5:81', '5:82']);
    expect(nav.versesOfSurahOnPage(4, 106)).toEqual(['4:176']);
    expect(nav.versesOfSurahOnPage(5, 604)).toEqual([]);
    expect(nav.versesOfSurahOnPage(1, 106)).toEqual([]);
  });
});

describe('navigation — surah and juz ranges', () => {
  it('gives a surah’s page range, correct when it starts mid-page', () => {
    expect(nav.pageRangeOfSurah(4)).toEqual({ from: 106, to: 106 });
    expect(nav.pageRangeOfSurah(5)).toEqual({ from: 106, to: 121 });
    expect(nav.pageRangeOfSurah(112)).toEqual({ from: 604, to: 604 });
    expect(nav.pageRangeOfSurah(114)).toEqual({ from: 604, to: 604 });
    expect(nav.pageRangeOfSurah(1)).toBeNull();
  });

  it('exposes the surah starts a page carries, with their heading bands', () => {
    expect(nav.surahStartOnPage(106).map((s) => [s.chapter, s.verseKey, s.lineNumber])).toEqual([
      [5, '5:1', 8],
    ]);
    expect(nav.surahStartOnPage(106)[0]!.headingBandLines).toEqual([6, 7]);
    expect(nav.surahStartOnPage(107)).toEqual([]);
    expect(nav.surahStartOnPage(604).map((s) => s.chapter)).toEqual([112, 113, 114]);
    expect(nav.surahStartOnPage(1)).toEqual([]);
  });

  it('finds the pages where two juz meet', () => {
    // 106 = juz 5 → 6 (4:176 then 5:1), 121 = juz 6 → 7 inside a line
    expect(nav.juzBoundaryPages).toEqual([106, 121]);
    expect(layout.pages.find((p) => p.pageNumber === 121)!.juzNumbers).toEqual([6, 7]);
    // the juz marker travels inside a word token, so the ref is still the verse's first word
    const mark = nav.placementOf('5:82', 1)!;
    expect(mark.line).toBe(5);
    expect(mark.position).toBe(1);
    expect(corpus.words.find((w) => w.verseKey === ('5:82' as VerseKey) && w.position === 1)!.textUthmani).toBe(
      '۞ لَتَجِدَنَّ',
    );
    expect(mark.isEndOfAyahMark).toBe(false);
  });

  it('returns the placed token untouched, and null for refs that do not exist', () => {
    expect(nav.placementOf('4:176', 7)!.line).toBe(2);
    expect(nav.placementOf('4:176', 7)!.verseKey).toBe('4:176');
    expect(nav.placementOf('4:176', 999)).toBeNull();
    expect(nav.verseKeysOnLine('4:176', 999)).toBeNull();
    expect(nav.placementOf('112:1' as VerseKey, 5)!.isEndOfAyahMark).toBe(true);
  });
});

describe('navigation — caching', () => {
  it('reuses one index per pages array', () => {
    expect(createMushafNavigation(layout.pages)).toBe(nav);
    const other = buildMushafLayout(corpus.words, corpus.ayahs).pages;
    expect(createMushafNavigation(other)).not.toBe(nav);
  });
});
