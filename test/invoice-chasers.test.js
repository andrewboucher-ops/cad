/* Payment reminders and statements (routes-invoice-chasers.js) — node --test.
 * Xero isn't connected here, so what is owed comes from CCCS's own approved
 * invoices; mail is caught by swapping app.mailer.send. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4071';
process.env.AUTH_SECRET = 'chasers-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
async function call(method, path, body, token) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const buf = Buffer.from(await res.arrayBuffer());
  let parsed = null; try { parsed = JSON.parse(buf.toString()); } catch { parsed = buf; }
  return { status: res.status, body: parsed, type: res.headers.get('content-type') };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

let T, client, sent = [];
const realSend = app.mailer.send;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  T = await login('admin', 'admin123');
  app.mailer.send = async (to, subject, html, opts) => { sent.push({ to, subject, html, opts }); return { ok: true }; };
  client = (await call('POST', '/api/clients', { name: 'Slow Payers Ltd', contact_email: 'ops@slow.example', billing_email: 'accounts@slow.example' }, T)).body;
});
after(() => { app.mailer.send = realSend; app.server.closeAllConnections?.(); app.server.close(); });

let invId = 9000;
function addInvoice(number, dueDaysAgo, total, status = 'APPROVED') {
  const inv = { id: ++invId, number, reference: `R/${invId}`, status, client_id: client.id, client_name: client.name, site_name: 'Depot', issue_date: daysAgo(dueDaysAgo + 30), due_date: daysAgo(dueDaysAgo), total, subtotal: total, vat: 0, vat_rate: 0, lines: [], history: [] };
  app.db.invoices.push(inv);
  return inv;
}
const key = () => `c-${client.id}`;

test('off by default, lists what is owed, nothing sent by itself', async () => {
  addInvoice('INV-9001', 20, 600);
  addInvoice('INV-9002', -5, 100); // not due yet
  const r = await call('GET', '/api/invoice-chasers', undefined, T);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.settings.enabled, false);
  assert.deepStrictEqual(r.body.settings.stages, [1, 7, 14, 30]);
  const g = r.body.groups.find((x) => x.key === key());
  assert.ok(g);
  assert.strictEqual(g.total_due, 700);
  assert.strictEqual(g.overdue_total, 600);
  assert.deepStrictEqual(g.emails, ['accounts@slow.example']);
  assert.strictEqual(g.plan.stage, 14);
  assert.strictEqual(g.plan.due, true);
  assert.strictEqual(await app.invoiceChasers.tick(), null);
  assert.strictEqual(sent.length, 0);
  assert.strictEqual((await call('POST', '/api/invoice-chasers/run', {}, T)).status, 409);
});

test('the statement PDF lists every open invoice and the late payment terms', async () => {
  const r = await call('GET', `/api/invoice-chasers/${key()}/statement`, undefined, T);
  assert.strictEqual(r.status, 200);
  assert.match(r.type, /application\/pdf/);
  const text = r.body.toString('latin1');
  assert.match(text, /STATEMENT OF ACCOUNT/);
  assert.match(text, /INV-9001/);
  assert.match(text, /INV-9002/);
  assert.match(text, /Late Payment of Commercial Debts/);
});

test('one day overdue gets the first reminder', async () => {
  const st = app.invoiceChasers.settings();
  const g = (await app.invoiceChasers.collect()).find((x) => x.key === key());
  const one = { ...g, overdue: [{ key: 'c-test', number: 'INV-1', due_date: daysAgo(1), days_overdue: 1, amount_due: 10 }] };
  assert.strictEqual(app.invoiceChasers.plan(one, st).stage, 1);
  const mail = app.invoiceChasers.emailFor(one, 1, st);
  assert.match(mail.subject, /^Reminder: invoice INV-1 is overdue/);
  assert.match(mail.html, /the invoice below is now past its due date/);
  assert.match(mail.html, /Late Payment of Commercial Debts/);
});

test('a reminder run sends one email at the latest stage reached, then not again', async () => {
  assert.strictEqual((await call('PUT', '/api/invoice-chasers/settings', { enabled: true, stages: '1, 7, 14, 30', copy_to: 'me@echelon.example' }, T)).status, 200);
  const r = await call('POST', '/api/invoice-chasers/run', {}, T);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.sent.length, 1);
  assert.strictEqual(sent.length, 1);
  const m = sent[0];
  assert.strictEqual(m.to, 'accounts@slow.example');
  assert.match(m.subject, /^Third reminder: invoice INV-9001 is overdue/);
  assert.strictEqual(m.opts.bcc, 'me@echelon.example');
  assert.strictEqual(m.opts.attachments.length, 1);
  assert.match(m.opts.attachments[0].name, /^Statement - Slow Payers Ltd/);
  assert.match(m.html, /INV-9001/);
  assert.doesNotMatch(m.html, /INV-9002/); // reminders list only the overdue ones
  assert.match(m.html, /Late Payment of Commercial Debts/); // terms in every reminder
  // 1, 7 and 14 all marked, so the same reminders never go again.
  const again = await call('POST', '/api/invoice-chasers/run', {}, T);
  assert.strictEqual(again.body.sent.length, 0);
  assert.strictEqual(sent.length, 1);
  assert.ok(app.db.invoices.find((i) => i.number === 'INV-9001').history.some((h) => /third reminder emailed/.test(h.what)));
});

test('the gap between emails holds a new reminder back, then it goes', async () => {
  addInvoice('INV-9003', 35, 250);
  let g = (await call('GET', '/api/invoice-chasers', undefined, T)).body.groups.find((x) => x.key === key());
  assert.strictEqual(g.plan.stage, 30);
  assert.strictEqual(g.plan.due, false);
  assert.match(g.plan.reason, /waiting/);
  // Pretend the last one went a week ago.
  for (const e of app.db.invoice_chases) e.at = new Date(Date.now() - 7 * 86400000).toISOString();
  const r = await call('POST', '/api/invoice-chasers/run', {}, T);
  assert.strictEqual(r.body.sent.length, 1);
  assert.match(sent[1].subject, /^Final reminder: 2 invoices are overdue \(£850\.00\)/);
});

test('paused customers are not chased; statements can be sent by hand', async () => {
  for (const e of app.db.invoice_chases) e.at = new Date(Date.now() - 30 * 86400000).toISOString();
  addInvoice('INV-9004', 8, 50);
  assert.strictEqual((await call('POST', `/api/invoice-chasers/${key()}/pause`, { until: null }, T)).status, 200);
  const g = (await call('GET', '/api/invoice-chasers', undefined, T)).body.groups.find((x) => x.key === key());
  assert.match(g.plan.reason, /paused/);
  assert.strictEqual((await call('POST', '/api/invoice-chasers/run', {}, T)).body.sent.length, 0);
  await call('POST', `/api/invoice-chasers/${key()}/pause`, { resume: true }, T);
  const before = sent.length;
  const s = await call('POST', `/api/invoice-chasers/${key()}/send`, { stage: 'statement' }, T);
  assert.strictEqual(s.status, 200);
  assert.strictEqual(sent.length, before + 1);
  assert.match(sent[before].subject, /^Statement of account/);
  assert.match(sent[before].html, /INV-9002/); // a statement lists everything open
  // The statement counts for the gap, so the 7-day reminder for INV-9004 waits.
  const g2 = (await call('GET', '/api/invoice-chasers', undefined, T)).body.groups.find((x) => x.key === key());
  assert.strictEqual(g2.plan.stage, 7);
  assert.match(sent[before].html, /Late Payment of Commercial Debts/);
  assert.match(g2.plan.reason, /waiting/);
});

test('paid and void invoices drop out; settings are checked', async () => {
  for (const i of app.db.invoices) if (i.client_id === client.id) i.status = 'PAID';
  const r = await call('GET', '/api/invoice-chasers', undefined, T);
  assert.ok(!r.body.groups.some((x) => x.key === key()));
  assert.strictEqual((await call('PUT', '/api/invoice-chasers/settings', { stages: 'soon' }, T)).status, 400);
  assert.strictEqual((await call('PUT', '/api/invoice-chasers/settings', { copy_to: 'not-an-email' }, T)).status, 400);
});

test('late payment terms are on unpaid invoices and editable', async () => {
  const st = (await call('GET', '/api/invoices/settings', undefined, T)).body;
  assert.match(st.late_payment_terms, /Late Payment of Commercial Debts \(Interest\) Act 1998/);
  const inv = addInvoice('INV-9005', 1, 80);
  let pdf = (await call('GET', `/api/invoices/${inv.id}/pdf`, undefined, T)).body.toString('latin1');
  assert.match(pdf, /Late Payment of Commercial Debts/);
  await call('PUT', '/api/invoices/settings', { late_payment_terms: '' }, T);
  pdf = (await call('GET', `/api/invoices/${inv.id}/pdf`, undefined, T)).body.toString('latin1');
  assert.doesNotMatch(pdf, /Late Payment of Commercial Debts/);
});

test('Xero-raised invoices are chased, joined to the CCCS client, and a Xero failure sends nothing', async () => {
  const register = require('../routes-invoice-chasers.js');
  const db = { clients: [{ id: 1, name: 'Sensor Link', billing_email: '' }], invoices: [{ id: 5, number: 'INV-0070', status: 'APPROVED', client_id: 1, client_name: 'Sensor Link', issue_date: daysAgo(40), due_date: daysAgo(10), total: 100, history: [] }], ui_settings: [] };
  let fail = false;
  const xero = {
    connected: () => true,
    outstandingInvoices: async () => { if (fail) throw new Error('down'); return [
      { invoice_id: 'a', number: 'INV-0001', contact_id: 'X1', contact_name: 'sensor link', date: daysAgo(180), due_date: daysAgo(149), total: 1270.77, amount_paid: 0, amount_due: 1270.77 },
      { invoice_id: 'b', number: 'INV-0047', contact_id: 'X2', contact_name: 'Lauren Cole', date: daysAgo(58), due_date: daysAgo(51), total: 132.5, amount_paid: 0, amount_due: 132.5 },
    ]; },
    contactEmails: async (ids) => Object.fromEntries(ids.map((id) => [id, id === 'X1' ? ['accounts@sensor.example'] : ['lauren@example.com']])),
  };
  const mails = [];
  const routes = {};
  const api = register({ route: (m, p, r, h) => { routes[`${m} ${p}`] = h; }, httpError: (s, m) => Object.assign(new Error(m), { status: s }), ADMIN: ['SYSTEM_ADMIN'], FINANCE: ['FINANCE'], db, nextId: (() => { let n = 0; return () => ++n; })(), logEvent: () => {}, xero,
    invoices: { company: () => ({ company_name: 'Echelon' }), settings: () => ({ account_number: '12345678', sort_code: '12-34-56', late_payment_terms: 'Late terms.' }) },
    sendEmail: async (to, subject) => { mails.push({ to, subject }); return { ok: true }; }, tickMs: 1e9 });
  const groups = await api.collect();
  const sl = groups.find((g) => g.key === 'x-X1');
  assert.strictEqual(sl.client_id, 1, 'joined to the CCCS client by name');
  assert.deepStrictEqual(sl.items.map((x) => x.number), ['INV-0001', 'INV-0070']);
  assert.deepStrictEqual(sl.emails, ['accounts@sensor.example'], 'falls back to the Xero contact address');
  assert.strictEqual(db.clients[0].xero_contact_id, undefined, 'nothing written to the client');
  assert.ok(groups.find((g) => g.key === 'x-X2'));
  api.settings().enabled = true;
  const r = await api.run();
  assert.strictEqual(r.sent.length, 2);
  assert.ok(mails.some((m) => /^Final reminder: 2 invoices/.test(m.subject) && m.to === 'accounts@sensor.example'));
  fail = true;
  await assert.rejects(api.run(), /could not read what is owed from Xero/);
  assert.strictEqual(mails.length, 2);
});
