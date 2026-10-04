/**
 * Semantic segmentation of an ayah into 1..n memorisation chunks.
 *
 * Pure function, no clock, no randomness. The rule set is documented in
 * `docs/memory-fingerprint.md`; the tunables live in `params.ts`.
 *
 * Guarantees (asserted by core/tests/hifz/segment.test.ts):
 *  - segments tile the ayah exactly: contiguous, 1-based, no word covered
 *    twice, no word uncovered, first segment starts at word 1, last segment
 *    ends at the final word;
 *  - every boundary is explained (pause mark, connector, or forced split);
 *  - the same input always yields the same output;
 *  - a segment's `meaning` is either a text the caller read out of a licensed
 *    content pack (and says which pack, in which language) or `null`. This
 *    module never writes, "fixes" or machine-translates a gloss of revelation.
 */

import { normalizeWord, tokenizeWords } from '../normalize/arabic';
import type { AyahWord } from '../contracts/quran';
import type {
  AnchorWord,
  HifzSegment,
  HifzTransition,
  SegmentMeaning,
} from '../contracts/hifz';
import {
  ANCHOR_ID_TAG,
  BOUNDARY_SCORE_CONNECTOR,
  BOUNDARY_SCORE_FORCED,
  BOUNDARY_SCORE_PAUSE,
  FORCED_SPLIT_CANDIDATE_WINDOW,
  FRESH_MEMORY_STABILITY,
  MAX_SEGMENT_WORDS,
  MIN_PREFIX_REMAINDER_CHARS,
  MIN_SEGMENT_WORDS,
  PREFIX_CONNECTORS,
  SEGMENT_ID_TAG,
  STANDALONE_CONNECTORS,
  TRANSITION_ID_TAG,
  WORD_GLOSS_LANG,
  WORD_GLOSS_PACK_ID,
} from './params';

/** One clause boundary that the segmenter considered or chose. */
export interface BoundaryDecision {
  /** First word of the segment that would start here (1-based, always > 1). */
  wordPosition: number;
  /** Sum of the rule scores that fired at this position. */
  score: number;
  /** Human-readable rule ids, in the order they fired. */
  reasons: string[];
}

/** A word of the ayah with everything the engine needs about it. */
export interface HifzWord {
  /** 1-based position among word tokens (marks excluded). */
  position: number;
  /** Raw token exactly as it appears in the authoritative text. */
  raw: string;
  /** Authoritative word text (the AyahWord text when a list was supplied). */
  text: string;
  /** `normalizeWord(text)` — the comparison basis. */
  norm: string;
  translationEn: string | null;
  /** True when an ornamental pause/stop mark follows this word in the text. */
  pauseAfter: boolean;
}

/** Where the caller's per-chunk meanings came from, when they are word glosses. */
export interface MeaningSourceLabel {
  /** Content pack id the gloss rows belong to, e.g. `word-data`. */
  packId: string;
  /** Language the gloss rows are written in. */
  lang: 'fa' | 'ar' | 'en';
}

export interface SegmentAyahInput {
  itemId: string;
  verseKey: string;
  /** Authoritative ayah text (Uthmani). Never modified by this module. */
  text: string;
  /**
   * Optional word list from the content pack. When it agrees with the text it
   * supplies word text and translations; the text always decides positions.
   */
  words?: readonly AyahWord[] | null;
  /** Next ayah of the item's sequence; adds an inter-ayah transition. */
  nextVerseKey?: string | null;
  /**
   * Licensed meaning of each chunk, keyed by 0-based segment position, exactly as
   * the caller read it out of a content pack. A position with no entry leaves the
   * segment with `meaning: null` — this module never writes a gloss of revealed
   * text of its own (AGENTS.md: never invent content).
   */
  meanings?: Record<number, SegmentMeaning> | null;
  /**
   * When set, and the supplied word list carries a `translationEn` for every word
   * of a chunk, that chunk's meaning is the joined glosses of exactly its own
   * words (`wordGloss: true`) under this pack id and language. Pass `true` to take
   * the documented word-pack defaults (`WORD_GLOSS_PACK_ID` / `WORD_GLOSS_LANG`).
   * `meanings` wins for a position where both are supplied, so an explicit pack
   * clause is never overwritten by a stitched gloss.
   */
  wordGlossSource?: MeaningSourceLabel | boolean | null;
}

