/**
 * Shared UI for the manual-first competitor flow: creating a competitor with
 * sources in one shot, and adding one more source to an existing competitor.
 * Used by both CompetitorOnboarding (step 3) and CompetitorWorkspace (the
 * competitors panel), so the two surfaces stay in sync rather than drifting.
 */

import { useState } from 'react';
import { AlertTriangle, Loader2, Plus, Trash2 } from 'lucide-react';
import {
  SOURCE_KIND_OPTIONS, TERM_SOURCE_TYPES, TERM_SOURCE_PLACEHOLDERS,
  KIND_SOURCE_TYPES, SOURCE_KIND_SUB_OPTIONS, SOURCE_KIND_DEFAULTS,
  URL_FIELD_PLACEHOLDERS, PLATFORM_LABELS, isPlausibleUrl,
} from '../competitorApi.js';

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
  return (
    <div className="source-type-tabs cs-source-type-tabs" role="tablist" aria-label="Choose source type">
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
            {option.label}
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
  const options = SOURCE_KIND_SUB_OPTIONS[platform];
  if (!options) return null;
  return (
    <select
      className="cs-select"
      style={{ flex: '0 1 180px' }}
      value={kind || SOURCE_KIND_DEFAULTS[platform]}
      onChange={(event) => onChange(event.target.value)}
      aria-label={`${PLATFORM_LABELS[platform] || platform} source kind`}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  );
}

/** Comma-separated alternate-name editor for one competitor, e.g. "Younes
 *  Bros, قهوة يونس" - articles naming any of these count as evidence for
 *  that competitor. Shared by the workspace and the study edit page. */
export function AliasEditor({ competitor, onSave }) {
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
      <label className="cs-label" htmlFor={`cs-aliases-${competitor.id}`}>Other names</label>
      <div className="cs-alias-editor-row">
        <input
          id={`cs-aliases-${competitor.id}`}
          className="cs-input"
          value={value}
          placeholder="e.g. Younes Bros, قهوة يونس"
          onChange={(event) => { setValue(event.target.value); setSaved(false); }}
        />
        <button type="button" className="cs-btn cs-btn-sm" onClick={save} disabled={busy || !dirty}>
          {busy ? <span className="cs-spinner" /> : null} {saved && !dirty ? 'Saved' : 'Save'}
        </button>
      </div>
      <small className="cs-row-desc">
        Comma separated. Articles naming any of these count as evidence for this competitor.
      </small>
    </div>
  );
}

/** One source row's inputs. Term-type platforms (hashtag/keyword/username) take a
 *  bare name instead of a URL — the real URL is derived server-side — so they get a
 *  single input bound to `handle` instead of the usual URL + optional-handle pair. */
function SourceRowFields({ row, onChange }) {
  if (TERM_SOURCE_TYPES.has(row.platform)) {
    return (
      <input
        className="cs-input"
        style={{ flex: '1 1 220px' }}
        placeholder={TERM_SOURCE_PLACEHOLDERS[row.platform] || 'Value'}
        value={row.handle}
        onChange={(event) => onChange({ handle: event.target.value })}
      />
    );
  }
  return (
    <>
      <input
        className="cs-input"
        style={{ flex: '1 1 220px' }}
        placeholder={URL_FIELD_PLACEHOLDERS[row.platform] || 'https://...'}
        value={row.url}
        onChange={(event) => onChange({ url: event.target.value })}
      />
      <input
        className="cs-input"
        style={{ flex: '0 1 140px' }}
        placeholder="display name (optional)"
        value={row.handle}
        onChange={(event) => onChange({ handle: event.target.value })}
      />
    </>
  );
}

/** Name/website/description + a dynamic list of source rows, for creating a
 *  competitor and its sources on one screen. Sources are optional — a
 *  competitor can be added with none and get sources added later. */
