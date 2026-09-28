/**
 * Corpus loader for the local-AI experiments.
 *
 * The authoritative import path is `tools/content` (owned by another agent) and
 * `content/` is still empty, so this reads the *raw provider captures* in
 * `data/raw/quran-com/` read-only and rebuilds the same records the pack build
 * will emit. Every assumption is checked at load time and the check report is
 * written to `results/corpus-alignment.json` — if a check fails the loader
 * throws, because measuring retrieval over a mis-aligned corpus is worse than
 * measuring nothing.
 *
 * Normalisation is imported from `core/src/normalize/arabic.ts` (the single
 * definition of "same word"). Nothing here re-implements it.
 *
 * Raw sources used:
 *   divisions-N.json            6236 ayahs: verse_key, text_uthmani, juz/hizb/page/sajda
 *   verses-uthmani.json         6236 ayahs keyed by source id (cross-check on text)
 *   words-N.json                word-level rows incl. English word glosses
 *   translation-135.json        Persian (IslamHouse) — position-aligned, PROVEN below
 *   translation-29.json         Persian (Fooladvandi) — same
 *   translation-85.json         English (Abdul Haleem) — same
 *   sample-translation-*-N.json verse-keyed spot checks that prove the alignment
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeWord, tokenizeWords, wordCount, normalizedFingerprint } from '../../../../core/src/normalize/arabic.ts';
import { buildSearchIndex, search } from '../../../../core/src/search/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
/** scripts/lib -> local-ai (this experiment) -> repo root. */
const EXP = join(HERE, '..', '..');
const ROOT = join(HERE, '..', '..', '..', '..');
const RAW = join(ROOT, 'data', 'raw', 'quran-com');
const RESULTS = join(EXP, 'results');

const FA_PACKS = { 'tr-fa-135': 'translation-135.json', 'tr-fa-29': 'translation-29.json' };
const EN_PACKS = { 'tr-en-85': 'translation-85.json' };

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** Chapters covered by the verse-keyed sample captures (the alignment proof). */
function sampleChapters(resourceId) {
  return readdirSync(RAW)
    .filter((f) => f.startsWith(`sample-translation-${resourceId}-`) && f.endsWith('.json'))
    .map((f) => Number(f.replace(`sample-translation-${resourceId}-`, '').replace('.json', '')))
    .sort((a, b) => a - b);
}

/**
 * Prove that `translation-<id>.json` is positionally aligned with the ayah
 * order: for every chapter that also exists as a verse-keyed sample capture,
 * each sampled ayah's text must equal the array element at that ayah's index.
 */
function proveTranslationAlignment(order, file, resourceId, report) {
  const rows = readJson(join(RAW, file)).translations;
  if (rows.length !== order.length) {
    throw new Error(`${file}: ${rows.length} rows vs ${order.length} ayahs`);
  }
  const indexOf = new Map(order.map((v, i) => [v.verse_key, i]));
  let checked = 0;
  let mismatched = 0;
  const samples = [];
  for (const ch of sampleChapters(resourceId)) {
    const cap = readJson(join(RAW, `sample-translation-${resourceId}-${ch}.json`)).verses;
    for (const row of cap) {
      const expected = row.translations?.[0]?.text;
      if (expected === undefined) continue;
      const idx = indexOf.get(row.verse_key);
      if (idx === undefined) continue;
      const got = rows[idx]?.text;
      checked += 1;
      if (got !== expected) {
        mismatched += 1;
        if (samples.length < 5) samples.push({ verseKey: row.verse_key, expected, got });
      }
    }
  }
  report.push({
    pack: file,
    resourceId,
    rows: rows.length,
    spotChecks: checked,
    spotCheckMismatches: mismatched,
    chaptersCovered: sampleChapters(resourceId).length,
    examples: samples,
  });
  // The verse-keyed sample captures cover chapters 1, 2, 5, 10, 18, 24, 36,
  // 45, 55, 67, 78, 112, 114 — the head, middle and tail of the file — so a
  // clean sweep over them is the strongest evidence available offline that the
  // big positional file lines up with the ayah order.
  const chapters = sampleChapters(resourceId).length;
  if (checked < 400 || chapters < 10 || mismatched > 0) {
    throw new Error(
      `${file}: alignment NOT proven (${mismatched} mismatches over ${checked} checks in ${chapters} chapters)`,
    );
  }
  const empty = rows.filter((r) => typeof r.text !== 'string' || r.text.trim().length === 0).length;
  report[report.length - 1].emptyRows = empty;
  if (empty > 0) throw new Error(`${file}: ${empty} empty translation rows`);
  return rows.map((r) => r.text);
}

