import { describe, expect, it } from 'vitest';
import type { BackupEnvelope } from '../../src/contracts/backup';
import { inspectEnvelope } from '../../src/backup/validate';
import { serializeEnvelope } from '../../src/backup/export';
import { reseal, sampleEnvelope } from './fixtures';

function tamperedNote(env: BackupEnvelope): string {
  const body = env.data.notes[0] as Record<string, unknown>;
  const clone = structuredClone(env);
  const note = clone.data.notes[0] as Record<string, string>;
  note.body = `${String(body.body)} ← tampered`;
  return serializeEnvelope(clone);
}

function serializedWith(mutate: (env: BackupEnvelope) => void): string {
  const env = sampleEnvelope();
  mutate(env);
  return serializeEnvelope(reseal(env));
}

/** For defects in counts/checksum themselves — re-sealing would repair them. */
function serializedWithoutReseal(mutate: (env: BackupEnvelope) => void): string {
  const env = sampleEnvelope();
  mutate(env);
  return serializeEnvelope(env);
}

describe('inspectEnvelope — structure & seal', () => {
  it('accepts a freshly built file', () => {
    const r = inspectEnvelope(serializeEnvelope(sampleEnvelope()));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings).toEqual([]);
  });

  // The web build is a shipped producer, so `web` is a legal provenance; the
  // enum stays closed, because an unknown platform means the file was edited or
  // comes from an app this contract has never heard of.
  it('accepts a file produced by the web build', () => {
    const r = inspectEnvelope(serializedWith((env) => { env.producedBy.platform = 'web'; }));
    expect(r.ok, JSON.stringify(r.ok ? r.warnings : r.errors)).toBe(true);
  });

  it('refuses a platform the contract does not know', () => {
    const r = inspectEnvelope(
      serializedWith((env) => {
        (env.producedBy as unknown as { platform: string }).platform = 'atlas';
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.filter((e) => e.code === 'bad-value').map((e) => e.path)).toContain('$.producedBy.platform');
    }
  });

  it('detects a single flipped character inside a note body (checksum mismatch, expected vs computed)', () => {
    const env = sampleEnvelope();
    const text = serializeEnvelope(env);
    const marker = '"body":"';
    const at = text.indexOf(marker) + marker.length + 5;
    const flipped = `${text.slice(0, at)}X${text.slice(at + 1)}`;
    expect(flipped).not.toBe(text);
    const r = inspectEnvelope(flipped);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const issue = r.errors.find((e) => e.code === 'checksum-mismatch');
      expect(issue).toBeDefined();
      expect(issue?.expected).toMatch(/^[0-9a-f]{64}$/);
      expect(issue?.computed).toMatch(/^[0-9a-f]{64}$/);
      expect(issue!.expected).not.toBe(issue!.computed);
    }
  });

  it('detects appended text inside a note body', () => {
    const r = inspectEnvelope(tamperedNote(sampleEnvelope()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === 'checksum-mismatch')).toBe(true);
  });

  it('detects counts disagreeing with the actual array length', () => {
    const r = inspectEnvelope(
      serializedWithoutReseal((env) => void ((env.counts as Record<string, number>).notes = 42)),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const issue = r.errors.find((e) => e.code === 'counts-mismatch');
      expect(issue?.path).toBe('$.counts.notes');
      expect(issue?.message).toContain('42');
    }
  });

  it('refuses a future schemaVersion', () => {
    const r = inspectEnvelope(serializedWith((env) => void ((env as { schemaVersion: number }).schemaVersion = 99)));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === 'future-schema-version')).toBe(true);
  });

  it('refuses a minReaderVersion above the app', () => {
    const r = inspectEnvelope(serializedWith((env) => void ((env as { minReaderVersion: number }).minReaderVersion = 7)));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === 'unreadable-min-reader')).toBe(true);
  });

  it('reports missing envelope fields instead of throwing', () => {
    const env = sampleEnvelope() as unknown as Record<string, unknown>;
    delete env.checksum;
    delete env.counts;
    const r = inspectEnvelope(JSON.stringify(env));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.code === 'missing-field' && e.path === '$.checksum')).toBe(true);
      expect(r.errors.some((e) => e.code === 'missing-field' && e.path === '$.counts')).toBe(true);
    }
  });

  it('rejects a non-hex or wrong-length checksum format', () => {
    const r = inspectEnvelope(
      serializedWithoutReseal((env) => void ((env as { checksum: string }).checksum = 'nope')),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === 'bad-value' || e.code === 'checksum-mismatch')).toBe(true);
  });

  it('applies the size guard before parsing', () => {
    const text = serializeEnvelope(sampleEnvelope());
    const r = inspectEnvelope(text, { maxBytes: 128 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toContain('too-large');
  });

  it('warns (not fails) on unknown data keys and non-allowlisted settings, since they were sealed', () => {
    const r = inspectEnvelope(
      serializedWith((env) => {
        (env.data.settings as Record<string, unknown>).evilKey = 'x';
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.some((w) => w.includes('evilKey'))).toBe(true);
  });
});

describe('inspectEnvelope — per-row validation', () => {
  const firstAttempt = (env: BackupEnvelope): Record<string, unknown> =>
    env.data.recallAttempts[0] as Record<string, unknown>;

  it('rejects accuracy outside 0..1', () => {
    const r = inspectEnvelope(serializedWith((env) => void (firstAttempt(env).accuracy = 1.5)));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const issue = r.errors.find((e) => e.path === '$.data.recallAttempts[0].accuracy');
      expect(issue?.message).toContain('0..1');
    }
  });

  it('rejects correctWordCount > expectedWordCount', () => {
    const r = inspectEnvelope(
      serializedWith((env) => {
        firstAttempt(env).correctWordCount = 99;
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.message.includes('exceeds expectedWordCount'))).toBe(true);
  });

  it('rejects an ErrorKind outside the contract union', () => {
    const r = inspectEnvelope(
      serializedWith((env) => {
        const errors = firstAttempt(env).errors as Array<Record<string, unknown>>;
        errors[0]!.kind = 'teleportation';
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const issue = r.errors.find((e) => e.path === '$.data.recallAttempts[0].errors[0].kind');
      expect(issue?.message).toContain('ErrorKind');
    }
  });

  it('rejects a SQL-injection verseKey on bookmarks, notes and positions', () => {
    for (const [mutate, path] of [
      [
        (e: BackupEnvelope) => ((e.data.bookmarks[0] as Record<string, unknown>).verseKey = "1:1'); DROP TABLE note;--"),
        '$.data.bookmarks[0].verseKey',
      ],
      [
        (e: BackupEnvelope) => ((e.data.notes[0] as Record<string, unknown>).verseKey = '1:1; DELETE FROM note'),
        '$.data.notes[0].verseKey',
      ],
      [
        (e: BackupEnvelope) => ((e.data.readingPositions[0] as Record<string, unknown>).verseKey = '۱۱۲:۱'),
        '$.data.readingPositions[0].verseKey',
      ],
    ] as const) {
      const r = inspectEnvelope(serializedWith(mutate));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.errors.some((e) => e.path === path && e.code === 'bad-value')).toBe(true);
      }
    }
  });

  it('rejects out-of-range chapters and verse 0', () => {
    const r = inspectEnvelope(
      serializedWith((env) => ((env.data.notes[0] as Record<string, unknown>).verseKey = '999:1')),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.message.includes('chapter 999'))).toBe(true);
  });

  it('rejects a duplicate primary id within a table', () => {
    const r = inspectEnvelope(
      serializedWith((env) => ((env.data.notes[0] as Record<string, unknown>).id = 'item-1')),
    );
    // 'item-1' belongs to a hifz item — this is also the cross-table case
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === 'duplicate-id')).toBe(true);
  });

  it('rejects duplicate ids across different tables', () => {
    const env = sampleEnvelope();
    (env.data.bookmarks[1] as Record<string, unknown>).id = (env.data.sessions[0] as Record<string, unknown>).id;
    const r = inspectEnvelope(serializeEnvelope(reseal(env)));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const dup = r.errors.find((e) => e.code === 'duplicate-id');
      expect(dup?.message).toContain('already used');
    }
  });

  it('tolerates reading rows that omit derived ids', () => {
    const env = sampleEnvelope();
    delete (env.data.readingPositions[0] as Record<string, unknown>).id;
    delete (env.data.readingHistory[0] as Record<string, unknown>).id;
    const r = inspectEnvelope(serializeEnvelope(reseal(env)));
    expect(r.ok).toBe(true);
  });

  it('rejects unknown enums, bad timestamps and non-primitive settings', () => {
    const r = inspectEnvelope(
      serializedWith((env) => {
        (env.data.hifzItems[0] as Record<string, unknown>).band = 'legendary';
        (env.data.hifzItems[1] as Record<string, unknown>).addedAt = 'yesterday';
        (env.data.settings as Record<string, unknown>).fontScale = { nested: true };
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.code === 'bad-value' && e.path.endsWith('.band'))).toBe(true);
      expect(r.errors.some((e) => e.path === '$.data.hifzItems[1].addedAt')).toBe(true);
      expect(r.errors.some((e) => e.path === '$.data.settings.fontScale')).toBe(true);
    }
  });
});

