#!/usr/bin/env node
/**
 * tests/e2e/layout.mjs — the responsive gate: every screen, every width, measured.
 *
 * WHY this exists: «کاملاً ریسپانسیو» is a property of rendered boxes, not of a
 * CSS file. A screenshot taken by hand at one width proves one width, and a
 * review that reads `tokens.css` and reports "modern" proves nothing at all. This
 * file drives a real browser over the shipped bundle, sets a real viewport, and
 * asks the document what its boxes actually did — so a layout that overflows at
 * 360 px fails here instead of failing on a phone.
 *
 * What counts as a violation, and why only these two:
 *   - the page scrolls sideways (`scrollWidth > innerWidth`), or
 *   - a visible element reaches past the viewport edge while no ancestor of it
 *     scrolls — i.e. content is cut off rather than deliberately pannable.
 * Everything else (small tap targets, clipped text with an ellipsis, a fixed
 * decorative element) is reported as a note, because the UI bar allows a
 * documented truncation while it does not allow losing a word of revelation.
 *
 * Two ways to run it:
 *   node tests/e2e/layout.mjs --url=http://127.0.0.1:5173/ --widths=360,768,1440
 *   …or imported by run.mjs, which sweeps the widths after the journey, so the
 *   screens hold the learner's real data instead of an empty database.
 *
 * `--keep` leaves the run directory (browser profile and screenshots) in %TEMP%.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { Cdp } from './lib/cdp.mjs';
import { findEdge, killTree, waitForHttp } from './lib/launch.mjs';
import { createRunRoot } from './lib/profile.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

/** Screens the learner can reach, with the parameters a real mushaf answers. */
export const LAYOUT_ROUTES = [
  { route: '/', label: 'home' },
  { route: '/quran', label: 'surah index' },
  { route: '/quran/surah/112', label: 'surah reader' },
  { route: '/quran/ayah/112%3A1', label: 'single ayah' },
  { route: '/quran/page/604', label: 'mushaf page' },
  { route: '/quran/juz/30', label: 'juz list' },
  { route: '/quran/bookmarks', label: 'bookmarks' },
  { route: '/hifz', label: 'hifz today' },
  { route: '/hifz/items', label: 'hifz items' },
  { route: '/hifz/review', label: 'hifz review' },
  { route: '/hifz/weak', label: 'hifz weak' },
  { route: '/hifz/confusion', label: 'confusion groups' },
  { route: '/hifz/progress', label: 'progress' },
  { route: '/hifz/session', label: 'session runner' },
  { route: '/discover', label: 'search' },
  { route: '/discover/mutashabihat', label: 'mutashabihat' },
  { route: '/discover/concepts', label: 'concepts' },
  { route: '/me', label: 'me' },
  { route: '/me/content', label: 'content packs' },
  { route: '/me/backup', label: 'backup' },
  { route: '/me/notes', label: 'notes' },
  { route: '/me/about', label: 'about' },
];

export const LAYOUT_WIDTHS = [360, 390, 768, 1024, 1280, 1440];

/**
 * The page-side measurement. One pass over every element, with the nearest
 * scrolling ancestor recorded so a deliberate horizontal scroller (the mushaf
 * page on a phone) is not reported as lost content.
 */
