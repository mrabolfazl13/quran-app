/**
 * Recall probes.
 *
 * Every probe returns a `cue` and the expected 1-based word range plus the
 * expected words themselves, so the UI can render the step without inventing
 * anything (AGENTS.md: no fake numbers, deterministic first).
 *
 * No clock reads, no unseeded randomness: the only stochastic probe
 * (`random`, and `missing-word` when no position is given) takes an explicit
 * integer-or-string seed and is therefore reproducible and Dart-portable.
 */

import type { AyahWord, VerseKey } from '../contracts/quran';
import type { HifzSegment, RecallMode, RecitedWord } from '../contracts/hifz';
import { normalizeWord, tokenizeWords } from '../normalize/arabic';
import { hifzWordsOf, type HifzWord } from './segment';
import {
  MISSING_WORD_PLACEHOLDER,
  POSITIONAL_THIRDS,
  RANDOM_PROBE_SPAN_WORDS,
  SEQUENCE_CUE_WORDS,
  SEQUENCE_EXPECTED_WORDS,
  TRANSITION_CUE_WORDS,
  TRANSITION_EXPECTED_WORDS,
} from './params';

/** The cue shown to the learner. Mirrors `RecallAttempt.cue`. */
export interface ProbeCue {
  kind: string;
  text: string | null;
}

export interface RecallProbe {
  mode: RecallMode;
  itemId: string | null;
  verseKey: VerseKey | null;
  cue: ProbeCue;
  /** 1-based, inclusive, against `verseKey`'s word list. */
  fromWord: number;
  toWord: number;
  /** Words the learner must produce, in the required order. */
  expected: RecitedWord[];
  /** Position blanked by a missing-word probe, else null. */
  hiddenWordPosition: number | null;
  /** UI instruction. Fixed wording, no content claims. */
  prompt: string;
  /** Set for probes that cross an ayah boundary. */
  nextVerseKey: VerseKey | null;
}

export interface ProbeAyah {
  itemId: string | null;
  verseKey: VerseKey;
  text: string;
  words?: readonly AyahWord[] | null;
}

function wordsOf(ayah: ProbeAyah): HifzWord[] {
  return hifzWordsOf(ayah.text, ayah.words ?? null);
}

function slice(words: readonly HifzWord[], from: number, to: number): HifzWord[] {
  const low = Math.max(1, Math.min(from, words.length));
  const high = Math.max(low, Math.min(to, words.length));
  return words.slice(low - 1, high);
}

function textOf(words: readonly HifzWord[]): string {
  return words.map((w) => w.text).join(' ');
}

