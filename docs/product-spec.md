# Product spec

## Who it is for

A single user memorising and studying the Quran, usually offline, usually on a
phone or at a desk, reading Arabic with a Persian interface. No accounts, no
sync, no server.

## The thesis

Reading apps answer "what does this ayah say?". This app answers
"will I still have it in three weeks, and where exactly will it break?".

That shifts the unit of work from the page to the **memory fingerprint**: every
memorised ayah is tracked as segments, anchors, transitions and a recall history,
so weakness is located precisely (segment 2 of 2:255, the transition into 2:256)
instead of reported vaguely as "review this ayah".

## Pillars and delivery order

| # | Pillar | Status |
| --- | --- | --- |
| 1 | Reading (surah / juz / page / mushaf / ayah mode) | this round |
| 2 | Understanding (translation fa+en, word-by-word) | this round |
| 3 | Tafsir (source-bound, attribution shown) | this round |
| 4 | Search (Arabic / Persian / English / word) | this round |
| 5 | Memory engine (fingerprint, recall, errors, review) | this round |
| 6 | Mutashabihat (similar ayahs, difference highlighting) | this round |
| 7 | Confusion groups | this round |
| 8 | Notes, bookmarks, reflection | this round |
| 9 | Backup / restore | this round |
| 10 | Concepts and related ayahs | packs pending |
| 11 | Audio | not bundled — licence unresolved |
| 12 | Android (Flutter) | phase 2 |

## Navigation

HOME · QURAN · HIFZ · DISCOVER · TAFSIR · ME.

**HOME** is an honest digest: continue reading, today's mission (new / review /
weak / confusion counts), the least stable ayahs, and the last session. Every
number is a query result. With no history it shows an onboarding empty state,
not a plausible-looking zero-filled dashboard.

**QURAN** reader: ayah mode and mushaf page mode, translation and tafsir
toggleable per session, tap an ayah for the intelligence panel with progressive
disclosure — text → translation → words → tafsir → related/similar → hifz
actions → notes.

**HIFZ** is the workbench: the mission list, the session runner
(warm-up → new → progressive recall → transitions → similar-ayah drill →
reverse → random → assessment) and a report that says what broke.

**DISCOVER** holds search, concepts, and the similar-ayah browser.
**TAFSIR** holds the source library with its licences.
**ME** holds settings, data health, backup.

## Hifz session, in product terms

The user recites (types) what they remember. The engine normalises, aligns the
word stream against the authoritative text, and classifies each divergence into
one of: omission, substitution, repetition, wrong-order, wrong-transition,
similar-ayah confusion, plus positional failures (beginning / middle / ending).
That classification is deterministic text alignment — no model, no guessing —
and it is what makes the next review queue meaningful.

## What this product refuses to do

- Present generated text as revelation, tafsir, hadith or history. Anything
  machine-made is labelled `AI GENERATED` and quarantined from canonical panes.
- Present computed relationships as religious rulings. Concept and similarity
  links carry a `type` (`textual` / `linguistic` / `thematic` / `educational` /
  `editorial`) and the UI shows it.
- Report a stability score, streak or estimate that no stored attempt produced.
- Claim the spacing of reviews is scientifically validated. It is a documented
  heuristic, tunable, unproven.
- Phone home. If a feature needs the network, it does not ship.

## Acceptance bar

The memory engine quality gate in `AGENTS.md` is the real gate: segmentation,
anchors, all recall modes, persisted attempts, error classification, weak-area
calculation, review priority response, similar ayahs, confusion groups, session
report — each exercised through the packaged app, with the network off.
