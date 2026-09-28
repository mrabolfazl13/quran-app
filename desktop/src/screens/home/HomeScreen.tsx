/**
 * HOME — what is due today, where I left off, and whether there is any content.
 *
 * Every number on this screen is a COUNT() or an engine output the gateway
 * computed from stored rows (`HomeStats` in `gateway/types.ts`); the screen has
 * no literals to fall back on, which is the point of building it first.
 */
import type { HomeStats } from '../../gateway/types';
import { useApp, type Tr } from '../../app/app-state';
import { navigate } from '../../app/router';
import { StateBoundary, useAsync } from '../../ui/async';
import { BandChip, Button, Chip, LinkButton, Meter, Panel } from '../../ui/primitives';
import './home.css';

function statCard(tr: Tr, label: string, value: number, to: string, hint?: string) {
  return (
    <button type="button" className="statcard" onClick={() => navigate(to)}>
      <span className="statcard__value num">{value}</span>
      <span className="statcard__label">{label}</span>
      {hint ? <span className="statcard__hint faint">{hint}</span> : null}
    </button>
  );
}

export function HomeScreen() {
  const { tr, gateway } = useApp();
  const stats = useAsync<HomeStats>(async () => {
    if (!gateway) throw new Error(tr('ذخیره‌گاه باز نشده', 'Storage is not open yet'));
    return gateway.homeStats(new Date());
  }, [gateway, tr]);

  return (
    <StateBoundary
      state={stats}
      emptyTitle={tr('هنوز محتوایی وارد نشده است', 'No content has been imported yet')}
      emptyBody={tr(
        'برنامه کامل آفلاین است؛ کافی است یک بار بسته‌ها را از پوشهٔ content وارد کنید.',
        'The app works entirely offline — import the packs from the content folder once.',
      )}
      isEmpty={(value) => !value.hasContent}
      emptyAction={<ImportAction />}
      skeleton={<div className="state state--loading">{tr('خواندن آمار…', 'Reading stats…')}</div>}
      onRetry={() => stats.refresh()}
    >
      {(value) => <Home value={value} />}
    </StateBoundary>
  );
}

function ImportAction() {
  const { tr, gateway } = useApp();
  const busy = useAsync(
    async () => {
      if (!gateway) return null;
      return gateway.importReport();
    },
    [gateway],
  );
  return (
    <div className="stack--tight row">
      <Button
        variant="primary"
        busy={busy.status === 'loading'}
        onClick={async () => {
          if (!gateway) return;
          const report = await gateway.importFromContent();
          busy.refresh();
          if (report.status !== 'success') {
            // The report is the diagnosis; showing a generic failure would hide
            // which stage (checksum, record count, integrity) refused the pack.
            window.alert(report.issue ? `${report.issue.stage}: ${report.issue.message}` : tr('وارد نشد', 'Import failed'));
          }
        }}
      >
        {tr('وارد کردن بسته‌های محتوا', 'Import content packs')}
      </Button>
      {busy.value?.status === 'failed' ? (
        <Chip tone="danger">{`${busy.value.issue?.stage ?? ''} ${busy.value.issue?.message ?? ''}`}</Chip>
      ) : null}
    </div>
  );
}

