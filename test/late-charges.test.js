/* Statutory late payment charges (routes-late-charges.js) — node --test. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4072';
process.env.AUTH_SECRET = 'late-charges-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';
// A stand-in for the Bank of England's Bank Rate history page.
const http = require('http');
let boeUp = false;
const BOE_HTML = '<table><tr><th>Date Changed</th><th>Rate</th></tr><tr><td>05 Nov 26</td><td>4.00</td></tr><tr><td>18 Dec 25</td><td>3.75</td></tr><tr><td>07 Aug 25</td><td>4.00</td></tr><tr><td>08 May 25</td><td>4.25</td></tr></table>';
const boeServer = http.createServer((req, res) => { if (!boeUp) { res.writeHead(503); res.end(); return; } res.writeHead(200, { 'content-type': 'text/html' }); res.end(BOE_HTML); }).listen(4073);
process.env.BOE_RATE_URL = 'http://127.0.0.1:4073/Bank-Rate.asp';
const boe = require('../boe-rate.js');

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
after(() => { app.server.closeAllConnections?.(); app.server.close(); boeServer.close(); });
const key = () => `c-${client.id}`;

test('the Bank of England history is read, and each debt uses its statutory reference date', () => {
  const rates = boe.parseHtml(BOE_HTML);
  assert.deepStrictEqual(rates, [['2025-05-08', 4.25], ['2025-08-07', 4], ['2025-12-18', 3.75], ['2026-11-05', 4]]);
  assert.strictEqual(boe.referenceDate('2026-03-01'), '2025-12-31');
  assert.strictEqual(boe.referenceDate('2026-07-01'), '2026-06-30');
  assert.strictEqual(boe.rateOn(rates, '2025-06-30'), 4.25);
  assert.strictEqual(boe.rateOn(rates, '2025-12-31'), 3.75);
  assert.strictEqual(boe.rateOn(rates, '2026-06-30'), 3.75); // the 5 Nov 2026 rise doesn't apply until 2027
  assert.deepStrictEqual(boe.parseCsv('DATE,IUDBEDR\n02 Jan 2024,5.25\n03 Jan 2024,5.25\n01 Aug 2024,5.00\n'), [['2024-01-02', 5.25], ['2024-08-01', 5]]);
});

test('works out compensation by size; interest from the Bank of England rate, or by hand when it is down', async () => {
  // The Bank can't be reached and no rate was typed in: no interest yet.
  let r = await call('GET', `/api/late-charges/${key()}`, undefined, T);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.target, 'cccs');
  assert.strictEqual(r.body.settings.base_rate_mode, 'AUTO');
  assert.ok(r.body.settings.boe.error);
  let [a, b] = r.body.items;
  assert.strictEqual(a.number, 'INV-7001');
  assert.strictEqual(a.compensation.amount, 70); // £1,200 debt
  assert.strictEqual(b.compensation.amount, 40); // £300 debt
  assert.strictEqual(a.interest.amount, null);
  assert.strictEqual((await call('POST', `/api/late-charges/${key()}`, { include: [{ key: a.key, interest: true }] }, T)).status, 409);
  assert.strictEqual((await call('POST', '/api/late-charges/refresh-rate', {}, T)).status, 502);
  // A rate typed in is the fallback.
  assert.strictEqual((await call('PUT', '/api/late-charges/settings', { base_rate: '' }, T)).status, 400);
  assert.strictEqual((await call('PUT', '/api/late-charges/settings', { base_rate: 4 }, T)).status, 200);
  [a] = (await call('GET', `/api/late-charges/${key()}`, undefined, T)).body.items;
  assert.strictEqual(a.interest.rate, 12);
  assert.strictEqual(a.interest.source, 'entered by hand');
  // The Bank is back: its reference rate for each debt wins.
  boeUp = true;
  assert.strictEqual((await call('POST', '/api/late-charges/refresh-rate', {}, T)).status, 200);
  r = (await call('GET', `/api/late-charges/${key()}`, undefined, T)).body;
  [a, b] = r.items;
  const expectBase = boe.rateOn(boe.parseHtml(BOE_HTML), boe.referenceDate(new Date(Date.parse(`${a.due_date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)));
  assert.strictEqual(a.interest.source, 'Bank of England');
  assert.strictEqual(a.interest.base, expectBase);
  assert.strictEqual(a.interest.rate, expectBase + 8);
  assert.strictEqual(a.interest.days, 100);
  assert.strictEqual(a.interest.amount, Math.round(1200 * (expectBase + 8) / 100 * 100 / 365 * 100) / 100);
  assert.ok(r.settings.boe.fetched_at);
  assert.strictEqual(r.settings.boe.error, null);
});

test('raises one draft charge invoice with no VAT, and never claims the same thing twice', async () => {
  const items = (await call('GET', `/api/late-charges/${key()}`, undefined, T)).body.items;
  const r = await call('POST', `/api/late-charges/${key()}`, { include: items.map((x) => ({ key: x.key, interest: true, compensation: true })) }, T);
  assert.strictEqual(r.status, 200);
  const inv = app.db.invoices.find((i) => i.id === r.body.cccs_invoice_id);
  assert.strictEqual(inv.status, 'DRAFT');
  assert.strictEqual(inv.vat, 0);
  assert.strictEqual(inv.lines.length, 4);
  assert.ok(inv.lines.some((l) => /Statutory interest on invoice INV-7001: £1,200\.00 at \d+\.\d\d% a year \(Bank of England base rate \d+\.\d\d% on \d+ \w+ \d{4} \+ 8%\)/.test(l.description)));
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
