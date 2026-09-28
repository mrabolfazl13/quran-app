# Current state

Updated 2026-09-28. Never record progress here that is not true of the tree.

## Phase

Desktop (delivery order step 1 of `AGENTS.md`) is feature-complete and verified
through the installed app: the Windows installer builds, installs, imports all 8
packs on a never-seen profile, and a backup it writes can be restored again
(that last round trip was broken until that round — see the defect table).
Web (step 2) now builds, packages and is verified on its own shipped path — a
staged bundle served by `bin/serveWeb.mjs` on a local port, with no Tauri:
content auto-imports, the user's rows live in IndexedDB, and the app keeps
working with the server process killed. Android is phase 2.

**One caveat about which binary is which.** The four fixes listed under "closed
this round" are in the working tree and in the web package on disk, which is the
build the web evidence below was produced from. The installed desktop app on
this machine is still `83cfc26`'s installer — it must be rebuilt before those
changes are claimed at desktop level.

## Completed

- **Content pipeline.** `tools/content` fetches from the verified public
  endpoints, validates every record, and emits 8 packs into `content/` (30 MB):
  `quran-core` 6350, `word-data` 83665, `tr-en-abdulhaleem` 6236,
  `tr-fa-islamhouse` 6236, `tr-fa-kaldari` 6236, `tafsir-ar-muyassar` 1013,
  `tafsir-en-ibnkathir` 300, `mutashabihat-ar` 1732. `npm run content:validate`
  is the integrity gate and passes.
- **Hifz memory engine** (`core/src/hifz`): segmentation, anchors, recall-mode
  suggestion as an ordered rule chain, error classifier, stability, adaptive
  review scheduling, confusion groups. Framework-free, fully unit-tested, and
  every number the UI shows comes out of it or out of stored rows.
- **Search and mutashabihat.** Deterministic Arabic-normalised index; the
  similar-ayah builder produced 1732 candidate rows over 1228 ayahs, imported as
  a pack rather than recomputed at runtime.
- **Mushaf page layout.** Page and line numbers ship in `word-data`, so a page
  is assembled from the provider's own line breaks and never re-flowed by font
  metrics.
- **Desktop app** (`desktop/`): 24 routes across قرآن / حفظ / کاوش / من, two
  gateway identities (`tauriGateway` over SQLite, `devGateway` over IndexedDB),
  backup + restore + settings layer, and the design system in `ui/` + `tokens.css`.
- **Local AI verdict.** Measured, then declined: no model ships. See
  [`local-ai.md`](local-ai.md).
- **Web target** (`npm run desktop:web:package` → `desktop/release/web/`). The
  same React app and the same `@quran/core`, served by a dependency-free Node
  server on a local port and packaged as one archive with a start script per
  platform. It persists in IndexedDB — the gateway was widened to a third shell
  rather than forked, so no engine logic is duplicated — and the packs it imports
  are the same validated bytes the desktop installer bundles.
  See [`packaging.md`](packaging.md).

## Verified earlier in this phase (UI gate, browser dev shell)

- **Hifz session end to end in the browser shell**: add range 1:1–1:7 → "7 آیه
  افزوده شد" → today's mission → launcher → 13-step session → answer a
  پاره‌خوانی step → "ثبت‌شده: 1", progress 8% → end session → report at
  `/hifz/session/<id>` with stored timings (زمان تلاش‌ها 3.5 ثانیه) and the
  engine's overall recall. No console errors.
- **First run**: store wiped from a same-origin non-app document, empty state
  and its import button both present, one click on «وارد کردن بسته‌های محتوا»
  cleared the empty state **2729 ms later without a reload**, and a real reload
  kept the content.
- **Geometry**: 24 routes at 1280×900 — no horizontal overflow, no element
  off-screen, no clipped text (the only remaining `overflow: hidden` hits are
  `caption.visually-hidden` screen-reader captions, which are hidden by design).
- **Bidi**: 301 numeric ranges across the app, 0 painted in reversed order.
- **Contrast**: 0 text nodes below WCAG AA across 14 routes × both themes. A
  control run (inject bad colours → 334 detections → remove → 0) proves the
  zero is a measurement, not a broken probe.
- **Keyboard**: 26 Tab stops on the reader, every one with a visible focus ring,
  sensible order, focus wraps.
- **Import**: all 8 packs applied in 2369 ms in that shell. The packaged app's
  number is the device-level one below — 8.0 s on first run, 7.6 s by the app's
  own report — and the two are not the same work.

## Verified this round (web target, packaged build served over HTTP)

