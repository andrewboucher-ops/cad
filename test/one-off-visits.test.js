/* One-off visits for a client at an address that isn't one of their sites
 * (AURA passing on a patrol at their own customer's premises): control
 * books it, a one-off site is made under the client and reused for the
 * same address, the client sees it in their portal, nobody else does,
 * and nothing is invoiced — node --test */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4157';
process.env.AUTH_SECRET = 'one-off-visits-test-secret';
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

let adminT, dispT;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dispT = await login('dispatcher', 'dispatch123');
  app.mailer.send = async () => ({ ok: true });
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

test('control books a one-off visit for a client at a new address; the client sees it, another client does not', async () => {
  const aura = (await call('POST', '/api/clients', { name: 'Aura Test', contact_email: 'ops@aura.example' }, adminT)).body;
  const other = (await call('POST', '/api/clients', { name: 'Other Client Ltd' }, adminT)).body;
  await call('POST', '/api/users', { username: 'auraclient', password: 'realpassword1', role: 'CLIENT', client_id: aura.id }, adminT);
  await call('POST', '/api/users', { username: 'otherclient', password: 'realpassword1', role: 'CLIENT', client_id: other.id }, adminT);
  const auraT = await login('auraclient', 'realpassword1');
  const otherT = await login('otherclient', 'realpassword1');

  // Needs a client and an address.
  assert.equal((await call('POST', '/api/site-visits/one-off', { address: '1 High St' }, dispT)).status, 400);
  assert.equal((await call('POST', '/api/site-visits/one-off', { client_id: aura.id, address: ' ' }, dispT)).status, 400);
  // Field staff can't book them.
  const fieldT = await login('dwhitfield', 'field123');
  assert.equal((await call('POST', '/api/site-visits/one-off', { client_id: aura.id, address: '1 High St' }, fieldT)).status, 403);

  const when = new Date(Date.now() + 3600000).toISOString();
  const r = await call('POST', '/api/site-visits/one-off', {
    client_id: aura.id, client_ref: 'AURA-778', customer_name: 'Smith Joinery', address: 'Unit 4, Mill Lane, Hull', postcode: 'hu1 1aa',
    scheduled_for: when, access_instructions: 'Code 1234 on side gate', notes: 'Check rear roller shutter',
  }, dispT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, 'SCHEDULED');
  assert.equal(r.body.one_off, true);
  assert.equal(r.body.client_ref, 'AURA-778');
  assert.equal(r.body.scheduled_for, when);
  assert.equal(r.body.site_address, 'Unit 4, Mill Lane, Hull');
  assert.equal(r.body.site_postcode, 'HU1 1AA');
  assert.equal(r.body.site_access, 'Code 1234 on side gate');
  assert.match(r.body.site_name, /Aura Test — Smith Joinery/);
  assert.deepEqual(r.body.warnings, []);

  const site = (await call('GET', '/api/sites', undefined, adminT)).body.find((s) => s.id === r.body.site_id);
  assert.equal(site.one_off, true);
  assert.equal(site.client_id, aura.id);
  assert.equal(site.contact_email, 'ops@aura.example', 'the report goes to the client');

  // The same address again reuses the one-off site.
  const again = await call('POST', '/api/site-visits/one-off', { client_id: aura.id, address: 'unit 4 mill lane hull', postcode: 'HU11AA' }, dispT);
  assert.equal(again.status, 201);
  assert.equal(again.body.site_id, r.body.site_id);

  // Client portal: Aura sees the visits, the other client doesn't.
  const mine = await call('GET', '/api/client/site-visits', undefined, auraT);
  assert.equal(mine.status, 200);
  assert.ok(mine.body.some((v) => v.reference === r.body.reference), JSON.stringify(mine.body));
  const theirs = await call('GET', '/api/client/site-visits', undefined, otherT);
  assert.ok(!(theirs.body || []).some((v) => v.reference === r.body.reference));

  // It runs like any visit and the report carries the address and their reference.
  const p = (await call('GET', '/api/personnel', undefined, dispT)).body[0];
  assert.equal((await call('POST', `/api/site-visits/${r.body.id}/assign`, { personnel: p.id }, dispT)).status, 200);
  const done = await call('PATCH', `/api/site-visits/${r.body.id}`, { status: 'COMPLETED' }, dispT);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.match(done.body.report_html, /AURA-778/);
  assert.match(done.body.report_html, /Mill Lane/);
});

test('a client with no contact email gets a warning, not a failure', async () => {
  const c = (await call('POST', '/api/clients', { name: 'No Email Client' }, adminT)).body;
  const r = await call('POST', '/api/site-visits/one-off', { client_id: c.id, address: '9 Station Rd' }, dispT);
  assert.equal(r.status, 201);
  assert.match(r.body.warnings.join(' '), /no contact email/);
});
