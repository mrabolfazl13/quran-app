/**
 * Session orchestration: turn a plan into an ordered step list, then turn the
 * attempts that actually happened into a `SessionReport`.
 *
 * The phase order is fixed (warm-up → new learning → progressive recall →
 * transition training → similar-ayah drill → reverse → random → assessment) and
 * every selection inside a phase is sorted by a deterministic key, so two runs
 * over the same plan produce the same steps. No clock reads, no randomness.
 */

import type {
  ConfusionGroup,
  DailyPlan,
  DetectedError,
  ErrorKind,
  HifzItem,
  HifzSegment,
  HifzSession,
  HifzTransition,
  RecallAttempt,
  RecallMode,
  SessionReport,
  SessionStep,
} from '../contracts/hifz';
import {
  ASSESSMENT_STEP_SECONDS,
  LEARN_RATE,
  PHASE_STEP_CAP,
  PROBE_DRILL_ITEM_CAP,
  REPEATED_ERROR_MIN_COUNT,
  STEP_OVERHEAD_SECONDS,
  WARM_UP_ITEM_COUNT,
  WEAK_SEGMENT_STABILITY,
  WEAK_TRANSITION_STABILITY,
} from './params';
import { WORD_LEVEL_ERROR_KINDS, attemptCostSeconds } from './review';
import { attemptIsSuccess, attemptToStabilityAttempt, computeStability, roundScore } from './stability';
import { parseIso } from './stability';

export interface SessionAyahSource {
  itemId: string;
  verseKey: string;
  /** Authoritative text, so steps can be rendered without a lookup. */
  text: string;
}

export interface BuildSessionInput {
  plan: DailyPlan;
  items: readonly HifzItem[];
  /** Texts for every ayah the plan touches. */
  ayahs?: readonly SessionAyahSource[];
  attempts?: readonly RecallAttempt[];
  segments?: readonly HifzSegment[];
  transitions?: readonly HifzTransition[];
  confusionGroups?: readonly ConfusionGroup[];
  nowIso: string;
  /** Cap per phase; defaults to `PHASE_STEP_CAP`. */
  phaseCap?: number;
}

function itemByVerseKey(items: readonly HifzItem[]): Map<string, HifzItem> {
  const map = new Map<string, HifzItem>();
  for (const item of items) {
    map.set(item.verseKey, item);
    for (const key of item.sequence) if (!map.has(key)) map.set(key, item);
  }
  return map;
}

function step(mode: RecallMode, verseKey: string | null, itemId: string | null): SessionStep {
  return { mode, verseKey, itemId, attemptId: null, completedAt: null };
}

/**
 * The eight phases, in order, each filled from the plan. Empty phases are
 * skipped rather than padded with fake steps.
 */
