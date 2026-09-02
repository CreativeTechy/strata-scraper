import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  LayoutDashboard,
  FolderKanban,
  RefreshCw,
  FileText,
  Rss,
  Users,
  TrendingUp,
  AlertTriangle,
  CheckCircle2,
  ShieldAlert,
  History,
  ChevronLeft,
  ChevronRight,
  Globe2,
  Search,
  AtSign,
  MessageCircle,
  Send,
  Link2,
  PackageOpen,
  Layers3,
} from 'lucide-react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
} from 'recharts';
import '../styles/Dashboard.css';

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function RunsChart({ runs }) {
  if (!runs.length) {
    return (
      <div className="admin-empty-state">
        <div className="admin-empty-state-icon">
          <TrendingUp size={20} />
        </div>
        <strong>No pipeline runs yet</strong>
        <p>Once a scrape runs for this project, its article counts will chart here.</p>
      </div>
    );
  }

  const data = runs.map((run) => ({
    label: run.sequence_number ? `#${run.sequence_number}` : formatDateTime(run.created_at),
    when: formatDateTime(run.created_at),
    articles: run.articles_saved || 0,
  }));

  return (
    <div className="dashboard-chart-wrap">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: -12 }}>
          <CartesianGrid stroke="rgba(15, 23, 42, 0.08)" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 12, fill: 'var(--text-light)' }} axisLine={false} tickLine={false} />
          <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: 'var(--text-light)' }} axisLine={false} tickLine={false} width={36} />
          <Tooltip
            formatter={(value) => [value, 'Articles saved']}
            labelFormatter={(label, payload) => payload?.[0]?.payload?.when || label}
            contentStyle={{ borderRadius: 12, border: '1px solid var(--border-soft)' }}
          />
          <Line type="monotone" dataKey="articles" stroke="var(--secondary-color)" strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

const SOURCE_PAGE_SIZE = 5;
const ATTENTION_PAGE_SIZE = 1;

const PLATFORM_ICONS = {
  rss: Rss,
  web: Globe2,
  keyword: Search,
  twitter: AtSign,
  reddit: MessageCircle,
  telegram: Send,
  linkedin: Link2,
  other: PackageOpen,
};

