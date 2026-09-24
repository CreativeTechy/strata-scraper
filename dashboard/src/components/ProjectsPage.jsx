import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Trans, useTranslation } from 'react-i18next';
import ConfirmModal from './ConfirmModal';
import ErrorNotice from './ErrorNotice';
import { useAuth } from '../auth/useAuth.js';
import { REPEAT_UNIT_OPTIONS } from '../constants/schedule.js';
import { apiError } from '../errors/apiError.js';
import i18n from '../i18n/index.js';
import { formatDate, formatDateTime, formatList, formatNumber } from '../i18n/format.js';
import '../styles/Projects.css';
import {
  CalendarDays,
  Eye,
  Plus,
  Check,
  X,
  Search,
  Flag,
  Clock3,
  Layers3,
  Link2,
  RefreshCw,
  Sparkles,
  Rss,
  Users,
} from 'lucide-react';

const emptyNewSourceDraft = {
  url: '',
  name: '',
  source_type: 'rss',
  reddit_kind: 'subreddit',
  linkedin_kind: 'company',
  threads_kind: 'profile',
  facebook_kind: 'page',
  instagram_kind: 'profile',
};

// No "Social" option - the backend has no dedicated scraping tier for
// TikTok/YouTube/etc, so a URL on any of those platforms is just stored
// (and crawled) as a "web" source instead (see
// backend/app/core/settings.py's _infer_source_type/_resolve_source_type,
// which reassigns any entered URL to its real platform type regardless of
// what was picked here). Values are the stable API codes; labels come from
// projects:sourceTypes.<value> at render time (sourceTypeLabel).
const SOURCE_TYPE_OPTIONS = [
  'rss',
  'web',
  'hashtag',
  'keyword',
  'username',
  'tweet',
  'reddit',
  'telegram',
  'linkedin',
  'threads',
  'facebook',
  'instagram',
].map((value) => ({ value }));

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

// The "New source" mini-form below groups hashtag/username/tweet under one
// "Twitter/X" tab (all three are X-only concepts - see
// backend/services/sources/sources_store.py's _derive_term_url/
// _derive_tweet_url) - picking a specific one happens via
// TWITTER_SUB_TYPE_OPTIONS, same pattern as the reddit/linkedin kind
// selectors. "keyword" stays its own top-level tab (see TWITTER_SOURCE_TYPES
// above). SOURCE_ASSIGN_TABS (the filter tabs over the existing source pool)
// keeps every type separate, since filtering by exact type still matters
// there.
const SOURCE_TYPE_FORM_TABS = [
  'rss',
  'web',
  'keyword',
  'twitter',
  'reddit',
  'telegram',
  'linkedin',
  'threads',
  'facebook',
  'instagram',
].map((value) => ({ value }));

const TWITTER_SUB_TYPE_OPTIONS = ['hashtag', 'username', 'tweet'].map((value) => ({ value }));

// Types with a term placeholder (projects:wizard.newSource.termPlaceholders.<type>).
const TERM_SOURCE_PLACEHOLDER_TYPES = new Set(['hashtag', 'username', 'keyword']);

// Reddit/Telegram/LinkedIn/tweet keep the URL field (unlike the term types
// above) since it doubles as a free-form input that accepts short forms (a
// bare subreddit/company/profile slug or search phrase, disambiguated by the
// kind selector below) as well as full URLs. A tweet has no short form - the
// full status URL is the only valid input. Placeholder text lives in
// projects:wizard.newSource.urlPlaceholders.<type>.
const URL_FIELD_PLACEHOLDER_TYPES = new Set(['reddit', 'telegram', 'linkedin', 'tweet', 'threads', 'facebook', 'instagram']);

// Called during render, so it follows the active UI language.
function sourceTypeLabel(sourceType) {
  const type = sourceType || 'rss';
  return i18n.t(`projects:sourceTypes.${type}`, { defaultValue: sourceType || 'RSS' });
}

// "keyword" sources are crawled as a bare Google News/GDELT/CSE search query
// (see backend/services/sources/sources_store.py's _derive_term_url), so a
// generic term like "coffee" alone returns industry-wide news, not news
// about this project. Prefixing the project name scopes the query to the
// project (e.g. "Starbucks coffee") instead. Hashtag/username terms already
// resolve to a specific page (an X hashtag/profile), not a search query, so
// they don't need this.
function scopeKeywordTerm(projectName, term, sourceType) {
  const trimmedTerm = (term || '').trim();
  if (sourceType !== 'keyword') return trimmedTerm;
  const trimmedName = (projectName || '').trim();
  if (!trimmedName || trimmedTerm.toLowerCase().includes(trimmedName.toLowerCase())) return trimmedTerm;
  return `${trimmedName} ${trimmedTerm}`.trim();
}

const SOURCE_ASSIGN_TABS = [{ value: 'all' }, ...SOURCE_TYPE_OPTIONS];

// Labels: projects:discovery.steps.<key> (chips) and
// projects:discovery.phases.<key> (the AI button while a phase runs).
const DISCOVERY_STEPS = ['suggesting', 'prefilling', 'syncing', 'success'].map((key) => ({ key }));

function sourceMatchesQuery(source, needle) {
  if (!needle) return true;
  return [
    source.name,
    source.url,
    source.source_type,
    source.enabled ? 'enabled' : 'disabled',
    // Also match the labels as shown in the active UI language.
    sourceTypeLabel(source.source_type),
    i18n.t(source.enabled ? 'projects:sourceState.enabled' : 'projects:sourceState.disabled'),
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
}

const emptyDraft = {
  name: '',
  status: 'draft',
  description: '',
  location: '',
  location_type: '',
  target_audience: '',
  usernames: [],
  hashtags: [],
  keywords: [],
  start_date: '',
  end_date: '',
  source_ids: [],
  user_ids: [],
  repeat_enabled: false,
  repeat_interval_value: 30,
  repeat_interval_unit: 'minutes',
  first_run_at: '',
  repeat_weekdays: [],
};

const STATUS_OPTIONS = ['draft', 'active', 'archived'];
// value = stable API code; labelKey = projects:locationTypes.<labelKey>.
const LOCATION_TYPE_OPTIONS = [
  { value: 'on_site', labelKey: 'onSite' },
  { value: 'remote', labelKey: 'remote' },
  { value: 'hybrid', labelKey: 'hybrid' },
];
// Labels: projects:weekdays.<value> / projects:weekdaysShort.<value>.
const WEEKDAY_OPTIONS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((value) => ({ value }));
const PAGE_SIZE = 10;

function statusLabel(status) {
  return i18n.t(`projects:statuses.${status}`, { defaultValue: status });
}

function weekdayLabel(day) {
  return i18n.t(`projects:weekdays.${day}`, { defaultValue: day });
}

// "30 minutes" / "minute" - the phrase that follows "every" ("كل") for a
// repeat interval.
function intervalLabel(value, unit) {
  const count = Number(value);
  return i18n.t(`projects:intervalUnits.${unit}`, { count, defaultValue: `${value} ${unit}` });
}

// Project start/end dates are date-only ("2026-01-31"), which Date parses as
// UTC midnight - format those in UTC so they don't shift a day west of UTC.
function formatProjectDate(value) {
  if (!value) return '';
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(value));
  return formatDate(
    value,
    { year: 'numeric', month: 'short', day: 'numeric', ...(dateOnly ? { timeZone: 'UTC' } : {}) },
    String(value)
  );
}

function repeatSummary(draft) {
  const value = Number(draft.repeat_interval_value);
  if (!draft.repeat_enabled || !Number.isFinite(value) || value <= 0) return '';
  const interval = intervalLabel(value, draft.repeat_interval_unit);
  const weekdays = Array.isArray(draft.repeat_weekdays) ? draft.repeat_weekdays : [];
  return weekdays.length
    ? i18n.t('projects:schedule.repeatSummaryOnDays', { interval, days: formatList(weekdays.map(weekdayLabel)) })
    : i18n.t('projects:schedule.repeatSummary', { interval });
}

function toDateInput(value) {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString().slice(0, 10);
}

function toDateTimeLocalInput(value) {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const year = parsed.getFullYear();
  const month = pad(parsed.getMonth() + 1);
  const day = pad(parsed.getDate());
  const hours = pad(parsed.getHours());
  const minutes = pad(parsed.getMinutes());
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function fromDateTimeLocalInput(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function sanitizeTermArray(values) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map((item) => String(item || '').trim())
        .filter(Boolean)
    ),
  ];
}

function normalizeTermListForCompare(values) {
  return sanitizeTermArray(values).sort();
}

function normalizeDraftForCompare(value) {
  return {
    name: String(value?.name || '').trim(),
    status: String(value?.status || 'draft').trim().toLowerCase(),
    description: String(value?.description || '').trim(),
    location: String(value?.location || '').trim(),
    location_type: String(value?.location_type || '').trim().toLowerCase(),
    target_audience: String(value?.target_audience || '').trim(),
    usernames: normalizeTermListForCompare(value?.usernames),
    hashtags: normalizeTermListForCompare(value?.hashtags),
    keywords: normalizeTermListForCompare(value?.keywords),
    start_date: String(value?.start_date || ''),
    end_date: String(value?.end_date || ''),
    source_ids: Array.isArray(value?.source_ids)
      ? [...new Set(value.source_ids.map((item) => Number(item)).filter((item) => Number.isFinite(item)))].sort((a, b) => a - b)
      : [],
    user_ids: Array.isArray(value?.user_ids)
      ? [...new Set(value.user_ids.map((item) => Number(item)).filter((item) => Number.isFinite(item)))].sort((a, b) => a - b)
      : [],
    repeat_enabled: Boolean(value?.repeat_enabled),
    repeat_interval_value: Number(value?.repeat_interval_value) || 0,
    repeat_interval_unit: String(value?.repeat_interval_unit || 'minutes').trim().toLowerCase(),
    first_run_at: String(value?.first_run_at || ''),
    repeat_weekdays: normalizeTermListForCompare(value?.repeat_weekdays),
  };
}

function ErrorBanner({ message }) {
  const { t } = useTranslation('projects');
  return <ErrorNotice error={message} context={t('errorContext.updateProject')} compact />;
}

