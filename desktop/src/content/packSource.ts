/**
 * PackSource — how the app reaches the bundled content directory.
 *
 * The shipped path (Tauri) asks Rust for the bytes *and* the digest, so the
 * webview never computes a checksum it then trusts itself with. The browser dev
 * shell fetches the same files from the Vite dev server (`/content/…`, served by
 * `dev/contentMiddleware.mjs` from the repository `content/` folder) and hashes
 * them with WebCrypto.
 *
 * Both implementations return the same shape and apply the same path rules, so a
 * path that would be rejected natively fails in dev too.
 */
import { sha256Hex } from './hash';

export type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export interface PackFileStat {
  bytes: number;
  sha256: string;
}

export interface PackFile extends PackFileStat {
  rel: string;
  text: string;
}

export interface PackAvailability {
  root: string | null;
  hasIndex: boolean;
}

export interface PackSource {
  readonly kind: 'tauri' | 'fetch';
  /** Where the files come from — shown verbatim on the Data health screen. */
  readonly location: string;
  available(): Promise<PackAvailability>;
  /** `null` when the file does not exist (a missing pack is not an error). */
  stat(rel: string): Promise<PackFileStat | null>;
  /** Throws when the file is missing. */
  read(rel: string): Promise<PackFile>;
}

/** Same rules as the Rust command, applied client-side so failures are clear. */
export function assertSafeRel(rel: string): void {
  if (!rel || rel.length > 512) throw new Error('content path is empty or too long');
  if (rel.includes('\\') || rel.includes(':') || rel.includes('\0')) {
    throw new Error(`content path rejected: ${rel}`);
  }
  if (!/\.(json|jsonl)$/i.test(rel)) throw new Error(`only .json/.jsonl may be read: ${rel}`);
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') throw new Error(`content path rejected: ${rel}`);
  }
}

const MISSING_RE = /stat failed|no such file|os error 2|not found|does not exist/i;

export function createTauriPackSource(invoke: TauriInvoke, root: string | null): PackSource {
  return {
    kind: 'tauri',
    location: root ?? '(no content directory found)',
    async available() {
      return invoke<PackAvailability>('content_status');
    },
    async stat(rel) {
      assertSafeRel(rel);
      try {
        const s = await invoke<PackFileStat>('content_pack_stat', { rel });
        return { bytes: s.bytes, sha256: s.sha256 };
      } catch (err) {
        if (MISSING_RE.test(String(err))) return null;
        throw err;
      }
    },
    async read(rel) {
      assertSafeRel(rel);
      const stat = await invoke<PackFileStat>('content_pack_stat', { rel });
      const text = await invoke<string>('content_read_text', { rel });
      return { rel, bytes: stat.bytes, sha256: stat.sha256, text };
    },
  };
}

export function createFetchPackSource(base = '/content'): PackSource {
  async function probe(rel: string): Promise<Response | null> {
    assertSafeRel(rel);
    const res = await fetch(`${base}/${rel}`, { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`content fetch failed (${res.status}) for ${rel}`);
    return res;
  }

  return {
    kind: 'fetch',
    location: base,
    async available() {
      try {
        const res = await probe('index.json');
        return { root: base, hasIndex: res !== null };
      } catch {
        return { root: null, hasIndex: false };
      }
    },
    async stat(rel) {
      const res = await probe(rel);
      if (!res) return null;
      const buf = await res.arrayBuffer();
      return { bytes: buf.byteLength, sha256: await sha256Hex(new Uint8Array(buf)) };
    },
    async read(rel) {
      const res = await probe(rel);
      if (!res) throw new Error(`content file missing: ${rel}`);
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      return {
        rel,
        bytes: buf.byteLength,
        sha256: await sha256Hex(bytes),
        text: new TextDecoder('utf-8').decode(bytes),
      };
    },
  };
}
