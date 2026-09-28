/**
 * The route and navigation registry.
 *
 * Each screen area owns its own `screens/<area>/index.tsx` and exports
 * `routes` + `nav`; this file only assembles them. Keeping the table here means
 * an area can be built by a different hand without two people editing the shell,
 * and the sidebar can never advertise a route that does not resolve (the
 * development-time assertion below catches exactly that).
 */
import type { NavItem, RouteDef } from './router';

import { nav as discoverNav, routes as discoverRoutes } from '../screens/discover';
import { nav as hifzNav, routes as hifzRoutes } from '../screens/hifz';
import { nav as homeNav, routes as homeRoutes } from '../screens/home';
import { nav as meNav, routes as meRoutes } from '../screens/me';
import { nav as quranNav, routes as quranRoutes } from '../screens/quran';

export const ROUTES: readonly RouteDef[] = [
  ...homeRoutes,
  ...quranRoutes,
  ...hifzRoutes,
  ...discoverRoutes,
  ...meRoutes,
];

export const NAV: readonly NavItem[] = [...homeNav, ...quranNav, ...hifzNav, ...discoverNav, ...meNav];

const PATHS = new Set(ROUTES.map((r) => r.path));
for (const item of NAV) {
  const target = item.to.replace(/^#/, '').split('?')[0] ?? '/';
  const normalised = target.replace(/\/+$/, '') || '/';
  // A nav entry that points at a parameterised route is allowed to name the
  // pattern's parent, e.g. `/hifz` for `/hifz/session/:id`.
  if (!PATHS.has(normalised) && ![...PATHS].some((p) => p.startsWith(`${normalised}/`))) {
    throw new Error(`nav entry ${item.to} resolves to no route (registered paths: ${[...PATHS].join(', ')})`);
  }
}
