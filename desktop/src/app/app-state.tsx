/**
 * The one place the UI is allowed to reach the storage boundary from.
 *
 * Every screen gets the gateway, the resolved shell info and the chrome
 * language/theme from here — no screen imports `tauriGateway` or `devGateway`
 * directly, and no screen guesses whether it is inside a Tauri window. That is
 * what keeps the same components portable to the web shell.
 *
 * Theme and language are persisted twice on purpose: `localStorage` (so the
 * pre-React inline script in index.html can apply them before first paint) and
 * the `settings` table under the keys `core/src/backup/settings.ts` allowlists,
 * so they travel with a backup and survive a reinstall.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import type { DataGateway, GatewayInfo } from '../gateway/types';
import { createGateway } from '../gateway';

export type UiLang = 'fa' | 'en';
/** `system` follows the OS; the resolved value is always light or dark. */
export type ThemePref = 'light' | 'dark' | 'system';

/** `(faText, enText) => string` — screens inline both, no central catalogue. */
export type Tr = (fa: string, en: string) => string;

export interface AppState {
  gateway: DataGateway | null;
  /** Null until `ready()` resolves; the shell shows the loading state then. */
  info: GatewayInfo | null;
  error: unknown;
  lang: UiLang;
  themePref: ThemePref;
  /** What `themePref` resolves to right now — what the CSS attributes carry. */
  theme: 'light' | 'dark';
  tr: Tr;
  setLang(lang: UiLang): void;
  setThemePref(pref: ThemePref): void;
  /** Re-open storage (after an import that replaced the file, or a failure). */
  reload(): Promise<void>;
}

const context = createContext<AppState | null>(null);

function prefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

function readLocal(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage disabled (private mode) — the preference still applies in-session */
  }
}

function asLang(value: string): UiLang {
  return value === 'en' ? 'en' : 'fa';
}

function asTheme(value: string): ThemePref {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [gateway, setGateway] = useState<DataGateway | null>(null);
  const [info, setInfo] = useState<GatewayInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [lang, setLang] = useState<UiLang>(() => asLang(readLocal('quran.uiLang', 'fa')));
  const [themePref, setThemePref] = useState<ThemePref>(() => asTheme(readLocal('quran.theme', 'system')));
  const [systemDark, setSystemDark] = useState(prefersDark);

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) return;
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const theme: 'light' | 'dark' = themePref === 'system' ? (systemDark ? 'dark' : 'light') : themePref;

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.lang = lang;
    root.dir = lang === 'en' ? 'ltr' : 'rtl';
  }, [theme, lang]);

  const open = useCallback(async () => {
    setError(null);
    try {
      const created = await createGateway();
      await created.ready();
      setGateway(created);
      setInfo(await created.info());
      // Stored settings win over the browser's own copy when they differ: the
      // database is the app's source of truth, localStorage is only a cache.
      const stored = await created.settings();
      if (stored['theme'] !== undefined) applyThemePref(asTheme(stored['theme'] ?? ''), false);
      if (stored['interfaceLanguage'] !== undefined) applyLang(asLang(stored['interfaceLanguage'] ?? ''), false);
    } catch (cause) {
      // A gateway that cannot open is a screen state, not a crash: the shell
      // keeps rendering and the error boundary explains what failed.
      setError(cause);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void open();
  }, [open]);

  function applyLang(next: UiLang, persist = true): void {
    setLang(next);
    writeLocal('quran.uiLang', next);
    if (persist) void gateway?.setSetting('interfaceLanguage', next).catch(() => undefined);
  }

  function applyThemePref(next: ThemePref, persist = true): void {
    setThemePref(next);
    writeLocal('quran.theme', next);
    if (persist) void gateway?.setSetting('theme', next).catch(() => undefined);
  }

  const tr = useCallback<Tr>((fa, en) => (lang === 'en' ? en : fa), [lang]);

  const value = useMemo<AppState>(
    () => ({
      gateway,
      info,
      error,
      lang,
      themePref,
      theme,
      tr,
      setLang: (next) => applyLang(next),
      setThemePref: (next) => applyThemePref(next),
      reload: open,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gateway, info, error, lang, themePref, theme, tr, open],
  );

  return <context.Provider value={value}>{children}</context.Provider>;
}

export function useApp(): AppState {
  const value = useContext(context);
  if (!value) throw new Error('useApp() called outside AppStateProvider');
  return value;
}

/** The gateway, once storage is open. Screens use it for every read or write. */
export function useGateway(): DataGateway {
  const { gateway } = useApp();
  if (!gateway) throw new Error('useGateway() called before the gateway opened');
  return gateway;
}

/** A `useAsync` helper lives in `ui/async.tsx`; this is the data it queries. */
export function useTr(): Tr {
  return useApp().tr;
}
