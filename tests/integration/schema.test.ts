/**
 * Integration: the authoritative DDL, executed for real in SQLite.
 *
 * Nothing is mocked — `core/src/contracts/db.sql` runs against a temp file
 * database via `node:sqlite`, and every promise `docs/data-model.md` makes
 * about it is checked: tables exist, CHECK constraints actually reject bad
 * enums, composite keys behave, cascades destroy what the document says they
 * destroy, and the FTS5 index is available on this build.
 *
 * The cascade case is the one the UI must warn about: dropping a `hifz_item`
 * takes `hifz_attempt` — the append-only history every stability number is
 * computed from — with it.
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  CONTENT_TABLES,
  EXPECTED_INDEXES,
  USER_TABLES,
  createFixtureDb,
  createTempDb,
  insertAyah,
  insertBookmark,
  insertHifzAttempt,
  insertHifzItem,
  insertHifzSegment,
  isCheckFailure,
  isForeignKeyFailure,
  isUniqueFailure,
  readHifzAttempts,
  readHifzSegments,
  rowToAyah,
  type TestHandle,
} from '../helpers/db';
import { readSchemaSql, pathExists, rawFile } from '../helpers/repo';
import { loadCorpusFixture } from '../helpers/corpus';
import { EPOCH_ISO, daysLater } from '../helpers/clock';
import { normalizedText } from '../../core/src/normalize/arabic';

/** Capture the throw of a statement so the message can be asserted precisely. */
function capture(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

/** Code-point dump, so a byte difference is locatable rather than a shrug. */
function codePoints(text: string): string {
  return [...text].map((ch) => ch.codePointAt(0)!.toString(16)).join(' ');
}

/**
 * Assert a statement is rejected by the constraint the test names.
 * `expect(fn).toThrow(predicate)` is not usable here: vitest only accepts a
 * string / RegExp / Error constructor, and the node:sqlite messages are exact.
 */
function expectRejection(fn: () => unknown, matcher: (error: unknown) => boolean, label: string): void {
  const error = capture(fn);
  if (error === null) throw new Error(`expected a rejection (${label}) but the statement succeeded`);
  expect(matcher(error), `${label}: got ${error instanceof Error ? error.message : String(error)}`).toBe(true);
}


/**
 * Tables the DDL must create, parsed out of `db.sql` itself rather than a
 * hand-copied list: if the Architect adds a table the suite notices.
 */
function ddlObjects(): { tables: string[]; indexes: string[] } {
  const sql = readSchemaSql();
  const tables = [...sql.matchAll(/CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+ES\s+)?([a-z_]+)/gi)].map((m) => m[1]!);
  const indexes = [...sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+ES\s+)?([a-z_]+)/gi)].map((m) => m[1]!);
  return { tables, indexes };
}

function checkClauses(): { table: string; column: string; expression: string }[] {
  const sql = readSchemaSql();
  const out: { table: string; column: string; expression: string }[] = [];
  for (const match of sql.matchAll(/CREATE\s+(?:VIRTUAL\s+)?TABLE\s+([a-z_]+)\s+\(([\s\S]*?)\n\);/g)) {
    const table = match[1]!;
    const body = match[2]!;
    for (const line of body.split('\n')) {
      const column = line.match(/^\s*([a-z_]+)\s+[A-Z]/)?.[1];
      const check = line.match(/CHECK\s*\((.+)\)\s*,?\s*$/);
      if (column && check) out.push({ table, column, expression: check[1]! });
    }
  }
  return out;
}

const raw = ddlObjects();
const checks = checkClauses();

