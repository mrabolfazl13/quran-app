/**
 * packageWeb.mjs — turn the built app into a portable, cross-platform package.
 *
 * The web deliverable is the same bundle the desktop installer carries, so this
 * script copies nothing it did not verify: `dist/` must already contain a built
 * `index.html` and staged, checksum-validated `content/` packs.
 *
 * Output layout (one folder, then optionally a zip of it):
 *
 *   quran-web-<version>/
 *     dist/                      the built app + its content packs
 *     bin/serveWeb.mjs           the server (node:http, no dependencies)
 *     dev/contentMiddleware.mjs  imported by the server: one path rule for the
 *                                dev server, the Rust command and this package
 *     start.cmd                  Windows launcher
 *     start.command / start.sh   macOS / Linux launchers
 *     README.md                  what it is, how to run, where data lives
 *
 * `bin/serveWeb.mjs` resolves its default root as `../dist` and its path-rule
 * import as `../dev/contentMiddleware.mjs`, which is exactly why the package is
 * shaped this way: the shipped server is the same file the repository runs,
 * copied verbatim rather than rewritten for delivery.
 */
import { chmod, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..');
const distDir = path.join(desktopRoot, 'dist');
const outRoot = path.join(desktopRoot, 'release', 'web');

const flag = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 2) : fallback;
};
const wantsZip = process.argv.includes('--zip');

const pkg = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8'));
const appName = 'quran-web';
const name = `${appName}-${pkg.version}`;
const target = path.join(outRoot, name);

// ---------------------------------------------------------------- preflight
const required = [
  ['index.html', 'the built app'],
  ['manifest.webmanifest', 'the PWA manifest'],
  ['sw.js', 'the service worker (offline start)'],
  ['content/index.json', 'the staged content packs'],
];
if (!existsSync(distDir)) {
  fail(`no ${path.relative(desktopRoot, distDir)} — run \`npm run build\` in desktop/ first`);
}
for (const [rel, why] of required) {
  if (!existsSync(path.join(distDir, rel))) fail(`dist/${rel} is missing — ${why} was not built or staged`);
}

function fail(message) {
  console.error(`[package:web] ${message}`);
  process.exit(1);
}

// ------------------------------------------------------------------ assemble
await rm(target, { recursive: true, force: true });
await mkdir(path.join(target, 'bin'), { recursive: true });
await mkdir(path.join(target, 'dev'), { recursive: true });

await cp(distDir, path.join(target, 'dist'), { recursive: true });
await cp(path.join(here, 'serveWeb.mjs'), path.join(target, 'bin', 'serveWeb.mjs'));
await cp(path.join(desktopRoot, 'dev', 'contentMiddleware.mjs'), path.join(target, 'dev', 'contentMiddleware.mjs'));

const SH = `#!/bin/sh
# Quran, offline web build. Needs Node.js; needs nothing else, ever.
# Any argument is passed to the server:  ./start.sh --port=8080
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 or newer is not on PATH. Install it, then run this again." >&2
  exit 1
fi
exec node bin/serveWeb.mjs "$@"
`;

const launchers = {
  'start.cmd': `@echo off
rem Quran, offline web build. Needs Node.js; needs nothing else, ever.
rem Any argument is passed to the server:  start.cmd --port=8080 --host=0.0.0.0
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not on PATH. Install Node 18 or newer, then run this again.
  exit /b 1
)
node bin\\serveWeb.mjs %*
`,
  // macOS Finder runs a double-clicked `.command` in Terminal; the content is
  // the same script Linux uses.
  'start.command': SH,
  'start.sh': SH,
};

for (const [file, body] of Object.entries(launchers)) {
  // A batch file with bare newlines can mis-parse a parenthesised `if` block, so
  // the Windows launcher is written the way Notepad would.
  const dest = path.join(target, file);
  await writeFile(dest, file.endsWith('.cmd') ? body.replace(/\n/g, '\r\n') : body, 'utf8');
  if (!file.endsWith('.cmd')) await chmod(dest, 0o755);
}

await writeFile(path.join(target, 'README.md'), readme(name), 'utf8');

// A package whose server cannot load its own path rule is worse than no package.
await sanityCheck(target);

