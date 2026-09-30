/* Foot-officer live location (FOOT_TRACKING) — node --test
 *
 * Continuous personal location tracking is a materially different privacy
 * position from the single GPS fix an emergency already takes (see
 * docs/PRIVACY.md), so this is off by default and the route itself refuses
 * outright until FOOT_TRACKING=on — not just quietly ignored client-side.
 * Once on, it mirrors the MDT auto-progress mechanism (checkAutoJobProgress)
 * for a foot officer's own job or patrol visit. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4017';
process.env.AUTH_SECRET = 'foot-tracking-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';
delete process.env.FOOT_TRACKING;

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

let adminT, dispT, danT, ellieT, dan, ellie;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dispT = await login('dispatcher', 'dispatch123');
  danT = await login('dwhitfield', 'field123');
  ellieT = await login('emarsh', 'field123');
  dan = app.db.personnel.find((p) => p.name === 'Dan Whitfield');
  ellie = app.db.personnel.find((p) => p.name === 'Ellie Marsh');
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

test('foot tracking is off by default: the config flag says so, and the route refuses even a valid report', async () => {
  assert.equal((await call('GET', '/api/config', undefined, danT)).body.foot_tracking, false);
  const r = await call('POST', `/api/personnel/${dan.id}/location`, { lat: 53.0, lon: -1.0 }, danT);
  assert.equal(r.status, 403);
});

test('once enabled, a FIELD_USER can report only their own position', async () => {
  process.env.FOOT_TRACKING = 'on';
  assert.equal((await call('GET', '/api/config', undefined, danT)).body.foot_tracking, true);

  const before_ = app.db.locations.length;
  const r = await call('POST', `/api/personnel/${dan.id}/location`, { lat: 53.1, lon: -1.1 }, danT);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(app.db.locations.length, before_ + 1);
  const row = app.db.locations[app.db.locations.length - 1];
  assert.equal(row.personnel_id, dan.id);
  assert.equal(row.mdt_id, null);

  const personnel = await call('GET', '/api/personnel', undefined, dispT);
  const danNow = personnel.body.find((p) => p.id === dan.id);
  assert.equal(danNow.lat, 53.1);
  assert.equal(danNow.lon, -1.1);
  assert.ok(danNow.location_at);

  assert.equal((await call('POST', `/api/personnel/${ellie.id}/location`, { lat: 1, lon: 1 }, danT)).status, 403, 'cannot report someone else\'s position');
  assert.equal((await call('POST', `/api/personnel/${dan.id}/location`, { lat: 1, lon: 1 }, dispT)).status, 403, 'route is FIELD_USER only, not control');
  assert.equal((await call('POST', `/api/personnel/${dan.id}/location`, { lat: 'nope', lon: -1 }, danT)).status, 400);
});

test('a foot officer\'s own job auto-progresses EN_ROUTE -> ON_SCENE by proximity, same as an MDT\'s', async () => {
  process.env.FOOT_TRACKING = 'on';
  const JOB_LAT = 53.5, JOB_LON = -1.5;
  const job = (await call('POST', '/api/jobs', { priority: 'GREEN', incident_type: 'Foot patrol test', location: 'Foot patrol test site', lat: JOB_LAT, lon: JOB_LON }, dispT)).body;
  await call('POST', `/api/jobs/${job.id}/assign`, { resources: [dan.id] }, dispT);
  await call('POST', `/api/jobs/${job.id}/ack`, {}, danT);

  // ~1.1km away: establishes a distance baseline, no transition yet.
  await call('POST', `/api/personnel/${dan.id}/location`, { lat: JOB_LAT + 0.01, lon: JOB_LON }, danT);
  let after1 = (await call('GET', '/api/jobs', undefined, dispT)).body.find((j) => j.id === job.id);
  assert.equal(after1.status, 'ACKNOWLEDGED');

  // Meaningfully closer, but outside the 100m arrival radius: EN_ROUTE.
  await call('POST', `/api/personnel/${dan.id}/location`, { lat: JOB_LAT + 0.001, lon: JOB_LON }, danT);
  let after2 = (await call('GET', '/api/jobs', undefined, dispT)).body.find((j) => j.id === job.id);
  assert.equal(after2.status, 'EN_ROUTE');

  // Within the arrival radius: ON_SCENE.
  await call('POST', `/api/personnel/${dan.id}/location`, { lat: JOB_LAT, lon: JOB_LON }, danT);
  let after3 = (await call('GET', '/api/jobs', undefined, dispT)).body.find((j) => j.id === job.id);
  assert.equal(after3.status, 'ON_SCENE');
});

test('a foot officer\'s own patrol visit auto-progresses to ON_SCENE by proximity to the site', async () => {
  process.env.FOOT_TRACKING = 'on';
  const sites = (await call('GET', '/api/sites', undefined, dispT)).body;
  const site = sites.find((s) => s.name === 'Meridian Business Park');
  const visit = (await call('POST', '/api/site-visits', { site_id: site.id, scheduled_for: new Date().toISOString() }, dispT)).body;
  await call('POST', `/api/site-visits/${visit.id}/assign`, { personnel: dan.id }, dispT);
  await call('POST', `/api/site-visits/${visit.id}/ack`, {}, danT);

  await call('POST', `/api/personnel/${dan.id}/location`, { lat: site.lat, lon: site.lon }, danT);
  const after = (await call('GET', '/api/site-visits', undefined, dispT)).body.find((v) => v.id === visit.id);
  assert.equal(after.status, 'ON_SCENE');
});

test('erasing a person\'s location history also clears their last-known position', async () => {
  process.env.FOOT_TRACKING = 'on';
  await call('POST', `/api/personnel/${ellie.id}/location`, { lat: 53.2, lon: -1.2 }, ellieT);
  const before_ = (await call('GET', '/api/personnel', undefined, dispT)).body.find((p) => p.id === ellie.id);
  assert.ok(before_.lat != null);

  await call('POST', `/api/personnel/${ellie.id}/erase-location-history`, {}, adminT);
  const after_ = (await call('GET', '/api/personnel', undefined, dispT)).body.find((p) => p.id === ellie.id);
  assert.equal(after_.lat, null);
  assert.equal(after_.lon, null);
  assert.equal(after_.location_at, null);
});