function TermChipsField({ label, placeholder, values, onChange, options = [], disabled, hint }) {
  const { t } = useTranslation('projects');
  const [manualValue, setManualValue] = useState('');

  const availableOptions = useMemo(
    () => options.filter((option) => !values.includes(option)),
    [options, values]
  );

  const addValue = (raw) => {
    const trimmed = String(raw || '').trim();
    if (!trimmed || values.includes(trimmed)) return;
    onChange([...values, trimmed]);
  };

  const removeValue = (value) => {
    onChange(values.filter((item) => item !== value));
  };

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <label style={{ fontSize: '0.82rem', color: 'var(--text-light)' }}>{label}</label>
      {values.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {values.map((value) => (
            <span
              key={value}
              className="panel-chip"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%', overflowWrap: 'anywhere' }}
            >
              <bdi>{value}</bdi>
              <button
                type="button"
                onClick={() => removeValue(value)}
                disabled={disabled}
                aria-label={t('terms.remove', { value })}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  cursor: disabled ? 'default' : 'pointer',
                  color: 'inherit',
                }}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          addValue(manualValue);
          setManualValue('');
        }}
        style={{ display: 'flex', gap: 6 }}
      >
        <input
          type="text"
          className="source-input"
          placeholder={placeholder}
          value={manualValue}
          onChange={(e) => setManualValue(e.target.value)}
          disabled={disabled}
          dir="auto"
          style={{ flex: 1 }}
        />
        <button
          type="submit"
          className="btn-secondary"
          disabled={disabled || !manualValue.trim()}
          aria-label={t('terms.add')}
          style={{ padding: '8px 10px' }}
        >
          <Plus size={14} />
        </button>
      </form>
      {availableOptions.length > 0 && (
        <select
          className="filter-select"
          value=""
          onChange={(e) => {
            if (e.target.value) addValue(e.target.value);
          }}
          disabled={disabled}
        >
          <option value="">{t('terms.addFromExisting')}</option>
          {availableOptions.map((option) => (
            <option key={option} value={option} dir="auto">
              {option}
            </option>
          ))}
        </select>
      )}
      {hint && (
        <span style={{ fontSize: '0.76rem', color: 'var(--text-light)', lineHeight: 1.4 }}>{hint}</span>
      )}
    </div>
  );
}

export function WeekdayPicker({ values, onChange, disabled }) {
  const { t } = useTranslation('projects');
  const toggleDay = (day) => {
    onChange(values.includes(day) ? values.filter((value) => value !== day) : [...values, day]);
  };

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <span style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-light)' }}>
        {t('schedule.repeatOnDays')}
      </span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {WEEKDAY_OPTIONS.map((option) => {
          const active = values.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              className={`btn-secondary ${active ? 'active' : ''}`}
              onClick={() => toggleDay(option.value)}
              disabled={disabled}
              style={{ padding: '8px 12px', fontSize: '0.8rem' }}
              title={t(`weekdays.${option.value}`)}
            >
              {t(`weekdaysShort.${option.value}`)}
            </button>
          );
        })}
      </div>
      <span style={{ fontSize: '0.78rem', color: 'var(--text-light)' }}>
        {values.length ? t('schedule.restrictedDays', { count: values.length }) : t('schedule.anyDay')}
      </span>
    </div>
  );
}

function UserAssignField({ users, selectedIds, onToggle, query, onQueryChange, disabled }) {
  const { t } = useTranslation('projects');
  const visibleUsers = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return users;
    return users.filter((user) =>
      [user.username, user.email, user.role].filter(Boolean).some((value) => String(value).toLowerCase().includes(needle))
    );
  }, [users, query]);

  return (
    <div className="assign-sources-panel">
      <div className="assign-sources-header">
        <div>
          <div className="assign-sources-kicker">
            <Users size={12} style={{ verticalAlign: -1, marginInlineEnd: 4 }} /> {t('users.kicker')}
          </div>
          <strong className="assign-sources-title">{t('users.title')}</strong>
        </div>
        <div className="assign-sources-summary">
          <span className="panel-chip">{t('users.selected', { n: selectedIds.length })}</span>
        </div>
      </div>

      <div className="assign-sources-toolbar">
        <label className="assign-sources-search">
          <Search size={14} />
          <input
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={t('users.filterPlaceholder')}
            disabled={disabled}
            dir="auto"
          />
        </label>
      </div>

      <div className="assign-sources-list">
        {users.length === 0 ? (
          <div style={{ color: 'var(--text-light)', fontSize: '0.85rem' }}>
            {t('users.empty')}
          </div>
        ) : visibleUsers.length === 0 ? (
          <div className="admin-empty-state" style={{ padding: '16px 10px' }}>
            <div className="admin-empty-state-icon" style={{ width: 36, height: 36 }}>
              <Search size={16} />
            </div>
            <strong>{t('users.noMatchesTitle')}</strong>
            <span>{t('users.noMatchesHint')}</span>
          </div>
        ) : (
          visibleUsers.map((user) => {
            const userId = Number(user.id);
            const isSelected = selectedIds.includes(userId);
            return (
              <label key={user.id} className={`assign-source-item ${isSelected ? 'selected' : ''}`}>
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onToggle(userId)}
                  disabled={disabled}
                />
                <div className="assign-source-copy">
                  <div className="assign-source-topline">
                    <strong className="assign-source-name project-term-name" dir="auto">{user.username}</strong>
                    <span className={`panel-chip role-${user.role}`}>
                      {t(`common:roleNames.${user.role}`, { defaultValue: user.role })}
                    </span>
                  </div>
                  {user.email ? (
                    <div className="assign-source-url ltr-isolate">{user.email}</div>
                  ) : (
                    <div className="assign-source-url">{t('users.noEmail')}</div>
                  )}
                </div>
              </label>
            );
          })
        )}
      </div>
    </div>
  );
}

