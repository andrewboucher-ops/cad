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

const GCPORT = 4037, GCBASE = `http://127.0.0.1:${GCPORT}`;
process.env.GOCARDLESS_ACCESS_TOKEN = 'test-gc-token';
process.env.GOCARDLESS_WEBHOOK_SECRET = 'test-gc-webhook-secret';
process.env.GOCARDLESS_API_BASE = GCBASE;

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
      if (u.searchParams.has('InvoiceNumbers')) {
        const nums = u.searchParams.get('InvoiceNumbers').split(',');
        return send(200, { Invoices: X.invoices.filter((i) => nums.includes(i.InvoiceNumber)) });
      }
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

/* ---- a fake GoCardless: just the endpoints gocardless.js uses ---- */
const GC = { billingRequests: [], flows: [], payments: [] };
const fakeGC = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const u = new URL(req.url, GCBASE);
    if (req.headers.authorization !== 'Bearer test-gc-token') return send(401, { error: { message: 'invalid token' } });
    const body = raw ? JSON.parse(raw) : {};
    if (u.pathname === '/billing_requests' && req.method === 'POST') {
      const id = `BRQ${GC.billingRequests.length + 1}`;
      const br = { id, mandate_request: { ...body.billing_requests.mandate_request, links: {} }, links: body.billing_requests.links || {} };
      GC.billingRequests.push(br);
      return send(201, { billing_requests: br });
    }
    const getBR = u.pathname.match(/^\/billing_requests\/([^/]+)$/);
    if (getBR && req.method === 'GET') {
      const br = GC.billingRequests.find((x) => x.id === getBR[1]);
      return br ? send(200, { billing_requests: br }) : send(404, { error: { message: 'not found' } });
    }
    if (u.pathname === '/billing_request_flows' && req.method === 'POST') {
      const id = `BRF${GC.flows.length + 1}`;
      const flow = { id, authorisation_url: `https://pay-sandbox.gocardless.com/billing/static/flow?id=${id}`, links: body.billing_request_flows.links };
      GC.flows.push(flow);
      return send(201, { billing_request_flows: flow });
    }
    if (u.pathname === '/payments' && req.method === 'POST') {
      const p = body.payments;
      if (p.links.mandate === 'MD-REJECT') return send(422, { error: { message: 'mandate_is_inactive' } });
      const id = `PM${GC.payments.length + 1}`;
      const payment = { id, status: 'pending_submission', amount: p.amount, currency: p.currency, reference: p.reference, links: { mandate: p.links.mandate } };
      GC.payments.push(payment);
      return send(201, { payments: payment });
    }
    send(404, { error: { message: 'no such fake endpoint' } });
  });
});
/** Signs a webhook body exactly as GoCardless would, for posting to CCCS's
 * own /api/webhooks/gocardless. */
function gcWebhookBody(events) {
  const raw = JSON.stringify({ events });
  const sig = require('crypto').createHmac('sha256', 'test-gc-webhook-secret').update(raw).digest('hex');
  return { raw, sig };
}

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
  await new Promise((r) => fakeGC.listen(GCPORT, '127.0.0.1', r));
  app.mailer.send = async (to, subject, html, opts = {}) => { mails.push({ to, subject, html, cc: opts.cc || [], bcc: opts.bcc || '', attachments: opts.attachments || [] }); return { ok: true }; };
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
after(() => { app.server.closeAllConnections?.(); app.server.close(); fake.close(); fakeGC.close(); });

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

test('hours worked on a client charge day (e.g. Christmas Day) are billed on their own line at the enhanced rate', async () => {
  // From the client charge days list (not payroll's), kept as its own line
  // rather than blended into one average.
  const id = app.seq.shifts = (app.seq.shifts || 0) + 1;
  app.db.shifts.push({ id, site_id: siteA.id, shift_type_id: app.db.shift_types[0].id, status: 'PUBLISHED',
    starts_at: '2026-12-25T08:00:00Z', ends_at: '2026-12-25T16:00:00Z', break_minutes: 0 });
  const aid = app.seq.shift_assignments = (app.seq.shift_assignments || 0) + 1;
  app.db.shift_assignments.push({ id: aid, shift_id: id, personnel_id: app.db.personnel[0].id, status: 'CONFIRMED',
    clocked_in_at: '2026-12-25T08:00:00Z', clocked_out_at: '2026-12-25T16:00:00Z', breaks: [] });

  const g = await call('POST', '/api/invoices/generate', { from: '2026-12-01', to: '2026-12-31' }, finT);
  assert.equal(g.status, 200, JSON.stringify(g.body));
  const inv = g.body.made.find((i) => i.site_id === siteA.id);
  assert.ok(inv, JSON.stringify(g.body));
  const hourlyLines = inv.lines.filter((l) => l.kind === 'HOURLY');
  assert.equal(hourlyLines.length, 1, 'all the hours this period are on the rate day, so no separate normal-hours line');
  const xmasLine = hourlyLines[0];
  assert.match(xmasLine.description, /Christmas Day/);
  assert.equal(xmasLine.quantity, 8);
  assert.equal(xmasLine.unit_amount, 40, 'double the contract\'s £20/hour rate');
  assert.equal(xmasLine.amount, 320);
});

