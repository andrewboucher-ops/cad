/**
 * Expenses — receipts captured in CCCS and sent to Xero.
 *
 * Anyone on staff (and the FINANCE role) logs an expense from a phone or a
 * desktop: date, supplier, what it was for, a category, the total, the VAT
 * on the receipt, who paid, and a photo or PDF of the receipt. Photos are
 * shrunk in the browser before upload. Each one gets a reference (EXP-0001).
 *
 *   SUBMITTED → APPROVED → IN_XERO            (or REJECTED, with a reason,
 *                                              which the claimant can fix
 *                                              and send again)
 *
 * Approving and sending to Xero are done by admins and FINANCE. In Xero:
 *   paid by a staff member (STAFF)   a bill (ACCPAY) to that person, so
 *                                    Xero shows what they are owed back
 *   paid on a company card (COMPANY) Spend Money from the bank account set
 *                                    in Expenses settings, ready to match
 *                                    against the bank feed line
 * Either way the receipt file is attached to the Xero transaction, and the
 * line is coded to the category's account.
 *
 * VAT: while the company is not VAT registered (Expenses settings), each
 * expense goes to Xero with no VAT (the whole amount is the cost) but the
 * VAT on the receipt is still recorded here and noted on the Xero line.
 * Turn "VAT registered" on from the registration date and the VAT goes to
 * Xero as input VAT (20% / 5% / zero / exempt) to reclaim. The receipts
 * kept here are the evidence HMRC asks for, including for the VAT on
 * purchases made before registration that can be reclaimed on the first
 * return. A category can be marked "no VAT reclaim" (client entertainment).
 *
 * A receipt is never deleted once the expense has been approved; a record
 * sent to Xero cannot be edited here (change it in Xero).
 *
 * Registrar pattern — server.js passes in what this needs.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' };
const SIGNATURES = {
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/webp': (b) => b.length > 12 && b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP',
  'application/pdf': (b) => b.length > 4 && b.slice(0, 4).toString() === '%PDF',
};
// What each VAT choice is in Xero (UK), on the purchases side.
const VAT_RATES = {
  STANDARD: { label: '20% VAT', tax_type: 'INPUT2', rate: 0.2 },
  REDUCED: { label: '5% VAT', tax_type: 'RRINPUT', rate: 0.05 },
  ZERO: { label: 'Zero rated', tax_type: 'ZERORATEDINPUT', rate: 0 },
  EXEMPT: { label: 'Exempt', tax_type: 'EXEMPTINPUT', rate: 0 },
  NONE: { label: 'No VAT on receipt', tax_type: 'NONE', rate: 0 },
};
// Codes from Xero's standard UK chart of accounts (the one this company
// uses); an admin can change them in Expenses settings.
const DEFAULT_CATEGORIES = [
  { key: 'fuel', label: 'Fuel & vehicle running', account_code: '449' },
  { key: 'parking', label: 'Parking & tolls', account_code: '493' },
  { key: 'travel', label: 'Travel (train, taxi, hotel)', account_code: '493' },
  { key: 'subsistence', label: 'Meals while working away', account_code: '493' },
  { key: 'uniform', label: 'Uniform, PPE & small equipment', account_code: '429' },
  { key: 'repairs', label: 'Repairs & maintenance', account_code: '473' },
  { key: 'it', label: 'Software & IT', account_code: '463' },
  { key: 'phone', label: 'Phone & internet', account_code: '489' },
  { key: 'stationery', label: 'Printing & stationery', account_code: '461' },
  { key: 'postage', label: 'Postage & courier', account_code: '425' },
  { key: 'training', label: 'Training & licences', account_code: '480' },
  { key: 'cleaning', label: 'Cleaning', account_code: '408' },
  { key: 'subscriptions', label: 'Subscriptions & memberships', account_code: '485' },
  { key: 'advertising', label: 'Advertising & marketing', account_code: '400' },
  { key: 'entertainment', label: 'Client entertainment', account_code: '424', no_vat_reclaim: true },
  { key: 'general', label: 'Other / general', account_code: '429' },
];

module.exports = function registerExpenses({
  route, httpError, ADMIN, FINANCE, db, nextId, logEvent, xero, UPLOADS_DIR, flushNow = () => {},
}) {
  if (!Array.isArray(db.expenses)) db.expenses = [];
  const MONEY = [...ADMIN, ...FINANCE];
  // Everyone on staff can claim; a vehicle terminal (MDT_USER) and a client cannot.
  const CLAIM = ['SYSTEM_ADMIN', 'DISPATCHER', 'SUPERVISOR', 'FIELD_USER', 'FINANCE'];
  const isMoney = (u) => MONEY.includes(u.role);
  const r2 = (n) => Math.round(Number(n) * 100) / 100;
  const dir = (id) => path.join(UPLOADS_DIR, 'expenses', String(id));

  function settings() {
    if (!Array.isArray(db.ui_settings)) db.ui_settings = [];
    let r = db.ui_settings.find((x) => x.key === 'expenses');
    if (!r) { r = { key: 'expenses', settings: {} }; db.ui_settings.push(r); }
    const s = r.settings || (r.settings = {});
    if (!Array.isArray(s.categories) || !s.categories.length) s.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
    if (typeof s.vat_registered !== 'boolean') s.vat_registered = false;
    if (!('vat_registered_from' in s)) s.vat_registered_from = null;
    if (!('bank_account' in s)) s.bank_account = '';
    if (!['DRAFT', 'AUTHORISED'].includes(s.bill_status)) s.bill_status = 'AUTHORISED';
    if (!Number.isInteger(s.pay_within_days)) s.pay_within_days = 7;
    if (!Number.isInteger(s.next_number)) s.next_number = 1;
    return s;
  }
  const category = (key) => settings().categories.find((c) => c.key === key) || null;
  const nameOfUser = (userId) => {
    const u = db.users.find((x) => x.id === userId); if (!u) return null;
    const p = u.personnel_id ? db.personnel.find((x) => x.id === u.personnel_id) : null;
    return (p && p.name) || u.display_name || u.username;
  };
  const today = () => new Date().toISOString().slice(0, 10);
  const addDays = (ymd, n) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

  function shape(e, viewer) {
    const c = category(e.category);
    return {
      ...e,
      receipt: e.receipt ? { filename: e.receipt.filename, mimetype: e.receipt.mimetype, size: e.receipt.size, url: `/api/expenses/${e.id}/receipt` } : null,
      category_label: c ? c.label : e.category,
      account_code: e.account_code || (c ? c.account_code : null),
      net: r2(e.gross - e.vat),
      can_edit: canEdit(e, viewer),
    };
  }
  function canSee(e, user) { return isMoney(user) || e.claimant_user_id === user.id || e.created_by === user.id; }
  function canEdit(e, user) {
    if (e.status === 'IN_XERO') return false;
    if (isMoney(user)) return true;
    return (e.claimant_user_id === user.id || e.created_by === user.id) && ['SUBMITTED', 'REJECTED'].includes(e.status);
  }
  function find(id, user) {
    const e = db.expenses.find((x) => x.id === Number(id));
    if (!e || !canSee(e, user)) throw httpError(404, 'expense not found');
    return e;
  }
  const note = (e, user, action, detail) => { (e.history || (e.history = [])).push({ at: new Date().toISOString(), by: user.display_name || user.username, action, ...(detail ? { detail } : {}) }); };

  /** Checks and normalises the fields a claimant fills in. `partial` for a PATCH. */
  function readFields(body, { partial = false, existing = null } = {}) {
    const out = {};
    const has = (k) => k in body;
    if (!partial || has('date')) {
      const d = String(body.date || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(Date.parse(d))) throw httpError(400, 'date of the receipt required (YYYY-MM-DD)');
      if (d > addDays(today(), 1)) throw httpError(400, 'the receipt date is in the future');
      out.date = d;
    }
    if (!partial || has('supplier')) {
      const s = String(body.supplier || '').trim();
      if (!s) throw httpError(400, 'supplier (who you paid) required');
      out.supplier = s.slice(0, 120);
    }
    if (!partial || has('description')) out.description = String(body.description || '').trim().slice(0, 500);
    if (!partial || has('category')) {
      if (!category(body.category)) throw httpError(400, 'pick a category');
      out.category = body.category;
    }
    if (!partial || has('paid_by')) {
      if (!['STAFF', 'COMPANY'].includes(body.paid_by)) throw httpError(400, 'paid_by must be STAFF (you paid, to be paid back) or COMPANY (company card)');
      out.paid_by = body.paid_by;
    }
    if (!partial || has('gross') || has('vat') || has('vat_rate')) {
      const gross = r2(has('gross') ? body.gross : existing.gross);
      if (!(gross > 0) || gross > 100000) throw httpError(400, 'total amount paid required');
      const rate = has('vat_rate') ? body.vat_rate : (existing ? existing.vat_rate : 'NONE');
      if (!VAT_RATES[rate]) throw httpError(400, 'vat_rate must be STANDARD, REDUCED, ZERO, EXEMPT or NONE');
      let vat;
      if (has('vat') && body.vat !== '' && body.vat != null) vat = r2(body.vat);
      else if (!has('vat') && existing && existing.vat_rate === rate) vat = existing.vat;
      else vat = r2(gross - gross / (1 + VAT_RATES[rate].rate)); // worked out from the rate
      if (!(vat >= 0) || vat >= gross) throw httpError(400, 'VAT must be less than the total');
      if (VAT_RATES[rate].rate === 0 && vat > 0) throw httpError(400, `${VAT_RATES[rate].label} has no VAT — set the VAT to 0 or pick 20% / 5%`);
      Object.assign(out, { gross, vat, vat_rate: rate });
    }
    if (has('vat_number')) out.vat_number = String(body.vat_number || '').replace(/\s+/g, '').toUpperCase().slice(0, 20);
    if (has('no_receipt_reason')) out.no_receipt_reason = String(body.no_receipt_reason || '').trim().slice(0, 300);
    return out;
  }

  function storeReceipt(e, raw) {
    if (!raw || typeof raw !== 'object' || !raw.data) throw httpError(400, 'receipt.data (base64) required');
    if (!TYPES[raw.mimetype]) throw httpError(400, 'the receipt must be a photo (JPEG, PNG, WebP) or a PDF');
    const bytes = Buffer.from(String(raw.data), 'base64');
    if (!bytes.length) throw httpError(400, 'the receipt file is empty');
    if (bytes.length > 8e6) throw httpError(413, 'the receipt file is too large (8 MB at most)');
    if (!SIGNATURES[raw.mimetype](bytes)) throw httpError(400, `that file does not look like a ${raw.mimetype.split('/')[1].toUpperCase()}`);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const stored = `${crypto.randomUUID()}${TYPES[raw.mimetype]}`;
    fs.mkdirSync(dir(e.id), { recursive: true });
    fs.writeFileSync(path.join(dir(e.id), stored), bytes);
    // The old file stays on disk (an earlier copy of the evidence); only
    // the record points at the new one.
    e.receipt = { stored, filename: String(raw.filename || `receipt${TYPES[raw.mimetype]}`).replace(/[\\/\r\n"]/g, '_').slice(0, 120), mimetype: raw.mimetype, size: bytes.length, sha256, uploaded_at: new Date().toISOString() };
    // The same receipt sent twice is the usual way an expense gets paid twice.
    const dup = db.expenses.find((x) => x.id !== e.id && x.status !== 'REJECTED' && x.receipt && x.receipt.sha256 === sha256);
    e.duplicate_of = dup ? dup.ref : null;
  }

  route('GET', '/api/expenses/meta', CLAIM, ({ user }) => {
    const s = settings();
    const out = {
      categories: s.categories, vat_rates: Object.entries(VAT_RATES).map(([key, v]) => ({ key, label: v.label, rate: v.rate })),
      vat_registered: s.vat_registered, can_approve: isMoney(user), is_admin: ADMIN.includes(user.role),
    };
    if (isMoney(user)) {
      const x = xero.status();
      out.settings = s;
      out.xero = {
        configured: x.configured, connected: x.connected, tenant_name: x.tenant_name, last_error: x.last_error,
        // null = not known (connected before CCCS kept the granted list)
        missing_scopes: x.connected && Array.isArray(x.scopes) ? ['accounting.banktransactions', 'accounting.attachments'].filter((sc) => !x.scopes.includes(sc)) : null,
      };
    }
    return out;
  });

  route('PUT', '/api/expenses/settings', ADMIN, ({ body, user }) => {
    const s = settings();
    if ('vat_registered' in body) s.vat_registered = Boolean(body.vat_registered);
    if ('vat_registered_from' in body) {
      const d = body.vat_registered_from ? String(body.vat_registered_from).slice(0, 10) : null;
      if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw httpError(400, 'VAT registration date looks wrong');
      s.vat_registered_from = d;
    }
    if ('bank_account' in body) {
      const b = String(body.bank_account || '').trim();
      if (b && !/^[0-9a-fA-F-]{36}$/.test(b) && !/^[A-Za-z0-9.-]{1,10}$/.test(b)) throw httpError(400, 'bank account: give its Xero account code, or its AccountID');
      s.bank_account = b;
    }
    if ('bill_status' in body) s.bill_status = body.bill_status === 'DRAFT' ? 'DRAFT' : 'AUTHORISED';
    if ('pay_within_days' in body) { const n = Number(body.pay_within_days); if (!Number.isInteger(n) || n < 0 || n > 90) throw httpError(400, 'pay within 0–90 days'); s.pay_within_days = n; }
    if ('categories' in body) {
      if (!Array.isArray(body.categories) || !body.categories.length) throw httpError(400, 'at least one category');
      const seen = new Set();
      s.categories = body.categories.map((c, i) => {
        const label = String(c.label || '').trim().slice(0, 60); if (!label) throw httpError(400, `category ${i + 1} needs a name`);
        const code = String(c.account_code || '').trim(); if (!/^[A-Za-z0-9.-]{1,10}$/.test(code)) throw httpError(400, `${label}: account code looks wrong`);
        let key = String(c.key || '').trim() || label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || `cat${i + 1}`;
        while (seen.has(key)) key += '_';
        seen.add(key);
        return { key, label, account_code: code, ...(c.no_vat_reclaim ? { no_vat_reclaim: true } : {}) };
      });
    }
    logEvent('expenses.settings', `EXPENSE SETTINGS CHANGED BY ${user.display_name || user.username}`, {});
    flushNow();
    return settings();
  });

  route('GET', '/api/expenses', CLAIM, ({ query, user }) => {
    let rows = db.expenses.filter((e) => canSee(e, user));
    if (query.get('mine') === '1' || !isMoney(user)) rows = rows.filter((e) => e.claimant_user_id === user.id || e.created_by === user.id);
    if (query.get('status')) rows = rows.filter((e) => e.status === query.get('status'));
    if (query.get('from')) rows = rows.filter((e) => e.date >= query.get('from'));
    if (query.get('to')) rows = rows.filter((e) => e.date <= query.get('to'));
    return rows.sort((a, b) => (b.date === a.date ? b.id - a.id : (b.date < a.date ? -1 : 1))).map((e) => shape(e, user));
  });

  // For the accountant, or a VAT return: one row per expense, with the
  // VAT split out and where the receipt is.
  route('GET', '/api/expenses/export.csv', MONEY, ({ query, user }) => {
    let rows = db.expenses.filter((e) => e.status !== 'REJECTED');
    if (query.get('from')) rows = rows.filter((e) => e.date >= query.get('from'));
    if (query.get('to')) rows = rows.filter((e) => e.date <= query.get('to'));
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
    // Quoted, and a leading = + - @ defused, so a supplier name cannot run as a spreadsheet formula.
    const cell = (v) => { let t = v == null ? '' : String(v); if (/^[=+\-@]/.test(t)) t = `'${t}`; return /[",\r\n']/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const head = ['Reference', 'Date', 'Supplier', 'Supplier VAT number', 'Description', 'Category', 'Account code', 'Net', 'VAT', 'Total', 'VAT rate', 'Paid by', 'Claimant', 'Status', 'Receipt', 'In Xero'];
    const lines = rows.map((e) => { const x = shape(e, user); return [e.ref, e.date, e.supplier, e.vat_number || '', e.description, x.category_label, x.account_code, x.net.toFixed(2), e.vat.toFixed(2), e.gross.toFixed(2), VAT_RATES[e.vat_rate].label, e.paid_by === 'STAFF' ? 'Staff (to repay)' : 'Company card', e.claimant_name, e.status, e.receipt ? 'Yes' : `No — ${e.no_receipt_reason || ''}`, e.xero ? `${e.xero.kind === 'SPEND' ? 'Spend money' : 'Bill'} ${e.xero.sent_at.slice(0, 10)}` : ''].map(cell).join(','); });
    return { __body: Buffer.from(`﻿${[head.join(','), ...lines].join('\r\n')}\r\n`), __headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="expenses${query.get('from') ? '-' + query.get('from') : ''}${query.get('to') ? '-to-' + query.get('to') : ''}.csv"`, 'cache-control': 'private, no-store' } };
  });

  route('POST', '/api/expenses', CLAIM, ({ body, user }) => {
    const fields = readFields(body);
    if (!body.receipt && !fields.no_receipt_reason) throw httpError(400, 'add a photo of the receipt, or say why there is none');
    // Admin/finance can log one on someone's behalf.
    let claimant = user;
    if (body.claimant_user_id && isMoney(user)) {
      claimant = db.users.find((u) => u.id === Number(body.claimant_user_id) && CLAIM.includes(u.role));
      if (!claimant) throw httpError(400, 'claimant not found');
    }
    const s = settings();
    const e = {
      id: nextId('expenses'), ref: `EXP-${String(s.next_number).padStart(4, '0')}`,
      ...fields, vat_number: fields.vat_number || '', no_receipt_reason: fields.no_receipt_reason || '',
      claimant_user_id: claimant.id, claimant_name: nameOfUser(claimant.id), personnel_id: claimant.personnel_id || null,
      receipt: null, duplicate_of: null, status: 'SUBMITTED', xero: null,
      created_by: user.id, created_at: new Date().toISOString(), history: [],
    };
    s.next_number += 1;
    if (body.receipt) storeReceipt(e, body.receipt);
    note(e, user, 'submitted');
    db.expenses.push(e);
    logEvent('expense.submitted', `EXPENSE ${e.ref} £${e.gross.toFixed(2)} ${e.supplier.toUpperCase()} BY ${(user.display_name || user.username).toUpperCase()}`, { expense_id: e.id });
    flushNow();
    return { __status: 201, __body: shape(e, user) };
  });

  route('GET', '/api/expenses/:id', CLAIM, ({ params, user }) => shape(find(params.id, user), user));

  route('PATCH', '/api/expenses/:id', CLAIM, ({ params, body, user }) => {
    const e = find(params.id, user);
    if (!canEdit(e, user)) throw httpError(409, e.status === 'IN_XERO' ? 'already in Xero — change it there' : 'this expense can no longer be changed');
    const fields = readFields(body, { partial: true, existing: e });
    const reason = 'no_receipt_reason' in fields ? fields.no_receipt_reason : e.no_receipt_reason;
    if (!e.receipt && !body.receipt && !reason) throw httpError(400, 'add a photo of the receipt, or say why there is none');
    if (body.receipt) storeReceipt(e, body.receipt);
    Object.assign(e, fields);
    // A rejected one the claimant has fixed goes back for approval.
    if (e.status === 'REJECTED' && !isMoney(user)) { e.status = 'SUBMITTED'; e.reject_reason = null; }
    note(e, user, 'edited');
    flushNow();
    return shape(e, user);
  });

  route('GET', '/api/expenses/:id/receipt', CLAIM, ({ params, user }) => {
    const e = find(params.id, user);
    if (!e.receipt) throw httpError(404, 'no receipt on this expense');
    const file = path.join(dir(e.id), e.receipt.stored);
    if (!fs.existsSync(file)) throw httpError(404, 'receipt file missing');
    return { __body: fs.readFileSync(file), __headers: { 'content-type': e.receipt.mimetype, 'content-disposition': `inline; filename="${e.receipt.filename}"`, 'cache-control': 'private, no-store' } };
  });

  // Only an expense nobody has approved yet; the receipt goes with it.
  route('DELETE', '/api/expenses/:id', CLAIM, ({ params, user }) => {
    const e = find(params.id, user);
    if (!['SUBMITTED', 'REJECTED'].includes(e.status) || !canEdit(e, user)) throw httpError(409, 'only an expense that has not been approved can be deleted');
    db.expenses = db.expenses.filter((x) => x.id !== e.id);
    fs.rmSync(dir(e.id), { recursive: true, force: true });
    logEvent('expense.deleted', `EXPENSE ${e.ref} DELETED BY ${(user.display_name || user.username).toUpperCase()}`, { expense_id: e.id });
    flushNow();
    return { ok: true };
  });

  route('POST', '/api/expenses/:id/reject', MONEY, ({ params, body, user }) => {
    const e = find(params.id, user);
    if (!['SUBMITTED', 'APPROVED'].includes(e.status)) throw httpError(409, `cannot reject — it is ${e.status}`);
    const reason = String(body.reason || '').trim();
    if (!reason) throw httpError(400, 'say why, so they can fix it');
    Object.assign(e, { status: 'REJECTED', reject_reason: reason.slice(0, 300), approved_by: null, approved_at: null });
    note(e, user, 'rejected', reason);
    logEvent('expense.rejected', `EXPENSE ${e.ref} REJECTED BY ${(user.display_name || user.username).toUpperCase()}`, { expense_id: e.id });
    flushNow();
    return shape(e, user);
  });

  route('POST', '/api/expenses/:id/approve', MONEY, ({ params, user }) => {
    const e = find(params.id, user);
    if (e.status !== 'SUBMITTED') throw httpError(409, `cannot approve — it is ${e.status}`);
    const c = category(e.category);
    Object.assign(e, { status: 'APPROVED', approved_by: user.display_name || user.username, approved_at: new Date().toISOString(), account_code: c ? c.account_code : e.account_code });
    note(e, user, 'approved');
    logEvent('expense.approved', `EXPENSE ${e.ref} APPROVED BY ${e.approved_by.toUpperCase()}`, { expense_id: e.id });
    flushNow();
    return shape(e, user);
  });

  /** What the Xero line says and how its VAT is coded. */
  function xeroLine(e) {
    const s = settings();
    const c = category(e.category);
    const reclaim = s.vat_registered && (!s.vat_registered_from || e.date >= s.vat_registered_from) && !(c && c.no_vat_reclaim);
    const bits = [`${e.ref} ${e.supplier}`, e.description, e.paid_by === 'STAFF' ? `paid by ${e.claimant_name}` : ''];
    if (!reclaim && e.vat > 0) bits.push(`VAT on receipt £${e.vat.toFixed(2)}${e.vat_number ? ` (supplier VAT no. ${e.vat_number})` : ''}`);
    const line = { Description: bits.filter(Boolean).join(' — ').slice(0, 4000), Quantity: 1, UnitAmount: e.gross, AccountCode: e.account_code || (c && c.account_code) };
    if (reclaim && e.vat_rate !== 'NONE') return { amountTypes: 'Inclusive', line: { ...line, TaxType: VAT_RATES[e.vat_rate].tax_type, TaxAmount: e.vat } };
    return { amountTypes: 'NoTax', line: { ...line, TaxType: 'NONE' } };
  }
  async function attachReceipt(e) {
    if (!e.receipt) return;
    try {
      const bytes = fs.readFileSync(path.join(dir(e.id), e.receipt.stored));
      const name = `${e.ref}-receipt${TYPES[e.receipt.mimetype]}`;
      e.xero.attachment_id = await xero.attach(e.xero.kind, e.xero.id, name, bytes, e.receipt.mimetype);
      e.xero.attachment_error = null;
    } catch (err) {
      e.xero.attachment_error = /forbidden|unauthori[sz]ed|authorizationunsuccessful|scope|401|403/i.test(err.message)
        ? 'Xero would not take the receipt: press Connect to Xero again (Invoices page) to allow attachments, then Retry receipt'
        : err.message;
    }
  }
  const pushing = new Set();
  route('POST', '/api/expenses/:id/xero', MONEY, async ({ params, user }) => {
    const e = find(params.id, user);
    if (e.status === 'IN_XERO') throw httpError(409, 'already in Xero');
    if (e.status !== 'APPROVED') throw httpError(409, 'approve it first');
    if (pushing.has(e.id)) throw httpError(409, 'already being sent');
    const s = settings();
    if (e.paid_by === 'COMPANY' && !s.bank_account) throw httpError(400, 'set the bank account company-card spending comes from (Expenses → Settings) first');
    pushing.add(e.id);
    try {
      const { amountTypes, line } = xeroLine(e);
      let made, kind;
      if (e.paid_by === 'STAFF') {
        kind = 'BILL';
        const contact = await xero.contactNamed(e.claimant_name);
        made = await xero.createBill({
          Contact: { ContactID: contact }, Date: e.date, DueDate: addDays(today(), s.pay_within_days),
          InvoiceNumber: e.ref, Reference: `Expenses ${e.ref}`, Status: s.bill_status, LineAmountTypes: amountTypes, LineItems: [line],
        });
      } else {
        kind = 'SPEND';
        const contact = await xero.contactNamed(e.supplier);
        made = await xero.createSpend({
          Contact: { ContactID: contact }, Date: e.date, Reference: e.ref, Status: 'AUTHORISED', LineAmountTypes: amountTypes, LineItems: [line],
          BankAccount: /^[0-9a-fA-F-]{36}$/.test(s.bank_account) ? { AccountID: s.bank_account } : { Code: s.bank_account },
        });
      }
      e.xero = { kind, id: made.id, status: made.status, total: made.total, sent_at: new Date().toISOString(), sent_by: user.display_name || user.username, attachment_id: null, attachment_error: null };
      e.status = 'IN_XERO';
      await attachReceipt(e);
      note(e, user, `sent to Xero as ${kind === 'BILL' ? 'a bill' : 'spend money'}`, e.xero.attachment_error || undefined);
      logEvent('expense.xero', `EXPENSE ${e.ref} SENT TO XERO BY ${(user.display_name || user.username).toUpperCase()}`, { expense_id: e.id });
      flushNow();
      return shape(e, user);
    } catch (err) {
      if (err.status) throw err;
      throw httpError(502, err.message);
    } finally { pushing.delete(e.id); }
  });

  route('POST', '/api/expenses/:id/xero-receipt', MONEY, async ({ params, user }) => {
    const e = find(params.id, user);
    if (e.status !== 'IN_XERO' || !e.xero) throw httpError(409, 'not in Xero yet');
    if (!e.receipt) throw httpError(400, 'no receipt on this expense');
    await attachReceipt(e);
    flushNow();
    if (e.xero.attachment_error) throw httpError(502, e.xero.attachment_error);
    note(e, user, 'receipt attached in Xero');
    return shape(e, user);
  });

  return { settings };
};
module.exports.DEFAULT_CATEGORIES = DEFAULT_CATEGORIES;
module.exports.VAT_RATES = VAT_RATES;
