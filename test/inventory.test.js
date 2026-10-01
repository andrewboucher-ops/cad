/* Stock and asset management (routes-inventory.js) — node --test */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4032';
process.env.AUTH_SECRET = 'inventory-test-secret';
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

let adminT, dispT, danT, dan, ellie, main, van, vest;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dispT = await login('dispatcher', 'dispatch123');
  danT = await login('dwhitfield', 'field123');
  dan = app.db.personnel.find((p) => p.name === 'Dan Whitfield');
  ellie = app.db.personnel.find((p) => p.name === 'Ellie Marsh');
  main = (await call('GET', '/api/stock/locations', undefined, dispT)).body.find((l) => l.is_main);
  van = (await call('POST', '/api/stock/locations', { name: 'VAN-101 kit', kind: 'VEHICLE' }, adminT)).body;
  vest = (await call('POST', '/api/assets', { description: 'Hi-vis vest', size: 'L', sku: 'HV-L', category: 'UNIFORM', unit: 'each', is_stock_tracked: true, low_stock_threshold: 5, reorder_qty: 20, unit_cost: 4.5, supplier: 'Uniforms Ltd' }, adminT)).body;
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });
const item = async (id) => (await call('GET', '/api/stock/overview', undefined, dispT)).body.items.find((i) => i.id === id);

test('a main store exists, locations are admin-made, and item codes are unique', async () => {
  assert.ok(main, 'main store created automatically');
  assert.equal((await call('POST', '/api/stock/locations', { name: 'X' }, dispT)).status, 403);
  assert.equal((await call('POST', '/api/stock/locations', { name: 'van-101 KIT' }, adminT)).status, 409, 'names are unique');
  assert.equal((await call('POST', '/api/assets', { description: 'Dup', category: 'UNIFORM', sku: 'HV-L', is_stock_tracked: true }, adminT)).status, 409);
  assert.equal((await call('PATCH', `/api/stock/locations/${main.id}`, { active: false }, adminT)).status, 400, 'main store cannot be closed');
});

test('receive, move, issue and return keep a level per location, and never below zero', async () => {
  let r = await call('POST', `/api/stock/${vest.id}/receive`, { quantity: 30, location_id: main.id, unit_cost: 4.25, supplier: 'Uniforms Ltd', reference: 'PO-1001' }, dispT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await call('POST', `/api/stock/${vest.id}/receive`, { quantity: 1 }, danT)).status, 403, 'officers do not run the store');
  r = await call('POST', `/api/stock/${vest.id}/transfer`, { from_location_id: main.id, to_location_id: van.id, quantity: 10 }, dispT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  let i = await item(vest.id);
  assert.deepEqual([i.levels[main.id], i.levels[van.id], i.total], [20, 10, 30]);
  assert.equal(i.value, Math.round(30 * 4.25 * 100) / 100, 'valued at the latest unit cost');

  assert.equal((await call('POST', `/api/stock/${vest.id}/issue`, { quantity: 11, location_id: van.id, personnel_id: dan.id }, dispT)).status, 409, 'only 10 on the van');
  assert.equal((await call('POST', `/api/stock/${vest.id}/issue`, { quantity: 2, location_id: van.id }, dispT)).status, 400, 'to someone');
  assert.equal((await call('POST', `/api/stock/${vest.id}/issue`, { quantity: 3, location_id: van.id, personnel_id: dan.id }, dispT)).status, 201);
  i = await item(vest.id);
  assert.deepEqual([i.levels[van.id], i.total, i.issued_out], [7, 27, 3]);

  const held = (await call('GET', '/api/stock/holdings', undefined, danT)).body;
  assert.deepEqual(held.map((h) => [h.item, h.quantity]), [['Hi-vis vest (L)', 3]], 'an officer sees what they hold');
  await call('POST', `/api/stock/${vest.id}/issue`, { quantity: 1, location_id: main.id, personnel_id: ellie.id }, dispT);
  assert.equal((await call('GET', `/api/stock/holdings?personnel_id=${ellie.id}`, undefined, danT)).body.length, 1, 'but only their own, whatever they ask for');
  assert.ok((await call('GET', `/api/stock/holdings?personnel_id=${ellie.id}`, undefined, danT)).body.every((h) => h.personnel_id === dan.id));

  assert.equal((await call('POST', `/api/stock/${vest.id}/return`, { personnel_id: dan.id, quantity: 4, location_id: main.id }, dispT)).status, 409, 'cannot return more than held');
  assert.equal((await call('POST', `/api/stock/${vest.id}/return`, { personnel_id: dan.id, quantity: 1, location_id: main.id }, dispT)).status, 201);
  assert.equal((await call('POST', `/api/stock/${vest.id}/return`, { personnel_id: dan.id, quantity: 1, location_id: main.id, restock: false }, dispT)).status, 201);
  i = await item(vest.id);
  assert.deepEqual([i.levels[main.id], i.issued_out], [20, 2], 'one back on the shelf, one written off; Dan holds 1, Ellie 1');
});

