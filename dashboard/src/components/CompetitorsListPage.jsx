/**
 * Competitors — a dedicated page for browsing and managing one study's
 * competitor list, split out of the study Edit page because it's a list
 * resource in its own right (search, pagination) rather than a form field,
 * and because AI discovery (finding new competitors, finding their channels)
 * belongs next to the list it populates rather than on the study workspace.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  AlertTriangle, ArrowLeft, Check, ChevronRight, Download, Link2, Plus, Radar,
  Search, Sparkles, Trash2,
} from 'lucide-react';
import {
  PLATFORM_LABELS, SIZE_TIER_LABELS, addAccount, addCompetitorManual,
  avatarGradient, deleteCompetitor, discoverAccounts, discoverCompetitors,
  discoverTrackedAccounts, getStudy, initials, listAccounts, listCompetitors,
  pollDiscoveryRun, setCompetitorStatus, updateCompetitor, validateAccount,
} from '../competitorApi.js';
import { countryLabel } from '../constants/countries.js';
import { useAuth } from '../auth/useAuth.js';
import ConfirmModal from './ConfirmModal';
import { AddCompetitorForm, AddSourceRow, AliasEditor } from './CompetitorSourceEditor.jsx';
import { DiscoveryLog } from './CompetitorOnboarding.jsx';
import '../styles/Competitors.css';

const PAGE_SIZE = 10;

export default function CompetitorsListPage() {
  const { studyId } = useParams();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('competitors.manage');

  const [study, setStudy] = useState(null);
  const [competitors, setCompetitors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const [showAddCompetitor, setShowAddCompetitor] = useState(false);
  const [addingManual, setAddingManual] = useState(false);
  const [trackingBusy, setTrackingBusy] = useState({});
  const [unverified, setUnverified] = useState({});
  const [expandedChannels, setExpandedChannels] = useState(() => new Set());
  const [accountsByCompetitor, setAccountsByCompetitor] = useState({});
  const [channelBusy, setChannelBusy] = useState({});
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deletingCompetitor, setDeletingCompetitor] = useState(false);

  const [discoveringCompetitors, setDiscoveringCompetitors] = useState(false);
  const [discoveryNotice, setDiscoveryNotice] = useState(null);
  const [discoveringChannels, setDiscoveringChannels] = useState(false);
  const [discoveryLogs, setDiscoveryLogs] = useState([]);
  const [actionError, setActionError] = useState('');
  const [exportingCompetitors, setExportingCompetitors] = useState(false);
  const [competitorsExportPreview, setCompetitorsExportPreview] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError('');
      try {
        const [studyDetail, competitorList] = await Promise.all([
          getStudy(studyId),
          listCompetitors(studyId),
        ]);
        if (cancelled) return;
        setStudy(studyDetail.study);
        setCompetitors(competitorList.competitors || []);
      } catch (caught) {
        if (!cancelled) setLoadError(caught.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [studyId]);

  const refreshCompetitors = async () => {
    try {
      const result = await listCompetitors(studyId);
      setCompetitors(result.competitors || []);
    } catch (caught) {
      setActionError(caught.message);
    }
  };

  const saveAliases = async (competitorId, aliases) => {
    try {
      await updateCompetitor(competitorId, { aliases });
      await refreshCompetitors();
    } catch (caught) {
      setActionError(caught.message);
    }
  };

  const toggleTracking = async (competitor) => {
    const nextStatus = competitor.status === 'tracked' ? 'ignored' : 'tracked';
    setTrackingBusy((current) => ({ ...current, [competitor.id]: true }));
    try {
      // Tracking an AI-suggested competitor for the first time triggers a
      // live web check server-side, so this can take a beat longer than a
      // plain status flip — the button shows a spinner for it.
      const statusResult = await setCompetitorStatus(competitor.id, nextStatus);
      if (statusResult.verification) {
        setUnverified((current) => ({ ...current, [competitor.id]: !statusResult.verification.verified }));
      }
      await refreshCompetitors();
    } catch (caught) {
      setActionError(caught.message);
    } finally {
      setTrackingBusy((current) => ({ ...current, [competitor.id]: false }));
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
      setActionError(caught.message);
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
      await refreshCompetitors();
    } catch (caught) {
      setActionError(caught.message);
    }
  };

  const findChannelsForOne = async (competitorId) => {
    setChannelBusy((current) => ({ ...current, [competitorId]: true }));
    try {
      const result = await discoverAccounts(competitorId);
      setAccountsByCompetitor((current) => ({ ...current, [competitorId]: result.accounts || [] }));
      await refreshCompetitors();
    } catch (caught) {
      setActionError(caught.message);
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
      await refreshCompetitors();
    } catch (caught) {
      setActionError(caught.message);
    } finally {
      setChannelBusy((current) => ({ ...current, [competitorId]: false }));
    }
  };

  const handleAddManualCompetitor = async (payload) => {
    setActionError('');
    setAddingManual(true);
    try {
      await addCompetitorManual(studyId, payload);
      await refreshCompetitors();
      setShowAddCompetitor(false);
    } catch (caught) {
      setActionError(caught.message);
    } finally {
      setAddingManual(false);
    }
  };

  const confirmDeleteCompetitor = async () => {
    if (!deleteTarget) return;
    setDeletingCompetitor(true);
    try {
      await deleteCompetitor(deleteTarget.id);
      await refreshCompetitors();
      setDeleteTarget(null);
    } catch (caught) {
      setActionError(caught.message);
    } finally {
      setDeletingCompetitor(false);
    }
  };

  // The handoff to whatever analyzes this study's exported articles - this
  // study's own tracked competitors, so that app doesn't have to re-guess
  // the same list. Fetches the file first so the confirmation modal can show
  // exactly how many rows are about to download; confirming just saves the
  // blob already in hand.
  const prepareCompetitorsExport = async () => {
    if (exportingCompetitors) return;
    setActionError('');
    setExportingCompetitors(true);
    try {
      const res = await fetch(`/api/competitors/export?project_id=${encodeURIComponent(studyId)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.detail || data?.error || `Failed to export competitors (${res.status})`);
      }
      const blob = await res.blob();
      const text = await blob.text();
      const count = text.split('\n').filter((line) => line.trim()).length;
      setCompetitorsExportPreview({ blob, count });
    } catch (caught) {
      setActionError(caught.message);
    } finally {
      setExportingCompetitors(false);
    }
  };

  const confirmCompetitorsExport = () => {
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

  const runDiscovery = async () => {
    setActionError('');
    setDiscoveryNotice(null);
    setDiscoveringCompetitors(true);
    setDiscoveryLogs([]);
    try {
      const queued = await discoverCompetitors(studyId, { limit: 12, with_accounts: false });
      const run = await pollDiscoveryRun(studyId, queued.run_id, (r) => setDiscoveryLogs(r.logs || []));
      if (run.status === 'failed') {
        throw new Error(run.error || run.message || 'Competitor discovery failed.');
      }
      await refreshCompetitors();
      setDiscoveryNotice({ discovered: run.discovered || 0, rejected: run.rejected || [] });
    } catch (caught) {
      setActionError(caught.message);
    } finally {
      setDiscoveringCompetitors(false);
    }
  };

  const runChannelDiscovery = async () => {
    setActionError('');
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
        // "Channels" re-fetches instead of showing the old (empty) list.
        setAccountsByCompetitor({});
        await refreshCompetitors();
      }
    } catch (caught) {
      setActionError(caught.message);
    } finally {
      setDiscoveringChannels(false);
    }
  };

  const stats = useMemo(() => {
    const tracked = competitors.filter((item) => item.status === 'tracked');
    const channellessTracked = tracked.filter((item) => !item.account_count).length;
    return { tracked: tracked.length, channellessTracked };
  }, [competitors]);

  const filteredCompetitors = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return competitors;
    return competitors.filter((competitor) => {
      const haystack = [
        competitor.name,
        competitor.domain,
        competitor.website,
        ...(Array.isArray(competitor.aliases) ? competitor.aliases : []),
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }, [competitors, search]);

  // A new search should land back on page 1 - adjusted during render (React's
  // documented pattern for this) rather than an effect, so it takes effect in
  // the same render as the search change instead of one tick later.
  const [prevSearch, setPrevSearch] = useState(search);
  if (search !== prevSearch) {
    setPrevSearch(search);
    setPage(1);
  }

  const totalPages = Math.max(1, Math.ceil(filteredCompetitors.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedCompetitors = useMemo(
    () => filteredCompetitors.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filteredCompetitors, safePage],
  );

  if (loading) {
    return (
      <div className="cs-page">
        <div className="cs-skeleton" style={{ height: 34, width: 280, marginBottom: 12 }} />
        <div className="cs-skeleton" style={{ height: 300 }} />
      </div>
    );
  }

  if (loadError || !study) {
    return (
      <div className="cs-page">
        <div className="cs-alert cs-alert-error">
          <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{loadError || 'Study not found.'}</span>
        </div>
        <Link to="/competitors" className="cs-btn" style={{ marginTop: 14 }}>
          <ArrowLeft size={15} /> Back to studies
        </Link>
      </div>
    );
  }

  return (
    <div className="cs-page">
      <div className="cs-head">
        <div>
          <Link to={`/competitors/${studyId}`} className="cs-link-back">
            <ChevronRight size={14} style={{ transform: 'rotate(180deg)' }} /> {study.name}
          </Link>
          <h1>Competitors</h1>
          <p>
            {competitors.length} competitor{competitors.length === 1 ? '' : 's'}, {stats.tracked} tracked.
            Only tracked competitors are scraped, and only their confirmed channels are collected.
          </p>
        </div>
        <div className="cs-head-actions">
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
          <button
            type="button"
            className="cs-btn"
            onClick={prepareCompetitorsExport}
            disabled={exportingCompetitors}
            title="Export this study's tracked competitors as JSONL, alongside its articles."
          >
            {exportingCompetitors ? <span className="cs-spinner" /> : <Download size={15} />}
            {exportingCompetitors ? 'Preparing...' : 'Export competitors'}
          </button>
        </div>
      </div>

      {(discoveringCompetitors || discoveringChannels) ? (
        <DiscoveryLog logs={discoveryLogs} active={discoveringCompetitors || discoveringChannels} />
      ) : null}

      {actionError ? (
        <div className="cs-alert cs-alert-error">
          <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} /> <span>{actionError}</span>
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
          </span>
        </div>
      ) : null}

      <div className="cs-panel">
        <div className="cs-panel cs-findings-toolbar" style={{ marginBottom: 14 }}>
          <label className="cs-search-field">
            <Search size={16} />
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by name, website, or alias..."
            />
          </label>
        </div>

        {canManage ? (
          <div style={{ marginBottom: 18, paddingBottom: 18, borderBottom: '1px solid #eef1f6' }}>
            {showAddCompetitor ? (
              <AddCompetitorForm onSubmit={handleAddManualCompetitor} busy={addingManual} />
            ) : (
              <button type="button" className="cs-btn cs-btn-sm" onClick={() => setShowAddCompetitor(true)}>
                <Plus size={13} /> Add competitor manually
              </button>
            )}
          </div>
        ) : null}

        {!competitors.length ? (
          <div className="cs-empty">
            <div className="cs-empty-icon"><Search size={20} /></div>
            <h3>No competitors yet</h3>
            <p>Add one above, or discover some with AI.</p>
          </div>
        ) : !filteredCompetitors.length ? (
          <div className="cs-empty">
            <div className="cs-empty-icon"><Search size={20} /></div>
            <h3>No matching competitors</h3>
            <p>Try a different search term.</p>
          </div>
        ) : (
          <>
            <div className="cs-rows">
              {pagedCompetitors.map((competitor) => {
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
                        {canManage ? (
                          <>
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
                            <button
                              type="button"
                              className="cs-btn cs-btn-sm cs-btn-danger"
                              onClick={() => setDeleteTarget(competitor)}
                              aria-label={`Delete ${competitor.name}`}
                            >
                              <Trash2 size={13} />
                            </button>
                          </>
                        ) : null}
                      </div>
                    </div>

                    {channelsOpen ? (
                      <div className="cs-rows" style={{ marginLeft: 30, marginBottom: 14 }}>
                        {canManage ? (
                          <AliasEditor
                            key={(competitor.aliases || []).join('|')}
                            competitor={competitor}
                            onSave={(aliases) => saveAliases(competitor.id, aliases)}
                          />
                        ) : null}
                        {!accounts ? (
                          <div className="cs-row-desc" style={{ padding: '8px 0' }}>Loading channels...</div>
                        ) : !accounts.length ? (
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0' }}>
                            <span className="cs-row-desc">No channels found yet.</span>
                            {canManage ? (
                              <button type="button" className="cs-btn cs-btn-sm"
                                onClick={() => findChannelsForOne(competitor.id)} disabled={channelBusy[competitor.id]}>
                                {channelBusy[competitor.id] ? <span className="cs-spinner" /> : <Search size={13} />} Find channels
                              </button>
                            ) : null}
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
                                {canManage && account.validation_status !== 'rejected' ? (
                                  <button type="button" className="cs-btn cs-btn-sm cs-btn-danger"
                                    onClick={() => decideAccount(competitor.id, account.id, 'rejected')}>
                                    <Trash2 size={13} /> Not theirs
                                  </button>
                                ) : null}
                              </div>
                            </div>
                          ))
                        ) : null}
                        {canManage && Array.isArray(accounts) ? (
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

            <div className="cs-pagination">
              <div className="cs-pagination-info">
                Showing {(safePage - 1) * PAGE_SIZE + 1}-{Math.min(safePage * PAGE_SIZE, filteredCompetitors.length)} of {filteredCompetitors.length}
              </div>
              <div className="cs-pagination-controls">
                <button
                  type="button"
                  className="cs-btn cs-btn-sm"
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                  disabled={safePage <= 1}
                >
                  Previous
                </button>
                <span className="cs-pill cs-pill-signal">Page {safePage} of {totalPages}</span>
                <button
                  type="button"
                  className="cs-btn cs-btn-sm"
                  onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
                  disabled={safePage >= totalPages}
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      <ConfirmModal
        open={Boolean(deleteTarget)}
        title={`Remove "${deleteTarget?.name || ''}" from this study?`}
        message="This permanently removes the competitor and its channels. Any past findings about it are kept."
        confirmLabel={deletingCompetitor ? 'Removing...' : 'Remove competitor'}
        cancelLabel="Keep competitor"
        confirmButtonStyle={{
          background: 'linear-gradient(135deg, #ff4757, #e03131)',
          boxShadow: '0 4px 15px rgba(255, 71, 87, 0.28)',
        }}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDeleteCompetitor}
      />

      <ConfirmModal
        open={Boolean(competitorsExportPreview)}
        title="Export competitors?"
        message={
          competitorsExportPreview
            ? `This will download ${competitorsExportPreview.count} tracked competitor${
                competitorsExportPreview.count === 1 ? '' : 's'
              } for "${study?.name || 'this study'}" as JSONL.`
            : ''
        }
        confirmLabel="Export"
        cancelLabel="Cancel"
        onClose={() => setCompetitorsExportPreview(null)}
        onConfirm={confirmCompetitorsExport}
      />
    </div>
  );
}
