/**
 * The derived mutashābahāt pack is re-proved from its input, with no network and
 * no re-fetch.
 *
 * WHY: the pack's whole claim is "these pairs are what the engine says, and the
 * same bytes come out every time". Two things can quietly break that and neither
 * is visible in the app:
 *   • someone hand-edits `content/mutashabihat-ar/payload.jsonl`, or a row goes
 *     stale after the core text pack is rebuilt — the manifest checksum would
 *     still match if they also edited the manifest, so the check has to be
 *     *semantic*: recompute the pairs and compare;
 *   • the build stops being deterministic, which makes every future checksum
 *     diff meaningless.
 * So this test runs `core/src/mutashabihat` over the *shipped* `quran-core`
 * payload and requires the shipped `mutashabihat-ar` payload byte for byte.
 *
 * It reuses the pipeline's own module (`src/mutashabihatPack.ts`) instead of a
 * copy of the math, and reads only files already present under `content/` —
 * nothing is fetched, nothing is written here. The engine index is built once
 * for the whole file: on this machine a second copy of 6,236 normalised ayahs is
 * the difference between a test suite and an out-of-memory kill.
 *
 * Run: `npm run test --workspace @quran/content` (or `npx vitest run` inside
 * `tools/content`). It needs the packs to exist, i.e. `npm run content:build`.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  MIN_SCORE_DEFAULT,
  MUTASHABIHAT_PRODUCED_BY,
  buildSimilarityIndex,
  pairTextScore,
} from '../../../core/src/mutashabihat/index.ts';
import { normalizeWord, tokenizeWords } from '../../../core/src/normalize/arabic.ts';
import type { Ayah } from '../../../core/src/contracts/quran.ts';
import type { ContentPackManifest, PackIndex } from '../../../core/src/contracts/content-pack.ts';
import {
  MUTASHABIHAT_PACK_ID,
  MUTASHABIHAT_RECORD_TYPE,
  buildMutashabihatPack,
  compareVerseKeys,
  coreAyahsFromPayload,
  type DerivedContentPackManifest,
  type SimilarAyahRecord,
} from '../src/mutashabihatPack.ts';

const CONTENT_ROOT = fileURLToPath(new URL('../../../content', import.meta.url));
const read = (rel: string): string => readFileSync(`${CONTENT_ROOT}/${rel}`, 'utf8');
const sha256 = (text: string): string => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

const corePayload = read('quran-core/payload.jsonl');
const coreSha = sha256(corePayload);

const shippedPayload = read(`${MUTASHABIHAT_PACK_ID}/payload.jsonl`);
const packManifest = JSON.parse(read(`${MUTASHABIHAT_PACK_ID}/pack.json`)) as DerivedContentPackManifest;
const index = JSON.parse(read('index.json')) as PackIndex;
const indexManifest = index.packs.find((p) => p.id === MUTASHABIHAT_PACK_ID) as DerivedContentPackManifest;
const coreManifest = index.packs.find((p) => p.kind === 'quran-core') as ContentPackManifest;

const shippedRecords = shippedPayload
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as SimilarAyahRecord);

/** Engine-normalised tokens of an ayah — the same view the score was computed on. */
const tokens = (ayah: Ayah): string[] => tokenizeWords(ayah.textUthmani).map((t) => normalizeWord(t));

