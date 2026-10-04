/**
 * What a graded recitation leaves on disk, on which axis.
 *
 * WHY this test exists at all: the dual-axis model is only useful if the
 * `hifz_attempt` rows separate the two. A meaning drill stored as form evidence
 * would let the progress screen report a Persian→Arabic cue as verbatim recall,
 * and a cue stored without its pack would be unattributable prose about revelation
 * (AGENTS.md: never invent content). Both are storage properties, so neither is
 * provable from the engine tests, which never touch a database, nor from the
 * screens, which never write one.
 *
 * So this file drives the real path — `createHifzFacade` over `TauriGateway` on
 * real SQLite from the shipped `SCHEMA_SQL` — and then reads the file back with a
 * second connection, bypassing the gateway's read model, because a column that is
 * derived at *read* time would pass a read-through-the-gateway assertion.
 *
 * Pinned:
 *   1. a `meaning-to-arabic` attempt lands on the `meaning` axis and its stored
 *      cue keeps the licensed clause's `lang` and `packId`;
 *   2. the cue comes from the engine's own probe, not from what the screen sent —
 *      a caller that restates the cue is overwritten, not trusted;
 *   3. a `full-ayah` attempt for the same ayah lands on the `form` axis, so the
 *      two numbers the dashboard shows are two selects, not one guess.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Surah, VerseKey } from '@quran/core';
import { RECALL_DIMENSION, tokenizeWords } from '@quran/core';
import { CONTENT_PACK_SCHEMA_VERSION } from '@quran/core';
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
    source: 'tests/integration/hifz-attempt-axis.test.ts',
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
      // No word gloss: the only meaning this install can attribute is the
      // ayah-level clause from the Persian pack.
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

/** Read the attempt rows the way the file is, with no gateway in the way. */
function rawAttempts(): {
  mode: string;
  dimension: string;
  verse_key: string;
  cue: string | null;
}[] {
  const db = new DatabaseSync(join(driver.dir, 'quran.db'));
  try {
    return db
      .prepare('SELECT mode, dimension, verse_key, cue FROM hifz_attempt ORDER BY started_at, id')
      .all() as never;
  } finally {
    db.close();
  }
}

describe('a graded recitation stores its axis and its cue provenance', () => {
  let gateway: TauriGateway;

  beforeAll(async () => {
    driver.dir = mkdtempSync(join(tmpdir(), 'quran-attempt-axis-'));
    planHolder.plan = plan();
    planHolder.report = successReport();
    gateway = new TauriGateway();
    await gateway.ready();
    await gateway.importFromContent();
    await gateway.setSetting('translationPack', FA_PACK);
    for (const key of KEYS) await gateway.addHifzItem(key);
  });

  afterAll(async () => {
    await gateway.close();
    rmSync(driver.dir, { recursive: true, force: true });
  });

  it('a meaning attempt is stored on the meaning axis, attributed to the pack', async () => {
    const facade = createHifzFacade(gateway);
    const session = await facade.startSession(NOW);
    const stepIndex = session.steps.findIndex((s) => s.mode === 'meaning-to-arabic');
    expect(stepIndex, 'no meaning→Arabic step for a covered new ayah').toBeGreaterThan(-1);
    const step = session.steps[stepIndex]!;

    const graded = await facade.submitRecall(
      {
        itemId: step.itemId!,
        verseKey: step.verseKey as VerseKey,
        mode: 'meaning-to-arabic',
        sessionId: session.id,
        stepIndex,
        produced: tokenizeWords(IKHLAS[step.verseKey as VerseKey]).map((text, at) => ({
          position: at + 1,
          text,
        })),
        startedAt: NOW.toISOString(),
      },
      NOW,
    );
    expect(graded.dimension).toBe('meaning');

    const stored = rawAttempts().find((r) => r.verse_key === step.verseKey);
    expect(stored, 'the attempt never reached the database').toBeDefined();
    expect(stored!.dimension).toBe('meaning');
    const cue = JSON.parse(stored!.cue ?? '{}') as { kind: string; text: string; lang: string; packId: string };
    // The licensed clause, with the two fields that make it attributable.
    expect(cue.text).toBe(FA[step.verseKey as VerseKey]);
    expect(cue.lang).toBe('fa');
    expect(cue.packId).toBe(FA_PACK);
    // The read model agrees with the file, which is what the dashboard filters on.
    const [readBack] = await gateway.recallAttempts(graded.itemId, 10);
    expect(readBack?.dimension).toBe('meaning');
    expect(readBack?.cue).toMatchObject({ lang: 'fa', packId: FA_PACK });
  });

  it('the engine owns the cue: a screen that restates it is overwritten, not trusted', async () => {
    const facade = createHifzFacade(gateway);
    const session = await facade.startSession(NOW);
    const stepIndex = session.steps.findIndex((s) => s.mode === 'meaning-to-arabic');
    const step = session.steps[stepIndex]!;

    await facade.submitRecall(
      {
        itemId: step.itemId!,
        verseKey: step.verseKey as VerseKey,
        mode: 'meaning-to-arabic',
        sessionId: session.id,
        stepIndex,
        produced: [],
        // A hostile caller: right kind, invented provenance.
        cue: { kind: 'meaning', text: 'معنی ساختگی', lang: 'und', packId: 'not-installed' },
        startedAt: NOW.toISOString(),
      },
      NOW,
    );

    const stored = rawAttempts().at(-1);
    expect(stored?.verse_key).toBe(step.verseKey);
    const cue = JSON.parse(stored!.cue ?? '{}') as { text: string; lang: string; packId: string };
    expect(cue).not.toMatchObject({ text: 'معنی ساختگی', lang: 'und', packId: 'not-installed' });
    expect(cue).toMatchObject({ text: FA[step.verseKey as VerseKey], lang: 'fa', packId: FA_PACK });
  });

  it('a form attempt for the same ayah stays separable from the meaning axis', async () => {
    const facade = createHifzFacade(gateway);
    const session = await facade.startSession(NOW);
    const formStep = session.steps.find(
      (s) => RECALL_DIMENSION[s.mode] === 'form' && s.itemId !== null && s.verseKey !== null,
    );
    expect(formStep, 'no form step in the session').toBeDefined();

    const graded = await facade.submitRecall(
      {
        itemId: formStep!.itemId!,
        verseKey: formStep!.verseKey as VerseKey,
        mode: formStep!.mode,
        sessionId: session.id,
        stepIndex: session.steps.indexOf(formStep!),
        produced: tokenizeWords(IKHLAS[formStep!.verseKey as VerseKey]).map((text, at) => ({
          position: at + 1,
          text,
        })),
        startedAt: NOW.toISOString(),
      },
      NOW,
    );
    expect(graded.dimension).toBe('form');

    const stored = rawAttempts().find((r) => r.mode === formStep!.mode);
    expect(stored?.dimension).toBe('form');
    // Two selects over one table now give the dashboard its two numbers.
    const rows = rawAttempts();
    expect(rows.filter((r) => r.dimension === 'form').length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.dimension === 'meaning').length).toBeGreaterThan(0);
  });
});
