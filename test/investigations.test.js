/* Incident investigations and their audit trail — node --test
 *
 * An investigation on a filed report: a named investigator, findings and
 * root cause, actions that must be finished, external notification
 * decisions, a sign-off that refuses to close half-done work, and a trail of
 * every view and change that is hash-chained, anchored in the global trail,
 * and never leaks a RESTRICTED report's content into the event log. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4103';
process.env.AUTH_SECRET = 'investigations-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';

const app = require('../server.js');
const { verifyTrail } = require('../record-trail.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, buf, headers: res.headers };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const sig = (name) => ({ mimetype: 'image/png', data: PNG, signer_name: name });
const def = (key) => app.db.form_definitions.find((d) => d.key === key);

let adminT, dispT, supT, danT, job, supervisor, dispatcher;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dispT = await login('dispatcher', 'dispatch123');
  supT = await login('supervisor', 'super123');
  danT = await login('dwhitfield', 'field123');
  supervisor = app.db.users.find((u) => u.username === 'supervisor');
  dispatcher = app.db.users.find((u) => u.username === 'dispatcher');
  const dan = app.db.personnel.find((p) => p.name === 'Dan Whitfield');
  job = (await call('POST', '/api/jobs', { priority: 'AMBER', location: 'Meridian Business Park', incident_type: 'Intruder' }, dispT)).body;
  await call('POST', `/api/jobs/${job.id}/assign`, { resources: [dan.id] }, dispT);
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

const fileIncident = (token = danT) => call('POST', '/api/form-submissions', {
  definition_id: def('incident-report').id, subject_type: 'JOB', subject_id: job.id,
  values: { occurred_at: new Date().toISOString(), severity: 'MEDIUM', incident_type: 'Assault', location: 'Main gate', immediate_action: 'Reported to control.', statement_true: true, description: 'Visitor pushed an officer at the gate.', officer_signature: sig('Dan Whitfield') },
}, token);
const sub = (id) => app.db.form_submissions.find((s) => s.id === id);

test('full investigation: assign a supervisor, record findings, actions and notifications, then sign off', async () => {
  const id = (await fileIncident()).body.id;
  const started = await call('POST', `/api/form-submissions/${id}/investigation/start`, { investigator_user_id: supervisor.id }, adminT);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.investigation.investigator, supervisor.display_name);

  // The named supervisor can work it; another control user cannot.
  assert.equal((await call('PATCH', `/api/form-submissions/${id}/investigation`, { findings: 'x' }, dispT)).status, 403);
  const upd = await call('PATCH', `/api/form-submissions/${id}/investigation`, { findings: 'CCTV confirms a push, no injury.', root_cause: 'Visitor refused entry with no explanation of the site rules.' }, supT);
  assert.equal(upd.status, 200, JSON.stringify(upd.body));

  const asFiler = (await call('GET', `/api/form-submissions/${id}`, undefined, danT)).body;
  assert.equal(asFiler.investigation.findings, undefined, 'the officer who filed it sees that an investigation exists, not its notes');
  assert.equal(asFiler.investigation.investigator, supervisor.display_name);

  const withAction = await call('POST', `/api/form-submissions/${id}/investigation/actions`, { description: 'Put site rules sign at the gate', owner: 'Site manager', due_date: '2026-12-01' }, supT);
  assert.equal(withAction.status, 200, JSON.stringify(withAction.body));
  const actionId = withAction.body.investigation.actions[0].id;

  assert.equal((await call('POST', `/api/form-submissions/${id}/investigation/notifications`, { body: 'POLICE' }, supT)).status, 400, 'needs a time');
  assert.equal((await call('POST', `/api/form-submissions/${id}/investigation/notifications`, { body: 'CQC', decision: 'NOT_REQUIRED' }, supT)).status, 400, 'needs a reason');
  assert.equal((await call('POST', `/api/form-submissions/${id}/investigation/notifications`, { body: 'POLICE', notified_at: new Date().toISOString(), reference: 'CAD-1234' }, supT)).status, 200);
  assert.equal((await call('POST', `/api/form-submissions/${id}/investigation/notifications`, { body: 'CQC', decision: 'NOT_REQUIRED', notes: 'Not a regulated activity.' }, supT)).status, 200);

  // Sign-off is refused while the action is open, and is admin only.
  assert.equal((await call('POST', `/api/form-submissions/${id}/action`, { outcome: 'APPROVED', feedback: 'Done' }, adminT)).status, 409);
  assert.equal((await call('PATCH', `/api/form-submissions/${id}/investigation/actions/${actionId}`, { status: 'CANCELLED' }, supT)).status, 400, 'cancelling needs a reason');
  assert.equal((await call('PATCH', `/api/form-submissions/${id}/investigation/actions/${actionId}`, { status: 'DONE', note: 'Sign fitted' }, supT)).status, 200);
  assert.equal((await call('POST', `/api/form-submissions/${id}/action`, { outcome: 'APPROVED', feedback: 'Done' }, supT)).status, 403, 'a supervisor cannot sign off');
  const closed = await call('POST', `/api/form-submissions/${id}/action`, { outcome: 'APPROVED', feedback: 'Investigation complete; sign fitted.' }, adminT);
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.investigation.sign_offs[0].independent, true, 'signed off by someone other than the investigator');

  // Signed off = locked, until reopened with a reason.
  assert.equal((await call('PATCH', `/api/form-submissions/${id}/investigation`, { findings: 'changed' }, adminT)).status, 409);
  assert.equal((await call('POST', `/api/form-submissions/${id}/investigation/reopen`, {}, adminT)).status, 400);
  assert.equal((await call('POST', `/api/form-submissions/${id}/investigation/reopen`, { reason: 'New CCTV angle found' }, adminT)).body.status, 'UNDER_INVESTIGATION');

  // And it can't be deleted by hand.
  await call('POST', `/api/form-submissions/${id}/action`, { outcome: 'APPROVED', feedback: 'Reviewed new footage, no change.' }, adminT);
  assert.equal((await call('DELETE', `/api/form-submissions/${id}`, { reason: 'tidy up' }, adminT)).status, 409);
});

test('the trail records views and every change with before and after, and its hash chain verifies', async () => {
  const id = (await fileIncident()).body.id;
  await call('GET', `/api/form-submissions/${id}`, undefined, dispT);
  await call('GET', `/api/form-submissions/${id}`, undefined, dispT); // a refresh: still one view
  await call('POST', `/api/form-submissions/${id}/investigation/start`, {}, adminT);
  await call('PATCH', `/api/form-submissions/${id}/investigation`, { findings: 'First draft' }, adminT);
  await call('PATCH', `/api/form-submissions/${id}/investigation`, { findings: 'Second draft' }, adminT);
  await call('PATCH', `/api/form-submissions/${id}/risk-assessment`, { likelihood: 'HIGH', severity: 'HIGH' }, adminT);

  assert.equal((await call('GET', `/api/form-submissions/${id}/audit-trail`, undefined, dispT)).status, 403, 'who-opened-what is for admins and the investigator');
  const t = await call('GET', `/api/form-submissions/${id}/audit-trail`, undefined, adminT);
  assert.equal(t.status, 200, JSON.stringify(t.body));
  const actions = t.body.entries.map((e) => e.action);
  assert.deepEqual(actions.filter((a) => a === 'viewed').length, 1, 'repeat opens within 10 minutes are one view');
  assert.ok(actions.includes('filed') && actions.includes('investigation_started') && actions.includes('risk_assessed'));
  const second = t.body.entries.filter((e) => e.action === 'updated')[1];
  assert.deepEqual(second.changes[0], { field: 'findings', label: 'Findings', from: 'First draft', to: 'Second draft' });
  assert.equal(t.body.integrity.ok, true);
  assert.equal(t.body.integrity.anchored_in_global_trail, t.body.entries.length, 'every entry is anchored in the global trail');

  // Views are recorded but not pushed to the live event feed.
  const view = app.db.audit_logs.find((e) => e.type === 'form.accessed' && e.data.submission_id === id);
  assert.ok(view);

  // Tampering is detected.
  const s = sub(id);
  const copy = JSON.parse(JSON.stringify(s.audit_trail));
  copy[2].summary = 'something else';
  assert.equal(verifyTrail(copy).ok, false);
  assert.equal(verifyTrail(copy).broken_at, 3);
  assert.equal(verifyTrail(s.audit_trail.filter((e) => e.seq !== 2)).ok, false, 'a removed entry is detected too');
});

test('investigation report PDF includes the investigation and trail, and the export is itself logged', async () => {
  const id = (await fileIncident()).body.id;
  assert.equal((await call('GET', `/api/form-submissions/${id}/investigation-report`, undefined, adminT)).status, 409, 'nothing to report yet');
  await call('POST', `/api/form-submissions/${id}/investigation/start`, {}, adminT);
  await call('PATCH', `/api/form-submissions/${id}/investigation`, { findings: 'Found it', root_cause: 'Cause' }, adminT);
  const pdf = await call('GET', `/api/form-submissions/${id}/investigation-report`, undefined, adminT);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.ok(pdf.buf.subarray(0, 5).toString() === '%PDF-');
  assert.ok(sub(id).audit_trail.some((e) => e.action === 'exported'));
});

test('a RESTRICTED report: investigator must hold a grant, and no content reaches the global trail', async () => {
  const d = def('safeguarding');
  const filed = await call('POST', '/api/form-submissions', {
    definition_id: d.id, subject_type: 'JOB', subject_id: job.id,
    values: { concern_about: 'Adult', at_risk_group: 'Adult at risk', concern_type: 'Not sure', location: 'Main gate', dsl_informed: 'Jo Lead, 14:05', referral_status: 'Left for the safeguarding lead to decide', consent_to_share: 'Not shared outside Echelon', statement_true: true, observed_at: new Date().toISOString(), what_happened: 'x', action_taken: 'x', officer_signature: sig('Dan') },
  }, danT);
  assert.equal(filed.status, 201, JSON.stringify(filed.body));
  const id = filed.body.id;
  await call('POST', `/api/form-definitions/${d.id}/grants`, { username: 'admin' }, adminT);
  await call('POST', `/api/form-submissions/${id}/investigation/start`, {}, adminT);
  const candidates = (await call('GET', `/api/form-submissions/${id}/investigators`, undefined, adminT)).body;
  assert.ok(!candidates.some((u) => u.id === supervisor.id), 'no grant, not eligible');
  assert.equal((await call('POST', `/api/form-submissions/${id}/investigation/assign`, { user_id: supervisor.id }, adminT)).status, 400);

  const CANARY = 'CANARY-ROOT-CAUSE-7731';
  await call('PATCH', `/api/form-submissions/${id}/investigation`, { root_cause: CANARY }, adminT);
  await call('POST', `/api/form-submissions/${id}/investigation/actions`, { description: CANARY }, adminT);
  const global = JSON.stringify(app.db.audit_logs.filter((e) => e.data && e.data.submission_id === id));
  assert.ok(!global.includes(CANARY), 'restricted investigation content never goes into the event log');
  assert.ok(JSON.stringify(sub(id).audit_trail).includes(CANARY), 'but it is in the report\'s own trail');
  assert.equal((await call('GET', `/api/form-submissions/${id}/audit-trail`, undefined, supT)).status, 404, 'no grant: the report does not exist for them');
});

test('retention keeps reports under investigation, and counts from sign-off', () => {
  const old = new Date(Date.now() - 4000 * 86400000).toISOString();
  const recent = new Date(Date.now() - 10 * 86400000).toISOString();
  const base = { fields: [], values: {}, files: [], definition_id: 1, subject_type: 'SITE', subject_id: 1 };
  app.db.form_submissions.push(
    { ...base, id: 990001, reference: 'KEEP-LIVE', status: 'UNDER_INVESTIGATION', submitted_at: old },
    { ...base, id: 990002, reference: 'KEEP-RECENT-CLOSE', status: 'ACTIONED', submitted_at: old, actioned_at: recent },
    { ...base, id: 990003, reference: 'GO', status: 'ACTIONED', submitted_at: old, actioned_at: old },
  );
  app.retentionSweep();
  const left = new Set(app.db.form_submissions.map((s) => s.reference));
  assert.ok(left.has('KEEP-LIVE'));
  assert.ok(left.has('KEEP-RECENT-CLOSE'));
  assert.ok(!left.has('GO'));
});
