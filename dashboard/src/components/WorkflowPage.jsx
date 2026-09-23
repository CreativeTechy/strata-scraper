import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '../auth/useAuth.js';
import {
  Globe,
  AtSign,
  Share2,
  Plus,
  ArrowRight,
  DownloadCloud,
  Sparkles,
  Database,
  CheckCircle2,
  RefreshCw,
  Clock3,
  Flag,
  ShieldCheck,
  Layers3,
  BadgeCheck,
  FileText,
  TrendingUp,
  ChevronDown,
  ChevronUp,
  Square,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '../styles/Workflow.css';
import ErrorNotice from './ErrorNotice';
import { friendlyRunMessage } from '../errors/userFacingError.js';
import { apiError } from '../errors/apiError.js';
import { formatDateTime, formatNumber, isRtl } from '../i18n/format.js';
import i18n from '../i18n/index.js';

const SourceTypeIcon = ({ sourceType }) => {
  if (sourceType === 'x' || sourceType === 'username' || sourceType === 'hashtag' || sourceType === 'tweet') return <AtSign size={16} />;
  if (sourceType === 'facebook') return <Share2 size={16} />;
  return <Globe size={16} />;
};

// Stage/status codes come from the backend (pipeline_runs.stage/status) and
// stay as-is for comparisons; only their display label is translated.
function prettyStage(stage) {
  const code = stage || 'queued';
  return i18n.t(`pipeline:stages.${code}`, { defaultValue: code });
}

function statusLabel(status) {
  if (!status) return i18n.t('common:status.queued');
  return i18n.t(`common:status.${status}`, { defaultValue: status });
}

const CLEANUP_STEP_KEYS = ['parsing', 'validatingJson', 'extractingInsights'];

function statusTone(status) {
  if (status === 'success') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'running') return 'warning';
  return 'muted';
}

