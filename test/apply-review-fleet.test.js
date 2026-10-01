/* Public job application, admin review of submitted forms, admin view of a
 * client portal, and the fleet dashboard — node --test */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4016';
process.env.AUTH_SECRET = 'apply-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;

async function call(method, path, body, token, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, raw: text };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const sig = (name) => ({ mimetype: 'image/png', data: PNG, signer_name: name });
// Each test's applications come from their own "sender", so the per-sender
// limit is exercised deliberately, not by accident.
let senderN = 0;
const asSender = () => ({ 'x-forwarded-for': `203.0.113.${++senderN}` });
const goodAnswers = (name = 'Jamie Applicant') => ({
  full_name: name, email: 'jamie@example.com', phone: '07700 900123', postcode: 'DN40 1AA',
  role_applied_for: 'Security officer', right_to_work: true, consent: true, experience: 'Two years door supervision',
});

let adminT, dispT, danT, appForm;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dispT = await login('dispatcher', 'dispatch123');
  danT = await login('dwhitfield', 'field123');
  appForm = (await call('GET', '/api/public/application-form')).body;
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

/* ---------------- public application ---------------- */
test('the application form is served without a login and is the default one', () => {
  assert.equal(appForm.name, 'Job application');
  assert.ok(appForm.fields.some((f) => f.id === 'full_name' && f.required));
  assert.ok(appForm.fields.some((f) => f.id === 'consent' && f.required));
  assert.equal(appForm.grants, undefined);
});

test('an application with no login lands under Applicants with its answers — and nothing personal in the event log', async () => {
  const r = await call('POST', '/api/public/applications', { definition_id: appForm.id, values: goodAnswers('Jamie Applicant') }, null, asSender());
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.reference, /^APP-\d{5}$/);
  assert.deepEqual(Object.keys(r.body).sort(), ['ok', 'reference'], 'nothing is echoed back');

  const list = (await call('GET', '/api/applicants', undefined, adminT)).body;
  const a = list.find((x) => x.name === 'Jamie Applicant');
  assert.ok(a, 'appears in the Applications section');
  assert.equal(a.source, 'Website');
  assert.equal(a.status, 'APPLIED');
  assert.equal(a.email, 'jamie@example.com');
  assert.equal(a.application.values.experience, 'Two years door supervision');
  assert.equal(a.application.definition_name, 'Job application');

  const ev = app.db.audit_logs.find((e) => e.type === 'applicant.applied_online' && e.data.applicant_id === a.id);
  assert.equal(ev.summary, `NEW WEBSITE APPLICATION — APPLICANT #${a.id}`);
  assert.ok(!app.db.audit_logs.some((e) => /Jamie|jamie@/.test(e.summary)), 'the event log reaches every officer: no name or email in it');
  assert.equal((await call('GET', '/api/applicants', undefined, danT)).status, 403, 'officers cannot read applicants');
});

