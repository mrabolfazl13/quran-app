# Content packs

Everything the app displays as imported content comes from checksummed,
build-time content packs. This document describes the on-disk layout, the
checksum chain, the SQLite import path, the validation gate, and the actual
contents of the seven packs shipped in `content/` right now. Every number was
read off the files on disk; every behavioural claim names the code that
implements it.

Contracts live in `core/src/contracts/content-pack.ts`
(`ContentPackManifest`, `PackIndex`, `CONTENT_PACK_SCHEMA_VERSION = 1`).

## Pack layout

One directory per pack under `content/`, plus a root index:

```
content/
  index.json                  ← PackIndex: schemaVersion, builtAt, all manifests
  <pack-id>/
    pack.json                 ← ContentPackManifest (one pack)
    payload.jsonl             ← one JSON record per line, no wrapper object
```

- `index.json` is written last by the build
  (`tools/content/src/build.ts:383-384`); its `packs` array is literally the
  list of the per-pack manifests, so index and pack.json never diverge within a
  build. (Verified: the individual `content/*/pack.json` files on disk are
  byte-identical in content to their index entries.)
- `pack.json` carries the fields the app trusts: `id`, `kind`, `version`,
  `schemaVersion`, `language`, `title`, `source`, `license`, `attribution`,
  `checksum`, `payloadBytes`, `recordCount`, `coverage` (chapter list +
  `verseKeysFrom`/`verseKeysTo`), `generatedAt`, `generator`
  (`core/src/contracts/content-pack.ts`; manifest is assembled in
  `tools/content/src/build.ts:141-169`).
- `kind` is the contract union (quran-core, word-data, translation, tafsir,
  recitation, roots, linguistic, educational, concepts). **Not every declared
  kind ships** — see the table below and `concept-engine.md`.
- `license.status` is the three-value union
  `'clear' | 'attribution-required' | 'unresolved'`
  (`core/src/contracts/content-pack.ts`). Distinct values present in shipped
  packs: **only `unresolved` — all seven packs** (each `content/*/pack.json`
  `license.status`, confirmed by reading all seven). No shipped pack is
  `clear` or `attribution-required`; that is the honest licensing state, not a
  default left behind. The reason is recorded verbatim in every pack's
  `license.notes`: the Quran.com v4 `/resources` endpoints expose no license
  field and the Quran Foundation developer terms state that QF content "is not
  sold, sublicensed, or redistributed", so bundling in an installer needs
  written permission (see also `docs/content-sources.md`). The UI surfaces
  this as "Licence unresolved" with a `danger` tone
  (`desktop/src/screens/quran/lib.ts:86-95`) and the About screen refuses to
  quote a licence document it does not hold
  (`desktop/src/screens/me/AboutScreen.tsx:124`).

## How the sha256 is computed, and what happens on mismatch

**At build time.** The checksum is `sha256hex(Buffer.from(payload, 'utf8'))`
over the exact JSONL text bytes — Node's `crypto.createHash('sha256')`
(`tools/content/src/common.ts:41-43`, used at `tools/content/src/build.ts:151`
and `:162`). After writing, the build re-reads the just-written file and throws
`checksum drift for pack <dir>` / `byte-length drift for pack <dir>` if the
bytes or length moved (`tools/content/src/build.ts:370-381`). Writes go to
`payload.jsonl.tmp` then `renameSync`, so a half-written pack cannot exist on
disk.

**At import time, the digest is never computed by the code that consumes it.**
Both `PackSource` implementations return `{bytes, sha256}` for a file
(`desktop/src/content/packSource.ts:17-20`):

- Tauri (shipped path): the bytes **and** the digest come from the Rust
  commands `content_pack_stat` / `content_read_text`, so "the webview never
  computes a checksum it then trusts itself with"
  (`desktop/src/content/packSource.ts:57-81`, file header `:5-8`; Rust side
  `sha256_text`/`content_pack_stat` commands per `docs/architecture.md:53-57`).
