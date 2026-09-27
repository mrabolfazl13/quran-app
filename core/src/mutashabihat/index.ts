/**
 * Mutashabihat (similar-ayah) engine — deterministic, framework-free.
 *
 * Builds candidate similar-ayah pairs over the full corpus using cheap
 * blocking (shared rare-word buckets + length-band + size-ratio filters) so
 * we never do the full O(n²) ≈ 19.4M comparison over 6236 ayahs. See
 * `docs/mutashabihat.md` for the blocking strategy, thresholds and the
 * documented recall/precision trade-off vs brute force.
 *
 * What this is NOT: a religious claim. Pairs here are *computed textual
 * similarity* (`type: 'textual'/'linguistic'`, never `'explicit'`), offered as
 * study candidates for hifz review. Only relations that a licensed content
 * pack states verbatim may carry `RelationType 'explicit'`, and this module
 * never produces those.
 *
 * Similarity math is imported from `../normalize/arabic` (`normalizeWord`,
 * `tokenizeWords`, `setSimilarity`, `tokenSimilarity`) — the single place
 * where "the same word" is defined. Nothing here re-implements it.
 */

import type { Ayah, AyahRelation, SimilarAyahPair, VerseKey } from '../contracts/quran';
import { normalizeWord, setSimilarity, tokenSimilarity, tokenizeWords } from '../normalize/arabic';

/* ------------------------------------------------------------------ */
/* Provenance — every emitted pair records these                       */
/* ------------------------------------------------------------------ */

export const MUTASHABIHAT_ALGORITHM_ID = 'mutashabihat-blocking';
export const MUTASHABIHAT_ALGORITHM_VERSION = 1;
export const MUTASHABIHAT_PRODUCED_BY = `algorithm:${MUTASHABIHAT_ALGORITHM_ID}@v${MUTASHABIHAT_ALGORITHM_VERSION}`;

/* ------------------------------------------------------------------ */
/* Named thresholds (documented in docs/mutashabihat.md)               */
/* ------------------------------------------------------------------ */

/** Minimum textScore reported by `findSimilar` unless a caller overrides. */
export const MIN_SCORE_DEFAULT = 0.5;
/** A word is "common" (useless for blocking) when its document frequency
 * exceeds RARE_DF_FRACTION of the corpus, but never below RARE_DF_FLOOR. */
export const RARE_DF_FRACTION = 0.02;
export const RARE_DF_FLOOR = 24;
/** Max rarest words an ayah contributes to blocking buckets. Bounds the
 * per-ayah candidate fan-out at RARE_WORDS_PER_AYAH × max bucket size. */
export const RARE_WORDS_PER_AYAH = 6;
/** Length band prefilter: skip a pair when the word counts differ by more
 * than max(LENGTH_BAND_ABS, LENGTH_BAND_FRACTION × the smaller count). */
export const LENGTH_BAND_ABS = 6;
export const LENGTH_BAND_FRACTION = 0.5;
/** Absolute lower bound on shared normalised words for any reported pair. */
export const MIN_SHARED_WORDS = 2;
/** Ayahs with at most this many words are "short": structurally similar to
 * everything, so they get a raised score bar, a stricter shared-word ratio
 * and a result cap. */
export const SHORT_AYAH_MAX_WORDS = 3;
export const MIN_SCORE_SHORT = 0.85;
export const SHORT_AYAH_SHARED_RATIO = 0.8;
export const SHORT_AYAH_RESULT_CAP = 5;
/** Fraction of the shared-word guard for normal-length ayahs. */
export const SHARED_RATIO_DEFAULT = 0.3;
/** Cap per query unless `opts.limit` is given. */
export const FIND_SIMILAR_DEFAULT_LIMIT = 50;
/** Pair score needed to join a confusion cluster. */
export const GROUP_MIN_SCORE = 0.6;
/** Only clusters of at least this many mutually similar ayahs are emitted. */
export const GROUP_MIN_SIZE = 2;
/** Pairs at or above this score, or with a contiguous shared phrase of at
 * least GROUP_PHRASE_TOKENS words, are labelled 'textual'; weaker
 * vocabulary overlaps are labelled 'linguistic'. */
