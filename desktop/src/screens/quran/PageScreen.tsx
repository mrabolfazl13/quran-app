/**
 * MUSHAF PAGE — the printed page, or an honest refusal to draw one.
 *
 * The grid comes from `@quran/core`'s mushaf engine, which groups word tokens by
 * the `page_number` / `line_number` the content pipeline captured from the
 * provider's mushaf rows. If those columns have not been imported, there is no
 * page to draw: the screen says so, links to Data health, and hands the reader to
 * the ayah view of the same page. It never re-flows the text with font metrics
 * and never invents a line break — a re-flowed mushaf is a different book.
 */
import { useMemo, useState } from 'react';
import { buildMushafLayout, renderPage } from '@quran/core';
import type { LayoutWord, MushafPage, RenderedPage, Surah, VerseKey } from '@quran/core';

import { useApp } from '../../app/app-state';
import { navigate, type RouteProps } from '../../app/router';
import type { AyahRow as AyahDataRow, AyahWordRow, DataGateway } from '../../gateway/types';
import { StateBoundary, useAsync } from '../../ui/async';
import { AyahBadge, Button, Chip, Field, LinkButton, Panel } from '../../ui/primitives';
import { PAGE_COUNT, asInt, chapterOf, declaredOf } from './lib';
import './quran.css';

interface PageData {
  page: number;
  ayahs: AyahDataRow[];
  words: AyahWordRow[];
  /** Tokens that carry no mushaf line number — the layout cannot be proven. */
  withoutLine: number;
  drawn: MushafPage | null;
  rendered: RenderedPage | null;
  surahs: Map<number, Surah>;
  layoutIssues: string[];
}

async function loadPage(gateway: DataGateway, page: number): Promise<PageData> {
  const ayahs = await gateway.ayahsByPage(page);
  const perAyah = await Promise.all(ayahs.map((ayah) => gateway.words(ayah.verseKey)));
  const words = perAyah.flat();

  // A page can only be laid out when every token on it declares its line: one
  // guessed line would misplace the rest of the page.
  const withLines = words.filter((word) => declaredOf(word).line !== null);
  const drawable = words.length > 0 && withLines.length === words.length;

  const layoutWords = words as unknown as LayoutWord[];
  const layout = drawable ? buildMushafLayout(layoutWords, ayahs) : null;
  const drawn = layout?.pages.find((candidate) => candidate.pageNumber === page) ?? null;
  const rendered = drawn ? renderPage(drawn, layoutWords) : null;

  const chapters = new Set(ayahs.map((ayah) => ayah.chapter));
  const starts = drawn?.surahStarts ?? [];
  const needed = starts.filter((start) => !chapters.has(start.chapter)).map((start) => start.chapter);
  const wanted = [...new Set([...chapters, ...needed])];
  const surahRows = await Promise.all(wanted.map((number) => gateway.surah(number)));
  const surahs = new Map<number, Surah>();
  for (const row of surahRows) if (row) surahs.set(row.number, row);

  return {
    page,
    ayahs,
    words,
    withoutLine: words.length - withLines.length,
    drawn,
    rendered,
    surahs,
    layoutIssues: (layout?.diagnostics ?? [])
      .filter((issue) => issue.severity !== 'info')
      .slice(0, 6)
      .map((issue) => `${issue.code} · ${issue.subject} · ${issue.detail}`),
  };
}

