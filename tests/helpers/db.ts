/**
 * Real SQLite for integration tests — no mocks, no in-memory stand-ins for
 * behaviour that only a file exhibits.
 *
 * Driver: `node:sqlite` (built into Node 24, synchronous). Findings that shape
 * this helper, all reproduced on this machine:
 *
 * - `CREATE VIRTUAL TABLE … fts5` works, `MATCH`, `bm25()` and prefix queries
 *   all run, so the FTS5 path of `db.sql` is exercised rather than skipped.
 * - Parameters must be null / number / bigint / string / Uint8Array.
 *   `undefined` and `boolean` throw `ERR_INVALID_ARG_TYPE`, so `toBindable()`
 *   maps `undefined → null` and `boolean → 0|1` here rather than in each test.
 * - `PRAGMA foreign_keys` is per-connection and defaults to OFF; `db.sql` turns
 *   it ON as its first statement. Any second connection to the same file has to
 *   set it again, which is what `openExisting()` does.
 * - Integers outside the safe double range throw on read:
 *   `RangeError: Value is too large to be represented as a JavaScript number`
 *   (`ERR_OUT_OF_RANGE`). Real mushaf data never reaches that, but a bad
 *   `source_id` would, so the readers here `Number()` only what they verified.
 * - `TEXT` into an `INTEGER PRIMARY KEY` (the `ayah_word.id` case) fails with
 *   `datatype mismatch` — word ids are counters, not uuid strings.
 * - `undefined` and booleans are not bindable (`ERR_INVALID_ARG_TYPE`);
 *   `bigint` is.
 * - Double quotes are identifiers, and Node says so helpfully:
 *   `no such column: "x" - should this be a string literal in single-quotes?`
 * - `SELECT 1/0` is not an error, it is `NULL`. A division that silently
 *   produces NULL (an empty attempt set, say) must be guarded in SQL, not by
 *   hoping for a throw.
 * - `run()` gives `{ changes, lastInsertRowid }` as JS numbers when they fit.
 * - FTS5: a `MATCH` string is a query language, not text. `'98:1'` is parsed as
 *   the column filter `98 : 1` and throws `no such column: 98`, so a verse key
 *   can only be looked up through the UNINDEXED column with SQL, never MATCH.
 * - The module is experimental: `node --warnings` prints
 *   `ExperimentalWarning: SQLite is an experimental feature`.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AnchorWord,
  ConfusionGroup,
  DetectedError,
  HifzItem,
  HifzSegment,
  HifzTransition,
  RecallAttempt,
  RecitedWord,
} from '../../core/src/contracts/hifz';
import type { Ayah, AyahWord, Surah, Translation, VerseKey } from '../../core/src/contracts/quran';
import { normalizeWord } from '../../core/src/normalize/arabic';
import { nextId, resetIds } from './ids';
import { EPOCH_ISO } from './clock';
import {
  buildSurahsFor,
  fixtureAyahRecords,
  fixtureChapters,
  fixtureTranslations,
  buildWordRows,
  tafsirForChapter,
  translationPackOf,
  TAFSIR_PACKS,
  TRANSLATION_PACKS,
} from './corpus';
import { readSchemaSql } from './repo';

/** Derived content data — dropped and rebuilt on a pack reimport. */
export const CONTENT_TABLES = [
  'content_pack',
  'surah',
  'ayah',
  'ayah_word',
  'translation',
  'tafsir',
  'similar_ayah',
  'ayah_relation',
  'concept',
  'concept_ayah',
  'concept_relation',
  'audio_track',
] as const;

/** The only tables a backup may contain (docs/data-model.md). */
export const USER_TABLES = [
  'user_profile',
  'settings',
  'bookmark',
  'note',
  'reading_position',
  'reading_history',
  'hifz_item',
  'hifz_segment',
  'anchor_word',
  'hifz_transition',
  'hifz_attempt',
  'confusion_group',
  'confusion_group_item',
  'hifz_session',
  'learning_journey',
  'journey_progress',
  'daily_plan',
  'reflection',
] as const;

/** Index/metadata objects that must exist once `db.sql` has run. */
export const EXPECTED_INDEXES = [
  'ayah_order_idx',
  'ayah_page_idx',
  'ayah_juz_idx',
  'ayah_hizb_idx',
  'hifz_due_idx',
  'attempt_item_idx',
  'sqlite_autoindex_translation_1',
  'sqlite_autoindex_tafsir_1',
  'sqlite_autoindex_similar_ayah_1',
  'sqlite_autoindex_ayah_relation_1',
  'sqlite_autoindex_hifz_segment_1',
  'sqlite_autoindex_anchor_word_1',
  'sqlite_autoindex_hifz_transition_1',
  'sqlite_autoindex_confusion_group_item_1',
  'sqlite_autoindex_journey_progress_1',
  'sqlite_autoindex_concept_ayah_1',
  'sqlite_autoindex_concept_relation_1',
] as const;

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface TestHandle {
  readonly db: DatabaseSync;
  /** Absolute path of the temp database file (not `:memory:`). */
  readonly path: string;
  readonly dir: string;
  exec(sql: string): void;
  run(sql: string, params?: readonly unknown[]): { changes: number; lastInsertRowid: number };
  get<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T[];
  count(table: string, where?: string, params?: readonly unknown[]): number;
  /** Row count of every table in the file, for "the DB is untouched" proofs. */
  rowCounts(): Record<string, number>;
  tables(): string[];
  indexes(): string[];
  /** One column definition list, e.g. to assert a CHECK survived. */
  sqlOf(name: string): string | undefined;
  tx<T>(fn: () => T): T;
  close(): void;
  /** Close and delete the temp file + directory. Idempotent. */
  dispose(): void;
}

