/**
 * Dual-axis hifz method: the meaning axis.
 *
 * Every one of the fifteen form probes cues Arabic with Arabic, so a learner can
 * pass all fifteen having memorised nothing but sounds. These tests pin the second
 * axis end to end: a licensed meaning is the cue, the Arabic is the answer, the
 * two stabilities are stored and reported apart, and the weaker axis is what the
 * schedule reads.
 *
 * Two rules are checked over and over, because they are the two that are easy to
 * break by accident:
 *   1. no meaning text is ever invented — a probe without a supplied meaning
 *      refuses, and a session without meaning data emits no meaning step;
 *   2. an attempt on one axis never moves the other.
 */

import { describe, expect, it } from 'vitest';
import {
  PROBE_MODES,
  buildProbe,
  conceptCueProbe,
  meaningToArabicProbe,
  type ProbeAyah,
  type ProbeContext,
} from '../../src/hifz/recall';
import {
  RECALL_DIMENSION,
  RECALL_MODES,
  type HifzItem,
  type RecallAttempt,
  type RecallMode,
  type SessionStep,
} from '../../src/contracts/hifz';
import type { VerseKey } from '../../src/contracts/quran';
import {
  classifyRecitation,
  type ClassificationResult,
} from '../../src/hifz/classify';
import { segmentAyah } from '../../src/hifz/segment';
import {
  applyAttemptToAxes,
  applyAttemptToSegment,
  attemptDimension,
  compositeStability,
  computeStabilityByAxis,
  limitingAxisOf,
  partitionAttemptsByDimension,
  type StabilityAttempt,
} from '../../src/hifz/stability';
import {
  buildSessionSteps,
  computeSessionReport,
  meaningModeFor,
  stabilityAfterSession,
  type BuildSessionInput,
  type SessionMeaningSource,
} from '../../src/hifz/session';
import {
  historyFor,
  meaningLagOf,
  planReviews,
  rawFactors,
  scoreItem,
  suggestMode,
  buildDailyPlan,
  factorSummaries,
  type ItemHistory,
  type MeaningCoverage,
  type ReviewContextInput,
} from '../../src/hifz/review';
import {
  AXIS_LEARN_RATE,
  CONCEPT_CUE_EXPECTED_WORDS,
  MEANING_CONCEPT_CUE_MAX_GAP,
  MEANING_DRILL_ITEM_CAP,
  MEANING_GAP_SATURATION,
  MEANING_UNTESTED_GAP,
  MODE_COST_SECONDS,
  REVIEW_WEIGHTS,
  SESSION_PHASES,
  type ReviewFactorKey,
} from '../../src/hifz/params';
import {
  ayahText,
  dayIso,
  makeAttempt,
  makeItem,
  makeMeaning,
  makeSegment,
  producedFrom,
} from './fixtures';
import { tokenizeWords } from '../../src/normalize/arabic';

const ayah = (verseKey: VerseKey, itemId = `i-${verseKey}`): ProbeAyah => ({
  itemId,
  verseKey,
  text: ayahText(verseKey),
});
const words = (verseKey: VerseKey): string[] => tokenizeWords(ayahText(verseKey));
const modesOf = (steps: SessionStep[]): string[] => steps.map((s) => s.mode);
const MEANING_MODES: readonly RecallMode[] = ['meaning-to-arabic', 'concept-cue'];

/** The nine documented factors that are summed into a priority (the meaning uplift is not). */
const SUMMED_KEYS = (Object.keys(REVIEW_WEIGHTS) as ReviewFactorKey[]).filter((key) => key !== 'meaning-gap');

/* ------------------------------------------------------------------ *
 * 1 + 2. The meaning probes: cue is the pack's text, answer is the Arabic
 * ------------------------------------------------------------------ */

