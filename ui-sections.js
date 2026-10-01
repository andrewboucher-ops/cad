/**
 * The sections of the site, and which roles see each one — the single list
 * behind the desktop side menu (public/nav.js), the mobile burger menu and
 * the mobile home tiles (public/officer.html), and the admin "Menu &
 * sections" matrix.
 *
 * Each section has two role lists:
 *   allowed — the ceiling: the roles the page or feature itself serves. An
 *             admin cannot give a section to a role outside this, because the
 *             page would only refuse them (the page's own requireAuth() and
 *             the API's route roles are what actually protect it).
 *   default — who sees it until an admin changes it.
 * An admin's choice is stored as the role list per section, always clipped
 * to `allowed`. Hiding a section takes it out of the menus; it does not
 * revoke the API — with one exception, `active_users`, whose data only
 * exists for this view, so its route checks visibility here (server-side,
 * never trusting the menu).
 *
 * `desktop` / `mobile` say where the section appears: a desktop page in the
 * side menu, a mobile screen (`#key` inside officer.html) or page on the
 * phone layout. `home` marks the big buttons on the mobile home screen.
 */
'use strict';

const STAFF = ['FIELD_USER', 'DISPATCHER', 'SUPERVISOR', 'SYSTEM_ADMIN'];
const CONTROL = ['DISPATCHER', 'SUPERVISOR', 'SYSTEM_ADMIN'];
const EDITABLE_ROLES = ['FIELD_USER', 'DISPATCHER', 'SUPERVISOR', 'SYSTEM_ADMIN', 'FINANCE', 'MDT_USER'];

const SECTIONS = [
  // Operations
  { key: 'dashboard', label: 'Dashboard', group: 'Operations', icon: 'dashboard', desktop: '/dashboard.html', allowed: CONTROL, default: CONTROL },
  { key: 'control', label: 'Control room', group: 'Operations', icon: 'control', desktop: '/control.html', allowed: CONTROL, default: CONTROL },
  { key: 'my_shift', label: 'My shift', group: 'Operations', icon: 'clock', mobile: '#shift', home: true, needs_person: true, allowed: STAFF, default: STAFF },
  { key: 'current_job', label: 'Current job', group: 'Operations', icon: 'job', mobile: '#job', home: true, needs_person: true, allowed: STAFF, default: STAFF },
  { key: 'patrol', label: 'Patrol visit', group: 'Operations', icon: 'patrol', mobile: '#visit', home: true, needs_person: true, allowed: STAFF, default: STAFF },
  { key: 'welfare', label: 'Welfare timer', group: 'Operations', icon: 'welfare', mobile: '#welfare', home: true, needs_person: true, allowed: STAFF, default: STAFF },
  { key: 'messages', label: 'Messages', group: 'Operations', icon: 'message', mobile: '#messages', home: true, allowed: STAFF, default: STAFF },
  { key: 'active_users', label: 'Active users', group: 'Operations', icon: 'people', mobile: '#active', home: true, allowed: STAFF, default: CONTROL },
  { key: 'log', label: 'Log', group: 'Operations', icon: 'log', desktop: '/log.html', allowed: CONTROL, default: CONTROL },
  // Reports
  { key: 'incident_report', label: 'Incident report', group: 'Reports', icon: 'incident', mobile: '#incident', home: true, allowed: STAFF, default: STAFF },
  { key: 'reports', label: 'Reports', group: 'Reports', icon: 'reports', desktop: '/forms.html', mobile: '#reports', home: true, allowed: [...STAFF, 'MDT_USER'], default: [...STAFF, 'MDT_USER'] },
  { key: 'passdown', label: 'Site handover', group: 'Reports', icon: 'passdown', mobile: '#passdown', needs_person: true, allowed: STAFF, default: STAFF },
  // Fleet & people
  { key: 'vehicle_check', label: 'Vehicle check', group: 'Fleet & people', icon: 'check', mobile: '#vehicle-check', home: true, allowed: STAFF, default: STAFF },
  { key: 'fuel_up', label: 'Fuel up', group: 'Fleet & people', icon: 'fuel', mobile: '#fuel', home: true, allowed: STAFF, default: STAFF },
  { key: 'deep_clean', label: 'Deep clean', group: 'Fleet & people', icon: 'clean', mobile: '#clean', home: true, allowed: STAFF, default: STAFF },
  { key: 'fleet', label: 'Fleet', group: 'Fleet & people', icon: 'fleet', desktop: '/fleet.html', mobile: '/fleet.html', allowed: CONTROL, default: CONTROL },
  { key: 'rota', label: 'Rota', group: 'Fleet & people', icon: 'rota', desktop: '/rota.html', mobile: '#rota', home: true, allowed: STAFF, default: STAFF },
  { key: 'leave', label: 'Leave', group: 'Fleet & people', icon: 'leave', mobile: '#leave', needs_person: true, allowed: STAFF, default: STAFF },
  { key: 'training', label: 'Training', group: 'Fleet & people', icon: 'training', mobile: '#training', needs_person: true, allowed: STAFF, default: STAFF },
  { key: 'equipment', label: 'My equipment', group: 'Fleet & people', icon: 'equipment', mobile: '#equipment', needs_person: true, allowed: STAFF, default: STAFF },
  // Finance
  { key: 'finance', label: 'Finance', group: 'Finance', icon: 'finance', desktop: '/finance.html', mobile: '/finance.html', allowed: [...CONTROL, 'FINANCE'], default: [...CONTROL, 'FINANCE'] },
  // System
  { key: 'admin', label: 'Admin', group: 'System', icon: 'admin', desktop: '/admin.html', mobile: '/admin.html', allowed: ['SYSTEM_ADMIN'], default: ['SYSTEM_ADMIN'], locked: ['SYSTEM_ADMIN'] },
  { key: 'client_portals', label: 'Client portals', group: 'System', icon: 'portal', desktop: '/client.html', allowed: ['SYSTEM_ADMIN'], default: ['SYSTEM_ADMIN'] },
  // Me
  { key: 'mobile_app', label: 'Officer app', group: 'Me', icon: 'terminal', desktop: '/officer.html', allowed: STAFF, default: ['FIELD_USER'] },
  { key: 'vehicle_terminal', label: 'Vehicle terminal', group: 'Me', icon: 'terminal', desktop: '/mdt.html', allowed: ['MDT_USER'], default: ['MDT_USER'] },
  { key: 'settings', label: 'My settings', group: 'Me', icon: 'me', desktop: '/settings.html', mobile: '/settings.html', allowed: EDITABLE_ROLES, default: EDITABLE_ROLES, locked: EDITABLE_ROLES },
];
const BY_KEY = new Map(SECTIONS.map((s) => [s.key, s]));

