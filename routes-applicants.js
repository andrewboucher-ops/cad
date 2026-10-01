/**
 * Applicant tracking — a recruitment pipeline for candidates before they
 * become a real personnel record. Genuinely separate from training
 * records: this is about people who aren't staff yet.
 *
 * Pure back-office HR data: unlike personnel/sites/vehicles, a FIELD_USER
 * or MDT_USER has no legitimate reason to see who's applying for a job, so
 * the whole surface is CONTROL-gated for reads, not ALL. Branch scoping
 * still applies the same way it does everywhere else (a SUPERVISOR sees
 * only their own branch's applicants) via the same visibleToUser() helper
 * server.js already uses for personnel/vehicles/sites/assets.
 *
 * Status is mostly free-form (PATCH accepts any of APPLICANT_STATUSES,
 * same looseness jobs/visits already allow), with one deliberate
 * exception: HIRED is never set by a plain PATCH. It only happens through
 * POST /api/applicants/:id/hire, which is the actual point of this
 * feature — it creates a real personnel record from the applicant's
 * details, so everything else in CCCS (compliance, training, branch, rota)
 * picks them up automatically from that moment on. That's an ADMIN action,
 * the same gate as POST /api/personnel itself.
 *
 * notes_log is an array on the applicant, not a separate top-level
 * collection like dial_log/training_records: nobody needs to query notes
 * across every applicant at once, so the extra collection would buy
 * nothing. It's still append-only — a note is never edited or removed,
 * only added, the same "the record of what happened doesn't get
 * rewritten" instinct as everywhere else in this codebase.
 *
 * THE PUBLIC APPLICATION ROUTES (/api/public/...) are the second and third
 * routes in the system that take no login (Twilio's webhook was the first).
 * Anyone on the internet can call them, so each is narrower than it looks:
 *   - the form is the one active APPLICATION form from routes-forms.js, its
 *     answers validated against that form's own fields (unknown keys
 *     refused, types checked), never a free-form payload;
 *   - a per-sender limit (5 an hour) and a daily cap bound what a script
 *     can do to the disk; a hidden honeypot field drops naive bots silently;
 *   - nothing personal goes into logEvent() — the event log reaches every
 *     connected officer's screen — or into a push payload;
 *   - the reply carries a reference only, never the data back.
 * ACKNOWLEDGEMENT EMAIL. An accepted application is acknowledged by email
 * with its reference. That is our mailbox writing to an address a stranger
 * typed in, so it is built to be useless for abuse: fixed text only (the
 * reference and the role picked from the form's own options — not the
 * name or anything else typed freely, which could carry spam), at most one
 * per address per day on top of the limits above, off with
 * APPLY_ACK_EMAIL=off, and inert until Graph mail is configured. Whether it
 * went is recorded on the applicant (acknowledgement) so a failure shows.
 *
 * The answers live on the applicant record, so they are read exactly like
 * every other applicant detail: control roles, branch-scoped.
 *
 * Registrar pattern, like routes-forms.js and routes-client.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APPLICANT_STATUSES = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN'];
const CV_MAX_BYTES = 8e6;
// Magic bytes, not the declared mimetype — same reasoning as routes-client.js
// and routes-forms.js: this file is served back to an admin's browser later.
const CV_SIGNATURES = {
  'application/pdf': (b) => b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46,
  'image/png': (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
};
const CV_EXT = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg' };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = function registerApplicantRoutes({
  route, httpError, CONTROL, ADMIN, db, nextId, logEvent, UPLOADS_DIR, MIME, visibleToUser, normalizedBranchId, publicPersonnel,
  forms, pushToRoles = () => {}, flushNow = () => {}, sendEmail = null, personnelFiles = null, publicBaseUrl = '',
}) {
  for (const t of ['applicants']) if (!Array.isArray(db[t])) db[t] = [];

  const cvDir = (applicantId) => path.join(UPLOADS_DIR, 'applicants', String(applicantId));
  const findApplicant = (id) => db.applicants.find((a) => a.id === Number(id)) || null;

  // The info-request token hash never leaves the server.
  const publicApplicant = (a) => ({ ...a, info_requests: (a.info_requests || []).map(({ token_hash, ...r }) => r) });

  route('GET', '/api/applicants', CONTROL, ({ query, user }) => {
    let rows = db.applicants.filter((a) => visibleToUser(a, user));
    if (query.get('status')) rows = rows.filter((a) => a.status === query.get('status').toUpperCase());
    return rows.sort((a, b) => (a.applied_at < b.applied_at ? 1 : -1)).map(publicApplicant);
  });

  /** One applicant shape for both ways in: added by control, or applied
   * through the website. */
  function createApplicant(body, createdBy) {
    const name = String(body.name || '').trim().slice(0, 200);
    if (!name) throw httpError(400, 'name required');
    if (body.email && !EMAIL_RE.test(String(body.email).trim())) throw httpError(400, 'invalid email');
    const a = {
      id: nextId('applicants'), name, email: body.email ? String(body.email).trim().toLowerCase().slice(0, 200) : '',
      phone: String(body.phone || '').trim().slice(0, 50), role_applied_for: String(body.role_applied_for || '').trim().slice(0, 120),
      source: String(body.source || '').trim().slice(0, 120), status: 'APPLIED',
      branch_id: normalizedBranchId(body.branch_id), interview_at: null,
      rejected_reason: null, hired_personnel_id: null, cv: null, notes_log: [], application: null,
      applied_at: new Date().toISOString(), updated_at: new Date().toISOString(), created_by: createdBy,
    };
    db.applicants.push(a);
    return a;
  }

  route('POST', '/api/applicants', CONTROL, ({ body, user }) => {
    const a = createApplicant(body, user.id);
    logEvent('applicant.created', `APPLICANT ${a.name} ADDED${a.role_applied_for ? ` (${a.role_applied_for})` : ''}`, { applicant_id: a.id });
    return { __status: 201, __body: publicApplicant(a) };
  });

  route('GET', '/api/applicants/:id', CONTROL, ({ params, user }) => {
    const a = findApplicant(params.id);
    if (!a || !visibleToUser(a, user)) throw httpError(404, 'applicant not found');
    return publicApplicant(a);
  });

  route('PATCH', '/api/applicants/:id', CONTROL, ({ params, body }) => {
    const a = findApplicant(params.id);
    if (!a) throw httpError(404, 'applicant not found');
    const before = { status: a.status, interview_at: a.interview_at };
    if ('name' in body) { const name = String(body.name || '').trim(); if (!name) throw httpError(400, 'name required'); a.name = name; }
    if ('email' in body) {
      const email = String(body.email || '').trim();
      if (email && !EMAIL_RE.test(email)) throw httpError(400, 'invalid email');
      a.email = email.toLowerCase();
    }
    if ('phone' in body) a.phone = String(body.phone || '').trim();
    if ('role_applied_for' in body) a.role_applied_for = String(body.role_applied_for || '').trim();
    if ('source' in body) a.source = String(body.source || '').trim();
    if ('branch_id' in body) a.branch_id = normalizedBranchId(body.branch_id);
    if ('interview_at' in body) {
      if (body.interview_at && isNaN(Date.parse(body.interview_at))) throw httpError(400, 'invalid interview_at');
      a.interview_at = body.interview_at ? new Date(body.interview_at).toISOString() : null;
    }
    if ('status' in body) {
      const status = String(body.status || '').toUpperCase();
      if (!APPLICANT_STATUSES.includes(status)) throw httpError(400, 'invalid status');
      if (status === 'HIRED') throw httpError(400, 'use POST /api/applicants/:id/hire to hire an applicant');
      if (status === 'REJECTED' && !body.rejected_reason && !a.rejected_reason) throw httpError(400, 'rejected_reason required when rejecting');
      if (status === 'REJECTED' && body.rejected_reason) a.rejected_reason = String(body.rejected_reason).trim();
      a.status = status;
    }
    // The applicant is told when their status changes (or their interview
    // is moved), unless whoever made the change chose not to.
    if (body.notify !== false) {
      if (a.status !== before.status) emailApplicant(a, a.status);
      else if (a.status === 'INTERVIEW' && a.interview_at && a.interview_at !== before.interview_at) emailApplicant(a, 'INTERVIEW_MOVED');
    }
    a.updated_at = new Date().toISOString();
    logEvent('applicant.updated', `APPLICANT ${a.name} UPDATED`, { applicant_id: a.id });
    return publicApplicant(a);
  });

  route('DELETE', '/api/applicants/:id', ADMIN, ({ params }) => {
    const a = findApplicant(params.id);
    if (!a) throw httpError(404, 'applicant not found');
    if (a.status === 'HIRED') throw httpError(409, 'cannot delete a hired applicant — the personnel record it became still references this history');
    db.applicants = db.applicants.filter((x) => x.id !== a.id);
    logEvent('applicant.deleted', `APPLICANT ${a.name} DELETED`);
    return { ok: true };
  });

  /** The point of the whole feature: an applicant becomes a real personnel
   * record. Only from a still-active stage — a rejected or withdrawn
   * candidate must be reopened deliberately (PATCH status back to an
   * earlier stage) before they can be hired, not hired past a decision
   * that was already made about them. */
  route('POST', '/api/applicants/:id/hire', ADMIN, ({ params, body }) => {
    const a = findApplicant(params.id);
    if (!a) throw httpError(404, 'applicant not found');
    if (a.status === 'HIRED') throw httpError(409, 'already hired');
    if (['REJECTED', 'WITHDRAWN'].includes(a.status)) throw httpError(409, `cannot hire a candidate marked ${a.status.toLowerCase()} — move them back to an earlier stage first`);
    const name = String(body.name || a.name).trim();
    if (!name) throw httpError(400, 'name required');
    const employeeNo = body.employee_no ? String(body.employee_no).trim() : null;
    if (employeeNo && db.personnel.some((p) => p.employee_no === employeeNo)) throw httpError(409, 'employee number already in use');
    const p = {
      id: nextId('personnel'), employee_no: employeeNo, name, rank: String(body.rank || a.role_applied_for || '').trim(),
      contact_phone: String(body.contact_phone || a.phone || '').trim(), contact_email: String(body.contact_email || a.email || '').trim(),
      employment_status: 'ACTIVE', callsign_id: null, user_id: null, vehicle_id: null,
      welfare_interval_s: null, welfare_due_at: null, welfare_warned: false, welfare_note: null,
      notes: `Hired via applicant tracking — applicant #${a.id}.`, branch_id: a.branch_id || null,
      lat: null, lon: null, location_at: null,
    };
    // Everything from the application goes onto their personnel file.
    const values = (a.application && a.application.values) || {};
    if (values.sia_licence && !p.sia_licence_no) p.sia_licence_no = String(values.sia_licence).trim().slice(0, 40);
    p.application = {
      applicant_id: a.id, reference: a.reference || null, applied_at: a.applied_at, role_applied_for: a.role_applied_for, source: a.source,
      email: a.email, phone: a.phone, form: a.application ? { definition_name: a.application.definition_name, definition_version: a.application.definition_version, fields: a.application.fields, values: a.application.values, submitted_at: a.application.submitted_at } : null,
      sia_none: Boolean(a.sia && a.sia.none),
      info_requests: (a.info_requests || []).filter((r) => r.status === 'COMPLETED').map((r) => ({ message: r.message, sent_at: r.created_at, answered_at: r.submitted_at, answers: r.answers.map((x) => ({ label: x.label, type: x.type, text: x.text || null })) })),
      notes: a.notes_log.map((n) => ({ ...n })), interview_at: a.interview_at, hired_at: new Date().toISOString(),
    };
    if (personnelFiles) {
      const copy = (from, meta) => { if (fs.existsSync(from)) personnelFiles.addFile(p, { ...meta, from, source: `Application ${a.reference || '#' + a.id}` }); };
      if (a.sia && a.sia.front) copy(path.join(cvDir(a.id), 'sia', a.sia.front.stored_name), { kind: 'SIA_FRONT', mimetype: a.sia.front.mimetype, filename: a.sia.front.filename });
      if (a.sia && a.sia.back) copy(path.join(cvDir(a.id), 'sia', a.sia.back.stored_name), { kind: 'SIA_BACK', mimetype: a.sia.back.mimetype, filename: a.sia.back.filename });
      if (a.cv) copy(path.join(cvDir(a.id), a.cv.stored_name), { kind: 'CV', mimetype: a.cv.mimetype, filename: a.cv.filename });
      for (const f of (a.application && a.application.files) || []) {
        const field = a.application.fields.find((x) => x.id === f.field_id);
        copy(path.join(answersDir(a.id), f.filename), { kind: 'APPLICATION', label: field ? field.label : 'Application file', mimetype: f.mimetype, filename: f.filename });
      }
      for (const r of a.info_requests || []) for (const x of r.answers || []) {
        if (x.file) copy(path.join(infoDir(a.id, r.id), x.file.stored_name), { kind: 'INFO', label: x.label, mimetype: x.file.mimetype, filename: x.file.filename });
      }
    }
    db.personnel.push(p);
    a.status = 'HIRED'; a.hired_personnel_id = p.id; a.updated_at = new Date().toISOString();
    if (body.notify !== false) emailApplicant(a, 'HIRED');
    flushNow();
    logEvent('applicant.hired', `${a.name} HIRED AS ${p.name} (personnel #${p.id})`, { applicant_id: a.id, personnel_id: p.id });
    return { __status: 201, __body: { applicant: publicApplicant(a), personnel: publicPersonnel(p) } };
  });

  route('POST', '/api/applicants/:id/notes', CONTROL, ({ params, body, user }) => {
    const a = findApplicant(params.id);
    if (!a) throw httpError(404, 'applicant not found');
    const text = String(body.body || '').trim();
    if (!text) throw httpError(400, 'body required');
    a.notes_log.push({ id: crypto.randomUUID(), body: text.slice(0, 2000), author: user.display_name, at: new Date().toISOString() });
    a.updated_at = new Date().toISOString();
    logEvent('applicant.note_added', `NOTE ADDED FOR ${a.name}`, { applicant_id: a.id });
    return publicApplicant(a);
  });

  route('POST', '/api/applicants/:id/cv', CONTROL, ({ params, body }) => {
    const a = findApplicant(params.id);
    if (!a) throw httpError(404, 'applicant not found');
    const ext = CV_EXT[body.mimetype];
    if (!ext) throw httpError(400, 'mimetype must be application/pdf, image/png or image/jpeg');
    if (!body.data) throw httpError(400, 'data (base64) required');
    const bytes = Buffer.from(body.data, 'base64');
    if (bytes.length > CV_MAX_BYTES) throw httpError(413, 'file too large');
    if (!CV_SIGNATURES[body.mimetype](bytes)) throw httpError(400, 'file content does not match the declared mimetype');
    const dir = cvDir(a.id);
    fs.mkdirSync(dir, { recursive: true });
    const storedName = `${crypto.randomUUID()}${ext}`;
    fs.writeFileSync(path.join(dir, storedName), bytes);
    a.cv = { id: crypto.randomUUID(), filename: String(body.filename || 'cv').trim().slice(0, 200) || 'cv', stored_name: storedName, mimetype: body.mimetype, uploaded_at: new Date().toISOString() };
    logEvent('applicant.cv_uploaded', `CV UPLOADED FOR ${a.name}`, { applicant_id: a.id });
    return publicApplicant(a);
  });
  route('GET', '/api/applicants/:id/cv', CONTROL, ({ params }) => {
    const a = findApplicant(params.id);
    if (!a || !a.cv) throw httpError(404, 'no CV on file');
    const file = path.join(cvDir(a.id), a.cv.stored_name);
    if (!fs.existsSync(file)) throw httpError(404, 'CV file missing');
    return { __body: fs.readFileSync(file), __headers: { 'content-type': a.cv.mimetype, 'content-disposition': `attachment; filename="${a.cv.filename.replace(/"/g, '')}"` } };
  });

  /* ---------------------------------------------------------------- *
   * Public application — see the header for what keeps these safe
   * ---------------------------------------------------------------- */

  const PER_SENDER_PER_HOUR = Number(process.env.APPLY_PER_IP_PER_HOUR || 5);
  const MAX_PER_DAY = Number(process.env.APPLY_MAX_PER_DAY || 200);
  const recent = new Map(); // sender -> [timestamps]
  let dayStart = Date.now(), dayCount = 0;

  /** Behind Caddy every request arrives from 127.0.0.1, so a per-IP limit on
   * the socket address would be ONE shared limit for every applicant. The
   * forwarded address is trusted only when the request came from the local
   * proxy — from anywhere else it is just a header the sender wrote. */
  function senderOf(req) {
    const remote = String(req.socket.remoteAddress || '');
    const viaLocalProxy = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    const fwd = viaLocalProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
    return fwd || remote || 'unknown';
  }
  /** Only ACCEPTED applications count: a real applicant who mistypes their
   * email five times must not be locked out for an hour. A refused attempt
   * stores nothing, so there is nothing for the limit to protect there. */
  function canApply(req) {
    const now = Date.now();
    if (now - dayStart > 86400000) { dayStart = now; dayCount = 0; }
    if (dayCount >= MAX_PER_DAY) return false;
    const times = (recent.get(senderOf(req)) || []).filter((t) => now - t < 3600000);
    return times.length < PER_SENDER_PER_HOUR;
  }
  function recordApplication(req) {
    const now = Date.now(), who = senderOf(req);
    const times = (recent.get(who) || []).filter((t) => now - t < 3600000);
    times.push(now); recent.set(who, times); dayCount++;
    if (recent.size > 5000) recent.delete(recent.keys().next().value);
  }

  const answersDir = (applicantId) => path.join(cvDir(applicantId), 'application');
  const infoDir = (applicantId, reqId) => path.join(cvDir(applicantId), 'info', String(reqId));

  const ACK_ENABLED = process.env.APPLY_ACK_EMAIL !== 'off';
  const ackedAt = new Map(); // email -> last acknowledgement time
  const escHtml = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Fire-and-forget: the application is already stored, and an email that
   * can't be delivered must never turn that into an error for the applicant. */
  function acknowledge(a, d, reference) {
    if (!ACK_ENABLED || !sendEmail || !a.email) { a.acknowledgement = { sent: false, reason: !ACK_ENABLED ? 'disabled' : !sendEmail ? 'email not configured' : 'no email' }; return; }
    const last = ackedAt.get(a.email);
    if (last && Date.now() - last < 86400000) { a.acknowledgement = { sent: false, reason: 'already acknowledged this address today' }; return; }
    ackedAt.set(a.email, Date.now());
    if (ackedAt.size > 10000) ackedAt.delete(ackedAt.keys().next().value);
    // The role is only included when it is one of the form's own options, so
    // nothing free-typed ever reaches the email.
    const roleField = d.fields.find((f) => f.id === 'role_applied_for');
    const role = roleField && roleField.options && roleField.options.includes(a.role_applied_for) ? a.role_applied_for : null;
    const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#111827;max-width:560px;margin:0 auto;padding:20px">
      <p>Hello,</p>
      <p>Thank you for applying to work with Echelon${role ? ` as a <strong>${escHtml(role)}</strong>` : ''}. We have received your application.</p>
      <p>Your reference is <strong style="font-family:monospace">${escHtml(reference)}</strong> — please quote it if you contact us.</p>
      <p>We review every application and will be in touch about the next steps.</p>
      <p style="color:#6b7280;font-size:12px;margin-top:28px">If you did not apply, you can ignore this email; nothing else will be sent to you.</p>
    </body></html>`;
    a.acknowledgement = { sent: false, pending: true };
    Promise.resolve(sendEmail(a.email, `Application received — ${reference}`, html)).then((r) => {
      a.acknowledgement = r && r.ok ? { sent: true, at: new Date().toISOString() } : { sent: false, reason: (r && r.error) || 'send failed', at: new Date().toISOString() };
      if (!(r && r.ok)) console.warn(`[apply] acknowledgement for applicant #${a.id} not sent:`, a.acknowledgement.reason);
      flushNow();
    }).catch((e) => { a.acknowledgement = { sent: false, reason: e.message }; });
  }

  route('GET', '/api/public/application-form', null, () => {
    const d = forms.activeApplicationForm();
    if (!d) throw httpError(404, 'applications are currently closed');
    return { id: d.id, version: d.version, name: d.name, description: d.description, fields: d.fields };
  });

  route('POST', '/api/public/applications', null, ({ body, req }) => {
    // Honeypot: a field real visitors never see. A bot that fills every
    // input gets the same reply as a person, and nothing is stored.
    if (body.website) return { __status: 201, __body: { ok: true, reference: 'APP-RECEIVED' } };
    const d = forms.activeApplicationForm();
    if (!d) throw httpError(404, 'applications are currently closed');
    if (Number(body.definition_id) !== d.id) throw httpError(409, 'the application form has changed — please reload the page');
    if (!canApply(req)) throw httpError(429, 'too many applications from here — please try again later');

    const { values, files } = forms.validateValues(d.fields, body.values);
    const email = String(values.email || '').trim();
    if (!EMAIL_RE.test(email)) throw httpError(400, 'please enter a valid email address');

    // SIA licence, front and back — or a tick to say they don't hold one yet.
    const noSia = body.no_sia === true;
    const siaFile = (raw, side) => {
      if (!raw || !raw.data) return null;
      const ext = CV_EXT[raw.mimetype];
      if (!ext) throw httpError(400, `the ${side} of your SIA licence must be a photo (JPEG or PNG) or a PDF`);
      const bytes = Buffer.from(String(raw.data), 'base64');
      if (bytes.length > CV_MAX_BYTES) throw httpError(413, `the ${side} of your SIA licence is too large (8MB maximum)`);
      if (!CV_SIGNATURES[raw.mimetype](bytes)) throw httpError(400, `the ${side} of your SIA licence does not look like a JPEG, PNG or PDF`);
      return { bytes, ext, mimetype: raw.mimetype, filename: String(raw.filename || `sia-${side}`).slice(0, 200) };
    };
    const siaFront = noSia ? null : siaFile(body.sia_front, 'front'), siaBack = noSia ? null : siaFile(body.sia_back, 'back');
    if (!noSia && (!siaFront || !siaBack)) throw httpError(400, 'please add photos of the front and back of your SIA licence — or tick that you don\'t hold one yet');

    let cv = null;
    if (body.cv && body.cv.data) {
      const ext = CV_EXT[body.cv.mimetype];
      if (!ext) throw httpError(400, 'your CV must be a PDF, PNG or JPEG');
      const bytes = Buffer.from(String(body.cv.data), 'base64');
      if (bytes.length > CV_MAX_BYTES) throw httpError(413, 'your CV is too large (8MB maximum)');
      if (!CV_SIGNATURES[body.cv.mimetype](bytes)) throw httpError(400, 'that file does not look like a PDF, PNG or JPEG');
      cv = { bytes, ext, mimetype: body.cv.mimetype, filename: String(body.cv.filename || 'cv').slice(0, 200) };
    }

    const a = createApplicant({ name: values.full_name, email, phone: values.phone, role_applied_for: values.role_applied_for, source: 'Website' }, null);
    recordApplication(req);
    if (files.length) {
      fs.mkdirSync(answersDir(a.id), { recursive: true });
      for (const f of files) fs.writeFileSync(path.join(answersDir(a.id), `${f.file_id}${forms.IMAGE_EXT[f.mimetype]}`), f.bytes);
    }
    a.application = {
      definition_id: d.id, definition_name: d.name, definition_version: d.version, fields: d.fields, values,
      files: files.map((f) => ({ file_id: f.file_id, field_id: f.field_id, mimetype: f.mimetype, filename: `${f.file_id}${forms.IMAGE_EXT[f.mimetype]}` })),
      submitted_at: new Date().toISOString(),
    };
    if (cv) {
      fs.mkdirSync(cvDir(a.id), { recursive: true });
      const storedName = `${crypto.randomUUID()}${cv.ext}`;
      fs.writeFileSync(path.join(cvDir(a.id), storedName), cv.bytes);
      a.cv = { id: crypto.randomUUID(), filename: cv.filename, stored_name: storedName, mimetype: cv.mimetype, uploaded_at: new Date().toISOString() };
    }
    a.sia = { none: noSia, front: null, back: null };
    for (const [side, f] of [['front', siaFront], ['back', siaBack]]) {
      if (!f) continue;
      fs.mkdirSync(path.join(cvDir(a.id), 'sia'), { recursive: true });
      const stored = `${side}-${crypto.randomUUID()}${f.ext}`;
      fs.writeFileSync(path.join(cvDir(a.id), 'sia', stored), f.bytes);
      a.sia[side] = { stored_name: stored, mimetype: f.mimetype, filename: f.filename, uploaded_at: new Date().toISOString() };
    }
    const reference = `APP-${String(a.id).padStart(5, '0')}`;
    a.reference = reference;
    logEvent('applicant.applied_online', `NEW WEBSITE APPLICATION — APPLICANT #${a.id}`, { applicant_id: a.id });
    pushToRoles(['SYSTEM_ADMIN'], { title: 'New job application', body: 'A new application arrived from the website', url: '/admin.html', tag: 'cccs-application' });
    acknowledge(a, d, reference);
    // Staff alert, to the addresses set on the form in Admin → Forms. Our own
    // people, so it can say which role — but still no name or contact
    // details in an email body; they are one click away in admin.
    if (sendEmail && Array.isArray(d.notify_emails) && d.notify_emails.length) {
      const roleField = d.fields.find((f) => f.id === 'role_applied_for');
      const role = roleField && roleField.options && roleField.options.includes(a.role_applied_for) ? a.role_applied_for : 'a role';
      const html = `<p>A new job application, <strong>${escHtml(reference)}</strong>, was made on the website for <strong>${escHtml(role)}</strong>.</p><p>Open Admin → Applicants in CCCS to review it.</p>`;
      for (const to of d.notify_emails) Promise.resolve(sendEmail(to, `New job application ${reference}`, html)).catch(() => {});
    }
    flushNow();
    return { __status: 201, __body: { ok: true, reference } };
  });

  // A signature (or other image) given on the website application.
  route('GET', '/api/applicants/:id/application-files/:fileId', CONTROL, ({ params, user }) => {
    const a = findApplicant(params.id);
    if (!a || !visibleToUser(a, user) || !a.application) throw httpError(404, 'not found');
    const f = a.application.files.find((x) => x.file_id === params.fileId);
    if (!f) throw httpError(404, 'not found');
    const file = path.join(answersDir(a.id), f.filename);
    if (!fs.existsSync(file)) throw httpError(404, 'file missing');
    return { __body: fs.readFileSync(file), __headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'private, max-age=3600' } };
  });

  route('GET', '/api/applicants/:id/sia/:side', CONTROL, ({ params, user }) => {
    const a = findApplicant(params.id);
    if (!a || !visibleToUser(a, user) || !a.sia || !['front', 'back'].includes(params.side) || !a.sia[params.side]) throw httpError(404, 'not found');
    const f = a.sia[params.side], file = path.join(cvDir(a.id), 'sia', f.stored_name);
    if (!fs.existsSync(file)) throw httpError(404, 'file missing');
    return { __body: fs.readFileSync(file), __headers: { 'content-type': f.mimetype, 'cache-control': 'private, no-store' } };
  });

  /* ---------------------------------------------------------------- *
   * Emails to the applicant
   *
   * Fixed wording per event — nothing typed by the applicant goes into
   * them (only the reference and, where it is one of the form's own
   * options, the role). What staff type (a further-information request)
   * does, because that is our own text. Each send is recorded on the
   * applicant, so a failed one shows in Admin.
   * ---------------------------------------------------------------- */
  const company = () => ((db.ui_settings || []).find((r) => r.key === 'rental') || {}).company_name || 'Echelon';
  function emailApplicant(a, kind, extra = {}) {
    if (!Array.isArray(a.emails)) a.emails = [];
    const log = { kind, to: a.email || null, at: new Date().toISOString(), ok: null };
    a.emails.push(log);
    if (!a.email) { Object.assign(log, { ok: false, error: 'no email address' }); return; }
    if (!sendEmail) { Object.assign(log, { ok: false, error: 'email is not configured' }); return; }
    const c = escHtml(company()), ref = a.reference ? ` (reference <strong style="font-family:monospace">${escHtml(a.reference)}</strong>)` : '';
    const when = a.interview_at ? escHtml(new Date(a.interview_at).toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })) : null;
    const T = {
      SCREENING: ['Your application is being reviewed', `<p>Your application to ${c}${ref} is now being reviewed. We will be in touch about the next step.</p>`],
      INTERVIEW: ['Interview', `<p>We would like to invite you to an interview for your application to ${c}${ref}.</p>${when ? `<p><strong>${when}</strong></p>` : '<p>We will contact you shortly to arrange a time.</p>'}<p>Please reply to this email if you need to rearrange.</p>`],
      INTERVIEW_MOVED: ['Interview time', `<p>Your interview with ${c}${ref} is now on <strong>${when}</strong>.</p><p>Please reply to this email if you can't make it.</p>`],
      OFFER: ['Good news about your application', `<p>We are pleased to let you know that ${c} would like to offer you a position${ref}. We will be in touch shortly with the details.</p>`],
      REJECTED: ['Your application', `<p>Thank you for your interest in working with ${c}${ref}. After careful consideration we will not be taking your application further on this occasion.</p><p>We wish you every success.</p>`],
      WITHDRAWN: ['Your application has been withdrawn', `<p>Your application to ${c}${ref} has been withdrawn. If this is a mistake, please reply to this email.</p>`],
      APPLIED: ['Your application', `<p>Your application to ${c}${ref} is back with our recruitment team.</p>`],
      HIRED: ['Welcome to the team', `<p>Congratulations — you have been taken on by ${c}, and your details have been added to our system.</p><p>We will be in touch about your start date, your login for our staff app and anything else you need before your first shift.</p>`],
      INFO_REQUEST: ['We need a little more information', `<p>Thank you for applying to ${c}${ref}. To carry on with your application we need some more information from you:</p>
        <ul>${(extra.items || []).map((i) => `<li>${escHtml(i.label)}${i.type === 'FILE' ? ' <em>(upload)</em>' : ''}</li>`).join('')}</ul>${extra.message ? `<p>${escHtml(extra.message).replace(/\n/g, '<br>')}</p>` : ''}
        <p><a href="${escHtml(extra.link)}" style="display:inline-block;background:#0f766e;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Send the information</a></p>
        <p style="color:#6b7280;font-size:12px">This link is just for you and works until ${escHtml(new Date(extra.expires_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }))}.</p>`],
    }[kind];
    if (!T) { Object.assign(log, { ok: false, error: 'no template' }); return; }
    const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#111827;max-width:560px;margin:0 auto;padding:20px"><p>Hello,</p>${T[1]}<p>Kind regards,<br>${c}</p></body></html>`;
    Promise.resolve(sendEmail(a.email, `${T[0]}${a.reference ? ` — ${a.reference}` : ''}`, html)).then((r) => {
      Object.assign(log, r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || 'send failed' });
      flushNow();
    }).catch((e) => Object.assign(log, { ok: false, error: e.message }));
  }

  /* ---------------------------------------------------------------- *
   * Further information requests
   *
   * Staff list what they need (uploads and/or written answers); the
   * applicant is emailed a private link to a page with no login. The link
   * carries a random token; only its hash is stored. It works until it
   * expires or is answered once — after that it shows "already sent".
   * Uploads are checked by content (PDF/JPEG/PNG) like the CV.
   * ---------------------------------------------------------------- */
  const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
  const findByToken = (token) => {
    const h = hashToken(token);
    for (const a of db.applicants) for (const r of a.info_requests || []) if (r.token_hash === h) return { a, r };
    return null;
  };
  route('POST', '/api/applicants/:id/info-requests', CONTROL, ({ params, body, user }) => {
    const a = findApplicant(params.id);
    if (!a || !visibleToUser(a, user)) throw httpError(404, 'applicant not found');
    if (!a.email) throw httpError(400, 'this applicant has no email address to send the request to');
    if (['HIRED', 'REJECTED', 'WITHDRAWN'].includes(a.status)) throw httpError(409, `the application is ${a.status.toLowerCase()}`);
    const items = (Array.isArray(body.items) ? body.items : []).map((i, n) => ({
      id: `q${n + 1}`, label: String(i.label || '').trim().slice(0, 200), type: i.type === 'TEXT' ? 'TEXT' : 'FILE', required: i.required !== false,
    })).filter((i) => i.label);
    if (!items.length) throw httpError(400, 'say what information you need');
    if (items.length > 15) throw httpError(400, 'at most 15 items in one request');
    const days = Math.min(Math.max(Number(body.expires_in_days) || 14, 1), 60);
    const token = crypto.randomBytes(24).toString('hex');
    if (!Array.isArray(a.info_requests)) a.info_requests = [];
    const r = {
      id: (a.info_requests.reduce((n, x) => Math.max(n, x.id), 0) || 0) + 1, token_hash: hashToken(token), items,
      message: String(body.message || '').trim().slice(0, 2000), status: 'OPEN', created_at: new Date().toISOString(), created_by: user.display_name,
      expires_at: new Date(Date.now() + days * 86400000).toISOString(), submitted_at: null, answers: [],
    };
    a.info_requests.push(r);
    const link = `${publicBaseUrl}/apply-info.html?t=${token}`;
    emailApplicant(a, 'INFO_REQUEST', { items, message: r.message, link, expires_at: r.expires_at });
    a.notes_log.push({ id: crypto.randomUUID(), body: `Asked for more information: ${items.map((i) => i.label).join('; ')}`, author: user.display_name, at: r.created_at });
    a.updated_at = r.created_at;
    logEvent('applicant.info_requested', `FURTHER INFORMATION REQUESTED FROM APPLICANT #${a.id}`, { applicant_id: a.id });
    flushNow();
    return { __status: 201, __body: { ...publicApplicant(a), link } };
  });
  route('DELETE', '/api/applicants/:id/info-requests/:rid', CONTROL, ({ params, user }) => {
    const a = findApplicant(params.id);
    const r = a && (a.info_requests || []).find((x) => x.id === Number(params.rid));
    if (!r) throw httpError(404, 'request not found');
    if (r.status !== 'OPEN') throw httpError(409, 'it has already been answered');
    r.status = 'CANCELLED'; r.cancelled_by = user.display_name;
    return publicApplicant(a);
  });
  route('GET', '/api/applicants/:id/info-files/:rid/:qid', CONTROL, ({ params, user }) => {
    const a = findApplicant(params.id);
    if (!a || !visibleToUser(a, user)) throw httpError(404, 'not found');
    const r = (a.info_requests || []).find((x) => x.id === Number(params.rid));
    const ans = r && r.answers.find((x) => x.item_id === params.qid && x.file);
    if (!ans) throw httpError(404, 'not found');
    const file = path.join(infoDir(a.id, r.id), ans.file.stored_name);
    if (!fs.existsSync(file)) throw httpError(404, 'file missing');
    return { __body: fs.readFileSync(file), __headers: { 'content-type': ans.file.mimetype, 'content-disposition': `inline; filename="${ans.file.filename.replace(/"/g, '')}"`, 'cache-control': 'private, no-store' } };
  });

  // Public: the page behind the emailed link.
  const tries = new Map();
  const tooMany = (req) => {
    const who = senderOf(req), now = Date.now();
    const t = (tries.get(who) || []).filter((x) => now - x < 3600000); t.push(now); tries.set(who, t);
    if (tries.size > 5000) tries.delete(tries.keys().next().value);
    return t.length > 30;
  };
  route('GET', '/api/public/info-request/:token', null, ({ params, req }) => {
    if (tooMany(req)) throw httpError(429, 'too many attempts — try again later');
    const hit = findByToken(params.token);
    if (!hit || hit.r.status === 'CANCELLED') throw httpError(404, 'this link is not valid — please contact us');
    const { a, r } = hit;
    const expired = Date.parse(r.expires_at) < Date.now();
    return { company: company(), reference: a.reference || null, message: r.message, items: r.items, status: expired && r.status === 'OPEN' ? 'EXPIRED' : r.status, expires_at: r.expires_at };
  });
  route('POST', '/api/public/info-request/:token', null, ({ params, body, req }) => {
    if (tooMany(req)) throw httpError(429, 'too many attempts — try again later');
    const hit = findByToken(params.token);
    if (!hit || hit.r.status === 'CANCELLED') throw httpError(404, 'this link is not valid — please contact us');
    const { a, r } = hit;
    if (r.status === 'COMPLETED') throw httpError(409, 'this information has already been sent — thank you');
    if (Date.parse(r.expires_at) < Date.now()) throw httpError(410, 'this link has expired — please contact us for a new one');
    const answers = body && typeof body.answers === 'object' && body.answers ? body.answers : {};
    const out = r.items.map((i) => {
      const v = answers[i.id];
      if (i.type === 'TEXT') {
        const text = String(v || '').trim().slice(0, 5000);
        if (!text && i.required) throw httpError(400, `please answer: ${i.label}`);
        return { item_id: i.id, label: i.label, type: i.type, text: text || null };
      }
      if (!v || !v.data) { if (i.required) throw httpError(400, `please upload: ${i.label}`); return { item_id: i.id, label: i.label, type: i.type, file: null }; }
      const ext = CV_EXT[v.mimetype];
      if (!ext) throw httpError(400, `${i.label}: must be a photo (JPEG or PNG) or a PDF`);
      const bytes = Buffer.from(String(v.data), 'base64');
      if (bytes.length > CV_MAX_BYTES) throw httpError(413, `${i.label}: file too large (8MB maximum)`);
      if (!CV_SIGNATURES[v.mimetype](bytes)) throw httpError(400, `${i.label}: that file does not look like a JPEG, PNG or PDF`);
      return { item_id: i.id, label: i.label, type: i.type, bytes, file: { stored_name: `${i.id}-${crypto.randomUUID()}${ext}`, mimetype: v.mimetype, filename: String(v.filename || i.label).slice(0, 200) } };
    });
    fs.mkdirSync(infoDir(a.id, r.id), { recursive: true });
    for (const x of out) if (x.bytes) { fs.writeFileSync(path.join(infoDir(a.id, r.id), x.file.stored_name), x.bytes); delete x.bytes; }
    r.answers = out; r.status = 'COMPLETED'; r.submitted_at = new Date().toISOString();
    a.notes_log.push({ id: crypto.randomUUID(), body: 'Further information received from the applicant.', author: 'Applicant', at: r.submitted_at });
    a.updated_at = r.submitted_at;
    logEvent('applicant.info_received', `FURTHER INFORMATION RECEIVED FROM APPLICANT #${a.id}`, { applicant_id: a.id });
    pushToRoles(['SYSTEM_ADMIN'], { title: 'Applicant replied', body: 'Further information has arrived for an application', url: '/admin.html#applicants', tag: 'cccs-application' });
    flushNow();
    return { ok: true };
  });

  return { createApplicant };
};
