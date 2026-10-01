/**
 * Quotes and contracts — what we have offered a client for a site, and what
 * they have agreed to. The contract is what invoicing works from
 * (routes-invoices.js).
 *
 * QUOTE     DRAFT → SENT → ACCEPTED | DECLINED   (EXPIRED once past valid_until;
 *           WITHDRAWN if we take it back). An accepted quote can be turned into
 *           a contract with the same lines.
 * CONTRACT  DRAFT → SENT → SIGNED → ENDED        (WITHDRAWN before signing).
 *
 * Only a DRAFT can be edited; once sent, what the client sees is fixed —
 * changes mean withdrawing and sending a new one. Sending makes a PDF; a
 * signed contract gets a second PDF with the signature on it, and the
 * unsigned one is kept. The terms printed are snapshotted at sending.
 *
 * LINES say how each part is charged:
 *   HOURLY        rate × hours (hours worked by clock, or rostered hours —
 *                 the contract's billing_basis), optionally only shifts of one
 *                 shift type; est_quantity is the estimate shown on a quote
 *   FIXED_PERIOD  a set amount every invoice period (e.g. monthly alarm response)
 *   ONE_OFF       charged once, on the first invoice
 *
 * Who: admins create, send and manage (also listed on the site, admin
 * only). The client — a CLIENT login for that client, never an admin
 * viewing as them — accepts or declines a quote and signs a contract in
 * their portal. Every decision is logged and admins are told.
 *
 * Registrar pattern — server.js passes in what this needs.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Doc } = require('./pdf.js');

const LINE_KINDS = { HOURLY: 'per hour', FIXED_PERIOD: 'per invoice period', ONE_OFF: 'one-off' };
const PERIODS = { WEEKLY: 'weekly', MONTHLY: 'monthly' };
const BASES = { HOURS_WORKED: 'hours worked (as clocked)', ROSTERED: 'hours rostered' };
const DEFAULT_CONTRACT_TERMS = `1. Services. The Company will provide the security services described in this contract at the site named, to the standard reasonably expected of a professional provider and in line with the relevant SIA and British Standard codes of practice.
2. Term. This contract runs from the start date until the end date shown or, where none is shown, until either party ends it by giving 30 days' written notice.
3. Charges. The Client will pay the charges set out in this contract. Hourly charges are calculated on the basis stated (hours worked as recorded by the Company's attendance system, or hours rostered). Additional hours requested by the Client are charged at the same rates unless agreed otherwise.
4. Invoicing and payment. The Company will invoice at the interval stated. Invoices are payable within the payment terms shown. VAT is charged at the prevailing rate. The Company may charge interest on late payments under the Late Payment of Commercial Debts (Interest) Act 1998.
5. Client responsibilities. The Client will give officers safe access to the site, the information and instructions they need, and tell the Company promptly of any change in risk at the site.
6. Staff. The Company remains the employer of its officers and is responsible for their vetting, licensing, training and supervision. The Client will not employ or engage any officer supplied under this contract during it or for 6 months after without the Company's written agreement.
7. Liability and insurance. The Company holds public and employer's liability insurance. Neither party limits liability for death or personal injury caused by negligence, or for fraud. Otherwise neither party is liable for indirect or consequential loss, and the Company's total liability in any year is limited to the charges paid in that year.
8. Data protection. Each party will comply with UK data protection law for any personal data it handles under this contract.
9. Termination. Either party may end this contract immediately by written notice if the other materially breaches it and does not put it right within 14 days of being asked to.
10. Law. This contract is governed by the law of England and Wales.`;

module.exports = function registerAgreements({
  route, httpError, ADMIN, CLIENT, db, nextId, logEvent, pushToRoles = () => {}, sendEmail = null, UPLOADS_DIR, publicBaseUrl = '', flushNow = () => {},
}) {
  if (!Array.isArray(db.agreements)) db.agreements = [];
  const dir = (id) => path.join(UPLOADS_DIR, 'agreements', String(id));
  const CLIENT_OR_ADMIN = [...CLIENT, 'SYSTEM_ADMIN'];
  const company = () => {
    const r = (db.ui_settings || []).find((x) => x.key === 'rental') || {};
    return { company_name: r.company_name || 'Echelon', company_address: r.company_address || '', company_phone: r.company_phone || '', company_email: r.company_email || '' };
  };
  const contractTerms = () => ((db.ui_settings || []).find((x) => x.key === 'contract') || {}).terms || DEFAULT_CONTRACT_TERMS;
  const clientForSite = (siteId) => (db.clients || []).find((c) => (c.site_ids || []).includes(siteId)) || null;
  const find = (id) => { const a = db.agreements.find((x) => x.id === Number(id)); if (!a) throw httpError(404, 'not found'); return a; };
  const today = () => new Date().toISOString().slice(0, 10);
  const statusOf = (a) => (a.kind === 'QUOTE' && a.status === 'SENT' && a.valid_until && a.valid_until < today() ? 'EXPIRED' : a.status);
  const money = (n) => `£${Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  function estimate(a) {
    let period = 0, once = 0;
    for (const l of a.lines) {
      if (l.kind === 'HOURLY') period += (l.est_quantity || 0) * l.rate;
      else if (l.kind === 'FIXED_PERIOD') period += l.rate;
      else once += l.rate;
    }
    return { per_period: Math.round(period * 100) / 100, one_off: Math.round(once * 100) / 100 };
  }
  function publicAgreement(a, { forClient = false } = {}) {
    const site = db.sites.find((s) => s.id === a.site_id);
    const out = { ...a, status: statusOf(a), site_name: site ? site.name : null, estimate: estimate(a), signature: undefined,
      pdf_url: forClient ? `/api/client/agreements/${a.id}/pdf` : `/api/agreements/${a.id}/pdf` };
    if (forClient) { delete out.internal_notes; delete out.created_by; delete out.emails; }
    return out;
  }

  /* ---- validation ---- */
  function cleanLines(raw) {
    if (!Array.isArray(raw) || !raw.length) throw httpError(400, 'add at least one line');
    if (raw.length > 40) throw httpError(400, 'too many lines');
    return raw.map((l, n) => {
      const description = String(l.description || '').trim().slice(0, 200);
      if (!description) throw httpError(400, `line ${n + 1}: description required`);
      const kind = LINE_KINDS[l.kind] ? l.kind : 'HOURLY';
      if (l.rate === '' || l.rate == null || Number.isNaN(Number(l.rate))) throw httpError(400, `line ${n + 1}: enter the rate`);
      const rate = Number(l.rate);
      if (!Number.isFinite(rate) || rate < 0) throw httpError(400, `line ${n + 1}: rate must be 0 or more`);
      const est = l.est_quantity === undefined || l.est_quantity === null || l.est_quantity === '' ? null : Number(l.est_quantity);
      if (est !== null && (!Number.isFinite(est) || est < 0)) throw httpError(400, `line ${n + 1}: estimate must be 0 or more`);
      const st = kind === 'HOURLY' && l.shift_type_id ? (db.shift_types || []).find((t) => t.id === Number(l.shift_type_id)) : null;
      if (kind === 'HOURLY' && l.shift_type_id && !st) throw httpError(400, `line ${n + 1}: shift type not found`);
      return { description, kind, rate: Math.round(rate * 100) / 100, est_quantity: est, shift_type_id: st ? st.id : null, shift_type_name: st ? st.name : null };
    });
  }
  const dateOrNull = (v, what) => { if (!v) return null; if (!/^\d{4}-\d{2}-\d{2}/.test(String(v)) || isNaN(Date.parse(v))) throw httpError(400, `${what} must be a date`); return String(v).slice(0, 10); };
  function apply(a, body) {
    if ('title' in body) { const t = String(body.title || '').trim().slice(0, 160); if (!t) throw httpError(400, 'title required'); a.title = t; }
    if ('lines' in body) a.lines = cleanLines(body.lines);
    if ('valid_until' in body) a.valid_until = dateOrNull(body.valid_until, 'valid until');
    if ('start_date' in body) a.start_date = dateOrNull(body.start_date, 'start date');
    if ('end_date' in body) a.end_date = dateOrNull(body.end_date, 'end date');
    if (a.start_date && a.end_date && a.end_date < a.start_date) throw httpError(400, 'the end date is before the start date');
    if ('billing_basis' in body) a.billing_basis = BASES[body.billing_basis] ? body.billing_basis : 'HOURS_WORKED';
    if ('invoice_period' in body) a.invoice_period = PERIODS[body.invoice_period] ? body.invoice_period : 'MONTHLY';
    if ('vat_rate' in body) { const v = Number(body.vat_rate); if (!Number.isFinite(v) || v < 0 || v > 100) throw httpError(400, 'VAT rate must be 0–100'); a.vat_rate = v; }
    if ('payment_terms_days' in body) { const d = Number(body.payment_terms_days); if (!Number.isInteger(d) || d < 0 || d > 180) throw httpError(400, 'payment terms must be 0–180 days'); a.payment_terms_days = d; }
    if ('notes' in body) a.notes = String(body.notes || '').slice(0, 4000);
    if ('internal_notes' in body) a.internal_notes = String(body.internal_notes || '').slice(0, 4000);
    if ('terms' in body) a.terms = String(body.terms || '').trim().slice(0, 20000) || null;
  }

  /* ---- PDF ---- */
  function pdf(a, signatureJpeg) {
    const c = company();
    const site = db.sites.find((s) => s.id === a.site_id) || {};
    const client = db.clients.find((x) => x.id === a.client_id) || {};
    const quote = a.kind === 'QUOTE';
    const doc = new Doc({ footer: `${c.company_name} — ${quote ? 'quotation' : 'contract'} ${a.reference}` });
    doc.para(c.company_name, { size: 18, bold: true, gap: 0 });
    const contact = [c.company_address, c.company_phone, c.company_email].filter(Boolean).join('  ·  ');
    if (contact) doc.para(contact, { size: 9, color: [0.35, 0.38, 0.42], gap: 6 });
    doc.rule(6);
    doc.para(quote ? 'Quotation' : 'Contract for security services', { size: 15, bold: true, gap: 2 });
    doc.para(`${a.reference} — ${a.title}`, { size: 10, color: [0.35, 0.38, 0.42], gap: 6 });
    const fmt = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '—');
    doc.pairs([
      ['Client', client.name || '—'], ['Site', `${site.name || '—'}${site.address ? `, ${site.address}` : ''}`],
      ['Date', fmt(a.sent_at || a.created_at)],
      ...(quote ? [['Valid until', fmt(a.valid_until)]] : [['Starts', fmt(a.start_date)], ['Ends', a.end_date ? fmt(a.end_date) : 'Until ended by 30 days\' notice']]),
      ['Charged on', BASES[a.billing_basis]], ['Invoiced', PERIODS[a.invoice_period]],
      ['Payment terms', `${a.payment_terms_days} days`], ['VAT', `${a.vat_rate}% added to all charges`],
    ]);
    doc.heading('Charges', 12);
    doc.table([{ title: 'Description', width: 0.42 }, { title: 'Basis', width: 0.2 }, { title: 'Rate', width: 0.13, align: 'right' }, { title: 'Est. qty', width: 0.11, align: 'right' }, { title: 'Est. amount', width: 0.14, align: 'right' }],
      a.lines.map((l) => [l.description + (l.shift_type_name ? ` (${l.shift_type_name} shifts)` : ''), LINE_KINDS[l.kind], money(l.rate), l.kind === 'HOURLY' && l.est_quantity != null ? `${l.est_quantity} h` : '', l.kind === 'HOURLY' ? (l.est_quantity != null ? money(l.rate * l.est_quantity) : '') : money(l.rate)]));
    const e = estimate(a);
    doc.para(`Estimated per ${a.invoice_period === 'WEEKLY' ? 'week' : 'month'}: ${money(e.per_period)} plus VAT${e.one_off ? `; one-off charges ${money(e.one_off)} plus VAT` : ''}. Hourly charges are invoiced on the ${BASES[a.billing_basis]}.`, { size: 9.5, gap: 6 });
    if (a.notes) { doc.heading('Notes', 12); doc.para(a.notes); }
    if (!quote || a.terms) {
      doc.heading('Terms and conditions', 12);
      for (const p of String(a.terms_snapshot || a.terms || contractTerms()).split(/\n+/)) doc.para(p, { size: 8.5, gap: 3 });
    }
    if (!quote) {
      doc.room(230);
      doc.heading(a.status === 'SIGNED' ? 'Signed for the client' : 'To be signed by the client', 12);
      if (a.status === 'SIGNED' && signatureJpeg) {
        const top = doc.y; doc.rect(doc.margin, top - 100, 240, 96, { stroke: 0.8 }); doc.y = top - 4;
        doc.image(signatureJpeg, { maxW: 232, maxH: 88, x: doc.margin + 4 }); doc.y = top - 104;
        doc.pairs([['Name', a.signed_name], ['Position', a.signed_position || '—'], ['Signed', new Date(a.signed_at).toLocaleString('en-GB', { timeZone: 'Europe/London' })]], { labelWidth: 70 });
      } else doc.para('This contract is signed in the client portal.', { size: 9.5 });
    } else if (a.status === 'ACCEPTED') {
      doc.heading('Accepted', 12);
      doc.para(`Accepted by ${a.decided_by_name} for the client on ${new Date(a.decided_at).toLocaleString('en-GB', { timeZone: 'Europe/London' })}.`);
    }
    return doc.toBuffer();
  }
  /* ---- emails to the client, each with the PDF attached ----
   * SENT     — the quote/contract, with how to answer it in the portal
   * ACCEPTED — confirmation of an accepted quote
   * SIGNED   — their copy of the signed contract
   * Kept on the agreement (a.emails) so admins can see what went out. */
  function emailClient(a, kind) {
    const client = db.clients.find((c) => c.id === a.client_id);
    if (!a.emails) a.emails = [];
    const log = (entry) => a.emails.push({ kind, at: new Date().toISOString(), ...entry });
    if (!sendEmail) return;
    if (!client || !client.contact_email) { log({ ok: false, error: 'the client has no contact email (Admin → Clients)' }); return; }
    const c = company(), q = a.kind === 'QUOTE', what = q ? 'quotation' : 'contract';
    const site = (db.sites.find((s) => s.id === a.site_id) || {}).name || 'your site';
    const portal = `<a href="${publicBaseUrl}/client.html">${publicBaseUrl}/client.html</a>`;
    const T = {
      SENT: [`${q ? 'Quotation' : 'Contract'} ${a.reference} from ${c.company_name}`,
        `<p>Hello,</p><p>Please find attached our ${what} <strong>${a.reference}</strong> for ${site}.</p>
         <p>${q ? `You can accept or decline it in your client portal${a.valid_until ? ` — it is valid until ${new Date(a.valid_until).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}` : ''}` : 'Please read it and sign it in your client portal'}: ${portal}</p>`],
      ACCEPTED: [`Quotation ${a.reference} accepted — thank you`,
        `<p>Hello,</p><p>Thank you — quotation <strong>${a.reference}</strong> for ${site} was accepted by ${a.decided_by_name}. A copy is attached. We'll be in touch with the contract.</p>`],
      SIGNED: [`Your signed contract ${a.reference}`,
        `<p>Hello,</p><p>Thank you — contract <strong>${a.reference}</strong> for ${site} was signed by ${a.signed_name}. Your copy is attached, and it is always available in your client portal: ${portal}</p>`],
    }[kind];
    const file = a.pdf_file ? path.join(dir(a.id), a.pdf_file) : null;
    const attachments = file && fs.existsSync(file) ? [{ name: `${a.reference}.pdf`, contentType: 'application/pdf', content: fs.readFileSync(file) }] : [];
    Promise.resolve(sendEmail(client.contact_email, T[0], `${T[1]}<p>Kind regards,<br>${c.company_name}</p>`, { attachments }))
      .then((r) => { log({ to: client.contact_email, ok: Boolean(r && r.ok), error: r && !r.ok ? String(r.error || '').slice(0, 200) : null }); flushNow(); })
      .catch((e) => log({ to: client.contact_email, ok: false, error: e.message }));
  }
  function writePdf(a, name, sig) { fs.mkdirSync(dir(a.id), { recursive: true }); fs.writeFileSync(path.join(dir(a.id), name), pdf(a, sig)); a.pdf_file = name; }

  /* ---- admin ---- */
  route('GET', '/api/agreements', ADMIN, ({ query }) => {
    const site = query.get('site_id') ? Number(query.get('site_id')) : null, kind = query.get('kind');
    return db.agreements.filter((a) => (!site || a.site_id === site) && (!kind || a.kind === kind)).slice().reverse().map((a) => publicAgreement(a));
  });
  route('GET', '/api/agreements/settings', ADMIN, () => ({ terms: contractTerms(), default: DEFAULT_CONTRACT_TERMS }));
  route('PUT', '/api/agreements/settings', ADMIN, ({ body }) => {
    if (!Array.isArray(db.ui_settings)) db.ui_settings = [];
    let r = db.ui_settings.find((x) => x.key === 'contract'); if (!r) { r = { key: 'contract' }; db.ui_settings.push(r); }
    r.terms = String(body.terms || '').trim().slice(0, 20000) || null;
    flushNow();
    return { terms: contractTerms() };
  });
  route('GET', '/api/agreements/:id', ADMIN, ({ params }) => publicAgreement(find(params.id)));
  route('POST', '/api/agreements', ADMIN, ({ body, user }) => {
    const kind = body.kind === 'CONTRACT' ? 'CONTRACT' : 'QUOTE';
    const site = db.sites.find((s) => s.id === Number(body.site_id)); if (!site) throw httpError(400, 'choose the site');
    const client = clientForSite(site.id);
    const id = nextId('agreements'), year = new Date().getFullYear();
    const a = {
      id, kind, reference: `${kind === 'QUOTE' ? 'QUO' : 'CON'}-${year}-${String(id).padStart(4, '0')}`, status: 'DRAFT',
      site_id: site.id, client_id: client ? client.id : null, title: '', lines: [], valid_until: null, start_date: null, end_date: null,
      billing_basis: 'HOURS_WORKED', invoice_period: 'MONTHLY', vat_rate: 20, payment_terms_days: 30, notes: '', internal_notes: '', terms: null,
      created_by: user.display_name, created_at: new Date().toISOString(), history: [],
    };
    if (kind === 'QUOTE') a.valid_until = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    apply(a, { title: body.title || `${kind === 'QUOTE' ? 'Quotation' : 'Contract'} — ${site.name}`, ...body });
    db.agreements.push(a);
    a.history.push({ at: a.created_at, by: user.display_name, what: 'created' });
    logEvent('agreement.created', `${kind} ${a.reference} CREATED FOR ${site.name.toUpperCase()}`, { agreement_id: a.id });
    flushNow();
    return { __status: 201, __body: publicAgreement(a) };
  });
  route('PATCH', '/api/agreements/:id', ADMIN, ({ params, body, user }) => {
    const a = find(params.id);
    if (a.status !== 'DRAFT') throw httpError(409, 'only a draft can be changed — withdraw it and send a new one');
    apply(a, body);
    a.history.push({ at: new Date().toISOString(), by: user.display_name, what: 'edited' });
    return publicAgreement(a);
  });
  route('DELETE', '/api/agreements/:id', ADMIN, ({ params }) => {
    const a = find(params.id);
    if (a.status !== 'DRAFT') throw httpError(409, 'only a draft can be deleted — withdraw it instead');
    db.agreements = db.agreements.filter((x) => x.id !== a.id);
    return { ok: true };
  });
  route('POST', '/api/agreements/:id/send', ADMIN, ({ params, user }) => {
    const a = find(params.id);
    if (a.status !== 'DRAFT') throw httpError(409, 'already sent');
    if (!a.client_id) { const c = clientForSite(a.site_id); if (!c) throw httpError(400, 'this site is not linked to a client — link it in Admin → Clients so they can see it in their portal'); a.client_id = c.id; }
    if (!a.lines.length) throw httpError(400, 'add at least one line');
    if (a.kind === 'CONTRACT' && !a.start_date) throw httpError(400, 'a contract needs a start date');
    if (a.kind === 'CONTRACT') a.terms_snapshot = a.terms || contractTerms(); else if (a.terms) a.terms_snapshot = a.terms;
    a.status = 'SENT'; a.sent_at = new Date().toISOString(); a.sent_by = user.display_name;
    writePdf(a, 'sent.pdf');
    a.history.push({ at: a.sent_at, by: user.display_name, what: 'sent to the client' });
    logEvent('agreement.sent', `${a.kind} ${a.reference} SENT TO CLIENT`, { agreement_id: a.id });
    emailClient(a, 'SENT');
    flushNow();
    return publicAgreement(a);
  });
  route('POST', '/api/agreements/:id/email', ADMIN, ({ params }) => {
    const a = find(params.id);
    if (!['SENT', 'ACCEPTED', 'SIGNED'].includes(a.status)) throw httpError(409, 'nothing to email yet — send it first');
    emailClient(a, a.status);
    return publicAgreement(a);
  });
  route('POST', '/api/agreements/:id/withdraw', ADMIN, ({ params, body, user }) => {
    const a = find(params.id);
    if (!['SENT'].includes(a.status)) throw httpError(409, 'only something sent and not yet answered can be withdrawn');
    a.status = 'WITHDRAWN'; a.history.push({ at: new Date().toISOString(), by: user.display_name, what: `withdrawn${body.reason ? ` — ${String(body.reason).slice(0, 200)}` : ''}` });
    logEvent('agreement.withdrawn', `${a.kind} ${a.reference} WITHDRAWN`, { agreement_id: a.id });
    flushNow();
    return publicAgreement(a);
  });
  /** An accepted quote becomes a draft contract with the same lines. */
  route('POST', '/api/agreements/:id/convert', ADMIN, ({ params, user }) => {
    const q = find(params.id);
    if (q.kind !== 'QUOTE' || q.status !== 'ACCEPTED') throw httpError(409, 'only an accepted quote can become a contract');
    if (db.agreements.some((x) => x.from_quote_id === q.id && x.status !== 'WITHDRAWN')) throw httpError(409, 'a contract has already been made from this quote');
    const id = nextId('agreements');
    const c = { ...JSON.parse(JSON.stringify(q)), id, kind: 'CONTRACT', reference: `CON-${new Date().getFullYear()}-${String(id).padStart(4, '0')}`, status: 'DRAFT',
      title: q.title.replace(/^Quotation/, 'Contract'), from_quote_id: q.id, valid_until: null, start_date: today(), sent_at: null, decided_at: null, decided_by_name: null,
      pdf_file: null, terms: null, terms_snapshot: null, created_by: user.display_name, created_at: new Date().toISOString(), history: [{ at: new Date().toISOString(), by: user.display_name, what: `made from quote ${q.reference}` }] };
    db.agreements.push(c);
    flushNow();
    return { __status: 201, __body: publicAgreement(c) };
  });
  route('POST', '/api/agreements/:id/end', ADMIN, ({ params, body, user }) => {
    const a = find(params.id);
    if (a.kind !== 'CONTRACT' || a.status !== 'SIGNED') throw httpError(409, 'only a signed contract can be ended');
    a.end_date = dateOrNull(body.end_date, 'end date') || today(); a.status = 'ENDED';
    a.history.push({ at: new Date().toISOString(), by: user.display_name, what: `ended on ${a.end_date}` });
    logEvent('agreement.ended', `CONTRACT ${a.reference} ENDED ${a.end_date}`, { agreement_id: a.id });
    flushNow();
    return publicAgreement(a);
  });
  const pdfOut = (a) => {
    if (!a.pdf_file) throw httpError(404, 'no document yet — it is made when sent');
    const file = path.join(dir(a.id), a.pdf_file);
    if (!fs.existsSync(file)) throw httpError(404, 'document missing');
    return { __body: fs.readFileSync(file), __headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${a.reference}.pdf"`, 'cache-control': 'private, no-store' } };
  };
  route('GET', '/api/agreements/:id/pdf', ADMIN, ({ params }) => pdfOut(find(params.id)));

  /* ---- client portal ---- */
  function clientFor(user, query) {
    if (user.role === 'SYSTEM_ADMIN') { const c = (db.clients || []).find((x) => x.id === Number(query.get('as_client'))); if (!c) throw httpError(404, 'client not found'); return c; }
    const c = (db.clients || []).find((x) => x.id === user.client_id); if (!c) throw httpError(403, 'no client is linked to this login'); return c;
  }
  const theirs = (a, c) => a.status !== 'DRAFT' && (a.client_id === c.id || (c.site_ids || []).includes(a.site_id));
  const own = (user, query, id) => { const c = clientFor(user, query); const a = db.agreements.find((x) => x.id === Number(id)); if (!a || !theirs(a, c)) throw httpError(404, 'not found'); return { a, c }; };
  route('GET', '/api/client/agreements', CLIENT_OR_ADMIN, ({ user, query }) => {
    const c = clientFor(user, query);
    return db.agreements.filter((a) => theirs(a, c)).slice().reverse().map((a) => publicAgreement(a, { forClient: true }));
  });
  route('GET', '/api/client/agreements/:id/pdf', CLIENT_OR_ADMIN, ({ params, user, query }) => pdfOut(own(user, query, params.id).a));
  const tellAdmins = (a, what) => {
    logEvent(`agreement.${what.toLowerCase()}`, `${a.kind} ${a.reference} ${what} BY THE CLIENT (${a.decided_by_name || a.signed_name})`, { agreement_id: a.id });
    pushToRoles(['SYSTEM_ADMIN'], { title: `${a.kind === 'QUOTE' ? 'Quote' : 'Contract'} ${what.toLowerCase()}`, body: `${a.reference} — ${a.title}`, url: `/contracts.html?id=${a.id}`, tag: `cccs-agreement-${a.id}` });
  };
  route('POST', '/api/client/agreements/:id/accept', CLIENT, ({ params, body, user, query }) => {
    const { a } = own(user, query, params.id);
    if (a.kind !== 'QUOTE') throw httpError(400, 'a contract is signed, not accepted');
    if (statusOf(a) === 'EXPIRED') throw httpError(410, 'this quote has expired — ask us for a new one');
    if (a.status !== 'SENT') throw httpError(409, `this quote is ${a.status.toLowerCase()}`);
    const name = String(body.name || '').trim().slice(0, 120); if (!name) throw httpError(400, 'type your name to accept');
    Object.assign(a, { status: 'ACCEPTED', decided_at: new Date().toISOString(), decided_by_name: name, decided_by_user_id: user.id });
    a.history.push({ at: a.decided_at, by: name, what: 'accepted by the client' });
    writePdf(a, 'accepted.pdf');
    tellAdmins(a, 'ACCEPTED'); emailClient(a, 'ACCEPTED'); flushNow();
    return publicAgreement(a, { forClient: true });
  });
  route('POST', '/api/client/agreements/:id/decline', CLIENT, ({ params, body, user, query }) => {
    const { a } = own(user, query, params.id);
    if (a.kind !== 'QUOTE' || a.status !== 'SENT') throw httpError(409, 'only a quote waiting for an answer can be declined');
    Object.assign(a, { status: 'DECLINED', decided_at: new Date().toISOString(), decided_by_name: String(body.name || user.display_name).slice(0, 120), decline_reason: String(body.reason || '').trim().slice(0, 1000) });
    a.history.push({ at: a.decided_at, by: a.decided_by_name, what: `declined by the client${a.decline_reason ? ` — ${a.decline_reason}` : ''}` });
    tellAdmins(a, 'DECLINED'); flushNow();
    return publicAgreement(a, { forClient: true });
  });
  route('POST', '/api/client/agreements/:id/sign', CLIENT, ({ params, body, user, query }) => {
    const { a } = own(user, query, params.id);
    if (a.kind !== 'CONTRACT' || a.status !== 'SENT') throw httpError(409, 'only a contract waiting for signature can be signed');
    if (body.agreed !== true) throw httpError(400, 'you must agree to the terms');
    const name = String(body.signed_name || '').trim().slice(0, 120); if (!name) throw httpError(400, 'your name is required');
    const sig = body.signature || {};
    const jpeg = sig.mimetype === 'image/jpeg' && sig.data ? Buffer.from(String(sig.data).replace(/^data:[^,]*,/, ''), 'base64') : null;
    if (!jpeg || jpeg.length > 600000 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw httpError(400, 'a signature is required');
    Object.assign(a, { status: 'SIGNED', signed_name: name, signed_position: String(body.position || '').trim().slice(0, 120), signed_at: new Date().toISOString(), signed_by_user_id: user.id });
    fs.mkdirSync(dir(a.id), { recursive: true });
    fs.writeFileSync(path.join(dir(a.id), 'signature.jpg'), jpeg);
    writePdf(a, 'signed.pdf', jpeg);
    a.history.push({ at: a.signed_at, by: name, what: 'signed by the client' });
    tellAdmins(a, 'SIGNED'); emailClient(a, 'SIGNED'); flushNow();
    return publicAgreement(a, { forClient: true });
  });

  return { find, statusOf, LINE_KINDS, BASES, PERIODS };
};
module.exports.DEFAULT_CONTRACT_TERMS = DEFAULT_CONTRACT_TERMS;
