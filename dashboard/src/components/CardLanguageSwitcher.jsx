import { Languages } from 'lucide-react';
import { SUPPORTED_LANGUAGES } from '../i18n/config.js';

// A single card's own English / العربية switch, independent of the global
// LanguageSwitcher: it changes the language of this card's content only, and
// leaves the interface language (and every other card) alone. Same markup and
// styling as the global switch, so the two read as the same control. `busy`
// spins the icon and locks the options while the card fetches a translation.
export default function CardLanguageSwitcher({ value, onChange, label, hint, busy = false }) {
  return (
    <div className="language-switcher" role="group" aria-label={label} title={hint} aria-busy={busy}>
      <Languages size={14} aria-hidden="true" className={`language-switcher-icon${busy ? ' spin' : ''}`} />
      {SUPPORTED_LANGUAGES.map((language) => (
        <button
          key={language.code}
          type="button"
          lang={language.code}
          dir={language.dir}
          className={`language-switcher-option${language.code === value ? ' is-active' : ''}`}
          aria-pressed={language.code === value}
          disabled={busy}
          onClick={() => onChange(language.code)}
        >
          {language.label}
        </button>
      ))}
    </div>
  );
}
