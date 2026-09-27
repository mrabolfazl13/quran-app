/**
 * Backup file inspection: parse → structure → checksum → counts → per-row
 * semantics → cross-row reference integrity.
 *
 * §47 security requirement: NOTHING in here throws on hostile input. Every
 * failure mode — truncated JSON, wrong types, null bytes, absurd nesting —
 * comes back as a failed `InspectionResult`. A malformed file must never be
 * able to crash or trick the restore path.
 *
 * Dangling references (e.g. a hifz attempt whose item is not in the file) are
 * ERRORS by default. They are only removed in an explicit, user-confirmed
 * "drop orphans" mode, which reports every dropped row and re-seals the
 * envelope — never a silent delete.
 */

import { BACKUP_SCHEMA_VERSION, type BackupEnvelope, type BackupUserData } from '../contracts/backup';
import { PAGE_COUNT, SURAH_COUNT } from '../contracts/quran';
import type { ErrorKind, RecallMode } from '../contracts/hifz';
import { canonicalJsonStringify, utf8Bytes } from './canonical-json';
import { computeCounts, computeDataChecksum, DATA_KEYS } from './export';
import { settingKeys } from './settings';

/** Hard cap on accepted file size, before any parsing. */
export const MAX_BACKUP_BYTES = 20 * 1024 * 1024;

export const VERSE_KEY_RE = /^\d{1,3}:\d{1,4}$/;

export const ERROR_KIND_VALUES = [
  'correct',
  'omission',
  'substitution',
  'repetition',
  'wrong-order',
  'wrong-transition',
  'similar-ayah-confusion',
  'beginning-failure',
  'middle-failure',
  'ending-failure',
] as const satisfies readonly ErrorKind[];
type _ErrorKindsComplete = ErrorKind extends (typeof ERROR_KIND_VALUES)[number] ? true : never;
export const _errorKindsComplete: _ErrorKindsComplete = true;

export const RECALL_MODE_VALUES = [
  'segment',
  'opening',
  'middle',
  'ending',
  'transition',
  'continue-ayah',
  'continue-sequence',
  'missing-word',
  'first-word-cue',
  'last-word-cue',
  'reverse',
  'random',
  'audio-recall',
  'full-ayah',
  'full-sequence',
] as const satisfies readonly RecallMode[];
type _ModesComplete = RecallMode extends (typeof RECALL_MODE_VALUES)[number] ? true : never;
export const _modesComplete: _ModesComplete = true;

export type ValidationErrorCode =
  | 'too-large'
  | 'malformed-json'
  | 'not-an-object'
  | 'missing-field'
  | 'bad-type'
  | 'bad-value'
  | 'future-schema-version'
  | 'unreadable-min-reader'
  | 'checksum-mismatch'
  | 'counts-mismatch'
  | 'duplicate-id'
  | 'dangling-reference'
  | 'out-of-range';

export interface ValidationIssue {
  code: ValidationErrorCode;
  /** JSON-pointer-ish path, e.g. `data.recallAttempts[3].accuracy`. */
  path: string;
  message: string;
  /** Only on checksum-mismatch: what the file claimed vs what we computed. */
  expected?: string;
  computed?: string;
}

export type InspectionResult =
  | { ok: true; envelope: BackupEnvelope; warnings: string[] }
  | { ok: false; errors: ValidationIssue[]; warnings: string[] };

export interface InspectOptions {
  maxBytes?: number;
  /** User-confirmed recovery mode: drop rows with dangling references. */
  dropOrphans?: boolean;
}

export interface OrphanRef {
  dataKey: keyof BackupUserData;
  index: number;
  id: string | null;
  /** The missing reference, e.g. `hifzItem "nope"`. */
  missing: string;
}

// ---------------------------------------------------------------- helpers

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

class Ctx {
  errors: ValidationIssue[] = [];
  warnings: string[] = [];
  orphans: OrphanRef[] = [];
  private ids = new Map<string, string>();

