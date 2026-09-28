/**
 * Shared helpers for the hifz screens.
 *
 * Rules these helpers encode (AGENTS.md): the UI renders what the engine and
 * the gateway return. Labels here are translations of contract values
 * (`RecallMode`, `ErrorKind`, `StabilityBand`, probe cue kinds), never new
 * judgements. Aggregations (counts, medians, sparkline points) are computations
 * over stored rows — accuracy, stability and priority are never recomputed.
 */
import { useMemo } from 'react';
import type { DetectedError, ErrorKind, RecitedWord, RecallAttempt, RecallMode, VerseKey } from '@quran/core';
import type { Tr } from '../../app/app-state';
import { useApp } from '../../app/app-state';
import { BandChip, LinkButton } from '../../ui/primitives';
import { useAsync } from '../../ui/async';
import { createHifzFacade, type HifzFacade } from '../../engine/hifzFacade';
import './hifz.css';

/** The facade bound to the open gateway; null until storage is up. */
export function useHifzFacade(): HifzFacade | null {
  const { gateway } = useApp();
  return useMemo(() => (gateway === null ? null : createHifzFacade(gateway)), [gateway]);
}

/** The same error text `StateBoundary` would show, for inline use. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

/* ------------------------------------------------------------------ labels */

const BANDS: Record<string, { fa: string; en: string }> = {
  new: { fa: 'نو', en: 'new' },
  unstable: { fa: 'ناپایدار', en: 'unstable' },
  weak: { fa: 'ضعیف', en: 'weak' },
  stable: { fa: 'پایدار', en: 'stable' },
  mastered: { fa: 'استوار', en: 'mastered' },
};

export function bandLabel(tr: Tr, band: string): string {
  const b = BANDS[band];
  return b ? tr(b.fa, b.en) : band;
}

/** Band chip whose label comes from the contract value — one source of names. */
export function BandTag({ band }: { band: string }) {
  const { tr } = useApp();
  return <BandChip band={band} label={bandLabel(tr, band)} />;
}

