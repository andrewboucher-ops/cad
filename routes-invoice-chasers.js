/**
 * Payment reminders and statements — chasing money that is owed.
 *
 * What is owed comes from two places, joined up per customer:
 *   - Xero (when connected): every approved sales invoice with money still
 *     due, whoever raised it. Most older invoices were raised straight in
 *     Xero, so this is where most of the debt is.
 *   - CCCS: approved invoices that have not been sent to Xero yet (and,
 *     with Xero not connected, the ones that were).
 * A CCCS client is joined to its Xero contact by xero_contact_id, or by
 * name when that isn't set.
 *
 * AUTOMATIC REMINDERS (off until an admin turns them on): once a day, on a
 * weekday after the send hour (UK time), every customer with an invoice
 * that has just passed one of the reminder points (7, 14 and 30 days
 * overdue by default) gets ONE email: a polite reminder in that stage's
 * wording, the overdue invoices listed, and a statement of everything they
 * owe attached as a PDF. Each invoice is chased once per stage. An invoice
 * already past several stages when this starts (or when a reminder was
 * held back) moves straight to the latest one, so nobody gets three emails
 * at once. A customer is never emailed twice within the "gap" (5 days by
 * default); anything due then waits. Customers can be paused.
 *
 * STATEMENTS on demand: "Send statement" emails one customer (or every
 * customer with something overdue) a statement of account, with no
 * reminder stage attached. It counts for the gap, so a reminder doesn't
 * follow two days later.
 *
 * Who: admins and the FINANCE role; the settings are admin only.
 * Registrar pattern — server.js passes in what this needs.
 */
'use strict';

const { Doc, A4 } = require('./pdf.js');

