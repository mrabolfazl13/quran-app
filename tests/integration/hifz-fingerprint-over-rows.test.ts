/**
 * What a graded recitation leaves on the fingerprint rows, on disk.
 *
 * WHY this test exists at all: the chunk rows used to be write-once. Enrolment
 * inserted them at the fresh-memory value and nothing ever moved them, so
 * `hifz_segment.stability` stayed 0 for a learner who had recited the ayah forty
 * times, `error_count` stayed 0 forever, and the fingerprint screen reported a
 * number that was structure rather than memory. The scheduler noticed nothing:
 * `review.ts` estimates the segment factors from item stability when the rows say
 * nothing, which is exactly what rows frozen at their enrolment value say.
 *
 * The update rule itself is pinned in `core/tests/hifz/fingerprint-update.test.ts`,
 * where it is a pure function. What only a database can prove is the half the
 * engine cannot see: that the rows the engine handed back actually reach the
 * file, that the rows it refused do not move, and that an attempt cannot restate
 * the tiling of revelation while it is writing (AGENTS.md non-negotiable 1).
 *
 * So this file drives `createHifzFacade` over `TauriGateway` on real SQLite from
 * the shipped schema, then reads the file back with a second connection: an
 * assertion through the gateway's own read model would pass on a value derived at
 * read time, and this defect was precisely a value that was never written.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { HifzSegment, Surah, VerseKey } from '@quran/core';
import { AXIS_LEARN_RATE, CONTENT_PACK_SCHEMA_VERSION, tokenizeWords } from '@quran/core';
import { TauriGateway } from '../../desktop/src/gateway/tauriGateway';
import { createHifzFacade } from '../../desktop/src/engine/hifzFacade';
import type {
  AyahRow,
  AyahWordRow,
  ContentPlan,
  ImportReport,
  PackRow,
  TranslationRow,
} from '../../desktop/src/gateway/types';
import { emptyPlan } from '../../desktop/src/gateway/types';

const driver = vi.hoisted(() => ({ dir: '' }));

vi.mock('@tauri-apps/plugin-sql', async () => {
  const { DatabaseSync } = await import('node:sqlite');

  class FakeDatabase {
    private constructor(private readonly db: InstanceType<typeof DatabaseSync>) {}

    static async load(url: string): Promise<FakeDatabase> {
      return new FakeDatabase(new DatabaseSync(join(driver.dir, url.replace(/^sqlite:/, ''))));
    }

    async select<TRow>(sql: string, params: unknown[] = []): Promise<TRow[]> {
      return this.db.prepare(sql).all(...bind(params)) as TRow[];
    }

    async execute(sql: string, params: unknown[] = []): Promise<{ rowsAffected: number }> {
      const { changes } = this.db.prepare(sql).run(...bind(params));
      return { rowsAffected: Number(changes) };
    }

    async close(): Promise<void> {
      this.db.close();
    }
  }

  return { default: FakeDatabase };
});

// `node:sqlite` binds null / number / bigint / string / Uint8Array only.
function bind(params: unknown[]): unknown[] {
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

/** The importer has its own suite; the plan is handed over at that seam. */
const planHolder = vi.hoisted(() => ({ plan: null as unknown, report: null as unknown }));

vi.mock('../../desktop/src/content/importer', () => ({
  buildImportPlan: async () => {
    if (!planHolder.plan) throw new Error('test did not stage a plan');
    return { report: planHolder.report, plan: planHolder.plan };
  },
}));

const MUSHAF_PACK = 'test-mushaf';
const FA_PACK = 'tr-fa-test';
const NOW = new Date('2026-09-29T12:00:00.000Z');

/** Surah 112 as `content/quran-core` ships it: the text decides every span below. */
const IKHLAS: Record<VerseKey, string> = {
  '112:1': 'قُلْ هُوَ ٱللَّهُ أَحَدٌ',
  '112:2': 'ٱللَّهُ ٱلصَّمَدُ',
  '112:3': 'لَمْ يَلِدْ وَلَمْ يُولَدْ',
  '112:4': 'وَلَمْ يَكُن لَّهُۥ كُفُوًا أَحَدٌۢ',
};
const KEYS = Object.keys(IKHLAS) as VerseKey[];
const FA: Record<VerseKey, string> = {
  '112:1': 'بگو: او خدا یکتاست',
  '112:2': 'خدایی که همه به او نیازمندند',
  '112:3': 'نه زاده است و نه زاده شده',
  '112:4': 'و هیچ کس همتای او نیست',
};