export const TEXTUAL_SCORE_FLOOR = 0.75;
export const GROUP_PHRASE_TOKENS = 2;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface SimilarityDoc {
  verseKey: VerseKey;
  /** Raw whitespace tokens of `textUthmani` (display source). */
  rawTokens: string[];
  /** Canonical tokens: `tokenizeWords` then `normalizeWord`. */
  normTokens: string[];
  uniqueNorm: string[];
  wordCount: number;
}

export interface CandidatePair {
  verseKeyA: VerseKey;
  verseKeyB: VerseKey;
}

export interface SimilarityIndexStats {
  ayahCount: number;
  rareDfThreshold: number;
  bucketCount: number;
  /** Unique candidate pairs produced by blocking (before scoring). */
  candidatePairs: number;
  /** The O(n²) pair count blocking replaces. */
  bruteForcePairs: number;
}

export interface SimilarityIndex {
  algorithm: typeof MUTASHABIHAT_ALGORITHM_ID;
  version: typeof MUTASHABIHAT_ALGORITHM_VERSION;
  docs: SimilarityDoc[];
  byVerseKey: Map<VerseKey, SimilarityDoc>;
  /** verseKey → candidate neighbours from blocking (superset of results). */
  adjacency: Map<VerseKey, Set<VerseKey>>;
  /** Diagnostic: candidate pairs as `a|b` (a canonical-smaller), ascending. */
  candidatePairs: CandidatePair[];
  stats: SimilarityIndexStats;
}

export interface FindSimilarOptions {
  index?: SimilarityIndex;
  /** Minimum textScore; short-ayah queries are automatically raised to
   * MIN_SCORE_SHORT. */
  minScore?: number;
  limit?: number;
}

/** Engine-proposed confusion cluster; consumed by the Hifz engine's
 * confusion.ts, which assigns user-visible ids and timestamps. */
export interface ConfusionCandidate {
  id: string;
  verseKeys: VerseKey[];
  /** Weakest intra-cluster score — an honest lower bound on cluster quality. */
  minPairScore: number;
  producedBy: string;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function verseKeyOrder(a: VerseKey, b: VerseKey): number {
  const [ca, va] = a.split(':');
  const [cb, vb] = b.split(':');
  const cn = Number(ca) - Number(cb);
  if (cn !== 0) return cn;
  return Number(va) - Number(vb);
}

function pairKey(a: VerseKey, b: VerseKey): { a: VerseKey; b: VerseKey } {
  return verseKeyOrder(a, b) <= 0 ? { a, b } : { a: b, b: a };
}

export function toSimilarityDoc(ayah: Ayah): SimilarityDoc {
  const rawTokens = tokenizeWords(ayah.textUthmani);
  const normTokens = rawTokens.map(normalizeWord);
  return {
    verseKey: ayah.verseKey,
    rawTokens,
    normTokens,
    uniqueNorm: [...new Set(normTokens)],
    wordCount: normTokens.length,
  };
}

/**
 * The similarity used everywhere here: the maximum of order-insensitive
 * Jaccard (`setSimilarity`) and order-sensitive normalised edit similarity
 * (`tokenSimilarity`), both computed on canonical normalised tokens by
 * `../normalize/arabic`. Max (not mean) is deliberate: a re-ordered but
 * identical vocabulary is still a confusion risk for a memoriser.
 */
export function pairTextScore(a: SimilarityDoc, b: SimilarityDoc): number {
  return Math.max(setSimilarity(a.normTokens, b.normTokens), tokenSimilarity(a.normTokens, b.normTokens));
}

function sharedWordCount(a: SimilarityDoc, b: SimilarityDoc): number {
  const setB = new Set(b.normTokens);
  let n = 0;
  for (const w of new Set(a.normTokens)) if (setB.has(w)) n++;
  return n;
}

function lengthBandPass(a: SimilarityDoc, b: SimilarityDoc): boolean {
  const minW = Math.min(a.wordCount, b.wordCount);
  const delta = Math.max(LENGTH_BAND_ABS, Math.ceil(LENGTH_BAND_FRACTION * minW));
  return Math.abs(a.wordCount - b.wordCount) <= delta;
}

/** Longest contiguous run of equal canonical tokens (DP over the two arrays). */
function longestCommonRun(a: string[], b: string[]): { startB: number; length: number } {
  let best = 0;
  let bestStartB = 0;
  if (a.length === 0 || b.length === 0) return { startB: 0, length: 0 };
  let prevRow = new Array<number>(b.length + 1).fill(0);
  const curRow = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      curRow[j] = a[i - 1] === b[j - 1] ? prevRow[j - 1]! + 1 : 0;
      if (curRow[j]! > best) {
        best = curRow[j]!;
        bestStartB = j - best;
      }
    }
    for (let j = 0; j <= b.length; j++) prevRow[j] = curRow[j]!;
  }
  return { startB: bestStartB, length: best };
}

