/**
 * A filesystem `PackSource` for tests.
 *
 * The shipped importer (`desktop/src/content/importer.ts`) reads packs through
 * the exported `PackSource` *interface* — Tauri asks Rust for bytes + digest,
 * the dev shell fetches `/content/…`. Neither of those exists in a plain Node
 * test, so QA implements the same contract over the repository/temp directory.
 * This is a real implementation of the contract, not a mock: the digests are
 * computed over the real bytes on disk, so the importer's checksum gate is
 * exercised for real.
 *
 * The path rules are the shipped ones: `assertSafeRel` is imported from the
 * production module so a rel path rejected by the app is rejected here too.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { assertSafeRel } from '../../desktop/src/content/packSource';
import type { PackAvailability, PackFile, PackFileStat, PackSource } from '../../desktop/src/content/packSource';

export interface FsPackSource extends PackSource {
  /** Absolute directory the rel paths are resolved against. */
  readonly rootDir: string;
  /** The pack ids this source can currently serve, for cheap assertions. */
  readonly packIds: string[];
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * `dir` may not exist (the "no content yet" state is a supported state), so
 * availability is computed per call rather than up front.
 */
export function createFsPackSource(dir: string): FsPackSource {
  const rootDir = resolve(dir);
  const abs = (rel: string): string => join(rootDir, rel);

  return {
    kind: 'fetch',
    location: rootDir,
    rootDir,
    get packIds() {
      const index = existsSync(abs('index.json')) ? readJsonOrNull<{ packs?: { id: string }[] }>(abs('index.json')) : null;
      return (index?.packs ?? []).map((p) => p.id);
    },
    async available(): Promise<PackAvailability> {
      const hasIndex = existsSync(abs('index.json'));
      return { root: hasIndex ? rootDir : null, hasIndex };
    },
    async stat(rel: string): Promise<PackFileStat | null> {
      assertSafeRel(rel);
      const p = abs(rel);
      if (!existsSync(p)) return null;
      const bytes = readFileSync(p);
      return { bytes: bytes.length, sha256: sha256(new Uint8Array(bytes)) };
    },
    async read(rel: string): Promise<PackFile> {
      assertSafeRel(rel);
      const p = abs(rel);
      if (!existsSync(p)) throw new Error(`content file missing: ${rel}`);
      const bytes = readFileSync(p);
      return {
        rel,
        bytes: bytes.length,
        sha256: sha256(new Uint8Array(bytes)),
        text: bytes.toString('utf-8'),
      };
    },
  };
}

function readJsonOrNull<T>(p: string): T | null {
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as T;
  } catch {
    return null;
  }
}

/** The repository's own build output — the packs the app actually ships with. */
export const REPO_CONTENT_DIR = resolve(import.meta.dirname, '..', '..', 'content');
