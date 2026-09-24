import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Database,
  Loader2,
  ChevronDown,
  ChevronRight,
  ShieldAlert,
  CircleAlert,
  CircleCheck,
  Rss,
  Filter,
  Save,
  Download,
  ExternalLink,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ErrorNotice from './ErrorNotice';
import ConfirmModal from './ConfirmModal';
import { apiError, apiErrorFromResponse } from '../errors/apiError.js';
import { friendlyRunMessage } from '../errors/userFacingError.js';
import { formatDateTime, formatDuration, formatNumber } from '../i18n/format.js';
import i18n from '../i18n/index.js';
import { translateFetchNote, translateSourceIssue } from '../lib/sourceIssue.js';

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
  if (status === 'cancelled') return '#9aa0aa';
  return '#9aa0aa';
}

function formatWhen(iso) {
  return formatDateTime(iso, undefined, '—');
}

function formatElapsedMs(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  // Sub-second stages (cleaning is often just in-memory filtering) are real,
  // measured durations - round-tripping through whole seconds would show "0s".
  if (ms < 1000) return formatNumber(Math.round(ms), { style: 'unit', unit: 'millisecond', unitDisplay: 'short' });
  return formatDuration(ms / 1000);
}

// Returns { text, inProgress } describing the span between two timestamps.
// Still in progress (endIso missing but startIso present) counts elapsed time against now.
function stageDuration(startIso, endIso) {
  if (!startIso) return { text: '—', inProgress: false };
  const start = new Date(startIso).getTime();
  if (!Number.isFinite(start)) return { text: '—', inProgress: false };
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const text = formatElapsedMs(end - start);
  return { text: text || '—', inProgress: !endIso };
}

function projectNameForRun(run, projectsById) {
  if (!run) return '';
  if (run.project_name) return run.project_name;
  const project = projectsById.get(Number(run.project_id));
  if (project?.name) return project.name;
  return run.project_id != null
    ? i18n.t('pipeline:projectNumber', { id: run.project_id })
    : i18n.t('pipeline:unassigned');
}

// Scraping, validating, and saving all happen interleaved within a single
// crawl (see backend/scraper/pipelines.py's StreamingCollectPipeline) - one
// source can finish while another is still being fetched, so a separate
// clean start-finish timestamp for the whole run means nothing distinct from
// the scrape span itself.
const STAGE_ROWS = [
  { key: 'scrape', labelKey: 'detail.stageRows.scrape', startField: 'scrape_started_at', endField: 'scrape_finished_at', Icon: Rss },
];

const TOTAL_STATS = [
  { key: 'articles_scraped', labelKey: 'detail.totals.scraped', Icon: Rss, tint: 'rgba(255, 159, 67, 0.14)', color: 'var(--primary-color)' },
  { key: 'articles_cleaned', labelKey: 'detail.totals.cleaned', Icon: Filter, tint: 'rgba(46, 134, 222, 0.14)', color: '#2e86de' },
  { key: 'articles_saved', labelKey: 'detail.totals.saved', Icon: Save, tint: 'rgba(46, 213, 115, 0.14)', color: '#2ed573' },
];

