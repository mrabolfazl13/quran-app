import type { NavItem, RouteDef } from '../../app/router';

import { HomeScreen } from './HomeScreen';

const title = (t: (fa: string, en: string) => string) => t('خانه', 'Home');

export const routes: readonly RouteDef[] = [
  { path: '/', title, section: 'home', component: HomeScreen },
];

export const nav: readonly NavItem[] = [
  { label: (t) => t('خانه', 'Home'), to: '/', section: 'home' },
];
