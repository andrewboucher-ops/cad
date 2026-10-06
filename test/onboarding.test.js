/* Onboarding checklist (server.js: onboardingStatusForPerson, publicPersonnel,
 * POST/DELETE /api/personnel/:id/onboarding-complete) — node --test
 *
 * The checklist is a read model over data this codebase already tracks
 * (personnel files, SIA/DBS fields, emergency contact, bank details, a
 * login, an asset checkout), plus one small addition (start_date) and one
 * new per-person flag (a logged admin override). The centre of this file is
 * that every item flips independently as its underlying fact changes, that
 * the audience for it is the same canSeeSensitive gate as emergency_contact/
 * bank_details (never a plain colleague), and that the manual override is
 * admin-only and logged either way.
 */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4097';
process.env.AUTH_SECRET = 'onboarding-test-secret';
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

// Smallest valid PNG (1x1), standing in for an uploaded document photo.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let adminT, dispT;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dispT = await login('dispatcher', 'dispatch123');
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

const itemsByKey = (p) => Object.fromEntries(p.onboarding.items.map((i) => [i.key, i.done]));

test('a new hire starts with every applicable item outstanding and a default start_date of today', async () => {
  const created = await call('POST', '/api/personnel', { name: 'Onboarding Test One' }, adminT);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const p = created.body;
  assert.equal(p.start_date, new Date().toISOString().slice(0, 10));
  assert.ok(p.onboarding, 'admin sees the checklist on their own creation response');
  assert.equal(p.onboarding.complete, false);
  assert.equal(p.onboarding.overridden, false);
  assert.ok(p.onboarding.outstanding > 0);
  assert.equal(itemsByKey(p).login_account, false);
  assert.equal(itemsByKey(p).bank_details, false, 'EMPLOYED by default, so bank_details is a real item');
});

test('a subcontractor never gets a bank_details item at all', async () => {
  const p = (await call('POST', '/api/personnel', { name: 'Onboarding Sub One', employment_type: 'SUBCONTRACTOR' }, adminT)).body;
  assert.ok(!('bank_details' in itemsByKey(p)), 'the item is absent, not merely false');
});

test('each item flips independently as the underlying fact changes, and completes naturally once all are done', async () => {
  const p0 = (await call('POST', '/api/personnel', { name: 'Onboarding Test Two' }, adminT)).body;
  const pid = p0.id;
  const current = async () => (await call('GET', '/api/personnel', undefined, adminT)).body.find((x) => x.id === pid);

  await call('POST', `/api/personnel/${pid}/files`, { kind: 'ID', mimetype: 'image/png', filename: 'passport.png', data: PNG }, adminT);
  assert.equal(itemsByKey(await current()).id_document, true);

  await call('POST', `/api/personnel/${pid}/files`, { kind: 'CONTRACT', mimetype: 'image/png', filename: 'contract.png', data: PNG }, adminT);
  assert.equal(itemsByKey(await current()).contract, true);

  await call('PATCH', `/api/personnel/${pid}`, { sia_licences: [{ licence_type: 'Door Supervision', licence_no: 'SIA-1234', expiry: null }] }, adminT);
  assert.equal(itemsByKey(await current()).sia_licence, true);

  await call('PATCH', `/api/personnel/${pid}`, { dbs_checked_now: true }, adminT);
  assert.equal(itemsByKey(await current()).dbs_check, true);

  await call('PATCH', `/api/personnel/${pid}`, { rtw_checked_now: true }, adminT);
  assert.equal(itemsByKey(await current()).rtw_check, true);

  await call('PATCH', `/api/personnel/${pid}/emergency-contact`, { name: 'Jo Bloggs', relationship: 'Partner', phone: '07700900000' }, adminT);
  assert.equal(itemsByKey(await current()).emergency_contact, true);

  await call('PATCH', `/api/personnel/${pid}`, { bank_details: { account_name: 'O. Test', bank_name: 'Test Bank', sort_code: '12-34-56', account_number: '12345678' } }, adminT);
  assert.equal(itemsByKey(await current()).bank_details, true);

  let before = await current();
  assert.equal(before.onboarding.complete, false, 'login and (if the business tracks kit) kit_issued are still outstanding');

  const username = `onboardtest2_${pid}`;
  const u = await call('POST', '/api/users', { username, password: 'realpassword1', role: 'FIELD_USER', personnel_id: pid }, adminT);
  assert.equal(u.status, 201, JSON.stringify(u.body));
  assert.equal(itemsByKey(await current()).login_account, true);

  if ('kit_issued' in itemsByKey(await current())) {
    const asset = (await call('POST', '/api/assets', { description: 'Onboarding test radio', category: 'RADIO' }, adminT)).body;
    const checkout = await call('POST', `/api/assets/${asset.id}/checkout`, { personnel_id: pid }, adminT);
    assert.equal(checkout.status, 201, JSON.stringify(checkout.body));
    assert.equal(itemsByKey(await current()).kit_issued, true);
  }

  const done = await current();
  assert.equal(done.onboarding.complete, true, 'every applicable item done — complete without needing the override');
  assert.equal(done.onboarding.overridden, false);
});

