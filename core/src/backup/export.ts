/**
 * Backup export: user-data rows in, `BackupEnvelope` out.
 *
 * Only the 14 user-data keys of `BackupUserData` (plus the `settings` record)
 * are ever exported. Unknown keys — including content tables like `ayah` or
 * `translation`, if a caller carelessly passes the whole DB — are dropped with
 * a warning: content packs ship with the app and must never round-trip
 * through a backup file (AGENTS.md non-negotiable #1: content is immutable).
 *
 * The checksum is sha256 over the canonical JSON of `data` ONLY — never of
 * `createdAt` — so two exports of identical data at different instants
 * produce identical checksums and are comparable.
 */

import { BACKUP_SCHEMA_VERSION, type BackupEnvelope, type BackupUserData } from '../contracts/backup';
import { canonicalJsonStringify, utf8Bytes } from './canonical-json';
import { sha256Hex } from './sha256';

/** The exact keys a backup may contain; anything else is refused. */
export const DATA_KEYS: readonly (keyof BackupUserData)[] = [
  'settings',
  'bookmarks',
  'notes',
  'readingPositions',
  'readingHistory',
  'hifzItems',
  'hifzSegments',
  'anchorWords',
  'hifzTransitions',
  'recallAttempts',
  'confusionGroups',
  'sessions',
  'journeys',
  'reflections',
  'dailyPlans',
];

export interface BackupExportMeta {
  app: string;
  version: string;
  platform: 'desktop' | 'mobile';
  /** ISO timestamp; defaults to the current time. Excluded from the checksum. */
  createdAt?: string;
  /** Defaults to `schemaVersion`; a file must never claim it needs a newer reader. */
  minReaderVersion?: number;
}

export interface BackupExportResult {
  envelope: BackupEnvelope;
  warnings: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Pull the 14 known keys out of arbitrary caller input, warning on the rest. */
export function selectUserData(rows: unknown): { data: BackupUserData; warnings: string[] } {
  const warnings: string[] = [];
  if (!isPlainObject(rows)) {
    throw new TypeError('buildEnvelope: rows must be a plain object keyed by BackupUserData fields');
  }
  const data = {} as BackupUserData;
  const writable = data as unknown as Record<string, unknown>;
  for (const key of DATA_KEYS) {
    const raw = (rows as Record<string, unknown>)[key];
    if (key === 'settings') {
      writable[key] = isPlainObject(raw) ? { ...raw } : {};
      if (raw !== undefined && !isPlainObject(raw)) {
        warnings.push('data.settings was not an object; exported as {}');
      }
      continue;
    }
    if (Array.isArray(raw)) {
      writable[key] = [...raw];
    } else {
      writable[key] = [];
      if (raw !== undefined) {
        warnings.push(`data.${key} was not an array; exported as []`);
      }
    }
  }
  for (const key of Object.keys(rows)) {
    if (!(DATA_KEYS as readonly string[]).includes(key)) {
      warnings.push(`refused non-user-data key "${key}": content tables are never exported`);
    }
  }
  return { data, warnings };
}

export function computeCounts(data: BackupUserData): BackupEnvelope['counts'] {
  const counts = {} as BackupEnvelope['counts'];
  for (const key of DATA_KEYS) {
    const v = data[key];
    counts[key] = key === 'settings' ? Object.keys(v as Record<string, unknown>).length : (v as unknown[]).length;
  }
  return counts;
}

/** sha256 (lowercase hex) over the canonical JSON of `data` only. */
export function computeDataChecksum(data: BackupUserData): string {
  return sha256Hex(utf8Bytes(canonicalJsonStringify(data)));
}

/**
 * Build a complete, verified-ready envelope. `data` is deep-copied key-wise;
 * values themselves are stored as given and serialised canonically, so the
 * caller must supply only JSON-safe values (see `canonical-json.ts`).
 */
export function buildEnvelope(rows: unknown, meta: BackupExportMeta): BackupExportResult {
  const { data, warnings } = selectUserData(rows);
  const schemaVersion = BACKUP_SCHEMA_VERSION;
  const envelope: BackupEnvelope = {
    schemaVersion,
    minReaderVersion: Math.min(meta.minReaderVersion ?? schemaVersion, schemaVersion),
    createdAt: meta.createdAt ?? new Date().toISOString(),
    producedBy: { app: meta.app, version: meta.version, platform: meta.platform },
    checksum: computeDataChecksum(data),
    counts: computeCounts(data),
    data,
  };
  return { envelope, warnings };
}

/** Serialise a whole envelope canonically — this is the bytes of a `.quranbak` file. */
export function serializeEnvelope(env: BackupEnvelope): string {
  return canonicalJsonStringify(env);
}