export default function WorkflowPage({
  articles = [],
  isScraping = false,
  onRunScraper,
  sources = [],
  projects = [],
  selectedProjects = [],
  selectedProjectIds = [],
  onChangeSelectedProjectIds = () => {},
  activeRun = null,
  onStopRun = () => {},
}) {
  const { t } = useTranslation('pipeline');
  const { hasPermission } = useAuth();
  const canRunScraper = hasPermission('pipeline.run');
  const canStopScraper = hasPermission('pipeline.stop');

  const sourceIds = useMemo(
    () => sources.map((source) => Number(source.id)).filter((id) => Number.isFinite(id)),
    [sources]
  );
  // Keyed on the *set* of ids (not the sources array reference) so switching
  // back to a project doesn't wipe an in-progress selection on every render -
  // only when the actual sources available to check change does the
  // selection reset to "all checked" (the required default).
  const sourceIdsKey = useMemo(() => [...sourceIds].sort((a, b) => a - b).join(','), [sourceIds]);
  const [checkedSourceIds, setCheckedSourceIds] = useState(() => new Set(sourceIds));

  useEffect(() => {
    setCheckedSourceIds(new Set(sourceIds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceIdsKey]);

  const toggleSourceChecked = (id) => {
    const numId = Number(id);
    setCheckedSourceIds((current) => {
      const next = new Set(current);
      if (next.has(numId)) next.delete(numId);
      else next.add(numId);
      return next;
    });
  };

  const allSourcesChecked = sources.length > 0 && checkedSourceIds.size === sources.length;
  const selectAllSources = () => setCheckedSourceIds(new Set(sourceIds));
  const deselectAllSources = () => setCheckedSourceIds(new Set());

  const [runs, setRuns] = useState([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState('');
  const [workflowStartedAt, setWorkflowStartedAt] = useState(null);
  const [workflowElapsed, setWorkflowElapsed] = useState(0);
  const [isSourceListCollapsed, setIsSourceListCollapsed] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const wasScrapingRef = useRef(false);

  const handleStopRun = async () => {
    if (!activeRun?.id) return;
    setIsStopping(true);
    try {
      await onStopRun(activeRun.id);
    } catch (error) {
      console.error('Failed to stop pipeline run:', error);
    } finally {
      setIsStopping(false);
    }
  };

  useEffect(() => {
    if (isScraping && !wasScrapingRef.current) {
      setWorkflowStartedAt(Date.now());
      setWorkflowElapsed(0);
    }

    if (!isScraping && wasScrapingRef.current && workflowStartedAt) {
      setWorkflowElapsed((Date.now() - workflowStartedAt) / 1000);
    }

    wasScrapingRef.current = isScraping;
  }, [isScraping, workflowStartedAt]);

  useEffect(() => {
    if (!isScraping || !workflowStartedAt) return undefined;

    const timer = setInterval(() => {
      setWorkflowElapsed((Date.now() - workflowStartedAt) / 1000);
    }, 200);

    return () => clearInterval(timer);
  }, [isScraping, workflowStartedAt]);

  useEffect(() => {
    let alive = true;
    const loadRuns = async () => {
      setRunsLoading(true);
      setRunsError('');
      try {
        const res = await fetch('/api/pipeline-runs?limit=6');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw apiError(data, { status: res.status, fallback: i18n.t('pipeline:errors.loadRunsFailed') });
        if (alive) setRuns(Array.isArray(data?.runs) ? data.runs : []);
      } catch (error) {
        if (alive) {
          setRuns([]);
          setRunsError(error?.message ? error : i18n.t('pipeline:errors.loadRunsFailed'));
        }
      } finally {
        if (alive) setRunsLoading(false);
      }
    };
    loadRuns();
    const interval = isScraping ? setInterval(loadRuns, 3000) : null;
    return () => {
      alive = false;
      if (interval) clearInterval(interval);
    };
  }, [isScraping]);

  const hasData = articles.length > 0;
  const workflowState = isScraping ? 'cleaning' : (hasData ? 'ready' : 'idle');
  const selectedProjectCount = selectedProjectIds.length;
  const projectLabel = useMemo(() => {
    if (selectedProjects.length === 0) return projects.length ? t('stopwatch.scopeSelect') : t('stopwatch.scopeNone');
    return selectedProjects[0].name || t('stopwatch.scopeOne');
  }, [projects.length, selectedProjects, t]);

  const stats = useMemo(() => {
    const total = articles.length;
    const sources = new Set(articles.map((a) => a.source).filter(Boolean)).size;
    const grouped = new Set(articles.map((a) => a.story_id).filter(Boolean)).size;
    const topSources = Object.entries(
      articles.reduce((acc, a) => {
        if (!a.source) return acc;
        acc[a.source] = (acc[a.source] || 0) + 1;
        return acc;
      }, {})
    )
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([source, count]) => ({ source, count }));

    return { total, sources, grouped, topSources };
  }, [articles]);

  const latestArticles = useMemo(
    () => [...articles].filter((a) => a?.title || a?.source).slice(0, 5),
    [articles]
  );

  const currentRun = runs[0] || null;
  const completedRuns = runs.slice(1);
  const pipelineStats = useMemo(() => ({
    pages: Number(currentRun?.crawl_pages) || 0,
    scraped: Number(currentRun?.articles_scraped) || 0,
    cleaned: Number(currentRun?.articles_cleaned) || 0,
    saved: Number(currentRun?.articles_saved) || 0,
  }), [currentRun]);

  const formatWhen = (value) => {
    if (!value) return t('common:time.justNow');
    return formatDateTime(value, undefined, String(value));
  };

  const formatElapsed = (seconds) => {
    const total = Math.max(0, Math.floor(seconds || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return [
      hours ? String(hours).padStart(2, '0') : null,
      String(minutes).padStart(2, '0'),
      String(secs).padStart(2, '0'),
    ].filter(Boolean).join(':');
  };

  const cleanupProgressLabel = useMemo(() => {
    const scraped = Math.max(0, Number(currentRun?.articles_scraped) || 0);
    const cleaned = Math.max(0, Number(currentRun?.articles_cleaned) || 0);
    const saved = Math.max(0, Number(currentRun?.articles_saved) || 0);
    if (!currentRun) return '';
    // currentRun.message is English free text from the backend, so the
    // fallbacks go through friendlyRunMessage (translated) instead.
    if ((currentRun.status || '').toLowerCase() !== 'running') {
      if ((currentRun.stage || '').toLowerCase() === 'done') {
        return scraped > 0
          ? t('cleanup.kept', { count: scraped, kept: formatNumber(Math.min(cleaned || scraped, scraped)), total: formatNumber(scraped) })
          : t('cleanup.complete');
      }
      return currentRun.message ? friendlyRunMessage(currentRun) : '';
    }
    if ((currentRun.stage || '').toLowerCase() === 'clean') {
      if (scraped > 0) {
        return t('cleanup.validatingProgress', { done: formatNumber(Math.min(Math.max(cleaned, 0), scraped)), total: formatNumber(scraped) });
      }
      return t('cleanup.validating');
    }
    if ((currentRun.stage || '').toLowerCase() === 'scrape') {
      if (scraped <= 0) return t('cleanup.scraping');
      const pages = Math.max(1, currentRun.crawl_pages || 0);
      return t('cleanup.scrapingProgress', {
        pages: t('cleanup.pages', { count: pages, formatted: formatNumber(pages) }),
        articles: t('cleanup.articles', { count: scraped, formatted: formatNumber(scraped) }),
      });
    }
    if ((currentRun.stage || '').toLowerCase() === 'done') {
      return saved > 0 ? t('cleanup.saved', { count: saved, formatted: formatNumber(saved) }) : t('cleanup.complete');
    }
    return currentRun.message ? friendlyRunMessage(currentRun) : '';
  }, [currentRun, t]);

  const selectProject = (projectId) => {
    const id = Number(projectId);
    if (!Number.isFinite(id)) return;
    onChangeSelectedProjectIds([id]);
  };

  const runLabel = selectedProjectCount === 0
    ? t('getData.runSelectProject')
    : checkedSourceIds.size === 0
      ? t('getData.runSelectSource')
      : t('getData.run');
  const slideFrom = isRtl() ? 20 : -20;

  return (
    <div className="workflow-layout">
      <div className="bg-pattern"></div>

      <div className="workflow-shell">
        <motion.div
          className="workflow-panel glass-card"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          style={{ marginBottom: '18px' }}
        >
          <div className="panel-header" style={{ marginBottom: 0 }}>
            <div>
              <div className="panel-kicker"><Clock3 size={14} /> {t('stopwatch.kicker')}</div>
              <h2>{t('stopwatch.title')}</h2>
              <div style={{ color: 'var(--text-light)', fontSize: '0.85rem', marginTop: 6 }}>
                {t('stopwatch.scope', { scope: projectLabel })}
              </div>
            </div>
            <span className={`panel-pill ${isScraping ? 'warning' : workflowStartedAt ? 'success' : 'neutral'}`}>
              {isScraping ? t('common:status.running') : workflowStartedAt ? t('pills.stopped') : t('pills.idle')}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px', flexWrap: 'wrap' }}>
            <div dir="ltr" style={{ fontSize: '2.4rem', fontWeight: 800, letterSpacing: '-0.04em', color: 'var(--text-dark)' }}>
              {workflowStartedAt ? formatElapsed(workflowElapsed) : '00:00'}
            </div>
            <div style={{ color: 'var(--text-light)', fontSize: '0.9rem' }}>
              {isScraping
                ? t('stopwatch.counting')
                : workflowStartedAt
                  ? t('stopwatch.lastStarted', { time: formatWhen(workflowStartedAt) })
                  : t('stopwatch.notStarted')}
            </div>
          </div>
        </motion.div>

        <div className="workflow-main-grid">
          <div className="miro-board">
            <motion.div
              className="workflow-block"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <div className="miro-badge top-right">
                <Sparkles size={14} /> {t('getData.badge')}
              </div>

              <div className="block-header">
                <div className="block-icon get">
                  <DownloadCloud size={20} />
                </div>
                <div className="block-title">{t('getData.title')}</div>
              </div>

              <div className="workflow-project-picker">
                <div className="workflow-project-picker-header">
                  <div>
                    <div className="workflow-project-picker-kicker">{t('picker.kicker')}</div>
                    <strong>{t('picker.title')}</strong>
                  </div>
                  <div className="workflow-project-picker-summary">
                    <span className="panel-chip muted">
                      {t('picker.total', { count: projects.length, formatted: formatNumber(projects.length) })}
                    </span>
                  </div>
                </div>

                <div className="workflow-project-picker-note">{t('picker.note')}</div>

                {projects.length === 0 ? (
                  <div className="panel-empty" style={{ marginTop: 8 }}>
                    <ShieldCheck size={16} />
                    <span>{t('picker.empty')}</span>
                  </div>
                ) : (
                  <div className="workflow-project-list">
                    {projects.map((project) => {
                      const isSelected = selectedProjectIds.includes(Number(project.id));
                      return (
                        <label key={project.id} className={`workflow-project-item ${isSelected ? 'selected' : ''}`}>
                          <input
                            type="radio"
                            name="workflow-project"
                            checked={isSelected}
                            onChange={() => selectProject(project.id)}
                            disabled={isScraping}
                          />
                          <div className="workflow-project-copy">
                            <div className="workflow-project-topline">
                              <strong dir="auto">{project.name}</strong>
                              <span className={`panel-chip ${isSelected ? 'success' : 'muted'}`}>
                                {isSelected ? t('picker.selected') : t('picker.unselected')}
                              </span>
                            </div>
                            <div className="workflow-project-meta">
                              <span>{t(`common:status.${project.status || 'draft'}`, { defaultValue: project.status || 'draft' })}</span>
                              {project.location ? <span dir="auto">{project.location}</span> : null}
                              <span>
                                {t('picker.sourceCount', {
                                  count: (project.source_ids || []).length,
                                  formatted: formatNumber((project.source_ids || []).length),
                                })}
                              </span>
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="get-rows-header">
                <div className="get-rows-header-copy">
                  <strong>{t('sources.title')}</strong>
                  <span>
                    {sources.length
                      ? t('sources.selectedSummary', { checked: formatNumber(checkedSourceIds.size), total: formatNumber(sources.length) })
                      : t('sources.noneAssigned')}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    className="workflow-project-toggle"
                    onClick={allSourcesChecked ? deselectAllSources : selectAllSources}
                    disabled={isScraping || sources.length === 0}
                  >
                    {allSourcesChecked ? t('sources.deselectAll') : t('common:actions.selectAll')}
                  </button>
                  <button
                    type="button"
                    className="workflow-project-toggle"
                    onClick={() => setIsSourceListCollapsed((current) => !current)}
                    aria-expanded={!isSourceListCollapsed}
                    aria-controls="workflow-source-list"
                  >
                    {isSourceListCollapsed ? (
                      <>
                        {t('sources.expand')} <ChevronDown size={14} />
                      </>
                    ) : (
                      <>
                        {t('sources.collapse')} <ChevronUp size={14} />
                      </>
                    )}
                  </button>
                </div>
              </div>

              <AnimatePresence initial={false}>
                {!isSourceListCollapsed ? (
                  <motion.div
                    key="workflow-source-list"
                    id="workflow-source-list"
                    className="workflow-source-list"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    {sources.length === 0 ? (
                      <div className="panel-empty" style={{ marginTop: 0 }}>
                        <ShieldCheck size={16} />
                        <span>{t('sources.emptyList')}</span>
                      </div>
                    ) : (
                      sources.map((source) => {
                        const id = Number(source.id);
                        const isChecked = checkedSourceIds.has(id);
                        return (
                          <label key={id} className={`workflow-source-item ${isChecked ? 'selected' : ''}`}>
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => toggleSourceChecked(id)}
                              disabled={isScraping}
                            />
                            <div className="workflow-source-icon">
                              <SourceTypeIcon sourceType={source.source_type} />
                            </div>
                            <div className="workflow-source-copy">
                              {source.name
                                ? <strong dir="auto">{source.name}</strong>
                                : <strong className="ltr-isolate">{source.url}</strong>}
                              {source.name ? <span className="ltr-isolate">{source.url}</span> : null}
                            </div>
                          </label>
                        );
                      })
                    )}
                  </motion.div>
                ) : (
                  <motion.div
                    key="workflow-source-list-collapsed"
                    className="workflow-project-list-collapsed"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                  >
                    {sources.length
                      ? t('sources.collapsedSummary', {
                        count: sources.length,
                        checked: formatNumber(checkedSourceIds.size),
                        formatted: formatNumber(sources.length),
                      })
                      : t('sources.collapsedEmpty')}
                  </motion.div>
                )}
              </AnimatePresence>

              <Link
                to="/sources"
                className="add-row-btn"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', textDecoration: 'none' }}
              >
                <Plus size={18} /> {t('sources.add')}
              </Link>

              <div style={{ display: 'flex', gap: '10px', marginTop: '15px' }}>
                <button
                  className="btn-primary"
                  style={{ opacity: isScraping ? 0.7 : 1, flex: 1 }}
                  onClick={() => onRunScraper?.(selectedProjectIds, [...checkedSourceIds])}
                  disabled={isScraping || selectedProjectCount === 0 || checkedSourceIds.size === 0 || !canRunScraper}
                  title={
                    !canRunScraper
                      ? t('getData.requiresPermission', { permission: 'pipeline.run' })
                      : selectedProjectCount > 0 && checkedSourceIds.size === 0
                        ? t('getData.selectSourceHint')
                        : undefined
                  }
                >
                  {isScraping ? (
                    <><RefreshCw size={16} className="spin" /> {t('getData.running')}</>
                  ) : (
                    runLabel
                  )}
                </button>

                {activeRun ? (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={handleStopRun}
                    disabled={isStopping || !canStopScraper}
                    title={canStopScraper ? undefined : t('getData.requiresPermission', { permission: 'pipeline.stop' })}
                  >
                    {isStopping ? (
                      <><RefreshCw size={16} className="spin" /> {t('runs.stopping')}</>
                    ) : (
                      <><Square size={16} /> {t('runs.stop')}</>
                    )}
                  </button>
                ) : null}
              </div>
            </motion.div>

            <div className="workflow-arrow">
              <ArrowRight size={32} className="icon-flip-rtl" />
            </div>

            <motion.div
              className="workflow-block"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
              style={{ opacity: workflowState === 'idle' ? 0.5 : 1 }}
            >
              <div className="miro-badge bottom-left" style={{ color: 'var(--primary-color)' }}>
                <RefreshCw size={14} /> {isScraping ? t('validate.badgeRunning') : t('validate.badgeActive')}
              </div>

              <div className="block-header">
                <div className="block-icon clean">
                  <Sparkles size={20} />
                </div>
                <div className="block-title">{t('validate.title')}</div>
              </div>

              <div className="cleanup-status">
                {cleanupProgressLabel ? (
                  <div className="cleanup-progress">
                    {cleanupProgressLabel}
                  </div>
                ) : null}

                {workflowState === 'idle' && (
                  <div style={{ textAlign: 'center', color: 'var(--text-light)' }}>
                    {t('validate.waiting')}
                  </div>
                )}

                {(workflowState === 'cleaning' || workflowState === 'ready') && (
                  <>
                    {CLEANUP_STEP_KEYS.map((stepKey, i) => (
                      <motion.div
                        key={stepKey}
                        className="status-item"
                        initial={{ opacity: 0, x: slideFrom }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: i * 0.35 }}
                      >
                        <div className="status-spinner">
                          {workflowState === 'cleaning'
                            ? <RefreshCw size={18} className="spin" />
                            : <CheckCircle2 size={18} color="#2ed573" />}
                        </div>
                        <div className="status-text">{t(`validate.steps.${stepKey}`)}</div>
                      </motion.div>
                    ))}
                    {isScraping && (
                      <p style={{ fontSize: '0.72rem', color: 'var(--text-light)', marginTop: '10px', textAlign: 'center' }}>
                        {t('validate.githubNote')}
                      </p>
                    )}
                  </>
                )}
              </div>
            </motion.div>

            <div className="workflow-arrow">
              <ArrowRight size={32} className="icon-flip-rtl" />
            </div>

            <motion.div
              className="workflow-block"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              style={{ opacity: workflowState === 'idle' ? 0.5 : 1 }}
            >
              <div className="block-header">
                <div className="block-icon save">
                  <Database size={20} />
                </div>
                <div className="block-title">{t('save.title')}</div>
              </div>

              <div className="save-summary">
                {!hasData ? (
                  <div style={{ textAlign: 'center', color: 'var(--text-light)' }}>
                    {t('save.waiting')}
                  </div>
                ) : (
                  <>
                    <div className="summary-stat">
                      <span className="summary-label">{t('save.totalRows')}</span>
                      <span className="summary-value">{t('save.rows', { count: stats.total, formatted: formatNumber(stats.total) })}</span>
                    </div>
                    <div className="summary-stat">
                      <span className="summary-label">{t('save.uniqueSources')}</span>
                      <span className="summary-value" style={{ color: 'var(--secondary-color)' }}>
                        {t('save.found', { count: stats.sources, formatted: formatNumber(stats.sources) })}
                      </span>
                    </div>
                    <div className="summary-stat">
                      <span className="summary-label">{t('save.storyGroups')}</span>
                      <span className="summary-value" style={{ color: 'var(--primary-color)' }}>
                        {t('save.grouped', { count: stats.grouped, formatted: formatNumber(stats.grouped) })}
                      </span>
                    </div>

                    <div className="save-btn" style={{ cursor: 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                      <CheckCircle2 size={18} /> {t('save.synced')}
                    </div>
                  </>
                )}
              </div>
            </motion.div>
          </div>
        </div>

        <div className="workflow-bottom-grid">
          <motion.div
            className="workflow-panel glass-card"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
          >
              <div className="panel-header">
                <div>
                  <div className="panel-kicker"><Clock3 size={14} /> {t('log.kicker')}</div>
                  <h2>{t('log.title')}</h2>
                </div>
                <span className={`panel-pill ${statusTone(currentRun?.status)}`}>
                  {currentRun ? statusLabel(currentRun.status) : t('pills.idle')}
                </span>
              </div>

              <ErrorNotice error={runsError} context={t('errorContext.loadActivity')} compact />

              <div className="log-list">
                {runsLoading ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="log-item skeleton">
                      <div className="log-dot"></div>
                      <div className="log-copy">
                        <div className="skeleton-line short"></div>
                        <div className="skeleton-line"></div>
                      </div>
                    </div>
                  ))
                ) : currentRun ? (
                  <>
                    <div className="log-item active">
                      <div className="log-dot"></div>
                      <div className="log-copy">
                        <div className="log-title">{t('log.currentRun')}</div>
                        <div className="log-body">{friendlyRunMessage(currentRun)}</div>
                        <div className="log-meta">
                          <span>{prettyStage(currentRun.stage)}</span>
                          <span>{statusLabel(currentRun.status)}</span>
                          <span>{formatWhen(currentRun.created_at)}</span>
                        </div>
                      </div>
                    </div>

                    {completedRuns.map((run) => (
                      <div key={run.id} className="log-item">
                        <div className={`log-dot ${run.status || ''}`}></div>
                        <div className="log-copy">
                          <div className="log-title">{prettyStage(run.stage)}</div>
                          <div className="log-body">{friendlyRunMessage(run)}</div>
                          <div className="log-meta">
                            <span>{statusLabel(run.status)}</span>
                            <span>{formatWhen(run.finished_at || run.created_at)}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </>
                ) : (
                  <div className="panel-empty">
                    <ShieldCheck size={16} />
                    <span>{t('log.empty')}</span>
                  </div>
                )}
              </div>
          </motion.div>

          <motion.div
            className="workflow-panel glass-card"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
          >
              <div className="panel-header">
                <div>
                  <div className="panel-kicker"><TrendingUp size={14} /> {t('results.kicker')}</div>
                  <h2>{t('results.title')}</h2>
                </div>
                <span className={`panel-pill ${statusTone(currentRun?.status || (isScraping ? 'running' : 'success'))}`}>
                  {currentRun ? statusLabel(currentRun.status) : (isScraping ? t('common:status.running') : t('pills.live'))}
                </span>
              </div>

              <div className="result-grid">
                <div className="result-card">
                  <FileText size={16} />
                  <span className="result-label">{t('results.pagesCrawled')}</span>
                  <strong>{formatNumber(pipelineStats.pages)}</strong>
                </div>
                <div className="result-card">
                  <Layers3 size={16} />
                  <span className="result-label">{t('results.articlesScraped')}</span>
                  <strong>{formatNumber(pipelineStats.scraped)}</strong>
                </div>
                <div className="result-card">
                  <BadgeCheck size={16} />
                  <span className="result-label">{t('results.cleaned')}</span>
                  <strong>{formatNumber(pipelineStats.cleaned)}</strong>
                </div>
                <div className="result-card">
                  <Flag size={16} />
                  <span className="result-label">{t('results.saved')}</span>
                  <strong>{formatNumber(pipelineStats.saved)}</strong>
                </div>
              </div>

              <div className="source-mini-list" style={{ marginTop: '16px' }}>
                <div className="mini-list-title">{t('results.snapshot')}</div>
                <div className="mini-list-row">
                  <span>{t('results.articlesStored')}</span>
                  <strong style={{ color: 'var(--primary-color)' }}>{formatNumber(stats.total)}</strong>
                </div>
                <div className="mini-list-row">
                  <span>{t('save.uniqueSources')}</span>
                  <strong style={{ color: 'var(--secondary-color)' }}>{formatNumber(stats.sources)}</strong>
                </div>
                <div className="mini-list-row">
                  <span>{t('save.storyGroups')}</span>
                  <strong>{formatNumber(stats.grouped)}</strong>
                </div>
              </div>

              <div className="source-mini-list">
                <div className="mini-list-title">{t('results.topSources')}</div>
                {stats.topSources.length ? (
                  stats.topSources.map((item) => (
                    <div key={item.source} className="mini-list-row">
                      <span dir="auto">{item.source}</span>
                      <strong>{formatNumber(item.count)}</strong>
                    </div>
                  ))
                ) : (
                  <div className="mini-empty">{t('results.noSources')}</div>
                )}
              </div>

              <div className="article-preview-list">
                <div className="mini-list-title">{t('results.recentArticles')}</div>
                {latestArticles.length ? (
                  latestArticles.map((article) => (
                    <div key={article.url} className="article-preview-row">
                    <div className="article-preview-top">
                      <span className="article-preview-source" dir="auto">{article.source || t('results.unknownSource')}</span>
                    </div>
                      {article.title
                        ? <div className="article-preview-title" dir="auto">{article.title}</div>
                        : <div className="article-preview-title ltr-isolate">{article.url}</div>}
                    </div>
                  ))
                ) : (
                  <div className="mini-empty">{t('results.noArticles')}</div>
                )}
              </div>
          </motion.div>
        </div>
      </div>
    </div>
  );
}