export function buildSessionSteps(input: BuildSessionInput): SessionStep[] {
  const cap = input.phaseCap ?? PHASE_STEP_CAP;
  const byKey = itemByVerseKey(input.items);
  const steps: SessionStep[] = [];
  const seen = new Set<string>();
  const push = (mode: RecallMode, verseKey: string | null): void => {
    const item = verseKey ? byKey.get(verseKey) : undefined;
    const dedupeKey = `${mode}:${verseKey ?? item?.id ?? '-'}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    steps.push(step(mode, verseKey ?? null, item?.id ?? null));
  };

  const planned = [...input.plan.weakItems, ...input.plan.reviewItems];

  // 1. warm-up: the most recently reviewed planned items, cued by their first word.
  const recency = new Map<string, number>();
  for (const attempt of input.attempts ?? []) {
    const at = parseIso(attempt.completedAt ?? attempt.startedAt);
    recency.set(attempt.itemId, Math.max(recency.get(attempt.itemId) ?? 0, at));
  }
  const warmPool = planned
    .map((e) => e.itemId)
    .filter((id) => (recency.get(id) ?? 0) > 0)
    .sort((a, b) => (recency.get(b) ?? 0) - (recency.get(a) ?? 0) || a.localeCompare(b))
    .slice(0, WARM_UP_ITEM_COUNT);
  for (const itemId of warmPool) {
    const item = input.items.find((i) => i.id === itemId);
    if (item) push('first-word-cue', item.verseKey);
  }

  // 2. new learning: today's new ayahs, segment by segment.
  for (const verseKey of input.plan.newAyahs) push('segment', verseKey);

  // 3. progressive recall: highest-priority reviews first.
  for (const entry of planned.slice(0, cap)) {
    if (entry.suggestedMode === 'segment' && input.plan.newAyahs.includes(entry.verseKey)) continue;
    push('continue-ayah', entry.verseKey);
  }

  // 4. transition training: weakest boundaries first.
  const weakTransitions = (input.transitions ?? [])
    .slice()
    .sort((a, b) => a.stability - b.stability || a.itemId.localeCompare(b.itemId) || a.toWord - b.toWord)
    .slice(0, cap);
  for (const transition of weakTransitions) {
    const item = input.items.find((i) => i.id === transition.itemId);
    if (!item || item.status !== 'active') continue;
    push('transition', item.verseKey);
  }

  // 5. similar-ayah drill: confusion-group members, back to back.
  const groupKeys = new Set<string>();
  for (const id of input.plan.confusionGroups) {
    const group = (input.confusionGroups ?? []).find((g) => g.id === id);
    if (!group) continue;
    for (const verseKey of group.verseKeys) groupKeys.add(verseKey);
  }
  let drilled = 0;
  for (const verseKey of [...groupKeys].sort()) {
    if (drilled >= cap * 2) break;
    push('full-ayah', verseKey);
    drilled += 1;
  }

  // 6. reverse recall: least stable planned items.
  const byStability = planned
    .map((entry) => ({ entry, item: byKey.get(entry.verseKey) }))
    .filter((row) => row.item !== undefined)
    .sort((a, b) => (a.item!.stability - b.item!.stability) || a.entry.verseKey.localeCompare(b.entry.verseKey))
    .slice(0, PROBE_DRILL_ITEM_CAP);
  for (const row of byStability) push('reverse', row.entry.verseKey);

  // 7. random recall: a seeded span, spread over the plan.
  const randomPool = planned
    .map((entry) => entry.verseKey)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, PROBE_DRILL_ITEM_CAP);
  for (const verseKey of randomPool) push('random', verseKey);

  // 8. assessment: one closing step — the sequence if an item spans ayahs.
  const assessmentCandidate = planned[0];
  if (assessmentCandidate) {
    const item = byKey.get(assessmentCandidate.verseKey);
    if (item && item.sequence.length > 1) push('full-sequence', item.sequence[0] ?? null);
    else push('audio-recall', assessmentCandidate.verseKey);
  }

  return steps;
}

/** Start a session: steps are planned, nothing is recorded yet. */
export function createSession(input: {
  id: string;
  startedAt: string;
  steps: readonly SessionStep[];
}): HifzSession {
  return {
    id: input.id,
    startedAt: input.startedAt,
    endedAt: null,
    plannedSteps: input.steps.length,
    steps: input.steps.map((s) => ({ ...s })),
    report: null,
  };
}

/** Attach a recorded attempt to a step, without mutating the session. */
export function withAttempt(
  session: HifzSession,
  stepIndex: number,
  attemptId: string,
  completedAt: string,
): HifzSession {
  const steps = session.steps.map((s, index) =>
    index === stepIndex ? { ...s, attemptId, completedAt } : s,
  );
  return { ...session, steps };
}

/** Close a session and attach its report. */
export function finishSession(
  session: HifzSession,
  endedAt: string,
  report: SessionReport,
): HifzSession {
  return { ...session, endedAt, report };
}

/** Rough session length from the same explicit cost model the plan uses. */
export function sessionCostSeconds(steps: readonly SessionStep[]): number {
  return steps.reduce((sum, s) => sum + attemptCostSeconds(s.mode) + STEP_OVERHEAD_SECONDS, 0) + assessmentCostSeconds();
}

export interface SessionReportInput {
  nowIso: string;
  /** Attempts that happened in this session. */
  attempts: readonly RecallAttempt[];
  /** Item state before the session (stability/band baseline, attempt counts). */
  items: readonly HifzItem[];
  /** History before the session, when available, for the after-stability math. */
  priorAttempts?: readonly RecallAttempt[];
  segments?: readonly HifzSegment[];
  transitions?: readonly HifzTransition[];
}

function wordErrors(attempts: readonly RecallAttempt[]): Set<string> {
  const seen = new Set<string>();
  for (const attempt of attempts) {
    for (const error of attempt.errors) {
      if (!WORD_LEVEL_ERROR_KINDS.includes(error.kind)) continue;
      seen.add(`${attempt.id}|${error.kind}|${error.expectedPosition}|${error.actual ?? ''}`);
    }
  }
  return seen;
}

function countByKind(attempts: readonly RecallAttempt[]): Map<ErrorKind, number> {
  const map = new Map<ErrorKind, number>();
  for (const attempt of attempts) {
    for (const error of attempt.errors) {
      if (error.kind === 'correct') continue;
      map.set(error.kind, (map.get(error.kind) ?? 0) + 1);
    }
  }
  return map;
}

/**
 * Report a finished session. Every number is summed or averaged from the
 * attempts that actually happened — no placeholders.
 */
export function computeSessionReport(input: SessionReportInput): SessionReport {
  const attempts = input.attempts
    .slice()
    .sort((a, b) => parseIso(a.completedAt ?? a.startedAt) - parseIso(b.completedAt ?? b.startedAt) || a.id.localeCompare(b.id));
  const itemsById = new Map(input.items.map((item) => [item.id, item]));

  let expectedWords = 0;
  let correctWords = 0;
  for (const attempt of attempts) {
    expectedWords += Math.max(0, attempt.expectedWordCount);
    correctWords += Math.max(0, attempt.correctWordCount);
  }
  const overallRecall = expectedWords === 0 ? 0 : roundScore(correctWords / expectedWords);

  const reviewedItemIds = [...new Set(attempts.map((a) => a.itemId))].sort();
  const newItemsLearned = reviewedItemIds.filter((id) => (itemsById.get(id)?.attemptCount ?? 0) === 0).length;
  const reviewsCompleted = reviewedItemIds.length - newItemsLearned;

  // Weak segments: expected words come from the segment spans, wrong words
  // from the word-level errors the classifier attributed to that segment.
  const segmentKey = (itemId: string, position: number) => `${itemId}|${position}`;
  const segmentTouched = new Map<string, { itemId: string; position: number; expected: number; wrong: number }>();
  for (const segment of input.segments ?? []) {
    segmentTouched.set(segmentKey(segment.itemId, segment.position), {
      itemId: segment.itemId,
      position: segment.position,
      expected: segment.toWord - segment.fromWord + 1,
      wrong: 0,
    });
  }
  const seenErrors = wordErrors(attempts);
  const counted = new Set<string>();
  for (const attempt of attempts) {
    for (const error of attempt.errors) {
      if (!WORD_LEVEL_ERROR_KINDS.includes(error.kind)) continue;
      const identity = `${attempt.id}|${error.kind}|${error.expectedPosition}|${error.actual ?? ''}`;
      if (!seenErrors.has(identity) || counted.has(identity)) continue;
      counted.add(identity);
      if (error.segmentPosition === null) continue;
      const row = segmentTouched.get(segmentKey(attempt.itemId, error.segmentPosition));
      if (row) row.wrong += 1;
    }
  }
  const weakSegments = [...segmentTouched.values()]
    .filter((row) => row.expected > 0)
    .map((row) => ({
      itemId: row.itemId,
      segmentPosition: row.position,
      accuracy: roundScore(Math.max(0, 1 - row.wrong / row.expected)),
    }))
    .filter((row) => row.accuracy < WEAK_SEGMENT_STABILITY)
    .sort((a, b) => a.accuracy - b.accuracy || a.itemId.localeCompare(b.itemId) || a.segmentPosition - b.segmentPosition);

  // Weak transitions: EWMA over the session's successes and failures at the
  // boundary word position. Only transitions of items actually recited in this
  // session are reported — the session report describes this session.
  const successAtPosition = new Map<string, Set<number>>();
  const failureAtPosition = new Map<string, Set<number>>();
  for (const attempt of attempts) {
    const successes = successAtPosition.get(attempt.itemId) ?? new Set<number>();
    const failures = failureAtPosition.get(attempt.itemId) ?? new Set<number>();
    for (const error of attempt.errors) {
      if (error.kind === 'correct') successes.add(error.expectedPosition);
      else if (WORD_LEVEL_ERROR_KINDS.includes(error.kind)) failures.add(error.expectedPosition);
    }
    successAtPosition.set(attempt.itemId, successes);
    failureAtPosition.set(attempt.itemId, failures);
  }
  const reviewedSet = new Set(reviewedItemIds);
  const weakTransitions = (input.transitions ?? [])
    .filter((transition) => reviewedSet.has(transition.itemId))
    .map((transition) => {
      const successes = successAtPosition.get(transition.itemId)?.has(transition.toWord) ?? false;
      const failures = failureAtPosition.get(transition.itemId)?.has(transition.toWord) ?? false;
      const stability = successes && !failures
        ? advanceStability(transition.stability, true)
        : failures
          ? advanceStability(transition.stability, false)
          : transition.stability;
      return { itemId: transition.itemId, toWord: transition.toWord, stability: roundScore(stability) };
    })
    .filter((row) => row.stability < WEAK_TRANSITION_STABILITY)
    .sort((a, b) => a.stability - b.stability || a.itemId.localeCompare(b.itemId) || a.toWord - b.toWord);

  const confusedVerseKeys = [
    ...new Set(
      attempts
        .flatMap((a) => a.errors)
        .map((e) => e.confusedWithVerseKey)
        .filter((k): k is string => typeof k === 'string' && k.length > 0),
    ),
  ].sort();

  const repeatedErrors = [...countByKind(attempts).entries()]
    .filter(([, count]) => count >= REPEATED_ERROR_MIN_COUNT)
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));

  // Stability after, per touched item, from prior history + this session.
  const prior = input.priorAttempts ?? [];
  const stabilityChanges = reviewedItemIds.map((itemId) => {
    const item = itemsById.get(itemId);
    const before = item?.stability ?? 0;
    const attemptsForItem = [
      ...prior.filter((a) => a.itemId === itemId),
      ...attempts.filter((a) => a.itemId === itemId),
    ].sort((a, b) => parseIso(a.startedAt) - parseIso(b.startedAt) || a.id.localeCompare(b.id));
    const after = computeStability({
      nowIso: input.nowIso,
      addedAt: item?.addedAt ?? input.nowIso,
      lastReviewedAt: attemptsForItem.length > 0
        ? attemptsForItem[attemptsForItem.length - 1]!.completedAt ?? attemptsForItem[attemptsForItem.length - 1]!.startedAt
        : item?.lastReviewedAt ?? null,
      storedNextReviewAt: item?.nextReviewAt ?? null,
      attempts: attemptsForItem.map(attemptToStabilityAttempt),
    });
    return { itemId, before: roundScore(before), after: after.stability, band: after.band, nextReviewAt: after.nextReviewAt };
  });

  const recommended = stabilityChanges
    .map((row) => row.nextReviewAt)
    .sort((a, b) => parseIso(a) - parseIso(b))[0] ?? null;

  return {
    overallRecall,
    newItemsLearned,
    reviewsCompleted,
    weakSegments,
    weakTransitions,
    confusedVerseKeys,
    repeatedErrors,
    recommendedNextReviewAt: recommended,
    stabilityChanges: stabilityChanges
      .map((row) => ({ itemId: row.itemId, before: row.before, after: row.after }))
      .sort((a, b) => a.itemId.localeCompare(b.itemId)),
  };
}

/**
 * EWMA stability update from one attempt at a boundary: a success moves the
 * value toward 1 by `LEARN_RATE` of the remaining gap, a failure moves it
 * toward 0 by the same share.
 */
export function advanceStability(current: number, success: boolean): number {
  const value = Math.min(1, Math.max(0, current));
  const next = success ? value + LEARN_RATE * (1 - value) : value * (1 - LEARN_RATE);
  return Math.min(1, Math.max(0, next));
}

/** Per-item stability updates after a session, ready to persist. */
export function stabilityAfterSession(
  input: SessionReportInput & { report?: SessionReport },
): { itemId: string; before: number; after: number; band: HifzItem['band']; nextReviewAt: string }[] {
  const attempts = input.attempts;
  const itemsById = new Map(input.items.map((item) => [item.id, item]));
  const prior = input.priorAttempts ?? [];
  const touched = [...new Set(attempts.map((a) => a.itemId))].sort();
  return touched.map((itemId) => {
    const item = itemsById.get(itemId);
    const attemptsForItem = [
      ...prior.filter((a) => a.itemId === itemId),
      ...attempts.filter((a) => a.itemId === itemId),
    ].sort((a, b) => parseIso(a.startedAt) - parseIso(b.startedAt) || a.id.localeCompare(b.id));
    const result = computeStability({
      nowIso: input.nowIso,
      addedAt: item?.addedAt ?? input.nowIso,
      lastReviewedAt: attemptsForItem.length > 0
        ? attemptsForItem[attemptsForItem.length - 1]!.completedAt ?? attemptsForItem[attemptsForItem.length - 1]!.startedAt
        : item?.lastReviewedAt ?? null,
      storedNextReviewAt: item?.nextReviewAt ?? null,
      attempts: attemptsForItem.map(attemptToStabilityAttempt),
    });
    return {
      itemId,
      before: roundScore(item?.stability ?? 0),
      after: result.stability,
      band: result.band,
      nextReviewAt: result.nextReviewAt,
    };
  });
}

/** Attempt ids grouped per item, for the UI to replay a session. */
export function attemptsByItem(attempts: readonly RecallAttempt[]): Map<string, RecallAttempt[]> {
  const map = new Map<string, RecallAttempt[]>();
  for (const attempt of attempts) {
    const list = map.get(attempt.itemId);
    if (list) list.push(attempt);
    else map.set(attempt.itemId, [attempt]);
  }
  return map;
}

/** Assessment step cost, on top of the mode cost of the step itself. */
export function assessmentCostSeconds(): number {
  return ASSESSMENT_STEP_SECONDS;
}

/** True when every attempt of the session was a success. */
export function sessionIsClean(attempts: readonly RecallAttempt[]): boolean {
  return attempts.length > 0 && attempts.every((a) => attemptIsSuccess({ at: a.startedAt, accuracy: a.accuracy }));
}