- Browser dev shell: fetches the same files from `/content/…` via
  `dev/contentMiddleware.mjs` and hashes with WebCrypto
  (`desktop/src/content/packSource.ts:83-122`, `desktop/src/content/hash.ts:5-8`;
  header comment there states plainly that dev-shell hashing is "weaker proof
  than one computed by the native layer").

**On mismatch, nothing is imported and the message says so.** The verify-only
plan builder `buildImportPlan()` compares the computed payload digest against
`pack.json`'s `checksum`; a mismatch fails the whole pack with the text
`"checksum … does not match pack.json (…); nothing was imported."`
(`desktop/src/content/importer.ts:203-213`). The same gate re-checks
`payloadBytes` (`:215-221`), `recordCount` against actual JSONL line count
(`:229-235`), and record shape via `mapRecords` + `validatePlan` before any
plan is returned (`:237-250`; `desktop/src/content/records.ts:507-577`). A
failed pack yields `plan = null` and a `'failed'` status in the import report;
the DB is not touched for it. The post-build checker `validatePacks()` does the
same computation in Node (`tools/content/src/validate.ts:514-515`, plus the
word/mushaf checks at `:543-584`).

## Import into SQLite

Two-stage, and the split is deliberate:

1. **Plan (pure, no DB).** `buildImportPlan()` reads `index.json`, parses the
   payload JSONL, verifies checksum/bytes/counts/shape, and maps records to row
   tuples (`desktop/src/content/importer.ts:95-254`; mapping in
   `desktop/src/content/records.ts`).
2. **Apply (transactional).**
   - `TauriGateway.applyImport()` runs `BEGIN` → `DELETE FROM` every content
     table → `INSERT` all plan rows → `COMMIT`, with `ROLLBACK` on any error,
     on a serialized write queue (`desktop/src/gateway/tauriGateway.ts:361-382`;
     the content-table list — chapters, verses, ayah_word, translations,
     tafsir, and the concept tables — is `:230-244`).
   - `DevGateway.applyImport()` replaces the whole in-memory state object in
     one assignment (`desktop/src/gateway/devGateway.ts:252-263`).

**What an abort leaves behind: the previous database content, intact.** If
`buildImportPlan` fails, `applyImport` is never called (gating in
`desktop/src/gateway/tauriGateway.ts:353-359`). If the transaction itself
fails mid-way, the `ROLLBACK` restores the pre-DELETE state
(`:361-382`). This matches the promise in `docs/architecture.md:34-37`:
"import → SQLite content tables (transactional; abort leaves DB untouched)"
and "A pack whose checksum fails is never imported and never displayed." —
both verified against the code, not just the doc.

## The validation gate (`tools/content/src/validate.ts`)

`build.ts` refuses to emit packs unless `validateRaw()` passes
(non-zero exit; rules enumerated in the file header `:10-22`). Actual line
numbers for each rule the spec asks about:

| Rule | Where |
|---|---|
| Exactly 114 surahs | `validate.ts:59` (`SURAH_COUNT = 114`), checked `:117`, missing-id sweep `:130` |
| Exactly 6236 ayahs (uthmani bulk; simple edition too) | `validate.ts:60` (`AYAH_COUNT = 6236`), checked `:136` and `:179` |
| Surah ids unique, 1..114 complete | `:120`, `:130` |
| Verse ids and verse_keys unique | `:145`, `:153` |
| Contiguous verse numbering within each surah, chapter range 1..114 | `:163-166` |
| Non-empty text (surah names, uthmani, simple edition, translations) | `:122`, `:159`, `:183`, `:384` |
| `chapters.verses_count` == actual ayah count per surah (provider counts match) | `:170-171`, `:198-199` |
| Divisions: verse id cross-check and juz/hizb/page/rub ranges (30/60/604/240) | `:206-213` (`:55-58`) |
| Word data: word-token count vs text tokens; provider page/line present and in range | `:322-331`, `:269-283` (quirk exemptions 5:52, 11:13 at `:231-234`) |
| Mushaf metadata covers all 604 pages | `:351-352` |
| Translation alignment: positional match with off-by-N shift detection; BLOCKER on failure — "do not ship a guessed mapping" | `:394-418`, `detectShift` `:454` |
| Tafsir (when fetched): verse_key validity, empty-row counting, coverage warning | `:428-447` |
| Post-build: pack bytes byte-faithful to manifest (checksum, length, record count) and word page/line retained | `validatePacks()` `:475-584`, esp. `:514-515`, `:543-584` |

## Raw data rule

`data/raw/` is a build-time-only artefact and raw bytes are **never rewritten
in place**: fetch is resumable (`tools/content/src/fetch.ts`) and records
provenance (`url`, `sha256`, `bytes`, `fetchedAt`) per file in
`data/raw/manifest.json` (`tools/content/src/common.ts` provenance helpers);
`attribution.retrievedAt` in each pack traces back to the earliest `fetchedAt`
of its raw dependencies (`build.ts:171-179`, `earliestFetchedAt`). There is no
runtime fetching — the app makes zero network calls (`docs/architecture.md:26-28`, `:93`).

## Shipped packs (read from `content/` at the time of writing)

Seven packs. `index.json` `builtAt`: `2026-09-27T23:46:40.803Z`; every pack's
`generator`: `@quran/content/src/build.ts v0.1.0`; all have `source`
`https://api.quran.com/api/v4`, `version` `1.0.0`, `schemaVersion` 1 and
`license.status` `unresolved`. **All seven payload checksums were recomputed
with `sha256sum` and matched their `pack.json`.**

| id | kind | lang | source | licence status | records | payload bytes | sha256 (first 12) |
|---|---|---|---|---|---|---|---|
| `quran-core` | quran-core | ar | api.quran.com/api/v4 | unresolved | 6,350 | 3,927,429 | `49cb3b10f7e7` |
| `word-data` | word-data | ar | api.quran.com/api/v4 | unresolved | 83,665 | 18,463,718 | `8758734b3f42` |
| `tr-en-abdulhaleem` | translation | en | api.quran.com/api/v4 | unresolved | 6,236 | 1,157,373 | `133c6db7ab92` |
| `tr-fa-islamhouse` | translation | fa | api.quran.com/api/v4 | unresolved | 6,236 | 1,932,380 | `b958c471e3a6` |
| `tr-fa-kaldari` | translation | fa | api.quran.com/api/v4 | unresolved | 6,236 | 1,793,124 | `d0acc845cdc1` |
| `tafsir-ar-muyassar` | tafsir | ar | api.quran.com/api/v4 | unresolved | 1,013 | 472,505 | `8527ea69b585` |
| `tafsir-en-ibnkathir` | tafsir | en | api.quran.com/api/v4 | unresolved | 300 | 2,193,978 | `e0188ed27840` |

No pack of kind `recitation`, `roots`, `linguistic`, `educational` or
`concepts` exists under `content/` — the kinds are contract declarations, not
shipping promises.

### About the `word-data` pack specifically

`content/word-data/pack.json`
reads: title "Word-by-word Uthmani text with Madani mushaf page/line
placement, English glosses and transliteration", edition "Uthmani word
segmentation with char_type word/end", `recordCount` 83,665, `payloadBytes`
18,463,718, checksum `8758734b…` — and that checksum matches the payload on
disk (re-verified; `npm run content:validate` passes against these exact bytes).

**Every one of the 83,665 word records carries both mushaf columns**,
`pageNumber` (1..604) and `lineNumber` (1..15), copied value-for-value out of the
raw provider rows in `data/raw/quran-com/words-<chapter>.json`. That is what
makes the 604-page Madani grid rebuildable at runtime from shipped data alone:
`core/src/mushaf/layout.ts` needs nothing but this pack plus `quran-core`, and
`core/tests/mushaf/real-corpus.test.ts` asserts the pack-built grid *is* the
raw-built grid (`builds the mushaf grid from content/word-data rows`,
`places exactly what the provider rows place — subset chapters, row by row`, and
the full 604-page grid-signature comparison under `MUSHAF_FULL_CORPUS=1`).
`validatePacks()` proves it on disk — `word_data_mushafPages: 604`,
`word_data_mushafColumnErrors: 0` — via the per-row comparison at
`tools/content/src/validate.ts:543-584` and the coverage error at `:581-582`,
while `validateRaw()` requires an integer, in-grid page/line on every captured
row (`:266-294`) and fails if the rows do not cover all 604 pages (`:351-352`).

Nothing is defaulted when the metadata is missing: `tools/content/src/build.ts`
aborts (`mushafInt`), `desktop/src/content/records.ts` `mapWord` rejects the
record shape so such a pack is never imported, and `ayah_word.page_number` /
`line_number` are `NOT NULL` in `core/src/contracts/db.sql:86-101` (see
`docs/data-model.md`). The 56 verses whose word rows name a page other than their
own `ayah.page` are kept verbatim and surfaced only as a warning
(`validate.ts:357-363`); the layout engine anchors them on the ayah page and
reports each move as a `word-page-corrected` diagnostic rather than rewriting the
provider's data. If a later rebuild changes these numbers, the pack on disk plus
`index.json` remain the single source of truth; this section records the state at
write time, not a guarantee about the future.


## What is NOT here

- No runtime network fetching, ever; `tools/content` is the only network
  component and only at build time.
- No pack with a cleared licence; nothing may ship in an installer until
  written permission exists (`docs/content-sources.md`).
- No concept, roots, recitation or linguistic packs.
- No AI-generated pack content in v1 (`docs/local-ai.md`).
