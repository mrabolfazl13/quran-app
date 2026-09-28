/**
 * Shared chrome primitives.
 *
 * One button, one chip, one panel — so a screen cannot accidentally grow a
 * fourth style. Every rule here is expressed through the tokens in
 * `styles/tokens.css`; nothing in this file contains a raw colour.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { navigate } from '../app/router';
import './ui.css';

export function Chip({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'warn' | 'danger' | 'info';
  title?: string;
}) {
  return (
    <span className={`chip chip--${tone}`} title={title}>
      {children}
    </span>
  );
}

/** Stability bands are a contract (`MemoryBand`), so their colours are shared. */
export function BandChip({ band, label }: { band: string; label: string }) {
  return (
    <span className="chip chip--band" data-band={band}>
      {label}
    </span>
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'default' | 'ghost' | 'danger';
  busy?: boolean;
}

export function Button({ variant = 'default', busy = false, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={`btn btn--${variant}`}
      disabled={disabled ?? busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {children}
    </button>
  );
}

export function LinkButton({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return (
    <a
      className={`linkbtn ${className ?? ''}`}
      href={to.startsWith('#') ? to : `#${to}`}
      onClick={(event) => {
        // Left click only; modifier clicks keep the browser's own behaviour.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

export function Panel({
  title,
  action,
  children,
  className,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className ?? ''}`}>
      {title !== undefined || action !== undefined ? (
        <header className="panel__head">
          <h2 className="panel__title">{title}</h2>
          <div className="panel__actions">{action}</div>
        </header>
      ) : null}
      <div className="panel__body">{children}</div>
    </section>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="field__error" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="field__hint">{hint}</p>
      ) : null}
    </div>
  );
}

/** A horizontal meter for a 0..1 value — accuracy, coverage, progress. */
export function Meter({ value, label, tone = 'accent' }: { value: number; label?: string; tone?: 'accent' | 'warn' | 'danger' }) {
  const percent = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 100;
  return (
    <span className={`meter meter--${tone}`} title={`${Math.round(percent)}%`}>
      <span className="meter__fill" style={{ width: `${percent}%` }} />
      {label ? <span className="meter__label">{label}</span> : null}
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner" role="status">
      <span className="spinner__ring" aria-hidden="true" />
      {label ? <span>{label}</span> : null}
    </span>
  );
}

/** The ayah number as a closed-form badge — the mushaf's own marker shape. */
export function AyahBadge({ verse }: { verse: number | string }) {
  return <span className="ayah-badge" aria-label={`آیه ${verse}`} title={`${verse}`}>{verse}</span>;
}
