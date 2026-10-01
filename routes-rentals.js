/**
 * Asset rental — hiring tagged assets out to a client or to one of their
 * sites, with a signed agreement.
 *
 * THE FLOW. An admin starts a rental, scans the tags of the items going out,
 * picks the client or site, and hands the screen to the person collecting,
 * who reads the terms and signs. On submit the items go ON_HIRE and a PDF
 * agreement is generated — company and hirer details, the items with serials
 * and condition, hire period, charges, the terms and conditions in force at
 * that moment (snapshotted, so later edits never rewrite a signed agreement),
 * and the signature. The PDF is kept with the rental, printable from the
 * Rentals page, and appears in that client's portal.
 *
 * RETURNS. From the Rentals page (all items, or some) or by scanning an item
 * at Sign in / out. Each return records date, condition and who received
 * it, puts the asset back in store (In repair if returned damaged, Lost if
 * reported lost), produces a return note PDF, and the portal shows the
 * item as returned. A rental is RETURNED once every item is back.
 *
 * Who: admins create rentals, see the list and edit the terms. Control
 * roles may RECEIVE returns (they run the sign-in desk). Clients see only
 * rentals to themselves or their own sites, read-only, with the PDFs.
 * The signature is a JPEG (white background) — it goes into the PDF as-is.
 *
 * Registrar pattern — server.js passes in what this needs.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Doc } = require('./pdf.js');

const CHARGE_PERIODS = { DAY: 'per day', WEEK: 'per week', MONTH: 'per month', FIXED: 'fixed charge' };
const RETURN_CONDITIONS = ['NEW', 'GOOD', 'FAIR', 'POOR', 'DAMAGED', 'LOST'];
const SIG_MAX = 600000;

const DEFAULT_TERMS = `1. Ownership. The equipment remains the property of the Company at all times. The Hirer must not sell, lend, sub-hire, charge or part with possession of it.
2. Hire period. The hire starts when this agreement is signed and ends when every item has been returned to and signed back in by the Company. Charges apply for the whole hire period, including any time past the agreed return date.
3. Use and care. The Hirer will use the equipment only for its intended purpose, by competent people, in line with any instructions given, keep it secure and in a clean, dry place, and not alter, repair or open it.
4. Loss and damage. From collection until return the Hirer is responsible for the equipment and for any loss, theft or damage to it other than fair wear and tear. The Hirer must tell the Company within 24 hours of any loss, theft, damage or fault, and report a theft to the police and give the Company the crime reference. Repair or replacement will be charged at the Company's current cost.
5. Electrical equipment. Electrical items are safety tested before hire. The Hirer must stop using any item that appears damaged or faulty and tell the Company immediately.
6. Insurance. The Hirer will insure the equipment for its full replacement value for the whole hire period.
7. Charges and payment. Hire charges and any deposit are as stated in this agreement. Unless agreed otherwise, invoices are payable within 30 days.
8. Return. The equipment must be returned complete, with all accessories, clean and in the condition it was supplied, by the agreed return date or earlier on request. Its condition is recorded on return.
9. Recordings and data. Where equipment records audio, video or location data, the Hirer is responsible for the lawful use of anything recorded during the hire.
10. Liability. Nothing in this agreement limits liability for death or personal injury caused by negligence. Otherwise the Company is not liable for any indirect or consequential loss arising from the hire.
11. Law. This agreement is governed by the law of England and Wales.`;

module.exports = function registerRentalRoutes({
  route, httpError, CONTROL, ADMIN, CLIENT, db, nextId, logEvent, UPLOADS_DIR, publicAsset, flushNow = () => {},
}) {
  for (const t of ['rentals', 'asset_events', 'assets', 'asset_checkouts', 'ui_settings']) if (!Array.isArray(db[t])) db[t] = [];
  const dir = (id) => path.join(UPLOADS_DIR, 'rentals', String(id));
  const CLIENT_OR_ADMIN = [...CLIENT, 'SYSTEM_ADMIN'];

  /* ---- settings: company details and the terms ---- */
  function settings() {
    const row = db.ui_settings.find((r) => r.key === 'rental') || {};
    return {
      company_name: row.company_name || 'Echelon', company_address: row.company_address || '',
      company_phone: row.company_phone || '', company_email: row.company_email || '',
      terms: row.terms || DEFAULT_TERMS, terms_are_default: !row.terms,
    };
  }
  route('GET', '/api/rentals/settings', ADMIN, () => settings());
  route('PUT', '/api/rentals/settings', ADMIN, ({ body, user }) => {
    let row = db.ui_settings.find((r) => r.key === 'rental');
    if (!row) { row = { key: 'rental' }; db.ui_settings.push(row); }
    for (const k of ['company_name', 'company_address', 'company_phone', 'company_email']) if (k in body) row[k] = String(body[k] || '').trim().slice(0, k === 'company_address' ? 300 : 120);
    if ('terms' in body) {
      const t = String(body.terms || '').trim();
      if (t.length > 20000) throw httpError(400, 'the terms are too long');
      row.terms = t || null; // empty = back to the standard terms
    }
    row.updated_at = new Date().toISOString(); row.updated_by = user.username;
    logEvent('rental.settings_updated', `RENTAL TERMS / COMPANY DETAILS UPDATED BY ${user.username}`, {});
    flushNow();
    return settings();
  });

  /* ---- helpers ---- */
  const findRental = (id) => { const r = db.rentals.find((x) => x.id === Number(id)); if (!r) throw httpError(404, 'rental not found'); return r; };
  const outstanding = (r) => r.items.filter((i) => !i.returned_at);
  const fmt = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }) : '—');
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' }) : '—');
  const words = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
  const money = (n) => `£${Number(n).toFixed(2)}`;
  const event = (asset, type, user, note, detail) => db.asset_events.push({ id: nextId('asset_events'), asset_id: asset.id, type, at: new Date().toISOString(), by: user.display_name, note: note || '', detail });
  function publicRental(r) {
    return {
      ...r, signature: undefined, files: undefined,
      outstanding: outstanding(r).length,
      overdue: r.status !== 'RETURNED' && r.expected_return_at && Date.parse(r.expected_return_at) < Date.now(),
      agreement_url: `/api/rentals/${r.id}/agreement`,
      return_notes: (r.returns || []).map((x, i) => ({ n: i + 1, at: x.at, by: x.by, count: x.asset_ids.length, url: `/api/rentals/${r.id}/returns/${i + 1}` })),
    };
  }

  /* ---- PDFs ---- */
  function header(doc, s, title, r) {
    doc.para(s.company_name, { size: 18, bold: true, gap: 0 });
    const contact = [s.company_address, s.company_phone, s.company_email].filter(Boolean).join('  ·  ');
    if (contact) doc.para(contact, { size: 9, color: [0.35, 0.38, 0.42], gap: 6 });
    doc.rule(6);
    doc.para(title, { size: 15, bold: true, gap: 2 });
    doc.para(`Reference ${r.reference}`, { size: 10, color: [0.35, 0.38, 0.42], gap: 6 });
  }
  function hirerRows(r) {
    return [
      ['Hirer', r.hirer_name], ...(r.site_name ? [['Site', `${r.site_name}${r.site_address ? `, ${r.site_address}` : ''}`]] : []),
      ...(r.client_name && r.hirer_type === 'SITE' ? [['Client', r.client_name]] : []),
      ['Contact', [r.contact_name, r.contact_phone, r.contact_email].filter(Boolean).join(' · ')],
    ];
  }
  function agreementPdf(r, signatureJpeg) {
    const s = r.company;
    const doc = new Doc({ footer: `${s.company_name} — rental agreement ${r.reference}` });
    header(doc, s, 'Equipment rental agreement', r);
    doc.pairs([...hirerRows(r),
      ['Hire starts', fmt(r.start_at)], ['Agreed return', r.expected_return_at ? fmtDate(r.expected_return_at) : 'On request'],
      ...(r.charge_amount != null ? [['Hire charge', `${money(r.charge_amount)} ${CHARGE_PERIODS[r.charge_period] || ''}`.trim()]] : []),
      ...(r.deposit != null ? [['Deposit', money(r.deposit)]] : []),
      ['Issued by', r.created_by_name]]);
    doc.heading('Equipment', 12);
    doc.table([{ title: 'Tag', width: 0.16 }, { title: 'Item', width: 0.42 }, { title: 'Serial no.', width: 0.24 }, { title: 'Condition', width: 0.18 }],
      r.items.map((i) => [i.tag || '—', [i.description, i.make_model].filter(Boolean).join(' — '), i.serial_no || '—', words(i.condition_out) || '—']));
    doc.para(`${r.items.length} item${r.items.length === 1 ? '' : 's'} in total.`, { size: 9, color: [0.35, 0.38, 0.42], gap: 6 });
    if (r.notes) { doc.heading('Notes', 12); doc.para(r.notes, { size: 10 }); }
    doc.heading('Terms and conditions of rental', 12);
    for (const p of String(r.terms).split(/\n+/)) doc.para(p, { size: 8.5, gap: 3 });
    doc.room(230); // keep the heading, wording and signature together
    doc.heading('Signed for the hirer', 12);
    doc.para(`By signing, the hirer confirms they have received the equipment listed above in the condition stated and agrees to the terms and conditions above.`, { size: 9, gap: 6 });
    doc.room(130);
    const boxTop = doc.y;
    doc.rect(doc.margin, boxTop - 100, 240, 96, { stroke: 0.8 });
    doc.y = boxTop - 4;
    doc.image(signatureJpeg, { maxW: 232, maxH: 88, x: doc.margin + 4 });
    doc.y = boxTop - 104;
    doc.pairs([['Name', r.signed_name], ['Signed', fmt(r.signed_at)]], { labelWidth: 60 });
    return doc.toBuffer();
  }
  function returnPdf(r, ret) {
    const s = r.company;
    const doc = new Doc({ footer: `${s.company_name} — return note for ${r.reference}` });
    header(doc, s, 'Equipment return note', r);
    doc.pairs([...hirerRows(r), ['Hired from', fmt(r.start_at)], ['Returned', fmt(ret.at)], ['Received by', ret.by]]);
    doc.heading('Returned', 12);
    const items = r.items.filter((i) => ret.asset_ids.includes(i.asset_id));
    doc.table([{ title: 'Tag', width: 0.16 }, { title: 'Item', width: 0.44 }, { title: 'Out', width: 0.18 }, { title: 'Back', width: 0.22 }],
      items.map((i) => [i.tag || '—', i.description, words(i.condition_out) || '—', i.returned_condition === 'LOST' ? 'Not returned — lost' : words(i.returned_condition) || '—']));
    if (ret.note) { doc.heading('Notes', 12); doc.para(ret.note); }
    const still = outstanding(r);
    doc.heading(still.length ? 'Still on hire' : 'Hire complete', 12);
    if (still.length) doc.table([{ title: 'Tag', width: 0.2 }, { title: 'Item', width: 0.8 }], still.map((i) => [i.tag || '—', i.description]));
    else doc.para('Every item on this agreement has now been returned.', { size: 10 });
    return doc.toBuffer();
  }

  /* ---- rentals ---- */
  route('GET', '/api/rentals', ADMIN, ({ query }) => {
    const status = (query.get('status') || '').toUpperCase();
    return db.rentals.filter((r) => !status || (status === 'OPEN' ? r.status !== 'RETURNED' : r.status === status))
      .slice().reverse().map(publicRental);
  });
  route('GET', '/api/rentals/:id', ADMIN, ({ params }) => publicRental(findRental(params.id)));

  route('POST', '/api/rentals', ADMIN, ({ body, user }) => {
    // What is going out — every item must be in store and free.
    const ids = [...new Set((Array.isArray(body.asset_ids) ? body.asset_ids : []).map(Number))];
    if (!ids.length) throw httpError(400, 'scan at least one item');
    if (ids.length > 200) throw httpError(400, 'too many items on one agreement');
    const assets = ids.map((id) => {
      const a = db.assets.find((x) => x.id === id && !x.is_stock_tracked);
      if (!a) throw httpError(400, `asset #${id} not found`);
      const label = a.tag || a.description;
      if (a.status !== 'IN_STORE') throw httpError(409, `${label} is ${words(a.status).toLowerCase()} — only items in store can be hired out`);
      if (db.asset_checkouts.some((c) => c.asset_id === a.id && !c.returned_at)) throw httpError(409, `${label} is signed out to staff`);
      return a;
    });
    // Who to.
    let client = null, site = null;
    if (body.site_id) {
      site = db.sites.find((x) => x.id === Number(body.site_id)); if (!site) throw httpError(400, 'site not found');
      client = (db.clients || []).find((c) => (c.site_ids || []).includes(site.id)) || null;
    } else if (body.client_id) {
      client = (db.clients || []).find((c) => c.id === Number(body.client_id)); if (!client) throw httpError(400, 'client not found');
    } else throw httpError(400, 'choose the client or site');
    const signedName = String(body.signed_name || '').trim().slice(0, 120);
    if (!signedName) throw httpError(400, 'the name of the person signing is required');
    if (body.agreed !== true) throw httpError(400, 'the hirer must agree to the terms');
    const sig = body.signature || {};
    if (sig.mimetype !== 'image/jpeg' || !sig.data) throw httpError(400, 'a signature is required');
    const jpeg = Buffer.from(String(sig.data).replace(/^data:[^,]*,/, ''), 'base64');
    if (jpeg.length > SIG_MAX || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw httpError(400, 'the signature image is not valid');
    const num = (k) => { if (body[k] == null || body[k] === '') return null; const n = Number(body[k]); if (!Number.isFinite(n) || n < 0) throw httpError(400, `${k.replace('_', ' ')} must be 0 or more`); return n; };
    const charge = num('charge_amount'), deposit = num('deposit');
    const period = charge != null ? (CHARGE_PERIODS[body.charge_period] ? body.charge_period : 'WEEK') : null;
    const expected = body.expected_return_at ? new Date(body.expected_return_at) : null;
    if (expected && isNaN(expected)) throw httpError(400, 'invalid return date');

    const id = nextId('rentals'), now = new Date();
    const s = settings();
    const r = {
      id, reference: `RENT-${now.getFullYear()}-${String(id).padStart(5, '0')}`, status: 'ON_HIRE',
      hirer_type: site ? 'SITE' : 'CLIENT', client_id: client ? client.id : null, site_id: site ? site.id : null,
      hirer_name: site ? (client ? `${client.name} — ${site.name}` : site.name) : client.name,
      client_name: client ? client.name : null, site_name: site ? site.name : null, site_address: site ? site.address || '' : '',
      contact_name: String(body.contact_name || signedName).trim().slice(0, 120), contact_phone: String(body.contact_phone || '').slice(0, 40), contact_email: String(body.contact_email || '').slice(0, 120),
      start_at: now.toISOString(), expected_return_at: expected ? expected.toISOString() : null,
      charge_amount: charge, charge_period: period, deposit, notes: String(body.notes || '').slice(0, 2000),
      items: assets.map((a) => ({
        asset_id: a.id, tag: a.tag || null, description: a.description, make_model: [a.make, a.model].filter(Boolean).join(' '),
        serial_no: a.serial_no || '', condition_out: a.condition || null, returned_at: null, returned_condition: null, returned_by: null,
      })),
      signed_name: signedName, signed_at: now.toISOString(),
      company: { company_name: s.company_name, company_address: s.company_address, company_phone: s.company_phone, company_email: s.company_email },
      terms: s.terms, created_by: user.id, created_by_name: user.display_name, created_at: now.toISOString(), returns: [],
    };
    const pdf = agreementPdf(r, jpeg);
    fs.mkdirSync(dir(id), { recursive: true });
    fs.writeFileSync(path.join(dir(id), 'signature.jpg'), jpeg);
    fs.writeFileSync(path.join(dir(id), 'agreement.pdf'), pdf);
    db.rentals.push(r);
    for (const a of assets) { a.status = 'ON_HIRE'; a.rental_id = r.id; event(a, 'HIRED_OUT', user, '', `${r.reference} to ${r.hirer_name}`); }
    logEvent('rental.created', `RENTAL ${r.reference}: ${assets.length} ITEM(S) TO ${r.hirer_name.toUpperCase()} BY ${user.display_name}`, { rental_id: r.id });
    flushNow();
    return { __status: 201, __body: publicRental(r) };
  });

  /** All outstanding items, or the asset_ids given. Control may do this —
   * the sign-in desk receives returns. */
  route('POST', '/api/rentals/:id/return', CONTROL, ({ params, body, user }) => {
    const r = findRental(params.id);
    const open = outstanding(r);
    if (!open.length) throw httpError(409, 'everything on this rental is already back');
    const wanted = Array.isArray(body.asset_ids) && body.asset_ids.length ? body.asset_ids.map(Number) : open.map((i) => i.asset_id);
    const conditions = body.conditions && typeof body.conditions === 'object' ? body.conditions : {};
    const items = wanted.map((aid) => {
      const i = r.items.find((x) => x.asset_id === aid);
      if (!i) throw httpError(400, `asset #${aid} is not on ${r.reference}`);
      if (i.returned_at) throw httpError(409, `${i.tag || i.description} is already back`);
      const cond = conditions[aid] || body.condition || i.condition_out || 'GOOD';
      if (!RETURN_CONDITIONS.includes(cond)) throw httpError(400, `condition must be one of ${RETURN_CONDITIONS.join(', ')}`);
      return { i, cond };
    });
    const at = new Date().toISOString();
    for (const { i, cond } of items) {
      Object.assign(i, { returned_at: at, returned_condition: cond, returned_by: user.display_name });
      const a = db.assets.find((x) => x.id === i.asset_id);
      if (a) {
        a.rental_id = null;
        a.status = cond === 'LOST' ? 'LOST' : cond === 'DAMAGED' ? 'IN_REPAIR' : 'IN_STORE';
        if (cond !== 'LOST') a.condition = cond;
        event(a, cond === 'LOST' ? 'REPORTED_LOST' : 'HIRE_RETURNED', user, body.note, `${r.reference} from ${r.hirer_name}, condition ${cond.toLowerCase()}`);
      }
    }
    const ret = { at, by: user.display_name, asset_ids: items.map((x) => x.i.asset_id), note: String(body.note || '').slice(0, 1000) };
    r.returns = r.returns || []; r.returns.push(ret);
    r.status = outstanding(r).length ? 'PART_RETURNED' : 'RETURNED';
    if (r.status === 'RETURNED') r.returned_at = at;
    fs.mkdirSync(dir(r.id), { recursive: true });
    fs.writeFileSync(path.join(dir(r.id), `return-${r.returns.length}.pdf`), returnPdf(r, ret));
    logEvent('rental.returned', `RENTAL ${r.reference}: ${items.length} ITEM(S) RETURNED${r.status === 'RETURNED' ? ' — COMPLETE' : ''}`, { rental_id: r.id });
    flushNow();
    return publicRental(r);
  });

  const pdfOut = (file, name) => {
    if (!fs.existsSync(file)) throw httpError(404, 'document missing');
    return { __body: fs.readFileSync(file), __headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${name}"`, 'cache-control': 'private, no-store' } };
  };
  route('GET', '/api/rentals/:id/agreement', ADMIN, ({ params }) => { const r = findRental(params.id); return pdfOut(path.join(dir(r.id), 'agreement.pdf'), `${r.reference}.pdf`); });
  route('GET', '/api/rentals/:id/returns/:n', ADMIN, ({ params }) => { const r = findRental(params.id); return pdfOut(path.join(dir(r.id), `return-${Number(params.n)}.pdf`), `${r.reference}-return-${Number(params.n)}.pdf`); });

  /* ---- client portal: their rentals only ---- */
  function clientFor(user, query) {
    if (user.role === 'SYSTEM_ADMIN') {
      const c = (db.clients || []).find((x) => x.id === Number(query.get('as_client')));
      if (!c) throw httpError(404, 'client not found'); return c;
    }
    const c = (db.clients || []).find((x) => x.id === user.client_id);
    if (!c) throw httpError(403, 'no client is linked to this login'); return c;
  }
  const isTheirs = (r, c) => r.client_id === c.id || (r.site_id && (c.site_ids || []).includes(r.site_id));
  route('GET', '/api/client/rentals', CLIENT_OR_ADMIN, ({ user, query }) => {
    const c = clientFor(user, query);
    return db.rentals.filter((r) => isTheirs(r, c)).slice().reverse().map((r) => ({
      id: r.id, reference: r.reference, status: r.status, hirer_name: r.hirer_name, site_name: r.site_name, start_at: r.start_at,
      expected_return_at: r.expected_return_at, signed_name: r.signed_name,
      items: r.items.map((i) => ({ tag: i.tag, description: i.description, serial_no: i.serial_no, returned_at: i.returned_at, returned_condition: i.returned_condition })),
      return_notes: (r.returns || []).map((x, n) => ({ n: n + 1, at: x.at })),
    }));
  });
  const ownRental = (user, query, id) => { const c = clientFor(user, query); const r = db.rentals.find((x) => x.id === Number(id)); if (!r || !isTheirs(r, c)) throw httpError(404, 'rental not found'); return r; };
  route('GET', '/api/client/rentals/:id/agreement', CLIENT_OR_ADMIN, ({ params, user, query }) => { const r = ownRental(user, query, params.id); return pdfOut(path.join(dir(r.id), 'agreement.pdf'), `${r.reference}.pdf`); });
  route('GET', '/api/client/rentals/:id/returns/:n', CLIENT_OR_ADMIN, ({ params, user, query }) => { const r = ownRental(user, query, params.id); return pdfOut(path.join(dir(r.id), `return-${Number(params.n)}.pdf`), `${r.reference}-return-${Number(params.n)}.pdf`); });

  /* ---- sign in / out desk: find an item by its tag, and what is out ---- */
  function deskView(a) {
    const co = db.asset_checkouts.find((c) => c.asset_id === a.id && !c.returned_at);
    const p = co ? db.personnel.find((x) => x.id === co.personnel_id) : null;
    const r = a.rental_id ? db.rentals.find((x) => x.id === a.rental_id) : null;
    return {
      ...publicAsset(a),
      checkout: co ? { id: co.id, personnel_id: co.personnel_id, personnel_name: p ? p.name : null, checked_out_at: co.checked_out_at, expected_return_at: co.expected_return_at || null, overdue: Boolean(co.expected_return_at && Date.parse(co.expected_return_at) < Date.now()) } : null,
      rental: r ? { id: r.id, reference: r.reference, hirer_name: r.hirer_name, start_at: r.start_at, expected_return_at: r.expected_return_at, overdue: Boolean(r.expected_return_at && Date.parse(r.expected_return_at) < Date.now()) } : null,
    };
  }
  route('GET', '/api/assets/lookup', CONTROL, ({ query }) => {
    if (query.get('id')) {
      const byId = db.assets.find((x) => !x.is_stock_tracked && x.id === Number(query.get('id')));
      if (!byId) throw httpError(404, 'asset not found');
      return deskView(byId);
    }
    const tag = String(query.get('tag') || '').trim();
    if (!tag) throw httpError(400, 'tag required');
    const a = db.assets.find((x) => !x.is_stock_tracked && x.tag && x.tag.toLowerCase() === tag.toLowerCase())
      || db.assets.find((x) => !x.is_stock_tracked && x.serial_no && x.serial_no.toLowerCase() === tag.toLowerCase());
    if (!a) throw httpError(404, `no asset with tag ${tag}`);
    return deskView(a);
  });
  route('GET', '/api/assets/out', CONTROL, () => db.assets.filter((a) => !a.is_stock_tracked && (a.rental_id || db.asset_checkouts.some((c) => c.asset_id === a.id && !c.returned_at))).map(deskView));

  return { settings };
};
module.exports.DEFAULT_TERMS = DEFAULT_TERMS;
