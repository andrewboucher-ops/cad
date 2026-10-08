/* CCCS shared client: auth, REST, WebSocket bus, SVG map. */
const CCCS = (() => {
  const KEY = 'cccs.session';
  let session = null;
  try {
    session = JSON.parse(sessionStorage.getItem(KEY) || 'null')
      || JSON.parse(localStorage.getItem(KEY + '.mirror') || 'null');
  } catch { session = null; }

  // Also mirrored to localStorage, which — unlike sessionStorage — is shared
  // with windows opened via window.open(). That's what a GoldenLayout
  // "popout" panel is: without this, the new window has no session and its
  // auth check fails before it ever renders anything, i.e. a blank window.
  function setSession(s) {
    session = s; sessionStorage.setItem(KEY, JSON.stringify(s)); try { localStorage.setItem(KEY + '.mirror', JSON.stringify(s)); } catch {} applyTheme(s && s.user && s.user.ui_prefs);
    // The right person being signed in is itself a trigger: a secure item
    // left queued because it belonged to someone else may now be sendable,
    // independent of the 'online' event, which may have already fired
    // while the wrong person was still signed in on this device.
    flushSecureOutbox();
  }
  function clearSession() { session = null; sessionStorage.removeItem(KEY); try { localStorage.removeItem(KEY + '.mirror'); } catch {} }
  function getSession() { return session; }

  /** Stamps the operator's theme choice onto <html> as data-* attributes,
   * which console.css keys every themed colour off. /theme-init.js does the
   * same thing synchronously in <head>, before this file has even loaded,
   * so the page never paints in the wrong theme first — this call exists
   * to keep the DOM in sync after login and after a live preference change
   * (public/settings.html calls it directly after PATCH /api/me/preferences
   * succeeds, for instant feedback with no reload). */
  function applyTheme(prefs) {
    const d = document.documentElement;
    if (!d) return; // stubbed DOM in the offline-outbox test harness, not a real page
    const p = prefs || {};
    const set = (attr, val) => { if (val) d.setAttribute(attr, val); else d.removeAttribute(attr); };
    set('data-theme', p.theme);
    set('data-mode', p.mode && p.mode !== 'system' ? p.mode : null);
    set('data-bloom', p.bloom);
    set('data-panels', p.panels);
    set('data-corners', p.corners);
    set('data-glow', p.glow ? 'on' : null);
    set('data-priority-ramp', p.priority_ramp);
    set('data-motion', p.reduce_motion ? 'reduce' : null);
  }
  if (session) applyTheme(session.user && session.user.ui_prefs);

  async function api(method, path, body, opts = {}) {
    const res = await fetch(path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(session ? { authorization: `Bearer ${session.token}` } : {}),
        ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
    if (!res.ok) { const err = new Error((data && data.error) || `${res.status} ${res.statusText}`); err.status = res.status; throw err; }
    return data;
  }

  async function login(username, password) {
    const out = await api('POST', '/api/auth/login', { username, password });
    setSession(out);
    return out;
  }

  /* ---- Offline outbox ---------------------------------------------------
     A vehicle loses signal mid-job. Writes are queued on the device and
     replayed in order when the link returns, each carrying an idempotency key
     so a lost reply cannot produce a duplicate job acknowledgement or message.

     Only writes go in the queue. Reads fail honestly — showing stale data as
     though it were live is how a controller ends up dispatching to a unit that
     cleared twenty minutes ago.                                            */
  const OUTBOX_KEY = 'cccs.outbox';
  const outboxListeners = new Set();

  function readOutbox() {
    try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); } catch { return []; }
  }
  function writeOutbox(items) {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(items.slice(-200)));
    outboxListeners.forEach((fn) => fn(items.length));
  }
  function enqueue(entry) {
    const items = readOutbox();
    items.push(entry);
    writeOutbox(items);
    return entry;
  }

  let flushing = false;
  async function flushOutbox() {
    if (flushing) return;
    flushing = true;
    try {
      let items = readOutbox();
      while (items.length) {
        const next = items[0];
        try {
          await api(next.method, next.path, next.body, { idempotencyKey: next.key });
        } catch (e) {
          if (isOffline(e)) break;               // still down — keep the queue intact
          console.warn('dropping unreplayable queued write', next.path, e.message);
        }
        items = readOutbox().filter((x) => x.key !== next.key);
        writeOutbox(items);
      }
    } finally { flushing = false; }
  }

  const isOffline = (e) => e instanceof TypeError || /Failed to fetch|NetworkError|Load failed/i.test(e.message || '');

  /** Write that survives losing signal: queued locally and replayed in order. */
  async function send(method, path, body, label) {
    const key = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
    try {
      return await api(method, path, body, { idempotencyKey: key });
    } catch (e) {
      if (!isOffline(e)) throw e;
      enqueue({ key, method, path, body, label: label || path, at: new Date().toISOString() });
      return { queued: true, key };
    }
  }

  window.addEventListener('online', flushOutbox);

  const outbox = {
    pending: () => readOutbox(),
    count: () => readOutbox().length,
    flush: flushOutbox,
    onChange(fn) { outboxListeners.add(fn); fn(readOutbox().length); },
    clear() { writeOutbox([]); },
  };

  /* ---- Secure offline outbox (reports, checkpoint scans) ---------------
     Same idea as the outbox above, but for a write where WHO made it
     matters, and which may carry a photo:
       - IndexedDB instead of localStorage, whose quota a single queued
         photo can overflow on its own.
       - Stamped with who queued it (their personnel_id), and only ever
         replayed while that same person is signed in on this device. A
         shared handset (an MDT, mainly — most officer handsets are
         personal) changing hands before the link returns must never
         submit a safeguarding report, or attribute a checkpoint scan to
         the wrong officer, just because someone else is now signed in.
         A mismatched item is left queued, visible, and unsent. */
  const SECURE_DB = 'cccs-secure-outbox', SECURE_STORE = 'items';
  function openSecureDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(SECURE_DB, 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(SECURE_STORE)) req.result.createObjectStore(SECURE_STORE, { keyPath: 'key' }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function idbReq(req) { return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }
  async function secureAll() { const db = await openSecureDB(); return idbReq(db.transaction(SECURE_STORE, 'readonly').objectStore(SECURE_STORE).getAll()); }
  async function securePut(item) { const db = await openSecureDB(); await idbReq(db.transaction(SECURE_STORE, 'readwrite').objectStore(SECURE_STORE).put(item)); }
  async function secureDelete(key) { const db = await openSecureDB(); await idbReq(db.transaction(SECURE_STORE, 'readwrite').objectStore(SECURE_STORE).delete(key)); }

  const secureListeners = new Set();
  function notifySecure() { secureAll().then((items) => secureListeners.forEach((fn) => fn(items))).catch(() => {}); }
  const myId = () => session && session.user && session.user.personnel_id;

  // A promise, not a boolean guard: setSession() below triggers a flush
  // without awaiting it (login itself must not block on network replay),
  // so a caller that does await secureOutbox.flush() right after needs to
  // wait for that same in-progress run to actually finish, not bounce off
  // a guard and resolve before the real work is done.
  async function doFlushSecure() {
    const mine = myId();
    if (!mine) return; // nobody with a staff record signed in — nothing can safely send
    let items;
    try { items = await secureAll(); } catch { return; } // IndexedDB unavailable — leave the queue for next time
    for (const item of items) {
      if (item.queued_by !== mine) continue; // someone else's — stays queued, never sent under this session
      try {
        await api(item.method, item.path, item.body, { idempotencyKey: item.key });
        await secureDelete(item.key);
      } catch (e) {
        if (isOffline(e)) break; // still down — keep the rest of the queue intact
        console.warn('dropping unreplayable secure write', item.path, e.message);
        await secureDelete(item.key);
      }
    }
  }
  let secureFlushPromise = null;
  function flushSecureOutbox() {
    if (secureFlushPromise) return secureFlushPromise;
    // .finally() is always deferred to a microtask, even on an already-
    // settled promise — unlike resetting secureFlushPromise from inside
    // doFlushSecure itself, which (when it returns before any await, e.g.
    // nobody signed in) runs synchronously while this very assignment is
    // still being evaluated, and the assignment completing last would
    // silently clobber the reset back to a stale, already-resolved promise.
    const p = doFlushSecure().finally(() => { secureFlushPromise = null; notifySecure(); });
    secureFlushPromise = p;
    return p;
  }

  /** Write that must never be sent under the wrong identity: queued locally
   * (IndexedDB) stamped with who made it, replayed only while they are
   * still signed in on this device. */
  async function sendSecure(method, path, body, label) {
    const key = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
    try {
      return await api(method, path, body, { idempotencyKey: key });
    } catch (e) {
      if (!isOffline(e)) throw e;
      const entry = { key, method, path, body, label: label || path, queued_by: myId(), at: new Date().toISOString() };
      try { await securePut(entry); } catch (e2) { throw e; } // IndexedDB unavailable too — surface the original offline error, nothing was queued
      notifySecure();
      return { queued: true, key };
    }
  }
  window.addEventListener('online', flushSecureOutbox);

  const secureOutbox = {
    pending: () => secureAll().catch(() => []),
    count: () => secureAll().then((items) => items.length).catch(() => 0),
    mine: () => secureAll().then((items) => items.filter((x) => x.queued_by === myId()).length).catch(() => 0),
    othersWaiting: () => secureAll().then((items) => items.some((x) => x.queued_by !== myId())).catch(() => false),
    flush: flushSecureOutbox,
    onChange(fn) { secureListeners.add(fn); secureAll().then(fn).catch(() => fn([])); },
  };

  /* ---- WebSocket bus with auto-reconnect ---- */
  function bus(onStatus) {
    const handlers = new Map();
    const binaryHandlers = [];
    let ws = null, retry = 0, closed = false;
    const queue = [];

    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(session.token)}`);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => { retry = 0; onStatus && onStatus(true); while (queue.length) ws.send(queue.shift()); };
      ws.onclose = () => {
        onStatus && onStatus(false);
        if (closed) return;
        retry = Math.min(retry + 1, 6);
        setTimeout(connect, 400 * retry);
      };
      ws.onerror = () => { try { ws.close(); } catch {} };
      ws.onmessage = (e) => {
        // Raw PCM from a legacy handset's floor time (relayAudioFrame in
        // server.js) — JSON.parse would just throw and silently discard
        // this on every frame, which is exactly what happened before
        // binaryType/this check existed.
        if (e.data instanceof ArrayBuffer) { binaryHandlers.forEach((fn) => fn(e.data)); return; }
        let msg; try { msg = JSON.parse(e.data); } catch { return; }
        (handlers.get(msg.type) || []).forEach((fn) => fn(msg.payload, msg));
        (handlers.get('*') || []).forEach((fn) => fn(msg.payload, msg));
      };
    }
    connect();
    return {
      on(type, fn) { handlers.set(type, [...(handlers.get(type) || []), fn]); return this; },
      onBinary(fn) { binaryHandlers.push(fn); return this; },
      send(type, payload) {
        const frame = JSON.stringify({ type, payload });
        if (ws && ws.readyState === 1) ws.send(frame); else queue.push(frame);
      },
      // No queueing here on purpose: audio is perishable, and stale queued
      // chunks flushed on reconnect would just play back as a burst of
      // noise well after the fact.
      sendBinary(data) { if (ws && ws.readyState === 1) ws.send(data); },
      wsState() { return ws ? ws.readyState : 'no-socket'; },
      close() { closed = true; try { ws.close(); } catch {} },
    };
  }

  /* ---- helpers ---- */
  const pad = (n) => String(n).padStart(2, '0');
  const hhmmss = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const el = (sel, root = document) => root.querySelector(sel);
  const els = (sel, root = document) => [...root.querySelectorAll(sel)];
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function requireAuth(roles) {
    if (!session) { location.href = `/index.html?next=${encodeURIComponent(location.pathname)}`; return false; }
    if (roles && !roles.includes(session.user.role)) {
      alert(`This console needs one of: ${roles.join(', ')}. You are signed in as ${session.user.role}.`);
      location.href = '/index.html';
      return false;
    }
    return true;
  }

  /* ---- SVG map (offline-capable; swap for Leaflet/OSM in production) ---- */
  /**
   * Real streets, not an abstract grid — dispatchers read positions against
   * actual roads and landmarks. Esri's free Dark/Light Gray Canvas looked
   * right but is genuinely capped at zoom 16 — server confirmed to return
   * byte-identical tiles for z16 and z18, i.e. an upscaled placeholder, not
   * more detail — so zooming in on an actual incident address turned to
   * mush exactly when precision mattered most. OSM's own tiles carry real
   * detail to z19; a hue-rotated invert() gets a genuinely dark map out of
   * them without an API key, tuned to avoid the "water turns orange" look
   * naive invert() filters get from CSS filter order alone.
   */
  function makeMap(container, opts = {}) {
    if (typeof L === 'undefined') throw new Error('Leaflet is not loaded — include leaflet.js before app.js');
    container.innerHTML = '';
    const mapDiv = document.createElement('div');
    mapDiv.style.cssText = 'width:100%;height:100%';
    container.appendChild(mapDiv);
    if (opts.theme !== 'light') mapDiv.classList.add('map-dark-tiles');

    const map = L.map(mapDiv, { attributionControl: true, preferCanvas: true })
      .setView(opts.center || [53.6152, -0.2210], opts.zoom || 12); // default: Immingham

    map.createPane('street').style.zIndex = 200;
    map.createPane('satellite').style.zIndex = 200;

    const streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      pane: 'street', maxZoom: 19, subdomains: 'abc',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    });
    const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      pane: 'satellite', maxZoom: 19,
      attribution: '&copy; <a href="https://www.esri.com">Esri</a>, Maxar, Earthstar Geographics',
    });

    streetLayer.addTo(map);
    const toggle = L.control({ position: 'topright' });
    toggle.onAdd = () => {
      const div = L.DomUtil.create('div', 'map-toggle');
      div.innerHTML = '<button type="button" class="active" data-layer="street">Street</button><button type="button" data-layer="satellite">Satellite</button>';
      L.DomEvent.disableClickPropagation(div);
      div.querySelectorAll('button').forEach((btn) => btn.addEventListener('click', () => {
        const wantSatellite = btn.dataset.layer === 'satellite';
        map.removeLayer(wantSatellite ? streetLayer : satelliteLayer);
        map.addLayer(wantSatellite ? satelliteLayer : streetLayer);
        div.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
      }));
      return div;
    };
    toggle.addTo(map);

    const unitLayer = L.layerGroup().addTo(map);
    const jobLayer = L.layerGroup().addTo(map);

    const colour = (s) => ({
      AVAILABLE: '#22c55e', ON_TASK: '#3b82f6', EN_ROUTE: '#3b82f6', ON_SCENE: '#3b82f6',
      BUSY: '#eab308', EMERGENCY: '#ef4444', OFFLINE: '#64748b', OUT_OF_SERVICE: '#64748b',
    }[s] || '#64748b');
    const priColour = (p) => ({ RED: '#ef4444', AMBER: '#f97316', GREEN: '#22c55e' }[p] || '#64748b');

    if ('ResizeObserver' in window) new ResizeObserver(() => map.invalidateSize()).observe(mapDiv);

    return {
      render(units, jobs = [], onPick) {
        unitLayer.clearLayers();
        jobLayer.clearLayers();
        const pts = [];

        for (const j of jobs) {
          if (j.lat == null) continue;
          pts.push([j.lat, j.lon]);
          const icon = L.divIcon({
            className: '', iconSize: [18, 18], iconAnchor: [9, 9],
            html: `<div class="map-job" style="border-color:${priColour(j.priority)}"></div>`,
          });
          L.marker([j.lat, j.lon], { icon, keyboard: false, interactive: false })
            .bindTooltip(esc(j.reference), { permanent: true, direction: 'right', offset: [8, 0], className: 'map-tip' })
            .addTo(jobLayer);
        }

        for (const u of units) {
          if (u.lat == null) continue;
          pts.push([u.lat, u.lon]);
          const label = `${u.callsign || u.issi}${u.speed ? ` ${u.speed}mph` : ''}`;
          const icon = L.divIcon({
            className: '', iconSize: [14, 14], iconAnchor: [7, 7],
            html: `<div class="map-unit${u.emergency ? ' emergency' : ''}" style="background:${colour(u.status)}"></div>`,
          });
          const marker = L.marker([u.lat, u.lon], { icon })
            .bindTooltip(esc(label), { permanent: true, direction: 'right', offset: [8, -4], className: 'map-tip' })
            .addTo(unitLayer);
          if (onPick) marker.on('click', () => onPick(u));
        }
      },
      /** Fits the view to whatever has a position — called explicitly (a
       * "Recenter" button, or a nav screen's own paint step), never
       * automatically, so the map doesn't jump away from the operator's
       * chosen view whenever one unit reports a new position. */
      fitToData(units = [], jobs = []) {
        const pts = [...units, ...jobs].filter((x) => x.lat != null).map((x) => [x.lat, x.lon]);
        if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 14 });
      },
      /**
       * Turns the map into an actual navigation view — a routed line along
       * real roads, not just two pins — using Leaflet Routing Machine's free
       * OSRM demo backend (no API key; same "reasonable use" terms as the
       * OSM tiles). Only on pages that load leaflet-routing-machine — a
       * no-op elsewhere. `onSummary` gets {totalDistance (m), totalTime (s)}.
       */
      setRoute(from, to, onSummary) {
        if (typeof L.Routing === 'undefined' || !from || !to) return;
        if (!this._routing) {
          this._routing = L.Routing.control({
            waypoints: [], addWaypoints: false, draggableWaypoints: false, routeWhileDragging: false,
            fitSelectedRoutes: true, show: false, createMarker: () => null,
            lineOptions: { styles: [{ color: '#3b82f6', weight: 5, opacity: .85 }] },
          }).addTo(map);
          this._routing.on('routesfound', (e) => {
            this._route = e.routes[0];
            onSummary && this._route && onSummary(this._route.summary);
          });
        }
        this._routing.setWaypoints([L.latLng(from[0], from[1]), L.latLng(to[0], to[1])]);
      },
      clearRoute() { if (this._routing) this._routing.setWaypoints([]); this._route = null; },
      invalidateSize() { map.invalidateSize(); },
      /** Recenters without the "fit everything" logic fitToData uses —
       * a sat-nav view wants to stay locked on the vehicle at a fixed,
       * fairly close zoom, not zoom out to fit the destination too. */
      centerOn(lat, lon, zoom) { map.setView([lat, lon], zoom || map.getZoom()); },
      /** Turn-by-turn against the last route found: nearest point on the
       * route to (lat, lon), the next instruction from there, and distance
       * to it. Null with no route yet. `offRoute` past 70m off the line is
       * the caller's cue to call setRoute again from the new position —
       * recalculation itself is the caller's job since only it knows the
       * destination and how often it wants to hit the OSRM demo server. */
      maneuverFor(lat, lon) {
        const route = this._route;
        if (!route || !route.coordinates || !route.coordinates.length || !route.instructions || !route.instructions.length) return null;
        let nearestIdx = 0, nearestDist = Infinity;
        route.coordinates.forEach((c, i) => {
          const d = haversine(lat, lon, c.lat, c.lng);
          if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
        });
        const upcoming = route.instructions.find((instr) => instr.index >= nearestIdx) || route.instructions[route.instructions.length - 1];
        const target = route.coordinates[upcoming.index] || route.coordinates[route.coordinates.length - 1];
        const distance = haversine(lat, lon, target.lat, target.lng);
        const isLast = upcoming === route.instructions[route.instructions.length - 1];
        // Remaining distance/ETA along what's left of the route, not the
        // route's original totals — those don't shrink as you drive.
        let remaining = haversine(lat, lon, route.coordinates[nearestIdx].lat, route.coordinates[nearestIdx].lng);
        for (let i = nearestIdx; i < route.coordinates.length - 1; i++) {
          remaining += haversine(route.coordinates[i].lat, route.coordinates[i].lng, route.coordinates[i + 1].lat, route.coordinates[i + 1].lng);
        }
        const avgSpeed = route.summary && route.summary.totalTime ? route.summary.totalDistance / route.summary.totalTime : null; // m/s
        return {
          instruction: upcoming, distance: Math.round(distance), offRoute: nearestDist > 70, arrived: isLast && distance < 25,
          remaining: Math.round(remaining), etaSeconds: avgSpeed ? Math.round(remaining / avgSpeed) : null,
        };
      },
    };
  }

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  /** Voice prompts at three distance bands per maneuver, like a normal sat
   * nav — not one announcement right as you're already at the junction.
   * Tracks which bands it's already spoken for the CURRENT instruction and
   * resets the moment maneuverFor() moves on to the next one. */
  function navAnnouncer() {
    let lastIndex = -1, said = new Set();
    let muted = false;
    function speak(text) {
      if (muted || !('speechSynthesis' in window)) return;
      try {
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
      } catch {}
    }
    return {
      check(m) {
        if (!m || !m.instruction) return;
        if (m.instruction.index !== lastIndex) { lastIndex = m.instruction.index; said = new Set(); }
        const text = m.instruction.text || 'continue';
        if (m.arrived) { if (!said.has('arrived')) { said.add('arrived'); speak('You have arrived at your destination.'); } return; }
        if (m.distance <= 50 && !said.has(50)) { said.add(50); said.add(200); said.add(500); speak(text); }
        else if (m.distance <= 200 && !said.has(200)) { said.add(200); said.add(500); speak(`In 200 metres, ${text}`); }
        else if (m.distance <= 500 && !said.has(500)) { said.add(500); speak(`In 500 metres, ${text}`); }
      },
      setMuted(v) { muted = v; if (v && 'speechSynthesis' in window) window.speechSynthesis.cancel(); },
      get muted() { return muted; },
    };
  }

  /** Arrow/glyph for a Leaflet Routing Machine instruction type — the OSRM
   * formatter's vocabulary, not exhaustive but covers what a road network
   * actually produces. */
  const NAV_ICONS = {
    Straight: '⬆️', Head: '⬆️', Continue: '⬆️', SlightRight: '↗️', Right: '➡️', SharpRight: '↘️',
    TurnAround: '↩️', SharpLeft: '↙️', Left: '⬅️', SlightLeft: '↖️', Roundabout: '🔄',
    DestinationReached: '🏁', WaypointReached: '📍', StartAt: '⬆️',
  };
  function navIcon(instruction) {
    return NAV_ICONS[instruction && instruction.type] || '⬆️';
  }

  /* ---- Web Push -----------------------------------------------------------
     Lets a phone that added the console to its home screen get emergency,
     call and job alerts while it isn't open — no App Store, no native app.
     iOS only allows this for an *installed* (home-screen) PWA, not a bare
     Safari tab; other platforms allow it either way. */
  function urlBase64ToUint8Array(base64url) {
    const raw = atob(base64url.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
  const push = {
    isSupported: pushSupported,
    async status() {
      if (!pushSupported()) return 'unsupported';
      if (Notification.permission === 'denied') return 'denied';
      const reg = await navigator.serviceWorker.getRegistration('/sw.js');
      const sub = reg && (await reg.pushManager.getSubscription());
      return sub ? 'subscribed' : 'available';
    },
    async enable() {
      if (!pushSupported()) throw new Error('Push is not supported in this browser');
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('Notification permission was not granted');
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const { key } = await api('GET', '/api/push/vapid-public-key');
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
      await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
      return sub;
    },
    async disable() {
      if (!pushSupported()) return;
      const reg = await navigator.serviceWorker.getRegistration('/sw.js');
      const sub = reg && (await reg.pushManager.getSubscription());
      if (!sub) return;
      await api('DELETE', '/api/push/subscribe', { endpoint: sub.endpoint });
      await sub.unsubscribe();
    },
  };

  /* ---- Phone / tablet detection ----
   * "Mobile" means the touch layout (officer.html's home screen, burger
   * menu, no control room), not literally a phone: tablets get it too. The
   * browser's own answer wins where it gives one (userAgentData.mobile);
   * otherwise the user agent, iPadOS's desktop-pretending Safari (MacIntel
   * with a touch screen), and finally a coarse pointer on a small screen.
   * Anyone can override it in My settings → Layout, kept per device. */
  const VIEW_KEY = 'cccs.view';
  function viewPreference() { try { return localStorage.getItem(VIEW_KEY) || 'auto'; } catch { return 'auto'; } }
  function setViewPreference(v) { try { if (v === 'auto') localStorage.removeItem(VIEW_KEY); else localStorage.setItem(VIEW_KEY, v); } catch {} }
  function detectedDevice() {
    const nav = typeof navigator !== 'undefined' ? navigator : {};
    const ua = nav.userAgent || '';
    const touchMac = nav.platform === 'MacIntel' && nav.maxTouchPoints > 1;
    const tabletUa = /iPad|Tablet|Android(?!.*Mobile)|Silk|Kindle|PlayBook/i.test(ua) || touchMac;
    const phoneUa = (nav.userAgentData && nav.userAgentData.mobile) || /iPhone|iPod|Android.*Mobile|Windows Phone|Mobi/i.test(ua);
    if (phoneUa) return 'phone';
    if (tabletUa) return 'tablet';
    const mq = (q) => typeof matchMedia === 'function' && matchMedia(q).matches;
    if (mq('(pointer: coarse)') && mq('(max-width: 1100px)')) return mq('(max-width: 640px)') ? 'phone' : 'tablet';
    return 'desktop';
  }
  /** 'phone' | 'tablet' | 'desktop', after the user's own override. */
  function deviceKind() {
    const pref = viewPreference();
    if (pref === 'desktop') return 'desktop';
    const d = detectedDevice();
    if (pref === 'mobile') return d === 'desktop' ? 'tablet' : d;
    return d;
  }
  const isMobile = () => deviceKind() !== 'desktop';

  /* ---- Calendar sync — one dialog for every page that offers it ----
   * A calendar app subscribes to the feed URL and re-fetches it itself, so
   * "Copy link" alone left people with a link and no idea where to put it,
   * and on a plain-http address the clipboard API does not exist at all.
   * This offers a one-tap subscribe for each common calendar, and a copy
   * that falls back to selecting the text. */
  async function calendarSync() {
    const host = document.createElement('div');
    const close = () => host.remove();
    host.innerHTML = `<div class="modal-back"><div class="modal" role="dialog" aria-label="Calendar sync"><h2>Calendar sync</h2><div class="content"><p class="dim">Loading…</p></div>
      <div class="foot"><button class="btn" data-cal="close">Close</button></div></div></div>`;
    document.body.appendChild(host);
    host.querySelector('[data-cal="close"]').onclick = close;
    host.querySelector('.modal-back').onclick = (e) => { if (e.target.classList.contains('modal-back')) close(); };
    const body = host.querySelector('.content');
    let feed = null;
    const paint = (which) => {
      const url = which === 'all' ? feed.all_url : feed.url;
      const webcal = url.replace(/^https?:/, 'webcal:');
      const name = encodeURIComponent(which === 'all' ? 'CCCS rota — all sites' : 'CCCS rota');
      // Only a control-role user with shifts of their own has two distinct
      // feeds to pick between — a dispatcher with no personal shifts, or a
      // field officer, only ever has the one (url falls back to all_url
      // server-side for the former), so there's nothing to toggle.
      const showToggle = feed.all_url && feed.url !== feed.all_url;
      body.innerHTML = `
        <p>Add ${which === 'all' ? 'the whole rota' : 'your rota'} to your calendar. It updates by itself when shifts change.</p>
        ${showToggle ? `<div class="btn-row" style="margin-bottom:10px">
          <button class="btn ${which !== 'all' ? 'primary' : ''}" data-cal="which" data-which="mine" type="button">My shifts</button>
          <button class="btn ${which === 'all' ? 'primary' : ''}" data-cal="which" data-which="all" type="button">Whole rota</button>
        </div>` : ''}
        <div class="cal-links">
          <a class="btn primary" href="${esc(webcal)}">iPhone, iPad or Mac calendar</a>
          <a class="btn" target="_blank" rel="noopener" href="https://outlook.office.com/calendar/0/addfromweb?url=${encodeURIComponent(url)}&name=${name}">Outlook (work account)</a>
          <a class="btn" target="_blank" rel="noopener" href="https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent(url)}&name=${name}">Outlook.com</a>
          <a class="btn" target="_blank" rel="noopener" href="https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}">Google Calendar</a>
        </div>
        <label style="margin-top:12px">Or copy the link into any calendar app ("subscribe" / "add from URL")</label>
        <input readonly data-cal="url" style="width:100%" value="${esc(url)}">
        <div class="btn-row" style="margin-top:8px">
          <button class="btn" data-cal="copy" type="button">Copy link</button>
          <button class="btn danger" data-cal="regen" type="button">Regenerate link</button>
        </div>
        <p class="dim" data-cal="msg" style="margin-top:8px">Anyone with this link can see ${which === 'all' ? 'the whole rota' : 'your rota'}, so don't share it. Google can take several hours to show changes.</p>`;
      const input = body.querySelector('[data-cal="url"]'), msg = body.querySelector('[data-cal="msg"]');
      input.onclick = () => input.select();
      body.querySelectorAll('[data-cal="which"]').forEach((b) => (b.onclick = () => paint(b.dataset.which)));
      body.querySelector('[data-cal="copy"]').onclick = async () => {
        try { await navigator.clipboard.writeText(input.value); msg.textContent = 'Copied.'; return; } catch {}
        input.focus(); input.select();
        let ok = false; try { ok = document.execCommand('copy'); } catch {}
        msg.textContent = ok ? 'Copied.' : 'The link is selected — copy it with your device\'s copy command.';
      };
      body.querySelector('[data-cal="regen"]').onclick = async () => {
        if (!confirm('The old link will stop working in any calendar already using it. Continue?')) return;
        try {
          const r = await api('POST', '/api/me/ical-feed/regenerate', which === 'all' ? { which: 'all' } : {});
          if (which === 'all') feed.all_url = r.url; else feed.url = r.url;
          paint(which);
          body.querySelector('[data-cal="msg"]').textContent = 'New link made — add it to your calendar again.';
        } catch (e) { msg.textContent = e.message; }
      };
    };
    try { feed = await api('GET', '/api/me/ical-feed'); paint(feed.all_url && feed.url === feed.all_url ? 'all' : 'mine'); }
    catch (e) { body.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  }

  return { api, send, outbox, sendSecure, secureOutbox, login, getSession, setSession, clearSession, applyTheme, bus, makeMap, push, navAnnouncer, navIcon, hhmmss, el, els, esc, requireAuth, deviceKind, detectedDevice, isMobile, viewPreference, setViewPreference, calendarSync };
})();
