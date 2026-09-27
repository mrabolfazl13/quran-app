import { describe, expect, it } from 'vitest';
import {
  editDistance,
  isRtl,
  normalizeWord,
  normalizedFingerprint,
  normalizedText,
  searchKey,
  setSimilarity,
  tokenSimilarity,
  tokenizeWords,
  wordCount,
} from '../../src/normalize/arabic';

/**
 * The normalisation layer defines "the same word" for the memory engine, the
 * search index and content integrity. These cases are the contract: real
 * Uthmani strings, copied verbatim from the Quran.com payloads.
 */
describe('normalizeWord', () => {
  it('strips harakat, madd and sukun', () => {
    expect(normalizeWord('بِسْمِ')).toBe('بسم');
    expect(normalizeWord('ٱللَّهِ')).toBe('الله');
    expect(normalizeWord('لِلَّهِ')).toBe('لله');
    expect(normalizeWord('مِنَ')).toBe('من');
  });

  it('unifies the alef family', () => {
    const forms = ['أَللهُ', 'إِلٰهٌ', 'ٱللَّهُ', 'آدَمَ', 'ٱهْدِنَا'];
    const keys = forms.map((f) => normalizeWord(f));
    expect(keys.every((k) => !/[أإآٱ]/.test(k))).toBe(true);
    expect(normalizeWord('أَحَدٌ')).toBe('احد');
    expect(normalizeWord('إِحْسانٌ')).toBe('احسان');
    expect(normalizeWord('آدم')).toBe('ادم');
  });

  it('folds ta marbuta, ya and Persian keystrokes to the same key', () => {
    expect(normalizeWord('مَلَكَة')).toBe('ملكه');
    expect(normalizeWord('الصلاة')).toBe('الصلاه');
    expect(normalizeWord('عَلَىٰ')).toBe('علي');
    expect(normalizeWord('کَفَوًا')).toBe('كفوا');
  });

  it('removes tatweel and annotation marks', () => {
    expect(normalizeWord('ٱلرَّحْمَـٰنِ')).toBe('الرحمن');
    expect(normalizeWord('اللهُ۩')).toBe('الله');
    expect(normalizeWord('مَنۖ')).toBe('من');
  });

  it('folds Arabic and Persian digits', () => {
    expect(normalizeWord('٣')).toBe('3');
    expect(normalizeWord('۱۲')).toBe('12');
  });

  it('returns empty string for punctuation-only or empty input', () => {
    expect(normalizeWord('')).toBe('');
    expect(normalizeWord(' ٰ  ّ ')).toBe('');
    expect(normalizeWord('-—*')).toBe('');
  });
});

describe('tokenizeWords', () => {
  it('splits on whitespace and drops empty tokens', () => {
    expect(tokenizeWords('  قُلْ   هُوَ  ٱللَّهُ  ')).toEqual(['قُلْ', 'هُوَ', 'ٱللَّهُ']);
  });

  it('drops standalone end-of-ayah ornamental marks', () => {
    const withMark = 'قُلْ هُوَ اللهُ اَحدٌ ۩';
    expect(tokenizeWords(withMark)).toHaveLength(4);
    expect(tokenizeWords(withMark).some((t) => t.includes('۩'))).toBe(false);
  });

  it('never yields an empty token', () => {
    for (const raw of ['', ' ', '  \t ', '۞']) {
      expect(tokenizeWords(raw).every((t) => t.length > 0)).toBe(true);
    }
  });
});

describe('normalizedText / wordCount / searchKey', () => {
  const ayah = 'بِسْمِ ٱللَّهِ ٱلرَّحْمَـٰنِ ٱلرَّحِيمِ';

  it('produces a space-joined diacritic-free form', () => {
    expect(normalizedText(ayah)).toBe('بسم الله الرحمن الرحيم');
  });

  it('counts words consistently with the tokeniser', () => {
    expect(wordCount(ayah)).toBe(4);
    expect(wordCount('لَمْ يَلِدْ وَلَمْ يُولَدْ')).toBe(4);
    expect(wordCount('')).toBe(0);
  });

  it('searchKey is stable under diacritic and alef variation', () => {
    expect(searchKey('ٱللَّهِ')).toBe(searchKey('الله'));
    expect(searchKey('أَحَدٌ')).toBe(searchKey('احد'));
    expect(searchKey('الرَّحْمَـٰنِ')).toBe('الرحمن');
  });

  it('is idempotent: normalising twice changes nothing', () => {
    const once = normalizedText(ayah);
    expect(normalizedText(once)).toBe(once);
    for (const w of tokenizeWords(ayah)) {
      const n = normalizeWord(w);
      expect(normalizeWord(n)).toBe(n);
    }
  });
});

describe('normalizedFingerprint', () => {
  it('ignores diacritics but respects letter identity', () => {
    expect(normalizedFingerprint('بِسْمِ ٱللَّهِ')).toBe(normalizedFingerprint('بسم الله'));
    expect(normalizedFingerprint('بسم الله')).not.toBe(normalizedFingerprint('بسم اللها'));
  });

  it('is order sensitive', () => {
    expect(normalizedFingerprint('قُلْ هُوَ')).not.toBe(normalizedFingerprint('هُوَ قُلْ'));
  });

  it('is a 16 hex char digest, deterministic across calls', () => {
    const a = normalizedFingerprint('ٱللَّهُ ٱلصَّمَدُ');
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).toBe(normalizedFingerprint('ٱللَّهُ ٱلصَّمَدُ'));
  });
});

describe('editDistance and similarity', () => {
  it('computes classic distances', () => {
    expect(editDistance([], [])).toBe(0);
    expect(editDistance(['a'], [])).toBe(1);
    expect(editDistance([], ['a', 'b'])).toBe(2);
    expect(editDistance(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(0);
    expect(editDistance([...'kitten'], [...'sitting'])).toBe(3);
    expect(editDistance(['لم', 'يلد', 'ولم', 'يولد'], ['ولم', 'يولد', 'لم', 'يلد'])).toBe(4);
    expect(editDistance(['ا', 'ب', 'ج'], ['ا', 'ب', 'د'])).toBe(1);
    expect(editDistance(['a', 'b', 'c'], ['c', 'b', 'a'])).toBe(2);
  });

  it('tokenSimilarity is 1 only for identical sequences', () => {
    expect(tokenSimilarity(['بسم', 'الله'], ['بسم', 'الله'])).toBe(1);
    expect(tokenSimilarity(['بسم', 'الله'], ['بسم'])).toBe(0.5);
    expect(tokenSimilarity([], [])).toBe(1);
  });

  it('setSimilarity ignores order and repetition', () => {
    expect(setSimilarity(['لم', 'يلد', 'ولم', 'يولد'], ['ولم', 'يولد', 'لم', 'يلد'])).toBe(1);
    expect(setSimilarity(['ا', 'ب'], ['ا', 'ب', 'ج'])).toBeCloseTo(2 / 3);
    expect(setSimilarity([], ['ا'])).toBe(0);
  });
});

describe('isRtl', () => {
  it('detects Arabic and Persian', () => {
    expect(isRtl('قل هو الله أحد')).toBe(true);
    expect(isRtl('به نام خدا')).toBe(true);
  });

  it('detects Latin and reports neutral strings as LTR so callers use the base direction', () => {
    expect(isRtl('Ayah text')).toBe(false);
    expect(isRtl('123 456')).toBe(false);
    expect(isRtl('')).toBe(false);
  });
});