export default function ProjectsPage({
  projects = [],
  sources = [],
  users = [],
  onCreateProject,
  onUpdateProject,
  onCreateSource,
  onRefreshSources,
  isLoadingProjects,
}) {
  const { t } = useTranslation('projects');
  const location = useLocation();
  const navigate = useNavigate();
  const params = useParams();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('projects.create') || hasPermission('projects.update') || hasPermission('projects.delete');
  const canLinkUsers = hasPermission('projects.link_users');
  // Built rather than hardcoded because 'users' only exists for someone who
  // can link them - every later step's number shifts with it.
  const STEP = useMemo(() => {
    const keys = ['basics', ...(canLinkUsers ? ['users'] : []), 'discovery', 'schedule', 'sources'];
    return Object.fromEntries(keys.map((key, index) => [key, index + 1]));
  }, [canLinkUsers]);
  const pathname = location.pathname;
  const isCreateRoute = pathname.endsWith('/new');
  const isEditRoute = pathname.endsWith('/edit');
  const isFormRoute = isCreateRoute || isEditRoute;
  const editingId = isEditRoute ? Number(params.projectId) : null;
  const currentProject = useMemo(
    () => (editingId != null ? projects.find((project) => Number(project.id) === Number(editingId)) || null : null),
    [editingId, projects]
  );

  const [draft, setDraft] = useState(emptyDraft);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [isSaving, setIsSaving] = useState(false);
  const [lastDiscovery, setLastDiscovery] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [sourceAssignQuery, setSourceAssignQuery] = useState('');
  const [activeSourceTab, setActiveSourceTab] = useState('all');
  const [userAssignQuery, setUserAssignQuery] = useState('');
  const [initialDraft, setInitialDraft] = useState(emptyDraft);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [wizardStep, setWizardStep] = useState(1);
  const [fillMode, setFillMode] = useState('');
  const [isGeneratingMetadata, setIsGeneratingMetadata] = useState(false);
  const [discoveryPhase, setDiscoveryPhase] = useState('idle');
  const [showDiscoverySuccessModal, setShowDiscoverySuccessModal] = useState(false);
  const discoveryPhaseTimersRef = useRef([]);
  // Id of the project currently loaded into the draft - lets the reset effect
  // below tell "switched to a different project" apart from "the same
  // project's array reference changed" (e.g. syncTermSourcesToDraft's
  // onCreateSource call triggers a projects refetch mid-wizard), which would
  // otherwise wipe in-progress edits and kick the wizard back to step 1.
  const loadedProjectIdRef = useRef(null);
  const [metadataError, setMetadataError] = useState('');
  const [showNewSourceForm, setShowNewSourceForm] = useState(false);
  const [newSourceDraft, setNewSourceDraft] = useState(emptyNewSourceDraft);
  const [isCreatingSource, setIsCreatingSource] = useState(false);
  const [newSourceError, setNewSourceError] = useState('');
  const [isSyncingSources, setIsSyncingSources] = useState(false);

  const clearDiscoveryPhaseTimers = () => {
    discoveryPhaseTimersRef.current.forEach(clearTimeout);
    discoveryPhaseTimersRef.current = [];
  };

  useEffect(() => () => clearDiscoveryPhaseTimers(), []);

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

  const assignableSources = useMemo(() => {
    const selected = new Set(draft.source_ids.map((id) => Number(id)));
    return sources.filter((source) => !source.limited || selected.has(Number(source.id)));
  }, [sources, draft.source_ids]);

  const globalTermOptions = useMemo(() => {
    const nonLimitedSources = sources.filter((source) => !source.limited);
    const optionsForType = (sourceType) =>
      [
        ...new Set(
          nonLimitedSources
            .filter((source) => source.source_type === sourceType)
            .map((source) => String(source.name || '').trim())
            .filter(Boolean)
        ),
      ];
    return {
      username: optionsForType('username'),
      hashtag: optionsForType('hashtag'),
      keyword: optionsForType('keyword'),
    };
  }, [sources]);

  // Both the create wizard's Step 4 and the edit form's assign-sources block scope
  // selection/search to whichever source-type tab is active.
  const sourceTabCounts = useMemo(() => {
    const counts = { all: assignableSources.length };
    SOURCE_TYPE_OPTIONS.forEach((option) => {
      counts[option.value] = assignableSources.filter((source) => (source.source_type || 'rss') === option.value).length;
    });
    return counts;
  }, [assignableSources]);

  const sourcesForActiveTab = useMemo(() => {
    if (activeSourceTab === 'all') return assignableSources;
    return assignableSources.filter((source) => (source.source_type || 'rss') === activeSourceTab);
  }, [assignableSources, activeSourceTab]);

  const visibleSourcesForActiveTab = useMemo(() => {
    const needle = sourceAssignQuery.trim().toLowerCase();
    return sourcesForActiveTab.filter((source) => sourceMatchesQuery(source, needle));
  }, [sourcesForActiveTab, sourceAssignQuery]);

  const selectedSourceCount = draft.source_ids.length;
  const visibleSelectedCountForActiveTab = visibleSourcesForActiveTab.filter((source) => draft.source_ids.includes(Number(source.id))).length;
  const allVisibleSelectedForActiveTab = visibleSourcesForActiveTab.length > 0 && visibleSelectedCountForActiveTab === visibleSourcesForActiveTab.length;

  const stats = useMemo(() => {
    const total = projects.length;
    const active = projects.filter((project) => (project.status || '').toLowerCase() === 'active').length;
    const draftCount = projects.filter((project) => (project.status || '').toLowerCase() === 'draft').length;
    const archived = projects.filter((project) => (project.status || '').toLowerCase() === 'archived').length;
    const assignedSources = new Set(projects.flatMap((project) => (project.source_ids || []).map(Number))).size;
    return { total, active, draftCount, archived, assignedSources };
  }, [projects]);

  const visibleProjects = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return projects.filter((project) => {
      const hashtagNames = (project.hashtags || []).map((value) => String(value).trim()).filter(Boolean);
      const keywordNames = (project.keywords || []).map((value) => String(value).trim()).filter(Boolean);
      const usernameNames = (project.usernames || []).map((value) => String(value).trim()).filter(Boolean);
      const matchesQuery =
        !needle ||
        [
          project.name,
          project.status,
          statusLabel(project.status || 'draft'),
          project.description,
          project.location,
          project.target_audience,
          project.start_date,
          project.end_date,
          ...hashtagNames,
          ...keywordNames,
          ...usernameNames,
        ]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(needle));
      const matchesStatus = statusFilter === 'all' || (project.status || 'draft').toLowerCase() === statusFilter;
      return matchesQuery && matchesStatus;
    });
  }, [projects, query, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(visibleProjects.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const pagedProjects = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return visibleProjects.slice(start, start + PAGE_SIZE);
  }, [visibleProjects, safePage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [query, statusFilter]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  useEffect(() => {
    if (!isFormRoute) {
      loadedProjectIdRef.current = null;
      setDraft(emptyDraft);
      setLastDiscovery(null);
      setInitialDraft(emptyDraft);
      setShowCancelModal(false);
      setWizardStep(1);
      setFillMode('');
      setIsGeneratingMetadata(false);
      clearDiscoveryPhaseTimers();
      setDiscoveryPhase('idle');
      setShowDiscoverySuccessModal(false);
      setMetadataError('');
      setShowNewSourceForm(false);
      setNewSourceDraft(emptyNewSourceDraft);
      setNewSourceError('');
      setActiveSourceTab('all');
      return;
    }

    if (isEditRoute) {
      if (!currentProject) {
        if (loadedProjectIdRef.current !== editingId) {
          setDraft(emptyDraft);
          setInitialDraft(emptyDraft);
        }
        return;
      }

      if (loadedProjectIdRef.current === Number(currentProject.id)) {
        // Same project already loaded - this fired only because the projects
        // array got a new reference (e.g. a source-creation refetch), not
        // because the user switched projects. Leave the in-progress draft
        // and wizard step alone.
        return;
      }
      loadedProjectIdRef.current = Number(currentProject.id);

      const draftFromProject = {
        name: currentProject.name || '',
        status: currentProject.status || 'draft',
        description: currentProject.description || '',
        location: currentProject.location || '',
        location_type: currentProject.location_type || '',
        target_audience: currentProject.target_audience || '',
        usernames: sanitizeTermArray(currentProject.usernames),
        hashtags: sanitizeTermArray(currentProject.hashtags),
        keywords: sanitizeTermArray(currentProject.keywords),
        start_date: toDateInput(currentProject.start_date),
        end_date: toDateInput(currentProject.end_date),
        source_ids: Array.isArray(currentProject.source_ids) ? currentProject.source_ids.map(Number) : [],
        user_ids: Array.isArray(currentProject.user_ids) ? currentProject.user_ids.map(Number) : [],
        repeat_enabled: Boolean(currentProject.repeat_enabled),
        repeat_interval_value: currentProject.repeat_interval_value || 30,
        repeat_interval_unit: currentProject.repeat_interval_unit || 'minutes',
        first_run_at: toDateTimeLocalInput(currentProject.first_run_at),
        repeat_weekdays: sanitizeTermArray(currentProject.repeat_weekdays),
      };
      setDraft(draftFromProject);
      setSourceAssignQuery('');
      setUserAssignQuery('');
      setActiveSourceTab('all');
      setLastDiscovery(null);
      setInitialDraft(draftFromProject);
      setWizardStep(STEP.basics);
      // An existing project already has its metadata filled in manually; default to the
      // "manual" fill mode so all wizard steps unlock immediately instead of forcing the
      // user to pick a fill method before they can see their own data.
      setFillMode('manual');
      setIsGeneratingMetadata(false);
      clearDiscoveryPhaseTimers();
      setDiscoveryPhase('idle');
      setShowDiscoverySuccessModal(false);
      setMetadataError('');
      setShowNewSourceForm(false);
      setNewSourceDraft(emptyNewSourceDraft);
      setNewSourceError('');
      return;
    }

    loadedProjectIdRef.current = null;
    setDraft(emptyDraft);
    setSourceAssignQuery('');
    setUserAssignQuery('');
    setLastDiscovery(null);
    setInitialDraft(emptyDraft);
    setWizardStep(1);
    setFillMode('');
    setIsGeneratingMetadata(false);
    clearDiscoveryPhaseTimers();
    setDiscoveryPhase('idle');
    setShowDiscoverySuccessModal(false);
    setMetadataError('');
    setShowNewSourceForm(false);
    setNewSourceDraft(emptyNewSourceDraft);
    setNewSourceError('');
    setActiveSourceTab('all');
  }, [currentProject, isEditRoute, isFormRoute, editingId, STEP.basics]);

  const discardChanges = () => {
    setShowCancelModal(false);
    setSourceAssignQuery('');
    setUserAssignQuery('');
    setActiveSourceTab('all');
    setDraft(emptyDraft);
    setLastDiscovery(null);
    navigate('/projects');
  };

  const toggleSource = (sourceId) => {
    const id = Number(sourceId);
    setDraft((prev) => ({
      ...prev,
      source_ids: prev.source_ids.includes(id)
        ? prev.source_ids.filter((value) => value !== id)
        : [...prev.source_ids, id],
    }));
  };

  const toggleUserLink = (userId) => {
    const id = Number(userId);
    setDraft((prev) => ({
      ...prev,
      user_ids: prev.user_ids.includes(id)
        ? prev.user_ids.filter((value) => value !== id)
        : [...prev.user_ids, id],
    }));
  };

  // Scoped to the sources visible in the active source-type tab.
  const selectAllSourcesForActiveTab = () => {
    setDraft((prev) => ({
      ...prev,
      source_ids: Array.from(new Set([...prev.source_ids, ...visibleSourcesForActiveTab.map((source) => Number(source.id))])),
    }));
  };

  const clearSourcesForActiveTab = () => {
    const visibleIds = new Set(visibleSourcesForActiveTab.map((source) => Number(source.id)));
    setDraft((prev) => ({
      ...prev,
      source_ids: prev.source_ids.filter((id) => !visibleIds.has(Number(id))),
    }));
  };

  const createSourceInline = async () => {
    const isTermType = TERM_SOURCE_TYPES.has(newSourceDraft.source_type);
    const payload = {
      url: isTermType ? '' : newSourceDraft.url.trim(),
      name: isTermType
        ? scopeKeywordTerm(draft.name, newSourceDraft.name, newSourceDraft.source_type)
        : newSourceDraft.name.trim(),
      source_type: newSourceDraft.source_type,
      enabled: true,
      project_ids: [],
    };
    if (newSourceDraft.source_type === 'reddit') {
      payload.reddit_kind = newSourceDraft.reddit_kind || 'subreddit';
    }
    if (newSourceDraft.source_type === 'linkedin') {
      payload.linkedin_kind = newSourceDraft.linkedin_kind || 'company';
    }
    if (newSourceDraft.source_type === 'threads') {
      payload.threads_kind = newSourceDraft.threads_kind || 'profile';
    }
    if (newSourceDraft.source_type === 'facebook') {
      payload.facebook_kind = newSourceDraft.facebook_kind || 'page';
    }
    if (newSourceDraft.source_type === 'instagram') {
      payload.instagram_kind = newSourceDraft.instagram_kind || 'profile';
    }

    if (isCreatingSource) return;
    if (isTermType ? !payload.name : !payload.url) return;

    setIsCreatingSource(true);
    setNewSourceError('');
    try {
      const created = await onCreateSource?.(payload);
      const createdId = Number(created?.id);
      if (Number.isFinite(createdId)) {
        setDraft((prev) => ({
          ...prev,
          source_ids: Array.from(new Set([...prev.source_ids, createdId])),
        }));
      }
      setNewSourceDraft(emptyNewSourceDraft);
      setShowNewSourceForm(false);
    } catch (error) {
      // Keep the Error itself (not just .message) so its API code reaches ErrorNotice.
      setNewSourceError(error || t('errors.createSourceFailed'));
    } finally {
      setIsCreatingSource(false);
    }
  };

  // Returns the full set of term-derived source ids (existing + newly synced) so
  // callers that need them immediately (e.g. submit()) aren't stuck reading
  // draft.source_ids before the setDraft below has applied.
  const syncTermSourcesToDraft = async () => {
    const terms = [
      ...draft.usernames.map((term) => ({ term, source_type: 'username' })),
      ...draft.hashtags.map((term) => ({ term, source_type: 'hashtag' })),
      ...draft.keywords.map((term) => ({ term, source_type: 'keyword' })),
    ];
    if (!terms.length || !onCreateSource) return draft.source_ids;

    setIsSyncingSources(true);
    try {
      const created = await Promise.all(
        terms.map(({ term, source_type }) =>
          onCreateSource({
            name: scopeKeywordTerm(draft.name, term, source_type),
            source_type,
            enabled: true,
            project_ids: [],
          }).catch(() => null)
        )
      );
      const ids = created
        .filter(Boolean)
        .map((source) => Number(source.id))
        .filter((id) => Number.isFinite(id));
      const mergedIds = Array.from(new Set([...draft.source_ids, ...ids]));
      if (ids.length) {
        setDraft((prev) => ({
          ...prev,
          source_ids: Array.from(new Set([...prev.source_ids, ...ids])),
        }));
      }
      return mergedIds;
    } finally {
      setIsSyncingSources(false);
    }
  };

  const generateMetadataFromAi = async () => {
    const name = draft.name.trim();
    const description = draft.description.trim();
    if (!name || !description || isGeneratingMetadata) return;

    setIsGeneratingMetadata(true);
    setMetadataError('');
    try {
      const res = await fetch('/api/projects/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        throw apiError(data, { status: res.status, fallback: t('errors.suggestFailed', { status: res.status }) });
      }

      const suggestions = data?.suggestions || {};
      setDraft((prev) => ({
        ...prev,
        target_audience: suggestions.target_audience || prev.target_audience,
        usernames: Array.isArray(suggestions.usernames)
          ? sanitizeTermArray([...prev.usernames, ...suggestions.usernames])
          : prev.usernames,
        hashtags: Array.isArray(suggestions.hashtags)
          ? sanitizeTermArray([...prev.hashtags, ...suggestions.hashtags])
          : prev.hashtags,
        keywords: Array.isArray(suggestions.keywords)
          ? sanitizeTermArray([...prev.keywords, ...suggestions.keywords])
          : prev.keywords,
      }));
      return suggestions;
    } catch (error) {
      setMetadataError(error || t('errors.aiSuggestFailed'));
      throw error;
    } finally {
      setIsGeneratingMetadata(false);
    }
  };

  const discoverSourcesFromDraft = async (nextDraft = draft) => {
    const payload = {
      name: nextDraft.name.trim(),
      description: nextDraft.description.trim(),
      location: nextDraft.location.trim(),
      target_audience: nextDraft.target_audience.trim(),
      usernames: sanitizeTermArray(nextDraft.usernames),
      hashtags: sanitizeTermArray(nextDraft.hashtags),
      keywords: sanitizeTermArray(nextDraft.keywords),
      source_ids: Array.isArray(nextDraft.source_ids) ? nextDraft.source_ids : [],
    };

    if (!payload.name) return null;

    clearDiscoveryPhaseTimers();
    setShowDiscoverySuccessModal(false);
    setDiscoveryPhase('suggesting');
    setMetadataError('');
    // The discovery endpoint runs AI suggestion + resolution + source creation as one
    // request, so there's no real progress signal from the server; step the label to
    // "prefilling" partway through so the wait doesn't look stuck on one phase.
    discoveryPhaseTimersRef.current.push(setTimeout(() => setDiscoveryPhase('prefilling'), 1800));

    try {
      const res = await fetch('/api/projects/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        throw apiError(data, { status: res.status, fallback: t('errors.discoverFailed', { status: res.status }) });
      }

      const discovery = data?.discovery || {};
      const discoveredSourceIds = Array.isArray(discovery.source_ids)
        ? [...new Set(discovery.source_ids.map((value) => Number(value)).filter((value) => Number.isFinite(value)))]
        : [];
      if (discoveredSourceIds.length) {
        setDraft((prev) => ({
          ...prev,
          source_ids: Array.from(new Set([...prev.source_ids, ...discoveredSourceIds])),
        }));
      }
      setLastDiscovery(discovery);

      clearDiscoveryPhaseTimers();
      setDiscoveryPhase('syncing');
      await onRefreshSources?.();

      setDiscoveryPhase('success');
      setShowDiscoverySuccessModal(true);
      return discovery;
    } catch (error) {
      clearDiscoveryPhaseTimers();
      setDiscoveryPhase('idle');
      setMetadataError(error || t('errors.prefillFailed'));
      return null;
    }
  };

  const closeDiscoverySuccessModal = () => {
    setShowDiscoverySuccessModal(false);
    setDiscoveryPhase('idle');
  };

  const chooseManualFill = () => {
    setMetadataError('');
    setFillMode('manual');
    setWizardStep(STEP.discovery);
  };

  const chooseAiFill = async () => {
    setFillMode('ai');
    setWizardStep(STEP.discovery);
    try {
      const suggestions = await generateMetadataFromAi();
      if (!suggestions) return;
      const nextDraft = {
        ...draft,
        target_audience: suggestions.target_audience || draft.target_audience,
        usernames: Array.isArray(suggestions.usernames)
          ? sanitizeTermArray([...draft.usernames, ...suggestions.usernames])
          : draft.usernames,
        hashtags: Array.isArray(suggestions.hashtags)
          ? sanitizeTermArray([...draft.hashtags, ...suggestions.hashtags])
          : draft.hashtags,
        keywords: Array.isArray(suggestions.keywords)
          ? sanitizeTermArray([...draft.keywords, ...suggestions.keywords])
          : draft.keywords,
      };
      await discoverSourcesFromDraft(nextDraft);
    } catch {
      // The UI already stores the error state for the user.
    }
  };

  const submit = async () => {
    if (isSaving) return;
    if (!draft.name.trim()) return;

    setIsSaving(true);
    try {
      // Terms (keywords/hashtags/usernames) only turn into actual scraped sources
      // once synced here - relying solely on the discovery step's own "Continue"
      // click meant terms added/edited after that step, or reached by jumping
      // straight to a later step, never got a source_ids entry. Syncing again on
      // every submit (idempotent - create_source upserts on url) guarantees the
      // saved project always reflects the current keywords/hashtags/usernames.
      const syncedSourceIds = await syncTermSourcesToDraft();

      const payload = {
        name: draft.name.trim(),
        status: draft.status,
        description: draft.description.trim(),
        location: draft.location.trim(),
        location_type: draft.location_type || null,
        target_audience: draft.target_audience.trim(),
        usernames: sanitizeTermArray(draft.usernames),
        hashtags: sanitizeTermArray(draft.hashtags),
        keywords: sanitizeTermArray(draft.keywords),
        start_date: draft.start_date || null,
        end_date: draft.end_date || null,
        source_ids: Array.from(new Set([...draft.source_ids, ...(syncedSourceIds || [])])),
        ...(canLinkUsers ? { user_ids: draft.user_ids } : {}),
        repeat_enabled: Boolean(draft.repeat_enabled),
        repeat_interval_value: draft.repeat_interval_value,
        repeat_interval_unit: draft.repeat_interval_unit,
        first_run_at: fromDateTimeLocalInput(draft.first_run_at),
        repeat_weekdays: sanitizeTermArray(draft.repeat_weekdays),
      };

      if (editingId) {
        await onUpdateProject?.(editingId, payload);
      } else {
        await onCreateProject?.(payload);
        setLastDiscovery(null);
      }
      if (editingId) {
        navigate(`/projects/${editingId}`);
      } else {
        navigate('/projects');
      }
    } finally {
      setIsSaving(false);
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
    const heading = isEditRoute ? t('wizard.headingEdit') : t('wizard.headingCreate');
    const step1Complete = Boolean(draft.name.trim() && draft.description.trim());
    const step2Complete = fillMode === 'manual' || fillMode === 'ai';
    const canContinueFromStep2 = step2Complete && !isGeneratingMetadata;
    const step3Complete = !draft.repeat_enabled || Boolean(Number(draft.repeat_interval_value) > 0 && draft.repeat_interval_unit);
    const totalSteps = Object.keys(STEP).length;
    const discoveredSources = Array.isArray(lastDiscovery?.sources) ? lastDiscovery.sources : [];
    const discoveredResolvedUrls = Array.isArray(lastDiscovery?.resolved_urls) ? lastDiscovery.resolved_urls : [];
    const discoveryPreviewLimit = 6;
    const discoveryPreviewItems = discoveredSources.length
      ? discoveredSources.slice(0, discoveryPreviewLimit).map((source) => ({ name: source.name || source.url, url: source.url }))
      : discoveredResolvedUrls.slice(0, discoveryPreviewLimit).map((url) => ({ name: url, url }));
    const stepMeta = {
      basics: { label: t('wizard.steps.basics.label'), detail: t('wizard.steps.basics.detail'), complete: step1Complete },
      users: { label: t('wizard.steps.users.label'), detail: t('wizard.steps.users.detail'), complete: true },
      discovery: { label: t('wizard.steps.discovery.label'), detail: t('wizard.steps.discovery.detail'), complete: step2Complete },
      schedule: { label: t('wizard.steps.schedule.label'), detail: t('wizard.steps.schedule.detail'), complete: step3Complete },
      sources: {
        label: t('wizard.steps.sources.label'),
        detail: isEditRoute ? t('wizard.steps.sources.detailEdit') : t('wizard.steps.sources.detailCreate'),
        complete: true,
      },
    };
    const fillModeLabel = fillMode ? t(`wizard.fillModes.${fillMode}`, { defaultValue: fillMode }).toUpperCase() : '';
    const stepOrder = Object.keys(STEP).sort((a, b) => STEP[a] - STEP[b]);

    return (
      <div className="admin-page-shell">
        <div className="admin-page-header">
          <div>
            <div className="admin-page-kicker">
              <CalendarDays size={14} /> {t('wizard.kicker')}
            </div>
            <h1 className="admin-page-title">{heading}</h1>
            <p className="admin-page-subtitle">
              {isEditRoute
                ? t('wizard.subtitleEdit', { count: totalSteps })
                : t('wizard.subtitleCreate', { count: totalSteps })}
            </p>
          </div>
          <div className="admin-page-toolbar">
            <div className="admin-page-toolbar-meta">
              <span>{t('wizard.stepLabel')}</span>
              <strong>{t('wizard.stepOf', { step: wizardStep, total: totalSteps })}</strong>
            </div>
            <div className="admin-page-toolbar-meta">
              <span>{t('wizard.modeLabel')}</span>
              <strong>{fillModeLabel || t('wizard.chooseOne')}</strong>
            </div>
          </div>
        </div>

        <div className="glass-card project-wizard-shell">
          <div className="project-wizard-steps">
            {stepOrder.map((key) => {
              const item = stepMeta[key];
              const step = STEP[key];
              const active = wizardStep === step;
              const done = wizardStep > step;
              const allowed = stepOrder.filter((k) => STEP[k] < step).every((k) => stepMeta[k].complete);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    if (allowed) {
                      setWizardStep(step);
                    }
                  }}
                  className="btn-secondary project-wizard-step-btn"
                  style={{
                    borderColor: active ? 'rgba(46, 134, 222, 0.28)' : 'rgba(0,0,0,0.08)',
                    background: active ? 'rgba(46, 134, 222, 0.08)' : 'rgba(255,255,255,0.72)',
                  }}
                >
                  <span className="panel-chip" style={{ marginInlineEnd: 10 }}>
                    {done ? t('wizard.stepDone') : `0${step}`}
                  </span>
                  <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                    <strong style={{ fontSize: '0.92rem' }}>{item.label}</strong>
                    <span style={{ fontSize: '0.74rem', color: 'var(--text-light)', textTransform: 'none', letterSpacing: 0 }}>
                      {item.detail}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          {wizardStep === STEP.basics && (
          <div className="glass-card project-wizard-panel">
            <div className="panel-header-tight" style={{ marginBottom: 12 }}>
              <strong style={{ fontSize: '1rem' }}>{t('wizard.stepHeading', { step: STEP.basics, title: t('wizard.basics.title') })}</strong>
              <span className="panel-chip">{step1Complete ? t('wizard.ready') : t('wizard.required')}</span>
            </div>
            <div style={{ display: 'grid', gap: 10 }}>
              <label style={{ display: 'grid', gap: 6 }}>
                <span style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-light)' }}>{t('wizard.basics.nameLabel')}</span>
                <input
                  type="text"
                  className="source-input"
                  placeholder={t('wizard.basics.namePlaceholder')}
                  value={draft.name}
                  onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
                  disabled={isSaving}
                  dir="auto"
                />
              </label>
              <label style={{ display: 'grid', gap: 6 }}>
                <span style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-light)' }}>{t('wizard.basics.descriptionLabel')}</span>
                <textarea
                  className="source-input"
                  placeholder={t('wizard.basics.descriptionPlaceholder')}
                  rows={4}
                  value={draft.description}
                  onChange={(e) => setDraft((prev) => ({ ...prev, description: e.target.value }))}
                  style={{ resize: 'vertical', minHeight: 110 }}
                  disabled={isSaving}
                  dir="auto"
                />
              </label>

              <div className="form-row-location">
                <label style={{ display: 'grid', gap: 6 }}>
                  <span style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-light)' }}>{t('wizard.basics.locationTypeLabel')}</span>
                  <select
                    className="filter-select"
                    value={draft.location_type}
                    onChange={(e) => setDraft((prev) => ({ ...prev, location_type: e.target.value }))}
                    disabled={isSaving}
                  >
                    <option value="">{t('wizard.basics.selectPlaceholder')}</option>
                    {LOCATION_TYPE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {t(`locationTypes.${option.labelKey}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ display: 'grid', gap: 6 }}>
                  <span style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-light)' }}>{t('wizard.basics.locationLabel')}</span>
                  <input
                    type="text"
                    className="source-input"
                    placeholder={t('wizard.basics.locationPlaceholder')}
                    value={draft.location}
                    onChange={(e) => setDraft((prev) => ({ ...prev, location: e.target.value }))}
                    disabled={isSaving}
                    dir="auto"
                  />
                </label>
              </div>

              <div className="project-wizard-nav-row">
                <span style={{ color: 'var(--text-light)', fontSize: '0.85rem', lineHeight: 1.5 }}>
                  {t('wizard.basics.hint')}
                </span>
                <div className="project-wizard-nav-actions">
                  <button
                    type="button"
                    className="btn-primary wizard-btn-continue"
                    onClick={() => setWizardStep(STEP.users || STEP.discovery)}
                    disabled={!step1Complete || isSaving}
                  >
                    {t('common:actions.continue')}
                  </button>
                </div>
              </div>
            </div>
          </div>
          )}

          {canLinkUsers && wizardStep === STEP.users && (
          <div className="glass-card project-wizard-panel">
            <div className="panel-header-tight" style={{ marginBottom: 12 }}>
              <strong style={{ fontSize: '1rem' }}>{t('wizard.stepHeading', { step: STEP.users, title: t('wizard.usersStep.title') })}</strong>
              <span className="panel-chip">{t('users.selected', { n: draft.user_ids.length })}</span>
            </div>
            <div style={{ display: 'grid', gap: 14 }}>
              <UserAssignField
                users={users}
                selectedIds={draft.user_ids}
                onToggle={toggleUserLink}
                query={userAssignQuery}
                onQueryChange={setUserAssignQuery}
                disabled={isSaving}
              />

              <div className="project-wizard-nav-row">
                <button type="button" className="btn-secondary wizard-btn-back" onClick={() => setWizardStep(STEP.basics)} disabled={isSaving}>
                  {t('common:actions.back')}
                </button>
                <button
                  type="button"
                  className="btn-primary wizard-btn-continue"
                  onClick={() => setWizardStep(STEP.discovery)}
                  disabled={isSaving}
                >
                  {t('common:actions.continue')}
                </button>
              </div>
            </div>
          </div>
          )}

          {wizardStep === STEP.discovery && (
          <div
            className="glass-card project-wizard-panel"
            style={{ opacity: step1Complete ? 1 : 0.7 }}
          >
            <div className="panel-header-tight" style={{ marginBottom: 12 }}>
              <strong style={{ fontSize: '1rem' }}>{t('wizard.stepHeading', { step: STEP.discovery, title: t('wizard.discovery.title') })}</strong>
              <span className="panel-chip">{fillModeLabel || t('wizard.discovery.chooseMethod')}</span>
            </div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
              <button
                type="button"
                className={`btn-secondary ${fillMode === 'manual' ? 'active' : ''}`}
                onClick={chooseManualFill}
                disabled={!step1Complete || isSaving}
              >
                {t('wizard.discovery.fillManual')}
              </button>
              <button
                type="button"
                className={`btn-secondary ${fillMode === 'ai' ? 'active' : ''}`}
                onClick={chooseAiFill}
                disabled={!step1Complete || isSaving || isGeneratingMetadata || discoveryPhase !== 'idle'}
              >
                {isGeneratingMetadata
                  ? t('wizard.discovery.generating')
                  : discoveryPhase !== 'idle'
                  ? t(`discovery.phases.${discoveryPhase}`)
                  : t('wizard.discovery.fillAi')}
              </button>
            </div>

            {!step2Complete ? (
              <div className="admin-empty-state" style={{ padding: '16px 10px' }}>
                <div className="admin-empty-state-icon">
                  <Sparkles size={18} />
                </div>
                <strong>{t('wizard.discovery.emptyTitle')}</strong>
                <span>{t('wizard.discovery.emptyHint')}</span>
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 12 }}>
                <ErrorBanner message={metadataError} />

                <div style={{ display: 'grid', gap: 8 }}>
                  <label style={{ fontSize: '0.82rem', color: 'var(--text-light)' }}>{t('wizard.discovery.targetAudienceLabel')}</label>
                  <input
                    type="text"
                    className="source-input"
                    placeholder={t('wizard.discovery.targetAudiencePlaceholder')}
                    value={draft.target_audience}
                    onChange={(e) => setDraft((prev) => ({ ...prev, target_audience: e.target.value }))}
                    disabled={isSaving || isGeneratingMetadata}
                    dir="auto"
                  />
                </div>

                <div className="wizard-term-fields">
                  <TermChipsField
                    label={t('wizard.discovery.xAccountsLabel')}
                    placeholder={t('wizard.discovery.xAccountsPlaceholder')}
                    values={draft.usernames}
                    onChange={(next) => setDraft((prev) => ({ ...prev, usernames: next }))}
                    options={globalTermOptions.username}
                    disabled={isSaving || isGeneratingMetadata}
                  />
                  <TermChipsField
                    label={t('wizard.discovery.hashtagsLabel')}
                    placeholder={t('wizard.discovery.hashtagsPlaceholder')}
                    values={draft.hashtags}
                    onChange={(next) => setDraft((prev) => ({ ...prev, hashtags: next }))}
                    options={globalTermOptions.hashtag}
                    disabled={isSaving || isGeneratingMetadata}
                  />
                  <TermChipsField
                    label={t('wizard.discovery.keywordsLabel')}
                    placeholder={t('wizard.discovery.keywordsPlaceholder')}
                    values={draft.keywords}
                    onChange={(next) => setDraft((prev) => ({ ...prev, keywords: next }))}
                    options={globalTermOptions.keyword}
                    disabled={isSaving || isGeneratingMetadata}
                    hint={
                      draft.name.trim() ? (
                        <Trans
                          t={t}
                          i18nKey="wizard.discovery.keywordHintExample"
                          values={{
                            example: scopeKeywordTerm(
                              draft.name,
                              draft.keywords[0] || t('wizard.discovery.exampleKeyword'),
                              'keyword'
                            ),
                          }}
                          components={{ bdi: <bdi /> }}
                        />
                      ) : (
                        t('wizard.discovery.keywordHint')
                      )
                    }
                  />
                </div>

                <div className="admin-form-hint">
                  {isEditRoute ? t('wizard.discovery.editHint') : t('wizard.discovery.createHint')}
                </div>

                {lastDiscovery && (
                  <div
                    style={{
                      padding: 14,
                      borderRadius: 16,
                      background: 'rgba(255,255,255,0.72)',
                      border: '1px solid rgba(15, 23, 42, 0.08)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 10,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: '0.92rem', color: 'var(--text-dark)' }}>{t('wizard.discovery.resultsTitle')}</strong>
                      <span className="panel-chip">
                        {t('wizard.discovery.resultsCount', { count: (lastDiscovery.resolved_urls || []).length })}
                      </span>
                    </div>

                    {(lastDiscovery.resolved_urls || []).length > 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {(lastDiscovery.resolved_urls || []).map((url) => (
                          <a
                            key={url}
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className="ltr-isolate"
                            style={{
                              fontSize: '0.84rem',
                              color: 'var(--text-dark)',
                              textDecoration: 'none',
                              padding: '10px 12px',
                              borderRadius: 12,
                              background: 'rgba(15, 23, 42, 0.04)',
                              wordBreak: 'break-word',
                            }}
                          >
                            {url}
                          </a>
                        ))}
                      </div>
                    ) : (
                      <div style={{ fontSize: '0.84rem', color: 'var(--text-light)' }}>
                        {t('wizard.discovery.noResolvedUrls')}
                      </div>
                    )}
                  </div>
                )}

                {discoveryPhase !== 'idle' && (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {DISCOVERY_STEPS.map((step) => {
                      const stepIndex = DISCOVERY_STEPS.findIndex((s) => s.key === step.key);
                      const currentIndex = DISCOVERY_STEPS.findIndex((s) => s.key === discoveryPhase);
                      const state = stepIndex < currentIndex ? 'done' : stepIndex === currentIndex ? 'active' : 'pending';
                      return (
                        <span
                          key={step.key}
                          className={`panel-chip ${state === 'done' ? 'success' : state === 'active' ? 'warning' : 'muted'}`}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                        >
                          {state === 'active' && <RefreshCw size={12} className="spin" />}
                          {state === 'done' && <Check size={12} />}
                          {t(`discovery.steps.${step.key}`)}
                        </span>
                      );
                    })}
                  </div>
                )}

                <div className="project-wizard-nav-row">
                  <span style={{ color: 'var(--text-light)', fontSize: '0.85rem', lineHeight: 1.5, maxWidth: 480 }}>
                    {t('wizard.discovery.aiNote')}
                  </span>
                  <div className="project-wizard-nav-actions">
                    <button
                      type="button"
                      className="btn-secondary wizard-btn-back"
                      onClick={() => setWizardStep(STEP.users || STEP.basics)}
                      disabled={isSaving || isGeneratingMetadata}
                    >
                      {t('common:actions.back')}
                    </button>
                    <button
                      type="button"
                      className="btn-primary wizard-btn-continue"
                      onClick={async () => {
                        await syncTermSourcesToDraft();
                        setWizardStep(STEP.schedule);
                      }}
                      disabled={!canContinueFromStep2 || isSaving || isSyncingSources}
                    >
                      {isSyncingSources ? (
                        <>
                          <RefreshCw size={18} className="spin" /> {t('wizard.discovery.syncing')}
                        </>
                      ) : (
                        t('common:actions.continue')
                      )}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
          )}

          {wizardStep === STEP.schedule && (
          <div
            className="glass-card project-wizard-panel"
            style={{ opacity: step1Complete && step2Complete ? 1 : 0.7 }}
          >
            <div className="panel-header-tight" style={{ marginBottom: 12 }}>
              <strong style={{ fontSize: '1rem' }}>{t('wizard.stepHeading', { step: STEP.schedule, title: t('wizard.schedule.title') })}</strong>
              <span className={`panel-chip ${draft.repeat_enabled ? 'success' : 'muted'}`}>
                {draft.repeat_enabled ? t('wizard.schedule.repeatOn') : t('wizard.schedule.repeatOff')}
              </span>
            </div>

            <div style={{ display: 'grid', gap: 14 }}>
              <label style={{ display: 'grid', gap: 6 }}>
                <span style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-light)' }}>{t('wizard.schedule.statusLabel')}</span>
                <select
                  className="filter-select"
                  value={draft.status}
                  onChange={(e) => setDraft((prev) => ({ ...prev, status: e.target.value }))}
                  disabled={isSaving}
                >
                  {STATUS_OPTIONS.map((status) => (
                    <option key={status} value={status}>
                      {statusLabel(status)}
                    </option>
                  ))}
                </select>
              </label>

              <label style={{ display: 'grid', gap: 6 }}>
                <span style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-light)' }}>{t('wizard.schedule.firstRunAt')}</span>
                <input
                  type="datetime-local"
                  className="source-input"
                  value={draft.first_run_at}
                  onChange={(e) => setDraft((prev) => ({ ...prev, first_run_at: e.target.value }))}
                  disabled={isSaving}
                />
              </label>

              <div className="admin-item-card" style={{ margin: 0 }}>
                <div className="panel-header-tight" style={{ marginBottom: 10 }}>
                  <strong style={{ fontSize: '0.94rem' }}>{t('wizard.schedule.runAutomatically')}</strong>
                  <span className={`panel-chip ${draft.repeat_enabled ? 'success' : 'muted'}`}>
                    {draft.repeat_enabled ? t('wizard.schedule.repeatOn') : t('wizard.schedule.repeatOff')}
                  </span>
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: draft.repeat_enabled ? 12 : 0 }}>
                  <input
                    type="checkbox"
                    checked={draft.repeat_enabled}
                    onChange={(e) => setDraft((prev) => ({ ...prev, repeat_enabled: e.target.checked }))}
                    disabled={isSaving}
                  />
                  <span style={{ fontSize: '0.86rem' }}>{t('wizard.schedule.autoRerun')}</span>
                </label>
                {draft.repeat_enabled && (
                  <>
                    <div className="form-row-even">
                      <label style={{ display: 'grid', gap: 6 }}>
                        <span style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-light)' }}>{t('wizard.schedule.repeatEvery')}</span>
                        <input
                          type="number"
                          min="1"
                          className="source-input"
                          value={draft.repeat_interval_value}
                          onChange={(e) => setDraft((prev) => ({ ...prev, repeat_interval_value: e.target.value }))}
                          disabled={isSaving}
                        />
                      </label>
                      <label style={{ display: 'grid', gap: 6 }}>
                        <span style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-light)' }}>{t('wizard.schedule.unit')}</span>
                        <select
                          className="filter-select"
                          value={draft.repeat_interval_unit}
                          onChange={(e) => setDraft((prev) => ({ ...prev, repeat_interval_unit: e.target.value }))}
                          disabled={isSaving}
                        >
                          {REPEAT_UNIT_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div style={{ marginTop: 12 }}>
                      <WeekdayPicker
                        values={draft.repeat_weekdays}
                        onChange={(next) => setDraft((prev) => ({ ...prev, repeat_weekdays: next }))}
                        disabled={isSaving}
                      />
                    </div>
                    <div style={{ marginTop: 10, color: 'var(--text-light)', fontSize: '0.84rem' }}>{repeatSummary(draft)}</div>
                  </>
                )}
              </div>

              <div className="project-wizard-nav-row">
                <button type="button" className="btn-secondary wizard-btn-back" onClick={() => setWizardStep(STEP.discovery)} disabled={isSaving}>
                  {t('common:actions.back')}
                </button>
                <button
                  type="button"
                  className="btn-primary wizard-btn-continue"
                  onClick={() => setWizardStep(STEP.sources)}
                  disabled={!step3Complete || isSaving}
                >
                  {t('common:actions.continue')}
                </button>
              </div>
            </div>
          </div>
          )}

          {wizardStep === STEP.sources && (
          <div
            className="glass-card project-wizard-panel"
            style={{ opacity: step1Complete && step2Complete && step3Complete ? 1 : 0.7 }}
          >
            <div className="panel-header-tight" style={{ marginBottom: 12 }}>
              <strong style={{ fontSize: '1rem' }}>
                {t('wizard.stepHeading', {
                  step: STEP.sources,
                  title: isEditRoute ? t('wizard.sources.titleEdit') : t('wizard.sources.titleCreate'),
                })}
              </strong>
              <span className="panel-chip">{t('wizard.sources.selectedSources', { count: selectedSourceCount })}</span>
            </div>

            <div style={{ display: 'grid', gap: 14 }}>
              <div className="admin-item-card" style={{ margin: 0 }}>
                <div className="panel-header-tight" style={{ marginBottom: 10 }}>
                  <strong style={{ fontSize: '0.94rem' }}>{t('wizard.sources.windowTitle')}</strong>
                </div>
                <div className="form-row-even">
                  <label style={{ display: 'grid', gap: 6 }}>
                    <span style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-light)' }}>{t('wizard.sources.startDate')}</span>
                    <input
                      type="date"
                      className="source-input"
                      value={draft.start_date}
                      onChange={(e) => setDraft((prev) => ({ ...prev, start_date: e.target.value }))}
                      disabled={isSaving}
                    />
                  </label>
                  <label style={{ display: 'grid', gap: 6 }}>
                    <span style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-light)' }}>{t('wizard.sources.endDate')}</span>
                    <input
                      type="date"
                      className="source-input"
                      value={draft.end_date}
                      onChange={(e) => setDraft((prev) => ({ ...prev, end_date: e.target.value }))}
                      disabled={isSaving}
                    />
                  </label>
                </div>
                <div style={{ marginTop: 10, color: 'var(--text-light)', fontSize: '0.84rem', lineHeight: 1.5 }}>
                  {t('wizard.sources.windowHint')}
                </div>
              </div>

              <div className="assign-sources-panel">
                <div className="assign-sources-header">
                  <div>
                    <div className="assign-sources-kicker">{t('wizard.sources.kicker')}</div>
                    <strong className="assign-sources-title">{t('wizard.sources.heading')}</strong>
                  </div>
                  <div className="assign-sources-summary">
                    <span className="panel-chip">{t('wizard.sources.selected', { n: selectedSourceCount })}</span>
                    <span className="panel-chip muted">{t('wizard.sources.shown', { n: visibleSourcesForActiveTab.length })}</span>
                  </div>
                </div>

                {assignableSources.length > 0 && (
                  <div className="source-type-tabs" role="tablist" aria-label={t('wizard.sources.filterByType')}>
                    {SOURCE_ASSIGN_TABS.map((tab) => {
                      const isActive = activeSourceTab === tab.value;
                      return (
                        <button
                          key={tab.value}
                          type="button"
                          role="tab"
                          aria-selected={isActive}
                          className={`source-type-tab ${isActive ? 'active' : ''}`}
                          onClick={() => setActiveSourceTab(tab.value)}
                          disabled={isSaving}
                        >
                          {tab.value === 'all' ? t('common:status.all') : sourceTypeLabel(tab.value)}
                          <span className="source-type-tab-count">{sourceTabCounts[tab.value] || 0}</span>
                        </button>
                      );
                    })}
                  </div>
                )}

                <div className="assign-sources-toolbar">
                  <label className="assign-sources-search">
                    <Search size={14} />
                    <input
                      type="text"
                      value={sourceAssignQuery}
                      onChange={(e) => setSourceAssignQuery(e.target.value)}
                      placeholder={t('wizard.sources.filterPlaceholder')}
                      disabled={isSaving}
                      dir="auto"
                    />
                  </label>

                  <div className="assign-sources-actions">
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={selectAllSourcesForActiveTab}
                      disabled={isSaving || visibleSourcesForActiveTab.length === 0 || allVisibleSelectedForActiveTab}
                      style={{ padding: '8px 10px', fontSize: '0.78rem' }}
                    >
                      {t('wizard.sources.selectVisible')}
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={clearSourcesForActiveTab}
                      disabled={isSaving || visibleSelectedCountForActiveTab === 0}
                      style={{ padding: '8px 10px', fontSize: '0.78rem' }}
                    >
                      {t('wizard.sources.clearVisible')}
                    </button>
                    <button
                      type="button"
                      className={`btn-secondary ${showNewSourceForm ? 'active' : ''}`}
                      onClick={() => {
                        setNewSourceError('');
                        setShowNewSourceForm((prev) => !prev);
                      }}
                      disabled={isSaving}
                      style={{ padding: '8px 10px', fontSize: '0.78rem' }}
                    >
                      <Rss size={14} /> {showNewSourceForm ? t('common:actions.close') : t('wizard.sources.newSource')}
                    </button>
                  </div>
                </div>

                {showNewSourceForm && (
                  <div
                    style={{
                      display: 'grid',
                      gap: 10,
                      padding: 14,
                      marginBottom: 10,
                      borderRadius: 14,
                      border: '1px solid rgba(15, 23, 42, 0.08)',
                      background: 'rgba(255,255,255,0.7)',
                    }}
                  >
                    <strong style={{ fontSize: '0.86rem' }}>{t('wizard.newSource.title')}</strong>
                    <div style={{ display: 'grid', gap: 6 }}>
                      <span style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-light)' }}>{t('wizard.newSource.typeLabel')}</span>
                      <div className="source-type-tabs" role="tablist" aria-label={t('wizard.newSource.chooseType')}>
                        {SOURCE_TYPE_FORM_TABS.map((option) => {
                          const isActive =
                            option.value === 'twitter'
                              ? TWITTER_SOURCE_TYPES.has(newSourceDraft.source_type)
                              : newSourceDraft.source_type === option.value;
                          return (
                            <button
                              key={option.value}
                              type="button"
                              role="tab"
                              aria-selected={isActive}
                              className={`source-type-tab ${isActive ? 'active' : ''}`}
                              onClick={() =>
                                setNewSourceDraft((prev) => ({
                                  ...prev,
                                  source_type:
                                    option.value === 'twitter'
                                      ? TWITTER_SOURCE_TYPES.has(prev.source_type)
                                        ? prev.source_type
                                        : 'hashtag'
                                      : option.value,
                                }))
                              }
                              disabled={isCreatingSource}
                            >
                              {sourceTypeLabel(option.value)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    {TWITTER_SOURCE_TYPES.has(newSourceDraft.source_type) && (
                      <label style={{ display: 'grid', gap: 6 }}>
                        <span style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-light)' }}>{t('wizard.newSource.twitterKind')}</span>
                        <select
                          className="filter-select"
                          value={newSourceDraft.source_type}
                          onChange={(e) => setNewSourceDraft((prev) => ({ ...prev, source_type: e.target.value }))}
                          disabled={isCreatingSource}
                        >
                          {TWITTER_SUB_TYPE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {sourceTypeLabel(option.value)}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {newSourceDraft.source_type === 'reddit' && (
                      <label style={{ display: 'grid', gap: 6 }}>
                        <span style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-light)' }}>{t('wizard.newSource.redditKind')}</span>
                        <select
                          className="filter-select"
                          value={newSourceDraft.reddit_kind}
                          onChange={(e) => setNewSourceDraft((prev) => ({ ...prev, reddit_kind: e.target.value }))}
                          disabled={isCreatingSource}
                        >
                          <option value="subreddit">{t('wizard.newSource.redditKinds.subreddit')}</option>
                          <option value="user">{t('wizard.newSource.redditKinds.user')}</option>
                          <option value="search">{t('wizard.newSource.redditKinds.search')}</option>
                          <option value="subreddit_search">{t('wizard.newSource.redditKinds.subreddit_search')}</option>
                        </select>
                        <span style={{ fontSize: '0.78rem', color: 'var(--text-light)' }}>
                          {newSourceDraft.reddit_kind === 'subreddit_search'
                            ? t('wizard.newSource.redditSubredditSearchHint')
                            : t('wizard.newSource.redditHint')}
                        </span>
                      </label>
                    )}
                    {newSourceDraft.source_type === 'linkedin' && (
                      <label style={{ display: 'grid', gap: 6 }}>
                        <span style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-light)' }}>{t('wizard.newSource.linkedinKind')}</span>
                        <select
                          className="filter-select"
                          value={newSourceDraft.linkedin_kind}
                          onChange={(e) => setNewSourceDraft((prev) => ({ ...prev, linkedin_kind: e.target.value }))}
                          disabled={isCreatingSource}
                        >
                          <option value="company">{t('wizard.newSource.linkedinKinds.company')}</option>
                          <option value="profile">{t('wizard.newSource.linkedinKinds.profile')}</option>
                          <option value="search">{t('wizard.newSource.linkedinKinds.search')}</option>
                        </select>
                        <span style={{ fontSize: '0.78rem', color: 'var(--text-light)' }}>
                          {t('wizard.newSource.linkedinHint')}
                        </span>
                      </label>
                    )}
                    {newSourceDraft.source_type === 'threads' && (
                      <label style={{ display: 'grid', gap: 6 }}>
                        <span style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-light)' }}>{t('wizard.newSource.threadsKind')}</span>
                        <select
                          className="filter-select"
                          value={newSourceDraft.threads_kind}
                          onChange={(e) => setNewSourceDraft((prev) => ({ ...prev, threads_kind: e.target.value }))}
                          disabled={isCreatingSource}
                        >
                          <option value="profile">{t('wizard.newSource.threadsKinds.profile')}</option>
                          <option value="search">{t('wizard.newSource.threadsKinds.search')}</option>
                        </select>
                        <span style={{ fontSize: '0.78rem', color: 'var(--text-light)' }}>
                          {t('wizard.newSource.requiresApify')}
                        </span>
                      </label>
                    )}
                    {newSourceDraft.source_type === 'facebook' && (
                      <label style={{ display: 'grid', gap: 6 }}>
                        <span style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-light)' }}>{t('wizard.newSource.facebookKind')}</span>
                        <select
                          className="filter-select"
                          value={newSourceDraft.facebook_kind}
                          onChange={(e) => setNewSourceDraft((prev) => ({ ...prev, facebook_kind: e.target.value }))}
                          disabled={isCreatingSource}
                        >
                          <option value="page">{t('wizard.newSource.facebookKinds.page')}</option>
                          <option value="group">{t('wizard.newSource.facebookKinds.group')}</option>
                          <option value="profile">{t('wizard.newSource.facebookKinds.profile')}</option>
                          <option value="search">{t('wizard.newSource.facebookKinds.search')}</option>
                        </select>
                        <span style={{ fontSize: '0.78rem', color: 'var(--text-light)' }}>
                          {t('wizard.newSource.facebookHint')}
                        </span>
                      </label>
                    )}
                    {newSourceDraft.source_type === 'instagram' && (
                      <label style={{ display: 'grid', gap: 6 }}>
                        <span style={{ fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-light)' }}>{t('wizard.newSource.instagramKind')}</span>
                        <select
                          className="filter-select"
                          value={newSourceDraft.instagram_kind}
                          onChange={(e) => setNewSourceDraft((prev) => ({ ...prev, instagram_kind: e.target.value }))}
                          disabled={isCreatingSource}
                        >
                          <option value="profile">{t('wizard.newSource.instagramKinds.profile')}</option>
                          <option value="hashtag">{t('wizard.newSource.instagramKinds.hashtag')}</option>
                          <option value="search">{t('wizard.newSource.instagramKinds.search')}</option>
                        </select>
                        <span style={{ fontSize: '0.78rem', color: 'var(--text-light)' }}>
                          {t('wizard.newSource.requiresApify')}
                        </span>
                      </label>
                    )}
                    {!TERM_SOURCE_TYPES.has(newSourceDraft.source_type) && (
                      <input
                        type="text"
                        className="source-input"
                        placeholder={
                          newSourceDraft.source_type === 'reddit' && newSourceDraft.reddit_kind === 'subreddit_search'
                            ? t('wizard.newSource.urlPlaceholderRedditSubredditSearch')
                            : URL_FIELD_PLACEHOLDER_TYPES.has(newSourceDraft.source_type)
                              ? t(`wizard.newSource.urlPlaceholders.${newSourceDraft.source_type}`)
                              : t('wizard.newSource.urlPlaceholderDefault')
                        }
                        value={newSourceDraft.url}
                        onChange={(e) => setNewSourceDraft((prev) => ({ ...prev, url: e.target.value }))}
                        disabled={isCreatingSource}
                        dir="auto"
                      />
                    )}
                    <input
                      type="text"
                      className="source-input"
                      placeholder={
                        TERM_SOURCE_PLACEHOLDER_TYPES.has(newSourceDraft.source_type)
                          ? t(`wizard.newSource.termPlaceholders.${newSourceDraft.source_type}`)
                          : t('wizard.newSource.namePlaceholderDefault')
                      }
                      value={newSourceDraft.name}
                      onChange={(e) => setNewSourceDraft((prev) => ({ ...prev, name: e.target.value }))}
                      disabled={isCreatingSource}
                      dir="auto"
                    />
                    <ErrorNotice error={newSourceError} context={t('errorContext.addSource')} compact />
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="btn-primary"
                        onClick={createSourceInline}
                        disabled={
                          isCreatingSource ||
                          (TERM_SOURCE_TYPES.has(newSourceDraft.source_type)
                            ? !newSourceDraft.name.trim()
                            : !newSourceDraft.url.trim())
                        }
                        style={{ minWidth: 160 }}
                      >
                        {isCreatingSource ? (
                          <>
                            <RefreshCw size={16} className="spin" /> {t('wizard.newSource.creating')}
                          </>
                        ) : (
                          <>
                            <Plus size={16} /> {t('wizard.newSource.create')}
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => {
                          setShowNewSourceForm(false);
                          setNewSourceDraft(emptyNewSourceDraft);
                          setNewSourceError('');
                        }}
                        disabled={isCreatingSource}
                      >
                        {t('common:actions.cancel')}
                      </button>
                    </div>
                  </div>
                )}

                <div className="assign-sources-list">
                  {assignableSources.length === 0 ? (
                    <div style={{ color: 'var(--text-light)', fontSize: '0.85rem' }}>
                      {t('wizard.sources.noSources')}
                    </div>
                  ) : visibleSourcesForActiveTab.length === 0 ? (
                    <div className="admin-empty-state" style={{ padding: '16px 10px' }}>
                      <div className="admin-empty-state-icon" style={{ width: 36, height: 36 }}>
                        <Search size={16} />
                      </div>
                      <strong>{t('wizard.sources.noMatchesTitle')}</strong>
                      <span>
                        {sourceAssignQuery.trim()
                          ? t('wizard.sources.tryDifferentSearch')
                          : activeSourceTab === 'all'
                          ? t('wizard.sources.noneAvailable')
                          : t('wizard.sources.noneOfType', { type: sourceTypeLabel(activeSourceTab) })}
                      </span>
                    </div>
                  ) : (
                    visibleSourcesForActiveTab.map((source) => {
                      const sourceId = Number(source.id);
                      const isSelected = draft.source_ids.includes(sourceId);
                      const projectCount = (sourceProjectsById.get(sourceId) || []).length;
                      return (
                        <label key={source.id} className={`assign-source-item ${isSelected ? 'selected' : ''}`}>
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleSource(source.id)}
                            disabled={isSaving}
                          />
                          <div className="assign-source-copy">
                            <div className="assign-source-topline">
                              <strong className="assign-source-name project-term-name" dir="auto">{source.name || source.url}</strong>
                              <span className={`panel-chip ${source.enabled ? 'success' : 'muted'}`}>
                                {source.enabled ? t('sourceState.enabled') : t('sourceState.disabled')}
                              </span>
                            </div>
                            <div className="assign-source-url ltr-isolate">{source.url}</div>
                            <div className="assign-source-meta">
                              <span>{sourceTypeLabel(source.source_type)}</span>
                              <span>
                                {t('wizard.sources.projectCount', { count: projectCount })}
                              </span>
                            </div>
                          </div>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>

              <div className="project-wizard-final-actions">
                <button className="btn-secondary wizard-btn-fixed" type="button" onClick={() => setWizardStep(STEP.schedule)} disabled={isSaving}>
                  {t('common:actions.back')}
                </button>
                <button className="btn-primary wizard-btn-grow" onClick={submit} disabled={isSaving || !step1Complete || !step3Complete}>
                  {isSaving ? (
                    <>
                      <RefreshCw size={18} className="spin" />
                      {t('common:actions.saving')}
                    </>
                  ) : (
                    <>
                      <Plus size={18} /> {isEditRoute ? t('wizard.updateProject') : t('wizard.createProject')}
                    </>
                  )}
                </button>
                <button className="btn-secondary wizard-btn-fixed" type="button" onClick={handleCancel}>
                  <X size={18} /> {t('common:actions.cancel')}
                </button>
              </div>
            </div>
          </div>
          )}

        </div>

        <ConfirmModal
          open={showCancelModal}
          title={t('wizard.cancelModal.title')}
          message={t('wizard.cancelModal.message')}
          confirmLabel={t('wizard.cancelModal.confirm')}
          cancelLabel={t('wizard.cancelModal.cancel')}
          onClose={() => setShowCancelModal(false)}
          onConfirm={discardChanges}
        />

        <ConfirmModal
          open={showDiscoverySuccessModal}
          title={t('wizard.successModal.title')}
          message={t('wizard.successModal.message')}
          confirmLabel={t('common:actions.done')}
          hideCancel
          onClose={closeDiscoverySuccessModal}
        >
          <div style={{ display: 'grid', gap: 10, marginBottom: 18 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <span className="panel-chip success">
                {t('wizard.successModal.sourcesCollected', { count: discoveredSources.length })}
              </span>
              <span className="panel-chip">
                {t('wizard.successModal.urlsResolved', { count: discoveredResolvedUrls.length })}
              </span>
            </div>

            {discoveryPreviewItems.length > 0 ? (
              <div style={{ display: 'grid', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
                {discoveryPreviewItems.map((item) => (
                  <div
                    key={item.url}
                    style={{
                      fontSize: '0.82rem',
                      padding: '8px 10px',
                      borderRadius: 10,
                      background: 'rgba(15, 23, 42, 0.04)',
                    }}
                  >
                    <strong style={{ display: 'block' }} dir="auto">{item.name}</strong>
                    {item.url && item.url !== item.name && (
                      <div className="ltr-isolate" style={{ color: 'var(--text-light)', wordBreak: 'break-word' }}>{item.url}</div>
                    )}
                  </div>
                ))}
                {discoveredSources.length > discoveryPreviewItems.length && (
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-light)' }}>
                    {t('wizard.successModal.more', { n: discoveredSources.length - discoveryPreviewItems.length })}
                  </span>
                )}
              </div>
            ) : (
              <div style={{ fontSize: '0.84rem', color: 'var(--text-light)' }}>
                {t('wizard.successModal.noneCollected')}
              </div>
            )}
          </div>
        </ConfirmModal>
      </div>
    );
  }

  return (
    <div className="admin-page-shell">
      <div className="admin-page-header">
        <div>
          <div className="admin-page-kicker">
            <CalendarDays size={14} /> {t('list.kicker')}
          </div>
          <h1 className="admin-page-title">{t('list.title')}</h1>
          <p className="admin-page-subtitle">
            {t('list.subtitle')}
          </p>
        </div>
        <div className="admin-page-toolbar">
          <div className="admin-page-toolbar-meta">
            <span>{t('list.statusLabel')}</span>
            <strong>{projects.length ? t('list.configured') : t('list.empty')}</strong>
          </div>
          <div className="admin-page-toolbar-meta">
            <span>{t('list.searchLabel')}</span>
            <strong>
              {t('list.matches', { count: visibleProjects.length, formatted: formatNumber(visibleProjects.length) })}
            </strong>
          </div>
          {canEdit && (
            <Link to="/projects/new" className="btn-primary" style={{ textDecoration: 'none' }}>
              <Plus size={16} /> {t('list.addProject')}
            </Link>
          )}
        </div>
      </div>

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
            <Flag size={18} />
          </div>
          <div>
            <span>{t('list.stats.active')}</span>
            <strong>{formatNumber(stats.active)}</strong>
          </div>
        </div>
        <div className="admin-stat-card">
          <div className="admin-stat-icon" style={{ background: 'rgba(255, 159, 67, 0.14)', color: 'var(--primary-color)' }}>
            <Clock3 size={18} />
          </div>
          <div>
            <span>{t('list.stats.draft')}</span>
            <strong>{formatNumber(stats.draftCount)}</strong>
          </div>
        </div>
        <div className="admin-stat-card">
          <div className="admin-stat-icon" style={{ background: 'rgba(116, 125, 140, 0.14)', color: '#747d8c' }}>
            <Link2 size={18} />
          </div>
          <div>
            <span>{t('list.stats.uniqueSources')}</span>
            <strong>{formatNumber(stats.assignedSources)}</strong>
          </div>
        </div>
      </div>

      <div className="admin-toolbar-row">
        <label className="admin-search">
          <Search size={16} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('list.searchPlaceholder')}
            dir="auto"
          />
        </label>

        <select className="filter-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">{t('list.allStatuses')}</option>
          {STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {statusLabel(status)}
            </option>
          ))}
        </select>
      </div>

      <div className="glass-card admin-list-panel">
        <div className="panel-header-tight">
          <strong style={{ fontSize: '1rem' }}>{t('list.trackedTitle')}</strong>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {isLoadingProjects && <span style={{ fontSize: '0.72rem', color: 'var(--text-light)' }}>{t('common:status.loading')}</span>}
            <span className="panel-chip">{t('list.visible', { n: visibleProjects.length })}</span>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {isLoadingProjects && projects.length === 0 && (
            <div className="admin-empty-state">
              <div className="admin-empty-state-icon">
                <RefreshCw size={18} className="spin" />
              </div>
              <strong>{t('list.loadingTitle')}</strong>
              <span>{t('list.loadingHint')}</span>
            </div>
          )}

          {projects.length === 0 && !isLoadingProjects && (
            <div className="admin-empty-state">
              <div className="admin-empty-state-icon">
                <CalendarDays size={18} />
              </div>
              <strong>{t('list.emptyTitle')}</strong>
              <span>{t('list.emptyHint')}</span>
              {canEdit && (
                <Link to="/projects/new" className="btn-primary" style={{ marginTop: 8, textDecoration: 'none' }}>
                  <Plus size={16} /> {t('list.addProject')}
                </Link>
              )}
            </div>
          )}

          {pagedProjects.map((project, index) => {
            const assignedSourceCount = Array.isArray(project.source_ids) ? project.source_ids.length : 0;
            const isActive = (project.status || '').toLowerCase() === 'active';
            return (
              <motion.div
                key={project.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.03 }}
                className="admin-item-card"
              >
                <div className="admin-item-top">
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
                      <strong className="admin-item-title project-item-title" dir="auto">{project.name}</strong>
                      <span className={`panel-chip ${isActive ? 'success' : project.status === 'archived' ? 'muted' : 'warning'}`}>
                        {statusLabel(project.status || 'draft').toUpperCase()}
                      </span>
                      {project.repeat_enabled && (
                        <span className="panel-chip success">
                          <RefreshCw size={12} />{' '}
                          {t('schedule.repeatEvery', {
                            interval: intervalLabel(project.repeat_interval_value, project.repeat_interval_unit),
                          })}
                        </span>
                      )}
                    </div>
                    <div className="admin-item-meta">
                      <span>{formatProjectDate(project.start_date) || t('list.noStartDate')}</span>
                      <span>{formatProjectDate(project.end_date) || t('list.noEndDate')}</span>
                      <span>
                        {t('list.sourceCount', { count: assignedSourceCount })}
                      </span>
                      {project.repeat_enabled && (
                        <span>{t('list.nextRun', { date: formatDateTime(project.next_run_at) || t('list.pendingFirstRun') })}</span>
                      )}
                      {project.last_run_at && (
                        <span>{t('list.lastRun', { date: formatDateTime(project.last_run_at, undefined, project.last_run_at) })}</span>
                      )}
                    </div>
                    {project.description ? (
                      <div dir="auto" style={{ marginTop: 10, color: 'var(--text-light)', fontSize: '0.88rem', lineHeight: 1.5, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
                        {project.description}
                      </div>
                    ) : (
                      <div style={{ marginTop: 10, color: 'var(--text-light)', fontSize: '0.88rem', lineHeight: 1.5, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
                        {t('list.descriptionFallback')}
                      </div>
                    )}
                  </div>

                  <div className="admin-item-actions">
                    <Link
                      className="btn-secondary"
                      to={`/projects/${project.id}`}
                      style={{ padding: '8px 10px', fontSize: '0.8rem', textDecoration: 'none' }}
                    >
                      <Eye size={14} /> {t('common:actions.view')}
                    </Link>
                  </div>
                </div>
              </motion.div>
            );
          })}

          {!isLoadingProjects && visibleProjects.length === 0 && projects.length > 0 && (
            <div className="admin-empty-state">
              <div className="admin-empty-state-icon">
                <Search size={18} />
              </div>
              <strong>{t('list.noMatchesTitle')}</strong>
              <span>{t('list.noMatchesHint')}</span>
            </div>
          )}
        </div>

        {visibleProjects.length > 0 && (
          <div
            style={{
              marginTop: 14,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
              paddingTop: 12,
              borderTop: '1px solid rgba(15, 23, 42, 0.08)',
            }}
          >
            <div style={{ fontSize: '0.84rem', color: 'var(--text-light)' }}>
              {t('common:pagination.showing', {
                from: (safePage - 1) * PAGE_SIZE + 1,
                to: Math.min(safePage * PAGE_SIZE, visibleProjects.length),
                total: visibleProjects.length,
              })}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                className="btn-secondary"
                onClick={() => setCurrentPage((value) => Math.max(1, value - 1))}
                disabled={safePage <= 1}
                style={{ padding: '8px 10px', fontSize: '0.8rem' }}
              >
                {t('common:actions.previous')}
              </button>
              <span className="panel-chip">
                {t('common:pagination.page', { page: safePage, total: totalPages })}
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

      </div>
    </div>
  );
}
