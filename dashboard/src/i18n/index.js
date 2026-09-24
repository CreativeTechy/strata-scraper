import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { DEFAULT_LANGUAGE, findLanguage, readStoredLanguage, storeLanguage } from './config.js';
import { namespaces, resources } from './resources.js';

function applyDocumentLanguage(code) {
  if (typeof document === 'undefined') return;
  const language = findLanguage(code) || findLanguage(DEFAULT_LANGUAGE);
  document.documentElement.lang = language.code;
  document.documentElement.dir = language.dir;
  if (i18n.isInitialized) document.title = i18n.t('common:app.fullName');
}

i18n.on('languageChanged', (code) => {
  applyDocumentLanguage(code);
  storeLanguage(code);
});

i18n.use(initReactI18next).init({
  resources,
  ns: namespaces,
  defaultNS: 'common',
  lng: readStoredLanguage(),
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: Object.keys(resources),
  // React already escapes rendered strings.
  interpolation: { escapeValue: false },
  returnNull: false,
  // Resources are bundled, so initialize synchronously: the first render
  // (and the <html lang dir> below) already has the stored language.
  initAsync: false,
});

applyDocumentLanguage(i18n.language);

export default i18n;