describe('schema: db.sql executes and creates every object', () => {
  let h: TestHandle;

  beforeAll(() => {
    h = createTempDb({ meta: {} });
  });

  afterAll(() => h?.dispose());

  it('creates every table declared in the DDL', () => {
    const created = new Set(h.tables());
    const missing = raw.tables.filter((t) => !created.has(t));
    expect(missing, `tables missing after running db.sql: ${missing.join(', ')}`).toEqual([]);
    expect(raw.tables.length).toBeGreaterThanOrEqual(30);
  });

  it('creates content tables and user tables as two documented groups', () => {
    const created = new Set(h.tables());
    for (const table of CONTENT_TABLES) expect(created.has(table), `content table ${table}`).toBe(true);
    for (const table of USER_TABLES) expect(created.has(table), `user table ${table}`).toBe(true);
  });

  it('creates every named index declared in the DDL', () => {
    const created = new Set(h.indexes());
    const missing = raw.indexes.filter((i) => !created.has(i));
    expect(missing, `indexes missing: ${missing.join(', ')}`).toEqual([]);
  });

  it('has the composite / uniqueness indexes data-model.md relies on', () => {
    const created = new Set(h.indexes());
    for (const index of EXPECTED_INDEXES) {
      expect(created.has(index), `expected index ${index}`).toBe(true);
    }
  });

  it('turns foreign keys ON as part of the schema script', () => {
    expect(h.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.['foreign_keys']).toBe(1);
  });

  it('is a real file database with an empty user schema', () => {
    expect(pathExists(h.path)).toBe(true);
    const journal = h.get<{ journal_mode: string }>('PRAGMA journal_mode');
    expect(Object.keys(journal ?? {})).toContain('journal_mode');
    for (const table of USER_TABLES) expect(h.count(table), `${table} should start empty`).toBe(0);
  });
});

describe('schema: FTS5 availability on this build', () => {
  let h: TestHandle;

  beforeAll(() => {
    h = createTempDb({ meta: {} });
  });

  afterAll(() => h?.dispose());

  it('creates the ayah_search virtual table with the documented columns', () => {
    const sql = h.sqlOf('ayah_search');
    expect(sql, 'ayah_search must exist').toBeTruthy();
    expect(sql).toMatch(/fts5/i);
    expect(sql).toMatch(/remove_diacritics\s+2/i);
    const cols = h
      .all("SELECT name FROM pragma_table_info('ayah_search')")
      .map((r) => String(r['name']));
    for (const expected of ['verse_key', 'arabic', 'translation_en', 'translation_fa']) {
      expect(cols, `ayah_search column ${expected}`).toContain(expected);
    }
  });

  it('MATCH, bm25() and prefix queries execute', () => {
    h.run("INSERT INTO ayah_search (verse_key, arabic, translation_en) VALUES (?,?,?)", [
      '1:1',
      normalizedText('بِسْمِ ٱللَّهِ ٱلرَّحْمَـٰنِ ٱلرَّحِيمِ'),
      'In the name of God, the Lord of Mercy',
    ]);
    const hits = h.all<{ verse_key: string }>(
      "SELECT verse_key, bm25(ayah_search) AS score FROM ayah_search WHERE ayah_search MATCH 'merc*'",
    );
    expect(hits.map((r) => r.verse_key)).toEqual(['1:1']);
    expect(Number(hits[0]!['score'])).toBeLessThan(0);
  });

  it('does NOT make raw Uthmani searchable by a diacritic-free query — the index must be fed normalised text', () => {
    const rawUthmani = 'بِسْمِ ٱللَّهِ ٱلرَّحْمَـٰنِ ٱلرَّحِيمِ';
    h.run('DELETE FROM ayah_search WHERE verse_key = ?', ['99:1']);
    h.run('INSERT INTO ayah_search (verse_key, arabic) VALUES (?,?)', ['99:1', rawUthmani]);
    const diacriticFree = h.all<{ verse_key: string }>(
      "SELECT verse_key FROM ayah_search WHERE ayah_search MATCH 'بسم الله'",
    );
    // `unicode61 remove_diacritics 2` only strips Mn combining marks. The mushaf
    // also carries tatweel (U+0640) and alef-wasla (U+0710), which SQLite keeps,
    // so raw text silently fails a diacritic-free search. `core/src/normalize`
    // folds both — hence the write path must index `normalizedText(...)`.
    expect(diacriticFree.map((r) => r.verse_key), 'raw Uthmani must not match a normalised query').not.toContain('99:1');

    h.run('INSERT INTO ayah_search (verse_key, arabic) VALUES (?,?)', ['99:2', normalizedText(rawUthmani)]);
    const normalized = h.all<{ verse_key: string }>(
      "SELECT verse_key FROM ayah_search WHERE ayah_search MATCH 'بسم الله'",
    );
    expect(normalized.map((r) => r.verse_key)).toContain('99:2');
  });

  it('keeps UNINDEXED verse_key out of the matchable text', () => {
    h.run('DELETE FROM ayah_search WHERE verse_key = ?', ['98:1']);
    h.run('INSERT INTO ayah_search (verse_key, arabic) VALUES (?,?)', [
      '98:1',
      normalizedText('لَا إِلَٰهَ إِلَّا هُوَ'),
    ]);
    expect(normalizedText('لَا إِلَٰهَ إِلَّا هُوَ')).toBe('لا اله الا هو');
    // A bare number only occurs in the UNINDEXED key column, so it must not be
    // findable. (`'98:1'` cannot be used as the query: FTS5 reads a colon inside
    // a match expression as `column : term`, not as literal text.)
    const byKey = h.all("SELECT verse_key FROM ayah_search WHERE ayah_search MATCH '98'");
    expect(byKey).toEqual([]);
    const byWord = h.all<{ verse_key: string }>("SELECT verse_key FROM ayah_search WHERE ayah_search MATCH 'هو'");
    expect(byWord.map((r) => r.verse_key)).toEqual(['98:1']);
  });
});

