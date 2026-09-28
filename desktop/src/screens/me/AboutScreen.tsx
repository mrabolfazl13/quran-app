/**
 * ME / about — what this app is, where its words come from, and under what
 * licence.
 *
 * The version and the font licences are read at build time from files that
 * ship in the bundle (`desktop/package.json`, `src/assets/fonts/LICENCE-notes.json`);
 * the pack list and its licence states come from the gateway, i.e. from what is
 * actually imported. Nothing here paraphrases a licence it does not have: the
 * shipped packs all declare `licenseStatus: 'unresolved'`, so this screen prints
 * that as the open issue it is (see `docs/content-sources.md`).
 */
import { useApp } from '../../app/app-state';
import type { Tr } from '../../app/app-state';
import type { RouteDef } from '../../app/router';
import type { PackRow } from '../../gateway/types';
import { StateBoundary, useAsync } from '../../ui/async';
import { gatewayLabel, gatewayStore } from '../../ui/gatewayText';
import { Chip, Panel } from '../../ui/primitives';
import pkg from '../../../package.json';
import fontNotes from '../../assets/fonts/LICENCE-notes.json';
import { LicenseChip, MeTabs, formatBytes, formatNumber } from './shared';
import './me.css';

type FontNotes = typeof fontNotes;

function fontTotals(notes: FontNotes): { files: number; bytes: number } {
  let bytes = 0;
  for (const file of notes.files) bytes += file.bytes;
  return { files: notes.files.length, bytes };
}

