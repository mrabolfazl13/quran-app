/**
 * Ranking metrics used for task A. Pure functions, no dependencies, so the
 * numbers in `docs/local-ai.md` can be recomputed from the saved run files.
 *
 * Definitions (stated because recall@5 without a definition is decoration):
 *  - gold: the labelled relevant set for a query (binary; may be empty for a
 *    query where nothing in the corpus is relevant — such queries are kept and
 *    scored for precision only, never dropped).
 *  - recall@k  = |gold ∩ top-k| / |gold|
 *  - precision@k = |gold ∩ top-k| / k
 *  - MRR       = 1 / (rank of the first relevant hit), 0 when none in the list
 *  - nDCG@k    = binary-gain DCG with ideal ordering, gains 1 per relevant hit
 *  - unjudged@k = hits in top-k outside gold ∩ reviewed pool. A system that
 *    fills the page with unreviewed text is NOT credited for it; a system that
 *    fills it with unjudged-but-plausible text is visible here and gets
 *    reviewed by hand before any conclusion is drawn.
 */

export function recallAtK(ranked, gold, k) {
  if (gold.length === 0) return null;
  const set = new Set(gold);
  let hit = 0;
  for (const id of ranked.slice(0, k)) if (set.has(id)) hit++;
  return hit / gold.length;
}

export function precisionAtK(ranked, gold, k) {
  const set = new Set(gold);
  let hit = 0;
  for (const id of ranked.slice(0, k)) if (set.has(id)) hit++;
  return hit / k;
}

export function reciprocalRank(ranked, gold) {
  const set = new Set(gold);
  for (let i = 0; i < ranked.length; i++) if (set.has(ranked[i])) return 1 / (i + 1);
  return 0;
}

export function ndcgAtK(ranked, gold, k) {
  const set = new Set(gold);
  let dcg = 0;
  for (let i = 0; i < Math.min(k, ranked.length); i++) {
    if (set.has(ranked[i])) dcg += 1 / Math.log2(i + 2);
  }
  const ideal = Math.min(gold.length, k);
  let idcg = 0;
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? null : dcg / idcg;
}

export function unjudgedCount(ranked, judged, k) {
  const j = new Set(judged);
  let n = 0;
  for (const id of ranked.slice(0, k)) if (!j.has(id)) n++;
  return n;
}

export function mean(values) {
  const v = values.filter((x) => x !== null && x !== undefined && Number.isFinite(x));
  return v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length;
}

export function median(values) {
  const v = values.slice().sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Percentile with linear interpolation (same convention as numpy default). */
export function percentile(values, p) {
  const v = values.slice().sort((a, b) => a - b);
  if (v.length === 0) return null;
  if (v.length === 1) return v[0];
  const idx = (p / 100) * (v.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return v[lo] + (v[hi] - v[lo]) * (idx - lo);
}

export function fmt(x, digits = 4) {
  return x === null || x === undefined ? 'n/a' : Number(x).toFixed(digits);
}
