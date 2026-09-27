/**
 * Mutashabihat engine tests: pair quality on real repeated Quranic
 * phrasing, the short-ayah flooding guard, exact brute-force agreement on
 * the small fixture corpus, confusion clustering, provenance, and a
 * measured complexity run on a synthetic 6236-ayah corpus (the real ayah
 * count) that reports the actual pair/time numbers.
 */

import { describe, expect, it } from 'vitest';
import type { Ayah, SimilarAyahPair, VerseKey } from '../../src/contracts/quran';
import {
  GROUP_MIN_SCORE,
  MIN_SCORE_DEFAULT,
  MIN_SCORE_SHORT,
  MUTASHABIHAT_PRODUCED_BY,
  SHORT_AYAH_MAX_WORDS,
  SHORT_AYAH_RESULT_CAP,
  buildConfusionCandidates,
  buildSimilarityIndex,
  bruteForceFindSimilar,
  findSimilar,
  pairTextScore,
  pairToAyahRelation,
  toSimilarityDoc,
} from '../../src/mutashabihat/index';
import {
  REAL_FIXTURE_AYAHS,
  SYNTHETIC_SHORT_AYAHS,
  SYNTHETIC_UNRELATED_SHORT_AYAHS,
  mkAyah,
} from '../search/fixtures';

// This tsconfig deliberately has no DOM/node lib (vitest/globals only);
// declare the two host facilities the measurement test needs.
declare const console: { log: (message?: unknown, ...args: unknown[]) => void };
declare const performance: { now: () => number };

const CORPUS: Ayah[] = [
  ...REAL_FIXTURE_AYAHS,
  ...SYNTHETIC_SHORT_AYAHS,
  ...SYNTHETIC_UNRELATED_SHORT_AYAHS,
];

const index = buildSimilarityIndex(CORPUS);

describe('real repeated Quranic phrasing (ar-Rahman 55, as-Saffat 37)', () => {
  it('the ar-Rahman refrain pairs with score exactly 1 and no differing words', () => {
    const pairs = findSimilar('55:13' as VerseKey, { index });
    expect(pairs).toHaveLength(1);
    const p = pairs[0]!;
    expect(p.verseKeyA).toBe('55:13');
    expect(p.verseKeyB).toBe('55:77');
    expect(p.textScore).toBe(1);
    expect(p.sharedPhrase).toBe('فَبِأَيِّ آلَاءِ رَبِّكُمَا تُكَذِّبَانِ');
    expect(p.differingWords).toEqual([]);
  });

  it('near-identical 55:54 / 55:76 differ exactly in حشو / رفرف', () => {
    const pairs = findSimilar('55:54' as VerseKey, { index });
    const p = pairs.find((x) => x.verseKeyB === '55:76')!;
    expect(p).toBeDefined();
    expect(p.textScore).toBeCloseTo(0.8333, 3);
    expect(p.differingWords).toEqual(['رَفْرَفٍ', 'حَشْوٍ']);
    expect(p.sharedPhrase).toBe('خُضْرٍ وَعَبْقَرِيٍّ حِسَانٍ');
  });

  it('the as-Saffat salam pair (37:130/131) is found above the default bar', () => {
    const pairs = findSimilar('37:130' as VerseKey, { index });
    const p = pairs.find((x) => x.verseKeyB === '37:131')!;
    expect(p).toBeDefined();
    expect(p.textScore).toBeGreaterThanOrEqual(MIN_SCORE_DEFAULT);
    expect(p.differingWords).toContain('إِبْرَاهِيمَ');
    expect(p.sharedPhrase).toBe('سَلامٌ عَلَى');
  });

  it('37:120/159 pair at 1, with 37:180 as a weaker "عما يصفون" ending match', () => {
    const pairs = findSimilar('37:120' as VerseKey, { index });
    expect(pairs.map((p) => p.verseKeyB)).toEqual(['37:159', '37:180']);
    expect(pairs[0]!.textScore).toBe(1);
    expect(pairs[1]!.textScore).toBeCloseTo(0.5, 5);
    expect(pairs[1]!.sharedPhrase).toBe('عَمَّا يَصِفُونَ');
  });

  it('diacritic-only surface differences collapse to score 1 (55:67 vs 55:78)', () => {
    const a = toSimilarityDoc(mkAyah(900, 1, 'تَبَارَكَ اسْمُ رَبِّكَ ذِي الْجَلالِ وَالإكْرَامِ'));
    const b = toSimilarityDoc(mkAyah(900, 2, 'تَبَارَكَ اسْمِ رَبِّكَ ذِي الْجَلالِ وَالإكْرَامِ'));
    expect(pairTextScore(a, b)).toBe(1);
  });
});

