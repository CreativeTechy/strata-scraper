// Locale registry. Adding a language means adding it here plus a
// locales/<code>/ folder with the same namespace files as locales/en/ -
// nothing else in the app hardcodes a language list.
export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English', dir: 'ltr', intlLocale: 'en' },
  // Latin digits (nu-latn) on purpose: the dashboard is dense with counts,
  // IDs, dates, and URLs sitting next to each other, and mixing Arabic-Indic
  // digits into that is harder to scan than it is helpful.
  { code: 'ar', label: 'العربية', dir: 'rtl', intlLocale: 'ar-u-nu-latn' },
];

export const DEFAULT_LANGUAGE = 'en';
export const LANGUAGE_STORAGE_KEY = 'strata.language';

export function findLanguage(code) {
  const base = String(code || '').toLowerCase().split('-')[0];
  return SUPPORTED_LANGUAGES.find((language) => language.code === base) || null;
}

export function resolveLanguage(code) {
  return (findLanguage(code) || findLanguage(DEFAULT_LANGUAGE)).code;
}

export function readStoredLanguage(storage = globalThis.localStorage) {
  try {
    return resolveLanguage(storage?.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    // Private mode / blocked storage: fall back to the default.
    return DEFAULT_LANGUAGE;
  }
}

export function storeLanguage(code, storage = globalThis.localStorage) {
  try {
    storage?.setItem(LANGUAGE_STORAGE_KEY, resolveLanguage(code));
  } catch {
    // Persisting the choice is a convenience; ignore storage failures.
  }
}
