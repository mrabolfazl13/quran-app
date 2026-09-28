/**
 * /hifz/session/:id — the stored session and its report.
 *
 * The report is rendered exactly as `finishSession()` stored it on the session
 * row; per-step outcomes join the stored attempts of the same sessionId. An
 * unfinished session (no report yet) says so — nothing is estimated here.
 */
import type { HifzSession, RecallAttempt } from '@quran/core';
import { useApp } from '../../app/app-state';
import type { RouteProps } from '../../app/router';
import { StateBoundary, useAsync } from '../../ui/async';
import { Chip, LinkButton, Meter, Panel } from '../../ui/primitives';
import { AyahLink, ErrorChips, errorKindLabel, fmtDateTime, fmtDuration, fmtPct, modeLabel } from './shared';

interface SessionData {
  session: HifzSession | null;
  attempts: RecallAttempt[];
}

export function SessionReportScreen({ params }: RouteProps) {
  const { tr, gateway } = useApp();
  const id = params.id ?? '';

  const data = useAsync<SessionData>(async () => {
    if (!gateway) throw new Error(tr('ذخیره‌گاه باز نشده است', 'Storage is not open yet'));
    const [sessions, attempts] = await Promise.all([gateway.hifzSessions(100), gateway.recallAttempts(undefined, 5000)]);
    return { session: sessions.find((s) => s.id === id) ?? null, attempts: attempts.filter((a) => a.sessionId === id) };
  }, [gateway, id, tr]);

  return (
    <StateBoundary
      state={data}
      emptyTitle={tr('نشستی با این شناسه ذخیره نشده است', 'No session with this id is stored')}
      emptyBody={tr(
        'نشست‌ها پس از «پایان نشست» در این آدرس ظاهر می‌شوند. شناسه را از صفحهٔ نشست بگیرید.',
        'Sessions appear here once finished from the runner. Open a finished one from the progress page.',
      )}
      emptyAction={
        <div className="row">
          <LinkButton to="/hifz/session" className="btn btn--primary">{tr('نشست تازه', 'New session')}</LinkButton>
          <LinkButton to="/hifz/progress">{tr('تاریخچهٔ نشست‌ها', 'Session history')}</LinkButton>
        </div>
      }
      isEmpty={(value) => value.session === null}
      onRetry={() => data.refresh()}
      skeleton={<div className="state state--loading">{tr('خواندن نشست…', 'Reading the session…')}</div>}
    >
      {(value) => (value.session ? <Report session={value.session} attempts={value.attempts} /> : null)}
    </StateBoundary>
  );
}

