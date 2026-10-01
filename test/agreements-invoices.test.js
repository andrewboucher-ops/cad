/* Quotes and contracts on sites, answered in the client portal
 * (routes-agreements.js); invoices built from signed contracts and hours
 * worked, sent to a fake Xero (routes-invoices.js, xero.js) — node --test */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

process.env.PORT = '4035';
process.env.AUTH_SECRET = 'agreements-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';
const XPORT = 4036, XBASE = `http://127.0.0.1:${XPORT}`;
process.env.XERO_CLIENT_ID = 'test-client-id';
process.env.XERO_CLIENT_SECRET = 'test-client-secret';
process.env.XERO_LOGIN_BASE = XBASE;
process.env.XERO_IDENTITY_BASE = XBASE;
process.env.XERO_API_BASE = XBASE;

/* ---- a fake Xero: just the endpoints xero.js uses ---- */
const X = { tokens: [], contacts: [], invoices: [], calls: [], emailed: [] };
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const u = new URL(req.url, XBASE);
    X.calls.push(`${req.method} ${u.pathname}`);
    if (u.pathname === '/connect/token') {
      const p = new URLSearchParams(raw);
      if (req.headers.authorization !== `Basic ${Buffer.from('test-client-id:test-client-secret').toString('base64')}`) return send(401, { error: 'invalid_client' });
      if (p.get('grant_type') === 'authorization_code' && p.get('code') !== 'good-code') return send(400, { error: 'invalid_grant' });
      X.tokens.push(p.get('grant_type'));
      return send(200, { access_token: `at-${X.tokens.length}`, refresh_token: `rt-${X.tokens.length}`, expires_in: 1800 });
    }
    if (!/^Bearer at-\d+$/.test(req.headers.authorization || '')) return send(401, { Detail: 'unauthorised' });
    if (u.pathname === '/connections') return send(200, [{ tenantId: 'tenant-1', tenantName: 'Echelon Test Ltd', tenantType: 'ORGANISATION' }]);
    if (req.headers['xero-tenant-id'] !== 'tenant-1') return send(403, { Detail: 'wrong tenant' });
    if (u.pathname === '/api.xro/2.0/Contacts' && req.method === 'GET') {
      const name = (u.searchParams.get('where') || '').match(/Name=="(.*)"/)[1];
      return send(200, { Contacts: X.contacts.filter((c) => c.Name === name) });
    }
    if (u.pathname === '/api.xro/2.0/Contacts' && req.method === 'POST') {
      const c = { ...JSON.parse(raw).Contacts[0], ContactID: `contact-${X.contacts.length + 1}` }; X.contacts.push(c);
      return send(200, { Contacts: [c] });
    }
    if (u.pathname === '/api.xro/2.0/Invoices' && req.method === 'POST') {
      const inv = JSON.parse(raw).Invoices[0];
      if (!inv.LineItems.length) return send(400, { Elements: [{ ValidationErrors: [{ Message: 'no lines' }] }] });
      const total = inv.LineItems.reduce((n, l) => n + l.Quantity * l.UnitAmount * (l.TaxType === 'NONE' ? 1 : 1.2), 0);
      const x = { ...inv, InvoiceID: `inv-${X.invoices.length + 1}`, InvoiceNumber: inv.InvoiceNumber || `X-${X.invoices.length + 1}`, Total: Math.round(total * 100) / 100, AmountDue: Math.round(total * 100) / 100, AmountPaid: 0 };
      X.invoices.push(x);
      return send(200, { Invoices: [x] });
    }
    if (u.pathname === '/api.xro/2.0/Invoices' && req.method === 'GET') {
      const ids = (u.searchParams.get('IDs') || '').split(',');
      return send(200, { Invoices: X.invoices.filter((i) => ids.includes(i.InvoiceID)) });
    }
    const em = u.pathname.match(/^\/api\.xro\/2\.0\/Invoices\/([^/]+)\/Email$/);
    if (em && req.method === 'POST') { X.emailed.push(em[1]); res.writeHead(204); return res.end(); }
    const m = u.pathname.match(/^\/api\.xro\/2\.0\/Invoices\/(.+)$/);
    if (m && req.method === 'GET') { const x = X.invoices.find((i) => i.InvoiceID === m[1]); return x ? send(200, { Invoices: [x] }) : send(404, { Detail: 'not found' }); }
    send(404, { Detail: 'no such fake endpoint' });
  });
});

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
async function call(method, path, body, token, raw = false) {
  const res = await fetch(BASE + path, { method, redirect: 'manual', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (raw) return res;
  const text = await res.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;
const JPEG = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

let adminT, dispT, clientT, otherT, finT, siteA, siteB, client, other;
const mails = [];
before(async () => {
  await new Promise((r) => fake.listen(XPORT, '127.0.0.1', r));
  app.mailer.send = async (to, subject, html, opts = {}) => { mails.push({ to, subject, html, attachments: opts.attachments || [] }); return { ok: true }; };
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123'); dispT = await login('dispatcher', 'dispatch123');
  [siteA, siteB] = app.db.sites;
  client = (await call('POST', '/api/clients', { name: 'Meridian Estates', contact_email: 'fm@meridian.example', site_ids: [siteA.id] }, adminT)).body;
  other = (await call('POST', '/api/clients', { name: 'Other Co', site_ids: [siteB.id] }, adminT)).body;
  await call('POST', '/api/users', { username: 'meridian', password: 'realpassword1', role: 'CLIENT', client_id: client.id }, adminT);
  await call('POST', '/api/users', { username: 'otherco', password: 'realpassword1', role: 'CLIENT', client_id: other.id }, adminT);
  await call('POST', '/api/users', { username: 'accounts', password: 'realpassword1', role: 'FINANCE' }, adminT);
  clientT = await login('meridian', 'realpassword1'); otherT = await login('otherco', 'realpassword1'); finT = await login('accounts', 'realpassword1');
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); fake.close(); });

const LINES = [
  { description: 'Static guarding', kind: 'HOURLY', rate: 20, est_quantity: 160 },
  { description: 'Mobile patrol', kind: 'FIXED_PERIOD', rate: 100 },
  { description: 'Set-up and site survey', kind: 'ONE_OFF', rate: 50 },
];

test('a quote is made on a site, sent to the client, and accepted in their portal — only by that client', async () => {
  assert.equal((await call('POST', '/api/agreements', { kind: 'QUOTE', site_id: siteA.id, lines: LINES }, dispT)).status, 403, 'admins only');
  const q = (await call('POST', '/api/agreements', { kind: 'QUOTE', site_id: siteA.id, lines: LINES }, adminT));
  assert.equal(q.status, 201, JSON.stringify(q.body));
  assert.equal(q.body.client_id, client.id, 'the client comes from the site');
  assert.equal(q.body.estimate.per_period, 3300);
  assert.equal((await call('GET', '/api/client/agreements', undefined, clientT)).body.length, 0, 'a draft is not in the portal');
  assert.equal((await call('GET', `/api/agreements?site_id=${siteA.id}`, undefined, adminT)).body.length, 1, 'saved on the site');

  const sent = await call('POST', `/api/agreements/${q.body.id}/send`, {}, adminT);
  assert.equal(sent.body.status, 'SENT');
  assert.equal((await call('PATCH', `/api/agreements/${q.body.id}`, { title: 'x' }, adminT)).status, 409, 'locked once sent');
  const mine = (await call('GET', '/api/client/agreements', undefined, clientT)).body;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].internal_notes, undefined);
  assert.equal((await call('GET', '/api/client/agreements', undefined, otherT)).body.length, 0, 'another client sees nothing');
  assert.equal((await call('POST', `/api/client/agreements/${q.body.id}/accept`, { name: 'Sneaky' }, otherT)).status, 404);
  assert.equal((await call('POST', `/api/client/agreements/${q.body.id}/accept`, { name: 'Admin' }, adminT)).status, 403, 'an admin cannot accept for the client');
  const pdf = await call('GET', `/api/client/agreements/${q.body.id}/pdf`, undefined, clientT, true);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');

  const acc = await call('POST', `/api/client/agreements/${q.body.id}/accept`, { name: 'Sam Patel' }, clientT);
  assert.equal(acc.body.status, 'ACCEPTED');
  assert.equal((await call('POST', `/api/client/agreements/${q.body.id}/decline`, {}, clientT)).status, 409, 'already answered');
});

