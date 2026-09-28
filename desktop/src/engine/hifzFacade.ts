/**
 * HifzFacade — the only surface the hifz UI may call.
 *
 * It owns storage (read rows into a `HifzContext`, persist what the engine
 * returns) and nothing else. Every judgement — what is due, how a recitation
 * scored, which band an item belongs to, what a session report says — comes
 * from `core/src/hifz` through the adapter in `./coreHifzEngine.ts`.
 *
 * What is stored: hifz items, recall attempts, sessions, daily plans,
 * engine-proposed confusion groups.
 * What is NOT stored: segmentations. `core/src/hifz/review.ts` explicitly
 * estimates the segment/transition factors from item stability when a row set
 * is empty, and re-deriving them at read time is deterministic, so the facade
 * derives structure on demand (`deriveSegmentation`) instead of persisting
 * stability values it has no way to keep current.
 *
 * If the adapter's core exports are missing, each method rejects with the typed
 * `EngineNotIntegratedError` and the screens render that as an error state.
 * There is no fallback scoring in this file, or anywhere above it.
 */
import type {
  DailyPlan,
  HifzSession,
  RecallAttempt,
  RecallMode,
  RecitedWord,
  SessionReport,
  VerseKey,
} from '@quran/core';
import type { DataGateway } from '../gateway';
import {
  EngineNotIntegratedError,
  type AttemptDraft,
  type HifzContext,
  type HifzEngine,
  type ProbeOutcome,
  type SegmentationOutcome,
  loadHifzEngine,
} from './hifzEngine';

export interface HifzFacadeStatus {
  integrated: boolean;
  /** Engine version/detail when integrated, otherwise why it is not. */
  detail: string;
}

export interface RecallInput {
  itemId: string;
  verseKey: VerseKey;
  mode: RecallMode;
  sessionId: string | null;
  produced: RecitedWord[];
  cue?: { kind: string; text: string | null } | null;
  startedAt: string;
  durationMs?: number | null;
  selfConfidence?: number | null;
  usedAudio?: boolean;
  stepIndex?: number | null;
}

export interface StepProbe extends ProbeOutcome {
  stepIndex: number;
  mode: RecallMode;
  verseKey: string | null;
  itemId: string | null;
}

export interface HifzFacade {
  status(): Promise<HifzFacadeStatus>;
  /** Today's mission as computed by the engine from stored attempts. */
  todayPlan(now?: Date): Promise<DailyPlan>;
  startSession(now?: Date, plannedSteps?: number): Promise<HifzSession>;
  /** The cue for one step of a stored session, built by core's probe builders. */
  probeForStep(session: HifzSession, stepIndex: number, now?: Date): Promise<StepProbe>;
  /** Score one recitation and store the attempt the engine produced. */
  submitRecall(input: RecallInput, now?: Date): Promise<RecallAttempt>;
  finishSession(sessionId: string, now?: Date): Promise<SessionReport>;
  /** Engine-proposed confusion groups, persisted with `origin: 'engine'`. */
  refreshConfusionGroups(now?: Date): Promise<string[]>;
  /** Structure core derives for an item (segments/anchors/transitions). */
  deriveSegmentation(itemId: string, now?: Date): Promise<SegmentationOutcome | null>;
}

