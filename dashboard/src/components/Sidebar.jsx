import React, { useState } from 'react';
import {
  LayoutDashboard,
  GitMerge,
  Rss,
  Newspaper,
  Database,
  CalendarDays,
  Radar,
  Users,
  ShieldCheck,
  Link2,
  LogOut,
  ChevronsLeft,
  ChevronsRight,
  ChevronDown,
  X,
} from 'lucide-react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/useAuth.js';
import LanguageSwitcher from './LanguageSwitcher';

// Kept visibly apart by what they're for: "Collection" is the data itself,
// "Monitoring" is the two ongoing watch programs that decide what gets
// collected (your own brand's opinion monitor and rival companies' competitor
// analysis), "Setup" is the plumbing that runs it. Mixing them in one flat
// list is what made the old navigation ambiguous.
const NAV_SECTIONS = [
  {
    id: 'collection',
    items: [
      { to: '/dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard },
      { to: '/articles', labelKey: 'nav.articles', icon: Newspaper },
    ],
  },
  {
    id: 'monitoring',
    items: [
      { to: '/projects', labelKey: 'nav.opinionMonitor', icon: CalendarDays },
      { to: '/competitors', labelKey: 'nav.competitorAnalysis', icon: Radar, permission: 'competitors.view' },
    ],
  },
  {
    id: 'setup',
    items: [
      { to: '/sources', labelKey: 'nav.sources', icon: Rss },
      { to: '/workflow', labelKey: 'nav.manualRun', icon: GitMerge },
      { to: '/pipeline-runs', labelKey: 'nav.pipelineRuns', icon: Database },
    ],
  },
];

const ADMIN_NAV_ITEMS = [
  { to: '/admin/users', labelKey: 'nav.users', icon: Users, permission: 'users.view' },
  { to: '/admin/roles', labelKey: 'nav.roles', icon: ShieldCheck, permission: 'roles.view' },
  { to: '/admin/project-linkage', labelKey: 'nav.projectAccess', icon: Link2, permission: 'projects.link_users' },
];

// Rendered as one more collapsible group alongside NAV_SECTIONS so admin gets
// the same expand/collapse and permission-filtering treatment as everything else.
const ALL_NAV_SECTIONS = [...NAV_SECTIONS, { id: 'admin', items: ADMIN_NAV_ITEMS }];

const SECTION_STATE_KEY = 'strata.sidebarSections';

function loadSectionState() {
  if (typeof window === 'undefined') return {};
  try {
    return JSON.parse(window.localStorage.getItem(SECTION_STATE_KEY)) || {};
  } catch {
    return {};
  }
}

function sectionDomId(id) {
  return `sidebar-section-${id}`;
}

// Open/closed state is keyed by stable section id, not the (translated)
// heading. The old English headings are still honored so a saved state from
// before localization survives.
const LEGACY_SECTION_KEYS = { collection: 'Collection', monitoring: 'Monitoring', setup: 'Setup', admin: 'Admin' };

export default function Sidebar({
  collapsed = false,
  onToggleCollapse = () => {},
  mobileOpen = false,
  onCloseMobile = () => {},
}) {
  const { t } = useTranslation();
  const { user, hasPermission, logout } = useAuth();
  const navigate = useNavigate();
  const [openSections, setOpenSections] = useState(loadSectionState);

  // On mobile the drawer always renders fully expanded; only the desktop rail collapses.
  const showCollapsed = collapsed && !mobileOpen;

  // Sections default to open unless the user has explicitly collapsed them before.
  const isSectionOpen = (id) => (openSections[id] ?? openSections[LEGACY_SECTION_KEYS[id]]) !== false;

  const toggleSection = (id) => {
    setOpenSections((prev) => {
      const wasOpen = (prev[id] ?? prev[LEGACY_SECTION_KEYS[id]]) !== false;
      const next = { ...prev, [id]: !wasOpen };
      delete next[LEGACY_SECTION_KEYS[id]];
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(SECTION_STATE_KEY, JSON.stringify(next));
      }
      return next;
    });
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  const initials = user?.username
    ? user.username.trim().slice(0, 2).toUpperCase()
    : '?';

  const toggleLabel = mobileOpen
    ? t('nav.closeNavigation')
    : (collapsed ? t('nav.expandNavigation') : t('nav.collapseNavigation'));

  const navStyle = ({ isActive }) => ({
    background: isActive ? 'white' : 'rgba(255,255,255,0.45)',
    borderColor: isActive ? 'transparent' : 'rgba(0,0,0,0.08)',
    boxShadow: isActive ? '0 6px 18px rgba(0,0,0,0.08)' : 'none',
    textDecoration: 'none',
    width: '100%',
    justifyContent: showCollapsed ? 'center' : 'flex-start',
  });

  return (
    <div
      className={`sidebar${showCollapsed ? ' sidebar-collapsed' : ''}${mobileOpen ? ' sidebar-mobile-open' : ''}`}
    >
      <div className="sidebar-header">
        <div className="sidebar-brand">
          {showCollapsed ? (
            <span className="sidebar-brand-mark">{t('app.brandMark')}</span>
          ) : (
            <>
              <h1 className="title">{t('app.name')}</h1>
              <p className="subtitle">{t('app.taglineShort')}</p>
            </>
          )}
        </div>
        <button
          type="button"
          className="sidebar-toggle-btn"
          onClick={mobileOpen ? onCloseMobile : onToggleCollapse}
          title={toggleLabel}
          aria-label={toggleLabel}
        >
          {/* Chevrons point toward the content edge, so they mirror in RTL via .icon-flip-rtl. */}
          {mobileOpen ? <X size={18} /> : (collapsed ? <ChevronsRight size={18} className="icon-flip-rtl" /> : <ChevronsLeft size={18} className="icon-flip-rtl" />)}
        </button>
      </div>

      <nav className="sidebar-nav">
        {ALL_NAV_SECTIONS.map((section) => {
          // A section with nothing the user may see should not leave a stray heading.
          const visible = section.items.filter(
            (item) => !item.permission || hasPermission(item.permission),
          );
          if (!visible.length) return null;

          const links = visible.map(({ to, labelKey, icon: Icon }) => {
            const label = t(labelKey);
            return (
            <NavLink
              key={to}
              to={to}
              className="btn-secondary sidebar-nav-link"
              style={navStyle}
              title={showCollapsed ? label : undefined}
              onClick={onCloseMobile}
            >
              <Icon size={18} /> {!showCollapsed && <span>{label}</span>}
            </NavLink>
            );
          });

          // Collapsed desktop rail stays a flat icon list; no headers to toggle.
          if (showCollapsed) {
            return <React.Fragment key={section.id}>{links}</React.Fragment>;
          }

          const open = isSectionOpen(section.id);
          const domId = sectionDomId(section.id);
          return (
            <div className="sidebar-nav-group" key={section.id}>
              <button
                type="button"
                className="sidebar-nav-section"
                onClick={() => toggleSection(section.id)}
                aria-expanded={open}
                aria-controls={domId}
              >
                <span>{t(`nav.sections.${section.id}`)}</span>
                <ChevronDown size={14} className={`sidebar-nav-chevron${open ? '' : ' sidebar-nav-chevron-closed'}`} />
              </button>
              {open && (
                <div className="sidebar-nav-items" id={domId}>
                  {links}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {user && (
        <div className="sidebar-profile">
          <div
            className="sidebar-profile-row"
            title={showCollapsed ? t('nav.profileTitle', { username: user.username, role: t(`roleNames.${user.role}`, { defaultValue: user.role }) }) : undefined}
          >
            <div className="sidebar-avatar">{initials}</div>
            {!showCollapsed && (
              <div className="sidebar-profile-meta">
                <bdi className="sidebar-profile-name">{user.username}</bdi>
                <span className={`panel-chip role-${user.role}`}>{t(`roleNames.${user.role}`, { defaultValue: user.role })}</span>
              </div>
            )}
          </div>
          <LanguageSwitcher compact={showCollapsed} className="sidebar-language-switcher" />
          <button
            type="button"
            className="btn-secondary sidebar-logout"
            onClick={handleLogout}
            title={showCollapsed ? t('nav.logOut') : undefined}
          >
            <LogOut size={16} className="icon-flip-rtl" /> {!showCollapsed && t('nav.logOut')}
          </button>
        </div>
      )}
    </div>
  );
}
