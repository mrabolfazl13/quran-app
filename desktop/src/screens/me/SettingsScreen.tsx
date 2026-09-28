/**
 * ME / settings — the one screen that writes the `settings` table.
 *
 * The rows come from `SETTING_DEFS` in `core/src/backup/settings.ts`, which is
 * the same allowlist a backup is filtered through at restore. That is on
 * purpose: a new setting appears here the moment it is declared, and the
 * control that renders is chosen from the setting's declared type, so no value
 * outside `min`/`max` or outside an enum's choices can be written from the UI.
 * Every change is persisted immediately with `setSetting` and read back on
 * load from `settings()`; the printed default is the one in the registry.
 */
import { useCallback, useEffect, useState } from 'react';

import { SETTING_DEFS, coerceSetting, defaultSettings, type SettingDef, type SettingPrimitive } from '@quran/core';

import { useApp } from '../../app/app-state';
import type { Tr } from '../../app/app-state';
import type { RouteDef } from '../../app/router';
import type { TranslationOption } from '../../gateway/types';
import { StateBoundary, useAsync } from '../../ui/async';
import { Button, Chip, Field, Panel } from '../../ui/primitives';
import { applyFontScales, cacheFontScales } from './font-scale';
import { ConfirmBox, LicenseChip, MeTabs, StatusLine, type Message } from './shared';
import './me.css';

interface SettingsData {
  values: Record<string, SettingPrimitive>;
  translations: TranslationOption[];
  /** `translationPack` coverage is only meaningful against the real verse count. */
  ayahTotal: number;
}

/** Persian labels live here; an unknown key falls back to the registry's label. */
const LABELS: Readonly<Record<string, readonly [string, string]>> = {
  theme: ['پوستهٔ رنگی', 'Colour theme'],
  interfaceLanguage: ['زبان رابط برنامه', 'Interface language'],
  translationPack: ['بستهٔ ترجمهٔ ترجیحی', 'Preferred translation pack'],
  readingMode: ['شیوهٔ خواندن', 'Reading mode'],
  fontScale: ['اندازهٔ نوشتهٔ رابط', 'Interface text size'],
  quranFontScale: ['اندازهٔ متن قرآن', 'Quran text size'],
  hifzSessionNewItemTarget: ['آیات تازه در هر نشست حفظ', 'New ayahs per hifz session'],
  hifzSessionReviewCap: ['سقف مرورها در هر نشست', 'Review items per hifz session'],
  hifzSessionDefaultMode: ['شیوهٔ بازیابی پیش‌فرض', 'Default recall mode'],
  hifzAutoAudio: ['پخش صوت پیش از بازیابی', 'Play audio before recall'],
};

const CHOICES: Readonly<Record<string, readonly [string, string]>> = {
  'theme:light': ['روشن', 'light'],
  'theme:dark': ['تیره', 'dark'],
  'theme:system': ['با سیستم', 'system'],
  'interfaceLanguage:fa': ['فارسی', 'Persian'],
  'interfaceLanguage:en': ['انگلیسی', 'English'],
  'readingMode:mushaf': ['صفحهٔ مصحف', 'mushaf pages'],
  'readingMode:ayah': ['آیه‌به‌آیه', 'scrolling ayat'],
  'hifzSessionDefaultMode:segment': ['پاره', 'segment'],
  'hifzSessionDefaultMode:full-ayah': ['آیهٔ کامل', 'full ayah'],
  'hifzSessionDefaultMode:full-sequence': ['توالی کامل', 'full sequence'],
  'hifzSessionDefaultMode:transition': ['گذار', 'transition'],
  'hifzSessionDefaultMode:random': ['تصادفی', 'random'],
};

function settingLabel(def: SettingDef, tr: Tr): string {
  const pair = LABELS[def.key];
  return pair ? tr(pair[0], pair[1]) : def.label;
}

function choiceLabel(key: string, value: string, tr: Tr): string {
  const pair = CHOICES[`${key}:${value}`];
  return pair ? tr(pair[0], pair[1]) : value;
}

function display(value: SettingPrimitive, def: SettingDef, tr: Tr): string {
  if (def.type === 'enum') return choiceLabel(def.key, String(value), tr);
  if (def.type === 'boolean') return value ? tr('روشن', 'on') : tr('خاموش', 'off');
  return String(value);
}

