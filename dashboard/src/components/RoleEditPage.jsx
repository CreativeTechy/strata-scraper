import { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { Pencil, ShieldAlert, ArrowLeft } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import RoleForm from './RoleForm';
import ErrorNotice from './ErrorNotice';
import { apiError } from '../errors/apiError.js';

// Edit-only: loads one existing role and its permission set and saves changes
// back to it. Creating a new role lives in RoleCreatePage.
export default function RoleEditPage() {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const { roleId } = useParams();
  const [permissions, setPermissions] = useState([]);
  const [role, setRole] = useState(null);
  const [value, setValue] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      setLoading(true);
      setLoadError('');
      try {
        const [rolesRes, permsRes] = await Promise.all([fetch('/api/roles'), fetch('/api/permissions')]);
        const rolesData = await rolesRes.json().catch(() => ({}));
        const permsData = await permsRes.json().catch(() => ({}));
        if (!rolesRes.ok) throw apiError(rolesData, { status: rolesRes.status, fallback: t('roleEdit.loadRolesFailed') });
        if (!permsRes.ok) throw apiError(permsData, { status: permsRes.status, fallback: t('roleEdit.loadPermissionsFailed') });

        const roleList = Array.isArray(rolesData?.roles) ? rolesData.roles : [];
        const found = roleList.find((item) => String(item.id) === String(roleId)) || null;

        setPermissions(Array.isArray(permsData?.permissions) ? permsData.permissions : []);
        setRole(found);
        setValue(
          found
            ? { name: found.name, description: found.description || '', permissions: [...(found.permissions || [])] }
            : null
        );
      } catch (err) {
        setLoadError(err);
      } finally {
        setLoading(false);
      }
    })();
    // Reload only when the role changes: `t` only changes with the UI
    // language, and refetching then would discard unsaved edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleId]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!role) return;
    setError('');
    setSubmitting(true);
    try {
      const res = await fetch(`/api/roles/${role.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(data, { status: res.status, fallback: t('roleEdit.updateFailed') });
      navigate('/admin/roles');
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  if (!loading && !role) {
    return (
      <div className="admin-page-shell">
        <div className="glass-card" style={{ maxWidth: 960, margin: '0 auto' }}>
          <div className="admin-empty-state" style={{ padding: '34px 20px' }}>
            <div className="admin-empty-state-icon">
              <ShieldAlert size={18} />
            </div>
            <strong>{t('roleEdit.notFound')}</strong>
            <ErrorNotice error={loadError || { code: 'roles.not_found' }} context={t('errorContext.loadRole')} compact />
            <Link to="/admin/roles" className="btn-primary" style={{ marginTop: 8, textDecoration: 'none' }}>
              <ArrowLeft size={16} className="icon-flip-rtl" /> {t('roleEdit.backToRoles')}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-page-shell">
      <div className="admin-page-header">
        <div>
          <div className="admin-page-kicker">
            <Pencil size={14} /> {t('kicker.accessControl')}
          </div>
          <h1 className="admin-page-title">
            {role ? (
              <Trans
                t={t}
                i18nKey="roleEdit.titleWithName"
                values={{ name: t(`common:roleNames.${role.name}`, { defaultValue: role.name }) }}
                components={{ name: <bdi /> }}
              />
            ) : (
              t('roleEdit.title')
            )}
          </h1>
          <p className="admin-page-subtitle">{t('roleEdit.subtitle')}</p>
        </div>
      </div>

      <ErrorNotice error={loadError} context={t('errorContext.loadRole')} />

      {loading && (
        <div className="glass-card" style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-light)' }}>
          <div className="loading-spinner" /> {t('roleEdit.loading')}
        </div>
      )}

      {!loading && value && (
        <RoleForm
          value={value}
          onChange={setValue}
          permissions={permissions}
          fullAccess={Boolean(role?.full_access)}
          submitLabel={t('common:actions.saveChanges')}
          submitting={submitting}
          error={error}
          onSubmit={handleSubmit}
          onCancel={() => navigate('/admin/roles')}
        />
      )}
    </div>
  );
}
