/* BroadNet Dispatch bridge — node --test.
 * Outbound: POST /api/jobs/:id/broadnet-push (operator-triggered, mirrors
 * the GoCardless "Collect via Direct Debit" pattern in agreements-invoices
 * .test.js). Inbound: POST /api/integrations/broadnet/webhook/:token,
 * mirroring AURA's single-endpoint-discriminated-by-shape pattern in
 * aura-callouts.test.js — no signature scheme exists on BroadNet's side,
 * so the token itself is the only auth, checked here. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

process.env.PORT = '4048';
process.env.AUTH_SECRET = 'broadnet-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';

const BNPORT = 4049, BNBASE = `http://127.0.0.1:${BNPORT}`;
process.env.BROADNET_ORG_KEY = 'test-org-key';
process.env.BROADNET_API_BASE = BNBASE;
process.env.BROADNET_WEBHOOK_TOKEN = 'test-webhook-token';
process.env.BROADNET_DEFAULT_CHANNEL_UUID = 'chan-1';

/* ---- a fake BroadNet: just the incidents endpoint broadnet.js uses ---- */
const BN = { incidents: [] };
const fakeBN = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const u = new URL(req.url, BNBASE);
    const m = u.pathname.match(/^\/api_dispatch\/v1\/organisations\/([^/]+)\/incidents$/);
    if (m && req.method === 'POST') {
      if (m[1] !== 'test-org-key') return send(404, { error: 'unknown organisation' });
      const body = JSON.parse(raw);
      const inc = { uuid: `INC-UUID-${BN.incidents.length + 1}`, ...body.incident };
      BN.incidents.push(inc);
      return send(201, { incident: inc });
    }
    send(404, { error: 'no such fake endpoint' });
  });
});

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
async function call(method, path, body, token, extraHeaders) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(extraHeaders || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;
const webhook = (body) => call('POST', '/api/integrations/broadnet/webhook/test-webhook-token', body);
const newJob = async (token, overrides = {}) => (await call('POST', '/api/jobs', { location: 'Test Street', incident_type: 'ALARM', priority: 'RED', ...overrides }, token)).body;

let adminT, dispT, fieldT;
before(async () => {
  await new Promise((r) => fakeBN.listen(BNPORT, '127.0.0.1', r));
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dispT = await login('dispatcher', 'dispatch123');
  await call('POST', '/api/users', { username: 'fielduser1', password: 'realpassword1', role: 'FIELD_USER' }, adminT);
  fieldT = await login('fielduser1', 'realpassword1');
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); fakeBN.close(); });

test('pushing a job to BroadNet creates an incident and stores its uuid', async () => {
  const j = await newJob(dispT);
  const r = await call('POST', `/api/jobs/${j.id}/broadnet-push`, undefined, dispT);
  assert.equal(r.status, 200);
  assert.match(r.body.broadnet_incident_uuid, /^INC-UUID-/);
  assert.ok(r.body.broadnet_pushed_at);
});

test('pushing the same job twice is rejected', async () => {
  const j = await newJob(dispT);
  const first = await call('POST', `/api/jobs/${j.id}/broadnet-push`, undefined, dispT);
  assert.equal(first.status, 200);
  const second = await call('POST', `/api/jobs/${j.id}/broadnet-push`, undefined, dispT);
  assert.equal(second.status, 409);
});

test('a non-control role cannot push a job to BroadNet', async () => {
  const j = await newJob(dispT);
  const r = await call('POST', `/api/jobs/${j.id}/broadnet-push`, undefined, fieldT);
  assert.equal(r.status, 403);
});

test('a bad or missing webhook token is rejected', async () => {
  const r = await call('POST', '/api/integrations/broadnet/webhook/wrong-token', { terminal: { network_id: 'NET1' } });
  assert.equal(r.status, 401);
});

test('a terminal event upserts broadnet_terminals with a translated status, and a repeat updates it in place', async () => {
  const r1 = await webhook({ terminal: { network_id: 'NET1', username: 'TT01', latitude: '51.5', longitude: '-0.12', incident_status: 'AVL', channel: 'C1', ptt_pressed: false } });
  assert.equal(r1.status, 200);
  let state = (await call('GET', '/api/state', undefined, dispT)).body;
  let t = state.broadnet_terminals.find((x) => x.network_id === 'NET1');
  assert.equal(t.status, 'AVAILABLE');
  assert.equal(t.username, 'TT01');

  const r2 = await webhook({ terminal: { network_id: 'NET1', username: 'TT01', latitude: '51.6', longitude: '-0.13', incident_status: 'EMG', channel: 'C1', ptt_pressed: true } });
  assert.equal(r2.status, 200);
  state = (await call('GET', '/api/state', undefined, dispT)).body;
  const terminals = state.broadnet_terminals.filter((x) => x.network_id === 'NET1');
  assert.equal(terminals.length, 1, 'the repeat updated the same terminal rather than adding a second one');
  assert.equal(terminals[0].status, 'EMERGENCY');
  assert.equal(terminals[0].lat, 51.6);
});

test('an incident-update webhook matching a pushed job appends a note', async () => {
  const j = await newJob(dispT);
  const pushed = (await call('POST', `/api/jobs/${j.id}/broadnet-push`, undefined, dispT)).body;
  const r = await webhook({ reason: 'incident.updated', incident: { uuid: pushed.broadnet_incident_uuid } });
  assert.equal(r.status, 200);
  assert.match(r.body.notes, /BroadNet incident\.updated/);
});

test('an allocation webhook matching a pushed job appends a note', async () => {
  const j = await newJob(dispT);
  const pushed = (await call('POST', `/api/jobs/${j.id}/broadnet-push`, undefined, dispT)).body;
  const r = await webhook({ reason: 'assigment.updated', allocation: { status: 'accepted', incident_uuid: pushed.broadnet_incident_uuid } });
  assert.equal(r.status, 200);
  assert.match(r.body.notes, /BroadNet assigment\.updated/);
});

test('an incident webhook with no matching job is logged only, not an error', async () => {
  const r = await webhook({ reason: 'incident.updated', incident: { uuid: 'INC-UUID-NOTHING-MATCHES' } });
  assert.equal(r.status, 200);
  assert.match(r.body.note, /no job matches/);
});

test('an unrecognised payload shape is logged only, not an error', async () => {
  const r = await webhook({ something: 'else' });
  assert.equal(r.status, 200);
  assert.match(r.body.note, /unrecognised/);
});
