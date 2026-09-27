/**
 * Restore: an explicit plan, then one-transaction application.
 *
 * The DB layer is injected (`RestoreDatabase`) so this module stays
 * framework-free: `node:sqlite` drives it in tests, and the desktop layer can
 * wrap Tauri's async plugin-sql — every awaited call tolerates sync or async
 * implementations.
 *
 * Guarantees:
 * - The envelope is re-verified from scratch (checksum included) inside
 *   `applyRestore`; a caller cannot smuggle an unvalidated or tampered file
 *   past us by pre-processing it.
 * - Only the 15 physical user tables are touched. Content tables are not in
 *   the write set at all, so a restore can never alter Quran text.
 * - One transaction. Any failure rolls back completely; the previous DB is
 *   left byte-identical. Counts are re-read inside the transaction before
 *   commit, and a mismatch aborts (rollback) too.
 */

import type { BackupEnvelope, BackupUserData } from '../contracts/backup';
import { canonicalJsonStringify } from './canonical-json';
import { serializeEnvelope } from './export';
import {
  findOrphanRows,
  inspectEnvelope,
  readingHistoryId,
  readingPositionId,
  type OrphanRef,
  type ValidationIssue,
} from './validate';
import { sanitizeSettings, type SettingPrimitive } from './settings';

export type SqlValue = string | number | Uint8Array | null;

export interface RestoreStatement {
  run(params?: SqlValue[]): unknown | Promise<unknown>;
  get(params?: SqlValue[]): unknown | Promise<unknown>;
}

export interface RestoreDatabase {
  exec(sql: string): unknown | Promise<unknown>;
  prepare(sql: string): RestoreStatement | Promise<RestoreStatement>;
}

const j = (v: unknown): string => canonicalJsonStringify(v);

interface TableOp {
  table: string;
  dataKey: keyof BackupUserData;
  columns: string[];
  rows: (data: BackupUserData, settings: Record<string, SettingPrimitive>, exportedAt: string) => SqlValue[][];
}