export interface SegmentationResult {
  itemId: string;
  verseKey: string;
  wordCount: number;
  words: HifzWord[];
  /** Chosen boundaries, in ascending word position. */
  boundaries: BoundaryDecision[];
  /** Every boundary the rules proposed, including the ones constraints removed. */
  proposedBoundaries: BoundaryDecision[];
  segments: HifzSegment[];
  anchors: AnchorWord[];
  transitions: HifzTransition[];
  /** Non-fatal notes, e.g. a supplied word list that disagrees with the text. */
  notes: string[];
}

/**
 * True when a raw whitespace token is a word rather than an ornament.
 *
 * Two conditions, both delegated to the normalisation module so the engine
 * never redefines "same word": the token must be the next token that
 * `tokenizeWords` keeps, and it must have a non-empty normalised form.
 */
function keepsToken(raw: string, canonical: readonly string[], cursor: number): boolean {
  return canonical[cursor] === raw && normalizeWord(raw).length > 0;
}

/** Split the ayah text into word slots and mark slots, in reading order. */
function partitionSlots(text: string): { words: HifzWord[]; notes: string[] } {
  const slots = text.split(/\s+/).filter((raw) => raw.length > 0);
  const canonical = tokenizeWords(text);
  const words: HifzWord[] = [];
  const notes: string[] = [];
  let cursor = 0;
  let marks = 0;
  for (const raw of slots) {
    if (keepsToken(raw, canonical, cursor)) {
      cursor += 1;
      words.push({
        position: words.length + 1,
        raw,
        text: raw,
        norm: normalizeWord(raw),
        translationEn: null,
        pauseAfter: false,
      });
    } else {
      marks += 1;
      if (words.length > 0) words[words.length - 1]!.pauseAfter = true;
    }
  }
  if (cursor !== canonical.length) {
    notes.push(
      `tokenizeWords kept ${canonical.length} tokens but ${cursor} matched the slot scan`,
    );
  }
  if (marks > 0) notes.push(`${marks} ornamental/pause token(s) excluded from word positions`);
  return { words, notes };
}

/**
 * Merge a supplied AyahWord list into the text-derived word slots.
 *
 * The text always decides positions and pauses; the list only enriches the
 * words with authoritative text and translations.
 */
function applyWordList(
  words: HifzWord[],
  provided: readonly AyahWord[] | null | undefined,
  notes: string[],
): HifzWord[] {
  if (!provided || provided.length === 0) return words;
  const usable = provided.filter(
    (w) => !w.isEndOfAyahMark && normalizeWord(w.textUthmani).length > 0,
  );
  if (usable.length !== words.length) {
    notes.push(
      `supplied word list has ${usable.length} words, text yields ${words.length}; text wins`,
    );
    return words;
  }
  return words.map((w, i) => {
    const p = usable[i]!;
    return {
      ...w,
      text: p.textUthmani,
      norm: normalizeWord(p.textUthmani),
      translationEn: p.translationEn ?? null,
    };
  });
}

/** Why a position is a candidate clause boundary, per the documented rules. */
function boundaryReasons(words: readonly HifzWord[], position: number): BoundaryDecision | null {
  const word = words[position - 1];
  const previous = words[position - 2];
  if (!word || !previous) return null;
  const reasons: string[] = [];
  let score = 0;
  if (previous.pauseAfter) {
    score += BOUNDARY_SCORE_PAUSE;
    reasons.push('pause-mark');
  }
  if (STANDALONE_CONNECTORS.includes(word.norm)) {
    score += BOUNDARY_SCORE_CONNECTOR;
    reasons.push(`connector:${word.norm}`);
  } else {
    for (const prefix of PREFIX_CONNECTORS) {
      if (
        word.norm.startsWith(prefix) &&
        word.norm.length - prefix.length >= MIN_PREFIX_REMAINDER_CHARS
      ) {
        score += BOUNDARY_SCORE_CONNECTOR;
        reasons.push(`prefix-connector:${prefix}`);
        break;
      }
    }
  }
  if (score === 0) return null;
  return { wordPosition: position, score, reasons };
}

