/**
 * tests/e2e/lib/launch.mjs — start the shipped app, and only stop what was started.
 *
 * Desktop: the built/installed `quran-desktop.exe` with
 * `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>
 *  --user-data-dir=<a directory this run created>`
 * so WebView2 exposes CDP and keeps its own profile (localStorage, cache) inside
 * a directory we own and may delete. The SQLite file is NOT redirected by that
 * switch — see profile.mjs for how the app-data directory is handled.
 *
 * Web: `node desktop/scripts/serveWeb.mjs --port=… --dist=…` plus headless
 * Edge on its own `--user-data-dir`, pointed at `http://127.0.0.1:<port>`.
 * There every byte of user state lives in the browser profile directory, so the
 * web shell is fully isolated and genuinely fresh with nothing parked.
 *
 * Process hygiene: `killTree` is only ever called with a PID this module
 * spawned. If a `quran-desktop.exe` is already running that we did not start,
 * preflight() refuses rather than killing someone else's window.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const IS_WINDOWS = process.platform === 'win32';

export const IDENTIFIER = 'app.quran.platform';
export const PRODUCT_NAME = 'Quran Platform';

/** Where a per-user NSIS install of this product lives. */
export function installDir() {
  return path.join(process.env.LOCALAPPDATA || '', PRODUCT_NAME);
}

export function installedExePath() {
  return path.join(installDir(), 'quran-desktop.exe');
}

export function builtExePath(repoRoot) {
  return path.join(repoRoot, 'desktop', 'src-tauri', 'target', 'release', 'quran-desktop.exe');
}

/** First candidate that exists; the error lists what was tried. */
export function findDesktopExe({ explicit = null, repoRoot }) {
  const candidates = [explicit, installedExePath(), builtExePath(repoRoot)].filter(Boolean);
  const hit = candidates.find((candidate) => existsSync(candidate));
  if (!hit) {
    throw new Error(
      `no desktop executable found. Tried:\n${candidates.map((c) => `  ${c}`).join('\n')}\n` +
        'Build one with `npm run desktop:tauri build`, or pass --exe=<path to quran-desktop.exe>.',
    );
  }
  return { exe: hit, source: hit === explicit ? '--exe' : hit === installedExePath() ? 'installed' : 'target/release' };
}

export function findEdge() {
  const candidates = [
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
    process.env['PROGRAMFILES(X86)']
      ? path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
  ].filter(Boolean);
  const hit = candidates.find((candidate) => existsSync(candidate));
  if (!hit) throw new Error(`Microsoft Edge not found (looked in: ${candidates.join(', ')}). Pass --browser=<path to msedge.exe>.`);
  return hit;
}

/**
 * Refuse to run if another quran-desktop.exe holds the database we are about to
 * park. Read-only check: `tasklist` never touches anything.
 */
export function preflightDesktopRunning() {
  if (!IS_WINDOWS) return false;
  const result = spawnSync('tasklist', ['/FI', 'IMAGENAME eq quran-desktop.exe', '/NH'], { encoding: 'utf8' });
  const text = `${result.stdout || ''}${result.stderr || ''}`;
  return /quran-desktop\.exe/i.test(text);
}

function childLogFile(dir, name) {
  mkdirSync(dir, { recursive: true });
  return openSync(path.join(dir, `${name}.log`), 'w');
}

/** Launch the packaged desktop app with WebView2 CDP enabled. */
export function launchDesktop({ exe, port, webViewUserDataDir, logDir, extraEnv = {} }) {
  const env = {
    ...process.env,
    ...extraEnv,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --user-data-dir=${webViewUserDataDir}`,
  };
  const child = spawn(exe, [], {
    env,
    cwd: path.dirname(exe),
    stdio: ['ignore', childLogFile(logDir, 'desktop-stdout'), childLogFile(logDir, 'desktop-stderr')],
    windowsHide: true,
  });
  child.on('error', (error) => {
    throw new Error(`failed to start ${exe}: ${error.message}`);
  });
  return child;
}

/** Serve the built web bundle on a loopback port. */
/**
 * Refuse to serve a bundle older than the sources it is supposed to contain.
 *
 * The web shell has no compile step of its own: it reads `desktop/dist` however
 * it was left. A round that changed `core/src` or `desktop/src` and forgot to
 * rebuild would "verify" the previous build — a PASS that proves nothing and a
 * FAIL that blames code which is actually fine. Both are worse than stopping.
 *
 * `index.html` is written by the same `vite build` as the chunks, so its mtime is
 * the build's; anything under the watched roots newer than it postdates the build.
 */
export function assertBundleFresh({ dist, repoRoot }) {
  const marker = path.join(dist, 'index.html');
  if (!existsSync(marker)) throw new Error(`no built bundle at ${marker} — run npm run desktop:build first`);
  const built = statSync(marker).mtimeMs;
  const roots = [path.join(repoRoot, 'desktop', 'src'), path.join(repoRoot, 'core', 'src')];
  const SOURCE = /\.(ts|tsx|css|sql)$/;
  let newest = null;
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { recursive: true })) {
      const name = entry.toString();
      if (!SOURCE.test(name)) continue;
      const file = path.join(root, name);
      const mtime = statSync(file).mtimeMs;
      if (mtime > built && (!newest || mtime > newest.mtime)) newest = { file, mtime };
    }
  }
  if (newest) {
    throw new Error(
      `${dist} is stale: ${path.relative(repoRoot, newest.file)} was written after the build ` +
        `(${new Date(newest.mtime).toISOString()} vs ${new Date(built).toISOString()}). ` +
        'The web shell would be judging the previous bundle — rebuild with `npm run desktop:build`.',
    );
  }
  return { marker, built };
}

export function launchWebServer({ repoRoot, port, dist }) {
  const script = path.join(repoRoot, 'desktop', 'scripts', 'serveWeb.mjs');
  if (!existsSync(script)) throw new Error(`missing ${script}`);
  const child = spawn(process.execPath, [script, `--port=${port}`, `--host=127.0.0.1`, `--dist=${dist}`], {
    cwd: path.join(repoRoot, 'desktop'),
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  });
  child.on('error', (error) => {
    throw new Error(`failed to start serveWeb.mjs: ${error.message}`);
  });
  return child;
}

/** Headless browser pointed at the served bundle, on a fresh profile directory. */
export function launchBrowser({ url, port, userDataDir, browser = null }) {
  const exe = browser || findEdge();
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--window-size=1320,880',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    url,
  ];
  const child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
  child.on('error', (error) => {
    throw new Error(`failed to start ${exe}: ${error.message}`);
  });
  return child;
}

export async function waitForHttp(url, { timeoutMs = 30_000, label = url } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = 'not attempted';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.status < 500) return true;
      last = `HTTP ${res.status}`;
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`${label} never answered at ${url} within ${timeoutMs} ms (last: ${last})`);
}

/**
 * Kill a process tree we started. `taskkill /T` is scoped to the PID we spawned;
 * nothing else is addressed, and a PID this module did not create is refused.
 */
export function killTree(child, { owned = new Set() } = {}) {
  if (!child || typeof child.pid !== 'number') return false;
  if (owned.size > 0 && !owned.has(child.pid)) {
    throw new Error(`refusing to kill PID ${child.pid}: this run did not start it`);
  }
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  return true;
}
