/**
 * SINGLE AYAH — the focus view of one verse key.
 *
 * Everything on this screen is one ayah's own neighbourhood: its words, every
 * translation pack that covers it, its tafsir, the deterministic similar ayat
 * and the stored relations. Prev/next follow mushaf order across surah
 * boundaries, so the last ayah of a chapter steps to the first of the next — and
 * the two ends of the mushaf simply show no link, never a wrapped-around one.
 */
import { useEffect, useMemo, useState } from 'react';
import type { AyahRelation, LicenseStatus, SimilarAyahPair, VerseKey } from '@quran/core';

import { useApp } from '../../app/app-state';
import type { RouteProps } from '../../app/router';
import type { AyahRow, DataGateway } from '../../gateway/types';
import { StateBoundary, useAsync, type AsyncState } from '../../ui/async';
import { Button, Chip, LinkButton, Meter, Panel } from '../../ui/primitives';
import { AyahText } from './AyahText';
import { useUserMarks } from './hooks';
import {
  PAGE_COUNT,
  SURAH_COUNT,
  asVerseKey,
  copyText,
  keyOf,
  licenseLabel,
  licenseTone,
  verseOf,
} from './lib';
import { TafsirPanel } from './panels';
import './quran.css';

interface TranslationEntry {
  packId: string;
  title: string;
  language: 'en' | 'fa' | 'ar' | 'und';
  licenseStatus: LicenseStatus;
  text: string | null;
}

interface FocusData {
  ayah: AyahRow;
  words: Awaited<ReturnType<DataGateway['words']>>;
  translations: TranslationEntry[];
  prev: VerseKey | null;
  next: VerseKey | null;
}

async function loadFocus(gateway: DataGateway, key: VerseKey): Promise<FocusData> {
  const ayah = await gateway.ayah(key);
  if (!ayah) throw new Error(`${key}: ${'no such ayah in the imported packs'}`);
  const chapter = ayah.chapter;
  const [words, options, current, previous, following] = await Promise.all([
    gateway.words(key),
    gateway.translationOptions(),
    gateway.surah(chapter),
    chapter > 1 ? gateway.surah(chapter - 1) : Promise.resolve(null),
    chapter < SURAH_COUNT ? gateway.surah(chapter + 1) : Promise.resolve(null),
  ]);

  // A focus view is small enough for one call per installed pack; the batch
  // rule that protects the chapter reader does not apply to a single verse key.
  const packs = await Promise.all(
    options.map(async (option) => ({ option, map: await gateway.translations([key], option.packId) })),
  );

  const lastVerse = verseOf(current?.lastVerseKey ?? key);
  const prev: VerseKey | null =
    ayah.verse > 1 ? keyOf(chapter, ayah.verse - 1) : (previous?.firstVerseKey ?? null);
  const next: VerseKey | null =
    ayah.verse < lastVerse ? keyOf(chapter, ayah.verse + 1) : (following?.firstVerseKey ?? null);

  return {
    ayah,
    words,
    translations: packs.map(({ option, map }) => ({
      packId: option.packId,
      title: option.title,
      language: option.language,
      licenseStatus: option.licenseStatus,
      text: map.get(key) ?? null,
    })),
    prev,
    next,
  };
}

function translationClass(language: TranslationEntry['language']): string {
  if (language === 'fa') return 'persian';
  if (language === 'ar') return 'arabic-inline';
  return '';
}

