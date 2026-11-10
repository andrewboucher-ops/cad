/* Expenses with receipts, approved and sent to a fake Xero as a bill (staff
 * paid) or spend money (company card), receipt attached
 * (routes-expenses.js, xero.js) — node --test */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.PORT = '4161';
process.env.AUTH_SECRET = 'expenses-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';
process.env.DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cccs-exp-')), 'cccs.db');
const XPORT = 4162, XBASE = `http://127.0.0.1:${XPORT}`;
process.env.XERO_CLIENT_ID = 'test-client-id';
process.env.XERO_CLIENT_SECRET = 'test-client-secret';
process.env.XERO_LOGIN_BASE = XBASE;
process.env.XERO_IDENTITY_BASE = XBASE;
process.env.XERO_API_BASE = XBASE;

/* ---- a fake Xero: contacts, bills, spend money, attachments ---- */
const X = { contacts: [], invoices: [], bank: [], attachments: [], grant: 'openid offline_access accounting.invoices accounting.contacts accounting.banktransactions accounting.attachments', refuseAttach: false };
const fake = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const u = new URL(req.url, XBASE);
    if (u.pathname === '/connect/token') return send(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 1800, scope: X.grant });
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
      const x = { ...inv, InvoiceID: `bill-${X.invoices.length + 1}`, Total: inv.LineItems[0].UnitAmount };
      X.invoices.push(x); return send(200, { Invoices: [x] });
    }
    if (u.pathname === '/api.xro/2.0/BankTransactions' && req.method === 'POST') {
      const t = JSON.parse(raw).BankTransactions[0];
      const x = { ...t, BankTransactionID: `bt-${X.bank.length + 1}`, Total: t.LineItems[0].UnitAmount };
      X.bank.push(x); return send(200, { BankTransactions: [x] });
    }
    const at = u.pathname.match(/^\/api\.xro\/2\.0\/(Invoices|BankTransactions)\/([^/]+)\/Attachments\/(.+)$/);
    if (at && req.method === 'POST') {
      if (X.refuseAttach) return send(403, { Title: 'Forbidden', Detail: 'AuthorizationUnsuccessful' });
      X.attachments.push({ on: at[1], id: at[2], name: decodeURIComponent(at[3]), type: req.headers['content-type'], bytes: raw });
      return send(200, { Attachments: [{ AttachmentID: `att-${X.attachments.length}`, FileName: decodeURIComponent(at[3]) }] });
    }
    send(404, { Detail: 'no such fake endpoint' });
  });
});

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
async function call(method, p, body, token, raw = false) {
  const res = await fetch(BASE + p, { method, redirect: 'manual', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (raw) return res;
  const text = await res.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;
const JPEG = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
const PDF = Buffer.from('%PDF-1.4\n% fake receipt\n').toString('base64');

let adminT, finT, fieldT, field2T, dispT, field;
before(async () => {
  await new Promise((r) => fake.listen(XPORT, '127.0.0.1', r));
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123'); dispT = await login('dispatcher', 'dispatch123');
  await call('POST', '/api/users', { username: 'accounts', password: 'realpassword1', role: 'FINANCE' }, adminT);
  field = (await call('POST', '/api/users', { username: 'guard1', password: 'realpassword1', role: 'FIELD_USER', display_name: 'Sam Guard' }, adminT)).body;
  await call('POST', '/api/users', { username: 'guard2', password: 'realpassword1', role: 'FIELD_USER', display_name: 'Other Guard' }, adminT);
  finT = await login('accounts', 'realpassword1'); fieldT = await login('guard1', 'realpassword1'); field2T = await login('guard2', 'realpassword1');
  // Connect Xero (the callback needs the one-time state from /connect).
  const { url } = (await call('GET', '/api/xero/connect', undefined, adminT)).body;
  const state = new URL(url).searchParams.get('state');
  await call('GET', `/api/xero/callback?state=${state}&code=good-code`, undefined, null, true);
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); fake.close(); });

const base = { date: '2026-11-03', supplier: 'Shell Gosforth', description: 'Fuel for patrol van', category: 'fuel', gross: 60, vat_rate: 'STANDARD', paid_by: 'STAFF' };

test('a staff member logs an expense with a receipt photo; VAT is worked out from the rate', async () => {
  const r = await call('POST', '/api/expenses', { ...base, receipt: { mimetype: 'image/jpeg', filename: 'IMG_1.jpg', data: JPEG } }, fieldT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.ref, /^EXP-\d{4}$/);
  assert.equal(r.body.vat, 10); assert.equal(r.body.net, 50);
  assert.equal(r.body.status, 'SUBMITTED');
  assert.equal(r.body.claimant_name, 'Sam Guard');
  assert.equal(r.body.receipt.mimetype, 'image/jpeg');
  assert.equal(r.body.receipt.stored, undefined, 'the stored file name is not shown');
  const img = await call('GET', r.body.receipt.url, undefined, fieldT, true);
  assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/jpeg');
});

test('a receipt is required (or a reason), and must really be an image or PDF', async () => {
  assert.equal((await call('POST', '/api/expenses', base, fieldT)).status, 400);
  assert.equal((await call('POST', '/api/expenses', { ...base, receipt: { mimetype: 'application/pdf', data: JPEG } }, fieldT)).status, 400);
  assert.equal((await call('POST', '/api/expenses', { ...base, receipt: { mimetype: 'text/html', data: JPEG } }, fieldT)).status, 400);
  assert.equal((await call('POST', '/api/expenses', { ...base, vat_rate: 'ZERO', vat: 5, no_receipt_reason: 'meter' }, fieldT)).status, 400, 'zero rated with VAT');
  assert.equal((await call('POST', '/api/expenses', { ...base, gross: 10, vat: 12, no_receipt_reason: 'meter' }, fieldT)).status, 400, 'VAT over total');
  const ok = await call('POST', '/api/expenses', { ...base, supplier: 'NCP', category: 'parking', gross: 4.5, vat_rate: 'NONE', no_receipt_reason: 'pay and display, no ticket' }, fieldT);
  assert.equal(ok.status, 201); assert.equal(ok.body.vat, 0); assert.equal(ok.body.receipt, null);
});

test('staff see only their own; a vehicle terminal and dispatch cannot approve', async () => {
  const mine = (await call('GET', '/api/expenses', undefined, fieldT)).body;
  assert.ok(mine.length >= 2);
  const theirs = (await call('GET', '/api/expenses', undefined, field2T)).body;
  assert.equal(theirs.length, 0);
  assert.equal((await call('GET', mine[0].receipt ? mine[0].receipt.url : `/api/expenses/${mine[0].id}`, undefined, field2T)).status, 404);
  assert.equal((await call('POST', `/api/expenses/${mine[0].id}/approve`, {}, dispT)).status, 403);
  assert.equal((await call('POST', `/api/expenses/${mine[0].id}/approve`, {}, fieldT)).status, 403);
  const all = (await call('GET', '/api/expenses', undefined, finT)).body;
  assert.ok(all.length >= 2, 'finance sees everyone');
});

test('the same receipt twice is flagged', async () => {
  const r = await call('POST', '/api/expenses', { ...base, receipt: { mimetype: 'image/jpeg', data: JPEG } }, field2T);
  assert.equal(r.status, 201);
  assert.match(r.body.duplicate_of, /^EXP-/);
});

test('sent back, fixed by the claimant, then approved and sent to Xero as a bill with the receipt (not VAT registered: no VAT claimed)', async () => {
  const e = (await call('GET', '/api/expenses', undefined, fieldT)).body.find((x) => x.supplier === 'Shell Gosforth');
  assert.equal((await call('POST', `/api/expenses/${e.id}/reject`, {}, finT)).status, 400, 'needs a reason');
  const rj = await call('POST', `/api/expenses/${e.id}/reject`, { reason: 'receipt is blurry' }, finT);
  assert.equal(rj.body.status, 'REJECTED');
  const fixed = await call('PATCH', `/api/expenses/${e.id}`, { receipt: { mimetype: 'application/pdf', filename: 'scan.pdf', data: PDF } }, fieldT);
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.equal(fixed.body.status, 'SUBMITTED');
  assert.equal(fixed.body.vat, 10, 'VAT kept on a receipt-only edit');
  assert.equal((await call('POST', `/api/expenses/${e.id}/xero`, {}, finT)).status, 409, 'approve first');
  assert.equal((await call('POST', `/api/expenses/${e.id}/approve`, {}, finT)).body.status, 'APPROVED');
  assert.equal((await call('PATCH', `/api/expenses/${e.id}`, { gross: 70 }, fieldT)).status, 409, 'claimant cannot change it once approved');
  const sent = await call('POST', `/api/expenses/${e.id}/xero`, {}, finT);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.status, 'IN_XERO');
  assert.equal(sent.body.xero.kind, 'BILL');
  assert.equal(sent.body.xero.attachment_error, null);
  const bill = X.invoices.at(-1);
  assert.equal(bill.Type, 'ACCPAY');
  assert.equal(bill.InvoiceNumber, e.ref);
  assert.equal(bill.LineAmountTypes, 'NoTax');
  assert.equal(bill.LineItems[0].TaxType, 'NONE');
  assert.equal(bill.LineItems[0].UnitAmount, 60);
  assert.equal(bill.LineItems[0].AccountCode, '449');
  assert.match(bill.LineItems[0].Description, /VAT on receipt £10\.00/);
  assert.equal(X.contacts.find((c) => c.ContactID === bill.Contact.ContactID).Name, 'Sam Guard');
  const att = X.attachments.at(-1);
  assert.equal(att.on, 'Invoices'); assert.equal(att.id, bill.InvoiceID);
  assert.equal(att.name, `${e.ref}-receipt.pdf`); assert.equal(att.type, 'application/pdf');
  assert.ok(att.bytes.toString().startsWith('%PDF'));
  assert.equal((await call('POST', `/api/expenses/${e.id}/xero`, {}, finT)).status, 409, 'not twice');
  assert.equal((await call('DELETE', `/api/expenses/${e.id}`, undefined, adminT)).status, 409, 'kept once in Xero');
});

test('company card: spend money from the set bank account; VAT claimed once registered', async () => {
  const r = await call('POST', '/api/expenses', { ...base, supplier: 'Screwfix', category: 'repairs', gross: 24, paid_by: 'COMPANY', vat_number: 'gb 123 4567 89', receipt: { mimetype: 'image/png', data: Buffer.from('89504e470d0a1a0a0000', 'hex').toString('base64') } }, fieldT);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await call('POST', `/api/expenses/${r.body.id}/approve`, {}, finT);
  const noBank = await call('POST', `/api/expenses/${r.body.id}/xero`, {}, finT);
  assert.equal(noBank.status, 400); assert.match(noBank.body.error, /bank account/);
  assert.equal((await call('PUT', '/api/expenses/settings', { vat_registered: true }, finT)).status, 403, 'settings are admin only');
  const s = await call('PUT', '/api/expenses/settings', { bank_account: '96fd9e23-7597-4058-b953-0739f10514a8', vat_registered: true, vat_registered_from: '2026-11-01' }, adminT);
  assert.equal(s.status, 200);
  const sent = await call('POST', `/api/expenses/${r.body.id}/xero`, {}, finT);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.xero.kind, 'SPEND');
  const t = X.bank.at(-1);
  assert.equal(t.Type, 'SPEND');
  assert.deepEqual(t.BankAccount, { AccountID: '96fd9e23-7597-4058-b953-0739f10514a8' });
  assert.equal(t.LineAmountTypes, 'Inclusive');
  assert.equal(t.LineItems[0].TaxType, 'INPUT2');
  assert.equal(t.LineItems[0].TaxAmount, 4);
  assert.equal(X.contacts.find((c) => c.ContactID === t.Contact.ContactID).Name, 'Screwfix');
  assert.equal(X.attachments.at(-1).on, 'BankTransactions');
});

