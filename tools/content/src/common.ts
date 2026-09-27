/**
 * Shared helpers for the content pipeline: paths, raw-data provenance
 * manifest, sha256, and a resumable JSON fetcher for the Quran.com v4 API.
 *
 * Only Node built-ins are used (node:fs, node:path, node:crypto, global
 * fetch). Raw files are stored EXACTLY as received — bytes are never
 * rewritten, and nothing downstream may "repair" Quran text.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Repo root: tools/content/src -> ../../.. */
export const REPO_ROOT = resolve(here, '..', '..', '..');
export const RAW_ROOT = join(REPO_ROOT, 'data', 'raw');
export const RAW_PROVIDER_DIR = join(RAW_ROOT, 'quran-com');
export const RAW_MANIFEST_PATH = join(RAW_ROOT, 'manifest.json');
export const CONTENT_ROOT = join(REPO_ROOT, 'content');
export const CORE_PACKS = ['quran-core', 'word-data'] as const;

export const API_BASE = 'https://api.quran.com/api/v4';

/** One entry per downloaded file, so every raw byte is auditable. */
export interface RawFileRecord {
  url: string;
  /** sha256 hex over the exact bytes stored on disk. */
  sha256: string;
  bytes: number;
  fetchedAt: string;
}

export interface RawManifest {
  schemaVersion: number;
  base: string;
  files: Record<string, RawFileRecord>;
}

export function sha256hex(buf: Uint8Array | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

function loadManifest(): RawManifest {
  if (existsSync(RAW_MANIFEST_PATH)) {
    try {
      const m = JSON.parse(readFileSync(RAW_MANIFEST_PATH, 'utf8')) as RawManifest;
      if (m && typeof m.files === 'object') return m;
    } catch {
      /* corrupt manifest: rebuild from disk */
    }
  }
  return { schemaVersion: 1, base: API_BASE, files: {} };
}

let tmpCounter = 0;
function saveManifest(m: RawManifest): void {
  mkdirSync(dirname(RAW_MANIFEST_PATH), { recursive: true });
  // Unique temp name: concurrent fetch/build processes must never collide.
  const tmp = `${RAW_MANIFEST_PATH}.${process.pid}.${tmpCounter++}.tmp`;
  writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n');
  renameSync(tmp, RAW_MANIFEST_PATH);
}

/** Record provenance for a locally assembled file (e.g. paginated merge). */
export function updateManifestEntry(rel: string, rec: RawFileRecord): void {
  const m = loadManifest();
  m.files[rel] = rec;
  saveManifest(m);
}

export function removeManifestEntries(pred: (rel: string) => boolean): void {
  const m = loadManifest();
  for (const k of Object.keys(m.files)) if (pred(k)) delete m.files[k];
  saveManifest(m);
}

export function rawPath(rel: string): string {
  return join(RAW_ROOT, rel);
}

export function readRawJson<T = unknown>(rel: string): T {
  const buf = readFileSync(rawPath(rel));
  return JSON.parse(buf.toString('utf8')) as T;
}

export function rawExists(rel: string): boolean {
  return existsSync(rawPath(rel));
}

export function writeRawJson(rel: string, text: string, url: string): void {
  const p = rawPath(rel);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${tmpCounter++}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, p);
  const m = loadManifest();
  m.files[rel] = {
    url,
    sha256: sha256hex(Buffer.from(text, 'utf8')),
    bytes: Buffer.byteLength(text),
    fetchedAt: new Date().toISOString(),
  };
  saveManifest(m);
}

