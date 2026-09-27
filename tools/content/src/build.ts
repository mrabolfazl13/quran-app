/**
 * Build offline content packs into content/.
 *
 * Gate: runs the full validation first (raw integrity + translation
 * alignment); refuses to emit anything if it fails.
 *
 * Fidelity rule: every stored text field is copied byte-for-byte from the
 * raw provider JSON. Normalisation is used for comparison only, never for
 * what we store. Records are the contract shapes (camelCase) from
 * core/src/contracts so the importer inserts them without invention.
 * Mixed-type packs (quran-core) carry a `_t` discriminator per line.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALL_CHAPTERS,
  CONTENT_ROOT,
  SAMPLE_CHAPTERS,
  TAFSIR_RESOURCES,
  TRANSLATION_RESOURCES,
  readRawJson,
  rawExists,
  sha256hex,
} from './common.ts';
import { runValidation } from './validate.ts';
import type { Surah, Ayah, AyahWord, Translation, TafsirPassage, VerseKey } from '../../../core/src/contracts/quran.ts';
import type {
  ContentPackManifest,
  ContentLicense,
  ContentAttribution,
  PackIndex,
} from '../../../core/src/contracts/content-pack.ts';
import { CONTENT_PACK_SCHEMA_VERSION } from '../../../core/src/contracts/content-pack.ts';

const SOURCE_URL = 'https://api.quran.com/api/v4';
const GENERATOR = '@quran/content/src/build.ts v0.1.0';

type LicenseSpec = { license: ContentLicense; attribution: Omit<ContentAttribution, 'retrievedAt'> };

const notConfirmed = (what: string): string =>
  `NOT CONFIRMED for offline bundling: ${what}. The Quran.com v4 /resources endpoints expose no license field (verified on the fetched metadata snapshot), and Quran Foundation developer terms state "QF Content is not sold, sublicensed, or redistributed" and forbid storing content beyond 1 week without express permission. Bundling in a shipped installer therefore needs written permission; status stays 'unresolved' until obtained.`;

function lic(spdx: string | null, name: string, notes: string, publisher: string, work: string, edition: string | null, sourceUrl: string, creditLine: string): LicenseSpec {
  return {
    license: { spdx, name, url: sourceUrl, status: 'unresolved', notes },
    attribution: { publisher, work, edition, sourceUrl, creditLine },
  };
}

const LICENSES: Record<string, LicenseSpec> = {
  'quran-core': lic(
    null,
    'Quranic Arabic text (Uthmani) via Quran.com / King Fahd Complex Madinah Mushaf',
    notConfirmed('the scripture text itself is not copyrightable in the Islamic tradition, but this digitisation follows the King Fahd Complex Mushaf; no explicit license grant for offline redistribution was found in the API or on quran.com. Attribution to the Mushaf and to Quran.com is required regardless.'),
    'King Fahd Complex for the Printing of the Holy Qur’an (digitisation served by Quran.com / Quran Foundation)',
    'Uthmani text of the Qur’an (al-Mushaf al-Madinah)',
    'Hafs ‘an ‘Asim, Madinah script 1-114 chapter/6236 verse enumeration',
    'https://quran.com',
    'Qur’an text: King Fahd Complex for the Printing of the Holy Qur’an, Madinah al-Munawwarah; served via Quran.com (Quran Foundation).',
  ),
  'word-data': lic(
    null,
    'Word-by-word Qur’an data via Quran.com (text: King Fahd Complex mushaf; word glosses/transliterations curated by Quran.com)',
    notConfirmed('the per-word English glosses and transliterations are Quran.com editorial layers; no license is exposed in the API metadata.'),
    'Quran Foundation (word glosses); King Fahd Complex (Arabic word text)',
    'Word-by-word text, translations and transliteration',
    'Uthmani word segmentation with char_type word/end',
    'https://quran.com',
    'Word-by-word data from Quran.com (Quran Foundation); Qur’an word text: King Fahd Complex, Madinah Mushaf.',
  ),
  'tr-en-abdulhaleem': lic(
    null,
    'The Qur’an: A New Translation by M.A.S. Abdel Haleem — Oxford University Press, 2004/2005',
    notConfirmed('OUP holds rights in this translation; Quran.com serves it for online reading. No redistribution grant for offline bundling was found. Credit is mandatory under any scenario.'),
    'Oxford University Press (served via Quran.com)',
    'The Qur’an: A New Translation (M.A.S. Abdel Haleem)',
    '2004 (repr. 2005), ISBN 978-0-19-953577-2',
    'https://quran.com/translations/m-a-s-abdel-haleem',
    'Translation: “The Qur’an”, M.A.S. Abdel Haleem, Oxford University Press. © OUP, used here pending written permission for offline redistribution.',
  ),
  'tr-fa-islamhouse': lic(
    null,
    'Persian translation published by IslamHouse.com (Foundation for Media Production and Distribution)',
    notConfirmed('IslamHouse generally permits non-commercial propagation with attribution, but their exact current terms could not be retrieved from this environment, and the API exposes no license field for resource 135.'),
    'IslamHouse.com (Foundation for Media Production and Distribution)',
    'Persian translation of the Qur’an (IslamHouse)',
    'API resource id 135, served by Quran.com',
    'https://islamhouse.com',
    'Persian translation © IslamHouse.com; redistribution subject to IslamHouse conditions — permission to confirm.',
  ),
  'tr-fa-kaldari': lic(
    null,
    'Persian (Tajalli-style) translation by Hussein Taji Kal Dari',
    notConfirmed('no publisher, edition or license statement could be located for this translation; the API metadata carries only the author name (resource id 29). This is the least-resolved resource in the set.'),
    'Hussein Taji Kal Dari (served via Quran.com)',
    'Persian translation of the Qur’an',
    'API resource id 29',
    'https://quran.com',
    'Translation by Hussein Taji Kal Dari, via Quran.com. Publisher/edition/licence unknown — confirm before shipping.',
  ),
  'tafsir-ar-muyassar': lic(
    null,
    'Tafsir al-Muyassar (التفسير الميسر) — committee edition',
    notConfirmed('the work is prepared by a committee of scholars and widely distributed free of charge, but the copy served by Quran.com (resource id 16) has no exposed license record. Confirm a publisher grant for offline bundling.'),
    'Prepared by a group of scholars; served via Quran.com',
    'Tafsir al-Muyassar',
    'API resource id 16 (arabic), grouped commentary (1013 passages)',
    'https://quran.com',
    'Tafsir al-Muyassar, Arabic; via Quran.com.',
  ),
  'tafsir-en-ibnkathir': lic(
    null,
    'Tafsir Ibn Kathir (abridged), English — abridgement associated with Dar-us-Salam publication',
    notConfirmed('the English abridgement is a modern derivative work (abridged by M. S. Al-Jabbari / editorial team; Dar-us-Salam holds publishing rights for the abridged set). No license is exposed in API metadata (resource id 169); text ships as HTML fragments from the provider.'),
    'Hafiz Ibn Kathir (author); abridgement served via Quran.com',
    'Tafsir Ibn Kathir (Abridged)',
    'API resource id 169 (english), 300 non-empty grouped passages',
    'https://quran.com',
    'Tafsir Ibn Kathir (abridged), English; via Quran.com.',
  ),
};

interface BuiltPack {
  dir: string;
  manifest: ContentPackManifest;
  payload: string;
}

function buildPayload(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

function emittedAt(): string {
  return new Date().toISOString();
}

function allChaptersCover(): { chapters: number[]; verseKeysFrom: string; verseKeysTo: string } {
  return { chapters: ALL_CHAPTERS, verseKeysFrom: '1:1', verseKeysTo: '114:6' };
}

function makeManifest(
  id: string,
  kind: ContentPackManifest['kind'],
  language: ContentPackManifest['language'],
  title: string,
  spec: LicenseSpec,
  payload: string,
  recordCount: number,
  retrievedAt: string,
): ContentPackManifest {
  const buf = Buffer.from(payload, 'utf8');
  return {
    id,
    kind,
    version: '1.0.0',
    schemaVersion: CONTENT_PACK_SCHEMA_VERSION,
    language,
    title,
    source: SOURCE_URL,
    license: spec.license,
    attribution: { ...spec.attribution, retrievedAt },
    checksum: sha256hex(buf),
    payloadBytes: buf.length,
    recordCount,
    coverage: allChaptersCover(),
    generatedAt: emittedAt(),
    generator: GENERATOR,
  };
}

function earliestFetchedAt(deps: string[]): string {
  let m = readRawJson<{ files: Record<string, { fetchedAt: string }> }>('manifest.json');
  let best: string | null = null;
  for (const rel of deps) {
    const rec = m.files[rel];
    if (rec && (!best || rec.fetchedAt < best)) best = rec.fetchedAt;
  }
  return best ?? emittedAt();
}

async function main(): Promise<void> {
  // ---- gate: validation must pass on raw data before anything is emitted ----
  console.log('running validation gate…');
  const { errors, warnings, stats } = await runValidation();
  if (errors.length) {
    console.error(`BUILD ABORTED — validation failed with ${errors.length} error(s):`);
    for (const e of errors.slice(0, 30)) console.error(`  ${e}`);
    process.exit(1);
  }
  for (const w of warnings) console.warn(`  warn: ${w}`);
  console.log('validation gate passed.', JSON.stringify(stats));

  // ---- load raw ----
  const chapters = readRawJson<any>('quran-com/chapters.json').chapters as any[];
  const uthmani = readRawJson<any>('quran-com/verses-uthmani.json').verses as { id: number; verse_key: string; text_uthmani: string }[];
  const simple = rawExists('quran-com/verses-uthmani-simple.json')
    ? ((readRawJson<any>('quran-com/verses-uthmani-simple.json').verses as { verse_key: string; text_uthmani: string }[]))
    : [];
  const simpleBy = new Map(simple.map((s) => [s.verse_key, s.text_uthmani]));

  const divBy = new Map<string, any>();
  for (const c of ALL_CHAPTERS) {
    for (const v of readRawJson<any>(`quran-com/divisions-${c}.json`).verses) divBy.set(String(v.verse_key), v);
  }

  // ---- pack: quran-core (surahs + ayahs + divisions) ----
  const surahRecs: (Surah & { _t: 'surah' })[] = chapters.map((c) => {
    const first = `${c.id}:1` as VerseKey;
    const last = `${c.id}:${c.verses_count}` as VerseKey;
    const tn = (c.translated_name?.language_name ?? '').toLowerCase();
    return {
      _t: 'surah',
      number: c.id,
      nameArabic: c.name_arabic,
      nameSimple: c.name_simple,
      nameTransliterated: c.name_complex,
      translationFa: null, // no per-surah Persian name from the used endpoints
      translationEn: tn === 'english' ? (c.translated_name?.name ?? null) : null,
      revelationPlace: String(c.revelation_place).toLowerCase() === 'madinah' ? 'madinah' : 'makkah',
      revelationOrder: c.revelation_order,
      ayahCount: c.verses_count,
      pagesFrom: c.pages[0],
      pagesTo: c.pages[1],
      firstVerseKey: first,
      lastVerseKey: last,
      bismillahPre: c.bismillah_pre === true,
    };
  });
  const ayahRecs: (Ayah & { _t: 'ayah' })[] = uthmani.map((v) => {
    const [ch, ver] = v.verse_key.split(':').map(Number);
    const d = divBy.get(v.verse_key)!;
    return {
      _t: 'ayah',
      verseKey: v.verse_key as VerseKey,
      chapter: ch,
      verse: ver,
      sourceId: v.id,
      juz: d.juz_number,
      hizb: d.hizb_number,
      rubElHizb: d.rub_el_hizb_number,
      sajda: d.sajdah_number ?? null,
      ruku: d.ruku_number ?? null,
      manzil: d.manzil_number ?? null,
      page: d.page_number,
      // byte-for-byte provider text; never normalised, trimmed or joined
      textUthmani: v.text_uthmani,
      textUthmaniSimple: simpleBy.get(v.verse_key) ?? null,
    };
  });
  const corePayload = buildPayload([...surahRecs, ...ayahRecs]);
  const coreDeps = ['quran-com/chapters.json', 'quran-com/verses-uthmani.json', 'quran-com/verses-uthmani-simple.json', ...ALL_CHAPTERS.map((c) => `quran-com/divisions-${c}.json`)];

  // ---- pack: word-data ----
  const wordRecs: AyahWord[] = [];
  for (const c of ALL_CHAPTERS) {
    const body = readRawJson<any>(`quran-com/words-${c}.json`);
    for (const v of body.verses as any[]) {
      const key = String(v.verse_key) as VerseKey;
      let wordPos = 0;
      let endPos = 0;
      const entries: AyahWord[] = [];
      for (const w of v.words as any[]) {
        const isEnd = w.char_type_name === 'end';
        if (!isEnd) wordPos += 1;
        entries.push({
          id: w.id,
          verseKey: key,
          position: isEnd ? wordPos + 1 + endPos++ : wordPos,
          textUthmani: w.text_uthmani,
          translationEn: w.translation?.language_name === 'english' ? (w.translation.text ?? null) : null,
          transliteration: w.transliteration?.language_name === 'english' ? (w.transliteration.text ?? null) : null,
          root: null,
          morphology: null,
          isEndOfAyahMark: isEnd,
        });
      }
      wordRecs.push(...entries);
    }
  }
  const wordPayload = buildPayload(wordRecs);

  // ---- packs: translations ----
  const orderedKeys = uthmani.map((v) => v.verse_key); // alignment proven by validate
  const builtTranslation: Record<number, BuiltPack> = {};
  for (const { resourceId, packId } of TRANSLATION_RESOURCES) {
    const rows = readRawJson<any>(`quran-com/translation-${resourceId}.json`).translations as { text: string }[];
    const recs: Translation[] = rows.map((r, i) => ({ verseKey: orderedKeys[i]! as VerseKey, packId, text: r.text }));
    const payload = buildPayload(recs);
    const spec = LICENSES[packId];
    builtTranslation[resourceId] = {
      dir: packId,
      payload,
      manifest: makeManifest(packId, 'translation', resourceId === 85 ? 'en' : 'fa', spec.attribution.work, spec, payload, recs.length, earliestFetchedAt([`quran-com/translation-${resourceId}.json`])),
    };
  }

  // ---- packs: tafsirs (only when fully fetched) ----
  const builtTafsir: BuiltPack[] = [];
  for (const { resourceId, packId } of TAFSIR_RESOURCES) {
    const complete = ALL_CHAPTERS.every((c) => rawExists(`quran-com/tafsir-${resourceId}-${c}.json`));
    if (!complete) {
      console.warn(`tafsir ${packId}: fetch incomplete, pack OMITTED`);
      continue;
    }
    const recs: TafsirPassage[] = [];
    let droppedEmpty = 0;
    for (const c of ALL_CHAPTERS) {
      const rows = readRawJson<any>(`quran-com/tafsir-${resourceId}-${c}.json`).tafsirs as any[];
      rows.sort((a, b) => a.verse_key.localeCompare(b.verse_key, 'en', { numeric: true }));
      for (const r of rows) {
        if (typeof r.text !== 'string' || !r.text.trim()) { droppedEmpty++; continue; }
        recs.push({ verseKey: String(r.verse_key) as VerseKey, packId, text: r.text, coversVerseKeys: [String(r.verse_key) as VerseKey] });
      }
    }
    const payload = buildPayload(recs);
    const spec = LICENSES[packId];
    builtTafsir.push({
      dir: packId,
      payload,
      manifest: makeManifest(packId, 'tafsir', resourceId === 16 ? 'ar' : 'en', spec.attribution.work, spec, payload, recs.length, earliestFetchedAt(ALL_CHAPTERS.map((c) => `quran-com/tafsir-${resourceId}-${c}.json`))),
    });
    console.log(`tafsir ${packId}: ${recs.length} passages (${droppedEmpty} empty provider rows dropped)`);
  }

  // ---- write everything ----
  const packs: BuiltPack[] = [
    {
      dir: 'quran-core',
      payload: corePayload,
      manifest: makeManifest('quran-core', 'quran-core', 'ar', 'Qur’an: Uthmani text, surah metadata and divisions', LICENSES['quran-core'], corePayload, surahRecs.length + ayahRecs.length, earliestFetchedAt(coreDeps)),
    },
    {
      dir: 'word-data',
      payload: wordPayload,
      manifest: makeManifest('word-data', 'word-data', 'ar', 'Word-by-word Uthmani text with English glosses and transliteration', LICENSES['word-data'], wordPayload, wordRecs.length, earliestFetchedAt(ALL_CHAPTERS.map((c) => `quran-com/words-${c}.json`))),
    },
    ...TRANSLATION_RESOURCES.map(({ resourceId }) => builtTranslation[resourceId]!),
    ...builtTafsir,
  ];

  mkdirSync(CONTENT_ROOT, { recursive: true });
  for (const p of packs) {
    const dir = join(CONTENT_ROOT, p.dir);
    mkdirSync(dir, { recursive: true });
    const payloadPath = join(dir, 'payload.jsonl');
    const tmp = payloadPath + '.tmp';
    writeFileSync(tmp, p.payload, 'utf8');
    renameSync(tmp, payloadPath);
    // manifest checksum must match the bytes we just wrote
    const written = readFileSync(payloadPath);
    if (sha256hex(written) !== p.manifest.checksum) throw new Error(`checksum drift for pack ${p.dir}`);
    if (written.length !== p.manifest.payloadBytes) throw new Error(`byte-length drift for pack ${p.dir}`);
    writeFileSync(join(dir, 'pack.json'), JSON.stringify(p.manifest, null, 2) + '\n', 'utf8');
  }
  const index: PackIndex = { schemaVersion: CONTENT_PACK_SCHEMA_VERSION, builtAt: emittedAt(), packs: packs.map((p) => p.manifest) };
  writeFileSync(join(CONTENT_ROOT, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');

  console.log(`\nwrote ${packs.length} packs:`);
  for (const p of packs) console.log(`  ${p.dir}: records=${p.manifest.recordCount} bytes=${p.manifest.payloadBytes} sha=${p.manifest.checksum.slice(0, 16)}…`);
  console.log('content/index.json written.');
}

main().catch((e) => {
  console.error('BUILD FAILED:', e);
  process.exit(1);
});
