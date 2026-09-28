/**
 * SYNTHETIC mushaf fixtures for the layout tests.
 *
 * The shapes are the provider's (`page_number` + `line_number` per word row,
 * one `end` row per ayah) and the Arabic strings are copied verbatim from
 * `data/raw/quran-com/words-*.json`, but the page/line assignments below are a
 * hand-built miniature of the mushaf — small enough to assert on exactly. The
 * real 604-page grid is covered by `real-corpus.test.ts`, which reads the
 * captured rows.
 *
 * What the fixture deliberately contains:
 *  - page 106: end of surah 4, then a two-line heading band (6, 7), then surah 5
 *    starting mid-page at line 8 — the surah-boundary page;
 *  - page 121: juz 6 and juz 7 meeting mid-line at line 5, where the juz marker
 *    travels *inside* a word token (`۞ لَتَجِدَنَّ`), with no surah start;
 *  - page 604: three surahs on one page (112, 113, 114), three heading bands;
 *  - a word token with an embedded space and waqf sign (`ٱلْكَلَـٰلَةِ ۚ`);
 *  - a token whose combining marks are ordered shadda-then-fatha and therefore
 *    differ from its NFC form (`ٱللَّهُ`, code points 671 644 644 651 64E 647 64F).
 */

import type { Ayah, AyahWord, VerseKey } from '../../src/contracts/quran';
import { normalizedFingerprint, wordCount } from '../../src/normalize/arabic';
import type { LayoutWord } from '../../src/mushaf/layout';

export interface TokenSpec {
  verseKey: string;
  text: string;
  page: number;
  line: number;
  end?: boolean;
}

export interface LineSpec {
  page: number;
  line: number;
  tokens: Array<readonly [verseKey: string, text: string, end?: true]>;
}

export interface AyahFixtureOptions {
  juz?: number;
  hizb?: number;
  rubElHizb?: number;
  page?: number;
}

/** Build an `Ayah` row the same way the pipeline does (derived fields computed). */
export function ayahFixture(
  verseKey: string,
  textUthmani: string,
  options: AyahFixtureOptions = {},
): Ayah {
  const [chapter, verse] = verseKey.split(':').map((x) => Number.parseInt(x, 10));
  return {
    verseKey: verseKey as VerseKey,
    chapter: chapter!,
    verse: verse!,
    sourceId: null,
    juz: options.juz ?? 1,
    hizb: options.hizb ?? 1,
    rubElHizb: options.rubElHizb ?? 1,
    sajda: null,
    ruku: null,
    manzil: null,
    page: options.page ?? 1,
    textUthmani,
    textUthmaniSimple: null,
    wordCount: wordCount(textUthmani),
    normalizedHash: normalizedFingerprint(textUthmani),
  };
}

export interface FixtureCorpus {
  words: LayoutWord[];
  ayahs: Ayah[];
  /** juz / hizb per verse key, so tests can restated what the fixture claims. */
  meta: Map<string, AyahFixtureOptions>;
}

/**
 * Expand line specs into word rows plus ayah rows.
 * Positions are assigned per verse in reading order: word tokens 1..n, then the
 * end-of-ayah mark at n+1 — exactly how the provider numbers them.
 */
export function buildFixture(lines: LineSpec[], meta: Map<string, AyahFixtureOptions> = new Map()): FixtureCorpus {
  const words: LayoutWord[] = [];
  const texts = new Map<string, string[]>();
  let id = 1000;

  for (const line of lines) {
    for (const [verseKey, text, end] of line.tokens) {
      const previous = words.filter((w) => w.verseKey === verseKey);
      const wordTokens = previous.filter((w) => !w.isEndOfAyahMark).length;
      /* words take 1..n, the end-of-ayah mark lands on n+1 */
      const position = wordTokens + 1;
      if (!end) texts.set(verseKey, [...(texts.get(verseKey) ?? []), text]);
      words.push({
        id: id++,
        verseKey: verseKey as VerseKey,
        position,
        textUthmani: text,
        translationEn: null,
        transliteration: null,
        root: null,
        morphology: null,
        isEndOfAyahMark: end === true,
        pageNumber: line.page,
        lineNumber: line.line,
      });
    }
  }

  const ayahs: Ayah[] = [];
  for (const [verseKey, parts] of texts) {
    const options = meta.get(verseKey) ?? {};
    ayahs.push(
      ayahFixture(
        verseKey,
        parts.join(' '),
        // the page the words actually sit on, unless the fixture overrides it
        { page: Number(words.find((w) => w.verseKey === verseKey)?.pageNumber ?? 1), ...options },
      ),
    );
  }
  ayahs.sort((a, b) => a.chapter - b.chapter || a.verse - b.verse);
  return { words, ayahs, meta };
}

