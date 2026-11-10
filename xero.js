/**
 * Xero — just enough of the Accounting API to send our invoices there:
 * connect (OAuth 2.0), keep the connection fresh, find or create the client
 * as a Xero contact, create the invoice, and read back its status (e.g. PAID).
 * Zero dependencies (Node's fetch), like sms.js and msauth.js.
 *
 * SETUP: create an app at developer.xero.com ("Web app"), with redirect URI
 *   https://<your site>/api/xero/callback
 * and set XERO_CLIENT_ID and XERO_CLIENT_SECRET in cccs.env. Then an admin
 * presses "Connect to Xero" on the Invoices page and approves it in Xero.
 *
 * The tokens are kept in the database (ui_settings, key "xero") and never
 * sent to a browser. Xero refresh tokens rotate: each refresh returns a new
 * one, which is saved straight away. The base URLs can be overridden
 * (XERO_*_BASE) — the tests point them at a fake Xero.
 */
'use strict';

const CLIENT_ID = process.env.XERO_CLIENT_ID || '';
const CLIENT_SECRET = process.env.XERO_CLIENT_SECRET || '';
const LOGIN = (process.env.XERO_LOGIN_BASE || 'https://login.xero.com').replace(/\/+$/, '');
const IDENTITY = (process.env.XERO_IDENTITY_BASE || 'https://identity.xero.com').replace(/\/+$/, '');
const API = (process.env.XERO_API_BASE || 'https://api.xero.com').replace(/\/+$/, '');
// Xero's granular scopes: apps created on or after 2 March 2026 can't ask for
// the old broad accounting.transactions (Xero answers "invalid_scope"), and
// older apps must move by September 2027. CCCS creates, emails and reads
// invoices (accounting.invoices) and finds or creates contacts
// (accounting.contacts). Expenses (routes-expenses.js) add a staff claim as
// a bill (ACCPAY, also accounting.invoices), a company-paid one as Spend
// Money (accounting.banktransactions), and attach the receipt to either
// (accounting.attachments). A new scope only takes effect when an admin
// presses Connect to Xero again. XERO_SCOPES overrides the list.
const SCOPES = process.env.XERO_SCOPES || 'openid profile email offline_access accounting.invoices accounting.contacts accounting.banktransactions accounting.attachments';

/** A Xero date as YYYY-MM-DD: "2026-11-10T00:00:00" (the *String fields)
 * or the older "/Date(<ms since 1970>+0000)/". Null when absent. */
