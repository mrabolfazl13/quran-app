# Packaging and distribution

How the offline app is turned into something a user installs, and what has to be
true before bundling starts. Code: `desktop/scripts/**`,
`desktop/src-tauri/{tauri.conf.json,src/commands.rs}`.

## The rule

An installed app must be able to import every pack **with the network off**.
That means the validated bytes have to travel inside the installer, and the code
that reads them must resolve them without ever falling back to a download. A
build that produces an app with an empty content folder is a failed build, even
if it compiles.

## Two generated inputs

Neither is importable source, so both are copied into the bundle at build time:

| Input | Source of truth | Emitted to | Script |
| --- | --- | --- | --- |
| SQLite schema | `core/src/contracts/db.sql` | `desktop/src/db/schema.generated.ts` | [`scripts/syncSchema.mjs`](../desktop/scripts/syncSchema.mjs) |
| Content packs | `content/` (built by `tools/content`) | `desktop/src-tauri/content/` and `desktop/dist/content/` | [`scripts/stageContent.mjs`](../desktop/scripts/stageContent.mjs) |

`syncSchema.mjs` refuses to embed a schema that does not look like the shared
contract (it checks for `CREATE TABLE meta` and the `ayah_search` virtual
table). The Tauri process cannot read `core/` at runtime, so the embedded string
*is* the shipped schema — a stale copy would silently migrate users onto the
wrong tables.

`stageContent.mjs` reads `content/index.json`, and for every listed pack copies
exactly `<pack.id>/pack.json` and `<pack.id>/payload.jsonl` plus the index:

* `src-tauri/content/` becomes the bundle resource directory;
* `dist/content/` is what the local web build serves over HTTP.

It is a copy, not a symlink or a dev-server alias: the bytes that ship must be
the bytes that were validated, and a link would let a later `content:build`
change the payload under an already-verified tree. Anything present in the
source folder but not listed in `index.json` is deleted from the staged tree, so
an unvalidated pack can never ride along. Zero-byte payloads, missing folders and
an absent `index.json` all stop the script with a non-zero exit.

The staged trees are build products and are git-ignored
(`desktop/src-tauri/content/`), so the shipped copy can never drift from the
committed `content/` packs.

## Build chain

```
npm run desktop:tauri build
  └─ tauri build
       ├─ beforeBuildCommand: npm run build:vite
       │    ├─ npm run sync:schema          # embed db.sql
       │    ├─ vite build                   # empties dist/, writes the app shell
       │    └─ node scripts/stageContent.mjs --to=both   # then fills dist/content + src-tauri/content
       ├─ cargo build --release             # the Rust shell + tauri-plugin-sql
       └─ bundle                             # NSIS installer (+ MSIX/MSI on targets: all)
```

Ordering matters: `vite build` clears `dist/`, so content staging has to run
after it. Both forms are staged by one command so the desktop and web trees can
never be built from different pack sets.

`bundle.resources = ["content/"]` in `tauri.conf.json` keeps the original
relative structure, so the installed layout is
`<resource dir>/content/index.json` plus one folder per pack.

## How the running app finds the packs

`resolve_content_root` (`desktop/src-tauri/src/commands.rs`) tries, in order:

1. `QURAN_CONTENT_DIR` — the packaging/CI override;
2. the bundle resource directory, `<resource>/content`;
3. `content/` found by walking up from the executable (this is what makes a
   debug build in `src-tauri/target/…` see `src-tauri/content`);
4. `content/` found by walking up from the current directory (`tauri dev`).

Whichever wins, the webview never receives a path it can escape: pack and backup
reads go through the validated commands (`content_pack_stat`, `content_read_text`,
`backup_read`, `backup_write`), each of which resolves the requested relative
path, checks it stays inside the allowed root, and rejects anything with
characters outside `[A-Za-z0-9._-]`. The capability set
(`desktop/src-tauri/capabilities/default.json`) grants only `core:default` plus
the four SQL plugin permissions — no filesystem, shell or HTTP plugin exists in
`Cargo.toml`, so the binary has no way to reach the network.

## Verifying a package (not optional)

A bundle is only done when the shipped path has been exercised:

1. install from the produced `.exe`, then launch it — not the dev server;
2. confirm the empty-state → import → counts flow completes with the network off;
3. confirm `content_status` reports the resource directory (not a `QURAN_CONTENT_DIR`
   or `tauri dev` fallback) — otherwise the installer is shipping no content and
   the ancestor walk is hiding it;
4. re-check the numbers on `/me/content` against `content/index.json`
   (`npm run content:validate` prints the same counts from the other side).
5. read the counts out of the app's own SQLite file, not only off the screen. A
   green import report is not the proof: the first fixed build was installed and
   the click appeared to work, and the number that mattered came from
   `%APPDATA%\app.quran.platform\quran.db` (`surah` 114, `ayah` 6236,
   `ayah_word` 83665, `translation` 18708, `tafsir` 1313, `similar_ayah` 1732,
   `content_pack` 8) plus the `last_import_json` row.
6. watch the process' working set during the import and record the wall clock of
   click → committed report. Both are device-level numbers and go in
   [`performance.md`](performance.md); the packaging pass that first made the
   import work took 164 s of them, which is a distribution problem as much as a
   speed one — the whole UI waits behind the gateway's statement queue.
7. run the install over an app-data directory that has never seen the app (move
   the existing one aside first). Reusing a database that already holds content
   proves only the re-import path.

Record the outcome — installer file size, counts read back from the installed
app, and anything that had to be fixed — in
[`current-state.md`](current-state.md) and [`changelog.md`](changelog.md).

Taken on 2026-09-28 against
`desktop/src-tauri/target/release/bundle/nsis/Quran Platform_0.1.0_x64-setup.exe`
(8,862,514 B), installed to `C:\Users\Alex\AppData\Local\Quran Platform`, driven
through WebView2 CDP: items 1–6 pass (fresh-profile first run committed in 8.0 s
of wall clock, report 7,629 ms; content root reported as the bundled
`…\Quran Platform\content`; 114/6,236/83,665/18,708/1,313/1,732/8 read back from
the app's own `quran.db`; 0 non-local requests out of 1,404). Item 7 (uninstall
cleanliness) has not been exercised yet.

## Notes for this machine

Release builds here run out of memory while other projects' processes are alive
(~0.5–1 GB free of 8 GB). `src-tauri/Cargo.toml` therefore keeps `lto = "thin"`
with 16 codegen units and compiles the Windows FFI binding crates at
`opt-level = 0`; if a new dependency aborts with `memory allocation of … bytes
failed`, that override pattern is the fix, and `CARGO_BUILD_JOBS=1` is how the
build is started.