function packRow(id: string, kind: PackRow['kind'], language: string, title: string): PackRow {
  return {
    id,
    kind,
    version: '1',
    schemaVersion: CONTENT_PACK_SCHEMA_VERSION,
    language,
    title,
    source: 'tests/integration/hifz-fingerprint-over-rows.test.ts',
    licenseName: 'Test',
    licenseSpdx: 'MIT',
    licenseStatus: 'clear',
    licenseNotes: '',
    attribution: {
      publisher: 'QA',
      work: title,
      edition: null,
      sourceUrl: '',
      retrievedAt: '2026-01-01T00:00:00.000Z',
      creditLine: 'fixture',
    },
    checksum: '0'.repeat(64),
    payloadBytes: 128,
    recordCount: 4,
    importedAt: '2026-01-01T00:00:00.000Z',
  };
}

function plan(): ContentPlan {
  const out = emptyPlan();
  out.packs = [
    packRow(MUSHAF_PACK, 'mushaf', 'ar', 'Test mushaf'),
    packRow(FA_PACK, 'translation', 'fa', 'آزمون فارسی'),
  ];
  out.surahs = [
    {
      number: 112,
      nameArabic: 'سُورَةُ الإخلاص',
      nameSimple: 'Surah 112',
      nameTransliterated: 'Surah 112',
      translationFa: null,
      translationEn: null,
      revelationPlace: 'makkah',
      revelationOrder: 112,
      ayahCount: 4,
      pagesFrom: 604,
      pagesTo: 604,
      firstVerseKey: '112:1' as VerseKey,
      lastVerseKey: '112:4' as VerseKey,
      bismillahPre: false,
    } satisfies Surah,
  ];
  out.ayahs = KEYS.map((verseKey, index): AyahRow => ({
    verseKey,
    chapter: 112,
    verse: index + 1,
    sourceId: null,
    juz: 30,
    hizb: 60,
    rubElHizb: 1,
    sajda: null,
    ruku: null,
    manzil: null,
    page: 604,
    textUthmani: IKHLAS[verseKey],
    textUthmaniSimple: null,
    wordCount: tokenizeWords(IKHLAS[verseKey]).length,
    normalizedHash: 'a'.repeat(16),
  }));
  out.words = out.ayahs.flatMap((ayah): AyahWordRow[] =>
    tokenizeWords(IKHLAS[ayah.verseKey]).map((text, position) => ({
      id: (ayah.chapter * 100 + ayah.verse) * 100 + position,
      verseKey: ayah.verseKey,
      position: position + 1,
      pageNumber: 604,
      lineNumber: position + 1,
      textUthmani: text,
      translationEn: null,
      transliteration: null,
      root: null,
      morphology: null,
      isEndOfAyahMark: false,
      normalized: `w${position + 1}`,
    })),
  );
  out.translations = KEYS.map(
    (verseKey): TranslationRow => ({ verseKey, packId: FA_PACK, text: FA[verseKey] }),
  );
  return out;
}

function successReport(): ImportReport {
  return {
    at: '2026-01-01T00:00:00.000Z',
    status: 'success',
    durationMs: 5,
    packs: [],
    counts: {
      surahs: 1,
      ayahs: 4,
      words: 16,
      translations: 4,
      tafsirs: 0,
      similar: 0,
      relations: 0,
      concepts: 0,
      audio: 0,
    },
    warnings: [],
  };
}

/** A `hifz_segment` row exactly as the file holds it. */
interface RawSegment {
  id: string;
  item_id: string;
  verse_key: string;
  position: number;
  from_word: number;
  to_word: number;
  text: string;
  meaning_text: string | null;
  meaning_pack: string | null;
  stability: number;
  meaning_stability: number | null;
  error_count: number;
}

