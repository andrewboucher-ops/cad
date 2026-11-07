/* Subcontractors with no personnel file (POST /api/subcontractors) — node --test
 *
 * Control puts a subcontractor on a rota shift with just a name, company,
 * SIA licence and phone. They must work on the shift like anyone else
 * (assignment, clock times, timesheet) while staying out of everything
 * that belongs to our own staff: staff numbers, onboarding, screening. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4140';
process.env.AUTH_SECRET = 'subcontractor-test-secret';
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

let adminT, dispT;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dispT = await login('dispatcher', 'dispatch123');
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

async function newShift(hoursAgoStart, hoursAgoEnd) {
  const type = (await call('GET', '/api/shift-types', undefined, adminT)).body[0];
  const site = (await call('GET', '/api/sites', undefined, adminT)).body[0];
  const now = Date.now();
  const r = await call('POST', '/api/shifts', {
    shift_type_id: type.id, site_id: site.id,
    starts_at: new Date(now - hoursAgoStart * 3600e3).toISOString(), ends_at: new Date(now - hoursAgoEnd * 3600e3).toISOString(),
  }, adminT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

test('an admin can add a subcontractor with only a name, and nobody else can', async () => {
  assert.equal((await call('POST', '/api/subcontractors', { name: '' }, adminT)).status, 400);
  assert.equal((await call('POST', '/api/subcontractors', { name: 'Not Allowed' }, dispT)).status, 403);
  const r = await call('POST', '/api/subcontractors', { name: 'Sam Cover', company: 'Acme Guarding Ltd', sia_licence_no: '1234 5678 9012 3456', contact_phone: '07700 900123' }, adminT);
  assert.equal(r.status, 201);
  assert.equal(r.body.external_sub, true);
  assert.equal(r.body.company, 'Acme Guarding Ltd');
  assert.equal(r.body.employment_type, 'SUBCONTRACTOR');
  assert.equal(r.body.employee_no, null, 'no staff number');
  assert.equal(r.body.has_login, false, 'no officer app sign-in');
  assert.equal(r.body.sia_licences[0].licence_no, '1234567890123456');
  assert.equal(r.body.onboarding, null, 'not on the onboarding checklist');
});

test('they go on a shift, get clocked in and out by control, and show on the timesheet', async () => {
  const sub = (await call('POST', '/api/subcontractors', { name: 'Timesheet Sub', company: 'Cover Co' }, adminT)).body;
  const s = await newShift(6, 1);
  const add = await call('POST', `/api/shifts/${s.id}/assignments`, { personnel: sub.id }, adminT);
  assert.equal(add.status, 201, JSON.stringify(add.body));
  const a = add.body.assignments.find((x) => x.personnel_id === sub.id);
  assert.ok(a);
  assert.equal((await call('POST', `/api/shift-assignments/${a.id}/clock-in`, {}, adminT)).status, 200);
  assert.equal((await call('POST', `/api/shift-assignments/${a.id}/clock-out`, {}, adminT)).status, 200);
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
  const rows = (await call('GET', `/api/timeclock/timesheet?from=${yesterday}&to=${today}&personnel_id=${sub.id}`, undefined, adminT)).body;
  assert.ok(rows.some((r) => r.assignment_id === a.id || r.id === a.id), 'their shift is on the timesheet');
});

test('a subcontractor can be put straight onto a new shift', async () => {
  const sub = (await call('POST', '/api/subcontractors', { name: 'New Shift Sub' }, adminT)).body;
  const type = (await call('GET', '/api/shift-types', undefined, adminT)).body[0];
  const start = Date.now() + 86400e3;
  const r = await call('POST', '/api/shifts', { shift_type_id: type.id, starts_at: new Date(start).toISOString(), ends_at: new Date(start + 8 * 3600e3).toISOString(), personnel: sub.id }, adminT);
  assert.equal(r.status, 201);
  assert.ok(r.body.assignments.some((x) => x.personnel_id === sub.id));
});

test('an expired SIA licence still blocks rostering them, same as staff', async () => {
  const sub = (await call('POST', '/api/subcontractors', { name: 'Expired Sub', sia_licence_no: '1111222233334444', sia_licence_expiry: '2020-01-01' }, adminT)).body;
  const s = await newShift(-24, -32);
  const r = await call('POST', `/api/shifts/${s.id}/assignments`, { personnel: sub.id }, adminT);
  assert.equal(r.status, 409);
});

test('they are left out of staff numbering and screening until given a full personnel file', async () => {
  const sub = (await call('POST', '/api/subcontractors', { name: 'Promote Me', company: 'Temp Co' }, adminT)).body;
  const assigned = (await call('POST', '/api/admin/staff-numbers/assign-missing', {}, adminT)).body.assigned;
  assert.ok(!assigned.some((x) => x.id === sub.id), 'assign-missing skips them');
  const overview = (await call('GET', '/api/screening/overview', undefined, adminT)).body;
  assert.ok(!overview.some((x) => x.id === sub.id), 'not on the screening list');

  const promoted = await call('PATCH', `/api/personnel/${sub.id}`, { external_sub: false }, adminT);
  assert.equal(promoted.status, 200);
  assert.equal(promoted.body.external_sub, false);
  assert.ok(promoted.body.employee_no, 'gets a staff number');
  assert.ok(promoted.body.onboarding, 'now on the onboarding checklist');
  const overview2 = (await call('GET', '/api/screening/overview', undefined, adminT)).body;
  assert.ok(overview2.some((x) => x.id === sub.id));
});

test('a subcontractor can be given an officer app sign-in, and then sees only their own shifts and record', async () => {
  const sub = (await call('POST', '/api/subcontractors', { name: 'Login Sub', company: 'Cover Co', contact_phone: '07700900456' }, adminT)).body;
  assert.equal((await call('POST', `/api/subcontractors/${sub.id}/login`, {}, dispT)).status, 403);
  const r = await call('POST', `/api/subcontractors/${sub.id}/login`, {}, adminT);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.username, 'login.sub');
  assert.equal(r.body.created, true);
  assert.ok(r.body.link.includes('/set-password.html?for=officer'));
  const token = new URL(r.body.link).searchParams.get('token');
  assert.equal((await call('POST', '/api/auth/set-password', { token, password: 'Cover-Shift-2026!' })).status, 200);
  const subT = await login('login.sub', 'Cover-Shift-2026!');
  assert.ok(subT, 'they can sign in');

  const mine = await newShift(2, -6);
  await call('POST', `/api/shifts/${mine.id}/assignments`, { personnel: sub.id }, adminT);
  const other = await newShift(3, -5);
  const shifts = (await call('GET', '/api/shifts', undefined, subT)).body;
  assert.ok(shifts.some((s) => s.id === mine.id), 'their own shift');
  assert.ok(!shifts.some((s) => s.id === other.id), 'not other shifts');
  const people = (await call('GET', '/api/personnel', undefined, subT)).body;
  assert.deepEqual(people.map((p) => p.id), [sub.id], 'only their own record');

  const again = await call('POST', `/api/subcontractors/${sub.id}/login`, {}, adminT);
  assert.equal(again.body.username, 'login.sub');
  assert.equal(again.body.created, false, 'a resend reuses the same login');
  assert.equal((await call('POST', '/api/auth/set-password', { token, password: 'Another-Pass-2026!' })).status, 400, 'the first link is used up');
});

test('the sign-in route is only for quick-added subcontractors', async () => {
  const staff = (await call('POST', '/api/personnel', { name: 'Normal Staff Member' }, adminT)).body;
  assert.equal((await call('POST', `/api/subcontractors/${staff.id}/login`, {}, adminT)).status, 404);
});

test('when no text goes out, the reply says why', async () => {
  const none = (await call('POST', '/api/subcontractors', { name: 'No Phone Sub' }, adminT)).body;
  const a = (await call('POST', `/api/subcontractors/${none.id}/login`, {}, adminT)).body;
  assert.equal(a.sms, false);
  assert.match(a.sms_problem, /no phone number/);
  const bad = (await call('POST', '/api/subcontractors', { name: 'Bad Phone Sub', contact_phone: '12345' }, adminT)).body;
  assert.match((await call('POST', `/api/subcontractors/${bad.id}/login`, {}, adminT)).body.sms_problem, /isn't a UK mobile/);
  const ok = (await call('POST', '/api/subcontractors', { name: 'Test Mode Sub', contact_phone: '07700900789' }, adminT)).body;
  assert.match((await call('POST', `/api/subcontractors/${ok.id}/login`, {}, adminT)).body.sms_problem, /test mode/);
});