/** Stored TEXT → the declared type, or the registry default when absent/invalid. */
function resolveAll(stored: Record<string, string>): Record<string, SettingPrimitive> {
  const out: Record<string, SettingPrimitive> = { ...defaultSettings() };
  for (const def of SETTING_DEFS) {
    const raw = stored[def.key];
    if (raw === undefined) continue;
    const coerced = coerceSetting(def.key, raw);
    if (coerced.ok) out[def.key] = coerced.value;
  }
  return out;
}

function numberStep(def: Extract<SettingDef, { type: 'number' }>): number {
  const integerish = Number.isInteger(def.min) && Number.isInteger(def.max);
  if (integerish) return def.max - def.min > 60 ? 5 : 1;
  return Number(((def.max - def.min) / 50).toFixed(3)) || 0.05;
}

export function SettingsScreen() {
  const { tr, gateway, setThemePref, setLang } = useApp();
  const [message, setMessage] = useState<Message | null>(null);

  const state = useAsync<SettingsData>(
    async () => {
      if (!gateway) throw new Error(tr('ذخیره‌گاه باز نشده', 'Storage is not open yet'));
      const [stored, counts, translations] = await Promise.all([
        gateway.settings(),
        gateway.counts(),
        // A missing translation table must not hide the rest of the settings.
        gateway.translationOptions().catch(() => [] as TranslationOption[]),
      ]);
      return { values: resolveAll(stored), translations, ayahTotal: counts.ayahs };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gateway],
  );

  // The database is the truth about the font scales, so once it has been read
  // it replaces whatever the pre-paint cache applied.
  useEffect(() => {
    const values = state.value?.values;
    if (!values) return;
    const ui = typeof values['fontScale'] === 'number' ? values['fontScale'] : 1;
    const quran = typeof values['quranFontScale'] === 'number' ? values['quranFontScale'] : 1;
    applyFontScales(ui, quran);
  }, [state.value]);

  const persist = useCallback(
    async (def: SettingDef, next: SettingPrimitive) => {
      if (!gateway) return;
      const data = state.value;
      try {
        await gateway.setSetting(def.key, String(next));
      } catch (cause) {
        setMessage({
          kind: 'error',
          text: `${settingLabel(def, tr)}: ${cause instanceof Error ? cause.message : String(cause)}`,
        });
        return;
      }
      const values: Record<string, SettingPrimitive> = { ...(data?.values ?? {}), [def.key]: next };
      if (data) state.setValue({ ...data, values });

      // Chrome settings do more than persist: the shell must react now.
      // `setThemePref`/`setLang` write the same key again through app-state,
      // which is the documented double-write (localStorage cache + settings).
      if (def.key === 'theme') {
        setThemePref(next === 'light' || next === 'dark' || next === 'system' ? next : 'system');
      }
      if (def.key === 'interfaceLanguage') setLang(next === 'en' ? 'en' : 'fa');
      if (def.key === 'fontScale' || def.key === 'quranFontScale') {
        const ui = typeof values['fontScale'] === 'number' ? values['fontScale'] : 1;
        const quran = typeof values['quranFontScale'] === 'number' ? values['quranFontScale'] : 1;
        applyFontScales(ui, quran);
        cacheFontScales(ui, quran);
      }
      setMessage({
        kind: 'ok',
        text: `${settingLabel(def, tr)} → ${display(next, def, tr)}`,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gateway, state.value, tr, setThemePref, setLang],
  );

  return (
    <div className="stack">
      <MeTabs current="/me" />
      <StateBoundary
        state={state}
        emptyTitle={tr('تنظیمی برای نمایش نیست', 'There are no settings to show')}
        isEmpty={(value) => SETTING_DEFS.length === 0 || Object.keys(value.values).length === 0}
        onRetry={() => state.refresh()}
        skeleton={<div className="state state--loading">{tr('خواندن تنظیمات…', 'Reading settings…')}</div>}
      >
        {(value) => (
          <>
            <StatusLine message={message} />
            <Panel title={tr('تنظیمات', 'Settings')}>
              <p className="muted measure">
                {tr(
                  'هر تغییر بی‌درنگ در پایگاه داده ذخیره می‌شود و با فایل پشتیبان همراه شما می‌آید. گزینه‌ها از فهرست رسمی تنظیمات برنامه ساخته شده‌اند، پس مقدار نامعتبری نمی‌تواند از این صفحه نوشته شود.',
                  'Every change is stored at once and travels with your backup file. The controls are generated from the app’s official setting registry, so an invalid value cannot be written from this screen.',
                )}
              </p>
              <ul className="settings">
                {SETTING_DEFS.map((def) => (
                  <SettingRow
                    key={def.key}
                    def={def}
                    value={value.values[def.key] ?? def.default}
                    translations={value.translations}
                    ayahTotal={value.ayahTotal}
                    onPersist={(next) => void persist(def, next)}
                  />
                ))}
              </ul>
            </Panel>
            <Panel title={tr('همراه', 'Next to')}>
              <ConfirmResetAll
                onReset={async () => {
                  for (const def of SETTING_DEFS) await persist(def, def.default);
                }}
              />
            </Panel>
          </>
        )}
      </StateBoundary>
    </div>
  );
}

function ConfirmResetAll({ onReset }: { onReset: () => Promise<void> }) {
  const { tr } = useApp();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <div className="stack--tight">
        <Button variant="ghost" onClick={() => setOpen(true)}>
          {tr('بازگردانی همهٔ تنظیمات به پیش‌فرض', 'Reset all settings to their defaults')}
        </Button>
        {done ? <StatusLine message={{ kind: 'info', text: done }} /> : null}
      </div>
    );
  }
  return (
    <ConfirmBox
      title={tr('بازگردانی همهٔ تنظیمات', 'Reset every setting')}
      consequences={[
        tr(
          'همهٔ ' + SETTING_DEFS.length + ' کلید جدول settings با مقدار پیش‌فرض جایگزین می‌شود.',
          'All ' + SETTING_DEFS.length + ' keys in the settings table are replaced by their registry defaults.',
        ),
        tr('هیچ یادداشت، نشانک، آیة حفظ یا بستهٔ محتوایی حذف نمی‌شود.', 'No note, bookmark, hifz item or content pack is touched.'),
        tr('پوسته و زبان رابط نیز به پیش‌فرض برمی‌گردد.', 'Theme and interface language also return to their defaults.'),
      ]}
      confirmLabel={tr('بازگردانی کن', 'Reset them')}
      busy={busy}
      onConfirm={async () => {
        setBusy(true);
        try {
          await onReset();
          setDone(tr('تنظیمات به پیش‌فرض برگشت', 'Settings are back to their defaults'));
        } catch (cause) {
          setDone(`— ${cause instanceof Error ? cause.message : String(cause)}`);
        } finally {
          setBusy(false);
          setOpen(false);
        }
      }}
    />
  );
}

