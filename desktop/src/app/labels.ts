/**
 * How each execution shell introduces itself in the interface.
 *
 * Three gateways answer the same queries and the difference is real for the
 * reader: `tauri` stores in SQLite next to the installed app, `web` stores in
 * this browser on a machine that served the bundle, and `dev` does the same but
 * is throwaway. The wording lives in one place so the header chip, the line
 * under the search box and the data-health panel cannot drift apart.
 */
import type { Tr } from './app-state';
import type { GatewayMode } from '../gateway/types';

export function shellName(tr: Tr, mode: GatewayMode): string {
  if (mode === 'tauri') return tr('دسکتاپ', 'Desktop');
  if (mode === 'web') return tr('وب', 'Web');
  return tr('مرورگر (توسعه)', 'Browser (dev)');
}

export function shellSentence(tr: Tr, mode: GatewayMode): string {
  if (mode === 'tauri') return tr('دروازهٔ دادهٔ دسکتاپ', 'the desktop data gateway');
  if (mode === 'web') return tr('دروازهٔ دادهٔ نسخهٔ وب', 'the web build’s data gateway');
  return tr('دروازهٔ دادهٔ پوستهٔ توسعه', 'the browser dev-shell data gateway');
}

/**
 * True for both browser paths: neither has a native filesystem, so anything
 * "file-shaped" is really browser storage plus a manual pick/upload.
 */
export function storesFilesInBrowser(mode: GatewayMode): boolean {
  return mode !== 'tauri';
}
