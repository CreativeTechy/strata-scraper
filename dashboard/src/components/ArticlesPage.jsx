import RemoveProjectArticlesDialog from './articles/RemoveProjectArticlesDialog.jsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Trans, useTranslation } from 'react-i18next';
import { ExternalLink, Calendar, Search, ChevronLeft, ChevronRight, ChevronDown, SlidersHorizontal, Trash2, Filter, Download, Upload, AlertTriangle, Info, LayoutGrid, List, FolderKanban, Layers, Languages, X } from 'lucide-react';
import ConfirmModal from './ConfirmModal';
import ErrorNotice from './ErrorNotice';
import ImportOptionsModal from './articles/ImportOptionsModal.jsx';
import ExportOptionsModal from './articles/ExportOptionsModal.jsx';
import { useAuth } from '../auth/useAuth.js';
import { apiError, localizedError } from '../errors/apiError.js';
import { userFacingError } from '../errors/userFacingError.js';
import { formatDate, formatDateTime, formatDuration, formatList, formatNumber, languageName } from '../i18n/format.js';
import '../styles/Articles.css';

// Values are the API's sort codes; labels are translation keys under
// `articles:sort.*`, resolved at render time.
const SORT_OPTIONS = [
  { value: 'published.desc', labelKey: 'sort.publishedDesc' },
  { value: 'published.asc', labelKey: 'sort.publishedAsc' },
  { value: 'fetched_at.desc', labelKey: 'sort.fetchedDesc' },
  { value: 'created_at.desc', labelKey: 'sort.createdDesc' },
  { value: 'source.asc', labelKey: 'sort.sourceAsc' },
];

const PAGE_SIZES = [12, 24, 48, 96];

const VIEW_MODES = [
  { value: 'card', labelKey: 'viewModes.card', icon: LayoutGrid },
  { value: 'list', labelKey: 'viewModes.list', icon: List },
];

// How often to poll a running import for its counters. Matches the cadence the
// competitor workspace polls its discovery/analysis jobs at.
const IMPORT_POLL_MS = 900;

// Folder pickers hand back every file under the folder regardless of the
// input's `accept` filter, so JSONL exports have to be picked out client-side.
const JSONL_NAME_RE = /\.(jsonl|ndjson)$/i;

// Chips/inline text with a date-input value ("YYYY-MM-DD"): parse as a local
// date so the label doesn't shift a day in timezones west of UTC.
function filterDateLabel(value) {
  const [year, month, day] = String(value).split('-').map(Number);
  if (!year || !month || !day) return value;
  return formatDate(new Date(year, month - 1, day), undefined, value);
}

/** Live view of one import job: how far through the file it is, how fast it is
 *  going, and what it could not read. `run` is whatever the last poll returned,
 *  so this renders the same whether the job is queued, running or finished.
 *  The headline and timing lines are built here from the run's counters rather
 *  than shown from the backend's (English-only) progress messages. */
function ImportProgressBanner({ run, onDismiss }) {
  const { t } = useTranslation('articles');
  const done = run.status === 'success' || run.status === 'failed';
  const total = run.total_lines || 0;
  const processed = run.processed || 0;
  const percent = total ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const rate = run.rate_per_second || 0;
  const saved = run.saved || 0;
  const elapsed = run.elapsed_seconds || 0;
  const roundedRate = Math.round(rate);

  let headline;
  if (run.status === 'success') headline = t('import.headline.success', { count: saved, formatted: formatNumber(saved) });
  else if (run.status === 'failed') headline = t('import.headline.failed');
  else if (run.status === 'running') headline = t('import.headline.running');
  else headline = t('import.headline.queued');

  const failureDetail = run.status === 'failed' && (run.error || run.message)
    ? userFacingError(run.error || run.message, { context: t('errorContext.importFile') }).message
    : '';

  let timing = '';
  if (!done && total && rate > 0 && processed < total) {
    timing = t('import.timeLeft', { duration: formatDuration((total - processed) / rate) });
  } else if (!done && elapsed) {
    timing = t('import.timeElapsed', { duration: formatDuration(elapsed) });
  }

  return (
    <div className={`glass-card articles-import-banner ${run.status === 'failed' ? 'is-failed' : ''}`}>
      {run.status === 'failed' ? <AlertTriangle size={18} /> : <Info size={18} />}
      <div className="articles-import-banner-body">
        {run._batch ? (
          <p className="articles-import-batch-label">
            {t('import.batchLabel', { index: formatNumber(run._batch.index), total: formatNumber(run._batch.total) })}{' '}
            <span className="ltr-isolate ltr-inline">{run._batch.name}</span>
          </p>
        ) : null}
        <div className="articles-import-headline">
          <strong>{headline}</strong>
          {!done && rate > 0 ? (
            <span className="articles-import-rate">{t('import.rate', { count: roundedRate, formatted: formatNumber(roundedRate) })}</span>
          ) : null}
        </div>

        {failureDetail ? <p className="articles-import-note">{failureDetail}</p> : null}

        {!done ? (
          <div
            className="articles-import-progress"
            role="progressbar"
            aria-valuenow={total ? percent : undefined}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t('import.progressAria')}
          >
            {/* Without a line count there is no honest percentage, so show an
                indeterminate bar rather than a made-up one. */}
            <div
              className={`articles-import-progress-fill ${total ? '' : 'is-indeterminate'}`}
              style={total ? { width: `${percent}%` } : undefined}
            />
          </div>
        ) : null}

        <div className="articles-import-counts">
          <span>{t('import.saved', { formatted: formatNumber(saved) })}</span>
          {total ? <span>{t('import.ofLines', { count: total, formatted: formatNumber(total) })}</span> : null}
          {run.skipped ? <span>{t('import.skipped', { formatted: formatNumber(run.skipped) })}</span> : null}
          {done && elapsed ? <span>{t('import.elapsedIn', { duration: formatDuration(elapsed) })}</span> : null}
        </div>

        {done && run.status === 'success' ? (
          <p className="articles-import-note">{t('import.updatedNote')}</p>
        ) : null}

        {run.errors?.length ? (
          <ul className="articles-import-errors">
            {run.errors.slice(0, 5).map((item) => (
              <li key={item.line}>
                {/* The whole item goes in: userFacingError reads `.error` as
                    the message and `.code`/`.params` for the translation. */}
                {t('import.lineError', {
                  line: formatNumber(item.line),
                  message: userFacingError(item, { context: t('errorContext.importArticle') }).message,
                })}
              </li>
            ))}
            {run.errors.length > 5 ? <li>{t('import.moreErrors', { formatted: formatNumber(run.errors.length - 5) })}</li> : null}
          </ul>
        ) : null}

        {timing ? <p className="articles-import-log">{timing}</p> : null}
      </div>
      {done ? (
        <button type="button" className="articles-import-banner-close" onClick={onDismiss} aria-label={t('import.dismissAria')}>
          <X size={16} />
        </button>
      ) : null}
    </div>
  );
}

