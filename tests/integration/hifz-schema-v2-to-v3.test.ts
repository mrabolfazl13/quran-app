/**
 * The v2 → v3 hifz fingerprint migration, against a real SQLite file.
 *
 * WHY: `hifz_segment.position`, `anchor_word.word_position` and
 * `hifz_transition.to_word` all count from the start of an ayah, but through v2
 * the row's identity was `(item_id, position)`. An item that tiles two ayat
 * therefore has two segment 0s, and the store could only keep one of them: the
 * enrolment path either offset the numbering or dropped the second ayah's row
 * outright. v3 makes the identity `(item_id, verse_key, position)`, which means
 * every existing row has to be told which ayah it numbers inside.
 *
 * The ayah is not invented. The engine has always written these ids as
 * `{itemId}:{verseKey}:{tag}{n}` (`core/src/hifz/segment.ts`), so the row names
 * its own ayah; a row whose id carries nothing (a hand-made row, or an id from
 * before that scheme) is placed only when its item spans exactly one ayah, where
 * every chunk of that item is in that ayah by arithmetic. Anything else cannot be
 * placed, and the whole step rolls back instead of filing the second ayah's chunk
 * under the first one — a mis-numbered fingerprint silently grades the wrong
 * chunk forever, which is worse than no migration at all.
 *
 * Positions are carried over byte-for-byte, exactly as `core/src/backup/restore.ts`
 * carries them: this step adds the ayah, it does not renumber the chunks.
 *
 * Nothing is mocked. The v2 file is the shipped DDL with the three fingerprint
 * tables replaced by their v2 bodies, the upgrade runs through `ensureSchema`, and
 * the assertions read the file back with `PRAGMA table_info` and plain SELECTs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ensureSchema,
  MIGRATIONS,
  SCHEMA_VERSION,
  splitStatements,
} from '../../desktop/src/db/schema';
import { readSchemaSql } from '../helpers/repo';
import { asSqlClient, createTempDb, type TestHandle } from '../helpers/db';

/**
 * The three fingerprint tables exactly as schema v2 stored them: no `verse_key`,
 * and a UNIQUE key that starts at `item_id`. The v2 `hifz_segment` body is the
 * dual-axis one `migrateV1ToV2` installs, so a file written by that step is what
 * this step reads.
 */
const V2_FINGERPRINT_DDL = `
CREATE TABLE hifz_segment (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES hifz_item(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  from_word INTEGER NOT NULL,
  to_word INTEGER NOT NULL,
  text TEXT NOT NULL,
  meaning_text TEXT,
  meaning_lang TEXT CHECK (meaning_lang IN ('fa','ar','en')),
  meaning_pack TEXT,
  meaning_word_gloss INTEGER NOT NULL DEFAULT 1,
  stability REAL NOT NULL DEFAULT 0,
  meaning_stability REAL,
  error_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (item_id, position)
);
CREATE TABLE anchor_word (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES hifz_item(id) ON DELETE CASCADE,
  word_position INTEGER NOT NULL,
  text TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('opening','middle','ending','boundary')),
  stability REAL NOT NULL DEFAULT 0,
  UNIQUE (item_id, word_position, role)
);
CREATE TABLE hifz_transition (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES hifz_item(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('intra','inter')),
  to_verse_key TEXT,
  to_word INTEGER NOT NULL,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  stability REAL NOT NULL DEFAULT 0,
  last_practiced_at TEXT,
  UNIQUE (item_id, kind, to_word, to_verse_key)
);
`;

/** The shipped DDL for everything except the three tables, which are v2-shaped. */
function v2SchemaSql(): string {
  const dropped = [
    /^CREATE TABLE hifz_segment\b/,
    /^CREATE TABLE anchor_word\b/,
    /^CREATE TABLE hifz_transition\b/,
  ];
  const keep = splitStatements(readSchemaSql()).filter((stmt) => !dropped.some((re) => re.test(stmt)));
  return `${keep.join(';\n')};\n${V2_FINGERPRINT_DDL}`;
}

