import { describe, expect, it } from 'vitest';
import type { Ayah, VerseKey } from '../../src/contracts/quran';
import {
  MAX_MUSHAF_LINES,
  MUSHAF_PAGE_COUNT,
  buildMushafLayout,
  type LayoutWord,
  type MushafPage,
} from '../../src/mushaf/layout';
import { validateLayout } from '../../src/mushaf/validate';
import { ayahFixture, buildFixture, miniMushaf, type AyahFixtureOptions } from './fixtures';

/**
 * The audit report: counts first, then every defect with the page / line / verse
 * key it belongs to. Nothing here throws — a broken page must be reported, not
 * reflowed.
 */

const corpus = miniMushaf();
const layout = buildMushafLayout(corpus.words, corpus.ayahs);

function clonePage(page: MushafPage): MushafPage {
  return {
    ...page,
    lines: page.lines.map((line) => ({
      ...line,
      refs: line.refs.map((r) => ({ ...r })),
      words: line.words.map((w) => ({ ...w })),
      verseKeys: [...line.verseKeys],
    })),
    emptyLineNumbers: [...page.emptyLineNumbers],
    verseKeys: [...page.verseKeys],
    surahStarts: page.surahStarts.map((s) => ({ ...s, headingBandLines: [...s.headingBandLines] })),
    juzNumbers: [...page.juzNumbers],
    diagnostics: page.diagnostics.map((d) => ({ ...d })),
  };
}

function codes(report: ReturnType<typeof validateLayout>): string[] {
  return report.defects.map((d) => d.code);
}

describe('validateLayout — a clean miniature mushaf', () => {
  const report = validateLayout(layout, corpus.ayahs);

  it('says ok and lists no defects', () => {
    expect(report.defects).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.fatalCount).toBe(0);
    expect(report.warningCount).toBe(0);
    expect(report.infoCount).toBe(0);
    expect(report.counts.pagesWithDefects).toBe(0);
  });

  it('counts every token: placed equals the input, unplaced is empty', () => {
    expect(report.counts.tokensInInput).toBe(corpus.words.length);
    expect(report.counts.tokensPlaced).toBe(corpus.words.length);
    expect(report.counts.wordsPlaced).toBe(corpus.words.filter((w) => !w.isEndOfAyahMark).length);
    expect(report.counts.endMarksPlaced).toBe(corpus.words.filter((w) => w.isEndOfAyahMark).length);
    expect(report.counts.wordsPlaced + report.counts.endMarksPlaced).toBe(report.counts.tokensPlaced);
    expect(report.counts.tokensUnplaced).toBe(0);
    expect(report.counts.unplacedByReason).toEqual({});
  });

  it('the placed word total equals the tokenised total over the ayah texts', () => {
    // the tokeniser drops ornament-only groups, so `ٱلْكَلَـٰلَةِ ۚ` is one word
    expect(report.counts.tokenisedWordsExpected).toBe(report.counts.wordsPlaced);
    expect(report.counts.wordTotalDelta).toBe(0);
  });

  it('counts pages, lines and the grid slots the word rows leave empty', () => {
    expect(report.counts.distinctPages).toBe(4);
    expect(report.counts.distinctLines).toBe(7 + 3 + 6 + 9);
    expect(report.counts.maxLinesOnOnePage).toBe(9);
    expect(report.counts.ayahsSupplied).toBe(21);
    expect(report.counts.versesWithPlacedWords).toBe(21);
    // 2 slots above surah 5 on page 106, 6 across the three bands on page 604
    expect(report.counts.emptyLineSlots).toBe(8);
    expect(report.counts.explainedEmptyLineSlots).toBe(8);
  });

  it('sees no duplicates, no inversions and no page corrections', () => {
    expect(report.counts.duplicateReferences).toBe(0);
    expect(report.counts.readingOrderInversions).toBe(0);
    expect(report.counts.pageCorrections).toBe(0);
  });
});