test('a quote can be declined with a reason, and an out-of-date one cannot be accepted', async () => {
  const q = (await call('POST', '/api/agreements', { kind: 'QUOTE', site_id: siteA.id, lines: LINES }, adminT)).body;
  await call('POST', `/api/agreements/${q.id}/send`, {}, adminT);
  const d = await call('POST', `/api/client/agreements/${q.id}/decline`, { reason: 'Too dear' }, clientT);
  assert.equal(d.body.status, 'DECLINED');
  assert.equal(d.body.decline_reason, 'Too dear');

  const old = (await call('POST', '/api/agreements', { kind: 'QUOTE', site_id: siteA.id, lines: LINES, valid_until: '2020-01-01' }, adminT)).body;
  await call('POST', `/api/agreements/${old.id}/send`, {}, adminT);
  assert.equal((await call('GET', `/api/agreements/${old.id}`, undefined, adminT)).body.status, 'EXPIRED');
  assert.equal((await call('POST', `/api/client/agreements/${old.id}/accept`, { name: 'Sam' }, clientT)).status, 410);
});

let contract;
test('an accepted quote becomes a contract the client must sign', async () => {
  const q = app.db.agreements.find((a) => a.kind === 'QUOTE' && a.status === 'ACCEPTED');
  const c = await call('POST', `/api/agreements/${q.id}/convert`, {}, adminT);
  assert.equal(c.status, 201);
  assert.equal(c.body.kind, 'CONTRACT');
  assert.equal(c.body.lines.length, 3);
  assert.equal((await call('POST', `/api/agreements/${q.id}/convert`, {}, adminT)).status, 409, 'only one contract per quote');
  await call('PATCH', `/api/agreements/${c.body.id}`, { start_date: '2026-08-01' }, adminT);
  await call('POST', `/api/agreements/${c.body.id}/send`, {}, adminT);
  const url = `/api/client/agreements/${c.body.id}/sign`;
  assert.equal((await call('POST', `/api/client/agreements/${c.body.id}/accept`, { name: 'x' }, clientT)).status, 400, 'contracts are signed, not accepted');
  assert.equal((await call('POST', url, { signed_name: 'Sam Patel', agreed: true }, clientT)).status, 400, 'needs a signature');
  assert.equal((await call('POST', url, { signed_name: 'Sam Patel', signature: { mimetype: 'image/jpeg', data: JPEG } }, clientT)).status, 400, 'needs the terms agreed');
  const s = await call('POST', url, { signed_name: 'Sam Patel', position: 'FM', agreed: true, signature: { mimetype: 'image/jpeg', data: JPEG } }, clientT);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.status, 'SIGNED');
  contract = app.db.agreements.find((a) => a.id === c.body.id);
  assert.ok(contract.terms_snapshot.includes('Late Payment'), 'the terms it was signed under are kept');
  const pdf = await call('GET', `/api/agreements/${contract.id}/pdf`, undefined, adminT, true);
  assert.ok((await pdf.arrayBuffer()).byteLength > 1000);
  assert.equal(contract.pdf_file, 'signed.pdf');
});