export interface CreateOptions {
  /** Default: the authoritative `core/src/contracts/db.sql`. */
  schemaSql?: string | null;
  /** Default: `<schema_version key, value 1>`. Pass `{}` to write none. */
  meta?: Record<string, string> | null;
  name?: string;
  /** Default true; `false` proves what a missing PRAGMA does to integrity. */
  enforceForeignKeys?: boolean;
}

const META_SCHEMA_VERSION_KEY = 'schema_version';

/** Create a fresh temp file database and run the schema into it. */
export function createTempDb(options: CreateOptions = {}): TestHandle {
  const dir = mkdtempSync(join(tmpdir(), 'quran-it-'));
  const path = join(dir, `${options.name ?? 'test'}.sqlite`);
  const handle = attach(path, dir);
  const schema = options.schemaSql === null ? '' : (options.schemaSql ?? readSchemaSql());
  if (schema) handle.exec(schema);
  if (options.enforceForeignKeys === false) handle.exec('PRAGMA foreign_keys = OFF');
  if (options.meta !== null) {
    const meta = options.meta ?? { [META_SCHEMA_VERSION_KEY]: '1' };
    const stmt = handle.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(meta)) stmt.run(key, value);
  }
  return handle;
}

/** Open an existing file the way the app must: FKs on, schema already present. */
export function openExisting(path: string, dir = join(path, '..')): TestHandle {
  const handle = attach(path, dir);
  handle.exec('PRAGMA foreign_keys = ON');
  return handle;
}

function attach(path: string, dir: string): TestHandle {
  const db = new DatabaseSync(path);
  let txDepth = 0;
  let disposed = false;

  const handle: TestHandle = {
    db,
    path,
    dir,
    exec: (sql) => db.exec(sql),
    run: (sql, params = []) => {
      const stmt = db.prepare(sql);
      const res = stmt.run(...toBindList(params));
      return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) };
    },
    get: <T,>(sql: string, params: readonly unknown[] = []) =>
      db.prepare(sql).get(...toBindList(params)) as T | undefined,
    all: <T,>(sql: string, params: readonly unknown[] = []) =>
      db.prepare(sql).all(...toBindList(params)) as T[],
    count: (table, where, params = []) => {
      const sql = `SELECT COUNT(*) AS n FROM ${quoteIdent(table)}${where ? ` WHERE ${where}` : ''}`;
      return Number(db.prepare(sql).get(...toBindList(params))?.['n'] ?? 0);
    },
    rowCounts: () => {
      const names = handle
        .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .map((r) => r.name)
        // FTS5 shadow tables are part of the index, not separate data.
        .filter((n) => !/_content$|_docsize$|_idx$|_data$|_config$/.test(n));
      const out: Record<string, number> = {};
      for (const name of names) out[name] = handle.count(name);
      return out;
    },
    tables: () =>
      handle
        .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .map((r) => r.name),
    indexes: () =>
      handle
        .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
        .map((r) => r.name),
    sqlOf: (name) => handle.get<{ sql: string }>('SELECT sql FROM sqlite_master WHERE name = ?', [name])?.sql,
    tx: <T,>(fn: () => T): T => {
      // node:sqlite has no transaction helper; savepoints keep nesting honest.
      if (txDepth === 0) db.exec('BEGIN');
      else db.exec(`SAVEPOINT sp${txDepth}`);
      txDepth += 1;
      try {
        const result = fn();
        txDepth -= 1;
        if (txDepth === 0) db.exec('COMMIT');
        else db.exec(`RELEASE sp${txDepth}`);
        return result;
      } catch (error) {
        txDepth -= 1;
        if (txDepth === 0) db.exec('ROLLBACK');
        else db.exec(`ROLLBACK TO sp${txDepth}`);
        throw error;
      }
    },
    close: () => {
      if (!disposed) db.close();
      disposed = true;
    },
    dispose: () => {
      handle.close();
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
      } catch {
        // A locked temp dir is not a test failure; the OS reclaims %TEMP%.
      }
    },
  };
  return handle;
}

/* ------------------------------------------------------------------ bind rules */

/** node:sqlite refuses `undefined` and `boolean`; map them the DB understands. */
export function toBindable(value: unknown): SqlValue {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') return value;
  if (value instanceof Uint8Array) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) return JSON.stringify(value);
  throw new TypeError(`toBindable: cannot bind ${typeof value}`);
}

export function toBindList(params: readonly unknown[]): SqlValue[] {
  return params.map(toBindable);
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new TypeError(`quoteIdent: unsafe identifier ${name}`);
  return name;
}

/** True when a thrown error is the CHECK constraint the test expects. */
export function isCheckFailure(error: unknown, constraintText: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /CHECK constraint failed/i.test(message) && message.includes(constraintText);
}

export function isForeignKeyFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /FOREIGN KEY constraint failed/i.test(message);
}

export function isUniqueFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed/i.test(message);
}

/* -------------------------------------------------------------------- inserters */

