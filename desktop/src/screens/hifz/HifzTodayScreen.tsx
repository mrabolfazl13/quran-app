/**
 * /hifz — today's mission.
 *
 * Everything on this screen is either an engine output (`todayPlan()`,
 * `status()`) or a gateway read (`hifzItems('active')`). The plan's estimated
 * minutes are shown exactly as the engine computed them; the band histogram is
 * a count over stored items, not a score.
 */
import type { DailyPlan, HifzItem } from '@quran/core';
import type { HifzFacadeStatus } from '../../engine/hifzFacade';
import { useApp } from '../../app/app-state';
import { StateBoundary, useAsync } from '../../ui/async';
import { Chip, LinkButton, Panel } from '../../ui/primitives';
import { BandTag, AyahLink, reviewReason, useHifzFacade } from './shared';

interface TodayData {
  plan: DailyPlan;
  items: HifzItem[];
}

function bandCounts(items: HifzItem[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) map.set(item.band, (map.get(item.band) ?? 0) + 1);
  return map;
}

/** The facade status chip — integrated with the real detail, or not with the reason. */
export function FacadeStatusChip() {
  const { tr } = useApp();
  const facade = useHifzFacade();
  const status = useAsync<HifzFacadeStatus>(async () => {
    if (!facade) throw new Error(tr('ذخیره‌گاه باز نشده است', 'Storage is not open yet'));
    return facade.status();
  }, [facade, tr]);
  if (status.status === 'loading') return <Chip tone="neutral">{tr('سنجش موتور…', 'checking engine…')}</Chip>;
  if (status.status === 'error') return <Chip tone="danger">{status.error instanceof Error ? status.error.message : String(status.error)}</Chip>;
  const value = status.value;
  if (!value) return null;
  return value.integrated ? (
    <Chip tone="info" title={value.detail}>{tr('موتور حافظه یکپارچه است', 'Memory engine integrated')} · <span className="ltr-iso">{value.detail}</span></Chip>
  ) : (
    <Chip tone="danger" title={value.detail}>{tr('موتور حافظه در این ساخت نیست', 'Memory engine not present in this build')}</Chip>
  );
}

export function HifzTodayScreen() {
  const { tr, gateway } = useApp();
  const facade = useHifzFacade();

  const data = useAsync<TodayData>(async () => {
    if (!facade || !gateway) throw new Error(tr('ذخیره‌گاه باز نشده است', 'Storage is not open yet'));
    const [plan, items] = await Promise.all([facade.todayPlan(new Date()), gateway.hifzItems('active')]);
    return { plan, items };
  }, [facade, gateway, tr]);

  return (
    <div className="stack">
      <div className="row">
        <FacadeStatusChip />
      </div>
      <StateBoundary
        state={data}
        emptyTitle={tr('هنوز آیه‌ای در برنامهٔ حفظ نیست', 'No ayat in the hifz set yet')}
        emptyBody={tr(
          'چند آیه انتخاب کنید تا موتور حافظه برنامهٔ امروز، اثر حافظه و زمان‌بندی مرورشان را بسازد.',
          'Pick a few ayat and the memory engine builds today’s plan, their fingerprint and a review schedule.',
        )}
        emptyAction={
          <LinkButton to="/hifz/items" className="btn btn--primary">
            {tr('افزودن آیات', 'Add ayat')}
          </LinkButton>
        }
        isEmpty={(value) => value.items.length === 0}
        onRetry={() => data.refresh()}
        skeleton={<div className="state state--loading">{tr('محاسبهٔ برنامهٔ امروز…', 'Computing today’s plan…')}</div>}
      >
        {(value) => <Today plan={value.plan} items={value.items} />}
      </StateBoundary>
    </div>
  );
}

