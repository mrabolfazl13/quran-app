# UX specification — desktop shell (Tauri v2 + React + TypeScript)

Scope: what the shipped UI does today, traceable to files under `desktop/src`.
Where a designed behaviour is missing it says **Not implemented** and names the
file that would have to change. Persian/RTL is the default; English is a toggle.
Style follows the UI gate in `AGENTS.md`: loading / empty / error / offline /
success on every data surface, RTL-first, no clipped Arabic, dark mode, keyboard
navigation, no dead buttons.

---

## 1. Navigation model

Routing is a hand-written hash router (`desktop/src/app/router.tsx`), no
dependency. The header comment (lines 1–9) states the reason: one bundle must
run in three shells — the Tauri custom protocol, where `pushState` paths 404; a
localhost web build that may sit under any prefix; and a `file://` open during
development. Screens never touch `location`: they call `navigate(to)`
(`router.tsx:94`) and read params through `useRoute(routes)`
(`router.tsx:105`).

Mechanics:

- `parseHash` (`router.tsx:48`) splits `#/quran/ayah/2:255?tab=tafsir` into path
  `/quran/ayah/2:255` and query `{ tab: 'tafsir' }`; trailing slashes are
  stripped, a leading slash is added.
- `match` (`router.tsx:57`) matches segment by segment, percent-decoding `:params`.
  A pattern never matches a *longer* path: `/quran/ayah` does not answer for
  `/quran/ayah/nope/deep` (comment at `router.tsx:70`).
- `resolveRoute` (`router.tsx:74`) sorts patterns longest-first so
  `/hifz/session/:id` wins over `/hifz/session`.
- Unmatched routes render the shell's "There is no such page" state with the
  literal path in a mono line and a real "Back to home" button
  (`desktop/src/app/App.tsx:146–154`).

Assembly: each area exports `routes` + `nav` from its own
`desktop/src/screens/<area>/index.tsx`; `desktop/src/app/registry.ts:18–26`
concatenates them in the order home → quran → hifz → discover → me.

Load-time rule (`registry.ts:28–37`): for every nav entry, the target (hash and
query stripped, trailing slash normalised) must either be an exact registered
path or a strict parent prefix of one (so `/hifz` may advertise
`/hifz/session/:id`). Otherwise the module throws
`nav entry <to> resolves to no route (registered paths: …)` — a nav entry
without a route fails at import, before first paint, in dev and prod alike.

### Route table (as registered)

| # | Path | Title (fa / en) | Section | Component | Source |
| --- | --- | --- | --- | --- | --- |
| 1 | `/` | خانه / Home | home | `HomeScreen` | `screens/home/index.tsx:8` |
| 2 | `/quran` | فهرس سوره‌ها / Surah index | quran | `SurahIndexScreen` | `screens/quran/index.tsx:25` |
| 3 | `/quran/surah/:number` | خواندن سوره / Surah reader | quran | `SurahReaderScreen` | `screens/quran/index.tsx:26` |
| 4 | `/quran/ayah/:verseKey` | یک آیه / Single ayah | quran | `AyahFocusScreen` | `screens/quran/index.tsx:27` |
| 5 | `/quran/juz` | اجزای سی‌گانه / Juz index | quran | `JuzIndexScreen` | `screens/quran/index.tsx:28` |
| 6 | `/quran/juz/:juz` | جزء / Juz | quran | `JuzScreen` | `screens/quran/index.tsx:29` |
| 7 | `/quran/page/:pageNumber` | صفحهٔ مصحف / Mushaf page | quran | `PageScreen` | `screens/quran/index.tsx:30` |
| 8 | `/quran/bookmarks` | نشانک‌ها / Bookmarks | quran | `BookmarksScreen` | `screens/quran/index.tsx:31` |
| 9 | `/hifz` | حفظ — مأموریت امروز / Hifz — today's mission | hifz | `HifzTodayScreen` | `screens/hifz/index.tsx:20` |
| 10 | `/hifz/session` | نشست حفظ / Hifz session | hifz | `SessionRunnerScreen` | `screens/hifz/index.tsx:21` |
| 11 | `/hifz/session/:id` | گزارش نشست / Session report | hifz | `SessionReportScreen` | `screens/hifz/index.tsx:22` |
| 12 | `/hifz/items` | آیات حفظ / Hifz items | hifz | `ItemsScreen` | `screens/hifz/index.tsx:23` |
| 13 | `/hifz/review` | صف مرور / Review queue | hifz | `ReviewScreen` | `screens/hifz/index.tsx:24` |
| 14 | `/hifz/weak` | نقاط ضعف / Weak spots | hifz | `WeakScreen` | `screens/hifz/index.tsx:25` |
| 15 | `/hifz/confusion` | اشتباه با آیات مشابه / Confused similar ayat | hifz | `ConfusionScreen` | `screens/hifz/index.tsx:26` |
| 16 | `/hifz/progress` | پیشرفت حفظ / Hifz progress | hifz | `ProgressScreen` | `screens/hifz/index.tsx:27` |
| 17 | `/discover` | جستجو و کاوش / Search & discover | discover | `SearchScreen` | `screens/discover/SearchScreen.tsx:331–333` |
| 18 | `/discover/mutashabihat` | آیات مشابه (متشابهات) / Similar ayat (mutashabihat) | discover | `MutashabihatScreen` | `screens/discover/MutashabihatScreen.tsx:339–341` |
| 19 | `/discover/concepts` | مفهوم‌ها / Concepts | discover | `ConceptsScreen` | `screens/discover/ConceptsScreen.tsx:175–177` |
| 20 | `/discover/word/:chapter/:position` | واژه / Word | discover | `WordPeekScreen` | `screens/discover/WordPeekScreen.tsx:196–198` |
| 21 | `/me` | تنظیمات / Settings | me | `SettingsScreen` | `screens/me/SettingsScreen.tsx:465–467` |
| 22 | `/me/content` | سلامت داده / Data health | me | `ContentHealthScreen` | `screens/me/ContentHealthScreen.tsx:500–502` |
| 23 | `/me/backup` | پشتیبان و بازیابی / Backup & restore | me | `BackupScreen` | `screens/me/BackupScreen.tsx:563–565` |
| 24 | `/me/notes` | یادداشت‌ها / Notes | me | `NotesScreen` | `screens/me/NotesScreen.tsx:254–256` |
| 25 | `/me/about` | درباره / About | me | `AboutScreen` | `screens/me/AboutScreen.tsx:249–251` |

25 registered routes. Param forms: `/quran/page/604` (`:pageNumber`),
`/quran/ayah/2:255` (`:verseKey` — the colon inside a segment is legal, `match`
splits on `/` only), `/quran/surah/18`, `/quran/juz/15`, `/hifz/session/<id>`,
`/discover/word/2/255`.

Query parameters are parsed once by the router and handed to screens as
`props.query` — no screen touches `location`. Only two keys are actually read:
`?vk=` on `/quran/surah/:number` (`SurahReaderScreen.tsx:26`, deep-links one
ayah in the feed) and on `/discover/mutashabihat`
(`MutashabihatScreen.tsx:58`). The `?tab=tafsir` form in `router.tsx:47` is an
illustration only — no screen reads a `tab` parameter (tafsir and notes are local
disclosures in `quran/panels.tsx`), and `?item=`, which `/hifz/items` emits, is
read by nobody (Gap G2).

## 2. Sections and shell

