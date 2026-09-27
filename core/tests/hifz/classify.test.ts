/**
 * Error classification. One scenario per `ErrorKind`, all written from the
 * real Arabic fixture words (no latin placeholders), plus the accuracy rules.
 */

import { describe, expect, it } from 'vitest';
import {
  alignWords,
  classifyRecitation,
  classifyRecitationFromText,
  isExactRecitation,
  positionalFailureKind,
} from '../../src/hifz/classify';
import { segmentAyah } from '../../src/hifz/segment';
import {

  ayahText
} from './fixtures';
import { normalizeWord, tokenizeWords } from '../../src/normalize/arabic';
import type { ErrorKind } from '../../src/contracts/hifz';
import type { VerseKey } from '../../src/contracts/quran';

const words = (key: VerseKey) => tokenizeWords(ayahText(key));

describe('correct', () => {
  it('an exact recitation is fully correct and scores 1', () => {
    const result = classifyRecitation({ expected: words('112:1'), produced: words('112:1'), verseKey: '112:1' });
    expect(result.accuracy).toBe(1);
    expect(result.correctWordCount).toBe(4);
    expect(result.expectedWordCount).toBe(4);
    expect(result.errors.every((e) => e.kind === 'correct')).toBe(true);
    expect(result.errors.map((e) => e.expectedPosition)).toEqual([1, 2, 3, 4]);
    expect(result.firstErrorPosition).toBeNull();
    expect(isExactRecitation(result)).toBe(true);
  });

  it('diacritic and letter variants of the same word count as correct', () => {
    const produced = ['قل', 'هو', 'الله', 'احد'];
    const result = classifyRecitationFromText({ expectedText: ayahText('112:1'), produced, verseKey: '112:1' });
    expect(result.accuracy).toBe(1);
    expect(result.errors.every((e) => e.kind === 'correct')).toBe(true);
  });

  it('an empty recitation scores 0, never a division error', () => {
    const result = classifyRecitation({ expected: words('112:1'), produced: [], verseKey: '112:1' });
    expect(result.accuracy).toBe(0);
    expect(result.correctWordCount).toBe(0);
    expect(result.firstErrorPosition).toBe(1);
  });

  it('a partially mismatched ayah can never be reported as correct', () => {
    const partial = [words('112:1')[0]!, words('112:1')[1]!, words('112:1')[2]!];
    const result = classifyRecitation({ expected: words('112:1'), produced: partial, verseKey: '112:1' });
    expect(result.accuracy).toBeLessThan(1);
    expect(result.errors.some((e) => e.kind !== 'correct')).toBe(true);
    expect(isExactRecitation(result)).toBe(false);
  });
});

