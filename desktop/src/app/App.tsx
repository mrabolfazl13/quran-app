/**
 * The application shell: sidebar, header, route outlet.
 *
 * It owns exactly two things — where storage came from (the badge in the header
 * is the only place the dev/shipped distinction is printed) and which screen is
 * mounted. Screens never render their own chrome, so the nav cannot drift
 * between areas.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { useApp } from './app-state';
import { NAV, ROUTES } from './registry';
import { navigate, useRoute } from './router';
import { StateBoundary, useAsync } from '../ui/async';
import { Chip } from '../ui/primitives';
import './shell.css';

function OnlineChip() {
  const { tr } = useApp();
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  // The app is designed to work with no network at all, so being offline is
  // stated as a fact, never as an error.
  return online ? null : (
    <Chip tone="info" title={tr('هیچ ویژگی‌ای به شبکه نیاز ندارد', 'No feature needs the network')}>
      {tr('آفلاین', 'Offline')}
    </Chip>
  );
}

function HeaderRight() {
  const { tr, themePref, setThemePref, lang, setLang, info } = useApp();
  return (
    <div className="header__right">
      <OnlineChip />
      {info ? (
        <Chip tone={info.isShippedPath ? 'accent' : 'warn'} title={`${info.label} · ${info.database ?? '—'}`}>
          {info.mode === 'tauri'
            ? tr('دسکتاپ', 'Desktop')
            : tr('مرورگر (توسعه)', 'Browser (dev)')}
        </Chip>
      ) : null}
      <button
        type="button"
        className="btn btn--ghost"
        onClick={() => setThemePref(themePref === 'dark' ? 'light' : themePref === 'light' ? 'system' : 'dark')}
        title={tr(`پوسته: ${themePref} — برای تغییر کلیک کنید`, `Theme: ${themePref} — click to change`)}
      >
        {themePref === 'dark' ? '◐' : themePref === 'light' ? '◑' : '◒'}
      </button>
      <button
        type="button"
        className="btn btn--ghost"
        onClick={() => setLang(lang === 'fa' ? 'en' : 'fa')}
        title={tr('زبان رابط: فارسی / English', 'Interface language: فارسی / English')}
      >
        {lang === 'fa' ? 'EN' : 'فا'}
      </button>
    </div>
  );
}

function Sidebar({ activeSection }: { activeSection: string }) {
  const { tr } = useApp();
  return (
    <nav className="sidebar" aria-label={tr('بخش‌ها', 'Sections')}>
      <ul>
        {NAV.map((item) => (
          <li key={item.section}>
            <a
              className={`navlink ${item.section === activeSection ? 'is-active' : ''}`}
              href={`#${item.to}`}
              aria-current={item.section === activeSection ? 'page' : undefined}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey) return;
                event.preventDefault();
                navigate(item.to);
              }}
            >
              {item.label(tr)}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The data-health probe the shell shows when storage itself is the problem. */
function BootBoundary({ children }: { children: ReactNode }) {
  const { tr, info, error, reload } = useApp();
  const state = useAsync(async () => {
    if (error) throw error;
    if (!info) throw new Error(tr('هنوز باز نشده است', 'Storage has not opened yet'));
    return true;
  }, [error, info, tr]);
  return (
    <StateBoundary
      state={state}
      emptyTitle={tr('ذخیره‌گاه باز نشد', 'Storage did not open')}
      isEmpty={() => false}
      onRetry={() => void reload()}
      skeleton={<div className="state state--loading" role="status">{tr('باز کردن ذخیره‌گاه…', 'Opening storage…')}</div>}
    >
      {() => <>{children}</>}
    </StateBoundary>
  );
}

export function App() {
  const { tr } = useApp();
  const resolved = useRoute(ROUTES);

  const title = useMemo(() => {
    if (resolved.route) return resolved.route.title(tr);
    return tr('صفحه پیدا نشد', 'Page not found');
  }, [resolved.route, tr]);

  useEffect(() => {
    document.title = `${title} — قرآن`;
  }, [title]);

  const Body = resolved.route?.component;

  return (
    <BootBoundary>
      <div className="shell">
        <Sidebar activeSection={resolved.route?.section ?? ''} />
        <div className="shell__main">
          <header className="header">
            <h1 className="header__title">{title}</h1>
            <HeaderRight />
          </header>
          <main className="content">
            {Body ? (
              <Body params={resolved.params} query={resolved.query} />
            ) : (
              <div className="state state--empty">
                <h3>{tr('چنین صفحه‌ای وجود ندارد', 'There is no such page')}</h3>
                <p className="muted mono">{resolved.path || '/'}</p>
                <button type="button" className="btn btn--primary" onClick={() => navigate('/')}>
                  {tr('بازگشت به خانه', 'Back to home')}
                </button>
              </div>
            )}
          </main>
        </div>
      </div>
    </BootBoundary>
  );
}
