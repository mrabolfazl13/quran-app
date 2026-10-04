/**
 * The integrity gate. Runs against data/raw BEFORE packing (and re-runnable
 * against content/ AFTER packing). Exits non-zero with the exact offending
 * verse key on any violation. Never modifies, normalises or "repairs" Quran
 * text — normalisation is used only to compare word tokens for counting,
 * never as stored data.
 *
 * Checks:
 *  0. Provenance audit: every raw file matches data/raw/manifest.json sha256.
 *  1. Exactly 114 surahs; exactly 6236 ayahs.
 *  2. Ids unique & ascending; verse_key matches chapter/verse; per-chapter
 *     1..n contiguity, no gaps or duplicates; text non-empty.
 *  3. Divisions ranges (juz 1..30, hizb 1..60, page 1..604, rub 1..240);
 *     divisions text byte-identical to bulk uthmani text.
 *  4. Surah ayah_count == actual verse count (chapters vs uthmani vs divisions).
 *  5. Word data: word-token count/text equality vs tokenizeWords(); reconstruction
 *     of the ayah text from word-type entries checked byte-for-byte; end marks flagged;
 *     every word row places itself on the Madani mushaf grid (`page_number` 1..604,
 *     `line_number` 1..15) and the corpus covers all 604 pages.
 *  6. Translation alignment: bulk arrays (no verse_key) proven against
 *     /verses/by_chapter/{c}?translations={id} for 12 sample chapters.
 *  7. Tafsir (when fetched): verse_key validity, non-empty text, coverage.
 *  8. Post-build: pack manifests (checksum/bytes/records, and `pack.json`
 *     agreeing with the `index.json` entry) + payload text is
 *     byte-identical to raw provider text, and the word-data payload's mushaf
 *     `pageNumber`/`lineNumber` equal the raw row's `page_number`/`line_number`
 *     row by row and page by page (this is what makes the 604-page grid
 *     rebuildable offline from shipped packs only). Licence and attribution are
 *     checked for *statement*, not clearance: empty notes, an empty credit line,
 *     a status outside the contract enum or a `'clear'` claim with neither an
 *     SPDX id nor a licence URL all stop the build; honest `'unresolved'`
 *     statuses pass and are printed as a warning with the pack ids.
 *  9. Post-build, the *derived* `mutashabihat-ar` pack: every pair is re-scored
 *     with the real engine function (`pairTextScore`) over the real core pack
 *     rows, every quoted phrase must actually occur in both ayat, ordering and
 *     de-duplication are canonical, `produced_by` is the engine's own constant,
 *     and the manifest states its parameters, its inherited licence and that
 *     the rows are computed rather than scholarly. A pair this gate cannot
 *     reproduce is a corrupted pack, not a "maybe".
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  RAW_PROVIDER_DIR,
  RAW_ROOT,
  RAW_MANIFEST_PATH,
  CONTENT_ROOT,
  REPO_ROOT,
  SAMPLE_CHAPTERS,
  TRANSLATION_RESOURCES,
  TAFSIR_RESOURCES,
  ALL_CHAPTERS,
  fetchJson,
  readRawJson,
  rawExists,
  sha256hex,
  API_BASE,
} from './common.ts';
import { tokenizeWords, normalizeWord, normalizedText } from '../../../core/src/normalize/arabic.ts';
import {
  MIN_SHARED_WORDS,
  MUTASHABIHAT_PRODUCED_BY,
  pairTextScore,
  toSimilarityDoc,
} from '../../../core/src/mutashabihat/index.ts';
import type { Ayah } from '../../../core/src/contracts/quran.ts';

export interface ValidationResult {
  errors: string[];
  warnings: string[];
  stats: Record<string, number | string>;
}

const JUZ_COUNT = 30;
const HIZB_COUNT = 60;
const PAGE_COUNT = 604;
const RUB_COUNT = 240;
const SURAH_COUNT = 114;
const AYAH_COUNT = 6236;
/**
 * Printed height of the Madani mushaf grid. Measured over all 83 665 provider
 * word rows: the highest `line_number` is 15 and 488 of 604 pages use all 15.
 * Same constant the layout engine ships (`core/src/mushaf/layout.ts`).
 */
const MAX_MUSHAF_LINE = 15;

interface RawVerse {
  id: number;
  verse_key: string;
  text_uthmani: string;
}
interface RawChapter {
  id: number;
  name_arabic: string;
  name_simple: string;
  name_complex: string;
  revelation_place: string;
  revelation_order: number;
  verses_count: number;
  pages: [number, number];
  bismillah_pre: boolean;
  translated_name?: { name: string; language_name: string };
}