function articleDate(value, t) {
  if (!value) return t('card.unknownDate');
  return formatDate(value, undefined, value);
}

function scrapedAtLabel(value, t) {
  if (!value) return t('card.unknown');
  return formatDateTime(value, undefined, value);
}

// The detector's ISO code (`source_language`, or `language` on older rows);
// null when the row carries neither.
function articleLanguage(article) {
  const code = article?.source_language || article?.language;
  return code ? String(code) : null;
}

function getPageNumbers(currentPage, totalPages) {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const pages = [1];
  if (currentPage > 3) pages.push('...');
  const start = Math.max(2, currentPage - 1);
  const end = Math.min(totalPages - 1, currentPage + 1);
  for (let page = start; page <= end; page += 1) pages.push(page);
  if (currentPage < totalPages - 2) pages.push('...');
  pages.push(totalPages);
  return pages;
}

function SkeletonArticleCard() {
  return (
    <div className="glass-card article-card article-skeleton" aria-hidden="true">
      <div className="skeleton-row">
        <div className="skeleton-pill skeleton-shimmer" />
        <div className="skeleton-pill skeleton-shimmer" style={{ width: '62%' }} />
      </div>
      <div className="skeleton-title skeleton-shimmer" />
      <div className="skeleton-line skeleton-shimmer" />
      <div className="skeleton-line skeleton-shimmer" style={{ width: '88%' }} />
      <div className="skeleton-tags">
        <div className="skeleton-chip skeleton-shimmer" />
        <div className="skeleton-chip skeleton-shimmer" style={{ width: 92 }} />
      </div>
      <div className="skeleton-footer">
        <div className="skeleton-line skeleton-shimmer" style={{ width: '38%' }} />
        <div className="skeleton-line skeleton-shimmer" style={{ width: '28%' }} />
      </div>
    </div>
  );
}

