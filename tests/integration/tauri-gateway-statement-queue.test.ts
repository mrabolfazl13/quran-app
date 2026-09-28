/**
 * The gateway must never let two statements be in flight.
 *
 * WHY this test exists at all: `tauri-plugin-sql` 2.5.0 executes every
 * `db.execute()`/`db.select()` as a separate `pool.<statement>()` against a sqlx
 * pool sized to the CPU count. Two overlapping calls therefore run on two
 * different SQLite connections, and a `BEGIN … COMMIT` spread over separate
 * calls stops being a transaction — the `BEGIN` is on one connection, the
 * inserts on another. On the installed app this was reproduced with a single
 * click on the import button and no external reader: the app's own
 * `Promise.all` of fifteen `COUNT(*)` queries in `counts()` was enough to make
 * the writer die with `(code: 5) database is locked`, its `ROLLBACK` report
 * `no transaction is active`, and a content table stay half-filled.
 *
 * What is pinned here, in order:
 *   1. Concurrent gateway calls are serialised at the driver, so the pool is
 *      never asked for a second connection.
 *   2. A manual transaction is contiguous: no read statement lands between its
 *      `BEGIN` and its `COMMIT`, even when the UI reads while it writes.
 *   3. An import that validated but could not be written is reported with
 *      `stage: 'write'` and stored, instead of the click doing nothing.
 *   4. Bulk content is written in chunked statements under SQLite's parameter
 *      ceiling, and the bound values — apostrophes, quotes, diacritics — come
 *      back byte-exact. Serialising the queue makes every statement a Tauri
 *      round trip, so one row per call is what cost the installed app 164 s of
 *      wall clock on first run.
 *
 * The driver is a fake of `@tauri-apps/plugin-sql` only: the SQL, the schema and
 * the transactions are real SQLite (`node:sqlite`), created from the same
 * `SCHEMA_SQL` the app runs. A single handle stands in for the single connection
 * the queue is supposed to keep; the fake refuses any second concurrent
 * statement, so a future change that bypasses the queue fails loudly here
 * instead of producing a corrupted database on a user's machine.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Surah, VerseKey } from '@quran/core';
import { CONTENT_PACK_SCHEMA_VERSION } from '@quran/core';
import { TauriGateway } from '../../desktop/src/gateway/tauriGateway';
import { MAX_PARAMS_PER_STATEMENT } from '../../desktop/src/gateway/batchInsert';
import type {
  AyahRow,
  AyahWordRow,
  ContentPlan,
  ImportReport,
  PackRow,
  TranslationRow,
} from '../../desktop/src/gateway/types';
import { emptyPlan } from '../../desktop/src/gateway/types';

/** Everything the fake driver records, reachable from the hoisted mock factory. */
const driver = vi.hoisted(() => ({
  /** Absolute path the fake opens; set by `beforeAll`. */
  dir: '',
  /** Statements in the order they reached the driver. */
  log: [] as { sql: string; params: unknown[] }[],
  inFlight: 0,
  maxInFlight: 0,
  /** The overlap the real plugin creates; here it is an immediate failure. */
  overlaps: [] as string[],
}));

