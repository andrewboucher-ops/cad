/* The stores scanning page (routes-stores.js) — node --test */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4071';
process.env.AUTH_SECRET = 'stores-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';

const app = require('../server.js');
const { parseGs1 } = require('../routes-stores.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
async function call(method, path, body, token) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;
const scan = async (code, t) => call('GET', `/api/stores/resolve?code=${encodeURIComponent(code)}`, undefined, t || adminT);

let adminT, dispT, dan, ellie, main, bag, dressing, radio;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dispT = await login('dispatcher', 'dispatch123');
  dan = app.db.personnel.find((p) => p.name === 'Dan Whitfield');
  ellie = app.db.personnel.find((p) => p.name === 'Ellie Marsh');
  main = (await call('GET', '/api/stock/locations', undefined, adminT)).body.find((l) => l.is_main);
  bag = (await call('POST', '/api/stock/locations', { name: 'ILS bag 3', kind: 'BAG' }, adminT)).body;
  dressing = (await call('POST', '/api/assets', { description: 'No.3 ambulance dressing', category: 'MEDICAL_CONSUMABLES', unit: 'each', is_stock_tracked: true }, adminT)).body;
  radio = (await call('POST', '/api/assets', { description: 'Radio', tag: 'RAD-07', category: 'RADIO' }, adminT)).body;
  assert.ok(dressing.id && radio.id && bag.id, 'fixtures');
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

test('GS1 pack codes give the product number, batch and expiry', () => {
  assert.deepEqual(parseGs1('(01)05012345678900(17)271130(10)AB123'), { gtin: '05012345678900', batch: 'AB123', expiry: '2027-11-30', serial: null });
  assert.deepEqual(parseGs1('0105012345678900172711001\x1d0AB123'.replace('1\x1d0', '10')), { gtin: '05012345678900', batch: 'AB123', expiry: '2027-11-30', serial: null }, 'day 00 is the end of the month');
  assert.deepEqual(parseGs1(']d201050123456789001727113010LOT9\x1d21SN1'), { gtin: '05012345678900', batch: 'LOT9', expiry: '2027-11-30', serial: 'SN1' });
  assert.equal(parseGs1('010501234567890010LOT517271231').expiry, '2027-12-31', 'batch run into a trailing expiry with no separator is split');
  assert.equal(parseGs1('010501234567890010LOT517271231').batch, 'LOT5');
  assert.equal(parseGs1('RAD-07'), null);
});

test('only roles given the Stores section can use it, and the routes check that themselves', async () => {
  assert.equal((await scan('RAD-07', dispT)).status, 403, 'control is off by default');
  assert.ok(!(await call('GET', '/api/ui/sections', undefined, dispT)).body.some((s) => s.key === 'stores'));
  assert.ok((await call('GET', '/api/ui/sections', undefined, adminT)).body.some((s) => s.key === 'stores'));
  assert.equal((await call('PUT', '/api/admin/ui-sections', { visible_to: { stores: ['SYSTEM_ADMIN', 'SUPERVISOR', 'DISPATCHER'] } }, adminT)).status, 200);
  assert.equal((await scan('RAD-07', dispT)).status, 200, 'turned on for dispatchers');
  assert.equal((await call('POST', '/api/stores/codes', { code: 'X1', kind: 'item', id: dressing.id }, dispT)).status, 403, 'linking codes stays admin');
});

test('codes resolve: own labels, staff cards (even typed by a US-layout scanner), tags, linked and GS1 codes', async () => {
  const pad = (n) => String(n).padStart(4, '0');
  assert.equal((await scan(`LOC-${pad(bag.id)}`)).body.kind, 'location');
  assert.equal((await scan(`gin-${pad(main.id)}`)).body.kind, 'receive');
  assert.equal((await scan(`ITM-${pad(dressing.id)}`)).body.item.id, dressing.id);
  assert.equal((await scan('rad-07')).body.asset.id, radio.id);
  const card = (await call('GET', `/api/personnel/${dan.id}/id-card`, undefined, adminT)).body;
  let r = await scan(card.verify_url);
  assert.equal(r.body.kind, 'person'); assert.equal(r.body.person.id, dan.id);
  assert.equal((await scan(card.verify_url.replace('#', '£'))).body.person.id, dan.id, '# typed as £');
  const token = card.verify_url.split('#')[1];
  const flipped = card.verify_url.split('#')[0] + '#' + token.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  assert.equal((await scan(flipped)).body.person.id, dan.id, 'caps lock on');

  r = await scan('(01)05012345678900(17)271130(10)AB123');
  assert.equal(r.body.kind, 'unknown');
  assert.equal(r.body.gs1.batch, 'AB123');
  assert.equal((await call('POST', '/api/stores/codes', { code: '(01)05012345678900(17)271130(10)AB123', kind: 'location', id: bag.id }, adminT)).status, 400, 'a product code is for an item');
  r = await call('POST', '/api/stores/codes', { code: '(01)05012345678900(17)271130(10)AB123', kind: 'item', id: dressing.id }, adminT);
  assert.equal(r.status, 201); assert.equal(r.body.code, '05012345678900', 'the GTIN is kept, not the batch');
  r = await scan('0105012345678900172801311\x1d0ZZ9'.replace('1\x1d0', '10'));
  assert.equal(r.body.kind, 'item', 'another batch of the same product is the same item');
  assert.equal(r.body.gs1.batch, 'ZZ9');
  assert.equal((await scan('5012345678900')).body.item.id, dressing.id, 'the EAN-13 on the box is the same product');
  assert.equal((await call('POST', '/api/stores/codes', { code: '5012345678900', kind: 'asset', id: radio.id }, adminT)).status, 409, 'a code means one thing');
  assert.equal((await call('POST', '/api/stores/codes', { code: 'BAG3-QR', kind: 'location', id: bag.id }, adminT)).status, 201);
  assert.equal((await scan('BAG3-QR')).body.location.id, bag.id, 'a QR already on the bag works once linked');
});

test('receive needs a batch or expiry; move confirms the batch; levels never go below zero', async () => {
  let r = await call('POST', '/api/stores/receive', { item_id: dressing.id, location_id: main.id, quantity: 10 }, adminT);
  assert.equal(r.status, 400, 'batch / expiry required');
  r = await call('POST', '/api/stores/receive', { item_id: dressing.id, location_id: main.id, quantity: 10, batch_no: 'AB123', expiry_date: '2027-11-30' }, adminT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await call('POST', '/api/stores/receive', { item_id: dressing.id, location_id: main.id, quantity: 1, batch_no: 'AB123', expiry_date: '2028-01-01' }, adminT)).status, 409, 'a batch keeps one expiry');
  await call('POST', '/api/stores/receive', { item_id: dressing.id, location_id: main.id, quantity: 4, batch_no: 'OLD1', expiry_date: '2020-01-31' }, adminT);

  r = await call('POST', '/api/stores/move', { item_id: dressing.id, from_location_id: main.id, to_location_id: bag.id, quantity: 2 }, adminT);
  assert.equal(r.status, 400, 'which batch must be confirmed');
  r = await call('POST', '/api/stores/move', { item_id: dressing.id, from_location_id: main.id, to_location_id: bag.id, quantity: 2, batch_no: 'OLD1', expiry_date: '2020-01-31' }, adminT);
  assert.equal(r.status, 409, 'expired stock is not moved without saying so');
  r = await call('POST', '/api/stores/move', { item_id: dressing.id, from_location_id: main.id, to_location_id: bag.id, quantity: 11, batch_no: 'AB123', expiry_date: '2027-11-30' }, adminT);
  assert.equal(r.status, 409, 'only 10 in that batch');
  r = await call('POST', '/api/stores/move', { item_id: dressing.id, from_location_id: main.id, to_location_id: bag.id, quantity: 3, batch_no: 'AB123', expiry_date: '2027-11-30', note: 'restock' }, adminT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.movements.every((m) => m.via === 'STORES' && m.batch_no === 'AB123'), 'the same batch arrives, marked as a stores scan');
  const it = (await scan(`ITM-${String(dressing.id).padStart(4, '0')}`)).body.item;
  assert.deepEqual(it.batches.filter((b) => b.location_id === bag.id).map((b) => [b.batch_no, b.qty]), [['AB123', 3]]);

  r = await call('POST', '/api/stores/issue', { item_id: dressing.id, location_id: bag.id, personnel_id: ellie.id, quantity: 1, batch_no: 'AB123', expiry_date: '2027-11-30' }, adminT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const held = (await call('GET', `/api/stock/holdings?personnel_id=${ellie.id}`, undefined, adminT)).body;
  assert.ok(held.some((h) => h.item_id === dressing.id && h.quantity === 1));
});

test('assets: staff card signs out, a second card asks for a handover, a location signs back in', async () => {
  let r = await call('POST', '/api/stores/asset-out', { asset_id: radio.id, personnel_id: dan.id }, dispT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(app.db.assets.find((a) => a.id === radio.id).assigned_to, dan.id);
  assert.equal((await call('POST', '/api/stores/asset-out', { asset_id: radio.id, personnel_id: dan.id }, dispT)).status, 409);
  assert.equal((await call('POST', '/api/stores/asset-out', { asset_id: radio.id, personnel_id: ellie.id }, dispT)).status, 409, 'handover must be confirmed');
  r = await call('POST', '/api/stores/asset-out', { asset_id: radio.id, personnel_id: ellie.id, handover: true }, dispT);
  assert.equal(r.status, 201); assert.match(r.body.done, /handed over from Dan Whitfield/);
  r = await call('POST', '/api/stores/asset-in', { asset_id: radio.id, location_id: main.id, condition: 'GOOD' }, dispT);
  assert.equal(r.status, 201); assert.match(r.body.done, /signed back in from Ellie Marsh and put away at/);
  const a = app.db.assets.find((x) => x.id === radio.id);
  assert.deepEqual([a.status, a.assigned_to, a.location_id], ['IN_STORE', null, main.id]);
  const outs = app.db.asset_checkouts.filter((c) => c.asset_id === radio.id);
  assert.equal(outs.length, 2); assert.ok(outs.every((c) => c.returned_at && c.via === 'STORES'));
  const act = (await call('GET', '/api/stores/activity', undefined, dispT)).body;
  assert.ok(act.some((x) => x.kind === 'asset' && x.reason === 'SIGNED_IN'));
  assert.ok(act.some((x) => x.reason === 'TRANSFER_IN' && x.from));
});

test('the desk and officer check-out routes still work after the shared helpers', async () => {
  const r = await call('POST', `/api/assets/${radio.id}/checkout`, { personnel_id: dan.id }, adminT);
  assert.equal(r.status, 201);
  assert.equal((await call('POST', `/api/assets/${radio.id}/return`, { condition: 'GOOD' }, adminT)).status, 200);
});

test('a pack barcode scanned in on receipt names that batch from then on', async () => {
  let r = await call('POST', '/api/stores/receive', { item_id: dressing.id, location_id: main.id, quantity: 6, batch_no: 'PK7', expiry_date: '2028-03-31', pack_code: 'PACK-PK7-XYZ' }, adminT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.done, /pack barcode saved/);
  r = await scan('pack-pk7-xyz');
  assert.equal(r.body.kind, 'item'); assert.equal(r.body.item.id, dressing.id);
  assert.deepEqual([r.body.gs1.batch, r.body.gs1.expiry], ['PK7', '2028-03-31'], 'the batch comes with it');
  // Receiving more of the same batch with the same code is fine; the same code on another batch is the product barcode.
  assert.equal((await call('POST', '/api/stores/receive', { item_id: dressing.id, location_id: main.id, quantity: 1, batch_no: 'PK7', expiry_date: '2028-03-31', pack_code: 'PACK-PK7-XYZ' }, adminT)).status, 201);
  r = await call('POST', '/api/stores/receive', { item_id: dressing.id, location_id: main.id, quantity: 1, batch_no: 'PK8', expiry_date: '2028-04-30', pack_code: 'PACK-PK7-XYZ' }, adminT);
  assert.equal(r.status, 409); assert.match(r.body.error, /product's barcode/);
  assert.equal((await call('POST', '/api/stores/receive', { item_id: dressing.id, location_id: main.id, quantity: 1, batch_no: 'PK9', pack_code: 'RAD-07' }, adminT)).status, 409, 'not an asset tag');
  assert.equal((await call('POST', '/api/stores/receive', { item_id: dressing.id, location_id: main.id, quantity: 1, batch_no: 'PK9', pack_code: '5012345678900' }, adminT)).status, 409, 'not the product barcode');
  assert.equal((await call('POST', '/api/stores/receive', { item_id: dressing.id, location_id: main.id, quantity: 1, no_batch: true, pack_code: 'NEWCODE-1' }, adminT)).status, 400, 'a pack code needs a batch or expiry');
  // The Stock page's receive takes it too.
  r = await call('POST', `/api/stock/${dressing.id}/receive`, { quantity: 2, location_id: main.id, batch_no: 'ST1', expiry_date: '2029-01-31', pack_code: 'STOCKPAGE-ST1' }, adminT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await scan('STOCKPAGE-ST1')).body.gs1.batch, 'ST1');
  const before = app.db.stock_movements.length;
  assert.equal((await call('POST', `/api/stock/${dressing.id}/receive`, { quantity: 2, location_id: main.id, batch_no: 'ST2', pack_code: 'STOCKPAGE-ST1' }, adminT)).status, 409);
  assert.equal(app.db.stock_movements.length, before, 'nothing booked when the code is refused');
});

test('several pack barcodes on one delivery, all checked first; search picks by id', async () => {
  let r = await call('POST', '/api/stores/receive', { item_id: dressing.id, location_id: main.id, quantity: 2, batch_no: 'MB1', expiry_date: '2029-06-30', pack_codes: ['BOX-MB1', 'INNER-MB1', 'box-mb1'] }, adminT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.done, /2 pack barcodes saved/);
  assert.equal((await scan('INNER-MB1')).body.gs1.batch, 'MB1');
  assert.equal((await scan('BOX-MB1')).body.gs1.batch, 'MB1');
  const before = app.db.stock_batch_codes.length;
  r = await call('POST', '/api/stores/receive', { item_id: dressing.id, location_id: main.id, quantity: 1, batch_no: 'MB2', pack_codes: ['FRESH-MB2', 'RAD-07'] }, adminT);
  assert.equal(r.status, 409, 'one bad code refuses the lot');
  assert.equal(app.db.stock_batch_codes.length, before, 'and none of them are saved');
  r = await call('POST', `/api/stock/${dressing.id}/receive`, { quantity: 1, location_id: main.id, batch_no: 'MB3', pack_code: 'SP-A, SP-B' }, adminT);
  assert.equal(r.status, 201);
  assert.equal((await scan('SP-B')).body.gs1.batch, 'MB3');

  r = await call('GET', `/api/stores/resolve?kind=location&id=${bag.id}`, undefined, adminT);
  assert.equal(r.body.location.id, bag.id);
  r = await call('GET', `/api/stores/resolve?kind=person&id=${dan.id}`, undefined, adminT);
  assert.equal(r.body.person.id, dan.id);
  const cat = (await call('GET', '/api/stores/catalogue', undefined, adminT)).body;
  assert.ok(cat.people.some((p) => p.id === dan.id), 'people are searchable');
});
