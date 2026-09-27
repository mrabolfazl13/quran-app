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
`translation.(verse_key, pack_id)` composite primary key, `hifz_segment.item_id`
→ `hifz_item` with `ON DELETE CASCADE` (dropping a memorisation target drops its
derived segments and anchors) while `hifz_attempt.item_id` also cascades — so
dropping an item destroys its history. That is deliberate but destructive, and
the UI must confirm it explicitly rather than treat it as a toggle.

## Enum discipline

Statuses are CHECK-constrained strings, not integers: bands
(`new|unstable|weak|stable|mastered`), item status
(`active|paused|graduated|dropped`), error kinds, relation types
(`explicit|textual|linguistic|thematic|educational|editorial`), licence status
(`clear|attribution-required|unresolved`). `unresolved` rows are imported but
must be hidden from reading surfaces until licensing is confirmed.

## Derived columns

`ayah.word_count` and `ayah.normalized_hash` are computed by the pipeline from
the authoritative text via `core/src/normalize/arabic.ts` and are what integrity
checks recompute against at import. `text_uthmani` itself is never normalised,
trimmed or rejoined — the stored string is byte-identical to the pack payload.

## Search

`ayah_search` is an FTS5 virtual table over normalised Arabic plus each bundled
translation, with `remove_diacritics 2`. It is a derived index: rebuildable,
never backed up, and dropped on content reimport.
