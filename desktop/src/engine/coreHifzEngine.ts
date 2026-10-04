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
  applyAttemptToStoredSegments,
  applyAttemptToStoredTransitions,
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
  type FingerprintAttemptView,
  type HifzSegment,
  type HifzTransition,
  type RecallAttempt,
  type SegmentMeaning,
  type VerseKey,
} from '@quran/core';
import type {
  AttemptDraft,
  ClassifiedAttempt,
  FingerprintUpdate,
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
  'applyAttemptToStoredSegments',
  'applyAttemptToStoredTransitions',
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
  applyAttemptToStoredSegments: typeof applyAttemptToStoredSegments;
  applyAttemptToStoredTransitions: typeof applyAttemptToStoredTransitions;
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

/** The ayah before this one in mushaf order — what a concept cue is built from. */
function prevVerseKeyOf(ctx: HifzContext, verseKey: string | null): string | null {
  if (!verseKey) return null;
  const index = ctx.ayahs.findIndex((a) => a.verseKey === verseKey);
  if (index <= 0) return null;
  return ctx.ayahs[index - 1]!.verseKey;
}

/**
 * The licensed meaning of one ayah, as core's `SegmentMeaning`.
 *
 * A meaning the app cannot attribute is not a meaning: the text, the pack it came
 * from and its language all have to be present, or the caller gets null and the
 * meaning axis stays unprobed for that ayah.
 */
function meaningOf(ctx: HifzContext, verseKey: string | null): SegmentMeaning | null {
  if (!verseKey) return null;
  return ctx.meanings[verseKey] ?? null;
}

/**
 * Meaning rows for the ayahs a session touches. `previousMeaning` is the mushaf
 * predecessor's licensed meaning, so a concept cue only ever asks the learner to
 * continue from a sense this install actually has.
 */
function meaningRows(ctx: HifzContext, verseKeys: readonly string[]) {
  const out: { verseKey: string; meaning: SegmentMeaning | null; previousMeaning: SegmentMeaning | null }[] = [];
  const seen = new Set<string>();
  for (const verseKey of verseKeys) {
    if (seen.has(verseKey)) continue;
    seen.add(verseKey);
    out.push({
      verseKey,
      meaning: meaningOf(ctx, verseKey),
      previousMeaning: meaningOf(ctx, prevVerseKeyOf(ctx, verseKey)),
    });
  }
  return out;
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
    applyAttemptToStoredSegments,
    applyAttemptToStoredTransitions,
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
    meanings: ctx.meanings,
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
        // Without this the meaning phases emit nothing at all, and the whole
        // conceptual axis of the method stays dark no matter how well the engine
        // implements it.
        meanings: meaningRows(ctx, ayahs.map((a) => a.verseKey)),
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
          // Only the ayah being recited: `position` restarts per ayah, so an
          // item-wide span list would let `segmentFor` attribute an error to a
          // chunk of a different ayah that happens to share the number.
          .filter((s) => s.itemId === draft.itemId && s.verseKey === draft.verseKey)
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
      const verseKey: string = request.verseKey;
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
      // Segments are structure, not state: they come from core's boundary rules
      // over the authoritative text, which is why they are derived here instead
      // of being stored with a stability value nothing keeps current. The word
      // gloss source makes each chunk's meaning the licensed `word-data` glosses
      // of exactly its own words — a meaning the app can attribute, or none.
      const segmentsOfItem = (): HifzSegment[] => {
        const stored = ctx.segments.filter((row) => row.itemId === request.itemId);
        if (stored.length > 0) return stored;
        const words = wordRowsOf(ctx, request.verseKey);
        return core.segmentAyah({
          itemId: request.itemId ?? '',
          verseKey,
          text,
          words,
          nextVerseKey: request.nextVerseKey ?? nextVerseKeyOf(ctx, request.verseKey),
          ...(words && words.length > 0 ? { wordGlossSource: true as const } : {}),
        }).segments;
      };
      const weakestOf = (rows: HifzSegment[]) =>
        rows.reduce<HifzSegment | undefined>(
          (weakest, row) => (weakest === undefined || row.stability < weakest.stability ? row : weakest),
          undefined,
        );

      if (request.mode === 'segment') {
        // The probe recites `verseKey`, so it is offered a chunk of that ayah.
        // Any numbering that ran past the ayah boundary is gone: the stored rows
        // carry their own `verseKey`, and `segmentPosition` counts inside it.
        const segments = segmentsOfItem().filter((row) => row.verseKey === verseKey);
        segment =
          (request.segmentPosition !== undefined
            ? segments.find((row) => row.position === request.segmentPosition)
            : undefined) ?? weakestOf(segments);
        if (!segment) return { probe: null, reason: 'item-has-no-segments' };
      }
      if ((request.mode === 'transition' || request.mode === 'continue-sequence' || request.mode === 'full-sequence') && !next) {
        return { probe: null, reason: 'no-next-ayah' };
      }
      const boundary = request.itemId
        ? ctx.transitions.find(
            (t) => t.itemId === request.itemId && t.verseKey === verseKey && t.kind === 'intra',
          )?.toWord
        : undefined;

      // The meaning axis is cued only by a meaning this install can attribute.
      // Anything else is an honest refusal the screen shows as a reason, never a
      // paraphrase invented here.
      let meaning: SegmentMeaning | null = null;
      let previousMeaning: SegmentMeaning | null = null;
      /** Set only for a chunk-scoped gloss cue: the span must be what it means. */
      let meaningSpan: { fromWord: number; toWord: number } | null = null;
      if (request.mode === 'meaning-to-arabic') {
        meaning = meaningOf(ctx, request.verseKey);
        if (meaning === null) {
          // No ayah-level clause: fall back to the chunk's own licensed gloss, so
          // a segment-scoped meaning drill still has a cue. Its span is then
          // exactly the words that gloss covers — grading the whole ayah against
          // a three-word meaning would fail the learner for words nobody asked.
          segment = segment ?? weakestOf(segmentsOfItem());
          if (!segment || !segment.meaning) {
            return { probe: null, reason: 'no-licensed-meaning-for-ayah' };
          }
          meaning = segment.meaning;
          meaningSpan = { fromWord: segment.fromWord, toWord: segment.toWord };
        }
      }
      if (request.mode === 'concept-cue') {
        previousMeaning = meaningOf(ctx, prevVerseKeyOf(ctx, request.verseKey));
        if (previousMeaning === null) return { probe: null, reason: 'no-licensed-meaning-for-previous-ayah' };
      }

      try {
        const probe = core.buildProbe(request.mode, {
          ayah,
          next,
          segment,
          ayahs: next ? [ayah, next] : [ayah],
          seed: `${request.seed}:${request.verseKey}`,
          ...(boundary !== undefined ? { boundaryWord: boundary, transitionKind: 'intra' as const } : { transitionKind: 'inter' as const }),
          ...(request.audioPackId ? { audioPackId: request.audioPackId } : {}),
          ...(meaning ? { meaning } : {}),
          ...(meaningSpan ? { meaningFromWord: meaningSpan.fromWord, meaningToWord: meaningSpan.toWord } : {}),
          ...(previousMeaning
            ? { previousMeaning, previousVerseKey: vk(prevVerseKeyOf(ctx, request.verseKey) ?? '') }
            : {}),
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
      const words = wordRowsOf(ctx, item.verseKey);
      const result = core.segmentAyah({
        itemId,
        verseKey: item.verseKey,
        text,
        words,
        nextVerseKey: nextVerseKey ?? item.sequence[1] ?? null,
        // Each chunk's meaning is the licensed gloss of exactly its own words,
        // attributed to the word pack, or the chunk stays meaning-less.
        ...(words && words.length > 0 ? { wordGlossSource: true as const } : {}),
      });
      return {
        segments: result.segments,
        anchors: result.anchors,
        transitions: result.transitions,
        wordCount: result.wordCount,
        notes: result.notes,
      };
    },

    fingerprintUpdate(ctx, attempt: FingerprintAttemptView): FingerprintUpdate {
      // Core keeps an untouched row as the very same object, so identity is how
      // "did this attempt move this row?" is read here — no field-by-field
      // comparison that a future column could slip past.
      const nextSegments = core.applyAttemptToStoredSegments(ctx.segments, attempt);
      const nextTransitions = core.applyAttemptToStoredTransitions(ctx.transitions, attempt);
      return {
        segments: nextSegments.filter((row, index) => row !== ctx.segments[index]),
        transitions: nextTransitions.filter((row, index) => row !== ctx.transitions[index]),
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
