/**
 * Confusion groups: sets of ayahs the learner keeps swapping.
 *
 * Two origins (contract: `ConfusionGroup.origin`):
 *  - `user`   — created by the learner, always authoritative;
 *  - `engine` — proposed from repeated cross-ayah substitutions in the attempt
 *    history, never invented from thin air (a proposal needs `PROPOSE_MIN_TRIGGERS`
 *    real errors).
 *
 * Members of a group are reviewed together: `groupBoost` in `review.ts` lifts
 * the whole group's priority, proportional to `confusionCount`.
 */

import type { ConfusionGroup, ErrorKind, RecallAttempt } from '../contracts/hifz';
import { GROUP_BOOST_CAP, GROUP_BOOST_PER_TRIGGER, GROUP_CONFUSION_SATURATION, PROPOSE_MIN_TRIGGERS } from './params';
import { parseIso } from './stability';

/** Error kinds that count as a cross-ayah confusion event. */
export const CONFUSION_ERROR_KINDS: readonly ErrorKind[] = [
  'similar-ayah-confusion',
  'wrong-transition',
];

/** One unordered ayah pair with how often it was confused and when last. */
export interface ConfusionPairTally {
  verseKeyA: string;
  verseKeyB: string;
  count: number;
  lastAt: string | null;
}

function pairKey(a: string, b: string): string {
  const [lo, hi] = sortedPair(a, b);
  return `${lo}\u0000${hi}`;
}

