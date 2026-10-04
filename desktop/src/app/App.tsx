/**
 * The application shell: navigation, header, route outlet.
 *
 * It owns exactly two things — where storage came from (the badge in the header
 * is the only place the dev/shipped distinction is printed) and which screen is
 * mounted. Screens never render their own chrome, so the nav cannot drift
 * between areas.
 *
 * Nav geometry is the shell's other job: the same five destinations are a bottom
 * tab bar on a phone, an icon rail on a tablet and a labelled sidebar on a
 * desktop (`app/shell.css`). Icons live here rather than in `app/registry.ts`
 * because areas are authored by other hands and must not have to know the icon
 * family; an unknown section falls back to a neutral glyph instead of crashing.
 */
import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';

import { useApp } from './app-state';
import { shellName } from './labels';
import { NAV, ROUTES } from './registry';
import { navigate, useRoute, type NavItem } from './router';
import { StateBoundary, useAsync } from '../ui/async';
import { gatewayLabel, gatewayStore } from '../ui/gatewayText';
import {
  IconBookOpen,
  IconCompass,
  IconContrast,
  IconHome,
  IconLayers,
  IconMonitor,
  IconMoon,
  IconMore,
  IconSun,
  IconUser,
  type IconProps,
} from '../ui/icons';
import { Chip, splitNavItems } from '../ui/primitives';
import './shell.css';

/** section → glyph. Keyed by section, not by path, so sub-routes stay marked. */
const NAV_ICONS: Record<string, ComponentType<IconProps>> = {
  home: IconHome,
  quran: IconBookOpen,
  hifz: IconMoon,
  discover: IconCompass,
  me: IconUser,
};

function navIcon(section: string): ComponentType<IconProps> {
  return NAV_ICONS[section] ?? IconLayers;
}

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

function NavEntry({
  item,
  active,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  onNavigate: (to: string) => void;
}) {
  const { tr } = useApp();
  const Icon = navIcon(item.section);
  return (
    <a
      className={`navlink ${active ? 'is-active' : ''}`}
      href={`#${item.to}`}
      aria-current={active ? 'page' : undefined}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey) return;
        event.preventDefault();
        onNavigate(item.to);
      }}
    >
      <span className="navlink__icon" aria-hidden="true">
        <Icon size={22} />
      </span>
      <span className="navlink__label">{item.label(tr)}</span>
    </a>
  );
}

function HeaderRight() {
  const { tr, themePref, setThemePref, lang, setLang, info } = useApp();
  const ThemeIcon = themePref === 'dark' ? IconContrast : themePref === 'light' ? IconSun : IconMonitor;
  const themeName = tr(`پوسته: ${themePref} — برای تغییر کلیک کنید`, `Theme: ${themePref} — click to change`);
  return (
    <div className="header__right">
      <OnlineChip />
      {info ? (
        <Chip
          tone={info.isShippedPath ? 'accent' : 'warn'}
          title={`${gatewayLabel(tr, info.labelId)} · ${gatewayStore(tr, info.storeId)}`}
        >
          {shellName(tr, info.mode)}
        </Chip>
      ) : null}
      {/*
        Both controls are icon-or-letter only, so `title` alone gives a screen
        reader nothing: the name lives in `aria-label` (both languages, same
        `tr`), the glyph itself is `aria-hidden`, and the global
        `:focus-visible` ring in `ui/ui.css` still paints because neither
        button overrides `outline`/`box-shadow`.
      */}
      <button
        type="button"
        className="btn btn--ghost btn--icon"
        onClick={() => setThemePref(themePref === 'dark' ? 'light' : themePref === 'light' ? 'system' : 'dark')}
        aria-label={tr('تغییر پوسته', 'Change theme')}
        title={themeName}
      >
        <span className="navlink__icon" aria-hidden="true">
          <ThemeIcon size={20} />
        </span>
      </button>
      <button
        type="button"
        className="btn btn--ghost btn--icon"
        onClick={() => setLang(lang === 'fa' ? 'en' : 'fa')}
        aria-label={
          lang === 'fa'
            ? tr('تغییر زبان رابط به انگلیسی', 'Change the interface language to English')
            : tr('تغییر زبان رابط به فارسی', 'Change the interface language to Persian')
        }
        title={tr('زبان رابط: فارسی / English', 'Interface language: فارسی / English')}
      >
        {/* Two letters, not a pictograph: the glyph IS the label here. */}
        <span aria-hidden="true">{lang === 'fa' ? 'EN' : 'فا'}</span>
      </button>
    </div>
  );
}

function Sidebar({ activeSection }: { activeSection: string }) {
  const { tr } = useApp();
  // Five destinations fit the phone tab bar; a sixth moves into «بیشتر» rather
  // than shrinking the tap targets below 44px.
  const { tabs, overflow } = useMemo(() => splitNavItems([...NAV]), []);
  const overflowActive = overflow.some((item) => item.section === activeSection);
  const go = (to: string) => navigate(to);

  return (
    <nav className="sidebar" aria-label={tr('بخش‌ها', 'Sections')}>
      <ul className="navlist">
        {tabs.map((item) => (
          <li key={item.section}>
            <NavEntry item={item} active={item.section === activeSection} onNavigate={go} />
          </li>
        ))}
        {overflow.length ? (
          <li className="navmore">
            {/* Uncontrolled: the browser owns open/close, so back-forward and
                Escape stay predictable; an active child only keeps the control
                marked, never forces the sheet open. */}
            <details>
              <summary className={overflowActive ? 'is-active' : undefined}>
                <span className="navmore__btn">
                  <span className="navlink__icon" aria-hidden="true">
                    <IconMore size={22} />
                  </span>
                  <span className="navlink__label">{tr('بیشتر', 'More')}</span>
                </span>
              </summary>
              <ul className="navmore__list">
                {overflow.map((item) => (
                  <li key={item.section}>
                    <NavEntry item={item} active={item.section === activeSection} onNavigate={go} />
                  </li>
                ))}
              </ul>
            </details>
          </li>
        ) : null}
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
