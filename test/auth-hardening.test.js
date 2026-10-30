/* Session and request hardening — node --test
 *
 * A password reset signs out the sessions issued before it, account changes
 * name who made them, and every response carries the baseline security
 * headers whether or not a proxy adds its own. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4062';
process.env.AUTH_SECRET = 'auth-hardening-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, headers: res.headers };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;

let adminT;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

test('an admin password reset signs out the account\'s existing sessions', async () => {
  const created = (await call('POST', '/api/users', { username: 'reset-me', password: 'first-pass-1', role: 'DISPATCHER' }, adminT)).body;
  const oldT = await login('reset-me', 'first-pass-1');
  assert.strictEqual((await call('GET', '/api/me', undefined, oldT)).status, 200);
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual((await call('PATCH', `/api/users/${created.id}`, { password: 'second-pass-2' }, adminT)).status, 200);
  assert.strictEqual((await call('GET', '/api/me', undefined, oldT)).status, 401);
  const newT = await login('reset-me', 'second-pass-2');
  assert.strictEqual((await call('GET', '/api/me', undefined, newT)).status, 200);
});

test('a role change is logged with who made it', async () => {
  const created = (await call('POST', '/api/users', { username: 'promote-me', password: 'a-password-1', role: 'DISPATCHER' }, adminT)).body;
  await call('PATCH', `/api/users/${created.id}`, { role: 'SUPERVISOR' }, adminT);
  const ev = app.db.audit_logs.filter((e) => e.type === 'user.updated').pop();
  assert.match(ev.summary, /BY admin/);
  assert.match(ev.summary, /ROLE DISPATCHER → SUPERVISOR/);
});

test('API and static responses carry the baseline security headers', async () => {
  for (const path of ['/api/auth/microsoft/status', '/index.html']) {
    const res = await fetch(BASE + path);
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
    assert.strictEqual(res.headers.get('referrer-policy'), 'same-origin');
  }
});

test('a wrong GuardM8 secret is refused', async () => {
  process.env.GUARDM8_SECRET = 'right-secret';
  const res = await fetch(BASE + '/api/integrations/guardm8/jobs', { method: 'POST', headers: { 'content-type': 'application/json', 'x-guardm8-secret': 'wrong-secret' }, body: '{}' });
  assert.strictEqual(res.status, 401);
  delete process.env.GUARDM8_SECRET;
});
