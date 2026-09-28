/**
 * Integration: `verifyCorpus` over rows that live in a real SQLite file.
 *
 * `core/src/integrity/verify.ts` is pure — it takes arrays. The unit tests feed
 * it arrays; that proves the arithmetic but not the thing that actually breaks
 * in the field: the same corpus read back out of `ayah` with `ORDER BY chapter,
 * verse` through `node:sqlite`. Character set, column order, `NULL` vs absent,
 * and the derived `word_count` / `normalized_hash` columns all sit in between,
 * and a mushaf that verifies in memory and fails on disk is exactly the failure
 * the release gate has to catch.
 *
 * Two corpora are used deliberately:
 *   • the 31-ayah fixture, which is a *sample* and must therefore FAIL the
 *     contiguity check (asserted, not excused — see the chapter 1 case), and
 *   • the whole 6 236-ayah mushaf from the provider captures, which is the only
 *     data `scope: 'full'` is meaningful for.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORPUS_EXPECT, verifyCorpus, verifyPageMonotonicity } from '../../core/src/integrity/verify';
import { normalizedFingerprint } from '../../core/src/normalize/arabic';
import {
  createFixtureDb,
  createTempDb,
  insertAyah,
  isForeignKeyFailure,
  readAyahs,
  readSurahs,
  type TestHandle,
} from '../helpers/db';
import { createFullCorpusDb, fullCorpus, fullTranslationRows } from '../helpers/fullcorpus';
import { fixtureAyahs, fixtureChapters } from '../helpers/corpus';

/** Hook budget: the full mushaf is 6 236 ayahs plus 12 472 translation rows. */
const BUILD_TIMEOUT = 240_000;

function subjectsOf(report: { issues: { code: string; subject: string }[] }, code: string): string[] {
  return report.issues.filter((i) => i.code === code).map((i) => i.subject);
}

/** Run a statement that is expected to throw, and hand back the error. */
function capture(fn: () => void): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

