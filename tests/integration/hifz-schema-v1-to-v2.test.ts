/**
 * The v1 → v2 hifz migration, against a real SQLite file.
 *
 * WHY this test exists at all: a version-1 database already exists on dev
 * machines — created from the DDL that had one `stability` column per item,
 * `meaning_fa`/`meaning_source` on `hifz_segment` and no `dimension` on
 * `hifz_attempt`. `SCHEMA_VERSION` is now 3, so the next time any of those files
 * is opened the chain in `desktop/src/db/schema.ts` has to upgrade it. If that
 * chain recreates the table instead of migrating it, the user loses their whole
 * recall history, which is the only thing every stability number is computed
 * from (AGENTS.md: no fake numbers, and the history is the data).
 *
 * The other thing pinned here is subtler and is the reason the test seeds a
 * *form-only* history: after the upgrade, every surviving attempt must read as
 * evidence of the **form** axis and the **meaning** axis must read as untested
 * (`meaning_stability` NULL on both the item and the segment). Backfilling
 * `meaning_stability = stability` would print a confident 62 % word-meaning
 * recall for an ayah whose meaning was never once drilled — an invented
 * statistic wearing the user's own history. Writing 0 instead of NULL is the
 * same mistake in the other direction: it claims the meaning axis was probed and
 * failed, which drops every migrated ayah to band `new` on the next recompute.
 *
 * Nothing is mocked: the v1 file is built from the real `ayah`/`content_pack`
 * schema plus the v1 definitions of the three hifz tables, the migration runs
 * through the shipped `ensureSchema` entry point, and the assertions read the
 * file back with `PRAGMA table_info` and plain SELECTs.
 *
 * The chain is two steps deep now (v2 dual axis, v3 fingerprint ayah), so this
 * file doubles as the proof that a v1 file composes both in one open: the rows
 * seeded here are written by hand, with ids no engine produced, and they still
 * end up carrying a `verse_key` — recovered from the item's own single-ayah
 * sequence, which is the branch `hifz-schema-v2-to-v3.test.ts` does not cover.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RECALL_MODES } from '@quran/core';
import { ensureSchema, SCHEMA_VERSION, splitStatements } from '../../desktop/src/db/schema';
import { MIGRATIONS } from '../../desktop/src/db/schema';
import { readSchemaSql } from '../helpers/repo';
import { asSqlClient, createTempDb, type TestHandle } from '../helpers/db';

/**
 * The three hifz tables exactly as schema v1 stored them: one `stability` per
 * item, an editorial `meaning_fa` + free-text `meaning_source` per segment, and
 * an attempt whose `mode` CHECK listed only the 15 form modes.
 */
const V1_HIFZ_DDL = `
CREATE TABLE hifz_item (
  id TEXT PRIMARY KEY,
  verse_key TEXT NOT NULL REFERENCES ayah(verse_key),
  sequence TEXT NOT NULL,
  added_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','paused','graduated','dropped')),
  band TEXT NOT NULL CHECK (band IN ('new','unstable','weak','stable','mastered')),
  stability REAL NOT NULL DEFAULT 0,
  strength REAL NOT NULL DEFAULT 0,
  last_reviewed_at TEXT,
  next_review_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX hifz_due_idx ON hifz_item(status, next_review_at);
CREATE TABLE hifz_segment (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES hifz_item(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  from_word INTEGER NOT NULL,
  to_word INTEGER NOT NULL,
  text TEXT NOT NULL,
  meaning_fa TEXT,
  meaning_source TEXT,
  stability REAL NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (item_id, position)
);
CREATE TABLE hifz_attempt (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES hifz_item(id) ON DELETE CASCADE,
  verse_key TEXT NOT NULL,
  session_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('segment','opening','middle','ending','transition','continue-ayah','continue-sequence','missing-word','first-word-cue','last-word-cue','reverse','random','audio-recall','full-ayah','full-sequence')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  produced TEXT NOT NULL,
  cue TEXT,
  expected_word_count INTEGER NOT NULL,
  correct_word_count INTEGER NOT NULL,
  accuracy REAL NOT NULL,
  errors TEXT NOT NULL,
  duration_ms INTEGER,
  self_confidence INTEGER,
  used_audio INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX attempt_item_idx ON hifz_attempt(item_id, started_at);
`;

