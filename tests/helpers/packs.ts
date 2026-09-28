/**
 * Content pack builders for tests, writing the real on-disk format:
 *
 *   <pack-dir>/pack.json      — `{ manifest: ContentPackManifest }`
 *   <pack-dir>/payload.jsonl  — one JSON record per line
 *   <pack-dir>/index.json     — `{ schemaVersion, builtAt, packs: [...] }`
 *
 * `checksum` is a genuine sha256 over the payload bytes, `payloadBytes` is the
 * real byte length and `recordCount` the real line count, so a test can prove
 * the importer verified them instead of trusting the manifest (AGENTS.md
 * non-negotiable 1, docs/architecture.md "a pack whose checksum fails is never
 * imported"). Corruption helpers produce packs that must be refused.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ContentPackFile,
  ContentPackManifest,
  PackIndex,
  PackKind,
} from '../../core/src/contracts/content-pack';
import { CONTENT_PACK_SCHEMA_VERSION } from '../../core/src/contracts/content-pack';
import { fixtureAyahRecords, fixtureAyahs, TRANSLATION_PACKS } from './corpus';

export const PACK_FILE_NAME = 'pack.json';
export const PAYLOAD_FILE_NAME = 'payload.jsonl';
export const INDEX_FILE_NAME = 'index.json';

export interface BuiltPack {
  dir: string;
  packPath: string;
  payloadPath: string;
  manifest: ContentPackManifest;
  checksum: string;
  payloadBytes: number;
  recordCount: number;
}

export interface BuildPackOptions<T> {
  records: T[];
  dir?: string;
  id?: string;
  kind?: PackKind;
  version?: string;
  language?: ContentPackManifest['language'];
  title?: string;
  source?: string;
  /** Last word on the manifest — e.g. to write an intentionally wrong checksum. */
  patch?: (manifest: ContentPackManifest) => ContentPackManifest;
}

export function createTempPackDir(name = 'quran-pack'): string {
  return mkdtempSync(join(tmpdir(), `${name}-`));
}

export function disposeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  } catch {
    // best effort; %TEMP% is reclaimed by the OS
  }
}

export function sha256HexOfBytes(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Base manifest with every required field filled by a test-meaningful value. */
export function baseManifest(
  overrides: Partial<ContentPackManifest> & { id?: string; kind?: PackKind } = {},
): ContentPackManifest {
  return {
    id: overrides.id ?? 'quran-core-test',
    kind: overrides.kind ?? 'quran-core',
    version: overrides.version ?? '0.0.0-test',
    schemaVersion: overrides.schemaVersion ?? CONTENT_PACK_SCHEMA_VERSION,
    language: overrides.language ?? 'ar',
    title: overrides.title ?? 'QA test pack',
    source: overrides.source ?? 'tests/helpers/packs.ts',
    license: overrides.license ?? {
      spdx: null,
      name: 'QA fixture — not shippable content',
      url: null,
      status: 'attribution-required',
      notes: 'test-only pack; never bundled with the app',
    },
    attribution: overrides.attribution ?? {
      publisher: 'QA harness',
      work: 'synthetic test pack',
      edition: null,
      sourceUrl: 'https://example.invalid/qa',
      retrievedAt: '2026-01-01T00:00:00.000Z',
      creditLine: 'test fixture',
    },
    checksum: overrides.checksum ?? '0'.repeat(64),
    payloadBytes: overrides.payloadBytes ?? 0,
    recordCount: overrides.recordCount ?? 0,
    coverage: overrides.coverage ?? { chapters: [1] },
    generatedAt: overrides.generatedAt ?? '2026-01-01T00:00:00.000Z',
    generator: overrides.generator ?? 'tests/helpers/packs.ts',
  };
}

/**
 * Write a pack to disk with a real checksum. The manifest is derived from the
 * payload, so `checksum`, `payloadBytes` and `recordCount` always describe the
 * bytes actually written unless `patch` overwrites them on purpose.
 */
export function buildPack<T>(options: BuildPackOptions<T>): BuiltPack {
  const dir = options.dir ?? createTempPackDir();
  const payload = serializeJsonl(options.records);
  const bytes = Buffer.from(payload, 'utf-8');
  const checksum = sha256HexOfBytes(bytes);
  let manifest = baseManifest({
    id: options.id,
    kind: options.kind,
    version: options.version,
    language: options.language,
    title: options.title,
    source: options.source,
    checksum,
    payloadBytes: bytes.byteLength,
    recordCount: options.records.length,
  });
  if (options.patch) manifest = options.patch(manifest);
  const packPath = join(dir, PACK_FILE_NAME);
  const payloadPath = join(dir, PAYLOAD_FILE_NAME);
  writeFileSync(packPath, `${JSON.stringify({ manifest } satisfies { manifest: ContentPackManifest }, null, 2)}\n`, 'utf-8');
  writeFileSync(payloadPath, payload, 'utf-8');
  return {
    dir,
    packPath,
    payloadPath,
    manifest,
    checksum,
    payloadBytes: bytes.byteLength,
    recordCount: options.records.length,
  };
}

export function serializeJsonl(records: readonly unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : '');
}