test('a receipt dated before registration, and client entertainment, claim no VAT', async () => {
  for (const [body, why] of [[{ date: '2026-10-20' }, 'before registration'], [{ category: 'entertainment', supplier: 'The Botanist' }, 'no reclaim category']]) {
    const r = await call('POST', '/api/expenses', { ...base, ...body, receipt: { mimetype: 'application/pdf', data: Buffer.from(`%PDF-1.4 ${why}`).toString('base64') } }, adminT);
    await call('POST', `/api/expenses/${r.body.id}/approve`, {}, adminT);
    const sent = await call('POST', `/api/expenses/${r.body.id}/xero`, {}, adminT);
    assert.equal(sent.status, 200, why);
    assert.equal(X.invoices.at(-1).LineItems[0].TaxType, 'NONE', why);
  }
});

test('if Xero refuses the receipt, the expense is still in Xero and the receipt can be retried', async () => {
  X.refuseAttach = true;
  const r = await call('POST', '/api/expenses', { ...base, supplier: 'Halfords', receipt: { mimetype: 'application/pdf', data: Buffer.from('%PDF-1.4 halfords').toString('base64') } }, fieldT);
  await call('POST', `/api/expenses/${r.body.id}/approve`, {}, finT);
  const sent = await call('POST', `/api/expenses/${r.body.id}/xero`, {}, finT);
  assert.equal(sent.body.status, 'IN_XERO');
  assert.match(sent.body.xero.attachment_error, /Connect to Xero again/);
  assert.equal((await call('POST', `/api/expenses/${r.body.id}/xero-receipt`, {}, finT)).status, 502);
  X.refuseAttach = false;
  const retry = await call('POST', `/api/expenses/${r.body.id}/xero-receipt`, {}, finT);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.xero.attachment_error, null);
  assert.ok(retry.body.xero.attachment_id);
});

