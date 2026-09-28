# Performance

Every number here carries the level it was measured at. A model-level figure is
not a product claim, and this project has been burnt by quoting one as if it
were the other.

Levels used:

| Label | What it means |
| --- | --- |
| **unit/model-level** | a function called directly in a test or throwaway script, Node on this dev machine. Says nothing about the app. |
| **pipeline-level** | output of the build-time content tools (`npm run content:*`) over the captured provider files. |
| **browser-dev-shell-level** | the Vite shell (`desktop`, `DevGateway`). Real UI code, wrong storage layer, wrong process. Not the shipped path. |
| **packaged-app / device-level** | the Tauri binary on a real machine. Only the import-cost and database-size figures below are at this level; everything else is a lower layer. |

This matches the rule already in `docs/testing.md`: "Numbers in reports are
labelled with their level: engine-level, database-level, or device-level."

## Corpus scale — pipeline-level

From `npm run content:validate` (run 2026-09-28 on this machine; command in
`package.json:16` → `tools/content` `validate`). It passed with 5 warnings.

| Quantity | Value |
| --- | --- |
| surahs | 114 |
| ayahs | 6,236 |
| word rows | 83,665 |
| end-of-ayah marks among them | 6,236 |
| distinct mushaf pages covered | 604 |
| maximum line number observed | 15 |
| rows with a bad page/line | 0 |
| verses whose word-row page disagrees with `ayah.page` | 56 |
| verses whose word text differs from the bulk text only in ornamental pause marks | 3,599 of 6,236 |
| packs in `content/index.json` at the time of the run | 8 |

Seven of those eight are committed at `b62612c`; the eighth
(`mutashabihat-ar`, 1,732 records) is a derived pack that exists only in the
uncommitted working tree while the mutashabihat gap is being closed — see
`docs/current-state.md` and `docs/mutashabihat.md`.

Payload volume, read from each `content/<pack>/pack.json` `payloadBytes`:

| Pack | Records | Payload |
| --- | --- | --- |
| `word-data` | 83,665 | 18,463,718 B (17.6 MiB) |
| `quran-core` | 6,350 | 3,927,429 B |
| `tr-fa-islamhouse` | 6,236 | 1,932,380 B |
| `tr-fa-kaldari` | 6,236 | 1,793,124 B |
| `tr-en-abdulhaleem` | 6,236 | 1,157,373 B |
| `tafsir-en-ibnkathir` | 300 | 2,193,978 B |
| `tafsir-ar-muyassar` | 1,013 | 472,505 B |
| **committed total (7 packs)** | | **29,940,507 B (28.55 MiB)** |

`word-data` is ~62% of the content volume: it carries the text of every word
plus its `pageNumber`/`lineNumber`. Any future "make the app lighter" work
starts there, not in the engine.

Tafsir coverage is a content fact, not a speed fact, but it belongs next to the
counts: Ibn Kathir ships 300 rows because the provider edition groups passages
and 762 of its 1,062 rows are empty (`content:validate` warns about exactly
this). See `docs/tafsir-system.md`.

## Pack import cost — measured at device level