test('a signature on the application is stored and readable by control only', async () => {
  const d = app.db.form_definitions.find((x) => x.id === appForm.id);
  const fields = [...d.fields, { id: 'applicant_signature', label: 'Signature', type: 'signature', required: true }];
  assert.equal((await call('PATCH', `/api/form-definitions/${d.id}`, { fields }, adminT)).status, 200);
  const form = (await call('GET', '/api/public/application-form')).body;
  const r = await call('POST', '/api/public/applications', { definition_id: form.id, values: { ...goodAnswers('Sig Nature'), applicant_signature: sig('Sig Nature') } }, null, asSender());
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const a = app.db.applicants.find((x) => x.name === 'Sig Nature');
  const fileId = a.application.values.applicant_signature.file_id;
  const img = await fetch(`${BASE}/api/applicants/${a.id}/application-files/${fileId}`, { headers: { authorization: `Bearer ${dispT}` } });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${BASE}/api/applicants/${a.id}/application-files/${fileId}`)).status, 401);
  await call('PATCH', `/api/form-definitions/${d.id}`, { fields: d.fields.filter((f) => f.id !== 'applicant_signature') }, adminT);
});

test('the public route validates against the form and refuses anything else', async () => {
  const post = (values, extra = {}) => call('POST', '/api/public/applications', { definition_id: appForm.id, values, ...extra }, null, asSender());
  const form = (await call('GET', '/api/public/application-form')).body;
  assert.equal((await call('POST', '/api/public/applications', { definition_id: form.id + 999, values: goodAnswers() }, null, asSender())).status, 409, 'stale form');
  assert.equal((await call('POST', '/api/public/applications', { definition_id: form.id, values: { ...goodAnswers(), consent: false } }, null, asSender())).status, 400, 'consent is required');
  assert.equal((await call('POST', '/api/public/applications', { definition_id: form.id, values: { ...goodAnswers(), email: 'not-an-email' } }, null, asSender())).status, 400);
  assert.equal((await call('POST', '/api/public/applications', { definition_id: form.id, values: { ...goodAnswers(), is_admin: true } }, null, asSender())).status, 400, 'unknown fields refused');
  const cvBad = await call('POST', '/api/public/applications', { definition_id: form.id, values: goodAnswers(), cv: { mimetype: 'application/pdf', data: Buffer.from('<script>').toString('base64') } }, null, asSender());
  assert.equal(cvBad.status, 400, 'a "PDF" that is not a PDF is refused');
  void post;
});

test('the honeypot drops bots silently, and one sender is limited to 5 an hour', async () => {
  const before = app.db.applicants.length;
  const bot = await call('POST', '/api/public/applications', { definition_id: appForm.id, values: goodAnswers('Bot'), website: 'http://spam' }, null, asSender());
  assert.equal(bot.status, 201, 'looks accepted to the bot');
  assert.equal(app.db.applicants.length, before, 'but nothing was stored');

  const same = { 'x-forwarded-for': '198.51.100.7' };
  // Mistakes don't count: five refused attempts, then still able to apply.
  for (let i = 0; i < 6; i++) assert.equal((await call('POST', '/api/public/applications', { definition_id: appForm.id, values: { ...goodAnswers('Typo'), email: 'typo' } }, null, same)).status, 400);
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/public/applications', { definition_id: appForm.id, values: goodAnswers(`Burst ${i}`) }, null, same)).status, 201);
  assert.equal((await call('POST', '/api/public/applications', { definition_id: appForm.id, values: goodAnswers('Burst 6') }, null, same)).status, 429);
  assert.equal((await call('POST', '/api/public/applications', { definition_id: appForm.id, values: goodAnswers('Someone else') }, null, asSender())).status, 201, 'a different sender is unaffected');
});

test('the application form keeps its required shape, and stays out of officers\' report menus', async () => {
  const d = app.db.form_definitions.find((x) => x.id === appForm.id);
  assert.equal((await call('PATCH', `/api/form-definitions/${d.id}`, { fields: d.fields.filter((f) => f.id !== 'email') }, adminT)).status, 400);
  assert.equal((await call('PATCH', `/api/form-definitions/${d.id}`, { fields: [...d.fields, { id: 'selfie', label: 'Photo', type: 'photo' }] }, adminT)).status, 400);
  assert.equal((await call('PATCH', `/api/form-definitions/${d.id}`, { subject_types: ['APPLICATION', 'SITE'] }, adminT)).status, 400);
  assert.ok(!(await call('GET', '/api/form-definitions', undefined, danT)).body.some((x) => x.id === d.id), 'officers are not offered it');
  assert.ok(!(await call('GET', '/api/form-definitions', undefined, dispT)).body.some((x) => x.id === d.id));
  assert.equal((await call('POST', '/api/form-submissions', { definition_id: d.id, subject_type: 'APPLICATION', subject_id: 1, values: {} }, danT)).status, 400);
});

test('retiring the application form closes applications', async () => {
  await call('PATCH', `/api/form-definitions/${appForm.id}`, { active: false }, adminT);
  assert.equal((await call('GET', '/api/public/application-form')).status, 404);
  assert.equal((await call('POST', '/api/public/applications', { definition_id: appForm.id, values: goodAnswers() }, null, asSender())).status, 404);
  await call('PATCH', `/api/form-definitions/${appForm.id}`, { active: true }, adminT);
  assert.equal((await call('GET', '/api/public/application-form')).status, 200);
});

/* ---------------- admin review of submitted forms ---------------- */
async function fileTrespass() {
  const dan = app.db.personnel.find((p) => p.name === 'Dan Whitfield');
  const job = (await call('POST', '/api/jobs', { priority: 'AMBER', location: 'Meridian Business Park' }, dispT)).body;
  await call('POST', `/api/jobs/${job.id}/assign`, { resources: [dan.id] }, dispT);
  const def = app.db.form_definitions.find((d) => d.key === 'trespass-advisal');
  const r = await call('POST', '/api/form-submissions', { definition_id: def.id, subject_type: 'JOB', subject_id: job.id, values: {
    person_description: 'Male, 30s', advised_at: new Date().toISOString(), narrative: 'Advised and left', officer_signature: sig('Dan Whitfield'),
  } }, danT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { sub: r.body, dan };
}

test('an admin actions a report: it leaves the open queue, the officer gets the feedback, and the record is kept', async () => {
  const { sub, dan } = await fileTrespass();
  assert.ok((await call('GET', '/api/form-submissions?status=OPEN', undefined, adminT)).body.some((s) => s.id === sub.id), 'in the admin queue');
  assert.equal((await call('POST', `/api/form-submissions/${sub.id}/action`, { outcome: 'APPROVED', feedback: 'x' }, dispT)).status, 403, 'only admins action');
  assert.equal((await call('POST', `/api/form-submissions/${sub.id}/action`, { outcome: 'APPROVED' }, adminT)).status, 400, 'feedback required to approve');

  const r = await call('POST', `/api/form-submissions/${sub.id}/action`, { outcome: 'APPROVED', feedback: 'Good report — add the police reference next time.' }, adminT);
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ACTIONED');
  assert.equal(r.body.outcome, 'APPROVED');
  assert.ok(!(await call('GET', '/api/form-submissions?status=OPEN', undefined, adminT)).body.some((s) => s.id === sub.id), 'removed from the queue');
  assert.ok((await call('GET', '/api/form-submissions?status=ACTIONED', undefined, adminT)).body.some((s) => s.id === sub.id), 'but kept, and findable');

  const msg = app.db.messages.find((m) => m.to_personnel_id === dan.id && m.body.includes(sub.reference));
  assert.ok(msg && msg.body.includes('add the police reference'), 'the officer gets the feedback as a message');
  const own = await call('GET', `/api/form-submissions/${sub.id}`, undefined, danT);
  assert.equal(own.body.feedback, 'Good report — add the police reference next time.');
  assert.equal((await call('POST', `/api/form-submissions/${sub.id}/action`, { outcome: 'REJECTED', feedback: 'again' }, adminT)).status, 409, 'actioned once');
});

test('a restricted report can only be actioned by an admin who is a named reader, and its feedback is never messaged or logged', async () => {
  const dan = app.db.personnel.find((p) => p.name === 'Dan Whitfield');
  const def = app.db.form_definitions.find((d) => d.key === 'safeguarding');
  const filed = await call('POST', '/api/form-submissions', { definition_id: def.id, subject_type: 'SITE', subject_id: 1, values: {
    concern_about: 'Child', at_risk_group: 'Child (under 18)', observed_at: new Date().toISOString(), what_happened: 'x', action_taken: 'x', officer_signature: sig('Dan'),
  } }, danT);
  const id = filed.body.id;
  assert.ok(!(await call('GET', '/api/form-submissions?status=OPEN', undefined, adminT)).body.some((s) => s.id === id), 'not in the admin queue without a grant');
  assert.equal((await call('POST', `/api/form-submissions/${id}/action`, { outcome: 'NOTED' }, adminT)).status, 404, 'cannot be actioned — or even confirmed to exist');

  await call('POST', `/api/form-definitions/${def.id}/grants`, { username: 'admin' }, adminT);
  const messagesBefore = app.db.messages.length;
  const FEEDBACK = 'SECRET-FEEDBACK referred to the DSL';
  const r = await call('POST', `/api/form-submissions/${id}/action`, { outcome: 'NOTED', feedback: FEEDBACK }, adminT);
  assert.equal(r.status, 200);
  assert.equal(app.db.messages.length, messagesBefore, 'no message — control roles can read every message');
  assert.ok(!app.db.audit_logs.some((e) => e.summary.includes('SECRET-FEEDBACK')), 'not in the event log');
  assert.equal((await call('GET', `/api/form-submissions/${id}`, undefined, danT)).body.feedback, FEEDBACK, 'the filer reads it on the report');
  void dan;
});

/* ---------------- admin view of a client portal ---------------- */
test('an admin can view a client portal exactly as the client sees it, read only, and the visit is logged', async () => {
  const c = (await call('POST', '/api/clients', { name: 'Meridian Estates', site_ids: [1] }, adminT)).body;
  assert.equal((await call('GET', '/api/client/me', undefined, adminT)).status, 404, 'must name a client');
  const me = await call('GET', `/api/client/me?as_client=${c.id}`, undefined, adminT);
  assert.equal(me.status, 200);
  assert.equal(me.body.name, 'Meridian Estates');
  assert.deepEqual(me.body.sites.map((s) => s.id), [1]);
  assert.equal((await call('GET', `/api/client/sites/1/report?as_client=${c.id}`, undefined, adminT)).status, 200);
  assert.equal((await call('GET', `/api/client/sites/2/report?as_client=${c.id}`, undefined, adminT)).status, 404, 'still scoped to that client\'s sites');
  assert.equal((await call('GET', `/api/client/me?as_client=${c.id}`, undefined, dispT)).status, 403, 'admin only');
  assert.equal((await call('POST', '/api/client-requests', { site_id: 1, subject: 'x' }, adminT)).status, 403, 'nothing writes as the client');
  assert.ok(app.db.audit_logs.some((e) => e.type === 'client.portal_viewed' && /admin VIEWED THE CLIENT PORTAL OF Meridian Estates/.test(e.summary)));
});

/* ---------------- fleet dashboard ---------------- */
test('the fleet dashboard grades compliance, reads inspection issues and offers the vehicle forms', async () => {
  const v = app.db.vehicles[0];
  v.mot_due_at = new Date(Date.now() - 86400000).toISOString();
  v.service_due_at = new Date(Date.now() + 10 * 86400000).toISOString();
  const def = app.db.form_definitions.find((d) => d.key === 'vehicle-inspection');
  const r = await call('POST', '/api/form-submissions', { definition_id: def.id, subject_type: 'VEHICLE', subject_id: v.id, values: {
    odometer: 41000, fuel_level: '1/2', tyres_ok: true, lights_ok: false, bodywork_ok: true, fluids_ok: true, kit_ok: true,
    defects: 'Nearside indicator out', driver_signature: sig('Dan Whitfield'),
  } }, danT);
  assert.equal(r.status, 201, JSON.stringify(r.body));

  const d = await call('GET', '/api/fleet-dashboard', undefined, dispT);
  assert.equal(d.status, 200);
  const row = d.body.vehicles.find((x) => x.id === v.id);
  assert.equal(row.compliance.find((c) => c.field === 'mot_due_at').state, 'OVERDUE');
  assert.equal(row.compliance.find((c) => c.field === 'service_due_at').state, 'DUE_SOON');
  assert.equal(row.worst_compliance, 'OVERDUE');
  assert.equal(row.inspected_today, true);
  assert.ok(row.last_inspection.issues.some((i) => /Lights and indicators OK: not ticked/.test(i)));
  assert.ok(row.last_inspection.issues.some((i) => /Nearside indicator out/.test(i)));
  assert.ok(d.body.vehicle_forms.some((f) => f.key === 'vehicle-inspection'));
  assert.ok(d.body.summary.compliance_overdue >= 1 && d.body.summary.with_issues >= 1);
  assert.equal((await call('GET', '/api/fleet-dashboard', undefined, danT)).status, 403);
});
