/* Automatic chasing of unfilled shifts (routes-open-shift-sms.js escalationTick) — node --test */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4072';
process.env.AUTH_SECRET = 'unfilled-shift-escalation-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';
delete process.env.SMS_LIVE; // dry run: logged, never sent
delete process.env.UNFILLED_SHIFT_ESCALATION;

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
async function call(method, path, body, token) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;
// A fixed "now" at midday UK time, so the daytime window is always open.
const NOON = Date.parse('2026-11-10T12:00:00Z');
const at = (h) => new Date(NOON + h * 3600000).toISOString();
const tick = (now = NOON) => app.openShiftSms.escalationTick(now);

let adminT, dispT, typeId, dan, ellie;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123'); dispT = await login('dispatcher', 'dispatch123');
  typeId = app.db.shift_types.find((t) => t.key === 'MOBILE_PATROL').id;
  dan = app.db.personnel.find((p) => p.name === 'Dan Whitfield');
  ellie = app.db.personnel.find((p) => p.name === 'Ellie Marsh');
  dan.contact_phone = '07700 900001'; ellie.contact_phone = '07700 900002';
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

// Shifts are created relative to the real clock by the API, then moved onto
// the fixed test clock so the tick sees exactly the hours we want.
async function shiftAt(hoursFromNoon, headcount = 1) {
  const s = (await call('POST', '/api/shifts', { shift_type_id: typeId, required_headcount: headcount, starts_at: new Date(Date.now() + 400 * 3600000).toISOString(), ends_at: new Date(Date.now() + 408 * 3600000).toISOString() }, adminT)).body;
  const row = app.db.shifts.find((x) => x.id === s.id);
  row.starts_at = at(hoursFromNoon); row.ends_at = at(hoursFromNoon + 8); row.status = 'PUBLISHED';
  return row;
}
const park = () => { for (const s of app.db.shifts) if (s.status === 'PUBLISHED') s.status = 'COMPLETED'; };

test('settings: control can read, only admin can change, bad numbers refused', async () => {
  const r = await call('GET', '/api/shifts/escalation/settings', undefined, dispT);
  assert.equal(r.status, 200);
  assert.equal(r.body.enabled, true); assert.equal(r.body.staff_hours, 48); assert.equal(r.body.alert_hours, 24);
  assert.equal((await call('PUT', '/api/shifts/escalation/settings', { enabled: false }, dispT)).status, 403);
  assert.equal((await call('PUT', '/api/shifts/escalation/settings', { alert_to: 'not a number' }, adminT)).status, 400);
  assert.equal((await call('PUT', '/api/shifts/escalation/settings', { staff_hours: 12, alert_hours: 24 }, adminT)).status, 400);
  const ok = await call('PUT', '/api/shifts/escalation/settings', { alert_to: '07700 900099' }, adminT);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.alert_to, '07700 900099');
});

test('a short shift is texted to staff once at 48h, and managers alerted once at 24h', async () => {
  park();
  const s = await shiftAt(40);
  const far = await shiftAt(60); // outside 48h: left alone
  const before = app.db.dial_log.length;
  let r = await tick();
  assert.deepEqual(r.staff_shifts, [s.id]);
  assert.ok(r.staff_texted >= 1);
  assert.deepEqual(r.alerted_shifts, [], 'not yet 24h away');
  const texts = app.db.dial_log.slice(before);
  assert.ok(texts.some((l) => l.personnel_id === dan.id && /still needs cover/.test(l.body) && /officer\.html#rota/.test(l.body)));
  assert.ok(!texts.some((l) => /Sat|Sun|Mon|Tue|Wed|Thu|Fri/.test(l.body) && l.body.includes(far.starts_at)));
  assert.equal(far.unfilled_escalation, undefined);

  r = await tick();
  assert.deepEqual(r.staff_shifts, [], 'never texted twice');

  // 17h later (05:00) it is 23h away, but managers are not woken: they hear at 07:00.
  const mid = app.db.dial_log.length;
  r = await tick(NOON + 17 * 3600000);
  assert.deepEqual(r.alerted_shifts, [], "not at 5am");
  r = await tick(NOON + 19 * 3600000);
  assert.deepEqual(r.alerted_shifts, [s.id]);
  assert.equal(r.alerts_sent, 1);
  const alert = app.db.dial_log.slice(mid).find((l) => l.to_number === '+447700900099');
  assert.ok(alert && /still short/.test(alert.body) && /rota\.html/.test(alert.body));
  r = await tick(NOON + 20 * 3600000);
  assert.deepEqual(r.alerted_shifts, [], 'alert only once');
});

test('a shift that fills is not chased, and is chased again if someone drops out', async () => {
  park();
  const s = await shiftAt(30);
  await call('POST', `/api/shifts/${s.id}/assignments`, { personnel: ellie.id }, adminT);
  let r = await tick();
  assert.deepEqual(r.staff_shifts, [], 'full shift left alone');
  const a = app.db.shift_assignments.find((x) => x.shift_id === s.id && x.personnel_id === ellie.id);
  a.status = 'REMOVED';
  r = await tick();
  assert.deepEqual(r.staff_shifts, [s.id]);
  const ok = app.db.shift_assignments.find((x) => x.shift_id === s.id && x.personnel_id === ellie.id); ok.status = 'ASSIGNED';
  await tick(); // fills: marks cleared
  assert.equal(s.unfilled_escalation, null);
  ok.status = 'REMOVED';
  r = await tick();
  assert.deepEqual(r.staff_shifts, [s.id], 'dropped out again: chased again');
});

test('waits for daytime, skips shifts texted by hand recently, and can be switched off', async () => {
  park();
  const s = await shiftAt(40);
  let r = await tick(Date.parse('2026-11-10T02:00:00Z'));
  assert.deepEqual(r.staff_shifts, [], 'no texts to staff at 2am');
  assert.equal(s.unfilled_escalation, undefined);

  app.db.audit_logs.push({ type: 'sms.open_shifts', at: new Date(NOON - 3600000).toISOString(), data: { shift_ids: [s.id], sent: 3 } });
  r = await tick();
  assert.deepEqual(r.staff_shifts, [], 'control already texted it an hour ago');
  assert.equal(s.unfilled_escalation.staff_by, 'manual text');

  park();
  const t = await shiftAt(20);
  assert.equal((await call('PUT', '/api/shifts/escalation/settings', { enabled: false }, adminT)).status, 200);
  r = await tick();
  assert.deepEqual(r.staff_shifts, []); assert.deepEqual(r.alerted_shifts, []);
  assert.equal(t.unfilled_escalation, undefined);
  await call('PUT', '/api/shifts/escalation/settings', { enabled: true }, adminT);
});