const MODES: Record<RecallMode, { fa: string; en: string; helpFa: string; helpEn: string }> = {
  segment: {
    fa: 'پاره‌خوانی', en: 'Segment recall',
    helpFa: 'یک پارهٔ معنایی از آیه را بخوانید.', helpEn: 'Recite one semantic segment of the ayah.',
  },
  opening: {
    fa: 'آغاز آیه', en: 'Opening third',
    helpFa: 'یک‌سوم نخست آیه را بخوانید.', helpEn: 'Recite the first third of the ayah.',
  },
  middle: {
    fa: 'میانهٔ آیه', en: 'Middle third',
    helpFa: 'با نشانهٔ واژه‌های پیش از میانه، یک‌سوم میانی را بخوانید.', helpEn: 'Cued by the words before it; recite the middle third.',
  },
  ending: {
    fa: 'پایان آیه', en: 'Ending third',
    helpFa: 'یک‌سوم پایانی آیه را بخوانید.', helpEn: 'Recite the last third of the ayah.',
  },
  transition: {
    fa: 'گذار', en: 'Transition',
    helpFa: 'از پایان بخش A به ادامهٔ B بروید (درون‌آیه‌ای یا میان‌آیه‌ای).', helpEn: 'Continue across a boundary — within an ayah or into the next one.',
  },
  'continue-ayah': {
    fa: 'ادامهٔ آیه', en: 'Continue the ayah',
    helpFa: 'آیه از جایی می‌ایستد؛ ادامه را بخوانید.', helpEn: 'The ayah stops partway; produce the rest from the prefix.',
  },
  'continue-sequence': {
    fa: 'ادامهٔ توالی', en: 'Continue the sequence',
    helpFa: 'پایان آیهٔ پیش، آغاز آیهٔ بعد را می‌خواند.', helpEn: 'The ending of the previous ayah cues the opening of the next.',
  },
  'missing-word': {
    fa: 'جای خالی واژه', en: 'Missing word',
    helpFa: 'یک واژه از آیه پوشیده شده؛ همان را بگویید.', helpEn: 'One word of the ayah is blanked; say exactly that word.',
  },
  'first-word-cue': {
    fa: 'نشانهٔ واژهٔ نخست', en: 'First-word cue',
    helpFa: 'پس از واژهٔ نخست، ادامهٔ آیه را بخوانید.', helpEn: 'Continue after the opening word of the ayah.',
  },
  'last-word-cue': {
    fa: 'واژهٔ پایانی', en: 'Last-word cue',
    helpFa: 'آیه‌ای را بخوانید که با این واژه تمام می‌شود.', helpEn: 'Recite the ayah that ends with this word.',
  },
  reverse: {
    fa: 'خوانش معکوس', en: 'Reverse recall',
    helpFa: 'آیه را واژه‌به‌واژه از آخر به اول بخوانید.', helpEn: 'Recite the ayah word by word, ending first.',
  },
  random: {
    fa: 'بازهٔ تصادفیِ seed', en: 'Seeded random span',
    helpFa: 'یک بازهٔ پی‌درپی از آیه — با seedِ نشست، قابل تکرار.', helpEn: 'A contiguous span, fully determined by the session seed.',
  },
  'audio-recall': {
    fa: 'یادآوری با صوت', en: 'Audio recall',
    helpFa: 'یک‌بار گوش دهید، سپس بدون صوت بخوانید.', helpEn: 'Listen once, then recite without the audio.',
  },
  'full-ayah': {
    fa: 'آیهٔ کامل', en: 'Full ayah',
    helpFa: 'تمام آیه را از حفظ بخوانید.', helpEn: 'Recite the whole ayah from memory.',
  },
  'full-sequence': {
    fa: 'توالی کامل', en: 'Full sequence',
    helpFa: 'همهٔ آیاتِ توالی را پی‌درهم بخوانید.', helpEn: 'Recite the whole bound sequence without stopping.',
  },
};

export function modeLabel(tr: Tr, mode: string): string {
  const m = MODES[mode as RecallMode];
  return m ? tr(m.fa, m.en) : mode;
}

export function modeHelp(tr: Tr, mode: string): string {
  const m = MODES[mode as RecallMode];
  return m ? tr(m.helpFa, m.helpEn) : '';
}

const ERROR_KINDS: Record<ErrorKind, { fa: string; en: string }> = {
  correct: { fa: 'درست', en: 'correct' },
  omission: { fa: 'جاافتادن', en: 'omission' },
  substitution: { fa: 'جایگزینی', en: 'substitution' },
  repetition: { fa: 'تکرار', en: 'repetition' },
  'wrong-order': { fa: 'ترتیب نادرست', en: 'wrong order' },
  'wrong-transition': { fa: 'گذار نادرست', en: 'wrong transition' },
  'similar-ayah-confusion': { fa: 'اشتباه با آیهٔ مشابه', en: 'similar-ayah confusion' },
  'beginning-failure': { fa: 'خطا در آغاز', en: 'beginning failure' },
  'middle-failure': { fa: 'خطا در میانه', en: 'middle failure' },
  'ending-failure': { fa: 'خطا در پایان', en: 'ending failure' },
};

export function errorKindLabel(tr: Tr, kind: string): string {
  const e = ERROR_KINDS[kind as ErrorKind];
  return e ? tr(e.fa, e.en) : kind;
}

