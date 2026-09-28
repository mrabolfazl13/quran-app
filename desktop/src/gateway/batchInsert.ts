/**
 * Chunked multi-row INSERTs for bulk content writes.
 *
 * The reason is measured, not assumed: writing one record per `execute()` call
 * means one Tauri IPC per record, and the shipped import has 111,776 of them
 * (114 surahs, 6,236 ayahs, 83,665 words, 18,708 translations, 1,313 tafsirs,
 * 1,732 similar pairs, 8 packs). On the installed app that took 164 s of wall
 * clock — and, because every statement waits behind the gateway's queue, the
 * whole UI was reading "loading…" for all of it.
 *
 * Values stay on the binding path: the tuple is `?,?,?…` and the data goes as
 * parameters, so revealed text is written byte-exactly with no quoting or
 * escaping step anywhere in this file. Only the number of rows per statement is
 * limited, and it is limited by SQLite's parameter ceiling rather than by
 * guesswork. The search index already wrote this way; this makes the content
 * tables do the same.
 */
import type { SqlWriter } from './search';

/**
 * SQLite's own default ceiling is 32,766 variables per statement in modern
 * builds and 999 in older ones; 900 keeps every chunk legal on either, with
 * headroom for the widest table in the plan.
 */
export const MAX_PARAMS_PER_STATEMENT = 900;

/**
 * Insert `rows` into `table`, one value per `columns` entry, in as few
 * statements as the parameter ceiling allows. `table` and `columns` are
 * literals from the caller — never data from a pack.
 */
export async function insertRows(
  client: SqlWriter,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
): Promise<void> {
  if (rows.length === 0) return;
  const perStatement = Math.max(1, Math.floor(MAX_PARAMS_PER_STATEMENT / columns.length));
  const tuple = `(${columns.map(() => '?').join(', ')})`;
  const header = `INSERT INTO ${table} (${columns.join(', ')}) VALUES `;
  for (let i = 0; i < rows.length; i += perStatement) {
    const chunk = rows.slice(i, i + perStatement);
    await client.execute(header + chunk.map(() => tuple).join(', '), chunk.flat());
  }
}
