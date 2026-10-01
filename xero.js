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
const SCOPES = 'openid profile email offline_access accounting.transactions accounting.contacts accounting.settings.read';

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
    for (const k of ['access_token', 'refresh_token', 'expires_at', 'tenant_id', 'tenant_name', 'connected_at', 'connected_by']) delete r[k];
    flushNow();
  }
  async function call(method, path, body) {
    if (!configured()) throw new Error('Xero is not set up on this server (XERO_CLIENT_ID / XERO_CLIENT_SECRET)');
    if (!connected()) throw new Error('not connected to Xero — press "Connect to Xero" on the Invoices page');
    let r = row();
    if (!r.access_token || Date.now() >= r.expires_at) r = await token({ grant_type: 'refresh_token', refresh_token: r.refresh_token });
    const res = await fetch(`${API}/api.xro/2.0${path}`, {
      method, headers: { authorization: `Bearer ${r.access_token}`, 'xero-tenant-id': r.tenant_id, accept: 'application/json', 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data && data.Elements && data.Elements[0] && data.Elements[0].ValidationErrors ? data.Elements[0].ValidationErrors.map((v) => v.Message).join('; ') : (data.Message || data.Detail || res.status);
      row().last_error = String(detail); flushNow();
      throw new Error(`Xero: ${detail}`);
    }
    return data;
  }
  /** The client as a Xero contact: found by name, or created. Remembered on the client. */
  async function contactFor(client) {
    if (client.xero_contact_id) return client.xero_contact_id;
    const where = encodeURIComponent(`Name=="${String(client.name).replace(/"/g, '')}"`);
    const found = await call('GET', `/Contacts?where=${where}`);
    let c = found.Contacts && found.Contacts[0];
    if (!c) {
      const made = await call('POST', '/Contacts', { Contacts: [{ Name: client.name, EmailAddress: client.contact_email || undefined }] });
      c = made.Contacts && made.Contacts[0];
    }
    if (!c) throw new Error('Xero did not return a contact');
    client.xero_contact_id = c.ContactID;
    return c.ContactID;
  }
  /** Creates the invoice in Xero. Draft or approved, as set in the settings. */
  async function pushInvoice(inv, client) {
    const s = row().settings;
    const contactId = await contactFor(client);
    const body = { Invoices: [{
      Type: 'ACCREC', Contact: { ContactID: contactId }, Date: inv.issue_date, DueDate: inv.due_date,
      LineAmountTypes: 'Exclusive', Reference: inv.reference, Status: s.invoice_status === 'AUTHORISED' ? 'AUTHORISED' : 'DRAFT', CurrencyCode: 'GBP',
      LineItems: inv.lines.map((l) => ({ Description: l.description, Quantity: l.quantity, UnitAmount: l.unit_amount, AccountCode: s.account_code, TaxType: inv.vat_rate > 0 ? s.tax_type : 'NONE' })),
    }] };
    const out = await call('POST', '/Invoices', body);
    const x = out.Invoices && out.Invoices[0];
    if (!x || !x.InvoiceID) throw new Error('Xero did not return the invoice');
    return { invoice_id: x.InvoiceID, number: x.InvoiceNumber || null, status: x.Status, total: x.Total, amount_due: x.AmountDue };
  }
  async function invoiceStatus(xeroId) {
    const out = await call('GET', `/Invoices/${encodeURIComponent(xeroId)}`);
    const x = out.Invoices && out.Invoices[0];
    return x ? { status: x.Status, number: x.InvoiceNumber, amount_due: x.AmountDue, amount_paid: x.AmountPaid, total: x.Total } : null;
  }
  function status() {
    const r = row();
    return { configured: configured(), connected: connected(), tenant_name: r.tenant_name || null, connected_at: r.connected_at || null, connected_by: r.connected_by || null, last_error: r.last_error || null, settings: r.settings, redirect_uri: redirectUri };
  }
  return { configured, connected, authorizeUrl, connect, disconnect, pushInvoice, invoiceStatus, status, row };
};
