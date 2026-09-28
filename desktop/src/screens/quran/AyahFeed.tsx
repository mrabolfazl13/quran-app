/**
 * The ayah feed: the shared body of every mushaf list screen.
 *
 * A chapter (or a juz) is one list of ayahs plus the four things a reader needs
 * around it — word rows, the chosen translation in a single batch call, the
 * user's own marks, and reading progress. The reader and the juz screen both
 * mount this, so neither can drift from the other.
 */
import { useCallback, useEffect, useMemo } from 'react';
import type { VerseKey } from '@quran/core';

import { useApp } from '../../app/app-state';
import type { AyahRow as AyahDataRow } from '../../gateway/types';
import { useAsync } from '../../ui/async';
import { Button } from '../../ui/primitives';
import { AyahRow } from './AyahRow';
import {
  DWELL_MS,
  topVisibleAyah,
  useAyahVisibility,
  useReadingProgress,
  useTafsirTitles,
  useTranslationPack,
  useUserMarks,
  useWordBank,
} from './hooks';
import { scrollAyahIntoView } from './lib';
import { TranslationPicker } from './TranslationPicker';
import './quran.css';

export interface AyahFeedProps {
  ayahs: readonly AyahDataRow[];
  /** Chapter the feed belongs to; `null` disables position tracking. */
  chapter: number | null;
  /** Record reading position and history — the surah reader only. */
  trackReading?: boolean;
  /** Ayah to scroll to once rendered (a `?vk=` deep link). */
  scrollTo?: VerseKey | null;
  label: string;
}

export function AyahFeed({ ayahs, chapter, trackReading = false, scrollTo = null, label }: AyahFeedProps) {
  const { tr, gateway, lang } = useApp();

  const keys = useMemo(() => ayahs.map((ayah) => ayah.verseKey), [ayahs]);
  const signature = keys.join(' ');

  const pack = useTranslationPack(gateway, lang === 'fa' ? 'fa' : 'en');
  const bank = useWordBank(gateway, keys);
  const marks = useUserMarks(gateway);
  const tafsirTitles = useTafsirTitles(gateway);

  // ONE call for the whole chapter — never a request per ayah.
  const translationState = useAsync(
    async () => {
      if (!gateway) return new Map<VerseKey, string>();
      if (pack.packId === '' || !pack.ready) return new Map<VerseKey, string>();
      return gateway.translations([...keys], pack.packId);
    },
    [gateway, pack.packId, pack.ready, signature],
  );

  const currentPosition = useCallback(() => topVisibleAyah(), []);
  const reading = useReadingProgress(gateway, trackReading ? chapter : null, currentPosition);

  const prioritize = bank.prioritize;
  const onEnter = useCallback((key: VerseKey) => prioritize(key), [prioritize]);
  const noteRead = reading.noteRead;
  const onLeave = useCallback(
    (key: VerseKey, dwellMs: number) => {
      if (trackReading) noteRead(key, dwellMs);
    },
    [noteRead, trackReading],
  );
  const flushVisibility = useAyahVisibility({ onEnter, onLeave }, signature);

  useEffect(() => () => flushVisibility(), [flushVisibility]);

  // A deep link arrives before the rows are in the DOM; one frame later they are.
  useEffect(() => {
    if (!scrollTo) return;
    const frame = window.requestAnimationFrame(() => {
      if (!scrollAyahIntoView(scrollTo)) window.requestAnimationFrame(() => scrollAyahIntoView(scrollTo));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [scrollTo, signature]);

  const activeOption = pack.options.find((option) => option.packId === pack.packId) ?? null;
  const translations = translationState.value ?? new Map<VerseKey, string>();
  const loaded = keys.reduce((count, key) => (bank.of(key) === undefined ? count : count + 1), 0);

  return (
    <div className="stack" aria-label={label}>
      <section className="panel qurantools">
        <header className="panel__head">
          <h2 className="panel__title">{tr('ابزار خواندن', 'Reading tools')}</h2>
          <div className="panel__actions">
            {translationState.status === 'loading' && pack.packId !== '' ? (
              <span className="faint" role="status">
                {tr('بارگذاری ترجمه…', 'Loading translation…')}
              </span>
            ) : (
              <span className="faint num">
                {loaded}/{keys.length} {tr('واژه', 'words')}
              </span>
            )}
          </div>
        </header>
        <div className="panel__body stack--tight">
          <TranslationPicker
            options={pack.options}
            value={pack.packId}
            onChange={pack.choose}
            tr={tr}
            covered={translationState.status === 'ready' ? translations.size : null}
            totalAyahs={keys.length}
          />

          {bank.failed.length > 0 ? (
            <p className="field__error" role="status">
              {tr(
                `${bank.failed.length} آیه واژه‌هایش را باز نکرد؛ متن همان آیات کامل نمایش داده می‌شود.`,
                `${bank.failed.length} ayat returned no word rows; their full text is still shown.`,
              )}
            </p>
          ) : null}

          {pack.error || marks.error ? (
            <div className="row" role="alert">
              <span className="field__error">{pack.error ?? marks.error}</span>
              {marks.error ? (
                <Button variant="ghost" onClick={marks.dismissError}>
                  {tr('بستن', 'Dismiss')}
                </Button>
              ) : null}
            </div>
          ) : null}

          {trackReading && reading.saved ? (
            <ContinueBar
              saved={reading.saved}
              onGo={(key) => {
                scrollAyahIntoView(key);
                prioritize(key);
              }}
            />
          ) : null}
        </div>
      </section>

      <div className="ayahfeed">
        {ayahs.map((ayah) => (
          <AyahRow
            key={ayah.verseKey}
            ayah={ayah}
            words={bank.of(ayah.verseKey)}
            translation={pack.packId === '' ? undefined : translations.get(ayah.verseKey)}
            packLabel={activeOption?.title ?? null}
            packLicense={activeOption?.licenseStatus ?? null}
            tafsirTitles={tafsirTitles}
            bookmarked={marks.bookmarkIdOf(ayah.verseKey) !== undefined}
            inHifz={marks.hifzItemIdOf(ayah.verseKey) !== undefined}
            busy={marks.busy.has(ayah.verseKey)}
            tr={tr}
            onToggleBookmark={marks.toggleBookmark}
            onToggleHifz={marks.toggleHifz}
          />
        ))}
      </div>

      {trackReading && keys.length > 0 ? (
        <p className="faint feednote" role="status">
          {tr(
            `هر آیه پس از ${DWELL_MS / 1000} ثانیه روی صفحه به‌عنوان خوانده‌شده ثبت می‌شود و جای خواندن نگه داشته می‌شود.`,
            `An ayah counts as read after ${DWELL_MS / 1000}s on screen, and the reading position is saved.`,
          )}
        </p>
      ) : null}
    </div>
  );
}

/** The stored position, offered — never imposed. */
function ContinueBar({
  saved,
  onGo,
}: {
  saved: { verseKey: VerseKey; page: number; scrollFraction: number };
  onGo(verseKey: VerseKey): void;
}) {
  const { tr } = useApp();
  return (
    <div className="row row--spread continuebar">
      <span>
        {tr('ادامه از آیهٔ', 'Continue from ayah')} <span className="mono">{saved.verseKey}</span>
        <span className="faint">
          {' · '}
          {tr('صفحه', 'page')} {saved.page}
        </span>
      </span>
      <Button variant="primary" onClick={() => onGo(saved.verseKey)}>
        {tr('ادامه', 'Continue')}
      </Button>
    </div>
  );
}