  error(code: ValidationErrorCode, path: string, message: string, extra?: { expected?: string; computed?: string }): void {
    this.errors.push({ code, path, message, ...extra });
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  /** Primary-id uniqueness, across AND within tables. */
  claimId(id: string | undefined, where: string): void {
    if (id === undefined) return;
    const seen = this.ids.get(id);
    if (seen !== undefined) {
      this.error('duplicate-id', where, `id "${id}" already used at ${seen}`);
    } else {
      this.ids.set(id, where);
    }
  }

  // --- field readers: each returns the value when valid, undefined otherwise

  string(row: Record<string, unknown>, path: string, field: string, opts: { nullable?: boolean } = {}): string | null | undefined {
    const v = row[field];
    if (v === undefined || (v === null && opts.nullable)) return opts.nullable ? null : this.missing(path, field);
    if (typeof v !== 'string') return this.badType(path, field, 'string', v);
    return v;
  }

  timestamp(row: Record<string, unknown>, path: string, field: string, opts: { nullable?: boolean } = {}): string | null | undefined {
    const s = this.string(row, path, field, opts);
    if (s === undefined || s === null) return s ?? undefined;
    if (s.trim() === '' || Number.isNaN(Date.parse(s))) {
      return this.badValue(path, field, `"${truncate(s)}" is not a parseable ISO-8601 timestamp`);
    }
    return s;
  }

  int(row: Record<string, unknown>, path: string, field: string, opts: { min?: number; max?: number; nullable?: boolean } = {}): number | null | undefined {
    const n = this.number(row, path, field, opts);
    if (n === undefined || n === null) return n ?? undefined;
    if (!Number.isInteger(n)) return this.badValue(path, field, `expected an integer, got ${n}`);
    return n;
  }

  number(row: Record<string, unknown>, path: string, field: string, opts: { min?: number; max?: number; nullable?: boolean } = {}): number | null | undefined {
    const v = row[field];
    if (v === undefined || (v === null && opts.nullable)) return opts.nullable ? null : this.missing(path, field);
    if (typeof v !== 'number' || !Number.isFinite(v)) return this.badType(path, field, 'finite number', v);
    if (opts.min !== undefined && v < opts.min) return this.badValue(path, field, `must be >= ${opts.min} (got ${v})`);
    if (opts.max !== undefined && v > opts.max) return this.badValue(path, field, `must be <= ${opts.max} (got ${v})`);
    return v;
  }

  boolean(row: Record<string, unknown>, path: string, field: string): boolean | undefined {
    const v = row[field];
    if (v === undefined) {
      this.missing(path, field);
      return undefined;
    }
    if (typeof v !== 'boolean') return this.badType(path, field, 'boolean', v);
    return v;
  }

  enum<T extends string>(row: Record<string, unknown>, path: string, field: string, choices: readonly T[]): T | undefined {
    const v = this.string(row, path, field);
    if (v === undefined || v === null) return undefined;
    if (!(choices as readonly string[]).includes(v)) {
      return this.badValue(path, field, `must be one of: ${choices.join(', ')} (got "${truncate(v)}")`);
    }
    return v as T;
  }

  verseKey(row: Record<string, unknown>, path: string, field: string, opts: { nullable?: boolean } = {}): string | null | undefined {
    const v = this.string(row, path, field, opts);
    if (v === undefined || v === null) return v ?? undefined;
    if (!VERSE_KEY_RE.test(v)) {
      return this.badValue(path, field, `"${truncate(v)}" is not a verse key (expected ^\\d{1,3}:\\d{1,4}$)`);
    }
    const [chapter, verse] = v.split(':').map(Number) as [number, number];
    if (chapter < 1 || chapter > SURAH_COUNT) {
      return this.badValue(path, field, `chapter ${chapter} outside 1..${SURAH_COUNT}`);
    }
    if (verse < 1) return this.badValue(path, field, `verse must be >= 1 (got ${verse})`);
    return v;
  }

  array(row: Record<string, unknown>, path: string, field: string): unknown[] | undefined {
    const v = row[field];
    if (v === undefined) {
      this.missing(path, field);
      return undefined;
    }
    if (!Array.isArray(v)) return this.badType(path, field, 'array', v);
    return v;
  }

  verseKeyArray(row: Record<string, unknown>, path: string, field: string): void {
    const arr = this.array(row, path, field);
    if (!arr) return;
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      if (typeof item !== 'string' || !VERSE_KEY_RE.test(item)) {
        this.error('bad-value', `${path}.${field}[${i}]`, `not a verse key: ${JSON.stringify(truncate(String(item)))}`);
      }
    }
  }

  object(row: Record<string, unknown>, path: string, field: string, opts: { nullable?: boolean } = {}): Record<string, unknown> | null | undefined {
    const v = row[field];
    if (v === undefined || (v === null && opts.nullable)) return opts.nullable ? null : this.missing(path, field);
    if (!isPlainObject(v)) return this.badType(path, field, 'object', v);
    return v;
  }

  private missing(path: string, field: string): undefined {
    this.error('missing-field', `${path}.${field}`, `missing required field "${field}"`);
    return undefined;
  }

  private badType(path: string, field: string, want: string, got: unknown): undefined {
    this.error('bad-type', `${path}.${field}`, `expected ${want}, got ${describe(got)}`);
    return undefined;
  }

  private badValue(path: string, field: string, message: string): undefined {
    this.error('bad-value', `${path}.${field}`, message);
    return undefined;
  }
}

function truncate(s: string): string {
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v === 'string' ? JSON.stringify(truncate(v)) : String(v);
}

/** Derived primary keys for tables whose contract rows may omit `id`. */
export function readingPositionId(row: { id?: string; verseKey: string }): string {
  return row.id ?? `pos:${row.verseKey}`;
}

export function readingHistoryId(row: { id?: string; verseKey: string; readAt: string }): string {
  return row.id ?? `hist:${row.verseKey}:${row.readAt}`;
}

