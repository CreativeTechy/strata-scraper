/**
 * Shared UI for the manual-first competitor flow: creating a competitor with
 * sources in one shot, and adding one more source to an existing competitor.
 * Used by both CompetitorOnboarding (step 3) and CompetitorWorkspace (the
 * competitors panel), so the two surfaces stay in sync rather than drifting.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2, Plus, Trash2 } from 'lucide-react';
import {
  SOURCE_KIND_OPTIONS, TERM_SOURCE_TYPES, TERM_SOURCE_PLACEHOLDERS,
  KIND_SOURCE_TYPES, SOURCE_KIND_SUB_OPTIONS, SOURCE_KIND_DEFAULTS,
  URL_FIELD_PLACEHOLDERS, PLATFORM_LABELS, isPlausibleUrl,
} from '../competitorApi.js';

// competitorApi.js's option lists carry English labels; the stable `value`
// codes key the translated labels here, falling back to that English label.
function platformLabel(t, platform) {
  return t(`competitors:platforms.${platform}`, { defaultValue: PLATFORM_LABELS[platform] || platform });
}

function emptySource() {
  return { platform: 'web', url: '', handle: '', kind: '' };
}

/** A bare handle/slug is valid for a kind-disambiguated platform (the
 *  backend derives the real URL from it, same as the Sources page) even
 *  though it doesn't look like a URL on its own - only a genuinely empty
 *  value is rejected there. Every other platform still needs a plausible URL. */
function isUsableSourceValue(row) {
  if (isPlausibleUrl(row.url)) return true;
  return KIND_SOURCE_TYPES.has(row.platform) && row.url.trim().length > 0;
}

/** Platform picker as a tab row instead of a `<select>` - matches the
 *  source-type tabs on the Sources page and the project wizard
 *  (SourcesPage.jsx / ProjectsPage.jsx's SOURCE_TYPE_FORM_TABS) so picking a
 *  source's platform looks and behaves the same everywhere in the app. */
function SourceTypeTabs({ value, onChange }) {
  const { t } = useTranslation('competitors');
  return (
    <div className="source-type-tabs cs-source-type-tabs" role="tablist" aria-label={t('sourceEditor.chooseType')}>
      {SOURCE_KIND_OPTIONS.map((option) => {
        const isActive = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={`source-type-tab ${isActive ? 'active' : ''}`}
            onClick={() => onChange(option.value)}
          >
            {platformLabel(t, option.value)}
          </button>
        );
      })}
    </div>
  );
}

/** Disambiguates a bare handle/slug for platforms where one is ambiguous
 *  (subreddit vs. user vs. search, company vs. profile, ...) - same
 *  reddit_kind/linkedin_kind/threads_kind/facebook_kind/instagram_kind
 *  selector as the Sources page and project wizard, just one shared select
 *  keyed off the current platform instead of five separate fields. Hidden
 *  entirely for platforms with no kind concept (web, rss, tweet, ...) - an
 *  explicit full URL also makes it moot, but it stays visible even then
 *  since it's ignored rather than wrong in that case. */
function SourceKindSelect({ platform, kind, onChange }) {
  const { t } = useTranslation('competitors');
  const options = SOURCE_KIND_SUB_OPTIONS[platform];
  if (!options) return null;
  return (
    <select
      className="cs-select"
      style={{ flex: '0 1 180px' }}
      value={kind || SOURCE_KIND_DEFAULTS[platform]}
      onChange={(event) => onChange(event.target.value)}
      aria-label={t('sourceEditor.kindLabel', { platform: platformLabel(t, platform) })}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {t(`sourceKinds.${platform}.${option.value}`, { defaultValue: option.label })}
        </option>
      ))}
    </select>
  );
}

/** Comma-separated alternate-name editor for one competitor, e.g. "Younes
 *  Bros, قهوة يونس" - articles naming any of these count as evidence for
 *  that competitor. Shared by the workspace and the study edit page. */
