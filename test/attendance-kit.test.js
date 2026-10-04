/* Geofenced clock-in, breaks and hours, shift reminders and auto clock-out
 * (routes-attendance.js); kit on vehicles — assets, bags and the stock in
 * them, and the vehicle check (routes-inventory.js) — node --test */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4034';
process.env.AUTH_SECRET = 'attendance-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';
process.env.SHIFT_REMINDERS = 'on';

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
async function call(method, path, body, token) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let adminT, dispT, danT, dan, site;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123'); dispT = await login('dispatcher', 'dispatch123'); danT = await login('dwhitfield', 'field123');
  dan = app.db.personnel.find((p) => p.name === 'Dan Whitfield');
  dan.contact_phone = '07700900123';
  site = app.db.sites[0];
  await call('PATCH', `/api/sites/${site.id}`, { lat: 53.5, lon: -0.1, geofence_m: 200 }, adminT);
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

async function shiftFor(startOffsetMin, lengthH = 8, siteId = site.id) {
  const type = (await call('GET', '/api/shift-types', undefined, dispT)).body[0];
  const st = new Date(Date.now() + startOffsetMin * 60000);
  const s = (await call('POST', '/api/shifts', { shift_type_id: type.id, site_id: siteId, starts_at: st.toISOString(), ends_at: new Date(st.getTime() + lengthH * 3600e3).toISOString() }, adminT)).body;
  await call('POST', `/api/shifts/${s.id}/assignments`, { personnel: dan.id }, adminT);
  await call('POST', `/api/shifts/${s.id}/publish`, {}, adminT);
  const shift = app.db.shifts.find((x) => x.id === s.id);
  shift.status = 'PUBLISHED';
  const a = app.db.shift_assignments.find((x) => x.shift_id === s.id && x.personnel_id === dan.id);
  return { s: shift, a };
}

test('clocking in needs the officer to be on site; control can override, and it is logged', async () => {
  const { a } = await shiftFor(-2);
  const url = `/api/shift-assignments/${a.id}/clock-in`;
  assert.equal((await call('POST', url, {}, danT)).status, 400, 'no location, no clock-in');
  const far = await call('POST', url, { lat: 53.52, lon: -0.1, accuracy: 10 }, danT);
  assert.equal(far.status, 403);
  assert.match(far.body.error, /km from/);
  const near = await call('POST', url, { lat: 53.5005, lon: -0.1, accuracy: 15 }, danT);
  assert.equal(near.status, 200, JSON.stringify(near.body));
  assert.ok(a.clock_in_location.distance_m < 200);

  const { a: b } = await shiftFor(-2);
  assert.equal((await call('POST', `/api/shift-assignments/${b.id}/clock-in`, {}, dispT)).status, 200, 'control clocks someone in');
  assert.ok(b.clock_in_override);
  assert.ok(app.db.audit_logs.some((e) => e.type === 'shift.clock_in_override'));

  const noSite = await shiftFor(-2, 8, null);
  assert.equal((await call('POST', `/api/shift-assignments/${noSite.a.id}/clock-in`, {}, danT)).status, 200, 'no site, nothing to check against');
});

test('breaks come off the hours worked, and clocking out ends an open break', async () => {
  const { a } = await shiftFor(-1);
  await call('POST', `/api/shift-assignments/${a.id}/clock-in`, { lat: 53.5, lon: -0.1 }, danT);
  a.clocked_in_at = new Date(Date.now() - 4 * 3600e3).toISOString();
  assert.equal((await call('POST', `/api/shift-assignments/${a.id}/break-end`, {}, danT)).status, 409, 'not on a break');
  assert.equal((await call('POST', `/api/shift-assignments/${a.id}/break-start`, {}, danT)).status, 200);
  assert.equal((await call('POST', `/api/shift-assignments/${a.id}/break-start`, {}, danT)).status, 409, 'one break at a time');
  a.breaks[0].start = new Date(Date.now() - 30 * 60000).toISOString();
  await call('POST', `/api/shift-assignments/${a.id}/break-end`, {}, danT);
  let h = (await call('GET', `/api/shift-assignments/${a.id}/hours`, undefined, danT)).body;
  assert.equal(h.break_min, 30);
  assert.ok(Math.abs(h.worked_min - 210) <= 1, `4h less a 30 min break, got ${h.worked_min}`);
  await call('POST', `/api/shift-assignments/${a.id}/break-start`, {}, danT);
  await call('POST', `/api/shift-assignments/${a.id}/clock-out`, {}, danT);
  assert.ok(a.breaks.every((b) => b.end), 'the open break closed with the shift');
});