test('meta tells finance which Xero permissions are missing; CSV export splits VAT and defuses formulas', async () => {
  const m = (await call('GET', '/api/expenses/meta', undefined, finT)).body;
  assert.deepEqual(m.xero.missing_scopes, []);
  assert.equal(m.can_approve, true);
  const f = (await call('GET', '/api/expenses/meta', undefined, fieldT)).body;
  assert.equal(f.settings, undefined); assert.equal(f.xero, undefined); assert.equal(f.can_approve, false);
  await call('POST', '/api/expenses', { ...base, supplier: '=HYPERLINK("x")', no_receipt_reason: 'lost', vat_rate: 'NONE' }, fieldT);
  const res = await call('GET', '/api/expenses/export.csv?from=2026-11-01', undefined, finT, true);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /Reference,Date,Supplier/);
  assert.match(text, /EXP-\d{4},2026-11-03,Shell Gosforth,,Fuel for patrol van,Fuel & vehicle running,449,50\.00,10\.00,60\.00/);
  assert.match(text, /"'=HYPERLINK\(""x""\)"/);
  assert.equal((await call('GET', '/api/expenses/export.csv', undefined, fieldT)).status, 403);
});

test('a claimant can delete one not yet approved; the receipt goes too', async () => {
  const r = await call('POST', '/api/expenses', { ...base, supplier: 'Mistake', receipt: { mimetype: 'application/pdf', data: Buffer.from('%PDF-1.4 oops').toString('base64') } }, fieldT);
  assert.equal((await call('DELETE', `/api/expenses/${r.body.id}`, undefined, field2T)).status, 404);
  assert.equal((await call('DELETE', `/api/expenses/${r.body.id}`, undefined, fieldT)).status, 200);
  assert.ok(!app.db.expenses.some((e) => e.id === r.body.id));
});