function PlatformBreakdown({ items, totalArticles }) {
  if (!items.length) {
    return (
      <div className="admin-empty-state">
        <div className="admin-empty-state-icon">
          <Layers3 size={20} />
        </div>
        <strong>No platform data yet</strong>
        <p>Platform totals will appear once sources are configured.</p>
      </div>
    );
  }

  const total = Math.max(0, Number(totalArticles) || 0);

  return (
    <div className="dashboard-platform-grid">
      {items.map((item) => {
        const Icon = PLATFORM_ICONS[item.platform] || Layers3;
        const count = Math.max(0, Number(item.count) || 0);
        const sourceCount = Math.max(0, Number(item.source_count) || 0);
        const share = total > 0 ? (count / total) * 100 : 0;
        const shareLabel = share > 0 && share < 0.1 ? '<0.1%' : `${share.toFixed(1)}%`;

        return (
          <div className="dashboard-platform-card" key={item.platform}>
            <div className="dashboard-platform-card-top">
              <span className="dashboard-platform-icon" aria-hidden="true">
                <Icon size={17} />
              </span>
              <span className="dashboard-platform-share">{shareLabel}</span>
            </div>
            <span className="dashboard-platform-name">{item.label || item.platform}</span>
            <strong className="dashboard-platform-count">{count.toLocaleString()}</strong>
            <span className="dashboard-platform-meta">
              {sourceCount.toLocaleString()} configured source{sourceCount === 1 ? '' : 's'}
            </span>
            <div className="dashboard-platform-track" aria-label={`${shareLabel} of project articles`}>
              <span style={{ width: `${Math.min(100, share)}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SourceBreakdown({ items }) {
  const [page, setPage] = useState(0);

  if (!items.length) {
    return (
      <div className="admin-empty-state">
        <div className="admin-empty-state-icon">
          <Rss size={20} />
        </div>
        <strong>Nothing collected yet</strong>
        <p>Articles will be broken down by source here once a scrape completes.</p>
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil(items.length / SOURCE_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const start = currentPage * SOURCE_PAGE_SIZE;
  const pageItems = items.slice(start, start + SOURCE_PAGE_SIZE);
  const max = Math.max(...items.map((item) => item.count), 1);

  return (
    <div className="dashboard-source-list">
      {pageItems.map((item) => (
        <div className="dashboard-source-row" key={item.source}>
          <div className="dashboard-source-row-label">
            <span className="dashboard-source-row-name">{item.source || 'unknown'}</span>
            <span className="dashboard-source-row-count">{item.count.toLocaleString()}</span>
          </div>
          <div className="report-insight-track">
            <div
              className="report-insight-fill"
              style={{
                width: `${Math.max(4, Math.round((item.count / max) * 100))}%`,
                background: 'linear-gradient(90deg, var(--secondary-color), var(--primary-color))',
              }}
            />
          </div>
        </div>
      ))}
      {totalPages > 1 ? (
        <div className="dashboard-source-pagination" role="navigation" aria-label="Articles by source pagination">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setPage((prev) => Math.max(0, prev - 1))}
            disabled={currentPage === 0}
          >
            <ChevronLeft size={14} /> Prev
          </button>
          <span className="dashboard-source-pagination-label">
            Page {currentPage + 1} of {totalPages}
          </span>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setPage((prev) => Math.min(totalPages - 1, prev + 1))}
            disabled={currentPage >= totalPages - 1}
          >
            Next <ChevronRight size={14} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function AttentionList({ items, healthyLabel, renderItem, pageSize = 0, paginationLabel = 'Attention list pagination' }) {
  const [page, setPage] = useState(0);

  if (!items.length) {
    return (
      <div className="admin-empty-state">
        <div className="admin-empty-state-icon" style={{ background: 'rgba(46, 213, 115, 0.14)', color: '#1a7f4e' }}>
          <CheckCircle2 size={20} />
        </div>
        <strong>{healthyLabel}</strong>
      </div>
    );
  }

  const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(items.length / pageSize)) : 1;
  const currentPage = Math.min(page, totalPages - 1);
  const pageItems = pageSize > 0
    ? items.slice(currentPage * pageSize, (currentPage + 1) * pageSize)
    : items;

  return (
    <div className="dashboard-attention-list">
      <div className="report-insight-list">{pageItems.map(renderItem)}</div>
      {totalPages > 1 ? (
        <div className="dashboard-source-pagination" role="navigation" aria-label={paginationLabel}>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setPage((prev) => Math.max(0, prev - 1))}
            disabled={currentPage === 0}
          >
            <ChevronLeft size={14} /> Prev
          </button>
          <span className="dashboard-source-pagination-label">
            Page {currentPage + 1} of {totalPages}
          </span>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setPage((prev) => Math.min(totalPages - 1, prev + 1))}
            disabled={currentPage >= totalPages - 1}
          >
            Next <ChevronRight size={14} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default function DashboardPage({ projects = [], projectId = null }) {
  const [selectedId, setSelectedId] = useState(() => {
    if (projectId != null) return Number(projectId);
    return projects[0]?.id != null ? Number(projects[0].id) : null;
  });
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (selectedId != null) return;
    const fallback = projectId != null ? Number(projectId) : projects[0]?.id != null ? Number(projects[0].id) : null;
    if (fallback != null) setSelectedId(fallback);
  }, [projects, projectId, selectedId]);

  useEffect(() => {
    const stillExists = projects.some((project) => Number(project.id) === Number(selectedId));
    if (selectedId != null && !stillExists && projects.length) {
      setSelectedId(Number(projects[0].id));
    }
  }, [projects, selectedId]);

  const loadSummary = async (id) => {
    if (id == null) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/dashboard/summary?project_id=${id}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to load dashboard data.');
      setSummary(data);
    } catch (err) {
      setError(err.message || 'Failed to load dashboard data.');
      setSummary(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSummary(selectedId);
  }, [selectedId]);

  const selectedProject = useMemo(
    () => projects.find((project) => Number(project.id) === Number(selectedId)) || null,
    [projects, selectedId]
  );

  const isCompetitorMode = (summary?.project?.mode || selectedProject?.mode) === 'competitor';

  return (
    <div className="content-shell">
      <div className="report-header">
        <div className="report-header-top">
          <div className="report-heading">
            <span className="report-kicker">
              <LayoutDashboard size={13} /> Dashboard
            </span>
            <h2 className="report-title">Overview</h2>
            <p className="subtitle">
              Collection health for one project at a time - pick a project to see what it has gathered and what needs a look.
            </p>
          </div>

          <div className="report-header-actions">
            <div className="report-project-control">
              <label className="report-project-control-label" htmlFor="dashboard-project-select">
                <FolderKanban size={13} /> Project
              </label>
              <div className="report-project-select-wrap">
                <FolderKanban size={16} aria-hidden="true" />
                <select
                  id="dashboard-project-select"
                  className="filter-select report-project-select"
                  value={selectedId ?? ''}
                  onChange={(e) => setSelectedId(e.target.value ? Number(e.target.value) : null)}
                  aria-label="Project"
                  disabled={!projects.length}
                >
                  {!projects.length ? <option value="">No projects yet</option> : null}
                  {projects.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} ({item.mode === 'competitor' ? 'competitor' : 'opinion'})
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <button
              type="button"
              className="btn-secondary report-refresh-btn"
              onClick={() => loadSummary(selectedId)}
              disabled={loading || selectedId == null}
            >
              <RefreshCw size={15} className={loading ? 'spin' : ''} /> Refresh
            </button>
          </div>
        </div>
      </div>

      {!projects.length ? (
        <div className="glass-card admin-empty-state">
          <div className="admin-empty-state-icon">
            <FolderKanban size={20} />
          </div>
          <strong>No projects yet</strong>
          <p>Create a project to start collecting, then its metrics will show up here.</p>
          <Link to="/projects" className="btn-secondary">Go to Projects</Link>
        </div>
      ) : error ? (
        <div className="glass-card admin-empty-state report-error-state">
          <div className="admin-empty-state-icon">
            <AlertTriangle size={20} />
          </div>
          <strong>Couldn't load this project's dashboard</strong>
          <p>{error}</p>
        </div>
      ) : (
        <div className="report-body">
          <div className="admin-stats-grid dashboard-stats-grid">
            <div className="admin-stat-card">
              <div className="admin-stat-icon">
                <FileText size={18} />
              </div>
              <div>
                <span>Total articles</span>
                <strong>{loading && !summary ? '-' : (summary?.totals?.articles ?? 0).toLocaleString()}</strong>
              </div>
            </div>
            <div className="admin-stat-card">
              <div className="admin-stat-icon" style={{ background: 'rgba(46, 134, 222, 0.12)', color: 'var(--secondary-color)' }}>
                <Rss size={18} />
              </div>
              <div>
                <span>Total sources</span>
                <strong>{loading && !summary ? '-' : (summary?.totals?.sources ?? 0).toLocaleString()}</strong>
              </div>
            </div>
            <div className="admin-stat-card">
              <div className="admin-stat-icon" style={{ background: 'rgba(46, 213, 115, 0.12)', color: '#2ed573' }}>
                <History size={18} />
              </div>
              <div>
                <span>Total pipeline runs</span>
                <strong>{loading && !summary ? '-' : (summary?.totals?.runs ?? 0).toLocaleString()}</strong>
              </div>
            </div>
            {isCompetitorMode ? (
              <div className="admin-stat-card">
                <div className="admin-stat-icon" style={{ background: 'rgba(255, 159, 67, 0.14)', color: 'var(--primary-color)' }}>
                  <Users size={18} />
                </div>
                <div>
                  <span>Competitors tracked</span>
                  <strong>{loading && !summary ? '-' : (summary?.totals?.competitors ?? 0).toLocaleString()}</strong>
                </div>
              </div>
            ) : null}
          </div>

          <div className="glass-card report-section">
            <div className="report-section-header">
              <div className="report-section-heading">
                <span className="report-section-icon">
                  <TrendingUp size={16} />
                </span>
                <h3 className="report-section-title">Articles per pipeline run</h3>
              </div>
              <p className="report-section-caption">How many articles each scrape run saved, oldest to most recent.</p>
            </div>
            <RunsChart runs={summary?.runs || []} />
          </div>

          <div className="glass-card report-section">
            <div className="report-section-header">
              <div className="report-section-heading">
                <span className="report-section-icon">
                  <Layers3 size={16} />
                </span>
                <h3 className="report-section-title">Articles by platform</h3>
              </div>
              <p className="report-section-caption">
                How each configured collection platform contributes to this project's articles.
              </p>
            </div>
            <PlatformBreakdown
              items={summary?.articles_by_platform || []}
              totalArticles={summary?.totals?.articles || 0}
            />
          </div>

          <div className="report-section-row dashboard-paired-row">
            <div className="glass-card report-section">
              <div className="report-section-header">
                <div className="report-section-heading">
                  <span className="report-section-icon">
                    <Rss size={16} />
                  </span>
                  <h3 className="report-section-title">Articles by source</h3>
                </div>
                <p className="report-section-caption">Which sources have contributed the most articles.</p>
              </div>
              <SourceBreakdown items={summary?.articles_by_source || []} key={selectedId} />
            </div>

            <div className="glass-card report-section">
              <div className="report-section-header">
                <div className="report-section-heading">
                  <span className="report-section-icon" style={{ background: 'rgba(255, 71, 87, 0.14)', color: '#b42318' }}>
                    <ShieldAlert size={16} />
                  </span>
                  <h3 className="report-section-title">Sources needing attention</h3>
                </div>
                <p className="report-section-caption">Sources that were blocked, errored, or returned nothing on the last run.</p>
              </div>
              <AttentionList
                key={selectedId}
                items={summary?.sources_needing_attention || []}
                healthyLabel="All sources came back healthy on the last run"
                pageSize={ATTENTION_PAGE_SIZE}
                paginationLabel="Sources needing attention pagination"
                renderItem={(item) => {
                  const issue = item.issue || {
                    title: 'Source needs attention',
                    message: item.reason,
                    action: 'Review the source configuration and try again.',
                    severity: 'warning',
                    technical_detail: item.reason,
                  };
                  return (
                  <div className={`report-insight-card ${issue.severity === 'error' ? 'tone-negative' : 'tone-warning'}`} key={item.source_url || item.source}>
                    <div className="report-insight-card-top">
                      <div className="report-insight-card-copy">
                        <p className="report-insight-card-text">{item.source}</p>
                        <strong className="dashboard-attention-title">{issue.title}</strong>
                        <span className="dashboard-attention-reason">{issue.message}</span>
                        <span className="dashboard-attention-action">{issue.action}</span>
                        <div className="dashboard-attention-controls">
                          <Link className="dashboard-attention-link" to="/sources">Review sources</Link>
                          {issue.technical_detail ? (
                            <details className="dashboard-attention-details">
                              <summary>Technical details</summary>
                              <p>{issue.technical_detail}</p>
                            </details>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </div>
                  );
                }}
              />
            </div>
          </div>

          {isCompetitorMode ? (
            <div className="glass-card report-section">
              <div className="report-section-header">
                <div className="report-section-heading">
                  <span className="report-section-icon" style={{ background: 'rgba(255, 71, 87, 0.14)', color: '#b42318' }}>
                    <ShieldAlert size={16} />
                  </span>
                  <h3 className="report-section-title">Competitors needing attention</h3>
                </div>
                <p className="report-section-caption">Tracked competitors whose linked sources failed or returned 0 articles on the last run.</p>
              </div>
              <AttentionList
                items={summary?.competitors_needing_attention || []}
                healthyLabel="All tracked competitors' sources came back healthy on the last run"
                renderItem={(competitor) => (
                  <div className="report-insight-card tone-negative" key={competitor.id}>
                    <div className="report-insight-card-top">
                      <div className="report-insight-card-copy">
                        <p className="report-insight-card-text">{competitor.name}</p>
                        <div className="report-insight-card-tags">
                          {competitor.sources.map((source, index) => (
                            <span className="report-insight-card-tag muted" key={`${competitor.id}-${index}`}>
                              {source.platform}: {source.issue?.title || source.reason}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
