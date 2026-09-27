/**
 * Row shapes stored inside `BackupUserData` arrays.
 *
 * Most tables already have a contract interface (`core/src/contracts`); the
 * backup re-uses it verbatim. A few user tables have no contract interface
 * (journeys, reflections) or need backup-only fields (derived ids, plan
 * generation timestamps); those are defined here. `db.sql` column names map
 * snake_case ↔ camelCase in `restore.ts`.
 */

import type { BackupUserData } from '../contracts/backup';
import type {
  AnchorWord,
  ConfusionGroup,
  DailyPlan,
  HifzItem,
  HifzSegment,
  HifzSession,
  HifzTransition,
  RecallAttempt,
} from '../contracts/hifz';
import type { Bookmark, Note, ReadingHistoryEntry, ReadingPosition } from '../contracts/quran';

export type BookmarkRow = Bookmark;
export type NoteRow = Note;

/** `reading_position.id` is the DB primary key; when absent it is derived from the verse key. */
export interface ReadingPositionRow extends ReadingPosition {
  id?: string;
}

/** Same derivation rule for `reading_history.id`. */
export interface ReadingHistoryRow extends ReadingHistoryEntry {
  id?: string;
}

export type HifzItemRow = HifzItem;
export type HifzSegmentRow = HifzSegment;
export type AnchorWordRow = AnchorWord;
export type HifzTransitionRow = HifzTransition;
export type RecallAttemptRow = RecallAttempt;
export type ConfusionGroupRow = ConfusionGroup;
export type SessionRow = HifzSession;

/** `learning_journey` joined with its `journey_progress` children. */
export interface JourneyProgressRow {
  verseKey: string;
  /** Free-form state label ('done', 'in-progress', …); NOT NULL in the DB. */
  state: string;
  updatedAt: string;
}

export interface JourneyRow {
  id: string;
  title: string;
  description: string | null;
  goalVerseKeys: string[];
  startedAt: string;
  completedAt: string | null;
  progress: JourneyProgressRow[];
}

/** `reflection` has no contract interface; this mirrors `db.sql`. */
export interface ReflectionRow {
  id: string;
  verseKey: string | null;
  body: string;
  writtenAt: string;
}

/**
 * `DailyPlan` plus the timestamp the `daily_plan` table requires; the whole
 * row is stored as the canonical JSON payload.
 */
export interface DailyPlanRow extends DailyPlan {
  generatedAt: string;
}

export interface BackupRows extends Partial<BackupUserData> {
  [extra: string]: unknown;
}