const CUES: Record<string, { fa: string; en: string }> = {
  'segment-previous-words': { fa: 'واژه‌های پیش از پاره', en: 'words before the segment' },
  'opening-prompt': { fa: 'بدون نشانه — آغاز آیه', en: 'no cue — the opening' },
  'middle-previous-words': { fa: 'واژه‌های پیش از میانه', en: 'words before the middle' },
  'ending-prompt': { fa: 'بدون نشانه — پایان آیه', en: 'no cue — the ending' },
  'transition-intra': { fa: 'واژه‌های پیش از مرز درون‌آیه‌ای', en: 'words before the intra-ayah boundary' },
  'transition-inter': { fa: 'پایان آیهٔ پیش', en: 'end of the previous ayah' },
  'missing-word': { fa: 'آیه با یک جای خالی', en: 'the ayah with one blank' },
  'first-word': { fa: 'واژهٔ نخست آیه', en: 'the ayah’s first word' },
  'last-word': { fa: 'واژهٔ پایانی آیه', en: 'the ayah’s last word' },
  'ayah-prefix': { fa: 'آغازِ خوانده‌شدهٔ آیه', en: 'the recited prefix of the ayah' },
  'previous-ayah-ending': { fa: 'پایان آیهٔ پیش', en: 'ending of the previous ayah' },
  reverse: { fa: 'واژهٔ پایانی (شروع معکوس)', en: 'the last word (reverse start)' },
  'random-span-start-word': { fa: 'واژهٔ نخستِ بازهٔ هدف', en: 'first word of the target span' },
  audio: { fa: 'پخش صوت (بستهٔ صوتی نصب‌شده)', en: 'audio cue (installed audio pack)' },
  'free-recall': { fa: 'بدون نشانه — یادآوری آزاد', en: 'no cue — free recall' },
  sequence: { fa: 'توالی آیات', en: 'the ayah sequence' },
};

/** Persian label for a probe cue kind; unknown kinds surface verbatim, never dropped. */
export function cueLabel(tr: Tr, kind: string): string {
  const c = CUES[kind];
  return c ? tr(c.fa, c.en) : kind;
}

const REASONS: Record<string, { fa: string; en: string }> = {
  'no-step-ayah': { fa: 'این گام به آیه‌ای پیوند نشده است.', en: 'This step is not bound to an ayah.' },
  'ayah-text-not-installed': {
    fa: 'متن این آیه در بسته‌های محتوا نیست؛ پیش از نشست محتوا را وارد کنید.',
    en: 'The ayah text is not in the installed packs; import content before the session.',
  },
  'item-has-no-segments': {
    fa: 'این مورد هنوز پاره‌بندی ندارد؛ از بخش آیات حفظ بسازید.',
    en: 'This item has no segments yet; build the fingerprint from the hifz items page.',
  },
  'no-next-ayah': { fa: 'آیهٔ بعدی برای این گام در داده نیست.', en: 'No next ayah exists in the data for this step.' },
  'no-such-step': { fa: 'چنین گامی در این نشست نیست.', en: 'No such step exists in this session.' },
};

export function probeReason(tr: Tr, reason: string): string {
  const r = REASONS[reason];
  if (r) return tr(r.fa, r.en);
  if (reason.startsWith('probe-builder-threw:')) {
    return tr(`سازندهٔ کاوش خطا داد: ${reason.slice('probe-builder-threw:'.length)}`, `Probe builder threw: ${reason.slice('probe-builder-threw:'.length)}`);
  }
  return reason;
}

/**
 * The review plan's `reason` is the engine's own evidence: up to three factor
 * summaries joined with "; ". The numbers in it are the engine's and stay
 * untouched — only the wording around them is translated, so a Persian reader
 * sees a Persian sentence and an English one is never presented as UI copy.
 *
 * Patterns are matched against `factorSummaries()` in core/src/hifz/review.ts.
 * An unrecognised fragment is returned verbatim rather than dropped: losing the
 * engine's evidence would be worse than showing it in English.
 */
