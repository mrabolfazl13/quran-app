# Data model

Authoritative DDL: `core/src/contracts/db.sql`. This document records the
decisions behind it, not a copy of it.

## Identity

- `verse_key` (`"112:1"`) is the primary key of an ayah and the foreign key
  everywhere else. It is human-readable, stable across providers, and survives a
  re-import.
- Provider row ids are stored as `source_id`, informational only. They are never
  referenced, because a different pack would renumber them.
- Surah identity is its number 1..114; page identity its number 1..604; juz
  1..30; hizb 1..60. All from the Madani mushaf layout the packs carry.
- User rows get text uuids, never autoincrement integers, so two devices can
  merge or restore without key collision.
- **No array index is ever an id.** Translation bulk responses are ordered
  arrays without keys; they are joined to ayahs only after alignment is proven
  by the pipeline, never by position at read time.

## Two kinds of tables, different survival rules

Content tables (`surah`, `ayah`, `ayah_word`, `translation`, `tafsir`,
`similar_ayah`, `concept*`, `audio_track`) are derived data: they are dropped
and rebuilt when a pack is reimported, and the importer runs one transaction
per pack so a checksum failure leaves the previous state intact.

User tables (`bookmark`, `note`, `reading_*`, `hifz_*`, `confusion_group*`,
`learning_journey*`, `daily_plan`, `reflection`, `settings`, `user_profile`) are
the only things a backup contains and the only things a reimport may never touch.
`hifz_attempt` is the most precious of these: it is append-only history, the
source of every stability number in the app. Deleting it silently rewrites the
user's memory as never having happened.

## Referential integrity

`ayah.chapter` → `surah.number`, `ayah_word.verse_key` → `ayah`,
`ayah_word.(verse_key, position)` unique (`ayah_word_pos_idx` — position, not
array order, is a word's id inside a verse),
`translation.(verse_key, pack_id)` composite primary key, `hifz_segment.item_id`
→ `hifz_item` with `ON DELETE CASCADE` (dropping a memorisation target drops its
derived segments and anchors) while `hifz_attempt.item_id` also cascades — so
dropping an item destroys its history. That is deliberate but destructive, and
the UI must confirm it explicitly rather than treat it as a toggle.

## Enum discipline

Statuses are CHECK-constrained strings, not integers: bands
(`new|unstable|weak|stable|mastered`), item status
(`active|paused|graduated|dropped`), relation types
(`explicit|textual|linguistic|thematic|educational|editorial`) on
`ayah_relation.type`, `concept.relation_type` and `concept_ayah.type`, licence
status (`clear|attribution-required|unresolved`) on `content_pack` and
`audio_track`, anchor role, transition kind, confusion origin, revelation
place, and the 15 `RecallMode` values on `hifz_attempt.mode`. Each of these was
verified by writing a bad value into a real in-memory SQLite database built
from `core/src/contracts/db.sql` and watching it get rejected, and a good value
get accepted.

Error kinds are the exception: they live inside `hifz_attempt.errors` as JSON,
so no CHECK can reach them. They are validated in code
(`core/src/contracts/hifz.ts`, enforced on write by the desktop engine facade).
`unresolved` rows are imported but must be hidden from reading surfaces until
licensing is confirmed.

## Derived columns

`ayah.word_count` and `ayah.normalized_hash` are computed by the pipeline from
the authoritative text via `core/src/normalize/arabic.ts` and are what integrity
checks recompute against at import. `text_uthmani` itself is never normalised,
trimmed or rejoined — the stored string is byte-identical to the pack payload.

## Mushaf placement on `ayah_word`

`ayah_word.page_number` (1..604) and `ayah_word.line_number` (1..15) are **not
derived columns**: they are provider metadata copied verbatim out of the
`word-data` pack (`content/word-data/payload.jsonl`, `pageNumber`/`lineNumber`,
sourced from Quran.com v4 word rows) into
`desktop/src/content/records.ts` → `tauriGateway`'s `ayah_word` INSERT, and into
the `AyahWord` contract (`core/src/contracts/quran.ts`) as required fields.

They exist because the offline reader has no other per-word placement:
`core/src/mushaf/layout.ts` rebuilds the whole Madani grid from these two columns
plus `ayah.page` as anchor, and `ayah_word_page_idx ON ayah_word(page_number,
line_number)` serves "which words are on page N". A pack without them cannot
render a page at runtime.

Both columns are `NOT NULL`, and nothing defaults them:

- `tools/content/src/fetch.ts` treats a capture whose word rows lack an in-range
  `page_number`/`line_number` as unusable (refetch), `build.ts` fails the build
  (`mushafInt`), and `validate.ts` fails if the packed rows disagree with the raw
  rows value-for-value or if the pack does not cover all 604 pages.
- `desktop/src/content/records.ts:mapWord` rejects a record with a missing,
  non-integer or out-of-range page/line as a record-shape error, so the pack is
  not imported.
- Test fixtures that only exercise verse metadata carry a placement table read
  off the real captures (`core/tests/hifz/fixtures.ts`,
  `core/tests/search/fixtures.ts`) and throw for a verse they do not know,
  rather than guessing page 1.

Range checking lives in the importer and the validator, not in a SQL `CHECK`,
because the same DDL backs hand-fed fixture databases; the layout engine itself
still accepts degraded rows (`LayoutWord` in `core/src/mushaf/layout.ts`), which
is a test-facing escape hatch, not a supported shipped state.

`ayah_word.page_number` is not foreign-keyed to anything: it is cross-checked
against `ayah.page` by the engine at build time. The shipped data disagrees on 56
verses (their word rows name a different page than their division page); the
engine keeps the provider values untouched and reports it as
`word-page-corrected`, moving 361 tokens onto the anchor page. `docs/mushaf-layout.md`
does not exist, so the grid rules are documented in the module headers
(`core/src/mushaf/*.ts`) and tested in `core/tests/mushaf/`.

Schema version stays **1**: v1 has not shipped, so the columns were added to the
v1 DDL instead of bumping it. A database created before this change has no such
columns; `ayah_word` is derived content data, so a reimport (or deleting the DB
file) rebuilds it and user tables are untouched either way.

## Search

`ayah_search` is an FTS5 virtual table over normalised Arabic plus each bundled
translation, with `remove_diacritics 2`. It is a derived index: rebuildable,
never backed up, and dropped on content reimport.
