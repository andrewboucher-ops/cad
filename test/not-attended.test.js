/* Not-attended jobs: control raises a job, deals with it without sending
 * anyone, and closes it with a reason. The client sees the reason and the
 * notes control shared, and the job is never invoiced — node --test */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4151';
process.env.AUTH_SECRET = 'not-attended-test-secret';
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
  app.mailer.send = async () => ({ ok: true });
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

test('control marks a job not attended with a reason; the client sees the reason and only the shared notes', async () => {
  const site = (await call('POST', '/api/sites', { name: 'Not Attended Site' }, adminT)).body;
  const client = (await call('POST', '/api/clients', { name: 'Not Attended Ltd', site_ids: [site.id] }, adminT)).body;
  await call('POST', '/api/users', { username: 'naclient', password: 'realpassword1', role: 'CLIENT', client_id: client.id }, adminT);
  const clientT = await login('naclient', 'realpassword1');

  const job = (await call('POST', '/api/jobs', { priority: 'AMBER', incident_type: 'Alarm activation', location: 'Rear door', site: site.id }, dispT)).body;
  assert.ok(job.id);

  // A reason is required.
  assert.equal((await call('POST', `/api/jobs/${job.id}/not-attended`, { reason: '' }, dispT)).status, 400);

  // An internal note stays internal.
  await call('POST', `/api/jobs/${job.id}/notes`, { text: 'Keyholder Mr Smith 07700 900000' }, dispT);

  const r = await call('POST', `/api/jobs/${job.id}/not-attended`, { reason: 'Keyholder confirmed false alarm', client_note: 'Cameras checked remotely at 02:14, all clear.' }, dispT);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'CANCELLED');
  assert.equal(r.body.not_attended, true);
  assert.ok(r.body.closed_at);
  assert.equal(r.body.awaiting_close, false);

  // Can't be done twice.
  assert.equal((await call('POST', `/api/jobs/${job.id}/not-attended`, { reason: 'again' }, dispT)).status, 409);

  // A note added afterwards and marked for the client shows; then hiding it removes it.
  const withNote = (await call('POST', `/api/jobs/${job.id}/notes`, { text: 'Client called back, happy.', client_visible: true }, dispT)).body;
  const later = withNote.note_entries.at(-1);
  assert.equal(later.client_visible, true);

  let mine = (await call('GET', `/api/client/jobs?site_id=${site.id}`, undefined, clientT)).body.find((j) => j.id === job.id);
  assert.equal(mine.not_attended, true);
  assert.equal(mine.not_attended_reason, 'Keyholder confirmed false alarm');
  const texts = mine.client_notes.map((n) => n.text);
  assert.ok(texts.includes('Cameras checked remotely at 02:14, all clear.'));
  assert.ok(texts.includes('Client called back, happy.'));
  assert.ok(!texts.some((t) => /Mr Smith/.test(t)), 'internal notes never reach the client');
  assert.ok(!JSON.stringify(mine).includes('by_name'), 'who wrote a note is not shown');

  assert.equal((await call('PATCH', `/api/jobs/${job.id}/notes/${later.id}`, { client_visible: false }, dispT)).status, 200);
  mine = (await call('GET', `/api/client/jobs?site_id=${site.id}`, undefined, clientT)).body.find((j) => j.id === job.id);
  assert.ok(!mine.client_notes.some((n) => n.text === 'Client called back, happy.'));

  // A client can't use the control routes.
  assert.equal((await call('POST', `/api/jobs/${job.id}/not-attended`, { reason: 'nope' }, clientT)).status, 403);

  // The service report counts it separately from plain cancellations.
  const rep = (await call('GET', `/api/client/sites/${site.id}/report`, undefined, clientT)).body;
  assert.equal(rep.jobs.not_attended, 1);
  assert.equal(rep.jobs.cancelled, 0);
});

test('a job an officer arrived at, or that was completed, cannot be marked not attended', async () => {
  const site = (await call('POST', '/api/sites', { name: 'Attended Site' }, adminT)).body;
  const job = (await call('POST', '/api/jobs', { priority: 'AMBER', incident_type: 'Alarm', location: 'Gate', site: site.id }, dispT)).body;
  app.db.jobs.find((j) => j.id === job.id).on_scene_at = new Date().toISOString();
  assert.equal((await call('POST', `/api/jobs/${job.id}/not-attended`, { reason: 'test reason' }, dispT)).status, 409);
});

test('a not-attended job is listed on an Alarm Response invoice with its reason, but never charged', async () => {
  let type = app.db.shift_types.find((t) => t.key === 'ALARM_RESPONSE');
  if (!type) { type = { id: 9101, key: 'ALARM_RESPONSE', name: 'Alarm Response', active: true }; app.db.shift_types.push(type); }
  const site = (await call('POST', '/api/sites', { name: 'NA Billing Site' }, adminT)).body;
  await call('POST', '/api/clients', { name: 'NA Billing Ltd', contact_email: 'na@example.test', site_ids: [site.id] }, adminT);
  const c = (await call('POST', '/api/agreements', { kind: 'CONTRACT', site_id: site.id, start_date: '2026-02-01', lines: [
    { description: 'Alarm Response', kind: 'HOURLY', rate: 45, shift_type_id: type.id },
  ] }, adminT)).body;
  await call('POST', `/api/agreements/${c.id}/mark-signed`, { name: 'Test' }, adminT);

  const officer = app.db.personnel[0];
  const attended = await call('POST', '/api/jobs', { site: site.id, incident_type: 'ALARM', retrospective: true, reason: 'radio only',
    created_at: '2026-02-10T22:00:00Z', on_scene_at: '2026-02-10T22:20:00Z', completed_at: '2026-02-10T23:05:00Z', resources: [officer.id] }, adminT);
  assert.equal(attended.status, 201, JSON.stringify(attended.body));
  const na = (await call('POST', '/api/jobs', { site: site.id, incident_type: 'ALARM', location: 'Front' }, dispT)).body;
  assert.equal((await call('POST', `/api/jobs/${na.id}/not-attended`, { reason: 'CCTV check, all clear' }, dispT)).status, 200);
  app.db.jobs.find((j) => j.id === na.id).created_at = '2026-02-12T03:00:00Z';

  const g = await call('POST', '/api/invoices/generate', { from: '2026-02-01', to: '2026-02-28', contract_id: c.id }, adminT);
  assert.equal(g.status, 200, JSON.stringify(g.body));
  const line = g.body.made[0].lines.find((l) => l.kind === 'HOURLY');
  assert.equal(line.shifts.length, 2, 'the not-attended call is listed too');
  const row = line.shifts.find((x) => x.job_id === na.id);
  assert.equal(row.hours, 0, 'but never charged');
  assert.match(row.source, /not attended: CCTV check, all clear — not charged/);
  assert.equal(line.quantity, 1, 'only the attended job is charged');
  const pdf = await call('GET', `/api/invoices/${g.body.made[0].id}/pdf`, undefined, adminT, true);
  assert.equal(pdf.status, 200);
});
