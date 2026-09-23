import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Database, RefreshCw, CalendarClock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ErrorNotice from './ErrorNotice';
import { friendlyRunMessage } from '../errors/userFacingError.js';
import { apiError } from '../errors/apiError.js';
import { formatDateTime, formatDuration, formatNumber } from '../i18n/format.js';
import i18n from '../i18n/index.js';

const POLL_INTERVAL_MS = 5000;
// Only surface an upcoming repeating run as a placeholder when it's within this
// many minutes of firing - otherwise every scheduled project would clutter the page.
const UPCOMING_WINDOW_MINUTES = 30;

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

function stageColor(status) {
  if (status === 'success') return '#2ed573';
  if (status === 'failed') return '#ff4757';
  if (status === 'running') return '#ffb13b';
  return '#9aa0aa';
}

const ACTIVE_STATUSES = ['queued', 'running'];

const STATUS_FILTER_OPTIONS = ['all', 'queued', 'running', 'success', 'failed', 'cancelled'];

function projectNameForRun(run, projectsById) {
  if (run.project_name) return run.project_name;
  const project = projectsById.get(Number(run.project_id));
  if (project?.name) return project.name;
  return run.project_id != null
    ? i18n.t('pipeline:projectNumber', { id: run.project_id })
    : i18n.t('pipeline:unassigned');
}

function findNearestUpcomingRun(projects, runs) {
  const now = Date.now();
  const windowMs = UPCOMING_WINDOW_MINUTES * 60 * 1000;
  const projectIdsWithActiveRun = new Set(
    runs
      .filter((run) => ACTIVE_STATUSES.includes(run.status))
      .map((run) => Number(run.project_id))
      .filter((id) => Number.isFinite(id))
  );

  const candidates = projects
    .filter((project) => project.repeat_enabled && project.next_run_at)
    .filter((project) => !projectIdsWithActiveRun.has(Number(project.id)))
    .map((project) => ({ project, nextRunAt: new Date(project.next_run_at).getTime() }))
    .filter(({ nextRunAt }) => Number.isFinite(nextRunAt) && nextRunAt - now <= windowMs)
    .sort((a, b) => a.nextRunAt - b.nextRunAt);

  return candidates[0] || null;
}

// Full "Scheduled to run ..." sentence for the upcoming-run placeholder.
function upcomingRunMessage(targetMs) {
  const time = formatDateTime(targetMs);
  const diffMs = targetMs - Date.now();
  if (diffMs <= 0) return i18n.t('pipeline:runs.upcomingShortly', { time });
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return i18n.t('pipeline:runs.upcomingUnderMinute', { time });
  return i18n.t('pipeline:runs.upcomingIn', { duration: formatDuration(minutes * 60), time });
}

