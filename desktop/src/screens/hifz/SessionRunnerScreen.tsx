/**
 * /hifz/session — the session runner. The most important screen in the app.
 *
 * `startSession()` builds the ordered steps; every step's cue comes from
 * `probeForStep()`; the recitation is scored only by `submitRecall()` (core's
 * classifier) and the verdict shown here is the stored `RecallAttempt` —
 * re-read with `recallAttempts(itemId, 1)` so the learner sees the row that
 * actually landed in the database. The target ayah stays hidden until
 * submission; the learner's own text is never rewritten.
 */
import { useEffect, useRef, useState } from 'react';
import type { HifzItem, HifzSession, RecallAttempt, VerseKey } from '@quran/core';
import type { StepProbe } from '../../engine/hifzFacade';
import { useApp } from '../../app/app-state';
import { navigate } from '../../app/router';
import { StateBoundary, useAsync, type AsyncState } from '../../ui/async';
import { Button, Chip, LinkButton, Meter, Panel } from '../../ui/primitives';
import {
  AyahLink,
  BandTag,
  ErrorChips,
  WordAlignment,
  cueLabel,
  errorMessage,
  fmtDuration,
  fmtPct,
  modeHelp,
  modeLabel,
  probeReason,
  splitRecited,
  useHifzFacade,
  useVerseWords,
} from './shared';

interface Verdict {
  attempt: RecallAttempt;
  saved: RecallAttempt | null;
  itemAfter: HifzItem | null;
}

export function SessionRunnerScreen() {
  const { tr } = useApp();
  const facade = useHifzFacade();
  const [session, setSession] = useState<HifzSession | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<unknown>(null);

  async function start(): Promise<void> {
    if (!facade) return;
    setStarting(true);
    setStartError(null);
    try {
      setSession(await facade.startSession(new Date(), 0));
    } catch (cause) {
      setStartError(cause);
    } finally {
      setStarting(false);
    }
  }

  if (session !== null) return <ActiveRunner session={session} />;

  return (
    <div className="stack">
      <Panel title={tr('نشست حفظ', 'Hifz session')}>
        <p className="muted measure rtl-iso">
          {tr(
            'نشست از برنامهٔ امروز ساخته می‌شود: گرم‌کردن، آیات نو، مرورهای بدهکار، گذارها و تمرین مشابه‌ها. هر پاسخ همین‌جا توسط موتور حافظه نمره می‌شود و در پایگاه داده ذخیره می‌شود.',
            'The session is built from today’s plan: warm-up, new ayat, owed reviews, transitions and similar-ayah drills. Every answer is scored by the memory engine and stored.',
          )}
        </p>
        <div className="row">
          <Button variant="primary" busy={starting} onClick={() => void start()}>
            {tr('شروع نشست', 'Start session')}
          </Button>
          <LinkButton to="/hifz">{tr('برنامهٔ امروز', 'Today’s plan')}</LinkButton>
        </div>
        {startError ? (
          <div className="state state--error" role="alert" style={{ marginTop: 'var(--sp-4)' }}>
            <h3>{tr('نشست آغاز نشد', 'The session could not start')}</h3>
            <p className="muted mono" dir="auto">{errorMessage(startError)}</p>
            <Button onClick={() => void start()}>{tr('تلاش دوباره', 'Try again')}</Button>
          </div>
        ) : null}
      </Panel>
    </div>
  );
}

