/**
 * Reader data hooks — everything the mushaf screens need that is not a query.
 *
 * Three constraints shape this file:
 *   • a chapter has up to 286 ayat, so word rows and translations are fetched in
 *     batches and applied in flushes, never one React update per row;
 *   • the gateway has no batch word endpoint, so `useWordBank` walks the chapter
 *     with a bounded queue and lets the viewport cut in line;
 *   • every write (bookmark, hifz item, setting, reading position) is optimistic
 *     over local state and re-read only on failure — no spinner per keystroke.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { VerseKey } from '@quran/core';
import type { AyahWordRow, Bookmark, DataGateway, HifzItem, TranslationOption } from '../../gateway/types';
import { useAsync } from '../../ui/async';
import { chapterOf, scrollFraction } from './lib';

/** Rows are fetched per ayah because the gateway exposes no `wordsByChapter`. */
const WORD_CONCURRENCY = 3;
/** Loaded rows are applied in flushes, not one state update per fetch. */
const WORD_FLUSH_MS = 120;
/** An ayah counts as read once it has been on screen this long. */
export const DWELL_MS = 4000;
/** Scroll has stopped → the reading position is worth writing. */
const SCROLL_IDLE_MS = 700;
/** The sticky shell header, so "top of the viewport" is below it. */
const VIEWPORT_TOP_OFFSET = 96;

/* ------------------------------------------------------------------ words */

export interface WordBank {
  /** `undefined` until the row set arrives — the caller falls back to the ayah text. */
  of(verseKey: VerseKey): AyahWordRow[] | undefined;
  /** Move an ayah to the front of the queue (the viewport called in). */
  prioritize(verseKey: VerseKey): void;
  /** Ayahs whose word rows refused to load; their text is still shown. */
  failed: readonly VerseKey[];
}

