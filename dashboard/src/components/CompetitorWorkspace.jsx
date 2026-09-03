/**
 * Competitor workspace — the card grid.
 *
 * Each card answers the same three questions in the same order, so the eye learns
 * the shape once: what they're up to, how it affects us, what to do. Cards are
 * ordered by impact then competitor size, because the point of the screen is to
 * put the thing worth acting on first rather than the most recent thing.
 *
 * Clicking a card opens the full report. The card is a genuine <button> so it is
 * keyboard-reachable, since the whole surface is the click target.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  BarChart3, CalendarClock, Check, ChevronDown, ChevronRight, ChevronUp,
  ExternalLink, Layers, Link2, Pencil, Play, Radar, RefreshCw, Search,
  ShieldCheck, Sparkles, Trash2, Users,
} from 'lucide-react';
import {
  PLATFORM_LABELS, avatarGradient, deleteStudy,
  getStudy, initials, listCompetitors, relativeTime, runCulturalAnalysis,
} from '../competitorApi.js';
import { countryLabel } from '../constants/countries.js';
import { useAuth } from '../auth/useAuth.js';
import ConfirmModal from './ConfirmModal';
import ErrorNotice from './ErrorNotice';
import '../styles/Competitors.css';

// How far back analysis looks for evidence. The backend accepts 1-365 and
// stamps the chosen window on every card as period_start/period_end.
// 30 stays the default: a card answers "what changed", and over a longer
// window a move from six months ago sits beside one from last week with
// nothing to tell them apart. Longer windows are for competitors that are
// simply covered rarely.
// The unfiltered "All sources" list spans every account across every tracked
// and suggested competitor - easily well past a screenful for a study with
// many competitors, so it's paged rather than rendered all at once.
const SOURCES_PAGE_SIZE = 20;

// The distribution chart lists every source type actually present (there can
// be more than a screenful once LinkedIn/Threads/Facebook/Instagram/Reddit/...
// are all in play), so it's paged too - 4 rows at a time.
const DISTRIBUTION_PAGE_SIZE = 4;

// Every row is already text-labeled by type, so the bar itself only needs to
// carry magnitude, not a second identity encoding - one accent hue for every
// bar (part of the app's validated categorical set) rather than inventing a
// colour per platform, which would run out of distinguishable hues well
// before a study accumulates its 8th or 9th source type.
const DISTRIBUTION_BAR_COLOR = '#2a78d6';

function sourceTypeLabel(platform) {
  const key = String(platform || '').toLowerCase();
  if (!key) return 'Unknown';
  return PLATFORM_LABELS[key] || `${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

function StatTile({ icon: Icon, label, value, tone }) {
  return (
    <div className="cs-panel" style={{ padding: '15px 17px', flex: '1 1 150px', marginTop: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--text-light)', fontSize: '0.75rem', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
        <Icon size={13} /> {label}
      </div>
      <div style={{ fontSize: '1.5rem', fontWeight: 680, marginTop: 6, color: tone || 'var(--text-dark)', letterSpacing: '-0.02em' }}>
        {value}
      </div>
    </div>
  );
}

const SOURCE_STATUS_FILTERS = [
  { key: '', label: 'All statuses' },
  { key: 'valid', label: 'Valid' },
  { key: 'pending', label: 'Pending' },
  { key: 'rejected', label: 'Rejected' },
];

/** Bar-per-source-type distribution, ranked by count (highest first) and
 *  paged 4 at a time - a study with LinkedIn/Threads/Facebook/Instagram/
 *  Reddit/etc. all in play can easily have more distinct types than fit in
 *  one screenful. */