describe('schema: CHECK constraints reject bad enums', () => {
  let h: TestHandle;

  beforeAll(() => {
    h = createTempDb();
    h.run(
      `INSERT INTO surah (number, name_arabic, name_simple, name_transliterated, revelation_place,
          revelation_order, ayah_count, pages_from, pages_to, first_verse_key, last_verse_key, bismillah_pre)
       VALUES (1,'الفاتحة','Al-Fatihah','Al-Fatihah','makkah',1,1,1,1,'1:1','1:1',1)`,
    );
    insertAyah(h, {
      verseKey: '1:1',
      chapter: 1,
      verse: 1,
      sourceId: 1,
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
      normalizedHash: 'deadbeefdeadbeef',
    });
  });

  afterAll(() => h?.dispose());

  it('declares a CHECK for the documented band / status / role / kind / origin enums', () => {
    const covered = new Set(checks.map((c) => `${c.table}.${c.column}`));
    for (const expected of [
      'hifz_item.band',
      'hifz_item.status',
      'anchor_word.role',
      'hifz_transition.kind',
      'confusion_group.origin',
      'surah.revelation_place',
      'surah.bismillah_pre',
      'ayah_relation.type',
      'concept_relation.type',
    ]) {
      expect(covered.has(expected), `db.sql has no CHECK on ${expected}`).toBe(true);
    }
  });

  it('rejects band = bogus on hifz_item', () => {
    expect(() => insertHifzItem(h, { verseKey: '1:1', band: 'bogus' as never })).toThrow(/CHECK constraint failed/);
    // The rejected expression must be the documented vocabulary, so a later
    // widening of `StabilityBand` cannot silently disagree with the DDL.
    const error = capture(() => insertHifzItem(h, { verseKey: '1:1', band: 'bogus' as never }));
    expect(
      isCheckFailure(error, "band IN ('new','unstable','weak','stable','mastered')"),
      `unexpected CHECK text: ${error instanceof Error ? error.message : String(error)}`,
    ).toBe(true);
  });

  it('rejects an out-of-vocabulary status on hifz_item', () => {
    expect(() => insertHifzItem(h, { verseKey: '1:1', status: 'sleeping' as never })).toThrow(
      /CHECK constraint failed/,
    );
  });

  it('rejects revelation_place = bogus on surah', () => {
    expect(() =>
      h.run(
        `INSERT INTO surah (number, name_arabic, name_simple, name_transliterated, revelation_place,
            revelation_order, ayah_count, pages_from, pages_to, first_verse_key, last_verse_key, bismillah_pre)
         VALUES (115,'x','y','z','jerusalem',115,1,1,1,'115:1','115:1',0)`,
      ),
    ).toThrow(/CHECK constraint failed/);
  });

  it('rejects bismillah_pre outside 0/1', () => {
    expect(() =>
      h.run(
        `INSERT INTO surah (number, name_arabic, name_simple, name_transliterated, revelation_place,
            revelation_order, ayah_count, pages_from, pages_to, first_verse_key, last_verse_key, bismillah_pre)
         VALUES (116,'x','y','z','makkah',116,1,1,1,'116:1','116:1',2)`,
      ),
    ).toThrow(/CHECK constraint failed/);
  });

  it('rejects an unknown anchor role, transition kind and confusion origin', () => {
    const itemId = insertHifzItem(h, { verseKey: '1:1' });
    expect(() =>
      h.run("INSERT INTO anchor_word (id, item_id, verse_key, word_position, text, role) VALUES ('aw-bad',?,'1:1',1,'ب','pivot')", [itemId]),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      h.run("INSERT INTO hifz_transition (id, item_id, verse_key, kind, to_word) VALUES ('tr-bad',?,'1:1','sideways',2)", [itemId]),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      h.run("INSERT INTO confusion_group (id, origin, created_at) VALUES ('cg-bad','imported',?)", [EPOCH_ISO]),
    ).toThrow(/CHECK constraint failed/);
    h.run('DELETE FROM hifz_item WHERE id = ?', [itemId]);
  });

  it('rejects an unknown ayah_relation type and concept_relation type', () => {
    expect(() =>
      h.run(
        `INSERT INTO ayah_relation (from_verse_key, to_verse_key, type, reason, score, produced_by)
         VALUES ('1:1','1:1','magic','test',1,'qa')`,
      ),
    ).toThrow(/CHECK constraint failed/);
    h.run("INSERT INTO concept (id, label_arabic, label_fa, label_en, description_fa, relation_type, produced_by) VALUES ('c1','ا','ب','c','d','editorial','qa')");
    expect(() =>
      h.run("INSERT INTO concept_relation (from_concept_id, to_concept_id, type, note) VALUES ('c1','c1','sibling','x')"),
    ).toThrow(/CHECK constraint failed/);
  });

  it('accepts every documented band value', () => {
    const bands = ['new', 'unstable', 'weak', 'stable', 'mastered'];
    const ids = bands.map((band, i) => insertHifzItem(h, { verseKey: '1:1', id: `band-${i}`, band: band as never }));
    expect(h.count('hifz_item', "id LIKE 'band-%'")).toBe(bands.length);
    for (const id of ids) h.run('DELETE FROM hifz_item WHERE id = ?', [id]);
  });
});

