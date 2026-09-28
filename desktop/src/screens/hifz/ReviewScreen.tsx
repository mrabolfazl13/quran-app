/**
 * /hifz/review — the review queue.
 *
 * Rows come from `todayPlan().reviewItems`, in the engine's own priority order
 * (core sorts by priority desc, dueAt asc, verseKey asc — we keep that order).
 * The "why" column shows the entry's stored reason and factor contributions,
 * plus date differences computed from `hifzItems` rows. Nothing is invented.
 */
import type { DailyPlan, HifzItem, ReviewPlanEntry } from '@quran/core';
import { useApp } from '../../app/app-state';
import { StateBoundary, useAsync } from '../../ui/async';
import { Chip, LinkButton, Meter, Panel } from '../../ui/primitives';
import { AyahLink, BandTag, daysSince, fmtDate, modeLabel, useHifzFacade } from './shared';

interface QueueData {
  plan: DailyPlan;
  itemsById: Map<string, HifzItem>;
}

export function ReviewScreen() {
  const { tr, gateway } = useApp();
  const facade = useHifzFacade();
  const data = useAsync<QueueData>(async () => {
    if (!facade || !gateway) throw new Error(tr('ذخیره‌گاه باز نشده است', 'Storage is not open yet'));
    const [plan, items] = await Promise.all([facade.todayPlan(new Date()), gateway.hifzItems()]);
    return { plan, itemsById: new Map(items.map((i) => [i.id, i])) };
  }, [facade, gateway, tr]);

  return (
    <StateBoundary
      state={data}
      emptyTitle={tr('مروری برای امروز بدهکار نیست', 'No reviews are owed today')}
      emptyBody={tr(
        'هرچه تمرین دقیق‌تر ثبت شود، زمان‌بندی موتور درست‌تر می‌شود. برای آیات تازه به مجموعهٔ حفظ بروید.',
        'The more accurately practice is recorded, the better the engine schedules. Add new ayat from the hifz set.',
      )}
      emptyAction={
        <div className="row">
          <LinkButton to="/hifz/items" className="btn btn--primary">{tr('افزودن آیات', 'Add ayat')}</LinkButton>
          <LinkButton to="/hifz">{tr('مأموریت امروز', 'Today’s mission')}</LinkButton>
        </div>
      }
      isEmpty={(value) => value.plan.reviewItems.length === 0}
      onRetry={() => data.refresh()}
      skeleton={<div className="state state--loading">{tr('خواندن صف مرور…', 'Reading the review queue…')}</div>}
    >
      {(value) => <Queue plan={value.plan} itemsById={value.itemsById} />}
    </StateBoundary>
  );
}

function Queue({ plan, itemsById }: { plan: DailyPlan; itemsById: Map<string, HifzItem> }) {
  const { tr } = useApp();
  const nowMs = Date.now();
  return (
    <div className="stack">
      <Panel
        title={tr('صف مرور — به ترتیب اولویتِ خودِ موتور', 'Review queue — in the engine’s own priority order')}
        action={
          <LinkButton to="/hifz/session" className="btn btn--primary">{tr('ورود به نشست', 'Enter session')}</LinkButton>
        }
      >
        <p className="muted rtl-iso">
          {tr(
            `امروز ${plan.reviewItems.length} مورد برای مرور تعیین شده است؛ مجموع زمان برنامه ${plan.estimatedMinutes} دقیقه.`,
            `${plan.reviewItems.length} items are scheduled today; the whole plan is estimated at ${plan.estimatedMinutes} minutes.`,
          )}
        </p>
        <ul className="list">
          {plan.reviewItems.map((entry) => (
            <ReviewRow key={entry.itemId} entry={entry} item={itemsById.get(entry.itemId) ?? null} nowMs={nowMs} />
          ))}
        </ul>
      </Panel>
    </div>
  );
}

function ReviewRow({ entry, item, nowMs }: { entry: ReviewPlanEntry; item: HifzItem | null; nowMs: number }) {
  const { tr } = useApp();
  const lastDays = daysSince(item?.lastReviewedAt ?? null, nowMs);
  const dueDays = daysSince(entry.dueAt, nowMs);
  const factorKeys = Object.keys(entry.factors).filter((k) => !k.endsWith('-raw'));
  return (
    <li className="item-row">
      <span className="item-row__grow">
        <AyahLink verseKey={entry.verseKey} />
        {item ? <BandTag band={item.band} /> : <Chip tone="neutral">{tr('مورد پاک شده', 'item removed')}</Chip>}
      </span>
      <Chip tone="warn" title={tr('اولویت خام موتور (پیش از تقویت گروهی)', 'engine raw priority (before group boost)')}>
        {tr('اولویت', 'priority')} <span className="num mono">{entry.priority}</span>
      </Chip>
      <span className="faint rtl-iso">
        {tr('از آخرین تمرین', 'since last practice')}:{' '}
        <span className="num">{lastDays === null ? '—' : lastDays}</span> {tr('روز', 'd')}
      </span>
      <span className="faint rtl-iso">
        {dueDays !== null && dueDays > 0
          ? tr(`${dueDays} روز گذشته از سررسید`, `${dueDays} d past due`)
          : tr('سررسید', 'due')} <span className="mono ltr-iso">{fmtDate(entry.dueAt)}</span>
      </span>
      {item ? <Meter value={item.stability} label={`${item.stability}`} tone={item.stability >= 0.7 ? 'accent' : 'danger'} /> : null}
      <Chip tone="neutral">{tr('حالت پیشنهادی', 'suggested mode')}: <span className="rtl-iso">{modeLabel(tr, entry.suggestedMode)}</span></Chip>
      <details className="disclosure" style={{ maxWidth: '100%' }}>
        <summary>{tr('چرا الان؟ (خروجی مرورگر)', 'why now? (scheduler output)')}</summary>
        <p className="muted mono ltr-iso" dir="ltr">{entry.reason}</p>
        <div className="row" dir="auto">
          {factorKeys.map((k) => (
            <Chip key={k} tone="info">
              <span className="ltr-iso">{k}</span> <span className="num mono">{entry.factors[k]}</span>
            </Chip>
          ))}
        </div>
        <div className="row">
          <LinkButton to={`/quran/ayah/${encodeURIComponent(entry.verseKey)}`}>{tr('متن آیه', 'ayah text')}</LinkButton>
          <LinkButton to="/hifz/session">{tr('تمرین', 'drill')}</LinkButton>
        </div>
      </details>
    </li>
  );
}
