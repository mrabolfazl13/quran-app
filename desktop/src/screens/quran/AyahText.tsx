/**
 * The Uthmani line of one ayah, word by word.
 *
 * Two rendering modes and no third: when the word rows have arrived each token
 * becomes its own `<span className="word">` and the mushaf's end-of-ayah sign is
 * drawn as an `<AyahBadge>`; before they arrive the ayah's own `textUthmani` is
 * rendered as one untouched string. Both paths print the provider's code points
 * exactly — no normalisation, no trimming, no rejoining — because the shipped
 * text is deliberately non-NFC and normalising it would reorder its harakat.
 */
import { memo } from 'react';
import type { AyahWordRow } from '../../gateway/types';
import { AyahBadge } from '../../ui/primitives';

export interface AyahTextProps {
  /** The authoritative ayah text, printed verbatim when word rows are absent. */
  text: string;
  /** Word rows for this ayah, or `undefined` while they are still loading. */
  words: readonly AyahWordRow[] | undefined;
  verse: number;
  className?: string;
  /** `title` on each word — a word gloss, only when the pack carries one. */
  wordTitles?: boolean;
}

export const AyahText = memo(function AyahText({
  text,
  words,
  verse,
  className,
  wordTitles = false,
}: AyahTextProps) {
  const tokens = words ? words.filter((word) => !word.isEndOfAyahMark) : null;

  if (!tokens || tokens.length === 0) {
    return (
      <p className={`quran-text ${className ?? ''}`} dir="rtl" lang="ar">
        {text}{' '}
        <AyahBadge verse={verse} />
      </p>
    );
  }

  return (
    <p className={`quran-text ${className ?? ''}`} dir="rtl" lang="ar">
      {tokens.map((word) => (
        <span
          key={`${word.verseKey}:${word.position}`}
          className="word"
          title={wordTitles ? (word.translationEn ?? undefined) : undefined}
        >
          {word.textUthmani}
          {' '}
        </span>
      ))}
      <AyahBadge verse={verse} />
    </p>
  );
});
