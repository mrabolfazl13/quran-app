/**
 * No memorisation plan step may be wordless.
 *
 * WHY this test exists: on the shipped-path E2E session the runner rendered a
 * step whose expected-word chip was 0 and marked it non-recordable — a dead step
 * (`AGENTS.md`: no dead buttons, no fake numbers). A wordless step is either a
 * `hifz_segment` row that should never have been created, or a segment whose
 * words were dropped when it was built.
 *
 * The engine's own tiling checker, `assertTiling`, already states the contract:
 * an ayah with `wordCount === 0` must produce ZERO segments. `segmentAyah`
 * violates it — it unconditionally emits a phantom `{fromWord: 1, toWord: 0}`
 * span, which then flows into a wordless `segment` session step.
 *
 * Part 1 pins the healthy invariant over the real surah 112 ayat (the ayah texts
 * are the ones the content packs ship, and `words: null` mirrors
 * `hifzFacade.buildContext`, which always derives structure from text): every
 * step the engine builds either has no probe (the screen offers "skip") or a
 * probe with at least one expected word.
 *
 * Part 2 reproduces the defect with a degenerate enrolment whose text carries no
 * word token (a lone ornamental pause mark — a mushaf ornament, not invented
 * revelation). The segmenter must yield no segment and the probe builder must
 * give no cue, so the runner shows a skippable empty state, never a dead chip.
 */
import { describe, expect, it } from 'vitest';
import type { HifzItem, VerseKey } from '@quran/core';
import {
  assertTiling,
  segmentAyah,
  tokenizeWords,
} from '@quran/core';
import { createCoreHifzEngine } from '../../desktop/src/engine/coreHifzEngine';
import type { HifzContext } from '../../desktop/src/engine/hifzEngine';

/** The uthmani texts as `content/quran-core` ships them for surah 112. */
const IKHLAS: Record<VerseKey, string> = {
  '112:1': ' قُلْ هُوَ ٱللَّهُ أَحَدٌ',
  '112:2': 'ٱللَّهُ ٱلصَّمَدُ',
  '112:3': 'لَمْ يَلِدْ وَلَمْ يُولَدْ',
  '112:4': 'وَلَمْ يَكُن لَّهُۥ كُفُوًا أَحَدٌۢ',
};
const IKHLAS_KEYS = Object.keys(IKHLAS) as VerseKey[];

function freshItem(verseKey: VerseKey): HifzItem {
  return {
    id: `hi-${verseKey}`,
    verseKey,
    sequence: [verseKey],
    addedAt: '2026-09-29T00:00:00.000Z',
    status: 'active',
    band: 'new',
    stability: 0,
    // Enrolled, never probed: the form axis has a score of zero because nothing
    // was produced, the meaning axis has no value at all.
    formStability: 0,
    meaningStability: null,
    strength: 0,
    lastReviewedAt: null,
    nextReviewAt: null,
    attemptCount: 0,
    errorCount: 0,
  };
}

/** A context mirroring `hifzFacade.buildContext`: text decides structure, words are null. */
function ikhlasContext(): HifzContext {
  const ayahs = IKHLAS_KEYS.map((verseKey) => ({
    verseKey: verseKey as string,
    textUthmani: IKHLAS[verseKey],
    wordCount: tokenizeWords(IKHLAS[verseKey]).length,
    words: null as null,
  }));
  const wordCounts: Record<string, number> = {};
  for (const a of ayahs) wordCounts[a.verseKey] = a.wordCount;
  return {
    now: '2026-09-29T12:00:00.000Z',
    items: IKHLAS_KEYS.map(freshItem),
    segments: [],
    anchors: [],
    transitions: [],
    attempts: [],
    confusionGroups: [],
    ayahs,
    newAyahs: IKHLAS_KEYS.slice(),
    newAyahWordCounts: wordCounts,
    // No translation pack behind this context: the meaning phases must emit no
    // step at all, which is what the session looked like before the axis existed.
    meanings: {},
  };
}

describe('hifz plan never produces a wordless step', () => {
  it('every session step for a fresh surah 112 has at least one expected word', () => {
    const engine = createCoreHifzEngine();
    const ctx = ikhlasContext();
    const session = engine.startSession(ctx, 0);
    expect(session.steps.length).toBeGreaterThan(0);

    for (const [index, step] of session.steps.entries()) {
      const outcome = engine.probe(ctx, {
        mode: step.mode,
        verseKey: step.verseKey,
        itemId: step.itemId,
        seed: `${session.id}:${index}`,
      });
      // A step with no probe renders the runner's skip state (not a dead chip);
      // a step with a probe must ask for at least one word.
      if (outcome.probe !== null) {
        expect(
          outcome.probe.expected.length,
          `step ${index} (${step.mode} ${step.verseKey}) cued zero words`,
        ).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('every engine-derived segment covers at least one word', () => {
    const engine = createCoreHifzEngine();
    const ctx = ikhlasContext();
    for (const item of ctx.items) {
      const derived = engine.segmentItem(ctx, item.id);
      expect(derived, `no segmentation for ${item.verseKey}`).not.toBeNull();
      for (const segment of derived!.segments) {
        expect(segment.toWord - segment.fromWord + 1).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('an ayah with no word token produces no segment and no probe cue', () => {
    // A lone ornamental pause mark: real mushaf furniture, zero memorisable
    // words. The plan must not build a wordless chunk out of it.
    const text = 'ۚ';
    expect(tokenizeWords(text)).toHaveLength(0);

    const result = segmentAyah({ itemId: 'hi-empty', verseKey: '112:99', text });
    expect(result.wordCount).toBe(0);
    // The contract `assertTiling` already documents: a wordless ayah has no segments.
    expect(result.segments).toHaveLength(0);
    expect(assertTiling(result.segments, result.wordCount)).toEqual({ ok: true });

    // And the probe builder over such a segment-less item gives no cue, so the
    // runner cannot render a 0-word dead step.
    const engine = createCoreHifzEngine();
    const ctx: HifzContext = {
      ...ikhlasContext(),
      items: [freshItem('112:99' as VerseKey)],
      ayahs: [{ verseKey: '112:99', textUthmani: text, wordCount: 0, words: null }],
      newAyahs: ['112:99'],
      newAyahWordCounts: { '112:99': 0 },
    };
    const outcome = engine.probe(ctx, {
      mode: 'segment',
      verseKey: '112:99',
      itemId: 'hi-112:99',
      seed: 'repro:0',
    });
    if (outcome.probe !== null) {
      expect(outcome.probe.expected.length, 'a segment cue was built with zero words').toBeGreaterThanOrEqual(1);
    } else {
      expect(outcome.reason).toBe('item-has-no-segments');
    }
  });
});
