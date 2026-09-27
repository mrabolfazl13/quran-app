/**
 * Stability, strength and band. The numbers asserted here are the documented
 * behaviour of the heuristic in `docs/review-algorithm.md`; they are engineering
 * targets, not research results.
 */

import { describe, expect, it } from 'vitest';
import {
  addDays,
  attemptIsSuccess,
  attemptToStabilityAttempt,
  bandFor,
  computeStability,
  decayFor,
  diffDays,
  intervalDaysFor,
  isOverdue,
  parseIso,
  roundScore,
} from '../../src/hifz/stability';
import { DECAY_FLOOR, DECAY_HALF_LIFE_DAYS } from '../../src/hifz/params';
import type { RecallAttempt } from '../../src/contracts/hifz';
import { makeAttempt } from './fixtures';

const START = '2026-01-01T00:00:00.000Z';
const day = (d: number) => addDays(START, d);

function history(points: readonly [number, number][]) {
  return points.map(([d, accuracy]) => ({
    at: day(d),
    accuracy,
    expectedWordCount: 10,
    correctWordCount: Math.round(accuracy * 10),
  }));
}

describe('date arithmetic is clock-free', () => {
  it('diffDays and addDays round-trip', () => {
    expect(diffDays(day(0), day(3))).toBeCloseTo(3, 6);
    expect(addDays(day(3), -3)).toBe(START);
    expect(parseIso(START)).toBe(Date.UTC(2026, 0, 1));
    expect(() => parseIso('not-a-date')).toThrow(/unparseable/);
  });

  it('diffDays never goes negative for a future-to-past query', () => {
    expect(diffDays(day(10), day(2))).toBe(0);
  });
});

describe('the simulated 30-day history', () => {
  const points: [number, number][] = [
    [1, 0.95],
    [3, 0.91],
    [7, 0.62],
    [14, 0.9],
    [30, 0.55],
  ];

  it('moves through the documented bands', () => {
    const seen: { day: number; band: string; stability: number }[] = [];
    for (let i = 1; i <= points.length; i += 1) {
      const slice = history(points.slice(0, i));
      const result = computeStability({ nowIso: day(points[i - 1]![0]), addedAt: day(0), attempts: slice });
      seen.push({ day: points[i - 1]![0], band: result.band, stability: result.stability });
    }
    expect(seen).toEqual([
      { day: 1, band: 'new', stability: 0.7747 },
      { day: 3, band: 'weak', stability: 0.8455 },
      { day: 7, band: 'weak', stability: 0.7312 },
      { day: 14, band: 'stable', stability: 0.778 },
      { day: 30, band: 'weak', stability: 0.7163 },
    ]);
  });

  it('the day-7 and day-30 lapses drag stability down, the recoveries lift it', () => {
    const at = (index: number) =>
      computeStability({
        nowIso: day(points[index]![0]),
        addedAt: day(0),
        attempts: history(points.slice(0, index + 1)),
      });
    expect(at(1).stability).toBeGreaterThan(at(2).stability);
    expect(at(3).stability).toBeGreaterThan(at(2).stability);
    expect(at(4).stability).toBeLessThan(at(3).stability);
    expect(at(4).band).toBe('weak');
  });

  it('exposes the component breakdown the UI explains with', () => {
    const result = computeStability({ nowIso: day(30), addedAt: day(0), attempts: history(points) });
    expect(result.recentAccuracy).toBeCloseTo(0.7299, 4);
    expect(result.errorRate).toBeCloseTo(0.2, 4);
    expect(result.consistency).toBeCloseTo(0.6671, 4);
    expect(result.attemptFactor).toBeCloseTo(1 - Math.exp(-5 / 5), 4);
    expect(result.elapsedDays).toBe(0);
    expect(result.decay).toBe(1);
    expect(result.breakdown['recent-accuracy']).toBeCloseTo(0.55 * 0.7299, 4);
    expect(Object.keys(result.breakdown).sort()).toEqual(
      ['attempts', 'consistency', 'decay', 'error-rate', 'recent-accuracy'].sort(),
    );
  });
});

