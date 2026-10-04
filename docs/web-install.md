# Installing and running the web build

The web target is the same application as the desktop app, served from a folder
on your own machine instead of from an installer. It is not a website that calls
a server: the only things it reads over HTTP are its own files inside that
folder, and the server binds `127.0.0.1` by default.

What this covers: running the bundle on Windows, macOS and Linux, installing it
as a browser app (its own window, no address bar), what it does with your data,
and how to prove to yourself that it is really offline. The desktop (Tauri)
installer is documented in [packaging.md](packaging.md); the live status of
every deliverable is in [current-state.md](current-state.md).

## 1. Get the bundle

From the repository root:

```bash
npm run desktop:web:package
```

That builds the app (`vite build`), stages the validated content packs into
`dist/content/`, assembles the portable folder and zips it:

```
desktop/release/web/quran-web-<version>/
  dist/                      the built app + its eight content packs
  bin/serveWeb.mjs           the server (node:http, no dependencies)
  dev/contentMiddleware.mjs  the one content-path rule, shared with the dev server
  start.cmd                  Windows launcher   (double-click)
  start.command              macOS launcher     (double-click)
  start.sh                   Linux launcher     (./start.sh)
  README.md                  the same instructions, inside the folder
desktop/release/web/quran-web-<version>.zip
```

Copy the folder, or the zip, to the machine that will run it. The zip is a
convenience: `packageWeb.mjs` uses the platform's own archiver and prints the
manual command if none is present, so a folder that failed to zip is still a
complete deliverable.

## 2. Run it

You need **Node.js 18 or newer** on `PATH`. Nothing else — no `npm install`, no
database server, no account, no build step.

| Platform | Start | Stop |
| --- | --- | --- |
| Windows | double-click `start.cmd`, or run it in a terminal | Ctrl+C in the window |
| macOS | double-click `start.command` (Terminal opens), or `sh start.sh` | Ctrl+C |
| Linux | `./start.sh` (it is marked executable by the packaging step) | Ctrl+C |

Then open **http://127.0.0.1:4173/** in Edge or Chrome. The first screen
imports the bundled content on its own — around 29 MB of packs read from this
folder, checksum-verified — and takes a few seconds on a first run.

Options, appended to any launcher (or to `node bin/serveWeb.mjs` directly):

```
--port=8080        a different port (default 4173)
--host=0.0.0.0     listen beyond loopback — deliberately NOT the default
--dist=<path>      serve a different built app directory
```

The server answers `GET` and `HEAD` only, refuses any path that resolves outside
its own directory, and hands out `.json`/`.jsonl` under `/content/` — the same
rule the dev server and the native desktop command use, from one shared file.
Ctrl+C closes it; nothing keeps running and nothing is installed system-wide by
running it.

## 3. Install it as an app (own window, offline start)

With the app open in Edge or Chrome, use the browser's own install entry:

* **Edge**: address bar → the *Install app* icon (or `⋯` → *Apps and
  extensions* → *Install this site as an app*).
* **Chrome**: address bar → *Install* / *Install app* in the `⋯` menu.

The install surface is real and is verified as part of the test suite:

* `manifest.webmanifest` is served as `application/manifest+json`, carries
  `name`, `short_name`, `start_url: "./"`, `scope: "./"`, `display: standalone`,
  `theme_color` / `background_color`, and three PNG icons (192, 256 and 512, the
  last also `maskable`) whose declared sizes match the actual files;
* the shipped `index.html` links that manifest;
* the production bundle registers `sw.js` with `scope: "./"`, and the live
  registration ends up as `<origin>/`, which covers the whole app;
* the worker reaches state `activated` and becomes the page's
  `navigator.serviceWorker.controller` — not an update parked in the wings.

After installing, the app opens in its own window. The local server has to be
running for the *first* load in a given browser profile; from then on the
service worker holds the shell **and every content pack**, so the app also opens
with the server stopped — see the next section. Because a fresh install
precaches the corpus during the worker's `install` step, that does not depend on
which screens you happened to look at.

