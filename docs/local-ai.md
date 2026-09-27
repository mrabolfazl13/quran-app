# Local AI — measurement and verdict

Updated 2026-09-28. This is the record behind the decision, not a proposal.

## Verdict

**No local AI model ships in v1.** The master prompt's rule is explicit: an AI
component must show measurable utility over the deterministic engine, and "if AI
provides insufficient measurable value: do not add it". Cost was measured on this
machine; **utility was not** — the head-to-head retrieval evaluation that would
justify shipping a model was never completed. A component whose benefit is
unmeasured cannot pass that gate, so it is out.

The deterministic engines already carry the product: `core/src/search` (FTS5 with
the `core-engine`/`like` fallbacks), `core/src/mutashabihat` (normalised word
similarity with blocking), `core/src/hifz` (segmentation, affine-gap error
classification, stability, scheduling), `core/src/mushaf` (page layout), and the
`concept`/`concept_ayah` schema which is filled by editorial packs, not by a
model. Nothing in `core/**`, `desktop/**` or `mobile/**` imports a runtime or a
model file.

## What was measured

Harness: `experiments/local-ai/` — its own `package.json`, own `node_modules`,
and a header stating it is never a product dependency. Stack:
`onnxruntime-node 1.30` through `@huggingface/transformers 3.8`, **CPU execution
provider only** (default EP, untuned thread counts), dynamic int8 quantised
graphs, mean pooling over non-pad tokens + L2 normalisation done in JS, max
sequence length 256. Device: this workstation (Windows 10.0.19045, x64, Node 24).
Every figure below is a **process-level measurement in that isolated harness**,
not an in-app measurement: no model ever ran inside the Tauri window, so nothing
here describes startup cost or UI latency of a shipped app.

Candidates (on-disk graph size, `find models -name '*.onnx'`):

| id | model | graph bytes |
| --- | --- | --- |
| `me5-small-int8` | `intfloat/multilingual-e5-small`, dynamic int8 | 118,308,185 |
| `mmnl12-int8` | `paraphrase-multilingual-MiniLM-L12-v2`, dynamic int8 | 118,308,126 |
| `minilm-en-int8` | `all-MiniLM-L6-v2`, dynamic int8 — English-only control | 22,972,370 |

Single-item latency, 220 samples per language, cold process, warm file cache
(`results/bench_*.json`, `singleItem.perKind`, medians in ms):

| model | Arabic med | Arabic p95 | Arabic at 256-token cap | Persian med | English med |
| --- | --- | --- | --- | --- | --- |
| `me5-small-int8` | 17.9 | 56.3 | 9 / 220 | 11.2 | 10.5 |
| `mmnl12-int8` | 14.1 | 35.8 | 9 / 220 | 12.1 | 8.9 |
| `minilm-en-int8` | 5.6 | 14.0 | 1 / 220 | 9.6 | 4.2 |

Two things the table says out loud. The English-only control is fastest on
Arabic precisely because it tokenises Arabic into the fewest subwords — it is
fast because it is bad at the language, which is why it is a control and not a
candidate. And 9 of 220 real ayahs exceed the 256-token cap for the multilingual
models, so any embedding of the mushaf silently truncates a nonzero slice of it.

Cold start, one process each (`timingsMs`): corpus JSON load 4.2–10.9 s, then
tokenizer + graph load **10.1–11.9 s**, warm-up batch of 10 0.5–1.4 s. A ~10 s
graph load before the first vector is the number that matters for a desktop app
the user opens to read.

Whole-corpus embedding cost, extrapolated by the harness from the measured
per-item means and labelled `EXTRAPOLATED: true` in the JSON (it is arithmetic
on measured latency, **not** a measured wall clock): embedding all 6 236 ayahs
in Arabic takes ~79 s with `me5-small` at 1-item-at-a-time and ~741 s in batches
of 100; in all three languages (ar + fa + en) 237 s / ~2 223 s. A 118 MB graph
plus a 741-second indexing pass on a low-end Android device is not a feature, it
is a liability.

Per-item detail rows are in `results/inference_<model>.csv`
(`kind,chars,seq_len,at_cap,tokenize_ms,inference_ms,pool_ms,total_ms`) if a
distribution needs re-examining.

## What was NOT measured (the reasons the verdict cannot be "ship")

- **Retrieval utility.** No embedding index was ever built
  (`scripts/embed-corpus.mjs`, `eval-retrieval.mjs`, `build-lexical-index.mjs`,
  `eval-error-classification.mjs`, `nearest-neighbours.mjs` are declared in
  `experiments/local-ai/package.json` but were not written). Without recall
  precision against the deterministic search, "AI finds concept matches better"
  is a hypothesis with zero data.
- **RAM.** `memoryMB` is `{}` in all three result files. `scripts/memwatch.ps1`
  exists and `results/mem_*.phase` files were produced, but each contains only
  the phase marker (`batch`) and no samples — the sampler's output never landed.
  Startup RSS and steady-state RSS are therefore unknown, and RAM is one of the
  five required measurements for adding a model.
- **Android.** Nothing ran on a phone or emulator; all latency is this CPU.
- **True cold disk read.** `bench_*.json` note references
  `results/cold-load-notes.md` — that file does not exist. The quoted 10–12 s
  graph load is a warm-file-cache, cold-process number.
- **Inside the shipped app.** The harness is a Node process, not the Tauri webview.

## The one useful signal for a future evaluation

`results/gold.json` + `gold-report.txt` are a 66-query gold set (32 Arabic, 34
Persian; kinds: `concept-ar` 25, `concept-fa` 29, `exact-phrase` 6,
`cross-lingual` 4, `refrain` 2) run against the **harness's own lexical probe**,
not the shipped `core/src/search` engine — read `corpus-alignment.json` before
trusting the comparison. Result: `OK` 39, `FAIL` 23, `TOO-BROAD` 4, with every
failure being `ZERO MATCHES` — i.e. concept phrasings that no surface-token
overlap reaches. That gap, 23 of 66, is the *only* quantified case for semantic
retrieval in this repo, and it is quantified against a baseline weaker than the
one that ships. Anyone revisiting local AI should start by re-running those 66
queries against the real search backend and measuring the shipped engine's
recall first; if the deterministic engine already resolves most of them through
`concept_ayah` rows or the mutashabihat index, the case for a model disappears.

## Rules this page enforces

- Adding a model later requires: graph size, startup latency, steady-state RAM,
  per-query latency, and Android numbers, all measured in the shipped shell,
  plus a retrieval delta against the deterministic engine on the gold set.
- Any AI-generated text shown to a user must be labelled `AI GENERATED` in the
  UI and stored with `produced_by` identifying it as such (`concept.produced_by`,
  `concept.relation_type` CHECK-constrained in `core/src/contracts/db.sql`).
- The experiment directory must never become a dependency. It is isolated by its
  own `package.json` + `node_modules` and is excluded from the repo (see
  `.gitignore`: `experiments/local-ai/models/`, `.../node_modules/`).