module.exports = function registerInvoiceChasers({
  route, httpError, ADMIN, FINANCE, db, nextId, logEvent, xero, invoices, sendEmail = null, publicBaseUrl = '', flushNow = () => {},
  now = () => Date.now(), tickMs = Number(process.env.INVOICE_CHASER_TICK_MS || 15 * 60000),
}) {
  if (!Array.isArray(db.invoice_chases)) db.invoice_chases = [];
  const MONEY = [...ADMIN, ...FINANCE];
  const r2 = (n) => Math.round(n * 100) / 100;
  const money = (n) => `£${Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const longDate = (d) => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '—');
  const shortDate = (d) => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isEmail = (x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x);
  const splitEmails = (v) => [...new Set(String(v || '').split(/[\s,;]+/).map((x) => x.trim()).filter(isEmail))];
  /** UK date and hour, so "9am" and "today" mean what Andy means. */
  function london(ms = now()) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' })
      .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), weekday: p.weekday };
  }
  const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);

  /* ---- settings (ui_settings key "invoice_chasers") ---- */
  const WORDING = {
    1: 'Just a friendly reminder that the invoices below are now past their due date. If you have already paid, thank you, and please ignore this email.',
    7: 'We have not yet received payment for the invoices below, and the oldest is now more than a week overdue. Please could you arrange payment, or let us know if there is a problem with any of them.',
    14: 'We have not yet received payment for the invoices below, and the oldest is now more than two weeks overdue. Please could you arrange payment, or let us know if there is a problem with any of them.',
    30: 'We still have not received payment for the invoices below, and the oldest is now more than 30 days overdue. Please arrange payment within the next 7 days, or reply to this email if there is a query so that we can sort it out.',
  };
  const DEFAULTS = {
    enabled: false, stages: [1, 7, 14, 30], send_hour: 9, weekdays_only: true, min_gap_days: 5, repeat_days: 0,
    copy_to: '', wording: { ...WORDING },
    statement_wording: 'Please find attached a statement of your account with us. The invoices listed are still open on our records. If you have already paid any of them, thank you, and please let us know so we can match the payment.',
    paused: {}, // group key -> { until: 'YYYY-MM-DD' | null, by, at, note }
    last_run_date: null, last_run_at: null, last_run_result: null,
  };
  function settings() {
    if (!Array.isArray(db.ui_settings)) db.ui_settings = [];
    let r = db.ui_settings.find((x) => x.key === 'invoice_chasers');
    if (!r) { r = { key: 'invoice_chasers', settings: {} }; db.ui_settings.push(r); }
    r.settings = { ...DEFAULTS, ...(r.settings || {}) };
    r.settings.wording = { ...WORDING, ...(r.settings.wording || {}) };
    if (!r.settings.paused || typeof r.settings.paused !== 'object') r.settings.paused = {};
    return r.settings;
  }
  const stageName = (s, st) => {
    const stages = st.stages;
    if (s === 'statement') return 'Statement';
    const i = stages.indexOf(s);
    if (i === stages.length - 1 && stages.length > 1) return 'Final reminder';
    if (i <= 0) return 'Reminder';
    return `${['Second', 'Third', 'Fourth', 'Fifth'][i - 1] || 'Further'} reminder`;
  };

  /* ---- what is owed, per customer ---- */
  const clientName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  /** Every customer with money outstanding. Throws if Xero is connected
   * but couldn't be read: reminders must never go out on stale data (an
   * invoice paid this morning would be chased). */
  async function collect({ withEmails = true } = {}) {
    const today = london().date;
    const xc = Boolean(xero && xero.connected && xero.connected());
    const groups = new Map();
    const clients = db.clients || [];
    const group = (key, init) => { if (!groups.has(key)) groups.set(key, { key, items: [], ...init }); return groups.get(key); };
    const xeroNumbers = new Set();
    if (xc) {
      let list;
      try { list = await xero.outstandingInvoices(); } catch (e) { throw new Error(`could not read what is owed from Xero (${e.message})`); }
      for (const x of list) {
        if (!x.contact_id) continue;
        const client = clients.find((c) => c.xero_contact_id === x.contact_id) || clients.find((c) => !c.xero_contact_id && clientName(c.name) === clientName(x.contact_name)) || null;
        const g = group(`x-${x.contact_id}`, { name: client ? client.name : x.contact_name, xero_contact_id: x.contact_id, client_id: client ? client.id : null });
        const cccs = (db.invoices || []).find((i) => i.xero && i.xero.invoice_id === x.invoice_id);
        g.items.push({ key: `x-${x.invoice_id}`, source: 'xero', number: x.number || (cccs && cccs.number) || '—', reference: x.reference, date: x.date, due_date: x.due_date || x.date, total: x.total, amount_paid: x.amount_paid, amount_due: x.amount_due, cccs_invoice_id: cccs ? cccs.id : null });
        if (x.number) xeroNumbers.add(x.number);
      }
    }
    for (const i of db.invoices || []) {
      if (!i.number || !['APPROVED', 'IN_XERO'].includes(i.status)) continue;
      if (xc && (i.status === 'IN_XERO' || xeroNumbers.has(i.number))) continue; // Xero's figure is the truth for those
      if (i.gocardless && i.gocardless.payment_id && !['failed', 'cancelled', 'charged_back'].includes(i.gocardless.status)) continue; // Direct Debit is collecting it
      const client = clients.find((c) => c.id === i.client_id) || null;
      // Into the customer's Xero group when it has one (linked by id, or
      // matched by name above), so one customer never gets two emails.
      const joined = client && [...groups.values()].find((g) => g.client_id === client.id);
      const key = joined ? joined.key : client && client.xero_contact_id && xc ? `x-${client.xero_contact_id}` : `c-${i.client_id}`;
      const g = group(key, { name: client ? client.name : i.client_name, xero_contact_id: client ? client.xero_contact_id || null : null, client_id: client ? client.id : null });
      const due = i.xero && Number.isFinite(Number(i.xero.amount_due)) && i.status === 'IN_XERO' ? Number(i.xero.amount_due) : i.total;
      if (!(due > 0)) continue;
      g.items.push({ key: `c-${i.id}`, source: 'cccs', number: i.number, reference: i.site_name || '', date: i.issue_date, due_date: i.due_date, total: i.total, amount_paid: r2(i.total - due), amount_due: due, cccs_invoice_id: i.id });
    }
    const list = [...groups.values()].filter((g) => g.items.length);
    // Where the reminders go: the CCCS client's billing (or contact) email
    // when it is a CCCS client, otherwise the Xero contact's own address
    // and the contact people Xero includes in its invoice emails.
    let xEmails = {};
    if (withEmails && xc) {
      const need = list.filter((g) => g.xero_contact_id && !(g.client_id && splitEmails(billingOf(g)).length)).map((g) => g.xero_contact_id);
      if (need.length) { try { xEmails = await xero.contactEmails(need); } catch { xEmails = {}; } }
    }
    for (const g of list) {
      g.items.sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
      for (const it of g.items) it.days_overdue = Math.max(0, daysBetween(it.due_date, today));
      g.total_due = r2(g.items.reduce((n, x) => n + x.amount_due, 0));
      g.overdue = g.items.filter((x) => x.days_overdue > 0);
      g.overdue_total = r2(g.overdue.reduce((n, x) => n + x.amount_due, 0));
      const own = splitEmails(billingOf(g));
      g.emails = own.length ? own : (xEmails[g.xero_contact_id] || []);
      g.email_from = own.length ? 'CCCS client' : (g.emails.length ? 'Xero contact' : null);
    }
    return list.sort((a, b) => b.overdue_total - a.overdue_total || a.name.localeCompare(b.name));
  }
  function billingOf(g) {
    const c = g.client_id ? (db.clients || []).find((x) => x.id === g.client_id) : null;
    return c ? c.billing_email || c.contact_email || '' : '';
  }

  /* ---- which reminder (if any) is due ---- */
  const okSends = (key) => db.invoice_chases.filter((e) => e.group_key === key && e.ok);
  /** Stages each invoice has already been chased at, from the send log. */
  function chasedStages(itemKey) {
    const out = new Set();
    for (const e of db.invoice_chases) if (e.ok) for (const it of e.items || []) if (it.key === itemKey) for (const s of it.stages || []) out.add(s);
    return out;
  }
  function lastChasedAt(itemKey) {
    let at = null;
    for (const e of db.invoice_chases) if (e.ok && e.stage !== 'statement' && (e.items || []).some((it) => it.key === itemKey && (it.stages || []).length)) if (!at || e.at > at) at = e.at;
    return at;
  }
  function plan(g, st = settings()) {
    const today = london().date;
    const stages = st.stages;
    const last = stages[stages.length - 1];
    const marks = {}; let stage = null;
    for (const it of g.overdue) {
      const done = chasedStages(it.key);
      const newly = stages.filter((s) => it.days_overdue >= s && !done.has(s));
      if (!newly.length && st.repeat_days > 0 && it.days_overdue >= last + st.repeat_days) {
        const at = lastChasedAt(it.key);
        if (at && daysBetween(at.slice(0, 10), today) >= st.repeat_days) newly.push(last);
      }
      if (newly.length) { marks[it.key] = newly; stage = Math.max(stage || 0, ...newly); }
    }
    const lastSend = okSends(g.key).map((e) => e.at).sort().pop() || null;
    const out = { stage, marks, last_sent_at: lastSend, due: false, reason: null };
    const p = st.paused[g.key];
    if (!g.overdue.length) out.reason = 'nothing overdue';
    else if (!stage) out.reason = 'already chased at every stage reached';
    else if (p && (!p.until || p.until >= today)) out.reason = `paused${p.until ? ` until ${shortDate(p.until)}` : ''}`;
    else if (lastSend && daysBetween(lastSend.slice(0, 10), today) < st.min_gap_days) out.reason = `waiting: last emailed ${shortDate(lastSend)}, ${st.min_gap_days}-day gap`;
    else if (!g.emails.length) out.reason = 'no email address (add one to the client in Admin → Clients, or to the contact in Xero)';
    else out.due = true;
    return out;
  }

  /* ---- the statement PDF ---- */
  const NAVY = [0.047, 0.086, 0.141], AMBER = [0.949, 0.663, 0.235], WHITE = [1, 1, 1], LIGHT = [0.78, 0.82, 0.88], GREY = [0.35, 0.38, 0.42], RED = [0.72, 0.13, 0.13];
  function statementPdf(g) {
    const c = invoices.company(), ist = invoices.settings(), today = london().date;
    const client = g.client_id ? (db.clients || []).find((x) => x.id === g.client_id) : null;
    const doc = new Doc({ footer: `${c.company_name} — statement for ${g.name}, ${shortDate(today)}` });
    const bandH = 112;
    doc.rect(0, A4.h - bandH, A4.w, bandH, { fill: NAVY, stroke: null });
    const fs = require('fs'), path = require('path');
    const logoFile = path.join(__dirname, 'public', 'assets', 'echelon-wordmark-navy.jpg');
    if (fs.existsSync(logoFile)) { doc.y = A4.h - 32; doc.image(fs.readFileSync(logoFile), { maxH: 20, maxW: 170, x: doc.margin }); }
    else doc.text(c.company_name.toUpperCase(), doc.margin, A4.h - 42, { size: 17, bold: true, color: WHITE });
    const contact = [c.company_address, c.company_phone, c.company_email].filter(Boolean).join('  ·  ');
    if (contact) doc.text(contact, doc.margin, A4.h - 66, { size: 8.5, color: LIGHT });
    const right = A4.w - doc.margin;
    const lab = 'STATEMENT OF ACCOUNT';
    doc.text(lab, right - doc.textWidth(lab, 10, true), A4.h - 36, { size: 10, bold: true, color: AMBER });
    const amt = money(g.total_due);
    doc.text(amt, right - doc.textWidth(amt, 14, true), A4.h - 54, { size: 14, bold: true, color: WHITE });
    const sub = g.overdue_total > 0 ? `${money(g.overdue_total)} overdue` : 'nothing overdue';
    doc.text(sub, right - doc.textWidth(sub, 9), A4.h - 70, { size: 9, color: LIGHT });
    doc.y = A4.h - bandH - 26;
    doc.pairs([
      ['Statement date', longDate(today)],
      ['Account', [g.name, client && client.billing_address].filter(Boolean).join('\n')],
      ...(ist.vat_number ? [['Our VAT number', ist.vat_number]] : []),
    ]);
    doc.table([{ title: 'Invoice', width: 0.16 }, { title: 'Date', width: 0.15 }, { title: 'Due', width: 0.15 }, { title: 'Overdue', width: 0.14, align: 'right' }, { title: 'Amount', width: 0.13, align: 'right' }, { title: 'Paid', width: 0.13, align: 'right' }, { title: 'Owed', width: 0.14, align: 'right' }],
      g.items.map((x) => [x.number, shortDate(x.date), shortDate(x.due_date), x.days_overdue > 0 ? `${x.days_overdue} day${x.days_overdue === 1 ? '' : 's'}` : 'not yet due', money(x.total), money(x.amount_paid), money(x.amount_due)]), { size: 9 });
    // Ageing, the way accounts teams read a statement.
    const buckets = [['Not yet due', (d) => d <= 0], ['1–30 days', (d) => d >= 1 && d <= 30], ['31–60 days', (d) => d > 30 && d <= 60], ['61–90 days', (d) => d > 60 && d <= 90], ['Over 90 days', (d) => d > 90]];
    doc.table(buckets.map(([t]) => ({ title: t, width: 0.2, align: 'right' })), [buckets.map(([, f]) => money(g.items.filter((x) => f(x.days_overdue)).reduce((n, x) => n + x.amount_due, 0)))], { size: 9 });
    doc.room(30); doc.y -= 2;
    doc.rect(doc.margin, doc.y - 20, doc.width, 24, { fill: NAVY, stroke: null });
    doc.text('Balance owed', doc.margin + 10, doc.y - 14, { size: 11, bold: true, color: WHITE });
    doc.text(amt, doc.margin + doc.width - 10 - doc.textWidth(amt, 11, true), doc.y - 14, { size: 11, bold: true, color: AMBER });
    doc.y -= 30;
    if (g.overdue_total > 0) doc.para(`${money(g.overdue_total)} of this is past its due date. Please pay it as soon as you can.`, { size: 9.5, bold: true, color: RED, gap: 6 });
    if (ist.account_number || ist.sort_code) {
      const rows = [['Bank', ist.bank_name], ['Account name', ist.account_name || c.company_name], ['Sort code', ist.sort_code], ['Account number', ist.account_number], ['Reference', 'the invoice number(s) you are paying']].filter(([, v]) => v);
      const padX = 14, rowGap = 13.5, rowH = rows.length * rowGap + 30;
      doc.room(rowH + 10); doc.y -= 6;
      const top = doc.y;
      doc.rect(doc.margin, top - rowH, doc.width, rowH, { fill: [0.99, 0.95, 0.87], stroke: null });
      doc.rect(doc.margin, top - rowH, 3, rowH, { fill: AMBER, stroke: null });
      doc.text('HOW TO PAY', doc.margin + padX, top - 16, { size: 9, bold: true, color: [0.7, 0.47, 0.1] });
      rows.forEach(([label, value], i) => { const ry = top - 32 - i * rowGap; doc.text(label, doc.margin + padX, ry, { size: 9, color: GREY }); doc.text(value, doc.margin + padX + 110, ry, { size: 9.5 }); });
      doc.y = top - rowH - 6;
    }
    doc.para('If you have paid recently, thank you: payments can take a day or two to show. If anything here looks wrong, just reply to the email this came with.', { size: 9, color: GREY, gap: 4 });
    if (ist.late_payment_terms) doc.para(ist.late_payment_terms, { size: 8.5, color: GREY, gap: 4 });
    if (ist.company_number) doc.para(`Registered in England and Wales, company number ${ist.company_number}.`, { size: 8.5, color: GREY });
    return doc.toBuffer();
  }
  const fileName = (g) => `Statement - ${g.name.replace(/[^A-Za-z0-9 &.-]+/g, '').trim() || 'account'} - ${london().date}.pdf`;

  /* ---- the email ---- */
  function emailFor(g, stage, st = settings()) {
    const c = invoices.company(), ist = invoices.settings();
    const isStatement = stage === 'statement';
    const listed = isStatement ? g.items : g.overdue;
    const one = listed.length === 1;
    const subject = isStatement
      ? `Statement of account from ${c.company_name}: ${money(g.total_due)} outstanding`
      : `${stageName(stage, st)}: ${one ? `invoice ${listed[0].number} is` : `${listed.length} invoices are`} overdue (${money(g.overdue_total)})`;
    const fill = (t) => String(t || '').replace(/\{name\}/g, g.name).replace(/\{overdue_total\}/g, money(g.overdue_total)).replace(/\{total\}/g, money(g.total_due)).replace(/\{count\}/g, String(listed.length));
    let intro = fill(isStatement ? st.statement_wording : (st.wording[stage] || WORDING[30]));
    // The stock wording is written for several invoices; read it as one.
    if (one) intro = intro.replace(/the invoices below are now past their/gi, 'the invoice below is now past its').replace(/the invoices (below|listed) are/gi, 'the invoice $1 is').replace(/the invoices (below|listed)/gi, 'the invoice $1').replace(/, and the oldest is now/gi, ', which is now').replace(/any of them/gi, 'it');
    const rows = listed.map((x) => `<tr><td style="padding:4px 10px 4px 0">${esc(x.number)}</td><td style="padding:4px 10px">${esc(shortDate(x.due_date))}</td><td style="padding:4px 10px">${x.days_overdue > 0 ? `${x.days_overdue} days overdue` : 'not yet due'}</td><td style="padding:4px 0 4px 10px;text-align:right">${esc(money(x.amount_due))}</td></tr>`).join('');
    const pay = ist.account_number ? `<p>Please pay by bank transfer to ${esc(ist.account_name || c.company_name)}, sort code ${esc(ist.sort_code)}, account ${esc(ist.account_number)}, quoting the invoice number${one ? '' : 's'}.</p>` : '';
    const html = `<p>Hello,</p><p>${esc(intro)}</p>
      <table style="border-collapse:collapse;font-size:14px"><thead><tr style="text-align:left;color:#666"><th style="padding:4px 10px 4px 0">Invoice</th><th style="padding:4px 10px">Due</th><th style="padding:4px 10px"></th><th style="padding:4px 0 4px 10px;text-align:right">Owed</th></tr></thead><tbody>${rows}</tbody>
      <tfoot><tr><td colspan="3" style="padding:6px 10px 4px 0"><strong>${isStatement ? 'Balance owed' : 'Overdue'}</strong></td><td style="padding:6px 0 4px 10px;text-align:right"><strong>${esc(money(isStatement ? g.total_due : g.overdue_total))}</strong></td></tr></tfoot></table>
      ${!isStatement && g.total_due > g.overdue_total ? `<p style="color:#666">Your full balance is ${esc(money(g.total_due))}, including invoices not yet due.</p>` : ''}
      ${pay}<p>A statement of your account is attached.</p>${ist.late_payment_terms ? `<p style="color:#555;font-size:13px">${esc(ist.late_payment_terms)}</p>` : ''}<p>Kind regards,<br>${esc(c.company_name)}${c.company_phone ? `<br>${esc(c.company_phone)}` : ''}</p>`;
    return { to: g.emails.join(', '), subject, html };
  }

  /** Sends one email (a reminder at `stage`, or 'statement') and records it. */
  async function send(g, stage, by, { auto = false, marks = null } = {}) {
    const st = settings();
    if (!sendEmail) throw new Error('email is not set up on this server');
    if (!g.emails.length) throw new Error('no email address for this customer (add one to the client in Admin → Clients, or to the contact in Xero)');
    const mail = emailFor(g, stage, st);
    const pdf = statementPdf(g);
    let r;
    try { r = await sendEmail(mail.to, mail.subject, mail.html, { bcc: st.copy_to || '', attachments: [{ name: fileName(g), contentType: 'application/pdf', content: pdf }] }); }
    catch (e) { r = { ok: false, error: e.message }; }
    const ok = Boolean(r && r.ok);
    const listed = stage === 'statement' ? g.items : g.overdue;
    // A manual reminder counts for every stage each invoice has reached,
    // so the automatic run doesn't send the same reminder again.
    const m = marks || (stage === 'statement' ? {} : Object.fromEntries(g.overdue.map((x) => [x.key, st.stages.filter((s) => x.days_overdue >= s && s <= stage)])));
    const entry = {
      id: nextId('invoice_chases'), at: new Date(now()).toISOString(), by, auto, group_key: g.key, name: g.name, to: mail.to, stage, subject: mail.subject,
      items: listed.map((x) => ({ key: x.key, number: x.number, due_date: x.due_date, days_overdue: x.days_overdue, amount_due: x.amount_due, stages: m[x.key] || [] })),
      total_due: g.total_due, overdue_total: g.overdue_total, ok, error: ok ? null : String((r && r.error) || 'failed').slice(0, 300),
    };
    db.invoice_chases.push(entry);
    if (db.invoice_chases.length > 2000) db.invoice_chases.splice(0, db.invoice_chases.length - 2000);
    if (ok) {
      for (const x of listed) {
        const inv = x.cccs_invoice_id && (db.invoices || []).find((i) => i.id === x.cccs_invoice_id);
        if (inv && Array.isArray(inv.history)) inv.history.push({ at: entry.at, by: auto ? 'CCCS' : by, what: `${stage === 'statement' ? 'statement' : stageName(stage, st).toLowerCase()} emailed to ${mail.to}` });
      }
      logEvent('invoice.chase', `${stage === 'statement' ? 'STATEMENT' : stageName(stage, st).toUpperCase()} SENT TO ${g.name.toUpperCase()} (${money(stage === 'statement' ? g.total_due : g.overdue_total)})${auto ? '' : ` BY ${by}`}`, {});
    }
    flushNow();
    return entry;
  }

  /* ---- the daily run ---- */
  let running = false;
  async function run({ by = 'CCCS' } = {}) {
    const st = settings();
    if (running) return { skipped: 'already running' };
    running = true;
    try {
      const l = london();
      const groups = await collect();
      const sent = [], failed = [], held = [];
      for (const g of groups) {
        const p = plan(g, st);
        if (!p.due) { if (p.stage) held.push({ name: g.name, reason: p.reason }); continue; }
        const e = await send(g, p.stage, by, { auto: by === 'CCCS', marks: p.marks });
        (e.ok ? sent : failed).push({ name: g.name, stage: p.stage, error: e.error });
      }
      st.last_run_date = l.date; st.last_run_at = new Date(now()).toISOString();
      st.last_run_result = { sent: sent.length, failed: failed.length, held: held.length, error: null };
      flushNow();
      return { sent, failed, held };
    } catch (e) {
      st.last_run_at = new Date(now()).toISOString();
      st.last_run_result = { sent: 0, failed: 0, held: 0, error: e.message };
      flushNow();
      throw e;
    } finally { running = false; }
  }
  async function tick() {
    const st = settings();
    if (!st.enabled) return null;
    const l = london();
    if (st.last_run_date === l.date || l.hour < st.send_hour) return null;
    if (st.weekdays_only && (l.weekday === 'Sat' || l.weekday === 'Sun')) return null;
    // Marked first, so a Xero outage doesn't retry (and re-fail) all day;
    // the next weekday tries again.
    st.last_run_date = l.date;
    try { return await run(); } catch (e) { console.warn('[chasers] run failed:', e.message); return null; }
  }
  const timer = setInterval(() => { tick().catch(() => {}); }, tickMs);
  if (timer.unref) timer.unref();

  /* ---- routes ---- */
  async function findGroup(key) {
    const g = (await collect()).find((x) => x.key === key);
    if (!g) throw httpError(404, 'nothing is owed by that customer now');
    return g;
  }
  const wrap = (fn) => async (ctx) => { try { return await fn(ctx); } catch (e) { if (e.status) throw e; throw httpError(502, e.message); } };
  route('GET', '/api/invoice-chasers', MONEY, wrap(async () => {
    const st = settings();
    const groups = await collect();
    return {
      settings: st, email_ready: Boolean(sendEmail), xero_connected: Boolean(xero && xero.connected && xero.connected()), today: london().date,
      groups: groups.map((g) => ({ ...g, plan: plan(g, st), stage_name: null, paused: st.paused[g.key] || null })).map((g) => ({ ...g, stage_name: g.plan.stage ? stageName(g.plan.stage, st) : null })),
      log: db.invoice_chases.slice(-150).reverse(),
    };
  }));
  route('PUT', '/api/invoice-chasers/settings', ADMIN, ({ body }) => {
    const st = settings();
    if ('enabled' in body) st.enabled = Boolean(body.enabled);
    if ('stages' in body) {
      const list = [...new Set((Array.isArray(body.stages) ? body.stages : String(body.stages).split(/[\s,;]+/)).filter((x) => String(x).trim() !== '').map(Number))];
      if (!list.length || list.length > 6 || list.some((n) => !Number.isInteger(n) || n < 1 || n > 365)) throw httpError(400, 'reminder days: 1 to 6 whole numbers of days, e.g. 7, 14, 30');
      st.stages = list.sort((a, b) => a - b);
    }
    if ('send_hour' in body) { const h = Number(body.send_hour); if (!Number.isInteger(h) || h < 0 || h > 23) throw httpError(400, 'send hour: 0 to 23'); st.send_hour = h; }
    if ('weekdays_only' in body) st.weekdays_only = Boolean(body.weekdays_only);
    if ('min_gap_days' in body) { const n = Number(body.min_gap_days); if (!Number.isInteger(n) || n < 0 || n > 60) throw httpError(400, 'gap: 0 to 60 days'); st.min_gap_days = n; }
    if ('repeat_days' in body) { const n = Number(body.repeat_days); if (!Number.isInteger(n) || n < 0 || n > 90) throw httpError(400, 'repeat: 0 (never) to 90 days'); st.repeat_days = n; }
    if ('copy_to' in body) {
      const list = [...new Set(String(body.copy_to || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))];
      const bad = list.find((x) => !isEmail(x));
      if (bad) throw httpError(400, `copy to: not an email address: ${bad}`);
      st.copy_to = list.join(', ');
    }
    if (body.wording && typeof body.wording === 'object') {
      for (const [k, v] of Object.entries(body.wording)) { const t = String(v || '').trim().slice(0, 1500); if (t) st.wording[k] = t; else delete st.wording[k]; }
    }
    if ('statement_wording' in body) st.statement_wording = String(body.statement_wording || '').trim().slice(0, 1500) || DEFAULTS.statement_wording;
    flushNow();
    return st;
  });
  route('GET', '/api/invoice-chasers/:key/statement', MONEY, wrap(async ({ params }) => {
    const g = await findGroup(params.key);
    return { __body: statementPdf(g), __headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${fileName(g).replace(/"/g, '')}"`, 'cache-control': 'private, no-store' } };
  }));
  route('GET', '/api/invoice-chasers/:key/preview', MONEY, wrap(async ({ params, query }) => {
    const g = await findGroup(params.key), st = settings();
    const want = query.get('stage');
    const p = plan(g, st);
    const stage = want === 'statement' ? 'statement' : Number(want) || p.stage || 'statement';
    return { ...emailFor(g, stage, st), stage, stage_name: stageName(stage, st) };
  }));
  route('POST', '/api/invoice-chasers/:key/send', MONEY, wrap(async ({ params, body, user }) => {
    const g = await findGroup(params.key), st = settings();
    let stage = body.stage === 'statement' || !body.stage ? 'statement' : Number(body.stage);
    if (stage !== 'statement') {
      if (!st.stages.includes(stage)) throw httpError(400, 'pick one of the reminder stages');
      if (!g.overdue.length) throw httpError(409, 'nothing is overdue, so send a statement instead');
    }
    const e = await send(g, stage, user.display_name);
    if (!e.ok) throw httpError(502, `not sent: ${e.error}`);
    return e;
  }));
  /** "Send statements to everyone overdue" — one statement each, skipping
   * anyone paused, emailed within the gap, or with no address. */
  route('POST', '/api/invoice-chasers/statements', MONEY, wrap(async ({ user }) => {
    const st = settings(), today = london().date;
    const sent = [], skipped = [];
    for (const g of await collect()) {
      if (!g.overdue.length) continue;
      const p = st.paused[g.key];
      const lastSend = okSends(g.key).map((e) => e.at).sort().pop();
      if (p && (!p.until || p.until >= today)) { skipped.push({ name: g.name, reason: 'paused' }); continue; }
      if (lastSend && daysBetween(lastSend.slice(0, 10), today) < st.min_gap_days) { skipped.push({ name: g.name, reason: `emailed ${shortDate(lastSend)}` }); continue; }
      if (!g.emails.length) { skipped.push({ name: g.name, reason: 'no email address' }); continue; }
      const e = await send(g, 'statement', user.display_name);
      if (e.ok) sent.push({ name: g.name, to: e.to }); else skipped.push({ name: g.name, reason: `failed: ${e.error}` });
    }
    return { sent, skipped };
  }));
  route('POST', '/api/invoice-chasers/:key/pause', MONEY, ({ params, body, user }) => {
    const st = settings();
    if (body.resume) delete st.paused[params.key];
    else {
      const until = body.until && /^\d{4}-\d{2}-\d{2}$/.test(String(body.until)) ? String(body.until) : null;
      st.paused[params.key] = { until, by: user.display_name, at: new Date(now()).toISOString(), note: String(body.note || '').slice(0, 200), name: String(body.name || '').slice(0, 120) };
    }
    flushNow();
    return { paused: st.paused[params.key] || null };
  });
  route('POST', '/api/invoice-chasers/run', ADMIN, wrap(async ({ user }) => {
    if (!settings().enabled) throw httpError(409, 'automatic reminders are off: turn them on in the settings first');
    return run({ by: user.display_name });
  }));

  return { collect, plan, run, tick, statementPdf, emailFor, settings };
};
