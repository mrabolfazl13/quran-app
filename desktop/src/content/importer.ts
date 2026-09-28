/**
 * Pack import: read the index, verify every pack, map records, cross-check
 * integrity, and only then hand one atomic plan to the gateway.
 *
 * The rules that matter:
 *   • A pack whose sha256 or byte length disagrees with the manifest stops the
 *     whole import. Nothing partial ever reaches the database, and the report
 *     names the exact pack id and stage.
 *   • `recordCount` must match the parsed payload line-for-line.
 *   • Cross-pack integrity (contiguous verse keys, surah ayah counts, 6236 when
 *     a full mushaf is present, no dangling references) is asserted before the
 *     write, because revealed text must never be silently wrong.
 *   • No `content/index.json` is a normal state, not a crash: the app reports
 *     "no packs yet" and every screen shows its onboarding empty state.
 */
import { CONTENT_PACK_SCHEMA_VERSION } from '@quran/core';
import type { ContentPackManifest, PackIndex } from '@quran/core';
import type { ContentPlan, ImportCounts, ImportIssue, ImportPackOutcome, ImportReport } from '../gateway/types';
import { emptyPlan } from '../gateway/types';
import type { PackSource } from './packSource';
import { buildSearchDocs, mapRecords, packRowOf, payloadPathOf, validatePlan } from './records';

export interface ImportOutcome {
  report: ImportReport;
  /** `null` whenever nothing may be written. */
  plan: ContentPlan | null;
}

/** JSONL → records. Blank lines are ignored; a bad line names its number. */
export function parseJsonl(text: string, packId: string): { records: Record<string, unknown>[]; issue: ImportIssue | null } {
  const records: Record<string, unknown>[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trim();
    if (line === '') continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { records: [], issue: { stage: 'record-shape', packId, message: `line ${i + 1} is not a JSON object` } };
      }
      records.push(parsed as Record<string, unknown>);
    } catch (err) {
      return { records: [], issue: { stage: 'record-shape', packId, message: `line ${i + 1} is not valid JSON: ${String(err)}` } };
    }
  }
  return { records, issue: null };
}

function countsOf(plan: ContentPlan): ImportCounts {
  return {
    surahs: plan.surahs.length,
    ayahs: plan.ayahs.length,
    words: plan.words.length,
    translations: plan.translations.length,
    tafsirs: plan.tafsirs.length,
    similar: plan.similar.length,
    relations: plan.relations.length,
    concepts: plan.concepts.length,
    audio: plan.audio.length,
  };
}

function merge(target: ContentPlan, add: ContentPlan): void {
  target.packs.push(...add.packs);
  target.surahs.push(...add.surahs);
  target.ayahs.push(...add.ayahs);
  target.words.push(...add.words);
  target.translations.push(...add.translations);
  target.tafsirs.push(...add.tafsirs);
  target.similar.push(...add.similar);
  target.relations.push(...add.relations);
  target.concepts.push(...add.concepts);
  target.conceptAyah.push(...add.conceptAyah);
  target.conceptRelations.push(...add.conceptRelations);
  target.audio.push(...add.audio);
}

function isManifest(value: unknown): value is ContentPackManifest {
  const m = value as ContentPackManifest | null;
  return (
    !!m &&
    typeof m.id === 'string' &&
    typeof m.kind === 'string' &&
    typeof m.checksum === 'string' &&
    typeof m.recordCount === 'number' &&
    !!m.license &&
    !!m.attribution
  );
}

/**
 * Verify + map every pack. Returns the report and, when everything checked out,
 * the plan to write. This function never touches the database.
 */