interface RowProps {
  def: SettingDef;
  value: SettingPrimitive;
  translations: TranslationOption[];
  ayahTotal: number;
  onPersist(next: SettingPrimitive): void;
}

interface ControlProps extends RowProps {
  /** Element id the control's label points at. */
  id: string;
}

function SettingRow({ def, value, translations, ayahTotal, onPersist }: RowProps) {
  const { tr } = useApp();
  const id = `setting-${def.key}`;
  const isDefault = String(value) === String(def.default);
  return (
    <li className="setting">
      <div className="setting__head">
        <span className="setting__key mono" dir="ltr">
          {def.key}
        </span>
        <span className="setting__current">{display(value, def, tr)}</span>
        {isDefault ? null : (
          <button type="button" className="btn btn--ghost btn--small" onClick={() => onPersist(def.default)}>
            {tr('پیش‌فرض', 'default')}
          </button>
        )}
      </div>
      <div className="setting__body">
        <Control def={def} id={id} value={value} translations={translations} ayahTotal={ayahTotal} onPersist={onPersist} />
        <p className="field__hint">
          {tr('پیش‌فرض', 'Default')}:{' '}
          <span className="mono" dir="ltr">
            {def.type === 'enum' ? choiceLabel(def.key, String(def.default), tr) : String(def.default)}
          </span>
          {def.type === 'number' ? ` · ${def.min}–${def.max}` : ''}
        </p>
      </div>
    </li>
  );
}

