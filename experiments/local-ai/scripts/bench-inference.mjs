/**
 * Size / RAM / latency benchmark for one candidate, on THIS machine, in the
 * stack a real Tauri/desktop implementer would use: Node + onnxruntime-node
 * (via @huggingface/transformers), CPU execution provider, dynamic-int8 ONNX.
 *
 *   node --import ./scripts/lib/register-hooks.mjs scripts/bench-inference.mjs <candidateId> \
 *        [--items 220] [--batch 100] [--reps 3]
 *
 * Phases (each tagged in the memory-watcher CSV, see scripts/memwatch.ps1):
 *   load      tokenizer + graph construction
 *   warmup    discarded inferences (arena growth)
 *   single    one-item inferences over real ayah / Persian / English texts
 *   batch     batches of `--batch` items, corpus order AND length-sorted
 *
 * Outputs
 *   results/inference_<id>.csv   raw per-inference numbers (medians come from this)
 *   results/mem_<id>.csv         raw memory samples
 *   results/bench_<id>.json      summary
 */
import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadBackend, BACKENDS } from './lib/embed.mjs';
import { loadCorpus } from './lib/corpus.mjs';
import { MemWatch, writeCsv } from './lib/mem.mjs';
import { median, percentile, mean, fmt } from './lib/metrics.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXP = join(HERE, '..');
const RESULTS = join(EXP, 'results');

const argName = process.argv.slice(2).find((a) => !a.startsWith('-'));
const flagNum = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? Number(process.argv[i + 1]) : dflt;
};
if (!argName || !BACKENDS[argName]) {
  console.error(`usage: node scripts/bench-inference.mjs <${Object.keys(BACKENDS).join('|')}> [--items N] [--batch N] [--reps N]`);
  process.exit(2);
}
const N_ITEMS = flagNum('--items', 220);
const BATCH = flagNum('--batch', 100);
const REPS = flagNum('--reps', 3);
const CAP = flagNum('--max-len', BACKENDS[argName]?.maxLen ?? 256);

mkdirSync(RESULTS, { recursive: true });

/** Deterministic sample: fixed stride over the corpus, no RNG. */
function sample(texts, n) {
  const out = [];
  const stride = Math.max(1, Math.floor(texts.length / n));
  for (let i = 0; out.length < n; i += stride) out.push(texts[i % texts.length]);
  return out;
}

const watch = new MemWatch(join(RESULTS, `mem_${argName}.csv`), join(RESULTS, `mem_${argName}.phase`), { intervalMs: 50 });
watch.start();

const t0 = performance.now();
const { ayahs } = loadCorpus({ withWords: false });
const corpusMs = performance.now() - t0;

const arAll = ayahs.map((a) => a.textUthmani);
const faAll = ayahs.map((a) => a.fa135);
const enAll = ayahs.map((a) => a.en85);
const arSample = sample(arAll, N_ITEMS);
const faSample = sample(faAll, N_ITEMS);
const enSample = sample(enAll, N_ITEMS);

const backend = await loadBackend(argName, { maxLen: CAP });
const loadMs = performance.now() - t0 - corpusMs;

watch.setPhase('warmup');
const warm = await backend.encode(arSample.slice(0, 10));

watch.setPhase('single');
const rows = [];
for (const [kind, texts] of [
  ['arabic', arSample],
  ['persian', faSample],
  ['english', enSample],
]) {
  for (const t of texts) {
    const r = await backend.encodeOneItem(t);
    rows.push({
      kind,
      chars: t.length,
      seq_len: r.seqLen,
      at_cap: r.seqLen >= CAP ? 1 : 0,
      tokenize_ms: +r.tokenizeMs.toFixed(3),
      inference_ms: +r.inferenceMs.toFixed(3),
      pool_ms: +r.poolMs.toFixed(3),
      total_ms: +r.totalMs.toFixed(3),
    });
  }
}

watch.setPhase('batch');
const batchRuns = [];
const batches = [];
for (let rep = 0; rep < REPS; rep++) {
  const naive = arSample.slice(0, BATCH);
  const t1 = performance.now();
  const r1 = await backend.encode(naive);
  batchRuns.push({ rep, mode: 'corpus-order', n: naive.length, padded_len: r1.seqLen, ms: +r1.ms.toFixed(1), ms_per_item: +(r1.ms / naive.length).toFixed(3) });

  const sorted = arSample
    .slice(0, BATCH)
    .slice()
    .sort((a, b) => a.length - b.length);
  const t2 = performance.now();
  const r2 = await backend.encode(sorted);
  batchRuns.push({ rep, mode: 'length-sorted', n: sorted.length, padded_len: r2.seqLen, ms: +r2.ms.toFixed(1), ms_per_item: +(r2.ms / sorted.length).toFixed(3) });
  batches.push({ naive: r1.ms / naive.length, sorted: r2.ms / sorted.length });
}
// smaller batches too: batch size is a real tuning knob
for (const size of [8, 32]) {
  const set = arSample.slice(0, size).sort((a, b) => a.length - b.length);
  const r = await backend.encode(set);
  batchRuns.push({ rep: null, mode: `length-sorted-batch${size}`, n: size, padded_len: r.seqLen, ms: +r.ms.toFixed(1), ms_per_item: +(r.ms / size).toFixed(3) });
}

