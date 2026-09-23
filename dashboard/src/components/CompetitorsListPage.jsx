/**
 * Competitors — a dedicated page for browsing and managing one study's
 * competitor list, split out of the study Edit page because it's a list
 * resource in its own right (search, pagination) rather than a form field,
 * and because AI discovery (finding new competitors, finding their channels)
 * belongs next to the list it populates rather than on the study workspace.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft, Check, ChevronLeft, Download, Link2, Plus, Radar,
  Search, Sparkles, Trash2,
} from 'lucide-react';
import {
  PLATFORM_LABELS, SIZE_TIER_LABELS, addAccount, addCompetitorManual,
  avatarGradient, deleteCompetitor, discoverAccounts, discoverCompetitors,
  discoverTrackedAccounts, getStudy, initials, listAccounts, listCompetitors,
  pollDiscoveryRun, setCompetitorStatus, updateCompetitor, validateAccount,
} from '../competitorApi.js';
import { countryLabel } from '../constants/countries.js';
import { apiError } from '../errors/apiError.js';
import { formatList, formatNumber, formatPercent } from '../i18n/format.js';
import { useAuth } from '../auth/useAuth.js';
import ConfirmModal from './ConfirmModal';
import ErrorNotice from './ErrorNotice';
import { AddCompetitorForm, AddSourceRow, AliasEditor } from './CompetitorSourceEditor.jsx';
import { DiscoveryLog } from './CompetitorOnboarding.jsx';
import '../styles/Competitors.css';

const PAGE_SIZE = 10;

export default function CompetitorsListPage() {
  const { t } = useTranslation('competitors');
  const { studyId } = useParams();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('competitors.manage');

  const [study, setStudy] = useState(null);
  const [competitors, setCompetitors] = useState([]);
  const [loading, setLoading] = useState(true);
  // Holds the caught Error itself (not just .message) so its API error code
  // reaches ErrorNotice for translation; '' means no error.
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
        if (!cancelled) setLoadError(caught);
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
      setActionError(caught);
    }
  };

  const saveAliases = async (competitorId, aliases) => {
    try {
      await updateCompetitor(competitorId, { aliases });
      await refreshCompetitors();
    } catch (caught) {
      setActionError(caught);
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
      setActionError(caught);
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
      setActionError(caught);
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
      setActionError(caught);
    }
  };

  const findChannelsForOne = async (competitorId) => {
    setChannelBusy((current) => ({ ...current, [competitorId]: true }));
    try {
      const result = await discoverAccounts(competitorId);
      setAccountsByCompetitor((current) => ({ ...current, [competitorId]: result.accounts || [] }));
      await refreshCompetitors();
    } catch (caught) {
      setActionError(caught);
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
      setActionError(caught);
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
      setActionError(caught);
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
      setActionError(caught);
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
        const failure = apiError(data, { status: res.status, fallback: t('list.exportFailed', { status: res.status }) });
        // Kept: this page has always preferred `detail` over `error` as the message.
        if (data?.detail) failure.message = data.detail;
        throw failure;
      }
      const blob = await res.blob();
      const text = await blob.text();
      const count = text.split('\n').filter((line) => line.trim()).length;
      setCompetitorsExportPreview({ blob, count });
    } catch (caught) {
      setActionError(caught);
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
        throw new Error(run.error || run.message || t('list.discoveryFailed'));
      }
      await refreshCompetitors();
      setDiscoveryNotice({ discovered: run.discovered || 0, rejected: run.rejected || [] });
    } catch (caught) {
      setActionError(caught);
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
          throw new Error(run.error || run.message || t('list.channelDiscoveryFailed'));
        }
        // Cached per-competitor account lists are now stale for whichever
        // competitors just got new channels - drop the cache so re-expanding
        // "Channels" re-fetches instead of showing the old (empty) list.
        setAccountsByCompetitor({});
        await refreshCompetitors();
      }
    } catch (caught) {
      setActionError(caught);
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
        <ErrorNotice error={loadError || t('studyNotFound')} context={t('errorContext.loadStudy')} />
        <Link to="/competitors" className="cs-btn" style={{ marginTop: 14 }}>
          <ArrowLeft size={15} className="icon-flip-rtl" /> {t('backToStudies')}
        </Link>
      </div>
    );
  }

  return (
    <div className="cs-page">
      <div className="cs-head">
        <div>
          <Link to={`/competitors/${studyId}`} className="cs-link-back">
            <ChevronLeft size={14} className="icon-flip-rtl" /> <bdi>{study.name}</bdi>
          </Link>
          <h1>{t('list.title')}</h1>
          <p>
            {t('list.summary', { count: competitors.length, tracked: formatNumber(stats.tracked) })}{' '}
            {t('list.summaryHint')}
          </p>
        </div>
        <div className="cs-head-actions">
          <button type="button" className="cs-btn" onClick={runDiscovery} disabled={discoveringCompetitors}>
            {discoveringCompetitors ? <span className="cs-spinner" /> : <Radar size={15} />}
            {discoveringCompetitors ? t('list.discovering') : t('list.discover')}
          </button>
          {stats.channellessTracked > 0 && (
            <button type="button" className="cs-btn" onClick={runChannelDiscovery} disabled={discoveringChannels}>
              {discoveringChannels ? <span className="cs-spinner" /> : <Search size={15} />}
              {discoveringChannels
                ? t('list.findingChannels')
                : t('list.findChannelsCount', { formatted: formatNumber(stats.channellessTracked) })}
            </button>
          )}
          <button
            type="button"
            className="cs-btn"
            onClick={prepareCompetitorsExport}
            disabled={exportingCompetitors}
            title={t('list.exportTitle')}
          >
            {exportingCompetitors ? <span className="cs-spinner" /> : <Download size={15} />}
            {exportingCompetitors ? t('list.preparing') : t('list.exportCompetitors')}
          </button>
        </div>
      </div>

      {(discoveringCompetitors || discoveringChannels) ? (
        <DiscoveryLog logs={discoveryLogs} active={discoveringCompetitors || discoveringChannels} />
      ) : null}

      <ErrorNotice error={actionError} context={t('errorContext.updateCompetitors')} onDismiss={() => setActionError('')} />

      {discoveryNotice ? (
        <div className="cs-alert cs-alert-info">
          <Sparkles size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            {t('list.discovered', { count: discoveryNotice.discovered })}
            {discoveryNotice.rejected.length
              ? ` ${t('list.dropped', { count: discoveryNotice.rejected.length })}`
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
              dir="auto"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('list.searchPlaceholder')}
            />
          </label>
        </div>

        {canManage ? (
          <div style={{ marginBottom: 18, paddingBottom: 18, borderBottom: '1px solid #eef1f6' }}>
            {showAddCompetitor ? (
              <AddCompetitorForm onSubmit={handleAddManualCompetitor} busy={addingManual} />
            ) : (
              <button type="button" className="cs-btn cs-btn-sm" onClick={() => setShowAddCompetitor(true)}>
                <Plus size={13} /> {t('list.addManually')}
              </button>
            )}
          </div>
        ) : null}

        {!competitors.length ? (
          <div className="cs-empty">
            <div className="cs-empty-icon"><Search size={20} /></div>
            <h3>{t('list.emptyTitle')}</h3>
            <p>{t('list.emptyHint')}</p>
          </div>
        ) : !filteredCompetitors.length ? (
          <div className="cs-empty">
            <div className="cs-empty-icon"><Search size={20} /></div>
            <h3>{t('list.noMatchesTitle')}</h3>
            <p>{t('list.noMatchesHint')}</p>
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
                      <span className="cs-row-rank">{competitor.size_rank != null ? formatNumber(competitor.size_rank) : t('list.noRank')}</span>
                      <div className="cs-avatar" style={{ background: avatarGradient(competitor.name), width: 30, height: 30, fontSize: '0.72rem' }} aria-hidden="true">
                        {initials(competitor.name)}
                      </div>
                      <div className="cs-row-main">
                        <div className="cs-row-name" dir="auto">{competitor.name}</div>
                        <div className="cs-row-desc">
                          {[
                            t('list.channelsConfirmed', {
                              valid: formatNumber(competitor.valid_account_count || 0),
                              total: formatNumber(competitor.account_count || 0),
                            }),
                            competitor.pending_account_count
                              ? t('list.pendingCount', { count: competitor.pending_account_count })
                              : null,
                            competitor.finding_count
                              ? t('list.reportCount', { count: competitor.finding_count })
                              : null,
                          ].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                      <div className="cs-row-side">
                        {competitor.country ? (
                          <span className="cs-pill cs-pill-signal" title={t('list.headquarteredTitle')}>
                            {t('list.basedIn', { country: countryLabel(competitor.country) })}
                          </span>
                        ) : null}
                        {Array.isArray(competitor.operates_in_countries) && competitor.operates_in_countries.length ? (
                          <span
                            className="cs-pill cs-pill-signal"
                            title={t('list.competesInTitle')}
                          >
                            {t('list.competesIn', { countries: formatList(competitor.operates_in_countries.map(countryLabel)) })}
                          </span>
                        ) : null}
                        <span className={`cs-pill cs-pill-${competitor.size_tier}`}>
                          {t(`sizeTiers.${competitor.size_tier}`, {
                            defaultValue: SIZE_TIER_LABELS[competitor.size_tier] || competitor.size_tier,
                          })}
                        </span>
                        {competitor.status === 'tracked' && unverified[competitor.id] ? (
                          <span
                            className="cs-pill cs-pill-signal"
                            title={t('list.unverifiedTitle')}
                          >
                            {t('list.unverified')}
                          </span>
                        ) : null}
                        <button type="button" className="cs-btn cs-btn-sm" onClick={() => toggleChannels(competitor.id)}>
                          <Link2 size={13} /> {channelsOpen ? t('list.hideChannels') : t('list.channels')}
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
                                <><Check size={13} /> {t('list.tracking')}</>
                              ) : (
                                t('list.track')
                              )}
                            </button>
                            <button
                              type="button"
                              className="cs-btn cs-btn-sm cs-btn-danger"
                              onClick={() => setDeleteTarget(competitor)}
                              aria-label={t('list.deleteCompetitor', { name: competitor.name })}
                            >
                              <Trash2 size={13} />
                            </button>
                          </>
                        ) : null}
                      </div>
                    </div>

                    {channelsOpen ? (
                      <div className="cs-rows" style={{ marginInlineStart: 30, marginBottom: 14 }}>
                        {canManage ? (
                          <AliasEditor
                            key={(competitor.aliases || []).join('|')}
                            competitor={competitor}
                            onSave={(aliases) => saveAliases(competitor.id, aliases)}
                          />
                        ) : null}
                        {!accounts ? (
                          <div className="cs-row-desc" style={{ padding: '8px 0' }}>{t('list.loadingChannels')}</div>
                        ) : !accounts.length ? (
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0' }}>
                            <span className="cs-row-desc">{t('list.noChannels')}</span>
                            {canManage ? (
                              <button type="button" className="cs-btn cs-btn-sm"
                                onClick={() => findChannelsForOne(competitor.id)} disabled={channelBusy[competitor.id]}>
                                {channelBusy[competitor.id] ? <span className="cs-spinner" /> : <Search size={13} />} {t('list.findChannels')}
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                        {accounts?.length ? (
                          accounts.map((account) => (
                            <div key={account.id} className="cs-row">
                              <div className="cs-row-main">
                                <div className="cs-row-name">
                                  {t(`platforms.${account.platform}`, {
                                    defaultValue: PLATFORM_LABELS[account.platform] || account.platform,
                                  })}
                                  {account.handle ? (
                                    <>
                                      {' '}
                                      <span className="ltr-isolate" style={{ fontWeight: 400, color: 'var(--text-light)' }}>@{account.handle}</span>
                                    </>
                                  ) : null}
                                </div>
                                <div className="cs-row-desc"><span className="ltr-isolate">{account.url}</span></div>
                              </div>
                              <div className="cs-row-side">
                                {account.confidence != null ? (
                                  <span className="cs-pill cs-pill-signal">
                                    {t('list.sure', { percent: formatPercent(Number(account.confidence)) })}
                                  </span>
                                ) : null}
                                <span className={`cs-pill cs-pill-${account.validation_status}`}>
                                  {t(`accountStatus.${account.validation_status}`, { defaultValue: account.validation_status })}
                                </span>
                                {canManage && account.validation_status !== 'rejected' ? (
                                  <button type="button" className="cs-btn cs-btn-sm cs-btn-danger"
                                    onClick={() => decideAccount(competitor.id, account.id, 'rejected')}>
                                    <Trash2 size={13} /> {t('list.notTheirs')}
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
                {t('common:pagination.showing', {
                  from: formatNumber((safePage - 1) * PAGE_SIZE + 1),
                  to: formatNumber(Math.min(safePage * PAGE_SIZE, filteredCompetitors.length)),
                  total: formatNumber(filteredCompetitors.length),
                })}
              </div>
              <div className="cs-pagination-controls">
                <button
                  type="button"
                  className="cs-btn cs-btn-sm"
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                  disabled={safePage <= 1}
                >
                  {t('common:actions.previous')}
                </button>
                <span className="cs-pill cs-pill-signal">
                  {t('common:pagination.page', { page: formatNumber(safePage), total: formatNumber(totalPages) })}
                </span>
                <button
                  type="button"
                  className="cs-btn cs-btn-sm"
                  onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
                  disabled={safePage >= totalPages}
                >
                  {t('common:actions.next')}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      <ConfirmModal
        open={Boolean(deleteTarget)}
        title={t('list.removeConfirm.title', { name: deleteTarget?.name || '' })}
        message={t('list.removeConfirm.message')}
        confirmLabel={deletingCompetitor ? t('list.removeConfirm.confirming') : t('list.removeConfirm.confirm')}
        cancelLabel={t('list.removeConfirm.cancel')}
        confirmButtonStyle={{
          background: 'linear-gradient(135deg, #ff4757, #e03131)',
          boxShadow: '0 4px 15px rgba(255, 71, 87, 0.28)',
        }}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDeleteCompetitor}
      />

      <ConfirmModal
        open={Boolean(competitorsExportPreview)}
        title={t('list.exportConfirm.title')}
        message={
          competitorsExportPreview
            ? study?.name
              ? t('list.exportConfirm.message', { count: competitorsExportPreview.count, name: study.name })
              : t('list.exportConfirm.messageUnnamed', { count: competitorsExportPreview.count })
            : ''
        }
        confirmLabel={t('common:actions.export')}
        cancelLabel={t('common:actions.cancel')}
        onClose={() => setCompetitorsExportPreview(null)}
        onConfirm={confirmCompetitorsExport}
      />
    </div>
  );
}
