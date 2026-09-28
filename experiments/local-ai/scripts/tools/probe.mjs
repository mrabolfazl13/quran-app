/**
 * Dev helper #2: probe many patterns in one corpus load, so the gold sets in
 * `data/queries.mjs` are chosen from patterns that actually match real ayah
 * text (and at a sane size — a gold set of 900 ayahs tells you nothing).
 *
 *   node --import ./scripts/lib/register-hooks.mjs scripts/tools/probe.mjs data/probes.json
 *
 * Each probe: { id, field: "ar"|"fa"|"en", pattern, note }
 * Prints: hit count, first hits with text, and the full key list.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorpus } from '../lib/corpus.mjs';
import { scriptTokens } from '../lib/lexical.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] ?? join(HERE, '..', 'data', 'probes.json');
const probes = JSON.parse(readFileSync(file, 'utf8'));
const { ayahs } = loadCorpus({ withWords: false });

const norm = (s) => scriptTokens(s ?? '').join(' ');
const fieldOf = { ar: 'textUthmani', fa: 'fa135', en: 'en85' };

for (const p of probes) {
  const f = fieldOf[p.field];
  const n = norm(p.pattern);
  const hits = ayahs.filter((a) => norm(a[f]).includes(n));
  console.log(`\n[${p.id}] ${p.field} "${p.pattern}" -> ${hits.length} ayahs`);
  for (const h of hits.slice(0, Number(process.env.SHOW ?? 6))) {
    console.log(`   ${h.verseKey.padEnd(8)} ${(h[f] ?? '').slice(0, 110)}`);
  }
  if (process.env.KEYS) console.log(`   keys: ${hits.map((h) => h.verseKey).join(' ')}`);
}
