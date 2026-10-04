/**
 * Stability, strength and stability band from an item's attempt history.
 *
 * Engineering heuristic, not a scientific model: the weights below were chosen
 * to be bounded, monotone and explainable. They are NOT validated by memory
 * research (see docs/review-algorithm.md, "Status of these numbers").
 *
 * Pure and deterministic: `now` is always an argument, never a clock read, so a
 * Dart port produces the same numbers.
 *
 * Two axes are maintained, because they are two memories: `formStability` from
 * Arabic-cued-by-Arabic attempts, `meaningStability` from meaning-cued attempts.
 * `computeStability` scores one history; `computeStabilityByAxis` scores both and
 * publishes the weaker as the composite. See `RECALL_DIMENSION` in the contracts
 * for why a meaning recitation may never lift the form number.
 */

import type {
  DetectedError,
  ErrorKind,
  HifzSegment,
  HifzTransition,
  RecallAttempt,
  RecallDimension,
  RecallMode,
  StabilityBand,
} from '../contracts/hifz';
import { RECALL_DIMENSION } from '../contracts/hifz';
import {
  ATTEMPT_SATURATION,
  AXIS_LEARN_RATE,
  AXIS_UNTESTED_STABILITY,
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
  SEGMENT_MEANING_BASE,
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
  /**
   * Which axis this attempt scored. `mode` wins when a mode is present, because
   * the axis is a property of the probe, not of the caller's memory of it.
   * Attempts with neither are treated as form work — that is every history
   * recorded before the meaning axis existed.
   */
  dimension?: RecallDimension;
}

export interface StabilityInput {
  nowIso: string;
  addedAt: string;
  lastReviewedAt?: string | null;
  /** The item's stored due date; only used for the `isOverdue` state. */
  storedNextReviewAt?: string | null;
  attempts: readonly StabilityAttempt[];
  /**
   * The item's stored axis numbers, consulted only for an axis this history has
   * no attempts for at all.
   *
   * Without it a caller that hands over a partial history — a session that only
   * touched the form axis, a recompute from a page of attempts — would return
   * `meaningStability: null` (or a form number of 0) and the persist path would
   * erase a number the learner earned. No evidence about an axis is not evidence
   * of nothing: the stored value carries forward unchanged.
   */
  storedAxes?: AxisStabilities | null;
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
    dimension: attemptDimension(attempt),
    errorKinds: kinds,
  };
}

/**
 * The axis an attempt belongs to.
 *
 * The mode decides it (`RECALL_DIMENSION`), so a caller cannot relabel a meaning
 * drill as verbatim recall; the stored `dimension` is only consulted for a row
 * whose mode the mode table has never heard of.
 */
export function attemptDimension(
  attempt: { mode?: RecallMode; dimension?: RecallDimension },
): RecallDimension {
  if (attempt.mode && attempt.mode in RECALL_DIMENSION) return RECALL_DIMENSION[attempt.mode];
  return attempt.dimension ?? 'form';
}

