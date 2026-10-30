/* Expired SIA licence / right to work blocks rostering and clock-in —
 * node --test
 *
 * Supplying an unlicensed operative is an offence, so the rota refuses it
 * unless an admin gives a reason, which is logged. A licence that is merely
 * missing never blocks: medics and office staff hold none. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4063';
process.env.AUTH_SECRET = 'licence-block-test-secret';
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
const iso = (hours) => new Date(Date.now() + hours * 3600000).toISOString();

let adminT, officerT, dan, ellie, ryan, typeId, siteId;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  officerT = await login('dwhitfield', 'field123');
  dan = app.db.personnel.find((p) => p.name === 'Dan Whitfield');
  ellie = app.db.personnel.find((p) => p.name === 'Ellie Marsh');
  ryan = app.db.personnel.find((p) => p.name === 'Ryan Cole');
  typeId = app.db.shift_types.find((t) => t.key === 'MOBILE_PATROL').id;
  siteId = (await call('POST', '/api/sites', { name: 'Licence Test Site' }, adminT)).body.id;
  dan.sia_licences = [{ id: 1, licence_type: 'Door Supervision', licence_no: '1', expiry: '2020-01-01' }];
  ellie.sia_licences = [{ id: 1, licence_type: 'Door Supervision', licence_no: '2', expiry: '2020-01-01' }, { id: 2, licence_type: 'Security Guarding', licence_no: '3', expiry: '2099-01-01' }];
  ryan.sia_licences = []; ryan.sia_licence_no = null; ryan.rtw_expiry = '2020-06-01';
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

const newShift = async () => (await call('POST', '/api/shifts', { shift_type_id: typeId, site_id: siteId, starts_at: iso(-0.5), ends_at: iso(8) }, adminT)).body;

test('an officer whose only SIA licence has expired cannot be rostered without a reason', async () => {
  const s = await newShift();
  const r = await call('POST', `/api/shifts/${s.id}/assignments`, { personnel: dan.id }, adminT);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'LICENCE_EXPIRED');
  assert.match(r.body.error, /SIA licence expired on 2020-01-01/);
  const ok = await call('POST', `/api/shifts/${s.id}/assignments`, { personnel: dan.id, compliance_override_reason: 'Medic cover, no licence needed' }, adminT);
  assert.strictEqual(ok.status, 201);
  assert.ok(app.db.audit_logs.some((e) => e.type === 'compliance.override' && /Medic cover/.test(e.summary)));
});

test('the officer cannot clock in on an expired licence, and cannot override it', async () => {
  const a = app.db.shift_assignments.filter((x) => x.personnel_id === dan.id).pop();
  const r = await call('POST', `/api/shift-assignments/${a.id}/clock-in`, { compliance_override_reason: 'please' }, officerT);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'LICENCE_EXPIRED');
  assert.strictEqual(a.clocked_in_at, null);
});

test('one expired licence alongside a valid one does not block', async () => {
  const s = await newShift();
  assert.strictEqual((await call('POST', `/api/shifts/${s.id}/assignments`, { personnel: ellie.id }, adminT)).status, 201);
});

test('an expired right to work blocks; no licence on file does not', async () => {
  const s = await newShift();
  const r = await call('POST', `/api/shifts/${s.id}/assignments`, { personnel: ryan.id }, adminT);
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, /right to work expired/);
  ryan.rtw_expiry = null;
  assert.strictEqual((await call('POST', `/api/shifts/${s.id}/assignments`, { personnel: ryan.id }, adminT)).status, 201);
});