The importer times itself: `desktop/src/content/importer.ts:107` computes
`durationMs: Math.max(0, now().getTime() - started)` and puts it in the
`ImportReport` (`desktop/src/gateway/types.ts`, `ImportReport.durationMs`). The
content-health screen is what surfaces it to a user
(`desktop/src/screens/me/ContentHealthScreen.tsx:108-109` — "`N` packs imported
in `X` ms" — and `:371` in the detail panel); the same screen lists each pack's
`payloadBytes` through `formatBytes` (`:304`). It does **not** report the size
of the SQLite file — there is no such field on the gateway
(`desktop/src/gateway/types.ts` has no database-size member), so that number
has to be taken off the filesystem.

Taken 2026-09-28 on the installed Windows app (NSIS build, this machine, 8 GB
RAM), network disabled, clicking «دریافت و بارگذاری» on `/me/content` and
reading the elapsed wall clock plus the report the screen quotes:

| Run | Records written | Click → committed (wall clock) | `durationMs` in the report |
| --- | --- | --- | --- |
| First import into an empty database, **before** the batching fix | 111,776 | **164.1 s**, UI blocked behind the statement queue the whole time | ~1,900 ms (understated: it timed verification only) |
| First import into an empty database, after | 111,776 | **10.4 s** (2 s polling resolution) | 8,565 ms |
| Full re-import over populated content | 111,776 | **7.33 s** (200 ms polling) | 7,150 ms |

Both post-fix runs left identical row counts read back out of the app's own
`quran.db` with `node:sqlite`: 114 surahs, 6,236 ayahs, 83,665 word rows,
18,708 translations, 1,313 tafsirs, 1,732 similar-ayah pairs, 8 packs, 6,236
FTS rows, backend `sqlite-fts5`. Database file after a full import: **28 MB**.
Peak working set of the app process during the import: **130.7 MB**. Zero
non-local requests, zero console exceptions.

The 164 s is an IPC cost, not a SQLite one: the statement queue (see
`docs/packaging.md`, `tests/integration/tauri-gateway-statement-queue.test.ts`)
keeps the plugin on one connection, so a write path of one `execute()` per
record means 111,776 round trips. `desktop/src/gateway/batchInsert.ts` chunks
rows into multi-tuple `INSERT`s under SQLite's variable ceiling (900 bound
parameters per statement) instead; the values stay bound, so the revealed text
still needs no escaping step. `applyImport` now adds its own write time to the
report before persisting it, which is why the quoted number and the wall clock
agree.

The first two rows are the reason `docs/testing.md` insists on device-level
numbers: the same code that "imports in under two seconds" at report level took
near three minutes on a user's machine.

### The same import on the web target — device-level, packaged build

Not the same work, so not comparable to the rows above: there is no SQLite and no
IPC round trip here. `DevGateway.ready()` fetches each pack from the origin,
verifies its checksum, and keeps the parsed records in memory; the user's own
rows are the only thing written to disk (IndexedDB).

Taken 2026-09-28 in headless Edge against
`node bin/serveWeb.mjs` on `127.0.0.1:4173`, serving
`release/web/quran-web-0.1.0`, with `Network.enable` on and an empty store:

| Measurement | Value |
| --- | --- |
| Navigation → first `/content/` request | 640 ms |
| Navigation → last `/content/` response received | 3,008 ms |
| `ImportReport.durationMs` for that import | 2,594 ms |
| Packs fetched / records mapped | 9 requests / 111,776 rows |
| Counts after import, read from the running page | 114 surahs, 6,236 ayahs, 83,665 words, 18,708 translations, 1,313 tafsirs, 1,732 similar, 8 packs |
| Non-local requests during the session | 0 |
| Console errors | none |

The 2.4 s window is nine requests over loopback dominated by payload size, not by
parsing — the identical pack set in the dev shell (same code, `vite dev` serving
it) imported in 2,369 ms, and the desktop path's 7–10 s is SQLite writing 111,776
rows through Tauri IPC. Three numbers for three different jobs; the row counts
are the only thing they agree on.

With the server process killed and the cache warm (24 entries: 9 content, 8
assets, 7 shell), a real navigation to the dead port paints the home screen, a
Persian query answers from the memory index, and page 42 renders — 0 network
failures and 0 exceptions. That is a cold-cache-free measurement: it says the
bytes a running app needs are all in the cache, not that a first run can happen
without the server.

## Engine cost — unit/model-level

Measured 2026-09-28 on this machine with a throwaway vitest file
(`core/scratch-perf.test.ts`) that was **deleted after the run**; no scratch
files remain in the tree (`git status --porcelain core` shows no such entry).
Node 24, V8 in a vitest worker, medians over the stated iteration counts, real
pack data read from `content/`. These are function-call costs, not in-app
latency.

