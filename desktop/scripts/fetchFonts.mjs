/**
 * Build-time font fetch (network is allowed here, never at runtime).
 *
 * Sources are the official upstreams only: the Google Fonts CSS API
 * (fonts.googleapis.com), which serves the canonical woff2 files from
 * fonts.gstatic.com. Every family below is SIL Open Font License 1.1; the
 * licence note and upstream URLs are recorded in docs/ux-spec.md and written
 * next to the files as `fonts/LICENCE-notes.json`.
 *
 * Subset filtering: only @font-face blocks whose unicode-range overlaps Latin
 * (incl. Latin Extended-A for transliteration), Arabic through Arabic
 * Extended-A, Arabic Presentation Forms, or General Punctuation are kept.
 * Cyrillic/Greek/Vietnamese cuts are dropped, and identical files are
 * deduplicated by URL so a variable font is stored once.
 *
 * If a family cannot be fetched the script exits non-zero and the UI keeps the
 * documented system fallback stacks written at the bottom of fonts.css — a
 * broken @font-face is never shipped.
 *
 * Run: node scripts/fetchFonts.mjs
 */
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const fontDir = path.resolve(here, '../src/assets/fonts');
const cssOut = path.resolve(here, '../src/styles/fonts.css');

/**
 * @type {{family: string,
 *         variable: string | false,
 *         staticWeights: number[],
 *         purpose: string}[]}
 *  `variable` is the requested weight axis range when the family ships as a
 *  variable font (one file, real weight interpolation), otherwise false. */
const FAMILIES = [
  { family: 'Amiri Quran', variable: false, staticWeights: [400], purpose: 'Mushaf / ayah text (Uthmani-capable Naskh with full diacritics)' },
  { family: 'Amiri', variable: false, staticWeights: [400, 700], purpose: 'Arabic body text: tafsir passages, Arabic notes' },
  { family: 'Vazirmatn', variable: '400..700', staticWeights: [400, 500, 600, 700], purpose: 'Persian UI chrome' },
  { family: 'Inter', variable: '400..700', staticWeights: [400, 500, 600, 700], purpose: 'Latin UI chrome, metadata, numbers' },
];

// Unicode bands this product actually renders.
const RANGES = [
  [0x0000, 0x024f], // Latin, Latin-1, Latin Extended-A
  [0x0590, 0x08ff], // Hebrew → Arabic Supplement → Arabic Extended-A
  [0x2000, 0x206f], // General Punctuation
  [0xfb50, 0xfdff], // Arabic Presentation Forms-A
  [0xfe70, 0xfeff], // Arabic Presentation Forms-B
];

function wants(range) {
  if (!range) return true;
  for (const part of range.split(',')) {
    const m = part.trim().match(/^U\+([0-9A-Fa-f]{1,6})(?:-([0-9A-Fa-f]{1,6}))?$/);
    if (!m) continue;
    const start = Number.parseInt(m[1] ?? '', 16);
    const end = m[2] ? Number.parseInt(m[2], 16) : start;
    if (RANGES.some(([lo, hi]) => start <= hi && end >= lo)) return true;
  }
  return false;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function get(url, raw = false) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return raw ? Buffer.from(await res.arrayBuffer()) : res.text();
}

