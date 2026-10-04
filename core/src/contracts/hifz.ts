/**
 * Hifz / Memory Engine contracts.
 *
 * The engine is deterministic and text-algorithm based: no LLM is involved in
 * scoring a recitation. Everything below must be computable from the Quran
 * text plus the user's own attempt history.
 */

export const HIFZ_SCHEMA_VERSION = 1;

/**
 * Which of the two memory axes an attempt scores.
 *
 * `form` is the verbatim sound-shape of the revelation: the cue is Arabic and
 * the learner produces Arabic. `meaning` is the conceptual binding: the cue is a
 * licensed meaning (a word gloss or a translation) and the learner produces
 * Arabic, or the cue is Arabic and the learner produces the meaning.
 *
 * The split exists because they are separate memories that fail separately, and
 * a learner who has only the first one has memorised sounds, not the ayah. Both
 * axes are graded by deterministic text comparison; neither asks a model
 * anything.
 */
export type RecallDimension = 'form' | 'meaning';

export type RecallMode =
  /* ---- form axis: the cue is Arabic, the answer is Arabic ---- */
  | 'segment'
  | 'opening'
  | 'middle'
  | 'ending'
  | 'transition'
  | 'continue-ayah'
  | 'continue-sequence'
  | 'missing-word'
  | 'first-word-cue'
  | 'last-word-cue'
  | 'reverse'
  | 'random'
  | 'audio-recall'
  | 'full-ayah'
  | 'full-sequence'
  /* ---- meaning axis: the cue is a licensed meaning, the answer is Arabic ---- */
  | 'meaning-to-arabic'
  | 'concept-cue';

/** The mode's axis, derived from the mode so no caller can mislabel an attempt. */
export const RECALL_DIMENSION: Readonly<Record<RecallMode, RecallDimension>> = {
  segment: 'form',
  opening: 'form',
  middle: 'form',
  ending: 'form',
  transition: 'form',
  'continue-ayah': 'form',
  'continue-sequence': 'form',
  'missing-word': 'form',
  'first-word-cue': 'form',
  'last-word-cue': 'form',
  reverse: 'form',
  random: 'form',
  'audio-recall': 'form',
  'full-ayah': 'form',
  'full-sequence': 'form',
  'meaning-to-arabic': 'meaning',
  'concept-cue': 'meaning',
};

export const RECALL_MODES = Object.keys(RECALL_DIMENSION) as RecallMode[];

/**
 * Every mode the shipped schema accepts, in DDL order. `core/src/contracts/db.sql`
 * repeats this list inside a CHECK constraint; `tests/integration` asserts the
 * two stay identical, because a mode accepted by TypeScript and refused by
 * SQLite is a stored attempt that vanishes on the next device run.
 */
export const RECALL_MODE_SQL_LIST: readonly RecallMode[] = RECALL_MODES;

export type ErrorKind =
  | 'correct'
  | 'omission'
  | 'substitution'
  | 'repetition'
  | 'wrong-order'
  | 'wrong-transition'
  | 'similar-ayah-confusion'
  | 'beginning-failure'
  | 'middle-failure'
  | 'ending-failure';

export type StabilityBand = 'new' | 'unstable' | 'weak' | 'stable' | 'mastered';

export type HifzItemStatus = 'active' | 'paused' | 'graduated' | 'dropped';

/** One memorisation target: a single ayah, or a bound sequence start. */
export interface HifzItem {
  id: string;
  verseKey: string;
  /** Ordered ayahs when the item is a sequence; length 1 for a single ayah. */
  sequence: string[];
  addedAt: string;
  status: HifzItemStatus;
  band: StabilityBand;
  /**
   * Composite estimate the band is read from: the **weaker** of the two axes.
   * An ayah whose sound-shape is perfect and whose meaning is blank is not
   * memorised, it is recited, so the composite never averages the axes away.
   *
   * `null` on the meaning axis means *never tested*, not *tested and failed*, so
   * it is left out of the minimum entirely: `meaningStability === null` gives
   * `stability = formStability`. Treating an untested axis as zero would drop
   * every migrated item to the bottom band for a test the learner was never
   * given, which is a fabricated number in the other direction.
   */
  stability: number;
  /** Verbatim recall: Arabic cued by Arabic. 0..1, recomputed from `form` attempts. */
  formStability: number;
  /** Conceptual recall: Arabic cued by a licensed meaning. Null until a meaning attempt exists. */
  meaningStability: number | null;
  strength: number;
  lastReviewedAt: string | null;
  nextReviewAt: string | null;
  attemptCount: number;
  errorCount: number;
}

/**
 * What a chunk of an ayah means, and exactly where that meaning came from.
 *
 * The text is never written by this app: it is a slice of a licensed content
 * pack, addressed by `packId`. A meaning the app cannot source is `null` — the
 * meaning axis then declines to test that segment rather than inventing a
 * gloss for revealed text.
 */
export interface SegmentMeaning {
  text: string;
  /** Language of `text`, taken from the pack that carries it. */
  lang: 'fa' | 'ar' | 'en';
  /** Content pack id the text was read from, e.g. `word-data` or `tr-fa-kaldari`. */
  packId: string;
  /** True when the chunk's meaning is the joined glosses of its own word rows. */
  wordGloss: boolean;
}