function xeroDate(v) {
  if (!v) return null;
  const m = String(v).match(/^\/Date\((-?\d+)/);
  if (m) return new Date(Number(m[1])).toISOString().slice(0, 10);
  const d = String(v).match(/^(\d{4}-\d{2}-\d{2})/);
  return d ? d[1] : null;
}

module.exports = function makeXero({ db, flushNow = () => {}, redirectUri }) {
  const configured = () => Boolean(CLIENT_ID && CLIENT_SECRET);
  const row = () => {
    if (!Array.isArray(db.ui_settings)) db.ui_settings = [];
    let r = db.ui_settings.find((x) => x.key === 'xero');
    if (!r) { r = { key: 'xero', settings: { account_code: '200', tax_type: 'OUTPUT2', invoice_status: 'DRAFT' } }; db.ui_settings.push(r); }
    if (!r.settings) r.settings = { account_code: '200', tax_type: 'OUTPUT2', invoice_status: 'DRAFT' };
    return r;
  };
  const connected = () => Boolean(row().refresh_token && row().tenant_id);

  function authorizeUrl(state) {
    const q = new URLSearchParams({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: redirectUri, scope: SCOPES, state });
    return `${LOGIN}/identity/connect/authorize?${q}`;
  }
  async function token(params) {
    const res = await fetch(`${IDENTITY}/connect/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Xero sign-in failed: ${data.error_description || data.error || res.status}`);
    const r = row();
    r.access_token = data.access_token; r.refresh_token = data.refresh_token || r.refresh_token;
    r.expires_at = Date.now() + (Number(data.expires_in) || 1800) * 1000 - 60000;
    // What this connection was granted, so a page can say "reconnect to
    // allow receipts" rather than fail on the first upload.
    if (data.scope) r.scopes = String(data.scope).split(/\s+/).filter(Boolean);
    flushNow();
    return r;
  }
  /** Finishes "Connect to Xero": swap the code, then pick the organisation. */
  async function connect(code, by) {
    await token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
    const res = await fetch(`${API}/connections`, { headers: { authorization: `Bearer ${row().access_token}` } });
    const conns = await res.json().catch(() => []);
    const org = Array.isArray(conns) ? conns.find((c) => c.tenantType === 'ORGANISATION') || conns[0] : null;
    if (!org) throw new Error('no Xero organisation was shared with CCCS');
    Object.assign(row(), { tenant_id: org.tenantId, tenant_name: org.tenantName || 'Xero organisation', connected_at: new Date().toISOString(), connected_by: by, last_error: null });
    flushNow();
    return row();
  }
  function disconnect() {
    const r = row();
    for (const k of ['access_token', 'refresh_token', 'expires_at', 'tenant_id', 'tenant_name', 'connected_at', 'connected_by', 'scopes']) delete r[k];
    flushNow();
  }
  async function call(method, path, body, raw = null) {
    if (!configured()) throw new Error('Xero is not set up on this server (XERO_CLIENT_ID / XERO_CLIENT_SECRET)');
    if (!connected()) throw new Error('not connected to Xero — press "Connect to Xero" on the Invoices page');
    let r = row();
    if (!r.access_token || Date.now() >= r.expires_at) r = await token({ grant_type: 'refresh_token', refresh_token: r.refresh_token });
    const res = await fetch(`${API}/api.xro/2.0${path}`, {
      method, headers: { authorization: `Bearer ${r.access_token}`, 'xero-tenant-id': r.tenant_id, accept: 'application/json', 'content-type': raw ? raw.contentType : 'application/json' },
      body: raw ? raw.bytes : (body ? JSON.stringify(body) : undefined),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data && data.Elements && data.Elements[0] && data.Elements[0].ValidationErrors ? data.Elements[0].ValidationErrors.map((v) => v.Message).join('; ') : (data.Message || data.Detail || res.status);
      Object.assign(row(), { last_error: String(detail), last_error_at: new Date().toISOString() }); flushNow();
      throw new Error(`Xero: ${detail}`);
    }
    // A call that works clears an old error, so the banner never shows
    // a problem that has since been fixed.
    if (row().last_error) { Object.assign(row(), { last_error: null, last_error_at: null }); flushNow(); }
    return data;
  }
  /** A supplier or staff member as a Xero contact: found by name, or created. */
  async function contactNamed(name) {
    const n = String(name || '').replace(/"/g, '').trim().slice(0, 255);
    if (!n) throw new Error('a Xero contact needs a name');
    const found = await call('GET', `/Contacts?where=${encodeURIComponent(`Name=="${n}"`)}`);
    let c = found.Contacts && found.Contacts[0];
    if (!c) { const made = await call('POST', '/Contacts', { Contacts: [{ Name: n }] }); c = made.Contacts && made.Contacts[0]; }
    if (!c || !c.ContactID) throw new Error('Xero did not return a contact');
    return c.ContactID;
  }
  /** A bill (ACCPAY invoice) — what a staff member is owed back. */
  async function createBill(bill) {
    const out = await call('POST', '/Invoices', { Invoices: [{ Type: 'ACCPAY', CurrencyCode: 'GBP', ...bill }] });
    const x = out.Invoices && out.Invoices[0];
    if (!x || !x.InvoiceID) throw new Error('Xero did not return the bill');
    return { id: x.InvoiceID, status: x.Status, total: x.Total };
  }
  /** Spend Money from a bank account — paid on a company card. */
  async function createSpend(spend) {
    const out = await call('POST', '/BankTransactions', { BankTransactions: [{ Type: 'SPEND', CurrencyCode: 'GBP', ...spend }] });
    const x = out.BankTransactions && out.BankTransactions[0];
    if (!x || !x.BankTransactionID) throw new Error('Xero did not return the spend money transaction');
    return { id: x.BankTransactionID, status: x.Status, total: x.Total };
  }
  /** A file (the receipt) attached to a bill or a spend money transaction. */
  async function attach(kind, id, filename, bytes, contentType) {
    const endpoint = kind === 'SPEND' ? 'BankTransactions' : 'Invoices';
    const out = await call('POST', `/${endpoint}/${encodeURIComponent(id)}/Attachments/${encodeURIComponent(filename)}`, null, { bytes, contentType });
    const a = out.Attachments && out.Attachments[0];
    return a ? a.AttachmentID : null;
  }
  /** The client as a Xero contact: found by name, or created. Remembered on the client. */
  async function contactFor(client) {
    if (client.xero_contact_id) return client.xero_contact_id;
    const where = encodeURIComponent(`Name=="${String(client.name).replace(/"/g, '')}"`);
    const found = await call('GET', `/Contacts?where=${where}`);
    let c = found.Contacts && found.Contacts[0];
    if (!c) {
      // A CCCS email field can hold several addresses; Xero's EmailAddress
      // takes exactly one, so the rest go in as contact people who are
      // included in Xero's invoice emails.
      const emails = String(client.billing_email || client.contact_email || '').split(/[\s,;]+/).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
      const people = emails.slice(1, 6).map((e) => ({ FirstName: e.split('@')[0], EmailAddress: e, IncludeInEmails: true }));
      const made = await call('POST', '/Contacts', { Contacts: [{ Name: client.name, EmailAddress: emails[0] || undefined, ...(people.length ? { ContactPersons: people } : {}) }] });
      c = made.Contacts && made.Contacts[0];
    }
    if (!c) throw new Error('Xero did not return a contact');
    client.xero_contact_id = c.ContactID;
    return c.ContactID;
  }
  /** Creates the invoice in Xero. Draft or approved, as set in the settings. */
  async function pushInvoice(inv, client, { status } = {}) {
    const s = row().settings;
    const contactId = await contactFor(client);
    const body = { Invoices: [{
      Type: 'ACCREC', Contact: { ContactID: contactId }, Date: inv.issue_date, DueDate: inv.due_date,
      // Same invoice number in Xero as on our PDF and in the client portal.
      InvoiceNumber: inv.number || undefined, Reference: inv.contract_reference || inv.reference,
      LineAmountTypes: 'Exclusive', Status: status || (s.invoice_status === 'AUTHORISED' ? 'AUTHORISED' : 'DRAFT'), CurrencyCode: 'GBP',
      LineItems: inv.lines.map((l) => ({ Description: l.description, Quantity: l.quantity, UnitAmount: l.unit_amount, AccountCode: s.account_code, TaxType: inv.vat_rate > 0 ? s.tax_type : 'NONE' })),
    }] };
    const out = await call('POST', '/Invoices', body);
    const x = out.Invoices && out.Invoices[0];
    if (!x || !x.InvoiceID) throw new Error('Xero did not return the invoice');
    return { invoice_id: x.InvoiceID, number: x.InvoiceNumber || null, status: x.Status, total: x.Total, amount_due: x.AmountDue };
  }
  /** Which of these invoice numbers Xero already has. POST /Invoices with
   * an existing InvoiceNumber means "update that invoice", which Xero
   * refuses once it is approved or paid ("not of valid status for
   * modification"), so CCCS checks before it pushes. */
  async function numbersTaken(numbers) {
    const taken = new Set();
    for (let i = 0; i < numbers.length; i += 40) {
      const r = await call('GET', `/Invoices?InvoiceNumbers=${numbers.slice(i, i + 40).map(encodeURIComponent).join(',')}&summaryOnly=true`);
      for (const x of r.Invoices || []) if (x.Status !== 'DELETED') taken.add(x.InvoiceNumber);
    }
    return taken;
  }
  /** The highest number Xero already has in this prefix's series (0 if
   * none), so CCCS can carry on after invoices raised straight in Xero.
   * Xero sorts InvoiceNumber as text, so the top page is read and the
   * largest number taken from it (copes with a mix of widths). */
  async function highestNumber(prefix) {
    const p = String(prefix || '');
    const where = `Type=="ACCREC"${p ? ` AND InvoiceNumber.StartsWith("${p.replace(/"/g, '')}")` : ''}`;
    const r = await call('GET', `/Invoices?where=${encodeURIComponent(where)}&order=${encodeURIComponent('InvoiceNumber DESC')}&summaryOnly=true&page=1`);
    let max = 0;
    for (const x of r.Invoices || []) {
      const n = String(x.InvoiceNumber || '');
      if (x.Status === 'DELETED' || !n.startsWith(p)) continue;
      const d = n.slice(p.length);
      if (/^\d{1,9}$/.test(d)) max = Math.max(max, Number(d));
    }
    return max;
  }
  /** Supplier bills still to pay (Xero "ACCPAY" invoices with money owing):
   * drafts (e.g. ones sent to Xero's bills inbox and not yet approved),
   * awaiting approval and approved-awaiting-payment. Read through the same
   * Invoices endpoint and accounting.invoices scope CCCS already has, so no
   * reconnect is needed. Up to 1,000 bills (10 pages of 100). */
  async function unpaidBills() {
    const where = 'Type=="ACCPAY" AND AmountDue>0';
    const out = [];
    for (let page = 1; page <= 10; page++) {
      const r = await call('GET', `/Invoices?where=${encodeURIComponent(where)}&Statuses=DRAFT,SUBMITTED,AUTHORISED&summaryOnly=true&page=${page}`);
      const list = r.Invoices || [];
      for (const x of list) {
        if (x.Type && x.Type !== 'ACCPAY') continue;
        if (!['DRAFT', 'SUBMITTED', 'AUTHORISED'].includes(x.Status)) continue;
        const due = Number(x.AmountDue);
        if (!(due > 0)) continue;
        out.push({
          id: x.InvoiceID, supplier: (x.Contact && x.Contact.Name) || 'Unknown supplier',
          number: x.InvoiceNumber || '', reference: x.Reference || '', status: x.Status,
          date: xeroDate(x.DateString || x.Date), due_date: xeroDate(x.DueDateString || x.DueDate),
          amount_due: due, total: Number(x.Total) || due, currency: x.CurrencyCode || 'GBP',
        });
      }
      if (list.length < 100) break;
    }
    return out;
  }
  /** Xero emails an approved invoice to the contact itself. */
  async function emailInvoice(xeroId) { await call('POST', `/Invoices/${encodeURIComponent(xeroId)}/Email`, {}); }
  /** Several at once (Xero takes a list of IDs), keyed by Xero invoice ID. */
  async function invoiceStatuses(ids) {
    const out = {};
    for (let i = 0; i < ids.length; i += 40) {
      const r = await call('GET', `/Invoices?IDs=${ids.slice(i, i + 40).map(encodeURIComponent).join(',')}`);
      for (const x of r.Invoices || []) out[x.InvoiceID] = { status: x.Status, number: x.InvoiceNumber, amount_due: x.AmountDue, amount_paid: x.AmountPaid, total: x.Total };
    }
    return out;
  }
  async function invoiceStatus(xeroId) {
    const out = await call('GET', `/Invoices/${encodeURIComponent(xeroId)}`);
    const x = out.Invoices && out.Invoices[0];
    return x ? { status: x.Status, number: x.InvoiceNumber, amount_due: x.AmountDue, amount_paid: x.AmountPaid, total: x.Total } : null;
  }
  /** Every approved sales invoice with money still owed on it, whoever
   * raised it (CCCS or straight in Xero) — for payment reminders and
   * statements. Partly paid invoices stay AUTHORISED with a smaller
   * AmountDue, so they are included at what is left. */
  async function outstandingInvoices() {
    const where = encodeURIComponent('Type=="ACCREC" AND Status=="AUTHORISED" AND AmountDue>0');
    const out = [];
    for (let page = 1; page <= 20; page++) {
      const r = await call('GET', `/Invoices?where=${where}&summaryOnly=true&page=${page}&pageSize=100`);
      const list = r.Invoices || [];
      for (const x of list) {
        if (!(Number(x.AmountDue) > 0)) continue;
        out.push({
          invoice_id: x.InvoiceID, number: x.InvoiceNumber || '', reference: x.Reference || '',
          contact_id: x.Contact && x.Contact.ContactID, contact_name: (x.Contact && x.Contact.Name) || '—',
          date: xeroDate(x.DateString || x.Date), due_date: xeroDate(x.DueDateString || x.DueDate),
          total: Number(x.Total) || 0, amount_paid: Number(x.AmountPaid) || 0, amount_due: Number(x.AmountDue) || 0,
        });
      }
      if (list.length < 100) break;
    }
    return out;
  }
  /** Where Xero sends a contact's invoices: its main address plus any
   * contact people ticked "include in emails". Keyed by ContactID. */
  async function contactEmails(ids) {
    const out = {};
    const uniq = [...new Set(ids.filter(Boolean))];
    for (let i = 0; i < uniq.length; i += 40) {
      const r = await call('GET', `/Contacts?IDs=${uniq.slice(i, i + 40).map(encodeURIComponent).join(',')}`);
      for (const c of r.Contacts || []) {
        const list = [c.EmailAddress, ...(c.ContactPersons || []).filter((p) => p.IncludeInEmails).map((p) => p.EmailAddress)];
        out[c.ContactID] = [...new Set(list.map((e) => String(e || '').trim()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))];
      }
    }
    return out;
  }
  function status() {
    const r = row();
    return { configured: configured(), connected: connected(), tenant_name: r.tenant_name || null, connected_at: r.connected_at || null, connected_by: r.connected_by || null, last_error: r.last_error || null, last_error_at: r.last_error_at || null, scopes: r.scopes || null, settings: r.settings, redirect_uri: redirectUri };
  }
  /** Whether the connection is known to lack a scope (null = not known:
   * a connection made before CCCS kept the granted list). */
  const lacksScope = (scope) => { const g = row().scopes; return Array.isArray(g) ? !g.includes(scope) : null; };
  return { configured, connected, authorizeUrl, connect, disconnect, pushInvoice, contactNamed, createBill, createSpend, attach, lacksScope, numbersTaken, highestNumber, emailInvoice, invoiceStatus, invoiceStatuses, unpaidBills, outstandingInvoices, contactEmails, status, row };
};
module.exports.xeroDate = xeroDate;
