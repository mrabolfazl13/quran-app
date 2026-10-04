/**
 * Data fetching and the five states every screen must render.
 *
 * The UI gate in the master prompt is explicit: loading, empty, error, offline
 * and success are states, not afterthoughts. Rather than asking each screen to
 * remember them, `useAsync` produces the status and `<StateBoundary>` renders it
 * — a screen that forgets the boundary cannot compile, because it has no value
 * to read yet.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { useApp } from '../app/app-state';
import { gatewayStore } from './gatewayText';
import { IconAlert, IconInbox, IconRefresh } from './icons';
import { Skeleton, Spinner } from './primitives';
import './ui.css';

export type AsyncStatus = 'loading' | 'ready' | 'error';

export interface AsyncState<T> {
  status: AsyncStatus;
  value: T | null;
  error: unknown;
  /** Re-run the query (pull-to-refresh, or after a write). */
  refresh: () => void;
  /** Replace the value in place after a local write, without a refetch. */
  setValue: (next: T) => void;
}

export function useAsync<T>(query: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [status, setStatus] = useState<AsyncStatus>('loading');
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [epoch, setEpoch] = useState(0);
  // Every run gets a token; a late answer from an earlier run is dropped, which
  // is what keeps a fast typing/search flow from showing stale hits.
  const token = useRef(0);

  useEffect(() => {
    const mine = ++token.current;
    setStatus('loading');
    setError(null);
    query()
      .then((result) => {
        if (token.current !== mine) return;
        setValue(result);
        setStatus('ready');
      })
      .catch((cause: unknown) => {
        if (token.current !== mine) return;
        setError(cause);
        setStatus('error');
      });
    // `query` is re-created with its inputs; the deps list is that contract.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, epoch]);

  const refresh = useCallback(() => setEpoch((n) => n + 1), []);
  const setValueStable = useCallback((next: T) => setValue(next), []);

  return { status, value, error, refresh, setValue: setValueStable };
}

export interface BoundaryProps<T> {
  state: AsyncState<T>;
  /** Title shown when the query succeeded with nothing in it. */
  emptyTitle: string;
  emptyBody?: string;
  /** A call to action for the empty state — without one it is a dead end. */
  emptyAction?: ReactNode;
  /** Decides "empty" from the loaded value. */
  isEmpty: (value: T) => boolean;
  /** Shown instead of the error text when the shell has no storage at all. */
  offlineTitle?: string;
  onRetry?: () => void;
  skeleton?: ReactNode;
  children: (value: T) => ReactNode;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

export function StateBoundary<T>({
  state,
  emptyTitle,
  emptyBody,
  emptyAction,
  isEmpty,
  offlineTitle,
  onRetry,
  skeleton,
  children,
}: BoundaryProps<T>) {
  const { tr, info, error: gatewayError, reload } = useApp();

  if (gatewayError) {
    return (
      <div className="state state--error" role="alert">
        <IconAlert size={28} className="state__icon" />
        <h3>{offlineTitle ?? tr('ذخیره‌گاه در دسترس نیست', 'Storage is unavailable')}</h3>
        <p className="muted">{messageOf(gatewayError)}</p>
        <div className="state__actions">
          <button type="button" className="btn btn--primary" onClick={() => void reload()}>
            <span className="btn__icon">
              <IconRefresh />
            </span>
            {tr('تلاش دوباره', 'Try again')}
          </button>
        </div>
      </div>
    );
  }

  if (state.status === 'loading') {
    return (
      <>
        {skeleton ?? (
          <div className="state state--loading" role="status" aria-busy="true">
            <Spinner label={tr('در حال بارگذاری…', 'Loading…')} />
            <Skeleton lines={3} />
          </div>
        )}
      </>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="state state--error" role="alert">
        <IconAlert size={28} className="state__icon" />
        <h3>{tr('این بخش باز نشد', 'This section could not load')}</h3>
        <p className="muted mono">{messageOf(state.error)}</p>
        {onRetry ? (
          <div className="state__actions">
            <button type="button" className="btn btn--primary" onClick={onRetry}>
              <span className="btn__icon">
                <IconRefresh />
              </span>
              {tr('تلاش دوباره', 'Try again')}
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  const value = state.value as T;
  if (isEmpty(value)) {
    return (
      <div className="state state--empty">
        <IconInbox size={28} className="state__icon" />
        <h3>{emptyTitle}</h3>
        {emptyBody ? <p className="muted">{emptyBody}</p> : null}
        {emptyAction ? <div className="state__actions">{emptyAction}</div> : null}
      </div>
    );
  }

  // The dev shell is announced, never hidden: a reviewer must know at a glance
  // that the data path is the browser one and not the packaged SQLite one.
  //
  // The notice and the section it belongs to are wrapped in one element on
  // purpose. A fragment here would put the notice and the content into the
  // parent as two children, and inside a grid (`hifz-columns`) the notice would
  // be assigned its own column and stretched to the row's height — a huge empty
  // panel instead of a strip above the content.
  if (info && !info.isShippedPath) {
    return (
      <div className="stack">
        <div className="shell-note" title={gatewayStore(tr, info.storeId)}>
          {tr('پوستهٔ توسعه — داده در حافظهٔ مرورگر است و با بستهٔ نصبی فرقی دارد', 'Dev shell — data lives in browser memory, not the packaged database')}
        </div>
        {children(value)}
      </div>
    );
  }

  return <>{children(value)}</>;
}
