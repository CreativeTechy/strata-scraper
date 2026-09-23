import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import RoleForm from './RoleForm';
import ErrorNotice from './ErrorNotice';
import { apiError } from '../errors/apiError.js';

const emptyValue = { name: '', description: '', permissions: [] };

// Create-only: builds a brand new role and its permission set, then hands
// back to the roles list. Editing an existing role lives in RoleEditPage.
export default function RoleCreatePage() {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const [permissions, setPermissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [value, setValue] = useState(emptyValue);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      setLoading(true);
      setLoadError('');
      try {
        const res = await fetch('/api/permissions');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw apiError(data, { status: res.status, fallback: t('roleCreate.loadFailed') });
        setPermissions(Array.isArray(data?.permissions) ? data.permissions : []);
      } catch (err) {
        setLoadError(err);
      } finally {
        setLoading(false);
      }
    })();
    // Load once on mount: `t` only changes with the UI language, which is no
    // reason to refetch (it's only used for the fallback error text).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const res = await fetch('/api/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(data, { status: res.status, fallback: t('roleCreate.createFailed') });
      navigate('/admin/roles');
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="admin-page-shell">
      <div className="admin-page-header">
        <div>
          <div className="admin-page-kicker">
            <ShieldPlus size={14} /> {t('kicker.accessControl')}
          </div>
          <h1 className="admin-page-title">{t('roleCreate.title')}</h1>
          <p className="admin-page-subtitle">{t('roleCreate.subtitle')}</p>
        </div>
      </div>

      <ErrorNotice error={loadError} context={t('errorContext.loadPermissions')} />

      {loading && (
        <div className="glass-card" style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-light)' }}>
          <div className="loading-spinner" /> {t('roleCreate.loading')}
        </div>
      )}

      {!loading && (
        <RoleForm
          value={value}
          onChange={setValue}
          permissions={permissions}
          submitLabel={t('roleCreate.submit')}
          submitting={submitting}
          error={error}
          onSubmit={handleSubmit}
          onCancel={() => navigate('/admin/roles')}
        />
      )}
    </div>
  );
}
