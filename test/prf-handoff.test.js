/* A full PRF started from a patient care / first aid report, and from a CAD
 * job flagged medical: what copies across, and that it isn't duplicated. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = process.env.TEST_PRF_HANDOFF_PORT || '4015';
process.env.AUTH_SECRET = 'test-secret-not-for-production';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';
process.env.RETENTION = 'off';
process.env.PRF_DRAFT_EDIT_WINDOW_MS = '0';

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
async function call(method, path, body, token) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let dispT, danT, ellieT, supT, job;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  [dispT, danT, ellieT, supT] = await Promise.all([login('dispatcher', 'dispatch123'), login('dwhitfield', 'field123'), login('emarsh', 'field123'), login('supervisor', 'super123')]);
  const dan = app.db.personnel.find((p) => p.name === 'Dan Whitfield');
  const j = await call('POST', '/api/jobs', { location: 'Gate B, Riverside Stadium', incident_type: 'Medical', priority: 'AMBER', caller: 'Steward Jones', description: 'Male collapsed near gate B',
    is_medical: true, patient_name: 'Sam Example', patient_dob: '1988-04-12', chief_complaint: 'faint_dizzy', mpds_code: '31a1' }, dispT);
  assert.ok(j.status < 300, JSON.stringify(j.body));
  job = j.body;
  await call('POST', `/api/jobs/${job.id}/assign`, { resources: [String(dan.id)] }, dispT);
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

test('a PRF from a medical job takes control\'s patient details, without treating the caller as the patient', async () => {
  const r = (await call('POST', '/api/prfs', { job_id: job.id }, danT)).body;
  assert.strictEqual(r.data.first, 'Sam');
  assert.strictEqual(r.data.last, 'Example');
  assert.strictEqual(r.data.dob, '1988-04-12');
  assert.strictEqual(r.data.chief, 'Collapse / faint');
  assert.match(r.data.sceneNotes, /Reported by: Steward Jones/);
  assert.strictEqual(r.data.events, 'Male collapsed near gate B');
  assert.strictEqual(r.data.mpdsCode, '31-A-01', 'control\'s MPDS triage comes across, normalised');
  assert.match(r.data.sceneNotes, /MPDS triage: 31-A-01/);
});

test('Create full PRF from a first aid report copies its answers, and a second press opens the same PRF', async () => {
  const d = app.db.form_definitions.find((x) => x.key === 'patient-care');
  const values = { casualty_name: 'Alex Walker', casualty_age: 34, occurred_at: '2026-11-03T14:00:00.000Z', presenting_complaint: 'Twisted ankle on the steps', treatment: 'Ice pack and elevation', outcome: 'Taken to hospital', consent_given: true, ambulance_called: true,
    first_aider_signature: { mimetype: 'image/png', data: PNG, signer_name: 'Dan' } };
  const sub = await call('POST', '/api/form-submissions', { definition_id: d.id, subject_type: 'JOB', subject_id: job.id, values }, danT);
  assert.strictEqual(sub.status, 201, JSON.stringify(sub.body));

  // Someone who can't read the (restricted) report can't start a PRF from it.
  assert.strictEqual((await call('POST', '/api/prfs', { from_submission: sub.body.id }, ellieT)).status, 404);
  assert.strictEqual((await call('POST', '/api/prfs', { from_submission: sub.body.id }, dispT)).status, 403, 'dispatchers do not write PRFs');

  const r = await call('POST', '/api/prfs', { from_submission: sub.body.id }, danT);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const p = r.body;
  assert.strictEqual(p.job_id, job.id, 'linked to the report\'s job');
  assert.strictEqual(p.source_ref, sub.body.reference);
  assert.strictEqual(p.data.first, 'Alex', 'the report\'s casualty wins over the job\'s');
  assert.strictEqual(p.data.ageApprox, '34');
  assert.strictEqual(p.data.disposition, 'Transported');
  assert.strictEqual(p.data.consent, 'Verbal consent');
  assert.match(p.data.narrative, /Ice pack and elevation/);
  assert.strictEqual(p.data.events, 'Twisted ankle on the steps');
  assert.ok(!p.data.signatures, 'signatures are never copied: each record is signed for itself');

  const again = await call('POST', '/api/prfs', { from_submission: sub.body.id }, danT);
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.body.pcr, p.pcr);
  assert.ok(again.body.existing);
});

test('a PRF started without a job can be linked later, and control sees that a PRF exists but not its content', async () => {
  const p = (await call('POST', '/api/prfs', {}, danT)).body;
  await call('PUT', `/api/prfs/${p.pcr}`, { version: p.version, data: { first: 'Kim', chief: 'Fall' } }, danT);
  const l = await call('POST', `/api/prfs/${p.pcr}/link`, { job_id: job.id }, danT);
  assert.strictEqual(l.status, 200, JSON.stringify(l.body));
  assert.strictEqual(l.body.data.first, 'Kim', 'existing entries are kept');
  assert.strictEqual(l.body.data.address, 'Gate B, Riverside Stadium', 'blanks come from the job');
  assert.strictEqual((await call('POST', `/api/prfs/${p.pcr}/link`, { job_id: job.id }, ellieT)).status, 403);

  const list = await call('GET', `/api/jobs/${job.id}/prfs`, undefined, dispT);
  assert.strictEqual(list.status, 200);
  assert.ok(list.body.some((x) => x.pcr === p.pcr));
  assert.ok(!JSON.stringify(list.body).includes('Kim'), 'no patient details for control');
  assert.strictEqual((await call('GET', `/api/prfs/${p.pcr}`, undefined, dispT)).status, 403);
});

test('control triage the MPDS code on the job: format checked, and checked against the list once one is loaded', async () => {
  const adminT = await login('admin', 'admin123');
  const mk = (code) => call('POST', '/api/jobs', { location: 'Gate C', incident_type: 'Medical', is_medical: true, mpds_code: code }, dispT);
  assert.strictEqual((await mk('chest pain')).status, 400);
  await call('POST', '/api/prf-admin/mpds', { text: '10-D-01,Example descriptor' }, adminT);
  const ok = await mk('10d1');
  assert.strictEqual(ok.body.mpds_code, '10-D-01');
  assert.strictEqual(ok.body.mpds_text, 'Example descriptor');
  assert.strictEqual((await mk('10-D-02')).status, 400, 'not on the loaded list');
  const ed = await call('PATCH', `/api/jobs/${ok.body.id}`, { mpds_code: '' }, dispT);
  assert.strictEqual(ed.body.mpds_code, '');
  assert.strictEqual((await call('GET', '/api/prfs/mpds', undefined, dispT)).status, 200, 'dispatchers can read the list');
  await call('DELETE', '/api/prf-admin/mpds', undefined, adminT);
});
