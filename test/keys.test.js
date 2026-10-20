/* Key management — safes, wallets, the key register, and disposal
 * (routes-keys.js) — node --test. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4050';
process.env.AUTH_SECRET = 'keys-test-secret';
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
const JPEG1PX = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

let adminT, dispT, danT, dan, job;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dispT = await login('dispatcher', 'dispatch123');
  danT = await login('dwhitfield', 'field123');
  dan = app.db.personnel.find((p) => p.name === 'Dan Whitfield');
  job = (await call('POST', '/api/jobs', { location: 'Riverside Depot', incident_type: 'ALARM', priority: 'AMBER' }, dispT)).body;
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

async function freshSafeAndWallet() {
  const s = (await call('POST', '/api/safes', { tag_id: `SAFE-${Date.now()}-${Math.random()}` }, adminT)).body;
  const w = (await call('POST', '/api/wallets', { safe_id: s.id, tag_id: `WAL-${Date.now()}-${Math.random()}`, seal_code: 'S-0001' }, adminT)).body;
  return { s, w };
}

test('creating safes/wallets/keys is admin-only; transfer and tag-check are control', async () => {
  assert.equal((await call('POST', '/api/safes', { tag_id: 'X' }, dispT)).status, 403);
  assert.equal((await call('POST', '/api/safes', { tag_id: 'X' }, danT)).status, 403);
  const { s, w } = await freshSafeAndWallet();
  assert.equal((await call('POST', '/api/wallets', { safe_id: s.id, tag_id: 'X', seal_code: '1' }, dispT)).status, 403);
  assert.equal((await call('POST', `/api/wallets/${w.id}/keys`, { tag_id: 'K1', description: 'Front door' }, dispT)).status, 403);
  const s2 = (await call('POST', '/api/safes', { tag_id: `SAFE-${Date.now()}` }, adminT)).body;
  assert.equal((await call('POST', `/api/wallets/${w.id}/transfer`, { to_safe_id: s2.id }, danT)).status, 403);
  assert.equal((await call('POST', `/api/wallets/${w.id}/transfer`, { to_safe_id: s2.id }, dispT)).status, 200, 'dispatcher is a control role');
  assert.equal((await call('POST', `/api/safes/${s.id}/tag-check`, { result: 'PASS' }, danT)).status, 403);
  assert.equal((await call('POST', `/api/safes/${s.id}/tag-check`, { result: 'PASS' }, dispT)).status, 200);
});

test('safe checkout requires both confirmation booleans, and blocks a second concurrent checkout', async () => {
  const { s } = await freshSafeAndWallet();
  assert.equal((await call('POST', `/api/safes/${s.id}/checkout`, { personnel_id: dan.id, not_left_in_vehicle_confirmed: true }, dispT)).status, 400, 'missing tags_confirmed');
  assert.equal((await call('POST', `/api/safes/${s.id}/checkout`, { personnel_id: dan.id, tags_confirmed: true }, dispT)).status, 400, 'missing vehicle confirmation');
  const ok = await call('POST', `/api/safes/${s.id}/checkout`, { personnel_id: dan.id, tags_confirmed: true, not_left_in_vehicle_confirmed: true }, dispT);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.status, 'SIGNED_OUT');
  const again = await call('POST', `/api/safes/${s.id}/checkout`, { personnel_id: dan.id, tags_confirmed: true, not_left_in_vehicle_confirmed: true }, dispT);
  assert.equal(again.status, 409, 'already signed out');
});

test('checkin requires tags_confirmed, and only the holder or a control role may do it', async () => {
  const { s } = await freshSafeAndWallet();
  await call('POST', `/api/safes/${s.id}/checkout`, { personnel_id: dan.id, tags_confirmed: true, not_left_in_vehicle_confirmed: true }, dispT);
  assert.equal((await call('POST', `/api/safes/${s.id}/checkin`, {}, danT)).status, 400, 'missing tags_confirmed');
  const ellieT = await login('emarsh', 'field123').catch(() => null);
  if (ellieT) assert.equal((await call('POST', `/api/safes/${s.id}/checkin`, { tags_confirmed: true }, ellieT)).status, 403, 'not their checkout');
  const ok = await call('POST', `/api/safes/${s.id}/checkin`, { tags_confirmed: true }, danT);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'IN_OFFICE');
  assert.equal((await call('POST', `/api/safes/${s.id}/checkout`, { personnel_id: dan.id, tags_confirmed: true, not_left_in_vehicle_confirmed: true }, dispT)).status, 201, 'can sign out again after checkin');
});

test('wallet open rejects a wrong seal code, a missing job_id, and an unknown job_id', async () => {
  const { w } = await freshSafeAndWallet();
  assert.equal((await call('POST', `/api/wallets/${w.id}/open`, { seal_code: 'WRONG', job_id: job.id }, danT)).status, 409);
  assert.equal((await call('POST', `/api/wallets/${w.id}/open`, { seal_code: 'S-0001' }, danT)).status, 400, 'job_id required');
  assert.equal((await call('POST', `/api/wallets/${w.id}/open`, { seal_code: 'S-0001', job_id: 999999 }, danT)).status, 404, 'unknown job');
  const ok = await call('POST', `/api/wallets/${w.id}/open`, { seal_code: 'S-0001', job_id: job.id }, danT);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'OPEN');
  const events = (await call('GET', `/api/wallets/${w.id}/events`, undefined, dispT)).body;
  assert.ok(events.some((e) => e.type === 'OPENED' && e.job_id === job.id));
});

test('reseal requires the wallet to currently be open', async () => {
  const { w } = await freshSafeAndWallet();
  assert.equal((await call('POST', `/api/wallets/${w.id}/reseal`, { new_seal_code: 'S-NEW' }, danT)).status, 409, 'still sealed, never opened');
  await call('POST', `/api/wallets/${w.id}/open`, { seal_code: 'S-0001', job_id: job.id }, danT);
  const ok = await call('POST', `/api/wallets/${w.id}/reseal`, { new_seal_code: 'S-NEW' }, danT);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'SEALED');
  assert.equal((await call('POST', `/api/wallets/${w.id}/reseal`, { new_seal_code: 'S-OTHER' }, danT)).status, 409, 'already sealed again');
});

test('transfer moves the wallet between safes and logs one TRANSFERRED event', async () => {
  const { s: fromSafe, w } = await freshSafeAndWallet();
  const toSafe = (await call('POST', '/api/safes', { tag_id: `SAFE-${Date.now()}-b` }, adminT)).body;
  assert.equal((await call('POST', `/api/wallets/${w.id}/transfer`, { to_safe_id: fromSafe.id }, dispT)).status, 400, 'same safe');
  const ok = await call('POST', `/api/wallets/${w.id}/transfer`, { to_safe_id: toSafe.id }, dispT);
  assert.equal(ok.status, 200);
  const fromList = (await call('GET', `/api/safes/${fromSafe.id}`, undefined, dispT)).body;
  const toList = (await call('GET', `/api/safes/${toSafe.id}`, undefined, dispT)).body;
  assert.ok(!fromList.wallets.some((x) => x.id === w.id));
  assert.ok(toList.wallets.some((x) => x.id === w.id));
  const events = (await call('GET', `/api/wallets/${w.id}/events`, undefined, dispT)).body.filter((e) => e.type === 'TRANSFERRED');
  assert.equal(events.length, 1);
  assert.equal(events[0].from_safe_id, fromSafe.id);
  assert.equal(events[0].to_safe_id, toSafe.id);
});

test('a tag-check FAIL is logged and visible but does not change custody status', async () => {
  const { s } = await freshSafeAndWallet();
  assert.equal((await call('POST', `/api/safes/${s.id}/tag-check`, { result: 'MAYBE' }, dispT)).status, 400);
  await call('POST', `/api/safes/${s.id}/tag-check`, { result: 'FAIL', note: 'torn tag on the main lock' }, dispT);
  const after2 = (await call('GET', `/api/safes/${s.id}`, undefined, dispT)).body;
  assert.equal(after2.status, 'IN_OFFICE', 'a tag-check finding is not a custody change');
  const events = (await call('GET', `/api/safes/${s.id}/events`, undefined, dispT)).body;
  assert.ok(events.some((e) => e.type === 'TAG_CHECK' && e.result === 'FAIL'));
});

test('retiring a key RETURNED_TO_CLIENT requires a signature, and it leaves the wallet\'s active list', async () => {
  const { w } = await freshSafeAndWallet();
  const k = (await call('POST', `/api/wallets/${w.id}/keys`, { tag_id: 'K-100', description: 'Fire exit' }, adminT)).body;
  assert.equal((await call('POST', `/api/keys/${k.id}/retire`, { disposition: 'RETURNED_TO_CLIENT', signed_by_name: 'J Smith' }, adminT)).status, 400, 'no signature');
  assert.equal((await call('POST', `/api/keys/${k.id}/retire`, { disposition: 'RETURNED_TO_CLIENT', signature: { mimetype: 'image/jpeg', data: JPEG1PX } }, adminT)).status, 400, 'no signed_by_name');
  const ok = await call('POST', `/api/keys/${k.id}/retire`, { disposition: 'RETURNED_TO_CLIENT', signed_by_name: 'J Smith', signature: { mimetype: 'image/jpeg', data: JPEG1PX } }, adminT);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'RETURNED_TO_CLIENT');
  const wallet = (await call('GET', `/api/wallets/${w.id}`, undefined, adminT)).body;
  assert.ok(!wallet.keys.some((x) => x.id === k.id), 'retired key no longer in the active list');
  assert.equal((await call('POST', `/api/keys/${k.id}/retire`, { disposition: 'DISPOSED' }, adminT)).status, 409, 'already retired');
});

test('retiring a key DISPOSED generates a fetchable certificate, and reports no client email on file rather than erroring', async () => {
  const { w } = await freshSafeAndWallet();
  const k = (await call('POST', `/api/wallets/${w.id}/keys`, { tag_id: 'K-200', description: 'Side gate' }, adminT)).body;
  const ok = await call('POST', `/api/keys/${k.id}/retire`, { disposition: 'DISPOSED' }, adminT);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'DISPOSED');
  assert.equal(ok.body.disposition.email_ok, false);
  assert.match(ok.body.disposition.email_error, /no client email on file/);
  const cert = await call('GET', `/api/keys/${k.id}/certificate`, undefined, adminT);
  assert.equal(cert.status, 200);
});
