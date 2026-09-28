/**
 * Dev helper #4 (one-off, batched): for a list of {field, term} probes, load the
 * corpus ONCE and report (a) exact-phrase hit count over the joined normalised
 * stream, (b) the top distinct normalised TOKENS containing the term. This is
 * how the ZERO-MATCHES gold patterns in data/queries.mjs were repaired — every
 * replacement pattern below is taken from column (b), i.e. from text that is
 * provably in the corpus.
 *
 *   node --import ./scripts/lib/register-hooks.mjs scripts/tools/fix-probe.mjs ar ملح
 *   node --import ./scripts/lib/register-hooks.mjs scripts/tools/fix-probe.mjs fa يتیم en orphan
 */
import { loadCorpus } from '../lib/corpus.mjs';
import { scriptTokens, latinStream } from '../lib/lexical.mjs';

const field = { ar: 'textUthmani', fa: 'fa135', en: 'en85' };
const argv = process.argv.slice(2);
const { ayahs } = loadCorpus({ withWords: false });

const streams = {
  ar: ayahs.map((a) => scriptTokens(a.textUthmani ?? '').join(' ')),
  fa: ayahs.map((a) => scriptTokens(a.fa135 ?? '').join(' ')),
  en: ayahs.map((a) => latinStream(a.en85 ?? '').join(' ')),
};
const toks = {
  ar: ayahs.map((a) => scriptTokens(a.textUthmani ?? '')),
  fa: ayahs.map((a) => scriptTokens(a.fa135 ?? '')),
  en: ayahs.map((a) => latinStream(a.en85 ?? '')),
};

for (let i = 0; i < argv.length; i += 2) {
  const rowKey = argv[i];
  const term = argv[i + 1];
  const normTerm = (rowKey === 'en' ? latinStream(term) : scriptTokens(term)).join(' ');
  const phrase = streams[rowKey].filter((s) => s.includes(normTerm)).length;
  const counts = new Map();
  for (const list of toks[rowKey]) {
    for (const t of list) if (t.includes(normTerm)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const single = (rowKey === 'en' ? latinStream(term) : scriptTokens(term));
  console.log(`\n### ${rowKey} "${term}" -> norm="${normTerm}" phraseHits=${phrase} tokens=${single.length}`);
  for (const [t, c] of top) console.log(`   ${String(c).padStart(4)}  ${t}`);
  if (!top.length) {
    // fall back to a 3-char stem so the misspelling is obvious
    const stem = normTerm.slice(0, Math.max(2, normTerm.length - 3));
    const c2 = new Map();
    for (const list of toks[rowKey]) for (const t of list) if (t.includes(stem)) c2.set(t, (c2.get(t) ?? 0) + 1);
    console.log(`   (no token contains the term; stem "${stem}"): ` +
      [...c2].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t, c]) => `${t}x${c}`).join(' '));
  }
}
