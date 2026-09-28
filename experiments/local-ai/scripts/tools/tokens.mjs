/**
 * Dev helper #3: list the DISTINCT normalised tokens in a field that contain a
 * substring. Used to repair gold patterns that produced ZERO MATCHES — the
 * corpus form of a word is often different from the way I typed it (definite
 * article, hamza, alef maksura, Persian spelling), and substring-matching a
 * *token* is the fastest way to see what the corpus actually says.
 *
 *   node --import ./scripts/lib/register-hooks.mjs scripts/tools/tokens.mjs ar ملح
 *   node --import ./scripts/lib/register-hooks.mjs scripts/tools/tokens.mjs fa تر
 */
import { loadCorpus } from '../lib/corpus.mjs';
import { scriptTokens, latinStream } from '../lib/lexical.mjs';

const [rowKey, sub] = process.argv.slice(2);
if (!rowKey || !sub) {
  console.error('usage: tokens.mjs <ar|fa|en> <substring> [limit]');
  process.exit(2);
}
const limit = Number(process.argv[4] ?? 40);
const { ayahs } = loadCorpus({ withWords: false });
const field = { ar: 'textUthmani', fa: 'fa135', en: 'en85' }[rowKey];
if (!field) { console.error('field must be ar|fa|en'); process.exit(2); }

const counts = new Map();
for (const a of ayahs) {
  const toks = rowKey === 'en' ? latinStream(a[field]) : scriptTokens(a[field]);
  for (const t of toks) {
    if (t.includes(sub)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
}
const list = [...counts].sort((x, y) => y[1] - x[1]);
console.log(`field=${rowKey} substring="${sub}" distinct=${list.length}`);
for (const [t, c] of list.slice(0, limit)) console.log(`  ${String(c).padStart(5)}  ${t}`);
