/**
 * HIFZ area — route table and sidebar entry.
 *
 * `section` is `hifz` for every route so the sidebar keeps the area lit on all
 * seven screens. Assembly happens in `app/registry.ts`; nothing outside this
 * folder registers a hifz path.
 */
import type { RouteDef } from '../../app/router';
import type { Tr } from '../../app/app-state';
import { HifzTodayScreen } from './HifzTodayScreen';
import { SessionRunnerScreen } from './SessionRunnerScreen';
import { SessionReportScreen } from './SessionReportScreen';
import { ItemsScreen } from './ItemsScreen';
import { ReviewScreen } from './ReviewScreen';
import { WeakScreen } from './WeakScreen';
import { ConfusionScreen } from './ConfusionScreen';
import { ProgressScreen } from './ProgressScreen';

export const routes: readonly RouteDef[] = [
  { path: '/hifz', title: (t: Tr) => t('حفظ — مأموریت امروز', 'Hifz — today’s mission'), section: 'hifz', component: HifzTodayScreen },
  { path: '/hifz/session', title: (t: Tr) => t('نشست حفظ', 'Hifz session'), section: 'hifz', component: SessionRunnerScreen },
  { path: '/hifz/session/:id', title: (t: Tr) => t('گزارش نشست', 'Session report'), section: 'hifz', component: SessionReportScreen },
  { path: '/hifz/items', title: (t: Tr) => t('آیات حفظ', 'Hifz items'), section: 'hifz', component: ItemsScreen },
  { path: '/hifz/review', title: (t: Tr) => t('صف مرور', 'Review queue'), section: 'hifz', component: ReviewScreen },
  { path: '/hifz/weak', title: (t: Tr) => t('نقاط ضعف', 'Weak spots'), section: 'hifz', component: WeakScreen },
  { path: '/hifz/confusion', title: (t: Tr) => t('اشتباه با آیات مشابه', 'Confused similar ayat'), section: 'hifz', component: ConfusionScreen },
  { path: '/hifz/progress', title: (t: Tr) => t('پیشرفت حفظ', 'Hifz progress'), section: 'hifz', component: ProgressScreen },
];

export const nav = [{ label: (t: Tr) => t('حفظ', 'Hifz'), to: '/hifz', section: 'hifz' }];
