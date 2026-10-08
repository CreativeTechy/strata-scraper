import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Hash,
  KeyRound,
  RefreshCw,
  RotateCcw,
  Save,
  Settings as SettingsIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ErrorNotice from './ErrorNotice';
import { useAuth } from '../auth/useAuth.js';
import { apiError } from '../errors/apiError.js';
import { formatNumber } from '../i18n/format.js';
import '../styles/AdminUsers.css';
import '../styles/Settings.css';

const FIELDS = ['actor', 'max', 'timeout'];

// lucide ships no brand icons, so each platform gets a short monogram badge.
const PLATFORM_BADGE = { twitter: 'X', reddit: 'R', linkedin: 'in', threads: '@', instagram: 'Ig', facebook: 'f' };

function formatUsd(value) {
  return formatNumber(value, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });
}

// One line describing how an actor charges, plus (for per-result pricing) the
// most a single call can cost at the configured cap. Pay-per-event and rental
// actors have no per-post figure to multiply, so only their list price shows.
function PriceCell({ pricing, maxPosts, t }) {
  if (!pricing) return <span className="settings-muted">{t('pricing.loading')}</span>;
  if (pricing.error) return <span className="settings-muted">{t(`pricing.error.${pricing.error}`)}</span>;

  const parts = [];
  let ceiling = null;
  if (pricing.per_result_usd != null) {
    parts.push(t('pricing.perThousand', { price: formatUsd(pricing.per_result_usd * 1000), unit: pricing.unit || t('pricing.result') }));
    ceiling = pricing.per_result_usd * maxPosts;
  }
  for (const event of pricing.events || []) {
    parts.push(t('pricing.perEvent', { price: formatUsd(event.price_usd), event: event.title || '' }));
  }
  if (pricing.monthly_usd != null) parts.push(t('pricing.monthly', { price: formatUsd(pricing.monthly_usd) }));
  // Only an actor Apify lists as FREE is free; a paid model whose price we
  // couldn't read must not be shown as free.
  const summary = parts.length ? parts.join(' + ') : t(pricing.model === 'FREE' ? 'pricing.free' : 'pricing.unknown');

  return (
    <div className="settings-price">
      <span className="settings-price-main">{summary}</span>
      {ceiling != null && (
        <span className="settings-muted">{t('pricing.ceiling', { posts: maxPosts, price: formatUsd(ceiling) })}</span>
      )}
      <a className="settings-link" href={pricing.url} target="_blank" rel="noreferrer">
        {t('pricing.viewOnApify')} <ExternalLink size={12} aria-hidden="true" />
      </a>
    </div>
  );
}

