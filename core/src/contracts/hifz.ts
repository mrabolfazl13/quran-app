/**
 * Hifz / Memory Engine contracts.
 *
 * The engine is deterministic and text-algorithm based: no LLM is involved in
 * scoring a recitation. Everything below must be computable from the Quran
 * text plus the user's own attempt history.
 */

export const HIFZ_SCHEMA_VERSION = 1;

export type RecallMode =
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
  | 'full-sequence';

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
  /** 0..1 composite recall estimate, recomputed from attempts. */
  stability: number;
  strength: number;
  lastReviewedAt: string | null;
  nextReviewAt: string | null;
  attemptCount: number;
  errorCount: number;
}

export interface HifzSegment {
  id: string;
  itemId: string;
  /** 0-based index within the ayah. */
  position: number;
  /** Word positions covered, inclusive, 1-based against the ayah word list. */
  fromWord: number;
  toWord: number;
  /** Arabic segment text, sliced from the authoritative ayah text. */
  text: string;
  /** Short meaning label; editorial, never presented as tafsir. */
  meaningFa: string | null;
  meaningSource: string | null;
  stability: number;
  errorCount: number;
}

export interface AnchorWord {
  id: string;
  itemId: string;
  /** 1-based word position in the ayah. */
  wordPosition: number;
  text: string;
  /** Anchor roles: opening, closing, or a segment boundary word. */
  role: 'opening' | 'middle' | 'ending' | 'boundary';
  stability: number;
}

export interface HifzTransition {
  id: string;
  itemId: string;
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
  segmentPosition: number | null;
  explanation: string;
}

export interface RecallAttempt {
  id: string;
  itemId: string;
  verseKey: string;
  sessionId: string | null;
  mode: RecallMode;
  startedAt: string;
  completedAt: string | null;
  /** Words the user produced, in order. */
  produced: RecitedWord[];
  /** Cue that was shown (anchor text, first word, audio, …) or null for free recall. */
  cue: { kind: string; text: string | null } | null;
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
  weakSegments: { itemId: string; segmentPosition: number; accuracy: number }[];
  weakTransitions: { itemId: string; toWord: number; stability: number }[];
  confusedVerseKeys: string[];
  repeatedErrors: { kind: ErrorKind; count: number }[];
  recommendedNextReviewAt: string | null;
  stabilityChanges: { itemId: string; before: number; after: number }[];
}
