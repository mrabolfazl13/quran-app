# Mushaf layout

What this is: the rules by which the app rebuilds the printed Madani mushaf
(604 pages, 15 lines each) from stored per-word data, offline, without ever
re-flowing the text.

Code: `core/src/mushaf/layout.ts`, `render.ts`, `validate.ts`,
`index.ts` (re-exports all three). Tests: `core/tests/mushaf/` —
`layout.test.ts` (26), `validate.test.ts` (24), `render.test.ts` (13),
`navigation.test.ts` (14), `real-corpus.test.ts` (16, 2 of which are the
full-corpus audits gated behind `MUSHAF_FULL_CORPUS=1`). `npx vitest run
tests/mushaf` reports **91 passed / 2 skipped (93)** across those 5 files
(2026-09-28, this machine).

Consumer: the desktop page screen `desktop/src/screens/quran/PageScreen.tsx`.
The screen renders from the mushaf metadata in the pack — the app never renders
an image of a page (see "What the renderer is not", below).

## The coordinate space

Two constants, both asserted rather than assumed:

| Bound | Where it is declared | Where it is enforced |
| --- | --- | --- |
| 604 pages | `PAGE_COUNT = 604` in `core/src/contracts/quran.ts`, re-exported as `MUSHAF_PAGE_COUNT` (`core/src/mushaf/layout.ts:33`) | `validate.ts` `page-out-of-range` (fatal) and `missing-pages` (fatal, full-corpus mode); `real-corpus.test.ts` asserts `pages.length === 604` |
| 15 lines per page | `MAX_MUSHAF_LINES = 15` (`core/src/mushaf/layout.ts:44`) | `validate.ts` `page-too-tall` / `line-exceeds-max` (fatal); layout unit tests reject a 16th line |

The 15 is sourced, not invented. The comment at `layout.ts:38-44` records the
measurement: over all 604 pages of the provider captures
(`data/raw/quran-com/words-*.json`, 83,665 word tokens) the highest
`line_number` observed is 15, and **488 of 604 pages use exactly 15 lines**.
That matches the printed Mushaf al-Madani, which is set on a 15-line grid.

`buildMushafLayout` takes `maxLines` and `pageCount` options
(`BuildLayoutOptions`, `layout.ts:221`), so a smaller fixture can be laid out
honestly; the shipped defaults are the two constants above, and the desktop
screen passes no overrides.

## Page and line are data, never a guess

A word's position on the page comes from the pack, not from measurement:
`ayah_word.page_number` (1..604) and `ayah_word.line_number` (1..15) are columns
in `core/src/contracts/db.sql` (`NOT NULL`, with the comment block above the
`ayah_word` table explaining that a row without them is a content-pipeline
failure), mirrored in the contract type `AyahWord.pageNumber` /
`.lineNumber` (`core/src/contracts/quran.ts`), and copied verbatim out of
`content/word-data/payload.jsonl` (`pageNumber` / `lineNumber`) by
`tools/content/src/build.ts` → `desktop/src/content/records.ts`.

The reason the app refuses to compute placement is stated in the module header
(`layout.ts:4-8`): a reader that re-flows text with font metrics produces a
*different book*. Page 278 has to be page 278 on every device and in every font,
because learners memorise "the verse on the third line of that page".

Placement is therefore a pure grouping operation: tokens are bucketed by
`(page, line)` and ordered inside a line by `(verse_key, position)`. Nothing is
measured, and nothing is dropped silently — see the two next sections.

### The one place metadata disagrees with itself

Two sources describe where a verse sits, and in the shipped data they disagree
on **56 of 6,236 ayahs** (`content:validate` reports
`wordPageAnchorDisagreements: 56`, and `npm run content:validate` prints a WARN
naming the same number):

- the word row's own `page_number`, and
- `ayah.page`, the per-ayah page from the divisions rows.