/** The shipped v2 DDL for everything except the three v1 hifz tables. */
function v1SchemaSql(): string {
  const dropped = [
    /^CREATE TABLE hifz_item\b/,
    /^CREATE TABLE hifz_segment\b/,
    /^CREATE TABLE hifz_attempt\b/,
    // Both hifz indexes are re-created by the v1 text below, in table order.
    /^CREATE INDEX hifz_due_idx\b/,
    /^CREATE INDEX attempt_item_idx\b/,
  ];
  const keep = splitStatements(readSchemaSql()).filter((stmt) => !dropped.some((re) => re.test(stmt)));
  return `${keep.join(';\n')};\n${V1_HIFZ_DDL}`;
}

function columns(h: TestHandle, table: string): string[] {
  return h.all<{ name: string }>(`PRAGMA table_info(${table})`).map((r) => r.name);
}

/** Full `PRAGMA table_info` rows, so not-null-ness can be pinned too. */
function columnInfo(h: TestHandle, table: string): { name: string; notnull: number }[] {
  return h.all<{ name: string; notnull: number }>(`PRAGMA table_info(${table})`);
}

const V1_ERRORS_JSON = JSON.stringify([
  {
    kind: 'substitution',
    expectedPosition: 2,
    expected: 'ٱللَّهِ',
    actual: 'ٱلرحمن',
    confusedWithVerseKey: null,
    segmentPosition: 0,
    explanation: 'v1 history: second word recited without shadda',
  },
]);

