import RemoveProjectArticlesDialog from './articles/RemoveProjectArticlesDialog.jsx';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Trans, useTranslation } from 'react-i18next';
import ConfirmModal from './ConfirmModal';
import { useAuth } from '../auth/useAuth.js';
import i18n from '../i18n/index.js';
import { formatDate as formatLocaleDate, formatDateTime as formatLocaleDateTime, formatList, formatNumber } from '../i18n/format.js';
import {
  ArrowLeft,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Hash,
  Link2,
  Loader2,
  Newspaper,
  Rss,
  MapPin,
  AtSign,
  Tag,
  Pencil,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import '../styles/ProjectDetail.css';

const SOURCES_PAGE_SIZE = 3;

// No "Social" option - see SourcesPage.jsx's SOURCE_TYPE_OPTIONS comment.
// Values are stable API codes; labels come from projects:sourceTypes.<value>.
const SOURCE_TYPE_OPTIONS = ['rss', 'web', 'hashtag', 'keyword', 'username', 'tweet', 'reddit', 'telegram', 'linkedin'].map(
  (value) => ({ value })
);

const SOURCE_ASSIGN_TABS = [{ value: 'all' }, ...SOURCE_TYPE_OPTIONS];

const LOCATION_TYPE_KEYS = { on_site: 'onSite', remote: 'remote', hybrid: 'hybrid' };

// These helpers are called during render, so they follow the UI language.
function sourceTypeLabel(sourceType) {
  const type = sourceType || 'rss';
  return i18n.t(`projects:sourceTypes.${type}`, { defaultValue: sourceType || 'RSS' });
}

// Date-only values ("2026-01-31", the project start/end dates) parse as UTC
// midnight, so format those in UTC to keep them from shifting a day.
function formatDate(value) {
  if (!value) return i18n.t('projects:detail.notSet');
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(value));
  return formatLocaleDate(
    value,
    { year: 'numeric', month: 'short', day: 'numeric', ...(dateOnly ? { timeZone: 'UTC' } : {}) },
    String(value)
  );
}