// ---------------------------------------------------------------- main entry

/**
 * Inspect a raw backup file body. Never throws; always returns a result.
 */
export function inspectEnvelope(raw: string, opts: InspectOptions = {}): InspectionResult {
  try {
    return inspectInner(raw, opts);
  } catch (err) {
    // Belt-and-braces: even a pathological input must degrade to a failure.
    return {
      ok: false,
      errors: [{ code: 'malformed-json', path: '$', message: `inspection aborted: ${err instanceof Error ? err.message : String(err)}` }],
      warnings: [],
    };
  }
}

function inspectInner(raw: string, opts: InspectOptions): InspectionResult {
  const maxBytes = opts.maxBytes ?? MAX_BACKUP_BYTES;
  const ctx = new Ctx();

  if (typeof raw !== 'string') {
    ctx.error('malformed-json', '$', 'backup body must be a string');
    return { ok: false, errors: ctx.errors, warnings: ctx.warnings };
  }
  const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (utf8Bytes(body).length > maxBytes) {
    ctx.error('too-large', '$', `backup exceeds the ${maxBytes} byte limit`);
    return { ok: false, errors: ctx.errors, warnings: ctx.warnings };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    ctx.error('malformed-json', '$', `invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, errors: ctx.errors, warnings: ctx.warnings };
  }
  if (!isPlainObject(parsed)) {
    ctx.error('not-an-object', '$', 'top level must be a JSON object');
    return { ok: false, errors: ctx.errors, warnings: ctx.warnings };
  }
  return validateEnvelopeObject(parsed, ctx, opts);
}

/**
 * Validate an already-parsed envelope object (same guarantees, never throws).
 * `restore.ts` re-verifies through here rather than trusting its caller.
 */
export function validateEnvelopeObject(parsed: unknown, shared?: Ctx, opts: InspectOptions = {}): InspectionResult {
  const ctx = shared ?? new Ctx();
  if (!isPlainObject(parsed)) {
    ctx.error('not-an-object', '$', 'envelope must be a JSON object');
    return finish(ctx, null, opts);
  }

  // --- envelope scalar fields
  const schemaVersion = ctx.int(parsed, '$', 'schemaVersion', { min: 1 });
  const minReaderVersion = ctx.int(parsed, '$', 'minReaderVersion', { min: 1 });
  ctx.string(parsed, '$', 'createdAt');
  const producedBy = ctx.object(parsed, '$', 'producedBy');
  if (producedBy) {
    ctx.string(producedBy, '$.producedBy', 'app');
    ctx.string(producedBy, '$.producedBy', 'version');
    ctx.enum(producedBy, '$.producedBy', 'platform', ['desktop', 'mobile'] as const);
  }
  const checksum = ctx.string(parsed, '$', 'checksum');
  if (typeof checksum === 'string' && !/^[0-9a-f]{64}$/.test(checksum)) {
    ctx.error('bad-value', '$.checksum', 'checksum must be 64 lowercase hex characters');
  }
  const counts = ctx.object(parsed, '$', 'counts');
  const data = ctx.object(parsed, '$', 'data');

  if (typeof schemaVersion === 'number' && schemaVersion > BACKUP_SCHEMA_VERSION) {
    ctx.error(
      'future-schema-version',
      '$.schemaVersion',
      `file schema v${schemaVersion} is newer than this app's v${BACKUP_SCHEMA_VERSION}; refuse, do not partially read`,
    );
  }
  if (typeof minReaderVersion === 'number' && minReaderVersion > BACKUP_SCHEMA_VERSION) {
    ctx.error(
      'unreadable-min-reader',
      '$.minReaderVersion',
      `file requires at least reader v${minReaderVersion}; this app is v${BACKUP_SCHEMA_VERSION}`,
    );
  }

  if (data) {
    // Unknown keys inside `data` are kept (they were covered by the checksum)
    // but flagged; restore only ever reads the known keys.
    for (const key of Object.keys(data)) {
      if (!(DATA_KEYS as readonly string[]).includes(key)) {
        ctx.warn(`unknown data key "${key}" ignored — content tables are never part of a backup`);
      }
    }
    if (typeof checksum === 'string') {
      let computed: string;
      try {
        computed = computeDataChecksum(data as unknown as BackupUserData);
      } catch (err) {
        ctx.error('bad-value', '$.data', `cannot canonicalise data: ${err instanceof Error ? err.message : String(err)}`);
        return finish(ctx, null, opts);
      }
      if (computed !== checksum) {
        ctx.error('checksum-mismatch', '$.checksum', 'file data does not match its checksum (tampered or corrupted)', {
          expected: checksum,
          computed,
        });
      }
    }

    if (typeof schemaVersion === 'number' && schemaVersion <= BACKUP_SCHEMA_VERSION) {
      validateUserData(ctx, data);
    } else {
      ctx.warn('row validation skipped for a future schema version');
    }
  }

  if (counts && data) {
    for (const key of DATA_KEYS) {
      const declared = counts[key];
      if (declared === undefined) {
        ctx.error('missing-field', `$.counts.${key}`, `counts is missing "${key}"`);
        continue;
      }
      if (typeof declared !== 'number' || !Number.isInteger(declared)) {
        ctx.error('bad-type', `$.counts.${key}`, 'counts values must be integers');
        continue;
      }
      const actual =
        key === 'settings'
          ? isPlainObject(data.settings)
            ? Object.keys(data.settings as Record<string, unknown>).length
            : -1
          : Array.isArray(data[key])
            ? (data[key] as unknown[]).length
            : -1;
      if (actual !== declared) {
        ctx.error('counts-mismatch', `$.counts.${key}`, `counts.${key} says ${declared} but data.${key} holds ${actual}`);
      }
    }
  }

  const envelope = isPlainObject(parsed) ? (parsed as unknown as BackupEnvelope) : null;
  return finish(ctx, envelope, opts);
}

