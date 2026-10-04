/**
 * Recall probes: every mode must hand the UI a cue plus the exact expected
 * word range and words — derived from the ayah text, never invented.
 */

import { describe, expect, it } from 'vitest';
import {
  PROBE_MODES,
  audioRecallProbe,
  buildProbe,
  continueAyahProbe,
  continueSequenceProbe,
  endingRecallProbe,
  firstWordCueProbe,
  fullAyahProbe,
  fullSequenceProbe,
  lastWordCueProbe,
  middleRecallProbe,
  missingWordProbe,
  openingRecallProbe,
  randomRecallProbe,
  reverseRecallProbe,
  seededRandom,
  segmentRecallProbe,
  transitionProbe,
  type ProbeAyah,
} from '../../src/hifz/recall';
import { segmentAyah } from '../../src/hifz/segment';
import {
  ayahText,
  makeMeaning
} from './fixtures';
import { RECALL_MODES } from '../../src/contracts/hifz';
import type { VerseKey } from '../../src/contracts/quran';
import { tokenizeWords } from '../../src/normalize/arabic';
import { MISSING_WORD_PLACEHOLDER, RANDOM_PROBE_SPAN_WORDS } from '../../src/hifz/params';

const ayah = (verseKey: VerseKey, itemId = `i-${verseKey}`): ProbeAyah => ({
  itemId,
  verseKey,
  text: ayahText(verseKey),
});

function words(verseKey: VerseKey): string[] {
  return tokenizeWords(ayahText(verseKey));
}

describe('free and whole-ayah probes', () => {
  it('full-ayah expects every word with no cue', () => {
    const probe = fullAyahProbe(ayah('112:1'));
    expect(probe.mode).toBe('full-ayah');
    expect(probe.cue).toEqual({ kind: 'free-recall', text: null });
    expect(probe.fromWord).toBe(1);
    expect(probe.toWord).toBe(4);
    expect(probe.expected.map((w) => w.text)).toEqual(words('112:1'));
    expect(probe.prompt).toBe('Recite the whole ayah.');
  });

  it('audio-recall cues on the audio pack id, not on invented text', () => {
    const probe = audioRecallProbe(ayah('108:1'), 'audio-ar-001');
    expect(probe.cue).toEqual({ kind: 'audio', text: 'audio-ar-001' });
    expect(probe.expected.map((w) => w.text)).toEqual(words('108:1'));
  });

  it('full-sequence concatenates the sequence in order', () => {
    const probe = fullSequenceProbe([ayah('112:1'), ayah('112:2'), ayah('112:3')]);
    expect(probe.mode).toBe('full-sequence');
    expect(probe.verseKey).toBe('112:1');
    expect(probe.nextVerseKey).toBe('112:3');
    const expected = [...words('112:1'), ...words('112:2'), ...words('112:3')];
    expect(probe.expected.map((w) => w.text)).toEqual(expected);
    expect(probe.toWord).toBe(expected.length);
  });
});

describe('positional probes', () => {
  it('opening / middle / ending split the ayah into thirds', () => {
    const opening = openingRecallProbe(ayah('112:1'));
    const middle = middleRecallProbe(ayah('112:1'));
    const ending = endingRecallProbe(ayah('112:1'));
    expect([opening.fromWord, opening.toWord]).toEqual([1, 2]);
    expect([middle.fromWord, middle.toWord]).toEqual([3, 4]);
    expect([ending.fromWord, ending.toWord]).toEqual([4, 4]);
    expect(opening.expected.map((w) => w.text)).toEqual(words('112:1').slice(0, 2));
    expect(middle.expected.map((w) => w.text)).toEqual(words('112:1').slice(2, 4));
    expect(ending.expected.map((w) => w.text)).toEqual(words('112:1').slice(3, 4));
    expect(middle.cue.text).toBe('قُلْ هُوَ');
  });

  it('Ayat al-Kursi thirds stay inside the ayah', () => {
    const all = words('2:255');
    for (const probe of [openingRecallProbe, middleRecallProbe, endingRecallProbe].map((f) => f(ayah('2:255')))) {
      expect(probe.fromWord).toBeGreaterThanOrEqual(1);
      expect(probe.toWord).toBeLessThanOrEqual(all.length);
      expect(probe.expected.map((w) => w.text)).toEqual(all.slice(probe.fromWord - 1, probe.toWord));
    }
  });
});

