/**
 * Staff numbers, ID photos, and the QR code on an ID card.
 *
 * STAFF NUMBERS. Anyone added without an employee number gets the next one
 * (prefix + number, e.g. ECH-0001 — set in Admin; it never reuses a number
 * already on file). Existing staff without one are only numbered when an
 * admin presses "number everyone without one" — nothing changes records
 * on its own.
 *
 * ID PHOTO. A head-and-shoulders photo on the staff record (JPEG/PNG),
 * shown on their profile, their ID card and the ID check page.
 *
 * ID CHECK. Each person's card carries a QR code holding a long random code
 * (personnel.verify_token) — not their staff number or id, so cards can't
 * be guessed or forged by counting. Scanning it opens /verify.html, which
 * anyone can view without logging in, showing only:
 *   name, photo, staff number, role, whether they are employed now,
 *   each SIA licence: type, verified on the SIA register (by an admin,
 *     with the date), valid or expired — not the licence number,
 *   DBS: verified (the date it was last checked) and its level — not the
 *     certificate number.
 * Nothing else about the person is ever on that page. Re-issuing a card
 * (lost or stolen) makes a new code, so the old card stops working.
 *
 * Registrar pattern — server.js passes in what this needs.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function registerStaffId({
  route, httpError, ADMIN, CONTROL, db, logEvent, UPLOADS_DIR, publicBaseUrl = '', isControlRole, flushNow = () => {},
}) {
  const dir = path.join(UPLOADS_DIR, 'staff-photos');
  const findP = (id) => { const p = db.personnel.find((x) => x.id === Number(id)); if (!p) throw httpError(404, 'personnel not found'); return p; };

  /* ---- numbers ---- */
  function numbering() {
    if (!Array.isArray(db.ui_settings)) db.ui_settings = [];
    let r = db.ui_settings.find((x) => x.key === 'staff_numbers');
    if (!r) { r = { key: 'staff_numbers', prefix: 'ECH-', next: 1, digits: 4 }; db.ui_settings.push(r); }
    return r;
  }
  function nextNumber() {
    const r = numbering();
    let n = Math.max(1, Number(r.next) || 1), num;
    do { num = `${r.prefix}${String(n).padStart(r.digits, '0')}`; n++; } while (db.personnel.some((p) => p.employee_no === num));
    r.next = n;
    return num;
  }
  /** Gives a new record the next number if it was created without one. */
  function assignNumber(p) { if (!p.employee_no) p.employee_no = nextNumber(); return p.employee_no; }
  route('GET', '/api/admin/staff-numbers', ADMIN, () => {
    const r = numbering();
    return { prefix: r.prefix, next: r.next, digits: r.digits, example: `${r.prefix}${String(r.next).padStart(r.digits, '0')}`, without_number: db.personnel.filter((p) => !p.employee_no).length };
  });
  route('PUT', '/api/admin/staff-numbers', ADMIN, ({ body }) => {
    const r = numbering();
    if ('prefix' in body) { const v = String(body.prefix ?? '').trim(); if (!/^[A-Za-z0-9/-]{0,10}$/.test(v)) throw httpError(400, 'prefix: letters, digits, - or / only'); r.prefix = v; }
    if ('next' in body) { const v = Number(body.next); if (!Number.isInteger(v) || v < 1) throw httpError(400, 'next number must be a whole number'); r.next = v; }
    if ('digits' in body) { const v = Number(body.digits); if (!Number.isInteger(v) || v < 1 || v > 8) throw httpError(400, 'digits must be 1–8'); r.digits = v; }
    flushNow();
    return { prefix: r.prefix, next: r.next, digits: r.digits, example: `${r.prefix}${String(r.next).padStart(r.digits, '0')}`, without_number: db.personnel.filter((p) => !p.employee_no).length };
  });
  route('POST', '/api/admin/staff-numbers/assign-missing', ADMIN, ({ user }) => {
    const done = db.personnel.filter((p) => !p.employee_no).sort((a, b) => a.id - b.id).map((p) => ({ id: p.id, name: p.name, employee_no: assignNumber(p) }));
    if (done.length) logEvent('personnel.numbered', `${done.length} STAFF NUMBER(S) ASSIGNED BY ${user.display_name}`, {});
    flushNow();
    return { assigned: done };
  });

  /* ---- ID photo ---- */
  const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const isPng = (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  route('POST', '/api/personnel/:id/photo', ADMIN, ({ params, body, user }) => {
    const p = findP(params.id);
    const bytes = Buffer.from(String((body && body.data) || '').replace(/^data:[^,]*,/, ''), 'base64');
    if (!bytes.length) throw httpError(400, 'choose a photo');
    if (bytes.length > 3e6) throw httpError(413, 'photo too large (3 MB at most)');
    const ext = isJpeg(bytes) ? 'jpg' : isPng(bytes) ? 'png' : null;
    if (!ext) throw httpError(400, 'the photo must be a JPEG or PNG');
    fs.mkdirSync(dir, { recursive: true });
    if (p.id_photo && p.id_photo.file) { try { fs.unlinkSync(path.join(dir, p.id_photo.file)); } catch {} }
    const file = `${p.id}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(dir, file), bytes);
    p.id_photo = { file, mimetype: ext === 'jpg' ? 'image/jpeg' : 'image/png', uploaded_at: new Date().toISOString(), uploaded_by: user.display_name };
    logEvent('personnel.photo', `ID PHOTO UPDATED FOR PERSONNEL #${p.id}`, { personnel_id: p.id });
    flushNow();
    return { ok: true, uploaded_at: p.id_photo.uploaded_at };
  });
  route('DELETE', '/api/personnel/:id/photo', ADMIN, ({ params }) => {
    const p = findP(params.id);
    if (p.id_photo && p.id_photo.file) { try { fs.unlinkSync(path.join(dir, p.id_photo.file)); } catch {} }
    p.id_photo = null; flushNow();
    return { ok: true };
  });
  const photoOut = (p) => {
    if (!p.id_photo || !p.id_photo.file) throw httpError(404, 'no photo');
    const f = path.join(dir, p.id_photo.file);
    if (!fs.existsSync(f)) throw httpError(404, 'photo missing');
    return { __body: fs.readFileSync(f), __headers: { 'content-type': p.id_photo.mimetype, 'cache-control': 'private, no-store' } };
  };
  // Control and admins, and the person themselves.
  route('GET', '/api/personnel/:id/photo', [], ({ params, user }) => {
    const p = findP(params.id);
    if (!isControlRole(user.role) && user.personnel_id !== p.id) throw httpError(403, 'not allowed');
    return photoOut(p);
  });

  /* ---- SIA licence verified on the register ---- */
  route('POST', '/api/personnel/:id/sia-licences/:lid/verify', ADMIN, ({ params, body, user }) => {
    const p = findP(params.id);
    if (!Array.isArray(p.sia_licences)) throw httpError(404, 'save the licences on the record first');
    const l = p.sia_licences.find((x) => x.id === Number(params.lid));
    if (!l) throw httpError(404, 'licence not found');
    if (body.verified === false) { l.verified_at = null; l.verified_by = null; }
    else { l.verified_at = new Date().toISOString(); l.verified_by = user.display_name; }
    logEvent('personnel.sia_verified', `SIA LICENCE ${body.verified === false ? 'VERIFICATION REMOVED' : 'VERIFIED ON THE REGISTER'} FOR PERSONNEL #${p.id} BY ${user.display_name}`, { personnel_id: p.id });
    flushNow();
    return l;
  });

  /* ---- the ID card's QR code ---- */
  const newToken = () => crypto.randomBytes(18).toString('base64url');
  const verifyUrl = (p) => `${publicBaseUrl}/verify.html#${p.verify_token}`;
  route('GET', '/api/personnel/:id/id-card', ADMIN, ({ params }) => {
    const p = findP(params.id);
    if (!p.verify_token) { p.verify_token = newToken(); p.id_card_issued_at = new Date().toISOString(); flushNow(); }
    return { verify_url: verifyUrl(p), issued_at: p.id_card_issued_at || null, has_photo: Boolean(p.id_photo), employee_no: p.employee_no, name: p.name, rank: p.rank || '' };
  });
  route('POST', '/api/personnel/:id/id-card/reissue', ADMIN, ({ params, user }) => {
    const p = findP(params.id);
    p.verify_token = newToken(); p.id_card_issued_at = new Date().toISOString();
    logEvent('personnel.id_card_reissued', `ID CARD RE-ISSUED FOR PERSONNEL #${p.id} BY ${user.display_name} — THE OLD CARD'S QR CODE NO LONGER WORKS`, { personnel_id: p.id });
    flushNow();
    return { verify_url: verifyUrl(p), issued_at: p.id_card_issued_at };
  });

  /* ---- public: what scanning the card shows ---- */
  const byToken = (token) => {
    const t = String(token || '');
    if (t.length < 20) return null;
    return db.personnel.find((p) => p.verify_token && p.verify_token.length === t.length && crypto.timingSafeEqual(Buffer.from(p.verify_token), Buffer.from(t))) || null;
  };
  const company = () => {
    const r = (db.ui_settings || []).find((x) => x.key === 'rental') || {};
    return { name: r.company_name || 'Echelon', phone: r.company_phone || '', email: r.company_email || '' };
  };
  route('GET', '/api/public/verify/:token', null, ({ params }) => {
    const p = byToken(params.token);
    if (!p) return { __status: 404, __body: { valid: false, error: 'This ID card is not recognised. It may have been cancelled or replaced.', company: company() } };
    const now = Date.now();
    const status = p.employment_status || 'ACTIVE';
    const licences = (Array.isArray(p.sia_licences) ? p.sia_licences : p.sia_licence_no ? [{ licence_type: 'Door Supervision', expiry: p.sia_licence_expiry || null }] : []).map((l) => ({
      type: l.licence_type, expiry: l.expiry || null, expired: Boolean(l.expiry && Date.parse(l.expiry) < now),
      verified: Boolean(l.verified_at), verified_at: l.verified_at || null,
    }));
    const dbsChecked = p.dbs_last_checked_at ? Date.parse(p.dbs_last_checked_at) : null;
    return {
      valid: true, checked_at: new Date().toISOString(), company: company(),
      name: p.name, employee_no: p.employee_no || null, role: p.rank || null,
      employed: status !== 'TERMINATED', employment_status: status,
      photo_url: p.id_photo ? `/api/public/verify/${encodeURIComponent(params.token)}/photo` : null,
      sia: licences,
      dbs: { verified: Boolean(dbsChecked), level: p.dbs_certificate_type || null, checked_at: p.dbs_last_checked_at || null, recheck_due: Boolean(dbsChecked && now - dbsChecked > 365 * 86400000) },
    };
  });
  route('GET', '/api/public/verify/:token/photo', null, ({ params }) => {
    const p = byToken(params.token);
    if (!p) throw httpError(404, 'not found');
    return photoOut(p);
  });

  return { assignNumber, nextNumber };
};
