/**
 * Confusion groups: the learner's own groups, and the groups the engine is
 * allowed to propose from real cross-ayah substitutions.
 */

import { describe, expect, it } from 'vitest';
import {
  CONFUSION_ERROR_KINDS,
  boostForVerseKey,
  confusionTally,
  createUserGroup,
  groupIdFor,
  groupBoost,
  groupsForVerseKey,
  mergeGroups,
  proposeGroups,
  shouldReviewTogether,
  withTrigger,
} from '../../src/hifz/confusion';
import {
  GROUP_BOOST_CAP,
  GROUP_BOOST_PER_TRIGGER,
  GROUP_CONFUSION_SATURATION,
  PROPOSE_MIN_TRIGGERS,
} from '../../src/hifz/params';
import { classifyRecitation } from '../../src/hifz/classify';
import { ayahText, dayIso, makeAttempt, makeGroup } from './fixtures';
import { tokenizeWords } from '../../src/normalize/arabic';
import type { ErrorKind, RecallAttempt } from '../../src/contracts/hifz';
import type { VerseKey } from '../../src/contracts/quran';

const words = (key: VerseKey) => tokenizeWords(ayahText(key));

/** A confusion event: `verseKey` was recited and `partner` came out. */
function confusionEvent(
  id: string,
  verseKey: string,
  partner: string,
  at: number,
  kind: ErrorKind = 'similar-ayah-confusion',
): RecallAttempt {
  return makeAttempt({
    id,
    itemId: `i-${verseKey}`,
    verseKey,
    startedAt: dayIso(at),
    completedAt: dayIso(at, 1),
    expectedWordCount: 4,
    correctWordCount: 1,
    errors: [{
      kind,
      expectedPosition: 1,
      expected: null,
      actual: null,
      confusedWithVerseKey: partner,
      segmentPosition: null,
      explanation: 'fixture',
    }],
  });
}

describe('user groups', () => {
  it('de-duplicate and sort members and get a deterministic id', () => {
    const group = createUserGroup({ verseKeys: ['112:4', '112:3', '112:4'], createdAt: dayIso(2) });
    expect(group.verseKeys).toEqual(['112:3', '112:4']);
    expect(group.id).toBe('cg-user-112:3+112:4');
    expect(group.origin).toBe('user');
    expect(group.label).toBeNull();
    expect(group.confusionCount).toBe(0);
    expect(group.lastTriggeredAt).toBeNull();
    expect(group.createdAt).toBe(dayIso(2));
  });

  it('keep an explicit id and label when the caller supplies them', () => {
    const group = createUserGroup({
      verseKeys: ['108:1', '1:7'],
      label: 'آیاتی که قاطی می‌کنم',
      createdAt: dayIso(0),
      id: 'mine-1',
    });
    expect(group.id).toBe('mine-1');
    expect(group.label).toBe('آیاتی که قاطی می‌کنم');
  });

  it('refuse a group that is not actually a group', () => {
    expect(() => createUserGroup({ verseKeys: ['112:1'], createdAt: dayIso(0) })).toThrow(/at least two/);
    expect(() => createUserGroup({ verseKeys: ['112:1', '112:1'], createdAt: dayIso(0) })).toThrow(/at least two/);
    expect(() => createUserGroup({ verseKeys: [], createdAt: dayIso(0) })).toThrow(/at least two/);
  });

  it('hash the id independently of the order members were typed in', () => {
    expect(groupIdFor(['112:4', '112:3'], 'engine')).toBe(groupIdFor(['112:3', '112:4'], 'engine'));
    expect(groupIdFor(['112:3', '112:4'], 'user')).not.toBe(groupIdFor(['112:3', '112:4'], 'engine'));
  });
});

