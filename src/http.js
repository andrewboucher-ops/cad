
/* ------------------------------------------------------------------ *
 * HTTP plumbing
 * ------------------------------------------------------------------ */
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

const routes = [];
const route = (method, pattern, roles, handler) => {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, regex, keys, roles, handler });
};

/* Replay protection. An MDT that went offline mid-shift resends its queued
 * writes on reconnect, and may resend the same one twice if the reply was lost.
 * Keyed replies are cached briefly so a repeat is answered, not re-applied. */
const idempotency = new Map();
const IDEMPOTENCY_TTL_MS = Number(process.env.IDEMPOTENCY_TTL_MS || 30 * 60 * 1000);

function idempotencyGet(key) {
  const hit = idempotency.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > IDEMPOTENCY_TTL_MS) { idempotency.delete(key); return null; }
  return hit;
}
function idempotencyPut(key, status, body) {
  idempotency.set(key, { at: Date.now(), status, body });
  if (idempotency.size > 5000) idempotency.delete(idempotency.keys().next().value);
}

const rate = new Map();
function rateLimit(ip) {
  const now = Date.now();
  const win = rate.get(ip) || { start: now, count: 0 };
  if (now - win.start > 60000) { win.start = now; win.count = 0; }
  win.count++; rate.set(ip, win);
  return win.count <= 600;
}

function authFrom(req, url) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token');
  const payload = verifyToken(token);
  if (!payload) return null;
  return db.users.find((u) => u.id === payload.sub) || null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.apk': 'application/vnd.android.package-archive',
};

const requestHandler = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const send = (status, body, headers = {}) => {
    const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(payload);
  };

  if (url.pathname.startsWith('/api/')) {
    const ip = req.socket.remoteAddress || 'unknown';
    if (!rateLimit(ip)) return send(429, { error: 'rate limit exceeded' });
    let body = {};
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
      const chunks = [];
      let size = 0;
      // 1MB is plenty for every route except on-scene photo uploads (base64
      // JSON, ~33% larger than the source file) — raised to accommodate a
      // real phone photo rather than adding a second, route-specific limit.
      for await (const c of req) { size += c.length; if (size > 9e6) { return send(413, { error: 'payload too large' }); } chunks.push(c); }
      const raw = Buffer.concat(chunks).toString();
      if (raw) { try { body = JSON.parse(raw); } catch { return send(400, { error: 'invalid JSON body' }); } }
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.regex.exec(url.pathname);
      if (!m) continue;
      const params = {}; r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      let user = null;
      if (r.roles) {
        user = authFrom(req, url);
        if (!user) return send(401, { error: 'authentication required' });
        if (r.roles.length && !r.roles.includes(user.role)) return send(403, { error: 'insufficient role' });
      }
      const idemKey = req.headers['idempotency-key'];
      if (idemKey && user) {
        const cached = idempotencyGet(`${user.id}:${idemKey}`);
        if (cached) return send(cached.status, cached.body, { 'idempotent-replay': 'true' });
      }
      try {
        const out = await r.handler({ params, body, query: url.searchParams, user, req });
        const status = out && out.__status ? out.__status : 200;
        const payload = out && out.__body !== undefined ? out.__body : out;
        const extraHeaders = (out && out.__headers) || {};
        if (idemKey && user) idempotencyPut(`${user.id}:${idemKey}`, status, payload);
        return send(status, payload, extraHeaders);
      } catch (e) {
        if (!e.status) console.error('[cccs]', e);
        return send(e.status || 500, { error: e.message || 'internal error' });
      }
    }
    return send(404, { error: 'no such endpoint' });
  }

  // static files
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(__dirname, 'public', path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(path.join(__dirname, 'public'))) return send(403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(404, 'Not found', { 'content-type': 'text/plain' });
    send(200, data, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  });
};

const server = http.createServer(requestHandler);

// Direct HTTPS/WSS listener for clients that reach this host over IPv6
// (bypassing the IPv4-only edge proxy — see the certbot setup this was
// provisioned alongside). Only created when a certificate actually exists,
// so a fresh checkout without one still runs fine on plain HTTP behind the
// edge exactly as before.
const TLS_CERT_DIR = process.env.TLS_CERT_DIR || `/etc/letsencrypt/live/${process.env.TLS_DOMAIN || 'comms.echeloncic.com'}`;
let httpsServer = null;
try {
  const tlsOptions = {
    cert: fs.readFileSync(path.join(TLS_CERT_DIR, 'fullchain.pem')),
    key: fs.readFileSync(path.join(TLS_CERT_DIR, 'privkey.pem')),
  };
  httpsServer = https.createServer(tlsOptions, requestHandler);
  // Handshake failures never reach the request handler, so without this an
  // old client (e.g. Android 4.4 handsets) that can't negotiate just looks
  // like nothing happened server-side.
  httpsServer.on('tlsClientError', (err, sock) => console.warn(`[cccs] TLS handshake failed from ${sock && sock.remoteAddress}: ${err.message}`));
} catch {
  // No certificate on disk — direct HTTPS stays off, edge-proxied HTTP is unaffected.
}

function handleUpgrade(req, socket) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') return socket.destroy();
  const user = authFrom(req, url);
  const key = req.headers['sec-websocket-key'];
  if (!user || !key) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${wsAccept(key)}`, '\r\n'].join('\r\n'));
  socket.setNoDelay(true);
  const conn = new Conn(socket, user);
  conn.send('hello', { user: { id: user.id, username: user.username, role: user.role, display_name: user.display_name, personnel_id: user.personnel_id, mdt_id: user.mdt_id, ui_prefs: normalizeUiPrefs(user.ui_prefs) } });
}
server.on('upgrade', handleUpgrade);
httpsServer?.on('upgrade', handleUpgrade);
