/**
 * Session assembly and reporting.
 *
 * The step list is built from a plan, the report is computed from the attempts
 * that actually happened, and both are checked against real recitations of the
 * fixture ayahs.
 */

import { describe, expect, it } from 'vitest';
import {
  advanceStability,
  attemptsByItem,
  buildSessionSteps,
  computeSessionReport,
  createSession,
  finishSession,
  sessionCostSeconds,
  sessionIsClean,
  stabilityAfterSession,
  withAttempt,
  type BuildSessionInput,
} from '../../src/hifz/session';
import { buildDailyPlan, type ReviewContextInput } from '../../src/hifz/review';
import { segmentAyah } from '../../src/hifz/segment';
import { classifyRecitation, classifyRecitationFromText, type ClassificationResult } from '../../src/hifz/classify';
import {
  ASSESSMENT_STEP_SECONDS,
  LEARN_RATE,
  MODE_COST_SECONDS,
  PHASE_STEP_CAP,
  PROBE_DRILL_ITEM_CAP,
  REPEATED_ERROR_MIN_COUNT,
  STEP_OVERHEAD_SECONDS,
  WARM_UP_ITEM_COUNT,
  WEAK_SEGMENT_STABILITY,
  WEAK_TRANSITION_STABILITY,
} from '../../src/hifz/params';
import {
  ayahText,
  dayIso,
  makeAttempt,
  makeError,
  makeGroup,
  makeItem,
  makeSegment,
  makeTransition,
  producedFrom,
} from './fixtures';
import { tokenizeWords } from '../../src/normalize/arabic';
import type { HifzSegment, HifzTransition, RecallAttempt, SessionStep } from '../../src/contracts/hifz';
import type { VerseKey } from '../../src/contracts/quran';

const words = (key: VerseKey) => tokenizeWords(ayahText(key));
const spanOf = (segments: HifzSegment[]) => segments.map((s) => ({ position: s.position, fromWord: s.fromWord, toWord: s.toWord }));
const modesOf = (steps: SessionStep[]) => steps.map((s) => s.mode);

/* ------------------------------------------------------------------ *
 * The plan a session is built from
 * ------------------------------------------------------------------ */

function planInput(): ReviewContextInput {
  const a255 = segmentAyah({ itemId: 'i-255', verseKey: '2:255', text: ayahText('2:255') });
  const a112 = segmentAyah({ itemId: 'i-112a', verseKey: '112:1', text: ayahText('112:1'), nextVerseKey: '112:2' });
  return {
    nowIso: dayIso(30),
    items: [
      makeItem({
        id: 'i-255',
        verseKey: '2:255',
        band: 'weak',
        stability: 0.5,
        lastReviewedAt: dayIso(20),
        nextReviewAt: dayIso(23),
        attemptCount: 5,
        errorCount: 9,
      }),
      makeItem({ id: 'i-112a', verseKey: '112:1', band: 'new', stability: 0, addedAt: dayIso(29) }),
      makeItem({
        id: 'i-112b',
        verseKey: '112:2',
        band: 'unstable',
        stability: 0.3,
        lastReviewedAt: dayIso(26),
        nextReviewAt: dayIso(28),
        attemptCount: 3,
      }),
      makeItem({
        id: 'i-paused',
        verseKey: '112:3',
        band: 'weak',
        status: 'paused',
        stability: 0.2,
        nextReviewAt: dayIso(1),
      }),
    ],
    attempts: [
      makeAttempt({
        id: 'h1',
        itemId: 'i-255',
        verseKey: '2:255',
        startedAt: dayIso(20),
        completedAt: dayIso(20, 1),
        expectedWordCount: 50,
        correctWordCount: 30,
      }),
    ],
    segments: [
      ...a255.segments.map((s, i) => ({ ...s, stability: i % 2 ? 0.2 : 0.8 })),
      ...a112.segments.map((s) => ({ ...s, stability: 0.1 })),
    ],
    transitions: [
      ...a255.transitions.map((t, i) => ({ ...t, stability: i % 2 ? 0.15 : 0.7 })),
      ...a112.transitions.map((t) => ({ ...t, stability: 0.1 })),
      makeTransition({ itemId: 'i-paused', toWord: 2, stability: 0.05 }),
    ],
    confusionGroups: [makeGroup({ verseKeys: ['112:1', '112:2'], confusionCount: 3, lastTriggeredAt: dayIso(5) })],
  };
}