describe('confusion tally', () => {
  it('counts each unordered ayah pair and remembers the latest event', () => {
    const tally = confusionTally([
      confusionEvent('e1', '112:3', '112:4', 1),
      confusionEvent('e2', '112:4', '112:3', 3, 'wrong-transition'),
      confusionEvent('e3', '112:3', '112:4', 2),
      confusionEvent('e4', '108:1', '108:3', 5),
    ]);
    expect(tally).toEqual([
      { verseKeyA: '112:3', verseKeyB: '112:4', count: 3, lastAt: dayIso(3, 1) },
      { verseKeyA: '108:1', verseKeyB: '108:3', count: 1, lastAt: dayIso(5, 1) },
    ]);
  });

  it('ignores events that name no partner, or only themselves', () => {
    const tally = confusionTally([
      confusionEvent('e1', '112:3', '112:3', 1),
      makeAttempt({
        id: 'e2',
        itemId: 'i-112:3',
        verseKey: '112:3',
        startedAt: dayIso(2),
        errors: [{ kind: 'wrong-transition', expectedPosition: 2, expected: null, actual: null, confusedWithVerseKey: null, segmentPosition: null, explanation: 'fixture' }],
      }),
    ]);
    expect(tally).toEqual([]);
  });

  it('only counts the confusion kinds', () => {
    expect(CONFUSION_ERROR_KINDS).toEqual(['similar-ayah-confusion', 'wrong-transition']);
    const noisy = confusionTally([
      confusionEvent('e1', '112:3', '112:4', 1, 'omission'),
      confusionEvent('e2', '112:3', '112:4', 2, 'substitution'),
    ]);
    expect(noisy).toEqual([]);
    const widened = confusionTally([confusionEvent('e3', '112:3', '112:4', 1, 'omission')], ['omission']);
    expect(widened[0]!.count).toBe(1);
  });

  it('falls back to startedAt when an attempt never completed', () => {
    const open = makeAttempt({ id: 'o', itemId: 'i', verseKey: '112:3', startedAt: dayIso(4), completedAt: null, errors: [{ kind: 'similar-ayah-confusion', expectedPosition: 1, expected: null, actual: null, confusedWithVerseKey: '112:4', segmentPosition: null, explanation: 'fixture' }] });
    expect(confusionTally([open])[0]!.lastAt).toBe(dayIso(4));
  });

  it('builds a tally out of real mis-recitation, not hand-written errors', () => {
    const attempts = [1, 2].map((n) => {
      const result = classifyRecitation({
        expected: words('112:4'),
        produced: words('112:3'),
        verseKey: '112:4',
        itemId: 'i-112:4',
        confusionCandidates: [{ verseKey: '112:3', words: words('112:3') }],
      });
      return makeAttempt({
        id: `real-${n}`,
        itemId: 'i-112:4',
        verseKey: '112:4',
        startedAt: dayIso(n),
        completedAt: dayIso(n, 1),
        expectedWordCount: result.expectedWordCount,
        correctWordCount: result.correctWordCount,
        accuracy: result.accuracy,
        errors: result.errors,
      });
    });
    expect(attempts[0]!.errors.some((e) => e.kind === 'similar-ayah-confusion')).toBe(true);
    expect(confusionTally(attempts)).toEqual([
      { verseKeyA: '112:3', verseKeyB: '112:4', count: 2, lastAt: dayIso(2, 1) },
    ]);
    expect(proposeGroups({ attempts, createdAt: dayIso(9) })[0]!.verseKeys).toEqual(['112:3', '112:4']);
  });
});