describe('cue probes', () => {
  it('first-word cue shows the opening word and expects the rest', () => {
    const probe = firstWordCueProbe(ayah('112:1'));
    expect(probe.cue).toEqual({ kind: 'first-word', text: 'قُلْ' });
    expect([probe.fromWord, probe.toWord]).toEqual([2, 4]);
    expect(probe.expected.map((w) => w.text)).toEqual(words('112:1').slice(1));
  });

  it('last-word cue names the closing word and expects the ayah', () => {
    const probe = lastWordCueProbe(ayah('112:1'));
    expect(probe.cue).toEqual({ kind: 'last-word', text: 'أَحَدٌ' });
    expect([probe.fromWord, probe.toWord]).toEqual([1, 4]);
    expect(probe.expected.map((w) => w.text)).toEqual(words('112:1'));
  });

  it('continue-ayah is given a prefix and expects the remainder', () => {
    const probe = continueAyahProbe({ ayah: ayah('2:255'), givenWords: 7 });
    expect(probe.cue.text).toBe(words('2:255').slice(0, 7).join(' '));
    expect(probe.fromWord).toBe(8);
    expect(probe.expected.map((w) => w.text)).toEqual(words('2:255').slice(7));
  });

  it('continue-ayah also accepts the prefix text itself', () => {
    const prefix = words('112:3').slice(0, 2).join(' ');
    const probe = continueAyahProbe({ ayah: ayah('112:3'), prefixText: prefix });
    expect(probe.fromWord).toBe(3);
    expect(probe.expected.map((w) => w.text)).toEqual(words('112:3').slice(2));
  });

  it('missing-word blanks exactly one position', () => {
    const probe = missingWordProbe({ ayah: ayah('112:1'), position: 2 });
    expect(probe.mode).toBe('missing-word');
    expect(probe.hiddenWordPosition).toBe(2);
    expect([probe.fromWord, probe.toWord]).toEqual([2, 2]);
    expect(probe.expected.map((w) => w.text)).toEqual(['هُوَ']);
    expect(probe.cue.text).toContain(MISSING_WORD_PLACEHOLDER);
    expect(probe.cue.text).not.toContain('هُوَ');
  });

  it('missing-word without a position is seeded and reproducible', () => {
    const a = missingWordProbe({ ayah: ayah('2:255'), seed: 42 });
    const b = missingWordProbe({ ayah: ayah('2:255'), seed: 42 });
    expect(a.hiddenWordPosition).toBe(b.hiddenWordPosition);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const positions = new Set(
      Array.from({ length: 12 }, (_, seed) => missingWordProbe({ ayah: ayah('2:255'), seed }).hiddenWordPosition),
    );
    expect(positions.size).toBeGreaterThan(1);
  });
});

describe('transition and sequence probes', () => {
  it('intra-ayah transition cues the boundary and expects the next words', () => {
    const segmentation = segmentAyah({ itemId: 'i-112-3', verseKey: '112:3', text: ayahText('112:3') });
    const boundary = segmentation.boundaries[0]!;
    const probe = transitionProbe({
      from: ayah('112:3'),
      to: ayah('112:3'),
      kind: 'intra',
      boundaryWord: boundary.wordPosition,
    });
    expect(probe.mode).toBe('transition');
    expect(probe.cue.kind).toBe('transition-intra');
    expect(probe.cue.text).toBe('لَمْ يَلِدْ');
    expect(probe.fromWord).toBe(3);
    expect(probe.expected.map((w) => w.text)).toEqual(words('112:3').slice(2, 4));
  });

  it('inter-ayah transition cues on the previous ayah ending', () => {
    const probe = transitionProbe({ from: ayah('112:1'), to: ayah('112:2'), kind: 'inter' });
    expect(probe.cue.kind).toBe('transition-inter');
    expect(probe.cue.text).toBe('ٱللَّهُ أَحَدٌ');
    expect(probe.verseKey).toBe('112:2');
    expect(probe.nextVerseKey).toBe('112:2');
    expect(probe.expected.map((w) => w.text)).toEqual(words('112:2'));
  });

  it('continue-sequence gives ayah N ending and expects ayah N+1 opening', () => {
    const probe = continueSequenceProbe({ previous: ayah('108:1'), next: ayah('108:2') });
    expect(probe.cue.kind).toBe('previous-ayah-ending');
    expect(probe.cue.text).toBe('أَعْطَيْنَٰكَ ٱلْكَوْثَرَ');
    expect(probe.expected.map((w) => w.text)).toEqual(words('108:2'));
    expect(probe.nextVerseKey).toBe('108:2');
  });
});