function columns(h: TestHandle, table: string): string[] {
  return h.all<{ name: string }>(`PRAGMA table_info(${table})`).map((r) => r.name);
}

/** Full `PRAGMA table_info` rows, so not-null-ness can be pinned too. */
function columnInfo(h: TestHandle, table: string): { name: string; notnull: number }[] {
  return h.all<{ name: string; notnull: number }>(`PRAGMA table_info(${table})`);
}

/** `id → verse_key` for one table, ordered so the arrays compare directly. */
function placed(h: TestHandle, table: string): { id: string; verseKey: string }[] {
  return h
    .all<{ id: string; verse_key: string }>(`SELECT id, verse_key FROM ${table} ORDER BY id`)
    .map((r) => ({ id: r.id, verseKey: String(r.verse_key) }));
}

/**
 * Content and hifz rows for a v2 file: one item that spans two ayat (whose
 * fingerprint rows carry engine ids naming each ayah), one single-ayah item whose
 * rows were written with hand-made ids, and one row in a table v3 never touches.
 */
function seedV2(h: TestHandle): void {
  h.run(
    `INSERT INTO surah (number, name_arabic, name_simple, name_transliterated, revelation_place,
        revelation_order, ayah_count, pages_from, pages_to, first_verse_key, last_verse_key, bismillah_pre)
     VALUES (112,'سُورَةُ الإِخْلَاص','Al-Ikhlas','Al-Ikhlas','makkah',189,4,1,1,'112:1','112:4',0)`,
  );
  const ayat: [string, string, number][] = [
    ['112:1', 'قُلْ هُوَ ٱللَّهُ أَحَدٌ', 4],
    ['112:2', 'ٱللَّهُ ٱلصَّمَدُ', 2],
    ['112:3', 'لَمْ يَلِدْ وَلَمْ يُولَدْ', 4],
  ];
  for (const [key, text, words] of ayat) {
    h.run(
      `INSERT INTO ayah (verse_key, chapter, verse, juz, hizb, rub_el_hizb, page, text_uthmani, word_count, normalized_hash)
       VALUES (?,112,?,30,60,1,1,?,?,'hash')`,
      [key, Number(key.slice(4)), text, words],
    );
  }

  // A two-ayah item: the engine numbered each ayah's chunks from 0, and v2 could
  // not have stored both segment 0s, so the second ayah's chunk is stored under an
  // offset. Its id still names the ayah it came from.
  h.run(
    `INSERT INTO hifz_item (id, verse_key, sequence, added_at, status, band, stability, form_stability,
        meaning_stability, strength, last_reviewed_at, next_review_at, attempt_count, error_count)
     VALUES ('hi-multi','112:1','["112:1","112:2"]','2026-09-01T09:00:00.000Z','active','weak',0.6,0.6,0.4,0.5,
        '2026-09-20T09:00:00.000Z','2026-09-29T09:00:00.000Z',2,1)`,
  );
  h.run(
    `INSERT INTO hifz_segment (id, item_id, position, from_word, to_word, text, meaning_text, meaning_lang,
        meaning_pack, meaning_word_gloss, stability, meaning_stability, error_count)
     VALUES ('hi-multi:112:1:s0','hi-multi',0,1,2,'قُلْ هُوَ','Say, He is','en','word-data',1,0.7,0.5,0)`,
  );
  h.run(
    `INSERT INTO hifz_segment (id, item_id, position, from_word, to_word, text, meaning_text, meaning_lang,
        meaning_pack, meaning_word_gloss, stability, meaning_stability, error_count)
     VALUES ('hi-multi:112:1:s1','hi-multi',1,3,4,'ٱللَّهُ أَحَدٌ','Allah, the One','en','word-data',1,0.3,0.2,1)`,
  );
  h.run(
    `INSERT INTO hifz_segment (id, item_id, position, from_word, to_word, text, meaning_text, meaning_lang,
        meaning_pack, meaning_word_gloss, stability, meaning_stability, error_count)
     VALUES ('hi-multi:112:2:s0','hi-multi',2,1,2,'ٱللَّهُ ٱلصَّمَدُ','Allah, the Eternal Refuge','en','word-data',1,0.1,NULL,0)`,
  );
  h.run(
    `INSERT INTO anchor_word (id, item_id, word_position, text, role, stability)
     VALUES ('hi-multi:112:1:a1','hi-multi',1,'قُلْ','opening',0.8)`,
  );
  h.run(
    `INSERT INTO anchor_word (id, item_id, word_position, text, role, stability)
     VALUES ('hi-multi:112:2:a1','hi-multi',1,'ٱللَّهُ','ending',0.2)`,
  );
  h.run(
    `INSERT INTO hifz_transition (id, item_id, kind, to_verse_key, to_word, success_count, failure_count, stability, last_practiced_at)
     VALUES ('hi-multi:112:1:t3','hi-multi','intra',NULL,3,4,1,0.65,'2026-09-20T09:00:00.000Z')`,
  );
  h.run(
    `INSERT INTO hifz_transition (id, item_id, kind, to_verse_key, to_word, success_count, failure_count, stability, last_practiced_at)
     VALUES ('hi-multi:112:1:tnext-112:2','hi-multi','inter','112:2',1,2,3,0.35,NULL)`,
  );

  // A one-ayah item whose rows have ids no engine wrote: no ayah inside them, so
  // the item's own sequence is the only evidence — and for a one-ayah item it is
  // proof, not a guess.
  h.run(
    `INSERT INTO hifz_item (id, verse_key, sequence, added_at, status, band, stability, form_stability,
        meaning_stability, strength, last_reviewed_at, next_review_at, attempt_count, error_count)
     VALUES ('hi-solo','112:3','["112:3"]','2026-09-02T09:00:00.000Z','active','stable',0.9,0.9,0.8,0.9,
        '2026-09-21T09:00:00.000Z','2026-10-01T09:00:00.000Z',3,0)`,
  );
  h.run(
    `INSERT INTO hifz_segment (id, item_id, position, from_word, to_word, text, meaning_text, meaning_lang,
        meaning_pack, meaning_word_gloss, stability, meaning_stability, error_count)
     VALUES ('legacy-seg','hi-solo',0,1,4,'لَمْ يَلِدْ وَلَمْ يُولَدْ',NULL,NULL,NULL,0,0.9,NULL,0)`,
  );
  h.run(
    `INSERT INTO anchor_word (id, item_id, word_position, text, role, stability)
     VALUES ('legacy-anchor','hi-solo',1,'لَمْ','opening',0.9)`,
  );
  h.run(
    `INSERT INTO hifz_transition (id, item_id, kind, to_verse_key, to_word, success_count, failure_count, stability, last_practiced_at)
     VALUES ('legacy-transition','hi-solo','intra',NULL,3,1,0,0.9,NULL)`,
  );

  // A row in a table the step must not even look at.
  h.run(`INSERT INTO bookmark (id, verse_key, page, label, created_at) VALUES ('bm-1','112:1',1,'ابتدا','2026-09-03T09:00:00.000Z')`);
}

