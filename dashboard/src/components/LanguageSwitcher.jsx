import { Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SUPPORTED_LANGUAGES, resolveLanguage } from '../i18n/config.js';

// English / العربية switch. Changing language only re-renders the UI - it
// never refetches or rewrites data, so filters, selections, and stored
// results survive the switch. `compact` renders a single icon button that
// cycles languages, for the collapsed sidebar rail.
export default function LanguageSwitcher({ compact = false, className = '' }) {
  const { t, i18n } = useTranslation();
  const current = resolveLanguage(i18n.resolvedLanguage || i18n.language);

  if (compact) {
    const index = SUPPORTED_LANGUAGES.findIndex((language) => language.code === current);
    const next = SUPPORTED_LANGUAGES[(index + 1) % SUPPORTED_LANGUAGES.length];
    const label = t('language.switchTo', { language: next.label });
    return (
      <button
        type="button"
        className={`language-switcher-compact ${className}`.trim()}
        onClick={() => i18n.changeLanguage(next.code)}
        title={label}
        aria-label={label}
      >
        <Languages size={16} />
      </button>
    );
  }

  return (
    <div className={`language-switcher ${className}`.trim()} role="group" aria-label={t('language.label')}>
      <Languages size={14} aria-hidden="true" className="language-switcher-icon" />
      {SUPPORTED_LANGUAGES.map((language) => (
        <button
          key={language.code}
          type="button"
          lang={language.code}
          dir={language.dir}
          className={`language-switcher-option${language.code === current ? ' is-active' : ''}`}
          aria-pressed={language.code === current}
          onClick={() => i18n.changeLanguage(language.code)}
        >
          {language.label}
        </button>
      ))}
    </div>
  );
}
