/**
 * Turning an enrolled ayah into the engine's own structure — one rule, two stores.
 *
 * `core/src/hifz/segment.ts` decides where an ayah tiles into chunks; this module
 * decides *when the app persists that tiling*, so the SQLite shell and the browser
 * shell write identical rows instead of each re-deriving boundaries. A second copy
 * of the loop is how a new column gets written by one gateway and forgotten by the
 * other.
 *
 * The rule is: enrolment is one unit. A `hifz_item` with no segments is the state
 * the memory fingerprint, the scheduler's weak-segment factor and the segment drill
 * all silently degrade on, so the item and its chunks are derived together and the
 * caller writes both in one transaction (or one in-memory assignment).
 */
import type { AnchorWord, HifzItem, HifzSegment, HifzTransition } from '@quran/core';
import { segmentAyah } from '@quran/core';
import type { AyahWordRow } from './types';

/** Where the per-word glosses live, as the installed packs report it. */
export interface GlossSource {
  packId: string;
  lang: 'en';
}

/** The three reads a store has to answer for one ayah. */
export interface SegmentationSource {
  /** Authoritative Uthmani text, or null when this store holds no text for the key. */
  ayahText(verseKey: string): Promise<string | null>;
  /** Word rows in `position` order; end-of-ayah marks may be included, core ignores them. */
  wordRows(verseKey: string): Promise<AyahWordRow[]>;
  /** Which pack licenses the per-word glosses, or null when none is installed. */
  glossSource(): Promise<GlossSource | null>;
}

export interface SegmentationRows {
  segments: HifzSegment[];
  anchors: AnchorWord[];
  transitions: HifzTransition[];
}

/** `anchor_word` UNIQUE key: one word position plays one role per ayah. */
export function anchorKey(anchor: AnchorWord): string {
  return `${anchor.itemId}\u0000${anchor.verseKey}\u0000${anchor.wordPosition}\u0000${anchor.role}`;
}

/** `hifz_transition` UNIQUE key: one boundary inside one ayah of one item is one row. */
export function transitionKey(transition: HifzTransition): string {
  return `${transition.itemId}\u0000${transition.verseKey}\u0000${transition.kind}\u0000${transition.toWord}\u0000${transition.toVerseKey ?? ''}`;
}

/**
 * Keep the first row per UNIQUE key. The engine derives anchors and transitions
 * from the word list, and two chunks of one ayah legitimately propose the same
 * boundary word; inserting both would abort the whole enrol transaction on the
 * SQLite constraint. First wins, because the first is the one the earlier chunk
 * already committed to. The ayah is part of both keys, so this only ever drops a
 * true duplicate — never the second ayah's own row.
 */
export function uniqueBy<T>(rows: readonly T[], keyOf: (row: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const key = keyOf(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/**
 * Derive the rows an enrolment owes the engine for one item.
 *
 * Meanings come from the one licensed per-word source the app has —
 * `ayah_word.translation_en`, joined over exactly the word positions each chunk
 * covers — and are addressed by the pack those rows came from. An ayah with no
 * word rows, or a word row with no gloss, is derived with a NULL meaning and the
 * meaning axis declines to test that chunk: nothing here writes an understanding
 * the packs do not contain (AGENTS.md: never invent content).
 *
 * Every row says which ayah it tiles: `hifz_segment.position`, `anchor_word`'s
 * `word_position` and `hifz_transition.to_word` all restart at the start of the
 * ayah they belong to, so a multi-ayah item has a segment 0 in each of its ayat
 * and the store keys on (item, verse_key, position). Nothing is offset into a
 * single item-wide numbering to satisfy an older column — that numbering is what
 * made the second ayah's chunks look like the first ayah's later chunks.
 */
export async function buildSegmentation(item: HifzItem, source: SegmentationSource): Promise<SegmentationRows> {
  const glossSource = await source.glossSource();
  const segments: HifzSegment[] = [];
  const anchors: AnchorWord[] = [];
  const transitions: HifzTransition[] = [];
  for (let index = 0; index < item.sequence.length; index += 1) {
    const verseKey = item.sequence[index]!;
    const text = await source.ayahText(verseKey);
    // No text means the content is not imported yet: there is nothing to tile,
    // and inventing a chunk boundary for revelation is refused.
    if (!text) continue;
    const words = await source.wordRows(verseKey);
    const result = segmentAyah({
      itemId: item.id,
      verseKey,
      text,
      words,
      nextVerseKey: item.sequence[index + 1] ?? null,
      // No word rows ⇒ no licensed gloss ⇒ no meaning at all.
      wordGlossSource: words.length > 0 && glossSource ? glossSource : null,
    });
    segments.push(...result.segments);
    anchors.push(...result.anchors);
    transitions.push(...result.transitions);
  }
  return {
    segments,
    anchors: uniqueBy(anchors, anchorKey),
    transitions: uniqueBy(transitions, transitionKey),
  };
}