test('client charge days are their own list: editing staff pay days does not change what clients are charged', async () => {
  const charge = (await call('GET', '/api/invoices/rate-days', undefined, adminT)).body;
  assert.equal((await call('GET', '/api/invoices/rate-days', undefined, finT)).status, 403, 'admin only');
  const boxing = charge.find((d) => d.date === '2026-12-26');
  assert.equal(boxing && boxing.multiplier, 2, 'Boxing Day itself is double for clients, even on a Saturday');
  assert.equal(charge.find((d) => d.date === '2026-12-28').multiplier, 1.5, 'the substitute bank holiday is time and a half');
  const pay = (await call('GET', '/api/payroll/rate-days', undefined, adminT)).body;
  const payXmas = pay.find((d) => d.date === '2026-12-25');
  await call('PATCH', `/api/payroll/rate-days/${payXmas.id}`, { multiplier: 3 }, adminT);
  try {
    assert.equal(app.db.client_rate_days.find((d) => d.date === '2026-12-25').multiplier, 2);
    const add = await call('POST', '/api/invoices/rate-days', { date: '2026-11-11', label: 'Late-notice cover', kind: 'FLAT', flat_rate: 50 }, adminT);
    assert.equal(add.status, 201, JSON.stringify(add.body));
    assert.ok(!app.db.payroll_rate_days.some((d) => d.date === '2026-11-11'), 'not added to the staff pay list');
    assert.equal((await call('DELETE', `/api/invoices/rate-days/${add.body.id}`, {}, adminT)).status, 200);
  } finally {
    await call('PATCH', `/api/payroll/rate-days/${payXmas.id}`, { multiplier: 2 }, adminT);
  }
});

test('a per-assignment pay override only reaches the invoice when flagged bill_client, and replaces a rate day when it does', async () => {
  // Same shift_assignments.pay_override set from Rota — only the admin's
  // explicit bill_client flag decides whether the client is charged the
  // uplift; unset, it's purely an internal staffing-cost decision and
  // bills as plain normal hours, same as any other shift.
  const mk = (day, hours, override) => {
    const id = app.seq.shifts = (app.seq.shifts || 0) + 1;
    app.db.shifts.push({ id, site_id: siteA.id, shift_type_id: app.db.shift_types[0].id, status: 'PUBLISHED',
      starts_at: `2027-01-${day}T08:00:00Z`, ends_at: `2027-01-${day}T${String(8 + hours).padStart(2, '0')}:00:00Z`, break_minutes: 0 });
    const aid = app.seq.shift_assignments = (app.seq.shift_assignments || 0) + 1;
    app.db.shift_assignments.push({ id: aid, shift_id: id, personnel_id: app.db.personnel[0].id, status: 'CONFIRMED',
      clocked_in_at: `2027-01-${day}T08:00:00Z`, clocked_out_at: `2027-01-${day}T${String(8 + hours).padStart(2, '0')}:00:00Z`, breaks: [],
      pay_override: override });
  };
  mk('05', 4, { kind: 'MULTIPLIER', multiplier: 2, flat_rate: null, reason: 'late-notice cover', bill_client: true, set_by: 'Test Admin', set_at: new Date().toISOString() });
  mk('06', 4, { kind: 'FLAT', multiplier: null, flat_rate: 100, reason: 'internal cover decision', bill_client: false, set_by: 'Test Admin', set_at: new Date().toISOString() });

  const g = await call('POST', '/api/invoices/generate', { from: '2027-01-01', to: '2027-01-31', contract_id: contract.id }, adminT);
  assert.equal(g.status, 200, JSON.stringify(g.body));
  const inv = g.body.made[0];
  const hourlyLines = inv.lines.filter((l) => l.kind === 'HOURLY');
  assert.equal(hourlyLines.length, 2, 'one normal line (the unbilled override\'s hours included) and one billed-override line');

  const normal = hourlyLines.find((l) => /— hours,/.test(l.description));
  assert.ok(normal, JSON.stringify(inv.lines));
  assert.equal(normal.quantity, 4, 'the bill_client:false override still bills as plain normal hours');
  assert.equal(normal.unit_amount, 20, 'not the internal £100/h override rate — the client is never billed for it');

  const overrideLine = hourlyLines.find((l) => /pay override/.test(l.description));
  assert.ok(overrideLine, JSON.stringify(inv.lines));
  assert.equal(overrideLine.quantity, 4);
  assert.equal(overrideLine.unit_amount, 40, '×2 the contract\'s £20/hour rate');
  assert.match(overrideLine.description, /late-notice cover/);
});

test('generate can be narrowed to one site', async () => {
  // Both contracts (siteA and siteB, from the tests above) are running by
  // October, with nothing invoiced yet for it.
  const bySite = await call('POST', '/api/invoices/generate', { from: '2026-10-01', to: '2026-10-31', site_id: siteB.id }, adminT);
  assert.equal(bySite.status, 200, JSON.stringify(bySite.body));
  assert.equal(bySite.body.made.length, 1, 'only the one site\'s contract, not siteA\'s too');
  assert.equal(bySite.body.made[0].site_id, siteB.id);

  const noContractSite = (await call('POST', '/api/sites', { name: 'No Contract Site' }, adminT)).body;
  const none = await call('POST', '/api/invoices/generate', { from: '2026-10-01', to: '2026-10-31', site_id: noContractSite.id }, adminT);
  assert.equal(none.status, 400);
  assert.match(none.body.error, /no signed contract/);
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
  await call('PATCH', `/api/clients/${other.client_id}`, { billing_email: 'info@other.example, mark@other.example' }, adminT);
  // Xero already used this number (and the next) for invoices raised there.
  const clash = app.db.invoices.find((i) => i.id === other.id).number;
  const ist = app.db.ui_settings.find((r) => r.key === 'invoice').settings, nextUp = ist.next_number;
  const fmt = (n) => `${ist.prefix}${String(n).padStart(ist.digits, '0')}`;
  X.invoices.push({ InvoiceID: 'old-1', InvoiceNumber: clash, Status: 'PAID' }, { InvoiceID: 'old-2', InvoiceNumber: fmt(nextUp), Status: 'AUTHORISED' });
  const s2 = await call('POST', `/api/invoices/${other.id}/xero`, {}, adminT);
  assert.equal(s2.status, 200, JSON.stringify(s2.body));
  assert.equal(s2.body.number, fmt(nextUp + 1), 'moved past the numbers Xero already has');
  assert.equal(app.db.ui_settings.find((r) => r.key === 'invoice').settings.next_number, nextUp + 2, 'numbering carries on after it');
  assert.ok(s2.body.history.some((h) => /renumbered/.test(h.what)));
  X.invoices.splice(X.invoices.findIndex((i) => i.InvoiceID === 'old-1'), 1);
  X.invoices.splice(X.invoices.findIndex((i) => i.InvoiceID === 'old-2'), 1);
  assert.equal(X.invoices[1].Status, 'AUTHORISED');
  assert.equal(X.contacts.length, 2, 'Other Co is a new contact; Meridian was not created twice');
  const oc = X.contacts.find((c) => c.Name === 'Other Co');
  assert.equal(oc.EmailAddress, 'info@other.example', 'Xero gets one email address on the contact');
  assert.deepEqual(oc.ContactPersons.map((p) => [p.EmailAddress, p.IncludeInEmails]), [['mark@other.example', true]], 'the rest are copied on Xero emails');
});

