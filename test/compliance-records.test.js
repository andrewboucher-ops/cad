/* BS 7858 screening record, BS 7499 assignment-instruction sign-off, and
 * the SIA ACS complaints log — node --test */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4067';
process.env.AUTH_SECRET = 'compliance-records-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;

async function call(method, p, body, token) {
  const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;
const ymd = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);

let adminT, dispT, danT, dan;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dispT = await login('dispatcher', 'dispatch123');
  danT = await login('dwhitfield', 'field123');
  dan = app.db.personnel.find((p) => p.id === (app.db.users.find((u) => u.username === 'dwhitfield')).personnel_id);
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

test('BS 7858: gaps over 28 days and unverified periods block sign-off; a complete file signs off; any change clears it', async () => {
  assert.strictEqual((await call('GET', `/api/personnel/${dan.id}/screening`, undefined, dispT)).status, 403, 'admin only');
  Object.assign(dan, { rtw_last_checked_at: new Date().toISOString(), dbs_certificate_no: '001234567890', sia_licence_no: '1234567890123456' });
  dan.files = [{ id: 'x', kind: 'ID', label: 'Passport', filename: 'p.pdf', stored_name: 'p.pdf', mimetype: 'application/pdf', added_at: new Date().toISOString() }];
  const base = {
    credit_check: { done_on: ymd(10), provider: 'Experian', result: 'CLEAR' },
    self_declaration: { signed_on: ymd(10), disclosed: false },
  };
  // Two periods with a 3-month hole between them.
  let r = await call('PUT', `/api/personnel/${dan.id}/screening`, { ...base, history: [
    { from: ymd(2000), to: ymd(400), activity: 'EMPLOYMENT', organisation: 'A Ltd', verified_at: ymd(5), verify_method: 'REFERENCE_WRITTEN' },
    { from: ymd(300), activity: 'EMPLOYMENT', organisation: 'Echelon', verified_at: ymd(5), verify_method: 'HMRC_RECORD' },
  ] }, adminT);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.status.gaps.length, 1);
  assert.ok(r.body.status.gaps[0].days > 28);
  assert.strictEqual((await call('POST', `/api/personnel/${dan.id}/screening/sign-off`, {}, adminT)).status, 409);

  // Fill the gap but leave it unverified: still blocked.
  r = await call('PUT', `/api/personnel/${dan.id}/screening`, { ...base, history: [
    { from: ymd(2000), to: ymd(400), activity: 'EMPLOYMENT', organisation: 'A Ltd', verified_at: ymd(5), verify_method: 'REFERENCE_WRITTEN' },
    { from: ymd(399), to: ymd(301), activity: 'UNEMPLOYMENT' },
    { from: ymd(300), activity: 'EMPLOYMENT', organisation: 'Echelon', verified_at: ymd(5), verify_method: 'HMRC_RECORD' },
  ] }, adminT);
  assert.strictEqual(r.body.status.gaps.length, 0);
  assert.strictEqual(r.body.status.unverified, 1);
  assert.strictEqual((await call('POST', `/api/personnel/${dan.id}/screening/sign-off`, {}, adminT)).status, 409);

  const history = r.body.screening.history.map((h) => (h.activity === 'UNEMPLOYMENT' ? { ...h, verified_at: ymd(5), verify_method: 'CHARACTER_REFERENCE' } : h));
  r = await call('PUT', `/api/personnel/${dan.id}/screening`, { ...base, history }, adminT);
  assert.strictEqual(r.body.status.status, 'READY_TO_SIGN');
  r = await call('POST', `/api/personnel/${dan.id}/screening/sign-off`, {}, adminT);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.status.status, 'COMPLETE');
  const onboarding = (await call('GET', '/api/personnel', undefined, adminT)).body.find((x) => x.id === dan.id).onboarding;
  assert.ok(onboarding.items.find((i) => i.key === 'bs7858_screening').done);

  r = await call('PUT', `/api/personnel/${dan.id}/screening`, { ...base, history, notes: 'changed' }, adminT);
  assert.strictEqual(r.body.status.status, 'READY_TO_SIGN', 'a change clears the sign-off');
  // Verification needs a method.
  assert.strictEqual((await call('PUT', `/api/personnel/${dan.id}/screening`, { history: [{ from: ymd(100), verified_at: ymd(1) }] }, adminT)).status, 400);
});