/** Segment spans implied by a boundary set, over `1..wordCount`. */
function spansFromBoundaries(
  boundaries: readonly BoundaryDecision[],
  wordCount: number,
): { fromWord: number; toWord: number }[] {
  const spans: { fromWord: number; toWord: number }[] = [];
  let start = 1;
  for (const b of boundaries) {
    spans.push({ fromWord: start, toWord: b.wordPosition - 1 });
    start = b.wordPosition;
  }
  // Only close out a trailing span when there is an uncovered word left. An
  // ayah with no word tokens (`wordCount === 0`) has nothing to cover, so it
  // gets no segment — matching `assertTiling`, which requires zero segments for
  // a wordless ayah. Emitting `{fromWord: 1, toWord: 0}` here would create a
  // wordless chunk that surfaces downstream as a dead, unrecordable step.
  if (start <= wordCount) spans.push({ fromWord: start, toWord: wordCount });
  return spans;
}

function spanLength(span: { fromWord: number; toWord: number }): number {
  return span.toWord - span.fromWord + 1;
}

/**
 * Drop boundaries that would leave a segment shorter than MIN_SEGMENT_WORDS.
 * Deterministic: the weaker-scoring adjacent boundary goes, ties go to the
 * later boundary.
 */
function enforceMinimum(
  chosen: BoundaryDecision[],
  wordCount: number,
): { boundaries: BoundaryDecision[]; dropped: BoundaryDecision[] } {
  const dropped: BoundaryDecision[] = [];
  let boundaries = chosen.slice();
  for (;;) {
    const spans = spansFromBoundaries(boundaries, wordCount);
    const shortIndex = spans.findIndex((s) => spanLength(s) < MIN_SEGMENT_WORDS);
    if (shortIndex < 0) break;
    const before = boundaries[shortIndex - 1];
    const after = boundaries[shortIndex];
    if (!before && !after) break;
    let removeIndex: number;
    if (!before) removeIndex = shortIndex;
    else if (!after) removeIndex = shortIndex - 1;
    else if (after.score !== before.score) {
      removeIndex = after.score < before.score ? shortIndex : shortIndex - 1;
    } else removeIndex = shortIndex;
    const [removed] = boundaries.splice(removeIndex, 1);
    if (removed) dropped.push(removed);
  }
  return { boundaries, dropped };
}

/**
 * Add boundaries until no segment exceeds MAX_SEGMENT_WORDS. Prefers a real
 * rule-proposed boundary near the midpoint; falls back to a forced midpoint
 * split so long ayahs are never one un-chunkable block.
 */