test('an admin can renumber an approved invoice that is not in Xero yet, and numbering carries on from it', async () => {
  const d = app.db.invoices.find((i) => i.status === 'DRAFT' && i.lines.length && i.total > 0)
    || (await call('POST', '/api/invoices/generate', { from: '2026-11-01', to: '2026-11-30', contract_id: contract.id }, adminT)).body.made[0];
  const a = (await call('POST', `/api/invoices/${d.id}/approve`, {}, adminT)).body;
  const ist = app.db.ui_settings.find((r) => r.key === 'invoice').settings;
  const target = `${ist.prefix}${String(ist.next_number + 40).padStart(ist.digits, '0')}`;
  assert.equal((await call('POST', `/api/invoices/${a.id}/renumber`, { number: target }, finT)).status, 403, 'admins only');
  assert.equal((await call('POST', `/api/invoices/${a.id}/renumber`, { number: 'bad number!' }, adminT)).status, 400);
  const taken = app.db.invoices.find((i) => i.number && i.id !== a.id).number;
  assert.equal((await call('POST', `/api/invoices/${a.id}/renumber`, { number: taken }, adminT)).status, 409, 'no duplicates');
  const r = await call('POST', `/api/invoices/${a.id}/renumber`, { number: target }, adminT);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.number, target);
  const after = app.db.ui_settings.find((x) => x.key === 'invoice').settings;
  assert.equal(`${after.prefix}${String(after.next_number - 1).padStart(after.digits, '0')}`, target, 'next number follows it');
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
  const st = await call('PUT', '/api/invoices/settings', { prefix: 'ECH-', next_number: 120, sort_code: '12-34-56', account_number: '12345678', bank_name: 'Lloyds', vat_number: 'GB123456789', copy_to: 'office@echelon.example; boss@echelon.example' }, adminT);
  assert.equal(st.status, 200, JSON.stringify(st.body));
  assert.equal((await call('PUT', '/api/invoices/settings', { prefix: 'ECH-' }, finT)).status, 403, 'settings are for admins');
  assert.equal((await call('PUT', '/api/invoices/settings', { sort_code: '12' }, adminT)).status, 400);
  assert.equal((await call('PUT', '/api/invoices/settings', { copy_to: 'not-an-email' }, adminT)).status, 400);
  assert.equal(st.body.copy_to, 'office@echelon.example, boss@echelon.example');

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
  assert.equal(m.bcc, 'office@echelon.example, boss@echelon.example', 'a copy goes to the office');
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

test('an admin can mark a contract signed when it was agreed outside the portal — e.g. migrating an existing paper contract', async () => {
  // No `lines` key at all — not `lines: []`, which the base create route
  // itself already rejects — to reach a real DRAFT with none yet, same as
  // one freshly created and never touched.
  const draft = (await call('POST', '/api/agreements', { kind: 'CONTRACT', site_id: siteB.id }, adminT)).body;
  const url = `/api/agreements/${draft.id}/mark-signed`;
  assert.equal((await call('POST', url, { name: 'Jo' }, clientT)).status, 403, 'admins only');
  assert.equal((await call('POST', url, { name: 'Jo' }, adminT)).status, 400, 'needs at least one line');
  await call('PATCH', `/api/agreements/${draft.id}`, { lines: [LINES[0]] }, adminT);
  assert.equal((await call('POST', url, { name: 'Jo' }, adminT)).status, 400, 'needs a start date');
  await call('PATCH', `/api/agreements/${draft.id}`, { start_date: '2024-01-01' }, adminT);
  assert.equal((await call('POST', url, {}, adminT)).status, 400, 'who signed it is needed');
  assert.equal((await call('POST', url, { name: 'Jo Bloggs', signed_at: '2099-01-01' }, adminT)).status, 400, 'cannot be in the future');

  const before = mails.length;
  const r = await call('POST', url, { name: 'Jo Bloggs', position: 'Ops Manager', how: 'LETTER', signed_at: '2024-01-15', note: 'migrating existing paper contract' }, adminT);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'SIGNED');
  assert.equal(r.body.signed_name, 'Jo Bloggs');
  assert.equal(r.body.signed_via, 'LETTER');
  assert.equal(r.body.signed_recorded_by, 'System Admin');
  assert.equal(r.body.signed_at.slice(0, 10), '2024-01-15', 'backdated to when it was actually agreed, not today');
  await new Promise((res) => setTimeout(res, 60));
  assert.equal(mails.length, before, 'no email unless explicitly asked for — this is a formality, not fresh outreach');

  assert.equal((await call('POST', url, { name: 'x' }, adminT)).status, 409, 'once only — already signed');
  const pdf = await call('GET', `/api/agreements/${draft.id}/pdf`, undefined, adminT, true);
  assert.equal(pdf.status, 200, 'the PDF is still generated for a recorded signing, not just a real online one');
});

