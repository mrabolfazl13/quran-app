/**
 * The fingerprint update rule: what one graded recitation does to the stored
 * chunk and hinge rows.
 *
 * `applyAttemptToSegment` scores a chunk; these two functions decide *which* rows
 * an attempt is allowed to score at all. That decision is the reason the
 * fingerprint can say "the third clause of 55:13 is what you lose" instead of
 * "the item is at 0.6": a row moves only on evidence that asked for it. Every
 * case below is that boundary case — a chunk the span does not cover, a hinge the
 * attempt did not begin at, an error attributed to a different chunk.
 *
 * Arithmetic is `AXIS_LEARN_RATE` (0.3) applied as an exponential step toward the
 * attempt's accuracy, or toward 1/0 for a hinge that held or missed. The numbers
 * are asserted, not described, so a future change of rate is a decision someone
 * had to make here.
 */

import { describe, expect, it } from 'vitest';
import type { AnchorWord, HifzSegment, HifzTransition } from '../../src/contracts/hifz';
import {
  applyAttemptToStoredSegments,
  applyAttemptToStoredTransitions,
  type FingerprintAttemptView,
} from '../../src/hifz/stability';
import { AXIS_LEARN_RATE, FRESH_MEMORY_STABILITY } from '../../src/hifz/params';

const ITEM = 'item-112';
const AT = '2026-01-01T00:00:00.000Z';

/** Two chunks of 112:1 (1–3, 4–5) and one chunk of the next ayah. */
function segments(): HifzSegment[] {
  const row = (over: Partial<HifzSegment> & Pick<HifzSegment, 'position' | 'verseKey' | 'fromWord' | 'toWord'>): HifzSegment => ({
    id: `${ITEM}:${over.verseKey}:s${over.position}`,
    itemId: ITEM,
    text: 'نَصّ',
    meaning: null,
    stability: 0.5,
    meaningStability: null,
    errorCount: 0,
    ...over,
  });
  return [
    row({ position: 0, verseKey: '112:1', fromWord: 1, toWord: 3 }),
    row({ position: 1, verseKey: '112:1', fromWord: 4, toWord: 5 }),
    row({ position: 0, verseKey: '112:2', fromWord: 1, toWord: 4 }),
  ];
}

function attempt(over: Partial<FingerprintAttemptView> = {}): FingerprintAttemptView {
  return {
    itemId: ITEM,
    verseKey: '112:1',
    mode: 'full-ayah',
    accuracy: 1,
    span: null,
    errors: [],
    at: AT,
    ...over,
  };
}

/** One intra hinge at word 4 of 112:1 and one inter hinge into 112:2. */
function transitions(): HifzTransition[] {
  const row = (over: Partial<HifzTransition> & Pick<HifzTransition, 'kind' | 'verseKey' | 'toWord'>): HifzTransition => ({
    id: `${ITEM}:${over.verseKey}:t${over.kind === 'inter' ? `next-${over.toVerseKey}` : over.toWord}`,
    itemId: ITEM,
    toVerseKey: null,
    successCount: 0,
    failureCount: 0,
    stability: FRESH_MEMORY_STABILITY,
    lastPracticedAt: null,
    ...over,
  });
  return [
    row({ kind: 'intra', verseKey: '112:1', toWord: 4 }),
    row({ kind: 'inter', verseKey: '112:1', toVerseKey: '112:2', toWord: 1 }),
  ];
}

