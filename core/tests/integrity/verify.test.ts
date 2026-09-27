import { describe, expect, it } from 'vitest';
import type { Ayah, Surah } from '../../src/contracts/quran';
import {
  CORPUS_EXPECT,
  verifyCorpus,
  verifyPageMonotonicity,
} from '../../src/integrity/verify';
import { normalizedFingerprint, tokenizeWords, wordCount } from '../../src/normalize/arabic';

/**
 * Fixtures are tiny synthetic corpora shaped like the real one. The counts are
 * deliberately wrong (2 surahs, 5 ayahs) so every structural check is exercised
 * against a report that must flag them, plus a clean case that must be silent.
 */

function ayah(
  chapter: number,
  verse: number,
  text: string,
  over: Partial<Ayah> = {},
): Ayah {
  const key = `${chapter}:${verse}` as const;
  return {
    verseKey: `${chapter}:${verse}`,
    chapter,
    verse,
    sourceId: null,
    juz: 1,
    hizb: 1,
    rubElHizb: 1,
    sajda: null,
    ruku: null,
    manzil: 1,
    page: 1,
    textUthmani: text,
    textUthmaniSimple: null,
    wordCount: wordCount(text),
    normalizedHash: normalizedFingerprint(text),
    ...over,
  };
}

function surah(number: number, ayahCount: number): Surah {
  return {
    number,
    nameArabic: 'س',
    nameSimple: 'S',
    nameTransliterated: 'S',
    translationFa: null,
    translationEn: null,
    revelationPlace: 'makkah',
    revelationOrder: number,
    ayahCount,
    pagesFrom: 1,
    pagesTo: 1,
    firstVerseKey: `${number}:1`,
    lastVerseKey: `${number}:${ayahCount}`,
    bismillahPre: false,
  };
}

const clean = [
  ayah(1, 1, 'بِسْمِ ٱللَّهِ ٱلرَّحْمَـٰنِ ٱلرَّحِيمِ'),
  ayah(1, 2, 'ٱلْحَمْدُ لِلَّهِ رَبِّ ٱلْعَـٰلَمِينَ'),
  ayah(2, 1, 'ذَٲلِكَ ٱلْكِتَـٰبُ لَا رَيْبَ فِيهِ'),
  ayah(2, 2, 'هُدًى لِّلْمُتَّقِينَ'),
  ayah(2, 3, 'ٱلَّذِينَ يُؤْمِنُونَ بِٱلْغَيْبِ'),
];
const cleanSurahs = [surah(1, 2), surah(2, 3)];

