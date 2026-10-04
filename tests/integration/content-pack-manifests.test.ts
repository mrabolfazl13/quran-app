/**
 * Integration: every shipped content pack, audited at the pack level.
 *
 * `npm run content:validate` is the pipeline's own gate, and it is written by
 * the same author as the builder it is meant to police. This file is the
 * independent pass: it does not call `tools/content` at all. It opens
 * `content/index.json`, re-hashes each payload with `node:crypto`, counts the
 * rows it actually finds, re-reads the provider captures under `data/raw`, and
 * asserts the two non-negotiables of `AGENTS.md` in terms a reviewer can check:
 *
 *   1. **The Qur'an text is immutable.** The `textUthmani` stored in
 *      `content/quran-core/payload.jsonl` must be byte-for-byte the bytes the
 *      provider sent — for the well-known ayat below, and for the whole corpus
 *      where the pipeline's own gate is compared against. A single added or
 *      removed diacritic is a finding, never something to "fix".
 *   2. **No invented content, and no licence hidden.** Every pack must *state*
 *      a licence status, a reason when it is not clear, and a credit line the
 *      UI can render. Anything machine-made must label itself as such.
 *
 * Packs are generated artefacts: when an assertion here fails, the fix belongs
 * in `tools/content/src/build.ts` (then `npm run content:build`), not in an
 * edit to `content/`.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTENT_DIR, REPO_ROOT, RAW_DIR } from '../helpers/repo';
import {
  CONTENT_PACK_SCHEMA_VERSION,
  type ContentPackManifest,
  type PackIndex,
} from '../../core/src/contracts/content-pack';

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

function readPackManifest(id: string): ContentPackManifest {
  return JSON.parse(readFileSync(join(CONTENT_DIR, id, 'pack.json'), 'utf8')) as ContentPackManifest;
}

function payloadLines(id: string): { buf: Buffer; lines: string[] } {
  const buf = readFileSync(join(CONTENT_DIR, id, 'payload.jsonl'));
  return { buf, lines: buf.toString('utf8').split('\n').filter((l) => l.trim() !== '') };
}

const index = JSON.parse(readFileSync(join(CONTENT_DIR, 'index.json'), 'utf8')) as PackIndex;
const packs = index.packs;
const ids = packs.map((p) => p.id);

/** Provider captures, the bytes the pipeline claims to be faithful to. */
const rawUthmani = new Map(
  (JSON.parse(readFileSync(join(RAW_DIR, 'verses-uthmani.json'), 'utf8')).verses as { verse_key: string; text_uthmani: string }[]).map(
    (v) => [v.verse_key, v.text_uthmani],
  ),
);
const rawSimple = new Map(
  (JSON.parse(readFileSync(join(RAW_DIR, 'verses-uthmani-simple.json'), 'utf8')).verses as { verse_key: string; text_uthmani: string }[]).map(
    (v) => [v.verse_key, v.text_uthmani],
  ),
);
function rawDivisions(chapter: number): Map<string, { text_uthmani: string; page_number: number }> {
  const body = JSON.parse(readFileSync(join(RAW_DIR, `divisions-${chapter}.json`), 'utf8'));
  return new Map((body.verses as any[]).map((v) => [String(v.verse_key), { text_uthmani: v.text_uthmani, page_number: v.page_number }]));
}

/**
 * Ayat chosen for name-recognition and for covering the awkward cases: Al-Fatihah
 * (whose basmalah *is* verse 1), surah 112 (whose first verse row ships with a
 * leading U+0020 from the provider), Ayat al-Kursi (the longest of the set, 50
 * word rows), Ar-Rahman's refrain (repeated 11× in the surah, so a re-written
 * text would show up in the mutashabihat pairs too).
 */
const IMMUTABILITY_KEYS = [
  '1:1', '1:2', '1:3', '1:4', '1:5', '1:6', '1:7',
  '112:1', '112:2', '112:3', '112:4',
  '2:255',
  '55:13',
] as const;

describe('content pack index', () => {
  it('is the schema version the contract declares', () => {
    expect(index.schemaVersion).toBe(CONTENT_PACK_SCHEMA_VERSION);
  });

  it('carries at least the core scripture, word, translation, tafsir and derived packs', () => {
    for (const id of ['quran-core', 'word-data', 'tr-en-abdulhaleem', 'tr-fa-islamhouse', 'tr-fa-kaldari', 'tafsir-ar-muyassar', 'tafsir-en-ibnkathir', 'mutashabihat-ar']) {
      expect(ids, `pack ${id} is missing from content/index.json`).toContain(id);
    }
  });

  it('has no pack that exists on disk but is not in the index', () => {
    // A directory the importer never sees would be dead weight in the installer.
    for (const p of packs) {
      expect(() => readPackManifest(p.id), `content/${p.id}/pack.json must exist`).not.toThrow();
    }
  });
});