function finish(ctx: Ctx, envelope: BackupEnvelope | null, opts: InspectOptions): InspectionResult {
  const orphanErrors = ctx.errors.filter((e) => e.code === 'dangling-reference');
  if (opts.dropOrphans && envelope && ctx.errors.every((e) => e.code === 'dangling-reference')) {
    const { clean } = dropOrphanRows(envelope, ctx.orphans);
    for (const o of ctx.orphans) {
      ctx.warn(`dropped orphan ${o.dataKey}${o.id ? ` "${o.id}"` : ''} — ${o.missing} (user-confirmed drop-orphans)`);
    }
    return { ok: true, envelope: clean, warnings: ctx.warnings };
  }
  if (orphanErrors.length > 0) {
    ctx.warn(
      `${orphanErrors.length} dangling reference(s): restore with the explicit drop-orphans option after user confirmation, or fix in the source app`,
    );
  }
  if (ctx.errors.length > 0) {
    return { ok: false, errors: ctx.errors, warnings: ctx.warnings };
  }
  if (!envelope) {
    return {
      ok: false,
      errors: [{ code: 'not-an-object', path: '$', message: 'envelope did not survive validation' }],
      warnings: ctx.warnings,
    };
  }
  return { ok: true, envelope, warnings: ctx.warnings };
}

/** Remove rows with dangling references and re-seal counts + checksum. Pure. */
export function dropOrphanRows(envelope: BackupEnvelope, refs: OrphanRef[]): { clean: BackupEnvelope; dropped: OrphanRef[] } {
  const data = { ...(envelope.data as unknown as Record<string, unknown>) };
  const byKey = new Map<keyof BackupUserData, Set<number>>();
  for (const r of refs) {
    let s = byKey.get(r.dataKey);
    if (!s) byKey.set(r.dataKey, (s = new Set()));
    s.add(r.index);
  }
  for (const [key, indices] of byKey) {
    const arr = [...((data[key] as unknown[]) ?? [])];
    const kept = arr.filter((_, i) => !indices.has(i));
    data[key] = kept;
  }
  const clean: BackupEnvelope = {
    ...envelope,
    counts: computeCounts(data as unknown as BackupUserData),
    checksum: computeDataChecksum(data as unknown as BackupUserData),
    data: data as unknown as BackupUserData,
  };
  return { clean, dropped: refs };
}

/** Orphan references in an already-validated envelope (used by `planRestore`). */
export function findOrphanRows(envelope: BackupEnvelope): OrphanRef[] {
  const ctx = new Ctx();
  validateUserData(ctx, envelope.data as unknown as Record<string, unknown>);
  return ctx.orphans;
}

// ---------------------------------------------------------------- per-row

