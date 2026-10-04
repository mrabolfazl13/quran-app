/**
 * tests/e2e/lib/harness.mjs — the step recorder for the E2E journey.
 *
 * Dependency-free on purpose: this repo ships no test runner for the packaged
 * app level, and the harness must not need one. It records ordered steps, each
 * with the evidence LEVEL its assertion belongs to (AGENTS.md / docs/testing.md
 * rule 5: engine / pipeline / database / device), times them, and prints a
 * table. Any FAIL makes the process exit non-zero.
 *
 * A step that throws is never swallowed: `AssertionError` carries the stated
 * expected value next to the measured one, so the report reads as evidence and
 * not as adjectives. `fatal` steps stop the journey (there is no point driving a
 * hifz session over a database that never imported).
 */

import { isDeepStrictEqual } from 'node:util';

/** The four levels this repo allows a number to be tagged with. */
export const LEVELS = Object.freeze({
  engine: 'engine',
  pipeline: 'pipeline',
  database: 'database',
  device: 'device',
});

export class AssertionError extends Error {
  constructor(message, { expected, actual }) {
    super(`${message} — expected ${fmt(expected)}, got ${fmt(actual)}`);
    this.name = 'AssertionError';
    this.expected = expected;
    this.actual = actual;
  }
}

export class StepError extends Error {
  constructor(message, cause) {
    super(`${message}${cause ? ` [${cause.name}: ${cause.message}]` : ''}`);
    this.name = 'StepError';
    this.cause = cause;
  }
}

function fmt(value) {
  if (typeof value === 'string') return value.length > 120 ? `${JSON.stringify(value.slice(0, 117))}…` : JSON.stringify(value);
  if (value === undefined) return 'undefined';
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text.slice(0, 160);
  } catch {
    return String(value);
  }
}

/** Assert deep equality with both sides printed. */
export function eq(actual, expected, what) {
  if (!isDeepStrictEqual(actual, expected)) throw new AssertionError(what, { expected, actual });
}

/** Assert `actual === expected` for scalars (numbers, strings, booleans). */
export function is(actual, expected, what) {
  if (actual !== expected) throw new AssertionError(what, { expected, actual });
}

export function ok(condition, what, detail = null) {
  if (!condition) throw new AssertionError(what, { expected: 'truthy', actual: detail ?? condition });
  return true;
}

/** Numbers the harness cannot predict exactly (durations, row orders). */
export function inRange(actual, min, max, what) {
  if (typeof actual !== 'number' || Number.isNaN(actual) || actual < min || actual > max) {
    throw new AssertionError(what, { expected: `between ${min} and ${max}`, actual });
  }
  return true;
}

/** Include check on a rendered string, with the needle stated in the failure. */
export function includes(haystack, needle, what) {
  if (typeof haystack !== 'string' || !haystack.includes(needle)) {
    throw new AssertionError(what, { expected: `text containing ${needle}`, actual: typeof haystack === 'string' ? haystack.slice(0, 200) : haystack });
  }
  return true;
}

export class Suite {
  /** @param {{title?: string, log?: (line: string) => void}} */
  constructor({ title = 'e2e', log = (line) => process.stdout.write(`${line}\n`) } = {}) {
    this.title = title;
    this.log = log;
    /** @type {Array<{name: string, level: string, status: string, ms: number, detail: string}>} */
    this.rows = [];
    this.abortedBy = null;
    this.startedAt = Date.now();
  }

  /**
   * Run one step. `fn` may return a short string: it becomes the step's detail
   * column, i.e. the measured evidence the report is allowed to quote.
   */
  async step(name, level, fn, { fatal = false, detail = '', skip = false, skipReason = '' } = {}) {
    if (!LEVELS[level]) throw new TypeError(`step "${name}" has no evidence level (got ${level})`);
    if (this.abortedBy) {
      this.rows.push({ name, level, status: 'SKIP', ms: 0, detail: `not run: earlier fatal step "${this.abortedBy}" failed` });
      return undefined;
    }
    if (skip) {
      this.rows.push({ name, level, status: 'SKIP', ms: 0, detail: skipReason || detail });
      return undefined;
    }

    const t0 = Date.now();
    this.log(`→ ${name} [${level}]`);
    try {
      const value = await fn();
      const ms = Date.now() - t0;
      const measured = typeof value === 'string' && value.length > 0 ? value : detail;
      this.rows.push({ name, level, status: 'PASS', ms, detail: measured });
      this.log(`  PASS (${ms} ms)${measured ? ` — ${measured}` : ''}`);
      return value;
    } catch (error) {
      const ms = Date.now() - t0;
      const status = error instanceof AssertionError ? 'FAIL' : 'ERROR';
      const message = error instanceof Error ? error.message : String(error);
      this.rows.push({ name, level, status, ms, detail: message });
      this.log(`  ${status} (${ms} ms) — ${message}`);
      if (fatal) this.abortedBy = name;
      return undefined;
    }
  }

  /** Record a step that could not be expressed as an assertion at all. */
  note(name, level, detail) {
    this.rows.push({ name, level, status: 'NOTE', ms: 0, detail });
  }

  /**
   * Record a failure that never reached a step — the runner itself broke. A NOTE
   * here would report `FAIL 0` and exit 0, so a run that verified nothing would
   * read as a green journey to whoever runs it next.
   */
  fail(name, level, detail) {
    this.rows.push({ name, level, status: 'FAIL', ms: 0, detail });
  }

  counts() {
    const out = { PASS: 0, FAIL: 0, ERROR: 0, SKIP: 0, NOTE: 0 };
    for (const row of this.rows) out[row.status] += 1;
    return out;
  }

  /** The report the operator (and docs/current-state.md) copies numbers from. */
  report() {
    const widths = { name: 52, level: 9, status: 6 };
    const line = (cells) => cells.map((c, i) => String(c).padEnd([widths.name, widths.level, widths.status][i])).join(' ');
    const rows = this.rows.map((r) => line([r.name.slice(0, widths.name), r.level, r.status, `${r.ms} ms`]) + ` ${r.detail}`);
    const counts = this.counts();
    return [
      '',
      `E2E ${this.title} — ${((Date.now() - this.startedAt) / 1000).toFixed(1)} s wall clock`,
      line(['STEP', 'LEVEL', 'STATUS', 'TIME']),
      '-'.repeat(110),
      ...rows,
      '-'.repeat(110),
      `PASS ${counts.PASS} · FAIL ${counts.FAIL} · ERROR ${counts.ERROR} · SKIP ${counts.SKIP} · NOTE ${counts.NOTE}`,
      '',
      'Levels: engine = pure function, pipeline = content build, database = rows in',
      'the app’s own file, device = the packaged app through its real window. A number',
      'is only a device-level claim when its row above is tagged device.',
      '',
    ].join('\n');
  }

  /** Non-zero exit code when anything failed or errored. */
  get failed() {
    const c = this.counts();
    return c.FAIL + c.ERROR > 0;
  }
}
