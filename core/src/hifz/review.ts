/**
 * Adaptive review scheduler.
 *
 * Deterministic, documented weights over ten factors; same inputs produce
 * byte-identical output (a test schedules the same input twice and compares
 * JSON). Every entry carries its per-factor breakdown so the UI can answer
 * "why is this ayah due?" without guessing.
 *
 * The tenth factor is the meaning gap: an ayah whose sound-shape is solid and
 * whose sense is blank is recited, not memorised, and the queue has to be able to
 * say so. It is zero for any item no licensed meaning covers.
 *
 * The weights are an engineering heuristic: bounded, monotone, tunable in
 * `params.ts`, and NOT validated by memory research. See
 * `docs/review-algorithm.md`.
 */

import type {
  ConfusionGroup,
  DailyPlan,
  ErrorKind,
  HifzItem,
  HifzSegment,
  HifzTransition,
  RecallAttempt,
  RecallMode,
  ReviewPlanEntry,
  SegmentMeaning,
} from '../contracts/hifz';
import {
  CONFUSION_SATURATION_ERRORS,
  DAILY_REVIEW_ITEM_CAP,
  DEFAULT_NEW_AYAH_WORD_COUNT,
  GROUP_CONFUSION_SATURATION,
  GROUP_MEMBER_LIFT_CAP,
  GROUP_MEMBER_TAPER,
  HISTORICAL_ERROR_WORD_NORMALIZER,
  MEANING_CONCEPT_CUE_MAX_GAP,
  MEANING_GAP_SATURATION,
  MEANING_UNTESTED_GAP,
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
  SUCCESS_ACCURACY,
  WEAK_SEGMENT_STABILITY,
  WEAK_TRANSITION_STABILITY,
  BAND_URGENCY,
  type ReviewFactorKey,
} from './params';
import { clamp01, diffDays, isOverdue, parseIso, roundScore } from './stability';
import { groupBoost, groupsForVerseKey } from './confusion';

/** Error kinds that describe one word position (summary kinds excluded). */
export const WORD_LEVEL_ERROR_KINDS: readonly ErrorKind[] = [
  'omission',
  'substitution',
  'repetition',
  'wrong-order',
  'wrong-transition',
  'similar-ayah-confusion',
];

/** Kinds that mean "this ayah got mixed up with another one". */
export const CROSS_AYAH_ERROR_KINDS: readonly ErrorKind[] = [
  'wrong-transition',
  'similar-ayah-confusion',
];

export type ReviewWeights = Record<ReviewFactorKey, number>;

/**
 * Which verses a licensed meaning actually covers, supplied by the caller from
 * the content packs it imported. The engine never looks a meaning up itself and
 * never writes one: no entry (or a null entry) means the meaning axis has no cue
 * to test with, so it contributes nothing to this item's priority.
 *
 * Keyed by `verse_key`, because that is the stable domain key.
 */
export type MeaningCoverage = Readonly<Record<string, SegmentMeaning | null>>;

export interface ItemHistory {
  item: HifzItem;
  attempts: RecallAttempt[];
  segments: HifzSegment[];
  transitions: HifzTransition[];
  groups: ConfusionGroup[];
  /** A licensed meaning covers this item's own ayah, so a meaning probe can be built. */
  meaningAvailable: boolean;
  /** It also covers the ayah before it, so the concept-cue chain can be built. */
  previousMeaningAvailable: boolean;
}

export interface ReviewContextInput {
  nowIso: string;
  items: readonly HifzItem[];
  attempts?: readonly RecallAttempt[];
  segments?: readonly HifzSegment[];
  transitions?: readonly HifzTransition[];
  confusionGroups?: readonly ConfusionGroup[];
  /** Override any weight for tuning; missing keys fall back to `REVIEW_WEIGHTS`. */
  weights?: Partial<ReviewWeights>;
  /**
   * Meaning coverage per verse key. `meanings[key]` is the ayah's own licensed
   * meaning; `concept-cue` is only offered when the previous ayah's key is also
   * present, so the chain never cues a learner with a meaning the app does not have.
   */
  meanings?: MeaningCoverage | null;
  /**
   * Previous verse key per ayah, from the mushaf order the caller already has.
   * Without it the engine cannot know what "the previous ayah" is, so it assumes
   * nothing and `concept-cue` is never suggested.
   */
  previousVerseKey?: Readonly<Record<string, string | null>> | null;
}

