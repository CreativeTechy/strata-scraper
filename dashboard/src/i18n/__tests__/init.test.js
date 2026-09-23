import { describe, expect, it } from 'vitest';

describe('startup language', () => {
  it('is the stored language, resolved synchronously before first render', async () => {
    const stored = { 'strata.language': 'ar' };
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: (key) => stored[key] ?? null, setItem: (key, value) => { stored[key] = value; } },
    });
    const { default: i18n } = await import('../index.js');
    expect(i18n.isInitialized).toBe(true);
    expect(i18n.language).toBe('ar');
    expect(i18n.t('common:actions.save')).toBe('حفظ');
    await i18n.changeLanguage('en');
    expect(stored['strata.language']).toBe('en');
  });
});
