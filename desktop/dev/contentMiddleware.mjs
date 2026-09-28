/**
 * Dev-server middleware that exposes the repository `content/` directory at
 * `/content/...` so the browser shell loads exactly the pack files the packaged
 * app loads. Path handling mirrors the Rust command's rules: relative only, no
 * traversal, `.json` / `.jsonl` only.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
};

function safeRel(rel) {
  if (!rel || rel.length > 512) return false;
  if (rel.includes('\0') || /^[a-zA-Z]:/.test(rel) || rel.startsWith('/')) return false;
  return rel.split('/').every((seg) => seg && seg !== '.' && seg !== '..');
}

export function createContentMiddleware(contentRoot) {
  const root = path.resolve(contentRoot);
  return {
    name: 'quran:content-static',
    configureServer(server) {
      server.middlewares.use('/content', async (req, res, next) => {
        const url = decodeURIComponent((req.url ?? '').split('?')[0] ?? '');
        const rel = url.replace(/^\/+/, '');
        if (!safeRel(rel)) {
          res.statusCode = 400;
          res.end('bad request: unsafe content path');
          return;
        }
        const ext = path.extname(rel).toLowerCase();
        if (ext !== '.json' && ext !== '.jsonl') {
          res.statusCode = 403;
          res.end('forbidden: only .json / .jsonl may be read from /content');
          return;
        }
        const abs = path.join(root, rel);
        if (!abs.startsWith(root)) {
          res.statusCode = 400;
          res.end('bad request: outside content root');
          return;
        }
        try {
          const info = await stat(abs);
          if (!info.isFile()) {
            res.statusCode = 404;
            res.end('not found');
            return;
          }
          const body = await readFile(abs);
          res.statusCode = 200;
          res.setHeader('Content-Type', MIME[ext] ?? 'text/plain; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(body);
        } catch {
          res.statusCode = 404;
          res.end('not found');
        }
      });
    },
  };
}
