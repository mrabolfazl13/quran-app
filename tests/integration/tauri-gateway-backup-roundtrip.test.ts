/**
 * The installed app must be able to read the files it writes.
 *
 * WHY this test exists at all: on the packaged app, one click on «ساخت فایل از
 * دادهٔ فعلی» followed by «بازیابی» produced `این فایل پذیرفته نشد — 6 ایراد`.
 * Two separate mismatches made the app refuse its own output, and no test caught
 * either because each side was only ever tested against itself:
 *
 *   1. The gateway sealed `checksum` as sha256 over `JSON.stringify(data)` while
 *      `core/src/backup/validate.ts` recomputes it over the CANONICAL json of
 *      `data` (keys sorted by code unit). Same data, two digests, so every file
 *      failed with `checksum-mismatch`.
 *   2. `dailyPlans` was exported as the storage row `{date, payload, generatedAt}`
 *      — the plan still wrapped in its `payload` string — while the validator
 *      reads a DECODED plan and demanded `newAyahs`, `reviewItems`, `weakItems`,
 *      `confusionGroups`, `estimatedMinutes` (five `missing-field` errors).
 *
 * So this drives the real shipped objects: `TauriGateway` over real SQLite, then
 * the same `validateEnvelopeObject` call the backup screen makes before showing a
 * preview, then `importBackup` on the parsed file bytes. The rule it pins is the
 * one whose absence produced the bug — anything the app can export, the app must
 * accept — and it holds only if all three links agree.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BackupEnvelope, Surah, VerseKey } from '@quran/core';
import {
  CONTENT_PACK_SCHEMA_VERSION,
  canonicalJsonStringify,
  computeDataChecksum,
  serializeEnvelope,
  validateEnvelopeObject,
} from '@quran/core';
import { TauriGateway } from '../../desktop/src/gateway/tauriGateway';
import type { AyahRow, AyahWordRow, ContentPlan, ImportReport, PackRow } from '../../desktop/src/gateway/types';
import { emptyPlan } from '../../desktop/src/gateway/types';

/** One plan, written exactly the way `hifzFacade` writes it: `JSON.stringify(plan)`. */
const PLAN = {
  date: '2026-01-05',
  newAyahs: ['1:1'],
  reviewItems: [],
  weakItems: [],
  confusionGroups: [],
  estimatedMinutes: 4,
};

/** What reached the fake Tauri backup commands, so the file bytes can be inspected. */
const ipc = vi.hoisted(() => ({ files: new Map<string, string>() }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'backup_write') {
      ipc.files.set(String(args.name), String(args.contents));
      return `backups\\${String(args.name)}`;
    }
    if (cmd === 'backup_read') return ipc.files.get(String(args.name)) ?? '';
    throw new Error(`test did not stage the command ${cmd}`);
  },
}));

// `node:sqlite` in place of the plugin's Rust connection: the SQL, schema and
// transactions are the shipped ones, and every statement waits its turn the way
// the single pooled connection does (see tauri-gateway-statement-queue.test.ts).
const driver = vi.hoisted(() => ({ dir: '' }));

vi.mock('@tauri-apps/plugin-sql', async () => {
  const { DatabaseSync } = await import('node:sqlite');

  class FakeDatabase {
    private constructor(private readonly db: InstanceType<typeof DatabaseSync>) {}

    static async load(url: string): Promise<FakeDatabase> {
      return new FakeDatabase(new DatabaseSync(join(driver.dir, url.replace(/^sqlite:/, ''))));
    }

    async select<TRow>(sql: string, params: unknown[] = []): Promise<TRow[]> {
      await null;
      return this.db.prepare(sql).all(...bind(params)) as TRow[];
    }

    async execute(sql: string, params: unknown[] = []): Promise<{ rowsAffected: number }> {
      await null;
      const { changes } = this.db.prepare(sql).run(...bind(params));
      return { rowsAffected: Number(changes) };
    }

    async close(): Promise<void> {
      this.db.close();
    }
  }

  return { default: FakeDatabase };
});

