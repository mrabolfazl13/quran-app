/**
 * HifzEngine — the boundary between the hifz UI and the memory engine.
 *
 * The UI layer never scores recall, schedules review or decides stability
 * bands: it renders exactly what this interface returns. The implementation is
 * `createCoreHifzEngine()` in `./coreHifzEngine.ts`, which is a thin adapter
 * over the pure functions in `core/src/hifz` (which in turn reuse
 * `core/src/normalize` for every "is this the same word?" decision).
 *
 * Design rules (AGENTS.md, docs/architecture.md):
 *   • framework-free and pure: no clock reads — every timestamp is passed in
 *     on `HifzContext.now`;
 *   • deterministic: the same rows + the same `now` produce the same plan;
 *   • text is read-only input: the engine may slice ayah text into segments,
 *     it may never rewrite it;
 *   • no invented content: if a value cannot be derived from stored rows the
 *     engine returns nothing and the UI says so.
 *
 * If the adapter's required core exports are missing (an app build shipped
 * against an older `@quran/core`), `loadHifzEngine()` reports it and every hifz
 * screen renders the typed `EngineNotIntegratedError` instead of guessing.
 */
import type {
  AnchorWord,
  CandidateAyah,
  ConfusionGroup,
  DailyPlan,
  DetectedError,
  HifzItem,
  HifzSegment,
  HifzSession,
  HifzTransition,
  RecallAttempt,
  RecallMode,
  RecitedWord,
  RecallProbe,
  SessionReport,
  AyahWord,
} from '@quran/core';

/** Immutable snapshot of everything the engine may consider, passed per call. */
export interface HifzContext {
  /** ISO timestamp the engine must treat as "now" — it never reads a clock. */
  now: string;
  items: HifzItem[];
  segments: HifzSegment[];
  anchors: AnchorWord[];
  transitions: HifzTransition[];
  attempts: RecallAttempt[];
  confusionGroups: ConfusionGroup[];
  /** Authoritative ayah text, sliced from the imported mushaf, in mushaf order. */
  ayahs: HifzContextAyah[];
  /**
   * verseKeys queued as new learning today, in mushaf order: active items that
   * have never been attempted. Derived from stored rows, never assumed.
   */
  newAyahs: string[];
  /** Words per new ayah, so the plan's cost model is measured not guessed. */
  newAyahWordCounts: Record<string, number>;
}

export interface HifzContextAyah {
  verseKey: string;
  textUthmani: string;
  wordCount: number;
  /** Word rows when a word pack is installed for this ayah, else null. */
  words?: AyahWord[] | null;
}

export interface AttemptDraft {
  itemId: string;
  verseKey: string;
  sessionId: string | null;
  mode: RecallMode;
  produced: RecitedWord[];
  cue: { kind: string; text: string | null } | null;
  startedAt: string;
  completedAt: string;
  durationMs: number | null;
  selfConfidence: number | null;
  usedAudio: boolean;
  /** Similar ayahs (mutashabihat pack) so cross-ayah confusion can be detected. */
  confusionCandidates?: CandidateAyah[];
  /** Known continuations so a wrong transition can be named. */
  continuations?: CandidateAyah[];
  /**
   * The word range the step's probe actually cued, in ayah-absolute positions.
   * Filled from the probe the facade re-derives for the step — never from the
   * screen — so grading covers what the engine asked for.
   */
  expectedSpan?: { fromWord: number; toWord: number } | null;
}

export interface ClassifiedAttempt {
  expectedWordCount: number;
  correctWordCount: number;
  accuracy: number;
  errors: DetectedError[];
}

export interface ItemRecomputation {
  itemId: string;
  band: HifzItem['band'];
  stability: number;
  strength: number;
  lastReviewedAt: string | null;
  nextReviewAt: string | null;
  attemptCount: number;
  errorCount: number;
}

