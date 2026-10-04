# Changelog

## 0.1.0 — Released 2026-10-04

First public release of the Quran learning platform with dual-axis hifz engine,
modern glassmorphism UI, and cross-platform support (Windows desktop + Web PWA).

### Core Features

- **Dual-axis hifz engine**: Track both form (Arabic text) and meaning (translation) for comprehensive memorization
- **Mushaf page layout engine**: Byte-exact rendering of all 604 pages from shipped word-data pack
- **Deterministic recall scoring**: Error classification using Needleman-Wunsch algorithm with 15 recall modes
- **Mutashabihat detection**: 1,732 similar ayah pairs identified with 110x comparison space reduction
- **FTS5 search**: Full-text search in Arabic, Persian, and English with token normalization
- **Backup/restore**: Versioned envelope format with canonical JSON checksums and migration support

### Platform Support

- ✅ **Windows desktop**: 8.47 MB NSIS installer with WebView2 runtime
- ✅ **Web PWA**: Offline-first with auto-import of 8 content packs, service worker caching
- 🚧 **Android Flutter**: Skeleton app built successfully (APK available), core integration pending

### Content Packs (8 packs, ~30 MB)

All packs include SHA256 checksums and provenance metadata:

- `quran-core`: 6,350 records (surahs, ayahs, words)
- `word-data`: 83,665 words with mushaf grid (page/line positioning)
- `tr-fa-islamhouse`: 6,236 Persian translations
- `tr-fa-kaldari`: 6,236 Persian translations
- `tr-en-abdulhaleem`: 6,236 English translations
- `tafsir-ar-muyassar`: 1,013 Arabic tafsir passages
- `tafsir-en-ibnkathir`: 300 English tafsir passages
- `mutashabihat-ar`: 1,732 similar ayah pairs

**Note**: All packs have "unresolved" license status pending written permission from Quran Foundation.

### Verified Through Shipped Path

- ✅ 584 core unit tests passing (26 files)
- ✅ 262 integration tests passing (17 files)
- ✅ 36 E2E web journey tests passing (0 failures, 4 skips)
- ✅ Install → import 8 packs → backup → restore round-trip verified
- ✅ Zero network requests during runtime (fully offline operation)
- ✅ Responsive layout: 66 screens measured across 360px/768px/1440px with zero overflow

### Bug Fixes Since Development

- Fixed database lock contention during batch imports (Statement Queue pattern)
- Fixed backup restore claiming success but losing data (envelope sealing)
- Reduced import time from 164s to 7.6s (batch insert with chunking)
- Fixed gateway writing English sentences into Persian interface (localised messages)
- Fixed web build persist failure (await save before return)
- Fixed hifz fingerprint rows missing verse_key attribution (schema v3 migration)

### Known Issues

- Content pack licenses unresolved (requires Quran Foundation written permission)
- Audio not bundled (license issue, no audio packs included)
- Mobile app skeleton only (Flutter started, @quran/core integration pending)
- PWA install prompt not exercised (manifest and service worker shipped)

### Technical Stack

- **Core**: TypeScript, Vitest (no framework dependencies)
- **Desktop**: Tauri v2, React 18, Vite, SQLite via tauri-plugin-sql
- **Web**: Same React codebase, IndexedDB persistence, Node.js dev server
- **Mobile**: Flutter + Dart (phase 2)
- **Build**: npm workspaces, Rust cargo (low-memory profile: lto="thin", opt-level=0 for FFI)

---

## 0.1.0 — in progress

Started from an empty repository. Nothing in this list is claimed until the
matching test or command has actually been run.

### Added

- Operating rules and file ownership for parallel agents (`AGENTS.md`).
- Shared contracts: Quran domain (`core/src/contracts/quran.ts`), Hifz memory
  engine (`hifz.ts`), content packs (`content-pack.ts`), backup envelope
  (`backup.ts`), SQLite schema v1 (`db.sql`).
- Arabic normalisation layer (`core/src/normalize/arabic.ts`) — one definition
  of "same word" for search, similarity, recall scoring and integrity. 21 unit
  tests.
- Runtime integrity verifier (`core/src/integrity/verify.ts`): counts, verse-key
  uniqueness and contiguity, division ranges, blank text, stored-vs-recomputed
  word counts and fingerprints, pack-vs-database text drift, page monotonicity.
  Whole-mushaf and partial-scope modes. 16 unit tests.