/** Physical write order: parents before children (FK-safe). Never content. */
export const RESTORE_OPS: readonly TableOp[] = [
  {
    table: 'settings',
    dataKey: 'settings',
    columns: ['key', 'value', 'updated_at'],
    rows: (_d, settings, exportedAt) =>
      Object.entries(settings).map(([k, v]) => [k, String(v), exportedAt]),
  },
  {
    table: 'bookmark',
    dataKey: 'bookmarks',
    columns: ['id', 'verse_key', 'page', 'label', 'created_at'],
    rows: (d) =>
      (d.bookmarks as Array<Record<string, unknown>>).map((r) => [
        r.id as string,
        (r.verseKey as string) ?? null,
        (r.page as number) ?? null,
        (r.label as string) ?? null,
        r.createdAt as string,
      ]),
  },
  {
    table: 'note',
    dataKey: 'notes',
    columns: ['id', 'verse_key', 'body', 'created_at', 'updated_at'],
    rows: (d) =>
      (d.notes as Array<Record<string, unknown>>).map((r) => [
        r.id as string,
        r.verseKey as string,
        r.body as string,
        r.createdAt as string,
        r.updatedAt as string,
      ]),
  },
  {
    table: 'reading_position',
    dataKey: 'readingPositions',
    columns: ['id', 'verse_key', 'page', 'scroll_fraction', 'updated_at'],
    rows: (d) =>
      (d.readingPositions as Array<{ id?: string; verseKey: string; page: number; scrollFraction: number; updatedAt: string }>).map(
        (r) => [readingPositionId(r), r.verseKey, r.page, r.scrollFraction, r.updatedAt],
      ),
  },
  {
    table: 'reading_history',
    dataKey: 'readingHistory',
    columns: ['id', 'verse_key', 'read_at', 'duration_ms'],
    rows: (d) =>
      (d.readingHistory as Array<{ id?: string; verseKey: string; readAt: string; durationMs: number | null }>).map(
        (r) => [readingHistoryId(r), r.verseKey, r.readAt, r.durationMs ?? null],
      ),
  },
  {
    table: 'hifz_item',
    dataKey: 'hifzItems',
    columns: [
      'id', 'verse_key', 'sequence', 'added_at', 'status', 'band', 'stability',
      'strength', 'last_reviewed_at', 'next_review_at', 'attempt_count', 'error_count',
    ],
    rows: (d) =>
      (d.hifzItems as Array<Record<string, unknown>>).map((r) => [
        r.id as string,
        r.verseKey as string,
        j(r.sequence),
        r.addedAt as string,
        r.status as string,
        r.band as string,
        r.stability as number,
        r.strength as number,
        (r.lastReviewedAt as string) ?? null,
        (r.nextReviewAt as string) ?? null,
        r.attemptCount as number,
        r.errorCount as number,
      ]),
  },
  {
    table: 'hifz_segment',
    dataKey: 'hifzSegments',
    columns: [
      'id', 'item_id', 'position', 'from_word', 'to_word', 'text',
      'meaning_fa', 'meaning_source', 'stability', 'error_count',
    ],
    rows: (d) =>
      (d.hifzSegments as Array<Record<string, unknown>>).map((r) => [
        r.id as string,
        r.itemId as string,
        r.position as number,
        r.fromWord as number,
        r.toWord as number,
        r.text as string,
        (r.meaningFa as string) ?? null,
        (r.meaningSource as string) ?? null,
        r.stability as number,
        r.errorCount as number,
      ]),
  },
  {
    table: 'anchor_word',
    dataKey: 'anchorWords',
    columns: ['id', 'item_id', 'word_position', 'text', 'role', 'stability'],
    rows: (d) =>
      (d.anchorWords as Array<Record<string, unknown>>).map((r) => [
        r.id as string,
        r.itemId as string,
        r.wordPosition as number,
        r.text as string,
        r.role as string,
        r.stability as number,
      ]),
  },
  {
    table: 'hifz_transition',
    dataKey: 'hifzTransitions',
    columns: [
      'id', 'item_id', 'kind', 'to_verse_key', 'to_word', 'success_count',
      'failure_count', 'stability', 'last_practiced_at',
    ],
    rows: (d) =>
      (d.hifzTransitions as Array<Record<string, unknown>>).map((r) => [
        r.id as string,
        r.itemId as string,
        r.kind as string,
        (r.toVerseKey as string) ?? null,
        r.toWord as number,
        r.successCount as number,
        r.failureCount as number,
        r.stability as number,
        (r.lastPracticedAt as string) ?? null,
      ]),
  },
  {
    table: 'hifz_attempt',
    dataKey: 'recallAttempts',
    columns: [
      'id', 'item_id', 'verse_key', 'session_id', 'mode', 'started_at',
      'completed_at', 'produced', 'cue', 'expected_word_count',
      'correct_word_count', 'accuracy', 'errors', 'duration_ms',
      'self_confidence', 'used_audio',
    ],
    rows: (d) =>
      (d.recallAttempts as Array<Record<string, unknown>>).map((r) => [
        r.id as string,
        r.itemId as string,
        r.verseKey as string,
        (r.sessionId as string) ?? null,
        r.mode as string,
        r.startedAt as string,
        (r.completedAt as string) ?? null,
        j(r.produced),
        r.cue == null ? null : j(r.cue),
        r.expectedWordCount as number,
        r.correctWordCount as number,
        r.accuracy as number,
        j(r.errors),
        (r.durationMs as number) ?? null,
        (r.selfConfidence as number) ?? null,
        r.usedAudio ? 1 : 0,
      ]),
  },
  {
    table: 'confusion_group',
    dataKey: 'confusionGroups',
    columns: ['id', 'label', 'origin', 'created_at', 'last_triggered_at', 'confusion_count'],
    rows: (d) =>
      (d.confusionGroups as Array<Record<string, unknown>>).map((r) => [
        r.id as string,
        (r.label as string) ?? null,
        r.origin as string,
        r.createdAt as string,
        (r.lastTriggeredAt as string) ?? null,
        r.confusionCount as number,
      ]),
  },
  {
    table: 'confusion_group_item',
    dataKey: 'confusionGroups',
    columns: ['group_id', 'verse_key', 'position'],
    rows: (d) => {
      const out: SqlValue[][] = [];
      for (const g of d.confusionGroups as Array<{ id: string; verseKeys: string[] }>) {
        g.verseKeys.forEach((vk, i) => out.push([g.id, vk, i]));
      }
      return out;
    },
  },
  {
    table: 'hifz_session',
    dataKey: 'sessions',
    columns: ['id', 'started_at', 'ended_at', 'planned_steps', 'steps', 'report'],
    rows: (d) =>
      (d.sessions as Array<Record<string, unknown>>).map((r) => [
        r.id as string,
        r.startedAt as string,
        (r.endedAt as string) ?? null,
        r.plannedSteps as number,
        j(r.steps),
        r.report == null ? null : j(r.report),
      ]),
  },
  {
    table: 'learning_journey',
    dataKey: 'journeys',
    columns: ['id', 'title', 'description', 'goal_verse_keys', 'started_at', 'completed_at'],
    rows: (d) =>
      (d.journeys as Array<Record<string, unknown>>).map((r) => [
        r.id as string,
        r.title as string,
        (r.description as string) ?? null,
        j(r.goalVerseKeys),
        r.startedAt as string,
        (r.completedAt as string) ?? null,
      ]),
  },
  {
    table: 'journey_progress',
    dataKey: 'journeys',
    columns: ['journey_id', 'verse_key', 'state', 'updated_at'],
    rows: (d) => {
      const out: SqlValue[][] = [];
      for (const jr of d.journeys as Array<{
        id: string;
        progress: Array<{ verseKey: string; state: string; updatedAt: string }>;
      }>) {
        for (const p of jr.progress) out.push([jr.id, p.verseKey, p.state, p.updatedAt]);
      }
      return out;
    },
  },
  {
    table: 'daily_plan',
    dataKey: 'dailyPlans',
    columns: ['date', 'payload', 'generated_at'],
    rows: (d) =>
      (d.dailyPlans as Array<Record<string, unknown>>).map((r) => [
        r.date as string,
        j(r),
        r.generatedAt as string,
      ]),
  },
  {
    table: 'reflection',
    dataKey: 'reflections',
    columns: ['id', 'verse_key', 'body', 'written_at'],
    rows: (d) =>
      (d.reflections as Array<Record<string, unknown>>).map((r) => [
        r.id as string,
        (r.verseKey as string) ?? null,
        r.body as string,
        r.writtenAt as string,
      ]),
  },
];

