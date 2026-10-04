/**
 * tests/integration/e2e-witness.test.ts — the shipped-path journey's own guards.
 *
 * The e2e suite is the only place a device-level claim is produced, so a runner
 * that can report success without having verified anything is worse than no
 * runner: both rounds that "passed" while serving a bundle from before the change
 * under test are the reason this file exists. Two properties are pinned here,
 * against real files in a temp directory:
 *
 *  1. `assertBundleFresh` refuses a `desktop/dist` older than the sources it is
 *     supposed to contain, and stays quiet when it is not.
 *  2. A runner-level error is a FAIL, so `Suite.failed` — the only thing
 *     `run.mjs` returns as an exit code — is true for a run that aborted before
 *     launching the app. Before this, that case was a NOTE and exit 0.
 *
 * Nothing here drives a browser or the app; it tests the witness, not the product.
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { assertBundleFresh } from '../e2e/lib/launch.mjs';
import { Suite } from '../e2e/lib/harness.mjs';

/** `dist/index.html` at `builtAt`, a repo-shaped source tree under `srcAt`. */
function makeFixture({ builtAt, sourceAt }: { builtAt: number; sourceAt: number }) {
  const root = mkdtempSync(path.join(tmpdir(), 'quran-freshness-'));
  const dist = path.join(root, 'desktop', 'dist');
  const src = path.join(root, 'desktop', 'src', 'gateway');
  mkdirSync(path.join(dist, 'assets'), { recursive: true });
  mkdirSync(src, { recursive: true });
  mkdirSync(path.join(root, 'core', 'src'), { recursive: true });
  const marker = path.join(dist, 'index.html');
  writeFileSync(marker, '<html></html>');
  writeFileSync(path.join(dist, 'assets', 'index-abc.js'), 'console.log(1);');
  writeFileSync(path.join(src, 'types.ts'), 'export type T = 1;');
  writeFileSync(path.join(root, 'core', 'src', 'note.css'), '.a{}');
  utimesSync(marker, new Date(builtAt), new Date(builtAt));
  utimesSync(path.join(dist, 'assets', 'index-abc.js'), new Date(builtAt), new Date(builtAt));
  utimesSync(path.join(src, 'types.ts'), new Date(sourceAt), new Date(sourceAt));
  utimesSync(path.join(root, 'core', 'src', 'note.css'), new Date(sourceAt), new Date(sourceAt));
  return { root, dist, marker };
}

const DAY = 86_400_000;

describe('assertBundleFresh — a web run must judge the current build', () => {
  const roots: string[] = [];

  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 8 });
  });

  function fixture(builtAt: number, sourceAt: number) {
    const f = makeFixture({ builtAt, sourceAt });
    roots.push(f.root);
    return f;
  }

  it('refuses a bundle older than a source file it should contain', () => {
    const { dist } = fixture(Date.now() - DAY, Date.now());
    expect(() => assertBundleFresh({ dist, repoRoot: path.join(dist, '..', '..') })).toThrow(/is stale/);
  });

  it('names the file and the rebuild command, so the operator knows what to do', () => {
    const { dist } = fixture(Date.now() - DAY, Date.now());
    let message = '';
    try {
      assertBundleFresh({ dist, repoRoot: path.join(dist, '..', '..') });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/desktop[\\/]src[\\/]gateway[\\/]types\.ts was written after the build/);
    expect(message).toMatch(/npm run desktop:build/);
  });

  it('accepts a bundle built after every source', () => {
    const { dist } = fixture(Date.now(), Date.now() - DAY);
    expect(() => assertBundleFresh({ dist, repoRoot: path.join(dist, '..', '..') })).not.toThrow();
  });

  it('refuses a missing bundle rather than serving an empty directory', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'quran-freshness-'));
    roots.push(root);
    expect(() =>
      assertBundleFresh({ dist: path.join(root, 'desktop', 'dist'), repoRoot: root }),
    ).toThrow(/no built bundle/);
  });

  it('ignores files that are not sources', () => {
    const { dist, root } = fixture(Date.now() - DAY, Date.now());
    const readme = path.join(root, 'desktop', 'src', 'README.md');
    writeFileSync(readme, 'not a source');
    utimesSync(readme, new Date(Date.now()), new Date(Date.now()));
    expect(() => assertBundleFresh({ dist, repoRoot: root })).toThrow(/is stale/);
    // …and a tree with only non-source files newer than the build is accepted.
    const fresh = fixture(Date.now() - DAY, Date.now() - DAY);
    writeFileSync(path.join(fresh.root, 'desktop', 'src', 'notes.md'), 'newer than every source');
    utimesSync(path.join(fresh.root, 'desktop', 'src', 'notes.md'), new Date(), new Date());
    expect(() => assertBundleFresh({ dist: fresh.dist, repoRoot: fresh.root })).not.toThrow();
  });
});

describe('Suite — the runner’s own failure is a failure', () => {
  it('counts a runner-level fail in the exit-code signal', () => {
    const suite = new Suite({ title: 'witness test', log: () => undefined });
    suite.fail('the runner completed the journey', 'device', 'the runner itself failed: bundle is stale');
    expect(suite.counts().FAIL).toBe(1);
    expect(suite.failed).toBe(true);
  });

  it('does not treat a note as a failure, so honest NOTE rows keep meaning nothing', () => {
    const suite = new Suite({ title: 'witness test', log: () => undefined });
    suite.note('runner', 'device', 'the runner itself failed: bundle is stale');
    expect(suite.counts().NOTE).toBe(1);
    expect(suite.failed).toBe(false);
  });

  it('reports the failed row in the text report an operator copies numbers from', () => {
    const suite = new Suite({ title: 'witness test', log: () => undefined });
    suite.fail('the runner completed the journey', 'device', 'the runner itself failed: bundle is stale');
    expect(suite.report()).toMatch(/the runner completed the journey\s+device\s+FAIL/);
    expect(suite.report()).toMatch(/FAIL 1/);
  });
});