/* Shifts at the contract's site in August 2026 — one fully clocked with a
 * break, one with no clock-out, one at another site (not charged). */
function addShift(siteId, day, startH, hours, clock) {
  const id = app.seq.shifts = (app.seq.shifts || 0) + 1;
  const starts = new Date(`2026-08-${day}T${String(startH).padStart(2, '0')}:00:00Z`);
  const s = { id, site_id: siteId, shift_type_id: app.db.shift_types[0].id, status: 'PUBLISHED', starts_at: starts.toISOString(), ends_at: new Date(starts.getTime() + hours * 3600e3).toISOString(), break_minutes: 30 };
  app.db.shifts.push(s);
  const aid = app.seq.shift_assignments = (app.seq.shift_assignments || 0) + 1;
  const a = { id: aid, shift_id: id, personnel_id: app.db.personnel[0].id, status: 'CONFIRMED', ...clock };
  app.db.shift_assignments.push(a);
  return { s, a };
}

test('invoices come from the signed contract and the hours worked at its site', async () => {
  addShift(siteA.id, '03', 8, 8, { clocked_in_at: '2026-08-03T08:00:00Z', clocked_out_at: '2026-08-03T16:00:00Z', breaks: [{ start: '2026-08-03T12:00:00Z', end: '2026-08-03T12:30:00Z' }] });
  addShift(siteA.id, '04', 8, 8, { clocked_in_at: '2026-08-04T08:00:00Z' });
  addShift(siteB.id, '05', 8, 8, { clocked_in_at: '2026-08-05T08:00:00Z', clocked_out_at: '2026-08-05T16:00:00Z' });

  assert.equal((await call('POST', '/api/invoices/generate', { from: '2026-08-01', to: '2026-08-31' }, dispT)).status, 403, 'not for dispatchers');
  const g = await call('POST', '/api/invoices/generate', { from: '2026-08-01', to: '2026-08-31' }, finT);
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.equal(g.body.made.length, 1);
  const inv = g.body.made[0];
  const hourly = inv.lines.find((l) => l.kind === 'HOURLY');
  assert.equal(hourly.quantity, 7.5, '8 hours less the 30 minute break; no clock-out counts 0');
  assert.equal(hourly.shifts.length, 2, 'only shifts at the contract site');
  assert.ok(inv.checks.some((c) => /no clock-out/.test(c)));
  assert.ok(inv.lines.some((l) => l.kind === 'FIXED_PERIOD' && l.unit_amount === 100));
  assert.ok(inv.lines.some((l) => l.kind === 'ONE_OFF'), 'the one-off goes on the first invoice');
  assert.equal(inv.subtotal, 7.5 * 20 + 100 + 50);
  assert.equal(inv.vat, 60);
  assert.equal(inv.total, 360);
  assert.equal(inv.due_date, new Date(Date.parse(inv.issue_date) + 30 * 864e5).toISOString().slice(0, 10));

  const again = await call('POST', '/api/invoices/generate', { from: '2026-08-15', to: '2026-09-14' }, adminT);
  assert.equal(again.body.made.length, 0);
  assert.match(again.body.skipped[0].reason, /already invoiced/);

  const sept = await call('POST', '/api/invoices/generate', { from: '2026-09-01', to: '2026-09-30' }, adminT);
  assert.equal(sept.body.made.length, 1);
  assert.ok(!sept.body.made[0].lines.some((l) => l.kind === 'ONE_OFF'), 'the one-off is charged once only');
  await call('POST', `/api/invoices/${sept.body.made[0].id}/void`, {}, adminT);

  // A rostered contract on the other site charges rostered hours less the unpaid break.
  const r = (await call('POST', '/api/agreements', { kind: 'CONTRACT', site_id: siteB.id, lines: [LINES[0]], billing_basis: 'ROSTERED', start_date: '2026-08-01' }, adminT)).body;
  await call('POST', `/api/agreements/${r.id}/send`, {}, adminT);
  await call('POST', `/api/client/agreements/${r.id}/sign`, { signed_name: 'O', agreed: true, signature: { mimetype: 'image/jpeg', data: JPEG } }, otherT);
  const rg = await call('POST', '/api/invoices/generate', { from: '2026-08-01', to: '2026-08-31', contract_id: r.id }, adminT);
  assert.equal(rg.body.made[0].lines[0].quantity, 7.5);
});

