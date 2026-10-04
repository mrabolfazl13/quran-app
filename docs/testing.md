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
  counts asserted (114 surahs, 6236 ayahs, 604 pages present), bulk rows written
  in chunked statements under SQLite's parameter ceiling with the values still
  bound (`tauri-gateway-statement-queue.test.ts`).
- alignment: a translation row fetched by `verse_key` matches the spot-check
  response the pipeline used, re-verified from raw data.
- engine over stored rows: add item → segment → attempt → stability → review
  queue, reading back from disk rather than memory.
- backup: export → wipe → restore → identical row counts and identical
  attempt payloads; restore of a corrupt or future-version envelope must fail
  without touching the live DB.
- migration: v1 DB opened by a newer app, then refused by an older one. The
  v2 → v3 fingerprint re-key (`hifz-schema-v2-to-v3.test.ts`) is exercised on
  real files: every stored row keeps the ayah it names in its own id, the rebuilt
  tables pass `PRAGMA foreign_key_check`, and a row the migration cannot place
  throws **before** any DDL, so an un-migratable file still opens at version 2.
- the E2E harness's own witnesses (`e2e-witness.test.ts`): a built bundle that is
  older than the source it is supposed to be judging is refused, and a runner
  that dies mid-journey reports a failure instead of a footnote.

## How to run

```bash
npm run test:core         # core unit suite
npm run test:desktop      # desktop unit suite (desktop/src/**)
npm run test:integration  # tests/integration/** — real SQLite through node:sqlite
```

`tests/integration/tauri-gateway-statement-queue.test.ts` mocks only
`@tauri-apps/plugin-sql`: the SQL, the schema and the transactions are real
SQLite against a temp file, and the fake driver fails any second concurrent
statement, so the gateway's serialisation is pinned rather than described.

**Wall-clock budgets in this lane.** The two heaviest suites carry a documented
allowance on the suite itself (`MUSHAF_TIMEOUT` / `QUEUE_TIMEOUT`, 60 s) instead
of vitest's default 5 s. Measured on an otherwise idle machine those bodies run
0.5–1.6 s, but the lane opens 16 files of real SQLite at once on an 8 GB machine,
and the default budget then expires on a test that is queued behind another
file's I/O — the failure reads as `Test timed out in 5000ms` on a row-integrity
assertion and points the next operator at `verify.ts`. Proved to be an allowance
and nothing more by running the file with `--testTimeout=1`: the whole-mushaf
suite still passes, the 31-ayah suite — deliberately left on the default — fails.
No test passes because it was fast, and a genuine hang still reports.

Commands for the packaged-app level (the only level that can prove a shipped
path) are in `docs/packaging.md` and `docs/release.md`.

**E2E** — `tests/e2e/`, plain Node with no new dependency, driving the *shipped*
app over the Chrome DevTools Protocol (WebView2 exposes it with
`--remote-debugging-port`; the web shell is the built bundle served on a
loopback port and opened in headless Edge on a profile of its own). The browser
dev shell is not a substitute for the shipped path and is not what runs here:

```bash
npm run test:e2e          # installed quran-desktop.exe, fresh app-data profile
npm run test:e2e:web      # desktop/dist over http://127.0.0.1:<port> + headless Edge
node tests/e2e/run.mjs --expect-only    # what the assertions expect, and from where
node tests/e2e/run.mjs --restore-profile # finish a run that was interrupted mid-park
```

The journey in one pass — open → Quran → surah → ayah → translation → tafsir →
bookmark → note → add to hifz → recall → seeded error → weak review → similar
ayah → confusion group → backup → restore → verify the ayah is still weak in
exactly the way it was — plus a search tail. Five rules make the report
auditable rather than impressive:

- Every write goes through the DOM a user uses. The SQLite file and IndexedDB
  are opened **read-only** and are only ever the witness, never the instrument.
- Every expected value is derived — counts from `content/index.json`, the
  post-restore state from the app's own pre-backup snapshot. Nothing is typed in
  beside a screenshot. `--expect-only` prints the derived figures and fails if
  they drift from the constants `docs/current-state.md` quotes.