describe('one scenario per error kind', () => {
  const cases: { kind: ErrorKind; label: string; run: () => ReturnType<typeof classifyRecitation> }[] = [
    {
      kind: 'omission',
      label: '112:1 recited without هو',
      run: () => {
        const w = words('112:1');
        return classifyRecitation({ expected: w, produced: [w[0]!, w[2]!, w[3]!], verseKey: '112:1' });
      },
    },
    {
      kind: 'substitution',
      label: '112:1 with هم for هو',
      run: () => {
        const w = words('112:1');
        return classifyRecitation({ expected: w, produced: [w[0]!, 'هُمْ', w[2]!, w[3]!], verseKey: '112:1' });
      },
    },
    {
      kind: 'repetition',
      label: '112:1 with هو twice',
      run: () => {
        const w = words('112:1');
        return classifyRecitation({ expected: w, produced: [w[0]!, w[1]!, w[1]!, w[2]!, w[3]!], verseKey: '112:1' });
      },
    },
    {
      kind: 'wrong-order',
      label: '112:1 with words 2 and 3 swapped',
      run: () => {
        const w = words('112:1');
        return classifyRecitation({ expected: w, produced: [w[0]!, w[2]!, w[1]!, w[3]!], verseKey: '112:1' });
      },
    },
    {
      kind: 'wrong-transition',
      label: '1:5 continued into 1:6',
      run: () =>
        classifyRecitation({
          expected: words('1:5'),
          produced: [words('1:5')[0]!, words('1:5')[1]!, ...words('1:6')],
          verseKey: '1:5',
          mode: 'full-ayah',
          continuations: [{ verseKey: '1:6', words: words('1:6') }],
        }),
    },
    {
      kind: 'similar-ayah-confusion',
      label: '112:4 recited as 112:3',
      run: () =>
        classifyRecitation({
          expected: words('112:4'),
          produced: words('112:3'),
          verseKey: '112:4',
          mode: 'full-ayah',
          confusionCandidates: [{ verseKey: '112:3', words: words('112:3') }],
        }),
    },
    {
      kind: 'beginning-failure',
      label: 'Ayat al-Kursi breaking down at word 3',
      run: () => {
        const w = words('2:255');
        return classifyRecitation({ expected: w, produced: [w[0]!, w[1]!, 'كِتَابٌ', ...w.slice(3)], verseKey: '2:255', mode: 'full-ayah' });
      },
    },
    {
      kind: 'middle-failure',
      label: 'Ayat al-Kursi breaking down at word 23',
      run: () => {
        const w = words('2:255');
        return classifyRecitation({
          expected: w,
          produced: [...w.slice(0, 22), 'يَدْفَعُ', ...w.slice(23)],
          verseKey: '2:255',
          mode: 'full-ayah',
        });
      },
    },
    {
      kind: 'ending-failure',
      label: 'Ayat al-Kursi breaking down in the last third',
      run: () => {
        const w = words('2:255');
        return classifyRecitation({
          expected: w,
          produced: [...w.slice(0, 47), 'ٱلْكَبِيرُ', 'ٱلْحَكِيمُ'],
          verseKey: '2:255',
          mode: 'full-ayah',
        });
      },
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.kind}: ${testCase.label}`, () => {
      const result = testCase.run();
      const found = result.errors.filter((e) => e.kind === testCase.kind);
      expect(found.length, `${testCase.kind} missing in ${JSON.stringify(result.errors.map((e) => e.kind))}`).toBeGreaterThan(0);
      expect(result.accuracy).toBeLessThan(1);
      for (const error of found) {
        expect(error.expectedPosition).toBeGreaterThanOrEqual(1);
        expect(error.expectedPosition).toBeLessThanOrEqual(result.expectedWordCount);
        expect(error.explanation.length).toBeGreaterThan(0);
      }
    });
  }

  it('covers all ten contract kinds across the scenarios', () => {
    const kinds: Set<ErrorKind> = new Set();
    for (const testCase of cases) for (const error of testCase.run().errors) kinds.add(error.kind);
    kinds.add('correct');
    const contractKinds: ErrorKind[] = [
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
    for (const kind of contractKinds) expect(kinds.has(kind), kind).toBe(true);
  });
});

describe('positional failures', () => {
  it('are derived from which third the first error falls in', () => {
    expect(positionalFailureKind(1, 50)).toBe('beginning-failure');
    expect(positionalFailureKind(17, 50)).toBe('beginning-failure');
    expect(positionalFailureKind(18, 50)).toBe('middle-failure');
    expect(positionalFailureKind(34, 50)).toBe('middle-failure');
    expect(positionalFailureKind(35, 50)).toBe('ending-failure');
    expect(positionalFailureKind(null, 50)).toBeNull();
  });

  it('are emitted exactly once, at the first error position', () => {
    const w = words('2:255');
    const result = classifyRecitation({
      expected: w,
      produced: w.slice(0, 8),
      verseKey: '2:255',
      mode: 'full-ayah',
    });
    const positional = result.errors.filter((e) => e.kind.endsWith('-failure'));
    expect(positional).toHaveLength(1);
    expect(positional[0]!.expectedPosition).toBe(result.firstErrorPosition);
    expect(positional[0]!.kind).toBe('beginning-failure');
  });

  it('are suppressed for partial probes unless asked for', () => {
    const w = words('2:255');
    const segment = classifyRecitation({ expected: w.slice(0, 4), produced: [], mode: 'segment' });
    expect(segment.errors.some((e) => e.kind.endsWith('-failure'))).toBe(false);
    const forced = classifyRecitation({ expected: w.slice(0, 4), produced: [], mode: 'segment', positionalFailures: true });
    expect(forced.errors.some((e) => e.kind.endsWith('-failure'))).toBe(true);
  });
});

describe('attribution', () => {
  it('maps every error onto the segment that covers it', () => {
    const segmentation = segmentAyah({ itemId: 'i-kursi', verseKey: '2:255', text: ayahText('2:255') });
    const w = words('2:255');
    const result = classifyRecitation({
      expected: w,
      produced: w.slice(0, 8),
      verseKey: '2:255',
      mode: 'full-ayah',
      segments: segmentation.segments,
    });
    const wordErrors = result.errors.filter((e) => e.kind !== 'correct');
    expect(wordErrors.length).toBeGreaterThan(0);
    for (const error of wordErrors) expect(error.segmentPosition).not.toBeNull();
    const first = segmentation.segments.find((s) => s.fromWord <= 9 && s.toWord >= 9);
    expect(wordErrors.find((e) => e.expectedPosition === 9)?.segmentPosition).toBe(first?.position);
  });

  it('confusion errors carry the partner verse key', () => {
    const result = classifyRecitation({
      expected: words('112:4'),
      produced: words('112:3'),
      verseKey: '112:4',
      mode: 'full-ayah',
      confusionCandidates: [{ verseKey: '112:3', words: words('112:3') }],
    });
    const confusion = result.errors.find((e) => e.kind === 'similar-ayah-confusion');
    expect(confusion?.confusedWithVerseKey).toBe('112:3');
    expect(result.runs[0]).toMatchObject({ kind: 'similar-ayah-confusion', confusedWithVerseKey: '112:3' });
  });

  it('a wrong transition names the ayah that was entered', () => {
    const result = classifyRecitation({
      expected: words('1:5'),
      produced: [words('1:5')[0]!, words('1:5')[1]!, ...words('1:6')],
      verseKey: '1:5',
      mode: 'full-ayah',
      continuations: [{ verseKey: '1:6', words: words('1:6') }],
    });
    const wrong = result.errors.find((e) => e.kind === 'wrong-transition');
    expect(wrong?.confusedWithVerseKey).toBe('1:6');
  });

  it('without candidates a cross-ayah slip degrades to plain substitutions', () => {
    const result = classifyRecitation({
      expected: words('1:5'),
      produced: [words('1:5')[0]!, words('1:5')[1]!, ...words('1:6')],
      verseKey: '1:5',
      mode: 'full-ayah',
    });
    expect(result.errors.some((e) => e.kind === 'wrong-transition')).toBe(false);
    expect(result.errors.some((e) => e.kind === 'substitution')).toBe(true);
  });
});

describe('alignment internals', () => {
  it('aligns identical sequences as all matches', () => {
    const ops = alignWords(['ا', 'ب', 'ج'], ['ا', 'ب', 'ج']);
    expect(ops.map((o) => o.kind)).toEqual(['match', 'match', 'match']);
  });

  it('keeps one gap for a run of dropped words instead of scattering matches', () => {
    const ops = alignWords(['ا', 'ب', 'ج', 'د', 'ه'], ['ا', 'ه']);
    expect(ops.map((o) => o.kind)).toEqual(['match', 'omission', 'omission', 'omission', 'match']);
    expect(ops.filter((o) => o.kind === 'omission')).toHaveLength(3);
  });

  it('is deterministic', () => {
    const w = words('2:255');
    const produced = w.slice(0, 20).concat(w.slice(21, 25));
    const a = classifyRecitation({ expected: w, produced, verseKey: '2:255', mode: 'full-ayah' });
    const b = classifyRecitation({ expected: w, produced, verseKey: '2:255', mode: 'full-ayah' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('Quran text is never mutated', () => {
  it('inputs come back byte-identical after classification', () => {
    const expected = Object.freeze(words('112:4'));
    const produced = Object.freeze([...expected.slice(0, 2), 'لَّهُم']);
    const snapshot = JSON.stringify(expected);
    classifyRecitation({ expected, produced, verseKey: '112:4' });
    expect(JSON.stringify(expected)).toBe(snapshot);
    expect(normalizeWord(expected[3]!)).toBe('كفوا');
  });
});
