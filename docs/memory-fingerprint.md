# Memory Fingerprint

The unit of the Hifz engine is not "an ayah you have memorised" but a
**structured profile of how that ayah is stored in memory** (master-prompt §8):

```text
Ayah
├── Semantic segments          (HifzSegment[])
├── Anchor words               (AnchorWord[], roles below)
├── Opening / middle / ending recall
├── Transitions  A→B, B→C, …   (HifzTransition[], intra + inter)
├── Similar ayahs              (core/src/mutashabihat)
├── Error history              (RecallAttempt[])
└── Memory stability           (stability.ts → 0..1 + band)
```

Code: [`core/src/hifz/segment.ts`](../core/src/hifz/segment.ts),
[`core/src/hifz/recall.ts`](../core/src/hifz/recall.ts).

## The row address is per-ayah, not per-item

A fingerprint's unit is the **ayah**, and an item is allowed to span several ayat
(`HifzItem.sequence`). Segmentation, anchors and transitions run for each ayah in
that sequence separately, so *every number below restarts at the beginning of
each ayah*: an item over `["112:1","112:2"]` has a segment `0`, an anchor word `1`
and a boundary at word `2` **in each** of the two ayat.

That makes the address of a stored fingerprint row three things, not two:

| Table | Identity |
|---|---|
| `hifz_segment` | `(item_id, verse_key, position)` |
| `anchor_word` | `(item_id, verse_key, word_position, role)` |
| `hifz_transition` | `(item_id, verse_key, kind, to_word, to_verse_key)` |

Storing them under `(item_id, position)` — which is what schema v2 did — silently
collides the second ayah's rows onto the first ayah's, so a two-ayah item loses
chunks of its own fingerprint. Schema v3 added the NOT NULL `verse_key` column;
the row had always carried that ayah, just only inside its **id**.

The id grammar is `{itemId}:{verseKey}:{tag}{n}` with `s`/`a`/`t` for
segment/anchor/transition, built by `segmentId`/`anchorId`/`transitionId`
(`core/src/hifz/segment.ts`). Item ids contain no colon, so the ayah is always the
field between the first and second colon and can be read back out of a row that
predates the column. The one irregular shape is an `inter` transition:
`{itemId}:{verseKey}:tnext-{nextVerseKey}` — the ayah embedded in the id is the
ayah the learner **leaves**, while `to_verse_key` is where they arrive.

