/**
 * The conceptual axis must be reachable from the app, not only implemented in core.
 *
 * WHY this test exists at all: core grew the second axis (form vs meaning —
 * docs/hifz-method.md, docs/review-algorithm.md) and every core unit test passed,
 * while a real session on the desktop still contained no meaning step at all and a
 * meaning probe died with `meaning probe needs a licensed meaning`. The defect was
 * above core: the facade built its context with `words: null` and no meaning
 * coverage, and the adapter never handed `meanings` to the planner, the session
 * builder or the probe builder. Core was simply never told which verses a licensed
 * meaning covers, and it correctly refused to invent one.
 *
 * So this file pins the seam, over the same texts surah 112 ships:
 *   1. a context with coverage produces meaning steps, and every meaning cue is
 *      the licensed text with the pack and language that make it attributable;
 *   2. the answer a meaning step asks for is still revelation — Arabic words,
 *      never the gloss;
 *   3. a context without coverage produces no meaning step (dark, not fabricated);
 *   4. with no ayah-level clause the cue falls back to the chunk's own word gloss
 *      and the graded span shrinks to exactly the words that gloss covers;
 *   5. a concept cue is only ever built from a previous ayah this install has.
 */
import { describe, expect, it } from 'vitest';
import {
  RECALL_DIMENSION,
  tokenizeWords,
  type AyahWord,
  type HifzItem,
  type SegmentMeaning,
  type VerseKey,
} from '@quran/core';
import { createCoreHifzEngine } from '../../desktop/src/engine/coreHifzEngine';
import type { HifzContext } from '../../desktop/src/engine/hifzEngine';

const IKHLAS: Record<VerseKey, string> = {
  '112:1': 'قُلْ هُوَ ٱللَّهُ أَحَدٌ',
  '112:2': 'ٱللَّهُ ٱلصَّمَدُ',
  '112:3': 'لَمْ يَلِدْ وَلَمْ يُولَدْ',
  '112:4': 'وَلَمْ يَكُن لَّهُۥ كُفُوًا أَحَدٌۢ',
};
const KEYS = Object.keys(IKHLAS) as VerseKey[];

/** The licensed Persian clause the pack carries for each ayah — the cue's text. */
const FA: Record<VerseKey, string> = {
  '112:1': 'بگو: او خدا یکتاست',
  '112:2': 'خدایی که همه به او نیازمندند',
  '112:3': 'نه زاده است و نه زاده شده',
  '112:4': 'و هیچ کس همتای او نیست',
};
const FA_PACK = 'tr-fa-test';

/** Word rows as the `word-data` pack ships them: every token with an English gloss. */
function wordRows(verseKey: VerseKey): AyahWord[] {
  return tokenizeWords(IKHLAS[verseKey]).map((text, index) => ({
    id: index + 1,
    verseKey,
    position: index + 1,
    pageNumber: 604,
    lineNumber: index + 1,
    textUthmani: text,
    translationEn: `gloss-${verseKey}-${index + 1}`,
    transliteration: null,
    root: null,
    morphology: null,
    isEndOfAyahMark: false,
  }));
}

function freshItem(verseKey: VerseKey): HifzItem {
  return {
    id: `hi-${verseKey}`,
    verseKey,
    sequence: [verseKey],
    addedAt: '2026-09-29T00:00:00.000Z',
    status: 'active',
    band: 'new',
    stability: 0,
    formStability: 0,
    meaningStability: null,
    strength: 0,
    lastReviewedAt: null,
    nextReviewAt: null,
    attemptCount: 0,
    errorCount: 0,
  };
}

/**
 * Mirrors `hifzFacade.buildContext` for surah 112.
 *
 * `withMeaning` is the coverage map the meaning loader would produce from the
 * selected translation pack; `glossedAyahs` is whether word rows were loaded.
 */
function context(options: { meanings?: boolean; words?: boolean } = {}): HifzContext {
  const withMeaning = options.meanings ?? true;
  const withWords = options.words ?? true;
  const meanings: Record<string, SegmentMeaning | null> = {};
  if (withMeaning) {
    for (const key of KEYS) {
      meanings[key] = { text: FA[key], lang: 'fa', packId: FA_PACK, wordGloss: false };
    }
  }
  return {
    now: '2026-09-29T12:00:00.000Z',
    items: KEYS.map(freshItem),
    segments: [],
    anchors: [],
    transitions: [],
    attempts: [],
    confusionGroups: [],
    ayahs: KEYS.map((verseKey) => ({
      verseKey: verseKey as string,
      textUthmani: IKHLAS[verseKey],
      wordCount: tokenizeWords(IKHLAS[verseKey]).length,
      words: withWords ? wordRows(verseKey) : null,
    })),
    newAyahs: KEYS.slice(),
    newAyahWordCounts: Object.fromEntries(KEYS.map((k) => [k, tokenizeWords(IKHLAS[k]).length])),
    meanings,
  };
}

const engine = createCoreHifzEngine();