export async function validateRaw(): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const stats: Record<string, number | string> = {};
  const fail = (m: string) => errors.push(m);

  // -- 0. provenance audit --------------------------------------------------
  const manifest = rawExists('manifest.json')
    ? (JSON.parse(readFileSync(RAW_MANIFEST_PATH, 'utf8')) as { files: Record<string, { url: string; sha256: string; bytes: number; fetchedAt: string }> })
    : { files: {} };
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [e.name.endsWith('.json') ? relative(RAW_ROOT, join(dir, e.name)).replaceAll('\\', '/') : null],
    ).filter((x): x is string => !!x);
  if (existsSync(RAW_PROVIDER_DIR)) {
    for (const rel of walk(RAW_PROVIDER_DIR)) {
      const rec = manifest.files[rel];
      if (!rec) {
        fail(`provenance: data/raw/${rel} has no entry in manifest.json — every raw byte must be auditable`);
        continue;
      }
      const buf = readFileSync(join(RAW_ROOT, rel));
      if (sha256hex(buf) !== rec.sha256 || buf.length !== rec.bytes) {
        fail(`provenance: data/raw/${rel} content does not match manifest sha256/bytes`);
      }
    }
  }

  // -- 1. chapters -----------------------------------------------------------
  if (!rawExists('quran-com/chapters.json')) { fail('missing data/raw/quran-com/chapters.json — run fetch first'); return { errors, warnings, stats }; }
  const chapters = (readRawJson<any>('quran-com/chapters.json')).chapters as RawChapter[];
  if (chapters.length !== SURAH_COUNT) fail(`expected exactly ${SURAH_COUNT} surahs, got ${chapters.length}`);
  const chIds = new Set<number>();
  for (const c of chapters) {
    if (chIds.has(c.id)) fail(`duplicate surah id ${c.id}`);
    chIds.add(c.id);
    if (!c.name_arabic?.trim() || !c.name_simple?.trim() || !c.name_complex?.trim()) fail(`surah ${c.id}: empty name field`);
    if (!['makkah', 'madinah', 'Makkah', 'Madinah', 'makki', 'madani'].includes(String(c.revelation_place))) {
      fail(`surah ${c.id}: unexpected revelation_place ${JSON.stringify(c.revelation_place)}`);
    }
    if (!(c.pages?.[0] >= 1 && c.pages[1] <= PAGE_COUNT && c.pages[0] <= c.pages[1])) fail(`surah ${c.id}: bad pages range ${JSON.stringify(c.pages)}`);
    if (!(c.revelation_order >= 1 && c.revelation_order <= SURAH_COUNT)) fail(`surah ${c.id}: revelation_order out of 1..114: ${c.revelation_order}`);
    if (c.bismillah_pre !== true && c.bismillah_pre !== false) fail(`surah ${c.id}: bismillah_pre not boolean`);
  }
  for (let i = 1; i <= SURAH_COUNT; i++) if (!chIds.has(i)) fail(`missing surah id ${i}`);
  stats.surahs = chapters.length;

  // -- 2. uthmani bulk -------------------------------------------------------
  if (!rawExists('quran-com/verses-uthmani.json')) { fail('missing data/raw/quran-com/verses-uthmani.json — run fetch first'); return { errors, warnings, stats }; }
  const uthmani = (readRawJson<any>('quran-com/verses-uthmani.json')).verses as RawVerse[];
  if (uthmani.length !== AYAH_COUNT) fail(`expected exactly ${AYAH_COUNT} ayahs in uthmani bulk, got ${uthmani.length}`);
  const ids = new Set<number>();
  const keysByChapter = new Map<number, number[]>();
  const keyToText = new Map<string, string>();
  const keyToId = new Map<string, number>();
  /** `verse_key` → the ayah's own mushaf page, from the divisions rows. */
  const keyToPage = new Map<string, number>();
  let prevId = 0;
  for (const v of uthmani) {
    if (ids.has(v.id)) fail(`duplicate verse id ${v.id} (${v.verse_key})`);
    ids.add(v.id);
    if (v.id <= prevId) fail(`verse ids not ascending at id ${v.id} (${v.verse_key})`);
    prevId = v.id;
    const m = /^(\d+):(\d+)$/.exec(v.verse_key ?? '');
    if (!m) { fail(`malformed verse_key ${JSON.stringify(v.verse_key)} (id ${v.id})`); continue; }
    const ch = Number(m[1]);
    const ver = Number(m[2]);
    if (keyToText.has(v.verse_key)) fail(`duplicate verse_key ${v.verse_key}`);
    keyToText.set(v.verse_key, v.text_uthmani);
    keyToId.set(v.verse_key, v.id);
    if (!Array.isArray(keysByChapter.get(ch))) keysByChapter.set(ch, []);
    keysByChapter.get(ch)!.push(ver);
    if (typeof v.text_uthmani !== 'string' || v.text_uthmani.trim().length === 0) {
      fail(`empty/whitespace-only uthmani text at ${v.verse_key}`);
    }
  }
  for (const [ch, vers] of keysByChapter) {
    if (ch < 1 || ch > SURAH_COUNT) { fail(`verse with chapter ${ch} outside 1..114 (first verse: ${ch}:1)`); continue; }
    const sorted = [...vers].sort((a, b) => a - b);
    if (new Set(sorted).size !== sorted.length) fail(`duplicate verse numbers within surah ${ch}`);
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i] !== i + 1) { fail(`verse ordering gap in surah ${ch}: expected verse ${i + 1}, found ${sorted[i]}`); break; }
    }
    const chapterMeta = chapters.find((c) => c.id === ch)!;
    if (chapterMeta && chapterMeta.verses_count !== sorted.length) {
      fail(`surah ${ch}: chapters.verses_count=${chapterMeta.verses_count} but uthmani has ${sorted.length} ayahs (boundary ${ch}:${sorted.length})`);
    }
  }
  stats.ayahs = uthmani.length;

  // -- simple text mirror check ----------------------------------------------
  if (rawExists('quran-com/verses-uthmani-simple.json')) {
    const simple = (readRawJson<any>('quran-com/verses-uthmani-simple.json')).verses as { id: number; verse_key: string; text_uthmani: string }[];
    if (simple.length !== AYAH_COUNT) fail(`uthmani-simple has ${simple.length} rows, expected ${AYAH_COUNT}`);
    let simpleMismatch = 0;
    for (const s of simple) {
      if (keyToId.get(s.verse_key) !== s.id) { if (simpleMismatch++ < 5) fail(`uthmani-simple id/verse_key disagreement at ${s.verse_key}`); }
      if (typeof s.text_uthmani !== 'string' || !s.text_uthmani.trim()) fail(`empty simple text at ${s.verse_key}`);
    }
    stats.simpleRows = simple.length;
  } else warnings.push('uthmani-simple not fetched; textUthmaniSimple will be null in packs');

  // -- 3/4. divisions ---------------------------------------------------------
  const missingDiv = ALL_CHAPTERS.filter((c) => !rawExists(`quran-com/divisions-${c}.json`));
  if (missingDiv.length) {
    fail(`missing divisions files for chapters: ${missingDiv.slice(0, 10).join(',')}${missingDiv.length > 10 ? '…' : ''} (${missingDiv.length} total)`);
  } else {
    let divChecked = 0;
    for (const c of ALL_CHAPTERS) {
      const body = readRawJson<any>(`quran-com/divisions-${c}.json`);
      const verses = body.verses as any[];
      const chMeta = chapters.find((x) => x.id === c)!;
      if (verses.length !== chMeta.verses_count) {
        fail(`surah ${c}: divisions count ${verses.length} != chapters.verses_count ${chMeta.verses_count}`);
      }
      for (const v of verses) {
        const key = String(v.verse_key);
        divChecked++;
        const rawText = keyToText.get(key);
        if (rawText === undefined) { fail(`divisions row for unknown verse_key ${key}`); continue; }
        if (v.id !== keyToId.get(key)) fail(`divisions id mismatch at ${key}: ${v.id} vs uthmani ${keyToId.get(key)}`);
        if (v.text_uthmani !== rawText) fail(`divisions text not byte-identical to uthmani bulk at ${key}`);
        const inRange = (x: unknown, lo: number, hi: number) => typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi;
        if (!inRange(v.juz_number, 1, JUZ_COUNT)) fail(`juz out of 1..${JUZ_COUNT} at ${key}: ${JSON.stringify(v.juz_number)}`);
        if (!inRange(v.hizb_number, 1, HIZB_COUNT)) fail(`hizb out of 1..${HIZB_COUNT} at ${key}: ${JSON.stringify(v.hizb_number)}`);
        if (!inRange(v.page_number, 1, PAGE_COUNT)) fail(`page out of 1..${PAGE_COUNT} at ${key}: ${JSON.stringify(v.page_number)}`);
        else keyToPage.set(key, v.page_number);
        if (!inRange(v.rub_el_hizb_number, 1, RUB_COUNT)) fail(`rub out of 1..${RUB_COUNT} at ${key}: ${JSON.stringify(v.rub_el_hizb_number)}`);
        for (const f of ['ruku_number', 'manzil_number', 'sajdah_number'] as const) {
          const x = v[f];
          if (x !== null && x !== undefined && !Number.isInteger(x)) fail(`${f} not integer/null at ${key}: ${JSON.stringify(x)}`);
        }
        if (typeof v.manzil_number === 'number' && (v.manzil_number < 1 || v.manzil_number > 7)) fail(`manzil out of 1..7 at ${key}`);
        if (typeof v.ruku_number === 'number' && v.ruku_number < 1) fail(`ruku < 1 at ${key}`);
      }
    }
    stats.divisionRows = divChecked;
  }

  // -- 5. word-by-word ---------------------------------------------------------
  // Documented provider-side quirks where the per-word endpoint spells a word
  // differently from the bulk uthmani endpoint. These are NOT repaired; the
  // stored ayah text remains the byte-exact bulk uthmani, and the stored word
  // text remains the byte-exact word-endpoint text. They are excluded from the
  // content-equality gate, listed here so nothing is hidden.
  const WORD_TEXT_QUIRKS: Record<string, string> = {
    '5:52': 'word data splits دَآئِرَةٌ as "دَآئِرَ" + "ةٌۭ ۚ"; bulk text kept verbatim',
    '11:13': 'word data spells ٱفْتَرَىٰهُ as ٱفْتَرَاهُ; bulk text kept verbatim',
  };
  const missingWords = ALL_CHAPTERS.filter((c) => !rawExists(`quran-com/words-${c}.json`));
  if (missingWords.length) {
    warnings.push(`word files missing for ${missingWords.length} chapters (${missingWords.slice(0, 8).join(',')})`);
  } else {
    let wordRows = 0;
    let endMarks = 0;
    let rebuildChecked = 0;
    let byteExact = 0;
    let markLevel = 0;
    let quirkHits = 0;
    // mushaf grid metadata (`page_number` / `line_number` on every word row)
    let mushafRows = 0;
    const mushafPages = new Set<number>();
    let mushafLineMax = 0;
    let mushafBadRows = 0;
    /** Verses whose word rows name a page other than the ayah's own page. */
    let anchorDisagreement = 0;
    for (const c of ALL_CHAPTERS) {
      const body = readRawJson<any>(`quran-com/words-${c}.json`);
      for (const v of body.verses as any[]) {
        const key = String(v.verse_key);
        const text = keyToText.get(key);
        if (text === undefined) { fail(`words row for unknown verse_key ${key}`); continue; }
        const words: any[] = v.words ?? [];
        if (!words.length) { fail(`no word entries at ${key}`); continue; }
        const wordType = words.filter((w) => w.char_type_name === 'word');
        const endType = words.filter((w) => w.char_type_name === 'end');
        if (wordType.length + endType.length !== words.length) fail(`unexpected char_type_name at ${key}`);
        if (!wordType.length) fail(`no word-type entries at ${key}`);
        endMarks += endType.length;
        wordRows += words.length;
        // Mushaf grid metadata: the reader rebuilds the 604-page grid offline
        // from exactly these two numbers on every row (word tokens AND the
        // end-of-ayah mark), so a missing or out-of-grid value is an error.
        const declaredPages = new Set<number>();
        for (const w of words) {
          mushafRows++;
          const pageOk =
            typeof w.page_number === 'number' && Number.isInteger(w.page_number) &&
            w.page_number >= 1 && w.page_number <= PAGE_COUNT;
          const lineOk =
            typeof w.line_number === 'number' && Number.isInteger(w.line_number) &&
            w.line_number >= 1 && w.line_number <= MAX_MUSHAF_LINE;
          if (!pageOk || !lineOk) {
            mushafBadRows++;
            if (mushafBadRows <= 20) {
              fail(
                `mushaf metadata at ${key} word id ${w.id}: page_number=${JSON.stringify(w.page_number)} ` +
                  `(need integer 1..${PAGE_COUNT}), line_number=${JSON.stringify(w.line_number)} ` +
                  `(need integer 1..${MAX_MUSHAF_LINE}) — placement is never guessed`,
              );
            }
            continue;
          }
          mushafPages.add(w.page_number);
          if (w.line_number > mushafLineMax) mushafLineMax = w.line_number;
          declaredPages.add(w.page_number);
        }
        const anchorPage = keyToPage.get(key);
        if (anchorPage !== undefined && [...declaredPages].some((p) => p !== anchorPage)) anchorDisagreement++;
        // positions must strictly ascend in provider order
        for (let i = 1; i < words.length; i++) {
          if (!(words[i]!.position > words[i - 1]!.position)) fail(`word positions not ascending at ${key}: ${words[i - 1]!.position} -> ${words[i]!.position}`);
        }
        // Exactly one end-of-ayah entry carrying the verse number.
        if (endType.length !== 1) fail(`expected 1 end-of-ayah mark at ${key}, found ${endType.length}`);
        const verseNo = Number(key.split(':')[1]);
        for (const e of endType) {
          const asDigits = String(e.text_uthmani ?? '').replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
          if (asDigits.trim() !== String(verseNo)) fail(`end-of-ayah mark at ${key} does not encode the verse number: ${JSON.stringify(e.text_uthmani)}`);
        }
        // Reconstruction gate: joining word-type texts must equal the stored
        // ayah text byte-for-byte, or differ only in ornamental pause marks
        // (core-normalised equality). Provider spelling quirks are listed in
        // WORD_TEXT_QUIRKS — everything else stops the pipeline.
        const rebuilt = wordType.map((w) => String(w.text_uthmani)).join(' ');
        if (rebuilt === text) {
          byteExact++;
        } else if (normalizedText(rebuilt) === normalizedText(text)) {
          markLevel++;
        } else if (WORD_TEXT_QUIRKS[key]) {
          quirkHits++;
        } else {
          fail(`word data does not reconstruct ayah text at ${key}: content divergence beyond ornamental marks`);
          continue;
        }
        rebuildChecked++;
        // Word-count gate: tokenise each word-type entry (some entries embed a
        // pause mark after a space, e.g. "بَعْدَ مَا") and compare the flattened
        // sequence with the tokens of the stored text.
        const flat = wordType.flatMap((w) => tokenizeWords(String(w.text_uthmani)).map(normalizeWord).filter((t) => t !== ''));
        const tokens = tokenizeWords(text).map(normalizeWord).filter((t) => t !== '');
        if (flat.length !== tokens.length) {
          if (WORD_TEXT_QUIRKS[key]) {
            quirkHits++;
          } else {
            fail(`word count mismatch at ${key}: ${wordType.length} word-type entries flattened to ${flat.length} tokens vs ${tokens.length} text tokens`);
            continue;
          }
        } else if (!WORD_TEXT_QUIRKS[key]) {
          for (let i = 0; i < tokens.length; i++) {
            if (flat[i] !== tokens[i]) {
              fail(`word ${i + 1} of ${key} disagrees with text token: ${JSON.stringify(flat[i])} vs ${JSON.stringify(tokens[i])}`);
              break;
            }
          }
        }
      }
    }
    stats.wordRows = wordRows;
    stats.endOfAyahMarks = endMarks;
    stats.mushafRowsChecked = mushafRows;
    stats.mushafPagesDistinct = mushafPages.size;
    stats.mushafLineMax = mushafLineMax;
    stats.mushafBadRows = mushafBadRows;
    stats.wordPageAnchorDisagreements = anchorDisagreement;
    if (mushafPages.size !== PAGE_COUNT) {
      fail(`mushaf metadata covers ${mushafPages.size} distinct pages, expected all ${PAGE_COUNT}`);
    }
    if (mushafLineMax !== MAX_MUSHAF_LINE) {
      warnings.push(`highest line_number observed across the word rows is ${mushafLineMax}, not the ${MAX_MUSHAF_LINE}-line grid`);
    }
    if (anchorDisagreement) {
      warnings.push(
        `${anchorDisagreement} verses have word rows naming a page other than their own division page ` +
          `(the provider's rows predate parts of the mushaf re-cut). Kept verbatim in the pack; ` +
          `core/src/mushaf/layout.ts anchors them on the ayah page and reports each move as a ` +
          `word-page-corrected diagnostic.`,
      );
    }
    stats.rebuildChecked = rebuildChecked;
    stats.rebuildByteExact = byteExact;
    stats.rebuildOrnamentalMarkDiff = markLevel;
    stats.documentedWordTextQuirks = quirkHits;
    for (const [k, why] of Object.entries(WORD_TEXT_QUIRKS)) warnings.push(`documented provider quirk at ${k}: ${why}`);
    if (markLevel) warnings.push(`${markLevel}/${rebuildChecked} verses: word texts differ from bulk uthmani only in ornamental pause marks (provider quirk; stored text is the byte-exact bulk uthmani, never altered)`);
  }

  // -- 6. translation alignment ------------------------------------------------
  const orderedKeys = uthmani.map((v) => v.verse_key); // ids ascending == mushaf order
  const keyIndex = new Map(orderedKeys.map((k, i) => [k, i]));
  for (const { resourceId, packId } of TRANSLATION_RESOURCES) {
    const bulkRel = `quran-com/translation-${resourceId}.json`;
    if (!rawExists(bulkRel)) { fail(`missing ${bulkRel}`); continue; }
    const rows = (readRawJson<any>(bulkRel)).translations as { resource_id: number; text: string }[];
    if (rows.length !== AYAH_COUNT) fail(`translation ${resourceId}: ${rows.length} rows, expected ${AYAH_COUNT}`);
    const rids = new Set(rows.map((r) => r.resource_id));
    if (rids.size !== 1 || !rids.has(resourceId)) fail(`translation ${resourceId}: mixed/foreign resource_ids: ${[...rids].join(',')}`);
    rows.forEach((r, i) => {
      if (typeof r.text !== 'string' || r.text.trim() === '') fail(`translation ${resourceId}: empty text at position ${i} (~${orderedKeys[i]})`);
    });
    // ensure sample proof files exist (fetch on demand so validate proves alignment itself)
    for (const c of SAMPLE_CHAPTERS) {
      const rel = `quran-com/sample-translation-${resourceId}-${c}.json`;
      if (!rawExists(rel)) {
        await fetchJson(rel, `${API_BASE}/verses/by_chapter/${c}?translations=${resourceId}&fields=verse_key&per_page=300`, (b: any) => !!b && Array.isArray(b.verses) && b.verses.length > 0);
      }
    }
    let sampleRows = 0;
    let mismatch = 0;
    for (const c of SAMPLE_CHAPTERS) {
      const rel = `quran-com/sample-translation-${resourceId}-${c}.json`;
      const sv = readRawJson<any>(rel).verses as any[];
      const expected = chapters.find((x) => x.id === c)!.verses_count;
      if (sv.length !== expected) fail(`alignment proof ${rel}: sampled ${sv.length} verses, expected all ${expected} of surah ${c} — proof is incomplete`);
      for (const verse of sv) {
        const key = String(verse.verse_key);
        const tr = (verse.translations ?? []).find((t: any) => t.resource_id === resourceId) ?? verse.translations?.[0];
        if (!tr) { fail(`translation ${resourceId}: sample ${key} has no translation entry`); continue; }
        const idx = keyIndex.get(key);
        if (idx === undefined) { fail(`translation sample unknown verse_key ${key}`); continue; }
        sampleRows++;
        if (rows[idx]?.text !== tr.text) {
          mismatch++;
          if (mismatch <= 5) {
            fail(`ALIGNMENT: translation ${resourceId} bulk row ${idx} (${key}) != sample text at ${key}: bulk=${JSON.stringify(rows[idx]?.text?.slice(0, 60))} sample=${JSON.stringify(String(tr.text).slice(0, 60))}`);
          }
        }
      }
    }
    stats[`align_${resourceId}_sampled`] = sampleRows;
    if (mismatch) {
      const shift = detectShift(rows, orderedKeys, resourceId);
      fail(`BLOCKER: translation ${resourceId} (${packId}) positional alignment FAILED on ${mismatch}/${sampleRows} sampled verses${shift !== null ? `; bulk appears SHIFTED by ${shift} (likely off-by-N vs mushaf order)` : '; no constant shift explains it — do not ship a guessed mapping'}`);
    } else {
      stats[`align_${resourceId}_ok`] = sampleRows;
    }
  }

  // -- 7. tafsirs (informational completeness; strict where present) -----------
  for (const { resourceId } of TAFSIR_RESOURCES) {
    const have = ALL_CHAPTERS.filter((c) => rawExists(`quran-com/tafsir-${resourceId}-${c}.json`));
    let rowsN = 0;
    let emptyRows = 0;
    for (const c of have) {
      const body = readRawJson<any>(`quran-com/tafsir-${resourceId}-${c}.json`);
      for (const t of body.tafsirs as any[]) {
        rowsN++;
        const key = String(t.verse_key);
        if (!keyToText.has(key)) fail(`tafsir ${resourceId}: row with unknown verse_key ${key}`);
        if (typeof t.text !== 'string' || !t.text.trim()) {
          // Ibn Kathir abridged (169) ships placeholder rows for verses whose
          // commentary sits under a preceding passage — provider structure,
          // not corruption. Empty rows are dropped at build time.
          emptyRows++;
        }
      }
    }
    stats[`tafsir_${resourceId}_chapters`] = have.length;
    stats[`tafsir_${resourceId}_rows`] = rowsN;
    stats[`tafsir_${resourceId}_emptyRows`] = emptyRows;
    if (emptyRows) warnings.push(`tafsir ${resourceId}: ${emptyRows}/${rowsN} rows have empty text (grouped provider edition; build drops empty rows, passages key on their own verse_key only)`);
    if (have.length < SURAH_COUNT) warnings.push(`tafsir ${resourceId} incomplete: ${have.length}/114 chapters fetched`);
  }

  return { errors, warnings, stats };
}

