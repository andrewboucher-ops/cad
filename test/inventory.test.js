/* Stock and asset management (routes-inventory.js) — node --test */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4032';
process.env.AUTH_SECRET = 'inventory-test-secret';
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

let adminT, dispT, danT, dan, ellie, main, van, vest;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dispT = await login('dispatcher', 'dispatch123');
  danT = await login('dwhitfield', 'field123');
  dan = app.db.personnel.find((p) => p.name === 'Dan Whitfield');
  ellie = app.db.personnel.find((p) => p.name === 'Ellie Marsh');
  main = (await call('GET', '/api/stock/locations', undefined, dispT)).body.find((l) => l.is_main);
  van = (await call('POST', '/api/stock/locations', { name: 'VAN-101 kit', kind: 'VEHICLE' }, adminT)).body;
  vest = (await call('POST', '/api/assets', { description: 'Hi-vis vest', size: 'L', sku: 'HV-L', category: 'UNIFORM', unit: 'each', is_stock_tracked: true, low_stock_threshold: 5, reorder_qty: 20, unit_cost: 4.5, supplier: 'Uniforms Ltd' }, adminT)).body;
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });
const item = async (id) => (await call('GET', '/api/stock/overview', undefined, adminT)).body.items.find((i) => i.id === id);

test('stock and the asset register are admin-only; the sign-in desk is control', async () => {
  for (const path of ['/api/stock/overview', '/api/stock/movements', '/api/assets/register', '/api/rentals']) {
    assert.equal((await call('GET', path, undefined, dispT)).status, 403, `${path} is admin only`);
  }
  assert.equal((await call('POST', `/api/stock/${vest.id}/receive`, { quantity: 1 }, dispT)).status, 403);
  assert.equal((await call('GET', '/api/assets/out', undefined, dispT)).status, 200, 'the desk can see what is out');
  assert.equal((await call('GET', '/api/assets/out', undefined, danT)).status, 403);
  const secs = (await call('GET', '/api/ui/sections', undefined, dispT)).body.map((x) => x.key);
  assert.ok(secs.includes('signout') && !secs.includes('stock') && !secs.includes('assets') && !secs.includes('rentals'), 'menu follows');
});

test('a main store exists, locations are admin-made, and item codes are unique', async () => {
  assert.ok(main, 'main store created automatically');
  assert.equal((await call('POST', '/api/stock/locations', { name: 'X' }, dispT)).status, 403);
  assert.equal((await call('POST', '/api/stock/locations', { name: 'van-101 KIT' }, adminT)).status, 409, 'names are unique');
  assert.equal((await call('POST', '/api/assets', { description: 'Dup', category: 'UNIFORM', sku: 'HV-L', is_stock_tracked: true }, adminT)).status, 409);
  assert.equal((await call('PATCH', `/api/stock/locations/${main.id}`, { active: false }, adminT)).status, 400, 'main store cannot be closed');
});

