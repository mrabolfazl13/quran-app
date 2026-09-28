/**
 * The mutashābahāt screen reads `similar_ayah`, which is filled from
 * `plan.similar` — so a fresh import must produce non-zero similar rows or the
 * screen stays empty no matter what UI is built on top of it.
 *
 * This is that proof, run against the *real* packs on disk in `content/` rather
 * than fixtures: the derived `mutashabihat-ar` pack is imported exactly the way
 * the app imports it (same `buildImportPlan`, same checksum/byte/record-count
 * gates, same `mapRecords`, same `validatePlan`), with a `PackSource` standing in
 * for the Tauri command and the dev middleware — both of which read the same
 * files. Nothing here re-implements the mapping: if the pack shape ever stops
 * matching `records.ts`, this test fails instead of the screen silently showing
 * "no similar verses found".
 *
 * WHY the import is scoped to two packs: `word-data` alone is 18 MB / 83,665
 * records, and a test that allocates the whole corpus makes the suite the thing
 * that runs the machine out of memory. The two packs kept here are the pair that
 * matters for this assertion — the core pack supplies the ayahs, `mutashabihat-ar`
 * supplies the rows — and they are still taken from the real `content/index.json`,
 * so a missing or mis-id'd entry fails. Cross-pack integrity (`validatePlan`) then
 * genuinely proves that every pair lands on an ayah the imported mushaf carries.
 *
 * WHY the files come in through `import.meta.glob(…, '?raw')`: this workspace has
 * no `@types/node`, and the desktop tsconfig locks `types` to `vite/client`, so
 * `node:fs` would not typecheck. The raw-glob is the idiom the app's other tests
 * already use to read repository files, and the digests come from the same
 * `sha256Hex()` the browser dev shell uses.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { MUTASHABIHAT_PRODUCED_BY } from '@quran/core';
import type { ContentPackManifest, PackIndex, SimilarAyahPair } from '@quran/core';
import { buildImportPlan, type ImportOutcome } from './importer';
import { assertSafeRel, type PackSource } from './packSource';
import { sha256Hex } from './hash';

/**
 * The shipped pack files, read as text. Patterns are narrow on purpose: the
 * whole `content/` tree would drag 30 MB of payloads into the test process.
 */