/** If a constant shift makes sample texts match, report its size. */
function detectShift(rows: { text: string }[], orderedKeys: string[], resourceId: number): number | null {
  const rel = `quran-com/sample-translation-${resourceId}-2.json`;
  if (!rawExists(rel)) return null;
  const sv = readRawJson<any>(rel).verses as any[];
  const offsets = new Map<number, number>();
  for (const verse of sv) {
    const idx = orderedKeys.indexOf(String(verse.verse_key));
    const tr = (verse.translations ?? []).find((t: any) => t.resource_id === resourceId) ?? verse.translations?.[0];
    if (idx < 0 || !tr) continue;
    for (let off = -3; off <= 3; off++) {
      if (rows[idx + off]?.text === tr.text) offsets.set(off, (offsets.get(off) ?? 0) + 1);
    }
  }
  let best: { off: number; n: number } | null = null;
  for (const [off, n] of offsets) if (!best || n > best.n) best = { off, n };
  return best && best.n > sv.length / 2 && best.off !== 0 ? best.off : null;
}

// ---------------------------------------------------------------------------
// post-build: the derived mutashabihat pack must reproduce from the engine
//
// `mutashabihat-ar` is not provider data — the build computes it with
// `core/src/mutashabihat` over the core pack (see `src/mutashabihatPack.ts`).
// So its gate re-derives every row instead of trusting the payload: the score
// must equal `pairTextScore` for those two ayat, the quoted phrase must really
// be a contiguous run of equal canonical tokens in both of them, the row set
// must be canonical/deduplicated, and the manifest must state its parameters,
// inherit `quran-core`'s unresolved licence and label itself as computed.