describe('decay over elapsed days', () => {
  const points: [number, number][] = [
    [1, 0.95],
    [3, 0.91],
    [7, 0.62],
    [14, 0.9],
    [30, 0.55],
  ];
  const attempts = history(points);

  it('halves over one documented half-life', () => {
    expect(decayFor(0)).toBe(1);
    expect(decayFor(DECAY_HALF_LIFE_DAYS)).toBeCloseTo(0.5, 6);
    expect(decayFor(DECAY_HALF_LIFE_DAYS * 2)).toBeCloseTo(0.25, 6);
  });

  it('decays the same history day by day after the last practice', () => {
    const at = (d: number) =>
      computeStability({ nowIso: day(d), addedAt: day(0), lastReviewedAt: day(30), attempts });
    expect(at(31).stability).toBeCloseTo(0.6817, 4);
    expect(at(45).stability).toBeCloseTo(0.3409, 4);
    expect(at(60).stability).toBeCloseTo(0.1622, 4);
    expect(at(90).stability).toBeCloseTo(0.0367, 4);
    expect(at(45).band).toBe('unstable');
    expect(at(90).band).toBe('unstable');
    expect(at(90).stability).toBeLessThan(at(45).stability);
  });

  it('never claims total forgetting: the decay floor holds', () => {
    const far = computeStability({ nowIso: day(3650), addedAt: day(0), lastReviewedAt: day(30), attempts });
    expect(far.decay).toBeCloseTo(DECAY_FLOOR, 6);
    expect(far.stability).toBeGreaterThan(0);
  });
});

describe('bands', () => {
  it('a fresh item with no attempts is new and scores zero', () => {
    const result = computeStability({ nowIso: START, addedAt: START, attempts: [] });
    expect(result.band).toBe('new');
    expect(result.stability).toBe(0);
    expect(result.nextReviewAt).toBe(START);
    expect(result.intervalDays).toBe(0);
  });

  it('mastered needs stability, attempts, accuracy and a low error rate together', () => {
    const points: [number, number][] = Array.from({ length: 9 }, (_, i) => [i, 1]) as [number, number][];
    const attempts = history(points);
    const result = computeStability({ nowIso: day(8), addedAt: day(0), attempts });
    expect(result.band).toBe('mastered');
    expect(result.stability).toBeGreaterThanOrEqual(0.92);
    expect(result.attemptCount).toBe(9);
    const withASlip: [number, number][] = [...points.slice(0, 8), [8, 0.6]];
    const oneSlip = computeStability({ nowIso: day(8), addedAt: day(0), attempts: history(withASlip) });
    expect(oneSlip.band).toBe('stable');
    expect(oneSlip.errorRate).toBeGreaterThan(0.03);
  });

  it('two lucky recitations are not enough for stable', () => {
    const result = computeStability({
      nowIso: day(2),
      addedAt: day(0),
      attempts: history([
        [1, 1],
        [2, 1],
      ]),
    });
    expect(result.stability).toBeGreaterThan(0.75);
    expect(result.band).toBe('weak');
    expect(bandFor({ attemptCount: 3, stability: 0.9, recentAccuracy: 0.99, errorRate: 0 })).toBe('stable');
  });

  it('bandFor honours the documented floors', () => {
    expect(bandFor({ attemptCount: 1, stability: 1, recentAccuracy: 1, errorRate: 0 })).toBe('new');
    expect(bandFor({ attemptCount: 10, stability: 0.93, recentAccuracy: 0.96, errorRate: 0.01 })).toBe('mastered');
    expect(bandFor({ attemptCount: 2, stability: 0.99, recentAccuracy: 0.99, errorRate: 0 })).toBe('weak');
    expect(bandFor({ attemptCount: 4, stability: 0.5, recentAccuracy: 0.5, errorRate: 0.5 })).toBe('weak');
    expect(bandFor({ attemptCount: 4, stability: 0.3, recentAccuracy: 0.3, errorRate: 0.7 })).toBe('unstable');
  });
});

