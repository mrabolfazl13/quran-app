#!/usr/bin/env node
/**
 * tests/e2e/pwa.mjs — task #20: exercise the PWA install surface of the
 * PACKAGED web build, offline, with the numbers a user's machine really sees.
 *
 * What is measured is `desktop/release/web/quran-web-<version>/dist` — the
 * folder `start.cmd` / `start.command` / `start.sh` serves when somebody
 * double-clicks it — and never `desktop/dist` directly. Everything else in this
 * suite drives a build tree; this file exists because "the web deliverable is
 * the artifact", and an artifact that was never booted from its own folder is a
 * claim, not a fact.
 *
 * The four checks (docs/testing.md: device level, since the packaged bytes are
 * driven through a real browser):
 *
 *   1. the service worker registers, activates and CONTROLS the page;
 *   2. the install surface is real: the manifest is served, parses and carries
 *      every field a browser needs to offer "Install app", its declared icons
 *      exist in the bundle at the size they claim, the shipped index.html links
 *      it, and the shipped app code registers sw.js at a scope covering the app;
 *   3. offline: after one online session with the packs imported, the loopback
 *      server is stopped and the app still opens and still renders revealed text
 *      — from the service worker's cache, with the port provably refusing;
 *   4. zero runtime network to the internet: every request the page made is
 *      same-origin loopback (lib/netgate.mjs is the single definition of that).
 *
 * Reuse is deliberate: `lib/launch.mjs` starts the server and the browser on a
 * profile directory this run created, `lib/cdp.mjs` is the only driver,
 * `lib/netgate.mjs` is the only origin policy, `lib/harness.mjs` is the only
 * report format. Nothing in those files is edited by this script, and nothing
 * here invents a second way to classify a URL.
 *
 * Usage:
 *   node tests/e2e/pwa.mjs                       # packaged bundle, fresh profile
 *   node tests/e2e/pwa.mjs --package=<dir>       # a specific quran-web-* folder
 *   node tests/e2e/pwa.mjs --observe-only        # watch requests instead of refusing them
 *   node tests/e2e/pwa.mjs --keep-run            # leave the %TEMP% run directory
 *   node tests/e2e/pwa.mjs --browser=<msedge>    # a specific browser binary
 *
 * Importing the shipped server question, answered honestly: the run starts the
 * server through `lib/launch.mjs`, which points at `desktop/scripts/serveWeb.mjs`
 * with `--dist` set to the bundle. That is only equivalent to `bin/serveWeb.mjs`
 * if the two files are the same bytes, so a first step compares them (and the
 * path rule they import) and refuses the run when they are not.
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';

import { Cdp } from './lib/cdp.mjs';
import { AssertionError, Suite, is, ok } from './lib/harness.mjs';
import { findEdge, killTree, launchBrowser, launchWebServer, waitForHttp } from './lib/launch.mjs';
import { makeLocalClassifier, offenders, originBuckets } from './lib/netgate.mjs';
import { PackSource } from './lib/packs.mjs';
import { createRunRoot } from './lib/profile.mjs';
import { makeStore } from './lib/store.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function arg(name, fallback = null) {
  const flag = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(flag));
  return hit ? hit.slice(flag.length) : fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

/** Bind and release a loopback port; the preferred one when it is free. */
async function listenOnce(port) {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen({ port, host: '127.0.0.1' }, () => {
      const got = srv.address().port;
      srv.close(() => resolve(got));
    });
  });
}

/** A debug port for THIS run only: 9901..9940, never the orchestrator's. */
async function pickCdpPort() {
  for (let candidate = 9901; candidate <= 9940; candidate += 1) {
    try {
      return await listenOnce(candidate);
    } catch {
      /* taken — try the next one */
    }
  }
  throw new Error('no free CDP port in 9901..9940 — another run of this suite holds them all');
}

async function pickWebPort() {
  for (const candidate of [8231, 0]) {
    try {
      return await listenOnce(candidate);
    } catch {
      /* taken — 0 asks the OS for anything free */
    }
  }
  throw new Error('no free loopback port for the web server');
}

/** Locate the packaged bundle: `--package=…`, else the versioned folder. */
function findBundle(explicit) {
  const webRoot = path.join(REPO_ROOT, 'desktop', 'release', 'web');
  if (explicit) {
    const dir = path.resolve(REPO_ROOT, explicit);
    if (!existsSync(path.join(dir, 'dist', 'index.html'))) throw new Error(`--package=${dir} has no dist/index.html`);
    return dir;
  }
  if (!existsSync(webRoot)) throw new Error(`no ${webRoot} — run \`node desktop/scripts/packageWeb.mjs --zip\``);
  const dirs = readdirSync(webRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^quran-web(-\d.*)?$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const version = JSON.parse(readFileSync(path.join(REPO_ROOT, 'desktop', 'package.json'), 'utf8')).version;
  const chosen = dirs.includes(`quran-web-${version}`) ? `quran-web-${version}` : dirs.at(-1);
  if (!chosen) throw new Error(`no quran-web-* folder under ${webRoot} — run \`node desktop/scripts/packageWeb.mjs --zip\``);
  return path.join(webRoot, chosen);
}

/** PNG width/height from IHDR: never trust a manifest's `sizes` at face value. */
function pngSize(file) {
  const bytes = readFileSync(file);
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  if (bytes.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes: bytes.length };
}

function dirBytes(dir) {
  let total = 0;
  let files = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = dirBytes(abs);
      total += inner.bytes;
      files += inner.files;
    } else {
      total += statSync(abs).size;
      files += 1;
    }
  }
  return { bytes: total, files };
}

/* --------------------------------------------------------------- page probes */

/** Everything the registration knows, taken from the live page. */
const SW_INFO = `(async function(){
  const reg = await navigator.serviceWorker.ready;
  const worker = (w) => (w ? { scriptURL: w.scriptURL, state: w.state } : null);
  return JSON.stringify({
    scope: reg.scope,
    active: worker(reg.active),
    waiting: worker(reg.waiting),
    installing: worker(reg.installing),
    controller: worker(navigator.serviceWorker.controller),
    updateViaCache: reg.updateViaCache ?? null,
  });
})()`;