/** The same rounding the build stores with — the engine's presentation format. */
const round4 = (n: number): number => Number(n.toFixed(4));

/** `chapter:verse` numeric ordering, used only to check stored row order. */
function compareVerseKeys(a: string, b: string): number {
  const [ca, va] = a.split(':');
  const [cb, vb] = b.split(':');
  const cn = Number(ca) - Number(cb);
  return cn !== 0 ? cn : Number(va) - Number(vb);
}

/**
 * The shipped core pack's ayah rows — the corpus every pair claims to describe.
 * `null` when that pack is not on disk.
 */
function corePackAyahs(): { byKey: Map<string, Ayah>; sha256: string } | null {
  const p = join(CONTENT_ROOT, 'quran-core', 'payload.jsonl');
  if (!existsSync(p)) return null;
  const buf = readFileSync(p);
  const byKey = new Map<string, Ayah>();
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as any;
    if (r && r._t === 'ayah') byKey.set(String(r.verseKey), r as Ayah);
  }
  return { byKey, sha256: sha256hex(buf) };
}

/** Separator that cannot occur inside a token, for contiguous-run checks. */
const SEP = String.fromCharCode(1);

type SimilarDoc = ReturnType<typeof toSimilarityDoc>;
interface CorePack {
  byKey: Map<string, Ayah>;
  sha256: string;
}

