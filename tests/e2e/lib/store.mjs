/**
 * tests/e2e/lib/store.mjs — one read-only witness interface, two implementations.
 *
 * The journey must not fork per shell, so both stores answer the same questions
 * with the same row shapes:
 *
 *  - `sqliteStore` (desktop): opens the shipped binary's own `quran.db` read-only
 *    while the app runs. Content and user rows are all DATABASE evidence.
 *  - `browserStore` (web/dev): reads the shell's own IndexedDB blob (`v1` in
 *    `quran-dev-shell/userdata`) and its backup index in localStorage, from inside
 *    the page over CDP. Those are the rows the app wrote, so they are DATABASE
 *    evidence too. Content has no browser-side store: the web shell keeps the
 *    packs in memory, so the reference for content rows comes from the pack files
 *    on disk — PIPELINE evidence, and every step that needs a content COUNT from
 *    the app's own store is reported as SKIP instead of being answered from files.
 *
 * `supports(feature)` is how a step decides to skip honestly; `unsupportedReason`
 * is printed in the report so the skip is auditable, never silent.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { openReadOnly } from './db.mjs';
import { PackSource } from './packs.mjs';

/** Features a step may need; each implementation says yes/no with a reason. */
export const FEATURES = [
  'importReport',
  'contentCounts',
  'surahAyahKeys',
  'translationsFor',
  'wordsFor',
  'tafsirFor',
  'similarPairs',
  'bookmarkRow',
  'noteRow',
  'hifzItem',
  'segments',
  'attempts',
  'confusionGroupRow',
  'userCounts',
  'userSnapshot',
  'readBackup',
  'searchHits',
];

class Base {
  constructor() {
    this.kind = 'base';
    this.missing = new Set();
    this.unsupportedReason = '';
  }

  supports(feature) {
    if (this.missing.has(feature)) {
      this.unsupportedReason = `${this.kind} store has no “${feature}”: ${this.reasonFor(feature)}`;
      return false;
    }
    this.unsupportedReason = '';
    return true;
  }

  reasonFor(feature) {
    return `not implemented`;
  }

  /** Wrap a feature call so a missing witness throws a clear, catchable error. */
  need(feature) {
    if (!this.supports(feature)) throw new Error(this.unsupportedReason);
  }
}

/* ------------------------------------------------------------------ sqlite */

export class SqliteStore extends Base {
  /** @param {{dbPath: string, backupsDir?: string}} */
  constructor({ dbPath, backupsDir = null }) {
    super();
    this.kind = 'sqlite';
    this.dbPath = dbPath;
    this.backupsDir = backupsDir;
  }

  open() {
    if (!existsSync(this.dbPath)) throw new Error(`no database at ${this.dbPath} yet — the app creates it on first import`);
    return openReadOnly(this.dbPath);
  }