export default function PipelineRunsPage({ projects = [] }) {
  const { t } = useTranslation('pipeline');
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [stoppingId, setStoppingId] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [projectFilter, setProjectFilter] = useState('all');

  const loadRuns = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/pipeline-runs?limit=25');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(data, { status: res.status, fallback: i18n.t('pipeline:errors.loadRunsFailed') });
      setRuns(Array.isArray(data?.runs) ? data.runs : []);
    } catch (err) {
      setError(err?.message ? err : i18n.t('pipeline:errors.loadRunsFailed'));
      setRuns([]);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    loadRuns();
    const interval = setInterval(() => loadRuns({ silent: true }), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  const stopRun = async (runId) => {
    setStoppingId(runId);
    try {
      const res = await fetch(`/api/pipeline-runs/${runId}/stop`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(data, { status: res.status, fallback: i18n.t('pipeline:errors.stopRunFailed') });
      await loadRuns();
    } catch (err) {
      setError(err?.message ? err : i18n.t('pipeline:errors.stopRunFailed'));
    } finally {
      setStoppingId(null);
    }
  };

  const projectsById = useMemo(() => {
    const map = new Map();
    projects.forEach((project) => map.set(Number(project.id), project));
    return map;
  }, [projects]);

  const projectFilterOptions = useMemo(() => {
    const idsInRuns = new Set(runs.map((run) => Number(run.project_id)).filter((id) => Number.isFinite(id)));
    return projects
      .filter((project) => idsInRuns.has(Number(project.id)))
      .map((project) => ({ id: Number(project.id), name: project.name || t('projectNumber', { id: project.id }) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [projects, runs, t]);

  const statusOptionsInRuns = useMemo(() => {
    const present = new Set(runs.map((run) => run.status).filter(Boolean));
    return STATUS_FILTER_OPTIONS.filter((option) => option === 'all' || present.has(option));
  }, [runs]);

  const filteredRuns = useMemo(() => {
    return runs.filter((run) => {
      const matchesStatus = statusFilter === 'all' || run.status === statusFilter;
      const matchesProject = projectFilter === 'all' || String(run.project_id) === projectFilter;
      return matchesStatus && matchesProject;
    });
  }, [runs, statusFilter, projectFilter]);

  const upcomingRun = useMemo(() => findNearestUpcomingRun(projects, runs), [projects, runs]);

  return (
    <div className="admin-page-shell">
      <div className="admin-page-header">
        <div>
          <div className="admin-page-kicker">
            <Database size={14} /> {t('history')}
          </div>
          <h1 className="admin-page-title">{t('runs.title')}</h1>
          <p className="admin-page-subtitle">{t('runs.subtitle')}</p>
        </div>

        <div className="admin-page-toolbar">
          <button className="btn-secondary" onClick={() => loadRuns()} disabled={loading}>
            <RefreshCw size={16} /> {t('common:actions.refresh')}
          </button>
          <Link to="/dashboard" className="btn-secondary" style={{ textDecoration: 'none' }}>
            {t('runs.backToDashboard')}
          </Link>
        </div>
      </div>

      <div className="admin-toolbar-row">
        <select
          className="filter-select"
          value={projectFilter}
          onChange={(e) => setProjectFilter(e.target.value)}
          aria-label={t('runs.filterProject')}
        >
          <option value="all">{t('runs.allProjects')}</option>
          {projectFilterOptions.map((option) => (
            <option key={option.id} value={String(option.id)}>
              {option.name}
            </option>
          ))}
        </select>

        <select
          className="filter-select"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label={t('runs.filterStatus')}
        >
          {statusOptionsInRuns.map((option) => (
            <option key={option} value={option}>
              {option === 'all' ? t('runs.allStatuses') : statusLabel(option)}
            </option>
          ))}
        </select>
      </div>

      <ErrorNotice error={error} context={t('errorContext.loadRuns')} onRetry={loadRuns} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {upcomingRun ? (
          <motion.div
            className="glass-card"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              border: '1px dashed rgba(255, 107, 53, 0.4)',
              background: 'rgba(255, 107, 53, 0.05)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <strong style={{ fontSize: '0.98rem' }} dir="auto">
                {upcomingRun.project.name || t('projectNumber', { id: upcomingRun.project.id })}
              </strong>
              <span style={{ color: '#ff6b35', fontSize: '0.8rem', textTransform: 'uppercase', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                <CalendarClock size={14} /> {t('runs.upcoming')}
              </span>
            </div>
            <div style={{ fontSize: '0.88rem', color: 'var(--text-dark)' }}>
              {upcomingRunMessage(upcomingRun.nextRunAt)}
            </div>
          </motion.div>
        ) : null}

        {loading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="glass-card" style={{ minHeight: 92, opacity: 0.7, animation: 'pulse 1.3s infinite' }} />
          ))
        ) : filteredRuns.length === 0 ? (
          <div className="admin-empty-state">
            <div className="admin-empty-state-icon">
              <Database size={18} />
            </div>
            <strong>{t('runs.emptyTitle')}</strong>
            <span>{runs.length === 0 ? t('runs.emptyNoRuns') : t('runs.emptyFiltered')}</span>
          </div>
        ) : (
          filteredRuns.map((run, i) => (
            <motion.div
              key={run.id}
              className="glass-card"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.03 }}
              style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: '0.98rem' }} dir="auto">{projectNameForRun(run, projectsById)}</strong>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ color: stageColor(run.status), fontSize: '0.8rem', textTransform: 'uppercase', fontWeight: 700 }}>
                    {statusLabel(run.status)}
                  </span>
                  <Link
                    to={`/pipeline-runs/${run.id}`}
                    className="btn-secondary"
                    style={{ padding: '6px 10px', fontSize: '0.75rem', textDecoration: 'none' }}
                  >
                    {t('common:actions.view')}
                  </Link>
                  {ACTIVE_STATUSES.includes(run.status) ? (
                    <button
                      className="btn-secondary"
                      onClick={() => stopRun(run.id)}
                      disabled={stoppingId === run.id}
                      style={{ padding: '6px 10px', fontSize: '0.75rem' }}
                    >
                      {stoppingId === run.id ? t('runs.stopping') : t('runs.stop')}
                    </button>
                  ) : null}
                </div>
              </div>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-light)' }}>
                {t('runs.stageMessage', { stage: prettyStage(run.stage), message: friendlyRunMessage(run) })}
              </div>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: '0.75rem', color: 'var(--text-light)' }}>
                <span>{t('runs.counts.scraped', { value: formatNumber(run.articles_scraped || 0) })}</span>
                <span>{t('runs.counts.cleaned', { value: formatNumber(run.articles_cleaned || 0) })}</span>
                <span>{t('runs.counts.saved', { value: formatNumber(run.articles_saved || 0) })}</span>
                <span>{t('runs.counts.pages', { value: formatNumber(run.crawl_pages || 0) })}</span>
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-light)' }}>
                {run.created_at && run.finished_at
                  ? t('runs.createdAndFinished', { created: formatDateTime(run.created_at), finished: formatDateTime(run.finished_at) })
                  : run.created_at
                    ? t('runs.created', { time: formatDateTime(run.created_at) })
                    : run.finished_at
                      ? t('runs.finished', { time: formatDateTime(run.finished_at) })
                      : ''}
              </div>
            </motion.div>
          ))
        )}
      </div>
    </div>
  );
}
