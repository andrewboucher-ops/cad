/* Duplicating an asset: same item, its own tag and serial number, a clean
 * history — all or nothing (server.js POST /api/assets/:id/duplicate) —
 * node --test */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4056';
process.env.AUTH_SECRET = 'asset-dup-test-secret';
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

let adminT, dispT, src;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123'); dispT = await login('dispatcher', 'dispatch123');
  const v = app.db.vehicles[0];
  src = (await call('POST', '/api/assets', {
    tag: 'RAD-014', category: 'RADIO', description: 'Handheld radio', serial_no: 'SN-AAA', make: 'Motorola', model: 'DP4400e',
    supplier: 'Radio Co', purchase_cost: 450, pat_required: true, pat_interval_days: 365, check_interval_days: 90, condition: 'GOOD',
    vehicle_id: v.id, notes: 'with belt clip',
  }, adminT)).body;
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

test('copies get everything about the item, their own tag and serial, and a clean start', async () => {
  assert.equal((await call('POST', `/api/assets/${src.id}/duplicate`, { copies: [{ tag: 'RAD-015' }] }, dispT)).status, 403, 'admins only');
  const r = await call('POST', `/api/assets/${src.id}/duplicate`, { copies: [{ tag: 'RAD-015', serial_no: 'SN-BBB' }, { tag: 'RAD-016', serial_no: 'SN-CCC' }] }, adminT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.map((a) => [a.tag, a.serial_no]), [['RAD-015', 'SN-BBB'], ['RAD-016', 'SN-CCC']]);
  const c = app.db.assets.find((a) => a.tag === 'RAD-015');
  for (const k of ['category', 'description', 'make', 'model', 'supplier', 'purchase_cost', 'pat_required', 'pat_interval_days', 'check_interval_days', 'condition', 'notes']) {
    assert.deepEqual(c[k], app.db.assets.find((a) => a.id === src.id)[k], `${k} copied`);
  }
  assert.equal(c.status, 'IN_STORE');
  assert.equal(c.vehicle_id ?? null, null, 'not in the original\'s vehicle');
  assert.equal(c.pat_last_at ?? null, null, 'no test results of its own yet');
  assert.ok(c.pat_next_due_at && c.next_check_due_at, 'its first PAT and inspection are scheduled');
  assert.equal(c.duplicated_from, src.id);
});

test('all or nothing: a tag in use, or used twice, stops every copy', async () => {
  const before = app.db.assets.length;
  let r = await call('POST', `/api/assets/${src.id}/duplicate`, { copies: [{ tag: 'RAD-017' }, { tag: 'RAD-015' }] }, adminT);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /RAD-015/);
  r = await call('POST', `/api/assets/${src.id}/duplicate`, { copies: [{ tag: 'RAD-018' }, { tag: 'RAD-018' }] }, adminT);
  assert.equal(r.status, 409);
  r = await call('POST', `/api/assets/${src.id}/duplicate`, { copies: [{ tag: 'RAD-019', serial_no: 'X' }, { tag: 'RAD-020', serial_no: 'X' }] }, adminT);
  assert.equal(r.status, 400, 'same serial twice');
  assert.equal((await call('POST', `/api/assets/${src.id}/duplicate`, { copies: [{ tag: '' }] }, adminT)).status, 400, 'a tag is required');
  assert.equal(app.db.assets.length, before, 'nothing was created');
});

test('stock items are not duplicated', async () => {
  const stock = (await call('POST', '/api/assets', { category: 'CONSUMABLE', description: 'Gloves', is_stock_tracked: true }, adminT)).body;
  assert.equal((await call('POST', `/api/assets/${stock.id}/duplicate`, { copies: [{ tag: 'GL-1' }] }, adminT)).status, 400);
});
