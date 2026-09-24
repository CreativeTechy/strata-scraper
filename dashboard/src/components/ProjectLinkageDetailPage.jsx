import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CalendarDays, Link2, Pencil } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatDate, formatNumber } from '../i18n/format.js';
import '../styles/ProjectLinkage.css';

// View-only: shows a single project's metadata and its linked users.
// Changing the linkage happens on ProjectLinkageEditPage.
export default function ProjectLinkageDetailPage({ projects = [], users = [] }) {
  const { t } = useTranslation('admin');
  // Unparseable dates are shown as stored rather than hidden.
  const displayDate = (value) => (value ? formatDate(value, undefined, String(value)) : t('linkage.detail.notSet'));
  const params = useParams();

  const project = useMemo(
    () => projects.find((item) => Number(item.id) === Number(params.projectId)) || null,
    [projects, params.projectId]
  );

  const linkedUsers = useMemo(() => {
    if (!project) return [];
    const ids = new Set((project.user_ids || []).map((value) => Number(value)));
    return users.filter((user) => ids.has(Number(user.id)));
  }, [project, users]);

  if (!project) {
    return (
      <div className="admin-page-shell project-linkage-page">
        <div className="glass-card" style={{ maxWidth: 960, margin: '0 auto' }}>
          <div className="admin-empty-state" style={{ padding: '34px 20px' }}>
            <div className="admin-empty-state-icon">
              <Link2 size={18} />
            </div>
            <strong>{t('linkage.notFoundTitle')}</strong>
            <span>{t('linkage.notFoundBody')}</span>
            <Link to="/admin/project-linkage" className="btn-primary" style={{ marginTop: 8, textDecoration: 'none' }}>
              <ArrowLeft size={16} className="icon-flip-rtl" /> {t('linkage.backToList')}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const status = String(project.status || 'draft').toLowerCase();
  const isActive = status === 'active';
  const isArchived = status === 'archived';
  const statusLabel = t(`projectStatus.${status}`, { defaultValue: status }).toUpperCase();

  return (
    <div className="admin-page-shell project-linkage-page">
      <div className="admin-page-header">
        <div>
          <div className="admin-page-kicker">
            <Link2 size={14} /> {t('kicker.projectLinkage')}
          </div>
          <h1 className="admin-page-title" dir="auto">{project.name}</h1>
          <p className="admin-page-subtitle">{t('linkage.detail.subtitle')}</p>
        </div>
        <div className="admin-page-toolbar">
          <div className="admin-page-toolbar-meta">
            <span>{t('linkage.detail.status')}</span>
            <strong>{statusLabel}</strong>
          </div>
          <div className="admin-page-toolbar-meta">
            <span>{t('linkage.detail.linkedUsers')}</span>
            <strong>{formatNumber(linkedUsers.length)}</strong>
          </div>
          <Link
            to={`/admin/project-linkage/${project.id}/edit`}
            className="btn-secondary"
            style={{ textDecoration: 'none' }}
          >
            <Pencil size={16} /> {t('linkage.detail.editLinkage')}
          </Link>
        </div>
      </div>

      <div className="project-detail-layout">
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="panel-header-tight">
            <strong style={{ fontSize: '1rem' }}>{t('linkage.detail.detailsTitle')}</strong>
            <span className={`panel-chip ${isActive ? 'success' : isArchived ? 'muted' : 'warning'}`}>
              {statusLabel}
            </span>
          </div>

          <div className="project-detail-summary-grid">
            <div className="admin-item-card" style={{ margin: 0 }}>
              <div className="admin-item-meta" style={{ marginBottom: 8 }}>
                <span>
                  <CalendarDays size={12} /> {t('linkage.detail.start')}
                </span>
                <span>
                  <CalendarDays size={12} /> {t('linkage.detail.end')}
                </span>
              </div>
              <strong style={{ fontSize: '0.98rem' }}>{displayDate(project.start_date)}</strong>
              <div style={{ color: 'var(--text-light)', fontSize: '0.84rem', marginTop: 4 }}>
                {displayDate(project.end_date)}
              </div>
            </div>

            <div className="admin-item-card" style={{ margin: 0 }}>
              <div className="admin-item-meta" style={{ marginBottom: 8 }}>
                <span>{t('linkage.detail.location')}</span>
                <span>{t('linkage.detail.audience')}</span>
              </div>
              <strong style={{ fontSize: '0.98rem', overflowWrap: 'anywhere' }} dir={project.location ? 'auto' : undefined}>
                {project.location || t('linkage.detail.notSet')}
              </strong>
              <div
                style={{ color: 'var(--text-light)', fontSize: '0.84rem', marginTop: 4, overflowWrap: 'anywhere' }}
                dir={project.target_audience ? 'auto' : undefined}
              >
                {project.target_audience || t('linkage.detail.noAudience')}
              </div>
            </div>
          </div>

          <div className="admin-item-card" style={{ margin: 0 }}>
            <div className="panel-header-tight" style={{ marginBottom: 10 }}>
              <strong style={{ fontSize: '0.94rem' }}>{t('linkage.detail.description')}</strong>
            </div>
            <div
              style={{ color: 'var(--text-light)', lineHeight: 1.7, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
              dir={project.description ? 'auto' : undefined}
            >
              {project.description || t('linkage.detail.noDescription')}
            </div>
          </div>
        </div>

        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="panel-header-tight">
            <strong style={{ fontSize: '1rem' }}>{t('linkage.detail.linkedUsersTitle')}</strong>
            <span className="panel-chip">{t('linkage.detail.linkedCount', { count: linkedUsers.length })}</span>
          </div>

          {linkedUsers.length === 0 ? (
            <div className="admin-empty-state" style={{ padding: '20px 12px' }}>
              <div className="admin-empty-state-icon">
                <Link2 size={18} />
              </div>
              <strong>{t('linkage.detail.noUsersTitle')}</strong>
              <span>{t('linkage.detail.noUsersBody')}</span>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {linkedUsers.map((user) => (
                <div key={user.id} className="admin-item-card" style={{ margin: 0 }}>
                  <div className="admin-item-top">
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
                        <strong className="admin-item-title" dir="auto">{user.username}</strong>
                        <span className={`panel-chip role-${user.role}`}>
                          {t(`common:roleNames.${user.role}`, { defaultValue: user.role })}
                        </span>
                      </div>
                      <div className="admin-item-meta">
                        {user.email ? <span className="ltr-isolate">{user.email}</span> : <span>{t('linkage.noEmail')}</span>}
                        <span>{t(`userStatus.${user.status}`, { defaultValue: user.status })}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
