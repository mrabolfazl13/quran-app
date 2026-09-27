/**
 * Segmentation: tiling invariants, rule behaviour, anchors and transitions.
 * All texts are the verbatim fixtures in `fixtures.ts` (test data only).
 */

import { describe, expect, it } from 'vitest';
import { assertTiling, segmentAyah, segmentAt, hifzWordsOf } from '../../src/hifz/segment';
import {

  SURAH_1_KEYS,
  SURAH_108_KEYS,
  SURAH_112_KEYS,
  fixtureWords,
  fixtureWordsWithMark,
  ayahText
} from './fixtures';
import { tokenizeWords, normalizeWord } from '../../src/normalize/arabic';
import { MAX_SEGMENT_WORDS, MIN_SEGMENT_WORDS } from '../../src/hifz/params';

const ALL_KEYS = [...SURAH_1_KEYS, ...SURAH_108_KEYS, ...SURAH_112_KEYS, '2:255'] as const;

describe('segmentation tiles every fixture ayah exactly', () => {
  for (const verseKey of ALL_KEYS) {
    it(`${verseKey}: contiguous 1-based cover with no word twice and none left out`, () => {
      const text = ayahText(verseKey);
      const words = tokenizeWords(text);
      const result = segmentAyah({ itemId: `item-${verseKey}`, verseKey, text });

      expect(result.wordCount).toBe(words.length);
      expect(assertTiling(result.segments, result.wordCount)).toEqual({ ok: true });

      const covered: number[] = [];
      for (const segment of result.segments) {
        for (let position = segment.fromWord; position <= segment.toWord; position += 1) covered.push(position);
      }
      const expected = words.map((_, index) => index + 1);
      expect(covered).toEqual(expected);
      expect(new Set(covered).size).toBe(covered.length);
    });

    it(`${verseKey}: segment text is a verbatim slice of the ayah word sequence`, () => {
      const text = ayahText(verseKey);
      const words = tokenizeWords(text);
      const result = segmentAyah({ itemId: `item-${verseKey}`, verseKey, text });
      const rejoined = result.segments.map((s) => s.text).join(' ');
      expect(rejoined.split(/\s+/).filter((t) => t.length > 0)).toEqual(words);
      for (const segment of result.segments) {
        const sliceWords = segment.text.split(/\s+/).filter((t) => t.length > 0);
        expect(sliceWords).toEqual(words.slice(segment.fromWord - 1, segment.toWord));
      }
    });
  }

  it('keeps every segment inside the documented word bounds', () => {
    for (const verseKey of ALL_KEYS) {
      const result = segmentAyah({ itemId: `item-${verseKey}`, verseKey, text: ayahText(verseKey) });
      const wordCount = result.wordCount;
      for (const segment of result.segments) {
        const length = segment.toWord - segment.fromWord + 1;
        if (wordCount >= MIN_SEGMENT_WORDS * 2) {
          expect(length).toBeGreaterThanOrEqual(MIN_SEGMENT_WORDS);
          expect(length).toBeLessThanOrEqual(MAX_SEGMENT_WORDS);
        } else {
          expect(length).toBe(wordCount);
        }
      }
    }
  });

  it('long ayah 2:255 becomes many chunks, short ayahs stay whole', () => {
    const kursi = segmentAyah({ itemId: 'i-kursi', verseKey: '2:255', text: ayahText('2:255') });
    expect(kursi.wordCount).toBe(50);
    expect(kursi.segments.length).toBeGreaterThan(8);
    const ikhlas = segmentAyah({ itemId: 'i-112-1', verseKey: '112:1', text: ayahText('112:1') });
    expect(ikhlas.segments).toHaveLength(1);
    expect(ikhlas.segments[0]).toMatchObject({ fromWord: 1, toWord: 4 });
  });
});