describe('inspectEnvelope — dangling references (§ orphan policy)', () => {
  function withOrphan(): BackupEnvelope {
    const env = sampleEnvelope();
    (env.data.recallAttempts[1] as Record<string, unknown>).itemId = 'ghost-item';
    return reseal(env);
  }

  it('reports the orphan instead of silently ignoring it', () => {
    const r = inspectEnvelope(serializeEnvelope(withOrphan()));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const orphan = r.errors.find((e) => e.code === 'dangling-reference');
      expect(orphan?.path).toContain('recallAttempts[1]');
      expect(orphan?.message).toContain('ghost-item');
    }
    if (!r.ok) expect(r.warnings.some((w) => w.includes('drop-orphans'))).toBe(true);
  });

  it('drops orphans ONLY in the explicit user-confirmed mode, and re-seals', () => {
    const text = serializeEnvelope(withOrphan());
    const r = inspectEnvelope(text, { dropOrphans: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.envelope.data.recallAttempts).toHaveLength(1);
      expect(r.envelope.counts.recallAttempts).toBe(1);
      expect(r.warnings.some((w) => w.includes('dropped orphan recallAttempts'))).toBe(true);
      // the cleaned envelope is a valid file on its own
      const again = inspectEnvelope(serializeEnvelope(r.envelope));
      expect(again.ok).toBe(true);
      // and it differs from the sealed original (not silently equal)
      expect(r.envelope.checksum).not.toBe(withOrphan().checksum);
    }
  });

  it('also catches orphaned segments, anchors and transitions', () => {
    for (const key of ['hifzSegments', 'anchorWords', 'hifzTransitions'] as const) {
      const env = sampleEnvelope();
      (env.data[key][0] as Record<string, unknown>).itemId = 'nowhere';
      const r = inspectEnvelope(serializeEnvelope(reseal(env)));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.some((e) => e.code === 'dangling-reference' && e.path.includes(key))).toBe(true);
    }
  });

  it('keeps attempts that reference a missing session (no FK) but warns', () => {
    const env = sampleEnvelope();
    (env.data.recallAttempts[0] as Record<string, unknown>).sessionId = 'no-such-session';
    const r = inspectEnvelope(serializeEnvelope(reseal(env)));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.some((w) => w.includes('no-such-session'))).toBe(true);
  });
});

describe('inspectEnvelope — hostile strings never throw', () => {
  const cases: Record<string, string> = {
    empty: '',
    'not json': '{{{{',
    'truncated file': serializeEnvelope(sampleEnvelope()).slice(0, 400),
    'top-level array': '[]',
    'top-level null': 'null',
    'top-level number': '42',
    'top-level string': '"backup"',
    'null bytes': '\u0000\u0000\u0000',
    'json of wrong shape': '{"schemaVersion":"one","data":3,"counts":null,"checksum":[]}',
  };
  for (const [name, input] of Object.entries(cases)) {
    it(`fails cleanly: ${name}`, () => {
      const r = inspectEnvelope(input);
      expect(typeof r).toBe('object');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
    });
  }
});
