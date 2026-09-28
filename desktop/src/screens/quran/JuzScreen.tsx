/**
 * JUZ — the thirty divisions and their first ayah.
 *
 * `/quran/juz` lists all thirty from `juzList()`; `/quran/juz/:juz` opens one of
 * them through the same feed the surah reader uses, so a juz reads exactly like a
 * chapter — same word rows, same single batched translation call, same actions.
 * Ranges, ayah counts and verse keys are the gateway's own aggregates.
 */
import { useApp } from '../../app/app-state';
import type { RouteProps } from '../../app/router';
import { StateBoundary, useAsync } from '../../ui/async';
import { Chip, LinkButton, NumRange, Panel } from '../../ui/primitives';
import { AyahFeed } from './AyahFeed';
import { JUZ_COUNT, asInt } from './lib';
import './quran.css';

export function JuzIndexScreen() {
  const { tr, gateway } = useApp();

  const state = useAsync(async () => {
    if (!gateway) throw new Error(tr('ذخیره‌گاه باز نشده', 'Storage is not open yet'));
    return gateway.juzList();
  }, [gateway, tr]);

  return (
    <StateBoundary
      state={state}
      emptyTitle={tr('اجزا ساخته نشده‌اند', 'No juz has been derived')}
      emptyBody={tr(
        'تقسیم جزء از ستون‌های divisions در بستهٔ متن اصلی خوانده می‌شود؛ پیش از وارد کردن، این فهرست خالی است.',
        'The juz divisions come from the core pack’s divisions columns; before an import this list is empty.',
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
          {tr('خواندن تقسیمات جزء…', 'Reading the juz divisions…')}
        </div>
      }
    >
      {(juzList) => (
        <div className="stack">
          <div className="row row--spread">
            <p className="muted measure">
              {tr(
                'هر جزء به نخستین آیهٔ خود باز می‌شود؛ بازهٔ صفحه‌ها و شمار آیات از همان دادهٔ واردشده است.',
                'Each juz opens at its first ayah; the page range and ayah count come from the imported rows.',
              )}
            </p>
            <LinkButton to="/quran">{tr('فهرس سوره‌ها', 'Surah index')}</LinkButton>
          </div>
          <ul className="grid grid--cards juzgrid">
            {juzList.map((juz) => (
              <li key={juz.juz} className="panel juzcard">
                <div className="panel__body stack--tight">
                  <div className="row row--spread">
                    <h2 className="panel__title">
                      {tr('جزء', 'Juz')} <span className="num">{juz.juz}</span>
                    </h2>
                    <Chip tone="neutral">
                      {juz.ayahCount} {tr('آیه', 'ayat')}
                    </Chip>
                  </div>
                  <div className="row">
                    <span className="num faint">
                      {tr('صفحه', 'p.')} <NumRange from={juz.pageFrom} to={juz.pageTo} />
                    </span>
                    <span className="faint mono" dir="ltr">
                      {juz.firstVerseKey}–{juz.lastVerseKey}
                    </span>
                  </div>
                  <div className="row">
                    <LinkButton to={`/quran/juz/${juz.juz}`} className="btn">
                      {tr('خواندن جزء', 'Read this juz')}
                    </LinkButton>
                    <LinkButton to={`/quran/ayah/${encodeURIComponent(juz.firstVerseKey)}`}>
                      {tr('نخستین آیه', 'first ayah')}
                    </LinkButton>
                    <LinkButton to={`/quran/page/${juz.pageFrom}`}>{tr('صفحهٔ آغاز', 'opening page')}</LinkButton>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </StateBoundary>
  );
}

export function JuzScreen({ params }: RouteProps) {
  const { tr, gateway } = useApp();
  const juz = asInt(params['juz'], 1, JUZ_COUNT);

  const state = useAsync(async () => {
    if (!gateway) throw new Error(tr('ذخیره‌گاه باز نشده', 'Storage is not open yet'));
    if (juz === null) throw new Error(tr('شمارهٔ جزء نامعتبر است', 'That juz number is not valid'));
    const [summary, ayahs] = await Promise.all([gateway.juzList(), gateway.ayahsByJuz(juz)]);
    const found = summary.find((item) => item.juz === juz) ?? null;
    return { found, ayahs };
  }, [gateway, juz, tr]);

  return (
    <StateBoundary
      state={state}
      emptyTitle={tr('این جزء آیه‌ای ندارد', 'This juz holds no ayah')}
      emptyBody={tr(
        'ستون juz در بستهٔ واردشده هیچ آیه‌ای برای این جزء نگه نداشته است.',
        'The imported pack’s juz column holds no ayah for this number.',
      )}
      emptyAction={
        <LinkButton to="/quran/juz" className="btn">
          {tr('فهرس اجزا', 'Juz index')}
        </LinkButton>
      }
      isEmpty={(value) => value.ayahs.length === 0}
      onRetry={() => state.refresh()}
      skeleton={
        <div className="state state--loading" role="status" aria-busy="true">
          {tr('خواندن جزء…', 'Reading the juz…')}
        </div>
      }
    >
      {({ found, ayahs }) => (
        <div className="stack">
          <Panel
            title={
              <span className="row">
                <span>
                  {tr('جزء', 'Juz')} <span className="num">{juz ?? '—'}</span>
                </span>
                {found ? (
                  <>
                    <span className="num faint">
                      {found.ayahCount} {tr('آیه', 'ayat')}
                    </span>
                    <span className="num faint">
                      {tr('صفحه', 'p.')} <NumRange from={found.pageFrom} to={found.pageTo} />
                    </span>
                    <span className="faint mono" dir="ltr">
                      {found.firstVerseKey}–{found.lastVerseKey}
                    </span>
                  </>
                ) : (
                  <Chip tone="warn">{tr('جمعیتی برای این جزء در بسته نیست', 'no stored summary for this juz')}</Chip>
                )}
              </span>
            }
            action={
              <span className="row">
                <LinkButton to="/quran/juz">{tr('فهرس اجزا', 'Juz index')}</LinkButton>
                {juz !== null && juz > 1 ? (
                  <LinkButton to={`/quran/juz/${juz - 1}`}>{tr('جزء پیشین', 'Previous juz')}</LinkButton>
                ) : null}
                {juz !== null && juz < JUZ_COUNT ? (
                  <LinkButton to={`/quran/juz/${juz + 1}`}>{tr('جزء پسین', 'Next juz')}</LinkButton>
                ) : null}
              </span>
            }
          >
            {found ? (
              <div className="row">
                <LinkButton to={`/quran/ayah/${encodeURIComponent(found.firstVerseKey)}`} className="btn btn--primary">
                  {tr('از نخستین آیهٔ جزء', 'From the juz’s first ayah')}
                </LinkButton>
                <LinkButton to={`/quran/page/${found.pageFrom}`} className="btn">
                  {tr('حالت صفحهٔ مصحف', 'Mushaf page mode')}
                </LinkButton>
              </div>
            ) : (
              <p className="muted">
                {tr('فهرست آیات این جزء از همان بسته ساخته می‌شود.', 'The ayah list below is built from the same pack.')}
              </p>
            )}
          </Panel>

          <AyahFeed
            ayahs={ayahs}
            chapter={null}
            label={tr(`آیات جزء ${juz ?? ''}`, `Ayat of juz ${juz ?? ''}`)}
          />
        </div>
      )}
    </StateBoundary>
  );
}
