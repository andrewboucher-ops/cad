/* Timeclock (routes-timeclock.js): reasons outside the rostered times,
 * ad-hoc shifts, approvals; patrols on shifts and what the client sees
 * (routes-shift-patrols.js) — node --test */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4037';
process.env.AUTH_SECRET = 'timeclock-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';
process.env.SHIFT_REMINDERS = 'off';

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
async function call(method, path, body, token) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;

let adminT, dispT, danT, dan, site, other, clientT, otherT;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123'); dispT = await login('dispatcher', 'dispatch123'); danT = await login('dwhitfield', 'field123');
  dan = app.db.personnel.find((p) => p.name === 'Dan Whitfield');
  [site, other] = app.db.sites;
  for (const s of app.db.sites) { s.lat = null; s.lon = null; } // no geofence in these tests
  const c = (await call('POST', '/api/clients', { name: 'New Holland Ltd', site_ids: [site.id] }, adminT)).body;
  const c2 = (await call('POST', '/api/clients', { name: 'Elsewhere', site_ids: [other.id] }, adminT)).body;
  await call('POST', '/api/users', { username: 'newholland', password: 'realpassword1', role: 'CLIENT', client_id: c.id }, adminT);
  await call('POST', '/api/users', { username: 'elsewhere', password: 'realpassword1', role: 'CLIENT', client_id: c2.id }, adminT);
  clientT = await login('newholland', 'realpassword1'); otherT = await login('elsewhere', 'realpassword1');
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

async function shiftFor(startOffsetMin, lengthH = 8, siteId = site.id) {
  const type = (await call('GET', '/api/shift-types', undefined, dispT)).body[0];
  const st = new Date(Date.now() + startOffsetMin * 60000);
  const s = (await call('POST', '/api/shifts', { shift_type_id: type.id, site_id: siteId, starts_at: st.toISOString(), ends_at: new Date(st.getTime() + lengthH * 3600e3).toISOString(), personnel: dan.id }, adminT)).body; // shift editing is admin-only
  const shift = app.db.shifts.find((x) => x.id === s.id);
  const a = app.db.shift_assignments.find((x) => x.shift_id === s.id && x.personnel_id === dan.id);
  return { s: shift, a };
}
const clockOutAll = () => { for (const a of app.db.shift_assignments) if (a.personnel_id === dan.id && a.clocked_in_at && !a.clocked_out_at) a.clocked_out_at = new Date().toISOString(); };

test('clocking in early needs a reason, waits for approval, and rejecting it pays from the rostered start', async () => {
  const { s, a } = await shiftFor(30);
  const url = `/api/shift-assignments/${a.id}/clock-in`;
  const r = await call('POST', url, {}, danT);
  assert.equal(r.status, 428);
  assert.match(r.body.error, /30 min before the rostered start/);
  assert.equal((await call('POST', url, { reason: 'site manager asked me in early' }, danT)).status, 200);
  assert.equal(a.exceptions[0].kind, 'EARLY_IN');
  assert.equal(a.exceptions[0].status, 'PENDING');

  assert.equal((await call('GET', '/api/timeclock/pending', undefined, danT)).status, 403, 'officers cannot approve');
  const pending = (await call('GET', '/api/timeclock/pending', undefined, dispT)).body;
  const p = pending.find((x) => x.assignment_id === a.id);
  assert.equal(p.reason, 'site manager asked me in early');
  const d = await call('POST', `/api/timeclock/exceptions/${a.id}/${p.id}`, { decision: 'REJECT' }, dispT);
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(a.clocked_in_at, s.starts_at, 'counted from the rostered start');
  assert.equal(a.time_edits.length, 1);
  assert.equal((await call('POST', `/api/timeclock/exceptions/${a.id}/${p.id}`, { decision: 'APPROVE' }, dispT)).status, 409, 'decided once');
  clockOutAll();
});

test('clocking out late needs a reason; within 5 minutes it does not; control clocking someone out is approved there and then', async () => {
  const { s, a } = await shiftFor(-120, 1.7); // ended ~18 min ago
  a.clocked_in_at = s.starts_at;
  const url = `/api/shift-assignments/${a.id}/clock-out`;
  assert.equal((await call('POST', url, {}, danT)).status, 428);
  assert.equal((await call('POST', url, { reason: 'incident at the gate' }, danT)).status, 200);
  assert.equal(a.exceptions[0].kind, 'LATE_OUT');
  const ok = await call('POST', `/api/timeclock/exceptions/${a.id}/${a.exceptions[0].id}`, { decision: 'APPROVE' }, adminT);
  assert.equal(ok.body.status, 'APPROVED');
  assert.ok(a.clocked_out_at > s.ends_at, 'approved — the late finish stands');

  const { a: b } = await shiftFor(-3);
  assert.equal((await call('POST', `/api/shift-assignments/${b.id}/clock-in`, {}, danT)).status, 200, 'on time: no questions');
  assert.equal((b.exceptions || []).length, 0);
  assert.equal((await call('POST', `/api/shift-assignments/${b.id}/clock-out`, {}, dispT)).status, 200, 'control clocks out early with no reason');
  assert.equal(b.exceptions[0].kind, 'EARLY_OUT');
  assert.equal(b.exceptions[0].status, 'APPROVED');
});