The tie-breaker is the mushaf's own reading order: as verses advance,
`(page, line)` must never go backwards. Anchoring each ayah's tokens on
`ayah.page` (falling back to the word row only when no anchor exists) yields
**zero reading-order inversions across all 83,665 provider tokens**; trusting
the word rows' page blindly yields **25** (`layout.ts:10-21`). Hence
`pagePolicy: 'anchor'` is the default; `'word'` and `'word-strict'` exist so the
comparison is a test, not an opinion — with `'word-strict'` the conflicting
tokens land in `unplaced` with reason `reading-order-conflict`
(asserted in `real-corpus.test.ts`).

Every correction is reported, never hidden: 56 `word-page-corrected`
diagnostics move 361 tokens in the full corpus (`real-corpus.test.ts`,
full-corpus mode). The stored text and stored metadata are untouched.

## Unplaced words

`buildMushafLayout` **never throws** — the doc comment at
`core/src/mushaf/layout.ts:305-308` states it and the function begins at `:310`.
A token it cannot place goes to `MushafLayout.unplaced` with one
of the `UnplacedReason` codes (`layout.ts:132-147`):

`missing-page-metadata` · `missing-line-metadata` · `page-out-of-range` ·
`line-not-positive` · `duplicate-reference` · `invalid-position` ·
`reading-order-conflict`

The full corpus builds with `unplaced.length === 0` (measured twice on this
machine: 83,665 rows in, 604 pages out, 0 unplaced, 56 diagnostics — engine-
level figure, see `docs/performance.md`). A non-empty bucket is fatal in
`validateLayout`, so an import that lost words fails the gate rather than
rendering a shorter mushaf.

## Navigation: page → ayah → word

`createMushafNavigation(pages)` (`layout.ts:925`, `MushafNavigation` at `:904`)
is the read API the UI uses; results are cached in a `WeakMap`, so repeated
lookups over the same page array do not rescan. It answers:

- `pageOfVerseKey` / `page` — where a verse sits,
- `versesOnPage`, `firstVerseOnPage`, `lastVerseOnPage`, `verseKeysOnLine` —
  what a page holds,
- `pageContinuesVerse` — whether a verse began on the previous page (the page
  header says so; `MushafPage.continuesVerseFromPreviousPage`),
- `placementOf(verseKey, position)` — the exact `(page, line)` of one word,
- `pageRangeOfSurah`, `versesOfSurahOnPage`, `surahStartOnPage` — surah entries,
- `juzBoundaryPages`, `pageCount`.

`MushafPage` (`layout.ts:158`) additionally carries `emptyLineNumbers` (line
slots holding no token), `tokenCount`, `juzNumbers`, `diagnostics` and
`isComplete`.

An empty line slot is never an accident. On a 15-line grid a gap means the
printed page puts something there — a surah heading, a basmalah, a blank line
between sections. `MushafPage.surahStarts` records the band a heading occupies
(`SurahStartOnPage.headingBandLines`, `layout.ts:113-121`) and
`validateLayout` requires **every gap to be explained by a heading band**
(`line-gap`, `validate.ts:255`); an unexplained gap is a defect. In the full
corpus: 205 empty line slots, all explained. On page 604 the printed layout is
lines `[3,4,7,8,9,12,13,14,15]` with `[1,2,5,6,10,11]` empty (73 tokens; surahs
112, 113, 114 start on lines 3, 7 and 12) — asserted in `real-corpus.test.ts`.

## Rendering: what `renderPage` guarantees

`renderPage(page, words, options?)` (`core/src/mushaf/render.ts:118`) returns a
`RenderedPage` of lines, text, ordered tokens, and issues. The guarantees:

1. **Whitespace is the only thing the renderer may add.** The separators are
   checked to be whitespace-only; a non-whitespace separator is rejected with a
   fatal `separator-not-whitespace` issue and the default is used instead
   (`render.ts:130-136`). Word text is copied out of the row untouched.
2. **Byte-exactness is verifiable, not promised.** `removeWhitespace(text)`
   versus the reading-order token texts (`pageTokenTexts`, `render.ts:227`) must
   match after whitespace removal — that is what `render.test.ts` and
   `real-corpus.test.ts` assert, including on the 20 non-NFC tokens on page 604.
   The provider's Uthmani text is not Unicode NFC (shadda `0651` then fatha
   `064E`; NFC reorders them), so any normalisation on the render path would
   corrupt the mushaf. It doesn't happen: combining-mark order survives
   (`112:1` word 3 is checked code-point-by-code-point in the real-corpus test).