function containsRun(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    let ok = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

describe('mutashabihat-ar pack', () => {
  type SimilarityDocs = ReturnType<typeof buildSimilarityIndex>['byVerseKey'];

  let ayahs: Ayah[];
  let rebuilt: string;
  let docs: SimilarityDocs;

  beforeAll(() => {
    ayahs = coreAyahsFromPayload(corePayload);
    rebuilt = buildMutashabihatPack({ ayahs, corePayloadSha256: coreSha }).payload;
    docs = buildSimilarityIndex(ayahs).byVerseKey;
  }, 240_000);

  it('recomputes to the shipped payload, byte for byte', () => {
    expect(rebuilt).toBe(shippedPayload);
    expect(sha256(shippedPayload)).toBe(packManifest.checksum);
  });

  it('is the same manifest in pack.json and in content/index.json', () => {
    // The importer reads the index; the per-pack manifest is its human-facing copy.
    expect(indexManifest).toEqual(packManifest);
    expect(indexManifest.checksum).toBe(sha256(shippedPayload));
    expect(indexManifest.payloadBytes).toBe(Buffer.byteLength(shippedPayload, 'utf8'));
    expect(indexManifest.recordCount).toBe(shippedRecords.length);
    expect(indexManifest.id).toBe(MUTASHABIHAT_PACK_ID);
  });

  it('records the input it was derived from, so a stale pack is detectable', () => {
    expect(ayahs.length).toBe(6236);
    expect(indexManifest.derived.input.packId).toBe('quran-core');
    expect(indexManifest.derived.input.payloadFile).toBe('content/quran-core/payload.jsonl');
    expect(indexManifest.derived.input.payloadSha256).toBe(coreSha);
    expect(indexManifest.derived.input.ayahCount).toBe(ayahs.length);
    expect(indexManifest.license.notes).toContain(coreSha);
  });

  it('says computed, not scholarly, and inherits the source licence', () => {
    expect(indexManifest.derived.computed).toBe(true);
    expect(indexManifest.derived.producedBy).toBe(MUTASHABIHAT_PRODUCED_BY);
    expect(indexManifest.derived.not.join(' ')).toMatch(/scholarly/i);
    expect(indexManifest.derived.not.join(' ')).toMatch(/asbab/i);
    expect(indexManifest.title).toMatch(/computed/i);
    expect(indexManifest.source).toBe('computed at build time from content/quran-core/payload.jsonl');
    // The Uthmani source ships `unresolved`; a derived work may not claim better.
    expect(coreManifest.license.status).toBe('unresolved');
    expect(indexManifest.license.status).toBe(coreManifest.license.status);
    expect(indexManifest.kind).toBe('linguistic');
  });

  it('stores only rows the engine still stands behind', () => {
    const offEngine = shippedRecords.filter((r) => {
      const a = docs.get(r.verseKeyA);
      const b = docs.get(r.verseKeyB);
      if (!a || !b) return true;
      return (
        r.textScore !== Number(pairTextScore(a, b).toFixed(4)) ||
        r.producedBy !== MUTASHABIHAT_PRODUCED_BY
      );
    });
    expect(offEngine).toEqual([]);
    expect(shippedRecords.filter((r) => r.textScore < MIN_SCORE_DEFAULT)).toEqual([]);
  });

  it('is sorted, canonical, unique and typed', () => {
    expect(shippedRecords.filter((r) => r._t !== MUTASHABIHAT_RECORD_TYPE)).toEqual([]);
    const keys = shippedRecords.map((r) => `${r.verseKeyA}|${r.verseKeyB}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(shippedRecords.filter((r) => compareVerseKeys(r.verseKeyA, r.verseKeyB) >= 0)).toEqual([]);
    const orderBreaks: string[] = [];
    for (let i = 1; i < shippedRecords.length; i += 1) {
      const prev = shippedRecords[i - 1]!;
      const cur = shippedRecords[i]!;
      if (
        compareVerseKeys(prev.verseKeyA, cur.verseKeyA) >= 0 &&
        compareVerseKeys(prev.verseKeyB, cur.verseKeyB) >= 0
      ) {
        orderBreaks.push(`${prev.verseKeyA}|${prev.verseKeyB} before ${cur.verseKeyA}|${cur.verseKeyB}`);
      }
    }
    expect(orderBreaks).toEqual([]);
  });

  it('keeps the coverage numbers the build reported honest', () => {
    const covered = new Set<string>();
    for (const r of shippedRecords) {
      covered.add(r.verseKeyA);
      covered.add(r.verseKeyB);
    }
    expect(indexManifest.derived.result.pairs).toBe(shippedRecords.length);
    expect(indexManifest.derived.result.ayahsWithAtLeastOnePair).toBe(covered.size);
    expect(indexManifest.derived.result.corpusAyahs).toBe(ayahs.length);
    expect(indexManifest.derived.result.pairsAtScoreOne).toBe(
      shippedRecords.filter((r) => r.textScore === 1).length,
    );
    expect(indexManifest.derived.result.pairsWithSharedPhrase).toBe(
      shippedRecords.filter((r) => r.sharedPhrase !== null).length,
    );
    expect(indexManifest.derived.result.coveragePercent).toBe(
      Number(((covered.size / ayahs.length) * 100).toFixed(1)),
    );
  });

  it('quotes a shared phrase that is a real run of words in both ayat', () => {
    // `buildPair()` takes the phrase from the *raw* tokens of its second
    // document (`b.rawTokens.slice(run.startB, …)`) — and the pack always stores
    // the canonically smaller key first, so the wording shown to a reader is a
    // contiguous slice of `verseKeyB`'s own text whose normalised form is also a
    // contiguous run inside `verseKeyA`. Neither may be invented wording.
    const byVerseKey = new Map(ayahs.map((a) => [a.verseKey, a] as const));
    const broken: string[] = [];
    for (const r of shippedRecords) {
      if (r.sharedPhrase === null) continue;
      const phrase = r.sharedPhrase.split(' ').filter((t) => t !== '');
      const a = byVerseKey.get(r.verseKeyA);
      const b = byVerseKey.get(r.verseKeyB);
      if (!a || !b) {
        broken.push(`${r.verseKeyA}|${r.verseKeyB}: ayah missing`);
        continue;
      }
      const rawB = tokenizeWords(b.textUthmani);
      if (!containsRun(rawB, phrase)) {
        broken.push(`${r.verseKeyA}|${r.verseKeyB}: not a raw run of ${r.verseKeyB}`);
        continue;
      }
      const normPhrase = phrase.map((t) => normalizeWord(t));
      if (!containsRun(tokens(a), normPhrase) || !containsRun(tokens(b), normPhrase)) {
        broken.push(`${r.verseKeyA}|${r.verseKeyB}: not a normalised run of both`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('reports the pair count the pack actually carries', () => {
    // A single place to look for "did the shipped set change?" — the number the
    // docs and the build log quote.
    expect(shippedRecords.length).toBe(1732);
  });
});
