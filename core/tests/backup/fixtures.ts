/**
 * Shared fixtures for the backup suite: a realistic user-data set, a real
 * `node:sqlite` database built from `core/src/contracts/db.sql`, a sync/async
 * `RestoreDatabase` adapter, and a DB→rows reader that mirrors what the
 * desktop layer will implement.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { BackupEnvelope, BackupUserData } from '../../src/contracts/backup';
import type { VerseKey } from '../../src/contracts/quran';
import type { AnchorWord, ConfusionGroup, HifzItem, HifzSegment, HifzSession, HifzTransition, RecallAttempt } from '../../src/contracts/hifz';
import { buildEnvelope, computeCounts, computeDataChecksum } from '../../src/backup/export';
import type { BackupRows, DailyPlanRow, JourneyRow, ReflectionRow } from '../../src/backup/types';
import { coerceSetting } from '../../src/backup/settings';
import type { RestoreDatabase, RestoreStatement, SqlValue } from '../../src/backup/restore';

export const vk = (s: string): VerseKey => s as VerseKey;

export const META = {
  app: 'quran-desktop',
  version: '0.1.0',
  platform: 'desktop' as const,
  createdAt: '2026-09-28T12:00:00.000Z',
};

/** Physical user tables (must equal `RESTORE_TABLES`). */
export const USER_TABLES = [
  'settings', 'bookmark', 'note', 'reading_position', 'reading_history',
  'hifz_item', 'hifz_segment', 'anchor_word', 'hifz_transition', 'hifz_attempt',
  'confusion_group', 'confusion_group_item', 'hifz_session',
  'learning_journey', 'journey_progress', 'daily_plan', 'reflection',
] as const;

const DB_SQL = readFileSync(fileURLToPath(new URL('../../src/contracts/db.sql', import.meta.url)), 'utf8');

/** In-memory DB with the shipped schema plus the content rows fixtures use. */
export function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(DB_SQL);
  insertContent(db);
  return db;
}

function insertContent(db: DatabaseSync): void {
  const surah = db.prepare(
    `INSERT INTO surah (number, name_arabic, name_simple, name_transliterated, revelation_place,
      revelation_order, ayah_count, pages_from, pages_to, first_verse_key, last_verse_key, bismillah_pre)
     VALUES (?, ?, ?, ?, 'makkah', ?, ?, 1, 1, ?, ?, 0)`,
  );
  surah.run(1, 'الفاتحة', 'Al-Fatihah', 'Al-Fatihah', 1, 7, '1:1', '1:7');
  surah.run(2, 'البقرة', 'Al-Baqarah', 'Al-Baqarah', 2, 2, '2:1', '2:2');
  surah.run(112, 'الإخلاص', 'Al-Ikhlas', 'Al-Ikhlas', 18, 4, '112:1', '112:4');
  const ayah = db.prepare(
    `INSERT INTO ayah (verse_key, chapter, verse, juz, hizb, rub_el_hizb, page, text_uthmani, word_count, normalized_hash)
     VALUES (?, ?, ?, 1, 1, 1, 1, ?, 5, 'hash')`,
  );
  for (let v = 1; v <= 7; v++) ayah.run(`1:${v}`, 1, v, 'بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ');
  for (let v = 1; v <= 2; v++) ayah.run(`2:${v}`, 2, v, 'الم');
  for (let v = 1; v <= 4; v++) ayah.run(`112:${v}`, 112, v, 'قُلْ هُوَ ٱللَّهُ أَحَدٌ');
}

/** Adapter: node:sqlite → database-agnostic RestoreDatabase. */
export function driver(db: DatabaseSync): RestoreDatabase {
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql): RestoreStatement => {
      const stmt = db.prepare(sql);
      return {
        run: (params: SqlValue[] = []) => stmt.run(...params),
        get: (params: SqlValue[] = []) => stmt.get(...params),
      };
    },
  };
}

