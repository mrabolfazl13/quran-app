import { describe, expect, it } from 'vitest';
import { reviewFactorLabel, reviewReason } from './shared';

const fa = (a: string, _b: string) => a;
const en = (_a: string, b: string) => b;

describe('reviewReason', () => {
  it('renders a three-factor scheduler reason in Persian', () => {
    const raw = 'no segment data — 1 estimated from item stability; no transition data — 1 estimated from item stability; never scheduled';
    const out = reviewReason(fa, raw);
    expect(out).toBe('دادهٔ پاره‌ای نیست — 1 از پایداری آیه برآورد شد؛ دادهٔ گذاری نیست — 1 از پایداری آیه برآورد شد؛ هرگز زمان‌بندی نشده');
    // The engine's numbers survive untouched; no English sentence leaks through.
    expect(out.match(/\d/g)).toEqual(['1', '1']);
    expect(/[a-z]{3}/i.test(out)).toBe(false);
  });

  it('keeps the English wording when the interface language is English', () => {
    expect(reviewReason(en, 'overdue by 4d; 2/5 segment(s) below 0.4')).toBe('overdue by 4d; 2/5 segment(s) below 0.4');
  });

  it('translates counts inside a factor summary without rounding them', () => {
    expect(reviewReason(fa, '3 wrong word(s) in 7 attempt(s)')).toBe('3 واژهٔ غلط در 7 تلاش');
    expect(reviewReason(fa, '2/5 segment(s) below 0.4')).toBe('2 از 5 پاره زیر 0.4');
    expect(reviewReason(fa, 'repetition debt 4; band=consolidate')).toBe('بدهی تکرار 4؛ باند consolidate');
  });

  it('passes an unknown fragment through rather than dropping engine evidence', () => {
    expect(reviewReason(fa, 'something the engine invented later')).toBe('something the engine invented later');
    expect(reviewReason(fa, 'no urgency signals')).toBe('نشانهٔ فوریتی نیست');
  });

  it('labels every scheduler factor and surfaces an unknown key verbatim', () => {
    expect(reviewFactorLabel(fa, 'weak-transitions')).toBe('گذارهای ضعیف');
    expect(reviewFactorLabel(fa, 'a-new-factor')).toBe('a-new-factor');
  });
});
