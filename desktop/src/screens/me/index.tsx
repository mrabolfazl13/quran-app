/**
 * The ME area: settings, data health, backup/restore, notes, about.
 *
 * One sidebar entry (the shell highlights by `section`, so five entries would
 * all light up at once); the sub-screens link to each other through `MeTabs`.
 *
 * Importing this module also applies the cached font scales before React paints
 * — see `font-scale.ts` for why the pre-paint pass exists.
 */
import type { NavItem, RouteDef } from '../../app/router';

import { applyCachedFontScales } from './font-scale';
import { routes as settingsRoutes } from './SettingsScreen';
import { routes as contentRoutes } from './ContentHealthScreen';
import { routes as backupRoutes } from './BackupScreen';
import { routes as notesRoutes } from './NotesScreen';
import { routes as aboutRoutes } from './AboutScreen';

applyCachedFontScales();

export const routes: readonly RouteDef[] = [
  ...settingsRoutes,
  ...contentRoutes,
  ...backupRoutes,
  ...notesRoutes,
  ...aboutRoutes,
];

export const nav: readonly NavItem[] = [
  { label: (t) => t('من', 'Me'), to: '/me', section: 'me' },
];