// Anchor target for a source row: prefer the real configured URL recorded
// during this run's fetch diagnostics; fall back to the source name only
// when it happens to already be a URL (legacy rows predating source_url).
function sourceHref(row) {
  if (row.source_url) return row.source_url;
  if (typeof row.source === 'string' && /^https?:\/\//i.test(row.source)) return row.source;
  return null;
}

const SOURCE_COLUMNS = [
  { key: 'scraped', labelKey: 'detail.columns.scraped' },
  { key: 'duplicate', labelKey: 'detail.columns.duplicate' },
  { key: 'content_filtered', labelKey: 'detail.columns.contentFiltered' },
  { key: 'date_filtered', labelKey: 'detail.columns.dateFiltered' },
  { key: 'skipped_existing', labelKey: 'detail.columns.alreadyScraped' },
  { key: 'kept', labelKey: 'detail.columns.kept' },
  { key: 'saved', labelKey: 'detail.columns.saved' },
];

// A source's fetch-status badge, distinct from the "Content filtered" column
// above (that one counts articles content_guard rejected AFTER a successful
// fetch - this is about whether the source's own page could be reached at
// all this run). See backend/services/pipeline/source_diagnostics.py.
// `issue` is the row's already-translated issue (see translateSourceIssue).
function sourceStatusBadge(source, issue) {
  if (issue) {
    return {
      label: issue.title,
      color: issue.severity === 'error' ? '#ff4757' : '#ffb13b',
      Icon: issue.severity === 'error' ? ShieldAlert : CircleAlert,
    };
  }
  if (source.network_blocked) {
    return { label: i18n.t('pipeline:detail.badges.blocked', { status: source.http_status ?? '?' }), color: '#ff4757', Icon: ShieldAlert };
  }
  if (source.http_status) {
    return { label: i18n.t('pipeline:detail.badges.http', { status: source.http_status }), color: '#ff4757', Icon: CircleAlert };
  }
  if (source.fetch_note) {
    return { label: i18n.t('pipeline:detail.badges.issue'), color: '#ffb13b', Icon: CircleAlert };
  }
  return { label: i18n.t('pipeline:detail.badges.ok'), color: '#2ed573', Icon: CircleCheck };
}

function StatusBadge({ status }) {
  const color = stageColor(status);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '4px 12px',
        borderRadius: 999,
        background: `${color}1f`,
        color,
        fontWeight: 700,
        textTransform: 'uppercase',
        fontSize: '0.75rem',
        letterSpacing: '0.03em',
      }}
    >
      {statusLabel(status)}
    </span>
  );
}

function SummaryField({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-light)', marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontSize: '0.9rem', color: 'var(--text-dark)', wordBreak: 'break-word' }}>{children}</div>
    </div>
  );
}

