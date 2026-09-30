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
}) {
  for (const t of ['applicants']) if (!Array.isArray(db[t])) db[t] = [];

  const cvDir = (applicantId) => path.join(UPLOADS_DIR, 'applicants', String(applicantId));
  const findApplicant = (id) => db.applicants.find((a) => a.id === Number(id)) || null;

  const publicApplicant = (a) => ({ ...a });

  route('GET', '/api/applicants', CONTROL, ({ query, user }) => {
    let rows = db.applicants.filter((a) => visibleToUser(a, user));
    if (query.get('status')) rows = rows.filter((a) => a.status === query.get('status').toUpperCase());
    return rows.sort((a, b) => (a.applied_at < b.applied_at ? 1 : -1)).map(publicApplicant);
  });

  route('POST', '/api/applicants', CONTROL, ({ body, user }) => {
    const name = String(body.name || '').trim();
    if (!name) throw httpError(400, 'name required');
    if (body.email && !EMAIL_RE.test(String(body.email).trim())) throw httpError(400, 'invalid email');
    const a = {
      id: nextId('applicants'), name, email: body.email ? String(body.email).trim().toLowerCase() : '',
      phone: String(body.phone || '').trim(), role_applied_for: String(body.role_applied_for || '').trim(),
      source: String(body.source || '').trim(), status: 'APPLIED',
      branch_id: normalizedBranchId(body.branch_id), interview_at: null,
      rejected_reason: null, hired_personnel_id: null, cv: null, notes_log: [],
      applied_at: new Date().toISOString(), updated_at: new Date().toISOString(), created_by: user.id,
    };
    db.applicants.push(a);
    logEvent('applicant.created', `APPLICANT ${name} ADDED${a.role_applied_for ? ` (${a.role_applied_for})` : ''}`, { applicant_id: a.id });
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
    db.personnel.push(p);
    a.status = 'HIRED'; a.hired_personnel_id = p.id; a.updated_at = new Date().toISOString();
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
};
