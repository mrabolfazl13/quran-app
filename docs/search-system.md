# Search system

Code: `core/src/search/index.ts` · Tests: `core/tests/search/`
Owner: Search agent. Deterministic, framework-free, offline. No clock, no
randomness, no network: every byte of content is an argument to
`buildSearchIndex`, so the whole system runs on fixture arrays in unit tests.

## Design in one paragraph

`buildSearchIndex(ayahs, translations[], words[], {concepts, conceptLinks,
notes, bookmarks})` produces a plain-object index (serialisable to JSON — the
desktop DB layer may stage it into SQLite FTS5, but all matching logic lives
here so desktop and mobile get identical results). `search(index, query)` runs
one documented query kind against the index and returns ranked hits with
pre-computed highlight ranges. Arabic-script normalisation is *never*
re-implemented: tokens are produced with `tokenizeWords` + `normalizeWord`
from `core/src/normalize/arabic.ts` — the single place where "the same word"
is defined — so search, the Hifz engine and the integrity checker always agree.

## Query types (`SearchQuery['type']`)

| type | semantics | matched field(s) |
| --- | --- | --- |
| `arabic-phrase` + `match:'exact'` | query's normalised tokens appear as a **contiguous run** of ayah tokens | `textUthmani` |
| `arabic-phrase` + `match:'prefix'` | contiguous run where every query token may be a **prefix** of the ayah token (diacritic-insensitive stem-ish: `العالم` → `العالمين`) | `textUthmani` |
| `arabic-word` | exactly one normalised token, matched at any position in every ayah containing it | `textUthmani` |
| `root` | normalised equality against `AyahWord.root` (`ر ح م` and `رحم` normalise identically). **If the data provides no roots the response is empty with reason `roots-unavailable` — the engine never guesses a root.** | word-level root column |
| `translation` (`language:'fa'\|'en'`) | query tokens matched against translations of that language; `fa` goes through the Arabic normalisation path (folds `ک`→`ك`, `ى`→`ي`, hamza carriers, harakat), `en` through the latin path | translation text |
| `concept` | matched over `Concept` labels (`labelArabic/Fa/En`) and `descriptionFa` of an attached concept pack; hits carry the linked verse keys (`ConceptAyahLink`) | concept pack |
| `user-text` | notes (`Note.body`) and bookmark labels; per-token dual keys (arabic + latin) so mixed Arabic/Persian/English notes match either | user data |

### Latin path caveat

`normalizeWord` intentionally **discards** non-Arabic characters, so it cannot
index English. The Latin script path (`latinKey`, lowercase + punctuation
folding) is defined in the search module **only for non-Arabic text**. Quran
text is never run through a Latin normaliser, and the Arabic rules are not
duplicated: the Arabic path always defers to `normalize/arabic`.

## Matching & scoring

`bestRun(docTokens, queryTokens, {prefix, requireContiguous})` tries, in
order:

1. a contiguous run under strict normalised equality;
2. (prefix kinds) a contiguous run under prefix equality;
3. (translation/concept/user kinds only) an order-preserving greedy
   subsequence; a scattered match is reported only when it covers at least
   `MIN_SCATTER_COVERAGE` of the query tokens, otherwise rejected as noise.

Score is a documented sum — every component is exported as a named constant:

```
score = WEIGHT_TOKEN_MATCH · matchedQueryTokens        (each token found: 1)
      + WEIGHT_COVERAGE    · coverage                   (fraction of query tokens found: ×4)
      + WEIGHT_CONTIGUOUS_PHRASE                        (query found as one contiguous run: +2)
      + WEIGHT_POSITION    · 1 / (1 + firstTokenIndex)  (earlier match ranks higher, bounded)
      + field weight                                   (arabic 3 · translation 2 ·
                                                        concept label 2 / description 1 ·
                                                        user text 1)
```

Constants: `WEIGHT_TOKEN_MATCH=1`, `WEIGHT_COVERAGE=4`,
`WEIGHT_CONTIGUOUS_PHRASE=2`, `WEIGHT_POSITION=1`,
`WEIGHT_FIELD_ARABIC=3`, `WEIGHT_FIELD_TRANSLATION=2`,
`WEIGHT_FIELD_CONCEPT_LABEL=2`, `WEIGHT_FIELD_CONCEPT_DESCRIPTION=1`,
`WEIGHT_FIELD_USER=1`, `MIN_SCATTER_COVERAGE=0.5`.