The shell (`desktop/src/app/App.tsx`) owns two things only: where storage came
from, and which screen is mounted. Screens render no chrome of their own, so the
nav cannot drift between areas.

### Sidebar

Five entries, in `NAV` order (home → quran → hifz → discover → me,
`app/registry.ts:26`), labels from each area's `nav` export:

| Order | Label (fa / en) | Hash target | Section key matched |
| --- | --- | --- | --- |
| 1 | خانه / Home | `/` | `home` |
| 2 | قرآن / Quran | `/quran` | `quran` |
| 3 | حفظ / Hifz | `/hifz` | `hifz` |
| 4 | کاوش / Discover | `/discover` | `discover` |
| 5 | من / Me | `/me` | `me` |

Rendering (`App.tsx:72–96`): `<nav aria-label="بخش‌ها / Sections">` containing a
`<ul>`; each item is a real `<a href="#…">` so middle-click / copy-address work,
with `onClick` calling `event.preventDefault()` then `navigate(item.to)` — and
deliberately letting Ctrl/Cmd-click through to the browser
(`App.tsx:83–87`). The active entry is decided by
`resolved.route?.section ?? ''` (`App.tsx:137`), so a detail page keeps its
parent lit: `/quran/page/604` still highlights قرآن because all six quran routes
declare `section: 'quran'` (`screens/quran/index.tsx:20–22`). Active styling is
`.navlink.is-active` (`app/shell.css:64–68`, accent-soft background + semibold);
semantics are carried by `aria-current="page"`.

Geometry (`app/shell.css`): CSS grid `var(--sidebar-width) minmax(0,1fr)` with a
sticky 100vh sidebar (268 px, `styles/tokens.css:71`); all direction-sensitive
gaps use logical properties (`border-inline-end`, `margin-inline-start`) because
the chrome can flip LTR at runtime. Below 900 px the sidebar becomes a
horizontally scrolling row (`shell.css:108–125`).

### Header controls

Left: `<h1 class="header__title">` with the route title (`router.tsx`
`RouteDef.title`). Right (`App.tsx:40–70`, in order):

- **Offline chip** (`App.tsx:18–38`): rendered only when `navigator.onLine` is
  false, listening to `online`/`offline` events. Label آفلاین, tone `info`,
  tooltip "No feature needs the network". Being offline is stated as a fact,
  never as an error — matching AGENTS.md rule 4.
- **Mode chip** (`App.tsx:45–51`): rendered only once `info` resolves. Text is
  `دسکتاپ` when `info.mode === 'tauri'`, otherwise `مرورگر (توسعه)`; tone is
  `accent` when `info.isShippedPath` and `warn` otherwise; the tooltip is
  `${info.label} · ${info.database ?? '—'}`. `tauriGateway.ts:279` sets
  `isShippedPath: true`; `devGateway.ts:212–221` sets mode `dev`, label
  "Browser dev shell — not the packaged app", database
  "IndexedDB (user rows) + in-memory content", `isShippedPath: false`. This is
  the only place the dev/shipped distinction is printed in the header.
- **3-state theme button** (`App.tsx:52–59`): cycles
  `dark → light → system → dark`, glyph label `◐` dark / `◑` light / `◒` system,
  tooltip "پوسته: <pref> — برای تغییر کلیک کنید". It is a cycle, not a toggle,
  so `system` is reachable.
- **EN / فا toggle** (`App.tsx:60–67`): shows `EN` while the interface is
  Persian (click switches to English) and `فا` while it is English.

### BootBoundary and document-title sync

`BootBoundary` (`App.tsx:99–117`) wraps the whole shell and is the data-health
probe for the case where *storage itself* is the problem. Its `useAsync` throws
when `app-state.error` is set, and throws `هنوز باز نشده است / Storage has not
opened yet` while `info` is still null; the `StateBoundary` uses
`isEmpty={() => false}` so the empty branch is unreachable by construction,
`skeleton` is the explicit string "باز کردن ذخیره‌گاه… / Opening storage…" with
`role="status"` (`App.tsx:112`),
and retry calls `reload()` which re-runs `createGateway()`
(`app/app-state.tsx:105–127`). No screen can therefore mount against a closed
database: the shell is showing an error state instead.

Title sync (`App.tsx:123–130`): the header title is
`resolved.route.title(tr)` or `صفحه پیدا نشد / Page not found`, and an effect
writes `` `${title} — قرآن` `` to `document.title` on every change, so taskbar /
window captions follow the route and the interface language.

Unknown hash: `.state.state--empty` with "There is no such page", the literal
path in `.mono`, and a primary button that navigates to `/` (`App.tsx:146–154`).

## 3. Screen behaviours

### The shared contract

Every screen reads through `useApp().gateway` (`app/app-state.tsx:170–174`) and
renders through one pair of primitives (`desktop/src/ui/async.tsx`):

- `useAsync(query, deps)` → `{ status: 'loading' | 'ready' | 'error', value, error,
  refresh, setValue }`. A token ref (`async.tsx:32–52`) discards late answers from
  superseded runs, which is what keeps fast typing in search from showing stale
  hits. `refresh()` bumps an epoch and re-runs; `setValue()` patches after a local
  write.
- `<StateBoundary>` renders, in this order: gateway-level failure
  (`.state--error`, `role="alert"`, retry → `reload()`), `skeleton` while loading
  (`role="status" aria-busy="true"`), the query's error (message in `.mono` +
  retry when `onRetry` is given), the empty state (`emptyTitle`, `emptyBody`,
  `emptyAction`), the dev-shell band, then `children(value)`.
  `async.tsx:6–9` states the enforcement: a screen that forgets the boundary has
  no value to read, so it cannot compile.

`isEmpty` per screen is the honest definition of "nothing here yet" — it is
always a predicate over stored rows, never a guess. Screen inventory: **25 routes
→ 25 components across 21 screen files** (`JuzIndexScreen` and `JuzScreen` share
one file; the Me area is five files).

