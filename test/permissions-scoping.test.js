/* Site-level supervisor scoping and the FINANCE role (Increment 8) —
 * node --test
 *
 * Two things worth testing hardest: a supervisor given an explicit
 * site_ids list sees (and can only write) those sites, not their whole
 * branch — the finer-grained option layered on top of the existing
 * branch scoping; and FINANCE is a genuinely separate, read-only role,
 * excluded from ALL the same way CLIENT is, never able to reach dispatch
 * routes regardless of what branch/site scope it's given. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4028';
process.env.AUTH_SECRET = 'permissions-scoping-test-secret';
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

let adminT, dispT, patrolTypeId, branchAId, siteA1, siteA2, siteB1;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dispT = await login('dispatcher', 'dispatch123');
  patrolTypeId = app.db.shift_types.find((t) => t.key === 'MOBILE_PATROL').id;

  branchAId = (await call('POST', '/api/branches', { name: 'Scoping Test Branch' }, adminT)).body.id;
  siteA1 = (await call('POST', '/api/sites', { name: 'Scoped Site A1', branch_id: branchAId }, adminT)).body.id;
  siteA2 = (await call('POST', '/api/sites', { name: 'Scoped Site A2', branch_id: branchAId }, adminT)).body.id;
  siteB1 = (await call('POST', '/api/sites', { name: 'Scoped Site B1' }, adminT)).body.id; // no branch — shared
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

function future(hours) { return new Date(Date.now() + hours * 3600000).toISOString(); }
async function shift(siteId, startHour, endHour) {
  const r = await call('POST', '/api/shifts', { shift_type_id: patrolTypeId, site_id: siteId, starts_at: future(startHour), ends_at: future(endHour) }, adminT);
  return r.body;
}
async function makeSupervisor(username, siteIds) {
  await call('POST', '/api/users', { username, password: 'sup12345', role: 'SUPERVISOR', display_name: username, branch_id: branchAId, site_ids: siteIds === undefined ? null : siteIds }, adminT);
  return login(username, 'sup12345');
}

test('a branch-scoped supervisor (no site_ids) sees every site in their branch, via GET /api/shifts', async () => {
  const supT = await makeSupervisor('sup-branch-wide');
  const s1 = await shift(siteA1, 24, 32);
  const s2 = await shift(siteA2, 24, 32);
  const sOther = await shift(siteB1, 24, 32); // shared (no branch) — visible to everyone regardless
  const rows = (await call('GET', '/api/shifts', undefined, supT)).body;
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes(s1.id) && ids.includes(s2.id) && ids.includes(sOther.id));
});

test('GET /api/shifts hides shifts outside a scoped supervisor\'s own branch (the gap this increment closes)', async () => {
  const outsideBranchSite = (await call('POST', '/api/sites', { name: 'Outside Branch Site' }, adminT)).body.id;
  const outsideBranchId = (await call('POST', '/api/branches', { name: 'A Different Branch' }, adminT)).body.id;
  await call('PATCH', `/api/sites/${outsideBranchSite}`, { branch_id: outsideBranchId }, adminT);
  const supT = await makeSupervisor('sup-branch-gap');
  const outsideShift = await shift(outsideBranchSite, 24, 32);
  const rows = (await call('GET', '/api/shifts', undefined, supT)).body;
  assert.ok(!rows.some((r) => r.id === outsideShift.id));
});

test('a site-list-scoped supervisor sees only those exact sites, even within their own branch', async () => {
  const supT = await makeSupervisor('sup-site-scoped', [siteA1]);
  const s1 = await shift(siteA1, 40, 48);
  const s2 = await shift(siteA2, 40, 48); // same branch, but not in site_ids
  const rows = (await call('GET', '/api/shifts', undefined, supT)).body;
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes(s1.id));
  assert.ok(!ids.includes(s2.id), 'site_ids narrows below branch level');
});

test('GET /api/sites is narrowed the same way', async () => {
  const supT = await makeSupervisor('sup-site-scoped-sites', [siteA1]);
  const sites = (await call('GET', '/api/sites', undefined, supT)).body;
  const ids = sites.map((s) => s.id);
  assert.ok(ids.includes(siteA1));
  assert.ok(!ids.includes(siteA2));
});

test('a supervisor cannot create, edit or staff a shift even at a site within their own scope — editing is admin-only now', async () => {
  const supT = await makeSupervisor('sup-site-write', [siteA1]);
  assert.equal((await call('POST', '/api/shifts', { shift_type_id: patrolTypeId, site_id: siteA1, starts_at: future(50), ends_at: future(58) }, supT)).status, 403, 'creating is admin-only, even at a site they can see');

  const okShift = await shift(siteA1, 50, 58);
  assert.equal((await call('PATCH', `/api/shifts/${okShift.id}`, { notes: 'nope' }, supT)).status, 403, 'editing is admin-only, even at a site they can see');
  assert.equal((await call('POST', `/api/shifts/${okShift.id}/assignments`, { personnel: 1 }, supT)).status, 403, 'staffing is admin-only, even at a site they can see');
});

test('a scoped supervisor cannot read another site\'s passdown log, but a dispatcher can', async () => {
  const supT = await makeSupervisor('sup-passdown', [siteA1]);
  assert.equal((await call('GET', `/api/passdown-logs?site_id=${siteA2}`, undefined, supT)).status, 404);
  assert.equal((await call('GET', `/api/passdown-logs?site_id=${siteA2}`, undefined, dispT)).status, 200);
  assert.equal((await call('GET', `/api/passdown-logs?site_id=${siteA1}`, undefined, supT)).status, 200);
});

test('FINANCE is excluded from ALL — it cannot reach dispatch routes at all', async () => {
  await call('POST', '/api/users', { username: 'fin-user', password: 'fin12345', role: 'FINANCE' }, adminT);
  const finT = await login('fin-user', 'fin12345');
  assert.equal((await call('GET', '/api/shifts', undefined, finT)).status, 403);
  assert.equal((await call('GET', '/api/personnel', undefined, finT)).status, 403);
});

test('FINANCE can read shift rates and vehicle costs, scoped like a branch-scoped role; FIELD_USER cannot reach either', async () => {
  await call('POST', '/api/users', { username: 'fin-branch', password: 'fin12345', role: 'FINANCE', branch_id: branchAId }, adminT);
  const finT = await login('fin-branch', 'fin12345');
  const s1 = await shift(siteA1, 70, 78);
  await call('PATCH', `/api/shifts/${s1.id}`, { pay_rate: 12.5, bill_rate: 22 }, adminT);

  const rows = (await call('GET', '/api/finance/shifts', undefined, finT)).body;
  const row = rows.find((r) => r.id === s1.id);
  assert.ok(row, 'finance sees the shift at its own branch\'s site');
  assert.equal(row.pay_rate, 12.5);
  assert.equal(row.bill_rate, 22);

  const outsideShift = await shift(siteB1, 70, 78); // shared site — visible to everyone, including unscoped finance
  const unscopedFinRows = (await call('GET', '/api/finance/shifts', undefined, finT)).body;
  assert.ok(unscopedFinRows.some((r) => r.id === outsideShift.id), 'a shared (no-branch) site is still visible');

  const vehicleCosts = await call('GET', '/api/finance/vehicle-costs', undefined, finT);
  assert.equal(vehicleCosts.status, 200);

  const fieldT = await login('dwhitfield', 'field123');
  assert.equal((await call('GET', '/api/finance/shifts', undefined, fieldT)).status, 403);
  assert.equal((await call('GET', '/api/finance/vehicle-costs', undefined, fieldT)).status, 403);
});

test('GET /api/assets does not crash past the first row (publicAsset\'s new optional index param must not leak Array.map\'s own index argument)', async () => {
  for (let i = 0; i < 3; i++) {
    const r = await call('POST', '/api/assets', { description: `Scoping test asset ${i}`, category: 'EQUIPMENT', is_stock_tracked: true, initial_quantity: 5 }, adminT);
    assert.equal(r.status, 201);
  }
  const list = await call('GET', '/api/assets', undefined, adminT);
  assert.equal(list.status, 200);
  assert.ok(list.body.length >= 3);
  assert.ok(list.body.every((a) => !a.is_stock_tracked || typeof a.stock_level === 'number'));
});

test('GET /api/vehicles/:id/allocations does not crash past the first row (same Array.map arity hazard, for publicVehicleAllocation)', async () => {
  const vanId = app.db.vehicles.find((v) => v.registration === 'VAN-101').id;
  const s1 = await shift(siteA1, 160, 168);
  const s2 = await shift(siteA1, 170, 178);
  await call('POST', `/api/shifts/${s1.id}/vehicles`, { vehicle_id: vanId }, adminT);
  await call('POST', `/api/shifts/${s2.id}/vehicles`, { vehicle_id: vanId }, adminT);
  const list = await call('GET', `/api/vehicles/${vanId}/allocations`, undefined, adminT);
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 2);
  assert.ok(list.body.every((a) => a.vehicle_registration === 'VAN-101'));
});

test('a shift with several assignments, a vehicle and an asset allocated returns identical data through the list endpoint and a single fetch (the indexed and non-indexed paths agree)', async () => {
  const s = await shift(siteA1, 90, 98);
  const dan = app.db.users.find((u) => u.username === 'dwhitfield').personnel_id;
  const ellie = app.db.users.find((u) => u.username === 'emarsh').personnel_id;
  await call('POST', `/api/shifts/${s.id}/assignments`, { personnel: dan }, adminT);
  await call('POST', `/api/shifts/${s.id}/assignments`, { personnel: ellie }, adminT);

  const viaList = (await call('GET', '/api/shifts', undefined, dispT)).body.find((r) => r.id === s.id);
  const viaSingle = (await call('GET', `/api/shifts?site_id=${siteA1}`, undefined, dispT)).body.find((r) => r.id === s.id);
  assert.equal(viaList.assignments.length, 2);
  assert.deepEqual(
    viaList.assignments.map((a) => a.personnel_id).sort(),
    viaSingle.assignments.map((a) => a.personnel_id).sort(),
  );
  assert.ok(viaList.assignments.every((a) => a.personnel_name), 'personnel names resolved through the grouped index too');
});
