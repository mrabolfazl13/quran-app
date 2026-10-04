/**
 * Review scheduler tests.
 *
 * Two things are checked everywhere: that the numbers come from the documented
 * formulas (so `docs/review-algorithm.md` cannot drift silently), and that the
 * same input produces byte-identical output.
 */

import { describe, expect, it } from 'vitest';
import {
  applyGroupBoost,
  attemptCostSeconds,
  buildDailyPlan,
  groupsByItemId,
  historyFor,
  newAyahCostSeconds,
  planReviews,
  rawFactors,
  scoreItem,
  sortEntries,
  suggestMode,
  type ItemHistory,
  type ReviewContextInput,
} from '../../src/hifz/review';
import {
  BAND_URGENCY,
  CONFUSION_SATURATION_ERRORS,
  DEFAULT_NEW_AYAH_WORD_COUNT,
  DAILY_REVIEW_ITEM_CAP,
  GROUP_BOOST_CAP,
  GROUP_BOOST_PER_TRIGGER,
  GROUP_CONFUSION_SATURATION,
  GROUP_MEMBER_LIFT_CAP,
  GROUP_MEMBER_TAPER,
  HISTORICAL_ERROR_WORD_NORMALIZER,
  MODE_COST_SECONDS,
  NEW_AYAH_EXPOSURE_SECONDS,
  NEW_AYAH_PER_DAY_CAP,
  NEW_AYAH_PER_WORD_SECONDS,
  NEW_LEARNING_ATTEMPT_SECONDS,
  NEW_LEARNING_RECALL_ATTEMPTS,
  NEVER_SCHEDULED_FACTOR,
  OVERDUE_SATURATION_DAYS,
  PRIORITY_PLAN_CUTOFF,
  PRIORITY_WEAK_CUTOFF,
  RECENCY_SATURATION_DAYS,
  REPETITION_SATURATION_ATTEMPTS,
  REVIEW_WEIGHTS,
  STEP_OVERHEAD_SECONDS,
  type ReviewFactorKey,
} from '../../src/hifz/params';
import {
  dayIso,
  makeAttempt,
  makeError,
  makeGroup,
  makeItem,
  makeSegment,
  makeTransition,
} from './fixtures';
import type { RecallAttempt, ReviewPlanEntry } from '../../src/contracts/hifz';

const FACTOR_KEYS = Object.keys(REVIEW_WEIGHTS) as ReviewFactorKey[];

/**
 * The scheduler scenario: one overdue ayah with real segment/transition data,
 * one brand-new ayah with nothing recorded yet, one mastered ayah that is a
 * confusion partner of the first, and one paused ayah that must never appear.
 */
function scenario(): ReviewContextInput {
  return {
    nowIso: dayIso(30),
    items: [
      makeItem({
        id: 'i-over',
        verseKey: '2:255',
        band: 'weak',
        stability: 0.5,
        addedAt: dayIso(0),
        lastReviewedAt: dayIso(20),
        nextReviewAt: dayIso(23),
        attemptCount: 2,
        errorCount: 9,
      }),
      makeItem({ id: 'i-fresh', verseKey: '112:1', band: 'new', stability: 0, addedAt: dayIso(29) }),
      makeItem({
        id: 'i-master',
        verseKey: '112:4',
        band: 'mastered',
        stability: 0.97,
        addedAt: dayIso(0),
        lastReviewedAt: dayIso(28),
        nextReviewAt: dayIso(45),
        attemptCount: 12,
      }),
      makeItem({
        id: 'i-paused',
        verseKey: '108:1',
        band: 'weak',
        status: 'paused',
        stability: 0.4,
        nextReviewAt: dayIso(1),
      }),
    ],
    attempts: [
      makeAttempt({
        id: 'a1',
        itemId: 'i-over',
        verseKey: '2:255',
        startedAt: dayIso(1),
        completedAt: dayIso(1, 1),
        expectedWordCount: 50,
        correctWordCount: 30,
        errors: [
          makeError('omission', 3, { segmentPosition: 1 }),
          makeError('substitution', 8, { segmentPosition: 2, actual: 'خَطَأٌ' }),
        ],
      }),
      makeAttempt({
        id: 'a2',
        itemId: 'i-over',
        verseKey: '2:255',
        startedAt: dayIso(10),
        completedAt: dayIso(10, 1),
        expectedWordCount: 50,
        correctWordCount: 48,
      }),
      makeAttempt({
        id: 'a3',
        itemId: 'i-master',
        verseKey: '112:4',
        startedAt: dayIso(28),
        completedAt: dayIso(28, 1),
        expectedWordCount: 4,
        correctWordCount: 4,
      }),
      makeAttempt({ id: 'a4', itemId: 'i-fresh', verseKey: '112:1', startedAt: dayIso(29), mode: 'segment' }),
    ],
    segments: [
      makeSegment({ itemId: 'i-over', position: 0, fromWord: 1, toWord: 6, stability: 0.9 }),
      makeSegment({ itemId: 'i-over', position: 1, fromWord: 7, toWord: 12, stability: 0.2 }),
      makeSegment({ itemId: 'i-over', position: 2, fromWord: 13, toWord: 20, stability: 0.4 }),
    ],
    transitions: [
      makeTransition({ itemId: 'i-over', toWord: 7, stability: 0.8 }),
      makeTransition({ itemId: 'i-over', toWord: 13, stability: 0.1 }),
      makeTransition({ itemId: 'i-over', toWord: 21, kind: 'inter', stability: 0.3 }),
    ],
    confusionGroups: [makeGroup({ verseKeys: ['2:255', '112:4'], confusionCount: GROUP_CONFUSION_SATURATION, lastTriggeredAt: dayIso(5) })],
  };
}