const REVIEW_REASON_SHAPES: { re: RegExp; fa: (m: RegExpMatchArray) => string; en: (m: RegExpMatchArray) => string }[] = [
  { re: /^(\d+) wrong word\(s\) in (\d+) attempt\(s\)$/, fa: (m) => `${m[1]} واژهٔ غلط در ${m[2]} تلاش`, en: (m) => m[0] },
  { re: /^no segment data — ([\d.]+) estimated from item stability$/, fa: (m) => `دادهٔ پاره‌ای نیست — ${m[1]} از پایداری آیه برآورد شد`, en: (m) => m[0] },
  { re: /^(\d+)\/(\d+) segment\(s\) below ([\d.]+)$/, fa: (m) => `${m[1]} از ${m[2]} پاره زیر ${m[3]}`, en: (m) => m[0] },
  { re: /^no transition data — ([\d.]+) estimated from item stability$/, fa: (m) => `دادهٔ گذاری نیست — ${m[1]} از پایداری آیه برآورد شد`, en: (m) => m[0] },
  { re: /^(\d+)\/(\d+) transition\(s\) below ([\d.]+)$/, fa: (m) => `${m[1]} از ${m[2]} گذار زیر ${m[3]}`, en: (m) => m[0] },
  { re: /^never scheduled$/, fa: () => 'هرگز زمان‌بندی نشده', en: (m) => m[0] },
  { re: /^overdue by (\d+)d$/, fa: (m) => `${m[1]} روز از سررسید گذشته`, en: (m) => m[0] },
  { re: /^not due yet$/, fa: () => 'هنوز سررسید نشده', en: (m) => m[0] },
  { re: /^(\d+)d since last success$/, fa: (m) => `${m[1]} روز از آخرین بازیافت موفق`, en: (m) => m[0] },
  { re: /^no successful recall yet$/, fa: () => 'هنوز بازیافت موفقی ثبت نشده', en: (m) => m[0] },
  { re: /^repetition debt (\d+)$/, fa: (m) => `بدهی تکرار ${m[1]}`, en: (m) => m[0] },
  { re: /^(\d+) cross-ayah error\(s\)$/, fa: (m) => `${m[1]} خطای میان‌آیه‌ای`, en: (m) => m[0] },
  { re: /^confusion group (.+)$/, fa: (m) => `گروه اشتباهی ${m[1]}`, en: (m) => m[0] },
  { re: /^ungrouped$/, fa: () => 'بدون گروه اشتباهی', en: (m) => m[0] },
  { re: /^band=(.+)$/, fa: (m) => `باند ${m[1]}`, en: (m) => m[0] },
  { re: /^no urgency signals$/, fa: () => 'نشانهٔ فوریتی نیست', en: (m) => m[0] },
];

const REVIEW_FACTORS: Record<string, { fa: string; en: string }> = {
  'historical-errors': { fa: 'خطاهای واژه‌ای پیشین', en: 'historical errors' },
  'weak-segments': { fa: 'پاره‌های ضعیف', en: 'weak segments' },
  'weak-transitions': { fa: 'گذارهای ضعیف', en: 'weak transitions' },
  overdue: { fa: 'گذشته از سررسید', en: 'overdue' },
  'recency-of-success': { fa: 'تازگی موفقیت', en: 'recency of success' },
  repetition: { fa: 'بدهی تکرار', en: 'repetition' },
  'confusion-rate': { fa: 'نرخ اشتباهی', en: 'confusion rate' },
  'group-membership': { fa: 'عضویت در گروه', en: 'group membership' },
  band: { fa: 'باند', en: 'band' },
};

export function reviewReason(tr: Tr, reason: string): string {
  return reason
    .split('; ')
    .map((part) => {
      for (const shape of REVIEW_REASON_SHAPES) {
        const m = part.match(shape.re);
        if (m) return tr(shape.fa(m), shape.en(m));
      }
      return part;
    })
    .join(tr('؛ ', '; '));
}

/** Persian label for one scheduler factor; an unknown key surfaces verbatim. */
export function reviewFactorLabel(tr: Tr, key: string): string {
  const f = REVIEW_FACTORS[key];
  return f ? tr(f.fa, f.en) : key;
}

/* --------------------------------------------------------------- formatting */

/** Exact duration of stored milliseconds — never rounded into a lie. */
export function fmtDuration(tr: Tr, ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} ${tr('ثانیه', 's')}`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} ${tr('دقیقه', 'min')} ${seconds} ${tr('ثانیه', 's')}`;
}