describe('validateLayout — defects name the offending page, line and verse', () => {
  it('catches a {verseKey, position} placed twice', () => {
    const pages = layout.pages.map(clonePage);
    const target = pages[0]!.lines[0]!;
    target.refs.push({ ...target.refs[0]! });
    target.words.push({ ...target.words[0]! });
    const report = validateLayout(pages, corpus.ayahs);
    expect(report.ok).toBe(false);
    const dup = report.defects.find((d) => d.code === 'duplicate-reference')!;
    expect(dup.severity).toBe('fatal');
    expect(dup.subject).toBe('4:176:1');
    expect(dup.verseKey).toBe('4:176');
    expect(dup.page).toBe(106);
    expect(dup.line).toBe(1);
    expect(report.counts.duplicateReferences).toBe(1);
    expect(report.counts.tokensPlaced).toBe(corpus.words.length);
  });

  it('catches a ref whose placed token went missing', () => {
    const pages = layout.pages.map(clonePage);
    const line = pages[1]!.lines[0]!;
    line.words.splice(2, 1);
    const report = validateLayout(pages, corpus.ayahs);
    const missing = report.defects.find((d) => d.code === 'ref-without-token')!;
    expect(missing.severity).toBe('fatal');
    expect(missing.subject).toBe('5:2:3');
    expect(missing.page).toBe(107);
    expect(missing.line).toBe(1);
    expect(report.ok).toBe(false);
  });

  it('refuses a page taller than the sourced 15-line grid', () => {
    const meta = new Map<string, AyahFixtureOptions>([['2:1', { page: 4 }]]);
    const lines = Array.from({ length: MAX_MUSHAF_LINES + 1 }, (_, i) => ({
      page: 4,
      line: i + 1,
      tokens: [[`2:1`, i === MAX_MUSHAF_LINES ? '١' : 'كَلِمة', i === MAX_MUSHAF_LINES ? (true as const) : undefined] as [string, string, true?]],
    }));
    const part = buildFixture(lines, meta);
    const tall = buildMushafLayout(part.words, part.ayahs);
    expect(tall.pages[0]!.lines).toHaveLength(MAX_MUSHAF_LINES + 1);
    const report = validateLayout(tall, part.ayahs);
    expect(codes(report)).toContain('page-too-tall');
    expect(report.defects.find((d) => d.code === 'page-too-tall')!.detail).toContain(`${MAX_MUSHAF_LINES} lines`);
    expect(report.counts.maxLinesOnOnePage).toBe(MAX_MUSHAF_LINES + 1);
    expect(report.ok).toBe(false);
    expect(tall.pages[0]!.isComplete).toBe(false);
  });

  it('refuses a line number below the grid', () => {
    const meta = new Map<string, AyahFixtureOptions>([['7:1', { page: 5 }]]);
    const part = buildFixture(
      [
        { page: 5, line: 1, tokens: [['7:1', 'أَلَمْ']] },
        { page: 5, line: MAX_MUSHAF_LINES + 1, tokens: [['7:1', 'حَاسِدَ'], ['7:1', '١', true]] },
      ],
      meta,
    );
    const layoutTall = buildMushafLayout(part.words, part.ayahs);
    const report = validateLayout(layoutTall, part.ayahs);
    const tooLow = report.defects.find((d) => d.code === 'line-exceeds-max')!;
    expect(tooLow.severity).toBe('fatal');
    expect(tooLow.page).toBe(5);
    expect(tooLow.line).toBe(MAX_MUSHAF_LINES + 1);
  });

  it('refuses a page number outside 1..604', () => {
    const pages = layout.pages.map(clonePage);
    pages[3]!.pageNumber = MUSHAF_PAGE_COUNT + 1;
    const report = validateLayout(pages, corpus.ayahs);
    const bad = report.defects.find((d) => d.code === 'page-out-of-range')!;
    expect(bad.severity).toBe('fatal');
    expect(bad.subject).toBe('page:605');
    expect(report.ok).toBe(false);
  });

  it('reports lines that do not ascend inside a page', () => {
    const pages = layout.pages.map(clonePage);
    const lines = pages[3]!.lines;
    [lines[0], lines[1]] = [lines[1]!, lines[0]!];
    const report = validateLayout(pages, corpus.ayahs);
    const disorder = report.defects.find((d) => d.code === 'line-out-of-order')!;
    expect(disorder.severity).toBe('fatal');
    expect(disorder.page).toBe(604);
    expect(disorder.line).toBe(3);
  });

  it('reports mushaf reading order going backwards', () => {
    const pages = layout.pages.map(clonePage);
    const swapped = [pages[1]!, pages[0]!, pages[2]!, pages[3]!];
    const report = validateLayout(swapped, corpus.ayahs);
    expect(report.defects.some((d) => d.code === 'page-out-of-order')).toBe(true);
    const inversion = report.defects.find((d) => d.code === 'reading-order-inversion')!;
    expect(inversion.severity).toBe('fatal');
    expect(report.counts.readingOrderInversions).toBeGreaterThan(0);
    expect(report.ok).toBe(false);
  });

  it('reports a line gap that is not a surah heading band', () => {
    const meta = new Map<string, AyahFixtureOptions>([
      ['15:1', { page: 9 }],
      ['15:2', { page: 9 }],
    ]);
    const part = buildFixture(
      [
        { page: 9, line: 1, tokens: [['15:1', 'ٱلر'], ['15:1', '١', true]] },
        { page: 9, line: 4, tokens: [['15:2', 'تِلْكَ'], ['15:2', '٢', true]] },
      ],
      meta,
    );
    const broken = buildMushafLayout(part.words, part.ayahs);
    const report = validateLayout(broken, part.ayahs);
    const gap = report.defects.find((d) => d.code === 'line-gap')!;
    expect(gap.severity).toBe('warning');
    expect(gap.page).toBe(9);
    expect(gap.detail).toContain('not a surah start');
    // ok stays true: the grid question is a warning, the words are all there
    expect(report.ok).toBe(true);
    expect(report.counts.emptyLineSlots).toBe(2);
    expect(report.counts.explainedEmptyLineSlots).toBe(0);
  });

  it('reports every word that sits in the unplaced bucket', () => {
    // an orphan row the ayah anchor cannot rescue: no ayah 77:7, no page, no line
    const broken: LayoutWord[] = [
      ...corpus.words,
      {
        ...corpus.words[0]!,
        id: 999_011,
        verseKey: '77:7' as VerseKey,
        position: 20,
        pageNumber: null,
        lineNumber: null,
      },
    ];
    const part = buildMushafLayout(broken, corpus.ayahs);
    expect(part.unplaced).toHaveLength(1);
    const report = validateLayout(part, corpus.ayahs);
    expect(report.ok).toBe(false);
    expect(report.counts.tokensUnplaced).toBe(1);
    expect(report.counts.unplacedByReason).toEqual({ 'missing-page-metadata': 1 });
    const fatal = report.defects.find((d) => d.code === 'unplaced-missing-page-metadata')!;
    expect(fatal.severity).toBe('fatal');
    expect(fatal.subject).toBe('77:7:20');
    expect(fatal.verseKey).toBe('77:7');
    // the row is a token the placed totals cannot see
    expect(report.counts.tokensPlaced).toBe(corpus.words.length);
    expect(codes(report)).toContain('word-without-ayah');
  });

  it('takes a bare pages array plus the unplaced bucket', () => {
    const broken: LayoutWord[] = corpus.words.map((w) =>
      w.verseKey === ('112:1' as VerseKey) && w.position === 1 ? { ...w, lineNumber: null } : w,
    );
    const part = buildMushafLayout(broken, corpus.ayahs);
    const report = validateLayout(part.pages, corpus.ayahs, { unplaced: part.unplaced });
    expect(report.counts.tokensUnplaced).toBe(1);
    expect(codes(report)).toContain('unplaced-missing-line-metadata');
    expect(report.ok).toBe(false);
  });
});

