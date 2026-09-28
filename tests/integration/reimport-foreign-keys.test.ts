/**
 * Re-importing content on a database that already holds user data.
 *
 * `TauriGateway.applyImport()` and `resetContent()` clear every content table
 * and then write the new pack rows back inside one transaction. Content tables
 * are emptied dependants-first, which handles the content-side foreign keys —
 * but the user side is not content: `note`, `bookmark`, `reading_position`,
 * `reading_history`, `hifz_item` and `confusion_group_item` all reference
 * `ayah(verse_key)` with SQLite's default RESTRICT, and the delete loop reaches
 * `ayah` while those rows still exist.
 *
 * The answers this test pins down, in order:
 *   1. RESTRICT is the right rule — replacing content must never be able to
 *      cascade-delete a learner's notes or attempt history.
 *   2. `PRAGMA defer_foreign_keys = ON` inside the import transaction is the
 *      mechanism that lets a *complete* replace succeed while keeping (1): the
 *      checks run at COMMIT, by which time the ayahs are back.
 *   3. Deferred is not disabled. An import that finishes without restoring a
 *      referenced verse fails at COMMIT and rolls back, so it cannot leave user
 *      data pointing at nothing.
 *
 * Everything runs against real SQLite (`node:sqlite`) created from the
 * authoritative `core/src/contracts/db.sql`, never a mock.
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  CONTENT_TABLES,
  createFixtureDb,
  readUserRowsSnapshot,
  type TestHandle,
} from '../helpers/db';
import type { VerseKey } from '../../core/src/contracts/quran';

/** Deletion order the shipped importer uses: dependant tables first. */
const DELETE_ORDER: readonly string[] = [...CONTENT_TABLES].reverse();

/**
 * Rows keyed by table, taken before the destructive part of an import so the
 * rewrite is a verbatim replay of the same content. `ayah_search` is an FTS5
 * virtual table; the app rebuilds it from the plan rather than replaying it, so
 * it is deliberately out of CONTENT_TABLES here.
 */
type Snapshot = Map<string, { columns: string[]; rows: unknown[][] }>;

function snapshotContent(h: TestHandle): Snapshot {
  const out: Snapshot = new Map();
  for (const table of DELETE_ORDER) {
    const rows = h.all<Record<string, unknown>>(`SELECT * FROM ${table}`);
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    out.set(table, {
      columns,
      rows: rows.map((r) => columns.map((c) => r[c] ?? null)),
    });
  }
  return out;
}

const FK_FAILURE = /FOREIGN KEY constraint failed/i;

/** The shipped clear-then-write, with the two switches this test needs. */
function reimport(h: TestHandle, options: { defer: boolean; dropVerseKey?: VerseKey; crashAfterWrite?: boolean } = { defer: false }): void {
  const snap = snapshotContent(h);
  h.exec('BEGIN');
  try {
    if (options.defer) h.exec('PRAGMA defer_foreign_keys = ON');
    for (const table of DELETE_ORDER) h.run(`DELETE FROM ${table}`);
    // Written back parents-first, the order the importer's plan also follows.
    for (const table of [...DELETE_ORDER].reverse()) {
      const { columns, rows } = snap.get(table)!;
      if (columns.length === 0) continue;
      const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
      for (const row of rows) {
        if (options.dropVerseKey && table === 'ayah' && row[columns.indexOf('verse_key')] === options.dropVerseKey) continue;
        h.run(sql, row);
      }
    }
    if (options.crashAfterWrite) throw new Error('simulated failure between write and commit');
    h.exec('COMMIT');
  } catch (error) {
    h.exec('ROLLBACK');
    throw error;
  }
}

const h = createFixtureDb();
const REFERENCED = '1:1' as VerseKey;

beforeAll(() => {
  expect(h.count('ayah', 'verse_key = ?', [REFERENCED]), 'fixture must contain the referenced ayah').toBe(1);
  expect(h.count('note', 'verse_key = ?', [REFERENCED])).toBeGreaterThan(0);
});

afterAll(() => h.dispose());

describe('content reimport over existing user rows', () => {
  it('refuses the plain clear-then-write: RESTRICT really does block it', () => {
    const ayahs = h.count('ayah');
    expect(() => reimport(h, { defer: false })).toThrowError(FK_FAILURE);

    // A refusal is a rollback, not a half-cleared database.
    expect(h.count('ayah')).toBe(ayahs);
    expect(h.count('content_pack')).toBeGreaterThan(0);
    expect(h.count('note')).toBe(1);
    expect(h.count('hifz_attempt')).toBeGreaterThan(0);
  });

  it('a complete reimport with deferred foreign keys succeeds and keeps user rows identical', () => {
    const beforeUsers = readUserRowsSnapshot(h);
    const beforeContent = snapshotContent(h);

    expect(() => reimport(h, { defer: true })).not.toThrow();

    expect(snapshotContent(h)).toEqual(beforeContent);
    expect(readUserRowsSnapshot(h)).toEqual(beforeUsers);
    expect(h.all('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('deferral does not leak past COMMIT', () => {
    // Deferred checks reset at COMMIT, so an orphan write now fails again.
    expect(() =>
      h.run('INSERT INTO note (id, verse_key, body, created_at, updated_at) VALUES (?,?,?,?,?)', [
        'orphan-probe',
        '77:7',
        'must be refused',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      ]),
    ).toThrowError(FK_FAILURE);
  });

  it('an import that loses a referenced verse fails at COMMIT rather than orphaning user data', () => {
    const beforeUsers = readUserRowsSnapshot(h);
    const beforeAyahs = h.count('ayah');

    expect(() => reimport(h, { defer: true, dropVerseKey: REFERENCED })).toThrowError(FK_FAILURE);

    expect(h.count('ayah')).toBe(beforeAyahs);
    expect(h.count('ayah', 'verse_key = ?', [REFERENCED])).toBe(1);
    expect(readUserRowsSnapshot(h)).toEqual(beforeUsers);
    expect(h.all('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('an abort between write and commit rolls the whole import back', () => {
    const beforeUsers = readUserRowsSnapshot(h);
    const beforeContent = snapshotContent(h);

    expect(() => reimport(h, { defer: true, crashAfterWrite: true })).toThrowError(/simulated failure/);

    expect(snapshotContent(h)).toEqual(beforeContent);
    expect(readUserRowsSnapshot(h)).toEqual(beforeUsers);
  });

  it('a database with no user rows needs no deferral', () => {
    const bare = createFixtureDb({ seedHifz: false });
    try {
      bare.tx(() => {
        for (const table of ['note', 'bookmark', 'reading_position', 'reading_history', 'hifz_item', 'confusion_group_item', 'reflection', 'hifz_attempt', 'hifz_segment', 'anchor_word', 'hifz_transition', 'confusion_group', 'hifz_session', 'journey_progress', 'learning_journey', 'daily_plan', 'user_profile', 'settings']) {
          bare.run(`DELETE FROM ${table}`);
        }
      });
      expect(bare.count('note') + bare.count('hifz_item') + bare.count('reading_position')).toBe(0);
      expect(() => reimport(bare, { defer: false })).not.toThrow();
      expect(bare.count('ayah')).toBe(31);
    } finally {
      bare.dispose();
    }
  });
});