const mem = await watch.stop();

const byKind = {};
for (const kind of ['arabic', 'persian', 'english']) {
  const r = rows.filter((x) => x.kind === kind);
  byKind[kind] = {
    n: r.length,
    tokenLenMedian: median(r.map((x) => x.seq_len)),
    tokenLenMax: Math.max(...r.map((x) => x.seq_len)),
    atCap: r.filter((x) => x.at_cap).length,
    totalMsMedian: +fmt(median(r.map((x) => x.total_ms)), 3),
    totalMsP95: +fmt(percentile(r.map((x) => x.total_ms), 95), 3),
    inferenceMsMedian: +fmt(median(r.map((x) => x.inference_ms)), 3),
    tokenizeMsMedian: +fmt(median(r.map((x) => x.tokenize_ms)), 3),
  };
}
const allTotal = rows.map((r) => r.total_ms);

const summary = {
  candidate: argName,
  label: BACKENDS[argName].label,
  stack: {
    runtime: 'onnxruntime-node 1.30 via @huggingface/transformers 3.8',
    provider: 'CPU (default EP, no tuning of thread counts)',
    quantisation: 'dynamic int8 (onnx/model_quantized.onnx)',
    pooling: 'mean over non-pad tokens + L2 normalise (done in JS)',
    maxLen: CAP,
  },
  nInferences: rows.length,
  timingsMs: {
    corpusJsonLoad: Math.round(corpusMs),
    tokenizerPlusGraphLoad: Math.round(loadMs),
    warmupBatch10: +warm.ms.toFixed(1),
    note: 'process-cold; the ONNX file is in the Windows file cache once downloaded, so this is a warm-file cold-process load. The very first load after transfer (page cache empty) is recorded separately in results/cold-load-notes.md.',
  },
  singleItem: {
    perKind: byKind,
    all: {
      median: +fmt(median(allTotal), 3),
      p95: +fmt(percentile(allTotal, 95), 3),
      mean: +fmt(mean(allTotal), 3),
      n: allTotal.length,
    },
  },
  batch: { requestedSize: BATCH, runs: batchRuns },
  memoryMB: {
    osPeakWorkingSetMB: mem.osPeakWorkingSetMB,
    sampledPeakWorkingSetMB: mem.sampledPeakWorkingSetMB,
    nodePeakRSSMB: mem.nodePeakRSSMB,
    minFreeRamMB: mem.minFreeRamMB,
    samples: mem.samples,
    intervalMs: mem.intervalMs,
    phases: mem.phases,
  },
  extrapolation: {},
};

/**
 * Full-corpus throughput, EXTRAPOLATED from the measured batch numbers.
 * Arithmetic is written out so it can be checked:
 *   seconds = items × ms_per_item / 1000
 */
const perItem = {
  single: median(allTotal),
  batch100_corpus_order: median(batchRuns.filter((b) => b.mode === 'corpus-order').map((b) => b.ms_per_item)),
  batch100_length_sorted: median(batchRuns.filter((b) => b.mode === 'length-sorted').map((b) => b.ms_per_item)),
};
for (const [label, ms] of Object.entries(perItem)) {
  summary.extrapolation[label] = {
    EXTRAPOLATED: true,
    msPerItem: +Number(ms).toFixed(3),
    formula: `6236 ayahs x ${Number(ms).toFixed(3)} ms/item / 1000 (also x3 for ar+fa+en)`,
    secondsArabicOnly: +((6236 * ms) / 1000).toFixed(1),
    secondsThreeLanguages: +((6236 * 3 * ms) / 1000).toFixed(1),
  };
}

writeCsv(
  join(RESULTS, `inference_${argName}.csv`),
  ['kind', 'chars', 'seq_len', 'at_cap', 'tokenize_ms', 'inference_ms', 'pool_ms', 'total_ms'],
  rows.map((r) => [r.kind, r.chars, r.seq_len, r.at_cap, r.tokenize_ms, r.inference_ms, r.pool_ms, r.total_ms]),
);
writeFileSync(join(RESULTS, `bench_${argName}.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`\nCSV: results/inference_${argName}.csv (${rows.length} inferences), memory: results/mem_${argName}.csv`);
