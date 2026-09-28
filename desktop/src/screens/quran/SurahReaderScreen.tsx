/**
 * SURAH READER — one chapter, loaded once, read offline.
 *
 * `ayahsByChapter` runs a single query and the body (`AyahFeed`) then issues one
 * `translations(keys, packId)` call for the whole chapter. The reader tracks the
 * mushaf's own structure only from stored fields: juz, page range, first and
 * last verse key. It does not print a basmalah line of its own, because the core
 * pack carries the basmalah only as verse 1:1 — inventing a second copy of
 * revealed text is not an option, and reusing 1:1 here would present a numbered
 * verse as an unnumbered heading.
 */
import { useMemo } from 'react';
import type { VerseKey } from '@quran/core';

import type { RouteProps } from '../../app/router';
import { useApp } from '../../app/app-state';
import { StateBoundary, useAsync } from '../../ui/async';
import { Chip, LinkButton, NumRange, Panel } from '../../ui/primitives';
import { AyahFeed } from './AyahFeed';
import { SURAH_COUNT, asInt, asVerseKey, chapterOf, revelationLabel, surahMeaning } from './lib';
import type { Tr } from '../../app/app-state';

export function SurahReaderScreen({ params, query }: RouteProps) {
  const { tr, gateway, lang } = useApp();
  const chapter = asInt(params['number'], 1, SURAH_COUNT);
  const deepLink = asVerseKey(query['vk']);

  const state = useAsync(async () => {
    if (!gateway) throw new Error(tr('ذخیره‌گاه باز نشده', 'Storage is not open yet'));
    if (chapter === null) throw new Error(tr('شمارهٔ سوره نامعتبر است', 'That surah number is not valid'));
    const surah = await gateway.surah(chapter);
    if (!surah) throw new Error(tr('چنین سوره‌ای وارد نشده است', 'No such surah has been imported'));
    const ayahs = await gateway.ayahsByChapter(chapter);
    return { surah, ayahs };
  }, [gateway, chapter, tr]);

  const scrollTo: VerseKey | null = useMemo(
    () => (deepLink && chapter !== null && chapterOf(deepLink) === chapter ? deepLink : null),
    [deepLink, chapter],
  );

  return (
    <StateBoundary
      state={state}
      emptyTitle={tr('این سوره آیه‌ای ندارد', 'This surah has no ayat')}
      emptyBody={tr(
        'متن این سوره در بستهٔ واردشده خالی است؛ چیزی ساخته نمی‌شود.',
        'The imported pack holds no text for this surah; nothing is fabricated to fill it.',
      )}
      emptyAction={
        <LinkButton to="/me/content" className="btn">
          {tr('سلامت داده', 'Data health')}
        </LinkButton>
      }
      isEmpty={(value) => value.ayahs.length === 0}
      onRetry={() => state.refresh()}
      skeleton={
        <div className="state state--loading" role="status" aria-busy="true">
          {tr('خواندن سوره…', 'Reading the surah…')}
        </div>
      }
    >
      {({ surah, ayahs }) => (
        <div className="stack">
          <Panel
            title={
              <span className="row surahhead">
                <span className="num">{tr('سوره', 'Surah')} {surah.number}</span>
                <span className="arabic surahhead__arabic">{surah.nameArabic}</span>
                <span>{surah.nameTransliterated}</span>
                <SurahMeaning tr={tr} surah={surah} lang={lang} />
              </span>
            }
            action={
              <span className="row">
                <LinkButton to="/quran">{tr('فهرس سوره‌ها', 'Surah index')}</LinkButton>
                {chapter !== null && chapter > 1 ? (
                  <LinkButton to={`/quran/surah/${surah.number - 1}`}>{tr('پیشین', 'Previous')}</LinkButton>
                ) : null}
                {chapter !== null && chapter < SURAH_COUNT ? (
                  <LinkButton to={`/quran/surah/${surah.number + 1}`}>{tr('پسین', 'Next')}</LinkButton>
                ) : null}
              </span>
            }
          >
            <div className="row surahmeta">
              <Chip tone="neutral">{revelationLabel(tr, surah.revelationPlace)}</Chip>
              <Chip tone="info" title={tr('ترتیب نزول', 'Revelation order')}>
                {tr('نزول', 'order')} {surah.revelationOrder}
              </Chip>
              <span className="num">
                {surah.ayahCount} {tr('آیه', 'ayat')}
              </span>
              <span className="num faint">
                {tr('صفحه', 'pages')} <NumRange from={surah.pagesFrom} to={surah.pagesTo} />
              </span>
              <span className="faint mono" dir="ltr">
                {surah.firstVerseKey}–{surah.lastVerseKey}
              </span>
              {ayahs[0] ? (
                <span className="faint">
                  {tr('جزء', 'juz')} <NumRange from={ayahs[0].juz} to={ayahs[ayahs.length - 1]?.juz} />
                </span>
              ) : null}
            </div>
            <div className="row surahmeta">
              <LinkButton to={`/quran/page/${surah.pagesFrom}`} className="btn">
                {tr('حالت صفحهٔ مصحف', 'Mushaf page mode')}
              </LinkButton>
              <LinkButton to={`/quran/ayah/${encodeURIComponent(surah.firstVerseKey)}`} className="btn">
                {tr('آیهٔ نخست', 'First ayah')}
              </LinkButton>
              <BookmarkSurahButton surah={surah} />
            </div>
          </Panel>

          <AyahFeed
            ayahs={ayahs}
            chapter={surah.number}
            trackReading
            scrollTo={scrollTo}
            label={tr(`متن سورهٔ ${surah.nameTransliterated}`, `Surah ${surah.nameTransliterated} text`)}
          />
        </div>
      )}
    </StateBoundary>
  );
}

