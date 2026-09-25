/**
 * Competitor study onboarding.
 *
 *   1. Your business  — name + website. The website is what makes the rest work,
 *                       so it is asked for first and its scrape is shown honestly.
 *   2. Market context — the AI's reading of the site, editable. Shown rather than
 *                       hidden because everything downstream is judged against it.
 *                       "Re-run analysis" re-scrapes and re-derives from scratch,
 *                       overwriting any hand edits, without going back to step 1.
 *   3. Cultural analysis — optional, and only shown when target countries were
 *                       chosen in step 1: an AI assessment of how the business
 *                       would fare in that culture (success factors, benefits,
 *                       difficulties, and a summary). Skippable — continuing
 *                       without running it is the skip path.
 *   4. Competitors    — manual-first: add competitors and their sources directly,
 *                       and they are valid and scrape-ready immediately, no
 *                       confirmation step needed. "Suggest with AI" is an optional
 *                       action on the same screen; AI-suggested competitors and
 *                       their channels still need a quick review before they're
 *                       trusted the same way a manual entry already is.
 *   5. Channels       — every channel found for a tracked competitor, manual or
 *                       AI-discovered, is listed here already included (channels
 *                       are trusted by default, same as a manually-entered
 *                       competitor). Discard any that aren't actually theirs, or
 *                       add one yourself if something's missing, before moving on.
 *   6. Schedule       — how often confirmed sources get re-scraped, then finish.
 *
 * A study defines who to watch and where to collect from; it draws no
 * conclusions (cultural analysis is the one exception, and it's scoped to
 * fit, not to the competitors themselves). Whatever analyzes the collected
 * articles lives elsewhere.
 *
 * Step ids run 2..7 rather than 1..6 - the wizard used to open on a
 * data-source choice (live sources vs uploaded documents) that no longer
 * exists, and id 4 (cultural analysis) is skipped in the chip row entirely
 * when there are no target countries. The chip row numbers by position, so
 * neither gap is visible; renaming ids would churn every setStep call for no
 * gain.
 *
 * Long steps (scrape, discovery) run tens of seconds, so each shows staged
 * progress instead of an indeterminate spinner.
 */