test('a draft is checked and edited, approved, sent to Xero, and its payment read back', async () => {
  const inv = app.db.invoices.find((i) => i.contract_id === contract.id && i.status === 'DRAFT');
  const lines = inv.lines.map((l) => ({ id: l.id, description: l.description, quantity: l.kind === 'HOURLY' ? 15.5 : l.quantity, unit_amount: l.unit_amount }));
  lines.push({ description: 'Extra cover 20 Aug', quantity: 4, unit_amount: 20 });
  const ed = await call('PATCH', `/api/invoices/${inv.id}`, { lines }, finT);
  assert.equal(ed.status, 200, JSON.stringify(ed.body));
  assert.equal(ed.body.subtotal, 15.5 * 20 + 100 + 50 + 80);
  assert.ok(ed.body.lines.find((l) => l.kind === 'HOURLY').shifts, 'the timesheet stays with the edited line');

  assert.equal((await call('POST', `/api/invoices/${inv.id}/xero`, {}, adminT)).status, 409, 'approve first');
  assert.equal((await call('POST', `/api/invoices/${inv.id}/approve`, {}, finT)).body.status, 'APPROVED');
  assert.equal((await call('PATCH', `/api/invoices/${inv.id}`, { notes: 'x' }, adminT)).status, 409, 'locked once approved');

  const notConnected = await call('POST', `/api/invoices/${inv.id}/xero`, {}, adminT);
  assert.equal(notConnected.status, 502);
  assert.match(notConnected.body.error, /Connect to Xero/);

  // Connect: only admins; the callback is tied to the state it was given.
  assert.equal((await call('GET', '/api/xero/connect', undefined, finT)).status, 403);
  const { url } = (await call('GET', '/api/xero/connect', undefined, adminT)).body;
  const state = new URL(url).searchParams.get('state');
  assert.ok(url.startsWith(`${XBASE}/identity/connect/authorize?`));
  assert.equal(new URL(url).searchParams.get('redirect_uri'), 'https://comms.echeloncic.com/api/xero/callback');
  const forged = await call('GET', '/api/xero/callback?code=good-code&state=made-up', undefined, undefined, true);
  assert.match(forged.headers.get('location'), /expired/);
  const back = await call('GET', `/api/xero/callback?code=good-code&state=${state}`, undefined, undefined, true);
  assert.equal(back.status, 302);
  assert.equal(back.headers.get('location'), '/invoices.html?xero=connected');
  const replay = await call('GET', `/api/xero/callback?code=good-code&state=${state}`, undefined, undefined, true);
  assert.match(replay.headers.get('location'), /expired/, 'a state works once');
  const st = (await call('GET', '/api/xero/status', undefined, finT)).body;
  assert.equal(st.connected, true);
  assert.equal(st.tenant_name, 'Echelon Test Ltd');
  assert.equal(JSON.stringify(st).includes('rt-'), false, 'tokens never leave the server');

  const sent = await call('POST', `/api/invoices/${inv.id}/xero`, {}, finT);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.status, 'IN_XERO');
  assert.equal(sent.body.xero.number, 'INV-0001');
  const x = X.invoices[0];
  assert.equal(x.Type, 'ACCREC');
  assert.equal(x.Reference, inv.contract_reference);
  assert.equal(x.InvoiceNumber, 'INV-0001', 'the same number in Xero as on our invoice');
  assert.equal(x.Status, 'DRAFT');
  assert.equal(x.LineItems.length, 4);
  assert.equal(x.LineItems[0].AccountCode, '200');
  assert.equal(x.LineItems[0].TaxType, 'OUTPUT2');
  assert.equal(x.Contact.ContactID, 'contact-1');
  assert.equal(client.id, app.db.clients.find((c) => c.xero_contact_id === 'contact-1').id, 'the Xero contact is remembered');
  assert.equal((await call('POST', `/api/invoices/${inv.id}/void`, {}, adminT)).status, 409, 'void it in Xero instead');

  // Expired access token: refreshed before the call, and the new refresh token kept.
  const row = app.db.ui_settings.find((r) => r.key === 'xero');
  row.expires_at = Date.now() - 1000;
  X.invoices[0].Status = 'PAID'; X.invoices[0].AmountDue = 0; X.invoices[0].AmountPaid = X.invoices[0].Total;
  const sync = await call('POST', `/api/invoices/${inv.id}/xero-sync`, {}, adminT);
  assert.equal(sync.status, 200, JSON.stringify(sync.body));
  assert.equal(sync.body.status, 'PAID');
  assert.equal(X.tokens.at(-1), 'refresh_token');
  assert.equal(row.refresh_token, `rt-${X.tokens.length}`);

  // A second invoice for the same client reuses the Xero contact.
  const other = app.db.invoices.find((i) => i.contract_id !== contract.id && i.status === 'DRAFT');
  await call('POST', `/api/invoices/${other.id}/approve`, {}, adminT);
  await call('PUT', '/api/xero/settings', { invoice_status: 'AUTHORISED' }, adminT);
  const s2 = await call('POST', `/api/invoices/${other.id}/xero`, {}, adminT);
  assert.equal(s2.status, 200, JSON.stringify(s2.body));
  assert.equal(X.invoices[1].Status, 'AUTHORISED');
  assert.equal(X.contacts.length, 2, 'Other Co is a new contact; Meridian was not created twice');
});

