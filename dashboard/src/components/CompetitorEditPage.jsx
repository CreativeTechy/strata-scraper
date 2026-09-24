/**
 * Edit competitor study — one page for every field-level edit that used to be
 * spread across three modals on the workspace (study, business profile,
 * schedule). Competitor/channel management (add, track, alias, delete,
 * validate, AI discovery) has its own dedicated page — it's a list resource
 * with search and pagination, not a form field this page's "Save" applies to.
 *
 * Study/profile/schedule/date-window fields are a draft, saved together by
 * the single "Save changes" button.
 */

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft, Building2, Calendar, CheckCircle2, ChevronLeft,
  Layers, Loader2, Save, Sparkles,
} from 'lucide-react';
import {
  buildProfile, getProfile, getSchedule, getStudy, saveProfile, setSchedule, updateStudy,
} from '../competitorApi.js';
import { SCRAPE_STAGES } from '../constants/competitorStages.js';
import { REPEAT_UNIT_OPTIONS } from '../constants/schedule.js';
import { CountryPicker, ListEditor, StageList } from './CompetitorOnboarding.jsx';
import ErrorNotice from './ErrorNotice';
import { WeekdayPicker } from './ProjectsPage.jsx';
import '../styles/Competitors.css';

// Stable status codes sent to the API; labels come from competitors:studyStatus.*.
const STUDY_STATUS_OPTIONS = ['draft', 'active', 'archived'];

