/* Configurable forms (routes-forms.js) — node --test
 *
 * The centre of this file is the RESTRICTED invariant: a safeguarding report
 * must never leave the server towards someone not entitled to it, by ANY
 * route, event or socket — not merely be left unrendered. The leak test
 * plants a canary string in a restricted report and then searches every
 * response body and every raw WebSocket byte that other users receive. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const crypto = require('node:crypto');

process.env.PORT = '4013';
process.env.AUTH_SECRET = 'forms-test-secret';
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
  return { status: res.status, body: parsed, raw: text, headers: res.headers };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;

/** A WebSocket that just records every raw byte the server sends it. Server
 * frames are unmasked, so a text payload is searchable as-is — which is
 * exactly the question: did these bytes reach this user's socket at all? */
function rawSocket(token) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(process.env.PORT), '127.0.0.1', () => {
      sock.write(`GET /ws?token=${encodeURIComponent(token)} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    const s = { bytes: '', close: () => sock.destroy() };
    sock.on('data', (d) => { s.bytes += d.toString('latin1'); if (s.bytes.includes('101 Switching')) resolve(s); });
    sock.on('error', reject);
  });
}

// Smallest valid PNG (1x1), standing in for a signature pad capture.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const sig = (name) => ({ mimetype: 'image/png', data: PNG, signer_name: name });

let adminT, dispT, supT, danT, ellieT, dan, job;
const def = (key) => app.db.form_definitions.find((d) => d.key === key);

before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dispT = await login('dispatcher', 'dispatch123');
  supT = await login('supervisor', 'super123');
  danT = await login('dwhitfield', 'field123');
  ellieT = await login('emarsh', 'field123');
  dan = app.db.personnel.find((p) => p.name === 'Dan Whitfield');
  job = (await call('POST', '/api/jobs', { priority: 'AMBER', location: 'Meridian Business Park', incident_type: 'Intruder' }, dispT)).body;
  await call('POST', `/api/jobs/${job.id}/assign`, { resources: [dan.id] }, dispT);
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

/* ---------------- defaults ---------------- */
test('the five requested forms are installed, safeguarding and patient care restricted', async () => {
  const list = await call('GET', '/api/form-definitions', undefined, danT);
  assert.equal(list.status, 200);
  const byKey = Object.fromEntries(list.body.map((d) => [d.key, d]));
  for (const k of ['trespass-advisal', 'parking-citation', 'vehicle-inspection', 'patient-care', 'safeguarding']) assert.ok(byKey[k], k);
  assert.equal(byKey.safeguarding.visibility, 'RESTRICTED');
  assert.equal(byKey['patient-care'].visibility, 'RESTRICTED', 'health information defaults to restricted');
  assert.equal(byKey['trespass-advisal'].visibility, 'STANDARD');
  assert.ok(byKey.safeguarding.fields.some((f) => f.type === 'signature' && f.required));
  assert.equal(byKey.safeguarding.grants, undefined, 'officers are not shown who holds grants');
  const asAdmin = await call('GET', '/api/form-definitions', undefined, adminT);
  assert.ok(Array.isArray(asAdmin.body[0].grants));
});

/* ---------------- a standard form, end to end ---------------- */
test('an officer files a trespass advisal against their job; control can read it, signature included', async () => {
  const r = await call('POST', '/api/form-submissions', {
    definition_id: def('trespass-advisal').id, subject_type: 'JOB', subject_id: job.id,
    values: {
      person_description: 'Male, 30s, grey hoodie', advised_at: new Date().toISOString(),
      left_site: true, narrative: 'Found by loading bay, advised, left via main gate.', officer_signature: sig('Dan Whitfield'),
    },
  }, danT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.reference, /^FORM-\d{4}-\d{5}$/);
  assert.equal(r.body.subject_label, job.reference);
  assert.equal(r.body.values.police_informed, false, 'an unticked box is recorded as false, not missing');
  assert.equal(r.body.values.officer_signature.signer_name, 'Dan Whitfield');
  assert.ok(r.body.values.officer_signature.signed_at);

  const asControl = await call('GET', `/api/form-submissions/${r.body.id}`, undefined, dispT);
  assert.equal(asControl.status, 200);
  const img = await fetch(BASE + asControl.body.values.officer_signature.url, { headers: { authorization: `Bearer ${dispT}` } });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');

  const listed = await call('GET', `/api/form-submissions?subject_type=JOB&subject_id=${job.id}`, undefined, dispT);
  assert.ok(listed.body.some((s) => s.id === r.body.id));
  assert.equal(listed.body[0].values, undefined, 'lists carry no field values');

  assert.equal((await call('GET', `/api/form-submissions/${r.body.id}`, undefined, ellieT)).status, 404, 'another officer cannot read it');
  const logged = app.db.audit_logs.find((e) => e.type === 'form.submitted' && e.data.submission_id === r.body.id);
  assert.match(logged.summary, /TRESPASS ADVISAL FORM-\d{4}-\d{5} FILED BY Dan Whitfield/);
});

test('submissions are validated against the form, and nothing is stashed outside it', async () => {
  const base = { definition_id: def('trespass-advisal').id, subject_type: 'JOB', subject_id: job.id };
  const ok = { person_description: 'x', advised_at: new Date().toISOString(), narrative: 'x', officer_signature: sig('Dan') };
  const post = (values, extra = {}) => call('POST', '/api/form-submissions', { ...base, ...extra, values }, danT);
  assert.equal((await post({ ...ok, narrative: '' })).status, 400, 'required field');
  assert.equal((await post({ ...ok, officer_signature: undefined })).status, 400, 'required signature');
  assert.equal((await post({ ...ok, officer_signature: { ...sig(''), signer_name: '' } })).status, 400, 'a signature needs the signer\'s name');
  assert.equal((await post({ ...ok, officer_signature: { ...sig('Dan'), data: Buffer.from('<svg onload=alert(1)>').toString('base64') } })).status, 400, 'not really a PNG');
  assert.equal((await post({ ...ok, advised_at: 'yesterday-ish' })).status, 400, 'bad datetime');
  assert.equal((await post({ ...ok, smuggled: 'extra data' })).status, 400, 'unknown field');
  assert.equal((await post(ok, { subject_type: 'VEHICLE', subject_id: 1 })).status, 400, 'wrong subject type for this form');
  const other = (await call('POST', '/api/jobs', { priority: 'GREEN', location: 'Elsewhere' }, dispT)).body;
  assert.equal((await post(ok, { subject_id: other.id })).status, 403, 'not assigned to that job');
});

/* ---------------- the RESTRICTED invariant ---------------- */
test('a restricted report never reaches anyone without a grant — by any route, event or socket', async () => {
  const CANARY = 'CANARY-' + crypto.randomBytes(6).toString('hex');
  const watchers = { dispatcher: await rawSocket(dispT), supervisor: await rawSocket(supT), admin: await rawSocket(adminT), otherOfficer: await rawSocket(ellieT) };
  try {

    const filed = await call('POST', '/api/form-submissions', {
      definition_id: def('safeguarding').id, subject_type: 'JOB', subject_id: job.id,
      values: {
        concern_about: `Child, approx 12 — ${CANARY}`, at_risk_group: 'Child (under 18)', observed_at: new Date().toISOString(),
        what_happened: `Disclosed ${CANARY}`, action_taken: 'Stayed with child, called 999', officer_signature: sig('Dan Whitfield'),
      },
    }, danT);
    assert.equal(filed.status, 201);
    assert.equal(filed.body.visibility, 'RESTRICTED');
    const id = filed.body.id;
    const fileUrl = filed.body.values.officer_signature.url;
    await new Promise((r) => setTimeout(r, 150));

    const people = { dispatcher: dispT, supervisor: supT, admin: adminT, otherOfficer: ellieT };
    for (const [who, t] of Object.entries(people)) {
      const reads = [
        await call('GET', `/api/form-submissions/${id}`, undefined, t),
        await call('GET', '/api/form-submissions', undefined, t),
        await call('GET', `/api/form-submissions?subject_type=JOB&subject_id=${job.id}`, undefined, t),
        await call('GET', `/api/form-submissions?definition_id=${def('safeguarding').id}`, undefined, t),
        await call('GET', fileUrl, undefined, t),
        await call('GET', '/api/events?limit=500', undefined, t),
        await call('GET', '/api/state', undefined, t),
        await call('GET', `/api/jobs`, undefined, t),
      ];
      assert.equal(reads[0].status, 404, `${who}: a single read is a 404, not a 403 that would confirm it exists`);
      assert.equal(reads[4].status, 404, `${who}: the signature image is gated identically`);
      for (const r of reads) {
        assert.ok(!r.raw.includes(CANARY), `${who}: canary leaked in a response`);
        assert.ok(!r.raw.includes(filed.body.values.officer_signature.file_id), `${who}: file id leaked`);
      }
      for (const listing of [reads[1], reads[2], reads[3]]) assert.ok(!listing.body.some((s) => s.id === id), `${who}: listed`);
      assert.ok(!watchers[who].bytes.includes(CANARY), `${who}: canary reached their WebSocket`);
      assert.ok(!/safeguard/i.test(watchers[who].bytes), `${who}: the form type reached their WebSocket`);
    }

    // The audit trail proves a restricted report was filed, and says nothing else.
    const ev = app.db.audit_logs.find((e) => e.type === 'form.submitted_restricted' && e.data.submission_id === id);
    assert.equal(ev.summary, `RESTRICTED REPORT ${filed.body.reference} FILED`);

    // The author can read back what they filed.
    const own = await call('GET', `/api/form-submissions/${id}`, undefined, danT);
    assert.equal(own.status, 200);
    assert.ok(own.raw.includes(CANARY));
  } finally {
    Object.values(watchers).forEach((w) => w.close());
  }
});

test('a named grant lets exactly that person read it; revoking it closes it again', async () => {
  const d = def('safeguarding');
  const filed = await call('POST', '/api/form-submissions', {
    definition_id: d.id, subject_type: 'SITE', subject_id: 1,
    values: { concern_about: 'Adult', at_risk_group: 'Adult at risk', observed_at: new Date().toISOString(), what_happened: 'x', action_taken: 'x', officer_signature: sig('Dan') },
  }, danT);
  const id = filed.body.id;
  const sup = app.db.users.find((u) => u.username === 'supervisor');

  assert.equal((await call('POST', `/api/form-definitions/${d.id}/grants`, { username: 'supervisor' }, dispT)).status, 403, 'only an admin grants');
  const granted = await call('POST', `/api/form-definitions/${d.id}/grants`, { username: 'supervisor' }, adminT);
  assert.equal(granted.status, 201);
  const grant = granted.body.grants.find((g) => g.user_id === sup.id);

  const read = await call('GET', `/api/form-submissions/${id}`, undefined, supT);
  assert.equal(read.status, 200);
  assert.equal(read.body.values.cache, undefined);
  const img = await fetch(BASE + read.body.values.officer_signature.url, { headers: { authorization: `Bearer ${supT}` } });
  assert.equal(img.headers.get('cache-control'), 'no-store', 'a restricted image is never cached by the browser');
  assert.equal((await call('GET', `/api/form-submissions/${id}`, undefined, dispT)).status, 404, 'a grant to one supervisor is not a grant to control');
  assert.equal((await call('GET', `/api/form-submissions/${id}`, undefined, adminT)).status, 404, 'being admin is not itself access');

  const log = app.db.audit_logs.find((e) => e.type === 'form.grant_added' && e.data.user_id === sup.id);
  assert.match(log.summary, /admin GRANTED supervisor ACCESS TO "Safeguarding report" REPORTS/);

  await call('DELETE', `/api/form-definitions/${d.id}/grants/${grant.id}`, undefined, adminT);
  assert.equal((await call('GET', `/api/form-submissions/${id}`, undefined, supT)).status, 404, 'revoked');
});

test('relaxing a form to STANDARD never exposes reports filed while it was restricted', async () => {
  const d = def('patient-care');
  const values = { occurred_at: new Date().toISOString(), presenting_complaint: 'Cut hand', treatment: 'Dressing', outcome: 'Returned to activity', first_aider_signature: sig('Dan') };
  const before = (await call('POST', '/api/form-submissions', { definition_id: d.id, subject_type: 'JOB', subject_id: job.id, values }, danT)).body;

  const relaxed = await call('PATCH', `/api/form-definitions/${d.id}`, { visibility: 'STANDARD' }, adminT);
  assert.equal(relaxed.body.visibility, 'STANDARD');
  const after = (await call('POST', '/api/form-submissions', { definition_id: d.id, subject_type: 'JOB', subject_id: job.id, values }, danT)).body;

  assert.equal((await call('GET', `/api/form-submissions/${before.id}`, undefined, dispT)).status, 404, 'filed under RESTRICTED, stays RESTRICTED');
  assert.equal((await call('GET', `/api/form-submissions/${after.id}`, undefined, dispT)).status, 200, 'filed under STANDARD');

  // Tightening again protects both.
  await call('PATCH', `/api/form-definitions/${d.id}`, { visibility: 'RESTRICTED' }, adminT);
  assert.equal((await call('GET', `/api/form-submissions/${after.id}`, undefined, dispT)).status, 404, 'tightening applies to past reports too');
});

/* ---------------- definitions ---------------- */
test('changing a form\'s fields makes a new version; old reports keep the fields they were filled on', async () => {
  const d = def('parking-citation');
  const values = { registration: 'AB12 CDE', location: 'Bay 4', contravention: 'Overstay', observed_at: new Date().toISOString(),
    photo: { mimetype: 'image/png', data: PNG }, officer_signature: sig('Dan') };
  const old = (await call('POST', '/api/form-submissions', { definition_id: d.id, subject_type: 'SITE', subject_id: 1, values }, danT)).body;
  assert.equal(old.definition_version, 1);

  const fields = [...d.fields, { id: 'ticket_no', label: 'Ticket number', type: 'text', required: true }];
  const updated = await call('PATCH', `/api/form-definitions/${d.id}`, { fields }, adminT);
  assert.equal(updated.body.version, 2);

  const reread = await call('GET', `/api/form-submissions/${old.id}`, undefined, dispT);
  assert.ok(!reread.body.fields.some((f) => f.id === 'ticket_no'), 'the old report is unchanged');
  assert.equal((await call('POST', '/api/form-submissions', { definition_id: d.id, subject_type: 'SITE', subject_id: 1, values }, danT)).status, 400, 'the new required field applies to new reports');
});

test('admins can build a form; bad definitions are refused; officers cannot', async () => {
  const good = { name: 'Key holding log', subject_types: ['SITE'], fields: [
    { id: 'keys_out', label: 'Keys signed out', type: 'number', required: true },
    { id: 'signature', label: 'Signature', type: 'signature', required: true },
  ] };
  assert.equal((await call('POST', '/api/form-definitions', good, danT)).status, 403);
  const made = await call('POST', '/api/form-definitions', good, adminT);
  assert.equal(made.status, 201);
  assert.equal(made.body.key, 'key-holding-log');
  assert.equal(made.body.visibility, 'STANDARD');
  assert.equal((await call('POST', '/api/form-definitions', good, adminT)).status, 409, 'duplicate key');
  const bad = (fields, extra = {}) => call('POST', '/api/form-definitions', { name: 'X' + Math.random(), subject_types: ['SITE'], fields, ...extra }, adminT);
  assert.equal((await bad([])).status, 400);
  assert.equal((await bad([{ id: 'Bad Id', label: 'x', type: 'text' }])).status, 400);
  assert.equal((await bad([{ id: 'a', label: 'x', type: 'script' }])).status, 400);
  assert.equal((await bad([{ id: 'a', label: 'x', type: 'select', options: ['only one'] }])).status, 400);
  assert.equal((await bad([{ id: 'a', label: 'x', type: 'text' }, { id: 'a', label: 'y', type: 'text' }])).status, 400);
  assert.equal((await bad([{ id: 'a', label: 'x', type: 'text' }], { subject_types: ['PLANET'] })).status, 400);

  const retired = await call('PATCH', `/api/form-definitions/${made.body.id}`, { active: false }, adminT);
  assert.equal(retired.body.active, false);
  assert.ok(!(await call('GET', '/api/form-definitions', undefined, danT)).body.some((d) => d.id === made.body.id), 'retired forms are not offered');
  assert.equal((await call('POST', '/api/form-submissions', { definition_id: made.body.id, subject_type: 'SITE', subject_id: 1, values: {} }, danT)).status, 404);
});

test('defaults install only on an empty database and never overwrite an admin\'s edits', () => {
  const r = require('node:child_process').spawnSync(process.execPath, ['-e', `
    process.env.PERSISTENCE = 'off';
    const a = require(${JSON.stringify(require('node:path').join(__dirname, '..', 'server.js'))});
    const forms = a.db.form_definitions;
    console.log(JSON.stringify({ before: forms.length }));
  `], { encoding: 'utf8' });
  assert.equal(JSON.parse(r.stdout.trim().split('\n').pop()).before, 0, 'nothing installs at require time, only at start()');
  const count = app.db.form_definitions.length;
  const d = def('trespass-advisal'); const name = d.name;
  d.name = 'Trespass advisal (edited)';
  app.forms.installDefaults();
  assert.equal(app.db.form_definitions.length, count, 'no duplicates on a second call');
  assert.equal(d.name, 'Trespass advisal (edited)');
  d.name = name;
});

/* ---------------- client reporting (GET /api/sites/:id/report) ---------------- */
test('a site service report aggregates alarm response against SLA, patrol visits, and incidents — restricted ones excluded for a reader without a grant', async () => {
  const site = (await call('POST', '/api/sites', { name: 'Report Test Site', response_sla_minutes: 10 }, adminT)).body;

  const siteJob = (await call('POST', '/api/jobs', { priority: 'AMBER', incident_type: 'Alarm activation', site: site.id }, dispT)).body;
  await call('POST', `/api/jobs/${siteJob.id}/assign`, { resources: [dan.id] }, dispT);
  await call('PATCH', `/api/jobs/${siteJob.id}`, { status: 'ON_SCENE' }, dispT);
  await call('PATCH', `/api/jobs/${siteJob.id}`, { status: 'COMPLETED' }, dispT);

  const visit = (await call('POST', '/api/site-visits', { site_id: site.id, scheduled_for: new Date().toISOString() }, dispT)).body;
  await call('PATCH', `/api/site-visits/${visit.id}`, { status: 'COMPLETED' }, dispT);

  // Filed by control — readable to a control-role reader without needing a grant.
  const standard = await call('POST', '/api/form-submissions', {
    definition_id: def('trespass-advisal').id, subject_type: 'JOB', subject_id: siteJob.id,
    values: {
      person_description: 'Male, 30s', advised_at: new Date().toISOString(), left_site: true,
      narrative: 'Trespasser advised and left.', officer_signature: sig('Dan Whitfield'),
    },
  }, dispT);
  assert.equal(standard.status, 201, JSON.stringify(standard.body));

  // Filed by the assigned officer, not by the dispatcher who will read the
  // report below — so the exclusion check actually exercises canRead()
  // rather than passing trivially because the reader is also the filer.
  const restricted = await call('POST', '/api/form-submissions', {
    definition_id: def('safeguarding').id, subject_type: 'JOB', subject_id: siteJob.id,
    values: {
      concern_about: 'A member of the public', at_risk_group: 'Adult at risk', observed_at: new Date().toISOString(),
      what_happened: 'Confidential detail that must not leak into any aggregate report.',
      action_taken: 'Safeguarding lead notified.', officer_signature: sig('Dan Whitfield'),
    },
  }, danT);
  assert.equal(restricted.status, 201, JSON.stringify(restricted.body));

  const asDispatcher = await call('GET', `/api/sites/${site.id}/report`, undefined, dispT);
  assert.equal(asDispatcher.status, 200);
  assert.equal(asDispatcher.body.jobs.total, 1);
  assert.equal(asDispatcher.body.jobs.completed, 1);
  assert.equal(asDispatcher.body.jobs.sla_minutes, 10);
  assert.ok(asDispatcher.body.jobs.avg_response_minutes >= 0, 'response time computed from created_at to on_scene_at');
  assert.equal(asDispatcher.body.jobs.within_sla, 1, 'an instant test response is well within a 10-minute SLA');
  assert.equal(asDispatcher.body.visits.total, 1);
  assert.equal(asDispatcher.body.visits.completed, 1);
  assert.equal(asDispatcher.body.incidents.length, 1, 'the dispatcher has no grant, so the restricted safeguarding report is excluded');
  assert.equal(asDispatcher.body.incidents[0].reference, standard.body.reference);
  assert.ok(!asDispatcher.raw?.includes?.('Confidential detail'), 'restricted content never reaches an ungranted reader, even in a rollup');

  const asFiler = await call('GET', `/api/sites/${site.id}/report`, undefined, danT);
  assert.equal(asFiler.status, 403, 'a field user is not a control role');

  const bad = await call('GET', `/api/sites/${site.id}/report?from=not-a-date`, undefined, dispT);
  assert.equal(bad.status, 400);

  assert.equal((await call('GET', '/api/sites/999999/report', undefined, dispT)).status, 404);
});

/* ---------------- severity, geo-tagging, PDF export ---------------- */
test('the incident report requires a severity, rejects a bad one, and a HIGH/CRITICAL one files without error', async () => {
  const incidentDef = def('incident-report');
  assert.ok(incidentDef.fields.some((f) => f.id === 'severity' && f.type === 'severity'), 'the default incident-report form carries a severity field');

  const missing = await call('POST', '/api/form-submissions', {
    definition_id: incidentDef.id, subject_type: 'JOB', subject_id: job.id,
    values: { occurred_at: new Date().toISOString(), incident_type: 'Other', description: 'No severity given.', officer_signature: sig('Dan Whitfield') },
  }, danT);
  assert.equal(missing.status, 400, 'severity is required');

  const bad = await call('POST', '/api/form-submissions', {
    definition_id: incidentDef.id, subject_type: 'JOB', subject_id: job.id,
    values: { occurred_at: new Date().toISOString(), severity: 'APOCALYPTIC', incident_type: 'Other', description: 'Bad severity.', officer_signature: sig('Dan Whitfield') },
  }, danT);
  assert.equal(bad.status, 400);

  const filed = await call('POST', '/api/form-submissions', {
    definition_id: incidentDef.id, subject_type: 'JOB', subject_id: job.id,
    values: { occurred_at: new Date().toISOString(), severity: 'CRITICAL', incident_type: 'Fire or alarm', description: 'Smoke reported in plant room.', officer_signature: sig('Dan Whitfield') },
  }, danT);
  assert.equal(filed.status, 201, JSON.stringify(filed.body));
  assert.equal(filed.body.values.severity, 'CRITICAL');
});

test('a best-effort device fix is kept with a submission and returned with it; an absent or invalid one is silently dropped', async () => {
  const withGeo = await call('POST', '/api/form-submissions', {
    definition_id: def('trespass-advisal').id, subject_type: 'JOB', subject_id: job.id,
    values: { person_description: 'Geo test', advised_at: new Date().toISOString(), narrative: 'n/a', officer_signature: sig('Dan Whitfield') },
    geo: { lat: 53.5675, lon: -0.0776, accuracy: 12.4 },
  }, danT);
  assert.equal(withGeo.status, 201, JSON.stringify(withGeo.body));
  assert.deepEqual(withGeo.body.geo, { lat: 53.5675, lon: -0.0776, accuracy: 12 });

  const bogus = await call('POST', '/api/form-submissions', {
    definition_id: def('trespass-advisal').id, subject_type: 'JOB', subject_id: job.id,
    values: { person_description: 'Geo test 2', advised_at: new Date().toISOString(), narrative: 'n/a', officer_signature: sig('Dan Whitfield') },
    geo: { lat: 'nowhere', lon: -0.0776 },
  }, danT);
  assert.equal(bogus.status, 201);
  assert.equal(bogus.body.geo, null, 'an invalid fix is dropped, not rejected — a report is never blocked on it');

  const none = await call('POST', '/api/form-submissions', {
    definition_id: def('trespass-advisal').id, subject_type: 'JOB', subject_id: job.id,
    values: { person_description: 'Geo test 3', advised_at: new Date().toISOString(), narrative: 'n/a', officer_signature: sig('Dan Whitfield') },
  }, danT);
  assert.equal(none.body.geo, null);
});

test('a brand-styled PDF can be built for a report exactly like an invoice or contract, and is still gated by canRead()', async () => {
  const filed = await call('POST', '/api/form-submissions', {
    definition_id: def('trespass-advisal').id, subject_type: 'JOB', subject_id: job.id,
    values: { person_description: 'PDF test', advised_at: new Date().toISOString(), narrative: 'Advised and left.', officer_signature: sig('Dan Whitfield') },
  }, danT);
  assert.equal(filed.status, 201);

  const pdf = await call('GET', `/api/form-submissions/${filed.body.id}/pdf`, undefined, dispT);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.ok(pdf.raw.startsWith('%PDF-'), 'produces a real PDF, not an error body');

  // A safeguarding report's PDF is gated exactly like any other read of it.
  const restricted = await call('POST', '/api/form-submissions', {
    definition_id: def('safeguarding').id, subject_type: 'JOB', subject_id: job.id,
    values: {
      concern_about: 'someone', at_risk_group: 'Adult at risk', observed_at: new Date().toISOString(),
      what_happened: 'detail', action_taken: 'notified', officer_signature: sig('Dan Whitfield'),
    },
  }, danT);
  assert.equal(restricted.status, 201);
  assert.equal((await call('GET', `/api/form-submissions/${restricted.body.id}/pdf`, undefined, dispT)).status, 404, 'a dispatcher without a grant cannot pull the PDF either');
  assert.equal((await call('GET', `/api/form-submissions/${restricted.body.id}/pdf`, undefined, danT)).status, 200, 'the filer can');
});

/* ---------------- severity escalation reminder (one-shot, like attendance's late_alert_at) ---------------- */
test('a HIGH/CRITICAL report still open after the reminder window pushes once more; actioning it first stops that', async () => {
  const filedAt = Date.now();
  const filed = await call('POST', '/api/form-submissions', {
    definition_id: def('incident-report').id, subject_type: 'JOB', subject_id: job.id,
    values: { occurred_at: new Date(filedAt).toISOString(), severity: 'HIGH', incident_type: 'Fire or alarm', description: 'Reminder test.', officer_signature: sig('Dan Whitfield') },
  }, danT);
  assert.equal(filed.status, 201, JSON.stringify(filed.body));
  const raw = () => app.db.form_submissions.find((s) => s.id === filed.body.id);

  app.forms.severityEscalationTick(filedAt + 10 * 60000);
  assert.ok(!raw().severity_reminded_at, 'too soon');

  app.forms.severityEscalationTick(filedAt + 16 * 60000);
  assert.ok(raw().severity_reminded_at, 'reminded once the window has passed');
  const reminders = () => app.db.audit_logs.filter((e) => e.type === 'form.severity_reminder' && e.data.submission_id === filed.body.id);
  assert.equal(reminders().length, 1);

  app.forms.severityEscalationTick(filedAt + 25 * 60000);
  assert.equal(reminders().length, 1, 'one-shot — never reminds twice for the same report');

  // Actioned before the window closes: no reminder, ever.
  const second = await call('POST', '/api/form-submissions', {
    definition_id: def('incident-report').id, subject_type: 'JOB', subject_id: job.id,
    values: { occurred_at: new Date(filedAt).toISOString(), severity: 'CRITICAL', incident_type: 'Fire or alarm', description: 'Reminder test 2 — actioned promptly.', officer_signature: sig('Dan Whitfield') },
  }, danT);
  await call('POST', `/api/form-submissions/${second.body.id}/action`, { outcome: 'NOTED' }, adminT);
  app.forms.severityEscalationTick(filedAt + 20 * 60000);
  assert.equal(app.db.audit_logs.filter((e) => e.data && e.data.submission_id === second.body.id && String(e.type).startsWith('form.severity_reminder')).length, 0, 'already actioned — no reminder needed');
});

test('a RESTRICTED HIGH/CRITICAL report reminds its named readers only, content-free, never CONTROL at large', async () => {
  const filedAt = Date.now();
  const filed = await call('POST', '/api/form-submissions', {
    definition_id: def('use-of-force').id, subject_type: 'JOB', subject_id: job.id,
    values: {
      occurred_at: new Date(filedAt).toISOString(), severity: 'CRITICAL',
      reason: 'Self-defence', force_type: 'Physical restraint or control',
      narrative: 'Confidential restricted narrative that must never appear in a broadcastable log line.',
      officer_signature: sig('Dan Whitfield'),
    },
  }, danT);
  assert.equal(filed.status, 201, JSON.stringify(filed.body));

  app.forms.severityEscalationTick(filedAt + 16 * 60000);
  const restrictedReminders = app.db.audit_logs.filter((e) => e.type === 'form.severity_reminder_restricted' && e.data.submission_id === filed.body.id);
  assert.equal(restrictedReminders.length, 1);
  assert.ok(!JSON.stringify(restrictedReminders[0]).includes('Confidential'), 'content-free, same as the original filing push');
  assert.equal(app.db.audit_logs.filter((e) => e.type === 'form.severity_reminder' && e.data.submission_id === filed.body.id).length, 0, 'never the non-restricted variant for a restricted report');
});