export function AliasEditor({ competitor, onSave }) {
  const { t } = useTranslation('competitors');
  const stored = Array.isArray(competitor.aliases) ? competitor.aliases : [];
  const [value, setValue] = useState(stored.join(', '));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  // Re-syncing from props is handled by remounting on a key of the stored
  // aliases (see the call site), not by an effect that writes state.
  const dirty = value !== stored.join(', ');

  const save = async () => {
    setBusy(true);
    try {
      await onSave(value.split(',').map((item) => item.trim()).filter(Boolean));
      setSaved(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cs-alias-editor">
      <label className="cs-label" htmlFor={`cs-aliases-${competitor.id}`}>{t('sourceEditor.aliases.label')}</label>
      <div className="cs-alias-editor-row">
        <input
          id={`cs-aliases-${competitor.id}`}
          className="cs-input"
          dir="auto"
          value={value}
          placeholder={t('sourceEditor.aliases.placeholder')}
          onChange={(event) => { setValue(event.target.value); setSaved(false); }}
        />
        <button type="button" className="cs-btn cs-btn-sm" onClick={save} disabled={busy || !dirty}>
          {busy ? <span className="cs-spinner" /> : null} {saved && !dirty ? t('sourceEditor.aliases.saved') : t('common:actions.save')}
        </button>
      </div>
      <small className="cs-row-desc">
        {t('sourceEditor.aliases.hint')}
      </small>
    </div>
  );
}

/** One source row's inputs. Term-type platforms (hashtag/keyword/username) take a
 *  bare name instead of a URL — the real URL is derived server-side — so they get a
 *  single input bound to `handle` instead of the usual URL + optional-handle pair. */
function SourceRowFields({ row, onChange }) {
  const { t } = useTranslation('competitors');
  if (TERM_SOURCE_TYPES.has(row.platform)) {
    return (
      <input
        className="cs-input"
        dir="auto"
        style={{ flex: '1 1 220px' }}
        placeholder={
          TERM_SOURCE_PLACEHOLDERS[row.platform]
            ? t(`placeholders.term.${row.platform}`, { defaultValue: TERM_SOURCE_PLACEHOLDERS[row.platform] })
            : t('placeholders.value')
        }
        value={row.handle}
        onChange={(event) => onChange({ handle: event.target.value })}
      />
    );
  }
  return (
    <>
      {/* A kind-disambiguated platform's field also takes a bare search
          phrase (possibly Arabic); every other one is a URL. */}
      <input
        className="cs-input"
        dir={KIND_SOURCE_TYPES.has(row.platform) ? 'auto' : 'ltr'}
        style={{ flex: '1 1 220px' }}
        placeholder={
          URL_FIELD_PLACEHOLDERS[row.platform]
            ? t(`placeholders.url.${row.platform}`, { defaultValue: URL_FIELD_PLACEHOLDERS[row.platform] })
            : 'https://...'
        }
        value={row.url}
        onChange={(event) => onChange({ url: event.target.value })}
      />
      <input
        className="cs-input"
        dir="auto"
        style={{ flex: '0 1 140px' }}
        placeholder={t('sourceEditor.displayNamePlaceholder')}
        value={row.handle}
        onChange={(event) => onChange({ handle: event.target.value })}
      />
    </>
  );
}

/** Name/website/description + a dynamic list of source rows, for creating a
 *  competitor and its sources on one screen. Sources are optional — a
 *  competitor can be added with none and get sources added later. */
export function AddCompetitorForm({ onSubmit, busy, submitLabel }) {
  const { t } = useTranslation('competitors');
  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  const [description, setDescription] = useState('');
  const [sources, setSources] = useState([emptySource()]);
  // Values are i18n keys, translated at render so they follow the UI language.
  const [errors, setErrors] = useState({});

  const updateSource = (index, patch) => {
    setSources((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const removeSource = (index) => {
    setSources((current) => current.filter((_, i) => i !== index));
  };

  const addSourceRow = () => setSources((current) => [...current, emptySource()]);

  const submit = async () => {
    const nextErrors = {};
    if (!name.trim()) nextErrors.name = 'sourceEditor.errors.nameRequired';

    const usable = sources.filter((row) => row.url.trim() || row.handle.trim());
    usable.forEach((row, index) => {
      if (TERM_SOURCE_TYPES.has(row.platform)) {
        if (!row.handle.trim()) nextErrors[`source-${index}`] = 'sourceEditor.errors.valueRequired';
      } else if (!isUsableSourceValue(row)) {
        nextErrors[`source-${index}`] = 'sourceEditor.errors.invalidUrl';
      }
    });

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;

    await onSubmit({
      name: name.trim(),
      website: website.trim() || null,
      description: description.trim() || null,
      sources: usable.map((row) => (
        TERM_SOURCE_TYPES.has(row.platform)
          ? { platform: row.platform, url: '', handle: row.handle.trim() }
          : {
            platform: row.platform,
            url: row.url.trim(),
            handle: row.handle.trim() || null,
            kind: KIND_SOURCE_TYPES.has(row.platform) ? (row.kind || SOURCE_KIND_DEFAULTS[row.platform]) : null,
          }
      )),
    });

    setName('');
    setWebsite('');
    setDescription('');
    setSources([emptySource()]);
    setErrors({});
  };

  return (
    <div>
      <div className="cs-grid-2">
        <div className="cs-field">
          <label className="cs-label" htmlFor="cs-manual-name">{t('sourceEditor.competitorName')}</label>
          <input
            id="cs-manual-name"
            className="cs-input"
            dir="auto"
            value={name}
            placeholder={t('sourceEditor.competitorNamePlaceholder')}
            onChange={(event) => setName(event.target.value)}
          />
          {errors.name ? <div className="cs-source-error">{t(errors.name)}</div> : null}
        </div>
        <div className="cs-field">
          <label className="cs-label" htmlFor="cs-manual-website">
            {t('sourceEditor.website')}<span className="cs-label-hint">{t('optional')}</span>
          </label>
          <input
            id="cs-manual-website"
            className="cs-input"
            dir="ltr"
            value={website}
            placeholder="acme.com"
            onChange={(event) => setWebsite(event.target.value)}
          />
        </div>
      </div>

      <div className="cs-field">
        <label className="cs-label" htmlFor="cs-manual-desc">
          {t('sourceEditor.description')}<span className="cs-label-hint">{t('optional')}</span>
        </label>
        <input
          id="cs-manual-desc"
          className="cs-input"
          dir="auto"
          value={description}
          placeholder={t('sourceEditor.descriptionPlaceholder')}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>

      <label className="cs-label">{t('sourceEditor.sources')}<span className="cs-label-hint">{t('sourceEditor.sourcesHint')}</span></label>
      {sources.map((row, index) => (
        <div key={index} className="cs-source-row">
          <SourceTypeTabs
            value={row.platform}
            onChange={(platform) => updateSource(index, { platform, kind: SOURCE_KIND_DEFAULTS[platform] || '' })}
          />
          <SourceKindSelect platform={row.platform} kind={row.kind} onChange={(kind) => updateSource(index, { kind })} />
          <SourceRowFields row={row} onChange={(patch) => updateSource(index, patch)} />
          {sources.length > 1 ? (
            <button type="button" className="cs-btn cs-btn-sm cs-btn-danger" onClick={() => removeSource(index)} aria-label={t('sourceEditor.removeSource')}>
              <Trash2 size={13} />
            </button>
          ) : null}
          {errors[`source-${index}`] ? (
            <div className="cs-source-error" style={{ width: '100%' }}>
              <AlertTriangle size={12} style={{ marginInlineEnd: 4, verticalAlign: -1 }} />
              {t(errors[`source-${index}`])}
            </div>
          ) : null}
        </div>
      ))}
      <button type="button" className="cs-btn cs-btn-sm" onClick={addSourceRow} style={{ marginBottom: 16 }}>
        <Plus size={13} /> {t('sourceEditor.addAnotherSource')}
      </button>

      <div>
        <button type="button" className="cs-btn cs-btn-primary" onClick={submit} disabled={busy || !name.trim()}>
          {busy ? <Loader2 size={15} className="cs-spin" /> : <Plus size={15} />}
          {submitLabel || t('sourceEditor.addCompetitor')}
        </button>
      </div>
    </div>
  );
}

/** Single-row variant for adding one more source to an already-existing
 *  competitor — inline on that competitor's card/row. */
export function AddSourceRow({ onSubmit, busy }) {
  const { t } = useTranslation('competitors');
  const [row, setRow] = useState(emptySource());
  // An i18n key (translated at render), or '' for no error.
  const [error, setError] = useState('');

  const isTermType = TERM_SOURCE_TYPES.has(row.platform);

  const submit = async () => {
    if (isTermType) {
      if (!row.handle.trim()) {
        setError('sourceEditor.errors.valueRequired');
        return;
      }
    } else if (!isUsableSourceValue(row)) {
      setError('sourceEditor.errors.invalidUrl');
      return;
    }
    setError('');
    await onSubmit(
      isTermType
        ? { platform: row.platform, url: '', handle: row.handle.trim() }
        : {
          platform: row.platform,
          url: row.url.trim(),
          handle: row.handle.trim() || null,
          kind: KIND_SOURCE_TYPES.has(row.platform) ? (row.kind || SOURCE_KIND_DEFAULTS[row.platform]) : null,
        },
    );
    setRow(emptySource());
  };

  return (
    <div>
      <div className="cs-source-row">
        <SourceTypeTabs
          value={row.platform}
          onChange={(platform) => setRow({ ...row, platform, kind: SOURCE_KIND_DEFAULTS[platform] || '' })}
        />
        <SourceKindSelect platform={row.platform} kind={row.kind} onChange={(kind) => setRow({ ...row, kind })} />
        <SourceRowFields row={row} onChange={(patch) => setRow({ ...row, ...patch })} />
        <button
          type="button"
          className="cs-btn cs-btn-sm"
          onClick={submit}
          disabled={busy || (isTermType ? !row.handle.trim() : !row.url.trim())}
        >
          {busy ? <Loader2 size={13} className="cs-spin" /> : <Plus size={13} />} {t('common:actions.add')}
        </button>
      </div>
      {error ? (
        <div className="cs-source-error">
          <AlertTriangle size={12} style={{ marginInlineEnd: 4, verticalAlign: -1 }} />
          {t(error)}
        </div>
      ) : null}
    </div>
  );
}
