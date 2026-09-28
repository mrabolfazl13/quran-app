/**
 * Repository paths shared by the QA suite. Everything is derived from this
 * file's own location so the suite runs from any working directory and on any
 * checkout path.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `tests/helpers` → repo root. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const TESTS_DIR = join(REPO_ROOT, 'tests');
export const FIXTURES_DIR = join(TESTS_DIR, 'fixtures');

/** Orchestrator-owned fixture: 31 real ayahs including the ar-Rahman refrain. */
export const CORPUS_FIXTURE_PATH = join(FIXTURES_DIR, 'corpus-sample.json');

/** Authoritative DDL (Architect-owned). Read, never copied. */
export const SCHEMA_PATH = join(REPO_ROOT, 'core', 'src', 'contracts', 'db.sql');

export const CORE_SRC_DIR = join(REPO_ROOT, 'core', 'src');
export const DESKTOP_SRC_DIR = join(REPO_ROOT, 'desktop', 'src');
export const DESKTOP_DIST_DIR = join(REPO_ROOT, 'desktop', 'dist');
export const CONTENT_DIR = join(REPO_ROOT, 'content');

/** Build-time provider captures — real text, used to shape DB fixtures. */
export const RAW_DIR = join(REPO_ROOT, 'data', 'raw', 'quran-com');
export const RAW_MANIFEST_PATH = join(REPO_ROOT, 'data', 'raw', 'manifest.json');

export function readSchemaSql(): string {
  return readFileSync(SCHEMA_PATH, 'utf-8');
}

export function repoPath(...parts: string[]): string {
  return join(REPO_ROOT, ...parts);
}

export function rawFile(name: string): string {
  return join(RAW_DIR, name);
}

export function pathExists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

const jsonCache = new Map<string, unknown | null>();

/**
 * Parse a JSON file at most once per process. The provider captures are
 * megabyte-scale and several suites read the same division/word files, so an
 * un-cached helper turned fixture seeding into a 12-second hook.
 */
export function readJsonIfExists<T>(p: string): T | null {
  if (jsonCache.has(p)) return jsonCache.get(p) as T | null;
  let parsed: T | null = null;
  try {
    parsed = JSON.parse(readFileSync(p, 'utf-8')) as T;
  } catch {
    parsed = null;
  }
  jsonCache.set(p, parsed);
  return parsed;
}

export function clearJsonCache(): void {
  jsonCache.clear();
}
