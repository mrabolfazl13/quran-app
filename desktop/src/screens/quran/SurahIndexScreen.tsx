/**
 * SURAH INDEX — the door to the mushaf.
 *
 * Every column is a stored `Surah` field: the Arabic name, the transliteration,
 * the meaning the pack carries (absent meanings are simply absent), the ayah
 * count, the revelation place, the Madani page range and the first and last
 * verse keys. The filter box is local to this screen and never invents a
 * "fuzzy" result — it matches the number, the verse key prefix, or the text the
 * row already shows.
 */
import { useMemo, useState } from 'react';
import type { Surah } from '@quran/core';

import { useApp } from '../../app/app-state';
import type { Tr } from '../../app/app-state';
import { StateBoundary, useAsync } from '../../ui/async';
import { Button, Chip, Field, LinkButton, NumRange } from '../../ui/primitives';
import { asInt, parseVerseKey, revelationLabel, surahMeaning } from './lib';
import './quran.css';

function matches(surah: Surah, needle: string): boolean {
  if (needle === '') return true;
  const byNumber = asInt(needle, 1, 114);
  if (byNumber !== null && surah.number === byNumber) return true;
  // A verse key such as `112:5` selects its surah when the verse is in range.
  const asKey = parseVerseKey(needle);
  if (asKey) {
    const lastVerse = parseVerseKey(surah.lastVerseKey)?.verse ?? 0;
    return surah.number === asKey.chapter && asKey.verse >= 1 && asKey.verse <= lastVerse;
  }
  const haystack = [
    String(surah.number),
    surah.nameArabic,
    surah.nameSimple,
    surah.nameTransliterated,
    surah.translationFa ?? '',
    surah.translationEn ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle.toLowerCase());
}

export function SurahIndexScreen() {
  const { tr, gateway, lang } = useApp();
  const [query, setQuery] = useState('');

  const state = useAsync(async () => {
    if (!gateway) throw new Error(tr('ذخیره‌گاه باز نشده', 'Storage is not open yet'));
    return gateway.surahs();
  }, [gateway, tr]);

  const filtered = useMemo(
    () => (state.value ?? []).filter((surah) => matches(surah, query.trim())),
    [state.value, query],
  );

  return (
    <div className="stack">
      <StateBoundary
        state={state}
        emptyTitle={tr('سوره‌ای وارد نشده است', 'No surah has been imported')}
        emptyBody={tr(
          'فهرس سوره‌ها از بستهٔ متن اصلی ساخته می‌شود؛ تا وارد نشده باشد این صفحه خالی می‌ماند.',
          'The index is built from the core text pack — until it is imported this screen stays empty.',
        )}
        emptyAction={
          <LinkButton to="/me/content" className="btn btn--primary">
            {tr('وارد کردن بسته‌ها', 'Import packs')}
          </LinkButton>
        }
        isEmpty={(value) => value.length === 0}
        onRetry={() => state.refresh()}
        skeleton={
          <div className="state state--loading" role="status" aria-busy="true">
            {tr('خواندن فهرس سوره‌ها…', 'Reading the surah index…')}
          </div>
        }
      >
        {(surahs) => (
          <div className="stack">
            <div className="row row--spread surahtools">
              <Field
                label={tr('پریدن به سوره', 'Jump to a surah')}
                hint={tr('شماره، نام یا کلید آیه (مثلاً ۱۱۲ یا ۱۱۲:۵)', 'A number, a name, or a verse key such as 112 or 112:5')}
                htmlFor="surah-filter"
              >
                <input
                  id="surah-filter"
                  className="input"
                  type="search"
                  value={query}
                  placeholder={tr('نام یا شمارهٔ سوره…', 'Surah name or number…')}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </Field>
              <div className="row">
                <span className="muted num">
                  {filtered.length} / {surahs.length}
                </span>
                {query !== '' ? (
                  <Button variant="ghost" onClick={() => setQuery('')}>
                    {tr('پاک کردن فیلتر', 'Clear filter')}
                  </Button>
                ) : null}
              </div>
            </div>

            <LinkButton to="/quran/juz" className="btn">
              {tr('فهرس سی جزء', 'Thirty-juz index')}
            </LinkButton>

            {filtered.length === 0 ? (
              <div className="state state--empty">
                <h3>{tr('سوره‌ای با این نام پیدا نشد', 'No surah matches that text')}</h3>
                <p className="muted">{query}</p>
                <Button onClick={() => setQuery('')}>{tr('نمایش همهٔ ۱۱۴ سوره', 'Show all surahs')}</Button>
              </div>
            ) : (
              <ul className="list surahlist">
                {filtered.map((surah) => (
                  <SurahRow key={surah.number} surah={surah} lang={lang} tr={tr} />
                ))}
              </ul>
            )}
          </div>
        )}
      </StateBoundary>
    </div>
  );
}

function SurahRow({ surah, lang, tr }: { surah: Surah; lang: 'fa' | 'en'; tr: Tr }) {
  const meaning = surahMeaning(lang, surah);
  return (
    <li className="surahrow" data-surah={surah.number}>
      <span className="num surahrow__number" aria-label={tr('شمارهٔ سوره', 'Surah number')}>
        {surah.number}
      </span>
      <LinkButton to={`/quran/surah/${surah.number}`} className="surahrow__link">
        <span className="arabic surahrow__arabic">{surah.nameArabic}</span>
        <span className="surahrow__translit">{surah.nameTransliterated}</span>
        {meaning ? (
          <span className={meaning.rtl ? 'muted persian surahrow__meaning' : 'muted surahrow__meaning'}>
            {meaning.text}
          </span>
        ) : (
          <span className="faint">{tr('معنای این سوره در بسته نیست', 'No meaning stored for this surah')}</span>
        )}
      </LinkButton>
      <span className="row surahrow__meta">
        <Chip tone="neutral" title={tr('محل نزول', 'Place of revelation')}>
          {revelationLabel(tr, surah.revelationPlace)}
        </Chip>
        <span className="num" title={tr('تعداد آیات', 'Ayah count')}>
          {surah.ayahCount} {tr('آیه', 'ayahs')}
        </span>
        <span className="num faint" title={tr('صفحه‌های مصحف', 'Mushaf pages')}>
          {tr('صفحه', 'p.')} <NumRange from={surah.pagesFrom} to={surah.pagesTo} />
        </span>
        <span className="faint mono" dir="ltr">
          {surah.firstVerseKey}–{surah.lastVerseKey}
        </span>
      </span>
      <span className="row surahrow__links">
        <LinkButton to={`/quran/page/${surah.pagesFrom}`}>{tr('صفحهٔ مصحف', 'Mushaf page')}</LinkButton>
        <LinkButton to={`/quran/ayah/${encodeURIComponent(surah.firstVerseKey)}`}>
          {tr('نخستین آیه', 'first ayah')}
        </LinkButton>
      </span>
    </li>
  );
}