export function insertSurah(h: TestHandle, s: Surah): void {
  h.run(
    `INSERT INTO surah (number, name_arabic, name_simple, name_transliterated, translation_fa,
        translation_en, revelation_place, revelation_order, ayah_count, pages_from, pages_to,
        first_verse_key, last_verse_key, bismillah_pre)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      s.number,
      s.nameArabic,
      s.nameSimple,
      s.nameTransliterated,
      s.translationFa,
      s.translationEn,
      s.revelationPlace,
      s.revelationOrder,
      s.ayahCount,
      s.pagesFrom,
      s.pagesTo,
      s.firstVerseKey,
      s.lastVerseKey,
      s.bismillahPre,
    ],
  );
}

export function insertAyah(h: TestHandle, a: Ayah): void {
  h.run(
    `INSERT INTO ayah (verse_key, chapter, verse, source_id, juz, hizb, rub_el_hizb, sajda, ruku,
        manzil, page, text_uthmani, text_uthmani_simple, word_count, normalized_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      a.verseKey,
      a.chapter,
      a.verse,
      a.sourceId,
      a.juz,
      a.hizb,
      a.rubElHizb,
      a.sajda,
      a.ruku,
      a.manzil,
      a.page,
      a.textUthmani,
      a.textUthmaniSimple,
      a.wordCount,
      a.normalizedHash,
    ],
  );
}

export function insertAyahWord(h: TestHandle, w: AyahWord): void {
  h.run(
    `INSERT INTO ayah_word (id, verse_key, position, page_number, line_number, text_uthmani,
        translation_en, transliteration, root, morphology, is_end_of_ayah_mark, normalized)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      w.id,
      w.verseKey,
      w.position,
      w.pageNumber,
      w.lineNumber,
      w.textUthmani,
      w.translationEn,
      w.transliteration,
      w.root,
      w.morphology,
      w.isEndOfAyahMark,
      normalizeWord(w.textUthmani),
    ],
  );
}

export function insertTranslation(h: TestHandle, t: Translation): void {
  h.run('INSERT INTO translation (verse_key, pack_id, text) VALUES (?,?,?)', [t.verseKey, t.packId, t.text]);
}

export function insertTafsir(
  h: TestHandle,
  verseKey: VerseKey,
  packId: string,
  text: string,
  covers: VerseKey[] = [verseKey],
): void {
  h.run('INSERT INTO tafsir (verse_key, pack_id, text, covers_verse_keys) VALUES (?,?,?,?)', [
    verseKey,
    packId,
    text,
    JSON.stringify(covers),
  ]);
}

export function insertContentPack(
  h: TestHandle,
  row: {
    id: string;
    kind: string;
    version: string;
    schemaVersion?: number;
    language: string;
    title: string;
    source: string;
    licenseName: string;
    licenseSpdx?: string | null;
    licenseStatus: string;
    licenseNotes?: string;
    attribution: string;
    checksum: string;
    payloadBytes: number;
    recordCount: number;
    importedAt?: string;
  },
): void {
  h.run(
    `INSERT INTO content_pack (id, kind, version, schema_version, language, title, source,
        license_name, license_spdx, license_status, license_notes, attribution, checksum,
        payload_bytes, record_count, imported_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      row.id,
      row.kind,
      row.version,
      row.schemaVersion ?? 1,
      row.language,
      row.title,
      row.source,
      row.licenseName,
      row.licenseSpdx ?? null,
      row.licenseStatus,
      row.licenseNotes ?? '',
      row.attribution,
      row.checksum,
      row.payloadBytes,
      row.recordCount,
      row.importedAt ?? EPOCH_ISO,
    ],
  );
}

export function insertMeta(h: TestHandle, key: string, value: string): void {
  h.run('INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
    key,
    value,
  ]);
}

export function readMeta(h: TestHandle, key: string): string | undefined {
  return h.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key])?.value;
}

export interface HifzItemSeed extends Partial<Omit<HifzItem, 'id'>> {
  id?: string;
}

export function insertHifzItem(h: TestHandle, seed: HifzItemSeed): string {
  const item: Required<
    Pick<HifzItem, 'id' | 'verseKey' | 'sequence' | 'addedAt' | 'status' | 'band'>
  > & { stability: number; strength: number; lastReviewedAt: string | null; nextReviewAt: string | null; attemptCount: number; errorCount: number } = {
    id: seed.id ?? nextId('hifz-item'),
    verseKey: seed.verseKey ?? '1:1',
    sequence: seed.sequence ?? [seed.verseKey ?? '1:1'],
    addedAt: seed.addedAt ?? EPOCH_ISO,
    status: seed.status ?? 'active',
    band: seed.band ?? 'new',
    stability: seed.stability ?? 0,
    strength: seed.strength ?? 0,
    lastReviewedAt: seed.lastReviewedAt ?? null,
    nextReviewAt: seed.nextReviewAt ?? null,
    attemptCount: seed.attemptCount ?? 0,
    errorCount: seed.errorCount ?? 0,
  };
  h.run(
    `INSERT INTO hifz_item (id, verse_key, sequence, added_at, status, band, stability, strength,
        last_reviewed_at, next_review_at, attempt_count, error_count)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      item.id,
      item.verseKey,
      JSON.stringify(item.sequence),
      item.addedAt,
      item.status,
      item.band,
      item.stability,
      item.strength,
      item.lastReviewedAt,
      item.nextReviewAt,
      item.attemptCount,
      item.errorCount,
    ],
  );
  return item.id;
}

export function insertHifzSegment(h: TestHandle, seed: Partial<HifzSegment> & { itemId: string; position: number; fromWord: number; toWord: number; text: string }): string {
  const id = seed.id ?? nextId('hifz-segment');
  h.run(
    `INSERT INTO hifz_segment (id, item_id, position, from_word, to_word, text, meaning_fa,
        meaning_source, stability, error_count)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      seed.itemId,
      seed.position,
      seed.fromWord,
      seed.toWord,
      seed.text,
      seed.meaningFa ?? null,
      seed.meaningSource ?? null,
      seed.stability ?? 0,
      seed.errorCount ?? 0,
    ],
  );
  return id;
}