export interface ScoredItem {
  entry: ReviewPlanEntry;
  /** Each raw factor, 0..1, before weighting. */
  raw: Record<ReviewFactorKey, number>;
  /** Weighted contributions; `entry.priority` is their sum (before group boost). */
  weighted: Record<ReviewFactorKey, number>;
}

export interface BuiltDailyPlan extends DailyPlan {
  /** Seconds behind `estimatedMinutes`, kept for the UI's breakdown panel. */
  estimatedSeconds: number;
  /** Number of review steps the estimate is built from. */
  stepCount: number;
}

function activeWeights(weights?: Partial<ReviewWeights>): ReviewWeights {
  const out = {} as ReviewWeights;
  for (const key of Object.keys(REVIEW_WEIGHTS) as ReviewFactorKey[]) {
    out[key] = weights?.[key] ?? REVIEW_WEIGHTS[key];
  }
  return out;
}

function groupByItemId<T extends { itemId: string }>(rows: readonly T[] | undefined): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows ?? []) {
    const list = map.get(row.itemId);
    if (list) list.push(row);
    else map.set(row.itemId, [row]);
  }
  return map;
}

/** Everything the scheduler needs about one item, pulled from the history. */
export function historyFor(input: ReviewContextInput): Map<string, ItemHistory> {
  const attemptsByItem = groupByItemId(input.attempts);
  const segmentsByItem = groupByItemId(input.segments);
  const transitionsByItem = groupByItemId(input.transitions);
  const groups = input.confusionGroups ?? [];
  const meanings = input.meanings ?? null;
  const previousKeys = input.previousVerseKey ?? null;
  const out = new Map<string, ItemHistory>();
  for (const item of input.items) {
    const itemKeys = new Set(item.sequence.length > 0 ? [...item.sequence, item.verseKey] : [item.verseKey]);
    const meaning = meanings?.[item.verseKey] ?? null;
    const previousKey = previousKeys?.[item.verseKey] ?? null;
    const previousMeaning = previousKey ? meanings?.[previousKey] ?? null : null;
    out.set(item.id, {
      item,
      attempts: (attemptsByItem.get(item.id) ?? []).slice().sort((a, b) => parseIso(a.startedAt) - parseIso(b.startedAt) || a.id.localeCompare(b.id)),
      segments: segmentsByItem.get(item.id) ?? [],
      transitions: transitionsByItem.get(item.id) ?? [],
      groups: groups.filter((g) => g.verseKeys.some((k) => itemKeys.has(k))),
      meaningAvailable: meaning !== null && meaning.text.trim().length > 0,
      previousMeaningAvailable: previousMeaning !== null && previousMeaning.text.trim().length > 0,
    });
  }
  return out;
}

function meanStability(rows: readonly { stability: number }[]): number {
  if (rows.length === 0) return 0;
  return rows.reduce((sum, r) => sum + clamp01(r.stability), 0) / rows.length;
}

function shareBelow(rows: readonly { stability: number }[], threshold: number): number {
  if (rows.length === 0) return 0;
  const below = rows.filter((r) => r.stability < threshold).length;
  return below / rows.length;
}

/**
 * The meaning lag of an item: how far its conceptual axis sits behind its
 * sound-shape axis, in stability points.
 *
 * Zero when no licensed meaning covers the item, because an axis nothing can cue
 * is not a gap — inventing one would send a learner to a probe the app cannot
 * honestly grade. An item that *could* be probed but never was (`meaningStability`
 * null) reports the full `MEANING_UNTESTED_GAP`: a whole untested axis is the
 * largest gap there is.
 */
export function meaningLagOf(item: HifzItem, meaningAvailable: boolean): number {
  if (!meaningAvailable) return 0;
  if (item.meaningStability === null) return MEANING_UNTESTED_GAP;
  return Math.max(0, item.formStability - item.meaningStability);
}

/**
 * The ten raw factors, each 0..1. Formulas documented in
 * `docs/review-algorithm.md`; every number is derived from stored history.
 */
