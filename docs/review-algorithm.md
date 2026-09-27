# Review Algorithm

Deterministic scheduler behind "Today's Hifz" (master-prompt §11). Code:
[`core/src/hifz/stability.ts`](../core/src/hifz/stability.ts),
[`core/src/hifz/review.ts`](../core/src/hifz/review.ts). All tunables:
[`params.ts`](../core/src/hifz/params.ts).

## Status of these numbers

These are **engineering heuristics**: bounded, monotone, explainable, and
centralised so tuning is a one-file change. They are **not** validated by memory
research and the product makes no scientific claim about them. The `0.5 ** (d /
14)` term is shaped like an Ebbinghaus curve because that shape is convenient
and well understood, **not** because it was fitted to anything.

## Stability

For one item, over its attempt history (sorted by timestamp, ties by input
order):

```text
recentAccuracy  = Σ (0.7^distance-from-newest × accuracy) / Σ weights   over the newest RECENT_WINDOW (5) attempts
consistency     = 1 − (stddev of the recent accuracies / 0.5)           (0.5 is the max stddev for 0..1 values)
attemptFactor   = 1 − e^(−attemptCount / ATTEMPT_SATURATION)           (saturates ≈ 5 attempts)
errorRate       = wrong expected words / expected words                (all attempts)

strength        = 0.55·recentAccuracy + 0.15·consistency
                + 0.15·attemptFactor  + 0.15·(1 − errorRate)           → weights sum to 1

elapsed         = days since (lastReviewedAt ?? last attempt ?? addedAt)
decay           = max(0.05, 0.5 ^ (elapsed / 14))                      (DECAY_FLOOR so a learned ayah is never "gone")
stability       = strength × decay                                     (0 when there are no attempts)
```

An attempt counts as a **success** at `accuracy ≥ SUCCESS_ACCURACY` (0.85),
everywhere in the engine — one definition, no per-module variants.

### Bands

Order matters; the first match wins, and a low attempt count can never be
outranked by a lucky recitation:

| Band | Condition |
|---|---|
| `new` | `attemptCount < 2` |
| `mastered` | all four: stability ≥ 0.92, attempts ≥ 8, recentAccuracy ≥ 0.95, errorRate ≤ 0.03 |
| `stable` | stability ≥ 0.75 **and** attempts ≥ 3 |
| `weak` | stability ≥ 0.45 **and** attempts ≥ 2 |
| `unstable` | everything else |

`overdue` is deliberately **a state, not a band**: it exists only relative to a
stored `nextReviewAt` and the moment you ask about (`isOverdue(next, now)`).

### Intervals

```text
intervalDays = round( BAND_INTERVAL_DAYS[band] × (0.5 + 1.0 × stability) )   capped at MAX_INTERVAL_DAYS (45)
nextReviewAt = nowIso + intervalDays                                         (nowIso when there are no attempts)
```

Base band intervals (days): new 0 · unstable 1 · weak 2 · stable 5 · mastered 12.
The stability multiplier pulls a *shallow* item back to half its band interval,
so a high band with thin history is not trusted.

## Review priority

Nine factors, each computed 0..1 then weighted. **The weights sum to exactly
1.00** (`review.test.ts` asserts this):

| Factor | Weight | Raw value |
|---|---|---|
| `historical-errors` | 0.16 | word-level errors / expected words over all attempts; falls back to `errorCount / 24` when there are no attempts |
| `weak-segments` | 0.16 | `0.5 × (1 − mean segment stability) + 0.5 × share of segments below 0.6`; without segment data, `1 − item.stability` |
| `weak-transitions` | 0.12 | same shape over transitions, threshold 0.6 |
| `overdue` | 0.20 | days late / 21 (saturates); `NEVER_SCHEDULED_FACTOR` = 0.4 when unscheduled; 0 when not due |
| `recency-of-success` | 0.08 | days since last successful recall / 30; 1 when never successful |
| `repetition` | 0.08 | `1 − attempts / 12` |
| `confusion-rate` | 0.10 | cross-ayah errors (`wrong-transition`, `similar-ayah-confusion`) / 3 |
| `group-membership` | 0.06 | `max(group.confusionCount / 3)` over the item's groups |
| `band` | 0.04 | urgency map: new 0.75 · unstable 1 · weak 0.8 · stable 0.4 · mastered 0.1 |