/** Everything below only mounts once a session exists, so hooks stay unconditional. */
function ActiveRunner({ session }: { session: HifzSession }) {
  const { tr } = useApp();
  const facade = useHifzFacade();
  const [stepIndex, setStepIndex] = useState(0);
  const [done, setDone] = useState<ReadonlySet<number>>(new Set());
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<unknown>(null);

  const total = session.steps.length;
  const probe = useStepProbe(session, Math.min(stepIndex, Math.max(total - 1, 0)));

  async function finish(): Promise<void> {
    if (!facade) return;
    setFinishing(true);
    setFinishError(null);
    try {
      await facade.finishSession(session.id, new Date());
      navigate(`/hifz/session/${encodeURIComponent(session.id)}`);
    } catch (cause) {
      setFinishError(cause);
    } finally {
      setFinishing(false);
    }
  }

  if (total === 0) {
    return (
      <div className="stack">
        <Panel title={tr('نشست حفظ', 'Hifz session')}>
          <div className="state state--empty">
            <h3>{tr('برنامهٔ امروز گامی ندارد', 'Today’s plan has no steps')}</h3>
            <p className="muted rtl-iso">
              {tr(
                'یا آیاتی در مجموعهٔ حفظ ندارید، یا هیچ مرور/آیهٔ تازه‌ای بدهکار نیست.',
                'Either the hifz set is empty or nothing is owed and no new ayah is queued.',
              )}
            </p>
            <LinkButton to="/hifz/items" className="btn btn--primary">{tr('افزودن آیات', 'Add ayat')}</LinkButton>
          </div>
        </Panel>
      </div>
    );
  }

  const completedCount = done.size;

  return (
    <div className="stack">
      <Panel
        title={
          <span dir="auto">
            {tr('گام', 'Step')} <span className="num">{Math.min(stepIndex + 1, total)}</span>/{' '}
            <span className="num">{total}</span> · <span className="ltr-iso mono">{session.id}</span>
          </span>
        }
        action={
          <div className="row">
            <Chip tone={completedCount === 0 ? 'neutral' : 'accent'}>
              {tr('ثبت‌شده', 'recorded')}: <span className="num">{completedCount}</span>
            </Chip>
            <Button variant="primary" busy={finishing} onClick={() => void finish()}>
              {tr('پایان نشست و گزارش', 'Finish & report')}
            </Button>
          </div>
        }
      >
        <Meter value={completedCount / total} label={`${Math.round((completedCount / total) * 100)}%`} />
        {finishError ? <p className="field__error mono" role="alert" dir="auto">{errorMessage(finishError)}</p> : null}
      </Panel>

      <div className="hifz-columns">
        <StepPanel
          key={`${session.id}:${stepIndex}`}
          session={session}
          stepIndex={stepIndex}
          probe={probe}
          onDone={() =>
            setDone((prev) => {
              const next = new Set(prev);
              next.add(stepIndex);
              return next;
            })
          }
          onNext={() => setStepIndex((i) => Math.min(i + 1, total - 1))}
          onSkip={() => setStepIndex((i) => Math.min(i + 1, total - 1))}
          isLast={stepIndex >= total - 1}
        />
        <Panel title={tr('گام‌های نشست', 'Session steps')}>
          <ol className="hifz-steps">
            {session.steps.map((s, i) => {
              const attempted = done.has(i) || s.attemptId !== null;
              return (
                <li
                  key={`${s.mode}-${s.verseKey ?? '-'}-${i}`}
                  className={`hifz-step ${i === stepIndex ? 'hifz-step--current' : ''} ${attempted ? 'hifz-step--done' : ''}`}
                >
                  <span className="hifz-step__mark" aria-hidden="true">{attempted ? '✓' : i + 1}</span>
                  <span className="rtl-iso">{modeLabel(tr, s.mode)}</span>
                  {s.verseKey ? <AyahLink verseKey={s.verseKey} /> : <span className="faint">{tr('بی‌آیه', 'no ayah')}</span>}
                  {s.completedAt ? <span className="faint ltr-iso mono">{s.completedAt.slice(11, 19)}</span> : null}
                </li>
              );
            })}
          </ol>
        </Panel>
      </div>
    </div>
  );
}

/** Load one step's probe through the facade; the engine is the only author. */
function useStepProbe(session: HifzSession, stepIndex: number): AsyncState<StepProbe> {
  const { tr } = useApp();
  const facade = useHifzFacade();
  return useAsync<StepProbe>(async () => {
    if (!facade) throw new Error(tr('ذخیره‌گاه باز نشده است', 'Storage is not open yet'));
    return facade.probeForStep(session, stepIndex, new Date());
  }, [facade, session.id, stepIndex, tr]);
}