- Shared test fixture (`tests/fixtures/corpus-sample.json`): 31 real ayahs from
  the captured provider responses, including the ar-Rahman / al-Mursalat /
  ash-Shu'ara refrains, so every module is tested against identical real text.
  6 unit tests, including the NFC-vs-provider mark-order guard.
- Content pipeline (`tools/content`): raw fetch with provenance manifest,
  integrity gate, checksummed pack builder.
- Hifz engine (`core/src/hifz`), search index and mutashabihat engine
  (`core/src/search`, `core/src/mutashabihat`).
- Desktop app (`desktop`): Tauri v2 shell, SQLite gateway, pack importer, design
  system with Arabic/Persian typography and RTL default, reader and hifz screens.
- Docs: architecture, product spec, data model, testing, privacy, packaging,
  performance, mushaf layout.
- Statement queue in `TauriGateway`: every statement (reads included) goes
  through one lane, so the plugin keeps a single SQLite connection and a manual
  `BEGIN … COMMIT` becomes a real transaction again.
- Chunked bulk writes (`desktop/src/gateway/batchInsert.ts`): multi-row
  `INSERT … VALUES (?,?,…),(?,?,…)` under a 900-bound-parameter ceiling, values
  staying bound so revealed text never passes through an escaping step.
- `tests/integration/tauri-gateway-statement-queue.test.ts` and
  `tests/integration/tauri-gateway-backup-roundtrip.test.ts` — real SQLite
  behind a fake `@tauri-apps/plugin-sql`, one statement in flight, chunk count
  and byte-exact parameters pinned, and "what the app exports the app must
  accept" pinned over the whole envelope.
- Root scripts: `test:core`, `test:desktop`, `test:integration`, `desktop:web`,
  `desktop:web:package`.
- Web target (delivery order step 2): `desktop/scripts/serveWeb.mjs` — a
  dependency-free HTTP server that binds `127.0.0.1`, answers GET/HEAD only, and
  refuses any path that resolves outside its own directory;
  `desktop/scripts/packageWeb.mjs`, which stages the built bundle, the server,
  the 8 packs and a `start.cmd` / `start.command` / `start.sh` into one archive
  and sanity-imports the server it just packaged; `public/manifest.webmanifest`,
  icons and `public/sw.js` (navigations network-first, hashed assets and content
  cache-first) so the installed-by-nothing build keeps working with the server
  dead.
- A third gateway shell — `web` — in `desktop/src/gateway/index.ts`. It is the
  same `DevGateway` class over the same IndexedDB persistence, now reporting
  itself honestly (`isShippedPath: true`, `platform: 'web'` in every backup it
  writes) instead of wearing the dev shell's label. No engine logic forked.
- `tests/integration/dev-gateway-browser-restore.test.ts`: a restore's rows must
  be visible to a *second* gateway instance the moment `importBackup()` resolves,
  over a fake IndexedDB whose timers are recorded and never run, plus the
  provenance each shell owes a reader.
- `BackupEnvelope.producedBy.platform` accepts `web`; the validator's enum
  widened with it, and a value the contract does not know is still refused as
  `bad-value`. 2 new core tests.

### Fixed

Four shipped-path defects, each found by using the installed app rather than
building it (device-level evidence in `docs/current-state.md`):

- The app refused to restore **its own** backup file: `checksum-mismatch` plus
  five `missing-field` errors on `$.data.dailyPlans[0]`. The gateways sealed
  `sha256(JSON.stringify(data))` while `core/src/backup/validate.ts` recomputes
  the digest over canonical JSON, and daily plans were exported as the storage
  row `{date, payload, generatedAt}` instead of the decoded plan the validator
  reads. Export now goes through `buildEnvelope`, files through
  `serializeEnvelope` (including the browser "download file" path), and restore
  re-encodes the plan into `daily_plan.payload`.
