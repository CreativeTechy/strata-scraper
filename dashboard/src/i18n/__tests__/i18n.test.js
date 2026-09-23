import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import i18n from '../index.js';
import { LANGUAGE_STORAGE_KEY, readStoredLanguage, resolveLanguage, storeLanguage } from '../config.js';
import { countryName, formatDate, formatNumber, isRtl, languageName } from '../format.js';
import { userFacingError, friendlyRunMessage } from '../../errors/userFacingError.js';
import { apiError } from '../../errors/apiError.js';
import { REPEAT_UNIT_OPTIONS } from '../../constants/schedule.js';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
    data,
  };
}

describe('language persistence', () => {
  it('defaults to English when nothing is stored', () => {
    expect(readStoredLanguage(memoryStorage())).toBe('en');
  });

  it('reads back a stored supported language', () => {
    expect(readStoredLanguage(memoryStorage({ [LANGUAGE_STORAGE_KEY]: 'ar' }))).toBe('ar');
  });

  it('falls back to English for an unsupported or garbled value', () => {
    expect(readStoredLanguage(memoryStorage({ [LANGUAGE_STORAGE_KEY]: 'xx' }))).toBe('en');
    expect(resolveLanguage('ar-SA')).toBe('ar');
  });

  it('survives storage that throws', () => {
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(readStoredLanguage(broken)).toBe('en');
    expect(() => storeLanguage('ar', broken)).not.toThrow();
  });

  it('stores the normalized code', () => {
    const storage = memoryStorage();
    storeLanguage('ar-EG', storage);
    expect(storage.data[LANGUAGE_STORAGE_KEY]).toBe('ar');
  });
});

describe('translation behavior', () => {
  beforeEach(async () => { await i18n.changeLanguage('ar'); });
  afterEach(async () => { await i18n.changeLanguage('en'); });

  it('switches direction with the language', () => {
    expect(i18n.dir()).toBe('rtl');
    expect(isRtl()).toBe(true);
  });

  it('falls back to English for a key missing in Arabic', () => {
    i18n.addResource('en', 'common', 'testOnly.englishOnly', 'Only in English');
    expect(i18n.t('common:testOnly.englishOnly')).toBe('Only in English');
  });

  it('interpolates values', () => {
    expect(i18n.t('common:pagination.page', { page: 2, total: 5 })).toBe('الصفحة 2 من 5');
  });

  it('selects every Arabic plural form', () => {
    const forms = [0, 1, 2, 3, 11, 100].map((count) => i18n.t('common:run.completeWithIssues', { count }));
    expect(new Set(forms).size).toBe(6);
    expect(forms[1]).toContain('مصدر واحد');
    expect(forms[2]).toContain('مصدران');
    expect(forms[3]).toContain('3 مصادر');
    expect(forms[4]).toContain('11 مصدرًا');
  });

  it('translates display labels while keeping stable values', () => {
    expect(REPEAT_UNIT_OPTIONS.map((option) => option.value)).toEqual(['minutes', 'hours', 'days']);
    expect(REPEAT_UNIT_OPTIONS[0].label).toBe('دقائق');
  });

  it('localizes language and country names', () => {
    expect(languageName('en')).not.toBe('English');
    expect(countryName('SA')).not.toBe('Saudi Arabia');
    expect(countryName('??', 'fallback')).toBe('fallback');
  });

  it('formats numbers with Latin digits', () => {
    expect(formatNumber(12345)).toMatch(/12.345/);
    expect(formatDate('not a date', undefined, 'raw')).toBe('raw');
  });
});

describe('API errors', () => {
  afterEach(async () => { await i18n.changeLanguage('en'); });

  it('keeps the English message and carries code/params', () => {
    const error = apiError(
      { error: 'Password must be at least 8 characters.', code: 'users.password_too_short', params: { min: 8 } },
      { status: 400 },
    );
    expect(error.message).toBe('Password must be at least 8 characters.');
    expect(error.code).toBe('users.password_too_short');
    expect(error.status).toBe(400);
  });

  it('renders a coded validation error in the UI language', async () => {
    const error = apiError(
      { error: 'Password must be at least 8 characters.', code: 'users.password_too_short', params: { min: 8 } },
      { status: 400 },
    );
    expect(userFacingError(error).message).toBe('Password must be at least 8 characters.');
    await i18n.changeLanguage('ar');
    const issue = userFacingError(error, { context: 'إنشاء المستخدم' });
    expect(issue.message).toBe('يجب ألا تقل كلمة المرور عن 8 أحرف.');
    expect(issue.title).toBe('تحقق من المعلومات المُدخلة');
  });

  it('classifies sign-in failures by code', async () => {
    await i18n.changeLanguage('ar');
    const issue = userFacingError(apiError({ error: 'Invalid username or password.', code: 'auth.invalid_credentials' }));
    expect(issue.title).toBe('فشل تسجيل الدخول');
  });

  it('keeps an uncoded English server message out of the Arabic notice body', async () => {
    await i18n.changeLanguage('ar');
    const issue = userFacingError('Some untranslated server sentence', { context: 'تحميل المقالات' });
    expect(issue.message).toBe('تعذّر تحميل المقالات.');
    expect(issue.technicalDetail).toBe('Some untranslated server sentence');
  });

  it('translates pipeline run summaries with plurals', async () => {
    expect(friendlyRunMessage({ message: '2 source(s) had fetch issues' })).toBe('Pipeline complete. 2 sources need attention.');
    await i18n.changeLanguage('ar');
    expect(friendlyRunMessage({ message: '2 source(s) had fetch issues' })).toContain('مصدران');
  });
});
