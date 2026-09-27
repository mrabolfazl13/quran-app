# Testing

## Levels

**Unit** — `core/tests/**`, vitest, no I/O, no clock. Every function that
decides something the user trusts is here:
- `tests/normalize/` — what "the same word" means. 21 cases over real Uthmani
  strings: harakat removal, alef folding, ta marbuta, Persian keystrokes,
  tatweel, annotation marks, digit folding, idempotence, direction detection.
- `tests/hifz/` — segmentation tiling invariants (no word covered twice, none
  missed), every recall probe, every error kind produced from a hand-written
  Arabic recitation, stability band transitions over a simulated 30-day history,
  scheduler determinism (same input → byte-identical queue twice).
- `tests/search/`, `tests/mutashabihat/` — each query type, RTL highlight
  offsets, guards (empty, diacritic-only, regex metacharacters, very long),
  indexed results agreeing with a brute-force reference on the same fixture.

**Integration** — `tests/integration/`, real SQLite:
- pack import: checksum verified, transaction abort leaves the DB untouched,
  counts asserted (114 surahs, 6236 ayahs, 604 pages present).
- alignment: a translation row fetched by `verse_key` matches the spot-check
  response the pipeline used, re-verified from raw data.
- engine over stored rows: add item → segment → attempt → stability → review
  queue, reading back from disk rather than memory.
- backup: export → wipe → restore → identical row counts and identical
  attempt payloads; restore of a corrupt or future-version envelope must fail
  without touching the live DB.
- migration: v1 DB opened by a newer app, then refused by an older one.

**E2E** — `tests/e2e/`, Playwright against the packaged app (headless Edge or
WebView2 CDP gives real pixels on this machine; the browser dev shell is not a
substitute for the shipped path):
the user journey in one pass — open → Quran → surah → ayah → translation →
tafsir → bookmark → note → add to hifz → recall → seeded error → weak review →
similar ayah → confusion group → backup → restore → verify the ayah is still
weak in exactly the way it was.

**Offline gate** — the same E2E with the network disabled. Any failure that
resolves when the network returns is a bug in the offline design, not a test
artifact.

## Rules

1. A green build is not a result. Only executed tests are reported, and
   `docs/current-state.md` records counts, not adjectives.
2. Determinism is tested, not assumed: time and randomness are parameters, so a
   failing scenario can be re-run exactly.
3. Text integrity tests compare bytes. A test that normalises the Quran text
   before comparing would pass on a corrupted database.
4. UI state tests cover the five states per screen (loading, empty, error,
   offline, success) — a screen with no empty state has no tests, and the check
   fails.
5. Numbers in reports are labelled with their level: engine-level (pure
   function), database-level, or device-level (packaged app). An engine-level
   timing never becomes a "the app is fast" claim.

## Measured, not invented

Performance is recorded from actual runs into `docs/performance.md`: startup,
memory, scroll, search latency, query times, session start, with the machine
and build identified. If a number has no measurement behind it, it does not go
in the docs.