export function insertAnchorWord(h: TestHandle, seed: Partial<AnchorWord> & { itemId: string; wordPosition: number; text: string; role: AnchorWord['role'] }): string {
  const id = seed.id ?? nextId('anchor');
  h.run(
    'INSERT INTO anchor_word (id, item_id, word_position, text, role, stability) VALUES (?,?,?,?,?,?)',
    [id, seed.itemId, seed.wordPosition, seed.text, seed.role, seed.stability ?? 0],
  );
  return id;
}

export function insertHifzTransition(h: TestHandle, seed: Partial<HifzTransition> & { itemId: string; kind: HifzTransition['kind']; toWord: number }): string {
  const id = seed.id ?? nextId('transition');
  h.run(
    `INSERT INTO hifz_transition (id, item_id, kind, to_verse_key, to_word, success_count,
        failure_count, stability, last_practiced_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      id,
      seed.itemId,
      seed.kind,
      seed.toVerseKey ?? null,
      seed.toWord,
      seed.successCount ?? 0,
      seed.failureCount ?? 0,
      seed.stability ?? 0,
      seed.lastPracticedAt ?? null,
    ],
  );
  return id;
}

export function insertHifzAttempt(
  h: TestHandle,
  seed: Partial<RecallAttempt> & {
    itemId: string;
    verseKey: string;
    mode: RecallAttempt['mode'];
    startedAt: string;
    accuracy: number;
    expectedWordCount: number;
    correctWordCount: number;
  },
): string {
  const id = seed.id ?? nextId('attempt');
  h.run(
    `INSERT INTO hifz_attempt (id, item_id, verse_key, session_id, mode, started_at, completed_at,
        produced, cue, expected_word_count, correct_word_count, accuracy, errors, duration_ms,
        self_confidence, used_audio)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      seed.itemId,
      seed.verseKey,
      seed.sessionId ?? null,
      seed.mode,
      seed.startedAt,
      seed.completedAt ?? null,
      JSON.stringify(seed.produced ?? []),
      seed.cue ? JSON.stringify(seed.cue) : null,
      seed.expectedWordCount,
      seed.correctWordCount,
      seed.accuracy,
      JSON.stringify(seed.errors ?? []),
      seed.durationMs ?? null,
      seed.selfConfidence ?? null,
      seed.usedAudio ?? false,
    ],
  );
  return id;
}

/**
 * Attempt rows as the schema actually stores them.
 *
 * The recited text is *derived here, not duplicated in the table*: `produced`
 * is the only stored record of what the learner said, and `recitation` is its
 * joined form. An earlier revision of this helper asked the contract for four
 * extra columns (`recitation`, `content_hash`, `omission_side`, `snapshot_id`)
 * which the schema does not have and the app does not write; keeping them would
 * have meant the test database and the shipped database were different
 * databases. A journey test that needs "the wrong recitation is still there"
 * reads it from `produced`, which is what the memory engine reads too.
 */
export function readAttemptRows(
  h: TestHandle,
  itemId?: string,
): Array<{
  id: string;
  itemId: string;
  verseKey: string;
  mode: string;
  startedAt: string;
  completedAt: string | null;
  recitation: string;
  accuracy: number;
  correctWordCount: number;
  expectedWordCount: number;
  errorsJson: string;
}> {
  return h
    .all<Record<string, unknown>>(
      `SELECT id, item_id, verse_key, mode, started_at, completed_at, produced,
          accuracy, correct_word_count, expected_word_count, errors
       FROM hifz_attempt ${itemId ? 'WHERE item_id = ?' : ''} ORDER BY started_at, rowid`,
      itemId ? [itemId] : [],
    )
    .map((r) => ({
      id: String(r['id']),
      itemId: String(r['item_id']),
      verseKey: String(r['verse_key']),
      mode: String(r['mode']),
      startedAt: String(r['started_at']),
      completedAt: r['completed_at'] == null ? null : String(r['completed_at']),
      recitation: (JSON.parse(String(r['produced'])) as Array<{ text: string }>)
        .map((w) => w.text)
        .join(' '),
      accuracy: Number(r['accuracy']),
      correctWordCount: Number(r['correct_word_count']),
      expectedWordCount: Number(r['expected_word_count']),
      errorsJson: String(r['errors'] ?? '[]'),
    }));
}

/** 32 hex chars of sha256 — the width every `*_hash` column in db.sql uses. */
export function sha256Hex32(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}

export function insertConfusionGroup(
  h: TestHandle,
  seed: { id?: string; label?: string | null; origin: ConfusionGroup['origin']; createdAt: string; verseKeys: VerseKey[]; lastTriggeredAt?: string | null; confusionCount?: number },
): string {
  const id = seed.id ?? nextId('confusion-group');
  h.run(
    'INSERT INTO confusion_group (id, label, origin, created_at, last_triggered_at, confusion_count) VALUES (?,?,?,?,?,?)',
    [id, seed.label ?? null, seed.origin, seed.createdAt, seed.lastTriggeredAt ?? null, seed.confusionCount ?? 0],
  );
  seed.verseKeys.forEach((verseKey, position) => {
    h.run('INSERT INTO confusion_group_item (group_id, verse_key, position) VALUES (?,?,?)', [id, verseKey, position]);
  });
  return id;
}