/** Integer seed from any seed value; deterministic, no Math.random anywhere. */
export function seedToInt(seed: number | string): number {
  if (typeof seed === 'number') return Math.abs(Math.trunc(seed)) >>> 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 — small, portable to Dart line-for-line. */
export function seededRandom(seed: number | string): () => number {
  let a = seedToInt(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function baseProbe(
  ayah: ProbeAyah,
  mode: RecallMode,
  cue: ProbeCue,
  from: number,
  to: number,
  expected: readonly HifzWord[],
  prompt: string,
): RecallProbe {
  return {
    mode,
    itemId: ayah.itemId,
    verseKey: ayah.verseKey,
    cue,
    fromWord: from,
    toWord: to,
    expected: expected.map((w, index) => ({ position: index + 1, text: w.text })),
    hiddenWordPosition: null,
    prompt,
    nextVerseKey: null,
  };
}

/** Segment recall: produce one semantic chunk. */
export function segmentRecallProbe(ayah: ProbeAyah, segment: HifzSegment): RecallProbe {
  const words = wordsOf(ayah);
  const target = slice(words, segment.fromWord, segment.toWord);
  const previous = segment.fromWord > 1 ? slice(words, Math.max(1, segment.fromWord - TRANSITION_CUE_WORDS), segment.fromWord - 1) : [];
  return baseProbe(
    ayah,
    'segment',
    {
      kind: 'segment-previous-words',
      text: previous.length > 0 ? textOf(previous) : null,
    },
    segment.fromWord,
    segment.toWord,
    target,
    previous.length > 0
      ? 'Continue from the cue and recite this segment.'
      : 'Recite this segment from its beginning.',
  );
}

function thirdBounds(wordCount: number): { start: number; end: number; size: number } {
  const size = Math.ceil(wordCount / POSITIONAL_THIRDS);
  return { start: 1, end: Math.max(1, Math.min(size, wordCount)), size };
}

/** Opening third recall. */
export function openingRecallProbe(ayah: ProbeAyah): RecallProbe {
  const words = wordsOf(ayah);
  const { end } = thirdBounds(words.length);
  const target = slice(words, 1, end);
  return baseProbe(
    ayah,
    'opening',
    { kind: 'opening-prompt', text: null },
    1,
    end,
    target,
    'Recite the beginning of the ayah.',
  );
}

/** Middle third recall, cued by the words just before it. */
export function middleRecallProbe(ayah: ProbeAyah): RecallProbe {
  const words = wordsOf(ayah);
  const { size } = thirdBounds(words.length);
  const from = Math.min(size + 1, words.length);
  const to = Math.min(size * 2, words.length);
  const cueWords = from > 1 ? slice(words, Math.max(1, from - TRANSITION_CUE_WORDS), from - 1) : [];
  const target = slice(words, from, to);
  return baseProbe(
    ayah,
    'middle',
    { kind: 'middle-previous-words', text: cueWords.length > 0 ? textOf(cueWords) : null },
    from,
    to,
    target,
    'Recite the middle of the ayah.',
  );
}

/** Ending third recall. */
export function endingRecallProbe(ayah: ProbeAyah): RecallProbe {
  const words = wordsOf(ayah);
  const { size } = thirdBounds(words.length);
  const from = Math.min(size * 2 + 1, words.length);
  const target = slice(words, from, words.length);
  return baseProbe(
    ayah,
    'ending',
    { kind: 'ending-prompt', text: null },
    from,
    words.length,
    target,
    'Recite the end of the ayah.',
  );
}

export interface TransitionProbeInput {
  /** The ayah (or segment) the learner stops at. */
  from: ProbeAyah;
  /** The ayah (or continuation) the learner must produce. */
  to: ProbeAyah;
  kind: 'intra' | 'inter';
  /** Intra-ayah: the boundary word position inside `from` (1-based). */
  boundaryWord?: number;
  /** Intra-ayah: the segment position of the A side, for cue text. */
  fromSegmentPosition?: number;
  /** Intra-ayah: the word where the expected continuation starts. Defaults to `boundaryWord`. */
  toWord?: number;
}

/** A→B transition training, inside an ayah or across two ayahs. */
export function transitionProbe(input: TransitionProbeInput): RecallProbe {
  const fromWords = wordsOf(input.from);
  const toWords = wordsOf(input.to);
  const boundary = Math.max(2, Math.min(input.boundaryWord ?? fromWords.length, fromWords.length + 1));
  const cueWindow = input.kind === 'intra'
    ? slice(fromWords, Math.max(1, boundary - TRANSITION_CUE_WORDS), boundary - 1)
    : fromWords.slice(Math.max(0, fromWords.length - SEQUENCE_CUE_WORDS));
  const start = input.toWord ?? (input.kind === 'intra' ? boundary : 1);
  const end = Math.min(start + TRANSITION_EXPECTED_WORDS - 1, toWords.length);
  const target = slice(toWords, start, end);
  return {
    ...baseProbe(
      input.to,
      'transition',
      { kind: `transition-${input.kind}`, text: textOf(cueWindow) },
      start,
      end,
      target,
      input.kind === 'intra'
        ? 'Continue from the end of segment A into segment B.'
        : 'Continue from the end of this ayah into the next one.',
    ),
    nextVerseKey: input.kind === 'inter' ? input.to.verseKey : null,
  };
}

export interface MissingWordProbeInput {
  ayah: ProbeAyah;
  /** 1-based position to blank. Chained-seeded when omitted. */
  position?: number;
  seed?: number | string;
}

/** Blank one position; the expected answer is exactly that word. */
export function missingWordProbe(input: MissingWordProbeInput): RecallProbe {
  const words = wordsOf(input.ayah);
  const position = input.position ?? pickSeededPosition(words.length, input.seed ?? 'missing-word');
  const word = words[position - 1] ?? words[0];
  const cueText = textOf(words.map((w, index) => (index + 1 === position ? { ...w, text: MISSING_WORD_PLACEHOLDER } : w)));
  return {
    ...baseProbe(
      input.ayah,
      'missing-word',
      { kind: 'missing-word', text: cueText },
      position,
      position,
      word ? [word] : [],
      'Fill the blank with the missing word.',
    ),
    hiddenWordPosition: position,
  };
}

function pickSeededPosition(wordCount: number, seed: number | string): number {
  if (wordCount <= 0) return 1;
  const rng = seededRandom(seed);
  return 1 + Math.floor(rng() * wordCount);
}

/** First-word cue: the ayah is cued by its opening word. */
export function firstWordCueProbe(ayah: ProbeAyah): RecallProbe {
  const words = wordsOf(ayah);
  const first = words[0];
  const rest = slice(words, 2, words.length);
  return {
    ...baseProbe(
      ayah,
      'first-word-cue',
      { kind: 'first-word', text: first ? first.text : null },
      2,
      words.length,
      rest,
      first ? `Continue after “${first.text}”.` : 'Recite the ayah.',
    ),
  };
}

/** Last-word cue: name and recite the ayah that ends with this word. */
export function lastWordCueProbe(ayah: ProbeAyah): RecallProbe {
  const words = wordsOf(ayah);
  const last = words[words.length - 1];
  return baseProbe(
    ayah,
    'last-word-cue',
    { kind: 'last-word', text: last ? last.text : null },
    1,
    words.length,
    words,
    last ? `Recite the ayah that ends with “${last.text}”.` : 'Recite the ayah.',
  );
}

export interface ContinueAyahProbeInput {
  ayah: ProbeAyah;
  /** Number of leading words the learner already produced. */
  givenWords?: number;
  /** Or the exact prefix text; wins over `givenWords` when it matches. */
  prefixText?: string;
}

/** Continue-ayah: given a prefix, produce the rest. */
export function continueAyahProbe(input: ContinueAyahProbeInput): RecallProbe {
  const words = wordsOf(input.ayah);
  let given = Math.max(0, Math.min(input.givenWords ?? 0, words.length));
  if (input.prefixText) {
    // normalizeWord removes spaces inside a token, so multi-word text is
    // tokenised first — that is what `normalizedText` does, per word.
    const prefix = tokenizeWords(input.prefixText).map(normalizeWord);
    let matched = 0;
    for (let i = 0; i < prefix.length && i < words.length; i += 1) {
      if (words[i]!.norm !== prefix[i]) break;
      matched = i + 1;
    }
    if (matched > 0) given = matched;
  }
  const cueWords = slice(words, 1, Math.max(1, given));
  const target = slice(words, given + 1, words.length);
  return baseProbe(
    input.ayah,
    'continue-ayah',
    { kind: 'ayah-prefix', text: textOf(cueWords) },
    given + 1,
    words.length,
    target,
    'Continue the ayah from where it stops.',
  );
}

export interface ContinueSequenceProbeInput {
  previous: ProbeAyah;
  next: ProbeAyah;
}

/** Continue-sequence: ayah N's ending cues ayah N+1's opening. */
export function continueSequenceProbe(input: ContinueSequenceProbeInput): RecallProbe {
  const previous = wordsOf(input.previous);
  const next = wordsOf(input.next);
  const cueWords = previous.slice(Math.max(0, previous.length - SEQUENCE_CUE_WORDS));
  const target = slice(next, 1, Math.min(SEQUENCE_EXPECTED_WORDS, next.length));
  return {
    ...baseProbe(
      input.next,
      'continue-sequence',
      { kind: 'previous-ayah-ending', text: textOf(cueWords) },
      1,
      target.length,
      target,
      'Recite the opening of the next ayah.',
    ),
    nextVerseKey: input.next.verseKey,
  };
}

/** Reverse recall: the ayah's words, back to front. */
export function reverseRecallProbe(ayah: ProbeAyah): RecallProbe {
  const words = wordsOf(ayah);
  const reversed = words.slice().reverse();
  return {
    ...baseProbe(
      ayah,
      'reverse',
      { kind: 'reverse', text: words.length > 0 ? words[words.length - 1]!.text : null },
      1,
      words.length,
      reversed,
      'Recite the ayah word by word, ending first.',
    ),
  };
}

export interface RandomProbeInput {
  ayah: ProbeAyah;
  seed: number | string;
  /** Words to cover; clamped to the ayah length. */
  span?: number;
}

/** Random recall of a contiguous span, fully determined by `seed`. */
export function randomRecallProbe(input: RandomProbeInput): RecallProbe {
  const words = wordsOf(input.ayah);
  const span = Math.max(1, Math.min(input.span ?? RANDOM_PROBE_SPAN_WORDS, words.length));
  const startsAt = Math.max(1, words.length - span + 1);
  const rng = seededRandom(input.seed);
  const from = 1 + Math.floor(rng() * startsAt);
  const target = slice(words, from, from + span - 1);
  return baseProbe(
    input.ayah,
    'random',
    { kind: 'random-span-start-word', text: target.length > 0 ? target[0]!.text : null },
    from,
    Math.min(from + span - 1, words.length),
    target,
    'Recite this span of the ayah.',
  );
}

/** Audio-cued recall of the whole ayah (the audio pack id is the cue). */
export function audioRecallProbe(ayah: ProbeAyah, audioPackId: string): RecallProbe {
  const words = wordsOf(ayah);
  return baseProbe(
    ayah,
    'audio-recall',
    { kind: 'audio', text: audioPackId },
    1,
    words.length,
    words,
    'Listen once, then recite without the audio.',
  );
}

/** Free full-ayah recall. */
export function fullAyahProbe(ayah: ProbeAyah): RecallProbe {
  const words = wordsOf(ayah);
  return baseProbe(
    ayah,
    'full-ayah',
    { kind: 'free-recall', text: null },
    1,
    words.length,
    words,
    'Recite the whole ayah.',
  );
}

/**
 * Full-sequence recall. `fromWord`/`toWord` are positions in the concatenated
 * word list of the sequence, and `verseKey` is the first ayah.
 */
export function fullSequenceProbe(ayahs: readonly ProbeAyah[]): RecallProbe {
  if (ayahs.length === 0) throw new Error('fullSequenceProbe needs at least one ayah');
  const all: { text: string; wordPosition: number }[] = [];
  for (const ayah of ayahs) {
    for (const w of wordsOf(ayah)) all.push({ text: w.text, wordPosition: w.position });
  }
  const first = ayahs[0]!;
  return {
    mode: 'full-sequence',
    itemId: first.itemId,
    verseKey: first.verseKey,
    cue: {
      kind: 'sequence',
      text: ayahs.map((a) => a.verseKey).join(' → '),
    },
    fromWord: 1,
    toWord: all.length,
    expected: all.map((w, index) => ({ position: index + 1, text: w.text })),
    hiddenWordPosition: null,
    prompt: 'Recite the whole sequence without stopping.',
    nextVerseKey: ayahs.length > 1 ? ayahs[ayahs.length - 1]!.verseKey : null,
  };
}

/** Modes every probe builder can serve. */
export const PROBE_MODES: readonly RecallMode[] = [
  'segment',
  'opening',
  'middle',
  'ending',
  'transition',
  'continue-ayah',
  'continue-sequence',
  'missing-word',
  'first-word-cue',
  'last-word-cue',
  'reverse',
  'random',
  'audio-recall',
  'full-ayah',
  'full-sequence',
];

export interface ProbeContext {
  ayah: ProbeAyah;
  /** Required for `segment`. */
  segment?: HifzSegment;
  /** Required for `transition` / `continue-sequence` / `full-sequence`. */
  next?: ProbeAyah;
  ayahs?: readonly ProbeAyah[];
  boundaryWord?: number;
  transitionKind?: 'intra' | 'inter';
  toWord?: number;
  givenWords?: number;
  prefixText?: string;
  position?: number;
  seed?: number | string;
  span?: number;
  audioPackId?: string;
}

/** Single entry point the UI/scheduler uses so modes never drift apart. */
export function buildProbe(mode: RecallMode, ctx: ProbeContext): RecallProbe {
  switch (mode) {
    case 'segment': {
      if (!ctx.segment) throw new Error('segment probe needs a segment');
      return segmentRecallProbe(ctx.ayah, ctx.segment);
    }
    case 'opening':
      return openingRecallProbe(ctx.ayah);
    case 'middle':
      return middleRecallProbe(ctx.ayah);
    case 'ending':
      return endingRecallProbe(ctx.ayah);
    case 'transition': {
      if (!ctx.next) throw new Error('transition probe needs the following ayah');
      return transitionProbe({
        from: ctx.ayah,
        to: ctx.next,
        kind: ctx.transitionKind ?? 'inter',
        boundaryWord: ctx.boundaryWord,
        toWord: ctx.toWord,
      });
    }
    case 'continue-ayah':
      return continueAyahProbe({ ayah: ctx.ayah, givenWords: ctx.givenWords, prefixText: ctx.prefixText });
    case 'continue-sequence': {
      if (!ctx.next) throw new Error('continue-sequence probe needs the following ayah');
      return continueSequenceProbe({ previous: ctx.ayah, next: ctx.next });
    }
    case 'missing-word':
      return missingWordProbe({ ayah: ctx.ayah, position: ctx.position, seed: ctx.seed });
    case 'first-word-cue':
      return firstWordCueProbe(ctx.ayah);
    case 'last-word-cue':
      return lastWordCueProbe(ctx.ayah);
    case 'reverse':
      return reverseRecallProbe(ctx.ayah);
    case 'random':
      return randomRecallProbe({ ayah: ctx.ayah, seed: ctx.seed ?? 0, span: ctx.span });
    case 'audio-recall':
      return audioRecallProbe(ctx.ayah, ctx.audioPackId ?? `audio:${ctx.ayah.verseKey}`);
    case 'full-ayah':
      return fullAyahProbe(ctx.ayah);
    case 'full-sequence': {
      const ayahs = ctx.ayahs && ctx.ayahs.length > 0 ? ctx.ayahs : [ctx.ayah];
      return fullSequenceProbe(ayahs);
    }
    default: {
      const unknown = mode as string;
      throw new Error(`unsupported recall mode: ${unknown}`);
    }
  }
}
