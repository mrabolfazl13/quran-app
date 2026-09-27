/**
 * v1 → v2 — future-format placeholder, kept real on purpose.
 *
 * BACKUP_SCHEMA_VERSION is 1 today, so this step never runs in production;
 * `migrate()` only reaches it when a caller explicitly asks for
 * `toVersion: 2`. It exists so the chain (lookup by `from`, contiguity
 * checks, envelope re-sealing with recomputed counts/checksum) is genuinely
 * exercised by `core/tests/backup/migrate.test.ts` instead of being dead
 * code that nobody has ever run.
 *
 * HOW TO EXTEND — when a real format change lands:
 * 1. Decide the row-level change. A migration may ONLY transform user data
 *    (`BackupUserData`); content never appears in backups.
 * 2. Replace the body of `apply` below: deep-copy the rows you touch
 *    (never mutate the input envelope), bump any renamed fields, and return
 *    `{ envelope, warnings }`. `migrate()` re-seals counts + sha256 after
 *    your step, so do not recompute them here.
 * 3. Set `minReaderVersion` only if older readers must refuse this file —
 *    the value must never exceed the new `BACKUP_SCHEMA_VERSION`.
 * 4. Have the orchestrator bump `BACKUP_SCHEMA_VERSION` in
 *    `core/src/contracts/backup.ts` in the same round, add a case to
 *    `migrate.test.ts` asserting the exact row transformation, and keep this
 *    step in `MIGRATION_STEPS` forever — old files must always migrate up.
 */

import type { BackupEnvelope } from '../../contracts/backup';
import type { BackupMigrationStep } from '../migrate';

export const v1ToV2: BackupMigrationStep = {
  from: 1,
  to: 2,
  description: 'placeholder for the next user-data format change (v1 → v2)',
  apply(env: BackupEnvelope): { envelope: BackupEnvelope; warnings: string[] } {
    // Intentionally a no-op on `data`: v1 rows are already v2-shaped.
    return {
      envelope: { ...env, schemaVersion: 2 },
      warnings: ['applied placeholder migration v1→v2 (no data changes)'],
    };
  },
};