describe('meaning-to-arabic probe', () => {
  const meaning = makeMeaning('Say: He is Allah, the One');

  it('cues with the licensed text verbatim and expects exactly the ayah Arabic', () => {
    const probe = meaningToArabicProbe({ ayah: ayah('112:1'), meaning });
    // the cue is the pack's string, character for character — not a paraphrase
    expect(probe.cue.text).toBe(meaning.text);
    expect(probe.cue.text).toContain('fixture:');
    expect(probe.cue.kind).toBe('meaning-text');
    // ...and it carries the attribution the UI has to show
    expect(probe.cue.lang).toBe('fa');
    expect(probe.cue.packId).toBe('tr-fa-kaldari');
    // the answer is revelation: the whole ayah's words, in order, unchanged
    expect(probe.expected.map((w) => w.text)).toEqual(words('112:1'));
    expect(probe.fromWord).toBe(1);
    expect(probe.toWord).toBe(words('112:1').length);
    expect(probe.mode).toBe('meaning-to-arabic');
    expect(probe.prompt).toBe('Recite the ayah that means this.');
  });

  it('restricts to one span when the meaning is a chunk meaning', () => {
    const probe = meaningToArabicProbe({ ayah: ayah('112:1'), meaning, fromWord: 2, toWord: 3 });
    expect(probe.expected.map((w) => w.text)).toEqual(words('112:1').slice(1, 3));
    expect(probe.prompt).toBe('Recite the words that mean this.');
    // a span the caller did not ask for is never quietly widened
    expect(probe.fromWord).toBe(2);
    expect(probe.toWord).toBe(3);
  });

  it('is refused outright when no licensed meaning was supplied', () => {
    // null / undefined meaning has no representation at this layer: the probe
    // simply is not constructible, and the dispatcher says why.
    expect(() => buildProbe('meaning-to-arabic', { ayah: ayah('112:1') })).toThrow(/licensed meaning/);
    expect(() => buildProbe('meaning-to-arabic', { ayah: ayah('112:1'), meaning: null })).toThrow(/licensed meaning/);
    const bare = segmentAyah({ itemId: 'i-112-1', verseKey: '112:1', text: ayahText('112:1') });
    expect(bare.segments[0]!.meaning).toBeNull();
    expect(() => buildProbe('meaning-to-arabic', { ayah: ayah('112:1'), segment: bare.segments[0]! })).toThrow(/licensed meaning/);
  });

  it('falls back to the segment meaning and its own word span', () => {
    const bare = segmentAyah({ itemId: 'i-112-1', verseKey: '112:1', text: ayahText('112:1') });
    const segment = bare.segments[0]!;
    const glossed = { ...segment, meaning: makeMeaning('He gave you abundance', { packId: 'word-data', lang: 'en', wordGloss: true }) };
    const probe = buildProbe('meaning-to-arabic', { ayah: ayah('112:1'), segment: glossed });
    expect(probe.cue.text).toBe(glossed.meaning!.text);
    expect(probe.cue.packId).toBe('word-data');
    // only the chunk's own words, because only they are what the cue means
    expect(probe.fromWord).toBe(segment.fromWord);
    expect(probe.toWord).toBe(segment.toWord);
    expect(probe.expected.map((w) => w.text)).toEqual(words('112:1').slice(segment.fromWord - 1, segment.toWord));
  });

  it('prefers an explicitly supplied ayah meaning over a segment gloss', () => {
    const bare = segmentAyah({ itemId: 'i-112-1', verseKey: '112:1', text: ayahText('112:1') });
    const segment = { ...bare.segments[0]!, meaning: makeMeaning('a chunk gloss') };
    const explicit = makeMeaning('the whole ayah, from the pack');
    const probe = buildProbe('meaning-to-arabic', { ayah: ayah('112:1'), segment, meaning: explicit });
    expect(probe.cue.text).toBe(explicit.text);
    expect(probe.toWord).toBe(words('112:1').length);
  });
});

describe('concept-cue probe', () => {
  const previousMeaning = makeMeaning('Allah, the Eternal, the Absolute');

  it('cues with the previous ayah meaning and expects this ayah opening', () => {
    const probe = conceptCueProbe({ previousMeaning, target: ayah('112:1'), previousVerseKey: '112:2' });
    expect(probe.cue.kind).toBe('previous-ayah-meaning');
    expect(probe.cue.text).toBe(previousMeaning.text);
    expect(probe.cue.lang).toBe('fa');
    expect(probe.cue.packId).toBe('tr-fa-kaldari');
    expect(probe.cueVerseKey).toBe('112:2');
    expect(probe.nextVerseKey).toBe('112:1');
    // the chain link only: the opening words, not the whole ayah
    expect(probe.expected.map((w) => w.text)).toEqual(words('112:1').slice(0, CONCEPT_CUE_EXPECTED_WORDS));
    expect(probe.fromWord).toBe(1);
    expect(probe.prompt).toBe('Recite how the ayah that follows this meaning begins.');
  });

  it('is refused without the previous ayah meaning', () => {
    expect(() => buildProbe('concept-cue', { ayah: ayah('112:1') })).toThrow(/previous ayah meaning/);
    expect(() => buildProbe('concept-cue', { ayah: ayah('112:1'), previousMeaning: null })).toThrow(/previous ayah meaning/);
  });

  it('clamps the expected span to a short ayah instead of inventing words', () => {
    const probe = buildProbe('concept-cue', {
      ayah: ayah('112:2'),
      previousMeaning: makeMeaning('Say: He is Allah, the One'),
      conceptCueWords: 99,
    });
    expect(probe.expected.map((w) => w.text)).toEqual(words('112:2'));
  });
});

