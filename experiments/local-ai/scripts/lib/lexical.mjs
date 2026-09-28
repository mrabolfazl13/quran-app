/**
 * The mandatory lexical baselines for task A.
 *
 * Three families, all deterministic:
 *
 *  1. `Bm25` — Okapi BM25 over normalised token streams. Not in `core` (the
 *     shipped scorer is phrase/coverage based), so it is implemented here as
 *     the strongest *classic* lexical competitor an implementer would reach
 *     for before buying embeddings. Parameters are named constants.
 *  2. `productionSearch` — a thin wrapper around
 *     `core/src/search/index.ts` (`buildSearchIndex` + `search`) so the
 *     comparison is against the code that actually ships, with its real
 *     weights and its real normalisation.
 *  3. `similarityRank` — `tokenSimilarity`/`setSimilarity` from
 *     `core/src/normalize/arabic`, ranking every ayah against the query text.
 *     Included because the brief names them as the comparison, and because
 *     they are what the mutashabihat engine uses for "similar ayah", not
 *     because a query engine should use them (they are O(corpus x query) with
 *     no index — the cost is measured and reported too).
 *
 * Normalisation is never re-implemented: Arabic and Persian streams go through
 * `normalizeWord`/`tokenizeWords`, English through `latinTokensLower`, exactly
 * as the shipped search index does.
 */
import {
  normalizeWord,
  searchKey,
  setSimilarity,
  tokenSimilarity,
  tokenizeWords,
} from '../../../../core/src/normalize/arabic.ts';
import { latinTokensLower, search } from '../../../../core/src/search/index.ts';

/* ------------------------------------------------------------------ *
 * Token streams (identical rules to the shipped index)
 * ------------------------------------------------------------------ */

/** Arabic / Persian script stream: `tokenizeWords` then `normalizeWord`. */
export function scriptTokens(text) {
  return tokenizeWords(text ?? '').map(normalizeWord).filter((t) => t.length > 0);
}

/** Latin stream: the shipped `latinTokensLower` (lowercase, punctuation split). */
export function latinStream(text) {
  return latinTokensLower(text ?? '');
}

/** Choose the stream by language, the same way `buildSearchIndex` does. */
export function tokensFor(lang, text) {
  return lang === 'en' ? latinStream(text) : scriptTokens(text);
}

/* ------------------------------------------------------------------ *
 * BM25
 * ------------------------------------------------------------------ */

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

export class Bm25 {
  /**
   * @param {{id:string, tokens:string[]}[]} docs
   */
  constructor(docs, { k1 = BM25_K1, b = BM25_B } = {}) {
    this.k1 = k1;
    this.b = b;
    this.docIds = docs.map((d) => d.id);
    this.docLen = docs.map((d) => d.tokens.length);
    this.avgLen = this.docLen.reduce((a, x) => a + x, 0) / Math.max(1, this.docLen.length);
    /** posting list: token -> [{df: index, tf}] */
    this.postings = new Map();
    docs.forEach((d, di) => {
      const tf = new Map();
      for (const t of d.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const [t, f] of tf) {
        let list = this.postings.get(t);
        if (!list) this.postings.set(t, (list = []));
        list.push({ di, tf: f });
      }
    });
    this.N = docs.length;
  }

  idf(token) {
    const df = this.postings.get(token)?.length ?? 0;
    if (df === 0) return 0;
    return Math.log(1 + (this.N - df + 0.5) / (df + 0.5));
  }

  /** @returns {{id:string, score:number, tokens:number}[]} best first */
  rank(queryTokens, limit = 50) {
    const q = Array.from(new Set(queryTokens));
    const acc = new Map();
    for (const t of q) {
      const idf = this.idf(t);
      if (idf === 0) continue;
      for (const { di, tf } of this.postings.get(t) ?? []) {
        const len = this.docLen[di];
        const denom = tf + this.k1 * (1 - this.b + (this.b * len) / this.avgLen);
        acc.set(di, (acc.get(di) ?? 0) + idf * ((tf * (this.k1 + 1)) / denom));
      }
    }
    const out = [...acc.entries()]
      .map(([di, score]) => ({ id: this.docIds[di], score, tokens: this.docLen[di] }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return out.slice(0, limit);
  }
}

/* ------------------------------------------------------------------ *
 * Production search wrapper
 * ------------------------------------------------------------------ */

/**
 * Ranked verse keys from the shipped search engine.
 *
 * Arabic queries are matched as a *phrase* (`requireContiguous` in core) or as
 * a single word, Persian/English as a translation query — exactly the query
 * kinds a UI would issue for this input.
 */
export function productionSearch(index, lang, queryText, limit = 50) {
  const q =
    lang === 'ar'
      ? { type: 'arabic-phrase', text: queryText, match: 'prefix', limit }
      : { type: 'translation', language: lang, text: queryText, limit };
  const res = search(index, q);
  const seen = new Set();
  const ids = [];
  for (const h of res.hits) {
    if (!h.verseKey || seen.has(h.verseKey)) continue;
    seen.add(h.verseKey);
    ids.push(h.verseKey);
  }
  return { ids, rejected: res.rejected, notes: res.notes, raw: res.hits.length };
}

/* ------------------------------------------------------------------ *
 * Similarity primitives (no index, brute force)
 * ------------------------------------------------------------------ */

/**
 * Rank ayahs by similarity of their token stream to the query token stream.
 * `mode` picks the primitive: `token` = order-sensitive 1 - edit/len,
 * `set` = Jaccard over word sets, `both` = mean of the two.
 */
export function similarityRank(ayahs, queryTokens, mode = 'both', limit = 50) {
  const scored = ayahs.map((a) => {
    const t = tokenSimilarity(queryTokens, a.normTokens);
    const s = setSimilarity(queryTokens, a.normTokens);
    return { id: a.verseKey, score: mode === 'token' ? t : mode === 'set' ? s : (t + s) / 2 };
  });
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.slice(0, limit);
}

/** Normalised query key helper (kept so scripts share one definition). */
export function queryKey(text) {
  return searchKey(text);
}

export { normalizeWord };