test('the menu offers quotes & contracts to admins and invoices to admins and finance', async () => {
  const keys = async (t) => (await call('GET', '/api/ui/sections', undefined, t)).body.map((s) => s.key);
  assert.ok((await keys(adminT)).includes('contracts'));
  assert.ok((await keys(finT)).includes('invoices'));
  assert.ok(!(await keys(finT)).includes('contracts'));
  assert.ok(!(await keys(dispT)).includes('invoices'));
  assert.equal((await call('GET', '/api/invoices', undefined, dispT)).status, 403);
  assert.equal((await call('GET', '/api/agreements', undefined, finT)).status, 403);
});

const settle = () => new Promise((r) => setTimeout(r, 60));
const isPdf = (att) => att && att.contentType === 'application/pdf' && Buffer.from(att.content).subarray(0, 4).toString() === '%PDF';

test('quotes and contracts are emailed to the client with the PDF — when sent, accepted and signed', async () => {
  await settle();
  const kinds = mails.filter((m) => m.to === 'fm@meridian.example').map((m) => m.subject);
  assert.ok(kinds.some((k) => /^Quotation QUO-/.test(k)), 'quote sent');
  assert.ok(kinds.some((k) => /accepted/.test(k)), 'acceptance confirmed');
  assert.ok(kinds.some((k) => /^Contract CON-/.test(k)), 'contract sent');
  assert.ok(kinds.some((k) => /signed contract/.test(k)), 'signed copy');
  for (const m of mails.filter((x) => x.to === 'fm@meridian.example')) assert.ok(isPdf(m.attachments[0]), `${m.subject} has the PDF attached`);
  const signed = mails.find((m) => /signed contract/.test(m.subject));
  assert.ok(signed.attachments[0].content.length > 2000, 'the signed version, with the signature');
  assert.ok(contract.emails.some((e) => e.kind === 'SIGNED' && e.ok));
  assert.equal((await call('GET', '/api/client/agreements', undefined, clientT)).body[0].emails, undefined, 'the email log is not shown to the client');

  const q = (await call('POST', '/api/agreements', { kind: 'QUOTE', site_id: siteA.id, lines: [{ description: 'No price', kind: 'ONE_OFF' }] }, adminT));
  assert.equal(q.status, 400, 'a line with no rate is refused, not priced at £0');
});