export default function PipelineRunDetailPage({ projects = [] }) {
  const { t } = useTranslation('pipeline');
  const { runId } = useParams();
  const [run, setRun] = useState(null);
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedSources, setExpandedSources] = useState(() => new Set());
  const [showExportConfirm, setShowExportConfirm] = useState(false);
  const [exportingArticles, setExportingArticles] = useState(false);
  const [exportError, setExportError] = useState('');

  const projectsById = useMemo(() => {
    const map = new Map();
    projects.forEach((project) => map.set(Number(project.id), project));
    return map;
  }, [projects]);

  useEffect(() => {
    if (!runId) return undefined;

    let cancelled = false;
    let intervalId = null;

    const load = ({ showLoading = false } = {}) => {
      if (showLoading) {
        setLoading(true);
        setError('');
      }
      return fetch(`/api/pipeline-runs/${runId}`)
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw apiError(data, { status: res.status, fallback: i18n.t('pipeline:errors.loadRunFailed') });
          if (cancelled) return null;
          setRun(data?.run || null);
          setSources(Array.isArray(data?.sources) ? data.sources : []);
          return data?.run || null;
        })
        .catch((err) => {
          if (!cancelled) setError(err?.message ? err : i18n.t('pipeline:errors.loadRunFailed'));
          return null;
        })
        .finally(() => {
          if (!cancelled && showLoading) setLoading(false);
        });
    };

    setRun(null);
    setSources([]);
    load({ showLoading: true }).then((loadedRun) => {
      if (cancelled) return;
      const status = (loadedRun?.status || '').toLowerCase();
      if (status !== 'queued' && status !== 'running') return;
      // Per-source rows fill in live while the run is active (see
      // backend/scraper/pipelines.py's StreamingCollectPipeline) - poll until
      // the run reaches a terminal status instead of leaving this static.
      intervalId = setInterval(() => {
        load().then((polledRun) => {
          const polledStatus = (polledRun?.status || '').toLowerCase();
          if (polledRun && polledStatus !== 'queued' && polledStatus !== 'running' && intervalId) {
            clearInterval(intervalId);
            intervalId = null;
          }
        });
      }, 3000);
    });

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, [runId]);

  const handleExportRunArticles = async () => {
    if (exportingArticles || !runId) return;
    setExportingArticles(true);
    setExportError('');
    try {
      const res = await fetch(`/api/articles/export?pipeline_run_id=${encodeURIComponent(runId)}`);
      if (!res.ok) {
        throw await apiErrorFromResponse(res, t('errors.exportFailed'));
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      anchor.href = objectUrl;
      anchor.download = `pipeline-run-${runId}-articles-${timestamp}.jsonl`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      setExportError(err?.message ? err : t('errors.exportFailed'));
    } finally {
      setExportingArticles(false);
    }
  };

  const toggleSource = (key) => {
    setExpandedSources((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const total = run ? stageDuration(run.started_at, run.finished_at) : null;
  const projectName = projectNameForRun(run, projectsById);
  const sourceIssueCount = sources.filter((source) => source.issue).length;
  const hasVerboseSourceSummary = sourceIssueCount > 0 && /source\(s\) had fetch issues:/i.test(run?.message || '');
  // The backend's run message is English free text; friendlyRunMessage turns
  // it into a translated summary, and the original stays one click away.
  const displayMessage = hasVerboseSourceSummary
    ? t('detail.completeWithIssues', { count: sourceIssueCount, formatted: formatNumber(sourceIssueCount) })
    : run?.message
      ? friendlyRunMessage(run)
      : '';
  const showOriginalMessage = Boolean(run?.message) && displayMessage !== run.message;
  const articlesSaved = run?.articles_saved || 0;

  return (
    <div className="admin-page-shell">
      <div className="admin-page-header">
        <div>
          <div className="admin-page-kicker">
            <Database size={14} /> {t('history')}
          </div>
          <h1 className="admin-page-title">{t('detail.title')}</h1>
          {projectName ? <p className="admin-page-subtitle" dir="auto">{projectName}</p> : null}
        </div>
        <div className="admin-page-toolbar">
          <Link to="/pipeline-runs" className="btn-secondary" style={{ textDecoration: 'none' }}>
            <ArrowLeft size={16} className="icon-flip-rtl" /> {t('detail.backToRuns')}
          </Link>
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-light)', padding: '24px 0' }}>
          <Loader2 size={18} className="spin" /> {t('detail.loading')}
        </div>
      ) : error ? (
        <ErrorNotice error={error} context={t('errorContext.loadRun')} />
      ) : !run ? null : (
        <>
          <ErrorNotice error={exportError} context={t('errorContext.exportRunArticles')} onDismiss={() => setExportError('')} />

          <div className="admin-stats-grid">
            {TOTAL_STATS.map(({ key, labelKey, Icon, tint, color }) => (
              <div className="admin-stat-card" key={key}>
                <div className="admin-stat-icon" style={{ background: tint, color }}>
                  <Icon size={18} />
                </div>
                <div>
                  <span>{t(labelKey)}</span>
                  <strong>{formatNumber(run[key] || 0)}</strong>
                </div>
              </div>
            ))}
            <button
              type="button"
              className="admin-stat-card admin-stat-action-card"
              onClick={() => setShowExportConfirm(true)}
              disabled={exportingArticles || !run.articles_saved}
              title={run.articles_saved ? t('detail.export.downloadTitle') : t('detail.export.noneSaved')}
              style={{ textAlign: 'start', width: '100%', font: 'inherit', color: 'inherit' }}
            >
              <div className="admin-stat-icon" style={{ background: 'rgba(249, 115, 22, 0.14)', color: 'var(--primary-color)' }}>
                {exportingArticles ? <Loader2 size={18} className="spin" /> : <Download size={18} />}
              </div>
              <div>
                <span>{exportingArticles ? t('detail.export.exporting') : t('detail.export.label')}</span>
                <strong>{formatNumber(articlesSaved)}</strong>
                <span className="admin-stat-action-hint">{t('detail.export.hint')}</span>
              </div>
              <ChevronRight size={16} className="admin-stat-action-arrow icon-flip-rtl" />
            </button>
          </div>

          <div className="glass-card" style={{ marginBottom: 18 }}>
            <div className="run-detail-summary-grid">
              <SummaryField label={t('detail.summary.project')}><bdi>{projectName}</bdi></SummaryField>
              <SummaryField label={t('detail.summary.status')}>
                <StatusBadge status={run.status} />
              </SummaryField>
              <SummaryField label={t('detail.summary.stage')}>{prettyStage(run.stage)}</SummaryField>
              <SummaryField label={t('detail.summary.startedAt')}>{formatWhen(run.started_at)}</SummaryField>
              <SummaryField label={t('detail.summary.finishedAt')}>{formatWhen(run.finished_at)}</SummaryField>
              <SummaryField label={t('detail.summary.totalDuration')}>
                {total.inProgress ? t('detail.inProgress', { duration: total.text }) : total.text}
              </SummaryField>
            </div>

            {/* Message/error text can run long (a full sentence, or a
                provider error's raw detail) - kept in their own full-width
                containers below the small-field grid instead of as cells in
                it, so one long value can't stretch or misalign the rest. */}
            {displayMessage ? (
              <div className="run-detail-message-box">
                <div className="run-detail-box-label">{t('detail.message')}</div>
                <div className="run-detail-message-text">{displayMessage}</div>
                {showOriginalMessage ? (
                  <details style={{ marginTop: 8 }}>
                    <summary style={{ cursor: 'pointer', color: 'var(--secondary-color)', fontSize: '0.78rem', fontWeight: 700 }}>
                      {t('detail.originalMessage')}
                    </summary>
                    <div className="run-detail-message-text" dir="auto" style={{ marginTop: 7, color: 'var(--text-light)' }}>{run.message}</div>
                  </details>
                ) : null}
              </div>
            ) : null}

            <ErrorNotice error={run.error} context={t('errorContext.completeRun')} compact />
          </div>

          <div className="glass-card" style={{ marginBottom: 18 }}>
            <h3 className="run-detail-section-title">{t('detail.timing')}</h3>
            {!run.has_detail ? (
              <div className="run-detail-fallback">{t('detail.legacyTiming')}</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {STAGE_ROWS.map(({ key, labelKey, startField, endField, Icon }) => {
                  const duration = stageDuration(run[startField], run[endField]);
                  return (
                    <div
                      key={key}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '10px 14px',
                        borderRadius: 12,
                        background: 'rgba(0,0,0,0.03)',
                      }}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.85rem', fontWeight: 600 }}>
                        <Icon size={15} style={{ color: 'var(--primary-color)' }} /> {t(labelKey)}
                      </span>
                      <span style={{ fontSize: '0.85rem', color: 'var(--text-light)', fontWeight: duration.inProgress ? 700 : 400 }}>
                        {duration.inProgress ? t('detail.inProgress', { duration: duration.text }) : duration.text}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="glass-card">
            <h3 className="run-detail-section-title">{t('detail.perSource')}</h3>
            {!run.has_detail ? (
              <div className="run-detail-fallback">{t('detail.legacySources')}</div>
            ) : sources.length === 0 ? (
              <div className="run-detail-fallback">{t('detail.noSourceData')}</div>
            ) : (
              <div className="table-scroll">
                <table className="run-detail-source-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                  <thead>
                    <tr style={{ textAlign: 'start', background: 'var(--glass-bg)' }}>
                      <th style={{ padding: '8px 10px', width: 28 }} />
                      <th style={{ padding: '8px 10px' }}>{t('detail.columns.source')}</th>
                      <th style={{ padding: '8px 10px' }}>{t('detail.columns.fetchStatus')}</th>
                      {SOURCE_COLUMNS.map((col) => (
                        <th key={col.key} style={{ padding: '8px 10px', textAlign: 'end' }}>
                          {t(col.labelKey)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sources.map((row) => {
                      const key = row.source;
                      const isExpanded = expandedSources.has(key);
                      const issue = translateSourceIssue(row.issue);
                      const issueDir = issue?.untranslated ? 'auto' : undefined;
                      const badge = sourceStatusBadge(row, issue);
                      const translatedNote = issue ? null : translateFetchNote(row.fetch_note);
                      const hasDetails = Boolean(row.fetch_note);
                      const href = sourceHref(row);
                      const showNameSeparately = href && row.source && row.source !== href;
                      return (
                        <Fragment key={key}>
                          <tr style={{ borderTop: '1px solid rgba(0,0,0,0.06)' }}>
                            <td style={{ padding: '8px 10px' }}>
                              {hasDetails ? (
                                <button
                                  type="button"
                                  onClick={() => toggleSource(key)}
                                  aria-label={isExpanded ? t('detail.collapseDetails') : t('detail.expandDetails')}
                                  style={{
                                    background: 'none',
                                    border: 'none',
                                    cursor: 'pointer',
                                    padding: 0,
                                    display: 'flex',
                                    alignItems: 'center',
                                    color: 'var(--text-light)',
                                  }}
                                >
                                  {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} className="icon-flip-rtl" />}
                                </button>
                              ) : null}
                            </td>
                            <td style={{ padding: '8px 10px', wordBreak: 'break-word', maxWidth: 280 }}>
                              {showNameSeparately ? (
                                <div style={{ fontWeight: 600, marginBottom: 2 }} dir="auto">{row.source}</div>
                              ) : null}
                              {href ? (
                                <a
                                  href={href}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title={t('detail.visit', { url: href })}
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'flex-start',
                                    gap: 4,
                                    color: 'var(--primary-color)',
                                    textDecoration: 'none',
                                    fontWeight: showNameSeparately ? 400 : 600,
                                    wordBreak: 'break-all',
                                  }}
                                >
                                  <span className="ltr-isolate">{href}</span>
                                  <ExternalLink size={11} style={{ flexShrink: 0, marginTop: 2 }} />
                                </a>
                              ) : (
                                <bdi>{row.source}</bdi>
                              )}
                            </td>
                            <td style={{ padding: '8px 10px' }}>
                              <span
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 4,
                                  padding: '3px 9px',
                                  borderRadius: 999,
                                  background: `${badge.color}1f`,
                                  color: badge.color,
                                  fontWeight: 600,
                                  fontSize: '0.75rem',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                <badge.Icon size={13} /> <span dir={issueDir}>{badge.label}</span>
                              </span>
                            </td>
                            {SOURCE_COLUMNS.map((col) => (
                              <td key={col.key} style={{ padding: '8px 10px', textAlign: 'end' }}>
                                {formatNumber(row[col.key] ?? 0)}
                              </td>
                            ))}
                          </tr>
                          {isExpanded && hasDetails ? (
                            <tr style={{ background: 'rgba(0,0,0,0.02)' }}>
                              <td />
                              <td colSpan={SOURCE_COLUMNS.length + 2} style={{ padding: '8px 10px 12px', fontSize: '0.8rem', color: 'var(--text-dark)' }}>
                                {issue ? (
                                  <div style={{ display: 'grid', gap: 5 }}>
                                    <strong dir={issueDir}>{issue.title}</strong>
                                    <span dir={issueDir}>{issue.message}</span>
                                    <span style={{ color: 'var(--text-light)' }} dir={issueDir}>{issue.action}</span>
                                    {issue.technical_detail ? (
                                      <details style={{ marginTop: 3 }}>
                                        <summary style={{ cursor: 'pointer', color: 'var(--secondary-color)', fontWeight: 700 }}>{t('common:errors.technicalDetails')}</summary>
                                        <div dir="ltr" style={{ marginTop: 6, overflowWrap: 'anywhere', color: 'var(--text-light)' }}>{issue.technical_detail}</div>
                                      </details>
                                    ) : null}
                                  </div>
                                ) : translatedNote ? (
                                  <div style={{ display: 'grid', gap: 5 }}>
                                    <span>{translatedNote}</span>
                                    <details style={{ marginTop: 3 }}>
                                      <summary style={{ cursor: 'pointer', color: 'var(--secondary-color)', fontWeight: 700 }}>{t('common:errors.technicalDetails')}</summary>
                                      <div dir="ltr" style={{ marginTop: 6, overflowWrap: 'anywhere', color: 'var(--text-light)' }}>{row.fetch_note}</div>
                                    </details>
                                  </div>
                                ) : (
                                  <span dir="auto">{row.fetch_note}</span>
                                )}
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      <ConfirmModal
        open={showExportConfirm}
        title={t('detail.export.confirmTitle')}
        message={t('detail.export.confirmMessage', { count: articlesSaved, formatted: formatNumber(articlesSaved) })}
        confirmLabel={exportingArticles ? t('detail.export.exporting') : t('detail.export.confirm')}
        cancelLabel={t('common:actions.cancel')}
        confirmDisabled={exportingArticles}
        onClose={() => {
          if (!exportingArticles) setShowExportConfirm(false);
        }}
        onConfirm={async () => {
          if (exportingArticles) return;
          setShowExportConfirm(false);
          await handleExportRunArticles();
        }}
      />
    </div>
  );
}