| Call | Input | Median | Spread |
| --- | --- | --- | --- |
| `classifyRecitation` | 2:282 (129 tokens) with 8 substituted words | 7.36 ms | min 5.58 / max 15.94, 50 iters |
| `classifyRecitation` | 2:255 (51 tokens), graded span 12..40, clean | 0.64 ms | min 0.56 / max 1.62, 100 iters |
| `buildDailyPlan` | 200 items, 600 attempts | 3.21 ms | min 2.03 / max 6.23, 20 iters |
| `buildSessionSteps` | same 200 items + the plan above | 0.23 ms | min 0.20 / max 0.31, 20 iters |
| `buildMushafLayout` | all 83,665 rows + 6,236 ayahs → 604 pages | 174–247 ms | three separate cold runs, 0 unplaced, 56 diagnostics |
| `renderPage` | one page, page-scoped word list (153 refs, page 19) | 0.086 ms | min 0.065 / max 0.177, 200 iters |
| `renderPage` | one page, **whole 83,665-row** word list | 19.75 ms | min 13.43 / max 47.32, 50 iters |
| `renderPages` | all 604 pages, whole word list | 16,066 ms | single run |

Two things follow from the last three rows, and they are advice, not promises:

1. `renderPage` indexes the word list it is given (`core/src/mushaf/render.ts`).
   Pass it the page's words and a page renders in well under a millisecond;
   pass it all 83,665 rows and each call costs ~20 ms of pure re-indexing.
   `desktop/src/screens/quran/PageScreen.tsx` already fetches words per ayah for
   the page it draws (`:43`), i.e. the shipped path is the cheap one.
2. Rebuilding the whole 604-page grid costs ~0.2 s of CPU. That is acceptable
   once, at startup, if a future screen needs the full grid — it is not
   something to do per keystroke. No current screen does; the reader builds one
   page at a time.

The 2:282 classify figure is the worst realistic case in the corpus (longest
ayah) and it is dominated by the edit-distance alignment over 129 words; the
51-token span case is 10× cheaper. A session grades a handful of steps, so the
engine's share of a session is milliseconds. Whether the *app* feels instant is
a device-level question this file does not answer.

For reference, the same code exercised by the real test suites:
`cd core && npx vitest run tests/mushaf` → **91 passed / 2 skipped (93) in
11.30 s** (wall clock, this machine, 2026-09-28), of which the always-run
real-corpus tests take ~4 s because they read 16 raw provider files.
`MUSHAF_FULL_CORPUS=1 npx vitest run tests/mushaf` adds the two full-corpus
audits and passed (exit 0) on the same date. These are suite durations, not
product latencies.

## Bundle size

The web bundle exists now, so half of this section is measured. The desktop
half is still the same story as when it was written: `npm run desktop:build`
(`package.json:18`) runs `build = npm run sync:schema && tsc --noEmit && npm run
build:vite` (`desktop/package.json:8`), and `sync:schema`
(`desktop/scripts/syncSchema.mjs`) regenerates the tracked file
`desktop/src/db/schema.generated.ts` inside `desktop/src/db/` — a directory
another agent was actively editing during that documentation pass, so it was not
run then.

### Web bundle — frontend-level, from the packaged archive

`npm run desktop:web:package` → `desktop/release/web/quran-web-0.1.0/`, sizes
read off that directory on 2026-09-28 (gzip at level 9, i.e. what a
`Content-Encoding: gzip` response would cost — note `serveWeb.mjs` does **not**
compress, so on a LAN these bytes go out raw):

