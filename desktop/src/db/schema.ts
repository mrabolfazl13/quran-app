/**
 * Schema bootstrap and the migration chain.
 *
 * The SQL is the shared contract (`core/src/contracts/db.sql`) embedded at
 * build time by `scripts/syncSchema.mjs`. `meta.schema_version` is written on
 * first creation and read on every open:
 *
 *   stored < SCHEMA_VERSION  → run the migration chain (stubs today)
 *   stored > SCHEMA_VERSION  → refuse to open (a newer DB may hold data this
 *                              build cannot represent; never downgrade silently)
 */
import { SCHEMA_SQL } from './schema.generated';
// `batchInsert`'s only dependency is a type, so this adds no cycle between the
// db layer and the gateway that imports it back.
import { insertRows } from '../gateway/batchInsert';

/** Keep in step with the "-- SQLite schema, version N" header of db.sql. */
export const SCHEMA_VERSION = 3;

export const META_KEYS = {
  schemaVersion: 'schema_version',
  createdAt: 'created_at',
  migrations: 'applied_migrations',
  searchBackend: 'search_backend',
  /**
   * Which normalisation the `ayah_search` columns were written with (see
   * `SEARCH_INDEX_KEY_VERSION` in `core/src/search`). A stored value below the
   * current one means the derived index predates the rules the query uses, so
   * the gateway rebuilds it from `ayah` + `translation` before serving a search.
   */
  searchIndexKeyVersion: 'search_index_key_version',
  lastImport: 'last_import_json',
  lastImportAt: 'last_import_at',
} as const;

/**
 * Stand-in for the `ayah_search` FTS5 virtual table on a SQLite build without
 * the FTS5 module. Same name, same columns, so the import writer and the
 * normalised substring read path are unchanged; the only thing lost is the
 * MATCH/bm25 accelerator on the Arabic column, which `SqliteSearchService`
 * skips in that case and `searchBackend: 'like'` reports.
 */
export const SEARCH_FALLBACK_DDL =
  'CREATE TABLE IF NOT EXISTS ayah_search (' +
  'verse_key TEXT PRIMARY KEY, arabic TEXT NOT NULL, translation_en TEXT NOT NULL, translation_fa TEXT NOT NULL)';

export interface SqlValue {
  [column: string]: unknown;
}

/** The subset of `Database` from @tauri-apps/plugin-sql this module needs. */
export interface SqlClient {
  select<TRow>(sql: string, params?: unknown[]): Promise<TRow[]>;
  execute(sql: string, params?: unknown[]): Promise<number>;
}

export class SchemaTooNewError extends Error {
  readonly found: number;
  readonly supported: number;
  readonly database: string | null;

  constructor(found: number, supported: number, database: string | null) {
    super(
      `Database schema v${found} is newer than this build supports (v${supported}). ` +
        'Refusing to open it — the data would be rewritten in an older format.',
    );
    this.name = 'SchemaTooNewError';
    this.found = found;
    this.supported = supported;
    this.database = database;
  }
}

export interface Migration {
  to: number;
  describe: string;
  up(client: SqlClient): Promise<void>;
}

/**
 * The chain. v1 → v2 is the hifz dual axis: an item and a segment gain a
 * `meaning_stability` beside their form one, a segment's meaning is re-addressed
 * by the licensed pack it came from instead of a free-text label, and every
 * attempt records the axis it scored.
 *
 * v2 → v3 gives every hifz fingerprint row its ayah: `hifz_segment`,
 * `anchor_word` and `hifz_transition` gain a NOT NULL `verse_key`, because
 * `position`, `word_position` and `to_word` restart at the start of each ayah
 * and one item can tile two of them.
 *
 * A version-1 database exists on real dev machines, so these steps UPGRADE
 * them. Nothing here recreates a table from the DDL, and nothing here is allowed
 * to drop a user row: `hifz_attempt` is the append-only history every stability
 * number is computed from (AGENTS.md #6, and `docs/data-model.md`).
 */
export const MIGRATIONS: Migration[] = [
  {
    to: 2,
    describe:
      'hifz dual axis: split item stability into form/meaning, address each segment meaning by the pack that carries it, and label every attempt with the axis it scored',
    up: migrateV1ToV2,
  },
  {
    to: 3,
    describe:
      'hifz fingerprint identity: hifz_segment, anchor_word and hifz_transition each carry the verse_key their position counts from',
    up: migrateV2ToV3,
  },
];