function sortedPair(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

/**
 * Tally every confusion event in the history: `attempt.verseKey` was recited
 * but matched `error.confusedWithVerseKey`.
 */
export function confusionTally(
  attempts: readonly RecallAttempt[],
  kinds: readonly ErrorKind[] = CONFUSION_ERROR_KINDS,
): ConfusionPairTally[] {
  const map = new Map<string, ConfusionPairTally>();
  const ordered = attempts.slice().sort((a, b) => parseIso(a.startedAt) - parseIso(b.startedAt));
  for (const attempt of ordered) {
    for (const error of attempt.errors) {
      if (!kinds.includes(error.kind)) continue;
      const partner = error.confusedWithVerseKey;
      if (!partner || partner === attempt.verseKey) continue;
      const [a, b] = sortedPair(attempt.verseKey, partner);
      const key = pairKey(a, b);
      const at = attempt.completedAt ?? attempt.startedAt;
      const existing = map.get(key);
      if (existing) {
        existing.count += 1;
        if (!existing.lastAt || parseIso(at) >= parseIso(existing.lastAt)) existing.lastAt = at;
      } else {
        map.set(key, { verseKeyA: a, verseKeyB: b, count: 1, lastAt: at });
      }
    }
  }
  return [...map.values()].sort(
    (x, y) => y.count - x.count || x.verseKeyA.localeCompare(y.verseKeyA) || x.verseKeyB.localeCompare(y.verseKeyB),
  );
}

/** Deterministic group id from origin + member set (user groups may override). */
export function groupIdFor(verseKeys: readonly string[], origin: ConfusionGroup['origin']): string {
  return `cg-${origin}-${[...verseKeys].sort().join('+')}`;
}

/** Create a learner-made group. Members are de-duplicated and sorted. */
export function createUserGroup(input: {
  verseKeys: readonly string[];
  label?: string | null;
  createdAt: string;
  id?: string;
}): ConfusionGroup {
  const verseKeys = [...new Set(input.verseKeys)].sort();
  if (verseKeys.length < 2) throw new Error('a confusion group needs at least two ayahs');
  return {
    id: input.id ?? groupIdFor(verseKeys, 'user'),
    label: input.label ?? null,
    origin: 'user',
    verseKeys,
    createdAt: input.createdAt,
    lastTriggeredAt: null,
    confusionCount: 0,
  };
}

/**
 * Propose groups from repeated cross-ayah substitutions. Ayahs are unioned
 * into one group when they share a partner and both pairs clear the trigger
 * threshold, so a three-way mix-up becomes one group rather than two.
 *
 * Engine proposals never carry a label: the engine does not invent meaning.
 */
export function proposeGroups(input: {
  attempts: readonly RecallAttempt[];
  createdAt: string;
  minTriggers?: number;
  existing?: readonly ConfusionGroup[];
}): ConfusionGroup[] {
  const minTriggers = input.minTriggers ?? PROPOSE_MIN_TRIGGERS;
  const tallies = confusionTally(input.attempts).filter((t) => t.count >= minTriggers);
  if (tallies.length === 0) return [];

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    let cursor = x;
    while (parent.get(cursor) !== cursor) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra > rb ? rb : ra, ra > rb ? ra : rb);
  };
  for (const t of tallies) union(t.verseKeyA, t.verseKeyB);

  const components = new Map<string, Set<string>>();
  for (const key of parent.keys()) {
    const root = find(key);
    const set = components.get(root) ?? new Set<string>();
    set.add(key);
    components.set(root, set);
  }

  const existingSets = (input.existing ?? []).map((g) => new Set(g.verseKeys));
  const out: ConfusionGroup[] = [];
  for (const members of [...components.values()].sort((a, b) => [...a][0]!.localeCompare([...b][0]!))) {
    const verseKeys = [...members].sort();
    if (verseKeys.length < 2) continue;
    const covered = existingSets.some((set) => verseKeys.every((k) => set.has(k)));
    if (covered) continue;
    const count = tallies
      .filter((t) => verseKeys.includes(t.verseKeyA) && verseKeys.includes(t.verseKeyB))
      .reduce((sum, t) => sum + t.count, 0);
    const lastAt = tallies
      .filter((t) => verseKeys.includes(t.verseKeyA) && verseKeys.includes(t.verseKeyB))
      .map((t) => t.lastAt)
      .filter((v): v is string => v !== null)
      .sort((a, b) => parseIso(a) - parseIso(b))
      .pop() ?? null;
    out.push({
      id: groupIdFor(verseKeys, 'engine'),
      label: null,
      origin: 'engine',
      verseKeys,
      createdAt: input.createdAt,
      lastTriggeredAt: lastAt,
      confusionCount: count,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Merge groups covering the same members; user groups win over engine ones. */
export function mergeGroups(groups: readonly ConfusionGroup[]): ConfusionGroup[] {
  const byMembers = new Map<string, ConfusionGroup>();
  for (const group of groups.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    const key = [...new Set(group.verseKeys)].sort().join('+');
    const existing = byMembers.get(key);
    if (!existing) {
      byMembers.set(key, { ...group, verseKeys: [...new Set(group.verseKeys)].sort() });
      continue;
    }
    const preferUser = existing.origin === 'user' || group.origin === 'user';
    byMembers.set(key, {
      id: preferUser ? (existing.origin === 'user' ? existing.id : group.id) : existing.id,
      label: existing.label ?? group.label,
      origin: preferUser ? 'user' : 'engine',
      verseKeys: [...new Set(existing.verseKeys.concat(group.verseKeys))].sort(),
      createdAt: parseIso(existing.createdAt) <= parseIso(group.createdAt) ? existing.createdAt : group.createdAt,
      lastTriggeredAt: latestIso(existing.lastTriggeredAt, group.lastTriggeredAt),
      confusionCount: existing.confusionCount + group.confusionCount,
    });
  }
  return [...byMembers.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function latestIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return parseIso(a) >= parseIso(b) ? a : b;
}

/** Record that a group actually caused an error, without mutating the input. */
export function withTrigger(group: ConfusionGroup, at: string): ConfusionGroup {
  return { ...group, confusionCount: group.confusionCount + 1, lastTriggeredAt: at };
}

/** Priority boost a group contributes, capped and proportional to triggers. */
export function groupBoost(group: ConfusionGroup): number {
  const proportional = GROUP_BOOST_PER_TRIGGER * Math.min(GROUP_CONFUSION_SATURATION, group.confusionCount);
  return Math.min(GROUP_BOOST_CAP, proportional);
}

/** Groups that contain a given ayah. */
export function groupsForVerseKey(
  groups: readonly ConfusionGroup[],
  verseKey: string,
): ConfusionGroup[] {
  return groups.filter((g) => g.verseKeys.includes(verseKey));
}

/** Strongest boost any of an ayah's groups contributes (0 when ungrouped). */
export function boostForVerseKey(groups: readonly ConfusionGroup[], verseKey: string): number {
  let best = 0;
  for (const group of groupsForVerseKey(groups, verseKey)) {
    best = Math.max(best, groupBoost(group));
  }
  return best;
}

/**
 * Members of a group are scheduled together: every member is pulled up to
 * within `GROUP_MEMBER_TAPER` of the group's boosted leader.
 */
export function shouldReviewTogether(a: ConfusionGroup, b: ConfusionGroup): boolean {
  return a.verseKeys.some((k) => b.verseKeys.includes(k)) && a.id !== b.id;
}
