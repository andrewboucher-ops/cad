/* Rota → Text staff about open shifts (routes-open-shift-sms.js) — node --test */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4071';
process.env.AUTH_SECRET = 'open-shift-sms-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';
delete process.env.SMS_LIVE; // dry run: logged, never sent

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
async function call(method, path, body, token) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;
const future = (h) => new Date(Date.now() + h * 3600000).toISOString();

let adminT, dispT, danT, typeId, dan, ellie;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123'); dispT = await login('dispatcher', 'dispatch123'); danT = await login('dwhitfield', 'field123');
  typeId = app.db.shift_types.find((t) => t.key === 'MOBILE_PATROL').id;
  dan = app.db.personnel.find((p) => p.name === 'Dan Whitfield');
  ellie = app.db.personnel.find((p) => p.name === 'Ellie Marsh');
  dan.contact_phone = '07700 900001'; ellie.contact_phone = '07700 900002';
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

test('control previews open shifts, the text and who gets it; officers cannot', async () => {
  const shift = (await call('POST', '/api/shifts', { shift_type_id: typeId, required_headcount: 1, starts_at: future(30), ends_at: future(38) }, adminT)).body;
  assert.equal((await call('GET', '/api/shifts/available/notify/preview', undefined, danT)).status, 403);
  const r = await call('GET', '/api/shifts/available/notify/preview', undefined, dispT);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.live, false);
  assert.ok(r.body.open_shifts.some((s) => s.id === shift.id && s.places === 1));
  assert.match(r.body.sample_message, /open to claim/);
  assert.match(r.body.sample_message, /officer\.html#rota/);
  assert.ok(r.body.sample_message.length <= 600);
  const d = r.body.recipients.find((x) => x.name === 'Dan Whitfield');
  assert.equal(d.status, 'ok');
  assert.ok(!d.to.includes('7700900'), 'numbers are masked');
});

test('sending texts each officer once, skips anyone already on the shift, and logs it', async () => {
  const shift = (await call('POST', '/api/shifts', { shift_type_id: typeId, required_headcount: 2, starts_at: future(50), ends_at: future(58) }, adminT)).body;
  await call('POST', `/api/shifts/${shift.id}/assignments`, { personnel: ellie.id }, adminT);
  const before = app.db.dial_log.length;
  const r = await call('POST', '/api/shifts/available/notify', { shifts: [shift.id] }, dispT);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.dry_run, true);
  assert.ok(r.body.results.some((x) => x.name === 'Dan Whitfield'));
  assert.ok(!r.body.results.some((x) => x.name === 'Ellie Marsh'), 'not texted about a shift she is already on');
  const logged = app.db.dial_log.slice(before);
  assert.equal(logged.length, r.body.sent);
  assert.ok(logged.every((l) => l.channel === 'SMS'));
  const after = (await call('GET', `/api/shifts/available/notify/preview?shifts=${shift.id}`, undefined, dispT)).body;
  assert.equal(after.last_sent.recent, true, 'preview warns it was just sent');
});

test('a shift that is no longer open cannot be advertised', async () => {
  const shift = (await call('POST', '/api/shifts', { shift_type_id: typeId, required_headcount: 1, starts_at: future(70), ends_at: future(78) }, adminT)).body;
  await call('POST', `/api/shifts/${shift.id}/assignments`, { personnel: dan.id }, adminT);
  assert.equal((await call('POST', '/api/shifts/available/notify', { shifts: [shift.id] }, dispT)).status, 400);
});

test('a long list is trimmed with "+N more" and stays within one long text', async () => {
  for (let i = 0; i < 7; i++) await call('POST', '/api/shifts', { shift_type_id: typeId, required_headcount: 1, starts_at: future(90 + i * 24), ends_at: future(98 + i * 24) }, adminT);
  const r = (await call('GET', '/api/shifts/available/notify/preview', undefined, dispT)).body;
  assert.ok(r.open_shifts.length >= 8);
  assert.match(r.sample_message, /\+\d+ more/);
  assert.ok(r.sample_message.length <= 600);
  assert.match(r.sample_message, /officer\.html#rota/, 'the claim link is never trimmed off');
});
