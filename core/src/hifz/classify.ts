/**
 * Deterministic error engine: align what the learner produced against what the
 * ayah expects, and emit `DetectedError[]`.
 *
 * No LLM, no randomness, no clock. Alignment is Needleman-Wunsch with affine
 * gap penalties over NORMALISED words (via `normalizeWord`, the single
 * definition of "same word" in this repository). Costs and thresholds are in
 * `params.ts` and documented in `docs/hifz-engine.md`.
 */

import type { DetectedError, ErrorKind, RecallMode } from '../contracts/hifz';
import {
  normalizeWord,
  tokenSimilarity,
  tokenizeWords,
  editDistance,
  setSimilarity,
} from '../normalize/arabic';
import {
  ALIGN_GAP_EXTEND_COST,
  ALIGN_GAP_OPEN_COST,
  ALIGN_MATCH_COST,
  ALIGN_MISMATCH_COST,
  CONFUSION_SIMILARITY,
  CONTINUATION_MIN_WORDS,
  NEAR_MISS_SIMILARITY,
  POSITIONAL_FAILURE_MODES,
  RUN_SIMILARITY,
  SUCCESS_ACCURACY,
  WRONG_TRANSITION_SIMILARITY,
} from './params';

/** Another ayah, as word text. The engine normalises it; nothing is mutated. */
export interface CandidateAyah {
  verseKey: string;
  /** Raw or normalised word tokens of that ayah. */
  words: readonly string[];
}

export interface SegmentSpan {
  position: number;
  fromWord: number;
  toWord: number;
}

export interface ClassifyInput {
  /** Expected ayah words in order (raw tokens are fine; normalised internally). */
  expected: readonly string[];
  /** Words the learner produced, in order. */
  produced: readonly string[];
  mode?: RecallMode;
  itemId?: string | null;
  verseKey?: string | null;
  /** Similar ayahs (mutashabihat). Drives `similar-ayah-confusion`. */
  confusionCandidates?: readonly CandidateAyah[];
  /** Other ayahs' continuations. Drives `wrong-transition`. */
  continuations?: readonly CandidateAyah[];
  /** Segment spans, so each error can carry its `segmentPosition`. */
  segments?: readonly SegmentSpan[];
  /**
   * Emit the positional beginning/middle/ending failure. Defaults to true for
   * whole-ayah modes (see `POSITIONAL_FAILURE_MODES`).
   */
  positionalFailures?: boolean;
  /**
   * 1-based, inclusive range of `expected` the probe actually asked for, in
   * ayah-absolute word positions (`RecallProbe.fromWord` / `toWord`).
   *
   * A `segment`, `missing-word`, `opening` or `transition` step cues a slice of
   * the ayah, so the slice is what gets graded: a flawless two-word segment
   * inside a thirteen-word ayah is a success, not a 15% recall. Omit it to grade
   * every expected word.
   *
   * Results stay ayah-absolute regardless — `errors[].expectedPosition`,
   * `alignment[].expectedIndex` and `firstErrorPosition` count from the start of
   * the ayah, so segment attribution and the word-by-word view keep pointing at
   * the same words they did before.
   */
  span?: { fromWord: number; toWord: number } | null;
}

export type AlignmentOpKind = 'match' | 'mismatch' | 'omission' | 'insertion';

export interface AlignmentOp {
  kind: AlignmentOpKind;
  /** 0-based index into the expected list, or null for insertions. Ayah-absolute when a `span` was given. */
  expectedIndex: number | null;
  /** 0-based index into the produced list, or null for omissions. */
  producedIndex: number | null;
  expected: string | null;
  produced: string | null;
  expectedNorm: string | null;
  producedNorm: string | null;
}

export interface ClassifiedRun {
  kind: ErrorKind;
  /** 1-based expected position where the run surfaces. */
  fromWord: number;
  toWord: number;
  confusedWithVerseKey: string | null;
}

export interface ClassificationResult {
  itemId: string | null;
  verseKey: string | null;
  mode: RecallMode;
  alignment: AlignmentOp[];
  runs: ClassifiedRun[];
  /** Every alignment row, including the `correct` ones, in ayah order. */
  errors: DetectedError[];
  expectedWordCount: number;
  /** Expected words produced in place, after the extra-word penalty. */
  correctWordCount: number;
  /** Expected words matched exactly, before the extra-word penalty. */
  matchedWordCount: number;
  /** Produced words with no counterpart in the ayah. */
  unpairedProducedWordCount: number;
  /** correctWordCount / expectedWordCount; 0 for an empty recitation. */
  accuracy: number;
  firstErrorPosition: number | null;
}

