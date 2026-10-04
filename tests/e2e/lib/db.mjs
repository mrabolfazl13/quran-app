/**
 * tests/e2e/lib/db.mjs — read-only look at the database the app itself wrote.
 *
 * This is database-level evidence, taken from the shipped binary's own file, not
 * from a test fixture: the app keeps `quran.db` in its app-data directory and we
 * open it `readOnly: true` while it runs (the same trick used by the scratch
 * drivers in %TEMP% that proved these numbers). The harness NEVER writes to this
 * file — anything the journey claims to have done must have been done through
 * the UI, and the DB is only the witness.
 *
 * Notes from `tests/helpers/db.ts`, which this mirrors:
 *  - node:sqlite throws on `undefined`/boolean bind values → `toBindable` here.
 *  - FTS5 shadow tables are not data; `*_content`, `*_docsize`, `*_idx`,
 *    `*_data`, `*_config` are filtered out of row counts.
 */

import { DatabaseSync } from 'node:sqlite';

const SHADOW = /_content$|_docsize$|_idx$|_data$|_config$/;

function toBindable(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

export function openReadOnly(dbPath) {
  return new ReadOnlyDb(dbPath);
}

export class ReadOnlyDb {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath, { readOnly: true });
  }

  count(table) {
    if (!/^[a-z_]+$/.test(table)) throw new TypeError(`unsafe table identifier: ${table}`);
    return Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
  }

  get(sql, params = []) {
    return this.db.prepare(sql).get(...params.map(toBindable));
  }

  all(sql, params = []) {
    return this.db.prepare(sql).all(...params.map(toBindable));
  }

  /** Content rows the importer is supposed to have landed. */
  contentCounts() {
    return {
      surahs: this.count('surah'),
      ayahs: this.count('ayah'),
      words: this.count('ayah_word'),
      translations: this.count('translation'),
      tafsirs: this.count('tafsir'),
      similar: this.count('similar_ayah'),
      packs: this.count('content_pack'),
    };
  }

  userCounts() {
    return {
      bookmarks: this.count('bookmark'),
      notes: this.count('note'),
      hifzItems: this.count('hifz_item'),
      segments: this.count('hifz_segment'),
      anchors: this.count('anchor_word'),
      transitions: this.count('hifz_transition'),
      attempts: this.count('hifz_attempt'),
      sessions: this.count('hifz_session'),
      confusionGroups: this.count('confusion_group'),
      confusionItems: this.count('confusion_group_item'),
      dailyPlans: this.count('daily_plan'),
    };
  }

  /** The `ImportReport` the gateway stores with the rows it applied. */
  importReport() {
    const row = this.get("SELECT value FROM meta WHERE key = 'last_import_json'");
    return row ? JSON.parse(String(row.value)) : null;
  }

  /** Translation rows for one verse key, per pack — byte-for-byte references. */
  translationsFor(verseKey) {
    return this.all('SELECT pack_id, text FROM translation WHERE verse_key = ? ORDER BY pack_id', [verseKey]);
  }

  tafsirFor(verseKey) {
    return this.all(
      'SELECT t.verse_key, t.pack_id, t.text, t.covers_verse_keys, p.title FROM tafsir t ' +
        'LEFT JOIN content_pack p ON p.id = t.pack_id WHERE t.verse_key = ? ORDER BY t.pack_id',
      [verseKey],
    );
  }

  wordsFor(verseKey) {
    return this.all(
      'SELECT position, text_uthmani, is_end_of_ayah_mark FROM ayah_word WHERE verse_key = ? ORDER BY position',
      [verseKey],
    );
  }

  ayah(verseKey) {
    return this.get('SELECT verse_key, chapter, verse, page, juz, text_uthmani, word_count FROM ayah WHERE verse_key = ?', [verseKey]);
  }

  surahAyahKeys(number) {
    return this.all('SELECT verse_key FROM ayah WHERE chapter = ? ORDER BY verse', [number]).map((r) => String(r.verse_key));
  }

  /** The verse key with the most stored similar-ayah partners. */
  busiestSimilarKey() {
    const row = this.get(
      'SELECT verse_key_a AS verseKey, COUNT(*) AS pairs FROM similar_ayah GROUP BY verse_key_a ORDER BY pairs DESC, verse_key_a LIMIT 1',
    );
    return row ? { verseKey: String(row.verseKey), pairs: Number(row.pairs) } : null;
  }

  similarPairs(verseKey) {
    return this.all(
      'SELECT CASE WHEN verse_key_a = ? THEN verse_key_b ELSE verse_key_a END AS partner, text_score AS textScore ' +
        'FROM similar_ayah WHERE verse_key_a = ? OR verse_key_b = ? ORDER BY text_score DESC, partner',
      [verseKey, verseKey, verseKey],
    ).map((r) => ({ partner: String(r.partner), textScore: Number(r.textScore) }));
  }

  packTitle(packId) {
    const row = this.get('SELECT title FROM content_pack WHERE id = ?', [packId]);
    return row ? String(row.title) : null;
  }

  /** Any verse key that has a passage in a given tafsir pack. */
  verseKeyWithTafsir(packId) {
    const row = this.get('SELECT verse_key FROM tafsir WHERE pack_id = ? ORDER BY verse_key LIMIT 1', [packId]);
    return row ? String(row.verse_key) : null;
  }

  /** The engine's segment rows: a segment must always cover at least one word. */
  segments() {
    return this.all(
      `SELECT id, item_id, verse_key, position, from_word, to_word,
              length(text) AS text_length
         FROM hifz_segment
        ORDER BY item_id, verse_key, position`,
    );
  }

  hifzItem(verseKey) {
    return this.get('SELECT * FROM hifz_item WHERE verse_key = ?', [verseKey]);
  }

  hifzItems() {
    return this.all('SELECT id, verse_key, band, stability, error_count, attempt_count, next_review_at FROM hifz_item ORDER BY verse_key');
  }

  attempts(itemId = null) {
    const rows = itemId
      ? this.all('SELECT id, item_id, verse_key, mode, accuracy, expected_word_count, correct_word_count, produced, errors, duration_ms FROM hifz_attempt WHERE item_id = ? ORDER BY started_at, id', [itemId])
      : this.all('SELECT id, item_id, verse_key, mode, accuracy, expected_word_count, correct_word_count, produced, errors, duration_ms FROM hifz_attempt ORDER BY started_at, id');
    return rows.map((r) => ({
      id: String(r.id),
      itemId: String(r.item_id),
      verseKey: String(r.verse_key),
      mode: String(r.mode),
      accuracy: Number(r.accuracy),
      expectedWordCount: Number(r.expected_word_count),
      correctWordCount: Number(r.correct_word_count),
      produced: String(r.produced),
      errors: String(r.errors),
      durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
    }));
  }

  /** Everything the restore comparison needs, keyed by primary value. */
  userSnapshot() {
    const table = (name, order = 'rowid') => this.all(`SELECT * FROM ${name} ORDER BY ${order}`);
    // `verse_key` before the position column: `position` restarts inside each ayah,
    // so ordering by it alone interleaves the two ayat of one item. TEXT order would
    // sort `2:10` between `2:1` and `2:2`, so both halves of the key are cast.
    const ayah = "(CAST(substr(verse_key, 1, instr(verse_key, ':') - 1) AS INTEGER), CAST(substr(verse_key, instr(verse_key, ':') + 1) AS INTEGER))";
    const fingerprint = (column) => `item_id, ${ayah}, ${column}`;
    return {
      bookmark: table('bookmark', 'verse_key'),
      note: table('note', 'verse_key'),
      hifz_item: table('hifz_item', 'verse_key'),
      hifz_segment: table('hifz_segment', fingerprint('position')),
      anchor_word: table('anchor_word', fingerprint('word_position')),
      hifz_transition: table('hifz_transition', fingerprint('to_word')),
      hifz_attempt: table('hifz_attempt', 'started_at, id'),
      confusion_group: table('confusion_group', 'id'),
      confusion_group_item: table('confusion_group_item', 'group_id, position'),
      settings: table('settings', 'key'),
    };
  }

  tables() {
    return this.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .map((r) => String(r.name))
      .filter((name) => !SHADOW.test(name) && !name.startsWith('sqlite_'));
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}
