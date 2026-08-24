/**
 * Competitor workspace — the card grid.
 *
 * Each card answers the same three questions in the same order, so the eye learns
 * the shape once: what they're up to, how it affects us, what to do. Cards are
 * ordered by impact then competitor size, because the point of the screen is to
 * put the thing worth acting on first rather than the most recent thing.
 *
 * Clicking a card opens the full report. The card is a genuine <button> so it is
 * keyboard-reachable, since the whole surface is the click target.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle, BarChart3, Building2, CalendarClock, Check, ChevronRight,
  ExternalLink, Layers, Link2, Pencil, Plus, Radar, RefreshCw, Search,
  ShieldCheck, Sparkles, Trash2,
} from 'lucide-react';
import {
  PLATFORM_LABELS, SIZE_TIER_LABELS, addAccount, addCompetitorManual,
  avatarGradient, deleteStudy, discoverAccounts, discoverCompetitors, discoverTrackedAccounts,
  getSchedule, getStudy, initials, listAccounts, listCompetitors,
  pollDiscoveryRun, relativeTime, saveProfile, setCompetitorStatus, setSchedule, syncSources,
  updateCompetitor, updateStudy, validateAccount,
} from '../competitorApi.js';
import { countryLabel } from '../constants/countries.js';
import { useAuth } from '../auth/useAuth.js';
import ConfirmModal from './ConfirmModal';
import { AddCompetitorForm, AddSourceRow } from './CompetitorSourceEditor.jsx';
import { DiscoveryLog, ListEditor } from './CompetitorOnboarding.jsx';
import '../styles/Competitors.css';

const STUDY_STATUS_OPTIONS = ['draft', 'active', 'archived'];
const SCHEDULE_UNIT_OPTIONS = [
  { value: 'minutes', label: 'minute(s)' },
  { value: 'hours', label: 'hour(s)' },
  { value: 'days', label: 'day(s)' },
];

function AliasEditor({ competitor, onSave }) {
  const stored = Array.isArray(competitor.aliases) ? competitor.aliases : [];
  const [value, setValue] = useState(stored.join(', '));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  // Re-syncing from props is handled by remounting on a key of the stored
  // aliases (see the call site), not by an effect that writes state.
  const dirty = value !== stored.join(', ');

  const save = async () => {
    setBusy(true);
    try {
      await onSave(value.split(',').map((item) => item.trim()).filter(Boolean));
      setSaved(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cs-alias-editor">
      <label className="cs-label" htmlFor={`cs-aliases-${competitor.id}`}>Other names</label>
      <div className="cs-alias-editor-row">
        <input
          id={`cs-aliases-${competitor.id}`}
          className="cs-input"
          value={value}
          placeholder="e.g. Younes Bros, قهوة يونس"
          onChange={(event) => { setValue(event.target.value); setSaved(false); }}
        />
        <button type="button" className="cs-btn cs-btn-sm" onClick={save} disabled={busy || !dirty}>
          {busy ? <span className="cs-spinner" /> : null} {saved && !dirty ? 'Saved' : 'Save'}
        </button>
      </div>
      <small className="cs-row-desc">
        Comma separated. Articles naming any of these count as evidence for this competitor.
      </small>
    </div>
  );
}

// How far back analysis looks for evidence. The backend accepts 1-365 and
// stamps the chosen window on every card as period_start/period_end.
// 30 stays the default: a card answers "what changed", and over a longer
// window a move from six months ago sits beside one from last week with
// nothing to tell them apart. Longer windows are for competitors that are
// simply covered rarely.
// The unfiltered "All sources" list spans every account across every tracked
// and suggested competitor - easily well past a screenful for a study with
// many competitors, so it's paged rather than rendered all at once.
const SOURCES_PAGE_SIZE = 20;

// Fixed identity -> colour mapping for the sources chart, in the order the
// chart always draws them (never re-ordered by count, so a colour always
// means the same platform group). The three hues are a validated-passing
// subset of the standard categorical order (run
// dataviz/scripts/validate_palette.js "#1baf7a,#2a78d6,#4a3aa7" to reproduce);
// "Other" stays neutral gray rather than a fourth hue, and none of the three
// overlap the green/amber/red already reserved for validation-status pills
// elsewhere on this page.
const SOURCE_GROUPS = [
  { key: 'content', label: 'Owned content', platforms: new Set(['news', 'web', 'website', 'blog', 'rss']), color: '#1baf7a' },
  { key: 'x', label: 'X accounts', platforms: new Set(['x']), color: '#2a78d6' },
  { key: 'hashtag', label: 'Hashtags', platforms: new Set(['hashtag']), color: '#4a3aa7' },
  { key: 'other', label: 'Other', platforms: new Set(), color: '#94a3b8' },
];
const SOURCE_GROUP_BY_KEY = Object.fromEntries(SOURCE_GROUPS.map((group) => [group.key, group]));

function sourceGroupKey(platform) {
  const found = SOURCE_GROUPS.find((group) => group.platforms.has(platform));
  return found ? found.key : 'other';
}

function StatTile({ icon: Icon, label, value, tone }) {
  return (
    <div className="cs-panel" style={{ padding: '15px 17px', flex: '1 1 150px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--text-light)', fontSize: '0.75rem', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
        <Icon size={13} /> {label}
      </div>
      <div style={{ fontSize: '1.5rem', fontWeight: 680, marginTop: 6, color: tone || 'var(--text-dark)', letterSpacing: '-0.02em' }}>
        {value}
      </div>
    </div>
  );
}

const SOURCE_STATUS_FILTERS = [
  { key: '', label: 'All statuses' },
  { key: 'valid', label: 'Valid' },
  { key: 'pending', label: 'Pending' },
  { key: 'rejected', label: 'Rejected' },
];

/** Bar-per-group chart, always in SOURCE_GROUPS order regardless of count -
 *  a group's colour never changes as filters change which ones have data. */