function Control({ def, id, value, translations, ayahTotal, onPersist }: ControlProps) {
  const { tr } = useApp();

  if (def.type === 'enum') {
    if (def.choices.length <= 3) {
      return (
        <fieldset className="radios" aria-labelledby={`${id}-label`}>
          <legend className="field__label" id={`${id}-label`}>
            {settingLabel(def, tr)}
          </legend>
          {def.choices.map((choice) => (
            <label key={choice} className="radio">
              <input
                type="radio"
                name={id}
                value={choice}
                checked={String(value) === choice}
                onChange={() => onPersist(choice)}
              />
              <span>{choiceLabel(def.key, choice, tr)}</span>
              <span className="faint mono" dir="ltr">
                {choice}
              </span>
            </label>
          ))}
        </fieldset>
      );
    }
    return (
      <Field label={settingLabel(def, tr)} htmlFor={id}>
        <select
          id={id}
          className="select"
          value={String(value)}
          onChange={(event) => onPersist(event.target.value)}
        >
          {def.choices.map((choice) => (
            <option key={choice} value={choice}>
              {choiceLabel(def.key, choice, tr)} — {choice}
            </option>
          ))}
        </select>
      </Field>
    );
  }

  if (def.type === 'number') {
    const step = numberStep(def);
    const numeric = typeof value === 'number' ? value : Number(value);
    const safe = Number.isFinite(numeric) ? numeric : def.default;
    return (
      <div className="scaler">
        <label className="field__label" htmlFor={`${id}-range`}>
          {settingLabel(def, tr)}
        </label>
        <div className="row">
          <input
            id={`${id}-range`}
            className="scaler__range"
            type="range"
            min={def.min}
            max={def.max}
            step={step}
            value={safe}
            onChange={(event) => {
              const next = clamp(Number(event.target.value), def.min, def.max);
              onPersist(next);
            }}
          />
          <input
            className="input scaler__number"
            type="number"
            aria-label={tr(`${settingLabel(def, tr)} — عدد`, `${settingLabel(def, tr)} — value`)}
            min={def.min}
            max={def.max}
            step={step}
            value={safe}
            onChange={(event) => {
              const raw = Number(event.target.value);
              if (!Number.isFinite(raw)) return;
              onPersist(clamp(raw, def.min, def.max));
            }}
          />
          <Chip tone="neutral">{`${Math.round(((safe - def.min) / (def.max - def.min || 1)) * 100)}%`}</Chip>
        </div>
      </div>
    );
  }

  if (def.type === 'boolean') {
    return (
      <label className="radio" id={`${id}-label`}>
        <input
          type="checkbox"
          checked={value === true || value === 'true'}
          onChange={(event) => onPersist(event.target.checked)}
        />
        <span>{settingLabel(def, tr)}</span>
      </label>
    );
  }

  if (def.key === 'translationPack') {
    return (
      <Field
        label={settingLabel(def, tr)}
        hint={tr(
          'فهرست از بسته‌های ترجمهٔ واردشده ساخته می‌شود؛ پوشش = تعداد آیات موجود در همان بسته.',
          'Built from the imported translation packs; coverage is the ayat that pack actually holds.',
        )}
        htmlFor={id}
      >
        <select
          id={id}
          className="select"
          value={String(value)}
          onChange={(event) => onPersist(event.target.value)}
        >
          <option value="">{tr('بدون ترجمه', 'no translation')}</option>
          {translations.map((option) => (
            <option key={option.packId} value={option.packId}>
              {`${option.title} · ${option.language} · ${option.coverage}/${ayahTotal}`}
            </option>
          ))}
        </select>
        {translations.length === 0 ? (
          <p className="field__error" role="alert">
            {tr('بستهٔ ترجمه‌ای وارد نشده است.', 'No translation pack has been imported yet.')}
          </p>
        ) : (
          <ul className="licence-list">
            {translations.map((option) => (
              <li key={`licence-${option.packId}`}>
                <span className="mono">{option.packId}</span> <span>{option.title}</span>{' '}
                <LicenseChip status={option.licenseStatus} tr={tr} />{' '}
                <span className="faint num">
                  {option.coverage}/{ayahTotal}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Field>
    );
  }

  return (
    <Field label={settingLabel(def, tr)} htmlFor={id}>
      <input
        id={id}
        className="input"
        type="text"
        maxLength={def.max}
        value={String(value)}
        onChange={(event) => onPersist(event.target.value.slice(0, def.max))}
      />
    </Field>
  );
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export const routes: readonly RouteDef[] = [
  {
    path: '/me',
    title: (t: Tr) => t('تنظیمات', 'Settings'),
    section: 'me',
    component: SettingsScreen,
  },
];
