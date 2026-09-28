/**
 * Download the candidate model artefacts INTO this experiment directory only.
 *
 * Downloads go through `curl` (retry + resume) and every file is recorded with
 * its transferred size, wall time, throughput and sha256 in
 * `results/downloads.json`. Every size quoted in `docs/local-ai.md` comes from
 * that file — never from a model card or a vendor claim.
 *
 *   node scripts/download-models.mjs           # fetch what is missing/stale
 *   node scripts/download-models.mjs --list    # remote sizes only, no transfer
 *
 * Nothing here is a product dependency; `models/` is gitignored.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** This experiment's folder (`experiments/local-ai`) — nothing is written above it. */
const EXP = join(HERE, '..');
const MODELS = join(EXP, 'models');
const RESULTS = join(EXP, 'results');

const HF = 'https://huggingface.co';

/**
 * Candidates, in the order a real implementer would try them. Only the int8 /
 * dynamic-quantised variants are fetched: this machine has 8 GB RAM, no GPU,
 * and the fp32 files are 4x larger (their published sizes are captured by
 * `--list` for context).
 */
export const CANDIDATES = [
  {
    id: 'mmnl12-int8',
    repo: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    upstream: 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',
    note: 'compact multilingual sentence embedder (XLM-R 250k vocab, 384 d, 12 layers)',
    files: ['onnx/model_quantized.onnx', 'tokenizer.json', 'tokenizer_config.json', 'config.json'],
  },
  {
    id: 'me5-small-int8',
    repo: 'Xenova/multilingual-e5-small',
    upstream: 'intfloat/multilingual-e5-small',
    note: 'mE5-small (XLM-R 250k vocab, 384 d, 12 layers), query/passage prefixes',
    files: ['onnx/model_quantized.onnx', 'tokenizer.json', 'tokenizer_config.json', 'config.json'],
  },
  {
    id: 'minilm-en-int8',
    repo: 'Xenova/all-MiniLM-L6-v2',
    upstream: 'sentence-transformers/all-MiniLM-L6-v2',
    note: 'the cheap control: English-only MiniLM-L6 (30k WordPiece vocab, 384 d, 6 layers)',
    files: ['onnx/model_quantized.onnx', 'tokenizer.json', 'tokenizer_config.json', 'config.json'],
  },
];

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function remoteMeta(url) {
  // A 1-byte range request returns Content-Range: bytes 0-0/<total>.
  try {
    const out = execFileSync('curl', ['-sSIL', '--max-time', '40', url], { encoding: 'utf8' });
    const m = out.match(/content-range:\s*bytes\s+\d+-\d+\/(\d+)/i);
    const cl = [...out.matchAll(/content-length:\s*(\d+)/gi)].pop();
    const total = m ? Number(m[1]) : cl ? Number(cl[1]) : null;
    return { bytes: total };
  } catch {
    return { bytes: null };
  }
}

function curlDownload(url, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  const t0 = process.hrtime.bigint();
  execFileSync(
    'curl',
    ['-sSL', '--fail', '--retry', '3', '--retry-delay', '2', '-C', '-', '--max-time', '1800', '-o', dest, url],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, bytes: statSync(dest).size };
}

const listOnly = process.argv.includes('--list');
mkdirSync(RESULTS, { recursive: true });

/**
 * Previous measurements for files we no longer need to fetch. A re-run must not
 * lose the real transfer numbers, so `cached` entries inherit the timings of
 * the run that actually transferred the bytes.
 */
const previous = (() => {
  const p = join(RESULTS, 'downloads.json');
  if (!existsSync(p)) return new Map();
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return new Map((j.files ?? []).map((f) => [`${f.candidate}::${f.file}`, f]));
  } catch {
    return new Map();
  }
})();

const report = { generatedAt: new Date().toISOString(), mode: listOnly ? 'list' : 'download', files: [] };

