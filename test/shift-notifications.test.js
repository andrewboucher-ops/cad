/* Shift SMS/email notifications and the personal iCal feed — node --test
 *
 * Notifications are fire-and-forget (no queue, matching the rest of the
 * system's synchronous click-to-SMS), so the only reliable thing to assert
 * on is the audit trail they leave in dial_log — same shape routes-contact.js
 * already writes for operator-triggered SMS. The iCal feed is tested for
 * both a field officer's own-assignment feed and a dispatcher's all-shifts
 * feed, including that a cancelled shift's VEVENT keeps its UID and flips
 * to STATUS:CANCELLED rather than disappearing or duplicating. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4027';
process.env.AUTH_SECRET = 'shift-notify-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
async function callRaw(method, path) {
  const res = await fetch(BASE + path, { method });
  return { status: res.status, text: await res.text(), headers: res.headers };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;

let adminT, dispT, patrolTypeId, danPersonnelId;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dispT = await login('dispatcher', 'dispatch123');
  patrolTypeId = app.db.shift_types.find((t) => t.key === 'MOBILE_PATROL').id;
  danPersonnelId = app.db.users.find((u) => u.username === 'dwhitfield').personnel_id;
  await call('PATCH', `/api/personnel/${danPersonnelId}`, { contact_phone: '+447700900999', contact_email: 'dan@example.test' }, adminT);
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

function future(hours) { return new Date(Date.now() + hours * 3600000).toISOString(); }
async function shift(startHour, endHour, extra) {
  const r = await call('POST', '/api/shifts', { shift_type_id: patrolTypeId, starts_at: future(startHour), ends_at: future(endHour), ...extra }, dispT);
  return r.body;
}
function notifyLogsFor(personnelId, sinceId) {
  return app.db.dial_log.filter((r) => r.personnel_id === personnelId && r.id > sinceId && ['SMS', 'EMAIL'].includes(r.channel));
}
const maxLogId = () => app.db.dial_log.reduce((m, r) => Math.max(m, r.id), 0);

test('assigning a published shift notifies by SMS and email, with an audit row each', async () => {
  const mark = maxLogId();
  const s = await shift(24, 32);
  await call('POST', `/api/shifts/${s.id}/assignments`, { personnel: danPersonnelId }, dispT);
  const logs = notifyLogsFor(danPersonnelId, mark);
  assert.equal(logs.filter((r) => r.channel === 'SMS').length, 1);
  assert.equal(logs.filter((r) => r.channel === 'EMAIL').length, 1);
  const sms = logs.find((r) => r.channel === 'SMS');
  assert.match(sms.body, /New shift/);
  assert.equal(sms.to_number, '+447700900999');
  assert.equal(sms.shift_id, s.id);
});

test('a draft shift never notifies its assignee', async () => {
  const mark = maxLogId();
  const s = await shift(50, 58, { status: 'DRAFT' });
  await call('POST', `/api/shifts/${s.id}/assignments`, { personnel: danPersonnelId }, dispT);
  assert.equal(notifyLogsFor(danPersonnelId, mark).length, 0);
});

test('changing a published shift\'s time notifies, and bumps its revision', async () => {
  const s = await shift(60, 68);
  await call('POST', `/api/shifts/${s.id}/assignments`, { personnel: danPersonnelId }, dispT);
  const revBefore = app.db.shifts.find((x) => x.id === s.id).revision;
  const mark = maxLogId();
  await call('PATCH', `/api/shifts/${s.id}`, { starts_at: future(61) }, dispT);
  const logs = notifyLogsFor(danPersonnelId, mark);
  assert.ok(logs.some((r) => r.channel === 'SMS' && /Shift updated/.test(r.body)));
  assert.ok(app.db.shifts.find((x) => x.id === s.id).revision > revBefore);
});

test('cancelling a shift notifies its assignee once, not on an unrelated field edit', async () => {
  const s = await shift(70, 78);
  await call('POST', `/api/shifts/${s.id}/assignments`, { personnel: danPersonnelId }, dispT);
  let mark = maxLogId();
  await call('PATCH', `/api/shifts/${s.id}`, { notes: 'just a note, not a time/site change' }, dispT);
  assert.equal(notifyLogsFor(danPersonnelId, mark).length, 0, 'an unrelated field edit does not notify');
  mark = maxLogId();
  await call('PATCH', `/api/shifts/${s.id}`, { status: 'CANCELLED' }, dispT);
  const logs = notifyLogsFor(danPersonnelId, mark);
  assert.ok(logs.some((r) => r.channel === 'SMS' && /cancelled/i.test(r.body)));
});

test('removing someone from a shift (control-initiated) notifies them', async () => {
  const s = await shift(80, 88);
  const assignR = await call('POST', `/api/shifts/${s.id}/assignments`, { personnel: danPersonnelId }, dispT);
  const assignmentId = assignR.body.assignments.find((a) => a.personnel_id === danPersonnelId).id;
  const mark = maxLogId();
  await call('PATCH', `/api/shift-assignments/${assignmentId}`, { status: 'REMOVED' }, dispT);
  const logs = notifyLogsFor(danPersonnelId, mark);
  assert.ok(logs.some((r) => r.channel === 'SMS' && /Removed from shift/.test(r.body)));
});

test('sms_opt_out suppresses the text but not the email', async () => {
  await call('PATCH', `/api/personnel/${danPersonnelId}`, { sms_opt_out: true }, adminT);
  const mark = maxLogId();
  const s = await shift(90, 98);
  await call('POST', `/api/shifts/${s.id}/assignments`, { personnel: danPersonnelId }, dispT);
  const logs = notifyLogsFor(danPersonnelId, mark);
  assert.equal(logs.filter((r) => r.channel === 'SMS').length, 0);
  assert.equal(logs.filter((r) => r.channel === 'EMAIL').length, 1);
  await call('PATCH', `/api/personnel/${danPersonnelId}`, { sms_opt_out: false }, adminT);
});

test('a rejected shift application notifies the applicant', async () => {
  const s = await shift(100, 108);
  const appR = await call('POST', '/api/shift-applications', { shift: s.id }, await login('rcole', 'field123'));
  const rcolePersonnelId = app.db.users.find((u) => u.username === 'rcole').personnel_id;
  await call('PATCH', `/api/personnel/${rcolePersonnelId}`, { contact_phone: '+447700900111' }, adminT);
  const mark = maxLogId();
  await call('PATCH', `/api/shift-applications/${appR.body.id}`, { status: 'REJECTED', rejection_reason: 'shift filled' }, dispT);
  const logs = notifyLogsFor(rcolePersonnelId, mark);
  assert.ok(logs.some((r) => r.channel === 'SMS' && /not successful/.test(r.body)));
});

test('personal iCal feed: own assignments only, cancelled shift keeps its UID but flips to STATUS:CANCELLED', async () => {
  const danT = await login('dwhitfield', 'field123');
  const feed1 = await call('GET', '/api/me/ical-feed', undefined, danT);
  assert.ok(feed1.body.url.includes('/api/rota/ical/'));
  const token = feed1.body.url.split('/').pop().replace('.ics', '');

  const s = await shift(120, 128);
  const assignR = await call('POST', `/api/shifts/${s.id}/assignments`, { personnel: danPersonnelId }, dispT);
  const assignmentId = assignR.body.assignments.find((a) => a.personnel_id === danPersonnelId).id;

  let ics = await callRaw('GET', `/api/rota/ical/${token}.ics`);
  assert.equal(ics.status, 200);
  assert.match(ics.headers.get('content-type'), /text\/calendar/);
  const uid = `shift-${s.id}-assignment-${assignmentId}@cccs.local`;
  assert.ok(ics.text.includes(`UID:${uid}`), 'feed includes this assignment');
  assert.ok(ics.text.includes('STATUS:CONFIRMED'));

  await call('PATCH', `/api/shifts/${s.id}`, { status: 'CANCELLED' }, dispT);
  ics = await callRaw('GET', `/api/rota/ical/${token}.ics`);
  const block = ics.text.split('BEGIN:VEVENT').find((b) => b.includes(uid));
  assert.ok(block.includes('STATUS:CANCELLED'), 'the same UID now shows cancelled, rather than vanishing');
});

test('a control role\'s feed shows the whole operation, not just their own assignments', async () => {
  const feed = await call('GET', '/api/me/ical-feed', undefined, dispT);
  const token = feed.body.url.split('/').pop().replace('.ics', '');
  const s = await shift(140, 148);
  const ics = await callRaw('GET', `/api/rota/ical/${token}.ics`);
  assert.ok(ics.text.includes(`UID:shift-${s.id}@cccs.local`));
});

test('a draft shift never appears on any feed', async () => {
  const feed = await call('GET', '/api/me/ical-feed', undefined, dispT);
  const token = feed.body.url.split('/').pop().replace('.ics', '');
  const s = await shift(150, 158, { status: 'DRAFT' });
  const ics = await callRaw('GET', `/api/rota/ical/${token}.ics`);
  assert.ok(!ics.text.includes(`shift-${s.id}`));
});

test('regenerating the feed token invalidates the old link', async () => {
  const danT = await login('dwhitfield', 'field123');
  const feed1 = await call('GET', '/api/me/ical-feed', undefined, danT);
  const oldToken = feed1.body.url.split('/').pop().replace('.ics', '');
  const regen = await call('POST', '/api/me/ical-feed/regenerate', {}, danT);
  const newToken = regen.body.url.split('/').pop().replace('.ics', '');
  assert.notEqual(oldToken, newToken);
  assert.equal((await callRaw('GET', `/api/rota/ical/${oldToken}.ics`)).status, 404);
  assert.equal((await callRaw('GET', `/api/rota/ical/${newToken}.ics`)).status, 200);
});

test('an unknown feed token is refused with no auth required', async () => {
  const r = await callRaw('GET', '/api/rota/ical/not-a-real-token.ics');
  assert.equal(r.status, 404);
});