describe('validateLayout — totals against the authoritative text', () => {
  it('names the verse where the word rows and the ayah text disagree', () => {
    const tampered: Ayah[] = corpus.ayahs.map((a) =>
      a.verseKey === ('112:1' as VerseKey)
        ? ayahFixture('112:1', 'قُلْ هُوَ ٱللَّهُ أَحَدٌ ٱلصَّمَدُ', { page: 604, juz: 30 })
        : a,
    );
    const report = validateLayout(layout, tampered);
    const verse = report.defects.find((d) => d.code === 'verse-word-count')!;
    expect(verse.severity).toBe('warning');
    expect(verse.verseKey).toBe('112:1');
    expect(verse.detail).toContain('4 tokens');
    expect(verse.detail).toContain('tokenises to 5');
    const total = report.defects.find((d) => d.code === 'word-total-vs-tokenised')!;
    expect(total.subject).toBe('corpus');
    expect(report.counts.wordTotalDelta).toBe(1);
    // a totals disagreement is a warning: the mushaf itself is still intact
    expect(report.ok).toBe(true);
    expect(validateLayout(layout, tampered, { checkTokenisedTotals: false }).defects).toEqual([]);
  });

  it('catches a missing end-of-ayah mark and a mark that is not last', () => {
    const noMark = corpus.words.filter(
      (w) => !(w.verseKey === ('113:5' as VerseKey) && w.isEndOfAyahMark),
    );
    const part = buildMushafLayout(noMark, corpus.ayahs);
    const report = validateLayout(part, corpus.ayahs);
    const missing = report.defects.find((d) => d.code === 'end-mark-missing')!;
    expect(missing.verseKey).toBe('113:5');
    expect(missing.severity).toBe('warning');

    const misplaced = corpus.words.map((w) =>
      w.verseKey === ('113:5' as VerseKey) && w.isEndOfAyahMark ? { ...w, position: 1 } : w,
    );
    // position 1 collides with the real first word, so move both along
    const renumbered = misplaced.map((w) =>
      w.verseKey === ('113:5' as VerseKey) && !w.isEndOfAyahMark ? { ...w, position: w.position + 1 } : w,
    );
    const second = buildMushafLayout(renumbered, corpus.ayahs);
    const report2 = validateLayout(second, corpus.ayahs);
    expect(report2.defects.some((d) => d.code === 'end-mark-not-last')).toBe(true);
  });

  it('catches two ayah rows for the same verse key', () => {
    const doubled: Ayah[] = [...corpus.ayahs, corpus.ayahs[0]!];
    const report = validateLayout(layout, doubled);
    const dup = report.defects.find((d) => d.code === 'duplicate-ayah-row')!;
    expect(dup.severity).toBe('fatal');
    expect(dup.verseKey).toBe('4:176');
    expect(report.counts.ayahsSupplied).toBe(21);
  });

  it('says which supplied ayahs have no words at all', () => {
    const extra = ayahFixture('2:200', 'لَا شَيْءَ', { page: 42 });
    const report = validateLayout(layout, [...corpus.ayahs, extra]);
    const partial = report.defects.find((d) => d.code === 'verse-not-placed-partial')!;
    expect(partial.severity).toBe('warning');
    expect(partial.verseKey).toBe('2:200');
    expect(partial.page).toBe(42);
  });
});