function SourceDistributionChart({ rows, page, totalPages, onPageChange }) {
  const max = Math.max(1, ...rows.map((row) => row.count));
  const paged = rows.slice((page - 1) * DISTRIBUTION_PAGE_SIZE, page * DISTRIBUTION_PAGE_SIZE);

  return (
    <div className="cs-panel" style={{ marginBottom: 20 }}>
      <h2 className="cs-panel-title"><BarChart3 size={16} /> Sources distribution</h2>
      <p className="cs-panel-hint">Every discovered or manually-added source across all competitors, by source type.</p>

      {rows.length ? (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
            {paged.map((row) => (
              <div key={row.platform} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ width: 128, flexShrink: 0, fontSize: '0.8rem', color: 'var(--text-dark)', fontWeight: 560 }}>
                  {row.label}
                </span>
                <div style={{ flex: 1, height: 16, borderRadius: 8, background: '#f1f5f9', overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${(row.count / max) * 100}%`,
                      minWidth: row.count ? 4 : 0,
                      borderRadius: 8,
                      background: DISTRIBUTION_BAR_COLOR,
                      transition: 'width 0.2s ease',
                    }}
                  />
                </div>
                <span style={{ width: 28, flexShrink: 0, textAlign: 'right', fontSize: '0.82rem', fontWeight: 650, color: 'var(--text-dark)' }}>
                  {row.count}
                </span>
              </div>
            ))}
          </div>

          <div className="cs-pagination" style={{ marginTop: 14 }}>
            <div className="cs-pagination-info">
              {rows.length} source type{rows.length === 1 ? '' : 's'}
            </div>
            <div className="cs-pagination-controls">
              <button
                type="button"
                className="cs-btn cs-btn-sm"
                onClick={() => onPageChange(Math.max(1, page - 1))}
                disabled={page <= 1}
              >
                Previous
              </button>
              <span className="cs-pill cs-pill-signal">Page {page} of {totalPages}</span>
              <button
                type="button"
                className="cs-btn cs-btn-sm"
                onClick={() => onPageChange(Math.min(totalPages, page + 1))}
                disabled={page >= totalPages}
              >
                Next
              </button>
            </div>
          </div>
        </>
      ) : (
        <p className="cs-panel-hint" style={{ marginTop: 12, marginBottom: 0 }}>
          No sources yet.
        </p>
      )}
    </div>
  );
}

/** All sources (competitor accounts) across the study in one place - the
 *  per-competitor "Sources" drawer shows the same data scoped to one company;
 *  this is the aggregate view across the whole study. */
function SourcesPanel({
  sources, filteredTotal, total, distributionRows, distributionPage, distributionTotalPages,
  onDistributionPageChange, search, onSearch, typeFilter, onTypeFilter, typeOptions,
  competitorFilter, onCompetitorFilter, competitorOptions,
  statusFilter, onStatusFilter, onChooseCompetitors, page, totalPages, onPageChange,
}) {
  return (
    <>
      <SourceDistributionChart
        rows={distributionRows}
        page={distributionPage}
        totalPages={distributionTotalPages}
        onPageChange={onDistributionPageChange}
      />

      <div className="cs-panel">
        <h2 className="cs-panel-title"><Link2 size={16} /> All sources</h2>
        <p className="cs-panel-hint">
          {total} source{total === 1 ? '' : 's'} across every tracked and suggested competitor.
        </p>

        {total ? (
          <>
            <div className="cs-panel cs-findings-toolbar" style={{ marginTop: 14 }}>
              <label className="cs-search-field">
                <Search size={16} />
                <input
                  type="text"
                  value={search}
                  onChange={(event) => onSearch(event.target.value)}
                  placeholder="Search competitor, handle, or URL..."
                />
              </label>

              <select className="cs-select" value={competitorFilter} onChange={(event) => onCompetitorFilter(event.target.value)}
                aria-label="Filter by competitor">
                <option value="">All competitors</option>
                {competitorOptions.map((competitor) => (
                  <option key={competitor.id} value={competitor.id}>{competitor.name}</option>
                ))}
              </select>

              <select className="cs-select" value={typeFilter} onChange={(event) => onTypeFilter(event.target.value)}
                aria-label="Filter by source type">
                <option value="">All source types</option>
                {typeOptions.map((option) => (
                  <option key={option.platform} value={option.platform}>{option.label}</option>
                ))}
              </select>

              <select className="cs-select" value={statusFilter} onChange={(event) => onStatusFilter(event.target.value)}
                aria-label="Filter by validation status">
                {SOURCE_STATUS_FILTERS.map((option) => (
                  <option key={option.key} value={option.key}>{option.label}</option>
                ))}
              </select>
            </div>

            {filteredTotal ? (
              <div className="cs-rows" style={{ marginTop: 4 }}>
                {sources.map((source) => (
                  <div key={source.id} className="cs-row">
                    <div
                      className="cs-avatar"
                      style={{ background: avatarGradient(source.competitor_name), width: 28, height: 28, fontSize: '0.68rem' }}
                      aria-hidden="true"
                    >
                      {initials(source.competitor_name)}
                    </div>
                    <div className="cs-row-main">
                      <div className="cs-row-name">
                        {source.competitor_name}
                        <span style={{ fontWeight: 400, color: 'var(--text-light)' }}>
                          {' '}· {sourceTypeLabel(source.platform)}
                          {source.handle ? ` @${source.handle}` : ''}
                        </span>
                      </div>
                      <div className="cs-row-desc">
                        <a href={source.url} target="_blank" rel="noopener noreferrer"
                          style={{ color: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          {source.url} <ExternalLink size={11} />
                        </a>
                      </div>
                    </div>
                    <div className="cs-row-side">
                      {typeof source.confidence === 'number' ? (
                        <span className="cs-pill cs-pill-signal">{Math.round(source.confidence * 100)}% confidence</span>
                      ) : null}
                      <span className={`cs-pill cs-pill-${source.validation_status}`}>{source.validation_status}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="cs-empty">
                <div className="cs-empty-icon"><Search size={20} /></div>
                <h3>No matching sources</h3>
                <p>Try a different search term or clear the filters.</p>
              </div>
            )}

            {filteredTotal ? (
              <div className="cs-pagination">
                <div className="cs-pagination-info">
                  Showing {(page - 1) * SOURCES_PAGE_SIZE + 1}-{Math.min(page * SOURCES_PAGE_SIZE, filteredTotal)} of {filteredTotal}
                </div>
                <div className="cs-pagination-controls">
                  <button
                    type="button"
                    className="cs-btn cs-btn-sm"
                    onClick={() => onPageChange(Math.max(1, page - 1))}
                    disabled={page <= 1}
                  >
                    Previous
                  </button>
                  <span className="cs-pill cs-pill-signal">Page {page} of {totalPages}</span>
                  <button
                    type="button"
                    className="cs-btn cs-btn-sm"
                    onClick={() => onPageChange(Math.min(totalPages, page + 1))}
                    disabled={page >= totalPages}
                  >
                    Next
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <div className="cs-empty">
            <div className="cs-empty-icon"><Link2 size={20} /></div>
            <h3>No sources yet</h3>
            <p>Track a competitor and confirm or discover its channels to see them here.</p>
            <button type="button" className="cs-btn cs-btn-primary" onClick={onChooseCompetitors}>
              <Layers size={15} /> Choose competitors
            </button>
          </div>
        )}
      </div>
    </>
  );
}

/** How well the business fits the culture(s) it's targeting — generated once
 *  from the wizard's "Cultural analysis" step (skippable there), and
 *  re-runnable from here. Only rendered when the profile actually has target
 *  countries; a study with none never has anything region-specific to show.
 *  The generated result is collapsible - it's the longest single block of text
 *  on the page, so it starts collapsed and only expands on request, or
 *  automatically right after a fresh run completes so the new result is
 *  immediately visible instead of hidden behind a click. */
function CulturalAnalysisPanel({ analysis, targetCountries, onRun, running }) {
  const hasResult = analysis && analysis.status === 'success';
  const [collapsed, setCollapsed] = useState(true);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) setCollapsed(false);
    wasRunning.current = running;
  }, [running]);

  return (
    <div className="cs-panel" style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 className="cs-panel-title" style={{ marginBottom: 4 }}>
            <Users size={16} /> Cultural fit
          </h2>
          <p className="cs-panel-hint" style={{ marginBottom: 0 }}>
            Targeting {targetCountries.map(countryLabel).join(', ')}.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {!running && hasResult ? (
            <button
              type="button"
              className="cs-btn"
              onClick={() => setCollapsed((value) => !value)}
              aria-expanded={!collapsed}
            >
              {collapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
              {collapsed ? 'Show details' : 'Hide details'}
            </button>
          ) : null}
          <button type="button" className="cs-btn" onClick={onRun} disabled={running}>
            {running ? <span className="cs-spinner" /> : <Sparkles size={15} />}
            {running ? 'Analyzing...' : hasResult ? 'Re-run analysis' : 'Run analysis'}
          </button>
        </div>
      </div>

      {!running && hasResult && !collapsed ? (
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="cs-field" style={{ marginBottom: 0 }}>
            <label className="cs-label">Summary</label>
            <p style={{ margin: 0, fontSize: '0.88rem', lineHeight: 1.55 }}>{analysis.summary}</p>
          </div>
          {[
            ['Success factors', analysis.success_factors],
            ['Benefits', analysis.benefits],
            ['Challenges', analysis.challenges],
            ['Other insights', analysis.insights],
          ].map(([label, items]) => (
            Array.isArray(items) && items.length ? (
              <div key={label} className="cs-field" style={{ marginBottom: 0 }}>
                <label className="cs-label">{label}</label>
                <ul style={{ margin: 0, paddingLeft: 20, fontSize: '0.86rem', lineHeight: 1.6 }}>
                  {items.map((item, index) => <li key={index}>{item}</li>)}
                </ul>
              </div>
            ) : null
          ))}
        </div>
      ) : null}

      {!running && analysis && analysis.status !== 'success' ? (
        <ErrorNotice error={analysis.error || 'The analysis could not be generated.'} context="generate this analysis" compact />
      ) : null}

      {!running && !analysis ? (
        <p className="cs-panel-hint" style={{ marginTop: 12, marginBottom: 0 }}>
          Not yet analyzed — run it here, or from the study wizard.
        </p>
      ) : null}
    </div>
  );
}

export default function CompetitorWorkspace() {
  const { studyId } = useParams();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('competitors.manage');
  const canRunScrape = hasPermission('pipeline.run');

  const [study, setStudy] = useState(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [profile, setProfile] = useState(null);
  const [competitors, setCompetitors] = useState([]);
  const [culturalAnalysis, setCulturalAnalysis] = useState(null);
  const [runningCultural, setRunningCultural] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [triggeringScrape, setTriggeringScrape] = useState(false);
  const [scrapeNotice, setScrapeNotice] = useState(null);
  const [sourceSearch, setSourceSearch] = useState('');
  const [sourceTypeFilter, setSourceTypeFilter] = useState('');
  const [sourceCompetitorFilter, setSourceCompetitorFilter] = useState('');
  const [sourceStatusFilter, setSourceStatusFilter] = useState('');
  const [sourcePage, setSourcePage] = useState(1);
  const [distributionPage, setDistributionPage] = useState(1);

  // Fetch inside the effect with a cancel guard, so switching studies mid-request
  // cannot resolve into the newly-selected study's state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const [detail, competitorList] = await Promise.all([
          getStudy(studyId),
          listCompetitors(studyId),
        ]);
        if (cancelled) return;
        setStudy(detail.study);
        setProfile(detail.profile);
        setCulturalAnalysis(detail.cultural_analysis || null);
        setCompetitors(competitorList.competitors || []);
      } catch (caught) {
        if (!cancelled) setError(caught.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [studyId]);

  const handleDeleteStudy = async () => {
    setDeleting(true);
    try {
      await deleteStudy(studyId);
      navigate('/competitors');
    } catch (caught) {
      setError(caught.message);
      setDeleting(false);
      setDeleteOpen(false);
    }
  };

  // Triggers this study's scrape the same way the Workflow page does for a
  // regular project (POST /scrape with { project_id }) - a competitor study
  // *is* a project (mode='competitor'), so it's the same pipeline. The
  // backend returns 200 (not an error) if a run is already active for this
  // project, so that's surfaced as an info notice rather than a failure.
  const runScrapeNow = async () => {
    setError('');
    setScrapeNotice(null);
    setTriggeringScrape(true);
    try {
      const response = await fetch('/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: studyId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.detail || data?.error || `Scrape request failed (${response.status})`);
      }
      setScrapeNotice({
        runId: data?.run_id ? String(data.run_id) : null,
        alreadyActive: /already active/i.test(data?.message || ''),
      });
    } catch (caught) {
      setError(caught.message);
    } finally {
      setTriggeringScrape(false);
    }
  };

  const rerunCultural = async () => {
    setError('');
    setRunningCultural(true);
    try {
      const result = await runCulturalAnalysis(studyId);
      setCulturalAnalysis(result.cultural_analysis);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setRunningCultural(false);
    }
  };

  const stats = useMemo(() => {
    const tracked = competitors.filter((item) => item.status === 'tracked');
    const pendingChannels = competitors.reduce((sum, item) => sum + (item.pending_account_count || 0), 0);
    return { tracked: tracked.length, pendingChannels };
  }, [competitors]);

  // Every competitor already carries its full `accounts` list from
  // listCompetitors() (see loadAll below) - no extra request needed to see
  // every source across the study at once.
  const allSources = useMemo(
    () => competitors.flatMap((competitor) => (competitor.accounts || []).map((account) => ({
      ...account,
      competitor_id: competitor.id,
      competitor_name: competitor.name,
    }))),
    [competitors],
  );

  // Ranked by count, highest first - the chart and the "filter by source
  // type" dropdown share this list so a type only ever shows up as a filter
  // option once it actually has a source.
  const sourceTypeCounts = useMemo(() => {
    const counts = new Map();
    for (const source of allSources) {
      const key = String(source.platform || '').toLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([platform, count]) => ({ platform, label: sourceTypeLabel(platform), count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [allSources]);

  const competitorOptions = useMemo(
    () => competitors
      .map((competitor) => ({ id: String(competitor.id), name: competitor.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [competitors],
  );

  const sourceStats = useMemo(() => ({
    total: allSources.length,
    valid: allSources.filter((source) => source.validation_status === 'valid').length,
    pending: allSources.filter((source) => source.validation_status === 'pending').length,
    rejected: allSources.filter((source) => source.validation_status === 'rejected').length,
  }), [allSources]);

  const filteredSources = useMemo(() => {
    const query = sourceSearch.trim().toLowerCase();
    return allSources.filter((source) => {
      if (sourceTypeFilter && String(source.platform || '').toLowerCase() !== sourceTypeFilter) return false;
      if (sourceCompetitorFilter && String(source.competitor_id) !== sourceCompetitorFilter) return false;
      if (sourceStatusFilter && source.validation_status !== sourceStatusFilter) return false;
      if (query) {
        const haystack = `${source.competitor_name} ${source.handle || ''} ${source.url || ''}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }, [allSources, sourceTypeFilter, sourceCompetitorFilter, sourceStatusFilter, sourceSearch]);

  // A new search/filter should land back on page 1, not wherever the user was
  // scrolled to on the old result set - adjusted during render (React's
  // documented pattern for this) rather than an effect, so it takes effect in
  // the same render as the filter change instead of one tick later.
  const sourceFilterKey = `${sourceSearch}|${sourceTypeFilter}|${sourceCompetitorFilter}|${sourceStatusFilter}`;
  const [prevSourceFilterKey, setPrevSourceFilterKey] = useState(sourceFilterKey);
  if (sourceFilterKey !== prevSourceFilterKey) {
    setPrevSourceFilterKey(sourceFilterKey);
    setSourcePage(1);
  }

  const sourceTotalPages = Math.max(1, Math.ceil(filteredSources.length / SOURCES_PAGE_SIZE));
  const sourceSafePage = Math.min(sourcePage, sourceTotalPages);
  const distributionTotalPages = Math.max(1, Math.ceil(sourceTypeCounts.length / DISTRIBUTION_PAGE_SIZE));
  const distributionSafePage = Math.min(distributionPage, distributionTotalPages);
  const pagedSources = useMemo(
    () => filteredSources.slice((sourceSafePage - 1) * SOURCES_PAGE_SIZE, sourceSafePage * SOURCES_PAGE_SIZE),
    [filteredSources, sourceSafePage],
  );

  if (loading) {
    return (
      <div className="cs-page">
        <div className="cs-skeleton" style={{ height: 34, width: 280, marginBottom: 12 }} />
        <div className="cs-skeleton" style={{ height: 18, width: 460, marginBottom: 28 }} />
        <div className="cs-card-grid">
          {[0, 1, 2].map((key) => (
            <div key={key} className="cs-skeleton" style={{ height: 300 }} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="cs-page">
      <div className="cs-head">
        <div>
          <Link to="/competitors" className="cs-link-back">
            <ChevronRight size={14} style={{ transform: 'rotate(180deg)' }} /> All studies
          </Link>
          <h1>{study?.name || 'Competitor study'}</h1>
          <p>
            {profile?.name ? (
              <>
                Tracked against <strong>{profile.name}</strong>
                {profile.market ? ` in ${profile.market}` : ''}. Confirm each competitor's channels
                and they are collected on every run of this study.
              </>
            ) : (
              'Add your business profile so competitor discovery has something to compare against.'
            )}
          </p>
        </div>
        <div className="cs-head-actions">
          {canRunScrape && (
            <button type="button" className="cs-btn cs-btn-primary" onClick={runScrapeNow} disabled={triggeringScrape}>
              {triggeringScrape ? <span className="cs-spinner" /> : <Play size={15} />}
              {triggeringScrape ? 'Starting...' : 'Run scrape'}
            </button>
          )}
          <Link to={`/competitors/${studyId}/competitors`} className="cs-btn">
            <Layers size={15} /> {competitors.length} competitor{competitors.length === 1 ? '' : 's'}
          </Link>
          {canManage && (
            <>
              <Link to={`/competitors/${studyId}/edit`} className="cs-btn">
                <Pencil size={15} /> Edit
              </Link>
              <button
                type="button"
                className="cs-btn"
                onClick={() => setDeleteOpen(true)}
                style={{ color: '#ff4757' }}
              >
                <Trash2 size={15} /> Delete study
              </button>
            </>
          )}
        </div>
      </div>

      <ErrorNotice error={error} context="load or update this competitor study" onDismiss={() => setError('')} />

      {scrapeNotice ? (
        <div className="cs-alert cs-alert-info">
          <Check size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            {scrapeNotice.alreadyActive ? 'A scrape is already running for this study.' : 'Scrape started.'}
            {scrapeNotice.runId ? (
              <>
                {' '}
                <Link to={`/pipeline-runs/${scrapeNotice.runId}`} style={{ fontWeight: 700 }}>
                  View progress
                </Link>
              </>
            ) : null}
          </span>
        </div>
      ) : null}

      {stats.pendingChannels > 0 ? (
        <div className="cs-alert cs-alert-warn">
          <ShieldCheck size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            {stats.pendingChannels} channel{stats.pendingChannels === 1 ? '' : 's'} still awaiting
            confirmation. Unconfirmed channels are not scraped, so nothing from them is
            collected.{' '}
            <Link to={`/competitors/${studyId}/competitors`} style={{ fontWeight: 700 }}>
              Review them
            </Link>
          </span>
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 20 }}>
        <StatTile icon={Radar} label="Tracked" value={stats.tracked} />
        <StatTile icon={Link2} label="Total sources" value={sourceStats.total} />
        <StatTile icon={ShieldCheck} label="Valid" value={sourceStats.valid} />
        <StatTile icon={RefreshCw} label="Pending" value={sourceStats.pending}
          tone={sourceStats.pending ? '#a16207' : undefined} />
        <StatTile icon={CalendarClock} label="Last Scrape"
          value={study?.last_run_at ? relativeTime(study.last_run_at) : 'Never'} />
      </div>

      {Array.isArray(profile?.target_countries) && profile.target_countries.length ? (
        <CulturalAnalysisPanel
          analysis={culturalAnalysis}
          targetCountries={profile.target_countries}
          onRun={rerunCultural}
          running={runningCultural}
        />
      ) : null}

      <SourcesPanel
        sources={pagedSources}
        filteredTotal={filteredSources.length}
        total={allSources.length}
        distributionRows={sourceTypeCounts}
        distributionPage={distributionSafePage}
        distributionTotalPages={distributionTotalPages}
        onDistributionPageChange={setDistributionPage}
        search={sourceSearch}
        onSearch={setSourceSearch}
        typeFilter={sourceTypeFilter}
        onTypeFilter={setSourceTypeFilter}
        typeOptions={sourceTypeCounts}
        competitorFilter={sourceCompetitorFilter}
        onCompetitorFilter={setSourceCompetitorFilter}
        competitorOptions={competitorOptions}
        statusFilter={sourceStatusFilter}
        onStatusFilter={setSourceStatusFilter}
        onChooseCompetitors={() => navigate(`/competitors/${studyId}/competitors`)}
        page={sourceSafePage}
        totalPages={sourceTotalPages}
        onPageChange={setSourcePage}
      />

      <ConfirmModal
        open={deleteOpen}
        title={`Delete study "${study?.name || ''}"?`}
        message="This will permanently remove the study, its business profile, tracked competitors, and findings."
        confirmLabel={deleting ? 'Deleting...' : 'Delete study'}
        cancelLabel="Keep study"
        confirmButtonStyle={{
          background: 'linear-gradient(135deg, #ff4757, #e03131)',
          boxShadow: '0 4px 15px rgba(255, 71, 87, 0.28)',
        }}
        onClose={() => setDeleteOpen(false)}
        onConfirm={handleDeleteStudy}
      />
    </div>
  );
}
