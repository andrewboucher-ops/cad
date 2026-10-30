/* Microsoft-only sign-in for admin and control roles — node --test
 *
 * With Microsoft sign-in configured, an admin/control/finance account that
 * has an email can't use its password; officers, accounts with no email, and
 * named break-glass accounts still can. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4064';
process.env.AUTH_SECRET = 'sso-required-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';
process.env.MS_TENANT_ID = 'tenant'; process.env.MS_CLIENT_ID = 'client';
process.env.MS_CLIENT_SECRET = 'secret'; process.env.MS_REDIRECT_URI = 'https://example.test/cb';
process.env.BREAK_GLASS_USERS = 'glass';

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
  return { status: res.status, body: parsed };
}
const login = (u, p) => call('POST', '/api/auth/login', { username: u, password: p });

let adminT;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = (await login('admin', 'admin123')).body.token; // no email yet, so a password still works
  await call('POST', '/api/users', { username: 'disp-sso', password: 'a-password-1', role: 'DISPATCHER', email: 'disp@example.test' }, adminT);
  await call('POST', '/api/users', { username: 'glass', password: 'a-password-2', role: 'SYSTEM_ADMIN', email: 'glass@example.test' }, adminT);
  await call('POST', '/api/users', { username: 'officer-sso', password: 'a-password-3', role: 'FIELD_USER', email: 'officer@example.test' }, adminT);
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

test('a dispatcher with an email must use Microsoft', async () => {
  const r = await login('disp-sso', 'a-password-1');
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.body.code, 'SSO_REQUIRED');
  assert.ok(!r.body.token);
  assert.ok(app.db.audit_logs.some((e) => e.type === 'auth.password_refused'));
});

test('a wrong password still reads as invalid credentials', async () => {
  assert.strictEqual((await login('disp-sso', 'nope-nope')).status, 401);
});

test('break-glass accounts, officers and accounts with no email keep password sign-in', async () => {
  assert.strictEqual((await login('glass', 'a-password-2')).status, 200);
  assert.strictEqual((await login('officer-sso', 'a-password-3')).status, 200);
  assert.strictEqual((await login('dispatcher', 'dispatch123')).status, 200);
});
