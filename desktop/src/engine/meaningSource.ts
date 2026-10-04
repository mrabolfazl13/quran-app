/**
 * The licensed meaning layer the hifz context is built from.
 *
 * core's rule is that the engine never looks a meaning up and never writes one;
 * this module is the single place above the gateway that is allowed to ask. It
 * may only answer with a meaning an imported pack actually carries, together
 * with the pack id and language that make it attributable — an unattributed
 * gloss of revealed text is not usable (AGENTS.md: never invent content).
 *
 * No pack selected, no translation row, or a language the schema cannot render
 * all produce *no coverage* for that ayah. The engine reads that as "the meaning
 * axis has no cue here" and leaves `meaningStability` null; it is never treated
 * as a score of zero, which would fabricate a failure the learner never had.
 */
import type { AyahWord, SegmentMeaning, VerseKey } from '@quran/core';
import type { DataGateway } from '../gateway';

/** Languages `hifz_segment.meaning_lang` accepts, so every cue is renderable. */
const MEANING_LANGS: readonly string[] = ['fa', 'ar', 'en'];

export interface MeaningRows {
  /** Licensed meaning per verse key. A key present with `null` was looked up and has no meaning. */
  meanings: Record<string, SegmentMeaning | null>;
  /** Word rows of the requested ayahs, grouped by verse key, in word order. */
  wordsByVerseKey: Record<string, AyahWord[]>;
  /** The pack the meanings came from, for the UI's attribution line. */
  packId: string | null;
}

export const NO_MEANING_ROWS: MeaningRows = { meanings: {}, wordsByVerseKey: {}, packId: null };

/**
 * Read the meaning coverage for exactly the ayahs asked about.
 *
 * Called with the ayahs the hifz list touches plus their mushaf predecessors,
 * because a concept cue is built from the ayah *before* the one being recited:
 * without the predecessor's meaning the chain step simply is not offered.
 */
export async function loadMeaningRows(gateway: DataGateway, verseKeys: VerseKey[]): Promise<MeaningRows> {
  const keys = [...new Set(verseKeys)];
  if (keys.length === 0) return NO_MEANING_ROWS;

  const wordsByVerseKey: Record<string, AyahWord[]> = {};
  for (const word of await gateway.wordsFor(keys)) {
    (wordsByVerseKey[word.verseKey] ??= []).push(word);
  }

  const packId = (await gateway.settings())['translationPack'] ?? '';
  if (packId === '') return { meanings: {}, wordsByVerseKey, packId: null };

  const option = (await gateway.translationOptions()).find((o) => o.packId === packId);
  const lang = option && MEANING_LANGS.includes(option.language) ? (option.language as SegmentMeaning['lang']) : null;
  if (!option || lang === null) {
    // A pack whose language the schema cannot hold, or which is not installed at
    // all, is reported as no coverage rather than silently mislabelled.
    return { meanings: {}, wordsByVerseKey, packId: null };
  }

  const meanings: Record<string, SegmentMeaning | null> = {};
  for (const key of keys) meanings[key] = null;
  for (const [key, text] of await gateway.translations(keys, packId)) {
    // `wordGloss: false`: this is one licensed clause of the whole ayah read from
    // a translation pack, not a meaning stitched together from word rows.
    meanings[key] = text.trim().length > 0 ? { text, lang, packId, wordGloss: false } : null;
  }
  return { meanings, wordsByVerseKey, packId };
}
