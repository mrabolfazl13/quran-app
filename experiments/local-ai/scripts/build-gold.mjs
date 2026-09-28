/**
 * build-gold.mjs — turn `data/queries.mjs` into machine-checkable gold sets.
 *
 * For every query pattern we run the *shipped* normaliser (`normalizeWord` via
 * `scriptTokens`) over the pattern and over the cited corpus field, then take
 * the ayahs whose normalised field contains the normalised pattern. So a gold
 * set is never "I felt these five ayahs are related"; it is "these ayahs
 * contain the quoted words that are the stated reason", and the quoted evidence
 * is printed for every query so a human can disagree with the reason, not the
 * mechanics.
 *
 *   node --import ./scripts/lib/register-hooks.mjs scripts/build-gold.mjs
 *
 * Env:
 *   SHOW=n     quoted evidence examples printed per query (default 2)
 *   ONLYFAIL=1 print only failing queries
 *
 * Writes results/gold.json (used by eval-retrieval.mjs) and
 * results/gold-report.txt (the audit trail).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorpus } from './lib/corpus.mjs';
import { scriptTokens } from './lib/lexical.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, '..', 'results');
const QUERIES_FILE = join(HERE, '..', 'data', 'queries.mjs');

const norm = (s) => scriptTokens(s ?? '').join(' ');
const FIELD = { ar: 'textUthmani', fa: 'fa135', en: 'en85' };
// Gold sets wider than this cannot discriminate a retrieval system at k=5.
const MAX_USEFUL_GOLD = 80;

const { ayahs } = loadCorpus({ withWords: false });
const textOf = new Map(ayahs.map((a) => [a.verseKey, a]));
// Pre-normalise the three fields once (6236 x 3, cheap).
const normRows = ayahs.map((a) => ({
  key: a.verseKey,
  ar: norm(a.textUthmani),
  fa: norm(a.fa135),
  en: norm(a.en85),
}));

const { QUERIES } = await import(`file://${QUERIES_FILE}`);

const lines = [];
const log = (s) => { lines.push(s); if (!process.env.QUIET) process.stdout.write(s + '\n'); };

const out = [];
const failures = [];
const seenIds = new Set();

for (const q of QUERIES) {
  if (seenIds.has(q.id)) failures.push({ id: q.id, why: 'duplicate query id' });
  seenIds.add(q.id);

  const pats = [];
  const gold = new Set();
  const excluded = new Set();
  let broken = false;

  for (const p of q.patterns ?? []) {
    const row = p.field; // 'ar' | 'fa' | 'en' in the pre-normalised rows
    const field = FIELD[p.field]; // matching field on the raw ayah record
    if (!field) { pats.push({ ...p, error: 'unknown field' }); broken = true; continue; }
    const np = norm(p.pattern);
    if (!np) { pats.push({ ...p, error: 'pattern normalises to nothing' }); broken = true; continue; }
    const hits = normRows.filter((r) => (r[row] ?? '').includes(np)).map((r) => r.key);
    if (hits.length === 0) {
      pats.push({ field: p.field, pattern: p.pattern, error: 'ZERO MATCHES', hits: 0 });
      broken = true;
      continue;
    }
    const ex = new Set(q.exclude ?? []);
    const kept = hits.filter((k) => !ex.has(k));
    hits.filter((k) => ex.has(k)).forEach((k) => excluded.add(k));
    kept.forEach((k) => gold.add(k));
    pats.push({
      field: p.field,
      pattern: p.pattern,
      normalised: np,
      hits: hits.length,
      matched: kept.length,
      evidence: kept.slice(0, Number(process.env.SHOW ?? 2)).map((k) => ({
        verseKey: k,
        field,
        quote: String(textOf.get(k)?.[field] ?? '').slice(0, 160),
        arabic: String(textOf.get(k)?.textUthmani ?? '').slice(0, 140),
      })),
    });
  }

  const size = gold.size;
  const record = {
    id: q.id, lang: q.lang, kind: q.kind, text: q.text, reason: q.reason,
    patterns: pats, gold: [...gold].sort(), goldSize: size,
    excluded: [...excluded].sort(),
    status: broken ? 'FAIL' : size === 0 ? 'FAIL' : size > MAX_USEFUL_GOLD ? 'TOO-BROAD' : 'OK',
  };
  out.push(record);
  if (broken || size === 0) failures.push({ id: q.id, why: pats.map((p) => p.error).filter(Boolean).join('; ') || 'empty gold' });

  if (process.env.ONLYFAIL && record.status === 'OK') continue;
  log(`\n[${record.id}] ${record.lang}/${record.kind} :: ${q.text}`);
  log(`   status=${record.status} gold=${size}`);
  for (const p of pats) {
    log(`   - ${p.field} "${p.pattern}" -> ${p.hits ?? 0} hits` + (p.error ? `  ** ${p.error} **` : ''));
    for (const ev of p.evidence ?? []) log(`       ${ev.verseKey} [${ev.field}] ${ev.quote}\n       ${ev.verseKey} [ar] ${ev.arabic}`);
  }
  if (excluded.size) log(`   excluded (homographs, auditable): ${[...excluded].join(' ')}`);
  if (record.status === 'OK') log(`   gold keys: ${record.gold.slice(0, 12).join(' ')}${size > 12 ? ' …' : ''}`);
}

/* ------------------------------- diagnostics ------------------------------ */
const byStatus = {};
for (const r of out) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
const byKind = {};
for (const r of out) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
const byLang = {};
for (const r of out) byLang[r.lang] = (byLang[r.lang] ?? 0) + 1;

log('\n=== summary ===');
log(`queries: ${out.length}  ${JSON.stringify(byStatus)}`);
log(`by language: ${JSON.stringify(byLang)}`);
log(`by kind: ${JSON.stringify(byKind)}`);
log(`gold size: min=${Math.min(...out.map((r) => r.goldSize))} median=${out.map((r) => r.goldSize).sort((a, b) => a - b)[out.length >> 1]} max=${Math.max(...out.map((r) => r.goldSize))}`);
if (failures.length) {
  log('\n=== FAILURES (must be fixed before eval) ===');
  for (const f of failures) log(`  ${f.id}: ${f.why}`);
}

mkdirSync(RESULTS, { recursive: true });
writeFileSync(
  join(RESULTS, 'gold.json'),
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    corpusDocs: ayahs.length,
    maxUsefulGold: MAX_USEFUL_GOLD,
    normaliser: 'core/src/normalize/arabic.ts normalizeWord via scripts/lib/lexical.mjs scriptTokens',
    summary: { queries: out.length, byStatus, byKind, byLang, failures },
    queries: out,
  }, null, 2),
);
writeFileSync(join(RESULTS, 'gold-report.txt'), lines.join('\n') + '\n');
log(`\nWROTE ${join(RESULTS, 'gold.json')}`);
log(`WROTE ${join(RESULTS, 'gold-report.txt')}`);