| Part | Files | Raw | Gzipped |
| --- | --- | --- | --- |
| Whole package (with server, scripts, README) | — | 30.56 MiB | — |
| `quran-web-0.1.0.zip` (what gets handed to a user) | — | 5.45 MiB | — |
| `dist/content/` — the 8 validated packs | 9 | 29.10 MiB | — |
| `dist/` shell (HTML, JS, CSS, icons, manifest, service worker) | 28 | 1.45 MiB | 1.01 MiB |
| — of which the main JS chunk (`index-*.js`) | 1 | 425.6 KiB | 127.8 KiB |
| — of which all JS | 12 | 598.7 KiB | — |
| — of which CSS (`index-*.css`) | 1 | 32.9 KiB | 6.4 KiB |

Two things worth reading off that table rather than away from it. The app is
**1.45 MiB of code and 29.1 MiB of content** — any download or disk budget is a
content budget, and the only realistic reduction is the per-word data
(`docs/content-packs.md`), exactly as the note at the bottom of this page said.
And the `tauriGateway` chunk (73.0 KiB raw) is still emitted into the web build
even though that shell can never be selected there; it is dead weight of one
dynamic import, not a forked engine.

| Figure | Command that produces it |
| --- | --- |
| Windows installer and unpacked app size | `npm run desktop:tauri build` (`tauri build`), output under `desktop/src-tauri/target/release/bundle/` — the installer this machine produced was 8,862,514 B |
| bundled content size | the payload table above; the bundle ships `content/` via `bundle.resources` in `desktop/src-tauri/tauri.conf.json:33` |

## Not measured — what must be taken before a release claim

Nothing below has a number anywhere in this repository. Writing one here would
be inventing it. The master prompt requires all four before any release note
says the app is fast or small; each row names who can take it.

| Measurement | Status | How it gets taken |
| --- | --- | --- |
| Cold start to first painted page (packaged Windows app) | **not measured** | `tauri build` a release bundle, time launch → page 1 rendered on this machine and one lower-spec machine |
| Working-set memory while reading, while importing, and at rest | **importing: measured (130.7 MB peak, see above)**. Reading and at rest: not measured | Task Manager / `Get-Counter` against the packaged process; the dev shell's numbers would be meaningless here |
| Database size after a full import | **measured: 28 MB** | as above — `%APPDATA%\app.quran.platform\quran.db` (`desktop/src/gateway/tauriGateway.ts:283`, from Rust `app_data_dir()` at `desktop/src-tauri/src/commands.rs:197-202`) |
| Interaction latency: page turn, search keystroke→results, session step grading | **not measured** | device-level runs in the packaged app; the engine-level costs above are the floor, not the experience |
| Android / mobile figures of any kind | **does not exist** | Flutter phase has not started; there is no APK to measure (see `docs/current-state.md`) |
| Web (localhost build) figures | **partly measured**: first-run content fetch spans 640 ms → 3,008 ms after navigation in the packaged build (see "The same import on the web target"). Cold start, memory and interaction latency in that build: **not measured** | Serve `release/web/…` with `node bin/serveWeb.mjs` and drive it over CDP, the way the desktop app was measured |
| Bundle size | **web: measured** (see "Bundle size"). Desktop `dist/` from `npm run desktop:build`: still to be taken without clobbering `desktop/src/db/` | as above |

Two honest observations that cost no measurement:

- The app's content is 29.1 MiB across 8 packs, 17.6 MiB of it in one pack, and
  it dwarfs the 1.45 MiB of code that displays it. Any packaging or download
  budget is a content budget, and the only realistic reduction is the per-word
  data (`docs/content-packs.md`).
- The engine is pure and synchronous over plain arrays with no I/O
  (`core/src/hifz/`, `core/src/mushaf/`), so the measured numbers above are the
  whole engine cost of those calls — there is no hidden async layer making it
  slower in the app, only the UI work around it.

## Related documents

`docs/mushaf-layout.md` (what the layout calls actually do), `docs/hifz-engine.md`
(the classify/plan/session semantics), `docs/content-packs.md` (pack contents
and licences), `docs/release.md` (build commands), `docs/testing.md` (the
level-labelling rule).