export function insertBookmark(h: TestHandle, seed: { verseKey: VerseKey; page?: number | null; label?: string | null; createdAt: string; id?: string }): string {
  const id = seed.id ?? nextId('bookmark');
  h.run('INSERT INTO bookmark (id, verse_key, page, label, created_at) VALUES (?,?,?,?,?)', [
    id,
    seed.verseKey,
    seed.page ?? null,
    seed.label ?? null,
    seed.createdAt,
  ]);
  return id;
}

export function insertNote(h: TestHandle, seed: { verseKey: VerseKey; body: string; createdAt: string; updatedAt?: string; id?: string }): string {
  const id = seed.id ?? nextId('note');
  h.run('INSERT INTO note (id, verse_key, body, created_at, updated_at) VALUES (?,?,?,?,?)', [
    id,
    seed.verseKey,
    seed.body,
    seed.createdAt,
    seed.updatedAt ?? seed.createdAt,
  ]);
  return id;
}

export function insertReadingPosition(h: TestHandle, seed: { verseKey: VerseKey; page: number; scrollFraction?: number; updatedAt: string; id?: string }): string {
  const id = seed.id ?? nextId('reading-position');
  h.run(
    'INSERT INTO reading_position (id, verse_key, page, scroll_fraction, updated_at) VALUES (?,?,?,?,?)',
    [id, seed.verseKey, seed.page, seed.scrollFraction ?? 0, seed.updatedAt],
  );
  return id;
}

export function insertUserProfile(h: TestHandle, displayName: string, createdAt = EPOCH_ISO, preferredLanguage = 'fa'): void {
  h.run('INSERT INTO user_profile (id, display_name, preferred_language, created_at) VALUES (1,?,?,?)', [
    displayName,
    preferredLanguage,
    createdAt,
  ]);
}

export function insertSetting(h: TestHandle, key: string, value: string, updatedAt = EPOCH_ISO): void {
  h.run('INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)', [key, value, updatedAt]);
}

/* ----------------------------------------------------------------- content seed */

/**
 * A SQLite database holding the real fixture corpus: the 114-chapter metadata
 * limited to the fixture's chapters, the 31 authoritative ayahs, their
 * word-by-word rows, both bundled translations, one tafsir chapter and the
 * `content_pack` manifests they belong to.
 */
const DEFAULT_TRANSLATION_RESOURCE_IDS = [85, 135] as const;

export function createFixtureDb(
  options: { seedHifz?: boolean; idSeed?: string; translationResourceIds?: readonly number[] } = {},
): TestHandle {
  resetIds(options.idSeed ?? 'quran-fixture');
  const h = createTempDb();
  seedFixtureContent(h, options.translationResourceIds ?? DEFAULT_TRANSLATION_RESOURCE_IDS);
  if (options.seedHifz !== false) seedSyntheticHifz(h);
  return h;
}

export function seedFixtureContent(
  h: TestHandle,
  resourceIds: readonly number[] = DEFAULT_TRANSLATION_RESOURCE_IDS,
): { ayahs: Ayah[]; surahs: Surah[] } {
  const chapters = fixtureChapters();
  const surahs = buildSurahsFor(chapters);
  const ayahs = fixtureAyahRecords();

  h.tx(() => {
    // One row per translation pack actually loaded, so `translation.pack_id`
    // always has a parent and the recorded `record_count` is true rather than
    // a constant that happens to look plausible.
    for (const resourceId of resourceIds) {
      const pack = translationPackOf(resourceId);
      insertContentPack(h, {
        id: pack.packId,
        kind: 'translation',
        version: '1.0.0',
        language: pack.language,
        title: pack.title,
        source: 'quran.com api v4',
        licenseName: `${pack.title} — attribution required`,
        licenseStatus: 'attribution-required',
        licenseNotes: `translation pack QA fixture (resource ${resourceId})`,
        attribution: pack.title,
        checksum: '0'.repeat(64),
        payloadBytes: 0,
        recordCount: 0,
      });
    }
    insertContentPack(h, {
      id: TAFSIR_PACKS[16].packId,
      kind: 'tafsir',
      version: '1.0.0',
      language: TAFSIR_PACKS[16].language,
      title: TAFSIR_PACKS[16].title,
      source: 'quran.com api v4',
      licenseName: 'Tafsir Muyassar',
      licenseStatus: 'attribution-required',
      licenseNotes: 'tafsir pack QA fixture',
      attribution: 'King Fahd Complex, via quran.com',
      checksum: '0'.repeat(64),
      payloadBytes: 0,
      recordCount: 0,
    });

    for (const s of surahs) insertSurah(h, s);
    for (const a of ayahs) insertAyah(h, a);

    let wordId = 0;
    for (const chapter of chapters) {
      for (const w of buildWordRows(chapter)) {
        const ayah = ayahs.find((a) => a.verseKey === w.verseKey);
        if (!ayah || w.textUthmani.length === 0) continue;
        wordId += 1;
        insertAyahWord(h, {
          id: wordId,
          verseKey: w.verseKey,
          position: w.position,
          pageNumber: w.pageNumber,
          lineNumber: w.lineNumber,
          textUthmani: w.textUthmani,
          translationEn: w.translationEn,
          transliteration: w.transliteration,
          root: null,
          morphology: null,
          isEndOfAyahMark: w.isEndOfAyahMark,
        } satisfies AyahWord);
      }
    }

    for (const resourceId of resourceIds) {
      for (const t of fixtureTranslations(resourceId as 85 | 135)) insertTranslation(h, t);
    }
    for (const resourceId of resourceIds) {
      const pack = translationPackOf(resourceId);
      h.run('UPDATE content_pack SET record_count = (SELECT COUNT(*) FROM translation WHERE pack_id = ?) WHERE id = ?', [
        pack.packId,
        pack.packId,
      ]);
    }

    let tafsirRows = 0;
    for (const chapter of chapters) {
      for (const passage of tafsirForChapter(16, chapter)) {
        const ayah = ayahs.find((a) => a.verseKey === passage.verseKey);
        if (!ayah) continue;
        insertTafsir(h, passage.verseKey, TAFSIR_PACKS[16].packId, passage.text);
        tafsirRows += 1;
      }
    }
    h.run('UPDATE content_pack SET record_count = (SELECT COUNT(*) FROM tafsir WHERE pack_id = ?) WHERE id = ?', [
      TAFSIR_PACKS[16].packId,
      TAFSIR_PACKS[16].packId,
    ]);
  });

  return { ayahs, surahs };
}