function historyOf(input: ReviewContextInput, itemId: string): ItemHistory {
  const history = historyFor(input).get(itemId);
  if (!history) throw new Error(`no history for ${itemId}`);
  return history;
}

function entryFor(entries: ReviewPlanEntry[], verseKey: string): ReviewPlanEntry {
  const found = entries.find((e) => e.verseKey === verseKey);
  if (!found) throw new Error(`no entry for ${verseKey}`);
  return found;
}

/** The nine factors that are summed into a priority (the meaning uplift is not). */
const SUMMED_KEYS = FACTOR_KEYS.filter((key) => key !== 'meaning-gap');

describe('review weights', () => {
  it('sum to exactly 1 so priority is a weighted average', () => {
    const sum = SUMMED_KEYS.reduce((acc, key) => acc + REVIEW_WEIGHTS[key], 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it('keep the meaning gap as a bounded uplift, not a tenth slice', () => {
    // The documented nine are unchanged by the meaning axis, so an item with no
    // meaning lag scores exactly what it scored before the axis existed, and no
    // learner loses a documented factor's weight to a feature they never opted in
    // to. The gap takes a share of the headroom the nine leave instead.
    const gapWeight = REVIEW_WEIGHTS['meaning-gap'];
    expect(gapWeight).toBeGreaterThan(0);
    expect(gapWeight).toBeLessThan(1);
    const input = scenario();
    const clean = scoreItem(historyOf(input, 'i-over'), input.nowIso);
    const lagging = scoreItem({ ...historyOf(input, 'i-over'), meaningAvailable: true }, input.nowIso);
    expect(clean.weighted['meaning-gap']).toBe(0);
    expect(lagging.entry.priority).toBeGreaterThan(clean.entry.priority);
    // uplift = raw × weight × headroom, and never exceeds what is left
    expect(lagging.weighted['meaning-gap']).toBeCloseTo(
      lagging.raw['meaning-gap'] * gapWeight * (1 - clean.entry.priority),
      3,
    );
    expect(lagging.entry.priority).toBeLessThanOrEqual(1);
  });

  it('every factor key is exposed both weighted and raw', () => {
    const entry = planReviews(scenario())[0]!;
    for (const key of FACTOR_KEYS) {
      expect(entry.factors).toHaveProperty(key);
      expect(entry.factors).toHaveProperty(`${key}-raw`);
    }
    expect(Object.keys(entry.factors)).toHaveLength(FACTOR_KEYS.length * 2);
  });
});

describe('determinism', () => {
  it('scheduling the same input twice yields byte-identical output', () => {
    const input = scenario();
    const first = JSON.stringify(planReviews(input));
    const second = JSON.stringify(planReviews(input));
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThan(1000);
  });

  it('an equal-but-separate input produces the same bytes', () => {
    const a = JSON.stringify(planReviews(scenario()));
    const b = JSON.stringify(buildDailyPlan(scenario()));
    const again = JSON.stringify(planReviews(scenario()));
    expect(a).toBe(again);
    // the plan embeds the same entries, so its JSON must contain them verbatim
    for (const entry of JSON.parse(b).reviewItems as ReviewPlanEntry[]) {
      expect(a).toContain(JSON.stringify(entry).slice(1, -1));
    }
  });

  it('does not mutate the input items, attempts or groups', () => {
    const input = scenario();
    const snapshot = JSON.stringify([input.items, input.attempts, input.confusionGroups]);
    buildDailyPlan({ ...input, newAyahs: ['108:2'] });
    expect(JSON.stringify([input.items, input.attempts, input.confusionGroups])).toBe(snapshot);
  });
});

describe('raw factors', () => {
  it('are computed from the stored history of an overdue item', () => {
    const input = scenario();
    const raw = rawFactors(historyOf(input, 'i-over'), input.nowIso);
    // 2 wrong words over 100 expected words
    expect(raw['historical-errors']).toBeCloseTo(2 / 100, 4);
    // 0.5*(1 - mean(0.9,0.2,0.4)) + 0.5*(2 of 3 below the weak cutoff)
    expect(raw['weak-segments']).toBeCloseTo(0.5 * (1 - 0.5) + 0.5 * (2 / 3), 4);
    expect(raw['weak-transitions']).toBeCloseTo(0.5 * (1 - 0.4) + 0.5 * (2 / 3), 4);
    // 7 days late out of 21
    expect(raw.overdue).toBeCloseTo(7 / OVERDUE_SATURATION_DAYS, 4);
    // last success ~20 days ago out of 30
    expect(raw['recency-of-success']).toBeCloseTo(19.9583 / RECENCY_SATURATION_DAYS, 3);
    expect(raw.repetition).toBeCloseTo(1 - 2 / REPETITION_SATURATION_ATTEMPTS, 4);
    expect(raw['confusion-rate']).toBe(0);
    expect(raw['group-membership']).toBe(1);
    expect(raw.band).toBe(BAND_URGENCY.weak);
  });

  it('saturate instead of running away', () => {
    const input = scenario();
    const history = historyOf(input, 'i-over');
    const huge: ItemHistory = {
      ...history,
      item: { ...history.item, nextReviewAt: dayIso(-100) },
      attempts: Array.from({ length: 40 }, (_, i) =>
        makeAttempt({
          id: `x${i}`,
          itemId: 'i-over',
          verseKey: '2:255',
          startedAt: dayIso(1),
          expectedWordCount: 1,
          errors: [makeError('similar-ayah-confusion', 1, { confusedWithVerseKey: '2:256' })],
        }),
      ),
      groups: [makeGroup({ verseKeys: ['2:255'], confusionCount: 999 })],
    };
    const raw = rawFactors(huge, input.nowIso);
    for (const key of FACTOR_KEYS) expect(raw[key]).toBeLessThanOrEqual(1);
    expect(raw.overdue).toBe(1);
    expect(raw['confusion-rate']).toBe(1);
    expect(raw['group-membership']).toBe(1);
    // 40 wrong words against 40 expected words
    expect(raw['historical-errors']).toBe(1);
    expect(raw.repetition).toBe(0);
    // and the priority still cannot exceed the weight budget
    expect(scoreItem(huge, input.nowIso).entry.priority).toBeLessThanOrEqual(1);
  });

  it('fall back to item stability when structure has not been recorded yet', () => {
    const input = scenario();
    const raw = rawFactors(historyOf(input, 'i-fresh'), input.nowIso);
    expect(raw['weak-segments']).toBeCloseTo(1 - 0, 4);
    expect(raw['weak-transitions']).toBeCloseTo(1 - 0, 4);
    expect(raw.overdue).toBe(NEVER_SCHEDULED_FACTOR);
    expect(raw['recency-of-success']).toBe(1);
    expect(raw.band).toBe(BAND_URGENCY.new);
  });

  it('uses item.errorCount when no attempt rows exist', () => {
    const input = scenario();
    const history = historyOf(input, 'i-over');
    const raw = rawFactors({ ...history, attempts: [] }, input.nowIso);
    expect(raw['historical-errors']).toBeCloseTo(9 / HISTORICAL_ERROR_WORD_NORMALIZER, 4);
    expect(raw.repetition).toBe(1);
  });

  it('counts cross-ayah errors into the confusion factor', () => {
    const input = scenario();
    const history = historyOf(input, 'i-over');
    const confused: ItemHistory = {
      ...history,
      attempts: [
        makeAttempt({
          id: 'z',
          itemId: 'i-over',
          verseKey: '2:255',
          startedAt: dayIso(1),
          expectedWordCount: 50,
          errors: [
            makeError('wrong-transition', 4, { confusedWithVerseKey: '2:256' }),
            makeError('similar-ayah-confusion', 9, { confusedWithVerseKey: '2:257' }),
            makeError('substitution', 12),
          ],
        }),
      ],
    };
    const raw = rawFactors(confused, input.nowIso);
    expect(raw['confusion-rate']).toBeCloseTo(2 / CONFUSION_SATURATION_ERRORS, 4);
    expect(raw['historical-errors']).toBeCloseTo(3 / 50, 4);
  });
});

describe('priority and reasons', () => {
  it('priority is the sum of the weighted contributions', () => {
    const input = scenario();
    const scored = scoreItem(historyOf(input, 'i-over'), input.nowIso);
    const sum = FACTOR_KEYS.reduce((acc, key) => acc + scored.weighted[key], 0);
    expect(scored.entry.priority).toBeCloseTo(sum, 3);
    for (const key of SUMMED_KEYS) {
      expect(scored.weighted[key]).toBeCloseTo(scored.raw[key] * REVIEW_WEIGHTS[key], 4);
    }
    // every summed contribution is inside its own weight, and the whole priority
    // is inside 0..1 with the uplift applied
    for (const key of SUMMED_KEYS) expect(scored.weighted[key]).toBeLessThanOrEqual(REVIEW_WEIGHTS[key]);
    expect(scored.entry.priority).toBeLessThanOrEqual(1);
  });

  it('reason lists the three strongest factors, and the entry carries its due date', () => {
    const input = scenario();
    const scored = scoreItem(historyOf(input, 'i-over'), input.nowIso);
    const top = FACTOR_KEYS.slice()
      .sort((a, b) => scored.weighted[b] - scored.weighted[a] || a.localeCompare(b))
      .slice(0, 3);
    for (const key of top) {
      expect(scored.entry.reason.length).toBeGreaterThan(0);
    }
    expect(scored.entry.reason.split('; ')).toHaveLength(3);
    expect(scored.entry.reason).toContain('2/3 segment(s) below 0.6');
    expect(scored.entry.reason).toContain('2/3 transition(s) below 0.6');
    expect(scored.entry.reason).toContain('overdue by 7d');
    expect(scored.entry.dueAt).toBe(dayIso(23));
    // the documented pre-meaning priority, unchanged: nothing about this item's
    // meaning was tested, and no licensed meaning was supplied for it either
    expect(scored.entry.priority).toBeCloseTo(0.4511, 4);
  });

  it('names the overdue summary when overdue is the dominant weight', () => {
    const input = scenario();
    const only = Object.fromEntries(
      FACTOR_KEYS.map((key) => [key, 0]),
    ) as Record<ReviewFactorKey, number>;
    const scored = scoreItem(historyOf(input, 'i-over'), input.nowIso, { ...only, overdue: 1 });
    expect(scored.entry.reason).toBe('overdue by 7d');
    expect(scored.entry.priority).toBeCloseTo(scored.raw.overdue, 4);
  });

  it('reports the meaning axis as unavailable rather than as a zero gap', () => {
    const input = scenario();
    const scored = scoreItem(historyOf(input, 'i-over'), input.nowIso);
    expect(scored.raw['meaning-gap']).toBe(0);
    // No meaning was supplied for this ayah, so the reason must say so when the
    // meaning factor is the one carrying the weight — an absent axis is not a
    // silent one.
    const only = Object.fromEntries(
      FACTOR_KEYS.map((key) => [key, 0]),
    ) as Record<ReviewFactorKey, number>;
    const meaningWeighted = scoreItem(historyOf(input, 'i-over'), input.nowIso, {
      ...only,
      'meaning-gap': 1,
    });
    expect(meaningWeighted.raw['meaning-gap']).toBe(0);
    expect(meaningWeighted.entry.reason).toBe('no urgency signals');
    const covered = scoreItem(
      { ...historyOf(input, 'i-over'), meaningAvailable: true },
      input.nowIso,
      { ...only, 'meaning-gap': 1 },
    );
    expect(covered.raw['meaning-gap']).toBe(1);
    expect(covered.entry.reason).toBe('meaning axis never tested vs form 0.5');
    // and with the documented weight it still moves the number, just quietly
    const withMeaning = scoreItem({ ...historyOf(input, 'i-over'), meaningAvailable: true }, input.nowIso);
    expect(withMeaning.entry.priority).toBeGreaterThan(scored.entry.priority);
    expect(withMeaning.weighted['meaning-gap']).toBeGreaterThan(0);
  });

  it('honest summaries appear when segment rows are missing', () => {
    const input = scenario();
    const fresh = scoreItem(historyOf(input, 'i-fresh'), input.nowIso);
    expect(fresh.entry.reason).toContain('no segment data');
    expect(fresh.entry.reason).toContain('never scheduled');
    expect(fresh.entry.dueAt).toBe(dayIso(29));
  });

  it('ranks the urgent items first', () => {
    const entries = planReviews(scenario());
    expect(entries.map((e) => e.verseKey)).toEqual(['112:1', '2:255', '112:4']);
    expect(entries[0]!.priority).toBeGreaterThan(entries[entries.length - 1]!.priority);
  });
});

describe('suggestMode', () => {
  /** One recorded recall, so "nothing learned yet" never masks a real signal. */
  const practiced = (): RecallAttempt[] => [
    makeAttempt({ id: 'p0', itemId: 'm', verseKey: '2:255', startedAt: dayIso(28), completedAt: dayIso(28, 1), expectedWordCount: 50, correctWordCount: 48 }),
  ];
  const base = (over: Partial<ItemHistory> = {}): ItemHistory => ({
    item: makeItem({ id: 'm', verseKey: '2:255', band: 'weak', stability: 0.5, nextReviewAt: dayIso(23) }),
    attempts: practiced(),
    segments: [],
    transitions: [],
    groups: [],
    // No meaning coverage by default: the meaning rules only fire when the
    // scenario says a licensed meaning exists.
    meaningAvailable: false,
    previousMeaningAvailable: false,
    ...over,
  });
  const modeOf = (over: Partial<ItemHistory>, raw?: Partial<Record<ReviewFactorKey, number>>): string => {
    const history = base(over);
    const defaults: Record<ReviewFactorKey, number> = {
      'historical-errors': 0,
      'weak-segments': 0,
      'weak-transitions': 0,
      overdue: 0,
      'recency-of-success': 0,
      repetition: 0,
      'confusion-rate': 0,
      'group-membership': 0,
      band: 0,
      'meaning-gap': 0,
    };
    return suggestMode(history, { ...defaults, ...raw });
  };

  it('teaches new material segment by segment', () => {
    expect(modeOf({ attempts: [] })).toBe('segment');
    expect(modeOf({ item: makeItem({ id: 'm', verseKey: '2:255', band: 'new' }) })).toBe('segment');
  });

  it('drills a confused ayah as a whole ayah first', () => {
    expect(modeOf({}, { 'confusion-rate': 0.5, 'weak-transitions': 1 })).toBe('full-ayah');
    expect(modeOf({ groups: [makeGroup({ verseKeys: ['2:255'], confusionCount: 1 })] }, { 'group-membership': 1 })).toBe('full-ayah');
  });

  it('trains the weakest boundary when transitions are the problem', () => {
    expect(modeOf({}, { 'weak-transitions': 0.6, 'weak-segments': 0.3 })).toBe('transition');
  });

  it('targets the positional third that keeps failing', () => {
    const withErrors = (kinds: string[]) =>
      [makeAttempt({ id: 'p', itemId: 'm', verseKey: '2:255', startedAt: dayIso(1), expectedWordCount: 50, correctWordCount: 20, errors: kinds.map((k, i) => makeError(k as never, i + 1)) })];
    expect(modeOf({ attempts: withErrors(['beginning-failure', 'ending-failure']) }, { 'weak-segments': 0.4 })).toBe('opening');
    expect(modeOf({ attempts: withErrors(['ending-failure']) }, { 'weak-segments': 0.4 })).toBe('ending');
    expect(modeOf({ attempts: withErrors(['middle-failure']) }, { 'weak-segments': 0.4 })).toBe('middle');
  });

  it('falls back through segments, cues and probes', () => {
    expect(modeOf({}, { 'weak-segments': 0.4 })).toBe('segment');
    expect(modeOf({}, { overdue: 0.3 })).toBe('first-word-cue');
    expect(modeOf({}, { 'recency-of-success': 0.9 })).toBe('first-word-cue');
    expect(modeOf({}, { 'recency-of-success': 0.2 })).toBe('missing-word');
  });
});

describe('ordering', () => {
  it('breaks priority ties by due date, then verse key, then item key', () => {
    const entry = (itemId: string, verseKey: string, dueAt: string, priority: number): ReviewPlanEntry => ({
      itemId,
      verseKey,
      reason: 'fixture',
      priority,
      factors: {},
      suggestedMode: 'full-ayah',
      dueAt,
    });
    const sorted = sortEntries([
      entry('b', '112:3', dayIso(5), 0.5),
      entry('a', '112:1', dayIso(6), 0.5),
      entry('c', '112:2', dayIso(5), 0.5),
      entry('d', '1:1', dayIso(1), 0.9),
    ]);
    expect(sorted.map((e) => e.itemId)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('never schedules paused, graduated or dropped items', () => {
    const input = scenario();
    const entries = planReviews(input);
    expect(entries.some((e) => e.itemId === 'i-paused')).toBe(false);
    const all = planReviews({
      ...input,
      items: input.items.map((item) => ({ ...item, status: item.id === 'i-over' ? 'graduated' : item.status })),
    });
    expect(all.some((e) => e.verseKey === '2:255')).toBe(false);
  });
});

describe('confusion group boost', () => {
  it('lifts the leader by the capped, trigger-proportional boost', () => {
    const input = scenario();
    const boosted = applyGroupBoost(
      [scoreItem(historyOf(input, 'i-over'), input.nowIso)],
      input.confusionGroups ?? [],
    );
    const entry = boosted[0]!.entry;
    const expected = Math.min(GROUP_BOOST_CAP, GROUP_BOOST_PER_TRIGGER * GROUP_CONFUSION_SATURATION);
    expect(entry.factors['group-boost']).toBeCloseTo(expected, 4);
    expect(entry.priority).toBeCloseTo(0.4511 + expected, 4);
    expect(entry.reason).toContain('confusion group');
    expect(entry.reason.match(/confusion group/g)).toHaveLength(1);
  });

  it('pulls the weaker partner up but never across the whole range', () => {
    const input = scenario();
    const scored = [
      scoreItem(historyOf(input, 'i-over'), input.nowIso),
      scoreItem(historyOf(input, 'i-master'), input.nowIso),
    ];
    const before = new Map(scored.map((s) => [s.entry.itemId, s.entry.priority]));
    const boosted = applyGroupBoost(scored, input.confusionGroups ?? []);
    const leader = boosted.find((s) => s.entry.itemId === 'i-over')!.entry.priority;
    const partner = boosted.find((s) => s.entry.itemId === 'i-master')!.entry;
    expect(before.get('i-master')).toBeLessThan(0.3);
    expect(partner.priority).toBeCloseTo(
      Math.min(leader - GROUP_MEMBER_TAPER, before.get('i-master')! + GROUP_MEMBER_LIFT_CAP),
      3,
    );
    expect(partner.priority).toBeLessThan(leader);
    expect(partner.factors['group-boost']).toBeGreaterThan(0);
  });

  it('leaves ungrouped items and zero-trigger groups alone', () => {
    const input = scenario();
    const scored = [scoreItem(historyOf(input, 'i-over'), input.nowIso)];
    const untouched = applyGroupBoost(scored, [makeGroup({ verseKeys: ['1:1', '1:2'], confusionCount: 3 })]);
    expect(untouched[0]!.entry.priority).toBe(scored[0]!.entry.priority);
    const noTriggers = applyGroupBoost(scored, [makeGroup({ verseKeys: ['2:255', '112:4'], confusionCount: 0 })]);
    expect(noTriggers[0]!.entry.factors['group-boost'] ?? 0).toBe(0);
  });
});

describe('weight overrides', () => {
  it('change priority by exactly the raw factor times the delta', () => {
    const input = scenario();
    const history = historyOf(input, 'i-over');
    const base = scoreItem(history, input.nowIso);
    const urgent = scoreItem(history, input.nowIso, { overdue: 0.5 });
    const delta = urgent.entry.priority - base.entry.priority;
    expect(delta).toBeCloseTo(base.raw.overdue * (0.5 - REVIEW_WEIGHTS.overdue), 3);
    expect(urgent.entry.factors.overdue).toBeCloseTo(base.raw.overdue * 0.5, 4);
  });
});

describe('cost model', () => {
  it('prices every recall mode in explicit seconds', () => {
    expect(attemptCostSeconds('segment')).toBe(MODE_COST_SECONDS.segment);
    expect(attemptCostSeconds('full-sequence')).toBe(MODE_COST_SECONDS['full-sequence']);
    expect(attemptCostSeconds('not-a-mode' as never)).toBe(MODE_COST_SECONDS['full-ayah']);
  });

  it('prices a new ayah from its word count', () => {
    const words = 7;
    expect(newAyahCostSeconds(words)).toBe(
      NEW_AYAH_EXPOSURE_SECONDS + NEW_AYAH_PER_WORD_SECONDS * words + NEW_LEARNING_ATTEMPT_SECONDS * NEW_LEARNING_RECALL_ATTEMPTS,
    );
    // a longer ayah must cost more; the model is not a constant
    expect(newAyahCostSeconds(20)).toBeGreaterThan(newAyahCostSeconds(3));
  });
});

describe('daily plan', () => {
  const input = (): ReviewContextInput => scenario();

  it('estimates minutes as the rounded-up sum of its own steps', () => {
    const plan = buildDailyPlan({
      ...input(),
      newAyahs: ['108:1'],
      newAyahWordCounts: { '108:1': 3 },
    });
    const reviewSeconds = [...plan.weakItems, ...plan.reviewItems].reduce(
      (sum, e) => sum + attemptCostSeconds(e.suggestedMode) + STEP_OVERHEAD_SECONDS,
      0,
    );
    const newSeconds = NEW_AYAH_EXPOSURE_SECONDS + NEW_AYAH_PER_WORD_SECONDS * 3 + NEW_LEARNING_ATTEMPT_SECONDS * NEW_LEARNING_RECALL_ATTEMPTS + STEP_OVERHEAD_SECONDS;
    const drillSeconds = plan.confusionGroups.length * 2 * (attemptCostSeconds('full-ayah') + STEP_OVERHEAD_SECONDS);
    const total = reviewSeconds + newSeconds + drillSeconds;
    expect(plan.estimatedSeconds).toBe(total);
    expect(plan.stepCount).toBe(plan.weakItems.length + plan.reviewItems.length + 1 + plan.confusionGroups.length * 2);
    expect(plan.estimatedMinutes).toBe(Math.ceil(total / 60));
    expect(plan.estimatedMinutes).toBeGreaterThan(0);
  });

  it('moves the estimate when the work changes', () => {
    const small = buildDailyPlan(input());
    const big = buildDailyPlan({
      ...input(),
      newAyahs: ['108:1', '108:2', '108:3'],
      newAyahWordCounts: { '108:1': 3, '108:2': 6, '108:3': 9 },
    });
    expect(big.estimatedSeconds).toBeGreaterThan(small.estimatedSeconds);
    expect(big.stepCount - small.stepCount).toBe(3);
    expect(big.estimatedMinutes).toBeGreaterThan(small.estimatedMinutes);
  });

  it('keeps the date and plans exactly the entries at or above the cutoff', () => {
    const plan = buildDailyPlan(input());
    expect(plan.date).toBe('2026-01-31');
    const all = planReviews(input());
    // The scenario supplies no licensed meaning, so every gap is 0 and these are
    // the pre-meaning-axis priorities, byte for byte: the tenth factor must not
    // change what an item with no conceptual lag scores.
    expect(all.map((e) => e.priority)).toEqual([0.5433, 0.5111, 0.301]);
    expect([...plan.weakItems, ...plan.reviewItems].map((e) => e.verseKey)).toEqual(['112:1', '2:255', '112:4']);
    for (const entry of [...plan.weakItems, ...plan.reviewItems]) {
      expect(entry.priority).toBeGreaterThanOrEqual(PRIORITY_PLAN_CUTOFF);
    }
  });

  it('drops an item whose only urgency came from its group', () => {
    const grouped = buildDailyPlan(input());
    const ungrouped = buildDailyPlan({ ...input(), confusionGroups: [] });
    expect(grouped.confusionGroups).toHaveLength(1);
    expect(ungrouped.reviewItems.map((e) => e.verseKey)).toEqual(['112:1', '2:255']);
    expect(ungrouped.estimatedSeconds).toBeLessThan(grouped.estimatedSeconds);
  });

  it('splits weak items from routine reviews at the documented cutoff', () => {
    const base = scenario();
    const hot: ReviewContextInput = {
      ...base,
      attempts: [
        ...base.attempts!,
        makeAttempt({
          id: 'a-hot',
          itemId: 'i-over',
          verseKey: '2:255',
          startedAt: dayIso(29),
          completedAt: dayIso(29, 1),
          expectedWordCount: 50,
          correctWordCount: 20,
          errors: [
            makeError('similar-ayah-confusion', 3, { confusedWithVerseKey: '2:256' }),
            makeError('wrong-transition', 9, { confusedWithVerseKey: '2:257' }),
            makeError('similar-ayah-confusion', 15, { confusedWithVerseKey: '2:258' }),
          ],
        }),
      ],
    };
    const plan = buildDailyPlan(hot);
    expect(plan.weakItems.map((e) => e.verseKey)).toEqual(['2:255']);
    expect(plan.weakItems[0]!.priority).toBeGreaterThanOrEqual(PRIORITY_WEAK_CUTOFF);
    expect(plan.reviewItems.map((e) => e.verseKey)).toEqual(['112:1', '112:4']);
    expect(plan.reviewItems[0]!.priority).toBeLessThan(PRIORITY_WEAK_CUTOFF);
    // a confused ayah is drilled as a whole ayah, not as a cue
    expect(plan.weakItems[0]!.suggestedMode).toBe('full-ayah');
  });

  it('caps new ayahs and review items', () => {
    const plan = buildDailyPlan({ ...input(), newAyahs: ['1:1', '1:2', '1:3', '1:4', '1:5', '1:6', '1:7'] });
    expect(plan.newAyahs).toHaveLength(NEW_AYAH_PER_DAY_CAP);
    expect(plan.newAyahs).toEqual(['1:1', '1:2', '1:3', '1:4', '1:5']);
    expect(plan.stepCount).toBeLessThanOrEqual(DAILY_REVIEW_ITEM_CAP + NEW_AYAH_PER_DAY_CAP + 10);

    const many = planReviews(input());
    expect(many.length).toBeLessThanOrEqual(DAILY_REVIEW_ITEM_CAP);
  });

  it('assumes a documented word count for new ayahs', () => {
    const plan = buildDailyPlan({ ...input(), newAyahs: ['1:2'] });
    const expected =
      NEW_AYAH_EXPOSURE_SECONDS +
      NEW_AYAH_PER_WORD_SECONDS * DEFAULT_NEW_AYAH_WORD_COUNT +
      NEW_LEARNING_ATTEMPT_SECONDS * NEW_LEARNING_RECALL_ATTEMPTS +
      STEP_OVERHEAD_SECONDS;
    const reviewSeconds = [...plan.weakItems, ...plan.reviewItems].reduce(
      (sum, e) => sum + attemptCostSeconds(e.suggestedMode) + STEP_OVERHEAD_SECONDS,
      0,
    );
    const drillSeconds = plan.confusionGroups.length * 2 * (attemptCostSeconds('full-ayah') + STEP_OVERHEAD_SECONDS);
    expect(plan.estimatedSeconds).toBe(reviewSeconds + expected + drillSeconds);
  });

  it('names only the confusion groups that actually appear today', () => {
    const plan = buildDailyPlan(input());
    expect(plan.confusionGroups).toEqual(['cg-user-112:4+2:255']);
    const none = buildDailyPlan({ ...input(), confusionGroups: [] });
    expect(none.confusionGroups).toEqual([]);
    expect(none.estimatedSeconds).toBeLessThan(plan.estimatedSeconds);
  });
});

describe('history assembly', () => {
  it('sorts attempts oldest first regardless of input order', () => {
    const input = scenario();
    const reversed: ReviewContextInput = { ...input, attempts: input.attempts!.slice().reverse() };
    const history = historyFor(reversed).get('i-over')!;
    expect(history.attempts.map((a: RecallAttempt) => a.id)).toEqual(['a1', 'a2']);
  });

  it('attaches a group through the item sequence, not just its own key', () => {
    const item = makeItem({ id: 'seq', verseKey: '112:1', sequence: ['112:1', '112:2', '112:3'] });
    const groups = [makeGroup({ verseKeys: ['112:3', '108:2'], confusionCount: 2 })];
    const history = historyFor({ nowIso: dayIso(30), items: [item], confusionGroups: groups }).get('seq')!;
    expect(history.groups).toHaveLength(1);
    expect(history.groups[0]!.id).toBe(groups[0]!.id);
    expect(groupsByItemId(groups, [item]).get('seq')).toHaveLength(1);
  });

  it('gives a fresh, independent history map per call', () => {
    const input = scenario();
    const first = historyFor(input);
    first.get('i-over')!.attempts.push(makeAttempt({ id: 'mut', itemId: 'i-over', verseKey: '2:255', startedAt: dayIso(31) }));
    expect(historyFor(input).get('i-over')!.attempts.map((a) => a.id)).toEqual(['a1', 'a2']);
  });
});