export function rawFactors(history: ItemHistory, nowIso: string): Record<ReviewFactorKey, number> {
  const { item, attempts, segments, transitions, groups } = history;

  let wrongWords = 0;
  let expectedWords = 0;
  let confusionErrors = 0;
  for (const attempt of attempts) {
    expectedWords += Math.max(0, attempt.expectedWordCount);
    for (const error of attempt.errors) {
      if (WORD_LEVEL_ERROR_KINDS.includes(error.kind)) wrongWords += 1;
      if (CROSS_AYAH_ERROR_KINDS.includes(error.kind)) confusionErrors += 1;
    }
  }
  const historical =
    attempts.length === 0
      ? clamp01(item.errorCount / HISTORICAL_ERROR_WORD_NORMALIZER)
      : clamp01(wrongWords / Math.max(1, expectedWords));

  const weakSegments =
    segments.length === 0
      ? clamp01(1 - item.stability)
      : clamp01(0.5 * (1 - meanStability(segments)) + 0.5 * shareBelow(segments, WEAK_SEGMENT_STABILITY));

  const weakTransitions =
    transitions.length === 0
      ? clamp01(1 - item.stability)
      : clamp01(0.5 * (1 - meanStability(transitions)) + 0.5 * shareBelow(transitions, WEAK_TRANSITION_STABILITY));

  const overdue =
    item.nextReviewAt === null
      ? NEVER_SCHEDULED_FACTOR
      : isOverdue(item.nextReviewAt, nowIso)
        ? clamp01(diffDays(item.nextReviewAt, nowIso) / OVERDUE_SATURATION_DAYS)
        : 0;

  const successes = attempts.filter((a) => a.accuracy >= SUCCESS_ACCURACY);
  const lastSuccess = successes.length > 0 ? successes[successes.length - 1]!.completedAt ?? successes[successes.length - 1]!.startedAt : null;
  const recency =
    lastSuccess === null
      ? 1
      : clamp01(diffDays(lastSuccess, nowIso) / RECENCY_SATURATION_DAYS);

  const repetitionDebt = clamp01(1 - attempts.length / REPETITION_SATURATION_ATTEMPTS);

  const confusion = clamp01(confusionErrors / CONFUSION_SATURATION_ERRORS);

  let membership = 0;
  for (const group of groups) {
    membership = Math.max(membership, clamp01(group.confusionCount / GROUP_CONFUSION_SATURATION));
  }

  const band = BAND_URGENCY[item.band] ?? 0.5;

  // Meaning gap: how far the conceptual axis lags the sound-shape axis, normalised
  // against `MEANING_GAP_SATURATION` so a full gap saturates the factor.
  const meaningGap = clamp01(meaningLagOf(item, history.meaningAvailable) / MEANING_GAP_SATURATION);

  return {
    'historical-errors': roundScore(historical),
    'weak-segments': roundScore(weakSegments),
    'weak-transitions': roundScore(weakTransitions),
    overdue: roundScore(overdue),
    'recency-of-success': roundScore(recency),
    repetition: roundScore(repetitionDebt),
    'confusion-rate': roundScore(confusion),
    'group-membership': roundScore(membership),
    band: roundScore(band),
    'meaning-gap': roundScore(meaningGap),
  };
}

/**
 * One honest sentence per factor, in the engine's own words. `scoreItem` puts the
 * three strongest into `entry.reason`; the rest stay reachable here so a caller
 * can state a factor that contributed *nothing* — an ayah no licensed meaning
 * covers has a `meaning-gap` of 0, which the reason would silently omit, and
 * "nothing to test" is exactly the message a learner deserves to see.
 */
export function factorSummaries(history: ItemHistory, nowIso: string): Record<ReviewFactorKey, string> {
  const { item, attempts, segments, transitions, groups } = history;  let wrongWords = 0;
  let confusionErrors = 0;
  for (const attempt of attempts) {
    for (const error of attempt.errors) {
      if (WORD_LEVEL_ERROR_KINDS.includes(error.kind)) wrongWords += 1;
      if (CROSS_AYAH_ERROR_KINDS.includes(error.kind)) confusionErrors += 1;
    }
  }
  const overdueDays = item.nextReviewAt ? Math.floor(diffDays(item.nextReviewAt, nowIso)) : null;
  const weakSegmentCount = segments.filter((s) => s.stability < WEAK_SEGMENT_STABILITY).length;
  const weakTransitionCount = transitions.filter((t) => t.stability < WEAK_TRANSITION_STABILITY).length;
  const successes = attempts.filter((a) => a.accuracy >= SUCCESS_ACCURACY);
  const lastSuccessAt = successes.length > 0 ? successes[successes.length - 1]!.completedAt ?? successes[successes.length - 1]!.startedAt : null;
  return {
    'historical-errors': `${wrongWords} wrong word(s) in ${attempts.length} attempt(s)`,
    'weak-segments':
      segments.length === 0
        ? `no segment data — ${roundScore(1 - item.stability)} estimated from item stability`
        : `${weakSegmentCount}/${segments.length} segment(s) below ${WEAK_SEGMENT_STABILITY}`,
    'weak-transitions':
      transitions.length === 0
        ? `no transition data — ${roundScore(1 - item.stability)} estimated from item stability`
        : `${weakTransitionCount}/${transitions.length} transition(s) below ${WEAK_TRANSITION_STABILITY}`,
    overdue: item.nextReviewAt === null ? 'never scheduled' : overdueDays !== null && overdueDays > 0 ? `overdue by ${overdueDays}d` : 'not due yet',
    'recency-of-success': lastSuccessAt ? `${Math.floor(diffDays(lastSuccessAt, nowIso))}d since last success` : 'no successful recall yet',
    repetition: `repetition debt ${Math.max(0, REPETITION_SATURATION_ATTEMPTS - attempts.length)}`,
    'confusion-rate': `${confusionErrors} cross-ayah error(s)`,
    'group-membership': groups.length > 0 ? `confusion group ${groups.map((g) => g.id).join(', ')}` : 'ungrouped',
    band: `band=${item.band}`,
    'meaning-gap': !history.meaningAvailable
      ? 'no licensed meaning available for this ayah'
      : item.meaningStability === null
        ? `meaning axis never tested vs form ${roundScore(item.formStability)}`
        : `meaning ${roundScore(item.meaningStability)} vs form ${roundScore(item.formStability)} (lag ${roundScore(meaningLagOf(item, true))})`,
  };
}

