/* Applicant emails, further-information requests, SIA licence uploads and
 * the hand-over to the personnel file on hire — node --test.
 * The registrars are driven directly with a recording sendEmail, the same
 * way apply-review-fleet.test.js tests the acknowledgement email. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const JPG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');
const b64 = (b) => b.toString('base64');

function rig() {
  const sent = [], handlers = {}, logs = [];
  const UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cccs-app-'));
  const db = { applicants: [], personnel: [], ui_settings: [] };
  let id = 0;
  const httpError = (s, m) => Object.assign(new Error(m), { status: s });
  const route = (m, p, roles, h) => { handlers[`${m} ${p}`] = h; };
  const personnelFiles = require('../routes-personnel-files.js')({ route, httpError, ADMIN: [], db, logEvent: () => {}, UPLOADS_DIR });
  const form = { id: 1, version: 1, name: 'Job application', fields: [
    { id: 'full_name', label: 'Full name', type: 'text', required: true }, { id: 'email', label: 'Email', type: 'text', required: true },
    { id: 'role_applied_for', label: 'Role', type: 'select', options: ['Security officer'] }, { id: 'sia_licence', label: 'SIA licence number', type: 'text' },
  ] };
  require('../routes-applicants.js')({
    route, httpError, CONTROL: [], ADMIN: [], db, nextId: () => ++id,
    logEvent: (t) => logs.push(t), UPLOADS_DIR, MIME: {}, visibleToUser: () => true, normalizedBranchId: () => null, publicPersonnel: (p) => p,
    forms: { activeApplicationForm: () => form, validateValues: (fields, v) => ({ values: v, files: [] }), IMAGE_EXT: {} },
    sendEmail: async (to, subject, html) => { sent.push({ to, subject, html }); return { ok: true }; },
    personnelFiles, publicBaseUrl: 'https://cccs.example',
  });
  const req = (ip = '192.0.2.10') => ({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': ip } });
  const call = (key, args) => { try { return handlers[key](args); } catch (e) { return { __status: e.status, error: e.message }; } };
  const user = { id: 1, display_name: 'Recruiter Rae' };
  const settle = () => new Promise((r) => setTimeout(r, 15));
  return { sent, handlers, db, call, req, user, settle, UPLOADS_DIR, logs };
}
const apply = (t, extra = {}) => t.call('POST /api/public/applications', { body: { definition_id: 1, values: { full_name: 'Sam Applicant', email: 'sam@example.com', role_applied_for: 'Security officer', sia_licence: '1234 5678 9012 3456' }, ...extra }, req: t.req() });

test('the application needs both sides of the SIA licence — or a tick to say there is none — and the photos are kept', () => {
  const t = rig();
  assert.equal(apply(t).__status, 400, 'missing photos refused');
  assert.equal(apply(t, { sia_front: { mimetype: 'image/png', data: b64(PNG) } }).__status, 400, 'one side is not enough');
  assert.equal(apply(t, { sia_front: { mimetype: 'image/png', data: b64(Buffer.from('<script>')) }, sia_back: { mimetype: 'image/png', data: b64(PNG) } }).__status, 400, 'content is checked, not just the type');
  const ok = apply(t, { sia_front: { mimetype: 'image/png', data: b64(PNG), filename: 'front.png' }, sia_back: { mimetype: 'image/jpeg', data: b64(JPG), filename: 'back.jpg' } });
  assert.equal(ok.__status, 201, JSON.stringify(ok));
  const a = t.db.applicants.at(-1);
  assert.ok(a.sia.front && a.sia.back && !a.sia.none);
  const front = t.handlers['GET /api/applicants/:id/sia/:side']({ params: { id: a.id, side: 'front' }, user: t.user });
  assert.equal(front.__headers['content-type'], 'image/png');
  assert.equal(apply(t, { no_sia: true }).__status, 201, 'someone without a licence yet can still apply');
  assert.equal(t.db.applicants.at(-1).sia.none, true);
});

test('the applicant is emailed when their status changes, about interviews, and when hired — unless told not to', async () => {
  const t = rig();
  apply(t, { no_sia: true });
  const a = t.db.applicants[0];
  await t.settle(); t.sent.length = 0;
  const patch = (body) => t.handlers['PATCH /api/applicants/:id']({ params: { id: a.id }, body, user: t.user });
  patch({ status: 'SCREENING' }); await t.settle();
  assert.equal(t.sent.length, 1); assert.match(t.sent[0].subject, /being reviewed/);
  patch({ status: 'INTERVIEW', interview_at: '2026-11-03T10:30:00Z' }); await t.settle();
  assert.match(t.sent[1].html, /3 November/, 'the interview time is in the email');
  patch({ interview_at: '2026-11-04T14:00:00Z' }); await t.settle();
  assert.match(t.sent[2].subject, /Interview time/); assert.match(t.sent[2].html, /4 November/);
  patch({ name: 'Sam A' }); await t.settle();
  assert.equal(t.sent.length, 3, 'no email when nothing the applicant cares about changed');
  patch({ status: 'OFFER', notify: false }); await t.settle();
  assert.equal(t.sent.length, 3, 'staff can choose not to email');
  patch({ status: 'REJECTED', rejected_reason: 'Failed vetting — internal note' }); await t.settle();
  assert.match(t.sent[3].subject, /Your application/);
  assert.ok(!/vetting|internal/.test(t.sent[3].html), 'the internal rejection reason is never sent');
  assert.ok(a.emails.length >= 4 && a.emails.every((e) => e.ok), 'each send is recorded');
});

test('further information: staff list what is needed, the applicant uploads it through a private link, and it lands on the application', async () => {
  const t = rig();
  apply(t, { no_sia: true });
  const a = t.db.applicants[0];
  await t.settle(); t.sent.length = 0;
  const bad = t.call('POST /api/applicants/:id/info-requests', { params: { id: a.id }, body: { items: [] }, user: t.user });
  assert.equal(bad.__status, 400);
  const r = t.handlers['POST /api/applicants/:id/info-requests']({ params: { id: a.id }, body: { message: 'Thanks — just a couple of things.', items: [{ label: 'Proof of address', type: 'FILE' }, { label: 'Two references (names and phone numbers)', type: 'TEXT' }, { label: 'Driving licence (optional)', type: 'FILE', required: false }] }, user: t.user });
  assert.ok(r.__status === 201);
  const token = new URL(r.__body.link).searchParams.get('t');
  assert.ok(token && token.length >= 40);
  assert.ok(!JSON.stringify(r.__body.info_requests).includes(token), 'neither the token nor its hash goes back out');
  assert.ok(!JSON.stringify(r.__body.info_requests).includes('token_hash'));
  await t.settle();
  assert.equal(t.sent.length, 1);
  assert.ok(t.sent[0].html.includes(r.__body.link) && /Proof of address/.test(t.sent[0].html));

  const view = t.handlers['GET /api/public/info-request/:token']({ params: { token }, req: t.req() });
  assert.deepEqual(view.items.map((i) => i.type), ['FILE', 'TEXT', 'FILE']);
  assert.equal(view.status, 'OPEN');
  assert.ok(!('email' in view) && !('name' in view), 'the page shows nothing personal');
  assert.equal(t.call('GET /api/public/info-request/:token', { params: { token: 'nope' }, req: t.req() }).__status, 404);

  const post = (answers) => t.call('POST /api/public/info-request/:token', { params: { token }, body: { answers }, req: t.req() });
  assert.equal(post({ q2: 'Jo Bloggs 07700 900000' }).__status, 400, 'a required upload is missing');
  assert.equal(post({ q1: { mimetype: 'application/pdf', data: b64(Buffer.from('nope')) }, q2: 'x' }).__status, 400, 'checked by content');
  const done = post({ q1: { mimetype: 'application/pdf', data: b64(PDF), filename: 'bill.pdf' }, q2: 'Jo Bloggs 07700 900000; Al Smith 07700 900001' });
  assert.deepEqual(done, { ok: true });
  const req = a.info_requests[0];
  assert.equal(req.status, 'COMPLETED');
  assert.equal(req.answers.find((x) => x.item_id === 'q2').text, 'Jo Bloggs 07700 900000; Al Smith 07700 900001');
  const file = t.handlers['GET /api/applicants/:id/info-files/:rid/:qid']({ params: { id: a.id, rid: req.id, qid: 'q1' }, user: t.user });
  assert.equal(file.__headers['content-type'], 'application/pdf');
  assert.equal(post({ q2: 'again' }).__status, 409, 'a link is answered once');
  assert.ok(a.notes_log.some((n) => /received/.test(n.body)));
});

test('hiring copies the whole application — answers, SIA photos, CV and further information — onto the personnel file, and welcomes them', async () => {
  const t = rig();
  apply(t, { sia_front: { mimetype: 'image/png', data: b64(PNG) }, sia_back: { mimetype: 'image/png', data: b64(PNG) }, cv: { mimetype: 'application/pdf', data: b64(PDF), filename: 'cv.pdf' } });
  const a = t.db.applicants[0];
  const r = t.handlers['POST /api/applicants/:id/info-requests']({ params: { id: a.id }, body: { items: [{ label: 'Proof of address', type: 'FILE' }] }, user: t.user });
  const token = new URL(r.__body.link).searchParams.get('t');
  t.handlers['POST /api/public/info-request/:token']({ params: { token }, body: { answers: { q1: { mimetype: 'image/jpeg', data: b64(JPG) } } }, req: t.req() });
  await t.settle(); t.sent.length = 0;

  const hired = t.handlers['POST /api/applicants/:id/hire']({ params: { id: a.id }, body: {}, user: t.user });
  const p = t.db.personnel[0];
  assert.equal(hired.__status, 201);
  assert.equal(p.sia_licence_no, '1234 5678 9012 3456', 'licence number carried over');
  assert.equal(p.application.form.values.full_name, 'Sam Applicant', 'every answer kept');
  assert.equal(p.application.reference, a.reference);
  assert.deepEqual(p.files.map((f) => f.kind).sort(), ['CV', 'INFO', 'SIA_BACK', 'SIA_FRONT']);
  for (const f of p.files) assert.ok(fs.existsSync(path.join(t.UPLOADS_DIR, 'personnel', String(p.id), f.stored_name)), `${f.kind} copied`);
  const rec = t.handlers['GET /api/personnel/:id/record']({ params: { id: p.id } });
  assert.equal(rec.files.length, 4);
  await t.settle();
  assert.equal(t.sent.length, 1); assert.match(t.sent[0].subject, /Welcome/);
});
