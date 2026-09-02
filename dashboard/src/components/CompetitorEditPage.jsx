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
import {
  ArrowLeft, Building2, Calendar, CheckCircle2, ChevronRight,
  Layers, Loader2, Save,
} from 'lucide-react';
import {
  getProfile, getSchedule, getStudy, saveProfile, setSchedule, updateStudy,
} from '../competitorApi.js';
import { REPEAT_UNIT_OPTIONS } from '../constants/schedule.js';
import { CountryPicker, ListEditor } from './CompetitorOnboarding.jsx';
import ErrorNotice from './ErrorNotice';
import { WeekdayPicker } from './ProjectsPage.jsx';
import '../styles/Competitors.css';

const STUDY_STATUS_OPTIONS = ['draft', 'active', 'archived'];

export default function CompetitorEditPage() {
  const { studyId } = useParams();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
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
        if (!cancelled) setLoadError(caught.message);
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
      setSaveError(caught.message);
    } finally {
      setSaving(false);
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
        <ErrorNotice error={loadError || 'Study not found.'} context="load this competitor study" />
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
          <h1>Edit study</h1>
          <p>Update the study, its business context, tracking schedule, and data window.</p>
        </div>
        <div className="cs-head-actions">
          <button type="button" className="cs-btn cs-btn-ghost" onClick={() => navigate(`/competitors/${studyId}`)}>
            Cancel
          </button>
          <button type="button" className="cs-btn cs-btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? <span className="cs-spinner" /> : <Save size={15} />}
            {saving ? 'Saving...' : 'Save changes'}
          </button>
        </div>
      </div>

      <ErrorNotice error={saveError} context="save this competitor study" onDismiss={() => setSaveError('')} />
      {saved && !saveError ? (
        <div className="cs-alert cs-alert-info">
          <CheckCircle2 size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>Saved. Study details, business context, and schedule are up to date.</span>
        </div>
      ) : null}

      {/* ---------------- Study ---------------- */}
      <div className="cs-panel" style={{ marginBottom: 20 }}>
        <h2 className="cs-panel-title"><Layers size={16} /> Study</h2>
        <div className="cs-field">
          <label className="cs-label" htmlFor="cs-study-name">Name</label>
          <input id="cs-study-name" className="cs-input" value={studyDraft.name}
            onChange={(event) => setStudyDraft({ ...studyDraft, name: event.target.value })} />
        </div>
        <div className="cs-field">
          <label className="cs-label" htmlFor="cs-study-description">Description</label>
          <textarea id="cs-study-description" className="cs-textarea" style={{ minHeight: 80 }}
            value={studyDraft.description}
            onChange={(event) => setStudyDraft({ ...studyDraft, description: event.target.value })} />
        </div>
        <div className="cs-field">
          <label className="cs-label" htmlFor="cs-study-status">Status</label>
          <select id="cs-study-status" className="cs-input" style={{ maxWidth: 220 }} value={studyDraft.status}
            onChange={(event) => setStudyDraft({ ...studyDraft, status: event.target.value })}>
            {STUDY_STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>{status}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ---------------- Business context ---------------- */}
      <div className="cs-panel" style={{ marginBottom: 20 }}>
        <h2 className="cs-panel-title"><Building2 size={16} /> Business context</h2>
        <p className="cs-panel-hint">
          This is the description competitors get matched against, and what every &ldquo;how does this
          affect us&rdquo; judgement is measured by.
        </p>

        {profileDraft ? (
          <>
            <div className="cs-grid-2">
              <div className="cs-field">
                <label className="cs-label" htmlFor="cs-p-name">Business name</label>
                <input id="cs-p-name" className="cs-input" value={profileDraft.name}
                  onChange={(event) => setProfileDraft({ ...profileDraft, name: event.target.value })} />
              </div>
              <div className="cs-field">
                <label className="cs-label" htmlFor="cs-p-website">Website</label>
                <input id="cs-p-website" className="cs-input" value={profileDraft.website}
                  onChange={(event) => setProfileDraft({ ...profileDraft, website: event.target.value })} />
              </div>
            </div>

            <div className="cs-field">
              <label className="cs-label" htmlFor="cs-p-description">
                Description<span className="cs-label-hint">optional</span>
              </label>
              <textarea id="cs-p-description" className="cs-textarea" style={{ minHeight: 70 }}
                value={profileDraft.description}
                onChange={(event) => setProfileDraft({ ...profileDraft, description: event.target.value })} />
            </div>

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

            <CountryPicker
              label="Target countries"
              hint="optional — leave blank to search globally"
              values={profileDraft.target_countries}
              onChange={(target_countries) => setProfileDraft({ ...profileDraft, target_countries })}
            />

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
          </>
        ) : null}
      </div>

      {/* ---------------- Tracking schedule ---------------- */}
      <div className="cs-panel" style={{ marginBottom: 20 }}>
        <h2 className="cs-panel-title"><Calendar size={16} /> Tracking schedule</h2>
        <p className="cs-panel-hint">
          Automatically re-scrape this study&rsquo;s confirmed competitor channels on a recurring interval.
        </p>

        <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.88rem', marginBottom: 14 }}>
          <input type="checkbox" checked={scheduleDraft.repeat_enabled}
            onChange={(event) => setScheduleDraft({ ...scheduleDraft, repeat_enabled: event.target.checked })} />
          Scrape automatically
        </label>

        {scheduleDraft.repeat_enabled ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: '0.88rem', flexWrap: 'wrap' }}>
              <span>Every</span>
              <input className="cs-input" type="number" min="1" style={{ width: 78 }}
                value={scheduleDraft.repeat_interval_value}
                onChange={(event) => setScheduleDraft({ ...scheduleDraft, repeat_interval_value: event.target.value })} />
              <select className="cs-input" style={{ width: 130 }} value={scheduleDraft.repeat_interval_unit}
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
        <h2 className="cs-panel-title"><Calendar size={16} /> Data retrieval window</h2>
        <p className="cs-panel-hint">
          Scopes which article publish dates get pulled in. Leave blank to pull in articles from any date.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
          <input
            className="cs-input"
            type="date"
            style={{ width: 160 }}
            value={scheduleDraft.start_date || ''}
            onChange={(event) => setScheduleDraft({ ...scheduleDraft, start_date: event.target.value })}
          />
          <span style={{ color: 'var(--text-light)' }}>to</span>
          <input
            className="cs-input"
            type="date"
            style={{ width: 160 }}
            value={scheduleDraft.end_date || ''}
            min={scheduleDraft.start_date || undefined}
            onChange={(event) => setScheduleDraft({ ...scheduleDraft, end_date: event.target.value })}
          />
        </div>
      </div>

      <div className="cs-wizard-foot">
        <button type="button" className="cs-btn cs-btn-ghost" onClick={() => navigate(`/competitors/${studyId}`)}>
          Cancel
        </button>
        <button type="button" className="cs-btn cs-btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 size={15} className="cs-spin" /> : <Save size={15} />}
          {saving ? 'Saving...' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}
