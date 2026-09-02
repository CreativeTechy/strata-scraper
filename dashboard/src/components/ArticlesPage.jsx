import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ExternalLink, Calendar, Search, ChevronLeft, ChevronRight, ChevronDown, SlidersHorizontal, Trash2, Filter, Download, Upload, AlertTriangle, Info, LayoutGrid, List, FolderKanban, Layers, X } from 'lucide-react';
import ConfirmModal from './ConfirmModal';
import ErrorNotice from './ErrorNotice';
import ImportOptionsModal from './articles/ImportOptionsModal.jsx';
import ExportOptionsModal from './articles/ExportOptionsModal.jsx';
import { useAuth } from '../auth/useAuth.js';
import { userFacingError } from '../errors/userFacingError.js';
import '../styles/Articles.css';

const SORT_OPTIONS = [
  { value: 'published.desc', label: 'Newest first' },
  { value: 'published.asc', label: 'Oldest first' },
  { value: 'fetched_at.desc', label: 'Recently scraped' },
  { value: 'created_at.desc', label: 'Recently saved' },
  { value: 'source.asc', label: 'Source (A-Z)' },
];

const PAGE_SIZES = [12, 24, 48, 96];

// Must match backend/main.py's DELETE_ALL_ARTICLES_CONFIRMATION exactly - the
// API rejects the request without it, so a typed confirmation replaces what
// used to be a plain confirm dialog's default-button click.
const DELETE_ALL_CONFIRMATION = 'DELETE ALL ARTICLES';

const VIEW_MODES = [
  { value: 'card', label: 'Cards', icon: LayoutGrid },
  { value: 'list', label: 'List', icon: List },
];

// How often to poll a running import for its counters. Matches the cadence the
// competitor workspace polls its discovery/analysis jobs at.
const IMPORT_POLL_MS = 900;

// Folder pickers hand back every file under the folder regardless of the
// input's `accept` filter, so JSONL exports have to be picked out client-side.
const JSONL_NAME_RE = /\.(jsonl|ndjson)$/i;

/** Live view of one import job: how far through the file it is, how fast it is
 *  going, and what it could not read. `run` is whatever the last poll returned,
 *  so this renders the same whether the job is queued, running or finished. */
