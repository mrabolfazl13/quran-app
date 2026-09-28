/**
 * Adapter: the `HifzEngine` boundary satisfied by the real memory engine in
 * `core/src/hifz`. This file contains no memory science — it converts stored
 * rows into core inputs and core results back into rows, and nothing else.
 *
 * Every function below is called through the typed signatures that
 * `@quran/core` exports, so a drift in core is a compile error here rather than
 * a silent behavioural change. Capability is additionally checked at runtime
 * (`pickCoreHifzModule`) so a build shipped against an older core still
 * degrades to the typed `EngineNotIntegratedError`.
 */
import {
  attemptToStabilityAttempt,
  buildDailyPlan,
  buildProbe,
  buildSessionSteps,
  classifyRecitation,
  computeSessionReport,
  computeStability,
  createSession,
  finishSession,
  groupIdFor,
  proposeGroups,
  segmentAyah,
  withAttempt,
  type AnchorWord,
  type ProbeAyah,
  type DailyPlan,
  type HifzSegment,
  type HifzTransition,
  type RecallAttempt,
  type VerseKey,
} from '@quran/core';
import type {
  AttemptDraft,
  ClassifiedAttempt,
  HifzContext,
  HifzEngine,
  ItemRecomputation,
  ProbeOutcome,
  ProbeRequest,
  SegmentationOutcome,
} from './hifzEngine';

/** The exact slice of `@quran/core` this adapter needs, verified before use. */
export const REQUIRED_HIFZ_EXPORTS = [
  'buildDailyPlan',
  'buildSessionSteps',
  'createSession',
  'withAttempt',
  'finishSession',
  'computeSessionReport',
  'classifyRecitation',
  'computeStability',
  'attemptToStabilityAttempt',
  'proposeGroups',
  'groupIdFor',
  'segmentAyah',
  'buildProbe',
] as const;

export interface CoreHifzModule {
  buildDailyPlan: typeof buildDailyPlan;
  buildSessionSteps: typeof buildSessionSteps;
  createSession: typeof createSession;
  withAttempt: typeof withAttempt;
  finishSession: typeof finishSession;
  computeSessionReport: typeof computeSessionReport;
  classifyRecitation: typeof classifyRecitation;
  computeStability: typeof computeStability;
  attemptToStabilityAttempt: typeof attemptToStabilityAttempt;
  proposeGroups: typeof proposeGroups;
  groupIdFor: typeof groupIdFor;
  segmentAyah: typeof segmentAyah;
  buildProbe: typeof buildProbe;
}

export function pickCoreHifzModule(
  core: Record<string, unknown>,
): { module: CoreHifzModule | null; missing: string[] } {
  const missing = REQUIRED_HIFZ_EXPORTS.filter((name) => typeof core[name] !== 'function');
  if (missing.length > 0) return { module: null, missing };
  return { module: core as unknown as CoreHifzModule, missing: [] };
}

/** Keys come straight out of the database, where they are `chapter:verse`. */
const vk = (key: string): VerseKey => key as VerseKey;

/** Words the learner was expected to produce, in ayah order — text never altered. */
function expectedWords(ctx: HifzContext, verseKey: string | null): string[] {
  if (!verseKey) return [];
  const ayah = ctx.ayahs.find((a) => a.verseKey === verseKey);
  if (!ayah) return [];
  if (ayah.words && ayah.words.length > 0) {
    return ayah.words.filter((w) => !w.isEndOfAyahMark).map((w) => w.textUthmani);
  }
  return ayah.textUthmani.split(/\s+/).filter((t) => t.length > 0);
}

function attemptsFor(ctx: HifzContext, itemId: string): RecallAttempt[] {
  return ctx.attempts.filter((a) => a.itemId === itemId);
}

function textOf(ctx: HifzContext, verseKey: string | null): string {
  if (!verseKey) return '';
  return ctx.ayahs.find((a) => a.verseKey === verseKey)?.textUthmani ?? '';
}

function wordRowsOf(ctx: HifzContext, verseKey: string | null) {
  if (!verseKey) return null;
  return ctx.ayahs.find((a) => a.verseKey === verseKey)?.words ?? null;
}

/** Next ayah in mushaf order — the only continuation the data actually supports. */
function nextVerseKeyOf(ctx: HifzContext, verseKey: string | null): string | null {
  if (!verseKey) return null;
  const index = ctx.ayahs.findIndex((a) => a.verseKey === verseKey);
  if (index < 0 || index + 1 >= ctx.ayahs.length) return null;
  return ctx.ayahs[index + 1]!.verseKey;
}

/**
 * The ayahs that follow any of this item's known confusions — used to name a
 * wrong transition instead of reporting a generic mismatch.
 */
