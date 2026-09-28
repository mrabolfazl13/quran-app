/**
 * Download provider data into data/raw/quran-com/ — one JSON file per
 * endpoint call, resumable (existing valid files are skipped), provenance
 * recorded in data/raw/manifest.json (url, sha256, bytes, fetchedAt).
 *
 * Usage:
 *   node src/fetch.ts            # core + words + translations + samples + resource metadata
 *   node src/fetch.ts tafsirs    # the 228 per-chapter tafsir calls (run in background)
 *   node src/fetch.ts all        # everything in one process
 */
import {
  API_BASE,
  ALL_CHAPTERS,
  SAMPLE_CHAPTERS,
  TAFSIR_RESOURCES,
  TRANSLATION_RESOURCES,
  cachedValid,
  fetchJson,
  rawExists,
  rawPath,
  removeManifestEntries,
  writeRawJson,
} from './common.ts';

type Expect = (body: unknown) => boolean;

const isObj = (b: any, k: string): boolean => !!b && typeof b === 'object' && Array.isArray(b[k]) && (b[k] as unknown[]).length > 0;
const expectChapters: Expect = (b: any) => isObj(b, 'chapters') && b.chapters.length === 114;
const expectVersesFull: Expect = (b: any) => isObj(b, 'verses') && b.verses.length === 6236;
const expectVerses: Expect = (b: any) => isObj(b, 'verses');
/** divisions rows must carry the requested fields and NOT word arrays */
const expectDivPage: Expect = (b: any) =>
  expectVerses(b) && b.verses.every((v: any) => 'juz_number' in v && 'text_uthmani' in v && v.words === undefined);
/** word rows must carry words with char_type AND the mushaf grid metadata.
 *
 * `page_number` / `line_number` are not opt-in `word_fields` on the v4 API —
 * every word object the provider returns already carries them (measured over
 * all 114 captures: 83 665 / 83 665 rows have both). So the query is unchanged
 * and the requirement is enforced here instead: if a future response shape drops
 * the mushaf columns, this guard fails and `cachedValid` refuses to reuse the
 * stale capture, rather than the pack silently shipping words with no page. */
const expectWordPage: Expect = (b: any) =>
  expectVerses(b) &&
  b.verses.every(
    (v: any) =>
      Array.isArray(v.words) &&
      v.words.length > 0 &&
      v.words.every(
        (w: any) =>
          typeof w.char_type_name === 'string' &&
          typeof w.text_uthmani === 'string' &&
          Number.isInteger(w.page_number) &&
          (w.page_number as number) >= 1 &&
          (w.page_number as number) <= 604 &&
          Number.isInteger(w.line_number) &&
          (w.line_number as number) >= 1,
      ),
  );
const expectTranslations: Expect = (b: any) => isObj(b, 'translations') && b.translations.length === 6236;
const expectTafsirs: Expect = (b: any) => isObj(b, 'tafsirs');
const expectResources: Expect = (b: any) => isObj(b, 'translations') || isObj(b, 'tafsirs');

/** Paginate a per-chapter endpoint, merging pages into one {verses:[...]} file.
 * Temp pages are namespaced by `tag` so a leftover page from one query type can
 * never be reused for another (this contaminated divisions-89 once). */
async function fetchChapterPages(rel: string, baseQuery: string, chapter: number, tag: string, pageExpect: Expect): Promise<void> {
  // per_page up to 300 is honoured by the API (measured: ch.2 returns all 286
  // in one page), but we still follow pagination.next_page defensively.
  const perPage = 300;
  const urlBase = `${API_BASE}/verses/by_chapter/${chapter}?${baseQuery}&per_page=${perPage}`;
  const cached = cachedValid(rel, urlBase, pageExpect);
  if (cached.ok) return;
  let page = 1;
  const verses: any[] = [];
  for (;;) {
    const url = `${urlBase}&page=${page}`;
    const body: any = await fetchJson(`_tmp/${tag}-page-${chapter}-${page}.json`, url, pageExpect);
    verses.push(...body.verses);
    if (!body.pagination?.next_page) break;
    page = body.pagination.next_page;
  }
  const text = JSON.stringify({ verses });
  writeRawJson(rel, text, urlBase);
  const { rmSync } = await import('node:fs');
  for (let p = 1; p <= page; p++) {
    const t = `_tmp/${tag}-page-${chapter}-${p}.json`;
    if (rawExists(t)) rmSync(rawPath(t), { force: true });
  }
  removeManifestEntries((k) => k.startsWith(`_tmp/${tag}-page-${chapter}-`));
}

