/**
 * Deterministic time for the QA suite.
 *
 * The hifz engine takes time as a parameter (`nowIso`, `addedAt`,
 * `startedAt`, …) — it must never read the machine clock, and neither must a
 * test. Anything that needs "today" asks this module, so a failing scenario can
 * be re-run exactly (docs/testing.md rule 2).
 *
 * The default anchor is a fixed, real-looking instant; it is not derived from
 * the current date, so a suite cannot drift when it runs at 23:59.
 */

/** Anchor instant every fixture timeline is measured from. */
export const EPOCH_ISO = '2026-01-01T08:00:00.000Z';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export interface FixedClock {
  /** Current instant as an ISO-8601 UTC string (`.000Z`). */
  now(): string;
  /** Current instant in epoch milliseconds. */
  ms(): number;
  /** Absolute instant `days` after the anchor, without moving the clock. */
  day(days: number, hour?: number, minute?: number): string;
  /** Move forward by whole days and return the new `now()`. */
  advanceDays(days: number): string;
  /** Move forward by milliseconds and return the new `now()`. */
  advanceMs(ms: number): string;
  /** Jump to an absolute ISO instant and return it. */
  set(iso: string): string;
  /** Consume a fresh timestamp `n` minutes after the previous one. */
  step(minutes: number): string;
}

/**
 * A clock that starts at the anchor and only moves when told to.
 * `startIso` may be any ISO instant so a scenario can be replayed from a
 * recorded date.
 */
export function fixedClock(startIso: string = EPOCH_ISO): FixedClock {
  let ms = Date.parse(startIso);
  if (Number.isNaN(ms)) throw new TypeError(`fixedClock: not an ISO instant: ${startIso}`);
  let stepCursor = ms;
  return {
    now: () => new Date(ms).toISOString(),
    ms: () => ms,
    day: (days, hour = 8, minute = 0) =>
      new Date(ms + days * DAY_MS + (hour - 8) * 60 * MINUTE_MS + minute * MINUTE_MS).toISOString(),
    advanceDays: (days) => {
      ms += days * DAY_MS;
      return new Date(ms).toISOString();
    },
    advanceMs: (offset) => {
      ms += offset;
      return new Date(ms).toISOString();
    },
    set: (iso) => {
      const parsed = Date.parse(iso);
      if (Number.isNaN(parsed)) throw new TypeError(`fixedClock.set: not an ISO instant: ${iso}`);
      ms = parsed;
      return iso;
    },
    step: (minutes) => {
      stepCursor += minutes * MINUTE_MS;
      return new Date(stepCursor).toISOString();
    },
  };
}

/** ISO instant `n` days after `fromIso` (n may be negative). */
export function daysLater(n: number, fromIso: string = EPOCH_ISO): string {
  return new Date(Date.parse(fromIso) + n * DAY_MS).toISOString();
}

/** ISO instant `n` minutes after `fromIso`. */
export function minutesLater(n: number, fromIso: string = EPOCH_ISO): string {
  return new Date(Date.parse(fromIso) + n * MINUTE_MS).toISOString();
}

/** `YYYY-MM-DD` for a `daily_plan.date`-style key. */
export function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}

/** Whole days between two instots, floor of the real difference. */
export function wholeDays(fromIso: string, toIso: string): number {
  return Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / DAY_MS);
}

/**
 * Run `fn` with the wall clock made unreachable, then restore it.
 *
 * Any code that reads the system clock (`new Date()`, `Date.now()`,
 * `performance.now()`-via-Date) throws instead of silently making a test
 * non-reproducible. Use it around engine calls: a deterministic engine is
 * unaffected, a clock-reading one fails with a clear message.
 */
export function runWithFrozenClock<T>(fn: () => T): T {
  const RealDate = Date;
  class GuardDate extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) {
        throw new Error('clock read blocked: engine code must take time as a parameter');
      }
      super(...(args as [string | number]));
    }
    static now(): number {
      throw new Error('clock read blocked: Date.now() is not allowed inside the engine');
    }
  }
  const globalRef = globalThis as { Date: unknown };
  globalRef.Date = GuardDate;
  try {
    return fn();
  } finally {
    globalRef.Date = RealDate;
  }
}