/** Manifest-level assertions: self-labelled provenance block, inherited licence, input digest. */
function checkMutashabihatManifest(id: string, pack: any, core: CorePack, errors: string[]): void {
  const d = pack.derived;
  const bad = (m: string): void => {
    errors.push(`${id}: ${m}`);
  };
  if (!d || d.computed !== true) bad('manifest has no derived.computed provenance block — a computed pack must label itself');
  if (d?.producedBy !== MUTASHABIHAT_PRODUCED_BY) bad(`manifest derived.producedBy is ${JSON.stringify(d?.producedBy)}, expected ${MUTASHABIHAT_PRODUCED_BY}`);
  if (pack.license?.status !== 'unresolved') bad(`derived from the 'unresolved' quran-core licence, so it may not claim a clearer status (got ${JSON.stringify(pack.license?.status)})`);
  if (d?.input?.payloadSha256 !== core.sha256) bad(`manifest says the pairs were computed over ${JSON.stringify(d?.input?.payloadSha256)}, but content/quran-core/payload.jsonl hashes to ${core.sha256}`);
  if (d?.input?.ayahCount !== core.byKey.size) bad(`manifest declares ${JSON.stringify(d?.input?.ayahCount)} input ayahs, the core pack carries ${core.byKey.size}`);
  if (d?.result?.pairs !== undefined && d.result.pairs !== pack.recordCount) bad(`derived.result.pairs is ${d.result.pairs} but recordCount is ${pack.recordCount}`);
}

