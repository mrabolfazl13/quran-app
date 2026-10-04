/**
 * A restore in the browser must be durable before the screen reports success.
 *
 * WHY this test exists at all: the installed web build restored a legitimate
 * `.quranbak` and reported success, and the bookmark in that file was gone again
 * after the shell reloaded. `DevGateway.importBackup` handed the write to
 * `touch()`, which is a 350 ms debounced `setTimeout`, and the backup screen
 * reloads the page as soon as a restore returns `ok` — the pending timer died
    with the page and IndexedDB never saw the restored rows. So the fake `window`
 * below records debounce callbacks and NEVER runs them: a restore that still
 * relies on the timer cannot pass.
 *
 * It also pins the file's provenance. The web build is a shipped producer, so a
 * file it writes says `quran-web` / `web`; claiming `desktop` would misreport
 * which app produced the bytes a user carries between browsers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackupEnvelope, RecallAttempt, VerseKey } from '@quran/core';
import { computeDataChecksum, validateEnvelopeObject } from '@quran/core';
import { DevGateway } from '../../desktop/src/gateway/devGateway';

/** Store name → key → value. One store (`userdata`) is enough for the gateway. */
const stores = new Map<string, Map<string, unknown>>();

function fire(req: { onsuccess?: () => void; onerror?: () => void }): void {
  queueMicrotask(() => req.onsuccess?.());
}

function fakeIndexedDb(): IDBDatabase {
  return {
    objectStoreNames: { contains: (name: string) => stores.has(name) } as unknown as DOMStringList,
    createObjectStore(name: string) {
      if (!stores.has(name)) stores.set(name, new Map());
      return {} as IDBObjectStore;
    },
    transaction(name: string) {
      const data = stores.get(name) ?? new Map<string, unknown>();
      stores.set(name, data);
      const tx: { oncomplete?: () => void; objectStore: () => unknown } = {
        oncomplete: undefined,
        objectStore: () => ({
          put(value: unknown, key: string) {
            data.set(key, structuredClone(value));
            const req: { onsuccess?: () => void } = {};
            fire(req);
            return req as unknown as IDBRequest;
          },
          get(key: string) {
            const req: { result?: unknown; onsuccess?: () => void } = { result: data.get(key) };
            fire(req);
            return req as unknown as IDBRequest;
          },
        }),
      };
      // `oncomplete` is read back off this same object: the gateway assigns the
      // callback after the transaction exists, exactly as the real API works.
      queueMicrotask(() => tx.oncomplete?.());
      return tx as unknown as IDBTransaction;
    },
    close() {
      /* nothing to release in memory */
    },
  } as unknown as IDBDatabase;
}

/** Debounce callbacks the page would have run — and never gets to, by design. */
let pendingTimers: (() => void)[];

