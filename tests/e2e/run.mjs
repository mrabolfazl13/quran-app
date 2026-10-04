#!/usr/bin/env node
/**
 * tests/e2e/run.mjs — the entry point of the shipped-path journey.
 *
 *   node tests/e2e/run.mjs                        # installed desktop app, fresh profile
 *   node tests/e2e/run.mjs --shell=web            # built bundle on a loopback port + headless Edge
 *   node tests/e2e/run.mjs --exe=<path>           # drive a specific quran-desktop.exe
 *   node tests/e2e/run.mjs --profile=as-is        # keep the real profile (first-run steps skip)
 *   node tests/e2e/run.mjs --no-network-block     # observe requests instead of refusing them
 *   node tests/e2e/run.mjs --keep-run             # leave %TEMP%\quran-e2e-* for inspection
 *   node tests/e2e/run.mjs --restore-profile      # finish an interrupted run's parked profile
 *   node tests/e2e/run.mjs --expect-only          # print the manifest-derived expectations
 *
 * What this file owns, and what it deliberately does not:
 *  - It owns the process lifecycle: it starts exactly one app (plus, for the web
 *    shell, one server and one browser) and kills exactly those PIDs. A
 *    quran-desktop.exe it did not start is a reason to refuse, never a target.
 *  - It owns the profile: the app's own %APPDATA%\app.quran.platform is parked
 *    aside (renamed, not deleted) and put back at the end. See lib/profile.mjs.
 *  - It owns the evidence levels: the expectations come from content/index.json
 *    (pipeline), the row witnesses from the app's own database file or IndexedDB
 *    (database), and only the app driven through its real window is device.
 *  - It does not assert anything about the product. Every assertion lives in
 *    journey.mjs; this file only wires, guards and reports.
 */

import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';

import { Cdp } from './lib/cdp.mjs';
import { driftAgainstConstants, readContentIndex } from './lib/expected.mjs';
import { AssertionError, Suite } from './lib/harness.mjs';
import { launchBrowser, launchDesktop, launchWebServer, findDesktopExe, findEdge, killTree, preflightDesktopRunning, waitForHttp, assertBundleFresh } from './lib/launch.mjs';
import { makeLocalClassifier, offenders, originBuckets } from './lib/netgate.mjs';
import { createRunRoot, ProfileGuard } from './lib/profile.mjs';
import { makeStore } from './lib/store.mjs';
import { runJourney, runSearchTail } from './journey.mjs';
import { runLayoutTail, layoutViolations } from './layout.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

