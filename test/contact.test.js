/* Contact routes (routes-contact.js) — click-to-dial, click-to-SMS and the
 * Twilio status webhook — node --test
 *
 * Runs its own server in its own process (node --test isolates files), with
 * no AMI_* set so dial takes the tel: path, SMS_LIVE unset so SMS is a dry
 * run, and a known Twilio auth token so the webhook's signature check can be
 * exercised with a correctly signed request as well as forged ones. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

process.env.PORT = '4012';
process.env.AUTH_SECRET = 'contact-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';
process.env.TWILIO_AUTH_TOKEN = 'twilio-test-token';
process.env.SMS_STATUS_CALLBACK_URL = 'https://cccs.example.test/api/sms/status';
delete process.env.SMS_LIVE;
delete process.env.AMI_HOST;

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

/** Signs exactly as Twilio does: HMAC-SHA1 over url + sorted key+value pairs. */
function twilioSign(url, params, token = process.env.TWILIO_AUTH_TOKEN) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
}
/** Posts a status callback the way Twilio does: form-encoded, not JSON. */
function postStatus(params, signature) {
  return fetch(BASE + '/api/sms/status', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(signature ? { 'x-twilio-signature': signature } : {}) },
    body: new URLSearchParams(params).toString(),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

const person = (name) => app.db.personnel.find((p) => p.name === name);
let dispT, fieldT;

before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  dispT = await login('dispatcher', 'dispatch123');
  fieldT = await login('dwhitfield', 'field123');
  // The demo seed carries no numbers and no supervisors; give it some.
  person('Dan Whitfield').contact_phone = '07700 900001';
  person('Ellie Marsh').contact_phone = '+447700900002';
  person('Ryan Cole').contact_phone = '07700900003';
  person('Jo Vance').contact_phone = '';
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

/* ---------------- dial ---------------- */
test('dial without a PBX records an ATTEMPT and nothing more', async () => {
  const dan = person('Dan Whitfield');
  const r = await call('POST', '/api/contact/dial', { personnel: dan.id, extension: '905' }, dispT);
  assert.equal(r.status, 201);
  assert.equal(r.body.outcome, 'ATTEMPTED');
  assert.equal(r.body.provider, 'none');
  assert.equal(r.body.duration_s, null);
  assert.equal(r.body.settled_at, null, 'a tel: link never settles');
  assert.equal(r.body.dial_uri, 'tel:07700 900001');
  const row = app.db.dial_log.find((d) => d.id === r.body.id);
  assert.equal(row.outcome, 'ATTEMPTED');
  assert.equal(row.to_number, '07700 900001', 'the number actually dialled is kept, not a live reference');

  const logged = app.db.audit_logs.find((e) => e.type === 'contact.dial' && e.data.dial_log_id === row.id);
  assert.ok(logged, 'the attempt is in the main event log');
  assert.match(logged.summary, /DIAL Dan Whitfield .* from ext 905/);
});

test('dial needs the operator\'s extension, a number on record, and a control role', async () => {
  const dan = person('Dan Whitfield');
  assert.equal((await call('POST', '/api/contact/dial', { personnel: dan.id }, dispT)).status, 400, 'no extension, no call');
  assert.equal((await call('POST', '/api/contact/dial', { personnel: person('Jo Vance').id, extension: '905' }, dispT)).status, 400, 'no number on record');
  assert.equal((await call('POST', '/api/contact/dial', { personnel: 99999, extension: '905' }, dispT)).status, 404);
  assert.equal((await call('POST', '/api/contact/dial', { personnel: dan.id, extension: '905' }, fieldT)).status, 403, 'officers cannot dial from the console routes');
  assert.equal((await call('POST', '/api/contact/dial', { personnel: dan.id, extension: '905' })).status, 401);
});

/* ---------------- supervisor resolution ---------------- */
test('with no duty supervisor rostered, the call goes to the line manager and says so', async () => {
  const dan = person('Dan Whitfield'), ellie = person('Ellie Marsh');
  dan.supervisor_id = ellie.id;
  const contact = await call('GET', `/api/personnel/${dan.id}/contact`, undefined, dispT);
  assert.equal(contact.body.supervisor.name, 'Ellie Marsh');
  assert.equal(contact.body.supervisor.source, 'LINE_MANAGER');

  const r = await call('POST', '/api/contact/dial', { personnel: dan.id, supervisor: true, extension: '905' }, dispT);
  assert.equal(r.status, 201);
  assert.equal(r.body.personnel_id, ellie.id, 'the row is about the person actually rung');
  assert.equal(r.body.supervisor_source, 'LINE_MANAGER');
  const logged = app.db.audit_logs.find((e) => e.type === 'contact.dial' && e.data.dial_log_id === r.body.id);
  assert.match(logged.summary, /line manager — no duty supervisor rostered/);
});

test('a rostered duty supervisor takes precedence over the line manager', async () => {
  const dan = person('Dan Whitfield'), ryan = person('Ryan Cole');
  const now = Date.now();
  const shift = {
    id: 990001, site_id: null, shift_type_id: app.db.shift_types[0].id, status: 'PUBLISHED', required_headcount: 1,
    starts_at: new Date(now - 3600e3).toISOString(), ends_at: new Date(now + 3600e3).toISOString(),
  };
  const assignment = { id: 990001, shift_id: shift.id, personnel_id: ryan.id, is_duty_supervisor: true, status: 'CONFIRMED', clocked_in_at: null, clocked_out_at: null };
  app.db.shifts.push(shift);
  app.db.shift_assignments.push(assignment);
  try {
    const contact = await call('GET', `/api/personnel/${dan.id}/contact`, undefined, dispT);
    assert.equal(contact.body.supervisor.name, 'Ryan Cole');
    assert.equal(contact.body.supervisor.source, 'DUTY_SUPERVISOR');
    const r = await call('POST', '/api/contact/dial', { personnel: dan.id, supervisor: true, extension: '905' }, dispT);
    assert.equal(r.body.personnel_id, ryan.id);
    assert.equal(r.body.supervisor_source, 'DUTY_SUPERVISOR');
    const logged = app.db.audit_logs.find((e) => e.type === 'contact.dial' && e.data.dial_log_id === r.body.id);
    assert.match(logged.summary, /\(duty supervisor\)/);
  } finally {
    app.db.shifts = app.db.shifts.filter((s) => s.id !== shift.id);
    app.db.shift_assignments = app.db.shift_assignments.filter((a) => a.id !== assignment.id);
  }
});

test('a duty shift that has ended does not count, and no supervisor at all is a clear 400', async () => {
  const dan = person('Dan Whitfield'), ryan = person('Ryan Cole');
  const past = { id: 990002, shift_type_id: app.db.shift_types[0].id, status: 'COMPLETED', required_headcount: 1,
    starts_at: new Date(Date.now() - 7200e3).toISOString(), ends_at: new Date(Date.now() - 3600e3).toISOString() };
  const assignment = { id: 990002, shift_id: past.id, personnel_id: ryan.id, is_duty_supervisor: true, status: 'CONFIRMED', clocked_in_at: null, clocked_out_at: null };
  app.db.shifts.push(past);
  app.db.shift_assignments.push(assignment);
  dan.supervisor_id = null;
  try {
    const contact = await call('GET', `/api/personnel/${dan.id}/contact`, undefined, dispT);
    assert.equal(contact.body.supervisor, null);
    const r = await call('POST', '/api/contact/dial', { personnel: dan.id, supervisor: true, extension: '905' }, dispT);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /no supervisor/);
  } finally {
    app.db.shifts = app.db.shifts.filter((s) => s.id !== past.id);
    app.db.shift_assignments = app.db.shift_assignments.filter((a) => a.id !== assignment.id);
  }
});