- Each step carries its evidence level. A step only the packaged desktop binary
  can answer (native paths, a file on disk) is recorded as `SKIP` with a reason
  on other shells, never faked with a weaker witness.
- **The bundle under test must be newer than the source that goes into it.**
  `assertBundleFresh` (`tests/e2e/lib/launch.mjs`) compares `dist/index.html`
  against every `.ts/.tsx/.css/.sql` under `desktop/src` and `core/src` and
  refuses the run when a source file was written after the build, naming the
  file and `npm run desktop:build`. A stale `dist` produces both kinds of lie at
  once: a PASS that says nothing about the code being changed, and a FAIL that
  blames code which is fine — the web journey's first false failure was exactly
  that, a `desktop/dist` predating the schema v3 re-key.
- **A runner that crashes reports a failure.** `Suite.fail`
  (`tests/e2e/lib/harness.mjs`) exists because the top-level `catch` used to log
  the crash as a `NOTE`, so a journey that verified nothing printed `FAIL 0` and
  exited 0. The stale-bundle refusal now exits 1 with a FAIL row naming the
  reason.

**Offline gate** — the E2E run intercepts every request the page makes and
refuses the ones that are not on the local allowlist (`tauri.localhost`, the
IPC host, loopback, `file:`, `data:`, `blob:`), then asserts zero offenders
across the whole journey. That is request-level proof inside the app's own
window, which is stronger than a cable and cannot be faked by a warm cache. The
cable check itself stays manual and is not automated: disable the adapter by
hand, open the installed app, import, browse, recite, back up. If anything there
resolves only when the network returns, it is a bug in the offline design, not a
test artifact. `--no-network-block` switches the suite to observe-only (it counts
requests and buckets origins, but refuses nothing).

**Responsive gate** — `tests/e2e/layout.mjs` measures every route at
360/390/768/1024/1280/1440 px in light and dark against the *built* bundle on a
loopback port — the same `desktop/dist` an Android WebView or a PWA would load,
not a vite dev server. A screen is a violation when any element crosses the
viewport edge, when the document scrolls horizontally, when text is clipped by
its own box, or when a control paints outside its scroller. The run that matters
happens **after** the journey: the sweep has to measure screens holding the
learner's real items, attempts and notes, which no empty database can represent.

- Latest full sweep: **264 screens measured (22 routes × 6 widths × 2 themes) ·
  0 violations**, in the web shell at device level.
- `#root { overflow-x: clip }` stops the page from scrolling sideways but does
  not hide a violation: the per-element edge tests run on the layout box, so a
  block that really is wider than the viewport still fails. Narrowing a
  threshold is not a fix and has not been used.
- Every fix so far was a root-cause CSS rule, and each one is the kind that
  breaks again: a stretched flex item must be given `inline-size: 100%` or it
  sizes to its widest descendant; an action row that must wrap needs
  `flex: 0 1 auto; min-width: 0`, because `flex: none` keeps it at max-content
  width and the parent's `flex-wrap` never engages.
- Tap targets, contrast and clipped text are reported as `NOTE`s, not gate
  failures, so a reviewer sees them without a run going red on a judgement call.

```bash
node tests/e2e/layout.mjs --url=http://127.0.0.1:<port>/ --widths=360,768,1440 --themes=light,dark
npm run test:e2e:web -- --widths=360,768,1440   # journey + sweep in one lifecycle
```

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
6. A wait in the E2E journey matches the thing it is waiting for, by its own
   face. Waiting on body text is how a run stalls on a working screen: the
   session runner's header chip «ثبت‌شده» is on screen from step one, so
   "verdict arrived" has to mean *the «داوری موتور» panel title exists and the
   recitation box is gone*. Where a screen legitimately offers two endings
   (next-step button, or "all steps reached" on the last one), the wait accepts
   both, and a timeout dumps the panel titles and control inventory instead of
   an adjective.

## Measured, not invented

Performance is recorded from actual runs into `docs/performance.md`: startup,
memory, scroll, search latency, query times, session start, with the machine
and build identified. If a number has no measurement behind it, it does not go
in the docs.
