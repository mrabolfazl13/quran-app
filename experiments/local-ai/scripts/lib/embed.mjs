/**
 * ONNX embedding backend.
 *
 * This is the stack a real implementer would try first for a Tauri/Node app:
 * `@huggingface/transformers` (tokenizer + graph) on top of `onnxruntime-node`,
 * CPU execution provider, quantised ONNX weights, mean pooling + L2
 * normalisation. No Python, no torch, no GPU.
 *
 * Every backend exposes the same surface so a benchmark can treat them alike:
 *   encode(texts)            -> { vectors: Float32Array[], ms }
 *   encodeTokens(text)       -> { ids, tokens, unk }   (script-competence probe)
 *   stats                      dim, vocab-ish info, maxLen, prefixes
 *
 * Prefix conventions are per model family and are applied here, not in the
 * callers: mE5 was trained with `query: `/`passage: ` prefixes, the
 * sentence-transformers multilingual MiniLM was not.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, AutoTokenizer, AutoModel } from '@huggingface/transformers';

const HERE = dirname(fileURLToPath(import.meta.url));
export const EXP = join(HERE, '..', '..');
export const MODELS_DIR = join(EXP, 'models');

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = MODELS_DIR;
env.useBrowserCache = false;

export const BACKENDS = {
  'mmnl12-int8': {
    dir: 'mmnl12-int8',
    label: 'paraphrase-multilingual-MiniLM-L12-v2 (dynamic int8)',
    repo: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    upstream: 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',
    licence: 'Apache-2.0 (sentence-transformers model card)',
    dim: 384,
    maxLen: 256,
    queryPrefix: '',
    docPrefix: '',
    family: 'multilingual-minilm',
  },
  'me5-small-int8': {
    dir: 'me5-small-int8',
    label: 'multilingual-e5-small (dynamic int8)',
    repo: 'Xenova/multilingual-e5-small',
    upstream: 'intfloat/multilingual-e5-small',
    licence: 'MIT (intfloat model card)',
    dim: 384,
    maxLen: 256,
    queryPrefix: 'query: ',
    docPrefix: 'passage: ',
    family: 'me5',
  },
  'minilm-en-int8': {
    dir: 'minilm-en-int8',
    label: 'all-MiniLM-L6-v2 (dynamic int8) — English-only control',
    repo: 'Xenova/all-MiniLM-L6-v2',
    upstream: 'sentence-transformers/all-MiniLM-L6-v2',
    licence: 'Apache-2.0 (sentence-transformers model card)',
    dim: 384,
    maxLen: 256,
    queryPrefix: '',
    docPrefix: '',
    family: 'english-minilm',
  },
};

function asNumber(id) {
  return typeof id === 'bigint' ? Number(id) : Number(id);
}

/** Mean-pool the last hidden state over non-pad positions, then L2-normalise. */
export function poolAndNormalise(hidden, mask, dims, normalize = true) {
  const [b, s, h] = dims;
  const out = [];
  for (let bi = 0; bi < b; bi++) {
    const v = new Float32Array(h);
    let counted = 0;
    for (let si = 0; si < s; si++) {
      const m = asNumber(mask[bi * s + si]);
      if (m === 0) continue;
      counted++;
      const off = (bi * s + si) * h;
      for (let hi = 0; hi < h; hi++) v[hi] += hidden[off + hi];
    }
    const n = counted || 1;
    for (let hi = 0; hi < h; hi++) v[hi] /= n;
    if (normalize) {
      let dot = 0;
      for (let hi = 0; hi < h; hi++) dot += v[hi] * v[hi];
      const inv = dot > 0 ? 1 / Math.sqrt(dot) : 1;
      for (let hi = 0; hi < h; hi++) v[hi] *= inv;
    }
    out.push(v);
  }
  return out;
}

export async function loadBackend(id, { maxLen, dtype = 'q8', log = () => {} } = {}) {
  const cfg = BACKENDS[id];
  if (!cfg) throw new Error(`unknown backend ${id}`);
  const limit = maxLen ?? cfg.maxLen;
  const tokenizer = await AutoTokenizer.from_pretrained(cfg.dir);
  // `dtype: 'q8'` selects `onnx/model_quantized.onnx` — the dynamic-int8 graph.
  const model = await AutoModel.from_pretrained(cfg.dir, { dtype });
  const realUnkId = tokenizer?.unk_token_id ?? 0;

  const encodeRaw = async (texts) => {
    const enc = await tokenizer(texts, { padding: true, truncation: true, max_length: limit });
    const ids = enc.input_ids;
    const outputs = await model({ input_ids: ids, attention_mask: enc.attention_mask });
    const t = outputs.last_hidden_state ?? outputs.logits;
    const vectors = poolAndNormalise(t.data, enc.attention_mask.data, t.dims, true);
    return { vectors, seqLen: t.dims[1], ids };
  };

  return {
    id,
    cfg,
    maxLen: limit,
    async encode(texts) {
      const t0 = process.hrtime.bigint();
      const { vectors, seqLen } = await encodeRaw(texts.map((x) => cfg.docPrefix + x));
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      return { vectors, ms, seqLen };
    },
    async encodeQueries(texts) {
      const t0 = process.hrtime.bigint();
      const { vectors, seqLen } = await encodeRaw(texts.map((x) => cfg.queryPrefix + x));
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      return { vectors, ms, seqLen };
    },
    /** Single item, with the tokenize/inference split measured separately. */
    async encodeOneItem(text, prefix = cfg.docPrefix) {
      const t0 = process.hrtime.bigint();
      const enc = await tokenizer([prefix + text], { padding: false, truncation: true, max_length: limit });
      const tTok = process.hrtime.bigint();
      const outputs = await model({ input_ids: enc.input_ids, attention_mask: enc.attention_mask });
      const tInf = process.hrtime.bigint();
      const t = outputs.last_hidden_state ?? outputs.logits;
      const [v] = poolAndNormalise(t.data, enc.attention_mask.data, t.dims, true);
      const tEnd = process.hrtime.bigint();
      return {
        vector: v,
        seqLen: t.dims[1],
        tokenizeMs: Number(tTok - t0) / 1e6,
        inferenceMs: Number(tInf - tTok) / 1e6,
        poolMs: Number(tEnd - tInf) / 1e6,
        totalMs: Number(tEnd - t0) / 1e6,
      };
    },
    /** Script-competence probe: subword count per word + UNK rate. */
    async tokenStats(text) {
      const enc = await tokenizer([text], { padding: false, truncation: true, max_length: limit });
      const ids = Array.from(enc.input_ids.data, asNumber);
      const unk = ids.filter((i) => i === realUnkId).length;
      return { tokens: ids.length, unk, unkRate: ids.length ? unk / ids.length : 0, ids };
    },
    decodeId(i) {
      try {
        return tokenizer.decode([asNumber(i)]);
      } catch {
        return null;
      }
    },
  };
}

/** Cosine of two L2-normalised vectors = dot product. */
export function cosine(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

/** Rank `query` against `docs` (pre-normalised vectors). */
export function rankByCosine(query, docs, limit = 50) {
  const scored = docs.map((d) => ({ id: d.id, score: cosine(query, d.vector) }));
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.slice(0, limit);
}
