/**
 * TauriGateway — the shipped data path.
 *
 * SQLite runs in the Rust layer (`tauri-plugin-sql` with the `sqlite` feature);
 * this module is the only place that writes SQL. Reads return contract-shaped
 * objects.
 *
 * Every statement — reads included — goes through one promise queue, and that
 * is a correctness requirement, not a performance choice. The plugin runs each
 * `execute()`/`select()` as `pool.<statement>()`: it checks a connection out of
 * a sqlx pool sized to the CPU count, runs one statement on it, then hands the
 * connection back. So two overlapping calls can land on two different SQLite
 * connections, and a `BEGIN … COMMIT` spread over separate calls is then not a
 * transaction at all: the `BEGIN` is on connection A and the inserts are on
 * connection B. Measured on the installed app with one click and no external
 * reader — the app's own concurrent `COUNT(*)` reads were enough — the import
 * died with `(code: 5) database is locked`, the `ROLLBACK` reported
 * `no transaction is active`, and a partial content table was left behind.
 *
 * Serialising the calls makes the pool never need a second connection: with one
 * statement in flight at a time sqlx reuses the same connection, so a manual
 * transaction spanning `db.execute()` calls becomes real again. Inside an
 * enqueued task, use `rawClient()` — the queued client would re-enter the queue
 * behind the very task it is running in and deadlock.
 */
import Database from '@tauri-apps/plugin-sql';
import { invoke } from '@tauri-apps/api/core';
import type {
  AnchorWord,
  AyahRelation,
  BackupEnvelope,
  Bookmark,
  ConfusionGroup,
  HifzItem,
  HifzItemStatus,
  HifzSegment,
  HifzSession,
  HifzTransition,
  MigrationResult,
  Note,
  ReadingHistoryEntry,
  ReadingPosition,
  RecallAttempt,
  SimilarAyahPair,
  Surah,
  VerseKey,
} from '@quran/core';
import { BACKUP_SCHEMA_VERSION, buildEnvelope, canonicalJsonStringify, computeDataChecksum, serializeEnvelope } from '@quran/core';
import { ensureSchema, META_KEYS, SCHEMA_VERSION, type SqlClient } from '../db/schema';
import { insertRows } from './batchInsert';
import { buildImportPlan } from '../content/importer';
import {
  createTauriPackSource,
  type PackSource,
  type TauriInvoke,
} from '../content/packSource';
import {
  SEARCH_INDEX_VERSION,
  SqliteSearchService,
  buildSearchIndexRows,
  collectRawSearchDocs,
  ensureSearchIndexForm,
  writeSearchIndexRows,
  type SearchService,
} from './search';
import type {
  AyahRow,
  AyahWordRow,
  BookmarkInput,
  ContentCounts,
  ContentPlan,
  GatewayInfo,
  HomeStats,
  ImportReport,
  JuzSummary,
  NoteInput,
  PackRow,
  SearchHit,
  SearchNoteId,
  SearchOptions,
  TafsirRow,
  TranslationOption,
} from './types';
import type { DataGateway } from './types';

const DB_FILE = 'sqlite:quran.db';

function v(v: VerseKey): [number, number] {
  const [c, a] = v.split(':');
  return [Number(c), Number(a)];
}

interface DbSurah {
  number: number;
  name_arabic: string;
  name_simple: string;
  name_transliterated: string;
  translation_fa: string | null;
  translation_en: string | null;
  revelation_place: 'makkah' | 'madinah';
  revelation_order: number;
  ayah_count: number;
  pages_from: number;
  pages_to: number;
  first_verse_key: string;
  last_verse_key: string;
  bismillah_pre: number;
}

interface DbAyah {
  verse_key: string;
  chapter: number;
  verse: number;
  source_id: number | null;
  juz: number;
  hizb: number;
  rub_el_hizb: number;
  sajda: number | null;
  ruku: number | null;
  manzil: number | null;
  page: number;
  text_uthmani: string;
  text_uthmani_simple: string | null;
  word_count: number;
  normalized_hash: string;
}

interface DbWord {
  id: number;
  verse_key: string;
  position: number;
  page_number: number;
  line_number: number;
  text_uthmani: string;
  translation_en: string | null;
  transliteration: string | null;
  root: string | null;
  morphology: string | null;
  is_end_of_ayah_mark: number;
  normalized: string;
}

interface DbPack {
  id: string;
  kind: string;
  version: string;
  schema_version: number;
  language: string;
  title: string;
  source: string;
  license_name: string;
  license_spdx: string | null;
  license_status: string;
  license_notes: string;
  attribution: string;
  checksum: string;
  payload_bytes: number;
  record_count: number;
  imported_at: string;
}

function surahFrom(row: DbSurah): Surah {
  return {
    number: row.number,
    nameArabic: row.name_arabic,
    nameSimple: row.name_simple,
    nameTransliterated: row.name_transliterated,
    translationFa: row.translation_fa,
    translationEn: row.translation_en,
    revelationPlace: row.revelation_place,
    revelationOrder: row.revelation_order,
    ayahCount: row.ayah_count,
    pagesFrom: row.pages_from,
    pagesTo: row.pages_to,
    firstVerseKey: row.first_verse_key as VerseKey,
    lastVerseKey: row.last_verse_key as VerseKey,
    bismillahPre: row.bismillah_pre === 1,
  };
}

function ayahFrom(row: DbAyah): AyahRow {
  return {
    verseKey: row.verse_key as VerseKey,
    chapter: row.chapter,
    verse: row.verse,
    sourceId: row.source_id,
    juz: row.juz,
    hizb: row.hizb,
    rubElHizb: row.rub_el_hizb,
    sajda: row.sajda,
    ruku: row.ruku,
    manzil: row.manzil,
    page: row.page,
    textUthmani: row.text_uthmani,
    textUthmaniSimple: row.text_uthmani_simple,
    wordCount: row.word_count,
    normalizedHash: row.normalized_hash,
  };
}

function wordFrom(row: DbWord): AyahWordRow {
  return {
    id: row.id,
    verseKey: row.verse_key as VerseKey,
    position: row.position,
    pageNumber: row.page_number,
    lineNumber: row.line_number,
    textUthmani: row.text_uthmani,
    translationEn: row.translation_en,
    transliteration: row.transliteration,
    root: row.root,
    morphology: row.morphology,
    isEndOfAyahMark: row.is_end_of_ayah_mark === 1,
    normalized: row.normalized,
  };
}

function attributionFrom(raw: string, row: { id: string; title: string; imported_at?: string }): PackRow['attribution'] {
  try {
    return JSON.parse(raw) as PackRow['attribution'];
  } catch {
    // A malformed attribution must not hide the pack from the licence screen.
    return {
      publisher: '(unreadable attribution record)',
      work: row.title,
      edition: null,
      sourceUrl: '',
      retrievedAt: row.imported_at ?? '',
      creditLine: raw,
    };
  }
}

function packFrom(row: DbPack): PackRow {
  const attribution = attributionFrom(row.attribution, row);
  return {
    id: row.id,
    kind: row.kind as PackRow['kind'],
    version: row.version,
    schemaVersion: row.schema_version,
    language: row.language,
    title: row.title,
    source: row.source,
    licenseName: row.license_name,
    licenseSpdx: row.license_spdx,
    licenseStatus: row.license_status as PackRow['licenseStatus'],
    licenseNotes: row.license_notes,
    attribution,
    checksum: row.checksum,
    payloadBytes: row.payload_bytes,
    recordCount: row.record_count,
    importedAt: row.imported_at,
  };
}

const CONTENT_TABLES = [
  'ayah_search',
  'audio_track',
  'concept_relation',
  'concept_ayah',
  'concept',
  'ayah_relation',
  'similar_ayah',
  'tafsir',
  'translation',
  'ayah_word',
  'ayah',
  'surah',
  'content_pack',
];

export class TauriGateway implements DataGateway {
  readonly mode = 'tauri' as const;

  private db: Database | null = null;
  private raw_: SqlClient | null = null;
  private sqlClient: SqlClient | null = null;
  private source: PackSource | null = null;
  private searchService: SearchService | null = null;
  private schema: Awaited<ReturnType<typeof ensureSchema>> | null = null;
  private contentRoot: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * Run `task` only after every previously queued statement has finished.
   * See the module header: this is what keeps the plugin's connection pool at a
   * single connection, and therefore what makes cross-call transactions real.
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private require(): Database {
    if (!this.db) throw new Error('database is not open yet');
    return this.db;
  }

