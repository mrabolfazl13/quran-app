# Backup file format (`.quranbak`) — v1

Normative spec for the offline Quran platform's user-data backup files.
Implemented by `core/src/backup/**` (export, validate, migrate, restore,
settings). This file is the byte-level contract; the code and
`core/tests/backup/**` must never drift from each other.

## Scope — what a backup contains

A backup carries **only user-generated data**. Content tables (`content_pack`,
`surah`, `ayah`, `ayah_word`, `translation`, `tafsir`, `similar_ayah`,
`ayah_relation`, `concept`, `concept_ayah`, `concept_relation`, `audio_track`,
`ayah_search`) ship with the app, are validated by the integrity gate, and are
**never** read from or written to by the backup path. `buildEnvelope` drops any
such key with a warning; `applyRestore`'s write set is a fixed allowlist of
user tables; a file that smuggles content rows into `data` has those rows
ignored (and warned about) at inspection time.

Exported logical tables — exactly the 14 arrays plus the settings record of
`BackupUserData` (`core/src/contracts/backup.ts`):

| Backup key | Physical SQLite table(s) in `db.sql` |
| --- | --- |
| `settings` | `settings` (values serialised as TEXT, restored through the typed allowlist) |
| `bookmarks` | `bookmark` |
| `notes` | `note` |
| `readingPositions` | `reading_position` (`id` may be derived: `pos:<verseKey>`) |
| `readingHistory` | `reading_history` (`id` may be derived: `hist:<verseKey>:<readAt>`) |
| `hifzItems` | `hifz_item` (`sequence` JSON array) |
| `hifzSegments` | `hifz_segment` (`verseKey` required — a `position` only means something inside an ayah) |
| `anchorWords` | `anchor_word` (`verseKey` required — `wordPosition` restarts per ayah) |
| `hifzTransitions` | `hifz_transition` (`verseKey` required — the ayah the learner leaves; `toVerseKey` is where they arrive) |
| `recallAttempts` | `hifz_attempt` (`produced`, `cue`, `errors` canonical-JSON columns) |
| `confusionGroups` | `confusion_group` + `confusion_group_item` (flattened into the group's `verseKeys` array; array order = `position`) |
| `sessions` | `hifz_session` (`steps`, `report` canonical JSON) |
| `journeys` | `learning_journey` + `journey_progress` (flattened into `progress[]`) |
| `reflections` | `reflection` |
| `dailyPlans` | `daily_plan` (backup row = the decoded `DailyPlan` + `generatedAt`; the storage `payload` column never appears in a file, and restore writes the plan back into it) |

`user_profile` and `meta` are device-local and not exported.

## Byte-level encoding

- UTF-8, **no BOM**, **no trailing newline**, compact JSON (no insignificant
  whitespace outside string literals).
- Canonical serialisation rules (module `canonical-json.ts`):
  1. Object keys sorted by UTF-16 code unit (JS default sort) — recursively, at
     every depth, including inside embedded JSON columns.
  2. Array order preserved (arrays are ordered domain data).
  3. Numbers: JS shortest round-trip form (`String(n)`); `-0` emitted as `0`;
     NaN/Infinity/bigint/functions are rejected outright.
  4. `undefined` object members dropped; explicit `null` kept.
  5. Strings: standard JSON escaping (control characters use `\u00XX`).
- These rules make `canonicalJsonStringify(data)` byte-identical on Node, the
  Tauri webview and (phase 2) any conforming Dart/Flutter writer that
  implements the same rules. The round-trip test asserts this for real.

## Envelope

Top-level object with exactly these fields (sorted in the file):

```
schemaVersion     integer >= 1   — data format version (currently 1)
minReaderVersion  integer >= 1   — oldest reader that can safely consume it
createdAt         string         — ISO-8601 export instant; NOT covered by the checksum
producedBy        {app, version, platform:'desktop'|'mobile'}  — informational
checksum          string         — 64 lowercase hex; definition below
counts            {<15 keys>: integer} — must equal actual array lengths (settings: key count)
data              BackupUserData — the 14 arrays + settings record
```

### Checksum definition

```
checksum = sha256( UTF8( canonicalJsonStringify(data) ) )   — lowercase hex
```

The checksum covers **`data` only** — never `createdAt`, `producedBy` or
`counts`. Consequences:

- Two exports of identical user data at different instants have identical
  checksums and are comparable for equality.
- Disagreement between `counts` and the actual arrays is a separate,
  specifically reported defect (`counts-mismatch`), not a checksum failure.
- A single flipped character anywhere inside any row (test: inside a note
  body) changes the computed digest; validation reports `expected` (the file's
  claimed checksum) vs `computed` (what we derived).

`sha256` is implemented dependency-free in `core/src/backup/sha256.ts` and is
verified against `node:crypto` for multiple inputs (including UTF-8 heavy and
block-boundary lengths).

A writer seals through `buildEnvelope` and serialises through
`serializeEnvelope` — never with `JSON.stringify` plus a second hash call. A
digest over non-canonical bytes validates against neither rule, and that is how
the installed app ended up refusing the file it had just written
(`tests/integration/tauri-gateway-backup-roundtrip.test.ts`).

## Validation (`inspectEnvelope`)

Ordered gates: size guard (`MAX_BACKUP_BYTES`, default 20 MiB, configurable) →
BOM strip → JSON parse → envelope shape → version gates → checksum → row
validation → counts → cross-row reference integrity. **Nothing throws on bad
input; every hostile or corrupt file produces a failed `InspectionResult`**
(§47 of the master spec). Row-level rejects include:

- `accuracy` outside 0..1, or `correctWordCount > expectedWordCount`;
- `errors[].kind` outside the `ErrorKind` contract union (the union list is
  compile-checked against `contracts/hifz.ts` so it cannot drift silently);
- any `verseKey` not matching `^\d{1,3}:\d{1,4}$` with chapter 1..114
  (SQL-injection-shaped or Persian-digit keys fail here);
- a fingerprint row (`hifzSegments`/`anchorWords`/`hifzTransitions`) with **no
  ayah at all**. Its `position`, `wordPosition` or `toWord` restarts for every
  ayah an item spans, so a row without the ayah it numbers inside cannot be
  placed. Files exported before the field existed are *not* corrupt: their row
  ids always carried the ayah (`{itemId}:{verseKey}:{tag}{n}`), so
  `fingerprintVerseKey(row)` recovers it and the row restores with a warning.
  A row whose id says nothing is reported as `bad-value` corruption — restore
  then fails the NOT NULL column rather than guessing a surah;
- duplicate primary ids — within a table **and** across tables;
- dangling references: `hifzSegments`/`anchorWords`/`hifzTransitions`/
  `recallAttempts` whose `itemId` names no `hifzItems` row in the file. These
  abort restore by default. Only an explicit, user-confirmed
  `dropOrphans: true` removes them — each dropped row is reported, and the
  cleaned envelope is re-sealed (fresh `counts` + `checksum`), never silently
  edited. (`sessionId` on an attempt has no FK in `db.sql`; a missing session
  is a warning, not an error.)

## Migration chain (`migrate`)

- Ordered, integer-keyed steps in `MIGRATION_STEPS`; `validateChain()` asserts
  contiguity from v1 with +1 increments (test-enforced).
- v1 → v1 is identity. The shipped `v1ToV2` step
  (`migrations/v1-to-v2.ts`) is a documented no-op placeholder that keeps the
  chain genuinely exercised; `opts.toVersion` (tests/planning only) walks it.
- Every applied step's output is re-sealed (`counts` + `checksum` recomputed).
- **Downgrade fails closed**: `file.schemaVersion > BACKUP_SCHEMA_VERSION` is
  a hard refusal at both validation (`future-schema-version`) and migration.
- To extend: add `migrations/vN-to-vN+1.ts`, register it, and have the
  orchestrator bump `BACKUP_SCHEMA_VERSION` in the same round.
- **The two version numbers are different lines.** SQLite's
  `SCHEMA_VERSION` (`desktop/src/db/schema.ts`) went 2 → 3 when the fingerprint
  tables grew their `verse_key` column; `BACKUP_SCHEMA_VERSION` stayed 1. A
  version-1 file was always *semantically* carrying the ayah — inside each row's
  id — so the exporter needed no new field and no old file became unreadable.
  A schema migration in the app is not a format change in the file.

## Restore (`planRestore` / `applyRestore`)

`planRestore(env, currentCounts)` describes: per physical table rows to insert
and rows to replace, orphaned rows inside the file, and settings keys the
allowlist rejects — without touching anything.

`applyRestore(db, env, opts)` — the DB layer is injected (`RestoreDatabase`:
`exec`/`prepare`, sync or async), so `node:sqlite` (tests/desktop-node) and
Tauri's async plugin-sql both drive it. It:

1. re-serialises the envelope canonically and re-runs **full validation
   including the checksum** — the caller is never trusted;
2. filters `settings` through the typed allowlist (`settings.ts`);
3. `PRAGMA foreign_keys = ON`, `BEGIN`, deletes only the 17 physical user
   tables, inserts the envelope rows with prepared statements, re-reads
   `COUNT(*)` per table inside the transaction and compares with expectations;
4. commits only when counts match; any failure → `ROLLBACK`, previous DB
   intact (asserted by tests, including a mid-write injected failure).

Restore is replace-all for the user tables it writes; content and `meta`
are structurally outside its write set.

## Settings allowlist

`core/src/backup/settings.ts` declares every acceptable key with type,
default and range: theme, interfaceLanguage (fa/en), translationPack,
readingMode (mushaf/ayah), fontScale/quranFontScale, hifz session defaults
(newItemTarget, reviewCap, defaultMode, autoAudio). Unknown keys from any
backup are dropped and reported; stringly-typed DB values are coerced back to
declared types; control characters, oversized strings and out-of-range
numbers are rejected. This is what makes "restore a file from another device"
safe against config injection.

## Threat model — what a hostile `.quranbak` can and cannot do

It **cannot**:

- alter Quran text or any content table (content keys are refused on export
  and ignored on restore; the restore write set is a fixed allowlist);
- execute SQL beyond data parameters (all writes are parameterised prepared
  statements; verse keys/ids are strings bound as values; injection-shaped
  values are rejected by row validation before any write);
- corrupt the DB half-way (single transaction, count-verified, full rollback);
- crash or hang the app by malformation (nothing throws on bad input; parse is
  size-capped before any work);
- inject settings (allowlist + coercion + rejection report);
- survive a tampered byte (any single-character change breaks the checksum
  with expected-vs-computed reported);
- silently delete data (orphan dropping is explicit, user-confirmed, and every
  dropped row is listed);
- forge a future format (newer `schemaVersion`/`minReaderVersion` than the app
  is refused, fail-closed, on both validation and migration);
- pollute JS object prototypes (parsed envelope is treated as inert data;
  values are only ever read by known-key accessors).

It **can** (bounded by design, not by validation):

- replace the user's current bookmarks/notes/hifz history with the file's
  content — that is the product feature; mitigated by the plan dialog showing
  replace counts and provenance (`producedBy`, `createdAt`) before applying;
- carry very large arrays (size cap 20 MiB keeps worst-case parse/insert
  memory and time bounded for this app's data shape);
- carry semantically odd but valid rows (e.g. accuracy 0 attempts) — they are
  stored as data, never trusted for engine state: stability bands are
  recomputed from attempts by the hifz engine anyway.

## File naming

`BACKUP_FILE_EXTENSION = 'quranbak'`. Suggested default name:
`quran-backup-<YYYY-MM-DD>.quranbak`.