describe('schema: enum discipline promised by docs/data-model.md but not enforced by db.sql', () => {
  let h: TestHandle;

  beforeAll(() => {
    h = createTempDb();
  });

  afterAll(() => h?.dispose());

  const covered = new Set(checks.map((c) => `${c.table}.${c.column}`));

  /**
   * docs/data-model.md "Enum discipline": licence status
   * (`clear|attribution-required|unresolved`) is documented as CHECK-constrained.
   * `content_pack.license_status` has no CHECK, so a typo lands in the table and
   * `unresolved` rows — which must be hidden from reading surfaces — are not
   * distinguishable from a bad value. Failing here is the finding, not the test.
   */
  it('enforces the licence status enum on content_pack', () => {
    const accepted = capture(() =>
      h.run(
        `INSERT INTO content_pack (id, kind, version, schema_version, language, title, source,
            license_name, license_status, license_notes, attribution, checksum, payload_bytes,
            record_count, imported_at)
         VALUES ('lic-gap','translation','1',1,'en','QA probe','tests','QA','definitely-not-a-status','','','${'0'.repeat(64)}',0,0,?)`,
        [EPOCH_ISO],
      ),
    );
    if (accepted === null) h.run("DELETE FROM content_pack WHERE id = 'lic-gap'");
    expect(
      covered.has('content_pack.license_status'),
      accepted === null
        ? 'db.sql has no CHECK on content_pack.license_status and the bogus value above was accepted; docs/data-model.md lists licence status (clear|attribution-required|unresolved) as CHECK-constrained'
        : `unexpected rejection: ${accepted instanceof Error ? accepted.message : String(accepted)}`,
    ).toBe(true);
  });

  /**
   * Same document lists "relation types" among the constrained statuses;
   * `concept_ayah.type` mirrors `RelationType` and is unconstrained.
   */
  it('enforces the relation type enum on concept_ayah', () => {
    h.run("INSERT INTO surah (number, name_arabic, name_simple, name_transliterated, revelation_place, revelation_order, ayah_count, pages_from, pages_to, first_verse_key, last_verse_key, bismillah_pre) VALUES (1,'الفاتحة','Al-Fatihah','Al-Fatihah','makkah',1,1,1,1,'1:1','1:1',1)");
    h.run("INSERT INTO ayah (verse_key, chapter, verse, juz, hizb, rub_el_hizb, page, text_uthmani, word_count, normalized_hash) VALUES ('1:1',1,1,1,1,1,1,'بسم',2,'qa')");
    h.run("INSERT INTO concept (id, label_arabic, label_fa, label_en, description_fa, relation_type, produced_by) VALUES ('c-gap','ا','ب','c','d','editorial','qa')");
    const accepted = capture(() =>
      h.run("INSERT INTO concept_ayah (concept_id, verse_key, type, reason) VALUES ('c-gap','1:1','wild-guess','qa probe')"),
    );
    if (accepted === null) h.run("DELETE FROM concept_ayah WHERE concept_id = 'c-gap'");
    expect(
      covered.has('concept_ayah.type'),
      accepted === null
        ? 'concept_ayah.type accepted a value outside RelationType; ayah_relation.type and concept.relation_type are constrained but this one is not, and it decides which verses a concept surfaces'
        : `unexpected rejection: ${accepted instanceof Error ? accepted.message : String(accepted)}`,
    ).toBe(true);
  });

  /**
   * `RecallMode` (`core/src/contracts/hifz.ts`) is the vocabulary every review
   * queue suggestion and every stored attempt is written in; nothing at the
   * storage layer rejects a value outside it.
   */
  it('enforces the recall mode enum on hifz_attempt', () => {
    const itemId = insertHifzItem(h, { verseKey: '1:1' });
    const accepted = capture(() =>
      insertHifzAttempt(h, {
        itemId,
        verseKey: '1:1',
        mode: 'telepathy' as never,
        startedAt: EPOCH_ISO,
        expectedWordCount: 2,
        correctWordCount: 2,
        accuracy: 1,
      }),
    );
    if (accepted === null) h.run('DELETE FROM hifz_item WHERE id = ?', [itemId]);
    expect(
      covered.has('hifz_attempt.mode'),
      accepted === null
        ? 'hifz_attempt.mode is TEXT NOT NULL with no CHECK, so a mode outside contracts/hifz.ts RecallMode is stored silently and the scheduler reads it back as valid'
        : `unexpected rejection: ${accepted instanceof Error ? accepted.message : String(accepted)}`,
    ).toBe(true);
  });
});

