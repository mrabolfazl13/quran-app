/**
 * /hifz/weak — the weak front.
 *
 * Two honest sources: the engine's `plan.weakItems`, and a tally of the error
 * kinds actually stored in `recallAttempts` — items whose recent attempts show
 * repeated errors. Counting stored `errors` rows is an aggregation for
 * display; the accuracy/stability/priority numbers are only ever the engine's.
 */
import type { DailyPlan, HifzItem, RecallAttempt, ReviewPlanEntry } from '@quran/core';
import { useApp } from '../../app/app-state';
import { StateBoundary, useAsync } from '../../ui/async';
import { Chip, LinkButton, Meter, Panel } from '../../ui/primitives';
import { AyahLink, BandTag, errorKindLabel, fmtDate, fmtPct, modeLabel, useHifzFacade } from './shared';

interface WeakData {
  plan: DailyPlan;
  itemsById: Map<string, HifzItem>;
  /** Items with ≥2 non-correct errors in their last five attempts. */
  repeatOffenders: { item: HifzItem; dominant: { kind: string; count: number } | null; recent: RecallAttempt[] }[];
}

export function WeakScreen() {
  const { tr, gateway } = useApp();
  const facade = useHifzFacade();
  const data = useAsync<WeakData>(async () => {
    if (!facade || !gateway) throw new Error(tr('ذخیره‌گاه باز نشده است', 'Storage is not open yet'));
    const [plan, items, attempts] = await Promise.all([
      facade.todayPlan(new Date()),
      gateway.hifzItems('active'),
      gateway.recallAttempts(undefined, 5000),
    ]);
    const itemsById = new Map(items.map((i) => [i.id, i]));
    // Group attempts by item in chronological order (startedAt), take the last
    // five, and count the error kinds the engine stored on them.
    const byItem = new Map<string, RecallAttempt[]>();
    for (const a of attempts) {
      const list = byItem.get(a.itemId);
      if (list) list.push(a);
      else byItem.set(a.itemId, [a]);
    }
    const repeatOffenders: WeakData['repeatOffenders'] = [];
    for (const [itemId, list] of byItem) {
      const item = itemsById.get(itemId);
      if (!item) continue;
      const recent = list
        .slice()
        .sort((x, y) => Date.parse(x.startedAt) - Date.parse(y.startedAt))
        .slice(-5);
      const counts = new Map<string, number>();
      for (const a of recent) for (const e of a.errors) if (e.kind !== 'correct') counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
      let total = 0;
      for (const n of counts.values()) total += n;
      if (total < 2) continue;
      let dominant: { kind: string; count: number } | null = null;
      for (const [kind, count] of counts) {
        if (dominant === null || count > dominant.count) dominant = { kind, count };
      }
      repeatOffenders.push({ item, dominant, recent });
    }
    repeatOffenders.sort((a, b) => a.item.stability - b.item.stability || a.item.verseKey.localeCompare(b.item.verseKey));
    return { plan, itemsById, repeatOffenders };
  }, [facade, gateway, tr]);

  return (
    <StateBoundary
      state={data}
      emptyTitle={tr('نقطهٔ ضعفی ثبت نشده است', 'No weak spots recorded')}
      emptyBody={tr(
        'یا هنوز تلاشی ثبت نشده، یا آخرین تمرین‌ها بدون خطای تکراری بوده‌اند. یک نشست انجام دهید تا داده جمع شود.',
        'Either no attempts exist yet, or the recent ones carried no repeated errors. Run a session to gather data.',
      )}
      emptyAction={<LinkButton to="/hifz/session" className="btn btn--primary">{tr('شروع نشست', 'Start session')}</LinkButton>}
      isEmpty={(value) => value.plan.weakItems.length === 0 && value.repeatOffenders.length === 0}
      onRetry={() => data.refresh()}
      skeleton={<div className="state state--loading">{tr('واکاوی تلاش‌ها…', 'Reviewing attempts…')}</div>}
    >
      {(value) => (
        <div className="stack">
          <Panel title={tr('ضعیف‌های برنامهٔ امروز (خروجی موتور)', `Weak items in today’s plan (engine output)`)}>
            {value.plan.weakItems.length === 0 ? (
              <p className="muted">{tr('موتور امروز مورد ضعیفی نگذاشته است.', 'The engine put no weak item in today’s plan.')}</p>
            ) : (
              <ul className="list">
                {value.plan.weakItems.map((entry) => (
                  <WeakPlanRow key={entry.itemId} entry={entry} item={value.itemsById.get(entry.itemId) ?? null} />
                ))}
              </ul>
            )}
          </Panel>

          <Panel title={tr('خطاهای تکراری در پنج تلاش آخر', 'Repeated errors in the last five attempts')}>
            {value.repeatOffenders.length === 0 ? (
              <p className="muted">{tr('هیچ موردی دو خطای نادرستِ ثبت‌شده یا بیشتر در تلاش‌های اخیر ندارد.', 'No item carries two or more stored errors across its recent attempts.')}</p>
            ) : (
              <ul className="list">
                {value.repeatOffenders.map(({ item, dominant, recent }) => (
                  <li key={item.id} className="item-row">
                    <span className="item-row__grow">
                      <AyahLink verseKey={item.verseKey} />
                      <BandTag band={item.band} />
                    </span>
                    {dominant ? (
                      <Chip tone="danger">
                        {tr('خطای غالب', 'dominant error')}: <span className="rtl-iso">{errorKindLabel(tr, dominant.kind)}</span> × <span className="num">{dominant.count}</span>
                      </Chip>
                    ) : null}
                    <Chip tone="neutral">{tr('دقت آخرین', 'last accuracy')}: <span className="num">{recent[recent.length - 1] ? fmtPct(recent[recent.length - 1]!.accuracy) : '—'}</span></Chip>
                    <Meter value={item.stability} label={`${item.stability}`} tone="danger" />
                    <span className="faint ltr-iso mono">{fmtDate(item.nextReviewAt)}</span>
                    <LinkButton to="/hifz/session" className="btn">{tr('تمرین', 'Drill')}</LinkButton>
                  </li>
                ))}
              </ul>
            )}
            <p className="faint rtl-iso" style={{ marginTop: 'var(--sp-3)' }}>
              {tr(
                'شمارش‌ها از ردیف‌های errorsِ تلاش‌های ذخیره‌شده است؛ هیچ دقت یا بانده‌ای اینجا دوباره محاسبه نشده.',
                'These counts read the stored attempts’ errors rows; no accuracy or band is recomputed here.',
              )}
            </p>
          </Panel>
        </div>
      )}
    </StateBoundary>
  );
}

function WeakPlanRow({ entry, item }: { entry: ReviewPlanEntry; item: HifzItem | null }) {
  const { tr } = useApp();
  return (
    <li className="item-row">
      <span className="item-row__grow">
        <AyahLink verseKey={entry.verseKey} />
        {item ? <BandTag band={item.band} /> : null}
      </span>
      <Chip tone="warn">{tr('اولویت', 'priority')} <span className="mono num">{entry.priority}</span></Chip>
      <Chip tone="neutral">{tr('حالت', 'mode')}: <span className="rtl-iso">{modeLabel(tr, entry.suggestedMode)}</span></Chip>
      <span className="muted mono ltr-iso" dir="ltr">{entry.reason}</span>
      {item ? <Meter value={item.stability} tone="danger" label={`${item.stability}`} /> : null}
      <LinkButton to="/hifz/session" className="btn">{tr('تمرین', 'Drill')}</LinkButton>
    </li>
  );
}