const RAW = import.meta.glob(
  [
    '../../../content/index.json',
    '../../../content/mutashabihat-ar/payload.jsonl',
    '../../../content/quran-core/payload.jsonl',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

function rawFile(rel: string): string {
  const key = Object.keys(RAW).find((k) => k.endsWith(`/content/${rel}`));
  if (!key) throw new Error(`test cannot read content/${rel} — run \`npm run content:build\``);
  return RAW[key]!;
}

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/** Packs this import reads: the mushaf plus the derived pairs. */
const IMPORTED = ['quran-core', 'mutashabihat-ar'];

const realIndex = JSON.parse(rawFile('index.json')) as PackIndex;

/** The real index, narrowed to `IMPORTED` — entry order and fields untouched. */
const scopedIndex: PackIndex = {
  ...realIndex,
  packs: IMPORTED.map((id) => {
    const found = realIndex.packs.find((p) => p.id === id);
    if (!found) throw new Error(`content/index.json has no pack "${id}" — run \`npm run content:build\``);
    return found;
  }),
};

function manifestOf(id: string): ContentPackManifest {
  const found = scopedIndex.packs.find((p) => p.id === id);
  if (!found) throw new Error(`scoped index has no pack "${id}"`);
  return found;
}

const manifest = manifestOf('mutashabihat-ar');

/** Payload lines as shipped — the ground truth the import must match. */
function payloadLines(): string[] {
  return rawFile(`${manifest.id}/payload.jsonl`)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
}

const indexText = JSON.stringify(scopedIndex);

/**
 * A `PackSource` over the files above. `kind` is `'fetch'` because that is the
 * role it plays: like the dev middleware it hands back text the importer then
 * hashes itself (only the Tauri shell is given a native digest).
 */
function shippedPackSource(): PackSource {
  return {
    kind: 'fetch',
    location: 'content/ (repository build output)',
    async available() {
      return { root: 'content/', hasIndex: true };
    },
    async stat(rel) {
      assertSafeRel(rel);
      const text = rel === 'index.json' ? indexText : rawFile(rel);
      return { bytes: byteLength(text), sha256: await sha256Hex(new TextEncoder().encode(text)) };
    },
    async read(rel) {
      assertSafeRel(rel);
      const text = rel === 'index.json' ? indexText : rawFile(rel);
      return {
        rel,
        bytes: byteLength(text),
        sha256: await sha256Hex(new TextEncoder().encode(text)),
        text,
      };
    },
  };
}

/** `[chapter, verse]` so pairs compare without string ordering traps. */
function vk(key: string): [number, number] {
  const [chapter, verse] = key.split(':');
  return [Number(chapter), Number(verse)];
}

function isBefore(a: string, b: string): boolean {
  const [ac, av] = vk(a);
  const [bc, bv] = vk(b);
  return ac === bc ? av < bv : ac < bc;
}

/** Unordered pair identity: the earlier ayah first. */
function pairId(a: string, b: string): string {
  return isBefore(a, b) ? `${a}|${b}` : `${b}|${a}`;
}

describe('importing the derived mutashabihat pack', () => {
  let outcome: ImportOutcome;
  let rows: SimilarAyahPair[];

  beforeAll(async () => {
    outcome = await buildImportPlan(shippedPackSource());
    rows = outcome.plan?.similar ?? [];
  }, 120_000);

  it('imports the core pack and the derived pack without a failed stage', () => {
    expect(
      outcome.report.issue
        ? `${outcome.report.issue.stage}: ${outcome.report.issue.message}`
        : outcome.report.status,
    ).toBe('success');
    expect(outcome.plan).not.toBeNull();
    // The core pack is what makes a pair addressable at all.
    expect(outcome.report.counts.ayahs).toBe(6236);
  });

  it('produces non-zero similar rows — the screen has data to show', () => {
    expect(rows.length).toBeGreaterThan(0);
    expect(outcome.report.counts.similar).toBe(rows.length);
    expect(outcome.report.counts.similar).toBe(manifest.recordCount);
    expect(manifest.recordCount).toBe(payloadLines().length);
  });

  it('labels every row as engine-computed, never as a pack id', () => {
    const wrong = rows.filter((r) => r.producedBy !== MUTASHABIHAT_PRODUCED_BY);
    expect(wrong).toEqual([]);
  });

  it('ships each unordered pair exactly once, in canonical direction', () => {
    const ids = rows.map((r) => pairId(r.verseKeyA, r.verseKeyB));
    expect(new Set(ids).size).toBe(ids.length);
    expect(rows.filter((r) => !isBefore(r.verseKeyA, r.verseKeyB))).toEqual([]);
  });

  it('keeps scores in range and both keys on real ayahs', () => {
    const ayahKeys = new Set((outcome.plan?.ayahs ?? []).map((a) => a.verseKey));
    const missing = rows.filter(
      (r) => !ayahKeys.has(r.verseKeyA) || !ayahKeys.has(r.verseKeyB) || r.verseKeyA === r.verseKeyB,
    );
    expect(missing).toEqual([]);
    expect(rows.filter((r) => !(r.textScore >= 0 && r.textScore <= 1))).toEqual([]);
    expect(rows.filter((r) => !Array.isArray(r.differingWords))).toEqual([]);
  });

  it('agrees line-for-line with the shipped payload', () => {
    const fromDisk = new Map<string, { score: number; phrase: string | null }>();
    for (const line of payloadLines()) {
      const rec = JSON.parse(line) as {
        verseKeyA: string;
        verseKeyB: string;
        textScore: number;
        sharedPhrase: string | null;
      };
      fromDisk.set(pairId(rec.verseKeyA, rec.verseKeyB), { score: rec.textScore, phrase: rec.sharedPhrase });
    }
    expect(fromDisk.size).toBe(rows.length);
    for (const row of rows) {
      const expected = fromDisk.get(pairId(row.verseKeyA, row.verseKeyB));
      expect(expected?.score).toBe(row.textScore);
      expect(expected?.phrase).toBe(row.sharedPhrase);
    }
  });

  it('keeps the honest labelling all the way into the imported pack row', () => {
    expect(manifest.kind).toBe('linguistic');
    expect(manifest.license.status).toBe('unresolved');
    expect(manifest.source).not.toMatch(/^https?:\/\//);
    const row = outcome.plan?.packs.find((p) => p.id === 'mutashabihat-ar');
    expect(row?.licenseStatus).toBe('unresolved');
    expect(row?.checksum).toBe(manifest.checksum);
    expect(row?.source).toBe(manifest.source);
    expect(byteLength(rawFile(`${manifest.id}/payload.jsonl`))).toBe(manifest.payloadBytes);
  });

  it('maps worked examples the engine really produced', () => {
    // WHY the expected phrases are read from the payload instead of typed here:
    // this is Qur’an wording, and a hand-retyped Arabic literal in a test is one
    // hamza away from a false claim. What is asserted is the *structure* of each
    // example — its score, empty/present differing words, and the phrase being
    // the one the pack ships for exactly this pair.
    const byKey = new Map(rows.map((r) => [pairId(r.verseKeyA, r.verseKeyB), r]));
    const shipped = new Map(
      payloadLines().map((line) => {
        const rec = JSON.parse(line) as { verseKeyA: string; verseKeyB: string; sharedPhrase: string | null };
        return [pairId(rec.verseKeyA, rec.verseKeyB), rec.sharedPhrase] as const;
      }),
    );

    // 55:13 ↔ 55:16 — the same refrain twice: score 1, nothing differing.
    const refrainKey = pairId('55:13', '55:16');
    const refrain = byKey.get(refrainKey);
    expect(refrain?.textScore).toBe(1);
    expect(refrain?.differingWords).toEqual([]);
    expect(refrain?.sharedPhrase).toBeTruthy();
    expect(refrain?.sharedPhrase).toBe(shipped.get(refrainKey));

    // 1:1 ↔ 27:30 — the basmala wording, on the engine's own acceptance floor,
    // with the rest of Solomon's verse recorded as the differing words.
    const basmalaKey = pairId('1:1', '27:30');
    const basmala = byKey.get(basmalaKey);
    expect(basmala?.textScore).toBe(0.5);
    expect(basmala?.sharedPhrase).toBe(shipped.get(basmalaKey));
    expect(String(basmala?.sharedPhrase).split(' ').length).toBeGreaterThan(1);
    expect((basmala?.differingWords.length ?? 0)).toBeGreaterThan(0);
  });
});
