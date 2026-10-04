/* Menu sections per role, the mobile Active users list, correcting a filed
 * vehicle report, and the incident report form — node --test */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4031';
process.env.AUTH_SECRET = 'mobile-test-secret';
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
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const sig = (name) => ({ mimetype: 'image/png', data: PNG, signer_name: name });
const keys = (rows) => rows.map((s) => s.key);

let adminT, dispT, danT, dan;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dispT = await login('dispatcher', 'dispatch123');
  danT = await login('dwhitfield', 'field123');
  dan = app.db.personnel.find((p) => p.name === 'Dan Whitfield');
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

/* ---------------- sections ---------------- */
test('each role gets its own menu: no control room or admin for an officer, active users for control only by default', async () => {
  const officer = keys((await call('GET', '/api/ui/sections', undefined, danT)).body);
  const disp = keys((await call('GET', '/api/ui/sections', undefined, dispT)).body);
  const admin = keys((await call('GET', '/api/ui/sections', undefined, adminT)).body);
  for (const k of ['my_shift', 'messages', 'incident_report', 'vehicle_check', 'fuel_up', 'deep_clean', 'rota', 'reports']) assert.ok(officer.includes(k), `officer sees ${k}`);
  for (const k of ['control', 'dashboard', 'admin', 'active_users', 'log']) assert.ok(!officer.includes(k), `officer does not see ${k}`);
  assert.ok(disp.includes('control') && disp.includes('active_users') && !disp.includes('admin'));
  assert.ok(admin.includes('admin') && admin.includes('client_portals'));
  assert.equal((await call('GET', '/api/ui/sections')).status, 401, 'needs a login');
});

test('an admin chooses who sees what — within what each page can serve, never locking admins out', async () => {
  assert.equal((await call('GET', '/api/admin/ui-sections', undefined, dispT)).status, 403);
  const bad = await call('PUT', '/api/admin/ui-sections', { visible_to: { control: ['FIELD_USER'] } }, adminT);
  assert.equal(bad.status, 400, 'the control room cannot be given to officers');
  assert.equal((await call('PUT', '/api/admin/ui-sections', { visible_to: { nope: [] } }, adminT)).status, 400);

  const r = await call('PUT', '/api/admin/ui-sections', { visible_to: { active_users: ['FIELD_USER', 'SUPERVISOR', 'SYSTEM_ADMIN'], fuel_up: ['DISPATCHER'], admin: [] } }, adminT);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const officer = keys((await call('GET', '/api/ui/sections', undefined, danT)).body);
  assert.ok(officer.includes('active_users'), 'officers can now see active users');
  assert.ok(!officer.includes('fuel_up'), 'and no longer fuel up');
  assert.ok(!keys((await call('GET', '/api/ui/sections', undefined, dispT)).body).includes('active_users'), 'dispatchers lost it');
  assert.ok(keys((await call('GET', '/api/ui/sections', undefined, adminT)).body).includes('admin'), 'Admin stays for admins whatever was sent');
  assert.ok(app.db.audit_logs.some((e) => e.type === 'ui.sections_updated'), 'the change is logged');
  // Put the defaults back for the other tests.
  const all = (await call('GET', '/api/admin/ui-sections', undefined, adminT)).body.sections;
  await call('PUT', '/api/admin/ui-sections', { visible_to: Object.fromEntries(all.map((s) => [s.key, s.default])) }, adminT);
});

/* ---------------- active users ---------------- */
test('active users lists who is working with a phone to call — and the server, not the menu, decides who may see it', async () => {
  dan.contact_phone = '07700 900456';
  const w = await call('POST', `/api/personnel/${dan.id}/welfare`, { interval_s: 600, note: 'Internal patrol' }, danT);
  assert.equal(w.status, 200, JSON.stringify(w.body));
  const r = await call('GET', '/api/mobile/active-users', undefined, dispT);
  assert.equal(r.status, 200);
  const row = r.body.find((x) => x.id === dan.id);
  assert.ok(row, 'someone on a welfare timer counts as working');
  assert.equal(row.phone, '07700 900456');
  assert.ok(row.welfare_due_at);
  assert.equal((await call('GET', '/api/mobile/active-users', undefined, danT)).status, 403, 'officers cannot by default');

  await call('PUT', '/api/admin/ui-sections', { visible_to: { active_users: ['FIELD_USER', 'DISPATCHER', 'SUPERVISOR', 'SYSTEM_ADMIN'] } }, adminT);
  const mine = await call('GET', '/api/mobile/active-users', undefined, danT);
  assert.equal(mine.status, 200, 'once an admin allows it');
  assert.equal(mine.body.find((x) => x.id === dan.id).is_me, true);
  await call('PUT', '/api/admin/ui-sections', { visible_to: { active_users: ['DISPATCHER', 'SUPERVISOR', 'SYSTEM_ADMIN'] } }, adminT);
  await call('DELETE', `/api/personnel/${dan.id}/welfare`, {}, danT);
  const after_ = (await call('GET', '/api/mobile/active-users', undefined, dispT)).body;
  assert.ok(!after_.some((x) => x.id === dan.id && !x.on_rota && !x.task), 'off duty and off the rota: not listed');
});