/** Wrap a driver so the nth `run()` call blows up (rollback testing). */
export function failingAt(inner: RestoreDatabase, n: number, hit: () => void): RestoreDatabase {
  let runs = 0;
  const wrap = (stmt: RestoreStatement): RestoreStatement => ({
    run: async (params: SqlValue[] = []) => {
      runs++;
      if (runs === n) {
        hit();
        throw new Error(`injected failure at statement run #${n}`);
      }
      return stmt.run(params);
    },
    get: (params: SqlValue[] = []) => stmt.get(params),
  });
  return {
    exec: (sql) => inner.exec(sql),
    prepare: async (sql) => wrap(await inner.prepare(sql)),
  };
}

export function tableCounts(db: DatabaseSync): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of USER_TABLES) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number };
    out[t] = Number(row.n);
  }
  return out;
}

// ------------------------------------------------------------- sample rows

export function sampleRows(): BackupRows {
  const items: HifzItem[] = [
    {
      id: 'item-1', verseKey: vk('1:1'), sequence: ['1:1'], addedAt: '2026-09-01T09:00:00Z',
      status: 'active', band: 'weak', stability: 0.5,
      // the composite is the WEAKER axis, so this ayah is 0.6 memorised by sound
      // and 0.5 by meaning
      formStability: 0.6, meaningStability: 0.5, strength: 0.625,
      lastReviewedAt: '2026-09-20T09:00:00Z', nextReviewAt: '2026-09-29T09:00:00Z',
      attemptCount: 4, errorCount: 1,
    },
    {
      id: 'item-2', verseKey: vk('1:2'), sequence: ['1:2', '1:3'], addedAt: '2026-09-02T09:00:00Z',
      status: 'paused', band: 'new', stability: 0,
      // never probed for meaning: NULL, not 0
      formStability: 0, meaningStability: null, strength: 0,
      lastReviewedAt: null, nextReviewAt: null, attemptCount: 0, errorCount: 0,
    },
  ];
  const segments: HifzSegment[] = [
    {
      id: 'seg-1', itemId: 'item-1', verseKey: vk('1:1'), position: 0, fromWord: 1, toWord: 3,
      text: 'بِسْمِ ٱللَّهِ',
      meaning: { text: 'in the name of God', lang: 'en', packId: 'word-data', wordGloss: true },
      stability: 0.75, meaningStability: 0.4, errorCount: 0,
    },
    {
      id: 'seg-2', itemId: 'item-1', verseKey: vk('1:1'), position: 1, fromWord: 4, toWord: 5,
      text: 'ٱلرَّحْمَٰنِ ٱلرَّحِيمِ', meaning: null,
      stability: 0.25, meaningStability: null, errorCount: 1,
    },
  ];
  const anchors: AnchorWord[] = [
    { id: 'anchor-1', itemId: 'item-1', verseKey: vk('1:1'), wordPosition: 1, text: 'بِسْمِ', role: 'opening', stability: 0.9 },
  ];
  const transitions: HifzTransition[] = [
    {
      id: 'tr-1', itemId: 'item-1', verseKey: vk('1:1'), kind: 'intra', toVerseKey: null, toWord: 4,
      successCount: 3, failureCount: 1, stability: 0.6, lastPracticedAt: '2026-09-20T09:05:00Z',
    },
    {
      id: 'tr-2', itemId: 'item-2', verseKey: vk('1:2'), kind: 'inter', toVerseKey: '1:3', toWord: 1,
      successCount: 0, failureCount: 0, stability: 0, lastPracticedAt: null,
    },
  ];
  const attempts: RecallAttempt[] = [
    {
      id: 'att-1', itemId: 'item-1', verseKey: '1:1', sessionId: 's-1', mode: 'full-ayah',
      dimension: 'form',
      startedAt: '2026-09-20T09:00:00Z', completedAt: '2026-09-20T09:00:40Z',
      produced: [{ position: 1, text: 'بِسْمِ' }, { position: 2, text: 'ٱللَّهِ' }],
      cue: { kind: 'anchor', text: 'بِسْمِ' },
      expectedWordCount: 5, correctWordCount: 4, accuracy: 0.8,
      errors: [
        {
          kind: 'substitution', expectedPosition: 3, expected: 'ٱلرَّحْمَٰنِ', actual: 'ٱلرحمن',
          confusedWithVerseKey: null, segmentPosition: 1, explanation: 'missing diacritics',
        },
      ],
      durationMs: 40000, selfConfidence: 3, usedAudio: false,
    },
    {
      id: 'att-2', itemId: 'item-1', verseKey: '1:1', sessionId: null, mode: 'segment',
      dimension: 'form',
      startedAt: '2026-09-21T09:00:00Z', completedAt: null,
      produced: [{ position: 1, text: 'بِسْمِ' }], cue: null,
      expectedWordCount: 3, correctWordCount: 3, accuracy: 1,
      errors: [], durationMs: null, selfConfidence: null, usedAudio: true,
    },
    {
      // A meaning drill must survive the round trip as a meaning drill: the
      // dimension is stored, and so is the pack the prompt was read from.
      id: 'att-3', itemId: 'item-1', verseKey: '1:1', sessionId: null, mode: 'meaning-to-arabic',
      dimension: 'meaning',
      startedAt: '2026-09-22T09:00:00Z', completedAt: '2026-09-22T09:00:20Z',
      produced: [{ position: 1, text: 'بِسْمِ' }, { position: 2, text: 'ٱللَّهِ' }, { position: 3, text: 'ٱلرَّحْمَٰنِ' }],
      cue: { kind: 'meaning-gloss', text: 'in the name of God', lang: 'en', packId: 'word-data' },
      expectedWordCount: 3, correctWordCount: 3, accuracy: 1,
      errors: [], durationMs: 20000, selfConfidence: 4, usedAudio: false,
    },
  ];
  const groups: ConfusionGroup[] = [
    {
      id: 'cg-1', label: 'رحمن/رحیم', origin: 'engine', verseKeys: ['1:1', '1:7'],
      createdAt: '2026-09-21T00:00:00Z', lastTriggeredAt: '2026-09-21T09:00:00Z', confusionCount: 2,
    },
  ];
  const sessions: HifzSession[] = [
    {
      id: 's-1', startedAt: '2026-09-20T09:00:00Z', endedAt: '2026-09-20T09:10:00Z', plannedSteps: 2,
      steps: [
        { mode: 'full-ayah', verseKey: '1:1', itemId: 'item-1', attemptId: 'att-1', completedAt: '2026-09-20T09:00:40Z' },
        { mode: 'segment', verseKey: null, itemId: 'item-1', attemptId: null, completedAt: null },
      ],
      report: {
        overallRecall: 0.8, newItemsLearned: 0, reviewsCompleted: 1,
        weakSegments: [{ itemId: 'item-1', verseKey: '1:1', segmentPosition: 1, accuracy: 0.5 }],
        weakTransitions: [{ itemId: 'item-1', verseKey: '1:1', toWord: 4, stability: 0.6 }],
        confusedVerseKeys: ['1:1'],
        repeatedErrors: [{ kind: 'substitution', count: 1 }],
        recommendedNextReviewAt: '2026-09-23T09:00:00Z',
        stabilityChanges: [{ itemId: 'item-1', before: 0.45, after: 0.5 }],
      },
    },
  ];
  const journeys: JourneyRow[] = [
    {
      id: 'j-1', title: 'جوزای اول', description: 'Fatihah + Baqarah start',
      goalVerseKeys: ['1:1', '1:2', '2:1'], startedAt: '2026-09-01T00:00:00Z', completedAt: null,
      progress: [
        { verseKey: '1:1', state: 'done', updatedAt: '2026-09-20T09:00:00Z' },
        { verseKey: '2:1', state: 'in-progress', updatedAt: '2026-09-21T09:00:00Z' },
      ],
    },
  ];
  const reflections: ReflectionRow[] = [
    { id: 'ref-1', verseKey: '1:5', body: 'تأمل در هدایت', writtenAt: '2026-09-22T20:00:00Z' },
  ];
  const plans: DailyPlanRow[] = [
    {
      date: '2026-09-28', generatedAt: '2026-09-28T04:00:00Z',
      newAyahs: ['2:2'], confusionGroups: ['cg-1'], estimatedMinutes: 12,
      reviewItems: [
        {
          itemId: 'item-1', verseKey: '1:1', reason: 'due', priority: 5.5,
          factors: { age: 1.5, lapse: 4 }, suggestedMode: 'segment', dueAt: '2026-09-28T09:00:00Z',
        },
      ],
      weakItems: [],
    },
  ];

  return {
    settings: {
      theme: 'dark',
      interfaceLanguage: 'fa',
      translationPack: 'tr-fa-1',
      readingMode: 'mushaf',
      fontScale: 1.25,
      hifzSessionNewItemTarget: 3,
      hifzAutoAudio: true,
    },
    bookmarks: [
      { id: 'bm-1', verseKey: vk('1:1'), page: 1, label: 'شروع', createdAt: '2026-09-01T08:00:00Z' },
      { id: 'bm-2', verseKey: null, page: 2, label: null, createdAt: '2026-09-02T08:00:00Z' },
    ],
    notes: [
      {
        id: 'note-1', verseKey: vk('1:1'), body: 'Note on al-Fatiha: basmalah counts as verse 1.',
        createdAt: '2026-09-03T08:00:00Z', updatedAt: '2026-09-04T08:00:00Z',
      },
    ],
    readingPositions: [
      { id: 'rp-1', verseKey: vk('2:1'), page: 2, scrollFraction: 0.375, updatedAt: '2026-09-25T08:00:00Z' },
    ],
    readingHistory: [
      { id: 'rh-1', verseKey: vk('112:1'), readAt: '2026-09-26T08:00:00Z', durationMs: 30000 },
      { id: 'rh-2', verseKey: vk('112:2'), readAt: '2026-09-26T08:01:00Z', durationMs: null },
    ],
    hifzItems: items,
    hifzSegments: segments,
    anchorWords: anchors,
    hifzTransitions: transitions,
    recallAttempts: attempts,
    confusionGroups: groups,
    sessions,
    journeys,
    reflections,
    dailyPlans: plans,
  };
}

