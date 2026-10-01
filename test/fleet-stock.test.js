/* Vehicle/asset allocation and the stock ledger (routes-fleet-stock.js) —
 * node --test
 *
 * Two independent rules worth testing hardest: a physical thing (a
 * vehicle, or a non-stock-tracked asset) can never be allocated to two
 * overlapping shifts, and a stock-tracked asset's level is always the
 * ledger's own resulting_balance — never a field anyone can overwrite
 * directly, only ever moved by a recorded entry. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4026';
process.env.AUTH_SECRET = 'fleet-stock-test-secret';
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

let adminT, dispT, patrolTypeId, vanId;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dispT = await login('dispatcher', 'dispatch123');
  patrolTypeId = app.db.shift_types.find((t) => t.key === 'MOBILE_PATROL').id;
  vanId = app.db.vehicles.find((v) => v.registration === 'VAN-101').id;
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

function future(hours) { return new Date(Date.now() + hours * 3600000).toISOString(); }
async function shift(startHour, endHour) {
  const r = await call('POST', '/api/shifts', { shift_type_id: patrolTypeId, starts_at: future(startHour), ends_at: future(endHour) }, dispT);
  return r.body;
}

test('a vehicle cannot be allocated to two overlapping shifts, but a later non-overlapping one is fine', async () => {
  const shiftA = await shift(24, 32);
  const shiftB = await shift(28, 36); // overlaps shiftA
  const shiftC = await shift(40, 48); // does not overlap either

  const allocA = await call('POST', `/api/shifts/${shiftA.id}/vehicles`, { vehicle_id: vanId }, dispT);
  assert.equal(allocA.status, 201);
  assert.equal(allocA.body.vehicle_registration, 'VAN-101');

  assert.equal((await call('POST', `/api/shifts/${shiftB.id}/vehicles`, { vehicle_id: vanId }, dispT)).status, 409, 'overlapping window refused');
  const allocC = await call('POST', `/api/shifts/${shiftC.id}/vehicles`, { vehicle_id: vanId }, dispT);
  assert.equal(allocC.status, 201, 'a later, non-overlapping shift is fine');

  const withAlloc = (await call('GET', '/api/shifts', undefined, dispT)).body.find((s) => s.id === shiftA.id);
  assert.equal(withAlloc.vehicle_allocations.length, 1);

  await call('DELETE', `/api/shift-vehicle-allocations/${allocA.body.id}`, undefined, dispT);
  const allocBRetry = await call('POST', `/api/shifts/${shiftB.id}/vehicles`, { vehicle_id: vanId }, dispT);
  assert.equal(allocBRetry.status, 201, 'freed up once the conflicting allocation is removed');
});

test('cancelling a shift frees its vehicle for an overlapping allocation elsewhere', async () => {
  const shiftA = await shift(60, 68);
  const shiftB = await shift(62, 70);
  await call('POST', `/api/shifts/${shiftA.id}/vehicles`, { vehicle_id: vanId }, dispT);
  assert.equal((await call('POST', `/api/shifts/${shiftB.id}/vehicles`, { vehicle_id: vanId }, dispT)).status, 409);
  await call('PATCH', `/api/shifts/${shiftA.id}`, { status: 'CANCELLED' }, dispT);
  assert.equal((await call('POST', `/api/shifts/${shiftB.id}/vehicles`, { vehicle_id: vanId }, dispT)).status, 201, 'a cancelled shift no longer holds the vehicle');
});

test('a stock-tracked asset is allocated and returned through the ledger, never a field anyone can overwrite', async () => {
  const kit = (await call('POST', '/api/assets', {
    category: 'EQUIPMENT', description: 'First aid plasters', is_stock_tracked: true, low_stock_threshold: 10, initial_quantity: 40,
  }, adminT)).body;
  assert.equal(kit.stock_level, 40);

  const s = await shift(80, 88);
  const alloc = await call('POST', `/api/shifts/${s.id}/assets`, { asset_id: kit.id, quantity: 15 }, dispT);
  assert.equal(alloc.status, 201);
  const afterAllocate = (await call('GET', '/api/assets', undefined, dispT)).body.find((a) => a.id === kit.id);
  assert.equal(afterAllocate.stock_level, 25, 'allocating withdraws from the ledger immediately');

  assert.equal((await call('POST', `/api/shifts/${s.id}/assets`, { asset_id: kit.id, quantity: 100 }, dispT)).status, 409, 'cannot allocate more than is in stock');

  const returned = await call('PATCH', `/api/shift-asset-allocations/${alloc.body.id}`, { quantity_returned: 9 }, dispT);
  assert.equal(returned.status, 200);
  const afterReturn = (await call('GET', '/api/assets', undefined, dispT)).body.find((a) => a.id === kit.id);
  assert.equal(afterReturn.stock_level, 34, 'only what actually came back (9 of 15) is credited — 6 were used on the job');

  assert.equal((await call('PATCH', `/api/shift-asset-allocations/${alloc.body.id}`, { quantity_returned: 5 }, dispT)).status, 409, 'cannot return an allocation twice');

  const movements = (await call('GET', `/api/assets/${kit.id}/stock-movements`, undefined, dispT)).body;
  assert.deepEqual(movements.map((m) => m.delta), [9, -15, 40], 'most recent first: returned, allocated, initial restock');
  assert.equal(movements[0].resulting_balance, 34);
});

test('a manual stock movement is refused below zero, and a non-stock asset refuses a quantity other than 1', async () => {
  const radio = (await call('POST', '/api/assets', { category: 'DEVICE', description: 'Handheld radio #9' }, adminT)).body;
  assert.equal(radio.is_stock_tracked, false);
  assert.equal((await call('POST', `/api/assets/${radio.id}/stock-movements`, { reason: 'RESTOCK', delta: 5 }, adminT)).status, 400, 'not stock-tracked');

  const gloves = (await call('POST', '/api/assets', { category: 'EQUIPMENT', description: 'Gloves (pairs)', is_stock_tracked: true, initial_quantity: 3 }, adminT)).body;
  assert.equal((await call('POST', `/api/assets/${gloves.id}/stock-movements`, { reason: 'DAMAGED', delta: -10 }, adminT)).status, 400, 'would go below zero');
  const ok = await call('POST', `/api/assets/${gloves.id}/stock-movements`, { reason: 'DAMAGED', delta: -2, note: 'torn on site' }, adminT);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.resulting_balance, 1);

  const s = await shift(100, 108);
  assert.equal((await call('POST', `/api/shifts/${s.id}/assets`, { asset_id: radio.id, quantity: 2 }, dispT)).status, 400, 'a discrete asset can only be allocated as quantity 1');
});

test('the stock dashboard flags items below threshold and expiring within 30 days, control-only', async () => {
  const dressings = (await call('POST', '/api/assets', {
    category: 'EQUIPMENT', description: 'Sterile dressings', is_stock_tracked: true, low_stock_threshold: 20, initial_quantity: 5,
    expiry_date: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10),
  }, adminT)).body;

  assert.equal((await call('GET', '/api/stock-dashboard', undefined, undefined)).status, 401);
  const dashboard = await call('GET', '/api/stock-dashboard', undefined, dispT);
  assert.equal(dashboard.status, 200);
  const row = dashboard.body.find((a) => a.id === dressings.id);
  assert.equal(row.below_threshold, true);
  assert.equal(row.expiring_soon, true);
  assert.equal(row.expired, false);
});