describe('short-ayah flooding guard', () => {
  it('constant is as documented', () => {
    expect(SHORT_AYAH_MAX_WORDS).toBe(3);
    expect(SHORT_AYAH_RESULT_CAP).toBe(5);
    expect(MIN_SCORE_SHORT).toBeGreaterThan(MIN_SCORE_DEFAULT);
  });

  it('eight identical one-word synthetic ayahs produce at most the cap, not a flood', () => {
    const pairs = findSimilar('777:1' as VerseKey, { index });
    expect(pairs.length).toBe(SHORT_AYAH_RESULT_CAP); // 7 mutual matches capped to 5
    expect(pairs.every((p) => p.textScore === 1)).toBe(true);
  });

  it('a one-word ayah that shares nothing normalised returns zero results', () => {
    expect(findSimilar('103:1' as VerseKey, { index })).toHaveLength(0);
    expect(findSimilar('778:1' as VerseKey, { index })).toHaveLength(0);
  });

  it('a short query against a longer ayah needs proportional overlap: 1:2 is not "similar" to 777:x', () => {
    const pairs = findSimilar('777:2' as VerseKey, { index });
    expect(pairs.map((p) => p.verseKeyB)).not.toContain('1:2');
  });
});

describe('blocking correctness vs brute force', () => {
  it('findSimilar agrees EXACTLY with the brute-force oracle for every anchor in the fixture corpus', () => {
    for (const ayah of CORPUS) {
      const indexed = findSimilar(ayah.verseKey, { index });
      const brute = bruteForceFindSimilar(ayah.verseKey, CORPUS);
      expect(
        indexed.map((p) => `${p.verseKeyB}@${p.textScore.toFixed(6)}`),
        `anchor ${ayah.verseKey}`,
      ).toEqual(brute.map((p) => `${p.verseKeyB}@${p.textScore.toFixed(6)}`));
    }
  });

  it('every candidate pair is a unique unordered pair with no self-loops', () => {
    const seen = new Set<string>();
    for (const cp of index.candidatePairs) {
      expect(cp.verseKeyA).not.toBe(cp.verseKeyB);
      const key = `${cp.verseKeyA}|${cp.verseKeyB}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('adjacency is symmetric', () => {
    for (const [a, set] of index.adjacency) {
      for (const b of set) expect(index.adjacency.get(b)!.has(a)).toBe(true);
    }
  });
});

describe('confusion clustering for the Hifz engine', () => {
  it('emits the refrain cluster and the identical synthetic cluster with provenance', () => {
    const clusters = buildConfusionCandidates(index);
    const keySets = clusters.map((c) => c.verseKeys.join(','));
    expect(keySets).toContain('55:13,55:77');
    expect(keySets).toContain('37:120,37:159');
    expect(keySets).toContain('55:67,55:78');
    expect(keySets).toContain(
      SYNTHETIC_SHORT_AYAHS.map((a) => a.verseKey).join(','),
    );
    for (const c of clusters) {
      expect(c.verseKeys.length).toBeGreaterThanOrEqual(2);
      expect(c.producedBy).toBe(MUTASHABIHAT_PRODUCED_BY);
      expect(c.minPairScore).toBeGreaterThanOrEqual(GROUP_MIN_SCORE);
    }
  });

  it('cluster members are mutually similar above the threshold', () => {
    const clusters = buildConfusionCandidates(index);
    const refrain = clusters.find((c) => c.verseKeys.includes('55:13'))!;
    for (let i = 0; i < refrain.verseKeys.length; i++) {
      for (let j = i + 1; j < refrain.verseKeys.length; j++) {
        const a = index.byVerseKey.get(refrain.verseKeys[i]!)!;
        const b = index.byVerseKey.get(refrain.verseKeys[j]!)!;
        expect(pairTextScore(a, b)).toBeGreaterThanOrEqual(GROUP_MIN_SCORE);
      }
    }
  });

  it('the 0.5 salam pair stays below the cluster bar and is not grouped', () => {
    const clusters = buildConfusionCandidates(index);
    const grouped = clusters.some(
      (c) => c.verseKeys.includes('37:130') && c.verseKeys.includes('37:131'),
    );
    expect(grouped).toBe(false);
  });
});

describe('provenance and relation typing', () => {
  it('every emitted pair carries the algorithm id and version', () => {
    for (const ayah of [REAL_FIXTURE_AYAHS[0]!, REAL_FIXTURE_AYAHS[3]!]) {
      for (const p of findSimilar(ayah.verseKey, { index })) {
        expect(p.producedBy).toBe(MUTASHABIHAT_PRODUCED_BY);
      }
    }
    for (const p of findSimilar('55:54' as VerseKey, { index })) {
      expect(p.producedBy).toContain('mutashabihat-blocking');
    }
  });

  it('near-verbatim pairs project to textual relations; vocabulary-only overlap is linguistic', () => {
    const refrainPair = findSimilar('55:13' as VerseKey, { index })[0]!;
    const rel = pairToAyahRelation(refrainPair);
    expect(rel.type).toBe('textual');
    expect(rel.reason).toContain('computed text similarity');
    expect(rel.reason).toContain('not a scholarly or religious claim');
    expect(rel.producedBy).toBe(MUTASHABIHAT_PRODUCED_BY);

    const weak: SimilarAyahPair = {
      verseKeyA: '1:1',
      verseKeyB: '1:2',
      textScore: 0.55,
      sharedPhrase: 'رب',
      differingWords: ['a', 'b'],
      producedBy: MUTASHABIHAT_PRODUCED_BY,
    };
    expect(pairToAyahRelation(weak).type).toBe('linguistic');
  });

  it('this module NEVER emits an explicit relation type', () => {
    for (const ayah of CORPUS) {
      for (const p of findSimilar(ayah.verseKey, { index })) {
        expect(pairToAyahRelation(p).type).not.toBe('explicit');
      }
    }
  });
});

describe('measured complexity on a synthetic 6236-ayah corpus', () => {
  // Fully deterministic generator (no randomness): token indexes are plain
  // arithmetic over the ayah number, so the corpus is stable run-to-run.
  function wordAt(idx: number): string {
    const first = 0x0628 + (idx % 50);
    const second = 0x064a + (Math.floor(idx / 50) % 20);
    const third = 0x0645 + (Math.floor(idx / 1000) % 20);
    return String.fromCharCode(first, second, third);
  }

  function syntheticCorpus(n: number): Ayah[] {
    const out: Ayah[] = [];
    for (let i = 0; i < n; i++) {
      const chapter = 1 + Math.floor(i / 7);
      const verse = (i % 7) + 1;
      let text: string;
      if (i > 0 && i % 100 === 0) {
        // Injected repeated ayah: identical to the previous one — the
        // blocking index must still find it.
        text = out[i - 1]!.textUthmani;
      } else if (i % 500 === 0) {
        text = wordAt(i * 3 + 1); // one-word ayah — short-ayah guard territory
      } else {
        const len = 3 + ((i * 5) % 12);
        const tokens = [wordAt(0)]; // global stop-word: df = n, never a key
        tokens.push(wordAt(13 + (i % 61))); // semi-common band, df ≈ n/61
        for (let j = 0; j < len; j++) tokens.push(wordAt((i * 131 + j * 7) % 12_000));
        text = tokens.join(' ');
      }
      out.push(mkAyah(chapter, verse, text));
    }
    return out;
  }

  it('blocking cuts the comparison space by >10x and still finds the injected identical pair', () => {
    const corpus = syntheticCorpus(6236);
    expect(corpus.length).toBe(6236);
    expect(new Set(corpus.map((a) => a.verseKey)).size).toBe(6236);

    const t0 = performance.now();
    const big = buildSimilarityIndex(corpus);
    const buildMs = performance.now() - t0;

    const t1 = performance.now();
    const pairs = findSimilar('15:3' as VerseKey, { index: big }); // duplicate of 15:2
    const queryMs = performance.now() - t1;

    expect(big.stats.ayahCount).toBe(6236);
    expect(big.stats.bruteForcePairs).toBe((6236 * 6235) / 2); // 19 441 710
    expect(big.stats.candidatePairs).toBeGreaterThan(0);
    expect(big.stats.candidatePairs * 10).toBeLessThan(big.stats.bruteForcePairs);
    expect(pairs.map((p) => p.verseKeyB)).toContain('15:2');
    expect(pairs.find((p) => p.verseKeyB === '15:2')!.textScore).toBe(1);
    expect(buildMs).toBeLessThan(20_000);

    console.log(
      `[mutashabihat perf] 6236 ayahs: buckets=${big.stats.bucketCount} ` +
        `candidatePairs=${big.stats.candidatePairs} ` +
        `(bruteForce=${big.stats.bruteForcePairs}, ` +
        `${((big.stats.candidatePairs / big.stats.bruteForcePairs) * 100).toFixed(2)}% of O(n²))) ` +
        `rareDfThreshold=${big.stats.rareDfThreshold} ` +
        `build=${buildMs.toFixed(0)}ms query(findSimilar)=${queryMs.toFixed(1)}ms ` +
        `results=${pairs.length}`,
    );
  });

  it('fixture-corpus similarity numbers (documentation record)', () => {
    const report: string[] = [];
    for (const anchor of ['55:13', '55:54', '37:130', '37:120'] as VerseKey[]) {
      for (const p of findSimilar(anchor, { index })) {
        report.push(`${anchor}→${p.verseKeyB} score=${p.textScore.toFixed(4)} phrase=${JSON.stringify(p.sharedPhrase)}`);
      }
    }
    console.log(`[mutashabihat fixtures]\n${report.join('\n')}`);
    expect(report.length).toBeGreaterThan(4);
  });
});