function SurahMeaning({
  tr,
  lang,
  surah,
}: {
  tr: Tr;
  lang: 'fa' | 'en';
  surah: { translationFa: string | null; translationEn: string | null };
}) {
  const meaning = surahMeaning(lang, surah);
  if (!meaning) return <span className="faint">{tr('معنایش در بسته نیست', 'meaning not in the pack')}</span>;
  return (
    <span className={meaning.rtl ? 'muted persian' : 'muted'} dir={meaning.rtl ? 'rtl' : undefined}>
      {meaning.text}
    </span>
  );
}

/**
 * Bookmark the opening of the chapter, labelled with the surah name so the
 * bookmark list reads as a shelf of chapters and ayat, not bare keys.
 */
function BookmarkSurahButton({
  surah,
}: {
  surah: { number: number; nameTransliterated: string; firstVerseKey: VerseKey; pagesFrom: number };
}) {
  const { tr, gateway } = useApp();
  const state = useAsync(async () => {
    if (!gateway) return null;
    const all = await gateway.bookmarks();
    return all.find((bookmark) => bookmark.verseKey === surah.firstVerseKey) ?? null;
  }, [gateway, surah.firstVerseKey]);

  const existing = state.value ?? null;
  const label = `${tr('سوره', 'Surah')} ${surah.number} ${surah.nameTransliterated}`;

  return (
    <button
      type="button"
      className="btn"
      disabled={state.status === 'loading' || !gateway}
      aria-pressed={existing !== null}
      onClick={async () => {
        if (!gateway) return;
        try {
          if (existing) await gateway.removeBookmark(existing.id);
          else await gateway.addBookmark({ verseKey: surah.firstVerseKey, page: surah.pagesFrom, label });
          state.refresh();
        } catch {
          // The button reflects the stored state after a re-read; a failed write
          // is not shown as a bookmark the user does not have.
          state.refresh();
        }
      }}
    >
      {state.status === 'loading'
        ? tr('در حال خواندن نشانک‌ها…', 'Reading bookmarks…')
        : existing
          ? tr('نشانک این سوره برداشته شود', 'Remove this surah’s bookmark')
          : tr('نشانک برای این سوره', 'Bookmark this surah')}
    </button>
  );
}