describe('engine proposals', () => {
  it('stay silent until the substitutions repeat', () => {
    const single = [confusionEvent('e1', '112:3', '112:4', 1)];
    expect(proposeGroups({ attempts: single, createdAt: dayIso(9) })).toEqual([]);
    expect(proposeGroups({ attempts: [confusionEvent('e1', '112:3', '112:4', 1), confusionEvent('e2', '112:3', '112:4', 2)], createdAt: dayIso(9) })).toHaveLength(1);
    expect(proposeGroups({ attempts: single, createdAt: dayIso(9), minTriggers: 1 })).toHaveLength(1);
  });

  it('use the documented threshold constant', () => {
    expect(PROPOSE_MIN_TRIGGERS).toBe(2);
  });

  it('merge overlapping pairs into one group instead of two', () => {
    const attempts = [
      confusionEvent('e1', '112:3', '112:4', 1),
      confusionEvent('e2', '112:4', '112:3', 2),
      confusionEvent('e3', '112:4', '112:2', 3),
      confusionEvent('e4', '112:2', '112:4', 4),
      confusionEvent('e5', '108:1', '108:3', 5),
      confusionEvent('e6', '108:3', '108:1', 6),
    ];
    const groups = proposeGroups({ attempts, createdAt: dayIso(9) });
    expect(groups).toHaveLength(2);
    const trio = groups.find((g) => g.verseKeys.length === 3)!;
    const pair = groups.find((g) => g.verseKeys.length === 2)!;
    expect(trio.verseKeys).toEqual(['112:2', '112:3', '112:4']);
    expect(trio.origin).toBe('engine');
    expect(trio.label).toBeNull();
    expect(trio.confusionCount).toBe(4);
    expect(trio.lastTriggeredAt).toBe(dayIso(4, 1));
    expect(trio.createdAt).toBe(dayIso(9));
    expect(pair.verseKeys).toEqual(['108:1', '108:3']);
    expect(pair.confusionCount).toBe(2);
    expect(groups.map((g) => g.id)).toEqual(['cg-engine-108:1+108:3', 'cg-engine-112:2+112:3+112:4']);
  });

  it('skip a component the learner already grouped themselves', () => {
    const attempts = [
      confusionEvent('e1', '112:3', '112:4', 1),
      confusionEvent('e2', '112:4', '112:3', 2),
    ];
    const existing = [createUserGroup({ verseKeys: ['112:3', '112:4'], createdAt: dayIso(0) })];
    expect(proposeGroups({ attempts, createdAt: dayIso(9), existing })).toEqual([]);
    const partial = [createUserGroup({ verseKeys: ['112:3', '112:4', '112:2'], createdAt: dayIso(0) })];
    expect(proposeGroups({ attempts, createdAt: dayIso(9), existing: partial })).toEqual([]);
    const unrelated = [createUserGroup({ verseKeys: ['1:1', '1:2'], createdAt: dayIso(0) })];
    expect(proposeGroups({ attempts, createdAt: dayIso(9), existing: unrelated })).toHaveLength(1);
  });

  it('are byte-identical for the same history', () => {
    const attempts = [
      confusionEvent('e1', '112:3', '112:4', 1),
      confusionEvent('e2', '112:4', '112:3', 2),
      confusionEvent('e3', '108:1', '108:3', 3),
      confusionEvent('e4', '108:3', '108:1', 4),
    ];
    const first = JSON.stringify(proposeGroups({ attempts, createdAt: dayIso(9) }));
    const second = JSON.stringify(proposeGroups({ attempts: attempts.slice().reverse(), createdAt: dayIso(9) }));
    expect(first).toBe(second);
  });
});

