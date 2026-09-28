/**
 * /hifz/confusion — the similar-ayah mix-ups.
 *
 * The list is the stored `ConfusionGroup` rows; each row shows exactly what a
 * group stores as evidence: its members, how often a confusion error named it
 * (`confusionCount`), when it last fired, and who created it (user or engine).
 * `refreshConfusionGroups()` lets the engine propose new groups from attempt
 * history; the drill runs inside a session — the engine's session builder puts
 * confusion members back to back on purpose (phase 5).
 */
import { useState } from 'react';
import type { ConfusionGroup } from '@quran/core';
import { useApp } from '../../app/app-state';
import { StateBoundary, useAsync } from '../../ui/async';
import { Button, Chip, LinkButton, Panel } from '../../ui/primitives';
import { AyahLink, errorMessage, fmtDateTime, useHifzFacade } from './shared';

export function ConfusionScreen() {
  const { tr, gateway } = useApp();
  const facade = useHifzFacade();
  const groups = useAsync<ConfusionGroup[]>(async () => {
    if (!gateway) throw new Error(tr('ذخیره‌گاه باز نشده است', 'Storage is not open yet'));
    return gateway.confusionGroups();
  }, [gateway, tr]);

  const [busy, setBusy] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<unknown>(null);

  async function refreshFromEngine(): Promise<void> {
    if (!facade) return;
    setBusy(true);
    setRefreshError(null);
    try {
      const ids = await facade.refreshConfusionGroups(new Date());
      setRefreshMessage(
        ids.length === 0
          ? tr('موتور گروه تازه‌ای از تاریخچهٔ تلاش‌ها نیافت.', 'The engine found no new group in the attempt history.')
          : tr(`موتور ${ids.length} گروه پیشنهاد کرد و ذخیره شد.`, `The engine proposed and stored ${ids.length} group(s).`),
      );
      groups.refresh();
    } catch (cause) {
      setRefreshError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <Panel
        title={tr('گروه‌های اشتباه', 'Confusion groups')}
        action={<Button busy={busy} disabled={!facade} onClick={() => void refreshFromEngine()}>{tr('پیشنهاد دوبارهٔ موتور', 'Re-run engine proposals')}</Button>}
      >
        <p className="muted rtl-iso">
          {tr(
            'گروه وقتی ساخته می‌شود که خوانش شما آیاتِ مشابه را جابه‌جا بگوید — همان‌طور که موتور طبقه‌بندی در تلاش‌های ذخیره‌شده می‌بیند. مرورِ اعضای گروه اولویت بیشتری می‌گیرد.',
            'A group forms when your recitation swaps similar ayat — as the classifier recorded it in your stored attempts. Reviews of group members get a priority boost.',
          )}
        </p>
        {refreshMessage ? <p role="status" className="muted rtl-iso">{refreshMessage}</p> : null}
        {refreshError ? <p role="alert" className="field__error mono" dir="auto">{errorMessage(refreshError)}</p> : null}
      </Panel>

      <StateBoundary
        state={groups}
        emptyTitle={tr('گروه اشتباهی ثبت نشده است', 'No confusion group is recorded')}
        emptyBody={tr(
          'گروه‌ها از دلِ تمرین بیرون می‌آیند، نه از پیش‌فرض: چند نشست بخوانید؛ اگر جابه‌جایی آیاتِ مشابه رخ دهد، موتور خود گروه پیشنهاد می‌دهد.',
          'Groups come from practice, not defaults: run a few sessions — when the engine sees similar-ayah swaps in your attempts it proposes groups itself.',
        )}
        emptyAction={<LinkButton to="/hifz/session" className="btn btn--primary">{tr('شروع نشست', 'Start session')}</LinkButton>}
        isEmpty={(value) => value.length === 0}
        onRetry={() => groups.refresh()}
        skeleton={<div className="state state--loading">{tr('خواندن گروه‌ها…', 'Reading groups…')}</div>}
      >
        {(value) => (
          <div className="stack">
            {value.map((group) => <GroupCard key={group.id} group={group} />)}
          </div>
        )}
      </StateBoundary>
    </div>
  );
}

function GroupCard({ group }: { group: ConfusionGroup }) {
  const { tr } = useApp();
  return (
    <Panel
      title={
        <span dir="auto">
          {group.label ?? <span className="mono ltr-iso">{group.id}</span>}
          {' · '}
          <Chip tone={group.origin === 'engine' ? 'info' : 'accent'}>
            {group.origin === 'engine' ? tr('پیشنهاد موتور', 'engine-proposed') : tr('ساخت کاربر', 'user-created')}
          </Chip>
        </span>
      }
      action={<LinkButton to="/hifz/session" className="btn btn--primary">{tr('تمرین در نشست', 'Drill in session')}</LinkButton>}
    >
      <div className="stack stack--tight">
        <div className="row" dir="auto">
          <span className="muted rtl-iso">{tr('اعضا:', 'members:')}</span>
          {group.verseKeys.map((key) => <AyahLink key={key} verseKey={key} />)}
        </div>
        <div className="row">
          <Chip tone={group.confusionCount > 0 ? 'warn' : 'neutral'}>
            {tr('شمار اشتباه‌های ثبت‌شده', 'recorded confusions')} <span className="num">{group.confusionCount}</span>
          </Chip>
          <Chip tone="neutral">
            {tr('آخرین بروز', 'last fired')} <span className="mono ltr-iso">{fmtDateTime(group.lastTriggeredAt)}</span>
          </Chip>
          <Chip tone="neutral">
            {tr('ساخته‌شده', 'created')} <span className="mono ltr-iso">{fmtDateTime(group.createdAt)}</span>
          </Chip>
          <LinkButton to="/hifz/weak">{tr('ضعیف‌ها', 'weak spots')}</LinkButton>
        </div>
      </div>
    </Panel>
  );
}
