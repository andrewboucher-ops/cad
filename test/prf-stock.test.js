/* PRF treatments taken out of CCCS stock and the medication register. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = process.env.TEST_PRF_STOCK_PORT || '4014';
process.env.AUTH_SECRET = 'test-secret-not-for-production';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';
process.env.RETENTION = 'off';
process.env.PRF_DRAFT_EDIT_WINDOW_MS = '0';

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
async function call(method, path, body, token) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;

let adminT, danT, ellieT, bag, dressing, paracetamol, morphine;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  [adminT, danT, ellieT] = await Promise.all([login('admin', 'admin123'), login('dwhitfield', 'field123'), login('emarsh', 'field123')]);
  bag = (await call('POST', '/api/stock/locations', { name: 'Response bag 1', kind: 'BAG' }, adminT)).body;
  dressing = (await call('POST', '/api/assets', { description: 'Trauma dressing', size: '10cm', category: 'OTHER', unit: 'each', is_stock_tracked: true, low_stock_threshold: 2 }, adminT)).body;
  assert.strictEqual((await call('POST', `/api/stock/${dressing.id}/receive`, { quantity: 5, location_id: bag.id, batch_no: 'D1', expiry_date: '2030-01-31' }, adminT)).status, 201);
  paracetamol = (await call('POST', '/api/medication/medicines', { name: 'Paracetamol', strength: '500 mg', form: 'TABLET', unit: 'tablet', legal_category: 'P' }, adminT)).body;
  assert.strictEqual((await call('POST', `/api/medication/${paracetamol.id}/receive`, { quantity: 16, location_id: bag.id, batch_no: 'P1', expiry_date: '2030-06-30', supplier: 'Pharmacy Ltd' }, adminT)).status, 201);
  morphine = (await call('POST', '/api/medication/medicines', { name: 'Morphine sulfate', strength: '10 mg/1 ml', form: 'AMPOULE', unit: 'ampoule', controlled: true, cd_schedule: 2 }, adminT)).body;
  const r = await call('POST', `/api/medication/${morphine.id}/receive`, { quantity: 2, location_id: bag.id, batch_no: 'M1', expiry_date: '2030-06-30', supplier: 'Pharmacy Ltd', reference: 'REQ-1', witness_username: 'supervisor', witness_password: 'super123' }, adminT);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

async function draftWith(txLog, extra = {}) {
  const p = (await call('POST', '/api/prfs', {}, danT)).body;
  const put = await call('PUT', `/api/prfs/${p.pcr}`, { version: p.version, data: { first: 'Sam', last: 'Example', ...extra, txLog } }, danT);
  assert.strictEqual(put.status, 200);
  return p.pcr;
}

test('the supplies list shows real medicines and items with what each location holds', async () => {
  const s = (await call('GET', '/api/prfs/supplies', undefined, danT)).body;
  assert.ok(s.enabled);
  assert.ok(s.locations.some((l) => l.id === bag.id));
  const d = s.items.find((x) => x.id === dressing.id);
  assert.deepStrictEqual(d.levels, [{ location_id: bag.id, qty: 5 }]);
  assert.ok(s.medicines.find((m) => m.id === morphine.id).controlled);
});

test('a consumable used on a PRF comes off stock against the PRF number, once', async () => {
  const pcr = await draftWith([{ id: 'e1', kind: 'Procedure', name: 'Wound care / dressing', time: '14:05' }]);
  assert.strictEqual((await call('POST', `/api/prfs/${pcr}/supplies`, { entry_id: 'e1', kind: 'stock', item_id: dressing.id, quantity: 2, location_id: bag.id }, ellieT)).status, 403, 'only the author');
  const r = await call('POST', `/api/prfs/${pcr}/supplies`, { entry_id: 'e1', kind: 'stock', item_id: dressing.id, quantity: 2, location_id: bag.id }, danT);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const st = r.body.data.txLog[0].stock;
  assert.strictEqual(st.quantity, 2);
  assert.deepStrictEqual(st.batches, ['D1']);
  const moves = app.db.stock_movements.filter((m) => st.movement_ids.includes(m.id));
  assert.ok(moves.every((m) => m.patient_ref === pcr && m.reason === 'USED_IN_TREATMENT'));
  const s = (await call('GET', '/api/prfs/supplies', undefined, danT)).body;
  assert.strictEqual(s.items.find((x) => x.id === dressing.id).levels[0].qty, 3);
  assert.strictEqual((await call('POST', `/api/prfs/${pcr}/supplies`, { entry_id: 'e1', kind: 'stock', item_id: dressing.id, quantity: 1, location_id: bag.id }, danT)).status, 409, 'not twice');
  assert.strictEqual((await call('POST', `/api/prfs/${pcr}/supplies`, { entry_id: 'nope', kind: 'stock', item_id: dressing.id, quantity: 1, location_id: bag.id }, danT)).status, 404);
  assert.strictEqual((await call('POST', `/api/prfs/${pcr}/supplies`, { entry_id: 'e1', kind: 'stock', item_id: dressing.id, quantity: 99, location_id: bag.id }, danT)).status, 409);

  // A draft save can't fake, change or drop that record.
  const cur = (await call('GET', `/api/prfs/${pcr}`, undefined, danT)).body;
  let put = await call('PUT', `/api/prfs/${pcr}`, { version: cur.version, data: { ...cur.data, txLog: [{ id: 'e1', kind: 'Procedure', name: 'x', stock: { quantity: 0 } }] } }, danT);
  let got = (await call('GET', `/api/prfs/${pcr}`, undefined, danT)).body;
  assert.strictEqual(got.data.txLog[0].stock.quantity, 2, 'stock record is the server\'s');
  put = await call('PUT', `/api/prfs/${pcr}`, { version: got.version, data: { ...got.data, txLog: [] } }, danT);
  got = (await call('GET', `/api/prfs/${pcr}`, undefined, danT)).body;
  assert.strictEqual(got.data.txLog.length, 1, 'an entry that took stock stays on the record');
  put = await call('PUT', `/api/prfs/${pcr}`, { version: got.version, data: { ...got.data, txLog: [{ id: 'e2', kind: 'Medication', name: 'Fake', stock: { item_id: 1, quantity: 5 } }] } }, danT);
  got = (await call('GET', `/api/prfs/${pcr}`, undefined, danT)).body;
  assert.strictEqual(got.data.txLog.find((x) => x.id === 'e2').stock, undefined, 'a client cannot invent one');

  const audit = (await call('GET', `/api/prf-audit?pcr=${pcr}`, undefined, adminT)).body;
  assert.ok(audit.some((a) => a.action === 'supply.used'));
});

test('a medicine given goes into the medication register; a controlled drug needs a witness', async () => {
  const pcr = await draftWith([{ id: 'm1', kind: 'Medication', name: 'Paracetamol', dose: '1 g', route: 'Oral' }, { id: 'm2', kind: 'Medication', name: 'Morphine', dose: '5 mg', route: 'IV' }]);
  assert.strictEqual((await call('POST', `/api/prfs/${pcr}/supplies`, { entry_id: 'm1', kind: 'medicine', item_id: paracetamol.id, quantity: 2, location_id: bag.id }, danT)).status, 400, 'a medicine needs its authority');
  let r = await call('POST', `/api/prfs/${pcr}/supplies`, { entry_id: 'm1', kind: 'medicine', item_id: paracetamol.id, quantity: 2, location_id: bag.id, authority: 'General sale / pharmacy medicine under protocol' }, danT);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const rows = app.db.med_movements.filter((m) => r.body.data.txLog[0].stock.movement_ids.includes(m.id));
  assert.ok(rows.every((m) => m.type === 'ADMINISTERED' && m.patient_ref === pcr && m.dose_given === '1 g' && m.source === 'PRF' && m.authority.startsWith('General sale')));

  assert.strictEqual((await call('POST', `/api/prfs/${pcr}/supplies`, { entry_id: 'm2', kind: 'medicine', item_id: morphine.id, quantity: 1, location_id: bag.id, authority: 'Prescriber\'s instruction' }, danT)).status, 400, 'CD without a witness');
  r = await call('POST', `/api/prfs/${pcr}/supplies`, { entry_id: 'm2', kind: 'medicine', item_id: morphine.id, quantity: 1, location_id: bag.id, authority: 'Prescriber\'s instruction', witness_username: 'emarsh', witness_password: 'field123' }, danT);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const cd = r.body.data.txLog.find((x) => x.id === 'm2').stock;
  assert.ok(cd.controlled && cd.witness);
  const reg = app.db.med_movements.find((m) => m.id === cd.movement_ids[0]);
  assert.strictEqual(reg.patient_name, 'Sam Example');
  assert.strictEqual(reg.witness, 'emarsh');
  const audit = (await call('GET', `/api/prf-audit?pcr=${pcr}`, undefined, adminT)).body;
  assert.ok(!JSON.stringify(audit).includes('field123'), 'no passwords in the trail');
  assert.ok(!JSON.stringify(audit).includes('Sam Example'), 'no patient values in the trail');
});

test('a finalised PRF cannot take more stock', async () => {
  const pcr = await draftWith([{ id: 'f1', kind: 'Procedure', name: 'Wound care / dressing' }]);
  app.db.prfs.find((x) => x.pcr === pcr).status = 'FINAL';
  assert.strictEqual((await call('POST', `/api/prfs/${pcr}/supplies`, { entry_id: 'f1', kind: 'stock', item_id: dressing.id, quantity: 1, location_id: bag.id }, danT)).status, 409);
});

test('PRF admin overview is for supervisors and admins, and lists stock used per PRF', async () => {
  assert.strictEqual((await call('GET', '/api/prf-admin/overview', undefined, danT)).status, 403);
  const o = await call('GET', '/api/prf-admin/overview', undefined, adminT);
  assert.strictEqual(o.status, 200);
  assert.ok(o.body.summary.total >= 3);
  assert.ok(o.body.supplies.some((x) => x.item.includes('Trauma dressing') && x.quantity === 2));
  assert.ok(o.body.supplies.some((x) => x.controlled && x.witness));
  assert.ok(o.body.prfs.some((r) => r.stock_entries > 0));
});
