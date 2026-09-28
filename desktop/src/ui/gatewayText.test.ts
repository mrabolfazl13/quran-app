import { describe, expect, it } from 'vitest';

import type { Tr } from '../app/app-state';
import type { GatewayLabelId, GatewayStoreId, SearchNoteId } from '../gateway/types';
import { gatewayLabel, gatewayStore, searchNote } from './gatewayText';

/**
 * These ids exist because prose from below the language boundary — the gateway,
 * which has no `tr` — ended up inside the Persian interface. A missing switch
 * case is already a compile error, so what this pins is the other failure: an
 * entry whose Persian is the English sentence copy-pasted.
 */
const LABELS: GatewayLabelId[] = ['tauri-sqlite', 'web-http', 'dev-shell'];
const STORES: GatewayStoreId[] = [
  'sqlite-file',
  'browser-store-plus-origin-content',
  'browser-store-plus-memory-content',
];
const NOTES: SearchNoteId[] = [
  'fts5-order-plus-substring',
  'fts5-unavailable',
  'memory-index-dev',
  'memory-index-web',
];

const asFa: Tr = (fa) => fa;
const asEn: Tr = (_fa, en) => en;

// Persian letters live in the same block as Arabic, so one range covers both.
const PERSIAN = /[؀-ۿ]/;

describe('gateway prose reaches the UI in the interface language', () => {
  const cases: [string, (tr: Tr, id: string) => string, string[]][] = [
    ['shell label', (tr, id) => gatewayLabel(tr, id as GatewayLabelId), LABELS],
    ['storage', (tr, id) => gatewayStore(tr, id as GatewayStoreId), STORES],
    ['search note', (tr, id) => searchNote(tr, id as SearchNoteId), NOTES],
  ];

  for (const [what, render, ids] of cases) {
    it(`writes every ${what} id in Persian and in English`, () => {
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        const fa = render(asFa, id);
        const en = render(asEn, id);
        expect(fa).toMatch(PERSIAN);
        expect(en).toMatch(/[A-Za-z]{3}/);
        expect(fa).not.toBe(en);
      }
    });
  }

  it('describes the shell it is, not another one', () => {
    // The web build calling itself a dev shell was defect 12.
    expect(gatewayLabel(asFa, 'web-http')).not.toMatch(/توسعه/);
    expect(gatewayLabel(asFa, 'dev-shell')).toMatch(/توسعه/);
    expect(searchNote(asFa, 'memory-index-web')).not.toMatch(/پوستهٔ توسعه/);
    expect(searchNote(asFa, 'memory-index-dev')).toMatch(/پوستهٔ توسعه/);
  });
});
