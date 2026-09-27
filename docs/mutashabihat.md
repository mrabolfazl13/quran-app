# Mutashabihat (similar-ayah) engine

Code: `core/src/mutashabihat/index.ts` · Tests: `core/tests/mutashabihat/`
Owner: Search agent. Deterministic, framework-free, offline. Every content
byte is an argument; the unit tests run on hand-written fixtures and on a
fully deterministic synthetic corpus of the real size (6 236 ayahs).

## What this is — and what it is not

This computes **text similarity between ayahs**: shared normalised words,
shared longest phrases, and the words that differ. It exists so a memoriser
can be warned "these two endings differ only in `حَشْوٍ` vs `رَفْرَفٍ`".

It is **not a religious claim.** The statement "these verses are *mutashābih*
in the scholarly sense" belongs to tafsir, not to this code. The provenance
rule in contracts (`core/src/contracts/quran.ts` `RelationType`): **only
`explicit` relations are textual authority, and only when a licensed content
pack states them verbatim.** Every relation this module emits is computed —
`pairToAyahRelation()` types a pair `textual` (near-verbatim wording match:
score ≥ `TEXTUAL_SCORE_FLOOR=0.75` or a shared phrase of ≥
`GROUP_PHRASE_TOKENS=2` words) or `linguistic` (vocabulary overlap only).
This module can and does **never** produce `explicit`. The reason string on
every relation spells out the score and the phrase and ends with "candidate
only — not a scholarly or religious claim". Every pair carries
`producedBy = "algorithm:mutashabihat-blocking@v1"`
(`MUTASHABIHAT_ALGORITHM_ID` + `MUTASHABIHAT_ALGORITHM_VERSION`).

## Similarity definition

Tokens: `tokenizeWords(textUthmani)` → `normalizeWord` — imported from
`core/src/normalize/arabic.ts`, the single definition of "the same word";
nothing here re-implements it. Scores are from the same library:

```
textScore = max( setSimilarity(a, b),      // Jaccard over normalised word sets
                 tokenSimilarity(a, b) )   // 1 − word-level Levenshtein / longer length
```

`max` (not mean) is deliberate: for a memoriser, a re-ordered but identical
vocabulary is just as confusing as an identical set.

## buildSimilarityIndex — blocking strategy

Naive all-pairs over 6 236 ayahs is 6 236·6 235/2 = **19 440 730** similarity
computations. Blocking reduces this to a candidate set:

1. **Document-frequency table** over each ayah's unique normalised words —
   one pass, O(total tokens) ≈ 60k.
