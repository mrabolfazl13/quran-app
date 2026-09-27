import { describe, expect, it } from 'vitest';
import { inspectEnvelope } from '../../src/backup/validate';
import { serializeEnvelope } from '../../src/backup/export';
import { sampleEnvelope } from './fixtures';

/**
 * §47: a malformed/hostile file must return a failed result, never throw,
 * never hang the process, and never pollute object state.
 */

function expectFailure(input: string, label: string): void {
  let result: ReturnType<typeof inspectEnvelope> | undefined;
  expect(() => {
    try {
      result = inspectEnvelope(input);
    } catch (err) {
      throw new Error(`inspectEnvelope THREW on ${label}: ${err}`);
    }
  }).not.toThrow();
  expect(result, label).toBeDefined();
  expect(result!.ok, label).toBe(false);
  if (!result!.ok) {
    expect(result!.errors.length, `${label}: errors`).toBeGreaterThan(0);
    for (const e of result!.errors) {
      expect(typeof e.code).toBe('string');
      expect(typeof e.path).toBe('string');
      expect(typeof e.message).toBe('string');
    }
  }
}

describe('hostile input — 100 KB of garbage never crashes restore', () => {
  const halfFile = serializeEnvelope(sampleEnvelope()).slice(0, 600);

  const garbage: Record<string, string> = {
    '100kb of junk chars': 'x'.repeat(100 * 1024),
    '100kb of mixed control chars': (() => {
      const part = '\u0000\u0001{"data":[,]}\n\t'.repeat(500);
      return `${part}x`.repeat(250).slice(0, 100 * 1024);
    })(),
    'truncated real backup': halfFile,
    'truncated backup + null bytes': `${halfFile}\u0000\u0000\u0000`,
    'unbalanced braces': '{'.repeat(50_000),
    'deep nesting': `[${'['.repeat(50_000)}${']'.repeat(50_000)}]`,
    'binary blob': String.fromCharCode(...Array.from({ length: 4096 }, (_, i) => i % 256)),
    'wrong types everywhere':
      '{"schemaVersion":[1],"minReaderVersion":"x","createdAt":5,"producedBy":"app","checksum":{"h":"n"},"counts":[],"data":[]}',
    'proto pollution attempt': '{"__proto__":{"polluted":true},"schemaVersion":1}',
    'object pollution attempt': '{"constructor":{"prototype":{"bad":1}},"schemaVersion":1}',
    'valid JSON, no envelope': '[1,2,3,{"a":null}]',
    'empty object': '{}',
    'just BOM': '\uFEFF',
    'BOM + junk': '\uFEFF{"schemaVersion":1,garbage',
    'huge numbers': `{"schemaVersion":1e400,"data":{"notes":[{"accuracy":${'9'.repeat(400)}}]}}`,
    'nested arrays as rows':
      '{"schemaVersion":1,"minReaderVersion":1,"createdAt":"2026-01-01T00:00:00Z","producedBy":{"app":"a","version":"b","platform":"desktop"},"checksum":"' +
      '0'.repeat(64) +
      '","counts":{"settings":0,"bookmarks":1,"notes":0,"readingPositions":0,"readingHistory":0,"hifzItems":0,"hifzSegments":0,"anchorWords":0,"hifzTransitions":0,"recallAttempts":0,"confusionGroups":0,"sessions":0,"journeys":0,"reflections":0,"dailyPlans":0},"data":{"settings":{},"bookmarks":[[[[]]]],"notes":[],"readingPositions":[],"readingHistory":[],"hifzItems":[],"hifzSegments":[],"anchorWords":[],"hifzTransitions":[],"recallAttempts":[],"confusionGroups":[],"sessions":[],"journeys":[],"reflections":[],"dailyPlans":[]}}',
  };

  for (const [label, input] of Object.entries(garbage)) {
    it(label, () => {
      expectFailure(input, label);
    });
  }

  it('size guard fires before any parsing', () => {
    const big = 'x'.repeat(2 * 1024 * 1024);
    const start = performance.now();
    const r = inspectEnvelope(big, { maxBytes: 64 * 1024 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.code).toBe('too-large');
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('does not pollute Object.prototype', () => {
    expectFailure(garbage['proto pollution attempt']!, 'proto');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expectFailure(garbage['object pollution attempt']!, 'constructor');
    expect(([] as unknown as Record<string, unknown>).bad).toBeUndefined();
  });

  it('inspectEnvelope on a 100 KB garbage file completes quickly and returns a result object', () => {
    const payload = 'x'.repeat(100 * 1024);
    const start = performance.now();
    const r = inspectEnvelope(payload);
    const elapsed = performance.now() - start;
    expect(r.ok).toBe(false);
    expect(elapsed).toBeLessThan(2000);
  });
});