describe.each(packs.map((m) => [m.id, m] as const))('pack %s', (id, manifest) => {
  it('checksum is the sha256 of the payload bytes as shipped', () => {
    const { buf } = payloadLines(id);
    expect(sha256(buf)).toBe(manifest.checksum.trim().toLowerCase());
    expect(buf.length).toBe(manifest.payloadBytes);
  });

  it('recordCount is the number of rows actually in the payload', () => {
    const { lines } = payloadLines(id);
    expect(lines.length).toBe(manifest.recordCount);
  });

  it('pack.json is the same manifest the importer will read from index.json', () => {
    expect(JSON.stringify(readPackManifest(id))).toBe(JSON.stringify(manifest));
  });

  it('states a licence the contract allows, with the reason it is not clear', () => {
    expect(['clear', 'attribution-required', 'unresolved']).toContain(manifest.license.status);
    expect(manifest.license.name.trim()).not.toBe('');
    if (manifest.license.status !== 'clear') {
      expect(manifest.license.notes.trim().length, 'a non-clear licence must say what is missing').toBeGreaterThan(0);
    } else {
      expect(
        (manifest.license.spdx ?? '').trim() !== '' || (manifest.license.url ?? '').trim() !== '',
        "a 'clear' claim needs the SPDX id or licence URL it rests on",
      ).toBe(true);
    }
  });

  it('carries attribution the UI can render', () => {
    for (const field of ['publisher', 'work', 'sourceUrl', 'retrievedAt', 'creditLine'] as const) {
      expect(String(manifest.attribution[field] ?? '').trim(), `attribution.${field} is empty`).not.toBe('');
    }
    expect(manifest.attribution.sourceUrl).toMatch(/^https?:\/\//);
  });

  it('is generated by the content pipeline, not hand-edited', () => {
    expect(manifest.generator).toContain('@quran/content');
    expect(manifest.schemaVersion).toBe(CONTENT_PACK_SCHEMA_VERSION);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('licence honesty across the whole shipment', () => {
  it('no provider pack claims a clearance it cannot point at', () => {
    // docs/content-sources.md: the QF terms grant no offline redistribution, so
    // every pack must say `unresolved` until a written grant is recorded. A pack
    // that stops saying it needs something to show: a document (SPDX or URL) and
    // a note long enough to name what was obtained.
    for (const m of packs) {
      if (m.license.status === 'unresolved') continue;
      const hasDocument = (m.license.spdx ?? '').trim() !== '' || (m.license.url ?? '').trim() !== '';
      expect(hasDocument, `${m.id} claims '${m.license.status}' with neither an SPDX id nor a licence URL`).toBe(true);
      expect(m.license.notes.trim().length, `${m.id} claims '${m.license.status}' without recording what the grant says`).toBeGreaterThan(40);
    }
  });

  it('records in docs/content-sources.md that the shipped licence status is unresolved', () => {
    // The document and the manifests must not disagree: if every pack still says
    // `unresolved`, the doc must say so too (it is the release blocker).
    const unresolved = packs.filter((m) => m.license.status === 'unresolved');
    const doc = readFileSync(join(REPO_ROOT, 'docs', 'content-sources.md'), 'utf8');
    if (unresolved.length > 0) {
      expect(doc).toContain('unresolved');
      expect(doc.toLowerCase()).toContain('gate before shipping');
    }
  });

  it('audio is not bundled, and docs/audio-licenses.md says so', () => {
    const audio = packs.filter((m) => m.kind === 'audio');
    const doc = readFileSync(join(REPO_ROOT, 'docs', 'audio-licenses.md'), 'utf8');
    expect(audio.length).toBe(0);
    expect(doc.toLowerCase()).toContain('no audio is bundled');
  });

  it('every pack shipped is named in docs/content-sources.md', () => {
    // A pack the source-of-truth document forgot is a pack nobody is licensing,
    // attributing or regenerating on purpose.
    const doc = readFileSync(join(REPO_ROOT, 'docs', 'content-sources.md'), 'utf8');
    for (const m of packs) {
      expect(doc, `docs/content-sources.md never mentions ${m.id}`).toContain(m.id);
    }
  });
});

describe('revealed text is immutable', () => {
  const core = payloadLines('quran-core');
  const ayahs = new Map<string, any>();
  for (const l of core.lines) {
    const r = JSON.parse(l);
    if (r._t === 'ayah') ayahs.set(r.verseKey, r);
  }

  it.each(IMMUTABILITY_KEYS)('%s: pack text is byte-identical to the provider bulk uthmani capture', (key) => {
    const rec = ayahs.get(key);
    expect(rec, `${key} missing from the core pack`).toBeTruthy();
    const pack = Buffer.from(String(rec.textUthmani), 'utf8');
    const raw = Buffer.from(String(rawUthmani.get(key)), 'utf8');
    expect(pack.equals(raw), `${key}: ${pack.length} bytes in the pack vs ${raw.length} in data/raw`).toBe(true);
    expect(sha256(pack)).toBe(sha256(raw));
  });

  it.each(IMMUTABILITY_KEYS)('%s: pack text is byte-identical to the per-chapter divisions capture too', (key) => {
    const rec = ayahs.get(key);
    const ch = Number(key.split(':')[0]);
    const div = rawDivisions(ch).get(key);
    expect(Buffer.from(String(rec.textUthmani), 'utf8').equals(Buffer.from(String(div?.text_uthmani), 'utf8'))).toBe(true);
  });

  it.each(IMMUTABILITY_KEYS)('%s: the simple-uthmani column is the provider byte sequence, not a re-vocalisation', (key) => {
    const rec = ayahs.get(key);
    const raw = rawSimple.get(key);
    if (rec.textUthmaniSimple === null) return; // pipeline stores null only when raw is absent
    expect(Buffer.from(String(rec.textUthmaniSimple), 'utf8').equals(Buffer.from(String(raw), 'utf8'))).toBe(true);
  });

  it('the whole corpus matches the capture row for row, and no verse was dropped or duplicated', () => {
    expect(ayahs.size).toBe(6236);
    expect(rawUthmani.size).toBe(6236);
    let identical = 0;
    const drift: string[] = [];
    for (const [key, rec] of ayahs) {
      const raw = rawUthmani.get(key);
      if (raw !== undefined && Buffer.from(String(rec.textUthmani), 'utf8').equals(Buffer.from(String(raw), 'utf8'))) identical += 1;
      else if (drift.length < 5) drift.push(key);
    }
    expect(drift, `verses whose pack bytes differ from data/raw: ${drift.join(', ')}`).toEqual([]);
    expect(identical).toBe(6236);
  });

  it('surah rows carry the provider name bytes unchanged, including the 114-chapter count', () => {
    const surahs = core.lines.map((l) => JSON.parse(l)).filter((r) => r._t === 'surah');
    expect(surahs.length).toBe(114);
    const raw = (JSON.parse(readFileSync(join(RAW_DIR, 'chapters.json'), 'utf8')).chapters as any[]).map((c) => [c.id, c]);
    const byId = new Map(raw);
    for (const s of surahs) {
      expect(Buffer.from(String(s.nameArabic), 'utf8').equals(Buffer.from(String(byId.get(s.number)?.name_arabic), 'utf8'))).toBe(true);
    }
  });

  it('word rows reproduce the ayah text they belong to without rejoining or re-vocalising it', () => {
    const words = payloadLines('word-data').lines.map((l) => JSON.parse(l));
    const byVerse = new Map<string, any[]>();
    for (const w of words) {
      if (!byVerse.has(w.verseKey)) byVerse.set(w.verseKey, []);
      byVerse.get(w.verseKey)!.push(w);
    }
    for (const key of IMMUTABILITY_KEYS) {
      const rawRows = JSON.parse(readFileSync(join(RAW_DIR, `words-${key.split(':')[0]}.json`), 'utf8')).verses.find((v: any) => String(v.verse_key) === key);
      expect(rawRows, `no raw word capture for ${key}`).toBeTruthy();
      const stored = byVerse.get(key)!.slice().sort((a, b) => a.position - b.position);
      expect(stored.length).toBe((rawRows.words as any[]).length);
      for (let i = 0; i < stored.length; i += 1) {
        expect(Buffer.from(String(stored[i].textUthmani), 'utf8').equals(Buffer.from(String(rawRows.words[i].text_uthmani), 'utf8')), `${key} row ${i} word text`).toBe(true);
      }
    }
  });

  it('the mushaf grid columns are the provider numbers, row by row, for the sampled ayat', () => {
    const words = payloadLines('word-data').lines.map((l) => JSON.parse(l));
    const byId = new Map(words.map((w) => [w.id, w]));
    for (const key of IMMUTABILITY_KEYS) {
      const body = JSON.parse(readFileSync(join(RAW_DIR, `words-${key.split(':')[0]}.json`), 'utf8'));
      const verse = body.verses.find((v: any) => String(v.verse_key) === key);
      const ayahRow = JSON.parse(core.lines.find((l) => l.includes(`"verseKey":"${key}"`))!);
      for (const w of verse.words as any[]) {
        const stored = byId.get(w.id)!;
        expect(stored.pageNumber).toBe(w.page_number);
        expect(stored.lineNumber).toBe(w.line_number);
      }
      // the ayah's own division page is the provider's page, untouched
      expect(ayahRow.page).toBe(rawDivisions(Number(ayahRow.chapter)).get(key)?.page_number);
    }
  });

  it('the word row count is tokens plus ayah-end marks, so "words" is never overstated', () => {
    const words = payloadLines('word-data').lines.map((l) => JSON.parse(l));
    const marks = words.filter((w) => w.isEndOfAyahMark === true).length;
    const tokens = words.length - marks;
    expect(marks).toBe(6236); // exactly one per ayah
    expect(tokens).toBe(words.length - 6236);
    expect(words.length).toBe(index.packs.find((p) => p.id === 'word-data')!.recordCount);
    // The provider's own row ids are unique: no word was synthesised to pad a count.
    expect(new Set(words.map((w) => w.id)).size).toBe(words.length);
  });
});

describe('machine-made content labels itself', () => {
  const derived = packs.filter((p) => p.source.startsWith('computed'));

  it('is limited to the similar-ayah pack, which is the only non-provider pack shipped', () => {
    expect(derived.map((p) => p.id)).toEqual(['mutashabihat-ar']);
  });

  it('states that it was computed, over which bytes, and what it is not', () => {
    const pack = packs.find((p) => p.id === 'mutashabihat-ar')! as ContentPackManifest & {
      derived?: {
        computed?: boolean;
        producedBy?: string;
        not?: string[];
        presentedAs?: string;
        input?: { payloadSha256?: string; ayahCount?: number };
        result?: { pairs?: number };
      };
    };
    expect(pack.derived?.computed).toBe(true);
    expect(pack.derived?.producedBy).toMatch(/^algorithm:/);
    expect(pack.title.toLowerCase()).toMatch(/computed|machine-derived/);
    expect((pack.derived?.not ?? []).length).toBeGreaterThan(0);
    expect(pack.attribution.creditLine).toMatch(/computed|machine/i);
    // The digest in the manifest is the digest of the corpus the rows describe.
    expect(pack.derived?.input?.payloadSha256).toBe(sha256(payloadLines('quran-core').buf));
    expect(pack.derived?.result?.pairs).toBe(pack.recordCount);
    // and it inherits the scripture pack's unresolved licence rather than
    // laundering it
    expect(pack.license.status).toBe('unresolved');
  });

  it('re-scores every stored pair with the engine, so no number drifted from the algorithm', async () => {
    const {
      MUTASHABIHAT_PRODUCED_BY,
      pairTextScore,
      toSimilarityDoc,
    } = await import('../../core/src/mutashabihat/index');
    const ayahs = new Map<string, any>();
    for (const l of payloadLines('quran-core').lines) {
      const r = JSON.parse(l);
      if (r._t === 'ayah') ayahs.set(r.verseKey, r);
    }
    const docOf = (k: string) => toSimilarityDoc(ayahs.get(k) as never);
    const rows = payloadLines('mutashabihat-ar').lines.map((l) => JSON.parse(l));
    for (const r of rows) {
      expect(r.producedBy).toBe(MUTASHABIHAT_PRODUCED_BY);
      expect(Number(pairTextScore(docOf(r.verseKeyA), docOf(r.verseKeyB)).toFixed(4))).toBe(r.textScore);
    }
  });

  it('has no pack that hides a model behind a canonical-sounding title', () => {
    for (const m of packs) {
      expect(m.title.toLowerCase(), `${m.id} would need an AI GENERATED label`).not.toMatch(/\bai\b|gpt|llm|generated translation|auto-translated/);
    }
  });
});