test('mark-signed can email a copy when asked, and refuses a quote', async () => {
  // siteA's client (Meridian Estates) has a contact_email on file; siteB's
  // (Other Co) deliberately doesn't, used above to prove the no-lines path
  // without the unrelated "no contact email" message getting in the way.
  const a = (await call('POST', '/api/agreements', { kind: 'CONTRACT', site_id: siteA.id, lines: [LINES[0]], start_date: '2026-01-01' }, adminT)).body;
  const before = mails.length;
  await call('POST', `/api/agreements/${a.id}/mark-signed`, { name: 'Pat', notify: true }, adminT);
  await new Promise((res) => setTimeout(res, 60));
  assert.ok(mails.slice(before).some((m) => /signed/i.test(m.subject)), 'emailed when notify is explicitly true');

  const q = (await call('POST', '/api/agreements', { kind: 'QUOTE', site_id: siteA.id, lines: LINES }, adminT)).body;
  assert.equal((await call('POST', `/api/agreements/${q.id}/mark-signed`, { name: 'x' }, adminT)).status, 400, 'a quote is accepted, not signed');
});

test('a withdrawn contract disappears from the client portal — it was taken back before it ever went live for them', async () => {
  const a = (await call('POST', '/api/agreements', { kind: 'CONTRACT', site_id: siteA.id, lines: [LINES[0]], start_date: '2026-01-01' }, adminT)).body;
  await call('POST', `/api/agreements/${a.id}/send`, {}, adminT);
  const seenBeforeWithdraw = (await call('GET', '/api/client/agreements', undefined, clientT)).body;
  assert.ok(seenBeforeWithdraw.some((x) => x.id === a.id), 'visible once sent, same as any other');

  const withdrawn = await call('POST', `/api/agreements/${a.id}/withdraw`, {}, adminT);
  assert.equal(withdrawn.body.status, 'WITHDRAWN');
  const seenAfterWithdraw = (await call('GET', '/api/client/agreements', undefined, clientT)).body;
  assert.ok(!seenAfterWithdraw.some((x) => x.id === a.id), 'gone from the list once withdrawn');
  assert.equal((await call('GET', `/api/client/agreements/${a.id}/pdf`, undefined, clientT)).status, 404, 'and not reachable directly by id either');
});

test('invoicing on the CLOCKED basis rounds the clocked span to the nearest 15 minutes in the company\'s favour — the opposite direction from payroll\'s rounding, since here the company bills the client rather than pays the worker', async () => {
  const site = (await call('POST', '/api/sites', { name: 'Rounding Test Site' }, adminT)).body;
  await call('POST', '/api/clients', { name: 'Rounding Test Client', site_ids: [site.id] }, adminT);
  const contract = (await call('POST', '/api/agreements', {
    kind: 'CONTRACT', site_id: site.id, lines: [{ description: 'Static guarding', kind: 'HOURLY', rate: 20, est_quantity: 160 }], start_date: '2026-08-01',
  }, adminT)).body;
  await call('POST', `/api/agreements/${contract.id}/mark-signed`, { name: 'Test' }, adminT);

  // 08:07 clock-in rounds DOWN to 08:00 (billing starts earlier — more
  // billable time); 16:53 clock-out rounds UP to 17:00 (billing ends
  // later — more again). Exact span would be 8h46m = £175.33 at £20/h;
  // rounded in the company's favour it's a clean 9.0h = £180.
  addShift(site.id, '20', 8, 8, { clocked_in_at: '2026-08-20T08:07:00Z', clocked_out_at: '2026-08-20T16:53:00Z' });

  const g = await call('POST', '/api/invoices/generate', { from: '2026-08-01', to: '2026-08-31', contract_id: contract.id }, adminT);
  assert.equal(g.status, 200, JSON.stringify(g.body));
  const inv = g.body.made[0];
  const hourly = inv.lines.find((l) => l.kind === 'HOURLY');
  assert.equal(hourly.quantity, 9, 'rounded up to a full 9 hours, not the exact 8h46m');
  assert.equal(inv.subtotal, 180);

  // attendance.worked() itself — what routes-payroll.js pays a worker
  // from — is untouched: the exact, unrounded span.
  const a = app.db.shift_assignments.find((x) => x.shift_id === app.db.shifts.find((s) => s.site_id === site.id).id);
  assert.equal(app.attendance.worked(a).worked_min, 526, 'payroll still sees the real 8h46m, not the bill-rounded figure');
});

/* ---------------- GoCardless Direct Debit ---------------- */

