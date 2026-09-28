/**
 * One entry point, two execution modes.
 *
 * `detectMode()` asks the window whether a Tauri host is present — nothing in
 * the app branches on build flags, so the same components, the same import
 * pipeline and the same contracts run in both shells.
 *
 * The dev shell can also be forced (`?shell=dev` or the persisted preference) so
 * a real Tauri window can be pointed at the browser code path for comparison.
 */
import type { DataGateway, GatewayMode } from './types';

export async function detectMode(): Promise<GatewayMode> {
  const url = new URL(window.location.href);
  const forced = url.searchParams.get('shell');
  if (forced === 'dev' || forced === 'tauri') return forced;
  try {
    const stored = window.localStorage.getItem('quran.forcedShell');
    if (stored === 'dev' || stored === 'tauri') return stored;
  } catch {
    /* storage disabled — fall through */
  }
  const w = window as unknown as Record<string, unknown>;
  const insideTauri = '__TAURI_INTERNALS__' in w || '__TAURI__' in w;
  return insideTauri ? 'tauri' : 'dev';
}

export async function createGateway(): Promise<DataGateway> {
  const mode = await detectMode();
  if (mode === 'tauri') {
    const { TauriGateway } = await import('./tauriGateway');
    return new TauriGateway();
  }
  const { DevGateway } = await import('./devGateway');
  return new DevGateway();
}

export type { DataGateway };
export { emptyPlan } from './types';