function Today({ plan, items }: { plan: DailyPlan; items: HifzItem[] }) {
  const { tr } = useApp();
  const counts = bandCounts(items);
  const orderedBands = ['new', 'unstable', 'weak', 'stable', 'mastered'] as const;
  const stepTotal = plan.newAyahs.length + plan.reviewItems.length + plan.weakItems.length;

  return (
    <div className="stack">
      <Panel
        title={tr('مأموریت امروز', 'Today’s mission')}
        action={
          <LinkButton to="/hifz/session" className="btn btn--primary">
            {tr('شروع نشست', 'Start session')}
          </LinkButton>
        }
      >
        <div className="row stack--tight">
          <Chip tone="accent">{tr(`تاریخ برنامه: ${plan.date}`, `plan date ${plan.date}`)}</Chip>
          <Chip tone="neutral">
            {tr('گام‌ها', 'steps')}: <span className="num">{stepTotal}</span>
          </Chip>
          <Chip tone="neutral" title={tr('مقادیر دقیق، گرد نشده', 'exact, not rounded')}>
            {tr('زمان تخمینی', 'estimated')}:{' '}
            <span className="num">{plan.estimatedMinutes}</span>{' '}
            {tr('دقیقه', 'min')}
            <span className="faint ltr-iso"> = {(plan.estimatedMinutes * 60).toLocaleString('en', { maximumFractionDigits: 2 })}s</span>
          </Chip>
        </div>
      </Panel>

      <div className="hifz-columns">
        <Panel title={tr('آیات نو', 'New ayat')}>
          {plan.newAyahs.length === 0 ? (
            <p className="muted">{tr('آیهٔ تازه‌ای برای امروز نیست.', 'No new ayat scheduled today.')}</p>
          ) : (
            <ul className="list">
              {plan.newAyahs.map((key) => (
                <li key={key}>
                  <AyahLink verseKey={key} />
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title={tr('مرورهای امروز', 'Reviews due')}
          action={<LinkButton to="/hifz/review">{tr('صفحهٔ مرور', 'Review page')}</LinkButton>}
        >
          {plan.reviewItems.length === 0 ? (
            <p className="muted">{tr('مرور بدهکاری نیست.', 'Nothing owed for review.')}</p>
          ) : (
            <>
              <p className="muted">
                {tr('کل', 'total')}: <span className="num">{plan.reviewItems.length}</span> ·{' '}
                {tr('بالاترین اولویت (خروجی موتور)', 'top priority (engine output)')}{' '}
                <span className="mono num">{plan.reviewItems[0]?.priority}</span>
              </p>
              <ul className="list">
                {plan.reviewItems.slice(0, 6).map((entry) => (
                  <li key={entry.itemId}>
                    <AyahLink verseKey={entry.verseKey} />{' '}
                    <span className="faint" dir="auto">{reviewReason(tr, entry.reason)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Panel>

        <Panel
          title={tr('نقاط ضعف', 'Weak items')}
          action={<LinkButton to="/hifz/weak">{tr('صفحهٔ ضعف‌ها', 'Weak page')}</LinkButton>}
        >
          {plan.weakItems.length === 0 ? (
            <p className="muted">{tr('مورد ضعیفی در برنامه نیست.', 'No weak items in the plan.')}</p>
          ) : (
            <ul className="list">
              {plan.weakItems.slice(0, 6).map((entry) => (
                <li key={entry.itemId}>
                  <AyahLink verseKey={entry.verseKey} />{' '}
                  <Chip tone="warn">{tr(`اولویت ${entry.priority}`, `priority ${entry.priority}`)}</Chip>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title={tr('گروه‌های اشتباه', 'Confusion groups')}
          action={<LinkButton to="/hifz/confusion">{tr('مدیریت', 'Manage')}</LinkButton>}
        >
          {plan.confusionGroups.length === 0 ? (
            <p className="muted">{tr('گروهی در برنامهٔ امروز نیست.', 'No confusion group in today’s plan.')}</p>
          ) : (
            <ul className="list">
              {plan.confusionGroups.map((id) => (
                <li key={id} className="mono">{id}</li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title={tr('توزیع باندها — آیات فعال', 'Band distribution — active ayat')}>
        <div className="row">
          {orderedBands.map((band) => (
            <span key={band} className="row stack--tight">
              <BandTag band={band} />
              <span className="num">{counts.get(band) ?? 0}</span>
            </span>
          ))}
          <span className="muted">
            {tr('مجموع', 'sum')}: <span className="num">{items.length}</span>{' '}
            {tr('آیهٔ فعال', 'active items')}
          </span>
        </div>
        <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
          <LinkButton to="/hifz/items">{tr('مدیریت آیات حفظ', 'Manage hifz items')}</LinkButton>
          <LinkButton to="/hifz/progress">{tr('پیشرفت', 'Progress')}</LinkButton>
        </div>
      </Panel>
    </div>
  );
}