test('GoCardless: a client starts Direct Debit setup, the webhook confirms the mandate is active (never the browser redirect), and the portal reflects it', async () => {
  const start = await call('POST', '/api/client/gocardless/start', {}, clientT);
  assert.equal(start.status, 200, JSON.stringify(start.body));
  assert.match(start.body.authorisation_url, /pay-sandbox\.gocardless\.com/);

  const statusBefore = await call('GET', '/api/client/gocardless/status', undefined, clientT);
  assert.equal(statusBefore.body.mandate_status, 'pending');

  // Simulate the payer completing GoCardless's hosted flow: the billing
  // request now carries the resulting mandate id — this is exactly what
  // resolveClientForMandateEvent (routes-client.js) reads back, since the
  // webhook event itself never says which of our clients it's for.
  const br = GC.billingRequests.at(-1);
  br.mandate_request.links.mandate = 'MD1';
  br.links.customer = 'CU1';

  const { raw, sig } = gcWebhookBody([{ id: 'EV1', resource_type: 'mandates', action: 'active', links: { mandate: 'MD1' } }]);
  const wh = await fetch(BASE + '/api/webhooks/gocardless', { method: 'POST', headers: { 'content-type': 'application/json', 'webhook-signature': sig }, body: raw });
  assert.equal(wh.status, 200);

  const statusAfter = await call('GET', '/api/client/gocardless/status', undefined, clientT);
  assert.equal(statusAfter.body.mandate_status, 'active');
});

test('GoCardless webhook rejects a bad signature outright — never processed, never a 200', async () => {
  const wh = await fetch(BASE + '/api/webhooks/gocardless', {
    method: 'POST', headers: { 'content-type': 'application/json', 'webhook-signature': 'not-the-real-signature' }, body: JSON.stringify({ events: [] }),
  });
  assert.equal(wh.status, 498);
});

test('an admin can only collect via Direct Debit once the client has an active mandate, and the webhook — not the submit call itself — is what marks the invoice paid', async () => {
  const site = (await call('POST', '/api/sites', { name: 'GC Test Site' }, adminT)).body;
  const gcClient = (await call('POST', '/api/clients', { name: 'GC Test Client', site_ids: [site.id] }, adminT)).body;
  const contract = (await call('POST', '/api/agreements', {
    kind: 'CONTRACT', site_id: site.id, lines: [{ description: 'Static guarding', kind: 'FIXED_PERIOD', rate: 500 }], start_date: '2026-08-01',
  }, adminT)).body;
  await call('POST', `/api/agreements/${contract.id}/mark-signed`, { name: 'Test' }, adminT);
  const gen = await call('POST', '/api/invoices/generate', { from: '2026-08-01', to: '2026-08-31', contract_id: contract.id }, adminT);
  const inv = gen.body.made[0];
  await call('POST', `/api/invoices/${inv.id}/approve`, {}, adminT);

  const blocked = await call('POST', `/api/invoices/${inv.id}/direct-debit`, {}, adminT);
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /no active Direct Debit mandate/);

  // Give the client an active mandate directly, as if an earlier webhook
  // had already confirmed it (this test is about collection, not setup —
  // setup itself is covered above).
  app.db.clients.find((c) => c.id === gcClient.id).gocardless = { mandate_id: 'MD2', mandate_status: 'active', customer_id: 'CU2' };

  const collected = await call('POST', `/api/invoices/${inv.id}/direct-debit`, {}, adminT);
  assert.equal(collected.status, 200, JSON.stringify(collected.body));
  assert.ok(collected.body.gocardless.payment_id);
  assert.equal(collected.body.status, 'APPROVED', 'stays APPROVED until GoCardless actually confirms the payment — submitting is not the same as being paid');

  const dup = await call('POST', `/api/invoices/${inv.id}/direct-debit`, {}, adminT);
  assert.equal(dup.status, 409, 'already submitted — never collected twice');

  const { raw, sig } = gcWebhookBody([{ id: 'EV2', resource_type: 'payments', action: 'confirmed', links: { payment: collected.body.gocardless.payment_id } }]);
  const wh = await fetch(BASE + '/api/webhooks/gocardless', { method: 'POST', headers: { 'content-type': 'application/json', 'webhook-signature': sig }, body: raw });
  assert.equal(wh.status, 200);
  const after = await call('GET', `/api/invoices/${inv.id}`, undefined, adminT);
  assert.equal(after.body.status, 'PAID');
});

test('a Direct Debit collection failure is recorded on the invoice, not silently dropped', async () => {
  const site = (await call('POST', '/api/sites', { name: 'GC Fail Site' }, adminT)).body;
  const gcClient = (await call('POST', '/api/clients', { name: 'GC Fail Client', site_ids: [site.id] }, adminT)).body;
  const contract = (await call('POST', '/api/agreements', {
    kind: 'CONTRACT', site_id: site.id, lines: [{ description: 'Static guarding', kind: 'FIXED_PERIOD', rate: 500 }], start_date: '2026-08-01',
  }, adminT)).body;
  await call('POST', `/api/agreements/${contract.id}/mark-signed`, { name: 'Test' }, adminT);
  const gen = await call('POST', '/api/invoices/generate', { from: '2026-08-01', to: '2026-08-31', contract_id: contract.id }, adminT);
  const inv = gen.body.made[0];
  await call('POST', `/api/invoices/${inv.id}/approve`, {}, adminT);
  app.db.clients.find((c) => c.id === gcClient.id).gocardless = { mandate_id: 'MD-REJECT', mandate_status: 'active' };

  const collected = await call('POST', `/api/invoices/${inv.id}/direct-debit`, {}, adminT);
  assert.equal(collected.status, 502, JSON.stringify(collected.body));
  assert.match(collected.body.error, /mandate_is_inactive/);
});

/* ---------------- per-client invoice consolidation, monthly fixed
 * charges, and accounts-email CC ---------------- */