/** A `hifz_transition` row exactly as the file holds it. */
interface RawTransition {
  id: string;
  item_id: string;
  verse_key: string;
  kind: string;
  to_verse_key: string | null;
  to_word: number;
  success_count: number;
  failure_count: number;
  stability: number;
  last_practiced_at: string | null;
}

function readRaw<TRow>(sql: string): TRow[] {
  const db = new DatabaseSync(join(driver.dir, 'quran.db'));
  try {
    return db.prepare(sql).all() as TRow[];
  } finally {
    db.close();
  }
}

const segmentRows = (): RawSegment[] =>
  readRaw<RawSegment>('SELECT * FROM hifz_segment ORDER BY verse_key, position');
const transitionRows = (): RawTransition[] =>
  readRaw<RawTransition>('SELECT * FROM hifz_transition ORDER BY verse_key, kind, to_word');

/** The words of one ayah, by absolute 1-based position inside it. */
function wordsOf(verseKey: VerseKey): string[] {
  return tokenizeWords(IKHLAS[verseKey]);
}

function recite(verseKey: VerseKey, from: number, to: number, skip: number[] = []) {
  const absolute = wordsOf(verseKey);
  const out: { position: number; text: string }[] = [];
  for (let at = from; at <= to; at += 1) {
    if (skip.includes(at)) continue;
    const text = absolute[at - 1];
    if (text) out.push({ position: at, text });
  }
  return out;
}

/** The whole ayah, with no session step behind it. */
async function reciteWholeAyah(gateway: TauriGateway, itemId: string, verseKey: VerseKey, skip: number[] = []) {
  const facade = createHifzFacade(gateway);
  return facade.submitRecall(
    {
      itemId,
      verseKey,
      mode: 'full-ayah',
      sessionId: null,
      produced: recite(verseKey, 1, wordsOf(verseKey).length, skip),
      startedAt: NOW.toISOString(),
    },
    NOW,
  );
}

