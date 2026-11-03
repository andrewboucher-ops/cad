/* Patient report forms: access rules, finalise lock, audit chain. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = process.env.TEST_PRF_PORT || '4013';
process.env.AUTH_SECRET = 'test-secret-not-for-production';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';
process.env.RETENTION = 'off';
process.env.PRF_DRAFT_EDIT_WINDOW_MS = '0'; // write each draft edit's audit row straight away

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;

// Everything the completeness rules need, so a PRF can be finalised.
const COMPLETE = {
  event: 'E1', callType: 'Medical', dispatch: '2026-11-03T12:00', address: '1 High St',
  chief: 'Fall', airway: 'Patent', breathing: 'Normal', circulation: 'Pulse present',
  assessment: 'Alert, minor graze', disposition: 'Treated and released', destination: 'Discharged on scene',
  capacity: 'Has capacity', consent: 'Verbal consent', safeguarding: 'No', narrative: 'Cleaned and dressed.',
  first: 'Test', last: 'Patient', health: '9434765919',
  vitals: [{ hr: '72', rr: '16', spo2: '98', o2: 'Air', sys: '120', acvpu: 'A', temp: '37' }],
};

let adminT, dispT, supT, danT, ellieT, mdtT, jobId;

before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  [adminT, dispT, supT, danT, ellieT, mdtT] = await Promise.all([
    login('admin', 'admin123'), login('dispatcher', 'dispatch123'), login('supervisor', 'super123'),
    login('dwhitfield', 'field123'), login('emarsh', 'field123'), login('mdt001', 'mdt123'),
  ]);
  const personnel = (await call('GET', '/api/personnel', undefined, dispT)).body;
  const dan = personnel.find((p) => p.name === 'Dan Whitfield');
  const job = await call('POST', '/api/jobs', { location: '12 Market Square', incident_type: 'Medical', priority: 'AMBER' }, dispT);
  jobId = job.body.id;
  const a = await call('POST', `/api/jobs/${jobId}/assign`, { resources: [String(dan.id)] }, dispT);
  assert.ok(a.status < 300, JSON.stringify(a.body));
});
after(() => {
  app.server.closeAllConnections?.();
  app.server.close();
});

test('dispatchers and vehicle terminals have no PRF access', async () => {
  assert.strictEqual((await call('GET', '/api/prfs', undefined, dispT)).status, 403);
  assert.strictEqual((await call('POST', '/api/prfs', {}, mdtT)).status, 403);
  assert.strictEqual((await call('GET', '/api/prfs')).status, 401);
});

test('a PRF started from an assigned job is prefilled; an unassigned officer cannot use that job', async () => {
  const jobs = (await call('GET', '/api/prfs/jobs', undefined, danT)).body;
  assert.ok(jobs.some((j) => j.id === jobId));
  const r = await call('POST', '/api/prfs', { job_id: jobId }, danT);
  assert.strictEqual(r.status, 201);
  assert.match(r.body.pcr, /^PRF-\d{4}-\d{5}$/);
  assert.strictEqual(r.body.data.address, '12 Market Square');
  assert.ok(r.body.data.event.startsWith('INC-'));
  assert.strictEqual((await call('POST', '/api/prfs', { job_id: jobId }, ellieT)).status, 403);
});

test('draft lifecycle: author-only edits, version check, server-side completeness, lock, addenda, audit', async () => {
  const created = (await call('POST', '/api/prfs', {}, danT)).body;
  const pcr = created.pcr;

  // Another officer can neither read nor edit it; a supervisor can read it.
  assert.strictEqual((await call('GET', `/api/prfs/${pcr}`, undefined, ellieT)).status, 403);
  assert.strictEqual((await call('PUT', `/api/prfs/${pcr}`, { data: {} }, ellieT)).status, 403);
  assert.strictEqual((await call('GET', `/api/prfs/${pcr}`, undefined, supT)).status, 200);

  // Unknown fields are dropped.
  let put = await call('PUT', `/api/prfs/${pcr}`, { version: 1, data: { chief: 'Fall', evil: 'x' } }, danT);
  assert.strictEqual(put.status, 200);
  assert.strictEqual(put.body.version, 2);
  const got = (await call('GET', `/api/prfs/${pcr}`, undefined, danT)).body;
  assert.strictEqual(got.data.evil, undefined);

  // A stale version is refused rather than silently overwriting.
  assert.strictEqual((await call('PUT', `/api/prfs/${pcr}`, { version: 1, data: { chief: 'Seizure' } }, danT)).status, 409);

  // Finalise needs the attestation and a complete record — checked by the server, not just the form.
  assert.strictEqual((await call('POST', `/api/prfs/${pcr}/finalise`, {}, danT)).status, 400);
  const incomplete = await call('POST', `/api/prfs/${pcr}/finalise`, { attest: true }, danT);
  assert.strictEqual(incomplete.status, 422);
  assert.ok(incomplete.body.missing.some((m) => m.label === 'Event Number'));

  // An invalid NHS number blocks finalise too.
  put = await call('PUT', `/api/prfs/${pcr}`, { version: 2, data: { ...COMPLETE, health: '9434765918' } }, danT);
  const bad = await call('POST', `/api/prfs/${pcr}/finalise`, { attest: true }, danT);
  assert.strictEqual(bad.status, 422);
  assert.ok(bad.body.missing.some((m) => m.label === 'NHS Number'));

  // Refused care needs refusal details.
  put = await call('PUT', `/api/prfs/${pcr}`, { version: put.body.version, data: { ...COMPLETE, disposition: 'Refused care' } }, danT);
  const refusal = await call('POST', `/api/prfs/${pcr}/finalise`, { attest: true }, danT);
  assert.ok(refusal.body.missing.some((m) => m.label === 'Refusal of Care Details'));

  put = await call('PUT', `/api/prfs/${pcr}`, { version: put.body.version, data: COMPLETE }, danT);
  const fin = await call('POST', `/api/prfs/${pcr}/finalise`, { attest: true }, danT);
  assert.strictEqual(fin.status, 200, JSON.stringify(fin.body));
  assert.strictEqual(fin.body.status, 'FINAL');
  assert.match(fin.body.content_hash, /^[0-9a-f]{64}$/);

  // Locked: no edits, no discarding.
  assert.strictEqual((await call('PUT', `/api/prfs/${pcr}`, { data: { chief: 'x' } }, danT)).status, 409);
  assert.strictEqual((await call('DELETE', `/api/prfs/${pcr}`, undefined, danT)).status, 409);

  // Addenda by the author or a supervisor, not another officer.
  assert.strictEqual((await call('POST', `/api/prfs/${pcr}/addenda`, { text: 'Patient phoned back, feeling better.' }, danT)).status, 201);
  assert.strictEqual((await call('POST', `/api/prfs/${pcr}/addenda`, { text: 'Reviewed.' }, supT)).status, 201);
  assert.strictEqual((await call('POST', `/api/prfs/${pcr}/addenda`, { text: 'x' }, ellieT)).status, 403);
  assert.strictEqual((await call('GET', `/api/prfs/${pcr}`, undefined, danT)).body.addenda.length, 2);

  // The trail: officers can't see it; supervisors can, and it records who did what, without patient values.
  assert.strictEqual((await call('GET', `/api/prf-audit?pcr=${pcr}`, undefined, danT)).status, 403);
  const rows = (await call('GET', `/api/prf-audit?pcr=${pcr}`, undefined, supT)).body;
  const actions = rows.map((r) => r.action);
  for (const a of ['created', 'draft.edited', 'finalised', 'addendum.added', 'viewed']) assert.ok(actions.includes(a), a);
  assert.ok(!JSON.stringify(rows).includes('9434765919'), 'audit rows must not carry patient data');
  assert.ok(rows.find((r) => r.action === 'viewed' && r.username === 'supervisor'));

  // The general event log only says a PRF exists — no patient detail.
  assert.ok(!JSON.stringify(app.db.audit_logs).includes('Test Patient'));

  // Lists: officers see their own, supervisors can ask for all.
  assert.ok((await call('GET', '/api/prfs', undefined, danT)).body.some((r) => r.pcr === pcr));
  assert.ok(!(await call('GET', '/api/prfs', undefined, ellieT)).body.some((r) => r.pcr === pcr));
  assert.ok((await call('GET', '/api/prfs?scope=all', undefined, supT)).body.some((r) => r.pcr === pcr));
});

test('a draft can be discarded by its author, and that is audited', async () => {
  const { pcr } = (await call('POST', '/api/prfs', {}, danT)).body;
  assert.strictEqual((await call('DELETE', `/api/prfs/${pcr}`, undefined, danT)).status, 200);
  assert.strictEqual((await call('GET', `/api/prfs/${pcr}`, undefined, danT)).status, 404);
  const rows = (await call('GET', `/api/prf-audit?pcr=${pcr}`, undefined, adminT)).body;
  assert.ok(rows.some((r) => r.action === 'draft.discarded'));
});

test('audit chain verifies, and detects tampering', async () => {
  let v = (await call('GET', '/api/prf-audit/verify', undefined, adminT)).body;
  assert.strictEqual(v.ok, true);
  assert.ok(v.rows > 5);

  const row = app.db.prf_audit[2];
  const original = row.username;
  row.username = 'someone-else';
  v = (await call('GET', '/api/prf-audit/verify', undefined, adminT)).body;
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.broken_at, row.id);
  row.username = original;

  const removed = app.db.prf_audit.splice(1, 1);
  v = (await call('GET', '/api/prf-audit/verify', undefined, adminT)).body;
  assert.strictEqual(v.ok, false);
  app.db.prf_audit.splice(1, 0, ...removed);
  assert.strictEqual((await call('GET', '/api/prf-audit/verify', undefined, adminT)).body.ok, true);
});
