/* Leave management (routes-leave.js) — node --test
 *
 * Self-service, mirroring the applicant-tracking and client-request
 * pipelines: a FIELD_USER requests their own leave, control approves or
 * rejects it, and only APPROVED annual leave ever touches the running
 * balance. The one hard rule worth its own tests: none of this applies to
 * a SUBCONTRACTOR, at any entry point. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4024';
process.env.AUTH_SECRET = 'leave-test-secret';
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

let adminT, dispT, danT, ellieT, mdtT, dan, ellie;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dispT = await login('dispatcher', 'dispatch123');
  danT = await login('dwhitfield', 'field123');
  ellieT = await login('emarsh', 'field123');
  mdtT = await login('mdt001', 'mdt123');
  dan = app.db.personnel.find((p) => p.name === 'Dan Whitfield');
  ellie = app.db.personnel.find((p) => p.name === 'Ellie Marsh');
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

test('an officer sees a leave balance by default, and it goes null the moment they\'re marked a subcontractor', async () => {
  const before_ = await call('GET', '/api/personnel', undefined, dispT);
  const danNow = before_.body.find((p) => p.id === dan.id);
  assert.equal(danNow.employment_type, 'EMPLOYED');
  assert.equal(danNow.leave_balance.allowance, 28, 'falls back to the statutory default when no allowance is set');
  assert.equal(danNow.leave_balance.taken, 0);

  const asSub = await call('PATCH', `/api/personnel/${dan.id}`, { employment_type: 'SUBCONTRACTOR' }, adminT);
  assert.equal(asSub.status, 200);
  assert.equal(asSub.body.leave_balance, null);
  assert.equal(asSub.body.annual_leave_allowance_days, null, 'switching to subcontractor clears any allowance on file');

  await call('PATCH', `/api/personnel/${dan.id}`, { employment_type: 'EMPLOYED' }, adminT);
  assert.equal((await call('PATCH', `/api/personnel/${dan.id}`, { employment_type: 'SUBCONTRACTOR', annual_leave_allowance_days: 20 }, adminT)).status, 400, 'a subcontractor cannot have an allowance set');
});

test('an officer can request their own leave, not someone else\'s; an MDT terminal cannot request leave at all', async () => {
  const own = await call('POST', '/api/leave-requests', { type: 'ANNUAL', start_date: '2027-01-04', end_date: '2027-01-08' }, danT);
  assert.equal(own.status, 201, JSON.stringify(own.body));
  assert.equal(own.body.status, 'PENDING');
  assert.equal(own.body.days, 5, 'inclusive day count when none is given');

  const spoofAttempt = await call('POST', '/api/leave-requests', { personnel: ellie.id, type: 'ANNUAL', start_date: '2027-02-01' }, danT);
  assert.equal(spoofAttempt.status, 201);
  assert.equal(spoofAttempt.body.personnel_id, dan.id, 'a field user\'s own personnel record is always used — body.personnel naming someone else is silently ignored, never honoured');

  assert.equal((await call('POST', '/api/leave-requests', { type: 'ANNUAL', start_date: '2027-03-01' }, mdtT)).status, 403);
  assert.equal((await call('GET', '/api/leave-requests', undefined, mdtT)).status, 403);
});

test('leave against a subcontractor is refused, whoever asks', async () => {
  const contractor = (await call('POST', '/api/personnel', { name: 'Contract Guard', employment_type: 'SUBCONTRACTOR' }, adminT)).body;
  assert.equal(contractor.employment_type, 'SUBCONTRACTOR');
  assert.equal((await call('POST', '/api/leave-requests', { personnel: contractor.id, type: 'ANNUAL', start_date: '2027-04-01' }, dispT)).status, 400);
});

test('rejecting requires a reason; approving and rejecting are control-only; the requester can cancel their own pending request but not approve it', async () => {
  const req = (await call('POST', '/api/leave-requests', { type: 'SICK', start_date: '2027-05-10', days: 1 }, ellieT)).body;

  assert.equal((await call('PATCH', `/api/leave-requests/${req.id}`, { status: 'APPROVED' }, ellieT)).status, 403, 'the requester cannot approve their own request');
  assert.equal((await call('PATCH', `/api/leave-requests/${req.id}`, { status: 'REJECTED' }, dispT)).status, 400, 'rejecting needs a reason');
  const rejected = await call('PATCH', `/api/leave-requests/${req.id}`, { status: 'REJECTED', rejection_reason: 'No cover available' }, dispT);
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.reviewed_by, 'Controller Hale');

  const req2 = (await call('POST', '/api/leave-requests', { type: 'UNPAID', start_date: '2027-06-01', days: 2 }, ellieT)).body;
  const cancelled = await call('PATCH', `/api/leave-requests/${req2.id}`, { status: 'CANCELLED' }, ellieT);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'CANCELLED');
});

test('only APPROVED annual leave counts against the balance — sick/unpaid/other never do, and pending/rejected don\'t either', async () => {
  const year = new Date().getFullYear();
  const before_ = (await call('GET', '/api/personnel', undefined, dispT)).body.find((p) => p.id === ellie.id).leave_balance.remaining;

  const sick = (await call('POST', '/api/leave-requests', { type: 'SICK', start_date: `${year}-06-01`, days: 3 }, ellieT)).body;
  await call('PATCH', `/api/leave-requests/${sick.id}`, { status: 'APPROVED' }, dispT);
  let bal = (await call('GET', '/api/personnel', undefined, dispT)).body.find((p) => p.id === ellie.id).leave_balance.remaining;
  assert.equal(bal, before_, 'approved sick leave does not touch the annual leave balance');

  const pending = (await call('POST', '/api/leave-requests', { type: 'ANNUAL', start_date: `${year}-07-01`, days: 5 }, ellieT)).body;
  bal = (await call('GET', '/api/personnel', undefined, dispT)).body.find((p) => p.id === ellie.id).leave_balance.remaining;
  assert.equal(bal, before_, 'a still-pending request does not touch the balance yet');

  await call('PATCH', `/api/leave-requests/${pending.id}`, { status: 'APPROVED' }, dispT);
  bal = (await call('GET', '/api/personnel', undefined, dispT)).body.find((p) => p.id === ellie.id).leave_balance.remaining;
  assert.equal(bal, before_ - 5, 'approving annual leave deducts it from the balance');
});

test('a shift against approved leave is flagged on the shift, never blocked at creation', async () => {
  const year = new Date().getFullYear() + 1;
  const typeId = (await call('GET', '/api/shift-types', undefined, dispT)).body[0].id;
  const leave = (await call('POST', '/api/leave-requests', { type: 'ANNUAL', start_date: `${year}-09-10`, end_date: `${year}-09-10` }, danT)).body;

  const shiftBeforeApproval = await call('POST', '/api/shifts', { personnel: dan.id, shift_type_id: typeId, starts_at: `${year}-09-10T09:00:00.000Z`, ends_at: `${year}-09-10T17:00:00.000Z` }, dispT);
  assert.equal(shiftBeforeApproval.status, 201);
  assert.equal(shiftBeforeApproval.body.assignments[0].on_leave_conflict, false, 'a merely-pending request is not a conflict yet');

  await call('PATCH', `/api/leave-requests/${leave.id}`, { status: 'APPROVED' }, dispT);
  const shifts = await call('GET', `/api/shifts?from=${year}-09-01T00:00:00.000Z&to=${year}-09-30T00:00:00.000Z`, undefined, dispT);
  const flagged = shifts.body.find((s) => s.id === shiftBeforeApproval.body.id);
  assert.equal(flagged.assignments[0].on_leave_conflict, true, 'the same shift is now flagged once the leave is approved — creation was never blocked, this is a warning');

  const clearDayShift = await call('POST', '/api/shifts', { personnel: dan.id, shift_type_id: typeId, starts_at: `${year}-09-11T09:00:00.000Z`, ends_at: `${year}-09-11T17:00:00.000Z` }, dispT);
  assert.equal(clearDayShift.body.assignments[0].on_leave_conflict, false, 'a shift the day after is unaffected');
});