beforeEach(() => {
  stores.clear();
  stores.set('userdata', new Map());
  pendingTimers = [];
  vi.stubGlobal('indexedDB', {
    open() {
      const req: {
        result?: unknown;
        onsuccess?: () => void;
        onupgradeneeded?: () => void;
        onerror?: () => void;
      } = {};
      queueMicrotask(() => {
        req.result = fakeIndexedDb();
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory);
  vi.stubGlobal('window', {
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
    setTimeout: (fn: () => void) => {
      pendingTimers.push(fn);
      return pendingTimers.length;
    },
    clearTimeout: () => undefined,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DevGateway backup — what survives a reload', () => {
  it('writes restored rows durably, not on a debounce the reload will kill', async () => {
    const gateway = new DevGateway({ shell: 'dev' });
    await gateway.ready();
    const key = '2:255' as VerseKey;
    await gateway.setSetting('theme', 'dark');
    const bookmark = await gateway.addBookmark({ verseKey: key, label: 'آیةالکرسی' });
    await gateway.saveDailyPlan('2026-01-05', JSON.stringify({ date: '2026-01-05', newAyahs: [], reviewItems: [], weakItems: [], confusionGroups: [], estimatedMinutes: 0 }));
    pendingTimers.length = 0;

    const envelope = await gateway.exportBackup();
    expect(envelope.producedBy).toEqual({ app: 'quran-dev-shell', version: '0.1.0', platform: 'web' });
    expect(computeDataChecksum(envelope.data)).toBe(envelope.checksum);

    await gateway.removeBookmark(bookmark.id);
    expect(await gateway.bookmarks()).toEqual([]);

    const restore = await gateway.importBackup(envelope);
    expect(restore.ok, JSON.stringify(restore.error ?? restore)).toBe(true);

    // The reload: a brand new gateway reading the same store. Anything still
    // sitting in `pendingTimers` is lost at this point, exactly as it is in the
    // browser, so only an awaited write can make this pass.
    const reloaded = new DevGateway({ shell: 'dev' });
    await reloaded.ready();
    const marks = await reloaded.bookmarks();
    expect(marks.map((m) => m.verseKey)).toEqual([key]);
    expect(marks[0]?.label).toBe('آیةالکرسی');
    expect(await reloaded.settings()).toMatchObject({ theme: 'dark' });
    expect(await reloaded.dailyPlan('2026-01-05')).not.toBeNull();
  });

  it('accepts its own envelope through the same validator the backup screen uses', async () => {
    const gateway = new DevGateway({ shell: 'dev' });
    await gateway.ready();
    await gateway.addBookmark({ verseKey: '1:1' as VerseKey });
    const envelope = await gateway.exportBackup();
    const check = validateEnvelopeObject(JSON.parse(JSON.stringify(envelope)));
    expect(check.ok, JSON.stringify(check.ok ? check.warnings : check.errors)).toBe(true);
  });

  it('reports the web build as the producer of a web file', async () => {
    // No `ready()` here: the web shell would auto-import, and provenance is a
    // property of the writer, not of the corpus.
    const web = new DevGateway({ shell: 'web' });
    const envelope = await web.exportBackup();
    expect(envelope.producedBy).toEqual({ app: 'quran-web', version: '0.1.0', platform: 'web' });
  });
});

/**
 * The browser store has no SQLite to enforce `hifz_attempt.item_id … ON DELETE
 * CASCADE`, so the gateway has to be the cascade itself. It was not: removing an
 * ayah pruned its segments, anchors and transitions and left every graded
 * attempt behind — orphan rows that keep feeding stability, the review queue and
 * the backup counts for an ayah the learner deleted, and a web user whose data
 * diverges from a desktop user's on the same action. The E2E journey catches this
 * at device level (`the user rows are deleted through the UI`); this pins it at
 * storage level so the fix is named, not just observed.
 */
describe('DevGateway hifz cascade — the schema promise without SQLite', () => {
  const attemptFor = (itemId: string): RecallAttempt => ({
    id: `att-${itemId}-1`,
    itemId,
    verseKey: '112:1',
    sessionId: null,
    mode: 'full-ayah',
    dimension: 'form',
    startedAt: '2026-09-29T09:00:00.000Z',
    completedAt: '2026-09-29T09:00:12.000Z',
    produced: [{ position: 1, text: 'قُلْ' }],
    cue: null,
    expectedWordCount: 4,
    correctWordCount: 1,
    accuracy: 0.25,
    errors: [],
    durationMs: 12_000,
    selfConfidence: null,
    usedAudio: false,
  });

  it('takes a stored attempt with the item it belongs to, durably', async () => {
    const gateway = new DevGateway({ shell: 'dev' });
    await gateway.ready();
    const item = await gateway.addHifzItem('112:1' as VerseKey);
    await gateway.saveRecallAttempt(attemptFor(item.id));
    expect((await gateway.recallAttempts(item.id)).length).toBe(1);

    await gateway.removeHifzItem(item.id);
    expect(await gateway.recallAttempts(), 'an attempt cannot outlive its item').toEqual([]);
    expect(await gateway.hifzItems()).toEqual([]);

    // And it stays deleted: the writes above still sit in `pendingTimers`, which
    // a reload throws away, so only an awaited cascade survives to the next page.
    pendingTimers.length = 0;
    const reloaded = new DevGateway({ shell: 'dev' });
    await reloaded.ready();
    expect(await reloaded.recallAttempts()).toEqual([]);
    expect(await reloaded.hifzItems()).toEqual([]);
  });
});
