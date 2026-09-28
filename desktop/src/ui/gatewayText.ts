/**
 * The gateway speaks ids, the interface speaks Persian.
 *
 * `GatewayInfo` and the search services used to return finished English
 * sentences, which then appeared verbatim in the middle of a Persian page — the
 * same failure defect 7 was for the review scheduler's reason prose. The rule
 * this file enforces: anything below the language boundary emits a key, and the
 * switch below is exhaustive by construction (no `default`), so a new id is a
 * build error until it has both languages.
 */
import type { GatewayLabelId, GatewayStoreId, SearchNoteId } from '../gateway/types';
import type { Tr } from '../app/app-state';

export function gatewayLabel(tr: Tr, id: GatewayLabelId): string {
  switch (id) {
    case 'tauri-sqlite':
      return tr('پایگاه دادهٔ Tauri + SQLite (نسخهٔ نصبی)', 'Tauri + SQLite (shipped path)');
    case 'web-http':
      return tr(
        'وب‌اپ سروشده روی HTTP — همان کد، ذخیرهٔ مرورگر',
        'Web app served over HTTP — same code, browser storage',
      );
    case 'dev-shell':
      return tr('پوستهٔ توسعهٔ مرورگر — نسخهٔ بسته‌بندی‌شده نیست', 'Browser dev shell — not the packaged app');
  }
}

/**
 * Where the user's rows are. The path itself is data, not prose — a screen that
 * has one (`info.databasePath`) renders it next to this, as its own LTR run, so
 * a Windows path cannot flip around inside an RTL sentence.
 */
export function gatewayStore(tr: Tr, id: GatewayStoreId): string {
  switch (id) {
    case 'sqlite-file':
      return tr('فایل SQLite', 'SQLite file');
    case 'browser-store-plus-origin-content':
      return tr(
        'IndexedDB — دادهٔ کاربر در مرورگر، محتوا از همین مبدأ',
        'IndexedDB — user rows in this browser, content served by this origin',
      );
    case 'browser-store-plus-memory-content':
      return tr(
        'IndexedDB — دادهٔ کاربر در مرورگر، محتوا در حافظه',
        'IndexedDB — user rows in this browser, content held in memory',
      );
  }
}

export function searchNote(tr: Tr, id: SearchNoteId): string {
  switch (id) {
    case 'fts5-order-plus-substring':
      return tr(
        'جست‌وجو در جدول نرمال‌شدهٔ SQLite: ترتیب bm25 ماژول FTS5 روی متن عربی، و تطبیق زیررشته روی ترجمه‌های فارسی و انگلیسی',
        'SQLite ayah_search: FTS5 bm25 order on the normalised Arabic column, normalised substring (LIKE) matching on the Persian and English translation columns',
      );
    case 'fts5-unavailable':
      return tr(
        'ماژول FTS5 در این ساخت SQLite نیست؛ تطبیق زیررشته روی همهٔ ستون‌ها از جمله عربی',
        'FTS5 module unavailable in this SQLite build — normalised substring (LIKE) matching on every column, Arabic included',
      );
    case 'memory-index-dev':
      return tr(
        'نمایهٔ در حافظهٔ همین پوستهٔ توسعه — همان فضای کلیدهای تطبیق',
        'Browser dev shell index — same matchKey space, held in memory',
      );
    case 'memory-index-web':
      return tr(
        'نمایهٔ در حافظه روی بسته‌هایی که همین مبدأ می‌دهد — همان فضای کلیدهای تطبیق برنامهٔ دسکتاپ',
        'Memory index over the packs served by this origin — same matchKey space as the desktop app',
      );
  }
}