## 4. Prove it is offline

`docs/testing.md` treats this as a shipped-path claim, so it is a test, not a
promise in a README:

```bash
node tests/e2e/pwa.mjs        # or: npm run test:pwa
```

It serves `desktop/release/web/quran-web-<version>/dist` (the folder the
launcher serves), drives it in a browser profile it creates in `%TEMP%`, and
reports one line per check:

1. the service worker registers, activates and controls the page;
2. the install surface (manifest, icons, `index.html`, registration scope);
3. offline: the loopback server is **stopped** and its port verified to answer
   `ECONNREFUSED`, and the app still reloads and still renders revealed text
   (and, in `CHECK 3b`, survives a full browser restart on the same profile);
4. zero runtime network to the internet: every request the page made is
   classified by `tests/e2e/lib/netgate.mjs`, and a non-loopback request is a
   failure rather than a warning.

The manual version, on your own machine: start the app, let it finish its
import, close the terminal (or kill the Node process), reload the app window —
or reopen it after quitting the browser entirely. Qur'an text, translations,
tafsir, search and the hifz screens keep working. If a screen claims it cannot
read its data, that is a bug: report it with the screen and the browser.

## 5. Where your data lives, and how to move it

User data — notes, bookmarks, hifz items, recall attempts, plans, sessions —
lives in the browser profile of the browser you installed the app **in**, in
that browser's own storage (IndexedDB). It never leaves the machine, and it is
not written into the bundle folder. Consequences worth knowing:

* The same bundle opened in a different browser is a different, empty library.
* Clearing site data / browsing history for `127.0.0.1` in that browser deletes
  your notes and hifz history. The revealed text is not affected: it ships with
  the app and is re-imported.
* To move libraries: **Me → Backup** → *Build from current data* → *Write file*,
  then pick that `.quranbak` file in the other browser's backup screen
  (format: [backup-format.md](backup-format.md)).

To remove the app: uninstall it through the browser (Edge: `edge://apps` →
remove; Chrome: `chrome://apps` or the app menu → *App info* → *Uninstall*),
then, if you want the cached content gone too, clear site data for
`http://127.0.0.1:<port>` (or delete the browser profile). Stop the server with
Ctrl+C; there is no service, no scheduled task and no registry entry created by
this bundle.

## 6. Updating

Rebuild or unpack the new folder over the old one and start it. Navigations are
served network-first, so a machine that re-runs the launcher gets the new app; a
machine that does not reach the launcher still opens the old app from cache. The
worker's `VERSION` key (`quran-web-v<schema>` in `desktop/public/sw.js`) is what
invalidates cached content packs, because packs are re-staged under the same
file names on every build — a build that changes content without bumping
`VERSION` would let an installed app keep the old bytes.

## 7. Known limits of this target

* **Browser support is Edge/Chrome today.** The install and offline checks run
  against Chromium (the same engine family as the desktop app's WebView2).
  Firefox serves the same files and can register the worker, but the *Install
  app* entry and this suite's verification have not been run there.
* **The server must be started by you.** `start.cmd` / `start.command` /
  `start.sh` is a foreground process: no auto-start at login, no background
  service. If you installed the app and the server is not running, the app opens
  from cache but cannot be reached from a *new* browser profile until you start
  it again.
* **`--host=0.0.0.0` is possible and off by purpose.** This is an offline app;
  binding a LAN interface is an explicit choice, and doing so means other
  machines on your network can read the same folder.
* **The macOS and Linux launchers are not executed by this suite on this
  machine** (it is Windows). They are the same dependency-free `node
  bin/serveWeb.mjs` call, and `packageWeb.mjs` refuses to ship a folder whose
  server cannot start against its own `dist/`, but "verified on macOS/Linux"
  would be a claim this repository has not made.
