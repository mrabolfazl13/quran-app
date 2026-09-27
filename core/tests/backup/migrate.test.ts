import { describe, expect, it } from 'vitest';
import type { BackupEnvelope, MigrationResult } from '../../src/contracts/backup';
import { APP_BACKUP_VERSION, migrate, MIGRATION_STEPS, validateChain } from '../../src/backup/migrate';
import { computeDataChecksum, serializeEnvelope } from '../../src/backup/export';
import { inspectEnvelope } from '../../src/backup/validate';
import { reseal, sampleEnvelope } from './fixtures';

function asV(env: BackupEnvelope, version: number): BackupEnvelope {
  return { ...env, schemaVersion: version };
}

describe('migration chain', () => {
  it('is contiguous from v1 and the app is at v1', () => {
    expect(validateChain()).toEqual([]);
    expect(MIGRATION_STEPS.length).toBeGreaterThanOrEqual(1);
    expect(APP_BACKUP_VERSION).toBe(1);
  });

  it('v1 → v1 is identity (result is contract-shaped MigrationResult)', () => {
    const env = sampleEnvelope();
    const result: MigrationResult = migrate(env);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.from).toBe(1);
      expect(result.to).toBe(1);
      expect(result.warnings).toEqual([]);
    }
  });

  it('walks the real chain: v1 → v2 placeholder is genuinely applied and re-seals', () => {
    const env = sampleEnvelope();
    const result = migrate(env, { toVersion: 2 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.from).toBe(1);
      expect(result.to).toBe(2);
      expect(result.warnings.join(' ')).toContain('v1→v2');
      expect(result.envelope.schemaVersion).toBe(2);
      // checksum invariant survives migration (data untouched here)
      expect(result.envelope.checksum).toBe(computeDataChecksum(result.envelope.data));
      // input envelope was not mutated
      expect(env.schemaVersion).toBe(1);
    }
  });

  it('rejects migration past a gap in the chain', () => {
    const result = migrate(sampleEnvelope(), { toVersion: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('no migration path');
  });

  it('downgrade (file newer than app) fails closed', () => {
    const newer = reseal(asV(sampleEnvelope(), 2));
    const r = migrate(newer);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.from).toBe(2);
      expect(r.error.toLowerCase()).toContain('downgrade');
    }
    const muchNewer = asV(sampleEnvelope(), 99);
    const r2 = migrate(muchNewer);
    expect(r2.ok).toBe(false);
  });

  it('validate refuses v2 files while the app is v1, so migrate() is never reached for them', () => {
    const future = reseal(asV(sampleEnvelope(), 2));
    const inspection = inspectEnvelope(serializeEnvelope(future));
    expect(inspection.ok).toBe(false);
    if (!inspection.ok) {
      expect(inspection.errors.some((e) => e.code === 'future-schema-version')).toBe(true);
    }
  });

  it('rejects garbage schemaVersion values without throwing', () => {
    expect(migrate(asV(sampleEnvelope(), 1.5)).ok).toBe(false);
    expect(migrate(asV(sampleEnvelope(), 0)).ok).toBe(false);
  });
});
