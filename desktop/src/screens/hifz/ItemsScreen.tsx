/**
 * /hifz/items — the memorisation set and its memory fingerprints.
 *
 * Add via `addHifzItem`, change status via `setHifzItemStatus`, delete via
 * `removeHifzItem` — only after `ConfirmBox` (the app's own confirm component,
 * shared with the Me area) has listed what is lost and the learner has ticked
 * it; there is no native dialog here. The "بافت حافظه" disclosure calls
 * `deriveSegmentation` (core derives it on demand — the facade deliberately does
 * not persist structure) and shows the stored `hifzSegments` / `anchorWords` /
 * `hifzTransitions` rows beside it, empty when none exist.
 */
import { useState } from 'react';
import type { AnchorWord, HifzItem, HifzItemStatus, HifzSegment, HifzTransition, RecallAttempt, VerseKey } from '@quran/core';
import type { SegmentationOutcome } from '../../engine/hifzEngine';
import { useApp } from '../../app/app-state';
import { StateBoundary, useAsync } from '../../ui/async';
import { Button, Chip, Field, LinkButton, Meter, NumRange, Panel } from '../../ui/primitives';
import { ConfirmBox } from '../me/shared';
import {
  AyahLink,
  BandTag,
  errorMessage,
  fmtDateTime,
  parseVerseKey,
  useHifzFacade,
} from './shared';

interface ItemsData {
  items: HifzItem[];
  attemptsByItem: Map<string, number>;
}

const STATUSES: readonly HifzItemStatus[] = ['active', 'paused', 'graduated', 'dropped'];

function statusLabel(tr: (fa: string, en: string) => string, status: string): string {
  switch (status) {
    case 'active': return tr('فعال', 'active');
    case 'paused': return tr('متوقف', 'paused');
    case 'graduated': return tr('تصفیه‌شده', 'graduated');
    case 'dropped': return tr('حذف‌شده از برنامه', 'dropped');
    default: return status;
  }
}

export function ItemsScreen() {
  const { tr, gateway } = useApp();
  const data = useAsync<ItemsData>(async () => {
    if (!gateway) throw new Error(tr('ذخیره‌گاه باز نشده است', 'Storage is not open yet'));
    const [items, attempts] = await Promise.all([gateway.hifzItems(), gateway.recallAttempts(undefined, 5000)]);
    const counts = new Map<string, number>();
    for (const a of attempts) counts.set(a.itemId, (counts.get(a.itemId) ?? 0) + 1);
    return { items, attemptsByItem: counts };
  }, [gateway, tr]);

  return (
    <div className="stack">
      <AddPanel onAdded={() => data.refresh()} />
      <StateBoundary
        state={data}
        emptyTitle={tr('مجموعهٔ حفظ خالی است', 'The memorisation set is empty')}
        emptyBody={tr(
          'با فرم بالا یک آیه یا بازهٔ سوره‌ای بیفزایید؛ موتور برایش پاره‌ها، لنگرها و گذارها را می‌سازد.',
          'Add an ayah or a surah range above; the engine derives its segments, anchors and transitions.',
        )}
        isEmpty={(value) => value.items.length === 0}
        onRetry={() => data.refresh()}
        skeleton={<div className="state state--loading">{tr('خواندن آیات…', 'Reading items…')}</div>}
      >
        {(value) => (
          <Panel title={tr('آیات حفظ', 'Hifz items')} action={<Chip tone="neutral"><span className="num">{value.items.length}</span></Chip>}>
            <ul className="list">
              {value.items.map((item) => (
                <ItemRow key={item.id} item={item} attemptCount={value.attemptsByItem.get(item.id) ?? 0} onChanged={() => data.refresh()} />
              ))}
            </ul>
          </Panel>
        )}
      </StateBoundary>
    </div>
  );
}

