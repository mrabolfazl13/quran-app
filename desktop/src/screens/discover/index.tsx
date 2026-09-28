/**
 * DISCOVER area — routes and nav entry, assembled by `app/registry.ts`.
 *
 * Search (the deterministic engine and its backend identity), the
 * mutashabihat browser (stored candidate pairs with word-level alignment),
 * the concept layer (an honest empty state until a concept pack and a
 * gateway read exist), and the optional word peek deep link.
 */
import type { Tr } from '../../app/app-state';
import type { NavItem, RouteDef } from '../../app/router';

import { routes as conceptRoutes } from './ConceptsScreen';
import { routes as mutashabihatRoutes } from './MutashabihatScreen';
import { routes as searchRoutes } from './SearchScreen';
import { routes as wordRoutes } from './WordPeekScreen';

export const routes: readonly RouteDef[] = [
  ...searchRoutes,
  ...mutashabihatRoutes,
  ...conceptRoutes,
  ...wordRoutes,
];

export const nav: readonly NavItem[] = [
  {
    label: (t: Tr) => t('کاوش', 'Discover'),
    to: '/discover',
    section: 'discover',
  },
];
