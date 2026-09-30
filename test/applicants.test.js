/* Applicant tracking (routes-applicants.js) — node --test
 *
 * Pure back-office HR data, gated to CONTROL not ALL: a FIELD_USER has no
 * legitimate reason to see the recruitment pipeline. The one action worth
 * its own dedicated tests is /hire — the actual point of the feature,
 * where a candidate becomes a real personnel record that the rest of
 * CCCS then picks up. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4022';
process.env.AUTH_SECRET = 'applicants-test-secret';
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

let adminT, dispT, danT;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dispT = await login('dispatcher', 'dispatch123');
  danT = await login('dwhitfield', 'field123');
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

test('applicant tracking is CONTROL-gated, not ALL — a field user has no route into it', async () => {
  assert.equal((await call('GET', '/api/applicants', undefined, danT)).status, 403);
  assert.equal((await call('POST', '/api/applicants', { name: 'x' }, danT)).status, 403);
});

test('an applicant can be created, updated, and moved through the pipeline; status cannot be set to HIRED by a plain PATCH', async () => {
  const a = await call('POST', '/api/applicants', { name: 'Jordan Casey', email: 'jordan@example.com', role_applied_for: 'Patrol Officer', source: 'Referral' }, dispT);
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(a.body.status, 'APPLIED');

  assert.equal((await call('POST', '/api/applicants', { name: '' }, adminT)).status, 400, 'name required');
  assert.equal((await call('POST', '/api/applicants', { name: 'Bad Email', email: 'not-an-email' }, adminT)).status, 400);

  const toInterview = await call('PATCH', `/api/applicants/${a.body.id}`, { status: 'INTERVIEW', interview_at: new Date(Date.now() + 86400000).toISOString() }, dispT);
  assert.equal(toInterview.status, 200);
  assert.equal(toInterview.body.status, 'INTERVIEW');
  assert.ok(toInterview.body.interview_at);

  assert.equal((await call('PATCH', `/api/applicants/${a.body.id}`, { status: 'HIRED' }, adminT)).status, 400, 'HIRED must go through /hire');

  const rejectNoReason = await call('PATCH', `/api/applicants/${a.body.id}`, { status: 'REJECTED' }, dispT);
  assert.equal(rejectNoReason.status, 400, 'rejecting needs a reason');
  const rejected = await call('PATCH', `/api/applicants/${a.body.id}`, { status: 'REJECTED', rejected_reason: 'Did not meet experience requirement' }, dispT);
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.rejected_reason, 'Did not meet experience requirement');
});

test('notes are append-only and attributed to the author', async () => {
  const a = (await call('POST', '/api/applicants', { name: 'Notes Test' }, dispT)).body;
  const n1 = await call('POST', `/api/applicants/${a.id}/notes`, { body: 'Phone screen went well.' }, dispT);
  assert.equal(n1.status, 200);
  assert.equal(n1.body.notes_log.length, 1);
  assert.equal(n1.body.notes_log[0].author, 'Controller Hale');
  const n2 = await call('POST', `/api/applicants/${a.id}/notes`, { body: 'Interview scheduled.' }, adminT);
  assert.equal(n2.body.notes_log.length, 2, 'notes accumulate, never replace');
  assert.equal((await call('POST', `/api/applicants/${a.id}/notes`, { body: '' }, dispT)).status, 400);
});

test('hiring creates a real personnel record and is blocked for a rejected/withdrawn or already-hired candidate', async () => {
  const a = (await call('POST', '/api/applicants', { name: 'Sam Rivera', email: 'sam.rivera@example.com', phone: '07700900555', role_applied_for: 'Static Guard' }, dispT)).body;

  assert.equal((await call('POST', `/api/applicants/${a.id}/hire`, {}, dispT)).status, 403, 'hiring is ADMIN only');

  const hired = await call('POST', `/api/applicants/${a.id}/hire`, { employee_no: 'EMP-APP-1' }, adminT);
  assert.equal(hired.status, 201, JSON.stringify(hired.body));
  assert.equal(hired.body.applicant.status, 'HIRED');
  assert.equal(hired.body.personnel.name, 'Sam Rivera');
  assert.equal(hired.body.personnel.rank, 'Static Guard', 'falls back to role_applied_for when rank is not given');
  assert.equal(hired.body.personnel.contact_phone, '07700900555');
  assert.equal(hired.body.applicant.hired_personnel_id, hired.body.personnel.id);

  const personnelList = await call('GET', '/api/personnel', undefined, dispT);
  assert.ok(personnelList.body.some((p) => p.id === hired.body.personnel.id), 'the new hire is a real, ordinary personnel record');

  assert.equal((await call('POST', `/api/applicants/${a.id}/hire`, {}, adminT)).status, 409, 'already hired');

  const rejectedApplicant = (await call('POST', '/api/applicants', { name: 'Rejected Candidate' }, dispT)).body;
  await call('PATCH', `/api/applicants/${rejectedApplicant.id}`, { status: 'REJECTED', rejected_reason: 'x' }, dispT);
  assert.equal((await call('POST', `/api/applicants/${rejectedApplicant.id}/hire`, {}, adminT)).status, 409, 'cannot hire a rejected candidate without reopening them first');
});

test('a hired applicant cannot be deleted; others can', async () => {
  const hireMe = (await call('POST', '/api/applicants', { name: 'To Be Hired' }, dispT)).body;
  const hired = await call('POST', `/api/applicants/${hireMe.id}/hire`, {}, adminT);
  assert.equal((await call('DELETE', `/api/applicants/${hireMe.id}`, undefined, adminT)).status, 409);

  const disposable = (await call('POST', '/api/applicants', { name: 'Disposable' }, dispT)).body;
  assert.equal((await call('DELETE', `/api/applicants/${disposable.id}`, undefined, dispT)).status, 403, 'delete is ADMIN only');
  assert.equal((await call('DELETE', `/api/applicants/${disposable.id}`, undefined, adminT)).status, 200);
});

test('a CV upload is magic-byte checked and downloadable', async () => {
  const a = (await call('POST', '/api/applicants', { name: 'CV Test' }, dispT)).body;
  const fakeContent = Buffer.from('not a pdf').toString('base64');
  assert.equal((await call('POST', `/api/applicants/${a.id}/cv`, { mimetype: 'application/pdf', data: fakeContent }, adminT)).status, 400);

  const realPdf = Buffer.from('%PDF-1.4 minimal').toString('base64');
  const uploaded = await call('POST', `/api/applicants/${a.id}/cv`, { mimetype: 'application/pdf', filename: 'resume.pdf', data: realPdf }, dispT);
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
  assert.equal(uploaded.body.cv.filename, 'resume.pdf');

  const res = await fetch(`${BASE}/api/applicants/${a.id}/cv`, { headers: { authorization: `Bearer ${dispT}` } });
  assert.equal(res.status, 200);
});
