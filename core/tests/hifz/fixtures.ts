/**
 * TEST FIXTURES — NOT APP DATA.
 *
 * The Arabic strings below are copied verbatim from the Uthmani text of short
 * surahs (1, 108, 112) and ayah 2:255 so the segmentation, classification and
 * scheduling tests run against real recitation shapes. They are fixtures: the
 * runtime never reads Quran text from this file, it reads content packs. Any
 * future change to this file is a test change, not a content change.
 *
 * `translationEn` values are deliberately absent or prefixed with `fixture:`
 * so no invented gloss can be mistaken for licensed content.
 */

import type { AyahWord, VerseKey } from '../../src/contracts/quran';
import type {
  HifzItem,
  RecallAttempt,
  RecitedWord,
} from '../../src/contracts/hifz';
import { tokenizeWords } from '../../src/normalize/arabic';

export const FIXTURE_NOTE = 'test fixtures only — never authoritative app data';

/** verseKey -> authoritative Uthmani text (verbatim). */
export const AYAH_TEXT: Readonly<Record<VerseKey, string>> = {
  '1:1': 'بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ',
  '1:2': 'ٱلْحَمْدُ لِلَّهِ رَبِّ ٱلْعَٰلَمِينَ',
  '1:3': 'ٱلرَّحْمَٰنِ ٱلرَّحِيمِ',
  '1:4': 'مَٰلِكِ يَوْمِ ٱلدِّينِ',
  '1:5': 'إِيَّاكَ نَعْبُدُ وَإِيَّاكَ نَسْتَعِينُ',
  '1:6': 'ٱهْدِنَا ٱلصِّرَٰطَ ٱلْمُسْتَقِيمَ',
  '1:7': 'صِرَٰطَ ٱلَّذِينَ أَنْعَمْتَ عَلَيْهِمْ غَيْرِ ٱلْمَغْضُوبِ عَلَيْهِمْ وَلَا ٱلضَّآلِّينَ',
  '108:1': 'إِنَّآ أَعْطَيْنَٰكَ ٱلْكَوْثَرَ',
  '108:2': 'فَصَلِّ لِرَبِّكَ وَٱنْحَرْ',
  '108:3': 'إِنَّ شَانِئَكَ هُوَ ٱلْأَبْتَرُ',
  '112:1': 'قُلْ هُوَ ٱللَّهُ أَحَدٌ',
  '112:2': 'ٱللَّهُ ٱلصَّمَدُ',
  '112:3': 'لَمْ يَلِدْ وَلَمْ يُولَدْ',
  '112:4': 'وَلَمْ يَكُن لَّهُۥ كُفُوًا أَحَدٌۢ',
  '2:255':
    'ٱللَّهُ لَآ إِلَٰهَ إِلَّا هُوَ ٱلْحَىُّ ٱلْقَيُّومُ ۚ لَا تَأْخُذُهُۥ سِنَةٌۭ وَلَا نَوْمٌۭ ۚ لَّهُۥ مَا فِى ٱلسَّمَٰوَٰتِ وَمَا فِى ٱلْأَرْضِ ۗ مَن ذَا ٱلَّذِى يَشْفَعُ عِندَهُۥٓ إِلَّا بِإِذْنِهِۦ ۚ يَعْلَمُ مَا بَيْنَ أَيْدِيهِمْ وَمَا خَلْفَهُمْ ۖ وَلَا يُحِيطُونَ بِشَىْءٍۢ مِّنْ عِلْمِهِۦٓ إِلَّا بِمَا شَآءَ ۚ وَسِعَ كُرْسِيُّهُ ٱلسَّمَٰوَٰتِ وَٱلْأَرْضَ ۖ وَلَا يَـُٔودُهُۥ حِفْظُهُمَا ۚ وَهُوَ ٱلْعَلِىُّ ٱلْعَظِيمُ',
};

/** Surah 112 in order — used for sequence/transition fixtures. */
export const SURAH_112_KEYS: readonly VerseKey[] = ['112:1', '112:2', '112:3', '112:4'];

/** Surah 108 in order. */
export const SURAH_108_KEYS: readonly VerseKey[] = ['108:1', '108:2', '108:3'];

/** Al-Fatihah in order. */
export const SURAH_1_KEYS: readonly VerseKey[] = ['1:1', '1:2', '1:3', '1:4', '1:5', '1:6', '1:7'];

export function ayahText(verseKey: VerseKey): string {
  const text = AYAH_TEXT[verseKey];
  if (!text) throw new Error(`fixture ayah ${verseKey} is not defined`);
  return text;
}

/**
 * Build an `AyahWord` list from the fixture text. Positions are 1-based and
 * exclude ornamental marks, matching the `AyahWord` contract.
 */