// ------------------------------------------------------------------- report
async function dirBytes(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    total += entry.isDirectory() ? await dirBytes(abs) : (await stat(abs)).size;
  }
  return total;
}
const bytes = await dirBytes(target);
console.log(`[package:web] ${path.relative(desktopRoot, target)} — ${(bytes / 1024 / 1024).toFixed(1)} MiB`);
console.log('[package:web] run it:  ' + path.join(target, process.platform === 'win32' ? 'start.cmd' : 'start.sh'));

if (wantsZip) await makeZip(target, name);

async function sanityCheck(root) {
  const probe = path.join(root, 'bin', 'serveWeb.mjs');
  const mod = await import(`file://${probe.replace(/\\/g, '/')}`);
  if (typeof mod.createWebServer !== 'function') fail('packaged server exports no createWebServer');
  try {
    mod.createWebServer(path.join(root, 'dist'));
  } catch (err) {
    fail(`packaged server refused to start against its own dist: ${err}`);
  }
}

/**
 * Zipping is a convenience, not a guarantee: there is no archive library in this
 * project's dependencies, so the platform's own tool is used when it is present
 * and the manual command is printed when it is not.
 */
async function makeZip(root, baseName) {
  const zipPath = `${root}.zip`;
  await rm(zipPath, { force: true });
  const [cmd, args] =
    process.platform === 'win32'
      ? ['powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${root}' -DestinationPath '${zipPath}' -Force`]]
      : ['zip', ['-qr', zipPath, path.basename(root)]];
  const cwd = process.platform === 'win32' ? undefined : path.dirname(root);
  try {
    await new Promise((resolve, reject) => {
      execFile(cmd, args, { cwd }, (err) => (err ? reject(err) : resolve()));
    });
    console.log(`[package:web] zip: ${path.relative(desktopRoot, zipPath)} (${((await stat(zipPath)).size / 1024 / 1024).toFixed(1)} MiB)`);
  } catch (err) {
    console.log(
      `[package:web] could not zip (${err instanceof Error ? err.message : err}). ` +
        `The folder is complete; archive it yourself: ${process.platform === 'win32' ? 'right-click → Send to → Compressed folder' : `cd "${path.dirname(root)}" && zip -qr ${baseName}.zip ${baseName}`}`,
    );
  }
}

function readme(pkgName) {
  return `# Quran — offline web build (${pkg.version})

${pkgName} is the same application as the desktop app, packaged to run from this
folder on a local HTTP port. It is not a website that calls a server: the only
thing it reads over HTTP are its own files inside this folder.

## Run it

You need Node.js 18 or newer. Nothing else — no install step, no npm install,
no database server, no account.

| Platform | Start |
| --- | --- |
| Windows | double-click \`start.cmd\`, or run it in a terminal |
| macOS | double-click \`start.command\` (or \`sh start.sh\`) |
| Linux | \`./start.sh\` |

Then open **http://127.0.0.1:4173/** in Chrome, Edge or Firefox.

Options, appended to the launcher: \`--port=8080\`, \`--host=0.0.0.0\` (off by
purpose — this is an offline app and does not advertise itself on the network).
Stop it with Ctrl+C.

## Install it as an app

Once it is open, the browser offers "Install app" (the address bar icon). The
installed copy starts from its own cache with the network disabled: the service
worker holds the shell, and every content pack is cached the first time the app
imports them.

## Where your data is

Notes, bookmarks, hifz items and recall attempts live in that browser's own
storage on this machine — nothing leaves it. Content (Quran text, translations,
tafsir) is read from \`dist/content/\` and is imported automatically on each
start; it is never written to.

To move your data to another browser or computer: **Me → Backup** → build the
file → **Download file**, then pick that \`.quranbak\` file in the other browser's
backup screen. The Quran text is not in the backup and does not need to be — it
ships with the app and is checksum-verified on import.

## What is in this folder

- \`dist/\` — the built app plus the eight content packs it serves
- \`bin/serveWeb.mjs\` — a dependency-free static server (\`node:http\`)
- \`dev/contentMiddleware.mjs\` — the one path rule shared by the dev server, the
  native desktop command and this package: relative paths only, no traversal,
  \`.json\`/\`.jsonl\` only
- \`start.cmd\` / \`start.command\` / \`start.sh\` — launchers

## Verify it is really offline

Start it, open the app, load a few screens, then disconnect the network and
reload. Everything still works, including the first import — because it was
never going anywhere but this folder.
`;
}