function formatDateTime(value) {
  if (!value) return i18n.t('projects:detail.notYet');
  return formatLocaleDateTime(value, undefined, String(value));
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

function prettyLabel(value) {
  return String(value || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function scrapedLabel(value) {
  if (!value) return i18n.t('common:time.never');
  return formatLocaleDateTime(value, undefined, String(value));
}

function locationTypeLabel(value) {
  const key = LOCATION_TYPE_KEYS[value];
  return key ? i18n.t(`projects:locationTypes.${key}`) : prettyLabel(value);
}

function intervalLabel(value, unit) {
  return i18n.t(`projects:intervalUnits.${unit}`, { count: Number(value), defaultValue: `${value} ${unit}` });
}

export default function ProjectDetailPage({
  projects = [],
  sources = [],
  users = [],
  onDeleteProject,
}) {
  const { t } = useTranslation('projects');
  const navigate = useNavigate();
  const params = useParams();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('projects.update') || hasPermission('projects.delete');
  const canLinkUsers = hasPermission('projects.link_users');
  const { t: tArticles } = useTranslation('articles');
  const canRemoveArticles = hasPermission('articles.delete');
  const [removeArticlesOpen, setRemoveArticlesOpen] = useState(false);
  const [articlesReloadKey, setArticlesReloadKey] = useState(0);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [sourcesPage, setSourcesPage] = useState(1);
  const [activeSourceTab, setActiveSourceTab] = useState('all');
  const [articleStats, setArticleStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [seenProjectId, setSeenProjectId] = useState(null);

  const project = useMemo(
    () => projects.find((item) => Number(item.id) === Number(params.projectId)) || null,
    [projects, params.projectId]
  );

  // Reset source pagination/tab when navigating to a different project. Adjusting state
  // during render (rather than in an effect) avoids an extra render on every navigation.
  if (project?.id !== seenProjectId) {
    setSeenProjectId(project?.id ?? null);
    setRemoveArticlesOpen(false);
    setSourcesPage(1);
    setActiveSourceTab('all');
  }

  useEffect(() => {
    const controller = new AbortController();
    async function loadArticleStats() {
      if (!project?.id) {
        setArticleStats(null);
        return;
      }
      setStatsLoading(true);
      try {
        const res = await fetch(`/api/articles/stats?project_id=${project.id}`, { signal: controller.signal });
        const data = await res.json().catch(() => null);
        setArticleStats(data && typeof data === 'object' ? data : null);
      } catch (err) {
        if (err?.name !== 'AbortError') setArticleStats(null);
      } finally {
        setStatsLoading(false);
      }
    }
    loadArticleStats();
    return () => controller.abort();
  }, [project?.id, articlesReloadKey]);

  const assignedSources = useMemo(() => {
    if (!project) return [];
    const sourceIds = new Set((project.source_ids || []).map((value) => Number(value)));
    return sources.filter((source) => sourceIds.has(Number(source.id)));
  }, [project, sources]);

  const linkedUsers = useMemo(() => {
    if (!project) return [];
    const userIds = new Set((project.user_ids || []).map((value) => Number(value)));
    return users.filter((user) => userIds.has(Number(user.id)));
  }, [project, users]);

  const sourceTabCounts = useMemo(() => {
    const counts = { all: assignedSources.length };
    SOURCE_TYPE_OPTIONS.forEach((option) => {
      counts[option.value] = assignedSources.filter((source) => (source.source_type || 'rss') === option.value).length;
    });
    return counts;
  }, [assignedSources]);

  const sourcesForActiveTab = useMemo(() => {
    if (activeSourceTab === 'all') return assignedSources;
    return assignedSources.filter((source) => (source.source_type || 'rss') === activeSourceTab);
  }, [assignedSources, activeSourceTab]);

  const totalSourcesPages = Math.max(1, Math.ceil(sourcesForActiveTab.length / SOURCES_PAGE_SIZE));
  const safeSourcesPage = Math.min(sourcesPage, totalSourcesPages);
  const pagedAssignedSources = useMemo(() => {
    const start = (safeSourcesPage - 1) * SOURCES_PAGE_SIZE;
    return sourcesForActiveTab.slice(start, start + SOURCES_PAGE_SIZE);
  }, [sourcesForActiveTab, safeSourcesPage]);

  const hashtagList = normalizeList(project?.hashtags);
  const keywordList = normalizeList(project?.keywords);
  const usernameList = normalizeList(project?.usernames);
  const weekdayList = normalizeList(project?.repeat_weekdays);

  const status = String(project?.status || 'draft').toLowerCase();
  const isActive = status === 'active';
  const isArchived = status === 'archived';
  const statusLabel = t(`statuses.${status}`, { defaultValue: status }).toUpperCase();

  if (!project) {
    return (
      <div className="admin-page-shell project-detail-page">
        <div className="glass-card" style={{ maxWidth: 960, margin: '0 auto' }}>
          <div className="admin-empty-state" style={{ padding: '34px 20px' }}>
            <div className="admin-empty-state-icon">
              <CalendarDays size={18} />
            </div>
            <strong>{t('detail.notFoundTitle')}</strong>
            <span>{t('detail.notFoundHint')}</span>
            <Link to="/projects" className="btn-primary" style={{ marginTop: 8, textDecoration: 'none' }}>
              <ArrowLeft size={16} className="icon-flip-rtl" /> {t('detail.backToProjects')}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const handleDelete = async () => {
    if (!onDeleteProject) return;
    await onDeleteProject(project.id);
    navigate('/projects');
  };

  return (
    <div className="admin-page-shell project-detail-page">
      <div className="admin-page-header">
        <div>
          <div className="admin-page-kicker">
            <CalendarDays size={14} /> {t('detail.kicker')}
          </div>
          <h1 className="admin-page-title" dir="auto">{project.name}</h1>
          <p className="admin-page-subtitle">
            {t('detail.subtitle')}
          </p>
        </div>

        <div className="admin-page-toolbar">
          <div className="admin-page-toolbar-meta">
            <span>{t('detail.statusLabel')}</span>
            <strong>{statusLabel}</strong>
          </div>
          <div className="admin-page-toolbar-meta">
            <span>{t('detail.assignedSourcesLabel')}</span>
            <strong>{formatNumber(assignedSources.length)}</strong>
          </div>
          {canEdit && (
            <>
              <Link to={`/projects/${project.id}/edit`} className="btn-secondary" style={{ textDecoration: 'none' }}>
                <Pencil size={16} /> {t('detail.editProject')}
              </Link>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setDeleteOpen(true)}
                style={{ color: '#ff4757' }}
              >
                <Trash2 size={16} /> {t('common:actions.delete')}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="project-detail-layout">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="glass-card"
          style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
        >
          <div className="panel-header-tight">
            <strong style={{ fontSize: '1rem' }}>{t('detail.overview')}</strong>
            <span className={`panel-chip ${isActive ? 'success' : isArchived ? 'muted' : 'warning'}`}>{statusLabel}</span>
          </div>

          <div className="project-detail-summary-grid">
            <div className="admin-item-card" style={{ margin: 0 }}>
              <div className="admin-item-meta" style={{ marginBottom: 8 }}>
                <span><CalendarDays size={12} /> {t('detail.start')}</span>
                <span><CalendarDays size={12} /> {t('detail.end')}</span>
              </div>
              <strong style={{ fontSize: '0.98rem' }}>{formatDate(project.start_date)}</strong>
              <div style={{ color: 'var(--text-light)', fontSize: '0.84rem', marginTop: 4 }}>{formatDate(project.end_date)}</div>
            </div>

            <div className="admin-item-card" style={{ margin: 0 }}>
              <div className="admin-item-meta" style={{ marginBottom: 8 }}>
                <span><MapPin size={12} /> {t('detail.location')}</span>
                <span><Tag size={12} /> {t('detail.audience')}</span>
              </div>
              <strong style={{ fontSize: '0.98rem' }}>
                {project.location_type ? (
                  // FSI/PDI isolate the user-entered location inside the sentence
                  // (the string equivalent of <bdi>).
                  t('detail.locationWithType', {
                    location: project.location ? `\u2068${project.location}\u2069` : t('detail.notSet'),
                    type: locationTypeLabel(project.location_type),
                  })
                ) : project.location ? (
                  <bdi>{project.location}</bdi>
                ) : (
                  t('detail.notSet')
                )}
              </strong>
              {project.target_audience ? (
                <div dir="auto" style={{ color: 'var(--text-light)', fontSize: '0.84rem', marginTop: 4 }}>{project.target_audience}</div>
              ) : (
                <div style={{ color: 'var(--text-light)', fontSize: '0.84rem', marginTop: 4 }}>{t('detail.noAudience')}</div>
              )}
            </div>
          </div>

          <div className="admin-item-card" style={{ margin: 0 }}>
            <div className="panel-header-tight" style={{ marginBottom: 10 }}>
              <strong style={{ fontSize: '0.94rem' }}><RefreshCw size={14} style={{ verticalAlign: -2 }} /> {t('detail.autoReruns')}</strong>
              <span className={`panel-chip ${project.repeat_enabled ? 'success' : 'muted'}`}>
                {project.repeat_enabled ? t('sourceState.enabled') : t('sourceState.disabled')}
              </span>
            </div>
            {project.repeat_enabled ? (
              <div style={{ display: 'grid', gap: 6, color: 'var(--text-light)', fontSize: '0.86rem' }}>
                <div>
                  {t('detail.repeatSummary', {
                    interval: intervalLabel(project.repeat_interval_value, project.repeat_interval_unit),
                  })}
                  {weekdayList.length
                    ? ` ${t('detail.restrictedTo', {
                        days: formatList(weekdayList.map((day) => t(`weekdays.${day}`, { defaultValue: prettyLabel(day) }))),
                      })}`
                    : ''}
                </div>
                <div className="admin-item-meta">
                  <span>{t('detail.firstRunAt', { date: formatDateTime(project.first_run_at) })}</span>
                  <span>{t('detail.nextRun', { date: formatDateTime(project.next_run_at) })}</span>
                  <span>{t('detail.lastRun', { date: formatDateTime(project.last_run_at) })}</span>
                  {project.last_run_status && (
                    <span>
                      {t('detail.lastStatus', {
                        status: t(`common:status.${project.last_run_status}`, { defaultValue: project.last_run_status }),
                      })}
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <div style={{ color: 'var(--text-light)', fontSize: '0.86rem' }}>
                {t('detail.manualOnly')}
                {project.last_run_at && ` ${t('detail.lastRunSentence', { date: formatDateTime(project.last_run_at) })}`}
              </div>
            )}
          </div>

          <div className="admin-item-card" style={{ margin: 0 }}>
            <div className="panel-header-tight" style={{ marginBottom: 10 }}>
              <strong style={{ fontSize: '0.94rem' }}>{t('detail.description')}</strong>
            </div>
            <div dir={project.description ? 'auto' : undefined} style={{ color: 'var(--text-light)', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
              {project.description || t('detail.noDescription')}
            </div>
          </div>

          <div className="admin-item-card" style={{ margin: 0 }}>
            <div className="panel-header-tight" style={{ marginBottom: 10 }}>
              <strong style={{ fontSize: '0.94rem' }}>{t('detail.signals')}</strong>
            </div>
            <div style={{ display: 'grid', gap: 12 }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, color: 'var(--text-light)', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  <Hash size={14} /> {t('detail.hashtags')}
                </div>
                <div className="admin-item-chips">
                  {hashtagList.length ? hashtagList.map((item) => (
                    <span key={item} className="admin-tag" dir="auto">{item}</span>
                  )) : <span className="admin-tag muted">{t('detail.noHashtags')}</span>}
                </div>
              </div>

              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, color: 'var(--text-light)', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  <AtSign size={14} /> {t('detail.xAccounts')}
                </div>
                <div className="admin-item-chips">
                  {usernameList.length ? usernameList.map((item) => (
                    <span key={item} className="admin-tag muted ltr-isolate">{item}</span>
                  )) : <span className="admin-tag muted">{t('detail.noXAccounts')}</span>}
                </div>
              </div>

              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, color: 'var(--text-light)', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  <Link2 size={14} /> {t('detail.keywords')}
                </div>
                <div className="admin-item-chips">
                  {keywordList.length ? keywordList.map((item) => (
                    <span key={item} className="admin-tag muted" dir="auto">{item}</span>
                  )) : <span className="admin-tag muted">{t('detail.noKeywords')}</span>}
                </div>
              </div>
            </div>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.05 }}
          className="glass-card"
          style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
        >
          <div className="panel-header-tight">
            <strong style={{ fontSize: '1rem' }}>{t('detail.assignedTitle')}</strong>
            <span className="panel-chip">{t('detail.linked', { n: assignedSources.length })}</span>
          </div>

          {assignedSources.length === 0 ? (
            <div className="admin-empty-state" style={{ padding: '20px 12px' }}>
              <div className="admin-empty-state-icon">
                <Link2 size={18} />
              </div>
              <strong>{t('detail.noSourcesTitle')}</strong>
              <span>{t('detail.noSourcesHint')}</span>
            </div>
          ) : (
            <>
              <div className="source-type-tabs" role="tablist" aria-label={t('detail.filterByType')}>
                {SOURCE_ASSIGN_TABS.map((tab) => {
                  const isActive = activeSourceTab === tab.value;
                  return (
                    <button
                      key={tab.value}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      className={`source-type-tab ${isActive ? 'active' : ''}`}
                      onClick={() => {
                        setActiveSourceTab(tab.value);
                        setSourcesPage(1);
                      }}
                    >
                      {tab.value === 'all' ? t('common:status.all') : sourceTypeLabel(tab.value)}
                      <span className="source-type-tab-count">{sourceTabCounts[tab.value] || 0}</span>
                    </button>
                  );
                })}
              </div>

              {sourcesForActiveTab.length === 0 ? (
                <div className="admin-empty-state" style={{ padding: '20px 12px' }}>
                  <div className="admin-empty-state-icon">
                    <Link2 size={18} />
                  </div>
                  <strong>{t('detail.noMatchesTitle')}</strong>
                  <span>{t('detail.noneOfType', { type: sourceTypeLabel(activeSourceTab) })}</span>
                </div>
              ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {pagedAssignedSources.map((source) => (
                <div key={source.id} className="admin-item-card" style={{ margin: 0 }}>
                  <div className="admin-item-top">
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
                        <strong className="admin-item-title project-detail-break-text" dir="auto">{source.name || source.url}</strong>
                        <span className={`panel-chip ${source.enabled ? 'success' : 'muted'}`}>
                          {source.enabled ? t('sourceState.enabled') : t('sourceState.disabled')}
                        </span>
                      </div>
                      <div className="admin-item-url ltr-isolate">{source.url}</div>
                      <div className="admin-item-meta">
                        <span>{sourceTypeLabel(source.source_type)}</span>
                      </div>
                    </div>
                  </div>
                </div>
                ))}
              </div>
              )}

              {sourcesForActiveTab.length > SOURCES_PAGE_SIZE && (
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 12,
                    flexWrap: 'wrap',
                    paddingTop: 6,
                    borderTop: '1px solid rgba(15, 23, 42, 0.08)',
                  }}
                >
                  <div style={{ fontSize: '0.84rem', color: 'var(--text-light)' }}>
                    {t('common:pagination.showing', {
                      from: (safeSourcesPage - 1) * SOURCES_PAGE_SIZE + 1,
                      to: Math.min(safeSourcesPage * SOURCES_PAGE_SIZE, sourcesForActiveTab.length),
                      total: sourcesForActiveTab.length,
                    })}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => setSourcesPage((value) => Math.max(1, value - 1))}
                      disabled={safeSourcesPage <= 1}
                      style={{ padding: '8px 10px', fontSize: '0.8rem' }}
                    >
                      <ChevronLeft size={14} className="icon-flip-rtl" /> {t('common:actions.previous')}
                    </button>
                    <span className="panel-chip">
                      {t('common:pagination.page', { page: safeSourcesPage, total: totalSourcesPages })}
                    </span>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => setSourcesPage((value) => Math.min(totalSourcesPages, value + 1))}
                      disabled={safeSourcesPage >= totalSourcesPages}
                      style={{ padding: '8px 10px', fontSize: '0.8rem' }}
                    >
                      {t('common:actions.next')} <ChevronRight size={14} className="icon-flip-rtl" />
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          <div className="admin-item-card" style={{ margin: 0 }}>
            <div className="panel-header-tight" style={{ marginBottom: 10 }}>
              <strong style={{ fontSize: '0.94rem' }}>{t('detail.quickFacts')}</strong>
            </div>
            <div style={{ display: 'grid', gap: 10 }}>
              <div className="admin-item-meta">
                <span>{t('detail.created', { date: formatDate(project.created_at) })}</span>
                <span>{t('detail.updated', { date: formatDate(project.updated_at) })}</span>
              </div>
              <div className="admin-item-meta">
                <span>{t('detail.linkedSources', { count: assignedSources.length })}</span>
                <span>{t('detail.hashtagCount', { count: hashtagList.length })}</span>
              </div>
              {canLinkUsers && (
                <div className="admin-item-meta">
                  <span>{t('detail.linkedUsers', { count: linkedUsers.length })}</span>
                </div>
              )}
              {canLinkUsers && linkedUsers.length > 0 && (
                <div className="admin-item-chips">
                  {linkedUsers.map((user) => (
                    <span key={user.id} className="admin-tag muted" dir="auto">{user.username}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </motion.div>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.1 }}
        className="glass-card"
        style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 24 }}
      >
        <div className="panel-header-tight">
          <strong style={{ fontSize: '1rem' }}>{t('detail.articlesTitle')}</strong>
          <span className="panel-chip">
            {t('detail.articlesStored', { count: articleStats?.total || 0, formatted: formatNumber(articleStats?.total || 0) })}
          </span>
        </div>

        {statsLoading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-light)', fontSize: '0.86rem', padding: '12px 0' }}>
            <Loader2 size={16} className="spin" /> {t('detail.loadingSummary')}
          </div>
        ) : !articleStats?.total ? (
          <div className="admin-empty-state" style={{ padding: '20px 12px' }}>
            <div className="admin-empty-state-icon">
              <Newspaper size={18} />
            </div>
            <strong>{t('detail.nothingTitle')}</strong>
            <span>{t('detail.nothingHint')}</span>
          </div>
        ) : (
          <>
            <div className="project-detail-summary-grid">
              <div className="admin-item-card" style={{ margin: 0 }}>
                <span className="admin-item-label">{t('detail.firstScraped')}</span>
                <strong style={{ fontSize: '0.98rem' }}>{scrapedLabel(articleStats?.first_scraped_at)}</strong>
              </div>
              <div className="admin-item-card" style={{ margin: 0 }}>
                <span className="admin-item-label">{t('detail.lastScraped')}</span>
                <strong style={{ fontSize: '0.98rem' }}>{scrapedLabel(articleStats?.last_scraped_at)}</strong>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span className="admin-item-label">
                <Rss size={12} style={{ marginInlineEnd: 4 }} /> {t('detail.articlesBySource')}
              </span>
              {(articleStats?.sources || []).map((row) => (
                <div
                  key={row.source}
                  className="admin-item-card"
                  style={{ margin: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}
                >
                  <strong dir="auto" style={{ fontSize: '0.9rem', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {row.source}
                  </strong>
                  <span className="panel-chip" style={{ flexShrink: 0 }}>
                    {t('detail.articleCount', { count: Number(row.count || 0), formatted: formatNumber(Number(row.count || 0)) })}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </motion.div>

      {canRemoveArticles && (
        <section className="glass-card danger-zone" aria-labelledby="project-danger-zone-title">
          <h2 id="project-danger-zone-title">{tArticles('removeProject.dangerZoneTitle')}</h2>
          <div className="danger-zone-row">
            <div><strong>{tArticles('removeProject.dangerZoneAction')}</strong><p>{tArticles('removeProject.dangerZoneBody')}</p></div>
            <button type="button" className="btn-secondary" onClick={() => setRemoveArticlesOpen(true)}>
              <Trash2 size={16} /> {tArticles('removeProject.openButton')}
            </button>
          </div>
        </section>
      )}
      {removeArticlesOpen && (
        <RemoveProjectArticlesDialog open project={project} onClose={() => setRemoveArticlesOpen(false)}
          onRemoved={() => { setRemoveArticlesOpen(false); setArticlesReloadKey((value) => value + 1); }} />
      )}

      <ConfirmModal
        open={deleteOpen}
        title={
          <Trans t={t} i18nKey="detail.deleteTitle" values={{ name: project.name }} components={{ bdi: <bdi /> }} />
        }
        message={t('detail.deleteMessage')}
        confirmLabel={t('detail.deleteConfirm')}
        cancelLabel={t('detail.deleteCancel')}
        confirmButtonStyle={{
          background: 'linear-gradient(135deg, #ff4757, #e03131)',
          boxShadow: '0 4px 15px rgba(255, 71, 87, 0.28)',
        }}
        onClose={() => setDeleteOpen(false)}
        onConfirm={handleDelete}
      />
    </div>
  );
}