/**
 * Mode suggestion, as an ordered rule chain on the raw factors. The first rule
 * that fires wins, so the choice is explainable rather than heuristic soup.
 *
 * The meaning rule sits directly after "this is brand-new material": nothing
 * beats chunking an ayah you have not learned yet, but once it is learned, the
 * axis that is behind is the axis that gets drilled. A meaning mode is only ever
 * suggested when a licensed meaning exists to cue it with.
 */
export function suggestMode(history: ItemHistory, raw: Record<ReviewFactorKey, number>): RecallMode {
  const { item, attempts } = history;
  const positional = { beginning: 0, middle: 0, ending: 0 };
  for (const attempt of attempts) {
    for (const error of attempt.errors) {
      if (error.kind === 'beginning-failure') positional.beginning += 1;
      else if (error.kind === 'middle-failure') positional.middle += 1;
      else if (error.kind === 'ending-failure') positional.ending += 1;
    }
  }
  if (attempts.length === 0 || item.band === 'new') return 'segment';
  if (raw['meaning-gap'] > 0 && history.meaningAvailable) {
    const lag = meaningLagOf(item, true);
    // A small hole is trained as a chain (previous meaning → this ayah's opening)
    // when the previous ayah's meaning is licensed too; a big hole needs the
    // direct meaning→Arabic binding of the whole ayah first.
    if (lag <= MEANING_CONCEPT_CUE_MAX_GAP && history.previousMeaningAvailable) return 'concept-cue';
    return 'meaning-to-arabic';
  }
  if (raw['confusion-rate'] > 0 || raw['group-membership'] > 0) return 'full-ayah';
  if (raw['weak-transitions'] >= raw['weak-segments'] && raw['weak-transitions'] > 0) return 'transition';
  const worstPositional = Math.max(positional.beginning, positional.middle, positional.ending);
  if (worstPositional > 0) {
    if (positional.beginning === worstPositional) return 'opening';
    if (positional.ending === worstPositional) return 'ending';
    return 'middle';
  }
  if (raw['weak-segments'] > 0) return 'segment';
  if (raw.overdue > 0 || raw['recency-of-success'] > 0.5) return 'first-word-cue';
  return 'missing-word';
}

