/**
 * The reader's toolbar: which translation pack is shown, and the licence state
 * of the one in use.
 *
 * A pack whose licence is not `clear` is labelled wherever it appears — the
 * chooser, the row and the reader header all print the same chip. Hiding it
 * would let an `unresolved` pack read like a licensed one.
 */
import type { Tr } from '../../app/app-state';
import type { TranslationOption } from '../../gateway/types';
import { Chip } from '../../ui/primitives';
import { licenseLabel, licenseTone } from './lib';

export function LicenseChip({ option, tr }: { option: TranslationOption; tr: Tr }) {
  if (option.licenseStatus === 'clear') return null;
  return (
    <Chip tone={licenseTone(option.licenseStatus)} title={option.packId}>
      {licenseLabel(tr, option.licenseStatus)}
    </Chip>
  );
}

export interface TranslationPickerProps {
  options: TranslationOption[];
  value: string;
  onChange(packId: string): void;
  tr: Tr;
  /** How many of the surah's ayat this pack actually translated, or null if unknown. */
  covered: number | null;
  totalAyahs: number;
}

export function TranslationPicker({
  options,
  value,
  onChange,
  tr,
  covered,
  totalAyahs,
}: TranslationPickerProps) {
  const active = options.find((option) => option.packId === value) ?? null;

  return (
    <fieldset className="trchooser">
      <legend>{tr('ترجمه', 'Translation')}</legend>
      {options.length === 0 ? (
        <p className="faint" role="status">
          {tr(
            'هیچ بستهٔ ترجمه‌ای وارد نشده است؛ متن عربی بدون ترجمه نمایش داده می‌شود.',
            'No translation pack is installed; the Arabic is shown on its own.',
          )}
        </p>
      ) : (
        <div className="trchooser__list" role="radiogroup" aria-label={tr('انتخاب بستهٔ ترجمه', 'Translation pack')}>
          <label className="trchooser__option">
            <input
              type="radio"
              name="translation-pack"
              checked={value === ''}
              onChange={() => onChange('')}
            />
            <span>{tr('بدون ترجمه', 'No translation')}</span>
          </label>
          {options.map((option) => (
            <label key={option.packId} className="trchooser__option">
              <input
                type="radio"
                name="translation-pack"
                data-pack-id={option.packId}
                checked={value === option.packId}
                onChange={() => onChange(option.packId)}
              />
              <span className="trchooser__title">{option.title}</span>
              <span className="faint mono">{option.language}</span>
              <span className="num faint" title={tr('ترجمه‌های موجود در کل مصحف', 'Rows in the whole mushaf')}>
                {option.coverage}
              </span>
              <LicenseChip option={option} tr={tr} />
            </label>
          ))}
        </div>
      )}
      {active && covered !== null && totalAyahs > 0 ? (
        <p className="faint">
          {covered < totalAyahs
            ? tr(
                `${covered} آیه از ${totalAyahs} آیهٔ این سوره در این بسته ترجمه دارد؛ بقیه بدون ترجمه می‌مانند.`,
                `${covered} of this surah's ${totalAyahs} ayat are translated in this pack; the rest stay untranslated.`,
              )
            : tr(
                'همهٔ آیات این سوره در این بسته ترجمه دارند.',
                'Every ayah of this surah is translated in this pack.',
              )}
        </p>
      ) : null}
    </fieldset>
  );
}
