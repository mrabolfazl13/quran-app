/**
 * The QURAN area's route table and sidebar entry.
 *
 * Six paths, all in `section: 'quran'`: the surah index, the chapter reader, the
 * single-ayah focus view, the juz index and a juz, the mushaf page, and the
 * bookmark shelf. Every path is a real screen — nothing here advertises a route
 * that does not resolve, which `app/registry.ts` asserts at module load.
 */
import type { NavItem, RouteDef } from '../../app/router';
import type { Tr } from '../../app/app-state';

import { AyahFocusScreen } from './AyahFocusScreen';
import { BookmarksScreen } from './BookmarksScreen';
import { JuzIndexScreen, JuzScreen } from './JuzScreen';
import { PageScreen } from './PageScreen';
import { SurahIndexScreen } from './SurahIndexScreen';
import { SurahReaderScreen } from './SurahReaderScreen';

/** `/quran/surah/:number` and friends read their parameters from props. */
function asRoute(path: string, title: (tr: Tr) => string, component: RouteDef['component']): RouteDef {
  return { path, title, section: 'quran', component };
}

export const routes: readonly RouteDef[] = [
  asRoute('/quran', (t) => t('فهرس سوره‌ها', 'Surah index'), SurahIndexScreen),
  asRoute('/quran/surah/:number', (t) => t('خواندن سوره', 'Surah reader'), SurahReaderScreen),
  asRoute('/quran/ayah/:verseKey', (t) => t('یک آیه', 'Single ayah'), AyahFocusScreen),
  asRoute('/quran/juz', (t) => t('اجزای سی‌گانه', 'Juz index'), JuzIndexScreen),
  asRoute('/quran/juz/:juz', (t) => t('جزء', 'Juz'), JuzScreen),
  asRoute('/quran/page/:pageNumber', (t) => t('صفحهٔ مصحف', 'Mushaf page'), PageScreen),
  asRoute('/quran/bookmarks', (t) => t('نشانک‌ها', 'Bookmarks'), BookmarksScreen),
];

export const nav: readonly NavItem[] = [
  { label: (t: Tr) => t('قرآن', 'Quran'), to: '/quran', section: 'quran' },
];
