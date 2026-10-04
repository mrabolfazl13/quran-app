# Hifz method — two axes: form and meaning

Code: [`core/src/hifz/`](../core/src/hifz/) · Contracts:
[`core/src/contracts/hifz.ts`](../core/src/contracts/hifz.ts),
[`db.sql`](../core/src/contracts/db.sql) (schema v3) · Engine internals:
[hifz-engine.md](hifz-engine.md), [memory-fingerprint.md](memory-fingerprint.md),
[review-algorithm.md](review-algorithm.md)

## The problem this is aimed at

A learner can pass every probe the old engine offered while having memorised
nothing but sound. All fifteen recall modes cue **Arabic with Arabic**: the
previous word, the first word, the opening third, the boundary between two ayat.
Every one of them is answerable by a motor chain that never touches meaning —
which is exactly the failure Persian learners describe as حفظ طُلقی: the tongue
runs, the mind is empty, and the ayah collapses the moment the cue changes.

So the engine now tracks **two separate memories** per item and per segment:

| Axis | Cue | Answer | What a failure means |
| --- | --- | --- | --- |
| **form** | Arabic (word, anchor, boundary, audio) | Arabic | the sound-shape is not settled |
| **meaning** | a licensed meaning of the ayah or chunk | Arabic | the words are not bound to what they say |

They are stored separately (`hifz_item.form_stability`,
`hifz_item.meaning_stability`; `hifz_segment.stability` for form and
`hifz_segment.meaning_stability` for meaning), they decay separately, and they
are scheduled separately. Nothing averages them.

## The composite is the weaker axis

`HifzItem.stability` — the number the band, the queue and every screen read — is
**min(form, meaning)**, not a blend:

```
stability = min(formStability, meaningStability)   # meaning tested
stability = formStability                          # meaningStability is null
```

An ayah whose recitation is flawless and whose meaning is blank is *recited*, not
memorised, and the product must not report it as memorised. This is a deliberate
pessimism: a learner who sees 96% on an ayah they cannot explain is being lied to
by the dashboard.

**Untested is not zero.** `meaningStability === null` means the meaning axis has
never been probed, so it is left out of the minimum entirely; a zero would drag
every flawless recitation down to band `new` and punish the learner for a question
the app never asked. The same rule holds per segment. Consequence for a migrated
history: attempts recorded before schema v2 were all form attempts, so
`dimension = 'form'` and the meaning axis of those items reads as **untested**
(`NULL`, never `0`) rather than as a fabricated zero-scored failure or an invented
100%. `docs/changelog.md` records the same rule for the backup envelope.

Schema v3 changed no semantics of the axes. It fixed the *address* of the
fingerprint rows: a segment, anchor or transition belongs to one ayah of the
item's `sequence`, and its `position` restarts for every ayah, so the stored key
is `(item_id, verse_key, position)` — see
[memory-fingerprint.md](memory-fingerprint.md#the-row-address-is-per-ayah-not-per-item).

## The two meaning probes

Only two modes exist today, and both are graded by the alignment code that
already grades form probes (`classifyRecitation` with a graded `span`) — the cue
changes, the scoring does not.

- **`meaning-to-arabic`** — the meaning of the ayah (or of one segment) is shown;
  the learner produces the Arabic of that span. This is the direct test of
  binding: it asks for the revelation itself, from nothing but its sense.
- **`concept-cue`** — the meaning of the **previous** ayah is shown; the learner
  produces the opening of the target ayah. This trains the chain that actually
  breaks in prayer and in recitation: not the words, but the seam between ideas.

Both write a `recall_attempt` row whose `dimension` is derived from the mode
through `RECALL_MODES`/`RECALL_DIMENSION` — a caller cannot mislabel an attempt,
and a report can be reprinted after the mode table changes.

## Where a meaning comes from (and where it never comes from)

Quran text is immutable and content is never invented (AGENTS.md §1–§2). The
meaning axis inherits that rule, so every `SegmentMeaning` names the licensed
pack its text was read from:

| Meaning | Source | `packId` | `wordGloss` |
| --- | --- | --- | --- |
| whole ayah | the learner's selected translation pack (`tr-fa-kaldari`, `tr-fa-islamhouse`, `tr-en-abdulhaleem`) | that pack's id | `false` |
| one segment | `ayah_word.translation_en` joined over exactly the word positions the segment covers | `word-data` | `true` |

The segment case is the reason the word-by-word pack ships: a chunk's meaning is
**the glosses of its own words**, addressed by `verse_key` + `position`, so no
algorithm has to guess which clause of a translation belongs to which chunk of
the Arabic. Clause-to-segment alignment would have been a heuristic, and a
heuristic that assigns meaning to revealed text is not something this app does.

When no licensed meaning covers a range, `SegmentMeaning` is `null`, the engine
refuses to build that probe, and the session builder **skips the meaning phase**
instead of emitting a step the learner cannot be scored on. A missing Persian
word-by-word gloss pack is a known gap: Persian meaning cues come from the
full-ayah translations until a licensed per-word Persian pack exists. Nothing is
machine-translated to fill it.

## Scheduling on the lagging axis

The review model gains one factor: how far the meaning axis sits below the form
axis for that item. `suggestMode` then prefers a meaning mode when meaning lags
form and a licensed meaning exists, and a form mode otherwise. Every factor stays
in the `factors` map the UI already prints, so «چرا این آیه امروز آمده» keeps
being answerable.

The session keeps its fixed phase order
([hifz-engine.md](hifz-engine.md#session)), with the meaning layer inserted where
comprehension actually precedes production: a new ayah is *understood chunk by
chunk* before it is recited chunk by chunk, and the seam drills run on meaning
for items whose form is already solid.

## Session report

Form recall and meaning recall are reported as **two numbers**, never blended
into one "overall". A learner who scored 90% on form and 30% on meaning has a
different job for tomorrow than one who scored 60% and 60%, and a single blended
figure would hide that difference — which is the whole thing this method exists
to surface.

## Status of these numbers — read this before quoting any of them

Every threshold, weight, cost and factor in this engine is an **engineering
heuristic** chosen to be bounded, monotone and explainable. Nothing here is
validated by memory research, and no claim of scientific effectiveness is made
in the engine, these docs, or the UI. All tunables live in
[`core/src/hifz/params.ts`](../core/src/hifz/params.ts). The dual axis is a
better-shaped model of what can go wrong in memorisation; it is not a measured
cure, and the app must keep saying so in the same voice it uses everywhere else.
