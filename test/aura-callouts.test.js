/* AURA callout webhook (POST /api/integrations/aura/jobs) — node --test.
 * Covers the corrections made after AURA's clarification email of
 * 2026-10-06: predefinedLocationId -> site mapping, calloutClassification
 * TEST handling alongside internalTest, and dedup of a resent status event. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4042';
process.env.AUTH_SECRET = 'aura-callouts-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';
process.env.AURA_SECRET = 'aura-test-secret';

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
async function call(method, path, body, token, extraHeaders) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(extraHeaders || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;
const aura = (body) => call('POST', '/api/integrations/aura/jobs', body, null, { 'x-aura-secret': 'aura-test-secret' });

let adminT, mappedSite;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  mappedSite = (await call('POST', '/api/sites', { name: 'Riverside Depot', address: '1 River Rd', aura_location_id: 'LOC-9001' }, adminT)).body;
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

test('a bad or missing secret is rejected', async () => {
  const res = await call('POST', '/api/integrations/aura/jobs', { message: 'NEW_CALLOUT', callout: { id: 1 } }, null, { 'x-aura-secret': 'wrong' });
  assert.equal(res.status, 401);
});

test('an internal connectivity-test callout is logged but creates no job', async () => {
  const r = await aura({ message: 'NEW_CALLOUT', callout: { id: 5001, internalTest: true, incidentInformation: [{}] } });
  assert.equal(r.status, 200);
  assert.match(r.body.note, /internal test/);
});

test('a TEST-classification callout is logged but creates no job, same as internalTest', async () => {
  const r = await aura({ message: 'NEW_CALLOUT', callout: { id: 5002, calloutClassification: { value: 'TEST' }, incidentInformation: [{}] } });
  assert.equal(r.status, 200);
  assert.match(r.body.note, /TEST classification/);
});

test('a real callout with a mapped predefinedLocationId lands on that site, not as address text', async () => {
  const r = await aura({
    message: 'NEW_CALLOUT',
    callout: {
      id: 5003, calloutClassification: { value: 'REAL' }, internalTest: false,
      incidentInformation: [{
        predefinedLocationId: 'LOC-9001',
        typeOfEmergency: { description: 'Security' }, incidentCategory: { description: 'Intruder alarm' },
        responseType: { value: 'SECURITY' },
        calloutCurrentLocation: { latitude: '51.5', longitude: '-0.1', formattedAddress: 'should not be used' },
      }],
    },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.site_id, mappedSite.id);
  assert.equal(r.body.priority, 'AMBER');
  assert.equal(r.body.lat, 51.5);
  assert.match(r.body.description, /SECURITY.*Intruder alarm/);
});

test('a real callout with no mapped site falls back to the address text', async () => {
  const r = await aura({
    message: 'NEW_CALLOUT',
    callout: {
      id: 5004,
      incidentInformation: [{
        predefinedLocationId: 'LOC-UNKNOWN',
        calloutCurrentLocation: { formattedAddress: '42 Unmapped Street' },
      }],
    },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.site_id, null);
  assert.equal(r.body.location, '42 Unmapped Street');
});

test('a lower-case incidentcategory (the real captured payload shape) is still read', async () => {
  const r = await aura({
    message: 'NEW_CALLOUT',
    callout: { id: 5005, incidentInformation: [{ incidentcategory: { description: 'Fire alarm' }, calloutCurrentLocation: { formattedAddress: 'x' } }] },
  });
  assert.match(r.body.description, /Fire alarm/);
});

test('resending the same callout id does not create a second job', async () => {
  const first = await aura({ message: 'NEW_CALLOUT', callout: { id: 5006, incidentInformation: [{ calloutCurrentLocation: { formattedAddress: 'Somewhere' } }] } });
  const second = await aura({ message: 'NEW_CALLOUT', callout: { id: 5006, incidentInformation: [{ calloutCurrentLocation: { formattedAddress: 'Somewhere' } }] } });
  assert.equal(second.status, 200);
  assert.equal(second.body.id, first.body.id);
});

test('a status-update event is appended to the matching job, and a repeat of it is deduped', async () => {
  await aura({ message: 'NEW_CALLOUT', callout: { id: 5007, incidentInformation: [{ calloutCurrentLocation: { formattedAddress: 'Somewhere else' } }] } });
  const r1 = await aura({ message: 'RESPONDER_ARRIVED_ON_SCENE', callout: { id: 5007 } });
  assert.equal(r1.status, 200);
  assert.match(r1.body.notes, /RESPONDER_ARRIVED_ON_SCENE/);
  const notesAfterFirst = r1.body.notes;
  const r2 = await aura({ message: 'RESPONDER_ARRIVED_ON_SCENE', callout: { id: 5007 } });
  assert.match(r2.body.note, /duplicate/);
  const job = (await call('GET', '/api/jobs', undefined, adminT)).body.find((j) => j.id === r1.body.id);
  assert.equal(job.notes, notesAfterFirst, 'the duplicate delivery did not add a second line');
});

test('a status update for a callout with no matching job is logged only', async () => {
  const r = await aura({ message: 'CALLOUT_CLOSED', callout: { id: 999999 } });
  assert.equal(r.status, 200);
  assert.match(r.body.note, /no job/);
});