/** A normal reload stays on the SW path; this says whether it really did. */
const SW_CONTROL = `(function(){
  const c = navigator.serviceWorker.controller;
  return JSON.stringify({ controlled: !!c, scriptURL: c ? c.scriptURL : null, state: navigator.serviceWorker.state });
})()`;

/** The Cache Storage the worker actually filled, as path names. */
const CACHE_DUMP = `(async function(){
  const keys = await caches.keys();
  const out = {};
  for (const key of keys) {
    const cache = await caches.open(key);
    const reqs = await cache.keys();
    out[key] = reqs.map((r) => new URL(r.url).pathname);
  }
  return JSON.stringify(out);
})()`;

/** URLs the page itself asked for, independent of anything CDP recorded. */
const PAGE_URLS = `(function(){
  const out = [];
  for (const e of performance.getEntriesByType('resource')) out.push(e.name);
  for (const e of performance.getEntriesByType('navigation')) out.push(e.name);
  return JSON.stringify(out);
})()`;

const LOADING = `!!document.querySelector('.state--loading')`;
const hasButton = (regexSource) =>
  `(function(){const re=new RegExp(${JSON.stringify(regexSource)});return Array.from(document.querySelectorAll('button, a.linkbtn')).some((b)=>re.test((b.textContent||'').trim())||re.test(b.title||''));})()`;
const ERROR_STATE = `(function(){return document.querySelectorAll('.state--error,[role=alert]').length;})()`;

/* ------------------------------------------------------------------- helpers */

async function httpProbe(url, { timeoutMs = 5_000 } = {}) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = res.status < 400 ? await res.text() : '';
    return { ok: true, status: res.status, type: res.headers.get('content-type') ?? '', bytes: Buffer.byteLength(body), body };
  } catch (error) {
    const code = error?.cause?.code ?? error?.name ?? 'unknown';
    return { ok: false, status: 0, type: '', bytes: 0, body: '', error: String(code) };
  }
}

/** Snapshot of the counters an assertion compares against later. */
const snapshot = (cdp) => ({
  requests: cdp.requests.length,
  blocked: cdp.blocked.length,
  failures: cdp.loadingFailures.length,
  exceptions: cdp.exceptions.length,
  consoleErrors: cdp.consoleErrors.length,
});

/* ---------------------------------------------------------------------- main */

