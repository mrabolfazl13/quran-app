# Changelog

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

### Known constraints

- No audio bundled: licences unresolved, so the feature is absent rather than
  present-and-infringing.
- Concept engine has no source data yet; relationships shown are computed and
  labelled as such.
- Flutter/Android not started (phase 2). The contracts and engine are written
  framework-free so the Dart port mirrors them instead of reimplementing them.
- This machine's clock is unsynchronised; timestamps in packs and backups come
  from it and are accurate to hours, not seconds.