function pushShift(siteId, isoDate, startH, endH, personIdx = 0) {
  const id = app.seq.shifts = (app.seq.shifts || 0) + 1;
  app.db.shifts.push({
    id, site_id: siteId, shift_type_id: app.db.shift_types[0].id, status: 'PUBLISHED',
    starts_at: `${isoDate}T${String(startH).padStart(2, '0')}:00:00Z`, ends_at: `${isoDate}T${String(endH).padStart(2, '0')}:00:00Z`, break_minutes: 0,
  });
  const aid = app.seq.shift_assignments = (app.seq.shift_assignments || 0) + 1;
  app.db.shift_assignments.push({
    id: aid, shift_id: id, personnel_id: app.db.personnel[personIdx].id, status: 'CONFIRMED',
    clocked_in_at: `${isoDate}T${String(startH).padStart(2, '0')}:00:00Z`, clocked_out_at: `${isoDate}T${String(endH).padStart(2, '0')}:00:00Z`, breaks: [],
  });
}

let gc, gs1, gs2, gc1, gc2;
test('a client left on PER_CONTRACT (the default) still gets one invoice per contract', async () => {
  gs1 = (await call('POST', '/api/sites', { name: 'Grouping Site One' }, adminT)).body;
  gs2 = (await call('POST', '/api/sites', { name: 'Grouping Site Two' }, adminT)).body;
  gc = (await call('POST', '/api/clients', { name: 'Grouping Test Ltd', contact_email: 'g@example.test', site_ids: [gs1.id, gs2.id] }, adminT)).body;
  assert.equal(gc.invoice_grouping, 'PER_CONTRACT', 'defaults to per-contract');

  const mkContract = async (siteId) => {
    const c = (await call('POST', '/api/agreements', { kind: 'CONTRACT', site_id: siteId, lines: [LINES[0]], start_date: '2027-03-01' }, adminT)).body;
    await call('POST', `/api/agreements/${c.id}/mark-signed`, { name: 'Test' }, adminT);
    return c;
  };
  gc1 = await mkContract(gs1.id); gc2 = await mkContract(gs2.id);
  pushShift(gs1.id, '2027-03-10', 8, 16); pushShift(gs2.id, '2027-03-10', 8, 16, 1);

  const g = await call('POST', '/api/invoices/generate', { from: '2027-03-01', to: '2027-03-31' }, adminT);
  assert.equal(g.status, 200, JSON.stringify(g.body));
  const made = g.body.made.filter((i) => i.client_id === gc.id);
  assert.equal(made.length, 2, 'one invoice per contract, the default behaviour');
  assert.ok(made.every((i) => i.contract_ids.length === 1));
});

test('switching a client to PER_CLIENT combines every running contract into one invoice', async () => {
  await call('PATCH', `/api/clients/${gc.id}`, { invoice_grouping: 'PER_CLIENT' }, adminT);
  pushShift(gs1.id, '2027-04-10', 8, 16); pushShift(gs2.id, '2027-04-10', 8, 16, 1);

  const g = await call('POST', '/api/invoices/generate', { from: '2027-04-01', to: '2027-04-30' }, adminT);
  assert.equal(g.status, 200, JSON.stringify(g.body));
  const made = g.body.made.filter((i) => i.client_id === gc.id);
  assert.equal(made.length, 1, 'one combined invoice for the client');
  const inv = made[0];
  assert.deepEqual([...inv.contract_ids].sort((a, b) => a - b), [gc1.id, gc2.id].sort((a, b) => a - b));
  const siteNames = [...new Set(inv.lines.map((l) => l.site_name))].sort();
  assert.deepEqual(siteNames, ['Grouping Site One', 'Grouping Site Two'].sort());
});

test('a PER_CLIENT consolidation still skips a contract that already clashes, and bills the rest', async () => {
  // Bill contract one alone for May, so it already has a May invoice —
  // then ask for a combined May invoice: contract one clashes and is
  // skipped, contract two (never billed for May) is still billed.
  pushShift(gs1.id, '2027-05-10', 8, 16);
  const solo = await call('POST', '/api/invoices/generate', { from: '2027-05-01', to: '2027-05-31', contract_id: gc1.id }, adminT);
  assert.equal(solo.body.made.length, 1);

  pushShift(gs2.id, '2027-05-11', 8, 16, 1);
  const g = await call('POST', '/api/invoices/generate', { from: '2027-05-01', to: '2027-05-31' }, adminT);
  const made = g.body.made.filter((i) => i.client_id === gc.id);
  assert.equal(made.length, 1, 'still one invoice, for the non-clashing contract');
  assert.deepEqual(made[0].contract_ids, [gc2.id]);
  assert.ok(g.body.skipped.some((s) => s.reason && /already invoiced/.test(s.reason)));
});

test('a FIXED_PERIOD line bills once per calendar month, regardless of how many invoices are generated that month', async () => {
  // A fresh month the original contract has never been invoiced for.
  pushShift(siteA.id, '2027-06-03', 8, 12);
  const first = await call('POST', '/api/invoices/generate', { from: '2027-06-01', to: '2027-06-15', contract_id: contract.id }, adminT);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.ok(first.body.made[0].lines.some((l) => l.kind === 'FIXED_PERIOD'), 'the fixed line is on the first invoice this month');

  pushShift(siteA.id, '2027-06-20', 8, 12);
  const second = await call('POST', '/api/invoices/generate', { from: '2027-06-16', to: '2027-06-30', contract_id: contract.id }, adminT);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const inv2 = second.body.made[0];
  assert.ok(!inv2.lines.some((l) => l.kind === 'FIXED_PERIOD'), 'not repeated later the same month');
  assert.ok(inv2.checks.some((c) => /already billed this month/.test(c)));

  pushShift(siteA.id, '2027-07-05', 8, 12);
  const next = await call('POST', '/api/invoices/generate', { from: '2027-07-01', to: '2027-07-31', contract_id: contract.id }, adminT);
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.ok(next.body.made[0].lines.some((l) => l.kind === 'FIXED_PERIOD'), 'reappears the following month');
});

