/**
 * The personnel file — documents kept against a member of staff (SIA licence
 * photos, CV, anything an applicant sent us, signed paperwork) and, for
 * someone hired through Applicants, their whole application exactly as it
 * was given.
 *
 * Admin only. These are HR and vetting records: they never go out through
 * GET /api/personnel (publicPersonnel lists its fields explicitly and does
 * not include files or the application), which every staff role can read.
 * Files live under uploads/personnel/<id>/ and are served only from here.
 *
 * Registrar pattern — server.js passes in what this needs, and the returned
 * helpers are how routes-applicants.js copies an application across on hire.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KINDS = { SIA_FRONT: 'SIA licence — front', SIA_BACK: 'SIA licence — back', CV: 'CV', APPLICATION: 'Application', INFO: 'Further information', CONTRACT: 'Contract', ID: 'Identity document', TRAINING: 'Training certificate', OTHER: 'Other' };
const TYPES = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg' };
const SIGNATURES = {
  'application/pdf': (b) => b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46,
  'image/png': (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
};
const MAX = 8e6;

module.exports = function registerPersonnelFiles({ route, httpError, ADMIN, db, logEvent, UPLOADS_DIR, flushNow = () => {} }) {
  const dir = (pid) => path.join(UPLOADS_DIR, 'personnel', String(pid));
  const findPerson = (id) => { const p = db.personnel.find((x) => x.id === Number(id)); if (!p) throw httpError(404, 'person not found'); return p; };

  /** Adds a file to someone's record from bytes already validated (or from
   * a file already on disk, copied — the applicant's copy stays where it is). */
  function addFile(p, { kind = 'OTHER', label, filename, mimetype, bytes, from, source = '', by = '' }) {
    if (!TYPES[mimetype]) throw httpError(400, 'files must be PDF, PNG or JPEG');
    const id = crypto.randomUUID();
    const stored = `${id}${TYPES[mimetype]}`;
    fs.mkdirSync(dir(p.id), { recursive: true });
    if (from) fs.copyFileSync(from, path.join(dir(p.id), stored));
    else fs.writeFileSync(path.join(dir(p.id), stored), bytes);
    if (!Array.isArray(p.files)) p.files = [];
    const f = { id, kind: KINDS[kind] ? kind : 'OTHER', label: String(label || KINDS[kind] || 'Document').slice(0, 160), filename: String(filename || stored).slice(0, 200), stored_name: stored, mimetype, source, added_by: by, added_at: new Date().toISOString() };
    p.files.push(f);
    return f;
  }
  function checkUpload(raw, what = 'file') {
    if (!raw || !raw.data) throw httpError(400, `${what}: no file`);
    if (!TYPES[raw.mimetype]) throw httpError(400, `${what} must be a PDF, PNG or JPEG`);
    const bytes = Buffer.from(String(raw.data).replace(/^data:[^,]*,/, ''), 'base64');
    if (bytes.length > MAX) throw httpError(413, `${what} is too large (8MB maximum)`);
    if (!SIGNATURES[raw.mimetype](bytes)) throw httpError(400, `${what} does not look like a ${raw.mimetype.split('/')[1].toUpperCase()}`);
    return { bytes, mimetype: raw.mimetype, filename: String(raw.filename || what).slice(0, 200) };
  }

  route('GET', '/api/personnel/:id/record', ADMIN, ({ params }) => {
    const p = findPerson(params.id);
    return { application: p.application || null, files: (p.files || []).map((f) => ({ ...f, url: `/api/personnel/${p.id}/files/${f.id}` })), kinds: KINDS };
  });
  route('GET', '/api/personnel/:id/files/:fileId', ADMIN, ({ params }) => {
    const p = findPerson(params.id);
    const f = (p.files || []).find((x) => x.id === params.fileId);
    if (!f) throw httpError(404, 'file not found');
    const file = path.join(dir(p.id), f.stored_name);
    if (!fs.existsSync(file)) throw httpError(404, 'file missing');
    return { __body: fs.readFileSync(file), __headers: { 'content-type': f.mimetype, 'content-disposition': `inline; filename="${f.filename.replace(/"/g, '')}"`, 'cache-control': 'private, no-store' } };
  });
  route('POST', '/api/personnel/:id/files', ADMIN, ({ params, body, user }) => {
    const p = findPerson(params.id);
    const up = checkUpload(body, 'file');
    const f = addFile(p, { kind: body.kind, label: body.label, ...up, source: 'Uploaded', by: user.display_name });
    logEvent('personnel.file_added', `DOCUMENT ADDED TO PERSONNEL FILE #${p.id}`, { personnel_id: p.id });
    flushNow();
    return { __status: 201, __body: f };
  });
  route('DELETE', '/api/personnel/:id/files/:fileId', ADMIN, ({ params, user }) => {
    const p = findPerson(params.id);
    const f = (p.files || []).find((x) => x.id === params.fileId);
    if (!f) throw httpError(404, 'file not found');
    p.files = p.files.filter((x) => x.id !== f.id);
    try { fs.rmSync(path.join(dir(p.id), f.stored_name), { force: true }); } catch {}
    logEvent('personnel.file_removed', `DOCUMENT "${f.label}" REMOVED FROM PERSONNEL FILE #${p.id} BY ${user.username}`, { personnel_id: p.id });
    flushNow();
    return { ok: true };
  });

  return { addFile, checkUpload, TYPES, SIGNATURES };
};