function stepsFor(overrides: Partial<BuildSessionInput> = {}): SessionStep[] {
  const input = planInput();
  const plan = buildDailyPlan({ ...input, newAyahs: ['108:1'], newAyahWordCounts: { '108:1': 3 } });
  return buildSessionSteps({
    plan,
    items: input.items,
    attempts: input.attempts,
    transitions: input.transitions,
    confusionGroups: input.confusionGroups,
    nowIso: input.nowIso,
    ...overrides,
  });
}

describe('session steps', () => {
  it('run the eight phases in the documented order', () => {
    const modes = modesOf(stepsFor());
    const phaseOf = (mode: string) => ['first-word-cue', 'segment', 'continue-ayah', 'transition', 'full-ayah', 'reverse', 'random', 'audio-recall'].indexOf(mode);
    const order = modes.map(phaseOf);
    expect(order.every((p) => p >= 0)).toBe(true);
    for (let i = 1; i < order.length; i += 1) expect(order[i]!).toBeGreaterThanOrEqual(order[i - 1]!);
    expect(modes[0]).toBe('first-word-cue');
    expect(modes).toContain('segment');
    expect(modes[modes.length - 1]).toBe('audio-recall');
  });

  it('warms up with the most recently reviewed planned items only', () => {
    const steps = stepsFor();
    const warm = steps.filter((s) => s.mode === 'first-word-cue');
    expect(warm.length).toBeLessThanOrEqual(WARM_UP_ITEM_COUNT);
    expect(warm.map((s) => s.verseKey)).toEqual(['2:255']);
    expect(warm[0]!.itemId).toBe('i-255');
  });

  it('teaches each new ayah of the day before recalling anything', () => {
    const steps = stepsFor();
    const segmentIndex = steps.findIndex((s) => s.mode === 'segment' && s.verseKey === '108:1');
    const firstRecall = steps.findIndex((s) => s.mode === 'continue-ayah');
    expect(segmentIndex).toBeGreaterThan(-1);
    expect(firstRecall).toBeGreaterThan(segmentIndex);
    // an ayah that is brand new today is not also probed as old material
    expect(steps.some((s) => s.mode === 'continue-ayah' && s.verseKey === '108:1')).toBe(false);
    expect(steps[segmentIndex]!.itemId).toBeNull();
  });

  it('drills the weakest boundaries and the confusion pair back to back', () => {
    const steps = stepsFor();
    const transitions = steps.filter((s) => s.mode === 'transition').map((s) => s.verseKey);
    expect(transitions.length).toBeLessThanOrEqual(PHASE_STEP_CAP);
    expect(transitions).toEqual(['112:1', '2:255']);
    // a paused ayah is never drilled
    expect(transitions).not.toContain('112:3');
    const drill = steps.filter((s) => s.mode === 'full-ayah').map((s) => s.verseKey);
    expect(drill).toEqual(['112:1', '112:2']);
  });

  it('caps the reverse and random drills', () => {
    const steps = stepsFor();
    expect(steps.filter((s) => s.mode === 'reverse')).toHaveLength(PROBE_DRILL_ITEM_CAP);
    expect(steps.filter((s) => s.mode === 'random')).toHaveLength(PROBE_DRILL_ITEM_CAP);
    // reverse goes for the least stable planned items first
    expect(modesOf(steps).filter((m) => m === 'reverse')).toHaveLength(PROBE_DRILL_ITEM_CAP);
  });

  it('assesses a bound sequence as a sequence', () => {
    const input = planInput();
    const sequenceItem = makeItem({
      id: 'i-seq',
      verseKey: '112:1',
      sequence: ['112:1', '112:2', '112:3'],
      band: 'weak',
      stability: 0.2,
      nextReviewAt: dayIso(20),
      attemptCount: 4,
    });
    const plan = buildDailyPlan({ ...input, items: [sequenceItem, ...input.items.filter((i) => i.id !== 'i-112a')] });
    const steps = buildSessionSteps({ plan, items: [sequenceItem], nowIso: input.nowIso });
    const last = steps[steps.length - 1]!;
    expect(last.mode).toBe('full-sequence');
    expect(last.verseKey).toBe('112:1');
  });

  it('skips phases that have nothing to do', () => {
    const steps = stepsFor({ transitions: [], confusionGroups: undefined });
    expect(modesOf(steps)).not.toContain('transition');
    expect(modesOf(steps)).not.toContain('full-ayah');
    const empty = buildSessionSteps({
      plan: { date: '2026-01-31', newAyahs: [], reviewItems: [], weakItems: [], confusionGroups: [], estimatedMinutes: 0 },
      items: [],
      nowIso: dayIso(30),
    });
    expect(empty).toEqual([]);
  });

  it('never repeats the same probe for the same ayah', () => {
    const steps = stepsFor();
    const keys = steps.map((s) => `${s.mode}:${s.verseKey}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('is byte-identical for the same plan', () => {
    expect(JSON.stringify(stepsFor())).toBe(JSON.stringify(stepsFor()));
  });

  it('prices the whole session from the same per-step model', () => {
    const steps = stepsFor();
    const manual = steps.reduce((sum, s) => sum + (MODE_COST_SECONDS[s.mode] ?? 0) + STEP_OVERHEAD_SECONDS, 0) + ASSESSMENT_STEP_SECONDS;
    expect(sessionCostSeconds(steps)).toBe(manual);
    expect(sessionCostSeconds([])).toBe(ASSESSMENT_STEP_SECONDS);
    expect(sessionCostSeconds(steps)).toBeGreaterThan(manual - 1);
  });
});

/* ------------------------------------------------------------------ *
 * Recording a session
 * ------------------------------------------------------------------ */

describe('session bookkeeping', () => {
  const steps = stepsFor();

  it('starts open with copies of the plan steps', () => {
    const session = createSession({ id: 's1', startedAt: dayIso(30, 8), steps });
    expect(session).toMatchObject({ id: 's1', startedAt: dayIso(30, 8), endedAt: null, plannedSteps: steps.length, report: null });
    expect(session.steps).toHaveLength(steps.length);
    expect(session.steps[0]).not.toBe(steps[0]);
    expect(session.steps.every((s) => s.attemptId === null && s.completedAt === null)).toBe(true);
  });

  it('attaches attempts step by step without mutating the session', () => {
    const open = createSession({ id: 's1', startedAt: dayIso(30, 8), steps });
    const once = withAttempt(open, 0, 'at-1', dayIso(30, 8, ));
    const twice = withAttempt(once, 1, 'at-2', dayIso(30, 9));
    expect(open.steps[0]!.attemptId).toBeNull();
    expect(once.steps[1]!.attemptId).toBeNull();
    expect(once.steps[0]).toMatchObject({ attemptId: 'at-1', completedAt: dayIso(30, 8) });
    expect(twice.steps[1]).toMatchObject({ attemptId: 'at-2', completedAt: dayIso(30, 9) });
    expect(twice.plannedSteps).toBe(open.plannedSteps);
    expect(withAttempt(twice, 99, 'at-x', dayIso(30, 10)).steps).toEqual(twice.steps);
  });

  it('closes with its report', () => {
    const open = createSession({ id: 's1', startedAt: dayIso(30, 8), steps });
    const report = computeSessionReport({ nowIso: dayIso(30), attempts: [], items: planInput().items });
    const closed = finishSession(open, dayIso(30, 11), report);
    expect(closed.endedAt).toBe(dayIso(30, 11));
    expect(closed.report).toBe(report);
    expect(open.endedAt).toBeNull();
  });

  it('knows whether the session was clean', () => {
    const good = makeAttempt({ id: 'g', itemId: 'i', verseKey: '112:1', startedAt: dayIso(1), expectedWordCount: 4, correctWordCount: 4 });
    const bad = makeAttempt({ id: 'b', itemId: 'i', verseKey: '112:1', startedAt: dayIso(1), expectedWordCount: 4, correctWordCount: 2 });
    expect(sessionIsClean([good, good])).toBe(true);
    expect(sessionIsClean([good, bad])).toBe(false);
    expect(sessionIsClean([])).toBe(false);
  });

  it('groups attempts per item for replay', () => {
    const map = attemptsByItem([
      makeAttempt({ id: '1', itemId: 'a', verseKey: '112:1', startedAt: dayIso(1) }),
      makeAttempt({ id: '2', itemId: 'b', verseKey: '112:2', startedAt: dayIso(1) }),
      makeAttempt({ id: '3', itemId: 'a', verseKey: '112:1', startedAt: dayIso(2) }),
    ]);
    expect([...map.keys()]).toEqual(['a', 'b']);
    expect(map.get('a')!.map((x) => x.id)).toEqual(['1', '3']);
  });
});

describe('advanceStability', () => {
  it('moves a boundary toward 1 on a success and toward 0 on a failure', () => {
    expect(advanceStability(0, true)).toBeCloseTo(LEARN_RATE, 10);
    expect(advanceStability(0, false)).toBe(0);
    expect(advanceStability(1, true)).toBe(1);
    expect(advanceStability(0.5, false)).toBeCloseTo(0.5 * (1 - LEARN_RATE), 10);
    expect(advanceStability(0.5, true)).toBeGreaterThan(0.5);
    expect(advanceStability(-2, true)).toBeCloseTo(LEARN_RATE, 10);
    expect(advanceStability(42, false)).toBeCloseTo(1 - LEARN_RATE, 10);
  });

  it('converges upward over repeated successes', () => {
    let value = 0;
    for (let i = 0; i < 10; i += 1) value = advanceStability(value, true);
    expect(value).toBeGreaterThan(0.95);
    expect(value).toBeLessThanOrEqual(1);
  });
});

/* ------------------------------------------------------------------ *
 * The report, computed from three real recitations
 * ------------------------------------------------------------------ */

function recited(): { attempts: RecallAttempt[]; results: Record<string, ClassificationResult> } {
  const a255 = segmentAyah({ itemId: 'i-255', verseKey: '2:255', text: ayahText('2:255') });
  const r255 = classifyRecitation({
    expected: words('2:255'),
    produced: producedFrom('2:255', { drop: [4, 5] }).map((w) => w.text),
    itemId: 'i-255',
    verseKey: '2:255',
    mode: 'continue-ayah',
    segments: spanOf(a255.segments),
  });
  const r112a = classifyRecitation({
    expected: words('112:1'),
    produced: words('112:1'),
    itemId: 'i-112a',
    verseKey: '112:1',
    mode: 'continue-ayah',
  });
  const r112c = classifyRecitation({
    expected: words('112:4'),
    produced: words('112:3'),
    itemId: 'i-112c',
    verseKey: '112:4',
    mode: 'full-ayah',
    confusionCandidates: [{ verseKey: '112:3', words: words('112:3') }],
  });
  const build = (n: number, r: ClassificationResult): RecallAttempt =>
    makeAttempt({
      id: `at-${n}`,
      itemId: r.itemId!,
      verseKey: r.verseKey!,
      sessionId: 's1',
      mode: r.mode,
      startedAt: dayIso(30, 8 + n),
      completedAt: dayIso(30, 8 + n),
      expectedWordCount: r.expectedWordCount,
      correctWordCount: r.correctWordCount,
      accuracy: r.accuracy,
      errors: r.errors,
    });
  return {
    attempts: [build(0, r255), build(1, r112a), build(2, r112c)],
    results: { r255, r112a, r112c },
  };
}

function reportInput() {
  const { attempts, results } = recited();
  const a255 = segmentAyah({ itemId: 'i-255', verseKey: '2:255', text: ayahText('2:255') });
  const items = [
    makeItem({
      id: 'i-255',
      verseKey: '2:255',
      band: 'weak',
      stability: 0.5,
      addedAt: dayIso(0),
      lastReviewedAt: dayIso(20),
      nextReviewAt: dayIso(23),
      attemptCount: 5,
      errorCount: 9,
    }),
    makeItem({ id: 'i-112a', verseKey: '112:1', band: 'new', stability: 0, addedAt: dayIso(29) }),
    makeItem({
      id: 'i-112c',
      verseKey: '112:4',
      band: 'weak',
      stability: 0.4,
      addedAt: dayIso(0),
      lastReviewedAt: dayIso(10),
      nextReviewAt: dayIso(12),
      attemptCount: 4,
      errorCount: 6,
    }),
  ];
  const segments: HifzSegment[] = [
    ...a255.segments,
    makeSegment({ itemId: 'i-112a', position: 0, fromWord: 1, toWord: 4, stability: 0.9 }),
  ];
  const transitions: HifzTransition[] = [
    makeTransition({ itemId: 'i-255', toWord: 4, stability: 0.7 }),
    makeTransition({ itemId: 'i-255', toWord: 8, stability: 0.9 }),
    makeTransition({ itemId: 'i-112a', toWord: 1, kind: 'inter', stability: 0.1 }),
    makeTransition({ itemId: 'i-112c', toWord: 2, stability: 0.8 }),
  ];
  const prior = [
    makeAttempt({ id: 'old-1', itemId: 'i-255', verseKey: '2:255', startedAt: dayIso(10), completedAt: dayIso(10, 1), expectedWordCount: 50, correctWordCount: 45 }),
    makeAttempt({ id: 'old-2', itemId: 'i-112c', verseKey: '112:4', startedAt: dayIso(10), completedAt: dayIso(10, 1), expectedWordCount: 4, correctWordCount: 4 }),
  ];
  return { attempts, results, input: { nowIso: dayIso(30), attempts, items, priorAttempts: prior, segments, transitions } };
}

describe('session report', () => {
  it('scores overall recall from the words actually recited', () => {
    const { input, results } = reportInput();
    const report = computeSessionReport(input);
    const expected = results.r255!.expectedWordCount + results.r112a!.expectedWordCount + results.r112c!.expectedWordCount;
    const correct = results.r255!.correctWordCount + results.r112a!.correctWordCount + results.r112c!.correctWordCount;
    expect(expected).toBe(59);
    expect(report.overallRecall).toBeCloseTo(correct / expected, 4);
    expect(report.overallRecall).toBeLessThan(1);
    expect(report.newItemsLearned).toBe(1);
    expect(report.reviewsCompleted).toBe(2);
  });

  it('an empty session reports zeros, never a division error', () => {
    const report = computeSessionReport({ nowIso: dayIso(30), attempts: [], items: planInput().items });
    expect(report.overallRecall).toBe(0);
    expect(report.newItemsLearned).toBe(0);
    expect(report.reviewsCompleted).toBe(0);
    expect(report.recommendedNextReviewAt).toBeNull();
    expect(report.weakSegments).toEqual([]);
    expect(report.stabilityChanges).toEqual([]);
  });

  it('names the segment that broke, by accuracy over its own words', () => {
    const report = computeSessionReport(reportInput().input);
    expect(report.weakSegments).toEqual([
      { itemId: 'i-255', segmentPosition: 1, accuracy: 0.5 },
    ]);
    for (const row of report.weakSegments) expect(row.accuracy).toBeLessThan(WEAK_SEGMENT_STABILITY);
  });

  it('moves transition stability with what happened at that boundary', () => {
    const { input, results } = reportInput();
    const report = computeSessionReport(input);
    // the ayah that was recited perfectly lifts its inter-ayah boundary, the
    // omitted word drags the boundary that follows it down.
    expect(report.weakTransitions).toEqual([
      { itemId: 'i-112a', toWord: 1, stability: 0.415 },
      { itemId: 'i-255', toWord: 4, stability: 0.455 },
    ]);
    for (const row of report.weakTransitions) expect(row.stability).toBeLessThan(WEAK_TRANSITION_STABILITY);
    // boundaries of items not recited in this session are not reported
    expect(report.weakTransitions.some((t) => t.itemId === 'i-112c')).toBe(false);
    expect(results.r255!.errors.filter((e) => e.kind === 'omission')).toHaveLength(2);
  });

  it('collects the ayahs the learner got mixed up with', () => {
    const report = computeSessionReport(reportInput().input);
    expect(report.confusedVerseKeys).toEqual(['112:3']);
  });

  it('flags a kind only once it repeats', () => {
    const report = computeSessionReport(reportInput().input);
    expect(REPEATED_ERROR_MIN_COUNT).toBe(2);
    // two omissions, and two attempts that broke down in the first third
    expect(report.repeatedErrors).toEqual([
      { kind: 'beginning-failure', count: 2 },
      { kind: 'omission', count: 2 },
    ]);
    // a one-off confusion kind is not a "repeated error" yet
    expect(report.repeatedErrors.some((e) => e.kind === 'similar-ayah-confusion')).toBe(false);
  });

  it('reports stability before and after for every touched item', () => {
    const { input } = reportInput();
    const report = computeSessionReport(input);
    expect(report.stabilityChanges.map((c) => c.itemId)).toEqual(['i-112a', 'i-112c', 'i-255']);
    const after = new Map(report.stabilityChanges.map((c) => [c.itemId, c.after]));
    expect(after.get('i-112a')).toBeGreaterThan(0);
    expect(after.get('i-255')).toBeGreaterThan(0.5);
    expect(after.get('i-112c')).toBeLessThan(0.4);
    for (const row of report.stabilityChanges) {
      expect(row.before).toBeLessThanOrEqual(1);
      expect(row.after).toBeGreaterThanOrEqual(0);
    }
  });

  it('recommends the earliest recomputed review date', () => {
    const { input } = reportInput();
    const report = computeSessionReport(input);
    const after = stabilityAfterSession(input);
    const earliest = after.map((a) => a.nextReviewAt).sort()[0]!;
    expect(report.recommendedNextReviewAt).toBe(earliest);
    expect(report.recommendedNextReviewAt).not.toBeNull();
  });

  it('exposes the per-item persistence rows with band and next review', () => {
    const after = stabilityAfterSession(reportInput().input);
    expect(after.map((a) => a.itemId)).toEqual(['i-112a', 'i-112c', 'i-255']);
    const i255 = after.find((a) => a.itemId === 'i-255')!;
    expect(i255.before).toBe(0.5);
    expect(i255.after).toBeGreaterThan(i255.before);
    expect(['new', 'unstable', 'weak', 'stable', 'mastered']).toContain(i255.band);
    expect(Date.parse(i255.nextReviewAt)).not.toBeNaN();
    const fresh = after.find((a) => a.itemId === 'i-112a')!;
    expect(fresh.before).toBe(0);
    expect(fresh.band).toBe('new');
  });

  it('is byte-identical for the same attempts', () => {
    const a = reportInput();
    const b = reportInput();
    expect(JSON.stringify(computeSessionReport(a.input))).toBe(JSON.stringify(computeSessionReport(b.input)));
  });

  it('does not mutate the attempts it reports on', () => {
    const { attempts } = recited();
    const snapshot = JSON.stringify(attempts);
    computeSessionReport({ nowIso: dayIso(30), attempts, items: [] });
    expect(JSON.stringify(attempts)).toBe(snapshot);
  });

  it('counts positional failures into the repeated-error table only when they repeat', () => {
    const attempts = [
      makeAttempt({ id: 'p1', itemId: 'i', verseKey: '2:255', startedAt: dayIso(1), expectedWordCount: 50, correctWordCount: 10, errors: [makeError('beginning-failure', 3)] }),
      makeAttempt({ id: 'p2', itemId: 'i', verseKey: '2:255', startedAt: dayIso(2), expectedWordCount: 50, correctWordCount: 12, errors: [makeError('beginning-failure', 4)] }),
    ];
    const report = computeSessionReport({ nowIso: dayIso(30), attempts, items: [] });
    expect(report.repeatedErrors).toEqual([{ kind: 'beginning-failure', count: 2 }]);
    expect(report.overallRecall).toBeCloseTo(22 / 100, 4);
  });
});
