/**
 * Test helper: read the repo's captured provider rows from a unit test.
 *
 * The repository tsconfig does not load `@types/node` (see the same baseline
 * errors in `core/tests/backup`), so the built-ins are imported dynamically
 * through non-literal specifiers and `ImportMeta.url` is augmented locally.
 * This keeps `npx tsc --noEmit` clean for the mushaf tests without touching
 * shared config that another agent owns.
 */

declare global {
  interface ImportMeta {
    readonly url: string;
  }
}

const FS_SPEC = 'node:fs';
const PATH_SPEC = 'node:path';
const URL_SPEC = 'node:url';

const fsModule: any = await import(FS_SPEC);
const pathModule: any = await import(PATH_SPEC);
const urlModule: any = await import(URL_SPEC);
const processModule: any = await import('node:' + 'process');

/** Environment flag, read without pulling `@types/node` into the tsconfig. */
export function envFlag(name: string): boolean {
  const value = processModule?.env?.[name];
  return value === '1' || value === 'true';
}

const HERE = pathModule.dirname(urlModule.fileURLToPath(import.meta.url));

/** Absolute path from the repository root. */
export function repoPath(...segments: string[]): string {
  return pathModule.resolve(HERE, '..', '..', '..', ...segments);
}

export function exists(...segments: string[]): boolean {
  return fsModule.existsSync(repoPath(...segments)) as boolean;
}

export function readJson<T = any>(...segments: string[]): T {
  const filePath = repoPath(...segments);
  if (!fsModule.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  return JSON.parse(fsModule.readFileSync(filePath, 'utf8')) as T;
}

/** Raw text file from the repository root (pack payloads are JSONL, not JSON). */
export function readText(...segments: string[]): string {
  return fsModule.readFileSync(repoPath(...segments), 'utf8') as string;
}

export function fileSize(...segments: string[]): number {
  return (fsModule.statSync(repoPath(...segments)).size) as number;
}

/** One provider chapter response: `{ verses: [ { verse_key, words: [...] } ] }`. */
export interface ProviderWordRow {
  id: number;
  position: number;
  char_type_name: string;
  text_uthmani: string;
  page_number: number;
  line_number: number;
}

export interface ProviderWordVerse {
  id: number;
  verse_number: number;
  verse_key: string;
  chapter_number?: number;
  juz_number: number;
  hizb_number: number;
  page_number: number;
  words: ProviderWordRow[];
}

export interface ProviderDivisionVerse {
  id: number;
  verse_number: number;
  verse_key: string;
  juz_number: number;
  hizb_number: number;
  rub_el_hizb_number: number;
  sajdah_number: number | null;
  ruku_number: number | null;
  manzil_number: number | null;
  page_number: number;
  text_uthmani: string;
}

export function readWordRows(chapter: number): ProviderWordVerse[] {
  return readJson<{ verses: ProviderWordVerse[] }>('data', 'raw', 'quran-com', `words-${chapter}.json`)
    .verses;
}

export function readDivisions(chapter: number): ProviderDivisionVerse[] {
  return readJson<{ verses: ProviderDivisionVerse[] }>('data', 'raw', 'quran-com', `divisions-${chapter}.json`)
    .verses;
}
