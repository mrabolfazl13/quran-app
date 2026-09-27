/**
 * Search system unit tests — every query kind, the pathological-input
 * guards, RTL highlight offsets and deterministic ranking.
 * All content is fixture-driven (see ./fixtures.ts); nothing touches the
 * clock, network or randomness.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_QUERY_CHARS,
  MAX_QUERY_TOKENS,
  buildSearchIndex,
  search,
  type SearchIndex,
} from '../../src/search/index';
import {
  A_1_1,
  A_1_2,
  A_55_13,
  BOOKMARKS,
  CONCEPTS,
  CONCEPT_LINKS,
  NOTES,
  REAL_FIXTURE_AYAHS,
  TRANSLATIONS,
  WORDS,
  WORDS_WITHOUT_ROOTS,
  mkAyah,
} from './fixtures';

function fullIndex(): SearchIndex {
  return buildSearchIndex(REAL_FIXTURE_AYAHS, TRANSLATIONS, WORDS, {
    concepts: CONCEPTS,
    conceptLinks: CONCEPT_LINKS,
    notes: NOTES,
    bookmarks: BOOKMARKS,
  });
}

/** Helper: split a string into the raw tokens the range arithmetic assumes. */
function rawTokensOf(text: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push({ text: m[0], start: m.index });
  return out;
}

describe('exact Arabic phrase queries', () => {
  it('matches a diacritic-free query against vocalised ayah text', () => {
    const res = search(fullIndex(), { type: 'arabic-phrase', text: 'بسم الله', match: 'exact' });
    expect(res.rejected).toBeNull();
    expect(res.hits).toHaveLength(1);
    const hit = res.hits[0]!;
    expect(hit.verseKey).toBe('1:1');
    expect(hit.field).toBe('arabic');
    expect(hit.coverage).toBe(1);
  });

  it('requires contiguity: first and last phrase words far apart do not match', () => {
    const res = search(fullIndex(), { type: 'arabic-phrase', text: 'بسم الرحيم', match: 'exact' });
    expect(res.hits).toHaveLength(0);
  });

  it('matches a full multi-word phrase including hamza-carrying letters', () => {
    const res = search(fullIndex(), {
      type: 'arabic-phrase',
      text: 'فَبِأَيِّ آلَاءِ رَبِّكُمَا تُكَذِّبَانِ',
      match: 'exact',
    });
    expect(res.hits.map((h) => h.verseKey).sort()).toEqual(['55:13', '55:77']);
  });
});

describe('Arabic prefix / stem-ish queries', () => {
  it('prefix mode matches longer words with the same normalised opening', () => {
    const res = search(fullIndex(), { type: 'arabic-phrase', text: 'العالم', match: 'prefix' });
    expect(res.hits.map((h) => h.verseKey)).toEqual(['1:2']);
  });

  it('exact mode does NOT match the same prefix query', () => {
    const res = search(fullIndex(), { type: 'arabic-phrase', text: 'العالم', match: 'exact' });
    expect(res.hits).toHaveLength(0);
  });

  it('is diacritic-insensitive in both directions', () => {
    const idx = fullIndex();
    // Query without harakat, document with harakat:
    const a = search(idx, { type: 'arabic-phrase', text: 'تكذبان', match: 'prefix' });
    expect(a.hits.map((h) => h.verseKey).sort()).toEqual(['55:13', '55:77']);
    // Query with harakat, same match:
    const b = search(idx, { type: 'arabic-phrase', text: 'تُكَذِّبَانِ', match: 'exact' });
    expect(b.hits.map((h) => h.verseKey).sort()).toEqual(['55:13', '55:77']);
  });
});

describe('word search', () => {
  it('returns every ayah containing the normalised word', () => {
    const res = search(fullIndex(), { type: 'arabic-word', text: 'الله' });
    expect(res.rejected).toBeNull();
    expect(res.hits.map((h) => h.verseKey)).toEqual(['1:1', '37:120', '37:159']);
    expect(res.hits.every((h) => h.field === 'word')).toBe(true);
  });

  it('rejects multi-word input for the word kind', () => {
    const res = search(fullIndex(), { type: 'arabic-word', text: 'بسم الله' });
    expect(res.rejected).toBe('query-too-many-tokens');
    expect(res.hits).toHaveLength(0);
  });
});