export interface HifzSegment {
  id: string;
  itemId: string;
  /**
   * The ayah this chunk tiles. Every fingerprint row names it: `position`,
   * `fromWord` and `toWord` all count from the start of *this* ayah, so without
   * it a two-ayah item cannot tell whose chunk it is looking at. It is the second
   * half of the row's identity — `id` embeds it, and the store's UNIQUE key is
   * (item, verse key, position).
   */
  verseKey: string;
  /** 0-based index within the ayah named by `verseKey`. */
  position: number;
  /** Word positions covered, inclusive, 1-based against this ayah's word list. */
  fromWord: number;
  toWord: number;
  /** Arabic segment text, sliced from the authoritative ayah text. */
  text: string;
  /** Meaning of this chunk from a licensed pack; null when no pack covers it. */
  meaning: SegmentMeaning | null;
  /** Per-chunk recall on the form axis, 0..1. */
  stability: number;
  /** Per-chunk recall on the meaning axis, 0..1. Null until a meaning attempt exists. */
  meaningStability: number | null;
  errorCount: number;
}

export interface AnchorWord {
  id: string;
  itemId: string;
  /** The ayah `wordPosition` counts through; part of the row's identity. */
  verseKey: string;
  /** 1-based word position within `verseKey`. */
  wordPosition: number;
  text: string;
  /** Anchor roles: opening, closing, or a segment boundary word. */
  role: 'opening' | 'middle' | 'ending' | 'boundary';
  stability: number;
}

export interface HifzTransition {
  id: string;
  itemId: string;
  /**
   * The ayah the transition is *at*: for `intra` the ayah holding the boundary,
   * for `inter` the ayah being left. `toWord` is a word position inside it.
   */
  verseKey: string;
  /** Boundary between `toPosition`-1 and `toPosition` within one ayah. */
  kind: 'intra' | 'inter';
  /** Verse key of the following ayah for inter-ayah transitions. */
  toVerseKey: string | null;
  toWord: number;
  successCount: number;
  failureCount: number;
  stability: number;
  lastPracticedAt: string | null;
}

export interface RecitedWord {
  position: number;
  text: string;
}

export interface DetectedError {
  kind: ErrorKind;
  /** Word position in the expected ayah where the error surfaces. */
  expectedPosition: number;
  expected: string | null;
  actual: string | null;
  /** Confused partner ayah for `similar-ayah-confusion`. */
  confusedWithVerseKey: string | null;
  /**
   * Which chunk of the graded ayah holds this error — the `position` of the
   * segment inside `RecallAttempt.verseKey`, never an item-wide index. A caller
   * that wants the segment row needs (itemId, attempt.verseKey, segmentPosition).
   */
  segmentPosition: number | null;
  explanation: string;
}

export interface RecallAttempt {
  id: string;
  itemId: string;
  verseKey: string;
  sessionId: string | null;
  mode: RecallMode;
  /** Which axis this attempt strengthens. Derived from the mode, never passed in. */
  dimension: RecallDimension;
  startedAt: string;
  completedAt: string | null;
  /** Words the user produced, in order. */
  produced: RecitedWord[];
  /** Cue that was shown (anchor text, first word, audio, …) or null for free recall. */
  cue: { kind: string; text: string | null; lang?: string; packId?: string } | null;
  expectedWordCount: number;
  correctWordCount: number;
  /** correctWordCount / expectedWordCount. */
  accuracy: number;
  errors: DetectedError[];
  durationMs: number | null;
  /** Self-reported confidence 1..5, or null when not given. */
  selfConfidence: number | null;
  /** Whether the user heard audio before recalling. */
  usedAudio: boolean;
}

export interface ConfusionGroup {
  id: string;
  label: string | null;
  /** Created by the user, or proposed by the engine from attempt history. */
  origin: 'user' | 'engine';
  verseKeys: string[];
  createdAt: string;
  lastTriggeredAt: string | null;
  /** Group reviews get a priority boost proportional to this. */
  confusionCount: number;
}

export interface ReviewPlanEntry {
  itemId: string;
  verseKey: string;
  reason: string;
  /** Raw priority before ordering; exposed for UI transparency. */
  priority: number;
  factors: Record<string, number>;
  suggestedMode: RecallMode;
  dueAt: string;
}

export interface DailyPlan {
  date: string;
  newAyahs: string[];
  reviewItems: ReviewPlanEntry[];
  weakItems: ReviewPlanEntry[];
  confusionGroups: string[];
  estimatedMinutes: number;
}

export interface SessionStep {
  mode: RecallMode;
  verseKey: string | null;
  itemId: string | null;
  attemptId: string | null;
  completedAt: string | null;
}

export interface HifzSession {
  id: string;
  startedAt: string;
  endedAt: string | null;
  plannedSteps: number;
  steps: SessionStep[];
  report: SessionReport | null;
}

export interface SessionReport {
  overallRecall: number;
  newItemsLearned: number;
  reviewsCompleted: number;
  /** A chunk of one ayah, named by verse key: positions restart per ayah. */
  weakSegments: { itemId: string; verseKey: string; segmentPosition: number; accuracy: number }[];
  weakTransitions: { itemId: string; verseKey: string; toWord: number; stability: number }[];
  confusedVerseKeys: string[];
  repeatedErrors: { kind: ErrorKind; count: number }[];
  recommendedNextReviewAt: string | null;
  stabilityChanges: { itemId: string; before: number; after: number }[];
}