test('onboarding is visible to control and to the person themselves, never to a colleague', async () => {
  const p = (await call('POST', '/api/personnel', { name: 'Onboarding Visibility Test' }, adminT)).body;
  const username = `onboardvis_${p.id}`;
  await call('POST', '/api/users', { username, password: 'realpassword1', role: 'FIELD_USER', personnel_id: p.id }, adminT);
  const myT = await login(username, 'realpassword1');
  const colleagueT = await login('dwhitfield', 'field123');

  const asAdmin = (await call('GET', '/api/personnel', undefined, adminT)).body.find((x) => x.id === p.id);
  const asControl = (await call('GET', '/api/personnel', undefined, dispT)).body.find((x) => x.id === p.id);
  const asSelf = (await call('GET', '/api/personnel', undefined, myT)).body.find((x) => x.id === p.id);
  const asColleague = (await call('GET', '/api/personnel', undefined, colleagueT)).body.find((x) => x.id === p.id);
  assert.ok(asAdmin.onboarding);
  assert.ok(asControl.onboarding);
  assert.ok(asSelf.onboarding, 'the person can see their own checklist');
  assert.ok(!('onboarding' in asColleague), 'a colleague sees nothing of it — same gate as emergency_contact/bank_details');
});

test('marking onboarding complete is admin-only, overrides outstanding items, is logged, and can be reopened', async () => {
  const p = (await call('POST', '/api/personnel', { name: 'Onboarding Override Test' }, adminT)).body;
  assert.ok(p.onboarding.outstanding > 0);

  assert.equal((await call('POST', `/api/personnel/${p.id}/onboarding-complete`, { note: 'control-room only, no SIA needed' }, dispT)).status, 403, 'dispatcher is a control role but not ADMIN');

  const done = await call('POST', `/api/personnel/${p.id}/onboarding-complete`, { note: 'control-room only, no SIA needed' }, adminT);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.onboarding.complete, true);
  assert.equal(done.body.onboarding.overridden, true, 'items are still outstanding — this is the override, not real completion');
  assert.equal(done.body.onboarding.completed_by, 'System Admin');

  assert.equal((await call('POST', `/api/personnel/${p.id}/onboarding-complete`, {}, adminT)).status, 409, 'already complete');

  const events = app.db.audit_logs.filter((e) => e.type === 'personnel.onboarding_completed' && e.data.personnel_id === p.id);
  assert.equal(events.length, 1);
  assert.match(events[0].summary, /control-room only, no SIA needed/);

  const reopen = await call('DELETE', `/api/personnel/${p.id}/onboarding-complete`, undefined, adminT);
  assert.equal(reopen.status, 200, JSON.stringify(reopen.body));
  assert.equal(reopen.body.onboarding.complete, false);
  assert.equal((await call('DELETE', `/api/personnel/${p.id}/onboarding-complete`, undefined, adminT)).status, 409, 'not currently complete');
});

test('hiring an applicant sets a start_date (defaulting to today) the same way direct personnel creation does', async () => {
  const form = (await call('GET', '/api/public/application-form')).body;
  const applied = await call('POST', '/api/public/applications', {
    no_sia: true, definition_id: form.id,
    values: { full_name: 'Onboarding Hire Test', email: `onboardhire-${Date.now()}@example.test`, phone: '07700900123', postcode: 'DN31 2TG', role_applied_for: 'Security officer', right_to_work: true, consent: true },
  });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const applicant = (await call('GET', '/api/applicants', undefined, adminT)).body.find((a) => a.reference === applied.body.reference);
  const hired = await call('POST', `/api/applicants/${applicant.id}/hire`, { notify: false }, adminT);
  assert.equal(hired.status, 201, JSON.stringify(hired.body));
  assert.equal(hired.body.personnel.start_date, new Date().toISOString().slice(0, 10));
  assert.equal(hired.body.personnel.onboarding.complete, false);
});