describe('overdue is a state, not a band', () => {
  it('a stable item past its due date stays stable and reports overdue', () => {
    const points: [number, number][] = Array.from({ length: 6 }, (_, i) => [i * 2, 0.97]) as [number, number][];
    const attempts = history(points);
    const result = computeStability({
      nowIso: day(30),
      addedAt: day(0),
      lastReviewedAt: day(28),
      storedNextReviewAt: day(29),
      attempts,
    });
    expect(result.band).toBe('stable');
    expect(result.isOverdue).toBe(true);
    expect(isOverdue(day(15), day(30))).toBe(true);
    expect(isOverdue(day(31), day(30))).toBe(false);
    expect(isOverdue(null, day(30))).toBe(false);
  });

  it('the same history decays out of the band without any date trick', () => {
    const points: [number, number][] = Array.from({ length: 6 }, (_, i) => [i * 2, 0.97]) as [number, number][];
    const attempts = history(points);
    const later = computeStability({
      nowIso: day(48),
      addedAt: day(0),
      lastReviewedAt: day(28),
      storedNextReviewAt: day(29),
      attempts,
    });
    expect(later.elapsedDays).toBeCloseTo(20, 6);
    expect(later.band).toBe('unstable');
    expect(later.isOverdue).toBe(true);
  });
});

describe('scheduling intervals', () => {
  it('grow with stability inside a band and cap at MAX_INTERVAL_DAYS', () => {
    expect(intervalDaysFor('new', 0.5)).toBe(0);
    expect(intervalDaysFor('unstable', 1)).toBe(2);
    expect(intervalDaysFor('weak', 1)).toBe(3);
    expect(intervalDaysFor('weak', 0)).toBe(1);
    expect(intervalDaysFor('stable', 1)).toBe(8);
    expect(intervalDaysFor('mastered', 1)).toBe(18);
    expect(intervalDaysFor('mastered', 0)).toBe(6);
  });

  it('a high-stability item gets a longer interval than a shaky one', () => {
    const points: [number, number][] = Array.from({ length: 10 }, (_, i) => [i, 1]) as [number, number][];
    const strong = computeStability({ nowIso: day(9), addedAt: day(0), attempts: history(points) });
    const shaky = computeStability({
      nowIso: day(9),
      addedAt: day(0),
      attempts: history(points.map(([d], i) => [d, i % 2 === 0 ? 1 : 0.4] as [number, number])),
    });
    expect(strong.band).toBe('mastered');
    expect(strong.intervalDays).toBeGreaterThan(shaky.intervalDays);
    expect(strong.nextReviewAt).toBe(addDays(day(9), strong.intervalDays));
  });
});

describe('attempt adaptation and helpers', () => {
  it('converts a stored RecallAttempt into a stability attempt', () => {
    const attempt: RecallAttempt = makeAttempt({
      id: 'a1',
      itemId: 'i-1',
      verseKey: '112:1',
      startedAt: day(1),
      completedAt: day(1),
      expectedWordCount: 4,
      correctWordCount: 3,
      accuracy: 0.75,
      errors: [
        { kind: 'correct', expectedPosition: 1, expected: 'قُلْ', actual: 'قُلْ', confusedWithVerseKey: null, segmentPosition: 0, explanation: '' },
        { kind: 'omission', expectedPosition: 2, expected: 'هُوَ', actual: null, confusedWithVerseKey: null, segmentPosition: 0, explanation: '' },
      ],
    });
    const converted = attemptToStabilityAttempt(attempt);
    expect(converted).toMatchObject({ at: day(1), accuracy: 0.75, expectedWordCount: 4, correctWordCount: 3 });
    expect(converted.errorKinds).toEqual(['omission']);
    expect(attemptIsSuccess(converted)).toBe(false);
    expect(attemptIsSuccess({ at: day(1), accuracy: 0.85 })).toBe(true);
  });

  it('more accurate history means higher stability', () => {
    const weak = computeStability({ nowIso: day(5), addedAt: day(0), attempts: history([[1, 0.5], [5, 0.55]]) });
    const strong = computeStability({ nowIso: day(5), addedAt: day(0), attempts: history([[1, 0.95], [5, 0.98]]) });
    expect(strong.stability).toBeGreaterThan(weak.stability);
    expect(strong.band).not.toBe('new');
    expect(weak.band).toBe('weak');
  });

  it('is deterministic and rounded for stable serialisation', () => {
    const points: [number, number][] = [
      [1, 0.9],
      [2, 0.4],
      [3, 0.8],
    ];
    const a = computeStability({ nowIso: day(3), addedAt: day(0), attempts: history(points) });
    const b = computeStability({ nowIso: day(3), addedAt: day(0), attempts: history(points) });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(roundScore(0.123456789)).toBe(0.1235);
  });
});
