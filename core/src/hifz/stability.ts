/**
 * Stability, strength and stability band from an item's attempt history.
 *
 * Engineering heuristic, not a scientific model: the weights below were chosen
 * to be bounded, monotone and explainable. They are NOT validated by memory
 * research (see docs/review-algorithm.md, "Status of these numbers").
 *
 * Pure and deterministic: `now` is always an argument, never a clock read, so a
 * Dart port produces the same numbers.
 */

import type { ErrorKind, RecallAttempt, RecallMode, StabilityBand } from '../contracts/hifz';
import {
  ATTEMPT_SATURATION,
  BAND_INTERVAL_DAYS,
  DECAY_FLOOR,
  DECAY_HALF_LIFE_DAYS,
  MASTERED_MAX_ERROR_RATE,
  MASTERED_MIN_ATTEMPTS,
  MASTERED_MIN_RECENT_ACCURACY,
  MASTERED_MIN_STABILITY,
  MAX_INTERVAL_DAYS,
  MS_PER_DAY,
  NEW_MAX_ATTEMPTS,
  RECENCY_WEIGHT_DECAY,
  RECENT_WINDOW,
  SCORE_DECIMALS,
  STABILITY_INTERVAL_GAIN,
  STABLE_MIN_ATTEMPTS,
  STABLE_MIN_STABILITY,
  SUCCESS_ACCURACY,
  WEAK_MIN_ATTEMPTS,
  WEAK_MIN_STABILITY,
  W_ATTEMPT_COUNT,
  W_CONSISTENCY,
  W_ERROR_RATE,
  W_RECENT_ACCURACY,
} from './params';

/** Parse an ISO timestamp without touching the system clock. */
export function parseIso(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`unparseable ISO timestamp: ${iso}`);
  return t;
}

/** Whole + fractional days from `fromIso` to `toIso` (never negative). */
export function diffDays(fromIso: string, toIso: string): number {
  return Math.max(0, (parseIso(toIso) - parseIso(fromIso)) / MS_PER_DAY);
}

/** `fromIso + days`, returned as an ISO string. Deterministic. */
export function addDays(fromIso: string, days: number): string {
  return new Date(parseIso(fromIso) + days * MS_PER_DAY).toISOString();
}

/** Round every emitted score so plans serialise identically everywhere. */
export function roundScore(value: number, decimals = SCORE_DECIMALS): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** A light attempt record; `RecallAttempt` adapts into it, tests can inline it. */
export interface StabilityAttempt {
  at: string;
  accuracy: number;
  expectedWordCount?: number;
  correctWordCount?: number;
  mode?: RecallMode;
  errorKinds?: ErrorKind[];
}

export interface StabilityInput {
  nowIso: string;
  addedAt: string;
  lastReviewedAt?: string | null;
  /** The item's stored due date; only used for the `isOverdue` state. */
  storedNextReviewAt?: string | null;
  attempts: readonly StabilityAttempt[];
}

export interface StabilityResult {
  /** 0..1 retrievable-now estimate: strength after retention decay. */
  stability: number;
  /** 0..1 stored-knowledge estimate before decay. */
  strength: number;
  band: StabilityBand;
  recentAccuracy: number;
  consistency: number;
  attemptFactor: number;
  /** Wrong expected words / expected words over all attempts. */
  errorRate: number;
  elapsedDays: number;
  decay: number;
  attemptCount: number;
  /** Review interval in whole days implied by band + stability. */
  intervalDays: number;
  /** When the item should come back, from `nowIso` + `intervalDays`. */
  nextReviewAt: string;
  /** True when the item's stored `nextReviewAt` is already past `nowIso`. */
  isOverdue: boolean;
  /** Component contributions, for the UI's "why" panel. */
  breakdown: Record<string, number>;
}

/** Adapt a stored `RecallAttempt` into a light stability input. */
export function attemptToStabilityAttempt(attempt: RecallAttempt): StabilityAttempt {
  const kinds = attempt.errors.filter((e) => e.kind !== 'correct').map((e) => e.kind);
  return {
    at: attempt.completedAt ?? attempt.startedAt,
    accuracy: attempt.accuracy,
    expectedWordCount: attempt.expectedWordCount,
    correctWordCount: attempt.correctWordCount,
    mode: attempt.mode,
    errorKinds: kinds,
  };
}

function sortByTime(attempts: readonly StabilityAttempt[]): StabilityAttempt[] {
  return attempts
    .map((attempt, index) => ({ attempt, index }))
    .sort((a, b) => parseIso(a.attempt.at) - parseIso(b.attempt.at) || a.index - b.index)
    .map((entry) => entry.attempt);
}

/** Weighted accuracy of the most recent attempts, newest weighted highest. */
export function recentAccuracy(attempts: readonly StabilityAttempt[]): number {
  if (attempts.length === 0) return 0;
  const newestFirst = attempts.slice().reverse().slice(0, RECENT_WINDOW);
  let weightSum = 0;
  let total = 0;
  newestFirst.forEach((attempt, distanceFromNewest) => {
    const weight = RECENCY_WEIGHT_DECAY ** distanceFromNewest;
    weightSum += weight;
    total += weight * clamp01(attempt.accuracy);
  });
  return weightSum === 0 ? 0 : total / weightSum;
}

