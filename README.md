# Quran Platform

Offline-first Quran platform: read → understand → connect → memorize → recall →
review → master. The differentiator is the **Quran Memory Engine (hifz)** — a
deterministic memory model over the mushaf, not a spaced-repetition timer.

**No backend. No network at runtime.** Everything the app shows ships inside the
installer or is computed on the device.

## Where it stands

Desktop (Tauri + React + TypeScript) is the first deliverable and is complete
through the vertical slice; the local web build and the Android port follow.
[`docs/current-state.md`](docs/current-state.md) is the live status page and is
updated at every milestone — read it before trusting anything here.

## Hard rules

These are enforced by code and tests, not by good intentions:

1. **Quran text is immutable.** Import compares raw code points against the
   provider bytes and stops on any mismatch. Nothing rewrites, rejoins or
   re-vocalises revealed text.
2. **No invented content.** Translations, tafsir, hadith and asbab al-nuzul come
   only from data packs with attribution and an explicit licence status
   ([`docs/content-sources.md`](docs/content-sources.md)). Anything machine-made
   is labelled as such and never presented as a canonical source.
3. **Deterministic first.** Recall scoring, similarity, review scheduling and
   integrity checks are algorithms with tests. The local-model experiment was
   measured and rejected: [`docs/local-ai.md`](docs/local-ai.md).
4. **Offline means offline.** One `fetch` exists in the app, and it reads
   same-origin static pack files in the browser build. The desktop binary has no
   HTTP client at all.
5. **No fake numbers.** Every hifz figure — counts, streaks, stability, weak
   segments — is computed from attempts actually stored
   ([`docs/hifz-engine.md`](docs/hifz-engine.md)).
6. **A green build is not "done".** A feature ships when it has been exercised
   through the path the installer actually runs.

## Layout

```
core/            framework-free engine: contracts, Arabic normalisation,
                 hifz memory engine, search, mutashabihat, mushaf layout
tools/content/   fetch → validate → build the offline packs into content/
content/         generated packs (index.json + one folder per pack)
desktop/         Tauri + React app: UI, SQLite gateway, packaging
tests/           cross-module integration tests over real SQLite
docs/            specification, engine and process documentation
```

File ownership is defined in [`AGENTS.md`](AGENTS.md); `core/src/contracts/**`
is the shared truth that every consumer must follow.

## Commands

```bash
npm install                 # root workspaces: core, tools/content, desktop
npm run test:core           # contracts, normalisation, hifz engine, search
npm run content:fetch       # build-time only: download raw provider data
npm run content:build       # validate + emit packs into content/
npm run content:validate    # integrity gate, exits non-zero on failure
npm run desktop:dev         # vite dev server (browser shell, IndexedDB gateway)
npm run desktop:tauri dev   # real Tauri window over SQLite
npm run desktop:tauri build # Windows installer
```

`npm run desktop:tauri build` executes `desktop/scripts/syncSchema.mjs` (embeds
`core/src/contracts/db.sql`) and `desktop/scripts/stageContent.mjs` (copies the
validated packs to `src-tauri/content/`, declared as a bundle resource, and to
`dist/content/` for the web build), then bundles. Both scripts fail loudly
rather than ship a stale schema or a partial content tree.

## Data

* 6236 ayahs of Uthmani text, 83 665 word rows with mushaf page and line,
  114 chapters, English translation (Abdel Haleem), two Persian translations,
  Arabic tafsir al-Muyassar and English Ibn Kathir.
* Every pack records `source`, `license`, `attribution`, `checksum`,
  `recordCount` and coverage — see [`docs/content-packs.md`](docs/content-packs.md)
  and [`docs/audio-licenses.md`](docs/audio-licenses.md).
* Licence status that could not be established from the provider is recorded as
  `unresolved` and the pack ships disabled rather than silently bundled.

## Documentation index

| Document | Covers |
| --- | --- |
| [product-spec](docs/product-spec.md) | the feature set and the user journeys |
| [ux-spec](docs/ux-spec.md) | screens, states, RTL and accessibility bar |
| [architecture](docs/architecture.md) | layers, gateways, ownership boundaries |
| [data-model](docs/data-model.md) | SQLite schema and contract mapping |
| [hifz-engine](docs/hifz-engine.md) | memory fingerprint, probes, classification |
| [memory-fingerprint](docs/memory-fingerprint.md) | segments, anchors, transitions |
| [review-algorithm](docs/review-algorithm.md) | stability, retention, priority, cost |
| [search-system](docs/search-system.md) | deterministic index and matching space |
| [mutashabihat](docs/mutashabihat.md) | similar-ayah detection |
| [concept-engine](docs/concept-engine.md) | concepts and thematic connections |
| [tafsir-system](docs/tafsir-system.md) | tafsir handling and attribution |
| [content-packs](docs/content-packs.md) | pack format, staging, versioning |
| [content-sources](docs/content-sources.md) | providers, endpoints, licence findings |
| [packaging](docs/packaging.md) | schema/content staging, installer build chain, verifying a package |
| [backup-format](docs/backup-format.md) | export/import envelope and validation |
| [local-ai](docs/local-ai.md) | measured costs and the decision not to ship a model |
| [testing](docs/testing.md) | test layers, gates, how to run them |
| [privacy](docs/privacy.md) | what is stored and where it never goes |
| [current-state](docs/current-state.md) | what is true of the tree right now |
| [changelog](docs/changelog.md) | milestones, newest first |
