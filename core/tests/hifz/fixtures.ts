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
 * so no invented gloss can be mistaken for licensed content. The same holds for
 * every `SegmentMeaning` these fixtures hand the engine: the meaning axis tests
 * exactly the text the caller supplied, so a prefixed fixture string proves the
 * engine echoes a pack's words rather than writing its own.
 */

import type { AyahWord, VerseKey } from '../../src/contracts/quran';
import type {
  ConfusionGroup,
  DetectedError,
  ErrorKind,
  HifzItem,
  HifzSegment,
  HifzTransition,
  RecallAttempt,
  RecitedWord,
  SegmentMeaning,
} from '../../src/contracts/hifz';
import { RECALL_DIMENSION } from '../../src/contracts/hifz';
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
 * Madani mushaf placement for the fixture verses, read out of the provider
 * captures (`data/raw/quran-com/words-<chapter>.json`, first line of the ayah)
 * rather than invented here. `AyahWord` requires `pageNumber`/`lineNumber`
 * because every shipped word row carries them; the hifz and search engines never
 * read the two fields, and grid behaviour is tested in `core/tests/mushaf`.
 * Tokens of one ayah share its opening line in these fixtures.
 */
const FIXTURE_MUSHAF: Readonly<Record<VerseKey, { pageNumber: number; lineNumber: number }>> = {
  '1:1': { pageNumber: 1, lineNumber: 2 },
  '1:2': { pageNumber: 1, lineNumber: 3 },
  '1:3': { pageNumber: 1, lineNumber: 4 },
  '1:4': { pageNumber: 1, lineNumber: 4 },
  '1:5': { pageNumber: 1, lineNumber: 5 },
  '1:6': { pageNumber: 1, lineNumber: 6 },
  '1:7': { pageNumber: 1, lineNumber: 6 },
  '2:255': { pageNumber: 42, lineNumber: 8 },
  '108:1': { pageNumber: 602, lineNumber: 14 },
  '108:2': { pageNumber: 602, lineNumber: 14 },
  '108:3': { pageNumber: 602, lineNumber: 15 },
  '112:1': { pageNumber: 604, lineNumber: 3 },
  '112:2': { pageNumber: 604, lineNumber: 3 },
  '112:3': { pageNumber: 604, lineNumber: 3 },
  '112:4': { pageNumber: 604, lineNumber: 4 },
};

/** Page/line a fixture ayah's rows claim. A verse with no capture fails. */
export function fixturePlacement(verseKey: VerseKey): { pageNumber: number; lineNumber: number } {
  const found = FIXTURE_MUSHAF[verseKey];
  if (found) return found;
  throw new Error(`fixturePlacement: ${verseKey} has no captured mushaf placement — add it from data/raw, do not guess`);
}

/**
 * Build an `AyahWord` list from the fixture text. Positions are 1-based and
 * exclude ornamental marks, matching the `AyahWord` contract.
 */
export function fixtureWords(verseKey: VerseKey, glosses: readonly string[] = []): AyahWord[] {
  const tokens = tokenizeWords(ayahText(verseKey));
  const mushaf = fixturePlacement(verseKey);
  return tokens.map((text, index) => ({
    id: index + 1,
    verseKey,
    position: index + 1,
    ...mushaf,
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
  const mushaf = fixturePlacement(verseKey);
  return [
    ...words,
    {
      id: 10_000 + words.length,
      verseKey,
      position: words.length + 1,
      ...mushaf,
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
  const stability = overrides.stability ?? 0;
  return {
    sequence: [overrides.verseKey],
    addedAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    band: 'new',
    stability,
    // A fixture that names only the composite is a form-only history: the meaning
    // axis is `null` — never tested — not zero, which the contract reserves for
    // "tested and failed".
    formStability: stability,
    meaningStability: overrides.meaningStability === undefined ? null : overrides.meaningStability,
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
  const mode = overrides.mode ?? 'full-ayah';
  return {
    sessionId: null,
    mode,
    dimension: RECALL_DIMENSION[mode],
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

/** A segment row with a chosen stability, for scheduler/report tests. */
export function makeSegment(
  overrides: Partial<HifzSegment> & Pick<HifzSegment, 'itemId'>,
): HifzSegment {
  const position = overrides.position ?? 0;
  // The default names the fixture ayah the tests recite; a caller that tiles a
  // second ayah passes its own `verseKey`, because `position` restarts per ayah.
  const verseKey = overrides.verseKey ?? '112:1';
  return {
    id: `${overrides.itemId}:${verseKey}:s${position}`,
    verseKey,
    position,
    fromWord: 1,
    toWord: 2,
    text: 'segment',
    meaning: null,
    stability: 0,
    meaningStability: null,
    errorCount: 0,
    ...overrides,
  };
}

/**
 * A meaning row for the tests. The text is prefixed `fixture:` because these are
 * test strings, not licensed pack content — the engine treats both identically,
 * and this keeps an invented gloss from being mistaken for a real translation.
 */
export function makeMeaning(
  text: string,
  overrides: Partial<SegmentMeaning> = {},
): SegmentMeaning {
  return {
    text: `fixture:${text}`,
    lang: 'fa',
    packId: 'tr-fa-kaldari',
    wordGloss: false,
    ...overrides,
  };
}

/** A joined per-word gloss, as `segmentWordGloss` builds it. */
export function makeWordGloss(text: string, overrides: Partial<SegmentMeaning> = {}): SegmentMeaning {
  return makeMeaning(text, { packId: 'word-data', lang: 'en', wordGloss: true, ...overrides });
}

/** A transition row with a chosen stability. */
export function makeTransition(
  overrides: Partial<HifzTransition> & Pick<HifzTransition, 'itemId'>,
): HifzTransition {
  const toWord = overrides.toWord ?? 2;
  const kind = overrides.kind ?? 'intra';
  const verseKey = overrides.verseKey ?? '112:1';
  return {
    id: `${overrides.itemId}:${verseKey}:t${kind}${toWord}`,
    verseKey,
    kind,
    toVerseKey: kind === 'inter' ? '112:2' : null,
    toWord,
    successCount: 0,
    failureCount: 0,
    stability: 0,
    lastPracticedAt: null,
    ...overrides,
  };
}

/** A confusion group row. */
export function makeGroup(
  overrides: Partial<ConfusionGroup> & Pick<ConfusionGroup, 'verseKeys'>,
): ConfusionGroup {
  const verseKeys = [...overrides.verseKeys].sort();
  return {
    id: overrides.id ?? `cg-${overrides.origin ?? 'user'}-${verseKeys.join('+')}`,
    label: null,
    origin: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastTriggeredAt: null,
    confusionCount: 0,
    ...overrides,
    verseKeys,
  };
}

/** A detected-error row. */
export function makeError(
  kind: ErrorKind,
  expectedPosition: number,
  overrides: Partial<DetectedError> = {},
): DetectedError {
  return {
    kind,
    expectedPosition,
    expected: null,
    actual: null,
    confusedWithVerseKey: null,
    segmentPosition: null,
    explanation: 'fixture',
    ...overrides,
  };
}
