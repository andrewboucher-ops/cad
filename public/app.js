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
  function setSession(s) { session = s; sessionStorage.setItem(KEY, JSON.stringify(s)); try { localStorage.setItem(KEY + '.mirror', JSON.stringify(s)); } catch {} }
  function clearSession() { session = null; sessionStorage.removeItem(KEY); try { localStorage.removeItem(KEY + '.mirror'); } catch {} }
  function getSession() { return session; }

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
    if (!res.ok) throw new Error((data && data.error) || `${res.status} ${res.statusText}`);
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

  /* ---- Hardware key bindings -------------------------------------------
     Rugged handsets disagree about which keycode a button sends, so bindings
     are learned on the device rather than compiled in. The Android shell
     forwards every key it sees as a `cccs:key` window event; in a plain
     browser the same code path handles KeyboardEvent.code. Either way a new
     handset means pressing a button in Settings, not a new APK.

     Long-press actions follow normal keypad convention:
       1  held → request a call from control
       #  held → priority call request
       *  held → lock the keypad and screen (hold again to unlock)
     Defaults are the Android keycodes for those keys. On a handset with no
     keypad they simply never fire, and `hasHardwareKeys` reports false so the
     UI can offer the same actions on screen instead.                        */
  const ACTIONS = ['ptt', 'sos', 'call', 'priority', 'lock', 'redial', 'talkgroup', 'status', 'covert', 'position'];

  /* Android keycode for each keypad character, so bindings can be shown and
     reasoned about as "keypad 5" rather than "device key 12". */
  const KEYPAD = { 0: 7, 1: 8, 2: 9, 3: 10, 4: 11, 5: 12, 6: 13, 7: 14, 8: 15, 9: 16, '*': 17, '#': 18 };
  const KEYPAD_BY_CODE = Object.fromEntries(Object.entries(KEYPAD).map(([k, v]) => [v, k]));
  /** The keypad character a token represents, or null. Works on device and desktop. */
  function keypadChar(token) {
    if (!token) return null;
    if (token.startsWith('android:')) return KEYPAD_BY_CODE[Number(token.split(':')[1])] ?? null;
    const m = /^Digit(\d)$|^Numpad(\d)$/.exec(token);
    return m ? (m[1] ?? m[2]) : null;
  }
  const KEYS_DEFAULT = {
    ptt: 'Space',
    sos: null,
    // Long-press keypad actions, following common PMR convention.
    call: 'android:8',        // hold 1  — request a call from control
    priority: 'android:18',   // hold #  — priority call request
    lock: 'android:17',       // hold *  — lock keypad and screen
    redial: 'android:7',      // hold 0  — call back the last party
    talkgroup: 'android:9',   // hold 2  — talkgroup selector
    status: 'android:10',     // hold 3  — send a status code
    covert: 'android:12',     // hold 5  — covert mode
    position: 'android:15',   // hold 8  — send a position report
    sosHoldMs: 2000,
    holdMs: 800,
    speedDial: {},            // keypad character -> { type, target, label }
  };
  const KEYS_STORE = 'cccs.keys';
  const SEEN_KEYS = 'cccs.sawHardwareKey';

  function loadKeys() {
    try { return { ...KEYS_DEFAULT, ...JSON.parse(localStorage.getItem(KEYS_STORE) || '{}') }; }
    catch { return { ...KEYS_DEFAULT }; }
  }
  function saveKeys(next) {
    localStorage.setItem(KEYS_STORE, JSON.stringify({ ...loadKeys(), ...next }));
  }

  /**
   * @param handlers {
   *   onPtt(pressed), onSos(), onSosArming(ms), onSosCancelled(),
   *   onAction(name), onActionArming(name, ms), onActionCancelled(name),
   *   onLearn(which, token)
   * }
   */
  function keybinds(handlers = {}) {
    let keys = loadKeys();
    let learning = null;
    let pttHeld = false;
    const timers = new Map();     // action -> timeout while the key is held

    const holdFor = (action) => (action === 'sos' ? keys.sosHoldMs : keys.holdMs);
    const which = (token) => ACTIONS.find((a) => keys[a] && token === keys[a]) || null;

    function arm(action) {
      if (timers.has(action)) return;
      const ms = holdFor(action);
      if (action === 'sos') handlers.onSosArming && handlers.onSosArming(ms);
      else handlers.onActionArming && handlers.onActionArming(action, ms);
      timers.set(action, setTimeout(() => {
        timers.delete(action);
        firedLong = true;
        if (action === 'sos') handlers.onSos && handlers.onSos();
        else handlers.onAction && handlers.onAction(action);
      }, ms));
    }
    function disarm(action) {
      const t = timers.get(action);
      if (!t) return false;
      clearTimeout(t); timers.delete(action);
      if (action === 'sos') handlers.onSosCancelled && handlers.onSosCancelled();
      else handlers.onActionCancelled && handlers.onActionCancelled(action);
      return true;
    }

    let pressedToken = null, pressedAt = 0, firedLong = false;

    const down = (token, repeat) => {
      if (!repeat) { pressedToken = token; pressedAt = Date.now(); firedLong = false; }
      if (learning) {
        const target = learning; learning = null;
        saveKeys({ [target]: token }); keys = loadKeys();
        handlers.onLearn && handlers.onLearn(target, token);
        return true;
      }
      const action = which(token);
      if (!action) return false;
      if (action === 'ptt') {
        if (!repeat && !pttHeld) { pttHeld = true; handlers.onPtt && handlers.onPtt(true); }
        return true;
      }
      // Held, not tapped — a key brushed in a pocket should not call control,
      // and certainly should not raise an SOS.
      if (!repeat) arm(action);
      return true;
    };
    const up = (token) => {
      const action = which(token);
      const wasShort = token === pressedToken && !firedLong;
      if (action === 'ptt') {
        if (pttHeld) { pttHeld = false; handlers.onPtt && handlers.onPtt(false); }
        pressedToken = null;
        return true;
      }
      if (action) disarm(action);
      // A tap is a different gesture from a hold: on a keypad radio, tapping a
      // digit speed-dials and holding it runs the action bound to that key.
      if (wasShort) {
        const ch = keypadChar(token);
        if (ch !== null) handlers.onTap && handlers.onTap(ch, token);
      }
      pressedToken = null;
      return Boolean(action);
    };

    document.addEventListener('keydown', (e) => { if (down(e.code, e.repeat)) e.preventDefault(); });
    document.addEventListener('keyup', (e) => { if (up(e.code)) e.preventDefault(); });
    window.addEventListener('cccs:key', (e) => {
      const d = e.detail || {};
      try { localStorage.setItem(SEEN_KEYS, '1'); } catch {}
      const token = `android:${d.keyCode}`;
      if (d.pressed) down(token, d.repeat); else up(token);
    });

    return {
      actions: ACTIONS,
      get bindings() { return loadKeys(); },
      /** False until this handset has actually sent a hardware key. */
      get hasHardwareKeys() { try { return localStorage.getItem(SEEN_KEYS) === '1'; } catch { return false; } },
      learn(action) { learning = action; },
      cancelLearn() { learning = null; },
      set(action, token) { saveKeys({ [action]: token }); keys = loadKeys(); },
      setHold(ms) { saveKeys({ sosHoldMs: ms }); keys = loadKeys(); },
      setActionHold(ms) { saveKeys({ holdMs: ms }); keys = loadKeys(); },
      keypadChar,
      get speedDial() { return loadKeys().speedDial || {}; },
      setSpeedDial(ch, entry) {
        const map = { ...(loadKeys().speedDial || {}) };
        if (entry) map[ch] = entry; else delete map[ch];
        saveKeys({ speedDial: map }); keys = loadKeys();
      },
      label(token) {
        if (!token) return 'not set';
        const ch = keypadChar(token);
        if (ch !== null) return `keypad ${ch}`;
        if (token.startsWith('android:')) return `device key ${token.split(':')[1]}`;
        return token.replace(/^Key|^Digit/, '');
      },
    };
  }

  /* ---- WebSocket bus with auto-reconnect ---- */
  function bus(onStatus) {
    const handlers = new Map();
    let ws = null, retry = 0, closed = false;
    const queue = [];

    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(session.token)}`);
      ws.onopen = () => { retry = 0; onStatus && onStatus(true); while (queue.length) ws.send(queue.shift()); };
      ws.onclose = () => {
        onStatus && onStatus(false);
        if (closed) return;
        retry = Math.min(retry + 1, 6);
        setTimeout(connect, 400 * retry);
      };
      ws.onerror = () => { try { ws.close(); } catch {} };
      ws.onmessage = (e) => {
        let msg; try { msg = JSON.parse(e.data); } catch { return; }
        (handlers.get(msg.type) || []).forEach((fn) => fn(msg.payload, msg));
        (handlers.get('*') || []).forEach((fn) => fn(msg.payload, msg));
      };
    }
    connect();
    return {
      on(type, fn) { handlers.set(type, [...(handlers.get(type) || []), fn]); return this; },
      send(type, payload) {
        const frame = JSON.stringify({ type, payload });
        if (ws && ws.readyState === 1) ws.send(frame); else queue.push(frame);
      },
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
   * actual roads and landmarks. Esri's Dark Gray Canvas is an actual dark
   * basemap (not a CSS filter hack over light tiles) and needs no API key.
   */
  function makeMap(container, opts = {}) {
    if (typeof L === 'undefined') throw new Error('Leaflet is not loaded — include leaflet.js before app.js');
    container.innerHTML = '';
    const mapDiv = document.createElement('div');
    mapDiv.style.cssText = 'width:100%;height:100%';
    container.appendChild(mapDiv);

    const map = L.map(mapDiv, { attributionControl: true, preferCanvas: true })
      .setView(opts.center || [53.6152, -0.2210], opts.zoom || 12); // default: Immingham

    // Two free base layers, no API key or billing for either. Dark Gray for
    // the ops room; Light Gray for bright vehicle screens (opts.theme) — same
    // free Esri service family as the satellite layer below.
    map.createPane('street').style.zIndex = 200;
    map.createPane('satellite').style.zIndex = 200;

    const canvasName = opts.theme === 'light' ? 'World_Light_Gray' : 'World_Dark_Gray';
    const streetLayer = L.layerGroup([
      L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${canvasName}_Base/MapServer/tile/{z}/{y}/{x}`, {
        pane: 'street', maxZoom: 16, maxNativeZoom: 16,
        attribution: '&copy; <a href="https://www.esri.com">Esri</a>',
      }),
      L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${canvasName}_Reference/MapServer/tile/{z}/{y}/{x}`, {
        pane: 'street', maxZoom: 16, maxNativeZoom: 16,
      }),
    ]);
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
          this._routing.on('routesfound', (e) => onSummary && e.routes[0] && onSummary(e.routes[0].summary));
        }
        this._routing.setWaypoints([L.latLng(from[0], from[1]), L.latLng(to[0], to[1])]);
      },
      clearRoute() { if (this._routing) this._routing.setWaypoints([]); },
      invalidateSize() { map.invalidateSize(); },
    };
  }

  /* ---- WebRTC audio ----------------------------------------------------
     Real media. The floor holder (or the caller) publishes to each listener
     over a peer connection; listeners receive only. Mesh is fine for one
     talker fanning out to a handful of listeners, which is what PTT is.
     Past roughly a dozen listeners per talkgroup, put an SFU in the middle —
     `publishTo` is the seam where that swaps in.                          */
  function audio(bus) {
    const peers = new Map();      // peer address -> RTCPeerConnection
    const sinks = new Map();      // peer address -> <audio>
    let config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
    let mic = null;
    let onLevel = null;

    // "Repeat" — only one talkgroup transmission is ever live at a time
    // (the server enforces one floor holder), so recording whichever
    // incoming stream is currently active is enough; no per-speaker
    // bookkeeping needed.
    let lastIncomingStream = null, recorder = null, recordedChunks = [], lastRecordingBlob = null;
    function beginRecording() {
      if (!lastIncomingStream || recorder) return;
      try {
        recordedChunks = [];
        recorder = new MediaRecorder(lastIncomingStream);
        recorder.ondataavailable = (e) => { if (e.data.size) recordedChunks.push(e.data); };
        recorder.start();
      } catch (e) { recorder = null; console.warn('[cccs] could not record transmission:', e.message); }
    }
    function endRecording() {
      if (!recorder) return;
      const r = recorder; recorder = null;
      r.onstop = () => { if (recordedChunks.length) lastRecordingBlob = new Blob(recordedChunks, { type: r.mimeType || 'audio/webm' }); };
      try { r.stop(); } catch {}
    }
    function playLastRecording() {
      if (!lastRecordingBlob) return false;
      new Audio(URL.createObjectURL(lastRecordingBlob)).play().catch((e) => console.warn('[cccs] repeat playback failed:', e.message));
      return true;
    }

    api('GET', '/api/config').then((c) => { if (c.iceServers) config = { iceServers: c.iceServers }; }).catch(() => {});

    async function getMic() {
      if (mic) return mic;
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      return mic;
    }
    function releaseMic() {
      if (!mic) return;
      mic.getTracks().forEach((t) => t.stop());
      mic = null;
    }
    function sinkFor(addr) {
      if (sinks.has(addr)) return sinks.get(addr);
      const a = document.createElement('audio');
      a.autoplay = true; a.style.display = 'none';
      document.body.appendChild(a);
      sinks.set(addr, a);
      return a;
    }
    function newPeer(addr) {
      const pc = new RTCPeerConnection(config);
      pc.onicecandidate = (e) => {
        if (e.candidate) bus.send('webrtc.signal', { to: addr, data: { candidate: e.candidate } });
      };
      pc.ontrack = (e) => {
        const sink = sinkFor(addr);
        sink.srcObject = e.streams[0];
        // autoplay="" alone can be silently blocked (no error anywhere in the
        // UI) — force play() and surface a failure instead of dead silence.
        sink.play().catch((err) => { if (onLevel) onLevel(addr, 'blocked'); console.warn(`[cccs] audio playback blocked for ${addr}:`, err.message); });
        if (onLevel) onLevel(addr, true);
        lastIncomingStream = e.streams[0];
      };
      pc.onconnectionstatechange = () => {
        if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) drop(addr);
      };
      peers.set(addr, pc);
      return pc;
    }
    function drop(addr) {
      const pc = peers.get(addr);
      if (pc) { try { pc.close(); } catch {} peers.delete(addr); }
      const sink = sinks.get(addr);
      if (sink) { sink.srcObject = null; sink.remove(); sinks.delete(addr); }
      if (onLevel) onLevel(addr, false);
    }

    async function publishTo(addresses) {
      const stream = await getMic();
      for (const addr of addresses) {
        if (peers.has(addr)) continue;
        const pc = newPeer(addr);
        stream.getTracks().forEach((t) => pc.addTrack(t, stream));
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        bus.send('webrtc.signal', { to: addr, data: { sdp: pc.localDescription } });
      }
    }
    function stopPublishing() {
      [...peers.keys()].forEach(drop);
      releaseMic();
    }

    bus.on('webrtc.signal', async ({ from, data }) => {
      try {
        if (data.sdp) {
          let pc = peers.get(from);
          if (data.sdp.type === 'offer') {
            if (!pc) pc = newPeer(from);
            await pc.setRemoteDescription(data.sdp);
            // Two-way for calls, receive-only for talkgroup traffic: if we
            // already hold a mic (we are in a call), send it back.
            if (mic) mic.getTracks().forEach((t) => pc.addTrack(t, mic));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            bus.send('webrtc.signal', { to: from, data: { sdp: pc.localDescription } });
          } else if (pc) {
            await pc.setRemoteDescription(data.sdp);
          }
        } else if (data.candidate) {
          const pc = peers.get(from);
          if (pc) await pc.addIceCandidate(data.candidate).catch(() => {});
        }
      } catch (e) { console.warn('webrtc signal failed', e); }
    });

    return {
      publishTo, stopPublishing, drop, getMic, releaseMic,
      beginRecording, endRecording, playLastRecording,
      /** Two-way audio for a private call. */
      async call(addr) {
        const stream = await getMic();
        if (peers.has(addr)) return;
        const pc = newPeer(addr);
        stream.getTracks().forEach((t) => pc.addTrack(t, stream));
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        bus.send('webrtc.signal', { to: addr, data: { sdp: pc.localDescription } });
      },
      hangUp() { stopPublishing(); },
      set onPeerAudio(fn) { onLevel = fn; },
      get peerCount() { return peers.size; },
    };
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

  return { api, send, outbox, keybinds, login, getSession, setSession, clearSession, bus, audio, makeMap, push, hhmmss, el, els, esc, requireAuth };
})();