export async function buildImportPlan(source: PackSource, now: () => Date = () => new Date()): Promise<ImportOutcome> {
  const started = now().getTime();
  const finish = (
    status: ImportReport['status'],
    packs: ImportPackOutcome[],
    plan: ContentPlan | null,
    issue?: ImportIssue,
    warnings: ImportIssue[] = [],
  ): ImportOutcome => ({
    report: {
      at: now().toISOString(),
      status,
      durationMs: Math.max(0, now().getTime() - started),
      packs,
      counts: plan ? countsOf(plan) : emptyCounts(),
      ...(issue ? { issue } : {}),
      warnings,
    },
    plan,
  });

  const availability = await source.available().catch((err: unknown) => {
    throw new Error(`content directory unreadable: ${String(err)}`);
  });

  if (!availability.hasIndex) {
    return finish(
      'no-packs',
      [],
      null,
      {
        stage: 'unavailable',
        message:
          'content/index.json was not found. The content pipeline has not produced packs yet, ' +
          'so there is nothing to import — run `npm run content:build`, then import again.',
        detail: `looked in: ${availability.root ?? source.location}`,
      },
    );
  }

  let index: PackIndex;
  try {
    const file = await source.read('index.json');
    const parsed = JSON.parse(file.text) as PackIndex;
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.packs)) {
      throw new Error('index.json has no `packs` array');
    }
    index = parsed;
  } catch (err) {
    return finish('failed', [], null, { stage: 'index', message: `could not read content/index.json: ${String(err)}` });
  }

  if (index.schemaVersion > CONTENT_PACK_SCHEMA_VERSION) {
    return finish('failed', [], null, {
      stage: 'index',
      message: `index schema v${index.schemaVersion} is newer than this build understands (v${CONTENT_PACK_SCHEMA_VERSION})`,
    });
  }

  const plan = emptyPlan();
  const outcomes: ImportPackOutcome[] = [];
  const warnings: ImportIssue[] = [];
  const manifests: ContentPackManifest[] = [];
  const importedAt = now().toISOString();

  for (const manifest of index.packs) {
    if (!isManifest(manifest)) {
      return finish('failed', outcomes, null, {
        stage: 'index',
        message: 'an index entry is missing id/kind/checksum/recordCount/license/attribution',
      }, warnings);
    }
    if (manifest.schemaVersion > CONTENT_PACK_SCHEMA_VERSION) {
      return finish('failed', outcomes, null, {
        stage: 'index',
        packId: manifest.id,
        message: `pack ${manifest.id} uses content schema v${manifest.schemaVersion}, newer than v${CONTENT_PACK_SCHEMA_VERSION}`,
      }, warnings);
    }
    manifests.push(manifest);

    const payloadRel = payloadPathOf(manifest);
    let payload;
    try {
      payload = await source.read(payloadRel);
    } catch (err) {
      return finish('failed', outcomes, null, {
        stage: 'checksum',
        packId: manifest.id,
        message: `payload for pack "${manifest.id}" could not be read at ${payloadRel}`,
        detail: String(err),
      }, warnings);
    }

    const expected = manifest.checksum.trim().toLowerCase();
    const actual = payload.sha256.trim().toLowerCase();
    outcomes.push({
      packId: manifest.id,
      kind: manifest.kind,
      title: manifest.title,
      recordsRead: 0,
      recordsApplied: 0,
      checksum: actual,
      checksumOk: actual === expected,
      licenseStatus: manifest.license.status,
    });
    const last = outcomes[outcomes.length - 1] as ImportPackOutcome;

    if (actual !== expected) {
      return finish('failed', outcomes, null, {
        stage: 'checksum',
        packId: manifest.id,
        message:
          `sha256 mismatch for pack "${manifest.id}" (${payloadRel}). ` +
          `Manifest says ${expected}, the file on disk hashes to ${actual}. ` +
          'The payload may be truncated, edited or copied from another build — nothing was imported.',
        detail: `bytes on disk ${payload.bytes}, manifest payloadBytes ${manifest.payloadBytes}`,
      }, warnings);
    }

    if (manifest.payloadBytes > 0 && payload.bytes !== manifest.payloadBytes) {
      return finish('failed', outcomes, null, {
        stage: 'payload-bytes',
        packId: manifest.id,
        message: `pack "${manifest.id}" is ${payload.bytes} bytes but the manifest declares ${manifest.payloadBytes}`,
      }, warnings);
    }

    const parsed = parseJsonl(payload.text, manifest.id);
    if (parsed.issue) {
      return finish('failed', outcomes, null, parsed.issue, warnings);
    }
    last.recordsRead = parsed.records.length;

    if (parsed.records.length !== manifest.recordCount) {
      return finish('failed', outcomes, null, {
        stage: 'record-count',
        packId: manifest.id,
        message: `pack "${manifest.id}" declares ${manifest.recordCount} records, payload has ${parsed.records.length}`,
      }, warnings);
    }

    const mapped = mapRecords(manifest, parsed.records);
    if (mapped.issues.length > 0) {
      return finish('failed', outcomes, null, mapped.issues[0] as ImportIssue, [...warnings, ...mapped.warnings]);
    }
    last.recordsApplied = mapped.recordsApplied;
    warnings.push(...mapped.warnings);
    plan.packs.push(packRowOf(manifest, importedAt));
    merge(plan, mapped.plan);
  }

  const integrity = validatePlan(plan, manifests);
  if (integrity.length > 0) {
    return finish('failed', outcomes, null, integrity[0] as ImportIssue, [...warnings, ...integrity.slice(1)]);
  }

  buildSearchDocs(plan);
  return finish('success', outcomes, plan, undefined, warnings);
}

function emptyCounts(): ImportCounts {
  return {
    surahs: 0,
    ayahs: 0,
    words: 0,
    translations: 0,
    tafsirs: 0,
    similar: 0,
    relations: 0,
    concepts: 0,
    audio: 0,
  };
}

export { countsOf };