2. **Shared rare-word buckets.** A word is a blocking key only when
   `df ≤ max(RARE_DF_FLOOR=24, ceil(RARE_DF_FRACTION=0.02 · n))`. High-df
   stop-word-like tokens (`الله`, `ما`, `من`) would create thousand-member
   buckets and rebuild O(n²); they are excluded. Each ayah contributes its
   `RARE_WORDS_PER_AYAH=6` rarest words (df ascending, lexicographic
   tie-break — deterministic even for equal df). Identical or near-identical
   ayahs share *many* rare words (ar-Rahman's refrain shares all four), so
   they reliably collide into the same bucket.
3. **Length-band prefilter.** A pair is dropped before any string math when
   word counts differ by more than
   `max(LENGTH_BAND_ABS=6, ceil(LENGTH_BAND_FRACTION=0.5 · minLen))` — a
   3-word ayah and a 19-word ayah are never "the same verse" regardless of
   vocabulary.
4. Within-bucket pairs are de-duplicated in canonical verse order
   (`verseKeyOrder`, chapter:verse numerically) and stored as an adjacency
   map. No similarity is computed at build time.

### Measured numbers (synthetic 6 236-ayah corpus, dev machine, Node 24)

The test `blocking cuts the comparison space by >10x…` prints real values
each run. Last measured on this machine (times are hardware-dependent;
counts are exact and deterministic):

| metric | value |
| --- | --- |
| ayahs | 6 236 |
| rare-df threshold | 125 (= 2% of corpus) |
| buckets | 255 |
| **candidate pairs after blocking** | **176 305** |
| brute-force pairs | 19 440 730 |
| ratio | **0.91 % of O(n²)** — a 110× reduction |
| index build | ≈ 0.8 s |
| `findSimilar` query | < 1 ms |

## findSimilar(verseKey, {index, minScore?, limit?})

Iterates the anchor's adjacency, computes `textScore`, applies guards, sorts
by score desc with canonical `verseKeyB` tie-break, and materialises
`SimilarAyahPair { verseKeyA = anchor, verseKeyB, textScore, sharedPhrase,
differingWords, producedBy }`:

- `sharedPhrase` — the **longest contiguous run of equal normalised tokens**
  (DP longest-common-substring), sliced from the candidate's raw surface
  tokens so the UI can locate it in the actual written ayah.
- `differingWords` — surface tokens present on one side but absent (under
  normalisation) from the other: candidate-side first in candidate order,
  then anchor-side. This is the payload the UI highlights; it is exactly what
  stops a memoriser conflating `مُتَّكِئِينَ عَلَى حَشْوٍ…` with
  `…عَلَى رَفْرَفٍ…` (`['رَفْرَفٍ', 'حَشْوٍ']`).

### Minimum-length guard (short-ayah flooding)

A 1–3 word ayah is structurally similar to almost everything it shares even
one word with — `وَالْعَصْرِ`-style openings match dozens of verses. The rule
(`SHORT_AYAH_MAX_WORDS=3`): when the **query ayah** has ≤ 3 words,

- score bar rises: `MIN_SCORE_SHORT=0.85` instead of `MIN_SCORE_DEFAULT=0.5`;
- shared-word ratio tightens: shared ≥ `SHORT_AYAH_SHARED_RATIO=0.8 · minLen`
  (normal ayahs need ≥ `SHARED_RATIO_DEFAULT=0.3 · minLen`);
- results are hard-capped at `SHORT_AYAH_RESULT_CAP=5` no matter the caller's
  `limit` (tested: 8 identical synthetic one-word ayahs → exactly 5 results).

All pairs additionally need `MIN_SHARED_WORDS=2` shared words, except when
the shorter ayah has a single word — then sharing that word *is* the whole
comparison.

## buildConfusionCandidates — grouping for the Hifz engine

Emits `ConfusionCandidate { id, verseKeys, minPairScore, producedBy }` —
clusters of ≥ `GROUP_MIN_SIZE=2` **mutually** similar ayahs, consumed by the
Hifz `confusion.ts` as engine-proposed groups (the Hifz agent owns
`ConfusionGroup` creation, timestamps and user-vs-engine origin).

Greedy clique construction, fully deterministic: candidate edges above
`GROUP_MIN_SCORE=0.6` are ordered by score desc, ties by canonical verse
order; a lone joins a cluster only if similar to **every** member, and two
clusters merge only if **all cross pairs** pass — no transitive chaining
(A–B, B–C never fabricates an A–C group). Each emitted cluster is re-
verified pairwise before return and reports its weakest intra-cluster score.
The 0.5 salam pair (37:130/131) is deliberately *not* grouped — below the
clique bar — while identical refrains and the 0.833 حشو/رفرف pair are.

## Measured similarity on the real-text fixtures

Printed by the `fixture-corpus similarity numbers` test:

| pair | textScore | shared phrase |
| --- | --- | --- |
| 55:13 → 55:77 (refrain) | **1.0000** | فَبِأَيِّ آلَاءِ رَبِّكُمَا تُكَذِّبَانِ |
| 55:67 → 55:78 (tabārak…; differing *haraka* only) | **1.0000** | full ayah |
| 55:54 → 55:76 (ḥashw / rafraf) | **0.8333** | خُضْرٍ وَعَبْقَرِيٍّ حِسَانٍ |
| 37:120 → 37:159 (subḥān Allāh…) | **1.0000** | full ayah |
| 37:120 → 37:180 (…mā yaṣifūn ending) | **0.5000** | عَمَّا يَصِفُونَ |
| 37:130 → 37:131 (salam pair in as-Saffat) | **0.5000** | سَلامٌ عَلَى |
| 2:5 → 8:4 ("أولئك هم المؤمنون" endings) | 0.2273* | — (below the 0.5 bar: whole-ayah similarity, not clause similarity — see limits) |

\* reported by `pairTextScore` directly; not surfaced by `findSimilar`.

## Blocking correctness vs brute force

The tests run `bruteForceFindSimilar` (same scoring, same guards, no
blocking) as an oracle for **every anchor** of the 29-ayah fixture corpus and
assert **exact agreement** — identical ordered list of `verseKeyB@score` per
anchor, not a threshold.

Divergence risk on big corpora, stated honestly: a true pair is missed by
blocking when (a) their shared vocabulary is entirely *common* words (df >
threshold), (b) their shared rare words fall outside the
`RARE_WORDS_PER_AYAH=6` rarest slice of both sides, or (c) the length-band
drops them first — which can only drop pairs whose Jaccard is already below
~`minLen/maxLen`, i.e. mostly low-score noise. (a)+(b) are rare for genuine
mutashabihat, which by definition share distinctive long phrases; the
synthetic 6 236-ayah test proves the injected exact duplicates all survive
blocking (score 1.0 found). The remedy if a future audit finds misses: raise
`RARE_DF_FRACTION`/`RARE_WORDS_PER_AYAH` — pure constants, measured by the
same agreement harness — **not** embeddings.

## What this cannot do

- **No semantic similarity.** Two ayahs saying the same thing in different
  words score 0. That is the concept layer's job, not this engine's.
- **Whole-ayah scores only.** A shared *clause* inside long ayahs (2:5 vs
  8:4) scores low because the surrounding words differ; a clause-level index
  (shared-phrase n-gram blocking) is the honest upgrade, and it needs a
  labelled eval set first.
- Arabic/Persian script only; Latin transliteration input is not accepted.
- No phonetic similarity (spelling-distinct homophones like `علي/يلِي` in
  recitation are out of scope; that is tajwīd data, not text diffing).
- Results are *candidates*: ordering by `textScore` is not a ranking of
  scholarly significance, and `producedBy` must be shown next to any UI
  presentation of a pair.
- A future local model must beat these numbers on size/RAM/latency/utility —
  exactly as for search — before any computed relation may leave the
  `textual`/`linguistic` typing this module is confined to.
