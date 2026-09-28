/**
 * Module discovery for tests against moving targets.
 *
 * Five agents are writing `core/src/hifz`, `core/src/search`,
 * `core/src/mutashabihat`, `core/src/backup`, `tools/content` + `content` and
 * `desktop` at the same time as this suite. QA therefore never hard-codes an
 * internal helper name: a spec declares *which public symbol* it needs and this
 * module finds the file that exports it, wherever the owning agent put it.
 *
 * If nothing exports the symbol yet, the probe comes back not-ok with a reason
 * string naming what is missing, and the spec is `.skip`-ed and counted as a
 * known gap instead of deleted.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe } from 'vitest';
import { REPO_ROOT } from './repo';

const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', 'target', '.git', '.next', 'assets', 'gen']);
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs'];

export interface Probe<T = Record<string, unknown>> {
  ok: boolean;
  /** Repo-relative path of the file that satisfied the probe. */
  file: string | null;
  module: T | null;
  /** Exported symbols the probe required and the file did not provide. */
  missing: string[];
  /** Human reason, always present when `ok` is false. Used in the skip title. */
  reason: string;
}

export interface LocateOptions {
  /** Repo-relative directories to scan, e.g. `['desktop/src']`. */
  dirs: string[];
  /** Exported names the spec needs. Any one of them identifies the module. */
  symbols: string[];
  /** Optional filename filter (matches the repo-relative path). */
  filePattern?: RegExp;
  /** Require every symbol (default) or any single one. */
  requireAll?: boolean;
  extensions?: string[];
  maxFiles?: number;
}

export function walkFiles(dir: string, extensions = SOURCE_EXTENSIONS, root = REPO_ROOT): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = join(dir, entry);
    if (IGNORED_DIRS.has(entry)) continue;
    let stats;
    try {
      stats = statSync(abs);
    } catch {
      continue;
    }
    if (stats.isDirectory()) out.push(...walkFiles(abs, extensions, root));
    else if (extensions.some((ext) => entry.endsWith(ext))) out.push(abs);
  }
  return out.sort();
}

/** Textual scan for an exported symbol; avoids importing files that cannot provide it. */
function exportsSymbol(source: string, symbol: string): boolean {
  const patterns = [
    new RegExp(`export\\s+(?:declare\\s+)?(?:async\\s+)?function\\s+${symbol}\\b`),
    new RegExp(`export\\s+(?:const|let|var|class|type|interface|enum)\\s+${symbol}\\b`),
    new RegExp(`export\\s*\\{[^}]*\\b${symbol}\\b`),
    new RegExp(`export\\s+\\*\\s+from`),
  ];
  return patterns.some((re) => re.test(source));
}

/**
 * Find the first file under `dirs` that exports the wanted symbols, import it,
 * and report whether every symbol actually arrived.
 */
export async function locateModule<T = Record<string, unknown>>(options: LocateOptions): Promise<Probe<T>> {
  const requireAll = options.requireAll ?? false;
  const candidates: { abs: string; rel: string; matched: string[] }[] = [];
  for (const dir of options.dirs) {
    const absDir = isAbsolute(dir) ? dir : join(REPO_ROOT, dir);
    for (const abs of walkFiles(absDir, options.extensions)) {
      const rel = relative(REPO_ROOT, abs).replace(/\\/g, '/');
      if (options.filePattern && !options.filePattern.test(rel)) continue;
      let source = '';
      try {
        source = readFileSync(abs, 'utf-8');
      } catch {
        continue;
      }
      const matched = options.symbols.filter((s) => exportsSymbol(source, s));
      if (matched.length === 0) continue;
      if (requireAll && matched.length !== options.symbols.length) continue;
      candidates.push({ abs, rel, matched });
      if (candidates.length >= (options.maxFiles ?? 3)) break;
    }
    if (candidates.length > 0) break;
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      file: null,
      module: null,
      missing: options.symbols,
      reason:
        `no module exporting ${options.symbols.map((s) => `'${s}'`).join(' or ')} found in ` +
        `${options.dirs.join(', ')} — module not landed yet`,
    };
  }

  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      const mod = (await import(pathToFileURL(candidate.abs).href)) as T;
      const present = options.symbols.filter((s) => s in (mod as Record<string, unknown>));
      const missing = options.symbols.filter((s) => !(s in (mod as Record<string, unknown>)));
      const satisfied = requireAll ? missing.length === 0 : present.length > 0;
      if (satisfied) {
        return { ok: true, file: candidate.rel, module: mod, missing, reason: '' };
      }
      errors.push(`${candidate.rel}: exports ${present.join(', ') || 'nothing required'}`);
    } catch (error) {
      errors.push(`${candidate.rel}: import failed — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    ok: false,
    file: candidates[0]?.rel ?? null,
    module: null,
    missing: options.symbols,
    reason: `candidate module(s) found but unusable: ${errors.join(' | ')}`,
  };
}

/**
 * Narrow a probe to the symbols it required, so specs get typed functions
 * without importing the module's internal names anywhere else.
 */
export function pick<T extends Record<string, unknown>>(probe: Probe, names: (keyof T & string)[]): T {
  const mod = (probe.module ?? {}) as Record<string, unknown>;
  const out = {} as T;
  for (const name of names) {
    if (typeof mod[name] !== 'function' && mod[name] === undefined) {
      throw new Error(`pick: '${name}' is not exported by ${probe.file ?? 'unknown module'}`);
    }
    (out as Record<string, unknown>)[name] = mod[name];
  }
  return out;
}

/** Title carrying the gap, used with `describe.skip` so the reason is visible. */
export function gapTitle(base: string, probe: Probe): string {
  if (probe.ok) return base;
  return `${base} — KNOWN GAP, SKIPPED: ${probe.reason}`;
}

export type SuiteFn = typeof describe;

/** `describe` when the probe is satisfied, `describe.skip` with a reason when not. */
export function suiteFor(probe: Probe): SuiteFn {
  return probe.ok ? describe : describe.skip;
}

/** Assert a probe landed; call inside a test that must not silently pass. */
export function assertLanded(probe: Probe, what: string): void {
  if (!probe.ok) throw new Error(`${what} is missing: ${probe.reason}`);
}