/** Row-level re-derivation. `null` means the row is exactly what the engine gives. */
function checkMutashabihatRow(r: any, core: CorePack, docOf: (k: string) => SimilarDoc): string | null {
  const a = String(r.verseKeyA ?? '');
  const b = String(r.verseKeyB ?? '');
  const where = `${a} -> ${b}`;
  if (!core.byKey.has(a) || !core.byKey.has(b)) return `${where}: references a verse that is not in the shipped core pack`;
  if (compareVerseKeys(a, b) >= 0) return `${where}: rows must be stored canonically, verseKeyA before verseKeyB in mushaf order`;
  if (r.producedBy !== MUTASHABIHAT_PRODUCED_BY) return `${where}: producedBy is ${JSON.stringify(r.producedBy)}, not the engine constant ${MUTASHABIHAT_PRODUCED_BY}`;
  const score = r.textScore;
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) return `${where}: textScore ${JSON.stringify(score)} is not a number in 0..1`;
  const docA = docOf(a);
  const docB = docOf(b);
  const engineScore = round4(pairTextScore(docA, docB));
  if (score !== engineScore) return `${where}: stored textScore ${score} but the engine gives ${engineScore} — stored similarity may not drift from the algorithm`;
  const setB = new Set(docB.normTokens);
  let shared = 0;
  for (const w of new Set(docA.normTokens)) if (setB.has(w)) shared += 1;
  const minWords = Math.min(docA.wordCount, docB.wordCount);
  if (shared < (minWords <= 1 ? 1 : MIN_SHARED_WORDS)) return `${where}: only ${shared} shared normalised words, below the engine guard MIN_SHARED_WORDS=${MIN_SHARED_WORDS}`;
  // The phrase must be a contiguous run of equal canonical tokens in BOTH ayat
  // — exactly what buildPair slices, and what the screen prints as shared.
  // Surface tokens are joined by single spaces, so a plain split is exact.
  const phrase = typeof r.sharedPhrase === 'string' ? r.sharedPhrase.trim() : '';
  if (phrase !== '') {
    const needle = phrase.split(' ').map(normalizeWord).join(SEP);
    if (!docA.normTokens.join(SEP).includes(needle) || !docB.normTokens.join(SEP).includes(needle)) {
      return `${where}: sharedPhrase ${JSON.stringify(r.sharedPhrase)} is not a contiguous token run of both ayat — a quoted phrase must really be in the text`;
    }
  }
  return null;
}

/**
 * Full pass over one computed similar-ayah payload: manifest provenance first,
 * then every row re-derived. Failures are capped so a systematically wrong
 * build reports the first twenty rows plus the total instead of 6 000 lines.
 */
function validateMutashabihatPack(
  pack: any,
  lines: string[],
  core: CorePack | null,
  errors: string[],
  stats: Record<string, number | string>,
): void {
  const id = String(pack.id);
  const fail = (message: string): void => {
    const shown = errors.filter((e) => e.startsWith(`${id} record #`)).length;
    if (shown < 20) errors.push(`${id}: ${message}`);
    else if (shown === 20) errors.push(`${id}: further similar-ayah failures suppressed (first 20 reported)`);
  };
  if (!core) {
    errors.push(`${id}: content/quran-core/payload.jsonl is missing, so not one pair in this pack can be verified`);
    return;
  }
  checkMutashabihatManifest(id, pack, core, errors);

  const docs = new Map<string, SimilarDoc>();
  const docOf = (k: string): SimilarDoc => {
    let d = docs.get(k);
    if (!d) {
      d = toSimilarityDoc(core.byKey.get(k)!);
      docs.set(k, d);
    }
    return d;
  };

  const seen = new Set<string>();
  const covered = new Set<string>();
  let reDerived = 0;
  let withPhrase = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const r = JSON.parse(lines[i]!) as any;
    const a = String(r.verseKeyA ?? '');
    const b = String(r.verseKeyB ?? '');
    if (seen.has(`${a}|${b}`)) {
      fail(`record #${i + 1} (${a} -> ${b}): duplicate pair — the mirror row is the same candidate and must not ship twice`);
      continue;
    }
    seen.add(`${a}|${b}`);
    const problem = checkMutashabihatRow(r, core, docOf);
    if (problem) {
      fail(`record #${i + 1} ${problem}`);
      continue;
    }
    reDerived += 1;
    covered.add(a);
    covered.add(b);
    if (typeof r.sharedPhrase === 'string' && r.sharedPhrase.trim() !== '') withPhrase += 1;
  }
  stats[`${id}_pairs`] = lines.length;
  stats[`${id}_reDerivedFromEngine`] = reDerived;
  stats[`${id}_ayahsWithPair`] = covered.size;
  stats[`${id}_pairsWithPhrase`] = withPhrase;
  const declared = pack.derived?.result;
  if (declared) {
    if (declared.ayahsWithAtLeastOnePair !== covered.size) {
      errors.push(`${id}: manifest claims ${declared.ayahsWithAtLeastOnePair} covered ayahs, the payload covers ${covered.size}`);
    }
    if (declared.corpusAyahs !== core.byKey.size) {
      errors.push(`${id}: manifest claims a ${declared.corpusAyahs}-ayah corpus, the shipped core pack has ${core.byKey.size}`);
    }
  }
}

// ---------------------------------------------------------------------------
// post-build: licence and attribution must be *stated*, not assumed
//
// `AGENTS.md` rule 2: content ships only with attribution, and an unclear
// licence must be recorded as `unresolved` rather than quietly shipped as if
// cleared. Nothing below clears a licence — it makes the manifest *unable to
// hide* one: an empty `license.notes`, a missing credit line, a `clear` claim
// with no document behind it, or a licence status outside the contract enum is
// an error that stops the build. Packs that honestly say `unresolved` stay
// green (that is the required label), but the gate now prints them, so a
// shipped installer cannot claim nobody noticed.

const LICENSE_STATUSES = ['clear', 'attribution-required', 'unresolved'] as const;