describe('verifyCorpus structural checks', () => {
  it('documents the real corpus expectations', () => {
    expect(CORPUS_EXPECT.surahs).toBe(114);
    expect(CORPUS_EXPECT.ayahs).toBe(6236);
    expect(CORPUS_EXPECT.juz).toBe(30);
    expect(CORPUS_EXPECT.hizb).toBe(60);
    expect(CORPUS_EXPECT.pages).toBe(604);
    expect(CORPUS_EXPECT.lastVerseKey).toBe('114:6');
  });

  it('reports only the whole-mushaf size failures for a well-formed subset', () => {
    const report = verifyCorpus(clean, cleanSurahs);
    const codes = report.issues.map((i) => i.code);
    expect(codes).toEqual(['surah-count', 'ayah-count', 'last-verse']);
    expect(report.ok).toBe(false);
    expect(report.checkedAyahs).toBe(5);
  });

  it('passes a well-formed corpus in partial scope', () => {
    const report = verifyCorpus(clean, cleanSurahs, { scope: 'partial' });
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('accepts size expectations when the caller opts out via a full-shaped corpus', () => {
    const big = Array.from({ length: CORPUS_EXPECT.ayahs }, (_, i) => {
      const chapter = Math.floor(i / 55) + 1;
      const verse = (i % 55) + 1;
      return ayah(chapter, verse, 'كلمة ' + i);
    });
    const surahs = Array.from({ length: CORPUS_EXPECT.surahs }, (_, i) => surah(i + 1, 55));
    const report = verifyCorpus(big.slice(0, 200), surahs.slice(0, 4));
    expect(report.issues.map((i) => i.code)).toContain('ayah-count');
    expect(report.issues.some((i) => i.code === 'ordering')).toBe(false);
  });

  it('flags a duplicated verse key', () => {
    const dup = [clean[0]!, clean[1]!, { ...clean[2]!, verseKey: '1:1' }];
    const report = verifyCorpus(dup, [surah(1, 2), surah(2, 1)]);
    expect(report.issues.filter((i) => i.code === 'duplicate-key')).toHaveLength(1);
    expect(report.issues.find((i) => i.code === 'duplicate-key')!.subject).toBe('1:1');
  });

  it('flags a gap in verse ordering', () => {
    const gapped = [ayah(1, 1, 'أ'), ayah(1, 3, 'ب')];
    const report = verifyCorpus(gapped, [surah(1, 2)]);
    const ordering = report.issues.find((i) => i.code === 'ordering');
    expect(ordering?.subject).toBe('1:3');
    expect(ordering?.detail).toContain('follows 1:1');
  });

  it('flags blank authoritative text as fatal', () => {
    const blank = [ayah(1, 1, '   '), ayah(1, 2, 'ب')];
    const report = verifyCorpus(blank, [surah(1, 2)]);
    expect(report.ok).toBe(false);
    expect(report.issues.find((i) => i.code === 'empty-text')?.subject).toBe('1:1');
  });

  it('flags out-of-range divisions', () => {
    const bad = [
      ayah(1, 1, 'أ', { juz: 31 }),
      ayah(1, 2, 'ب', { hizb: 0 }),
      ayah(1, 3, 'ج', { page: 605 }),
      ayah(1, 4, 'د', { chapter: 1, verse: 4 }),
    ];
    const report = verifyCorpus(bad, [surah(1, 4)]);
    const codes = report.issues.map((i) => i.code);
    expect(codes).toContain('juz-range');
    expect(codes).toContain('hizb-range');
    expect(codes).toContain('page-range');
  });

  it('detects stored text that drifted from the pack digest', () => {
    const tampered = ayah(1, 1, 'بِسْمِ ٱللَّهِ');
    const digest = new Map([[tampered.verseKey, normalizedFingerprint('بِسْمِ رَبِّي')]]);
    const report = verifyCorpus([tampered], [surah(1, 1)], { scope: 'partial', expectedFingerprints: digest });
    const drift = report.issues.find((i) => i.code === 'text-drift');
    expect(drift?.subject).toBe('1:1');
    expect(report.ok).toBe(false);
  });

  it('detects a corrupted stored fingerprint', () => {
    const broken = { ...clean[0]!, normalizedHash: 'deadbeefdeadbeef' };
    const report = verifyCorpus([broken], [surah(1, 1)], { scope: 'partial' });
    expect(report.issues.find((i) => i.code === 'fingerprint')?.subject).toBe('1:1');
    expect(report.ok).toBe(false);
  });

  it('warns when stored word count disagrees with the tokeniser', () => {
    const miscounted = { ...clean[0]!, wordCount: 99 };
    const report = verifyCorpus([miscounted], [surah(1, 1)], { scope: 'partial' });
    const w = report.issues.find((i) => i.code === 'word-count');
    expect(w?.severity).toBe('warning');
    expect(report.ok).toBe(true);
  });

  it('flags a corpus that does not end at 114:6', () => {
    const report = verifyCorpus([ayah(114, 5, 'خ')], [surah(114, 1)]);
    expect(report.issues.find((i) => i.code === 'last-verse')?.detail).toContain('114:6');
  });

  it('flags surah metadata disagreeing with the corpus', () => {
    const report = verifyCorpus(clean, [surah(1, 9), surah(2, 3)]);
    const mismatch = report.issues.find((i) => i.code === 'surah-ayah-count');
    expect(mismatch?.subject).toBe('surah 1');
    expect(mismatch?.detail).toContain('metadata says 9');
  });
});

describe('verifyPageMonotonicity', () => {
  it('accepts pages that only move forward', () => {
    const paged = clean.map((a, i) => ({ ...a, page: 1 + Math.floor(i / 2) }));
    expect(verifyPageMonotonicity(paged)).toEqual([]);
  });

  it('warns when a later ayah sits on an earlier page', () => {
    const paged = [
      { ...clean[0]!, page: 5 },
      { ...clean[1]!, page: 3 },
    ];
    const issues = verifyPageMonotonicity(paged);
    expect(issues[0]?.code).toBe('page-backwards');
    expect(issues[0]?.severity).toBe('warning');
  });
});

describe('fixture sanity', () => {
  it('tokenises the fixture texts into the word counts the fixtures claim', () => {
    for (const a of clean) {
      expect(a.wordCount).toBe(tokenizeWords(a.textUthmani).length);
    }
  });
});
