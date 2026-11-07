/* "Write it up for me" (report-assist.js) — node --test
 *
 * The local AI is faked, so this runs offline. Checks: the template drafter
 * works with no AI configured; the AI's answer is used when it is good;
 * every AI failure (down, slow, junk, empty) falls back to the template;
 * the AI can never fill tick boxes, signatures or out-of-list options;
 * invented numbers are flagged; nothing of the notes lands in the audit log;
 * and an officer cannot draft against someone else's job.
 */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4091';
process.env.AUTH_SECRET = 'report-assist-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';
delete process.env.LOCAL_AI_URL;

const app = require('../server.js');
const assist = require('../report-assist.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
async function call(method, path, body, token) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;

const NOTES = 'arrived 2215, rear fire door open, no one inside, 2 youths seen running towards the park, secured it, rang keyholder 2230';
let dispT, danT, ellieT, job, incident;

before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  dispT = await login('dispatcher', 'dispatch123');
  danT = await login('dwhitfield', 'field123');
  ellieT = await login('emarsh', 'field123');
  const dan = app.db.personnel.find((p) => p.name === 'Dan Whitfield');
  job = (await call('POST', '/api/jobs', { priority: 'AMBER', location: 'Meridian Business Park', incident_type: 'Intruder alarm' }, dispT)).body;
  await call('POST', `/api/jobs/${job.id}/assign`, { resources: [dan.id] }, dispT);
  incident = app.db.form_definitions.find((d) => d.key === 'incident-report');
});
after(() => { assist.setTransport(null); app.server.closeAllConnections?.(); app.server.close(); });

const draft = (body, token = danT) => call('POST', '/api/report-assist', { definition_id: incident.id, subject_type: 'JOB', subject_id: job.id, notes: NOTES, ...body }, token);

test('tidies rough notes into first-person sentences', () => {
  assert.deepStrictEqual(assist.sentences('arrived 2215, secured it, rang keyholder 10pm'),
    ['I arrived at 22:15.', 'I secured it.', 'I rang keyholder at 22:00.']);
  assert.equal(assist.tidyTimes('call 07700 900188 in 2025'), 'call 07700 900188 in 2025', 'phone numbers and years untouched');
});

test('with no AI set up, the template drafter fills the form', async () => {
  const st = await call('GET', '/api/report-assist/status', undefined, danT);
  assert.deepStrictEqual(st.body, { available: true, ai: false, model: null });
  const r = await draft();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.source, 'template');
  assert.match(r.body.values.description, /job .*Intruder alarm/);
  assert.match(r.body.values.description, /I arrived at 22:15\. Rear fire door open\./);
  assert.match(r.body.values.immediate_action, /I secured it\. I rang keyholder at 22:30\./);
  assert.match(r.body.values.persons_involved, /2 youths/);
  assert.equal(r.body.values.location, 'Meridian Business Park');
  assert.ok(incident.fields.find((f) => f.id === 'incident_type').options.includes(r.body.values.incident_type));
  for (const id of ['anyone_injured', 'statement_true', 'officer_signature', 'officer_sia_licence', 'occurred_at']) assert.equal(r.body.values[id], undefined, id);
});

test('uses the local AI answer, keeps only allowed fields, flags invented numbers', async () => {
  process.env.LOCAL_AI_URL = 'http://ai.test:11434/';
  let sent;
  assist.setTransport(async (req) => {
    sent = req;
    return { message: { content: JSON.stringify({
      fields: {
        description: 'At 22:15 I arrived at Meridian Business Park. The rear fire door was open. At 23:40 I left.',
        immediate_action: 'I secured the door and rang the keyholder at 22:30.',
        incident_type: 'Trespass', location: '', anyone_injured: 'true', officer_signature: 'x', officer_sia_licence: '1234',
      },
      missing: ['Was anything taken?'],
    }) } };
  });
  try {
    const r = await draft();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.source, 'ai');
    assert.equal(sent.url, 'http://ai.test:11434/api/chat');
    assert.equal(sent.body.stream, false);
    assert.ok(sent.body.format.properties.fields.properties.description, 'answer constrained to a JSON schema');
    assert.ok(!sent.body.format.properties.fields.properties.anyone_injured, 'tick boxes not offered to the model');
    assert.match(sent.body.messages[1].content, /rear fire door open/);
    assert.equal(r.body.values.incident_type, 'Trespass');
    assert.equal(r.body.values.anyone_injured, undefined);
    assert.equal(r.body.values.officer_signature, undefined);
    assert.equal(r.body.values.officer_sia_licence, undefined);
    assert.deepStrictEqual(r.body.check, ['23:40'], 'a time not in the notes is flagged');
    assert.ok(r.body.missing.includes('Was anything taken?'));
  } finally { delete process.env.LOCAL_AI_URL; assist.setTransport(null); }
});

test('rejects a pick-list answer that is not one of the options', async () => {
  process.env.LOCAL_AI_URL = 'http://ai.test:11434';
  assist.setTransport(async () => ({ message: { content: JSON.stringify({ fields: { description: 'I arrived.', incident_type: 'Burglary' }, missing: [] }) } }));
  try {
    const r = await draft();
    assert.equal(r.body.source, 'ai');
    assert.equal(r.body.values.incident_type, undefined);
  } finally { delete process.env.LOCAL_AI_URL; assist.setTransport(null); }
});

for (const [name, fake] of [
  ['down', async () => { throw new Error('local AI unavailable (ECONNREFUSED)'); }],
  ['junk', async () => ({ message: { content: 'Sure! Here is your report…' } })],
  ['empty', async () => ({ message: { content: JSON.stringify({ fields: { description: '' }, missing: [] }) } })],
]) {
  test(`falls back to the template when the AI is ${name}`, async () => {
    process.env.LOCAL_AI_URL = 'http://ai.test:11434';
    assist.setTransport(fake);
    try {
      const r = await draft();
      assert.equal(r.status, 200);
      assert.equal(r.body.source, 'template');
      assert.match(r.body.note, /template/);
      assert.match(r.body.values.description, /I arrived at 22:15/);
    } finally { delete process.env.LOCAL_AI_URL; assist.setTransport(null); }
  });
}

test('notes are not written to the audit log', async () => {
  await draft({ notes: 'CANARY-NOTES-7731 arrived 2215' });
  const hits = app.db.audit_logs.filter((e) => JSON.stringify(e).includes('CANARY-NOTES-7731'));
  assert.equal(hits.length, 0);
  assert.ok(app.db.audit_logs.some((e) => e.type === 'report.assist'));
});

test('an officer cannot draft against a job that is not theirs; empty notes refused', async () => {
  assert.equal((await draft({}, ellieT)).status, 403);
  assert.equal((await draft({ notes: '' })).status, 400);
  assert.equal((await draft({ definition_id: 999999 })).status, 404);
  const site = app.db.sites[0];
  const r = await draft({ subject_type: 'SITE', subject_id: site.id }, ellieT);
  assert.equal(r.status, 200);
  assert.match(r.body.values.description, new RegExp(`I was on duty at ${site.name}`));
});