describe('integrity over stored rows: the whole mushaf', () => {
  let h: TestHandle;

  beforeAll(() => {
    h = createFullCorpusDb(createTempDb({ name: 'full' }), { translations: [85, 135] });
  }, BUILD_TIMEOUT);

  afterAll(() => h?.dispose());

  it('stores exactly the corpus the contract expects', () => {
    expect(h.count('ayah')).toBe(CORPUS_EXPECT.ayahs);
    expect(h.count('surah')).toBe(CORPUS_EXPECT.surahs);
    expect(
      h.get<{ verse_key: string }>('SELECT verse_key FROM ayah ORDER BY chapter DESC, verse DESC LIMIT 1')
        ?.verse_key,
    ).toBe(CORPUS_EXPECT.lastVerseKey);
    expect(
      h.get<{ verse_key: string }>('SELECT verse_key FROM ayah ORDER BY chapter, verse LIMIT 1')?.verse_key,
    ).toBe('1:1');
  });

  it('verifies ok from disk, with the row counts SQLite actually reports', () => {
    const report = verifyCorpus(readAyahs(h), readSurahs(h), { scope: 'full' });
    expect(report.checkedAyahs).toBe(CORPUS_EXPECT.ayahs);
    expect(report.checkedSurahs).toBe(CORPUS_EXPECT.surahs);
    // The issue list is compared to [] rather than summarised into `ok`, so a
    // warning shows up in the failure output instead of hiding behind a pass.
    expect(
      report.issues.map((i) => `${i.severity}/${i.code}/${i.subject}: ${i.detail}`).slice(0, 12),
    ).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('keeps the derived columns honest across all 6 236 rows, not just a spot check', () => {
    const ayahs = readAyahs(h);
    const badHash = ayahs.filter((a) => a.normalizedHash !== normalizedFingerprint(a.textUthmani));
    expect(badHash.map((a) => a.verseKey)).toEqual([]);
    // `word-count` is only a warning inside verifyCorpus, so a corpus full of
    // wrong word counts would still report ok: true. Assert it directly.
    expect(subjectsOf(verifyCorpus(ayahs, readSurahs(h), { scope: 'full' }), 'word-count')).toEqual([]);
  });

  it('has no page that runs backwards (the mushaf layout invariant)', () => {
    expect(verifyPageMonotonicity(readAyahs(h))).toEqual([]);
  });

  it('agrees with the digest the pipeline published, verse by verse', () => {
    const packMap = new Map(fullCorpus().ayahs.map((a) => [a.verseKey, normalizedFingerprint(a.textUthmani)]));
    const report = verifyCorpus(readAyahs(h), readSurahs(h), { scope: 'full', expectedFingerprints: packMap });
    expect(report.ok).toBe(true);
    expect(subjectsOf(report, 'missing-in-pack')).toEqual([]);
    expect(subjectsOf(report, 'text-drift')).toEqual([]);
  });

  describe('a corrupted stored row is reported by its exact verse key', () => {
    const VERSE = '55:13';
    const pristine = () => {
      const row = fullCorpus().ayahs.find((a) => a.verseKey === VERSE);
      if (!row) throw new Error(`the corpus has no ${VERSE} — the captures moved`);
      return row;
    };

    /**
     * Put the row back from the authoritative in-memory corpus.
     *
     * `translation.verse_key` is a RESTRICT foreign key on purpose (the case
     * below proves SQLite enforces it), so a re-import has to clear dependants
     * before the ayah itself and put them back afterwards. `translation` is the
     * only content table this database loads; if `words` or `tafsirs` are ever
     * turned on for this suite, this function has to clear those too.
     */
    function repair(): void {
      const dependants = h.all<{ pack_id: string; text: string }>(
        'SELECT pack_id, text FROM translation WHERE verse_key = ?',
        [VERSE],
      );
      h.run('DELETE FROM translation WHERE verse_key = ?', [VERSE]);
      h.run('DELETE FROM ayah WHERE verse_key = ?', [VERSE]);
      insertAyah(h, pristine());
      for (const d of dependants) {
        h.run('INSERT INTO translation (verse_key, pack_id, text) VALUES (?,?,?)', [VERSE, d.pack_id, d.text]);
      }
    }

    it('names the verse when its text is edited after import', () => {
      h.run('UPDATE ayah SET text_uthmani = ? WHERE verse_key = ?', ['بِسْمِ ٱللَّهِ', VERSE]);
      const report = verifyCorpus(readAyahs(h), readSurahs(h), { scope: 'full' });
      expect(report.ok).toBe(false);
      expect(subjectsOf(report, 'fingerprint')).toEqual([VERSE]);
      const print = report.issues.find((i) => i.code === 'fingerprint')!;
      expect(print.severity).toBe('fatal');
      // The detail carries both digests: "which one is wrong" is the question
      // an operator has to answer.
      expect(print.detail).toContain('stored');
      expect(print.detail).toContain('recomputed');
      repair();
      expect(verifyCorpus(readAyahs(h), readSurahs(h), { scope: 'full' }).ok).toBe(true);
    });

    it('only the pack digest catches text rewritten together with its own hash', () => {
      // A hand-edited row can be made internally consistent; that is precisely
      // why verifyCorpus takes `expectedFingerprints` from the pack.
      const forged = normalizedFingerprint('مُحَرَّفَة');
      h.run('UPDATE ayah SET text_uthmani = ?, normalized_hash = ? WHERE verse_key = ?', ['مُحَرَّفَة', forged, VERSE]);
      const internal = verifyCorpus(readAyahs(h), readSurahs(h), { scope: 'full' });
      expect(subjectsOf(internal, 'fingerprint')).toEqual([]);
      const packMap = new Map(fullCorpus().ayahs.map((a) => [a.verseKey, a.normalizedHash]));
      const againstPack = verifyCorpus(readAyahs(h), readSurahs(h), { scope: 'full', expectedFingerprints: packMap });
      expect(subjectsOf(againstPack, 'text-drift')).toEqual([VERSE]);
      expect(againstPack.ok).toBe(false);
      repair();
    });

    it('reports a blank authoritative text as fatal on that verse', () => {
      h.run('UPDATE ayah SET text_uthmani = ? WHERE verse_key = ?', ['', VERSE]);
      const report = verifyCorpus(readAyahs(h), readSurahs(h), { scope: 'full' });
      expect(subjectsOf(report, 'empty-text')).toEqual([VERSE]);
      expect(report.ok).toBe(false);
      repair();
    });

    it('reports a division value out of range on that verse', () => {
      h.run('UPDATE ayah SET juz = ? WHERE verse_key = ?', [CORPUS_EXPECT.juz + 1, VERSE]);
      expect(subjectsOf(verifyCorpus(readAyahs(h), readSurahs(h), { scope: 'full' }), 'juz-range')).toEqual([VERSE]);
      repair();
    });

    it('reports a surah whose stored verses no longer match its declared count', () => {
      // SQLite will not let a verse vanish while its translations still point
      // at it — the content tables have the same FK discipline as the user
      // tables, and a targeted re-import has to delete dependants first.
      const blocked = capture(() => h.run('DELETE FROM ayah WHERE verse_key = ?', [VERSE]));
      expect(isForeignKeyFailure(blocked)).toBe(true);
      h.run('DELETE FROM translation WHERE verse_key = ?', [VERSE]);
      h.run('DELETE FROM ayah WHERE verse_key = ?', [VERSE]);

      // A hole in the middle is not only a count problem — with scope full the
      // missing row also fails `ayah-count` — so the finding asserted here is
      // the one that names *where* the hole is.
      const report = verifyCorpus(readAyahs(h), readSurahs(h), { scope: 'partial' });
      expect(subjectsOf(report, 'surah-ayah-count')).toContain('surah 55');
      expect(subjectsOf(report, 'ordering')).toContain('55:14');

      repair();
      for (const row of [85, 135]) {
        const t = fullTranslationRows(row).find((r) => r.verseKey === VERSE);
        if (t) h.run('INSERT INTO translation (verse_key, pack_id, text) VALUES (?,?,?)', [t.verseKey, t.packId, t.text]);
      }
      expect(verifyCorpus(readAyahs(h), readSurahs(h), { scope: 'full' }).ok).toBe(true);
    });
  });
});

describe('integrity over stored rows: the 31-ayah sample must NOT pass whole-mushaf checks', () => {
  let h: TestHandle;

  beforeAll(() => {
    h = createFixtureDb({ seedHifz: false });
  }, BUILD_TIMEOUT);

  afterAll(() => h?.dispose());

  it('carries the sample rows the fixture declares', () => {
    expect(h.count('ayah')).toBe(fixtureAyahs().length);
    expect(h.count('surah')).toBe(fixtureChapters().length);
  });

  it('fails scope full, because a sample is not a mushaf', () => {
    const report = verifyCorpus(readAyahs(h), readSurahs(h), { scope: 'full' });
    expect(report.ok).toBe(false);
    const codes = report.issues.map((i) => i.code);
    expect(codes).toContain('surah-count');
    expect(codes).toContain('ayah-count');
    expect(codes).toContain('surah-ayah-count');
    // `last-verse` is NOT expected here, and the reason is worth stating: the
    // 31-ayah fixture ends at 114:6, which is the real last verse of the
    // mushaf, so the closing-verse check has nothing to blame. It is covered
    // against a corpus that is genuinely truncated at the end (`core/tests/
    // integrity/verify.test.ts`) and by the drop-the-tail case below.
    expect(codes).not.toContain('last-verse');

    const truncated = readAyahs(h).slice(0, -1);
    expect(
      verifyCorpus(truncated, readSurahs(h), { scope: 'full' }).issues.find((i) => i.code === 'last-verse')?.subject,
    ).toBe('114:5');
  });

  it('still reports the holes inside a non-contiguous chapter even at scope partial', () => {
    // The assertion that keeps the sample honest: `scope: 'partial'` relaxes the
    // whole-mushaf counts, it does not bless a corpus with holes. al-Fatiha is
    // sampled as verses 1, 2, 5, 6, 7, so 2 → 5 is a break.
    const report = verifyCorpus(readAyahs(h), readSurahs(h), { scope: 'partial' });
    expect(report.ok).toBe(false);
    const ordering = report.issues.filter((i) => i.code === 'ordering');
    expect(ordering.length).toBeGreaterThan(0);
    expect(ordering.map((i) => i.subject)).toEqual(expect.arrayContaining(['1:5']));
    expect(ordering.find((i) => i.subject === '1:5')!.detail).toContain('1:2');
    // Chapters sampled contiguously must not be blamed.
    expect(ordering.map((i) => i.subject)).not.toContain('112:2');
  });

  it('finds a corrupted sample row by its verse key too', () => {
    const target = '112:3';
    const before = h.get<{ text_uthmani: string }>(
      'SELECT text_uthmani FROM ayah WHERE verse_key = ?',
      [target],
    );
    if (!before) throw new Error(`the fixture no longer contains ${target}`);
    h.run('UPDATE ayah SET text_uthmani = ? WHERE verse_key = ?', ['خ', target]);
    expect(
      subjectsOf(verifyCorpus(readAyahs(h), readSurahs(h), { scope: 'partial' }), 'fingerprint'),
    ).toEqual([target]);
    h.run('UPDATE ayah SET text_uthmani = ? WHERE verse_key = ?', [before.text_uthmani, target]);
    expect(
      subjectsOf(verifyCorpus(readAyahs(h), readSurahs(h), { scope: 'partial' }), 'fingerprint'),
    ).toEqual([]);
  });
});
