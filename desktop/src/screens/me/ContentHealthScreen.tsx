/**
 * ME / data health — what is actually in the database, read from the gateway.
 *
 * Nothing here is estimated: the storage facts come from `info()`, the row
 * counts from `counts()` (COUNT over real tables), the licence picture from
 * `packs()` and the last import from `importReport()`. Every pack shipped today
 * carries `licenseStatus: 'unresolved'`, and this screen prints that instead of
 * softening it — an unlicensed bundle is a shipping blocker, not a footnote.
 */
import { useCallback, useState } from 'react';

import { useApp } from '../../app/app-state';
import type { Tr } from '../../app/app-state';
import type { RouteDef } from '../../app/router';
import type { ContentCounts, GatewayInfo, ImportReport, PackRow } from '../../gateway/types';
import { StateBoundary, useAsync } from '../../ui/async';
import { Button, Panel } from '../../ui/primitives';
import { ConfirmBox, LicenseChip, MeTabs, StatusLine, formatBytes, formatNumber, shortDigest, type Message } from './shared';
import './me.css';

interface Health {
  info: GatewayInfo;
  counts: ContentCounts;
  packs: PackRow[];
  report: ImportReport | null;
  backendNote: string | null;
}

/**
 * What `resetContent()` deletes. Transcribed from `CONTENT_TABLES` in
 * `desktop/src/gateway/tauriGateway.ts` (plus the two `meta` keys it clears);
 * the user tables — `note`, `bookmark`, `hifz_*`, `reading_*`, `settings` — are
 * not in that list and are untouched.
 */
const CONTENT_TABLES = [
  'content_pack',
  'surah',
  'ayah',
  'ayah_word',
  'translation',
  'tafsir',
  'similar_ayah',
  'ayah_relation',
  'concept',
  'concept_ayah',
  'concept_relation',
  'audio_track',
  'ayah_search',
];

const COUNT_LABELS: Readonly<Record<keyof ContentCounts, readonly [string, string]>> = {
  surahs: ['سوره', 'Surahs'],
  ayahs: ['آیه', 'Ayat'],
  words: ['واژه', 'Words'],
  translations: ['ترجمه', 'Translations'],
  tafsirs: ['تفسیر', 'Tafsir passages'],
  similar: ['آیهٔ مشابه', 'Similar-ayah pairs'],
  relations: ['روابط', 'Ayah relations'],
  concepts: ['مفهوم', 'Concepts'],
  audio: ['صوت', 'Audio tracks'],
  packs: ['بسته', 'Packs'],
  bookmarks: ['نشانک', 'Bookmarks'],
  notes: ['یادداشت', 'Notes'],
  hifzItems: ['آیهٔ حفظ', 'Hifz items'],
  recallAttempts: ['تمرین بازیابی', 'Recall attempts'],
  confusionGroups: ['گروه اشتباه', 'Confusion groups'],
};

const KIND_LABELS: Readonly<Record<string, readonly [string, string]>> = {
  'quran-core': ['متن قرآن', 'Quran text'],
  'word-data': ['دادهٔ واژه‌ای', 'Word data'],
  translation: ['ترجمه', 'Translation'],
  tafsir: ['تفسیر', 'Tafsir'],
  audio: ['صوت', 'Audio'],
};

