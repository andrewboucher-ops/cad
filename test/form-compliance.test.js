/* Safeguarding, use of force and incident report fields (routes-forms.js
 * STATEMENT_FORM_FIELDS) — node --test
 *
 * What the forms must ask for to stand up under the Care Act 2014, UK GDPR /
 * DPA 2018, RIDDOR, CQC Regulation 18 and use-of-force law, and the
 * validation that enforces it: conditional "required when ticked" fields, no
 * future incident times, a statement of truth, control alerts for anything
 * that starts a legal clock, and the one-off upgrade of a live database's
 * existing forms. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4098';
process.env.AUTH_SECRET = 'form-compliance-test-secret';
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
const def = (key) => app.db.form_definitions.find((d) => d.key === key);

let adminT, dispT, danT, job;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dispT = await login('dispatcher', 'dispatch123');
  danT = await login('dwhitfield', 'field123');
  const dan = app.db.personnel.find((p) => p.name === 'Dan Whitfield');
  job = (await call('POST', '/api/jobs', { priority: 'AMBER', location: 'Meridian Business Park', incident_type: 'Intruder' }, dispT)).body;
  await call('POST', `/api/jobs/${job.id}/assign`, { resources: [dan.id] }, dispT);
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

const file = (key, values) => call('POST', '/api/form-submissions', { definition_id: def(key).id, subject_type: 'JOB', subject_id: job.id, values }, danT);

const safeguarding = () => ({
  concern_about: 'Adult, about 70', at_risk_group: 'Adult at risk', concern_type: 'Financial or material abuse',
  observed_at: new Date().toISOString(), location: 'Reception', what_happened: 'Said her son takes her pension.',
  action_taken: 'Stayed with her, told the lead.', dsl_informed: 'Jo Lead, 14:05',
  referral_status: 'Left for the safeguarding lead to decide', consent_to_share: 'Yes they agreed',
  statement_true: true, officer_signature: sig('Dan Whitfield'),
});
const useOfForce = () => ({
  occurred_at: new Date().toISOString(), severity: 'MEDIUM', location: 'Main gate', officer_sia_licence: '1234567890123456',
  threat: 'Swung a punch at a colleague.', de_escalation: 'Talked to him, warned him, stepped back.',
  reason: 'Defence of another person', force_type: 'Physical restraint or control',
  why_proportionate: 'Held his arms only until he calmed; released at once.', narrative: 'In sequence…',
  aftercare: 'Checked he was breathing normally and unhurt, sat him down.', statement_true: true, officer_signature: sig('Dan Whitfield'),
});
const incident = () => ({
  occurred_at: new Date().toISOString(), severity: 'LOW', incident_type: 'Injury or accident', location: 'Loading bay',
  description: 'Visitor tripped on a pallet.', immediate_action: 'First aid, area coned off.', statement_true: true,
  officer_signature: sig('Dan Whitfield'),
});

test('the three statement forms carry the fields the law and regulators look for', () => {
  const ids = (k) => def(k).fields.map((f) => f.id);
  for (const id of ['concern_type', 'location', 'persons_views', 'alleged_is_staff', 'dsl_informed', 'referral_status', 'consent_to_share', 'sharing_reason', 'statement_true']) assert.ok(ids('safeguarding').includes(id), `safeguarding: ${id}`);
  for (const id of ['location', 'officer_sia_licence', 'threat', 'de_escalation', 'why_proportionate', 'restraint_position', 'prone_details', 'aftercare', 'arrest_grounds', 'statement_true']) assert.ok(ids('use-of-force').includes(id), `use of force: ${id}`);
  for (const id of ['location', 'immediate_action', 'injury_details', 'riddor_possible', 'data_breach', 'cqc_notifiable', 'footage_preserved', 'statement_true']) assert.ok(ids('incident-report').includes(id), `incident: ${id}`);
  assert.equal(def('safeguarding').visibility, 'RESTRICTED');
  assert.equal(def('use-of-force').visibility, 'RESTRICTED');
});

test('a complete report of each kind files', async () => {
  for (const [k, v] of [['safeguarding', safeguarding()], ['use-of-force', useOfForce()], ['incident-report', incident()]]) {
    const r = await file(k, v);
    assert.equal(r.status, 201, `${k}: ${JSON.stringify(r.body)}`);
  }
});

test('the statement of truth must be ticked', async () => {
  for (const [k, v] of [['safeguarding', safeguarding()], ['use-of-force', useOfForce()], ['incident-report', incident()]]) {
    const r = await file(k, { ...v, statement_true: false });
    assert.equal(r.status, 400, k);
    assert.match(r.body.error, /true and accurate/);
  }
});

test('a conditional field is required only once its condition holds', async () => {
  // Ticked box → its detail is required.
  assert.equal((await file('use-of-force', { ...useOfForce(), police_informed: true })).status, 400, 'police reference missing');
  assert.equal((await file('use-of-force', { ...useOfForce(), police_informed: true, police_reference: 'CAD 1234' })).status, 201);
  assert.equal((await file('use-of-force', { ...useOfForce(), arrested_detained: true })).status, 400, 'arrest grounds missing');
  assert.equal((await file('use-of-force', { ...useOfForce(), subject_injured: true })).status, 400, 'injury details missing');
  // Select answer → its detail is required.
  assert.equal((await file('use-of-force', { ...useOfForce(), restraint_position: 'Face down (prone)' })).status, 400, 'prone details missing');
  assert.equal((await file('use-of-force', { ...useOfForce(), restraint_position: 'Standing' })).status, 201, 'other positions need nothing more');
  // Sharing without consent must be justified.
  const refused = { ...safeguarding(), consent_to_share: 'They refused but sharing is needed to protect them or others' };
  const r = await file('safeguarding', refused);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Why sharing/);
  assert.equal((await file('safeguarding', { ...refused, sharing_reason: 'Ongoing financial abuse; risk of harm.' })).status, 201);
  assert.equal((await file('safeguarding', { ...safeguarding(), referral_status: 'Made by me' })).status, 400, 'referral reference missing');
  assert.equal((await file('incident-report', { ...incident(), data_breach: true })).status, 400, 'breach details missing');
});

test('an incident time cannot be in the future (a fast phone clock is forgiven)', async () => {
  const later = new Date(Date.now() + 3600e3).toISOString();
  const r = await file('incident-report', { ...incident(), occurred_at: later });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /future/);
  assert.equal((await file('incident-report', { ...incident(), occurred_at: new Date(Date.now() + 2 * 60000).toISOString() })).status, 201);
});

test('a ticked RIDDOR / data breach / CQC box alerts control at once, whatever the severity', async () => {
  const r = await file('incident-report', { ...incident(), riddor_possible: true, data_breach: true, data_breach_details: 'Visitor log page lost.' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const raw = app.db.form_submissions.find((s) => s.id === r.body.id);
  assert.deepEqual(raw.alerts, ['riddor_possible', 'data_breach']);
  assert.ok(app.db.audit_logs.some((e) => e.type === 'form.alert' && e.data.submission_id === r.body.id));
  const quiet = await file('incident-report', incident());
  assert.ok(!app.db.audit_logs.some((e) => e.type === 'form.alert' && e.data.submission_id === quiet.body.id), 'nothing ticked, no alert');
});

test('an existing database\'s old forms are upgraded once, keeping the admin\'s own fields and options', () => {
  const d = def('incident-report');
  const before = d.version;
  // Rewind to how a pre-upgrade form looked, plus an admin's own additions.
  d.fields = [
    { id: 'occurred_at', label: 'When it happened', type: 'datetime', required: true },
    { id: 'incident_type', label: 'Type', type: 'select', required: true, options: ['Theft', 'Bird strike'] },
    { id: 'description', label: 'What happened', type: 'textarea', required: true },
    { id: 'site_manager', label: 'Site manager on duty', type: 'text' },
    { id: 'officer_signature', label: 'Officer signature', type: 'signature', required: true },
  ];
  delete d.compliance_version;
  assert.equal(app.forms.ensureStatementCompliance(), 1);
  const ids = d.fields.map((f) => f.id);
  assert.ok(ids.includes('riddor_possible') && ids.includes('statement_true'));
  assert.ok(ids.indexOf('site_manager') < ids.indexOf('statement_true'), 'the admin\'s field is kept, before the statement of truth');
  assert.ok(d.fields.find((f) => f.id === 'incident_type').options.includes('Bird strike'), 'the admin\'s extra option is kept');
  assert.equal(d.version, before + 1);
  assert.equal(app.forms.ensureStatementCompliance(), 0, 'runs once');
});

test('a condition whose controlling field an admin removed is dropped, not left blocking the form', async () => {
  const d = def('use-of-force');
  const fields = d.fields.filter((f) => f.id !== 'police_informed');
  const r = await call('PATCH', `/api/form-definitions/${d.id}`, { fields }, adminT);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ref = def('use-of-force').fields.find((f) => f.id === 'police_reference');
  assert.equal(ref.required_if, undefined);
  assert.equal(ref.required, false);
});
