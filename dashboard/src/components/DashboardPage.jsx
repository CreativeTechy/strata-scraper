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
  CheckCircle2,
  ShieldAlert,
  History,
  ChevronLeft,
  ChevronRight,
  Globe2,
  Search,
  Feather,
  MessagesSquare,
  Send,
  Briefcase,
  AtSign,
  ThumbsUp,
  Camera,
  PackageOpen,
  Layers3,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ErrorNotice from './ErrorNotice';
import { apiError } from '../errors/apiError.js';
import i18n from '../i18n/index.js';
import { formatDateTime, formatNumber, formatPercent, isRtl } from '../i18n/format.js';
import { translateFetchNote, translateSourceIssue } from '../lib/sourceIssue.js';
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

const CHART_DATE_OPTIONS = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };

function RunsChart({ runs }) {
  const { t } = useTranslation('dashboard');
  if (!runs.length) {
    return (
      <div className="admin-empty-state">
        <div className="admin-empty-state-icon">
          <TrendingUp size={20} />
        </div>
        <strong>{t('runsChart.emptyTitle')}</strong>
        <p>{t('runsChart.emptyMessage')}</p>
      </div>
    );
  }

  const data = runs.map((run) => ({
    label: run.sequence_number
      ? t('runsChart.runNumber', { number: run.sequence_number })
      : formatDateTime(run.created_at, CHART_DATE_OPTIONS),
    when: formatDateTime(run.created_at, CHART_DATE_OPTIONS),
    articles: run.articles_saved || 0,
  }));
  // Runs read oldest -> newest in the reading direction, so the time axis
  // (and the value axis beside it) mirror in RTL.
  const rtl = isRtl();

  return (
    <div className="dashboard-chart-wrap">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={rtl ? { top: 8, right: -12, bottom: 0, left: 16 } : { top: 8, right: 16, bottom: 0, left: -12 }}>
          <CartesianGrid stroke="rgba(15, 23, 42, 0.08)" vertical={false} />
          <XAxis dataKey="label" reversed={rtl} tick={{ fontSize: 12, fill: 'var(--text-light)' }} axisLine={false} tickLine={false} />
          <YAxis
            allowDecimals={false}
            orientation={rtl ? 'right' : 'left'}
            tickFormatter={(value) => formatNumber(value)}
            tick={{ fontSize: 12, fill: 'var(--text-light)' }}
            axisLine={false}
            tickLine={false}
            width={36}
          />
          <Tooltip
            formatter={(value) => [formatNumber(value), t('runsChart.articlesSaved')]}
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
  twitter: Feather,
  reddit: MessagesSquare,
  telegram: Send,
  linkedin: Briefcase,
  threads: AtSign,
  facebook: ThumbsUp,
  instagram: Camera,
  other: PackageOpen,
};

function PlatformBreakdown({ items, totalArticles }) {
  const { t } = useTranslation('dashboard');
  const ranked = items
    .filter((item) => (Number(item.count) || 0) > 0)
    .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0));

  if (!ranked.length) {
    return (
      <div className="admin-empty-state">
        <div className="admin-empty-state-icon">
          <Layers3 size={20} />
        </div>
        <strong>{t('platformBreakdown.emptyTitle')}</strong>
        <p>{t('platformBreakdown.emptyMessage')}</p>
      </div>
    );
  }

  const total = Math.max(0, Number(totalArticles) || 0);

  return (
    <div className="dashboard-platform-grid">
      {ranked.map((item) => {
        const Icon = PLATFORM_ICONS[item.platform] || Layers3;
        const count = Math.max(0, Number(item.count) || 0);
        const sourceCount = Math.max(0, Number(item.source_count) || 0);
        const share = total > 0 ? (count / total) * 100 : 0;
        const shareLabel = share > 0 && share < 0.1
          ? t('platformBreakdown.shareBelow', { value: formatPercent(0.001, { maximumFractionDigits: 1 }) })
          : formatPercent(share / 100, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

        return (
          <div className="dashboard-platform-card" key={item.platform}>
            <div className="dashboard-platform-card-top">
              <span className="dashboard-platform-icon" aria-hidden="true">
                <Icon size={17} />
              </span>
              <span className="dashboard-platform-share">{shareLabel}</span>
            </div>
            <span className="dashboard-platform-name">
              {t(`platforms.${item.platform}`, { defaultValue: item.label || item.platform })}
            </span>
            <strong className="dashboard-platform-count">{formatNumber(count)}</strong>
            <span className="dashboard-platform-meta">
              {t('platformBreakdown.configuredSources', { count: sourceCount, formatted: formatNumber(sourceCount) })}
            </span>
            <div className="dashboard-platform-track" aria-label={t('platformBreakdown.shareOfArticles', { share: shareLabel })}>
              <span style={{ width: `${Math.min(100, share)}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SourceBreakdown({ items }) {
  const { t } = useTranslation('dashboard');
  const [page, setPage] = useState(0);

  if (!items.length) {
    return (
      <div className="admin-empty-state">
        <div className="admin-empty-state-icon">
          <Rss size={20} />
        </div>
        <strong>{t('sourceBreakdown.emptyTitle')}</strong>
        <p>{t('sourceBreakdown.emptyMessage')}</p>
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
            <span className="dashboard-source-row-name" dir="auto">{item.source || t('sourceBreakdown.unknownSource')}</span>
            <span className="dashboard-source-row-count">{formatNumber(item.count)}</span>
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
        <div className="dashboard-source-pagination" role="navigation" aria-label={t('sourceBreakdown.paginationLabel')}>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setPage((prev) => Math.max(0, prev - 1))}
            disabled={currentPage === 0}
          >
            <ChevronLeft size={14} className="icon-flip-rtl" /> {t('common:actions.previous')}
          </button>
          <span className="dashboard-source-pagination-label">
            {t('common:pagination.page', { page: formatNumber(currentPage + 1), total: formatNumber(totalPages) })}
          </span>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setPage((prev) => Math.min(totalPages - 1, prev + 1))}
            disabled={currentPage >= totalPages - 1}
          >
            {t('common:actions.next')} <ChevronRight size={14} className="icon-flip-rtl" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function AttentionList({ items, healthyLabel, renderItem, pageSize = 0, paginationLabel }) {
  const { t } = useTranslation('dashboard');
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
        <div className="dashboard-source-pagination" role="navigation" aria-label={paginationLabel || t('attention.paginationLabel')}>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setPage((prev) => Math.max(0, prev - 1))}
            disabled={currentPage === 0}
          >
            <ChevronLeft size={14} className="icon-flip-rtl" /> {t('common:actions.previous')}
          </button>
          <span className="dashboard-source-pagination-label">
            {t('common:pagination.page', { page: formatNumber(currentPage + 1), total: formatNumber(totalPages) })}
          </span>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setPage((prev) => Math.min(totalPages - 1, prev + 1))}
            disabled={currentPage >= totalPages - 1}
          >
            {t('common:actions.next')} <ChevronRight size={14} className="icon-flip-rtl" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default function DashboardPage({ projects = [], projectId = null }) {
  const { t } = useTranslation('dashboard');
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
      if (!res.ok) throw apiError(data, { status: res.status, fallback: i18n.t('dashboard:errors.loadFailed') });
      setSummary(data);
    } catch (err) {
      setError(err?.message ? err : i18n.t('dashboard:errors.loadFailed'));
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
              <LayoutDashboard size={13} /> {t('header.kicker')}
            </span>
            <h2 className="report-title">{t('header.title')}</h2>
            <p className="subtitle">{t('header.subtitle')}</p>
          </div>

          <div className="report-header-actions">
            <div className="report-project-control">
              <label className="report-project-control-label" htmlFor="dashboard-project-select">
                <FolderKanban size={13} /> {t('header.projectLabel')}
              </label>
              <div className="report-project-select-wrap">
                <FolderKanban size={16} aria-hidden="true" />
                <select
                  id="dashboard-project-select"
                  className="filter-select report-project-select"
                  value={selectedId ?? ''}
                  onChange={(e) => setSelectedId(e.target.value ? Number(e.target.value) : null)}
                  aria-label={t('header.projectLabel')}
                  disabled={!projects.length}
                >
                  {!projects.length ? <option value="">{t('noProjects.title')}</option> : null}
                  {projects.map((item) => (
                    <option key={item.id} value={item.id}>
                      {t('header.projectOption', {
                        name: item.name,
                        mode: t(item.mode === 'competitor' ? 'header.modes.competitor' : 'header.modes.opinion'),
                      })}
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
              <RefreshCw size={15} className={loading ? 'spin' : ''} /> {t('common:actions.refresh')}
            </button>
          </div>
        </div>
      </div>

      {!projects.length ? (
        <div className="glass-card admin-empty-state">
          <div className="admin-empty-state-icon">
            <FolderKanban size={20} />
          </div>
          <strong>{t('noProjects.title')}</strong>
          <p>{t('noProjects.message')}</p>
          <Link to="/projects" className="btn-secondary">{t('noProjects.action')}</Link>
        </div>
      ) : error ? (
        <ErrorNotice error={error} context={t('errorContext.loadDashboard')} onRetry={() => loadSummary(selectedId)} />
      ) : (
        <div className="report-body">
          <div className="admin-stats-grid dashboard-stats-grid">
            <div className="admin-stat-card">
              <div className="admin-stat-icon">
                <FileText size={18} />
              </div>
              <div>
                <span>{t('stats.totalArticles')}</span>
                <strong>{loading && !summary ? '-' : formatNumber(summary?.totals?.articles ?? 0)}</strong>
              </div>
            </div>
            <div className="admin-stat-card">
              <div className="admin-stat-icon" style={{ background: 'rgba(46, 134, 222, 0.12)', color: 'var(--secondary-color)' }}>
                <Rss size={18} />
              </div>
              <div>
                <span>{t('stats.totalSources')}</span>
                <strong>{loading && !summary ? '-' : formatNumber(summary?.totals?.sources ?? 0)}</strong>
              </div>
            </div>
            <div className="admin-stat-card">
              <div className="admin-stat-icon" style={{ background: 'rgba(46, 213, 115, 0.12)', color: '#2ed573' }}>
                <History size={18} />
              </div>
              <div>
                <span>{t('stats.totalRuns')}</span>
                <strong>{loading && !summary ? '-' : formatNumber(summary?.totals?.runs ?? 0)}</strong>
              </div>
            </div>
            {isCompetitorMode ? (
              <div className="admin-stat-card">
                <div className="admin-stat-icon" style={{ background: 'rgba(255, 159, 67, 0.14)', color: 'var(--primary-color)' }}>
                  <Users size={18} />
                </div>
                <div>
                  <span>{t('stats.competitorsTracked')}</span>
                  <strong>{loading && !summary ? '-' : formatNumber(summary?.totals?.competitors ?? 0)}</strong>
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
                <h3 className="report-section-title">{t('runsChart.title')}</h3>
              </div>
              <p className="report-section-caption">{t('runsChart.caption')}</p>
            </div>
            <RunsChart runs={summary?.runs || []} />
          </div>

          <div className="glass-card report-section">
            <div className="report-section-header">
              <div className="report-section-heading">
                <span className="report-section-icon">
                  <Layers3 size={16} />
                </span>
                <h3 className="report-section-title">{t('platformBreakdown.title')}</h3>
              </div>
              <p className="report-section-caption">{t('platformBreakdown.caption')}</p>
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
                  <h3 className="report-section-title">{t('sourceBreakdown.title')}</h3>
                </div>
                <p className="report-section-caption">{t('sourceBreakdown.caption')}</p>
              </div>
              <SourceBreakdown items={summary?.articles_by_source || []} key={selectedId} />
            </div>

            <div className="glass-card report-section">
              <div className="report-section-header">
                <div className="report-section-heading">
                  <span className="report-section-icon" style={{ background: 'rgba(255, 71, 87, 0.14)', color: '#b42318' }}>
                    <ShieldAlert size={16} />
                  </span>
                  <h3 className="report-section-title">{t('sourceAttention.title')}</h3>
                </div>
                <p className="report-section-caption">{t('sourceAttention.caption')}</p>
              </div>
              <AttentionList
                key={selectedId}
                items={summary?.sources_needing_attention || []}
                healthyLabel={t('sourceAttention.healthy')}
                pageSize={ATTENTION_PAGE_SIZE}
                paginationLabel={t('sourceAttention.paginationLabel')}
                renderItem={(item) => {
                  const fallbackMessage = translateFetchNote(item.reason);
                  const issue = item.issue ? translateSourceIssue(item.issue) : {
                    title: t('sourceAttention.fallbackTitle'),
                    message: fallbackMessage || item.reason,
                    action: t('sourceAttention.fallbackAction'),
                    severity: 'warning',
                    technical_detail: item.reason,
                    untranslated: !fallbackMessage,
                  };
                  const textDir = issue.untranslated ? 'auto' : undefined;
                  return (
                  <div className={`report-insight-card ${issue.severity === 'error' ? 'tone-negative' : 'tone-warning'}`} key={item.source_url || item.source}>
                    <div className="report-insight-card-top">
                      <div className="report-insight-card-copy">
                        <p className="report-insight-card-text" dir="auto">{item.source}</p>
                        <strong className="dashboard-attention-title" dir={textDir}>{issue.title}</strong>
                        <span className="dashboard-attention-reason" dir={textDir}>{issue.message}</span>
                        <span className="dashboard-attention-action" dir={textDir}>{issue.action}</span>
                        <div className="dashboard-attention-controls">
                          <Link className="dashboard-attention-link" to="/sources">{t('sourceAttention.reviewSources')}</Link>
                          {issue.technical_detail ? (
                            <details className="dashboard-attention-details">
                              <summary>{t('common:errors.technicalDetails')}</summary>
                              <p dir="ltr">{issue.technical_detail}</p>
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
                  <h3 className="report-section-title">{t('competitorAttention.title')}</h3>
                </div>
                <p className="report-section-caption">{t('competitorAttention.caption')}</p>
              </div>
              <AttentionList
                items={summary?.competitors_needing_attention || []}
                healthyLabel={t('competitorAttention.healthy')}
                paginationLabel={t('competitorAttention.paginationLabel')}
                renderItem={(competitor) => (
                  <div className="report-insight-card tone-negative" key={competitor.id}>
                    <div className="report-insight-card-top">
                      <div className="report-insight-card-copy">
                        <p className="report-insight-card-text" dir="auto">{competitor.name}</p>
                        <div className="report-insight-card-tags">
                          {competitor.sources.map((source, index) => {
                            const issue = translateSourceIssue(source.issue);
                            const reason = issue?.title
                              || translateFetchNote(source.reason, { fallbackToGeneric: false })
                              || source.reason;
                            return (
                              <span className="report-insight-card-tag muted" key={`${competitor.id}-${index}`}>
                                {t('competitorAttention.sourceIssue', {
                                  platform: t(`platforms.${source.platform}`, { defaultValue: source.platform }),
                                  reason,
                                })}
                              </span>
                            );
                          })}
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
