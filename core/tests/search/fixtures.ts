/**
 * Hand-written test fixtures.
 *
 * REAL ARABIC TEXT: the ayah texts below were copied by hand from memory of
 * the standard printed mushaf into this TEST FILE ONLY, labelled as fixtures.
 * They are used to exercise normalisation/RTL paths on genuinely similar
 * Quranic phrasing (the repeated refrain of ar-Rahman, the near-identical
 * pair 55:54/55:76, the salam pair in as-Saffat, the "أولئك" endings).
 * They are NOT the shipped content pipeline — production text comes from
 * validated licensed content packs only (AGENTS.md rule 1/2).
 *
 * Everything marked `synthetic` is fabricated for guards/bulk tests.
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
} from '../../src/contracts/quran';
import { normalizedFingerprint, wordCount } from '../../src/normalize/arabic';

export function mkAyah(chapter: number, verse: number, textUthmani: string): Ayah {
  return {
    verseKey: `${chapter}:${verse}` as VerseKey,
    chapter,
    verse,
    sourceId: null,
    juz: 1,
    hizb: 1,
    rubElHizb: 1,
    sajda: null,
    ruku: null,
    manzil: null,
    page: 1,
    textUthmani,
    textUthmaniSimple: null,
    // Derived with the canonical normalisation — never hand-typed.
    wordCount: wordCount(textUthmani),
    normalizedHash: normalizedFingerprint(textUthmani),
  };
}

/* ---------------- real-text fixtures (hand-copied, labelled) ---------------- */

export const A_1_1 = mkAyah(1, 1, 'بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ');
export const A_1_2 = mkAyah(1, 2, 'الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ');
export const A_2_5 = mkAyah(2, 5, 'أُولَئِكَ عَلَى هُدًى مِنْ رَبِّهِمْ وَأُولَئِكَ هُمُ الْمُؤْمِنُونَ');
export const A_8_4 = mkAyah(
  8,
  4,
  'أُولَئِكَ هُمُ الْمُؤْمِنُونَ حَقًّا لَهُمْ دَرَجَاتٌ عِنْدَ رَبِّهِمْ فِي جَنَّاتٍ تَجْرِي مِنْ تَحْتِهَا الْأَنْهَارُ خَالِدِينَ فِيهَا وَنِعْمَ أَجْرُ الْعَامِلِينَ',
);
export const A_55_13 = mkAyah(55, 13, 'فَبِأَيِّ آلَاءِ رَبِّكُمَا تُكَذِّبَانِ');
export const A_55_77 = mkAyah(55, 77, 'فَبِأَيِّ آلَاءِ رَبِّكُمَا تُكَذِّبَانِ');
export const A_55_54 = mkAyah(55, 54, 'مُتَّكِئِينَ عَلَى حَشْوٍ خُضْرٍ وَعَبْقَرِيٍّ حِسَانٍ');
export const A_55_76 = mkAyah(55, 76, 'مُتَّكِئِينَ عَلَى رَفْرَفٍ خُضْرٍ وَعَبْقَرِيٍّ حِسَانٍ');
export const A_55_67 = mkAyah(55, 67, 'تَبَارَكَ اسْمُ رَبِّكَ ذِي الْجَلالِ وَالإكْرَامِ');
export const A_55_78 = mkAyah(55, 78, 'تَبَارَكَ اسْمِ رَبِّكَ ذِي الْجَلالِ وَالإكْرَامِ');
export const A_37_120 = mkAyah(37, 120, 'سُبْحَانَ اللَّهِ عَمَّا يَصِفُونَ');
export const A_37_159 = mkAyah(37, 159, 'سُبْحَانَ اللَّهِ عَمَّا يَصِفُونَ');
export const A_37_130 = mkAyah(37, 130, 'سَلامٌ عَلَى إِلْ يَاسِينَ');
export const A_37_131 = mkAyah(37, 131, 'سَلامٌ عَلَى إِبْرَاهِيمَ');
export const A_37_180 = mkAyah(37, 180, 'سُبْحَانَ رَبِّكَ رَبِّ الْعِزَّةِ عَمَّا يَصِفُونَ');
export const A_103_1 = mkAyah(103, 1, 'وَالْعَصْرِ');
export const A_91_1 = mkAyah(91, 1, 'وَالشَّمْسِ');
export const A_91_2 = mkAyah(91, 2, 'وَقَمَرِهَا');

/** All real-text ayahs, in canonical order. */
export const REAL_FIXTURE_AYAHS: Ayah[] = [
  A_1_1,
  A_1_2,
  A_2_5,
  A_8_4,
  A_37_120,
  A_37_130,
  A_37_131,
  A_37_159,
  A_37_180,
  A_55_13,
  A_55_54,
  A_55_67,
  A_55_76,
  A_55_77,
  A_55_78,
  A_91_1,
  A_91_2,
  A_103_1,
];

/* ---------------- synthetic fixtures (guards / bulk) ---------------- */

/** Eight synthetic one-word ayahs sharing one word: short-ayah flood test. */
export const SYNTHETIC_SHORT_AYAHS: Ayah[] = Array.from(
  { length: 8 },
  (_, i) => mkAyah(777, i + 1, 'رَبِّ'),
);

/** Synthetic one-word ayahs that are NOT mutually similar. */
export const SYNTHETIC_UNRELATED_SHORT_AYAHS: Ayah[] = [
  mkAyah(778, 1, 'شَمْس'),
  mkAyah(778, 2, 'قَمَر'),
  mkAyah(778, 3, 'نَجْم'),
];