test('receive, move, issue and return keep a level per location, and never below zero', async () => {
  let r = await call('POST', `/api/stock/${vest.id}/receive`, { quantity: 30, location_id: main.id, unit_cost: 4.25, supplier: 'Uniforms Ltd', reference: 'PO-1001' }, adminT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await call('POST', `/api/stock/${vest.id}/receive`, { quantity: 1 }, danT)).status, 403, 'officers do not run the store');
  r = await call('POST', `/api/stock/${vest.id}/transfer`, { from_location_id: main.id, to_location_id: van.id, quantity: 10 }, adminT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  let i = await item(vest.id);
  assert.deepEqual([i.levels[main.id], i.levels[van.id], i.total], [20, 10, 30]);
  assert.equal(i.value, Math.round(30 * 4.25 * 100) / 100, 'valued at the latest unit cost');

  assert.equal((await call('POST', `/api/stock/${vest.id}/issue`, { quantity: 11, location_id: van.id, personnel_id: dan.id }, adminT)).status, 409, 'only 10 on the van');
  assert.equal((await call('POST', `/api/stock/${vest.id}/issue`, { quantity: 2, location_id: van.id }, adminT)).status, 400, 'to someone');
  assert.equal((await call('POST', `/api/stock/${vest.id}/issue`, { quantity: 3, location_id: van.id, personnel_id: dan.id }, adminT)).status, 201);
  i = await item(vest.id);
  assert.deepEqual([i.levels[van.id], i.total, i.issued_out], [7, 27, 3]);

  const held = (await call('GET', '/api/stock/holdings', undefined, danT)).body;
  assert.deepEqual(held.map((h) => [h.item, h.quantity]), [['Hi-vis vest (L)', 3]], 'an officer sees what they hold');
  await call('POST', `/api/stock/${vest.id}/issue`, { quantity: 1, location_id: main.id, personnel_id: ellie.id }, adminT);
  assert.equal((await call('GET', `/api/stock/holdings?personnel_id=${ellie.id}`, undefined, danT)).body.length, 1, 'but only their own, whatever they ask for');
  assert.ok((await call('GET', `/api/stock/holdings?personnel_id=${ellie.id}`, undefined, danT)).body.every((h) => h.personnel_id === dan.id));

  assert.equal((await call('POST', `/api/stock/${vest.id}/return`, { personnel_id: dan.id, quantity: 4, location_id: main.id }, adminT)).status, 409, 'cannot return more than held');
  assert.equal((await call('POST', `/api/stock/${vest.id}/return`, { personnel_id: dan.id, quantity: 1, location_id: main.id }, adminT)).status, 201);
  assert.equal((await call('POST', `/api/stock/${vest.id}/return`, { personnel_id: dan.id, quantity: 1, location_id: main.id, restock: false }, adminT)).status, 201);
  i = await item(vest.id);
  assert.deepEqual([i.levels[main.id], i.issued_out], [20, 2], 'one back on the shelf, one written off; Dan holds 1, Ellie 1');
});

test('adjustments take a reason, and a stocktake books only the differences', async () => {
  assert.equal((await call('POST', `/api/stock/${vest.id}/adjust`, { reason: 'DAMAGED', delta: 2, location_id: main.id }, adminT)).status, 400, 'damaged only removes');
  assert.equal((await call('POST', `/api/stock/${vest.id}/adjust`, { reason: 'AUDIT_CORRECTION', delta: -1, location_id: main.id }, adminT)).status, 400, 'a correction needs a note');
  assert.equal((await call('POST', `/api/stock/${vest.id}/adjust`, { reason: 'DAMAGED', delta: -2, location_id: main.id, note: 'torn' }, adminT)).status, 201);
  assert.equal((await item(vest.id)).levels[main.id], 18);

  const t = await call('POST', '/api/stock/stocktake', { location_id: main.id, counts: [{ item_id: vest.id, counted: 16 }], note: 'monthly' }, adminT);
  assert.equal(t.status, 201, JSON.stringify(t.body));
  assert.deepEqual([t.body.lines[0].expected, t.body.lines[0].counted, t.body.lines[0].diff], [18, 16, -2]);
  assert.equal((await item(vest.id)).levels[main.id], 16);
  const again = await call('POST', '/api/stock/stocktake', { location_id: main.id, counts: [{ item_id: vest.id, counted: 16 }] }, adminT);
  assert.equal(again.body.lines[0].diff, 0, 'a matching count changes nothing');
  assert.equal((await call('GET', '/api/stock/stocktakes', undefined, adminT)).body.length, 2);
});

test('at or under the reorder level an item is listed with a quantity to order', async () => {
  await call('POST', `/api/stock/${vest.id}/transfer`, { from_location_id: van.id, to_location_id: main.id, quantity: 7 }, adminT);
  await call('POST', `/api/stock/${vest.id}/adjust`, { reason: 'LOST', delta: -19, location_id: main.id, note: 'store flood' }, adminT);
  const i = await item(vest.id);
  assert.equal(i.total, 4);
  assert.equal(i.below_reorder, true);
  assert.equal(i.suggested_order, 20, 'the reorder quantity');
  assert.ok((await call('GET', '/api/stock/overview', undefined, adminT)).body.summary.below_reorder >= 1);
});

