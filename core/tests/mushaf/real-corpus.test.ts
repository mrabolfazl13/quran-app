import { describe, expect, it } from 'vitest';
import type { Ayah, VerseKey } from '../../src/contracts/quran';
import {
  MAX_MUSHAF_LINES,
  MUSHAF_PAGE_COUNT,
  buildMushafLayout,
  createMushafNavigation,
  type LayoutWord,
  type MushafLayout,
} from '../../src/mushaf/layout';
import { pageTokenTexts, removeWhitespace, renderPage } from '../../src/mushaf/render';
import { validateLayout } from '../../src/mushaf/validate';
import { normalizedFingerprint, wordCount } from '../../src/normalize/arabic';
import { ayahFixture } from './fixtures';
import { envFlag, exists, fileSize, readDivisions, readJson, readText, readWordRows } from './provider-rows';

/**
 * REAL provider data and REAL shipped packs.
 *
 * `data/raw/quran-com/words-<chapter>.json` (the Quran.com v4 mushaf word rows,
 * the build-time source of `page_number` / `line_number`) plus
 * `divisions-<chapter>.json` (the ayah rows, which carry the page anchor).
 *
 * `content/word-data/payload.jsonl` + `content/quran-core/payload.jsonl` are the
 * packs that ship: the word rows carry `pageNumber` / `lineNumber`, so the
 * offline app can rebuild the 604-page grid from the pack alone — asserted below.
 *
 * Eight chapters are loaded by default. The full 114-chapter / 604-page audit
 * that re-reads the 228 raw files is opt-in with `MUSHAF_FULL_CORPUS=1` because
 * on a cold disk cache that read dominates the suite's runtime; the pack-built
 * full audit runs every time, since a shipped pack is two files. Every number
 * asserted here is measured from those files — see docs/data-model.md for the
 * columns and the mushaf layout note in the engine's own header.
 */

const SUBSET = [1, 2, 5, 9, 78, 112, 113, 114];
const ALL_CHAPTERS = Array.from({ length: 114 }, (_, i) => i + 1);
const FULL_CORPUS = envFlag('MUSHAF_FULL_CORPUS');

/** Check if raw provider data files exist for the subset chapters */
function hasRawData(): boolean {
  try {
    // Just check the first chapter - if it exists, assume all exist
    return exists('data', 'raw', 'quran-com', `words-${SUBSET[0]}.json`);
  } catch {
    return false;
  }
}

interface ChapterData {
  ayahs: Ayah[];
  words: LayoutWord[];
}

/** Division rows + word rows, mapped the way the ingest pipeline maps them. */
function loadChapter(chapter: number): ChapterData {
  const ayahs: Ayah[] = readDivisions(chapter).map((d) =>
    ayahFixture(d.verse_key, d.text_uthmani, {
      juz: d.juz_number,
      hizb: d.hizb_number,
      rubElHizb: d.rub_el_hizb_number,
      page: d.page_number,
    }),
  );
  const words: LayoutWord[] = readWordRows(chapter).flatMap((v) =>
    v.words.map((w) => ({
      id: w.id,
      verseKey: v.verse_key as VerseKey,
      position: w.position,
      textUthmani: w.text_uthmani,
      translationEn: null,
      transliteration: null,
      root: null,
      morphology: null,
      isEndOfAyahMark: w.char_type_name === 'end',
      pageNumber: w.page_number,
      lineNumber: w.line_number,
    })),
  );
  return { ayahs, words };
}

function build(chapters: readonly number[]): MushafLayout & ChapterData {
  const parts = chapters.map(loadChapter);
  const ayahs = parts.flatMap((p) => p.ayahs);
  const words = parts.flatMap((p) => p.words);
  return { ...buildMushafLayout(words, ayahs), ayahs, words };
}

const rawDataAvailable = hasRawData();
const real = rawDataAvailable ? build(SUBSET) : null;
const report = rawDataAvailable ? validateLayout(real!, real!.ayahs) : null;
const nav = rawDataAvailable ? createMushafNavigation(real!.pages) : null;

function page(n: number) {
  const found = real.pages.find((p) => p.pageNumber === n);
  if (!found) throw new Error(`the captured grid has no page ${n}`);
  return found;
}

const codePoints = (text: string): string =>
  [...text].map((c) => c.codePointAt(0)!.toString(16).toUpperCase()).join(' ');

