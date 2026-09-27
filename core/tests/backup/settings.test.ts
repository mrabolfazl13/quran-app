import { describe, expect, it } from 'vitest';
import {
  coerceSetting,
  defaultSettings,
  sanitizeSettings,
  settingDef,
  settingKeys,
} from '../../src/backup/settings';

describe('settings registry', () => {
  it('covers the required domains with sane defaults', () => {
    const keys = settingKeys();
    for (const expected of [
      'theme',
      'interfaceLanguage',
      'translationPack',
      'readingMode',
      'fontScale',
      'hifzSessionNewItemTarget',
      'hifzSessionReviewCap',
      'hifzSessionDefaultMode',
      'hifzAutoAudio',
    ]) {
      expect(keys).toContain(expected);
    }
    const defaults = defaultSettings();
    expect(Object.keys(defaults).sort()).toEqual([...keys].sort());
    expect(defaults.theme).toBe('system');
    expect(defaults.interfaceLanguage).toBe('fa');
    expect(defaults.fontScale).toBe(1);
    expect(defaults.readingMode).toBe('mushaf');
    expect(typeof defaults.hifzSessionNewItemTarget).toBe('number');
  });

  it('coerces stringly-typed DB values back to declared types', () => {
    expect(coerceSetting('fontScale', '1.2')).toEqual({ ok: true, value: 1.2 });
    expect(coerceSetting('hifzAutoAudio', 'true')).toEqual({ ok: true, value: true });
    expect(coerceSetting('theme', 'dark')).toEqual({ ok: true, value: 'dark' });
  });

  it('rejects hostile or malformed values', () => {
    expect(coerceSetting('fontScale', 999).ok).toBe(false); // out of range
    expect(coerceSetting('fontScale', 'abc').ok).toBe(false);
    expect(coerceSetting('theme', 'hot-pink').ok).toBe(false); // not an enum choice
    expect(coerceSetting('interfaceLanguage', 'ar').ok).toBe(false);
    expect(coerceSetting('translationPack', "'; DROP TABLE settings;--").ok).toBe(false);
    expect(coerceSetting('translationPack', 'ok-but-way-too-long'.repeat(5)).ok).toBe(false);
    expect(coerceSetting('hifzAutoAudio', 1).ok).toBe(false); // numbers are not booleans here
    expect(coerceSetting('theme', { evil: true }).ok).toBe(false);
  });

  it('allowlist blocks arbitrary keys — the core injection defence', () => {
    const hostile: Record<string, unknown> = Object.create(null);
    hostile.theme = 'dark';
    hostile.evilKey = 'injected';
    hostile.__proto__ = 'x'; // own property on a null-prototype object
    hostile.fontScale = '2';
    const result = sanitizeSettings(hostile);
    expect(result.settings).toEqual({ theme: 'dark', fontScale: 2 });
    expect(result.rejected.map((r) => r.key).sort()).toEqual(['__proto__', 'evilKey']);
    expect(settingDef('evilKey')).toBeUndefined();
    expect(coerceSetting('evilKey', 'anything').ok).toBe(false);
    expect(({} as Record<string, unknown>).__proto__ === undefined).toBe(false); // unchanged
  });

  it('applyDefaults fills missing known keys', () => {
    const result = sanitizeSettings({ theme: 'light' }, { applyDefaults: true });
    expect(Object.keys(result.settings).length).toBe(settingKeys().length);
    expect(result.settings.hifzSessionReviewCap).toBe(20);
    expect(result.defaulted).toContain('fontScale');
  });

  it('control characters and NUL never survive coercion', () => {
    expect(coerceSetting('theme', 'dark\u0000').ok).toBe(false);
    expect(coerceSetting('translationPack', 'tr\u0000fa').ok).toBe(false);
  });
});