test('the rota still draws shift kit from the main store', async () => {
  const before_ = (await item(vest.id)).levels[main.id];
  const type = (await call('GET', '/api/shift-types', undefined, adminT)).body[0];
  const sr = await call('POST', '/api/shifts', { shift_type_id: type.id, starts_at: new Date(Date.now() + 86400e3).toISOString(), ends_at: new Date(Date.now() + 115200e3).toISOString() }, adminT);
  assert.equal(sr.status, 201, JSON.stringify(sr.body));
  const shift = sr.body;
  const r = await call('POST', `/api/shifts/${shift.id}/assets`, { asset_id: vest.id, quantity: 1 }, adminT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await item(vest.id)).levels[main.id], before_ - 1);
});

/* ---------------- assets ---------------- */
test('an asset is checked out with a due date, shows overdue, and comes back damaged into repair', async () => {
  const radio = (await call('POST', '/api/assets', { tag: 'RAD-001', description: 'Handheld radio', category: 'RADIO', make: 'Motorola', model: 'DP4400', purchase_cost: 450, warranty_expires_at: '2027-06-01', condition: 'GOOD', location_id: main.id, check_type: 'PAT test', check_interval_days: 365 }, adminT)).body;
  assert.equal(radio.make, 'Motorola');
  assert.equal((await call('POST', '/api/assets', { description: 'x', category: 'RADIO', condition: 'SHINY' }, adminT)).status, 400);
  const out = await call('POST', `/api/assets/${radio.id}/checkout`, { personnel_id: dan.id, expected_return_at: new Date(Date.now() - 86400e3).toISOString() }, adminT);
  assert.equal(out.status, 201, JSON.stringify(out.body));
  let reg = (await call('GET', '/api/assets/register', undefined, adminT)).body;
  let row = reg.assets.find((a) => a.id === radio.id);
  assert.equal(row.checkout.personnel_name, 'Dan Whitfield');
  assert.equal(row.checkout.overdue, true);
  assert.ok(reg.summary.overdue_returns >= 1);
  assert.equal((await call('POST', `/api/assets/${radio.id}/status`, { status: 'RETIRED', note: 'old' }, adminT)).status, 409, 'return it first');

  const back = await call('POST', `/api/assets/${radio.id}/return`, { condition: 'DAMAGED', notes: 'cracked screen' }, adminT);
  assert.equal(back.body.status, 'IN_REPAIR');
  assert.equal((await call('POST', `/api/assets/${radio.id}/checkout`, { personnel_id: dan.id }, adminT)).status, 409, 'not issued while in repair');

  const ins = await call('POST', `/api/assets/${radio.id}/inspect`, { result: 'PASS', note: 'repaired and tested' }, adminT);
  assert.equal(ins.status, 200);
  assert.equal(ins.body.next_check_due_at, new Date(Date.now() + 365 * 86400e3).toISOString().slice(0, 10), 'next check from the interval');
  await call('POST', `/api/assets/${radio.id}/status`, { status: 'IN_STORE', note: 'fixed' }, adminT);

  const hist = (await call('GET', `/api/assets/${radio.id}/history`, undefined, adminT)).body.map((h) => h.type);
  for (const t of ['CHECKED_OUT', 'RETURNED', 'INSPECTED', 'BACK_IN_STORE']) assert.ok(hist.includes(t), `history has ${t}`);
});