export function AddCompetitorForm({ onSubmit, busy, submitLabel = 'Add competitor' }) {
  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  const [description, setDescription] = useState('');
  const [sources, setSources] = useState([emptySource()]);
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
    if (!name.trim()) nextErrors.name = 'A competitor name is required.';

    const usable = sources.filter((row) => row.url.trim() || row.handle.trim());
    usable.forEach((row, index) => {
      if (TERM_SOURCE_TYPES.has(row.platform)) {
        if (!row.handle.trim()) nextErrors[`source-${index}`] = 'Enter a value.';
      } else if (!isUsableSourceValue(row)) {
        nextErrors[`source-${index}`] = 'Enter a valid URL.';
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
          <label className="cs-label" htmlFor="cs-manual-name">Competitor name</label>
          <input
            id="cs-manual-name"
            className="cs-input"
            value={name}
            placeholder="Acme Inc."
            onChange={(event) => setName(event.target.value)}
          />
          {errors.name ? <div className="cs-source-error">{errors.name}</div> : null}
        </div>
        <div className="cs-field">
          <label className="cs-label" htmlFor="cs-manual-website">
            Website<span className="cs-label-hint">optional</span>
          </label>
          <input
            id="cs-manual-website"
            className="cs-input"
            value={website}
            placeholder="acme.com"
            onChange={(event) => setWebsite(event.target.value)}
          />
        </div>
      </div>

      <div className="cs-field">
        <label className="cs-label" htmlFor="cs-manual-desc">
          Description<span className="cs-label-hint">optional</span>
        </label>
        <input
          id="cs-manual-desc"
          className="cs-input"
          value={description}
          placeholder="What they do, briefly"
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>

      <label className="cs-label">Sources<span className="cs-label-hint">optional — add now or later</span></label>
      {sources.map((row, index) => (
        <div key={index} className="cs-source-row">
          <SourceTypeTabs
            value={row.platform}
            onChange={(platform) => updateSource(index, { platform, kind: SOURCE_KIND_DEFAULTS[platform] || '' })}
          />
          <SourceKindSelect platform={row.platform} kind={row.kind} onChange={(kind) => updateSource(index, { kind })} />
          <SourceRowFields row={row} onChange={(patch) => updateSource(index, patch)} />
          {sources.length > 1 ? (
            <button type="button" className="cs-btn cs-btn-sm cs-btn-danger" onClick={() => removeSource(index)} aria-label="Remove source">
              <Trash2 size={13} />
            </button>
          ) : null}
          {errors[`source-${index}`] ? (
            <div className="cs-source-error" style={{ width: '100%' }}>
              <AlertTriangle size={12} style={{ marginRight: 4, verticalAlign: -1 }} />
              {errors[`source-${index}`]}
            </div>
          ) : null}
        </div>
      ))}
      <button type="button" className="cs-btn cs-btn-sm" onClick={addSourceRow} style={{ marginBottom: 16 }}>
        <Plus size={13} /> Add another source
      </button>

      <div>
        <button type="button" className="cs-btn cs-btn-primary" onClick={submit} disabled={busy || !name.trim()}>
          {busy ? <Loader2 size={15} className="cs-spin" /> : <Plus size={15} />}
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

/** Single-row variant for adding one more source to an already-existing
 *  competitor — inline on that competitor's card/row. */
export function AddSourceRow({ onSubmit, busy }) {
  const [row, setRow] = useState(emptySource());
  const [error, setError] = useState('');

  const isTermType = TERM_SOURCE_TYPES.has(row.platform);

  const submit = async () => {
    if (isTermType) {
      if (!row.handle.trim()) {
        setError('Enter a value.');
        return;
      }
    } else if (!isUsableSourceValue(row)) {
      setError('Enter a valid URL.');
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
          {busy ? <Loader2 size={13} className="cs-spin" /> : <Plus size={13} />} Add
        </button>
      </div>
      {error ? (
        <div className="cs-source-error">
          <AlertTriangle size={12} style={{ marginRight: 4, verticalAlign: -1 }} />
          {error}
        </div>
      ) : null}
    </div>
  );
}