test('adjustments take a reason, and a stocktake books only the differences', async () => {
  assert.equal((await call('POST', `/api/stock/${vest.id}/adjust`, { reason: 'DAMAGED', delta: 2, location_id: main.id }, dispT)).status, 400, 'damaged only removes');
  assert.equal((await call('POST', `/api/stock/${vest.id}/adjust`, { reason: 'AUDIT_CORRECTION', delta: -1, location_id: main.id }, dispT)).status, 400, 'a correction needs a note');
  assert.equal((await call('POST', `/api/stock/${vest.id}/adjust`, { reason: 'DAMAGED', delta: -2, location_id: main.id, note: 'torn' }, dispT)).status, 201);
  assert.equal((await item(vest.id)).levels[main.id], 18);

  const t = await call('POST', '/api/stock/stocktake', { location_id: main.id, counts: [{ item_id: vest.id, counted: 16 }], note: 'monthly' }, dispT);
  assert.equal(t.status, 201, JSON.stringify(t.body));
  assert.deepEqual([t.body.lines[0].expected, t.body.lines[0].counted, t.body.lines[0].diff], [18, 16, -2]);
  assert.equal((await item(vest.id)).levels[main.id], 16);
  const again = await call('POST', '/api/stock/stocktake', { location_id: main.id, counts: [{ item_id: vest.id, counted: 16 }] }, dispT);
  assert.equal(again.body.lines[0].diff, 0, 'a matching count changes nothing');
  assert.equal((await call('GET', '/api/stock/stocktakes', undefined, dispT)).body.length, 2);
});

test('at or under the reorder level an item is listed with a quantity to order', async () => {
  await call('POST', `/api/stock/${vest.id}/transfer`, { from_location_id: van.id, to_location_id: main.id, quantity: 7 }, dispT);
  await call('POST', `/api/stock/${vest.id}/adjust`, { reason: 'LOST', delta: -19, location_id: main.id, note: 'store flood' }, dispT);
  const i = await item(vest.id);
  assert.equal(i.total, 4);
  assert.equal(i.below_reorder, true);
  assert.equal(i.suggested_order, 20, 'the reorder quantity');
  assert.ok((await call('GET', '/api/stock/overview', undefined, dispT)).body.summary.below_reorder >= 1);
});

test('the rota still draws shift kit from the main store', async () => {
  const before_ = (await item(vest.id)).levels[main.id];
  const type = (await call('GET', '/api/shift-types', undefined, dispT)).body[0];
  const sr = await call('POST', '/api/shifts', { shift_type_id: type.id, starts_at: new Date(Date.now() + 86400e3).toISOString(), ends_at: new Date(Date.now() + 115200e3).toISOString() }, dispT);
  assert.equal(sr.status, 201, JSON.stringify(sr.body));
  const shift = sr.body;
  const r = await call('POST', `/api/shifts/${shift.id}/assets`, { asset_id: vest.id, quantity: 1 }, dispT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await item(vest.id)).levels[main.id], before_ - 1);
});

