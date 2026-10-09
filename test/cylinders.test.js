/* Medical gas cylinders (routes-cylinders.js) — node --test */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4043';
process.env.AUTH_SECRET = 'cylinders-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
async function call(method, path, body, token) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;

let adminT, dispT, danT, main, van;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dispT = await login('dispatcher', 'dispatch123');
  danT = await login('dwhitfield', 'field123');
  main = (await call('GET', '/api/stock/locations', undefined, adminT)).body.find((l) => l.is_main);
  van = (await call('POST', '/api/stock/locations', { name: 'Ambulance 1 kit', kind: 'VEHICLE' }, adminT)).body;
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });
const one = async (id) => (await call('GET', '/api/cylinders', undefined, dispT)).body.cylinders.find((c) => c.id === id);

test('admins receive cylinders; control logs them; officers cannot see the register', async () => {
  assert.equal((await call('GET', '/api/cylinders', undefined, danT)).status, 403);
  assert.equal((await call('POST', '/api/cylinders', { serial: 'X1', gas: 'OXYGEN' }, dispT)).status, 403, 'only an admin adds one');
  assert.equal((await call('POST', '/api/cylinders', { serial: 'X1', gas: 'HELIUM' }, adminT)).status, 400);
  assert.equal((await call('POST', '/api/cylinders', { gas: 'OXYGEN' }, adminT)).status, 400, 'serial required');
  const r = await call('POST', '/api/cylinders', { serial: 'OX-1001', gas: 'OXYGEN', size: 'cd', supplier: 'BOC', batch_no: 'B77', expiry_date: '2030-01-31', location_id: main.id, reference: 'DN-55' }, adminT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, 'FULL'); assert.equal(r.body.contents_pct, 100); assert.equal(r.body.size, 'CD');
  assert.equal(r.body.check_overdue, true, 'never checked');
  assert.equal((await call('POST', '/api/cylinders', { serial: 'ox-1001', gas: 'OXYGEN' }, adminT)).status, 409, 'serials are unique on the register');
  const secs = (await call('GET', '/api/ui/sections', undefined, dispT)).body.map((x) => x.key);
  assert.ok(secs.includes('cylinders'), 'control sees Medical gases in the menu');
});

test('check, move, use and empty an oxygen cylinder, with its history', async () => {
  const c = (await call('POST', '/api/cylinders', { serial: 'OX-2002', gas: 'OXYGEN', size: 'CD', location_id: main.id }, adminT)).body;
  let r = await call('POST', `/api/cylinders/${c.id}/log`, { type: 'CHECKED', contents_pct: 100, seal_intact: true }, dispT);
  assert.equal(r.body.status, 'FULL'); assert.equal(r.body.check_overdue, false);
  r = await call('POST', `/api/cylinders/${c.id}/log`, { type: 'MOVED', location_id: van.id }, dispT);
  assert.equal(r.body.location_name, 'Ambulance 1 kit');
  assert.equal((await call('POST', `/api/cylinders/${c.id}/log`, { type: 'USED' }, dispT)).status, 400, 'what is left is required');
  r = await call('POST', `/api/cylinders/${c.id}/log`, { type: 'USED', contents_pct: 20, reference: 'JOB-9' }, dispT);
  assert.equal(r.body.status, 'IN_USE'); assert.equal(r.body.low, true, '20% is low');
  assert.equal((await call('POST', `/api/cylinders/${c.id}/log`, { type: 'USED', contents_pct: 60 }, dispT)).status, 400, 'use cannot add gas');
  r = await call('POST', `/api/cylinders/${c.id}/log`, { type: 'USED', contents_pct: 0 }, dispT);
  assert.equal(r.body.status, 'EMPTY');
  const sum = (await call('GET', '/api/cylinders', undefined, dispT)).body.summary;
  assert.ok(sum.to_return >= 1, 'empties wait to go back');
  const h = (await call('GET', `/api/cylinders/${c.id}/history`, undefined, dispT)).body.map((e) => e.type);
  assert.deepEqual(h, ['USED', 'USED', 'MOVED', 'CHECKED', 'RECEIVED'], 'newest first');
  assert.equal((await call('DELETE', `/api/cylinders/${c.id}`, undefined, adminT)).status, 409, 'a cylinder with history is returned, not deleted');
});

test('a broken seal is never full; faults quarantine; returned cylinders leave the list', async () => {
  const c = (await call('POST', '/api/cylinders', { serial: 'EN-3003', gas: 'ENTONOX', size: 'D', ownership: 'RENTED' }, adminT)).body;
  let r = await call('POST', `/api/cylinders/${c.id}/log`, { type: 'CHECKED', contents_pct: 100, seal_intact: false }, dispT);
  assert.equal(r.body.status, 'IN_USE', 'opened, whatever the gauge says');
  assert.equal((await call('POST', `/api/cylinders/${c.id}/log`, { type: 'FAULT' }, dispT)).status, 400, 'say what is wrong');
  r = await call('POST', `/api/cylinders/${c.id}/log`, { type: 'FAULT', note: 'valve leaking' }, dispT);
  assert.equal(r.body.status, 'QUARANTINE');
  r = await call('POST', `/api/cylinders/${c.id}/log`, { type: 'CHECKED', contents_pct: 100, seal_intact: true }, dispT);
  assert.equal(r.body.status, 'QUARANTINE', 'a check does not clear a fault');
  r = await call('POST', `/api/cylinders/${c.id}/log`, { type: 'RETURNED', reference: 'COL-1' }, dispT);
  assert.equal(r.body.status, 'RETURNED'); assert.equal(r.body.location_id, null);
  assert.ok(!(await one(c.id)), 'gone from the working list');
  assert.ok((await call('GET', '/api/cylinders?include_returned=1', undefined, dispT)).body.cylinders.some((x) => x.id === c.id));
  assert.equal((await call('POST', `/api/cylinders/${c.id}/log`, { type: 'MOVED', location_id: main.id }, dispT)).status, 409);
  assert.equal((await call('POST', '/api/cylinders', { serial: 'EN-3003', gas: 'ENTONOX' }, adminT)).status, 201, 'the supplier can send the same cylinder back later');
});

test('expiry is flagged, and a mistaken record can be deleted', async () => {
  const c = (await call('POST', '/api/cylinders', { serial: 'OX-4004', gas: 'OXYGEN', expiry_date: '2020-01-01' }, adminT)).body;
  assert.equal(c.expired, true);
  const soon = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  assert.equal((await call('PATCH', `/api/cylinders/${c.id}`, { expiry_date: soon }, adminT)).body.expiring_soon, true);
  assert.equal((await call('PATCH', `/api/cylinders/${c.id}`, { expiry_date: 'soon' }, adminT)).status, 400);
  assert.equal((await call('DELETE', `/api/cylinders/${c.id}`, undefined, dispT)).status, 403);
  assert.equal((await call('DELETE', `/api/cylinders/${c.id}`, undefined, adminT)).status, 200);
});
