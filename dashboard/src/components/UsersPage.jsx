import { useEffect, useState } from 'react';
import { UserPlus, Users as UsersIcon, Ban, CheckCircle2, Trash2 } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { useAuth } from '../auth/useAuth.js';
import ConfirmModal from './ConfirmModal';
import ErrorNotice from './ErrorNotice';
import { apiError } from '../errors/apiError.js';
import { formatNumber } from '../i18n/format.js';
import '../styles/AdminUsers.css';

const emptyDraft = { username: '', email: '', password: '', role: '' };

export default function UsersPage() {
  const { t } = useTranslation('admin');
  const { user: currentUser, hasPermission } = useAuth();
  const canDelete = hasPermission('users.delete');
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState(emptyDraft);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  // Role names are stable codes; the built-in ones have display labels and a
  // custom role shows the name it was created with.
  const roleLabel = (name) => t(`common:roleNames.${name}`, { defaultValue: name });

  const loadUsers = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/users');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(data, { status: res.status, fallback: t('users.loadFailed') });
      setUsers(Array.isArray(data?.users) ? data.users : []);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  };

  const loadRoles = async () => {
    try {
      const res = await fetch('/api/roles');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return;
      const roleList = Array.isArray(data?.roles) ? data.roles : [];
      setRoles(roleList);
      setDraft((prev) => (prev.role ? prev : { ...prev, role: roleList[0]?.name || '' }));
    } catch {
      // Role list is only used to populate the select options; if it fails
      // to load the selects below just render empty.
    }
  };

  useEffect(() => {
    loadUsers();
    loadRoles();
    // Load once on mount: `t` (used for fallback error text) only changes
    // with the UI language, which is no reason to refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createUser = async (e) => {
    e.preventDefault();
    setError('');
    setCreating(true);
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(data, { status: res.status, fallback: t('users.createFailed') });
      setDraft(emptyDraft);
      await loadUsers();
    } catch (err) {
      setError(err);
    } finally {
      setCreating(false);
    }
  };

  const setStatus = async (userId, status) => {
    setError('');
    try {
      const res = await fetch(`/api/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(data, { status: res.status, fallback: t('users.updateFailed') });
      await loadUsers();
    } catch (err) {
      setError(err);
    }
  };

  const setRole = async (userId, role) => {
    setError('');
    try {
      const res = await fetch(`/api/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(data, { status: res.status, fallback: t('users.updateFailed') });
      await loadUsers();
    } catch (err) {
      setError(err);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setError('');
    setDeleting(true);
    try {
      const res = await fetch(`/api/users/${target.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(data, { status: res.status, fallback: t('users.deleteFailed') });
      setDeleteTarget(null);
      await loadUsers();
    } catch (err) {
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
            <UsersIcon size={14} /> {t('kicker.userManagement')}
          </div>
          <h1 className="admin-page-title">{t('users.title')}</h1>
          <p className="admin-page-subtitle">{t('users.subtitle')}</p>
        </div>
        <div className="admin-page-toolbar">
          <div className="admin-page-toolbar-meta">
            <span>{t('users.totalUsers')}</span>
            <strong>{formatNumber(users.length)}</strong>
          </div>
        </div>
      </div>

      <ErrorNotice error={error} context={t('errorContext.manageUsers')} onDismiss={() => setError('')} />

      <form onSubmit={createUser} className="glass-card user-create-form" style={{ marginBottom: 24 }}>
        <label className="user-create-field">
          <span style={{ fontSize: '0.8rem' }}>{t('users.fields.username')}</span>
          <input className="filter-select" dir="auto" value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} required />
        </label>
        <label className="user-create-field">
          <span style={{ fontSize: '0.8rem' }}>{t('users.fields.email')}</span>
          <input className="filter-select" type="email" dir="ltr" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
        </label>
        <label className="user-create-field">
          <span style={{ fontSize: '0.8rem' }}>{t('users.fields.password')}</span>
          <input className="filter-select" type="password" dir="ltr" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} minLength={8} required />
        </label>
        <label className="user-create-field">
          <span style={{ fontSize: '0.8rem' }}>{t('users.fields.role')}</span>
          <select className="filter-select" value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })}>
            {roles.map((role) => <option key={role.id} value={role.name}>{roleLabel(role.name)}</option>)}
          </select>
        </label>
        <button type="submit" className="btn-primary" disabled={creating}>
          <UserPlus size={16} /> {creating ? t('users.creating') : t('users.create')}
        </button>
      </form>

      <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="table-scroll">
          <table>
            <thead>
              <tr style={{ textAlign: 'start', background: 'rgba(0,0,0,0.03)' }}>
                <th style={{ padding: 12 }}>{t('users.columns.username')}</th>
                <th className="admin-table-col-optional" style={{ padding: 12 }}>{t('users.columns.email')}</th>
                <th style={{ padding: 12 }}>{t('users.columns.role')}</th>
                <th style={{ padding: 12 }}>{t('users.columns.status')}</th>
                <th style={{ padding: 12 }}>{t('users.columns.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={5} style={{ padding: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-light)' }}>
                      <div className="loading-spinner" /> {t('users.loading')}
                    </div>
                  </td>
                </tr>
              )}
              {!loading && users.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ padding: 0 }}>
                    <div className="admin-empty-state">
                      <div className="admin-empty-state-icon">
                        <UsersIcon size={18} />
                      </div>
                      <strong>{t('users.emptyTitle')}</strong>
                      <span>{t('users.emptyBody')}</span>
                    </div>
                  </td>
                </tr>
              )}
              {users.map((u) => {
                const isSelf = currentUser && Number(currentUser.id) === Number(u.id);
                return (
                  <tr key={u.id} style={{ borderTop: '1px solid rgba(0,0,0,0.06)' }}>
                    <td style={{ padding: 12 }}>
                      <bdi>{u.username}</bdi>
                      {isSelf && <> {t('users.youSuffix')}</>}
                    </td>
                    <td className="admin-table-col-optional" style={{ padding: 12 }}>
                      {u.email ? <span className="ltr-isolate">{u.email}</span> : '-'}
                    </td>
                    <td style={{ padding: 12 }}>
                      <select
                        className="filter-select"
                        value={u.role}
                        disabled={isSelf}
                        onChange={(e) => setRole(u.id, e.target.value)}
                      >
                        {roles.map((role) => <option key={role.id} value={role.name}>{roleLabel(role.name)}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: 12 }}>{t(`userStatus.${u.status}`, { defaultValue: u.status })}</td>
                    <td style={{ padding: 12 }}>
                      <div className="admin-row-actions">
                        {u.status === 'active' ? (
                          <button className="btn-secondary" disabled={isSelf} onClick={() => setStatus(u.id, 'disabled')}>
                            <Ban size={14} /> {t('users.disable')}
                          </button>
                        ) : (
                          <button className="btn-secondary" onClick={() => setStatus(u.id, 'active')}>
                            <CheckCircle2 size={14} /> {t('users.enable')}
                          </button>
                        )}
                        {canDelete && (
                          <button
                            className="btn-secondary"
                            disabled={isSelf}
                            title={isSelf ? t('users.cannotDeleteSelf') : undefined}
                            onClick={() => setDeleteTarget(u)}
                            style={{ color: isSelf ? undefined : '#ff4757' }}
                          >
                            <Trash2 size={14} /> {t('common:actions.delete')}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <ConfirmModal
        open={Boolean(deleteTarget)}
        title={(
          <Trans
            t={t}
            i18nKey="users.deleteTitle"
            values={{ username: deleteTarget?.username || '' }}
            components={{ name: <bdi /> }}
          />
        )}
        message={t('users.deleteMessage')}
        confirmLabel={deleting ? t('common:actions.deleting') : t('users.deleteConfirm')}
        cancelLabel={t('users.keep')}
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
