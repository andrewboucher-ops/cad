/* Admin → Text staff (routes-staff-sms.js), and the toolbox talk PDF being
 * served — node --test */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4039';
process.env.AUTH_SECRET = 'staff-sms-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';
delete process.env.SMS_LIVE; // dry run: logged, never sent

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
async function call(method, path, body, token, raw = false) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (raw) return res;
  const text = await res.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;

let adminT, dispT;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123'); dispT = await login('dispatcher', 'dispatch123');
  // Give the dispatcher and supervisor logins staff records; only one has a mobile.
  const a = (await call('POST', '/api/personnel', { name: 'Chris Hale', contact_phone: '07700 900111' }, adminT)).body;
  const b = (await call('POST', '/api/personnel', { name: 'Sam Reid' }, adminT)).body;
  const users = (await call('GET', '/api/users', undefined, adminT)).body;
  await call('PATCH', `/api/users/${users.find((u) => u.username === 'dispatcher').id}`, { personnel_id: a.id }, adminT);
  await call('PATCH', `/api/users/${users.find((u) => u.username === 'supervisor').id}`, { personnel_id: b.id }, adminT);
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

test('the preview lists every controller, and who will be missed and why', async () => {
  assert.equal((await call('GET', '/api/admin/sms-broadcast/preview?roles=DISPATCHER', undefined, dispT)).status, 403, 'admins only');
  assert.equal((await call('GET', '/api/admin/sms-broadcast/preview?roles=NOPE', undefined, adminT)).status, 400);
  const r = (await call('GET', '/api/admin/sms-broadcast/preview?roles=DISPATCHER,SUPERVISOR', undefined, adminT)).body;
  assert.equal(r.live, false);
  assert.equal(r.sending_to, 1);
  const chris = r.recipients.find((x) => x.name === 'Chris Hale');
  assert.equal(chris.status, 'ok');
  assert.match(chris.to, /0111$/);
  assert.ok(!chris.to.includes('7700900'), 'the number is masked in the preview');
  assert.equal(r.recipients.find((x) => x.name === 'Sam Reid').status, 'no mobile number');
});

test('sending texts everyone with a mobile, through sms.js, and logs each one', async () => {
  const before = app.db.dial_log.length;
  assert.equal((await call('POST', '/api/admin/sms-broadcast', { roles: ['DISPATCHER', 'SUPERVISOR'], body: '' }, adminT)).status, 400);
  const link = 'https://comms.echeloncic.com/toolbox/clocking-in.pdf';
  const r = await call('POST', '/api/admin/sms-broadcast', { roles: ['DISPATCHER', 'SUPERVISOR'], body: `Toolbox talk: how to clock in and out — please read: ${link}` }, adminT);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sent, 1);
  assert.equal(r.body.dry_run, true);
  const logged = app.db.dial_log.slice(before);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].channel, 'SMS');
  assert.ok(logged[0].body.includes(link));
  assert.equal(logged[0].outcome, 'ATTEMPTED', 'a dry run is logged as attempted, not sent');
  assert.ok(app.db.audit_logs.some((e) => e.type === 'sms.broadcast'));
  assert.equal((await call('POST', '/api/admin/sms-broadcast', { roles: ['FIELD_USER'], body: 'x'.repeat(601) }, adminT)).status, 400, 'length limit');
});

test('the toolbox talk PDF is served to anyone with the link, as a PDF', async () => {
  const res = await call('GET', '/toolbox/clocking-in.pdf', undefined, undefined, true);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
});
