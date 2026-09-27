/**
 * Forward-only, ordered migration chain keyed by integer schema version.
 *
 * Contract (`core/src/contracts/backup.ts`): a file carries `schemaVersion`
 * (its data format) and `minReaderVersion`. `BACKUP_SCHEMA_VERSION` is the
 * version this app understands; today it is 1, and v1 is identity.
 *
 * Rules:
 * - Files newer than the app FAIL CLOSED (downgrade refusal). There is no
 *   partial read of a newer format; the user must update the app.
 * - Older files walk the chain one step at a time: v1→v2→…→app version.
 *   Every step declares `from`/`to`; a gap is a hard error, never a guess.
 * - A step that changes `data` must leave the envelope re-sealable; `migrate`
 *   recomputes `counts` and `checksum` after every applied step, so the
 *   result is always directly restorable.
 *
 * To add a real migration:
 * 1. Create `core/src/backup/migrations/vN-to-vN+1.ts` (see v1-to-v2.ts for
 *    the template) and append the step to `MIGRATION_STEPS` below.
 * 2. Bump `BACKUP_SCHEMA_VERSION` in the contracts via the orchestrator —
 *    never before the step exists.
 *
 * `opts.toVersion` migrates within the chain past the current app version and
 * exists so the chain itself is exercised by tests (and for forward planning);
 * production callers never pass it.
 */

import { BACKUP_SCHEMA_VERSION, type BackupEnvelope, type MigrationResult } from '../contracts/backup';
import { computeCounts, computeDataChecksum } from './export';
import { v1ToV2 } from './migrations/v1-to-v2';

export interface BackupMigrationStep {
  from: number;
  to: number;
  description: string;
  /**
   * Return a NEW envelope (never mutate the input) plus user-visible warnings.
   * Throws only for programmer bugs; `migrate` catches and reports.
   */
  apply: (env: BackupEnvelope) => { envelope: BackupEnvelope; warnings: string[] };
}

/** The ordered chain. Append new steps here; ordering by `from` is validated. */
export const MIGRATION_STEPS: readonly BackupMigrationStep[] = [v1ToV2];

export const APP_BACKUP_VERSION = BACKUP_SCHEMA_VERSION;

export type MigrateResult =
  | (MigrationResult & { ok: true; envelope: BackupEnvelope })
  | { ok: false; from: number; error: string };

export interface MigrateOptions {
  /** Internal/test use: migrate to a chain version newer than the app. */
  toVersion?: number;
}

function reSeal(env: BackupEnvelope): BackupEnvelope {
  return {
    ...env,
    counts: computeCounts(env.data),
    checksum: computeDataChecksum(env.data),
  };
}

/** Type-compatible with the exported `MigrationResult`; carries the envelope. */
export function migrate(env: BackupEnvelope, opts: MigrateOptions = {}): MigrateResult {
  const from = env.schemaVersion;
  const target = opts.toVersion ?? APP_BACKUP_VERSION;

  if (!Number.isInteger(from) || from < 1) {
    return { ok: false, from, error: `invalid schemaVersion ${String(from)}` };
  }
  // Fail closed on downgrades: the app must not rewrite a file whose format
  // it does not fully understand. Explicit toVersion only widens within the
  // chain; it can never talk us into reading above-chain files.
  if (from > target || (from > APP_BACKUP_VERSION && opts.toVersion === undefined)) {
    return {
      ok: false,
      from,
      error: `backup is schema v${from}; this app supports v${APP_BACKUP_VERSION} — refusing to downgrade-restore a newer format`,
    };
  }

  let current = env;
  let version = from;
  const warnings: string[] = [];
  while (version < target) {
    const step = MIGRATION_STEPS.find((s) => s.from === version);
    if (!step) {
      return { ok: false, from, error: `no migration path from v${version} to v${target}` };
    }
    let applied: { envelope: BackupEnvelope; warnings: string[] };
    try {
      applied = step.apply(current);
      if (applied.envelope.schemaVersion !== step.to) {
        return { ok: false, from, error: `migration v${step.from}→v${step.to} did not advance schemaVersion` };
      }
    } catch (err) {
      return { ok: false, from, error: `migration v${step.from}→v${step.to} failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    warnings.push(...applied.warnings.map((w) => `v${step.from}→v${step.to}: ${w}`));
    current = reSeal({ ...applied.envelope, schemaVersion: step.to });
    version = step.to;
  }
  return { ok: true, from, to: version, warnings, envelope: current };
}

/** Chain self-check used by tests: steps must be contiguous starting at 1. */
export function validateChain(): string[] {
  const problems: string[] = [];
  let expected = 1;
  for (const step of MIGRATION_STEPS) {
    if (step.from !== expected) problems.push(`step v${step.from}→v${step.to} does not continue from v${expected}`);
    if (step.to !== step.from + 1) problems.push(`step v${step.from}→v${step.to} must advance exactly one version`);
    expected = step.to;
  }
  return problems;
}