function enforceMaximum(
  boundaries: BoundaryDecision[],
  candidates: readonly BoundaryDecision[],
  wordCount: number,
): BoundaryDecision[] {
  const unused = new Map<number, BoundaryDecision>();
  for (const c of candidates) {
    if (!boundaries.some((b) => b.wordPosition === c.wordPosition)) {
      unused.set(c.wordPosition, c);
    }
  }
  let result = boundaries.slice();
  for (let guard = 0; guard < wordCount + 2; guard += 1) {
    const spans = spansFromBoundaries(result, wordCount);
    const longIndex = spans.findIndex((s) => spanLength(s) > MAX_SEGMENT_WORDS);
    if (longIndex < 0) break;
    const span = spans[longIndex]!;
    const length = spanLength(span);
    const midpoint = span.fromWord + Math.floor(length / 2);
    const low = span.fromWord + MIN_SEGMENT_WORDS;
    const high = span.toWord - MIN_SEGMENT_WORDS + 1;
    if (low > high) break;
    let insert: BoundaryDecision | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const [position, candidate] of unused) {
      if (position < low || position > high) continue;
      const distance = Math.abs(position - midpoint);
      if (distance > FORCED_SPLIT_CANDIDATE_WINDOW) continue;
      if (
        candidate.score > (insert?.score ?? -1) ||
        (candidate.score === (insert?.score ?? -1) && distance < bestDistance)
      ) {
        insert = candidate;
        bestDistance = distance;
      }
    }
    if (insert) {
      unused.delete(insert.wordPosition);
      result = [...result, insert].sort((a, b) => a.wordPosition - b.wordPosition);
      continue;
    }
    const position = Math.min(Math.max(midpoint, low), high);
    if (result.some((b) => b.wordPosition === position)) break;
    result = [...result, { wordPosition: position, score: BOUNDARY_SCORE_FORCED, reasons: ['forced-midpoint'] }].sort(
      (a, b) => a.wordPosition - b.wordPosition,
    );
  }
  return result;
}

function anchorId(itemId: string, verseKey: string, wordPosition: number): string {
  return `${itemId}:${verseKey}:${ANCHOR_ID_TAG}${wordPosition}`;
}

function segmentId(itemId: string, verseKey: string, position: number): string {
  return `${itemId}:${verseKey}:${SEGMENT_ID_TAG}${position}`;
}

function transitionId(itemId: string, verseKey: string, key: string): string {
  return `${itemId}:${verseKey}:${TRANSITION_ID_TAG}${key}`;
}

/**
 * The verse key a fingerprint row's `id` already contains.
 *
 * Ids are `{itemId}:{verseKey}:{tag}{n}` and item ids (`hi-…`) carry no colon, so
 * the ayah is exactly the two digits between them. This is not a second source of
 * truth: it is how a v1 backup file or a v2 SQLite row, which have no verse_key
 * column, is read back without asking the user where the chunk came from.
 */
export function verseKeyFromFingerprintId(id: string): string | null {
  const match = /^[^:]+:(\d{1,3}:\d{1,4}):[a-z]/.exec(id);
  return match ? (match[1] as string) : null;
}

const VERSE_KEY_RE = /^\d{1,3}:\d{1,4}$/;

/**
 * Which ayah a segment / anchor / transition row numbers inside.
 *
 * The contract field is the answer. The fallback is what a file or a database
 * written before the column existed still always had: the row's own id spells
 * the ayah out. Two readers need exactly this reading — `backup/restore.ts`
 * filling the column, and `backup/validate.ts` deciding whether an absent field
 * is a legacy row or corruption — so it lives beside the id builders rather than
 * twice on either side.
 */
export function fingerprintVerseKey(row: { verseKey?: unknown; id?: unknown }): string | null {
  if (typeof row.verseKey === 'string' && VERSE_KEY_RE.test(row.verseKey)) return row.verseKey;
  return typeof row.id === 'string' ? verseKeyFromFingerprintId(row.id) : null;
}

/**
 * Join the per-word glosses the supplied word list carries for exactly this
 * chunk's positions, as a `wordGloss` meaning.
 *
 * Returns null when any covered word has no gloss: half a chunk's meaning would
 * misrepresent the revelation, so the whole chunk is left untested instead.
 */
export function segmentWordGloss(
  words: readonly HifzWord[],
  fromWord: number,
  toWord: number,
  source: MeaningSourceLabel,
): SegmentMeaning | null {
  const covered = words.slice(Math.max(0, fromWord - 1), toWord);
  if (covered.length === 0 || covered.length !== toWord - fromWord + 1) return null;
  const glosses = covered.map((w) => (w.translationEn ?? '').trim());
  if (glosses.some((g) => g.length === 0)) return null;
  return { text: glosses.join(' '), lang: source.lang, packId: source.packId, wordGloss: true };
}