  /**
   * Each read opens its own handle and closes it immediately. The app is writing
   * concurrently, so a long-lived read handle would either pin the file open
   * (cleanup then fails with EPERM) or serve a stale snapshot.
   */
  withDb(fn) {
    const db = this.open();
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  async contentCounts() {
    return this.withDb((db) => db.contentCounts());
  }

  async userCounts() {
    return this.withDb((db) => ({ ...db.userCounts(), packs: db.count('content_pack') }));
  }

  async importReport() {
    return this.withDb((db) => db.importReport());
  }

  async surahAyahKeys(chapter) {
    return this.withDb((db) => db.surahAyahKeys(chapter));
  }

  async translationsFor(verseKey) {
    return this.withDb((db) => db.translationsFor(verseKey));
  }

  async tafsirFor(verseKey) {
    return this.withDb((db) => db.tafsirFor(verseKey));
  }

  async wordsFor(verseKey) {
    return this.withDb((db) => db.wordsFor(verseKey));
  }

  async verseKeyWithTafsir(packId) {
    return this.withDb((db) => db.verseKeyWithTafsir(packId));
  }

  async busiestSimilarKey() {
    return this.withDb((db) => db.busiestSimilarKey());
  }

  async similarPairs(verseKey) {
    return this.withDb((db) => db.similarPairs(verseKey));
  }

  async hifzItem(verseKey) {
    const row = this.withDb((db) => db.hifzItem(verseKey));
    return row ? { ...row, band: String(row.band), attempt_count: Number(row.attempt_count), error_count: Number(row.error_count) } : null;
  }

  async hifzItems() {
    return this.withDb((db) => db.hifzItems());
  }

  async segments() {
    return this.withDb((db) => db.segments());
  }

  async attempts() {
    return this.withDb((db) => db.attempts());
  }

  async bookmarkRow(verseKey) {
    return this.withDb((db) => db.get('SELECT * FROM bookmark WHERE verse_key = ?', [verseKey]));
  }

  async noteRow(verseKey) {
    return this.withDb((db) => db.get('SELECT * FROM note WHERE verse_key = ? ORDER BY updated_at DESC', [verseKey]));
  }

  async confusionGroupRow() {
    return this.withDb((db) => db.get('SELECT * FROM confusion_group ORDER BY id LIMIT 1'));
  }

  async userSnapshot() {
    return this.withDb((db) => db.userSnapshot());
  }

  async readBackup(name) {
    if (!this.backupsDir) throw new Error('the backups directory was never reported by app_paths');
    const file = path.join(this.backupsDir, name);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  }

  async searchHits(query) {
    // FTS5 with the tokenizer the schema declares; the phrase form keeps the
    // Persian word intact instead of splitting it into prefixes.
    return this.withDb((db) => {
      const row = db.get('SELECT COUNT(*) AS n FROM (SELECT verse_key FROM ayah_search WHERE ayah_search MATCH ? GROUP BY verse_key)', [`"${String(query).replace(/"/g, '')}"`]);
      return row ? Number(row.n) : 0;
    });
  }

  reasonFor(feature) {
    return `the SQLite witness reads only ${feature === 'readBackup' ? 'the backups directory' : 'tables'}; ${feature} needs ${this.dbPath}`;
  }
}

/* ------------------------------------------------------------------ browser */

/** One async expression evaluated in the page; `awaitPromise` makes IDB legal. */
const idbRead = (key) => `(async function(){
  return await new Promise((resolve) => {
    try {
      const open = indexedDB.open('quran-dev-shell', 1);
      open.onsuccess = () => {
        const db = open.result;
        try {
          const tx = db.transaction('userdata', 'readonly');
          const req = tx.objectStore('userdata').get(${JSON.stringify(key)});
          req.onsuccess = () => { resolve(req.result ?? null); db.close(); };
          req.onerror = () => { resolve(null); db.close(); };
        } catch { resolve(null); }
      };
      open.onerror = () => resolve(null);
      open.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
})()`;

export class BrowserStore extends Base {
  /** @param {{cdp: import('./cdp.mjs').Cdp, packs?: PackSource}} */
  constructor({ cdp, packs = new PackSource() }) {
    super();
    this.kind = 'browser';
    this.cdp = cdp;
    this.packs = packs;
    // Content row counts are not stored anywhere in a browser shell; the importer's
    // own bookkeeping (importReport) is, and the user rows are.
    this.missing = new Set(['contentCounts']);
  }

