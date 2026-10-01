/* The side menu — one definition for every staff page.
 *
 * Each page used to carry its own copy of the menu, and the copies drifted:
 * a section existed on one page and not the next, and the control room's
 * own panel buttons sat where other pages had navigation. Now every page
 * loads this file (after app.js) and gets the same menu, built from the list
 * below. What changes between people is only their role — each link is
 * shown to the roles that page itself lets in — and which entry is
 * highlighted.
 *
 * A page that already lays itself out around a menu (padding-left: 228px)
 * keeps its <div class="icon-rail"> and has it refilled. A page that has
 * none gets one added and the body class `with-nav`, which console.css
 * pads for — and drops on narrow screens, so an officer filing a report on
 * a phone isn't squeezed by a desktop menu.
 */
'use strict';
(() => {
  // app.js declares CCCS with const: a global name, but NOT a window
  // property — so test the name itself, not window.CCCS.
  const session = typeof CCCS !== 'undefined' && CCCS.getSession();
  if (!session || !session.user) return;
  const role = session.user.role;

  const CONTROL = ['DISPATCHER', 'SUPERVISOR', 'SYSTEM_ADMIN'];
  const ICON = {
    dashboard: '<rect x="3" y="3" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.8"/><rect x="13" y="3" width="8" height="5" rx="1.5" stroke="currentColor" stroke-width="1.8"/><rect x="13" y="10" width="8" height="11" rx="1.5" stroke="currentColor" stroke-width="1.8"/><rect x="3" y="13" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.8"/>',
    control: '<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9 4v14M15 6v14" stroke="currentColor" stroke-width="1.6"/>',
    reports: '<rect x="5" y="3" width="14" height="18" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M9 8h6M9 12h6M9 16h3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    log: '<path d="M5 4h14v16l-3-2-3 2-3-2-3 2z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 9h8M8 13h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    fleet: '<path d="M3 15V9l2-4h11l3 4h2v6h-2" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="7.5" cy="16.5" r="2" stroke="currentColor" stroke-width="1.8"/><circle cx="16.5" cy="16.5" r="2" stroke="currentColor" stroke-width="1.8"/>',
    rota: '<rect x="3" y="4" width="18" height="17" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M3 9h18M8 3v3M16 3v3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    finance: '<path d="M12 2v20M17 6.5c0-1.9-2.2-3.5-5-3.5s-5 1.6-5 3.5 2.2 3 5 3.5c2.8.5 5 1.6 5 3.5s-2.2 3.5-5 3.5-5-1.6-5-3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    admin: '<path d="M4 8a4 4 0 118 0 4 4 0 01-8 0z" stroke="currentColor" stroke-width="1.8"/><path d="M2.5 19c0-3.3 2.7-5.5 5.5-5.5s5.5 2.2 5.5 5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M15.5 4.5l1 1.8 2 .4-1.4 1.5.3 2-1.9-.9-1.9.9.3-2-1.4-1.5 2-.4z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
    portal: '<rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M3 9h18" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="14" r="2" stroke="currentColor" stroke-width="1.6"/>',
    terminal: '<rect x="4" y="3" width="16" height="12" rx="1.5" stroke="currentColor" stroke-width="1.8"/><path d="M9 19h6M12 15v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    me: '<circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="1.8"/><path d="M4.5 20c0-3.6 3.4-6 7.5-6s7.5 2.4 7.5 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  };
  /** Roles mirror each page's own requireAuth() — a link is only offered to
   * someone the page would let in. */
  const MENU = [
    ['Operations', [
      ['/dashboard.html', 'Dashboard', 'dashboard', CONTROL],
      ['/control.html', 'Control room', 'control', CONTROL],
      ['/forms.html', 'Reports', 'reports', [...CONTROL, 'FIELD_USER', 'MDT_USER']],
      ['/log.html', 'Log', 'log', CONTROL],
    ]],
    ['Fleet & people', [
      ['/fleet.html', 'Fleet', 'fleet', CONTROL],
      ['/rota.html', 'Rota', 'rota', CONTROL],
    ]],
    ['Finance', [
      ['/finance.html', 'Finance', 'finance', [...CONTROL, 'FINANCE']],
    ]],
    ['System', [
      ['/admin.html', 'Admin', 'admin', ['SYSTEM_ADMIN']],
      ['/client.html', 'Client portals', 'portal', ['SYSTEM_ADMIN']],
    ]],
    ['Me', [
      ['/officer.html', 'Officer terminal', 'terminal', ['FIELD_USER']],
      ['/mdt.html', 'Vehicle terminal', 'terminal', ['MDT_USER']],
      ['/settings.html', 'My settings', 'me', null],
    ]],
  ];

  const here = location.pathname === '/' ? '/index.html' : location.pathname;
  const html = ['<div class="rail-brand"><img class="brand-wordmark" src="/assets/echelon-wordmark.png" alt="Echelon"></div>'];
  for (const [section, items] of MENU) {
    const visible = items.filter(([, , , roles]) => !roles || roles.includes(role));
    if (!visible.length) continue;
    html.push(`<div class="rail-section">${section}</div>`);
    for (const [href, label, icon] of visible) {
      html.push(`<a href="${href}" title="${label}"${href === here ? ' class="active" aria-current="page"' : ''}><svg viewBox="0 0 24 24" fill="none">${ICON[icon]}</svg><span>${label}</span></a>`);
    }
  }

  let rail = document.querySelector('.icon-rail');
  if (!rail) {
    rail = document.createElement('nav');
    rail.className = 'icon-rail';
    document.body.appendChild(rail);
    document.body.classList.add('with-nav');
  }
  rail.setAttribute('aria-label', 'Main menu');
  rail.innerHTML = html.join('');
})();