export function sampleEnvelope(over?: Partial<BackupUserData>): BackupEnvelope {
  const rows = sampleRows();
  return buildEnvelope(over ? { ...rows, ...over } : rows, META).envelope;
}

/** Re-seal after tampering so only the intended defect is reported. */
export function reseal(env: BackupEnvelope): BackupEnvelope {
  return {
    ...env,
    counts: computeCounts(env.data),
    checksum: computeDataChecksum(env.data),
  };
}

// -------------------------------------------------------- DB → rows reader

/**
 * The four `meaning_*` columns as one contract object, or null.
 *
 * Same rule the desktop reader applies: a chunk whose text no licensed pack is
 * named for has no meaning, so it is reported as null rather than as an object
 * with holes.
 */
function readSegmentMeaning(r: Record<string, unknown>): HifzSegment['meaning'] {
  const text = r.meaning_text == null ? null : String(r.meaning_text);
  const lang = r.meaning_lang == null ? null : String(r.meaning_lang);
  const packId = r.meaning_pack == null ? null : String(r.meaning_pack);
  if (!text || text.trim() === '' || !lang || !packId) return null;
  return { text, lang: lang as 'fa' | 'ar' | 'en', packId, wordGloss: Number(r.meaning_word_gloss) === 1 };
}

/**
 * Read every user table back into `BackupUserData` shape. This is the exact
 * code the desktop layer will need for export; it deliberately uses no
 * knowledge from the backup module beyond column mapping.
 */