describe('applyAttemptToStoredSegments: which chunk an attempt is allowed to score', () => {
  it('grades every chunk of the recited ayah when the whole ayah was recited', () => {
    const out = applyAttemptToStoredSegments(segments(), attempt({ accuracy: 1 }));
    // 0.5 + 0.3 · (1 − 0.5)
    expect(out[0]!.stability).toBeCloseTo(0.65, 10);
    expect(out[1]!.stability).toBeCloseTo(0.65, 10);
    // The other ayah's chunk belongs to a recitation that never happened.
    expect(out[2]!.stability).toBe(0.5);
  });

  it('grades only the chunks the cued span covers entirely', () => {
    // The step asked for words 4–5. Chunk 1–3 was not recited and must keep its
    // number, which is the whole point of storing one per chunk.
    const out = applyAttemptToStoredSegments(
      segments(),
      attempt({ mode: 'segment', span: { fromWord: 4, toWord: 5 }, accuracy: 1 }),
    );
    expect(out[0]!.stability).toBe(0.5);
    expect(out[1]!.stability).toBeCloseTo(0.65, 10);

    // A span that only clips the edge of a chunk grades none of it: 2–4 crosses
    // chunk 1–3 without covering it and without covering 4–5.
    const clipped = applyAttemptToStoredSegments(
      segments(),
      attempt({ mode: 'segment', span: { fromWord: 2, toWord: 4 }, accuracy: 1 }),
    );
    expect(clipped.map((s) => s.stability)).toEqual([0.5, 0.5, 0.5]);
  });

  it('moves only the axis the attempt was cued on', () => {
    const form = applyAttemptToStoredSegments(segments(), attempt({ mode: 'segment', span: { fromWord: 1, toWord: 3 } }));
    expect(form[0]!.stability).toBeCloseTo(0.65, 10);
    expect(form[0]!.meaningStability).toBeNull();

    // The meaning axis starts from SEGMENT_MEANING_BASE (0), not from the form
    // number it sits beside: a flawless recitation is not a shred of understanding.
    const meaning = applyAttemptToStoredSegments(
      segments(),
      attempt({ mode: 'concept-cue', accuracy: 1, at: AT }),
    );
    expect(meaning[0]!.meaningStability).toBeCloseTo(AXIS_LEARN_RATE, 10);
    expect(meaning[0]!.stability).toBe(0.5);
  });

  it('counts an error against the chunk the classifier named, not the whole ayah', () => {
    const rows = segments();
    const out = applyAttemptToStoredSegments(
      rows,
      attempt({
        accuracy: 0.4,
        errors: [
          { kind: 'substitution', expectedPosition: 4, segmentPosition: 1 },
          { kind: 'omission', expectedPosition: 5, segmentPosition: 1 },
          { kind: 'wrong-order', expectedPosition: 2, segmentPosition: 0 },
        ],
      }),
    );
    expect(out[0]!.errorCount).toBe(1);
    expect(out[1]!.errorCount).toBe(2);
    // An error in this ayah does not visit the next one.
    expect(out[2]!.errorCount).toBe(0);
    // Both chunks moved on the form axis, toward the attempt's own accuracy.
    expect(out[0]!.stability).toBeCloseTo(0.5 + AXIS_LEARN_RATE * (0.4 - 0.5), 10);
  });

  it('leaves an untouched row as the same object, so the caller can tell what changed', () => {
    const rows = segments();
    const out = applyAttemptToStoredSegments(rows, attempt({ span: { fromWord: 1, toWord: 3 }, accuracy: 1 }));
    expect(out[1]).toBe(rows[1]);
    expect(out[2]).toBe(rows[2]);
    expect(out[0]).not.toBe(rows[0]);
  });

  it('is deterministic: the same attempt twice gives the same first result', () => {
    const one = applyAttemptToStoredSegments(segments(), attempt({ accuracy: 0.7 }));
    const two = applyAttemptToStoredSegments(segments(), attempt({ accuracy: 0.7 }));
    expect(one).toEqual(two);
    // And applying it twice in a row keeps moving toward the accuracy without
    // ever overshooting it or leaving 0..1 — the row is a mean of recitations,
    // not a counter.
    const thrice = applyAttemptToStoredSegments(one, attempt({ accuracy: 0.7 }));
    expect(one[0]!.stability).toBeGreaterThan(0.5);
    expect(thrice[0]!.stability).toBeGreaterThan(one[0]!.stability);
    expect(thrice[0]!.stability).toBeLessThan(0.7);
    expect(thrice[0]!.stability).toBeGreaterThanOrEqual(0);
  });

  it('scores a chunk of one ayah without disturbing the same position in another', () => {
    // The address v3 exists for: position 0 is a row of 112:1 *and* of 112:2.
    const out = applyAttemptToStoredSegments(segments(), attempt({ accuracy: 1 }));
    expect(out[0]!.position).toBe(out[2]!.position);
    expect(out[0]!.stability).toBeCloseTo(0.65, 10);
    expect(out[2]!.stability).toBe(0.5);
  });

  it('leaves a dropped track on the same ayah alone', () => {
    // A dropped item keeps its chunk rows while a fresh item for the same verse
    // starts a new track, so `(item, verse, position)` — the UNIQUE key — is what
    // says whose memory this recitation is evidence for. Grading on the ayah
    // alone would move the old track's numbers from the new one.
    const rows = [
      ...segments(),
      { ...segments()[0]!, id: 'item-old:112:1:s0', itemId: 'item-old', stability: 0.2 },
    ];
    const out = applyAttemptToStoredSegments(rows, attempt({ accuracy: 1 }));
    expect(out[0]!.stability).toBeCloseTo(0.65, 10);
    expect(out[3]!.stability).toBe(0.2);
  });
});