const DIVISION_FIELDS = 'text_uthmani,juz_number,page_number,hizb_number,rub_el_hizb_number,ruku_number,manzil_number,sajdah_number';
/**
 * Optional word fields only. The mushaf columns the layout engine needs
 * (`page_number`, `line_number`) are part of the default word object and are
 * asserted by `expectWordPage`, so this list is deliberately not the place
 * where they are requested — changing it would re-fetch all 114 captures for
 * bytes that are already on disk.
 */
const WORD_FIELDS = 'text_uthmani,translation,transliteration';

async function main(): Promise<void> {
  const mode = process.argv[2] ?? '';
  const doCore = mode === '' || mode === 'all';
  const doTafsirs = mode === 'tafsirs' || mode === 'all';
  const t0 = Date.now();
  let done = 0;
  const total =
    (doCore ? 2 + 1 + 1 + 3 + 3 * SAMPLE_CHAPTERS.length + 2 * 114 : 0) + (doTafsirs ? 2 * 114 : 0);
  const tick = (label: string) => {
    done++;
    if (done % 25 === 0 || done === total) console.log(`[${done}/${total}] ${label} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  };

  if (doCore) {
    console.log('— chapters + full text');
    await fetchJson('quran-com/chapters.json', `${API_BASE}/chapters`, expectChapters);
    tick('chapters');
    await fetchJson('quran-com/verses-uthmani.json', `${API_BASE}/quran/verses/uthmani`, expectVersesFull);
    tick('verses-uthmani');
    await fetchJson('quran-com/verses-uthmani-simple.json', `${API_BASE}/quran/verses/uthmani-simple`, expectVersesFull);
    tick('verses-uthmani-simple');

    console.log('— resource metadata snapshot (attribution/licensing evidence)');
    await fetchJson('quran-com/resources-translations.json', `${API_BASE}/resources/translations`, expectResources);
    tick('resources-translations');
    await fetchJson('quran-com/resources-tafsirs.json', `${API_BASE}/resources/tafsirs`, expectResources);
    tick('resources-tafsirs');

    console.log('— bulk translations (6236 rows each)');
    for (const { resourceId } of TRANSLATION_RESOURCES) {
      await fetchJson(`quran-com/translation-${resourceId}.json`, `${API_BASE}/quran/translations/${resourceId}`, expectTranslations);
      tick(`translation-${resourceId}`);
    }

    console.log('— divisions + word-by-word, per chapter');
    for (const c of ALL_CHAPTERS) {
      await fetchChapterPages(`quran-com/divisions-${c}.json`, `fields=${DIVISION_FIELDS}`, c, 'div', expectDivPage);
      tick(`divisions-${c}`);
      await fetchChapterPages(`quran-com/words-${c}.json`, `words=true&word_fields=${WORD_FIELDS}`, c, 'words', expectWordPage);
      tick(`words-${c}`);
    }

    console.log('— translation alignment sample chapters (proof files for validate)');
    for (const { resourceId } of TRANSLATION_RESOURCES) {
      for (const c of SAMPLE_CHAPTERS) {
        const url = `${API_BASE}/verses/by_chapter/${c}?translations=${resourceId}&fields=verse_key&per_page=300`;
        const rel = `quran-com/sample-translation-${resourceId}-${c}.json`;
        await fetchJson(rel, url, expectVerses);
        tick(rel);
      }
    }
  }

  if (doTafsirs) {
    console.log('— tafsirs per chapter');
    for (const { resourceId } of TAFSIR_RESOURCES) {
      for (const c of ALL_CHAPTERS) {
        const rel = `quran-com/tafsir-${resourceId}-${c}.json`;
        await fetchJson(rel, `${API_BASE}/tafsirs/${resourceId}/by_chapter/${c}`, expectTafsirs);
        tick(rel);
      }
    }
  }

  console.log(`fetch(${mode || 'core'}) complete: ${done} endpoints, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error('FETCH FAILED:', e);
  process.exit(1);
});