type State = 'M' | 'X' | 'Y';

interface Cell {
  cost: number;
  from: State;
}

const EMPTY = Number.POSITIVE_INFINITY;

/** Normalised word list, empties dropped (ornaments, breaths, stray marks). */
function normList(words: readonly string[]): { raw: string[]; norm: string[] } {
  const raw: string[] = [];
  const norm: string[] = [];
  for (const w of words) {
    const n = normalizeWord(w);
    if (n.length === 0) continue;
    raw.push(w);
    norm.push(n);
  }
  return { raw, norm };
}

/**
 * Needleman-Wunsch with affine gaps.
 *
 * Tie preference is fixed (M before X before Y, both in the DP relax and in
 * the final state choice) so the alignment — and therefore the score — is
 * byte-identical across runs and ports.
 */
export function alignWords(expectedNorm: readonly string[], producedNorm: readonly string[]): AlignmentOp[] {
  const n = expectedNorm.length;
  const m = producedNorm.length;
  const diag: Cell[][] = [];
  const del: Cell[][] = [];
  const ins: Cell[][] = [];
  const row = (len: number): Cell[] =>
    Array.from({ length: len }, () => ({ cost: EMPTY, from: 'M' as State }));
  for (let i = 0; i <= n; i += 1) {
    diag.push(row(m + 1));
    del.push(row(m + 1));
    ins.push(row(m + 1));
  }
  diag[0]![0] = { cost: 0, from: 'M' };
  for (let i = 1; i <= n; i += 1) {
    const open = diag[i - 1]![0]!.cost + ALIGN_GAP_OPEN_COST + ALIGN_GAP_EXTEND_COST;
    const extend = del[i - 1]![0]!.cost + ALIGN_GAP_EXTEND_COST;
    const openIns = ins[i - 1]![0]!.cost + ALIGN_GAP_OPEN_COST + ALIGN_GAP_EXTEND_COST;
    const best = Math.min(open, extend, openIns);
    const from: State = best === open ? 'M' : best === extend ? 'X' : 'Y';
    del[i]![0] = { cost: best === EMPTY ? EMPTY : best, from };
  }
  for (let j = 1; j <= m; j += 1) {
    const open = diag[0]![j - 1]!.cost + ALIGN_GAP_OPEN_COST + ALIGN_GAP_EXTEND_COST;
    const extend = ins[0]![j - 1]!.cost + ALIGN_GAP_EXTEND_COST;
    const openDel = del[0]![j - 1]!.cost + ALIGN_GAP_OPEN_COST + ALIGN_GAP_EXTEND_COST;
    const best = Math.min(open, extend, openDel);
    const from: State = best === open ? 'M' : best === extend ? 'Y' : 'X';
    ins[0]![j] = { cost: best === EMPTY ? EMPTY : best, from };
  }
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const same = expectedNorm[i - 1] === producedNorm[j - 1];
      const substitution = same ? ALIGN_MATCH_COST : ALIGN_MISMATCH_COST;
      const prevDiag = Math.min(diag[i - 1]![j - 1]!.cost, del[i - 1]![j - 1]!.cost, ins[i - 1]![j - 1]!.cost);
      const diagFrom: State =
        prevDiag === diag[i - 1]![j - 1]!.cost ? 'M' : prevDiag === del[i - 1]![j - 1]!.cost ? 'X' : 'Y';
      diag[i]![j] = {
        cost: prevDiag === EMPTY ? EMPTY : prevDiag + substitution,
        from: diagFrom,
      };
      const delOpenM = diag[i - 1]![j]!.cost + ALIGN_GAP_OPEN_COST + ALIGN_GAP_EXTEND_COST;
      const delExtend = del[i - 1]![j]!.cost + ALIGN_GAP_EXTEND_COST;
      const delOpenIns = ins[i - 1]![j]!.cost + ALIGN_GAP_OPEN_COST + ALIGN_GAP_EXTEND_COST;
      const delBest = Math.min(delOpenM, delExtend, delOpenIns);
      del[i]![j] = {
        cost: delBest,
        from: delBest === delOpenM ? 'M' : delBest === delExtend ? 'X' : 'Y',
      };
      const insOpenM = diag[i]![j - 1]!.cost + ALIGN_GAP_OPEN_COST + ALIGN_GAP_EXTEND_COST;
      const insExtend = ins[i]![j - 1]!.cost + ALIGN_GAP_EXTEND_COST;
      const insOpenDel = del[i]![j - 1]!.cost + ALIGN_GAP_OPEN_COST + ALIGN_GAP_EXTEND_COST;
      const insBest = Math.min(insOpenM, insExtend, insOpenDel);
      ins[i]![j] = {
        cost: insBest,
        from: insBest === insOpenM ? 'M' : insBest === insExtend ? 'Y' : 'X',
      };
    }
  }
  const finalCosts = [diag[n]![m]!.cost, del[n]![m]!.cost, ins[n]![m]!.cost];
  let state: State = 'M';
  let bestFinal = finalCosts[0]!;
  if (finalCosts[1]! < bestFinal) {
    bestFinal = finalCosts[1]!;
    state = 'X';
  }
  if (finalCosts[2]! < bestFinal) {
    state = 'Y';
  }
  const ops: AlignmentOp[] = [];
  let i = n;
  let j = m;
  let guard = n + m + 2;
  while ((i > 0 || j > 0) && guard-- > 0) {
    if (state === 'M') {
      if (i === 0 || j === 0) {
        state = i > 0 ? 'X' : 'Y';
        continue;
      }
      ops.push({
        kind: expectedNorm[i - 1] === producedNorm[j - 1] ? 'match' : 'mismatch',
        expectedIndex: i - 1,
        producedIndex: j - 1,
        expected: null,
        produced: null,
        expectedNorm: expectedNorm[i - 1] ?? null,
        producedNorm: producedNorm[j - 1] ?? null,
      });
      const previous = diag[i]![j]!.from;
      i -= 1;
      j -= 1;
      state = previous;
      continue;
    }
    if (state === 'X') {
      if (i === 0) {
        state = 'Y';
        continue;
      }
      ops.push({
        kind: 'omission',
        expectedIndex: i - 1,
        producedIndex: null,
        expected: null,
        produced: null,
        expectedNorm: expectedNorm[i - 1] ?? null,
        producedNorm: null,
      });
      const previous = del[i]![j]!.from;
      i -= 1;
      state = previous;
      continue;
    }
    if (j === 0) {
      state = 'X';
      continue;
    }
    ops.push({
      kind: 'insertion',
      expectedIndex: null,
      producedIndex: j - 1,
      expected: null,
      produced: null,
      expectedNorm: null,
      producedNorm: producedNorm[j - 1] ?? null,
    });
    const previous = ins[i]![j]!.from;
    j -= 1;
    state = previous;
  }
  ops.reverse();
  return ops;
}