export function readUserRows(db: DatabaseSync): BackupRows {
  const all = (sql: string, ...params: unknown[]): Array<Record<string, unknown>> =>
    db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  const s = (r: Record<string, unknown>, k: string): string => r[k] as string;
  const num = (r: Record<string, unknown>, k: string): number => Number(r[k]);

  const settings: Record<string, string | number | boolean> = {};
  for (const r of all('SELECT key, value FROM settings ORDER BY key')) {
    const coerced = coerceSetting(String(r.key), r.value);
    if (coerced.ok) settings[String(r.key)] = coerced.value;
  }

  return {
    settings,
    bookmarks: all('SELECT * FROM bookmark ORDER BY id').map((r) => ({
      id: s(r, 'id'),
      verseKey: r.verse_key == null ? null : vk(String(r.verse_key)),
      page: r.page == null ? null : num(r, 'page'),
      label: r.label == null ? null : String(r.label),
      createdAt: s(r, 'created_at'),
    })),
    notes: all('SELECT * FROM note ORDER BY id').map((r) => ({
      id: s(r, 'id'),
      verseKey: vk(String(r.verse_key)),
      body: s(r, 'body'),
      createdAt: s(r, 'created_at'),
      updatedAt: s(r, 'updated_at'),
    })),
    readingPositions: all('SELECT * FROM reading_position ORDER BY id').map((r) => ({
      id: s(r, 'id'),
      verseKey: vk(String(r.verse_key)),
      page: num(r, 'page'),
      scrollFraction: num(r, 'scroll_fraction'),
      updatedAt: s(r, 'updated_at'),
    })),
    readingHistory: all('SELECT * FROM reading_history ORDER BY id').map((r) => ({
      id: s(r, 'id'),
      verseKey: vk(String(r.verse_key)),
      readAt: s(r, 'read_at'),
      durationMs: r.duration_ms == null ? null : num(r, 'duration_ms'),
    })),
    hifzItems: all('SELECT * FROM hifz_item ORDER BY id').map((r) => ({
      id: s(r, 'id'),
      verseKey: vk(String(r.verse_key)),
      sequence: JSON.parse(String(r.sequence)) as string[],
      addedAt: s(r, 'added_at'),
      status: r.status,
      band: r.band,
      stability: num(r, 'stability'),
      formStability: num(r, 'form_stability'),
      meaningStability: r.meaning_stability == null ? null : num(r, 'meaning_stability'),
      strength: num(r, 'strength'),
      lastReviewedAt: r.last_reviewed_at == null ? null : String(r.last_reviewed_at),
      nextReviewAt: r.next_review_at == null ? null : String(r.next_review_at),
      attemptCount: num(r, 'attempt_count'),
      errorCount: num(r, 'error_count'),
    })),
    hifzSegments: all('SELECT * FROM hifz_segment ORDER BY id').map((r) => ({
      id: s(r, 'id'),
      itemId: s(r, 'item_id'),
      verseKey: vk(String(r.verse_key)),
      position: num(r, 'position'),
      fromWord: num(r, 'from_word'),
      toWord: num(r, 'to_word'),
      text: s(r, 'text'),
      meaning: readSegmentMeaning(r),
      stability: num(r, 'stability'),
      meaningStability: r.meaning_stability == null ? null : num(r, 'meaning_stability'),
      errorCount: num(r, 'error_count'),
    })),
    anchorWords: all('SELECT * FROM anchor_word ORDER BY id').map((r) => ({
      id: s(r, 'id'),
      itemId: s(r, 'item_id'),
      verseKey: vk(String(r.verse_key)),
      wordPosition: num(r, 'word_position'),
      text: s(r, 'text'),
      role: r.role,
      stability: num(r, 'stability'),
    })),
    hifzTransitions: all('SELECT * FROM hifz_transition ORDER BY id').map((r) => ({
      id: s(r, 'id'),
      itemId: s(r, 'item_id'),
      verseKey: vk(String(r.verse_key)),
      kind: r.kind,
      toVerseKey: r.to_verse_key == null ? null : String(r.to_verse_key),
      toWord: num(r, 'to_word'),
      successCount: num(r, 'success_count'),
      failureCount: num(r, 'failure_count'),
      stability: num(r, 'stability'),
      lastPracticedAt: r.last_practiced_at == null ? null : String(r.last_practiced_at),
    })),
    recallAttempts: all('SELECT * FROM hifz_attempt ORDER BY id').map((r) => ({
      id: s(r, 'id'),
      itemId: s(r, 'item_id'),
      verseKey: vk(String(r.verse_key)),
      sessionId: r.session_id == null ? null : String(r.session_id),
      mode: r.mode,
      dimension: s(r, 'dimension'),
      startedAt: s(r, 'started_at'),
      completedAt: r.completed_at == null ? null : String(r.completed_at),
      produced: JSON.parse(String(r.produced)),
      cue: r.cue == null ? null : JSON.parse(String(r.cue)),
      expectedWordCount: num(r, 'expected_word_count'),
      correctWordCount: num(r, 'correct_word_count'),
      accuracy: num(r, 'accuracy'),
      errors: JSON.parse(String(r.errors)),
      durationMs: r.duration_ms == null ? null : num(r, 'duration_ms'),
      selfConfidence: r.self_confidence == null ? null : num(r, 'self_confidence'),
      usedAudio: num(r, 'used_audio') === 1,
    })),
    confusionGroups: all('SELECT * FROM confusion_group ORDER BY id').map((r) => {
      const keys = all('SELECT verse_key FROM confusion_group_item WHERE group_id = ? ORDER BY position', r.id as string).map(
        (i) => String(i.verse_key),
      );
      return {
        id: s(r, 'id'),
        label: r.label == null ? null : String(r.label),
        origin: r.origin,
        verseKeys: keys,
        createdAt: s(r, 'created_at'),
        lastTriggeredAt: r.last_triggered_at == null ? null : String(r.last_triggered_at),
        confusionCount: num(r, 'confusion_count'),
      };
    }),
    sessions: all('SELECT * FROM hifz_session ORDER BY id').map((r) => ({
      id: s(r, 'id'),
      startedAt: s(r, 'started_at'),
      endedAt: r.ended_at == null ? null : String(r.ended_at),
      plannedSteps: num(r, 'planned_steps'),
      steps: JSON.parse(String(r.steps)),
      report: r.report == null ? null : JSON.parse(String(r.report)),
    })),
    journeys: all('SELECT * FROM learning_journey ORDER BY id').map((r) => ({
      id: s(r, 'id'),
      title: s(r, 'title'),
      description: r.description == null ? null : String(r.description),
      goalVerseKeys: JSON.parse(String(r.goal_verse_keys)) as string[],
      startedAt: s(r, 'started_at'),
      completedAt: r.completed_at == null ? null : String(r.completed_at),
      progress: all('SELECT * FROM journey_progress WHERE journey_id = ? ORDER BY verse_key', r.id as string).map((p) => ({
        verseKey: String(p.verse_key),
        state: String(p.state),
        updatedAt: String(p.updated_at),
      })),
    })),
    reflections: all('SELECT * FROM reflection ORDER BY id').map((r) => ({
      id: s(r, 'id'),
      verseKey: r.verse_key == null ? null : vk(String(r.verse_key)),
      body: s(r, 'body'),
      writtenAt: s(r, 'written_at'),
    })),
    dailyPlans: all('SELECT date, payload, generated_at FROM daily_plan ORDER BY date').map((r) => ({
      // A file carries the decoded plan plus the timestamp the table keeps in
      // its own column: `payload` alone would lose `generatedAt`, and reading
      // only the payload is how an export silently dropped a field restore had
      // written elsewhere. Merge the columns, as the shipped gateway does.
      ...(JSON.parse(String(r.payload)) as Record<string, unknown>),
      date: String(r.date),
      generatedAt: String(r.generated_at),
    })),
  };
}