**Nobody re-implements that grammar.** `verseKeyFromFingerprintId(id)` is the
single parser and `fingerprintVerseKey(row)` ("the row's own `verse_key`, else the
ayah its id spells out") is the single reader. Three consumers use them:
`core/src/backup/restore.ts` (a file exported before the column existed),
`core/src/backup/validate.ts` (warns when it had to recover), and the desktop
v2→v3 migration. A row whose id says nothing yields `NULL` and fails the NOT NULL
column rather than guessing a surah — the migration throws during derivation,
before any DDL, so nothing is half-written. v3 recovers the **ayah only**;
positions are carried byte-for-byte.

Finally: `verse_key` is TEXT, so any query that orders fingerprint rows numerically
by it must cast both halves (`VERSE_KEY_ORDER_SQL` in `desktop/src/gateway`);
plain text order sorts `2:10` between `2:1` and `2:2`.

## Word indexing rules (non-negotiable)

- Word positions are **1-based**, and they are positions *inside one ayah*: every
  ayah in an item's `sequence` numbers its own words from 1, which is why a
  position is meaningless without its `verse_key` (see
  [The row address is per-ayah, not per-item](#the-row-address-is-per-ayah-not-per-item)).
- An ornament / pause mark is **not** a word. A raw whitespace token counts as a
  word only when it is the next token `tokenizeWords` keeps *and* its
  normalised form is non-empty. The engine never redefines "same word" — it
  delegates to `core/src/normalize/arabic.ts`.
- Segments **tile** the ayah: `assertTiling` proves position 0 starts at word 1,
  the last segment ends at `wordCount`, positions are sequential, no range is
  inverted, and adjacent segments neither gap nor overlap. A fingerprint that
  fails tiling is a bug, not a warning. An ayah with `wordCount === 0` (no word
  token survives normalisation) yields **zero** segments — never a
  `{fromWord: 1, toWord: 0}` placeholder — because a wordless segment surfaces
  downstream as a dead, unrecordable session step.
- When a word-by-word pack (`AyahWord[]`) is supplied it is cross-checked
  against the text; disagreement is reported in `SegmentationResult.notes` and
  the **text** wins. The engine never edits Quran text to make data agree.

## Boundary rules

A candidate boundary sits *before* word position `p` (`2 ≤ p ≤ wordCount+1`):

| Signal | Score | Reason tag |
|---|---|---|
| previous word carries a pause (waqf) mark | `BOUNDARY_SCORE_PAUSE` = 3 | `pause-mark` |
| word normalises to a standalone clause connector | `BOUNDARY_SCORE_CONNECTOR` = 2 | `connector:<norm>` |
| word starts with a joinable clitic, ≥ `MIN_PREFIX_REMAINDER_CHARS` (2) left | 2 | `prefix-connector:<p>` |
| forced midpoint split (constraint only) | 0 | `forced-midpoint` |

Connector list (`STANDALONE_CONNECTORS`, compared **after** normalisation, so
`إن`/`أن` → `ان` and `إلى` → `الي`): و ، ف ، ثم ، ان ، لو ، ما ، من ، الي ، علي ،
في ، حيث ، كما ، اذا. Only `و`, `ف`, `ثم` are treated as joinable prefixes,
because longer particles are not written joined. Known false-positive class,
documented rather than hidden: a word whose *root* begins with those letters
(e.g. `وسع`) can look like a prefixed connector — the pause mark usually fires
there anyway and the size constraints absorb the rest.

Then constraints are applied, in this order, twice:

1. `enforceMinimum` — no segment shorter than `MIN_SEGMENT_WORDS` (2 words). The
   **weaker-scoring** adjacent boundary is dropped; ties drop the later one.
2. `enforceMaximum` — no segment longer than `MAX_SEGMENT_WORDS` (6 words). Near
   the midpoint, inside `FORCED_SPLIT_CANDIDATE_WINDOW` (2 words), a real
   rule-proposed boundary is preferred; only if none exists is a forced
   midpoint boundary inserted. This is how 2:255 (50 words) still chunks.
3. `enforceMinimum` again, because insertions can create short segments.

`SegmentationResult.proposedBoundaries` keeps **every** proposal, including the
ones the constraints removed, so the UI can show what the method saw instead of
only its final choice.

## Anchors

Roles: `opening` (word 1), `ending` (last word), `middle`
(`ceil(wordCount / 2)`), `boundary` (each chosen boundary). Where two roles
collide on one position, the positional role wins — `opening`/`ending`/`middle`
are more specific than `boundary`, so a position never gets downgraded.
Anchor ids are stable: `{itemId}:{verseKey}:a{wordPosition}`, and the anchor set is
derived per ayah, so the same `wordPosition` can be an anchor of two different ayat
of one item.

## Transitions

One `intra` transition per chosen boundary (`toWord` = the boundary position),
plus one `inter` transition to `nextVerseKey` at word 1 when the item continues
into another ayah. Each carries `successCount`, `failureCount`, `stability`,
`lastPracticedAt` — this is what "I always lose the ayah at the third clause"
becomes a number instead of a feeling.

Fresh memories start at `FRESH_MEMORY_STABILITY` = 0; nothing is pre-credited.

## The 15 recall probes

`recall.ts` builds cue + expected text for each `RecallMode`; the caller records
the recitation and hands it to `classify.ts`:

| Mode | Cue shown | Expected |
|---|---|---|
| `segment` | the segment before it, or an explicit segment position | that segment's words |
| `opening` | first third of the ayah (`POSITIONAL_THIRDS`) | the remainder |
| `middle` | middle third | the remainder from that point |
| `ending` | last third | the ending words |
| `transition` | `TRANSITION_CUE_WORDS` (2) words before a boundary | `TRANSITION_EXPECTED_WORDS` (3) after it |
| `continue-ayah` | a prefix of the ayah | the rest of the ayah |
| `continue-sequence` | `SEQUENCE_CUE_WORDS` (2) words ending the previous ayah | `SEQUENCE_EXPECTED_WORDS` (4) opening words |
| `missing-word` | the ayah with one word replaced by `⟪……⟫` | the blanked word |
| `first-word-cue` | the ayah's first word | the whole ayah |
| `last-word-cue` | the ayah's last word | the whole ayah, ending there |
| `reverse` | the ayah written word-reversed, from the last word | the ayah backwards |
| `random` | a seeded span of `RANDOM_PROBE_SPAN_WORDS` (3) words | the following words |
| `audio-recall` | an audio pack id (`audioPackId`) | the whole ayah |
| `full-ayah` | nothing | the whole ayah |
| `full-sequence` | nothing | every ayah in the item's `sequence`, in order |

`random` and `missing-word` take a **seed**, not `Math.random()`
(`seededRandom` = mulberry32, `seedToInt` accepts number or string), so a
re-run of a session plan yields the same probes. `buildProbe(mode, ctx)` is the
single entry point the UI uses; it fails loudly when the context lacks what a
mode needs (a previous ayah for `continue-sequence`, segments for `segment`)
rather than silently degrading to a different probe.
