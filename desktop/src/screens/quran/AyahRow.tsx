/**
 * One ayah in the feed: text, translation, and a disclosure row of actions.
 *
 * The row is `React.memo`-ised with primitive-or-stable props only, because a
 * 286-ayah chapter re-renders whenever a word batch or a translation map
 * arrives. Everything that can fail (clipboard, tafsir, notes) is local to the
 * row, and every control here writes or navigates — there are no decorative
 * buttons.
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { LicenseStatus, VerseKey } from '@quran/core';

import type { Tr } from '../../app/app-state';
import type { AyahRow as AyahDataRow, AyahWordRow } from '../../gateway/types';
import { Button, Chip, LinkButton } from '../../ui/primitives';
import { AyahText } from './AyahText';
import { copyText, licenseLabel, licenseTone } from './lib';
import { isArabicScript, NotePanel, TafsirPanel } from './panels';

export interface AyahRowProps {
  ayah: AyahDataRow;
  /** Word rows, or `undefined` until the bank has fetched them. */
  words: readonly AyahWordRow[] | undefined;
  /** The chosen pack's translation, or `undefined` when there is none. */
  translation: string | undefined;
  packLabel: string | null;
  packLicense: LicenseStatus | null;
  tafsirTitles: ReadonlyMap<string, string>;
  bookmarked: boolean;
  inHifz: boolean;
  busy: boolean;
  tr: Tr;
  onToggleBookmark(verseKey: VerseKey): void;
  onToggleHifz(verseKey: VerseKey): void;
}

type Disclosure = 'tafsir' | 'notes' | null;

function AyahRowComponent({
  ayah,
  words,
  translation,
  packLabel,
  packLicense,
  tafsirTitles,
  bookmarked,
  inHifz,
  busy,
  tr,
  onToggleBookmark,
  onToggleHifz,
}: AyahRowProps) {
  const [open, setOpen] = useState<Disclosure>(null);
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  const copyTimer = useRef<number | null>(null);
  const key = ayah.verseKey;
  const headingId = `ayah-${key.replace(':', '-')}`;

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const doCopy = useCallback(() => {
    void copyText(ayah.textUthmani).then((ok) => {
      setCopied(ok ? 'done' : 'failed');
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied('idle'), 2200);
    });
  }, [ayah.textUthmani]);

  const toggle = useCallback(
    (next: Exclude<Disclosure, null>) => setOpen((current) => (current === next ? null : next)),
    [],
  );

  return (
    <article className="ayah" data-verse-key={key} data-page={ayah.page} aria-labelledby={headingId}>
      <header className="row row--spread ayah__head">
        <h3 className="ayah__key" id={headingId}>
          <LinkButton to={`/quran/ayah/${encodeURIComponent(key)}`}>{key}</LinkButton>
        </h3>
        <span className="row ayah__tags">
          {ayah.sajda !== null ? <Chip tone="warn">{tr('آیهٔ سجده', 'Sajda verse')}</Chip> : null}
          {inHifz ? <Chip tone="accent">{tr('در حفظ', 'In hifz')}</Chip> : null}
          {bookmarked ? <Chip tone="info">{tr('نشانک', 'Bookmarked')}</Chip> : null}
          <span className="faint num">
            {tr('جزء', 'juz')} {ayah.juz} · {tr('صفحه', 'page')} {ayah.page}
          </span>
        </span>
      </header>

      <AyahText text={ayah.textUthmani} words={words} verse={ayah.verse} wordTitles />

      {translation === undefined ? null : (
        <div className="ayah__tr">
          {packLabel || packLicense ? (
            <span className="row ayah__packlabel">
              {packLabel ? <span className="faint">{packLabel}</span> : null}
              {packLicense && packLicense !== 'clear' ? (
                <Chip tone={licenseTone(packLicense)}>{licenseLabel(tr, packLicense)}</Chip>
              ) : null}
            </span>
          ) : null}
          <p className={isArabicScript(translation) ? 'arabic-inline ayah__trtext' : 'persian ayah__trtext'}>
            {translation}
          </p>
        </div>
      )}

      <div className="row ayah__tools">
        <Button
          variant={open === 'tafsir' ? 'primary' : 'default'}
          aria-expanded={open === 'tafsir'}
          onClick={() => toggle('tafsir')}
        >
          {tr('تفسیر', 'Tafsir')}
        </Button>
        <Button
          variant={open === 'notes' ? 'primary' : 'default'}
          aria-expanded={open === 'notes'}
          onClick={() => toggle('notes')}
        >
          {tr('یادداشت', 'Notes')}
        </Button>
        <Button
          aria-pressed={bookmarked}
          busy={busy}
          onClick={() => onToggleBookmark(key)}
          title={bookmarked ? tr('حذف نشانک', 'Remove bookmark') : tr('افزودن نشانک', 'Add bookmark')}
        >
          {bookmarked ? tr('نشانک‌شده', 'Bookmarked') : tr('نشانک', 'Bookmark')}
        </Button>
        <Button aria-pressed={inHifz} busy={busy} onClick={() => onToggleHifz(key)}>
          {inHifz ? tr('خروج از حفظ', 'Remove from hifz') : tr('افزودن به حفظ', 'Add to hifz')}
        </Button>
        <Button onClick={doCopy}>
          {copied === 'done'
            ? tr('کپی شد', 'Copied')
            : copied === 'failed'
              ? tr('کپی نشد', 'Copy failed')
              : tr('کپی متن', 'Copy text')}
        </Button>
        <LinkButton to={`/quran/ayah/${encodeURIComponent(key)}`}>{tr('تک‌آیه', 'Single ayah')}</LinkButton>
        <LinkButton to={`/discover/mutashabihat?vk=${encodeURIComponent(key)}`}>
          {tr('متشابهات', 'Mutashabihat')}
        </LinkButton>
      </div>

      {open === 'tafsir' ? <TafsirPanel verseKey={key} titles={tafsirTitles} /> : null}
      {open === 'notes' ? <NotePanel verseKey={key} /> : null}
    </article>
  );
}

/**
 * Shallow memo: the feed re-renders on every word flush, and only the rows whose
 * own rows changed should follow it.
 */
export const AyahRow = memo(AyahRowComponent, (previous, next) => {
  return (
    previous.ayah === next.ayah &&
    previous.words === next.words &&
    previous.translation === next.translation &&
    previous.packLabel === next.packLabel &&
    previous.packLicense === next.packLicense &&
    previous.tafsirTitles === next.tafsirTitles &&
    previous.bookmarked === next.bookmarked &&
    previous.inHifz === next.inHifz &&
    previous.busy === next.busy &&
    previous.tr === next.tr &&
    previous.onToggleBookmark === next.onToggleBookmark &&
    previous.onToggleHifz === next.onToggleHifz
  );
});