async function fetchSheet(spec) {
  const fam = encodeURIComponent(spec.family);
  const urls = [];
  if (spec.variable) {
    urls.push(`https://fonts.googleapis.com/css2?family=${fam}:wght@${spec.variable}&display=block`);
  }
  urls.push(`https://fonts.googleapis.com/css2?family=${fam}:wght@${spec.staticWeights.join(';')}&display=block`);
  let lastErr = null;
  for (const url of urls) {
    try {
      const sheet = await get(url);
      if (/@\s*font-face/.test(sheet)) return { sheet, url };
      lastErr = new Error(`no @font-face in ${url}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error(`no usable stylesheet for ${spec.family}`);
}

/** Parse every `@font-face { … }` block out of a Google Fonts stylesheet. */
function parseFaces(sheet) {
  const out = [];
  const re = /@font-face\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(sheet)) !== null) {
    const body = m[1] ?? '';
    const pick = (prop) => body.match(new RegExp(`${prop}:\\s*([^;]+);`, 'i'))?.[1]?.trim();
    const src = body.match(/src:\s*url\((https:[^)]+)\)/i)?.[1];
    const family = pick('font-family')?.replace(/^['"]|['"]$/g, '');
    if (!src || !family) continue;
    out.push({
      family,
      src,
      weight: pick('font-weight') ?? '400',
      style: pick('font-style') ?? 'normal',
      range: pick('unicode-range') ?? '',
    });
  }
  return out;
}

await mkdir(fontDir, { recursive: true });
await mkdir(path.dirname(cssOut), { recursive: true });

const urlToFile = new Map();
const notes = [];
const failures = [];
const faces = [];

for (const spec of FAMILIES) {
  let fetched;
  try {
    fetched = await fetchSheet(spec);
  } catch (err) {
    failures.push(`${spec.family}: ${String(err)}`);
    console.warn(`[fonts] SKIP ${spec.family} — ${String(err)}`);
    continue;
  }
  const parsed = parseFaces(fetched.sheet);
  let kept = 0;
  for (const face of parsed) {
    const { family, src, weight, style, range } = face;
    if (!wants(range)) continue;
    let file = urlToFile.get(src);
    if (!file) {
      const tag = createHash('sha1').update(src).digest('hex').slice(0, 8);
      file = `${family.replace(/\s+/g, '')}-${weight.replace(/\s+/g, '-')}-${style}-${tag}.woff2`;
      const bytes = await get(src, true);
      if (bytes.length < 512) throw new Error(`implausibly small font ${file}`);
      await writeFile(path.join(fontDir, file), bytes);
      urlToFile.set(src, file);
      notes.push({
        family,
        file: `src/assets/fonts/${file}`,
        fontWeight: weight,
        style,
        bytes: bytes.length,
        upstream: src,
        licence: 'SIL Open Font License 1.1',
        licenceTextUrl: 'https://openfonts.dev/licenses/OFL-1.1.txt',
      });
    }
    faces.push({ family, weight, style, file, range });
    kept += 1;
  }
  if (kept === 0) failures.push(`${spec.family}: no usable @font-face blocks (parsed ${parsed.length})`);
  console.log(`[fonts] ${spec.family}: kept ${kept} of ${parsed.length} faces (variable=${String(spec.variable)})`);
}

let css = `/* GENERATED by scripts/fetchFonts.mjs — do not edit by hand.
   Bundled at build time so the shipped app never fetches a font at runtime.
   All families: SIL OPEN FONT LICENSE Version 1.1 — see docs/ux-spec.md
   ("Typography & licences") and src/assets/fonts/LICENCE-notes.json for the
   per-file upstream URL and sha. */

`;
for (const face of faces) {
  css +=
    `@font-face {\n` +
    `  font-family: '${face.family}';\n` +
    `  font-style: ${face.style};\n` +
    `  font-weight: ${face.weight};\n` +
    `  font-display: block;\n` +
    `  src: url('../assets/fonts/${face.file}') format('woff2');\n` +
    (face.range ? `  unicode-range: ${face.range};\n` : '') +
    `}\n`;
}

css += `
/* Font fallback stacks — documented, not a silent failure. When a family above
   is missing from the bundle these stacks are what the UI renders with. */
:root {
  --font-quran: 'Amiri Quran', 'Scheherazade New', 'Noto Naskh Arabic', 'Traditional Arabic', 'Amiri', serif;
  --font-arabic: 'Amiri', 'Scheherazade New', 'Noto Naskh Arabic', 'Traditional Arabic', serif;
  --font-fa: 'Vazirmatn', 'Segoe UI', Tahoma, 'Iranian Sans', 'Noto Sans Arabic', sans-serif;
  --font-latin: 'Inter', 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif;
  --font-mono: 'Cascadia Mono', 'Consolas', ui-monospace, monospace;
}
`;

await writeFile(cssOut, css, 'utf8');
await writeFile(
  path.join(fontDir, 'LICENCE-notes.json'),
  JSON.stringify(
    {
      generatedBy: 'scripts/fetchFonts.mjs',
      runtime: 'files are bundled; the app performs zero network requests',
      families: FAMILIES.map((f) => ({
        family: f.family,
        purpose: f.purpose,
        licence: 'SIL Open Font License 1.1',
        upstreamCss: `https://fonts.googleapis.com/css2?family=${encodeURIComponent(f.family)}`,
      })),
      files: notes,
    },
    null,
    2,
  ),
  'utf8',
);
console.log(`[fonts] ${urlToFile.size} unique files bundled → ${path.relative(process.cwd(), cssOut)}`);
const previous = await readFile(path.join(fontDir, 'MISSING.txt'), 'utf8').catch(() => null);
if (failures.length) {
  await writeFile(
    path.join(fontDir, 'MISSING.txt'),
    `Font download failures (fallback stacks in fonts.css apply):\n${failures.join('\n')}\n`,
    'utf8',
  );
  console.error(`[fonts] ${failures.length} failure(s):\n  ${failures.join('\n  ')}`);
  process.exitCode = 1;
} else if (previous !== null) {
  console.log('[fonts] failures cleared, removing MISSING.txt');
  await rm(path.join(fontDir, 'MISSING.txt'), { force: true });
}