test('approved invoices get the next number, are emailed to the billing address with the PDF, and appear in the portal', async () => {
  await call('PATCH', `/api/clients/${client.id}`, { billing_email: 'accounts@meridian.example', billing_address: '1 High St\nLeeds' }, adminT);
  const st = await call('PUT', '/api/invoices/settings', { prefix: 'ECH-', next_number: 120, sort_code: '12-34-56', account_number: '12345678', bank_name: 'Lloyds', vat_number: 'GB123456789' }, adminT);
  assert.equal(st.status, 200, JSON.stringify(st.body));
  assert.equal((await call('PUT', '/api/invoices/settings', { prefix: 'ECH-' }, finT)).status, 403, 'settings are for admins');
  assert.equal((await call('PUT', '/api/invoices/settings', { sort_code: '12' }, adminT)).status, 400);

  const g = (await call('POST', '/api/invoices/generate', { from: '2026-10-01', to: '2026-10-31', contract_id: contract.id }, adminT)).body;
  const inv = g.made[0];
  assert.equal(inv.number, undefined, 'a draft has no number');
  assert.ok(!(await call('GET', '/api/client/invoices', undefined, clientT)).body.some((x) => x.id === inv.id), 'drafts are not in the portal');
  const draftPdf = await call('GET', `/api/invoices/${inv.id}/pdf`, undefined, finT, true);
  assert.equal(Buffer.from(await draftPdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');

  const before = mails.length;
  const a = (await call('POST', `/api/invoices/${inv.id}/approve`, {}, adminT)).body;
  assert.equal(a.number, 'ECH-0120');
  await settle();
  const m = mails.slice(before).find((x) => /ECH-0120/.test(x.subject));
  assert.ok(m, 'emailed on approval');
  assert.equal(m.to, 'accounts@meridian.example', 'to the billing email');
  assert.ok(isPdf(m.attachments[0]));
  assert.match(m.html, /12345678/);
  assert.ok(app.db.invoices.find((i) => i.id === inv.id).emails[0].ok);

  const portal = (await call('GET', '/api/client/invoices', undefined, clientT)).body;
  assert.equal(portal.length >= 1, true);
  const row = portal.find((x) => x.number === 'ECH-0120');
  assert.equal(row.paid, false);
  assert.equal((await call('GET', `${row.pdf_url}`, undefined, clientT, true)).status, 200);
  assert.equal((await call('GET', `${row.pdf_url}`, undefined, otherT, true)).status, 404, 'not another client\'s');

  // Paid by bank transfer, no Xero involved.
  assert.equal((await call('POST', `/api/invoices/${inv.id}/paid`, { note: 'BACS' }, finT)).body.status, 'PAID');
  assert.equal((await call('GET', '/api/client/invoices', undefined, clientT)).body.find((x) => x.number === 'ECH-0120').paid, true);

  // "Nobody" sends: approving does not email.
  await call('PUT', '/api/invoices/settings', { send_via: 'NONE' }, adminT);
  const g2 = (await call('POST', '/api/invoices/generate', { from: '2026-11-01', to: '2026-11-30', contract_id: contract.id }, adminT)).body.made[0];
  const n = mails.length;
  assert.equal((await call('POST', `/api/invoices/${g2.id}/approve`, {}, adminT)).body.number, 'ECH-0121');
  await settle();
  assert.equal(mails.length, n);
  // Xero sends: it goes in approved and Xero is asked to email it.
  await call('PUT', '/api/invoices/settings', { send_via: 'XERO' }, adminT);
  await call('PUT', '/api/xero/settings', { invoice_status: 'DRAFT' }, adminT);
  const r = await call('POST', `/api/invoices/${g2.id}/xero`, {}, adminT);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const x = X.invoices.at(-1);
  assert.equal(x.Status, 'AUTHORISED');
  assert.equal(x.InvoiceNumber, 'ECH-0121');
  assert.deepEqual(X.emailed, [x.InvoiceID]);
});

test('a payment recorded in Xero shows here without anyone pressing anything', async () => {
  const inv = app.db.invoices.find((i) => i.number === 'ECH-0121');
  assert.equal(inv.status, 'IN_XERO');
  const x = X.invoices.find((i) => i.InvoiceID === inv.xero.invoice_id);
  x.Status = 'PAID'; x.AmountDue = 0; x.AmountPaid = x.Total;
  const r = await call('POST', '/api/invoices/xero-sync-all', {}, finT);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.paid, 1);
  assert.equal(inv.status, 'PAID');
  assert.ok(inv.history.some((h) => h.by === 'Xero' && /paid/.test(h.what)));
  assert.ok(X.calls.some((c) => c === 'GET /api.xro/2.0/Invoices'), 'checked in one batch');
  assert.equal((await call('GET', '/api/client/invoices', undefined, clientT)).body.find((i) => i.number === 'ECH-0121').paid, true, 'and the client sees it paid');
});

test('an admin can mark a quote accepted when the client said yes outside the portal', async () => {
  const q = (await call('POST', '/api/agreements', { kind: 'QUOTE', site_id: siteA.id, lines: LINES }, adminT)).body;
  const url = `/api/agreements/${q.id}/mark-accepted`;
  assert.equal((await call('POST', url, { name: 'Sam' }, clientT)).status, 403);
  assert.equal((await call('POST', url, {}, adminT)).status, 400, 'who accepted it is needed');
  const before = mails.length;
  const r = await call('POST', url, { name: 'Sam Patel', how: 'PHONE', note: 'call 3 Oct' }, adminT);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'ACCEPTED');
  assert.equal(r.body.accepted_via, 'PHONE');
  assert.equal(r.body.accepted_recorded_by, 'System Admin');
  await new Promise((res) => setTimeout(res, 60));
  assert.ok(mails.slice(before).some((m) => /accepted/.test(m.subject)), 'the client is sent a confirmation');
  assert.equal((await call('POST', url, { name: 'x' }, adminT)).status, 409, 'once only');
  assert.equal((await call('POST', `/api/agreements/${q.id}/convert`, {}, adminT)).status, 201, 'and it can become a contract');
});
