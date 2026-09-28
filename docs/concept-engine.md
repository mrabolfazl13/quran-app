# Concept engine — what does and does not exist in v1

**Headline: there is no concept pack and no concept/semantic search engine in
this repository's product code.** The schema, contracts and import plumbing for
a concept layer exist and were verified; the content side was never produced,
deliberately, and every surface that touches concepts says so honestly rather
than showing invented data. This document records that state precisely, marks
what is missing with a NOT IMPLEMENTED list, and describes what a real,
admissible concept pack would require — as requirements, not as a plan.

## What "concept search" would mean

Browsing or searching the Qur'an by *theme* — e.g. "patience across the
mushaf", "verses about gratitude" — requires a mapping from a curated list of
concepts to the verse keys each concept covers, plus relations between
concepts (broader/narrower/related). It is a semantic layer: unlike the
mutashabihat engine, which finds verses by *word-sequence similarity*
deterministically (`docs/mutashabihat.md`), concept membership is an editorial
judgement about *meaning* and therefore must come from a cited, licensed source
— never from surface token overlap and never from a model guessing (see
`ConceptsScreen` text quoted below).

## Exact current state (verified on disk and in code)

### Present and working

- **Contracts.** `Concept`, `ConceptAyahLink`, `ConceptRelation` are defined in
  `core/src/contracts/quran.ts:136-160`; the `PackKind` union in
  `core/src/contracts/content-pack.ts` includes `concepts` (as it includes
  `roots`, `linguistic` etc. — declaration, not delivery).
- **Schema.** The tables `concept`, `concept_ayah`, `concept_relation` are
  created in `core/src/contracts/db.sql:138-162` (with `produced_by` and
  `relation_type` CHECK constraints, as `docs/local-ai.md:114-115` notes), and
  the same DDL is embedded into the desktop app via
  `desktop/src/db/schema.ts` + `desktop/scripts/syncSchema.mjs`.
- **Import plumbing.** `desktop/src/content/records.ts:277-324` maps records of
  a `concepts`-kind pack into those tables; `ContentPlan` carries
  `concepts / conceptAyah / conceptRelations` (`desktop/src/gateway/types.ts:128-130`,
  emptied at `:145-147`); `TauriGateway.applyImport` deletes and rewrites these
  tables transactionally along with all other content tables
  (`desktop/src/gateway/tauriGateway.ts:230-244`, `:361-382`).
- **A row count is exposed.** `ImportCounts.concepts`
  (`desktop/src/gateway/types.ts:191`) is filled by both gateways from the
  stored table (`desktop/src/gateway/tauriGateway.ts:601-621`,
  `desktop/src/gateway/devGateway.ts:288`).

### Absent — and confirmed absent, not assumed

- **No concept pack.** `content/` contains exactly seven packs
  (`content/index.json`, and `docs/content-packs.md` lists them); none has
  `kind: "concepts"`. There is no `content/concepts*/` directory. The concept
  tables are created and then *deleted-and-rewritten-empty* on every import, so
  they contain **zero rows** on a fresh install.
- **No fetch/build/validation path for concepts.** `tools/content` fetches only
  quran.com resources enumerated in `tools/content/src/common.ts:250-259`
  (chapters/verses/words/divisions, translations 85/135/29, tafsir 16/169);
  `fetch.ts`, `validate.ts` and `build.ts` contain no concept mode. Nothing on
  the provider side would even produce such data.
- **No concept read method on the data gateway.** The `DataGateway` interface
  (`desktop/src/gateway/types.ts:285-382`) has `tafsirFor`, `tafsirSources`,
  `similarTo`, `relationsOf`, `search` — and **no** concept query. Neither
  `TauriGateway` nor `DevGateway` implements one.
- **No concept search anywhere.** The FTS index `ayah_search` covers only
  Arabic text, English and Persian translation columns
  (`core/src/contracts/db.sql:350-356`); none of the three desktop search
  backends (`desktop/src/gateway/search.ts` — SqliteSearchService/FTS5,
  MemorySearchService, and the defined-but-unwired CoreEngineSearchService,
  whose query path at `:131-157` never uses the core engine's `concept` query
  kind) resolves a query through concept rows. `docs/search-system.md`
  describes a `concept` query kind and a `no-concept-pack` guard; in this tree
  that guard can only ever say "no pack", and no desktop code path emits the
  query (see contradiction note in the final report).
- **The UI states its own limit.** `desktop/src/screens/discover/ConceptsScreen.tsx`
  detects at call time whether the gateway optionally exposes a `concepts?()`
  reader (it does not), and renders the honest empty state — English text as
  it appears on screen (`:130-131`):
  > "No concept-bearing content pack is installed, and the data gateway
  > exposes no concept read either; so there is nothing to display — and
  > nothing will be invented."

  The only number on the screen is the stored row count, via
  `counts().concepts = ${storedRows}` (`:136`) — which on a fresh import is 0.

