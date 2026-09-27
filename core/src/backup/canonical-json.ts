/**
 * Deterministic canonical JSON serialisation.
 *
 * The backup file format depends on this being byte-reproducible across
 * platforms and engines, because the envelope checksum is the sha256 of the
 * canonical JSON of `data` (see `docs/backup-format.md`).
 *
 * Rules (normative, mirrored in the docs):
 * 1. UTF-8 encoding, no BOM, no trailing newline, no insignificant whitespace.
 * 2. Object keys are sorted by UTF-16 code unit (JS default `Array.sort()`),
 *    which is deterministic across all JS engines.
 * 3. Array order is preserved — arrays are ordered data (attempts, steps,
 *    verse-key sequences); sorting them would destroy meaning.
 * 4. `undefined` object members are dropped; explicit `null` is kept.
 * 5. Numbers use JS `String(n)` shortest-round-trip form. `-0` is emitted as
 *    `0`. Non-finite numbers (NaN/Infinity) and bigint/function/symbol values
 *    are rejected — they cannot be represented portably and must never reach
 *    a checksum.
 * 6. Strings are serialised with JSON escaping (no raw control characters).
 */

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

function walk(value: unknown, path: string, out: { parts: string[] }): void {
  if (value === null) {
    out.parts.push('null');
    return;
  }
  switch (typeof value) {
    case 'boolean':
      out.parts.push(value ? 'true' : 'false');
      return;
    case 'number': {
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(`non-finite number at ${path}`);
      }
      out.parts.push(Object.is(value, -0) ? '0' : String(value));
      return;
    }
    case 'string':
      out.parts.push(JSON.stringify(value));
      return;
    case 'undefined':
      // Only reachable through an array hole or an explicit call; drop as null
      // in arrays is JSON behaviour, but we forbid it for determinism.
      throw new CanonicalJsonError(`undefined value at ${path}`);
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new CanonicalJsonError(`unsupported ${typeof value} value at ${path}`);
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(`unsupported value at ${path}`);
  }

  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let i = 0; i < value.length; i++) {
      const parts: string[] = [];
      walk(value[i], `${path}[${i}]`, { parts });
      items.push(parts.join(''));
    }
    out.parts.push('[', items.join(','), ']');
    return;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  const members: string[] = [];
  for (const key of keys) {
    const parts: string[] = [];
    walk(record[key], `${path}.${key}`, { parts });
    members.push(`${JSON.stringify(key)}:${parts.join('')}`);
  }
  out.parts.push('{', members.join(','), '}');
}

/**
 * Serialise `value` to canonical JSON. Throws `CanonicalJsonError` on values
 * that cannot be represented deterministically — callers that face hostile
 * input must catch and convert to a failed result.
 */
export function canonicalJsonStringify(value: unknown): string {
  const parts: string[] = [];
  walk(value, '$', { parts });
  return parts.join('');
}

/**
 * UTF-8 bytes of a string, without Node-specific APIs (works in webview too).
 * Ambient minimal declaration: the core tsconfig lib is ES2022 (no DOM), but
 * TextEncoder exists at runtime in Node ≥ 11 and all modern webviews.
 */
interface RuntimeTextEncoder {
  encode(input?: string): Uint8Array;
}
declare const TextEncoder: new () => RuntimeTextEncoder;

export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
