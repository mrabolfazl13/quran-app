/**
 * /hifz/progress — the stored history.
 *
 * Sessions come from `hifzSessions(20)`; every figure below is a computation
 * over the stored `recallAttempts` rows in this same render path: totals, the
 * median of the recorded accuracies, summed durations, and the per-item
 * accuracy sparkline drawn point-for-point from that item's attempts. With no
 * rows there are no zeros pretending to be data — the empty state answers.
 */
import type { HifzItem, HifzSession, RecallAttempt } from '@quran/core';
import { useApp } from '../../app/app-state';
import { StateBoundary, useAsync } from '../../ui/async';
import { Chip, LinkButton, Meter, Panel } from '../../ui/primitives';
import { AyahLink, BandTag, fmtDate, fmtDateTime, fmtDuration, fmtPct, medianOf, modeLabel } from './shared';

interface ProgressData {
  sessions: HifzSession[];
  attempts: RecallAttempt[];
  itemsById: Map<string, HifzItem>;
}

/** One honest sparkline: a point per stored attempt, y = its recorded accuracy. */
function Sparkline({ values, label }: { values: number[]; label: string }) {
  const width = 120;
  const height = 28;
  if (values.length === 0) return <span className="faint">—</span>;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values.map((v, i) => `${(values.length === 1 ? width / 2 : i * step).toFixed(1)},${(height - 2 - v * (height - 4)).toFixed(1)}`);
  return (
    <svg className="spark" width={width} height={height} role="img" aria-label={label} data-points={values.length}>
      <line className="spark__baseline" x1="0" y1={height - 2} x2={width} y2={height - 2} />
      {points.length === 1 ? (
        <circle cx={width / 2} cy={height - 2 - values[0]! * (height - 4)} r="2.5" />
      ) : (
        <polyline points={points.join(' ')} />
      )}
    </svg>
  );
}

export function ProgressScreen() {
  const { tr, gateway } = useApp();
  const data = useAsync<ProgressData>(async () => {
    if (!gateway) throw new Error(tr('ذخیره‌گاه باز نشده است', 'Storage is not open yet'));
    const [sessions, attempts, items] = await Promise.all([
      gateway.hifzSessions(20),
      gateway.recallAttempts(undefined, 5000),
      gateway.hifzItems(),
    ]);
    return { sessions, attempts, itemsById: new Map(items.map((i) => [i.id, i])) };
  }, [gateway, tr]);

  return (
    <StateBoundary
      state={data}
      emptyTitle={tr('هنوز تلاشی ثبت نشده است', 'No attempts have been recorded yet')}
      emptyBody={tr(
        'پیشرفت از دلِ تمرین‌های ذخیره‌شده محاسبه می‌شود؛ با صف داده، عددی هم نیست — و ما عدد جعلی نمی‌سازیم.',
        'Progress is computed from stored attempts; with an empty table there are no numbers — and we do not fake them.',
      )}
      emptyAction={<LinkButton to="/hifz/session" className="btn btn--primary">{tr('شروع نخستین نشست', 'Start your first session')}</LinkButton>}
      isEmpty={(value) => value.attempts.length === 0 && value.sessions.length === 0}
      onRetry={() => data.refresh()}
      skeleton={<div className="state state--loading">{tr('خواندن تاریخچه…', 'Reading history…')}</div>}
    >
      {(value) => <Progress data={value} />}
    </StateBoundary>
  );
}

