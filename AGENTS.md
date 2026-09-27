# AGENTS.md — operating rules for this repository

Offline Quran learning, understanding, tafsir and hifz platform.
Desktop: Tauri + React + TypeScript. Mobile: Flutter + Dart (phase 2).
**No backend. No network at runtime.**

## Non-negotiables

1. **Quran text is immutable.** Nothing may alter, "fix", rejoin or re-vocalise
   revealed text. Content validation stops the import on any mismatch.
2. **Never invent content.** Verses, translations, tafsir, hadith, asbab
   al-nuzul and scholarly quotes come only from licensed data packs with
   attribution. Anything machine-made is labelled `AI GENERATED` and is never
   presented as a canonical source.
3. **Deterministic first.** Recall scoring, similarity, review scheduling and
   integrity checks are algorithms with tests, not model output. An optional
   local model may only be added after measured size/RAM/latency/utility.
4. **Offline means offline.** Every feature must work with the network
   disabled. Runtime fetches are a defect, not a fallback.
5. **No fake numbers.** Hifz counts, streaks, stability and time estimates are
   computed from stored attempts. Never placeholder statistics.
6. **Do not declare done on a green build.** Completion requires the feature
   exercised through the shipped path.

## Layout and ownership

| Path | Owner | Notes |
| --- | --- | --- |
| `core/src/contracts/**` | Architect | Shared truth. Edit only with impact review + integration test |
| `core/src/normalize/**` | Architect | Defines "same word" for engine, search and integrity |
| `core/src/hifz/**`, `docs/hifz-engine.md`, `docs/memory-fingerprint.md`, `docs/review-algorithm.md` | Hifz | Engine is framework-free and fully unit-tested |
| `core/src/search/**`, `core/src/mutashabihat/**` | Search | Deterministic index + similar-ayah builder |
| `tools/content/**`, `content/**`, `docs/content-sources.md`, `docs/audio-licenses.md` | Content | Fetch → validate → build packs; packs are generated |
| `desktop/**` | Tauri | UI, DB layer, commands, packaging |
| `mobile/**` | Flutter | Phase 2 |
| `tests/**`, `docs/testing.md` | QA | Unit beside code, integration + E2E here |
| `docs/**` | Orchestrator | `current-state.md` is updated at every milestone |

Two agents must not edit the same file in one round. Shared contracts change
through the orchestrator, then every consumer is updated in the same round.

## Contracts first

Types live in `core/src/contracts/`. The SQLite schema is
`core/src/contracts/db.sql`. Content packs follow `ContentPackManifest`
(id, version, schemaVersion, language, source, license, attribution, checksum,
recordCount). IDs are stable domain keys — `verse_key` (`"112:1"`), surah
number, page number. **Array indexes are never IDs.**

## Loop every agent follows

```
IMPLEMENT → BUILD → TEST → INSPECT → FIX → RETEST
```

Then integration: `INTEGRATE → BUILD → REGRESSION → FIX → REGRESSION AGAIN`.

## UI bar

Every screen has loading, empty, error, offline and success states. RTL is the
default; Arabic and Persian typography must not clip or overlap. Dark mode,
keyboard navigation on desktop, 44px touch targets, real contrast. No
dashboard-template filler, no card soup, no dead buttons.

## Commands

```bash
npm install                     # root, workspaces: core, tools/content, desktop
npm run test:core               # vitest: contracts, normalisation, hifz engine
npm run content:fetch           # download raw provider data into data/raw
npm run content:build           # validate + emit packs into content/
npm run content:validate        # integrity gate, exits non-zero on failure
npm run desktop:dev             # vite dev server (browser shell)
npm run desktop:tauri dev       # real Tauri window
npm run desktop:tauri build     # Windows installer
```
