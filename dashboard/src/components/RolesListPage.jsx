import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, ShieldPlus, Trash2, Pencil } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import ConfirmModal from './ConfirmModal';
import ErrorNotice from './ErrorNotice';
import { useAuth } from '../auth/useAuth.js';
import { apiError } from '../errors/apiError.js';
import { formatNumber } from '../i18n/format.js';
import '../styles/AdminUsers.css';

// List-only: the entry point for role administration. Create/edit happen on
// their own routed pages (RoleCreatePage/RoleEditPage); this page never
// renders a form itself.
export default function RolesListPage() {
  const { t, i18n } = useTranslation('admin');
  const { hasPermission } = useAuth();
  const canCreate = hasPermission('roles.create');
  const canUpdate = hasPermission('roles.update');
  const canDelete = hasPermission('roles.delete');

  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  // Role names are stable codes; the built-in ones have display labels and a
  // custom role shows the name it was created with.
  const roleLabel = (name) => t(`common:roleNames.${name}`, { defaultValue: name });
  // The seeded roles' descriptions are stored in English. Show the translated
  // one only while the stored text is still the seeded original, so a
  // description an admin has since rewritten is shown as written.
  const roleDescription = (role) => {
    const key = `roleDescriptions.${role.name}`;
    if (role.description && i18n.exists(key, { ns: 'admin', lng: 'en' })
      && role.description === t(key, { lng: 'en' })) {
      return t(key);
    }
    return role.description;
  };

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/roles');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(data, { status: res.status, fallback: t('roles.loadFailed') });
      setRoles(Array.isArray(data?.roles) ? data.roles : []);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // Load once on mount: `t` (used for fallback error text) only changes
    // with the UI language, which is no reason to refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setError('');
    setDeleting(true);
    try {
      const res = await fetch(`/api/roles/${target.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(data, { status: res.status, fallback: t('roles.deleteFailed') });
      setDeleteTarget(null);
      await load();
    } catch (err) {
      // Keep the dialog open so the "in use" (or other) rejection from the
      // backend - the source of truth for whether deletion is allowed - is
      // visible right next to the role the user tried to remove.
      setError(err);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="admin-page-shell">
      <div className="admin-page-header">
        <div>
          <div className="admin-page-kicker">
            <ShieldCheck size={14} /> {t('kicker.accessControl')}
          </div>
          <h1 className="admin-page-title">{t('roles.title')}</h1>
          <p className="admin-page-subtitle">{t('roles.subtitle')}</p>
        </div>
        <div className="admin-page-toolbar">
          <div className="admin-page-toolbar-meta">
            <span>{t('roles.totalRoles')}</span>
            <strong>{formatNumber(roles.length)}</strong>
          </div>
          {canCreate && (
            <Link to="/admin/roles/new" className="btn-primary" style={{ textDecoration: 'none' }}>
              <ShieldPlus size={16} /> {t('roles.newRole')}
            </Link>
          )}
        </div>
      </div>

      <ErrorNotice error={error} context={t('errorContext.manageRoles')} onRetry={load} onDismiss={() => setError('')} />

      <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="table-scroll">
          <table>
            <thead>
              <tr style={{ textAlign: 'start', background: 'rgba(0,0,0,0.03)' }}>
                <th style={{ padding: 12 }}>{t('roles.columns.role')}</th>
                <th className="admin-table-col-optional" style={{ padding: 12 }}>{t('roles.columns.description')}</th>
                <th style={{ padding: 12 }}>{t('roles.columns.permissions')}</th>
                <th style={{ padding: 12 }}>{t('roles.columns.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={4} style={{ padding: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-light)' }}>
                      <div className="loading-spinner" /> {t('roles.loading')}
                    </div>
                  </td>
                </tr>
              )}
              {!loading && roles.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ padding: 0 }}>
                    <div className="admin-empty-state">
                      <div className="admin-empty-state-icon">
                        <ShieldCheck size={18} />
                      </div>
                      <strong>{t('roles.emptyTitle')}</strong>
                      <span>
                        {canCreate ? t('roles.emptyBodyCanCreate') : t('roles.emptyBody')}
                      </span>
                    </div>
                  </td>
                </tr>
              )}
              {!loading && roles.map((role) => (
                <tr key={role.id} style={{ borderTop: '1px solid rgba(0,0,0,0.06)' }}>
                  <td style={{ padding: 12 }}>
                    <strong dir="auto">{roleLabel(role.name)}</strong>
                    {role.is_system && <span className="panel-chip" style={{ marginInlineStart: 8 }}>{t('roles.system')}</span>}
                  </td>
                  <td className="admin-table-col-optional" style={{ padding: 12 }}>
                    {role.description ? <span dir="auto">{roleDescription(role)}</span> : '-'}
                  </td>
                  <td style={{ padding: 12 }}>
                    {role.full_access ? (
                      <span className="panel-chip">{t('roles.fullAccess')}</span>
                    ) : (
                      t('roles.permissionCount', { count: role.permissions?.length || 0 })
                    )}
                  </td>
                  <td style={{ padding: 12 }}>
                    {(canUpdate || canDelete) ? (
                      <div className="admin-row-actions">
                        {canUpdate && (
                          <Link
                            className="btn-secondary"
                            to={`/admin/roles/${role.id}/edit`}
                            style={{ padding: '8px 10px', fontSize: '0.8rem', textDecoration: 'none' }}
                          >
                            <Pencil size={14} /> {t('common:actions.edit')}
                          </Link>
                        )}
                        {canDelete && (
                          <button
                            className="btn-secondary"
                            disabled={role.is_system}
                            title={role.is_system ? t('roles.systemCannotDelete') : undefined}
                            onClick={() => setDeleteTarget(role)}
                            style={{ padding: '8px 10px', fontSize: '0.8rem', color: role.is_system ? undefined : '#ff4757' }}
                          >
                            <Trash2 size={14} /> {t('common:actions.delete')}
                          </button>
                        )}
                      </div>
                    ) : (
                      <span className="subtitle">{t('roles.viewOnly')}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ConfirmModal
        open={Boolean(deleteTarget)}
        title={(
          <Trans
            t={t}
            i18nKey="roles.deleteTitle"
            values={{ name: deleteTarget ? roleLabel(deleteTarget.name) : '' }}
            components={{ name: <bdi /> }}
          />
        )}
        message={t('roles.deleteMessage')}
        confirmLabel={deleting ? t('common:actions.deleting') : t('roles.deleteConfirm')}
        cancelLabel={t('roles.keep')}
        confirmButtonStyle={{
          background: 'linear-gradient(135deg, #ff4757, #e03131)',
          boxShadow: '0 4px 15px rgba(255, 71, 87, 0.28)',
        }}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
