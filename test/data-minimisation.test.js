/* What an officer can see about colleagues, and who can read the audit log —
 * node --test
 *
 * The audit log carries failed-login usernames, sickness leave, applicant
 * names and raw alarm payloads, so it is control's alone. A colleague's live
 * position and HR record (DBS, right-to-work, notes, leave) are control's and
 * the person's own; name, call sign and SIA licence stay shared. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4061';
process.env.AUTH_SECRET = 'data-minimisation-test-secret';
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

let officerT, dispT, dan, ellie;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  officerT = await login('dwhitfield', 'field123');
  dispT = await login('dispatcher', 'dispatch123');
  dan = app.db.personnel.find((p) => p.name === 'Dan Whitfield');
  ellie = app.db.personnel.find((p) => p.name === 'Ellie Marsh');
  Object.assign(ellie, { dbs_certificate_no: '001234567890', rtw_reference: 'W123456', notes: 'private HR note', lat: 53.5, lon: -0.1 });
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

test('an officer cannot read the audit log; control can', async () => {
  assert.strictEqual((await call('GET', '/api/events', undefined, officerT)).status, 403);
  assert.strictEqual((await call('GET', '/api/events', undefined, dispT)).status, 200);
  assert.deepStrictEqual((await call('GET', '/api/state', undefined, officerT)).body.events, []);
  assert.ok((await call('GET', '/api/state', undefined, dispT)).body.events.length > 0);
});

test('an officer sees a colleague\'s name and call sign, not their HR record or position', async () => {
  const rows = (await call('GET', '/api/personnel', undefined, officerT)).body;
  const other = rows.find((p) => p.id === ellie.id);
  assert.strictEqual(other.name, 'Ellie Marsh');
  for (const k of ['dbs_certificate_no', 'rtw_reference', 'notes', 'lat', 'lon', 'leave_balance', 'compliance']) assert.ok(!(k in other), `${k} leaked`);
  const self = rows.find((p) => p.id === dan.id);
  assert.ok('leave_balance' in self && 'compliance' in self, 'officer still sees their own record');
  const stateOther = (await call('GET', '/api/state', undefined, officerT)).body.personnel.find((p) => p.id === ellie.id);
  assert.ok(!('lat' in stateOther) && !('dbs_certificate_no' in stateOther));
});

test('control still sees colleagues\' position and compliance, but /api/state never carries bank details', async () => {
  const fromList = (await call('GET', '/api/personnel', undefined, dispT)).body.find((p) => p.id === ellie.id);
  assert.strictEqual(fromList.dbs_certificate_no, '001234567890');
  const fromState = (await call('GET', '/api/state', undefined, dispT)).body.personnel.find((p) => p.id === ellie.id);
  assert.strictEqual(fromState.lat, 53.5);
  assert.ok('compliance' in fromState);
  assert.ok(!('bank_details' in fromState));
});