describe('the two axes never confuse a grader', () => {
  it('a meaning probe grades exactly like the form probe of the same span', () => {
    const ctx: ProbeContext = { ayah: ayah('112:1'), meaning: makeMeaning('He gave you abundance') };
    const meaningProbe = buildProbe('meaning-to-arabic', ctx);
    const formProbe = buildProbe('full-ayah', ctx);
    expect(meaningProbe.expected).toEqual(formProbe.expected);

    const produced = producedFrom('112:1', { drop: [2] }).map((w) => w.text);
    const grade = (mode: RecallMode): ClassificationResult =>
      classifyRecitation({
        expected: words('112:1'),
        produced,
        itemId: 'i-112-1',
        verseKey: '112:1',
        mode,
      });
    const asForm = grade('full-ayah');
    const asMeaning = grade('meaning-to-arabic');
    // one aligner, one set of span rules: only the cue differed
    expect(asMeaning.errors.filter((e) => e.kind !== 'beginning-failure')).toEqual(
      asForm.errors.filter((e) => e.kind !== 'beginning-failure'),
    );
    expect(asMeaning.accuracy).toBe(asForm.accuracy);
  });

  it('RECALL_DIMENSION puts both meaning modes on the meaning axis and nothing else', () => {
    for (const mode of RECALL_MODES) {
      expect(RECALL_DIMENSION[mode]).toBe(MEANING_MODES.includes(mode) ? 'meaning' : 'form');
    }
    expect(PROBE_MODES.length).toBe(RECALL_MODES.length);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Stability: two numbers, and the composite is the weaker one
 * ------------------------------------------------------------------ */

describe('axis splitting', () => {
  const formAttempt: StabilityAttempt = { at: dayIso(1), accuracy: 1, mode: 'full-ayah' };
  const meaningAttempt: StabilityAttempt = { at: dayIso(1), accuracy: 0.2, mode: 'meaning-to-arabic' };

  it('routes an attempt by its mode, not by what the caller claims', () => {
    expect(attemptDimension({ mode: 'concept-cue', dimension: 'form' })).toBe('meaning');
    expect(attemptDimension({ mode: 'segment', dimension: 'meaning' })).toBe('form');
    // a legacy row with no mode at all is form work — nothing existed before that
    expect(attemptDimension({ dimension: 'meaning' })).toBe('meaning');
    expect(attemptDimension({})).toBe('form');
    const split = partitionAttemptsByDimension([formAttempt, meaningAttempt]);
    expect(split.form).toEqual([formAttempt]);
    expect(split.meaning).toEqual([meaningAttempt]);
  });

  it('a graded meaning attempt moves meaningStability and leaves formStability alone', () => {
    const current = { formStability: 0.8, meaningStability: 0.2 };
    const next = applyAttemptToAxes(current, { accuracy: 1, mode: 'meaning-to-arabic' });
    expect(next.formStability).toBe(0.8);
    expect(next.meaningStability).toBeCloseTo(0.2 + AXIS_LEARN_RATE * (1 - 0.2), 6);
    expect(next.dimension).toBe('meaning');
    // the composite reads the axis that is behind, so meaning lifting helps it
    expect(next.stability).toBeCloseTo(next.meaningStability!, 6);
    expect(next.limitingAxis).toBe('meaning');
  });

  it('a graded form attempt moves formStability and never touches meaning', () => {
    const untested = { formStability: 0.4, meaningStability: null };
    const next = applyAttemptToAxes(untested, { accuracy: 1, mode: 'full-ayah' });
    expect(next.meaningStability).toBeNull();
    expect(next.formStability).toBeCloseTo(0.4 + AXIS_LEARN_RATE * (1 - 0.4), 6);
    expect(next.stability).toBe(next.formStability);
    expect(next.limitingAxis).toBe('form');
  });

  it('a perfect recitation cannot fake understanding, and vice versa', () => {
    const recited = applyAttemptToAxes({ formStability: 0, meaningStability: 0.9 }, { accuracy: 1, mode: 'full-ayah' });
    expect(recited.meaningStability).toBe(0.9);
    // the composite is the weaker axis: a flawless form attempt on a blank meaning
    // axis must not produce a healthy-looking item.
    const meaningOnly = applyAttemptToAxes({ formStability: 0, meaningStability: 0 }, { accuracy: 1, mode: 'concept-cue' });
    expect(meaningOnly.formStability).toBe(0);
    expect(meaningOnly.stability).toBe(0);
    expect(meaningOnly.limitingAxis).toBe('form');
  });

  it('the first meaning attempt on an untested axis measures from untested, not 0.5', () => {
    const before = applyAttemptToAxes({ formStability: 1, meaningStability: null }, { accuracy: 0, mode: 'concept-cue' });
    expect(before.meaningStability).toBe(0);
    // …and the moment the axis has a number at all, the composite reads it, even
    // if that means a flawless recitation scores 0 overall.
    const next = applyAttemptToAxes({ formStability: 1, meaningStability: null }, { accuracy: 1, mode: 'meaning-to-arabic' });
    expect(next.meaningStability).toBeCloseTo(AXIS_LEARN_RATE, 6);
    expect(next.stability).toBe(next.meaningStability);
    expect(next.limitingAxis).toBe('meaning');
  });

  it('composite is the weaker axis, with an untested axis left out entirely', () => {
    expect(compositeStability(0.9, 0.3)).toBe(0.3);
    expect(compositeStability(0.3, 0.9)).toBe(0.3);
    expect(compositeStability(0.9, null)).toBe(0.9);
    expect(compositeStability(0.9, 0.9)).toBe(0.9);
    expect(limitingAxisOf(0.9, 0.3)).toBe('meaning');
    expect(limitingAxisOf(0.3, 0.9)).toBe('form');
    expect(limitingAxisOf(0.9, null)).toBe('form');
    // ties read as form: the stricter of the two claims
    expect(limitingAxisOf(0.5, 0.5)).toBe('form');
  });

  it('segments keep their two axes apart too', () => {
    const segment = makeSegment({ itemId: 'i', verseKey: '112:1', position: 0, stability: 0.5, meaningStability: null });
    const onMeaning = applyAttemptToSegment(segment, { accuracy: 1, mode: 'meaning-to-arabic' });
    expect(onMeaning.stability).toBe(0.5);
    expect(onMeaning.meaningStability).toBeCloseTo(AXIS_LEARN_RATE, 6);
    const onForm = applyAttemptToSegment(segment, { accuracy: 1, mode: 'segment' });
    expect(onForm.meaningStability).toBeNull();
    expect(onForm.stability).toBeCloseTo(0.5 + AXIS_LEARN_RATE * (1 - 0.5), 6);
  });

  it('computeStabilityByAxis scores each axis from its own attempts only', () => {
    const input = {
      nowIso: dayIso(2),
      addedAt: dayIso(0),
      attempts: [
        { at: dayIso(1), accuracy: 1, mode: 'full-ayah' as RecallMode, expectedWordCount: 4, correctWordCount: 4 },
        { at: dayIso(1), accuracy: 0.25, mode: 'meaning-to-arabic' as RecallMode, expectedWordCount: 4, correctWordCount: 1 },
      ],
    };
    const axes = computeStabilityByAxis(input);
    expect(axes.form.attemptCount).toBe(1);
    expect(axes.meaning.attemptCount).toBe(1);
    expect(axes.formStability).toBeGreaterThan(axes.meaningStability!);
    expect(axes.stability).toBe(axes.meaningStability);
    expect(axes.limitingAxis).toBe('meaning');
    expect(axes.gap).toBeCloseTo(axes.formStability - axes.meaningStability!, 4);
    // scheduling follows the weak axis, not the confident one
    expect(axes.nextReviewAt).toBe(axes.meaning.nextReviewAt);
    expect(axes.intervalDays).toBe(axes.meaning.intervalDays);

    const noMeaning = computeStabilityByAxis({ ...input, attempts: [input.attempts[0]!] });
    expect(noMeaning.meaningStability).toBeNull();
    expect(noMeaning.stability).toBe(noMeaning.formStability);
    expect(noMeaning.limitingAxis).toBe('form');
    expect(noMeaning.gap).toBe(0);
  });

  it('understanding alone does not make an ayah memorised', () => {
    const axes = computeStabilityByAxis({
      nowIso: dayIso(2),
      addedAt: dayIso(0),
      attempts: [{ at: dayIso(1), accuracy: 1, mode: 'concept-cue' as RecallMode, expectedWordCount: 4, correctWordCount: 4 }],
    });
    expect(axes.meaningStability).toBeGreaterThan(0);
    expect(axes.formStability).toBe(0);
    expect(axes.stability).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 4. Scheduler: the meaning gap is a factor, and it flips the mode
 * ------------------------------------------------------------------ */

describe('meaningLagOf', () => {
  const item = makeItem({ id: 'i', verseKey: '112:1', stability: 0.8, formStability: 0.8, meaningStability: 0.5 });

  it('is zero when no licensed meaning covers the item', () => {
    expect(meaningLagOf(item, false)).toBe(0);
    expect(meaningLagOf({ ...item, meaningStability: null }, false)).toBe(0);
  });

  it('is the full gap when the axis was never tested', () => {
    expect(meaningLagOf({ ...item, meaningStability: null }, true)).toBe(MEANING_UNTESTED_GAP);
  });

  it('is the form-minus-meaning lag once tested, and never negative', () => {
    expect(meaningLagOf(item, true)).toBeCloseTo(0.3, 6);
    expect(meaningLagOf({ ...item, meaningStability: 0.95 }, true)).toBe(0);
  });
});

describe('meaning-gap factor', () => {
  const practiced = (): RecallAttempt[] => [
    makeAttempt({ id: 'p', itemId: 'm', verseKey: '112:1', startedAt: dayIso(28), completedAt: dayIso(28, 1), expectedWordCount: 4, correctWordCount: 4 }),
  ];

  function historyForItem(item: HifzItem, meanings?: MeaningCoverage, previous?: Record<string, string | null>): ItemHistory {
    const input: ReviewContextInput = {
      nowIso: dayIso(30),
      items: [item],
      attempts: practiced(),
      meanings: meanings ?? null,
      previousVerseKey: previous ?? null,
    };
    const history = historyFor(input).get(item.id);
    if (!history) throw new Error(`no history for ${item.id}`);
    return history;
  }

  const item = (meaningStability: number | null): HifzItem =>
    makeItem({
      id: 'm',
      verseKey: '112:1',
      band: 'weak',
      stability: 0.8,
      formStability: 0.8,
      meaningStability,
      lastReviewedAt: dayIso(28),
      nextReviewAt: dayIso(29),
      attemptCount: 3,
    });

  it('flags coverage, and only coverage with actual text', () => {
    const covered = historyForItem(item(0.1), { '112:1': makeMeaning('the One') });
    expect(covered.meaningAvailable).toBe(true);
    expect(covered.previousMeaningAvailable).toBe(false);
    // a row whose text is blank is not a meaning: there is nothing to cue with
    const blank = historyForItem(item(0.1), { '112:1': { ...makeMeaning('x'), text: '   ' } });
    expect(blank.meaningAvailable).toBe(false);
    const none = historyForItem(item(0.1));
    expect(none.meaningAvailable).toBe(false);
    const chained = historyForItem(item(0.1), { '112:1': makeMeaning('the One'), '112:2': makeMeaning('the Eternal') }, { '112:1': '112:2' });
    expect(chained.previousMeaningAvailable).toBe(true);
    // a previous key that is itself uncovered does not make a chain
    const broken = historyForItem(item(0.1), { '112:1': makeMeaning('the One') }, { '112:1': '112:2' });
    expect(broken.previousMeaningAvailable).toBe(false);
  });

  it('scales with the lag and saturates instead of running away', () => {
    const half = rawFactors(historyForItem(item(0.5), { '112:1': makeMeaning('x') }), dayIso(30));
    expect(half['meaning-gap']).toBeCloseTo(0.3 / MEANING_GAP_SATURATION, 4);
    // 0.75 of lag against a 0.6 saturation clamps to 1 rather than overshooting
    const saturated = rawFactors(historyForItem(item(0.05), { '112:1': makeMeaning('x') }), dayIso(30));
    expect(saturated['meaning-gap']).toBe(1);
    const untested = rawFactors(historyForItem(item(null), { '112:1': makeMeaning('x') }), dayIso(30));
    expect(untested['meaning-gap']).toBe(1);
    // an axis nothing can cue contributes nothing
    const uncued = rawFactors(historyForItem(item(null)), dayIso(30));
    expect(uncued['meaning-gap']).toBe(0);
  });

  it('raises priority, and is explainable in the reason', () => {
    const lagging = scoreItem(historyForItem(item(0.1), { '112:1': makeMeaning('x') }), dayIso(30));
    const caught = scoreItem(historyForItem(item(0.8), { '112:1': makeMeaning('x') }), dayIso(30));
    const uncued = scoreItem(historyForItem(item(0.1)), dayIso(30));
    expect(lagging.entry.priority).toBeGreaterThan(caught.entry.priority);
    // the gap is a bounded uplift on the headroom the nine documented factors
    // leave, so a caught-up item's priority is exactly what it was before the
    // meaning axis existed
    expect(caught.weighted['meaning-gap']).toBe(0);
    expect(caught.entry.priority).toBeCloseTo(
      SUMMED_KEYS.reduce((acc, key) => acc + caught.raw[key] * REVIEW_WEIGHTS[key], 0),
      3,
    );
    expect(lagging.entry.priority - caught.entry.priority).toBeCloseTo(
      lagging.raw['meaning-gap'] * REVIEW_WEIGHTS['meaning-gap'] * (1 - caught.entry.priority),
      3,
    );
    // a missing meaning pack is stated, never hidden behind a zero
    expect(uncued.weighted['meaning-gap']).toBe(0);
    expect(uncued.entry.factors['meaning-gap-raw']).toBe(0);
    expect(lagging.entry.reason).toContain('meaning 0.1 vs form 0.8');
    // an uncued item gets no fake meaning urgency, and makes no meaning claim in
    // its reason; the absence is still stated, in the factor summary the UI reads
    expect(uncued.entry.reason).not.toMatch(/meaning/);
    expect(factorSummaries(historyForItem(item(0.1)), dayIso(30))['meaning-gap']).toContain(
      'no licensed meaning available',
    );
  });

  it('drags a whole queue behind: the lagging ayah is scheduled first', () => {
    const input: ReviewContextInput = {
      nowIso: dayIso(30),
      items: [
        { ...item(0.1), id: 'lag', verseKey: '112:1' },
        { ...item(0.8), id: 'ok', verseKey: '112:2' },
      ],
      attempts: [
        makeAttempt({ id: 'x1', itemId: 'lag', verseKey: '112:1', startedAt: dayIso(28), completedAt: dayIso(28, 1), expectedWordCount: 4, correctWordCount: 4 }),
        makeAttempt({ id: 'x2', itemId: 'ok', verseKey: '112:2', startedAt: dayIso(28), completedAt: dayIso(28, 1), expectedWordCount: 4, correctWordCount: 4 }),
      ],
      meanings: { '112:1': makeMeaning('the One'), '112:2': makeMeaning('the Eternal') },
    };
    const entries = planReviews(input);
    expect(entries[0]!.verseKey).toBe('112:1');
    expect(entries[0]!.suggestedMode).toBe('meaning-to-arabic');
    expect(RECALL_DIMENSION[entries[0]!.suggestedMode]).toBe('meaning');
  });
});

describe('suggestMode flips to the axis that lags', () => {
  const meaningOf = makeMeaning('the One');

  const modeFor = (item: HifzItem, meanings?: MeaningCoverage, previous?: Record<string, string | null>): RecallMode => {
    const input: ReviewContextInput = {
      nowIso: dayIso(30),
      items: [item],
      attempts: [
        makeAttempt({ id: 'p', itemId: item.id, verseKey: item.verseKey, startedAt: dayIso(28), completedAt: dayIso(28, 1), expectedWordCount: 4, correctWordCount: 4 }),
      ],
      meanings: meanings ?? null,
      previousVerseKey: previous ?? null,
    };
    const history = historyFor(input).get(item.id)!;
    return suggestMode(history, rawFactors(history, input.nowIso));
  };

  const item = (meaningStability: number | null): HifzItem =>
    makeItem({
      id: 'm',
      verseKey: '112:1',
      band: 'weak',
      stability: 0.8,
      formStability: 0.8,
      meaningStability,
      lastReviewedAt: dayIso(28),
      nextReviewAt: dayIso(29),
      attemptCount: 3,
    });

  it('tests an untested meaning axis directly, never as a chain', () => {
    expect(modeFor(item(null), { '112:1': meaningOf })).toBe('meaning-to-arabic');
    expect(modeFor(item(null), { '112:1': meaningOf, '112:2': makeMeaning('x') }, { '112:1': '112:2' })).toBe('meaning-to-arabic');
  });

  it('offers the chain only when the lag is small and the previous meaning exists', () => {
    const smallLag = item(0.8 - MEANING_CONCEPT_CUE_MAX_GAP);
    expect(modeFor(smallLag, { '112:1': meaningOf, '112:2': makeMeaning('the Eternal') }, { '112:1': '112:2' })).toBe('concept-cue');
    // no previous meaning → the direct binding, because a chain needs both links
    expect(modeFor(smallLag, { '112:1': meaningOf }, { '112:1': '112:2' })).toBe('meaning-to-arabic');
    expect(modeFor(smallLag, { '112:1': meaningOf })).toBe('meaning-to-arabic');
    // a big hole needs the whole ayah bound to its sense first
    expect(modeFor(item(0.05), { '112:1': meaningOf, '112:2': makeMeaning('the Eternal') }, { '112:1': '112:2' })).toBe('meaning-to-arabic');
  });

  it('stays on the form axis when meaning is caught up or untestable', () => {
    const caught = modeFor(item(0.8), { '112:1': meaningOf });
    expect(MEANING_MODES).not.toContain(caught);
    const uncued = modeFor(item(null));
    expect(MEANING_MODES).not.toContain(uncued);
  });

  it('never lets the meaning rule outrank brand-new material', () => {
    const fresh = makeItem({ id: 'm', verseKey: '112:1', band: 'new', stability: 0, formStability: 0, meaningStability: null });
    expect(modeFor(fresh, { '112:1': meaningOf })).toBe('segment');
  });

  it('prices a meaning step like the form step of the same span', () => {
    expect(MODE_COST_SECONDS['meaning-to-arabic']).toBe(MODE_COST_SECONDS['full-ayah']);
    expect(MODE_COST_SECONDS['concept-cue']).toBeLessThan(MODE_COST_SECONDS['meaning-to-arabic']);
  });
});

/* ------------------------------------------------------------------ *
 * 5 + 6. Sessions: meaning layers appear, and vanish with no meaning data
 * ------------------------------------------------------------------ */

describe('session meaning phases', () => {
  function planInput(): ReviewContextInput {
    return {
      nowIso: dayIso(30),
      items: [
        makeItem({
          id: 'i-255',
          verseKey: '2:255',
          band: 'weak',
          stability: 0.6,
          formStability: 0.9,
          meaningStability: 0.1,
          addedAt: dayIso(0),
          lastReviewedAt: dayIso(20),
          nextReviewAt: dayIso(23),
          attemptCount: 5,
        }),
        makeItem({ id: 'i-112a', verseKey: '112:1', band: 'weak', stability: 0.6, formStability: 0.7, meaningStability: 0.65, addedAt: dayIso(0), lastReviewedAt: dayIso(26), nextReviewAt: dayIso(28), attemptCount: 4 }),
        makeItem({ id: 'i-112b', verseKey: '112:2', band: 'weak', stability: 0.6, formStability: 0.8, meaningStability: null, addedAt: dayIso(0), lastReviewedAt: dayIso(26), nextReviewAt: dayIso(28), attemptCount: 4 }),
      ],
      attempts: [
        makeAttempt({ id: 'h1', itemId: 'i-255', verseKey: '2:255', startedAt: dayIso(20), completedAt: dayIso(20, 1), expectedWordCount: 50, correctWordCount: 45 }),
        makeAttempt({ id: 'h2', itemId: 'i-112a', verseKey: '112:1', startedAt: dayIso(26), completedAt: dayIso(26, 1), expectedWordCount: 4, correctWordCount: 4 }),
        makeAttempt({ id: 'h3', itemId: 'i-112b', verseKey: '112:2', startedAt: dayIso(26), completedAt: dayIso(26, 1), expectedWordCount: 4, correctWordCount: 4 }),
      ],
    };
  }

  const coverage = (): MeaningCoverage => ({
    '2:255': makeMeaning('Allah — there is no deity except Him'),
    '112:1': makeMeaning('Say: He is Allah, the One'),
    '112:2': makeMeaning('Allah, the Eternal, the Absolute'),
  });

  function steps(overrides: Partial<BuildSessionInput> = {}, withMeanings = true): SessionStep[] {
    const input = planInput();
    const plan = buildDailyPlan({
      ...input,
      newAyahs: ['108:1'],
      newAyahWordCounts: { '108:1': 3 },
      meanings: withMeanings ? coverage() : null,
      previousVerseKey: { '112:1': '112:2', '2:255': '2:254' },
    });
    const meanings: SessionMeaningSource[] | null = withMeanings
      ? [
          { verseKey: '2:255', meaning: coverage()['2:255']!, previousMeaning: coverage()['2:255'] },
          { verseKey: '112:1', meaning: coverage()['112:1']!, previousMeaning: coverage()['112:2'] },
          { verseKey: '112:2', meaning: coverage()['112:2']! },
          { verseKey: '108:1', meaning: makeMeaning('Abundance'), previousMeaning: null },
        ]
      : [];
    return buildSessionSteps({
      plan,
      items: input.items,
      attempts: input.attempts,
      nowIso: input.nowIso,
      meanings,
      ...overrides,
    });
  }

  it('emits no meaning step at all when there is no meaning data', () => {
    const noData = steps({}, false);
    const emptyList = steps({ meanings: [] }, false);
    const omitted = buildSessionSteps({
      plan: buildDailyPlan({ ...planInput(), newAyahs: ['108:1'] }),
      items: planInput().items,
      attempts: planInput().attempts,
      nowIso: dayIso(30),
    });
    const stalePlan = steps({ meanings: [] });
    for (const mode of MEANING_MODES) {
      expect(modesOf(noData)).not.toContain(mode);
      expect(modesOf(emptyList)).not.toContain(mode);
      expect(modesOf(omitted)).not.toContain(mode);
      // a plan scheduled as if meanings existed, then a session with none: the
      // stale suggestion must not smuggle a meaning step into the queue either
      expect(modesOf(stalePlan)).not.toContain(mode);
    }
    // the spellings of "no meaning here" are the same session, byte for byte
    const json = JSON.stringify(noData);
    expect(JSON.stringify(emptyList)).toBe(json);
    expect(JSON.stringify(omitted)).toBe(json);
  });

  it('introduces a new ayah by its sense before it is chunked', () => {
    const withMeaning = steps();
    const meetIndex = withMeaning.findIndex((s) => s.verseKey === '108:1' && MEANING_MODES.includes(s.mode));
    const chunkIndex = withMeaning.findIndex((s) => s.verseKey === '108:1' && s.mode === 'segment');
    expect(meetIndex).toBeGreaterThan(-1);
    expect(chunkIndex).toBeGreaterThan(meetIndex);
    // and the sense step is only offered for ayahs a pack actually covers
    expect(withMeaning.some((s) => MEANING_MODES.includes(s.mode))).toBe(true);
  });

  it('drills the lagging meaning axis after progressive recall', () => {
    const withMeaning = steps();
    const firstFormRecall = withMeaning.findIndex((s) => s.mode === 'continue-ayah');
    const drills = withMeaning.filter((s) => MEANING_MODES.includes(s.mode) && s.verseKey !== '108:1');
    expect(drills.length).toBeGreaterThan(0);
    expect(drills.length).toBeLessThanOrEqual(MEANING_DRILL_ITEM_CAP);
    for (const drill of drills) {
      expect(withMeaning.indexOf(drill)).toBeGreaterThan(firstFormRecall);
    }
    // the item whose meaning axis is blankest is drilled, the caught-up one is not
    const drilledKeys = drills.map((d) => d.verseKey);
    expect(drilledKeys).toContain('112:2');
    expect(drilledKeys).toContain('2:255');
    expect(drilledKeys).not.toContain('112:1');
  });

  it('never repeats a step and never emits a dead one', () => {
    const withMeaning = steps();
    const keys = withMeaning.map((s) => `${s.mode}:${s.verseKey}`);
    expect(new Set(keys).size).toBe(keys.length);
    // an ayah with no licensed meaning gets no meaning step
    const uncovered = steps({
      meanings: [{ verseKey: '2:255', meaning: null }],
    });
    expect(uncovered.filter((s) => s.verseKey === '2:255' && MEANING_MODES.includes(s.mode))).toEqual([]);
    expect(uncovered.filter((s) => s.verseKey === '108:1' && MEANING_MODES.includes(s.mode))).toEqual([]);
  });

  it('is byte-identical for the same plan and meanings', () => {
    expect(JSON.stringify(steps())).toBe(JSON.stringify(steps()));
  });

  it('picks the meaning mode from the lag, exactly like the scheduler', () => {
    const row: SessionMeaningSource = { verseKey: '112:1', meaning: makeMeaning('x'), previousMeaning: makeMeaning('y') };
    expect(meaningModeFor(row, 0)).toBe('concept-cue');
    expect(meaningModeFor(row, MEANING_CONCEPT_CUE_MAX_GAP)).toBe('concept-cue');
    expect(meaningModeFor(row, MEANING_CONCEPT_CUE_MAX_GAP + 0.01)).toBe('meaning-to-arabic');
    expect(meaningModeFor({ verseKey: '112:1', meaning: makeMeaning('x') }, 0)).toBe('meaning-to-arabic');
    expect(meaningModeFor({ verseKey: '112:1', meaning: null }, 0)).toBeNull();
    expect(meaningModeFor(undefined, 0)).toBeNull();
    expect(meaningModeFor({ verseKey: '112:1', meaning: { ...makeMeaning('x'), text: '   ' } }, 0)).toBeNull();
  });

  it('lists the meaning phases in the documented session order', () => {
    expect(SESSION_PHASES).toContain('meaning-introduction');
    expect(SESSION_PHASES).toContain('meaning-drill');
    expect(SESSION_PHASES.indexOf('meaning-introduction')).toBeLessThan(SESSION_PHASES.indexOf('new-learning'));
    expect(SESSION_PHASES.indexOf('meaning-drill')).toBeGreaterThan(SESSION_PHASES.indexOf('progressive-recall'));
  });
});

describe('session report separates the two axes', () => {
  const formWin = makeAttempt({
    id: 'f1',
    itemId: 'i-112a',
    verseKey: '112:1',
    sessionId: 's1',
    mode: 'full-ayah',
    startedAt: dayIso(30, 8),
    completedAt: dayIso(30, 8),
    expectedWordCount: 4,
    correctWordCount: 4,
    dimension: 'form',
  });
  const meaningFail = makeAttempt({
    id: 'm1',
    itemId: 'i-112a',
    verseKey: '112:1',
    sessionId: 's1',
    mode: 'meaning-to-arabic',
    startedAt: dayIso(30, 9),
    completedAt: dayIso(30, 9),
    expectedWordCount: 4,
    correctWordCount: 1,
    dimension: 'meaning',
  });
  const items = [
    makeItem({
      id: 'i-112a',
      verseKey: '112:1',
      band: 'weak',
      stability: 0.9,
      formStability: 0.9,
      meaningStability: 0.9,
      addedAt: dayIso(0),
      lastReviewedAt: dayIso(20),
      nextReviewAt: dayIso(23),
      attemptCount: 6,
    }),
  ];

  it('reports the two recalls apart so a blend cannot hide which axis failed', () => {
    const report = computeSessionReport({ nowIso: dayIso(30), attempts: [formWin, meaningFail], items });
    expect(report.formRecall).toBe(1);
    expect(report.meaningRecall).toBeCloseTo(0.25, 4);
    expect(report.overallRecall).toBeLessThan(report.formRecall);
    expect(report.recallByAxis.map((a) => a.dimension)).toEqual(['form', 'meaning']);
    expect(report.recallByAxis.map((a) => a.attempts)).toEqual([1, 1]);
    expect(report.meaningTested).toBe(true);
    // and the composite drops to the failed axis
    const change = report.stabilityChanges[0]!;
    expect(change.limitingAxis).toBe('meaning');
    expect(change.after).toBeLessThanOrEqual(change.meaningAfter!);
    expect(change.meaningBefore).toBe(0.9);
  });

  it('keeps an untested meaning axis untested, at zero and never invented', () => {
    const report = computeSessionReport({ nowIso: dayIso(30), attempts: [formWin], items });
    expect(report.meaningRecall).toBe(0);
    expect(report.meaningTested).toBe(false);
    expect(report.recallByAxis[1]!.expectedWords).toBe(0);
    const change = report.stabilityChanges[0]!;
    expect(change.meaningBefore).toBe(0.9);
    expect(change.meaningAfter).toBe(0.9);
    expect(change.limitingAxis).toBe('form');
    expect(change.meaningAvailable).toBe(false);
  });

  it('marks an item meaning-available only when a licensed meaning was supplied', () => {
    const report = computeSessionReport({
      nowIso: dayIso(30),
      attempts: [formWin],
      items,
      meanings: [{ verseKey: '112:1', meaning: makeMeaning('the One') }],
    });
    expect(report.stabilityChanges[0]!.meaningAvailable).toBe(true);
    const none = computeSessionReport({ nowIso: dayIso(30), attempts: [formWin], items, meanings: [{ verseKey: '112:1', meaning: null }] });
    expect(none.stabilityChanges[0]!.meaningAvailable).toBe(false);
  });

  it('a meaning attempt in a session cannot lift the form number', () => {
    const before = items[0]!;
    const after = stabilityAfterSession({ nowIso: dayIso(30), attempts: [meaningFail], items: [before] });
    expect(after).toHaveLength(1);
    expect(after[0]!.formStability).toBeLessThanOrEqual(before.formStability);
    expect(after[0]!.meaningStability).toBeLessThan(before.meaningStability!);
    expect(after[0]!.limitingAxis).toBe('meaning');
  });

  it('is byte-identical for the same attempts', () => {
    const a = computeSessionReport({ nowIso: dayIso(30), attempts: [formWin, meaningFail], items });
    const b = computeSessionReport({ nowIso: dayIso(30), attempts: [formWin, meaningFail], items });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
