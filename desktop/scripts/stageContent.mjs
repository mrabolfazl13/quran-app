/**
 * Put the generated content packs where each shipped form can find them.
 *
 * `content/` is produced by `tools/content` at the repo root and is not
 * importable code, so nothing in `src/` can reach it. Each distribution needs
 * its own copy, for different reasons:
 *
 * - `--to=tauri` stages `src-tauri/content/`, which `tauri.conf.json` declares
 *   as a bundle resource. The Rust side resolves it through
 *   `app.path().resolve("content", BaseDirectory::Resource)`
 *   (`src-tauri/src/commands.rs:resolve_content_root`) and hands bytes plus the
 *   SHA-256 to the webview, so an installed app can import without a network.
 *   Without this step the installer ships an app that opens, shows the empty
 *   state and has nothing to import.
 * - `--to=web` stages `dist/content/`, which is what a static file server hands
 *   to the browser gateway's `fetch`-based pack source.
 *
 * Staging is deliberately a copy, not a symlink or a dev-server alias: the
 * bytes that ship must be the bytes that were validated, and a link would let a
 * later `content:build` change the payload under an already-verified tree.
 *
 * Fails loudly when the source has no `index.json`, when a pack folder listed
 * there is missing, or when a payload is empty — a silent partial stage would
 * surface as a checksum error only after install.
 */
import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..');
const sourceRoot = path.resolve(desktopRoot, '../content');

const TARGETS = {
  tauri: path.join(desktopRoot, 'src-tauri', 'content'),
  web: path.join(desktopRoot, 'dist', 'content'),
};

const flag = process.argv.find((a) => a.startsWith('--to='));
const which = flag ? flag.slice('--to='.length) : 'both';
if (!['tauri', 'web', 'both'].includes(which)) {
  console.error(`[stage:content] --to must be one of tauri|web|both, got "${which}"`);
  process.exit(1);
}
const targets = which === 'both' ? ['tauri', 'web'] : [which];

const indexRaw = await readFile(path.join(sourceRoot, 'index.json'), 'utf8').catch(() => {
  console.error(`[stage:content] no index.json in ${sourceRoot} — run \`npm run content:build\` first`);
  process.exit(1);
});
const index = JSON.parse(indexRaw);
const packs = Array.isArray(index) ? index : (index.packs ?? []);
if (packs.length === 0) {
  console.error('[stage:content] index.json lists no packs');
  process.exit(1);
}

/** Every file the app is allowed to read: the index plus each pack's two files. */
function relFiles(pack) {
  // `index.json` entries carry no explicit folder field: the pack folder is its
  // id, which is also what `desktop/src/content/packSource.ts` requests.
  const dir = pack.id;
  return [`${dir}/pack.json`, `${dir}/payload.jsonl`];
}

let bytes = 0;
let files = 0;
for (const pack of packs) {
  for (const rel of relFiles(pack)) {
    const s = await stat(path.join(sourceRoot, rel)).catch(() => null);
    if (!s) {
      console.error(`[stage:content] pack "${pack.id}" is listed in index.json but ${rel} is missing`);
      process.exit(1);
    }
    if (s.size === 0) {
      console.error(`[stage:content] ${rel} is empty — refusing to stage a zero-byte pack file`);
      process.exit(1);
    }
    bytes += s.size;
    files += 1;
  }
}
// The index itself travels with the packs; the app reads it first.
bytes += (await stat(path.join(sourceRoot, 'index.json'))).size;
files += 1;

for (const name of targets) {
  const dest = TARGETS[name];
  await rm(dest, { recursive: true, force: true });
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(sourceRoot, dest, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(sourceRoot, src);
      return rel === '' || rel === 'index.json' || packs.some((p) => rel.split(path.sep)[0] === p.id);
    },
  });
  const staged = await readdir(dest);
  const listed = new Set(['index.json', ...packs.map((p) => p.id)]);
  const extra = staged.filter((entry) => !listed.has(entry));
  for (const entry of extra) {
    // Anything else in the folder would be shipped without ever being validated.
    await rm(path.join(dest, entry), { recursive: true, force: true });
  }
  if (staged.length - extra.length !== listed.size) {
    console.error(`[stage:content] ${dest} is missing entries: expected ${listed.size}, staged ${staged.length - extra.length}`);
    process.exit(1);
  }
  console.log(`[stage:content] ${path.relative(desktopRoot, dest)} — ${staged.length - extra.length} entries`);
}

console.log(
  `[stage:content] ${files} files, ${(bytes / 1024 / 1024).toFixed(2)} MiB from ${path.relative(process.cwd(), sourceRoot) || 'content/'}`,
);