/**
 * Synthetic-but-consistent hifz + user state, so persistence behaviour
 * (cascades, composite keys, due-index ordering) can be asserted without
 * waiting for the app's repositories. Text always comes from the fixture.
 *
 * Shape: an active weak item on the ar-Rahman refrain 55:13 with segments,
 * anchors, transitions and three attempts (last one deliberately wrong), a
 * dropped item, a user confusion group over the refrain ayahs, plus a
 * bookmark, a note, a reading position, settings and a profile.
 */
export function seedSyntheticHifz(h: TestHandle, at: string = EPOCH_ISO): { itemId: string; droppedItemId: string; groupId: string } {
  const refrain = h.get<{ verse_key: string; text_uthmani: string }>(
    "SELECT verse_key, text_uthmani FROM ayah WHERE verse_key LIKE '55:%' ORDER BY verse_key LIMIT 1",
  );
  const verseKey = (refrain?.verse_key ?? '1:1') as VerseKey;
  const text = refrain?.text_uthmani ?? 'بِسْمِ ٱللَّهِ ٱلرَّحْمَـٰنِ ٱلرَّحِيمِ';
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);

  const itemId = insertHifzItem(h, {
    verseKey,
    sequence: [verseKey],
    addedAt: at,
    status: 'active',
    band: 'weak',
    stability: 0.42,
    strength: 0.6,
    lastReviewedAt: at,
    nextReviewAt: at,
    attemptCount: 3,
    errorCount: 1,
  });

  // Two segments tiling the ayah, no word covered twice.
  const half = Math.max(1, Math.floor(tokens.length / 2));
  insertHifzSegment(h, { itemId, position: 0, fromWord: 1, toWord: half, text: tokens.slice(0, half).join(' ') });
  insertHifzSegment(h, {
    itemId,
    position: 1,
    fromWord: half + 1,
    toWord: tokens.length,
    text: tokens.slice(half).join(' '),
    stability: 0.3,
    errorCount: 1,
  });
  insertAnchorWord(h, { itemId, wordPosition: 1, text: tokens[0] ?? '', role: 'opening' });
  insertAnchorWord(h, { itemId, wordPosition: tokens.length, text: tokens[tokens.length - 1] ?? '', role: 'ending' });
  if (tokens.length > 1) {
    insertAnchorWord(h, { itemId, wordPosition: half + 1, text: tokens[half] ?? '', role: 'boundary' });
    insertHifzTransition(h, { itemId, kind: 'intra', toWord: half + 1, successCount: 1, failureCount: 1, stability: 0.35, lastPracticedAt: at });
  }

  const produced: RecitedWord[] = tokens.map((t, i) => ({ position: i + 1, text: t }));
  insertHifzAttempt(h, {
    itemId,
    verseKey,
    mode: 'full-ayah',
    startedAt: at,
    completedAt: at,
    produced,
    cue: null,
    expectedWordCount: tokens.length,
    correctWordCount: tokens.length,
    accuracy: 1,
    errors: [],
    durationMs: 9_000,
    selfConfidence: 4,
    usedAudio: false,
  });
  insertHifzAttempt(h, {
    itemId,
    verseKey,
    mode: 'opening',
    startedAt: at,
    completedAt: at,
    produced: produced.slice(0, Math.min(2, produced.length)),
    cue: { kind: 'anchor', text: tokens[0] ?? '' },
    expectedWordCount: Math.min(2, produced.length),
    correctWordCount: Math.min(2, produced.length),
    accuracy: 1,
    errors: [],
    durationMs: 4_000,
    selfConfidence: 3,
    usedAudio: false,
  });
  // The recorded failure: one substituted word, band left 'weak' on purpose.
  const wrong: RecitedWord[] = tokens.map((t, i) => ({ position: i + 1, text: i === 1 ? 'كَذِبًا' : t }));
  const errors: DetectedError[] = [
    {
      kind: 'substitution',
      expectedPosition: 2,
      expected: tokens[1] ?? null,
      actual: 'كَذِبًا',
      confusedWithVerseKey: null,
      segmentPosition: 0,
      explanation: 'QA seed: second word substituted',
    },
  ];
  insertHifzAttempt(h, {
    itemId,
    verseKey,
    mode: 'full-ayah',
    startedAt: at,
    completedAt: at,
    produced: wrong,
    cue: null,
    expectedWordCount: tokens.length,
    correctWordCount: Math.max(0, tokens.length - 1),
    accuracy: Math.max(0, (tokens.length - 1) / tokens.length),
    errors,
    durationMs: 11_000,
    selfConfidence: 2,
    usedAudio: true,
  });

  const droppedItemId = insertHifzItem(h, {
    verseKey: '1:1',
    sequence: ['1:1'],
    addedAt: at,
    status: 'dropped',
    band: 'new',
  });

  const refrainKeys = h
    .all<{ verse_key: string }>(
      `SELECT verse_key FROM (SELECT verse_key, normalized_hash FROM ayah WHERE verse_key LIKE '55:%') ORDER BY verse_key LIMIT 2`,
    )
    .map((r) => r.verse_key as VerseKey);
  const groupId = insertConfusionGroup(h, {
    label: 'ar-Rahman refrain cluster',
    origin: 'user',
    createdAt: at,
    verseKeys: refrainKeys.length >= 2 ? refrainKeys : ['55:13', '55:77'].map((k) => k as VerseKey),
    confusionCount: 2,
  });

  insertBookmark(h, { verseKey: '1:1', page: 1, label: 'الفاتحة', createdAt: at });
  insertNote(h, { verseKey: '1:1', body: 'ملاحظة اختبار — QA note, not shipped content', createdAt: at });
  insertReadingPosition(h, { verseKey: '1:1', page: 1, scrollFraction: 0.25, updatedAt: at });
  insertUserProfile(h, 'QA Harness');
  insertSetting(h, 'theme', 'dark', at);

  return { itemId, droppedItemId, groupId };
}

