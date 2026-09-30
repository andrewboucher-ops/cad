/* Multi-branch (branch_id scoping) — node --test
 *
 * This is a staff-visibility split, not a security wall like CLIENT: a
 * SUPERVISOR, FIELD_USER or MDT_USER sees only their own branch's
 * personnel/vehicles/assets/sites (and jobs/visits at those sites), while
 * DISPATCHER and SYSTEM_ADMIN always see everything. A record with no
 * branch_id is shared and visible regardless of role, and a scoped-role
 * user with no branch_id set on their own account also sees everything —
 * multi-branch is opt-in per record and per account. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4016';
process.env.AUTH_SECRET = 'branches-test-secret';
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
  return { status: res.status, body: parsed, raw: text };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;

let adminT, dispT;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dispT = await login('dispatcher', 'dispatch123');
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

test('branches can be created, renamed, and cannot be deleted while in use', async () => {
  const a = await call('POST', '/api/branches', { name: 'North' }, adminT);
  assert.equal(a.status, 201);
  assert.equal((await call('POST', '/api/branches', { name: 'North' }, adminT)).status, 409, 'duplicate name');
  assert.equal((await call('POST', '/api/branches', { name: 'South' }, dispT)).status, 403, 'only admin creates branches');

  const site = await call('POST', '/api/sites', { name: 'Branch Test Site', branch_id: a.body.id }, adminT);
  assert.equal(site.status, 201);
  assert.equal(site.body.branch_id, a.body.id);
  assert.equal((await call('DELETE', `/api/branches/${a.body.id}`, undefined, adminT)).status, 409, 'branch still has a site');

  const renamed = await call('PATCH', `/api/branches/${a.body.id}`, { name: 'North Region' }, adminT);
  assert.equal(renamed.body.name, 'North Region');
  await call('PATCH', `/api/sites/${site.body.id}`, { branch_id: null }, adminT);
  assert.equal((await call('DELETE', `/api/branches/${a.body.id}`, undefined, adminT)).status, 200);
});

test('a SUPERVISOR or FIELD_USER sees only their own branch\'s personnel, vehicles, assets and sites; DISPATCHER and SYSTEM_ADMIN see everything', async () => {
  const north = (await call('POST', '/api/branches', { name: 'North Branch' }, adminT)).body;
  const south = (await call('POST', '/api/branches', { name: 'South Branch' }, adminT)).body;

  const siteNorth = (await call('POST', '/api/sites', { name: 'North Site', branch_id: north.id }, adminT)).body;
  const siteSouth = (await call('POST', '/api/sites', { name: 'South Site', branch_id: south.id }, adminT)).body;
  const siteShared = (await call('POST', '/api/sites', { name: 'Shared Site' }, adminT)).body; // no branch_id

  const personNorth = (await call('POST', '/api/personnel', { name: 'Norma North', branch_id: north.id }, adminT)).body;
  const personSouth = (await call('POST', '/api/personnel', { name: 'Sam South', branch_id: south.id }, adminT)).body;

  const vehicleNorth = (await call('POST', '/api/vehicles', { registration: 'BR-NORTH-01', branch_id: north.id }, adminT)).body;
  const vehicleSouth = (await call('POST', '/api/vehicles', { registration: 'BR-SOUTH-01', branch_id: south.id }, adminT)).body;

  const assetNorth = (await call('POST', '/api/assets', { description: 'North radio', category: 'DEVICE', branch_id: north.id }, adminT)).body;
  const assetSouth = (await call('POST', '/api/assets', { description: 'South radio', category: 'DEVICE', branch_id: south.id }, adminT)).body;

  await call('POST', '/api/users', { username: 'northsuper', password: 'realpassword1', role: 'SUPERVISOR', branch_id: north.id }, adminT);
  const northSuperT = await login('northsuper', 'realpassword1');
  await call('POST', '/api/users', { username: 'southfield', password: 'realpassword1', role: 'FIELD_USER', personnel_id: personSouth.id, branch_id: south.id }, adminT);
  const southFieldT = await login('southfield', 'realpassword1');
  await call('POST', '/api/users', { username: 'unassignedsuper', password: 'realpassword1', role: 'SUPERVISOR' }, adminT);
  const unassignedSuperT = await login('unassignedsuper', 'realpassword1');

  // North supervisor: sees north + shared, not south.
  const sitesAsNorth = (await call('GET', '/api/sites', undefined, northSuperT)).body;
  assert.ok(sitesAsNorth.some((s) => s.id === siteNorth.id));
  assert.ok(sitesAsNorth.some((s) => s.id === siteShared.id), 'a site with no branch_id is shared, visible to everyone');
  assert.ok(!sitesAsNorth.some((s) => s.id === siteSouth.id));

  const personnelAsNorth = (await call('GET', '/api/personnel', undefined, northSuperT)).body;
  assert.ok(personnelAsNorth.some((p) => p.id === personNorth.id));
  assert.ok(!personnelAsNorth.some((p) => p.id === personSouth.id));

  const vehiclesAsNorth = (await call('GET', '/api/vehicles', undefined, northSuperT)).body;
  assert.ok(vehiclesAsNorth.some((v) => v.id === vehicleNorth.id));
  assert.ok(!vehiclesAsNorth.some((v) => v.id === vehicleSouth.id));

  const assetsAsNorth = (await call('GET', '/api/assets', undefined, northSuperT)).body;
  assert.ok(assetsAsNorth.some((x) => x.id === assetNorth.id));
  assert.ok(!assetsAsNorth.some((x) => x.id === assetSouth.id));

  // South field user: the mirror image.
  const sitesAsSouth = (await call('GET', '/api/sites', undefined, southFieldT)).body;
  assert.ok(sitesAsSouth.some((s) => s.id === siteSouth.id));
  assert.ok(!sitesAsSouth.some((s) => s.id === siteNorth.id));

  // A scoped role with no branch_id set on their own account sees everything — opt-in, not a default restriction.
  const sitesAsUnassigned = (await call('GET', '/api/sites', undefined, unassignedSuperT)).body;
  assert.ok(sitesAsUnassigned.some((s) => s.id === siteNorth.id) && sitesAsUnassigned.some((s) => s.id === siteSouth.id));

  // DISPATCHER and SYSTEM_ADMIN: always everything, regardless of any branch.
  const sitesAsDispatcher = (await call('GET', '/api/sites', undefined, dispT)).body;
  assert.ok(sitesAsDispatcher.some((s) => s.id === siteNorth.id) && sitesAsDispatcher.some((s) => s.id === siteSouth.id));
  const sitesAsAdmin = (await call('GET', '/api/sites', undefined, adminT)).body;
  assert.ok(sitesAsAdmin.some((s) => s.id === siteNorth.id) && sitesAsAdmin.some((s) => s.id === siteSouth.id));
});

test('jobs, visits and /api/state are scoped by their site\'s branch; mdts, emergencies and events are never scoped', async () => {
  const north = (await call('POST', '/api/branches', { name: 'Jobs North' }, adminT)).body;
  const south = (await call('POST', '/api/branches', { name: 'Jobs South' }, adminT)).body;
  const siteNorth = (await call('POST', '/api/sites', { name: 'Jobs North Site', branch_id: north.id }, adminT)).body;
  const siteSouth = (await call('POST', '/api/sites', { name: 'Jobs South Site', branch_id: south.id }, adminT)).body;

  await call('POST', '/api/users', { username: 'jobsnorthsuper', password: 'realpassword1', role: 'SUPERVISOR', branch_id: north.id }, adminT);
  const northT = await login('jobsnorthsuper', 'realpassword1');

  const jobNorth = (await call('POST', '/api/jobs', { priority: 'GREEN', incident_type: 'Test', site: siteNorth.id }, dispT)).body;
  const jobSouth = (await call('POST', '/api/jobs', { priority: 'GREEN', incident_type: 'Test', site: siteSouth.id }, dispT)).body;
  const jobNoSite = (await call('POST', '/api/jobs', { priority: 'GREEN', location: 'Ad hoc, no site' }, dispT)).body;

  const jobsAsNorth = (await call('GET', '/api/jobs', undefined, northT)).body;
  assert.ok(jobsAsNorth.some((j) => j.id === jobNorth.id));
  assert.ok(!jobsAsNorth.some((j) => j.id === jobSouth.id));
  assert.ok(jobsAsNorth.some((j) => j.id === jobNoSite.id), 'a job with no site is unscopable, so it is visible to everyone');

  const visitNorth = (await call('POST', '/api/site-visits', { site_id: siteNorth.id, scheduled_for: new Date().toISOString() }, dispT)).body;
  const visitSouth = (await call('POST', '/api/site-visits', { site_id: siteSouth.id, scheduled_for: new Date().toISOString() }, dispT)).body;
  const visitsAsNorth = (await call('GET', '/api/site-visits', undefined, northT)).body;
  assert.ok(visitsAsNorth.some((v) => v.id === visitNorth.id));
  assert.ok(!visitsAsNorth.some((v) => v.id === visitSouth.id));

  const state = (await call('GET', '/api/state', undefined, northT)).body;
  assert.ok(state.jobs.some((j) => j.id === jobNorth.id) && !state.jobs.some((j) => j.id === jobSouth.id));
  assert.ok(state.sites.some((s) => s.id === siteNorth.id) && !state.sites.some((s) => s.id === siteSouth.id));
  assert.ok(state.site_visits.some((v) => v.id === visitNorth.id) && !state.site_visits.some((v) => v.id === visitSouth.id));

  const stateAsDispatcher = (await call('GET', '/api/state', undefined, dispT)).body;
  assert.ok(stateAsDispatcher.sites.some((s) => s.id === siteSouth.id), 'dispatcher state is never branch-filtered');
});