test('BS 7858: a conditional start is flagged OVERDUE once the conditional period passes without sign-off', async () => {
  const p = (await call('POST', '/api/personnel', { name: 'New Starter' }, adminT)).body;
  let r = await call('PUT', `/api/personnel/${p.id}/screening`, { conditional_start: ymd(10) }, adminT);
  assert.strictEqual(r.body.status.status, 'CONDITIONAL');
  r = await call('PUT', `/api/personnel/${p.id}/screening`, { conditional_start: ymd(100) }, adminT);
  assert.strictEqual(r.body.status.status, 'OVERDUE');
  const overview = (await call('GET', '/api/screening/overview', undefined, adminT)).body;
  assert.strictEqual(overview.find((x) => x.id === p.id).status, 'OVERDUE');
});

test('BS 7499: an officer posted to a site confirms reading its current instructions; control sees who has not', async () => {
  const site = app.db.sites[0];
  const doc = { id: 770001, site_id: site.id, type: 'ASSIGNMENT_INSTRUCTIONS', title: 'Main gate', version: 2, is_current: true, filename: 'ai.pdf', stored_name: 'ai.pdf', mimetype: 'application/pdf', uploaded_by: 'Admin', uploaded_at: new Date().toISOString() };
  app.db.documents.push(doc);
  const shift = { id: 770001, site_id: site.id, starts_at: new Date(Date.now() + 3600e3).toISOString(), ends_at: new Date(Date.now() + 8 * 3600e3).toISOString(), status: 'PUBLISHED' };
  app.db.shifts.push(shift);
  app.db.shift_assignments.push({ id: 770001, shift_id: shift.id, personnel_id: dan.id, status: 'CONFIRMED' });

  let ack = (await call('GET', `/api/sites/${site.id}/acknowledgements`, undefined, dispT)).body;
  assert.ok(ack[0].outstanding.some((x) => x.personnel_id === dan.id));
  let list = (await call('GET', `/api/sites/${site.id}/documents`, undefined, danT)).body;
  assert.strictEqual(list.find((d) => d.id === doc.id).acknowledged_by_me, false);

  const elliT = await login('emarsh', 'field123');
  assert.strictEqual((await call('POST', `/api/documents/${doc.id}/acknowledge`, {}, elliT)).status, 403, 'not posted there');
  assert.strictEqual((await call('POST', `/api/documents/${doc.id}/acknowledge`, {}, danT)).status, 200);
  list = (await call('GET', `/api/sites/${site.id}/documents`, undefined, danT)).body;
  assert.strictEqual(list.find((d) => d.id === doc.id).acknowledged_by_me, true);
  assert.strictEqual(list.find((d) => d.id === doc.id).acknowledgements, undefined, 'officers do not see colleagues\' sign-offs');
  ack = (await call('GET', `/api/sites/${site.id}/acknowledgements`, undefined, dispT)).body;
  assert.ok(!ack[0].outstanding.some((x) => x.personnel_id === dan.id));
  assert.strictEqual((await call('GET', `/api/sites/${site.id}/acknowledgements`, undefined, danT)).status, 403);
});

test('ACS complaints log: recorded, worked, cannot close without root cause, action, outcome and telling the complainant', async () => {
  assert.strictEqual((await call('POST', '/api/complaints', { summary: 'x' }, danT)).status, 403, 'control only');
  assert.strictEqual((await call('POST', '/api/complaints', {}, dispT)).status, 400);
  const c = (await call('POST', '/api/complaints', { summary: 'Officer late to site', category: 'LATE_OR_MISSED', complainant_name: 'Site manager', site_id: app.db.sites[0].id, status: 'CLOSED' }, dispT)).body;
  assert.match(c.reference, /^CMP-\d{4}$/);
  assert.strictEqual(c.status, 'OPEN', 'always starts open');
  assert.strictEqual((await call('POST', `/api/complaints/${c.id}/notes`, { body: 'Spoke to the officer' }, dispT)).status, 200);
  let r = await call('PATCH', `/api/complaints/${c.id}`, { status: 'CLOSED' }, dispT);
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /root cause/);
  r = await call('PATCH', `/api/complaints/${c.id}`, { root_cause: 'Rota published late', corrective_action: 'Apologised; credit note', preventive_action: 'Rota locked 7 days ahead', outcome: 'Upheld', outcome_communicated_at: new Date().toISOString(), acknowledged_at: new Date().toISOString(), status: 'CLOSED' }, dispT);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.closed_at);
  const all = (await call('GET', '/api/complaints', undefined, dispT)).body;
  assert.ok(all.complaints.some((x) => x.id === c.id && x.notes.length === 1));
  assert.strictEqual((await call('DELETE', `/api/complaints/${c.id}`, undefined, adminT)).status, 404, 'no way to delete one');
  assert.ok(app.store.enabled === false || app.store.file);
});