/** One item's plan entry: raw factors, weighted contributions, priority, reason. */
export function scoreItem(history: ItemHistory, nowIso: string, weights?: Partial<ReviewWeights>): ScoredItem {
  const w = activeWeights(weights);
  const raw = rawFactors(history, nowIso);
  const weighted = {} as Record<ReviewFactorKey, number>;
  let priority = 0;
  for (const key of Object.keys(raw) as ReviewFactorKey[]) {
    // `meaning-gap` is not summed here: it is applied as a bounded uplift below.
    if (key === 'meaning-gap') continue;
    const contribution = raw[key] * w[key];
    weighted[key] = roundScore(contribution);
    priority += contribution;
  }
  // The nine documented weights sum to exactly 1.00, so `priority` above is the
  // documented weighted average and an item with no meaning lag scores precisely
  // what it scored before the meaning axis existed.
  //
  // The gap then takes its share of whatever headroom those nine left: it can
  // only ever raise urgency, it cannot dilute a documented factor to do so, and
  // `p + gap·w·(1 − p)` stays inside 0..1 by construction. Re-weighting the nine
  // instead would have shifted every existing priority by ~12% and silently moved
  // which items clear the plan and weak cutoffs for learners who have never been
  // shown a meaning probe.
  const gapUplift = clamp01(raw['meaning-gap']) * w['meaning-gap'] * (1 - priority);
  weighted['meaning-gap'] = roundScore(gapUplift);
  priority = clamp01(priority + gapUplift);
  const summaries = factorSummaries(history, nowIso);
  const ordered = (Object.keys(weighted) as ReviewFactorKey[])
    .map((key) => ({ key, value: weighted[key] }))
    .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  const reasonKeys = ordered.filter((o) => o.value > 0).slice(0, 3).map((o) => o.key);
  const reason = reasonKeys.length > 0
    ? reasonKeys.map((key) => summaries[key]).join('; ')
    : 'no urgency signals';

  const factors: Record<string, number> = {};
  for (const key of Object.keys(weighted) as ReviewFactorKey[]) {
    factors[key] = weighted[key]!;
    factors[`${key}-raw`] = raw[key]!;
  }

  return {
    entry: {
      itemId: history.item.id,
      verseKey: history.item.verseKey,
      reason,
      priority: roundScore(priority),
      factors,
      suggestedMode: suggestMode(history, raw),
      dueAt: history.item.nextReviewAt ?? history.item.addedAt,
    },
    raw,
    weighted,
  };
}

/**
 * Group members are lifted together: the strongest member takes the capped
 * boost, the rest are pulled within `GROUP_MEMBER_TAPER` of it but never by
 * more than `GROUP_MEMBER_LIFT_CAP`, so a confused pair is not split across
 * days while a `mastered` partner is not dragged to the top of the queue.
 */
export function applyGroupBoost(
  scored: readonly ScoredItem[],
  groups: readonly ConfusionGroup[],
): ScoredItem[] {
  const byItem = new Map<string, ScoredItem>();
  for (const s of scored) byItem.set(s.entry.itemId, { ...s, entry: { ...s.entry, factors: { ...s.entry.factors } } });
  const itemKeys = (id: string): string[] => {
    const s = byItem.get(id);
    return s ? [s.entry.verseKey] : [];
  };
  for (const group of groups.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    const members = [...byItem.values()].filter((s) => group.verseKeys.some((k) => itemKeys(s.entry.itemId).includes(k)));
    if (members.length === 0) continue;
    members.sort((a, b) => b.entry.priority - a.entry.priority || a.entry.verseKey.localeCompare(b.entry.verseKey));
    const boost = roundScore(groupBoost(group));
    if (boost <= 0) continue;
    const leader = members[0]!;
    const leaderPriority = roundScore(Math.min(1, leader.entry.priority + boost));
    for (const member of members) {
      const pullTarget = member === leader
        ? leaderPriority
        : roundScore(Math.min(leaderPriority - GROUP_MEMBER_TAPER, member.entry.priority + GROUP_MEMBER_LIFT_CAP));
      const target = roundScore(Math.max(member.entry.priority, pullTarget));
      const delta = roundScore(target - member.entry.priority);
      if (delta <= 0) continue;
      member.entry.factors['group-boost'] = roundScore((member.entry.factors['group-boost'] ?? 0) + delta);
      member.entry.priority = roundScore(member.entry.priority + delta);
      const tag = `confusion group ${group.id}`;
      if (!member.entry.reason.includes(tag)) {
        member.entry.reason = member.entry.reason === 'no urgency signals' ? tag : `${member.entry.reason}; ${tag}`;
      }
    }
  }
  return [...byItem.values()];
}

/** Deterministic ordering: priority desc, dueAt asc, verseKey asc, itemId asc. */
export function sortEntries(entries: readonly ReviewPlanEntry[]): ReviewPlanEntry[] {
  return entries.slice().sort(
    (a, b) =>
      b.priority - a.priority ||
      parseIso(a.dueAt) - parseIso(b.dueAt) ||
      a.verseKey.localeCompare(b.verseKey) ||
      a.itemId.localeCompare(b.itemId),
  );
}

/**
 * Score every active item, boost confusion groups, sort deterministically.
 * Paused / graduated / dropped items are never scheduled.
 */
