/**
 * tests/e2e/lib/packs.mjs — the shipped content read from `content/` itself.
 *
 * Used by the browser store: the web/dev shell keeps the packs in memory and
 * writes no content table, so the only reference a screen can be checked against
 * is the payload the app was given. That is PIPELINE evidence (the bytes the
 * content build produced), and every step that uses it says so in the report —
 * it is never presented as a database witness.
 *
 * `contentCounts` reads the pack manifests, not the payloads, so the counts the
 * importer must reach are the counts the build claims, straight from index.json.
 * Each payload is parsed at most once and only the fields the journey compares
 * are kept: the machine this suite runs on has little free memory.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { REPO_ROOT, readContentIndex } from './expected.mjs';

const CONTENT_DIRNAME = process.env.QURAN_CONTENT_DIR || path.join(REPO_ROOT, 'content');

export function contentDir() {
  return CONTENT_DIRNAME;
}

function lines(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

export class PackSource {
  constructor(dir = CONTENT_DIRNAME) {
    this.dir = dir;
    const { packs, expect } = readContentIndex(path.join(dir, 'index.json'));
    this.packs = packs;
    this.expect = expect;
    /** @type {Map<string, object[]>} */
    this.cache = new Map();
  }

  file(packId, name) {
    return path.join(this.dir, packId, name);
  }

  manifest(packId) {
    return this.packs.find((pack) => pack.id === packId) ?? null;
  }

  idsOfKind(kind) {
    return this.packs.filter((pack) => pack.kind === kind).map((pack) => pack.id);
  }

  /** Parse a payload once, keeping only the projection this kind of pack needs. */
  records(packId) {
    if (this.cache.has(packId)) return this.cache.get(packId);
    const manifest = this.manifest(packId);
    if (!manifest) throw new Error(`pack ${packId} is not in ${path.join(this.dir, 'index.json')}`);
    const kind = manifest.kind;
    const rows = lines(this.file(packId, 'payload.jsonl')).map((line) => {
      const record = JSON.parse(line);
      switch (kind) {
        case 'quran-core':
          return record._t === 'surah'
            ? { _t: 'surah', number: Number(record.number), ayahCount: Number(record.ayahCount) }
            : { _t: 'ayah', verse_key: String(record.verseKey), chapter: Number(record.chapter), verse: Number(record.verse), text_uthmani: String(record.textUthmani), text_simple: record.textSimple ?? null, page: record.page ?? null };
        case 'word-data':
          return {
            verse_key: String(record.verseKey),
            position: Number(record.position),
            text_uthmani: String(record.textUthmani),
            is_end_of_ayah_mark: record.isEndOfAyahMark ? 1 : 0,
          };
        case 'translation':
        case 'tafsir':
          return {
            verse_key: String(record.verseKey),
            pack_id: String(record.packId ?? packId),
            text: String(record.text),
            covers_verse_keys: record.coversVerseKeys ? JSON.stringify(record.coversVerseKeys) : null,
          };
        case 'linguistic':
          return {
            verse_key_a: String(record.verseKeyA),
            verse_key_b: String(record.verseKeyB),
            text_score: Number(record.textScore),
            shared_phrase: record.sharedPhrase ?? null,
          };
        default:
          return record;
      }
    });
    this.cache.set(packId, rows);
    return rows;
  }

  /* ------------------------------------------------------------ counts */

  contentCounts() {
    const core = this.records('quran-core');
    const translations = this.idsOfKind('translation').reduce((sum, id) => sum + this.records(id).length, 0);
    const tafsirs = this.idsOfKind('tafsir').reduce((sum, id) => sum + this.records(id).length, 0);
    const similar = this.idsOfKind('linguistic').reduce((sum, id) => sum + this.records(id).length, 0);
    return {
      surahs: core.filter((row) => row._t === 'surah').length,
      ayahs: core.filter((row) => row._t === 'ayah').length,
      words: this.records('word-data').length,
      translations,
      tafsirs,
      similar,
      packs: this.packs.length,
    };
  }

  /* ------------------------------------------------------------ lookups */

  surahAyahKeys(chapter) {
    return this.records('quran-core')
      .filter((row) => row._t === 'ayah' && row.chapter === Number(chapter))
      .sort((a, b) => a.verse - b.verse)
      .map((row) => row.verse_key);
  }

  wordsFor(verseKey) {
    return this.records('word-data')
      .filter((row) => row.verse_key === verseKey)
      .sort((a, b) => a.position - b.position)
      .map((row) => ({ position: row.position, text_uthmani: row.text_uthmani, is_end_of_ayah_mark: row.is_end_of_ayah_mark }));
  }

  translationsFor(verseKey) {
    const rows = [];
    for (const id of this.idsOfKind('translation')) {
      for (const row of this.records(id)) if (row.verse_key === verseKey) rows.push({ pack_id: row.pack_id, text: row.text });
    }
    return rows.sort((a, b) => a.pack_id.localeCompare(b.pack_id));
  }

  tafsirFor(verseKey) {
    const rows = [];
    for (const id of this.idsOfKind('tafsir')) {
      for (const row of this.records(id)) {
        if (row.verse_key !== verseKey) continue;
        rows.push({ verse_key: row.verse_key, pack_id: row.pack_id, text: row.text, covers_verse_keys: row.covers_verse_keys, title: this.manifest(row.pack_id)?.title ?? row.pack_id });
      }
    }
    return rows.sort((a, b) => a.pack_id.localeCompare(b.pack_id));
  }

  verseKeyWithTafsir(packId) {
    const rows = this.records(packId).slice().sort((a, b) => a.verse_key.localeCompare(b.verse_key, void 0, { numeric: true }));
    return rows.length ? rows[0].verse_key : null;
  }

  similarPairs(verseKey) {
    const partners = [];
    for (const id of this.idsOfKind('linguistic')) {
      for (const row of this.records(id)) {
        if (row.verse_key_a === verseKey) partners.push({ partner: row.verse_key_b, textScore: row.text_score });
        else if (row.verse_key_b === verseKey) partners.push({ partner: row.verse_key_a, textScore: row.text_score });
      }
    }
    return partners.sort((a, b) => b.textScore - a.textScore || a.partner.localeCompare(b.partner, void 0, { numeric: true }));
  }

  busiestSimilarKey() {
    const tally = new Map();
    for (const id of this.idsOfKind('linguistic')) {
      for (const row of this.records(id)) tally.set(row.verse_key_a, (tally.get(row.verse_key_a) ?? 0) + 1);
    }
    let best = null;
    for (const [verseKey, pairs] of tally) {
      if (!best || pairs > best.pairs || (pairs === best.pairs && verseKey.localeCompare(best.verseKey, void 0, { numeric: true }) < 0)) {
        best = { verseKey, pairs };
      }
    }
    return best;
  }

  /**
   * Upper bound on what any backend can answer for a raw substring: verses whose
   * Uthmani text or any shipped translation contains it. The app searches a
   * normalised, tokenised index built from these same rows, so a real result list
   * can only be a subset of this count.
   */
  searchHits(query) {
    const needle = String(query).trim();
    if (!needle) return 0;
    const keys = new Set();
    for (const row of this.records('quran-core')) {
      if (row._t !== 'ayah') continue;
      if (row.text_uthmani.includes(needle) || String(row.text_simple ?? '').includes(needle)) keys.add(row.verse_key);
    }
    for (const id of this.idsOfKind('translation')) {
      for (const row of this.records(id)) if (row.text.includes(needle)) keys.add(row.verse_key);
    }
    return keys.size;
  }
}