function Report({ session, attempts }: { session: HifzSession; attempts: RecallAttempt[] }) {
  const { tr } = useApp();
  const report = session.report;
  const attemptedCount = session.steps.filter((s) => s.attemptId !== null).length;
  const totalDuration = attempts.reduce((sum, a) => sum + (a.durationMs ?? 0), 0);
  const attemptsById = new Map(attempts.map((a) => [a.id, a]));

  return (
    <div className="stack">
      <Panel title={<span dir="auto">{tr('گزارش نشست', 'Session report')} · <span className="mono ltr-iso">{session.id}</span></span>}>
        <dl className="hifz-kv">
          <dt>{tr('آغاز', 'started')}</dt><dd className="mono ltr-iso">{fmtDateTime(session.startedAt)}</dd>
          <dt>{tr('پایان', 'ended')}</dt><dd className="mono ltr-iso">{session.endedAt ? fmtDateTime(session.endedAt) : tr('تمام نشده', 'not finished')}</dd>
          <dt>{tr('گام‌ها', 'steps')}</dt><dd className="num">{attemptedCount}/{session.steps.length} <span className="muted rtl-iso">ثبت‌شده</span></dd>
          <dt>{tr('زمان تلاش‌ها', 'attempt time')}</dt><dd className="num">{fmtDuration(tr, totalDuration)}</dd>
        </dl>
      </Panel>

      {report === null ? (
        <div className="state state--empty">
          <h3>{tr('این نشست گزارشی ذخیره نکرده است', 'This session stored no report')}</h3>
          <p className="muted rtl-iso">
            {session.endedAt === null
              ? tr('نشست هنوز تمام نشده؛ در صفحهٔ نشست «پایان نشست و گزارش» را بزنید.', 'The session is not finished — use “Finish & report” in the runner.')
              : tr('گزارش روی ردیف نشست ثبت نشده است؛ عددی از خود اضافه نمی‌کنیم.', 'No report row was persisted for this session; we will not invent one.')}
          </p>
          <LinkButton to="/hifz/session" className="btn btn--primary">{tr('نشست تازه', 'New session')}</LinkButton>
        </div>
      ) : (
        <>
          <Panel title={tr('جمع‌بندی', 'Summary')}>
            <div className="stack stack--tight">
              <div className="row">
                <Meter
                  value={report.overallRecall}
                  tone={report.overallRecall >= 0.9 ? 'accent' : report.overallRecall >= 0.6 ? 'warn' : 'danger'}
                  label={`${tr('بازخوانی کلی', 'overall recall')} ${fmtPct(report.overallRecall)}`}
                />
                <Chip tone="accent">{tr('آیات نو آموخته‌شده', 'new items learned')}: <span className="num">{report.newItemsLearned}</span></Chip>
                <Chip tone="info">{tr('مرورهای انجام‌شده', 'reviews completed')}: <span className="num">{report.reviewsCompleted}</span></Chip>
                <Chip tone="neutral">
                  {tr('مرور بعدی پیشنهادی', 'next review')}: <span className="mono ltr-iso">{fmtDateTime(report.recommendedNextReviewAt)}</span>
                </Chip>
              </div>
              {report.repeatedErrors.length > 0 ? (
                <div className="row" dir="auto">
                  <span className="muted rtl-iso">{tr('خطاهای تکرارشونده:', 'repeated errors:')}</span>
                  {report.repeatedErrors.map((e) => (
                    <Chip key={e.kind} tone="warn">
                      <span className="rtl-iso">{errorKindLabel(tr, e.kind)}</span> × <span className="num">{e.count}</span>
                    </Chip>
                  ))}
                </div>
              ) : (
                <span className="muted rtl-iso">{tr('خطای تکرارشونده‌ای ثبت نشد.', 'No repeated errors were recorded.')}</span>
              )}
              {report.confusedVerseKeys.length > 0 ? (
                <div className="row" dir="auto">
                  <span className="muted rtl-iso">{tr('آیات دچار اشتباه:', 'confused ayat:')}</span>
                  {report.confusedVerseKeys.map((key) => <AyahLink key={key} verseKey={key} />)}
                  <LinkButton to="/hifz/confusion">{tr('گروه‌های اشتباه', 'confusion groups')}</LinkButton>
                </div>
              ) : null}
            </div>
          </Panel>

          <div className="hifz-columns">
            <Panel title={tr('پاره‌های ضعیف', 'Weak segments')}>
              {report.weakSegments.length === 0 ? (
                <p className="muted">{tr('در این نشست، پاره‌ای زیر آستانهٔ ضعف نرفت.', 'No segment fell under the weak threshold this session.')}</p>
              ) : (
                <ul className="list">
                  {report.weakSegments.map((s) => (
                    <li key={`${s.itemId}-${s.segmentPosition}`}>
                      <span className="mono ltr-iso">{s.itemId}</span>{' · '}
                      {tr('پاره', 'segment')} <span className="num">{s.segmentPosition}</span>{' · '}
                      <Meter value={s.accuracy} label={fmtPct(s.accuracy)} tone="warn" />
                      <LinkButton to="/hifz/items" className="faint">{tr('بافت', 'fingerprint')}</LinkButton>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title={tr('گذارهای ضعف', 'Weak transitions')}>
              {report.weakTransitions.length === 0 ? (
                <p className="muted">{tr('گذار سستی در این نشست ثبت نشد.', 'No weak transition was recorded this session.')}</p>
              ) : (
                <ul className="list">
                  {report.weakTransitions.map((t) => (
                    <li key={`${t.itemId}-${t.toWord}`}>
                      <span className="mono ltr-iso">{t.itemId}</span>{' · '}
                      {tr('واژهٔ گذار', 'boundary word')} <span className="num">{t.toWord}</span>{' · '}
                      <Meter value={t.stability} label={fmtPct(t.stability)} tone="danger" />
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <Panel title={tr('تغییر پایداری آیات', 'Item stability changes')}>
            {report.stabilityChanges.length === 0 ? (
              <p className="muted">{tr('موردی تغییر نکرد.', 'No item changed.')}</p>
            ) : (
              <ul className="list">
                {report.stabilityChanges.map((c) => (
                  <li key={c.itemId}>
                    <span className="mono ltr-iso">{c.itemId}</span>{' · '}
                    <span className="num">{c.before}</span> → <span className="num">{c.after}</span>
                    <Meter value={c.after} tone={c.after >= c.before ? 'accent' : 'danger'} />
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}

      <Panel title={tr('گام‌به‌گام', 'Step by step')}>
        <ul className="list">
          {session.steps.map((s, i) => {
            const attempt = s.attemptId ? attemptsById.get(s.attemptId) ?? null : null;
            return (
              <li key={`${s.mode}-${i}`} className="item-row">
                <span className="num faint">{i + 1}</span>
                <span className="rtl-iso">{modeLabel(tr, s.mode)}</span>
                {s.verseKey ? <AyahLink verseKey={s.verseKey} /> : <span className="faint">{tr('بی‌آیه', 'no ayah')}</span>}
                {attempt ? (
                  <span className="row stack--tight item-row__grow">
                    <Chip tone={attempt.accuracy >= 0.9 ? 'info' : attempt.accuracy >= 0.6 ? 'warn' : 'danger'}>
                      {fmtPct(attempt.accuracy)}
                    </Chip>
                    <span className="faint">{fmtDuration(tr, attempt.durationMs)}</span>
                    {attempt.errors.length > 0 ? (
                      <details className="disclosure" style={{ minWidth: 240 }}>
                        <summary>{tr(`${attempt.errors.length} خطای ثبت‌شده`, `${attempt.errors.length} stored errors`)}</summary>
                        <ErrorChips errors={attempt.errors} />
                      </details>
                    ) : null}
                  </span>
                ) : (
                  <span className="faint rtl-iso item-row__grow">{s.completedAt ? fmtDateTime(s.completedAt) : tr('بدون تلاش', 'no attempt')}</span>
                )}
              </li>
            );
          })}
        </ul>
      </Panel>

      <div className="row">
        <LinkButton to="/hifz">{tr('بازگشت به امروز', 'Back to today')}</LinkButton>
        <LinkButton to="/hifz/progress">{tr('همهٔ نشست‌ها', 'All sessions')}</LinkButton>
      </div>
    </div>
  );
}
