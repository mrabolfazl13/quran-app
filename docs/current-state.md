# Current state

Updated 2026-09-28. Never record progress here that is not true of the tree.

## Completed

- Repository started from an empty tree (no prior implementation existed).
- Toolchain confirmed on this machine: Node 24, npm 11, Rust 1.96 / cargo 1.96,
  Flutter 3.47 + Dart 3.13, Python 3.12, git 2.52, JDK 17.
- Data source verified reachable and mapped, per-endpoint:
  - `GET /quran/verses/uthmani` → all 6236 ayahs, 1.65 MB, single request.
  - `GET /verses/by_chapter/{c}?fields=text_uthmani,juz_number,page_number,hizb_number,rub_el_hizb_number,sajdah_number,ruku_number,manzil_number`
    → divisions per ayah (114 requests).
  - `GET /verses/by_chapter/{c}?words=true&word_fields=text_uthmani,translation,transliteration`
    → word-by-word with page/line (114 requests, paginated).
  - `GET /quran/translations/{id}` → 6236 rows in one request. English 85
    (Abdel Haleem), Persian 135 (IslamHouse) and 29 (Hussein Taji Kal Dari).
  - `GET /tafsirs/{id}/by_chapter/{c}` → tafsir per chapter (114 requests per
    tafsir). Arabic Muyassar id 16, Ibn Kathir english id 169.
  - `GET /chapters` → 114 surahs with names, revelation place/order, counts,
    page range.
- Shared contracts authored: `core/src/contracts/quran.ts`, `hifz.ts`,
  `content-pack.ts`, `backup.ts`, `db.sql`.
- Arabic normalisation authored: `core/src/normalize/arabic.ts` — the single
  definition of "same word" for search, integrity and the memory engine.
- Workspace scaffolding: root npm workspaces (`core`, `tools/content`,
  `desktop`), `tsconfig.base.json`, `.gitignore`, `AGENTS.md`.

## In progress

- Content pipeline: fetch → validate → pack.
- Hifz memory engine (segmentation, anchors, recall modes, error classifier,
  stability, adaptive review, confusion groups).
- Desktop app scaffold: Tauri + React + Vite + TS, design system, RTL.

## Blocked

- Nothing blocking. Network use is limited to the build-time content pipeline,
  as approved; runtime stays offline.

## Tested

- Not yet — first vitest run pending on the engine and normalisation modules.

## Known issues

- Bulk translation responses (`/quran/translations/{id}`) carry no `verse_key`,
  only an ordered array. Alignment must be proven by per-chapter spot checks
  before the pack is trusted; a silent off-by-one here would corrupt every
  translation shown. Pipeline must assert, not assume.
- Provider licensing metadata is not exposed per resource. Each pack's
  `license.status` must be resolved explicitly or recorded as `unresolved` and
  shipped disabled.
- `tools/content/package.json` scripts point at files that do not exist yet.
- The desktop workspace has no `tauri.conf.json` yet, so `desktop:tauri` fails
  until the Tauri agent lands its scaffold.

## Next tasks

1. Land content packs in `content/` with passing integrity validation.
2. Land the Hifz engine with deterministic unit tests.
3. Wire the desktop reader + hifz UI to the SQLite layer.
4. Run the offline gate: disable network, exercise every feature.
5. Produce and test a Windows build.