test('leaving site for 5 minutes clocks you out at the time you left — and no position is not the same as leaving', async () => {
  const { a, s } = await shiftFor(-1);
  await call('POST', `/api/shift-assignments/${a.id}/clock-in`, { lat: 53.5, lon: -0.1 }, danT);
  let r = await call('POST', `/api/shift-assignments/${a.id}/presence`, { lat: 53.5, lon: -0.1 }, danT);
  assert.deepEqual([r.body.enforced, r.body.inside], [true, true]);
  r = await call('POST', `/api/shift-assignments/${a.id}/presence`, { lat: 53.53, lon: -0.1 }, danT);
  assert.equal(r.body.inside, false);
  const left = a.outside_since;
  app.attendance.tick(Date.now() + 2 * 60000);
  assert.ok(!a.clocked_out_at, 'two minutes away is not enough');
  app.attendance.tick(Date.parse(left) + 5 * 60000 + 1000);
  assert.equal(a.clocked_out_at, left, 'clocked out from when they left');
  assert.equal(a.auto_clocked_out, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(app.db.dial_log.some((d) => d.channel === 'SMS' && d.personnel_id === dan.id && /clocked out/.test(d.body)), 'and told by SMS');

  const { a: b } = await shiftFor(-1);
  await call('POST', `/api/shift-assignments/${b.id}/clock-in`, { lat: 53.5, lon: -0.1 }, danT);
  app.attendance.tick(Date.now() + 60 * 60000);
  assert.ok(!b.clocked_out_at, 'a phone that stops reporting does not clock anyone out');
});

test('5 minutes late: an SMS; 15 minutes: an alert to control; end of shift: thanks and clock out', async () => {
  const { a, s } = await shiftFor(-6);
  const start = Date.parse(s.starts_at);
  app.attendance.tick(start + 4 * 60000);
  assert.ok(!a.late_sms_at, 'not yet');
  app.attendance.tick(start + 6 * 60000);
  assert.ok(a.late_sms_at);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(app.db.dial_log.some((d) => d.shift_id === s.id && /please clock in/i.test(d.body)));
  app.attendance.tick(start + 7 * 60000);
  assert.equal(app.db.dial_log.filter((d) => d.shift_id === s.id && /please clock in/i.test(d.body)).length, 1, 'only once');
  app.attendance.tick(start + 16 * 60000);
  assert.ok(a.late_alert_at);
  assert.ok(app.db.audit_logs.some((e) => e.type === 'shift.not_clocked_in' && e.data.shift_id === s.id), 'control alerted');

  const { a: b, s: s2 } = await shiftFor(-60, 1);
  await call('POST', `/api/shift-assignments/${b.id}/clock-in`, { lat: 53.5, lon: -0.1 }, danT);
  app.attendance.tick(Date.parse(s2.ends_at) + 60000);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(app.db.dial_log.some((d) => d.shift_id === s2.id && /remember to clock out/.test(d.body)));
});

test('10 minutes late is a real alarm, not another reminder — an emergency with the person\'s name on it, a RED job, and it fires once', async () => {
  const { a, s } = await shiftFor(-6);
  const start = Date.parse(s.starts_at);
  // Earlier tests in this file also drive the tick well past 10 minutes for
  // their own shifts, so Dan may already have other NOT_CLOCKED_IN rows —
  // scope every assertion to new ones raised by THIS shift, not to there
  // being none at all for him file-wide.
  const matching = () => app.db.emergency_events.filter((e) => e.kind === 'NOT_CLOCKED_IN' && e.personnel_id === dan.id);
  const seenBefore = new Set(matching().map((e) => e.id));
  const newOnes = () => matching().filter((e) => !seenBefore.has(e.id));

  app.attendance.tick(start + 9 * 60000);
  assert.ok(!a.not_clocked_in_alarm_at, 'not yet');
  assert.equal(newOnes().length, 0);

  app.attendance.tick(start + 11 * 60000);
  assert.ok(a.not_clocked_in_alarm_at, 'one-shot flag set');
  assert.equal(newOnes().length, 1);
  const ev = newOnes()[0];
  assert.equal(ev.state, 'ACTIVE');
  assert.equal(ev.callsign, 'Dan Whitfield', 'the person\'s actual name, not a radio callsign');

  const job = app.db.jobs.find((j) => j.emergency_id === ev.id);
  assert.ok(job, 'a RED job was raised for it, same as any other emergency');
  assert.equal(job.priority, 'RED');
  assert.equal(job.incident_type, 'NOT CLOCKED IN');
  assert.equal(job.location, site.name, 'no GPS fix, but the site is known and used instead of "location unknown"');

  assert.ok(app.db.audit_logs.some((e) => e.type === 'shift.not_clocked_in_alarm' && e.data.shift_id === s.id));

  app.attendance.tick(start + 12 * 60000);
  assert.equal(newOnes().length, 1, 'one-shot — never raises a second alarm for the same lateness');

  // The existing 15-minute control alert still fires on top of this — the
  // new alarm is additive, not a replacement.
  app.attendance.tick(start + 16 * 60000);
  assert.ok(a.late_alert_at);
});

/* ---------------- kit on vehicles ---------------- */
test('a first aid bag kept in a vehicle: the vehicle shows the bag and the plasters in it, with expiry; the check asks about the bag', async () => {
  const van = app.db.vehicles[0];
  const bag = (await call('POST', '/api/assets', { tag: 'FAB-01', description: 'First aid bag 01', category: 'FIRST_AID', vehicle_id: van.id }, adminT)).body;
  assert.equal(bag.vehicle_id, van.id);
  const loc = await call('POST', '/api/stock/locations', { name: 'First aid bag 01', kind: 'BAG', asset_id: bag.id }, adminT);
  assert.equal(loc.status, 201, JSON.stringify(loc.body));
  assert.equal((await call('POST', '/api/stock/locations', { name: 'Dup bag', kind: 'BAG', asset_id: bag.id }, adminT)).status, 409, 'one location per bag');
  const plasters = (await call('POST', '/api/assets', { description: 'Plasters', category: 'FIRST_AID', unit: 'each', is_stock_tracked: true }, adminT)).body;
  const soon = new Date(Date.now() + 10 * 86400e3).toISOString().slice(0, 10);
  await call('POST', `/api/stock/${plasters.id}/receive`, { quantity: 5, location_id: loc.body.id, batch_no: 'PL-1', expiry_date: soon }, adminT);
  assert.equal((await call('POST', '/api/assets', { description: 'x', category: 'FIRST_AID', is_stock_tracked: true, pat_required: true }, adminT)).status, 400, 'no PAT on stock');

  const kit = (await call('GET', `/api/vehicles/${van.id}/kit`, undefined, danT)).body;
  assert.deepEqual(kit.assets.map((a) => a.tag), ['FAB-01']);
  assert.equal(kit.locations[0].in_vehicle, van.registration, 'the bag is in the van because the bag asset is');
  assert.deepEqual(kit.locations[0].contents.map((c) => [c.item, c.qty, c.next_expiry, c.expiring_soon]), [['Plasters', 5, soon, true]]);
  const fleet = (await call('GET', '/api/fleet-dashboard', undefined, dispT)).body.vehicles.find((v) => v.id === van.id);
  assert.equal(fleet.kit.assets[0].tag, 'FAB-01');
  assert.equal(fleet.kit.expiring, 1);

  // Move the bag to another vehicle: its contents go with it.
  const other = app.db.vehicles[1];
  await call('PATCH', `/api/assets/${bag.id}`, { vehicle_id: other.id }, adminT);
  assert.equal((await call('GET', `/api/vehicles/${van.id}/kit`, undefined, danT)).body.locations.length, 0);
  assert.equal((await call('GET', `/api/vehicles/${other.id}/kit`, undefined, danT)).body.locations[0].contents[0].qty, 5);
  await call('PATCH', `/api/assets/${bag.id}`, { vehicle_id: van.id }, adminT);

  const ins = app.db.form_definitions.find((d) => d.key === 'vehicle-inspection');
  const sig = { mimetype: 'image/png', data: PNG, signer_name: 'Dan Whitfield' };
  const bad = await call('POST', '/api/form-submissions', { definition_id: ins.id, subject_type: 'VEHICLE', subject_id: van.id, values: { odometer: 1, fuel_level: 'Full', driver_signature: sig }, kit_check: [{ asset_id: 999, present: true }] }, danT);
  assert.equal(bad.status, 400, 'only the vehicle\'s own kit');
  const r = await call('POST', '/api/form-submissions', { definition_id: ins.id, subject_type: 'VEHICLE', subject_id: van.id, values: { odometer: 1, fuel_level: 'Full', driver_signature: sig }, kit_check: [{ asset_id: bag.id, present: false, note: 'not in the boot' }] }, danT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.kit_check[0].present, false);
  const after_ = (await call('GET', '/api/fleet-dashboard', undefined, dispT)).body.vehicles.find((v) => v.id === van.id);
  assert.ok(after_.last_inspection.issues.some((i) => /FAB-01: missing/.test(i)), 'the dashboard flags it');
  assert.ok((await call('GET', `/api/assets/${bag.id}/history`, undefined, adminT)).body.some((h) => h.type === 'MISSING_ON_CHECK'));
});

test('app closed: a reminder push, and when it reopens off site they are clocked out at the last time seen on site, flagged for control', async () => {
  const { a } = await shiftFor(-60);
  await call('POST', `/api/shift-assignments/${a.id}/clock-in`, { lat: 53.5, lon: -0.1 }, danT);
  await call('POST', `/api/shift-assignments/${a.id}/presence`, { lat: 53.5, lon: -0.1 }, danT);
  // The phone goes quiet: last report 40 minutes ago, on site.
  const seen = new Date(Date.now() - 40 * 60000).toISOString();
  a.clocked_in_at = new Date(Date.now() - 50 * 60000).toISOString();
  a.last_presence_at = seen; a.last_inside_at = seen;
  app.attendance.tick();
  assert.ok(a.presence_nudged_at, 'asked to open the app');
  const nudged = a.presence_nudged_at;
  app.attendance.tick(Date.now() + 60000);
  assert.equal(a.presence_nudged_at, nudged, 'not again within 30 minutes');
  assert.ok(!a.clocked_out_at, 'silence alone never clocks anyone out');

  const r = await call('POST', `/api/shift-assignments/${a.id}/presence`, { lat: 53.53, lon: -0.1 }, danT);
  assert.equal(r.body.clocked_out, true, JSON.stringify(r.body));
  assert.equal(a.clocked_out_at, seen, 'clocked out at the last time seen on site');
  assert.equal(a.clock_out_needs_review, true);
  assert.ok(app.db.audit_logs.some((e) => e.type === 'shift.auto_clocked_out' && /CHECK THE TIME/.test(e.summary || e.message || JSON.stringify(e))));
  await new Promise((res) => setTimeout(res, 50));
  assert.ok(app.db.dial_log.some((d) => d.personnel_id === dan.id && /last time your phone showed you on site/.test(d.body)));

  // Back on screen after only a minute away: the normal 5 minutes apply.
  const { a: b } = await shiftFor(-10);
  await call('POST', `/api/shift-assignments/${b.id}/clock-in`, { lat: 53.5, lon: -0.1 }, danT);
  await call('POST', `/api/shift-assignments/${b.id}/presence`, { lat: 53.5, lon: -0.1 }, danT);
  const r2 = await call('POST', `/api/shift-assignments/${b.id}/presence`, { lat: 53.53, lon: -0.1 }, danT);
  assert.equal(r2.body.clocked_out, undefined);
  assert.ok(!b.clocked_out_at);
});

test('control corrects clock times, with a reason, and the change is kept', async () => {
  const { a } = await shiftFor(-120, 3);
  await call('POST', `/api/shift-assignments/${a.id}/clock-in`, { lat: 53.5, lon: -0.1 }, danT);
  a.clock_out_needs_review = true; a.clocked_in_at = new Date(Date.now() - 100 * 60000).toISOString();
  const url = `/api/shift-assignments/${a.id}/times`;
  const out = new Date(Date.now() - 10 * 60000).toISOString();
  assert.equal((await call('PATCH', url, { clocked_out_at: out, reason: 'x' }, danT)).status, 403, 'officers cannot change their own times');
  assert.equal((await call('PATCH', url, { clocked_out_at: out }, dispT)).status, 400, 'a reason is needed');
  assert.equal((await call('PATCH', url, { clocked_out_at: '2000-01-01T00:00:00Z', reason: 'x' }, dispT)).status, 400, 'out before in');
  const r = await call('PATCH', url, { clocked_out_at: out, reason: 'left at 10 to, confirmed by supervisor' }, dispT);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(a.clocked_out_at, out);
  assert.equal(a.clock_out_needs_review, false);
  assert.equal(a.time_edits.length, 1);
  assert.equal(a.time_edits[0].from.out, null);
});
