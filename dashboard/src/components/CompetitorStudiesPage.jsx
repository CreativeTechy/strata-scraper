/**
 * Competitor studies index — the entry point for the competitor experience.
 *
 * Separate from the sentiment/opinion screens on purpose: the two answer different
 * questions and mixing them was what made the old single dashboard hard to read.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import {
  Building2, CalendarClock, ChevronRight, LayoutGrid, List, Plus, Radar, Search,
  Sparkles, X,
} from 'lucide-react';
import { avatarGradient, initials, listStudies, relativeTime } from '../competitorApi.js';
import { formatNumber } from '../i18n/format.js';
import ErrorNotice from './ErrorNotice';
import '../styles/Competitors.css';

// `labelKey`s are competitors-namespace i18n keys, translated at render.
const STATUS_FILTERS = [
  { key: 'all', labelKey: 'studies.allStatuses' },
  { key: 'active', labelKey: 'studyStatus.active' },
  { key: 'draft', labelKey: 'studyStatus.draft' },
  { key: 'archived', labelKey: 'studyStatus.archived' },
];

const VIEW_MODES = [
  { value: 'card', labelKey: 'studies.viewCards', icon: LayoutGrid },
  { value: 'list', labelKey: 'studies.viewList', icon: List },
];

function StudyRow({ study }) {
  const { t } = useTranslation('competitors');
  const articleCount = Number(study.article_count || 0);
  return (
    <Link to={`/competitors/${study.id}`} className="cs-finding-row" style={{ textDecoration: 'none' }}>
      <span className="cs-avatar cs-finding-row-avatar" style={{ background: avatarGradient(study.name) }} aria-hidden="true">
        {initials(study.name)}
      </span>
      <span className="cs-finding-row-main">
        <span className="cs-finding-row-name">
          {study.business_name ? <bdi>{study.business_name}</bdi> : t('studies.noProfile')}
          {study.market ? <> · <bdi>{study.market}</bdi></> : null}
        </span>
        <span className="cs-finding-row-headline" dir="auto">{study.name}</span>
      </span>
      <span className="cs-finding-row-meta">
        {[
          t('studies.trackedCount', { formatted: formatNumber(study.tracked_competitors || 0) }),
          t('studies.articleCount', { count: articleCount, formatted: formatNumber(articleCount) }),
          study.last_scraped_at ? relativeTime(study.last_scraped_at) : t('studies.neverScraped'),
        ].join(' · ')}
      </span>
      <ChevronRight size={15} className="cs-finding-row-chevron icon-flip-rtl" />
    </Link>
  );
}

export default function CompetitorStudiesPage() {
  const { t } = useTranslation('competitors');
  const navigate = useNavigate();
  const [studies, setStudies] = useState([]);
  const [loading, setLoading] = useState(true);
  // Holds the caught Error itself (not just .message) so its API error code
  // reaches ErrorNotice for translation; '' means no error.
  const [error, setError] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [viewMode, setViewMode] = useState(() => {
    try {
      return window.localStorage.getItem('competitor-studies-view-mode') === 'list' ? 'list' : 'card';
    } catch {
      return 'card';
    }
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await listStudies();
        if (!cancelled) setStudies(result.studies || []);
      } catch (caught) {
        if (!cancelled) setError(caught);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounce the free-text search the same way ArticlesPage does, so every
  // keystroke doesn't re-filter the list.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim().toLowerCase()), 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const hasFilters = Boolean(search || statusFilter !== 'all' || dateFrom || dateTo);

  const clearFilters = () => {
    setSearchInput('');
    setSearch('');
    setStatusFilter('all');
    setDateFrom('');
    setDateTo('');
  };

  const changeViewMode = (mode) => {
    setViewMode(mode);
    try {
      window.localStorage.setItem('competitor-studies-view-mode', mode);
    } catch {
      // ignore - persistence is a nicety, not a requirement
    }
  };

  // Studies are a small, fully-loaded list (unlike articles), so filtering
  // client-side avoids adding query params to an endpoint built for a
  // one-shot summary read.
  const filteredStudies = useMemo(() => {
    const fromTime = dateFrom ? new Date(dateFrom).getTime() : null;
    const toTime = dateTo ? new Date(`${dateTo}T23:59:59.999`).getTime() : null;
    return studies.filter((study) => {
      if (statusFilter !== 'all' && (study.status || 'active') !== statusFilter) return false;
      if (search) {
        const haystack = [study.name, study.business_name, study.market, study.industry]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      if (fromTime != null || toTime != null) {
        const scraped = study.last_scraped_at ? new Date(study.last_scraped_at).getTime() : null;
        if (scraped == null) return false;
        if (fromTime != null && scraped < fromTime) return false;
        if (toTime != null && scraped > toTime) return false;
      }
      return true;
    });
  }, [studies, search, statusFilter, dateFrom, dateTo]);

  return (
    <div className="cs-page">
      <div className="cs-head">
        <div>
          <h1>{t('studies.title')}</h1>
          <p>{t('studies.intro')}</p>
        </div>
        <div className="cs-head-actions">
          <button type="button" className="cs-btn cs-btn-primary" onClick={() => navigate('/competitors/new')}>
            <Plus size={15} /> {t('studies.newStudy')}
          </button>
        </div>
      </div>

      <ErrorNotice error={error} context={t('errorContext.loadStudies')} />

      {loading ? (
        <div className="cs-card-grid">
          {[0, 1].map((key) => <div key={key} className="cs-skeleton" style={{ height: 170 }} />)}
        </div>
      ) : studies.length ? (
        <>
          <div className="cs-panel cs-findings-toolbar">
            <label className="cs-search-field">
              <Search size={16} />
              <input
                type="text"
                dir="auto"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder={t('studies.searchPlaceholder')}
              />
            </label>

            <select className="cs-select" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}
              aria-label={t('studies.filterByStatus')}>
              {STATUS_FILTERS.map((option) => (
                <option key={option.key} value={option.key}>{t(option.labelKey)}</option>
              ))}
            </select>

            <div className="cs-date-range">
              <input type="date" className="cs-input" value={dateFrom}
                onChange={(event) => setDateFrom(event.target.value)} aria-label={t('studies.lastScrapedFrom')} />
              <span>{t('dateRangeSeparator')}</span>
              <input type="date" className="cs-input" value={dateTo}
                onChange={(event) => setDateTo(event.target.value)} aria-label={t('studies.lastScrapedTo')} />
            </div>

            {hasFilters ? (
              <button type="button" className="cs-btn cs-btn-sm" onClick={clearFilters}>
                <X size={13} /> {t('common:actions.clearFilters')}
              </button>
            ) : null}

            <div className="cs-view-tabs" role="tablist" aria-label={t('studies.switchView')}>
              {VIEW_MODES.map((mode) => {
                const Icon = mode.icon;
                const isActive = viewMode === mode.value;
                return (
                  <button key={mode.value} type="button" role="tab" aria-selected={isActive}
                    className={`cs-view-tab${isActive ? ' active' : ''}`} onClick={() => changeViewMode(mode.value)}>
                    <Icon size={14} /> {t(mode.labelKey)}
                  </button>
                );
              })}
            </div>
          </div>

          {filteredStudies.length ? (
            viewMode === 'list' ? (
              <div className="cs-finding-list">
                {filteredStudies.map((study) => <StudyRow key={study.id} study={study} />)}
              </div>
            ) : (
              <div className="cs-card-grid">
                {filteredStudies.map((study) => (
                  <Link key={study.id} to={`/competitors/${study.id}`} className="cs-card" style={{ textDecoration: 'none' }}>
                    <span className={`cs-card-spine ${study.high_impact_count ? 'cs-card-spine-high' : 'cs-card-spine-low'}`} aria-hidden="true" />
                    <div className="cs-card-body">
                      <div className="cs-card-top">
                        <div style={{ minWidth: 0 }}>
                          <h3 className="cs-card-headline" style={{ fontSize: '1.05rem' }} dir="auto">{study.name}</h3>
                          {study.business_name ? (
                            <p className="cs-card-domain" style={{ marginTop: 5 }}>
                              <Building2 size={11} style={{ display: 'inline', verticalAlign: -1, marginInlineEnd: 4 }} />
                              <bdi>{study.business_name}</bdi>
                              {study.market ? <> · <bdi>{study.market}</bdi></> : null}
                            </p>
                          ) : (
                            <p className="cs-card-domain" style={{ marginTop: 5, color: '#a16207' }}>
                              {t('studies.noProfile')}
                            </p>
                          )}
                        </div>
                      </div>

                      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: '0.83rem', color: 'var(--text-light)' }}>
                        <span>
                          <Trans
                            t={t}
                            i18nKey="studies.trackedStrong"
                            values={{ formatted: formatNumber(study.tracked_competitors || 0) }}
                            components={{ strong: <strong style={{ color: 'var(--text-dark)' }} /> }}
                          />
                        </span>
                        <span>
                          <Trans
                            t={t}
                            i18nKey="studies.articlesStrong"
                            count={Number(study.article_count || 0)}
                            values={{ formatted: formatNumber(study.article_count || 0) }}
                            components={{ strong: <strong style={{ color: 'var(--text-dark)' }} /> }}
                          />
                        </span>
                        {study.repeat_enabled ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <CalendarClock size={12} /> {t('studies.scheduled')}
                          </span>
                        ) : null}
                      </div>

                      <div className="cs-card-foot">
                        <span>
                          {study.last_scraped_at
                            ? t('studies.lastScraped', { time: relativeTime(study.last_scraped_at) })
                            : t('studies.neverScraped')}
                        </span>
                        <span className="cs-card-foot-open">{t('common:actions.open')} <ChevronRight size={13} className="icon-flip-rtl" /></span>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )
          ) : (
            <div className="cs-empty">
              <div className="cs-empty-icon"><Search size={20} /></div>
              <h3>{t('studies.noMatchesTitle')}</h3>
              <p>{t('studies.noMatchesHint')}</p>
              <button type="button" className="cs-btn" onClick={clearFilters}>
                <X size={15} /> {t('common:actions.clearFilters')}
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="cs-empty">
          <div className="cs-empty-icon"><Radar size={20} /></div>
          <h3>{t('studies.emptyTitle')}</h3>
          <p>{t('studies.emptyHint')}</p>
          <button type="button" className="cs-btn cs-btn-primary" onClick={() => navigate('/competitors/new')}>
            <Sparkles size={15} /> {t('studies.createFirst')}
          </button>
        </div>
      )}
    </div>
  );
}