| Screen | Primary user action | Gateway / facade reads (`gateway/types.ts`) | States it can show |
| --- | --- | --- | --- |
| `/` `HomeScreen` | import packs, or open any stat card (`navigate(to)` per card, `HomeScreen.tsx:15–23`) | `homeStats(new Date())`, `importFromContent()`, `importReport()` | loading ("Reading stats…"), empty = `!hasContent` + import CTA, error + retry, dev band |
| `/quran` `SurahIndexScreen` | open a surah; filter by name (local `query` state, `setQuery('')` clears) | `surahs()` | loading, empty = `surahs().length === 0` ("the index is built from the core text pack"), error, dev band |
| `/quran/surah/:number` `SurahReaderScreen` | open a `?vk=` deep link (scrolls to that ayah), bookmark the chapter and per-ayah marks (through `useUserMarks`) | `surah`, `ayahsByChapter`, `bookmarks`, `addBookmark`, `removeBookmark`; `translations` batch in `AyahFeed` | loading ("Reading the surah…"), empty = `ayahs.length === 0` with a `/me/content` CTA ("nothing is fabricated to fill it", `:45–56`), invalid `:number` → thrown "That surah number is not valid", unknown chapter → thrown "No such surah has been imported" (`:31–33`), error + retry, dev band |
| `/quran/ayah/:verseKey` `AyahFocusScreen` | toggle bookmark / hifz item (`aria-pressed`), copy the Uthmani text verbatim (`quran/lib.ts:122–142`), open in reader / juz / page / mutashabihat, prev & next in mushaf order | `ayah`, `words`, `translationOptions`, `translations`, `surah` (±1 chapter), `similarTo`, `relationsOf`, `tafsirSources`, `setReadingPosition` | loading, invalid key → thrown "That verse key is not valid" (`:103`), unset value → early-return state (`:136`), error, dev band; panels show their own tafsir/note empties (`quran/panels.tsx`) |
| `/quran/juz` `JuzIndexScreen` | open a juz | `juzList()` | loading, empty = "no juz derived" (`JuzScreen.tsx:28–38`), error, dev band |
| `/quran/juz/:juz` `JuzScreen` | open an ayah / jump to the page | `ayahsByJuz(juz)` via `AyahFeed` | loading, empty = juz holds no ayah, invalid `:juz` clamped by `asInt(…,1,JUZ_COUNT)`, error, dev band |
| `/quran/page/:pageNumber` `PageScreen` | prev/next page, page-jump form (`navigate('/quran/page/'+target)`), open first ayah | `ayahsByPage`, `words`, `surah` | loading ("Building the mushaf page…"), empty = page has no ayah **and** a second refusal state when line metadata is missing (`:187–210`), diagnostics alerts, error, dev band |
| `/quran/bookmarks` `BookmarksScreen` | open a bookmark, remove it (`removeBookmark`, `:160`) | `bookmarks()`, `removeBookmark` | loading, empty ("every ayah in the surah reader has a bookmark button"), filter-empty (`:119` "Show all"), error, dev band |
| `/hifz` `HifzTodayScreen` | start a session / add ayat | facade `status()`, `todayPlan(new Date())`; `hifzItems('active')` | loading ("Computing today's plan…"), empty = no items, error incl. `EngineNotIntegratedError`, dev band; engine-status chip is a 4th state (checking / integrated / absent) |
| `/hifz/session` `SessionRunnerScreen` | start → answer each step → finish | facade `startSession`, `probeForStep`, `submitRecall`, `finishSession`; gateway `recallAttempts`, `hifzItems`, `words`, `ayah` | pre-session panel, start-error state + retry, empty = plan has no steps (`:116–133`), per-step loading / no-probe empty (skip CTA), submit error, verdict state, read-back failure chip (`:511`) |
| `/hifz/session/:id` `SessionReportScreen` | open a step's ayah | `hifzSessions`, `recallAttempts` | loading, empty = "no session with this id is stored" (`:33–44`), error, dev band; unfinished session prints that instead of estimating |
| `/hifz/items` `ItemsScreen` | add (`addHifzItem`), change status (`setHifzItemStatus`), remove (`removeHifzItem`), derive fingerprint (`deriveSegmentation`) | `hifzItems`, `addHifzItem`, `removeHifzItem`, `setHifzItemStatus`, `ayah`, `ayahsByChapter`, `hifzSegments`, `anchorWords`, `hifzTransitions`, `recallAttempts` + facade `deriveSegmentation` | loading, empty set (`:58–63`), fingerprint empty (`:281–287`: nothing derived **and** no stored rows), write errors printed `dir="auto"` (`:172`, `:251`), engine-not-integrated error |
| `/hifz/review` `ReviewScreen` | open a queued ayah, start a session | facade `todayPlan`; `hifzItems()` | loading, empty = "no reviews owed today" (`:32–43`), error, dev band |
| `/hifz/weak` `WeakScreen` | start a session / open item | facade `todayPlan`; `hifzItems`, `recallAttempts` | loading, empty = no weak plan entries **and** no repeat offenders (`:67–73`), error, dev band |
| `/hifz/confusion` `ConfusionScreen` | engine re-propose (`refreshConfusionGroups`), open members, start session | `confusionGroups()` + facade | loading, empty (`:67–72`), refresh error (`:62`), dev band |
| `/hifz/progress` `ProgressScreen` | start first session / open session report | `hifzItems`, `hifzSessions(20)`, `recallAttempts` | loading, empty = no attempts and no sessions (`:56–62`), error, dev band |
| `/discover` `SearchScreen` | type query (200 ms debounce), pick field, click a suggestion token, "Search all fields" | `search(query,{field,limit:50})`, `searchBackend()`, `searchBackendNote?()`, `ayahsByChapter(1/112)` | loading, "type to search" idle, zero-results state with field-specific advice (`:251–278`), no-content hint, error + retry; `isEmpty={() => false}` deliberately, so an empty result list is *content*, not the empty state |
| `/discover/mutashabihat` `MutashabihatScreen` | enter a verse key → `navigate('/discover/mutashabihat?vk=…')` (`:291–292`), pick a bookmarked ayah | `ayah`, `similarTo`, `words`, `bookmarks` | loading, empty = no stored candidates (`:92–97`), empty bookmark source (`:311`), invalid verse key message, error, dev band |
| `/discover/concepts` `ConceptsScreen` | read the explanation / go to word data | `counts()` | loading, error, and the documented honest empty: `isEmpty={() => false}` because the number shown is `counts().concepts` and no `concepts()` read exists on `DataGateway` |
| `/discover/word/:chapter/:position` `WordPeekScreen` | search the root, go back to search | `surah`, `ayahsByChapter`, `words`, `search` | loading, empty = "this word was not found" (`:84–90`), missing-root disclosure text, error, dev band |
| `/me` `SettingsScreen` | change any setting (immediate `setSetting`) | `settings`, `setSetting`, `counts`, `translationOptions` | loading, empty = no settings registered (`:168–169`), error; controls built from `SETTING_DEFS` (`core/src/backup/settings.ts`) so out-of-range/enum values cannot be written |
| `/me/content` `ContentHealthScreen` | re-import (`importFromContent`), reset content (`resetContent`) behind a `ConfirmBox` | `info`, `counts`, `packs`, `importReport`, `searchBackendNote` | loading, empty = "no pack imported" with import CTA (`:154–167`), error, dev band, engine version + search-backend notes |
| `/me/backup` `BackupScreen` | export → write file, read file, restore (`ConfirmBox` gated) | `counts`, `info`, `settings`, `exportBackup`, `writeBackupFile`, `backupFiles`, `readBackupFile`, `importBackup` | loading, empty = "no backup file exists yet" (`:260–262`), success `role="status" aria-live="polite"` (`:327`), failure `role="alert" aria-live="assertive"` (`:543`), malformed file → message not crash |
| `/me/notes` `NotesScreen` | save (`saveNote`), delete (`deleteNote` after `ConfirmBox`), jump to ayah | `recentNotes(500)`, `saveNote`, `deleteNote` | loading, empty = "no notes yet" (`:117–127`), window-full notice (500-row cap is stated), error, dev band |
| `/me/about` `AboutScreen` | read attribution and licences | `packs()` | loading, empty = "no content pack imported" (`:107–112`), error, dev band |

Shared reader plumbing (`desktop/src/screens/quran/hooks.ts`) is part of this
contract: word rows and translations are fetched in bounded batches
(`WORD_CONCURRENCY = 3`, `hooks.ts:26`) because a chapter has up to 286 ayat;
every write (bookmark, hifz item, setting, reading position) is optimistic over
local state and re-read only on failure (`hooks.ts:1–12`). `recordReading` is
called with a dwell time (`hooks.ts:474`), which is what feeds
`HomeStats.recentReading`.

## 4. Labelled degraded states