function validateUserData(ctx: Ctx, data: Record<string, unknown>): void {
  /** Fetch `data[key]` as an array; report a bad-type/missing error when not. */
  const arr = (key: keyof BackupUserData): unknown[] => {
    const v = data[key];
    if (v === undefined) {
      ctx.error('missing-field', `$.data.${key}`, `data is missing "${key}"`);
      return [];
    }
    if (!Array.isArray(v)) {
      ctx.error('bad-type', `$.data.${key}`, 'must be an array');
      return [];
    }
    return v;
  };

  const settings = data.settings;
  if (settings !== undefined) {
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
      ctx.error('bad-type', '$.data.settings', 'settings must be an object');
    } else {
      const allow = new Set(settingKeys());
      for (const [key, value] of Object.entries(settings as Record<string, unknown>)) {
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
          const where = /^[A-Za-z0-9_]+$/.test(key) ? `$.data.settings.${key}` : `$.data.settings.${JSON.stringify(key)}`;
          ctx.error('bad-type', where, 'setting values must be primitives');
        }
        if (!allow.has(key)) ctx.warn(`setting "${key}" is not in the app allowlist; it will be dropped at restore time`);
      }
    }
  }

  const items = arr('hifzItems');
  const sessions = arr('sessions');
  const bookmarks = arr('bookmarks');
  const notes = arr('notes');
  const positions = arr('readingPositions');
  const history = arr('readingHistory');
  const segments = arr('hifzSegments');
  const anchors = arr('anchorWords');
  const transitions = arr('hifzTransitions');
  const attempts = arr('recallAttempts');
  const groups = arr('confusionGroups');
  const journeys = arr('journeys');
  const reflections = arr('reflections');
  const plans = arr('dailyPlans');

  const itemIds = new Set<string>();
  const sessionIds = new Set<string>();
  // Pre-pass: attempts may reference sessions validated later; collect their
  // ids up front so the (warning-level) session check sees them.
  for (const row of sessions) {
    if (isPlainObject(row) && typeof row.id === 'string') sessionIds.add(row.id);
  }

  items.forEach((row, i) => {
    const r = rowRow(ctx, 'hifzItems', i, row);
    if (!r) return;
    const id = ctx.string(r, path('hifzItems', i), 'id');
    ctx.claimId(typeof id === 'string' ? id : undefined, path('hifzItems', i));
    ctx.verseKey(r, path('hifzItems', i), 'verseKey');
    const seq = ctx.array(r, path('hifzItems', i), 'sequence');
    if (seq) seq.forEach((v, j) => typeof v !== 'string' && ctx.error('bad-type', `${path('hifzItems', i)}.sequence[${j}]`, 'not a verse key string'));
    ctx.timestamp(r, path('hifzItems', i), 'addedAt');
    ctx.enum(r, path('hifzItems', i), 'status', ['active', 'paused', 'graduated', 'dropped'] as const);
    ctx.enum(r, path('hifzItems', i), 'band', ['new', 'unstable', 'weak', 'stable', 'mastered'] as const);
    ctx.number(r, path('hifzItems', i), 'stability', { min: 0, max: 1 });
    ctx.number(r, path('hifzItems', i), 'strength', { min: 0, max: 1 });
    ctx.timestamp(r, path('hifzItems', i), 'lastReviewedAt', { nullable: true });
    ctx.timestamp(r, path('hifzItems', i), 'nextReviewAt', { nullable: true });
    ctx.int(r, path('hifzItems', i), 'attemptCount', { min: 0 });
    ctx.int(r, path('hifzItems', i), 'errorCount', { min: 0 });
    if (typeof id === 'string') itemIds.add(id);
  });

  bookmarks.forEach((row, i) => {
    const r = rowRow(ctx, 'bookmarks', i, row);
    if (!r) return;
    const id = ctx.string(r, path('bookmarks', i), 'id');
    ctx.claimId(typeof id === 'string' ? id : undefined, path('bookmarks', i));
    ctx.verseKey(r, path('bookmarks', i), 'verseKey', { nullable: true });
    ctx.int(r, path('bookmarks', i), 'page', { min: 1, max: PAGE_COUNT, nullable: true });
    ctx.string(r, path('bookmarks', i), 'label', { nullable: true });
    ctx.timestamp(r, path('bookmarks', i), 'createdAt');
  });

  notes.forEach((row, i) => {
    const r = rowRow(ctx, 'notes', i, row);
    if (!r) return;
    const id = ctx.string(r, path('notes', i), 'id');
    ctx.claimId(typeof id === 'string' ? id : undefined, path('notes', i));
    ctx.verseKey(r, path('notes', i), 'verseKey');
    ctx.string(r, path('notes', i), 'body');
    ctx.timestamp(r, path('notes', i), 'createdAt');
    ctx.timestamp(r, path('notes', i), 'updatedAt');
  });

  positions.forEach((row, i) => {
    const r = rowRow(ctx, 'readingPositions', i, row);
    if (!r) return;
    const verseKey = ctx.verseKey(r, path('readingPositions', i), 'verseKey');
    const declaredId = typeof r.id === 'string' ? r.id : undefined;
    ctx.claimId(verseKey === undefined ? declaredId : readingPositionId({ id: declaredId, verseKey: String(verseKey) }), path('readingPositions', i));
    ctx.int(r, path('readingPositions', i), 'page', { min: 1, max: PAGE_COUNT });
    ctx.number(r, path('readingPositions', i), 'scrollFraction', { min: 0, max: 1 });
    ctx.timestamp(r, path('readingPositions', i), 'updatedAt');
  });

  history.forEach((row, i) => {
    const r = rowRow(ctx, 'readingHistory', i, row);
    if (!r) return;
    const verseKey = ctx.verseKey(r, path('readingHistory', i), 'verseKey');
    const readAt = ctx.timestamp(r, path('readingHistory', i), 'readAt');
    const declaredId = typeof r.id === 'string' ? r.id : undefined;
    ctx.claimId(
      verseKey && readAt ? readingHistoryId({ id: declaredId, verseKey, readAt }) : declaredId,
      path('readingHistory', i),
    );
    ctx.int(r, path('readingHistory', i), 'durationMs', { min: 0, nullable: true });
  });

  segments.forEach((row, i) => {
    const r = rowRow(ctx, 'hifzSegments', i, row);
    if (!r) return;
    const id = ctx.string(r, path('hifzSegments', i), 'id');
    ctx.claimId(typeof id === 'string' ? id : undefined, path('hifzSegments', i));
    const itemId = ctx.string(r, path('hifzSegments', i), 'itemId');
    ctx.int(r, path('hifzSegments', i), 'position', { min: 0 });
    const from = ctx.int(r, path('hifzSegments', i), 'fromWord', { min: 1 });
    const to = ctx.int(r, path('hifzSegments', i), 'toWord', { min: 1 });
    if (from !== undefined && to !== undefined && from !== null && to !== null && from > to) {
      ctx.error('out-of-range', path('hifzSegments', i), `fromWord ${from} > toWord ${to}`);
    }
    ctx.string(r, path('hifzSegments', i), 'text');
    ctx.string(r, path('hifzSegments', i), 'meaningFa', { nullable: true });
    ctx.string(r, path('hifzSegments', i), 'meaningSource', { nullable: true });
    ctx.number(r, path('hifzSegments', i), 'stability', { min: 0, max: 1 });
    ctx.int(r, path('hifzSegments', i), 'errorCount', { min: 0 });
    if (typeof itemId === 'string' && itemId && !itemIds.has(itemId)) {
      ctx.orphans.push({ dataKey: 'hifzSegments', index: i, id: typeof id === 'string' ? id : null, missing: `hifzItem "${itemId}"` });
    }
  });

  anchors.forEach((row, i) => {
    const r = rowRow(ctx, 'anchorWords', i, row);
    if (!r) return;
    const id = ctx.string(r, path('anchorWords', i), 'id');
    ctx.claimId(typeof id === 'string' ? id : undefined, path('anchorWords', i));
    const itemId = ctx.string(r, path('anchorWords', i), 'itemId');
    ctx.int(r, path('anchorWords', i), 'wordPosition', { min: 1 });
    ctx.string(r, path('anchorWords', i), 'text');
    ctx.enum(r, path('anchorWords', i), 'role', ['opening', 'middle', 'ending', 'boundary'] as const);
    ctx.number(r, path('anchorWords', i), 'stability', { min: 0, max: 1 });
    if (typeof itemId === 'string' && itemId && !itemIds.has(itemId)) {
      ctx.orphans.push({ dataKey: 'anchorWords', index: i, id: typeof id === 'string' ? id : null, missing: `hifzItem "${itemId}"` });
    }
  });

  transitions.forEach((row, i) => {
    const r = rowRow(ctx, 'hifzTransitions', i, row);
    if (!r) return;
    const id = ctx.string(r, path('hifzTransitions', i), 'id');
    ctx.claimId(typeof id === 'string' ? id : undefined, path('hifzTransitions', i));
    const itemId = ctx.string(r, path('hifzTransitions', i), 'itemId');
    ctx.enum(r, path('hifzTransitions', i), 'kind', ['intra', 'inter'] as const);
    ctx.verseKey(r, path('hifzTransitions', i), 'toVerseKey', { nullable: true });
    ctx.int(r, path('hifzTransitions', i), 'toWord', { min: 1 });
    ctx.int(r, path('hifzTransitions', i), 'successCount', { min: 0 });
    ctx.int(r, path('hifzTransitions', i), 'failureCount', { min: 0 });
    ctx.number(r, path('hifzTransitions', i), 'stability', { min: 0, max: 1 });
    ctx.timestamp(r, path('hifzTransitions', i), 'lastPracticedAt', { nullable: true });
    if (typeof itemId === 'string' && itemId && !itemIds.has(itemId)) {
      ctx.orphans.push({ dataKey: 'hifzTransitions', index: i, id: typeof id === 'string' ? id : null, missing: `hifzItem "${itemId}"` });
    }
  });

  attempts.forEach((row, i) => {
    const r = rowRow(ctx, 'recallAttempts', i, row);
    if (!r) return;
    const p = path('recallAttempts', i);
    const id = ctx.string(r, p, 'id');
    ctx.claimId(typeof id === 'string' ? id : undefined, p);
    const itemId = ctx.string(r, p, 'itemId');
    ctx.verseKey(r, p, 'verseKey');
    const sessionId = ctx.string(r, p, 'sessionId', { nullable: true });
    ctx.enum(r, p, 'mode', RECALL_MODE_VALUES);
    ctx.timestamp(r, p, 'startedAt');
    ctx.timestamp(r, p, 'completedAt', { nullable: true });

    const produced = ctx.array(r, p, 'produced');
    if (produced) {
      produced.forEach((w, j) => {
        if (!isPlainObject(w)) {
          ctx.error('bad-type', `${p}.produced[${j}]`, 'recited word must be an object');
          return;
        }
        ctx.int(w, `${p}.produced[${j}]`, 'position', { min: 1 });
        ctx.string(w, `${p}.produced[${j}]`, 'text');
      });
    }
    const cue = ctx.object(r, p, 'cue', { nullable: true });
    if (cue) {
      ctx.string(cue, `${p}.cue`, 'kind');
      ctx.string(cue, `${p}.cue`, 'text', { nullable: true });
    }

    const expected = ctx.int(r, p, 'expectedWordCount', { min: 0 });
    const correct = ctx.int(r, p, 'correctWordCount', { min: 0 });
    if (
      expected !== undefined && correct !== undefined &&
      expected !== null && correct !== null && correct > expected
    ) {
      ctx.error('out-of-range', p, `correctWordCount ${correct} exceeds expectedWordCount ${expected}`);
    }
    const accuracy = ctx.number(r, p, 'accuracy');
    if (accuracy !== undefined && accuracy !== null && (accuracy < 0 || accuracy > 1)) {
      ctx.error('out-of-range', `${p}.accuracy`, `accuracy must be within 0..1 (got ${accuracy})`);
    }

    const errors = ctx.array(r, p, 'errors');
    if (errors) {
      errors.forEach((e, j) => {
        if (!isPlainObject(e)) {
          ctx.error('bad-type', `${p}.errors[${j}]`, 'detected error must be an object');
          return;
        }
        const kind = ctx.string(e, `${p}.errors[${j}]`, 'kind');
        if (typeof kind === 'string' && !(ERROR_KIND_VALUES as readonly string[]).includes(kind)) {
          ctx.error('bad-value', `${p}.errors[${j}].kind`, `"${truncate(kind)}" is not a valid ErrorKind from the contract union`);
        }
        ctx.int(e, `${p}.errors[${j}]`, 'expectedPosition', { min: 0 });
        ctx.string(e, `${p}.errors[${j}]`, 'expected', { nullable: true });
        ctx.string(e, `${p}.errors[${j}]`, 'actual', { nullable: true });
        ctx.verseKey(e, `${p}.errors[${j}]`, 'confusedWithVerseKey', { nullable: true });
        ctx.int(e, `${p}.errors[${j}]`, 'segmentPosition', { min: 0, nullable: true });
        ctx.string(e, `${p}.errors[${j}]`, 'explanation');
      });
    }

    ctx.int(r, p, 'durationMs', { min: 0, nullable: true });
    ctx.int(r, p, 'selfConfidence', { min: 1, max: 5, nullable: true });
    ctx.boolean(r, p, 'usedAudio');

    if (typeof itemId === 'string' && itemId && !itemIds.has(itemId)) {
      ctx.orphans.push({ dataKey: 'recallAttempts', index: i, id: typeof id === 'string' ? id : null, missing: `hifzItem "${itemId}"` });
    } else if (typeof sessionId === 'string' && sessionId && !sessionIds.has(sessionId)) {
      ctx.warn(`recallAttempt "${String(id)}" references unknown session "${sessionId}" (session_id has no FK; kept)`);
    }
  });

  sessions.forEach((row, i) => {
    const r = rowRow(ctx, 'sessions', i, row);
    if (!r) return;
    const p = path('sessions', i);
    const id = ctx.string(r, p, 'id');
    ctx.claimId(typeof id === 'string' ? id : undefined, p);
    ctx.timestamp(r, p, 'startedAt');
    ctx.timestamp(r, p, 'endedAt', { nullable: true });
    ctx.int(r, p, 'plannedSteps', { min: 0 });
    const steps = ctx.array(r, p, 'steps');
    if (steps) {
      steps.forEach((s, j) => {
        if (!isPlainObject(s)) {
          ctx.error('bad-type', `${p}.steps[${j}]`, 'session step must be an object');
          return;
        }
        ctx.enum(s, `${p}.steps[${j}]`, 'mode', RECALL_MODE_VALUES);
        ctx.verseKey(s, `${p}.steps[${j}]`, 'verseKey', { nullable: true });
        ctx.string(s, `${p}.steps[${j}]`, 'itemId', { nullable: true });
        ctx.string(s, `${p}.steps[${j}]`, 'attemptId', { nullable: true });
        ctx.timestamp(s, `${p}.steps[${j}]`, 'completedAt', { nullable: true });
      });
    }
    const report = ctx.object(r, p, 'report', { nullable: true });
    if (report) {
      ctx.number(report, `${p}.report`, 'overallRecall', { min: 0, max: 1 });
      ctx.int(report, `${p}.report`, 'newItemsLearned', { min: 0 });
      ctx.int(report, `${p}.report`, 'reviewsCompleted', { min: 0 });
      for (const key of ['weakSegments', 'weakTransitions', 'confusedVerseKeys', 'repeatedErrors', 'stabilityChanges'] as const) {
        ctx.array(report, `${p}.report`, key);
      }
      ctx.timestamp(report, `${p}.report`, 'recommendedNextReviewAt', { nullable: true });
    }
    if (typeof id === 'string') sessionIds.add(id);
  });

  groups.forEach((row, i) => {
    const r = rowRow(ctx, 'confusionGroups', i, row);
    if (!r) return;
    const p = path('confusionGroups', i);
    const id = ctx.string(r, p, 'id');
    ctx.claimId(typeof id === 'string' ? id : undefined, p);
    ctx.string(r, p, 'label', { nullable: true });
    ctx.enum(r, p, 'origin', ['user', 'engine'] as const);
    ctx.verseKeyArray(r, p, 'verseKeys');
    ctx.timestamp(r, p, 'createdAt');
    ctx.timestamp(r, p, 'lastTriggeredAt', { nullable: true });
    ctx.int(r, p, 'confusionCount', { min: 0 });
  });

  journeys.forEach((row, i) => {
    const r = rowRow(ctx, 'journeys', i, row);
    if (!r) return;
    const p = path('journeys', i);
    const id = ctx.string(r, p, 'id');
    ctx.claimId(typeof id === 'string' ? id : undefined, p);
    ctx.string(r, p, 'title');
    ctx.string(r, p, 'description', { nullable: true });
    ctx.verseKeyArray(r, p, 'goalVerseKeys');
    ctx.timestamp(r, p, 'startedAt');
    ctx.timestamp(r, p, 'completedAt', { nullable: true });
    const progress = ctx.array(r, p, 'progress');
    if (progress) {
      progress.forEach((s, j) => {
        if (!isPlainObject(s)) {
          ctx.error('bad-type', `${p}.progress[${j}]`, 'progress entry must be an object');
          return;
        }
        ctx.verseKey(s, `${p}.progress[${j}]`, 'verseKey');
        ctx.string(s, `${p}.progress[${j}]`, 'state');
        ctx.timestamp(s, `${p}.progress[${j}]`, 'updatedAt');
      });
    }
  });

  reflections.forEach((row, i) => {
    const r = rowRow(ctx, 'reflections', i, row);
    if (!r) return;
    const p = path('reflections', i);
    const id = ctx.string(r, p, 'id');
    ctx.claimId(typeof id === 'string' ? id : undefined, p);
    ctx.verseKey(r, p, 'verseKey', { nullable: true });
    ctx.string(r, p, 'body');
    ctx.timestamp(r, p, 'writtenAt');
  });

  plans.forEach((row, i) => {
    const r = rowRow(ctx, 'dailyPlans', i, row);
    if (!r) return;
    const p = path('dailyPlans', i);
    const date = ctx.string(r, p, 'date');
    if (typeof date === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      ctx.error('bad-value', `${p}.date`, `"${truncate(date)}" is not YYYY-MM-DD`);
    }
    ctx.claimId(typeof date === 'string' ? date : undefined, p);
    ctx.timestamp(r, p, 'generatedAt');
    ctx.verseKeyArray(r, p, 'newAyahs');
    for (const key of ['reviewItems', 'weakItems'] as const) {
      const entries = ctx.array(r, p, key);
      if (entries) {
        entries.forEach((e, j) => {
          if (!isPlainObject(e)) {
            ctx.error('bad-type', `${p}.${key}[${j}]`, 'plan entry must be an object');
            return;
          }
          ctx.string(e, `${p}.${key}[${j}]`, 'itemId');
          ctx.verseKey(e, `${p}.${key}[${j}]`, 'verseKey');
          ctx.string(e, `${p}.${key}[${j}]`, 'reason');
          ctx.number(e, `${p}.${key}[${j}]`, 'priority');
          ctx.object(e, `${p}.${key}[${j}]`, 'factors');
          ctx.enum(e, `${p}.${key}[${j}]`, 'suggestedMode', RECALL_MODE_VALUES);
          ctx.timestamp(e, `${p}.${key}[${j}]`, 'dueAt');
        });
      }
    }
    const groupIds = ctx.array(r, p, 'confusionGroups');
    if (groupIds) groupIds.forEach((g, j) => typeof g !== 'string' && ctx.error('bad-type', `${p}.confusionGroups[${j}]`, 'group id must be a string'));
    ctx.number(r, p, 'estimatedMinutes', { min: 0 });
  });

  for (const o of ctx.orphans) {
    ctx.error(
      'dangling-reference',
      `$.data.${o.dataKey}[${o.index}]${o.id ? ` (id "${o.id}")` : ''}`,
      `references ${o.missing}, which is not in this backup; restore refused unless the user explicitly confirms drop-orphans`,
    );
  }
}

function path(key: string, i: number): string {
  return `$.data.${key}[${i}]`;
}

function rowRow(ctx: Ctx, key: string, i: number, row: unknown): Record<string, unknown> | null {
  if (!isPlainObject(row)) {
    ctx.error('bad-type', path(key, i), `row must be an object, got ${describe(row)}`);
    return null;
  }
  return row;
}