/** Best token-similarity of `run` against any window of `candidate` of that size. */
function bestWindowSimilarity(
  run: readonly string[],
  candidate: readonly string[],
): { score: number; index: number } {
  if (run.length === 0 || candidate.length === 0) return { score: 0, index: -1 };
  if (candidate.length <= run.length) {
    return { score: tokenSimilarity(run, candidate), index: 0 };
  }
  let best = { score: 0, index: 0 };
  for (let start = 0; start + run.length <= candidate.length; start += 1) {
    const score = tokenSimilarity(run, candidate.slice(start, start + run.length));
    if (score > best.score) best = { score, index: start };
  }
  return best;
}

function multisetEquals(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = a.slice().sort();
  const sb = b.slice().sort();
  for (let i = 0; i < sa.length; i += 1) if (sa[i] !== sb[i]) return false;
  return true;
}

function segmentFor(spans: readonly SegmentSpan[] | undefined, wordPosition: number): number | null {
  if (!spans || spans.length === 0) return null;
  for (const s of spans) if (wordPosition >= s.fromWord && wordPosition <= s.toWord) return s.position;
  return null;
}

/** The graded range, clamped into the word list; the whole list when no span is given. */
function spanBounds(
  span: { fromWord: number; toWord: number } | null | undefined,
  wordCount: number,
): { from: number; to: number } {
  if (!span) return { from: 1, to: Math.max(0, wordCount) };
  const from = Math.max(1, Math.min(Math.trunc(span.fromWord), Math.max(1, wordCount)));
  return { from, to: Math.max(from, Math.min(Math.trunc(span.toWord), wordCount)) };
}