describe('merging groups', () => {
  it('lets the learner label win over the engine proposal', () => {
    const merged = mergeGroups([
      makeGroup({ id: 'cg-engine', verseKeys: ['112:3', '112:4'], origin: 'engine', confusionCount: 2, createdAt: dayIso(4), lastTriggeredAt: dayIso(4) }),
      makeGroup({ id: 'cg-user', verseKeys: ['112:4', '112:3'], confusionCount: 1, label: 'قَلْ هُوَ ٱللَّهُ أَحَدٌ', createdAt: dayIso(0), lastTriggeredAt: dayIso(6) }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe('cg-user');
    expect(merged[0]!.origin).toBe('user');
    expect(merged[0]!.label).toBe('قَلْ هُوَ ٱللَّهُ أَحَدٌ');
    expect(merged[0]!.confusionCount).toBe(3);
    expect(merged[0]!.createdAt).toBe(dayIso(0));
    expect(merged[0]!.lastTriggeredAt).toBe(dayIso(6));
  });

  it('keeps distinct member sets apart and sorts its output', () => {
    const merged = mergeGroups([
      makeGroup({ id: 'b', verseKeys: ['1:5', '1:6'] }),
      makeGroup({ id: 'a', verseKeys: ['112:3', '112:4'] }),
    ]);
    expect(merged.map((g) => g.id)).toEqual(['a', 'b']);
    expect(merged).toHaveLength(2);
  });

  it('does not mutate the groups it merges', () => {
    const engine = makeGroup({ id: 'e', verseKeys: ['112:4', '112:3'], origin: 'engine', confusionCount: 2 });
    const user = makeGroup({ id: 'u', verseKeys: ['112:3', '112:4'], confusionCount: 1 });
    const snapshot = JSON.stringify([engine, user]);
    mergeGroups([engine, user]);
    expect(JSON.stringify([engine, user])).toBe(snapshot);
  });
});

describe('trigger bookkeeping', () => {
  it('records a trigger without mutating the stored group', () => {
    const group = makeGroup({ verseKeys: ['112:3', '112:4'], confusionCount: 1 });
    const next = withTrigger(group, dayIso(9));
    expect(next.confusionCount).toBe(2);
    expect(next.lastTriggeredAt).toBe(dayIso(9));
    expect(group.confusionCount).toBe(1);
    expect(group.lastTriggeredAt).toBeNull();
    expect(next.id).toBe(group.id);
    expect(next.origin).toBe('user');
  });

  it('starts counting from zero for a fresh user group', () => {
    const group = createUserGroup({ verseKeys: ['1:6', '1:7'], createdAt: dayIso(0) });
    expect(withTrigger(group, dayIso(1)).confusionCount).toBe(1);
  });
});

describe('boost', () => {
  it('is proportional to triggers, saturates, and is capped', () => {
    expect(groupBoost(makeGroup({ verseKeys: ['1:1', '1:2'], confusionCount: 0 }))).toBe(0);
    expect(groupBoost(makeGroup({ verseKeys: ['1:1', '1:2'], confusionCount: 1 }))).toBeCloseTo(GROUP_BOOST_PER_TRIGGER, 10);
    expect(groupBoost(makeGroup({ verseKeys: ['1:1', '1:2'], confusionCount: GROUP_CONFUSION_SATURATION }))).toBeCloseTo(
      GROUP_BOOST_PER_TRIGGER * GROUP_CONFUSION_SATURATION,
      10,
    );
    expect(groupBoost(makeGroup({ verseKeys: ['1:1', '1:2'], confusionCount: 1000 }))).toBeCloseTo(
      Math.min(GROUP_BOOST_CAP, GROUP_BOOST_PER_TRIGGER * GROUP_CONFUSION_SATURATION),
      10,
    );
    expect(GROUP_BOOST_CAP).toBeGreaterThanOrEqual(GROUP_BOOST_PER_TRIGGER * GROUP_CONFUSION_SATURATION);
  });

  it('finds the groups an ayah belongs to, and the strongest boost', () => {
    const pair = makeGroup({ id: 'g1', verseKeys: ['112:3', '112:4'], confusionCount: 1 });
    const trio = makeGroup({ id: 'g2', verseKeys: ['112:4', '112:1', '108:1'], confusionCount: GROUP_CONFUSION_SATURATION });
    const groups = [pair, trio];
    expect(groupsForVerseKey(groups, '112:4').map((g) => g.id)).toEqual(['g1', 'g2']);
    expect(groupsForVerseKey(groups, '1:1')).toEqual([]);
    expect(boostForVerseKey(groups, '112:3')).toBeCloseTo(groupBoost(pair), 10);
    expect(boostForVerseKey(groups, '112:4')).toBeCloseTo(groupBoost(trio), 10);
    expect(boostForVerseKey(groups, '2:255')).toBe(0);
  });

  it('says whether two groups have to be drilled together', () => {
    const a = makeGroup({ id: 'a', verseKeys: ['112:3', '112:4'] });
    const sharing = makeGroup({ id: 'b', verseKeys: ['112:4', '108:1'] });
    const disjoint = makeGroup({ id: 'c', verseKeys: ['1:1', '1:2'] });
    expect(shouldReviewTogether(a, sharing)).toBe(true);
    expect(shouldReviewTogether(a, disjoint)).toBe(false);
    expect(shouldReviewTogether(a, a)).toBe(false);
  });
});
