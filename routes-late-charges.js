/**
 * Statutory late payment charges — Late Payment of Commercial Debts
 * (Interest) Act 1998, for business customers.
 *
 * For a customer's overdue invoices (the same list Reminders & statements
 * uses, from Xero and CCCS), works out:
 *   - interest: simple, at the Bank of England base rate + 8% a year, on
 *     what is still owed, from the due date (or from the end of the last
 *     interest already claimed) to today;
 *   - fixed-sum compensation, once per invoice: £40 for a debt under
 *     £1,000, £70 under £10,000, £100 above.
 * "Raise charge invoice" puts the chosen amounts on one DRAFT invoice, with
 * no VAT (statutory interest and compensation are outside the scope of
 * VAT): in Xero when the customer is a Xero contact, otherwise in CCCS. It
 * is only a draft, to check and send as normal. What's been claimed is
 * kept, so nothing is claimed twice; a record can be removed if its draft
 * is deleted.
 *
 * The base rate is entered by an admin: the Act uses the rate on 31
 * December for January to June, and on 30 June for July to December.
 *
 * Who: admins and FINANCE; the base rate and removing a record, admins.
 */
'use strict';

const crypto = require('crypto');

module.exports = function registerLateCharges({ route, httpError, ADMIN, FINANCE, db, nextId, logEvent, xero, chasers, flushNow = () => {}, now = () => Date.now() }) {
  if (!Array.isArray(db.late_charges)) db.late_charges = [];
  const MONEY = [...ADMIN, ...FINANCE];
  const STATUTORY_MARGIN = 8;
  const r2 = (n) => Math.round(n * 100) / 100;
  const money = (n) => `£${Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const sd = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(now()));
  const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

  function settings() {
    if (!Array.isArray(db.ui_settings)) db.ui_settings = [];
    let r = db.ui_settings.find((x) => x.key === 'late_charges');
    if (!r) { r = { key: 'late_charges', settings: {} }; db.ui_settings.push(r); }
    r.settings = { base_rate: null, base_rate_set_at: null, base_rate_by: null, pay_within_days: 14, ...(r.settings || {}) };
    return r.settings;
  }
  const compensationFor = (debt) => (debt < 1000 ? 40 : debt < 10000 ? 70 : 100);
  /** Item keys of invoices that are themselves late charges: no interest on interest. */
  const chargeKeys = () => new Set(db.late_charges.map((c) => c.charge_item_key).filter(Boolean));

  /** What could be claimed on each of a customer's overdue invoices today. */
  function workOut(g, st = settings()) {
    const t = today(), rate = st.base_rate == null ? null : r2(Number(st.base_rate) + STATUTORY_MARGIN);
    const skip = chargeKeys();
    const items = [];
    for (const it of g.overdue) {
      const cccs = it.cccs_invoice_id && (db.invoices || []).find((i) => i.id === it.cccs_invoice_id);
      if (skip.has(it.key) || (cccs && cccs.late_charge) || it.reference === 'Late payment charges') continue;
      const lines = db.late_charges.flatMap((c) => c.lines.filter((l) => l.item_key === it.key));
      const interestTo = lines.filter((l) => l.kind === 'interest').map((l) => l.to).sort().pop();
      const from = interestTo && interestTo > it.due_date ? interestTo : it.due_date;
      const days = Math.max(0, daysBetween(from, t));
      const interest = rate == null ? null : r2(it.amount_due * rate / 100 * days / 365);
      const claimed = lines.some((l) => l.kind === 'compensation');
      items.push({ key: it.key, number: it.number, due_date: it.due_date, days_overdue: it.days_overdue, principal: it.amount_due,
        interest: { from, to: t, days, rate, amount: interest }, compensation: { amount: compensationFor(it.amount_due), claimed } });
    }
    return items;
  }
  const target = (g) => (g.xero_contact_id && xero && xero.connected && xero.connected() ? 'xero' : (g.client_id ? 'cccs' : null));

  async function group(key) {
    const g = (await chasers.collect({ withEmails: false })).find((x) => x.key === key);
    if (!g) throw httpError(404, 'nothing is owed by that customer now');
    return g;
  }
  const wrap = (fn) => async (ctx) => { try { return await fn(ctx); } catch (e) { if (e.status) throw e; throw httpError(502, e.message); } };

  route('GET', '/api/late-charges/:key', MONEY, wrap(async ({ params }) => {
    const g = await group(params.key), st = settings();
    return { name: g.name, key: g.key, target: target(g), settings: st, margin: STATUTORY_MARGIN, items: workOut(g, st), history: db.late_charges.filter((c) => c.group_key === g.key).slice().reverse() };
  }));
  route('PUT', '/api/late-charges/settings', ADMIN, ({ body, user }) => {
    const st = settings();
    if ('base_rate' in body) {
      const v = Number(body.base_rate);
      if (body.base_rate === '' || body.base_rate === null || !Number.isFinite(v) || v < 0 || v > 25) throw httpError(400, 'Bank of England base rate: a percentage, e.g. 4.25');
      st.base_rate = r2(v); st.base_rate_set_at = new Date(now()).toISOString(); st.base_rate_by = user.display_name;
    }
    if ('pay_within_days' in body) { const n = Number(body.pay_within_days); if (!Number.isInteger(n) || n < 0 || n > 90) throw httpError(400, 'pay within: 0 to 90 days'); st.pay_within_days = n; }
    flushNow();
    return st;
  });
  /** body.include: [{ key, interest: bool, compensation: bool }] */
  route('POST', '/api/late-charges/:key', MONEY, wrap(async ({ params, body, user }) => {
    const g = await group(params.key), st = settings();
    const where = target(g);
    if (!where) throw httpError(409, 'this customer is not a CCCS client and Xero is not connected, so there is nowhere to raise the invoice');
    const want = new Map((Array.isArray(body.include) ? body.include : []).map((x) => [String(x.key), x]));
    const lines = [];
    for (const it of workOut(g, st)) {
      const w = want.get(it.key);
      if (!w) continue;
      if (w.interest) {
        if (it.interest.amount == null) throw httpError(409, 'set the Bank of England base rate first');
        if (it.interest.amount > 0) lines.push({ item_key: it.key, number: it.number, kind: 'interest', from: it.interest.from, to: it.interest.to, days: it.interest.days, rate: it.interest.rate, principal: it.principal, amount: it.interest.amount,
          description: `Statutory interest on invoice ${it.number}: ${money(it.principal)} at ${it.interest.rate.toFixed(2)}% a year (Bank of England base rate ${Number(st.base_rate).toFixed(2)}% + 8%), ${sd(it.interest.from)} to ${sd(it.interest.to)}, ${it.interest.days} days. Late Payment of Commercial Debts (Interest) Act 1998.` });
      }
      if (w.compensation && !it.compensation.claimed) lines.push({ item_key: it.key, number: it.number, kind: 'compensation', principal: it.principal, amount: it.compensation.amount,
        description: `Fixed-sum compensation for late payment of invoice ${it.number} (debt of ${money(it.principal)}). Late Payment of Commercial Debts (Interest) Act 1998, section 5A.` });
    }
    if (!lines.length) throw httpError(400, 'nothing to charge: tick the interest or compensation to claim');
    const total = r2(lines.reduce((n, l) => n + l.amount, 0));
    const t = today(), due = addDays(t, st.pay_within_days);
    const rec = { id: nextId('late_charges'), at: new Date(now()).toISOString(), by: user.display_name, group_key: g.key, name: g.name, target: where, lines, total };
    if (where === 'xero') {
      const x = await xero.createDraftInvoice({ contactId: g.xero_contact_id, date: t, dueDate: due, reference: 'Late payment charges', lines });
      Object.assign(rec, { xero_invoice_id: x.invoice_id, number: x.number, charge_item_key: `x-${x.invoice_id}` });
    } else {
      const id = nextId('invoices');
      const client = (db.clients || []).find((c) => c.id === g.client_id);
      const inv = {
        id, reference: `LATE/${String(id).padStart(4, '0')}`, status: 'DRAFT', contract_id: null, contract_reference: 'Late payment charges', contract_ids: [],
        client_id: g.client_id, client_name: client ? client.name : g.name, site_id: null, site_name: 'Late payment charges',
        period_from: t, period_to: t, issue_date: t, due_date: due, vat_rate: 0, billing_basis: null,
        lines: lines.map((l) => ({ id: crypto.randomUUID(), kind: 'MANUAL', description: l.description, quantity: 1, unit_amount: l.amount, amount: l.amount })),
        checks: [], notes: 'Statutory interest and compensation under the Late Payment of Commercial Debts (Interest) Act 1998. Outside the scope of VAT.',
        subtotal: total, vat: 0, total, created_at: rec.at, created_by: user.display_name, history: [{ at: rec.at, by: user.display_name, what: 'late payment charges raised' }], xero: null, additional: true, late_charge: true,
      };
      db.invoices.push(inv);
      Object.assign(rec, { cccs_invoice_id: id, charge_item_key: `c-${id}` });
    }
    db.late_charges.push(rec);
    logEvent('invoice.late_charge', `LATE PAYMENT CHARGES ${money(total)} RAISED FOR ${g.name.toUpperCase()} BY ${user.display_name} (DRAFT IN ${where.toUpperCase()})`, {});
    flushNow();
    return rec;
  }));
  /** Forget a charge (e.g. its draft was deleted), so it can be claimed again. */
  route('DELETE', '/api/late-charges/records/:id', ADMIN, ({ params, user }) => {
    const i = db.late_charges.findIndex((c) => c.id === Number(params.id));
    if (i < 0) throw httpError(404, 'not found');
    const [c] = db.late_charges.splice(i, 1);
    logEvent('invoice.late_charge_removed', `LATE PAYMENT CHARGE RECORD FOR ${c.name.toUpperCase()} (${money(c.total)}) REMOVED BY ${user.display_name}`, {});
    flushNow();
    return { ok: true };
  });

  return { workOut, settings, compensationFor };
};