describe('schema v2 → v3: every fingerprint row is placed in an ayah, or nothing moves', () => {
  let h: TestHandle;

  beforeAll(() => {
    h = createTempDb({ schemaSql: v2SchemaSql(), meta: { schema_version: '2' } });
    seedV2(h);
    // Pre-flight: the file really is v2-shaped, or the test proves nothing.
    expect(columns(h, 'hifz_segment')).not.toContain('verse_key');
    expect(columns(h, 'anchor_word')).not.toContain('verse_key');
    expect(columns(h, 'hifz_transition')).not.toContain('verse_key');
  });

  afterAll(() => h.dispose());

  it('has a v2 → v3 step, and it is the last one', () => {
    const step = MIGRATIONS.find((m) => m.to === 3);
    expect(step, 'MIGRATIONS has no v3 step — the chain cannot upgrade a v2 file').toBeDefined();
    expect(MIGRATIONS[MIGRATIONS.length - 1]!.to).toBe(SCHEMA_VERSION);
  });

  it('upgrades in place, records version 3, and loses no row', async () => {
    const before = h.rowCounts();
    const result = await ensureSchema(asSqlClient(h.db), h.path);

    expect(result.created).toBe(false);
    expect(result.version).toBe(3);
    expect(result.migrationsRan).toEqual([3]);
    expect(h.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', ['schema_version'])?.value).toBe('3');

    const after = h.rowCounts();
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const table of Object.keys(before)) {
      if (table === 'meta') continue;
      expect(after[table], `${table} row count changed by the migration`).toBe(before[table]);
    }
    // The tables it rebuilt are back to their exact row counts, not just the same total.
    expect(h.count('hifz_segment')).toBe(4);
    expect(h.count('anchor_word')).toBe(3);
    expect(h.count('hifz_transition')).toBe(3);
  });

  it('places each row of the two-ayah item by the ayah its id names', () => {
    expect(placed(h, 'hifz_segment')).toEqual([
      { id: 'hi-multi:112:1:s0', verseKey: '112:1' },
      { id: 'hi-multi:112:1:s1', verseKey: '112:1' },
      { id: 'hi-multi:112:2:s0', verseKey: '112:2' },
      { id: 'legacy-seg', verseKey: '112:3' },
    ]);
    // The chunk v2 could not hold beside segment 0 of the first ayah is now
    // addressable as (item, 112:2, its own number) instead of being dropped.
    const second = h.get<Record<string, unknown>>(
      'SELECT * FROM hifz_segment WHERE id = ?',
      ['hi-multi:112:2:s0'],
    )!;
    expect(String(second.text)).toBe('ٱللَّهُ ٱلصَّمَدُ');
    expect(Number(second.stability)).toBeCloseTo(0.1, 10);
    // An untested meaning axis stays NULL across the rebuild — a 0 here would
    // claim the meaning was probed and failed.
    expect(second.meaning_stability).toBeNull();
  });

  it('places anchors and transitions by their ids too, inter-ayah included', () => {
    expect(placed(h, 'anchor_word')).toEqual([
      { id: 'hi-multi:112:1:a1', verseKey: '112:1' },
      { id: 'hi-multi:112:2:a1', verseKey: '112:2' },
      { id: 'legacy-anchor', verseKey: '112:3' },
    ]);
    expect(placed(h, 'hifz_transition')).toEqual([
      { id: 'hi-multi:112:1:t3', verseKey: '112:1' },
      // The inter-ayah boundary names the ayah it leaves, not the one it lands in.
      { id: 'hi-multi:112:1:tnext-112:2', verseKey: '112:1' },
      { id: 'legacy-transition', verseKey: '112:3' },
    ]);
    const inter = h.get<Record<string, unknown>>(
      'SELECT * FROM hifz_transition WHERE id = ?',
      ['hi-multi:112:1:tnext-112:2'],
    )!;
    expect(String(inter.kind)).toBe('inter');
    expect(String(inter.to_verse_key)).toBe('112:2');
    expect(Number(inter.failure_count)).toBe(3);
  });

  it('takes the single-ayah item at its word when the id says nothing', () => {
    // `legacy-*` ids carry no ayah, and `hi-solo` spans exactly one, so every one
    // of its rows is in `112:3` by arithmetic rather than by guess.
    for (const table of ['hifz_segment', 'anchor_word', 'hifz_transition']) {
      const rows = h.all<{ verse_key: string; item_id: string }>(
        `SELECT verse_key, item_id FROM ${table} WHERE item_id = 'hi-solo'`,
      );
      expect(rows.length, `${table} has no row for hi-solo`).toBeGreaterThan(0);
      for (const row of rows) expect(String(row.verse_key)).toBe('112:3');
    }
  });

  it('makes verse_key NOT NULL on all three tables, and keeps every other column', () => {
    for (const table of ['hifz_segment', 'anchor_word', 'hifz_transition']) {
      const verseCol = columnInfo(h, table).find((c) => c.name === 'verse_key')!;
      expect(Number(verseCol.notnull), `${table}.verse_key must be NOT NULL`).toBe(1);
    }
    // Column order is the contract's, so a `SELECT *` reader still lines up.
    expect(columns(h, 'hifz_segment')).toEqual([
      'id', 'item_id', 'verse_key', 'position', 'from_word', 'to_word', 'text',
      'meaning_text', 'meaning_lang', 'meaning_pack', 'meaning_word_gloss',
      'stability', 'meaning_stability', 'error_count',
    ]);
    expect(columns(h, 'anchor_word')).toEqual([
      'id', 'item_id', 'verse_key', 'word_position', 'text', 'role', 'stability',
    ]);
    expect(columns(h, 'hifz_transition')).toEqual([
      'id', 'item_id', 'verse_key', 'kind', 'to_verse_key', 'to_word',
      'success_count', 'failure_count', 'stability', 'last_practiced_at',
    ]);
  });

  it('swaps the UNIQUE key for one that includes the ayah, and keeps the CHECKs', () => {
    // The rebuild is not cosmetic: what v2 refused, v3 must admit, and what v3
    // allows must still stop a true duplicate inside one ayah.
    h.run(
      `INSERT INTO hifz_segment (id, item_id, verse_key, position, from_word, to_word, text)
       VALUES ('probe-seg','hi-multi','112:2',0,1,1,'ٱللَّهُ')`,
    );
    expect(h.count('hifz_segment', 'item_id = ? AND position = 0', ['hi-multi'])).toBe(2);
    let sameAyahRefused = false;
    try {
      h.run(
        `INSERT INTO hifz_segment (id, item_id, verse_key, position, from_word, to_word, text)
         VALUES ('probe-seg-2','hi-multi','112:2',0,2,2,'ٱلصَّمَدُ')`,
      );
    } catch {
      sameAyahRefused = true;
    }
    expect(sameAyahRefused, 'UNIQUE (item_id, verse_key, position) did not fire').toBe(true);
    h.run("DELETE FROM hifz_segment WHERE id LIKE 'probe-%'");

    h.run(`INSERT INTO anchor_word (id, item_id, verse_key, word_position, text, role) VALUES ('probe-a','hi-multi','112:2',1,'ٱللَّهُ','opening')`);
    let anchorRefused = false;
    try {
      h.run(`INSERT INTO anchor_word (id, item_id, verse_key, word_position, text, role) VALUES ('probe-a2','hi-multi','112:2',1,'ٱللَّهُ','opening')`);
    } catch {
      anchorRefused = true;
    }
    expect(anchorRefused).toBe(true);
    h.run("DELETE FROM anchor_word WHERE id LIKE 'probe-%'");

    let roleRefused = false;
    try {
      h.run(`INSERT INTO anchor_word (id, item_id, verse_key, word_position, text, role) VALUES ('probe-r','hi-multi','112:1',2,'هُوَ','sideways')`);
    } catch {
      roleRefused = true;
    }
    expect(roleRefused, 'the role CHECK was lost by the rebuild').toBe(true);
    let langRefused = false;
    try {
      h.run(
        `INSERT INTO hifz_segment (id, item_id, verse_key, position, from_word, to_word, text, meaning_lang)
         VALUES ('probe-lang','hi-multi','112:1',9,1,1,'قُلْ','de')`,
      );
    } catch {
      langRefused = true;
    }
    expect(langRefused, 'the meaning_lang CHECK was lost by the rebuild').toBe(true);
    let kindRefused = false;
    try {
      h.run(
        `INSERT INTO hifz_transition (id, item_id, verse_key, kind, to_word)
         VALUES ('probe-kind','hi-multi','112:1','sideways',1)`,
      );
    } catch {
      kindRefused = true;
    }
    expect(kindRefused, 'the kind CHECK was lost by the rebuild').toBe(true);
  });

  it('keeps the cascade, so a dropped item takes its rebuilt rows with it', () => {
    expect(h.indexes()).toEqual(expect.arrayContaining(['hifz_due_idx', 'attempt_item_idx']));
    h.run("DELETE FROM hifz_item WHERE id = 'hi-multi'");
    expect(h.count('hifz_segment', 'item_id = ?', ['hi-multi'])).toBe(0);
    expect(h.count('anchor_word', 'item_id = ?', ['hi-multi'])).toBe(0);
    expect(h.count('hifz_transition', 'item_id = ?', ['hi-multi'])).toBe(0);
    // The other item and the unrelated table are untouched.
    expect(h.count('hifz_segment')).toBe(1);
    expect(h.count('bookmark')).toBe(1);
  });

  it('is current after one run: a second open migrates nothing', async () => {
    const result = await ensureSchema(asSqlClient(h.db), h.path);
    expect(result.migrationsRan).toEqual([]);
    expect(result.notes).toContain('Schema already current');
  });
});

