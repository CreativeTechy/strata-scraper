import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import '../styles/AdminUsers.css';
import ErrorNotice from './ErrorNotice';

// Permission keys ("projects.view") and their resource prefix are stable
// codes; display labels live in admin:permissionGroups / admin:permissions.
// Resources listed here come first, in this order; any others follow A-Z.
const CATEGORY_ORDER = ['articles', 'pipeline', 'projects', 'roles', 'sources', 'users'];

function categoryLabel(t, resource) {
  return t(`permissionGroups.${resource}`, {
    defaultValue: resource.charAt(0).toUpperCase() + resource.slice(1),
  });
}

// A translated label for known keys; otherwise the permission's own
// description (already human-readable, no category prefix, but English from
// the server), falling back to deriving one from the key if it's missing.
function permissionLabel(t, perm) {
  let fallback = perm.description;
  if (!fallback) {
    const label = perm.key.split('.').slice(1).join(' ').replace(/_/g, ' ');
    fallback = label.charAt(0).toUpperCase() + label.slice(1);
  }
  return t(`permissions.${perm.key}`, { defaultValue: fallback });
}

function groupPermissions(permissions) {
  const groups = {};
  for (const perm of permissions) {
    const [resource] = perm.key.split('.');
    if (!groups[resource]) groups[resource] = [];
    groups[resource].push(perm);
  }
  const rest = Object.keys(groups)
    .filter((resource) => !CATEGORY_ORDER.includes(resource))
    .sort();
  return [...CATEGORY_ORDER, ...rest].filter((resource) => groups[resource]).map((resource) => ({
    resource,
    perms: groups[resource],
  }));
}

function GroupSelectAll({ perms, selected, onToggleGroup }) {
  const { t } = useTranslation('admin');
  const checkboxRef = useRef(null);
  const checkedCount = perms.filter((perm) => selected.has(perm.key)).length;
  const allChecked = checkedCount === perms.length;
  const someChecked = checkedCount > 0 && !allChecked;

  useEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = someChecked;
  }, [someChecked]);

  return (
    <label className="permission-group-toggle">
      <input
        ref={checkboxRef}
        type="checkbox"
        checked={allChecked}
        onChange={() => onToggleGroup(perms, !allChecked)}
      />
      {allChecked ? t('roleForm.deselectAll') : t('common:actions.selectAll')}
    </label>
  );
}

function PermissionGrid({ permissions, selected, onToggle, onToggleGroup }) {
  const { t } = useTranslation('admin');
  const groups = useMemo(() => groupPermissions(permissions), [permissions]);
  return (
    <div className="permission-groups">
      {groups.map(({ resource, perms }) => (
        <div key={resource} className="permission-group-card">
          <div className="permission-group-header">
            <span className="permission-group-title">{categoryLabel(t, resource)}</span>
            <GroupSelectAll perms={perms} selected={selected} onToggleGroup={onToggleGroup} />
          </div>
          <div className="permission-group-body">
            {perms.map((perm) => (
              <label key={perm.key} className="permission-row" title={perm.key}>
                <input type="checkbox" checked={selected.has(perm.key)} onChange={() => onToggle(perm.key)} />
                {permissionLabel(t, perm)}
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// Shared by RoleCreatePage and RoleEditPage: name/description fields plus the
// permission checkbox grid. The caller owns `value` and persistence - this
// component only renders the fields and reports changes.
export default function RoleForm({
  value,
  onChange,
  permissions,
  fullAccess = false,
  submitLabel,
  submitting = false,
  error = '',
  onSubmit,
  onCancel,
}) {
  const { t } = useTranslation('admin');
  const togglePermission = (key) => {
    const next = new Set(value.permissions);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange({ ...value, permissions: Array.from(next) });
  };

  const toggleGroup = (perms, shouldSelect) => {
    const next = new Set(value.permissions);
    for (const perm of perms) {
      if (shouldSelect) next.add(perm.key);
      else next.delete(perm.key);
    }
    onChange({ ...value, permissions: Array.from(next) });
  };

  const nameValid = value.name.trim().length > 0;

  return (
    <form onSubmit={onSubmit} className="glass-card role-form">
      <ErrorNotice error={error} context={t('errorContext.saveRole')} compact />

      <div className="role-fields">
        <label className="role-field">
          <span className="role-field-label">{t('roleForm.nameLabel')}</span>
          <input
            className="filter-select"
            value={value.name}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
            placeholder={t('roleForm.namePlaceholder')}
            dir="auto"
            required
          />
        </label>
        <label className="role-field">
          <span className="role-field-label">{t('roleForm.descriptionLabel')}</span>
          <textarea
            className="filter-select role-textarea"
            value={value.description}
            onChange={(e) => onChange({ ...value, description: e.target.value })}
            placeholder={t('roleForm.descriptionPlaceholder')}
            dir="auto"
            rows={3}
          />
        </label>
      </div>

      {fullAccess ? (
        <p className="subtitle">{t('roleForm.fullAccessNote')}</p>
      ) : (
        <div className="role-permissions">
          <span className="role-field-label">{t('roleForm.permissionsLabel')}</span>
          <PermissionGrid
            permissions={permissions}
            selected={new Set(value.permissions)}
            onToggle={togglePermission}
            onToggleGroup={toggleGroup}
          />
        </div>
      )}

      <div className="role-form-actions">
        <button type="button" className="btn-secondary" onClick={onCancel}>
          {t('common:actions.cancel')}
        </button>
        <button type="submit" className="btn-primary" disabled={submitting || !nameValid}>
          {submitting ? t('common:actions.saving') : submitLabel}
        </button>
      </div>
    </form>
  );
}