`priority = Σ (factor × weight)`, rounded to 4 decimals. Every entry carries
both the raw factor and its weighted contribution (`factors[key]`,
`factors[key + "-raw"]`), plus a human-readable `reason` built from the three
largest contributions — so the UI answers *"why is this ayah due?"* from stored
history instead of inventing a sentence.

### Confusion-group lift

A group boosts its strongest member by `min(1, priority + 0.02 × triggers)`
(capped at `GROUP_BOOST_CAP` = 0.08) and pulls the other members toward it:
within `GROUP_MEMBER_TAPER` (0.05) of the leader, but never lifted more than
`GROUP_MEMBER_LIFT_CAP` (0.15). The cap is what stops a `mastered` partner of a
`weak` ayah from being dragged to the top of the queue — "review these together"
does not mean "these are equally urgent".

### Suggested mode

An ordered rule chain on the raw factors; the first rule that fires wins, which
keeps the choice explainable:

```text
no attempts or band = new                 → segment
confusion / group signal                  → full-ayah
weak transitions ≥ weak segments, > 0     → transition
positional failure history                → opening | ending | middle  (worst side, ties: beginning → ending → middle)
any weak segment                          → segment
overdue or stale success                  → first-word-cue
otherwise                                 → missing-word
```

## Daily plan

```text
planReviews()  → score all active items, apply group lift, sort
                 (priority desc, dueAt asc, verseKey asc, itemId asc)
             → keep entries with priority ≥ PRIORITY_PLAN_CUTOFF (0.18)
             → cap at DAILY_REVIEW_ITEM_CAP (20)
             → split: priority ≥ PRIORITY_WEAK_CUTOFF (0.55) = weakItems, rest = reviewItems
newAyahs   → curriculum order, capped at NEW_AYAH_PER_DAY_CAP (5)
groups     → only groups containing a planned verse key
```

Paused / graduated / dropped items are never scheduled.

## Time estimate — always a sum, never a constant

`estimatedMinutes = ceil(Σ step seconds / 60)` over exactly the steps in the
plan (`estimatedSeconds` and `stepCount` are returned too, for the UI's
breakdown panel). Per-attempt costs (`MODE_COST_SECONDS`, seconds):

```text
segment 12 · opening 10 · middle 10 · ending 10 · transition 8
continue-ayah 20 · continue-sequence 20 · missing-word 8
first-word-cue 15 · last-word-cue 15 · reverse 25 · random 20
audio-recall 35 · full-ayah 30 · full-sequence 45
```

plus `STEP_OVERHEAD_SECONDS` (5) per step, and for each new ayah
`90 + 6 × wordCount + 2 × 40` (exposure + chunk building + two recall
attempts). Word counts come from the content pack when supplied; the
`DEFAULT_NEW_AYAH_WORD_COUNT` (6) fallback is flagged in the docs rather than
presented as measured.

## Determinism guarantees

- `nowIso` is a parameter; no clock reads, no `Math.random()`.
- All scores rounded to `SCORE_DECIMALS` (4).
- Sorts have total tie-break chains, so ordering is reproducible.
- Weight overrides are accepted per call (`input.weights`) for tuning and tests;
  missing keys fall back to `REVIEW_WEIGHTS`.
- A test schedules the same context twice and compares the JSON byte for byte.
- The same inputs must produce the same numbers in the future Dart port; that is
  the reason none of these functions touch a database, a clock or a RNG.