describe('segment probe', () => {
  it('expects exactly the segment words and cues the previous segment end', () => {
    const segmentation = segmentAyah({ itemId: 'i-112-3', verseKey: '112:3', text: ayahText('112:3') });
    const second = segmentation.segments[1]!;
    const probe = segmentRecallProbe(ayah('112:3'), second);
    expect(probe.mode).toBe('segment');
    expect([probe.fromWord, probe.toWord]).toEqual([second.fromWord, second.toWord]);
    expect(probe.cue.text).toBe('لَمْ يَلِدْ');
    expect(probe.expected.map((w) => w.text)).toEqual(words('112:3').slice(2, 4));
    const first = segmentation.segments[0]!;
    expect(segmentRecallProbe(ayah('112:3'), first).cue.text).toBeNull();
  });
});

describe('reverse and random probes', () => {
  it('reverse expects the ayah words back to front', () => {
    const probe = reverseRecallProbe(ayah('112:1'));
    expect(probe.mode).toBe('reverse');
    expect(probe.cue.text).toBe('أَحَدٌ');
    expect(probe.expected.map((w) => w.text)).toEqual(words('112:1').slice().reverse());
    expect([probe.fromWord, probe.toWord]).toEqual([1, 4]);
  });

  it('random returns a contiguous span and is fully seed-determined', () => {
    const first = randomRecallProbe({ ayah: ayah('2:255'), seed: 'session-1' });
    const again = randomRecallProbe({ ayah: ayah('2:255'), seed: 'session-1' });
    expect(JSON.stringify(first)).toBe(JSON.stringify(again));
    const length = first.toWord - first.fromWord + 1;
    expect(length).toBe(RANDOM_PROBE_SPAN_WORDS);
    expect(first.expected.map((w) => w.text)).toEqual(words('2:255').slice(first.fromWord - 1, first.toWord));
    const other = randomRecallProbe({ ayah: ayah('2:255'), seed: 'session-2' });
    expect(other.fromWord).not.toBe(first.fromWord);
  });

  it('seededRandom is a deterministic 0..1 stream', () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    const streamA = Array.from({ length: 5 }, () => a());
    const streamB = Array.from({ length: 5 }, () => b());
    expect(streamA).toEqual(streamB);
    for (const value of streamA) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    expect(seededRandom('same-text')()).toBe(seededRandom('same-text')());
  });
});

describe('buildProbe dispatcher', () => {
  it('serves every recall mode the contract allows', () => {
    const segmentation = segmentAyah({ itemId: 'i-112-1', verseKey: '112:1', text: ayahText('112:1') });
    const context = {
      ayah: ayah('112:1'),
      next: ayah('112:2'),
      ayahs: [ayah('112:1'), ayah('112:2')],
      segment: segmentation.segments[0]!,
      givenWords: 1,
      position: 3,
      seed: 5,
      // The two meaning modes refuse to build without a licensed cue, so the
      // full-coverage check has to supply one.
      meaning: makeMeaning('say: He is Allah, the One'),
      previousMeaning: makeMeaning('say: He is Allah, the Eternal, the Absolute'),
      previousVerseKey: '112:2' as VerseKey,
    };
    for (const mode of PROBE_MODES) {
      const probe = buildProbe(mode, context);
      expect(probe.mode).toBe(mode);
      expect(PROBE_MODES).toContain(probe.mode);
      expect(probe.expected.length).toBeGreaterThan(0);
      expect(probe.cue.kind.length).toBeGreaterThan(0);
      expect(probe.prompt.length).toBeGreaterThan(0);
      expect(probe.fromWord).toBeLessThanOrEqual(probe.toWord + 1);
    }
  });

  it('dispatches every mode the contracts declare, with no gap either way', () => {
    expect([...PROBE_MODES].sort()).toEqual([...RECALL_MODES].sort());
  });

  it('no probe invents a word that is not in the fixture ayah', () => {
    const source = words('112:1');
    const probe = buildProbe('random', { ayah: ayah('112:1'), seed: 3 });
    for (const word of probe.expected) expect(source).toContain(word.text);
  });

  it('missing context fails loudly instead of guessing', () => {
    expect(() => buildProbe('segment', { ayah: ayah('112:1') })).toThrow(/needs a segment/);
    expect(() => buildProbe('transition', { ayah: ayah('112:1') })).toThrow(/following ayah/);
    expect(() => buildProbe('continue-sequence', { ayah: ayah('112:1') })).toThrow(/following ayah/);
    expect(() => buildProbe('meaning-to-arabic', { ayah: ayah('112:1') })).toThrow(/licensed meaning/);
    expect(() => buildProbe('concept-cue', { ayah: ayah('112:2') })).toThrow(/previous ayah meaning/);
  });
});