The rule the code follows is: a degraded path is *named on screen*, never
silently substituted. Five such labels exist today.

1. **Dev shell badge.** Condition: `info && !info.isShippedPath` inside
   `StateBoundary` (`desktop/src/ui/async.tsx:138`) — i.e. any screen that
   renders through the boundary, whenever the live gateway is `DevGateway`
   (`devGateway.ts:220` hard-codes `isShippedPath: false`). Output: a
   `.shell-note` band above the content reading "پوستهٔ توسعه — داده در
   حافظهٔ مرورگر است و با بستهٔ نصبی فرقی دارد", with the database label as its
   `title`. It is printed *in addition* to the real content, so a reviewer sees
   both the warning and the same components the shipped path renders.
2. **Search backend label.** Condition: the search panel has a loaded value —
   `SearchScreen.tsx:185–194` always renders a `Chip tone="info"` containing the
   raw backend id in `.mono` plus `backendLabel()` (`SearchScreen.tsx:47–58`):
   `core-engine` → "رتبه‌بندی قطعی موتور core", `sqlite-fts5` → "SQLite
   full-text search (FTS5)", `like` → "مطابق‌سازی ساده، بدون FTS5", `memory-index`
   → "نمایهٔ در حافظهٔ همین صفحه". The id comes from `gateway.searchBackend()`
   (`desktop/src/gateway/tauriGateway.ts:333–337`,
   `devGateway.ts:616–617`).
3. **"Why the stronger backend was skipped".** Condition:
   `gateway.searchBackendNote?.()` returns non-null
   (`SearchScreen.tsx:122`, rendered at `:192`; also
   `ContentHealthScreen.tsx:91`). In the shipped path the note is chosen in
   `tauriGateway.pickSearch()` (`:306–312`): `"SQLite FTS5 over ayah_search;
   core/src/search is used by the dev shell"` when
   `this.schema?.searchBackend === 'fts5'`, else `"FTS5 module unavailable in
   this SQLite build — literal LIKE matching is active"`. In the dev shell the
   default note is the `MemorySearchService` constructor default
   `"browser dev shell index — not the shipped SQLite path"`
   (`desktop/src/gateway/search.ts:298–305`). Gap: `CoreEngineSearchService`
   (`search.ts:102–103`) is implemented but **not instantiated by either
   gateway**, so `core-engine` can never appear in the UI today; the comment at
   `tauriGateway.ts:299–303` claims the dev shell uses it while
   `devGateway.ts:206` constructs `MemorySearchService`. File to change:
   `desktop/src/gateway/devGateway.ts` (or the comment).
4. **Licence `unresolved` chips.** Condition: `licenseStatus === 'unresolved'`
   on a pack row or translation option. Labels: `licenseLabel()` /
   `licenseTone()` in `desktop/src/screens/quran/lib.ts:86–92` render "مجوز
   نامشخص / Licence unresolved" with tone `danger`, and
   `desktop/src/screens/me/shared.tsx:70–75` renders "مجوز نامشخص / licence
   unresolved". `desktop/src/screens/quran/TranslationPicker.tsx:1–8` states the
   rule that an `unresolved` pack must not read like a licensed one, so the chip
   travels with the option. `desktop/src/screens/me/AboutScreen.tsx:7–10`
   records that every shipped pack currently declares `unresolved`, so this chip
   is expected on first run, not an anomaly. The enum itself is enforced by the
   schema CHECK constraints (`desktop/src/db/schema.generated.ts`,
   `content_pack.license_status`, `audio_track.license_status`).
5. **Content not imported (onboarding).** Condition: `HomeStats.hasContent` is
   false, which is a `COUNT()` over imported core rows (`gateway/types.ts:266`
   "False until the core pack is imported"); `HomeScreen.tsx:40` declares
   `isEmpty={(value) => !value.hasContent}` and the boundary then shows the
   onboarding state with its CTA (next bullet). The same condition surfaces in
   search as text, not a state: `SearchScreen.tsx:315–324` prints "no content
   imported yet — import the packs to enable search" when the sample-token query
   found no ayah rows.
6. **Hifz "engine not integrated".** Condition: `loadHifzEngine()` cannot find
   the required `@quran/core` hifz exports, or the dynamic import throws
   (`desktop/src/engine/hifzEngine.ts:192–208`, missing-export list at
   `:196–201`). Every facade method then rejects with the typed
   `EngineNotIntegratedError` (`hifzEngine.ts:168–179`, code
   `HIFZ_ENGINE_NOT_INTEGRATED`) from `engine()`
   (`desktop/src/engine/hifzFacade.ts:89`); screens render it as their error
   state (`StateBoundary` `.state--error`, `role="alert"`). `/hifz` additionally
   prints the capability as a chip before any query runs:
   `FacadeStatusChip` (`HifzTodayScreen.tsx:28–44`) shows
   "موتور حافظه یکپارچه است · <detail>" (tone info) or
   "موتور حافظه در این ساخت نیست" (tone danger). `hifzFacade.ts:17–19` is
   explicit that there is no fallback scoring anywhere above it.

Empty-state CTAs that perform a real action (no dead ends):

| Screen | CTA | Effect |
| --- | --- | --- |
| `/` (home, no content) | "وارد کردن بسته‌های محتوا" | `gateway.importFromContent()`, then `refresh()`; failure alert prints `issue.stage: issue.message` (`home/HomeScreen.tsx:60–82`) |
| `/quran` | Data health / import | see `screens/quran/SurahIndexScreen.tsx:67` |
| `/quran/page/:n` | "سلامت داده" + "فهرس سوره‌ها" | `LinkButton` to `/me/content`, `/quran` (`quran/PageScreen.tsx:97–106`) |
| `/hifz` | "افزودن آیات" | `LinkButton` to `/hifz/items` (`HifzTodayScreen.tsx:68–72`) |
| `/hifz/session` (no probe) | "رد شدن از این گام" | `onSkip()` advances `stepIndex` (`SessionRunnerScreen.tsx:301`) |
| `/hifz/weak`, `/hifz/confusion`, `/hifz/progress` | "شروع نشست" | `LinkButton` to `/hifz/session` (`WeakScreen.tsx:72`, `ConfusionScreen.tsx:72`, `ProgressScreen.tsx:61`) |
| `/hifz/items` | "وضعیت داده" | `LinkButton to="/me/data"` — **dead**: the registered path is `/me/content` (`ItemsScreen.tsx:286` vs `me/ContentHealthScreen.tsx:500`); it lands on the shell's "There is no such page" state. Gap, file: `desktop/src/screens/hifz/ItemsScreen.tsx` |
| `/discover/word/:c/:p` | "بازگشت به جستجو" | `LinkButton` to `/discover` (`WordPeekScreen.tsx:89`) |

## 5. RTL, i18n, typography

**Translation mechanism.** There is no catalogue and no i18n library: `Tr` is
`(fa, en) => string` (`desktop/src/app/app-state.tsx:32`) implemented at
`:141` as `lang === 'en' ? en : fa`. Screens inline both strings at the call
site. Consequence for the gate: any new label must be written twice, and a
screen that shows only one language is visible in the code, not at runtime.

**Where `lang` / `dir` are set.**