function loadAyahOrder() {
  const chapters = [];
  for (let c = 1; c <= 114; c++) chapters.push(readJson(join(RAW, `divisions-${c}.json`)).verses);
  const all = chapters.flat();
  return { all, chapters };
}

export function loadCorpus({ withWords = false } = {}) {
  const { all, chapters } = loadAyahOrder();
  const alignment = [];
  if (all.length !== 6236) throw new Error(`expected 6236 ayahs, got ${all.length}`);

  // Cross-check the authoritative text against the separate verses capture.
  const byKey = new Map(readJson(join(RAW, 'verses-uthmani.json')).verses.map((v) => [v.verse_key, v.text_uthmani]));
  let textMismatch = 0;
  for (const v of all) if (byKey.get(v.verse_key) !== v.text_uthmani) textMismatch++;
  alignment.push({ check: 'divisions vs verses-uthmani text', ayahs: all.length, mismatches: textMismatch });
  if (textMismatch > 0) throw new Error(`text cross-check failed: ${textMismatch} mismatches`);

  const fa = {};
  for (const [packId, file] of Object.entries(FA_PACKS)) {
    fa[packId] = proveTranslationAlignment(all, file, Number(packId.split('-').pop()), alignment);
  }
  const en = {};
  for (const [packId, file] of Object.entries(EN_PACKS)) {
    en[packId] = proveTranslationAlignment(all, file, Number(packId.split('-').pop()), alignment);
  }

  const ayahs = all.map((v, i) => {
    const normTokens = tokenizeWords(v.text_uthmani).map(normalizeWord).filter((t) => t.length > 0);
    return {
      verseKey: v.verse_key,
      chapter: Number(v.verse_key.split(':')[0]),
      verse: Number(v.verse_key.split(':')[1]),
      index: i,
      juz: v.juz_number,
      page: v.page_number,
      sajda: v.sajdah_number,
      textUthmani: v.text_uthmani,
      normTokens,
      normText: normTokens.join(' '),
      words: normTokens.length,
      wordCountCheck: wordCount(v.text_uthmani),
      fingerprint: normalizedFingerprint(v.text_uthmani),
      fa135: fa['tr-fa-135'][i],
      fa29: fa['tr-fa-29'][i],
      en85: en['tr-en-85'][i],
    };
  });

  const wordRows = [];
  if (withWords) {
    for (let c = 1; c <= 114; c++) {
      const cap = readJson(join(RAW, `words-${c}.json`)).verses;
      for (const v of cap) {
        for (const w of v.words ?? []) {
          if (w.char_type_name !== 'word') continue;
          wordRows.push({
            id: w.id,
            verseKey: v.verse_key,
            position: w.position,
            textUthmani: w.text_uthmani ?? w.text,
            translationEn: w.translation?.text ?? null,
            transliteration: w.transliteration?.text ?? null,
            root: null,
            morphology: null,
            isEndOfAyahMark: false,
          });
        }
      }
    }
  }

  const searchAyahs = ayahs.map((a) => ({
    verseKey: a.verseKey,
    chapter: a.chapter,
    verse: a.verse,
    sourceId: all[a.index].id,
    juz: a.juz,
    hizb: all[a.index].hizb_number,
    rubElHizb: all[a.index].rub_el_hizb_number,
    sajda: a.sajda,
    ruku: all[a.index].ruku_number,
    manzil: all[a.index].manzil_number,
    page: a.page,
    textUthmani: a.textUthmani,
    textUthmaniSimple: null,
    wordCount: a.words,
    normalizedHash: a.fingerprint,
  }));

  const translations = [];
  for (const a of ayahs) {
    translations.push({ verseKey: a.verseKey, packId: 'tr-fa-135', text: a.fa135 });
    translations.push({ verseKey: a.verseKey, packId: 'tr-en-85', text: a.en85 });
  }

  const index = buildSearchIndex(searchAyahs, translations, wordRows, {});
  const corpus = { ayahs, searchAyahs, translations, index, alignment, fa, en };
  mkdirSync(RESULTS, { recursive: true });
  if (!existsSync(join(RESULTS, 'corpus-alignment.json'))) {
    writeFileSync(
      join(RESULTS, 'corpus-alignment.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), ayahCount: ayahs.length, checks: alignment }, null, 2),
    );
  }
  return corpus;
}

export { normalizeWord, tokenizeWords, search, RESULTS, RAW, ROOT };
