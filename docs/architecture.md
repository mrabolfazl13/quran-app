# Architecture

## Shape

Three layers, one direction of dependency:

```
content packs (built offline, checksummed)
        ↓ imported once, then read-only
SQLite (Tauri: tauri-plugin-sql/sqlite · Flutter: sqflite)
        ↓ repositories
@quran/core  ← framework-free: contracts, normalisation, hifz engine,
               search, similarity, integrity, backup
        ↓ consumed by
desktop (React UI + Tauri shell)      mobile (Flutter UI, phase 2)
```

`@quran/core` holds every decision that must be identical on both platforms:
what counts as the same word, how an error is classified, how review priority
is computed. UI layers never implement engine logic; they render engine output.
The Dart port mirrors `core/src/contracts` and is validated against the same
fixtures, so a desktop and a phone recitation score identically.

## Content pipeline

`tools/content` is the only component allowed to touch the network, and only at
build time:

```
fetch   → data/raw/<provider>/<endpoint>.json  (never rewritten in place)
validate → integrity gate: 114 surahs, 6236 ayahs, contiguous verse keys,
           unique ids, no empty text, provider counts match, alignment proven
build    → content/<pack>/pack.json + payload.jsonl, sha256 checksum
import   → SQLite content tables (transactional; abort leaves DB untouched)
```

A pack whose checksum fails is never imported and never displayed.

## Persistence

One SQLite file per app install. Content tables are replaceable; user tables
are precious. Backup exports user tables only (`BackupEnvelope`, checksummed,
versioned, migratable). Restore validates the envelope before writing, and
writes inside a transaction.

## The storage seam (`desktop/src/gateway`)

`DataGateway` (`desktop/src/gateway/types.ts`) is the only boundary between the
UI and storage: ~60 typed methods, every row shape imported from `@quran/core`.
Two implementations satisfy it and nothing above the seam may know which one is
live:

- `TauriGateway` — `@tauri-apps/plugin-sql` (`Database.load('sqlite:quran.db')`)
  plus `invoke()` calls to the argument-validated commands in
  `desktop/src-tauri/src/commands.rs` (`app_paths`, `content_status`,
  `content_read_text`, `content_pack_stat`, `backup_write`, `backup_read`,
  `backup_list`, `sha256_text`).
- `DevGateway` — the same contract over an in-memory store, reading the same
  `content/` pack files over the dev server, so a browser window exercises the
  real import path. The UI announces it (`GatewayInfo.isShippedPath`).

**The Rust layer is deliberately thin.** It owns no SQL and holds no copy of the
schema: `desktop/src/db/schema.ts` applies `core/src/contracts/db.sql` — embedded
as `schema.generated.ts` by `scripts/syncSchema.mjs`, which is run by
`npm run build` and fails if the copy is stale. That choice is what keeps the
delivery order honest:

- the web shell needs the same schema applied to a browser SQLite (wasm-sqlite
  with FTS5 over OPFS), and it reuses `schema.ts` verbatim — no Rust in that path;
- the Flutter port reads the same `db.sql` text into `sqflite`;
- a Rust-owned data layer would have forked both.

`ensureSchema` applies statements one at a time, so a SQLite build without FTS5
degrades to the labelled `like` search backend instead of losing the schema, and
a database newer than the app's `SCHEMA_VERSION` is refused rather than
downgraded.

## Modules in `@quran/core`

`contracts` (types + `db.sql`) · `normalize` (the one definition of word
equality) · `integrity` (runtime corpus verification) · `search` · `mutashabihat`
· `hifz` (memory fingerprint, recall probes, error classification, stability,
scheduling, sessions) · `backup` (canonical JSON, checksum, migration chain,
hostile-file validation, transactional restore) · `mushaf` (604-page layout from
per-word page/line metadata, byte-exact rendering, layout validation).

Every engine number is deterministic: `nowIso` is a parameter, randomness is a
seeded `mulberry32`, rounding is fixed to `SCORE_DECIMALS`, and tie-breaks are
ordered — all so a Dart port reproduces the same digits.

## What is NOT in the architecture

No backend, no telemetry, no account, no runtime network call. No local AI model
in v1 — the measurement and the reasons are in
[local-ai.md](local-ai.md); `experiments/local-ai/` is isolated from the product
by its own `package.json` and is git-ignored for models and dependencies.

## Hifz engine

Pure functions over stored rows — no timers, no randomness without a seeded
generator, no clock reads (timestamps are passed in). That makes every
scenario reproducible in a test: given these attempts on these dates, the
scheduler must produce exactly this queue.

```
ayah text ──► segmentation ──► anchors ──► transitions
                                          │
recited words ──► normalisation ──► classify ──► attempt ──► stability
                                                     │
                              adaptive review queue ◄─┘
```

## Search

FTS5 over normalised Arabic plus each bundled translation, with the
normalisation shared from `core`. Root and concept search are separate indexes
built from packs, never guessed at query time. Which backend answered is part
of the result (`GatewayInfo.searchBackend`, `searchBackendNote()`), so a
reviewer always knows whether they are looking at FTS5 or the `like` fallback.