describe('real mushaf rows — chapters 1, 2, 5, 9, 78, 112, 113, 114', () => {
  const itWithRaw = rawDataAvailable ? it : it.skip;

  itWithRaw('places every captured word row', () => {
    expect(real!.words).toHaveLength(12275);
    expect(real!.stats.wordTokensInInput).toBe(11678);
    expect(real!.stats.endMarksInInput).toBe(597);
    expect(real!.ayahs).toHaveLength(597);
    expect(real!.unplaced).toEqual([]);
    expect(real!.stats.tokensPlaced).toBe(real!.stats.tokensInInput);
    expect(real!.stats.versesInInput).toBe(597);
    expect(real!.stats.ayahsWithoutWords).toBe(0);
  });

  itWithRaw('stays inside the real grid: pages 1..604, never taller than 15 lines', () => {
    expect(real!.stats.distinctPages).toBe(95);
    expect(real!.stats.distinctLines).toBe(1383);
    expect(real!.stats.maxLinesOnOnePage).toBe(MAX_MUSHAF_LINES);
    expect(real!.stats.maxLineNumberObserved).toBe(MAX_MUSHAF_LINES);
    for (const p of real!.pages) {
      expect(p.pageNumber).toBeGreaterThanOrEqual(1);
      expect(p.pageNumber).toBeLessThanOrEqual(MUSHAF_PAGE_COUNT);
      expect(p.lines.length).toBeLessThanOrEqual(MAX_MUSHAF_LINES);
      const lines = p.lines.map((l) => l.lineNumber);
      expect([...lines].sort((a, b) => a - b)).toEqual(lines);
      expect(lines[0]! >= 1).toBe(true);
      expect(p.tokenCount).toBe(p.lines.reduce((n, l) => n + l.words.length, 0));
    }
  });

  itWithRaw('explains every empty line slot as the band above a real surah start', () => {
    expect(report!.counts.emptyLineSlots).toBe(19);
    expect(report!.counts.explainedEmptyLineSlots).toBe(19);
    expect(report!.defects.filter((d) => d.code === 'line-gap')).toEqual([]);
    // the single page with a defect is the one carrying 2:181's word-count warning
    expect(report!.counts.pagesWithDefects).toBe(1);
    expect(real!.pages.every((p) => p.isComplete)).toBe(true);
  });

  itWithRaw('reports no structural defect — only the one known text/row disagreement', () => {
    expect(report!.ok).toBe(true);
    expect(report!.fatalCount).toBe(0);
    expect(report!.counts.duplicateReferences).toBe(0);
    expect(report!.counts.readingOrderInversions).toBe(0);
    expect(report!.counts.tokensUnplaced).toBe(0);
    expect(report!.defects.map((d) => d.code).sort()).toEqual(['verse-word-count', 'word-total-vs-tokenised']);
  });

  itWithRaw('names the ayah where the provider word rows and the ayah text disagree', () => {
    // measured over these eight chapters: only 2:181
    expect(report!.counts.tokenisedWordsExpected).toBe(11679);
    expect(report!.counts.wordsPlaced).toBe(11678);
    expect(report!.counts.wordTotalDelta).toBe(1);
    const verse = report!.defects.find((d) => d.code === 'verse-word-count')!;
    expect(verse.verseKey).toBe('2:181');
    expect(verse.detail).toBe('word rows place 13 tokens but the ayah text tokenises to 14');
    expect(verse.severity).toBe('warning');
  });

  itWithRaw('moves stale word-row pages onto the ayah anchor, and says so', () => {
    expect(real!.diagnostics.filter((d) => d.code === 'word-page-corrected').map((d) => d.subject)).toEqual([
      '5:77',
      '5:83',
      '5:90',
    ]);
    expect(real!.stats.pageCorrections).toBe(3);
    expect(report!.counts.pageCorrections).toBe(62);
    const moved = page(121).lines.flatMap((l) => l.words).filter((w) => w.verseKey === ('5:77' as VerseKey));
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.every((w) => w.pageCorrected)).toBe(true);
    expect(moved[0]!.declaredPage).toBe(120);
    expect(moved[0]!.page).toBe(121);
    // the anchor is what keeps the reading order monotonic: trusting the rows
    // alone leaves these tokens unplaced rather than guessed onto a page end
    const strict = buildMushafLayout(real!.words, real!.ayahs, { pagePolicy: 'word-strict' });
    expect(strict.unplaced.length).toBeGreaterThan(0);
    expect(strict.unplaced.every((u) => u.reason === 'reading-order-conflict')).toBe(true);
    expect(strict.pages.every((p) => p.isComplete)).toBe(false);
  });

  itWithRaw('reads the surah and juz seams where the mushaf actually puts them', () => {
    expect(nav!.surahStartOnPage(106)).toHaveLength(1);
    expect(nav!.surahStartOnPage(106)[0]).toMatchObject({ chapter: 5, verseKey: '5:1', lineNumber: 8 });
    // lines 1-5 of page 106 belong to surah 4, which this subset does not load
    expect(nav!.surahStartOnPage(106)[0]!.headingBandLines).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(nav!.surahStartOnPage(1)[0]).toMatchObject({ chapter: 1, verseKey: '1:1', lineNumber: 2 });
    expect(nav!.surahStartOnPage(582)[0]).toMatchObject({ chapter: 78, verseKey: '78:1', lineNumber: 3 });
    expect(nav!.pageRangeOfSurah(5)).toEqual({ from: 106, to: 127 });
    expect(nav!.pageRangeOfSurah(112)).toEqual({ from: 604, to: 604 });
    expect(nav!.pageRangeOfSurah(3)).toBeNull();

    expect(nav!.juzBoundaryPages).toEqual([121, 201]);
    expect(page(121).juzNumbers).toEqual([6, 7]);
    expect(page(201).juzNumbers).toEqual([10, 11]);
    expect(nav!.versesOnPage(201).slice(0, 2)).toEqual(['9:87', '9:88']);
  });

  itWithRaw('reproduces page 604 exactly as the captured rows describe it', () => {
    expect(page(604).lines.map((l) => l.lineNumber)).toEqual([3, 4, 7, 8, 9, 12, 13, 14, 15]);
    expect(page(604).emptyLineNumbers).toEqual([1, 2, 5, 6, 10, 11]);
    expect(page(604).tokenCount).toBe(73);
    expect(page(604).surahStarts.map((s) => [s.chapter, s.lineNumber])).toEqual([
      [112, 3],
      [113, 7],
      [114, 12],
    ]);
    expect(page(604).verseKeys).toEqual([
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
});

describe('real mushaf rows — rendering is byte-exact', () => {
  const itWithRaw = rawDataAvailable ? it : it.skip;

  itWithRaw('round-trips real pages without touching a single code point', () => {
    for (const pageNumber of [1, 106, 121, 582, 604]) {
      const rendered = renderPage(page(pageNumber), real!.words);
      expect(rendered.issues).toEqual([]);
      expect(rendered.tokensInOrder).toEqual(pageTokenTexts(page(pageNumber), real!.words));
      expect(removeWhitespace(rendered.text)).toBe(removeWhitespace(rendered.tokensInOrder.join('')));
      expect(rendered.tokenCount).toBe(page(pageNumber).tokenCount);
      // each line's own bytes check out too, so an inserted break cannot hide a edit
      let offset = 0;
      for (const line of rendered.lines) {
        const tokens = rendered.tokensInOrder.slice(offset, offset + line.words.length);
        offset += line.words.length;
        expect(removeWhitespace(line.text)).toBe(removeWhitespace(tokens.join('')));
      }
    }
  });

  itWithRaw("keeps the provider's non-NFC combining order on a real page", () => {
    const rendered = renderPage(page(604), real!.words);
    // 112:1 word 3 is `ٱللَّه`: shadda 0651 then fatha 064E — NFC would swap them
    const allah = real!.words.find((w) => w.verseKey === ('112:1' as VerseKey) && w.position === 3)!;
    expect(codePoints(allah.textUthmani)).toBe('671 644 644 651 64E 647 64F');
    expect(allah.textUthmani).not.toBe(allah.textUthmani.normalize('NFC'));
    expect(rendered.tokensInOrder).toContain(allah.textUthmani);
    expect(rendered.text).toContain(allah.textUthmani);
    expect(rendered.text).not.toContain(allah.textUthmani.normalize('NFC'));

    const nonNfc = rendered.tokensInOrder.filter((t) => t !== t.normalize('NFC'));
    expect(nonNfc).toHaveLength(20);
    expect(nonNfc.every((t) => codePoints(t).includes(' 651 '))).toBe(true);
    expect(rendered.text).not.toBe(rendered.text.normalize('NFC'));
  });

  itWithRaw('renders real end-of-ayah marks as their ayah-number sign, in place', () => {
    const rendered = renderPage(page(604), real!.words);
    const marks = rendered.lines.flatMap((l) => l.words.filter((w) => w.isEndOfAyahMark));
    expect(marks).toHaveLength(15);
    expect(marks.slice(0, 3).map((m) => [String(m.verseKey), m.ayahNumber, m.text])).toEqual([
      ['112:1', 1, '١'],
      ['112:2', 2, '٢'],
      ['112:3', 3, '٣'],
    ]);
    expect(marks[marks.length - 1]).toMatchObject({ verseKey: '114:6', ayahNumber: 6, text: '٦' });
    // line 3 of page 604, assembled from the rows themselves: three short surahs
    // share one line in the Madani mushaf, marks and all
    const line3 = page(604).lines[0]!;
    const expected = line3.refs
      .map((r) => real!.words.find((w) => w.verseKey === r.verseKey && w.position === r.position)!.textUthmani)
      .join(' ');
    expect(rendered.lines[0]!.text).toBe(expected);
    expect(line3.verseKeys).toEqual(['112:1', '112:2', '112:3']);
    expect(line3.words.length).toBe(line3.refs.length);
    // three short surahs share the line: 112:1 (+mark), 112:2 (+mark), 112:3's first words
    expect(line3.refs.map((r) => String(r.verseKey)).join(' ')).toBe(
      real!.words
        .filter((w) => w.pageNumber === 604 && w.lineNumber === 3)
        .map((w) => String(w.verseKey))
        .join(' '),
    );
  });
});

describe('real mushaf rows — full 604-page audit', () => {
  const audited = FULL_CORPUS && rawDataAvailable ? it : it.skip;

  audited(
    [
      'builds all 114 chapters: 604 pages, nothing unplaced, no fatal defect',
      '(skipped without MUSHAF_FULL_CORPUS=1: this audit re-reads the 228 raw',
      'provider files, which dominates the suite on a cold disk cache — the same',
      '604-page grid built from the shipped pack runs in the pack suite below)',
    ].join(' '),
    () => {
      const full = build(ALL_CHAPTERS);
      const fullReport = validateLayout(full, full.ayahs, { expectFullCorpus: true });
      const fullNav = createMushafNavigation(full.pages);

      expect(full.words).toHaveLength(83665);
      expect(full.stats.wordTokensInInput).toBe(77429);
      expect(full.stats.endMarksInInput).toBe(6236);
      expect(full.ayahs).toHaveLength(6236);
      expect(full.unplaced).toEqual([]);
      expect(full.emptyPages).toEqual([]);
      expect(full.stats.distinctPages).toBe(MUSHAF_PAGE_COUNT);
      expect(full.stats.distinctLines).toBe(8820);
      expect(full.stats.maxLinesOnOnePage).toBe(MAX_MUSHAF_LINES);
      expect(full.stats.maxLineNumberObserved).toBe(MAX_MUSHAF_LINES);
      expect(full.pages.map((p) => p.pageNumber)).toEqual(
        Array.from({ length: MUSHAF_PAGE_COUNT }, (_, i) => i + 1),
      );
      expect(full.pages.reduce((n, p) => n + p.surahStarts.length, 0)).toBe(114);
      expect(full.pages.every((p) => p.isComplete)).toBe(true);

      expect(fullReport.ok).toBe(true);
      expect(fullReport.fatalCount).toBe(0);
      expect(fullReport.counts.duplicateReferences).toBe(0);
      expect(fullReport.counts.readingOrderInversions).toBe(0);
      expect(fullReport.counts.emptyLineSlots).toBe(205);
      expect(fullReport.counts.explainedEmptyLineSlots).toBe(205);
      expect(fullReport.counts.tokenisedWordsExpected).toBe(77433);
      expect(fullReport.counts.wordsPlaced).toBe(77429);
      expect(fullReport.counts.wordTotalDelta).toBe(4);
      expect(fullReport.defects.map((d) => d.code).sort()).toEqual([
        'verse-word-count',
        'verse-word-count',
        'verse-word-count',
        'verse-word-count',
        'word-total-vs-tokenised',
      ]);
      expect(fullReport.defects.filter((d) => d.code === 'verse-word-count').map((d) => d.verseKey)).toEqual([
        '2:181',
        '8:6',
        '13:37',
        '37:130',
      ]);

      // 56 ayahs whose word rows still name the page they had before the mushaf
      // was re-cut; anchoring moves 361 tokens onto the ayah's own page
      expect(full.diagnostics.filter((d) => d.code === 'word-page-corrected')).toHaveLength(56);
      expect(fullReport.counts.pageCorrections).toBe(361);

      expect(fullNav.juzBoundaryPages).toEqual([62, 121, 201, 502]);
      expect(fullNav.surahStartOnPage(106)[0]!.headingBandLines).toEqual([6, 7]);
      expect(fullNav.versesOnPage(1)).toEqual(['1:1', '1:2', '1:3', '1:4', '1:5', '1:6', '1:7']);
      expect(fullNav.pageOfVerseKey('114:6')).toBe(604);
      // Al-Baqarah runs pages 2..49 of the 604-page Madani mushaf; Aal-Imran
      // opens on page 50. Asserted from the seam both ways so the number is
      // pinned by its neighbours, not by a remembered value.
      expect(fullNav.pageRangeOfSurah(2)).toEqual({ from: 2, to: 49 });
      expect(fullNav.pageOfVerseKey('2:286')).toBe(49);
      expect(fullNav.pageOfVerseKey('3:1')).toBe(50);
      expect(fullNav.pageRangeOfSurah(3)?.from).toBe(50);
    },
    240_000,
  );
});

/* -------------------------------------------------------------------------- */
/* the shipped pack: the grid has to be rebuildable offline from packs alone  */
/* -------------------------------------------------------------------------- */

type PackRow = Record<string, unknown>;

const WORD_PACK_JSON = ['content', 'word-data', 'pack.json'];
const WORD_PACK_PAYLOAD = ['content', 'word-data', 'payload.jsonl'];
const CORE_PACK_PAYLOAD = ['content', 'quran-core', 'payload.jsonl'];

function packLines(...segments: string[]): PackRow[] {
  return readText(...segments)
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as PackRow);
}

/** A pack word row → the layout input, mapped the way the desktop importer does. */
function wordFromPackRow(row: PackRow): LayoutWord {
  return {
    id: row.id as number,
    verseKey: row.verseKey as VerseKey,
    position: row.position as number,
    pageNumber: row.pageNumber as number,
    lineNumber: row.lineNumber as number,
    textUthmani: row.textUthmani as string,
    translationEn: (row.translationEn as string | null) ?? null,
    transliteration: (row.transliteration as string | null) ?? null,
    root: (row.root as string | null) ?? null,
    morphology: (row.morphology as string | null) ?? null,
    isEndOfAyahMark: row.isEndOfAyahMark as boolean,
  };
}

/**
 * A pack ayah row → `Ayah`. `word_count` / `normalized_hash` are derived columns
 * the pipeline does not ship and the importer recomputes from the authoritative
 * text (`desktop/src/content/records.ts` → `mapAyah`), so this does the same.
 */
function ayahFromPackRow(row: PackRow): Ayah {
  return {
    verseKey: row.verseKey as VerseKey,
    chapter: row.chapter as number,
    verse: row.verse as number,
    sourceId: (row.sourceId as number | null) ?? null,
    juz: row.juz as number,
    hizb: row.hizb as number,
    rubElHizb: row.rubElHizb as number,
    sajda: (row.sajda as number | null) ?? null,
    ruku: (row.ruku as number | null) ?? null,
    manzil: (row.manzil as number | null) ?? null,
    page: row.page as number,
    textUthmani: row.textUthmani as string,
    textUthmaniSimple: (row.textUthmaniSimple as string | null) ?? null,
    wordCount: wordCount(row.textUthmani as string),
    normalizedHash: normalizedFingerprint(row.textUthmani as string),
  };
}

/** Parsed once per process; reading 83 665 JSONL lines is the bulk of the cost. */
let packCache: { rows: PackRow[]; words: LayoutWord[]; ayahs: Ayah[] } | null = null;
function loadPacks(): { rows: PackRow[]; words: LayoutWord[]; ayahs: Ayah[] } {
  if (packCache) return packCache;
  const rows = packLines(...WORD_PACK_PAYLOAD);
  const ayahs = packLines(...CORE_PACK_PAYLOAD)
    .filter((r) => r._t === 'ayah')
    .map(ayahFromPackRow);
  packCache = { rows, words: rows.map(wordFromPackRow), ayahs };
  return packCache;
}

const chapterOf = (key: string): number => Number(key.split(':')[0]);

/**
 * The whole placement, as one string per page: every token with the page/line it
 * was placed on, what the row declared, whether the anchor moved it and whether
 * it is an end-of-ayah mark, plus the page-level facts the reader draws from
 * (line gaps, surah starts, juz numbers, completeness).
 *
 * Comparing these proves two builds produced the *same mushaf*, not the same
 * counts by coincidence.
 */
function gridSignature(layout: MushafLayout): string[] {
  return layout.pages.map((p) =>
    [
      `page ${p.pageNumber} tokens=${p.tokenCount} first=${p.firstVerseKey ?? '-'} continues=${p.continuesVerseFromPreviousPage ?? '-'}`,
      `juz=${p.juzNumbers.join('/')} starts=${p.surahStarts.map((s) => `${s.chapter}@${s.lineNumber}(${s.headingBandLines.join('-')})`).join(',')} empty=${p.emptyLineNumbers.join('-')} complete=${p.isComplete}`,
      `diags=${p.diagnostics.map((d) => d.code).join(',')}`,
      ...p.lines.map(
        (l) =>
          `line ${l.lineNumber}: ` +
          l.words
            .map(
              (w) =>
                `${w.verseKey}.${w.position}:${w.page}/${w.line}/${w.declaredPage ?? '-'}/${w.declaredLine ?? '-'}` +
                `${w.pageCorrected ? 'c' : ''}${w.isEndOfAyahMark ? 'm' : ''}`,
            )
            .join(' '),
      ),
    ].join('\n'),
  );
}

describe('content/word-data pack — mushaf grid from shipped data only', () => {
  const packExists = exists(...WORD_PACK_JSON) && exists(...WORD_PACK_PAYLOAD) && exists(...CORE_PACK_PAYLOAD);
  const itWithRaw = rawDataAvailable ? it : it.skip;

  it('is present, complete over all 114 chapters — and carries the mushaf columns', () => {
    expect(packExists).toBe(true);
    const pack = readJson<{
      recordCount: number;
      payloadBytes: number;
      coverage: { chapters: number[] };
    }>(...WORD_PACK_JSON);
    expect(pack.recordCount).toBe(83665);
    expect(pack.coverage.chapters).toHaveLength(114);

    const rows = loadPacks().rows;
    expect(rows).toHaveLength(pack.recordCount);
    expect(fileSize(...WORD_PACK_PAYLOAD)).toBe(pack.payloadBytes);
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'id',
      'isEndOfAyahMark',
      'lineNumber',
      'morphology',
      'pageNumber',
      'position',
      'root',
      'textUthmani',
      'translationEn',
      'transliteration',
      'verseKey',
    ]);

    // every row — word token and end-of-ayah mark alike — places itself on the
    // printed grid: pages 1..604 all covered, lines 1..15. Counted in one pass
    // and asserted once: 83 665 `expect` calls would dominate the suite.
    let rowsWithoutUsablePage = 0;
    let rowsWithoutUsableLine = 0;
    let maxLineObserved = 0;
    const pages = new Set<number>();
    for (const r of rows) {
      const page = r.pageNumber;
      const line = r.lineNumber;
      if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > MUSHAF_PAGE_COUNT) {
        rowsWithoutUsablePage += 1;
      } else {
        pages.add(page);
      }
      if (typeof line !== 'number' || !Number.isInteger(line) || line < 1 || line > MAX_MUSHAF_LINES) {
        rowsWithoutUsableLine += 1;
      } else if (line > maxLineObserved) {
        maxLineObserved = line;
      }
    }
    expect(rowsWithoutUsablePage).toBe(0);
    expect(rowsWithoutUsableLine).toBe(0);
    expect(pages.size).toBe(MUSHAF_PAGE_COUNT);
    expect(maxLineObserved).toBe(MAX_MUSHAF_LINES);
  }, 120_000);

  it('builds the mushaf grid from content/word-data rows', () => {
    const { words, ayahs } = loadPacks();
    const layout = buildMushafLayout(words, ayahs, { expectFullCorpus: true });
    expect(layout.unplaced).toEqual([]);
    expect(layout.emptyPages).toEqual([]);
    expect(layout.stats).toEqual({
      tokensInInput: 83665,
      wordTokensInInput: 77429,
      endMarksInInput: 6236,
      tokensPlaced: 83665,
      wordsPlaced: 77429,
      endMarksPlaced: 6236,
      tokensUnplaced: 0,
      distinctPages: MUSHAF_PAGE_COUNT,
      distinctLines: 8820,
      maxLinesOnOnePage: MAX_MUSHAF_LINES,
      maxLineNumberObserved: MAX_MUSHAF_LINES,
      versesInInput: 6236,
      ayahsSupplied: 6236,
      ayahsWithoutWords: 0,
      pageCorrections: 56,
    });
    expect(layout.pages.map((p) => p.pageNumber)).toEqual(
      Array.from({ length: MUSHAF_PAGE_COUNT }, (_, i) => i + 1),
    );

    // the same audit the raw rows pass, run on pack rows: no fatal defect, and
    // the only warnings are the four documented provider word-count quirks
    const report = validateLayout(layout, ayahs, { expectFullCorpus: true });
    expect(report.fatalCount).toBe(0);
    expect(report.counts.duplicateReferences).toBe(0);
    expect(report.counts.readingOrderInversions).toBe(0);
    expect(report.counts.tokensUnplaced).toBe(0);
    expect(report.counts.emptyLineSlots).toBe(205);
    expect(report.counts.explainedEmptyLineSlots).toBe(205);
    expect(report.counts.tokenisedWordsExpected).toBe(77433);
    expect(report.counts.wordsPlaced).toBe(77429);
    expect(report.counts.wordTotalDelta).toBe(4);
    expect(report.counts.pageCorrections).toBe(361);
    expect(report.defects.filter((d) => d.code === 'verse-word-count').map((d) => d.verseKey)).toEqual([
      '2:181',
      '8:6',
      '13:37',
      '37:130',
    ]);

    const nav = createMushafNavigation(layout.pages);
    expect(nav.juzBoundaryPages).toEqual([62, 121, 201, 502]);
    expect(nav.pageOfVerseKey('114:6')).toBe(604);
    expect(nav.pageRangeOfSurah(2)).toEqual({ from: 2, to: 49 });
    expect(nav.versesOnPage(1)).toEqual(['1:1', '1:2', '1:3', '1:4', '1:5', '1:6', '1:7']);
  });

  itWithRaw('places exactly what the provider rows place — subset chapters, row by row', () => {
    const { words, ayahs } = loadPacks();
    const subsetWords = words.filter((w) => SUBSET.includes(chapterOf(String(w.verseKey))));
    const subsetAyahs = ayahs.filter((a) => SUBSET.includes(a.chapter));
    expect(subsetWords).toHaveLength(real!.words.length);
    expect(subsetAyahs).toHaveLength(real!.ayahs.length);

    const fromPack = buildMushafLayout(subsetWords, subsetAyahs);
    expect(fromPack.stats).toEqual(real!.stats);
    expect(gridSignature(fromPack)).toEqual(gridSignature(real!));

    // and the rendered page is byte-identical, so the pack reproduces the
    // provider's own script order (no normalisation crept in through the pack)
    const packPage604 = fromPack.pages.find((p) => p.pageNumber === 604)!;
    const rendered = renderPage(packPage604, subsetWords);
    expect(rendered.issues).toEqual([]);
    expect(rendered.text).toBe(renderPage(page(604), real!.words).text);
    expect(rendered.tokensInOrder).toEqual(pageTokenTexts(packPage604, subsetWords));
  });

  const auditedFull = FULL_CORPUS && rawDataAvailable ? it : it.skip;
  auditedFull(
    FULL_CORPUS
      ? 'is identical to the raw provider grid over all 604 pages'
      : 'word-data pack not compared to every raw chapter — run with MUSHAF_FULL_CORPUS=1',
    () => {
      const { words, ayahs } = loadPacks();
      const fromPack = buildMushafLayout(words, ayahs, { expectFullCorpus: true });
      const fromRaw = build(ALL_CHAPTERS);
      expect(gridSignature(fromPack)).toEqual(gridSignature(fromRaw));
      expect(fromPack.stats).toEqual(fromRaw.stats);
    },
    240_000,
  );
});
