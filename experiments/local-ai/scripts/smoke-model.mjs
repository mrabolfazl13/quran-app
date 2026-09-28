/**
 * Smoke test: can the Node ONNX stack actually load and run each candidate,
 * and is the tokenizer behaving on Arabic / Persian text?
 *
 *   node scripts/smoke-model.mjs [candidateId ...]
 *
 * Prints cold load time, one embedding per sample, self-similarity, and the
 * UNK / subword statistics that show script competence (an English tokenizer
 * turns Arabic into UNKs — that is the point of printing this).
 */
import { performance } from 'node:perf_hooks';
import { loadBackend, BACKENDS, cosine } from './lib/embed.mjs';

const SAMPLES = [
  { label: 'ar 55:13 (refrain)', text: 'فَبِأَيِّ آلَاءِ رَبِّكُمَا تُكَذِّبَانِ' },
  { label: 'ar 112:1', text: 'قُلْ هُوَ ٱللَّهُ أَحَدٌ' },
  { label: 'fa 55:13 (translation)', text: 'پس [ای جن و انس] كدام یک از نعمت‌های پروردگارتان را انكار مى‌كنید؟' },
  { label: 'fa concept', text: 'بخشش و توبه برای کسانی که ایمان آوردند' },
  { label: 'en concept', text: 'forgiveness and repentance for those who believe' },
];

const ids = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const targets = ids.length ? ids : Object.keys(BACKENDS);

for (const id of targets) {
  const t0 = performance.now();
  let backend;
  try {
    backend = await loadBackend(id);
  } catch (e) {
    console.log(`\n### ${id}: LOAD FAILED — ${e.message}`);
    continue;
  }
  const coldMs = Math.round(performance.now() - t0);
  console.log(`\n### ${id}  (${BACKENDS[id].label})`);
  console.log(`cold load (tokenizer + model, incl. disk read): ${coldMs} ms`);
  const vectors = [];
  for (const s of SAMPLES) {
    const r = await backend.encodeOneItem(s.text);
    vectors.push({ label: s.label, v: r.vector });
    console.log(
      `  ${s.label.padEnd(24)} seq=${String(r.seqLen).padStart(3)} tok=${r.tokenizeMs.toFixed(1)}ms inf=${r.inferenceMs.toFixed(1)}ms pool=${r.poolMs.toFixed(1)}ms`,
    );
  }
  console.log('  self-similarity check (must be 1.000):', cosine(vectors[0].v, vectors[0].v).toFixed(4));
  console.log('  ar-refrain vs fa-translation cosine:', cosine(vectors[0].v, vectors[2].v).toFixed(4));
  console.log('  fa-concept vs en-concept cosine:', cosine(vectors[3].v, vectors[4].v).toFixed(4));
  for (const s of SAMPLES) {
    const st = await backend.tokenStats(s.text);
    console.log(`  tokens "${s.label}": ${st.tokens} unk=${st.unk} (${(st.unkRate * 100).toFixed(1)}%)`);
  }
  console.log(`  peak RSS so far: ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`);
}