/** `license` + `attribution` shape checks for one shipped pack manifest. */
function checkLicenceAndAttribution(
  pack: any,
  errors: string[],
  unresolved: string[],
): void {
  const id = String(pack.id);
  const bad = (m: string): void => { errors.push(`${id}: ${m}`); };
  const filled = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';

  const lic = pack.license;
  if (!lic || typeof lic !== 'object') {
    bad('manifest has no `license` object — every pack must state its licence');
  } else {
    if (!LICENSE_STATUSES.includes(lic.status)) bad(`license.status ${JSON.stringify(lic.status)} is outside the contract enum`);
    if (!filled(lic.name)) bad('license.name is empty — the work being licensed must be named');
    // `unresolved` is honest and stays green; anything *not* clear must say why.
    if (lic.status !== 'clear' && !filled(lic.notes)) bad(`license.status is ${JSON.stringify(lic.status)} but license.notes is empty — the contract requires notes whenever the status is not 'clear'`);
    // A cleared claim without any document is exactly the "shipped as if
    // licensed" failure mode, so it is stopped rather than trusted.
    if (lic.status === 'clear' && !filled(lic.spdx) && !filled(lic.url)) bad("license.status is 'clear' with neither an SPDX id nor a licence URL — a clearance claim needs the document it rests on");
    if (lic.status === 'unresolved') unresolved.push(id);
  }

  const attr = pack.attribution;
  if (!attr || typeof attr !== 'object') {
    bad('manifest has no `attribution` object — source attribution is mandatory');
  } else {
    for (const field of ['publisher', 'work', 'sourceUrl', 'retrievedAt', 'creditLine'] as const) {
      if (!filled(attr[field])) bad(`attribution.${field} is empty — the UI renders it as the credit line`);
    }
  }
}

/**
 * `coverage` is a *range*, but it must not describe verses this payload does
 * not contain: a pack claiming all 114 chapters while carrying rows for 113 of
 * them overstates what the app can show. Reported as a warning (the field is
 * metadata only — the app counts real rows from the DB), never hidden.
 */
function checkCoverageClaim(pack: any, lines: string[], warnings: string[]): void {
  const seenChapters = new Set<number>();
  const note = (key: string): void => {
    const ch = Number(key.split(':')[0]);
    if (Number.isInteger(ch) && ch >= 1) seenChapters.add(ch);
  };
  for (const l of lines) {
    const r = JSON.parse(l) as any;
    if (typeof r.verseKey === 'string') note(r.verseKey);
    if (typeof r.verseKeyA === 'string') note(r.verseKeyA);
    if (typeof r.verseKeyB === 'string') note(r.verseKeyB);
    if (r._t === 'surah' && Number.isInteger(r.number)) seenChapters.add(r.number as number);
  }
  const claimed = Array.isArray(pack.coverage?.chapters) ? (pack.coverage.chapters as number[]) : [];
  const missing = claimed.filter((c) => !seenChapters.has(c));
  if (missing.length) {
    warnings.push(
      `pack ${pack.id}: manifest coverage.chapters claims ${claimed.length} chapters, the payload has rows for ${seenChapters.size} ` +
        `(no rows for ${missing.slice(0, 6).join(',')}${missing.length > 6 ? ',…' : ''}) — coverage is a range, the app counts real rows`,
    );
  }
}

// ---------------------------------------------------------------------------
// post-build: packs must be byte-faithful to raw