/* ---------------- assets ---------------- */
test('an asset is checked out with a due date, shows overdue, and comes back damaged into repair', async () => {
  const radio = (await call('POST', '/api/assets', { tag: 'RAD-001', description: 'Handheld radio', category: 'RADIO', make: 'Motorola', model: 'DP4400', purchase_cost: 450, warranty_expires_at: '2027-06-01', condition: 'GOOD', location_id: main.id, check_type: 'PAT test', check_interval_days: 365 }, adminT)).body;
  assert.equal(radio.make, 'Motorola');
  assert.equal((await call('POST', '/api/assets', { description: 'x', category: 'RADIO', condition: 'SHINY' }, adminT)).status, 400);
  const out = await call('POST', `/api/assets/${radio.id}/checkout`, { personnel_id: dan.id, expected_return_at: new Date(Date.now() - 86400e3).toISOString() }, dispT);
  assert.equal(out.status, 201, JSON.stringify(out.body));
  let reg = (await call('GET', '/api/assets/register', undefined, dispT)).body;
  let row = reg.assets.find((a) => a.id === radio.id);
  assert.equal(row.checkout.personnel_name, 'Dan Whitfield');
  assert.equal(row.checkout.overdue, true);
  assert.ok(reg.summary.overdue_returns >= 1);
  assert.equal((await call('POST', `/api/assets/${radio.id}/status`, { status: 'RETIRED', note: 'old' }, dispT)).status, 409, 'return it first');

  const back = await call('POST', `/api/assets/${radio.id}/return`, { condition: 'DAMAGED', notes: 'cracked screen' }, dispT);
  assert.equal(back.body.status, 'IN_REPAIR');
  assert.equal((await call('POST', `/api/assets/${radio.id}/checkout`, { personnel_id: dan.id }, dispT)).status, 409, 'not issued while in repair');

  const ins = await call('POST', `/api/assets/${radio.id}/inspect`, { result: 'PASS', note: 'repaired and tested' }, dispT);
  assert.equal(ins.status, 200);
  assert.equal(ins.body.next_check_due_at, new Date(Date.now() + 365 * 86400e3).toISOString().slice(0, 10), 'next check from the interval');
  await call('POST', `/api/assets/${radio.id}/status`, { status: 'IN_STORE', note: 'fixed' }, dispT);

  const hist = (await call('GET', `/api/assets/${radio.id}/history`, undefined, dispT)).body.map((h) => h.type);
  for (const t of ['CHECKED_OUT', 'RETURNED', 'INSPECTED', 'BACK_IN_STORE']) assert.ok(hist.includes(t), `history has ${t}`);
});

test('lost while issued ends the check-out against that person; lost and retired need a reason', async () => {
  const cam = (await call('POST', '/api/assets', { tag: 'BC-01', description: 'Body camera', category: 'BODY_CAMERA' }, adminT)).body;
  await call('POST', `/api/assets/${cam.id}/checkout`, { personnel_id: ellie.id }, dispT);
  assert.equal((await call('POST', `/api/assets/${cam.id}/status`, { status: 'LOST' }, dispT)).status, 400, 'reason required');
  const lost = await call('POST', `/api/assets/${cam.id}/status`, { status: 'LOST', note: 'dropped on patrol' }, dispT);
  assert.equal(lost.body.status, 'LOST');
  assert.ok(app.db.asset_checkouts.find((c) => c.asset_id === cam.id).returned_at, 'check-out closed');
  assert.equal((await call('POST', `/api/assets/${cam.id}/checkout`, { personnel_id: ellie.id }, dispT)).status, 409, 'a lost asset cannot be issued');
  const found = await call('POST', `/api/assets/${cam.id}/status`, { status: 'IN_STORE', note: 'handed in' }, dispT);
  assert.equal(found.body.status, 'IN_STORE');
  assert.ok((await call('GET', `/api/assets/${cam.id}/history`, undefined, dispT)).body.some((h) => h.type === 'FOUND'));
  assert.equal((await call('GET', '/api/assets/register', undefined, danT)).status, 403, 'the register is for control');
});
