/**
 * Shared chrome primitives.
 *
 * One button, one chip, one panel — so a screen cannot accidentally grow a
 * fourth style. Every rule here is expressed through the tokens in
 * `styles/tokens.css`; nothing in this file contains a raw colour.
 *
 * Compatibility is part of the contract (docs/design-system.md): an existing
 * export keeps its name and its props, and new behaviour arrives as an
 * optional prop with the previous rendering as its default.
 */
import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';

import { navigate } from '../app/router';
import { IconClose } from './icons';
import './ui.css';

export interface ChipProps {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'warn' | 'danger' | 'info';
  title?: string;
  /** An icon at the inline start. Optional; a chip may be text alone. */
  icon?: ReactNode;
  /** For a chip whose content is a whole sentence (a provenance line): it may
   * wrap instead of pushing the row past the edge of a phone. */
  wrap?: boolean;
}

export function Chip({ children, tone = 'neutral', title, icon, wrap = false }: ChipProps) {
  return (
    <span className={`chip chip--${tone}${wrap ? ' chip--wrap' : ''}`} title={title}>
      {icon}
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
  /** `sm` is for dense toolbars; the default stays a 44px target. */
  size?: 'sm' | 'md';
  /** An icon at the inline start. Decorative: the label still carries the name. */
  icon?: ReactNode;
  /** Stretch to the width of the surface — the phone pattern for a CTA. */
  block?: boolean;
}

export function Button({
  variant = 'default',
  busy = false,
  size = 'md',
  icon,
  block = false,
  children,
  disabled,
  className,
  ...rest
}: ButtonProps) {
  const classes = [
    'btn',
    `btn--${variant}`,
    size === 'sm' ? 'btn--sm' : '',
    block ? 'btn--block' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      className={classes}
      disabled={disabled ?? busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {icon ? <span className="btn__icon">{icon}</span> : null}
      {children}
    </button>
  );
}

/**
 * An icon-only control. `label` is mandatory, because a glyph without a name is
 * unreadable to a screen reader and untestable by keyboard.
 */
export function IconButton({
  label,
  icon,
  variant = 'ghost',
  className,
  ...rest
}: Omit<ButtonProps, 'children' | 'icon'> & { label: string; icon: ReactNode }) {
  return (
    <Button
      variant={variant}
      aria-label={label}
      title={label}
      className={`btn--icon${className ? ` ${className}` : ''}`}
      {...rest}
    >
      <span className="btn__icon">{icon}</span>
      <span className="btn__label">{label}</span>
    </Button>
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

export interface PanelProps {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  /** One line under the title — a panel should not need a paragraph of chrome. */
  subtitle?: ReactNode;
  /**
   * `card` is the default plane. `quiet` is an inset well (no elevation),
   * `raised` is the single hero surface on a screen, `flush` removes the body
   * padding so a table or the mushaf can run edge to edge.
   */
  tone?: 'card' | 'quiet' | 'raised' | 'flush';
  /** A footer bar; the place a panel's own actions belong. */
  footer?: ReactNode;
}

export function Panel({ title, action, children, className, subtitle, tone = 'card', footer }: PanelProps) {
  const classes = ['panel', tone !== 'card' ? `panel--${tone}` : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <section className={classes}>
      {title !== undefined || action !== undefined || subtitle !== undefined ? (
        <header className="panel__head">
          <div className="panel__heading">
            <h2 className="panel__title">{title}</h2>
            {subtitle !== undefined ? <p className="panel__subtitle">{subtitle}</p> : null}
          </div>
          <div className="panel__actions">{action}</div>
        </header>
      ) : null}
      <div className="panel__body">{children}</div>
      {footer !== undefined ? <footer className="panel__foot">{footer}</footer> : null}
    </section>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
  required = false,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
  required?: boolean;
}) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={htmlFor}>
        {label}
        {required ? (
          <span className="field__required" aria-hidden="true">
            *
          </span>
        ) : null}
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
      <span className="meter__track">
        <span className="meter__fill" style={{ width: `${percent}%` }} />
      </span>
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

/**
 * A numeric range inside an RTL line. An en-dash is a bidi neutral, so without
 * isolation the paragraph direction wins and "2–49" is laid out with 49 on the
 * left — which reads backwards, because digits always read left to right.
 */
export function NumRange({ from, to, className }: { from: ReactNode; to: ReactNode; className?: string }) {
  return (
    <span dir="ltr" className={className}>
      {from}–{to}
    </span>
  );
}

/**
 * The shape of content that has not arrived yet.
 *
 * A spinner says "something is happening"; a skeleton says "here is what will
 * be here", which is what makes a slow screen feel honest instead of broken.
 * `StateBoundary` uses this as its default loading state.
 */
export function Skeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={`stack stack--tight ${className ?? ''}`} role="presentation">
      <div className="skeleton skeleton--title" />
      {Array.from({ length: Math.max(1, lines) }, (_, i) => (
        <div key={i} className="skeleton skeleton--line" style={{ width: `${100 - i * 12}%` }} />
      ))}
    </div>
  );
}

/** A card-shaped skeleton for a grid of tiles. */
export function SkeletonCards({ count = 3 }: { count?: number }) {
  return (
    <div className="grid grid--cards" role="presentation">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton skeleton--card" />
      ))}
    </div>
  );
}

/**
 * A docked panel that becomes a bottom sheet on a phone (see `ui.css`).
 * The grip is the visible dismiss affordance; Escape and the scrim also close
 * it, because a sheet you can only close one way is a trap.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  closeLabel = 'بستن',
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  closeLabel?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      <button type="button" className="sheet__scrim" onClick={onClose} aria-label={closeLabel} tabIndex={-1} />
      <aside className="sheet" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <button type="button" className="sheet__grip" onClick={onClose}>
          {closeLabel}
        </button>
        {title !== undefined ? (
          <header className="sheet__head">
            <h2 className="sheet__title">{title}</h2>
            <IconButton label={closeLabel} icon={<IconClose />} onClick={onClose} />
          </header>
        ) : null}
        <div className="sheet__body">{children}</div>
        {footer !== undefined ? <footer className="sheet__foot">{footer}</footer> : null}
      </aside>
    </>
  );
}

/**
 * The tab bar holds at most five top-level destinations; the rest move into a
 * «بیشتر» sheet. Pure and exported so the rule is testable without a browser.
 */
export const MAX_TABS = 5;
export function splitNavItems<T>(items: readonly T[], max = MAX_TABS): { tabs: T[]; overflow: T[] } {
  if (items.length <= max) return { tabs: [...items], overflow: [] };
  // The last slot belongs to the overflow control, so the fifth destination
  // joins the sheet rather than being squeezed out of it.
  return { tabs: items.slice(0, max - 1), overflow: items.slice(max - 1) };
}