/** Maximal sequences of consecutive non-matching alignment ops. */
function runsOf(ops: readonly AlignmentOp[]): AlignmentOp[][] {
  const runs: AlignmentOp[][] = [];
  let current: AlignmentOp[] = [];
  for (const op of ops) {
    if (op.kind === 'match') {
      if (current.length > 0) runs.push(current);
      current = [];
      continue;
    }
    current.push(op);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

interface RunClassification {
  errors: DetectedError[];
  run: ClassifiedRun | null;
}

/**
 * Classify one divergence run: permutation, cross-ayah confusion, wrong
 * transition, substitution, omission or repetition.
 */
function classifyRun(
  run: readonly AlignmentOp[],
  ctx: {
    expectedRaw: readonly string[];
    producedRaw: readonly string[];
    expectedNorm: readonly string[];
    producedNorm: readonly string[];
    confusionCandidates: readonly CandidateAyah[];
    continuations: readonly CandidateAyah[];
    segments: readonly SegmentSpan[] | undefined;
  },
): RunClassification {
  const expectedOps = run.filter((op) => op.expectedIndex !== null);
  const producedOps = run.filter((op) => op.producedIndex !== null);
  const firstExpectedIndex = expectedOps.length > 0 ? expectedOps[0]!.expectedIndex! : null;
  const anchorPosition =
    firstExpectedIndex !== null
      ? firstExpectedIndex + 1
      : Math.min(
          ctx.expectedNorm.length,
          (producedOps.length > 0 ? producedOps[0]!.producedIndex! : 0) + 1,
        );
  const segmentPosition = segmentFor(ctx.segments, anchorPosition);
  const producedRunNorm = producedOps.map((op) => op.producedNorm ?? '');
  const expectedRunNorm = expectedOps.map((op) => op.expectedNorm ?? '');

  const errors: DetectedError[] = [];
  let attributed: ClassifiedRun | null = null;

  // 1. cross-ayah attribution (only for runs of 2+ produced words).
  if (producedRunNorm.length >= CONTINUATION_MIN_WORDS) {
    let confusion: { verseKey: string; score: number } | null = null;
    for (const candidate of ctx.confusionCandidates) {
      const words = candidate.words.map(normalizeWord).filter((w) => w.length > 0);
      const best = bestWindowSimilarity(producedRunNorm, words);
      if (best.score >= RUN_SIMILARITY && (!confusion || best.score > confusion.score)) {
        confusion = { verseKey: candidate.verseKey, score: best.score };
      }
    }
    let transition: { verseKey: string; score: number } | null = null;
    for (const candidate of ctx.continuations) {
      const words = candidate.words.map(normalizeWord).filter((w) => w.length > 0);
      const best = bestWindowSimilarity(producedRunNorm, words);
      // A wrong transition is a continuation of *another* ayah: the matched
      // window has to start at that ayah's first word, otherwise the learner
      // merely reused a phrase from the middle of some other ayah.
      const reachesEnd = firstExpectedIndex !== null && firstExpectedIndex + 1 + expectedRunNorm.length > ctx.expectedNorm.length;
      if (
        (best.index === 0 || reachesEnd) &&
        best.score >= WRONG_TRANSITION_SIMILARITY &&
        (!transition || best.score > transition.score)
      ) {
        transition = { verseKey: candidate.verseKey, score: best.score };
      }
    }
    const toWord =
      firstExpectedIndex !== null
        ? Math.min(
            ctx.expectedNorm.length,
            Math.max(expectedRunNorm.length, producedRunNorm.length) + firstExpectedIndex,
          )
        : anchorPosition;
    if (confusion) {
      attributed = {
        kind: 'similar-ayah-confusion',
        fromWord: anchorPosition,
        toWord,
        confusedWithVerseKey: confusion.verseKey,
      };
      errors.push({
        kind: 'similar-ayah-confusion',
        expectedPosition: anchorPosition,
        expected: ctx.expectedRaw[anchorPosition - 1] ?? null,
        actual: ctx.producedRaw[producedOps[0]?.producedIndex ?? 0] ?? null,
        confusedWithVerseKey: confusion.verseKey,
        segmentPosition,
        explanation: `Produced the words of ${confusion.verseKey} instead of this ayah (similarity ${confusion.score.toFixed(2)}).`,
      });
      return { errors, run: attributed };
    }
    if (transition) {
      attributed = {
        kind: 'wrong-transition',
        fromWord: anchorPosition,
        toWord,
        confusedWithVerseKey: transition.verseKey,
      };
      errors.push({
        kind: 'wrong-transition',
        expectedPosition: anchorPosition,
        expected: ctx.expectedRaw[anchorPosition - 1] ?? null,
        actual: ctx.producedRaw[producedOps[0]?.producedIndex ?? 0] ?? null,
        confusedWithVerseKey: transition.verseKey,
        segmentPosition,
        explanation: `Continued into ${transition.verseKey} instead of this ayah (similarity ${transition.score.toFixed(2)}).`,
      });
      return { errors, run: attributed };
    }
  }

  // 2. permutation inside the run: same words, wrong order.
  const permuted =
    expectedRunNorm.length >= 2 &&
    producedRunNorm.length >= 2 &&
    multisetEquals(expectedRunNorm, producedRunNorm);

  // 3. pair up expected/produced positionally, leftovers are pure gaps.
  const pairs = Math.min(expectedOps.length, producedOps.length);
  for (let k = 0; k < pairs; k += 1) {
    const e = expectedOps[k]!;
    const p = producedOps[k]!;
    const position = (e.expectedIndex ?? 0) + 1;
    const expectedWord = ctx.expectedRaw[e.expectedIndex ?? 0] ?? null;
    const producedWord = ctx.producedRaw[p.producedIndex ?? 0] ?? null;
    const similarity = tokenSimilarity([e.expectedNorm ?? ''], [p.producedNorm ?? '']);
    errors.push({
      kind: permuted ? 'wrong-order' : 'substitution',
      expectedPosition: position,
      expected: expectedWord,
      actual: producedWord,
      confusedWithVerseKey: null,
      segmentPosition: segmentFor(ctx.segments, position),
      explanation: permuted
        ? `Word order reversed here: “${producedWord ?? ''}” belongs elsewhere in the ayah.`
        : similarity >= NEAR_MISS_SIMILARITY
          ? `Near miss: “${producedWord ?? ''}” instead of “${expectedWord ?? ''}” (edit distance ${editDistance([e.expectedNorm ?? ''], [p.producedNorm ?? ''])}).`
          : `Substituted “${producedWord ?? ''}” for “${expectedWord ?? ''}”.`,
    });
  }
  for (let k = pairs; k < expectedOps.length; k += 1) {
    const e = expectedOps[k]!;
    const position = (e.expectedIndex ?? 0) + 1;
    errors.push({
      kind: 'omission',
      expectedPosition: position,
      expected: ctx.expectedRaw[e.expectedIndex ?? 0] ?? null,
      actual: null,
      confusedWithVerseKey: null,
      segmentPosition: segmentFor(ctx.segments, position),
      explanation: `“${ctx.expectedRaw[e.expectedIndex ?? 0] ?? ''}” was not recited.`,
    });
  }
  for (let k = pairs; k < producedOps.length; k += 1) {
    const p = producedOps[k]!;
    const norm = p.producedNorm ?? '';
    const producedWord = ctx.producedRaw[p.producedIndex ?? 0] ?? null;
    const neighbour = ctx.expectedNorm[Math.max(0, anchorPosition - 1)] ?? '';
    const appearsInAyah = ctx.expectedNorm.indexOf(norm);
    const isDuplicate = norm.length > 0 && (norm === neighbour || appearsInAyah >= 0);
    const position = Math.max(1, Math.min(anchorPosition + (k - pairs), ctx.expectedNorm.length));
    const kind: ErrorKind = isDuplicate
      ? appearsInAyah >= 0 && Math.abs(appearsInAyah - (anchorPosition - 1)) > 2
        ? 'wrong-order'
        : 'repetition'
      : 'substitution';
    errors.push({
      kind,
      expectedPosition: position,
      expected: kind === 'substitution' ? null : ctx.expectedRaw[appearsInAyah >= 0 ? appearsInAyah : position - 1] ?? null,
      actual: producedWord,
      confusedWithVerseKey: null,
      segmentPosition: segmentFor(ctx.segments, position),
      explanation:
        kind === 'repetition'
          ? `“${producedWord ?? ''}” was recited twice.`
          : kind === 'wrong-order'
            ? `“${producedWord ?? ''}” belongs at word ${appearsInAyah + 1}, not here.`
            : `“${producedWord ?? ''}” is not part of this ayah.`,
    });
  }
  return { errors, run: attributed };
}

/**
 * Classify a recitation.
 *
 * `accuracy` is correct words / expected words. An empty recitation scores 0,
 * an exact one scores 1, and a partially mismatched ayah can never be reported
 * as fully correct: any divergence produces at least one non-`correct` error.
 */
export function classifyRecitation(input: ClassifyInput): ClassificationResult {
  const full = normList(input.expected);
  const span = spanBounds(input.span, full.norm.length);
  // Everything below — the alignment, the error attribution, the positional
  // thirds — runs in the graded span's own frame. `base` is what turns those
  // positions back into ayah-absolute ones on the way out.
  const base = span.from - 1;
  const expected = { raw: full.raw.slice(base, span.to), norm: full.norm.slice(base, span.to) };
  const produced = normList(input.produced);
  const mode: RecallMode = input.mode ?? 'full-ayah';
  const alignment = alignWords(expected.norm, produced.norm);
  const segments = input.segments?.map((s) => ({ position: s.position, fromWord: s.fromWord - base, toWord: s.toWord - base }));

  const errors: DetectedError[] = [];
  const runs: ClassifiedRun[] = [];
  let correctWordCount = 0;
  for (const op of alignment) {
    if (op.kind === 'match') {
      correctWordCount += 1;
      const position = (op.expectedIndex ?? 0) + 1;
      errors.push({
        kind: 'correct',
        expectedPosition: position,
        expected: expected.raw[op.expectedIndex ?? 0] ?? null,
        actual: produced.raw[op.producedIndex ?? 0] ?? null,
        confusedWithVerseKey: null,
        segmentPosition: segmentFor(segments, position),
        explanation: 'Exact match after normalisation.',
      });
    }
  }

  for (const run of runsOf(alignment)) {
    const classified = classifyRun(run, {
      expectedRaw: expected.raw,
      producedRaw: produced.raw,
      expectedNorm: expected.norm,
      producedNorm: produced.norm,
      confusionCandidates: input.confusionCandidates ?? [],
      continuations: input.continuations ?? [],
      segments,
    });
    errors.push(...classified.errors);
    if (classified.run) runs.push(classified.run);
  }

  // Whole-recitation confusion fallback: the learner recited a similar ayah.
  if (runs.length === 0 && produced.norm.length > 0 && expected.norm.length > 0) {
    let best: { verseKey: string; score: number } | null = null;
    for (const candidate of input.confusionCandidates ?? []) {
      const words = candidate.words.map(normalizeWord).filter((w) => w.length > 0);
      const score = setSimilarity(produced.norm, words);
      if (score >= CONFUSION_SIMILARITY && (!best || score > best.score)) {
        best = { verseKey: candidate.verseKey, score };
      }
    }
    if (best) {
      const firstWrong = alignment.find((op) => op.kind !== 'match') ?? null;
      const position = firstWrong && firstWrong.expectedIndex !== null ? firstWrong.expectedIndex + 1 : 1;
      errors.push({
        kind: 'similar-ayah-confusion',
        expectedPosition: position,
        expected: expected.raw[position - 1] ?? null,
        actual: produced.raw[0] ?? null,
        confusedWithVerseKey: best.verseKey,
        segmentPosition: segmentFor(segments, position),
        explanation: `Recitation matches ${best.verseKey} (word-set similarity ${best.score.toFixed(2)}).`,
      });
      runs.push({
        kind: 'similar-ayah-confusion',
        fromWord: position,
        toWord: expected.norm.length,
        confusedWithVerseKey: best.verseKey,
      });
    }
  }

  errors.sort((a, b) => a.expectedPosition - b.expectedPosition || kindOrder(a.kind) - kindOrder(b.kind));

  const firstError = errors.find((e) => e.kind !== 'correct');
  const firstErrorPosition = firstError ? firstError.expectedPosition : null;

  const positionalDefault = POSITIONAL_FAILURE_MODES.includes(mode);
  if (input.positionalFailures ?? positionalDefault) {
    const positional = positionalFailureKind(firstErrorPosition, expected.norm.length);
    if (positional && expected.norm.length > 0) {
      errors.push({
        kind: positional,
        expectedPosition: firstErrorPosition ?? 1,
        expected: expected.raw[(firstErrorPosition ?? 1) - 1] ?? null,
        actual: null,
        confusedWithVerseKey: null,
        segmentPosition: segmentFor(segments, firstErrorPosition ?? 1),
        explanation: `First break-down falls in the ${positional.replace('-failure', '')} third of the ayah.`,
      });
      errors.sort((a, b) => a.expectedPosition - b.expectedPosition || kindOrder(a.kind) - kindOrder(b.kind));
    }
  }

  const expectedWordCount = expected.norm.length;
  // An extra (unpaired) produced word takes credit away from the position
  // where it surfaced: a recitation that stutters or adds words can never be
  // scored as fully correct. `accuracy` keeps the contract formula
  // correctWordCount / expectedWordCount, so `correctWordCount` is the
  // post-penalty count of expected words produced correctly *in place*.
  const unpairedProduced = alignment.filter((op) => op.kind === 'insertion').length;
  const scoredCorrectWordCount = Math.max(0, correctWordCount - unpairedProduced);
  const accuracy = expectedWordCount === 0 ? 0 : scoredCorrectWordCount / expectedWordCount;
  // Last step back into the ayah's own frame. A position a screen marks or a
  // later sum counts has to name the same word whether the step graded the whole
  // ayah or one segment of it, so the span-relative work above is offset here.
  const absolute = (position: number): number => position + base;
  return {
    itemId: input.itemId ?? null,
    verseKey: input.verseKey ?? null,
    mode,
    alignment: alignment.map((op) => ({
      ...op,
      expectedIndex: op.expectedIndex === null ? null : op.expectedIndex + base,
      expected: op.expectedIndex !== null ? expected.raw[op.expectedIndex] ?? null : null,
      produced: op.producedIndex !== null ? produced.raw[op.producedIndex] ?? null : null,
    })),
    runs: runs.map((run) => ({ ...run, fromWord: absolute(run.fromWord), toWord: absolute(run.toWord) })),
    errors: errors.map((error) => ({ ...error, expectedPosition: absolute(error.expectedPosition) })),
    expectedWordCount,
    correctWordCount: scoredCorrectWordCount,
    /** Expected words that matched exactly before the extra-word penalty. */
    matchedWordCount: correctWordCount,
    /** Produced words with no counterpart in the ayah. */
    unpairedProducedWordCount: unpairedProduced,
    accuracy,
    firstErrorPosition: firstErrorPosition === null ? null : absolute(firstErrorPosition),
  };
}

const KIND_ORDER: readonly ErrorKind[] = [
  'correct',
  'omission',
  'substitution',
  'repetition',
  'wrong-order',
  'wrong-transition',
  'similar-ayah-confusion',
  'beginning-failure',
  'middle-failure',
  'ending-failure',
];

function kindOrder(kind: ErrorKind): number {
  return KIND_ORDER.indexOf(kind);
}

/** Which third of the ayah the first error falls in. */
export function positionalFailureKind(
  firstErrorPosition: number | null,
  expectedWordCount: number,
): ErrorKind | null {
  if (firstErrorPosition === null || expectedWordCount <= 0) return null;
  const third = Math.ceil(expectedWordCount / 3);
  if (firstErrorPosition <= third) return 'beginning-failure';
  if (firstErrorPosition <= third * 2) return 'middle-failure';
  return 'ending-failure';
}

/** True only when every expected word was produced and nothing extra came out. */
export function isExactRecitation(result: ClassificationResult): boolean {
  return (
    result.expectedWordCount > 0 &&
    result.accuracy >= 1 &&
    result.alignment.every((op) => op.kind === 'match')
  );
}

/** Convenience: classify straight from ayah text plus produced word list. */
export function classifyRecitationFromText(input: {
  expectedText: string;
  produced: readonly string[];
  mode?: RecallMode;
  itemId?: string | null;
  verseKey?: string | null;
  confusionCandidates?: readonly CandidateAyah[];
  continuations?: readonly CandidateAyah[];
  segments?: readonly SegmentSpan[];
  positionalFailures?: boolean;
  span?: { fromWord: number; toWord: number } | null;
}): ClassificationResult {
  return classifyRecitation({
    expected: tokenizeWords(input.expectedText),
    produced: input.produced,
    mode: input.mode,
    itemId: input.itemId,
    verseKey: input.verseKey,
    confusionCandidates: input.confusionCandidates,
    continuations: input.continuations,
    segments: input.segments,
    positionalFailures: input.positionalFailures,
    span: input.span,
  });
}

/** Attempts count as a success at or above `SUCCESS_ACCURACY`. */
export function isSuccess(accuracy: number): boolean {
  return accuracy >= SUCCESS_ACCURACY;
}
