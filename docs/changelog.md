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
- Docs: architecture, product spec, data model, testing, privacy.

### Known constraints

- No audio bundled: licences unresolved, so the feature is absent rather than
  present-and-infringing.
- Concept engine has no source data yet; relationships shown are computed and
  labelled as such.
- Flutter/Android not started (phase 2). The contracts and engine are written
  framework-free so the Dart port mirrors them instead of reimplementing them.
- This machine's clock is unsynchronised; timestamps in packs and backups come
  from it and are accurate to hours, not seconds.
