/**
 * Pieces shared by the Me screens only.
 *
 * `ConfirmBox` exists because every destructive action in this area (reset
 * content, restore a backup, delete a note) has to state what is lost and
 * require an explicit tick before the button works — a `window.confirm` string
 * cannot carry that much detail and is not keyboard-styled with the rest of the
 * app. `MeTabs` is the in-area navigation: the sidebar carries one entry for
 * the section, so the sub-screens link to each other here instead.
 */
import { useState, type ReactNode } from 'react';

import { useApp } from '../../app/app-state';
import type { Tr } from '../../app/app-state';
import { navigate } from '../../app/router';
import { Button, Chip } from '../../ui/primitives';

export const ME_TABS: readonly { to: string; label: (t: Tr) => string }[] = [
  { to: '/me', label: (t) => t('تنظیمات', 'Settings') },
  { to: '/me/content', label: (t) => t('سلامت داده', 'Data health') },
  { to: '/me/backup', label: (t) => t('پشتیبان و بازیابی', 'Backup & restore') },
  { to: '/me/notes', label: (t) => t('یادداشت‌ها', 'Notes') },
  { to: '/me/about', label: (t) => t('درباره', 'About') },
];

export function MeTabs({ current }: { current: string }) {
  const { tr } = useApp();
  return (
    <nav className="metabs" aria-label={tr('بخش‌های من', 'Sections of Me')}>
      {ME_TABS.map((tab) => {
        const active = tab.to === current;
        return (
          <button
            key={tab.to}
            type="button"
            className={`metabs__tab ${active ? 'is-active' : ''}`}
            aria-current={active ? 'page' : undefined}
            onClick={() => navigate(tab.to)}
          >
            {tab.label(tr)}
          </button>
        );
      })}
    </nav>
  );
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 2 : 0)} KiB`;
  return `${(kb / 1024).toFixed(2)} MiB`;
}

export function formatNumber(tr: Tr, value: number): string {
  return new Intl.NumberFormat(tr('fa-IR', 'en-US')).format(value);
}

export function shortDigest(checksum: string): string {
  return checksum.length > 16 ? `${checksum.slice(0, 12)}…${checksum.slice(-4)}` : checksum || '—';
}

/** A licence status is a fact about the pack, so it is coloured everywhere the same. */
export function LicenseChip({ status, tr }: { status: string; tr: Tr }) {
  const tone = status === 'clear' ? 'accent' : status === 'attribution-required' ? 'warn' : 'danger';
  const label =
    status === 'clear'
      ? tr('مجاز', 'cleared')
      : status === 'attribution-required'
        ? tr('نیازمند ذکر منبع', 'attribution required')
        : status === 'unresolved'
          ? tr('مجوز نامشخص', 'licence unresolved')
          : status;
  return <Chip tone={tone}>{label}</Chip>;
}

export interface Message {
  kind: 'ok' | 'error' | 'info';
  text: string;
}

/** Announced to screen readers; a save that cannot be heard did not happen. */
export function StatusLine({ message }: { message: Message | null }) {
  if (!message) return null;
  return (
    <p className={`msg msg--${message.kind}`} role="status" aria-live="polite">
      {message.text}
    </p>
  );
}

export interface ConfirmBoxProps {
  /** What is about to happen, as a heading. */
  title: string;
  /** Exactly what is lost — the user must be able to read this before ticking. */
  consequences: readonly string[];
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  onConfirm(): void;
  children?: ReactNode;
}

export function ConfirmBox({ title, consequences, confirmLabel, cancelLabel, busy = false, onConfirm, children }: ConfirmBoxProps) {
  const { tr } = useApp();
  const [armed, setArmed] = useState(false);
  return (
    <div className="confirm" role="group" aria-label={title}>
      <p className="confirm__title">{title}</p>
      <ul className="confirm__list">
        {consequences.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {children}
      <label className="confirm__arm">
        <input type="checkbox" checked={armed} onChange={(e) => setArmed(e.target.checked)} />
        <span>{tr('می‌دانم چه چیزی از بین می‌رود و ادامه می‌دهم', 'I understand what is lost, and want to continue')}</span>
      </label>
      <div className="row">
        <Button variant="danger" disabled={!armed || busy} busy={busy} onClick={onConfirm}>
          {confirmLabel}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setArmed(false);
          }}
        >
          {cancelLabel ?? tr('بی‌خیال', 'Cancel')}
        </Button>
      </div>
    </div>
  );
}