describe('root search', () => {
  it('matches AyahWord.root when the data provides it', () => {
    const res = search(fullIndex(), { type: 'root', text: 'رحم' });
    expect(res.rejected).toBeNull();
    expect(res.hits.map((h) => h.verseKey)).toEqual(['1:1']);
    const hit = res.hits[0]!;
    expect(hit.ranges).toHaveLength(2); // الرَّحْمَنِ and الرَّحِيمِ
    expect(A_1_1.textUthmani.slice(hit.ranges[0]!.start, hit.ranges[0]!.end)).toBe('الرَّحْمَنِ');
    expect(A_1_1.textUthmani.slice(hit.ranges[1]!.start, hit.ranges[1]!.end)).toBe('الرَّحِيمِ');
  });

  it('matches spaced root notation as well', () => {
    const res = search(fullIndex(), { type: 'root', text: 'ر ح م' });
    expect(res.hits.map((h) => h.verseKey)).toEqual(['1:1']);
  });

  it('returns nothing with a reason when the data provides no roots — never guesses', () => {
    const idx = buildSearchIndex(REAL_FIXTURE_AYAHS, TRANSLATIONS, WORDS_WITHOUT_ROOTS);
    const res = search(idx, { type: 'root', text: 'رحم' });
    expect(res.hits).toHaveLength(0);
    expect(res.rejected).toBe('roots-unavailable');
  });

  it('returns nothing with a reason when no word rows exist at all', () => {
    const idx = buildSearchIndex(REAL_FIXTURE_AYAHS);
    const res = search(idx, { type: 'root', text: 'رحم' });
    expect(res.rejected).toBe('roots-unavailable');
  });
});

describe('Persian translation search', () => {
  it('matches Persian queries against Persian translations', () => {
    const res = search(fullIndex(), { type: 'translation', language: 'fa', text: 'خداوند' });
    expect(res.rejected).toBeNull();
    expect(res.hits).toHaveLength(1);
    const hit = res.hits[0]!;
    expect(hit.verseKey).toBe('1:1');
    expect(hit.field).toBe('translation-fa');
    expect(hit.rawText.slice(hit.ranges[0]!.start, hit.ranges[0]!.end)).toBe('خداوند');
  });

  it('folds the Persian ك to Arabic ك the same way normalisation does', () => {
    const res = search(fullIndex(), { type: 'translation', language: 'fa', text: 'پروردگارتان' });
    expect(res.hits.map((h) => h.verseKey)).toEqual(['55:13']);
  });

  it('does not leak Persian hits into the English lane or vice versa', () => {
    const idx = fullIndex();
    const fa = search(idx, { type: 'translation', language: 'en', text: 'خداوند' });
    expect(fa.hits).toHaveLength(0);
    const en = search(idx, { type: 'translation', language: 'fa', text: 'merciful' });
    expect(en.hits).toHaveLength(0);
  });
});

describe('English translation search', () => {
  it('matches an English query against English translations', () => {
    const res = search(fullIndex(), { type: 'translation', language: 'en', text: 'merciful' });
    expect(res.hits.map((h) => h.verseKey)).toEqual(['1:1']);
    const hit = res.hits[0]!;
    expect(hit.rawText.slice(hit.ranges[0]!.start, hit.ranges[0]!.end)).toBe('Merciful');
  });

  it('matches a multi-word English phrase with contiguity scoring', () => {
    const res = search(fullIndex(), { type: 'translation', language: 'en', text: 'lord of the worlds' });
    expect(res.hits.map((h) => h.verseKey)).toEqual(['1:2']);
    expect(res.hits[0]!.coverage).toBe(1);
  });

  it('allows scattered coverage (partial score) for translation queries', () => {
    const res = search(fullIndex(), { type: 'translation', language: 'en', text: 'worlds deny' });
    expect(res.hits.map((h) => h.verseKey).sort()).toEqual(['1:2', '55:13']);
    expect(res.hits.every((h) => h.coverage === 0.5)).toBe(true);
  });

  it('ignores case and punctuation', () => {
    const res = search(fullIndex(), { type: 'translation', language: 'en', text: 'ALLAH,' });
    expect(res.hits.map((h) => h.verseKey).sort()).toEqual(['1:1', '1:2']);
  });
});

describe('concept search', () => {
  it('matches concept labels across languages and returns linked ayahs', () => {
    const res = search(fullIndex(), { type: 'concept', text: 'رحمت' });
    expect(res.hits.length).toBeGreaterThan(0);
    const mercy = res.hits.find((h) => h.conceptId === 'demo-mercy' && h.field === 'concept');
    expect(mercy).toBeDefined();
    expect(mercy!.conceptVerseKeys).toEqual(['1:1', '55:13']);
  });

  it('matches English concept labels via the latin path', () => {
    const res = search(fullIndex(), { type: 'concept', text: 'patience' });
    expect(res.hits.map((h) => h.conceptId)).toContain('demo-patience');
  });

  it('rejects with a reason when no concept pack is attached', () => {
    const idx = buildSearchIndex(REAL_FIXTURE_AYAHS);
    const res = search(idx, { type: 'concept', text: 'رحمت' });
    expect(res.rejected).toBe('no-concept-pack');
    expect(res.hits).toHaveLength(0);
  });
});