/** Every physical table a restore may write — the allowlist, nothing else. */
export const RESTORE_TABLES: readonly string[] = RESTORE_OPS.map((o) => o.table);

// ------------------------------------------------------------------ plan

export interface RestoreTablePlan {
  table: string;
  dataKey: keyof BackupUserData;
  /** Rows the backup will insert. */
  rows: number;
  /** Rows currently in the DB that this restore replaces (deletes). */
  replacing: number;
}

export interface RestorePlan {
  schemaVersion: number;
  minReaderVersion: number;
  createdAt: string;
  producedBy: BackupEnvelope['producedBy'];
  checksum: string;
  /** What will be written, in FK-safe order. */
  tables: RestoreTablePlan[];
  /** Rows whose references are missing inside the backup — restore aborts. */
  orphans: OrphanRef[];
  settings: { accepted: string[]; rejected: { key: string; reason: string }[] };
  /** Physical rows removed without a replacement (child rows dropped with parents). */
  warnings: string[];
}

/**
 * Describe what restoring `env` would do, against live row counts, without
 * touching anything.
 */
export function planRestore(
  env: BackupEnvelope,
  currentCounts: Partial<Record<string, number>> = {},
): RestorePlan {
  const sanitize = sanitizeSettings(env.data.settings as Record<string, unknown>);
  const warnings: string[] = [];
  const tables: RestoreTablePlan[] = RESTORE_OPS.map((op) => {
    let rowCount = 0;
    try {
      rowCount = op.rows(env.data, sanitize.settings, env.createdAt).length;
    } catch {
      warnings.push(`could not materialise ${op.table} rows — envelope is probably not validated yet`);
    }
    return {
      table: op.table,
      dataKey: op.dataKey,
      rows: rowCount,
      replacing: currentCounts[op.table] ?? 0,
    };
  });
  if (sanitize.rejected.length > 0) {
    warnings.push(`${sanitize.rejected.length} setting(s) dropped by the allowlist: ${sanitize.rejected.map((r) => r.key).join(', ')}`);
  }
  const orphans = findOrphanRows(env);
  if (orphans.length > 0) {
    warnings.push(`${orphans.length} row(s) carry dangling references; restore will abort unless drop-orphans is confirmed`);
  }
  return {
    schemaVersion: env.schemaVersion,
    minReaderVersion: env.minReaderVersion,
    createdAt: env.createdAt,
    producedBy: env.producedBy,
    checksum: env.checksum,
    tables,
    orphans,
    settings: { accepted: Object.keys(sanitize.settings), rejected: sanitize.rejected },
    warnings,
  };
}

// ----------------------------------------------------------------- apply