export default function SettingsPage() {
  const { t } = useTranslation('settings');
  const { hasPermission } = useAuth();
  const canUpdate = hasPermission('settings.update');

  const [data, setData] = useState(null);
  const [form, setForm] = useState({});
  const [pricing, setPricing] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pricingLoading, setPricingLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const adopt = useCallback((next) => {
    const values = {};
    for (const tier of next.tiers) {
      for (const field of FIELDS) values[tier[`${field}_key`]] = String(tier[field]);
    }
    setData(next);
    setForm(values);
  }, []);

  const loadPricing = useCallback(async (refresh = false) => {
    setPricingLoading(true);
    try {
      const res = await fetch(`/api/settings/apify/pricing${refresh ? '?refresh=true' : ''}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(body, { status: res.status, fallback: t('pricing.loadFailed') });
      setPricing(body.pricing || {});
    } catch (err) {
      setError(err);
    } finally {
      setPricingLoading(false);
    }
  }, [t]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/settings/apify');
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(body, { status: res.status, fallback: t('loadFailed') });
      adopt(body);
      loadPricing();
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [adopt, loadPricing, t]);

  useEffect(() => {
    load();
    // Load once on mount; `t` only changes with the UI language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keyed by env var, so rows that share a max-posts setting stay in step.
  const serverValues = useMemo(() => {
    const values = {};
    for (const tier of data?.tiers || []) {
      for (const field of FIELDS) values[tier[`${field}_key`]] = String(tier[field]);
    }
    return values;
  }, [data]);
  const defaults = useMemo(() => {
    const values = {};
    for (const tier of data?.tiers || []) {
      for (const field of FIELDS) values[tier[`${field}_key`]] = String(tier[`${field}_default`]);
    }
    return values;
  }, [data]);
  const dirtyKeys = Object.keys(form).filter((key) => form[key].trim() !== serverValues[key]);

  const setField = (key, value) => {
    setSaved(false);
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      // A value equal to the built-in default is sent as null, which clears
      // the stored override instead of pinning today's default forever.
      const values = Object.fromEntries(
        dirtyKeys.map((key) => [key, form[key].trim() === defaults[key] ? null : form[key].trim()]),
      );
      const res = await fetch('/api/settings/apify', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(body, { status: res.status, fallback: t('saveFailed') });
      adopt(body);
      setSaved(true);
      loadPricing();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  const groups = useMemo(() => {
    const byPlatform = new Map();
    for (const tier of data?.tiers || []) {
      if (!byPlatform.has(tier.platform)) byPlatform.set(tier.platform, []);
      byPlatform.get(tier.platform).push(tier);
    }
    return [...byPlatform.entries()];
  }, [data]);

  const customizedCount = (data?.tiers || []).reduce(
    (count, tier) => count + (FIELDS.some((field) => tier[`${field}_overridden`]) ? 1 : 0),
    0,
  );

  const renderInput = (tier, field, inputProps, unit) => {
    const key = tier[`${field}_key`];
    const isDefault = form[key]?.trim() === defaults[key];
    return (
      <div className="settings-input-wrap">
        <input
          {...inputProps}
          value={form[key] ?? ''}
          disabled={!canUpdate || saving}
          onChange={(event) => setField(key, event.target.value)}
          aria-label={`${t(`platforms.${tier.platform}`)} ${t(`kinds.${tier.kind}`)} - ${t(`fields.${field}`)}`}
        />
        {unit && <span className="settings-input-unit">{unit}</span>}
        {canUpdate && !isDefault && (
          <button
            type="button"
            className="settings-reset"
            onClick={() => setField(key, defaults[key])}
            title={t('resetTo', { value: defaults[key] })}
            aria-label={t('resetTo', { value: defaults[key] })}
          >
            <RotateCcw size={13} aria-hidden="true" />
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="admin-page-shell">
      <div className="admin-page-header">
        <div>
          <div className="admin-page-kicker">
            <SettingsIcon size={14} /> {t('kicker')}
          </div>
          <h1 className="admin-page-title">{t('title')}</h1>
          <p className="admin-page-subtitle">{t('subtitle')}</p>
        </div>
        <div className="admin-page-toolbar">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => loadPricing(true)}
            disabled={pricingLoading || loading}
          >
            <RefreshCw size={16} className={pricingLoading ? 'settings-spin' : undefined} /> {t('pricing.refresh')}
          </button>
        </div>
      </div>

      <ErrorNotice error={error} context={t('errorContext')} onRetry={load} onDismiss={() => setError('')} />

      {loading && (
        <div className="settings-skeletons" aria-busy="true" aria-label={t('loading')}>
          <div className="settings-skeleton" />
          <div className="settings-skeleton settings-skeleton-tall" />
          <div className="settings-skeleton settings-skeleton-tall" />
        </div>
      )}

      {data && (
        <>
          <div className="settings-summary">
            <div className={`settings-stat ${data.token_configured ? 'settings-stat-ok' : 'settings-stat-warn'}`}>
              <span className="settings-stat-icon">
                {data.token_configured ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
              </span>
              <div>
                <span className="settings-stat-label">{t('summary.token')}</span>
                <strong>{data.token_configured ? t('summary.tokenOk') : t('summary.tokenMissing')}</strong>
              </div>
            </div>
            <div className="settings-stat">
              <span className="settings-stat-icon"><KeyRound size={18} /></span>
              <div>
                <span className="settings-stat-label">{t('summary.actors')}</span>
                <strong>{formatNumber(data.tiers.length)}</strong>
              </div>
            </div>
            <div className="settings-stat">
              <span className="settings-stat-icon"><Hash size={18} /></span>
              <div>
                <span className="settings-stat-label">{t('summary.customized')}</span>
                <strong>{formatNumber(customizedCount)}</strong>
              </div>
            </div>
          </div>

          {!data.token_configured && (
            <div className="settings-banner" role="status">{t('tokenMissing')}</div>
          )}

          <form onSubmit={save}>
            {groups.map(([platform, tiers]) => (
              <section className="glass-card settings-group" key={platform} aria-labelledby={`settings-${platform}`}>
                <header className="settings-group-header">
                  <span className={`settings-badge settings-badge-${platform}`} aria-hidden="true">
                    {PLATFORM_BADGE[platform] || platform.charAt(0).toUpperCase()}
                  </span>
                  <h2 className="settings-group-title" id={`settings-${platform}`}>{t(`platforms.${platform}`)}</h2>
                  <span className="panel-chip">{t('actorCount', { count: tiers.length })}</span>
                </header>

                <div className="settings-actors">
                  {tiers.map((tier) => {
                    const savedActor = serverValues[tier.actor_key];
                    const maxPosts = Number.parseInt(form[tier.max_key], 10) || tier.max;
                    const rowDirty = FIELDS.some(
                      (field) => form[tier[`${field}_key`]]?.trim() !== serverValues[tier[`${field}_key`]],
                    );
                    const rowCustom = FIELDS.some((field) => tier[`${field}_overridden`]);
                    return (
                      <div className={`settings-actor${rowDirty ? ' settings-actor-dirty' : ''}`} key={tier.id}>
                        <div className="settings-actor-head">
                          <span className="settings-kind">{t(`kinds.${tier.kind}`)}</span>
                          {rowDirty && <span className="settings-chip settings-chip-dirty">{t('unsavedChip')}</span>}
                          {!rowDirty && rowCustom && <span className="settings-chip">{t('customizedChip')}</span>}
                        </div>

                        <div className="settings-fields">
                          <label className="settings-field settings-field-actor">
                            <span className="settings-label">{t('fields.actor')}</span>
                            {renderInput(tier, 'actor', { type: 'text', dir: 'ltr', spellCheck: false, placeholder: 'username/actor-name' })}
                          </label>
                          <label className="settings-field">
                            <span className="settings-label">{t('fields.max')}</span>
                            {renderInput(tier, 'max', { type: 'number', inputMode: 'numeric', min: data.limits.max.min, max: data.limits.max.max })}
                          </label>
                          <label className="settings-field">
                            <span className="settings-label"><Clock size={11} aria-hidden="true" /> {t('fields.timeout')}</span>
                            {renderInput(tier, 'timeout', { type: 'number', inputMode: 'numeric', min: data.limits.timeout.min, max: data.limits.timeout.max }, t('secondsShort'))}
                          </label>
                        </div>

                        <div className="settings-pricebox">
                          <span className="settings-label">{t('fields.price')}</span>
                          {form[tier.actor_key]?.trim() === savedActor ? (
                            <PriceCell pricing={pricing ? pricing[savedActor] : null} maxPosts={maxPosts} t={t} />
                          ) : (
                            <span className="settings-muted">{t('pricing.saveToSee')}</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}

            <p className="settings-note">{t('note')}</p>

            {canUpdate ? (
              <div className={`settings-savebar${dirtyKeys.length ? ' settings-savebar-active' : ''}`}>
                <span className="settings-savebar-status" role="status">
                  {dirtyKeys.length > 0
                    ? t('unsavedCount', { count: dirtyKeys.length })
                    : (saved ? t('saved') : t('noChanges'))}
                </span>
                <div className="settings-savebar-buttons">
                  {dirtyKeys.length > 0 && !saving && (
                    <button type="button" className="btn-secondary" onClick={() => setForm(serverValues)}>
                      {t('discard')}
                    </button>
                  )}
                  <button type="submit" className="btn-primary" disabled={saving || dirtyKeys.length === 0}>
                    <Save size={16} /> {saving ? t('saving') : t('save')}
                  </button>
                </div>
              </div>
            ) : (
              <p className="settings-muted">{t('readOnly')}</p>
            )}
          </form>
        </>
      )}
    </div>
  );
}
