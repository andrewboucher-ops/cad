/* Statutory late payment charges (routes-late-charges.js) — node --test. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4072';
process.env.AUTH_SECRET = 'late-charges-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
async function call(method, path, body, token) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let parsed = null; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
let T, client;
before(async () => {
  app.start(); await new Promise((r) => setTimeout(r, 200));
  T = (await call('POST', '/api/auth/login', { username: 'admin', password: 'admin123' })).body.token;
  client = (await call('POST', '/api/clients', { name: 'Late Ltd', billing_email: 'a@late.example' }, T)).body;
  app.db.invoices.push({ id: 7001, number: 'INV-7001', status: 'APPROVED', client_id: client.id, client_name: 'Late Ltd', site_name: 'X', issue_date: daysAgo(130), due_date: daysAgo(100), total: 1200, subtotal: 1000, vat: 200, vat_rate: 20, lines: [], history: [] });
  app.db.invoices.push({ id: 7002, number: 'INV-7002', status: 'APPROVED', client_id: client.id, client_name: 'Late Ltd', site_name: 'X', issue_date: daysAgo(40), due_date: daysAgo(10), total: 300, subtotal: 300, vat: 0, vat_rate: 0, lines: [], history: [] });
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });
const key = () => `c-${client.id}`;

test('works out compensation by size, and interest only once the base rate is set', async () => {
  const r = await call('GET', `/api/late-charges/${key()}`, undefined, T);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.target, 'cccs');
  const [a, b] = r.body.items;
  assert.strictEqual(a.number, 'INV-7001');
  assert.strictEqual(a.compensation.amount, 70); // £1,200 debt
  assert.strictEqual(b.compensation.amount, 40); // £300 debt
  assert.strictEqual(a.interest.amount, null);
  assert.strictEqual((await call('POST', `/api/late-charges/${key()}`, { include: [{ key: a.key, interest: true }] }, T)).status, 409);
  assert.strictEqual((await call('PUT', '/api/late-charges/settings', { base_rate: '' }, T)).status, 400);
  assert.strictEqual((await call('PUT', '/api/late-charges/settings', { base_rate: 4 }, T)).status, 200);
  const r2 = (await call('GET', `/api/late-charges/${key()}`, undefined, T)).body;
  assert.strictEqual(r2.items[0].interest.rate, 12);
  assert.strictEqual(r2.items[0].interest.days, 100);
  assert.strictEqual(r2.items[0].interest.amount, Math.round(1200 * 0.12 * 100 / 365 * 100) / 100); // £39.45
});

test('raises one draft charge invoice with no VAT, and never claims the same thing twice', async () => {
  const items = (await call('GET', `/api/late-charges/${key()}`, undefined, T)).body.items;
  const r = await call('POST', `/api/late-charges/${key()}`, { include: items.map((x) => ({ key: x.key, interest: true, compensation: true })) }, T);
  assert.strictEqual(r.status, 200);
  const inv = app.db.invoices.find((i) => i.id === r.body.cccs_invoice_id);
  assert.strictEqual(inv.status, 'DRAFT');
  assert.strictEqual(inv.vat, 0);
  assert.strictEqual(inv.lines.length, 4);
  assert.ok(inv.lines.some((l) => /Statutory interest on invoice INV-7001: £1,200\.00 at 12\.00% a year/.test(l.description)));
  assert.ok(inv.lines.some((l) => /Fixed-sum compensation .* INV-7002.*section 5A/.test(l.description)));
  const expected = Math.round((items[0].interest.amount + items[1].interest.amount + 70 + 40) * 100) / 100;
  assert.strictEqual(inv.total, expected);
  // Straight after: interest claimed to today, compensation claimed.
  const after1 = (await call('GET', `/api/late-charges/${key()}`, undefined, T)).body.items;
  assert.ok(after1.every((x) => x.compensation.claimed && x.interest.days === 0 && x.interest.amount === 0));
  assert.strictEqual((await call('POST', `/api/late-charges/${key()}`, { include: after1.map((x) => ({ key: x.key, interest: true, compensation: true })) }, T)).status, 400);
  // Once approved, the charge invoice is owed but never charged interest itself.
  inv.status = 'APPROVED'; inv.number = 'INV-7003'; inv.due_date = daysAgo(20);
  const after2 = (await call('GET', `/api/late-charges/${key()}`, undefined, T)).body.items;
  assert.ok(!after2.some((x) => x.number === 'INV-7003'));
  // Forgetting the record frees them up again.
  assert.strictEqual((await call('DELETE', `/api/late-charges/records/${r.body.id}`, undefined, T)).status, 200);
  const after3 = (await call('GET', `/api/late-charges/${key()}`, undefined, T)).body.items;
  assert.ok(after3.some((x) => !x.compensation.claimed));
  assert.ok(!after3.some((x) => x.number === 'INV-7003'));
});