/* ---------------- correcting a vehicle report ---------------- */
test('a mistyped fuel-up is corrected: the report keeps the history, the fuel log follows and the bad mileage is taken back out', async () => {
  const v = app.db.vehicles[0];
  v.mileage = 20000;
  const fuel = app.db.form_definitions.find((d) => d.key === 'vehicle-fuel-up');
  const r = await call('POST', '/api/form-submissions', { definition_id: fuel.id, subject_type: 'VEHICLE', subject_id: v.id, values: {
    odometer: 210450, litres: 40, cost: 58, fuel_type: 'Diesel', driver_signature: sig('Dan Whitfield'),
  } }, danT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(v.mileage, 210450, 'the typo went forward, so it was applied');
  assert.equal((await call('GET', `/api/form-submissions/${r.body.id}`, undefined, danT)).body.editable, true, 'the filer may edit it for now');

  assert.equal((await call('PATCH', `/api/form-submissions/${r.body.id}`, { values: { odometer: 21045 } }, danT)).status, 400, 'a reason is required');
  assert.equal((await call('PATCH', `/api/form-submissions/${r.body.id}`, { values: { driver_signature: sig('X') }, reason: 'x' }, danT)).status, 400, 'signatures cannot be changed');
  assert.equal((await call('PATCH', `/api/form-submissions/${r.body.id}`, { values: { odometer: 21045 }, reason: 'typo' }, dispT)).status, 403, 'someone else (not an admin) cannot');

  const e = await call('PATCH', `/api/form-submissions/${r.body.id}`, { values: { odometer: 21045, litres: 41.5 }, reason: 'odometer mistyped' }, danT);
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.equal(e.body.values.odometer, 21045);
  assert.equal(e.body.amendments.length, 1);
  assert.deepEqual(e.body.amendments[0].changes.map((c) => [c.field, c.from, c.to]), [['odometer', 210450, 21045], ['litres', 40, 41.5]]);
  assert.equal(e.body.amendments[0].reason, 'odometer mistyped');
  assert.equal(v.mileage, 21045, 'mileage set by the typo is put right');
  const log = app.db.fuel_logs.find((f) => f.form_submission_id === r.body.id);
  assert.deepEqual([log.odometer, log.litres], [21045, 41.5], 'the linked fuel log follows');
  assert.ok(app.db.audit_logs.some((x) => x.type === 'form.amended' && x.data.submission_id === r.body.id));
  assert.equal((await call('PATCH', `/api/form-submissions/${r.body.id}`, { values: { odometer: 21045 }, reason: 'again' }, danT)).status, 400, 'nothing changed');

  // Actioned: the filer can no longer edit it; an admin still can.
  await call('POST', `/api/form-submissions/${r.body.id}/action`, { outcome: 'NOTED' }, adminT);
  assert.equal((await call('PATCH', `/api/form-submissions/${r.body.id}`, { values: { cost: 60 }, reason: 'receipt' }, danT)).status, 403);
  assert.equal((await call('PATCH', `/api/form-submissions/${r.body.id}`, { values: { cost: 60 }, reason: 'receipt' }, adminT)).status, 200);
});

test('a correction never lowers mileage that another record set, and a deep clean date can be corrected', async () => {
  const v = app.db.vehicles[1];
  const ins = app.db.form_definitions.find((d) => d.key === 'vehicle-inspection');
  v.mileage = 5000;
  const r = await call('POST', '/api/form-submissions', { definition_id: ins.id, subject_type: 'VEHICLE', subject_id: v.id, values: { odometer: 5100, fuel_level: 'Full', driver_signature: sig('Dan Whitfield') } }, danT);
  v.mileage = 6000; // a later record moved it on
  await call('PATCH', `/api/form-submissions/${r.body.id}`, { values: { odometer: 5050 }, reason: 'misread' }, danT);
  assert.equal(v.mileage, 6000, 'untouched — this report was not what set it');

  const clean = app.db.form_definitions.find((d) => d.key === 'vehicle-deep-clean');
  delete v.deep_clean_at;
  const wrong = new Date(Date.now() + 5 * 86400e3).toISOString(); // a future date by mistake
  const c = await call('POST', '/api/form-submissions', { definition_id: clean.id, subject_type: 'VEHICLE', subject_id: v.id, values: { cleaned_at: wrong, interior: true, cleaner_signature: sig('Dan Whitfield') } }, danT);
  assert.equal(v.deep_clean_at, wrong);
  const right = new Date(Date.now() - 3600e3).toISOString();
  const e = await call('PATCH', `/api/form-submissions/${c.body.id}`, { values: { cleaned_at: right }, reason: 'wrong day picked' }, danT);
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.equal(v.deep_clean_at, right, 'the clean date follows the correction, even backwards');
  assert.equal((await call('PATCH', `/api/form-submissions/${c.body.id}`, { values: { interior: false }, reason: 'x' }, danT)).status, 400, 'a required tick cannot be removed');
});

test('only vehicle reports can be edited — statements stay as filed', async () => {
  const incident = app.db.form_definitions.find((d) => d.key === 'incident-report');
  assert.ok(incident && incident.active, 'the incident report form is installed');
  const site = app.db.sites[0];
  const r = await call('POST', '/api/form-submissions', { definition_id: incident.id, subject_type: 'SITE', subject_id: site.id, values: {
    occurred_at: new Date().toISOString(), severity: 'MEDIUM', incident_type: 'Trespass', description: 'Two people on the roof', officer_signature: sig('Dan Whitfield'),
  } }, danT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await call('GET', `/api/form-submissions/${r.body.id}`, undefined, adminT)).body.editable, false);
  assert.equal((await call('PATCH', `/api/form-submissions/${r.body.id}`, { values: { description: 'changed' }, reason: 'x' }, adminT)).status, 400);
});

test('the rota calendar feed is reachable by its link alone', async () => {
  const { url } = (await call('GET', '/api/me/ical-feed', undefined, danT)).body;
  const res = await fetch(BASE + new URL(url).pathname);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/calendar/);
  assert.match(await res.text(), /^BEGIN:VCALENDAR/);
});