const JUZ6: AyahFixtureOptions = { juz: 6, hizb: 11, rubElHizb: 43 };
const JUZ7: AyahFixtureOptions = { juz: 7, hizb: 13, rubElHizb: 51 };
const JUZ30: AyahFixtureOptions = { juz: 30, hizb: 60, rubElHizb: 240 };

/** The miniature mushaf described in the file header. */
export function miniMushaf(): FixtureCorpus {
  const meta = new Map<string, AyahFixtureOptions>([
    ['4:176', { juz: 5, hizb: 10, rubElHizb: 38 }],
    ['5:1', JUZ6],
    ['5:2', JUZ6],
    ['5:80', JUZ6],
    ['5:81', JUZ6],
    ['5:82', JUZ7],
    ['112:1', JUZ30],
    ['112:2', JUZ30],
    ['112:3', JUZ30],
    ['112:4', JUZ30],
    ['113:1', JUZ30],
    ['113:2', JUZ30],
    ['113:3', JUZ30],
    ['113:4', JUZ30],
    ['113:5', JUZ30],
    ['114:1', JUZ30],
    ['114:2', JUZ30],
    ['114:3', JUZ30],
    ['114:4', JUZ30],
    ['114:5', JUZ30],
    ['114:6', JUZ30],
  ]);

  return buildFixture(
    [
      /* page 106 — end of surah 4, heading band, start of surah 5 */
      {
        page: 106,
        line: 1,
        tokens: [
          ['4:176', 'يَسْتَفْتُونَكَ'],
          ['4:176', 'قُلِ'],
          ['4:176', 'ٱللَّهُ'],
          ['4:176', 'يُفْتِيكُمْ'],
          ['4:176', 'فِى'],
          ['4:176', 'ٱلْكَلَـٰلَةِ ۚ'],
        ],
      },
      {
        page: 106,
        line: 2,
        tokens: [
          ['4:176', 'إِنِ'],
          ['4:176', 'ٱمْرُؤٌا۟'],
          ['4:176', 'هَلَكَ'],
          ['4:176', 'لَيْسَ'],
          ['4:176', 'لَهُۥ'],
          ['4:176', 'وَلَدٌۭ'],
        ],
      },
      {
        page: 106,
        line: 3,
        tokens: [
          ['4:176', 'وَلَهُۥٓ'],
          ['4:176', 'أُخْتٌۭ'],
          ['4:176', 'فَلَهَا'],
          ['4:176', 'نِصْفُ'],
          ['4:176', 'مَا'],
          ['4:176', 'تَرَكَ ۚ'],
        ],
      },
      {
        page: 106,
        line: 4,
        tokens: [
          ['4:176', 'وَإِن'],
          ['4:176', 'كَانُوا۟'],
          ['4:176', 'إِخْوَةًۭ'],
          ['4:176', 'فَلِلذَّكَرِ'],
        ],
      },
      { page: 106, line: 5, tokens: [['4:176', '١٧٦', true]] },
      /* lines 6 and 7: no word rows — the band above surah 5 */
      {
        page: 106,
        line: 8,
        tokens: [
          ['5:1', 'يَـٰٓأَيُّهَا'],
          ['5:1', 'ٱلَّذِينَ'],
          ['5:1', 'ءَامَنُوٓا۟'],
          ['5:1', 'أَوْفُوا۟'],
        ],
      },
      {
        page: 106,
        line: 9,
        tokens: [
          ['5:1', 'بِٱلْعُقُودِ ۚ'],
          ['5:1', 'أُحِلَّتْ'],
          ['5:1', 'لَكُم'],
          ['5:1', '١', true],
        ],
      },
      /* page 107 — surah 5 continues from the previous page */
      {
        page: 107,
        line: 1,
        tokens: [
          ['5:2', 'يَـٰٓأَيُّهَا'],
          ['5:2', 'ٱلَّذِينَ'],
          ['5:2', 'ءَامَنُوا۟'],
          ['5:2', 'لَا'],
          ['5:2', 'تُحِلُّوا۟'],
        ],
      },
      {
        page: 107,
        line: 2,
        tokens: [
          ['5:2', 'شَعَـٰٓئِرَ'],
          ['5:2', 'ٱللَّهِ'],
          ['5:2', 'وَلَا'],
          ['5:2', 'ٱلشَّهْرَ'],
        ],
      },
      {
        page: 107,
        line: 3,
        tokens: [
          ['5:2', 'ٱلْحَرَامَ'],
          ['5:2', '٢', true],
        ],
      },
      /* page 121 — juz 6 and juz 7 meet mid-line, no surah start */
      {
        page: 121,
        line: 1,
        tokens: [
          ['5:80', 'يَتَوَلَّوْنَ'],
          ['5:80', 'ٱلَّذِينَ'],
          ['5:80', 'كَفَرُوا۟ ۚ'],
          ['5:80', 'لَبِئْسَ'],
        ],
      },
      {
        page: 121,
        line: 2,
        tokens: [
          ['5:80', 'مَا'],
          ['5:80', 'قَدَّمَتْ'],
          ['5:80', 'أَنفُسُهُمْ'],
          ['5:80', '٨٠', true],
        ],
      },
      {
        page: 121,
        line: 3,
        tokens: [
          ['5:81', 'وَلَوْ'],
          ['5:81', 'كَانُوا۟'],
          ['5:81', 'يُؤْمِنُونَ'],
        ],
      },
      {
        page: 121,
        line: 4,
        tokens: [
          ['5:81', 'مَا'],
          ['5:81', 'ٱتَّخَذُوهُمْ'],
          ['5:81', '٨١', true],
        ],
      },
      {
        page: 121,
        line: 5,
        tokens: [
          ['5:82', '۞ لَتَجِدَنَّ'],
          ['5:82', 'أَشَدَّ'],
          ['5:82', 'ٱلنَّاسِ'],
          ['5:82', 'عَدَٰوَةً'],
        ],
      },
      {
        page: 121,
        line: 6,
        tokens: [
          ['5:82', 'ٱلَّذِينَ'],
          ['5:82', 'قَالُوٓا۟'],
          ['5:82', '٨٢', true],
        ],
      },
      /* page 604 — three surahs, three heading bands; lines 3, 4, 7, 8, 9, 12,
       * 13, 14, 15 carry words, exactly as the provider rows do. */
      {
        page: 604,
        line: 3,
        tokens: [
          ['112:1', 'قُلْ'],
          ['112:1', 'هُوَ'],
          ['112:1', 'ٱللَّهُ'],
          ['112:1', 'أَحَدٌ'],
          ['112:1', '١', true],
          ['112:2', 'ٱللَّهُ'],
          ['112:2', 'ٱلصَّمَدُ'],
          ['112:2', '٢', true],
          ['112:3', 'لَمْ'],
          ['112:3', 'يَلِدْ'],
        ],
      },
      {
        page: 604,
        line: 4,
        tokens: [
          ['112:3', 'وَلَمْ'],
          ['112:3', 'يُولَدْ'],
          ['112:3', '٣', true],
          ['112:4', 'وَلَمْ'],
          ['112:4', 'يَكُن'],
          ['112:4', 'لَّهُۥ'],
          ['112:4', 'كُفُوًا'],
          ['112:4', 'أَحَدٌۢ'],
          ['112:4', '٤', true],
        ],
      },
      {
        page: 604,
        line: 7,
        tokens: [
          ['113:1', 'قُلْ'],
          ['113:1', 'أَعُوذُ'],
          ['113:1', 'بِرَبِّ'],
          ['113:1', 'ٱلْفَلَقِ'],
          ['113:1', '١', true],
          ['113:2', 'مِن'],
          ['113:2', 'شَرِّ'],
          ['113:2', 'مَا'],
          ['113:2', 'خَلَقَ'],
          ['113:2', '٢', true],
          ['113:3', 'وَمِن'],
        ],
      },
      {
        page: 604,
        line: 8,
        tokens: [
          ['113:3', 'شَرِّ'],
          ['113:3', 'غَاسِقٍ'],
          ['113:3', 'إِذَا'],
          ['113:3', 'وَقَبَ'],
          ['113:3', '٣', true],
          ['113:4', 'وَمِن'],
          ['113:4', 'شَرِّ'],
          ['113:4', 'ٱلنَّفَّـٰثَـٰتِ'],
          ['113:4', 'فِى'],
        ],
      },
      {
        page: 604,
        line: 9,
        tokens: [
          ['113:4', 'ٱلْعُقَدِ'],
          ['113:4', '٤', true],
          ['113:5', 'وَمِن'],
          ['113:5', 'شَرِّ'],
          ['113:5', 'حَاسِدٍ'],
          ['113:5', 'إِذَا'],
          ['113:5', 'حَسَدَ'],
          ['113:5', '٥', true],
        ],
      },
      {
        page: 604,
        line: 12,
        tokens: [
          ['114:1', 'قُلْ'],
          ['114:1', 'أَعُوذُ'],
          ['114:1', 'بِرَبِّ'],
          ['114:1', 'ٱلنَّاسِ'],
          ['114:1', '١', true],
          ['114:2', 'مَلِكِ'],
          ['114:2', 'ٱلنَّاسِ'],
          ['114:2', '٢', true],
          ['114:3', 'إِلَـٰهِ'],
        ],
      },
      {
        page: 604,
        line: 13,
        tokens: [
          ['114:3', 'ٱلنَّاسِ'],
          ['114:3', '٣', true],
          ['114:4', 'مِن'],
          ['114:4', 'شَرِّ'],
          ['114:4', 'ٱلْوَسْوَاسِ'],
          ['114:4', 'ٱلْخَنَّاسِ'],
          ['114:4', '٤', true],
          ['114:5', 'ٱلَّذِى'],
        ],
      },
      {
        page: 604,
        line: 14,
        tokens: [
          ['114:5', 'يُوَسْوِسُ'],
          ['114:5', 'فِى'],
          ['114:5', 'صُدُورِ'],
          ['114:5', 'ٱلنَّاسِ'],
          ['114:5', '٥', true],
        ],
      },
      {
        page: 604,
        line: 15,
        tokens: [
          ['114:6', 'مِنَ'],
          ['114:6', 'ٱلْجِنَّةِ'],
          ['114:6', 'وَٱلنَّاسِ'],
          ['114:6', '٦', true],
        ],
      },
    ],
    meta,
  );
}