export function registerRawFile(rel: string): RawFileRecord | null {
  const p = rawPath(rel);
  if (!existsSync(p)) return null;
  const buf = readFileSync(p);
  const rec: RawFileRecord = {
    url: '(registered from disk)',
    sha256: sha256hex(buf),
    bytes: buf.length,
    fetchedAt: new Date().toISOString(),
  };
  const m = loadManifest();
  m.files[rel] = rec;
  saveManifest(m);
  return rec;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when the file exists, parses, passes `expect`, and its manifest
 * provenance (url + sha256 + bytes) matches exactly. Prevents a stale temp
 * file from one endpoint being reused for another (seen in practice). */
export function cachedValid<T = any>(rel: string, url: string, expect?: (body: unknown) => boolean): { ok: true; body: T } | { ok: false } {
  const p = rawPath(rel);
  if (!existsSync(p)) return { ok: false };
  const rec = loadManifest().files[rel];
  if (!rec || rec.url !== url) return { ok: false };
  let buf: Buffer;
  try {
    buf = readFileSync(p);
  } catch {
    return { ok: false };
  }
  if (sha256hex(buf) !== rec.sha256 || buf.length !== rec.bytes) return { ok: false };
  if (!expect) return { ok: true, body: JSON.parse(buf.toString('utf8')) as T };
  try {
    const body = JSON.parse(buf.toString('utf8'));
    return expect(body) ? { ok: true, body: body as T } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export interface FetchOptions {
  /** Polite inter-request delay in ms (default 120). */
  delayMs?: number;
}

/**
 * Download `url` into `data/raw/<rel>` (skipping an existing valid file),
 * record provenance in data/raw/manifest.json, return the parsed body.
 * Resumable: `expect` decides whether an existing file is valid enough to
 * skip re-downloading. Retries transient failures with backoff.
 */
export async function fetchJson<T = any>(
  rel: string,
  url: string,
  expect: (body: unknown) => boolean,
  opts: FetchOptions = {},
): Promise<T> {
  const path = rawPath(rel);
  const manifest = loadManifest();

  // Resume only when provenance is exact (same url, same bytes). A file on
  // disk whose manifest url differs is re-downloaded, never trusted.
  if (existsSync(path)) {
    const cached = cachedValid<T>(rel, url, expect as (b: unknown) => boolean);
    if (cached.ok) return cached.body;
    let body: unknown = null;
    try {
      body = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      body = null;
    }
    if (body !== null && expect(body)) {
      const rec = manifest.files[rel];
      const buf = readFileSync(path);
      if (!rec) {
        // file pre-dates the manifest (or the manifest lost a write): register
        // its real bytes rather than re-fetching identical content.
        manifest.files[rel] = {
          url,
          sha256: sha256hex(buf),
          bytes: buf.length,
          fetchedAt: new Date().toISOString(),
        };
        saveManifest(manifest);
        return body as T;
      }
      if (rec.sha256 === sha256hex(buf) && rec.url !== url) {
        console.warn(`  ! ${rel}: on-disk bytes registered for a DIFFERENT url — re-fetching`);
      }
    }
  }

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'quran-offline-content/0.1 (research build)' } });
      if (res.status === 429 || res.status >= 500) {
        const wait = attempt * 2000;
        console.warn(`  ! ${rel}: HTTP ${res.status}, retry in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const text = await res.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`Non-JSON response (starts ${JSON.stringify(text.slice(0, 80))}) from ${url}`);
      }
      if (!expect(body)) throw new Error(`Response failed shape check from ${url}`);
      mkdirSync(dirname(path), { recursive: true });
      const buf = Buffer.from(text, 'utf8');
      const tmp = `${path}.${process.pid}.${tmpCounter++}.tmp`;
      writeFileSync(tmp, buf);
      renameSync(tmp, path);
      manifest.files[rel] = { url, sha256: sha256hex(buf), bytes: buf.length, fetchedAt: new Date().toISOString() };
      saveManifest(manifest);
      await sleep(opts.delayMs ?? 120);
      return body as T;
    } catch (e) {
      lastErr = e;
      const wait = attempt * 1500;
      console.warn(`  ! ${rel}: ${String(e).slice(0, 160)} — retry ${attempt}/5 in ${wait}ms`);
      await sleep(wait);
    }
  }
  throw new Error(`fetch failed after 5 attempts: ${url}\n  last error: ${String(lastErr)}`);
}

/** Have a shape guard throw a readable message. */
export function assertShape(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`shape assertion failed: ${msg}`);
}

export const ALL_CHAPTERS: number[] = Array.from({ length: 114 }, (_, i) => i + 1);

/** 12 chapters spread across the mushaf for translation-alignment proofs. */
export const SAMPLE_CHAPTERS = [1, 2, 10, 18, 24, 36, 45, 55, 67, 78, 112, 114];

export const TRANSLATION_RESOURCES = [
  { resourceId: 85, packId: 'tr-en-abdulhaleem' },
  { resourceId: 135, packId: 'tr-fa-islamhouse' },
  { resourceId: 29, packId: 'tr-fa-kaldari' },
] as const;

export const TAFSIR_RESOURCES = [
  { resourceId: 16, packId: 'tafsir-ar-muyassar' },
  { resourceId: 169, packId: 'tafsir-en-ibnkathir' },
] as const;