  async info(): Promise<GatewayInfo> {
    const paths = await invoke<{ appData: string; backups: string; contentRoot: string | null }>('app_paths');
    this.contentRoot = paths.contentRoot;
    return {
      mode: 'tauri',
      labelId: 'tauri-sqlite',
      storeId: 'sqlite-file',
      databasePath: `${paths.appData}\\quran.db`,
      contentRoot: paths.contentRoot,
      schemaVersion: this.schema?.version ?? SCHEMA_VERSION,
      searchBackend: (await this.searchBackend()) as GatewayInfo['searchBackend'],
      isShippedPath: true,
    };
  }

  async ready(): Promise<void> {
    if (this.db) return;
    const db = await Database.load(DB_FILE);
    this.db = db;
    const raw: SqlClient = {
      select: <TRow>(sql: string, params?: unknown[]) => db.select<TRow>(sql, params),
      execute: (sql: string, params?: unknown[]) => db.execute(sql, params).then((r) => r.rowsAffected),
    };
    this.raw_ = raw;
    this.sqlClient = this.queued(raw);
    const client = this.sqlClient;
    // `PRAGMA foreign_keys` is a per-connection setting: `db.sql` issues it only
    // when the file is created. Re-asserting it on every open is what makes the
    // RESTRICT rules the content/reset paths rely on real for an existing
    // database — and it sticks because the queue keeps the plugin on one
    // connection instead of letting a later statement run somewhere else.
    await client.execute('PRAGMA foreign_keys = ON');
    this.schema = await ensureSchema(client, DB_FILE);
    this.source = createTauriPackSource(invoke as TauriInvoke, this.contentRoot);
    this.searchService = await this.pickSearch(client);
    await this.ensureSearchIndexKeyForm();
    await this.ensureProfile();
  }

  /** Wrap an unqueued client so every statement waits for the one before it. */
  private queued(raw: SqlClient): SqlClient {
    return {
      select: <TRow>(sql: string, params?: unknown[]) => this.enqueue(() => raw.select<TRow>(sql, params)),
      execute: (sql: string, params?: unknown[]) => this.enqueue(() => raw.execute(sql, params)),
    };
  }

  /**
   * The shipped path keeps the corpus in SQLite and searches it there, so the
   * 78k word rows never have to be materialised in the webview.
   *
   * `core/src/search` is not a second backend running here: what this app takes
   * from it is its matching space (`matchKey` / `matchTokens`), which is what
   * the `ayah_search` columns and the query are both written in. The dev shell
   * (`devGateway.ts`) holds the same keys in memory instead of in SQLite.
   */
  private async pickSearch(client: SqlClient): Promise<SearchService> {
    const backend = this.schema?.searchBackend === 'fts5' ? 'sqlite-fts5' : 'like';
    const noteId = backend === 'sqlite-fts5' ? 'fts5-order-plus-substring' : 'fts5-unavailable';
    return new SqliteSearchService(client, backend, noteId);
  }

  /**
   * Self-heal a stale derived search index on the way up. The whole rule lives
   * in `ensureSearchIndexForm` (`gateway/search.ts`), which the integration
   * suite exercises against a real SQLite file; this is the serialised call site.
   */
  private async ensureSearchIndexKeyForm(): Promise<void> {
    await this.enqueue(() => ensureSearchIndexForm(this.rawClient()));
  }

  async close(): Promise<void> {
    await this.enqueue(async () => {
      await this.db?.close();
      this.db = null;
      this.sqlClient = null;
      this.raw_ = null;
    });
  }

  private client(): SqlClient {
    if (!this.sqlClient) throw new Error('database is not open yet');
    return this.sqlClient;
  }

  /**
   * The unqueued client, for use *inside* an `enqueue` task only. Calling it
   * from outside the queue would let statements overlap again.
   */
  private rawClient(): SqlClient {
    if (!this.raw_) throw new Error('database is not open yet');
    return this.raw_;
  }

  private async ensureProfile(): Promise<void> {
    const rows = await this.client().select<{ n: number }>('SELECT COUNT(*) AS n FROM user_profile');
    if ((rows[0]?.n ?? 0) === 0) {
      await this.client().execute('INSERT INTO user_profile (id, preferred_language, created_at) VALUES (1, ?, ?)', [
        'fa',
        new Date().toISOString(),
      ]);
    }
  }

  async searchBackend(): Promise<SearchService['backend']> {
    if (!this.searchService) this.searchService = await this.pickSearch(this.client());
    return this.searchService.backend;
  }

  async searchBackendNote(): Promise<SearchNoteId | null> {
    if (!this.searchService) this.searchService = await this.pickSearch(this.client());
    return this.searchService.noteId;
  }

  // --------------------------------------------------------------- import

  async packSource(): Promise<PackSource> {
    if (!this.source) await this.ready();
    if (!this.source) throw new Error('content source unavailable');
    return this.source;
  }

  /**
   * Validate every pack, then write them as one transaction.
   *
   * A plan that validated but failed to land is still a report the UI can
   * render: the write stage has its own `issue`, so the screen shows why the
   * database refused it instead of the click doing nothing. The transaction is
   * rolled back in that case, which is why the content counts stay at whatever
   * was there before rather than a partial import.
   */
  async importFromContent(): Promise<ImportReport> {
    const source = await this.packSource();
    const { report, plan } = await buildImportPlan(source);
    if (!plan || report.status !== 'success') {
      await this.recordReport(report);
      return report;
    }
    try {
      await this.applyImport(plan, report);
      return report;
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      const failed: ImportReport = {
        ...report,
        at: new Date().toISOString(),
        status: 'failed',
        issue: { stage: 'write', packId: report.issue?.packId, message },
        warnings: [...report.warnings, { stage: 'write', message: 'the write was rolled back; stored content is unchanged' }],
      };
      await this.recordReport(failed);
      return failed;
    }
  }

  async applyImport(plan: ContentPlan, report: ImportReport): Promise<void> {
    const db = this.require();
    await this.enqueue(async () => {
      const wroteAt = Date.now();
      await db.execute('BEGIN');
      try {
        // User rows reference `ayah` with RESTRICT, which is what stops a
        // content replace from cascading into notes and attempt history. Within
        // one transaction that is the only window where an ayah is missing, so
        // the checks are deferred to COMMIT — where a genuinely incomplete
        // import still fails and rolls back. See
        // `tests/integration/reimport-foreign-keys.test.ts`.
        await db.execute('PRAGMA defer_foreign_keys = ON');
        for (const table of CONTENT_TABLES) await db.execute(`DELETE FROM ${table}`);
        await this.writePlan(db, plan);
        // `buildImportPlan` timed the verification and mapping; the screen quotes
        // `durationMs` as *the import* duration, so the write belongs in it too.
        report.durationMs += Date.now() - wroteAt;
        await db.execute(
          'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          ['last_import_json', JSON.stringify(report)],
        );
        await db.execute(
          'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          ['last_import_at', report.at],
        );
        await db.execute('COMMIT');
      } catch (err) {
        await db.execute('ROLLBACK').catch(() => undefined);
        throw err;
      }
    });
  }