test('a site\'s accounts_email is CC\'d on its invoice email; a consolidated invoice CCs the union across its sites, deduplicated and blank-free', async () => {
  await call('PATCH', `/api/sites/${siteA.id}`, { accounts_email: 'accounts@meridian.example' }, adminT);
  pushShift(siteA.id, '2027-08-03', 8, 12);
  const g = await call('POST', '/api/invoices/generate', { from: '2027-08-01', to: '2027-08-31', contract_id: contract.id }, adminT);
  const inv = g.body.made[0];
  await call('POST', `/api/invoices/${inv.id}/approve`, {}, adminT);
  const before = mails.length;
  await call('POST', `/api/invoices/${inv.id}/email`, {}, adminT);
  assert.equal(mails.length, before + 1);
  assert.deepEqual(mails[mails.length - 1].cc, ['accounts@meridian.example']);

  // Consolidated: one site with an accounts email, one without — only the
  // one that has it is CC'd, deduplicated, no blank entry for the other.
  await call('PATCH', `/api/sites/${gs1.id}`, { accounts_email: 'ops@grouping.example' }, adminT);
  pushShift(gs1.id, '2027-09-03', 8, 12);
  pushShift(gs2.id, '2027-09-03', 8, 12, 1);
  const g2 = await call('POST', '/api/invoices/generate', { from: '2027-09-01', to: '2027-09-30' }, adminT);
  const combined = g2.body.made.find((i) => i.client_id === gc.id);
  assert.ok(combined, JSON.stringify(g2.body));
  await call('POST', `/api/invoices/${combined.id}/approve`, {}, adminT);
  const before2 = mails.length;
  await call('POST', `/api/invoices/${combined.id}/email`, {}, adminT);
  assert.deepEqual(mails[mails.length - 1].cc, ['ops@grouping.example'], 'only the site with an accounts email contributes one');
});

test('a sent or signed agreement is amended through a dedicated, audited endpoint — not the draft-only PATCH, and only once it has actually gone out', async () => {
  const site = (await call('POST', '/api/sites', { name: 'Amend Test Site' }, adminT)).body;
  await call('POST', '/api/clients', { name: 'Amend Test Client', contact_email: 'amend@example.test', site_ids: [site.id] }, adminT);

  const draft = (await call('POST', '/api/agreements', { kind: 'QUOTE', site_id: site.id, lines: [LINES[0]] }, adminT)).body;
  assert.equal((await call('POST', `/api/agreements/${draft.id}/amend`, { title: 'x', reason: 'no reason needed yet' }, adminT)).status, 409, 'a draft is edited directly, not amended');

  await call('POST', `/api/agreements/${draft.id}/send`, {}, adminT);
  assert.equal((await call('PATCH', `/api/agreements/${draft.id}`, { title: 'x' }, adminT)).status, 409, 'the draft-only PATCH still refuses once sent');
  assert.equal((await call('POST', `/api/agreements/${draft.id}/amend`, { title: 'Renamed quote' }, adminT)).status, 400, 'a reason is required');
  const amendedQ = await call('POST', `/api/agreements/${draft.id}/amend`, { title: 'Renamed quote', reason: 'typo in the original title' }, adminT);
  assert.equal(amendedQ.status, 200, JSON.stringify(amendedQ.body));
  assert.equal(amendedQ.body.title, 'Renamed quote');
  assert.equal(amendedQ.body.status, 'SENT', 'amending does not change status');

  await call('POST', `/api/agreements/${draft.id}/withdraw`, {}, adminT);
  assert.equal((await call('POST', `/api/agreements/${draft.id}/amend`, { title: 'y', reason: 'z' }, adminT)).status, 409, 'a withdrawn agreement is dead — not amendable either');
});

test("amending a signed contract's rate changes future invoices but leaves the signed terms, PDF and already-generated invoices untouched", async () => {
  const site = (await call('POST', '/api/sites', { name: 'Amend Rate Test Site' }, adminT)).body;
  await call('POST', '/api/clients', { name: 'Amend Rate Test Client', contact_email: 'amend-rate@example.test', site_ids: [site.id] }, adminT);
  const c = (await call('POST', '/api/agreements', {
    kind: 'CONTRACT', site_id: site.id, lines: [{ description: 'Static guarding', kind: 'HOURLY', rate: 20, est_quantity: 160 }], start_date: '2026-01-01',
  }, adminT)).body;
  await call('POST', `/api/agreements/${c.id}/mark-signed`, { name: 'Jo Bloggs', position: 'Ops Manager' }, adminT);
  const signed = app.db.agreements.find((a) => a.id === c.id);
  const snapshotBefore = signed.terms_snapshot, pdfBefore = signed.pdf_file;

  pushShift(site.id, '2026-02-10', 8, 16);
  const before = await call('POST', '/api/invoices/generate', { from: '2026-02-01', to: '2026-02-28', contract_id: c.id }, adminT);
  assert.equal(before.body.made[0].lines[0].unit_amount, 20, 'billed at the original rate before any amendment');

  const amended = await call('POST', `/api/agreements/${c.id}/amend`, {
    lines: [{ description: 'Static guarding', kind: 'HOURLY', rate: 25, est_quantity: 160 }], reason: 'client agreed a rate increase from March',
  }, adminT);
  assert.equal(amended.status, 200, JSON.stringify(amended.body));
  assert.equal(amended.body.lines[0].rate, 25);
  assert.equal(amended.body.status, 'SIGNED', 'still signed — amending does not revert to draft');
  assert.equal(amended.body.terms_snapshot, snapshotBefore, 'the original signed terms are never touched');
  assert.equal(amended.body.pdf_file, pdfBefore, 'the stored signed PDF is not regenerated');
  assert.equal(amended.body.amendments.length, 1);
  assert.equal(amended.body.amendments[0].reason, 'client agreed a rate increase from March');
  assert.equal(amended.body.amendments[0].previous.lines[0].rate, 20, 'the amendment snapshot keeps the pre-amendment rate');
  assert.ok(amended.body.history.some((h) => /amended — client agreed a rate increase/.test(h.what)));

  const feb = app.db.invoices.find((i) => i.contract_id === c.id && String(i.period_from).startsWith('2026-02'));
  assert.equal(feb.lines[0].unit_amount, 20, 'an invoice already generated is not retroactively changed');

  pushShift(site.id, '2026-03-10', 8, 16);
  const after = await call('POST', '/api/invoices/generate', { from: '2026-03-01', to: '2026-03-31', contract_id: c.id }, adminT);
  assert.equal(after.body.made[0].lines[0].unit_amount, 25, 'a new invoice reads the amended, live rate');
});

