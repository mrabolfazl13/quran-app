# Content sources, licences and the pack pipeline

Owner: Content agent. Provider: Quran.com API v4 (`https://api.quran.com/api/v4`,
operated by Quran Foundation). This document records exactly where bundled
content comes from, what is known about its licence, and how the pipeline
guarantees text integrity.

**Read the licence section first: it is deliberately pessimistic. Nothing here
is "free because a public API served it".**

## Pipeline

```
tools/content/src/fetch.ts     →  data/raw/quran-com/*.json  (+ data/raw/manifest.json)
tools/content/src/validate.ts  →  integrity gate, exits non-zero on any violation
tools/content/src/build.ts     →  content/<pack>/pack.json + payload.jsonl, content/index.json
```

npm wiring: root `content:fetch` / `content:validate` / `content:build` →
`tools/content` `fetch` / `validate` / `build` (`node src/<step>.ts`, Node 24
type stripping, zero runtime dependencies).

* `fetch.ts` is resumable: a file is skipped only when its bytes match the
  sha256/bytes recorded for it in `data/raw/manifest.json` **and** the recorded
  URL is the same one being requested. One crashed run left a stale paginated
  temp file that contaminated `divisions-89.json`; provenance-aware skipping
  and per-endpoint shape expectations now prevent any recurrence. The
  contaminated file was re-downloaded and now passes every gate.
* `data/raw/manifest.json` records `url`, `sha256`, `bytes`, `fetchedAt` for
  every raw file (500 files, 500 entries, verified). Note: this machine's
  clock is unsynchronised — `fetchedAt` is ordering-reliable, not wall-clock-true.
* `validate.ts` re-hashes every raw file against the manifest before checking
  content, so "audited" means the bytes examined are the bytes downloaded.
* Tafsir fetching (228 per-chapter calls) is a separate mode
  (`node src/fetch.ts tafsirs`) because it is slow; it is not part of the
  default fetch.

## Endpoints actually used (all measured 2026-09, all HTTP 200)

| Endpoint | Used for | Notes |
| --- | --- | --- |
| `/chapters` | surah metadata | 114 rows |
| `/quran/verses/uthmani` | authoritative ayah text | 6236 rows in one call; ids ascending == mushaf order |
| `/quran/verses/uthmani-simple` | `textUthmaniSimple` | 6236 rows |
| `/verses/by_chapter/{c}?fields=…divisions…&per_page=300` | juz/hizb/rub/ruku/manzil/sajdah/page + cross-check text | per_page up to 300 honoured (ch.2 returns all 286); pages still merged defensively |
| `/verses/by_chapter/{c}?words=true&word_fields=…&per_page=300` | word-by-word | word objects: id, position, char_type_name (word/end), text_uthmani, translation, transliteration |
| `/quran/translations/85|135|29` | bulk translations | 6236 ordered rows, **no verse_key** — see alignment proof |
| `/verses/by_chapter/{c}?translations={id}&per_page=300` | alignment proofs | 12 sample chapters, all their verses |
| `/tafsirs/16|169/by_chapter/{c}` | tafsir passages | 114 calls each |
| `/resources/translations`, `/resources/tafsirs` | attribution snapshot | **contain no license fields** (verified on the snapshot) |

## Measured provider-data facts that shaped the pipeline

1. **Translation array alignment is proven, not assumed.** Bulk rows carry no
   verse_key. For every one of 12 sample chapters (1, 2, 10, 18, 24, 36, 45,
   55, 67, 78, 112, 114 — the required set plus more, all verses of each,
   854 verses per resource) the positional mapping `uthmani-id-order → bulk
   row` was compared **byte-for-byte** against `/verses/by_chapter/{c}?translations={id}`.
   Result: 854/854 exact matches for all three resources (85, 135, 29).
   If a future run detects a shift, `validate.ts` prints a `BLOCKER:` line
   including the measured offset and refuses to pass.
