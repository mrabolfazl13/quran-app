import { describe, expect, it } from 'vitest';
import type { Ayah, VerseKey } from '../../src/contracts/quran';
import {
  MAX_MUSHAF_LINES,
  buildMushafLayout,
  buildMushafPages,
  declaredPlacement,
  parseVerseKey,
  type LayoutWord,
  type MushafPage,
} from '../../src/mushaf/layout';
import { anchorConflictFixture, buildFixture, miniMushaf, type AyahFixtureOptions } from './fixtures';

/**
 * Grouping, ordering and the diagnostics the layout engine owes the reader.
 * Fixtures are the miniature mushaf in `fixtures.ts`; the real 604-page grid is
 * covered by `real-corpus.test.ts`.
 */

function pageAt(pages: readonly MushafPage[], n: number): MushafPage {
  const found = pages.find((p) => p.pageNumber === n);
  if (!found) throw new Error(`fixture has no page ${n}`);
  return found;
}

describe('buildMushafLayout — grouping and ordering', () => {
  const corpus = miniMushaf();
  const layout = buildMushafLayout(corpus.words, corpus.ayahs);
  const pages = layout.pages;

  it('groups tokens by the page/line the provider rows declare', () => {
    expect(pages.map((p) => p.pageNumber)).toEqual([106, 107, 121, 604]);
    expect(pageAt(pages, 106)!.lines.map((l) => l.lineNumber)).toEqual([1, 2, 3, 4, 5, 8, 9]);
    expect(pageAt(pages, 121)!.lines.map((l) => l.lineNumber)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(pageAt(pages, 604).lines.map((l) => l.lineNumber)).toEqual([3, 4, 7, 8, 9, 12, 13, 14, 15]);
  });

  it('reports grid lines the word rows do not fill', () => {
    expect(pageAt(pages, 106).emptyLineNumbers).toEqual([6, 7]);
    expect(pageAt(pages, 604).emptyLineNumbers).toEqual([1, 2, 5, 6, 10, 11]);
    expect(pageAt(pages, 121).emptyLineNumbers).toEqual([]);
  });

  it('attributes every fixture gap to the surah heading band below it', () => {
    const page106 = pageAt(pages, 106)!;
    expect(page106.surahStarts).toEqual([
      { chapter: 5, verseKey: '5:1', lineNumber: 8, headingBandLines: [6, 7] },
    ]);
    expect(page106.diagnostics.map((d) => [d.code, d.severity])).toEqual([
      ['surah-heading-band', 'info'],
    ]);
    expect(page106.isComplete).toBe(true);
    expect(pageAt(pages, 604)!.surahStarts.map((s) => [s.chapter, s.lineNumber])).toEqual([
      [112, 3],
      [113, 7],
      [114, 12],
    ]);
  });

  it('keeps lines in ascending order and refs aligned with their tokens', () => {
    for (const page of pages) {
      for (const line of page.lines) {
        expect(line.refs.length).toBe(line.words.length);
        line.refs.forEach((ref, i) => {
          expect(ref.verseKey).toBe(line.words[i]!.verseKey);
          expect(ref.position).toBe(line.words[i]!.position);
        });
      }
    }
  });

  it('walks the mushaf in reading order — chapter, verse, position', () => {
    const sequence: Array<[string, number]> = [];
    for (const page of pages) {
      for (const line of page.lines) for (const ref of line.refs) sequence.push([ref.verseKey, ref.position]);
    }
    const parsed = sequence.map(([key, position]) => ({ ...parseVerseKey(key)!, position }));
    for (let i = 1; i < parsed.length; i++) {
      const a = parsed[i - 1]!;
      const b = parsed[i]!;
      const cmp = a.chapter - b.chapter || a.verse - b.verse || a.position - b.position;
      expect(cmp).toBeLessThan(0);
    }
    expect(sequence.length).toBe(corpus.words.length);
  });

  it('orders a verse by position even when the rows arrive shuffled', () => {
    const shuffled = [...corpus.words].reverse();
    const layout2 = buildMushafLayout(shuffled, corpus.ayahs);
    const firstLine = layout2.pages.find((p) => p.pageNumber === 106)!.lines[0]!;
    expect(firstLine.refs.map((r) => r.position)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(firstLine.refs.every((r) => r.verseKey === ('4:176' as VerseKey))).toBe(true);
  });

  it('builds the page array through the convenience wrapper too', () => {
    const pagesOnly = buildMushafPages(corpus.words, corpus.ayahs);
    expect(pagesOnly.map((p) => p.pageNumber)).toEqual(pages.map((p) => p.pageNumber));
  });

  it('records juz numbers per page so boundary pages are findable', () => {
    expect(pageAt(pages, 106)!.juzNumbers).toEqual([5, 6]);
    expect(pageAt(pages, 121)!.juzNumbers).toEqual([6, 7]);
    expect(pageAt(pages, 604)!.juzNumbers).toEqual([30]);
  });

  it('accounts for every token: placed + unplaced = input', () => {
    const { stats } = layout;
    expect(stats.tokensInInput).toBe(corpus.words.length);
    expect(stats.tokensPlaced + stats.tokensUnplaced).toBe(stats.tokensInInput);
    expect(stats.endMarksInInput).toBe(
      corpus.words.filter((w) => w.isEndOfAyahMark).length,
    );
    expect(stats.maxLineNumberObserved).toBeLessThanOrEqual(MAX_MUSHAF_LINES);
  });
});

describe('buildMushafLayout — unplaced policy', () => {
  it('sends a word with no page metadata to unplaced, never to the end of a page', () => {
    const corpus = miniMushaf();
    const withNullPage: LayoutWord[] = [
      ...corpus.words,
      {
        ...corpus.words[0]!,
        id: 999_001,
        verseKey: '77:7' as VerseKey,
        position: 20,
        pageNumber: null,
        lineNumber: null,
      },
    ];
    const layout = buildMushafLayout(withNullPage, corpus.ayahs);
    expect(layout.unplaced).toHaveLength(1);
    expect(layout.unplaced[0]!.reason).toBe('missing-page-metadata');
    expect(layout.unplaced[0]!.verseKey).toBe('77:7');
    expect(layout.unplaced[0]!.word.pageNumber).toBeNull();
    expect(layout.stats.tokensUnplaced).toBe(1);

    // the corrupt row must not have leaked into the grid anywhere
    const allRefs = layout.pages.flatMap((p) => p.lines.flatMap((l) => l.refs));
    expect(allRefs.filter((r) => r.verseKey === ('77:7' as VerseKey))).toEqual([]);
    // and page 604 (the last page) still ends with 114:6's mark, unmoved
    const lastPage = layout.pages[layout.pages.length - 1]!;
    const lastLine = lastPage.lines[lastPage.lines.length - 1]!;
    expect(lastPage.pageNumber).toBe(604);
    expect(lastLine.lineNumber).toBe(15);
    expect(new Set(lastLine.words.map((w) => w.verseKey))).toEqual(new Set(['114:6']));
    expect(lastLine.words[lastLine.words.length - 1]!.isEndOfAyahMark).toBe(true);
  });

  it('sends a word with a missing line number to unplaced with its own reason', () => {
    const corpus = miniMushaf();
    const broken: LayoutWord[] = corpus.words.map((w) =>
      w.verseKey === ('5:1' as VerseKey) && w.position === 2 ? { ...w, lineNumber: null } : w,
    );
    const layout = buildMushafLayout(broken, corpus.ayahs);
    expect(layout.unplaced.map((u) => u.reason)).toEqual(['missing-line-metadata']);
    expect(layout.unplaced[0]!.detail).toContain('no line number');
    const page106 = layout.pages.find((p) => p.pageNumber === 106)!;
    const line8 = page106.lines.find((l) => l.lineNumber === 8)!;
    expect(line8.refs.map((r) => r.position)).toEqual([1, 3, 4]);
  });

  it('rejects page numbers outside 1..604', () => {
    const corpus = miniMushaf();
    const broken = corpus.words.map((w) =>
      w.verseKey === ('112:1' as VerseKey) && w.position === 1 ? { ...w, pageNumber: 605 } : w,
    );
    const layout = buildMushafLayout(broken, corpus.ayahs, { pageCount: 604 });
    expect(layout.unplaced.map((u) => u.reason)).toEqual(['page-out-of-range']);
    expect(layout.diagnostics.some((d) => d.code === 'page-out-of-range')).toBe(true);
  });

  it('rejects a non-positive line number instead of inventing a slot', () => {
    const corpus = miniMushaf();
    const broken = corpus.words.map((w) =>
      w.verseKey === ('112:1' as VerseKey) && w.position === 1 ? { ...w, lineNumber: 0 } : w,
    );
    const layout = buildMushafLayout(broken, corpus.ayahs);
    expect(layout.unplaced).toHaveLength(1);
    expect(layout.unplaced[0]!.reason).toBe('line-not-positive');
    expect(layout.unplaced[0]!.detail).toContain('not on the mushaf grid');
  });

  it('places a duplicated {verseKey, position} exactly once and reports it', () => {
    const corpus = miniMushaf();
    const duplicate: LayoutWord = { ...corpus.words[0]!, id: 999_002 };
    const layout = buildMushafLayout([...corpus.words, duplicate], corpus.ayahs);
    expect(layout.unplaced.map((u) => u.reason)).toEqual(['duplicate-reference']);
    expect(layout.diagnostics.filter((d) => d.code === 'duplicate-reference')).toHaveLength(1);
    expect(layout.diagnostics.find((d) => d.code === 'duplicate-reference')!.severity).toBe('fatal');
    const placed = layout.pages.flatMap((p) => p.lines.flatMap((l) => l.words));
    expect(placed.filter((w) => w.verseKey === ('4:176' as VerseKey) && w.position === 1)).toHaveLength(1);
  });

  it('flags a position jump inside a verse', () => {
    const corpus = miniMushaf();
    const sparse = corpus.words.filter(
      (w) => !(w.verseKey === ('112:1' as VerseKey) && w.position === 2),
    );
    const layout = buildMushafLayout(sparse, corpus.ayahs);
    expect(layout.diagnostics.some((d) => d.code === 'position-sequence-gap' && d.subject === '112:1')).toBe(true);
  });
});

describe('buildMushafLayout — page/line conflicts', () => {
  it('anchors a verse on its ayah page when the word rows lag a page behind', () => {
    const corpus = anchorConflictFixture();
    const layout = buildMushafLayout(corpus.words, corpus.ayahs);

    const placement = layout.pages
      .flatMap((p) => p.lines)
      .flatMap((l) => l.words)
      .filter((w) => w.verseKey === ('5:77' as VerseKey));
    expect(placement.map((w) => [w.page, w.line])).toEqual([
      [121, 1],
      [121, 1],
      [121, 1],
      [121, 2],
      [121, 2],
      [121, 2],
    ]);
    expect(placement.every((w) => w.pageCorrected)).toBe(true);
    expect(placement[0]!.declaredPage).toBe(120);
    expect(layout.stats.pageCorrections).toBe(1);
    expect(
      layout.diagnostics.some((d) => d.code === 'word-page-corrected' && d.subject === '5:77'),
    ).toBe(true);
    expect(layout.unplaced).toHaveLength(0);
  });

  it('still rescues the verse when the word-row page is preferred', () => {
    const corpus = anchorConflictFixture();
    const layout = buildMushafLayout(corpus.words, corpus.ayahs, { pagePolicy: 'word' });
    const placed = layout.pages
      .flatMap((p) => p.lines)
      .flatMap((l) => l.words)
      .filter((w) => w.verseKey === ('5:77' as VerseKey));
    expect(placed.map((w) => [w.page, w.line])).toEqual([
      [121, 1],
      [121, 1],
      [121, 1],
      [121, 2],
      [121, 2],
      [121, 2],
    ]);
  });

  it('leaves the verse unplaced when the word rows are trusted with no fallback', () => {
    const corpus = anchorConflictFixture();
    const layout = buildMushafLayout(corpus.words, corpus.ayahs, { pagePolicy: 'word-strict' });
    expect(layout.unplaced).toHaveLength(6);
    expect(layout.unplaced.every((u) => u.verseKey === ('5:77' as VerseKey))).toBe(true);
    expect(layout.unplaced.every((u) => u.reason === 'reading-order-conflict')).toBe(true);
    expect(layout.stats.tokensPlaced).toBe(corpus.words.length - 6);
    expect(
      layout.diagnostics.some((d) => d.code === 'word-page-conflict' && d.subject === '5:77'),
    ).toBe(true);
    // nothing was appended to the end of page 120 to keep the count tidy
    const page120 = layout.pages.find((p) => p.pageNumber === 120)!;
    expect(page120.lines.map((l) => l.lineNumber)).toEqual([14, 15]);
  });

  it('keeps a verse that the provider itself splits across pages', () => {
    const meta = new Map<string, AyahFixtureOptions>([['2:2', { page: 2 }]]);
    const corpus = buildFixture(
      [
        { page: 2, line: 14, tokens: [['2:1', 'الٓمٓ'], ['2:1', '١', true]] },
        { page: 2, line: 15, tokens: [['2:2', 'ذَٰلِكَ'], ['2:2', 'ٱلْكِتَـٰبُ']] },
        { page: 3, line: 1, tokens: [['2:2', 'مُبِينًۭا'], ['2:2', '٢', true]] },
      ],
      meta,
    );
    const layout = buildMushafLayout(corpus.words, corpus.ayahs);
    const spans = layout.diagnostics.filter((d) => d.code === 'verse-spans-pages');
    expect(spans.map((d) => d.subject)).toEqual(['2:2']);
    expect(layout.unplaced).toHaveLength(0);
    expect(layout.pages.map((p) => p.pageNumber)).toEqual([2, 3]);
    // page 3 continues a verse that began on page 2
    expect(layout.pages[1]!.continuesVerseFromPreviousPage).toBe('2:2');
    expect(layout.pages[1]!.verseKeys).toEqual(['2:2']);
  });

  it('marks a line below the 15-line grid but still surfaces it as a defect', () => {
    const meta = new Map<string, AyahFixtureOptions>([['7:1', { page: 5 }]]);
    const corpus = buildFixture([
      { page: 5, line: 1, tokens: [['7:1', 'أَلَمْ'], ['7:1', 'تَرَإْ']] },
      { page: 5, line: 16, tokens: [['7:1', 'إِلَىٰ', true]] },
    ], meta);
    const layout = buildMushafLayout(corpus.words, corpus.ayahs);
    expect(layout.stats.maxLineNumberObserved).toBe(16);
    const warning = layout.diagnostics.find((d) => d.code === 'line-exceeds-max');
    expect(warning?.severity).toBe('warning');
    expect(warning?.subject).toBe('page:5/line:16');
  });

  it('reports a line gap that no surah heading explains', () => {
    const meta = new Map<string, AyahFixtureOptions>([
      ['15:1', { page: 9 }],
      ['15:2', { page: 9 }],
    ]);
    const corpus = buildFixture(
      [
        { page: 9, line: 1, tokens: [['15:1', 'ٱلر']] },
        { page: 9, line: 4, tokens: [['15:2', 'تِلْكَ']] },
      ],
      meta,
    );
    const layout = buildMushafLayout(corpus.words, corpus.ayahs);
    const page = layout.pages[0]!;
    expect(page.emptyLineNumbers).toEqual([2, 3]);
    expect(page.surahStarts).toEqual([
      { chapter: 15, verseKey: '15:1', lineNumber: 1, headingBandLines: [] },
    ]);
    const gap = page.diagnostics.find((d) => d.code === 'line-gap');
    expect(gap?.severity).toBe('warning');
    expect(gap?.subject).toContain('page:9');
    expect(page.isComplete).toBe(false);
  });

  it('never synthesises the basmalah: a pack that injects it is reported', () => {
    const meta = new Map<string, AyahFixtureOptions>([['2:1', { page: 2 }]]);
    const corpus = buildFixture(
      [
        {
          page: 2,
          line: 3,
          tokens: [
            ['2:1', 'بِسْمِ ٱللَّهِ'],
            ['2:1', 'الٓمٓ'],
            ['2:1', '١', true],
          ],
        },
      ],
      meta,
    );
    const layout = buildMushafLayout(corpus.words, corpus.ayahs);
    expect(layout.diagnostics.some((d) => d.code === 'unexpected-basmalah-token')).toBe(true);
  });

  it('reports a word row whose ayah is missing from the corpus', () => {
    const corpus = miniMushaf();
    const orphan: LayoutWord = {
      ...corpus.words[0]!,
      id: 999_003,
      verseKey: '99:1' as VerseKey,
      position: 1,
      pageNumber: 600,
      lineNumber: 4,
    };
    const layout = buildMushafLayout([...corpus.words, orphan], corpus.ayahs);
    expect(layout.diagnostics.some((d) => d.code === 'word-without-ayah' && d.subject === '99:1')).toBe(true);
    // still placed — the metadata is enough to render it, the omission is reported
    expect(layout.unplaced).toHaveLength(0);
  });

  it('flags duplicate ayah rows and multiple end marks', () => {
    const corpus = miniMushaf();
    const duplicatedAyahs: Ayah[] = [...corpus.ayahs, corpus.ayahs[0]!];
    const layout = buildMushafLayout(corpus.words, duplicatedAyahs);
    expect(layout.diagnostics.some((d) => d.code === 'duplicate-ayah')).toBe(true);

    const twoMarks: LayoutWord[] = [
      ...corpus.words,
      { ...corpus.words.find((w) => w.verseKey === ('112:1' as VerseKey) && w.isEndOfAyahMark)!, id: 999_004, position: 6 },
    ];
    const layout2 = buildMushafLayout(twoMarks, corpus.ayahs);
    expect(layout2.diagnostics.some((d) => d.code === 'end-mark-multiple')).toBe(true);
  });
});

describe('helpers', () => {
  it('reads both camelCase and snake_case metadata spellings', () => {
    const row = {
      id: 1,
      verseKey: '2:1' as VerseKey,
      position: 1,
      textUthmani: 'الٓمٓ',
      translationEn: null,
      transliteration: null,
      root: null,
      morphology: null,
      isEndOfAyahMark: false,
      page_number: '2',
      line_number: 3,
    } satisfies LayoutWord;
    expect(declaredPlacement(row)).toEqual({ page: 2, line: 3 });
    expect(declaredPlacement({ ...row, page_number: undefined, pageNumber: undefined })).toEqual({
      page: null,
      line: 3,
    });
  });

  it('parses verse keys', () => {
    expect(parseVerseKey('112:4')).toEqual({ chapter: 112, verse: 4 });
    expect(parseVerseKey('nonsense')).toBeNull();
  });
});