## Why no concept data was generated locally

Two non-negotiables of this repository, both documented rather than implied:

1. **Never invent Quranic-adjacent content.** Thematic verse attributions are
   religious/editorial claims; a generated list presented as tafsir-adjacent
   content would breach the project's rule against inventing content
   (`AGENTS.md`; the same rule shapes the licence honesty in
   `docs/content-sources.md`).
2. **No AI-generated content ships in v1 — measured, not assumed.**
   `docs/local-ai.md:7`: "**No local AI model ships in v1.**" and `:18`: the
   "`concept`/`concept_ayah` schema … is filled by editorial packs, not by a
   model." The experiments directory did run a semantic-corpus measurement
   (corpus kinds `concept-ar`/`concept-fa`/…, `docs/local-ai.md:96-106`), but
   `experiments/local-ai/` is isolated from the product by its own
   `package.json` and git-ignored for models (`docs/architecture.md:93-96`).
   Its findings inform the *why* — a model could pre-seed candidate rows for
   human review (`docs/local-ai.md:106`) — but nothing from it ships.

Consequence: the concept layer is **empty by decision**, with the schema kept
so a future curated pack imports without migration.

## What an admissible real concept pack would require

Requirements for any future `concepts`-kind pack to be shippable — stated as
gates, not as commitments:

- **A named source work** with author/edition, recorded in
  `attribution` exactly as the seven shipped packs do
  (`core/src/contracts/content-pack.ts` manifest shape).
- **A licence position.** If the licence cannot be confirmed, `status` must
  stay `unresolved` with the reason in `notes` — the precedent of every
  shipped pack (`content/*/pack.json`), and written permission is still needed
  before installer shipping (`docs/content-sources.md`,
  `desktop/src/screens/me/AboutScreen.tsx:124`).
- **Verse-key alignment proven.** Every `concept_ayah.verse_key` must resolve
  against the canonical 1..114 / 6236 enumeration; the gate for this is the
  same style of cross-check `tools/content/src/validate.ts` applies to
  translations (`:394-418`, BLOCKER on a guessed mapping) and tafsir
  (`:428-447`).
- **Checksum chain.** sha256 over the JSONL payload, `payloadBytes`,
  `recordCount`, and post-build byte re-verification, identical to
  `tools/content/src/build.ts:141-169`, `:369-384` and the import-side checks
  (`desktop/src/content/importer.ts:203-250`).
- **A human review workflow** for the semantic claims themselves (which verse
  "bears" a concept is interpretation). If a model ever pre-seeds candidates,
  rows must carry `produced_by` identifying that provenance, per the schema's
  CHECK constraints (`core/src/contracts/db.sql:138-162`,
  `docs/local-ai.md:114-115`).
- **Files that would change:** `tools/content/src/common.ts` (resource/roll-up
  maps), `fetch.ts` or an offline ingest step, `validate.ts` (concept gate),
  `build.ts` (emit `content/<id>/pack.json` + `payload.jsonl`), `content/index.json`
  (via the build), and — for first read access — a concept query on
  `DataGateway` (`desktop/src/gateway/types.ts`) implemented in both
  `tauriGateway.ts` and `devGateway.ts`, which `ConceptsScreen` already
  probes for. The import path needs no change (records.ts already maps it).

## NOT IMPLEMENTED (honest list, as of this writing)

- NOT IMPLEMENTED: any `concepts`-kind content pack (none in `content/`; zero
  concept rows after import).
- NOT IMPLEMENTED: fetching/building/validating concept data (`tools/content`
  has no concept mode).
- NOT IMPLEMENTED: a concept read method on `DataGateway` or either gateway
  implementation.
- NOT IMPLEMENTED: concept search / semantic search in the product (no backend
  in `desktop/src/gateway/search.ts` issues a concept query; `ayah_search`
  FTS has no concept column).
- NOT IMPLEMENTED: concept graph UI beyond the empty-state explanation in
  `ConceptsScreen`.
- NOT IMPLEMENTED: any model-based concept generation in the shipped app
  (`docs/local-ai.md` — experiments are isolated and not product code).
- Also absent (same "declared kind, no pack" family, for completeness):
  `recitation` (no audio packs), `roots`, `linguistic`, `educational` — hence
  the mutashabihat screen shows its own honest empty state, since nothing
  populates `similar_ayah` (see `docs/mutashabihat.md` and
  `desktop/src/screens/discover/MutashabihatScreen.tsx:92-96`).