test('with no shift booked, an officer clocks in ad hoc with a site and a reason; it ends when they clock out', async () => {
  assert.equal((await call('POST', '/api/timeclock/clock-in', { site_id: site.id }, danT)).status, 428, 'a reason is needed');
  const r = await call('POST', '/api/timeclock/clock-in', { site_id: site.id, reason: 'called in for cover' }, danT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.ad_hoc, true);
  assert.equal(r.body.status, 'IN_PROGRESS');
  assert.equal((await call('POST', '/api/timeclock/clock-in', { site_id: site.id, reason: 'again' }, danT)).status, 409, 'already clocked in');
  const mine = (await call('GET', `/api/shifts?personnel_id=${dan.id}&from=${new Date(Date.now() - 3600e3).toISOString()}`, undefined, danT)).body;
  const s = mine.find((x) => x.id === r.body.id);
  assert.ok(s, 'it is in their own shift list, so the phone banner shows it');
  const now = (await call('GET', '/api/timeclock/now', undefined, dispT)).body;
  assert.ok(now.on.some((x) => x.shift_id === s.id && x.ad_hoc && x.approval === 'PENDING'));
  const a = app.db.shift_assignments.find((x) => x.shift_id === s.id);
  a.clocked_in_at = new Date(Date.now() - 2 * 3600e3).toISOString();
  assert.equal((await call('POST', `/api/shift-assignments/${a.id}/clock-out`, {}, danT)).status, 200, 'no rostered finish, no reason needed');
  const shift = app.db.shifts.find((x) => x.id === s.id);
  assert.equal(shift.ends_at, a.clocked_out_at);
  assert.equal(shift.status, 'COMPLETED');

  const today = new Date().toISOString().slice(0, 10);
  let sheet = (await call('GET', `/api/timeclock/timesheet?from=${today}&to=${today}&personnel_id=${dan.id}`, undefined, adminT)).body;
  const row = sheet.find((x) => x.assignment_id === a.id);
  assert.ok(Math.abs(row.worked_min - 120) <= 1);
  await call('POST', `/api/timeclock/exceptions/${a.id}/${a.exceptions[0].id}`, { decision: 'REJECT', note: 'not authorised' }, dispT);
  assert.equal(a.time_rejected, true, 'rejected: no hours count');
  sheet = (await call('GET', `/api/timeclock/timesheet?from=${today}&to=${today}`, undefined, adminT)).body;
  assert.equal(sheet.find((x) => x.assignment_id === a.id).rejected, true);

  // Control clocks someone in with no shift: approved straight away.
  const c = await call('POST', '/api/timeclock/clock-in', { personnel_id: dan.id, site_id: site.id, reason: 'cover' }, dispT);
  assert.equal(c.status, 201);
  assert.equal(app.db.shift_assignments.find((x) => x.shift_id === c.body.id).exceptions[0].status, 'APPROVED');
  clockOutAll();
});

let patrolShift;
test('a shift with an hourly patrol: each patrol goes to the officer on shift; one not done in its hour is missed', async () => {
  const beat = (await call('POST', '/api/beats', { site_id: site.id, name: 'Yard loop' }, dispT)).body;
  await call('PATCH', `/api/beats/${beat.id}`, { waypoints: [{ title: 'Gate A' }, { title: 'Fuel store' }, { title: 'Workshop' }] }, dispT);
  const otherBeat = (await call('POST', '/api/beats', { site_id: other.id, name: 'Elsewhere loop' }, dispT)).body;
  const { s, a } = await shiftFor(-130, 12);
  patrolShift = s;
  const url = `/api/shifts/${s.id}/patrol`;
  assert.equal((await call('PUT', url, { every_min: 60, beat_id: beat.id }, danT)).status, 403);
  assert.equal((await call('PUT', url, { every_min: 60, beat_id: beat.id }, dispT)).status, 403, 'admin only, like shift editing');
  assert.equal((await call('PUT', url, { every_min: 5 }, adminT)).status, 400);
  assert.equal((await call('PUT', url, { every_min: 60, beat_id: otherBeat.id }, adminT)).status, 400, 'the route must be at this site');
  assert.equal((await call('PUT', url, { every_min: 60, beat_id: beat.id }, adminT)).status, 200);
  assert.equal(s.detail.patrol_interval_min, 60, 'the officer app\'s shift note stays in step');
  await call('POST', `/api/shift-assignments/${a.id}/clock-in`, { reason: 'test' }, danT);

  app.shiftPatrols.tick();
  assert.equal(app.db.site_visits.filter((v) => v.shift_id === s.id).length, 0, 'set just now: no patrols invented for the past');
  s.patrol.set_at = s.starts_at; // as if it had been set when the shift was made
  app.shiftPatrols.tick();
  const visits = app.db.site_visits.filter((v) => v.shift_id === s.id).sort((x, y) => x.patrol_seq - y.patrol_seq);
  assert.deepEqual(visits.map((v) => v.patrol_seq), [1, 2], 'due at +60 and +120 minutes');
  assert.equal(visits[0].status, 'MISSED', 'the first one\'s hour is over');
  assert.equal(visits[1].status, 'ON_SCENE');
  assert.equal(visits[1].personnel_id, dan.id, 'given to the officer clocked in');
  app.shiftPatrols.tick();
  assert.equal(app.db.site_visits.filter((v) => v.shift_id === s.id).length, 2, 'not created twice');

  // The officer scans two of the three checkpoints and completes it.
  const v = visits[1];
  for (const w of beat.waypoints ? app.db.beats.find((b) => b.id === beat.id).waypoints.slice(0, 2) : []) {
    assert.equal((await call('POST', `/api/site-visits/${v.id}/checkpoint-scan`, { waypoint_id: w.id }, danT)).status, 201);
  }
  assert.equal((await call('PATCH', `/api/site-visits/${v.id}`, { status: 'COMPLETED' }, danT)).status, 200);
  assert.ok(app.db.audit_logs.some((e) => e.type === 'site_visit.missed' && e.data && e.data.shift_id === s.id), 'control told about the miss');

  // Not done within the hour → missed.
  const later = Date.parse(s.starts_at) + 4 * 3600e3 + 1000;
  app.shiftPatrols.tick(later);
  const third = app.db.site_visits.find((v2) => v2.shift_id === s.id && v2.patrol_seq === 3);
  assert.equal(third.status, 'MISSED');
});

