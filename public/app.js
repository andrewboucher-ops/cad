/* CCCS shared client: auth, REST, WebSocket bus, SVG map. */
const CCCS = (() => {
  const KEY = 'cccs.session';
  let session = null;
  let expiredNotified = false; // see "Staying signed in" below
  try {
    session = JSON.parse(sessionStorage.getItem(KEY) || 'null')
      || JSON.parse(localStorage.getItem(KEY + '.mirror') || 'null');
  } catch { session = null; }

  // Also mirrored to localStorage, which — unlike sessionStorage — is shared
  // with windows opened via window.open(). That's what a GoldenLayout
  // "popout" panel is: without this, the new window has no session and its
  // auth check fails before it ever renders anything, i.e. a blank window.
  function setSession(s) {
    session = s; expiredNotified = false; sessionStorage.setItem(KEY, JSON.stringify(s)); try { localStorage.setItem(KEY + '.mirror', JSON.stringify(s)); } catch {} applyTheme(s && s.user && s.user.ui_prefs);
    syncSessionCookie();
    // The right person being signed in is itself a trigger: a secure item
    // left queued because it belonged to someone else may now be sendable,
    // independent of the 'online' event, which may have already fired
    // while the wrong person was still signed in on this device.
    flushSecureOutbox();
  }
  function clearSession() {
    session = null; sessionStorage.removeItem(KEY); try { localStorage.removeItem(KEY + '.mirror'); } catch {}
    clearSnapshots();
    if (typeof fetch === 'function' && document.documentElement) try { fetch('/api/auth/logout', { method: 'POST', keepalive: true }).catch(() => {}); } catch {}
  }
  /** Links to PDFs, photos and downloads carry no token in their address:
   * the server reads an HttpOnly cookie instead. This keeps that cookie on
   * the session this page holds (it follows the last sign-in on this
   * browser, as the localStorage mirror above already does). */
  let cookieReady = Promise.resolve();
  function syncSessionCookie() {
    if (!session || !session.token || typeof fetch !== 'function' || !document.documentElement) return; // not in the offline-outbox test harness
    try { cookieReady = fetch('/api/auth/session-cookie', { method: 'POST', headers: { authorization: `Bearer ${session.token}` } }).then(() => {}, () => {}); } catch {}
  }
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
  if (session) { applyTheme(session.user && session.user.ui_prefs); syncSessionCookie(); }

  async function api(method, path, body, opts = {}) {
    const res = await fetch(path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(session ? { authorization: `Bearer ${session.token}` } : {}),
        ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
        // A write replayed from the offline queue says when it was really
        // made, so a clock-out pressed in a dead spot is timed then, not
        // when signal came back (offline-time.js on the server).
        ...(opts.occurredAt ? { 'x-cccs-occurred-at': opts.occurredAt } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
    if (!res.ok) {
      const err = new Error((data && data.error) || `${res.status} ${res.statusText}`); err.status = res.status; if (data && data.code) err.code = data.code;
      if (res.status === 401 && session && !opts.noExpiryEvent) sessionExpired();
      throw err;
    }
    return data;
  }

  /* ---- Staying signed in -----------------------------------------------
     A session token lasts 8 hours; a security shift is often 12. Nothing
     used to renew it, so at hour 8 the live link was refused on every
     reconnect and every write failed — "link down" with full signal, and
     the only fix was signing out and in. Now an open page swaps its token
     for a fresh one (POST /api/auth/refresh) every half hour, whenever it
     comes back to the foreground, and whenever the link drops. If the
     session truly can't be renewed (signed out elsewhere, password reset,
     a week since sign-in), the page is told so it can ask the officer to
     sign in again — nothing queued is lost, it sends after. */
  const REFRESH_EVERY_MS = 30 * 60 * 1000;
  const expiredListeners = new Set();
  function sessionExpired() {
    if (expiredNotified) return;
    expiredNotified = true;
    expiredListeners.forEach((fn) => { try { fn(); } catch {} });
  }
  function tokenPayload(t) {
    try { const b = String(t).split('.')[0].replace(/-/g, '+').replace(/_/g, '/'); return JSON.parse(atob(b)); } catch { return null; }
  }
  let refreshing = null;
  /** Renews the session if it is due (or always, with force). Resolves
   * true when signed in with a usable token, false when the server said
   * the session is over, and null when the server couldn't be reached. */
  function refreshSession({ force = false } = {}) {
    if (!session || !session.token || typeof fetch !== 'function') return Promise.resolve(false);
    const p = tokenPayload(session.token);
    if (!force && p && p.iat && Date.now() - p.iat < REFRESH_EVERY_MS) return Promise.resolve(true);
    if (refreshing) return refreshing;
    refreshing = api('POST', '/api/auth/refresh', {}, { noExpiryEvent: true })
      .then((out) => { if (out && out.token && session) { setSession({ ...session, token: out.token, user: out.user || session.user }); expiredNotified = false; } return true; })
      .catch((e) => { if (e.status === 401) { sessionExpired(); return false; } return null; })
      .finally(() => { refreshing = null; });
    return refreshing;
  }
  if (typeof setInterval === 'function' && typeof document !== 'undefined' && document.documentElement) {
    setInterval(() => { refreshSession(); }, 5 * 60 * 1000);
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

  /* Writes that reached the server and were refused (a clock-out the
     server says already happened, a job that was closed meanwhile) are
     kept here with the reason, for the officer to see and dismiss —
     never silently thrown away. */
  const FAILED_KEY = 'cccs.outbox.failed';
  const failedListeners = new Set();
  function readFailed() { try { return JSON.parse(localStorage.getItem(FAILED_KEY) || '[]'); } catch { return []; } }
  function writeFailed(items) {
    try { localStorage.setItem(FAILED_KEY, JSON.stringify(items.slice(-50))); } catch {}
    failedListeners.forEach((fn) => fn(items));
  }
  function recordFailed(entry, e) {
    const { body, ...rest } = entry; // keep the label and when, not a photo
    writeFailed([...readFailed(), { ...rest, error: e.message || String(e), status: e.status || null, failed_at: new Date().toISOString() }]);
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
          await api(next.method, next.path, next.body, { idempotencyKey: next.key, occurredAt: next.at });
        } catch (e) {
          if (shouldWait(e)) break;              // no signal, server restarting, or signed out — keep the queue intact
          if (isRetryable(e) && (next.tries || 0) < MAX_SERVER_RETRIES) {
            writeOutbox(readOutbox().map((x) => (x.key === next.key ? { ...x, tries: (x.tries || 0) + 1 } : x)));
            break;
          }
          console.warn('queued write refused', next.path, e.message);
          recordFailed(next, e);
        }
        items = readOutbox().filter((x) => x.key !== next.key);
        writeOutbox(items);
      }
    } finally { flushing = false; }
  }

  const isOffline = (e) => e instanceof TypeError || /Failed to fetch|NetworkError|Load failed|network connection was lost/i.test(e.message || '');
  /* The server being briefly unreachable is not the same as it refusing
     the write: a deploy restarts CCCS (502/503 from the proxy for a few
     seconds), a busy minute can 429. Those are retried, a few times, not
     dropped. A 401 means the session ran out: wait for sign-in. */
  const MAX_SERVER_RETRIES = 30;
  const isRetryable = (e) => [408, 425, 429, 500, 502, 503, 504].includes(e.status);
  const shouldWait = (e) => isOffline(e) || e.status === 401;
  const shouldQueue = (e) => isOffline(e) || e.status === 401 || isRetryable(e);

  /** Write that survives losing signal: queued locally and replayed in order. */
  async function send(method, path, body, label) {
    const key = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
    const at = new Date().toISOString();
    try {
      return await api(method, path, body, { idempotencyKey: key });
    } catch (e) {
      if (!shouldQueue(e)) throw e;
      enqueue({ key, method, path, body, label: label || path, at });
      scheduleRetry();
      return { queued: true, key };
    }
  }

  /* 'online' alone is not enough: phones fire it unreliably, and it says
     nothing about a server that was restarting. While anything is queued,
     try again every 20 seconds as well. */
  let retryTimer = null;
  function scheduleRetry() {
    if (retryTimer || typeof setTimeout !== 'function') return;
    const t = retryTimer = setTimeout(async () => {
      retryTimer = null;
      await flushAll();
      let waiting = readOutbox().length;
      try { waiting += (await secureAll()).filter((x) => x.queued_by === myId() && !x.failed).length; } catch {}
      if (waiting) scheduleRetry();
    }, 20000);
    if (t && t.unref) t.unref(); // Node test harness only
  }
  async function flushAll() {
    if (session && session.token) await refreshSession();
    await flushOutbox();
    await flushSecureOutbox();
  }

  window.addEventListener('online', () => { flushAll(); });

  const outbox = {
    pending: () => readOutbox(),
    count: () => readOutbox().length,
    flush: flushOutbox,
    flushAll,
    onChange(fn) { outboxListeners.add(fn); fn(readOutbox().length); },
    clear() { writeOutbox([]); },
    failed: () => readFailed(),
    onFailed(fn) { failedListeners.add(fn); fn(readFailed()); },
    dismissFailed(key) { writeFailed(key ? readFailed().filter((x) => x.key !== key) : []); },
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
    items.sort((x, y) => String(x.at).localeCompare(String(y.at)));
    for (const item of items) {
      if (item.queued_by !== mine) continue; // someone else's — stays queued, never sent under this session
      if (item.failed) continue; // refused by the server — shown to the officer, not retried
      try {
        await api(item.method, item.path, item.body, { idempotencyKey: item.key, occurredAt: item.at });
        await secureDelete(item.key);
      } catch (e) {
        if (shouldWait(e)) break; // still down or signed out — keep the rest of the queue intact
        if (isRetryable(e) && (item.tries || 0) < MAX_SERVER_RETRIES) { await securePut({ ...item, tries: (item.tries || 0) + 1 }); break; }
        console.warn('queued secure write refused', item.path, e.message);
        // Kept (it may be a whole report the officer wrote), marked as
        // refused with the reason, until they look at it and dismiss it.
        await securePut({ ...item, failed: { error: e.message || String(e), status: e.status || null, at: new Date().toISOString() } });
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
    const at = new Date().toISOString();
    try {
      return await api(method, path, body, { idempotencyKey: key });
    } catch (e) {
      if (!shouldQueue(e)) throw e;
      const entry = { key, method, path, body, label: label || path, queued_by: myId(), at };
      try { await securePut(entry); } catch (e2) { throw e; } // IndexedDB unavailable too — surface the original offline error, nothing was queued
      notifySecure();
      scheduleRetry();
      return { queued: true, key };
    }
  }

  const waitingItems = (items) => items.filter((x) => !x.failed);
  const secureOutbox = {
    pending: () => secureAll().then(waitingItems).catch(() => []),
    count: () => secureAll().then((items) => waitingItems(items).length).catch(() => 0),
    mine: () => secureAll().then((items) => waitingItems(items).filter((x) => x.queued_by === myId()).length).catch(() => 0),
    othersWaiting: () => secureAll().then((items) => waitingItems(items).some((x) => x.queued_by !== myId())).catch(() => false),
    /** Refused by the server — this officer's only. */
    failed: () => secureAll().then((items) => items.filter((x) => x.failed && x.queued_by === myId())).catch(() => []),
    async dismissFailed(key) { try { const items = await secureAll(); for (const x of items) if (x.failed && x.queued_by === myId() && (!key || x.key === key)) await secureDelete(x.key); } catch {} notifySecure(); },
    flush: flushSecureOutbox,
    onChange(fn) { secureListeners.add(fn); secureAll().then(fn).catch(() => fn([])); },
  };

  /* ---- Saved copies for working offline --------------------------------
     A page reloaded with no signal used to come up empty: no shift, so no
     clock-out button, even though a clock-out can be queued. The officer
     app keeps a copy of its own shift, job and visit here (only this
     user's, removed at sign-out) and shows it, clearly marked as saved,
     when the server can't be reached. Reads through api() still fail
     honestly everywhere else. */
  const SNAP_PREFIX = 'cccs.snap.';
  const snapKey = (name) => `${SNAP_PREFIX}${(session && session.user && session.user.id) || 'anon'}.${name}`;
  function clearSnapshots() {
    try { for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k && k.startsWith(SNAP_PREFIX)) localStorage.removeItem(k); } } catch {}
  }
  const snapshot = {
    save(name, data) { try { const v = JSON.stringify({ at: new Date().toISOString(), data }); if (v.length < 500000) localStorage.setItem(snapKey(name), v); } catch {} },
    load(name) { try { return JSON.parse(localStorage.getItem(snapKey(name)) || 'null'); } catch { return null; } },
  };
  /** GET that falls back to the saved copy when the server can't be
   * reached. Returns { data, savedAt } — savedAt is null when live. */
  async function readThrough(name, path) {
    try {
      const data = await api('GET', path);
      snapshot.save(name, data);
      return { data, savedAt: null };
    } catch (e) {
      if (!shouldQueue(e)) throw e;
      const snap = snapshot.load(name);
      if (!snap) throw e;
      return { data: snap.data, savedAt: snap.at };
    }
  }

  /* ---- WebSocket bus with auto-reconnect ----------------------------
     Phones are hard on a live link: a tower handover, Wi-Fi to 4G, or the
     screen locking can leave a socket that looks open but is dead, and
     the browser may never report it closed. So the bus:
       - pings every 20 s and treats 45 s of silence as a dead link;
       - reconnects straight away when the phone comes back online, the
         app comes back to the foreground, or the page is shown again;
       - backs off to at most 10 s between attempts, and never gives up;
       - renews the session when the server keeps refusing the link, so an
         expired sign-in is fixed (or reported) instead of looping. */
  function bus(onStatus) {
    const handlers = new Map();
    const binaryHandlers = [];
    let ws = null, retry = 0, closed = false, timer = null, lastRx = 0, refused = 0, isUp = false, startedAt = 0;
    const PING_MS = 20000, DEAD_MS = 45000;
    const status = (up) => { isUp = up; onStatus && onStatus(up); };
    // The live link signs in with the HttpOnly cookie, which proxies leave
    // out of their logs. If the cookie turns out to be someone else's (a
    // different sign-in in another tab), it falls back to sending this tab's
    // token as a subprotocol: still never in the address.
    let viaProtocol = false;
    const queue = [];

    function connect() { timer = null; cookieReady.then(open); }
    function schedule(ms) {
      if (closed || timer) return;
      timer = setTimeout(connect, ms);
    }
    /** Drop whatever we have and reconnect now — used when the phone says
     * it is back, rather than waiting out the backoff. */
    function kick() {
      if (closed) return;
      if (ws && ws.readyState === 1 && Date.now() - lastRx < DEAD_MS) { try { ws.send(JSON.stringify({ type: 'ping', payload: {} })); } catch {} return; }
      if (ws && ws.readyState === 0 && Date.now() - startedAt < 15000) return; // still connecting — let it finish
      if (timer) { clearTimeout(timer); timer = null; }
      retry = 0;
      if (ws && ws.readyState <= 1) { const old = ws; ws = null; try { old.onclose = null; old.close(); } catch {} status(false); }
      connect();
    }
    function open() {
      if (closed) return;
      if (ws && ws.readyState <= 1) return; // already connecting or open
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      let sock;
      try {
        sock = viaProtocol && session ? new WebSocket(`${proto}://${location.host}/ws`, ['cccs', session.token]) : new WebSocket(`${proto}://${location.host}/ws`);
      } catch { retry = Math.min(retry + 1, 6); schedule(backoff()); return; }
      ws = sock; startedAt = Date.now();
      ws.binaryType = 'arraybuffer';
      let opened = false;
      ws.onopen = () => {
        if (ws !== sock) return;
        opened = true; retry = 0; refused = 0; lastRx = Date.now(); status(true);
        while (queue.length) ws.send(queue.shift());
        // Anything queued while the link was down goes now, not on the next timer.
        flushAll();
      };
      ws.onclose = () => {
        if (ws !== sock) return; // a socket we already replaced
        ws = null;
        if (!opened) { viaProtocol = true; refused++; } // refused: no cookie yet (or a blocked one)
        if (isUp || !opened) status(false);
        if (closed) return;
        retry = Math.min(retry + 1, 6);
        // Refused over and over with the network fine is what an expired
        // sign-in looks like: renew it (or let the page ask to sign in).
        if (refused >= 2 && refused % 2 === 0) refreshSession({ force: true }).then((ok) => { if (ok) viaProtocol = false; });
        schedule(backoff());
      };
      ws.onerror = () => { try { sock.close(); } catch {} };
      ws.onmessage = (e) => {
        lastRx = Date.now();
        // Raw PCM from a legacy handset's floor time (relayAudioFrame in
        // server.js) — JSON.parse would just throw and silently discard
        // this on every frame, which is exactly what happened before
        // binaryType/this check existed.
        if (e.data instanceof ArrayBuffer) { binaryHandlers.forEach((fn) => fn(e.data)); return; }
        let msg; try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === 'hello' && !viaProtocol && msg.payload && msg.payload.user && session && session.user && msg.payload.user.id !== session.user.id) {
          viaProtocol = true; try { ws.close(); } catch {} return;
        }
        (handlers.get(msg.type) || []).forEach((fn) => fn(msg.payload, msg));
        (handlers.get('*') || []).forEach((fn) => fn(msg.payload, msg));
      };
    }
    const backoff = () => Math.min(10000, 500 * 2 ** (retry - 1)) * (0.75 + Math.random() * 0.5);
    // Heartbeat: the server answers 'ping' with 'pong'; silence means dead.
    if (typeof setInterval === 'function') setInterval(() => {
      if (closed || !ws) return;
      if (ws.readyState === 0 && Date.now() - startedAt > 15000) { kick(); return; } // a connect that hangs
      if (ws.readyState !== 1) return;
      if (Date.now() - lastRx > DEAD_MS) { kick(); return; }
      try { ws.send(JSON.stringify({ type: 'ping', payload: {} })); } catch {}
    }, PING_MS);
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('online', kick);
      window.addEventListener('pageshow', kick);
      window.addEventListener('focus', kick);
    }
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { refreshSession(); kick(); } });
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
      isUp: () => isUp,
      reconnect: kick,
      close() { closed = true; if (timer) clearTimeout(timer); try { ws.close(); } catch {} },
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

    /* OSM refuses tiles ("Access blocked") when the request carries no
     * Referer, and our pages send none cross-origin (Referrer-Policy is
     * same-origin / no-referrer). The tiles alone send just the site origin,
     * never the path or any ?token=. OSM also asks for the single host, not
     * the old a/b/c subdomains. */
    const streetLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      pane: 'street', maxZoom: 19, referrerPolicy: 'strict-origin',
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

  return { api, send, outbox, sendSecure, secureOutbox, snapshot, readThrough, refreshSession, onSessionExpired(fn) { expiredListeners.add(fn); }, login, getSession, setSession, clearSession, applyTheme, bus, makeMap, push, navAnnouncer, navIcon, hhmmss, el, els, esc, requireAuth, deviceKind, detectedDevice, isMobile, viewPreference, setViewPreference, calendarSync };
})();