  /**
   * Read the persisted blob only once it has stopped changing.
   *
   * The browser gateway writes IndexedDB on a 350 ms debounce after its last
   * mutation (`devGateway.touch()`), so a read taken right after a click sees the
   * blob as it was *before* the click. Asserting on that reported a stored
   * bookmark, note and hifz item as absent — a witness race, not an app defect,
   * and exactly the kind of failure a test must not paper over by loosening the
   * assertion. Two consecutive identical snapshots 700 ms apart can only happen
   * when nothing is pending: a scheduled write would land inside that window and
   * make the snapshots differ. A row that really was never written still fails,
   * just after the wait.
   */
  async user() {
    const deadline = Date.now() + 12_000;
    let last = null;
    let stable = 0;
    for (;;) {
      const raw = await this.cdp.evaluate(idbRead('v1'));
      const text = raw === null || raw === undefined ? '' : JSON.stringify(raw);
      stable = text === last ? stable + 1 : 0;
      last = text;
      if (stable >= 1) break;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    if (!last) throw new Error('the browser shell has written no user data blob yet (IndexedDB quran-dev-shell/userdata/v1 is empty)');
    return JSON.parse(last);
  }

  async contentCounts() {
    throw new Error(this.supports('contentCounts') ? 'unreachable' : this.unsupportedReason);
  }

  async userCounts() {
    const user = await this.user();
    return {
      bookmarks: user.bookmarks.length,
      notes: user.notes.length,
      hifzItems: user.hifzItems.length,
      segments: user.segments.length,
      anchors: user.anchors.length,
      transitions: user.transitions.length,
      attempts: user.attempts.length,
      sessions: user.sessions.length,
      confusionGroups: user.groups.length,
      confusionItems: user.groups.reduce((sum, group) => sum + (group.verseKeys?.length ?? 0), 0),
      dailyPlans: user.plans.length,
    };
  }

  async importReport() {
    const user = await this.user();
    return user.importReport ?? null;
  }

  async surahAyahKeys(chapter) {
    return this.packs.surahAyahKeys(chapter);
  }

  async translationsFor(verseKey) {
    return this.packs.translationsFor(verseKey);
  }

  async tafsirFor(verseKey) {
    return this.packs.tafsirFor(verseKey);
  }

  async wordsFor(verseKey) {
    return this.packs.wordsFor(verseKey);
  }

  async verseKeyWithTafsir(packId) {
    return this.packs.verseKeyWithTafsir(packId);
  }

  async busiestSimilarKey() {
    return this.packs.busiestSimilarKey();
  }

  async similarPairs(verseKey) {
    return this.packs.similarPairs(verseKey);
  }

  async hifzItem(verseKey) {
    const item = (await this.user()).hifzItems.find((row) => String(row.verseKey) === String(verseKey)) ?? null;
    return item ? { ...item, band: String(item.band), attempt_count: Number(item.attemptCount), error_count: Number(item.errorCount) } : null;
  }

  async hifzItems() {
    return (await this.user()).hifzItems.map((item) => ({
      id: String(item.id),
      verse_key: String(item.verseKey),
      band: String(item.band),
      stability: Number(item.stability),
      error_count: Number(item.errorCount),
      attempt_count: Number(item.attemptCount),
      next_review_at: item.nextReviewAt ?? null,
    }));
  }

  async segments() {
    const user = await this.user();
    // `v3`: the row names its own ayah. Reading it off the item instead is what
    // made a two-ayah item's second chunk look like the first chunk's neighbour.
    return user.segments.map((row) => ({
      id: String(row.id),
      item_id: String(row.itemId),
      position: Number(row.position),
      from_word: Number(row.fromWord),
      to_word: Number(row.toWord),
      text_length: String(row.text ?? '').length,
      verse_key: String(row.verseKey ?? ''),
    }));
  }

  async attempts() {
    return (await this.user()).attempts.map((row) => ({
      id: String(row.id),
      itemId: String(row.itemId),
      verseKey: String(row.verseKey),
      mode: String(row.mode),
      accuracy: Number(row.accuracy),
      expectedWordCount: Number(row.expectedWordCount),
      correctWordCount: Number(row.correctWordCount),
      // The browser shell keeps these as objects; SQLite keeps the same JSON.
      produced: JSON.stringify(row.produced ?? []),
      errors: JSON.stringify(row.errors ?? []),
      durationMs: row.durationMs ?? null,
    }));
  }

  async bookmarkRow(verseKey) {
    return (await this.user()).bookmarks.find((row) => String(row.verseKey) === String(verseKey)) ?? null;
  }

  async noteRow(verseKey) {
    const rows = (await this.user()).notes.filter((row) => String(row.verseKey) === String(verseKey));
    return rows.length ? rows[rows.length - 1] : null;
  }

  async confusionGroupRow() {
    const groups = (await this.user()).groups;
    return groups.length ? groups[groups.length - 1] : null;
  }

  /**
   * Same table names as the SQLite snapshot, same snake_case columns, so the
   * restore comparison in journey.mjs is one code path for both shells.
   */
  async userSnapshot() {
    const user = await this.user();
    const snake = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [camelToSnake(k), typeof v === 'object' && v !== null ? JSON.stringify(v) : v]));
    return {
      bookmark: user.bookmarks.map(snake),
      note: user.notes.map(snake),
      hifz_item: user.hifzItems.map(snake).sort(byKey('verse_key')),
      hifz_segment: user.segments.map(snake).sort(byKey('item_id')),
      anchor_word: user.anchors.map(snake).sort(byKey('item_id')),
      hifz_transition: user.transitions.map(snake).sort(byKey('item_id')),
      hifz_attempt: user.attempts.map(snake).sort(byKey('started_at')),
      confusion_group: user.groups.map(snake).sort(byKey('id')),
      confusion_group_item: user.groups.flatMap((group) => (group.verseKeys ?? []).map((verseKey, position) => ({ group_id: String(group.id), position, verse_key: String(verseKey) }))).sort(byKey('group_id')),
      settings: Object.entries(user.settings).map(([key, value]) => ({ key, value })),
    };
  }

  async readBackup(name) {
    const index = await this.cdp.evaluate(`(function(){try{return JSON.parse(window.localStorage.getItem('quran.backups')||'{}');}catch{return {};}})()`);
    const entry = index?.[name];
    return entry && typeof entry.json === 'string' ? entry.json : null;
  }

  /**
   * The browser shells search an in-memory index built from the shipped packs, so
   * the honest upper bound is the pack text itself — pipeline reference, not a
   * stored index. The journey only compares `rendered <= stored`, which this is.
   */
  async searchHits(query) {
    return this.packs.searchHits(query);
  }

  reasonFor(feature) {
    if (feature === 'contentCounts') {
      return 'the web shell holds the content packs in memory and writes no content table; content counts are proven from the app’s own store in desktop mode';
    }
    return `${feature} is not reachable from the browser store`;
  }
}

function camelToSnake(name) {
  return name.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}

function byKey(field) {
  return (a, b) => String(a[field] ?? '').localeCompare(String(b[field] ?? ''));
}

/** Pick the witness for the shell this run drives. */
export function makeStore({ shell, dbPath = null, backupsDir = null, cdp }) {
  return shell === 'desktop'
    ? new SqliteStore({ dbPath, backupsDir })
    : new BrowserStore({ cdp, packs: new PackSource() });
}
