/**
 * The shared matching space — the single normalisation both sides of a search
 * comparison use.
 *
 * These tests exist because the shipped path did NOT have one: the query was
 * normalised and the stored translation columns were not, so a Persian query
 * for `آتش` (normalised to `اتش`) could not match the stored `آتش`, and an
 * Arabic query pasted from the mushaf was shattered into single letters because
 * the pre-clean treated combining harakat as separators. Every case below is a
 * real string from the bundled packs or the bundled Uthmani text.
 */

import { describe, expect, it } from 'vitest';
import {
  MATCH_FIELD_PRIORITY,
  SEARCH_INDEX_KEY_VERSION,
  compareMatchedHits,
  matchKey,
  matchTokens,
} from '../../src/search/index';

describe('matchKey — one normalisation for every searchable column', () => {
  it('is the core normalisation of the word stream, lowercased', () => {
    expect(matchKey('بِسْمِ ٱللَّهِ ٱلرَّحْمَـٰنِ ٱلرَّحِيمِ')).toBe('بسم الله الرحمن الرحيم');
  });

  it('folds the Persian letters a keyboard produces for an Arabic one', () => {
    expect(matchKey('آتش')).toBe('اتش'); // initial madda alef
    expect(matchKey('روزى')).toBe('روزي'); // alef maqsura
    expect(matchKey('کیفر')).toBe('كيفر'); // Persian kehef → Arabic kaf, Persian ye → yeh
  });

  it('keeps the letters only Persian uses, and folds the one letter the two scripts split', () => {
    expect(matchKey('نمازهای')).toBe('نمازهاي'); // پ چ ژ گ survive; ی folds onto ي
    expect(matchKey('بخشنده')).toBe('بخشنده');
    expect(matchKey('پرهیزگاری')).toBe('پرهيزگاري');
  });

  it('makes a Persian-typed ye find the Arabic-script spelling of the same letter', () => {
    // The packs write `دین`, the mushaf writes `دين`; one key for both.
    expect(matchKey('دین')).toBe(matchKey('دين'));
  });

  it('removes ZWNJ so a compound word is one run of letters on both sides', () => {
    expect(matchKey('خانه‌ای')).toBe('خانهاي');
    expect(matchKey('نعمت‌های')).toBe('نعمتهاي');
  });

  it('is idempotent — re-keying stored index text cannot drift', () => {
    for (const text of [
      'بِسْمِ ٱللَّهِ ٱلرَّحْمَـٰنِ ٱلرَّحِيمِ',
      'به نام خداوند بخشنده مهربان',
      'In the name of Allah, the Entirely Merciful',
      'خانه‌ای که [و سپاس‌ها] از آنِ الله است',
    ]) {
      expect(matchKey(matchKey(text))).toBe(matchKey(text));
    }
  });

  it('produces tokens that are safe to paste into an unescaped LIKE pattern', () => {
    // `%` and `_` are LIKE wildcards; `\p{P}`/`\p{S}` are dropped by
    // `normalizeWord`, so no token of a query can ever contain one.
    const tokens = matchTokens('50% off_a_verse!! (رحمن) — "بخشنده"');
    expect(tokens.join(' ')).not.toMatch(/[%_]/);
  });
});

describe('matchTokens — the query in the index space', () => {
  it('keeps diacritic Arabic in one piece instead of shattering it', () => {
    expect(matchTokens('بِسْمِ ٱللَّهِ ٱلرَّحْمَـٰنِ ٱلرَّحِيمِ')).toEqual([
      'بسم',
      'الله',
      'الرحمن',
      'الرحيم',
    ]);
  });

  it('splits Persian on spaces and drops punctuation, diacritics included', () => {
    expect(matchTokens('به نامِ خداوند، بخشندهٔ مهربان')).toEqual(['به', 'نام', 'خداوند', 'بخشنده', 'مهربان']);
  });

  it('treats a Latin query case-insensitively', () => {
    expect(matchTokens('Mercy of your LORD')).toEqual(['mercy', 'of', 'your', 'lord']);
  });

  it('returns nothing for punctuation-only input', () => {
    expect(matchTokens('   ،؛—‍  ')).toEqual([]);
  });

  it('matches the column text the way the shipped path compares them', () => {
    const column = matchKey('إِنَّ الَّذِينَ كَفَرُوا سَوَاءٌ عَلَيْهِمْ أَأَنذَرْتَهُمْ');
    for (const token of matchTokens('كَفَرُوا')) expect(column.includes(token)).toBe(true);
  });

  it('documents the defect this replaced: a normalised query against raw text', () => {
    const storedRawText = 'وَالَّذِينَ آمَنُوا بِمَا أَنْزَلَ إِلَى مُحَمَّدٍ' + ' ' + 'آتش';
    const queryToken = matchTokens('آتش')[0]!;
    // The old index stored translation text as-is; this is why Persian search
    // returned zero. Kept as a test so nobody "optimises" the key away.
    expect(storedRawText.includes(queryToken)).toBe(false);
    expect(matchKey(storedRawText).includes(queryToken)).toBe(true);
  });
});

describe('the merged ordering', () => {
  it('is the documented field priority', () => {
    expect([...MATCH_FIELD_PRIORITY]).toEqual(['arabic', 'translation-fa', 'translation-en']);
  });

  it('puts a mushaf-text hit above a translation hit for the same verse', () => {
    const hits = [
      { field: 'translation-fa' as const, chapter: 1, verse: 1 },
      { field: 'arabic' as const, chapter: 9, verse: 1 },
    ];
    expect(hits.sort(compareMatchedHits).map((h) => h.field)).toEqual(['arabic', 'translation-fa']);
  });

  it('uses bm25 only inside the Arabic group, then mushaf order', () => {
    const hits = [
      { field: 'arabic' as const, bm25: -1, chapter: 5, verse: 1 },
      { field: 'arabic' as const, bm25: -9, chapter: 2, verse: 3 },
      { field: 'arabic' as const, bm25: -9, chapter: 2, verse: 4 },
      { field: 'translation-en' as const, chapter: 1, verse: 1 },
    ];
    expect(hits.sort(compareMatchedHits).map((h) => `${h.chapter}:${h.verse}`)).toEqual([
      '2:3',
      '2:4',
      '5:1',
      '1:1',
    ]);
  });

  it('is stable without a rank at all', () => {
    const hits = [
      { field: 'translation-fa' as const, chapter: 2, verse: 1 },
      { field: 'translation-fa' as const, chapter: 1, verse: 7 },
    ];
    expect(hits.sort(compareMatchedHits).map((h) => `${h.chapter}:${h.verse}`)).toEqual(['1:7', '2:1']);
  });
});

describe('the index version marker', () => {
  it('is 2 — every column keyed, not Arabic only', () => {
    expect(SEARCH_INDEX_KEY_VERSION).toBe(2);
  });
});