describe('schema v1 → v2: the hifz dual axis migrates without losing a row', () => {
  let h: TestHandle;

  beforeAll(() => {
    h = createTempDb({ schemaSql: v1SchemaSql(), meta: { schema_version: '1' } });

    // Content the user data points at: one surah, one ayah, and two packs so the
    // "does `meaning_source` name a real pack?" branch has both answers present.
    h.run(
      `INSERT INTO surah (number, name_arabic, name_simple, name_transliterated, revelation_place,
          revelation_order, ayah_count, pages_from, pages_to, first_verse_key, last_verse_key, bismillah_pre)
       VALUES (1,'سُورَةُ الفَاتِحَة','Al-Fatihah','Al-Fatihah','makkah',1,1,1,1,'1:1','1:1',0)`,
    );
    h.run(
      `INSERT INTO ayah (verse_key, chapter, verse, juz, hizb, rub_el_hizb, page, text_uthmani, word_count, normalized_hash)
       VALUES ('1:1',1,1,1,1,1,1,'بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ',4,'hash')`,
    );
    for (const id of ['word-data', 'tr-fa-kaldari']) {
      h.run(
        `INSERT INTO content_pack (id, kind, version, schema_version, language, title, source, license_name,
            license_status, license_notes, attribution, checksum, payload_bytes, record_count, imported_at)
         VALUES (?,'translation','1',1,'fa','t','s','l','clear','','a','0',0,0,'2026-01-01T00:00:00.000Z')`,
        [id],
      );
    }

    h.run(
      `INSERT INTO hifz_item (id, verse_key, sequence, added_at, status, band, stability, strength,
          last_reviewed_at, next_review_at, attempt_count, error_count)
       VALUES ('item-1','1:1','["1:1"]','2026-09-01T09:00:00.000Z','active','weak',0.62,0.7,'2026-09-20T09:00:00.000Z','2026-09-29T09:00:00.000Z',1,1)`,
    );
    // Three kinds of v1 segment row: a real pack, a fixture label that is not a
    // pack, and a segment that never had a meaning at all.
    h.run(
      `INSERT INTO hifz_segment (id, item_id, position, from_word, to_word, text, meaning_fa, meaning_source, stability, error_count)
       VALUES ('seg-pack','item-1',0,1,2,'بِسْمِ ٱللَّهِ','به نام خدا','word-data',0.62,0)`,
    );
    h.run(
      `INSERT INTO hifz_segment (id, item_id, position, from_word, to_word, text, meaning_fa, meaning_source, stability, error_count)
       VALUES ('seg-fixture','item-1',1,3,4,'ٱلرَّحْمَٰنِ ٱلرَّحِيمِ','بخشنده مهربان','fixture-editorial',0.3,1)`,
    );
    h.run(
      `INSERT INTO hifz_segment (id, item_id, position, from_word, to_word, text, meaning_fa, meaning_source, stability, error_count)
       VALUES ('seg-none','item-1',2,4,4,'ٱلرَّحِيمِ',NULL,NULL,0.1,0)`,
    );
    h.run(
      `INSERT INTO hifz_attempt (id, item_id, verse_key, session_id, mode, started_at, completed_at, produced,
          cue, expected_word_count, correct_word_count, accuracy, errors, duration_ms, self_confidence, used_audio)
       VALUES ('att-1','item-1','1:1','s-1','full-ayah','2026-09-20T09:00:00.000Z','2026-09-20T09:00:40.000Z',
          '[{"position":1,"text":"بِسْمِ"},{"position":2,"text":"ٱلرحمن"}]','{"kind":"anchor","text":"بِسْمِ"}',
          4,3,0.75,?,1100,3,1)`,
      [V1_ERRORS_JSON],
    );
    // A row in a table the migration must not even look at.
    h.run(`INSERT INTO bookmark (id, verse_key, page, label, created_at) VALUES ('bm-1','1:1',1,'ابتدا','2026-09-02T09:00:00.000Z')`);
  });

  afterAll(() => h.dispose());

  it('has a v1 entry in the chain, and the chain ends at SCHEMA_VERSION', () => {
    const step = MIGRATIONS.find((m) => m.to === 2);
    expect(step, 'MIGRATIONS has no v2 step — the chain cannot upgrade a v1 file').toBeDefined();
    expect(MIGRATIONS.map((m) => m.to)).toEqual([2, 3]);
  });

  it('upgrades the file in place and records the current version', async () => {
    const before = h.rowCounts();
    const result = await ensureSchema(asSqlClient(h.db), h.path);

    expect(result.created).toBe(false);
    expect(result.version).toBe(SCHEMA_VERSION);
    expect(result.migrationsRan).toEqual([2, 3]);
    expect(
      h.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', ['schema_version'])?.value,
    ).toBe(String(SCHEMA_VERSION));

    // Not one user row lost, in any table.
    const after = h.rowCounts();
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const table of Object.keys(before)) {
      if (table === 'meta') continue;
      expect(after[table], `${table} row count changed by the migration`).toBe(before[table]);
    }
  });

  it('gives the item two axes and backfills them from form evidence only', () => {
    expect(columns(h, 'hifz_item')).toEqual(expect.arrayContaining(['form_stability', 'meaning_stability']));
    const row = h.get<Record<string, unknown>>('SELECT * FROM hifz_item WHERE id = ?', ['item-1'])!;
    // A v1 item only ever had form evidence, so the form axis inherits the old
    // composite and `stability` itself is left alone for that row.
    expect(Number(row.stability)).toBeCloseTo(0.62, 10);
    expect(Number(row.form_stability)).toBeCloseTo(0.62, 10);
    // …and the meaning axis is *untested*: NULL, not the old number repeated and
    // not a 0 that reads as "drilled and failed". `Number(null)` is 0, so the
    // plain numeric check would pass on either — the raw value is what matters.
    expect(row.meaning_stability).toBeNull();
    const meaningCol = columnInfo(h, 'hifz_item').find((c) => c.name === 'meaning_stability')!;
    expect(Number(meaningCol.notnull), 'meaning_stability must stay nullable').toBe(0);
  });

  it('re-addresses each segment meaning by the pack it actually came from', () => {
    const cols = columns(h, 'hifz_segment');
    expect(cols).toEqual(expect.arrayContaining(['meaning_text', 'meaning_lang', 'meaning_pack', 'meaning_word_gloss', 'meaning_stability']));
    // The v1 columns are gone, so nothing can quietly keep writing to them.
    expect(cols).not.toContain('meaning_fa');
    expect(cols).not.toContain('meaning_source');

    const pack = h.get<Record<string, unknown>>('SELECT * FROM hifz_segment WHERE id = ?', ['seg-pack'])!;
    expect(String(pack.meaning_text)).toBe('به نام خدا');
    expect(String(pack.meaning_lang)).toBe('fa');
    expect(String(pack.meaning_pack)).toBe('word-data');
    expect(Number(pack.meaning_word_gloss)).toBe(0);
    expect(pack.meaning_stability).toBeNull();
    // The v3 step in the same open has to place these hand-written rows in an
    // ayah too. Their ids carry no verse key — no engine wrote them — so the
    // only honest answer is the item's own sequence, which names exactly one.
    expect(String(pack.verse_key)).toBe('1:1');

    // 'fixture-editorial' named no pack, so the meaning has no source now: the
    // text is kept (deleting it would lose the user's own note) but it is not
    // attributed to a licensed pack it never came from.
    const fixture = h.get<Record<string, unknown>>('SELECT * FROM hifz_segment WHERE id = ?', ['seg-fixture'])!;
    expect(String(fixture.meaning_text)).toBe('بخشنده مهربان');
    expect(String(fixture.meaning_lang)).toBe('fa');
    expect(fixture.meaning_pack).toBeNull();
    expect(Number(fixture.meaning_word_gloss)).toBe(0);

    const none = h.get<Record<string, unknown>>('SELECT * FROM hifz_segment WHERE id = ?', ['seg-none'])!;
    expect(none.meaning_text).toBeNull();
    expect(none.meaning_lang).toBeNull();
    expect(none.meaning_pack).toBeNull();
    // A segment with no meaning must not claim to be a word gloss.
    expect(Number(none.meaning_word_gloss)).toBe(0);
    expect(Number(none.stability)).toBeCloseTo(0.1, 10);
  });

  it('rebuilds hifz_attempt so every v1 attempt is form evidence, byte-for-byte', () => {
    expect(columns(h, 'hifz_attempt')).toEqual(expect.arrayContaining(['dimension']));
    const row = h.get<Record<string, unknown>>('SELECT * FROM hifz_attempt WHERE id = ?', ['att-1'])!;
    expect(String(row.dimension)).toBe('form');
    expect(String(row.mode)).toBe('full-ayah');
    expect(String(row.errors)).toBe(V1_ERRORS_JSON);
    expect(String(row.produced)).toBe('[{"position":1,"text":"بِسْمِ"},{"position":2,"text":"ٱلرحمن"}]');
    expect(String(row.cue)).toBe('{"kind":"anchor","text":"بِسْمِ"}');
    expect(Number(row.accuracy)).toBeCloseTo(0.75, 10);
    expect(Number(row.used_audio)).toBe(1);
    expect(Number(row.self_confidence)).toBe(3);
    expect(Number(row.duration_ms)).toBe(1100);

    // The CHECK really was widened: a meaning attempt is now storable…
    h.run(
      `INSERT INTO hifz_attempt (id, item_id, verse_key, mode, dimension, started_at, produced,
          expected_word_count, correct_word_count, accuracy, errors, used_audio)
       VALUES ('att-2','item-1','1:1','meaning-to-arabic','meaning','2026-09-21T09:00:00.000Z','[]',2,1,0.5,'[]',0)`,
    );
    expect(h.count('hifz_attempt', 'dimension = ?', ['meaning'])).toBe(1);
    // …and a dimension outside the contract union is still refused.
    let refused = false;
    try {
      h.run(
        `INSERT INTO hifz_attempt (id, item_id, verse_key, mode, dimension, started_at, produced,
            expected_word_count, correct_word_count, accuracy, errors, used_audio)
         VALUES ('att-3','item-1','1:1','segment','recall','2026-09-21T09:00:00.000Z','[]',1,1,1,'[]',0)`,
      );
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    h.run('DELETE FROM hifz_attempt WHERE id IN (?,?)', ['att-2', 'att-3']);
  });

  it('is current after one run: a second open migrates nothing and rewrites nothing', async () => {
    h.run("UPDATE hifz_item SET meaning_stability = 0.4 WHERE id = 'item-1'");
    const result = await ensureSchema(asSqlClient(h.db), h.path);
    expect(result.migrationsRan).toEqual([]);
    expect(result.notes).toContain('Schema already current');
    // The backfill must not re-run and stamp a real meaning score back to 0.
    const row = h.get<Record<string, unknown>>('SELECT meaning_stability FROM hifz_item WHERE id = ?', ['item-1'])!;
    expect(Number(row.meaning_stability)).toBeCloseTo(0.4, 10);
  });

  it('survives a file whose DDL already ran ahead of the version it claims', async () => {
    // Real shape on dev machines: `db.sql` gained the dual axis before
    // `SCHEMA_VERSION` was bumped (and, again, the fingerprint `verse_key`
    // before this bump), so a freshly created file can be current-shaped while
    // `meta.schema_version` still says 1. `ALTER TABLE … ADD COLUMN` would throw
    // `duplicate column name` there, so every step probes before it writes.
    const fresh = createTempDb({ meta: { schema_version: '1' } });    fresh.run(
      `INSERT INTO surah (number, name_arabic, name_simple, name_transliterated, revelation_place,
          revelation_order, ayah_count, pages_from, pages_to, first_verse_key, last_verse_key, bismillah_pre)
       VALUES (112,'سُورَةُ الإِخْلَاص','Al-Ikhlas','Al-Ikhlas','makkah',189,4,1,1,'112:1','112:4',0)`,
    );
    fresh.run(
      `INSERT INTO ayah (verse_key, chapter, verse, juz, hizb, rub_el_hizb, page, text_uthmani, word_count, normalized_hash)
       VALUES ('112:1',112,1,30,60,1,1,'قُلْ هُوَ ٱللَّهُ أَحَدٌ',4,'hash')`,
    );
    fresh.run(
      `INSERT INTO hifz_item (id, verse_key, sequence, added_at, status, band, stability, form_stability, meaning_stability,
          strength, attempt_count, error_count)
       VALUES ('live-1','112:1','["112:1"]','2026-09-01T09:00:00.000Z','active','stable',0.9,0.9,0.7,0.8,5,0)`,
    );
    fresh.run(
      `INSERT INTO hifz_segment (id, item_id, verse_key, position, from_word, to_word, text, meaning_text, meaning_lang,
          meaning_pack, meaning_word_gloss, stability, meaning_stability, error_count)
       VALUES ('live-seg','live-1','112:1',0,1,4,'قُلْ هُوَ ٱللَّهُ أَحَدٌ','He is Allah, the One','en','word-data',1,0.9,0.5,0)`,
    );

    const result = await ensureSchema(asSqlClient(fresh.db), fresh.path);
    expect(result.migrationsRan).toEqual([2, 3]);
    const item = fresh.get<Record<string, unknown>>('SELECT * FROM hifz_item WHERE id = ?', ['live-1'])!;
    expect(Number(item.form_stability)).toBeCloseTo(0.9, 10);
    expect(Number(item.meaning_stability)).toBeCloseTo(0.7, 10);
    const seg = fresh.get<Record<string, unknown>>('SELECT * FROM hifz_segment WHERE id = ?', ['live-seg'])!;
    expect(String(seg.meaning_pack)).toBe('word-data');
    expect(Number(seg.meaning_word_gloss)).toBe(1);
    expect(Number(seg.meaning_stability)).toBeCloseTo(0.5, 10);
    fresh.dispose();
  });

  it('accepts every contract mode in the rebuilt CHECK list', () => {
    // The DDL and the contract are two lists of the same enum; the guard suite
    // compares the text, this one proves SQLite really admits every mode.
    const ddl = readSchemaSql();
    for (const mode of RECALL_MODES) {
      expect(ddl, `db.sql does not list the mode '${mode}'`).toContain(`'${mode}'`);
    }
    h.run(
      `INSERT INTO hifz_item (id, verse_key, sequence, added_at, status, band, stability, form_stability,
          meaning_stability, strength, attempt_count, error_count)
       VALUES ('modes-item','1:1','["1:1"]','2026-09-01T09:00:00.000Z','active','new',0,0,0,0,0,0)`,
    );
    for (const [index, mode] of RECALL_MODES.entries()) {
      const dimension = mode === 'meaning-to-arabic' || mode === 'concept-cue' ? 'meaning' : 'form';
      h.run(
        `INSERT INTO hifz_attempt (id, item_id, verse_key, mode, dimension, started_at, produced,
            expected_word_count, correct_word_count, accuracy, errors, used_audio)
         VALUES (?, 'modes-item', '1:1', ?, ?, '2026-09-22T09:00:00.000Z', '[]', 1, 1, 1, '[]', 0)`,
        [`mode-${index}`, mode, dimension],
      );
    }
    expect(h.count('hifz_attempt', 'item_id = ?', ['modes-item'])).toBe(RECALL_MODES.length);
    h.run("DELETE FROM hifz_item WHERE id = 'modes-item'");
  });

  it('keeps the indexes and the cascade of the tables it rebuilt — last, it deletes the item', () => {
    expect(h.indexes()).toEqual(expect.arrayContaining(['attempt_item_idx', 'hifz_due_idx']));
    // `hifz_segment.item_id → hifz_item` still cascades after the rebuild, so a
    // dropped ayah does not leave orphan chunks behind that no attempt can reach.
    h.run('DELETE FROM hifz_item WHERE id = ?', ['item-1']);
    expect(h.count('hifz_segment')).toBe(0);
    expect(h.count('hifz_attempt')).toBe(0);
  });
});
