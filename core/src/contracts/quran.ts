/**
 * Quran domain contracts. Single source of truth for desktop (TS) and, by
 * mirroring, mobile (Dart). Change only through the orchestrator.
 */

export const SURAH_COUNT = 114;
export const AYAH_COUNT = 6236;
export const JUZ_COUNT = 30;
export const HIZB_COUNT = 60;
export const PAGE_COUNT = 604;

/** Canonical, stable reference for one ayah. Never derived from array indexes. */
export type VerseKey = `${number}:${number}`;

export type RevelationPlace = 'makkah' | 'madinah';

export interface Surah {
  number: number;
  nameArabic: string;
  nameSimple: string;
  nameTransliterated: string;
  translationFa: string | null;
  translationEn: string | null;
  revelationPlace: RevelationPlace;
  revelationOrder: number;
  ayahCount: number;
  /** Madani mushaf page range, inclusive. */
  pagesFrom: number;
  pagesTo: number;
  firstVerseKey: VerseKey;
  lastVerseKey: VerseKey;
  /**
   * True when a separate bismillah line is rendered *before* verse 1.
   * Provider value, stored verbatim: false only for At-Tawbah (9, no bismillah)
   * and Al-Fatihah (1, where the bismillah IS verse 1). An-Naml (27) is true —
   * its bismillah is not a verse, but it is not a separate prefix line either,
   * and the provider does not distinguish that case here.
   */
  bismillahPre: boolean;
}

export interface Ayah {
  /** `chapter:verse`, the stable identity used by every other entity. */
  verseKey: VerseKey;
  chapter: number;
  verse: number;
  /** Source row id from the content pack; informational only, never a foreign key. */
  sourceId: number | null;
  juz: number;
  hizb: number;
  rubElHizb: number;
  sajda: number | null;
  ruku: number | null;
  manzil: number | null;
  page: number;
  /** Uthmani script with diacritics — authoritative text, immutable. */
  textUthmani: string;
  /** Uthmani simplified, for search normalisation input. */
  textUthmaniSimple: string | null;
  /** Word count over the filtered token stream; recomputed by integrity checks. */
  wordCount: number;
  /** FNV fingerprint of the normalised text; recomputed by integrity checks. */
  normalizedHash: string;
}

export interface AyahWord {
  id: number;
  verseKey: VerseKey;
  /** 1-based position among word tokens of the ayah (excludes end-of-ayah marks). */
  position: number;
  textUthmani: string;
  translationEn: string | null;
  transliteration: string | null;
  root: string | null;
  morphology: string | null;
  isEndOfAyahMark: boolean;
}

export interface Translation {
  verseKey: VerseKey;
  /** Content pack id of the translation resource, e.g. `tr-en-85`. */
  packId: string;
  text: string;
}

export interface TafsirPassage {
  verseKey: VerseKey;
  packId: string;
  text: string;
  /** Some tafsirs group commentary over several ayahs. */
  coversVerseKeys: VerseKey[];
}

export type RelationType =
  | 'explicit'
  | 'textual'
  | 'linguistic'
  | 'thematic'
  | 'educational'
  | 'editorial';

export interface AyahRelation {
  fromVerseKey: VerseKey;
  toVerseKey: VerseKey;
  type: RelationType;
  /** Human-readable basis, required — no unexplained links. */
  reason: string;
  /** 0..1; 0 when the relation is categorical. */
  score: number;
  /** Which pack or algorithm produced it, for provenance display. */
  producedBy: string;
}

export interface SimilarAyahPair {
  verseKeyA: VerseKey;
  verseKeyB: VerseKey;
  /** Jaccard/normalised-edit similarity over word sets, 0..1. */
  textScore: number;
  sharedPhrase: string | null;
  differingWords: string[];
  producedBy: string;
}

export interface Concept {
  id: string;
  labelArabic: string;
  labelFa: string;
  labelEn: string;
  descriptionFa: string;
  /** Concepts are editorial unless explicitly `explicit`. */
  relationType: RelationType;
  producedBy: string;
}

export interface ConceptAyahLink {
  conceptId: string;
  verseKey: VerseKey;
  type: RelationType;
  reason: string;
}

export type ConnectionType = 'parent' | 'child' | 'related' | 'contrast';

export interface ConceptRelation {
  fromConceptId: string;
  toConceptId: string;
  type: ConnectionType;
  note: string;
}

export interface Bookmark {
  id: string;
  verseKey: VerseKey | null;
  page: number | null;
  label: string | null;
  createdAt: string;
}

export interface Note {
  id: string;
  verseKey: VerseKey;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReadingPosition {
  verseKey: VerseKey;
  page: number;
  scrollFraction: number;
  updatedAt: string;
}

export interface ReadingHistoryEntry {
  verseKey: VerseKey;
  readAt: string;
  durationMs: number | null;
}
