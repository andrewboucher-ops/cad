/* Medication and the controlled drugs register (routes-medication.js) — node --test */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4044';
process.env.AUTH_SECRET = 'medication-test-secret';
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
const W = { witness_username: 'supervisor', witness_password: 'super123' };

let adminT, dispT, danT, safe, bag, morphine, paracetamol;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dispT = await login('dispatcher', 'dispatch123');
  danT = await login('dwhitfield', 'field123');
  safe = (await call('GET', '/api/stock/locations', undefined, adminT)).body.find((l) => l.is_main);
  bag = (await call('POST', '/api/stock/locations', { name: 'Paramedic bag 1', kind: 'BAG' }, adminT)).body;
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });
const med = async (id) => (await call('GET', '/api/medication', undefined, dispT)).body.medicines.find((m) => m.id === id);

test('the catalogue is admin only; a controlled drug needs its schedule', async () => {
  assert.equal((await call('POST', '/api/medication/medicines', { name: 'X', strength: '1 mg' }, dispT)).status, 403);
  assert.equal((await call('POST', '/api/medication/medicines', { name: 'Morphine sulfate', strength: '10 mg/1 ml', form: 'AMPOULE', controlled: true }, adminT)).status, 400, 'schedule required');
  morphine = (await call('POST', '/api/medication/medicines', { name: 'Morphine sulfate', strength: '10 mg/1 ml', form: 'AMPOULE', unit: 'ampoule', controlled: true, cd_schedule: 2, reorder_level: 5 }, adminT)).body;
  assert.equal(morphine.cd_schedule, 2);
  assert.equal((await call('POST', '/api/medication/medicines', { name: 'morphine sulfate', strength: '10 MG/1 ML', form: 'AMPOULE', controlled: true, cd_schedule: 2 }, adminT)).status, 409, 'one entry per drug, strength and form');
  paracetamol = (await call('POST', '/api/medication/medicines', { name: 'Paracetamol', strength: '500 mg', form: 'TABLET', unit: 'tablet', legal_category: 'P' }, adminT)).body;
  assert.equal(paracetamol.controlled, false);
  assert.equal((await call('GET', '/api/medication', undefined, danT)).status, 200, 'field staff can see what they carry');
});

test('a CD receipt needs a real, different witness and the supplier', async () => {
  const rec = { quantity: 10, location_id: safe.id, batch_no: 'M1', expiry_date: '2030-06-30', supplier: 'Pharmacy Ltd', reference: 'REQ-1' };
  assert.equal((await call('POST', `/api/medication/${morphine.id}/receive`, rec, dispT)).status, 400, 'no witness');
  assert.equal((await call('POST', `/api/medication/${morphine.id}/receive`, { ...rec, witness_username: 'supervisor', witness_password: 'wrong' }, dispT)).status, 400, 'wrong password');
  assert.equal((await call('POST', `/api/medication/${morphine.id}/receive`, { ...rec, witness_username: 'dispatcher', witness_password: 'dispatch123' }, dispT)).status, 400, 'cannot witness yourself');
  assert.equal((await call('POST', `/api/medication/${morphine.id}/receive`, { ...rec, supplier: '', ...W }, dispT)).status, 400, 'supplier required');
  assert.equal((await call('POST', `/api/medication/${morphine.id}/receive`, { ...rec, expiry_date: '', ...W }, dispT)).status, 400, 'expiry required');
  assert.equal((await call('POST', `/api/medication/${morphine.id}/receive`, { ...rec, ...W }, danT)).status, 403, 'field staff do not receive stock');
  const r = await call('POST', `/api/medication/${morphine.id}/receive`, { ...rec, ...W }, dispT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body[0].witness, 'supervisor'); assert.equal(r.body[0].balance_after, 10);
  // A non-CD receipt does not need a witness.
  assert.equal((await call('POST', `/api/medication/${paracetamol.id}/receive`, { quantity: 32, location_id: safe.id, expiry_date: '2029-01-01' }, dispT)).status, 201);
});

test('move to a bag, then a crew administers with the patient, dose and waste recorded', async () => {
  assert.equal((await call('POST', `/api/medication/${morphine.id}/transfer`, { quantity: 4, from_location_id: safe.id, to_location_id: bag.id }, dispT)).status, 400, 'CD move needs a witness');
  assert.equal((await call('POST', `/api/medication/${morphine.id}/transfer`, { quantity: 4, from_location_id: safe.id, to_location_id: bag.id, ...W }, dispT)).status, 201);
  let m = await med(morphine.id);
  assert.equal(m.levels[safe.id], 6); assert.equal(m.levels[bag.id], 4); assert.equal(m.total, 10);
  const give = { quantity: 1, location_id: bag.id, dose_given: '5 mg IV', dose_wasted: '5 mg', patient_ref: 'JOB-77' };
  assert.equal((await call('POST', `/api/medication/${morphine.id}/administer`, { ...give, ...W }, danT)).status, 400, "a CD needs the patient's name");
  assert.equal((await call('POST', `/api/medication/${morphine.id}/administer`, { ...give, patient_name: 'John Smith', dose_given: '' , ...W }, danT)).status, 400, 'dose required');
  assert.equal((await call('POST', `/api/medication/${morphine.id}/administer`, { ...give, patient_name: 'John Smith', quantity: 5, ...W }, danT)).status, 409, 'cannot go below zero');
  const r = await call('POST', `/api/medication/${morphine.id}/administer`, { ...give, patient_name: 'John Smith', authority: 'JRCALC', ...W }, danT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body[0].location_balance_after, 3); assert.equal(r.body[0].balance_after, 9);
  // Paracetamol: no witness, and a job number is enough.
  assert.equal((await call('POST', `/api/medication/${paracetamol.id}/administer`, { quantity: 2, location_id: safe.id, dose_given: '1 g oral', patient_ref: 'JOB-78' }, danT)).status, 201);
});

