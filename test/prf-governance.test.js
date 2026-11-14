/* PRF governance: no controlled drugs by default, retention, legal hold,
 * disposal, and the public privacy notice details. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = process.env.TEST_PRF_GOV_PORT || '4098';
process.env.AUTH_SECRET = 'test-secret-not-for-production';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';
process.env.RETENTION = 'off';
process.env.PRF_DRAFT_EDIT_WINDOW_MS = '0';
delete process.env.PRF_CONTROLLED_DRUGS;
process.env.PRF_CONTROLLER = 'Echelon Command Information Centre Ltd';
process.env.PRF_PRIVACY_EMAIL = 'privacy@example.org';

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
async function call(method, path, body, token) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;

let adminT, danT, bag, morphine;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  [adminT, danT] = await Promise.all([login('admin', 'admin123'), login('dwhitfield', 'field123')]);
  bag = (await call('POST', '/api/stock/locations', { name: 'Gov bag', kind: 'BAG' }, adminT)).body;
  morphine = (await call('POST', '/api/medication/medicines', { name: 'Morphine sulfate', strength: '10 mg/1 ml', form: 'AMPOULE', unit: 'ampoule', controlled: true, cd_schedule: 2 }, adminT)).body;
  await call('POST', `/api/medication/${morphine.id}/receive`, { quantity: 2, location_id: bag.id, batch_no: 'M1', expiry_date: '2030-06-30', supplier: 'Pharmacy Ltd', reference: 'REQ-1', witness_username: 'supervisor', witness_password: 'super123' }, adminT);
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

async function draft(data) {
  const p = (await call('POST', '/api/prfs', {}, danT)).body;
  assert.strictEqual((await call('PUT', `/api/prfs/${p.pcr}`, { version: p.version, data }, danT)).status, 200);
  return p.pcr;
}
const row = async (pcr) => (await call('GET', '/api/prf-admin/overview', undefined, adminT)).body.prfs.find((x) => x.pcr === pcr);

test('controlled drugs are not offered or accepted on a PRF unless switched on', async () => {
  const s = (await call('GET', '/api/prfs/supplies', undefined, danT)).body;
  assert.strictEqual(s.controlled_drugs, false);
  assert.ok(!s.medicines.some((m) => m.id === morphine.id));
  const pcr = await draft({ first: 'Sam', txLog: [{ id: 'e1', kind: 'Medication', name: 'Morphine' }] });
  const r = await call('POST', `/api/prfs/${pcr}/supplies`, { entry_id: 'e1', kind: 'medicine', item_id: morphine.id, quantity: 1, location_id: bag.id, authority: 'Prescriber\'s instruction', witness_username: 'supervisor', witness_password: 'super123' }, danT);
  assert.strictEqual(r.status, 403);
  assert.match(r.body.error, /controlled drugs/);
});

test('retention: adults 8 years from the incident, children to 25 (26 if 17), unknown age as a child', async () => {
  const adult = await draft({ first: 'A', dob: '1980-05-01', callReceived: '2024-03-10T12:00' });
  const child = await draft({ first: 'C', dob: '2015-01-01', callReceived: '2024-03-10T12:00' });
  const seventeen = await draft({ first: 'S', dob: '2006-06-01', callReceived: '2024-03-10T12:00' });
  const approx = await draft({ first: 'X', ageApprox: '10', callReceived: '2024-03-10T12:00' });
  const unknown = await draft({ first: 'U', callReceived: '2024-03-10T12:00' });
  assert.strictEqual((await row(adult)).retain_until, '2032-03-10');
  assert.strictEqual((await row(child)).retain_until, '2040-01-01');
  assert.strictEqual((await row(seventeen)).retain_until, '2032-06-01');
  assert.strictEqual((await row(approx)).retain_until, '2039-03-10');
  assert.strictEqual((await row(unknown)).retain_until, '2049-03-10');
  assert.strictEqual((await row(adult)).due, false);
});

test('a PRF past retention can be held, and once released, disposed of with a stub left', async () => {
  const pcr = await draft({ first: 'Old', last: 'Record', dob: '1970-01-01', callReceived: '2010-01-01T09:00', narrative: 'clinical detail' });
  let r = await row(pcr);
  assert.ok(r.due);
  assert.strictEqual((await call('POST', `/api/prf-admin/${pcr}/dispose`, { confirm: pcr }, danT)).status, 403, 'responders cannot dispose');
  assert.strictEqual((await call('POST', `/api/prf-admin/${pcr}/hold`, {}, adminT)).status, 400, 'a hold needs a reason');
  assert.strictEqual((await call('POST', `/api/prf-admin/${pcr}/hold`, { reason: 'Open claim' }, adminT)).status, 200);
  r = await row(pcr);
  assert.ok(!r.due && r.legal_hold.reason === 'Open claim');
  assert.strictEqual((await call('POST', `/api/prf-admin/${pcr}/dispose`, { confirm: pcr }, adminT)).status, 409, 'held');
  await call('POST', `/api/prf-admin/${pcr}/hold`, { on: false }, adminT);
  assert.strictEqual((await call('POST', `/api/prf-admin/${pcr}/dispose`, { confirm: 'wrong' }, adminT)).status, 400, 'must type the number');
  const d = await call('POST', `/api/prf-admin/${pcr}/dispose`, { confirm: pcr, reason: 'End of retention' }, adminT);
  assert.strictEqual(d.status, 200, JSON.stringify(d.body));
  r = await row(pcr);
  assert.strictEqual(r.status, 'DISPOSED');
  assert.strictEqual(r.patient, null);
  assert.strictEqual(r.disposed_reason, 'End of retention');
  assert.strictEqual((await call('GET', `/api/prfs/${pcr}`, undefined, adminT)).status, 410);
  assert.ok(!(await call('GET', '/api/prfs', undefined, danT)).body.some((x) => x.pcr === pcr));
  const trail = (await call('GET', `/api/prf-audit?pcr=${pcr}`, undefined, adminT)).body.map((a) => a.action);
  assert.ok(trail.includes('disposed') && trail.includes('hold.placed') && trail.includes('hold.released'));
  assert.ok((await call('GET', '/api/prf-audit/verify', undefined, adminT)).body.ok);
});

test('a PRF inside its retention period cannot be disposed of', async () => {
  const pcr = await draft({ first: 'New', dob: '1990-01-01' });
  const r = await call('POST', `/api/prf-admin/${pcr}/dispose`, { confirm: pcr }, adminT);
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, /kept until/);
});

test('the privacy notice details are public', async () => {
  const r = await call('GET', '/api/prf-privacy');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.controller, 'Echelon Command Information Centre Ltd');
  assert.strictEqual(r.body.email, 'privacy@example.org');
  assert.deepStrictEqual(r.body.retention, { adult_years: 8, child_until_age: 25 });
});

test('pertinent negatives on lists and the MPDS code are kept on the record', async () => {
  const pcr = await draft({ mpds: '10 - Chest Pain / Chest Discomfort (Non-Traumatic)', mpdsCode: '10-D-01', allergies: ['Latex'], allergiesNeg: ['Penicillin'], pmhNeg: ['Asthma', 'Diabetes'], sceneFindingsNeg: ['Weapon present'] });
  const d = (await call('GET', `/api/prfs/${pcr}`, undefined, danT)).body.data;
  assert.strictEqual(d.mpdsCode, '10-D-01');
  assert.deepStrictEqual(d.allergiesNeg, ['Penicillin']);
  assert.deepStrictEqual(d.pmhNeg, ['Asthma', 'Diabetes']);
  assert.deepStrictEqual(d.sceneFindingsNeg, ['Weapon present']);
});
