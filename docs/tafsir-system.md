# Tafsir system

What tafsir ships, how a passage attaches to a verse, what `covers_verse_keys`
actually means in this data, what the UI really shows (including the empty
state), and the verified gaps. Every number was read from `content/`,
`data/raw/` or the code named at the claim.

## Which tafsirs ship

Two packs, both built by `tools/content/src/build.ts` from Quran.com v4 API
resources enumerated in `tools/content/src/common.ts:250-259`
(`TAFSIR_RESOURCES` = resource id 16 and 169):

| pack id | kind | lang | provider resource | records (payload) | payload bytes | licence status |
|---|---|---|---|---|---|---|
| `tafsir-ar-muyassar` | tafsir | ar | id 16, Tafsir al-Muyassar | **1,013** | 472,505 | `unresolved` |
| `tafsir-en-ibnkathir` | tafsir | en | id 169, Tafsir Ibn Kathir (abridged) | **300** | 2,193,978 | `unresolved` |

(Read from `content/tafsir-ar-muyassar/pack.json` and
`content/tafsir-en-ibnkathir/pack.json`; both payload sha256s recomputed and
matching, per `docs/content-packs.md`.)

Raw-data context, counted from `data/raw/quran-com/tafsir-*.json`:

- Muyassar (16): 1,013 provider rows, **0 empty** — every row shipped.
- Ibn Kathir (169): 1,062 provider rows, **762 empty** (the provider's
  abridgement is a grouped edition: many verse keys carry an empty placeholder
  because their commentary lives in the preceding group). The build drops
  empty rows (`tools/content/src/build.ts:339`), so 300 passages ship; the
  validator records the same number as a warning
  (`tools/content/src/validate.ts:428-446`, stat
  `tafsir_169_emptyRows`). `docs/content-sources.md` documents the 762.
- A pack is emitted only if every chapter's tafsir file was fully fetched;
  otherwise the pack is OMITTED with a console warning
  (`tools/content/src/build.ts:327-332`).

Both packs' `license.status` is `unresolved` for the same reason as every
other shipped pack (no licence field in the API; QF terms forbid
redistribution) — quoted in full in `content/*/pack.json` `license.notes`; see
`docs/content-packs.md` and `docs/content-sources.md`. No AI-generated tafsir
content exists or ships (`docs/local-ai.md`).

## How a tafsir attaches to a verse

- **Contract.** `TafsirPassage` in `core/src/contracts/quran.ts:98-104`:
  `{ verseKey, packId, text, coversVerseKeys }`.
- **Payload → plan.** `desktop/src/content/records.ts:238-256` (case `'tafsir'`):
  a record needs `verse_key` and non-empty `text` or the whole import fails;
  `coversVerseKeys` falls back to `[verseKey]` when absent
  (`records.ts:245-252`).
- **Table.** `tafsir` in `core/src/contracts/db.sql:110-116`, primary key
  `(verse_key, pack_id)` — one passage per verse per pack; the verse-key side
  is the single anchor row.
- **Lookup.** `TauriGateway.tafsirFor(verseKey)` is an **equality** query,
  `WHERE verse_key = ?` (`desktop/src/gateway/tauriGateway.ts:734-748`);
  `DevGateway.tafsirFor` filters `row.verseKey === key`
  (`desktop/src/gateway/devGateway.ts:377-379`). The UI calls it per ayah when
  the disclosure opens (`desktop/src/screens/quran/panels.tsx:32-35`,
  `desktop/src/screens/quran/AyahRow.tsx:152`).

## What `covers_verse_keys` means in this data — precisely

The contract allows a multi-verse array (a grouped commentary "covers" several
ayat). **In the shipped data it never does.** The build always writes a
single-element array equal to the row's own verse key
(`tools/content/src/build.ts:340`:
`coversVerseKeys: [String(r.verse_key)]`), and a grep over both tafsir
payloads finds zero multi-element arrays. Combined with the equality-only
lookup above, the consequence is that **grouped commentary is not propagated
to the verses it covers**: for an Ibn Kathir group spanning 2:5–2:6, only the
anchor verse (whichever the provider keyed the non-empty row to) shows the
passage; the other covered verses show the empty state. The UI is aware of the
*possibility* — it renders an "N ayat" info chip when
`passage.coversVerseKeys.length > 1` (`panels.tsx:61-65`) — but with today's
packs that branch is unreachable. This is the honest state; `docs/content-sources.md`
records the same build policy.

## UI state, verified