export function AboutScreen() {
  const { tr, gateway, info } = useApp();

  const state = useAsync<PackRow[]>(
    async () => {
      if (!gateway) throw new Error(tr('ذخیره‌گاه باز نشده', 'Storage is not open yet'));
      return gateway.packs();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gateway],
  );

  const totals = fontTotals(fontNotes);

  return (
    <div className="stack">
      <MeTabs current="/me/about" />

      <Panel title={tr('این برنامه چیست', 'What this app is')}>
        <div className="stack--tight">
          <p className="measure">
            {tr(
              'قرآن: خواندن، فهمیدن، تفسیر و حفظ — یک برنامهٔ آفلاین. متن مصحف، ترجمه‌ها و تفسیرها یک‌بار از بسته‌های محتوای مجاز وارد می‌شوند و پس از آن هیچ بخشی از برنامه به شبکه نیاز ندارد.',
              'Quran: reading, understanding, tafsir and memorisation, in one offline app. The mushaf text, translations and tafsir are imported once from licensed content packs, and after that no part of the app needs a network.',
            )}
          </p>
          <ul className="list">
            <li>{tr('هیچ درخواست شبکه‌ای در زمان اجرا انجام نمی‌شود.', 'No network request is made at runtime.')}</li>
            <li>
              {tr(
                'آمار حفظ از تمرین‌های ثبت‌شده محاسبه می‌شود؛ عددی ساختگی نیست.',
                'Hifz figures are computed from recorded attempts; no number is invented.',
              )}
            </li>
            <li>
              {tr(
                'داده‌های شما تنها روی این دستگاه می‌ماند و هیچ پایانهٔ اندازه‌گیری یا ارسال گزارش وجود ندارد.',
                'Your data stays on this device: there is no telemetry or reporting endpoint at all.',
              )}
            </li>
            <li>
              {tr(
                'متن وحی تغییرناپذیر است: هیچ قابلیت «ویرایش» یا «اصلاح» روی آیات وجود ندارد.',
                'The revealed text is immutable: there is no “edit” or “fix” path for an ayah.',
              )}
            </li>
          </ul>
          <dl className="facts">
            <div>
              <dt>{tr('نسخهٔ برنامه', 'App version')}</dt>
              <dd className="mono" dir="ltr">
                {pkg.name} {pkg.version}
              </dd>
            </div>
            <div>
              <dt>{tr('پوسته', 'Shell')}</dt>
              <dd>{info ? gatewayLabel(tr, info.labelId) : tr('در حال باز شدن…', 'Opening…')}</dd>
            </div>
            <div>
              <dt>{tr('محل ذخیره', 'Storage location')}</dt>
              {info?.databasePath ? (
                <dd className="mono" dir="ltr">
                  {info.databasePath}
                </dd>
              ) : (
                <dd>{info ? gatewayStore(tr, info.storeId) : '—'}</dd>
              )}
            </div>
            <div>
              <dt>{tr('پوشهٔ محتوا', 'Content folder')}</dt>
              <dd className="mono" dir="ltr">
                {info?.contentRoot ?? tr('پیدا نشد', 'not found')}
              </dd>
            </div>
          </dl>
        </div>
      </Panel>

      <StateBoundary
        state={state}
        emptyTitle={tr('بستهٔ محتوایی وارد نشده است', 'No content pack has been imported')}
        emptyBody={tr(
          'برای دیدن منبع و مجوز هر بسته، اول آن را از صفحهٔ سلامت داده وارد کنید.',
          'To see each pack’s source and licence, import it first from the data-health screen.',
        )}
        isEmpty={(packs) => packs.length === 0}
        onRetry={() => state.refresh()}
        skeleton={<div className="state state--loading">{tr('خواندن بسته‌ها…', 'Reading packs…')}</div>}
      >
        {(packs) => (
          <>
            <Panel title={tr('منابع محتوا و وضعیت مجوز', 'Content sources and licence status')}>
              <div className="state state--warning" role="note">
                <h3>{tr('مجوزها هنوز بسته نشده است', 'The licences are not settled yet')}</h3>
                <p className="muted">
                  {tr(
                    'هیچ‌یک از بسته‌های واردشده وضعیت مجوز «روشن» ندارد. متن و انتساب نمایش داده می‌شود، ولی متن کامل مجوزی که در دست نیست اینجا نقل نمی‌شود. پیش از انتشار، گرفتن اجازهٔ کتبی لازم است (docs/content-sources.md).',
                    'None of the imported packs reports a cleared licence. The text and attribution are shown; a licence document we do not hold is not quoted or invented here. Written permission is needed before release (docs/content-sources.md).',
                  )}
                </p>
              </div>
              <ul className="packlist">
                {packs.map((pack) => (
                  <PackItem key={pack.id} pack={pack} tr={tr} />
                ))}
              </ul>
            </Panel>
          </>
        )}
      </StateBoundary>

      <Panel title={tr('قلم‌های همراه برنامه', 'Bundled fonts')}>
        <div className="stack--tight">
          <p className="muted">
            {fontNotes.runtime} · {tr('فهرست', 'list from')}{' '}
            <span className="mono" dir="ltr">
              src/assets/fonts/LICENCE-notes.json
            </span>
          </p>
          <div className="table-wrap">
            <table className="table">
              <caption className="visually-hidden">
                {tr('خانوادهٔ قلم‌ها و مجوز آن‌ها', 'Font families and their licences')}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{tr('قلم', 'Family')}</th>
                  <th scope="col">{tr('کاربرد', 'Purpose')}</th>
                  <th scope="col">{tr('مجوز', 'Licence')}</th>
                </tr>
              </thead>
              <tbody>
                {fontNotes.families.map((family) => (
                  <tr key={family.family}>
                    <th scope="row">{family.family}</th>
                    <td>{family.purpose}</td>
                    <td>
                      <Chip tone="accent">{family.licence}</Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="faint">
            {formatNumber(tr, totals.files)} {tr('فایل قلم، مجموع', 'font files,')} <span className="num">{formatBytes(totals.bytes)}</span> ·{' '}
            {tr('ساخته‌شده توسط', 'generated by')}{' '}
            <span className="mono" dir="ltr">
              {fontNotes.generatedBy}
            </span>
          </p>
          <p className="faint">
            {tr(
              'متن کامل مجوز هر قلم (SIL OFL 1.1) در نشانی ثبت‌شده در همان فایل است؛ این برنامه متن مجوز را از جایی نمی‌گیرد.',
              'The full text of each font licence (SIL OFL 1.1) is at the URL recorded in that same file; this screen does not paste a licence it has not been given.',
            )}
          </p>
        </div>
      </Panel>
    </div>
  );
}

function PackItem({ pack, tr }: { pack: PackRow; tr: Tr }) {
  return (
    <li className="packitem">
      <div className="row row--spread">
        <span className="packitem__title">{pack.title}</span>
        <span className="row">
          <span className="mono" dir="ltr">
            {pack.id}
          </span>
          <LicenseChip status={pack.licenseStatus} tr={tr} />
        </span>
      </div>
      <dl className="facts facts--tight">
        <div>
          <dt>{tr('منتشرکننده', 'Publisher')}</dt>
          <dd>{pack.attribution.publisher}</dd>
        </div>
        <div>
          <dt>{tr('اثر', 'Work')}</dt>
          <dd>{pack.attribution.work}</dd>
        </div>
        <div>
          <dt>{tr('ویرایش', 'Edition')}</dt>
          <dd>{pack.attribution.edition ?? '—'}</dd>
        </div>
        <div>
          <dt>{tr('منبع داده', 'Data source')}</dt>
          <dd className="mono" dir="ltr">
            {pack.attribution.sourceUrl}
          </dd>
        </div>
        <div>
          <dt>{tr('برداشت', 'Retrieved')}</dt>
          <dd className="mono" dir="ltr">
            {pack.attribution.retrievedAt.slice(0, 10)}
          </dd>
        </div>
        <div>
          <dt>{tr('سطر / نسخه', 'Records / version')}</dt>
          <dd className="num">
            {formatNumber(tr, pack.recordCount)} · {pack.version}
          </dd>
        </div>
        <div>
          <dt>{tr('مجوز', 'Licence')}</dt>
          <dd>
            {pack.licenseName}
            {pack.licenseSpdx ? <span className="mono"> · {pack.licenseSpdx}</span> : null}
          </dd>
        </div>
      </dl>
      <p className="licence__notes">{pack.licenseNotes}</p>
      <p className="muted">{pack.attribution.creditLine}</p>
    </li>
  );
}

export const routes: readonly RouteDef[] = [
  {
    path: '/me/about',
    title: (t: Tr) => t('درباره', 'About'),
    section: 'me',
    component: AboutScreen,
  },
];