export default function CompetitorEditPage() {
  const { t, i18n } = useTranslation('competitors');
  const { studyId } = useParams();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  // Holds the caught Error itself (not just .message) so its API error code
  // reaches ErrorNotice for translation; '' means no error.
  const [loadError, setLoadError] = useState('');
  const [study, setStudy] = useState(null);

  const [studyDraft, setStudyDraft] = useState({ name: '', description: '', status: 'active' });
  const [profileDraft, setProfileDraft] = useState(null);
  const [scheduleDraft, setScheduleDraft] = useState({
    repeat_enabled: false, repeat_interval_value: 1, repeat_interval_unit: 'days',
    repeat_weekdays: [], start_date: '', end_date: '',
  });

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);

  // Re-scraping the site and re-deriving the profile from scratch, distinct
  // from `saving` which persists the (possibly hand-edited) draft as-is.
  const [contextBusy, setContextBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError('');
      try {
        const [studyDetail, profileDetail, scheduleDetail] = await Promise.all([
          getStudy(studyId),
          getProfile(studyId),
          getSchedule(studyId),
        ]);
        if (cancelled) return;
        const loadedStudy = studyDetail.study;
        const loadedProfile = profileDetail.profile;
        const loadedSchedule = scheduleDetail.schedule || {};
        setStudy(loadedStudy);
        setStudyDraft({
          name: loadedStudy?.name || '',
          description: loadedStudy?.description || '',
          status: loadedStudy?.status || 'active',
        });
        setProfileDraft({
          name: loadedProfile?.name || '',
          website: loadedProfile?.website || '',
          description: loadedProfile?.description || '',
          industry: loadedProfile?.industry || '',
          market: loadedProfile?.market || '',
          target_countries: loadedProfile?.target_countries || [],
          positioning: loadedProfile?.positioning || '',
          offerings: loadedProfile?.offerings || [],
          audience: loadedProfile?.audience || [],
          differentiators: loadedProfile?.differentiators || [],
          context_summary: loadedProfile?.context_summary || '',
        });
        setScheduleDraft({
          repeat_enabled: Boolean(loadedSchedule.repeat_enabled),
          repeat_interval_value: loadedSchedule.repeat_interval_value || 1,
          repeat_interval_unit: loadedSchedule.repeat_interval_unit || 'days',
          repeat_weekdays: loadedSchedule.repeat_weekdays || [],
          start_date: loadedSchedule.start_date || '',
          end_date: loadedSchedule.end_date || '',
        });
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

  const handleSave = async () => {
    setSaving(true);
    setSaveError('');
    setSaved(false);
    try {
      const [studyResult, profileResult] = await Promise.all([
        updateStudy(studyId, studyDraft),
        saveProfile(studyId, profileDraft),
        setSchedule(studyId, {
          repeat_enabled: scheduleDraft.repeat_enabled,
          repeat_interval_value: Math.max(1, Number(scheduleDraft.repeat_interval_value) || 1),
          repeat_interval_unit: scheduleDraft.repeat_interval_unit,
          repeat_weekdays: scheduleDraft.repeat_weekdays,
          start_date: scheduleDraft.start_date || null,
          end_date: scheduleDraft.end_date || null,
        }),
      ]);
      setStudy((prev) => ({ ...prev, ...studyResult.study }));
      setProfileDraft((prev) => ({ ...prev, ...(profileResult.profile || {}) }));
      setSaved(true);
    } catch (caught) {
      setSaveError(caught);
    } finally {
      setSaving(false);
    }
  };

  // Re-scrapes the site and re-derives the whole profile from scratch
  // (everything but name/website/description/target_countries is
  // overwritten), the same escape hatch onboarding's step 2 offers for a bad
  // first read — without discarding the rest of this draft's unsaved edits.
  const rerunContext = async () => {
    if (!profileDraft) return;
    setSaveError('');
    setSaved(false);
    setContextBusy(true);
    try {
      const result = await buildProfile(studyId, {
        name: profileDraft.name,
        website: profileDraft.website,
        description: profileDraft.description,
        target_countries: profileDraft.target_countries,
      });
      setProfileDraft((prev) => ({ ...prev, ...(result.profile || {}) }));
    } catch (caught) {
      setSaveError(caught);
    } finally {
      setContextBusy(false);
    }
  };

  const scheduleWeekdaysSupported = scheduleDraft.repeat_interval_unit === 'days';

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
          <h1>{t('edit.title')}</h1>
          <p>{t('edit.intro')}</p>
        </div>
        <div className="cs-head-actions">
          <button type="button" className="cs-btn cs-btn-ghost" onClick={() => navigate(`/competitors/${studyId}`)}>
            {t('common:actions.cancel')}
          </button>
          <button type="button" className="cs-btn cs-btn-primary" onClick={handleSave} disabled={saving || contextBusy}>
            {saving ? <span className="cs-spinner" /> : <Save size={15} />}
            {saving ? t('common:actions.saving') : t('common:actions.saveChanges')}
          </button>
        </div>
      </div>

      <ErrorNotice error={saveError} context={t('errorContext.saveStudy')} onDismiss={() => setSaveError('')} />
      {saved && !saveError ? (
        <div className="cs-alert cs-alert-info">
          <CheckCircle2 size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{t('edit.saved')}</span>
        </div>
      ) : null}

      {/* ---------------- Study ---------------- */}
      <div className="cs-panel" style={{ marginBottom: 20 }}>
        <h2 className="cs-panel-title"><Layers size={16} /> {t('edit.study.title')}</h2>
        <div className="cs-field">
          <label className="cs-label" htmlFor="cs-study-name">{t('edit.study.name')}</label>
          <input id="cs-study-name" className="cs-input" dir="auto" value={studyDraft.name}
            onChange={(event) => setStudyDraft({ ...studyDraft, name: event.target.value })} />
        </div>
        <div className="cs-field">
          <label className="cs-label" htmlFor="cs-study-description">{t('edit.study.description')}</label>
          <textarea id="cs-study-description" className="cs-textarea" dir="auto" style={{ minHeight: 80 }}
            value={studyDraft.description}
            onChange={(event) => setStudyDraft({ ...studyDraft, description: event.target.value })} />
        </div>
        <div className="cs-field">
          <label className="cs-label" htmlFor="cs-study-status">{t('edit.study.status')}</label>
          <select id="cs-study-status" className="cs-input" style={{ maxWidth: 220 }} value={studyDraft.status}
            onChange={(event) => setStudyDraft({ ...studyDraft, status: event.target.value })}>
            {STUDY_STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>{t(`studyStatus.${status}`)}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ---------------- Business context ---------------- */}
      <div className="cs-panel" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h2 className="cs-panel-title" style={{ marginBottom: 4 }}><Building2 size={16} /> {t('edit.context.title')}</h2>
            <p className="cs-panel-hint" style={{ marginBottom: 0 }}>
              {t('edit.context.hint')}
            </p>
          </div>
          <button
            type="button"
            className="cs-btn"
            onClick={rerunContext}
            disabled={!profileDraft?.website?.trim() || contextBusy || saving}
          >
            {contextBusy ? <span className="cs-spinner" /> : <Sparkles size={15} />}
            {contextBusy ? t('edit.context.readingSite') : t('edit.context.rerun')}
          </button>
        </div>

        {contextBusy ? (
          <div className="cs-panel" style={{ marginTop: 14, background: '#fcfdff' }}>
            <StageList stages={SCRAPE_STAGES} />
          </div>
        ) : null}

        {!contextBusy && profileDraft?.generated_language
          && profileDraft.generated_language !== String(i18n.resolvedLanguage || i18n.language).split('-')[0] ? (
            <div className="cs-alert cs-alert-warn" role="status" style={{ marginTop: 14 }}>
              {t('edit.context.languageMismatch')}
            </div>
          ) : null}

        {profileDraft ? (
          <>
            <div className="cs-grid-2">
              <div className="cs-field">
                <label className="cs-label" htmlFor="cs-p-name">{t('edit.context.businessName')}</label>
                <input id="cs-p-name" className="cs-input" dir="auto" value={profileDraft.name}
                  onChange={(event) => setProfileDraft({ ...profileDraft, name: event.target.value })} />
              </div>
              <div className="cs-field">
                <label className="cs-label" htmlFor="cs-p-website">{t('edit.context.website')}</label>
                <input id="cs-p-website" className="cs-input" dir="ltr" value={profileDraft.website}
                  onChange={(event) => setProfileDraft({ ...profileDraft, website: event.target.value })} />
              </div>
            </div>

            <div className="cs-field">
              <label className="cs-label" htmlFor="cs-p-description">
                {t('edit.context.description')}<span className="cs-label-hint">{t('optional')}</span>
              </label>
              <textarea id="cs-p-description" className="cs-textarea" dir="auto" style={{ minHeight: 70 }}
                value={profileDraft.description}
                onChange={(event) => setProfileDraft({ ...profileDraft, description: event.target.value })} />
            </div>

            <div className="cs-grid-2">
              <div className="cs-field">
                <label className="cs-label" htmlFor="cs-p-industry">{t('edit.context.industry')}</label>
                <input id="cs-p-industry" className="cs-input" dir="auto" value={profileDraft.industry}
                  onChange={(event) => setProfileDraft({ ...profileDraft, industry: event.target.value })} />
              </div>
              <div className="cs-field">
                <label className="cs-label" htmlFor="cs-p-market">{t('edit.context.market')}</label>
                <input id="cs-p-market" className="cs-input" dir="auto" value={profileDraft.market}
                  onChange={(event) => setProfileDraft({ ...profileDraft, market: event.target.value })} />
              </div>
            </div>

            <CountryPicker
              label={t('edit.context.targetCountries')}
              hint={t('edit.context.targetCountriesHint')}
              values={profileDraft.target_countries}
              onChange={(target_countries) => setProfileDraft({ ...profileDraft, target_countries })}
            />

            <div className="cs-field">
              <label className="cs-label" htmlFor="cs-p-positioning">{t('edit.context.positioning')}</label>
              <input id="cs-p-positioning" className="cs-input" dir="auto" value={profileDraft.positioning}
                onChange={(event) => setProfileDraft({ ...profileDraft, positioning: event.target.value })} />
            </div>

            <ListEditor label={t('edit.context.offerings')} values={profileDraft.offerings}
              placeholder={t('edit.context.offeringsPlaceholder')}
              onChange={(offerings) => setProfileDraft({ ...profileDraft, offerings })} />
            <ListEditor label={t('edit.context.audience')} values={profileDraft.audience}
              placeholder={t('edit.context.audiencePlaceholder')}
              onChange={(audience) => setProfileDraft({ ...profileDraft, audience })} />
            <ListEditor label={t('edit.context.differentiators')} hint={t('edit.context.differentiatorsHint')}
              values={profileDraft.differentiators} placeholder={t('edit.context.differentiatorsPlaceholder')}
              onChange={(differentiators) => setProfileDraft({ ...profileDraft, differentiators })} />

            <div className="cs-field">
              <label className="cs-label" htmlFor="cs-p-context">{t('edit.context.marketContext')}</label>
              <textarea id="cs-p-context" className="cs-textarea" dir="auto" style={{ minHeight: 110 }}
                value={profileDraft.context_summary}
                onChange={(event) => setProfileDraft({ ...profileDraft, context_summary: event.target.value })} />
            </div>
          </>
        ) : null}
      </div>

      {/* ---------------- Tracking schedule ---------------- */}
      <div className="cs-panel" style={{ marginBottom: 20 }}>
        <h2 className="cs-panel-title"><Calendar size={16} /> {t('edit.schedule.title')}</h2>
        <p className="cs-panel-hint">
          {t('edit.schedule.hint')}
        </p>

        <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.88rem', marginBottom: 14 }}>
          <input type="checkbox" checked={scheduleDraft.repeat_enabled}
            onChange={(event) => setScheduleDraft({ ...scheduleDraft, repeat_enabled: event.target.checked })} />
          {t('edit.schedule.enabled')}
        </label>

        {scheduleDraft.repeat_enabled ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: '0.88rem', flexWrap: 'wrap' }}>
              <span>{t('edit.schedule.every')}</span>
              <input className="cs-input" type="number" min="1" style={{ width: 78 }}
                aria-label={t('edit.schedule.intervalValue')}
                value={scheduleDraft.repeat_interval_value}
                onChange={(event) => setScheduleDraft({ ...scheduleDraft, repeat_interval_value: event.target.value })} />
              <select className="cs-input" style={{ width: 130 }} value={scheduleDraft.repeat_interval_unit}
                aria-label={t('edit.schedule.intervalUnit')}
                onChange={(event) => setScheduleDraft({ ...scheduleDraft, repeat_interval_unit: event.target.value })}>
                {REPEAT_UNIT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
            {scheduleWeekdaysSupported ? (
              <div style={{ marginTop: 14 }}>
                <WeekdayPicker
                  values={scheduleDraft.repeat_weekdays}
                  onChange={(repeat_weekdays) => setScheduleDraft({ ...scheduleDraft, repeat_weekdays })}
                />
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      {/* ---------------- Data retrieval window ---------------- */}
      <div className="cs-panel" style={{ marginBottom: 20 }}>
        <h2 className="cs-panel-title"><Calendar size={16} /> {t('edit.window.title')}</h2>
        <p className="cs-panel-hint">
          {t('edit.window.hint')}
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
          <input
            className="cs-input"
            type="date"
            style={{ width: 160 }}
            aria-label={t('edit.window.startDate')}
            value={scheduleDraft.start_date || ''}
            onChange={(event) => setScheduleDraft({ ...scheduleDraft, start_date: event.target.value })}
          />
          <span style={{ color: 'var(--text-light)' }}>{t('dateRangeSeparator')}</span>
          <input
            className="cs-input"
            type="date"
            style={{ width: 160 }}
            aria-label={t('edit.window.endDate')}
            value={scheduleDraft.end_date || ''}
            min={scheduleDraft.start_date || undefined}
            onChange={(event) => setScheduleDraft({ ...scheduleDraft, end_date: event.target.value })}
          />
        </div>
      </div>

      <div className="cs-wizard-foot">
        <button type="button" className="cs-btn cs-btn-ghost" onClick={() => navigate(`/competitors/${studyId}`)}>
          {t('common:actions.cancel')}
        </button>
        <button type="button" className="cs-btn cs-btn-primary" onClick={handleSave} disabled={saving || contextBusy}>
          {saving ? <Loader2 size={15} className="cs-spin" /> : <Save size={15} />}
          {saving ? t('common:actions.saving') : t('common:actions.saveChanges')}
        </button>
      </div>
    </div>
  );
}