`npm run desktop:web:package` → `desktop/release/web/quran-web-0.1.0/`
(32,045,739 B on disk) and `quran-web-0.1.0.zip` (5,712,903 B): `dist/`,
`bin/serveWeb.mjs`, `dev/contentMiddleware.mjs`, the 8 packs under
`dist/content`, and `start.cmd` / `start.command` / `start.sh` so the same
archive starts on Windows, macOS and Linux. Served by
`node bin/serveWeb.mjs` on `127.0.0.1:4173` and driven in headless Edge over
CDP — this is the packaged bundle, not `vite dev`.

- **Auto-import on the shipped path**: first `ready()` pulled all 8 packs from
  this origin and `/me/content` read 114 surahs / 6,236 ayahs / 83,665 words /
  18,708 translations / 1,313 tafsirs / 1,732 similar / 8 packs — the same
  numbers `content/index.json` carries, and the screen names the origin directory
  `/content` as where they came from. The app's own report for that import:
  **2,594 ms**; the content requests span 640 ms → 3,008 ms after navigation
  (see [`performance.md`](performance.md)).
- **Modes are now three, not two**: the shell reports `web` and the header badge
  says «وب»; `isShippedPath` is true for it, so no dev-only affordance leaks into
  a build a user can download. Forcing `?shell=dev` still gives the labelled dev
  shell.
- **Still works with the server dead**: with the service-worker cache warm,
  `serveWeb.mjs` was killed and the origin reloaded — a real navigation to a
  port with nothing listening. The shell came from cache, all 8 packs re-imported
  from cache with their checksums still verifying, the user's rows were intact, a
  Persian query («نماز») answered from `memory-index` with 50 verse keys on
  screen, and page 42 rendered. Cache inventory 24 entries (9 content / 8 assets
  / 7 shell); **0 network failures, 0 exceptions, 0 non-local requests**.
  Repeated after this round's `sw.js` change, on a freshly packaged bundle — the
  worker has no push message any more; the fetch handler fills the cache as it
  serves.
- **A restore survives the reload the restore itself triggers**: bookmark + dark
  theme + a daily plan restored through `/me/backup` were readable from
  IndexedDB *immediately* after the success message and again after the shell
  reloaded — 1 bookmark, same verse key, theme still dark.
- **Hostile input**: `/content/../../package.json` → 404, `POST /` → 405, an
  unknown route renders the app's own «چنین صفحه‌ای وجود ندارد» screen rather than
  a blank page, and every request observed in the session was same-origin.
- **UI gate on this target**: 11 routes at 1280×720 with no horizontal overflow
  and no 404 screen; dark mode reached through the header control (one click
  from `system`) — body contrast 13.2:1, `lang="fa" dir="rtl"` on every route,
  Arabic with full vocalisation on the mushaf page unclipped in both themes.
- **Repackaging while the app runs is refused by Windows, not by the script**:
  `packageWeb.mjs` clears its output directory first, and if
  `node bin/serveWeb.mjs` is still running from inside it the build dies with
  `EBUSY: resource busy or locked, rmdir …\quran-web-0.1.0`. Stop the server
  first; the failure is loud and nothing partial is left claiming to be a
  package.

## Verified last round (device-level, installed app, network left on)

Reinstalled `Quran Platform_0.1.0_x64-setup.exe` (8,862,514 B) over this
machine and drove the shipped window through WebView2 CDP on port 9777.

