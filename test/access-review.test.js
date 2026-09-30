/* Access review — node --test
 *
 * A handful of "act on your own record" routes checked `role === 'FIELD_USER'`
 * before letting a self-scope check through, which meant MDT_USER — a
 * vehicle terminal login, not a specific person — fell through unrestricted
 * on every one of them: it could cancel or falsely check in ANY officer's
 * welfare timer, return anyone's asset checkout, clear anyone's callback
 * request, and read anyone's training record. The welfare ones are the
 * safety-critical pair this file exists to prove fixed — an MDT terminal
 * silently clearing a lone-worker alarm is exactly the "wrong person did
 * it" scenario docs/ROADMAP.md's Access review item named. Also covers the
 * smaller structural gap found alongside it: only acknowledged_by was ever
 * recorded on an emergency event, never resolved_by. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4023';
process.env.AUTH_SECRET = 'access-review-test-secret';
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
  return { status: res.status, body: parsed };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;

let adminT, dispT, danT, mdtT, dan, ellie;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dispT = await login('dispatcher', 'dispatch123');
  danT = await login('dwhitfield', 'field123');
  mdtT = await login('mdt001', 'mdt123');
  dan = app.db.personnel.find((p) => p.name === 'Dan Whitfield');
  ellie = app.db.personnel.find((p) => p.name === 'Ellie Marsh');
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

test('an MDT terminal cannot start, check in, or cancel another person\'s welfare timer — only that person or control can', async () => {
  assert.equal((await call('POST', `/api/personnel/${dan.id}/welfare`, { interval_s: 600 }, mdtT)).status, 403);

  const started = await call('POST', `/api/personnel/${dan.id}/welfare`, { interval_s: 600 }, danT);
  assert.equal(started.status, 200);

  assert.equal((await call('POST', `/api/personnel/${dan.id}/welfare/check`, {}, mdtT)).status, 403, 'an MDT terminal must not be able to silently clear an officer\'s overdue alarm');
  assert.equal((await call('DELETE', `/api/personnel/${dan.id}/welfare`, undefined, mdtT)).status, 403, 'nor cancel it outright');

  // Dan can manage his own; control can manage anyone's.
  assert.equal((await call('POST', `/api/personnel/${dan.id}/welfare/check`, {}, danT)).status, 200);
  assert.equal((await call('DELETE', `/api/personnel/${dan.id}/welfare`, undefined, dispT)).status, 200);
});

test('checking in clears the right welfare alarm and now records who did it', async () => {
  const p = ellie;
  p.welfare_due_at = new Date(Date.now() + 600000).toISOString();
  p.welfare_interval_s = 600;
  // Stand in for what welfareTick would have created on a real overdue
  // alarm — the route under test only cares that a WELFARE-kind event is
  // open for this person, not how it got there.
  app.db.emergency_events.push({
    id: 9001, kind: 'WELFARE', personnel_id: p.id, callsign: 'TEST', lat: null, lon: null, state: 'ACTIVE',
    note: null, activated_at: new Date().toISOString(), acknowledged_at: null, acknowledged_by: null, resolved_at: null, resolved_by: null,
  });
  const checked = await call('POST', `/api/personnel/${p.id}/welfare/check`, {}, dispT);
  assert.equal(checked.status, 200);
  const ev = app.db.emergency_events.find((e) => e.id === 9001);
  assert.equal(ev.state, 'RESOLVED');
  assert.equal(ev.resolved_by, 'Controller Hale', 'who cleared this alarm is now on the record, not just in a log line');
});

test('an emergency\'s resolved_by is recorded the same way acknowledged_by already was', async () => {
  const raised = await call('POST', '/api/emergency', {}, danT);
  assert.equal(raised.status, 201, JSON.stringify(raised.body));
  await call('POST', `/api/emergency/${raised.body.id}/ack`, {}, dispT);
  const resolved = await call('POST', `/api/emergency/${raised.body.id}/resolve`, {}, adminT);
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.acknowledged_by, 'Controller Hale');
  assert.equal(resolved.body.resolved_by, 'System Admin', 'resolved_by is now recorded, same as acknowledged_by always was');
});

test('an MDT terminal cannot return someone else\'s asset checkout or clear someone else\'s callback request', async () => {
  const asset = (await call('POST', '/api/assets', { description: 'Test radio', category: 'DEVICE' }, adminT)).body;
  await call('POST', `/api/assets/${asset.id}/checkout`, { personnel_id: dan.id }, dispT);
  assert.equal((await call('POST', `/api/assets/${asset.id}/return`, {}, mdtT)).status, 403);
  assert.equal((await call('POST', `/api/assets/${asset.id}/return`, {}, dispT)).status, 200, 'control still can');

  const req = await call('POST', '/api/calls/request', {}, danT);
  assert.equal(req.status, 201, JSON.stringify(req.body));
  assert.equal((await call('POST', `/api/calls/requests/${req.body.id}/clear`, {}, mdtT)).status, 403);
});

test('an MDT terminal cannot read someone else\'s training record', async () => {
  assert.equal((await call('GET', `/api/personnel/${dan.id}/training-records`, undefined, mdtT)).status, 403);
  assert.equal((await call('GET', `/api/personnel/${dan.id}/training-records`, undefined, danT)).status, 200, 'the person themselves still can');
  assert.equal((await call('GET', `/api/personnel/${dan.id}/training-records`, undefined, dispT)).status, 200, 'control still can');
});

test('only the actual recipient (or control, for a message sent to control) can mark a message read', async () => {
  const toDan = await call('POST', '/api/messages', { to_personnel: dan.id, body: 'test message' }, dispT);
  assert.equal(toDan.status, 201, JSON.stringify(toDan.body));
  assert.equal((await call('POST', `/api/messages/${toDan.body.id}/read`, {}, mdtT)).status, 403, 'not addressed to this MDT');
  const marked = await call('POST', `/api/messages/${toDan.body.id}/read`, {}, danT);
  assert.equal(marked.status, 200);
  assert.ok(marked.body.read_at);

  const toControl = await call('POST', '/api/messages', { to_control: true, body: 'to control' }, danT);
  assert.equal((await call('POST', `/api/messages/${toControl.body.id}/read`, {}, danT)).status, 403, 'a message to control is not this officer\'s to mark read');
  assert.equal((await call('POST', `/api/messages/${toControl.body.id}/read`, {}, dispT)).status, 200);
});
