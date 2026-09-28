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

/** Keep in step with the "-- SQLite schema, version N" header of db.sql. */
export const SCHEMA_VERSION = 1;

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
 * Migration chain stub. A v1 database is created straight from the contract, so
 * there is nothing to migrate yet; when v2 lands, append one entry here and the
 * runner below applies them in order inside one transaction.
 */
export const MIGRATIONS: Migration[] = [];

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
