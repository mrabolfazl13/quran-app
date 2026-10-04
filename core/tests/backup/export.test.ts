import { describe, expect, it } from 'vitest';
import { BACKUP_SCHEMA_VERSION } from '../../src/contracts/backup';
import { buildEnvelope, computeCounts, computeDataChecksum, DATA_KEYS, serializeEnvelope } from '../../src/backup/export';
import { canonicalJsonStringify } from '../../src/backup/canonical-json';
import { inspectEnvelope } from '../../src/backup/validate';
import { META, sampleRows } from './fixtures';

describe('buildEnvelope', () => {
  it('produces a complete, versioned envelope with computed counts', () => {
    const { envelope, warnings } = buildEnvelope(sampleRows(), META);
    expect(warnings).toEqual([]);
    expect(envelope.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
    expect(envelope.minReaderVersion).toBe(BACKUP_SCHEMA_VERSION);
    expect(envelope.producedBy).toEqual({ app: 'quran-desktop', version: '0.1.0', platform: 'desktop' });
    expect(Object.keys(envelope.counts).sort()).toEqual([...DATA_KEYS].sort());
    expect(envelope.counts.notes).toBe(1);
    expect(envelope.counts.settings).toBe(7);
    // two form drills and one meaning drill
    expect(envelope.counts.recallAttempts).toBe(3);
    expect(envelope.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(envelope.checksum).toBe(computeDataChecksum(envelope.data));
    const fresh = inspectEnvelope(serializeEnvelope(envelope));
    expect(fresh.ok).toBe(true);
  });

  it('checksum covers data only — same data at different createdAt is comparable', () => {
    const a = buildEnvelope(sampleRows(), { ...META, createdAt: '2026-01-01T00:00:00Z' });
    const b = buildEnvelope(sampleRows(), { ...META, createdAt: '2026-12-31T23:59:59Z' });
    expect(a.envelope.checksum).toBe(b.envelope.checksum);
    expect(canonicalJsonStringify(a.envelope.data)).toBe(canonicalJsonStringify(b.envelope.data));
  });

  it('serialisation is byte-stable and canonically key-sorted', () => {
    const env = buildEnvelope(sampleRows(), META).envelope;
    expect(serializeEnvelope(env)).toBe(serializeEnvelope(env));
    // top-level keys in sorted order (checksum < counts < createdAt < data …),
    // compact separators
    expect(serializeEnvelope(env).startsWith('{"checksum":"')).toBe(true);
    expect(serializeEnvelope(env).includes(',"counts":')).toBe(true);
  });

  it('refuses content tables: unknown keys are dropped with a warning', () => {
    const rows = {
      ...sampleRows(),
      ayah: [{ verseKey: '1:1', textUthmani: 'مُحَمَّدٌ' }],
      translation: [{ verseKey: '1:1', packId: 'x', text: 'liar' }],
      content_pack: { id: 'evil' },
    };
    const { envelope, warnings } = buildEnvelope(rows, META);
    expect(warnings.some((w) => /refused non-user-data key "ayah"/.test(w))).toBe(true);
    expect(warnings.some((w) => /translation/.test(w))).toBe(true);
    expect('ayah' in envelope.data).toBe(false);
    expect('translation' in envelope.data).toBe(false);
    expect('content_pack' in envelope.data).toBe(false);
    // the tampered corpus text must not reach the checksummed payload
    expect(JSON.stringify(envelope.data)).not.toContain('مُحَمَّدٌ');
  });

  it('fills missing keys with empty tables instead of failing', () => {
    const { envelope, warnings } = buildEnvelope({ notes: sampleRows().notes }, META);
    expect(envelope.data.bookmarks).toEqual([]);
    expect(envelope.data.settings).toEqual({});
    expect(envelope.counts.hifzItems).toBe(0);
    expect(warnings).toEqual([]);
  });

  it('degrades non-array values to empty arrays with a warning', () => {
    const { envelope, warnings } = buildEnvelope({ notes: 'not-an-array', bookmarks: undefined }, META);
    expect(envelope.data.notes).toEqual([]);
    expect(warnings.some((w) => w.includes('notes'))).toBe(true);
  });

  it('counts agree with the payload by construction', () => {
    const { envelope } = buildEnvelope(sampleRows(), META);
    const counts = computeCounts(envelope.data);
    expect(envelope.counts).toEqual(counts);
  });
});