/* ---------------- translations (fixture translations, editorial) ---------------- */

export const TRANSLATIONS: Translation[] = [
  {
    verseKey: '1:1',
    packId: 'tr-en-demo',
    text: 'In the name of Allah, the Entirely Merciful, the Especially Merciful',
  },
  {
    verseKey: '1:2',
    packId: 'tr-en-demo',
    text: 'All praise is due to Allah, Lord of the worlds',
  },
  {
    verseKey: '55:13',
    packId: 'tr-en-demo',
    text: 'So which of the favors of your Lord would you deny?',
  },
  { verseKey: '1:1', packId: 'tr-fa-demo', text: 'به نام خداوند بخشنده مهربان' },
  {
    verseKey: '55:13',
    packId: 'tr-fa-demo',
    text: 'پس کدام‌یک از نعمت‌های پروردگارتان را انکار می‌کنید؟',
  },
  {
    verseKey: '2:5',
    packId: 'tr-fa-demo',
    text: ' آنها بر هدایتی از پروردگار خودند و آنها همان مؤمنانند',
  },
];

/* ---------------- word-level data with roots (synthetic annotation) ---------------- */

/**
 * Madani mushaf placement of the two fixture ayahs, read from
 * `data/raw/quran-com/words-1.json` (Al-Fatihah opens on page 1 line 2, the
 * second ayah on line 3). `AyahWord` requires both numbers because every
 * shipped word row carries them; the search index never reads them, and grid
 * behaviour is covered by `core/tests/mushaf`.
 */
const SEARCH_FIXTURE_PAGE = 1;
const SEARCH_FIXTURE_LINE: Record<string, number> = { '1:1': 2, '1:2': 3 };

function mkWord(
  id: number,
  verseKey: VerseKey,
  position: number,
  textUthmani: string,
  root: string | null,
): AyahWord {
  const lineNumber = SEARCH_FIXTURE_LINE[verseKey];
  if (lineNumber === undefined) throw new Error(`mkWord: no captured mushaf line for fixture ayah ${verseKey}`);
  return {
    id,
    verseKey,
    position,
    pageNumber: SEARCH_FIXTURE_PAGE,
    lineNumber,
    textUthmani,
    translationEn: null,
    transliteration: null,
    root,
    morphology: null,
    isEndOfAyahMark: false,
  };
}

/** Root annotations are synthetic for the test pack (real packs carry their
 * own morphological data); the Arabic surface forms are the fixture texts. */
export const WORDS: AyahWord[] = [
  mkWord(1, '1:1', 1, 'بِسْمِ', null),
  mkWord(2, '1:1', 2, 'اللَّهِ', 'أ ل ل ه'),
  mkWord(3, '1:1', 3, 'الرَّحْمَنِ', 'ر ح م'),
  mkWord(4, '1:1', 4, 'الرَّحِيمِ', 'ر ح م'),
  mkWord(5, '1:2', 1, 'الْحَمْدُ', 'ح م د'),
  mkWord(6, '1:2', 2, 'لِلَّهِ', 'أ ل ل ه'),
  mkWord(7, '1:2', 3, 'رَبِّ', 'ر ب ب'),
  mkWord(8, '1:2', 4, 'الْعَالَمِينَ', 'ع ل م'),
];

/** Same word rows but every root nulled — the "data does not provide roots" case. */
export const WORDS_WITHOUT_ROOTS: AyahWord[] = WORDS.map((w) => ({ ...w, root: null }));

/* ---------------- concept pack fixture (editorial) ---------------- */

export const CONCEPTS: Concept[] = [
  {
    id: 'demo-mercy',
    labelArabic: 'الرحمة',
    labelFa: 'رحمت',
    labelEn: 'Mercy',
    descriptionFa: 'رحمت واسع خداوند که در آیات بسیاری آمده است',
    relationType: 'editorial',
    producedBy: 'concept-pack-demo@v1',
  },
  {
    id: 'demo-patience',
    labelArabic: 'الصبر',
    labelFa: 'صبر',
    labelEn: 'Patience',
    descriptionFa: 'صبر در برابر سختی‌ها',
    relationType: 'editorial',
    producedBy: 'concept-pack-demo@v1',
  },
];

export const CONCEPT_LINKS: ConceptAyahLink[] = [
  { conceptId: 'demo-mercy', verseKey: '1:1', type: 'editorial', reason: 'demo link' },
  { conceptId: 'demo-mercy', verseKey: '55:13', type: 'editorial', reason: 'demo link' },
  { conceptId: 'demo-patience', verseKey: '2:5', type: 'editorial', reason: 'demo link' },
];

/* ---------------- user data fixtures ---------------- */

export const NOTES: Note[] = [
  {
    id: 'note-1',
    verseKey: '55:13',
    body: 'مراجعة حفظ آيات الرحمن — repeat rahman ayahs weekly',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'note-2',
    verseKey: '1:1',
    body: 'بسم الله الرحمن الرحیم را روز اول بخوان',
    createdAt: '2026-01-02T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
  },
];

export const BOOKMARKS: Bookmark[] = [
  { id: 'bm-1', verseKey: '2:255', page: null, label: 'حفظ آية الكرسي', createdAt: '2026-01-03T00:00:00Z' },
  { id: 'bm-2', verseKey: null, page: 42, label: null, createdAt: '2026-01-03T00:00:00Z' },
];
