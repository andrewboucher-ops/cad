/**
 * Invoicing — built from signed contracts and the hours actually worked.
 *
 * GENERATE for a period (a week or a month): one DRAFT invoice per signed
 * contract that was running in it (and has no invoice for an overlapping
 * period already). Its lines come from the contract:
 *   HOURLY        hours × rate. Hours are from the shifts at the contract's
 *                 site in the period (only one shift type if the line says
 *                 so), per person:
 *                   HOURS_WORKED — clocked in to clocked out, minus breaks;
 *                                  a shift with no clock-out is listed as
 *                                  "to check" and counts 0 until fixed
 *                   ROSTERED     — rostered length minus the unpaid break
 *   FIXED_PERIOD  the amount, once per invoice
 *   ONE_OFF       the amount, on the contract's first invoice only
 * Every hourly line keeps the shifts it came from, so the invoice can be
 * checked against the timesheet before it goes anywhere.
 *
 * Then: review (edit lines, add a manual line) → APPROVE, which gives it
 * its invoice number (sequential — prefix and next number in the invoice
 * settings, so it can carry on from an existing series; drafts have no
 * number, so voiding a draft leaves no gap) → it is emailed to the client
 * with the PDF attached (unless the settings say Xero sends it, or nobody
 * does) and appears in their portal → SEND TO XERO (same number there) →
 * the Xero status is read back (PAID…), or it is marked paid by hand.
 * VOID at any point before paid.
 *
 * Who: admins and the FINANCE role. Xero connect/disconnect: admins.
 *
 * Registrar pattern — server.js passes in what this needs.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Doc, A4 } = require('./pdf.js');

module.exports = function registerInvoices({
  route, httpError, ADMIN, FINANCE, CLIENT = ['CLIENT'], db, nextId, logEvent, attendance, agreements, xero, sendEmail = null, publicBaseUrl = '', flushNow = () => {},
}) {
  if (!Array.isArray(db.invoices)) db.invoices = [];
  const MONEY = [...ADMIN, ...FINANCE];
  const r2 = (n) => Math.round(n * 100) / 100;
  const findInv = (id) => { const i = db.invoices.find((x) => x.id === Number(id)); if (!i) throw httpError(404, 'invoice not found'); return i; };
  const span = (a, b) => { const f = (d, o) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', o); return a === b ? f(a, { day: 'numeric', month: 'short', year: 'numeric' }) : `${f(a, { day: 'numeric', month: 'short' })} – ${f(b, { day: 'numeric', month: 'short', year: 'numeric' })}`; };
  const money = (n) => `£${Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const longDate = (d) => (d ? new Date(String(d).length === 10 ? `${d}T12:00:00Z` : d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '—');
  const today = () => new Date().toISOString().slice(0, 10);

  /* ---- invoice settings (ui_settings key "invoice") ---- */
  const DEFAULTS = {
    prefix: 'INV-', next_number: 1, digits: 4, send_via: 'CCCS', // CCCS | XERO | NONE
    bank_name: '', account_name: '', sort_code: '', account_number: '', vat_number: '', company_number: '',
    footer: 'Thank you for your business.', include_timesheet: true,
  };
  function settingsRow() {
    if (!Array.isArray(db.ui_settings)) db.ui_settings = [];
    let r = db.ui_settings.find((x) => x.key === 'invoice');
    if (!r) { r = { key: 'invoice', settings: {} }; db.ui_settings.push(r); }
    r.settings = { ...DEFAULTS, ...(r.settings || {}) };
    return r.settings;
  }
  const company = () => {
    const r = (db.ui_settings || []).find((x) => x.key === 'rental') || {};
    return { company_name: r.company_name || 'Echelon', company_address: r.company_address || '', company_phone: r.company_phone || '', company_email: r.company_email || '' };
  };
  const clientOf = (inv) => (db.clients || []).find((c) => c.id === inv.client_id) || null;
  const billTo = (c) => (c ? c.billing_email || c.contact_email || '' : '');
  function takeNumber() {
    const st = settingsRow();
    let n = Math.max(1, Number(st.next_number) || 1), num;
    do { num = `${st.prefix}${String(n).padStart(st.digits, '0')}`; n++; } while (db.invoices.some((i) => i.number === num));
    st.next_number = n;
    return num;
  }

  /* ---- the PDF ---- */
  // Same brand language as the printed marketing material and the client
  // welcome email: a dark navy band, amber accent. The PDF writer (pdf.js)
  // only draws rects/text/images at explicit coordinates, so the band is
  // drawn by hand before anything else, and doc.y is reset below it — the
  // rest of the document (pairs/table/para) still flows normally.
  const NAVY = [0.047, 0.086, 0.141], AMBER = [0.949, 0.663, 0.235], WHITE = [1, 1, 1], LIGHT = [0.78, 0.82, 0.88];
  function invoicePdf(inv) {
    const c = company(), st = settingsRow(), client = clientOf(inv) || {};
    const grey = [0.35, 0.38, 0.42];
    const doc = new Doc({ footer: `${c.company_name} — invoice ${inv.number || '(draft)'}` });
    const bandH = 112;
    doc.rect(0, A4.h - bandH, A4.w, bandH, { fill: NAVY, stroke: null });
    // The wordmark is white-on-transparent (public/assets/echelon-wordmark.png,
    // used as-is in HTML emails) — pdf.js's Doc only embeds JPEGs (DCTDecode),
    // so a copy pre-flattened onto this same navy is kept alongside it
    // specifically for PDFs. Falls back to the text name if that file is
    // ever missing, same safety the welcome email's logo attachment has.
    const logoFile = path.join(__dirname, 'public', 'assets', 'echelon-wordmark-navy.jpg');
    if (fs.existsSync(logoFile)) {
      doc.y = A4.h - 32;
      doc.image(fs.readFileSync(logoFile), { maxH: 20, maxW: 170, x: doc.margin });
    } else {
      doc.text(c.company_name.toUpperCase(), doc.margin, A4.h - 42, { size: 17, bold: true, color: WHITE });
    }
    const contact = [c.company_address, c.company_phone, c.company_email].filter(Boolean).join('  ·  ');
    if (contact) doc.text(contact, doc.margin, A4.h - 66, { size: 8.5, color: LIGHT });
    const label = inv.status === 'DRAFT' ? 'DRAFT INVOICE' : inv.status === 'VOID' ? 'INVOICE — VOID' : 'INVOICE';
    const rightEdge = A4.w - doc.margin;
    doc.text(label, rightEdge - doc.textWidth(label, 10, true), A4.h - 36, { size: 10, bold: true, color: AMBER });
    const numStr = inv.number || '(given when approved)';
    doc.text(numStr, rightEdge - doc.textWidth(numStr, 14, true), A4.h - 54, { size: 14, bold: true, color: WHITE });
    const dueStr = `Due ${longDate(inv.due_date)}`;
    doc.text(dueStr, rightEdge - doc.textWidth(dueStr, 9), A4.h - 70, { size: 9, color: LIGHT });
    doc.y = A4.h - bandH - 26;

    doc.pairs([
      ['Invoice date', longDate(inv.issue_date)],
      ['Bill to', [client.name || inv.client_name, client.billing_address].filter(Boolean).join('\n')],
      ['Site', inv.site_name], ['Period', span(inv.period_from, inv.period_to)], ['Contract', inv.contract_reference],
      ...(st.vat_number ? [['Our VAT number', st.vat_number]] : []),
    ]);
    doc.table([{ title: 'Description', width: 0.55 }, { title: 'Qty', width: 0.13, align: 'right' }, { title: 'Unit price', width: 0.16, align: 'right' }, { title: 'Amount', width: 0.16, align: 'right' }],
      inv.lines.map((l) => [l.description, String(l.quantity), money(l.unit_amount), money(l.amount)]));
    const total = (label, value, bold = false) => {
      doc.room(16); doc.y -= 14;
      doc.text(label, doc.margin + doc.width * 0.55, doc.y, { size: 10, bold });
      doc.text(value, doc.margin + doc.width - 4 - doc.textWidth(value, 10, bold), doc.y, { size: 10, bold });
    };
    total('Net', money(inv.subtotal)); total(`VAT at ${inv.vat_rate}%`, money(inv.vat));
    doc.room(30); doc.y -= 6;
    doc.rect(doc.margin, doc.y - 20, doc.width, 24, { fill: NAVY, stroke: null });
    doc.text('Total due', doc.margin + 10, doc.y - 14, { size: 11, bold: true, color: WHITE });
    const totalStr = money(inv.total);
    doc.text(totalStr, doc.margin + doc.width - 10 - doc.textWidth(totalStr, 11, true), doc.y - 14, { size: 11, bold: true, color: AMBER });
    doc.y -= 30;
    if (inv.status === 'PAID') doc.para('PAID — thank you', { size: 13, bold: true, color: [0.09, 0.55, 0.27], gap: 6 });
    if (inv.notes) { doc.heading('Notes', 11); doc.para(inv.notes, { size: 9.5 }); }
    if (inv.status !== 'PAID' && (st.account_number || st.sort_code)) {
      const rows = [['Bank', st.bank_name], ['Account name', st.account_name || c.company_name], ['Sort code', st.sort_code], ['Account number', st.account_number], ['Reference', inv.number || '—']].filter(([, v]) => v);
      const padX = 14, rowGap = 13.5, rowH = rows.length * rowGap + 30;
      doc.room(rowH + 10); doc.y -= 6;
      const top = doc.y;
      doc.rect(doc.margin, top - rowH, doc.width, rowH, { fill: [0.99, 0.95, 0.87], stroke: null });
      doc.rect(doc.margin, top - rowH, 3, rowH, { fill: AMBER, stroke: null });
      doc.text('HOW TO PAY', doc.margin + padX, top - 16, { size: 9, bold: true, color: [0.7, 0.47, 0.1] });
      rows.forEach(([label, value], i) => {
        const ry = top - 32 - i * rowGap;
        doc.text(label, doc.margin + padX, ry, { size: 9, color: grey });
        doc.text(value, doc.margin + padX + 110, ry, { size: 9.5 });
      });
      doc.y = top - rowH - 6;
    }
    if (st.footer) doc.para(st.footer, { size: 9.5, color: grey, gap: 4 });
    if (st.company_number) doc.para(`Registered in England and Wales, company number ${st.company_number}.`, { size: 8.5, color: grey });
    const hourly = inv.lines.filter((l) => l.shifts && l.shifts.length);
    if (st.include_timesheet && hourly.length) {
      doc.heading(`Hours breakdown (${inv.billing_basis === 'ROSTERED' ? 'hours rostered' : 'hours worked'})`, 11);
      for (const l of hourly) {
        if (hourly.length > 1) doc.para(l.description, { size: 9, bold: true, gap: 2 });
        doc.table([{ title: 'Date', width: 0.2 }, { title: 'Officer', width: 0.4 }, { title: 'Shift', width: 0.25 }, { title: 'Hours', width: 0.15, align: 'right' }],
          l.shifts.map((x) => [longDate(x.date), x.person, `${new Date(x.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })}–${new Date(x.ends_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })}`, String(x.hours)]), { size: 8.5 });
      }
    }
    return doc.toBuffer();
  }
  const pdfOut = (inv) => ({ __body: invoicePdf(inv), __headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${inv.number || 'draft-invoice'}.pdf"`, 'cache-control': 'private, no-store' } });

  /* ---- email to the client, PDF attached ---- */
  function emailInvoice(inv, by) {
    if (!inv.emails) inv.emails = [];
    const client = clientOf(inv), to = billTo(client);
    const log = (e) => { inv.emails.push({ at: new Date().toISOString(), by, ...e }); };
    if (!sendEmail) return;
    if (!to) { log({ ok: false, error: 'the client has no billing or contact email (Admin → Clients)' }); return; }
    const c = company(), st = settingsRow();
    const pay = st.account_number ? `<p>Please pay by bank transfer to ${st.account_name || c.company_name}, sort code ${st.sort_code}, account ${st.account_number}, quoting <strong>${inv.number}</strong>.</p>` : '';
    const html = `<p>Hello,</p><p>Please find attached invoice <strong>${inv.number}</strong> for ${inv.site_name}, ${span(inv.period_from, inv.period_to)}: <strong>${money(inv.total)}</strong> including VAT, due by ${longDate(inv.due_date)}.</p>${pay}
      <p>Your invoices are also in your client portal: <a href="${publicBaseUrl}/client.html">${publicBaseUrl}/client.html</a></p><p>Kind regards,<br>${c.company_name}</p>`;
    Promise.resolve(sendEmail(to, `Invoice ${inv.number} from ${c.company_name}`, html, { attachments: [{ name: `${inv.number}.pdf`, contentType: 'application/pdf', content: invoicePdf(inv) }] }))
      .then((r) => { log({ to, ok: Boolean(r && r.ok), error: r && !r.ok ? String(r.error || '').slice(0, 200) : null }); if (r && r.ok) inv.history.push({ at: new Date().toISOString(), by, what: `emailed to ${to}` }); flushNow(); })
      .catch((e) => log({ to, ok: false, error: e.message }));
  }

  const dayStart = (d) => new Date(`${d}T00:00:00.000Z`).getTime();

  /** Hours for one HOURLY line in [from, to]: per shift, per person. */
  function hoursFor(contract, line, from, to) {
    const t0 = dayStart(from), t1 = dayStart(to) + 86400000;
    const shifts = db.shifts.filter((s) => s.site_id === contract.site_id && s.status !== 'CANCELLED' && s.status !== 'DRAFT'
      && Date.parse(s.starts_at) >= t0 && Date.parse(s.starts_at) < t1 && (!line.shift_type_id || s.shift_type_id === line.shift_type_id));
    const rows = [];
    for (const s of shifts) {
      for (const a of db.shift_assignments.filter((x) => x.shift_id === s.id && ['ASSIGNED', 'CONFIRMED'].includes(x.status))) {
        const p = db.personnel.find((x) => x.id === a.personnel_id);
        let hours = 0, source;
        if (contract.billing_basis === 'ROSTERED') {
          hours = Math.max(0, (Date.parse(s.ends_at) - Date.parse(s.starts_at)) / 3600000 - (Number(s.break_minutes) || 0) / 60);
          source = 'rostered';
        } else if (a.clocked_in_at && a.clocked_out_at) {
          hours = attendance.worked(a).worked_min / 60; source = 'clocked';
        } else if (a.attendance === 'NO_SHOW') {
          source = 'no-show';
        } else {
          source = Date.parse(s.ends_at) > Date.now() ? 'not finished' : 'to check';
        }
        rows.push({ shift_id: s.id, assignment_id: a.id, date: s.starts_at.slice(0, 10), starts_at: s.starts_at, ends_at: s.ends_at, person: p ? p.name : '—', hours: r2(hours), source });
      }
    }
    return rows.sort((x, y) => x.starts_at.localeCompare(y.starts_at));
  }
  const running = (c, from, to) => c.kind === 'CONTRACT' && ['SIGNED', 'ENDED'].includes(c.status) && c.start_date <= to && (!c.end_date || c.end_date >= from);
  const overlaps = (i, from, to) => i.status !== 'VOID' && i.period_from <= to && i.period_to >= from;
  function totals(inv) {
    for (const l of inv.lines) l.amount = r2(l.quantity * l.unit_amount);
    inv.subtotal = r2(inv.lines.reduce((n, l) => n + l.amount, 0));
    inv.vat = r2(inv.subtotal * inv.vat_rate / 100);
    inv.total = r2(inv.subtotal + inv.vat);
  }
  function build(c, from, to, user) {
    const client = (db.clients || []).find((x) => x.id === c.client_id);
    const site = db.sites.find((s) => s.id === c.site_id);
    const first = !db.invoices.some((i) => i.contract_id === c.id && i.status !== 'VOID');
    const lines = [], checks = [];
    for (const l of c.lines) {
      if (l.kind === 'HOURLY') {
        const rows = hoursFor(c, l, from, to);
        const hours = r2(rows.reduce((n, x) => n + x.hours, 0));
        for (const x of rows) if (x.source === 'to check') checks.push(`${x.person} on ${x.date}: no clock-out — counted as 0 hours`);
        lines.push({ id: crypto.randomUUID(), description: `${l.description}${l.shift_type_name ? ` (${l.shift_type_name})` : ''} — hours, ${span(from, to)}`, kind: 'HOURLY', quantity: hours, unit_amount: l.rate, shifts: rows });
      } else if (l.kind === 'FIXED_PERIOD') {
        lines.push({ id: crypto.randomUUID(), description: `${l.description}, ${span(from, to)}`, kind: l.kind, quantity: 1, unit_amount: l.rate });
      } else if (first) {
        lines.push({ id: crypto.randomUUID(), description: l.description, kind: l.kind, quantity: 1, unit_amount: l.rate });
      }
    }
    const id = nextId('invoices'), issue = new Date().toISOString().slice(0, 10);
    const inv = {
      id, reference: `${c.reference}/${String(id).padStart(4, '0')}`, status: 'DRAFT', contract_id: c.id, contract_reference: c.reference,
      client_id: c.client_id, client_name: client ? client.name : '—', site_id: c.site_id, site_name: site ? site.name : '—',
      period_from: from, period_to: to, issue_date: issue, due_date: new Date(Date.parse(issue) + (c.payment_terms_days || 30) * 86400000).toISOString().slice(0, 10),
      vat_rate: c.vat_rate, billing_basis: c.billing_basis, lines, checks, notes: '',
      created_at: new Date().toISOString(), created_by: user.display_name, history: [{ at: new Date().toISOString(), by: user.display_name, what: 'generated from the contract' }],
      xero: null,
    };
    totals(inv);
    return inv;
  }

  route('POST', '/api/invoices/generate', MONEY, ({ body, user }) => {
    const from = String(body.from || ''), to = String(body.to || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) throw httpError(400, 'choose the period (from and to dates)');
    const contracts = (db.agreements || []).filter((c) => running(c, from, to)
      && (!body.contract_id || c.id === Number(body.contract_id))
      && (!body.site_id || c.site_id === Number(body.site_id)));
    if (body.contract_id && !contracts.length) throw httpError(400, 'that contract is not signed or was not running in this period');
    if (body.site_id && !body.contract_id && !contracts.length) throw httpError(400, 'that site has no signed contract running in this period');
    const made = [], skipped = [];
    for (const c of contracts) {
      if (!c.client_id) { skipped.push({ contract: c.reference, reason: 'no client' }); continue; }
      const clash = db.invoices.find((i) => i.contract_id === c.id && overlaps(i, from, to));
      if (clash) { skipped.push({ contract: c.reference, reason: `already invoiced (${clash.reference}, ${clash.period_from} to ${clash.period_to})` }); continue; }
      const inv = build(c, from, to, user);
      if (!inv.lines.length) { skipped.push({ contract: c.reference, reason: 'nothing to charge in this period' }); continue; }
      db.invoices.push(inv); made.push(inv);
    }
    if (made.length) logEvent('invoice.generated', `${made.length} INVOICE(S) GENERATED FOR ${from} TO ${to} BY ${user.display_name}`, {});
    flushNow();
    return { made, skipped };
  });
  route('GET', '/api/invoices', MONEY, ({ query }) => {
    const st = query.get('status');
    return db.invoices.filter((i) => !st || i.status === st).slice().reverse().map((i) => ({ ...i, lines: i.lines.map(({ shifts, ...l }) => ({ ...l, shift_count: shifts ? shifts.length : 0 })) }));
  });
  route('GET', '/api/invoices/settings', MONEY, () => ({ ...settingsRow(), company: company() }));
  route('PUT', '/api/invoices/settings', ADMIN, ({ body }) => {
    const st = settingsRow();
    const str = (k, max = 120) => { if (k in body) st[k] = String(body[k] ?? '').trim().slice(0, max); };
    ['bank_name', 'account_name', 'vat_number', 'company_number'].forEach((k) => str(k));
    str('footer', 500);
    if ('sort_code' in body) { const v = String(body.sort_code || '').replace(/\s/g, ''); if (v && !/^\d{2}-?\d{2}-?\d{2}$/.test(v)) throw httpError(400, 'sort code should be 6 digits, e.g. 12-34-56'); st.sort_code = v; }
    if ('account_number' in body) { const v = String(body.account_number || '').replace(/\s/g, ''); if (v && !/^\d{6,10}$/.test(v)) throw httpError(400, 'account number should be 8 digits'); st.account_number = v; }
    if ('prefix' in body) { const v = String(body.prefix ?? '').trim(); if (!/^[A-Za-z0-9/-]{0,12}$/.test(v)) throw httpError(400, 'number prefix: letters, digits, - or / only'); st.prefix = v; }
    if ('next_number' in body) { const v = Number(body.next_number); if (!Number.isInteger(v) || v < 1) throw httpError(400, 'next number must be a whole number'); st.next_number = v; }
    if ('send_via' in body) st.send_via = ['CCCS', 'XERO', 'NONE'].includes(body.send_via) ? body.send_via : 'CCCS';
    if ('include_timesheet' in body) st.include_timesheet = Boolean(body.include_timesheet);
    flushNow();
    return { ...st, company: company() };
  });
  route('GET', '/api/invoices/:id/pdf', MONEY, ({ params }) => pdfOut(findInv(params.id)));
  route('POST', '/api/invoices/:id/email', MONEY, ({ params, user }) => {
    const inv = findInv(params.id);
    if (!inv.number || inv.status === 'VOID') throw httpError(409, 'approve it first');
    emailInvoice(inv, user.display_name);
    return inv;
  });
  route('POST', '/api/invoices/:id/paid', MONEY, ({ params, body, user }) => {
    const inv = findInv(params.id);
    if (inv.xero && inv.xero.invoice_id) throw httpError(409, 'it is in Xero — record the payment there, then press "Check Xero"');
    if (inv.status !== 'APPROVED') throw httpError(409, 'only an approved invoice can be marked paid');
    inv.status = 'PAID'; inv.paid_at = new Date().toISOString();
    inv.history.push({ at: inv.paid_at, by: user.display_name, what: `marked paid${body.note ? ` — ${String(body.note).slice(0, 200)}` : ''}` });
    flushNow();
    return inv;
  });

  /* ---- the client portal: issued invoices only ---- */
  const CLIENT_OR_ADMIN = [...CLIENT, 'SYSTEM_ADMIN'];
  function portalClient(user, query) {
    if (user.role === 'SYSTEM_ADMIN') { const c = (db.clients || []).find((x) => x.id === Number(query.get('as_client'))); if (!c) throw httpError(404, 'client not found'); return c; }
    const c = (db.clients || []).find((x) => x.id === user.client_id); if (!c) throw httpError(403, 'no client is linked to this login'); return c;
  }
  const issued = (i) => ['APPROVED', 'IN_XERO', 'PAID'].includes(i.status);
  route('GET', '/api/client/invoices', CLIENT_OR_ADMIN, ({ user, query }) => {
    const c = portalClient(user, query);
    return db.invoices.filter((i) => i.client_id === c.id && issued(i)).slice().reverse().map((i) => ({
      id: i.id, number: i.number, site_name: i.site_name, period_from: i.period_from, period_to: i.period_to, issue_date: i.issue_date, due_date: i.due_date,
      total: i.total, paid: i.status === 'PAID', overdue: i.status !== 'PAID' && i.due_date < today(), pdf_url: `/api/client/invoices/${i.id}/pdf`,
    }));
  });
  route('GET', '/api/client/invoices/:id/pdf', CLIENT_OR_ADMIN, ({ params, user, query }) => {
    const c = portalClient(user, query);
    const i = db.invoices.find((x) => x.id === Number(params.id));
    if (!i || i.client_id !== c.id || !issued(i)) throw httpError(404, 'not found');
    return pdfOut(i);
  });
  route('GET', '/api/invoices/:id', MONEY, ({ params }) => findInv(params.id));
  route('PATCH', '/api/invoices/:id', MONEY, ({ params, body, user }) => {
    const inv = findInv(params.id);
    if (inv.status !== 'DRAFT') throw httpError(409, 'only a draft invoice can be changed');
    if (Array.isArray(body.lines)) {
      inv.lines = body.lines.map((l, n) => {
        const was = inv.lines.find((x) => x.id === l.id);
        const description = String(l.description || '').trim().slice(0, 300); if (!description) throw httpError(400, `line ${n + 1}: description required`);
        const q = Number(l.quantity), u = Number(l.unit_amount);
        if (!Number.isFinite(q) || !Number.isFinite(u)) throw httpError(400, `line ${n + 1}: quantity and price must be numbers`);
        return { ...(was || { id: crypto.randomUUID(), kind: 'MANUAL' }), description, quantity: r2(q), unit_amount: r2(u) };
      });
    }
    if ('notes' in body) inv.notes = String(body.notes || '').slice(0, 2000);
    if ('due_date' in body && /^\d{4}-\d{2}-\d{2}$/.test(String(body.due_date))) inv.due_date = body.due_date;
    totals(inv);
    inv.history.push({ at: new Date().toISOString(), by: user.display_name, what: 'edited' });
    return inv;
  });
  route('POST', '/api/invoices/:id/approve', MONEY, ({ params, user }) => {
    const inv = findInv(params.id);
    if (inv.status !== 'DRAFT') throw httpError(409, 'only a draft can be approved');
    if (!inv.lines.length || inv.total <= 0) throw httpError(400, 'there is nothing to invoice');
    inv.status = 'APPROVED'; inv.approved_by = user.display_name; inv.approved_at = new Date().toISOString();
    // Issued today: the due date moves with it, keeping the same terms.
    const terms = Math.round((Date.parse(inv.due_date) - Date.parse(inv.issue_date)) / 86400000);
    inv.issue_date = today(); inv.due_date = new Date(Date.parse(inv.issue_date) + terms * 86400000).toISOString().slice(0, 10);
    inv.number = takeNumber();
    inv.history.push({ at: inv.approved_at, by: user.display_name, what: `approved as ${inv.number}` });
    logEvent('invoice.approved', `INVOICE ${inv.number} APPROVED (£${inv.total.toFixed(2)})`, { invoice_id: inv.id });
    if (settingsRow().send_via === 'CCCS') emailInvoice(inv, user.display_name);
    flushNow();
    return inv;
  });
  route('POST', '/api/invoices/:id/void', MONEY, ({ params, body, user }) => {
    const inv = findInv(params.id);
    if (inv.status === 'PAID') throw httpError(409, 'a paid invoice cannot be voided here — credit it in Xero');
    if (inv.status === 'VOID') throw httpError(409, 'already void');
    if (inv.xero && inv.xero.invoice_id) throw httpError(409, 'it is in Xero — void it there, then press "Check Xero"');
    inv.status = 'VOID'; inv.history.push({ at: new Date().toISOString(), by: user.display_name, what: `voided${body.reason ? ` — ${String(body.reason).slice(0, 200)}` : ''}` });
    flushNow();
    return inv;
  });
  route('POST', '/api/invoices/:id/xero', MONEY, async ({ params, user }) => {
    const inv = findInv(params.id);
    if (inv.status !== 'APPROVED') throw httpError(409, 'approve the invoice first');
    if (inv.xero && inv.xero.invoice_id) throw httpError(409, 'already in Xero');
    const client = (db.clients || []).find((c) => c.id === inv.client_id);
    if (!client) throw httpError(400, 'the client for this invoice no longer exists');
    try {
      const viaXero = settingsRow().send_via === 'XERO';
      const x = await xero.pushInvoice(inv, client, viaXero ? { status: 'AUTHORISED' } : {});
      inv.xero = { ...x, sent_at: new Date().toISOString(), sent_by: user.display_name };
      inv.status = 'IN_XERO';
      inv.history.push({ at: inv.xero.sent_at, by: user.display_name, what: `sent to Xero${x.number ? ` as ${x.number}` : ''}` });
      if (viaXero) {
        // Xero emails it to the contact, from Xero, with its own PDF and pay link.
        try { await xero.emailInvoice(x.invoice_id); inv.history.push({ at: new Date().toISOString(), by: user.display_name, what: 'emailed to the client by Xero' }); }
        catch (e) { inv.history.push({ at: new Date().toISOString(), by: user.display_name, what: `Xero could not email it: ${e.message}` }); }
      }
      logEvent('invoice.xero', `INVOICE ${inv.reference} SENT TO XERO${x.number ? ` (${x.number})` : ''}`, { invoice_id: inv.id });
      flushNow();
      return inv;
    } catch (e) { throw httpError(502, e.message); }
  });
  /** Brings one invoice up to date with what Xero says (paid, voided…). */
  function applyXero(inv, x) {
    const was = inv.status;
    Object.assign(inv.xero, { status: x.status, number: x.number || inv.xero.number, amount_due: x.amount_due, amount_paid: x.amount_paid, checked_at: new Date().toISOString() });
    if (x.status === 'PAID' && was !== 'PAID') { inv.status = 'PAID'; inv.paid_at = new Date().toISOString(); inv.history.push({ at: inv.paid_at, by: 'Xero', what: 'paid in Xero' }); logEvent('invoice.paid', `INVOICE ${inv.number || inv.reference} PAID (XERO)`, { invoice_id: inv.id }); }
    if ((x.status === 'VOIDED' || x.status === 'DELETED') && was !== 'VOID') { inv.status = 'VOID'; inv.history.push({ at: new Date().toISOString(), by: 'Xero', what: `${x.status.toLowerCase()} in Xero` }); }
  }
  /* Payments recorded in Xero show here on their own: every XERO_SYNC_MIN
   * minutes (default 30) every invoice in Xero and not yet paid or void is
   * checked, in batches. "Check Xero" on an invoice does it at once. */
  async function syncAll() {
    if (!xero.connected()) return { checked: 0 };
    const open = db.invoices.filter((i) => i.xero && i.xero.invoice_id && i.status === 'IN_XERO');
    if (!open.length) return { checked: 0 };
    const got = await xero.invoiceStatuses(open.map((i) => i.xero.invoice_id));
    let paid = 0;
    for (const inv of open) { const x = got[inv.xero.invoice_id]; if (x) { applyXero(inv, x); if (inv.status === 'PAID') paid++; } }
    flushNow();
    return { checked: open.length, paid };
  }
  const syncTimer = setInterval(() => syncAll().catch((e) => console.warn('[xero] sync failed:', e.message)), Number(process.env.XERO_SYNC_MIN || 30) * 60000);
  if (syncTimer.unref) syncTimer.unref();
  route('POST', '/api/invoices/xero-sync-all', MONEY, async () => { try { return await syncAll(); } catch (e) { throw httpError(502, e.message); } });
  route('POST', '/api/invoices/:id/xero-sync', MONEY, async ({ params }) => {
    const inv = findInv(params.id);
    if (!inv.xero || !inv.xero.invoice_id) throw httpError(409, 'not in Xero yet');
    try {
      const x = await xero.invoiceStatus(inv.xero.invoice_id);
      if (!x) throw new Error('Xero no longer has this invoice');
      applyXero(inv, x);
      flushNow();
      return inv;
    } catch (e) { throw httpError(502, e.message); }
  });

  /* ---- Xero connection ---- */
  const states = new Map(); // state → { user, at }
  route('GET', '/api/xero/status', MONEY, () => xero.status());
  route('GET', '/api/xero/connect', ADMIN, ({ user }) => {
    if (!xero.configured()) throw httpError(400, 'set XERO_CLIENT_ID and XERO_CLIENT_SECRET in cccs.env first (see the setup steps on this page)');
    const state = crypto.randomBytes(18).toString('hex');
    states.set(state, { user: user.display_name, at: Date.now() });
    for (const [k, v] of states) if (Date.now() - v.at > 900000) states.delete(k);
    return { url: xero.authorizeUrl(state) };
  });
  // Xero sends the browser back here. No login on this request (it comes
  // from Xero's redirect) — the one-time state ties it to the admin who
  // pressed Connect, within 15 minutes.
  route('GET', '/api/xero/callback', null, async ({ query }) => {
    const back = (msg) => ({ __status: 302, __headers: { location: `/invoices.html?xero=${encodeURIComponent(msg)}` }, __body: '' });
    const st = states.get(String(query.get('state') || ''));
    if (!st || Date.now() - st.at > 900000) return back('That Xero sign-in link expired — press Connect again.');
    states.delete(String(query.get('state')));
    if (query.get('error')) return back(`Xero said: ${query.get('error_description') || query.get('error')}`);
    try { const r = await xero.connect(String(query.get('code') || ''), st.user); logEvent('xero.connected', `XERO CONNECTED TO ${r.tenant_name.toUpperCase()} BY ${st.user}`, {}); return back('connected'); }
    catch (e) { return back(e.message); }
  });
  route('POST', '/api/xero/disconnect', ADMIN, ({ user }) => { xero.disconnect(); logEvent('xero.disconnected', `XERO DISCONNECTED BY ${user.display_name}`, {}); return xero.status(); });
  route('PUT', '/api/xero/settings', ADMIN, ({ body }) => {
    const s = xero.row().settings;
    if ('account_code' in body) { const c = String(body.account_code || '').trim(); if (!/^[A-Za-z0-9.-]{1,10}$/.test(c)) throw httpError(400, 'account code looks wrong'); s.account_code = c; }
    if ('tax_type' in body) { const t = String(body.tax_type || '').trim().toUpperCase(); if (!/^[A-Z0-9]{2,20}$/.test(t)) throw httpError(400, 'tax type looks wrong'); s.tax_type = t; }
    if ('invoice_status' in body) s.invoice_status = body.invoice_status === 'AUTHORISED' ? 'AUTHORISED' : 'DRAFT';
    flushNow();
    return xero.status();
  });

  return { hoursFor, invoicePdf, syncAll };
};