/**
 * Words that differ between the two ayahs — the payload the UI highlights so
 * a memoriser never conflates the pair. Surface forms (raw tokens), first
 * from the candidate B (in B's order), then from A (in A's order), each
 * de-duplicated. "Differs" = canonical form absent from the other side.
 */
export function differingWords(a: SimilarityDoc, b: SimilarityDoc): string[] {
  const setA = new Set(a.normTokens);
  const setB = new Set(b.normTokens);
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < b.normTokens.length; i++) {
    const t = b.normTokens[i]!;
    if (!setA.has(t) && !seen.has(t)) {
      seen.add(t);
      out.push(b.rawTokens[i]!);
    }
  }
  for (let i = 0; i < a.normTokens.length; i++) {
    const t = a.normTokens[i]!;
    if (!setB.has(t) && !seen.has(t)) {
      seen.add(t);
      out.push(a.rawTokens[i]!);
    }
  }
  return out;
}

/** Materialise one pair (A = anchor side, B = candidate side). */
export function buildPair(a: SimilarityDoc, b: SimilarityDoc, producedBy: string): SimilarAyahPair {
  const run = longestCommonRun(a.normTokens, b.normTokens);
  const phraseTokens = run.length > 0 ? b.rawTokens.slice(run.startB, run.startB + run.length) : [];
  return {
    verseKeyA: a.verseKey,
    verseKeyB: b.verseKey,
    textScore: pairTextScore(a, b),
    sharedPhrase: phraseTokens.length > 0 ? phraseTokens.join(' ') : null,
    differingWords: differingWords(a, b),
    producedBy,
  };
}

/* ------------------------------------------------------------------ */
/* Blocking index                                                      */
/* ------------------------------------------------------------------ */

/**
 * Build the similarity index over a corpus.
 *
 * Blocking strategy (each stage is O(small), total ≈ O(n · k · B)):
 * 1. DF table over canonical word sets (one pass, O(total words)).
 * 2. Each ayah contributes its up-to-RARE_WORDS_PER_AYAH rarest words
 *    (df ascending, then lexicographic — deterministic) with
 *    df ≤ max(RARE_DF_FLOOR, RARE_DF_FRACTION · n) into word buckets.
 *    Identical/very similar ayahs (e.g. the ar-Rahman refrain) share a rare
 *    word with each other, so they always land in a common bucket; stop-word
 *    like high-df words (الله, ما, من) are excluded — that is what keeps
 *    buckets small on the real corpus.
 * 3. Candidate pairs = within-bucket pairs passing the length-band prefilter,
 *    de-duplicated in canonical order. No similarity math happens here.
 *
 * Known recall risk (documented): two genuinely similar ayahs whose shared
 * vocabulary is entirely common-words (or entirely hapax and disjoint) never
 * become candidates. The brute-force agreement test covers this on small
 * corpora; docs/mutashabihat.md explains when it can diverge on big ones.
 */
