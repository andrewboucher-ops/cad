/* AI assistant + phone agent integration — node --test. The model is faked,
 * so these run offline and check CCCS's side: validation, access rules,
 * idempotency and that suggestions never write to the record. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4012';
process.env.AUTH_SECRET = 'test-secret-not-for-production';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';
process.env.RETENTION = 'off';
process.env.PATROL_SCHEDULE_TICK_MS = '3600000';
process.env.VOICE_SECRET = 'test-voice-secret';

const ai = require('../ai.js');
const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;

let lastRequest = null, nextAnswer = {};
const fake = async (req) => {
  lastRequest = req;
  const name = req.tool_choice.name;
  return { content: [{ type: 'tool_use', name, input: nextAnswer }] };
};
fake.__fake = true;
ai.setTransport(fake);

async function call(method, path, body, token, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;
const voice = { 'x-voice-secret': 'test-voice-secret' };

let dispT, danT, ellieT;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  dispT = await login('dispatcher', 'dispatch123');
  danT = await login('dwhitfield', 'field123');
  ellieT = await login('emarsh', 'field123');
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

test('status reports the assistant as available', async () => {
  const r = await call('GET', '/api/ai/status', undefined, dispT);
  assert.equal(r.status, 200);
  assert.equal(r.body.enabled, true);
});

test('triage turns notes into a suggestion without creating a job', async () => {
  const site = app.db.sites[0];
  const before = app.db.jobs.length;
  nextAnswer = { incident_type: 'Intruder on site', priority: 'RED', site_id: site.id, description: 'Caller sees two people inside the yard.', caller: 'Mark, 07700 900123', missing: ['Direction of travel'] };
  const r = await call('POST', '/api/ai/triage', { text: 'mark rang, 2 lads in the yard now' }, dispT);
  assert.equal(r.status, 200);
  assert.equal(r.body.priority, 'RED');
  assert.equal(r.body.site_id, site.id);
  assert.deepEqual(r.body.missing, ['Direction of travel']);
  assert.equal(app.db.jobs.length, before, 'a suggestion must not create a job');
  assert.ok(lastRequest.messages[0].content.includes(site.name), 'the model is given the site list');
});

test('triage drops a site id and priority the model made up', async () => {
  nextAnswer = { incident_type: 'Alarm', priority: 'PURPLE', site_id: 99999, description: 'x', location: 'Unit 4, Somewhere' };
  const r = await call('POST', '/api/ai/triage', { text: 'alarm going off' }, dispT);
  assert.equal(r.body.site_id, null);
  assert.equal(r.body.priority, 'GREEN');
  assert.equal(r.body.location, 'Unit 4, Somewhere');
});

test('triage is control-only and needs text', async () => {
  assert.equal((await call('POST', '/api/ai/triage', { text: 'x' }, danT)).status, 403);
  assert.equal((await call('POST', '/api/ai/triage', { text: '  ' }, dispT)).status, 400);
});

test('report drafting is limited to the assigned officer and does not save', async () => {
  const job = (await call('POST', '/api/jobs', { incident_type: 'Alarm activation', priority: 'AMBER', site: app.db.sites[0].id }, dispT)).body;
  const dan = app.db.personnel.find((p) => p.name === 'Dan Whitfield');
  await call('POST', `/api/jobs/${job.id}/assign`, { resources: [dan.id] }, dispT);

  nextAnswer = { report: 'I attended the site and found the rear door secure.', missing: ['Time of arrival'] };
  const ok = await call('POST', `/api/ai/jobs/${job.id}/report`, { notes: 'rear door secure, no sign of entry' }, danT);
  assert.equal(ok.status, 200);
  assert.match(ok.body.report, /rear door secure/);
  assert.ok(lastRequest.messages[0].content.includes(job.reference));

  const other = await call('POST', `/api/ai/jobs/${job.id}/report`, { notes: 'x' }, ellieT);
  assert.equal(other.status, 403, 'an officer not on the job cannot use it');
  const stored = app.db.jobs.find((j) => j.id === job.id);
  assert.ok(!stored.checklist.some((c) => c.notes.includes('I attended')), 'the draft is not written to the job');
});

test('unit ranking puts the nearest available unit first', async () => {
  const job = (await call('POST', '/api/jobs', { incident_type: 'Alarm activation', priority: 'AMBER', location: 'Test', lat: 53.6, lon: -0.2 }, dispT)).body;
  const [a, b, c] = app.db.mdts;
  Object.assign(a, { connected: true, lat: 53.7, lon: -0.2, job_id: null, duty_status: 'AVAILABLE' }); // ~11 km
  Object.assign(b, { connected: true, lat: 53.61, lon: -0.2, job_id: null, duty_status: 'AVAILABLE' }); // ~1 km
  if (c) Object.assign(c, { connected: true, lat: 53.6001, lon: -0.2, job_id: 123, duty_status: 'AVAILABLE' }); // closest but busy
  const r = await call('GET', `/api/ai/jobs/${job.id}/units`, undefined, dispT);
  assert.equal(r.status, 200);
  assert.equal(r.body.units[0].mdt, b.mdt_code);
  assert.equal(r.body.units[0].available, true);
  if (c) assert.equal(r.body.units.find((u) => u.mdt === c.mdt_code).available, false);
});

test('voice routes need the shared secret', async () => {
  assert.equal((await call('GET', '/api/integrations/voice/sites?q=test')).status, 401);
  assert.equal((await call('POST', '/api/integrations/voice/jobs', { location: 'x' }, null, { 'x-voice-secret': 'wrong' })).status, 401);
});

test('voice site lookup returns names and addresses only', async () => {
  const site = app.db.sites[0];
  const r = await call('GET', `/api/integrations/voice/sites?q=${encodeURIComponent(site.name.split(' ')[0])}`, undefined, null, voice);
  assert.equal(r.status, 200);
  assert.ok(r.body.length >= 1);
  assert.deepEqual(Object.keys(r.body[0]).sort(), ['address', 'id', 'name']);
});

test('a phone job is flagged, alerts control and is not duplicated on retry', async () => {
  const site = app.db.sites[0];
  const payload = { call_id: 'call-abc', site_id: site.id, priority: 'red', incident_type: 'Intruder on site', description: 'Two people in the yard', caller_name: 'Mark', caller_number: '07700900123', transcript: 'AI: Echelon...' };
  const first = await call('POST', '/api/integrations/voice/jobs', payload, null, voice);
  assert.equal(first.status, 201);
  assert.equal(first.body.priority, 'RED');
  const again = await call('POST', '/api/integrations/voice/jobs', payload, null, voice);
  assert.equal(again.status, 200);
  assert.equal(again.body.id, first.body.id);
  const job = app.db.jobs.find((j) => j.id === first.body.id);
  assert.equal(job.external_source, 'ai-call');
  assert.match(job.description, /AI phone assistant/);
  assert.match(job.caller, /Mark, 07700900123/);
});

test('a phone message lands in the control inbox once', async () => {
  const p = { call_id: 'call-msg-1', caller_name: 'Ian', caller_number: '01472000000', message: 'Please call back about the camera quote.' };
  const r = await call('POST', '/api/integrations/voice/messages', p, null, voice);
  assert.equal(r.status, 201);
  assert.equal(r.body.to_label, 'CONTROL');
  assert.equal((await call('POST', '/api/integrations/voice/messages', p, null, voice)).body.id, r.body.id);
  const inbox = (await call('GET', '/api/messages', undefined, dispT)).body;
  assert.ok(inbox.some((m) => m.id === r.body.id));
});