import { useMemo, useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import {
  ArrowLeft, ArrowRight, Building2, CalendarClock, Check, CheckCircle2, ChevronRight,
  Globe, Link2, Loader2, Plus, Radar, Search, Sparkles, Trash2, Users, X,
} from 'lucide-react';
import {
  PLATFORM_LABELS, SIZE_TIER_LABELS, addAccount, addCompetitorManual,
  avatarGradient, buildProfile, createStudy, discoverCompetitors, discoverTrackedAccounts,
  getProfile, initials, listAccounts, listCompetitors, listStudies,
  pollDiscoveryRun, runCulturalAnalysis, saveProfile, setCompetitorStatus, setSchedule, validateAccount,
} from '../competitorApi.js';
import { SCRAPE_STAGES } from '../constants/competitorStages.js';
import { countryLabel, localizedCountries } from '../constants/countries.js';
import { REPEAT_UNIT_OPTIONS } from '../constants/schedule.js';
import { AddCompetitorForm, AddSourceRow } from './CompetitorSourceEditor.jsx';
import { WeekdayPicker } from './ProjectsPage.jsx';
import ErrorNotice from './ErrorNotice';
import { apiError } from '../errors/apiError.js';
import {
  formatDuration, formatList, formatNumber, generatedLanguageNeedsRefresh,
  generatedTextDirection,
} from '../i18n/format.js';
import { translateDiscoveryLog, translateRejectionReason } from '../i18n/competitorText.js';
import '../styles/Competitors.css';

// `labelKey` is translated at render time (competitorOnboarding namespace).
const STEPS = [
  { id: 2, labelKey: 'steps.business', icon: Building2 },
  { id: 3, labelKey: 'steps.marketContext', icon: Sparkles },
  { id: 4, labelKey: 'steps.culturalAnalysis', icon: Users },
  { id: 5, labelKey: 'steps.competitors', icon: Radar },
  { id: 6, labelKey: 'steps.channels', icon: Link2 },
  { id: 7, labelKey: 'steps.schedule', icon: CalendarClock },
];

// Phase 1 only asks the model for names and ranks them - no web verification
// yet (that happens per competitor when it's tracked) and channels are a
// separate step (CHANNEL_STAGES below), so this list must not claim either.
// Every stage list holds fully-qualified i18n keys; StageList translates them.
const DISCOVERY_STAGES = [
  'competitorOnboarding:stages.discovery.compareProfile',
  'competitorOnboarding:stages.discovery.nameCandidates',
  'competitorOnboarding:stages.discovery.filterDuplicates',
  'competitorOnboarding:stages.discovery.rankBySize',
];

// One synchronous LLM call against the already-derived business profile —
// same shape as SCRAPE_STAGES above, not the discovery job's staged polling.
const CULTURAL_STAGES = [
  'competitorOnboarding:stages.cultural.readContext',
  'competitorOnboarding:stages.cultural.weighFit',
  'competitorOnboarding:stages.cultural.workOutFactors',
  'competitorOnboarding:stages.cultural.writeSummary',
];

// Phase 3: finding channels for whichever competitors got tracked.
const CHANNEL_STAGES = [
  'competitorOnboarding:stages.channels.checkFeeds',
  'competitorOnboarding:stages.channels.searchAccounts',
  'competitorOnboarding:stages.channels.askModel',
  'competitorOnboarding:stages.channels.searchReviews',
  'competitorOnboarding:stages.channels.linkSources',
];

/** Real-time progress lines from a discovery run's `logs` (see
 *  competitorApi.js's pollDiscoveryRun `onUpdate`) — each poll can add more, so
 *  this auto-scrolls to keep the latest line in view. Styled like StageList
 *  (same row/icon language: a checkmark per finished line, a spinner on the
 *  most recent one while the run is still active) so the real detail trail
 *  reads as a continuation of that same progress UI rather than a separate
 *  terminal-style log. Renders nothing until there's at least one line, and
 *  stays visible after the run finishes so the trail can still be reviewed.
 *  Exported so CompetitorWorkspace.jsx can reuse it, the same way it already
 *  reuses ListEditor from this file. */
export function DiscoveryLog({ logs, active }) {
  const { t } = useTranslation('competitorOnboarding');
  const boxRef = useRef(null);
  const [now, setNow] = useState(null);

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [logs?.length]);

  // The backend can go quiet for a while on a single slow step (an LLM call
  // has no sub-progress to report) - without this, the last line just sits
  // there and reads as stuck. Ticking a counter next to it at least shows
  // time is passing, not that the run died. `Date.now()` only ever runs here,
  // inside an effect, never during render.
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, logs?.length]);

  if (!logs?.length) return null;

  const lastTs = new Date(logs[logs.length - 1].ts).getTime();
  const elapsed = now ? Math.max(0, Math.round((now - lastTs) / 1000)) : 0;

  return (
    <div className="cs-panel cs-discovery-log" style={{ marginTop: 14, background: '#fcfdff' }}>
      <div className="cs-progress" ref={boxRef}>
        {logs.map((entry, index) => {
          const isCurrent = active && index === logs.length - 1;
          const display = translateDiscoveryLog(entry, t);
          return (
            <div
              key={index}
              className={`cs-progress-row${isCurrent ? ' cs-progress-row-active' : ' cs-progress-row-done'}`}
            >
              {isCurrent ? <span className="cs-spinner" /> : <CheckCircle2 size={15} />}
              <span dir={display.translated ? undefined : 'auto'}>
                {display.text}
                {isCurrent && elapsed >= 4 ? t('discoveryLog.stillWorking', { duration: formatDuration(elapsed) }) : ''}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Staged feedback for a slow request. Advances on a timer purely so the wait
 *  reads as progress; it never claims the work finished — that is driven by the
 *  response, which replaces this component entirely. Rendered only while a
 *  request is in flight, so each run mounts it fresh at stage zero. */
export function StageList({ stages }) {
  // Stages are fully-qualified i18n keys (e.g. 'common:competitorStages.fetchWebsite').
  const { t } = useTranslation();
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setActiveIndex((current) => Math.min(current + 1, stages.length - 1));
    }, 2600);
    return () => clearInterval(timer);
  }, [stages.length]);

  return (
    <div className="cs-progress">
      {stages.map((stage, i) => {
        const done = i < activeIndex;
        const active = i === activeIndex;
        return (
          <div
            key={stage}
            className={`cs-progress-row${active ? ' cs-progress-row-active' : ''}${done ? ' cs-progress-row-done' : ''}`}
          >
            {done ? <CheckCircle2 size={15} /> : active ? <span className="cs-spinner" /> : <span style={{ width: 15 }} />}
            <span>{t(stage)}</span>
          </div>
        );
      })}
    </div>
  );
}

export function ListEditor({ label, hint, values, onChange, placeholder, dir = 'auto' }) {
  const { t } = useTranslation('competitorOnboarding');
  const [draft, setDraft] = useState('');
  const items = Array.isArray(values) ? values : [];

  const add = () => {
    const value = draft.trim();
    if (!value || items.includes(value)) {
      setDraft('');
      return;
    }
    onChange([...items, value]);
    setDraft('');
  };

  return (
    <div className="cs-field">
      <label className="cs-label">
        {label}
        {hint ? <span className="cs-label-hint">{hint}</span> : null}
      </label>
      <div className="cs-pills" style={{ marginBottom: items.length ? 9 : 0 }}>
        {items.map((item) => (
          <span key={item} className="cs-pill" dir={dir}>
            <bdi dir={dir}>{item}</bdi>
            <button
              type="button"
              onClick={() => onChange(items.filter((value) => value !== item))}
              aria-label={t('listEditor.remove', { item })}
              style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, display: 'flex', color: 'inherit' }}
            >
              <X size={11} />
            </button>
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          className="cs-input"
          dir={dir}
          value={draft}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="cs-btn" onClick={add} disabled={!draft.trim()}>
          <Plus size={14} /> {t('common:actions.add')}
        </button>
      </div>
    </div>
  );
}

/** Fixed-list country multi-select: type to filter, click a match to add,
 *  selected countries render as removable pills. Modeled on ListEditor above,
 *  since free text would let "USA" and "United States" reach the discovery
 *  prompt as different values. */
export function CountryPicker({ label, hint, values, onChange }) {
  const { t } = useTranslation('competitorOnboarding');
  const [query, setQuery] = useState('');
  const selected = Array.isArray(values) ? values : [];
  // Matches the name in the UI language, the English name, or the ISO code,
  // so "Germany", "ألمانيا", and "DE" all find the same country.
  const needle = query.trim().toLocaleLowerCase();
  const matches = needle
    ? localizedCountries().filter(
        (c) =>
          !selected.includes(c.code) &&
          (c.name.toLocaleLowerCase().includes(needle) ||
            c.englishName.toLowerCase().includes(needle) ||
            c.code.toLowerCase() === needle),
      ).slice(0, 8)
    : [];

  const add = (code) => {
    if (!selected.includes(code)) onChange([...selected, code]);
    setQuery('');
  };

  return (
    <div className="cs-field">
      <label className="cs-label">
        {label}
        {hint ? <span className="cs-label-hint">{hint}</span> : null}
      </label>
      <div className="cs-pills" style={{ marginBottom: selected.length ? 9 : 0 }}>
        {selected.map((code) => (
          <span key={code} className="cs-pill">
            {countryLabel(code)}
            <button
              type="button"
              onClick={() => onChange(selected.filter((value) => value !== code))}
              aria-label={t('countryPicker.remove', { country: countryLabel(code) })}
              style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, display: 'flex', color: 'inherit' }}
            >
              <X size={11} />
            </button>
          </span>
        ))}
      </div>
      <div style={{ position: 'relative' }}>
        <input
          className="cs-input"
          dir="auto"
          value={query}
          placeholder={t('countryPicker.searchPlaceholder')}
          onChange={(event) => setQuery(event.target.value)}
        />
        {matches.length ? (
          <div className="cs-dropdown">
            {matches.map((c) => (
              <button key={c.code} type="button" className="cs-dropdown-item" onClick={() => add(c.code)}>
                {c.name}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(dateIso, days) {
  if (!dateIso) return '';
  const parsed = new Date(`${dateIso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return '';
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

// The retrieval window is date-granular, so a minutes/hours interval still
// needs to resolve to at least a 1-day-wide window rather than 0.
function intervalToDays(value, unit) {
  const amount = Math.max(1, Number(value) || 1);
  if (unit === 'minutes') return Math.max(1, Math.ceil(amount / 1440));
  if (unit === 'hours') return Math.max(1, Math.ceil(amount / 24));
  return amount;
}

export default function CompetitorOnboarding() {
  const { t, i18n } = useTranslation('competitorOnboarding');
  const navigate = useNavigate();
  const [step, setStep] = useState(2);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [step1Mode, setStep1Mode] = useState(null); // 'ai' | 'manual' while the business step is busy

  const [studyName, setStudyName] = useState('');
  const [studyId, setStudyId] = useState(null);

  const [business, setBusiness] = useState({ name: '', website: '', description: '' });
  const [targetCountries, setTargetCountries] = useState([]);
  const [profile, setProfile] = useState(null);
  const [scrape, setScrape] = useState(null);
  const [culturalAnalysis, setCulturalAnalysis] = useState(null);
  const [culturalBusy, setCulturalBusy] = useState(false);
  // Re-running step 3's context derivation (re-scrape + re-derive) without
  // leaving the step, distinct from `busy` which covers saving/continuing.
  const [contextBusy, setContextBusy] = useState(false);

  // 'new' builds a fresh business profile (scrape+AI, or manual); 'existing'
  // reuses one already derived for a past study, skipping both.
  const [businessMode, setBusinessMode] = useState('new');
  const [existingBusinesses, setExistingBusinesses] = useState([]);
  const [loadingBusinesses, setLoadingBusinesses] = useState(false);
  const [businessSearch, setBusinessSearch] = useState('');
  const [selectedBusinessId, setSelectedBusinessId] = useState(null);
  const [selectedBusinessProfile, setSelectedBusinessProfile] = useState(null);

  const [competitors, setCompetitors] = useState([]);
  const [rejected, setRejected] = useState([]);
  const [addingManual, setAddingManual] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [findingChannels, setFindingChannels] = useState(false);
  const [discoveryLogs, setDiscoveryLogs] = useState([]);

  const [expandedChannels, setExpandedChannels] = useState(() => new Set());
  const [accountsByCompetitor, setAccountsByCompetitor] = useState({});
  const [sourceBusy, setSourceBusy] = useState({});
  const [trackingBusy, setTrackingBusy] = useState({});
  const [trackingAllBusy, setTrackingAllBusy] = useState(false);
  const [unverified, setUnverified] = useState({});

  const [scheduleIntervalValue, setScheduleIntervalValue] = useState(1);
  const [scheduleIntervalUnit, setScheduleIntervalUnit] = useState('days');
  const [scheduleWeekdays, setScheduleWeekdays] = useState([]);
  const [scheduleOn, setScheduleOn] = useState(true);
  // Defaults to today rather than blank, since the window is required before
  // finishing — no effect needed, this only ever needs to run once.
  const [retrievalStart, setRetrievalStart] = useState(() => todayIso());
  // Only holds a real value while the schedule toggle is off (manual entry);
  // while it's on, the window's end is derived fresh each render below so
  // changing the repeat interval resizes it without a setState-in-effect.
  const [retrievalEnd, setRetrievalEnd] = useState('');

  const canLeaveStep1 = business.name.trim().length > 0;
  const trackedCompetitors = useMemo(
    () => competitors.filter((competitor) => competitor.status === 'tracked'),
    [competitors],
  );
  const untrackedCompetitors = useMemo(
    () => competitors.filter((competitor) => competitor.status !== 'tracked'),
    [competitors],
  );
  // Only counts competitors whose accounts have already loaded (undefined
  // means "not fetched yet", not "found nothing") - avoids a misleading 0
  // flashing before step 5's own effect has loaded them.
  const channellessTracked = useMemo(
    () => trackedCompetitors.filter((competitor) => accountsByCompetitor[competitor.id]?.length === 0).length,
    [trackedCompetitors, accountsByCompetitor],
  );
  // The cultural-analysis step has nothing to analyze without target
  // countries, so it's hidden entirely rather than shown empty.
  const visibleSteps = useMemo(
    () => (targetCountries.length ? STEPS : STEPS.filter((item) => item.id !== 4)),
    [targetCountries.length],
  );
  const filteredExistingBusinesses = useMemo(() => {
    const query = businessSearch.trim().toLowerCase();
    if (!query) return existingBusinesses;
    return existingBusinesses.filter(
      (b) => (b.business_name || '').toLowerCase().includes(query)
        || (b.business_website || '').toLowerCase().includes(query),
    );
  }, [existingBusinesses, businessSearch]);

  const refreshCompetitors = async () => {
    const result = await listCompetitors(studyId);
    setCompetitors(result.competitors || []);
  };

  const ensureStudy = async () => {
    if (studyId) return studyId;
    const fallbackName = business.name.trim()
      ? t('study.defaultName', { name: business.name.trim() })
      : t('study.untitled');
    const created = await createStudy({ name: studyName.trim() || fallbackName });
    setStudyId(created.study.id);
    return created.study.id;
  };

  // Step 2 -> 3: create the study, scrape the site, derive the market context.
  const submitBusiness = async () => {
    setError('');
    setBusy(true);
    setStep1Mode('ai');
    try {
      const id = await ensureStudy();
      const result = await buildProfile(id, { ...business, target_countries: targetCountries });
      setProfile(result.profile);
      setScrape(result.scrape);
      if (!result.ai_derived) {
        setError(t('errors.contextNotGenerated'));
      }
      setStep(3);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
      setStep1Mode(null);
    }
  };

  // Businesses that already have a derived profile from a past study, deduped
  // by website (falling back to name) so the same company scraped twice
  // doesn't show up as two picks.
  const loadExistingBusinesses = async () => {
    setLoadingBusinesses(true);
    try {
      const { studies } = await listStudies();
      const seen = new Set();
      const businesses = [];
      for (const study of studies || []) {
        if (!study.business_name) continue;
        const key = (study.business_website || study.business_name).trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        businesses.push(study);
      }
      setExistingBusinesses(businesses);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoadingBusinesses(false);
    }
  };

  // Lazy-load once the user actually asks to reuse a business, not on every
  // visit to step 2 — most studies create a new business and never need it.
  useEffect(() => {
    if (step !== 2 || businessMode !== 'existing') return;
    if (existingBusinesses.length || loadingBusinesses) return;
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await loadExistingBusinesses();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, businessMode]);

  const switchBusinessMode = (mode) => {
    if (mode === businessMode) return;
    setError('');
    setBusinessMode(mode);
    setSelectedBusinessId(null);
    setSelectedBusinessProfile(null);
    setBusiness({ name: '', website: '', description: '' });
    setTargetCountries([]);
  };

  const chooseExistingBusiness = async (study) => {
    setError('');
    setSelectedBusinessId(study.id);
    setSelectedBusinessProfile(null);
    try {
      const { profile: sourceProfile } = await getProfile(study.id);
      if (!sourceProfile) {
        setError(t('errors.profileLoadFailed'));
        return;
      }
      setBusiness({
        name: sourceProfile.name || '',
        website: sourceProfile.website || '',
        description: sourceProfile.description || '',
      });
      setTargetCountries(sourceProfile.target_countries || []);
      setSelectedBusinessProfile(sourceProfile);
    } catch (caught) {
      setError(caught);
    }
  };

  // Step 2 -> 3, reusing a business: no scrape, no LLM call — just copy the
  // already-derived profile onto this study, still editable on the next step.
  const continueWithExistingBusiness = async () => {
    if (!selectedBusinessProfile) return;
    setError('');
    setBusy(true);
    setStep1Mode('existing');
    try {
      const id = await ensureStudy();
      const saved = await saveProfile(id, { ...selectedBusinessProfile, target_countries: targetCountries });
      setProfile(saved.profile);
      setScrape(null);
      setStep(3);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
      setStep1Mode(null);
    }
  };

  // Step 2 -> 3, no AI: skip the scrape/derive call entirely and persist
  // exactly what was typed in, so Step 2 opens blank and ready to fill in by hand.
  const submitBusinessManually = async () => {
    setError('');
    setBusy(true);
    setStep1Mode('manual');
    try {
      const id = await ensureStudy();
      const saved = await saveProfile(id, {
        name: business.name.trim(),
        website: business.website.trim(),
        description: business.description.trim(),
        target_countries: targetCountries,
      });
      setProfile(saved.profile);
      setScrape(null);
      setStep(3);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
      setStep1Mode(null);
    }
  };

  // Step 3: re-scrape the website and re-derive the market context from
  // scratch, overwriting whatever is on screen (including hand edits) —
  // the escape hatch for a bad first read, without going back to step 2.
  const rerunContext = async () => {
    setError('');
    setContextBusy(true);
    try {
      const result = await buildProfile(studyId, { ...business, target_countries: targetCountries });
      setScrape(result.scrape);
      if (!result.ai_derived) {
        setError(t('errors.contextNotGenerated'));
        return;
      }
      setProfile(result.profile);
    } catch (caught) {
      setError(caught);
    } finally {
      setContextBusy(false);
    }
  };

  // Step 3 -> 4 (or -> 5 with no target countries): save any edits and move
  // on. Competitors are added manually from here; AI suggestion is an
  // optional action on that screen, not a step.
  const submitContext = async () => {
    setError('');
    setBusy(true);
    try {
      const saved = await saveProfile(studyId, profile);
      setProfile(saved.profile);
      await refreshCompetitors();
      setStep(targetCountries.length ? 4 : 5);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  // Step 4: optional — assess cultural fit for the target countries chosen in
  // step 2. Continuing without running this is the "skip" path; nothing is
  // required here to move on.
  const runCultural = async () => {
    setError('');
    setCulturalBusy(true);
    try {
      const result = await runCulturalAnalysis(studyId);
      setCulturalAnalysis(result.cultural_analysis);
    } catch (caught) {
      setError(caught);
    } finally {
      setCulturalBusy(false);
    }
  };

  const handleAddManualCompetitor = async (payload) => {
    setError('');
    setAddingManual(true);
    try {
      const result = await addCompetitorManual(studyId, payload);
      await refreshCompetitors();
      // Only pre-seed the cache when there's something to show immediately -
      // an empty array here would look identical to "already fetched, found
      // nothing" to every reader of this cache (step 4's drawer, step 5's
      // auto-load), permanently hiding channels that automatic discovery
      // finds for this competitor later since nothing would think to re-fetch.
      if (result.accounts?.length) {
        setAccountsByCompetitor((current) => ({ ...current, [result.competitor.id]: result.accounts }));
      }
    } catch (caught) {
      setError(caught);
    } finally {
      setAddingManual(false);
    }
  };

  const runAiSuggest = async () => {
    setError('');
    setDiscovering(true);
    setDiscoveryLogs([]);
    try {
      const queued = await discoverCompetitors(studyId, { limit: 12, with_accounts: false });
      const run = await pollDiscoveryRun(studyId, queued.run_id, (r) => setDiscoveryLogs(r.logs || []));
      if (run.status === 'failed') {
        throw apiError(
          { ...run, error: run.error || run.message },
          { fallback: t('errors.discoveryFailed') },
        );
      }
      await refreshCompetitors();
      setRejected(run.rejected || []);
    } catch (caught) {
      setError(caught);
    } finally {
      setDiscovering(false);
    }
  };

  // Step 4 -> 5: before showing the channels review step, find channels for
  // whichever competitors the user chose to track — best-effort, since a
  // failure here shouldn't block moving on (channels can still be found later
  // from the workspace, and the review step below shows whatever came back).
  const continueToChannels = async () => {
    setFindingChannels(true);
    setDiscoveryLogs([]);
    try {
      const queued = await discoverTrackedAccounts(studyId);
      if (queued.run_id) {
        await pollDiscoveryRun(studyId, queued.run_id, (r) => setDiscoveryLogs(r.logs || []));
        await refreshCompetitors();
      }
    } catch {
      // best-effort — see comment above.
    } finally {
      setFindingChannels(false);
      setStep(6);
    }
  };

  // Step 5's own "Find more channels" button — reruns the same bulk job as
  // above for any tracked competitor still without one (more may have been
  // tracked since, or the first pass came back empty), but stays on this step
  // and, unlike the automatic pass above, surfaces a failure instead of
  // swallowing it, since this is an explicit user action rather than a
  // best-effort step transition. Also re-fetches each competitor's account
  // list afterwards, since accounts are only lazy-loaded once per competitor.
  const findMoreChannels = async () => {
    setError('');
    setFindingChannels(true);
    setDiscoveryLogs([]);
    try {
      const queued = await discoverTrackedAccounts(studyId);
      if (queued.run_id) {
        await pollDiscoveryRun(studyId, queued.run_id, (r) => setDiscoveryLogs(r.logs || []));
      }
      await refreshCompetitors();
      const results = await Promise.allSettled(
        trackedCompetitors.map((competitor) => listAccounts(competitor.id)),
      );
      setAccountsByCompetitor((current) => {
        const next = { ...current };
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') next[trackedCompetitors[index].id] = result.value.accounts || [];
        });
        return next;
      });
    } catch (caught) {
      setError(caught);
    } finally {
      setFindingChannels(false);
    }
  };

  const toggleTracking = async (competitor) => {
    const nextStatus = competitor.status === 'tracked' ? 'ignored' : 'tracked';
    setTrackingBusy((current) => ({ ...current, [competitor.id]: true }));
    try {
      // Phase 2: tracking an AI-suggested competitor for the first time
      // triggers a live web check server-side, so this call can take a beat
      // longer than a plain status flip — the button shows a spinner for it.
      const result = await setCompetitorStatus(competitor.id, nextStatus);
      if (result.verification) {
        setUnverified((current) => ({ ...current, [competitor.id]: !result.verification.verified }));
      }
      await refreshCompetitors();
    } catch (caught) {
      setError(caught);
    } finally {
      setTrackingBusy((current) => ({ ...current, [competitor.id]: false }));
    }
  };

  // Tracks every not-yet-tracked competitor in one go, so a user with a long
  // AI-suggested list doesn't have to click "Track" once per row. Runs the
  // per-competitor status calls (each one a live web check the first time an
  // AI suggestion is tracked, see toggleTracking above) in parallel rather
  // than one after another, and keeps going even if one of them fails.
  const trackAllCompetitors = async () => {
    const targets = untrackedCompetitors;
    if (!targets.length) return;
    setTrackingAllBusy(true);
    setTrackingBusy((current) => ({
      ...current,
      ...Object.fromEntries(targets.map((competitor) => [competitor.id, true])),
    }));
    try {
      const results = await Promise.allSettled(
        targets.map((competitor) => setCompetitorStatus(competitor.id, 'tracked')),
      );
      setUnverified((current) => {
        const next = { ...current };
        results.forEach((result, index) => {
          if (result.status === 'fulfilled' && result.value.verification) {
            next[targets[index].id] = !result.value.verification.verified;
          }
        });
        return next;
      });
      const failed = results.filter((result) => result.status === 'rejected').length;
      if (failed) {
        setError(t('errors.trackAllPartial', {
          count: targets.length,
          tracked: targets.length - failed,
          failed,
        }));
      }
      await refreshCompetitors();
    } finally {
      setTrackingBusy((current) => ({
        ...current,
        ...Object.fromEntries(targets.map((competitor) => [competitor.id, false])),
      }));
      setTrackingAllBusy(false);
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
      setError(caught);
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
      setError(caught);
    }
  };

  const addSourceToCompetitor = async (competitorId, source) => {
    setSourceBusy((current) => ({ ...current, [competitorId]: true }));
    try {
      const result = await addAccount(competitorId, { ...source, validation_status: 'valid', confidence: 1 });
      setAccountsByCompetitor((current) => ({
        ...current,
        [competitorId]: [...(current[competitorId] || []), result.account],
      }));
      await refreshCompetitors();
    } catch (caught) {
      setError(caught);
    } finally {
      setSourceBusy((current) => ({ ...current, [competitorId]: false }));
    }
  };

  // Step 5 shows every tracked competitor's channels at once instead of the
  // per-competitor drawer step 4 uses, so make sure they're all loaded the
  // moment this step is reached rather than waiting for a click.
  useEffect(() => {
    if (step !== 5) return;
    trackedCompetitors
      .filter((competitor) => !accountsByCompetitor[competitor.id])
      .forEach((competitor) => {
        listAccounts(competitor.id)
          .then((result) => {
            setAccountsByCompetitor((current) => ({ ...current, [competitor.id]: result.accounts || [] }));
          })
          .catch(() => {});
      });
  }, [step, trackedCompetitors, accountsByCompetitor]);

  // While the repeat schedule is on, the window's end is derived fresh from
  // the interval on every render - the same start_date/end_date columns
  // Opinion Monitor projects use to scope which article publish dates get
  // pulled in - so "every 7 days" always means a 7-day window with no stale
  // state to keep in sync. Turning the schedule off freezes it at whatever it
  // last resolved to, then hands editing over to the retrievalEnd state.
  const scheduleWindowDays = intervalToDays(scheduleIntervalValue, scheduleIntervalUnit);
  const effectiveRetrievalEnd = scheduleOn ? addDaysIso(retrievalStart, scheduleWindowDays) : retrievalEnd;

  const finish = async () => {
    setError('');
    setBusy(true);
    try {
      // Offline studies have nothing to scrape yet, so scheduling never applies
      // Scheduling always applies: a study exists to be re-scraped.
      await setSchedule(studyId, {
        repeat_enabled: scheduleOn,
        repeat_interval_value: Math.max(1, Number(scheduleIntervalValue) || 1),
        repeat_interval_unit: scheduleIntervalUnit,
        repeat_weekdays: scheduleWeekdays,
        start_date: retrievalStart || null,
        end_date: effectiveRetrievalEnd || null,
      });
      navigate(`/competitors/${studyId}`);
    } catch (caught) {
      setError(caught);
      setBusy(false);
    }
  };

  return (
    <div className="cs-page cs-wizard">
      <div className="cs-head">
        <div>
          <h1>{t('page.title')}</h1>
          <p>{t('page.intro')}</p>
        </div>
      </div>

      <div className="cs-steps" role="list">
        {visibleSteps.map((item, index) => {
          const state = step === item.id ? ' cs-step-active' : step > item.id ? ' cs-step-done' : '';
          const Icon = item.icon;
          // Only steps already completed can be jumped back to — their data is
          // already loaded. A step not yet reached has nothing to show yet, so
          // it stays inert rather than opening a blank/broken panel.
          const clickable = step > item.id;
          return (
            <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button
                type="button"
                className={`cs-step${state}${clickable ? ' cs-step-clickable' : ''}`}
                role="listitem"
                aria-current={step === item.id}
                onClick={clickable ? () => setStep(item.id) : undefined}
                disabled={!clickable}
                title={clickable ? t('steps.backTo', { step: t(item.labelKey) }) : undefined}
              >
                <span className="cs-step-num">
                  {step > item.id ? <Check size={12} /> : formatNumber(index + 1)}
                </span>
                <Icon size={14} />
                <span>{t(item.labelKey)}</span>
              </button>
              {index < visibleSteps.length - 1 ? <ChevronRight size={14} className="cs-step-sep icon-flip-rtl" /> : null}
            </div>
          );
        })}
      </div>

      <ErrorNotice error={error} context={t('errorContext.setup')} onDismiss={() => setError('')} />

      {step === 2 ? (
        <div className="cs-panel">
          <h2 className="cs-panel-title"><Building2 size={16} /> {t('business.title')}</h2>
          <p className="cs-panel-hint">{t('business.hint')}</p>

          <div className="cs-field">
            <label className="cs-label">{t('business.label')}</label>
            <div className="cs-view-tabs" style={{ marginInline: 0, marginBottom: 4 }}>
              <button
                type="button"
                className={`cs-view-tab${businessMode === 'new' ? ' active' : ''}`}
                onClick={() => switchBusinessMode('new')}
              >
                <Plus size={13} /> {t('business.createNew')}
              </button>
              <button
                type="button"
                className={`cs-view-tab${businessMode === 'existing' ? ' active' : ''}`}
                onClick={() => switchBusinessMode('existing')}
              >
                <Search size={13} /> {t('business.chooseExisting')}
              </button>
            </div>
          </div>

          {businessMode === 'existing' ? (
            <div className="cs-field">
              <div style={{ position: 'relative' }}>
                <div className="cs-search-field">
                  <Search size={14} />
                  <input
                    value={businessSearch}
                    dir="auto"
                    placeholder={t('business.searchPlaceholder')}
                    onChange={(event) => setBusinessSearch(event.target.value)}
                  />
                </div>
                {filteredExistingBusinesses.length ? (
                  <div className="cs-dropdown" style={{ position: 'static', marginTop: 8 }}>
                    {filteredExistingBusinesses.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="cs-dropdown-item"
                        style={selectedBusinessId === item.id
                          ? { background: '#f1f5f9', fontWeight: 600 } : undefined}
                        onClick={() => chooseExistingBusiness(item)}
                      >
                        <bdi>{item.business_name}</bdi>
                        {item.business_website ? (
                          <span className="ltr-isolate" style={{ marginInlineStart: 8, fontWeight: 400, color: 'var(--text-light)' }}>
                            {item.business_website}
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              {loadingBusinesses ? (
                <p className="cs-panel-hint"><Loader2 size={13} className="cs-spin" /> {t('business.loadingPast')}</p>
              ) : null}
              {!loadingBusinesses && !existingBusinesses.length ? (
                <p className="cs-panel-hint">{t('business.noPast')}</p>
              ) : null}
              {selectedBusinessProfile ? (
                <>
                  <div className="cs-alert cs-alert-info" style={{ marginTop: 10 }}>
                    <CheckCircle2 size={16} style={{ flexShrink: 0 }} />
                    <span>
                      <Trans
                        t={t}
                        i18nKey="business.reusing"
                        values={{ name: selectedBusinessProfile.name }}
                        components={{ strong: <strong dir="auto" /> }}
                      />
                    </span>
                  </div>
                  <CountryPicker
                    label={t('business.targetCountries')}
                    hint={t('business.targetCountriesCarriedHint')}
                    values={targetCountries}
                    onChange={setTargetCountries}
                  />
                </>
              ) : null}
            </div>
          ) : null}

          {businessMode === 'new' ? (
            <>
              <div className="cs-field">
                <label className="cs-label" htmlFor="cs-biz-name">{t('business.name')}</label>
                <input
                  id="cs-biz-name"
                  className="cs-input"
                  dir="auto"
                  value={business.name}
                  placeholder={t('business.namePlaceholder')}
                  onChange={(event) => setBusiness({ ...business, name: event.target.value })}
                />
              </div>

              <div className="cs-field">
                <label className="cs-label" htmlFor="cs-biz-site">
                  {t('business.website')}<span className="cs-label-hint">{t('business.websiteHint')}</span>
                </label>
                <input
                  id="cs-biz-site"
                  className="cs-input"
                  dir="ltr"
                  value={business.website}
                  placeholder="northwind.com"
                  onChange={(event) => setBusiness({ ...business, website: event.target.value })}
                />
              </div>

              <div className="cs-field">
                <label className="cs-label" htmlFor="cs-biz-desc">
                  {t('business.description')}<span className="cs-label-hint">{t('business.optional')}</span>
                </label>
                <textarea
                  id="cs-biz-desc"
                  className="cs-textarea"
                  dir="auto"
                  value={business.description}
                  placeholder={t('business.descriptionPlaceholder')}
                  onChange={(event) => setBusiness({ ...business, description: event.target.value })}
                />
              </div>

              <CountryPicker
                label={t('business.targetCountries')}
                hint={t('business.targetCountriesHint')}
                values={targetCountries}
                onChange={setTargetCountries}
              />
            </>
          ) : null}

          <div className="cs-field">
            <label className="cs-label" htmlFor="cs-study-name">
              {t('study.name')}<span className="cs-label-hint">{t('study.nameHint')}</span>
            </label>
            <input
              id="cs-study-name"
              className="cs-input"
              dir="auto"
              value={studyName}
              placeholder={business.name ? t('study.defaultName', { name: business.name }) : t('study.namePlaceholder')}
              onChange={(event) => setStudyName(event.target.value)}
            />
          </div>

          {busy && businessMode === 'new' ? (
            <div className="cs-panel" style={{ marginTop: 18, background: '#fcfdff' }}>
              <StageList stages={SCRAPE_STAGES} />
            </div>
          ) : null}

          <div className="cs-wizard-foot">
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <button type="button" className="cs-btn cs-btn-ghost" onClick={() => navigate('/competitors')} disabled={busy}>
                <ArrowLeft size={15} className="icon-flip-rtl" /> {t('common:actions.back')}
              </button>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-light)' }}>
                {businessMode === 'existing' ? t('business.footReuse') : t('business.footRead')}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {businessMode === 'existing' ? (
                <button
                  type="button"
                  className="cs-btn cs-btn-primary"
                  onClick={continueWithExistingBusiness}
                  disabled={!selectedBusinessProfile || busy}
                >
                  {busy ? <Loader2 size={15} className="cs-spin" /> : <ArrowRight size={15} className="icon-flip-rtl" />}
                  {busy ? t('common:actions.saving') : t('business.continueExisting')}
                </button>
              ) : (
                <>
                  <button type="button" className="cs-btn" onClick={submitBusinessManually} disabled={!canLeaveStep1 || busy}>
                    {busy && step1Mode === 'manual' ? <Loader2 size={15} className="cs-spin" /> : <Building2 size={15} />}
                    {t('business.writeManually')}
                  </button>
                  <button type="button" className="cs-btn cs-btn-primary" onClick={submitBusiness} disabled={!canLeaveStep1 || busy}>
                    {busy && step1Mode === 'ai' ? <Loader2 size={15} className="cs-spin" /> : <ArrowRight size={15} className="icon-flip-rtl" />}
                    {busy && step1Mode === 'ai' ? t('business.readingSite') : t('business.readWithAi')}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {/* ---------------- Step 3: market context ---------------- */}
      {step === 3 && profile ? (
        <>
          {scrape?.status === 'success' ? (
            <div className="cs-alert cs-alert-info">
              <Globe size={16} style={{ flexShrink: 0 }} />
              <span>{t('context.readPages', { count: scrape.pages.length, chars: formatNumber(scrape.chars) })}</span>
            </div>
          ) : scrape ? (
            <ErrorNotice error={scrape.error || t('errors.websiteUnreadable')} context={t('errorContext.readWebsite')} compact />
          ) : null}

          <div className="cs-panel">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <h2 className="cs-panel-title" style={{ marginBottom: 4 }}><Sparkles size={16} /> {t('context.title')}</h2>
                <p className="cs-panel-hint" style={{ marginBottom: 0 }}>{t('context.hint')}</p>
              </div>
              <button
                type="button"
                className="cs-btn"
                onClick={rerunContext}
                disabled={!business.website.trim() || contextBusy || busy}
              >
                {contextBusy ? <span className="cs-spinner" /> : <Sparkles size={15} />}
                {contextBusy ? t('business.readingSite') : t('context.rerun')}
              </button>
            </div>

            {contextBusy ? (
              <div className="cs-panel" style={{ marginTop: 14, background: '#fcfdff' }}>
                <StageList stages={SCRAPE_STAGES} />
              </div>
            ) : null}

            {!contextBusy && generatedLanguageNeedsRefresh(profile, i18n.resolvedLanguage || i18n.language) ? (
                <div className="cs-alert cs-alert-warn" role="status" style={{ marginTop: 14 }}>
                  {t('context.languageMismatch')}
                </div>
              ) : null}

            <div className="cs-grid-2">
              <div className="cs-field">
                <label className="cs-label" htmlFor="cs-industry">{t('context.industry')}</label>
                <input id="cs-industry" className="cs-input" dir={generatedTextDirection(profile.generated_language)} value={profile.industry || ''}
                  onChange={(event) => setProfile({ ...profile, industry: event.target.value })} />
              </div>
              <div className="cs-field">
                <label className="cs-label" htmlFor="cs-market">{t('context.market')}</label>
                <input id="cs-market" className="cs-input" dir={generatedTextDirection(profile.generated_language)} value={profile.market || ''}
                  onChange={(event) => setProfile({ ...profile, market: event.target.value })} />
              </div>
            </div>

            <div className="cs-field">
              <label className="cs-label" htmlFor="cs-positioning">{t('context.positioning')}</label>
              <input id="cs-positioning" className="cs-input" dir={generatedTextDirection(profile.generated_language)} value={profile.positioning || ''}
                onChange={(event) => setProfile({ ...profile, positioning: event.target.value })} />
            </div>

            <ListEditor label={t('context.offerings')} values={profile.offerings}
              dir={generatedTextDirection(profile.generated_language)}
              placeholder={t('context.offeringsPlaceholder')}
              onChange={(offerings) => setProfile({ ...profile, offerings })} />
            <ListEditor label={t('context.audience')} values={profile.audience}
              dir={generatedTextDirection(profile.generated_language)}
              placeholder={t('context.audiencePlaceholder')}
              onChange={(audience) => setProfile({ ...profile, audience })} />
            <ListEditor label={t('context.differentiators')} hint={t('context.differentiatorsHint')}
              dir={generatedTextDirection(profile.generated_language)}
              values={profile.differentiators} placeholder={t('context.differentiatorsPlaceholder')}
              onChange={(differentiators) => setProfile({ ...profile, differentiators })} />

            <div className="cs-field">
              <label className="cs-label" htmlFor="cs-context">{t('context.summary')}</label>
              <textarea id="cs-context" className="cs-textarea" dir={generatedTextDirection(profile.generated_language)} style={{ minHeight: 110 }}
                value={profile.context_summary || ''}
                onChange={(event) => setProfile({ ...profile, context_summary: event.target.value })} />
            </div>

            <div className="cs-wizard-foot">
              <button type="button" className="cs-btn cs-btn-ghost" onClick={() => setStep(2)} disabled={busy || contextBusy}>
                <ArrowLeft size={15} className="icon-flip-rtl" /> {t('common:actions.back')}
              </button>
              <button type="button" className="cs-btn cs-btn-primary" onClick={submitContext} disabled={busy || contextBusy}>
                {busy ? <span className="cs-spinner" /> : <ArrowRight size={15} className="icon-flip-rtl" />}
                {busy
                  ? t('common:actions.saving')
                  : targetCountries.length ? t('context.continueCultural') : t('context.continueCompetitors')}
              </button>
            </div>
          </div>
        </>
      ) : null}

      {/* ---------------- Step 4: cultural analysis ---------------- */}
      {step === 4 ? (
        <div className="cs-panel">
          <h2 className="cs-panel-title"><Users size={16} /> {t('cultural.title')}</h2>
          <p className="cs-panel-hint">{t('cultural.hint')}</p>

          <button type="button" className="cs-btn cs-btn-primary" onClick={runCultural} disabled={culturalBusy}>
            {culturalBusy ? <span className="cs-spinner" /> : <Sparkles size={15} />}
            {culturalBusy ? t('cultural.analyzing') : culturalAnalysis ? t('context.rerun') : t('cultural.run')}
          </button>

          {culturalBusy ? (
            <div className="cs-panel" style={{ marginTop: 14, background: '#fcfdff' }}>
              <StageList stages={CULTURAL_STAGES} />
            </div>
          ) : null}

          {!culturalBusy && culturalAnalysis ? (
            culturalAnalysis.status === 'success' ? (
              <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
                {generatedLanguageNeedsRefresh(culturalAnalysis, i18n.resolvedLanguage || i18n.language) ? (
                    <div className="cs-alert cs-alert-warn" role="status">
                      {t('cultural.languageMismatch')}
                    </div>
                  ) : null}
                <div className="cs-field" style={{ marginBottom: 0 }}>
                  <label className="cs-label">{t('cultural.summary')}</label>
                  <p dir={generatedTextDirection(culturalAnalysis.generated_language)} style={{ margin: 0, fontSize: '0.88rem', lineHeight: 1.55 }}>{culturalAnalysis.summary}</p>
                </div>
                {[
                  ['cultural.successFactors', culturalAnalysis.success_factors],
                  ['cultural.benefits', culturalAnalysis.benefits],
                  ['cultural.challenges', culturalAnalysis.challenges],
                  ['cultural.insights', culturalAnalysis.insights],
                ].map(([labelKey, items]) => (
                  Array.isArray(items) && items.length ? (
                    <div key={labelKey} className="cs-field" style={{ marginBottom: 0 }}>
                      <label className="cs-label">{t(labelKey)}</label>
                      <ul style={{ margin: 0, paddingInlineStart: 20, fontSize: '0.86rem', lineHeight: 1.6 }}>
                        {items.map((item, index) => <li key={index} dir={generatedTextDirection(culturalAnalysis.generated_language)}>{item}</li>)}
                      </ul>
                    </div>
                  ) : null
                ))}
              </div>
            ) : (
              <ErrorNotice error={culturalAnalysis.error || t('errors.analysisNotGenerated')} context={t('errorContext.generateAnalysis')} compact />
            )
          ) : null}

          <div className="cs-wizard-foot">
            <button type="button" className="cs-btn cs-btn-ghost" onClick={() => setStep(3)} disabled={busy || culturalBusy}>
              <ArrowLeft size={15} className="icon-flip-rtl" /> {t('common:actions.back')}
            </button>
            <button type="button" className="cs-btn cs-btn-primary" onClick={() => setStep(5)} disabled={culturalBusy}>
              <ArrowRight size={15} className="icon-flip-rtl" /> {culturalAnalysis ? t('common:actions.continue') : t('cultural.skip')}
            </button>
          </div>
        </div>
      ) : null}

      {/* ---------------- Step 5: competitors ---------------- */}
      {step === 5 ? (
        <>
          <div className="cs-panel">
            <h2 className="cs-panel-title"><Building2 size={16} /> {t('competitors.addTitle')}</h2>
            <p className="cs-panel-hint">{t('competitors.addHint')}</p>
            <AddCompetitorForm onSubmit={handleAddManualCompetitor} busy={addingManual} />
          </div>

          <div className="cs-panel">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <h2 className="cs-panel-title" style={{ marginBottom: 4 }}>
                  <Sparkles size={16} /> {t('competitors.suggestTitle')}
                </h2>
                <p className="cs-panel-hint" style={{ marginBottom: 0 }}>{t('competitors.suggestHint')}</p>
              </div>
              <button type="button" className="cs-btn" onClick={runAiSuggest} disabled={discovering}>
                {discovering ? <span className="cs-spinner" /> : <Sparkles size={15} />}
                {discovering ? t('competitors.suggesting') : t('competitors.suggest')}
              </button>
            </div>

            {discovering ? (
              <div className="cs-panel" style={{ marginTop: 14, background: '#fcfdff' }}>
                <StageList stages={DISCOVERY_STAGES} />
              </div>
            ) : null}
            {discovering ? <DiscoveryLog logs={discoveryLogs} active={discovering} /> : null}

            {rejected.length ? (
              <details style={{ marginTop: 16 }}>
                <summary style={{ cursor: 'pointer', fontSize: '0.82rem', color: 'var(--text-light)' }}>
                  {t('competitors.rejectedSummary', { count: rejected.length })}
                </summary>
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {rejected.map((item) => (
                    <div key={item.name} style={{ fontSize: '0.81rem', color: 'var(--text-light)' }}>
                      <strong dir="auto" style={{ color: 'var(--text-dark)' }}>{item.name}</strong>
                      {' — '}
                      <bdi>{translateRejectionReason(item, t)}</bdi>
                    </div>
                  ))}
                </div>
              </details>
            ) : null}
          </div>

          <div className="cs-panel">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <h2 className="cs-panel-title" style={{ marginBottom: 4 }}><Radar size={16} /> {t('competitors.listTitle')}</h2>
                <p className="cs-panel-hint" style={{ marginBottom: 0 }}>
                  <Trans
                    t={t}
                    i18nKey="competitors.trackedSummary"
                    values={{ tracked: formatNumber(trackedCompetitors.length) }}
                    components={{ strong: <strong /> }}
                  />
                </p>
              </div>
              {untrackedCompetitors.length ? (
                <button type="button" className="cs-btn cs-btn-sm" onClick={trackAllCompetitors} disabled={trackingAllBusy}>
                  {trackingAllBusy ? <span className="cs-spinner" /> : <Check size={13} />}
                  {trackingAllBusy
                    ? t('competitors.trackingAll')
                    : t('competitors.trackAll', { total: formatNumber(untrackedCompetitors.length) })}
                </button>
              ) : null}
            </div>

            {!competitors.length ? (
              <div className="cs-empty">
                <div className="cs-empty-icon"><Search size={20} /></div>
                <h3>{t('competitors.emptyTitle')}</h3>
                <p>{t('competitors.emptyHint')}</p>
              </div>
            ) : (
              <div className="cs-rows">
                {competitors.map((competitor) => {
                  const channelsOpen = expandedChannels.has(competitor.id);
                  const accounts = accountsByCompetitor[competitor.id];
                  const isManual = competitor.discovery_source === 'manual';
                  const tracked = competitor.status === 'tracked';
                  return (
                    <div key={competitor.id}>
                      <div className={`cs-row${tracked ? ' cs-row-selected' : ''}`}>
                        <span className="cs-row-rank">{competitor.size_rank != null ? formatNumber(competitor.size_rank) : '-'}</span>
                        <div
                          className="cs-avatar"
                          style={{ background: avatarGradient(competitor.name), width: 30, height: 30, fontSize: '0.72rem' }}
                          aria-hidden="true"
                        >
                          {initials(competitor.name)}
                        </div>
                        <div className="cs-row-main">
                          <div className="cs-row-name" dir="auto">{competitor.name}</div>
                          <div className="cs-row-desc" dir={generatedTextDirection(competitor.generated_language)}>
                            {competitor.description || competitor.size_signals?.why_competitor || competitor.domain || '—'}
                          </div>
                          {generatedLanguageNeedsRefresh(competitor, i18n.resolvedLanguage || i18n.language) ? (
                            <div className="cs-row-desc" style={{ color: 'var(--warning-dark, #92400e)' }}>
                              {t('competitors.languageMismatch')}
                            </div>
                          ) : null}
                        </div>
                        <div className="cs-row-side">
                          <span className={`cs-pill ${isManual ? 'cs-pill-manual' : 'cs-pill-ai'}`}>
                            {isManual ? t('competitors.origin.manual') : t('competitors.origin.ai')}
                          </span>
                          {competitor.country ? (
                            <span className="cs-pill cs-pill-signal" title={t('competitors.basedInTitle')}>
                              {t('competitors.basedIn', { country: countryLabel(competitor.country) })}
                            </span>
                          ) : null}
                          {Array.isArray(competitor.operates_in_countries) && competitor.operates_in_countries.length ? (
                            <span
                              className="cs-pill cs-pill-signal"
                              title={t('competitors.competesInTitle')}
                            >
                              {t('competitors.competesIn', {
                                countries: formatList(competitor.operates_in_countries.map(countryLabel)),
                              })}
                            </span>
                          ) : null}
                          <span className={`cs-pill cs-pill-${competitor.size_tier}`}>
                            {t(`sizeTiers.${competitor.size_tier}`, {
                              defaultValue: SIZE_TIER_LABELS[competitor.size_tier] || competitor.size_tier,
                            })}
                          </span>
                          {tracked && unverified[competitor.id] ? (
                            <span
                              className="cs-pill cs-pill-signal"
                              title={t('competitors.unverifiedTitle')}
                            >
                              {t('competitors.unverified')}
                            </span>
                          ) : null}
                          <button type="button" className="cs-btn cs-btn-sm" onClick={() => toggleChannels(competitor.id)}>
                            <Link2 size={13} /> {channelsOpen ? t('competitors.hideSources') : t('competitors.sources')}
                          </button>
                          <button
                            type="button"
                            className={`cs-btn cs-btn-sm${tracked ? ' cs-btn-primary' : ''}`}
                            onClick={() => toggleTracking(competitor)}
                            disabled={Boolean(trackingBusy[competitor.id])}
                          >
                            {trackingBusy[competitor.id] ? (
                              <span className="cs-spinner" />
                            ) : tracked ? (
                              <><Check size={13} /> {t('competitors.tracking')}</>
                            ) : (
                              t('competitors.track')
                            )}
                          </button>
                        </div>
                      </div>

                      {channelsOpen ? (
                        <div className="cs-rows" style={{ marginInlineStart: 30, marginBottom: 14 }}>
                          {!accounts ? (
                            <div className="cs-row-desc" style={{ padding: '8px 0' }}>{t('competitors.loadingSources')}</div>
                          ) : (
                            accounts.map((account) => (
                              <div key={account.id} className="cs-row">
                                <div className="cs-row-main">
                                  <div className="cs-row-name">
                                    {t(`platforms.${account.platform}`, { defaultValue: PLATFORM_LABELS[account.platform] || account.platform })}
                                    {account.handle ? <>{' '}<span className="ltr-isolate" style={{ fontWeight: 400, color: 'var(--text-light)' }}>@{account.handle}</span></> : null}
                                  </div>
                                  <div className="cs-row-desc ltr-isolate">{account.url}</div>
                                </div>
                                <div className="cs-row-side">
                                  <span className={`cs-pill cs-pill-${account.validation_status}`}>
                                    {t(`validationStatus.${account.validation_status}`, { defaultValue: account.validation_status })}
                                  </span>
                                  {account.validation_status !== 'rejected' ? (
                                    <button type="button" className="cs-btn cs-btn-sm cs-btn-danger"
                                      onClick={() => decideAccount(competitor.id, account.id, 'rejected')}>
                                      <Trash2 size={13} /> {t('channels.notTheirs')}
                                    </button>
                                  ) : null}
                                </div>
                              </div>
                            ))
                          )}
                          <AddSourceRow
                            busy={Boolean(sourceBusy[competitor.id])}
                            onSubmit={(source) => addSourceToCompetitor(competitor.id, source)}
                          />
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}

            {findingChannels ? (
              <div className="cs-panel" style={{ marginTop: 14, background: '#fcfdff' }}>
                <StageList stages={CHANNEL_STAGES} />
              </div>
            ) : null}
            {findingChannels ? <DiscoveryLog logs={discoveryLogs} active={findingChannels} /> : null}

            <div className="cs-wizard-foot">
              <button
                type="button"
                className="cs-btn cs-btn-ghost"
                onClick={() => setStep(targetCountries.length ? 4 : 3)}
                disabled={busy}
              >
                <ArrowLeft size={15} className="icon-flip-rtl" /> {t('common:actions.back')}
              </button>
              <button
                type="button"
                className="cs-btn cs-btn-primary"
                onClick={continueToChannels}
                disabled={busy || findingChannels || !trackedCompetitors.length}
              >
                {findingChannels ? <Loader2 size={15} className="cs-spin" /> : <ArrowRight size={15} className="icon-flip-rtl" />}
                {findingChannels
                  ? t('competitors.findingChannels')
                  : t('competitors.continueWith', { count: trackedCompetitors.length })}
              </button>
            </div>
          </div>
        </>
      ) : null}

      {/* ---------------- Step 6 (online): review channels ---------------- */}
      {step === 6 ? (
        <div className="cs-panel">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <h2 className="cs-panel-title" style={{ marginBottom: 4 }}><Link2 size={16} /> {t('channels.title')}</h2>
              <p className="cs-panel-hint" style={{ marginBottom: 0 }}>{t('channels.hint')}</p>
            </div>
            {channellessTracked > 0 ? (
              <button type="button" className="cs-btn cs-btn-sm" onClick={findMoreChannels} disabled={findingChannels}>
                {findingChannels ? <span className="cs-spinner" /> : <Search size={13} />}
                {findingChannels
                  ? t('channels.finding')
                  : t('channels.findMore', { total: formatNumber(channellessTracked) })}
              </button>
            ) : null}
          </div>

          {findingChannels ? (
            <div className="cs-panel" style={{ marginTop: 14, background: '#fcfdff' }}>
              <StageList stages={CHANNEL_STAGES} />
            </div>
          ) : null}
          {findingChannels ? <DiscoveryLog logs={discoveryLogs} active={findingChannels} /> : null}

          {!findingChannels && !trackedCompetitors.length ? (
            <div className="cs-empty">
              <div className="cs-empty-icon"><Link2 size={20} /></div>
              <h3>{t('channels.emptyTitle')}</h3>
              <p>{t('channels.emptyHint')}</p>
            </div>
          ) : null}

          {!findingChannels ? trackedCompetitors.map((competitor) => {
            const accounts = accountsByCompetitor[competitor.id];
            return (
              <div key={competitor.id} style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <div
                    className="cs-avatar"
                    style={{ background: avatarGradient(competitor.name), width: 26, height: 26, fontSize: '0.68rem' }}
                    aria-hidden="true"
                  >
                    {initials(competitor.name)}
                  </div>
                  <strong dir="auto" style={{ fontSize: '0.88rem' }}>{competitor.name}</strong>
                </div>
                <div className="cs-rows" style={{ marginInlineStart: 30 }}>
                  {!accounts ? (
                    <div className="cs-row-desc" style={{ padding: '8px 0' }}>{t('channels.loading')}</div>
                  ) : !accounts.length ? (
                    <div className="cs-row-desc" style={{ padding: '8px 0' }}>{t('channels.none')}</div>
                  ) : (
                    accounts.map((account) => (
                      <div key={account.id} className="cs-row">
                        <div className="cs-row-main">
                          <div className="cs-row-name">
                            {t(`platforms.${account.platform}`, { defaultValue: PLATFORM_LABELS[account.platform] || account.platform })}
                            {account.handle ? <>{' '}<span className="ltr-isolate" style={{ fontWeight: 400, color: 'var(--text-light)' }}>@{account.handle}</span></> : null}
                          </div>
                          <div className="cs-row-desc ltr-isolate">{account.url}</div>
                        </div>
                        <div className="cs-row-side">
                          <span className={`cs-pill cs-pill-${account.validation_status}`}>
                            {t(`validationStatus.${account.validation_status}`, { defaultValue: account.validation_status })}
                          </span>
                          {account.validation_status !== 'rejected' ? (
                            <button type="button" className="cs-btn cs-btn-sm cs-btn-danger"
                              onClick={() => decideAccount(competitor.id, account.id, 'rejected')}>
                              <Trash2 size={13} /> {t('channels.notTheirs')}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ))
                  )}
                  <AddSourceRow
                    busy={Boolean(sourceBusy[competitor.id])}
                    onSubmit={(source) => addSourceToCompetitor(competitor.id, source)}
                  />
                </div>
              </div>
            );
          }) : null}

          <div className="cs-wizard-foot">
            <button type="button" className="cs-btn cs-btn-ghost" onClick={() => setStep(5)} disabled={busy}>
              <ArrowLeft size={15} className="icon-flip-rtl" /> {t('common:actions.back')}
            </button>
            <button type="button" className="cs-btn cs-btn-primary" onClick={() => setStep(7)} disabled={busy}>
              <ArrowRight size={15} className="icon-flip-rtl" /> {t('common:actions.continue')}
            </button>
          </div>
        </div>
      ) : null}

      {/* ---------------- Step 7 (offline): analyze + report ---------------- */}
      {step === 7 ? (
        <div className="cs-panel">
          <h2 className="cs-panel-title"><Globe size={16} /> {t('schedule.title')}</h2>
          <p className="cs-panel-hint">{t('schedule.hint', { count: trackedCompetitors.length })}</p>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.88rem', marginBottom: 14 }}>
            <input
              type="checkbox"
              checked={scheduleOn}
              onChange={(event) => {
                const checked = event.target.checked;
                // Freeze the derived end date into editable state right as the
                // toggle turns off, so the field doesn't go blank.
                if (!checked) setRetrievalEnd(effectiveRetrievalEnd);
                setScheduleOn(checked);
              }}
            />
            {t('schedule.auto')}
          </label>
          {scheduleOn ? (
            <div className="cs-panel" style={{ margin: '0 0 4px', background: '#fcfdff' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: '0.88rem', flexWrap: 'wrap' }}>
                <span>{t('schedule.every')}</span>
                <input className="cs-input" type="number" min="1" style={{ width: 78 }}
                  value={scheduleIntervalValue} onChange={(event) => setScheduleIntervalValue(event.target.value)} />
                <select
                  className="cs-input"
                  style={{ width: 130 }}
                  value={scheduleIntervalUnit}
                  onChange={(event) => setScheduleIntervalUnit(event.target.value)}
                >
                  {REPEAT_UNIT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
              <div style={{ marginTop: 14 }}>
                <WeekdayPicker values={scheduleWeekdays} onChange={setScheduleWeekdays} />
              </div>
            </div>
          ) : null}

          <div className="cs-field" style={{ marginTop: 18 }}>
            <label className="cs-label">
              {t('schedule.window')}
              <span className="cs-label-hint">
                {scheduleOn ? t('schedule.windowHintScheduled') : t('business.optional')}
              </span>
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
              <input
                className="cs-input"
                type="date"
                style={{ width: 160 }}
                value={retrievalStart}
                onChange={(event) => setRetrievalStart(event.target.value)}
              />
              <span style={{ color: 'var(--text-light)' }}>{t('schedule.to')}</span>
              <input
                className="cs-input"
                type="date"
                style={{ width: 160 }}
                value={effectiveRetrievalEnd}
                min={retrievalStart || undefined}
                disabled={scheduleOn}
                onChange={(event) => setRetrievalEnd(event.target.value)}
              />
            </div>
            <p className="cs-panel-hint" style={{ marginTop: 8, marginBottom: 0 }}>
              {scheduleOn
                ? t('schedule.windowExplainScheduled', {
                  window: t('schedule.windowDays', { count: scheduleWindowDays }),
                  interval: t(`schedule.interval.${scheduleIntervalUnit}`, {
                    count: Math.max(1, Number(scheduleIntervalValue) || 1),
                  }),
                })
                : t('schedule.windowExplain')}
            </p>
          </div>

          <div className="cs-wizard-foot">
            <button type="button" className="cs-btn cs-btn-ghost" onClick={() => setStep(6)} disabled={busy}>
              <ArrowLeft size={15} className="icon-flip-rtl" /> {t('common:actions.back')}
            </button>
            <button type="button" className="cs-btn cs-btn-primary" onClick={finish} disabled={busy}>
              {busy ? <span className="cs-spinner" /> : <CheckCircle2 size={15} />} {t('schedule.openWorkspace')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