- Before React: an inline script in `desktop/index.html:11–24` reads
  `localStorage['quran.theme']` (falling back to
  `matchMedia('(prefers-color-scheme: dark)')`) and
  `localStorage['quran.uiLang']` (default `fa`), then sets
  `documentElement.dataset.theme`, `.lang` and `.dir`
  (`rtl` for `fa`/`ar`, else `ltr`). The static markup already declares
  `<html lang="fa" dir="rtl">` (`index.html:2`). This is what prevents a
  theme/language flash on first paint.
- After React: an effect in `app-state.tsx:98–103` re-applies the same three
  attributes whenever `theme` or `lang` changes, so the runtime toggle in the
  header stays in sync with the pre-paint values.

**Persistence — deliberately twice** (`app-state.tsx:9–13`, `129–139`):

| Preference | localStorage key | `settings` table key | Written by |
| --- | --- | --- | --- |
| Interface language | `quran.uiLang` | `interfaceLanguage` | `applyLang()` → `writeLocal` + `gateway.setSetting` |
| Theme | `quran.theme` | `theme` | `applyThemePref()` |
| UI font scale | `quran.fontScale` | see Settings screen | `cacheFontScales()` (`me/font-scale.ts:103–110`) |
| Quran font scale | `quran.quranFontScale` | see Settings screen | same |

localStorage is the pre-paint cache only; on open, stored settings *win over*
the browser copy (`app-state.tsx:114–116`) because the database is the source of
truth and travels with a backup. `setSetting` failures are swallowed
(`.catch(() => undefined)`) so a disabled-storage browser cannot break the
toggle — in that case the preference applies for the session only.

**Font scales are applied twice too**: `screens/me/index.tsx:19` calls
`applyCachedFontScales()` at module load (before React paints), and the Me
screens re-apply the authoritative values from the `settings` table. Scaling
rewrites the `rem`-based tokens on `<html>`
(`me/font-scale.ts:84–100`): `--fs-100…--fs-900` for chrome (clamped 0.5–3) and
`--mushaf-size` / `--arabic-size` for Quran script (clamped 0.5–4), with base
values read back out of `styles/tokens.css` so that file remains the source of
truth.

**Bidi isolation (the actual CSS).** Mixed Arabic/Latin runs never inherit the
chrome direction:

- `.arabic`, `.quran-text`, `.arabic-inline`, `.persian` each set
  `direction: rtl; unicode-bidi: isolate` (`desktop/src/ui/ui.css:295–318`), and
  `.word` — one token of revelation — is isolated on its own
  (`ui.css:332–335`), which is what keeps a Latin ayah number or gloss from
  reordering the harakat around it.
- The mushaf line is double-guarded: `dir="rtl" lang="ar"` on the element
  (`quran/PageScreen.tsx:332`) plus `.quran-text` isolation.
- Ids, timestamps, engine reason codes and error strings are wrapped in
  `dir="auto"` or the `.ltr-iso` / `.rtl-iso` helpers (e.g.
  `hifz/SessionRunnerScreen.tsx:141,143,505`, `hifz/SessionReportScreen.tsx:62`,
  `hifz/HifzTodayScreen.tsx:145`). `dir="auto"` on the search input lets a Persian
  query be entered while the chrome is English (`discover/SearchScreen.tsx:163`).
- Gaps that rely on `margin-inline-start` etc.: `ui.css:259–266`
  (`.meter__label`), `shell.css:34` (sidebar border).

**Quran font stack.** Loaded families are `Amiri Quran`, `Amiri`, `Vazirmatn`,
`Inter`, all bundled as `@font-face` with `font-display: block` and
`unicode-range` slices (`desktop/src/styles/fonts.css`, generated by
`scripts/fetchFonts.mjs` — "the shipped app never fetches a font at runtime").
Chrome uses `'Vazirmatn', 'Inter', system-ui, sans-serif`
(`app/shell.css:13`); Quran display uses `'Amiri Quran', 'Amiri', serif`
(`ui.css:296,302`, mirrored in `quran/quran.css`, `hifz/hifz.css:57`,
`discover/discover.css:31,78`). `fonts.css:120–128` also declares documented
fallback stacks (`--font-quran` with Scheherazade New / Noto Naskh Arabic /
Traditional Arabic, `--font-fa`, `--font-latin`, `--font-mono`). **Gap:** no CSS
rule consumes `--font-quran` / `--font-arabic` / `--font-fa`, so the documented
fallback chain is inert and the literal `'Amiri Quran', 'Amiri', serif` wins
everywhere. Files to change: `desktop/src/ui/ui.css`,
`desktop/src/screens/{quran,hifz,discover}/*.css`.

**Line height / clipping.** `--lh-quran: 2.15` exists specifically so stacked
harakat and kasratayn cannot collide (`styles/tokens.css:24–25`); `--lh-ui: 1.6`
for chrome. Mushaf size is `2rem` and rem-based so a reader can scale it
(`tokens.css:32–34`). Mono strings use `word-break: break-word` rather than
clipping (`ui.css:34–38`); truncation is opt-in via `.truncate`.

**Provider text is rendered byte-verbatim.** The stored Uthmani text is
*deliberately not Unicode NFC*: the mushaf encodes combining marks
shadda-then-fatha (`0651 064E`) and NFC reorders them
(`core/src/mushaf/render.ts:5–9`, `docs/current-state.md:47–48`). Therefore:

- Normalisation exists only for *comparison*, never for display.
  `normalizeWord` strips harakat, unifies the alef family and folds
  Persian/Arabic digits and equivalents (`core/src/normalize/arabic.ts:16–62`).
- The quran render path prints raw bytes: `AyahText.tsx:44–58` maps each
  `AyahWordRow.textUthmani` into its own `<span className="word">` with an
  inserted `' '` and, before the word rows arrive, prints `textUthmani` of the
  ayah as one untouched string (`AyahText.tsx:35–42`). No trim, no join, no
  `normalizeWord` call anywhere in the file.
- Search reuses that equality only to decide which token to mark, and re-inserts
  the *original* excerpt text (`discover/SearchScreen.tsx:60–88`, header
  comment `:1–14`).
- The mushaf renderer asserts the same rule: `renderPage` "only ever inserts
  whitespace" between tokens (`core/src/mushaf/render.ts:10–14`).

## 6. Mushaf page vs ayah-feed reading modes

Two reading modes, one shared token source, and a hard rule that the printed
page is metadata, not typography.

**`/quran/page/:n` — the printed grid.** `PageScreen`
(`desktop/src/screens/quran/PageScreen.tsx`) loads `gateway.ayahsByPage(page)`
then `gateway.words(verseKey)` per ayah, flattens the word rows and hands them to
`buildMushafLayout(layoutWords, ayahs)` from `@quran/core`
(`PageScreen.tsx:35–48`). The layout engine groups tokens by the per-word
`page_number` (1..604) and `line_number` (1..15) columns that the content
pipeline captured from the provider's mushaf rows — the DDL states both are
NOT NULL because "a row without them is a content-pipeline failure, so the
import stops rather than defaulting to a page"
(`desktop/src/db/schema.generated.ts`, `ayah_word` comment; index
`ayah_word_page_idx ON ayah_word(page_number, line_number)`).
`core/src/mushaf/layout.ts:1–25` documents the policy: the word row's page and
`Ayah.page` disagree on 56 of 6236 ayahs, so the default is `anchor` (place on
`Ayah.page` first, fall back to the word row), every correction becomes a
reported diagnostic, nothing is moved, dropped or appended silently, and
`MAX_MUSHAF_LINES = 15` is measured (488 of 604 pages use exactly 15 lines), not
invented.