function SourceGroupChart({ groupCounts }) {
  const rows = SOURCE_GROUPS.map((group) => ({ ...group, count: groupCounts[group.key] || 0 }));
  const max = Math.max(1, ...rows.map((row) => row.count));

  return (
    <div className="cs-panel" style={{ marginBottom: 20 }}>
      <h2 className="cs-panel-title"><BarChart3 size={16} /> Sources by channel</h2>
      <p className="cs-panel-hint">Every discovered or manually-added source across all competitors, by channel type.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
        {rows.map((row) => (
          <div key={row.key} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ width: 128, flexShrink: 0, fontSize: '0.8rem', color: 'var(--text-dark)', fontWeight: 560 }}>
              {row.label}
            </span>
            <div style={{ flex: 1, height: 16, borderRadius: 8, background: '#f1f5f9', overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: `${(row.count / max) * 100}%`,
                  minWidth: row.count ? 4 : 0,
                  borderRadius: 8,
                  background: row.color,
                  transition: 'width 0.2s ease',
                }}
              />
            </div>
            <span style={{ width: 28, flexShrink: 0, textAlign: 'right', fontSize: '0.82rem', fontWeight: 650, color: 'var(--text-dark)' }}>
              {row.count}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** All sources (competitor accounts) across the study in one place - the
 *  per-competitor "Sources" drawer shows the same data scoped to one company;
 *  this is the aggregate view across the whole study. */
function SourcesPanel({
  sources, filteredTotal, total, groupCounts, search, onSearch, groupFilter, onGroupFilter,
  statusFilter, onStatusFilter, onChooseCompetitors, page, totalPages, onPageChange,
}) {
  return (
    <>
      <SourceGroupChart groupCounts={groupCounts} />

      <div className="cs-panel">
        <h2 className="cs-panel-title"><Link2 size={16} /> All sources</h2>
        <p className="cs-panel-hint">
          {total} source{total === 1 ? '' : 's'} across every tracked and suggested competitor.
        </p>

        {total ? (
          <>
            <div className="cs-panel cs-findings-toolbar" style={{ marginTop: 14 }}>
              <label className="cs-search-field">
                <Search size={16} />
                <input
                  type="text"
                  value={search}
                  onChange={(event) => onSearch(event.target.value)}
                  placeholder="Search competitor, handle, or URL..."
                />
              </label>

              <select className="cs-select" value={groupFilter} onChange={(event) => onGroupFilter(event.target.value)}
                aria-label="Filter by channel">
                <option value="">All channels</option>
                {SOURCE_GROUPS.map((group) => (
                  <option key={group.key} value={group.key}>{group.label}</option>
                ))}
              </select>

              <select className="cs-select" value={statusFilter} onChange={(event) => onStatusFilter(event.target.value)}
                aria-label="Filter by validation status">
                {SOURCE_STATUS_FILTERS.map((option) => (
                  <option key={option.key} value={option.key}>{option.label}</option>
                ))}
              </select>
            </div>

            {filteredTotal ? (
              <div className="cs-rows" style={{ marginTop: 4 }}>
                {sources.map((source) => {
                  const group = SOURCE_GROUP_BY_KEY[sourceGroupKey(source.platform)];
                  return (
                    <div key={source.id} className="cs-row">
                      <span
                        aria-hidden="true"
                        style={{ width: 8, height: 8, borderRadius: 4, background: group.color, flexShrink: 0 }}
                      />
                      <div
                        className="cs-avatar"
                        style={{ background: avatarGradient(source.competitor_name), width: 28, height: 28, fontSize: '0.68rem' }}
                        aria-hidden="true"
                      >
                        {initials(source.competitor_name)}
                      </div>
                      <div className="cs-row-main">
                        <div className="cs-row-name">
                          {source.competitor_name}
                          <span style={{ fontWeight: 400, color: 'var(--text-light)' }}>
                            {' '}· {PLATFORM_LABELS[source.platform] || source.platform}
                            {source.handle ? ` @${source.handle}` : ''}
                          </span>
                        </div>
                        <div className="cs-row-desc">
                          <a href={source.url} target="_blank" rel="noopener noreferrer"
                            style={{ color: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            {source.url} <ExternalLink size={11} />
                          </a>
                        </div>
                      </div>
                      <div className="cs-row-side">
                        {typeof source.confidence === 'number' ? (
                          <span className="cs-pill cs-pill-signal">{Math.round(source.confidence * 100)}% confidence</span>
                        ) : null}
                        <span className={`cs-pill cs-pill-${source.validation_status}`}>{source.validation_status}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="cs-empty">
                <div className="cs-empty-icon"><Search size={20} /></div>
                <h3>No matching sources</h3>
                <p>Try a different search term or clear the channel/status filters.</p>
              </div>
            )}

            {filteredTotal ? (
              <div className="cs-pagination">
                <div className="cs-pagination-info">
                  Showing {(page - 1) * SOURCES_PAGE_SIZE + 1}-{Math.min(page * SOURCES_PAGE_SIZE, filteredTotal)} of {filteredTotal}
                </div>
                <div className="cs-pagination-controls">
                  <button
                    type="button"
                    className="cs-btn cs-btn-sm"
                    onClick={() => onPageChange(Math.max(1, page - 1))}
                    disabled={page <= 1}
                  >
                    Previous
                  </button>
                  <span className="cs-pill cs-pill-signal">Page {page} of {totalPages}</span>
                  <button
                    type="button"
                    className="cs-btn cs-btn-sm"
                    onClick={() => onPageChange(Math.min(totalPages, page + 1))}
                    disabled={page >= totalPages}
                  >
                    Next
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <div className="cs-empty">
            <div className="cs-empty-icon"><Link2 size={20} /></div>
            <h3>No sources yet</h3>
            <p>Track a competitor and confirm or discover its channels to see them here.</p>
            <button type="button" className="cs-btn cs-btn-primary" onClick={onChooseCompetitors}>
              <Layers size={15} /> Choose competitors
            </button>
          </div>
        )}
      </div>
    </>
  );
}

export default function CompetitorWorkspace() {
  const { studyId } = useParams();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('competitors.manage');

  const [study, setStudy] = useState(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [profile, setProfile] = useState(null);
  const [competitors, setCompetitors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCompetitors, setShowCompetitors] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncNotice, setSyncNotice] = useState(null);
  const [sourceSearch, setSourceSearch] = useState('');
  const [sourceGroupFilter, setSourceGroupFilter] = useState('');
  const [sourceStatusFilter, setSourceStatusFilter] = useState('');
  const [sourcePage, setSourcePage] = useState(1);
  const [expandedChannels, setExpandedChannels] = useState(() => new Set());
  const [accountsByCompetitor, setAccountsByCompetitor] = useState({});
  const [channelBusy, setChannelBusy] = useState({});
  const [trackingBusy, setTrackingBusy] = useState({});
  const [unverified, setUnverified] = useState({});
  const [showAddCompetitor, setShowAddCompetitor] = useState(false);
  const [addingManual, setAddingManual] = useState(false);
  const [discoveringCompetitors, setDiscoveringCompetitors] = useState(false);
  const [discoveryNotice, setDiscoveryNotice] = useState(null);
  const [discoveringChannels, setDiscoveringChannels] = useState(false);
  const [discoveryLogs, setDiscoveryLogs] = useState([]);

  const [editOpen, setEditOpen] = useState(false);
  const [editDraft, setEditDraft] = useState({ name: '', description: '', status: 'active' });
  const [savingEdit, setSavingEdit] = useState(false);

  const [schedule, setScheduleState] = useState(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleDraft, setScheduleDraft] = useState({
    repeat_enabled: false, repeat_interval_value: 1, repeat_interval_unit: 'days',
  });
  const [savingSchedule, setSavingSchedule] = useState(false);

  const [profileOpen, setProfileOpen] = useState(false);
  const [profileDraft, setProfileDraft] = useState(null);
  const [savingProfile, setSavingProfile] = useState(false);

  // Fetch inside the effect with a cancel guard, so switching studies mid-request
  // cannot resolve into the newly-selected study's state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const [detail, competitorList, scheduleDetail] = await Promise.all([
          getStudy(studyId),
          listCompetitors(studyId),
          getSchedule(studyId),
        ]);
        if (cancelled) return;
        setStudy(detail.study);
        setProfile(detail.profile);
        setCompetitors(competitorList.competitors || []);
        setScheduleState(scheduleDetail.schedule || null);
      } catch (caught) {
        if (!cancelled) setError(caught.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [studyId]);

  const handleDeleteStudy = async () => {
    setDeleting(true);
    try {
      await deleteStudy(studyId);
      navigate('/competitors');
    } catch (caught) {
      setError(caught.message);
      setDeleting(false);
      setDeleteOpen(false);
    }
  };

  const openEdit = () => {
    setEditDraft({
      name: study?.name || '',
      description: study?.description || '',
      status: study?.status || 'active',
    });
    setEditOpen(true);
  };

  const handleSaveEdit = async () => {
    setSavingEdit(true);
    setError('');
    try {
      const result = await updateStudy(studyId, editDraft);
      setStudy((prev) => ({ ...prev, ...result.study }));
      setEditOpen(false);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setSavingEdit(false);
    }
  };

  // A confirmed channel is only *collected* once it exists as a row in
  // `sources` linked to this study - that's what the scraper reads. Analysis
  // used to trigger this implicitly before every run; with collection as the
  // whole point of a study it's an explicit action instead, and the schedule
  // save below also does it so turning tracking on can't leave a study
  // scheduled to scrape nothing.
  const runSyncSources = async ({ quiet = false } = {}) => {
    if (!quiet) {
      setSyncing(true);
      setSyncNotice(null);
    }
    setError('');
    try {
      const result = await syncSources(studyId);
      if (!quiet) setSyncNotice(result || {});
      return result;
    } catch (caught) {
      setError(caught.message);
      return null;
    } finally {
      if (!quiet) setSyncing(false);
    }
  };

  const openSchedule = () => {
    setScheduleDraft({
      repeat_enabled: Boolean(schedule?.repeat_enabled),
      repeat_interval_value: schedule?.repeat_interval_value || 1,
      repeat_interval_unit: schedule?.repeat_interval_unit || 'days',
    });
    setScheduleOpen(true);
  };

  const handleSaveSchedule = async () => {
    setSavingSchedule(true);
    setError('');
    try {
      const result = await setSchedule(studyId, {
        repeat_enabled: scheduleDraft.repeat_enabled,
        repeat_interval_value: Math.max(1, Number(scheduleDraft.repeat_interval_value) || 1),
        repeat_interval_unit: scheduleDraft.repeat_interval_unit,
      });
      setScheduleState(result.schedule || null);
      setStudy((prev) => (prev ? { ...prev, ...result.schedule } : prev));
      if (scheduleDraft.repeat_enabled) await runSyncSources({ quiet: true });
      setScheduleOpen(false);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setSavingSchedule(false);
    }
  };

  const openProfile = () => {
    setProfileDraft({
      industry: profile?.industry || '',
      market: profile?.market || '',
      positioning: profile?.positioning || '',
      offerings: profile?.offerings || [],
      audience: profile?.audience || [],
      differentiators: profile?.differentiators || [],
      context_summary: profile?.context_summary || '',
    });
    setProfileOpen(true);
  };

  const handleSaveProfile = async () => {
    setSavingProfile(true);
    setError('');
    try {
      const result = await saveProfile(studyId, profileDraft);
      setProfile(result.profile || null);
      setProfileOpen(false);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setSavingProfile(false);
    }
  };

  const saveAliases = async (competitorId, aliases) => {
    try {
      await updateCompetitor(competitorId, { aliases });
      const result = await listCompetitors(studyId);
      setCompetitors(result.competitors || []);
    } catch (caught) {
      setError(caught.message);
    }
  };

  const toggleTracking = async (competitor) => {
    const nextStatus = competitor.status === 'tracked' ? 'ignored' : 'tracked';
    setTrackingBusy((current) => ({ ...current, [competitor.id]: true }));
    try {
      // Phase 2: tracking an AI-suggested competitor for the first time
      // triggers a live web check server-side, so this call can take a beat
      // longer than a plain status flip — the button shows a spinner for it.
      const statusResult = await setCompetitorStatus(competitor.id, nextStatus);
      if (statusResult.verification) {
        setUnverified((current) => ({ ...current, [competitor.id]: !statusResult.verification.verified }));
      }
      const result = await listCompetitors(studyId);
      setCompetitors(result.competitors || []);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setTrackingBusy((current) => ({ ...current, [competitor.id]: false }));
    }
  };

  // Confirmed/valid, pending, and account_count are aggregate counts on the
  // competitor row itself - refetch them after any channel action so the
  // "N pending" banner and per-row counts stay in sync with what was just done.
  const refreshCompetitorCounts = async () => {
    try {
      const result = await listCompetitors(studyId);
      setCompetitors(result.competitors || []);
    } catch (caught) {
      setError(caught.message);
    }
  };

  const toggleChannels = async (competitorId) => {
    setExpandedChannels((current) => {
      const next = new Set(current);
      if (next.has(competitorId)) next.delete(competitorId);
      else next.add(competitorId);
      return next;
    });
    if (accountsByCompetitor[competitorId]) return;
    try {
      const result = await listAccounts(competitorId);
      setAccountsByCompetitor((current) => ({ ...current, [competitorId]: result.accounts || [] }));
    } catch (caught) {
      setError(caught.message);
    }
  };

  const decideAccount = async (competitorId, accountId, status) => {
    try {
      const result = await validateAccount(accountId, status);
      setAccountsByCompetitor((current) => ({
        ...current,
        [competitorId]: (current[competitorId] || []).map((account) =>
          account.id === accountId ? result.account : account,
        ),
      }));
      await refreshCompetitorCounts();
    } catch (caught) {
      setError(caught.message);
    }
  };

  const findChannels = async (competitorId) => {
    setChannelBusy((current) => ({ ...current, [competitorId]: true }));
    try {
      const result = await discoverAccounts(competitorId);
      setAccountsByCompetitor((current) => ({ ...current, [competitorId]: result.accounts || [] }));
      await refreshCompetitorCounts();
    } catch (caught) {
      setError(caught.message);
    } finally {
      setChannelBusy((current) => ({ ...current, [competitorId]: false }));
    }
  };

  const addSourceToCompetitor = async (competitorId, source) => {
    setChannelBusy((current) => ({ ...current, [competitorId]: true }));
    try {
      const result = await addAccount(competitorId, { ...source, validation_status: 'valid', confidence: 1 });
      setAccountsByCompetitor((current) => ({
        ...current,
        [competitorId]: [...(current[competitorId] || []), result.account],
      }));
      await refreshCompetitorCounts();
    } catch (caught) {
      setError(caught.message);
    } finally {
      setChannelBusy((current) => ({ ...current, [competitorId]: false }));
    }
  };

  const handleAddManualCompetitor = async (payload) => {
    setError('');
    setAddingManual(true);
    try {
      await addCompetitorManual(studyId, payload);
      await refreshCompetitorCounts();
      setShowAddCompetitor(false);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setAddingManual(false);
    }
  };

  // Optional, from the workspace rather than onboarding - runs the same
  // background discovery job and merges results into the existing list.
  const runDiscovery = async () => {
    setError('');
    setDiscoveryNotice(null);
    setDiscoveringCompetitors(true);
    setDiscoveryLogs([]);
    try {
      const queued = await discoverCompetitors(studyId, { limit: 12, with_accounts: false });
      const run = await pollDiscoveryRun(studyId, queued.run_id, (r) => setDiscoveryLogs(r.logs || []));
      if (run.status === 'failed') {
        throw new Error(run.error || run.message || 'Competitor discovery failed.');
      }
      await refreshCompetitorCounts();
      setShowCompetitors(true);
      setDiscoveryNotice({ discovered: run.discovered || 0, rejected: run.rejected || [] });
    } catch (caught) {
      setError(caught.message);
    } finally {
      setDiscoveringCompetitors(false);
    }
  };

  // Phase 3: find channels for every tracked competitor that doesn't have one
  // yet, in one shot, instead of clicking "Find channels" per competitor.
  const runChannelDiscovery = async () => {
    setError('');
    setDiscoveringChannels(true);
    setDiscoveryLogs([]);
    try {
      const queued = await discoverTrackedAccounts(studyId);
      if (queued.run_id) {
        const run = await pollDiscoveryRun(studyId, queued.run_id, (r) => setDiscoveryLogs(r.logs || []));
        if (run.status === 'failed') {
          throw new Error(run.error || run.message || 'Channel discovery failed.');
        }
        // Cached per-competitor account lists are now stale for whichever
        // competitors just got new channels - drop the cache so re-expanding
        // "Sources" re-fetches instead of showing the old (empty) list.
        setAccountsByCompetitor({});
        await refreshCompetitorCounts();
      }
    } catch (caught) {
      setError(caught.message);
    } finally {
      setDiscoveringChannels(false);
    }
  };

  const stats = useMemo(() => {
    const tracked = competitors.filter((item) => item.status === 'tracked');
    const pendingChannels = competitors.reduce((sum, item) => sum + (item.pending_account_count || 0), 0);
    const channellessTracked = tracked.filter((item) => !item.account_count).length;
    return { tracked: tracked.length, pendingChannels, channellessTracked };
  }, [competitors]);

  // Every competitor already carries its full `accounts` list from
  // listCompetitors() (see loadAll below) - no extra request needed to see
  // every source across the study at once.
  const allSources = useMemo(
    () => competitors.flatMap((competitor) => (competitor.accounts || []).map((account) => ({
      ...account,
      competitor_id: competitor.id,
      competitor_name: competitor.name,
    }))),
    [competitors],
  );

  const sourceGroupCounts = useMemo(() => {
    const counts = Object.fromEntries(SOURCE_GROUPS.map((group) => [group.key, 0]));
    for (const source of allSources) counts[sourceGroupKey(source.platform)] += 1;
    return counts;
  }, [allSources]);

  const sourceStats = useMemo(() => ({
    total: allSources.length,
    valid: allSources.filter((source) => source.validation_status === 'valid').length,
    pending: allSources.filter((source) => source.validation_status === 'pending').length,
    rejected: allSources.filter((source) => source.validation_status === 'rejected').length,
  }), [allSources]);

  const filteredSources = useMemo(() => {
    const query = sourceSearch.trim().toLowerCase();
    return allSources.filter((source) => {
      if (sourceGroupFilter && sourceGroupKey(source.platform) !== sourceGroupFilter) return false;
      if (sourceStatusFilter && source.validation_status !== sourceStatusFilter) return false;
      if (query) {
        const haystack = `${source.competitor_name} ${source.handle || ''} ${source.url || ''}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }, [allSources, sourceGroupFilter, sourceStatusFilter, sourceSearch]);

  // A new search/filter should land back on page 1, not wherever the user was
  // scrolled to on the old result set - adjusted during render (React's
  // documented pattern for this) rather than an effect, so it takes effect in
  // the same render as the filter change instead of one tick later.
  const sourceFilterKey = `${sourceSearch}|${sourceGroupFilter}|${sourceStatusFilter}`;
  const [prevSourceFilterKey, setPrevSourceFilterKey] = useState(sourceFilterKey);
  if (sourceFilterKey !== prevSourceFilterKey) {
    setPrevSourceFilterKey(sourceFilterKey);
    setSourcePage(1);
  }

  const sourceTotalPages = Math.max(1, Math.ceil(filteredSources.length / SOURCES_PAGE_SIZE));
  const sourceSafePage = Math.min(sourcePage, sourceTotalPages);
  const pagedSources = useMemo(
    () => filteredSources.slice((sourceSafePage - 1) * SOURCES_PAGE_SIZE, sourceSafePage * SOURCES_PAGE_SIZE),
    [filteredSources, sourceSafePage],
  );

  if (loading) {
    return (
      <div className="cs-page">
        <div className="cs-skeleton" style={{ height: 34, width: 280, marginBottom: 12 }} />
        <div className="cs-skeleton" style={{ height: 18, width: 460, marginBottom: 28 }} />
        <div className="cs-card-grid">
          {[0, 1, 2].map((key) => (
            <div key={key} className="cs-skeleton" style={{ height: 300 }} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="cs-page">
      <div className="cs-head">
        <div>
          <Link to="/competitors" className="cs-link-back">
            <ChevronRight size={14} style={{ transform: 'rotate(180deg)' }} /> All studies
          </Link>
          <h1>{study?.name || 'Competitor study'}</h1>
          <p>
            {profile?.name ? (
              <>
                Tracked against <strong>{profile.name}</strong>
                {profile.market ? ` in ${profile.market}` : ''}. Confirm each competitor's channels
                and they are collected on every run of this study.
              </>
            ) : (
              'Add your business profile so competitor discovery has something to compare against.'
            )}
          </p>
        </div>
        <div className="cs-head-actions">
          <button type="button" className="cs-btn" onClick={() => setShowCompetitors((value) => !value)}>
            <Layers size={15} /> {competitors.length} competitor{competitors.length === 1 ? '' : 's'}
          </button>
          <button type="button" className="cs-btn" onClick={runDiscovery} disabled={discoveringCompetitors}>
            {discoveringCompetitors ? <span className="cs-spinner" /> : <Radar size={15} />}
            {discoveringCompetitors ? 'Discovering...' : 'Discover with AI'}
          </button>
          {stats.channellessTracked > 0 && (
            <button type="button" className="cs-btn" onClick={runChannelDiscovery} disabled={discoveringChannels}>
              {discoveringChannels ? <span className="cs-spinner" /> : <Search size={15} />}
              {discoveringChannels ? 'Finding channels...' : `Find channels (${stats.channellessTracked})`}
            </button>
          )}
          {canManage && (
            <>
                  <button type="button" className="cs-btn cs-btn-primary" onClick={() => runSyncSources()} disabled={syncing}>
                {syncing ? <span className="cs-spinner" /> : <RefreshCw size={15} />}
                {syncing ? 'Syncing sources...' : 'Sync sources'}
              </button>
              <button type="button" className="cs-btn" onClick={openProfile}>
                <Building2 size={15} /> {profile ? 'Edit profile' : 'Add profile'}
              </button>
              <button type="button" className="cs-btn" onClick={openSchedule}>
                <CalendarClock size={15} />
                {schedule?.repeat_enabled ? `Every ${schedule.repeat_interval_value} ${schedule.repeat_interval_unit}` : 'Tracking off'}
              </button>
              <button type="button" className="cs-btn" onClick={openEdit}>
                <Pencil size={15} /> Edit study
              </button>
              <button
                type="button"
                className="cs-btn"
                onClick={() => setDeleteOpen(true)}
                style={{ color: '#ff4757' }}
              >
                <Trash2 size={15} /> Delete study
              </button>
            </>
          )}
        </div>
      </div>

      {(discoveringCompetitors || discoveringChannels) ? (
        <DiscoveryLog logs={discoveryLogs} active={discoveringCompetitors || discoveringChannels} />
      ) : null}

      {error ? (
        <div className="cs-alert cs-alert-error">
          <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} /> <span>{error}</span>
        </div>
      ) : null}

      {syncNotice ? (
        <div className="cs-alert cs-alert-info">
          <Check size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            This study&rsquo;s confirmed channels are now linked as scrapable sources
            {Number.isFinite(Number(syncNotice.synced)) ? ` (${syncNotice.synced})` : ''}. They are
            collected on the next run of this study.
          </span>
        </div>
      ) : null}

      {discoveryNotice ? (
        <div className="cs-alert cs-alert-info">
          <Sparkles size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            Discovered {discoveryNotice.discovered} competitor{discoveryNotice.discovered === 1 ? '' : 's'}.
            {discoveryNotice.rejected.length
              ? ` ${discoveryNotice.rejected.length} suggestion${discoveryNotice.rejected.length === 1 ? '' : 's'} dropped during checking.`
              : ''}
            {' '}Review them in the competitors list below.
          </span>
        </div>
      ) : null}

      {stats.pendingChannels > 0 ? (
        <div className="cs-alert cs-alert-warn">
          <ShieldCheck size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            {stats.pendingChannels} channel{stats.pendingChannels === 1 ? '' : 's'} still awaiting
            confirmation. Unconfirmed channels are not scraped, so nothing from them is
            collected.{' '}
            <button type="button" onClick={() => setShowCompetitors(true)}
              style={{ background: 'none', border: 'none', padding: 0, color: 'inherit', fontWeight: 700, textDecoration: 'underline', cursor: 'pointer' }}>
              Review them
            </button>
          </span>
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 20 }}>
        <StatTile icon={Radar} label="Tracked" value={stats.tracked} />
        <StatTile icon={Link2} label="Total sources" value={sourceStats.total} />
        <StatTile icon={ShieldCheck} label="Valid" value={sourceStats.valid} />
        <StatTile icon={RefreshCw} label="Pending" value={sourceStats.pending}
          tone={sourceStats.pending ? '#a16207' : undefined} />
        <StatTile icon={CalendarClock} label="Last run"
          value={study?.last_run_at ? relativeTime(study.last_run_at) : 'Never'} />
      </div>

      {showCompetitors ? (
        <div className="cs-panel" style={{ marginBottom: 20 }}>
          <h2 className="cs-panel-title"><Layers size={16} /> Competitors</h2>
          <p className="cs-panel-hint">
            Only tracked competitors are scraped. Ranked by size.
          </p>

          <div style={{ marginBottom: 18, paddingBottom: 18, borderBottom: '1px solid #eef1f6' }}>
            {showAddCompetitor ? (
              <AddCompetitorForm onSubmit={handleAddManualCompetitor} busy={addingManual} />
            ) : (
              <button type="button" className="cs-btn cs-btn-sm" onClick={() => setShowAddCompetitor(true)}>
                <Plus size={13} /> Add competitor manually
              </button>
            )}
          </div>

          <div className="cs-rows">
            {competitors.map((competitor) => {
              const channelsOpen = expandedChannels.has(competitor.id);
              const accounts = accountsByCompetitor[competitor.id];
              return (
                <div key={competitor.id}>
                  <div className="cs-row">
                    <span className="cs-row-rank">{competitor.size_rank ?? '-'}</span>
                    <div className="cs-avatar" style={{ background: avatarGradient(competitor.name), width: 30, height: 30, fontSize: '0.72rem' }} aria-hidden="true">
                      {initials(competitor.name)}
                    </div>
                    <div className="cs-row-main">
                      <div className="cs-row-name">{competitor.name}</div>
                      <div className="cs-row-desc">
                        {competitor.valid_account_count}/{competitor.account_count} channels confirmed
                        {competitor.pending_account_count ? ` · ${competitor.pending_account_count} pending` : ''}
                        {competitor.finding_count ? ` · ${competitor.finding_count} report(s)` : ''}
                      </div>
                    </div>
                    <div className="cs-row-side">
                      {competitor.country ? (
                        <span className="cs-pill cs-pill-signal" title="Where this company is headquartered">
                          Based in {countryLabel(competitor.country)}
                        </span>
                      ) : null}
                      {Array.isArray(competitor.operates_in_countries) && competitor.operates_in_countries.length ? (
                        <span
                          className="cs-pill cs-pill-signal"
                          title="Where this competitor actually competes with your business"
                        >
                          Competes in {competitor.operates_in_countries.map(countryLabel).join(', ')}
                        </span>
                      ) : null}
                      <span className={`cs-pill cs-pill-${competitor.size_tier}`}>
                        {SIZE_TIER_LABELS[competitor.size_tier] || competitor.size_tier}
                      </span>
                      {competitor.status === 'tracked' && unverified[competitor.id] ? (
                        <span
                          className="cs-pill cs-pill-signal"
                          title="Tracked, but a live web check couldn't confirm this company exists — worth a manual look."
                        >
                          Couldn’t verify
                        </span>
                      ) : null}
                      <button type="button" className="cs-btn cs-btn-sm" onClick={() => toggleChannels(competitor.id)}>
                        <Link2 size={13} /> {channelsOpen ? 'Hide channels' : 'Channels'}
                      </button>
                      <button
                        type="button"
                        className={`cs-btn cs-btn-sm${competitor.status === 'tracked' ? ' cs-btn-primary' : ''}`}
                        onClick={() => toggleTracking(competitor)}
                        disabled={Boolean(trackingBusy[competitor.id])}
                      >
                        {trackingBusy[competitor.id] ? (
                          <span className="cs-spinner" />
                        ) : competitor.status === 'tracked' ? (
                          <><Check size={13} /> Tracking</>
                        ) : (
                          'Track'
                        )}
                      </button>
                    </div>
                  </div>

                  {channelsOpen ? (
                    <div className="cs-rows" style={{ marginLeft: 30, marginBottom: 14 }}>
                      <AliasEditor
                        key={(competitor.aliases || []).join('|')}
                        competitor={competitor}
                        onSave={(aliases) => saveAliases(competitor.id, aliases)}
                      />
                      {!accounts ? (
                        <div className="cs-row-desc" style={{ padding: '8px 0' }}>Loading channels...</div>
                      ) : !accounts.length ? (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0' }}>
                          <span className="cs-row-desc">No channels found yet.</span>
                          <button type="button" className="cs-btn cs-btn-sm"
                            onClick={() => findChannels(competitor.id)} disabled={channelBusy[competitor.id]}>
                            {channelBusy[competitor.id] ? <span className="cs-spinner" /> : <Search size={13} />} Find channels
                          </button>
                        </div>
                      ) : null}
                      {accounts?.length ? (
                        accounts.map((account) => (
                          <div key={account.id} className="cs-row">
                            <div className="cs-row-main">
                              <div className="cs-row-name">
                                {PLATFORM_LABELS[account.platform] || account.platform}
                                {account.handle ? <span style={{ fontWeight: 400, color: 'var(--text-light)' }}> @{account.handle}</span> : null}
                              </div>
                              <div className="cs-row-desc">{account.url}</div>
                            </div>
                            <div className="cs-row-side">
                              {account.confidence != null ? (
                                <span className="cs-pill cs-pill-signal">
                                  {Math.round(Number(account.confidence) * 100)}% sure
                                </span>
                              ) : null}
                              <span className={`cs-pill cs-pill-${account.validation_status}`}>
                                {account.validation_status}
                              </span>
                              {account.validation_status !== 'rejected' ? (
                                <button type="button" className="cs-btn cs-btn-sm cs-btn-danger"
                                  onClick={() => decideAccount(competitor.id, account.id, 'rejected')}>
                                  <Trash2 size={13} /> Not theirs
                                </button>
                              ) : null}
                            </div>
                          </div>
                        ))
                      ) : null}
                      {Array.isArray(accounts) ? (
                        <AddSourceRow
                          busy={Boolean(channelBusy[competitor.id])}
                          onSubmit={(source) => addSourceToCompetitor(competitor.id, source)}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <SourcesPanel
        sources={pagedSources}
        filteredTotal={filteredSources.length}
        total={allSources.length}
        groupCounts={sourceGroupCounts}
        search={sourceSearch}
        onSearch={setSourceSearch}
        groupFilter={sourceGroupFilter}
        onGroupFilter={setSourceGroupFilter}
        statusFilter={sourceStatusFilter}
        onStatusFilter={setSourceStatusFilter}
        onChooseCompetitors={() => setShowCompetitors(true)}
        page={sourceSafePage}
        totalPages={sourceTotalPages}
        onPageChange={setSourcePage}
      />

      <ConfirmModal
        open={editOpen}
        title="Edit study"
        confirmLabel={savingEdit ? 'Saving...' : 'Save changes'}
        cancelLabel="Cancel"
        onClose={() => setEditOpen(false)}
        onConfirm={handleSaveEdit}
      >
        <div className="cs-field">
          <label className="cs-label" htmlFor="cs-study-name">Name</label>
          <input id="cs-study-name" className="cs-input" value={editDraft.name}
            onChange={(event) => setEditDraft({ ...editDraft, name: event.target.value })} />
        </div>
        <div className="cs-field">
          <label className="cs-label" htmlFor="cs-study-description">Description</label>
          <textarea id="cs-study-description" className="cs-textarea" style={{ minHeight: 80 }}
            value={editDraft.description}
            onChange={(event) => setEditDraft({ ...editDraft, description: event.target.value })} />
        </div>
        <div className="cs-field">
          <label className="cs-label" htmlFor="cs-study-status">Status</label>
          <select id="cs-study-status" className="cs-input" value={editDraft.status}
            onChange={(event) => setEditDraft({ ...editDraft, status: event.target.value })}>
            {STUDY_STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>{status}</option>
            ))}
          </select>
        </div>
      </ConfirmModal>

      <ConfirmModal
        open={scheduleOpen}
        title="Tracking schedule"
        message="Automatically re-scrape and re-analyse this study's competitors on a recurring interval."
        confirmLabel={savingSchedule ? 'Saving...' : 'Save schedule'}
        cancelLabel="Cancel"
        onClose={() => setScheduleOpen(false)}
        onConfirm={handleSaveSchedule}
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.88rem', marginBottom: 14 }}>
          <input type="checkbox" checked={scheduleDraft.repeat_enabled}
            onChange={(event) => setScheduleDraft({ ...scheduleDraft, repeat_enabled: event.target.checked })} />
          Scrape automatically
        </label>
        {scheduleDraft.repeat_enabled ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: '0.88rem' }}>
            <span>Every</span>
            <input className="cs-input" type="number" min="1" style={{ width: 78 }}
              value={scheduleDraft.repeat_interval_value}
              onChange={(event) => setScheduleDraft({ ...scheduleDraft, repeat_interval_value: event.target.value })} />
            <select className="cs-input" style={{ width: 130 }} value={scheduleDraft.repeat_interval_unit}
              onChange={(event) => setScheduleDraft({ ...scheduleDraft, repeat_interval_unit: event.target.value })}>
              {SCHEDULE_UNIT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
        ) : null}
      </ConfirmModal>

      <ConfirmModal
        open={profileOpen}
        title="Business profile"
        message="This is the description competitors get matched against, and what every “how does this affect us” judgement is measured by."
        confirmLabel={savingProfile ? 'Saving...' : 'Save profile'}
        cancelLabel="Cancel"
        onClose={() => setProfileOpen(false)}
        onConfirm={handleSaveProfile}
      >
        {profileDraft ? (
          <div style={{ maxHeight: '60vh', overflowY: 'auto', paddingRight: 4 }}>
            <div className="cs-grid-2">
              <div className="cs-field">
                <label className="cs-label" htmlFor="cs-p-industry">Industry</label>
                <input id="cs-p-industry" className="cs-input" value={profileDraft.industry}
                  onChange={(event) => setProfileDraft({ ...profileDraft, industry: event.target.value })} />
              </div>
              <div className="cs-field">
                <label className="cs-label" htmlFor="cs-p-market">Market you compete in</label>
                <input id="cs-p-market" className="cs-input" value={profileDraft.market}
                  onChange={(event) => setProfileDraft({ ...profileDraft, market: event.target.value })} />
              </div>
            </div>

            <div className="cs-field">
              <label className="cs-label" htmlFor="cs-p-positioning">Positioning</label>
              <input id="cs-p-positioning" className="cs-input" value={profileDraft.positioning}
                onChange={(event) => setProfileDraft({ ...profileDraft, positioning: event.target.value })} />
            </div>

            <ListEditor label="What you offer" values={profileDraft.offerings}
              placeholder="demand forecasting"
              onChange={(offerings) => setProfileDraft({ ...profileDraft, offerings })} />
            <ListEditor label="Who buys it" values={profileDraft.audience}
              placeholder="operations directors"
              onChange={(audience) => setProfileDraft({ ...profileDraft, audience })} />
            <ListEditor label="What sets you apart" hint="used to judge competitor moves"
              values={profileDraft.differentiators} placeholder="implementation in under 30 days"
              onChange={(differentiators) => setProfileDraft({ ...profileDraft, differentiators })} />

            <div className="cs-field">
              <label className="cs-label" htmlFor="cs-p-context">Market context</label>
              <textarea id="cs-p-context" className="cs-textarea" style={{ minHeight: 110 }}
                value={profileDraft.context_summary}
                onChange={(event) => setProfileDraft({ ...profileDraft, context_summary: event.target.value })} />
            </div>
          </div>
        ) : null}
      </ConfirmModal>

      <ConfirmModal
        open={deleteOpen}
        title={`Delete study "${study?.name || ''}"?`}
        message="This will permanently remove the study, its business profile, tracked competitors, and findings."
        confirmLabel={deleting ? 'Deleting...' : 'Delete study'}
        cancelLabel="Keep study"
        confirmButtonStyle={{
          background: 'linear-gradient(135deg, #ff4757, #e03131)',
          boxShadow: '0 4px 15px rgba(255, 71, 87, 0.28)',
        }}
        onClose={() => setDeleteOpen(false)}
        onConfirm={handleDeleteStudy}
      />
    </div>
  );
}