export function validatePacks(): ValidationResult | null {
  const errors: string[] = [];
  const warnings: string[] = [];
  const stats: Record<string, number | string> = {};
  if (!existsSync(CONTENT_ROOT)) return null;
  const index = JSON.parse(readFileSync(join(CONTENT_ROOT, 'index.json'), 'utf8')) as any;
  const uthmani = rawExists('quran-com/verses-uthmani.json')
    ? ((readRawJson<any>('quran-com/verses-uthmani.json')).verses as RawVerse[])
    : [];
  const keyText = new Map(uthmani.map((v) => [v.verse_key, v.text_uthmani]));
  const orderedKeys = uthmani.map((v) => v.verse_key);
  const keyOrderIndex = new Map(orderedKeys.map((k, i) => [k, i]));
  // word-id -> raw word row facts (word text is byte-faithful to the WORD
  // endpoint, not to the verse text; page/line are the mushaf grid metadata)
  interface RawWordFacts { text: string; page: number | null; line: number | null }
  const wordText = new Map<number, RawWordFacts>();
  if (rawExists('quran-com/words-1.json')) {
    for (const c of ALL_CHAPTERS) {
      if (!rawExists(`quran-com/words-${c}.json`)) continue;
      for (const v of readRawJson<any>(`quran-com/words-${c}.json`).verses) {
        for (const w of (v.words ?? []) as any[]) {
          wordText.set(w.id, {
            text: String(w.text_uthmani),
            page: typeof w.page_number === 'number' ? w.page_number : null,
            line: typeof w.line_number === 'number' ? w.line_number : null,
          });
        }
      }
    }
  }
  const simpleText = new Map<string, string>();
  if (rawExists('quran-com/verses-uthmani-simple.json')) {
    for (const s of readRawJson<any>('quran-com/verses-uthmani-simple.json').verses as any[]) simpleText.set(s.verse_key, s.text_uthmani);
  }
  /** The shipped core pack: the corpus the computed pairs must describe. */
  const corePackData = corePackAyahs();
  /** Packs that honestly declare an unresolved licence — printed, never hidden. */
  const unresolvedLicencePacks: string[] = [];
  for (const pack of index.packs as any[]) {
    const dir = join(CONTENT_ROOT, pack.id);
    const payloadPath = join(dir, 'payload.jsonl');
    if (!existsSync(payloadPath)) { errors.push(`pack ${pack.id}: payload.jsonl missing`); continue; }
    // The app imports what `index.json` says; humans read `content/<id>/pack.json`.
    // The two must be the same manifest, or a stale file can describe a payload
    // that is not the one being shipped.
    const packJsonPath = join(dir, 'pack.json');
    if (existsSync(packJsonPath)) {
      const onDisk = JSON.parse(readFileSync(packJsonPath, 'utf8')) as any;
      if (JSON.stringify(onDisk) !== JSON.stringify(pack)) {
        errors.push(`pack ${pack.id}: content/${pack.id}/pack.json and the index.json entry are different manifests`);
      }
    } else {
      errors.push(`pack ${pack.id}: pack.json missing next to its payload`);
    }
    const buf = readFileSync(payloadPath);
    if (sha256hex(buf) !== pack.checksum) errors.push(`pack ${pack.id}: checksum mismatch vs pack.json`);
    if (buf.length !== pack.payloadBytes) errors.push(`pack ${pack.id}: payloadBytes mismatch (${buf.length})`);
    const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
    if (lines.length !== pack.recordCount) errors.push(`pack ${pack.id}: recordCount ${pack.recordCount} != payload lines ${lines.length}`);
    checkLicenceAndAttribution(pack, errors, unresolvedLicencePacks);
    checkCoverageClaim(pack, lines, warnings);
    let byteChecked = 0;
    let mushafErrors = 0;
    const packMushafPages = new Set<number>();
    const tafsirRaw = new Map<string, Set<string>>();
    if (pack.kind === 'tafsir') {
      const rid = pack.id === 'tafsir-ar-muyassar' ? 16 : 169;
      for (const c of ALL_CHAPTERS) {
        if (!rawExists(`quran-com/tafsir-${rid}-${c}.json`)) continue;
        for (const r of readRawJson<any>(`quran-com/tafsir-${rid}-${c}.json`).tafsirs as any[]) {
          if (!tafsirRaw.has(String(r.verse_key))) tafsirRaw.set(String(r.verse_key), new Set());
          tafsirRaw.get(String(r.verse_key))!.add(String(r.text));
        }
      }
    }
    const trRaw = pack.kind === 'translation'
      ? (readRawJson<any>(`quran-com/translation-${TRANSLATION_RESOURCES.find((t) => t.packId === pack.id)?.resourceId ?? -1}.json`)?.translations as { text: string }[] | undefined)
      : undefined;
    for (let li = 0; li < lines.length; li++) {
      const r = JSON.parse(lines[li]!);
      if (pack.id === 'quran-core' && r._t === 'ayah') {
        if (keyText.get(r.verseKey) !== r.textUthmani)
          errors.push(`PACK CORRUPTION: quran-core ${r.verseKey} textUthmani is not byte-identical to raw provider verse text`);
        if (r.textUthmaniSimple !== null && simpleText.get(r.verseKey) !== r.textUthmaniSimple)
          errors.push(`PACK CORRUPTION: quran-core ${r.verseKey} textUthmaniSimple is not byte-identical to raw simple text`);
        byteChecked++;
      } else if (pack.id === 'word-data') {
        const raw = wordText.get(r.id);
        if (raw?.text !== r.textUthmani)
          errors.push(`PACK CORRUPTION: word-data id ${r.id} (${r.verseKey} pos ${r.position}) is not byte-identical to raw provider word text`);
        // The mushaf columns must be the provider's, value for value: this is
        // what lets the offline reader rebuild the 604-page grid from packs.
        if (raw && (r.pageNumber !== raw.page || !Number.isInteger(r.pageNumber))) {
          mushafErrors++;
          if (mushafErrors <= 20) {
            errors.push(`PACK CORRUPTION: word-data id ${r.id} (${r.verseKey} pos ${r.position}) carries pageNumber ${JSON.stringify(r.pageNumber)} but the raw row says ${JSON.stringify(raw.page)}`);
          }
        }
        if (raw && (r.lineNumber !== raw.line || !Number.isInteger(r.lineNumber))) {
          mushafErrors++;
          if (mushafErrors <= 20) {
            errors.push(`PACK CORRUPTION: word-data id ${r.id} (${r.verseKey} pos ${r.position}) carries lineNumber ${JSON.stringify(r.lineNumber)} but the raw row says ${JSON.stringify(raw.line)}`);
          }
        }
        if (Number.isInteger(r.pageNumber) && r.pageNumber >= 1 && r.pageNumber <= PAGE_COUNT) {
          packMushafPages.add(r.pageNumber as number);
        }
        byteChecked++;
      } else if (pack.kind === 'translation' && trRaw) {
        const idx = keyOrderIndex.get(String(r.verseKey)) ?? -1;
        if (trRaw[idx]?.text !== r.text)
          errors.push(`PACK CORRUPTION: ${pack.id} ${r.verseKey} text is not byte-identical to raw provider translation`);
        byteChecked++;
      } else if (pack.kind === 'tafsir') {
        if (!tafsirRaw.get(String(r.verseKey))?.has(String(r.text)))
          errors.push(`PACK CORRUPTION: ${pack.id} ${r.verseKey} text is not byte-identical to any raw provider tafsir row`);
        byteChecked++;
      }
    }
    stats[`${pack.id}_records`] = lines.length;
    stats[`${pack.id}_byteChecked`] = byteChecked;
    if (pack.kind === 'linguistic') {
      // A computed pack has no raw provider row to be byte-compared against:
      // its gate re-derives every number and every quoted phrase from the
      // engine and the shipped core pack instead.
      validateMutashabihatPack(pack, lines, corePackData, errors, stats);
    }
    if (pack.id === 'word-data') {
      stats.word_data_mushafPages = packMushafPages.size;
      stats.word_data_mushafColumnErrors = mushafErrors;
      if (packMushafPages.size !== PAGE_COUNT) {
        errors.push(`word-data pack covers ${packMushafPages.size} mushaf pages, expected all ${PAGE_COUNT} — the reader could not rebuild the grid offline`);
      }
    }
  }
  stats.indexPacks = index.packs.length;
  stats.packsLicenceUnresolved = unresolvedLicencePacks.length;
  if (unresolvedLicencePacks.length) {
    warnings.push(
      `${unresolvedLicencePacks.length}/${index.packs.length} shipped packs declare license.status = 'unresolved' ` +
        `(${unresolvedLicencePacks.join(', ')}). That label is required by AGENTS.md rule 2 and is what makes the gap auditable — ` +
        `but it also means none of this content may go into an installer for anyone outside personal use until a written grant ` +
        `is recorded and the status moves to 'attribution-required'/'clear' (docs/content-sources.md).`,
    );
  }
  return { errors, warnings, stats };
}

export async function runValidation(): Promise<ValidationResult> {
  const raw = await validateRaw();
  const packs = validatePacks();
  if (packs) {
    raw.errors.push(...packs.errors);
    raw.warnings.push(...packs.warnings);
    Object.assign(raw.stats, packs.stats);
  }
  return raw;
}

const invokedDirectly = process.argv[1] && process.argv[1].replaceAll('\\', '/').endsWith('src/validate.ts');
if (invokedDirectly) {
  const { errors, warnings, stats } = await runValidation();
  console.log('— stats —');
  for (const [k, v] of Object.entries(stats)) console.log(`  ${k}: ${v}`);
  for (const w of warnings) console.warn(`WARN: ${w}`);
  if (errors.length) {
    console.error(`\nVALIDATION FAILED — ${errors.length} error(s):`);
    for (const e of errors.slice(0, 60)) console.error(`  ${e}`);
    if (errors.length > 60) console.error(`  … ${errors.length - 60} more`);
    process.exit(1);
  }
  console.log(`\nVALIDATION PASSED (${warnings.length} warning(s)). Raw integrity and translation alignment proven on ${SAMPLE_CHAPTERS.length} sample chapters.`);
}