test('expired stock can be destroyed with a witness but never administered', async () => {
  await call('POST', `/api/medication/${morphine.id}/receive`, { quantity: 2, location_id: bag.id, batch_no: 'OLD', expiry_date: '2020-01-01', supplier: 'Pharmacy Ltd', ...W }, dispT);
  // 3 in date + 2 expired in the bag: asking for 4 must refuse rather than use the expired ones.
  const r = await call('POST', `/api/medication/${morphine.id}/administer`, { quantity: 4, location_id: bag.id, dose_given: 'x', patient_name: 'A', ...W }, danT);
  assert.equal(r.status, 409); assert.match(r.body.error, /in date/);
  assert.equal((await call('POST', `/api/medication/${morphine.id}/destroy`, { quantity: 2, location_id: bag.id, batch_no: 'OLD', ...W }, dispT)).status, 400, 'reason required');
  assert.equal((await call('POST', `/api/medication/${morphine.id}/destroy`, { quantity: 2, location_id: bag.id, batch_no: 'OLD', reason: 'Expired', ...W }, danT)).status, 403, 'destruction is control');
  assert.equal((await call('POST', `/api/medication/${morphine.id}/destroy`, { quantity: 2, location_id: bag.id, batch_no: 'OLD', reason: 'Expired', ...W }, dispT)).status, 201);
  assert.equal((await med(morphine.id)).levels[bag.id], 3);
});

test('a CD stock check records every count and flags a discrepancy', async () => {
  assert.equal((await call('POST', '/api/medication/stock-check', { location_id: bag.id, counts: [{ medicine_id: morphine.id, batch_no: 'M1', expiry_date: '2030-06-30', counted: 3 }] }, dispT)).status, 400, 'witness needed');
  let r = await call('POST', '/api/medication/stock-check', { location_id: bag.id, counts: [{ medicine_id: morphine.id, batch_no: 'M1', expiry_date: '2030-06-30', counted: 3 }], ...W }, dispT);
  assert.equal(r.status, 201); assert.equal(r.body.lines[0].diff, 0);
  const entries = (await call('GET', `/api/medication/register/${morphine.id}`, undefined, dispT)).body.entries;
  assert.equal(entries[entries.length - 1].type, 'STOCK_CHECK', 'a correct CD count is still in the register');
  assert.equal((await call('POST', '/api/medication/stock-check', { location_id: bag.id, counts: [{ medicine_id: morphine.id, batch_no: 'M1', expiry_date: '2030-06-30', counted: 2 }], ...W }, dispT)).status, 400, 'a difference needs a reason');
  r = await call('POST', '/api/medication/stock-check', { location_id: bag.id, counts: [{ medicine_id: morphine.id, batch_no: 'M1', expiry_date: '2030-06-30', counted: 2 }], reason: 'One ampoule unaccounted for — reported', ...W }, dispT);
  assert.equal(r.body.lines[0].diff, -1);
  const ov = (await call('GET', '/api/medication', undefined, dispT)).body;
  assert.equal(ov.summary.discrepancies, 1);
});

test('entries are never edited or deleted — a correction points at the original', async () => {
  const entries = (await call('GET', `/api/medication/register/${morphine.id}`, undefined, dispT)).body.entries;
  const check = entries[entries.length - 1];
  assert.equal((await call('POST', '/api/medication/correct', { corrects_id: check.id, delta: 1 }, dispT)).status, 400, 'reason required');
  const r = await call('POST', '/api/medication/correct', { corrects_id: check.id, delta: 1, reason: 'Ampoule found in the bag lid pocket', ...W }, dispT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await call('POST', '/api/medication/correct', { corrects_id: check.id, delta: 1, reason: 'again', ...W }, dispT)).status, 409, 'only one correction per entry');
  const after = (await call('GET', `/api/medication/register/${morphine.id}`, undefined, dispT)).body.entries;
  assert.equal(after.find((e) => e.id === check.id).corrected_by, r.body[0].id);
  assert.equal(after.find((e) => e.id === check.id).delta, -1, 'the original is untouched');
  assert.equal((await med(morphine.id)).levels[bag.id], 3);
  assert.equal((await call('DELETE', `/api/medication/medicines/${morphine.id}`, undefined, adminT)).status, 409, 'a medicine with entries cannot be deleted');
  assert.equal((await call('PATCH', `/api/medication/medicines/${morphine.id}`, { strength: '30 mg/1 ml' }, adminT)).status, 409, "a CD's strength is fixed once it has entries");
  assert.equal((await call('PATCH', `/api/medication/medicines/${morphine.id}`, { reorder_level: 8 }, adminT)).status, 200);
});