describe('schema: keys, uniqueness and referential integrity', () => {
  let h: TestHandle;

  beforeAll(() => {
    h = createFixtureDb({ seedHifz: false });
  });

  afterAll(() => h?.dispose());

  it('rejects a duplicate verse_key primary key', () => {
    const first = h.get<Record<string, unknown>>('SELECT * FROM ayah ORDER BY chapter, verse LIMIT 1')!;
    const clone = rowToAyah(first);
    // A fresh (chapter, verse) that no other row occupies, so the only possible
    // conflict is the `verse_key` primary key itself — otherwise `ayah_order_idx`
    // fires first and the test proves nothing about the key.
    const freeSlot = h.get<{ chapter: number; next: number }>(
      `SELECT chapter, MAX(verse) + 1 AS next FROM ayah WHERE chapter = 2`,
    )!;
    expect(() =>
      insertAyah(h, { ...clone, chapter: Number(freeSlot.chapter), verse: Number(freeSlot.next) }),
    ).toThrow(/UNIQUE constraint failed: ayah\.verse_key/);
  });

  it('rejects the same (chapter, verse) under a different verse_key', () => {
    const sample = h.get<{ chapter: number; verse: number }>('SELECT chapter, verse FROM ayah ORDER BY chapter, verse LIMIT 1')!;
    const error = capture(() =>
      insertAyah(h, {
        verseKey: '114:7',
        chapter: Number(sample.chapter),
        verse: Number(sample.verse),
        sourceId: null,
        juz: 1,
        hizb: 1,
        rubElHizb: 1,
        sajda: null,
        ruku: null,
        manzil: null,
        page: 1,
        textUthmani: 'نص',
        textUthmaniSimple: null,
        wordCount: 1,
        normalizedHash: 'y'.repeat(16),
      }),
    );
    expect(
      isUniqueFailure(error) && /ayah\.chapter, ayah\.verse/.test(String((error as Error).message)),
      `expected the ayah_order_idx UNIQUE key to fire, got ${String((error as Error).message)}`,
    ).toBe(true);
  });

  it('allows one verse to carry two translation packs but not the same pack twice', () => {
    const packEn = h.get<{ id: string }>("SELECT id FROM content_pack WHERE kind = 'translation' AND language = 'en' LIMIT 1")!;
    h.run(
      `INSERT INTO content_pack (id, kind, version, schema_version, language, title, source,
          license_name, license_status, license_notes, attribution, checksum, payload_bytes,
          record_count, imported_at)
       VALUES ('tr-fa-999','translation','1',1,'fa','QA second Persian','tests','QA','clear','','qa',?,0,0,?)`,
      ['0'.repeat(64), EPOCH_ISO],
    );
    const verseKey = h.get<{ verse_key: string }>('SELECT verse_key FROM ayah ORDER BY chapter, verse LIMIT 1')!.verse_key;
    h.run('INSERT INTO translation (verse_key, pack_id, text) VALUES (?,?,?)', [verseKey, 'tr-fa-999', 'متن فارسی دوم']);
    expect(
      h.count('translation', 'verse_key = ?', [verseKey]),
      'one ayah may legitimately hold several packs (here: en + fa fixtures)',
    ).toBeGreaterThanOrEqual(2);
    expectRejection(
      () => h.run('INSERT INTO translation (verse_key, pack_id, text) VALUES (?,?,?)', [verseKey, packEn.id, 'dupe']),
      isUniqueFailure,
      'translation (verse_key, pack_id) composite primary key',
    );
  });

  it('requires the composite triple key on similar_ayah', () => {
    const keys = h
      .all<{ verse_key: string }>('SELECT verse_key FROM ayah WHERE verse_key LIKE ? ORDER BY chapter, verse', ['55:%'])
      .map((r) => r.verse_key);
    expect(keys.length, 'fixture must contain ar-Rahman verses for the refrain cases').toBeGreaterThanOrEqual(2);
    const [a, b] = keys;
    h.run("INSERT INTO similar_ayah (verse_key_a, verse_key_b, text_score, produced_by) VALUES (?,?,'1','qa-algo')", [a!, b!]);
    expectRejection(
      () =>
        h.run("INSERT INTO similar_ayah (verse_key_a, verse_key_b, text_score, produced_by) VALUES (?,?,'1','qa-algo')", [a!, b!]),
      isUniqueFailure,
      'similar_ayah (verse_key_a, verse_key_b, produced_by) primary key',
    );
    h.run("INSERT INTO similar_ayah (verse_key_a, verse_key_b, text_score, produced_by) VALUES (?,?,'1','qa-other')", [a!, b!]);
    expect(h.count('similar_ayah', "verse_key_a = ? AND verse_key_b = ?", [a!, b!])).toBe(2);
    h.run("DELETE FROM similar_ayah WHERE produced_by LIKE 'qa-%'");
  });

  it('enforces UNIQUE (item_id, verse_key, position) on hifz_segment', () => {
    const itemId = insertHifzItem(h, { verseKey: '1:1' });
    insertHifzSegment(h, { itemId, verseKey: '1:1', position: 0, fromWord: 1, toWord: 1, text: 'بسم' });
    expectRejection(
      () => insertHifzSegment(h, { itemId, verseKey: '1:1', position: 0, fromWord: 2, toWord: 3, text: 'الله' }),
      isUniqueFailure,
      'hifz_segment UNIQUE (item_id, verse_key, position)',
    );
    // The same position number in the next ayah is a different chunk, not a
    // duplicate — that restart per ayah is the whole reason the column exists.
    insertHifzSegment(h, { itemId, verseKey: '1:2', position: 0, fromWord: 1, toWord: 2, text: 'الرحمن' });
    expect(h.count('hifz_segment', 'item_id = ?', [itemId])).toBe(2);
    h.run('DELETE FROM hifz_item WHERE id = ?', [itemId]);
  });

  it('enforces UNIQUE (item_id, verse_key, word_position, role) on anchor_word', () => {
    const itemId = insertHifzItem(h, { verseKey: '1:1' });
    h.run("INSERT INTO anchor_word (id, item_id, verse_key, word_position, text, role) VALUES ('uq-1',?,'1:1',1,'بسم','opening')", [itemId]);
    expectRejection(
      () =>
        h.run("INSERT INTO anchor_word (id, item_id, verse_key, word_position, text, role) VALUES ('uq-2',?,'1:1',1,'بسم','opening')", [itemId]),
      isUniqueFailure,
      'anchor_word (item_id, verse_key, word_position, role) unique key',
    );
    h.run("INSERT INTO anchor_word (id, item_id, verse_key, word_position, text, role) VALUES ('uq-3',?,'1:1',1,'بسم','boundary')", [itemId]);
    // Every ayah has a word 1, so word 1 of the next ayah anchors its own row.
    h.run("INSERT INTO anchor_word (id, item_id, verse_key, word_position, text, role) VALUES ('uq-4',?,'1:2',1,'الحمد','opening')", [itemId]);
    expect(h.count('anchor_word', 'item_id = ?', [itemId])).toBe(3);
    h.run('DELETE FROM hifz_item WHERE id = ?', [itemId]);
  });

  it('refuses an ayah whose surah does not exist', () => {
    expectRejection(
      () =>
        insertAyah(h, {
          verseKey: '117:1',
          chapter: 117,
          verse: 1,
          sourceId: null,
          juz: 1,
          hizb: 1,
          rubElHizb: 1,
          sajda: null,
          ruku: null,
          manzil: null,
          page: 1,
          textUthmani: 'نص',
          textUthmaniSimple: null,
          wordCount: 1,
          normalizedHash: 'z'.repeat(16),
        }),
      isForeignKeyFailure,
      'ayah.chapter → surah.number',
    );
  });

  it('refuses a translation row pointing at an unknown pack', () => {
    const verseKey = h.get<{ verse_key: string }>('SELECT verse_key FROM ayah ORDER BY chapter, verse LIMIT 1')!.verse_key;
    expectRejection(
      () => h.run('INSERT INTO translation (verse_key, pack_id, text) VALUES (?,?,?)', [verseKey, 'tr-nope-1', 'x']),
      isForeignKeyFailure,
      'translation.pack_id → content_pack.id',
    );
  });

  it('refuses a note on a verse that does not exist, but allows a page-only bookmark', () => {
    expectRejection(
      () =>
        h.run("INSERT INTO note (id, verse_key, body, created_at, updated_at) VALUES ('n-x','478:99','ب',?,?)", [
          EPOCH_ISO,
          EPOCH_ISO,
        ]),
      isForeignKeyFailure,
      'note.verse_key → ayah.verse_key',
    );
    const pageOnlyId = insertBookmark(h, { verseKey: '1:1', page: 3, createdAt: EPOCH_ISO });
    h.run('UPDATE bookmark SET verse_key = NULL WHERE id = ?', [pageOnlyId]);
    expect(h.get<{ verse_key: unknown }>('SELECT verse_key FROM bookmark WHERE id = ?', [pageOnlyId])?.verse_key).toBeNull();
    h.run('DELETE FROM bookmark WHERE id = ?', [pageOnlyId]);
  });

  it('leaves similar_ayah without verse foreign keys, as derived data must be insertable first', () => {
    h.run("INSERT INTO similar_ayah (verse_key_a, verse_key_b, text_score, produced_by) VALUES ('777:1','777:2','0.9','qa-probe')");
    expect(h.count('similar_ayah', "verse_key_a = '777:1'")).toBe(1);
    h.run("DELETE FROM similar_ayah WHERE verse_key_a = '777:1'");
  });
});