module.exports = function registerUiSections({ route, httpError, ADMIN, db, logEvent, flushNow }) {
  if (!Array.isArray(db.ui_settings)) db.ui_settings = [];
  const stored = () => (db.ui_settings.find((r) => r.key === 'sections') || {}).roles || {};

  /** Roles that see a section now: the admin's choice (clipped to the
   * ceiling, plus any locked roles), else the default. */
  function rolesFor(key) {
    const s = BY_KEY.get(key); if (!s) return [];
    const chosen = stored()[key];
    const base = Array.isArray(chosen) ? chosen.filter((r) => s.allowed.includes(r)) : s.default;
    return [...new Set([...base, ...(s.locked || [])])];
  }
  const canSee = (key, role) => rolesFor(key).includes(role);

  const publicSection = (s) => ({ key: s.key, label: s.label, group: s.group, icon: s.icon, desktop: s.desktop || null, mobile: s.mobile || null, home: Boolean(s.home), needs_person: Boolean(s.needs_person) });

  // Every signed-in role, CLIENT included (it simply gets an empty list):
  // the menu is built from this on every page.
  route('GET', '/api/ui/sections', [], ({ user }) => SECTIONS.filter((s) => canSee(s.key, user.role)).map(publicSection));

  route('GET', '/api/admin/ui-sections', ADMIN, () => ({
    roles: EDITABLE_ROLES,
    sections: SECTIONS.map((s) => ({ ...publicSection(s), allowed: s.allowed, default: s.default, locked: s.locked || [], visible_to: rolesFor(s.key) })),
  }));

  route('PUT', '/api/admin/ui-sections', ADMIN, ({ body, user }) => {
    const raw = body && body.visible_to;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, 'visible_to must be an object of section → roles');
    const next = {};
    const changes = [];
    for (const [key, roles] of Object.entries(raw)) {
      const s = BY_KEY.get(key); if (!s) throw httpError(400, `unknown section ${key}`);
      if (!Array.isArray(roles)) throw httpError(400, `${key}: roles must be a list`);
      for (const r of roles) if (!s.allowed.includes(r)) throw httpError(400, `${s.label} cannot be shown to ${r} — that page does not serve that role`);
      next[key] = [...new Set([...roles, ...(s.locked || [])])];
      const before = rolesFor(key).slice().sort().join(','), after = next[key].slice().sort().join(',');
      if (before !== after) changes.push(`${s.label}: ${after || 'nobody'}`);
    }
    let row = db.ui_settings.find((r) => r.key === 'sections');
    if (!row) { row = { key: 'sections', roles: {} }; db.ui_settings.push(row); }
    row.roles = { ...row.roles, ...next };
    row.updated_at = new Date().toISOString(); row.updated_by = user.username;
    logEvent('ui.sections_updated', `MENU SECTIONS CHANGED BY ${user.username}${changes.length ? ': ' + changes.join('; ') : ' (no changes)'}`, {});
    flushNow();
    return { ok: true, changed: changes.length };
  });

  return { canSee, rolesFor };
};
module.exports.SECTIONS = SECTIONS;