  private async writePlan(db: Database, plan: ContentPlan): Promise<void> {
    await insertRows(
      db,
      'content_pack',
      [
        'id',
        'kind',
        'version',
        'schema_version',
        'language',
        'title',
        'source',
        'license_name',
        'license_spdx',
        'license_status',
        'license_notes',
        'attribution',
        'checksum',
        'payload_bytes',
        'record_count',
        'imported_at',
      ],
      plan.packs.map((p) => [
        p.id,
        p.kind,
        p.version,
        p.schemaVersion,
        p.language,
        p.title,
        p.source,
        p.licenseName,
        p.licenseSpdx,
        p.licenseStatus,
        p.licenseNotes,
        JSON.stringify(p.attribution),
        p.checksum,
        p.payloadBytes,
        p.recordCount,
        p.importedAt,
      ]),
    );
    await insertRows(
      db,
      'surah',
      [
        'number',
        'name_arabic',
        'name_simple',
        'name_transliterated',
        'translation_fa',
        'translation_en',
        'revelation_place',
        'revelation_order',
        'ayah_count',
        'pages_from',
        'pages_to',
        'first_verse_key',
        'last_verse_key',
        'bismillah_pre',
      ],
      plan.surahs.map((s) => [
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
        s.bismillahPre ? 1 : 0,
      ]),
    );
    await insertRows(
      db,
      'ayah',
      [
        'verse_key',
        'chapter',
        'verse',
        'source_id',
        'juz',
        'hizb',
        'rub_el_hizb',
        'sajda',
        'ruku',
        'manzil',
        'page',
        'text_uthmani',
        'text_uthmani_simple',
        'word_count',
        'normalized_hash',
      ],
      plan.ayahs.map((a) => [
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
      ]),
    );
    let wordId = 0;
    await insertRows(
      db,
      'ayah_word',
      [
        'id',
        'verse_key',
        'position',
        'page_number',
        'line_number',
        'text_uthmani',
        'translation_en',
        'transliteration',
        'root',
        'morphology',
        'is_end_of_ayah_mark',
        'normalized',
      ],
      plan.words.map((w) => {
        wordId += 1;
        return [
          wordId,
          w.verseKey,
          w.position,
          w.pageNumber,
          w.lineNumber,
          w.textUthmani,
          w.translationEn,
          w.transliteration,
          w.root,
          w.morphology,
          w.isEndOfAyahMark ? 1 : 0,
          w.normalized,
        ];
      }),
    );
    await insertRows(
      db,
      'translation',
      ['verse_key', 'pack_id', 'text'],
      plan.translations.map((t) => [t.verseKey, t.packId, t.text]),
    );
    await insertRows(
      db,
      'tafsir',
      ['verse_key', 'pack_id', 'text', 'covers_verse_keys'],
      plan.tafsirs.map((t) => [t.verseKey, t.packId, t.text, JSON.stringify(t.coversVerseKeys)]),
    );
    await insertRows(
      db,
      'similar_ayah',
      ['verse_key_a', 'verse_key_b', 'text_score', 'shared_phrase', 'differing_words', 'produced_by'],
      plan.similar.map((s) => [
        s.verseKeyA,
        s.verseKeyB,
        s.textScore,
        s.sharedPhrase,
        JSON.stringify(s.differingWords),
        s.producedBy,
      ]),
    );
    await insertRows(
      db,
      'ayah_relation',
      ['from_verse_key', 'to_verse_key', 'type', 'reason', 'score', 'produced_by'],
      plan.relations.map((r) => [r.fromVerseKey, r.toVerseKey, r.type, r.reason, r.score, r.producedBy]),
    );
    await insertRows(
      db,
      'concept',
      ['id', 'label_arabic', 'label_fa', 'label_en', 'description_fa', 'relation_type', 'produced_by'],
      plan.concepts.map((c) => [
        c.id,
        c.labelArabic,
        c.labelFa,
        c.labelEn,
        c.descriptionFa,
        c.relationType,
        c.producedBy,
      ]),
    );
    await insertRows(
      db,
      'concept_ayah',
      ['concept_id', 'verse_key', 'type', 'reason'],
      plan.conceptAyah.map((l) => [l.conceptId, l.verseKey, l.type, l.reason]),
    );
    await insertRows(
      db,
      'concept_relation',
      ['from_concept_id', 'to_concept_id', 'type', 'note'],
      plan.conceptRelations.map((rel) => [rel.fromConceptId, rel.toConceptId, rel.type, rel.note]),
    );
    await insertRows(
      db,
      'audio_track',
      ['id', 'verse_key', 'chapter', 'reciter', 'file_path', 'duration_ms', 'license_status'],
      plan.audio.map((a) => [a.id, a.verseKey, a.chapter, a.reciter, a.filePath, a.durationMs, a.licenseStatus]),
    );
    // The search index is derived matching data, never display data: every
    // column is written in `matchKey` form so the query and the index agree for
    // Arabic, Persian and English, and the Persian column carries every bundled
    // Persian pack instead of whichever translation the loader saw last. The
    // verses themselves stay byte-exact in `ayah` and `translation`.
    //
    // The FTS table exists only when SQLite had the module; when it did not,
    // `ensureSchema` created the plain fallback table with the same columns, so
    // both backends read the same rows.
    const searchRows = buildSearchIndexRows(
      collectRawSearchDocs(plan.ayahs, plan.translations, plan.packs),
    );
    await writeSearchIndexRows(db, searchRows);
    await db.execute(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [META_KEYS.searchIndexKeyVersion, String(SEARCH_INDEX_VERSION)],
    );
  }

  /**
   * Empty the content tables and nothing else.
   *
   * User rows reference `ayah` with RESTRICT, so an in-use mushaf cannot be
   * removed: emptying it would leave every note, bookmark and memorisation
   * target pointing at a verse that is no longer stored. Rather than cascade
   * (which is what `ON DELETE CASCADE` would silently do to the learner's data)
   * this refuses up front and counts what is holding the content in place, so
   * the screen can say exactly that. Re-import is the way out — it replaces the
   * rows instead of removing them.
   */
  async resetContent(): Promise<void> {
    const db = this.rawClient();
    await this.enqueue(async () => {
      const refs = await db.select<{ notes: number; bookmarks: number; reading: number; hifz: number; confusion: number }>(
        `SELECT
           (SELECT COUNT(*) FROM note) AS notes,
           (SELECT COUNT(*) FROM bookmark WHERE verse_key IS NOT NULL) AS bookmarks,
           (SELECT COUNT(*) FROM reading_position) + (SELECT COUNT(*) FROM reading_history) AS reading,
           (SELECT COUNT(*) FROM hifz_item) AS hifz,
           (SELECT COUNT(*) FROM confusion_group_item) AS confusion`,
      );
      const r = refs[0];
      const held = (r?.notes ?? 0) + (r?.bookmarks ?? 0) + (r?.reading ?? 0) + (r?.hifz ?? 0) + (r?.confusion ?? 0);
      if (held > 0) {
        throw new Error(
          `Content is still referenced by user data and cannot be emptied: ` +
            `${r?.notes ?? 0} note(s), ${r?.bookmarks ?? 0} bookmark(s), ${r?.reading ?? 0} reading row(s), ` +
            `${r?.hifz ?? 0} memorisation item(s), ${r?.confusion ?? 0} confusion-group member(s). ` +
            `Re-import instead — it replaces the content rows without touching them.`,
        );
      }
      await db.execute('BEGIN');
      try {
        for (const table of CONTENT_TABLES) await db.execute(`DELETE FROM ${table}`);
        await db.execute("DELETE FROM meta WHERE key IN ('last_import_json','last_import_at')");
        await db.execute('COMMIT');
      } catch (err) {
        await db.execute('ROLLBACK').catch(() => undefined);
        throw err;
      }
    });
  }

  async recordReport(report: ImportReport): Promise<void> {
    const db = this.require();
    await this.enqueue(() =>
      db.execute(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        ['last_import_json', JSON.stringify(report)],
      ).then(() => db.execute(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        ['last_import_at', report.at],
      )),
    );
  }