function Home({ value }: { value: HomeStats }) {
  const { tr } = useApp();
  return (
    <div className="stack home">
      {value.continueAt ? (
        <Panel
          title={tr('ادامهٔ خواندن', 'Continue reading')}
          action={
            <LinkButton to={`/quran/ayah/${encodeURIComponent(value.continueAt.verseKey)}`}>
              {tr('باز کردن', 'Open')}
            </LinkButton>
          }
        >
          <div className="row row--spread">
            <div>
              <div className="home__surah">{value.continueAt.surah.nameArabic}</div>
              <div className="muted">
                {value.continueAt.surah.nameTransliterated} · {tr('آیه', 'ayah')}{' '}
                {value.continueAt.verseKey.split(':')[1]} · {tr('صفحه', 'page')} {value.continueAt.page}
              </div>
            </div>
            <Meter
              value={value.continueAt.scrollFraction}
              label={`${Math.round(value.continueAt.scrollFraction * 100)}%`}
            />
          </div>
        </Panel>
      ) : (
        <Panel title={tr('ادامهٔ خواندن', 'Continue reading')}>
          <p className="muted">{tr('هنوز جایی را باز نکرده‌اید.', 'You have not opened a place yet.')}</p>
          <LinkButton to="/quran" className="btn btn--primary">
            {tr('شروع از سورهٔ فاتحه', 'Start at Al-Fatihah')}
          </LinkButton>
        </Panel>
      )}

      <div className="grid grid--cards">
        {statCard(tr, tr('آیات فعال حفظ', 'Active hifz ayat'), value.hifzActive, '/hifz')}
        {statCard(
          tr,
          tr('مرور امروز', 'Due for review today'),
          value.hifzDueToday,
          '/hifz/review',
          value.hifzDueToday > 0 ? tr('امروز بدهکارید', 'Owed today') : tr('تصفیه', 'Clear'),
        )}
        {statCard(tr, tr('نقاط ضعف', 'Weak spots'), value.hifzWeak, '/hifz/weak')}
        {statCard(tr, tr('گروه‌های اشتباه', 'Confusion groups'), value.confusionGroups, '/hifz/confusion')}
        {statCard(tr, tr('تمرین‌های ثبت‌شده', 'Recorded attempts'), value.recallAttempts, '/hifz/progress')}
        {statCard(tr, tr('یادداشت‌ها', 'Notes'), value.notes.length, '/me/notes')}
      </div>

      <div className="home__columns">
        <Panel title={tr('آخرین یادداشت‌ها', 'Recent notes')} action={<LinkButton to="/me/notes">{tr('همه', 'All')}</LinkButton>}>
          {value.notes.length === 0 ? (
            <p className="muted">{tr('یادداشتی نیست.', 'No notes yet.')}</p>
          ) : (
            <ul className="list">
              {value.notes.slice(0, 5).map((note) => (
                <li key={note.id}>
                  <LinkButton to={`/quran/ayah/${encodeURIComponent(note.verseKey)}`}>{note.verseKey}</LinkButton>
                  <span> {note.body.slice(0, 90)}{note.body.length > 90 ? '…' : ''}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title={tr('نشانک‌ها', 'Bookmarks')} action={<LinkButton to="/quran/bookmarks">{tr('همه', 'All')}</LinkButton>}>
          {value.bookmarks.length === 0 ? (
            <p className="muted">{tr('نشانکی نیست.', 'No bookmarks yet.')}</p>
          ) : (
            <ul className="list">
              {value.bookmarks.slice(0, 5).map((bookmark) => (
                <li key={bookmark.id}>
                  <LinkButton
                    to={bookmark.page ? `/quran/page/${bookmark.page}` : `/quran/ayah/${encodeURIComponent(bookmark.verseKey ?? '')}`}
                  >
                    {bookmark.label ?? bookmark.verseKey ?? `${tr('صفحه', 'page')} ${bookmark.page}`}
                  </LinkButton>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title={tr('تازهدیده‌ها', 'Recently read')}>
          {value.recentReading.length === 0 ? (
            <p className="muted">{tr('تاریخچه‌ای نیست.', 'No reading history.')}</p>
          ) : (
            <ul className="list">
              {value.recentReading.slice(0, 6).map((entry) => (
                <li key={`${entry.verseKey}-${entry.readAt}`}>
                  <LinkButton to={`/quran/ayah/${encodeURIComponent(entry.verseKey)}`}>{entry.verseKey}</LinkButton>
                  <span className="faint"> · {entry.readAt.slice(0, 10)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {!value.hasUserData ? (
        <Panel title={tr('شروع حفظ', 'Start memorising')}>
          <p className="muted">
            {tr(
              'چند آیه را انتخاب کنید تا اثر حافظه‌شان ساخته شود: تقسیم‌بندی، لنگرها و زمان‌بندی مرور.',
              'Pick a few ayat and their memory fingerprint is built: segments, anchors and a review schedule.',
            )}
          </p>
          <LinkButton to="/hifz/items" className="btn btn--primary">
            {tr('انتخاب آیات', 'Choose ayat')}
          </LinkButton>
        </Panel>
      ) : (
        <div className="row">
          <LinkButton to="/hifz/session" className="btn btn--primary">
            {tr('شروع نشست امروز', 'Start today’s session')}
          </LinkButton>
          <BandChip band="unstable" label={tr(`${value.hifzWeak} آیهٔ ناپایدار`, `${value.hifzWeak} unstable`)} />
        </div>
      )}
    </div>
  );
}