export function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

/** Load a pack from disk into the contract shape (`ContentPackFile`). */
export function readPack<T = Record<string, unknown>>(packPath: string): ContentPackFile<T> {
  const dir = packPath.replace(/[\\/][^\\/]+$/, '');
  const manifest = JSON.parse(readFileSync(packPath, 'utf-8')).manifest as ContentPackManifest;
  return { manifest, records: readJsonl<T>(join(dir, PAYLOAD_FILE_NAME)) };
}

export interface PackChecksumReport {
  ok: boolean;
  manifestChecksum: string;
  actualChecksum: string;
  manifestPayloadBytes: number;
  actualPayloadBytes: number;
  manifestRecordCount: number;
  actualRecordCount: number;
  failures: string[];
}

/**
 * The verification the importer is required to perform *before* writing a row.
 * Tests use it as the oracle: a pack reported not-ok here must not change the
 * database at all.
 */
export function checkPackOnDisk(packPath: string): PackChecksumReport {
  const dir = packPath.replace(/[\\/][^\\/]+$/, '');
  const manifest = JSON.parse(readFileSync(packPath, 'utf-8')).manifest as ContentPackManifest;
  const bytes = readFileSync(join(dir, PAYLOAD_FILE_NAME));
  const actualChecksum = sha256HexOfBytes(bytes);
  const failures: string[] = [];
  if (manifest.checksum !== actualChecksum) {
    failures.push(`checksum mismatch: manifest ${manifest.checksum}, payload ${actualChecksum}`);
  }
  if (manifest.payloadBytes !== bytes.byteLength) {
    failures.push(`payload_bytes mismatch: manifest ${manifest.payloadBytes}, file ${bytes.byteLength}`);
  }
  const lines = readFileSync(join(dir, PAYLOAD_FILE_NAME), 'utf-8').split('\n').filter((l) => l.trim()).length;
  if (manifest.recordCount !== lines) {
    failures.push(`record_count mismatch: manifest ${manifest.recordCount}, payload ${lines}`);
  }
  return {
    ok: failures.length === 0,
    manifestChecksum: manifest.checksum,
    actualChecksum,
    manifestPayloadBytes: manifest.payloadBytes,
    actualPayloadBytes: bytes.byteLength,
    manifestRecordCount: manifest.recordCount,
    actualRecordCount: lines,
    failures,
  };
}

/* ------------------------------------------------------------- corruption cases */

export interface TamperResult {
  /** The verse key / record whose payload text changed. */
  subject: string;
  before: string;
  after: string;
  /** The checksum the manifest still advertises — now a lie. */
  staleChecksum: string;
  newChecksum: string;
}

/**
 * Change exactly one character inside one payload record and leave the manifest
 * untouched. `checkPackOnDisk` must then fail, and an import must abort.
 */
export function tamperPayloadRecord(
  packPath: string,
  selector: (record: Record<string, unknown>, index: number) => boolean = (_r, i) => i === 0,
  mutate: (text: string) => string = (text) => `${text.slice(0, Math.max(1, text.length - 1))}ا`,
): TamperResult {
  const dir = packPath.replace(/[\\/][^\\/]+$/, '');
  const payloadPath = join(dir, PAYLOAD_FILE_NAME);
  const records = readJsonl<Record<string, unknown>>(payloadPath);
  const index = records.findIndex(selector);
  if (index < 0) throw new Error('tamperPayloadRecord: no record matched the selector');
  const record = records[index]!;
  const textField = pickTextField(record);
  const before = String(record[textField]);
  const after = mutate(before);
  records[index] = { ...record, [textField]: after };
  writeFileSync(payloadPath, serializeJsonl(records), 'utf-8');
  const manifest = JSON.parse(readFileSync(packPath, 'utf-8')).manifest as ContentPackManifest;
  return {
    subject: String(record['verse_key'] ?? record['verseKey'] ?? `record ${index}`),
    before,
    after,
    staleChecksum: manifest.checksum,
    newChecksum: sha256HexOfBytes(Buffer.from(serializeJsonl(records), 'utf-8')),
  };
}