- **First run on a never-seen app-data directory**: empty state on `/` →
  «وارد کردن بسته‌های محتوا» → the write committed **8.0 s later** (2 s polling;
  the app's own report says 7,629 ms) and `/me/content` then read
  114 surahs / 6,236 ayahs / 83,665 words / 18,708 translations / 1,313 tafsirs
  / 1,732 similar / 8 packs — the same numbers `content/index.json` carries.
  Before this round the identical click took **164.1 s** with the UI blocked.
- **Where content came from**: `/me/content` names
  `C:\Users\Alex\AppData\Local\Quran Platform\content` (the bundled resources
  directory), database `…\app.quran.platform\quran.db`, backend `sqlite-fts5`.
  Not a `QURAN_CONTENT_DIR` or `tauri dev` fallback.
- **No network at runtime**: 1,404 requests recorded across a session with
  `Network.enable` on, **0 of them non-local** (every one `http://ipc.localhost`,
  i.e. Tauri command calls). The adapter was never disabled, so this is request
  evidence rather than a powered-off-network gate.
- **Backup → delete → restore, in the shipped app**: bookmark 1:5 → build
  envelope → «ذخیرهٔ فایل» →
  `…\app.quran.platform\backups\quran-backup-20260928-1149.quranbak` (1,141 B) →
  delete the bookmark (0 rows) → select the file → preview «جایگزینی دادهٔ فعلی
  با این فایل» → arm → «بازیابی کن» → **1 bookmark back, same id, same verse_key,
  same created_at**, content counts unchanged, no console errors or exceptions.
- **The file is what the format says it is**: read off disk, its keys are sorted
  (canonical), it has no trailing newline, and `dailyPlans[0]` is the decoded
  plan (`date`, `newAyahs`, `reviewItems`, `weakItems`, `confusionGroups`,
  `estimatedMinutes`, `generatedAt`) — not the `{date, payload, generatedAt}`
  storage row it used to be.
- **Hostile files still refused, app alive, DB untouched**: a truncated JSON file
  gets «این فایل JSON خوانا نیست…», a future-schema file with a bogus platform
  and a `tables` member gets «این فایل پذیرفته نشد — 4 ایراد؛ نخستین:
  $.producedBy.platform…»; `bookmark` count stayed 0 through both attempts.

## Defects closed this round (found on the packaged web build)

| # | Defect | Where |
| --- | --- | --- |
| 12 | The web build described itself as a dev shell: the content-health screen printed the "held in memory, no FTS5" note on a build a user downloads and runs, because the note was a single constant rather than a property of the shell | `MemorySearchService` constructor call in `gateway/devGateway.ts` |
| 13 | The recall session advertised «پخش صوت (بستهٔ صوتی نصب‌شده)» and offered a "I heard the audio" checkbox on a build where `content:validate` reports `صوت ۰` — a control for a feature no imported pack supports. The step now asks the gateway whether a track exists for that ayah and says so when none does | `screens/hifz/SessionRunnerScreen.tsx`, label in `screens/hifz/shared.tsx` |
| 14 | **A restore silently did not persist.** `importBackup()` ended in the same debounced `touch()` as an ordinary edit, and the backup screen reloads the shell as soon as a restore reports success — the 350 ms timer died with the page and the restored rows never reached IndexedDB. The success message was a lie. The save is now awaited and the timer cleared before it returns | `importBackup` in `gateway/devGateway.ts`, pinned by `tests/integration/dev-gateway-browser-restore.test.ts` |
| 15 | A backup written by a browser claimed `platform: "desktop"`, and the validator had no `web` value at all — so the honest file would have been refused by the enum while the dishonest one passed | `contracts/backup.ts`, `backup/export.ts`, `backup/validate.ts` (enum now `desktop \| mobile \| web`; unknown values still `bad-value`) |

Defect 14 is the one worth the emphasis: it was invisible in every earlier round
because the dev shell was reloaded by hand, minutes later, long after the timer
had fired. Reverting the fix makes the new test fail (1 failed / 2 passed);
restoring it makes the suite pass, so the test pins the defect rather than the
current code.

## Defects closed last round (found on the installed app, not in a test)

| # | Defect | Where |
| --- | --- | --- |
| 8 | Import died on the installed app with `(code: 5) database is locked`, its `ROLLBACK` reported `no transaction is active`, and a content table was left half-filled: `tauri-plugin-sql` checks out a pooled connection per call, so the app's own `Promise.all` of counts could put a read between the writer's `BEGIN` and its inserts. Every statement now goes through one queue | `gateway/tauriGateway.ts` (`enqueue`), pinned by `tauri-gateway-statement-queue.test.ts` |
| 9 | The app refused to restore **its own** backup: `checksum-mismatch` plus five `missing-field` errors on `$.data.dailyPlans[0]`. The gateway sealed `sha256(JSON.stringify(data))` while `core/src/backup/validate.ts` recomputes the digest over canonical JSON, and `dailyPlans` was exported as the storage wrapper instead of the decoded plan. Both gateways now seal through `buildEnvelope` and write through `serializeEnvelope`; `daily_plan` rows are decoded on export and re-encoded on restore | `gateway/tauriGateway.ts`, `gateway/devGateway.ts`, `BackupScreen.tsx` (the browser download used `JSON.stringify` too) |
| 10 | First content import cost **164.1 s of wall clock with the UI frozen** on the installed app: the queue makes every statement a round trip, and the write path issued one `execute()` per record (111,776 of them) | `gateway/batchInsert.ts` + `writePlan` in `tauriGateway.ts` |
| 11 | `ImportReport.durationMs` — the number the content-health screen quotes as "imported in X ms" — timed only verification and mapping, so it reported ~1.9 s for an import that took 164 s | `applyImport` in `tauriGateway.ts` |

Plus the earlier §47 crash fix, re-verified here: a malformed file cannot take
the preview screen down.

Pinned by `tests/integration/tauri-gateway-backup-roundtrip.test.ts` (export →
file bytes → validator → restore, over real SQLite) and
`tests/integration/tauri-gateway-statement-queue.test.ts` (chunked writes,
bound parameters byte-exact, one statement in flight).

## Defects closed earlier in this phase (UI gate, browser shell)

| # | Defect | Where |
| --- | --- | --- |
| 1 | Home kept saying "no content imported" after a successful import, because the empty state is derived from stats read at mount and nothing re-read them | `screens/home/HomeScreen.tsx` |
| 2 | En-dash ranges rendered reversed inside RTL paragraphs (U+2013 is bidi-neutral) across 13 sites | `NumRange` in `ui/primitives.tsx` + `dir="ltr"` on verse keys |
| 3 | Five primary link-buttons painted their label in their own background colour — invisible CTAs on onboarding and empty states | `.linkbtn:not(.btn)` in `ui/ui.css` |
| 4 | `--text-faint` sat at 2.99–3.2:1 and warn/gold tokens under AA | `styles/tokens.css` |
| 5 | The dev-shell notice became its own grid item inside `.hifz-columns` and stretched to a 467×691 empty panel | `ui/async.tsx` |
| 6 | Every stability/accuracy value was invisible: `.meter__label` hung outside a box with `overflow: hidden` that clipped it | `Meter` + `.meter__track` |
| 7 | The scheduler's English reason prose was shown raw in the Persian interface | `reviewReason`/`reviewFactorLabel` in `screens/hifz/shared.tsx` |

Plus the §47 crash closed earlier: malformed backup files can no longer take the
preview screen down (`screens/me/backupPreview.test.ts`).

## Blocked

- **Nothing that stops a desktop release.** The installer that used to be
  recorded here as unbuildable now builds and installs: every `tauri build` died
  inside the Windows FFI crates with `memory allocation of 1266720 bytes failed`
  (0xc0000409) until the low-memory profile in `src-tauri/Cargo.toml`
  (`lto = "thin"`, 16 codegen units, `opt-level = 0` for the FFI binding crates)
  plus `CARGO_BUILD_JOBS=1` were applied, and builds are started only when no
  test runner or browser is competing for the 8 GB. The produced
  `Quran Platform_0.1.0_x64-setup.exe` (8,862,514 B) was installed and exercised
  — see the two "Verified this round" sections and
  [`packaging.md`](packaging.md).
- **The E2E suite `docs/testing.md` describes does not exist.** There is no
  `tests/e2e/`. The shipped path has been exercised by driving the installed
  window over WebView2 CDP (scripts in `%TEMP%`, results recorded here), which
  proves the flows but is not repeatable by `npm run`. Writing that suite is the
  largest remaining gap between what the testing document promises and what the
  repository contains.
- **Offline gate is request-level, not cable-level.** This machine's adapter was
  never disabled; the evidence is 0 non-local requests out of 1,404 during an
  installed-app session. See [`testing.md`](testing.md).

## Tests

Run from the repository root (see [`testing.md`](testing.md)):

| Command | Result on 2026-09-28 |
| --- | --- |
| `npm run test:core` | 24 files, **516 passed / 2 skipped** (8.0 s) |
| `npm run test:desktop` | 5 files, **29 passed** (4.3 s) |
| `npm run test:integration` | 7 files, **86 passed** (37.0 s) — includes the new browser-restore suite |
| `cd desktop && npx tsc --noEmit` | clean |
| `npm run content:validate` | passes with 5 warnings (the Ibn Kathir empty rows `docs/tafsir-system.md` already explains) |

## Next tasks

1. Write `tests/e2e/` so the installed-app journey above is repeatable, and run
   it with the network genuinely off.
2. Localise the two gateway-prose strings that reach the Persian interface as
   English (`GatewayInfo.label` = "Tauri + SQLite (shipped path)", and the FTS5
   `searchBackendNote` sentence). The clean shape is a key + params from the
   gateway, translated by the screen — a contracts change, so it goes through the
   architect with every consumer updated in the same round.
3. Uninstall cleanliness: run the NSIS uninstaller and record what survives in
   `%LOCALAPPDATA%` and `%APPDATA%`.
4. Web target, what is genuinely left: the PWA **install** flow is unexercised
   (the manifest and service worker are shipped and offline-from-cache is proven,
   but no install prompt / standalone window has been driven), and
   `start.command` / `start.sh` have never run — only the Windows path has been
   executed on this machine. The service worker's unused `quran:cache-content`
   listener was deleted this round (packs reach the cache through its fetch
   handler, which is what the offline evidence shows), so the web package must be
   rebuilt before the shipped `sw.js` matches the tree.
5. Rebuild the desktop installer so the shipped `.exe` carries defects 12–15's
   fixes; the current install on this machine predates them.
6. Remove the now-dead Rust command `sha256_text` (`src-tauri/src/commands.rs`,
   registered in `lib.rs`): nothing calls it since backups seal through core.
   Least privilege (§47) says it should not stay registered.
7. Re-run `npm run content:build` + `stage:content` before any release build.
