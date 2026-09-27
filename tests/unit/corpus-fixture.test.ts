import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeWord, normalizedText, tokenizeWords, wordCount } from '../../core/src/normalize/arabic';

/**
 * The shared corpus fixture: 31 real ayahs lifted from the captured provider
 * responses, including the repeated refrains of ar-Rahman (55), al-Mursalat (77)
 * and ash-Shu'ara (26). Every module under test — memory engine, similarity,
 * search, integrity — reads the same real text from here, so a pass in one
 * module cannot disagree with another about what the words are.
 */

interface FixtureAyah {
  verseKey: string;
  chapter: number;
  verse: number;
  textUthmani: string;
  translationEn: string;
  translationFa: string;
  normalized: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const path = join(here, '..', 'fixtures', 'corpus-sample.json');
const fixture = JSON.parse(readFileSync(path, 'utf-8')) as { ayahs: FixtureAyah[] };
const ayahs = fixture.ayahs;

describe('shared corpus fixture', () => {
  it('is non-trivial and uniquely keyed', () => {
    expect(ayahs.length).toBeGreaterThanOrEqual(30);
    expect(new Set(ayahs.map((a) => a.verseKey)).size).toBe(ayahs.length);
    for (const a of ayahs) {
      expect(a.textUthmani.trim().length).toBeGreaterThan(0);
      expect(a.translationEn.trim().length).toBeGreaterThan(0);
      expect(a.translationFa.trim().length).toBeGreaterThan(0);
      expect(`${a.chapter}:${a.verse}`).toBe(a.verseKey);
    }
  });

  it('carries both real refrains so similarity has something to find', () => {
    const groups = new Map<string, string[]>();
    for (const a of ayahs) {
      const key = normalizedText(a.textUthmani);
      groups.set(key, [...(groups.get(key) ?? []), a.verseKey]);
    }
    const repeated = [...groups.values()].filter((v) => v.length >= 2);
    expect(repeated.length).toBeGreaterThanOrEqual(2);
    const rahman = repeated.find((v) => v.some((k) => k.startsWith('55:')));
    expect(rahman?.length).toBeGreaterThanOrEqual(2);
  });

  it('normalises the hamza-over-alef refrain to one identical key', () => {
    const keys = ayahs
      .filter((a) => a.chapter === 55)
      .map((a) => normalizedText(a.textUthmani));
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]!.startsWith('فباي')).toBe(true);
  });

  it('counts words on real text without dropping or inventing tokens', () => {
    const basmala = ayahs.find((a) => a.verseKey === '1:1')!;
    expect(wordCount(basmala.textUthmani)).toBe(4);
    expect(tokenizeWords(basmala.textUthmani)).toHaveLength(4);
    expect(normalizedText(basmala.textUthmani)).toBe('بسم الله الرحمن الرحيم');
    const short = ayahs.find((a) => a.verseKey === '108:2')!;
    expect(wordCount(short.textUthmani)).toBe(3);
    expect(tokenizeWords(short.textUthmani).map(normalizeWord)).toEqual([
      'فصل',
      'لربك',
      'وانحر',
    ]);
  });

  /**
   * Provider Uthmani text orders combining marks differently from Unicode NFC
   * (shadda-then-fatha versus fatha-then-shadda). Import must compare raw code
   * points, and the key function must be immune to the difference — otherwise a
   * round-trip through any normalising tool looks like corrupted revelation.
   */
  it('is provider-encoded, not NFC, and normalisation is immune to the difference', () => {
    const basmala = ayahs.find((a) => a.verseKey === '1:1')!;
    expect(basmala.textUthmani.normalize('NFC')).not.toBe(basmala.textUthmani);
    expect(normalizedText(basmala.textUthmani)).toBe(
      normalizedText(basmala.textUthmani.normalize('NFC')),
    );
    expect(wordCount(basmala.textUthmani.normalize('NFC'))).toBe(4);
  });

  it('keeps the authoritative text free of normaliser output', () => {
    for (const a of ayahs) {
      expect(a.textUthmani).not.toBe(normalizedText(a.textUthmani));
      expect(a.textUthmani).toContain(' ');
    }
  });
});