/** `PRAGMA table_info` for one table; empty when the table does not exist. */
async function tableColumns(client: SqlClient, table: string): Promise<string[]> {
  const rows = await client.select<{ name: string }>(`PRAGMA table_info(${table})`);
  return rows.map((r) => r.name);
}

/** The stored `CREATE TABLE` text, so a CHECK constraint can be inspected. */
async function tableDdl(client: SqlClient, table: string): Promise<string> {
  const row = await client.select<{ sql: string | null }>(
    "SELECT sql AS sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    [table],
  );
  return row[0]?.sql ?? '';
}

/** Column list of the v2 `hifz_segment`, in contract order. Mirrors `db.sql`. */
const HIFZ_SEGMENT_V2_COLUMNS = [
  'id', 'item_id', 'position', 'from_word', 'to_word', 'text',
  'meaning_text', 'meaning_lang', 'meaning_pack', 'meaning_word_gloss',
  'stability', 'meaning_stability', 'error_count',
] as const;

const HIFZ_SEGMENT_V2_BODY = `(
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
)`;

const HIFZ_ATTEMPT_V2_COLUMNS = [
  'id', 'item_id', 'verse_key', 'session_id', 'mode', 'dimension', 'started_at',
  'completed_at', 'produced', 'cue', 'expected_word_count', 'correct_word_count',
  'accuracy', 'errors', 'duration_ms', 'self_confidence', 'used_audio',
] as const;

/**
 * The v2 body, copied from `core/src/contracts/db.sql` verbatim except for the
 * `mode` CHECK, which is generated from `RECALL_MODES` so the constraint this
 * migration installs cannot drift from the contract it is built to match.
 */
function hifzAttemptV2Body(modes: readonly string[]): string {
  return `(
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES hifz_item(id) ON DELETE CASCADE,
  verse_key TEXT NOT NULL,
  session_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN (${modes.map((m) => `'${m}'`).join(',')})),
  dimension TEXT NOT NULL CHECK (dimension IN ('form','meaning')),
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
)`;
}

/**
 * The documented safe SQLite table rebuild: create the new shape beside the old
 * one, copy, drop, rename, restore the indexes. It runs inside the caller's
 * transaction, with `PRAGMA foreign_keys` already OFF — which is what lets the
 * old table be dropped while rows still point at its name.
 */
async function rebuildTable(
  client: SqlClient,
  table: string,
  body: string,
  columns: readonly string[],
  selectList: string,
  indexes: readonly string[],
): Promise<void> {
  const temp = `${table}__v2`;
  await client.execute(`CREATE TABLE ${temp} ${body}`);
  await client.execute(`INSERT INTO ${temp} (${columns.join(', ')}) SELECT ${selectList} FROM ${table}`);
  await client.execute(`DROP TABLE ${table}`);
  await client.execute(`ALTER TABLE ${temp} RENAME TO ${table}`);
  for (const index of indexes) await client.execute(index);
}

/** The union of modes v2 admits, from the shared contract. */
async function contractModes(): Promise<string[]> {
  // Imported lazily so this module stays loadable in a build that has not
  // resolved `@quran/core` yet (the browser shell bundles it the same way).
  const core = await import('@quran/core');
  return [...core.RECALL_MODES];
}

