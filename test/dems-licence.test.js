/* DEMS asks CCCS whether someone holds an in-date SIA CCTV licence before
 * showing them footage (server.js, /api/integrations/dems/licence) — node --test */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4071';
process.env.AUTH_SECRET = 'dems-licence-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
async function call(method, path, body, token) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

let adminT, ellie;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = (await call('POST', '/api/auth/login', { username: 'admin', password: 'admin123' })).body.token;
  ellie = app.db.personnel.find((p) => p.name === 'Ellie Marsh');
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

test('DEMS checks for an in-date SIA CCTV licence without seeing the number', async () => {
  process.env.DEMS_SECRET = 'test-dems-secret';
  const hdr = { 'x-dems-secret': 'test-dems-secret' };
  const ask = async (q) => (await fetch(BASE + '/api/integrations/dems/licence?' + q, { headers: hdr })).json();
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  await call('PATCH', `/api/personnel/${ellie.id}`, { contact_email: 'ellie@example.com', sia_licences: [
    { licence_type: 'Door Supervision', licence_no: 'DS-9', expiry: day(300) },
    { licence_type: 'CCTV (Public Space Surveillance)', licence_no: 'CCTV-9', expiry: day(-1) }] }, adminT);
  let r = await ask('email=Ellie@example.com');
  assert.equal(r.person.name, 'Ellie Marsh');
  assert.equal(r.cctv, null, 'an expired CCTV licence, or another type, does not count');
  await call('PATCH', `/api/personnel/${ellie.id}`, { sia_licences: [
    { licence_type: 'CCTV (Public Space Surveillance)', licence_no: 'CCTV-9', expiry: day(100) }] }, adminT);
  r = await ask('person=ellie%20marsh');
  assert.equal(r.cctv.expiry, day(100));
  assert.equal(r.cctv.verified, false);
  assert.ok(!JSON.stringify(r).includes('CCTV-9'), 'the licence number is not shared');
  assert.equal((await ask('email=nobody@example.com')).person, null);
  delete process.env.DEMS_SECRET;
});

test('DEMS needs its secret to ask about licences', async () => {
  process.env.DEMS_SECRET = 'test-dems-secret';
  assert.equal((await fetch(BASE + '/api/integrations/dems/licence?person=x')).status, 401);
  delete process.env.DEMS_SECRET;
});
