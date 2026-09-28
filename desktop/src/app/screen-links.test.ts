/**
 * Every link a screen can render must resolve to a registered route.
 *
 * A dead `to=` is invisible until someone clicks it: the router answers `null`
 * and the shell shows its not-found page, which reads as "the app is broken".
 * `registry.ts` already asserts the sidebar (`NAV`) at module load; this test
 * covers the rest — the `LinkButton to=`, `navigate(` and `to:` literals
 * scattered through the screens — by reading the screen sources as text and
 * resolving each target against the real route table.
 *
 * Targets built from a template literal (`/quran/ayah/${key}`) are checked as a
 * prefix: the static part must be the start of a registered parameterised path,
 * so `/quran/ayah/` passes and a mistyped `/me/data/` does not.
 */
import { describe, expect, it } from 'vitest';

import { NAV, ROUTES } from './registry';
import { resolveRoute } from './router';

/** Raw screen sources — text only, so JSX and hooks never execute here. */
const SOURCES = import.meta.glob('../screens/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** The literal part of a link as the screens write it: `to="…"`, `to={`/…`}`, `navigate('…')`, `to: '…'`. */
const TARGET_RE = /(?:to=|to:\s*|navigate\()\s*\{?\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g;

/** `path?query` → the path portion, with a dynamic tail cut at `${`. */
function pathOf(target: string): { path: string; dynamic: boolean } {
  const withoutFragment = target.split('#')[0] ?? '/';
  const pathPart = withoutFragment.split('?')[0] ?? '/';
  const dollar = pathPart.indexOf('${');
  if (dollar >= 0) return { path: pathPart.slice(0, dollar), dynamic: true };
  return { path: pathPart.replace(/\/+$/, '') || '/', dynamic: false };
}

/** The targets that no route answers for, as `file → target` strings. */
function deadTargets(links: readonly { target: string; file: string }[]): string[] {
  const broken: string[] = [];
  for (const { target, file } of links) {
    const { path, dynamic } = pathOf(target);
    if (!path.startsWith('/')) continue;
    if (dynamic) {
      // A template link is `/quran/ayah/${key}`: cut at `${`, then resolve a
      // concrete probe value for the parameter (`/quran/ayah/probe`). The prefix
      // alone is not enough — `/hifz/${x}` would otherwise look like `/hifz/`.
      const prefix = path.endsWith('/') ? path : `${path}/`;
      const hit = resolveRoute(ROUTES, `${prefix}probe`, {}).route;
      if (hit === null || !hit.path.startsWith(prefix)) {
        broken.push(`${file} → ${target} (nothing registers a route under ${prefix})`);
      }
      continue;
    }
    if (resolveRoute(ROUTES, path, {}).route === null) broken.push(`${file} → ${target}`);
  }
  return broken;
}

const LINKS: readonly { target: string; file: string }[] = Object.entries(SOURCES)
  .flatMap(([file, text]) =>
    [...text.matchAll(TARGET_RE)].map((match) => ({
      target: match[1] ?? match[2] ?? match[3] ?? '',
      file,
    })),
  )
  .filter((link) => link.target.startsWith('/'))
  .sort((a, b) => `${a.file}${a.target}`.localeCompare(`${b.file}${b.target}`));

describe('screen link targets', () => {
  it('reads the real sources, so the scan cannot pass by matching nothing', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(20);
    expect(LINKS.length).toBeGreaterThan(40);
    // The dead target the UI audit found must never come back as a literal.
    expect(LINKS.filter((l) => l.target.startsWith('/me/data'))).toEqual([]);
  });

  it('catches a dead target, so an empty result means "no dead links"', () => {
    const synthetic = [
      // literal, unregistered
      { target: '/me/data', file: 'synthetic' },
      // template that does land on a parameterised route
      { target: '/quran/ayah/${k}', file: 'synthetic' },
      // template with no route under its prefix
      { target: '/nowhere/${k}', file: 'synthetic' },
      // prefix of a registered section, but no route takes a segment there
      { target: '/hifz/${k}', file: 'synthetic' },
      // a query-carrying template: only the path part has to resolve
      { target: '/hifz/session?item=${id}', file: 'synthetic' },
    ];
    expect(deadTargets(synthetic)).toEqual([
      'synthetic → /me/data',
      'synthetic → /nowhere/${k} (nothing registers a route under /nowhere/)',
      'synthetic → /hifz/${k} (nothing registers a route under /hifz/)',
    ]);
  });

  it('resolves every literal target a screen can navigate to', () => {
    expect(deadTargets(LINKS)).toEqual([]);
  });

  it('resolves every sidebar nav entry too', () => {
    for (const item of NAV) {
      const { path } = pathOf(item.to);
      expect(resolveRoute(ROUTES, path, {}).route, `nav ${item.to}`).not.toBeNull();
    }
  });
});