async function migrateV1ToV2(client: SqlClient): Promise<void> {
  const itemColumns = await tableColumns(client, 'hifz_item');
  const segmentColumns = await tableColumns(client, 'hifz_segment');
  const attemptColumns = await tableColumns(client, 'hifz_attempt');
  const attemptDdl = await tableDdl(client, 'hifz_attempt');

  // Two different v1 files exist: one built from the v1 DDL, and one built from
  // the v2 DDL while `SCHEMA_VERSION` still said 1 (the columns landed in the
  // contract before the bump). `ALTER TABLE … ADD COLUMN` throws `duplicate
  // column name` on the second, which would lock the user out of their own
  // database, so every step below probes before it writes.
  const addItemForm = !itemColumns.includes('form_stability');
  const addItemMeaning = !itemColumns.includes('meaning_stability');
  const segmentLegacy = segmentColumns.includes('meaning_fa') || segmentColumns.includes('meaning_source');
  const rebuildSegment =
    segmentLegacy || !HIFZ_SEGMENT_V2_COLUMNS.every((column) => segmentColumns.includes(column));
  const rebuildAttempt = !attemptColumns.includes('dimension') || !/'meaning-to-arabic'/.test(attemptDdl);
  const modes = await contractModes();

  /**
   * `PRAGMA foreign_keys` is a connection setting and a documented no-op inside
   * a transaction, so it is switched OFF here and restored after the COMMIT —
   * not because the gateway wanted it off, but because the rebuild below drops
   * and recreates tables that other rows reference.
   */
  await client.execute('PRAGMA foreign_keys = OFF');
  await client.execute('BEGIN');
  try {
    if (addItemForm) await client.execute('ALTER TABLE hifz_item ADD COLUMN form_stability REAL NOT NULL DEFAULT 0');
    // Nullable, with no DEFAULT: SQLite fills existing rows with NULL, which is
    // the only value that can mean "this axis was never probed". A `NOT NULL
    // DEFAULT 0` here would store a claim of failure for a drill nobody offered.
    if (addItemMeaning) await client.execute('ALTER TABLE hifz_item ADD COLUMN meaning_stability REAL');
    if (addItemForm || addItemMeaning) {
      /**
       * A v1 item only ever had form evidence — v1 had no meaning drill to
       * score — so its `stability` *is* its form stability, and the meaning axis
       * starts life untested: NULL, exactly as the segment migration below
       * leaves it and exactly as `contracts/db.sql` defines the column. Zero is
       * reserved for "probed and failed", and min(form, 0) would drop every
       * migrated ayah to band `new` on the next recompute while the scheduler
       * sent a permanent, unfalsifiable meaning drill after it.
       *
       * `stability` itself is left exactly as it was: the composite is the
       * engine's to recompute from the attempt history on the next graded
       * recall, and rewriting it here would be this migration inventing a
       * number instead of moving one.
       */
      await client.execute('UPDATE hifz_item SET form_stability = stability, meaning_stability = NULL');
    }

    if (rebuildSegment) {
      const select = segmentLegacy
        ? `id, item_id, position, from_word, to_word, text,
             meaning_fa,
             CASE WHEN meaning_fa IS NOT NULL AND TRIM(meaning_fa) <> '' THEN 'fa' ELSE NULL END,
             CASE WHEN meaning_source IS NOT NULL AND EXISTS (
                    SELECT 1 FROM content_pack cp WHERE cp.id = hifz_segment.meaning_source
                  ) THEN meaning_source ELSE NULL END,
             0,
             stability,
             NULL,
             error_count`
        : HIFZ_SEGMENT_V2_COLUMNS.join(', ');
      // The v1 label was never a word gloss: `meaning_fa` held either a
      // fixture/editorial sentence or the user's own note, so `meaning_word_gloss`
      // is 0 for every row carried over, and `meaning_source` only survives as
      // `meaning_pack` when a real pack answers that id.
      await rebuildTable(client, 'hifz_segment', HIFZ_SEGMENT_V2_BODY, HIFZ_SEGMENT_V2_COLUMNS, select, []);
    }

    if (rebuildAttempt) {
      // SQLite cannot widen a CHECK with ALTER, so the table is rebuilt to make
      // room for the two meaning modes. Every existing row was scored under v1's
      // form-only mode list, hence `'form'`; a file that already carries a
      // `dimension` keeps what it stored rather than being relabelled.
      const dimension = attemptColumns.includes('dimension') ? "COALESCE(dimension, 'form')" : "'form'";
      await rebuildTable(
        client,
        'hifz_attempt',
        hifzAttemptV2Body(modes),
        HIFZ_ATTEMPT_V2_COLUMNS,
        `id, item_id, verse_key, session_id, mode, ${dimension}, started_at, completed_at,
            produced, cue, expected_word_count, correct_word_count, accuracy, errors,
            duration_ms, self_confidence, used_audio`,
        ['CREATE INDEX attempt_item_idx ON hifz_attempt(item_id, started_at)'],
      );
    }

    // The rebuild is only trustworthy if nothing dangling was left behind:
    // `foreign_key_check` answers one row per violation, and a non-empty answer
    // rolls the whole step back instead of shipping a half-linked database.
    const violations = await client.select<Record<string, unknown>>('PRAGMA foreign_key_check');
    if (violations.length > 0) {
      throw new Error(
        `migration to v2 aborted: ${violations.length} foreign key violation(s) after the rebuild ` +
          `(first: ${JSON.stringify(violations[0])})`,
      );
    }
    await client.execute('COMMIT');
  } catch (error) {
    await client.execute('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    // Back ON: the gateway asserts it on every open, and a migration that left
    // it off would make the RESTRICT rules the content paths rely on inert.
    await client.execute('PRAGMA foreign_keys = ON');
  }
}

/**
 * The three hifz fingerprint tables as v3 defines them, plus how an older row
 * becomes a new one. `columns` and `body` mirror `core/src/contracts/db.sql`.
 */
interface FingerprintRebuild {
  readonly table: string;
  readonly columns: readonly string[];
  readonly body: string;
  /** The old row's values, with the derived `verse_key` in its column slot. */
  row(old: Record<string, unknown>, verseKey: string): unknown[];
}

/** A column a pre-v2 file may genuinely not have yet reads as SQL NULL. */
function value(old: Record<string, unknown>, column: string): unknown {
  return old[column] ?? null;
}

const FINGERPRINT_V3: readonly FingerprintRebuild[] = [
  {
    table: 'hifz_segment',
    columns: [
      'id', 'item_id', 'verse_key', 'position', 'from_word', 'to_word', 'text',
      'meaning_text', 'meaning_lang', 'meaning_pack', 'meaning_word_gloss',
      'stability', 'meaning_stability', 'error_count',
    ],
    body: `(
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES hifz_item(id) ON DELETE CASCADE,
  verse_key TEXT NOT NULL,
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
  UNIQUE (item_id, verse_key, position)
)`,
    row: (old, verseKey) => [
      value(old, 'id'), value(old, 'item_id'), verseKey, value(old, 'position'),
      value(old, 'from_word'), value(old, 'to_word'), value(old, 'text'),
      value(old, 'meaning_text'), value(old, 'meaning_lang'), value(old, 'meaning_pack'),
      value(old, 'meaning_word_gloss'), value(old, 'stability'),
      value(old, 'meaning_stability'), value(old, 'error_count'),
    ],
  },
  {
    table: 'anchor_word',
    columns: ['id', 'item_id', 'verse_key', 'word_position', 'text', 'role', 'stability'],
    body: `(
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES hifz_item(id) ON DELETE CASCADE,
  verse_key TEXT NOT NULL,
  word_position INTEGER NOT NULL,
  text TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('opening','middle','ending','boundary')),
  stability REAL NOT NULL DEFAULT 0,
  UNIQUE (item_id, verse_key, word_position, role)
)`,
    row: (old, verseKey) => [
      value(old, 'id'), value(old, 'item_id'), verseKey, value(old, 'word_position'),
      value(old, 'text'), value(old, 'role'), value(old, 'stability'),
    ],
  },
  {
    table: 'hifz_transition',
    columns: [
      'id', 'item_id', 'verse_key', 'kind', 'to_verse_key', 'to_word',
      'success_count', 'failure_count', 'stability', 'last_practiced_at',
    ],
    body: `(
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES hifz_item(id) ON DELETE CASCADE,
  verse_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('intra','inter')),
  to_verse_key TEXT,
  to_word INTEGER NOT NULL,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  stability REAL NOT NULL DEFAULT 0,
  last_practiced_at TEXT,
  UNIQUE (item_id, verse_key, kind, to_word, to_verse_key)
)`,
    row: (old, verseKey) => [
      value(old, 'id'), value(old, 'item_id'), verseKey, value(old, 'kind'),
      value(old, 'to_verse_key'), value(old, 'to_word'), value(old, 'success_count'),
      value(old, 'failure_count'), value(old, 'stability'), value(old, 'last_practiced_at'),
    ],
  },
];

/**
 * The ayah each stored item's fingerprint rows can belong to, or null when the
 * item spans more than one ayah and only the row's own id can say.
 *
 * A single-ayah item is not a guess: every chunk, anchor and boundary of an item
 * enrolled for `112:1` is in `112:1`. For a multi-ayah item the position columns
 * restart per ayah, so the only honest source is the id the engine wrote.
 */
async function itemAyahOf(client: SqlClient): Promise<Map<string, string | null>> {
  const rows = await client.select<{ id: string; verse_key: string; sequence: string }>(
    'SELECT id, verse_key, sequence FROM hifz_item',
  );
  const out = new Map<string, string | null>();
  for (const row of rows) {
    let sequence: unknown = null;
    try {
      sequence = JSON.parse(row.sequence);
    } catch {
      sequence = null;
    }
    const spans = Array.isArray(sequence) ? sequence.length : 0;
    out.set(row.id, spans === 1 ? row.verse_key : null);
  }
  return out;
}

/**
 * Rebuild the fingerprint tables so each row names its ayah.
 *
 * The ayah comes from the row id, which the engine has always written as
 * `{itemId}:{verseKey}:{tag}{n}` — recovery, never invention, exactly as the
 * backup reader does it (`core/src/backup/restore.ts`). A row whose id says
 * nothing and whose item spans several ayat cannot be placed, so the whole step
 * rolls back rather than filing a chunk of the second ayah under the first one.
 */
async function migrateV2ToV3(client: SqlClient): Promise<void> {
  const pending: Array<{ spec: FingerprintRebuild; rows: unknown[][] }> = [];
  for (const spec of FINGERPRINT_V3) {
    const columns = await tableColumns(client, spec.table);
    // A file that never had the table has nothing to place, and a file built
    // from the v3 DDL before the version bump already carries the column.
    if (columns.length === 0 || columns.includes('verse_key')) continue;
    const rows = await client.select<Record<string, unknown>>(`SELECT * FROM ${spec.table}`);
    if (rows.length === 0) {
      pending.push({ spec, rows: [] });
      continue;
    }
    const ayahOf = await itemAyahOf(client);
    // Resolved the same way `contractModes()` does: this module has to stay
    // loadable before `@quran/core` resolves, in the browser shell too.
    const { verseKeyFromFingerprintId } = await import('@quran/core');
    pending.push({
      spec,
      rows: rows.map((old) => {
        const id = String(old.id ?? '');
        const verseKey =
          verseKeyFromFingerprintId(id) ?? ayahOf.get(String(old.item_id ?? '')) ?? null;
        if (verseKey === null) {
          throw new Error(
            `migration to v3 aborted: ${spec.table} row "${id}" gives no verse key in its id ` +
              `and belongs to a multi-ayah item, so its position could not be placed in an ayah. ` +
              'Nothing was written.',
          );
        }
        return spec.row(old, verseKey);
      }),
    });
  }
  if (pending.length === 0) return;

  await client.execute('PRAGMA foreign_keys = OFF');
  await client.execute('BEGIN');
  try {
    for (const { spec, rows } of pending) {
      const temp = `${spec.table}__v3`;
      await client.execute(`CREATE TABLE ${temp} ${spec.body}`);
      // One statement per chunk, not per row: this runs before the window is up,
      // and the import measurement in `docs/performance.md` priced a round trip
      // per statement.
      await insertRows(client, temp, spec.columns, rows);
      await client.execute(`DROP TABLE ${spec.table}`);
      await client.execute(`ALTER TABLE ${temp} RENAME TO ${spec.table}`);
    }
    const violations = await client.select<Record<string, unknown>>('PRAGMA foreign_key_check');
    if (violations.length > 0) {
      throw new Error(
        `migration to v3 aborted: ${violations.length} foreign key violation(s) after the rebuild ` +
          `(first: ${JSON.stringify(violations[0])})`,
      );
    }
    await client.execute('COMMIT');
  } catch (error) {
    await client.execute('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.execute('PRAGMA foreign_keys = ON');
  }
}

/** Strip line comments and split on statement boundaries. */
export function splitStatements(sql: string): string[] {
  const lines = sql
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  return lines
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** PRAGMAs cannot run inside a transaction, so they are issued separately. */
export function splitPragmas(statements: string[]): { pragmas: string[]; ddl: string[] } {
  const pragmas: string[] = [];
  const ddl: string[] = [];
  for (const stmt of statements) {
    (/^pragma\b/i.test(stmt) ? pragmas : ddl).push(stmt);
  }
  return { pragmas, ddl };
}

export async function readSchemaVersion(client: SqlClient): Promise<number | null> {
  const tables = await client.select<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
  );
  if (tables.length === 0) return null;
  const rows = await client.select<{ value: string }>(
    'SELECT value FROM meta WHERE key = ?',
    [META_KEYS.schemaVersion],
  );
  const raw = rows[0]?.value;
  if (raw === undefined) return 0; // an existing DB with no version row
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface SchemaResult {
  version: number;
  created: boolean;
  migrationsRan: number[];
  /** `fts5` when the virtual table exists, `like` when SQLite lacks FTS5. */
  searchBackend: 'fts5' | 'like';
  notes: string[];
}

/**
 * Create or upgrade the database. Every statement is applied individually so a
 * single unsupported feature (FTS5 in a minimal SQLite build) degrades to an
 * explicit, reported fallback instead of losing the whole schema.
 */
export async function ensureSchema(client: SqlClient, databaseLabel: string | null): Promise<SchemaResult> {
  const notes: string[] = [];
  const found = await readSchemaVersion(client);
  if (found !== null && found > SCHEMA_VERSION) {
    throw new SchemaTooNewError(found, SCHEMA_VERSION, databaseLabel);
  }

  if (found === null) {
    const { pragmas, ddl } = splitPragmas(splitStatements(SCHEMA_SQL));
    for (const pragma of pragmas) await client.execute(pragma);
    let ftsOk = true;
    for (const stmt of ddl) {
      try {
        await client.execute(stmt);
      } catch (err) {
        const text = String(err);
        if (/fts5|virtual table/i.test(stmt) && /no such module|unrecognized|syntax/i.test(text)) {
          ftsOk = false;
          // The read path still needs the table to exist: create the plain
          // stand-in so the import writer and the normalised substring matching
          // work unchanged, and only the MATCH/bm25 accelerator is missing.
          await client.execute(SEARCH_FALLBACK_DDL).catch(() => undefined);
          notes.push(
            'SQLite in this build has no FTS5 module, so the `ayah_search` virtual table was replaced by a plain table ' +
              'with the same columns. Search runs on normalised substring (LIKE) matching over every column, including ' +
              'Arabic, and is labelled as such everywhere.',
          );
          continue;
        }
        throw new Error(`schema statement failed: ${stmt.slice(0, 60)}… — ${text}`);
      }
    }
    await client.execute('INSERT INTO meta (key, value) VALUES (?, ?)', [
      META_KEYS.schemaVersion,
      String(SCHEMA_VERSION),
    ]);
    await client.execute('INSERT INTO meta (key, value) VALUES (?, ?)', [
      META_KEYS.createdAt,
      new Date().toISOString(),
    ]);
    await client.execute('INSERT INTO meta (key, value) VALUES (?, ?)', [
      META_KEYS.migrations,
      '[]',
    ]);
    return {
      version: SCHEMA_VERSION,
      created: true,
      migrationsRan: [],
      searchBackend: ftsOk && ddl.some((s) => /ayah_search/i.test(s)) ? 'fts5' : 'like',
      notes,
    };
  }

  // Existing database at found <= SCHEMA_VERSION: apply the chain.
  // `ayah_search` is reported from what is actually in the file: an FTS5 virtual
  // table answers `fts5`, a plain stand-in table (or nothing) answers `like`.
  // The gateway rebuilds whichever exists into the current matching form before
  // the first search, so a stored index can never outlive the rules it needs.
  const migrationsRan: number[] = [];
  let ftsProbe: 'fts5' | 'like' = 'like';
  try {
    const hit = await client.select<{ sql: string | null }>(
      "SELECT sql AS sql FROM sqlite_master WHERE type IN ('table','view') AND name = 'ayah_search'",
    );
    ftsProbe = /fts5/i.test(hit[0]?.sql ?? '') ? 'fts5' : 'like';
  } catch {
    ftsProbe = 'like';
  }
  if (found !== undefined && found < SCHEMA_VERSION) {
    for (const step of MIGRATIONS.filter((m) => m.to > (found ?? 0))) {
      await step.up(client);
      migrationsRan.push(step.to);
    }
    await client.execute(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [META_KEYS.schemaVersion, String(SCHEMA_VERSION)],
    );
  }
  return {
    version: SCHEMA_VERSION,
    created: false,
    migrationsRan,
    searchBackend: ftsProbe,
    notes: migrationsRan.length
      ? [`Applied migrations: ${migrationsRan.join(', ')}`]
      : ['Schema already current'],
  };
}
