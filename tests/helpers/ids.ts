/**
 * Deterministic ids.
 *
 * User rows are uuid-ish text keys (docs/data-model.md: never autoincrement,
 * so two devices can restore without collision). Tests need the same shape but
 * must be re-runnable byte-for-byte, so ids come from a counter mixed into a
 * sha256 digest — no `crypto.randomUUID()`, no `Math.random()`.
 *
 * Call `resetIds(seed)` with a per-suite seed so ids are stable inside a run
 * and cannot collide between suites sharing one database file.
 */

import { createHash } from 'node:crypto';

let seed = 'quran-test-default';
let counter = 0;

export function resetIds(newSeed = seed): void {
  seed = newSeed;
  counter = 0;
}

/** Raw 128-bit hex digest of the current draw, without consuming it. */
export function peekId(kind = 'row'): string {
  return sha128(`${seed}|${kind}|${counter + 1}`);
}

/** Consumes one counter slot and returns a canonical 8-4-4-4-12 uuid string. */
export function nextId(kind = 'row'): string {
  counter += 1;
  return asUuid(sha128(`${seed}|${kind}|${counter}`));
}

/** Ids for a batch, in draw order — handy for seeded fixture rows. */
export function nextIds(count: number, kind = 'row'): string[] {
  return Array.from({ length: count }, () => nextId(kind));
}

/**
 * A stable id for a domain value (not the counter): the same verse key or the
 * same pack id always maps to the same uuid-ish string, which is what makes a
 * re-import or a re-export comparable.
 */
export function stableId(prefix: string, value: string): string {
  return asUuid(sha128(`${prefix}|${value}`));
}

export function currentCounter(): number {
  return counter;
}

function sha128(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 32);
}

/** Format 32 hex chars as 8-4-4-4-12 with the v4 version/variant nibbles set. */
function asUuid(hex32: string): string {
  const h = hex32.padEnd(32, '0');
  const versioned = `${h.slice(0, 12)}4${h.slice(13)}`;
  const variantNibble = ((parseInt(versioned[16] ?? '0', 16) & 0b0011) | 0b1000).toString(16);
  const v = `${versioned.slice(0, 16)}${variantNibble}${versioned.slice(17)}`;
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}`;
}
