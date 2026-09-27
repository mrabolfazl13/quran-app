/**
 * Backup / restore contract. Only user-generated data is exported — content
 * packs are re-shipped with the app and never round-tripped through a backup.
 */

export const BACKUP_SCHEMA_VERSION = 1;
export const BACKUP_FILE_EXTENSION = 'quranbak';

export interface BackupUserData {
  settings: Record<string, string | number | boolean>;
  bookmarks: unknown[];
  notes: unknown[];
  readingPositions: unknown[];
  readingHistory: unknown[];
  hifzItems: unknown[];
  hifzSegments: unknown[];
  anchorWords: unknown[];
  hifzTransitions: unknown[];
  recallAttempts: unknown[];
  confusionGroups: unknown[];
  sessions: unknown[];
  journeys: unknown[];
  reflections: unknown[];
  dailyPlans: unknown[];
}

export interface BackupEnvelope {
  schemaVersion: number;
  /** Schema version the file was produced from; drives the migration chain. */
  minReaderVersion: number;
  createdAt: string;
  /** App + platform that produced the file, purely informational. */
  producedBy: { app: string; version: string; platform: 'desktop' | 'mobile' };
  /** sha256 over the canonical JSON of `data`. */
  checksum: string;
  counts: Record<keyof BackupUserData, number>;
  data: BackupUserData;
}

export type MigrationResult = {
  ok: true;
  from: number;
  to: number;
  warnings: string[];
} | { ok: false; from: number; error: string };