const MEASURE = `(function () {
  const vw = window.innerWidth;
  const doc = document.documentElement;
  const scrollers = new Set();
  for (const el of document.querySelectorAll('*')) {
    const s = getComputedStyle(el);
    if (s.overflowX === 'auto' || s.overflowX === 'scroll') scrollers.add(el);
  }
  const inScroller = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (scrollers.has(p)) return true;
    return false;
  };
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    if (s.position === 'fixed' && (s.pointerEvents === 'none' || s.visibility === 'hidden')) return false;
    return true;
  };
  const offenders = [];
  const smallTargets = [];
  const clipped = [];
  for (const el of document.querySelectorAll('body *')) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (!visible(el)) continue;
    if (rect.right > vw + 1 && !inScroller(el)) {
      offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: (typeof el.className === 'string' ? el.className : '').trim().split(/\\s+/).slice(0, 3).join('.'),
        right: Math.round(rect.right),
        overflowPx: Math.round(rect.right - vw),
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
      });
    }
    if (rect.left < -1 && !inScroller(el)) {
      offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: (typeof el.className === 'string' ? el.className : '').trim().split(/\\s+/).slice(0, 3).join('.'),
        right: Math.round(rect.left),
        overflowPx: Math.round(-rect.left),
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
        side: 'left',
      });
    }
    const interactive =
      el.matches('button, a[href], [role="button"], input[type="submit"], summary, select');
    if (interactive && (rect.height < 44 || rect.width < 44)) {
      smallTargets.push({
        tag: el.tagName.toLowerCase(),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        text: (el.textContent || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 30),
      });
    }
    const s = getComputedStyle(el);
    const hasText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
    // A visually-hidden caption is *meant* to be off screen; reporting it as lost
    // text would train the reader to ignore this column.
    if (hasText && !el.classList.contains('visually-hidden') && el.scrollWidth > el.clientWidth + 1 && s.textOverflow !== 'ellipsis' && s.overflow !== 'visible') {
      clipped.push({
        tag: el.tagName.toLowerCase(),
        cls: (typeof el.className === 'string' ? el.className : '').trim().split(/\\s+/).slice(0, 2).join('.'),
        lostPx: el.scrollWidth - el.clientWidth,
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
      });
    }
  }
  const unique = (rows, key) => {
    const seen = new Set();
    return rows.filter((r) => (seen.has(key(r)) ? false : (seen.add(key(r)), true)));
  };
  return {
    innerWidth: vw,
    scrollWidth: Math.max(doc.scrollWidth, document.body ? document.body.scrollWidth : 0),
    bodyOverflowX: getComputedStyle(doc).overflowX,
    offenders: unique(offenders, (r) => r.tag + '|' + r.cls + '|' + r.right + '|' + (r.side || 'right')).slice(0, 12),
    smallTargets: unique(smallTargets, (r) => r.tag + '|' + r.text + '|' + r.w + 'x' + r.h).slice(0, 12),
    clipped: unique(clipped, (r) => r.tag + '|' + r.cls + '|' + r.text).slice(0, 8),
  };
})()`;

/** Set the viewport the way a device would, then let layout settle. */
export async function setViewport(cdp, { width, height = 900, scale = 1 }) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: scale,
    mobile: width < 768,
  });
  await sleep(250);
}

/**
 * Wait for the screen to be the screen: the app must have painted at all, then
 * no busy region left, and the sideways extent unchanged across two polls, so a
 * late-loading card cannot be measured while it is still growing.
 *
 * The paint check is not politeness. A page that never booted measures as an
 * empty document with no overflow, which is the exact shape of a false green.
 */
async function settle(cdp, { timeoutMs = 25_000, label }) {
  const deadline = Date.now() + timeoutMs;
  const painted = await cdp.evaluate(
    `(function(){const r=document.getElementById('root');return !!r && r.children.length>0 && document.body.innerText.trim().length>20;})()`,
  );
  if (!painted) {
    throw new Error(`nothing painted: ${label} — the app did not render, so any geometry here would be a lie`);
  }
  let last = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    const busy = await cdp.evaluate(`document.querySelectorAll('[aria-busy="true"]').length`);
    const width = await cdp.evaluate(`Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)`);
    if (Number(busy) === 0) stable = Number(width) === last ? stable + 1 : 0;
    last = Number(width);
    if (stable >= 2) return true;
    await sleep(300);
  }
  throw new Error(`the screen never settled: ${label}`);
}

/**
 * Walk every route at every width and report what the boxes did.
 * Returns the rows; the caller decides whether a violation fails a suite.
 */