export function buildSimilarityIndex(ayahs: Ayah[]): SimilarityIndex {
  const docs = ayahs.map(toSimilarityDoc).sort((x, y) => verseKeyOrder(x.verseKey, y.verseKey));
  const byVerseKey = new Map<VerseKey, SimilarityDoc>();
  for (const d of docs) byVerseKey.set(d.verseKey, d);

  const n = docs.length;
  const df = new Map<string, number>();
  for (const d of docs) {
    for (const w of d.uniqueNorm) df.set(w, (df.get(w) ?? 0) + 1);
  }
  const rareDfThreshold = Math.max(RARE_DF_FLOOR, Math.ceil(RARE_DF_FRACTION * n));

  const buckets = new Map<string, SimilarityDoc[]>();
  for (const d of docs) {
    const rare = d.uniqueNorm
      .filter((w) => (df.get(w) ?? 0) <= rareDfThreshold)
      .sort((x, y) => {
        const c = (df.get(x) ?? 0) - (df.get(y) ?? 0);
        return c !== 0 ? c : x < y ? -1 : x > y ? 1 : 0;
      })
      .slice(0, RARE_WORDS_PER_AYAH);
    for (const w of rare) {
      const list = buckets.get(w);
      if (list) list.push(d);
      else buckets.set(w, [d]);
    }
  }

  const adjacency = new Map<VerseKey, Set<VerseKey>>();
  const candidateKeySet = new Set<string>();
  const candidatePairs: CandidatePair[] = [];
  const addCandidate = (a: SimilarityDoc, b: SimilarityDoc): void => {
    if (a.verseKey === b.verseKey) return;
    if (!lengthBandPass(a, b)) return;
    const canon = pairKey(a.verseKey, b.verseKey);
    const key = `${canon.a}|${canon.b}`;
    if (candidateKeySet.has(key)) return;
    candidateKeySet.add(key);
    candidatePairs.push({ verseKeyA: canon.a, verseKeyB: canon.b });
    let adjA = adjacency.get(canon.a);
    if (!adjA) {
      adjA = new Set();
      adjacency.set(canon.a, adjA);
    }
    adjA.add(canon.b);
    let adjB = adjacency.get(canon.b);
    if (!adjB) {
      adjB = new Set();
      adjacency.set(canon.b, adjB);
    }
    adjB.add(canon.a);
  };
  for (const list of buckets.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) addCandidate(list[i]!, list[j]!);
    }
  }
  candidatePairs.sort(
    (x, y) =>
      verseKeyOrder(x.verseKeyA, y.verseKeyA) || verseKeyOrder(x.verseKeyB, y.verseKeyB),
  );

  return {
    algorithm: MUTASHABIHAT_ALGORITHM_ID,
    version: MUTASHABIHAT_ALGORITHM_VERSION,
    docs,
    byVerseKey,
    adjacency,
    candidatePairs,
    stats: {
      ayahCount: n,
      rareDfThreshold,
      bucketCount: buckets.size,
      candidatePairs: candidatePairs.length,
      bruteForcePairs: (n * (n - 1)) / 2,
    },
  };
}

/**
 * Reference brute force: computes `findSimilar` semantics against ALL other
 * ayahs (no blocking), with the identical score and guard rules. Only used by
 * tests on small corpora and as the documented correctness oracle — never in
 * app paths (it is the O(n²) we are blocking away from).
 */
export function bruteForceFindSimilar(
  anchorVerseKey: VerseKey,
  ayahs: Ayah[],
  opts: { minScore?: number; limit?: number } = {},
): SimilarAyahPair[] {
  const docs = ayahs.map(toSimilarityDoc).sort((x, y) => verseKeyOrder(x.verseKey, y.verseKey));
  const anchor = docs.find((d) => d.verseKey === anchorVerseKey);
  if (!anchor) return [];
  const isShort = anchor.wordCount <= SHORT_AYAH_MAX_WORDS;
  const minScore = opts.minScore ?? MIN_SCORE_DEFAULT;
  const effMin = isShort ? Math.max(minScore, MIN_SCORE_SHORT) : minScore;
  const ratio = isShort ? SHORT_AYAH_SHARED_RATIO : SHARED_RATIO_DEFAULT;

  const scored: { pair: SimilarAyahPair; score: number }[] = [];
  for (const b of docs) {
    if (b.verseKey === anchor.verseKey) continue;
    const score = pairTextScore(anchor, b);
    if (score < effMin) continue;
    const shared = sharedWordCount(anchor, b);
    const minWords = Math.min(anchor.wordCount, b.wordCount);
    if (shared < (minWords <= 1 ? 1 : MIN_SHARED_WORDS)) continue;
    if (minWords > 0 && shared < Math.ceil(ratio * minWords)) continue;
    scored.push({ pair: buildPair(anchor, b, MUTASHABIHAT_PRODUCED_BY), score });
  }
  scored.sort((x, y) => y.score - x.score || verseKeyOrder(x.pair.verseKeyB, y.pair.verseKeyB));
  const cap = isShort
    ? Math.min(opts.limit ?? SHORT_AYAH_RESULT_CAP, SHORT_AYAH_RESULT_CAP)
    : opts.limit ?? FIND_SIMILAR_DEFAULT_LIMIT;
  return scored.slice(0, cap).map((s) => s.pair);
}

