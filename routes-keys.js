/**
 * Key management — chain of custody for physical client-site keys.
 *
 * Keys live in sealed WALLETS (a real tamper-evident seal, a physical
 * code read off by hand — this never generates or scans a seal, it only
 * records what a person typed, as an audit trail and a catch for the
 * wrong-wallet/typo case). Wallets live inside portable SAFES, signed out
 * of the office and back in, with every tag checked each time. A wallet
 * moves between safes. Admin/control run tag-check audits, scheduled or
 * random — one TAG_CHECK event type covers both, there's no scheduling
 * system to build here, just a logged finding.
 *
 * A key permanently leaving the register must end in one of two
 * dispositions: RETURNED_TO_CLIENT (their signature required — reuses
 * the exact signature-capture mechanism routes-rentals.js already uses,
 * public/forms-ui.js's signaturePad) or DISPOSED (a Certificate of
 * Destruction is generated via pdf.js's Doc, same way invoicePdf/
 * payslipPdf are built, and emailed to the client the same fire-and-
 * forget way routes-invoices.js's emailInvoice does — if no client email
 * is on file this does not block disposal, it just says so).
 *
 * safe_checkouts mirrors asset_checkouts (server.js) exactly: one open
 * row per safe, returned_at/returned_by null until return. key_events is
 * one generic timeline shared by safes/wallets/keys, same shape as
 * routes-inventory.js's asset_events.
 *
 * Registrar pattern — server.js passes in what this needs.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Doc } = require('./pdf.js');

const SIG_MAX = 600000;

module.exports = function registerKeyRoutes({
  route, httpError, ALL, CONTROL, ADMIN, db, nextId, logEvent, isControlRole,
  UPLOADS_DIR, sendEmail, flushNow = () => {},
}) {
  for (const t of ['safes', 'safe_checkouts', 'key_wallets', 'keys', 'key_events']) if (!Array.isArray(db[t])) db[t] = [];
  const dir = (id) => path.join(UPLOADS_DIR, 'keys', String(id));
  const billTo = (c) => (c ? c.billing_email || c.contact_email || '' : '');
  const clientFor = (k) => (k.site_id ? (db.clients || []).find((c) => (c.site_ids || []).includes(k.site_id)) || null : null);

  const findSafe = (id) => { const s = db.safes.find((x) => x.id === Number(id)); if (!s) throw httpError(404, 'safe not found'); return s; };
  const findWallet = (id) => { const w = db.key_wallets.find((x) => x.id === Number(id)); if (!w) throw httpError(404, 'wallet not found'); return w; };
  const findKey = (id) => { const k = db.keys.find((x) => x.id === Number(id)); if (!k) throw httpError(404, 'key not found'); return k; };

  function keyEvent(subjectType, subjectId, type, user, note, data = {}) {
    const e = { id: nextId('key_events'), subject_type: subjectType, subject_id: subjectId, type, at: new Date().toISOString(), by: user.display_name, note: String(note || '').slice(0, 500), ...data };
    db.key_events.push(e);
    return e;
  }

  function publicSafe(s) {
    const co = db.safe_checkouts.find((c) => c.safe_id === s.id && !c.returned_at);
    const holder = co ? db.personnel.find((p) => p.id === co.personnel_id) : null;
    return {
      ...s, seal_code: undefined, has_seal_code: Boolean(s.seal_code),
      current_holder: holder ? holder.name : null, checkout_id: co ? co.id : null,
      wallets: db.key_wallets.filter((w) => w.safe_id === s.id).map((w) => ({ id: w.id, tag_id: w.tag_id, label: w.label, status: w.status })),
    };
  }
  function publicWallet(w) {
    const s = db.safes.find((x) => x.id === w.safe_id);
    return {
      ...w, seal_code: undefined, has_seal_code: Boolean(w.seal_code),
      safe_tag: s ? s.tag_id : null,
      keys: db.keys.filter((k) => k.wallet_id === w.id && k.status === 'IN_WALLET').map(publicKey),
    };
  }
  function publicKey(k) {
    const w = db.key_wallets.find((x) => x.id === k.wallet_id);
    return { ...k, wallet_tag: w ? w.tag_id : null };
  }

  /* ---- safes --------------------------------------------------------- */
  route('GET', '/api/safes', ALL, () => db.safes.map(publicSafe));
  route('GET', '/api/safes/:id', ALL, ({ params }) => publicSafe(findSafe(params.id)));
  route('POST', '/api/safes', ADMIN, ({ body, user }) => {
    const tagId = String(body.tag_id || '').trim();
    if (!tagId) throw httpError(400, 'tag_id required');
    const s = {
      id: nextId('safes'), tag_id: tagId, label: String(body.label || '').trim().slice(0, 120),
      notes: String(body.notes || '').slice(0, 1000), status: 'IN_OFFICE',
      seal_code: body.seal_code ? String(body.seal_code).trim() : null,
      created_at: new Date().toISOString(), created_by: user.id,
    };
    db.safes.push(s);
    logEvent('safe.created', `SAFE ${s.tag_id} CREATED`, { safe_id: s.id });
    flushNow();
    return { __status: 201, __body: publicSafe(s) };
  });
  route('PATCH', '/api/safes/:id', ADMIN, ({ params, body }) => {
    const s = findSafe(params.id);
    if ('label' in body) s.label = String(body.label || '').trim().slice(0, 120);
    if ('notes' in body) s.notes = String(body.notes || '').slice(0, 1000);
    if ('seal_code' in body) s.seal_code = body.seal_code ? String(body.seal_code).trim() : null;
    flushNow();
    return publicSafe(s);
  });
  route('GET', '/api/safes/:id/events', ALL, ({ params }) => {
    const s = findSafe(params.id);
    return db.key_events.filter((e) => e.subject_type === 'SAFE' && e.subject_id === s.id).slice().reverse();
  });
  route('GET', '/api/safes/:id/checkouts', ALL, ({ params }) => {
    const s = findSafe(params.id);
    return db.safe_checkouts.filter((c) => c.safe_id === s.id).slice().reverse();
  });

  /* A safe is signed out to a person and must be signed back in — same
   * shape as asset_checkouts in server.js: FIELD_USER acts only on
   * themselves, a control role may act for anyone. Both the tag check and
   * (at checkout only) the "not left in a vehicle overnight" promise are
   * explicit booleans the caller must affirmatively set true. */
  route('POST', '/api/safes/:id/checkout', ALL, ({ params, body, user }) => {
    const s = findSafe(params.id);
    if (db.safe_checkouts.some((c) => c.safe_id === s.id && !c.returned_at)) throw httpError(409, 'safe is already signed out — sign it back in first');
    let personnelId;
    if (user.role === 'FIELD_USER') {
      if (!user.personnel_id) throw httpError(400, 'no personnel record linked to your account');
      personnelId = user.personnel_id;
    } else {
      const p = body.personnel_id ? db.personnel.find((x) => x.id === Number(body.personnel_id)) : null;
      if (!p) throw httpError(400, 'personnel_id required');
      personnelId = p.id;
    }
    if (body.tags_confirmed !== true) throw httpError(400, 'confirm all tags have been checked');
    if (body.not_left_in_vehicle_confirmed !== true) throw httpError(400, 'confirm the safe will not be left in a vehicle overnight');
    const co = {
      id: nextId('safe_checkouts'), safe_id: s.id, personnel_id: personnelId,
      checked_out_at: new Date().toISOString(), checked_out_by: user.id,
      returned_at: null, returned_by: null,
      tags_confirmed: true, not_left_in_vehicle_confirmed: true, tags_confirmed_in: null,
      notes: String(body.notes || '').slice(0, 1000), return_notes: '',
    };
    db.safe_checkouts.push(co);
    s.status = 'SIGNED_OUT';
    logEvent('safe.checked_out', `SAFE ${s.tag_id} CHECKED OUT`, { safe_id: s.id, checkout_id: co.id });
    flushNow();
    return { __status: 201, __body: publicSafe(s) };
  });
  route('POST', '/api/safes/:id/checkin', ALL, ({ params, body, user }) => {
    const s = findSafe(params.id);
    const co = db.safe_checkouts.find((c) => c.safe_id === s.id && !c.returned_at);
    if (!co) throw httpError(409, 'safe is not currently signed out');
    if (!isControlRole(user.role) && user.personnel_id !== co.personnel_id) throw httpError(403, 'not your checkout');
    if (body.tags_confirmed !== true) throw httpError(400, 'confirm all tags have been checked');
    co.returned_at = new Date().toISOString(); co.returned_by = user.id;
    co.tags_confirmed_in = true;
    co.return_notes = String(body.notes || '').slice(0, 1000);
    s.status = 'IN_OFFICE';
    logEvent('safe.returned', `SAFE ${s.tag_id} SIGNED BACK IN`, { safe_id: s.id, checkout_id: co.id });
    flushNow();
    return publicSafe(s);
  });

  /* ---- tag-check audits — one shape covers scheduled and random ---- */
  const tagCheck = (subjectType, findFn) => ({ params, body, user }) => {
    const item = findFn(params.id);
    const result = String(body.result || '').toUpperCase();
    if (!['PASS', 'FAIL'].includes(result)) throw httpError(400, 'result must be PASS or FAIL');
    keyEvent(subjectType, item.id, 'TAG_CHECK', user, body.note || '', { result });
    logEvent('tag_check.recorded', `${subjectType} ${item.tag_id} TAG CHECK: ${result}`, { subject_type: subjectType, subject_id: item.id, result });
    flushNow();
    return { ok: true, result };
  };
  route('POST', '/api/safes/:id/tag-check', CONTROL, tagCheck('SAFE', findSafe));
  route('POST', '/api/wallets/:id/tag-check', CONTROL, tagCheck('WALLET', findWallet));

  /* ---- wallets --------------------------------------------------------
   * Created already SEALED with the seal applied when first packed. From
   * there it only ever moves through open -> reseal cycles; nothing
   * mutates status or seal_code except those two routes (and PATCH, for
   * an admin correction such as a relabel — never seal_code/status). */
  route('GET', '/api/wallets', ALL, ({ query }) => {
    const safeId = query.get('safe_id');
    return db.key_wallets.filter((w) => !safeId || w.safe_id === Number(safeId)).map(publicWallet);
  });
  route('GET', '/api/wallets/:id', ALL, ({ params }) => publicWallet(findWallet(params.id)));
  route('POST', '/api/wallets', ADMIN, ({ body }) => {
    const s = findSafe(body.safe_id);
    const tagId = String(body.tag_id || '').trim();
    if (!tagId) throw httpError(400, 'tag_id required');
    const sealCode = String(body.seal_code || '').trim();
    if (!sealCode) throw httpError(400, 'seal_code required — the seal applied when first packed');
    const w = {
      id: nextId('key_wallets'), safe_id: s.id, tag_id: tagId, label: String(body.label || '').trim().slice(0, 120),
      status: 'SEALED', seal_code: sealCode, created_at: new Date().toISOString(),
    };
    db.key_wallets.push(w);
    logEvent('wallet.created', `WALLET ${w.tag_id} CREATED IN SAFE ${s.tag_id}`, { wallet_id: w.id, safe_id: s.id });
    flushNow();
    return { __status: 201, __body: publicWallet(w) };
  });
  route('PATCH', '/api/wallets/:id', ADMIN, ({ params, body }) => {
    const w = findWallet(params.id);
    if ('label' in body) w.label = String(body.label || '').trim().slice(0, 120);
    flushNow();
    return publicWallet(w);
  });
  route('GET', '/api/wallets/:id/events', ALL, ({ params }) => {
    const w = findWallet(params.id);
    return db.key_events.filter((e) => e.subject_type === 'WALLET' && e.subject_id === w.id).slice().reverse();
  });
  route('POST', '/api/wallets/:id/open', ALL, ({ params, body, user }) => {
    const w = findWallet(params.id);
    if (w.status !== 'SEALED') throw httpError(409, 'wallet is already open');
    if (!body.job_id) throw httpError(400, 'job_id required');
    const job = db.jobs.find((x) => x.id === Number(body.job_id));
    if (!job) throw httpError(404, 'job not found');
    const code = String(body.seal_code || '').trim();
    if (!code) throw httpError(400, 'seal_code required');
    if (code !== w.seal_code) throw httpError(409, "seal code does not match this wallet's recorded seal — check you have the right wallet");
    w.status = 'OPEN'; w.seal_code = null;
    keyEvent('WALLET', w.id, 'OPENED', user, body.reason || '', { job_id: job.id });
    logEvent('wallet.opened', `WALLET ${w.tag_id} OPENED ON JOB ${job.reference}`, { wallet_id: w.id, job_id: job.id });
    flushNow();
    return publicWallet(w);
  });
  route('POST', '/api/wallets/:id/reseal', ALL, ({ params, body, user }) => {
    const w = findWallet(params.id);
    if (w.status !== 'OPEN') throw httpError(409, 'wallet is not currently open');
    const code = String(body.new_seal_code || '').trim();
    if (!code) throw httpError(400, 'new_seal_code required');
    w.seal_code = code; w.status = 'SEALED';
    keyEvent('WALLET', w.id, 'RESEALED', user, body.notes || '', {});
    logEvent('wallet.resealed', `WALLET ${w.tag_id} RESEALED`, { wallet_id: w.id });
    flushNow();
    return publicWallet(w);
  });
  route('POST', '/api/wallets/:id/transfer', CONTROL, ({ params, body, user }) => {
    const w = findWallet(params.id);
    const to = findSafe(body.to_safe_id);
    if (to.id === w.safe_id) throw httpError(400, 'choose a different safe');
    const from_safe_id = w.safe_id;
    w.safe_id = to.id;
    keyEvent('WALLET', w.id, 'TRANSFERRED', user, body.notes || '', { from_safe_id, to_safe_id: to.id });
    logEvent('wallet.transferred', `WALLET ${w.tag_id} MOVED TO SAFE ${to.tag_id}`, { wallet_id: w.id, from_safe_id, to_safe_id: to.id });
    flushNow();
    return publicWallet(w);
  });

  /* ---- the key register ---- */
  route('GET', '/api/keys', ALL, ({ query }) => {
    const walletId = query.get('wallet_id'), siteId = query.get('site_id'), status = query.get('status');
    return db.keys.filter((k) => (!walletId || k.wallet_id === Number(walletId)) && (!siteId || k.site_id === Number(siteId)) && (!status || k.status === status)).map(publicKey);
  });
  route('GET', '/api/keys/:id', ALL, ({ params }) => publicKey(findKey(params.id)));
  route('GET', '/api/keys/:id/events', ALL, ({ params }) => {
    const k = findKey(params.id);
    return db.key_events.filter((e) => e.subject_type === 'KEY' && e.subject_id === k.id).slice().reverse();
  });
  route('POST', '/api/wallets/:id/keys', ADMIN, ({ params, body }) => {
    const w = findWallet(params.id);
    const tagId = String(body.tag_id || '').trim();
    if (!tagId) throw httpError(400, 'tag_id required');
    const description = String(body.description || '').trim();
    if (!description) throw httpError(400, 'description required');
    let site_id = null, vehicle_id = null;
    if (body.site_id) { if (!db.sites.find((x) => x.id === Number(body.site_id))) throw httpError(400, 'site not found'); site_id = Number(body.site_id); }
    if (body.vehicle_id) { if (!db.vehicles.find((x) => x.id === Number(body.vehicle_id))) throw httpError(400, 'vehicle not found'); vehicle_id = Number(body.vehicle_id); }
    const k = {
      id: nextId('keys'), wallet_id: w.id, tag_id: tagId, description, site_id, vehicle_id,
      status: 'IN_WALLET', created_at: new Date().toISOString(), retired_at: null, disposition: null,
    };
    db.keys.push(k);
    logEvent('key.created', `KEY ${k.tag_id} REGISTERED IN WALLET ${w.tag_id}`, { key_id: k.id, wallet_id: w.id });
    flushNow();
    return { __status: 201, __body: publicKey(k) };
  });
  route('PATCH', '/api/keys/:id', ADMIN, ({ params, body }) => {
    const k = findKey(params.id);
    if ('description' in body) {
      const d = String(body.description || '').trim();
      if (!d) throw httpError(400, 'description required');
      k.description = d;
    }
    if ('site_id' in body) {
      if (body.site_id) { if (!db.sites.find((x) => x.id === Number(body.site_id))) throw httpError(400, 'site not found'); k.site_id = Number(body.site_id); }
      else k.site_id = null;
    }
    if ('vehicle_id' in body) {
      if (body.vehicle_id) { if (!db.vehicles.find((x) => x.id === Number(body.vehicle_id))) throw httpError(400, 'vehicle not found'); k.vehicle_id = Number(body.vehicle_id); }
      else k.vehicle_id = null;
    }
    flushNow();
    return publicKey(k);
  });

  /* ---- retiring a key: it must end RETURNED_TO_CLIENT or DISPOSED ---- */
  function disposalCertificatePdf(k, wallet, safe, user) {
    const site = k.site_id ? db.sites.find((s) => s.id === k.site_id) : null;
    const doc = new Doc({ footer: 'Echelon — certificate of destruction' });
    doc.para('Echelon', { size: 18, bold: true, gap: 0 });
    doc.rule(6);
    doc.para('Certificate of Destruction', { size: 15, bold: true, gap: 2 });
    doc.para(`Key ${k.tag_id}`, { size: 10, color: [0.35, 0.38, 0.42], gap: 6 });
    doc.pairs([
      ['Key tag', k.tag_id],
      ['Description', k.description],
      ['Site', site ? site.name : '—'],
      ['Wallet', wallet ? wallet.tag_id : '—'],
      ['Safe', safe ? safe.tag_id : '—'],
      ['Disposed by', user.display_name],
      ['Disposed at', new Date().toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })],
    ]);
    doc.heading('Confirmation', 12);
    doc.para('This certifies that the key described above has been securely destroyed and is no longer capable of use.', { size: 10 });
    return doc.toBuffer();
  }
  route('POST', '/api/keys/:id/retire', ADMIN, ({ params, body, user }) => {
    const k = findKey(params.id);
    if (k.status !== 'IN_WALLET') throw httpError(409, 'this key is already retired');
    const disposition = String(body.disposition || '');
    if (!['RETURNED_TO_CLIENT', 'DISPOSED'].includes(disposition)) throw httpError(400, 'disposition must be RETURNED_TO_CLIENT or DISPOSED');
    const notes = String(body.notes || '').slice(0, 2000);
    const now = new Date().toISOString();
    const wallet = db.key_wallets.find((w) => w.id === k.wallet_id);
    const safe = wallet ? db.safes.find((s) => s.id === wallet.safe_id) : null;
    let signed_by_name = null;

    if (disposition === 'RETURNED_TO_CLIENT') {
      signed_by_name = String(body.signed_by_name || '').trim().slice(0, 120);
      if (!signed_by_name) throw httpError(400, "the client's name is required");
      const sig = body.signature || {};
      if (sig.mimetype !== 'image/jpeg' || !sig.data) throw httpError(400, 'a signature is required');
      const jpeg = Buffer.from(String(sig.data).replace(/^data:[^,]*,/, ''), 'base64');
      if (jpeg.length > SIG_MAX || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw httpError(400, 'the signature image is not valid');
      fs.mkdirSync(dir(k.id), { recursive: true });
      fs.writeFileSync(path.join(dir(k.id), 'signature.jpg'), jpeg);
    }

    k.status = disposition; k.retired_at = now;
    const client = clientFor(k);
    const to = billTo(client);
    k.disposition = { type: disposition, at: now, by: user.display_name, notes, signed_by_name, client_id: client ? client.id : null, emailed_to: null, email_ok: null, email_error: null };
    keyEvent('KEY', k.id, disposition, user, notes, { client_id: client ? client.id : null });
    logEvent('key.retired', `KEY ${k.tag_id} ${disposition}`, { key_id: k.id });

    if (disposition === 'DISPOSED') {
      const pdf = disposalCertificatePdf(k, wallet, safe, user);
      fs.mkdirSync(dir(k.id), { recursive: true });
      fs.writeFileSync(path.join(dir(k.id), 'certificate.pdf'), pdf);
      if (!to) {
        k.disposition.email_ok = false;
        k.disposition.email_error = 'no client email on file — send this certificate manually';
      } else if (sendEmail) {
        Promise.resolve(sendEmail(to, `Certificate of Destruction — key ${k.tag_id}`,
          `<p>Hello,</p><p>Please find attached the Certificate of Destruction for key <strong>${k.tag_id}</strong> (${k.description}).</p><p>Kind regards,<br>Echelon</p>`,
          { attachments: [{ name: 'certificate.pdf', contentType: 'application/pdf', content: pdf }] }))
          .then((r) => { k.disposition.emailed_to = to; k.disposition.email_ok = Boolean(r && r.ok); k.disposition.email_error = r && !r.ok ? String(r.error || '').slice(0, 200) : null; flushNow(); })
          .catch((e) => { k.disposition.email_ok = false; k.disposition.email_error = e.message; flushNow(); });
      }
    }
    flushNow();
    return publicKey(k);
  });
  route('GET', '/api/keys/:id/certificate', ADMIN, ({ params }) => {
    const k = findKey(params.id);
    const file = path.join(dir(k.id), 'certificate.pdf');
    if (!fs.existsSync(file)) throw httpError(404, 'no certificate for this key');
    return { __body: fs.readFileSync(file), __headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="certificate-${k.tag_id}.pdf"`, 'cache-control': 'private, no-store' } };
  });
};