/** The caller's meaning label, with `true` expanding to the documented word-pack defaults. */
function glossSourceOf(input: SegmentAyahInput): MeaningSourceLabel | null {
  if (input.wordGlossSource === true) {
    return { packId: WORD_GLOSS_PACK_ID, lang: WORD_GLOSS_LANG };
  }
  const source = input.wordGlossSource;
  return typeof source === 'object' && source !== null ? source : null;
}

/** Opening / middle / ending / boundary anchors for the segmented ayah. */
export function deriveAnchors(result: {
  itemId: string;
  verseKey: string;
  wordCount: number;
  words: readonly HifzWord[];
  boundaries: readonly BoundaryDecision[];
}): AnchorWord[] {
  const roleByPosition = new Map<number, AnchorWord['role']>();
  const put = (position: number, role: AnchorWord['role']): void => {
    if (position < 1 || position > result.wordCount) return;
    const existing = roleByPosition.get(position);
    // opening/ending/middle are more specific than a boundary role.
    if (existing && existing !== 'boundary') return;
    roleByPosition.set(position, existing ?? role);
  };
  put(1, 'opening');
  put(result.wordCount, 'ending');
  put(Math.ceil(result.wordCount / 2), 'middle');
  for (const b of result.boundaries) put(b.wordPosition, 'boundary');
  const out: AnchorWord[] = [];
  for (const position of [...roleByPosition.keys()].sort((a, b) => a - b)) {
    const word = result.words[position - 1];
    const role = roleByPosition.get(position);
    if (!word || !role) continue;
    out.push({
      id: anchorId(result.itemId, result.verseKey, position),
      itemId: result.itemId,
      verseKey: result.verseKey,
      wordPosition: position,
      text: word.text,
      role,
      stability: FRESH_MEMORY_STABILITY,
    });
  }
  return out;
}

/** Intra-ayah transitions at each boundary, plus the inter-ayah one if given. */
export function deriveTransitions(result: {
  itemId: string;
  verseKey: string;
  boundaries: readonly BoundaryDecision[];
  nextVerseKey?: string | null;
}): HifzTransition[] {
  const out: HifzTransition[] = [];
  for (const b of result.boundaries) {
    out.push({
      id: transitionId(result.itemId, result.verseKey, String(b.wordPosition)),
      itemId: result.itemId,
      verseKey: result.verseKey,
      kind: 'intra',
      toVerseKey: null,
      toWord: b.wordPosition,
      successCount: 0,
      failureCount: 0,
      stability: FRESH_MEMORY_STABILITY,
      lastPracticedAt: null,
    });
  }
  if (result.nextVerseKey) {
    out.push({
      id: transitionId(result.itemId, result.verseKey, `next-${result.nextVerseKey}`),
      itemId: result.itemId,
      verseKey: result.verseKey,
      kind: 'inter',
      toVerseKey: result.nextVerseKey,
      toWord: 1,
      successCount: 0,
      failureCount: 0,
      stability: FRESH_MEMORY_STABILITY,
      lastPracticedAt: null,
    });
  }
  return out;
}

/**
 * Segment one ayah. See `docs/memory-fingerprint.md` for the rule set.
 */