describe('validateLayout — full-corpus expectations', () => {
  it('demands all 604 pages and every ayah when told to', () => {
    const withGap = [...corpus.ayahs, ayahFixture('2:200', 'لَا شَيْءَ', { page: 42 })];
    const report = validateLayout(layout, withGap, { expectFullCorpus: true });
    const missing = report.defects.find((d) => d.code === 'missing-pages')!;
    expect(missing.severity).toBe('fatal');
    expect(missing.subject).toBe(`pages:1-${MUSHAF_PAGE_COUNT}`);
    expect(missing.detail).toContain(`${MUSHAF_PAGE_COUNT - 4} page(s)`);
    const notPlaced = report.defects.find((d) => d.code === 'verse-not-placed')!;
    expect(notPlaced.severity).toBe('fatal');
    expect(notPlaced.verseKey).toBe('2:200');
    expect(codes(report)).not.toContain('verse-not-placed-partial');
    expect(report.ok).toBe(false);
  });

  it('honours a smaller grid when the reader asks for one', () => {
    const report = validateLayout(layout, corpus.ayahs, { pageCount: 700, maxLines: 20 });
    expect(codes(report)).not.toContain('page-out-of-range');
    expect(codes(report)).not.toContain('page-too-tall');
    expect(report.ok).toBe(true);
  });
});

describe('validateLayout — layout diagnostics carried through', () => {
  it('surfaces a word row whose ayah is missing', () => {
    const orphan: LayoutWord = {
      ...corpus.words[0]!,
      id: 999_010,
      verseKey: '99:1' as VerseKey,
      position: 1,
      pageNumber: 600,
      lineNumber: 4,
    };
    const part = buildMushafLayout([...corpus.words, orphan], corpus.ayahs);
    const report = validateLayout(part, corpus.ayahs);
    expect(codes(report)).toContain('word-without-ayah');
    expect(report.defects.find((d) => d.code === 'word-without-ayah')!.severity).toBe('warning');
  });

  it('surfaces a pack that injected the basmalah as a word row', () => {
    const meta = new Map<string, AyahFixtureOptions>([['2:1', { page: 2 }]]);
    const part = buildFixture(
      [
        {
          page: 2,
          line: 3,
          tokens: [['2:1', 'بِسْمِ ٱللَّهِ ٱلرَّحِيمِ'], ['2:1', 'الٓمٓ'], ['2:1', '١', true]],
        },
      ],
      meta,
    );
    const built = buildMushafLayout(part.words, part.ayahs);
    expect(built.diagnostics.some((d) => d.code === 'unexpected-basmalah-token')).toBe(true);
    const report = validateLayout(built, part.ayahs);
    expect(codes(report)).toContain('unexpected-basmalah-token');
  });

  it('surfaces the anchor corrections it made', () => {
    const part = buildFixture(
      [
        { page: 120, line: 15, tokens: [['5:76', 'قُلْ'], ['5:76', '٧٦', true]] },
        { page: 120, line: 1, tokens: [['5:77', 'قُلْ'], ['5:77', '٧٧', true]] },
      ],
      new Map<string, AyahFixtureOptions>([['5:76', { page: 120 }], ['5:77', { page: 121 }]]),
    );
    const report = validateLayout(buildMushafLayout(part.words, part.ayahs), part.ayahs);
    expect(report.counts.pageCorrections).toBe(2);
    expect(report.ok).toBe(true);
  });
});