/* ------------------------------------------------------------------ */
/* Query                                                               */
/* ------------------------------------------------------------------ */

function effectiveGuard(index: SimilarityIndex, verseKey: VerseKey, minScore: number) {
  const doc = index.byVerseKey.get(verseKey);
  const isShort = doc !== undefined && doc.wordCount <= SHORT_AYAH_MAX_WORDS;
  return {
    isShort,
    minScore: isShort ? Math.max(minScore, MIN_SCORE_SHORT) : minScore,
    sharedRatio: isShort ? SHORT_AYAH_SHARED_RATIO : SHARED_RATIO_DEFAULT,
  };
}

/**
 * Similar-ayah candidates for one verse, sorted by score descending with a
 * deterministic tie-break. Short ayahs (≤ SHORT_AYAH_MAX_WORDS words) are
 * structurally similar to everything, so for them the bar rises
 * (MIN_SCORE_SHORT), the shared-word ratio tightens
 * (SHORT_AYAH_SHARED_RATIO) and results are capped (SHORT_AYAH_RESULT_CAP)
 * — without the guard a two-word ayah "matches" dozens of verses.
 */
export function findSimilar(verseKey: VerseKey, opts: FindSimilarOptions & { index: SimilarityIndex }): SimilarAyahPair[] {
  const index = opts.index;
  const doc = index.byVerseKey.get(verseKey);
  if (!doc) return [];
  const guard = effectiveGuard(index, verseKey, opts.minScore ?? MIN_SCORE_DEFAULT);
  const neighbours = index.adjacency.get(verseKey);
  if (!neighbours) return [];

  const scored: { pair: SimilarAyahPair; score: number }[] = [];
  for (const other of neighbours) {
    const b = index.byVerseKey.get(other);
    if (!b) continue;
    const score = pairTextScore(doc, b);
    if (score < guard.minScore) continue;
    const shared = sharedWordCount(doc, b);
    const minWords = Math.min(doc.wordCount, b.wordCount);
    // Absolute floor: two+ unless the shorter ayah has a single word, in
    // which case sharing that word is the whole comparison.
    if (shared < (minWords <= 1 ? 1 : MIN_SHARED_WORDS)) continue;
    if (minWords > 0 && shared < Math.ceil(guard.sharedRatio * minWords)) continue;
    const pair = buildPair(doc, b, MUTASHABIHAT_PRODUCED_BY);
    scored.push({ pair, score });
  }
  scored.sort((x, y) => y.score - x.score || verseKeyOrder(x.pair.verseKeyB, y.pair.verseKeyB));
  // For short-ayah queries the cap is absolute; otherwise the caller's limit
  // (or the default) governs.
  const cap = guard.isShort
    ? Math.min(opts.limit ?? SHORT_AYAH_RESULT_CAP, SHORT_AYAH_RESULT_CAP)
    : opts.limit ?? FIND_SIMILAR_DEFAULT_LIMIT;
  return scored.slice(0, cap).map((s) => s.pair);
}

/* ------------------------------------------------------------------ */
/* Confusion clusters for the Hifz engine                              */
/* ------------------------------------------------------------------ */

/**
 * Greedy clique clustering: candidate pairs are ordered by score descending
 * (ties by canonical verse order) and merged only when the joining cluster
 * is *fully* similar — every cross pair scores ≥ GROUP_MIN_SCORE. Clusters
 * of ≥ GROUP_MIN_SIZE are emitted with their weakest intra-cluster score.
 * Deterministic; conservative by design (no chained transitive merges).
 */