  async importReport(): Promise<ImportReport | null> {
    const rows = await this.client().select<{ value: string }>('SELECT value FROM meta WHERE key = ?', [
      'last_import_json',
    ]);
    const raw = rows[0]?.value;
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ImportReport;
    } catch {
      return null;
    }
  }

  async packs(): Promise<PackRow[]> {
    const rows = await this.client().select<DbPack>('SELECT * FROM content_pack ORDER BY kind, id');
    return rows.map(packFrom);
  }

  private async countOf(table: string): Promise<number> {
    const rows = await this.client().select<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
    return rows[0]?.n ?? 0;
  }

  async counts(): Promise<ContentCounts> {
    const [surahs, ayahs, words, translations, tafsirs, similar, relations, concepts, audio, packs, bookmarks, notes, hifzItems, recallAttempts, confusionGroups] =
      await Promise.all([
        this.countOf('surah'),
        this.countOf('ayah'),
        this.countOf('ayah_word'),
        this.countOf('translation'),
        this.countOf('tafsir'),
        this.countOf('similar_ayah'),
        this.countOf('ayah_relation'),
        this.countOf('concept'),
        this.countOf('audio_track'),
        this.countOf('content_pack'),
        this.countOf('bookmark'),
        this.countOf('note'),
        this.countOf('hifz_item'),
        this.countOf('hifz_attempt'),
        this.countOf('confusion_group'),
      ]);
    return { surahs, ayahs, words, translations, tafsirs, similar, relations, concepts, audio, packs, bookmarks, notes, hifzItems, recallAttempts, confusionGroups };
  }

  // ------------------------------------------------------------ quran read

  async surahs(): Promise<Surah[]> {
    const rows = await this.client().select<DbSurah>('SELECT * FROM surah ORDER BY number');
    return rows.map(surahFrom);
  }

  async surah(number: number): Promise<Surah | null> {
    const rows = await this.client().select<DbSurah>('SELECT * FROM surah WHERE number = ?', [number]);
    const row = rows[0];
    return row ? surahFrom(row) : null;
  }

  async ayah(verseKey: VerseKey): Promise<AyahRow | null> {
    const rows = await this.client().select<DbAyah>('SELECT * FROM ayah WHERE verse_key = ?', [verseKey]);
    const row = rows[0];
    return row ? ayahFrom(row) : null;
  }

  async allAyahTexts(): Promise<AyahRow[]> {
    const rows = await this.client().select<DbAyah>('SELECT * FROM ayah ORDER BY chapter, verse');
    return rows.map(ayahFrom);
  }

  async ayahsByChapter(chapter: number): Promise<AyahRow[]> {
    const rows = await this.client().select<DbAyah>('SELECT * FROM ayah WHERE chapter = ? ORDER BY verse', [chapter]);
    return rows.map(ayahFrom);
  }

  async ayahsByPage(page: number): Promise<AyahRow[]> {
    const rows = await this.client().select<DbAyah>('SELECT * FROM ayah WHERE page = ? ORDER BY chapter, verse', [page]);
    return rows.map(ayahFrom);
  }

  async ayahsByJuz(juz: number): Promise<AyahRow[]> {
    const rows = await this.client().select<DbAyah>('SELECT * FROM ayah WHERE juz = ? ORDER BY chapter, verse', [juz]);
    return rows.map(ayahFrom);
  }

  async juzList(): Promise<JuzSummary[]> {
    const rows = await this.client().select<{
      juz: number;
      first_key: string;
      last_key: string;
      page_from: number;
      page_to: number;
      n: number;
    }>(
      `SELECT juz,
              MIN(verse_key) AS first_key,
              MAX(verse_key) AS last_key,
              MIN(page) AS page_from,
              MAX(page) AS page_to,
              COUNT(*) AS n
       FROM ayah GROUP BY juz ORDER BY juz`,
    );
    return rows.map((r) => ({
      juz: r.juz,
      firstVerseKey: r.first_key as VerseKey,
      lastVerseKey: r.last_key as VerseKey,
      pageFrom: r.page_from,
      pageTo: r.page_to,
      ayahCount: r.n,
    }));
  }

  async words(verseKey: VerseKey): Promise<AyahWordRow[]> {
    const rows = await this.client().select<DbWord>(
      'SELECT * FROM ayah_word WHERE verse_key = ? ORDER BY position',
      [verseKey],
    );
    return rows.map(wordFrom);
  }

  async translationOptions(): Promise<TranslationOption[]> {
    const rows = await this.client().select<{
      pack_id: string;
      title: string;
      language: string;
      license_status: string;
      coverage: number;
    }>(
      `SELECT t.pack_id AS pack_id,
              cp.title AS title,
              cp.language AS language,
              cp.license_status AS license_status,
              COUNT(*) AS coverage
       FROM translation t
       JOIN content_pack cp ON cp.id = t.pack_id
       GROUP BY t.pack_id
       ORDER BY cp.language, cp.title`,
    );
    return rows.map((r) => ({
      packId: r.pack_id,
      title: r.title,
      language: r.language as TranslationOption['language'],
      licenseStatus: r.license_status as TranslationOption['licenseStatus'],
      coverage: r.coverage,
    }));
  }

  async translations(verseKeys: VerseKey[], packId: string): Promise<Map<VerseKey, string>> {
    if (verseKeys.length === 0) return new Map();
    const marks = verseKeys.map(() => '?').join(',');
    const rows = await this.client().select<{ verse_key: string; text: string }>(
      `SELECT verse_key, text FROM translation WHERE pack_id = ? AND verse_key IN (${marks})`,
      [packId, ...verseKeys],
    );
    return new Map(rows.map((r) => [r.verse_key as VerseKey, r.text]));
  }

  async tafsirFor(verseKey: VerseKey): Promise<TafsirRow[]> {
    const rows = await this.client().select<{ pack_id: string; text: string; covers_verse_keys: string }>(
      'SELECT pack_id, text, covers_verse_keys FROM tafsir WHERE verse_key = ?',
      [verseKey],
    );
    return rows.map((r) => {
      let covers: VerseKey[] = [];
      try {
        covers = JSON.parse(r.covers_verse_keys) as VerseKey[];
      } catch {
        covers = [];
      }
      return { verseKey, packId: r.pack_id, text: r.text, coversVerseKeys: covers.length ? covers : [verseKey] };
    });
  }

  async tafsirSources(): Promise<
    { packId: string; title: string; licenseName: string; licenseSpdx: string | null; licenseStatus: PackRow['licenseStatus']; attribution: PackRow['attribution']; passages: number }[]
  > {
    const rows = await this.client().select<{ id: string; title: string; license_name: string; license_spdx: string | null; license_status: string; attribution: string; passages: number }>(
      `SELECT cp.id AS id, cp.title AS title, cp.license_name AS license_name, cp.license_spdx AS license_spdx,
              cp.license_status AS license_status, cp.attribution AS attribution,
              (SELECT COUNT(*) FROM tafsir t WHERE t.pack_id = cp.id) AS passages
       FROM content_pack cp WHERE cp.kind = 'tafsir' ORDER BY cp.title`,
    );
    return rows.map((r) => ({
      packId: r.id,
      title: r.title,
      licenseName: r.license_name,
      licenseSpdx: r.license_spdx,
      licenseStatus: r.license_status as PackRow['licenseStatus'],
      attribution: attributionFrom(r.attribution, r),
      passages: r.passages,
    }));
  }

  async similarTo(verseKey: VerseKey, limit = 12): Promise<SimilarAyahPair[]> {
    const rows = await this.client().select<{
      verse_key_a: string;
      verse_key_b: string;
      text_score: number;
      shared_phrase: string | null;
      differing_words: string | null;
      produced_by: string;
    }>(
      `SELECT verse_key_a, verse_key_b, text_score, shared_phrase, differing_words, produced_by
       FROM similar_ayah WHERE verse_key_a = ? OR verse_key_b = ?
       ORDER BY text_score DESC LIMIT ?`,
      [verseKey, verseKey, limit],
    );
    return rows.map((r) => {
      let differing: string[] = [];
      try {
        differing = JSON.parse(r.differing_words ?? '[]') as string[];
      } catch {
        differing = [];
      }
      return {
        verseKeyA: r.verse_key_a as VerseKey,
        verseKeyB: r.verse_key_b as VerseKey,
        textScore: r.text_score,
        sharedPhrase: r.shared_phrase,
        differingWords: differing,
        producedBy: r.produced_by,
      };
    });
  }

  async relationsOf(verseKey: VerseKey, limit = 20): Promise<AyahRelation[]> {
    const rows = await this.client().select<{
      from_verse_key: string;
      to_verse_key: string;
      type: string;
      reason: string;
      score: number;
      produced_by: string;
    }>(
      `SELECT from_verse_key, to_verse_key, type, reason, score, produced_by
       FROM ayah_relation WHERE from_verse_key = ? OR to_verse_key = ?
       ORDER BY score DESC LIMIT ?`,
      [verseKey, verseKey, limit],
    );
    return rows.map((r) => ({
      fromVerseKey: r.from_verse_key as VerseKey,
      toVerseKey: r.to_verse_key as VerseKey,
      type: r.type as AyahRelation['type'],
      reason: r.reason,
      score: r.score,
      producedBy: r.produced_by,
    }));
  }

  async audioFor(verseKey: VerseKey): Promise<
    { id: string; verseKey: VerseKey | null; chapter: number | null; reciter: string; filePath: string; durationMs: number | null; licenseStatus: PackRow['licenseStatus'] }[]
  > {
    const [chapter] = v(verseKey);
    const rows = await this.client().select<{
      id: string;
      verse_key: string | null;
      chapter: number | null;
      reciter: string;
      file_path: string;
      duration_ms: number | null;
      license_status: string;
    }>(
      'SELECT id, verse_key, chapter, reciter, file_path, duration_ms, license_status FROM audio_track WHERE verse_key = ? OR (verse_key IS NULL AND chapter = ?) LIMIT 4',
      [verseKey, chapter],
    );
    return rows.map((r) => ({
      id: r.id,
      verseKey: (r.verse_key as VerseKey | null) ?? null,
      chapter: r.chapter,
      reciter: r.reciter,
      filePath: r.file_path,
      durationMs: r.duration_ms,
      licenseStatus: r.license_status as PackRow['licenseStatus'],
    }));
  }

  // ----------------------------------------------------------- user data

  async settings(): Promise<Record<string, string>> {
    const rows = await this.client().select<{ key: string; value: string }>('SELECT key, value FROM settings');
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async setSetting(key: string, value: string): Promise<void> {
    const db = this.require();
    await this.enqueue(() =>
      db.execute(
        `INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [key, value, new Date().toISOString()],
      ),
    );
  }

  async bookmarks(): Promise<Bookmark[]> {
    const rows = await this.client().select<{
      id: string;
      verse_key: string | null;
      page: number | null;
      label: string | null;
      created_at: string;
    }>('SELECT * FROM bookmark ORDER BY created_at DESC');
    return rows.map((r) => ({
      id: r.id,
      verseKey: (r.verse_key as VerseKey | null) ?? null,
      page: r.page,
      label: r.label,
      createdAt: r.created_at,
    }));
  }

  async addBookmark(input: BookmarkInput): Promise<Bookmark> {
    const db = this.require();
    const bookmark: Bookmark = {
      id: `bm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      verseKey: input.verseKey ?? null,
      page: input.page ?? null,
      label: input.label ?? null,
      createdAt: new Date().toISOString(),
    };
    await this.enqueue(() =>
      db.execute('INSERT INTO bookmark (id, verse_key, page, label, created_at) VALUES (?,?,?,?,?)', [
        bookmark.id,
        bookmark.verseKey,
        bookmark.page,
        bookmark.label,
        bookmark.createdAt,
      ]),
    );
    return bookmark;
  }

  async removeBookmark(id: string): Promise<void> {
    const db = this.require();
    await this.enqueue(() => db.execute('DELETE FROM bookmark WHERE id = ?', [id]));
  }

  async notesFor(verseKey: VerseKey): Promise<Note[]> {
    const rows = await this.client().select<DbNote>(
      'SELECT * FROM note WHERE verse_key = ? ORDER BY updated_at DESC',
      [verseKey],
    );
    return rows.map(noteFrom);
  }

  async recentNotes(limit: number): Promise<Note[]> {
    const rows = await this.client().select<DbNote>('SELECT * FROM note ORDER BY updated_at DESC LIMIT ?', [limit]);
    return rows.map(noteFrom);
  }

  async saveNote(input: NoteInput): Promise<Note> {
    const db = this.require();
    const now = new Date().toISOString();
    const id = input.id ?? `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const existing = input.id
      ? (await this.client().select<DbNote>('SELECT * FROM note WHERE id = ?', [input.id]))[0]
      : undefined;
    const note: Note = {
      id,
      verseKey: input.verseKey,
      body: input.body,
      createdAt: existing?.created_at ?? now,
      updatedAt: now,
    };
    await this.enqueue(() =>
      db.execute(
        `INSERT INTO note (id, verse_key, body, created_at, updated_at) VALUES (?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
        [note.id, note.verseKey, note.body, note.createdAt, note.updatedAt],
      ),
    );
    return note;
  }

  async deleteNote(id: string): Promise<void> {
    const db = this.require();
    await this.enqueue(() => db.execute('DELETE FROM note WHERE id = ?', [id]));
  }

  async readingPosition(): Promise<(ReadingPosition & { surah: Surah }) | null> {
    const rows = await this.client().select<{
      verse_key: string;
      page: number;
      scroll_fraction: number;
      updated_at: string;
      number: number;
      name_arabic: string;
      name_simple: string;
      name_transliterated: string;
      translation_fa: string | null;
      translation_en: string | null;
      revelation_place: 'makkah' | 'madinah';
      revelation_order: number;
      ayah_count: number;
      pages_from: number;
      pages_to: number;
      first_verse_key: string;
      last_verse_key: string;
      bismillah_pre: number;
    }>(
      `SELECT rp.verse_key, rp.page, rp.scroll_fraction, rp.updated_at, s.*
       FROM reading_position rp JOIN surah s ON s.number = CAST(substr(rp.verse_key, 1, instr(rp.verse_key, ':') - 1) AS INTEGER)
       ORDER BY rp.updated_at DESC LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      verseKey: row.verse_key as VerseKey,
      page: row.page,
      scrollFraction: row.scroll_fraction,
      updatedAt: row.updated_at,
      surah: surahFrom({
        number: row.number,
        name_arabic: row.name_arabic,
        name_simple: row.name_simple,
        name_transliterated: row.name_transliterated,
        translation_fa: row.translation_fa,
        translation_en: row.translation_en,
        revelation_place: row.revelation_place,
        revelation_order: row.revelation_order,
        ayah_count: row.ayah_count,
        pages_from: row.pages_from,
        pages_to: row.pages_to,
        first_verse_key: row.first_verse_key,
        last_verse_key: row.last_verse_key,
        bismillah_pre: row.bismillah_pre,
      }),
    };
  }

  async setReadingPosition(verseKey: VerseKey, page: number, scrollFraction: number): Promise<void> {
    const db = this.require();
    await this.enqueue(() =>
      db.execute(
        `INSERT INTO reading_position (id, verse_key, page, scroll_fraction, updated_at) VALUES ('current',?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET verse_key = excluded.verse_key, page = excluded.page,
           scroll_fraction = excluded.scroll_fraction, updated_at = excluded.updated_at`,
        [verseKey, page, scrollFraction, new Date().toISOString()],
      ),
    );
  }

  async recordReading(verseKey: VerseKey, durationMs: number | null): Promise<void> {
    const db = this.require();
    await this.enqueue(() =>
      db.execute('INSERT INTO reading_history (id, verse_key, read_at, duration_ms) VALUES (?,?,?,?)', [
        `rh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        verseKey,
        new Date().toISOString(),
        durationMs,
      ]),
    );
  }

  async recentReading(limit: number): Promise<ReadingHistoryEntry[]> {
    const rows = await this.client().select<{ verse_key: string; read_at: string; duration_ms: number | null }>(
      'SELECT verse_key, read_at, duration_ms FROM reading_history ORDER BY read_at DESC LIMIT ?',
      [limit],
    );
    return rows.map((r) => ({ verseKey: r.verse_key as VerseKey, readAt: r.read_at, durationMs: r.duration_ms }));
  }

  // ---------------------------------------------------------------- hifz

  async hifzItems(status?: HifzItemStatus): Promise<HifzItem[]> {
    const rows = status
      ? await this.client().select<DbHifzItem>('SELECT * FROM hifz_item WHERE status = ? ORDER BY next_review_at', [status])
      : await this.client().select<DbHifzItem>('SELECT * FROM hifz_item ORDER BY added_at DESC');
    return rows.map(hifzItemFrom);
  }

  async addHifzItem(verseKey: VerseKey, sequence?: VerseKey[]): Promise<HifzItem> {
    const db = this.require();
    const item: HifzItem = {
      id: `hi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      verseKey,
      sequence: sequence && sequence.length > 0 ? sequence : [verseKey],
      addedAt: new Date().toISOString(),
      status: 'active',
      band: 'new',
      stability: 0,
      strength: 0,
      lastReviewedAt: null,
      nextReviewAt: null,
      attemptCount: 0,
      errorCount: 0,
    };
    await this.enqueue(() =>
      db.execute(
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
          null,
          null,
          0,
          0,
        ],
      ),
    );
    return item;
  }

  async removeHifzItem(id: string): Promise<void> {
    const db = this.require();
    await this.enqueue(() => db.execute('DELETE FROM hifz_item WHERE id = ?', [id]));
  }

  async setHifzItemStatus(id: string, status: HifzItemStatus): Promise<void> {
    const db = this.require();
    await this.enqueue(() => db.execute('UPDATE hifz_item SET status = ? WHERE id = ?', [status, id]));
  }

  async upsertHifzItem(item: HifzItem): Promise<void> {
    const db = this.require();
    await this.enqueue(() =>
      db.execute(
        `INSERT INTO hifz_item (id, verse_key, sequence, added_at, status, band, stability, strength,
             last_reviewed_at, next_review_at, attempt_count, error_count)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, band = excluded.band,
           stability = excluded.stability, strength = excluded.strength,
           last_reviewed_at = excluded.last_reviewed_at, next_review_at = excluded.next_review_at,
           attempt_count = excluded.attempt_count, error_count = excluded.error_count`,
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
      ),
    );
  }

  async saveRecallAttempt(attempt: RecallAttempt): Promise<void> {
    const db = this.require();
    await this.enqueue(() =>
      db.execute(
        `INSERT INTO hifz_attempt (id, item_id, verse_key, session_id, mode, started_at, completed_at, produced,
             cue, expected_word_count, correct_word_count, accuracy, errors, duration_ms, self_confidence, used_audio)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          attempt.id,
          attempt.itemId,
          attempt.verseKey,
          attempt.sessionId,
          attempt.mode,
          attempt.startedAt,
          attempt.completedAt,
          JSON.stringify(attempt.produced),
          attempt.cue ? JSON.stringify(attempt.cue) : null,
          attempt.expectedWordCount,
          attempt.correctWordCount,
          attempt.accuracy,
          JSON.stringify(attempt.errors),
          attempt.durationMs,
          attempt.selfConfidence,
          attempt.usedAudio ? 1 : 0,
        ],
      ),
    );
  }

  async hifzSegments(itemId?: string): Promise<HifzSegment[]> {
    const rows = itemId
      ? await this.client().select<DbSegment>('SELECT * FROM hifz_segment WHERE item_id = ? ORDER BY position', [itemId])
      : await this.client().select<DbSegment>('SELECT * FROM hifz_segment ORDER BY item_id, position');
    return rows.map((r) => ({
      id: r.id,
      itemId: r.item_id,
      position: r.position,
      fromWord: r.from_word,
      toWord: r.to_word,
      text: r.text,
      meaningFa: r.meaning_fa,
      meaningSource: r.meaning_source,
      stability: r.stability,
      errorCount: r.error_count,
    }));
  }

  async anchorWords(itemId?: string): Promise<AnchorWord[]> {
    const rows = itemId
      ? await this.client().select<DbAnchor>('SELECT * FROM anchor_word WHERE item_id = ? ORDER BY word_position', [itemId])
      : await this.client().select<DbAnchor>('SELECT * FROM anchor_word ORDER BY item_id, word_position');
    return rows.map((r) => ({
      id: r.id,
      itemId: r.item_id,
      wordPosition: r.word_position,
      text: r.text,
      role: r.role as AnchorWord['role'],
      stability: r.stability,
    }));
  }

  async hifzTransitions(itemId?: string): Promise<HifzTransition[]> {
    const rows = itemId
      ? await this.client().select<DbTransition>('SELECT * FROM hifz_transition WHERE item_id = ? ORDER BY to_word', [itemId])
      : await this.client().select<DbTransition>('SELECT * FROM hifz_transition ORDER BY item_id, to_word');
    return rows.map((r) => ({
      id: r.id,
      itemId: r.item_id,
      kind: r.kind as HifzTransition['kind'],
      toVerseKey: (r.to_verse_key as VerseKey | null) ?? null,
      toWord: r.to_word,
      successCount: r.success_count,
      failureCount: r.failure_count,
      stability: r.stability,
      lastPracticedAt: r.last_practiced_at,
    }));
  }

  async recallAttempts(itemId?: string, limit = 500): Promise<RecallAttempt[]> {
    const sql = itemId
      ? 'SELECT * FROM hifz_attempt WHERE item_id = ? ORDER BY started_at DESC LIMIT ?'
      : 'SELECT * FROM hifz_attempt ORDER BY started_at DESC LIMIT ?';
    const rows = await this.client().select<DbAttempt>(sql, itemId ? [itemId, limit] : [limit]);
    return rows.map(attemptFrom).reverse();
  }

  async confusionGroups(): Promise<ConfusionGroup[]> {
    const groups = await this.client().select<{
      id: string;
      label: string | null;
      origin: string;
      created_at: string;
      last_triggered_at: string | null;
      confusion_count: number;
    }>('SELECT * FROM confusion_group ORDER BY confusion_count DESC, created_at DESC');
    const out: ConfusionGroup[] = [];
    for (const g of groups) {
      const items = await this.client().select<{ verse_key: string; position: number }>(
        'SELECT verse_key, position FROM confusion_group_item WHERE group_id = ? ORDER BY position',
        [g.id],
      );
      out.push({
        id: g.id,
        label: g.label,
        origin: g.origin as ConfusionGroup['origin'],
        verseKeys: items.map((i) => i.verse_key as VerseKey),
        createdAt: g.created_at,
        lastTriggeredAt: g.last_triggered_at,
        confusionCount: g.confusion_count,
      });
    }
    return out;
  }

  async saveConfusionGroup(group: ConfusionGroup): Promise<void> {
    const db = this.require();
    await this.enqueue(async () => {
      await db.execute(
        `INSERT INTO confusion_group (id, label, origin, created_at, last_triggered_at, confusion_count)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET label = excluded.label, last_triggered_at = excluded.last_triggered_at,
           confusion_count = excluded.confusion_count`,
        [group.id, group.label, group.origin, group.createdAt, group.lastTriggeredAt, group.confusionCount],
      );
      await db.execute('DELETE FROM confusion_group_item WHERE group_id = ?', [group.id]);
      for (let i = 0; i < group.verseKeys.length; i += 1) {
        await db.execute(
          'INSERT INTO confusion_group_item (group_id, verse_key, position) VALUES (?,?,?)',
          [group.id, group.verseKeys[i], i],
        );
      }
    });
  }

  async hifzSessions(limit: number): Promise<HifzSession[]> {
    const rows = await this.client().select<{
      id: string;
      started_at: string;
      ended_at: string | null;
      planned_steps: number;
      steps: string;
      report: string | null;
    }>('SELECT * FROM hifz_session ORDER BY started_at DESC LIMIT ?', [limit]);
    return rows.map((r) => {
      let steps: HifzSession['steps'] = [];
      let report: HifzSession['report'] = null;
      try {
        steps = JSON.parse(r.steps) as HifzSession['steps'];
      } catch {
        steps = [];
      }
      try {
        report = r.report ? (JSON.parse(r.report) as HifzSession['report']) : null;
      } catch {
        report = null;
      }
      return { id: r.id, startedAt: r.started_at, endedAt: r.ended_at, plannedSteps: r.planned_steps, steps, report };
    });
  }

  async saveHifzSession(session: HifzSession): Promise<void> {
    const db = this.require();
    await this.enqueue(() =>
      db.execute(
        `INSERT INTO hifz_session (id, started_at, ended_at, planned_steps, steps, report) VALUES (?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET ended_at = excluded.ended_at, planned_steps = excluded.planned_steps,
           steps = excluded.steps, report = excluded.report`,
        [
          session.id,
          session.startedAt,
          session.endedAt,
          session.plannedSteps,
          JSON.stringify(session.steps),
          session.report ? JSON.stringify(session.report) : null,
        ],
      ),
    );
  }

  async dailyPlan(date: string): Promise<{ date: string; payload: string; generatedAt: string } | null> {
    const rows = await this.client().select<{ date: string; payload: string; generated_at: string }>(
      'SELECT date, payload, generated_at FROM daily_plan WHERE date = ?',
      [date],
    );
    const row = rows[0];
    return row ? { date: row.date, payload: row.payload, generatedAt: row.generated_at } : null;
  }

  async saveDailyPlan(date: string, payload: string): Promise<void> {
    const db = this.require();
    await this.enqueue(() =>
      db.execute(
        `INSERT INTO daily_plan (date, payload, generated_at) VALUES (?,?,?)
         ON CONFLICT(date) DO UPDATE SET payload = excluded.payload, generated_at = excluded.generated_at`,
        [date, payload, new Date().toISOString()],
      ),
    );
  }

  // -------------------------------------------------------------- search

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    if (!this.searchService) this.searchService = await this.pickSearch(this.client());
    return this.searchService.search(query, options);
  }

  // -------------------------------------------------------------- dashboard

  async homeStats(now: Date): Promise<HomeStats> {
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const [position, due, weak, groups, attempts, notes, bookmarks, recent] = await Promise.all([
      this.readingPosition(),
      this.client().select<{ n: number }>(
        "SELECT COUNT(*) AS n FROM hifz_item WHERE status = 'active' AND next_review_at IS NOT NULL AND next_review_at <= ?",
        [now.toISOString()],
      ),
      this.client().select<{ n: number }>(
        "SELECT COUNT(*) AS n FROM hifz_item WHERE status = 'active' AND band IN ('weak','unstable')",
      ),
      this.countOf('confusion_group'),
      this.countOf('hifz_attempt'),
      this.recentNotes(5),
      this.bookmarks(),
      this.recentReading(6),
    ]);
    const counts = await this.counts();
    return {
      continueAt: position,
      hifzDueToday: due[0]?.n ?? 0,
      hifzWeak: weak[0]?.n ?? 0,
      hifzActive: counts.hifzItems,
      confusionGroups: groups,
      recallAttempts: attempts,
      notes,
      bookmarks: bookmarks.slice(0, 6),
      recentReading: recent,
      hasContent: counts.ayahs > 0,
      hasUserData: counts.hifzItems + counts.notes + counts.bookmarks + counts.recallAttempts > 0,
    };
  }

  // --------------------------------------------------------------- backup

  async exportBackup(): Promise<BackupEnvelope> {
    const data = await collectUserData({
      settings: () => this.settings(),
      bookmarks: () => this.bookmarks(),
      notes: () => this.notesAll(),
      readingPositions: async () => {
        const p = await this.readingPosition();
        return p ? [{ id: 'current', verseKey: p.verseKey, page: p.page, scrollFraction: p.scrollFraction, updatedAt: p.updatedAt }] : [];
      },
      readingHistory: async () => this.recentReading(100000),
      hifzItems: () => this.hifzItems(),
      hifzSegments: () => this.hifzSegments(),
      anchorWords: () => this.anchorWords(),
      hifzTransitions: () => this.hifzTransitions(),
      recallAttempts: () => this.recallAttempts(undefined, 100000),
      confusionGroups: () => this.confusionGroups(),
      sessions: () => this.hifzSessions(10000),
      journeys: async () => [],
      reflections: async () => [],
      dailyPlans: async () => this.dailyPlans(),
    });
    // Sealed through core, never here: the checksum is sha256 over the
    // CANONICAL json of `data` (keys sorted, undefined members dropped), and
    // `validateEnvelopeObject` recomputes exactly that. An envelope built with
    // `JSON.stringify(data)` + `sha256_text` digested a different byte string
    // than the validator checks, so the app refused to restore files it had
    // just written itself.
    return buildEnvelope(data, {
      app: 'quran-desktop',
      version: '0.1.0',
      platform: 'desktop',
      minReaderVersion: 1,
    }).envelope;
  }

  private async notesAll(): Promise<Note[]> {
    const rows = await this.client().select<DbNote>('SELECT * FROM note ORDER BY updated_at');
    return rows.map(noteFrom);
  }

  private async dailyPlans(): Promise<Record<string, unknown>[]> {
    const rows = await this.client().select<{ date: string; payload: string; generated_at: string }>(
      'SELECT date, payload, generated_at FROM daily_plan ORDER BY date',
    );
    return plansForEnvelope(rows.map((r) => ({ date: r.date, payload: r.payload, generatedAt: r.generated_at })));
  }

  async importBackup(envelope: BackupEnvelope): Promise<MigrationResult> {
    if (envelope.schemaVersion > BACKUP_SCHEMA_VERSION) {
      return { ok: false, from: envelope.schemaVersion, error: `backup schema v${envelope.schemaVersion} is newer than v${BACKUP_SCHEMA_VERSION}` };
    }
    if (envelope.schemaVersion < BACKUP_SCHEMA_VERSION) {
      return { ok: false, from: envelope.schemaVersion, error: `backup v${envelope.schemaVersion} needs a migration; only v${BACKUP_SCHEMA_VERSION} can be read directly` };
    }
    // Same digest the validator recomputes: core's canonical JSON of `data`,
    // not `JSON.stringify` of it (see `exportBackup`).
    const digest = computeDataChecksum(envelope.data);
    if (digest.toLowerCase() !== envelope.checksum.trim().toLowerCase()) {
      return { ok: false, from: envelope.schemaVersion, error: 'backup checksum does not match its contents — the file is corrupt or edited' };
    }
    const warnings: string[] = [];
    const db = this.require();
    await this.enqueue(async () => {
      await db.execute('BEGIN');
      try {
        for (const table of ['bookmark', 'note', 'reading_position', 'reading_history', 'hifz_attempt', 'anchor_word', 'hifz_transition', 'hifz_segment', 'confusion_group_item', 'confusion_group', 'hifz_item', 'hifz_session', 'daily_plan', 'journey_progress', 'learning_journey', 'reflection', 'settings']) {
          await db.execute(`DELETE FROM ${table}`);
        }
        for (const [key, value] of Object.entries(envelope.data.settings ?? {})) {
          await db.execute(
            `INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            [key, String(value), envelope.createdAt],
          );
        }
        for (const b of envelope.data.bookmarks as Bookmark[]) {
          await db.execute('INSERT INTO bookmark (id, verse_key, page, label, created_at) VALUES (?,?,?,?,?)', [
            b.id,
            b.verseKey,
            b.page,
            b.label,
            b.createdAt,
          ]);
        }
        for (const n of envelope.data.notes as Note[]) {
          await db.execute('INSERT INTO note (id, verse_key, body, created_at, updated_at) VALUES (?,?,?,?,?)', [
            n.id,
            n.verseKey,
            n.body,
            n.createdAt,
            n.updatedAt,
          ]);
        }
        for (const p of envelope.data.readingPositions as ReadingPosition[]) {
          await db.execute(
            `INSERT INTO reading_position (id, verse_key, page, scroll_fraction, updated_at) VALUES (?,?,?,?,?)`,
            ['current', p.verseKey, p.page, p.scrollFraction, p.updatedAt],
          );
        }
        for (const h of envelope.data.readingHistory as ReadingHistoryEntry[]) {
          await db.execute('INSERT INTO reading_history (id, verse_key, read_at, duration_ms) VALUES (?,?,?,?)', [
            `rh-${Math.random().toString(36).slice(2, 10)}`,
            h.verseKey,
            h.readAt,
            h.durationMs,
          ]);
        }
        for (const item of envelope.data.hifzItems as HifzItem[]) {
          await db.execute(
            `INSERT INTO hifz_item (id, verse_key, sequence, added_at, status, band, stability, strength,
               last_reviewed_at, next_review_at, attempt_count, error_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        }
        for (const s of envelope.data.hifzSegments as HifzSegment[]) {
          await db.execute(
            `INSERT INTO hifz_segment (id, item_id, position, from_word, to_word, text, meaning_fa, meaning_source, stability, error_count)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [s.id, s.itemId, s.position, s.fromWord, s.toWord, s.text, s.meaningFa, s.meaningSource, s.stability, s.errorCount],
          );
        }
        for (const a of envelope.data.anchorWords as AnchorWord[]) {
          await db.execute(
            'INSERT INTO anchor_word (id, item_id, word_position, text, role, stability) VALUES (?,?,?,?,?,?)',
            [a.id, a.itemId, a.wordPosition, a.text, a.role, a.stability],
          );
        }
        for (const t of envelope.data.hifzTransitions as HifzTransition[]) {
          await db.execute(
            `INSERT INTO hifz_transition (id, item_id, kind, to_verse_key, to_word, success_count, failure_count, stability, last_practiced_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [t.id, t.itemId, t.kind, t.toVerseKey, t.toWord, t.successCount, t.failureCount, t.stability, t.lastPracticedAt],
          );
        }
        for (const att of envelope.data.recallAttempts as RecallAttempt[]) {
          await db.execute(
            `INSERT INTO hifz_attempt (id, item_id, verse_key, session_id, mode, started_at, completed_at, produced, cue,
               expected_word_count, correct_word_count, accuracy, errors, duration_ms, self_confidence, used_audio)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              att.id,
              att.itemId,
              att.verseKey,
              att.sessionId,
              att.mode,
              att.startedAt,
              att.completedAt,
              JSON.stringify(att.produced),
              att.cue ? JSON.stringify(att.cue) : null,
              att.expectedWordCount,
              att.correctWordCount,
              att.accuracy,
              JSON.stringify(att.errors),
              att.durationMs,
              att.selfConfidence,
              att.usedAudio ? 1 : 0,
            ],
          );
        }
        for (const g of envelope.data.confusionGroups as ConfusionGroup[]) {
          await db.execute(
            'INSERT INTO confusion_group (id, label, origin, created_at, last_triggered_at, confusion_count) VALUES (?,?,?,?,?,?)',
            [g.id, g.label, g.origin, g.createdAt, g.lastTriggeredAt, g.confusionCount],
          );
          for (let i = 0; i < g.verseKeys.length; i += 1) {
            await db.execute('INSERT INTO confusion_group_item (group_id, verse_key, position) VALUES (?,?,?)', [
              g.id,
              g.verseKeys[i],
              i,
            ]);
          }
        }
        for (const s of envelope.data.sessions as HifzSession[]) {
          await db.execute(
            'INSERT INTO hifz_session (id, started_at, ended_at, planned_steps, steps, report) VALUES (?,?,?,?,?,?)',
            [s.id, s.startedAt, s.endedAt, s.plannedSteps, JSON.stringify(s.steps), s.report ? JSON.stringify(s.report) : null],
          );
        }
        for (const p of planRowsFromEnvelope(envelope.data.dailyPlans)) {
          await db.execute('INSERT INTO daily_plan (date, payload, generated_at) VALUES (?,?,?)', [
            p.date,
            p.payload,
            p.generatedAt,
          ]);
        }
        await db.execute('COMMIT');
      } catch (err) {
        await db.execute('ROLLBACK').catch(() => undefined);
        throw err;
      }
    });
    return { ok: true, from: envelope.schemaVersion, to: BACKUP_SCHEMA_VERSION, warnings };
  }

  // ------------------------------------------------------ backup files
  //
  // The Rust commands take a NAME, not a path: `backup_write` / `backup_read`
  // reject anything that is not `<safe-name>.quranbak` and resolve it inside
  // the app-data backups directory. Widening that from here is not an option
  // (see §47 of the brief); the JS layer only ever passes a name through.

  async backupFiles(): Promise<{ name: string; createdAt: string; bytes: number }[]> {
    // `backup_list` -> Vec<BackupEntry { name, bytes, sha256 }>; it exposes no
    // mtime, so `createdAt` stays empty rather than carrying a made-up date.
    const entries = await invoke<{ name: string; bytes: number; sha256: string }[]>('backup_list');
    return entries.map((e) => ({ name: e.name, createdAt: '', bytes: Number(e.bytes) }));
  }

  async writeBackupFile(name: string, envelope: BackupEnvelope): Promise<string> {
    // Rust arg is `contents: String` — the envelope serialised, nothing else.
    // Canonical bytes: the sealed checksum is the digest of exactly this text's
    // `data` member, so a file stays verifiable by its own bytes.
    return invoke<string>('backup_write', { name, contents: serializeEnvelope(envelope) });
  }

  async readBackupFile(name: string): Promise<BackupEnvelope | null> {
    const raw = await invoke<string>('backup_read', { name });
    try {
      return JSON.parse(raw) as BackupEnvelope;
    } catch {
      // A file that is not valid JSON is reported by the screen, never thrown.
      return null;
    }
  }
}

// ------------------------------------------------------------------ shared

interface DbNote {
  id: string;
  verse_key: string;
  body: string;
  created_at: string;
  updated_at: string;
}

function noteFrom(r: DbNote): Note {
  return {
    id: r.id,
    verseKey: r.verse_key as VerseKey,
    body: r.body,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface DbHifzItem {
  id: string;
  verse_key: string;
  sequence: string;
  added_at: string;
  status: string;
  band: string;
  stability: number;
  strength: number;
  last_reviewed_at: string | null;
  next_review_at: string | null;
  attempt_count: number;
  error_count: number;
}

function hifzItemFrom(r: DbHifzItem): HifzItem {
  let sequence: VerseKey[] = [];
  try {
    sequence = JSON.parse(r.sequence) as VerseKey[];
  } catch {
    sequence = [];
  }
  return {
    id: r.id,
    verseKey: r.verse_key as VerseKey,
    sequence: sequence.length ? sequence : [r.verse_key as VerseKey],
    addedAt: r.added_at,
    status: r.status as HifzItem['status'],
    band: r.band as HifzItem['band'],
    stability: r.stability,
    strength: r.strength,
    lastReviewedAt: r.last_reviewed_at,
    nextReviewAt: r.next_review_at,
    attemptCount: r.attempt_count,
    errorCount: r.error_count,
  };
}

interface DbSegment {
  id: string;
  item_id: string;
  position: number;
  from_word: number;
  to_word: number;
  text: string;
  meaning_fa: string | null;
  meaning_source: string | null;
  stability: number;
  error_count: number;
}

interface DbAnchor {
  id: string;
  item_id: string;
  word_position: number;
  text: string;
  role: string;
  stability: number;
}

interface DbTransition {
  id: string;
  item_id: string;
  kind: string;
  to_verse_key: string | null;
  to_word: number;
  success_count: number;
  failure_count: number;
  stability: number;
  last_practiced_at: string | null;
}

interface DbAttempt {
  id: string;
  item_id: string;
  verse_key: string;
  session_id: string | null;
  mode: string;
  started_at: string;
  completed_at: string | null;
  produced: string;
  cue: string | null;
  expected_word_count: number;
  correct_word_count: number;
  accuracy: number;
  errors: string;
  duration_ms: number | null;
  self_confidence: number | null;
  used_audio: number;
}

function attemptFrom(r: DbAttempt): RecallAttempt {
  const parse = <T>(raw: string, fallback: T): T => {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  };
  return {
    id: r.id,
    itemId: r.item_id,
    verseKey: r.verse_key as VerseKey,
    sessionId: r.session_id,
    mode: r.mode as RecallAttempt['mode'],
    startedAt: r.started_at,
    completedAt: r.completed_at,
    produced: parse(r.produced, []),
    cue: r.cue ? parse<{ kind: string; text: string | null }>(r.cue, { kind: 'unknown', text: null }) : null,
    expectedWordCount: r.expected_word_count,
    correctWordCount: r.correct_word_count,
    accuracy: r.accuracy,
    errors: parse(r.errors, []),
    durationMs: r.duration_ms,
    selfConfidence: r.self_confidence,
    usedAudio: r.used_audio === 1,
  };
}

/**
 * Shared backup assembly. The desktop and dev gateways both build the envelope
 * through here so a backup file is byte-identical in shape whichever produced
 * it, and `counts` always reflects what is actually in `data`.
 */
export async function collectUserData(
  readers: { [K in keyof BackupEnvelope['data']]: () => Promise<BackupEnvelope['data'][K]> },
): Promise<BackupEnvelope['data']> {
  const out: Record<string, unknown> = {};
  for (const [key, read] of Object.entries(readers)) {
    out[key] = await read();
  }
  return out as unknown as BackupEnvelope['data'];
}

/** The stored shape of one row of `daily_plan` (and of the dev shell's list). */
export interface DailyPlanRow {
  date: string;
  payload: string;
  generatedAt: string;
}

/**
 * Storage rows → the rows a backup carries.
 *
 * A `daily_plan` row is `{date, payload, generated_at}`, where `payload` is the
 * plan as JSON. The backup format (and `validate.ts`, which checks the plan
 * field by field) exports the DECODED plan instead, so the storage wrapper
 * never appears in a file. A payload this app cannot read is dropped: sealing
 * it in would produce a file the validator then refuses, which is worse than
 * exporting one plan the user can regenerate.
 */
export function plansForEnvelope(rows: readonly DailyPlanRow[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    let plan: unknown;
    try {
      plan = JSON.parse(r.payload);
    } catch {
      continue;
    }
    if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) continue;
    out.push({ ...(plan as Record<string, unknown>), date: r.date, generatedAt: r.generatedAt });
  }
  return out;
}

/** The reverse of `plansForEnvelope`, used by every restore path. */
export function planRowsFromEnvelope(rows: readonly unknown[]): DailyPlanRow[] {
  const out: DailyPlanRow[] = [];
  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const { generatedAt, ...plan } = raw as Record<string, unknown> & { generatedAt?: unknown };
    const date = plan.date;
    if (typeof date !== 'string' || typeof generatedAt !== 'string') continue;
    // Canonical bytes, so export → restore → export is stable rather than
    // reordering keys on every round trip.
    out.push({ date, payload: canonicalJsonStringify(plan), generatedAt });
  }
  return out;
}
