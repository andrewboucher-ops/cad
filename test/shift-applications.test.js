/* Shift applications (routes-shift-applications.js) — node --test
 *
 * Self-service, mirroring leave.test.js's shape: a FIELD_USER applies for
 * their own shift, control shortlists/approves/rejects, and approving is
 * the one action with a real side effect — it creates the actual
 * assignment and can expire everyone else still waiting on the same
 * now-impossible vacancy. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4025';
process.env.AUTH_SECRET = 'shift-apps-test-secret';
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

let adminT, dispT, danT, ellieT, ryanT, dan, ellie, ryan, patrolTypeId;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dispT = await login('dispatcher', 'dispatch123');
  danT = await login('dwhitfield', 'field123');
  ellieT = await login('emarsh', 'field123');
  ryanT = await login('rcole', 'field123');
  dan = app.db.personnel.find((p) => p.name === 'Dan Whitfield');
  ellie = app.db.personnel.find((p) => p.name === 'Ellie Marsh');
  ryan = app.db.personnel.find((p) => p.name === 'Ryan Cole');
  patrolTypeId = app.db.shift_types.find((t) => t.key === 'MOBILE_PATROL').id;
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

function future(hours) { return new Date(Date.now() + hours * 3600000).toISOString(); }

async function openShift(headcount = 1) {
  const r = await call('POST', '/api/shifts', { shift_type_id: patrolTypeId, required_headcount: headcount, starts_at: future(24), ends_at: future(32) }, dispT);
  return r.body;
}

test('an officer applies for an open shift, not a full or already-joined one, and sees it in Available Shifts', async () => {
  const shift = await openShift(1);
  const available = await call('GET', '/api/shifts/available', undefined, danT);
  assert.ok(available.body.some((s) => s.id === shift.id), 'an unfilled published shift shows up as available');

  const applied = await call('POST', '/api/shift-applications', { shift: shift.id }, danT);
  assert.equal(applied.status, 201);
  assert.equal(applied.body.status, 'APPLIED');
  assert.equal(applied.body.personnel_name, 'Dan Whitfield');

  assert.equal((await call('POST', '/api/shift-applications', { shift: shift.id }, danT)).status, 409, 'cannot apply twice');
  const availableAfter = await call('GET', '/api/shifts/available', undefined, danT);
  assert.ok(!availableAfter.body.some((s) => s.id === shift.id), 'no longer shown as available once applied');

  await call('POST', `/api/shifts/${shift.id}/assignments`, { personnel: ellie.id }, dispT);
  assert.equal((await call('POST', '/api/shift-applications', { shift: shift.id }, ryanT)).status, 400, 'a now-full shift refuses a new application');
});

test('control cannot apply on its own behalf — only direct assignment', async () => {
  const shift = await openShift(1);
  assert.equal((await call('POST', '/api/shift-applications', { shift: shift.id }, dispT)).status, 403);
});

test('approving an application creates the real assignment and expires the other applicants once the shift is full', async () => {
  const shift = await openShift(1);
  const danApp = (await call('POST', '/api/shift-applications', { shift: shift.id }, danT)).body;
  const ellieApp = (await call('POST', '/api/shift-applications', { shift: shift.id }, ellieT)).body;

  assert.equal((await call('PATCH', `/api/shift-applications/${danApp.id}`, { status: 'APPROVED' }, danT)).status, 403, 'an officer cannot approve their own application');
  const approved = await call('PATCH', `/api/shift-applications/${danApp.id}`, { status: 'APPROVED' }, dispT);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.reviewed_by, 'Controller Hale');

  const shiftNow = (await call('GET', `/api/shifts?personnel_id=${dan.id}`, undefined, dispT)).body.find((s) => s.id === shift.id);
  assert.ok(shiftNow.assignments.some((a) => a.personnel_id === dan.id), 'approval actually assigned Dan to the shift');

  const ellieAppNow = await call('GET', '/api/shift-applications', undefined, ellieT);
  assert.equal(ellieAppNow.body.find((a) => a.id === ellieApp.id).status, 'EXPIRED', 'the other applicant is told the vacancy is gone, not left pending forever');
});

test('rejecting requires a reason; the requester can withdraw their own pending application but not a resolved one', async () => {
  const shift = await openShift(2);
  const app1 = (await call('POST', '/api/shift-applications', { shift: shift.id }, danT)).body;
  assert.equal((await call('PATCH', `/api/shift-applications/${app1.id}`, { status: 'REJECTED' }, dispT)).status, 400, 'rejecting needs a reason');
  const rejected = await call('PATCH', `/api/shift-applications/${app1.id}`, { status: 'REJECTED', rejection_reason: 'Not enough recent patrol hours' }, dispT);
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.status, 'REJECTED');
  assert.equal((await call('PATCH', `/api/shift-applications/${app1.id}`, { status: 'WITHDRAWN' }, danT)).status, 409, 'cannot withdraw an already-resolved application');

  const app2 = (await call('POST', '/api/shift-applications', { shift: shift.id }, ellieT)).body;
  const withdrawn = await call('PATCH', `/api/shift-applications/${app2.id}`, { status: 'WITHDRAWN' }, ellieT);
  assert.equal(withdrawn.status, 200);
  assert.equal(withdrawn.body.status, 'WITHDRAWN');
});

test('control can shortlist an application, and an unresolved application expires if the shift is cancelled or deleted', async () => {
  const shift1 = await openShift(1);
  const app1 = (await call('POST', '/api/shift-applications', { shift: shift1.id }, danT)).body;
  const shortlisted = await call('PATCH', `/api/shift-applications/${app1.id}`, { status: 'SHORTLISTED' }, dispT);
  assert.equal(shortlisted.body.status, 'SHORTLISTED');
  await call('PATCH', `/api/shifts/${shift1.id}`, { status: 'CANCELLED' }, dispT);
  const afterCancel = await call('GET', '/api/shift-applications', undefined, danT);
  assert.equal(afterCancel.body.find((a) => a.id === app1.id).status, 'EXPIRED', 'cancelling the shift expires a shortlisted application too');

  const shift2 = await openShift(1);
  const app2 = (await call('POST', '/api/shift-applications', { shift: shift2.id }, danT)).body;
  await call('DELETE', `/api/shifts/${shift2.id}`, undefined, adminT);
  const afterDelete = await call('GET', '/api/shift-applications', undefined, danT);
  assert.equal(afterDelete.body.find((a) => a.id === app2.id).status, 'EXPIRED', 'deleting the shift expires it too, even though the shift itself is gone');
});

test('a draft shift never appears as available, and applying to one is refused', async () => {
  const draft = (await call('POST', '/api/shifts', { shift_type_id: patrolTypeId, starts_at: future(24), ends_at: future(32), status: 'DRAFT' }, dispT)).body;
  const available = await call('GET', '/api/shifts/available', undefined, danT);
  assert.ok(!available.body.some((s) => s.id === draft.id));
  assert.equal((await call('POST', '/api/shift-applications', { shift: draft.id }, danT)).status, 400);
  await call('DELETE', `/api/shifts/${draft.id}`, undefined, adminT);
});