/** What the runner asks the engine for: the cue shown for one session step. */
export interface ProbeRequest {
  mode: RecallMode;
  verseKey: string | null;
  itemId: string | null;
  /** The ayah that follows `verseKey`, for transition/sequence modes. */
  nextVerseKey?: string | null;
  /** Segment index for `segment` mode; defaults to the weakest stored one. */
  segmentPosition?: number;
  /** Deterministic seed source (session id + step index), never Math.random. */
  seed: string;
  /** Installed audio pack id, when there is one. */
  audioPackId?: string | null;
}

export interface ProbeOutcome {
  probe: RecallProbe | null;
  /** Machine-readable reason code (i18n maps it), or null when a probe exists. */
  reason: string | null;
}

/** Segmentation rows produced when an ayah joins the hifz list. */
export interface SegmentationOutcome {
  segments: HifzSegment[];
  anchors: AnchorWord[];
  transitions: HifzTransition[];
  wordCount: number;
  notes: string[];
}

export interface HifzEngine {
  /** Engine version, reported verbatim on the Data health screen. */
  readonly version: number;
  /** Human description of what backs the engine, e.g. `core/src/hifz`. */
  readonly detail: string;
  /** Today's mission: new ayahs, due reviews, weak items, confusion work. */
  dailyPlan(ctx: HifzContext): DailyPlan;
  /** Build the ordered step list for a session from the plan. */
  startSession(ctx: HifzContext, plannedSteps: number): HifzSession;
  /** Score one recitation against the authoritative text. */
  classify(ctx: HifzContext, draft: AttemptDraft): ClassifiedAttempt;
  /** Recompute an item's band/stability/next review after new attempts. */
  recomputeItems(ctx: HifzContext, itemIds: string[]): ItemRecomputation[];
  /** Session roll-up, computed from the attempts in `ctx` only. */
  sessionReport(ctx: HifzContext, sessionId: string): SessionReport;
  /** Propose confusion pairs from history; `origin` is always `engine`. */
  proposeConfusionGroups(ctx: HifzContext): ConfusionGroup[];
  /** The cue for one step, built by core's probe builders. */
  probe(ctx: HifzContext, request: ProbeRequest): ProbeOutcome;
  /** Segment a stored item's ayah with core's boundary rules. */
  segmentItem(ctx: HifzContext, itemId: string, nextVerseKey?: string | null): SegmentationOutcome | null;
  /** Attach a recorded attempt to a session step without mutating the session. */
  recordStepAttempt(
    session: HifzSession,
    stepIndex: number,
    attemptId: string,
    completedAt: string,
  ): HifzSession;
  /** Close a session and attach the report core computed for it. */
  closeSession(session: HifzSession, endedAt: string, report: SessionReport): HifzSession;
}

export class EngineNotIntegratedError extends Error {
  readonly code = 'HIFZ_ENGINE_NOT_INTEGRATED' as const;

  constructor(detail: string) {
    super(
      `The Hifz memory engine is not available in this build. ${detail} ` +
        'Recall scoring, review scheduling and stability come from core/src/hifz — ' +
        'the desktop UI will not fake them.',
    );
    this.name = 'EngineNotIntegratedError';
  }
}

export interface EngineLoadResult {
  engine: HifzEngine | null;
  /** What was tried and why it failed — surfaced in the UI error state. */
  detail: string;
}

/**
 * Resolve the engine from `@quran/core`. The capability check happens at
 * runtime against the exports listed in `REQUIRED_HIFZ_EXPORTS`, so an older
 * core degrades to the typed error instead of half-working.
 */
export async function loadHifzEngine(): Promise<EngineLoadResult> {
  try {
    const core = (await import('@quran/core')) as Record<string, unknown>;
    const { createCoreHifzEngine, pickCoreHifzModule } = await import('./coreHifzEngine');
    const { module, missing } = pickCoreHifzModule(core);
    if (module === null) {
      return {
        engine: null,
        detail: `@quran/core is missing the hifz exports ${missing.join(', ')}.`,
      };
    }
    const engine = createCoreHifzEngine(module);
    return { engine, detail: engine.detail };
  } catch (err) {
    return { engine: null, detail: `importing @quran/core failed: ${String(err)}` };
  }
}