describe('applyAttemptToStoredTransitions: which hinge an attempt is allowed to grade', () => {
  it('grades an intra hinge only when the recitation began at its word', () => {
    const rows = transitions();
    const hit = applyAttemptToStoredTransitions(rows, attempt({ mode: 'transition', span: { fromWord: 4, toWord: 5 } }));
    expect(hit[0]!.stability).toBeCloseTo(AXIS_LEARN_RATE, 10);
    expect(hit[0]!.successCount).toBe(1);
    // The inter hinge is about the seam into 112:2; this attempt never crossed it,
    // and comes back as the very same object so the caller can see it did not move.
    expect(hit[1]).toBe(rows[1]);
    expect(hit[1]!.stability).toBe(FRESH_MEMORY_STABILITY);
    expect(hit[1]!.successCount).toBe(0);

    // A whole-ayah recitation passes over word 4 but was not asked to *arrive*
    // there, so it is not evidence about the hinge.
    const free = applyAttemptToStoredTransitions(transitions(), attempt({ accuracy: 1 }));
    expect(free[0]!.stability).toBe(FRESH_MEMORY_STABILITY);
    expect(free[0]!.failureCount).toBe(0);
  });

  it('holds when nothing went wrong at the word the hinge arrives at', () => {
    const missed = applyAttemptToStoredTransitions(
      transitions(),
      attempt({
        mode: 'transition',
        span: { fromWord: 4, toWord: 5 },
        errors: [{ kind: 'substitution', expectedPosition: 4, segmentPosition: 1 }],
      }),
    );
    expect(missed[0]!.failureCount).toBe(1);
    expect(missed[0]!.successCount).toBe(0);
    // Toward 0 from 0: it cannot fall below the floor.
    expect(missed[0]!.stability).toBe(0);

    // An error two words later is a real error and not this hinge's fault.
    const elsewhere = applyAttemptToStoredTransitions(
      transitions(),
      attempt({ mode: 'transition', span: { fromWord: 4, toWord: 6 }, errors: [{ kind: 'omission', expectedPosition: 6, segmentPosition: 1 }] }),
    );
    expect(elsewhere[0]!.successCount).toBe(1);
    expect(elsewhere[0]!.failureCount).toBe(0);
  });

  it('treats a wrong-transition anywhere in the step as the hinge giving way', () => {
    const out = applyAttemptToStoredTransitions(
      transitions(),
      attempt({
        mode: 'transition',
        span: { fromWord: 4, toWord: 5 },
        errors: [{ kind: 'wrong-transition', expectedPosition: 9, segmentPosition: null }],
      }),
    );
    expect(out[0]!.failureCount).toBe(1);
    expect(out[0]!.stability).toBe(0);
  });

  it('grades an inter hinge from the ayah entered, not the one left', () => {
    const left = applyAttemptToStoredTransitions(transitions(), attempt({ verseKey: '112:1', mode: 'transition', span: { fromWord: 1, toWord: 3 } }));
    expect(left[1]!.stability).toBe(FRESH_MEMORY_STABILITY);
    expect(left[1]!.successCount).toBe(0);

    const entered = applyAttemptToStoredTransitions(
      transitions(),
      attempt({ verseKey: '112:2', mode: 'continue-sequence', span: { fromWord: 1, toWord: 3 } }),
    );
    expect(entered[1]!.successCount).toBe(1);
    expect(entered[1]!.stability).toBeCloseTo(AXIS_LEARN_RATE, 10);
    // Starting mid-ayah is not continuing from the previous one.
    const late = applyAttemptToStoredTransitions(
      transitions(),
      attempt({ verseKey: '112:2', mode: 'continue-sequence', span: { fromWord: 2, toWord: 4 } }),
    );
    expect(late[1]!.successCount).toBe(0);
    expect(late[1]!.failureCount).toBe(0);
  });

  it('grades a hinge of this track only, not a second item on the same ayah', () => {
    const rows = [...transitions(), { ...transitions()[0]!, id: 'item-old:112:1:t4', itemId: 'item-old', stability: 0.9 }];
    const out = applyAttemptToStoredTransitions(rows, attempt({ mode: 'transition', span: { fromWord: 4, toWord: 5 } }));
    expect(out[0]!.successCount).toBe(1);
    expect(out[2]!.successCount).toBe(0);
    expect(out[2]!.stability).toBe(0.9);
  });

  it('leaves the form-only hinge number alone when the cue was a meaning', () => {
    const rows = transitions();
    const out = applyAttemptToStoredTransitions(
      rows,
      attempt({ mode: 'meaning-to-arabic', span: { fromWord: 4, toWord: 5 } }),
    );
    // A meaning drill moves the meaning axis of the chunks it covered; a hinge has
    // no meaning axis, so it comes back untouched rather than "practised".
    expect(out[0]).toBe(rows[0]);
    expect(out[0]!.stability).toBe(FRESH_MEMORY_STABILITY);
    expect(out[0]!.successCount).toBe(0);
    expect(out[0]!.lastPracticedAt).toBeNull();
  });

  it('records when the hinge was last practised and keeps the counters honest over a history', () => {
    let rows = transitions();
    rows = applyAttemptToStoredTransitions(rows, attempt({ mode: 'transition', span: { fromWord: 4, toWord: 5 }, at: '2026-01-02T00:00:00.000Z' }));
    rows = applyAttemptToStoredTransitions(
      rows,
      attempt({
        mode: 'transition',
        span: { fromWord: 4, toWord: 5 },
        errors: [{ kind: 'omission', expectedPosition: 4, segmentPosition: 1 }],
        at: '2026-01-03T00:00:00.000Z',
      }),
    );
    expect(rows[0]!.successCount).toBe(1);
    expect(rows[0]!.failureCount).toBe(1);
    expect(rows[0]!.lastPracticedAt).toBe('2026-01-03T00:00:00.000Z');
    // 0 → 0.3 (held), then toward 0: 0.3 − 0.3·0.3
    expect(rows[0]!.stability).toBeCloseTo(0.3 - AXIS_LEARN_RATE * 0.3, 10);
  });
});

describe('the fingerprint is not the anchor list', () => {
  it('leaves anchor rows out of the update, because nothing reads their stability', () => {
    // Guard by shape: these functions take segments and transitions only. If an
    // anchor writer is ever added, `anchor_word.stability` needs a consumer in
    // core/src/hifz first — see docs/memory-fingerprint.md.
    const anchor: AnchorWord = {
      id: `${ITEM}:112:1:a4`,
      itemId: ITEM,
      verseKey: '112:1',
      wordPosition: 4,
      text: 'كَلِمَة',
      role: 'boundary',
      stability: FRESH_MEMORY_STABILITY,
    };
    expect(anchor.stability).toBe(FRESH_MEMORY_STABILITY);
    expect(typeof applyAttemptToStoredSegments).toBe('function');
    expect(typeof applyAttemptToStoredTransitions).toBe('function');
  });
});