/* ---------------- SMS ---------------- */
test('SMS in dry-run records ATTEMPTED, never QUEUED, and says nothing was sent', async () => {
  const ellie = person('Ellie Marsh');
  const r = await call('POST', '/api/contact/sms', { personnel: ellie.id, body: 'Call control when free' }, dispT);
  assert.equal(r.status, 201);
  assert.equal(r.body.dry_run, true);
  assert.equal(r.body.outcome, 'ATTEMPTED', 'a message that was never sent must not be logged as queued');
  assert.equal(r.body.provider, 'none', 'and must not claim Twilio as its provider');
  assert.equal(r.body.to_number, '+447700900002');
  assert.equal(r.body.body, 'Call control when free');
  const logged = app.db.audit_logs.find((e) => e.type === 'contact.sms' && e.data.dial_log_id === r.body.id);
  assert.match(logged.summary, /dry run — SMS_LIVE is off, nothing sent/);
});

test('SMS refuses an empty message and an unusable number', async () => {
  assert.equal((await call('POST', '/api/contact/sms', { personnel: person('Ellie Marsh').id, body: '   ' }, dispT)).status, 400);
  const bad = await call('POST', '/api/contact/sms', { personnel: person('Jo Vance').id, body: 'hello' }, dispT);
  assert.equal(bad.status, 502);
  const row = app.db.dial_log.find((d) => d.id === bad.body.dial_log_id);
  assert.equal(row.outcome, 'FAILED', 'the failed attempt is still recorded');
});