// `node:sqlite` accepts null / number / bigint / string / Uint8Array only.
function bind(params: unknown[]): unknown[] {
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

const PACK_ID = 'test-backup-roundtrip';

/**
 * Content is not what this test is about, but the user tables have real foreign
 * keys into `ayah`, so a bookmark and a note need something revealed to point at.
 * The importer is staged at the same seam the queue test uses.
 */
const planHolder = vi.hoisted(() => ({ plan: null as unknown }));

vi.mock('../../desktop/src/content/importer', () => ({
  buildImportPlan: async () => {
    if (!planHolder.plan) throw new Error('test did not stage a plan');
    return { report: report(), plan: planHolder.plan };
  },
}));

function packRow(): PackRow {
  return {
    id: PACK_ID,
    kind: 'mushaf',
    version: '1',
    schemaVersion: CONTENT_PACK_SCHEMA_VERSION,
    language: 'ar',
    title: 'Test mushaf',
    source: 'tests/integration/tauri-gateway-backup-roundtrip.test.ts',
    licenseName: 'Test',
    licenseSpdx: 'MIT',
    licenseStatus: 'clear',
    licenseNotes: '',
    attribution: {
      publisher: 'QA',
      work: 'Test mushaf',
      edition: null,
      sourceUrl: '',
      retrievedAt: '2026-01-01T00:00:00.000Z',
      creditLine: 'fixture',
    },
    checksum: '0'.repeat(64),
    payloadBytes: 128,
    recordCount: 1,
    importedAt: '2026-01-01T00:00:00.000Z',
  };
}

function surah(): Surah {
  return {
    number: 1,
    nameArabic: 'سُورَةُ الفَاتِحَة',
    nameSimple: 'Al-Fatihah',
    nameTransliterated: 'Al-Fatihah',
    translationFa: null,
    translationEn: null,
    revelationPlace: 'makkah',
    revelationOrder: 1,
    ayahCount: 1,
    pagesFrom: 1,
    pagesTo: 1,
    firstVerseKey: '1:1' as VerseKey,
    lastVerseKey: '1:1' as VerseKey,
    bismillahPre: false,
  };
}

function contentPlan(): ContentPlan {
  const plan = emptyPlan();
  plan.packs = [packRow()];
  plan.surahs = [surah()];
  plan.ayahs = [
    {
      verseKey: '1:1' as VerseKey,
      chapter: 1,
      verse: 1,
      sourceId: null,
      juz: 1,
      hizb: 1,
      rubElHizb: 1,
      sajda: null,
      ruku: null,
      manzil: null,
      page: 1,
      textUthmani: 'بِسْمِ ٱللَّهِ',
      textUthmaniSimple: null,
      wordCount: 2,
      normalizedHash: 'a'.repeat(16),
    } as AyahRow,
  ];
  plan.words = [1, 2].map((position): AyahWordRow => ({
    id: position,
    verseKey: '1:1' as VerseKey,
    position,
    pageNumber: 1,
    lineNumber: 1,
    textUthmani: `كَلِمَة ${position}`,
    translationEn: null,
    transliteration: null,
    root: null,
    morphology: null,
    isEndOfAyahMark: position === 2,
    normalized: `k${position}`,
  }));
  return plan;
}

function report(): ImportReport {
  return {
    at: '2026-01-01T00:00:00.000Z',
    status: 'success',
    durationMs: 5,
    packs: [],
    counts: {
      surahs: 1,
      ayahs: 1,
      words: 2,
      translations: 0,
      tafsirs: 0,
      similar: 0,
      relations: 0,
      concepts: 0,
      audio: 0,
    },
    warnings: [],
  };
}

describe('what the app exports, the app accepts', () => {
  let gateway: TauriGateway;
  let envelope: BackupEnvelope;

  beforeAll(async () => {
    driver.dir = mkdtempSync(join(tmpdir(), 'quran-backup-'));
    gateway = new TauriGateway();
    await gateway.ready();

    planHolder.plan = contentPlan();
    await gateway.importFromContent();

    await gateway.setSetting('theme', 'dark');
    await gateway.addBookmark({ verseKey: '1:1' as VerseKey, label: 'ابتدا' });
    await gateway.saveNote({ verseKey: '1:1' as VerseKey, body: 'یادداشت آزمون' });
    await gateway.saveDailyPlan(PLAN.date, JSON.stringify(PLAN));

    envelope = await gateway.exportBackup();
  });

  afterAll(async () => {
    await gateway.close();
    rmSync(driver.dir, { recursive: true, force: true });
  });

  it('seals the checksum with the rule the validator recomputes', () => {
    // The exact failure seen on the installed app: both sides digest their own
    // idea of the same object, so the file always looked tampered with.
    expect(/^[0-9a-f]{64}$/.test(envelope.checksum)).toBe(true);
    expect(envelope.checksum).toBe(computeDataChecksum(envelope.data));
  });

  it('exports the daily plan decoded, not as its storage row', () => {
    const plans = envelope.data.dailyPlans as Record<string, unknown>[];
    expect(plans).toHaveLength(1);
    const row = plans[0]!;
    expect(row.payload).toBeUndefined();
    expect(row).toMatchObject({
      date: PLAN.date,
      newAyahs: PLAN.newAyahs,
      reviewItems: [],
      weakItems: [],
      confusionGroups: [],
      estimatedMinutes: PLAN.estimatedMinutes,
    });
    expect(typeof row.generatedAt).toBe('string');
    expect(envelope.counts.dailyPlans).toBe(1);
  });

  it('passes the backup screen validator after a file round trip', () => {
    const bytes = serializeEnvelope(envelope);
    expect(canonicalJsonStringify(JSON.parse(bytes))).toBe(bytes);
    const check = validateEnvelopeObject(JSON.parse(bytes));
    expect(check.ok, JSON.stringify(check.errors)).toBe(true);
    expect(check.envelope.data.dailyPlans).toHaveLength(1);
  });

  it('writes file bytes that carry the checksum they were sealed with', async () => {
    const written = await gateway.writeBackupFile('roundtrip.quranbak', envelope);
    expect(written.length).toBeGreaterThan(0);
    const onDisk = ipc.files.get('roundtrip.quranbak');
    expect(onDisk).toBe(serializeEnvelope(envelope));
    const read = await gateway.readBackupFile('roundtrip.quranbak');
    expect(read).not.toBeNull();
    const check = validateEnvelopeObject(read);
    expect(check.ok, JSON.stringify(check.errors)).toBe(true);
  });

  it('restores its own file: the bookmark returns and the plan re-reads identically', async () => {
    const before = await gateway.dailyPlan(PLAN.date);
    expect(before).not.toBeNull();

    await gateway.removeBookmark((await gateway.bookmarks())[0]!.id);
    expect(await gateway.bookmarks()).toHaveLength(0);

    const restored = await gateway.importBackup(JSON.parse(serializeEnvelope(envelope)));
    expect(restored.ok, JSON.stringify(restored)).toBe(true);

    expect(await gateway.bookmarks()).toHaveLength(1);
    expect((await gateway.settings()).theme).toBe('dark');

    const after = await gateway.dailyPlan(PLAN.date);
    expect(after).not.toBeNull();
    expect(JSON.parse(after!.payload)).toEqual(JSON.parse(before!.payload));
    expect(after!.generatedAt).toBe(before!.generatedAt);

    // Restore → export must be stable: the file the user takes the next time
    // seals the same digest over the same data (`createdAt` is excluded from the
    // checksum by design, so only `data` is compared byte for byte).
    const resealed = await gateway.exportBackup();
    expect(canonicalJsonStringify(resealed.data)).toBe(canonicalJsonStringify(envelope.data));
    expect(resealed.checksum).toBe(envelope.checksum);
  });
});