vi.mock('@tauri-apps/plugin-sql', async () => {
  const { DatabaseSync } = await import('node:sqlite');

  class FakeDatabase {
    private constructor(private readonly db: InstanceType<typeof DatabaseSync>) {}

    static async load(url: string): Promise<FakeDatabase> {
      // `sqlite:quran.db` → the temp file this test owns.
      const file = join(driver.dir, url.replace(/^sqlite:/, ''));
      return new FakeDatabase(new DatabaseSync(file));
    }

    async select<TRow>(sql: string, params: unknown[] = []): Promise<TRow[]> {
      return this.hold(sql, () => this.db.prepare(sql).all(...bind(params)) as TRow[], params);
    }

    async execute(sql: string, params: unknown[] = []): Promise<{ rowsAffected: number }> {
      const { changes } = await this.hold(sql, () => this.db.prepare(sql).run(...bind(params)), params);
      return { rowsAffected: Number(changes) };
    }

    async close(): Promise<void> {
      this.db.close();
    }

    /**
     * One statement, holding the connection across an await the way the real
     * plugin holds it across the IPC round trip. Without that gap two calls made
     * in the same tick would look sequential to this fake while the real pool
     * hands them two connections — which is precisely the bug under test.
     */
    private async hold<T>(sql: string, fn: () => T, params: unknown[] = []): Promise<T> {
      driver.log.push({ sql, params });
      driver.inFlight += 1;
      driver.maxInFlight = Math.max(driver.maxInFlight, driver.inFlight);
      if (driver.inFlight > 1) {
        driver.overlaps.push(sql.slice(0, 80));
        driver.inFlight -= 1;
        throw new Error(`two statements checked out at once: ${sql.slice(0, 80)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        return fn();
      } finally {
        driver.inFlight -= 1;
      }
    }
  }

  return { default: FakeDatabase };
});

// `node:sqlite` binds null / number / bigint / string / Uint8Array only.
function bind(params: unknown[]): unknown[] {
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

/**
 * The importer is not what this test is about (it has its own suite), but
 * `importFromContent` reaches it through a `PackSource` that only exists inside
 * Tauri. The plan below is handed over at that seam instead.
 */
const planHolder = vi.hoisted(() => ({ plan: null as unknown, report: null as unknown }));

vi.mock('../../desktop/src/content/importer', () => ({
  buildImportPlan: async () => {
    if (!planHolder.plan) throw new Error('test did not stage a plan');
    return { report: planHolder.report, plan: planHolder.plan };
  },
}));

const PACK_ID = 'test-mushaf';

function packRow(): PackRow {
  return {
    id: PACK_ID,
    kind: 'mushaf',
    version: '1',
    schemaVersion: CONTENT_PACK_SCHEMA_VERSION,
    language: 'ar',
    title: 'Test mushaf',
    source: 'tests/integration/tauri-gateway-statement-queue.test.ts',
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
    recordCount: 3,
    importedAt: '2026-01-01T00:00:00.000Z',
  };
}

function surah(number: number): Surah {
  return {
    number,
    nameArabic: `سُورَةُ ${number}`,
    nameSimple: `Surah ${number}`,
    nameTransliterated: `Surah ${number}`,
    translationFa: null,
    translationEn: null,
    revelationPlace: 'makkah',
    revelationOrder: number,
    ayahCount: 3,
    pagesFrom: 1,
    pagesTo: 1,
    firstVerseKey: `${number}:1` as VerseKey,
    lastVerseKey: `${number}:3` as VerseKey,
    bismillahPre: false,
  };
}

function plan(chapter: number): ContentPlan {
  const plan = emptyPlan();
  plan.packs = [packRow()];
  plan.surahs = [surah(chapter)];
  plan.ayahs = [1, 2, 3].map((verse): AyahRow => ({
    verseKey: `${chapter}:${verse}` as VerseKey,
    chapter,
    verse,
    sourceId: null,
    juz: 1,
    hizb: 1,
    rubElHizb: 1,
    sajda: null,
    ruku: null,
    manzil: null,
    page: 1,
    textUthmani: `كَلِمَاتٌ ${chapter}:${verse}`,
    textUthmaniSimple: null,
    wordCount: 2,
    normalizedHash: 'a'.repeat(16),
  }));
  let id = 0;
  plan.words = plan.ayahs.flatMap((a): AyahWordRow[] =>
    [1, 2].map((position) => ({
      id: (id += 1),
      verseKey: a.verseKey,
      position,
      pageNumber: 1,
      lineNumber: position,
      textUthmani: `${a.textUthmani} — ${position}`,
      translationEn: null,
      transliteration: null,
      root: null,
      morphology: null,
      isEndOfAyahMark: false,
      normalized: `k${position}`,
    })),
  );
  plan.translations = plan.ayahs.map(
    (a): TranslationRow => ({ verseKey: a.verseKey, packId: PACK_ID, text: `verse ${a.verseKey}` }),
  );
  return plan;
}

function successReport(): ImportReport {
  return {
    at: '2026-01-01T00:00:00.000Z',
    status: 'success',
    durationMs: 5,
    packs: [],
    counts: {
      surahs: 1,
      ayahs: 3,
      words: 6,
      translations: 3,
      tafsirs: 0,
      similar: 0,
      relations: 0,
      concepts: 0,
      audio: 0,
    },
    warnings: [],
  };
}

/** The statement slices between `BEGIN` and its terminating `COMMIT`/`ROLLBACK`. */
function transactions(log = driver.log): string[][] {
  const out: string[][] = [];
  let current: string[] | null = null;
  for (const entry of log) {
    const head = entry.sql.trim().toUpperCase();
    if (head === 'BEGIN') {
      current = [];
      continue;
    }
    if (head === 'COMMIT' || head === 'ROLLBACK') {
      if (current) out.push(current);
      current = null;
      continue;
    }
    if (current) current.push(entry.sql);
  }
  return out;
}

describe('TauriGateway statement queue', () => {
  let gateway: TauriGateway;

  beforeAll(async () => {
    driver.dir = mkdtempSync(join(tmpdir(), 'quran-queue-'));
    gateway = new TauriGateway();
    await gateway.ready();
  });

  afterAll(async () => {
    await gateway.close();
    rmSync(driver.dir, { recursive: true, force: true });
  });

  it('keeps one statement in flight when the UI reads five things at once', async () => {
    driver.log.length = 0;
    driver.maxInFlight = 0;
    // `homeStats` and `counts` are the two that fan out: a dozen-plus queries
    // issued with `Promise.all`. This is the exact shape that broke the import.
    await Promise.all([
      gateway.counts(),
      gateway.homeStats(new Date('2026-01-01T00:00:00Z')),
      gateway.packs(),
      gateway.surahs(),
      gateway.settings(),
    ]);
    expect(driver.overlaps).toEqual([]);
    expect(driver.maxInFlight).toBe(1);
    expect(driver.log.length).toBeGreaterThan(20);
  });

  it('runs a manual transaction contiguously while a read is waiting behind it', async () => {
    planHolder.plan = plan(1);
    planHolder.report = successReport();
    driver.log.length = 0;
    driver.maxInFlight = 0;

    await Promise.all([gateway.importFromContent(), gateway.counts(), gateway.packs()]);

    expect(driver.overlaps).toEqual([]);
    expect(driver.maxInFlight).toBe(1);

    const importTxn = transactions().find((block) => block.some((sql) => /DELETE FROM surah/i.test(sql)));
    expect(importTxn, 'the import did not run inside a transaction').toBeDefined();
    // Nothing that is not part of the import may appear inside it: a read
    // checked out on a second connection is what makes the BEGIN meaningless.
    expect(importTxn!.filter((sql) => /^\s*SELECT/i.test(sql))).toEqual([]);
    expect(importTxn!.some((sql) => /defer_foreign_keys/i.test(sql))).toBe(true);

    const counts = await gateway.counts();
    expect(counts.ayahs).toBe(3);
    expect(counts.words).toBe(6);
    expect(counts.packs).toBe(1);
    // The report is written inside the same transaction as the content.
    const stored = await gateway.importReport();
    expect(stored?.status).toBe('success');
  });

  it('reports a write that the database refused, and stores that report', async () => {
    // The content from the previous test must survive a refused write.
    const before = await gateway.counts();
    expect(before.ayahs).toBe(3);

    planHolder.plan = plan(2);
    planHolder.report = successReport();
    const spy = vi
      .spyOn(gateway, 'applyImport')
      .mockRejectedValue(new Error('error returned from database: (code: 5) database is locked'));

    const report = await gateway.importFromContent();

    spy.mockRestore();
    expect(report.status).toBe('failed');
    expect(report.issue?.stage).toBe('write');
    expect(report.issue?.message).toMatch(/database is locked/);

    const stored = await gateway.importReport();
    expect(stored?.status).toBe('failed');
    expect(stored?.issue?.message).toMatch(/database is locked/);

    const after = await gateway.counts();
    expect(after.ayahs).toBe(before.ayahs);
  });

  it('rolls a half-finished import back instead of leaving partial content', async () => {
    const before = await gateway.counts();
    planHolder.plan = plan(3);
    planHolder.report = successReport();

    // A real failure inside the transaction: the plan writes a word row for a
    // verse that is not in it. `defer_foreign_keys` moves that check to COMMIT,
    // so the whole import — including the content-table clears — must unwind.
    const original = planHolder.plan as ContentPlan;
    original.words.push({
      ...original.words[0],
      id: 9999,
      verseKey: '114:1' as VerseKey,
    });

    const report = await gateway.importFromContent();

    expect(report.status).toBe('failed');
    expect(report.issue?.stage).toBe('write');
    expect(report.issue?.message).toMatch(/foreign key/i);

    const counts = await gateway.counts();
    expect(counts.ayahs).toBe(before.ayahs);
    expect(counts.words).toBe(before.words);
    expect(await gateway.packs()).toHaveLength(before.packs);
  });

  it('writes bulk content in chunked statements, not one round trip per record', async () => {
    // 2,000 words is a tenth of the shipped `word-data` pack and enough to cross
    // several chunks: the whole point of the batching is that this is not
    // 2,000 `execute()` calls, because on the installed app that shape cost
    // 164 s of wall clock with the UI blocked on the queue.
    const words = 2000;
    const staged = bigPlan(4, words);
    planHolder.plan = staged;
    planHolder.report = successReport();
    driver.log.length = 0;
    driver.maxInFlight = 0;

    await gateway.importFromContent();

    const wordInserts = driver.log.filter((entry) => /^\s*INSERT INTO ayah_word/i.test(entry.sql));
    expect(wordInserts.length).toBeGreaterThan(1);
    expect(wordInserts.length).toBeLessThan(40);
    for (const entry of driver.log) {
      expect(entry.params.length).toBeLessThanOrEqual(MAX_PARAMS_PER_STATEMENT);
    }
    expect(driver.overlaps).toEqual([]);
    expect(driver.maxInFlight).toBe(1);

    const counts = await gateway.counts();
    expect(counts.words).toBe(words);
    expect(counts.ayahs).toBe(words / 2);

    // Bound parameters are why the chunk is safe: apostrophes, quotation marks
    // and a backslash come back byte-for-byte, with no escaping step to get wrong.
    const storedAyah = await gateway.ayah('4:1' as VerseKey);
    expect(storedAyah?.textUthmani).toBe(staged.ayahs[0]?.textUthmani);
    const storedWords = await gateway.words('4:1' as VerseKey);
    expect(storedWords).toHaveLength(2);
    expect(storedWords[0]?.textUthmani).toBe(staged.words[0]?.textUthmani);
    expect(storedWords[1]?.isEndOfAyahMark).toBe(true);

    // The report the screen quotes covers the write, not just the mapping.
    const stored = await gateway.importReport();
    expect(stored!.durationMs).toBeGreaterThan(successReport().durationMs);
  });
});

/**
 * A plan sized like the real corpus, carrying the text shapes that would break a
 * string-built INSERT: a single quote, a double quote and a backslash.
 */
function bigPlan(chapter: number, wordCount: number): ContentPlan {
  const tricky = "قُلْ 'أَعُوذُ' بِرَبِّ النَّاسِ \"الناس\" \\";
  const ayahCount = wordCount / 2;
  const plan = emptyPlan();
  plan.packs = [packRow()];
  plan.surahs = [{ ...surah(chapter), ayahCount, lastVerseKey: `${chapter}:${ayahCount}` as VerseKey }];
  plan.ayahs = Array.from({ length: ayahCount }, (_, index): AyahRow => {
    const verse = index + 1;
    return {
      verseKey: `${chapter}:${verse}` as VerseKey,
      chapter,
      verse,
      sourceId: null,
      juz: 1,
      hizb: 1,
      rubElHizb: 1,
      sajda: null,
      ruku: null,
      manzil: null,
      page: 1 + (verse % 3),
      textUthmani: verse === 1 ? tricky : `${tricky} ${verse}`,
      textUthmaniSimple: null,
      wordCount: 2,
      normalizedHash: 'b'.repeat(16),
    };
  });
  let id = 0;
  plan.words = plan.ayahs.flatMap((a): AyahWordRow[] =>
    [1, 2].map((position) => ({
      id: (id += 1),
      verseKey: a.verseKey,
      position,
      pageNumber: a.page,
      lineNumber: position,
      textUthmani: `${a.textUthmani} — ${position}`,
      translationEn: position === 1 ? null : `word ${position}`,
      transliteration: null,
      root: null,
      morphology: null,
      isEndOfAyahMark: position === 2,
      normalized: `k${position}`,
    })),
  );
  plan.translations = plan.ayahs.map(
    (a): TranslationRow => ({ verseKey: a.verseKey, packId: PACK_ID, text: `verse ${a.verseKey}` }),
  );
  return plan;
}