2. **Quran text is never normalised in storage.** The stored `textUthmani` is
   the byte-exact string from `/quran/verses/uthmani`. Post-build validation
   compares every pack record back to the raw bytes (6 236 ayah texts, 83 665
   word texts, 3×6 236 translation texts, all tafsir passages) — any drift is
   a hard `PACK CORRUPTION` failure. Core normalisation is used *only* to
   compare tokens/counts.
3. **Word-data quirks (documented, not repaired).** The per-word endpoint's
   `text_uthmani` carries ornamental pause marks (U+06D6–U+06ED) that the bulk
   uthmani omits: 2 635/6 236 verses reconstruct byte-exactly, 3 599 differ
   only in those marks, and 2 verses have genuine cross-endpoint spelling
   variants (`5:52` splits `دَآئِرَةٌ` as `دَآئِرَ ةٌ`; `11:13` spells
   `ٱفْتَرَىٰهُ` as `ٱفْتَرَاهُ`). These are whitelisted in
   `validate.ts` with reasons; every other divergence fails the gate.
4. **Word counts**: some word entries embed a pause mark after a space
   (`"بَعْدَ مَا"`), so counts compare *flattened* token sequences, not raw
   entry counts. Each ayah has exactly one `char_type_name=end` entry whose
   Arabic-Indic digits equal the verse number (6 236 end marks).
5. **Tafsir editions are grouped.** Al-Muyassar (16): 1 013 non-empty
   passages; Ibn Kathir abridged (169): 1 062 rows of which **762 are empty
   placeholder rows** (commentary sits under the preceding passage). Empty
   rows are dropped; surviving passages are stored with
   `coversVerseKeys=[verseKey]` — we do **not** invent multi-verse coverage
   ranges the provider never states. English tafsir text contains HTML
   fragments (`<h2>`, `<span style…>`) as delivered.
6. **`bismillah_pre` contract mismatch (reported to orchestrator).** The API
   sets `bismillah_pre=false` for surahs 1 and 9 only (true = basmalah is
   *prefixed, not a verse*; Al-Fatihah's basmalah *is* verse 1; At-Tawbah has
   none). The contract comment in `core/src/contracts/quran.ts` says
   "An-Naml: false, Al-Fatihah: true", which contradicts both the provider
   data and its own definition. Packs pass the provider value through
   verbatim; the contract comment needs an architect fix.
7. Al-Fajr has 30 ayahs and Al-Balad 20 in this edition (standard Kufi
   enumeration; chapters metadata, divisions, word data and bulk text all
   agree at 6 236 ayahs / 114 surahs).

## Packs produced (current run)

Eight packs, all of them `license.status = "unresolved"` (see the licence
section). No audio pack exists — see `docs/audio-licenses.md`.

| Pack | Kind | Records | Notes |
| --- | --- | ---: | --- |
| `quran-core` | quran-core | 6 350 | 114 `_t:"surah"` + 6 236 `_t:"ayah"` lines; divisions inline |
| `word-data` | word-data | 83 665 | **77 429 word tokens + 6 236 ayah-end marks** (`isEndOfAyahMark:true`); `position` = contract rule (word tokens 1..N; end marks at N+1). Quote the row count as *rows*, never as "83 665 words" |
| `tr-en-abdulhaleem` | translation | 6 236 | alignment proven |
| `tr-fa-islamhouse` | translation | 6 236 | alignment proven |
| `tr-fa-kaldari` | translation | 6 236 | alignment proven |
| `tafsir-ar-muyassar` | tafsir | 1 013 | grouped passages; 270 of them carry provider HTML |
| `tafsir-en-ibnkathir` | tafsir | 300 | grouped passages, 762 empty provider rows dropped; all 300 carry provider HTML; **covers 113 chapters — surah 105 (Al-Fil) has no passage at all** |
| `mutashabihat-ar` | linguistic | 1 732 | **not fetched — computed at build time** by `core/src/mutashabihat` over the `quran-core` payload this run shipped (see below) |

### `mutashabihat-ar` — the one machine-made pack

It is the only shipped pack with no provider row behind it, so it labels itself
that way in the artefact rather than relying on a comment here:

* `source` is the literal string `computed at build time from
  content/quran-core/payload.jsonl` — not an API URL.