- **Opening tafsir.** Each ayah row has a "Tafsir" disclosure button
  (`AyahRow.tsx:113-120`, `aria-expanded`), which mounts `TafsirPanel` only
  when open (`:152`; header comment `panels.tsx:1-7`).
- **A verse with no tafsir row** (the majority: 1,013 + 300 passages against
  6,236 verses) gets the panel's own empty state, bilingual text quoted from
  `panels.tsx:40-44` exactly as in code:
  - FA title: «تفسیری برای این آیه وارد نشده است» / EN: "No tafsir has been
    imported for this ayah"
  - FA body: «بستهٔ تفسیر را می‌توانید از بخش «سلامت داده» وارد کنید.» / EN:
    "Import a tafsir pack from the Data health screen." — with a link button to
    `/me/content` (`panels.tsx:45-49`).
- **Passage rendering.** Header shows the pack's title from
  `useTafsirTitles` (which loads `gateway.tafsirSources()` purely to build the
  `packId → title` map; `desktop/src/screens/quran/hooks.ts:519-529`, SQL at
  `tauriGateway.ts:750-768`) plus the pack id in mono
  (`panels.tsx:59`, `:66`). The body is rendered as **plain text**:
  `passage.text` sits in a `<p>{passage.text}</p>` with no
  `dangerouslySetInnerHTML` anywhere in the panel (`panels.tsx:69-74`), so the
  HTML fragments present in the provider's Ibn Kathir text (`<span class="green">`,
  `<h1>` — noted in `content/tafsir-en-ibnkathir/pack.json` `license.notes`)
  show as literal markup. That is the current behaviour, documented here
  rather than fixed here.
- **RTL/bidi.** Direction and font are chosen by script *presence in the stored
  text*, not by the pack's manifest language:
  `isArabicScript()` tests `/\p{sc=Arabic}/u` (`panels.tsx:20-22`), and the
  passage gets `dir="rtl"` + the `arabic-inline` class for Arabic-script text,
  otherwise the `persian` class (`panels.tsx:70-71`). So the Arabic Muyassar
  panel renders RTL and the English Ibn Kathir LTR regardless of what any
  manifest says.

## Attribution as it actually appears in the UI

- Per-pack credit lines are surfaced verbatim on the Data health screen —
  `{pack.attribution.creditLine} — {pack.attribution.publisher} (date)`
  (`desktop/src/screens/me/ContentHealthScreen.tsx:328-329`) and on the About
  screen (`AboutScreen.tsx:205-242`). For the two tafsir packs these strings,
  read from `content/tafsir-*/pack.json`, are:
  - "Tafsir al-Muyassar, Arabic; via Quran.com."
  - "Tafsir Ibn Kathir (abridged), English; via Quran.com."
- Licence status is never hidden or softened: the UI label function maps
  `unresolved` to "Licence unresolved" / «مجوز نامشخص» with `danger` tone
  (`desktop/src/screens/quran/lib.ts:86-95`), used by chips on verse rows and
  the focus screen (`AyahRow.tsx:103`, `AyahFocusScreen.tsx:247`), and the
  About screen states, quoted from `AboutScreen.tsx:124`:
  > "None of the imported packs reports a cleared licence. The text and
  > attribution are shown; a licence document we do not hold is not quoted or
  > invented here. Written permission is needed before release
  > (docs/content-sources.md)."

## Verified gaps (NOT IMPLEMENTED, checked against code)

- **No tafsir search.** The FTS table `ayah_search` has only Arabic,
  English-translation and Persian-translation columns
  (`core/src/contracts/db.sql:350-356`) and the import-side search-doc builder
  covers the same fields (`desktop/src/content/records.ts:580-597`); no
  code path indexes or queries tafsir text. Searching for a phrase found only
  in Muyassar returns nothing.
- **No per-verse scholar/source toggle.** `tafsirFor` returns *all* passages
  for the verse and the panel renders every one (`panels.tsx:54-77`);
  `tafsirSources()` is used only for titles (`hooks.ts:519-529`). There is no
  UI to pick, filter or order by scholar/pack.
- **Covered verses see nothing** (see the `covers_verse_keys` section): no
  expansion of grouped passages into the covered keys exists in build, import
  or lookup.
- **No tafsir HTML sanitising/strip step** in the pipeline — provider markup
  ships in payload text and renders literally; no code decodes it.
- **No tafsir packs beyond the two above** — no other scholar, language or
  kind is present under `content/`.
