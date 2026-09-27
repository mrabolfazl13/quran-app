/**
 * Runtime integrity checks over the imported corpus.
 *
 * The content pipeline validates before packing; this validates what actually
 * landed in the database. The two are different risks: a pack can be valid and
 * still import wrong (truncated row, mixed pack version, hand-edited file).
 */

import type { Ayah, Surah } from '../contracts/quran.js';
import { normalizedFingerprint, wordCount } from '../normalize/arabic.js';

export const CORPUS_EXPECT = {
  surahs: 114,
  ayahs: 6236,
  juz: 30,
  hizb: 60,
  pages: 604,
  firstSurahAyahs: 7,
  lastVerseKey: '114:6',
} as const;

export type IntegritySeverity = 'fatal' | 'warning';

export interface IntegrityIssue {
  code: string;
  severity: IntegritySeverity;
  /** The offending verse key or surah number, so a fix is locatable. */
  subject: string;
  detail: string;
}

export interface IntegrityReport {
  ok: boolean;
  checkedAyahs: number;
  checkedSurahs: number;
  issues: IntegrityIssue[];
}

export interface VerifyOptions {
  /**
   * `full` (default) asserts whole-mushaf invariants: 114 surahs, 6236 ayahs,
   * ending at 114:6. `partial` checks only the rows handed to it — used when
   * verifying a single surah after a targeted reimport.
   */
  scope?: 'full' | 'partial';
  /** Pack digests keyed by verse key, to detect stored text drifting from source. */
  expectedFingerprints?: ReadonlyMap<string, string>;
}

/**
 * Ayahs must be supplied in canonical order (chapter, verse). The caller reads
 * them with `ORDER BY chapter, verse`; passing an unordered array is a bug the
 * checks are meant to catch, and contiguity failures will show as such.
 */
export function verifyCorpus(
  ayahs: readonly Ayah[],
  surahs: readonly Surah[],
  options: VerifyOptions = {},
): IntegrityReport {
  const { scope = 'full', expectedFingerprints } = options;
  const issues: IntegrityIssue[] = [];
  const push = (
    code: string,
    severity: IntegritySeverity,
    subject: string,
    detail: string,
  ) => issues.push({ code, severity, subject, detail });

  if (scope === 'full') {
    if (surahs.length !== CORPUS_EXPECT.surahs) {
      push('surah-count', 'fatal', 'surah', `expected ${CORPUS_EXPECT.surahs}, found ${surahs.length}`);
    }
    if (ayahs.length !== CORPUS_EXPECT.ayahs) {
      push('ayah-count', 'fatal', 'ayah', `expected ${CORPUS_EXPECT.ayahs}, found ${ayahs.length}`);
    }
  }

  const seen = new Set<string>();
  const byChapter = new Map<number, number>();

  for (let i = 0; i < ayahs.length; i++) {
    const a = ayahs[i]!;
    const expectedKey = `${a.chapter}:${a.verse}`;
    if (a.verseKey !== expectedKey) {
      push('key-mismatch', 'fatal', expectedKey, `verse_key field says ${a.verseKey}`);
    }
    if (seen.has(a.verseKey)) {
      push('duplicate-key', 'fatal', a.verseKey, 'same verse key appears twice');
    }
    seen.add(a.verseKey);

    if (i > 0) {
      const prev = ayahs[i - 1]!;
      const contiguous =
        a.chapter === prev.chapter ? a.verse === prev.verse + 1 : a.chapter === prev.chapter + 1 && a.verse === 1;
      if (!contiguous) {
        push('ordering', 'fatal', a.verseKey, `follows ${prev.verseKey} instead of continuing it`);
      }
    }

    if (a.textUthmani.trim().length === 0) {
      push('empty-text', 'fatal', a.verseKey, 'authoritative text is blank');
    }
    if (a.chapter < 1 || a.chapter > CORPUS_EXPECT.surahs) {
      push('chapter-range', 'fatal', a.verseKey, `chapter ${a.chapter} out of range`);
    }
    if (a.juz < 1 || a.juz > CORPUS_EXPECT.juz) {
      push('juz-range', 'fatal', a.verseKey, `juz ${a.juz} out of range`);
    }
    if (a.hizb < 1 || a.hizb > CORPUS_EXPECT.hizb) {
      push('hizb-range', 'fatal', a.verseKey, `hizb ${a.hizb} out of range`);
    }
    if (a.page < 1 || a.page > CORPUS_EXPECT.pages) {
      push('page-range', 'fatal', a.verseKey, `page ${a.page} out of range`);
    }
    if (a.verse < 1) {
      push('verse-range', 'fatal', a.verseKey, `verse ${a.verse} is not positive`);
    }

    const actualWords = wordCount(a.textUthmani);
    if (a.wordCount !== actualWords) {
      push('word-count', 'warning', a.verseKey, `stored ${a.wordCount}, recomputed ${actualWords}`);
    }
    const fp = normalizedFingerprint(a.textUthmani);
    if (a.normalizedHash && a.normalizedHash !== fp) {
      push('fingerprint', 'fatal', a.verseKey, `stored ${a.normalizedHash}, recomputed ${fp}`);
    }
    if (expectedFingerprints) {
      const packFp = expectedFingerprints.get(a.verseKey);
      if (packFp === undefined) {
        push('missing-in-pack', 'warning', a.verseKey, 'row has no counterpart in the pack digest');
      } else if (packFp !== fp) {
        push('text-drift', 'fatal', a.verseKey, 'stored text differs from the pack');
      }
    }

    byChapter.set(a.chapter, (byChapter.get(a.chapter) ?? 0) + 1);
  }

  for (const s of surahs) {
    const actual = byChapter.get(s.number) ?? 0;
    if (actual !== s.ayahCount) {
      push(
        'surah-ayah-count',
        'fatal',
        `surah ${s.number}`,
        `metadata says ${s.ayahCount}, corpus has ${actual}`,
      );
    }
  }

  const last = ayahs[ayahs.length - 1];
  if (scope === 'full' && last && last.verseKey !== CORPUS_EXPECT.lastVerseKey) {
    push('last-verse', 'fatal', last.verseKey, `corpus must end at ${CORPUS_EXPECT.lastVerseKey}`);
  }

  return {
    ok: !issues.some((i) => i.severity === 'fatal'),
    checkedAyahs: ayahs.length,
    checkedSurahs: surahs.length,
    issues,
  };
}

/**
 * Page-mode guard: mushaf pages must be filled in order, otherwise a page view
 * can show an ayah the reader expects on the next page.
 */
export function verifyPageMonotonicity(ayahs: readonly Ayah[]): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  for (let i = 1; i < ayahs.length; i++) {
    const prev = ayahs[i - 1]!;
    const cur = ayahs[i]!;
    if (cur.page < prev.page) {
      issues.push({
        code: 'page-backwards',
        severity: 'warning',
        subject: cur.verseKey,
        detail: `page ${cur.page} follows ${prev.verseKey} on page ${prev.page}`,
      });
    }
  }
  return issues;
}
