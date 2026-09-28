/**
 * One entry point, three execution modes.
 *
 * `detectMode()` asks the window whether a Tauri host is present — nothing in
 * the app branches on build flags, so the same components, the same import
 * pipeline and the same contracts run in every shell:
 *
 * • `tauri` — the packaged desktop app: SQLite behind a native command layer.
 * • `web`   — the built bundle served over HTTP (`scripts/serveWeb.mjs`): a
 *   shipped path, so its storage is the browser's own and its content is
 *   imported from that origin on startup without being asked.
 * • `dev`   — `vite dev`: the same code path as `web`, announced as throwaway
 *   because it exists for UI iteration, not for users.
 *
 * Only `tauri` is detected from the host; `web` vs `dev` is the build mode,
 * because a dev server and a built bundle are not the same deliverable even
 * when both answer on localhost. Any of the three can be forced (`?shell=web`,
 * or the persisted preference) to compare one path against another.
 */
import type { DataGateway, GatewayMode } from './types';

const SHELLS: readonly GatewayMode[] = ['tauri', 'web', 'dev'];

function asShell(value: string | null): GatewayMode | null {
  return SHELLS.includes(value as GatewayMode) ? (value as GatewayMode) : null;
}

export async function detectMode(): Promise<GatewayMode> {
  const url = new URL(window.location.href);
  const forced = asShell(url.searchParams.get('shell'));
  if (forced) return forced;
  try {
    const stored = asShell(window.localStorage.getItem('quran.forcedShell'));
    if (stored) return stored;
  } catch {
    /* storage disabled — fall through */
  }
  const w = window as unknown as Record<string, unknown>;
  const insideTauri = '__TAURI_INTERNALS__' in w || '__TAURI__' in w;
  if (insideTauri) return 'tauri';
  // A built bundle has no dev server to talk to and no native host to serve it:
  // it is the web deliverable, and it is meant to look like one.
  return import.meta.env.PROD ? 'web' : 'dev';
}

export async function createGateway(): Promise<DataGateway> {
  const mode = await detectMode();
  if (mode === 'tauri') {
    const { TauriGateway } = await import('./tauriGateway');
    return new TauriGateway();
  }
  const { DevGateway } = await import('./devGateway');
  return new DevGateway({ shell: mode });
}

export type { DataGateway };
export { emptyPlan } from './types';
