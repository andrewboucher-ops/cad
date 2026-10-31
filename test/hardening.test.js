/* Second round of security hardening — node --test
 *
 * Pages carry a Content-Security-Policy; the session travels as an HttpOnly
 * cookie (read for GET and the WebSocket only) so links need no ?token=;
 * the WebSocket takes its token as a subprotocol and refuses other sites;
 * lockout is per username and address; common passwords are refused;
 * openapi.json is admin-only; FINANCE misses untargeted live traffic;
 * removing an account closes its live connections; officers can swap the
 * date of birth on the welfare call for a PIN; and integration routes can
 * be limited to known addresses. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const crypto = require('node:crypto');

process.env.PORT = '4065';
process.env.AUTH_SECRET = 'hardening-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';
process.env.INTEGRATION_ALLOWED_IPS = '10.0.0.0/8';

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;

async function call(method, path, body, token, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, headers: res.headers };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;

/** Raw upgrade: resolves { status, head, socket } once the response head is in. */
function upgrade({ path = '/ws', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(process.env.PORT), '127.0.0.1', () => {
      const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${process.env.PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`);
    });
    let buf = '';
    const onData = (d) => {
      buf += d.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      sock.off('data', onData);
      resolve({ status: Number(buf.split(' ')[1]), head: buf.slice(0, end), socket: sock });
    };
    sock.on('data', onData);
    sock.on('error', reject);
  });
}
const closed = (sock, ms = 2000) => new Promise((resolve) => {
  if (sock.destroyed) return resolve(true);
  const t = setTimeout(() => resolve(false), ms);
  sock.on('close', () => { clearTimeout(t); resolve(true); });
});

let adminT;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

test('pages carry a Content-Security-Policy that only runs CCCS\'s own scripts; API responses and files do not', async () => {
  const page = await fetch(`${BASE}/control.html`);
  const csp = page.headers.get('content-security-policy');
  assert.ok(csp, 'pages have one');
  assert.match(csp, /script-src 'self' 'unsafe-inline'(;|$)/, 'no CDN scripts');
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /base-uri 'self'/);
  assert.strictEqual((await fetch(`${BASE}/api/auth/microsoft/status`)).headers.get('content-security-policy'), null);
  const html = await page.text();
  assert.doesNotMatch(html, /unpkg\.com|cdnjs|jsdelivr/, 'map libraries come from /vendor');
  assert.strictEqual((await fetch(`${BASE}/vendor/leaflet/leaflet.js`)).status, 200);
  assert.strictEqual((await fetch(`${BASE}/vendor/jsQR.js`)).status, 200);
  assert.strictEqual((await fetch(`${BASE}/vendor/qrcode.min.js`)).status, 200);
});

test('sign-in sets an HttpOnly SameSite=Strict cookie that works for GET but never on its own for a change', async () => {
  const res = await call('POST', '/api/auth/login', { username: 'dispatcher', password: 'dispatch123' });
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /^cccs_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+/);
  const jar = cookie.split(';')[0];
  assert.strictEqual((await call('GET', '/api/me', undefined, null, { cookie: jar })).status, 200, 'a link to a PDF or photo needs no token');
  assert.strictEqual((await call('POST', '/api/jobs', { incident_type: 'TEST', location: 'x' }, null, { cookie: jar })).status, 401, 'a change still needs the Bearer header');
  const out = await call('POST', '/api/auth/logout');
  assert.match(out.headers.get('set-cookie'), /^cccs_session=; .*Max-Age=0/);
  // A page signed in before the cookie existed gets one from its Bearer session.
  const synced = await call('POST', '/api/auth/session-cookie', {}, res.body.token);
  assert.strictEqual(synced.status, 200);
  assert.match(synced.headers.get('set-cookie'), /HttpOnly/);
  assert.strictEqual((await call('POST', '/api/auth/session-cookie', {})).status, 401);
});

test('the WebSocket takes its token as a subprotocol and refuses a page on another site', async () => {
  const token = await login('dispatcher', 'dispatch123');
  const ok = await upgrade({ headers: { 'Sec-WebSocket-Protocol': `cccs, ${token}`, Origin: `http://127.0.0.1:${process.env.PORT}` } });
  assert.strictEqual(ok.status, 101);
  assert.match(ok.head, /Sec-WebSocket-Protocol: cccs/);
  ok.socket.destroy();
  const foreign = await upgrade({ headers: { 'Sec-WebSocket-Protocol': `cccs, ${token}`, Origin: 'https://evil.example' } });
  assert.strictEqual(foreign.status, 403);
  foreign.socket.destroy();
  const cookieOnly = await upgrade({ headers: { cookie: `cccs_session=${encodeURIComponent(token)}`, Origin: `http://127.0.0.1:${process.env.PORT}` } });
  assert.strictEqual(cookieOnly.status, 101, 'same-site page riding the cookie is fine');
  cookieOnly.socket.destroy();
});

test('lockout is per username and address: a guesser elsewhere does not lock the real user out', async () => {
  await call('POST', '/api/users', { username: 'lock-me', password: 'quiet-meadow-81', role: 'DISPATCHER' }, adminT);
  const attacker = { 'x-real-ip': '198.51.100.7' };
  for (let i = 0; i < 5; i++) await call('POST', '/api/auth/login', { username: 'lock-me', password: 'wrong' }, null, attacker);
  assert.strictEqual((await call('POST', '/api/auth/login', { username: 'lock-me', password: 'quiet-meadow-81' }, null, attacker)).status, 429, 'the guessing address is locked');
  assert.strictEqual((await call('POST', '/api/auth/login', { username: 'lock-me', password: 'quiet-meadow-81' }, null, { 'x-real-ip': '203.0.113.20' })).status, 200, 'the real user elsewhere is not');
});

test('common passwords and ones containing the username are refused', async () => {
  for (const password of ['password123', 'Password1', '11111111', 'qwerty123']) {
    const r = await call('POST', '/api/users', { username: `weak-${crypto.randomBytes(3).toString('hex')}`, password, role: 'DISPATCHER' }, adminT);
    assert.strictEqual(r.status, 400, password);
  }
  assert.strictEqual((await call('POST', '/api/users', { username: 'jsmith', password: 'jsmith2026!', role: 'DISPATCHER' }, adminT)).status, 400);
  assert.strictEqual((await call('POST', '/api/users', { username: 'okpass', password: 'harbour-lantern-7', role: 'DISPATCHER' }, adminT)).status, 201);
});

test('openapi.json is for admins only', async () => {
  assert.strictEqual((await call('GET', '/api/openapi.json')).status, 401);
  assert.strictEqual((await call('GET', '/api/openapi.json', undefined, await login('dispatcher', 'dispatch123'))).status, 403);
  assert.strictEqual((await call('GET', '/api/openapi.json', undefined, adminT)).status, 200);
});

test('FINANCE does not receive untargeted live traffic, and deleting an account closes its open connections', async () => {
  await call('POST', '/api/users', { username: 'fin-live', password: 'ledger-river-42', role: 'FINANCE' }, adminT);
  const finT = await login('fin-live', 'ledger-river-42');
  const fin = await upgrade({ headers: { 'Sec-WebSocket-Protocol': `cccs, ${finT}` } });
  assert.strictEqual(fin.status, 101);
  const frames = [];
  fin.socket.on('data', (d) => frames.push(d.toString('latin1')));
  await new Promise((r) => setTimeout(r, 100));
  app.broadcast('job.created', { id: 1, reference: 'UNTARGETED-TEST' }); // untargeted: everyone internal but FINANCE
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!frames.join('').includes('UNTARGETED-TEST'), 'finance did not get it');

  const finUser = app.db.users.find((u) => u.username === 'fin-live');
  const done = closed(fin.socket);
  assert.strictEqual((await call('DELETE', `/api/users/${finUser.id}`, undefined, adminT)).status, 200);
  assert.ok(await done, 'the socket was closed');
});

test('an officer can replace the date of birth on the welfare call with a PIN; the answer is never handed out', async () => {
  const danT = await login('dwhitfield', 'field123');
  const me = (await call('GET', '/api/me', undefined, danT)).body;
  const p = app.db.personnel.find((x) => x.id === me.personnel_id);
  p.date_of_birth = '1985-06-15';
  assert.strictEqual((await call('PUT', '/api/me/welfare-pin', { pin: '1234' }, danT)).status, 400, 'too easy');
  assert.strictEqual((await call('PUT', '/api/me/welfare-pin', { pin: '15061985' }, danT)).status, 400, 'date of birth');
  assert.strictEqual((await call('PUT', '/api/me/welfare-pin', { pin: '12a4' }, danT)).status, 400);
  assert.strictEqual((await call('PUT', '/api/me/welfare-pin', { pin: '583921' }, danT)).status, 200);
  assert.ok(p.welfare_pin_hash && !String(p.welfare_pin_hash).includes('583921'), 'stored hashed');
  assert.strictEqual((await call('GET', `/api/personnel/${p.id}`, undefined, adminT)).body.welfare_pin_hash, undefined);

  // The PBX's calls come from the allowed range in production; this test sets 10.0.0.0/8.
  const pbx = { 'x-real-ip': '10.1.2.3' };
  const shift = { id: 990001, site_id: null, starts_at: new Date(Date.now() - 3600e3).toISOString(), ends_at: new Date(Date.now() + 3600e3).toISOString() };
  app.db.shifts.push(shift);
  const a = { id: 990001, shift_id: shift.id, personnel_id: p.id, clocked_in_at: new Date().toISOString(), welfare_checkcall_token: 'tok-pin', welfare_checkcall_sent_at: new Date().toISOString() };
  app.db.shift_assignments.push(a);
  const got = await call('GET', '/api/welfare-checkcall/tok-pin', undefined, null, pbx);
  assert.deepStrictEqual(got.body, { first_name: p.name.split(/\s+/)[0], uses_pin: true });
  const verify = (digits) => fetch(`${BASE}/api/welfare-checkcall/tok-pin/verify`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...pbx }, body: `digits=${digits}` }).then((r) => r.text());
  assert.strictEqual(await verify('15061985'), 'RETRY', 'the date of birth no longer works once a PIN is set');
  assert.strictEqual(await verify('583921'), 'CONFIRMED');

  assert.strictEqual((await call('DELETE', `/api/personnel/${p.id}/welfare-pin`, undefined, await login('emarsh', 'field123'))).status, 403, 'not a colleague\'s');
  assert.strictEqual((await call('DELETE', `/api/personnel/${p.id}/welfare-pin`, undefined, danT)).status, 200);
  assert.ok(!p.welfare_pin_hash);
});

test('INTEGRATION_ALLOWED_IPS limits machine-to-machine routes, but not the control room PC routes', async () => {
  const r = await call('POST', '/api/integrations/guardm8/jobs', {}, null, { 'x-real-ip': '198.51.100.9' });
  assert.strictEqual(r.status, 403);
  assert.ok(app.db.audit_logs.some((e) => e.type === 'integration.address_refused'));
  assert.strictEqual((await call('POST', '/api/integrations/guardm8/jobs', {}, null, { 'x-real-ip': '10.9.9.9' })).status, 401, 'allowed address reaches the secret check');
  assert.notStrictEqual((await call('POST', '/api/integrations/workstation/clock-in', {}, null, { 'x-real-ip': '198.51.100.9' })).status, 403, 'PCs off the VPN still get through to their own secret check');
});