function Progress({ data }: { data: ProgressData }) {
  const { tr } = useApp();
  const { attempts, sessions, itemsById } = data;

  const accuracies = attempts.map((a) => a.accuracy);
  const median = medianOf(accuracies);
  const timedAttempts = attempts.filter((a) => a.durationMs !== null);
  const totalMs = timedAttempts.reduce((sum, a) => sum + (a.durationMs ?? 0), 0);

  // Per-item timeline in chronological order (stored rows carry their own times).
  const byItem = new Map<string, RecallAttempt[]>();
  for (const a of attempts) {
    const list = byItem.get(a.itemId);
    if (list) list.push(a);
    else byItem.set(a.itemId, [a]);
  }
  const timelines = [...byItem.entries()]
    .map(([itemId, list]) => ({
      itemId,
      attempts: list.slice().sort((x, y) => Date.parse(x.startedAt) - Date.parse(y.startedAt) || x.id.localeCompare(y.id)),
    }))
    .sort((a, b) => (a.attempts[a.attempts.length - 1]?.startedAt ?? '').localeCompare(b.attempts[b.attempts.length - 1]?.startedAt ?? ''))
    .reverse();

  return (
    <div className="stack">
      <Panel title={tr('مجموع‌ها — از ردیف‌های ذخیره‌شده', 'Totals — computed over stored rows')}>
        <div className="row">
          <Chip tone="accent">{tr('تلاش‌ها', 'attempts')}: <span className="num">{attempts.length}</span></Chip>
          <Chip tone="neutral">{tr('میانیگین دقت', 'median accuracy')}: <span className="num">{median === null ? '—' : fmtPct(median)}</span></Chip>
          <Chip tone="neutral">{tr('مجموع زمان', 'recorded time')}: <span className="num">{fmtDuration(tr, attempts.length === 0 ? null : totalMs)}</span></Chip>
          <Chip tone="neutral">
            {tr('تلاش‌های بدون زمان ثبت‌شده', 'attempts without duration')}: <span className="num">{attempts.length - timedAttempts.length}</span>
          </Chip>
          <Chip tone="info">{tr('نشست‌های ۲۰ اخیر', 'last 20 sessions')}: <span className="num">{sessions.length}</span></Chip>
        </div>
      </Panel>

      <Panel title={tr('دقت هر آیه در طول زمان', 'Per-ayah accuracy over time')}>
        {timelines.length === 0 ? (
          <p className="muted">{tr('ردیف تلاشی نیست.', 'No attempt rows.')}</p>
        ) : (
          <ul className="list">
            {timelines.map(({ itemId, attempts: list }) => {
              const item = itemsById.get(itemId) ?? null;
              const values = list.map((a) => a.accuracy);
              const last = list[list.length - 1];
              return (
                <li key={itemId} className="item-row">
                  <span className="item-row__grow">
                    {item ? <AyahLink verseKey={item.verseKey} /> : <span className="mono ltr-iso">{itemId}</span>}
                    {item ? <BandTag band={item.band} /> : null}
                  </span>
                  <Sparkline values={values} label={tr('نمودار دقت تلاش‌های ذخیره‌شده', 'accuracy of the stored attempts')} />
                  <Chip tone="neutral">{tr('تلاش', 'attempts')}: <span className="num">{list.length}</span></Chip>
                  <Chip tone="neutral">{tr('میانه', 'median')}: <span className="num">{fmtPct(medianOf(values) ?? 0)}</span></Chip>
                  <span className="faint ltr-iso">{tr('آخرین', 'last')}: {last ? `${fmtPct(last.accuracy)} · ${fmtDate(last.startedAt)}` : '—'}</span>
                  {last ? <Chip tone="neutral">{tr('حالت', 'mode')}: <span className="rtl-iso">{modeLabel(tr, last.mode)}</span></Chip> : null}
                  {item ? <Meter value={item.stability} label={`${item.stability}`} /> : null}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel title={tr('نشست‌ها', 'Sessions')} action={<LinkButton to="/hifz/session" className="btn">{tr('نشست تازه', 'New session')}</LinkButton>}>
        {sessions.length === 0 ? (
          <p className="muted rtl-iso">{tr('نشستی ذخیره نشده است.', 'No session is stored.')}</p>
        ) : (
          <ul className="list">
            {sessions.map((s) => {
              const attempted = s.steps.filter((st) => st.attemptId !== null).length;
              return (
                <li key={s.id} className="item-row">
                  <span className="mono ltr-iso item-row__grow">{s.id}</span>
                  <span className="faint ltr-iso">{fmtDateTime(s.startedAt)} → {s.endedAt ? fmtDateTime(s.endedAt) : tr('بی‌پایان', 'open')}</span>
                  <Chip tone="neutral">{tr('گام ثبت‌شده', 'recorded steps')}: <span className="num">{attempted}</span>/<span className="num">{s.steps.length}</span></Chip>
                  {s.report ? (
                    <Chip tone={s.report.overallRecall >= 0.9 ? 'info' : 'warn'}>
                      {tr('بازخوانی', 'recall')} <span className="num">{fmtPct(s.report.overallRecall)}</span>
                    </Chip>
                  ) : (
                    <Chip tone="neutral">{tr('بدون گزارش', 'no report')}</Chip>
                  )}
                  <LinkButton to={`/hifz/session/${encodeURIComponent(s.id)}`}>{tr('گزارش', 'report')}</LinkButton>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <div className="row">
        <LinkButton to="/hifz">{tr('مأموریت امروز', 'Today’s mission')}</LinkButton>
        <LinkButton to="/hifz/items">{tr('مجموعهٔ حفظ', 'Hifz set')}</LinkButton>
      </div>
    </div>
  );
}
