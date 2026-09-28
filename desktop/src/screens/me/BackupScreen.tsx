/**
 * ME / backup & restore.
 *
 * A backup holds user data only — never the Quran text (`docs/backup-format.md`).
 * The envelope shown here is the one the gateway produced, with its real
 * `counts` and `checksum`; a file is written through the gateway's *name-only*
 * backup commands, so the shipped path stays inside the scoped app-data
 * directory and this screen never handles a path.
 *
 * Restore is destructive: the gateway deletes the user tables and re-inserts
 * what the file carries, so the screen prints both sides of that swap before
 * asking, renders the `MigrationResult` verbatim afterwards, and turns every
 * malformed file into a message instead of a crash.
 */
import { useCallback, useState } from 'react';

import { coerceSetting, defaultSettings, type BackupEnvelope, type MigrationResult } from '@quran/core';

import { useApp } from '../../app/app-state';
import type { Tr } from '../../app/app-state';
import type { RouteDef } from '../../app/router';
import type { ContentCounts, GatewayInfo } from '../../gateway/types';
import { StateBoundary, useAsync } from '../../ui/async';
import { Button, Chip, Field, Panel } from '../../ui/primitives';
import { applyFontScales, cacheFontScales } from './font-scale';
import { ConfirmBox, MeTabs, StatusLine, formatBytes, formatNumber, shortDigest, type Message } from './shared';
import './me.css';

interface BackupData {
  info: GatewayInfo;
  counts: ContentCounts;
  files: { name: string; createdAt: string; bytes: number }[];
}

/** A backup name is a filename to the native layer: keep it in its allowlist. */
const NAME_RE = /^[A-Za-z0-9._-]+\.quranbak$/;

const DATA_LABELS: Readonly<Record<string, readonly [string, string]>> = {
  settings: ['تنظیمات', 'Settings'],
  bookmarks: ['نشانک‌ها', 'Bookmarks'],
  notes: ['یادداشت‌ها', 'Notes'],
  readingPositions: ['جای خواندن', 'Reading position'],
  readingHistory: ['تاریخچهٔ خواندن', 'Reading history'],
  hifzItems: ['آیات حفظ', 'Hifz items'],
  hifzSegments: ['پاره‌های حفظ', 'Hifz segments'],
  anchorWords: ['واژه‌های لنگر', 'Anchor words'],
  hifzTransitions: ['گذارها', 'Hifz transitions'],
  recallAttempts: ['تمرین‌های بازیابی', 'Recall attempts'],
  confusionGroups: ['گروه‌های اشتباه', 'Confusion groups'],
  sessions: ['نشست‌ها', 'Sessions'],
  journeys: ['مسیرها', 'Journeys'],
  reflections: ['تأملات', 'Reflections'],
  dailyPlans: ['برنامه‌های روزانه', 'Daily plans'],
};

/** `ContentCounts` is the only live row count the gateway exposes per table. */
function currentOf(counts: ContentCounts, key: string): number | null {
  switch (key) {
    case 'bookmarks':
      return counts.bookmarks;
    case 'notes':
      return counts.notes;
    case 'hifzItems':
      return counts.hifzItems;
    case 'recallAttempts':
      return counts.recallAttempts;
    case 'confusionGroups':
      return counts.confusionGroups;
    default:
      return null;
  }
}

function defaultName(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `quran-backup-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.quranbak`;
}