test('an Alarm Response line bills the jobs attended at the site by the hour or part thereof, once, with like lines grouped', async () => {
  let type = app.db.shift_types.find((t) => t.key === 'ALARM_RESPONSE');
  if (!type) { type = { id: 9001, key: 'ALARM_RESPONSE', name: 'Alarm Response', active: true }; app.db.shift_types.push(type); }
  const site = (await call('POST', '/api/sites', { name: 'Alarm Billing Site' }, adminT)).body;
  await call('POST', '/api/clients', { name: 'Alarm Billing Ltd', contact_email: 'a@example.test', site_ids: [site.id] }, adminT);
  const c = (await call('POST', '/api/agreements', { kind: 'CONTRACT', site_id: site.id, start_date: '2026-02-01', lines: [
    { description: 'Response Services', kind: 'HOURLY', rate: 45, shift_type_id: type.id },
    { description: 'Alarm Response', kind: 'HOURLY', rate: 45, shift_type_id: type.id },
    { description: 'CCTV Monitoring', kind: 'FIXED_PERIOD', rate: 12 },
    { description: 'CCTV Monitoring', kind: 'FIXED_PERIOD', rate: 12 },
    { description: 'CCTV Monitoring', kind: 'FIXED_PERIOD', rate: 12 },
  ] }, adminT)).body;
  await call('POST', `/api/agreements/${c.id}/mark-signed`, { name: 'Test' }, adminT);

  const officer = app.db.personnel[0];
  const done = await call('POST', '/api/jobs', { site: site.id, incident_type: 'ALARM', retrospective: true, reason: 'radio only',
    created_at: '2026-02-10T22:00:00Z', on_scene_at: '2026-02-10T22:20:00Z', completed_at: '2026-02-10T23:05:00Z', resources: [officer.id] }, adminT);
  assert.equal(done.status, 201, JSON.stringify(done.body));
  const long = await call('POST', '/api/jobs', { site: site.id, incident_type: 'ALARM', retrospective: true, reason: 'radio only',
    created_at: '2026-02-11T01:00:00Z', on_scene_at: '2026-02-11T01:10:00Z', completed_at: '2026-02-11T02:20:00Z', resources: [officer.id] }, adminT);
  assert.equal(long.status, 201, JSON.stringify(long.body));
  const noArrival = await call('POST', '/api/jobs', { site: site.id, incident_type: 'ALARM', retrospective: true, reason: 'radio only',
    created_at: '2026-02-12T02:00:00Z', completed_at: '2026-02-12T03:00:00Z' }, adminT);
  assert.equal(noArrival.status, 201, JSON.stringify(noArrival.body));
  const cancelled = await call('POST', '/api/jobs', { site: site.id, incident_type: 'ALARM' }, adminT);
  app.db.jobs.find((j) => j.id === cancelled.body.id).status = 'CANCELLED';
  app.db.jobs.find((j) => j.id === cancelled.body.id).created_at = '2026-02-15T10:00:00Z';

  const g = await call('POST', '/api/invoices/generate', { from: '2026-02-01', to: '2026-02-31', contract_id: c.id }, adminT);
  assert.equal(g.status, 200, JSON.stringify(g.body));
  const inv = g.body.made[0];
  const hourly = inv.lines.filter((l) => l.kind === 'HOURLY');
  assert.equal(hourly.length, 1, 'the two alarm response lines are one line on the invoice');
  assert.equal(hourly[0].quantity, 3, '45 minutes bills 1 hour, 1h10 bills 2 hours, none without an arrival time');
  assert.equal(hourly[0].shifts.length, 3, 'each attendance once, not the cancelled job');
  assert.ok(hourly[0].shifts.some((x) => x.person.includes(officer.name)));
  const cctv = inv.lines.filter((l) => /CCTV/.test(l.description));
  assert.equal(cctv.length, 1, 'repeated fixed charges are one line');
  assert.equal(cctv[0].quantity, 3);
  assert.equal(cctv[0].amount, 36);
  assert.ok(inv.checks.some((x) => /^INC-.* no arrived or cleared time/.test(x)), JSON.stringify(inv.checks));
  assert.ok(!inv.checks.some((x) => /undefined/.test(x)), JSON.stringify(inv.checks));
  const att = hourly[0].shifts.find((x) => x.job_id && x.hours === 2);
  assert.equal(att.clocked_in_at, '2026-02-11T01:10:00.000Z', 'the breakdown carries the arrived time');
  const pdf = await call('GET', `/api/invoices/${inv.id}/pdf`, undefined, adminT, true);
  assert.equal(pdf.status, 200);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
});