export async function sweepLayout({
  cdp,
  baseUrl,
  widths = LAYOUT_WIDTHS,
  routes = LAYOUT_ROUTES,
  shotsDir = null,
  themes = ['light', 'dark'],
  onRow = null,
  log = () => {},
}) {
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
  const rows = [];
  for (const theme of themes) {
    // The app reads its theme from localStorage, so the sweep can hold one
    // preference while it walks the routes.
    await cdp.run(`try { localStorage.setItem('quran.theme', ${JSON.stringify(theme)}); } catch (e) {}`);
    for (const width of widths) {
      await setViewport(cdp, { width });
      for (const { route, label } of routes) {
        await cdp.run(`location.hash = '#${route}';`);
        await sleep(200);
        try {
          await settle(cdp, { label: `${label} @ ${width}` });
        } catch (error) {
          rows.push({ theme, width, route, label, error: error.message });
          log(`  ! ${theme} ${width}px ${label}: ${error.message}`);
          continue;
        }
        const measured = await cdp.evaluate(MEASURE);
        const overflowPx = Number(measured.scrollWidth) - Number(measured.innerWidth);
        const row = {
          theme,
          width,
          route,
          label,
          scrollWidth: Number(measured.scrollWidth),
          overflowPx,
          pageScrollsX: overflowPx > 1,
          offenders: measured.offenders,
          smallTargets: measured.smallTargets,
          clipped: measured.clipped,
        };
        rows.push(row);
        if (shotsDir) {
          const file = path.join(shotsDir, `${theme}-${width}-${label.replace(/[^a-z0-9]+/gi, '-')}.png`);
          try {
            await cdp.screenshot(file);
            row.shot = file;
          } catch {
            /* a failed screenshot is reported by the row that follows it */
          }
        }
        const bad = row.pageScrollsX || row.offenders.length > 0;
        log(`  ${bad ? '✗' : '·'} ${theme} ${String(width).padStart(4)}px ${label.padEnd(16)} scrollW ${row.scrollWidth}${bad ? ` offenders ${row.offenders.length}` : ''}`);
        if (onRow) await onRow(row);
      }
    }
  }
  return rows;
}

/** Rows that break the gate, described the way a fix needs to read them. */
export function layoutViolations(rows) {
  const out = [];
  for (const row of rows) {
    if (row.error) {
      out.push(`${row.theme} ${row.width}px ${row.label}: ${row.error}`);
      continue;
    }
    if (row.pageScrollsX) {
      out.push(`${row.theme} ${row.width}px ${row.label} (${row.route}): the page scrolls sideways by ${row.overflowPx}px`);
    }
    for (const offender of row.offenders) {
      out.push(
        `${row.theme} ${row.width}px ${row.label}: <${offender.tag}${offender.cls ? `.${offender.cls}` : ''}> passes the ${offender.side || 'right'} edge by ${offender.overflowPx}px — "${offender.text}"`,
      );
    }
  }
  return out;
}

/** Notes worth reading that are not, by themselves, a failed gate. */
export function layoutNotes(rows) {
  const small = new Map();
  const clipped = new Map();
  for (const row of rows) {
    for (const t of row.smallTargets ?? []) {
      const key = `${t.tag} "${t.text}" ${t.w}×${t.h}`;
      small.set(key, (small.get(key) ?? 0) + 1);
    }
    for (const c of row.clipped ?? []) {
      const key = `${c.tag}${c.cls ? `.${c.cls}` : ''} "${c.text}" loses ${c.lostPx}px`;
      clipped.set(key, (clipped.get(key) ?? 0) + 1);
    }
  }
  return {
    smallTargets: [...small.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
    clipped: [...clipped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
  };
}

/** Used by run.mjs after the journey: the app already holds the learner's data. */
export async function runLayoutTail({ cdp, suite, opts }) {
  const widths = String(opts?.widths ?? '360,768,1440').split(',').map(Number).filter(Boolean);
  const baseUrl = opts?.webPort ? `http://127.0.0.1:${opts.webPort}/` : null;
  const shotsDir = path.join(opts?.runRoot ?? REPO_ROOT, 'shots', 'layout');
  const rows = await sweepLayout({
    cdp,
    baseUrl,
    widths,
    shotsDir,
    themes: ['light'],
    log: (line) => process.stdout.write(`${line}\n`),
  });
  const notes = layoutNotes(rows);
  suite.note('layout sweep', 'device', `${widths.join('/')} px · ${rows.length} screens measured · shots at ${shotsDir}`);
  for (const [text, count] of notes.smallTargets) {
    suite.note('tap target under 44px', 'device', `×${count} ${text}`);
  }
  for (const [text, count] of notes.clipped) {
    suite.note('text clipped without ellipsis', 'device', `×${count} ${text}`);
  }
  return rows;
}

/* --------------------------------------------------------------- standalone */

function arg(name, fallback = null) {
  const flag = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(flag));
  return hit ? hit.slice(flag.length) : fallback;
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen({ port, host: '127.0.0.1' }, () => srv.close(() => resolve(port)));
  });
}