/** Split a history into the two axes it was recorded on, oldest first untouched. */
export function partitionAttemptsByDimension(
  attempts: readonly StabilityAttempt[],
): Record<RecallDimension, StabilityAttempt[]> {
  const out: Record<RecallDimension, StabilityAttempt[]> = { form: [], meaning: [] };
  for (const attempt of attempts) out[attemptDimension(attempt)].push(attempt);
  return out;
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

/* ------------------------------------------------------------------ *
 * Two axes: form (sound-shape) and meaning (sense)
 * ------------------------------------------------------------------ */

/** The two memory axes, in the order every report lists them. */
export const RECALL_DIMENSIONS: readonly RecallDimension[] = ['form', 'meaning'];

/** The two stored axis numbers of an item, exactly as `hifz_item` keeps them. */
export interface AxisStabilities {
  formStability: number;
  /** Null until a meaning attempt exists — "never tested", not "tested and failed". */
  meaningStability: number | null;
}

export interface DualAxisStability {
  /** Verbatim recall, computed over the `form` attempts only. */
  form: StabilityResult;
  /** Conceptual recall, computed over the `meaning` attempts only. */
  meaning: StabilityResult;
  /** Form axis number: recomputed, or the stored value when this history has no form attempts. */
  formStability: number;
  /**
   * Meaning axis number. Null only when this history has no meaning attempts
   * *and* no stored value was supplied — "never tested" stays distinguishable
   * from "tested and failed" either way.
   */
  meaningStability: number | null;
  /**
   * Composite the band is read from: the **weaker** of the two axes.
   *
   * Not an average and not the form number. An ayah whose sound-shape is perfect
   * and whose meaning is blank is recited, not memorised, so the composite can
   * never read better than either axis. An axis that has never been tested at all
   * is `null` and stands out of the minimum: dropping an item to zero for a probe
   * the learner was never offered would be a number invented in the other
   * direction.
   */
  stability: number;
  /** Band of the composite, read from the axis that produced it. */
  band: StabilityBand;
  /** The axis the composite is currently reading from. */
  limitingAxis: RecallDimension;
  /** How far the meaning axis lags the form axis; 0 while meaning is untested. */
  gap: number;
  /** Scheduling fields of the limiting axis, so an item never gets the longer
   * interval of the axis that is not its weak point. */
  intervalDays: number;
  nextReviewAt: string;
}

/**
 * The weaker of the two axes. An untested meaning axis (`null`) is not a weak
 * one, so the form axis stands alone until a meaning attempt lands.
 */
export function compositeStability(formStability: number, meaningStability: number | null): number {
  const form = clamp01(formStability);
  return meaningStability === null ? form : Math.min(form, clamp01(meaningStability));
}

/** Which axis is holding the composite down. Ties go to `form`, the stricter reading. */
export function limitingAxisOf(
  formStability: number,
  meaningStability: number | null,
): RecallDimension {
  return meaningStability !== null && clamp01(meaningStability) < clamp01(formStability)
    ? 'meaning'
    : 'form';
}

/**
 * Whole dual-axis computation for one item: the same documented heuristic run
 * separately over each axis's attempts, then combined by the weaker link.
 *
 * `computeStability` stays the single-history function it always was — a caller
 * that only has one axis's data keeps using it unchanged.
 */
export function computeStabilityByAxis(input: StabilityInput): DualAxisStability {
  const byAxis = partitionAttemptsByDimension(input.attempts);
  const form = computeStability({ ...input, attempts: byAxis.form });
  const meaning = computeStability({ ...input, attempts: byAxis.meaning });
  const stored = input.storedAxes ?? null;
  // An axis this history never touched keeps what the store already says about
  // it: no attempts here is not evidence of forgetting, and a caller that hands
  // over a partial history must not be able to wipe the other axis.
  const formStability = byAxis.form.length === 0 && stored ? clamp01(stored.formStability) : form.stability;
  const meaningStability = byAxis.meaning.length === 0 ? (stored ? stored.meaningStability : null) : meaning.stability;
  const stability = compositeStability(formStability, meaningStability);
  const limiting = limitingAxisOf(formStability, meaningStability);
  // Scheduling is read from an axis that has data in *this* history: an axis
  // carried over from the store has no fresh attempts behind a band or interval.
  const limitingHasData = limiting === 'meaning' ? byAxis.meaning.length > 0 : byAxis.form.length > 0;
  const limitingResult = limitingHasData
    ? limiting === 'meaning'
      ? meaning
      : form
    : byAxis.form.length > 0
      ? form
      : meaning;
  return {
    form,
    meaning,
    formStability: roundScore(formStability),
    meaningStability,
    stability,
    band: limitingResult.band,
    limitingAxis: limiting,
    gap: roundScore(
      Math.max(0, formStability - (meaningStability ?? formStability)),
    ),
    intervalDays: limitingResult.intervalDays,
    nextReviewAt: limitingResult.nextReviewAt,
  };
}

export interface AxisUpdateResult extends AxisStabilities {
  /** Which axis the attempt was graded on. */
  dimension: RecallDimension;
  /** Weaker-of-the-two composite, ready to persist as `hifz_item.stability`. */
  stability: number;
  limitingAxis: RecallDimension;
}

/**
 * Incremental EWMA update of one item's axes from a single graded attempt.
 *
 * Only the axis the attempt scored moves, and it moves toward that attempt's
 * accuracy by `AXIS_LEARN_RATE` of the remaining distance — bounded in 0..1 and
 * monotone in the accuracy, like every other number here. The other axis is
 * returned untouched, which is the entire reason the two are stored separately:
 * a flawless meaning recitation must never be allowed to look like verbatim
 * recall, and a flawless recitation must never be allowed to look like
 * understanding.
 */
export function applyAttemptToAxes(
  current: AxisStabilities,
  attempt: { accuracy: number; mode?: RecallMode; dimension?: RecallDimension },
  rate = AXIS_LEARN_RATE,
): AxisUpdateResult {
  const dimension = attemptDimension(attempt);
  const target = clamp01(attempt.accuracy);
  const advance = (value: number | null): number => {
    const base = value === null ? AXIS_UNTESTED_STABILITY : clamp01(value);
    return roundScore(clamp01(base + rate * (target - base)));
  };
  const next: AxisStabilities =
    dimension === 'meaning'
      ? { formStability: roundScore(clamp01(current.formStability)), meaningStability: advance(current.meaningStability) }
      : { formStability: advance(current.formStability), meaningStability: current.meaningStability };
  return {
    ...next,
    dimension,
    stability: compositeStability(next.formStability, next.meaningStability),
    limitingAxis: limitingAxisOf(next.formStability, next.meaningStability),
  };
}

/**
 * Per-chunk update of a segment's two axes from one graded recitation of that
 * chunk. `meaningStability` starts as null ("never tested"), and the first
 * meaning attempt measures itself against `SEGMENT_MEANING_BASE`, not against an
 * accidental row default.
 */
export function applyAttemptToSegment(
  segment: HifzSegment,
  attempt: { accuracy: number; mode?: RecallMode; dimension?: RecallDimension },
  rate = AXIS_LEARN_RATE,
): Pick<HifzSegment, 'stability' | 'meaningStability'> {
  const dimension = attemptDimension(attempt);
  const target = clamp01(attempt.accuracy);
  const advance = (value: number | null): number =>
    roundScore(clamp01((value ?? SEGMENT_MEANING_BASE) + rate * (target - (value ?? SEGMENT_MEANING_BASE))));
  return dimension === 'meaning'
    ? {
        stability: segment.stability,
        meaningStability: advance(segment.meaningStability),
      }
    : { stability: advance(segment.stability), meaningStability: segment.meaningStability };
}

/**
 * The part of a graded attempt the stored fingerprint is updated from.
 *
 * It is a *view*, not a new row type: `RecallAttempt` keeps what the learner did,
 * while the span below is what the engine asked for. The two differ — a
 * continue-ayah step is graded over the tail it was handed — and the span only
 * exists at grading time, so it is passed in rather than stored. No schema change
 * is justified by a number the fingerprint can only learn once.
 */
export interface FingerprintAttemptView {
  /**
   * The memory track the recitation belongs to. A stored chunk is addressed by
   * `(item, verse, position)` — that is its UNIQUE key — and two items can hold
   * the same ayah (a dropped track and the fresh one enrolled in its place), so
   * the ayah alone cannot say whose memory an attempt is evidence for.
   */
  itemId: string;
  verseKey: string;
  mode: RecallMode;
  accuracy: number;
  /**
   * The 1-based word range inside `verseKey` the recitation was graded over, or
   * null when the whole ayah was recited. It decides which chunks move.
   */
  span: { fromWord: number; toWord: number } | null;
  /** The classifier's errors, whose `segmentPosition` already names the chunk each landed in. */
  errors: readonly Pick<DetectedError, 'kind' | 'expectedPosition' | 'segmentPosition'>[];
  /** `RecallAttempt.completedAt`, stored as the rows' `lastPracticedAt`. */
  at: string | null;
}

/**
 * Which stored chunks a recitation grades, and what it does to them.
 *
 * A chunk moves only when the span covers it **entirely**. That is the whole
 * rule, and its reason is the one thing the fingerprint exists for: a chunk's
 * number has to mean "this learner can produce this chunk". A continue-ayah step
 * graded over words 4–7 of a 7-word ayah says nothing about the chunk 1–5, so
 * that chunk keeps its previous number instead of being flattered or punished by
 * a recitation that never asked for it. A null span is a full-ayah recitation,
 * which does cover every chunk of that ayah.
 *
 * `errorCount` is the one field that is not an axis score: it counts the errors
 * the classifier already attributed to this chunk (`segmentPosition`), on either
 * axis. A meaning drill that stumbles over the words still stumbled over the
 * words — but it moves `meaningStability`, never `stability`, which is the
 * separation `RECALL_DIMENSION` exists to protect.
 *
 * Rows of another track, of another ayah, or of a chunk the span does not fully
 * cover come back unchanged and in the order they arrived, so the caller can
 * persist the array it was handed without re-sorting or re-keying anything.
 */
export function applyAttemptToStoredSegments(
  segments: readonly HifzSegment[],
  attempt: FingerprintAttemptView,
  rate = AXIS_LEARN_RATE,
): HifzSegment[] {
  return segments.map((segment) => {
    if (segment.itemId !== attempt.itemId || segment.verseKey !== attempt.verseKey) return segment;
    const covered =
      attempt.span === null ||
      (segment.fromWord >= attempt.span.fromWord && segment.toWord <= attempt.span.toWord);
    if (!covered) return segment;
    const axes = applyAttemptToSegment(segment, attempt, rate);
    const landed = attempt.errors.filter((error) => error.segmentPosition === segment.position).length;
    if (axes.stability === segment.stability && axes.meaningStability === segment.meaningStability && landed === 0) {
      return segment;
    }
    return { ...segment, ...axes, errorCount: segment.errorCount + landed };
  });
}

/**
 * What one recitation does to the hinges of the fingerprint.
 *
 * A transition row is the boundary *into* a word (`toWord`), inside one ayah or
 * across two, so it is exercised by the attempt that was asked to start there —
 * not by every attempt that happened to pass over it. Two cases, and nothing else:
 *
 *   • `intra`: the attempt recites the ayah holding the boundary and its span
 *     **begins at** `toWord`. The learner was handed the clause before the hinge
 *     and had to land on this word; a whole-ayah recitation (null span) is not
 *     that question, so it does not answer it.
 *   • `inter`: `verseKey` is the ayah being left and `toWord` is the first word of
 *     `toVerseKey`, so the attempt that speaks to it is one **on the ayah entered**
 *     whose span begins at that word. Continuing into the next ayah is the only
 *     evidence that the seam between two ayat held; reciting either one alone is
 *     not.
 *
 * A hinge **holds** when nothing went wrong on the word it arrives at: no error
 * with `expectedPosition === toWord` in that attempt, and no `wrong-transition`
 * anywhere in it — the classifier raises that kind precisely when the recitation
 * jumped onto a different boundary. The number then moves the same way every other
 * stability here moves: one exponential step toward 1 (held) or 0 (missed), at
 * `AXIS_LEARN_RATE`. The counters are the raw evidence beside it, because
 * "lost it there four times" is a different claim from the score.
 *
 * Anchors are deliberately absent: nothing in `core/src/hifz` reads
 * `anchor_word.stability`, and a number no consumer uses is dead state, not a
 * memory. They stay at their derived enrolment value until something asks.
 */
export function applyAttemptToStoredTransitions(
  transitions: readonly HifzTransition[],
  attempt: FingerprintAttemptView,
  rate = AXIS_LEARN_RATE,
): HifzTransition[] {
  // `hifz_transition.stability` is one number on the form axis, so only a
  // form-cued attempt may move it. A meaning drill that happens to begin on a
  // hinge word says nothing about holding the Arabic seam.
  if (attemptDimension(attempt) !== 'form') return [...transitions];
  const jumped = attempt.errors.some((error) => error.kind === 'wrong-transition');
  return transitions.map((transition) => {
    // The ayah whose word list `toWord` counts through.
    const arrivedIn = transition.kind === 'inter' ? transition.toVerseKey : transition.verseKey;
    if (transition.itemId !== attempt.itemId || arrivedIn === null || attempt.verseKey !== arrivedIn) return transition;
    // Only a span tells us the step began at this hinge; a whole-ayah recitation
    // began at word 1 and proves nothing about a boundary further in.
    if (attempt.span === null || attempt.span.fromWord !== transition.toWord) return transition;
    const landedWrong = jumped || attempt.errors.some((error) => error.expectedPosition === transition.toWord);
    const target = landedWrong ? 0 : 1;
    return {
      ...transition,
      stability: roundScore(clamp01(transition.stability + rate * (target - transition.stability))),
      successCount: transition.successCount + (landedWrong ? 0 : 1),
      failureCount: transition.failureCount + (landedWrong ? 1 : 0),
      lastPracticedAt: attempt.at ?? transition.lastPracticedAt,
    };
  });
}