export function AyahFocusScreen({ params }: RouteProps) {
  const { tr, gateway } = useApp();
  const key = asVerseKey(params['verseKey']);
  const keySignature = key ?? 'invalid';
  const marks = useUserMarks(gateway);
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');

  const state = useAsync(async () => {
    if (!gateway) throw new Error(tr('ذخیره‌گاه باز نشده', 'Storage is not open yet'));
    if (key === null) throw new Error(tr('کلید آیه نامعتبر است', 'That verse key is not valid'));
    return loadFocus(gateway, key);
  }, [gateway, keySignature, tr]);

  const verseKey = state.value?.ayah.verseKey ?? null;

  const similar = useAsync(
    async () => {
      if (!gateway || !verseKey) return [] as SimilarAyahPair[];
      return gateway.similarTo(verseKey, 10);
    },
    [gateway, verseKey],
  );

  const relations = useAsync(
    async () => {
      if (!gateway || !verseKey) return [] as AyahRelation[];
      return gateway.relationsOf(verseKey, 20);
    },
    [gateway, verseKey],
  );

  const tafsirTitles = useAsync(async () => {
    if (!gateway) return new Map<string, string>();
    const sources = await gateway.tafsirSources();
    return new Map(sources.map((source) => [source.packId, source.title]));
  }, [gateway]);
  const titles = useMemo(() => tafsirTitles.value ?? new Map<string, string>(), [tafsirTitles.value]);

  // Opening a single ayah is reading it, so the stored position moves here.
  const row = state.value?.ayah ?? null;
  useEffect(() => {
    if (!gateway || !row) return;
    void gateway.setReadingPosition(row.verseKey, row.page, 0).catch(() => undefined);
  }, [gateway, row?.verseKey, row?.page]); // eslint-disable-line react-hooks/exhaustive-deps

  if (state.status !== 'ready' || state.value === null || row === null) {
    return (
      <StateBoundary
        state={state}
        emptyTitle={tr('آیه‌ای برای نمایش نیست', 'There is no ayah to show')}
        isEmpty={() => true}
        onRetry={() => state.refresh()}
      >
        {() => null}
      </StateBoundary>
    );
  }

  const { ayah, words, translations, prev, next } = state.value;

  return (
    <div className="stack">
      <Panel
        title={
          <span className="row">
            <span className="mono">{ayah.verseKey}</span>
            <LinkButton to={`/quran/surah/${ayah.chapter}`}>
              {tr('سوره', 'Surah')} {ayah.chapter}
            </LinkButton>
            <span className="faint num">
              {tr('جزء', 'juz')} {ayah.juz} · {tr('صفحه', 'page')} {ayah.page} · {tr('حزب', 'hizb')} {ayah.hizb}
            </span>
            {ayah.sajda !== null ? <Chip tone="warn">{tr('آیهٔ سجده', 'Sajda verse')}</Chip> : null}
          </span>
        }
        action={
          <span className="row">
            {prev ? (
              <LinkButton to={`/quran/ayah/${encodeURIComponent(prev)}`}>{tr('آیهٔ پیشین', 'Previous ayah')}</LinkButton>
            ) : (
              <span className="faint">{tr('آغاز مصحف', 'start of the mushaf')}</span>
            )}
            {next ? (
              <LinkButton to={`/quran/ayah/${encodeURIComponent(next)}`}>{tr('آیهٔ پسین', 'Next ayah')}</LinkButton>
            ) : (
              <span className="faint">{tr('پایان مصحف', 'end of the mushaf')}</span>
            )}
          </span>
        }
      >
        <AyahText text={ayah.textUthmani} words={words} verse={ayah.verse} wordTitles />

        <div className="row focustools">
          <Button
            aria-pressed={marks.bookmarkIdOf(ayah.verseKey) !== undefined}
            busy={marks.busy.has(ayah.verseKey)}
            onClick={() => marks.toggleBookmark(ayah.verseKey)}
          >
            {marks.bookmarkIdOf(ayah.verseKey) !== undefined
              ? tr('نشانک‌شده', 'Bookmarked')
              : tr('نشانک', 'Bookmark')}
          </Button>
          <Button
            aria-pressed={marks.hifzItemIdOf(ayah.verseKey) !== undefined}
            busy={marks.busy.has(ayah.verseKey)}
            onClick={() => marks.toggleHifz(ayah.verseKey)}
          >
            {marks.hifzItemIdOf(ayah.verseKey) !== undefined
              ? tr('خروج از حفظ', 'Remove from hifz')
              : tr('افزودن به حفظ', 'Add to hifz')}
          </Button>
          <Button
            onClick={() => {
              void copyText(ayah.textUthmani).then((ok) => setCopied(ok ? 'done' : 'failed'));
            }}
          >
            {copied === 'done'
              ? tr('کپی شد', 'Copied')
              : copied === 'failed'
                ? tr('کپی نشد', 'Copy failed')
                : tr('کپی متن', 'Copy text')}
          </Button>
          <LinkButton to={`/quran/surah/${ayah.chapter}?vk=${encodeURIComponent(ayah.verseKey)}`} className="btn btn--primary">
            {tr('باز کردن در خوانندهٔ سوره', 'Open in the surah reader')}
          </LinkButton>
          <LinkButton to={`/quran/juz/${ayah.juz}`}>{tr('جزء این آیه', 'its juz')}</LinkButton>
          <LinkButton to={`/quran/page/${Math.min(PAGE_COUNT, Math.max(1, ayah.page))}`}>
            {tr('صفحهٔ مصحف', 'mushaf page')}
          </LinkButton>
          <LinkButton to={`/discover/mutashabihat?vk=${encodeURIComponent(ayah.verseKey)}`}>
            {tr('متشابهات', 'Mutashabihat')}
          </LinkButton>
        </div>
        {marks.error ? (
          <p className="field__error" role="alert">
            {marks.error}
          </p>
        ) : null}
      </Panel>

      <Panel title={tr('ترجمه‌ها', 'Translations')}>
        {translations.length === 0 ? (
          <p className="muted">
            {tr('هیچ بستهٔ ترجمه‌ای وارد نشده است.', 'No translation pack has been imported.')}
          </p>
        ) : (
          <div className="stack--tight">
            {translations.map((entry) => (
              <div className="stack--tight" key={entry.packId}>
                <div className="row">
                  <h3 className="focuspack__title">{entry.title}</h3>
                  <span className="faint mono">{entry.packId}</span>
                  {entry.licenseStatus !== 'clear' ? (
                    <Chip tone={licenseTone(entry.licenseStatus)}>{licenseLabel(tr, entry.licenseStatus)}</Chip>
                  ) : null}
                </div>
                {entry.text === null ? (
                  <p className="faint">{tr('این بسته این آیه را ندارد.', 'This pack does not carry this ayah.')}</p>
                ) : (
                  <p className={translationClass(entry.language)} dir={entry.language === 'en' ? 'ltr' : 'rtl'}>
                    {entry.text}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title={tr('تفسیر', 'Tafsir')}>
        <TafsirPanel verseKey={ayah.verseKey} titles={titles} />
      </Panel>

      <Panel
        title={tr('آیات مشابه', 'Similar ayat')}
        action={
          <LinkButton to={`/discover/mutashabihat?vk=${encodeURIComponent(ayah.verseKey)}`}>
            {tr('همهٔ متشابهات', 'All mutashabihat')}
          </LinkButton>
        }
      >
        <SimilarList state={similar} verseKey={ayah.verseKey} />
      </Panel>

      <Panel title={tr('روابط این آیه', 'Relations of this ayah')}>
        <RelationList state={relations} verseKey={ayah.verseKey} />
      </Panel>
    </div>
  );
}

function SimilarList({ state, verseKey }: { state: AsyncState<SimilarAyahPair[]>; verseKey: VerseKey }) {
  const { tr } = useApp();
  return (
    <StateBoundary
      state={state}
      emptyTitle={tr('مشابهی برای این آیه ساخته نشده است', 'No similar ayah has been built for this verse')}
      emptyBody={tr(
        'فهرت متشابهات از واژه‌های همان آیه ساخته می‌شود؛ اگر هنوز محاسبه نشده باشد، اینجا خالی می‌ماند.',
        'The list is built from the words of the ayah itself; if it has not been computed, this stays empty.',
      )}
      isEmpty={(value) => value.length === 0}
      onRetry={() => state.refresh()}
    >
      {(pairs) => (
        <ul className="list similalist">
          {pairs.map((pair) => {
            const other = pair.verseKeyA === verseKey ? pair.verseKeyB : pair.verseKeyA;
            return (
              <li key={`${pair.verseKeyA}|${pair.verseKeyB}`} className="row similalist__row">
                <LinkButton to={`/quran/ayah/${encodeURIComponent(other)}`}>{other}</LinkButton>
                <Meter value={pair.textScore} label={`${Math.round(pair.textScore * 100)}%`} />
                {pair.sharedPhrase ? <span className="arabic-inline faint">{pair.sharedPhrase}</span> : null}
                {pair.differingWords.length > 0 ? (
                  <span className="faint mono">{`${pair.differingWords.length} ${tr('واژهٔ متفاوت', 'differing words')}`}</span>
                ) : null}
                <span className="faint mono">{pair.producedBy}</span>
              </li>
            );
          })}
        </ul>
      )}
    </StateBoundary>
  );
}

function RelationList({ state, verseKey }: { state: AsyncState<AyahRelation[]>; verseKey: VerseKey }) {
  const { tr } = useApp();
  return (
    <StateBoundary
      state={state}
      emptyTitle={tr('رابطه‌ای برای این آیه وارد نشده است', 'No relation has been imported for this verse')}
      isEmpty={(value) => value.length === 0}
      onRetry={() => state.refresh()}
    >
      {(relations) => (
        <ul className="list relationlist">
          {relations.map((relation) => {
            const other = relation.fromVerseKey === verseKey ? relation.toVerseKey : relation.fromVerseKey;
            return (
              <li key={`${relation.fromVerseKey}->${relation.toVerseKey}:${relation.type}`} className="relationlist__item">
                <div className="row">
                  <LinkButton to={`/quran/ayah/${encodeURIComponent(other)}`}>{other}</LinkButton>
                  <Chip tone="neutral">{relation.type}</Chip>
                  {relation.score > 0 ? (
                    <Meter value={relation.score} label={`${Math.round(relation.score * 100)}%`} />
                  ) : null}
                </div>
                <p className="muted">{relation.reason}</p>
                <p className="faint mono">{relation.producedBy}</p>
              </li>
            );
          })}
        </ul>
      )}
    </StateBoundary>
  );
}