async function freePort(preferred) {
  try {
    return await listen(preferred);
  } catch {
    const srv = createServer();
    await new Promise((resolve, reject) => {
      srv.once('error', reject);
      srv.listen({ port: 0, host: '127.0.0.1' }, resolve);
    });
    const port = srv.address().port;
    await new Promise((resolve) => srv.close(resolve));
    return port;
  }
}

async function main() {
  const url = arg('url', 'http://localhost:5173/');
  const widths = String(arg('widths', '360,768,1440')).split(',').map(Number).filter(Boolean);
  const themes = String(arg('themes', 'light,dark')).split(',').filter(Boolean);
  const only = arg('routes');
  const keep = process.argv.includes('--keep');
  const routes = only
    ? only.split(',').map((route) => ({ route, label: route.replace(/^\//, '') || 'home' }))
    : LAYOUT_ROUTES;

  const port = await freePort(9444);
  // The profile lives in the OS temp directory, like every other run here. A
  // profile on a project drive boots a blank page in headless Edge, which would
  // make the whole sweep measure an empty document.
  const runRoot = createRunRoot('quran-layout');
  const userDataDir = path.join(runRoot.root, 'browser');
  const shotsDir = arg('shots', path.join(runRoot.root, 'shots', 'layout'));
  mkdirSync(shotsDir, { recursive: true });
  const child = spawn(
    findEdge(),
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--window-size=1440,900',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true },
  );
  const owned = new Set([child.pid]);
  let exitCode = 0;
  let cdp = null;
  try {
    await waitForHttp(`http://127.0.0.1:${port}/json/list`, { label: 'the CDP endpoint', timeoutMs: 60_000 });
    cdp = await Cdp.attach({ port, urlMatch: (u) => u.includes('about:blank'), name: 'layout' });
    await cdp.startCapture({ intercept: false });
    await cdp.send('Page.navigate', { url });
    await cdp.waitFor(`document.getElementById('root') && document.getElementById('root').children.length > 0`, {
      timeoutMs: 60_000,
      label: 'the app to paint',
    });
    if (process.argv.includes('--seed=import')) {
      // The app's own first-run button, not a seeded store: the screens are then
      // measured over real Arabic and real Persian, which is where a layout
      // actually breaks.
      await cdp.run(`location.hash = '#/';`);
      await sleep(800);
      const clicked = await cdp.clickText('وارد کردن بسته‌های محتوا|Import content packs').catch(() => null);
      if (clicked === null) process.stdout.write('· --seed=import: no first-run import affordance (already imported?)\n');
      else {
        process.stdout.write(`· clicked “${clicked}”; waiting for the packs to land\n`);
        await cdp.run(`location.hash = '#/quran';`);
        await cdp.waitFor(`document.querySelectorAll('a[href*="quran/surah/"]').length >= 114`, {
          timeoutMs: 600_000,
          intervalMs: 2000,
          label: 'the surah index to fill',
        });
      }
    }
    process.stdout.write(`· sweeping ${routes.length} screens × ${widths.join('/')} px × ${themes.join('/')} at ${url}\n`);
    const rows = await sweepLayout({ cdp, baseUrl: url, widths, routes, themes, shotsDir, log: (line) => process.stdout.write(`${line}\n`) });
    const violations = layoutViolations(rows);
    const notes = layoutNotes(rows);
    process.stdout.write(
      `\n${rows.length} screens measured · ${violations.length} violation(s) · shots in ${shotsDir}\n`,
    );
    for (const line of violations.slice(0, 60)) process.stdout.write(`  ✗ ${line}\n`);
    process.stdout.write('\nnotes (not gate failures):\n');
    for (const [text, count] of notes.smallTargets) process.stdout.write(`  · tap ×${count} ${text}\n`);
    for (const [text, count] of notes.clipped) process.stdout.write(`  · clip ×${count} ${text}\n`);
    exitCode = violations.length ? 1 : 0;
  } finally {
    if (cdp) cdp.close();
    killTree(child, { owned });
    if (!keep) {
      try {
        rmSync(userDataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
      } catch (error) {
        // An Edge handle can outlive the process; a leftover profile is untidy,
        // losing the sweep's evidence would be worse.
        process.stdout.write(`· profile kept at ${userDataDir} (${error.code ?? error.message})\n`);
      }
    } else {
      process.stdout.write(`· run directory kept whole at ${runRoot.root}\n`);
    }
  }
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exitCode = await main();
}