* `title` reads "…computed similar-ayah candidates (machine-derived from the
  Uthmani text; not a scholarly analysis)".
* a `derived` block states `computed: true`, `producedBy:
  algorithm:mutashabihat-blocking@v1`, the algorithm/module/tokenisation, every
  engine parameter it used, the score definition, the determinism rules, the
  sha256 of the exact core payload the pairs were computed over, and an explicit
  `not:` list ("scholarly mutashābahāt analysis", "asbab al-nuzul", "a religious
  or legal claim", "model or human output").
* `license.status` inherits `quran-core`'s `unresolved` — a derived work may not
  launder the licence of its input.
* `attribution.creditLine` says the rows are machine-computed candidates.

No model of any kind produced these rows: they are deterministic algorithm
output over the bundled text, which is why they are labelled *computed* and not
`AI GENERATED`. Nothing else in `content/` is machine-made; `docs/local-ai.md`
records the rule that any model output would have to carry the `AI GENERATED`
label and stay out of canonical panes. The gate re-derives all 1 732 pairs with
the real engine function (`tools/content/src/validate.ts`, check 9) and
`tests/integration/content-pack-manifests.test.ts` re-derives them again
independently of `tools/content`.

`content/index.json` is the `PackIndex` (schemaVersion 1). Every `pack.json`
is a `ContentPackManifest` with sha256 over the payload, real byte length and
real record count — all re-verified by the post-build validation pass.
`pack.json` and the matching `index.json` entry must be the same manifest:
`validatePacks()` compares them byte-for-byte, because the importer reads the
index while a human reviewer reads the per-pack file.

## Pack-level audit evidence (independent recomputation, not the pipeline's word)

Recomputed with `node:crypto` over the bytes on disk, then asserted as
`tests/integration/content-pack-manifests.test.ts`:

| Pack | sha256 (first 12) recomputed = manifest | rows counted = recordCount | licence / attribution stated |
| --- | --- | --- | --- |
| `quran-core` | `49cb3b10f7e7` ✔ | 6 350 ✔ | unresolved, notes + credit line present |
| `word-data` | `8758734b3f42` ✔ | 83 665 ✔ | unresolved, present |
| `tr-en-abdulhaleem` | `133c6db7ab92` ✔ | 6 236 ✔ | unresolved, present |
| `tr-fa-islamhouse` | `b958c471e3a6` ✔ | 6 236 ✔ | unresolved, present |
| `tr-fa-kaldari` | `d0acc845cdc1` ✔ | 6 236 ✔ | unresolved, present |
| `tafsir-ar-muyassar` | `8527ea69b585` ✔ | 1 013 ✔ | unresolved, present |
| `tafsir-en-ibnkathir` | `e0188ed27840` ✔ | 300 ✔ | unresolved, present |
| `mutashabihat-ar` | `415e7a1a130c` ✔ | 1 732 ✔ | unresolved (inherited), self-labelled computed |

Provenance of the inputs: 500 JSON captures under `data/raw/quran-com`, 500
entries in `data/raw/manifest.json`, 0 bytes whose sha256/length disagree with
that manifest, and every recorded URL on `https://api.quran.com`. The 36
translation-alignment proofs (3 resources × 12 sample chapters) are on disk, so
`content:validate` runs fully offline — no fetch was needed for this audit and
`content:fetch` was not run.

The validator was also proven able to **fail**, on throwaway copies under
`%TEMP%` (the shipped `content/` was never touched): altering one dammah in
55:13, truncating one word-data row, inventing a mushaf page number, raising a
stored pair score, appending to a tafsir passage, and — the adversarial case —
editing 2:255 **and** recomputing `checksum`/`payloadBytes`/`recordCount` so the
manifest is self-consistent. Every one of those exited non-zero with a
`PACK CORRUPTION` line, because the pack text is compared to the provider
capture rather than to its own metadata. Tampering with the raw capture itself is
caught by the provenance hash plus the divisions-vs-bulk comparison.


## Licences — honest status

The Quran Foundation **Developer Terms of Service** state:
“QF Content is not sold, sublicensed, or redistributed”, caching beyond one
week requires permission (via their Content Sync endpoints), and apps must
“credit translations, tafsir editions and recitations by their named source”
and “comply with any source-specific license requirements”. The Quran.com
site Terms of Service limit use to “YOUR PERSONAL, NON-COMMERCIAL USE ONLY”.
The API `/resources/*` metadata carries **no license fields** (measured).

Therefore **every pack ships with `license.status = "unresolved"`**, with
notes recording exactly what is missing:

| Resource | Publisher / rights holder | What must be obtained |
| --- | --- | --- |
| Arabic Uthmani text (chapters, verses, words) | King Fahd Complex for the Printing of the Holy Qur'an (Madinah mushaf), served by Quran Foundation | Written offline-redistribution permission (QF developer terms) or use of the sanctioned Content Sync licence |
| Word glosses/transliteration (resource via Quran.com) | Quran Foundation editorial layer | Same as above |
| English translation, `tr-en-abdulhaleem` (API resource 85) | M.A.S. Abdel Haleem; published by Oxford University Press, *The Qur’an: A New Translation* (2004/2005, ISBN 978-0-19-953577-2) | OUP/QF permission for offline bundling — API serving ≠ redistribution right |
| Persian, `tr-fa-islamhouse` (resource 135) | IslamHouse.com (Foundation for Media Production and Distribution) | IslamHouse’s own reproduction terms could not be retrieved from this environment — their site historically allows non-commercial propagation with attribution, but this must be confirmed in writing against the current terms |
| Persian, `tr-fa-kaldari` (resource 29) | Hussein Taji Kal Dari | No publisher, edition or licence statement located anywhere; least-resolved resource — needs author/publisher contact before shipping |
| `tafsir-ar-muyassar` (resource 16) | “Tafsir al-Muyassar” — prepared by a committee of scholars (per the work's own front matter); print editions widely distributed | Written redistribution grant; free web/CD distribution does not evidence a licence |
| `tafsir-en-ibnkathir` (resource 169) | Ibn Kathir (abridged), English abridgement associated with Dar-us-Salam | Dar-us-Salam permission for offline bundling |

**Gate before shipping to anyone outside the owner's personal use:** obtain
and record written permission per resource, then flip statuses
(`unresolved → attribution-required/clear`) with the evidence file-attached.
The app must display every `attribution.creditLine` wherever the underlying
content is surfaced (QF requirement) — this includes the mushaf text itself.

## Contract-conformance notes for the importer

* Records match `core/src/contracts/*` field names exactly (camelCase).
  Mixed payloads carry `_t: "surah" | "ayah"` discriminators on `quran-core`
  lines (word/translation/tafsir payloads are single-type).
* `Ayah.sourceId` is the provider row id — informational, never a key.
* `AyahWord.id` is the provider's globally unique word id;
  `position` follows the contract rule; end marks get `position = N+1…`.
* `VerseKey` strings are exactly `chapter:verse` with no padding.
* `Surah.translationFa` is null: no endpoint in this set provides Persian
  surah names (only English via `translated_name`). Do not invent one.
* `manifest.coverage` is a **range, not a completeness claim**: `build.ts`
  stamps every pack with `allChaptersCover()` (chapters 1..114, `1:1`–`114:6`).
  For the grouped tafsir and the computed pair pack that overstates what the
  payload holds — `tafsir-en-ibnkathir` has rows for 113 chapters (none for 105)
  and `mutashabihat-ar` for 107. `validate.ts` prints this as a warning per pack
  and `tests/integration/content-pack-manifests.test.ts` pins the row
  arithmetic. No consumer may treat `coverage` as a count: the UI's "coverage"
  figure is a `COUNT(*)` over `translation`/`tafsir` rows
  (`desktop/src/gateway/tauriGateway.ts`, `translationOptions()`), never this
  field. Tightening the field to per-pack reality is a generator change
  (`npm run content:build`), not a hand-edit of `content/`.
* Empty/whitespace text is impossible: the validator hard-fails on it, and
  post-build re-verifies every stored string against raw bytes.