export function BackupScreen() {
  const { tr, gateway, reload } = useApp();
  const [message, setMessage] = useState<Message | null>(null);

  // ---- export
  const [name, setName] = useState(() => defaultName(new Date()));
  const [draft, setDraft] = useState<BackupEnvelope | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // ---- restore
  const [selected, setSelected] = useState<{ name: string; envelope: BackupEnvelope } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [result, setResult] = useState<MigrationResult | null>(null);

  const state = useAsync<BackupData>(
    async () => {
      if (!gateway) throw new Error(tr('ذخیره‌گاه باز نشده', 'Storage is not open yet'));
      const [info, counts, files] = await Promise.all([gateway.info(), gateway.counts(), gateway.backupFiles()]);
      return { info, counts, files };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gateway],
  );

  const build = useCallback(async () => {
    if (!gateway) return;
    setExporting(true);
    setSavedPath(null);
    try {
      const envelope = await gateway.exportBackup();
      setDraft(envelope);
      setMessage({
        kind: 'info',
        text: tr(
          `فایل آماده شد: ${Object.values(envelope.counts).reduce((a, b) => a + b, 0)} سطر کاربر، بدون متن قرآن`,
          `Envelope built: ${Object.values(envelope.counts).reduce((a, b) => a + b, 0)} user rows, no Quran text`,
        ),
      });
    } catch (cause) {
      setDraft(null);
      setMessage({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setExporting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, tr]);

  const save = useCallback(async () => {
    if (!gateway || !draft) return;
    if (!NAME_RE.test(name)) {
      setMessage({
        kind: 'error',
        text: tr(
          'نام فایل باید فقط حرف، رقم، نقطه، زیرخط و خط تیره باشد و با .quranbak پایان یابد.',
          'The name may only contain letters, digits, dot, underscore and dash, and must end in .quranbak.',
        ),
      });
      return;
    }
    setExporting(true);
    try {
      const written = await gateway.writeBackupFile(name, draft);
      setSavedPath(written);
      setMessage({ kind: 'ok', text: `${tr('نوشته شد', 'Written')}: ${written}` });
      state.refresh();
    } catch (cause) {
      setMessage({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setExporting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, draft, name, state, tr]);

  const openStored = useCallback(
    async (fileName: string) => {
      if (!gateway) return;
      setResult(null);
      setRestoring(true);
      try {
        const envelope = await gateway.readBackupFile(fileName);
        if (!envelope) {
          setMessage({
            kind: 'error',
            text: tr(
              'این فایل JSON خوانا نیست؛ برنامه سالم مانده و چیزی تغییر نکرده است.',
              'This file is not readable JSON; the app is untouched and nothing changed.',
            ),
          });
          setSelected(null);
          return;
        }
        setSelected({ name: fileName, envelope });
        setMessage({ kind: 'info', text: `${fileName} — ${tr('آمادهٔ بررسی', 'ready to inspect')}` });
      } catch (cause) {
        setMessage({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) });
        setSelected(null);
      } finally {
        setRestoring(false);
      }
    },
    [gateway, tr],
  );

  const openUploaded = useCallback(
    async (file: File) => {
      setResult(null);
      try {
        const text = await file.text();
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          setMessage({
            kind: 'error',
            text: tr('بالای فایل باید یک شیء JSON باشد؛ چیزی خوانده نشد.', 'The top level must be a JSON object; nothing was loaded.'),
          });
          return;
        }
        setSelected({ name: file.name, envelope: parsed as BackupEnvelope });
        setMessage({ kind: 'info', text: `${file.name} — ${tr('آمادهٔ بررسی', 'ready to inspect')}` });
      } catch (cause) {
        // A hostile or truncated file is a message, never an exception.
        setMessage({
          kind: 'error',
          text: `${tr('فایل نامعتبر', 'Unreadable file')}: ${cause instanceof Error ? cause.message : String(cause)}`,
        });
        setSelected(null);
      }
    },
    [tr],
  );

  const restore = useCallback(async () => {
    if (!gateway || !selected) return;
    setRestoring(true);
    try {
      const migration = await gateway.importBackup(selected.envelope);
      setResult(migration);
      if (migration.ok) {
        // A backup carries the sender's settings, and `font-scale.ts` keeps the
        // scales in `document.documentElement` (not in React state), so they are
        // re-applied — and re-cached for the next pre-paint pass — before the
        // shell reloads. A failure here must not mask a successful restore.
        try {
          const stored = await gateway.settings();
          const defaults = defaultSettings();
          const scale = (key: 'fontScale' | 'quranFontScale'): number => {
            const coerced = coerceSetting(key, stored[key]);
            const fallback = Number(defaults[key]);
            return coerced.ok ? Number(coerced.value) : Number.isFinite(fallback) ? fallback : 1;
          };
          applyFontScales(scale('fontScale'), scale('quranFontScale'));
          cacheFontScales(scale('fontScale'), scale('quranFontScale'));
        } catch {
          /* the settings screen applies them on the next visit */
        }
        setMessage({
          kind: 'ok',
          text: tr(
            'بازیابی انجام شد؛ پوسته دوباره باز می‌شود تا تنظیمات بازیابی‌شده جاری شوند.',
            'Restore applied; the shell reopens so the restored settings take effect.',
          ),
        });
        setSelected(null);
        state.refresh();
        await reload();
      } else {
        setMessage({ kind: 'error', text: migration.error });
      }
    } catch (cause) {
      setMessage({ kind: 'error', text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setRestoring(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, selected, state, reload, tr]);

  return (
    <div className="stack">
      <MeTabs current="/me/backup" />
      <StateBoundary
        state={state}
        emptyTitle={tr('هنوز فایلی ساخته نشده است', 'No backup file exists yet')}
        emptyBody={tr('ابتدا یک فایل بسازید.', 'Build one first.')}
        isEmpty={(value) => value.files.length === 0}
        onRetry={() => state.refresh()}
        skeleton={<div className="state state--loading">{tr('فهرست پشتیبان‌ها…', 'Listing backups…')}</div>}
      >
        {(value) => (
          <>
            <StatusLine message={message} />
            <Panel title={tr('محلی که فایل‌ها می‌روند', 'Where files live')}>
              <p className="muted measure">
                {value.info.mode === 'tauri'
                  ? tr(
                      `در برنامهٔ نصبی، فایل‌ها با پسوند quranbak. در پوشهٔ backups کنار پایگاه داده نوشته و فقط با نام خوانده می‌شوند — نه با مسیر. پایگاه داده: ${value.info.database ?? '—'}`,
                      `In the packaged app, .quranbak files are written into the backups folder next to the database and are addressed by NAME only, never by path. Database: ${value.info.database ?? '—'}`,
                    )
                  : tr(
                      'در پوستهٔ توسعهٔ مرورگر، «فایل» یعنی یک رکورد در localStorage همین مرورگر با کلید quran.backups. این فایل قابل حمل نیست؛ برای گرفتن پشتیبان واقعی برنامهٔ دسکتاپ را باز کنید.',
                      'In the browser dev shell a “file” is one entry in this browser’s localStorage under the key quran.backups. It is not portable — use the desktop app for a real backup.',
                    )}
              </p>
              {value.info.mode === 'dev' ? (
                <div className="row">
                  <Chip tone="warn">{tr('پوستهٔ توسعه', 'Dev shell')}</Chip>
                  <span className="faint">{formatNumber(tr, value.files.length)} {tr('فایل ذخیره‌شده در این مرورگر', 'files stored in this browser')}</span>
                </div>
              ) : null}
            </Panel>

            {/* ------------------------------------------------------------ export */}
            <Panel
              title={tr('پشتیبان گرفتن', 'Export')}
              action={
                <Button variant="primary" busy={exporting} onClick={() => void build()}>
                  {tr('ساخت فایل از دادهٔ فعلی', 'Build from current data')}
                </Button>
              }
            >
              <p className="muted measure">
                {tr(
                  'تنظیمات، نشانک‌ها، یادداشت‌ها و تمام دادهٔ حفظ صادر می‌شوند؛ متن قرآن و تفسیرها در فایل پشتیبان نمی‌آیند، چون با برنامه می‌آیند و اعتبارشان جدا بررسی می‌شود.',
                  'Settings, bookmarks, notes and all hifz data are exported; the Quran text and tafsir are never in a backup — they ship with the app and are verified on their own.',
                )}
              </p>
              {draft ? (
                <div className="stack">
                  <EnvelopeSummary tr={tr} envelope={draft} label={tr('فایل ساخته‌شده', 'Built envelope')} />
                  <CountsTable tr={tr} envelope={draft} counts={value.counts} />
                  <div className="row row--end">
                    <Field label={tr('نام فایل', 'File name')} htmlFor="backup-name">
                      <input
                        id="backup-name"
                        className="input"
                        dir="ltr"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        aria-describedby="backup-name-hint"
                      />
                    </Field>
                    <Button busy={exporting} disabled={Boolean(savedPath)} onClick={() => void save()}>
                      {tr('ذخیرهٔ فایل', 'Write file')}
                    </Button>
                  </div>
                  <p className="field__hint" id="backup-name-hint">
                    {tr('نمونه:', 'Example:')} <span className="mono" dir="ltr">quran-backup-20260928-2130.quranbak</span>
                  </p>
                  {savedPath ? (
                    <p className="msg msg--ok" role="status" aria-live="polite">
                      {`${tr('نوشته شد', 'Written')}: `}
                      <span className="mono" dir="ltr">
                        {savedPath}
                      </span>
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="faint">{tr('هنوز فایلی ساخته نشده است.', 'No envelope has been built yet.')}</p>
              )}
            </Panel>

            {/* ------------------------------------------------------------ restore */}
            <Panel title={tr('بازیابی', 'Restore')}>
              {value.files.length === 0 ? (
                <p className="muted">{tr('فایل ذخیره‌شده‌ای نیست.', 'There are no stored backup files.')}</p>
              ) : (
                <ul className="filelist">
                  {value.files.map((file) => (
                    <li key={file.name}>
                      <span className="mono" dir="ltr">
                        {file.name}
                      </span>
                      <span className="faint num">{formatBytes(file.bytes)}</span>
                      {file.createdAt ? (
                        <span className="faint mono" dir="ltr">
                          {file.createdAt.slice(0, 16).replace('T', ' ')}
                        </span>
                      ) : (
                        <span
                          className="faint"
                          title={tr(
                            'فهرست بومی زمان را گزارش نمی‌کند؛ با انتخاب فایل، تاریخ درون آن نمایش داده می‌شود.',
                            'The native listing reports no timestamp; select the file to see the date inside it.',
                          )}
                        >
                          {tr('زمان درون فایل', 'time inside the file')}
                        </span>
                      )}
                      <Button busy={restoring} onClick={() => void openStored(file.name)}>
                        {tr('برای بازیابی انتخاب کن', 'Select to restore')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}

              {value.info.mode === 'dev' ? (
                <Field
                  label={tr('یا یک فایل JSON از این رایانه بردارید (فقط پوستهٔ توسعه)', 'Or pick a JSON file from this computer (dev shell only)')}
                  htmlFor="backup-upload"
                  hint={tr('فقط در همین مرورگر خوانده می‌شود و جایی فرستاده نمی‌شود.', 'It is read locally by this browser and never sent anywhere.')}
                >
                  <input
                    id="backup-upload"
                    type="file"
                    accept="application/json,.json,.quranbak"
                    onChange={(event) => {
                      const picked = event.target.files?.[0];
                      event.target.value = '';
                      if (picked) void openUploaded(picked);
                    }}
                  />
                </Field>
              ) : null}

              {selected ? (
                <div className="stack">
                  <RestorePreview
                    tr={tr}
                    name={selected.name}
                    envelope={selected.envelope}
                    counts={value.counts}
                    restoring={restoring}
                    onConfirm={() => void restore()}
                    onCancel={() => {
                      setSelected(null);
                      setResult(null);
                    }}
                  />
                </div>
              ) : null}

              {result ? <ResultPanel tr={tr} result={result} /> : null}
            </Panel>
          </>
        )}
      </StateBoundary>
    </div>
  );
}

function EnvelopeSummary({ tr, envelope, label }: { tr: Tr; envelope: BackupEnvelope; label: string }) {
  return (
    <div className="stack--tight">
      <div className="row">
        <Chip tone="info">{label}</Chip>
        <span className="mono">
          {tr('شمایه', 'schema')} v{envelope.schemaVersion} · {tr('حداقل خواننده', 'min reader')} v{envelope.minReaderVersion}
        </span>
      </div>
      <p className="faint">
        {tr('ساخته', 'created')} <span className="mono" dir="ltr">{envelope.createdAt.replace('T', ' ').slice(0, 19)}</span> ·{' '}
        <span className="mono" dir="ltr">
          {envelope.producedBy.app} {envelope.producedBy.version} ({envelope.producedBy.platform})
        </span>
      </p>
      <p className="mono" dir="ltr" title={envelope.checksum}>
        {`${tr('مجموعهیکنترل', 'checksum')}: ${shortDigest(envelope.checksum)}`}
      </p>
    </div>
  );
}

function CountsTable({ tr, envelope, counts }: { tr: Tr; envelope: BackupEnvelope; counts: ContentCounts }) {
  const keys = Object.keys(DATA_LABELS).filter((key) => key in envelope.counts);
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="visually-hidden">
          {tr('مقایسهٔ فایل با پایگاه فعلی', 'The file against the current database')}
        </caption>
        <thead>
          <tr>
            <th scope="col">{tr('داده', 'Data')}</th>
            <th scope="col" className="num">
              {tr('در فایل', 'In file')}
            </th>
            <th scope="col" className="num">
              {tr('اکنون در پایگاه', 'Now in database')}
            </th>
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => {
            const live = currentOf(counts, key);
            const pair = DATA_LABELS[key];
            return (
              <tr key={key}>
                <th scope="row">{pair ? tr(pair[0], pair[1]) : key}</th>
                <td className="num">{formatNumber(tr, envelope.counts[key as keyof BackupEnvelope['counts']] ?? 0)}</td>
                <td className="num">{live === null ? '—' : formatNumber(tr, live)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RestorePreview({
  tr,
  name,
  envelope,
  counts,
  restoring,
  onConfirm,
  onCancel,
}: {
  tr: Tr;
  name: string;
  envelope: BackupEnvelope;
  counts: ContentCounts;
  restoring: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  const fileRows = Object.values(envelope.counts).reduce((a, b) => a + b, 0);
  return (
    <div className="stack">
      <EnvelopeSummary tr={tr} envelope={envelope} label={`${tr('فایل انتخاب‌شده', 'Selected file')}: ${name}`} />
      <ConfirmBox
        title={tr('جایگزینی دادهٔ فعلی با این فایل', 'Replace the current data with this file')}
        consequences={[
          tr(
            'پیش از نوشتن، سطرهای همهٔ جدول‌های کاربر (تنظیمات، نشانک، یادداشت، جای خواندن، تاریخچه، آیات و پاره‌ها و گذارها و تمرین‌های حفظ، گروه‌های اشتباه، نشست‌ها، برنامه‌های روزانه) حذف می‌شود.',
            'Before writing, every row in the user tables (settings, bookmarks, notes, reading position and history, hifz items, segments, transitions and attempts, confusion groups, sessions, daily plans) is deleted.',
          ),
          tr(
            `هر سطری که در این فایل ${fileRows} سطری نباشد، برای همیشه از این دستگاه می‌رود.`,
            `Anything not inside these ${fileRows} rows is gone from this device for good.`,
          ),
          tr(
            `اکنون ${formatNumber(tr, counts.notes)} یادداشت، ${formatNumber(tr, counts.bookmarks)} نشانک، ${formatNumber(tr, counts.hifzItems)} آیة حفظ و ${formatNumber(tr, counts.recallAttempts)} تمرین در پایگاه است.`,
            `The database currently holds ${formatNumber(tr, counts.notes)} notes, ${formatNumber(tr, counts.bookmarks)} bookmarks, ${formatNumber(tr, counts.hifzItems)} hifz ayat and ${formatNumber(tr, counts.recallAttempts)} attempts.`,
          ),
          tr(
            'متن قرآن، ترجمه‌ها و تفسیرها هرگز از فایل پشتیبان خوانده یا نوشته نمی‌شوند.',
            'Quran text, translations and tafsir are never read from or written by a backup file.',
          ),
        ]}
        confirmLabel={tr('بازیابی کن', 'Restore it')}
        cancelLabel={tr('انصراف', 'Cancel')}
        busy={restoring}
        onConfirm={onConfirm}
      />
      <Button variant="ghost" onClick={onCancel}>
        {tr('انصراف از انتخاب', 'Discard this selection')}
      </Button>
    </div>
  );
}

/** The `MigrationResult` exactly as the gateway returned it — no paraphrasing. */
function ResultPanel({ tr, result }: { tr: Tr; result: MigrationResult }) {
  return (
    <div className="stack--tight">
      <p className="field__label">{tr('پیامد بازیابی', 'Restore outcome')}</p>
      {result.ok ? (
        <p className="msg msg--ok" role="status" aria-live="polite">
          {tr(`موفق: شمایه v${result.from} به v${result.to} رسید.`, `Applied: schema v${result.from} → v${result.to}.`)}
          {result.warnings.length > 0 ? ` ${tr('هشدارها:', 'Warnings:')}` : ''}
        </p>
      ) : (
        <p className="msg msg--error" role="alert" aria-live="assertive">
          {tr('رد شد — چیزی نوشته نشد:', 'Refused — nothing was written:')} <span className="mono">{result.error}</span>
        </p>
      )}
      {result.ok && result.warnings.length > 0 ? (
        <ul className="list">
          {result.warnings.map((warning, index) => (
            <li key={`w-${index}-${warning.slice(0, 24)}`}>{warning}</li>
          ))}
        </ul>
      ) : null}
      <pre className="mono result-json" dir="ltr">
        {JSON.stringify(result, null, 2)}
      </pre>
    </div>
  );
}

export const routes: readonly RouteDef[] = [
  {
    path: '/me/backup',
    title: (t: Tr) => t('پشتیبان و بازیابی', 'Backup & restore'),
    section: 'me',
    component: BackupScreen,
  },
];