function arg(name, fallback = null) {
  const flag = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(flag));
  return hit ? hit.slice(flag.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

/** Ask the OS for a free loopback port; the preferred one is used when it is free. */
async function pickPort(preferred) {
  const tryListen = (port) =>
    new Promise((resolve, reject) => {
      const srv = createServer();
      srv.once('error', reject);
      srv.listen({ port, host: '127.0.0.1' }, () => srv.close(() => resolve(port)));
    });
  try {
    return await tryListen(preferred);
  } catch {
    return await tryListen(0);
  }
}

async function main() {
  const opts = {
    shell: arg('shell', 'desktop'),
    exe: arg('exe'),
    browser: arg('browser'),
    dist: arg('dist', path.join(REPO_ROOT, 'desktop', 'dist')),
    profile: arg('profile', 'fresh'),
    nameStamp: arg('stamp', String(Date.now()).slice(-6)),
    networkBlock: !hasFlag('no-network-block'),
    keepRun: hasFlag('keep-run'),
    keepProfile: hasFlag('keep-profile'),
    widths: arg('widths', '360,768,1440'),
    layout: !hasFlag('no-layout'),
  };

  if (opts.shell !== 'desktop' && opts.shell !== 'web') {
    throw new Error(`--shell must be desktop or web (got ${opts.shell})`);
  }

  /* ------------------------------------------------------- recovery commands */

  if (hasFlag('restore-profile')) {
    if (preflightDesktopRunning()) throw new Error('a quran-desktop.exe is running; close it first');
    const restored = ProfileGuard.restoreFromJournal({ appRunning: false });
    process.stdout.write(restored ? `restored ${restored.canonical} ← ${restored.parkedTo}\n` : 'no park journal found; nothing to do\n');
    return 0;
  }

  const { expect: expected } = readContentIndex();
  if (hasFlag('expect-only')) {
    const drift = driftAgainstConstants(expected);
    const { perPackRecords, checksums, ...counts } = expected;
    process.stdout.write(
      [
        `content/index.json — every figure below is read from the manifests, not typed in`,
        JSON.stringify(counts, null, 2),
        JSON.stringify({ perPackRecords, checksums }, null, 2),
        drift.length ? `DRIFT against the documented constants:\n${drift.join('\n')}` : 'no drift against the documented constants',
      ].join('\n') + '\n',
    );
    return drift.length ? 1 : 0;
  }

  /* --------------------------------------------------------------- lifecycle */

  const suite = new Suite({ title: `${opts.shell} journey` });
  const isDesktop = opts.shell === 'desktop';
  const runRoot = createRunRoot();
  const owned = new Set();
  const children = [];
  let guard = null;
  let cdp = null;
  let cleanupNote = '';
  let runnerError = null;

  const log = (line) => process.stdout.write(`${line}\n`);

  try {
    const appRunning = isDesktop && preflightDesktopRunning();

    await suite.step('no app instance was already running when this started', 'device', async () => {
      if (appRunning) throw new AssertionError('this run starts the app itself', { expected: 'no quran-desktop.exe before launch', actual: 'one was already running' });
      return 'nothing was running; only PIDs this run creates will be touched';
    }, { fatal: true });

    guard = new ProfileGuard({ runRoot: runRoot.root, mode: opts.profile });
    const prepared = guard.prepare({ appRunning });
    suite.note('profile', 'device', prepared.note);
    log(`· profile: ${prepared.note}`);

    const cdpPort = await pickPort(isDesktop ? 9777 : 9333);
    opts.webPort = isDesktop ? 0 : await pickPort(8123);

    let url = null;
    if (isDesktop) {
      const found = findDesktopExe({ explicit: opts.exe, repoRoot: REPO_ROOT });
      suite.note('executable', 'device', `${found.exe} (${found.source})`);
      log(`· exe: ${found.exe} [${found.source}]`);
      children.push(launchDesktop({
        exe: found.exe,
        port: cdpPort,
        webViewUserDataDir: path.join(runRoot.root, 'webview'),
        logDir: path.join(runRoot.root, 'logs'),
        extraEnv: prepared.env,
      }));
      url = 'http://tauri.localhost/';
    } else {
      assertBundleFresh({ dist: opts.dist, repoRoot: REPO_ROOT });
      children.push(launchWebServer({ repoRoot: REPO_ROOT, port: opts.webPort, dist: opts.dist }));
      await waitForHttp(`http://127.0.0.1:${opts.webPort}/`, { label: 'the web server' });
      log(`· serving ${opts.dist} at http://127.0.0.1:${opts.webPort}`);
      url = `http://127.0.0.1:${opts.webPort}/`;
      children.push(launchBrowser({
        url,
        port: cdpPort,
        userDataDir: path.join(runRoot.root, 'browser'),
        browser: opts.browser ? opts.browser : findEdge(),
      }));
    }

    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/list`, { label: 'the CDP endpoint', timeoutMs: 60_000 });
    cdp = await Cdp.attach({
      port: cdpPort,
      urlMatch: (targetUrl) => (isDesktop ? targetUrl.includes('tauri.localhost') : targetUrl.includes(`127.0.0.1:${opts.webPort}`)),
      name: opts.shell,
    });
    const webOrigin = isDesktop ? null : `http://127.0.0.1:${opts.webPort}`;
    const isLocal = makeLocalClassifier({ webOrigin });
    cdp.setLocalTest(isLocal);
    await cdp.startCapture({ intercept: opts.networkBlock });
    log(`· CDP attached on ${cdpPort}; offline gate ${opts.networkBlock ? 'refusing non-local requests' : 'observe only'}`);

    /* The witness needs to know where the shipped binary decided to write. Ask it
     * before the journey starts, so a step never has to guess a path. The invoke
     * bridge only exists once the page has booted, so this polls rather than
     * assuming the attach moment is the ready moment. */
    let paths = null;
    if (isDesktop) {
      const deadline = Date.now() + 90_000;
      while (!paths && Date.now() < deadline) {
        const raw = await cdp.evaluate(`(function(){
          const i = window.__TAURI_INTERNALS__;
          if (!i || !i.invoke) return null;
          return i.invoke('app_paths').then((p) => JSON.stringify(p)).catch(() => null);
        })()`);
        if (raw) paths = JSON.parse(String(raw));
        else await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (!paths) throw new Error('app_paths never answered within 90 s — the window did not boot');
      guard.observeReported(paths.appData);
    }

    const store = makeStore({
      shell: isDesktop ? 'desktop' : 'browser',
      dbPath: paths ? path.join(paths.appData, 'quran.db') : null,
      backupsDir: paths ? paths.backups : null,
      cdp,
    });

    await suite.step('the packs on disk still carry the documented figures', 'pipeline', async () => {
      const drift = driftAgainstConstants(expected);
      if (drift.length) throw new AssertionError('content/index.json matches docs/current-state.md', { expected: 'no drift', actual: drift });
      return `surahs ${expected.surahs} · ayahs ${expected.ayahs} · words ${expected.words} · translations ${expected.translations} · tafsirs ${expected.tafsirs} · similar ${expected.similar} · packs ${expected.packRows}`;
    }, { fatal: true });

    const ctx = { cdp, suite, expected, store, opts, isDesktop, guard, paths, importWallMs: null };
    if (paths) ctx.paths = { appData: paths.appData, backups: paths.backups, contentRoot: paths.contentRoot };

    await runJourney(ctx);
    await runSearchTail(ctx);

    /* The layout sweep runs last and on purpose: it measures the screens the
     * journey just filled with the learner's real items, attempts and notes,
     * which no empty-database screenshot can represent. */
    if (opts.layout) {
      await suite.step('every screen keeps its content inside the viewport at every swept width', 'device', async () => {
        const rows = await runLayoutTail({ cdp, suite, opts: { ...opts, runRoot: runRoot.root } });
        const violations = layoutViolations(rows);
        if (violations.length) throw new Error(`${violations.length} violation(s):\n    ${violations.slice(0, 20).join('\n    ')}`);
        return `${rows.length} screens measured across ${opts.widths} px, 0 sideways overflow, 0 cut-off element`;
      });
    }

    await suite.step('no request left this machine during the whole journey', 'device', async () => {
      const bad = offenders(cdp.requests, isLocal);
      if (bad.length) throw new AssertionError('every request was local', { expected: '0 non-local requests', actual: [...new Set(bad)].slice(0, 10) });
      const buckets = originBuckets(cdp.requests.map((r) => r.url), isLocal).slice(0, 6);
      const note = buckets.map((b) => `${b.origin}×${b.count}`).join(' · ');
      suite.note('origins asked', 'device', note);
      if (opts.networkBlock) {
        return `${cdp.requests.length} requests, 0 non-local, ${cdp.blocked.length} refused at request level (${note})`;
      }
      return `${cdp.requests.length} requests, 0 non-local (observe-only; nothing was refused) (${note})`;
    });

    if (ctx.importWallMs) {
      suite.note('content import wall clock', 'device', `${ctx.importWallMs} ms for ${expected.packRows} packs on this machine`);
    }
  } catch (error) {
    // The runner breaking is a failure of the verification, not a footnote. A
    // stale bundle, a server that never came up or a crash mid-journey used to
    // land as a NOTE, so the report said `FAIL 0` and exited 0 for a run that
    // proved nothing.
    runnerError = error instanceof Error ? error.message : String(error);
    suite.fail('the runner completed the journey', 'device', `the runner itself failed: ${runnerError}`);
    if (!(error instanceof AssertionError)) log(`· runner error: ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n') : error}`);
  } finally {
    if (cdp) cdp.close();
    for (const child of children) {
      if (child && typeof child.pid === 'number') owned.add(child.pid);
      killTree(child, { owned });
    }
    const summary = guard ? guard.finish({ keep: opts.keepProfile }) : null;
    if (summary) {
      if (summary.deleted.length) cleanupNote += `deleted this run’s profile: ${summary.deleted.join(', ')} · `;
      if (summary.restored) cleanupNote += `parked profile restored to ${summary.restored} · `;
      if (summary.warnings.length) cleanupNote += `warnings: ${summary.warnings.join(' | ')} · `;
    }

    // The evidence is written before anything is removed: a deleted run must
    // still be auditable from its own log directory.
    const logsDir = path.join(runRoot.root, 'logs');
    const counts = suite.counts();
    writeFileSync(
      path.join(logsDir, 'summary.json'),
      JSON.stringify({ shell: opts.shell, at: new Date().toISOString(), counts, rows: suite.rows, cleanup: cleanupNote }, null, 2),
    );
    writeFileSync(path.join(logsDir, 'report.txt'), suite.report());
    cleanupNote += `evidence kept at ${logsDir} · `;
    if (!opts.keepRun) {
      // Only the browser profiles — they are the bulk of the directory and are
      // this run's own creation. logs/ and shots/ stay for the operator.
      for (const heavy of ['webview', 'browser']) {
        try {
          rmSync(path.join(runRoot.root, heavy), { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
        } catch (error) {
          // A WebView2 handle can outlive the process; leaving the directory is
          // untidy, deleting the evidence would be worse.
          cleanupNote += `${heavy} not removed: ${error.message} · `;
        }
      }
    } else {
      cleanupNote += `run directory kept whole at ${runRoot.root} · `;
    }
  }

  const report = suite.report();
  process.stdout.write(report + (cleanupNote ? `Cleanup: ${cleanupNote}\n` : ''));

  return suite.failed ? 1 : 0;
}

process.exitCode = await main();