export function segmentAyah(input: SegmentAyahInput): SegmentationResult {
  const partition = partitionSlots(input.text);
  const words = applyWordList(partition.words, input.words, partition.notes);
  const wordCount = words.length;

  const proposals: BoundaryDecision[] = [];
  if (wordCount > 1) {
    for (let position = 2; position <= wordCount + 1; position += 1) {
      const decision = boundaryReasons(words, position);
      if (decision) proposals.push(decision);
    }
  }

  let chosen = proposals.slice();
  const dropped: BoundaryDecision[] = [];
  if (wordCount >= MIN_SEGMENT_WORDS * 2) {
    const minimum = enforceMinimum(chosen, wordCount);
    chosen = minimum.boundaries;
    dropped.push(...minimum.dropped);
    chosen = enforceMaximum(chosen, proposals, wordCount);
    const secondPass = enforceMinimum(chosen, wordCount);
    chosen = secondPass.boundaries;
    dropped.push(...secondPass.dropped);
  } else {
    chosen = [];
  }

  const spans = spansFromBoundaries(chosen, wordCount);
  const glossSource = glossSourceOf(input);
  const segments: HifzSegment[] = spans.map((span, position) => {
    const text = words
      .slice(span.fromWord - 1, span.toWord)
      .map((w) => w.text)
      .join(' ');
    const meaning =
      input.meanings?.[position] ??
      (glossSource ? segmentWordGloss(words, span.fromWord, span.toWord, glossSource) : null) ??
      null;
    return {
      id: segmentId(input.itemId, input.verseKey, position),
      itemId: input.itemId,
      verseKey: input.verseKey,
      position,
      fromWord: span.fromWord,
      toWord: span.toWord,
      text,
      meaning,
      stability: FRESH_MEMORY_STABILITY,
      meaningStability: null,
      errorCount: 0,
    };
  });

  if (segments.length > 0 && (glossSource || input.meanings)) {
    const untested = segments.filter((s) => s.meaning === null).length;
    if (untested > 0) {
      partition.notes.push(
        `${untested}/${segments.length} segment(s) have no licensed meaning; the meaning axis declines to test them`,
      );
    }
  }

  const base = { itemId: input.itemId, verseKey: input.verseKey, wordCount, words, boundaries: chosen };
  return {
    ...base,
    proposedBoundaries: chosen
      .concat(proposals.filter((p) => !chosen.some((c) => c.wordPosition === p.wordPosition)))
      .concat(dropped.filter((d) => !chosen.some((c) => c.wordPosition === d.wordPosition)))
      .sort((a, b) => a.wordPosition - b.wordPosition),
    segments,
    anchors: deriveAnchors(base),
    transitions: deriveTransitions({ ...base, nextVerseKey: input.nextVerseKey ?? null }),
    notes: partition.notes,
  };
}

/**
 * Tiling check used by the tests and reusable by the UI before rendering a
 * segmented ayah: contiguous, complete, in order, covering 1..wordCount.
 */
export function assertTiling(
  segments: readonly HifzSegment[],
  wordCount: number,
): { ok: true } | { ok: false; error: string } {
  if (wordCount === 0) {
    return segments.length === 0 ? { ok: true } : { ok: false, error: 'segments for an empty ayah' };
  }
  if (segments.length === 0) return { ok: false, error: 'no segments' };
  const sorted = segments.slice().sort((a, b) => a.position - b.position);
  if (sorted[0]!.fromWord !== 1) return { ok: false, error: `first segment starts at ${sorted[0]!.fromWord}` };
  if (sorted[sorted.length - 1]!.toWord !== wordCount) {
    return { ok: false, error: `last segment ends at ${sorted[sorted.length - 1]!.toWord}, expected ${wordCount}` };
  }
  for (let i = 0; i < sorted.length; i += 1) {
    const s = sorted[i]!;
    if (s.position !== i) return { ok: false, error: `segment positions not sequential at index ${i}` };
    if (s.toWord < s.fromWord) return { ok: false, error: `segment ${s.position} inverted range` };
    if (i > 0 && s.fromWord !== sorted[i - 1]!.toWord + 1) {
      return { ok: false, error: `gap or overlap between segments ${i - 1} and ${i}` };
    }
  }
  return { ok: true };
}

/** Which segment covers a 1-based word position, or null. */
export function segmentAt(
  segments: readonly HifzSegment[],
  wordPosition: number,
): HifzSegment | null {
  for (const s of segments) if (wordPosition >= s.fromWord && wordPosition <= s.toWord) return s;
  return null;
}

/** Words of an ayah, 1-based, as the engine sees them. Exposed for probes. */
export function hifzWordsOf(text: string, words?: readonly AyahWord[] | null): HifzWord[] {
  const partition = partitionSlots(text);
  return applyWordList(partition.words, words, partition.notes);
}
