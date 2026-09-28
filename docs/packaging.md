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

## The web package (delivery order step 2)

The same app, minus Tauri: a static bundle plus a server small enough to read.

```
npm run desktop:web:package
  ├─ npm run build:vite          # same chain as above: schema, shell, stageContent --to=both
  ├─ node scripts/packageWeb.mjs
  │    ├─ copy dist/            → release/web/quran-web-0.1.0/dist   (app + /content)
  │    ├─ copy bin/serveWeb.mjs → …/bin
  │    ├─ copy dev/contentMiddleware.mjs → …/dev   (so the dev-only path is not needed)
  │    ├─ write start.cmd / start.command / start.sh + README.md
  │    ├─ sanity-import the server it just wrote (a broken file fails the build)
  │    └─ zip → release/web/quran-web-0.1.0.zip
  └─ run it: node bin/serveWeb.mjs [--port=4173] [--host=127.0.0.1]
```

`serveWeb.mjs` has no dependencies and no build step, which is the whole reason a
"cross-platform installer" here is three shell scripts and one archive rather
than three installers: the only requirement on the user's machine is a Node
runtime, and the same bytes start on Windows, macOS and Linux.

What the server promises, in code:

- binds `127.0.0.1` unless `--host` says otherwise — it is a local port, not a
  host;
- GET and HEAD only, everything else `405`;
- every path goes through `safeRel()` + `resolveInside()`; anything that escapes
  the served directory is `400`, and traversal in the URL is a `404` before it
  reaches the filesystem;
- `X-Content-Type-Options: nosniff` on all responses; `immutable` only for
  hashed asset names; `no-cache` for `index.html`, the manifest, the service
  worker and `content/` — so a re-packaged build is picked up on the next
  navigation instead of being served from a stale cache.

The app side of "installable" is `public/manifest.webmanifest` plus
`public/sw.js`, registered only when the bundle is production *and* not inside
Tauri (`desktop/src/main.tsx`). The worker is network-first for navigations and
cache-first-then-fill for `/assets/*` and `/content/*`.

### Verifying the web package

The same bar as the installer, with two swaps forced by the different runtime:

1. run the **packaged** bundle (`node bin/serveWeb.mjs`), not `vite dev` — the
   dev shell has a middleware that hides half of what the server does;
2. confirm the auto-import on first `ready()` reaches the counts in
   `content/index.json`, and that `/me/content` names the origin's `/content`
   directory as where they came from;
3. confirm the badge says «وب» and the shell reports `web`, so no dev-only
   affordance is reachable in a build someone downloads;
4. **then kill the server process** and reload: the shell must come from the
   service-worker cache, all 8 packs must re-import with their checksums still
   verifying, and the user's rows must still be there. This is the web target's
   equivalent of "network off" — there is no adapter to disable, so the server
   dying is the test;
5. drive a restore through `/me/backup` and reload the shell afterwards. Defect
   14 in [`current-state.md`](current-state.md) is exactly this flow and nothing
   else caught it;
6. probe the server: `/content/../../package.json` → 404, `POST /` → 405, and no
   request in the session leaves the origin.

Taken on 2026-09-28 against `release/web/quran-web-0.1.0` (30.56 MiB unpacked,
5.45 MiB zipped) served on `127.0.0.1:4173` and driven in headless Edge over CDP:
items 1–6 pass — 114/6,236/83,665/18,708/1,313/1,732/8 after auto-import (the
app's own report: 2,594 ms), 24 cache entries (9 content / 8 assets / 7 shell),
the app fully usable with the server process stopped — home, a Persian query
answered from the memory index, page 42 — 0 network failures, 0 non-local
requests, no console errors. Not exercised: the browser's *install* prompt and a
standalone window (the manifest is shipped and validated by the browser, but no
install was completed), and `start.command` / `start.sh`, which only macOS and
Linux can run.

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

`packageWeb.mjs` empties `release/web/quran-web-0.1.0/` before writing it, so a
server still running from inside that directory makes the build fail with
`EBUSY: resource busy or locked, rmdir …`. Windows locks a process' working
directory; stop `serveWeb.mjs` first. The failure is loud and leaves no half
package claiming to be one.

Release builds here run out of memory while other projects' processes are alive
(~0.5–1 GB free of 8 GB). `src-tauri/Cargo.toml` therefore keeps `lto = "thin"`
with 16 codegen units and compiles the Windows FFI binding crates at
`opt-level = 0`; if a new dependency aborts with `memory allocation of … bytes
failed`, that override pattern is the fix, and `CARGO_BUILD_JOBS=1` is how the
build is started.