/** Words + ayahs for one page where the word row's page disagrees with the ayah. */
export function anchorConflictFixture(): FixtureCorpus {
  const corpus = buildFixture(
    [
      {
        page: 120,
        line: 14,
        tokens: [
          ['5:76', 'قُلْ'],
          ['5:76', 'أَتَعْبُدُونَ'],
        ],
      },
      {
        page: 120,
        line: 15,
        tokens: [
          ['5:76', 'ٱلسَّمِيعُ'],
          ['5:76', 'ٱلْعَلِيمُ'],
          ['5:76', '٧٦', true],
        ],
      },
      /* provider word rows still say page 120 here, but the lines restart at 1:
       * these tokens belong to page 121 (measured in the real corpus). */
      {
        page: 120,
        line: 1,
        tokens: [
          ['5:77', 'قُلْ'],
          ['5:77', 'يَـٰٓأَهْلَ'],
          ['5:77', 'ٱلْكِتَـٰبِ'],
        ],
      },
      {
        page: 120,
        line: 2,
        tokens: [
          ['5:77', 'لَا'],
          ['5:77', 'تَغْلُوا۟'],
          ['5:77', '٧٧', true],
        ],
      },
      {
        page: 121,
        line: 3,
        tokens: [
          ['5:78', 'لُعِنَ'],
          ['5:78', 'ٱلَّذِينَ'],
          ['5:78', '٧٨', true],
        ],
      },
    ],
    new Map<string, AyahFixtureOptions>([
      ['5:76', { page: 120, ...JUZ6 }],
      /* the ayah row says 121 — and the line numbers only read correctly there */
      ['5:77', { page: 121, ...JUZ6 }],
      ['5:78', { page: 121, ...JUZ6 }],
    ]),
  );
  return corpus;
}

export function toArabicIndic(value: number): string {
  return String(value)
    .split('')
    .map((d) => String.fromCharCode(0x0660 + Number.parseInt(d, 10)))
    .join('');
}

export type { AyahWord };