/* ---------------- Twilio status webhook ---------------- */
test('the webhook rejects a missing or forged signature, failing closed', async () => {
  const params = { MessageSid: 'SMforged', MessageStatus: 'delivered' };
  assert.equal((await postStatus(params)).status, 403, 'unsigned');
  assert.equal((await postStatus(params, 'bm90LWEtcmVhbC1zaWduYXR1cmU=')).status, 403, 'garbage signature');
  assert.equal((await postStatus(params, twilioSign(process.env.SMS_STATUS_CALLBACK_URL, params, 'wrong-token'))).status, 403, 'signed with the wrong token');
  assert.equal((await postStatus(params, twilioSign('https://attacker.example/api/sms/status', params))).status, 403, 'signed for a different URL');
  const tampered = { ...params, MessageStatus: 'failed' };
  assert.equal((await postStatus(tampered, twilioSign(process.env.SMS_STATUS_CALLBACK_URL, params))).status, 403, 'params changed after signing');
});

test('a correctly signed callback for an unknown SID is accepted but matches nothing', async () => {
  const params = { MessageSid: 'SMunknown000', MessageStatus: 'delivered', AccountSid: 'ACtest', To: '+447700900002' };
  const before = JSON.stringify(app.db.dial_log);
  const r = await postStatus(params, twilioSign(process.env.SMS_STATUS_CALLBACK_URL, params));
  assert.equal(r.status, 200, 'form-encoded, as Twilio sends it, is parsed');
  assert.deepEqual(r.body, { ok: true, matched: false });
  assert.equal(JSON.stringify(app.db.dial_log), before, 'no row was invented for it');
});

test('successive callbacks update one row in place: queued, sent, delivered', async () => {
  const row = {
    id: 990100, channel: 'SMS', personnel_id: person('Ellie Marsh').id, to_number: '+447700900002',
    provider: 'twilio', provider_ref: 'SMlive0001', outcome: 'QUEUED', error_code: null, attempted_at: new Date().toISOString(), settled_at: null,
  };
  app.db.dial_log.push(row);
  for (const status of ['queued', 'sent', 'delivered']) {
    const params = { MessageSid: 'SMlive0001', MessageStatus: status };
    const r = await postStatus(params, twilioSign(process.env.SMS_STATUS_CALLBACK_URL, params));
    assert.deepEqual(r.body, { ok: true, matched: true });
  }
  assert.equal(app.db.dial_log.filter((d) => d.provider_ref === 'SMlive0001').length, 1, 'one message, one row');
  assert.equal(row.outcome, 'DELIVERED');
  assert.ok(row.settled_at, 'delivered is terminal');
  assert.ok(app.db.audit_logs.some((e) => e.type === 'contact.sms_status' && e.data.dial_log_id === row.id && /DELIVERED/.test(e.summary)));
});

test('an undelivered callback carries its error code onto the row', async () => {
  const row = { id: 990101, channel: 'SMS', provider: 'twilio', provider_ref: 'SMlive0002', outcome: 'QUEUED', to_number: '+447700900003', attempted_at: new Date().toISOString(), settled_at: null };
  app.db.dial_log.push(row);
  const params = { MessageSid: 'SMlive0002', MessageStatus: 'undelivered', ErrorCode: '30003' };
  await postStatus(params, twilioSign(process.env.SMS_STATUS_CALLBACK_URL, params));
  assert.equal(row.outcome, 'UNDELIVERED');
  assert.equal(row.error_code, '30003');
});

test('a dry-run row can never be updated by a webhook, even with a valid signature', async () => {
  const sent = await call('POST', '/api/contact/sms', { personnel: person('Ryan Cole').id, body: 'dry' }, dispT);
  const fakeSid = sent.body.provider_ref;
  const params = { MessageSid: fakeSid, MessageStatus: 'delivered' };
  const r = await postStatus(params, twilioSign(process.env.SMS_STATUS_CALLBACK_URL, params));
  assert.equal(r.body.matched, false, 'provider is none, so the synthesised SID matches nothing');
  assert.equal(app.db.dial_log.find((d) => d.id === sent.body.id).outcome, 'ATTEMPTED');
});

