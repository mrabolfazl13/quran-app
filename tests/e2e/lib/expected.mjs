/**
 * tests/e2e/lib/expected.mjs — what the journey is allowed to assert, and where
 * each expectation comes from.
 *
 * Every number is *derived from `content/index.json`* (the pack manifests the
 * importer itself reads) — never typed in from memory. The documented constants
 * in `EXPECTED_CONSTANTS` are cross-checked against the manifests, so a rebuilt
 * pack set that changes a record count fails loudly here instead of quietly
 * changing what the device steps expect. `docs/current-state.md` quotes the same
 * figures as device-level evidence; this module is what pins them.
 *
 * `canonicalJsonStringify` is a harness-side mirror of
 * `core/src/backup/canonical-json.ts`. It is a mirror because the core module is
 * TypeScript and this suite must run on plain Node with no build step and no new
 * dependency. If core's rules ever change, the backup checksum step fails here —
 * that is the intended behaviour, not a flake: the mirror must be updated in the
 * same round as the contract.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
export const INDEX_JSON = path.join(REPO_ROOT, 'content', 'index.json');

/** The figures `docs/current-state.md` records; kept here so drift is visible. */
export const EXPECTED_CONSTANTS = Object.freeze({
  surahs: 114,
  ayahs: 6236,
  words: 83665,
  translationsPerPack: 6236,
  tafsirMuyassar: 1013,
  tafsirIbnKathir: 300,
  similarPairs: 1732,
});

/** Read the pack manifests the importer itself consumes. */
export function readContentIndex(file = INDEX_JSON) {
  const index = JSON.parse(readFileSync(file, 'utf8'));
  const byId = new Map(index.packs.map((pack) => [pack.id, pack]));
  const ofKind = (kind) => index.packs.filter((pack) => pack.kind === kind);

  const core = byId.get('quran-core');
  if (!core) throw new Error(`${file}: no quran-core pack — run npm run content:build`);
  const chapters = core.coverage?.chapters?.length ?? 0;

  const translations = ofKind('translation');
  const tafsirs = ofKind('tafsir');
  const similar = index.packs.find((pack) => pack.id === 'mutashabihat-ar');
  const words = byId.get('word-data');

  return {
    builtAt: index.builtAt,
    packs: index.packs,
    byId,
    expect: {
      packRows: index.packs.length,
      // quran-core carries 114 chapter rows + one row per ayah.
      surahs: chapters,
      ayahs: core.recordCount - chapters,
      words: words ? words.recordCount : 0,
      translations: translations.reduce((sum, pack) => sum + pack.recordCount, 0),
      tafsirs: tafsirs.reduce((sum, pack) => sum + pack.recordCount, 0),
      similar: similar ? similar.recordCount : 0,
      translationPackIds: translations.map((pack) => pack.id),
      tafsirPackIds: tafsirs.map((pack) => pack.id),
      perPackRecords: Object.fromEntries(index.packs.map((pack) => [pack.id, pack.recordCount])),
      checksums: Object.fromEntries(index.packs.map((pack) => [pack.id, pack.checksum])),
    },
  };
}

/**
 * Compare manifest-derived expectations with the documented constants.
 * Returns the list of mismatches; an empty list means the pack set on disk still
 * carries the numbers the docs claim.
 */
export function driftAgainstConstants(expect) {
  const problems = [];
  const check = (name, actual) => {
    if (actual !== EXPECTED_CONSTANTS[name]) problems.push(`${name}: manifest says ${actual}, docs say ${EXPECTED_CONSTANTS[name]}`);
  };
  check('surahs', expect.surahs);
  check('ayahs', expect.ayahs);
  check('words', expect.words);
  check('similarPairs', expect.similar);
  check('tafsirMuyassar', expect.perPackRecords['tafsir-ar-muyassar'] ?? 0);
  check('tafsirIbnKathir', expect.perPackRecords['tafsir-en-ibnkathir'] ?? 0);
  for (const id of expect.translationPackIds) {
    if (expect.perPackRecords[id] !== EXPECTED_CONSTANTS.translationsPerPack) {
      problems.push(`translation pack ${id}: ${expect.perPackRecords[id]} rows, docs say ${EXPECTED_CONSTANTS.translationsPerPack} each`);
    }
  }
  return problems;
}

/** Persian-grouped digits, the same locale the screens use (`formatNumber`). */
export function faNumber(value) {
  return new Intl.NumberFormat('fa-IR').format(value);
}

export function enNumber(value) {
  return new Intl.NumberFormat('en-US').format(value);
}

/* ------------------------------------------------------------------ canonical */

/** Mirror of core/src/backup/canonical-json.ts — see the header note. */
export function canonicalJsonStringify(value) {
  const walk = (node) => {
    if (node === null) return 'null';
    switch (typeof node) {
      case 'boolean':
        return node ? 'true' : 'false';
      case 'number': {
        if (!Number.isFinite(node)) throw new Error(`non-finite number in backup data`);
        return Object.is(node, -0) ? '0' : String(node);
      }
      case 'string':
        return JSON.stringify(node);
      case 'undefined':
      case 'bigint':
      case 'function':
      case 'symbol':
        throw new Error(`unsupported ${typeof node} value in backup data`);
      default:
        break;
    }
    if (Array.isArray(node)) return `[${node.map(walk).join(',')}]`;
    const record = node;
    const keys = Object.keys(record).filter((k) => record[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${walk(record[k])}`).join(',')}}`;
  };
  return walk(value);
}

export function sha256Hex(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/** The seal `computeDataChecksum` in core/src/backup/export.ts produces. */
export function dataChecksum(data) {
  return sha256Hex(canonicalJsonStringify(data));
}