describe('schema: cascades destroy exactly what data-model.md says', () => {
  let h: TestHandle;

  beforeAll(() => {
    h = createFixtureDb();
  });

  afterAll(() => h?.dispose());

  it('deleting a hifz_item destroys its attempts — the destructive behaviour the UI must confirm', () => {
    const item = h.get<{ id: string }>("SELECT id FROM hifz_item WHERE status = 'active' LIMIT 1")!;
    const itemId = String(item.id);
    const segmentsBefore = readHifzSegments(h, itemId);
    const attemptsBefore = readHifzAttempts(h, itemId);
    expect(segmentsBefore.length, 'fixture must have segments').toBeGreaterThan(0);
    expect(attemptsBefore.length, 'fixture must have attempts (append-only history)').toBeGreaterThanOrEqual(3);

    h.run('DELETE FROM hifz_item WHERE id = ?', [itemId]);

    expect(readHifzAttempts(h, itemId), 'hifz_attempt cascades with the item').toEqual([]);
    expect(readHifzSegments(h, itemId), 'hifz_segment cascades with the item').toEqual([]);
    expect(h.count('anchor_word', 'item_id = ?', [itemId]), 'anchor_word cascades').toBe(0);
    expect(h.count('hifz_transition', 'item_id = ?', [itemId]), 'hifz_transition cascades').toBe(0);
    // The verse itself is content and must survive the user's deletion.
    expect(h.count('ayah', 'verse_key = ?', [attemptsBefore[0]!.verseKey])).toBe(1);
  });

  it('refuses to delete a verse that a hifz_item still references', () => {
    const referenced = h.get<{ verse_key: string }>('SELECT verse_key FROM hifz_item LIMIT 1');
    if (!referenced) return; // every other case in this suite seeds an item
    expectRejection(
      () => h.run('DELETE FROM ayah WHERE verse_key = ?', [referenced.verse_key]),
      isForeignKeyFailure,
      'hifz_item.verse_key → ayah.verse_key (no cascade: content is not deletable by user action)',
    );
  });

  it('cascades confusion_group members with the group', () => {
    const group = h.get<{ id: string }>('SELECT id FROM confusion_group LIMIT 1')!;
    expect(h.count('confusion_group_item', 'group_id = ?', [String(group.id)])).toBeGreaterThan(0);
    h.run('DELETE FROM confusion_group WHERE id = ?', [String(group.id)]);
    expect(h.count('confusion_group_item', 'group_id = ?', [String(group.id)])).toBe(0);
  });

  it('cascades journey progress with the journey', () => {
    const verse = h.get<{ verse_key: string }>('SELECT verse_key FROM ayah LIMIT 1')!;
    h.run("INSERT INTO learning_journey (id, title, goal_verse_keys, started_at) VALUES ('j1','QA','[]',?)", [EPOCH_ISO]);
    h.run("INSERT INTO journey_progress (journey_id, verse_key, state, updated_at) VALUES ('j1',?,'seen',?)", [verse.verse_key, daysLater(1)]);
    expect(h.count('journey_progress', "journey_id = 'j1'")).toBe(1);
    h.run("DELETE FROM learning_journey WHERE id = 'j1'");
    expect(h.count('journey_progress', "journey_id = 'j1'")).toBe(0);
  });
});