describe('the meaning axis is reachable through the desktop engine boundary', () => {
  it('a licensed meaning turns the session conceptual: meaning steps are emitted', () => {
    const ctx = context();
    const session = engine.startSession(ctx, 0);
    const meaningSteps = session.steps.filter((s) => RECALL_DIMENSION[s.mode] === 'meaning');

    expect(meaningSteps.length, 'no meaning step in a session over fully covered ayahs').toBeGreaterThan(0);
    // Every meaning step must be able to show a cue — a step the runner cannot
    // cue is a dead chip on the screen.
    for (const [index, step] of meaningSteps.entries()) {
      const outcome = engine.probe(ctx, {
        mode: step.mode,
        verseKey: step.verseKey,
        itemId: step.itemId,
        seed: `${session.id}:${index}`,
      });
      expect(outcome.probe, `meaning step died: ${outcome.reason}`).not.toBeNull();
    }
  });

  it('the cue is the licensed clause, attributed; the answer is Arabic revelation', () => {
    const ctx = context();
    const session = engine.startSession(ctx, 0);
    const step = session.steps.find((s) => s.mode === 'meaning-to-arabic');
    expect(step, 'expected a meaning→Arabic step for a new, covered ayah').toBeDefined();

    const outcome = engine.probe(ctx, {
      mode: 'meaning-to-arabic',
      verseKey: step!.verseKey,
      itemId: step!.itemId,
      seed: `${session.id}:direct`,
    });
    const probe = outcome.probe;
    expect(probe, outcome.reason ?? 'probe refused').not.toBeNull();
    if (!probe) return;

    expect(probe.cue.text).toBe(FA[step!.verseKey as VerseKey]);
    expect(probe.cue.lang).toBe('fa');
    expect(probe.cue.packId).toBe(FA_PACK);
    // The expected words are the ayah's own Arabic, in order — the gloss is a
    // cue, never an answer the learner is allowed to give.
    const arabic = tokenizeWords(IKHLAS[step!.verseKey as VerseKey]);
    expect(probe.expected.map((w) => w.text)).toEqual(arabic);
    expect(probe.mode).toBe('meaning-to-arabic');
  });

  it('without coverage the meaning axis stays dark instead of inventing a cue', () => {
    // An install with neither a translation pack nor a word pack: nothing here
    // can attribute a meaning, so the conceptual axis contributes nothing at all.
    const ctx = context({ meanings: false, words: false });
    const session = engine.startSession(ctx, 0);
    expect(session.steps.filter((s) => RECALL_DIMENSION[s.mode] === 'meaning')).toEqual([]);

    const outcome = engine.probe(ctx, {
      mode: 'meaning-to-arabic',
      verseKey: '112:1',
      itemId: 'hi-112:1',
      seed: 'dark',
    });
    expect(outcome.probe).toBeNull();
    // Word glosses are also absent here, so there is nothing attributable at all.
    expect(outcome.reason).toBe('no-licensed-meaning-for-ayah');
  });

  it('a chunk cue falls back to the word gloss and grades only the words it covers', () => {
    const ctx = context();
    // Drop the ayah-level clause for 112:2: the segment's own licensed gloss is
    // all the app has, so the span must shrink to that chunk's words.
    ctx.meanings['112:2'] = null;
    const outcome = engine.probe(ctx, {
      mode: 'meaning-to-arabic',
      verseKey: '112:2',
      itemId: 'hi-112:2',
      seed: 'gloss',
    });
    const probe = outcome.probe;
    expect(probe, outcome.reason ?? 'gloss cue refused').not.toBeNull();
    if (!probe) return;

    expect(probe.cue.lang).toBe('en');
    expect(probe.cue.packId).toBe('word-data');
    expect(probe.cue.text).toMatch(/^gloss-112:2-/);
    const arabic = tokenizeWords(IKHLAS['112:2']);
    const span = arabic.slice(probe.fromWord - 1, probe.toWord);
    expect(probe.expected.map((w) => w.text)).toEqual(span);
    expect(span.length).toBeLessThanOrEqual(arabic.length);
  });

  it('a concept cue is built only from a previous ayah this install can attribute', () => {
    const ctx = context();
    const outcome = engine.probe(ctx, {
      mode: 'concept-cue',
      verseKey: '112:2',
      itemId: 'hi-112:2',
      seed: 'chain',
    });
    const probe = outcome.probe;
    expect(probe, outcome.reason ?? 'chain refused').not.toBeNull();
    if (!probe) return;
    expect(probe.cue.text).toBe(FA['112:1']);
    expect(probe.cue.packId).toBe(FA_PACK);
    expect(probe.cueVerseKey).toBe('112:1');

    // 112:1 has no predecessor inside the surah the learner holds, so the chain
    // step refuses rather than cueing with a meaning nobody imported.
    ctx.meanings['112:1'] = null;
    const refused = engine.probe(ctx, {
      mode: 'concept-cue',
      verseKey: '112:2',
      itemId: 'hi-112:2',
      seed: 'chain',
    });
    expect(refused.probe).toBeNull();
    expect(refused.reason).toBe('no-licensed-meaning-for-previous-ayah');
  });

  it('derived segments carry the gloss and the pack it came from', () => {
    const ctx = context();
    const derived = engine.segmentItem(ctx, 'hi-112:1');
    expect(derived).not.toBeNull();
    if (!derived) return;
    expect(derived.segments.length).toBeGreaterThan(0);
    for (const segment of derived.segments) {
      expect(segment.meaning?.packId).toBe('word-data');
      expect(segment.meaning?.lang).toBe('en');
      expect(segment.meaning?.wordGloss).toBe(true);
    }
  });
});