**Ranking stability.** Ordering is `score desc`, then canonical `chapter:verse`
ascending, then field name, then concept/note id. No comparator can hit a
hidden tie on the same corpus, so repeated queries over the same index return
byte-identical JSON (tested). An Arabic word search for the identical refrain
shows the tie path: `55:13` before `55:77` at equal scores.

## Highlighting and RTL

Every hit returns `rawText` plus half-open **UTF-16 code-unit ranges in
logical string order**. JS strings are stored in logical (input) order even
for RTL scripts; visual right-to-left rendering is a presentation concern.
Ranges are therefore *never* reversed or mirrored — the UI does
`rawText.slice(r.start, r.end)` and the exact substring falls out. The tests
assert slice-identity, not just numbers: a query typed without harakat
highlights the vocalised `الرَّحْمَنِ` in full; `فَبِأَيِّ` (hamza + shadda)
round-trips verbatim; the `إِبْرَاهِيمَ` highlight survives alef folding.
Mechanics: raw tokens keep their original offsets; the normalised→raw
relationship is probed by calling `normalizeWord` **per character** (valid
because every rule in `normalize/arabic.ts` rewrites or deletes a single code
unit, none spans two), so offsets come from the same function that defines
sameness, and Arabic-script tokens are never punctuation-trimmed.

## Guards (never throw, always a reason)

`search` cannot crash: no user input is ever compiled into a `RegExp` —
queries are matched token-by-token against literal normalised keys, so
`.*+?^${}()|[]\` is inert by construction.

| input | behaviour | reason code |
| --- | --- | --- |
| empty / whitespace | 0 hits | `empty-query` |
| only diacritics (`َ ُ ِ` `ّ` `ٰ`) | 0 hits | `empty-after-normalization` |
| > `MAX_QUERY_CHARS` (512) chars | 0 hits, rejected **before** scanning | `query-too-long` |
| > `MAX_QUERY_TOKENS` (32) tokens | 0 hits | `query-too-many-tokens` |
| `arabic-word` with several tokens | 0 hits | `query-too-many-tokens` |
| `root` query, no root data in pack | 0 hits, never guesses | `roots-unavailable` |
| `concept` query, no pack | 0 hits | `no-concept-pack` |
| `user-text` query, no notes/bookmarks | 0 hits | `no-user-data` |

Result limits: `DEFAULT_RESULT_LIMIT=200`, `MAX_RESULT_LIMIT=2000`.

## Complexity

- Build: O(total tokens) — one pass per ayah/translation; root buckets are a
  single pass over word rows.
- Query: O(ayahs × tokens-per-ayah) worst case per scan (6 236 ayahs × ~10
  words ≈ 60k token comparisons — well under a millisecond-scale sweep in
  memory). The shape is exactly what SQLite FTS5 can replace for the scan
  stage; the ranking/highlight logic stays in core either way.

## What this search cannot do

- **No semantic / embedding search.** `رحمة` and `mercy` do not match unless
  a concept pack links them. A local model may only be considered after it
  beats this index on model size (MB), RAM at rest, query latency (p50/p95 on
  the desktop target machine) and measured utility on a labelled query set —
  deterministic scoring stays as the fallback and the audit trail either way.
- **No morphological stemming.** "Prefix/stem-ish" is literal prefix over the
  normalised surface; `يرحمان` will not fold to root `ر ح م` — the `root`
  query kind is the root-aware path, and only when packs ship roots.
- **One contiguous window per hit.** Repeated occurrences outside the best
  window are not all highlighted.
- No transliteration search, no typo tolerance (edit distance is the Hifz
  classifier's tool, deliberately not applied to queries), no fuzzy matching —
  by design: deterministic and explainable beats clever and irreproducible.
- Search quality is exactly content-pack quality: a pack whose `textUthmani`
  is wrong will return the wrong verbatim text. The integrity pipeline, not
  search, owns that risk.