for (const c of CANDIDATES) {
  for (const f of c.files) {
    const url = `${HF}/${c.repo}/resolve/main/${f}`;
    const dest = join(MODELS, c.id, f);
    const entry = { candidate: c.id, repo: c.repo, upstream: c.upstream, file: f, url };
    try {
      const meta = remoteMeta(url);
      entry.remoteBytes = meta.bytes;
      entry.remoteMB = meta.bytes === null ? null : +(meta.bytes / 1048576).toFixed(2);
      const fresh = existsSync(dest) && meta.bytes !== null && statSync(dest).size === meta.bytes;
      if (listOnly) {
        entry.state = existsSync(dest) ? (fresh ? 'present-and-correct' : 'present-but-stale') : 'not-downloaded';
      } else if (fresh) {
        entry.state = 'cached';
        const prev = previous.get(`${c.id}::${f}`);
        if (prev && (prev.downloadMs ?? prev.transferredBytes)) {
          entry.firstDownload = {
            downloadMs: prev.downloadMs ?? null,
            transferredBytes: prev.transferredBytes ?? null,
            throughputMBps: prev.throughputMBps ?? null,
            at: prev.at ?? null,
          };
        }
      } else {
        const { ms, bytes } = curlDownload(url, dest);
        entry.downloadMs = Math.round(ms);
        entry.transferredBytes = bytes;
        entry.at = new Date().toISOString();
        entry.throughputMBps = +((bytes / 1048576) / (ms / 1000)).toFixed(2);
        entry.state = meta.bytes !== null && bytes !== meta.bytes ? 'SIZE-MISMATCH' : 'downloaded';
      }
      if (existsSync(dest)) {
        entry.bytesOnDisk = statSync(dest).size;
        entry.onDiskMB = +(entry.bytesOnDisk / 1048576).toFixed(2);
        entry.sha256 = sha256(dest);
      }
    } catch (e) {
      entry.state = 'error';
      entry.error = String(e && e.message ? e.message : e);
    }
    report.files.push(entry);
    console.log(
      `${entry.candidate.padEnd(16)} ${entry.file.padEnd(28)} ${String(entry.remoteMB ?? '?').padStart(8)} MB  ${entry.state}` +
        (entry.throughputMBps ? `  @${entry.throughputMBps} MB/s` : '') +
        (entry.sha256 ? `  sha=${entry.sha256.slice(0, 12)}` : ''),
    );
    if (entry.state === 'SIZE-MISMATCH' || entry.state === 'error') {
      console.error('ABORT: transfer problem on', entry.file, entry.error ?? '');
      writeFileSync(join(RESULTS, 'downloads.json'), JSON.stringify(report, null, 2));
      process.exit(1);
    }
  }
}

const perCandidate = {};
for (const f of report.files) {
  if (!f.bytesOnDisk) continue;
  perCandidate[f.candidate] ??= { repo: f.repo, upstream: f.upstream, note: f.note, files: [], modelMB: 0, totalMB: 0 };
  const e = perCandidate[f.candidate];
  e.files.push({ file: f.file, onDiskMB: f.onDiskMB, sha256: f.sha256, downloadMs: f.downloadMs ?? null, throughputMBps: f.throughputMBps ?? null });
  if (f.file.endsWith('.onnx')) e.modelMB += f.onDiskMB;
  e.totalMB += f.onDiskMB;
}
for (const e of Object.values(perCandidate)) {
  e.modelMB = +e.modelMB.toFixed(2);
  e.totalMB = +e.totalMB.toFixed(2);
}
report.perCandidate = perCandidate;
report.totalsMB = Object.fromEntries(Object.entries(perCandidate).map(([k, v]) => [k, v.totalMB]));
console.log('\nper-candidate on-disk MB:', JSON.stringify(report.totalsMB));

writeFileSync(join(RESULTS, 'downloads.json'), JSON.stringify(report, null, 2));
console.log('wrote', join(RESULTS, 'downloads.json'));