Guards in the UI:

- A page is drawable **only** when every token on it declares a line
  (`withLines.length === words.length`, `PageScreen.tsx:41–43`) — "one guessed
  line would misplace the rest of the page".
- Otherwise an honest empty state names the count
  (`${withoutLine} of ${words.length}` rows carry no line number), refuses to
  guess, and offers `/me/content` plus the ayah view of the same page
  (`PageScreen.tsx:187–210`).
- Layout diagnostics are printed, capped at six, as `code · subject · detail`
  (`PageScreen.tsx:66–70`), plus an explicit "layout is not complete" alert when
  `drawn.isComplete` is false (`:162–169`), and a `missingWords` alert for
  references with no word row (`:308–315`).
- `renderPage(drawn, layoutWords)` produces the lines; each provider line is one
  `.mushafline` block with its line number, gaps are rendered as visible
  "surface band" placeholders rather than collapsed
  (`:321–355`, `drawn.emptyLineNumbers` counted at `:287–291`).

**Why text is never re-flowed by font metrics.** Stated twice and load-bearing:
the screen's own caption ("The layout is built only from each word's page and
line number; the text is never re-flowed by font metrics",
`PageScreen.tsx:156–161`) and the engine header ("A reader that re-flows the
text with font metrics produces a *different* book",
`core/src/mushaf/layout.ts:6–8`). Re-flowing would also require measuring glyphs
that are `font-display: block` and scale with a user-set `--mushaf-size`
(`me/font-scale.ts`), so a font-size change would move verses across pages —
which is exactly the immutability violation AGENTS.md rule 1 forbids. The corollary
is that the mushaf mode is **resolution-independent**: `--mushaf-size` can only
make a line wrap the page, never re-order it, and the page number stays the
address (1..604, `PAGE_COUNT` from `quran/lib.ts`).

**`/quran/surah/:number` — the ayah feed.** `SurahReaderScreen` reads
`gateway.ayahsByChapter`, `gateway.surah`, `gateway.bookmarks` and writes
`addBookmark` / `removeBookmark` (`screens/quran/SurahReaderScreen.tsx`), then
renders an ayah feed (`quran/AyahFeed.tsx`, which fetches `gateway.translations`
for the visible pack) with word-level ayah text through `AyahText`. This mode is
continuous, font-metric-flowed prose and is therefore *not* presented as a
mushaf page; navigation to the printed page is a separate link. Reading progress
is stored per ayah + `scrollFraction` via `gateway.setReadingPosition`
(`quran/AyahFocusScreen.tsx`), which is what `/` (Continue reading) shows
(`gateway/types.ts:255–256`, `HomeScreen.tsx:88–110`).

## 7. Hifz surfaces

**Who decides what.** `desktop/src/engine/hifzFacade.ts` is the only surface the
hifz UI may call, and it owns storage only: "Every judgement — what is due, how
a recitation scored, which band an item belongs to, what a session report says —
comes from `core/src/hifz` through the adapter in `./coreHifzEngine.ts`"
(`hifzFacade.ts:1–20`). The UI layer never scores recall, schedules review or
decides bands (`desktop/src/engine/hifzEngine.ts:9–21`), and the labels in
`desktop/src/screens/hifz/shared.tsx:1–8` are translations of contract values
(`RecallMode`, `ErrorKind`, `StabilityBand`, cue kinds), never new judgements.

**Where the numbers come from.** The engine's world is assembled from stored
rows only, in `buildContext()` (`hifzFacade.ts:254–287`):
`hifzItems()`, `recallAttempts(undefined, 5000)`, `confusionGroups()`,
`hifzSegments()`, `anchorWords()`, `hifzTransitions()`, `allAyahTexts()`, plus
`newAyahs` derived as "active items that have never been attempted". Per screen:

- **`/hifz` today/plan** — `facade.todayPlan(new Date())` +
  `gateway.hifzItems('active')`. Steps count =
  `newAyahs + reviewItems + weakItems` (`HifzTodayScreen.tsx:87`); the estimated
  minutes chip prints `plan.estimatedMinutes` with an explicit "exact, not
  rounded" tooltip and the seconds expansion next to it (`:104–109`). The band
  histogram is `bandCounts(items)` — a count over stored item rows, "not a score"
  (`:21–25`, header `:1–8`). The plan is also persisted through
  `gateway.saveDailyPlan(plan.date, JSON.stringify(plan))`
  (`hifzFacade.ts:112–117`), so `dailyPlan()` on the gateway is a real read path.
- **`/hifz/session` runner (probe → recall → verdict)** — steps come from
  `facade.startSession(new Date(), 0)`; each cue from
  `facade.probeForStep(session, stepIndex, new Date())`
  (`SessionRunnerScreen.tsx:202–209`). The target ayah stays hidden until
  submission (`revealedKey` is null before a verdict, `:245`). Scoring happens
  only inside `facade.submitRecall()`, which calls the engine's `classify`
  (`hifzFacade.ts:167`) and stores the resulting `RecallAttempt`
  (`:186`). The verdict panel then **re-reads the evidence from storage** —
  `gateway.recallAttempts(attempt.itemId, 1)` and `gateway.hifzItems()` — and
  prints the stored row id/accuracy/mode/completedAt, with a danger chip
  "the attempt could not be read back!" if the row is missing
  (`SessionRunnerScreen.tsx:279–287`, `:503–513`). Word marks come from
  `attempt.errors` as stored; `WordAlignment` renders them and the screen states
  "the app never re-scores" (`:489–494`).
- **`/hifz/items`** — add/status/remove via `addHifzItem`,
  `setHifzItemStatus`, `removeHifzItem`, with the loss count printed first
  (stored `recallAttempts` per item, `ItemsScreen.tsx:58–63`). The "بافت حافظه"
  disclosure calls `facade.deriveSegmentation(itemId, new Date())` and shows it
  beside the *stored* `hifzSegments` / `anchorWords` / `hifzTransitions` rows;
  segmentation is deliberately not persisted
  (`hifzFacade.ts:11–15`), which is why the empty fingerprint state is
  "nothing derived **and** no stored rows" (`ItemsScreen.tsx:281–287`).
- **`/hifz/review`** — `plan.reviewItems` in the engine's own order (core sorts
  priority desc, dueAt asc, verseKey asc — the screen keeps it,
  `ReviewScreen.tsx:1–8`), with the stored `reason` and factor contributions
  shown verbatim. Those reason strings are the engine's own, including the
  honest fallback "no segment data — <x> estimated from item stability"
  (`core/src/hifz/review.ts:246–253`).
- **`/hifz/weak`** — two sources only: `plan.weakItems`, and a tally of the error
  kinds actually stored in `recallAttempts`; "the accuracy/stability/priority
  numbers are only ever the engine's" (`WeakScreen.tsx:1–9`).
- **`/hifz/confusion`** — stored `ConfusionGroup` rows (members,
  `confusionCount`, `lastTriggeredAt`, `origin` user|engine);
  `facade.refreshConfusionGroups(new Date())` lets the engine propose more and
  persists them with `origin: 'engine'` (`hifzFacade.ts:220–225`,
  `ConfusionScreen.tsx:35`).
- **`/hifz/progress`** — `hifzSessions(20)` for the list; totals, the median of
  recorded accuracies (`medianOf`, `hifz/shared.tsx`), summed durations and the
  per-item sparkline are all computations over the stored `recallAttempts` rows
  in the same render path. "With no rows there are no zeros pretending to be
  data — the empty state answers" (`ProgressScreen.tsx:1–9`, empty condition
  `:56–62`).