/* --------------------------------------------------------------------- readers */

/** Ayah rows read back from disk in canonical order, as contract objects. */
export function readAyahs(h: TestHandle, where?: { sql: string; params?: readonly unknown[] }): Ayah[] {
  const sql = `SELECT * FROM ayah${where ? ` WHERE ${where.sql}` : ''} ORDER BY chapter, verse`;
  return h.all<Record<string, unknown>>(sql, where?.params ?? []).map(rowToAyah);
}

export function readSurahs(h: TestHandle): Surah[] {
  return h.all<Record<string, unknown>>('SELECT * FROM surah ORDER BY number').map(rowToSurah);
}

export function readHifzItems(h: TestHandle): HifzItem[] {
  return h
    .all<Record<string, unknown>>('SELECT * FROM hifz_item ORDER BY id')
    .map((r) => rowToHifzItem(r));
}

export function readHifzItem(h: TestHandle, id: string): HifzItem | undefined {
  const r = h.get<Record<string, unknown>>('SELECT * FROM hifz_item WHERE id = ?', [id]);
  return r ? rowToHifzItem(r) : undefined;
}

export function readHifzSegments(h: TestHandle, itemId?: string): HifzSegment[] {
  const rows = itemId
    ? h.all<Record<string, unknown>>('SELECT * FROM hifz_segment WHERE item_id = ? ORDER BY position', [itemId])
    : h.all<Record<string, unknown>>('SELECT * FROM hifz_segment ORDER BY item_id, position');
  return rows.map((r) => ({
    id: String(r['id']),
    itemId: String(r['item_id']),
    position: Number(r['position']),
    fromWord: Number(r['from_word']),
    toWord: Number(r['to_word']),
    text: String(r['text']),
    meaningFa: (r['meaning_fa'] as string | null) ?? null,
    meaningSource: (r['meaning_source'] as string | null) ?? null,
    stability: Number(r['stability']),
    errorCount: Number(r['error_count']),
  }));
}

export function readAnchorWords(h: TestHandle, itemId?: string): AnchorWord[] {
  const rows = itemId
    ? h.all<Record<string, unknown>>('SELECT * FROM anchor_word WHERE item_id = ? ORDER BY word_position, role', [itemId])
    : h.all<Record<string, unknown>>('SELECT * FROM anchor_word ORDER BY item_id, word_position');
  return rows.map((r) => ({
    id: String(r['id']),
    itemId: String(r['item_id']),
    wordPosition: Number(r['word_position']),
    text: String(r['text']),
    role: String(r['role']) as AnchorWord['role'],
    stability: Number(r['stability']),
  }));
}

export function readHifzTransitions(h: TestHandle, itemId?: string): HifzTransition[] {
  const rows = itemId
    ? h.all<Record<string, unknown>>('SELECT * FROM hifz_transition WHERE item_id = ? ORDER BY kind, to_word', [itemId])
    : h.all<Record<string, unknown>>('SELECT * FROM hifz_transition ORDER BY item_id, kind, to_word');
  return rows.map((r) => ({
    id: String(r['id']),
    itemId: String(r['item_id']),
    kind: String(r['kind']) as HifzTransition['kind'],
    toVerseKey: (r['to_verse_key'] as string | null) ?? null,
    toWord: Number(r['to_word']),
    successCount: Number(r['success_count']),
    failureCount: Number(r['failure_count']),
    stability: Number(r['stability']),
    lastPracticedAt: (r['last_practiced_at'] as string | null) ?? null,
  }));
}

