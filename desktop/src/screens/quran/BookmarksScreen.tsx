/**
 * BOOKMARKS — the reader's own shelf.
 *
 * Stored rows only: a bookmark points at a verse key, a page, or both, and its
 * label is whatever the writer stored (the surah reader labels chapter marks with
 * the surah name). Removing is immediate and reversible by re-adding; nothing is
 * cached here that could drift from the database.
 */
import { useMemo, useState } from 'react';

import { useApp } from '../../app/app-state';
import { StateBoundary, useAsync } from '../../ui/async';
import { Button, Chip, LinkButton } from '../../ui/primitives';
import { chapterOf } from './lib';
import './quran.css';

export function BookmarksScreen() {
  const { tr, gateway } = useApp();
  const [filter, setFilter] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const state = useAsync(async () => {
    if (!gateway) throw new Error(tr('ذخیره‌گاه باز نشده', 'Storage is not open yet'));
    return gateway.bookmarks();
  }, [gateway, tr]);

  const visible = useMemo(() => {
    const list = state.value ?? [];
    const needle = filter.trim().toLowerCase();
    if (needle === '') return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return [...list]
      .filter((bookmark) => {
        const haystack = `${bookmark.label ?? ''} ${bookmark.verseKey ?? ''} ${bookmark.page ?? ''}`.toLowerCase();
        return haystack.includes(needle);
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [state.value, filter]);

  async function remove(id: string) {
    if (!gateway) return;
    setBusyId(id);
    setError(null);
    try {
      await gateway.removeBookmark(id);
      state.refresh();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="stack">
      <div className="row row--spread">
        <p className="muted measure">
          {tr(
            'نشانک‌ها از همان آیه یا صفحه باز می‌شوند که بسته‌اند.',
            'A bookmark opens exactly the ayah or page it was set on.',
          )}
        </p>
        <LinkButton to="/quran">{tr('فهرس سوره‌ها', 'Surah index')}</LinkButton>
      </div>

      <StateBoundary
        state={state}
        emptyTitle={tr('نشانکی ثبت نشده است', 'No bookmark is stored yet')}
        emptyBody={tr(
          'در خوانندهٔ سوره، هر آیه دکمهٔ نشانک دارد؛ آنچه اینجا می‌بینید همان رکوردهای ذخیره‌شده‌اند.',
          'Every ayah in the surah reader has a bookmark button; this list is those stored rows.',
        )}
        emptyAction={
          <LinkButton to="/quran/surah/1" className="btn btn--primary">
            {tr('شروع از سورهٔ فاتحه', 'Start at Al-Fatihah')}
          </LinkButton>
        }
        isEmpty={(value) => value.length === 0}
        onRetry={() => state.refresh()}
        skeleton={
          <div className="state state--loading" role="status" aria-busy="true">
            {tr('خواندن نشانک‌ها…', 'Reading bookmarks…')}
          </div>
        }
      >
        {(bookmarks) => (
          <div className="stack--tight">
            <div className="row">
              <label className="field__label" htmlFor="bookmark-filter">
                {tr('فیلتر نشانک‌ها', 'Filter bookmarks')}
              </label>
              <input
                id="bookmark-filter"
                className="input"
                type="search"
                value={filter}
                placeholder={tr('برچسب، کلید آیه یا شمارهٔ صفحه', 'Label, verse key or page number')}
                onChange={(event) => setFilter(event.target.value)}
              />
              <span className="muted num">
                {visible.length} / {bookmarks.length}
              </span>
              {filter !== '' ? (
                <Button variant="ghost" onClick={() => setFilter('')}>
                  {tr('پاک کردن', 'Clear')}
                </Button>
              ) : null}
            </div>

            {error ? (
              <p className="field__error" role="alert">
                {error}
              </p>
            ) : null}

            {visible.length === 0 ? (
              <div className="state state--empty">
                <h3>{tr('نشانکی با این متن نیست', 'No bookmark matches that text')}</h3>
                <Button onClick={() => setFilter('')}>{tr('نمایش همه', 'Show all')}</Button>
              </div>
            ) : (
              <ul className="list bookmarklist">
                {visible.map((bookmark) => (
                  <li key={bookmark.id} className="row row--spread bookmarklist__row">
                    <span className="stack--tight bookmarklist__main">
                      <span className="bookmarklist__label">
                        {bookmark.label ??
                          bookmark.verseKey ??
                          (bookmark.page ? `${tr('صفحه', 'Page')} ${bookmark.page}` : tr('بی‌نام', 'untitled'))}
                      </span>
                      <span className="row faint">
                        {bookmark.verseKey ? <span className="mono">{bookmark.verseKey}</span> : null}
                        {bookmark.page ? (
                          <Chip tone="neutral">
                            {tr('صفحه', 'page')} {bookmark.page}
                          </Chip>
                        ) : null}
                        <span className="mono">{bookmark.createdAt.slice(0, 16).replace('T', ' ')}</span>
                        {bookmark.verseKey && bookmark.label ? (
                          <span className="faint">{tr('نشانکِ سوره یا آیه', 'surah or ayah mark')}</span>
                        ) : null}
                      </span>
                    </span>
                    <span className="row">
                      {bookmark.verseKey ? (
                        <LinkButton to={`/quran/ayah/${encodeURIComponent(bookmark.verseKey)}`} className="btn">
                          {tr('باز کردن آیه', 'Open ayah')}
                        </LinkButton>
                      ) : null}
                      {bookmark.page ? (
                        <LinkButton to={`/quran/page/${bookmark.page}`} className="btn">
                          {tr('باز کردن صفحه', 'Open page')}
                        </LinkButton>
                      ) : null}
                      {bookmark.verseKey ? (
                        <LinkButton to={`/quran/surah/${chapterOf(bookmark.verseKey)}`}>
                          {tr('سوره', 'Surah')}
                        </LinkButton>
                      ) : null}
                      <Button variant="danger" busy={busyId === bookmark.id} onClick={() => void remove(bookmark.id)}>
                        {tr('حذف', 'Remove')}
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </StateBoundary>
    </div>
  );
}