export function useWordBank(gateway: DataGateway | null, verseKeys: readonly VerseKey[]): WordBank {
  const [bank, setBank] = useState<ReadonlyMap<VerseKey, AyahWordRow[]>>(() => new Map());
  const [failed, setFailed] = useState<readonly VerseKey[]>([]);

  const pending = useRef(new Map<VerseKey, AyahWordRow[]>());
  const failedSeen = useRef(new Set<VerseKey>());
  const queue = useRef<VerseKey[]>([]);
  const claimed = useRef(new Set<VerseKey>());
  const running = useRef(0);
  const flushTimer = useRef<number | null>(null);
  const token = useRef(0);

  const flush = useCallback(() => {
    flushTimer.current = null;
    if (pending.current.size === 0) return;
    const additions = [...pending.current.entries()];
    pending.current.clear();
    setBank((previous) => {
      const next = new Map(previous);
      for (const [key, rows] of additions) next.set(key, rows);
      return next;
    });
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimer.current !== null) return;
    flushTimer.current = window.setTimeout(flush, WORD_FLUSH_MS);
  }, [flush]);

  const pump = useCallback(() => {
    if (!gateway) return;
    const mine = token.current;
    while (running.current < WORD_CONCURRENCY && queue.current.length > 0) {
      const key = queue.current.shift();
      if (key === undefined) continue;
      running.current += 1;
      void gateway
        .words(key)
        .then((rows) => {
          if (token.current !== mine) return;
          pending.current.set(key, rows);
          scheduleFlush();
        })
        .catch(() => {
          if (token.current !== mine) return;
          claimed.current.delete(key);
          if (!failedSeen.current.has(key)) {
            failedSeen.current.add(key);
            setFailed((previous) => [...previous, key]);
          }
        })
        .finally(() => {
          running.current -= 1;
          pump();
        });
    }
  }, [gateway, scheduleFlush]);

  const signature = verseKeys.join(' ');

  useEffect(() => {
    if (!gateway) return;
    token.current += 1;
    claimed.current = new Set();
    failedSeen.current = new Set();
    pending.current.clear();
    setBank(new Map());
    setFailed([]);
    queue.current = [...verseKeys];
    for (const key of verseKeys) claimed.current.add(key);
    pump();
    return () => {
      token.current += 1;
      queue.current = [];
      if (flushTimer.current !== null) {
        window.clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
    };
    // `signature` is the identity of the ayah list; `pump` is stable per gateway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, signature, pump]);

  const prioritize = useCallback(
    (key: VerseKey) => {
      if (gateway === null) return;
      if (bank.has(key)) return;
      const at = queue.current.indexOf(key);
      if (at >= 0) queue.current.splice(at, 1);
      else if (!claimed.current.has(key)) claimed.current.add(key);
      queue.current.unshift(key);
      pump();
    },
    [bank, gateway, pump],
  );

  const of = useCallback((key: VerseKey) => bank.get(key), [bank]);

  return { of, prioritize, failed };
}

/* ------------------------------------------------------- translation pack */

export interface TranslationChoice {
  options: TranslationOption[];
  /** `''` means "no translation", the canonical `translationPack` empty value. */
  packId: string;
  ready: boolean;
  /** Persisted through `setSetting('translationPack', …)`. */
  choose(packId: string): void;
  error: string | null;
}

export function useTranslationPack(
  gateway: DataGateway | null,
  preferred: 'fa' | 'en',
): TranslationChoice {
  const [options, setOptions] = useState<TranslationOption[]>([]);
  const [stored, setStored] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!gateway) return;
    let mine = true;
    void (async () => {
      try {
        const [settings, packs] = await Promise.all([gateway.settings(), gateway.translationOptions()]);
        if (!mine) return;
        setOptions(packs);
        setStored(settings['translationPack'] ?? '');
      } catch (cause: unknown) {
        if (!mine) return;
        setOptions([]);
        setStored(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      mine = false;
    };
  }, [gateway]);

  const choose = useCallback(
    (packId: string) => {
      setChosen(packId);
      setError(null);
      void gateway?.setSetting('translationPack', packId).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    },
    [gateway],
  );

  // Nothing chosen yet: prefer the interface language, then any pack. The
  // default is applied in memory only — the stored setting stays untouched
  // until the reader actually picks a pack.
  const resolved =
    chosen !== null
      ? chosen
      : stored && options.some((o) => o.packId === stored)
        ? stored
        : (options.find((o) => o.language === preferred)?.packId ?? options[0]?.packId ?? '');

  return { options, packId: resolved, ready: stored !== null, choose, error };
}

/* --------------------------------------------------------------- user marks */

export interface UserMarks {
  bookmarkIdOf(verseKey: VerseKey): string | undefined;
  hifzItemIdOf(verseKey: VerseKey): string | undefined;
  toggleBookmark(verseKey: VerseKey): void;
  toggleHifz(verseKey: VerseKey): void;
  /** Verse keys the reader may render as a bookmark/hifz item. */
  busy: ReadonlySet<VerseKey>;
  error: string | null;
  dismissError(): void;
}

export function useUserMarks(gateway: DataGateway | null): UserMarks {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [items, setItems] = useState<HifzItem[]>([]);
  const [busy, setBusy] = useState<ReadonlySet<VerseKey>>(() => new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!gateway) return;
    let mine = true;
    void (async () => {
      try {
        const [bm, hz] = await Promise.all([gateway.bookmarks(), gateway.hifzItems()]);
        if (!mine) return;
        setBookmarks(bm);
        setItems(hz);
      } catch (cause: unknown) {
        // Marks are an overlay on the text: a failure is reported, the reader
        // still renders, and no row is invented as a placeholder.
        if (!mine) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      mine = false;
    };
  }, [gateway]);

  const byVerse = useMemo(() => {
    const bm = new Map<string, string>();
    for (const bookmark of bookmarks) if (bookmark.verseKey) bm.set(bookmark.verseKey, bookmark.id);
    const hz = new Map<string, string>();
    for (const item of items) hz.set(item.verseKey, item.id);
    return { bm, hz };
  }, [bookmarks, items]);

  const mark = useCallback((key: VerseKey, on: boolean) => {
    setBusy((previous) => {
      const next = new Set(previous);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  // Read through a ref so the two callbacks below keep a stable identity: a
  // single bookmark toggle must not re-render all 286 rows of a chapter.
  const marksRef = useRef(byVerse);
  marksRef.current = byVerse;

  const toggleBookmark = useCallback(
    (key: VerseKey) => {
      if (!gateway) return;
      const existing = marksRef.current.bm.get(key);
      mark(key, true);
      void (async () => {
        try {
          if (existing) {
            await gateway.removeBookmark(existing);
            setBookmarks((previous) => previous.filter((b) => b.id !== existing));
          } else {
            const created = await gateway.addBookmark({ verseKey: key });
            setBookmarks((previous) => [...previous, created]);
          }
          setError(null);
        } catch (cause: unknown) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          mark(key, false);
        }
      })();
    },
    [gateway, mark],
  );

  const toggleHifz = useCallback(
    (key: VerseKey) => {
      if (!gateway) return;
      const existing = marksRef.current.hz.get(key);
      mark(key, true);
      void (async () => {
        try {
          if (existing) {
            await gateway.removeHifzItem(existing);
            setItems((previous) => previous.filter((i) => i.id !== existing));
          } else {
            const created = await gateway.addHifzItem(key);
            setItems((previous) => [...previous, created]);
          }
          setError(null);
        } catch (cause: unknown) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          mark(key, false);
        }
      })();
    },
    [gateway, mark],
  );

  return {
    bookmarkIdOf: (key) => byVerse.bm.get(key),
    hifzItemIdOf: (key) => byVerse.hz.get(key),
    toggleBookmark,
    toggleHifz,
    busy,
    error,
    dismissError: () => setError(null),
  };
}

/* ---------------------------------------------------------------- visibility */

export interface VisibilityHandlers {
  /** An ayah crossed into view. */
  onEnter(key: VerseKey): void;
  /** An ayah left the view after `dwellMs`; 0 when it never stayed. */
  onLeave(key: VerseKey, dwellMs: number): void;
}

/**
 * Observe every `[data-verse-key]` element in the document.
 *
 * One observer for the whole feed, keyed by the list signature, so a 286-ayah
 * chapter costs one IntersectionObserver instead of 286.
 */
export function useAyahVisibility({ onEnter, onLeave }: VisibilityHandlers, signature: string): () => void {
  const entered = useRef(new Map<VerseKey, number>());
  const observed = useRef(new WeakSet<Element>());
  const observer = useRef<IntersectionObserver | null>(null);
  const handlers = useRef<VisibilityHandlers>({ onEnter, onLeave });
  handlers.current = { onEnter, onLeave };

  const attach = useCallback(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    if (observer.current === null) {
      observer.current = new IntersectionObserver(
        (records) => {
          for (const record of records) {
            const raw = record.target instanceof HTMLElement ? record.target.dataset.verseKey : undefined;
            if (!raw) continue;
            const key = raw as VerseKey;
            if (record.isIntersecting) {
              if (!entered.current.has(key)) {
                entered.current.set(key, Date.now());
                handlers.current.onEnter(key);
              }
            } else if (entered.current.has(key)) {
              const started = entered.current.get(key) ?? Date.now();
              entered.current.delete(key);
              handlers.current.onLeave(key, Date.now() - started);
            }
          }
        },
        { rootMargin: `-${VIEWPORT_TOP_OFFSET}px 0px 0px 0px`, threshold: 0.35 },
      );
    }
    for (const node of Array.from(document.querySelectorAll<HTMLElement>('[data-verse-key]'))) {
      if (observed.current.has(node)) continue;
      observed.current.add(node);
      observer.current.observe(node);
    }
  }, []);

  useEffect(() => {
    entered.current = new Map();
    observed.current = new WeakSet();
    const local = observer.current;
    local?.disconnect();
    observer.current = null;
    attach();
    return () => {
      observer.current?.disconnect();
      observer.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, attach]);

  /** Record whatever is still on screen — the reader is about to unmount. */
  return useCallback(() => {
    const now = Date.now();
    for (const [key, started] of entered.current) handlers.current.onLeave(key, now - started);
    entered.current = new Map();
  }, []);
}

/* ------------------------------------------------------------ reading state */

export interface ReadingProgress {
  /** The stored position, when it belongs to this chapter. */
  saved: { verseKey: VerseKey; page: number; scrollFraction: number } | null;
  /** Called for each ayah the reader wants counted as read. */
  noteRead(key: VerseKey, durationMs: number): void;
  /** Persist the position now (scroll idle, unmount). */
  commit(key: VerseKey, page: number): void;
  lastSavedAt: string | null;
}

/**
 * Reading position + reading history for one chapter.
 *
 * The stored position is read once on entry — the reader offers "continue"
 * rather than yanking the page. Writes happen when scrolling stops, and an ayah
 * is recorded as read once it has been on screen for `DWELL_MS`.
 */
export function useReadingProgress(
  gateway: DataGateway | null,
  chapter: number | null,
  currentPosition: () => { key: VerseKey; page: number } | null,
): ReadingProgress {
  const [saved, setSaved] = useState<ReadingProgress['saved']>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const recorded = useRef(new Set<VerseKey>());

  useEffect(() => {
    if (!gateway || chapter === null) return;
    let mine = true;
    void gateway
      .readingPosition()
      .then((position) => {
        if (!mine || !position) return;
        if (chapterOf(position.verseKey) !== chapter) return;
        setSaved({
          verseKey: position.verseKey,
          page: position.page,
          scrollFraction: position.scrollFraction,
        });
      })
      .catch(() => {
        /* no stored position is a legitimate state, not an error */
      });
    return () => {
      mine = false;
    };
  }, [gateway, chapter]);

  const commit = useCallback(
    (key: VerseKey, page: number) => {
      if (!gateway) return;
      void gateway
        .setReadingPosition(key, page, scrollFraction())
        .then(() => setLastSavedAt(new Date().toISOString()))
        .catch(() => {
          /* a failed position write must not interrupt reading */
        });
    },
    [gateway],
  );

  const noteRead = useCallback(
    (key: VerseKey, durationMs: number) => {
      if (!gateway || durationMs < DWELL_MS) return;
      if (recorded.current.has(key)) return;
      recorded.current.add(key);
      void gateway.recordReading(key, durationMs).catch(() => {
        recorded.current.delete(key);
      });
    },
    [gateway],
  );

  // Debounced scroll → one position write per reading pause, not per frame.
  useEffect(() => {
    if (!gateway) return;
    let timer: number | null = null;
    const onScroll = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        const current = currentPosition();
        if (current) commit(current.key, current.page);
      }, SCROLL_IDLE_MS);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [gateway, commit, currentPosition]);

  return { saved, noteRead, commit, lastSavedAt };
}

/** The topmost ayah element below the sticky header. */
export function topVisibleAyah(): { key: VerseKey; page: number } | null {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('[data-verse-key]'));
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (rect.bottom > VIEWPORT_TOP_OFFSET) {
      const raw = node.dataset.verseKey;
      const page = Number.parseInt(node.dataset.page ?? '', 10);
      if (!raw) return null;
      return { key: raw as VerseKey, page: Number.isFinite(page) ? page : 0 };
    }
  }
  return null;
}

/** The pack list is tiny and static, so a failed load is surfaced, not retried silently. */
export function useTafsirTitles(gateway: DataGateway | null): ReadonlyMap<string, string> {
  const state = useAsync(async () => {
    if (!gateway) return new Map<string, string>();
    const sources = await gateway.tafsirSources();
    return new Map(sources.map((s) => [s.packId, s.title]));
  }, [gateway]);
  // Stable identity: a row must not re-render because some other row asked for
  // its tafsir, and `state.value ?? new Map()` would be a fresh object each time.
  const empty = useRef(new Map<string, string>()).current;
  return useMemo(() => state.value ?? empty, [state.value, empty]);
}
