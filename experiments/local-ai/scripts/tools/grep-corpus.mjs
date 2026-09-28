/**
 * Dev helper: grep the real corpus so every query/gold pattern in
 * `data/queries.mjs` is grounded in text that actually exists.
 *
 *   node --import ./scripts/lib/register-hooks.mjs scripts/tools/grep-corpus.mjs \
 *       --ar "اليتامى" --fa "يتيم" --limit 12
 *
 * Matches on the *normalised* streams (`normalizeWord` over `tokenizeWords`) —
 * the same comparison basis the engine and the search index use — and prints
 * the raw Uthmani text plus the Persian/English translations of each hit.
 */
import { loadCorpus } from '../lib/corpus.mjs';
import { scriptTokens } from '../lib/lexical.mjs';

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  return i > -1 ? args[i + 1] : null;
};
const limit = Number(flag('--limit') ?? 15);
const ar = flag('--ar');
const fa = flag('--fa');
const en = flag('--en');
const phrase = flag('--phrase');

const { ayahs } = loadCorpus({ withWords: false });

function norm(s) {
  return scriptTokens(s).join(' ');
}

function run(label, needle, field) {
  if (!needle) return;
  const n = norm(needle);
  const hits = ayahs.filter((a) => norm(a[field]).includes(n));
  console.log(`\n## ${label} "${needle}" -> normalised "${n}" -> ${hits.length} ayahs`);
  for (const h of hits.slice(0, limit)) {
    console.log(`  ${h.verseKey.padEnd(8)} ${h[field]}`);
    if (field !== 'textUthmani') console.log(`           ar: ${h.textUthmani}`);
  }
  if (hits.length > limit) console.log(`  … ${hits.length - limit} more`);
  console.log(`  keys: ${hits.map((h) => h.verseKey).join(' ')}`);
}

run('AR', ar, 'textUthmani');
run('FA', fa, 'fa135');
run('EN', en, 'en85');
run('PHRASE(both ar+fa)', phrase, 'textUthmani');