export function ContentHealthScreen() {
  const { tr, gateway } = useApp();
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState<'import' | 'reset' | null>(null);

  const state = useAsync<Health>(
    async () => {
      if (!gateway) throw new Error(tr('ذخیره‌گاه باز نشده', 'Storage is not open yet'));
      const [info, counts, packs, report] = await Promise.all([
        gateway.info(),
        gateway.counts(),
        gateway.packs(),
        gateway.importReport(),
      ]);
      const backendNote = gateway.searchBackendNote ? await gateway.searchBackendNote() : null;
      return { info, counts, packs, report, backendNote };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gateway],
  );

  const reimport = useCallback(async () => {
    if (!gateway) return;
    setBusy('import');
    try {
      const report: ImportReport = await gateway.importFromContent();
      setMessage(
        report.status === 'success'
          ? {
              kind: 'ok',
              text: tr(
                `${report.packs.length} بسته در ${Math.round(report.durationMs)} میلی‌ثانیه وارد شد`,
                `${report.packs.length} packs imported in ${Math.round(report.durationMs)} ms`,
              ),
            }
          : {
              kind: 'error',
              // The report names the stage that refused the pack; a generic
              // "import failed" would hide the diagnosis.
              text: `${report.issue?.stage ?? tr('نامشخص', 'unknown')}: ${report.issue?.message ?? tr('وارد نشد', 'import failed')}`,
            },
      );
      state.refresh();
    } catch (cause) {
      setMessage({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, state, tr]);

  const reset = useCallback(async () => {
    if (!gateway) return;
    setBusy('reset');
    try {
      await gateway.resetContent();
      setMessage({
        kind: 'info',
        text: tr(
          'جداول محتوا خالی شد؛ یادداشت‌ها، نشانک‌ها و دادهٔ حفظ دست‌نخورده‌اند.',
          'Content tables emptied; notes, bookmarks and hifz data untouched.',
        ),
      });
      state.refresh();
    } catch (cause) {
      setMessage({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, state, tr]);

  return (
    <div className="stack">
      <MeTabs current="/me/content" />
      <StateBoundary
        state={state}
        emptyTitle={tr('هیچ بسته‌ای وارد نشده است', 'No pack has been imported yet')}
        emptyBody={tr(
          'پوشهٔ content کنار برنامه است؛ یک بار واردش کنید.',
          'The content folder ships with the app — import it once.',
        )}
        emptyAction={
          <div className="stack--tight">
            <StatusLine message={message} />
            <Button variant="primary" busy={busy === 'import'} onClick={() => void reimport()}>
              {tr('وارد کردن بسته‌های محتوا', 'Import content packs')}
            </Button>
          </div>
        }
        isEmpty={(value) => value.counts.ayahs === 0 && value.packs.length === 0}
        onRetry={() => state.refresh()}
        skeleton={<div className="state state--loading">{tr('خواندن سلامت داده…', 'Reading data health…')}</div>}
      >
        {(value) => (
          <>
            <StatusLine message={message} />
            <div className="row">
              <Button variant="primary" busy={busy === 'import'} onClick={() => void reimport()}>
                {tr('وارد کردن دوبارهٔ بسته‌ها', 'Re-import content packs')}
              </Button>
              <span className="faint">
                {tr(
                  'ورود دوباره اول همهٔ بسته‌ها را بررسی می‌کند و تنها در صورت تطابق مجموعهیکنترل چیزی می‌نویسد.',
                  'A re-import verifies every pack first and writes only when the checksums match.',
                )}
              </span>
            </div>

            <StoragePanel info={value.info} backendNote={value.backendNote} />

            <Panel title={tr('شمارش واقعی سطرهای پایگاه', 'Real row counts')}>
              <dl className="counts">
                {(Object.keys(COUNT_LABELS) as (keyof ContentCounts)[]).map((key) => (
                  <div key={key} className="counts__item">
                    <dt>{tr(COUNT_LABELS[key][0], COUNT_LABELS[key][1])}</dt>
                    <dd className="num">{formatNumber(tr, value.counts[key])}</dd>
                  </div>
                ))}
              </dl>
              <p className="faint">
                {tr('شمارش‌ها از همان پایگاه خوانده می‌شوند؛ جایگزین محاسباتی وجود ندارد.', 'Counts are read from this database; nothing here is computed elsewhere.')}
              </p>
            </Panel>

            <PackTable packs={value.packs} />
            <ImportReportPanel report={value.report} />

            <Panel title={tr('پاک کردن محتوا', 'Reset content')}>
              <ResetPanel busy={busy === 'reset'} onConfirm={() => void reset()} tr={tr} />
            </Panel>
          </>
        )}
      </StateBoundary>
    </div>
  );
}

function StoragePanel({ info, backendNote }: { info: GatewayInfo; backendNote: string | null }) {
  const { tr } = useApp();
  return (
    <Panel title={tr('ذخیره‌گاه', 'Storage')}>
      <dl className="facts">
        <div>
          <dt>{tr('شیوه', 'Mode')}</dt>
          <dd className="mono">{info.mode}</dd>
        </div>
        <div>
          <dt>{tr('برچسب', 'Label')}</dt>
          <dd>{info.label}</dd>
        </div>
        <div>
          <dt>{tr('پایگاه داده', 'Database')}</dt>
          <dd className="mono" dir="ltr">
            {info.database ?? tr('—', '—')}
          </dd>
        </div>
        <div>
          <dt>{tr('پوشهٔ محتوا', 'Content root')}</dt>
          <dd className="mono" dir="ltr">
            {info.contentRoot ?? tr('پیدا نشد', 'not found')}
          </dd>
        </div>
        <div>
          <dt>{tr('نسخهٔ نقشه', 'Schema version')}</dt>
          <dd className="num">{info.schemaVersion}</dd>
        </div>
        <div>
          <dt>{tr('جست‌وجو', 'Search backend')}</dt>
          <dd className="mono">{info.searchBackend}</dd>
        </div>
      </dl>
      {backendNote ? <p className="muted">{backendNote}</p> : null}
      {!info.isShippedPath ? (
        <p className="field__hint">
          {tr(
            'این پنجرهٔ توسعهٔ مرورگری است؛ مسیرهای فایل واقعی نیستند.',
            'This is the browser dev shell — file paths shown here are not real files.',
          )}
        </p>
      ) : null}
    </Panel>
  );
}

function PackTable({ packs }: { packs: PackRow[] }) {
  const { tr } = useApp();
  return (
    <Panel title={tr('بسته‌های واردشده', 'Imported packs')}>
      <div className="table-wrap">
        <table className="table">
          <caption className="visually-hidden">
            {tr('فهرست بسته‌ها و وضعیت مجوز هر یک', 'Packs and each one’s licence status')}
          </caption>
          <thead>
            <tr>
              <th scope="col">{tr('عنوان', 'Title')}</th>
              <th scope="col">{tr('نوع', 'Kind')}</th>
              <th scope="col">{tr('زبان', 'Language')}</th>
              <th scope="col">{tr('نسخه', 'Version')}</th>
              <th scope="col" className="num">
                {tr('سطر', 'Records')}
              </th>
              <th scope="col">{tr('مجموعهیکنترل', 'Checksum')}</th>
              <th scope="col">{tr('اندازه', 'Payload')}</th>
              <th scope="col">{tr('واردات', 'Imported')}</th>
              <th scope="col">{tr('مجوز', 'Licence')}</th>
            </tr>
          </thead>
          <tbody>
            {packs.map((pack) => {
              const kind = KIND_LABELS[pack.kind];
              return (
                <tr key={pack.id}>
                  <th scope="row">
                    <span className="mono">{pack.id}</span>
                    <div className="faint">{pack.title}</div>
                  </th>
                  <td>{kind ? tr(kind[0], kind[1]) : pack.kind}</td>
                  <td className="mono">{pack.language}</td>
                  <td className="mono">
                    {pack.version} · v{pack.schemaVersion}
                  </td>
                  <td className="num">{formatNumber(tr, pack.recordCount)}</td>
                  <td className="mono" title={pack.checksum} dir="ltr">
                    {shortDigest(pack.checksum)}
                  </td>
                  <td className="num">{formatBytes(pack.payloadBytes)}</td>
                  <td className="mono" dir="ltr">
                    {pack.importedAt.slice(0, 16).replace('T', ' ')}
                  </td>
                  <td>
                    <div className="stack--tight">
                      {pack.licenseStatus === 'clear' ? (
                        <LicenseChip status={pack.licenseStatus} tr={tr} />
                      ) : (
                        <details className="licence">
                          <summary>
                            <LicenseChip status={pack.licenseStatus} tr={tr} />
                          </summary>
                          <p className="muted">{pack.licenseName}</p>
                          {pack.licenseSpdx ? <p className="mono">{pack.licenseSpdx}</p> : null}
                          <p className="licence__notes">{pack.licenseNotes}</p>
                          <p className="faint">
                            {tr('منبع داده', 'Data source')}:{' '}
                            <span className="mono" dir="ltr">
                              {pack.source}
                            </span>
                          </p>
                          <p className="faint">
                            {tr('انتساب', 'Attribution')}:{' '}
                            {pack.attribution.creditLine} — {pack.attribution.publisher} (
                            {pack.attribution.retrievedAt.slice(0, 10)})
                          </p>
                        </details>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function ImportReportPanel({ report }: { report: ImportReport | null }) {
  const { tr } = useApp();
  if (!report) {
    return (
      <Panel title={tr('آخرین ورود محتوا', 'Last import')}>
        <p className="muted">{tr('گزارشی ثبت نشده است.', 'No import has been recorded yet.')}</p>
      </Panel>
    );
  }
  return (
    <Panel
      title={tr('آخرین ورود محتوا', 'Last import')}
      action={
        <span className={`chip chip--${report.status === 'success' ? 'accent' : 'danger'}`}>
          {report.status === 'success'
            ? tr('موفق', 'success')
            : report.status === 'no-packs'
              ? tr('بسته‌ای نبود', 'no packs')
              : tr('ناموفق', 'failed')}
        </span>
      }
    >
      <p className="muted">
        <span className="mono" dir="ltr">
          {report.at.replace('T', ' ').slice(0, 19)}
        </span>{' '}
        · {formatNumber(tr, Math.round(report.durationMs))} {tr('میلی‌ثانیه', 'ms')}
      </p>
      {report.issue ? (
        <div className="state state--error" role="alert">
          <h3>
            {tr('مرحلهٔ خطادار', 'Failing stage')}{': '}
            <span className="mono">{report.issue.stage}</span>
          </h3>
          <p className="muted">{report.issue.message}</p>
          {report.issue.detail ? <p className="mono">{report.issue.detail}</p> : null}
          {report.issue.packId ? (
            <p className="faint mono">
              {tr('بسته', 'pack')} {report.issue.packId}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="table-wrap">
        <table className="table">
          <caption className="visually-hidden">
            {tr('نتیجهٔ هر بسته در آخرین ورود', 'Per-pack outcome of the last import')}
          </caption>
          <thead>
            <tr>
              <th scope="col">{tr('بسته', 'Pack')}</th>
              <th scope="col" className="num">
                {tr('خوانده‌شده', 'Read')}
              </th>
              <th scope="col" className="num">
                {tr('نوشته‌شده', 'Applied')}
              </th>
              <th scope="col">{tr('مجموعهیکنترل', 'Checksum')}</th>
              <th scope="col">{tr('مجوز', 'Licence')}</th>
            </tr>
          </thead>
          <tbody>
            {report.packs.map((outcome) => (
              <tr key={`${report.at}-${outcome.packId}`}>
                <th scope="row">
                  <span className="mono">{outcome.packId}</span>
                  <div className="faint">{outcome.title}</div>
                </th>
                <td className="num">{formatNumber(tr, outcome.recordsRead)}</td>
                <td className="num">{formatNumber(tr, outcome.recordsApplied)}</td>
                <td>
                  <span className="mono" dir="ltr" title={outcome.checksum}>
                    {shortDigest(outcome.checksum)}
                  </span>{' '}
                  {outcome.checksumOk ? (
                    <span className="chip chip--accent">{tr('مطابق', 'ok')}</span>
                  ) : (
                    <span className="chip chip--danger">{tr('ناسازگار', 'mismatch')}</span>
                  )}
                </td>
                <td>
                  <LicenseChip status={outcome.licenseStatus} tr={tr} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {report.warnings.length > 0 ? (
        <div className="stack--tight">
          <p className="field__label">{tr('هشدارهای بی‌خطر', 'Non-fatal warnings')}</p>
          <ul className="list">
            {report.warnings.map((warning, index) => (
              <li key={`w-${index}-${warning.stage}`}>
                <span className="mono">{warning.stage}</span> — {warning.message}
                {warning.detail ? <span className="faint"> · {warning.detail}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Panel>
  );
}

function ResetPanel({ busy, onConfirm, tr }: { busy: boolean; onConfirm(): void; tr: Tr }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <div className="stack--tight">
        <p className="muted measure">
          {tr(
            'اگر بسته‌ها خراب یا ناسازگار شده‌اند، محتوا را پاک کنید و دوباره وارد کنید. دادهٔ شما (یادداشت، نشانک، حفظ، تنظیمات) و فایل‌های پشتیبان پاک نمی‌شوند. پاک‌کردن تنها وقتی ممکن است که هیچ دادهٔ کاربری به آیه‌ها ارجاع ندهد؛ وگرنه برنامه رد می‌کند و «بازخوانی محتوا» جای آن را می‌گیرد.',
            'If the packs are corrupt or mismatched, clear the content and re-import it. Your own data (notes, bookmarks, hifz, settings) and backup files are not touched. Clearing is only possible while no user data references the mushaf — otherwise it is refused, and "Re-import" is the action that replaces the rows instead.',
          )}
        </p>
        <Button variant="danger" onClick={() => setOpen(true)}>
          {tr('پاک کردن جداول محتوا', 'Reset content tables')}
        </Button>
      </div>
    );
  }
  return (
    <ConfirmBox
      title={tr('پاک کردن جداول محتوا', 'Delete the content tables')}
      consequences={[
        tr(
          `فقط این ${CONTENT_TABLES.length} جدول خالی می‌شود: ${CONTENT_TABLES.join('، ')}`,
          `Only these ${CONTENT_TABLES.length} tables are emptied: ${CONTENT_TABLES.join(', ')}`,
        ),
        tr(
          'کلیدهای last_import_json و last_import_at از جدول meta حذف می‌شوند.',
          'The meta keys last_import_json and last_import_at are removed too.',
        ),
        tr(
          'جدول‌های کاربر — از جمله note، bookmark، hifz_item، hifz_attempt، confusion_group، reading_position، reading_history، daily_plan، settings — دست‌نخورده می‌مانند؛ آنچه در بالا نیامده هم پاک نمی‌شود.',
          'User tables — note, bookmark, hifz_item, hifz_attempt, confusion_group, reading_position, reading_history, daily_plan, settings among them — are left alone; anything not listed above is untouched too.',
        ),
        tr(
          'متن قرآن در فایل‌های content باقی است و با «وارد کردن دوباره» بازمی‌گردد.',
          'The Quran files stay on disk and come back with “re-import content packs”.',
        ),
      ]}
      confirmLabel={tr('پاک کن', 'Delete the content')}
      busy={busy}
      onConfirm={() => {
        onConfirm();
        setOpen(false);
      }}
    />
  );
}

export const routes: readonly RouteDef[] = [
  {
    path: '/me/content',
    title: (t: Tr) => t('سلامت داده', 'Data health'),
    section: 'me',
    component: ContentHealthScreen,
  },
];