function pickTextField(record: Record<string, unknown>): string {
  for (const key of ['text_uthmani', 'textUthmani', 'text']) {
    if (typeof record[key] === 'string' && (record[key] as string).length > 1) return key;
  }
  throw new Error(`tamperPayloadRecord: record has no text field: ${Object.keys(record).join(',')}`);
}

/** Drop trailing bytes so the payload is shorter than the manifest claims. */
export function truncatePayload(packPath: string, keepBytes = -8): number {
  const dir = packPath.replace(/[\\/][^\\/]+$/, '');
  const payloadPath = join(dir, PAYLOAD_FILE_NAME);
  const bytes = readFileSync(payloadPath);
  const end = keepBytes < 0 ? Math.max(0, bytes.byteLength + keepBytes) : keepBytes;
  writeFileSync(payloadPath, bytes.subarray(0, end));
  return end;
}

/** Delete payload lines so `record_count` no longer describes the file. */
export function dropPayloadRecords(packPath: string, count = 1): number {
  const dir = packPath.replace(/[\\/][^\\/]+$/, '');
  const payloadPath = join(dir, PAYLOAD_FILE_NAME);
  const records = readJsonl<Record<string, unknown>>(payloadPath);
  const kept = records.slice(0, Math.max(0, records.length - count));
  writeFileSync(payloadPath, serializeJsonl(kept), 'utf-8');
  return kept.length;
}

/** Rewrite the manifest (wrong checksum, wrong counts, future schemaVersion…). */
export function patchManifest(
  packPath: string,
  patch: (manifest: ContentPackManifest) => Partial<ContentPackManifest>,
): ContentPackManifest {
  const parsed = JSON.parse(readFileSync(packPath, 'utf-8')) as { manifest: ContentPackManifest };
  parsed.manifest = { ...parsed.manifest, ...patch(parsed.manifest) };
  writeFileSync(packPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
  return parsed.manifest;
}

/* ------------------------------------------------------------------ fixtures */

/** Ayah payload records in the snake_case shape the pipeline emits. */
export interface AyahPayloadRecord {
  verse_key: string;
  chapter: number;
  verse_number: number;
  text_uthmani: string;
  juz_number: number;
  hizb_number: number;
  rub_el_hizb_number: number;
  page_number: number;
  word_count: number;
  normalized_hash: string;
}

export function buildCorpusPack(dir = createTempPackDir('quran-corpus-pack')): BuiltPack & {
  records: AyahPayloadRecord[];
} {
  const ayahs = fixtureAyahRecords();
  const records: AyahPayloadRecord[] = ayahs.map((a) => ({
    verse_key: a.verseKey,
    chapter: a.chapter,
    verse_number: a.verse,
    text_uthmani: a.textUthmani,
    juz_number: a.juz,
    hizb_number: a.hizb,
    rub_el_hizb_number: a.rubElHizb,
    page_number: a.page,
    word_count: a.wordCount,
    normalized_hash: a.normalizedHash,
  }));
  const built = buildPack<AyahPayloadRecord>({
    dir,
    id: 'quran-core-uthmani',
    kind: 'quran-core',
    language: 'ar',
    title: 'QA corpus fixture pack',
    records,
  });
  return { ...built, records };
}

export interface TranslationPayloadRecord {
  verse_key: string;
  pack_id: string;
  text: string;
}

export function buildTranslationPack(
  resourceId: 85 | 135,
  dir = createTempPackDir('quran-translation-pack'),
): BuiltPack & { records: TranslationPayloadRecord[] } {
  const records: TranslationPayloadRecord[] = fixtureAyahs().map((a) => ({
    verse_key: a.verseKey,
    pack_id: TRANSLATION_PACKS[resourceId].packId,
    text: resourceId === 85 ? a.translationEn : a.translationFa,
  }));
  const built = buildPack<TranslationPayloadRecord>({
    dir,
    id: TRANSLATION_PACKS[resourceId].packId,
    kind: 'translation',
    language: TRANSLATION_PACKS[resourceId].language === 'en' ? 'en' : 'fa',
    title: TRANSLATION_PACKS[resourceId].title,
    records,
  });
  return { ...built, records };
}

/** `index.json` in the `PackIndex` shape, listing the packs that ship together. */
export function writePackIndex(dir: string, manifests: readonly ContentPackManifest[]): PackIndex {
  const index: PackIndex = {
    schemaVersion: CONTENT_PACK_SCHEMA_VERSION,
    builtAt: '2026-01-01T00:00:00.000Z',
    packs: [...manifests],
  };
  writeFileSync(join(dir, INDEX_FILE_NAME), `${JSON.stringify(index, null, 2)}\n`, 'utf-8');
  return index;
}