function continuationsFor(ctx: HifzContext, verseKey: string | null) {
  const keys = new Set<string>();
  for (const item of ctx.items) {
    if (item.verseKey !== verseKey) continue;
    for (const key of item.sequence) keys.add(key);
  }
  const groupKeys = ctx.confusionGroups
    .filter((g) => g.verseKeys.includes(verseKey ?? ''))
    .flatMap((g) => g.verseKeys);
  for (const key of groupKeys) keys.add(key);
  const out: { verseKey: string; words: string[] }[] = [];
  for (const key of keys) {
    const next = nextVerseKeyOf(ctx, key);
    if (!next) continue;
    out.push({ verseKey: next, words: expectedWords(ctx, next).slice(0, 6) });
  }
  return out;
}

export function createCoreHifzEngine(module?: CoreHifzModule): HifzEngine {
  const core: CoreHifzModule = module ?? {
    buildDailyPlan,
    buildSessionSteps,
    createSession,
    withAttempt,
    finishSession,
    computeSessionReport,
    classifyRecitation,
    computeStability,
    attemptToStabilityAttempt,
    proposeGroups,
    groupIdFor,
    segmentAyah,
    buildProbe,
  };

  const planInput = (ctx: HifzContext) => ({
    nowIso: ctx.now,
    items: ctx.items,
    attempts: ctx.attempts,
    segments: ctx.segments,
    transitions: ctx.transitions,
    confusionGroups: ctx.confusionGroups,
    newAyahs: ctx.newAyahs,
    newAyahWordCounts: ctx.newAyahWordCounts,
  });

  return {
    version: 1,
    detail: 'core/src/hifz (deterministic memory engine, adapter v1)',

    dailyPlan(ctx) {
      return core.buildDailyPlan(planInput(ctx)) as DailyPlan;
    },

    startSession(ctx, plannedSteps) {
      const plan = core.buildDailyPlan(planInput(ctx));
      const ayahs = ctx.items.map((item) => ({
        itemId: item.id,
        verseKey: item.verseKey,
        text: textOf(ctx, item.verseKey),
      }));
      for (const item of ctx.items) {
        for (const key of item.sequence) {
          if (ayahs.some((a) => a.verseKey === key)) continue;
          const itemId = ctx.items.find((i) => i.sequence.includes(key))?.id ?? item.id;
          ayahs.push({ itemId, verseKey: key, text: textOf(ctx, key) });
        }
      }
      const steps = core.buildSessionSteps({
        plan,
        items: ctx.items,
        ayahs,
        attempts: ctx.attempts,
        segments: ctx.segments,
        transitions: ctx.transitions,
        confusionGroups: ctx.confusionGroups,
        nowIso: ctx.now,
        ...(plannedSteps > 0 ? { phaseCap: plannedSteps } : {}),
      });
      const id = `sess-${ctx.now.replace(/[:.]/g, '-')}`;
      return core.createSession({ id, startedAt: ctx.now, steps });
    },

    classify(ctx, draft: AttemptDraft): ClassifiedAttempt {
      const result = core.classifyRecitation({
        expected: expectedWords(ctx, draft.verseKey),
        produced: draft.produced.map((w) => w.text),
        mode: draft.mode,
        itemId: draft.itemId,
        verseKey: draft.verseKey,
        confusionCandidates: draft.confusionCandidates ?? [],
        continuations: draft.continuations ?? continuationsFor(ctx, draft.verseKey),
        segments: ctx.segments
          .filter((s) => s.itemId === draft.itemId)
          .map((s) => ({ position: s.position, fromWord: s.fromWord, toWord: s.toWord })),
        span: draft.expectedSpan ?? null,
      });
      return {
        expectedWordCount: result.expectedWordCount,
        correctWordCount: result.correctWordCount,
        accuracy: result.accuracy,
        errors: result.errors.filter((e) => e.kind !== 'correct'),
      };
    },

    recomputeItems(ctx, itemIds) {
      const out: ItemRecomputation[] = [];
      for (const itemId of itemIds) {
        const item = ctx.items.find((i) => i.id === itemId);
        if (!item) continue;
        const attempts = attemptsFor(ctx, itemId);
        const result = core.computeStability({
          nowIso: ctx.now,
          addedAt: item.addedAt,
          lastReviewedAt: item.lastReviewedAt,
          storedNextReviewAt: item.nextReviewAt,
          attempts: attempts.map((a) => core.attemptToStabilityAttempt(a)),
        });
        const last = attempts[attempts.length - 1];
        out.push({
          itemId,
          band: result.band,
          stability: result.stability,
          strength: result.strength,
          lastReviewedAt: last ? (last.completedAt ?? last.startedAt) : item.lastReviewedAt,
          nextReviewAt: result.nextReviewAt,
          attemptCount: result.attemptCount,
          errorCount: attempts.reduce((sum, a) => sum + a.errors.filter((e) => e.kind !== 'correct').length, 0),
        });
      }
      return out;
    },

    sessionReport(ctx, sessionId) {
      const sessionAttempts = ctx.attempts.filter((a) => a.sessionId === sessionId);
      const startedAt = sessionAttempts[0]?.startedAt ?? ctx.now;
      return core.computeSessionReport({
        nowIso: ctx.now,
        attempts: sessionAttempts,
        items: ctx.items,
        priorAttempts: ctx.attempts.filter((a) => a.sessionId !== sessionId && a.startedAt < startedAt),
        segments: ctx.segments,
        transitions: ctx.transitions,
      });
    },

    proposeConfusionGroups(ctx) {
      return core.proposeGroups({
        attempts: ctx.attempts,
        createdAt: ctx.now,
        existing: ctx.confusionGroups,
      });
    },

    probe(ctx, request: ProbeRequest): ProbeOutcome {
      if (!request.verseKey) return { probe: null, reason: 'no-step-ayah' };
      const text = textOf(ctx, request.verseKey);
      if (text.length === 0) return { probe: null, reason: 'ayah-text-not-installed' };
      const ayah = {
        itemId: request.itemId,
        verseKey: vk(request.verseKey),
        text,
        words: wordRowsOf(ctx, request.verseKey),
      };
      const nextKey = request.nextVerseKey ?? nextVerseKeyOf(ctx, request.verseKey);
      const next: ProbeAyah | undefined = nextKey
        ? {
            itemId: null,
            verseKey: vk(nextKey),
            text: textOf(ctx, nextKey),
            words: wordRowsOf(ctx, nextKey),
          }
        : undefined;

      let segment: HifzSegment | undefined;
      if (request.mode === 'segment') {
        // Segments are structure, not state: they come from core's boundary
        // rules over the authoritative text, which is why they are derived here
        // instead of being stored with a stability value nothing keeps current.
        const stored = ctx.segments.filter((row) => row.itemId === request.itemId);
        const segments = stored.length > 0 ? stored : core.segmentAyah({
          itemId: request.itemId ?? '',
          verseKey: request.verseKey,
          text,
          words: wordRowsOf(ctx, request.verseKey),
          nextVerseKey: request.nextVerseKey ?? nextVerseKeyOf(ctx, request.verseKey),
        }).segments;
        segment =
          (request.segmentPosition !== undefined
            ? segments.find((row) => row.position === request.segmentPosition)
            : undefined) ??
          segments.reduce<HifzSegment | undefined>(
            (weakest, row) => (weakest === undefined || row.stability < weakest.stability ? row : weakest),
            undefined,
          );
        if (!segment) return { probe: null, reason: 'item-has-no-segments' };
      }
      if ((request.mode === 'transition' || request.mode === 'continue-sequence' || request.mode === 'full-sequence') && !next) {
        return { probe: null, reason: 'no-next-ayah' };
      }
      const boundary = request.itemId
        ? ctx.transitions.find((t) => t.itemId === request.itemId && t.kind === 'intra')?.toWord
        : undefined;

      try {
        const probe = core.buildProbe(request.mode, {
          ayah,
          next,
          segment,
          ayahs: next ? [ayah, next] : [ayah],
          seed: `${request.seed}:${request.verseKey}`,
          ...(boundary !== undefined ? { boundaryWord: boundary, transitionKind: 'intra' as const } : { transitionKind: 'inter' as const }),
          ...(request.audioPackId ? { audioPackId: request.audioPackId } : {}),
        });
        return { probe, reason: null };
      } catch (err) {
        return { probe: null, reason: `probe-builder-threw:${String(err)}` };
      }
    },

    segmentItem(ctx, itemId, nextVerseKey): SegmentationOutcome | null {
      const item = ctx.items.find((i) => i.id === itemId);
      if (!item) return null;
      const text = textOf(ctx, item.verseKey);
      if (text.length === 0) return null;
      const result = core.segmentAyah({
        itemId,
        verseKey: item.verseKey,
        text,
        words: wordRowsOf(ctx, item.verseKey),
        nextVerseKey: nextVerseKey ?? item.sequence[1] ?? null,
      });
      return {
        segments: result.segments,
        anchors: result.anchors,
        transitions: result.transitions,
        wordCount: result.wordCount,
        notes: result.notes,
      };
    },

    recordStepAttempt(session, stepIndex, attemptId, completedAt) {
      return core.withAttempt(session, stepIndex, attemptId, completedAt);
    },

    closeSession(session, endedAt, report) {
      return core.finishSession(session, endedAt, report);
    },
  };
}