/** 1 - normalised spread of the recent accuracies (1 = perfectly steady). */
export function consistencyOf(attempts: readonly StabilityAttempt[]): number {
  const window = attempts.slice(-RECENT_WINDOW).map((a) => clamp01(a.accuracy));
  if (window.length < 2) return window.length === 1 ? 0.5 : 0;
  const mean = window.reduce((s, x) => s + x, 0) / window.length;
  const variance = window.reduce((s, x) => s + (x - mean) ** 2, 0) / window.length;
  const stddev = Math.sqrt(variance);
  // 0.5 is the maximum possible stddev for values in 0..1.
  return clamp01(1 - stddev / 0.5);
}

/** Wrong expected words over all attempts, 0..1. */
export function errorRateOf(attempts: readonly StabilityAttempt[]): number {
  let expected = 0;
  let wrong = 0;
  for (const a of attempts) {
    const words = a.expectedWordCount ?? 0;
    if (words > 0) {
      expected += words;
      wrong += Math.max(0, words - (a.correctWordCount ?? Math.round(a.accuracy * words)));
    } else {
      expected += 1;
      wrong += a.accuracy >= 1 ? 0 : 1;
    }
  }
  return expected === 0 ? 0 : clamp01(wrong / expected);
}

/** Saturing attempt-count component. */
export function attemptFactorOf(attemptCount: number): number {
  return clamp01(1 - Math.exp(-attemptCount / ATTEMPT_SATURATION));
}

/** Retention multiplier for `elapsedDays` without practice. */
export function decayFor(elapsedDays: number): number {
  const raw = 0.5 ** (elapsedDays / DECAY_HALF_LIFE_DAYS);
  return Math.max(DECAY_FLOOR, raw);
}

/**
 * Band from stability + history. Order matters: an item with almost no
 * attempts is `new` regardless of a lucky first recitation.
 */
export function bandFor(input: {
  attemptCount: number;
  stability: number;
  recentAccuracy: number;
  errorRate: number;
}): StabilityBand {
  if (input.attemptCount < NEW_MAX_ATTEMPTS) return 'new';
  if (
    input.stability >= MASTERED_MIN_STABILITY &&
    input.attemptCount >= MASTERED_MIN_ATTEMPTS &&
    input.recentAccuracy >= MASTERED_MIN_RECENT_ACCURACY &&
    input.errorRate <= MASTERED_MAX_ERROR_RATE
  ) {
    return 'mastered';
  }
  if (input.stability >= STABLE_MIN_STABILITY && input.attemptCount >= STABLE_MIN_ATTEMPTS) return 'stable';
  if (input.stability >= WEAK_MIN_STABILITY && input.attemptCount >= WEAK_MIN_ATTEMPTS) return 'weak';
  return 'unstable';
}

/** Days until the next review for a band, scaled by current stability. */
export function intervalDaysFor(band: StabilityBand, stability: number): number {
  const base = BAND_INTERVAL_DAYS[band] ?? 1;
  const scaled = base * (0.5 + STABILITY_INTERVAL_GAIN * clamp01(stability));
  return Math.min(MAX_INTERVAL_DAYS, Math.max(0, Math.round(scaled)));
}

/** The whole stability computation for one item. */
export function computeStability(input: StabilityInput): StabilityResult {
  const attempts = sortByTime(input.attempts);
  const attemptCount = attempts.length;
  const accuracy = recentAccuracy(attempts);
  const consistency = consistencyOf(attempts);
  const attemptFactor = attemptFactorOf(attemptCount);
  const errorRate = errorRateOf(attempts);

  const strength = clamp01(
    W_RECENT_ACCURACY * accuracy +
      W_CONSISTENCY * consistency +
      W_ATTEMPT_COUNT * attemptFactor +
      W_ERROR_RATE * (1 - errorRate),
  );

  const anchor = input.lastReviewedAt ?? (attemptCount > 0 ? attempts[attemptCount - 1]!.at : input.addedAt);
  const elapsedDays = diffDays(anchor, input.nowIso);
  const decay = attemptCount === 0 ? 1 : decayFor(elapsedDays);
  const stability = attemptCount === 0 ? 0 : clamp01(strength * decay);
  const band = bandFor({ attemptCount, stability, recentAccuracy: accuracy, errorRate });
  const intervalDays = intervalDaysFor(band, stability);
  const nextReviewAt = attemptCount === 0 ? input.nowIso : addDays(input.nowIso, intervalDays);

  return {
    stability: roundScore(stability),
    strength: roundScore(strength),
    band,
    recentAccuracy: roundScore(accuracy),
    consistency: roundScore(consistency),
    attemptFactor: roundScore(attemptFactor),
    errorRate: roundScore(errorRate),
    elapsedDays: roundScore(elapsedDays, 3),
    decay: roundScore(decay),
    attemptCount,
    intervalDays,
    nextReviewAt,
    isOverdue: isOverdue(input.storedNextReviewAt ?? null, input.nowIso),
    breakdown: {
      'recent-accuracy': roundScore(W_RECENT_ACCURACY * accuracy),
      consistency: roundScore(W_CONSISTENCY * consistency),
      attempts: roundScore(W_ATTEMPT_COUNT * attemptFactor),
      'error-rate': roundScore(W_ERROR_RATE * (1 - errorRate)),
      decay: roundScore(decay),
    },
  };
}

/**
 * Overdue is a *state*, not a band: it only exists relative to a stored
 * `nextReviewAt` and the moment you ask about.
 */
export function isOverdue(nextReviewAt: string | null, nowIso: string): boolean {
  if (!nextReviewAt) return false;
  return parseIso(nextReviewAt) < parseIso(nowIso);
}

/** True when the attempt counts as a success everywhere in the engine. */
export function attemptIsSuccess(attempt: StabilityAttempt): boolean {
  return attempt.accuracy >= SUCCESS_ACCURACY;
}