export function fixtureWords(verseKey: VerseKey, glosses: readonly string[] = []): AyahWord[] {
  const tokens = tokenizeWords(ayahText(verseKey));
  return tokens.map((text, index) => ({
    id: index + 1,
    verseKey,
    position: index + 1,
    textUthmani: text,
    translationEn: glosses[index] ? `fixture:${glosses[index]}` : null,
    transliteration: null,
    root: null,
    morphology: null,
    isEndOfAyahMark: false,
  }));
}

/** The `AyahWord` list with the trailing end-of-ayah mark row, as packs ship it. */
export function fixtureWordsWithMark(verseKey: VerseKey): AyahWord[] {
  const words = fixtureWords(verseKey);
  return [
    ...words,
    {
      id: 10_000 + words.length,
      verseKey,
      position: words.length + 1,
      textUthmani: 'ۚ',
      translationEn: null,
      transliteration: null,
      root: null,
      morphology: null,
      isEndOfAyahMark: true,
    },
  ];
}

/** Words the user produced from a fixture ayah: pick, drop or swap positions. */
export function producedFrom(
  verseKey: VerseKey,
  spec: { drop?: readonly number[]; swap?: readonly [number, number][]; insertAfter?: { position: number; text: string }[]; replace?: { position: number; text: string }[] },
): RecitedWord[] {
  const tokens = tokenizeWords(ayahText(verseKey));
  const drop = new Set(spec.drop ?? []);
  const replace = new Map((spec.replace ?? []).map((r) => [r.position, r.text]));
  const out: RecitedWord[] = [];
  let duplicateAt = new Map<number, string>(
    (spec.insertAfter ?? []).map((i) => [i.position, i.text]),
  );
  const order = tokens.map((text, index) => ({ text, position: index + 1 }));
  if (spec.swap) {
    for (const [a, b] of spec.swap) {
      const wa = order[a - 1];
      const wb = order[b - 1];
      if (wa && wb) {
        const t = wa.text;
        order[a - 1] = { text: wb.text, position: a };
        order[b - 1] = { text: t, position: b };
      }
    }
  }
  let producedIndex = 1;
  for (const item of order) {
    if (drop.has(item.position)) continue;
    const replacement = replace.get(item.position);
    out.push({ position: producedIndex++, text: replacement ?? item.text });
    const extra = duplicateAt.get(item.position);
    if (extra) {
      out.push({ position: producedIndex++, text: extra });
    }
  }
  return out;
}

/** Produce the first `count` words of an ayah (a truncated recitation). */
export function producedPrefix(verseKey: VerseKey, count: number): RecitedWord[] {
  return tokenizeWords(ayahText(verseKey))
    .slice(0, count)
    .map((text, index) => ({ position: index + 1, text }));
}

/** Produce the whole ayah with one word replaced by another ayah's word. */
export function producedWithRun(
  verseKey: VerseKey,
  atPosition: number,
  runVerseKey: VerseKey,
): RecitedWord[] {
  const expected = tokenizeWords(ayahText(verseKey));
  const run = tokenizeWords(ayahText(runVerseKey));
  const out = expected.slice(0, atPosition - 1);
  out.push(...run);
  let producedIndex = 1;
  return [...out, ...expected.slice(atPosition)].map((text) => ({
    position: producedIndex++,
    text,
  }));
}

export function makeItem(overrides: Partial<HifzItem> & Pick<HifzItem, 'id' | 'verseKey'>): HifzItem {
  return {
    sequence: [overrides.verseKey],
    addedAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    band: 'new',
    stability: 0,
    strength: 0,
    lastReviewedAt: null,
    nextReviewAt: null,
    attemptCount: 0,
    errorCount: 0,
    ...overrides,
  };
}

export function makeAttempt(
  overrides: Partial<RecallAttempt> & Pick<RecallAttempt, 'id' | 'itemId' | 'verseKey'>,
): RecallAttempt {
  const expectedWordCount = overrides.expectedWordCount ?? 0;
  const correctWordCount = overrides.correctWordCount ?? 0;
  return {
    sessionId: null,
    mode: 'full-ayah',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    produced: [],
    cue: null,
    expectedWordCount,
    correctWordCount,
    accuracy: expectedWordCount > 0 ? correctWordCount / expectedWordCount : 0,
    errors: [],
    durationMs: null,
    selfConfidence: null,
    usedAudio: false,
    ...overrides,
  };
}

/** A day offset in the fixture timeline; the engine never reads the clock. */
export function dayIso(day: number, hour = 0): string {
  const date = new Date(Date.UTC(2026, 0, 1 + day, hour, 0, 0));
  return `${date.toISOString().slice(0, 11)}${String(hour).padStart(2, '0')}:00:00.000Z`;
}