describe('a graded recitation moves the fingerprint rows it covered, in the file', () => {
  let gateway: TauriGateway;
  /** verse_key → item id, read out of the gateway after enrolment. */
  let itemOf: Record<string, string>;

  beforeAll(async () => {
    driver.dir = mkdtempSync(join(tmpdir(), 'quran-fingerprint-rows-'));
    planHolder.plan = plan();
    planHolder.report = successReport();
    gateway = new TauriGateway();
    await gateway.ready();
    await gateway.importFromContent();
    await gateway.setSetting('translationPack', FA_PACK);
    for (const key of KEYS) await gateway.addHifzItem(key);
    itemOf = {};
    for (const item of await gateway.hifzItems()) itemOf[item.verseKey] = item.id;
  });

  afterAll(async () => {
    await gateway.close();
    rmSync(driver.dir, { recursive: true, force: true });
  });

  it('enrolment leaves every chunk at the fresh-memory value, so later movement is evidence', () => {
    const rows = segmentRows();
    // Structure first: without these rows the fingerprint has nothing to score.
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.verse_key)).size).toBe(KEYS.length);
    expect(rows.every((r) => r.stability === 0 && r.error_count === 0)).toBe(true);
    expect(rows.every((r) => r.meaning_stability === null)).toBe(true);
    expect(transitionRows().every((t) => t.success_count === 0 && t.last_practiced_at === null)).toBe(true);
  });

  it('a whole-ayah recitation scores every chunk of that ayah and no other', async () => {
    const before = segmentRows();
    await reciteWholeAyah(gateway, itemOf['112:1']!, '112:1' as VerseKey);
    const after = segmentRows();

    const mine = after.filter((r) => r.verse_key === '112:1');
    expect(mine.length).toBeGreaterThan(0);
    // 0 + 0.3 · (1 − 0): the engine's step, in the file, not a recomputed guess.
    for (const row of mine) expect(row.stability).toBeCloseTo(AXIS_LEARN_RATE, 10);

    // The other three ayat have not been recited; their rows are the baseline
    // numbers, unchanged. This is the claim the fingerprint screen makes.
    const others = after.filter((r) => r.verse_key !== '112:1');
    const beforeOthers = new Map(before.filter((r) => r.verse_key !== '112:1').map((r) => [r.id, r.stability]));
    expect(others.every((r) => r.stability === beforeOthers.get(r.id))).toBe(true);
    expect(others.every((r) => r.stability === 0)).toBe(true);
  });

  it('a chunk-scoped step moves only the chunk it asked for, and counts its own errors', async () => {
    const session = await createHifzFacade(gateway).startSession(NOW);
    // `segment` is emitted for every new ayah, so the step exists by construction.
    const stepIndex = session.steps.findIndex((s) => s.mode === 'segment' && s.verseKey === '112:3');
    expect(stepIndex, 'no segment step for the new ayah 112:3').toBeGreaterThan(-1);
    const step = session.steps[stepIndex]!;

    const stored = (await gateway.hifzSegments(step.itemId!)).filter((s: HifzSegment) => s.verseKey === '112:3');
    const cued = stored[0]!;
    // One word inside the cued chunk is missing; the rest of the ayah is untouched
    // by the request, so nothing outside the chunk may answer for it.
    const dropped = cued.fromWord;
    const attempt = await createHifzFacade(gateway).submitRecall(
      {
        itemId: step.itemId!,
        verseKey: step.verseKey as VerseKey,
        mode: 'segment',
        sessionId: session.id,
        stepIndex,
        produced: recite('112:3' as VerseKey, cued.fromWord, cued.toWord, [dropped]),
        startedAt: NOW.toISOString(),
      },
      NOW,
    );
    expect(attempt.errors.length, 'the graded chunk produced no error at all').toBeGreaterThan(0);

    const after = segmentRows().filter((r) => r.verse_key === '112:3');
    const scored = after.find((r) => r.position === cued.position)!;
    expect(scored.stability).toBeGreaterThan(0);
    expect(scored.error_count).toBeGreaterThan(0);
    // A chunk nobody recited keeps the enrolment number while its neighbour does
    // not: the two clauses of one ayah are now two measurements.
    const untouched = after.filter((r) => r.position !== cued.position);
    if (untouched.length > 0) {
      expect(untouched.every((r) => r.stability === 0 && r.error_count === 0)).toBe(true);
    }
  });

  it('a meaning drill lifts the meaning column and leaves the form number where it was', async () => {
    const session = await createHifzFacade(gateway).startSession(NOW);
    const stepIndex = session.steps.findIndex(
      (s) => (s.mode === 'meaning-to-arabic' || s.mode === 'concept-cue') && s.verseKey === '112:2',
    );
    expect(stepIndex, 'no meaning step for the ayah the Persian pack covers').toBeGreaterThan(-1);
    const step = session.steps[stepIndex]!;

    const before = segmentRows().filter((r) => r.verse_key === '112:2');
    await createHifzFacade(gateway).submitRecall(
      {
        itemId: step.itemId!,
        verseKey: step.verseKey as VerseKey,
        mode: step.mode,
        sessionId: session.id,
        stepIndex,
        produced: recite('112:2' as VerseKey, 1, wordsOf('112:2' as VerseKey).length),
        startedAt: NOW.toISOString(),
      },
      NOW,
    );
    const after = segmentRows().filter((r) => r.verse_key === '112:2');

    // The form axis is a separate memory: a Persian→Arabic cue proves nothing
    // about producing the Arabic, so its column must not move (docs/hifz-engine.md).
    const form = new Map(before.map((r) => [r.id, r.stability]));
    expect(after.every((r) => r.stability === form.get(r.id))).toBe(true);
    expect(after.some((r) => r.meaning_stability !== null)).toBe(true);
  });

  it('the gateway writers move only the stateful columns of the rows they are handed', async () => {
    // This pins the plumbing end-to-end: the engine decides which rows moved, the
    // facade hands them to the gateway, and the file changes exactly those three
    // numbers per chunk and four per hinge. It does not depend on the probe/session
    // composition, which is why the previous test struggled with intra/inter
    // semantics.
    const before = segmentRows();
    const firstChunk = before.find((r) => r.verse_key === '112:1' && r.position === 0)!;
    await gateway.updateHifzSegments([
      {
        id: firstChunk.id,
        itemId: firstChunk.item_id,
        verseKey: firstChunk.verse_key,
        position: firstChunk.position,
        fromWord: firstChunk.from_word,
        toWord: firstChunk.to_word,
        text: firstChunk.text,
        meaning: firstChunk.meaning_text ? { text: firstChunk.meaning_text, lang: 'fa', packId: firstChunk.meaning_pack!, wordGloss: false } : null,
        stability: 0.7,
        meaningStability: 0.4,
        errorCount: 2,
      },
    ]);
    const after = segmentRows().find((r) => r.id === firstChunk.id)!;
    expect(after.stability).toBe(0.7);
    expect(after.meaning_stability).toBe(0.4);
    expect(after.error_count).toBe(2);
    // Tiling untouched.
    expect(after.text).toBe(firstChunk.text);
    expect(after.from_word).toBe(firstChunk.from_word);
    expect(after.to_word).toBe(firstChunk.to_word);

    const tBefore = transitionRows();
    const firstHinge = tBefore[0]!;
    // Build a proper HifzTransition from the raw row.
    await gateway.updateHifzTransitions([
      {
        id: firstHinge.id,
        itemId: firstHinge.item_id,
        verseKey: firstHinge.verse_key,
        kind: firstHinge.kind as 'intra' | 'inter',
        toVerseKey: (firstHinge.to_verse_key ?? null) as VerseKey | null,
        toWord: firstHinge.to_word,
        successCount: 3,
        failureCount: 1,
        stability: 0.5,
        lastPracticedAt: NOW.toISOString(),
      },
    ]);
    const tAfter = transitionRows().find((t) => t.id === firstHinge.id)!;
    expect(tAfter.success_count).toBe(3);
    expect(tAfter.failure_count).toBe(1);
    expect(tAfter.stability).toBe(0.5);
    expect(tAfter.last_practiced_at).toBe(NOW.toISOString());
    // Structure untouched.
    expect(tAfter.to_word).toBe(firstHinge.to_word);
    expect(tAfter.kind).toBe(firstHinge.kind);
  });

  it('no attempt restates the tiling: text, spans and provenance are byte-identical', async () => {
    // AGENTS.md non-negotiable 1 — Quran text is immutable. The fingerprint
    // writer is allowed to touch three numbers on a chunk and four on a hinge;
    // everything that describes *what the chunk is* must survive every attempt
    // exactly as the import and the segmentation rules produced it.
    const rows = segmentRows();
    const structure = rows.map((r) =>
      [r.id, r.item_id, r.verse_key, r.position, r.from_word, r.to_word, r.text, r.meaning_text, r.meaning_pack].join('|'),
    );
    const hinges = transitionRows().map((t) =>
      [t.id, t.item_id, t.verse_key, t.kind, t.to_verse_key, t.to_word].join('|'),
    );

    await reciteWholeAyah(gateway, itemOf['112:1']!, '112:1' as VerseKey, [2]);
    expect(segmentRows().map((r) =>
      [r.id, r.item_id, r.verse_key, r.position, r.from_word, r.to_word, r.text, r.meaning_text, r.meaning_pack].join('|'),
    )).toEqual(structure);
    expect(transitionRows().map((t) =>
      [t.id, t.item_id, t.verse_key, t.kind, t.to_verse_key, t.to_word].join('|'),
    )).toEqual(hinges);
  });

  it('a second recitation of the same chunk keeps moving its number instead of resetting it', async () => {
    const first = segmentRows().filter((r) => r.verse_key === '112:1');
    await reciteWholeAyah(gateway, itemOf['112:1']!, '112:1' as VerseKey);
    const second = segmentRows().filter((r) => r.verse_key === '112:1');
    for (const row of second) {
      const previous = first.find((r) => r.id === row.id)!;
      expect(row.stability).toBeGreaterThan(previous.stability);
      // Toward 1, so it climbs and never overshoots the ceiling.
      expect(row.stability).toBeLessThan(1);
    }
  });
});
