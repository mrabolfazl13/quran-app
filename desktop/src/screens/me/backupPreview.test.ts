/**
 * The gate between a file on disk and a preview the screen will render.
 *
 * WHY this test exists: the preview reads `envelope.createdAt.replace(...)` and
 * `schemaVersion` straight off the object, so for a while a file that parsed as
 * JSON but carried the wrong *types* took the whole app down — the error
 * boundary caught it, but §47 says a malformed file must never crash anything.
 * The fix was to run the same validator `applyRestore` uses before ever handing
 * the object to React, so what is pinned here is that the shapes the gateway can
 * return either come back certified, or come back as a message and nothing else.
 *
 * The mutilated objects are built from a real envelope (`buildEnvelope` is pure)
 * rather than typed by hand, so if `BackupEnvelope` grows a field these cases
 * still describe a file a person could actually save.
 */
import { describe, expect, it } from 'vitest';

import { buildEnvelope } from '@quran/core';
import type { BackupEnvelope } from '@quran/core';

import { acceptEnvelope } from './BackupScreen';

const tr = (fa: string, _en: string): string => fa;

/** The smallest file this app really writes: no user rows at all. */
function realEnvelope(): BackupEnvelope {
  const built = buildEnvelope(
    { settings: {}, bookmarks: [], notes: [], readingPositions: [], readingHistory: [], hifz: { items: [] } },
    { app: 'desktop-test', version: '0.0.0', platform: 'desktop', createdAt: '2026-09-28T00:00:00.000Z' },
  );
  return built.envelope;
}

function rejected(parsed: unknown): string {
  const out = acceptEnvelope(parsed, tr);
  expect('envelope' in out).toBe(false);
  const message = (out as { error: string }).error;
  expect(message).toContain('پذیرفته نشد');
  return message;
}

describe('the file a backup screen is allowed to preview', () => {
  it('accepts an envelope this app actually wrote', () => {
    const out = acceptEnvelope(realEnvelope(), tr);
    expect('error' in out).toBe(false);
    const envelope = (out as { envelope: BackupEnvelope }).envelope;
    expect(envelope.createdAt.replace('T', ' ').slice(0, 19)).toMatch(/^\d{4}-\d{2}-\d{2} /);
    expect(envelope.producedBy.app).toBe('desktop-test');
  });

  it('refuses the field types that used to crash the preview', () => {
    // `createdAt` missing is the exact shape that threw
    // "Cannot read properties of undefined (reading 'replace')".
    const noCreated = { ...realEnvelope() } as unknown as Record<string, unknown>;
    delete noCreated.createdAt;
    expect(rejected(noCreated)).toMatch(/createdAt/);

    const wrongTypes = {
      ...realEnvelope(),
      schemaVersion: 'one',
      minReaderVersion: null,
      checksum: 42,
    };
    expect(rejected(wrongTypes)).toMatch(/schemaVersion|checksum/);

    const nestedGarbage = { ...realEnvelope(), producedBy: { app: ['x'], version: {}, platform: 'atlas' } };
    expect(rejected(nestedGarbage)).toMatch(/producedBy|\$/);
  });

  it('refuses anything that is not an envelope object at all', () => {
    expect(rejected([])).toMatch(/\$/);
    expect(rejected(null)).toMatch(/\$/);
    expect(rejected('bismillah')).toMatch(/\$/);
    expect(rejected({ schemaVersion: 1 })).toMatch(/ ایراد/);
  });

  it('reports what it found without pretending to have loaded anything', () => {
    const message = rejected({ ...realEnvelope(), checksum: '0'.repeat(63) });
    expect(message).toContain('چیزی خوانده نشد');
    expect(message).toContain('پایگاه دستنخورده');
  });
});