export function createHifzFacade(gateway: DataGateway): HifzFacade {
  let cached: { engine: HifzEngine | null; detail: string } | null = null;

  async function engine(now: Date): Promise<{ engine: HifzEngine; ctx: HifzContext }> {
    if (cached === null) cached = await loadHifzEngine();
    if (cached.engine === null) throw new EngineNotIntegratedError(cached.detail);
    const ctx = await buildContext(gateway, now);
    return { engine: cached.engine, ctx };
  }

  /** Similar ayahs from the installed mutashabihat data, as core expects them. */
  async function confusionCandidates(gateway: DataGateway, verseKey: VerseKey) {
    const pairs = await gateway.similarTo(verseKey, 8);
    const out: { verseKey: string; words: string[] }[] = [];
    for (const pair of pairs) {
      const other = pair.verseKeyA === verseKey ? pair.verseKeyB : pair.verseKeyA;
      const ayah = await gateway.ayah(other);
      if (ayah) out.push({ verseKey: other, words: ayah.textUthmani.split(/\s+/).filter((t) => t.length > 0) });
    }
    return out;
  }

  /**
   * The engine's probe for one step — cue *and* graded span from a single call.
   * The seed is the session id plus step index, so re-deriving it at grading
   * time yields exactly what the learner was shown.
   */
  async function stepProbe(
    e: HifzEngine,
    ctx: HifzContext,
    session: HifzSession,
    stepIndex: number,
  ): Promise<ProbeOutcome & { step: HifzSession['steps'][number] | undefined }> {
    const step = session.steps[stepIndex];
    if (!step) return { step: undefined, probe: null, reason: 'no-such-step' };
    const outcome = e.probe(ctx, {
      mode: step.mode,
      verseKey: step.verseKey,
      itemId: step.itemId,
      nextVerseKey: nextOfSequence(ctx, step),
      seed: `${session.id}:${stepIndex}`,
      audioPackId: await audioPackIdOf(gateway),
    });
    return { step, ...outcome };
  }

  return {
    async status() {
      const result = (cached ??= await loadHifzEngine());
      return { integrated: result.engine !== null, detail: result.detail };
    },

    async todayPlan(now = new Date()) {
      const { engine: e, ctx } = await engine(now);
      const plan = e.dailyPlan(ctx);
      await gateway.saveDailyPlan(plan.date, JSON.stringify(plan));
      return plan;
    },

    async startSession(now = new Date(), plannedSteps = 0) {
      const { engine: e, ctx } = await engine(now);
      const session = e.startSession(ctx, plannedSteps);
      await gateway.saveHifzSession(session);
      return session;
    },

    async probeForStep(session, stepIndex, now = new Date()) {
      const { engine: e, ctx } = await engine(now);
      const { step, probe, reason } = await stepProbe(e, ctx, session, stepIndex);
      return {
        stepIndex,
        mode: step?.mode ?? 'full-ayah',
        verseKey: step?.verseKey ?? null,
        itemId: step?.itemId ?? null,
        probe,
        reason,
      };
    },

    async submitRecall(input: RecallInput, now = new Date()) {
      const { engine: e, ctx } = await engine(now);
      const completedAt = now.toISOString();
      // The stored session is read once and reused for both the span and the
      // step record: nothing between the two writes touches the session rows.
      const stored =
        input.sessionId && input.stepIndex !== null && input.stepIndex !== undefined
          ? await gateway.hifzSessions(50)
          : [];
      const session = input.sessionId ? stored.find((s) => s.id === input.sessionId) : undefined;
      // What the step cued is what the step is graded on, taken from the engine's
      // own probe for this session and step index — never from the screen, and
      // only when that probe targets the ayah actually being recited.
      let expectedSpan: { fromWord: number; toWord: number } | null = null;
      if (session && input.stepIndex !== null && input.stepIndex !== undefined) {
        const { probe } = await stepProbe(e, ctx, session, input.stepIndex);
        if (probe && probe.verseKey === input.verseKey && probe.toWord >= probe.fromWord) {
          expectedSpan = { fromWord: probe.fromWord, toWord: probe.toWord };
        }
      }
      const draft: AttemptDraft = {
        itemId: input.itemId,
        verseKey: input.verseKey,
        sessionId: input.sessionId,
        mode: input.mode,
        produced: input.produced,
        cue: input.cue ?? null,
        startedAt: input.startedAt,
        completedAt,
        durationMs: input.durationMs ?? null,
        selfConfidence: input.selfConfidence ?? null,
        usedAudio: input.usedAudio ?? false,
        expectedSpan,
        confusionCandidates: await confusionCandidates(gateway, input.verseKey),
      };
      const scored = e.classify(ctx, draft);
      const attempt: RecallAttempt = {
        id: `att-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        itemId: draft.itemId,
        verseKey: draft.verseKey,
        sessionId: draft.sessionId,
        mode: draft.mode,
        startedAt: draft.startedAt,
        completedAt: draft.completedAt,
        produced: draft.produced,
        cue: draft.cue,
        expectedWordCount: scored.expectedWordCount,
        correctWordCount: scored.correctWordCount,
        accuracy: scored.accuracy,
        errors: scored.errors,
        durationMs: draft.durationMs,
        selfConfidence: draft.selfConfidence,
        usedAudio: draft.usedAudio,
      };
      await gateway.saveRecallAttempt(attempt);

      for (const next of e.recomputeItems(ctx, [draft.itemId])) {
        const item = ctx.items.find((i) => i.id === next.itemId);
        if (item && item.id === next.itemId) await gateway.upsertHifzItem({ ...item, ...next });
      }

      if (session && input.stepIndex !== undefined && input.stepIndex !== null) {
        await gateway.saveHifzSession(
          e.recordStepAttempt(session, input.stepIndex, attempt.id, completedAt),
        );
      }
      return attempt;
    },

    async finishSession(sessionId, now = new Date()) {
      const { engine: e, ctx } = await engine(now);
      const report = e.sessionReport(ctx, sessionId);
      const stored = await gateway.hifzSessions(50);
      const session = stored.find((s) => s.id === sessionId);
      if (session) await gateway.saveHifzSession(e.closeSession(session, now.toISOString(), report));
      for (const itemId of new Set(ctx.attempts.filter((a) => a.sessionId === sessionId).map((a) => a.itemId))) {
        for (const next of e.recomputeItems(ctx, [itemId])) {
          const item = ctx.items.find((i) => i.id === itemId);
          if (item) await gateway.upsertHifzItem({ ...item, ...next });
        }
      }
      return report;
    },

    async refreshConfusionGroups(now = new Date()) {
      const { engine: e, ctx } = await engine(now);
      const groups = e.proposeConfusionGroups(ctx);
      for (const group of groups) await gateway.saveConfusionGroup(group);
      return groups.map((g) => g.id);
    },

    async deriveSegmentation(itemId, now = new Date()) {
      const { engine: e, ctx } = await engine(now);
      return e.segmentItem(ctx, itemId);
    },
  };
}

/** The ayah after this step inside the item's own sequence, when it has one. */
function nextOfSequence(ctx: HifzContext, step: HifzSession['steps'][number]): string | null {
  if (!step.itemId || !step.verseKey) return null;
  const item = ctx.items.find((i) => i.id === step.itemId);
  if (!item) return null;
  const at = item.sequence.indexOf(step.verseKey);
  return at >= 0 && at + 1 < item.sequence.length ? item.sequence[at + 1]! : null;
}

/** Only an id if an audio pack really is installed — the runner never pretends. */
async function audioPackIdOf(gateway: DataGateway): Promise<string | null> {
  const packs = await gateway.packs();
  const audio = packs.find((p) => p.kind === 'audio');
  return audio ? audio.id : null;
}

/**
 * Assemble the engine's read-only world from stored rows. Timestamps are passed
 * in, never read inside the engine, so a scenario is reproducible.
 */
export async function buildContext(gateway: DataGateway, now: Date): Promise<HifzContext> {
  const [items, attempts, groups, segments, anchors, transitions, ayahRows] = await Promise.all([
    gateway.hifzItems(),
    gateway.recallAttempts(undefined, 5000),
    gateway.confusionGroups(),
    gateway.hifzSegments(),
    gateway.anchorWords(),
    gateway.hifzTransitions(),
    gateway.allAyahTexts(),
  ]);
  const ayahs = ayahRows.map((a) => ({
    verseKey: a.verseKey as string,
    textUthmani: a.textUthmani,
    wordCount: a.wordCount,
    words: null as null,
  }));
  const newAyahs = items
    .filter((i) => i.status === 'active' && i.band === 'new' && i.attemptCount === 0)
    .map((i) => i.verseKey);
  const wordCounts: Record<string, number> = {};
  for (const a of ayahs) if (newAyahs.includes(a.verseKey)) wordCounts[a.verseKey] = a.wordCount;
  return {
    now: now.toISOString(),
    items,
    attempts,
    confusionGroups: groups,
    segments,
    anchors,
    transitions,
    ayahs,
    newAyahs,
    newAyahWordCounts: wordCounts,
  };
}