describe('boundary rules', () => {
  it('a clause-initial waw opens a new segment', () => {
    const result = segmentAyah({ itemId: 'i-112-3', verseKey: '112:3', text: ayahText('112:3') });
    expect(result.segments.map((s) => [s.fromWord, s.toWord])).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(result.boundaries).toHaveLength(1);
    expect(result.boundaries[0]!.wordPosition).toBe(3);
    expect(result.boundaries[0]!.reasons).toContain('prefix-connector:و');
  });

  it('and in the middle of an ayah (1:5) too', () => {
    const result = segmentAyah({ itemId: 'i-1-5', verseKey: '1:5', text: ayahText('1:5') });
    expect(result.boundaries.map((b) => b.wordPosition)).toEqual([3]);
  });

  it('standalone particles count as connectors, joined roots are tolerated', () => {
    const kursi = segmentAyah({ itemId: 'i-kursi', verseKey: '2:255', text: ayahText('2:255') });
    const reasons = kursi.proposedBoundaries.flatMap((b) => b.reasons);
    expect(reasons).toContain('connector:ما');
    expect(reasons).toContain('connector:في');
    expect(reasons).toContain('connector:من');
    expect(reasons).toContain('prefix-connector:و');
  });

  it('pause marks are boundaries and score higher than a bare connector', () => {
    const kursi = segmentAyah({ itemId: 'i-kursi', verseKey: '2:255', text: ayahText('2:255') });
    const pauseOnly = kursi.proposedBoundaries.filter((b) => b.reasons.includes('pause-mark'));
    expect(pauseOnly.length).toBeGreaterThan(0);
    for (const boundary of pauseOnly) expect(boundary.score).toBeGreaterThanOrEqual(3);
    // Ornament marks are excluded from word positions entirely.
    expect(kursi.notes.join(' ')).toMatch(/ornamental\/pause token\(s\) excluded/);
  });

  it('a long ayah needs a forced midpoint split when no rule fires inside it', () => {
    // 1:7 has a waw connector at word 8 only; the 7-word span forces a split.
    const result = segmentAyah({ itemId: 'i-1-7', verseKey: '1:7', text: ayahText('1:7') });
    expect(result.boundaries).toEqual([
      { wordPosition: 4, score: 0, reasons: ['forced-midpoint'] },
      { wordPosition: 8, score: 2, reasons: ['prefix-connector:و'] },
    ]);
    for (const segment of result.segments) {
      expect(segment.toWord - segment.fromWord + 1).toBeLessThanOrEqual(MAX_SEGMENT_WORDS);
    }
  });

  it('candidates that would leave a one-word segment are proposed but not chosen', () => {
    const kursi = segmentAyah({ itemId: 'i-kursi', verseKey: '2:255', text: ayahText('2:255') });
    const chosen = new Set(kursi.boundaries.map((b) => b.wordPosition));
    const dropped = kursi.proposedBoundaries.filter((b) => !chosen.has(b.wordPosition));
    expect(dropped.length).toBeGreaterThan(0);
    for (const segment of kursi.segments) {
      expect(segment.toWord - segment.fromWord + 1).toBeGreaterThanOrEqual(MIN_SEGMENT_WORDS);
    }
  });

  it('is deterministic: the same input segments identically twice', () => {
    for (const verseKey of ALL_KEYS) {
      const a = segmentAyah({ itemId: 'i', verseKey, text: ayahText(verseKey) });
      const b = segmentAyah({ itemId: 'i', verseKey, text: ayahText(verseKey) });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });
});

describe('anchors', () => {
  it('cover opening, middle, ending and every chosen boundary', () => {
    const result = segmentAyah({ itemId: 'i-112-3', verseKey: '112:3', text: ayahText('112:3') });
    const roles = result.anchors.map((a) => [a.wordPosition, a.role]);
    expect(roles).toEqual([
      [1, 'opening'],
      [2, 'middle'],
      [3, 'boundary'],
      [4, 'ending'],
    ]);
    for (const anchor of result.anchors) {
      const words = tokenizeWords(ayahText('112:3'));
      expect(anchor.text).toBe(words[anchor.wordPosition - 1]);
    }
  });

  it('never assigns two roles to the same word position', () => {
    for (const verseKey of ALL_KEYS) {
      const result = segmentAyah({ itemId: `i-${verseKey}`, verseKey, text: ayahText(verseKey) });
      const positions = result.anchors.map((a) => a.wordPosition);
      expect(new Set(positions).size).toBe(positions.length);
      expect(positions).toContain(1);
      expect(positions).toContain(result.wordCount);
      const ids = result.anchors.map((a) => a.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('opening and ending anchors of Ayat al-Kursi are the real first/last words', () => {
    const result = segmentAyah({ itemId: 'i-kursi', verseKey: '2:255', text: ayahText('2:255') });
    const opening = result.anchors.find((a) => a.role === 'opening');
    const ending = result.anchors.find((a) => a.role === 'ending');
    expect(opening?.text).toBe('ٱللَّهُ');
    expect(ending?.wordPosition).toBe(50);
    expect(normalizeWord(ending!.text)).toBe('العظيم');
  });
});

describe('transitions', () => {
  it('one intra transition per chosen boundary, pointing at the following word', () => {
    const result = segmentAyah({ itemId: 'i-112-3', verseKey: '112:3', text: ayahText('112:3') });
    expect(result.transitions).toHaveLength(1);
    expect(result.transitions[0]).toMatchObject({ kind: 'intra', toWord: 3, toVerseKey: null, stability: 0 });
    expect(result.transitions[0]!.id.startsWith('i-112-3:112:3:t')).toBe(true);
  });

  it('an inter transition is added when the item continues into the next ayah', () => {
    const result = segmentAyah({
      itemId: 'i-112-1',
      verseKey: '112:1',
      text: ayahText('112:1'),
      nextVerseKey: '112:2',
    });
    const inter = result.transitions.filter((t) => t.kind === 'inter');
    expect(inter).toHaveLength(1);
    expect(inter[0]).toMatchObject({ toVerseKey: '112:2', toWord: 1 });
  });
});

describe('word list integration', () => {
  it('a supplied AyahWord list enriches words without moving positions', () => {
    const verseKey = '112:1';
    const withList = segmentAyah({
      itemId: 'i-112-1',
      verseKey,
      text: ayahText(verseKey),
      words: fixtureWords(verseKey, ['say', 'he', 'allah', 'one']),
    });
    expect(withList.words.map((w) => w.position)).toEqual([1, 2, 3, 4]);
    expect(withList.words[0]!.translationEn).toBe('fixture:say');
    expect(withList.words[3]!.translationEn).toBe('fixture:one');
    expect(withList.notes).toEqual([]);
  });

  it('end-of-ayah mark rows never enter word positions', () => {
    const verseKey = '108:1';
    const result = segmentAyah({
      itemId: 'i-108-1',
      verseKey,
      text: ayahText(verseKey),
      words: fixtureWordsWithMark(verseKey),
    });
    expect(result.wordCount).toBe(tokenizeWords(ayahText(verseKey)).length);
    expect(result.words.some((w) => w.norm === '')).toBe(false);
    expect(result.notes).toEqual([]);
  });

  it('a word list that disagrees with the text is reported, and the text wins', () => {
    const verseKey = '112:2';
    const shortList = fixtureWords(verseKey).slice(0, 1);
    const result = segmentAyah({ itemId: 'i-112-2', verseKey, text: ayahText(verseKey), words: shortList });
    expect(result.wordCount).toBe(2);
    expect(result.notes.join(' ')).toMatch(/text wins/);
    expect(assertTiling(result.segments, result.wordCount)).toEqual({ ok: true });
  });

  it('hifzWordsOf exposes the same words the segmenter used', () => {
    const words = hifzWordsOf(ayahText('112:4'));
    expect(words.map((w) => w.norm)).toEqual(tokenizeWords(ayahText('112:4')).map(normalizeWord));
  });

  it('meanings are only attached when the caller supplies them', () => {
    const result = segmentAyah({
      itemId: 'i-112-3',
      verseKey: '112:3',
      text: ayahText('112:3'),
      meaningsFa: { 0: 'fixture:negation-of-birth', 1: 'fixture:negation-of-being-born' },
    });
    expect(result.segments[0]!.meaningFa).toBe('fixture:negation-of-birth');
    expect(result.segments[0]!.meaningSource).toBe('fixture-editorial');
    expect(result.segments[1]!.meaningFa).toBe('fixture:negation-of-being-born');
    const bare = segmentAyah({ itemId: 'i-112-3', verseKey: '112:3', text: ayahText('112:3') });
    expect(bare.segments[0]!.meaningFa).toBeNull();
  });
});

describe('segmentAt', () => {
  it('resolves a word position to its segment', () => {
    const result = segmentAyah({ itemId: 'i-kursi', verseKey: '2:255', text: ayahText('2:255') });
    for (const segment of result.segments) {
      expect(segmentAt(result.segments, segment.fromWord)).toBe(segment);
      expect(segmentAt(result.segments, segment.toWord)).toBe(segment);
    }
    expect(segmentAt(result.segments, 999)).toBeNull();
  });
});