describe('schema: derived columns and content metadata match the fixture', () => {
  let h: TestHandle;

  beforeAll(() => {
    h = createFixtureDb({ seedHifz: false });
  });

  afterAll(() => h?.dispose());

  it('stores the authoritative text byte-identical to the fixture', () => {
    // docs/testing.md rule 3: text integrity tests compare bytes. A test that
    // normalised before comparing would pass on a corrupted database.
    const expected = new Map(loadCorpusFixture().ayahs.map((a) => [a.verseKey, a.textUthmani]));
    const rows = h.all<{ verse_key: string; text_uthmani: string }>(
      'SELECT verse_key, text_uthmani FROM ayah ORDER BY chapter, verse',
    );
    expect(rows.length).toBe(expected.size);
    const drifted: string[] = [];
    for (const r of rows) {
      const want = expected.get(String(r.verse_key));
      if (want === undefined) {
        drifted.push(`${r.verse_key}: not in the fixture`);
        continue;
      }
      const got = String(r.text_uthmani);
      if (got !== want) {
        drifted.push(
          `${r.verse_key}: ${codePoints(got)} vs fixture ${codePoints(want)}`,
        );
      }
    }
    expect(drifted, `stored text differs from the fixture: ${drifted.join(' | ')}`).toEqual([]);
  });

  it('keeps ayah.word_count equal to the tokenised length of the stored text', () => {
    const rows = h.all<{ verse_key: string; text_uthmani: string; word_count: number }>('SELECT verse_key, text_uthmani, word_count FROM ayah');
    for (const r of rows) {
      expect(normalizedText(String(r.text_uthmani)).split(' ').length, `word_count of ${r.verse_key}`).toBe(Number(r.word_count));
    }
  });

  it('stores one ayah_word row per provider token, marks included, positions unique', () => {
    const verseKey = h.get<{ verse_key: string }>("SELECT verse_key FROM ayah WHERE verse_key = '1:1'")!.verse_key;
    const rows = h.all<{ position: number; normalized: string; is_end_of_ayah_mark: number }>(
      'SELECT position, normalized, is_end_of_ayah_mark FROM ayah_word WHERE verse_key = ? ORDER BY position',
      [verseKey],
    );
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(new Set(rows.map((r) => Number(r.position))).size).toBe(rows.length);
    expect(rows.some((r) => Number(r.is_end_of_ayah_mark) === 1)).toBe(true);
    expect(rows.every((r) => typeof r.normalized === 'string')).toBe(true);
  });

  it('carries both bundled translations and the tafsir pack the fixture imported', () => {
    expect(h.count('content_pack')).toBeGreaterThanOrEqual(3);
    expect(h.count('translation')).toBeGreaterThanOrEqual(30);
    expect(h.count('tafsir')).toBeGreaterThan(0);
    const fa = h.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM translation t JOIN content_pack p ON p.id = t.pack_id WHERE p.language = 'fa'",
    );
    expect(Number(fa?.n ?? 0)).toBeGreaterThan(0);
  });

  it('proves the provider captures QA relies on are still on disk', () => {
    // Without them the full-corpus specs and the performance numbers cannot be
    // reproduced, so a missing capture is a hard failure, not a silent skip.
    for (const f of ['chapters.json', 'verses-uthmani.json', 'divisions-55.json']) {
      expect(pathExists(rawFile(f)), `data/raw/quran-com/${f}`).toBe(true);
    }
  });
});
