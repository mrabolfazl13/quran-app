/**
 * Enrolling the same verse twice must not open a second memory track.
 *
 * WHY this test exists at all: on the installed app, adding the range 112:1–4
 * twice left eight rows in `hifz_item` — two live tracks for every ayah, each
 * with its own stability and its own due date. The list showed two
 * indistinguishable `112:1` rows and the scheduler booked the same verse twice,
 * while the screen still reported «۴ آیه افزوده شد» for a range of four that
 * added nothing. `hifz_item` keys nothing on `verse_key`, so nothing below the
 * gateway stopped it; the rule now lives in the gateway both shells implement.
 *
 * The SQLite half is pinned in `tauri-gateway-statement-queue.test.ts`, where
 * the real-database harness already exists. This file covers the browser shell.
 *
 * `window` is stubbed because `DevGateway.touch()` schedules its debounced
 * IndexedDB write on a host timer. The timer is recorded and never advanced, so
 * nothing is persisted — which is also why no fake IndexedDB is needed here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerseKey } from '@quran/core';
import { DevGateway } from '../../desktop/src/gateway/devGateway';

const pending = new Map<number, () => void>();
let timerSeq = 1;
vi.stubGlobal('window', {
  setTimeout: (fn: () => void) => {
    const id = timerSeq;
    timerSeq += 1;
    pending.set(id, fn);
    return id;
  },
  clearTimeout: (id: number) => {
    pending.delete(id);
  },
});

describe('hifz enrolment keeps one live track per verse', () => {
  let gateway: DevGateway;

  beforeEach(() => {
    gateway = new DevGateway({ shell: 'dev' });
  });

  it('returns the item that exists instead of adding a second one', async () => {
    const first = await gateway.addHifzItem('112:1' as VerseKey);
    const again = await gateway.addHifzItem('112:1' as VerseKey);

    expect(again.id).toBe(first.id);
    expect(await gateway.hifzItems()).toHaveLength(1);
  });

  it('starts a fresh track when the previous one was dropped', async () => {
    const first = await gateway.addHifzItem('112:2' as VerseKey);
    await gateway.setHifzItemStatus(first.id, 'dropped');
    const againAfterDrop = await gateway.addHifzItem('112:2' as VerseKey);

    expect(againAfterDrop.id).not.toBe(first.id);
    expect(againAfterDrop.status).toBe('active');
    expect(await gateway.hifzItems('active')).toHaveLength(1);
  });

  it('leaves a paused verse alone rather than reviving it as a new row', async () => {
    const first = await gateway.addHifzItem('112:3' as VerseKey);
    await gateway.setHifzItemStatus(first.id, 'paused');
    const again = await gateway.addHifzItem('112:3' as VerseKey);

    expect(again.id).toBe(first.id);
    expect(await gateway.hifzItems()).toHaveLength(1);
  });
});
