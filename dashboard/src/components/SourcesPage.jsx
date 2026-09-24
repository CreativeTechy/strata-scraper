import React, { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import ConfirmModal from './ConfirmModal';
import ErrorNotice from './ErrorNotice';
import { useAuth } from '../auth/useAuth.js';
import { formatNumber } from '../i18n/format.js';
import {
  Rss,
  Plus,
  Pencil,
  Trash2,
  Check,
  X,
  ToggleLeft,
  ToggleRight,
  Search,
  Link2,
  CheckCircle2,
  Layers3,
} from 'lucide-react';
import '../styles/Sources.css';

const emptyDraft = {
  url: '',
  name: '',
  source_type: 'rss',
  enabled: true,
  limited: true,
  project_ids: [],
  reddit_kind: 'subreddit',
  linkedin_kind: 'company',
  threads_kind: 'profile',
  facebook_kind: 'page',
  instagram_kind: 'profile',
};

// No "Social" option - the backend has no dedicated scraping tier for
// TikTok/YouTube/etc, so a URL on one of those platforms is just stored (and
// crawled) as a "web" source instead (see backend/app/core/settings.py's
// _infer_source_type/_resolve_source_type, which reassigns any entered URL
// to its real platform type regardless of what was picked here).
// Values are stable API codes; display labels come from sources:types.<value>
// at render time (sourceTypeLabel below).
const SOURCE_TYPE_OPTIONS = [
  { value: 'rss' },
  { value: 'web' },
  { value: 'hashtag' },
  { value: 'keyword' },
  { value: 'username' },
  { value: 'tweet' },
  { value: 'reddit' },
  { value: 'telegram' },
  { value: 'linkedin' },
  { value: 'threads' },
  { value: 'facebook' },
  { value: 'instagram' },
];

const SOURCE_TYPE_TABS = [{ value: 'all' }, ...SOURCE_TYPE_OPTIONS];

const TERM_SOURCE_TYPES = new Set(['hashtag', 'keyword', 'username']);

// hashtag/username/tweet grouped under the "Twitter/X" tab - a superset of
// TERM_SOURCE_TYPES, which only governs the term-vs-URL field choice below
// (tweet keeps the URL field, like reddit/telegram/linkedin, since a tweet
// has no bare-term short form). "keyword" is deliberately NOT included here:
// its stored URL/primary crawl is a Google News RSS search
// (sources_store._derive_term_url), not an X/Twitter search - the Apify
// tweet-search tier it also gets (scraper/apify_twitter.py) is one of
// several tiers, not what the source actually is, so grouping it under
// Twitter/X read as "this searches X" and was misleading.
const TWITTER_SOURCE_TYPES = new Set(['hashtag', 'username', 'tweet']);

// The create/edit form groups hashtag/username/tweet under one "Twitter/X"
// tab (all three are X-only concepts - see
// sources_store._derive_term_url/_derive_tweet_url) - picking a specific one
// happens via TWITTER_SUB_TYPE_OPTIONS below, same pattern as the
// reddit/linkedin kind selectors. "keyword" stays its own top-level tab (see
// TWITTER_SOURCE_TYPES above). The type-filter tabs on the source list
// (SOURCE_TYPE_TABS above) keep every type separate, since filtering by
// exact type still matters there.
const SOURCE_TYPE_FORM_TABS = [
  { value: 'rss' },
  { value: 'web' },
  { value: 'keyword' },
  { value: 'twitter' },
  { value: 'reddit' },
  { value: 'telegram' },
  { value: 'linkedin' },
  { value: 'threads' },
  { value: 'facebook' },
  { value: 'instagram' },
];

const TWITTER_SUB_TYPE_OPTIONS = [
  { value: 'hashtag' },
  { value: 'username' },
  { value: 'tweet' },
];

// Translation keys (sources namespace), resolved at render time.
const TERM_SOURCE_PLACEHOLDERS = {
  hashtag: 'form.termPlaceholders.hashtag',
  username: 'form.termPlaceholders.username',
  keyword: 'form.termPlaceholders.keyword',
};

// Reddit/Telegram/LinkedIn/tweet keep the URL field (unlike the term types
// above) since it doubles as a free-form input that accepts short forms (a
// bare company/profile slug or search phrase, disambiguated by the kind
// selector below) as well as full URLs. A tweet has no short form - the
// full status URL is the only valid input.
// Values are translation keys (sources namespace), resolved at render time.
const URL_FIELD_PLACEHOLDERS = {
  reddit: 'form.urlPlaceholders.reddit',
  telegram: 'form.urlPlaceholders.telegram',
  linkedin: 'form.urlPlaceholders.linkedin',
  tweet: 'form.urlPlaceholders.tweet',
  threads: 'form.urlPlaceholders.threads',
  facebook: 'form.urlPlaceholders.facebook',
  instagram: 'form.urlPlaceholders.instagram',
};

// Types whose URL field only ever takes a URL/handle (always LTR); the others
// also accept a free-text search phrase, which may be Arabic, so they use
// dir="auto" instead.
const URL_ONLY_SOURCE_TYPES = new Set(['rss', 'web', 'tweet', 'telegram']);

function inferRedditKind(url) {
  let path = url || '';
  let query = '';
  try {
    const parsed = new URL(url);
    path = parsed.pathname;
    query = parsed.search;
  } catch {
    // Not a full URL (e.g. a bare term saved before this field existed) - fall through.
  }
  if (/\/user\//i.test(path)) return 'user';
  // A subreddit-scoped search is stored as a plain search URL with the
  // subreddit folded into `q` via Reddit's subreddit: operator (see
  // backend's _derive_reddit_url) - a `/r/.../search` path is also handled
  // in case a raw copy-pasted URL like that ever ends up here unconverted.
  if (/^\/r\/[^/]+\/search/i.test(path) || /subreddit%3A|subreddit:/i.test(query)) return 'subreddit_search';
  if (/\/search/i.test(path)) return 'search';
  return 'subreddit';
}

function inferLinkedinKind(url) {
  let path = url || '';
  try {
    path = new URL(url).pathname;
  } catch {
    // Not a full URL (e.g. a bare term saved before this field existed) - fall through.
  }
  if (/\/search\/results\/content/i.test(path)) return 'search';
  if (/\/in\//i.test(path)) return 'profile';
  return 'company';
}

function inferThreadsKind(url) {
  let path = url || '';
  try {
    path = new URL(url).pathname;
  } catch {
    // Not a full URL (e.g. a bare term saved before this field existed) - fall through.
  }
  if (/\/search/i.test(path)) return 'search';
  return 'profile';
}

function inferFacebookKind(url) {
  let path = url || '';
  let search = '';
  try {
    const parsed = new URL(url);
    path = parsed.pathname;
    search = parsed.search;
  } catch {
    // Not a full URL (e.g. a bare term saved before this field existed) - fall through.
  }
  if (/\/groups\//i.test(path)) return 'group';
  if (/\/search/i.test(path)) return 'search';
  if (/\/people\//i.test(path) || /profile\.php/i.test(path) || /fb_kind=profile/i.test(search)) return 'profile';
  return 'page';
}

function inferInstagramKind(url) {
  let path = url || '';
  try {
    path = new URL(url).pathname;
  } catch {
    // Not a full URL (e.g. a bare term saved before this field existed) - fall through.
  }
  if (/\/explore\/tags\//i.test(path)) return 'hashtag';
  if (/\/explore\/search\//i.test(path)) return 'search';
  return 'profile';
}

function sourceTypeLabel(t, sourceType) {
  const type = sourceType || 'rss';
  return t(`sources:types.${type}`, { defaultValue: type });
}

// First-strong isolate, so a URL/name interpolated into a sentence keeps its
// own direction regardless of the UI language.
function isolate(value) {
  return `\u2068${value}\u2069`;
}

const PAGE_SIZE = 3;

function normalizeDraftForCompare(value) {
  return {
    url: String(value?.url || '').trim(),
    name: String(value?.name || '').trim(),
    source_type: String(value?.source_type || 'rss').trim().toLowerCase(),
    enabled: Boolean(value?.enabled),
    limited: Boolean(value?.limited),
    project_ids: Array.isArray(value?.project_ids)
      ? [...new Set(value.project_ids.map((item) => Number(item)).filter((item) => Number.isFinite(item)))].sort((a, b) => a - b)
      : [],
    reddit_kind: String(value?.reddit_kind || 'subreddit').trim().toLowerCase(),
    linkedin_kind: String(value?.linkedin_kind || 'company').trim().toLowerCase(),
    threads_kind: String(value?.threads_kind || 'profile').trim().toLowerCase(),
    facebook_kind: String(value?.facebook_kind || 'page').trim().toLowerCase(),
    instagram_kind: String(value?.instagram_kind || 'profile').trim().toLowerCase(),
  };
}

export default function SourcesPage({
  sources = [],
  projects = [],
  sourcesSource,
  onCreateSource,
  onUpdateSource,
  onDeleteSource,
  isLoadingSources,
}) {
  const { t } = useTranslation('sources');
  const location = useLocation();
  const navigate = useNavigate();
  const params = useParams();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('sources.create') || hasPermission('sources.update') || hasPermission('sources.delete');
  const pathname = location.pathname;
  const isCreateRoute = pathname.endsWith('/new');
  const isEditRoute = pathname.endsWith('/edit');
  const isFormRoute = isCreateRoute || isEditRoute;
  const editingId = isEditRoute ? Number(params.sourceId) : null;
  const currentSource = useMemo(
    () => (editingId != null ? sources.find((source) => Number(source.id) === Number(editingId)) || null : null),
    [editingId, sources]
  );

  const [draft, setDraft] = useState(emptyDraft);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [reachFilter, setReachFilter] = useState('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [projectAssignQuery, setProjectAssignQuery] = useState('');
  const [initialDraft, setInitialDraft] = useState(emptyDraft);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    if (!isFormRoute) {
      setDraft(emptyDraft);
      setInitialDraft(emptyDraft);
      setShowCancelModal(false);
      setDeleteTarget(null);
      setProjectAssignQuery('');
      return;
    }

    setProjectAssignQuery('');

    if (isEditRoute) {
      if (!currentSource) {
        setDraft(emptyDraft);
        setInitialDraft(emptyDraft);
        return;
      }

      const assignedProjectIds = projects
        .filter((project) => Array.isArray(project.source_ids) && project.source_ids.map(Number).includes(Number(currentSource.id)))
        .map((project) => Number(project.id));

      const nextDraft = {
        url: currentSource.url || '',
        name: currentSource.name || '',
        source_type: currentSource.source_type || 'rss',
        enabled: currentSource.enabled ?? true,
        limited: currentSource.limited ?? false,
        project_ids: assignedProjectIds,
        reddit_kind: inferRedditKind(currentSource.url),
        linkedin_kind: inferLinkedinKind(currentSource.url),
        threads_kind: inferThreadsKind(currentSource.url),
        facebook_kind: inferFacebookKind(currentSource.url),
        instagram_kind: inferInstagramKind(currentSource.url),
      };
      setDraft(nextDraft);
      setInitialDraft(nextDraft);
      return;
    }

    setDraft(emptyDraft);
    setInitialDraft(emptyDraft);
  }, [currentSource, projects, isEditRoute, isFormRoute]);

  const sourceProjectsById = useMemo(() => {
    const map = new Map();
    projects.forEach((project) => {
      (project.source_ids || []).forEach((sourceId) => {
        const id = Number(sourceId);
        if (!map.has(id)) map.set(id, []);
        map.get(id).push(project);
      });
    });
    return map;
  }, [projects]);

  const visibleAssignableProjects = useMemo(() => {
    const needle = projectAssignQuery.trim().toLowerCase();
    if (!needle) return projects;
    return projects.filter((project) =>
      [project.name, project.status, project.description].filter(Boolean).some((value) => String(value).toLowerCase().includes(needle))
    );
  }, [projects, projectAssignQuery]);

  const stats = useMemo(() => {
    const total = sources.length;
    const enabled = sources.filter((source) => source.enabled).length;
    const assigned = sources.filter((source) => (sourceProjectsById.get(Number(source.id)) || []).length > 0).length;
    const rss = sources.filter((source) => (source.source_type || 'rss') === 'rss').length;
    return { total, enabled, assigned, rss };
  }, [sources, sourceProjectsById]);

  const sourcesMatchingFilters = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sources.filter((source) => {
      const sourceProjects = sourceProjectsById.get(Number(source.id)) || [];
      const matchesQuery =
        !needle ||
        [source.name, source.url, source.source_type, ...sourceProjects.map((project) => project.name)]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(needle));
      const matchesStatus =
        statusFilter === 'all' ||
        (statusFilter === 'enabled' && source.enabled) ||
        (statusFilter === 'disabled' && !source.enabled) ||
        (statusFilter === 'assigned' && sourceProjects.length > 0) ||
        (statusFilter === 'unassigned' && sourceProjects.length === 0);
      const matchesReach =
        reachFilter === 'all' ||
        (reachFilter === 'limited' && source.limited) ||
        (reachFilter === 'global' && !source.limited);
      return matchesQuery && matchesStatus && matchesReach;
    });
  }, [sources, sourceProjectsById, query, statusFilter, reachFilter]);

  // Tab counts reflect the search/status/reach filters that are still applied
  // alongside the tabs, same as the source-type tabs elsewhere in the app.
  const sourceTypeTabCounts = useMemo(() => {
    const counts = { all: sourcesMatchingFilters.length };
    SOURCE_TYPE_OPTIONS.forEach((option) => {
      counts[option.value] = sourcesMatchingFilters.filter((source) => (source.source_type || 'rss') === option.value).length;
    });
    return counts;
  }, [sourcesMatchingFilters]);

  const visibleSources = useMemo(() => {
    if (typeFilter === 'all') return sourcesMatchingFilters;
    return sourcesMatchingFilters.filter((source) => (source.source_type || 'rss') === typeFilter);
  }, [sourcesMatchingFilters, typeFilter]);

  const totalPages = Math.max(1, Math.ceil(visibleSources.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const pagedSources = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return visibleSources.slice(start, start + PAGE_SIZE);
  }, [visibleSources, safePage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [query, statusFilter, typeFilter, reachFilter]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const beginEdit = (source) => {
    navigate(`/sources/${source.id}/edit`);
  };

  const discardChanges = () => {
    setShowCancelModal(false);
    setDraft(emptyDraft);
    setProjectAssignQuery('');
    navigate('/sources');
  };

  const submit = async () => {
    setActionError('');
    const isTermType = TERM_SOURCE_TYPES.has(draft.source_type);
    const payload = {
      url: isTermType ? '' : draft.url.trim(),
      name: draft.name.trim(),
      source_type: draft.source_type,
      enabled: Boolean(draft.enabled),
      limited: Boolean(draft.limited),
      project_ids: draft.project_ids,
    };
    if (draft.source_type === 'reddit') {
      payload.reddit_kind = draft.reddit_kind || 'subreddit';
    }
    if (draft.source_type === 'linkedin') {
      payload.linkedin_kind = draft.linkedin_kind || 'company';
    }
    if (draft.source_type === 'threads') {
      payload.threads_kind = draft.threads_kind || 'profile';
    }
    if (draft.source_type === 'facebook') {
      payload.facebook_kind = draft.facebook_kind || 'page';
    }
    if (draft.source_type === 'instagram') {
      payload.instagram_kind = draft.instagram_kind || 'profile';
    }

    if (isTermType ? !payload.name : !payload.url) return;

    try {
      if (editingId) {
        await onUpdateSource?.(editingId, payload);
      } else {
        await onCreateSource?.(payload);
      }
      navigate('/sources');
    } catch (error) {
      setActionError(error?.message ? error : t('form.saveFailed'));
    }
  };

  const toggleProject = (projectId) => {
    const id = Number(projectId);
    setDraft((prev) => ({
      ...prev,
      project_ids: prev.project_ids.includes(id)
        ? prev.project_ids.filter((value) => value !== id)
        : [...prev.project_ids, id],
    }));
  };

  const remove = async (source) => {
    setActionError('');
    try {
      await onDeleteSource?.(source.id);
      if (editingId === source.id) {
        navigate('/sources');
      }
    } catch (error) {
      setActionError(error?.message ? error : t('list.deleteFailed'));
    }
  };

  const isDirty = useMemo(() => {
    return JSON.stringify(normalizeDraftForCompare(draft)) !== JSON.stringify(normalizeDraftForCompare(initialDraft));
  }, [draft, initialDraft]);

  const handleCancel = () => {
    if (isDirty) {
      setShowCancelModal(true);
      return;
    }
    discardChanges();
  };

  if (isFormRoute) {
    const heading = isEditRoute ? t('form.editTitle') : t('form.createTitle');
    const buttonLabel = isEditRoute ? t('form.saveButton') : t('form.createButton');
    return (
      <div className="admin-page-shell">
        <div className="admin-page-header">
          <div>
            <div className="admin-page-kicker">
              <Rss size={14} /> {t('kicker')}
            </div>
            <h1 className="admin-page-title">{heading}</h1>
            <p className="admin-page-subtitle">
              {isEditRoute ? t('form.editSubtitle') : t('form.createSubtitle')}
            </p>
          </div>
          <div className="admin-page-toolbar">
            <div className="admin-page-toolbar-meta">
              <span>{t('form.mode')}</span>
              <strong>{isEditRoute ? t('form.modeEditing') : t('form.modeCreating')}</strong>
            </div>
            <div className="admin-page-toolbar-meta">
              <span>{t('form.projects')}</span>
              <strong>{formatNumber(draft.project_ids.length)}</strong>
            </div>
          </div>
        </div>

        <ErrorNotice error={actionError} context={t('errorContext.save')} onDismiss={() => setActionError('')} />

        <div className="glass-card admin-form-panel" style={{ maxWidth: 1080, margin: '0 auto' }}>
          <div className="panel-header-tight">
            <strong style={{ fontSize: '1rem' }}>{heading}</strong>
            <span className="panel-chip">{isEditRoute ? t('form.chipEditing') : t('form.chipCreating')}</span>
          </div>

          <div style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-light)' }}>{t('form.sourceType')}</span>
            <div className="source-type-tabs" role="tablist" aria-label={t('form.chooseSourceType')}>
              {SOURCE_TYPE_FORM_TABS.map((option) => {
                const isActive =
                  option.value === 'twitter' ? TWITTER_SOURCE_TYPES.has(draft.source_type) : draft.source_type === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    className={`source-type-tab ${isActive ? 'active' : ''}`}
                    onClick={() =>
                      setDraft((prev) => ({
                        ...prev,
                        source_type:
                          option.value === 'twitter'
                            ? TWITTER_SOURCE_TYPES.has(prev.source_type)
                              ? prev.source_type
                              : 'hashtag'
                            : option.value,
                      }))
                    }
                  >
                    {t(`types.${option.value}`)}
                  </button>
                );
              })}
            </div>
          </div>
          {TWITTER_SOURCE_TYPES.has(draft.source_type) && (
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-light)' }}>{t('form.twitterKind')}</span>
              <select
                className="filter-select"
                value={draft.source_type}
                onChange={(e) => setDraft((prev) => ({ ...prev, source_type: e.target.value }))}
              >
                {TWITTER_SUB_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(`types.${option.value}`)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {draft.source_type === 'reddit' && (
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-light)' }}>{t('form.redditKind')}</span>
              <select
                className="filter-select"
                value={draft.reddit_kind}
                onChange={(e) => setDraft((prev) => ({ ...prev, reddit_kind: e.target.value }))}
              >
                <option value="subreddit">{t('kinds.reddit.subreddit')}</option>
                <option value="user">{t('kinds.reddit.user')}</option>
                <option value="search">{t('kinds.reddit.search')}</option>
                <option value="subreddit_search">{t('kinds.reddit.subreddit_search')}</option>
              </select>
              <span style={{ fontSize: '0.78rem', color: 'var(--text-light)' }}>
                {draft.reddit_kind === 'subreddit_search' ? t('form.redditSubredditSearchHelp') : t('form.redditKindHelp')}
              </span>
            </label>
          )}
          {draft.source_type === 'linkedin' && (
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-light)' }}>{t('form.linkedinKind')}</span>
              <select
                className="filter-select"
                value={draft.linkedin_kind}
                onChange={(e) => setDraft((prev) => ({ ...prev, linkedin_kind: e.target.value }))}
              >
                <option value="company">{t('kinds.linkedin.company')}</option>
                <option value="profile">{t('kinds.linkedin.profile')}</option>
                <option value="search">{t('kinds.linkedin.search')}</option>
              </select>
              <span style={{ fontSize: '0.78rem', color: 'var(--text-light)' }}>
                {t('form.requiresApify')}
              </span>
            </label>
          )}
          {draft.source_type === 'threads' && (
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-light)' }}>{t('form.threadsKind')}</span>
              <select
                className="filter-select"
                value={draft.threads_kind}
                onChange={(e) => setDraft((prev) => ({ ...prev, threads_kind: e.target.value }))}
              >
                <option value="profile">{t('kinds.threads.profile')}</option>
                <option value="search">{t('kinds.threads.search')}</option>
              </select>
              <span style={{ fontSize: '0.78rem', color: 'var(--text-light)' }}>
                {t('form.requiresApify')}
              </span>
            </label>
          )}
          {draft.source_type === 'facebook' && (
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-light)' }}>{t('form.facebookKind')}</span>
              <select
                className="filter-select"
                value={draft.facebook_kind}
                onChange={(e) => setDraft((prev) => ({ ...prev, facebook_kind: e.target.value }))}
              >
                <option value="page">{t('kinds.facebook.page')}</option>
                <option value="group">{t('kinds.facebook.group')}</option>
                <option value="profile">{t('kinds.facebook.profile')}</option>
                <option value="search">{t('kinds.facebook.search')}</option>
              </select>
              <span style={{ fontSize: '0.78rem', color: 'var(--text-light)' }}>
                {t('form.facebookKindHelp')}
              </span>
            </label>
          )}
          {draft.source_type === 'instagram' && (
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-light)' }}>{t('form.instagramKind')}</span>
              <select
                className="filter-select"
                value={draft.instagram_kind}
                onChange={(e) => setDraft((prev) => ({ ...prev, instagram_kind: e.target.value }))}
              >
                <option value="profile">{t('kinds.instagram.profile')}</option>
                <option value="hashtag">{t('kinds.instagram.hashtag')}</option>
                <option value="search">{t('kinds.instagram.search')}</option>
              </select>
              <span style={{ fontSize: '0.78rem', color: 'var(--text-light)' }}>
                {t('form.requiresApify')}
              </span>
            </label>
          )}
          {!TERM_SOURCE_TYPES.has(draft.source_type) && (
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-light)' }}>{t('form.sourceUrl')}</span>
              <input
                type="text"
                className="source-input"
                dir={URL_ONLY_SOURCE_TYPES.has(draft.source_type) ? 'ltr' : 'auto'}
                placeholder={
                  draft.source_type === 'reddit' && draft.reddit_kind === 'subreddit_search'
                    ? t('form.urlPlaceholders.redditSubredditSearch')
                    : t(URL_FIELD_PLACEHOLDERS[draft.source_type] || 'form.urlPlaceholders.default')
                }
                value={draft.url}
                onChange={(e) => setDraft((prev) => ({ ...prev, url: e.target.value }))}
              />
            </label>
          )}
          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-light)' }}>
              {t('form.displayName')}{!TERM_SOURCE_TYPES.has(draft.source_type) && <span style={{ textTransform: 'none', letterSpacing: 0 }}>{t('form.optional')}</span>}
            </span>
            <input
              type="text"
              className="source-input"
              dir={draft.source_type === 'username' ? 'ltr' : 'auto'}
              placeholder={t(TERM_SOURCE_PLACEHOLDERS[draft.source_type] || 'form.termPlaceholders.default')}
              value={draft.name}
              onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
            />
          </label>
          <div className="source-toggle-row">
            <div className="source-toggle-copy">
              <strong style={{ display: 'block', fontSize: '0.9rem', color: 'var(--text-dark)' }}>{t('form.statusTitle')}</strong>
              <span style={{ display: 'block', marginTop: 4, fontSize: '0.82rem', color: 'var(--text-light)' }}>
                {t('form.statusHelp')}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setDraft((prev) => ({ ...prev, enabled: !prev.enabled }))}
              className={`btn-secondary source-toggle-btn ${draft.enabled ? 'active' : ''}`}
              style={{
                background: draft.enabled ? 'rgba(46, 213, 115, 0.12)' : 'rgba(116, 125, 140, 0.12)',
                borderColor: draft.enabled ? 'rgba(46, 213, 115, 0.24)' : 'rgba(116, 125, 140, 0.16)',
                color: draft.enabled ? '#1e9e57' : '#5f6b7a',
              }}
            >
              {draft.enabled ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
              {draft.enabled ? t('sourceStatus.enabled') : t('sourceStatus.disabled')}
            </button>
          </div>

          <div className="source-toggle-row">
            <div className="source-toggle-copy">
              <strong style={{ display: 'block', fontSize: '0.9rem', color: 'var(--text-dark)' }}>{t('form.reachTitle')}</strong>
              <span style={{ display: 'block', marginTop: 4, fontSize: '0.82rem', color: 'var(--text-light)' }}>
                {t('form.reachHelp')}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setDraft((prev) => ({ ...prev, limited: !prev.limited }))}
              className={`btn-secondary source-toggle-btn ${draft.limited ? 'active' : ''}`}
              style={{
                background: draft.limited ? 'rgba(255, 159, 67, 0.14)' : 'rgba(46, 134, 222, 0.1)',
                borderColor: draft.limited ? 'rgba(255, 159, 67, 0.28)' : 'rgba(46, 134, 222, 0.24)',
                color: draft.limited ? 'var(--primary-color)' : '#2e86de',
              }}
            >
              {draft.limited ? <ToggleLeft size={18} /> : <ToggleRight size={18} />}
              {draft.limited ? t('reach.limited') : t('reach.global')}
            </button>
          </div>

          <div className="assign-sources-panel">
            <div className="assign-sources-header">
              <div>
                <div className="assign-sources-kicker">{t('form.assignKicker')}</div>
                <strong className="assign-sources-title">{t('form.assignTitle')}</strong>
              </div>
              <div className="assign-sources-summary">
                <span className="panel-chip">{t('form.selectedCount', { count: draft.project_ids.length })}</span>
              </div>
            </div>

            <div className="assign-sources-toolbar">
              <label className="assign-sources-search">
                <Search size={14} />
                <input
                  type="text"
                  value={projectAssignQuery}
                  onChange={(e) => setProjectAssignQuery(e.target.value)}
                  dir="auto"
                  placeholder={t('form.filterProjects')}
                />
              </label>
            </div>

            <div className="assign-sources-list">
              {projects.length === 0 ? (
                <div className="admin-empty-state" style={{ padding: '16px 10px' }}>
                  <div className="admin-empty-state-icon" style={{ width: 36, height: 36 }}>
                    <Layers3 size={16} />
                  </div>
                  <strong>{t('form.noProjectsTitle')}</strong>
                  <span>{t('form.noProjectsHint')}</span>
                </div>
              ) : visibleAssignableProjects.length === 0 ? (
                <div className="admin-empty-state" style={{ padding: '16px 10px' }}>
                  <div className="admin-empty-state-icon" style={{ width: 36, height: 36 }}>
                    <Search size={16} />
                  </div>
                  <strong>{t('form.noMatchingProjectsTitle')}</strong>
                  <span>{t('form.noMatchingProjectsHint')}</span>
                </div>
              ) : (
                visibleAssignableProjects.map((project) => {
                  const isSelected = draft.project_ids.includes(Number(project.id));
                  return (
                    <label key={project.id} className={`assign-source-item ${isSelected ? 'selected' : ''}`}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleProject(project.id)}
                      />
                      <div className="assign-source-copy">
                        <div className="assign-source-topline">
                          <strong className="assign-source-name" dir="auto">{project.name}</strong>
                          <span className="panel-chip">
                            {t(`common:status.${project.status || 'draft'}`, { defaultValue: project.status || 'draft' })}
                          </span>
                        </div>
                      </div>
                    </label>
                  );
                })
              )}
            </div>
          </div>

          <div className="source-form-actions">
            <button className="btn-primary" onClick={submit}>
              {editingId ? (
                <>
                  <Check size={18} /> {buttonLabel}
                </>
              ) : (
                <>
                  <Plus size={18} /> {buttonLabel}
                </>
              )}
            </button>
            <button className="btn-secondary" type="button" onClick={handleCancel}>
              <X size={18} /> {t('common:actions.cancel')}
            </button>
          </div>
        </div>

        <ConfirmModal
          open={showCancelModal}
          title={t('form.discardTitle')}
          message={t('form.discardMessage')}
          confirmLabel={t('form.discardConfirm')}
          cancelLabel={t('form.keepEditing')}
          onClose={() => setShowCancelModal(false)}
          onConfirm={discardChanges}
        />

      </div>
    );
  }

  return (
    <div className="admin-page-shell">
      <div className="admin-page-header">
        <div>
          <div className="admin-page-kicker">
            <Rss size={14} /> {t('kicker')}
          </div>
          <h1 className="admin-page-title">{t('list.title')}</h1>
          <p className="admin-page-subtitle">
            {t('list.subtitle')}
          </p>
        </div>
        <div className="admin-page-toolbar">
          <div className="admin-page-toolbar-meta">
            <span>{t('list.dataSource')}</span>
            <strong className="ltr-isolate">{sourcesSource || 'supabase'}</strong>
          </div>
          <div className="admin-page-toolbar-meta">
            <span>{t('list.search')}</span>
            <strong>{t('list.matches', { count: visibleSources.length, formatted: formatNumber(visibleSources.length) })}</strong>
          </div>
          {canEdit && (
            <Link to="/sources/new" className="btn-primary" style={{ textDecoration: 'none' }}>
              <Plus size={16} /> {t('list.addSource')}
            </Link>
          )}
        </div>
      </div>

      <ErrorNotice error={actionError} context={t('errorContext.manage')} onDismiss={() => setActionError('')} />

      <div className="admin-stats-grid">
        <div className="admin-stat-card">
          <div className="admin-stat-icon">
            <Layers3 size={18} />
          </div>
          <div>
            <span>{t('list.stats.total')}</span>
            <strong>{formatNumber(stats.total)}</strong>
          </div>
        </div>
        <div className="admin-stat-card">
          <div className="admin-stat-icon" style={{ background: 'rgba(46, 213, 115, 0.12)', color: '#2ed573' }}>
            <CheckCircle2 size={18} />
          </div>
          <div>
            <span>{t('list.stats.enabled')}</span>
            <strong>{formatNumber(stats.enabled)}</strong>
          </div>
        </div>
        <div className="admin-stat-card">
          <div className="admin-stat-icon" style={{ background: 'rgba(46, 134, 222, 0.12)', color: 'var(--secondary-color)' }}>
            <Link2 size={18} />
          </div>
          <div>
            <span>{t('list.stats.assigned')}</span>
            <strong>{formatNumber(stats.assigned)}</strong>
          </div>
        </div>
        <div className="admin-stat-card">
          <div className="admin-stat-icon" style={{ background: 'rgba(255, 159, 67, 0.14)', color: 'var(--primary-color)' }}>
            <Rss size={18} />
          </div>
          <div>
            <span>{t('list.stats.rss')}</span>
            <strong>{formatNumber(stats.rss)}</strong>
          </div>
        </div>
      </div>

      <div className="source-type-tabs" role="tablist" aria-label={t('list.filterByType')}>
        {SOURCE_TYPE_TABS.map((tab) => {
          const isActive = typeFilter === tab.value;
          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`source-type-tab ${isActive ? 'active' : ''}`}
              onClick={() => setTypeFilter(tab.value)}
            >
              {tab.value === 'all' ? t('common:status.all') : t(`types.${tab.value}`)}
              <span className="source-type-tab-count">{formatNumber(sourceTypeTabCounts[tab.value] || 0)}</span>
            </button>
          );
        })}
      </div>

      <div className="admin-toolbar-row">
        <label className="admin-search">
          <Search size={16} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            dir="auto"
            placeholder={t('list.searchPlaceholder')}
          />
        </label>

        <select className="filter-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">{t('list.statusFilter.all')}</option>
          <option value="enabled">{t('list.statusFilter.enabled')}</option>
          <option value="disabled">{t('list.statusFilter.disabled')}</option>
          <option value="assigned">{t('list.statusFilter.assigned')}</option>
          <option value="unassigned">{t('list.statusFilter.unassigned')}</option>
        </select>

        <select className="filter-select" value={reachFilter} onChange={(e) => setReachFilter(e.target.value)}>
          <option value="all">{t('list.reachFilter.all')}</option>
          <option value="global">{t('list.reachFilter.global')}</option>
          <option value="limited">{t('list.reachFilter.limited')}</option>
        </select>
      </div>

      <div className="glass-card admin-list-panel">
        <div className="panel-header-tight">
          <strong style={{ fontSize: '1rem' }}>{t('list.trackedSources')}</strong>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {isLoadingSources && <span style={{ fontSize: '0.72rem', color: 'var(--text-light)' }}>{t('common:status.loading')}</span>}
            <span className="panel-chip">{t('list.visibleCount', { count: visibleSources.length, formatted: formatNumber(visibleSources.length) })}</span>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {sources.length === 0 && !isLoadingSources && (
            <div className="admin-empty-state">
              <div className="admin-empty-state-icon">
                <Rss size={18} />
              </div>
              <strong>{t('list.emptyTitle')}</strong>
              <span>{t('list.emptyHint')}</span>
              {canEdit && (
                <Link to="/sources/new" className="btn-primary" style={{ marginTop: 8, textDecoration: 'none' }}>
                  <Plus size={16} /> {t('list.addSource')}
                </Link>
              )}
            </div>
          )}

          {pagedSources.map((source, index) => {
            const sourceProjects = sourceProjectsById.get(Number(source.id)) || [];
            return (
              <motion.div
                key={source.id ?? source.url}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.03 }}
                className="admin-item-card"
              >
                <div className="admin-item-top">
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
                      <strong className="admin-item-title" dir="auto">{source.name || source.url?.replace('https://www.', '')}</strong>
                      <span className={`panel-chip ${source.enabled ? 'success' : 'muted'}`}>
                        {source.enabled ? t('sourceStatus.enabled') : t('sourceStatus.disabled')}
                      </span>
                      {source.limited && <span className="panel-chip warning">{t('reach.limited')}</span>}
                    </div>
                    <div className="admin-item-url ltr-isolate">{source.url}</div>
                    <div className="admin-item-meta">
                      <span>{sourceTypeLabel(t, source.source_type)}</span>
                      <span>
                        {t('list.projectCount', { count: sourceProjects.length })}
                      </span>
                    </div>
                  </div>

                  {canEdit && (
                    <div className="admin-item-actions">
                      <Link
                        className="btn-secondary"
                        to={`/sources/${source.id}/edit`}
                        style={{ padding: '8px 10px', fontSize: '0.8rem', textDecoration: 'none' }}
                      >
                        <Pencil size={14} /> {t('common:actions.edit')}
                      </Link>
                      <button
                        className="btn-secondary"
                        onClick={() => setDeleteTarget(source)}
                        style={{ padding: '8px 10px', fontSize: '0.8rem', color: '#ff4757' }}
                      >
                        <Trash2 size={14} /> {t('common:actions.delete')}
                      </button>
                    </div>
                  )}
                </div>
                <div className="admin-item-chips">
                  {sourceProjects.length ? (
                    sourceProjects.slice(0, 4).map((project) => (
                      <span key={project.id} className="admin-tag" dir="auto">
                        {project.name}
                      </span>
                    ))
                  ) : (
                    <span className="admin-tag muted">{t('list.unassigned')}</span>
                  )}
                </div>
              </motion.div>
            );
          })}

          {!isLoadingSources && visibleSources.length === 0 && sources.length > 0 && (
            <div className="admin-empty-state">
              <div className="admin-empty-state-icon">
                <Search size={18} />
              </div>
              <strong>{t('list.noMatchesTitle')}</strong>
              <span>{t('list.noMatchesHint')}</span>
            </div>
          )}
        </div>

        {visibleSources.length > 0 && (
          <div className="source-pagination">
            <div className="source-pagination-info">
              {t('common:pagination.showing', {
                from: formatNumber((safePage - 1) * PAGE_SIZE + 1),
                to: formatNumber(Math.min(safePage * PAGE_SIZE, visibleSources.length)),
                total: formatNumber(visibleSources.length),
              })}
            </div>
            <div className="source-pagination-controls">
              <button
                className="btn-secondary"
                onClick={() => setCurrentPage((value) => Math.max(1, value - 1))}
                disabled={safePage <= 1}
                style={{ padding: '8px 10px', fontSize: '0.8rem' }}
              >
                {t('common:actions.previous')}
              </button>
              <span className="panel-chip">
                {t('common:pagination.page', { page: formatNumber(safePage), total: formatNumber(totalPages) })}
              </span>
              <button
                className="btn-secondary"
                onClick={() => setCurrentPage((value) => Math.min(totalPages, value + 1))}
                disabled={safePage >= totalPages}
                style={{ padding: '8px 10px', fontSize: '0.8rem' }}
              >
                {t('common:actions.next')}
              </button>
            </div>
          </div>
        )}

        <ConfirmModal
          open={Boolean(deleteTarget)}
          title={t('list.deleteTitle', { name: isolate(deleteTarget?.name || deleteTarget?.url || '') })}
          message={t('list.deleteMessage')}
          confirmLabel={t('list.deleteConfirm')}
          cancelLabel={t('list.keepSource')}
          confirmButtonStyle={{
            background: 'linear-gradient(135deg, #ff4757, #e03131)',
            boxShadow: '0 4px 15px rgba(255, 71, 87, 0.28)',
          }}
          onClose={() => setDeleteTarget(null)}
          onConfirm={async () => {
            if (!deleteTarget) return;
            const target = deleteTarget;
            setDeleteTarget(null);
            await remove(target);
          }}
        />
      </div>
    </div>
  );
}