3. **Nothing is invented.** A line reference with no backing row is a fatal
   `unresolvable-reference` (`render.ts:192`); two rows claiming the same
   `(verse_key, position)` is an `ambiguous-word-row` warning (`render.ts:102`).
   End-of-ayah marks render as the ayah number derived from the verse key — the
   number is computed from identity, not stored per mark.

### Bidi / RTL

Layout and render are direction-agnostic: they emit ordered tokens and text and
know nothing about RTL. Direction belongs to the DOM and CSS:

- every mushaf line is `<p className="quran-text mushafline" dir="rtl" lang="ar">`
  with one `<span className="word">` per token
  (`desktop/src/screens/quran/PageScreen.tsx:332`),
- `.quran-text` / `.arabic` set `direction: rtl; unicode-bidi: isolate;`
  (`desktop/src/ui/ui.css:301-307`), and the app itself is `dir="rtl"`
  (`desktop/index.html`),
- line content is centred with `justify-content: center` and
  `font-size: var(--mushaf-size)` = `2rem`
  (`desktop/src/screens/quran/quran.css:296-306`,
  `desktop/src/styles/tokens.css:33`), `line-height: var(--lh-quran)` = 2.15
  (`desktop/src/styles/tokens.css:25`).

**Caveat worth knowing:** `.mushafline` is `display: flex; flex-wrap: wrap`.
A long printed line at a large `--mushaf-size` can therefore wrap *inside* the
DOM, which breaks the "one data line = one visual line" property on screen even
though the data is right. The mushaf metadata is correct; the CSS is a
readability compromise, not a re-flow (no line assignment changes). Nothing in
`core/tests` or `desktop` asserts the no-wrap property — do not claim it.

## Validation: `validateLayout` against the real corpus

`validateLayout(input, ayahs, options)` (`core/src/mushaf/validate.ts:137`)
returns `{ ok, counts, defects, fatalCount, warningCount, infoCount }` with
`ok = fatalCount === 0` — a warning-heavy layout can still be `ok`, so callers
must look at the counts too. Checks and their codes:

| Code | Severity | What it catches |
| --- | --- | --- |
| `duplicate-ayah-row` | fatal | the same verse key supplied twice |
| `page-out-of-range`, `ayah-page-out-of-range` | fatal | a page outside 1..604 |
| `page-too-tall`, `line-exceeds-max` | fatal | more than 15 lines on a page |
| `line-out-of-order` | fatal | lines not ascending within a page |
| `line-gap` | warning | an empty line slot with no heading band to explain it |
| `ref-without-token`, `duplicate-reference`, `token-count-mismatch` | fatal | a line pointing at a word that is not there, a word counted twice, totals that disagree |
| `reading-order-inversion` | fatal | a verse advancing while `(page, line)` goes backwards |
| `page-out-of-order` | fatal | pages emitted out of sequence |
| `word-total-vs-tokenised` | warning | packed word-row count vs the tokenised expected total |
| `position-gap` | warning | non-contiguous word positions inside a verse |
| `end-mark-multiple` / `end-mark-missing` / `end-mark-not-last` | fatal / warning / warning | the one-end-of-ayah-mark-per-verse rule |
| `verse-word-count` | warning | `ayah.word_count` vs the rows supplied |
| `missing-pages` | fatal | absent page numbers (full-corpus mode) |
| `word-page-conflict`, `word-without-ayah`, `unexpected-basmalah-token` | reported | disagreements passed through from the layout build |

### Measured coverage, and what it is measured over

Two levels, and the difference matters:

- **Always-run subset.** `real-corpus.test.ts` lays out the 8 chapters
  `[1, 2, 5, 9, 78, 112, 113, 114]` from the real captures — 12,275 rows,
  11,678 word tokens, 597 end marks, 95 pages, 1,383 lines, 19 empty line slots
  (all explained), **1 page carrying a defect**. The defects are
  `verse-word-count` (2:181: 13 rows vs a text of 14 words) and
  `word-total-vs-tokenised` — real provider discrepancies, deliberately not
  hidden. Level: unit/model, over real provider rows.
- **Pack-level.** A separate describe builds the grid straight from
  `content/word-data/payload.jsonl` and asserts `recordCount === 83665`,
  114 chapters, `fileSize` equals the payload bytes, every row's page in 1..604
  and line in 1..15, and that the grid signature from the pack equals the
  signature from the raw captures. Level: pipeline output, read at test time.
- **Full corpus (opt-in).** `MUSHAF_FULL_CORPUS=1 npx vitest run tests/mushaf`
  audits all 604 pages: 83,665 rows → 77,429 word tokens + 6,236 end marks,
  8,820 lines, 205 empty slots all explained, 77,433 tokenised vs 77,429 placed
  (delta 4, from the four documented provider discrepancies `2:181`, `8:6`,
  `13:37`, `37:130`), juz boundary pages `[62, 121, 201, 502]`, 56
  `word-page-corrected` diagnostics moving 361 tokens. This run was executed on
  2026-09-28 and passed (exit 0). It is opt-in because it is slow relative to a
  unit test, not because it is uncertain.

Named placements asserted in the tests: page 121 holds tokens whose rows
declared page 120 (`5:77`, `5:83`, `5:90` — the anchor policy corrects them);
surah 5 starts on page 106 line 8 with heading band `[1..7]`; Al-Baqarah spans
pages 2..49 and `3:1` begins on page 50; juz boundary pages in the subset are
`[121, 201]`.

## What is not shipped

Stated plainly, because a reader will otherwise assume it:

- **No page art.** There is no calligraphic surah heading, no basmalah
  ornament, no page-boundary frame, no image of the printed mushaf. Heading
  bands are rendered as dashed placeholder strips labelled "line N"
  (`.mushafgap`, `border-block: 1px dashed var(--gold)` in
  `desktop/src/screens/quran/quran.css:312-321`, used by
  `desktop/src/screens/quran/PageScreen.tsx:324`). The *data* about
  which lines are a heading band exists (`surahStarts`, `headingBandLines`,
  `emptyLineNumbers`); the art does not.
- **Page-break behaviour lives in the screen, not the engine.** Next/previous
  page, the clamped 1..604 jump box (`PageJump` in `PageScreen.tsx`) and what
  happens at a boundary are UI decisions. `core/src/mushaf/` computes a page
  grid and knows nothing about navigation gestures or history.
- **The mushaf is drawn from pack text, not from an image.** Each token is a
  `<span>` whose content came from `ayah_word.text_uthmani`, positioned by
  `page_number`/`line_number`. There is no scanned-page asset anywhere in the
  reader path.
- **A degraded page is possible and says so.** `PageScreen.tsx` renders a page
  only when every word for it carries a line number
  (`drawable = words.length > 0 && withLines.length === words.length`) and shows
  an honest empty state otherwise. Since `ayah_word.page_number`/`line_number`
  are `NOT NULL` and the importer refuses rows without them, a shipped database
  cannot reach that state through import — it is a guard, not an expected path.
- **No font-metric pagination, ever.** Not implemented, and per the module
  header it must not be.
- **`LayoutWord` accepts degraded input on purpose** (`layout.ts:62-69`): the
  engine widens the contract's required `pageNumber`/`lineNumber` back to
  "maybe missing, maybe null, maybe snake_case" so a hand-fed fixture or a
  corrupt capture is *reported* rather than crashing the build. That is a
  test-facing escape hatch, not a supported shipped state — the schema and the
  importer both refuse such rows.

## Related documents

`docs/data-model.md` (the `ayah_word` columns and why they are not derived),
`docs/content-packs.md` (the `word-data` pack and its licence status),
`docs/performance.md` (layout/render cost, by level), `docs/ux-spec.md` §6
(mushaf page vs ayah-feed reading modes).