- First content import took **164.1 s with the UI frozen** on the installed app.
  Serialising the statement queue makes each statement one Tauri round trip, and
  the write path issued one `execute()` per record — 111,776 of them. Batched
  into chunked statements: **10.4 s** measured at 2 s resolution on the first
  build after the fix, **8.0 s** (app's own report: 7,629 ms) on a later
  never-seen profile, **7.33 s** for a full re-import at 200 ms resolution, with
  byte-identical row counts.
- `ImportReport.durationMs` — the figure `/me/content` quotes as "imported in X
  ms" — timed verification and mapping only, so it printed ~1,900 ms for the
  164-second import. `applyImport` adds the write time before storing the report.
- Import died with `(code: 5) database is locked`, `ROLLBACK` reporting `no
  transaction is active` and a half-filled content table, because the app's own
  `Promise.all` of counts could interleave a read between the writer's `BEGIN`
  and its inserts on a second pooled connection.

Four more, found on the packaged web build rather than in a test:

- **A restore did not persist.** `DevGateway.importBackup()` ended in the same
  350 ms-debounced `touch()` as any other edit, and the backup screen reloads the
  shell as soon as a restore reports success — the pending timer died with the
  page and the restored rows never reached IndexedDB. The user saw "بازیابی شد"
  and an unchanged app. The save is now awaited and the timer cleared before the
  method returns; the new integration test fails when the fix is reverted.
- The web build described itself as a dev shell on `/me/content`, printing the
  "held in memory, no FTS5" note on a bundle a user downloads and runs. The note
  is now a property of the shell that serves it.
- The recall session advertised «پخش صوت (بستهٔ صوتی نصب‌شده)» and offered an
  "I heard the audio" checkbox while `content:validate` reports `صوت ۰` — a
  control for a feature nothing in the build supports. The step now asks the
  gateway whether a track exists for that ayah and, when none does, says so and
  offers the same step without sound.
- A backup written by a browser reported `platform: "desktop"`. The contract had
  no `web` value, so honesty would have been rejected by the validator; the enum
  was widened and the two shells now report `quran-web` / `quran-dev-shell` over
  a platform they actually run on.

Seven UI-gate defects found by exercising the app rather than building it:

- Home left the "no content imported" empty state on screen after a successful
  import: the state is derived from stats read at mount, and the import never
  re-read them. Verified first-run — one click clears it in 2729 ms, no reload.
- Numeric ranges with an en dash painted in reversed order inside RTL
  paragraphs (U+2013 is bidi-neutral, so the paragraph direction wins). Added
  `NumRange` (`ui/primitives.tsx`) and `dir="ltr"` on verse keys across 13
  sites. Sweep: 301 ranges, 0 reversed.
- Five primary link-buttons rendered their label in their own background
  colour, because `.linkbtn` is declared after `.btn--primary` at equal
  specificity. Now only a plain link takes the accent
  (`.linkbtn:not(.btn)`).
- Secondary text failed contrast systemically: `--text-faint` measured
  2.99–3.2:1 and warn/gold tokens sat under AA on their own chips. Re-tokenised
  in `styles/tokens.css`; audit now reports 0 sub-AA text nodes over 14 routes
  × 2 themes, with an injected-violation control run to prove the probe works.
- The dev-shell notice was a fragment child of `.hifz-columns`, so the grid
  gave it its own column and stretched it to a 467×691 empty amber panel. It is
  wrapped with its section now.
- Stability and accuracy values were invisible: `.meter__label` was positioned
  outside a box that had `overflow: hidden` to round the fill, which clipped
  the label. `Meter` is now a track plus an in-flow label.
- The review scheduler's reason prose (English, from `factorSummaries`) was
  shown verbatim in the Persian interface. `reviewReason` translates the known
  summary shapes and leaves the engine's numbers untouched; an unrecognised
  fragment still passes through rather than disappearing. 5 unit tests.

Two more, both about what crosses the language boundary:

- **The gateway wrote finished English sentences into a Persian interface**
  (defect 16). `/me/content`, `/me/about`, the header shell chip, the search note
  and `async.tsx` all rendered strings the gateway had already composed —
  `"Tauri + SQLite (shipped path)"`, `"browser IndexedDB + memory-held content"`,
  `"memory index (dev shell — no FTS5)"`. The gateway cannot translate, so it no
  longer writes prose: `GatewayInfo` carries `labelId`, `storeId` and
  `SearchNoteId` union types, `database` became `databasePath` (a path is data,
  a sentence about a path is not), and one place — `desktop/src/ui/gatewayText.ts`
  — turns ids into wording through exhaustive switches with no `default`, so a
  new id is a compile error until it is answered in both languages. The ids are
  shared by all three shells, so the web build can no longer describe itself as a
  dev shell even by accident. 4 unit tests pin that every id has Persian *and*
  English wording, that the two differ, and that a shell's wording never names
  another shell. Verified on the packaged web bundle in Persian mode: 0 English
  leaks over `/me/content`, `/me/about` and `/discover`, screenshot in dark RTL
  with 0 overflow.
- `sha256_text` was a Tauri command that hashed any string handed to it from the
  frontend. Nothing called it after the backup work moved into `@quran/core`, so
  it was deleted rather than left as a general-purpose hash oracle — AGENTS.md
  §47 asks for least privilege over command lists. `content_pack_stat` covers the
  one place a digest is still needed at the shell level.

A stored-row defect in the hifz fingerprint (defect 17, tracked as task #34):

- **A two-ayah memorisation target kept one chunk per position, not one per
  ayah.** `hifz_segment.position`, `anchor_word.word_position` and
  `hifz_transition.to_word` all count from the start of the **ayah** they sit in,
  but the UNIQUE keys started at `item_id`, so `112:1` segment 0 and `112:2`
  segment 0 were the same row as far as SQLite was concerned. The enrolment path
  either dropped the second ayah's chunk or offset its number to dodge the
  constraint — and an offset row describes a chunk the engine will never ask
  about again, so the per-segment stability it carries is decoration.
- Schema **v3** adds the NOT NULL `verse_key` these rows always carried inside
  their own id (`{itemId}:{verseKey}:{tag}{n}`), and re-keys the three tables by
  `(item_id, verse_key, …)`. Every consumer moved in the same round: the
  contracts, the gateway writes and reads (`VERSE_KEY_ORDER_SQL`, because
  `verse_key` is TEXT and plain text order sorts `2:10` between `2:1` and `2:2`),
  the e2e witnesses, and the backup reader — which now validates, recovers and
  writes the ayah through `fingerprintVerseKey`, so a file exported before the
  column exists still restores (warning, not failure) while a row whose id says
  nothing is refused instead of guessing a surah.
- The migration is a real rebuild, not a default: `CREATE t__v3` → batched copy →
  `DROP` → `RENAME`, foreign keys off before `BEGIN` and back on in `finally`,
  `PRAGMA foreign_key_check` as the commit gate. An unplaceable row throws during
  **derivation**, before any DDL, so a file that cannot migrate is left exactly as
  it was and still opens at version 2. Positions are carried over byte-for-byte —
  this step adds the ayah, it does not renumber the chunks. `BACKUP_SCHEMA_VERSION`
  stays 1: the format was always semantically carrying the ayah in the row id.
- 10 new integration tests (`tests/integration/hifz-schema-v2-to-v3.test.ts`)
  over a real v2-shaped database: rows placed by the ayah their id names, the
  inter-ayah transition included, both UNIQUE shapes (same position in two ayat
  accepted, in one ayah refused), CHECKs and cascades surviving the rebuild, and
  the abort-leaves-nothing-written case with its retry. The v1→v2 file now doubles
  as the proof that a v1 file composes both steps in one open.

- Two of the integration lane's whole-mushaf suites failed intermittently at
  vitest's default 5 s budget while queued behind 15 other files of real SQLite.
  They now carry a documented 60 s allowance (`MUSHAF_TIMEOUT`, `QUEUE_TIMEOUT`);
  measured on an idle machine those bodies run 0.5–1.6 s, so the budget is a
  scheduler concession and not a performance claim. Proved honest by re-running
  the file with `--testTimeout=1`: the suite that carries the allowance still
  passes, the 31-ayah suite that deliberately does not still fails (`docs/testing.md`).

Verification code was wrong twice this round, in the direction of looking
successful:

- **The web journey judged a stale bundle** (defect 18). `desktop/dist` predated
  the schema v3 work, so the run reported device-level results about code that
  was not in the binary — red when the old bundle disagreed, and it would equally
  have been green when the old bundle agreed. `assertBundleFresh`
  (`tests/e2e/lib/launch.mjs`) now compares `dist/index.html` against every
  `.ts/.tsx/.css/.sql` under `desktop/src` and `core/src` and refuses the run
  before a server starts, naming the file and the rebuild command.
- **A crashed runner exited 0** (defect 19). Its `catch` wrote a `NOTE`, so the
  report read `PASS 1 · FAIL 0 · NOTE 2` and the process succeeded for a journey
  that verified nothing. `Suite.fail` (`tests/e2e/lib/harness.mjs`) makes the
  harness's own breakage a result; the stale-bundle refusal now exits 1 with a
  FAIL row naming the reason. Both behaviours pinned by
  `tests/integration/e2e-witness.test.ts` (8 tests).

### Known constraints

- No audio bundled: licences unresolved, so the feature is absent rather than
  present-and-infringing.
- Concept engine has no source data yet; relationships shown are computed and
  labelled as such.
- Flutter/Android not started (phase 2). The contracts and engine are written
  framework-free so the Dart port mirrors them instead of reimplementing them.
- This machine's clock is unsynchronised; timestamps in packs and backups come
  from it and are accurate to hours, not seconds.