export function planReviews(input: ReviewContextInput): ReviewPlanEntry[] {
  const histories = historyFor(input);
  const scored: ScoredItem[] = [];
  for (const item of input.items) {
    if (item.status !== 'active') continue;
    const history = histories.get(item.id);
    if (!history) continue;
    scored.push(scoreItem(history, input.nowIso, input.weights));
  }
  const boosted = applyGroupBoost(scored, input.confusionGroups ?? []);
  return sortEntries(boosted.map((s) => s.entry));
}

/** Cost of one review step, from the explicit seconds-per-step model. */
export function attemptCostSeconds(mode: RecallMode): number {
  return MODE_COST_SECONDS[mode] ?? MODE_COST_SECONDS['full-ayah']!;
}

/** Cost of introducing one new ayah: exposure + chunk building + recall attempts. */
export function newAyahCostSeconds(wordCount: number): number {
  return (
    NEW_AYAH_EXPOSURE_SECONDS +
    NEW_AYAH_PER_WORD_SECONDS * Math.max(1, wordCount) +
    NEW_LEARNING_ATTEMPT_SECONDS * NEW_LEARNING_RECALL_ATTEMPTS
  );
}

export interface DailyPlanInput extends ReviewContextInput {
  /** verseKeys queued as new learning today, in curriculum order. */
  newAyahs?: readonly string[];
  /** Words per new ayah so the cost model is real, not assumed. */
  newAyahWordCounts?: Readonly<Record<string, number>>;
}

/**
 * Build today's plan. `estimatedMinutes` is the rounded-up sum of the explicit
 * per-step costs (see `docs/review-algorithm.md`), never a constant.
 */
export function buildDailyPlan(input: DailyPlanInput): BuiltDailyPlan {
  const all = planReviews(input);
  const due = all.filter((e) => e.priority >= PRIORITY_PLAN_CUTOFF);
  const capped = due.slice(0, DAILY_REVIEW_ITEM_CAP);
  const weakItems = sortEntries(capped.filter((e) => e.priority >= PRIORITY_WEAK_CUTOFF));
  const weakIds = new Set(weakItems.map((e) => e.itemId));
  const reviewItems = sortEntries(capped.filter((e) => !weakIds.has(e.itemId)));
  const planned = [...weakItems, ...reviewItems];

  const plannedKeys = new Set(planned.map((e) => e.verseKey));
  const confusionGroups = (input.confusionGroups ?? [])
    .filter((g) => g.verseKeys.some((k) => plannedKeys.has(k)))
    .map((g) => g.id)
    .sort();

  const newAyahs = (input.newAyahs ?? []).slice(0, NEW_AYAH_PER_DAY_CAP);

  let seconds = 0;
  let stepCount = 0;
  for (const entry of planned) {
    seconds += attemptCostSeconds(entry.suggestedMode) + STEP_OVERHEAD_SECONDS;
    stepCount += 1;
  }
  for (const verseKey of newAyahs) {
    const words = input.newAyahWordCounts?.[verseKey] ?? DEFAULT_NEW_AYAH_WORD_COUNT;
    seconds += newAyahCostSeconds(words) + STEP_OVERHEAD_SECONDS;
    stepCount += 1;
  }
  // Each confusion group in the plan gets one head-to-head drill per member.
  for (const groupId of confusionGroups) {
    const group = (input.confusionGroups ?? []).find((g) => g.id === groupId);
    if (!group) continue;
    seconds += group.verseKeys.length * (attemptCostSeconds('full-ayah') + STEP_OVERHEAD_SECONDS);
    stepCount += group.verseKeys.length;
  }

  return {
    date: input.nowIso.slice(0, 10),
    newAyahs,
    reviewItems,
    weakItems,
    confusionGroups,
    estimatedMinutes: Math.ceil(seconds / 60),
    estimatedSeconds: seconds,
    stepCount,
  };
}

/** Convenience: group lookup keyed by the items it contains. */
export function groupsByItemId(
  groups: readonly ConfusionGroup[],
  items: readonly HifzItem[],
): Map<string, ConfusionGroup[]> {
  const out = new Map<string, ConfusionGroup[]>();
  for (const item of items) {
    const keys = new Set(item.sequence.length > 0 ? [...item.sequence, item.verseKey] : [item.verseKey]);
    const own = [...new Set([...keys].flatMap((k) => groupsForVerseKey(groups, k)))].sort((a, b) => a.id.localeCompare(b.id));
    if (own.length > 0) out.set(item.id, own);
  }
  return out;
}