**Why the figures are reproducible.** Three documented determinism rules, all
visible in core:

1. *Clock is an argument.* `HifzContext.now` is an ISO string the engine must
   treat as "now" and "it never reads a clock"
   (`hifzEngine.ts:43–45`); `buildContext` converts the passed `Date` once
   (`hifzFacade.ts:276`) and every core module takes `nowIso` explicitly
   (e.g. `rawFactors(history, nowIso)`, `scoreItem(history, nowIso, weights)`,
   `core/src/hifz/review.ts:161`, `:290`; `stability.ts:8` "Pure and
   deterministic: `now` is always an argument").
2. *Fixed rounding.* Every emitted score passes `roundScore` at
   `SCORE_DECIMALS = 4` for "stable serialisation"
   (`core/src/hifz/params.ts:20–22`, `core/src/hifz/stability.ts:58–60`, applied
   at `stability.ts:239–253` and `review.ts:215–223`). So the UI's stability,
   strength and factor numbers are the serialised values, not floats that drift
   per platform.
3. *Ordered tie-breaks.* Attempts sort by `startedAt` then `id`
   (`core/src/hifz/review.ts:137`); errors by `expectedPosition` then a fixed
   kind order (`core/src/hifz/classify.ts:578`, `:596`); confusion groups and
   their members are sorted, and a group's id is a pure function of its sorted
   members — `cg-${origin}-${[...verseKeys].sort().join('+')}`
   (`core/src/hifz/confusion.ts:68–75`, `:170–194`). No probe uses randomness;
   the runner's probe seed is `${session.id}:${stepIndex}`
   (`hifzFacade.ts:138`, rule stated at `hifzEngine.ts:115–116`).

Consequence: the same stored rows plus the same `nowIso` render the same plan,
the same queue order and the same digits, which is what makes hifz screenshots
and tests meaningful. The one place the UI does read a wall clock is the learner's
own timing — `startedAtRef` per step and `durationMs = Date.now() −
startedAt` (`SessionRunnerScreen.tsx:237–243`, `:272`) — and that is a measurement
stored on the attempt, not a judgement.

## 8. Accessibility and keyboard

What exists in code today:

- **Focus.** One global rule: `:focus-visible { outline: none; box-shadow: var(--ring) }`
  (`desktop/src/ui/ui.css:137–140`), with `--ring: 0 0 0 2px var(--accent-ring)`
  (`styles/tokens.css:55`) and a theme-specific ring colour
  (`tokens.css:102` light, `:146` dark). It applies to every interactive element
  because they are all native `<button>` / `<a>` / `<input>` / `<select>` (see
  `ui/primitives.tsx:43–72`, `app/App.tsx:79–90`).
- **Touch/click targets.** `--inline-target: 44px` (`tokens.css:48`) is the
  `min-height` of `.btn` (`ui.css:90`), `.linkbtn` (`ui.css:128`) and `.navlink`
  (`shell.css:53`) — the AGENTS.md 44 px rule is enforced through tokens, not
  per-screen guesses.
- **Semantics and landmarks.** `<nav aria-label="بخش‌ها / Sections">` for the
  sidebar (`App.tsx:75`), `<header>` + `<h1>` per route title, `<main>` for the
  outlet (`App.tsx:139–143`), `aria-current="page"` on the active nav item
  (`App.tsx:82`) and on the active Me tab (`me/shared.tsx:37`); `Panel` is a
  `<section>` with `<header><h2>` (`primitives.tsx:85–95`); `MeTabs` is a second
  `<nav aria-label="Sections of Me">` (`me/shared.tsx:29`); `Field` binds
  `<label htmlFor>` (`primitives.tsx:112–126`) and the screens pass real ids
  (`PageScreen.tsx:241`, `SearchScreen.tsx:158–176`).
- **Status semantics.** `role="status"` on every loading state
  (`async.tsx:108`, `PageScreen.tsx:110`) and `role="alert"` on every error state
  (`async.tsx:96`, `:112`); live regions on the mutable result lines
  (`SearchScreen.tsx:206`, `ConceptsScreen.tsx:79`, `WordPeekScreen.tsx:163`,
  `me/shared.tsx:87`), with `aria-live="assertive"` reserved for backup failures
  (`BackupScreen.tsx:543`). `aria-busy` on buttons in flight
  (`primitives.tsx:49`) and on the loading skeleton.
- **Script and direction metadata.** `lang="fa"`, `dir="rtl"` in the markup
  (`index.html:2`), re-applied at runtime (`app-state.tsx:98–103`); Quran text
  carries `dir="rtl" lang="ar"` explicitly (`PageScreen.tsx:332`,
  `AyahText.tsx:37`, `:45`); `unicode-bidi: isolate` on every mixed run
  (`ui.css:295–335`); `dir="auto"` on ids, timestamps, engine reason codes and
  error strings (`SessionRunnerScreen.tsx:81,141`, `BackupScreen`, Notes,
  Confusion). `AyahBadge` supplies `aria-label="آیه n"` where the glyph is
  decorative (`primitives.tsx:150`).
- **Motion and colour.** `prefers-reduced-motion` slows the spinner
  (`ui.css:288–292`); `color-scheme` is declared both in markup (`index.html:6`)
  and per theme (`tokens.css:80`, `:123`) so native controls follow the theme.
  Contrast is token-paired per theme (e.g. dark `--text-strong #f4f1e8` on
  `--surface-1 #16221e`), but **not measured anywhere** — no contrast test exists
  in `desktop` or `tests/`.
- **Keyboard.** Tab/Shift-Tab reaches everything because there are no
  `div`-based buttons; modifier-clicks keep native behaviour on nav links
  (`App.tsx:83–87`) and `LinkButton` (`primitives.tsx:62–67`); forms submit on
  Enter (`PageScreen.tsx:226–231` uses a real `<form onSubmit>`).

## 9. Interactivity audit

Method: every `<Button>`, `<LinkButton>` and native `<button>`/`<a>` in
`desktop/src/screens`, `desktop/src/app`, `desktop/src/ui` was extracted and each
one checked for a handler that reaches a gateway/facade method, a `navigate()`,
or a state change. Result: **no dead controls** — every `Button`/`<button>`
carries `onClick` or `type="submit"`, and every `LinkButton` carries `to=`; the
only raw `<a>` elements are the sidebar (`App.tsx:79`) and `LinkButton` itself
(`primitives.tsx:59`), both wired.

Representative traces (all reach a `DataGateway` method in `gateway/types.ts` or
a facade call):

| Control | Trace |
| --- | --- |
| Home "Import content packs" | `gateway.importFromContent()` → `busy.refresh()` → stage-specific failure print (`home/HomeScreen.tsx:61–76`) |
| Home stat cards | `navigate(to)` to `/hifz`, `/hifz/review`, `/hifz/weak`, `/hifz/confusion`, `/hifz/progress`, `/me/notes` (`HomeScreen.tsx:120–133`) — all registered |
| Ayah bookmark / hifz toggles | `marks.toggleBookmark` / `marks.toggleHifz` → `addBookmark` / `removeBookmark`, `addHifzItem` / `removeHifzItem` (`quran/hooks.ts:278–306`) |
| Reader chapter bookmark | `gateway.removeBookmark(existing.id)` else `addBookmark({ verseKey, page, label })` (`quran/SurahReaderScreen.tsx:173–177`) |
| Note save / delete | `gateway.saveNote`, `gateway.deleteNote` (`quran/panels.tsx:117,133`; `me/NotesScreen.tsx:216`) |
| Focus "Copy text" | `copyText(ayah.textUthmani)` → `navigator.clipboard.writeText`, falling back to a hidden readonly textarea + `execCommand` (`quran/lib.ts:122–142`); the verbatim stored bytes are what is copied, and the button's own label becomes the only feedback |
| Session start / submit / finish | `facade.startSession`, `facade.submitRecall`, `facade.finishSession` then `navigate('/hifz/session/<id>')` (`SessionRunnerScreen.tsx:53,264,107–108`) |
| Confusion "engine propose" | `facade.refreshConfusionGroups(new Date())` (`hifz/ConfusionScreen.tsx:35`) |
| Search suggestion chips | `onPick(token)` → `setRawQuery(token)` → debounced `gateway.search()` (`discover/SearchScreen.tsx:222,302–311`) |
| Settings controls | `gateway.setSetting(key, value)` on change; "reset to default" → `onPersist(def.default)` (`me/SettingsScreen.tsx:279`) |
| Data health re-import / reset | `gateway.importFromContent()`; reset behind `ConfirmBox` → `gateway.resetContent()` (`me/ContentHealthScreen.tsx:162,175`, `:461–489`) |
| Backup export / save / restore | `gateway.exportBackup()` → `writeBackupFile(name, envelope)`; `readBackupFile(name)` → `importBackup(envelope)` (`me/BackupScreen.tsx:293,319,367`) |
| Mutashabihat focus form | `navigate('/discover/mutashabihat?vk=…')` after `asVerseKey` validation (`discover/MutashabihatScreen.tsx:291–292`) |

Two controls cannot be traced to a working destination — see Gaps G1 and G2:

- `LinkButton to="/me/data"` (`hifz/ItemsScreen.tsx:286`): no such route; it
  lands on the shell's "There is no such page" state instead of Data health.
- `LinkButton to={\`/hifz/session?item=${itemId}\`}`
  (`hifz/ItemsScreen.tsx:385`): the route resolves, but `SessionRunnerScreen`
  ignores `query['item']` — only `SurahReaderScreen.tsx:26` and
  `MutashabihatScreen.tsx:58` read any query parameter — so the link opens a
  whole-plan session rather than the drilled item.

Also flagged for the UI gate: two controls escape the styled shell with native
dialogs — `window.alert(...)` for a failed import
(`home/HomeScreen.tsx:71`) and `window.confirm(...)` before removing a hifz item
(`hifz/ItemsScreen.tsx:203`) — while `me/shared.tsx:4–8` states exactly why
`ConfirmBox` exists instead ("a `window.confirm` string cannot carry that much
detail and is not keyboard-styled with the rest of the app"). A screen-reader or
RTL user gets an unthemed OS string with no consequences list.

## 10. Gaps

| # | Gap | File to change |
| --- | --- | --- |
| G1 | Dead nav: empty-state CTA points at `/me/data`, which is not a registered route (`/me/content` is). `registry.ts` only validates `NAV` entries, so a screen-level link can rot silently. | `desktop/src/screens/hifz/ItemsScreen.tsx:286` |
| G2 | `?item=` deep link from the items screen is accepted by the router but read by nobody, so "در این نشست تمرینش کن" opens an unrelated plan-driven session. | `desktop/src/screens/hifz/SessionRunnerScreen.tsx` (read `query['item']`) |
| G3 | Icon-only header buttons (theme cycle, EN/فا) carry `title` but no `aria-label`, so their accessible name is the glyph `◐`/`EN`. | `desktop/src/app/App.tsx:52–67` |
| G4 | Offline chip appears/disappears with no live-region announcement, and no success state is announced for it; the shell's own "state must be hearable" rule (`me/shared.tsx:83–91`) is not applied here. | `desktop/src/app/App.tsx:18–38` |
| G5 | Native `window.alert` / `window.confirm` bypass theme, RTL and `ConfirmBox`: an unsighted or keyboard user gets an OS dialog with no consequences list. | `desktop/src/screens/home/HomeScreen.tsx:71`, `desktop/src/screens/hifz/ItemsScreen.tsx:203` |
| G6 | No keyboard shortcuts or arrow-key navigation anywhere (`onKeyDown` appears nowhere in `desktop/src`), while AGENTS.md asks for "keyboard navigation on desktop" beyond Tab. No skip-to-content link either; `.sr-only` is defined (`discover/discover.css:137`) and used by zero component. | `desktop/src/app/App.tsx`, `desktop/src/screens/quran/AyahFeed.tsx` |
| G7 | `Meter` conveys progress by width and a `title` percentage only — no `role="progressbar"`, `aria-valuenow` or visible number, so hifz accuracy and continue-reading percentages are invisible to AT. | `desktop/src/ui/primitives.tsx:129–137` |
| G8 | Contrast is asserted through paired tokens but never measured; there is no contrast test or documented ratio check anywhere in the repo. | `desktop/src/styles/tokens.css`, add a check under `tests/` |
| G9 | Reduced-motion handling covers the spinner only; the button hover/active transitions (`ui.css:99`) and the sticky-header `backdrop-filter` (`shell.css:87`) have no `prefers-reduced-motion` branch. | `desktop/src/ui/ui.css`, `desktop/src/app/shell.css` |
| G10 | Documented-but-inert font fallbacks: `--font-quran` / `--font-arabic` / `--font-fa` / `--font-latin` (`styles/fonts.css:120–128`) are never referenced, so the Scheherazade/Noto Naskh chain that `fonts.css` promises cannot take effect if the bundled woff2 fails. | `desktop/src/ui/ui.css:295–318` (+ `quran/quran.css`, `hifz/hifz.css`, `discover/discover.css`) |
| G11 | `core-engine` search backend is unreachable: `CoreEngineSearchService` exists (`gateway/search.ts:102`) but no gateway instantiates it, while `tauriGateway.ts:299–303` claims the dev shell wires it. The UI label for it (`SearchScreen.tsx:49–50`) is therefore dead copy. | `desktop/src/gateway/devGateway.ts:206` (or the comment in `tauriGateway.ts`) |
| G12 | `SearchScreen` sets `isEmpty={() => false}`, so a zero-result query bypasses `StateBoundary`'s empty contract and is handled by bespoke markup; the same trick in `ConceptsScreen.tsx:67` and `BootBoundary` (`App.tsx:110`) is deliberate but undocumented in the boundary itself. | `desktop/src/ui/async.tsx` (define whether "no results" counts as the empty state) |
| G13 | No global concept content and no `concepts()` read on the gateway: `/discover/concepts` can only ever show its honest explanation plus `counts().concepts`. Contract work, not a UI fix. | `desktop/src/gateway/types.ts` (add `concepts()`), `content/` packs |
| G14 | Segmentation evidence is derived at read time, so `/hifz/items` can show a derived fingerprint next to zero stored `hifz_segment` rows and a reviewer may read that as stored truth; `hifzSegments()` is documented as "empty until the memory engine lands (never faked)" (`gateway/types.ts:347`). Needs a visible "derived, not stored" marker. | `desktop/src/screens/hifz/ItemsScreen.tsx:270–290` |
