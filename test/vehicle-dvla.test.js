/* Vehicle Data Global lookup (POST /api/vehicles/:id/dvla-lookup) — node
 * --test. global.fetch is monkey-patched only for calls to the provider's
 * host; calls to this test's own server pass through to the real fetch, so
 * the test helper below keeps working undisturbed. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4041';
process.env.AUTH_SECRET = 'vehicle-dvla-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';
process.env.VDG_API_KEY = 'test-key'; // read once at module load by dvla.js

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
const realFetch = global.fetch;
function mockDvla(responder) {
  global.fetch = async (url, opts) => {
    if (typeof url === 'string' && url.includes('ukvehicledata.co.uk')) return responder(url, opts);
    return realFetch(url, opts);
  };
}
async function call(method, path, body, token) {
  const res = await realFetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;

let adminT, dispT, vehicleId;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123'); dispT = await login('dispatcher', 'dispatch123');
  vehicleId = (await call('POST', '/api/vehicles', { registration: 'AB12 CDE', type: 'Response car' }, adminT)).body.id;
});
after(() => { global.fetch = realFetch; app.server.closeAllConnections?.(); app.server.close(); });

test('a dispatcher cannot run a vehicle lookup — fleet records are admin-only', async () => {
  assert.equal((await call('POST', `/api/vehicles/${vehicleId}/dvla-lookup`, undefined, dispT)).status, 403);
});

test('a lookup against a vehicle that does not exist 404s', async () => {
  assert.equal((await call('POST', '/api/vehicles/999999/dvla-lookup', undefined, adminT)).status, 404);
});

test('a successful lookup updates make, colour, tax/MOT status and due dates', async () => {
  mockDvla(async (url) => {
    assert.match(url, /\/api\/datapackage\/VehicleData\?/, 'calls the configured package via GET query params');
    assert.match(url, /key_VRM=AB12CDE/);
    assert.match(url, /auth_apikey=test-key/);
    return {
      ok: true,
      json: async () => ({
        Response: {
          StatusCode: 0, StatusMessage: 'Success',
          VehicleRegistration: { Make: 'FORD', Colour: 'BLUE' },
          DataItems: { VehicleStatus: { MotVed: { TaxStatus: 'Taxed', TaxDue: '2027-03-01', MotStatus: 'Valid', MotDue: '2026-11-15' } } },
        },
      }),
    };
  });
  const r = await call('POST', `/api/vehicles/${vehicleId}/dvla-lookup`, undefined, adminT);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.make, 'FORD');
  assert.equal(r.body.colour, 'BLUE');
  assert.equal(r.body.tax_status, 'Taxed');
  assert.equal(r.body.mot_status, 'Valid');
  assert.equal(r.body.tax_due_at, '2027-03-01');
  assert.equal(r.body.mot_due_at, '2026-11-15');
  assert.ok(r.body.dvla_checked_at, 'records when the check was made');
});

test('a non-success status code from the provider is surfaced as an error, not silently ignored', async () => {
  mockDvla(async () => ({
    ok: true,
    json: async () => ({ Response: { StatusCode: 7, StatusMessage: 'Invalid VRM supplied' } }),
  }));
  const r = await call('POST', `/api/vehicles/${vehicleId}/dvla-lookup`, undefined, adminT);
  assert.equal(r.status, 502);
  assert.match(r.body.error, /Invalid VRM supplied/);
});

test('a response with none of the expected fields is reported as an error rather than silently half-empty', async () => {
  mockDvla(async () => ({
    ok: true,
    json: async () => ({ Response: { StatusCode: 0, StatusMessage: 'Success', SomeOtherShape: { Whatever: true } } }),
  }));
  const r = await call('POST', `/api/vehicles/${vehicleId}/dvla-lookup`, undefined, adminT);
  assert.equal(r.status, 502);
  assert.match(r.body.error, /no recognised|expected vehicle fields/i);
});

test('a transport failure is reported as an error rather than throwing an unhandled 500', async () => {
  mockDvla(async () => { throw new TypeError('fetch failed'); });
  const r = await call('POST', `/api/vehicles/${vehicleId}/dvla-lookup`, undefined, adminT);
  assert.equal(r.status, 502);
  assert.match(r.body.error, /fetch failed/);
});