function ImportProgressBanner({ run, onDismiss }) {
  const done = run.status === 'success' || run.status === 'failed';
  const total = run.total_lines || 0;
  const processed = run.processed || 0;
  const percent = total ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const rate = run.rate_per_second || 0;
  const logs = run.logs || [];

  return (
    <div className={`glass-card articles-import-banner ${run.status === 'failed' ? 'is-failed' : ''}`}>
      {run.status === 'failed' ? <AlertTriangle size={18} /> : <Info size={18} />}
      <div className="articles-import-banner-body">
        {run._batchLabel ? <p className="articles-import-batch-label">{run._batchLabel}</p> : null}
        <div className="articles-import-headline">
          <strong>{run.message || 'Importing...'}</strong>
          {!done && rate > 0 ? <span className="articles-import-rate">{Math.round(rate).toLocaleString()} articles/s</span> : null}
        </div>

        {!done ? (
          <div
            className="articles-import-progress"
            role="progressbar"
            aria-valuenow={total ? percent : undefined}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Import progress"
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
          <span>{(run.saved || 0).toLocaleString()} saved</span>
          {total ? <span>of ~{total.toLocaleString()} lines</span> : null}
          {run.skipped ? <span>{run.skipped.toLocaleString()} skipped</span> : null}
          {done && run.elapsed_seconds ? <span>in {run.elapsed_seconds}s</span> : null}
        </div>

        {done && run.status === 'success' ? (
          <p className="articles-import-note">Articles matching an existing URL were updated in place.</p>
        ) : null}

        {run.errors?.length ? (
          <ul className="articles-import-errors">
            {run.errors.slice(0, 5).map((item) => (
              <li key={item.line}>
                Line {item.line}: {userFacingError(item.error, { context: 'import this article' }).message}
              </li>
            ))}
            {run.errors.length > 5 ? <li>and {run.errors.length - 5} more...</li> : null}
          </ul>
        ) : null}

        {!done && logs.length ? <p className="articles-import-log">{logs[logs.length - 1].message}</p> : null}
      </div>
      {done ? (
        <button type="button" className="articles-import-banner-close" onClick={onDismiss} aria-label="Dismiss import summary">
          <X size={16} />
        </button>
      ) : null}
    </div>
  );
}

function articleDate(value) {
  if (!value) return 'Unknown date';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString();
}

function scrapedAtLabel(value) {
  if (!value) return 'Unknown';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
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
  const [limit, setLimit] = useState(24);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState('published.desc');
  const [scrapedFrom, setScrapedFrom] = useState('');
  const [scrapedTo, setScrapedTo] = useState('');
  const [articles, setArticles] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deletingAll, setDeletingAll] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportingCompetitors, setExportingCompetitors] = useState(false);
  const [competitorsExportPreview, setCompetitorsExportPreview] = useState(null);
  const [importing, setImporting] = useState(false);
  const [importRun, setImportRun] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [showDeleteAllModal, setShowDeleteAllModal] = useState(false);
  const [deleteAllConfirmText, setDeleteAllConfirmText] = useState('');
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
  }, [search, projectFilter, sourceFilter, limit, sort, scrapedFrom, scrapedTo]);

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
  }, [projectFilter]);

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
        if (scrapedFrom) params.set('scraped_from', scrapedFrom);
        if (scrapedTo) params.set('scraped_to', scrapedTo);
        params.set('limit', String(limit));
        params.set('offset', String(offset));
        params.set('sort', sort);

        const res = await fetch(`/api/articles?${params.toString()}`, { signal: controller.signal });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data?.detail || data?.error || `Failed to load articles (${res.status})`);
        }

        setArticles(Array.isArray(data?.articles) ? data.articles : []);
        setTotal(Number(data?.total) || 0);
      } catch (err) {
        if (err?.name !== 'AbortError') {
          setError(err?.message || 'Failed to load articles.');
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
  }, [search, projectFilter, sourceFilter, limit, offset, sort, scrapedFrom, scrapedTo, reloadToken]);

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
  const scopeLabel = projectFilter === 'all' ? 'All projects' : (activeProject?.name || 'Selected project');

  const visibleRange = useMemo(() => `${start}-${end}`, [start, end]);
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

  const handleDeleteAll = async () => {
    if (deletingAll) return;
    setDeletingAll(true);
    setError('');
    try {
      const res = await fetch(`/api/articles?confirm=${encodeURIComponent(DELETE_ALL_CONFIRMATION)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        throw new Error(data?.detail || data?.error || `Failed to delete articles (${res.status})`);
      }
      setSearchInput('');
      setSearch('');
      setProjectFilter(normalizedProjectId != null ? String(normalizedProjectId) : 'all');
      setSourceFilter('all');
      setScrapedFrom('');
      setScrapedTo('');
      setOffset(0);
      setReloadToken((value) => value + 1);
    } catch (err) {
      setError(err?.message || 'Failed to delete articles.');
    } finally {
      setDeletingAll(false);
    }
  };

  const handleExportJsonl = async () => {
    if (exporting) return;
    setExporting(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (projectFilter !== 'all') params.set('project_id', String(projectFilter));
      if (sourceFilter !== 'all') params.set('source_url', sourceFilter);
      if (scrapedFrom) params.set('scraped_from', scrapedFrom);
      if (scrapedTo) params.set('scraped_to', scrapedTo);
      params.set('sort', sort);

      const res = await fetch(`/api/articles/export?${params.toString()}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.detail || data?.error || `Failed to export articles (${res.status})`);
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
      setError(err?.message || 'Failed to export articles.');
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
        throw new Error(data?.detail || data?.error || `Failed to export competitors (${res.status})`);
      }
      const blob = await res.blob();
      const text = await blob.text();
      const count = text.split('\n').filter((line) => line.trim()).length;
      setCompetitorsExportPreview({ blob, count });
    } catch (err) {
      setError(err?.message || 'Failed to export competitors.');
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
  // `batchLabel` (e.g. "File 2 of 3: foo.jsonl") is stamped onto each polled
  // run so the banner can show which file of a multi-file selection is active.
  const importSingleFile = async (file, batchLabel) => {
    const body = new FormData();
    body.append('file', file);
    // Imported rows land in the project currently in scope, mirroring what a
    // scrape for that project would have produced. 'all' imports unlinked.
    if (projectFilter !== 'all') body.append('project_id', String(projectFilter));

    const res = await fetch('/api/articles/import', { method: 'POST', body });
    const queued = await res.json().catch(() => ({}));
    if (!res.ok || queued?.error) {
      throw new Error(queued?.detail || queued?.error || `Failed to import articles (${res.status})`);
    }

    let lastSaved = 0;
    for (;;) {
      const statusRes = await fetch(`/api/articles/import/${queued.run_id}`);
      const payload = await statusRes.json().catch(() => ({}));
      if (!statusRes.ok || payload?.error) {
        throw new Error(payload?.detail || payload?.error || `Lost track of the import (${statusRes.status})`);
      }
      const run = payload.run || {};
      setImportRun(batchLabel ? { ...run, _batchLabel: batchLabel } : run);
      // Refresh the list as rows land, not only at the end, so a long import
      // visibly fills the page instead of sitting empty until it finishes.
      if ((run.saved || 0) > lastSaved) {
        lastSaved = run.saved || 0;
        setReloadToken((value) => value + 1);
      }
      if (run.status === 'success' || run.status === 'failed') {
        if (run.status === 'failed') throw new Error(run.error || run.message || 'Import failed.');
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
      setError('No .jsonl/.ndjson files found in the selected folder.');
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
      const batchLabel = files.length > 1 ? `File ${i + 1} of ${files.length}: ${displayName}` : null;
      try {
        await importSingleFile(file, batchLabel);
      } catch (err) {
        failures.push({ name: displayName, error: err?.message || 'Failed to import.' });
      }
    }

    if (failures.length) {
      setError(
        files.length > 1
          ? `${failures.length} of ${files.length} file(s) failed to import: ${failures
              .map((f) => `${f.name} (${f.error})`)
              .join('; ')}`
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
              <span>Article Library</span>
            </div>
            <h1 className="admin-page-title">Articles</h1>
            <p className="admin-page-subtitle">
              Server-side search, project, source, date-range, sort, and pagination powered by the API.
              {project ? ` Dashboard project: ${project.name}.` : ' Showing all projects.'}
            </p>
          </div>

          <div className="dashboard-hero-actions">
            <div className="report-project-control">
              <label className="report-project-control-label" htmlFor="articles-project-select">
                <FolderKanban size={13} /> Project scope
              </label>
              <div className="report-project-select-wrap">
                <FolderKanban size={16} aria-hidden="true" />
                <select
                  id="articles-project-select"
                  className="filter-select report-project-select"
                  value={projectFilter}
                  onChange={(e) => setProjectFilter(e.target.value)}
                  aria-label="Project scope for articles"
                >
                  <option value="all">All projects</option>
                  {projects.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} ({item.status || 'draft'})
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {canDeleteAll && (
              <button
                className="btn-secondary"
                onClick={() => setShowDeleteAllModal(true)}
                disabled={loading || deletingAll}
                style={{ color: '#b42318', borderColor: 'rgba(180,35,24,0.18)' }}
              >
                <Trash2 size={16} />
                {deletingAll ? 'Deleting...' : 'Delete All Articles'}
              </button>
            )}
            <Link to="/dashboard" className="btn-secondary" style={{ textDecoration: 'none' }}>
              Back to Dashboard
            </Link>
          </div>
        </div>

        <ConfirmModal
          open={showDeleteAllModal}
          title="Delete all articles?"
          message="This will remove every row in the articles table and cannot be undone."
          confirmLabel={deletingAll ? 'Deleting...' : 'Delete all articles'}
          cancelLabel="Keep articles"
          confirmButtonStyle={{
            background: 'linear-gradient(135deg, #ff4757, #e03131)',
            boxShadow: '0 4px 15px rgba(255, 71, 87, 0.28)',
          }}
          confirmDisabled={deletingAll || deleteAllConfirmText !== DELETE_ALL_CONFIRMATION}
          onClose={() => {
            if (!deletingAll) {
              setShowDeleteAllModal(false);
              setDeleteAllConfirmText('');
            }
          }}
          onConfirm={async () => {
            if (deletingAll || deleteAllConfirmText !== DELETE_ALL_CONFIRMATION) return;
            setShowDeleteAllModal(false);
            setDeleteAllConfirmText('');
            await handleDeleteAll();
          }}
        >
          <label style={{ display: 'block', marginTop: '0.5rem' }}>
            Type <strong>{DELETE_ALL_CONFIRMATION}</strong> to confirm:
            <input
              type="text"
              value={deleteAllConfirmText}
              onChange={(event) => setDeleteAllConfirmText(event.target.value)}
              autoComplete="off"
              style={{
                display: 'block',
                width: '100%',
                marginTop: '0.4rem',
                padding: '0.5rem 0.75rem',
                borderRadius: '8px',
                border: '1px solid var(--border, #ccc)',
                fontSize: '0.95rem',
              }}
            />
          </label>
        </ConfirmModal>

        <ConfirmModal
          open={Boolean(competitorsExportPreview)}
          title="Export competitors?"
          message={
            competitorsExportPreview
              ? `This will download ${competitorsExportPreview.count} tracked competitor${
                  competitorsExportPreview.count === 1 ? '' : 's'
                } for "${activeProject?.name || 'this project'}" as JSONL.`
              : ''
          }
          confirmLabel="Export"
          cancelLabel="Cancel"
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
          title="Export articles?"
          message={`This will export ${total.toLocaleString()} article${total === 1 ? '' : 's'} matching your current filters as a JSONL file.`}
          confirmLabel={exporting ? 'Exporting...' : 'Export'}
          cancelLabel="Cancel"
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
            >
              <option value="all">
                {activeProject ? 'All sources' : 'Select a project for sources'}
              </option>
              {sourceOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            <div className="articles-date-range">
              <span className="articles-date-range-label">
                <Calendar size={14} /> Scraped between
              </span>
              <input
                type="date"
                className="filter-select"
                value={scrapedFrom}
                max={scrapedTo || undefined}
                onChange={(e) => setScrapedFrom(e.target.value)}
                title="Only show articles scraped on or after this date"
                aria-label="Scraped from date"
              />
              <span className="articles-date-range-sep">to</span>
              <input
                type="date"
                className="filter-select"
                value={scrapedTo}
                min={scrapedFrom || undefined}
                onChange={(e) => setScrapedTo(e.target.value)}
                title="Only show articles scraped on or before this date"
                aria-label="Scraped to date"
              />
            </div>
          </div>

          <div className="glass-card articles-filter-panel">
            <label className="articles-search">
              <Search size={18} color="var(--text-light)" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && searchInput) {
                    e.stopPropagation();
                    clearSearch();
                  }
                }}
                placeholder="Search title, summary, source..."
                aria-label="Search articles"
                style={{ width: '100%', border: 'none', outline: 'none', background: 'transparent', fontSize: '0.95rem' }}
              />
              {searchBusy ? (
                <span className="articles-search-spinner" aria-hidden="true" />
              ) : searchInput ? (
                <button
                  type="button"
                  className="articles-search-clear"
                  onClick={clearSearch}
                  aria-label="Clear search"
                  title="Clear search"
                >
                  <X size={14} />
                </button>
              ) : null}
            </label>

            <select className="filter-select" value={sort} onChange={(e) => setSort(e.target.value)}>
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="admin-toolbar-row" style={{ justifyContent: 'space-between' }}>
          <div className="articles-toolbar-summary">
            <span>{loading ? 'Loading articles...' : `${total.toLocaleString()} articles total, showing ${visibleRange}`}</span>
            <span className="panel-chip muted" style={{ textTransform: 'none', letterSpacing: 0 }}>
              <Filter size={12} />
              {scopeLabel}
            </span>
            {sourceFilter !== 'all' && (
              <span className="panel-chip muted" style={{ textTransform: 'none', letterSpacing: 0 }}>
                <Filter size={12} />
                {sourceOptions.find((option) => option.value === sourceFilter)?.label || sourceFilter}
              </span>
            )}
            {(scrapedFrom || scrapedTo) && (
              <span className="panel-chip muted" style={{ textTransform: 'none', letterSpacing: 0 }}>
                <Calendar size={12} />
                Scraped {scrapedFrom || 'any'} to {scrapedTo || 'any'}
              </span>
            )}
          </div>
          <div className="articles-pager-actions">
            <div className="source-type-tabs" role="tablist" aria-label="Switch article view">
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
                    <Icon size={14} /> {mode.label}
                  </button>
                );
              })}
            </div>
            <select className="filter-select" value={limit} onChange={(e) => setLimit(Number(e.target.value))} aria-label="Articles per page">
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size} per page
                </option>
              ))}
            </select>
            <button className="btn-secondary" onClick={() => setShowExportModal(true)} disabled={loading || exporting || exportingCompetitors || deletingAll}>
              <Upload size={16} />
              {exporting || exportingCompetitors ? 'Exporting...' : 'Export'}
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
                  disabled={loading || importing || deletingAll}
                >
                  <Download size={16} />
                  {importing ? 'Importing...' : 'Import'}
                </button>
              </>
            )}
          </div>
        </div>

        <ErrorNotice error={error} context="load or manage articles" onDismiss={() => setError('')} />

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
                  <div style={{ fontWeight: 600, marginBottom: 3 }}>Refreshing results</div>
                  <div style={{ color: 'var(--text-light)', fontSize: '0.9rem' }}>
                    Keeping the current list visible while the new filter set loads.
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
                          <span className="article-row-title">{article.title || 'Untitled article'}</span>
                          <span className="article-row-source">{article.source || 'Unknown source'}</span>
                          <span className="article-row-date">
                            <Calendar size={13} /> {articleDate(article.published)}
                          </span>
                          <ChevronDown size={16} className="article-row-chevron" />
                        </button>

                        {isExpanded ? (
                          <div className="article-row-details">
                            <div className="article-meta">
                              <span className="panel-chip muted" style={{ textTransform: 'none', letterSpacing: 0 }} title="When the pipeline scraped this article">
                                <Calendar size={11} style={{ marginRight: 4 }} /> Scraped: {scrapedAtLabel(article.fetched_at)}
                              </span>
                              {article.author ? (
                                <span className="panel-chip muted" style={{ textTransform: 'none', letterSpacing: 0 }}>
                                  By {article.author}
                                </span>
                              ) : null}
                              {article.story_id ? (
                                <span
                                  className="panel-chip muted"
                                  style={{ textTransform: 'none', letterSpacing: 0 }}
                                  title="Syndication group: articles whose bodies are near-identical share one story group"
                                >
                                  <Layers size={11} style={{ marginRight: 4 }} /> Story #{article.story_id}
                                </span>
                              ) : null}
                              {article.verified ? <span className="badge positive">Verified source</span> : null}
                            </div>

                            <p className="article-summary">
                              {article.text ? `${article.text.substring(0, 400)}...` : 'No text captured.'}
                            </p>

                            <div className="article-row-details-actions">
                              <a href={article.url} target="_blank" rel="noopener noreferrer" className="btn-secondary" style={{ textDecoration: 'none' }}>
                                <ExternalLink size={13} /> Open original
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
                          <span className="panel-chip muted" style={{ textTransform: 'none', letterSpacing: 0 }} title="When the pipeline scraped this article">
                            <Calendar size={11} style={{ marginRight: 4 }} /> Scraped: {scrapedAtLabel(article.fetched_at)}
                          </span>
                          {article.story_id ? (
                            <span
                              className="panel-chip muted"
                              style={{ textTransform: 'none', letterSpacing: 0 }}
                              title="Syndication group: articles whose bodies are near-identical share one story group"
                            >
                              <Layers size={11} style={{ marginRight: 4 }} /> Story #{article.story_id}
                            </span>
                          ) : null}
                          {article.verified ? <span className="badge positive">Verified source</span> : null}
                        </div>
                      </div>

                      <h3 className="article-title">
                        <a href={article.url} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>
                          {article.title || 'Untitled article'} <ExternalLink size={14} style={{ opacity: 0.5 }} />
                        </a>
                      </h3>

                      <p className="article-summary">
                        {article.text ? `${article.text.substring(0, 220)}...` : 'No text captured.'}
                      </p>

                      <div className="article-footer">
                        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <Calendar size={14} /> {articleDate(article.published)}
                        </span>
                        <span>{article.source || 'Unknown source'}</span>
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
                  <strong>No articles found</strong>
                  <span>Try adjusting your search, source, date range, or project filters.</span>
                </div>
              </div>
            )}
          </>
        )}

        {!isInitialLoading && articles.length > 0 && (
          <div className="articles-pagination" role="navigation" aria-label="Articles pagination">
            <button className="btn-secondary" onClick={() => setOffset((prev) => Math.max(0, prev - limit))} disabled={!hasPrev || loading}>
              <ChevronLeft size={16} /> Previous
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
                  {page}
                </button>
              )
            )}
            <button className="btn-secondary" onClick={() => setOffset((prev) => prev + limit)} disabled={!hasNext || loading}>
              Next <ChevronRight size={16} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
