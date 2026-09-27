import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalJsonStringify, CanonicalJsonError, utf8Bytes } from '../../src/backup/canonical-json';
import { sha256Hex } from '../../src/backup/sha256';

describe('canonical JSON', () => {
  it('sorts keys recursively, independent of insertion order', () => {
    const a = { b: 1, a: { d: [1, { z: 1, y: 2 }], c: 'x' } };
    const b = { a: { c: 'x', d: [1, { y: 2, z: 1 }] }, b: 1 };
    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
    expect(canonicalJsonStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('preserves array order (arrays are ordered data)', () => {
    expect(canonicalJsonStringify([2, 1, 3])).toBe('[2,1,3]');
  });

  it('emits shortest-round-trip numbers, -0 as 0', () => {
    expect(canonicalJsonStringify({ v: 0.1 })).toBe('{"v":0.1}');
    expect(canonicalJsonStringify({ v: 1e21 })).toBe('{"v":1e+21}');
    expect(canonicalJsonStringify(-0)).toBe('0');
  });

  it('drops undefined object members, keeps explicit null', () => {
    expect(canonicalJsonStringify({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('escapes strings with JSON rules (control chars, quotes)', () => {
    expect(canonicalJsonStringify('a"b\u0000c')).toBe('"a\\"b\\u0000c"');
  });

  it('rejects values that cannot be represented deterministically', () => {
    expect(() => canonicalJsonStringify(NaN)).toThrow(CanonicalJsonError);
    expect(() => canonicalJsonStringify(Infinity)).toThrow(CanonicalJsonError);
    expect(() => canonicalJsonStringify(() => 0)).toThrow(CanonicalJsonError);
    expect(() => canonicalJsonStringify(10n)).toThrow(CanonicalJsonError);
    expect(() => canonicalJsonStringify([undefined])).toThrow(CanonicalJsonError);
  });
});

describe('sha256', () => {
  const vectors: readonly string[] = [
    '',
    'abc',
    'a'.repeat(55), // one block after padding boundary cases
    'a'.repeat(56),
    'a'.repeat(63),
    'a'.repeat(64),
    'a'.repeat(119),
    'a'.repeat(120),
    'بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ', // Arabic, multi-byte UTF-8
    '😀'.repeat(40), // astral plane
    'x'.repeat(100_000),
  ];

  it('matches node:crypto for every vector', () => {
    for (const text of vectors) {
      const bytes = utf8Bytes(text);
      expect(sha256Hex(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });
});