export type RestoreResult =
  | {
      ok: true;
      schemaVersion: number;
      /** Physical rows inserted per table. */
      applied: Record<string, number>;
      /** COUNT(*) re-read inside the transaction before commit. */
      verified: Record<string, number>;
      settingsRejected: { key: string; reason: string }[];
      droppedOrphans: OrphanRef[];
      warnings: string[];
    }
  | {
      ok: false;
      phase: 'verify' | 'write' | 'rollback';
      message: string;
      /** Populated when the envelope itself failed re-verification. */
      errors: ValidationIssue[];
      rolledBack: boolean;
    };

/**
 * Apply an envelope in one transaction. Async so Tauri's plugin-sql can drive
 * it; a `node:sqlite` adapter works too (awaits on sync values are fine).
 */
export async function applyRestore(
  db: RestoreDatabase,
  env: BackupEnvelope,
  opts: { dropOrphans?: boolean } = {},
): Promise<RestoreResult> {
  // 1. Re-verify everything ourselves: canonicalise (rejects non-JSON junk),
  //    reparse, re-checksum, re-validate every row.
  let raw: string;
  try {
    raw = serializeEnvelope(env);
  } catch (err) {
    return {
      ok: false,
      phase: 'verify',
      message: `envelope cannot be canonicalised: ${err instanceof Error ? err.message : String(err)}`,
      errors: [],
      rolledBack: false,
    };
  }
  const inspection = inspectEnvelope(raw, { dropOrphans: opts.dropOrphans });
  if (!inspection.ok) {
    return {
      ok: false,
      phase: 'verify',
      message: 'envelope failed re-verification; nothing was written',
      errors: inspection.errors,
      rolledBack: false,
    };
  }
  const clean = inspection.envelope;
  const droppedOrphans = opts.dropOrphans ? findOrphanRows(env) : [];

  const sanitize = sanitizeSettings(clean.data.settings as Record<string, unknown>);
  const expected: Record<string, number> = {};
  const rowSets: Array<{ op: TableOp; rows: SqlValue[][] }> = [];
  for (const op of RESTORE_OPS) {
    const rows =
      op.dataKey === 'settings'
        ? op.rows(clean.data, sanitize.settings, clean.createdAt)
        : op.rows(clean.data, sanitize.settings, clean.createdAt);
    rowSets.push({ op, rows });
    expected[op.table] = (expected[op.table] ?? 0) + rows.length;
  }

  // 2. Single transaction: wipe the user tables, insert, confirm counts, commit.
  let committed = false;
  try {
    // PRAGMA is a no-op inside a transaction — must come first.
    await db.exec('PRAGMA foreign_keys = ON');
    await db.exec('BEGIN');
    try {
      for (let i = rowSets.length - 1; i >= 0; i--) {
        const op = rowSets[i]!.op;
        await (await db.prepare(`DELETE FROM ${op.table}`)).run();
      }
      for (const { op, rows } of rowSets) {
        if (rows.length === 0) continue;
        const stmt = await db.prepare(
          `INSERT INTO ${op.table} (${op.columns.join(', ')}) VALUES (${op.columns.map(() => '?').join(', ')})`,
        );
        for (const row of rows) await stmt.run(row);
      }
      const verified: Record<string, number> = {};
      for (const table of RESTORE_TABLES) {
        const stmt = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`);
        const got = (await stmt.get()) as { n: number | bigint } | undefined;
        verified[table] = Number(got?.n ?? -1);
        if (verified[table] !== expected[table]) {
          throw new Error(
            `post-write count mismatch on ${table}: expected ${expected[table]}, found ${verified[table]}`,
          );
        }
      }
      await db.exec('COMMIT');
      committed = true;
      return {
        ok: true,
        schemaVersion: clean.schemaVersion,
        applied: expected,
        verified,
        settingsRejected: sanitize.rejected,
        droppedOrphans,
        warnings: inspection.warnings,
      };
    } catch (err) {
      try {
        await db.exec('ROLLBACK');
      } catch {
        /* rollback of an already-dead txn — report the original failure */
      }
      return {
        ok: false,
        phase: committed ? 'rollback' : 'write',
        message: `restore failed, rolled back: ${err instanceof Error ? err.message : String(err)}`,
        errors: [],
        rolledBack: !committed,
      };
    }
  } catch (err) {
    // Failure escaping the outer transaction control (e.g. BEGIN itself).
    return {
      ok: false,
      phase: 'write',
      message: `restore could not run: ${err instanceof Error ? err.message : String(err)}`,
      errors: [],
      rolledBack: false,
    };
  }
}