export default function ArticlesPage({ project = null, projectId = null, projects = [], sources = [] }) {
  const { t, i18n } = useTranslation('articles');
  const uiLanguage = i18n.resolvedLanguage;
  const normalizedProjectId = useMemo(() => {
    if (projectId == null) return null;
    if (typeof projectId === 'object') {
      const nestedId = Number(projectId?.id);
      return Number.isFinite(nestedId) ? nestedId : null;
    }
    const parsed = Number(projectId);
    return Number.isFinite(parsed) ? parsed : null;
  }, [projectId]);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [projectFilter, setProjectFilter] = useState(() => (normalizedProjectId != null ? String(normalizedProjectId) : 'all'));
  const [sourceFilter, setSourceFilter] = useState('all');
  const [pipelineRunFilter, setPipelineRunFilter] = useState('all');
  const [pipelineRuns, setPipelineRuns] = useState([]);
  const [limit, setLimit] = useState(24);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState('published.desc');
  const [scrapedFrom, setScrapedFrom] = useState('');
  const [scrapedTo, setScrapedTo] = useState('');
  const [articles, setArticles] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportingCompetitors, setExportingCompetitors] = useState(false);
  const [competitorsExportPreview, setCompetitorsExportPreview] = useState(null);
  const [importing, setImporting] = useState(false);
  const [importRun, setImportRun] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [showDeleteAllModal, setShowDeleteAllModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showExportArticlesConfirm, setShowExportArticlesConfirm] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [viewMode, setViewMode] = useState(() => {
    try {
      return window.localStorage.getItem('articles-view-mode') === 'list' ? 'list' : 'card';
    } catch {
      return 'card';
    }
  });
  const [expandedRows, setExpandedRows] = useState(() => new Set());
  const hasArticlesRef = useRef(false);
  const searchInputRef = useRef(null);
  const importInputRef = useRef(null);
  const importFolderInputRef = useRef(null);
  const { hasPermission } = useAuth();
  const canDeleteAll = hasPermission('articles.delete');
  const canImport = hasPermission('articles.import');

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    setOffset(0);
  }, [search, projectFilter, sourceFilter, pipelineRunFilter, limit, sort, scrapedFrom, scrapedTo]);

  const activeProject = useMemo(() => {
    if (projectFilter === 'all') return null;
    return projects.find((item) => String(item.id) === String(projectFilter)) || null;
  }, [projects, projectFilter]);

  const sourceOptions = useMemo(() => {
    if (!activeProject) return [];
    const linkedIds = new Set((activeProject.source_ids || []).map((id) => Number(id)));
    return (sources || [])
      .filter((source) => linkedIds.has(Number(source.id)))
      .map((source) => ({ value: source.url, label: source.name || source.url }));
  }, [activeProject, sources]);

  useEffect(() => {
    setSourceFilter('all');
    setPipelineRunFilter('all');
  }, [projectFilter]);

  useEffect(() => {
    const controller = new AbortController();
    async function loadPipelineRuns() {
      if (!activeProject) {
        setPipelineRuns([]);
        return;
      }
      try {
        const res = await fetch(`/api/pipeline-runs?project_id=${encodeURIComponent(activeProject.id)}&limit=50`, {
          signal: controller.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return;
        setPipelineRuns(Array.isArray(data?.runs) ? data.runs : []);
      } catch (err) {
        if (err?.name !== 'AbortError') setPipelineRuns([]);
      }
    }
    loadPipelineRuns();
    return () => controller.abort();
  }, [activeProject]);

  // Labels are rebuilt when the UI language changes; `value` (the run id the
  // filter state holds) never is, so switching language keeps the filter.
  const pipelineRunOptions = useMemo(
    () =>
      pipelineRuns.map((run) => ({
        value: run.id,
        label: t('filters.pipelineRunOption', {
          run: run.sequence_number
            ? t('filters.pipelineNumber', { number: formatNumber(run.sequence_number) })
            : t('filters.pipelineRun'),
          date: formatDateTime(run.started_at) || t('filters.unknownDate'),
        }),
      })),
    // uiLanguage: formatDateTime reads the active locale, not `t`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pipelineRuns, t, uiLanguage],
  );

  useEffect(() => {
    const controller = new AbortController();
    async function loadArticles() {
      setLoading(true);
      setError('');
      try {
        const params = new URLSearchParams();
        if (search) params.set('search', search);
        if (projectFilter !== 'all') params.set('project_id', String(projectFilter));
        if (sourceFilter !== 'all') params.set('source_url', sourceFilter);
        if (pipelineRunFilter !== 'all') params.set('pipeline_run_id', pipelineRunFilter);
        if (scrapedFrom) params.set('scraped_from', scrapedFrom);
        if (scrapedTo) params.set('scraped_to', scrapedTo);
        params.set('limit', String(limit));
        params.set('offset', String(offset));
        params.set('sort', sort);

        const res = await fetch(`/api/articles?${params.toString()}`, { signal: controller.signal });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw apiError(data, { status: res.status, fallback: t('errors.loadFailed') });
        }

        setArticles(Array.isArray(data?.articles) ? data.articles : []);
        setTotal(Number(data?.total) || 0);
      } catch (err) {
        if (err?.name !== 'AbortError') {
          setError(err?.message ? err : t('errors.loadFailed'));
          if (!hasArticlesRef.current) {
            setArticles([]);
            setTotal(0);
          }
        }
      } finally {
        setLoading(false);
      }
    }

    loadArticles();
    return () => controller.abort();
    // `t` is only read for fallback error text; a language switch must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, projectFilter, sourceFilter, pipelineRunFilter, limit, offset, sort, scrapedFrom, scrapedTo, reloadToken]);

  useEffect(() => {
    hasArticlesRef.current = articles.length > 0;
  }, [articles.length]);

  const changeViewMode = (mode) => {
    setViewMode(mode);
    try {
      window.localStorage.setItem('articles-view-mode', mode);
    } catch {
      // ignore - persistence is a nicety, not a requirement
    }
  };

  const toggleRowExpanded = (id) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + articles.length, total);
  const hasPrev = offset > 0;
  const hasNext = offset + limit < total;
  const isInitialLoading = loading && articles.length === 0;
  const isRefreshing = loading && articles.length > 0;
  const scopeLabel = projectFilter === 'all' ? t('header.allProjectsOption') : (activeProject?.name || t('toolbar.selectedProject'));
  const searchBusy = Boolean(searchInput) && (searchInput.trim() !== search || loading);

  const clearSearch = () => {
    setSearchInput('');
    setSearch('');
    searchInputRef.current?.focus();
  };

  const totalPages = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.min(totalPages, Math.floor(offset / limit) + 1);
  const pageNumbers = useMemo(() => getPageNumbers(currentPage, totalPages), [currentPage, totalPages]);
  const goToPage = (page) => setOffset((page - 1) * limit);

  const handleExportJsonl = async () => {
    if (exporting) return;
    setExporting(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (projectFilter !== 'all') params.set('project_id', String(projectFilter));
      if (sourceFilter !== 'all') params.set('source_url', sourceFilter);
      if (pipelineRunFilter !== 'all') params.set('pipeline_run_id', pipelineRunFilter);
      if (scrapedFrom) params.set('scraped_from', scrapedFrom);
      if (scrapedTo) params.set('scraped_to', scrapedTo);
      params.set('sort', sort);

      const res = await fetch(`/api/articles/export?${params.toString()}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw apiError(data, { status: res.status, fallback: t('errors.exportFailed') });
      }

      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      anchor.href = objectUrl;
      anchor.download = `articles-${timestamp}.jsonl`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      setError(err?.message ? err : t('errors.exportFailed'));
    } finally {
      setExporting(false);
    }
  };

  // Companion to handleExportJsonl: the tracked competitors for the project
  // currently in scope, so the same handoff that carries articles to whatever
  // analyzes them also carries who this study is watching. Only meaningful
  // for a competitor-mode project - the button that calls this is hidden
  // otherwise. Fetches the file first so the confirmation modal can show
  // exactly how many rows are about to download; confirming just saves the
  // blob already in hand.
  const handleExportCompetitorsJsonl = async () => {
    if (exportingCompetitors || !activeProject) return;
    setExportingCompetitors(true);
    setError('');
    try {
      const res = await fetch(`/api/competitors/export?project_id=${encodeURIComponent(activeProject.id)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw apiError(data, { status: res.status, fallback: t('errors.exportCompetitorsFailed') });
      }
      const blob = await res.blob();
      const text = await blob.text();
      const count = text.split('\n').filter((line) => line.trim()).length;
      setCompetitorsExportPreview({ blob, count });
    } catch (err) {
      setError(err?.message ? err : t('errors.exportCompetitorsFailed'));
    } finally {
      setExportingCompetitors(false);
    }
  };

  const confirmExportCompetitorsJsonl = () => {
    if (!competitorsExportPreview) return;
    const objectUrl = URL.createObjectURL(competitorsExportPreview.blob);
    const anchor = document.createElement('a');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    anchor.href = objectUrl;
    anchor.download = `competitors-${timestamp}.jsonl`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
    setCompetitorsExportPreview(null);
  };

  // Imports one file end to end: queues the backend job, then polls it to
  // completion, rendering its counters and throughput as they arrive.
  // `batch` ({ index, total, name }, e.g. file 2 of 3: foo.jsonl) is stamped
  // onto each polled run so the banner can show which file of a multi-file
  // selection is active; the banner turns it into text at render time.
  const importSingleFile = async (file, batch) => {
    const body = new FormData();
    body.append('file', file);
    // Imported rows land in the project currently in scope, mirroring what a
    // scrape for that project would have produced. 'all' imports unlinked.
    if (projectFilter !== 'all') body.append('project_id', String(projectFilter));

    const res = await fetch('/api/articles/import', { method: 'POST', body });
    const queued = await res.json().catch(() => ({}));
    if (!res.ok || queued?.error) {
      throw apiError(queued, { status: res.status, fallback: t('errors.importFailed') });
    }

    let lastSaved = 0;
    for (;;) {
      const statusRes = await fetch(`/api/articles/import/${queued.run_id}`);
      const payload = await statusRes.json().catch(() => ({}));
      if (!statusRes.ok || payload?.error) {
        throw apiError(payload, { status: statusRes.status, fallback: t('errors.importStatusLost') });
      }
      const run = payload.run || {};
      setImportRun(batch ? { ...run, _batch: batch } : run);
      // Refresh the list as rows land, not only at the end, so a long import
      // visibly fills the page instead of sitting empty until it finishes.
      if ((run.saved || 0) > lastSaved) {
        lastSaved = run.saved || 0;
        setReloadToken((value) => value + 1);
      }
      if (run.status === 'success' || run.status === 'failed') {
        if (run.status === 'failed') throw new Error(run.error || run.message || t('errors.importJobFailed'));
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, IMPORT_POLL_MS));
    }
  };

  const handleImportFile = async (event) => {
    const picked = Array.from(event.target.files || []);
    // Clear the input straight away so re-picking the same file(s)/folder still fires onChange.
    event.target.value = '';
    if (!picked.length || importing) return;

    // A folder pick hands back every file it contains, so keep only JSONL exports.
    const files = picked.filter((file) => JSONL_NAME_RE.test(file.webkitRelativePath || file.name));
    if (!files.length) {
      setError(localizedError(t('errors.noJsonlFiles')));
      return;
    }

    setImporting(true);
    setError('');
    setImportRun(null);

    // Files are imported one at a time (the backend runs one job per upload)
    // so failures on one file don't abort the rest of the batch.
    const failures = [];
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      const displayName = file.webkitRelativePath || file.name;
      const batch = files.length > 1 ? { index: i + 1, total: files.length, name: displayName } : null;
      try {
        await importSingleFile(file, batch);
      } catch (err) {
        failures.push({ name: displayName, error: err?.message ? err : new Error(t('errors.importFailed')) });
      }
    }

    if (failures.length) {
      setError(
        files.length > 1
          ? localizedError(
              t('errors.batchFailed', {
                count: files.length,
                failed: formatNumber(failures.length),
                formatted: formatNumber(files.length),
                details: formatList(
                  failures.map((f) => t('errors.batchFailureItem', { name: f.name, error: userFacingError(f.error, { context: t('errorContext.importFile') }).message })),
                ),
              }),
            )
          // A single file keeps its own Error, so an API error code survives.
          : failures[0].error
      );
    }

    setOffset(0);
    setReloadToken((value) => value + 1);
    setImporting(false);
  };

  return (
    <div className="admin-page-shell articles-page-shell">
      <div className="content-shell">
        <div className="admin-page-header">
          <div>
            <div className="admin-page-kicker" style={{ marginBottom: 10 }}>
              <SlidersHorizontal size={26} color="#ff6b35" />
              <span>{t('header.kicker')}</span>
            </div>
            <h1 className="admin-page-title">{t('header.title')}</h1>
            <p className="admin-page-subtitle">
              {t('header.subtitle')}{' '}
              {project ? (
                <Trans t={t} i18nKey="header.dashboardProject" values={{ name: project.name }} components={{ name: <bdi /> }} />
              ) : (
                t('header.allProjects')
              )}
            </p>
          </div>

          <div className="dashboard-hero-actions">
            <div className="report-project-control">
              <label className="report-project-control-label" htmlFor="articles-project-select">
                <FolderKanban size={13} /> {t('header.projectScope')}
              </label>
              <div className="report-project-select-wrap">
                <FolderKanban size={16} aria-hidden="true" />
                <select
                  id="articles-project-select"
                  className="filter-select report-project-select"
                  value={projectFilter}
                  onChange={(e) => setProjectFilter(e.target.value)}
                  aria-label={t('header.projectScopeAria')}
                >
                  <option value="all">{t('header.allProjectsOption')}</option>
                  {projects.map((item) => {
                    const status = item.status || 'draft';
                    return (
                      <option key={item.id} value={item.id}>
                        {t('header.projectOption', { name: item.name, status: t(`common:status.${status}`, { defaultValue: status }) })}
                      </option>
                    );
                  })}
                </select>
              </div>
            </div>
            {canDeleteAll && activeProject && (
              <button
                className="btn-secondary"
                onClick={() => setShowDeleteAllModal(true)}
                disabled={loading}
                style={{ color: '#b42318', borderColor: 'rgba(180,35,24,0.18)' }}
              >
                <Trash2 size={16} />
                {t('removeProject.openButton')}
              </button>
            )}
            <Link to="/dashboard" className="btn-secondary" style={{ textDecoration: 'none' }}>
              {t('header.backToDashboard')}
            </Link>
          </div>
        </div>

        {showDeleteAllModal && activeProject && (
          <RemoveProjectArticlesDialog
            key={activeProject.id}
            open
            project={activeProject}
            onClose={() => setShowDeleteAllModal(false)}
            onRemoved={() => {
              setShowDeleteAllModal(false);
              setOffset(0);
              setReloadToken((value) => value + 1);
            }}
          />
        )}

        <ConfirmModal
          open={Boolean(competitorsExportPreview)}
          title={t('exportCompetitors.title')}
          message={
            competitorsExportPreview
              ? t('exportCompetitors.message', {
                  count: competitorsExportPreview.count,
                  formatted: formatNumber(competitorsExportPreview.count),
                  project: activeProject?.name || t('exportCompetitors.thisProject'),
                })
              : ''
          }
          confirmLabel={t('common:actions.export')}
          cancelLabel={t('common:actions.cancel')}
          onClose={() => setCompetitorsExportPreview(null)}
          onConfirm={confirmExportCompetitorsJsonl}
        />

        <ExportOptionsModal
          open={showExportModal}
          articlesCount={total}
          showCompetitorsOption={activeProject?.mode === 'competitor'}
          competitorProjectName={activeProject?.name}
          onClose={() => setShowExportModal(false)}
          onChooseArticles={() => {
            setShowExportModal(false);
            setShowExportArticlesConfirm(true);
          }}
          onChooseCompetitors={() => {
            setShowExportModal(false);
            handleExportCompetitorsJsonl();
          }}
        />

        <ConfirmModal
          open={showExportArticlesConfirm}
          title={t('exportArticles.title')}
          message={t('exportArticles.message', { count: total, formatted: formatNumber(total) })}
          confirmLabel={exporting ? t('toolbar.exporting') : t('common:actions.export')}
          cancelLabel={t('common:actions.cancel')}
          onClose={() => {
            if (!exporting) setShowExportArticlesConfirm(false);
          }}
          onConfirm={async () => {
            if (exporting) return;
            setShowExportArticlesConfirm(false);
            await handleExportJsonl();
          }}
        />

        <ImportOptionsModal
          open={showImportModal}
          hasProject={projectFilter !== 'all'}
          disabled={importing}
          onClose={() => setShowImportModal(false)}
          onChooseFiles={() => {
            setShowImportModal(false);
            importInputRef.current?.click();
          }}
          onChooseFolder={() => {
            setShowImportModal(false);
            importFolderInputRef.current?.click();
          }}
        />

        <div className="articles-filters-row">
          <div className="glass-card articles-filter-panel">
            <select
              className="filter-select"
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              disabled={!activeProject || sourceOptions.length === 0}
              aria-label={t('filters.sourceAria')}
            >
              <option value="all">
                {activeProject ? t('filters.allSources') : t('filters.selectProjectForSources')}
              </option>
              {sourceOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            <select
              className="filter-select"
              value={pipelineRunFilter}
              onChange={(e) => setPipelineRunFilter(e.target.value)}
              disabled={!activeProject || pipelineRunOptions.length === 0}
              aria-label={t('filters.pipelineRunAria')}
            >
              <option value="all">
                {activeProject ? t('filters.allPipelineRuns') : t('filters.selectProjectForPipelineRuns')}
              </option>
              {pipelineRunOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            <div className="articles-date-range">
              <span className="articles-date-range-label">
                <Calendar size={14} /> {t('filters.scrapedBetween')}
              </span>
              <input
                type="date"
                className="filter-select"
                value={scrapedFrom}
                max={scrapedTo || undefined}
                onChange={(e) => setScrapedFrom(e.target.value)}
                title={t('filters.scrapedFromTitle')}
                aria-label={t('filters.scrapedFromAria')}
              />
              <span className="articles-date-range-sep">{t('filters.dateRangeSeparator')}</span>
              <input
                type="date"
                className="filter-select"
                value={scrapedTo}
                min={scrapedFrom || undefined}
                onChange={(e) => setScrapedTo(e.target.value)}
                title={t('filters.scrapedToTitle')}
                aria-label={t('filters.scrapedToAria')}
              />
            </div>
          </div>

          <div className="glass-card articles-filter-panel">
            <label className="articles-search">
              <Search size={18} color="var(--text-light)" />
              <input
                ref={searchInputRef}
                type="text"
                dir="auto"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && searchInput) {
                    e.stopPropagation();
                    clearSearch();
                  }
                }}
                placeholder={t('filters.searchPlaceholder')}
                aria-label={t('filters.searchAria')}
                style={{ width: '100%', border: 'none', outline: 'none', background: 'transparent', fontSize: '0.95rem' }}
              />
              {searchBusy ? (
                <span className="articles-search-spinner" aria-hidden="true" />
              ) : searchInput ? (
                <button
                  type="button"
                  className="articles-search-clear"
                  onClick={clearSearch}
                  aria-label={t('filters.clearSearch')}
                  title={t('filters.clearSearch')}
                >
                  <X size={14} />
                </button>
              ) : null}
            </label>

            <select className="filter-select" value={sort} onChange={(e) => setSort(e.target.value)} aria-label={t('filters.sortAria')}>
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="admin-toolbar-row" style={{ justifyContent: 'space-between' }}>
          <div className="articles-toolbar-summary">
            <span>
              {loading
                ? t('toolbar.loading')
                : t('toolbar.summary', {
                    count: total,
                    formatted: formatNumber(total),
                    from: formatNumber(start),
                    to: formatNumber(end),
                  })}
            </span>
            <span className="panel-chip muted" style={{ textTransform: 'none', letterSpacing: 0 }}>
              <Filter size={12} />
              <bdi>{scopeLabel}</bdi>
            </span>
            {sourceFilter !== 'all' && (
              <span className="panel-chip muted" style={{ textTransform: 'none', letterSpacing: 0 }}>
                <Filter size={12} />
                <bdi>{sourceOptions.find((option) => option.value === sourceFilter)?.label || sourceFilter}</bdi>
              </span>
            )}
            {pipelineRunFilter !== 'all' && (
              <span className="panel-chip muted" style={{ textTransform: 'none', letterSpacing: 0 }}>
                <Layers size={12} />
                {pipelineRunOptions.find((option) => option.value === pipelineRunFilter)?.label || t('filters.pipelineRun')}
              </span>
            )}
            {(scrapedFrom || scrapedTo) && (
              <span className="panel-chip muted" style={{ textTransform: 'none', letterSpacing: 0 }}>
                <Calendar size={12} />
                {t('toolbar.scrapedRange', {
                  from: scrapedFrom ? filterDateLabel(scrapedFrom) : t('toolbar.anyDate'),
                  to: scrapedTo ? filterDateLabel(scrapedTo) : t('toolbar.anyDate'),
                })}
              </span>
            )}
          </div>
          <div className="articles-pager-actions">
            <div className="source-type-tabs" role="tablist" aria-label={t('toolbar.viewSwitcherAria')}>
              {VIEW_MODES.map((mode) => {
                const Icon = mode.icon;
                const isActive = viewMode === mode.value;
                return (
                  <button
                    key={mode.value}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    className={`source-type-tab ${isActive ? 'active' : ''}`}
                    onClick={() => changeViewMode(mode.value)}
                  >
                    <Icon size={14} /> {t(mode.labelKey)}
                  </button>
                );
              })}
            </div>
            <select className="filter-select" value={limit} onChange={(e) => setLimit(Number(e.target.value))} aria-label={t('toolbar.perPageAria')}>
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {t('toolbar.perPageOption', { formatted: formatNumber(size) })}
                </option>
              ))}
            </select>
            <button className="btn-secondary" onClick={() => setShowExportModal(true)} disabled={loading || exporting || exportingCompetitors}>
              <Upload size={16} />
              {exporting || exportingCompetitors ? t('toolbar.exporting') : t('common:actions.export')}
            </button>
            {canImport && (
              <>
                <input
                  ref={importInputRef}
                  type="file"
                  accept=".jsonl,.ndjson,application/x-ndjson"
                  multiple
                  onChange={handleImportFile}
                  style={{ display: 'none' }}
                />
                <input
                  ref={importFolderInputRef}
                  type="file"
                  webkitdirectory=""
                  directory=""
                  multiple
                  onChange={handleImportFile}
                  style={{ display: 'none' }}
                />
                <button
                  className="btn-secondary"
                  onClick={() => setShowImportModal(true)}
                  disabled={loading || importing}
                >
                  <Download size={16} />
                  {importing ? t('toolbar.importing') : t('common:actions.import')}
                </button>
              </>
            )}
          </div>
        </div>

        <ErrorNotice error={error} context={t('errorContext.loadArticles')} onDismiss={() => setError('')} />

        {importRun ? <ImportProgressBanner run={importRun} onDismiss={() => setImportRun(null)} /> : null}

        {isInitialLoading ? (
          viewMode === 'list' ? (
            <div className="articles-list">
              {Array.from({ length: Math.min(limit, 12) }).map((_, i) => (
                <div key={i} className="glass-card article-row article-skeleton" aria-hidden="true">
                  <div className="skeleton-row">
                    <div className="skeleton-pill skeleton-shimmer" style={{ width: '46%' }} />
                    <div className="skeleton-pill skeleton-shimmer" style={{ width: '18%' }} />
                    <div className="skeleton-pill skeleton-shimmer" style={{ width: '14%' }} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="articles-grid">
              {Array.from({ length: Math.min(limit, 12) }).map((_, i) => (
                <SkeletonArticleCard key={i} />
              ))}
            </div>
          )
        ) : (
          <>
            {isRefreshing && (
              <div className="glass-card" style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, padding: '14px 18px' }}>
                <div className="loading-spinner" />
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 3 }}>{t('refreshing.title')}</div>
                  <div style={{ color: 'var(--text-light)', fontSize: '0.9rem' }}>
                    {t('refreshing.message')}
                  </div>
                </div>
              </div>
            )}

            {viewMode === 'list' ? (
              <div className="articles-list">
                <AnimatePresence>
                  {articles.map((article, i) => {
                    const isExpanded = expandedRows.has(article.id);
                    return (
                      <motion.div
                        key={article.url}
                        layout
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.2, delay: Math.min((i % 24) * 0.015, 0.3) }}
                        className={`glass-card article-row ${isExpanded ? 'expanded' : ''}`}
                        style={isRefreshing ? { opacity: 0.72, pointerEvents: 'none' } : undefined}
                      >
                        <button
                          type="button"
                          className="article-row-summary"
                          onClick={() => toggleRowExpanded(article.id)}
                          aria-expanded={isExpanded}
                        >
                          <span className="article-row-title" dir="auto">{article.title || t('card.untitled')}</span>
                          <span className="article-row-source" dir="auto">{article.source || t('card.unknownSource')}</span>
                          <span className="article-row-date">
                            <Calendar size={13} /> {articleDate(article.published, t)}
                          </span>
                          <ChevronDown size={16} className="article-row-chevron" />
                        </button>

                        {isExpanded ? (
                          <div className="article-row-details">
                            <div className="article-meta">
                              <span className="panel-chip muted" style={{ textTransform: 'none', letterSpacing: 0 }} title={t('card.scrapedTitle')}>
                                <Calendar size={11} style={{ marginInlineEnd: 4 }} /> {t('card.scraped', { date: scrapedAtLabel(article.fetched_at, t) })}
                              </span>
                              {article.author ? (
                                <span className="panel-chip muted" style={{ textTransform: 'none', letterSpacing: 0 }}>
                                  <Trans t={t} i18nKey="card.byAuthor" values={{ author: article.author }} components={{ author: <bdi /> }} />
                                </span>
                              ) : null}
                              {articleLanguage(article) ? (
                                <span className="panel-chip muted" style={{ textTransform: 'none', letterSpacing: 0 }} title={t('card.languageTitle')}>
                                  <Languages size={11} style={{ marginInlineEnd: 4 }} /> {languageName(articleLanguage(article))}
                                </span>
                              ) : null}
                              {article.story_id ? (
                                <span
                                  className="panel-chip muted"
                                  style={{ textTransform: 'none', letterSpacing: 0 }}
                                  title={t('card.storyTitle')}
                                >
                                  <Layers size={11} style={{ marginInlineEnd: 4 }} /> {t('card.story', { id: article.story_id })}
                                </span>
                              ) : null}
                              {article.verified ? <span className="badge positive">{t('card.verified')}</span> : null}
                            </div>

                            <p className="article-summary" dir={article.text ? 'auto' : undefined}>
                              {article.text ? `${article.text.substring(0, 400)}...` : t('card.noText')}
                            </p>

                            <div className="article-row-details-actions">
                              <a href={article.url} target="_blank" rel="noopener noreferrer" className="btn-secondary" style={{ textDecoration: 'none' }}>
                                <ExternalLink size={13} /> {t('card.openOriginal')}
                              </a>
                            </div>
                          </div>
                        ) : null}
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              </div>
            ) : (
              <div className="articles-grid">
                <AnimatePresence>
                  {articles.map((article, i) => (
                    <motion.div
                      key={article.url}
                      layout
                      initial={{ opacity: 0, scale: 0.96, y: 16 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.96 }}
                      transition={{ duration: 0.25, delay: Math.min((i % 12) * 0.03, 0.4) }}
                      className="glass-card article-card"
                      style={isRefreshing ? { opacity: 0.72, pointerEvents: 'none' } : undefined}
                    >
                      <div className="article-header">
                        <div className="article-meta">
                          <span className="panel-chip muted" style={{ textTransform: 'none', letterSpacing: 0 }} title={t('card.scrapedTitle')}>
                            <Calendar size={11} style={{ marginInlineEnd: 4 }} /> {t('card.scraped', { date: scrapedAtLabel(article.fetched_at, t) })}
                          </span>
                          {articleLanguage(article) ? (
                            <span className="panel-chip muted" style={{ textTransform: 'none', letterSpacing: 0 }} title={t('card.languageTitle')}>
                              <Languages size={11} style={{ marginInlineEnd: 4 }} /> {languageName(articleLanguage(article))}
                            </span>
                          ) : null}
                          {article.story_id ? (
                            <span
                              className="panel-chip muted"
                              style={{ textTransform: 'none', letterSpacing: 0 }}
                              title={t('card.storyTitle')}
                            >
                              <Layers size={11} style={{ marginInlineEnd: 4 }} /> {t('card.story', { id: article.story_id })}
                            </span>
                          ) : null}
                          {article.verified ? <span className="badge positive">{t('card.verified')}</span> : null}
                        </div>
                      </div>

                      <h3 className="article-title" dir="auto">
                        <a href={article.url} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>
                          {article.title || t('card.untitled')} <ExternalLink size={14} style={{ opacity: 0.5 }} />
                        </a>
                      </h3>

                      <p className="article-summary" dir={article.text ? 'auto' : undefined}>
                        {article.text ? `${article.text.substring(0, 220)}...` : t('card.noText')}
                      </p>

                      <div className="article-footer">
                        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <Calendar size={14} /> {articleDate(article.published, t)}
                        </span>
                        <span dir="auto">{article.source || t('card.unknownSource')}</span>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            )}

            {articles.length === 0 && (
              <div className="glass-card">
                <div className="admin-empty-state">
                  <div className="admin-empty-state-icon">
                    <Search size={18} />
                  </div>
                  <strong>{t('empty.title')}</strong>
                  <span>{t('empty.message')}</span>
                </div>
              </div>
            )}
          </>
        )}

        {!isInitialLoading && articles.length > 0 && (
          <div className="articles-pagination" role="navigation" aria-label={t('pagination.aria')}>
            <button className="btn-secondary" onClick={() => setOffset((prev) => Math.max(0, prev - limit))} disabled={!hasPrev || loading}>
              <ChevronLeft size={16} className="icon-flip-rtl" /> {t('common:actions.previous')}
            </button>
            {pageNumbers.map((page, index) =>
              page === '...' ? (
                <span key={`ellipsis-${index}`} className="articles-page-ellipsis">
                  &hellip;
                </span>
              ) : (
                <button
                  key={page}
                  type="button"
                  className={`articles-page-btn ${page === currentPage ? 'active' : ''}`}
                  onClick={() => goToPage(page)}
                  disabled={loading}
                  aria-current={page === currentPage ? 'page' : undefined}
                >
                  {formatNumber(page)}
                </button>
              )
            )}
            <button className="btn-secondary" onClick={() => setOffset((prev) => prev + limit)} disabled={!hasNext || loading}>
              {t('common:actions.next')} <ChevronRight size={16} className="icon-flip-rtl" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
