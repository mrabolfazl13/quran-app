# Hifz Engine — Memory Fingerprint Method

Implements master-prompt §8–§11. Code: `core/src/hifz/**`. Tests:
`core/tests/hifz/**` (175 passing across 6 files — measured with
`cd core && npx vitest run tests/hifz`). Contracts:
`core/src/contracts/hifz.ts`.

Related docs: [memory-fingerprint.md](memory-fingerprint.md) (segmentation,
anchors, transitions, probes), [review-algorithm.md](review-algorithm.md)
(stability, priority, cost model).

## Status of these numbers

Every threshold, weight and cost in this engine is an **engineering heuristic**
chosen to be bounded, monotone and explainable. **Nothing here is validated by
memory research**, and no claim of scientific effectiveness is made anywhere in
the engine, its docs, or the UI. All tunables live in
[`core/src/hifz/params.ts`](../core/src/hifz/params.ts); no module hard-codes a
threshold inline.

## Determinism contract

The engine is pure. Consequences that the rest of the product relies on:

- **No clock reads.** `now` / `nowIso` is always a parameter. Same inputs →
  byte-identical outputs (`review.test.ts` schedules the same context twice and
  compares the JSON).
- **No `Math.random()`.** Seeded choice uses `seededRandom(seed)` (mulberry32)
  in `recall.ts`; `seedToInt` accepts a number or a string seed.
- **All scores rounded** to `SCORE_DECIMALS = 4` before being returned, so
  serialisation is stable across ports.
- **Tie-breaks are fixed** (alignment state preference, sort orders keyed by
  `verseKey`/`itemId`). This is what lets a Dart port reproduce the numbers.

## Layers

| Module | Responsibility |
|---|---|
| `params.ts` | every tunable, documented |
| `segment.ts` | memory fingerprint: segments, anchors, transitions |
| `recall.ts` | 15 recall probe modes → cue + expected text |
| `classify.ts` | aligner + error classification |
| `stability.ts` | strength, retention decay, band, interval |
| `review.ts` | 9-factor priority, mode suggestion, daily plan, cost model |
| `confusion.ts` | confusion groups (user-declared and engine-proposed) |
| `session.ts` | session step builder, session report, stability advance |

## Error classification (`classify.ts`)

### Alignment

Recitation is scored by **Needleman–Wunsch with affine gaps** (Gotoh) over
*normalised* word tokens (`normalizeWord`), so diacritics, hamza carriers and
ta marbuta never count as errors:

| Cost | Value |
|---|---|
| match | 0 |
| substitution (same-length wrong word) | `ALIGN_MISMATCH_COST` = 2 |
| opening a gap | `ALIGN_GAP_OPEN_COST` = 3 |
| extending an open gap | `ALIGN_GAP_EXTEND_COST` = 1 |

Opening a run of 3 omissions therefore costs 5, not 3 — which is why a single
dropped clause reads as one mistake instead of three. Gap seams are snapped so
an insertion/deletion pair is never reported as a substitution plus a phantom
reorder. Correctness is **exact normalised equality only**; a word ≥
`NEAR_MISS_SIMILARITY` (0.7) similar to the expected word is still a
substitution, and the near miss appears only in the explanation text.

### Error kinds

`omission`, `substitution`, `repetition`, `wrong-order`, `wrong-transition`,
`similar-ayah-confusion`, `beginning-failure`, `middle-failure`,
`ending-failure`, plus `correct`. Attribution rules:

- A produced run is charged to **another ayah** (`wrong-transition`) only when
  it is ≥ `CONTINUATION_MIN_WORDS` (2) long *and* reaches
  `WRONG_TRANSITION_SIMILARITY` (0.6) token similarity against that ayah's
  opening.
- `similar-ayah-confusion` needs `CONFUSION_SIMILARITY` (0.55) set similarity
  against a supplied `confusionCandidates` ayah — the caller (desktop/mobile)
  passes mutashabihat neighbours from `core/src/mutashabihat`.
- Positional failures (`beginning`/`middle`/`ending`) are only emitted for the
  modes that actually covered the whole ayah
  (`POSITIONAL_FAILURE_MODES`: `full-ayah`, `full-sequence`, `continue-ayah`,
  `reverse`, `audio-recall`), so a partial probe can never fake a
  "middle failure".
- Segment attribution: each error carries `segmentPosition` from the fingerprint
  spans, which is what makes "weak segments" real rather than guessed.

`accuracy = correctWordCount / expectedWordCount` over normalised tokens.
`isExactRecitation` is the only notion of "perfect".

## Session (`session.ts`)

Phases run in fixed order (`SESSION_PHASES`): warm-up → new learning →
progressive recall → transition training → similar-ayah drill → reverse →
random → assessment. Each phase draws from the plan rather than from a
template:

1. warm-up — the `WARM_UP_ITEM_COUNT` (2) most recently practised planned
   items, cued by first word.
2. new learning — today's new ayahs, segment by segment.
3. progressive recall — highest-priority reviews, `continue-ayah`.
4. transition training — the `PHASE_STEP_CAP` (4) least-stable boundaries.
5. similar-ayah drill — confusion-group members back to back (`cap × 2` steps).
6. reverse — the `PROBE_DRILL_ITEM_CAP` (3) least-stable planned items.
7. random — seeded span over the plan's first `cap` verse keys.
8. assessment — `full-sequence` when the item spans ayahs, else `audio-recall`.

Steps are deduplicated per `(mode, verseKey)`. `stabilityAfterSession` advances
per-segment/per-transition stability with an EWMA of rate `LEARN_RATE` (0.35),
so one attempt never hard-sets a memory's stability.

## Session report

`computeSessionReport` returns overall recall, weak segments, weak transitions,
confused ayah pairs, repeated mistakes (a kind occurring ≥
`REPEATED_ERROR_MIN_COUNT` = 2 times in the session), recommended next review,
and per-item stability change. Every figure is computed from the attempts that
were actually recorded in the session — there is no synthetic number anywhere
in the report path (master-prompt §31: the numbers must be real).

## UI-facing guarantees

- Errors are reported at word positions, so the reader can highlight exactly
  which word was missed.
- Nothing in this engine calls an LLM. Text comparison is deterministic
  (§9 of the master prompt).
- The engine never rewrites Quran text: it reads expected text, it never
  repairs produced text.
