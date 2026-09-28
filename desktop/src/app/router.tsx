/**
 * Hash routing, no dependency.
 *
 * A hash router is what survives all three shells unchanged: Tauri serves the
 * bundle from a custom protocol where pushState paths 404, the web shell is
 * served from a localhost port that may sit under any prefix, and a file://
 * open must still work during development. Nothing else in the app knows the
 * difference — screens navigate through `navigate()` and read `useRoute()`.
 */
import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';

import type { Tr } from './app-state';

export interface RouteProps {
  /** Captured `:param` segments, already percent-decoded. */
  params: Readonly<Record<string, string>>;
  /** The part after `?`, parsed once so screens never touch `location`. */
  query: Readonly<Record<string, string>>;
}

export interface RouteDef {
  /** e.g. `/quran/ayah/:verseKey`. Must start with `/`. */
  path: string;
  /** Shown in the header and used as the document title suffix. */
  title: (tr: Tr) => string;
  /** Section the sidebar highlights, so a detail page keeps its parent lit. */
  section: string;
  component: ComponentType<RouteProps>;
}

export interface NavItem {
  /** Sidebar label. */
  label: (tr: Tr) => string;
  /** Hash target, e.g. `/hifz`. */
  to: string;
  /** Match rule: this nav entry is active when the route section equals it. */
  section: string;
}

export interface Resolved {
  route: RouteDef | null;
  params: Readonly<Record<string, string>>;
  query: Readonly<Record<string, string>>;
  path: string;
}

/** `#/quran/ayah/2:255?tab=tafsir` → `/quran/ayah/2:255` + `{ tab: 'tafsir' }`. */
export function parseHash(hash: string): { path: string; query: Record<string, string> } {
  const raw = hash.replace(/^#/, '');
  const [pathPart = '/', queryPart = ''] = raw.split('?');
  const path = pathPart.startsWith('/') ? pathPart : `/${pathPart}`;
  const query: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(queryPart)) query[key] = value;
  return { path: path.replace(/\/+$/, '') || '/', query };
}

function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split('/').filter((s) => s.length > 0);
  const b = path.split('/').filter((s) => s.length > 0);
  // Exact segment count, in both directions. A shorter pattern must not swallow
  // a longer path: that is how `/` answered for `/hifz` and rendered home.
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i += 1) {
    const seg = a[i]!;
    const actual = b[i];
    if (actual === undefined) return null;
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(actual);
    else if (seg !== actual) return null;
  }
  return params;
}

function depth(path: string): number {
  return path.split('/').filter((s) => s.length > 0).length;
}

function paramCount(path: string): number {
  return path.split('/').filter((s) => s.startsWith(':')).length;
}

export function resolveRoute(routes: readonly RouteDef[], path: string, query: Record<string, string>): Resolved {
  // Deepest pattern first so `/hifz/session/:id` wins over `/hifz/session`, and
  // among equal depths the literal path wins over one with parameters, so a
  // future `/quran/page/first` is not eaten by `/quran/page/:pageNumber`.
  const ordered = [...routes].sort(
    (x, y) => depth(y.path) - depth(x.path) || paramCount(x.path) - paramCount(y.path),
  );
  for (const route of ordered) {
    const params = match(route.path, path);
    if (params !== null) return { route, params, query, path };
  }
  return { route: null, params: {}, query, path };
}

export function useHashLocation(): { path: string; query: Record<string, string> } {
  const [loc, setLoc] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onHash = () => setLoc(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return loc;
}

export function navigate(to: string): void {
  const hash = to.startsWith('#') ? to : `#${to}`;
  if (window.location.hash === hash) return;
  window.location.hash = hash;
}

/** A link that behaves like a link: middle-click and copy-address work. */
export function useNavigate() {
  return useCallback((to: string) => navigate(to), []);
}

export function useRoute(routes: readonly RouteDef[]): Resolved {
  const { path, query } = useHashLocation();
  return useMemo(() => resolveRoute(routes, path, query), [routes, path, query]);
}