test('lost while issued ends the check-out against that person; lost and retired need a reason', async () => {
  const cam = (await call('POST', '/api/assets', { tag: 'BC-01', description: 'Body camera', category: 'BODY_CAMERA' }, adminT)).body;
  await call('POST', `/api/assets/${cam.id}/checkout`, { personnel_id: ellie.id }, adminT);
  assert.equal((await call('POST', `/api/assets/${cam.id}/status`, { status: 'LOST' }, adminT)).status, 400, 'reason required');
  const lost = await call('POST', `/api/assets/${cam.id}/status`, { status: 'LOST', note: 'dropped on patrol' }, adminT);
  assert.equal(lost.body.status, 'LOST');
  assert.ok(app.db.asset_checkouts.find((c) => c.asset_id === cam.id).returned_at, 'check-out closed');
  assert.equal((await call('POST', `/api/assets/${cam.id}/checkout`, { personnel_id: ellie.id }, adminT)).status, 409, 'a lost asset cannot be issued');
  const found = await call('POST', `/api/assets/${cam.id}/status`, { status: 'IN_STORE', note: 'handed in' }, adminT);
  assert.equal(found.body.status, 'IN_STORE');
  assert.ok((await call('GET', `/api/assets/${cam.id}/history`, undefined, adminT)).body.some((h) => h.type === 'FOUND'));
  assert.equal((await call('GET', '/api/assets/register', undefined, danT)).status, 403, 'the register is for control');
});

/* ---------------- batches & expiry ---------------- */
test('batches: stock goes out earliest-expiry first, a chosen batch is honoured, and expiring batches are listed', async () => {
  const kit = (await call('POST', '/api/assets', { description: 'Burn gel', category: 'FIRST_AID', unit: 'sachet', is_stock_tracked: true }, adminT)).body;
  const soon = new Date(Date.now() + 10 * 86400e3).toISOString().slice(0, 10), later = new Date(Date.now() + 200 * 86400e3).toISOString().slice(0, 10);
  await call('POST', `/api/stock/${kit.id}/receive`, { quantity: 5, location_id: main.id, batch_no: 'B-LATE', expiry_date: later }, adminT);
  await call('POST', `/api/stock/${kit.id}/receive`, { quantity: 4, location_id: main.id, batch_no: 'B-SOON', expiry_date: soon }, adminT);
  await call('POST', `/api/stock/${kit.id}/receive`, { quantity: 2, location_id: main.id }, adminT);
  assert.equal((await call('POST', `/api/stock/${kit.id}/receive`, { quantity: 1, batch_no: 'B-SOON', expiry_date: later }, adminT)).status, 409, 'one batch, one expiry');

  const issued = await call('POST', `/api/stock/${kit.id}/issue`, { quantity: 6, location_id: main.id, personnel_id: dan.id }, adminT);
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  assert.deepEqual(issued.body.map((m) => [m.batch_no, m.delta]), [['B-SOON', -4], ['B-LATE', -2]], 'soonest expiry first, then the next');
  let i = await item(kit.id);
  assert.deepEqual(i.batches.map((b) => [b.batch_no, b.qty]).sort(), [['B-LATE', 3]].sort(), 'B-SOON used up; no-batch stock is not listed as a batch');
  assert.equal(i.total, 5);
  assert.equal(i.next_expiry, later);

  assert.equal((await call('POST', `/api/stock/${kit.id}/adjust`, { reason: 'EXPIRED', delta: -4, location_id: main.id, batch_no: 'B-LATE' }, adminT)).status, 409, 'only 3 in that batch');
  await call('POST', `/api/stock/${kit.id}/receive`, { quantity: 3, location_id: main.id, batch_no: 'B-SOON2', expiry_date: soon }, adminT);
  const ov = (await call('GET', '/api/stock/overview', undefined, adminT)).body;
  assert.ok(ov.expiring_batches.some((b) => b.item_id === kit.id && b.batch_no === 'B-SOON2' && b.qty === 3), 'expiring batch listed');
  assert.equal(ov.items.find((x) => x.id === kit.id).expiring_soon, true);

  // A per-batch count.
  const t = await call('POST', '/api/stock/stocktake', { location_id: main.id, counts: [{ item_id: kit.id, batch_no: 'B-LATE', expiry_date: later, counted: 1 }] }, adminT);
  assert.equal(t.status, 201, JSON.stringify(t.body));
  assert.deepEqual([t.body.lines[0].expected, t.body.lines[0].diff], [3, -2]);
  i = await item(kit.id);
  assert.equal(i.batches.find((b) => b.batch_no === 'B-LATE').qty, 1);
});