async function main() {
  const log = (line) => process.stdout.write(`${line}\n`);
  const suite = new Suite({ title: 'PWA install / offline (packaged web bundle)' });
  const results = [];

  const bundleDir = findBundle(arg('package'));
  const bundleRoot = path.join(bundleDir, 'dist');
  const pkgDir = path.join(bundleDir, 'dist', 'content');
  const observeOnly = hasFlag('observe-only');

  const runRoot = createRunRoot('quran-pwa');
  const owned = new Set();
  const children = [];
  let cdp = null;
  /** Every CDP driver this run attached to, so the request gate sees them all. */
  const drivers = [];
  let server = null;
  let browser = null;
  let webPort = null;
  let cleanupNote = '';

  /** One recorded check, so the summary line and the table can never disagree. */
  async function check(id, title, level, fn, extra = {}) {
    await suite.step(`${id}. ${title}`, level, fn, extra);
    const row = suite.rows.at(-1);
    results.push({ id, title, status: row ? row.status : 'ERROR', detail: row ? row.detail : 'step recorded nothing' });
  }

  try {
    /* ---------------------------------------------------- the artifact itself */

    let bundleStat = null;
    await suite.step('the packaged bundle is the artifact this run measures', 'pipeline', async () => {
      const required = ['index.html', 'sw.js', 'manifest.webmanifest', 'content/index.json', 'icons/pwa-192.png'];
      const missing = required.filter((rel) => !existsSync(path.join(bundleRoot, rel)));
      ok(missing.length === 0, 'the bundle holds the app shell, worker, manifest and content', { missing });
      bundleStat = dirBytes(bundleRoot);
      const launchers = ['start.cmd', 'start.command', 'start.sh'].filter((f) => existsSync(path.join(bundleDir, f)));
      ok(launchers.length === 3, 'the bundle carries all three platform launchers', { found: launchers });
      return `${bundleRoot} — ${bundleStat.files} files, ${(bundleStat.bytes / 1024 / 1024).toFixed(1)} MiB; launchers ${launchers.join(', ')}`;
    }, { fatal: true });

    await suite.step('the server the launcher runs is the server this run starts', 'pipeline', async () => {
      const pairs = [
        [path.join(bundleDir, 'bin', 'serveWeb.mjs'), path.join(REPO_ROOT, 'desktop', 'scripts', 'serveWeb.mjs')],
        [path.join(bundleDir, 'dev', 'contentMiddleware.mjs'), path.join(REPO_ROOT, 'desktop', 'dev', 'contentMiddleware.mjs')],
      ];
      for (const [shipped, repo] of pairs) {
        ok(existsSync(shipped), `the bundle ships ${path.basename(shipped)}`, shipped);
        const a = readFileSync(shipped);
        const b = readFileSync(repo);
        ok(a.equals(b), `${path.basename(shipped)} in the bundle is byte-identical to the one lib/launch.mjs starts`, {
          expected: `${b.length} bytes`,
          actual: `${a.length} bytes${a.length === b.length ? ' (content differs)' : ''}`,
        });
      }
      return 'bin/serveWeb.mjs ≡ desktop/scripts/serveWeb.mjs, so serving the bundle through lib is the shipped path';
    }, { fatal: true });

    /* ------------------------------------------- the artifact, offline by itself */

    await suite.step('every reference inside the bundle resolves to a file in the bundle', 'pipeline', async () => {
      const html = readFileSync(path.join(bundleRoot, 'index.html'), 'utf8');
      const htmlRefs = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
        .map((m) => m[1])
        .filter((u) => !u.startsWith('#'));
      const offsite = htmlRefs.filter((u) => /^[a-z]+:\/\//i.test(u) && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(u));
      ok(offsite.length === 0, 'index.html asks for nothing outside this machine', offsite);
      const htmlMissing = htmlRefs
        .filter((u) => !/^[a-z]+:\/\//i.test(u))
        .filter((u) => !existsSync(path.join(bundleRoot, ...u.replace(/^\.\//, '').replace(/^\//, '').split('/'))));
      ok(htmlMissing.length === 0, 'every href/src in the shipped index.html is a file in the bundle', htmlMissing);

      const cssDir = path.join(bundleRoot, 'assets');
      const cssFiles = readdirSync(cssDir).filter((f) => f.endsWith('.css'));
      const cssUrls = new Set();
      for (const f of cssFiles) {
        for (const m of readFileSync(path.join(cssDir, f), 'utf8').matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) cssUrls.add(m[1]);
      }
      const cssOffsite = [...cssUrls].filter((u) => /^(https?|data|blob):/i.test(u) && !/^data:/i.test(u));
      ok(cssOffsite.length === 0, 'no stylesheet reaches out to a font CDN', cssOffsite);
      const cssMissing = [...cssUrls].filter((u) => !existsSync(path.normalize(path.join(cssDir, u))));
      ok(cssMissing.length === 0, 'every @font-face url resolves inside the bundle', cssMissing);

      const chunks = new Set();
      for (const f of readdirSync(cssDir).filter((x) => x.endsWith('.js'))) {
        for (const m of readFileSync(path.join(cssDir, f), 'utf8').matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) chunks.add(m[1]);
      }
      const chunkMissing = [...chunks].filter((u) => !existsSync(path.normalize(path.join(cssDir, u))));
      ok(chunkMissing.length === 0, 'every dynamic import target ships too', chunkMissing);

      const identical = (a, b) => readFileSync(a).equals(readFileSync(b));
      ok(identical(path.join(bundleRoot, 'sw.js'), path.join(REPO_ROOT, 'desktop', 'public', 'sw.js')), 'the worker in the bundle is the one in desktop/public', null);
      ok(identical(path.join(bundleRoot, 'manifest.webmanifest'), path.join(REPO_ROOT, 'desktop', 'public', 'manifest.webmanifest')), 'the manifest in the bundle is the one in desktop/public', null);
      ok(
        identical(path.join(bundleRoot, 'content', 'index.json'), path.join(REPO_ROOT, 'content', 'index.json')),
        'the bundle’s content index is the index the content build produced',
        { bundle: path.join(bundleRoot, 'content', 'index.json'), repo: path.join(REPO_ROOT, 'content', 'index.json') },
      );

      return `${htmlRefs.length} html refs, ${cssFiles.length} css with ${cssUrls.size} url() targets, ${chunks.size} dynamic chunks — 0 offsite, 0 missing; sw.js + manifest + content/index.json byte-identical to their sources`;
    }, { fatal: true });

    let launcher = null;
    let launcherPort = null;
    await suite.step('the launcher the user double-clicks serves the bundle by itself', 'device', async () => {
      launcherPort = await listenOnce(8232).catch(() => listenOnce(0));
      const spec =
        process.platform === 'win32'
          ? { cmd: 'cmd.exe', args: ['/d', '/c', 'start.cmd', `--port=${launcherPort}`, '--host=127.0.0.1'] }
          : { cmd: 'sh', args: ['./start.sh', `--port=${launcherPort}`, '--host=127.0.0.1'] };
      launcher = spawn(spec.cmd, spec.args, {
        cwd: bundleDir,
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
      });
      owned.add(launcher.pid);
      children.push(launcher);
      await waitForHttp(`http://127.0.0.1:${launcherPort}/`, { label: `${path.basename(spec.cmd)} ${spec.args[2] ?? ''}` });
      const page = await httpProbe(`http://127.0.0.1:${launcherPort}/index.html`);
      const worker = await httpProbe(`http://127.0.0.1:${launcherPort}/sw.js`);
      const manifest = await httpProbe(`http://127.0.0.1:${launcherPort}/manifest.webmanifest`);
      const pack = await httpProbe(`http://127.0.0.1:${launcherPort}/content/index.json`);
      for (const [label, probe] of [['index.html', page], ['sw.js', worker], ['manifest.webmanifest', manifest], ['content/index.json', pack]]) {
        ok(probe.ok && probe.status === 200, `the launcher answers ${label}`, probe);
      }
      ok(/javascript/.test(worker.type) && /manifest\+json/.test(manifest.type), 'with the media types a service worker and a manifest need', {
        sw: worker.type,
        manifest: manifest.type,
      });
      ok(killTree(launcher, { owned }), 'the launcher process this step started is stopped again', launcher.pid);
      await sleep(800);
      const gone = await httpProbe(`http://127.0.0.1:${launcherPort}/`);
      ok(!gone.ok, 'and its port stops answering', gone);
      return `${path.join(bundleDir, process.platform === 'win32' ? 'start.cmd' : 'start.sh')} → pid ${launcher.pid} served index.html ${page.bytes} B, sw.js ${worker.bytes} B (${worker.type}), manifest ${manifest.bytes} B (${manifest.type}), content/index.json ${pack.bytes} B on port ${launcherPort}; then stopped (${gone.error})`;
    }, { fatal: true });

    /* ------------------------------------------------------- server + browser */

    let url = null;
    await suite.step('the packaged bundle is served on a loopback port only', 'device', async () => {
      webPort = await pickWebPort();
      server = launchWebServer({ repoRoot: REPO_ROOT, port: webPort, dist: bundleRoot });
      owned.add(server.pid);
      children.push(server);
      await waitForHttp(`http://127.0.0.1:${webPort}/`, { label: 'the packaged bundle' });
      const probe = await httpProbe(`http://127.0.0.1:${webPort}/index.html`);
      ok(probe.ok && probe.status === 200, 'GET / answers 200 from the bundle', probe);
      url = `http://127.0.0.1:${webPort}/`;
      return `${url} → ${bundleRoot} (${probe.bytes} bytes of index.html)`;
    }, { fatal: true });

    const cdpPort = await pickCdpPort();
    await suite.step('a browser profile this run owns opens it over CDP', 'device', async () => {
      const profileDir = path.join(runRoot.root, 'browser');
      browser = launchBrowser({ url, port: cdpPort, userDataDir: profileDir, browser: arg('browser') ? arg('browser') : findEdge() });
      owned.add(browser.pid);
      children.push(browser);
      await waitForHttp(`http://127.0.0.1:${cdpPort}/json/list`, { label: 'the CDP endpoint', timeoutMs: 60_000 });
      cdp = await Cdp.attach({ port: cdpPort, urlMatch: (target) => target.includes(`127.0.0.1:${webPort}`), name: 'pwa' });
      drivers.push(cdp);
      cdp.setLocalTest(makeLocalClassifier({ webOrigin: `http://127.0.0.1:${webPort}` }));
      await cdp.startCapture({ intercept: !observeOnly });
      // Chromium commits an empty stub document at the target URL first, so a
      // single immediate read can legitimately see no title: wait for the commit.
      await cdp.waitFor(`!!document.title && !!document.querySelector('#root')`, {
        timeoutMs: 60_000,
        label: 'the packaged page to be committed',
      });
      const title = await cdp.evaluate('document.title');
      ok(typeof title === 'string' && title.length > 0, 'the page has a title', title);
      return `CDP on ${cdpPort}, profile ${profileDir}, title “${title}”`;
    }, { fatal: true });

    const isLocal = makeLocalClassifier({ webOrigin: `http://127.0.0.1:${webPort}` });
    const pageUrlLog = [];
    const collectPageUrls = async (label) => {
      const raw = await cdp.evaluate(PAGE_URLS);
      const list = JSON.parse(String(raw));
      pageUrlLog.push({ label, urls: list });
      return list;
    };

    await suite.step('the shipped shell renders before any of this is asserted', 'device', async () => {
      await cdp.waitFor(`!!document.querySelector('#root > *')`, { timeoutMs: 45_000, label: 'the React shell to mount' });
      const early = await cdp.bodyText(200);
      // The web shell imports its corpus during `ready()`, so the first paint can
      // legitimately be an “opening” state. Measure how long that lasts and fail
      // only if the screen stays broken — a permanent error here is a product bug.
      const t0 = Date.now();
      let cleared = true;
      try {
        await cdp.waitFor(`document.querySelectorAll('.state--error,[role=alert]').length === 0 && document.body.innerText.replace(/\\s+/g,' ').length > 40`, {
          timeoutMs: 240_000,
          intervalMs: 1_000,
          label: 'the boot state to give way to the app',
        });
      } catch {
        cleared = false;
      }
      const text = await cdp.bodyText(240);
      const errors = await cdp.evaluate(ERROR_STATE);
      ok(cleared, 'the app reaches a working screen after the first load', { ms: Date.now() - t0, errors, text: text.slice(0, 160) });
      is(Number(errors), 0, 'no error/alert state once the app has booted', errors);
      return `mounted; boot state settled after ${Date.now() - t0} ms; first 60 chars: ${text.slice(0, 60)}${early ? '' : ' (empty!)'}`;
    }, { fatal: true });

    /* ------------------------------------------------------------- CHECK 1 — */

    let reg = null;
    let cacheAfterWarm = null;
    await check('CHECK 1', 'service worker registers, activates and controls the page', 'device', async () => {
      await cdp.waitFor(`!!(navigator.serviceWorker && navigator.serviceWorker.controller)`, {
        timeoutMs: 45_000,
        label: 'the page to come under the worker’s control',
      });
      reg = JSON.parse(String(await cdp.evaluate(SW_INFO)));

      ok(reg.active, 'the registration has an ACTIVE worker (not an install/update pending one)', reg);
      is(reg.installing, null, 'no worker still installing');
      is(reg.waiting, null, 'no worker parked as update-only — this registration is the live one');
      const origin = `http://127.0.0.1:${webPort}`;
      is(reg.active.scriptURL, `${origin}/sw.js`, 'the active worker is the bundle’s own sw.js');
      is(reg.scope, `${origin}/`, 'the registration scope is the app root');
      ok(url.startsWith(reg.scope), 'the scope covers the URL the app is opened at', { scope: reg.scope, url });
      is(reg.controller.scriptURL, `${origin}/sw.js`, 'navigator.serviceWorker.controller is that worker');
      suite.note('updateViaCache', 'device', String(reg.updateViaCache));

      // A reload under the worker proves control on a fresh navigation, not just
      // after clients.claim(). ignoreCache stays FALSE: a hard reload would
      // bypass the worker and prove nothing.
      await cdp.reload({ ignoreCache: false });
      const control = JSON.parse(String(await cdp.evaluate(SW_CONTROL)));
      is(control.controlled, true, 'after a normal reload the page is still served under the worker’s control', control);
      is(control.scriptURL, `${origin}/sw.js`, 'the controlling worker after reload', control);
      await cdp.waitFor(`!!document.querySelector('#root > *')`, { timeoutMs: 45_000, label: 'the shell after the controlled reload' });
      await collectPageUrls('after controlled reload');

      return `active=${reg.active.scriptURL} scope=${reg.scope} installing=null waiting=null controller=after-reload ${control.scriptURL} updateViaCache=${reg.updateViaCache}`;
    }, { fatal: true });

    /* ------------------------------------------------------------- CHECK 2 — */

    await check('CHECK 2', 'the install surface is real: manifest, icons, index.html, registration', 'device', async () => {
      const manifestUrl = `${`http://127.0.0.1:${webPort}`}/manifest.webmanifest`;
      const fetched = await httpProbe(manifestUrl);
      ok(fetched.ok && fetched.status === 200, 'the packaged manifest is served over the loopback port', fetched);
      ok(/application\/manifest\+json/.test(fetched.type), 'it is served as a manifest, not as text', fetched.type);
      let manifest = null;
      try {
        manifest = JSON.parse(fetched.body);
      } catch (error) {
        throw new AssertionError('manifest.webmanifest parses as JSON', { expected: 'valid JSON', actual: String(error) });
      }
      const need = ['name', 'short_name', 'start_url', 'display', 'scope', 'theme_color', 'background_color', 'icons'];
      const absent = need.filter((key) => manifest[key] === undefined || manifest[key] === null || manifest[key] === '');
      ok(absent.length === 0, 'the manifest carries every field an install prompt needs', { absent });
      is(manifest.display, 'standalone', 'display is standalone (an installed window, not a browser tab)');
      ok(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'at least one icon is declared', manifest.icons);

      const origin = `http://127.0.0.1:${webPort}`;
      for (const key of ['start_url', 'scope']) {
        const resolved = new URL(manifest[key], `${origin}/`).href;
        ok(resolved.startsWith(`${origin}/`), `${key} resolves inside the loopback origin`, { resolved });
      }
      const scopeUrl = new URL(manifest.scope, `${origin}/`).href;
      const regScope = new URL(reg.scope).href;
      ok(scopeUrl === regScope || regScope.startsWith(scopeUrl), 'the manifest scope and the worker scope agree, so a window opened from the manifest is controlled', {
        manifestScope: scopeUrl,
        workerScope: regScope,
      });

      const icons = manifest.icons.map((icon) => {
        const rel = icon.src.replace(/^\.\//, '').replace(/^\//, '');
        const abs = path.join(bundleRoot, ...rel.split('/'));
        ok(existsSync(abs), `the declared icon ${icon.src} is a file in the bundle`, abs);
        const dims = pngSize(abs);
        ok(dims, `the icon decodes as a PNG`, abs);
        const [w, h] = String(icon.sizes).toLowerCase().split('x').map(Number);
        ok(dims.width === w && dims.height === h, `the icon is really ${icon.sizes}`, {
          expected: `${w}x${h}`,
          actual: `${dims.width}x${dims.height} (${dims.bytes} bytes)`,
        });
        return `${rel} ${dims.width}x${dims.height} ${(dims.bytes / 1024).toFixed(0)} KiB`;
      });

      const html = readFileSync(path.join(bundleRoot, 'index.html'), 'utf8');
      ok(/<link[^>]+rel=["']manifest["'][^>]*>/.test(html), 'the shipped index.html links the manifest', html.slice(0, 200));
      const href = html.match(/<link[^>]+rel=["']manifest["'][^>]+href=["']([^"']+)["']/)?.[1];
      ok(href && existsSync(path.join(bundleRoot, ...href.replace(/^\.\//, '').replace(/^\//, '').split('/'))), 'that href resolves to a file in the bundle', href);

      const appAsset = html.match(/<script[^>]+src=["']([^"']*assets\/[^"']+\.js)["']/)?.[1];
      ok(appAsset, 'index.html loads a hashed module', appAsset);
      const appPath = path.join(bundleRoot, ...appAsset.replace(/^\.\//, '').split('/'));
      ok(existsSync(appPath), 'that module exists in the bundle', appPath);
      const appJs = readFileSync(appPath, 'utf8');
      ok(/serviceWorker/.test(appJs) && /register\(["']sw\.js["']/.test(appJs), 'the shipped production bundle registers sw.js', appAsset);
      const scopeMatch = appJs.match(/register\(["']sw\.js["'],\{scope:["']([^"']+)["']\}\)/);
      ok(scopeMatch, 'the registration states its scope', appJs.slice(Math.max(0, appJs.indexOf('serviceWorker.register') - 40), appJs.indexOf('serviceWorker.register') + 120));
      const scopeValue = new URL(scopeMatch[1], `${origin}/`).href;
      ok(scopeValue === regScope, 'that scope is the scope the live registration got', { declared: scopeValue, live: regScope });

      const served = await httpProbe(`${origin}/sw.js`);
      ok(served.ok && served.status === 200 && /javascript/.test(served.type), 'sw.js is served as a script at /sw.js', { status: served.status, type: served.type, bytes: served.bytes });

      return `manifest ${fetched.bytes} B ${fetched.type} · display=${manifest.display} start_url=${manifest.start_url} scope=${manifest.scope} theme=${manifest.theme_color}/${manifest.background_color} · icons: ${icons.join(', ')} · <link rel=manifest href=${href}> · bundle registers sw.js scope “${scopeMatch[1]}” → ${scopeValue} == live scope; sw.js ${served.bytes} B`;
    }, { fatal: true });

    /* ------------------------------------------ warm the cache the real way */

    const packs = new PackSource(pkgDir);
    const store = makeStore({ shell: 'browser', cdp });

    await suite.step('one online session imports the bundled packs (this fills the caches)', 'device', async () => {
      await cdp.go('/');
      if (await cdp.evaluate(hasButton('وارد کردن بسته‌های محتوا|Import content packs'))) {
        await cdp.clickText('وارد کردن بسته‌های محتوا|Import content packs');
      }
      const t0 = Date.now();
      let report = null;
      while (Date.now() - t0 < 600_000) {
        report = await store.importReport().catch(() => null);
        if (report) break;
        await sleep(1_000);
      }
      ok(report, 'the app stored its own ImportReport', { waitedMs: Date.now() - t0 });
      is(report.status, 'success', 'the import succeeded');
      is(report.packs.length, packs.expect.packRows, 'every pack in the bundle’s index.json was applied');

      await cdp.go('/quran');
      await cdp.waitFor(`!${LOADING}`, { timeoutMs: 60_000, label: 'the surah index' });
      await cdp.go('/quran/surah/112');
      await cdp.waitFor(`!!document.querySelector('article.ayah')`, { timeoutMs: 60_000, label: 'the reader' });
      await cdp.waitFor(`!${LOADING}`, { timeoutMs: 60_000, label: 'the reader to settle' });
      const rows = await cdp.count('article.ayah');
      is(rows, packs.surahAyahKeys(112).length, 'surah 112 renders every ayah in the bundle');
      await cdp.go('/me/content');
      await cdp.waitFor(`!${LOADING}`, { timeoutMs: 60_000, label: 'the data health screen' });
      await collectPageUrls('after online warm-up');

      cacheAfterWarm = JSON.parse(String(await cdp.evaluate(CACHE_DUMP)));
      const names = Object.keys(cacheAfterWarm);
      let total = names.reduce((sum, k) => sum + cacheAfterWarm[k].length, 0);
      ok(total > 0, 'the worker cache holds entries after one session', names);
      const allPaths = Object.values(cacheAfterWarm).flat();

      // The offline claim only holds if the WHOLE corpus is in the cache, not
      // just the packs the user happened to look at. Which files that is comes
      // from the bundle’s own index.json, never from a list typed in here.
      const needed = packs.packs.map((pack) => `/content/${pack.id}/payload.jsonl`);
      const t1 = Date.now();
      let missing = needed.filter((p) => !allPaths.includes(p));
      while (missing.length && Date.now() - t1 < 180_000) {
        await sleep(2_000);
        const again = JSON.parse(String(await cdp.evaluate(CACHE_DUMP)));
        const pathsAgain = Object.values(again).flat();
        missing = needed.filter((p) => !pathsAgain.includes(p));
        if (pathsAgain.length >= allPaths.length) {
          Object.assign(cacheAfterWarm, again);
          allPaths.length = 0;
          allPaths.push(...pathsAgain);
          total = pathsAgain.length;
        }
      }
      ok(missing.length === 0, 'every pack payload the bundle ships is in the worker cache after one session', {
        needed: needed.length,
        missing,
      });
      suite.note(
        'worker cache contents after the online session',
        'device',
        `${names.join(', ')} = ${total} entries, of which ${allPaths.filter((p) => p.startsWith('/content/')).length} are /content/* and ${allPaths.filter((p) => p.startsWith('/assets/')).length} are /assets/*`,
      );
      return `import “${report.status}” over ${((Date.now() - t0) / 1000).toFixed(1)} s with ${report.packs.length}/${packs.expect.packRows} packs · ${rows} ayah rows in 112 · caches ${names.join(', ')} hold ${total} entries, all ${needed.length} pack payloads cached (waited ${((Date.now() - t1) / 1000).toFixed(1)} s for the last one)`;
    }, { fatal: true });

    /* ------------------------------------------------------------- CHECK 3 — */

    let offlineConsoleErrors = [];
    await check('CHECK 3', 'offline: the server is stopped and the app still opens and renders', 'device', async () => {
      const origin = `http://127.0.0.1:${webPort}`;
      const cacheBefore = JSON.parse(String(await cdp.evaluate(CACHE_DUMP)));
      const entryCount = Object.values(cacheBefore).reduce((sum, list) => sum + list.length, 0);
      const paths = Object.values(cacheBefore).flat();
      const has = (needle) => paths.filter((p) => p.includes(needle)).length;

      // Stop the server this run started, then prove the port is dead: without
      // that, "it still works offline" could just mean "it asked the server again".
      ok(killTree(server, { owned }), 'the loopback server this run started is stopped', 'killTree refused or the PID was unknown');
      await sleep(1_500);
      const probe = await httpProbe(`${origin}/index.html`);
      ok(!probe.ok, 'the port now refuses connections — the server is really gone', probe);
      suite.note('server gone', 'device', `GET ${origin}/index.html failed with ${probe.error}`);

      const navStart = snapshot(cdp);
      await cdp.reload({ ignoreCache: false });

      await cdp.waitFor(`!!document.querySelector('#root > *')`, { timeoutMs: 60_000, label: 'the app to render with no server' });
      const still = await cdp.evaluate(`(function(){return JSON.stringify({href: location.href, title: document.title, ready: document.readyState, children: document.querySelectorAll('#root > *').length, text: document.body.innerText.replace(/\\s+/g,' ').length, errors: document.querySelectorAll('.state--error,[role=alert]').length});})()`);
      const dom = JSON.parse(String(still));
      // The router is hash based, so the hash may carry the last screen: what has
      // to hold is the origin and the path — the bundle itself, on a dead port.
      const landed = new URL(dom.href);
      is(landed.origin, origin, 'the offline page is still this bundle’s origin', dom.href);
      is(landed.pathname, '/', 'and still the bundle’s index.html, not an error page', dom.href);
      ok(dom.children > 0 && dom.ready === 'complete', 'the shell mounted from cache, so this is not a blank screen', dom);
      ok(dom.text > 100, 'there is real text on screen', dom);
      const control = JSON.parse(String(await cdp.evaluate(SW_CONTROL)));
      is(control.controlled, true, 'the offline page is served by the worker', control);

      // Same rule as the online boot: the web shell re-imports its corpus during
      // ready(), and offline that import has to come out of the worker cache.
      // Give it the same chance the online first load was given, then require the
      // app to be error-free.
      const settleT0 = Date.now();
      let offlineCleared = true;
      try {
        await cdp.waitFor(`document.querySelectorAll('.state--error,[role=alert]').length === 0 && document.body.innerText.replace(/\\s+/g,' ').length > 40`, {
          timeoutMs: 240_000,
          intervalMs: 1_000,
          label: 'the offline boot state to give way to the app',
        });
      } catch {
        offlineCleared = false;
      }
      const offlineErrors = Number(await cdp.evaluate(ERROR_STATE));
      suite.note('offline settle', 'device', `${Date.now() - settleT0} ms until the offline screen stopped reporting an error; error/alert elements now ${offlineErrors}`);
      ok(offlineCleared, 'the app reaches a working screen with no server at all', { ms: Date.now() - settleT0, errors: offlineErrors, text: (await cdp.bodyText(200)).slice(0, 160) });
      is(offlineErrors, 0, 'no error/alert state after the offline load', offlineErrors);

      // The web shell re-reads its corpus from its own origin on every load
      // (devGateway.autoImport), so an offline start has to answer those
      // /content/* reads from the worker cache. Ask the app what it managed to
      // import with no server, rather than inferring it from the screen.
      let offlineReport = null;
      const reportDeadline = Date.now() + 120_000;
      while (Date.now() < reportDeadline) {
        offlineReport = await store.importReport().catch(() => null);
        if (offlineReport && offlineReport.status === 'success') break;
        await sleep(1_000);
      }
      suite.note('offline import report', 'database', offlineReport ? JSON.stringify(offlineReport).slice(0, 400) : 'no ImportReport readable after the offline load');
      is(offlineReport && offlineReport.status, 'success', 'the app re-imported its whole corpus with no server, from the worker cache', offlineReport);
      is(offlineReport.packs.length, packs.expect.packRows, 'every pack the bundle ships was applied on the offline load', offlineReport.packs.map((pack) => pack.id ?? pack));

      await cdp.go('/quran/surah/112');
      await cdp.waitFor(`!!document.querySelector('article.ayah')`, { timeoutMs: 90_000, label: 'revealed text to render offline' });
      await cdp.waitFor(`!${LOADING}`, { timeoutMs: 30_000, label: 'the offline reader to settle' });
      const keys = packs.surahAyahKeys(112);
      const rows = await cdp.count('article.ayah');
      is(rows, keys.length, `surah 112 still renders its ${keys.length} ayat with no server (offline import status: ${offlineReport?.status ?? 'unknown'})`);
      const firstKey = await cdp.evaluate(`(function(){const a=document.querySelector('article.ayah');return a?a.getAttribute('data-verse-key'):null;})()`);
      is(firstKey, keys[0], 'the first offline row is the first ayah, keyed');
      const arabic = await cdp.evaluate(`(function(){const a=document.querySelector('article.ayah .arabic, article.ayah [dir="rtl"], article.ayah');return a?a.textContent.replace(/\\s+/g,' ').trim().slice(0,80):null;})()`);
      ok(typeof arabic === 'string' && arabic.length > 10, 'the ayah text itself came through', arabic);

      await cdp.go('/me/content');
      await cdp.waitFor(`!${LOADING}`, { timeoutMs: 45_000, label: 'the data health screen offline' });
      const healthErrors = Number(await cdp.evaluate(ERROR_STATE));
      is(healthErrors, 0, 'the data health screen shows no error state offline', healthErrors);

      const urls = await collectPageUrls('offline reload + screens');
      const badOnPage = urls.filter((u) => !isLocal(u));
      ok(badOnPage.length === 0, 'every URL the offline page asked for was loopback', badOnPage.slice(0, 5));

      const newExceptions = cdp.exceptions.slice(navStart.exceptions);
      is(newExceptions.length, 0, 'no page exception during the offline load', newExceptions.slice(0, 3));
      const rawConsole = cdp.consoleErrors.slice(navStart.consoleErrors);
      // The navigation is network-first by design, so the ONE expected failure is
      // the refused request to our own dead loopback port. Anything else is a bug.
      const expectedRefusal = /ERR_CONNECTION_REFUSED|ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|Failed to fetch|net::ERR/i;
      offlineConsoleErrors = rawConsole.filter((line) => !expectedRefusal.test(line) && !/127\.0\.0\.1/i.test(line));
      suite.note('offline console', 'device', `${rawConsole.length} console error line(s) during the offline load; ${offlineConsoleErrors.length} not explained by the intentional refused navigation${offlineConsoleErrors.length ? `: ${offlineConsoleErrors.slice(0, 3).join(' | ')}` : ''}`);
      is(offlineConsoleErrors.length, 0, 'no console error beyond the intentional network-first miss', offlineConsoleErrors.slice(0, 3));
      suite.note('offline request counts', 'device', `page resources observed during the offline window=${urls.length}; CDP request events so far=${cdp.requests.length} (was ${navStart.requests} before the reload); loadingFailures +${cdp.loadingFailures - navStart.failures}`);

      const cacheAfter = JSON.parse(String(await cdp.evaluate(CACHE_DUMP)));
      const afterCount = Object.values(cacheAfter).reduce((sum, list) => sum + list.length, 0);
      ok(afterCount >= entryCount, 'the cache did not lose entries across the offline load', { before: entryCount, after: afterCount });

      return `port ${webPort} refused (${probe.error}) yet the page reloaded under ${control.scriptURL}: ${rows}/${keys.length} ayah rows, first ${firstKey}, ${dom.text} chars of text, 0 error states · cache ${afterCount} entries (${has('/assets/')} assets, ${has('/content/')} content, ${has('index.html')} html)`;
    }, { fatal: true });

    /* ------------------------------------------- CHECK 3b — cold start, dead port */

    await check('CHECK 3b', 'cold start: the browser is restarted and the app opens with the server still stopped', 'device', async () => {
      // A reload under a live worker proves the cache answers. What a user of an
      // installed app actually does is close the window, keep the local server
      // switched off, and open the app again — so the browser process has to die
      // and come back, and the worker has to be found on disk in the profile.
      ok(killTree(browser, { owned }), 'the browser this run started is closed', browser.pid);
      await sleep(2_500);
      const gone = await httpProbe(`http://127.0.0.1:${webPort}/`);
      ok(!gone.ok, 'and the server is still gone when it comes back', gone);

      browser = launchBrowser({
        url: `http://127.0.0.1:${webPort}/`,
        port: cdpPort,
        userDataDir: path.join(runRoot.root, 'browser'),
        browser: arg('browser') ? arg('browser') : findEdge(),
      });
      owned.add(browser.pid);
      children.push(browser);
      await waitForHttp(`http://127.0.0.1:${cdpPort}/json/list`, { label: 'the CDP endpoint after the cold start', timeoutMs: 90_000 });
      cdp = await Cdp.attach({ port: cdpPort, urlMatch: (target) => target.includes(`127.0.0.1:${webPort}`), name: 'pwa-cold' });
      drivers.push(cdp);
      cdp.setLocalTest(isLocal);
      await cdp.startCapture({ intercept: !observeOnly });

      await cdp.waitFor(`!!document.querySelector('#root > *')`, { timeoutMs: 90_000, label: 'the app to boot from a cold start with no server' });
      await cdp.go('/quran/surah/112');
      const settled = await cdp
        .waitFor(`document.querySelectorAll('.state--error,[role=alert]').length === 0 && !!document.querySelector('article.ayah')`, {
          timeoutMs: 180_000,
          intervalMs: 1_000,
          label: 'the cold-started app to render an ayah',
        })
        .then(() => true)
        .catch(() => false);
      const cold = JSON.parse(String(await cdp.evaluate(`(function(){return JSON.stringify({href: location.href, ready: document.readyState, rows: document.querySelectorAll('article.ayah').length, errors: document.querySelectorAll('.state--error,[role=alert]').length, text: document.body.innerText.replace(/\\s+/g,' ').length});})()`)));
      const coldControl = JSON.parse(String(await cdp.evaluate(SW_CONTROL)));
      await collectPageUrls('cold start, server off');
      is(cold.ready, 'complete', 'the cold-started document finished loading', cold);
      ok(cold.text > 100, 'the cold-started app has real text on screen', cold);
      is(cold.errors, 0, 'and no error state', cold);
      ok(coldControl.controlled, 'the worker from the previous session is still the one controlling it', coldControl);
      ok(settled && cold.rows > 0, `the reader rendered revealed text from a cold start with the port refused (rows=${cold.rows} at ${cold.href})`, cold);
      const keys = packs.surahAyahKeys(112);
      is(cold.rows, keys.length, `all ${keys.length} ayat of surah 112 came from the profile’s own cache`, cold);
      return `browser pid ${browser.pid} restarted on the same profile, port ${webPort} still ${gone.error}: ${cold.rows}/${keys.length} ayah rows at ${cold.href}, ${cold.text} chars, 0 error states, controller ${coldControl.scriptURL}`;
    }, { fatal: false });

    /* ------------------------------------------------------------- CHECK 4 — */

    await check('CHECK 4', 'zero runtime network to the internet', 'device', async () => {
      const cdpUrls = drivers.flatMap((driver) => driver.requests.map((r) => r.url));
      const blocked = drivers.reduce((sum, driver) => sum + driver.blocked.length, 0);
      const blockedUrls = drivers.flatMap((driver) => driver.blocked);
      const pageUrls = pageUrlLog.flatMap((entry) => entry.urls);
      const union = [...new Set([...cdpUrls, ...pageUrls])];
      const bad = offenders(drivers.flatMap((driver) => driver.requests), isLocal);
      const badFromPage = pageUrls.filter((u) => !isLocal(u));
      ok(union.length > 0, 'the gate actually saw requests (an empty witness proves nothing)', { cdp: cdpUrls.length, page: pageUrls.length });
      ok(bad.length === 0, 'no request left the machine’s own addresses (CDP witness)', [...new Set(bad)].slice(0, 10));
      ok(badFromPage.length === 0, 'no request left the machine’s own addresses (page resource-timing witness)', badFromPage.slice(0, 10));
      is(blocked, 0, 'nothing had to be refused: the app never tried a non-local origin', observeOnly ? 'interception was OFF (--observe-only)' : blockedUrls.slice(0, 5));

      const buckets = originBuckets(union, isLocal);
      suite.note('origins asked', 'device', buckets.map((b) => `${b.origin}×${b.count}`).join(' · '));
      return `${union.length} distinct URLs, ${cdpUrls.length} CDP-request events (${drivers.length} driver${drivers.length === 1 ? '' : 's'}) + ${pageUrls.length} page-timing entries across ${pageUrlLog.length} snapshots, 0 non-local, ${blocked} refused at request level (${buckets.map((b) => `${b.origin}×${b.count}`).join(' · ')})`;
    }, { fatal: true });
  } catch (error) {
    suite.note('runner', 'device', `the checker itself failed: ${error instanceof Error ? error.stack?.split('\n').slice(0, 3).join(' | ') : String(error)}`);
    log(`· runner error: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    for (const driver of drivers) driver.close();
    if (cdp) cdp.close();
    for (const child of children) {
      if (child && typeof child.pid === 'number') owned.add(child.pid);
      killTree(child, { owned });
    }
    const logsDir = path.join(runRoot.root, 'logs');
    const counts = suite.counts();
    const summary = {
      bundle: bundleRoot,
      at: new Date().toISOString(),
      counts,
      checks: results,
      rows: suite.rows,
      cleanup: cleanupNote,
    };
    try {
      writeFileSync(path.join(logsDir, 'pwa-summary.json'), JSON.stringify(summary, null, 2));
      writeFileSync(path.join(logsDir, 'pwa-report.txt'), suite.report());
      cleanupNote += `evidence kept at ${logsDir} · `;
    } catch {
      cleanupNote += 'evidence could not be written · ';
    }
    if (!hasFlag('keep-run')) {
      try {
        rmSync(path.join(runRoot.root, 'browser'), { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
        cleanupNote += 'browser profile deleted · ';
      } catch (error) {
        cleanupNote += `browser profile kept: ${error.message} · `;
      }
    } else {
      cleanupNote += `run directory kept at ${runRoot.root} · `;
    }
  }

  process.stdout.write(suite.report());
  process.stdout.write('PWA CHECKS — packaged bundle ' + bundleRoot + '\n');
  for (const item of results) {
    process.stdout.write(`${item.status.padEnd(5)} ${item.id} — ${item.title}${item.detail ? `\n      ${item.detail}` : ''}\n`);
  }
  const seen = new Set(results.map((r) => r.id));
  for (const id of ['CHECK 1', 'CHECK 2', 'CHECK 3', 'CHECK 3b', 'CHECK 4']) {
    if (!seen.has(id)) process.stdout.write(`MISSING ${id} — never ran (an earlier fatal step stopped it)\n`);
  }
  if (cleanupNote) process.stdout.write(`Cleanup: ${cleanupNote}\n`);
  const counts = suite.counts();
  return counts.FAIL + counts.ERROR > 0 ? 1 : 0;
}

process.exitCode = await main();