test('form bodies are accepted only on the webhook; every other route stays JSON-only', async () => {
  const r = await fetch(BASE + '/api/contact/sms', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Bearer ${dispT}` },
    body: 'personnel=1&body=hello',
  });
  assert.equal(r.status, 400);
});

/* ---------------- history + extension ---------------- */
test('per-person contact history is newest first and control-only', async () => {
  const dan = person('Dan Whitfield');
  const log = await call('GET', `/api/personnel/${dan.id}/contact-log`, undefined, dispT);
  assert.equal(log.status, 200);
  assert.ok(log.body.length >= 1);
  for (let i = 1; i < log.body.length; i++) assert.ok(log.body[i - 1].attempted_at >= log.body[i].attempted_at);
  assert.equal((await call('GET', `/api/personnel/${dan.id}/contact-log`, undefined, fieldT)).status, 403);
});

test('the operator\'s extension is validated and only remembered when asked', async () => {
  assert.equal((await call('POST', '/api/me/extension', { extension: '9x' }, dispT)).status, 400);
  const once = await call('POST', '/api/me/extension', { extension: '905' }, dispT);
  assert.equal(once.body.remembered, false);
  assert.equal((await call('GET', '/api/me/extension', undefined, dispT)).body.default_extension, '');
  await call('POST', '/api/me/extension', { extension: '905', remember: true }, dispT);
  assert.equal((await call('GET', '/api/me/extension', undefined, dispT)).body.default_extension, '905');
});

/* ---------------- setting both supervisor concepts through the API ---------------- */
test('line manager and duty supervisor are settable through the real routes, and dial follows them', async () => {
  const adminT = await login('admin', 'admin123');
  const dan = person('Dan Whitfield'), ellie = person('Ellie Marsh'), ryan = person('Ryan Cole');

  assert.equal((await call('PATCH', `/api/personnel/${dan.id}`, { supervisor_id: dan.id }, adminT)).status, 400, 'not their own line manager');
  assert.equal((await call('PATCH', `/api/personnel/${dan.id}`, { supervisor_id: 99999 }, adminT)).status, 400, 'must exist');
  assert.equal((await call('PATCH', `/api/personnel/${dan.id}`, { supervisor_id: ellie.id }, dispT)).status, 403, 'line management is an admin decision');
  const set = await call('PATCH', `/api/personnel/${dan.id}`, { supervisor_id: ellie.id }, adminT);
  assert.equal(set.body.supervisor_id, ellie.id);
  assert.equal((await call('GET', `/api/personnel/${dan.id}/contact`, undefined, dispT)).body.supervisor.source, 'LINE_MANAGER');

  const now = Date.now();
  const shift = await call('POST', '/api/shifts', {
    personnel: ryan.id, shift_type_id: app.db.shift_types[0].id,
    starts_at: new Date(now - 3600e3).toISOString(), ends_at: new Date(now + 3600e3).toISOString(), is_duty_supervisor: true,
  }, adminT);
  assert.equal(shift.status, 201);
  assert.equal(shift.body.assignments[0].is_duty_supervisor, true);
  const assignmentId = shift.body.assignments[0].id;
  const c = await call('GET', `/api/personnel/${dan.id}/contact`, undefined, dispT);
  assert.equal(c.body.supervisor.name, 'Ryan Cole');
  assert.equal(c.body.supervisor.source, 'DUTY_SUPERVISOR');

  assert.equal((await call('PATCH', `/api/shift-assignments/${assignmentId}`, { is_duty_supervisor: false }, dispT)).status, 403, 'toggling duty supervisor on a shift is admin-only');
  const off = await call('PATCH', `/api/shift-assignments/${assignmentId}`, { is_duty_supervisor: false }, adminT);
  assert.equal(off.body.assignments[0].is_duty_supervisor, false);
  assert.ok(app.db.audit_logs.some((e) => e.type === 'shift_assignment.updated' && /Ryan Cole ON SHIFT/.test(e.summary)), 'the change is logged by name');
  assert.equal((await call('GET', `/api/personnel/${dan.id}/contact`, undefined, dispT)).body.supervisor.source, 'LINE_MANAGER');
  await call('PATCH', `/api/personnel/${dan.id}`, { supervisor_id: null }, adminT);
});