/* ---------------- PAT & inspections ---------------- */
test('PAT testing is chosen when the asset is created, inspections run on their own frequency', async () => {
  const kettle = (await call('POST', '/api/assets', { tag: 'KET-1', description: 'Kettle', category: 'EQUIPMENT', pat_required: true, pat_interval_days: 365, check_interval_days: 30 }, adminT)).body;
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(kettle.pat_next_due_at, today, 'never tested: PAT due now');
  assert.equal(kettle.next_check_due_at, new Date(Date.now() + 30 * 86400e3).toISOString().slice(0, 10), 'first inspection one interval away');
  let row = (await call('GET', '/api/assets/register', undefined, adminT)).body.assets.find((a) => a.id === kettle.id);
  assert.equal(row.pat_state, 'DUE_SOON');
  const pat = await call('POST', `/api/assets/${kettle.id}/inspect`, { kind: 'PAT', result: 'PASS' }, adminT);
  assert.equal(pat.body.pat_next_due_at, new Date(Date.now() + 365 * 86400e3).toISOString().slice(0, 10));
  assert.equal(pat.body.next_check_due_at, kettle.next_check_due_at, 'a PAT test does not move the inspection');
  const radio = (await call('POST', '/api/assets', { tag: 'RAD-77', description: 'Radio', category: 'RADIO' }, adminT)).body;
  assert.ok(!radio.pat_required);
  assert.equal((await call('POST', `/api/assets/${radio.id}/inspect`, { kind: 'PAT' }, adminT)).status, 400, 'no PAT on an asset not set up for it');
  const fail = await call('POST', `/api/assets/${kettle.id}/inspect`, { kind: 'INSPECTION', result: 'FAIL', note: 'cable split' }, adminT);
  assert.equal(fail.body.status, 'IN_REPAIR');
});

