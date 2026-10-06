/* The menu — one definition for every staff page, desktop and mobile.
 *
 * What is in it comes from the server (GET /api/ui/sections): the sections
 * this user's role may see, as set by an admin in Admin → Menu & sections
 * (ui-sections.js holds the list and the defaults). The last answer is
 * cached per role so the menu paints instantly, then refreshed.
 *
 * Desktop: the side menu, as before — a page that already lays itself out
 * around one keeps its <div class="icon-rail"> and has it refilled; any
 * other gets one added plus body.with-nav, which console.css pads for.
 *
 * Phone or tablet (CCCS.deviceKind(), overridable in My settings): no side
 * menu. A burger button opens a drawer with the mobile entries instead, and
 * the control room and dashboard — desktop-only views — send you to the
 * mobile home screen (officer.html), which shows the same sections as big
 * buttons. A page can host the burger itself by including an element with
 * [data-nav-burger]; otherwise a floating one is added.
 */
'use strict';
(() => {
  // app.js declares CCCS with const: a global name, but NOT a window
  // property — so test the name itself, not window.CCCS.
  const session = typeof CCCS !== 'undefined' && CCCS.getSession();
  if (!session || !session.user) return;
  const { user } = session;
  const mobile = CCCS.isMobile();
  // The burger also stands in for the side menu in a narrow desktop window,
  // but only a real phone/tablet changes where links go or skips the
  // control room.
  const compact = mobile || window.innerWidth <= 860;
  const page = location.pathname === '/' ? '/index.html' : location.pathname;

  // The control room is not offered on a phone or tablet: send it home.
  if (mobile && ['/control.html', '/dashboard.html'].includes(page) && user.role !== 'MDT_USER') {
    location.replace('/officer.html');
    return;
  }

  const i = (d) => d;
  const ICON = {
    dashboard: i('<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/>'),
    control: i('<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z" stroke-linejoin="round"/><path d="M9 4v14M15 6v14"/>'),
    reports: i('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3" stroke-linecap="round"/>'),
    log: i('<path d="M5 4h14v16l-3-2-3 2-3-2-3 2z" stroke-linejoin="round"/><path d="M8 9h8M8 13h5" stroke-linecap="round"/>'),
    fleet: i('<path d="M3 15V9l2-4h11l3 4h2v6h-2" stroke-linejoin="round"/><circle cx="7.5" cy="16.5" r="2"/><circle cx="16.5" cy="16.5" r="2"/>'),
    rota: i('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 3v3M16 3v3" stroke-linecap="round"/>'),
    finance: i('<path d="M12 2v20M17 6.5c0-1.9-2.2-3.5-5-3.5s-5 1.6-5 3.5 2.2 3 5 3.5c2.8.5 5 1.6 5 3.5s-2.2 3.5-5 3.5-5-1.6-5-3.5" stroke-linecap="round"/>'),
    admin: i('<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" stroke-linecap="round"/>'),
    portal: i('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/><circle cx="12" cy="14" r="2"/>'),
    terminal: i('<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2" stroke-linecap="round"/>'),
    me: i('<circle cx="12" cy="8" r="4"/><path d="M4.5 20c0-3.6 3.4-6 7.5-6s7.5 2.4 7.5 6" stroke-linecap="round"/>'),
    clock: i('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2" stroke-linecap="round"/>'),
    job: i('<path d="M12 3l9 16H3z" stroke-linejoin="round"/><path d="M12 10v4M12 17h.01" stroke-linecap="round"/>'),
    patrol: i('<path d="M12 21s-7-6.2-7-11a7 7 0 0114 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>'),
    welfare: i('<path d="M12 20s-8-4.6-8-10.2A4.4 4.4 0 0112 7a4.4 4.4 0 018 2.8C20 15.4 12 20 12 20z" stroke-linejoin="round"/>'),
    message: i('<path d="M4 5h16v11H9l-5 4z" stroke-linejoin="round"/>'),
    people: i('<circle cx="9" cy="8" r="3.2"/><path d="M3 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" stroke-linecap="round"/><path d="M16 5a3 3 0 010 6M18 13.8c1.9.7 3 2.6 3 5.2" stroke-linecap="round"/>'),
    incident: i('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M12 8v5M12 16h.01" stroke-linecap="round"/>'),
    passdown: i('<path d="M4 7h12M4 7l4-4M4 7l4 4M20 17H8m12 0l-4-4m4 4l-4 4" stroke-linecap="round" stroke-linejoin="round"/>'),
    check: i('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 12l3 3 5-6" stroke-linecap="round" stroke-linejoin="round"/>'),
    fuel: i('<path d="M5 21V5a2 2 0 012-2h6a2 2 0 012 2v16M3 21h14M7 8h6" stroke-linecap="round"/><path d="M15 9h2a2 2 0 012 2v6a1.5 1.5 0 003 0V8l-3-3" stroke-linecap="round" stroke-linejoin="round"/>'),
    clean: i('<path d="M12 3c3 4 6 7.2 6 10.5a6 6 0 01-12 0C6 10.2 9 7 12 3z" stroke-linejoin="round"/><path d="M9.5 14a2.5 2.5 0 002.5 2.5" stroke-linecap="round"/>'),
    leave: i('<path d="M3 20h18M5 20c0-6 3-10 7-10s7 4 7 10M12 10V4M9 6h6" stroke-linecap="round"/>'),
    training: i('<path d="M2 9l10-5 10 5-10 5z" stroke-linejoin="round"/><path d="M6 11v5c3 2 9 2 12 0v-5" stroke-linecap="round"/>'),
    asset: i('<path d="M3 7l9-4 9 4v10l-9 4-9-4z" stroke-linejoin="round"/><path d="M3 7l9 4 9-4M12 11v10"/>'),
    scan: i('<path d="M4 8V5a1 1 0 011-1h3M16 4h3a1 1 0 011 1v3M20 16v3a1 1 0 01-1 1h-3M8 20H5a1 1 0 01-1-1v-3" stroke-linecap="round"/><path d="M7 12h10" stroke-linecap="round"/>'),
    contract: i('<path d="M6 3h9l4 4v14H6z" stroke-linejoin="round"/><path d="M15 3v4h4M9 12h6M9 16h3" stroke-linecap="round"/><path d="M13 18c1-1.5 2-1.5 2.5 0s1.5 1 2.5-.5" stroke-linecap="round"/>'),
    invoice: i('<path d="M6 3h12v18l-2-1.5L14 21l-2-1.5L10 21l-2-1.5L6 21z" stroke-linejoin="round"/><path d="M9 8h6M9 12h6M9 16h3" stroke-linecap="round"/>'),
    rental: i('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h4" stroke-linecap="round"/><path d="M15 17l1.5 1.5L19 15" stroke-linecap="round" stroke-linejoin="round"/>'),
    stock: i('<rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/><rect x="8" y="3" width="8" height="8" rx="1"/>'),
    equipment: i('<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 012-2h4a2 2 0 012 2v2M3 12h18" stroke-linecap="round"/>'),
  };
  const svg = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${ICON[name] || ICON.reports}</svg>`;
  const esc = CCCS.esc;

  /** Where a section goes on this device, or null if it has no place here.
   * A mobile screen (#key) lives in officer.html. Someone with no officer
   * record (most control users) has no shift to show on "Rota" or reports
   * of their own on "Reports", so those take them to the desktop page. */
  function href(s) {
    if (s.needs_person && !user.personnel_id) return null;
    if (!mobile) return s.desktop;
    if (!s.mobile) return null;
    if (s.mobile.startsWith('#')) {
      if (!user.personnel_id && s.desktop && ['rota', 'reports'].includes(s.key)) return s.desktop;
      return `/officer.html${s.mobile}`;
    }
    return s.mobile;
  }
  const isHere = (h) => {
    if (!h) return false;
    const [p, hash] = h.split('#');
    return p === page && (hash ? location.hash === '#' + hash : !location.hash || p !== '/officer.html');
  };

  const cacheKey = `cccs.sections.${user.role}`;
  let sections = null;
  try { sections = JSON.parse(sessionStorage.getItem(cacheKey) || 'null'); } catch {}

  function grouped() {
    const out = [];
    for (const s of sections || []) {
      const h = href(s); if (!h) continue;
      let g = out.find((x) => x.name === s.group);
      if (!g) out.push((g = { name: s.group, items: [] }));
      g.items.push({ ...s, href: h });
    }
    return out;
  }
  const linkHtml = (s) => `<a href="${esc(s.href)}" title="${esc(s.label)}"${isHere(s.href) ? ' class="active" aria-current="page"' : ''}>${svg(s.icon)}<span>${esc(s.label)}</span></a>`;

  /** Collapsible groups on the desktop rail — "less there until it's
   * needed". Opt-in only: every group starts open (so nothing already
   * using the menu loses an item without asking for that), and only a
   * group someone has actually collapsed is remembered, per browser, so
   * it does not affect anyone else or follow them to another device. A
   * group holding the current page always forces open regardless of its
   * stored state — collapsing never hides where you already are. */
  const collapseKey = 'cccs.nav.collapsedGroups';
  function collapsedGroups() { try { return new Set(JSON.parse(localStorage.getItem(collapseKey) || '[]')); } catch { return new Set(); } }
  function setGroupCollapsed(name, collapsed) {
    const set = collapsedGroups();
    collapsed ? set.add(name) : set.delete(name);
    try { localStorage.setItem(collapseKey, JSON.stringify([...set])); } catch {}
  }

  function paintRail() {
    let rail = document.querySelector('.icon-rail');
    if (!rail) {
      rail = document.createElement('nav');
      rail.className = 'icon-rail';
      document.body.appendChild(rail);
      document.body.classList.add('with-nav');
    }
    rail.setAttribute('aria-label', 'Main menu');
    const collapsed = collapsedGroups();
    rail.innerHTML = '<div class="rail-brand"><img class="brand-wordmark" src="/assets/echelon-wordmark.png" alt="Echelon"></div>'
      + grouped().map((g) => {
        const hasActive = g.items.some((s) => isHere(s.href));
        const isCollapsed = collapsed.has(g.name) && !hasActive;
        return `<button type="button" class="rail-section" data-group="${esc(g.name)}" aria-expanded="${!isCollapsed}">`
          + `<span>${esc(g.name)}</span><svg class="rail-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`
          + `<div class="rail-group${isCollapsed ? ' hide' : ''}">${g.items.map(linkHtml).join('')}</div>`;
      }).join('');
    rail.querySelectorAll('.rail-section').forEach((btn) => (btn.onclick = () => {
      const name = btn.dataset.group;
      const nowCollapsed = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!nowCollapsed));
      btn.nextElementSibling.classList.toggle('hide', nowCollapsed);
      setGroupCollapsed(name, nowCollapsed);
    }));
  }

  let drawer = null;
  function paintDrawer() {
    if (!drawer) {
      drawer = document.createElement('div');
      drawer.className = 'm-drawer';
      drawer.innerHTML = '<div class="m-drawer-back" data-close></div><nav class="m-drawer-panel" aria-label="Main menu"></nav>';
      document.body.appendChild(drawer);
      drawer.addEventListener('click', (e) => { if (e.target.closest('[data-close]') || e.target.closest('a')) close(); });
    }
    const who = user.display_name || user.username;
    drawer.querySelector('.m-drawer-panel').innerHTML = `
      <div class="m-drawer-head"><img class="brand-wordmark" src="/assets/echelon-wordmark.png" alt="Echelon"><button class="m-x" data-close aria-label="Close menu">✕</button></div>
      <a href="/officer.html"${page === '/officer.html' && !location.hash ? ' class="active"' : ''}>${svg('dashboard')}<span>Home</span></a>
      ${grouped().map((g) => `<div class="rail-section">${esc(g.name)}</div>${g.items.map(linkHtml).join('')}`).join('')}
      <div class="m-drawer-foot">
        <div class="dim">${esc(who)} · ${esc(user.role.replace('_', ' ').toLowerCase())}</div>
        <button class="btn" data-signout>Sign out</button>
      </div>`;
    drawer.querySelector('[data-signout]').onclick = () => { CCCS.clearSession(); location.href = '/index.html'; };
  }
  const open = () => { paintDrawer(); drawer.classList.add('open'); document.body.classList.add('m-drawer-open'); };
  const close = () => { if (drawer) drawer.classList.remove('open'); document.body.classList.remove('m-drawer-open'); };

  function paint() {
    if (!sections) return;
    if (!compact) { paintRail(); return; }
    document.body.classList.add('nav-mobile');
    const rail = document.querySelector('.icon-rail'); if (rail) rail.remove();
    let burger = document.querySelector('[data-nav-burger]');
    if (!burger) {
      burger = document.createElement('button');
      burger.className = 'm-burger m-burger-float';
      burger.setAttribute('data-nav-burger', '');
      document.body.appendChild(burger);
      document.body.classList.add('nav-float');
    }
    burger.setAttribute('aria-label', 'Menu');
    if (!burger.innerHTML.trim()) burger.innerHTML = '<span></span><span></span><span></span>';
    burger.onclick = open;
    if (drawer) paintDrawer();
  }

  paint();
  CCCS.api('GET', '/api/ui/sections').then((fresh) => {
    const changed = JSON.stringify(fresh) !== JSON.stringify(sections);
    sections = fresh;
    try { sessionStorage.setItem(cacheKey, JSON.stringify(fresh)); } catch {}
    if (changed) { paint(); document.dispatchEvent(new CustomEvent('cccs:sections', { detail: sections })); }
  }).catch(() => {});
  window.addEventListener('hashchange', () => { if (drawer) paintDrawer(); });

  /** For officer.html's home screen: the same sections, the same hrefs. */
  window.CCCSNav = { href, svg, open, close, get sections() { return sections; }, mobile };
})();