export function readHifzAttempts(h: TestHandle, itemId?: string): RecallAttempt[] {
  const rows = itemId
    ? h.all<Record<string, unknown>>(
        `SELECT * FROM hifz_attempt WHERE item_id = ? ORDER BY started_at, id`,
        [itemId],
      )
    : h.all<Record<string, unknown>>('SELECT * FROM hifz_attempt ORDER BY started_at, id');
  return rows.map((r) => ({
    id: String(r['id']),
    itemId: String(r['item_id']),
    verseKey: String(r['verse_key']),
    sessionId: (r['session_id'] as string | null) ?? null,
    mode: String(r['mode']) as RecallAttempt['mode'],
    startedAt: String(r['started_at']),
    completedAt: (r['completed_at'] as string | null) ?? null,
    produced: JSON.parse(String(r['produced'])) as RecitedWord[],
    cue: r['cue'] === null ? null : (JSON.parse(String(r['cue'])) as RecallAttempt['cue']),
    expectedWordCount: Number(r['expected_word_count']),
    correctWordCount: Number(r['correct_word_count']),
    accuracy: Number(r['accuracy']),
    errors: JSON.parse(String(r['errors'])) as DetectedError[],
    durationMs: r['duration_ms'] === null ? null : Number(r['duration_ms']),
    selfConfidence: r['self_confidence'] === null ? null : Number(r['self_confidence']),
    usedAudio: Number(r['used_audio']) === 1,
  }));
}

export function readConfusionGroups(h: TestHandle): ConfusionGroup[] {
  const groups = h.all<Record<string, unknown>>('SELECT * FROM confusion_group ORDER BY id');
  return groups.map((g) => ({
    id: String(g['id']),
    label: (g['label'] as string | null) ?? null,
    origin: String(g['origin']) as ConfusionGroup['origin'],
    verseKeys: h
      .all<{ verse_key: string }>('SELECT verse_key FROM confusion_group_item WHERE group_id = ? ORDER BY position', [
        String(g['id']),
      ]).map((r) => r.verse_key),
    createdAt: String(g['created_at']),
    lastTriggeredAt: (g['last_triggered_at'] as string | null) ?? null,
    confusionCount: Number(g['confusion_count']),
  }));
}

export function readDueItems(h: TestHandle, nowIso: string): HifzItem[] {
  return h
    .all<Record<string, unknown>>(
      `SELECT * FROM hifz_item WHERE status = 'active' AND next_review_at IS NOT NULL AND next_review_at <= ?
       ORDER BY next_review_at, id`,
      [nowIso],
    )
    .map(rowToHifzItem);
}

export function readUserRowsSnapshot(h: TestHandle): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const table of USER_TABLES) {
    out[table] = h.all(`SELECT * FROM ${table} ORDER BY ROWID`);
  }
  return out;
}

export function rowToAyah(r: Record<string, unknown>): Ayah {
  return {
    verseKey: String(r['verse_key']) as VerseKey,
    chapter: Number(r['chapter']),
    verse: Number(r['verse']),
    sourceId: r['source_id'] === null ? null : Number(r['source_id']),
    juz: Number(r['juz']),
    hizb: Number(r['hizb']),
    rubElHizb: Number(r['rub_el_hizb']),
    sajda: r['sajda'] === null ? null : Number(r['sajda']),
    ruku: r['ruku'] === null ? null : Number(r['ruku']),
    manzil: r['manzil'] === null ? null : Number(r['manzil']),
    page: Number(r['page']),
    textUthmani: String(r['text_uthmani']),
    textUthmaniSimple: (r['text_uthmani_simple'] as string | null) ?? null,
    wordCount: Number(r['word_count']),
    normalizedHash: String(r['normalized_hash']),
  };
}

export function rowToSurah(r: Record<string, unknown>): Surah {
  return {
    number: Number(r['number']),
    nameArabic: String(r['name_arabic']),
    nameSimple: String(r['name_simple']),
    nameTransliterated: String(r['name_transliterated']),
    translationFa: (r['translation_fa'] as string | null) ?? null,
    translationEn: (r['translation_en'] as string | null) ?? null,
    revelationPlace: String(r['revelation_place']) as Surah['revelationPlace'],
    revelationOrder: Number(r['revelation_order']),
    ayahCount: Number(r['ayah_count']),
    pagesFrom: Number(r['pages_from']),
    pagesTo: Number(r['pages_to']),
    firstVerseKey: String(r['first_verse_key']) as VerseKey,
    lastVerseKey: String(r['last_verse_key']) as VerseKey,
    bismillahPre: Number(r['bismillah_pre']) === 1,
  };
}

export function rowToHifzItem(r: Record<string, unknown>): HifzItem {
  return {
    id: String(r['id']),
    verseKey: String(r['verse_key']),
    sequence: JSON.parse(String(r['sequence'])) as string[],
    addedAt: String(r['added_at']),
    status: String(r['status']) as HifzItem['status'],
    band: String(r['band']) as HifzItem['band'],
    stability: Number(r['stability']),
    strength: Number(r['strength']),
    lastReviewedAt: (r['last_reviewed_at'] as string | null) ?? null,
    nextReviewAt: (r['next_review_at'] as string | null) ?? null,
    attemptCount: Number(r['attempt_count']),
    errorCount: Number(r['error_count']),
  };
}

export function sameCounts(a: Record<string, number>, b: Record<string, number>): { equal: boolean; diff: string[] } {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const diff: string[] = [];
  for (const k of keys) {
    if ((a[k] ?? -1) !== (b[k] ?? -1)) diff.push(`${k}: ${a[k] ?? 'missing'} vs ${b[k] ?? 'missing'}`);
  }
  return { equal: diff.length === 0, diff };
}