export function buildConfusionCandidates(
  index: SimilarityIndex,
  minScore: number = GROUP_MIN_SCORE,
): ConfusionCandidate[] {
  const edges: { a: VerseKey; b: VerseKey; score: number }[] = [];
  for (const cp of index.candidatePairs) {
    const a = index.byVerseKey.get(cp.verseKeyA);
    const b = index.byVerseKey.get(cp.verseKeyB);
    if (!a || !b) continue;
    const score = pairTextScore(a, b);
    if (score < minScore) continue;
    const shared = sharedWordCount(a, b);
    const minWords = Math.min(a.wordCount, b.wordCount);
    if (shared < (minWords <= 1 ? 1 : MIN_SHARED_WORDS)) continue;
    edges.push({ a: cp.verseKeyA, b: cp.verseKeyB, score });
  }
  edges.sort(
    (x, y) => y.score - x.score || verseKeyOrder(x.a, y.a) || verseKeyOrder(x.b, y.b),
  );

  const scoreCache = new Map<string, number>();
  const scoreOf = (a: VerseKey, b: VerseKey): number => {
    if (a === b) return 1;
    const canon = pairKey(a, b);
    const key = `${canon.a}|${canon.b}`;
    const cached = scoreCache.get(key);
    if (cached !== undefined) return cached;
    const da = index.byVerseKey.get(canon.a);
    const db = index.byVerseKey.get(canon.b);
    const s = da && db ? pairTextScore(da, db) : 0;
    scoreCache.set(key, s);
    return s;
  };

  const clusterOf = new Map<VerseKey, number>();
  const clusters: VerseKey[][] = [];
  for (const e of edges) {
    const ca = clusterOf.get(e.a);
    const cb = clusterOf.get(e.b);
    if (ca === undefined && cb === undefined) {
      const id = clusters.length;
      clusters.push([e.a, e.b]);
      clusterOf.set(e.a, id);
      clusterOf.set(e.b, id);
    } else if (ca === undefined || cb === undefined) {
      const cid = ca ?? (cb as number);
      const existing = clusters[cid]!;
      const lone = ca === undefined ? e.a : e.b;
      if (existing.every((k) => scoreOf(lone, k) >= minScore)) {
        existing.push(lone);
        existing.sort(verseKeyOrder);
        clusterOf.set(lone, cid);
      }
    } else if (ca !== cb) {
      const xa = clusters[ca]!;
      const xb = clusters[cb]!;
      const ok = xa.every((k) => xb.every((l) => scoreOf(k, l) >= minScore));
      if (ok) {
        for (const k of xb) {
          xa.push(k);
          clusterOf.set(k, ca);
        }
        xa.sort(verseKeyOrder);
        clusters[cb] = [];
      }
    }
  }

  const out: ConfusionCandidate[] = [];
  for (const members of clusters) {
    const uniq = [...new Set(members.filter((m) => m !== undefined))];
    if (uniq.length < GROUP_MIN_SIZE) continue;
    // Verify full mutual similarity before emitting.
    let mutual = true;
    let minPair = 1;
    for (let i = 0; i < uniq.length && mutual; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        const s = scoreOf(uniq[i]!, uniq[j]!);
        if (s < minScore) {
          mutual = false;
          break;
        }
        minPair = Math.min(minPair, s);
      }
    }
    if (!mutual) continue;
    out.push({
      id: `mc-${uniq.join(',')}`,
      verseKeys: uniq,
      minPairScore: minPair,
      producedBy: MUTASHABIHAT_PRODUCED_BY,
    });
  }
  out.sort(
    (x, y) =>
      y.verseKeys.length - x.verseKeys.length ||
      verseKeyOrder(x.verseKeys[0] ?? '0:0', y.verseKeys[0] ?? '0:0'),
  );
  return out;
}

/* ------------------------------------------------------------------ */
/* Relation projection + provenance                                    */
/* ------------------------------------------------------------------ */

/**
 * Project a computed pair into an `AyahRelation` for the graph/UI layer.
 * The type is `textual` for near-verbatim matches (high score or a shared
 * phrase of ≥ GROUP_PHRASE_TOKENS words) and `linguistic` for pure
 * vocabulary overlap. It is NEVER `explicit` — that type is reserved for
 * statements made verbatim by a licensed content pack. The reason string
 * names both similarity components so no number is unexplained.
 */
export function pairToAyahRelation(pair: SimilarAyahPair): AyahRelation {
  const phraseTokens = pair.sharedPhrase === null ? 0 : tokenizeWords(pair.sharedPhrase).length;
  const type =
    pair.textScore >= TEXTUAL_SCORE_FLOOR || phraseTokens >= GROUP_PHRASE_TOKENS
      ? 'textual'
      : 'linguistic';
  return {
    fromVerseKey: pair.verseKeyA,
    toVerseKey: pair.verseKeyB,
    type,
    reason: `computed text similarity ${pair.textScore.toFixed(4)}; shared phrase: ${
      pair.sharedPhrase === null ? 'none' : `"${pair.sharedPhrase}"`
    }; candidate only — not a scholarly or religious claim`,
    score: pair.textScore,
    producedBy: pair.producedBy,
  };
}