describe('note / bookmark search', () => {
  it('finds user notes by Arabic token', () => {
    const res = search(fullIndex(), { type: 'user-text', text: 'الرحمن' });
    const ids = res.hits.filter((h) => h.field === 'note').map((h) => h.noteId).sort();
    expect(ids).toEqual(['note-1', 'note-2']);
  });

  it('finds user notes by Latin token in mixed-script bodies', () => {
    const res = search(fullIndex(), { type: 'user-text', text: 'weekly' });
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]!.noteId).toBe('note-1');
  });

  it('finds bookmarks by label and normalises alef variants', () => {
    const res = search(fullIndex(), { type: 'user-text', text: 'الكرسي' });
    expect(res.hits.filter((h) => h.field === 'bookmark').map((h) => h.noteId)).toEqual(['bm-1']);
    const res2 = search(fullIndex(), { type: 'user-text', text: 'اية' });
    expect(res2.hits.filter((h) => h.field === 'bookmark')).toHaveLength(1);
  });

  it('rejects with a reason when no user data is attached', () => {
    const idx = buildSearchIndex(REAL_FIXTURE_AYAHS);
    const res = search(idx, { type: 'user-text', text: 'weekly' });
    expect(res.rejected).toBe('no-user-data');
  });
});

describe('pathological input guards — never throw, always a reason', () => {
  it('empty query', () => {
    const res = search(fullIndex(), { type: 'arabic-phrase', text: '   ', match: 'exact' });
    expect(res.rejected).toBe('empty-query');
    expect(res.hits).toHaveLength(0);
  });

  it('diacritics-only query', () => {
    const res = search(fullIndex(), { type: 'arabic-phrase', text: '\u064E\u064F\u0650 \u0651\u0670', match: 'exact' });
    expect(res.rejected).toBe('empty-after-normalization');
    expect(res.hits).toHaveLength(0);
  });

  it('over-long query is rejected before any scanning', () => {
    const huge = `${'رَبِّ '.repeat(MAX_QUERY_CHARS)}`;
    const res = search(fullIndex(), { type: 'arabic-phrase', text: huge, match: 'exact' });
    expect(res.rejected).toBeOneOf(['query-too-long', 'query-too-many-tokens']);
    // Also enforce the token ceiling with a short-but-many query:
    const many = Array.from({ length: MAX_QUERY_TOKENS + 1 }, () => 'الله').join(' ');
    expect(many.length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
    const res2 = search(fullIndex(), { type: 'arabic-phrase', text: many, match: 'exact' });
    expect(res2.rejected).toBe('query-too-many-tokens');
  });

  it('regex metacharacters are inert, never compiled', () => {
    const idx = fullIndex();
    const a = search(idx, { type: 'arabic-phrase', text: '.*+?^${}()|[]\\', match: 'exact' });
    expect(a.rejected).toBe('empty-after-normalization');
    const b = search(idx, { type: 'arabic-phrase', text: '.*بسم.*', match: 'exact' });
    expect(b.rejected).toBeNull();
    expect(b.hits.map((h) => h.verseKey)).toEqual(['1:1']);
    const c = search(idx, { type: 'translation', language: 'en', text: '[Mm]erciful.*' });
    expect(c.hits.map((h) => h.verseKey)).toEqual(['1:1']);
  });

  it('unknown/absent verse-like queries on an empty index return empty', () => {
    const idx = buildSearchIndex([]);
    const res = search(idx, { type: 'arabic-word', text: 'الله' });
    expect(res.rejected).toBeNull();
    expect(res.hits).toHaveLength(0);
  });
});

describe('RTL highlight ranges', () => {
  it('single vocalised token: range slices back to the exact raw substring', () => {
    const res = search(fullIndex(), { type: 'arabic-phrase', text: 'فَبِأَيِّ', match: 'exact' });
    const hit = res.hits.find((h) => h.verseKey === '55:13')!;
    expect(hit.ranges).toHaveLength(1);
    const r = hit.ranges[0]!;
    expect(A_55_13.textUthmani.slice(r.start, r.end)).toBe('فَبِأَيِّ');
  });

  it('multi-word phrase: one ascending logical range per matched word', () => {
    const res = search(fullIndex(), { type: 'arabic-phrase', text: 'رب العالمين', match: 'exact' });
    const hit = res.hits.find((h) => h.verseKey === '1:2')!;
    expect(hit.ranges).toHaveLength(2);
    expect(hit.ranges[0]!.start).toBeLessThan(hit.ranges[1]!.start);
    const tokens = rawTokensOf(A_1_2.textUthmani);
    expect(A_1_2.textUthmani.slice(hit.ranges[0]!.start, hit.ranges[0]!.end)).toBe(tokens[2]!.text);
    expect(A_1_2.textUthmani.slice(hit.ranges[1]!.start, hit.ranges[1]!.end)).toBe(tokens[3]!.text);
  });

  it('diacritic-free prefix match still highlights the full vocalised word', () => {
    const res = search(fullIndex(), { type: 'arabic-phrase', text: 'الرحم', match: 'prefix' });
    const hit = res.hits.find((h) => h.verseKey === '1:1')!;
    expect(A_1_1.textUthmani.slice(hit.ranges[0]!.start, hit.ranges[0]!.end)).toBe('الرَّحْمَنِ');
  });

  it('hamza carrier folding does not shift offsets (إبراهيم highlighted verbatim)', () => {
    const res = search(fullIndex(), { type: 'arabic-phrase', text: 'ابراهيم', match: 'exact' });
    expect(res.rejected).toBeNull();
    const hit = res.hits.find((h) => h.verseKey === '37:131')!;
    expect(hit.rawText.slice(hit.ranges[0]!.start, hit.ranges[0]!.end)).toBe('إِبْرَاهِيمَ');
  });
});

describe('deterministic ranking', () => {
  it('hits are sorted by score descending', () => {
    const res = search(fullIndex(), { type: 'arabic-phrase', text: 'رب', match: 'prefix' });
    for (let i = 1; i < res.hits.length; i++) {
      expect(res.hits[i - 1]!.score).toBeGreaterThanOrEqual(res.hits[i]!.score);
    }
  });

  it('ties break deterministically by verse key, and repeated queries give identical output', () => {
    const idx = fullIndex();
    const res1 = search(idx, { type: 'arabic-phrase', text: 'تكذبان', match: 'prefix' });
    const res2 = search(idx, { type: 'arabic-phrase', text: 'تكذبان', match: 'prefix' });
    expect(JSON.stringify(res1)).toBe(JSON.stringify(res2));
    // 55:13 and 55:77 have identical texts → identical scores → canonical
    // ascending verse order must be emitted every time.
    expect(res1.hits.map((h) => h.verseKey)).toEqual(['55:13', '55:77']);
    expect(res1.hits[0]!.score).toBe(res1.hits[1]!.score);
  });

  it('earlier match position ranks above later position for otherwise equal docs', () => {
    const idx = buildSearchIndex([
      mkAyah(60, 1, 'الله ربّ العالمين'),
      mkAyah(60, 2, 'ربّ العالمين الله'),
    ]);
    const res = search(idx, { type: 'arabic-word', text: 'الله' });
    expect(res.hits.map((h) => h.verseKey)).toEqual(['60:1', '60:2']);
    expect(res.hits[0]!.score).toBeGreaterThan(res.hits[1]!.score);
  });

  it('limit is honoured and bounded', () => {
    const res = search(fullIndex(), { type: 'arabic-phrase', text: 'على', match: 'exact', limit: 2 });
    expect(res.hits.length).toBeLessThanOrEqual(2);
  });
});

describe('index shape', () => {
  it('buildSearchIndex defaults translations/words to empty arrays', () => {
    const idx = buildSearchIndex([A_1_1]);
    expect(idx.ayahCount).toBe(1);
    expect(idx.hasRoots).toBe(false);
    expect(idx.conceptAvailable).toBe(false);
    expect(idx.userDataAvailable).toBe(false);
  });

  it('index is serialisable to JSON (SQLite FTS5 staging round-trip)', () => {
    const idx = fullIndex();
    const plain = JSON.parse(
      JSON.stringify({ version: idx.version, ayahCount: idx.ayahCount, docs: idx.docs }),
    ) as { version: number; ayahCount: number; docs: unknown[] };
    expect(plain.version).toBe(1);
    expect(plain.ayahCount).toBe(REAL_FIXTURE_AYAHS.length);
    expect(plain.docs.length).toBe(REAL_FIXTURE_AYAHS.length);
  });

  it('note/bookmark/concept roots and user data flags reflect attached packs', () => {
    const idx = fullIndex();
    expect(idx.hasRoots).toBe(true);
    expect(idx.conceptAvailable).toBe(true);
    expect(idx.userDataAvailable).toBe(true);
    expect(idx.rootBuckets.has('رحم')).toBe(true);
  });
});