describe('schema v2 → v3: a row that cannot be placed stops the whole step', () => {
  it('throws, writes nothing, and leaves the v2 file openable', async () => {
    // `hi-multi` spans two ayat and `orphan-seg` names no ayah in its id, so there
    // is no honest answer. Filing it under the item's first verse_key would grade
    // the second ayah's chunk as if it were the first ayah's.
    const h = createTempDb({ schemaSql: v2SchemaSql(), meta: { schema_version: '2' } });
    try {
      seedV2(h);
      h.run(
        `INSERT INTO hifz_item (id, verse_key, sequence, added_at, status, band, stability, form_stability,
            meaning_stability, strength, attempt_count, error_count)
         VALUES ('hi-orphan','112:1','["112:1","112:2"]','2026-09-03T09:00:00.000Z','active','new',0,0,NULL,0,0,0)`,
      );
      h.run(
        `INSERT INTO hifz_segment (id, item_id, position, from_word, to_word, text)
         VALUES ('orphan-seg','hi-orphan',0,1,2,'قُلْ هُوَ')`,
      );

      const before = h.rowCounts();
      await expect(ensureSchema(asSqlClient(h.db), h.path)).rejects.toThrow(/migration to v3 aborted/);

      // Nothing half-written: not the unplaceable row's table, and not the tables
      // whose rows all *could* be placed either.
      expect(h.rowCounts()).toEqual(before);
      expect(columns(h, 'hifz_segment')).not.toContain('verse_key');
      expect(columns(h, 'anchor_word')).not.toContain('verse_key');
      expect(columns(h, 'hifz_transition')).not.toContain('verse_key');
      expect(h.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', ['schema_version'])?.value).toBe('2');
      // The step never leaves the connection with foreign keys off. `PRAGMA
      // foreign_keys` answers one row, and node:sqlite names the column after the
      // pragma, not `enable`.
      expect(Number(h.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys)).toBe(1);
      // `PRAGMA foreign_key_check` still answers nothing, so the file is intact.
      expect(h.all('PRAGMA foreign_key_check')).toEqual([]);

      // …and the file is still openable: once the row no user can place is gone,
      // the same step runs to completion on the retry.
      h.run("DELETE FROM hifz_segment WHERE id = 'orphan-seg'");
      h.run("DELETE FROM hifz_item WHERE id = 'hi-orphan'");
      const again = await ensureSchema(asSqlClient(h.db), h.path);
      expect(again.version).toBe(SCHEMA_VERSION);
      expect(again.migrationsRan).toEqual([3]);
      expect(h.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', ['schema_version'])?.value).toBe('3');
      expect(placed(h, 'hifz_segment')).toEqual([
        { id: 'hi-multi:112:1:s0', verseKey: '112:1' },
        { id: 'hi-multi:112:1:s1', verseKey: '112:1' },
        { id: 'hi-multi:112:2:s0', verseKey: '112:2' },
        { id: 'legacy-seg', verseKey: '112:3' },
      ]);
    } finally {
      h.dispose();
    }
  });
});
