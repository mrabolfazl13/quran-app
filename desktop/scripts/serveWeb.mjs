/**
 * serveWeb.mjs — run the built app on a local HTTP port.
 *
 * The web target is the same bundle the desktop installer carries: `dist/` from
 * `vite build` plus `dist/content/` staged by `stageContent.mjs`. Nothing here
 * rebuilds or re-validates anything; it only serves bytes that already passed
 * the content gate, so what you see on http://127.0.0.1 is what ships.
 *
 * Deliberately dependency-free (node:http only) so the installer package runs on
 * Windows, macOS and Linux with nothing but Node installed.
 *
 * Binds to 127.0.0.1 by default. This is an offline app; listening on a LAN
 * interface has to be an explicit choice (`--host`), never the accident of a
 * default.
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeRel } from '../dev/contentMiddleware.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function arg(name, fallback) {
  const pre = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pre));
  return hit ? hit.slice(pre.length) : fallback;
}

/** Absolute path inside `root`, or null when the request tries to escape. */
function resolveInside(root, rel) {
  if (!safeRel(rel)) return null;
  const abs = path.resolve(root, rel);
  return abs === root || abs.startsWith(root + path.sep) ? abs : null;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}

function serveFile(req, res, abs, immutable) {
  const ext = path.extname(abs).toLowerCase();
  const type = MIME[ext] ?? 'application/octet-stream';
  // Hashed assets (…/assets/index-abc123.js) never change; everything else —
  // index.html, the manifest, the service worker — must be revalidated, or an
  // update would never reach a machine that already installed the app.
  const cache = immutable ? 'public, max-age=31536000, immutable' : 'no-cache';
  if (req.method === 'HEAD') {
    send(res, 200, '', { 'Content-Type': type, 'Cache-Control': cache });
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
  createReadStream(abs).pipe(res);
}

export function createWebServer(root = DIST) {
  if (!existsSync(path.join(root, 'index.html'))) {
    throw new Error(`no built app at ${root} — run \`npm run desktop:build\` first`);
  }
  const contentRoot = path.join(root, 'content');

  return createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      send(res, 400, 'bad request');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // The app writes nothing over HTTP: user data lives in the browser's own
      // storage, and content is read-only. Any other verb is a bug or a probe.
      send(res, 405, 'method not allowed', { Allow: 'GET, HEAD' });
      return;
    }

    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/content' || pathname.startsWith('/content/')) {
      if (!existsSync(contentRoot)) {
        send(res, 404, 'this build has no staged content — run `node scripts/stageContent.mjs --to=both`');
        return;
      }
      const rel = pathname.replace(/^\/content\/?/, '');
      // index.json and the packs are re-staged on every build, so never let a
      // client (or a service worker) hold a stale pack.
      serve(contentRoot, rel, res, req, false, 'not found: /content/' + rel);
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      serveFile(req, res, path.join(root, 'index.html'), false);
      return;
    }

    serve(root, pathname.replace(/^\//, ''), res, req, /^\/assets\/|\.woff2?$/, 'not found: ' + pathname);
  });

  function serve(rootDir, rel, res, req, immutableRe, notFound) {
    const abs = resolveInside(rootDir, rel);
    if (!abs) {
      send(res, 400, 'bad request: unsafe path');
      return;
    }
    let info;
    try {
      info = statSync(abs);
    } catch {
      send(res, 404, notFound);
      return;
    }
    if (info.isDirectory()) {
      const index = path.join(abs, 'index.html');
      if (!existsSync(index)) {
        send(res, 404, notFound);
        return;
      }
      serveFile(req, res, index, false);
      return;
    }
    serveFile(req, res, abs, Boolean(immutableRe) && immutableRe.test('/' + rel));
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const host = arg('host', '127.0.0.1');
  const port = Number(arg('port', '4173'));
  const root = path.resolve(arg('dist', DIST));
  const server = createWebServer(root);
  server.listen(port, host, () => {
    process.stdout.write(`Quran web build  http://${host}:${port}/\n`);
    process.stdout.write(`  app     ${path.join(root, 'index.html')}\n`);
    process.stdout.write(`  content ${existsSync(path.join(root, 'content', 'index.json')) ? path.join(root, 'content') : '(none staged)'}\n`);
    process.stdout.write('Ctrl+C stops it.\n');
  });
  server.on('error', (e) => {
    process.stderr.write(`cannot listen on ${host}:${port} — ${e.message}\n`);
    process.exitCode = 1;
  });
}