function AddPanel({ onAdded }: { onAdded: () => void }) {
  const { tr, gateway } = useApp();
  const [single, setSingle] = useState('');
  const [surah, setSurah] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function addSingle(): Promise<void> {
    if (!gateway) return;
    const parsed = parseVerseKey(single);
    if (!parsed) {
      setError(tr('قالب کلید آیه «سوره:آیه» است، مثلاً 67:29', 'Use the “surah:ayah” key format, e.g. 67:29'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const key = `${parsed.chapter}:${parsed.verse}` as VerseKey;
      const exists = await gateway.ayah(key);
      if (!exists) throw new Error(tr(`آیهٔ ${key} در محتوا نیست`, `Ayah ${key} is not in the installed content`));
      const live = (await gateway.hifzItems()).some((item) => item.verseKey === key && item.status !== 'dropped');
      await gateway.addHifzItem(key);
      setMessage(
        live
          ? tr(`آیهٔ ${key} از پیش در مجموعه بود`, `Ayah ${key} was already in the set`)
          : tr(`آیهٔ ${key} افزوده شد`, `Added ${key}`),
      );
      setSingle('');
      onAdded();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  async function addRange(): Promise<void> {
    if (!gateway) return;
    const chapter = Number(surah);
    const a = Number(from);
    const b = Number(to);
    if (!Number.isInteger(chapter) || chapter < 1 || chapter > 114 || !Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a) {
      setError(tr('بازه نامعتبر است — سورهٔ ۱ تا ۱۱۴ و «از» کوچک‌تر یا مساوی «تا»', 'Invalid range — surah 1..114, from ≤ to'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const ayahs = await gateway.ayahsByChapter(chapter);
      if (b > ayahs.length) {
        throw new Error(tr(`سورهٔ ${chapter} تنها ${ayahs.length} آیه دارد`, `Surah ${chapter} has only ${ayahs.length} ayat`));
      }
      // Enrolment is idempotent, so the count the screen reports must be the
      // number that actually entered the plan — not the width of the range.
      const already = new Set((await gateway.hifzItems()).map((item) => item.verseKey));
      let added = 0;
      for (let v = a; v <= b; v += 1) {
        const key = `${chapter}:${v}` as VerseKey;
        await gateway.addHifzItem(key);
        if (!already.has(key)) added += 1;
      }
      const skipped = b - a + 1 - added;
      setMessage(
        skipped === 0
          ? tr(`${added} آیه افزوده شد`, `Added ${added} ayat`)
          : tr(
              `${added} آیه افزوده شد؛ ${skipped} تای دیگر از پیش در مجموعه بودند`,
              `Added ${added} ayat; ${skipped} were already in the set`,
            ),
      );
      setSurah(''); setFrom(''); setTo('');
      onAdded();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title={tr('افزودن به مجموعهٔ حفظ', 'Add to the hifz set')}>
      <div className="hifz-columns">
        <Field label={tr('کلید آیه', 'Verse key')} hint={tr('نمونه: 78:20', 'Example: 78:20')}>
          <div className="row">
            <input
              className="input mono"
              dir="ltr"
              value={single}
              onChange={(e) => { setSingle(e.target.value); setError(null); }}
              placeholder="67:29"
              aria-label={tr('کلید آیه', 'Verse key')}
            />
            <Button variant="primary" busy={busy} disabled={single.trim() === ''} onClick={() => void addSingle()}>
              {tr('افزودن', 'Add')}
            </Button>
          </div>
        </Field>
        <Field label={tr('بازهٔ سوره‌ای', 'Surah range')} hint={tr('هر آیه به‌عنوان یک مورد جدا افزوده می‌شود', 'each ayah joins as its own item')}>
          <div className="row">
            <input className="input num" dir="ltr" style={{ width: '5.5em' }} value={surah} onChange={(e) => setSurah(e.target.value)} placeholder={tr('سوره', 'surah')} aria-label={tr('شمارهٔ سوره', 'Surah number')} />
            <input className="input num" dir="ltr" style={{ width: '5em' }} value={from} onChange={(e) => setFrom(e.target.value)} placeholder={tr('از', 'from')} aria-label={tr('از آیه', 'From ayah')} />
            <input className="input num" dir="ltr" style={{ width: '5em' }} value={to} onChange={(e) => setTo(e.target.value)} placeholder={tr('تا', 'to')} aria-label={tr('تا آیه', 'To ayah')} />
            <Button busy={busy} disabled={surah === '' || from === '' || to === ''} onClick={() => void addRange()}>
              {tr('افزودن بازه', 'Add range')}
            </Button>
          </div>
        </Field>
      </div>
      {message ? <p className="muted rtl-iso" role="status">{message}</p> : null}
      {error !== null && typeof error === 'string' ? <p className="field__error" role="alert">{error}</p> : null}
      {error !== null && error instanceof Error ? <p className="field__error mono" role="alert" dir="auto">{errorMessage(error)}</p> : null}
    </Panel>
  );
}

function ItemRow({ item, attemptCount, onChanged }: { item: HifzItem; attemptCount: number; onChanged: () => void }) {
  const { tr, gateway } = useApp();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function changeStatus(next: HifzItemStatus): Promise<void> {
    if (!gateway) return;
    setBusy(true);
    setError(null);
    try {
      await gateway.setHifzItemStatus(item.id, next);
      onChanged();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (!gateway) return;
    setBusy(true);
    setError(null);
    try {
      await gateway.removeHifzItem(item.id);
      setConfirming(false);
      onChanged();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="item-row-wrap">
      <div className="item-row">
        <span className="item-row__grow">
          <AyahLink verseKey={item.verseKey} />
          {item.sequence.length > 1 ? (
            <Chip tone="info" title={item.sequence.join(' → ')}>
              {tr('توالی', 'sequence')} × <span className="num">{item.sequence.length}</span>
            </Chip>
          ) : null}
        </span>
        <BandTag band={item.band} />
        <Meter value={item.stability} label={`${tr('پایداری', 'stability')} ${item.stability}`} tone={item.stability >= 0.7 ? 'accent' : 'warn'} />
        <span className="faint num">{attemptCount} {tr('تلاش', 'attempts')}</span>
        <span className="faint ltr-iso mono">{tr('آخرین', 'last')}: {fmtDateTime(item.lastReviewedAt)}</span>
        <span className="faint ltr-iso mono">{tr('مرور', 'next')}: {fmtDateTime(item.nextReviewAt)}</span>
        <label className="row stack--tight">
          <span className="faint rtl-iso">{tr('وضعیت', 'status')}</span>
          <select
            className="select"
            value={item.status}
            disabled={busy}
            onChange={(e) => void changeStatus(e.target.value as HifzItemStatus)}
            aria-label={tr(`وضعیت ${item.verseKey}`, `status of ${item.verseKey}`)}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>{statusLabel(tr, s)}</option>
            ))}
          </select>
        </label>
        <Button
          busy={busy}
          variant="danger"
          aria-expanded={confirming}
          onClick={() => setConfirming((c) => !c)}
        >
          {tr('حذف', 'Remove')}
        </Button>
        <Button onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {tr('بافت حافظه', 'Memory fingerprint')}
        </Button>
      </div>
      {error ? <p className="field__error" role="alert" dir="auto">{error instanceof Error ? error.message : String(error)}</p> : null}
      {/* The warning names the stored rows that go with this item — a native
          confirm cannot carry that, and it is not themed or RTL either. */}
      {confirming ? (
        <ConfirmBox
          title={tr(`حذف آیهٔ ${item.verseKey} از مجموعهٔ حفظ`, `Remove ${item.verseKey} from the hifz set`)}
          consequences={[
            tr(
              `${attemptCount} تلاشِ مرورِ ذخیره‌شدهٔ این مورد پاک می‌شود`,
              `${attemptCount} stored recall attempts for this item are deleted`,
            ),
            tr('باندها و زمان‌بندی مرور آن بازنویسی می‌شوند', 'its band and review schedule are rewritten'),
            tr('متن آیات و بسته‌های محتوا دست‌نخورده می‌مانند', 'the ayah text and the content packs are untouched'),
          ]}
          confirmLabel={tr('حذف این مورد', 'Remove this item')}
          busy={busy}
          onConfirm={() => void remove()}
        />
      ) : null}
      {open ? <Fingerprint itemId={item.id} /> : null}
    </li>
  );
}

interface FingerprintData {
  derived: SegmentationOutcome | null;
  storedSegments: HifzSegment[];
  storedAnchors: AnchorWord[];
  storedTransitions: HifzTransition[];
}

function Fingerprint({ itemId }: { itemId: string }) {
  const { tr, gateway } = useApp();
  const facade = useHifzFacade();
  const fp = useAsync<FingerprintData>(async () => {
    if (!facade || !gateway) throw new Error(tr('ذخیره‌گاه باز نشده است', 'Storage is not open yet'));
    const [derived, storedSegments, storedAnchors, storedTransitions] = await Promise.all([
      facade.deriveSegmentation(itemId, new Date()),
      gateway.hifzSegments(itemId),
      gateway.anchorWords(itemId),
      gateway.hifzTransitions(itemId),
    ]);
    return { derived, storedSegments, storedAnchors, storedTransitions };
  }, [facade, gateway, itemId, tr]);

  return (
    <StateBoundary
      state={fp}
      emptyTitle={tr('بافتی برای این مورد ساخته نشد', 'No fingerprint could be built for this item')}
      emptyBody={tr(
        'موتور بدون متن آیه ساختار نمی‌سازد؛ پیش‌تر یک بستهٔ متنی وارد کرده‌اید؟',
        'The engine derives nothing without the ayah text — have you imported a content pack?',
      )}
      emptyAction={<LinkButton to="/me/content">{tr('وضعیت داده', 'Data health')}</LinkButton>}
      isEmpty={(value) => value.derived === null && value.storedSegments.length === 0 && value.storedAnchors.length === 0 && value.storedTransitions.length === 0}
      onRetry={() => fp.refresh()}
      skeleton={<div className="state state--loading">{tr('موتور در حال ساخت پاره‌ها و لنگرهاست…', 'Deriving segments and anchors…')}</div>}
    >
      {(value) => (
        <div className="stack" style={{ padding: 'var(--sp-2) var(--sp-4)' }}>
          {value.derived && value.derived.notes.length > 0 ? (
            <p className="faint rtl-iso">{value.derived.notes.map((n, i) => <span key={i} className="ltr-iso">{n} </span>)}</p>
          ) : null}
          <div className="hifz-columns">
            <Panel title={tr('پاره‌ها (ساختهٔ موتور)', 'Segments (engine-derived)')}>
              {value.derived === null || value.derived.segments.length === 0 ? (
                <p className="muted">{tr('پاره‌ای ساخته نشد.', 'No segments were derived.')}</p>
              ) : (
                <ul className="list">
                  {value.derived.segments.map((s) => (
                    <li key={s.id}>
                      <span className="num faint">{s.position + 1}.</span>{' '}
                      <span className="quran-text" dir="rtl">{s.text}</span>{' '}
                      <Chip tone="neutral">{tr('واژه', 'words')} <NumRange className="num" from={s.fromWord} to={s.toWord} /></Chip>
                      {s.meaning ? (
                        <>
                          {' '}
                          {/* the gloss is only shown with the pack it came from: an
                              unattributed meaning of revealed text is not usable */}
                          <span className="muted" dir={s.meaning.lang === 'en' ? 'ltr' : 'rtl'}>
                            {s.meaning.text}
                          </span>{' '}
                          <Chip tone="neutral">{s.meaning.packId}</Chip>
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title={tr('لنگرها', 'Anchors')}>
              {value.derived === null || value.derived.anchors.length === 0 ? (
                <p className="muted">{tr('لنگری ساخته نشد.', 'No anchors were derived.')}</p>
              ) : (
                <ul className="list">
                  {value.derived.anchors.map((a) => (
                    <li key={a.id}>
                      <Chip tone={a.role === 'opening' ? 'info' : a.role === 'ending' ? 'accent' : 'neutral'}>
                        {a.role === 'opening'
                          ? tr('آغاز', 'opening')
                          : a.role === 'ending'
                            ? tr('پایان', 'ending')
                            : a.role === 'boundary'
                              ? tr('مرز', 'boundary')
                              : tr('میانه', 'middle')}
                      </Chip>{' '}
                      <span className="quran-text" dir="rtl">{a.text}</span>{' '}
                      <span className="faint num">{tr('واژه', 'word')} {a.wordPosition}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title={tr('گذارها', 'Transitions')}>
              {value.derived === null || value.derived.transitions.length === 0 ? (
                <p className="muted">{tr('گذاری ساخته نشد.', 'No transitions were derived.')}</p>
              ) : (
                <ul className="list">
                  {value.derived.transitions.map((t) => (
                    <li key={t.id}>
                      <Chip tone="neutral">{t.kind === 'intra' ? tr('درون‌آیه‌ای', 'intra-ayah') : tr('میان‌آیه‌ای', 'inter-ayah')}</Chip>{' '}
                      <span className="num">{tr('واژهٔ', 'word')} {t.toWord}</span>
                      {t.toVerseKey ? <> → <AyahLink verseKey={t.toVerseKey} /></> : null}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <details className="disclosure">
            <summary>
              {tr(
                `ردیف‌های ذخیره‌شده: ${value.storedSegments.length} پاره، ${value.storedAnchors.length} لنگر، ${value.storedTransitions.length} گذار`,
                `stored rows: ${value.storedSegments.length} segments, ${value.storedAnchors.length} anchors, ${value.storedTransitions.length} transitions`,
              )}
            </summary>
            {value.storedSegments.length + value.storedAnchors.length + value.storedTransitions.length === 0 ? (
              <p className="muted rtl-iso" style={{ marginTop: 'var(--sp-2)' }}>
                {tr(
                  'هیچ ردیف ساختاری در پایگاه نیست؛ موتور ساختار را هنگام نیاز می‌سازد و پایداریِ پاره‌ها را از همان ردیف‌های تلاش محاسبه می‌کند.',
                  'No structure rows are in the database; the engine derives structure on demand and estimates segment factors from the stored attempt rows.',
                )}
              </p>
            ) : (
              <ul className="list mono">
                {/* Each line leads with its ayah: `position`, `word_position` and
                    `to_word` all restart per ayah, so a bare number cannot say
                    which of the item's ayat the row belongs to. */}
                {value.storedSegments.map((s) => (
                  <li key={s.id}>{s.verseKey} · segment {s.position}: <NumRange from={s.fromWord} to={s.toWord} /> · {tr('پایداری', 'stability')} {s.stability} · {s.text}</li>
                ))}
                {value.storedAnchors.map((a) => (
                  <li key={a.id}>{a.verseKey} · anchor w{a.wordPosition} ({a.role}) · {tr('پایداری', 'stability')} {a.stability} · {a.text}</li>
                ))}
                {value.storedTransitions.map((t) => (
                  <li key={t.id}>{t.verseKey} · transition {t.kind} → {t.toWord}{t.toVerseKey ? ` (${t.toVerseKey})` : ''} · ✓{t.successCount} ✗{t.failureCount} · {t.lastPracticedAt ?? '—'}</li>
                ))}
              </ul>
            )}
          </details>

          <div className="row">
            {/* `?item=` is read by `/hifz/session` (RouteProps.query): the runner
                starts today’s engine-built session and opens it on this item’s
                step, saying so when the plan holds no step for it. */}
            <LinkButton to={`/hifz/session?item=${encodeURIComponent(itemId)}`} className="btn">
              {tr('تمرین در نشست', 'Drill in a session')}
            </LinkButton>
            <span className="faint rtl-iso">
              {tr('گام‌های نشست را خودِ موتور از برنامهٔ امروز می‌سازد.', 'Session steps are built by the engine from today’s plan.')}
            </span>
          </div>
        </div>
      )}
    </StateBoundary>
  );
}