function StepPanel({
  session,
  stepIndex,
  probe,
  onDone,
  onNext,
  onSkip,
  isLast,
}: {
  session: HifzSession;
  stepIndex: number;
  probe: AsyncState<StepProbe>;
  onDone: () => void;
  onNext: () => void;
  onSkip: () => void;
  isLast: boolean;
}) {
  const { tr, gateway } = useApp();
  const facade = useHifzFacade();
  const [text, setText] = useState('');
  const [usedAudio, setUsedAudio] = useState(false);
  const [confidence, setConfidence] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const startedAtRef = useRef<string>(new Date().toISOString());

  // The clock starts when the cue appears for this step — duration is what the
  // learner actually spent recalling, and it travels into the stored attempt.
  useEffect(() => {
    if (probe.status === 'ready') startedAtRef.current = new Date().toISOString();
  }, [probe.status, probe.value?.stepIndex]);

  const revealedKey = verdict ? session.steps[stepIndex]?.verseKey ?? null : null;
  const expected = useVerseWords(revealedKey);

  async function submit(): Promise<void> {
    if (!facade || !gateway) return;
    const p = probe.value;
    if (!p || !p.itemId || !p.verseKey) {
      setInputError(tr('این گام شناسهٔ مورد یا آیه ندارد؛ فقط می‌توان رد شد.', 'This step has no item/ayah id; it can only be skipped.'));
      return;
    }
    const produced = splitRecited(text);
    if (produced.length === 0) {
      setInputError(tr('ابتدا آیه را بخوانید؛ ورودی خالی ثبت نمی‌شود.', 'Recite first — an empty input is not recorded.'));
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setInputError(null);
    try {
      const attempt = await facade.submitRecall({
        itemId: p.itemId,
        verseKey: p.verseKey as VerseKey,
        mode: p.mode,
        sessionId: session.id,
        produced,
        cue: p.probe ? { kind: p.probe.cue.kind, text: p.probe.cue.text } : null,
        startedAt: startedAtRef.current,
        durationMs: Date.now() - Date.parse(startedAtRef.current),
        selfConfidence: confidence === '' ? null : Number(confidence),
        usedAudio,
        stepIndex,
      });
      // Read the evidence back from storage: the saved attempt row and the
      // engine-recomputed item with its new band.
      const [savedRows, items] = await Promise.all([
        gateway.recallAttempts(attempt.itemId, 1),
        gateway.hifzItems(),
      ]);
      setVerdict({
        attempt,
        saved: savedRows[0] ?? null,
        itemAfter: items.find((i) => i.id === attempt.itemId) ?? null,
      });
      onDone();
    } catch (cause) {
      setSubmitError(cause);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <StateBoundary
      state={probe}
      emptyTitle={tr('این گام کاوشی ندارد', 'This step has no probe')}
      emptyBody={probe.value ? probeReason(tr, probe.value.reason ?? '') : undefined}
      emptyAction={<Button onClick={onSkip}>{tr('رد شدن از این گام', 'Skip this step')}</Button>}
      isEmpty={(value) => value.probe === null}
      onRetry={() => probe.refresh()}
      skeleton={<div className="state state--loading">{tr('ساخت کاوش…', 'Building the probe…')}</div>}
    >
      {(p) => {
        const probeData = p.probe;
        if (!probeData) return null;
        const canSubmit = p.itemId !== null && p.verseKey !== null;
        return (
          <div className="stack">
            <Panel
              title={
                <span dir="auto">
                  {tr('گام', 'Step')} {stepIndex + 1} — <span className="rtl-iso">{modeLabel(tr, p.mode)}</span>
                </span>
              }
            >
              <div className="stack stack--tight">
                <p className="muted rtl-iso">{modeHelp(tr, p.mode)}</p>
                <div className="cue-box">
                  <div className="cue-box__kind rtl-iso">{cueLabel(tr, probeData.cue.kind)}</div>
                  {probeData.cue.kind === 'audio' ? (
                    <div className="rtl-iso muted">
                      {tr('بستهٔ صوتی', 'audio pack')}: <span className="mono ltr-iso">{probeData.cue.text ?? '—'}</span>
                      {' · '}
                      <label className="row stack--tight" style={{ display: 'inline-flex' }}>
                        <input type="checkbox" checked={usedAudio} onChange={(e) => setUsedAudio(e.target.checked)} />
                        {tr('صوت را شنیدم', 'I listened to the audio')}
                      </label>
                    </div>
                  ) : probeData.cue.text ? (
                    <div className="cue-box__text quran-text" dir="rtl">{probeData.cue.text}</div>
                  ) : (
                    <div className="muted rtl-iso">{tr('بدون نشانهٔ متنی', 'no text cue')}</div>
                  )}
                  {probeData.hiddenWordPosition !== null ? (
                    <div className="faint num rtl-iso">
                      {tr('جای خالی: واژهٔ', 'blank at word')} {probeData.hiddenWordPosition}
                    </div>
                  ) : null}
                  {probeData.nextVerseKey ? (
                    <div className="row stack--tight">
                      <span className="faint rtl-iso">{tr('ادامه به آیهٔ', 'continues into')}</span>
                      <AyahLink verseKey={probeData.nextVerseKey} />
                    </div>
                  ) : null}
                  <div className="row stack--tight">
                    <Chip tone="neutral">
                      {tr('واژه‌های انتظار (تعیین موتور)', 'expected words (engine-set)')}:{' '}
                      <span className="num">{probeData.expected.length}</span>
                    </Chip>
                    {p.verseKey ? <AyahLink verseKey={p.verseKey} label={`${tr('هدف', 'target')} · ${p.verseKey}`} /> : null}
                  </div>
                </div>
              </div>
            </Panel>

            {verdict === null ? (
              <Panel title={tr('خوانش', 'Recitation')}>
                <div className="stack stack--tight">
                  <label className="field__label rtl-iso" htmlFor={`recite-${stepIndex}`}>
                    {tr(
                      'آنچه از حفظ می‌خوانید — متن شما دست‌نخورده ذخیره می‌شود',
                      'Recite from memory — your text is stored verbatim',
                    )}
                  </label>
                  <textarea
                    id={`recite-${stepIndex}`}
                    className="textarea recite-input"
                    dir="rtl"
                    value={text}
                    onChange={(e) => {
                      setText(e.target.value);
                      setInputError(null);
                    }}
                    disabled={!canSubmit || submitting}
                    placeholder={canSubmit ? '…' : tr('این گام قابل ثبت نیست — رد شوید', 'this step cannot be recorded — skip it')}
                  />
                  {inputError ? <p className="field__error" role="alert">{inputError}</p> : null}
                  <div className="row">
                    <label className="row stack--tight" htmlFor={`conf-${stepIndex}`}>
                      <span className="muted rtl-iso">{tr('اطمینان خود (اختیاری)', 'self-confidence (optional)')}</span>
                      <select
                        id={`conf-${stepIndex}`}
                        className="select"
                        value={confidence}
                        onChange={(e) => setConfidence(e.target.value)}
                        disabled={!canSubmit}
                      >
                        <option value="">—</option>
                        {[1, 2, 3, 4, 5].map((n) => (
                          <option key={n} value={String(n)}>{n}</option>
                        ))}
                      </select>
                    </label>
                    <Button variant="primary" busy={submitting} disabled={!canSubmit} onClick={() => void submit()}>
                      {tr('ثبت و نمره توسط موتور', 'Submit for engine scoring')}
                    </Button>
                    <Button onClick={onSkip}>{tr('رد شدن', 'Skip')}</Button>
                  </div>
                  {submitError ? (
                    <div className="state state--error" role="alert">
                      <h3>{tr('ثبت نشد', 'Submission failed')}</h3>
                      <p className="muted mono" dir="auto">{errorMessage(submitError)}</p>
                    </div>
                  ) : null}
                </div>
              </Panel>
            ) : (
              <VerdictPanel verdict={verdict} expected={expected} probe={p} onNext={onNext} isLast={isLast} />
            )}
          </div>
        );
      }}
    </StateBoundary>
  );
}

function VerdictPanel({
  verdict,
  expected,
  probe,
  onNext,
  isLast,
}: {
  verdict: Verdict;
  expected: AsyncState<string[]>;
  probe: StepProbe;
  onNext: () => void;
  isLast: boolean;
}) {
  const { tr } = useApp();
  const { attempt, saved, itemAfter } = verdict;
  return (
    <Panel
      title={tr('داوری موتور', 'Engine verdict')}
      action={
        <div className="row">
          {!isLast ? (
            <Button variant="primary" onClick={onNext}>{tr('گام بعدی', 'Next step')}</Button>
          ) : (
            <Chip tone="info">{tr('به پایان گام‌ها رسیدید — نشست را تمام کنید', 'All steps reached — finish the session')}</Chip>
          )}
        </div>
      }
    >
      <div className="stack stack--tight">
        <div className="row">
          <Meter
            value={attempt.accuracy}
            tone={attempt.accuracy >= 0.9 ? 'accent' : attempt.accuracy >= 0.6 ? 'warn' : 'danger'}
            label={fmtPct(attempt.accuracy)}
          />
          <Chip tone="neutral">
            {tr('واژه‌های درست', 'words correct')}:{' '}
            <span className="num">{attempt.correctWordCount}</span>/<span className="num">{attempt.expectedWordCount}</span>
          </Chip>
          <Chip tone="neutral">
            {tr('زمان', 'time')}: <span className="num">{fmtDuration(tr, attempt.durationMs)}</span>
          </Chip>
          <Chip tone="neutral">{tr('حالت', 'mode')}: <span className="rtl-iso">{modeLabel(tr, attempt.mode)}</span></Chip>
          {itemAfter ? (
            <span className="row stack--tight">
              <span className="muted rtl-iso">{tr('باند اکنون', 'band now')}</span>
              <BandTag band={itemAfter.band} />
              <Chip tone="neutral">
                {tr('پایداری', 'stability')} <span className="num">{itemAfter.stability}</span>
              </Chip>
            </span>
          ) : null}
        </div>

        <ErrorChips errors={attempt.errors} />

        <StateBoundary
          state={expected}
          emptyTitle={tr('متن آیه در بسته‌های نصب‌شده نیست', 'The ayah text is not in the installed packs')}
          isEmpty={(v) => v.length === 0}
        >
          {(words) => (
            <div className="stack stack--tight">
              <div className="muted rtl-iso">{tr('آیهٔ هدف — پس از ثبت آشکار شد:', 'target ayah — revealed after submission:')}</div>
              <WordAlignment expected={words} attempt={attempt} />
              <div className="row" dir="auto">
                <span className="chip"><span className="word mark"> {tr('درست', 'correct')}</span></span>
                <span className="chip"><span className="word strike"> {tr('نادرست/جاافتاده', 'wrong/omitted')}</span></span>
                <span className="chip"><span className="word insert"> {tr('افزوده', 'inserted')}</span></span>
                <span className="faint rtl-iso">
                  {tr(
                    'این نشانه‌ها همان خطاهای ذخیره‌شدهٔ موتورند؛ برنامه چیزی دوباره نمره نمی‌دهد.',
                    'These marks are the engine’s own stored errors — the app never re-scores.',
                  )}
                </span>
              </div>
              {probe.verseKey ? (
                <AyahLink verseKey={probe.verseKey} label={`${tr('دیدن در مصحف', 'open in mushaf')} · ${probe.verseKey}`} />
              ) : null}
            </div>
          )}
        </StateBoundary>

        <div className="disclosure">
          <div className="row stack--tight" dir="auto">
            <span className="muted rtl-iso">{tr('ردیف بازیابی‌شده از پایگاه (recallAttempts):', 'row read back from storage (recallAttempts):')}</span>
            {saved ? (
              <span className="mono ltr-iso">
                {saved.id} · {fmtPct(saved.accuracy)} · {saved.mode} · {saved.completedAt ?? saved.startedAt}
              </span>
            ) : (
              <Chip tone="danger">{tr('تلاش از پایگاه خوانده نشد!', 'the attempt could not be read back!')}</Chip>
            )}
          </div>
        </div>
      </div>
    </Panel>
  );
}