/** Engine scores (already rounded by core) shown with one decimal. */
export function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}٪`;
}

export function fmtDateTime(iso: string | null): string {
  return iso ? iso.slice(0, 16).replace('T', ' ') : '—';
}

export function fmtDate(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : '—';
}

/** Whole days between a stored ISO timestamp and now; null when there is no row. */
export function daysSince(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return Math.floor((nowMs - at) / 86_400_000);
}

/* ------------------------------------------------------------------ inputs */

/**
 * Split a recitation into `RecitedWord`s WITHOUT touching the text: split on
 * whitespace only, positions in the learner's own order (AGENTS.md: the
 * recitation is preserved verbatim, never normalised or re-flowed).
 */
export function splitRecited(text: string): RecitedWord[] {
  return text
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((text2, i) => ({ position: i + 1, text: text2 }));
}

const VERSE_KEY_RE = /^(\d{1,3}):(\d{1,4})$/;

export function parseVerseKey(input: string): { chapter: number; verse: number } | null {
  const m = VERSE_KEY_RE.exec(input.trim());
  if (!m) return null;
  const chapter = Number(m[1]);
  const verse = Number(m[2]);
  if (!Number.isFinite(chapter) || !Number.isFinite(verse)) return null;
  if (chapter < 1 || chapter > 114 || verse < 1) return null;
  return { chapter, verse };
}

/* ------------------------------------------------------------------ pieces */

/** Verse key linking to the real ayah page. Colon is percent-encoded as elsewhere. */
export function AyahLink({ verseKey, label }: { verseKey: string; label?: string }) {
  return (
    <LinkButton to={`/quran/ayah/${encodeURIComponent(verseKey)}`} className="mono ayah-link">
      {label ?? verseKey}
    </LinkButton>
  );
}

/**
 * Expected word list of an ayah exactly as the engine's classifier sees it
 * (word rows when installed, otherwise whitespace tokens of the Uthmani text).
 * Pass null to keep the target hidden — the query answers instantly with [].
 */
export function useVerseWords(verseKey: string | null) {
  const { gateway, tr } = useApp();
  return useAsync<string[]>(async () => {
    if (!verseKey || !gateway) return [];
    // Stored keys already are `chapter:verse`; the gateway asks for the branded
    // type, and the two checks below keep a malformed hand-typed key out.
    if (!parseVerseKey(verseKey)) throw new Error(tr('کلید آیه نامعتبر است', 'Invalid verse key'));
    const key = verseKey as VerseKey;
    const rows = await gateway.words(key);
    if (rows.length > 0) return rows.filter((w) => !w.isEndOfAyahMark).map((w) => w.textUthmani);
    const ayah = await gateway.ayah(key);
    if (!ayah) throw new Error(tr('آیه‌ای با این کلید نیست', 'No ayah exists with this key'));
    return ayah.textUthmani.split(/\s+/).filter((t) => t.length > 0);
  }, [verseKey, gateway, tr]);
}

/**
 * Word-level view of one stored attempt over the expected words. Marking is
 * pure presentation: every class comes from `attempt.errors` as saved by the
 * engine; nothing is re-scored.
 */
export function WordAlignment({ expected, attempt }: { expected: string[]; attempt: RecallAttempt }) {
  const { tr } = useApp();
  const byPos = new Map<number, DetectedError[]>();
  for (const error of attempt.errors) {
    const list = byPos.get(error.expectedPosition);
    if (list) list.push(error);
    else byPos.set(error.expectedPosition, [error]);
  }
  // `insertion` is produced by the classifier as a word event even though the
  // contract union names the ten families above; show it verbatim when present.
  const insertions = attempt.errors.filter((e) => String(e.kind) === 'insertion' || (e.actual !== null && e.expected === null));
  return (
    <div className="alignment quran-text" dir="rtl">
      {expected.map((word, index) => {
        const pos = index + 1;
        const errs = byPos.get(pos);
        const cls = errs ? errsClass(errs) : '';
        return (
          <span key={pos} className={`word ${cls}`} title={errs ? errs.map((e) => e.explanation || errorKindLabel(tr, e.kind)).join(' — ') : undefined}>
            {word}
          </span>
        );
      })}
      {insertions.length > 0 ? (
        <span className="alignment__inserts" dir="rtl">
          <span className="muted" dir="auto">{tr('+ افزوده‌شده:', ' + inserted:')}</span>{' '}
          {insertions.map((e, i) => (
            <span key={`${e.expectedPosition}-${i}`} className="word insert" title={e.explanation}>
              {e.actual ?? '؟'}
            </span>
          ))}
        </span>
      ) : null}
    </div>
  );
}

function errsClass(errs: DetectedError[]): string {
  for (const e of errs) {
    if (e.kind === 'omission') return 'strike';
    if (e.kind === 'substitution' || e.kind === 'wrong-order' || e.kind === 'repetition') return 'strike';
    if (e.kind === 'similar-ayah-confusion' || e.kind === 'wrong-transition') return 'strike';
    if (String(e.kind) === 'correct') return 'mark';
  }
  return 'mark';
}

/**
 * What the engine recorded, phrased in the interface language.
 *
 * The engine's own `explanation` is an English sentence stored with the attempt;
 * interpolating it into a Persian chip reads like a bug, and the same facts are
 * already in the structured fields (`kind`, `expected`, `actual`, position), so
 * they are re-expressed here — the original sentence stays on the chip as its
 * `title` so the record the engine wrote is never lost.
 */
function errorDetail(tr: Tr, e: DetectedError): string | null {
  const q = (word: string | null): string => `«${word}»`;
  switch (e.kind) {
    case 'substitution':
      if (!e.expected || !e.actual) return null;
      return tr(`به‌جای ${q(e.expected)}، ${q(e.actual)} خوانده شد`, `“${e.actual}” instead of “${e.expected}”`);
    case 'omission':
      return e.expected ? tr(`${q(e.expected)} خوانده نشد`, `“${e.expected}” was not recited`) : null;
    case 'repetition':
      return e.actual ? tr(`${q(e.actual)} دوباره خوانده شد`, `“${e.actual}” was recited twice`) : null;
    case 'wrong-order':
      return e.actual ? tr(`${q(e.actual)} جای دیگری از همین آیه است`, `“${e.actual}” belongs elsewhere in the ayah`) : null;
    case 'similar-ayah-confusion':
      return tr('این واژه از آیهٔ دیگری آمده است', 'this wording comes from another ayah');
    case 'wrong-transition':
      return tr('گذار به آیهٔ نادرست', 'transitioned to the wrong ayah');
    default:
      return null;
  }
}

/** Error chips of one attempt, labelled from the contract. */
export function ErrorChips({ errors }: { errors: DetectedError[] }) {
  const { tr } = useApp();
  if (errors.length === 0) {
    return <span className="muted">{tr('بدون خطا ثبت شده است.', 'Recorded with no errors.')}</span>;
  }
  return (
    <div className="row stack--tight">
      {errors.map((e, i) => (
        <span
          key={`${e.kind}-${e.expectedPosition}-${i}`}
          className="chip chip--band"
          data-band={e.kind === 'correct' ? 'mastered' : 'weak'}
          dir="auto"
          title={e.explanation ?? undefined}
        >
          <span className="error-chip__kind">{errorKindLabel(tr, e.kind)}</span>
          <span className="num faint"> · {tr('واژه', 'word')} {e.expectedPosition}</span>
          {e.confusedWithVerseKey ? <span className="mono"> ← {e.confusedWithVerseKey}</span> : null}
          {errorDetail(tr, e) ? <span className="faint"> — {errorDetail(tr, e)}</span> : null}
        </span>
      ))}
    </div>
  );
}

/** Median over stored accuracies (an aggregation over rows, not a re-score). */
export function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