export function PageScreen({ params }: RouteProps) {
  const { tr, gateway } = useApp();
  const page = asInt(params['pageNumber'], 1, PAGE_COUNT);

  const state = useAsync(async () => {
    if (!gateway) throw new Error(tr('ذخیره‌گاه باز نشده', 'Storage is not open yet'));
    if (page === null) throw new Error(tr('شمارهٔ صفحه نامعتبر است', 'That page number is not valid'));
    return loadPage(gateway, page);
  }, [gateway, page === null ? 'invalid' : page, tr]);

  const firstKey: VerseKey | null = useMemo(() => {
    const first = state.value?.ayahs[0]?.verseKey;
    return first ?? null;
  }, [state.value]);

  return (
    <div className="stack">
      <StateBoundary
        state={state}
        emptyTitle={tr('آیه‌ای روی این صفحه نیست', 'No ayah sits on this page')}
        emptyBody={tr(
          'شاید شمارهٔ صفحه بیرون از ۱ تا ۶۰۴ باشد یا ستون‌های صفحه/سطر هنوز وارد نشده باشند.',
          'The page may be outside 1..604, or the page/line columns may not have been imported yet.',
        )}
        emptyAction={
          <div className="row">
            <LinkButton to="/me/content" className="btn btn--primary">
              {tr('سلامت داده', 'Data health')}
            </LinkButton>
            <LinkButton to="/quran" className="btn">
              {tr('فهرس سوره‌ها', 'Surah index')}
            </LinkButton>
          </div>
        }
        isEmpty={(value) => value.ayahs.length === 0}
        onRetry={() => state.refresh()}
        skeleton={
          <div className="state state--loading" role="status" aria-busy="true">
            {tr('ساخت صفحهٔ مصحف…', 'Building the mushaf page…')}
          </div>
        }
      >
        {(data) => (
          <div className="stack">
            <Panel
              title={
                <span className="row">
                  <span className="num">
                    {tr('صفحه', 'Page')} {data.page}
                  </span>
                  <span className="faint num">
                    {data.ayahs.length} {tr('آیه', 'ayat')}
                  </span>
                  <span className="faint mono">
                    {data.ayahs[0]?.verseKey ?? '—'}
                    {data.ayahs.length > 1 ? `–${data.ayahs[data.ayahs.length - 1]?.verseKey ?? ''}` : ''}
                  </span>
                  {data.drawn?.juzNumbers.map((juz) => (
                    <Chip key={juz} tone="accent">
                      {tr('جزء', 'juz')} {juz}
                    </Chip>
                  ))}
                </span>
              }
              action={
                <span className="row">
                  {data.page > 1 ? (
                    <LinkButton to={`/quran/page/${data.page - 1}`}>{tr('صفحهٔ پیشین', 'Previous page')}</LinkButton>
                  ) : null}
                  {data.page < PAGE_COUNT ? (
                    <LinkButton to={`/quran/page/${data.page + 1}`}>{tr('صفحهٔ پسین', 'Next page')}</LinkButton>
                  ) : null}
                  {firstKey ? (
                    <LinkButton to={`/quran/ayah/${encodeURIComponent(firstKey)}`}>
                      {tr('نخستین آیهٔ صفحه', 'first ayah of the page')}
                    </LinkButton>
                  ) : null}
                  <LinkButton to={`/quran/surah/${chapterOf(data.ayahs[0]?.verseKey ?? ('1:1' as VerseKey))}`} className="btn">
                    {tr('خواندن سوره', 'Read the surah')}
                  </LinkButton>
                </span>
              }
            >
              <p className="faint">
                {tr(
                  'چیدمان این صفحه فقط از شمارهٔ صفحه و سطرِ هر واژه ساخته می‌شود؛ متن هرگز با معیار فونت بازچین نمی‌شود.',
                  'The layout is built only from each word’s page and line number; the text is never re-flowed by font metrics.',
                )}
              </p>
              {data.drawn && !data.drawn.isComplete ? (
                <p className="field__error" role="alert">
                  {tr(
                    `چیدمان این صفحه کامل نیست؛ ${data.drawn.diagnostics.length} گزارش دارد.`,
                    `This page's layout is not complete; it reports ${data.drawn.diagnostics.length} diagnostics.`,
                  )}
                </p>
              ) : null}
              {data.layoutIssues.map((issue) => (
                <p className="faint mono" key={issue}>
                  {issue}
                </p>
              ))}
            </Panel>

            <PageJump current={data.page} />

            {data.rendered && data.drawn && data.rendered.lines.length > 0 ? (
              <MushafPageView
                rendered={data.rendered}
                drawn={data.drawn}
                surahs={data.surahs}
                words={data.words}
              />
            ) : (
              <div className="state state--empty" role="status">
                <h3>
                  {tr(
                    'ستون‌های صفحه و سطرِ واژه‌ها هنوز وارد نشده‌اند',
                    'The per-word page and line columns have not been imported',
                  )}
                </h3>
                <p className="muted">
                  {tr(
                    `واژه‌های این صفحه شمارهٔ سطر مصحف ندارند (${data.withoutLine} از ${data.words.length} واژه). بدون آن‌ها چیدمان واقعی صفحه ساخته نمی‌شود و چیزی جاگذاری نمی‌کنیم.`,
                    `These word rows carry no mushaf line number (${data.withoutLine} of ${data.words.length}). Without them a real page cannot be laid out, and nothing is guessed here.`,
                  )}
                </p>
                <div className="row">
                  <LinkButton to="/me/content" className="btn btn--primary">
                    {tr('سلامت داده', 'Data health')}
                  </LinkButton>
                  {firstKey ? (
                    <LinkButton to={`/quran/ayah/${encodeURIComponent(firstKey)}`} className="btn">
                      {tr('خواندن آیات این صفحه', 'Read this page’s ayat')}
                    </LinkButton>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        )}
      </StateBoundary>
    </div>
  );
}

/** Jump straight to a printed page — the mushaf's own address, 1..604. */
function PageJump({ current }: { current: number }) {
  const { tr } = useApp();
  const [draft, setDraft] = useState(String(current));
  const target = asInt(draft.trim(), 1, PAGE_COUNT);

  return (
    <form
      className="row pagejump"
      onSubmit={(event) => {
        event.preventDefault();
        if (target !== null) navigate(`/quran/page/${target}`);
      }}
    >
      <Field
        label={tr('پریدن به صفحهٔ مصحف', 'Jump to mushaf page')}
        hint={tr('شماره‌ای میان ۱ و ۶۰۴', 'A number between 1 and 604')}
        error={draft.trim() !== '' && target === null ? tr('این شماره صفحه نیست', 'Not a page number') : undefined}
        htmlFor="page-jump"
      >
        <input
          id="page-jump"
          className="input num"
          type="number"
          min={1}
          max={PAGE_COUNT}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </Field>
      <Button variant="primary" disabled={target === null || target === current} type="submit">
        {tr('برو', 'Go')}
      </Button>
      <LinkButton to="/quran/page/1">{tr('آغاز مصحف', 'page 1')}</LinkButton>
      <LinkButton to={`/quran/page/${PAGE_COUNT}`}>{tr('پایان مصحف', 'last page')}</LinkButton>
    </form>
  );
}

/** The grid: one block per provider line, gaps kept where the mushaf has them. */
function MushafPageView({
  rendered,
  drawn,
  surahs,
  words,
}: {
  rendered: RenderedPage;
  drawn: MushafPage;
  surahs: ReadonlyMap<number, Surah>;
  words: readonly AyahWordRow[];
}) {
  const { tr } = useApp();
  const byToken = useMemo(() => {
    const map = new Map<string, AyahWordRow>();
    for (const word of words) map.set(`${word.verseKey}:${word.position}`, word);
    return map;
  }, [words]);

  return (
    <section className="panel mushafpage">
      <header className="panel__head">
        <h2 className="panel__title">
          {tr('صفحهٔ مصحف', 'Mushaf page')} · <span className="num">{rendered.pageNumber}</span>
        </h2>
        <div className="panel__actions">
          <span className="faint num">
            {rendered.tokenCount} {tr('واژه', 'tokens')}
          </span>
          {drawn.emptyLineNumbers.length > 0 ? (
            <span className="faint num">
              {drawn.emptyLineNumbers.length} {tr('سطر خالی', 'heading-band lines')}
            </span>
          ) : null}
        </div>
      </header>
      <div className="panel__body">
        {drawn.surahStarts.length > 0 ? (
          <ul className="list pagestarts" aria-label={tr('آغاز سوره‌ها در این صفحه', 'Surahs starting on this page')}>
            {drawn.surahStarts.map((start) => (
              <li key={`${start.chapter}:${start.lineNumber}`} className="row">
                <span className="arabic">{surahs.get(start.chapter)?.nameArabic ?? start.chapter}</span>
                <span className="faint num">
                  {tr('سطر', 'line')} {start.lineNumber}
                </span>
                <LinkButton to={`/quran/ayah/${encodeURIComponent(start.verseKey)}`}>{start.verseKey}</LinkButton>
              </li>
            ))}
          </ul>
        ) : null}
        {rendered.missingWords.length > 0 ? (
          <p className="field__error" role="alert">
            {tr(
              `${rendered.missingWords.length} ارجاع بدون ردیف واژه است و نمایش داده نمی‌شود.`,
              `${rendered.missingWords.length} references have no word row and are not shown.`,
            )}
          </p>
        ) : null}
        {rendered.issues.map((issue) => (
          <p className="faint mono" key={`${issue.code}:${issue.subject}`}>
            {`${issue.code} · ${issue.subject}`}
          </p>
        ))}
        {rendered.lines.map((line) => (
          <div className="mushafline__wrap" key={`${line.pageNumber}:${line.lineNumber}`}>
            {line.gapLinesBefore.length > 0 ? (
              <p className="mushafgap" aria-label={tr('بند عنوان سوره در این جای خالی است', 'a surah heading band sits in this gap')}>
                {line.gapLinesBefore.map((gap) => (
                  <span key={gap} className="mushafgap__cell">
                    {tr('سطر', 'line')} {gap}
                  </span>
                ))}
              </p>
            ) : null}
            <p className="quran-text mushafline" dir="rtl" lang="ar">
              <span className="faint mushafline__no num" aria-label={tr('شمارهٔ سطر', 'line number')}>
                {line.lineNumber}
              </span>
              {line.words.map((token) =>
                token.isEndOfAyahMark ? (
                  <span className="word mushafline__end" key={`${token.verseKey}:${token.position}`}>
                    {token.ayahNumber !== null ? <AyahBadge verse={token.ayahNumber} /> : `${token.text} `}
                    {' '}
                  </span>
                ) : (
                  <span
                    className="word"
                    key={`${token.verseKey}:${token.position}`}
                    title={byToken.get(`${token.verseKey}:${token.position}`)?.translationEn ?? undefined}
                  >
                    {token.text}
                    {' '}
                  </span>
                ),
              )}
            </p>
          </div>
        ))}
        {rendered.lines.length > 0 ? null : (
          <p className="muted">{tr('این صفحه واژه‌چین نشده است.', 'No token has been laid out on this page.')}</p>
        )}
      </div>
    </section>
  );
}
