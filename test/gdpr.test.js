/* UK GDPR retention schedule for people records, and subject access export — node --test */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.PORT = '4066';
process.env.AUTH_SECRET = 'gdpr-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';
process.env.DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cccs-gdpr-')), 'cccs.db');

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
const UPLOADS = path.join(path.dirname(process.env.DATA_FILE), 'uploads');

async function call(method, p, body, token) {
  const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, headers: res.headers };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;
const longAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

let adminT;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

test('rejected applicants go after six months, with their files; live ones stay', async () => {
  const old = { id: 880001, name: 'Old Reject', status: 'REJECTED', updated_at: longAgo(200), applied_at: longAgo(230), notes_log: [] };
  const recent = { id: 880002, name: 'Recent Reject', status: 'REJECTED', updated_at: longAgo(30), applied_at: longAgo(40), notes_log: [] };
  const live = { id: 880003, name: 'Old But Live', status: 'INTERVIEW', updated_at: longAgo(400), applied_at: longAgo(400), notes_log: [] };
  app.db.applicants.push(old, recent, live);
  const dir = path.join(UPLOADS, 'applicants', String(old.id));
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'cv.pdf'), 'x');
  const removed = app.retentionSweep();
  assert.ok(removed.applicants >= 1);
  const ids = app.db.applicants.map((a) => a.id);
  assert.ok(!ids.includes(old.id));
  assert.ok(ids.includes(recent.id) && ids.includes(live.id));
  assert.ok(!fs.existsSync(dir), 'the CV went too');
});

test('deleting an applicant removes their uploaded files', async () => {
  const created = (await call('POST', '/api/applicants', { name: 'Delete Me' }, adminT)).body;
  const dir = path.join(UPLOADS, 'applicants', String(created.id));
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'cv.pdf'), 'x');
  assert.strictEqual((await call('DELETE', `/api/applicants/${created.id}`, undefined, adminT)).status, 200);
  assert.ok(!fs.existsSync(dir));
});

test('marking someone TERMINATED starts the leaver clock; after it runs out the record is anonymised, not deleted', async () => {
  const p = (await call('POST', '/api/personnel', { name: 'Leaver Person', contact_phone: '07700900001' }, adminT)).body;
  await call('PATCH', `/api/personnel/${p.id}`, { employment_status: 'TERMINATED' }, adminT);
  const rec = app.db.personnel.find((x) => x.id === p.id);
  assert.ok(rec.terminated_at);
  rec.date_of_birth = '1980-01-01'; rec.bank_details = { sort_code: '00-00-00' };
  app.retentionSweep();
  assert.strictEqual(rec.name, 'Leaver Person', 'not yet');
  rec.terminated_at = longAgo(2600);
  const fileDir = path.join(UPLOADS, 'personnel', String(p.id));
  fs.mkdirSync(fileDir, { recursive: true }); fs.writeFileSync(path.join(fileDir, 'screening.pdf'), 'x');
  const removed = app.retentionSweep();
  assert.strictEqual(removed.leavers_anonymised, 1);
  assert.match(rec.name, /^Former employee/);
  assert.strictEqual(rec.date_of_birth, null);
  assert.strictEqual(rec.bank_details, null);
  assert.strictEqual(rec.contact_phone, null);
  assert.ok(app.db.personnel.includes(rec), 'still there for rotas and payslips');
  assert.ok(!fs.existsSync(fileDir));
});

test('old shifts, closed forms and client requests age out; open ones stay', async () => {
  app.db.shifts.push({ id: 870001, starts_at: longAgo(2300), ends_at: longAgo(2300) }, { id: 870002, starts_at: longAgo(10), ends_at: longAgo(10) });
  app.db.shift_assignments.push({ id: 870001, shift_id: 870001, personnel_id: 1 }, { id: 870002, shift_id: 870002, personnel_id: 1 });
  app.db.form_submissions.push({ id: 870001, status: 'ACTIONED', submitted_at: longAgo(2300) }, { id: 870002, status: 'OPEN', submitted_at: longAgo(2300) });
  app.db.client_requests.push({ id: 870001, status: 'CLOSED', resolved_at: longAgo(800) }, { id: 870002, status: 'OPEN', created_at: longAgo(800) });
  app.retentionSweep();
  assert.deepStrictEqual(app.db.shifts.filter((s) => s.id >= 870001).map((s) => s.id), [870002]);
  assert.deepStrictEqual(app.db.shift_assignments.filter((a) => a.id >= 870001).map((a) => a.id), [870002]);
  assert.deepStrictEqual(app.db.form_submissions.filter((s) => s.id >= 870001).map((s) => s.id), [870002]);
  assert.deepStrictEqual(app.db.client_requests.filter((r) => r.id >= 870001).map((r) => r.id), [870002]);
});

test('subject access export: everything about the person, nothing secret, admin only, logged', async () => {
  const danT = await login('dwhitfield', 'field123');
  const me = (await call('GET', '/api/me', undefined, danT)).body;
  const pid = me.personnel_id;
  app.db.personnel.find((x) => x.id === pid).welfare_pin_hash = 'abc:def';
  assert.strictEqual((await call('GET', `/api/personnel/${pid}/subject-access-export`, undefined, danT)).status, 403);
  assert.strictEqual((await call('GET', `/api/personnel/${pid}/subject-access-export`, undefined, await login('dispatcher', 'dispatch123'))).status, 403);
  const res = await call('GET', `/api/personnel/${pid}/subject-access-export`, undefined, adminT);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="subject-access-/);
  const out = res.body;
  assert.strictEqual(out.person.id, pid);
  assert.strictEqual(out.account.username, 'dwhitfield');
  const text = JSON.stringify(out);
  assert.ok(!text.includes('password_hash') && !text.includes('welfare_pin_hash'), 'no secrets');
  assert.ok(out.audit_log.some((e) => e.data && e.data.user_id === me.id), 'their sign-ins are in it');
  assert.ok(app.db.audit_logs.some((e) => e.type === 'gdpr.subject_access_export' && e.data.personnel_id === pid));
});