test('the client sees the shifts at their site and every patrol with its checkpoint times — and no staff names', async () => {
  const q = `site_id=${site.id}&from=${new Date(Date.now() - 86400e3).toISOString()}&to=${new Date(Date.now() + 86400e3).toISOString()}`;
  const shifts = await call('GET', `/api/client/shifts?${q}`, undefined, clientT);
  assert.equal(shifts.status, 200, JSON.stringify(shifts.body));
  const s = shifts.body.find((x) => x.id === patrolShift.id);
  assert.equal(s.state, 'ON_SITE');
  assert.equal(s.patrol_every_min, 60);
  assert.equal(s.patrols.completed, 1);
  assert.ok(s.patrols.missed >= 2);
  const patrols = (await call('GET', `/api/client/patrols?${q}`, undefined, clientT)).body;
  const done = patrols.find((p) => p.shift_id === patrolShift.id && p.status === 'COMPLETED');
  assert.equal(done.route, 'Yard loop');
  assert.deepEqual(done.checkpoints.map((c) => Boolean(c.scanned_at)), [true, true, false]);
  const all = JSON.stringify([shifts.body, patrols]);
  assert.ok(!all.includes('Dan') && !all.includes('Whitfield'), 'no staff names');
  assert.equal((await call('GET', `/api/client/shifts?${q}`, undefined, otherT)).status, 404, 'not another client\'s site');
  assert.equal((await call('GET', `/api/client/shifts?${q}`, undefined, danT)).status, 403);
});

test('someone rostered for a past shift who never clocked in at all shows up on the timesheet, not just invisibly missing', async () => {
  const { s, a } = await shiftFor(-240, 2); // ended two hours ago, nobody ever clocked in
  const from = new Date(Date.parse(s.starts_at)).toISOString().slice(0, 10);
  const to = new Date(Date.parse(s.ends_at) + 86400e3).toISOString().slice(0, 10);
  let sheet = (await call('GET', `/api/timeclock/timesheet?from=${from}&to=${to}&personnel_id=${dan.id}`, undefined, adminT)).body;
  const row = sheet.find((x) => x.assignment_id === a.id);
  assert.ok(row, 'present even with no clocked_in_at to anchor a normal row on');
  assert.equal(row.clocked_in_at, null);
  assert.equal(row.worked_min, 0);

  // Backfilling it through the same /times route used to correct a wrong
  // time makes it a normal, clocked row from here on.
  const inAt = s.starts_at, outAt = s.ends_at;
  const r = await call('PATCH', `/api/shift-assignments/${a.id}/times`, { clocked_in_at: inAt, clocked_out_at: outAt, reason: 'phone died on shift, confirmed worked the full shift with the site manager' }, dispT);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(a.clocked_in_at, inAt);
  assert.equal(a.attendance, 'ATTENDED');

  sheet = (await call('GET', `/api/timeclock/timesheet?from=${from}&to=${to}&personnel_id=${dan.id}`, undefined, adminT)).body;
  const backfilled = sheet.find((x) => x.assignment_id === a.id);
  assert.equal(backfilled.clocked_in_at, inAt);
  assert.ok(Math.abs(backfilled.worked_min - 120) <= 1);

  // A NO_SHOW is a deliberate record, not a gap to surface for backfilling.
  const { a: b } = await shiftFor(-240, 2);
  await call('PATCH', `/api/shift-assignments/${b.id}`, { attendance: 'NO_SHOW' }, adminT);
  sheet = (await call('GET', `/api/timeclock/timesheet?from=${from}&to=${to}&personnel_id=${dan.id}`, undefined, adminT)).body;
  assert.ok(!sheet.some((x) => x.assignment_id === b.id), 'NO_SHOW is excluded');
});