/* ---------------- rentals ---------------- */
const JPEG = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
test('a rental: items scanned out on hire, signed PDF agreement, shown in the client portal, returned at the desk', async () => {
  const site = app.db.sites[0];
  const client = (await call('POST', '/api/clients', { name: 'Hire Co', site_ids: [site.id] }, adminT)).body;
  const other = (await call('POST', '/api/clients', { name: 'Someone Else', site_ids: [] }, adminT)).body;
  await call('POST', '/api/users', { username: 'hireclient', password: 'realpassword1', role: 'CLIENT', client_id: client.id }, adminT);
  await call('POST', '/api/users', { username: 'otherclient', password: 'realpassword1', role: 'CLIENT', client_id: other.id }, adminT);
  const clientT = await login('hireclient', 'realpassword1'), otherT = await login('otherclient', 'realpassword1');

  const a1 = (await call('POST', '/api/assets', { tag: 'HIRE-1', description: 'Barrier light', category: 'EQUIPMENT', serial_no: 'SN1', condition: 'GOOD' }, adminT)).body;
  const a2 = (await call('POST', '/api/assets', { tag: 'HIRE-2', description: 'Radio — hire set', category: 'RADIO', condition: 'NEW' }, adminT)).body;
  const a3 = (await call('POST', '/api/assets', { tag: 'HIRE-3', description: 'Busy radio', category: 'RADIO' }, adminT)).body;
  await call('POST', `/api/assets/${a3.id}/checkout`, { personnel_id: dan.id }, dispT);

  // The desk finds items by tag.
  const look = await call('GET', '/api/assets/lookup?tag=hire-1', undefined, dispT);
  assert.equal(look.body.id, a1.id, 'tags match regardless of case');
  assert.equal((await call('GET', '/api/assets/lookup?tag=NOPE', undefined, dispT)).status, 404);

  const base = { site_id: site.id, contact_name: 'Pat Jones', signed_name: 'Pat Jones', agreed: true, signature: { mimetype: 'image/jpeg', data: JPEG }, expected_return_at: new Date(Date.now() + 7 * 86400e3).toISOString(), charge_amount: 25, charge_period: 'WEEK', deposit: 100 };
  assert.equal((await call('POST', '/api/rentals', { ...base, asset_ids: [a1.id] }, dispT)).status, 403, 'admins make rentals');
  assert.equal((await call('POST', '/api/rentals', { ...base, asset_ids: [a1.id, a3.id] }, adminT)).status, 409, 'a signed-out item cannot be hired');
  assert.equal((await call('POST', '/api/rentals', { ...base, agreed: false, asset_ids: [a1.id] }, adminT)).status, 400, 'terms must be agreed');
  assert.equal((await call('POST', '/api/rentals', { ...base, signature: null, asset_ids: [a1.id] }, adminT)).status, 400, 'signature required');
  const r = await call('POST', '/api/rentals', { ...base, asset_ids: [a1.id, a2.id] }, adminT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.reference, /^RENT-\d{4}-\d{5}$/);
  assert.equal(r.body.hirer_name, `Hire Co — ${site.name}`, 'a site rental names its client');
  assert.equal(app.db.assets.find((a) => a.id === a1.id).status, 'ON_HIRE');
  assert.equal((await call('POST', `/api/assets/${a1.id}/checkout`, { personnel_id: dan.id }, dispT)).status, 409, 'on hire: cannot be signed out');
  assert.equal((await call('POST', `/api/rentals`, { ...base, asset_ids: [a1.id] }, adminT)).status, 409, 'cannot be hired twice');

  const pdf = await fetch(`${BASE}/api/rentals/${r.body.id}/agreement`, { headers: { authorization: `Bearer ${adminT}` } });
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const bytes = Buffer.from(await pdf.arrayBuffer());
  assert.equal(bytes.slice(0, 5).toString(), '%PDF-');
  assert.ok(bytes.includes(Buffer.from('/DCTDecode')), 'the signature is in it');
  assert.ok(bytes.includes(Buffer.from('HIRE-1')) && bytes.includes(Buffer.from('Terms and conditions of rental')));

  // The client sees it; nobody else does.
  const mine = (await call('GET', '/api/client/rentals', undefined, clientT)).body;
  assert.equal(mine.length, 1);
  assert.deepEqual(mine[0].items.map((i) => [i.tag, i.returned_at]), [['HIRE-1', null], ['HIRE-2', null]]);
  assert.equal((await call('GET', '/api/client/rentals', undefined, otherT)).body.length, 0);
  assert.equal((await fetch(`${BASE}/api/client/rentals/${r.body.id}/agreement`, { headers: { authorization: `Bearer ${otherT}` } })).status, 404);
  assert.equal((await fetch(`${BASE}/api/client/rentals/${r.body.id}/agreement`, { headers: { authorization: `Bearer ${clientT}` } })).status, 200);

  // One back at the desk (control), damaged; then the rest.
  const part = await call('POST', `/api/rentals/${r.body.id}/return`, { asset_ids: [a1.id], condition: 'DAMAGED', note: 'lens cracked' }, dispT);
  assert.equal(part.status, 200, JSON.stringify(part.body));
  assert.equal(part.body.status, 'PART_RETURNED');
  assert.equal(app.db.assets.find((a) => a.id === a1.id).status, 'IN_REPAIR');
  assert.equal((await call('POST', `/api/rentals/${r.body.id}/return`, { asset_ids: [a1.id] }, dispT)).status, 409, 'already back');
  const portal = (await call('GET', '/api/client/rentals', undefined, clientT)).body[0];
  assert.ok(portal.items.find((i) => i.tag === 'HIRE-1').returned_at, 'portal shows it returned');
  assert.equal(portal.return_notes.length, 1);
  const done = await call('POST', `/api/rentals/${r.body.id}/return`, {}, dispT);
  assert.equal(done.body.status, 'RETURNED');
  assert.equal(app.db.assets.find((a) => a.id === a2.id).status, 'IN_STORE');
  const note = await fetch(`${BASE}/api/rentals/${r.body.id}/returns/2`, { headers: { authorization: `Bearer ${adminT}` } });
  assert.equal(note.status, 200);
  assert.ok((await call('GET', `/api/assets/${a1.id}/history`, undefined, adminT)).body.some((h) => h.type === 'HIRED_OUT'));
});
