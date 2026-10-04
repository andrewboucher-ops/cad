/* Staff numbers, ID photos and the ID card's QR check (routes-staff-id.js)
 * — node --test */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4038';
process.env.AUTH_SECRET = 'staff-id-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
async function call(method, path, body, token, raw = false) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (raw) return res;
  const text = await res.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;
const JPEG = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

let adminT, dispT, danT, dan;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123'); dispT = await login('dispatcher', 'dispatch123'); danT = await login('dwhitfield', 'field123');
  dan = app.db.personnel.find((p) => p.name === 'Dan Whitfield');
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

test('new staff get the next staff number unless one is given; numbers in use are skipped', async () => {
  assert.equal((await call('PUT', '/api/admin/staff-numbers', { prefix: 'ECH-', next: 7 }, dispT)).status, 403);
  await call('PUT', '/api/admin/staff-numbers', { prefix: 'ECH-', next: 7, digits: 4 }, adminT);
  const a = (await call('POST', '/api/personnel', { name: 'Ava Stone' }, adminT)).body;
  assert.equal(a.employee_no, 'ECH-0007');
  await call('PATCH', `/api/personnel/${a.id}`, { employee_no: null, rank: 'Officer' }, adminT); // the admin form's follow-up save
  assert.equal(app.db.personnel.find((p) => p.id === a.id).employee_no, 'ECH-0007', 'a blank number in a save does not wipe it');
  const b = (await call('POST', '/api/personnel', { name: 'Ben Hale', employee_no: 'ECH-0008' }, adminT)).body;
  assert.equal(b.employee_no, 'ECH-0008', 'a number typed in is kept');
  const c = (await call('POST', '/api/personnel', { name: 'Cal Reed' }, adminT)).body;
  assert.equal(c.employee_no, 'ECH-0009', 'ECH-0008 was taken, so it is skipped');

  const without = app.db.personnel.filter((p) => !p.employee_no).length;
  assert.ok(without > 0, 'the demo staff have none');
  assert.equal((await call('GET', '/api/admin/staff-numbers', undefined, adminT)).body.without_number, without, 'nothing is numbered until asked');
  const r = await call('POST', '/api/admin/staff-numbers/assign-missing', {}, adminT);
  assert.equal(r.body.assigned.length, without);
  assert.equal(app.db.personnel.filter((p) => !p.employee_no).length, 0);
  assert.equal(new Set(app.db.personnel.map((p) => p.employee_no)).size, app.db.personnel.length, 'all different');
});

test('an ID photo on the staff record — seen by control and the person, nobody else', async () => {
  assert.equal((await call('POST', `/api/personnel/${dan.id}/photo`, { data: Buffer.from('not an image').toString('base64') }, adminT)).status, 400);
  assert.equal((await call('POST', `/api/personnel/${dan.id}/photo`, { data: JPEG }, dispT)).status, 403, 'admins set it');
  assert.equal((await call('POST', `/api/personnel/${dan.id}/photo`, { data: `data:image/jpeg;base64,${JPEG}` }, adminT)).status, 200);
  const list = (await call('GET', '/api/personnel', undefined, adminT)).body;
  assert.equal(list.find((p) => p.id === dan.id).has_photo, true);
  const own = await call('GET', `/api/personnel/${dan.id}/photo`, undefined, danT, true);
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('content-type'), 'image/jpeg');
  assert.equal((await call('GET', `/api/personnel/${dan.id}/photo`, undefined, dispT, true)).status, 200);
  const other = app.db.users.find((u) => u.role === 'FIELD_USER' && u.personnel_id && u.personnel_id !== dan.id);
  if (other) {
    const t = await login(other.username, 'field123');
    if (t) assert.equal((await call('GET', `/api/personnel/${dan.id}/photo`, undefined, t, true)).status, 403, 'a colleague cannot');
  }
});

test('an SIA licence is marked verified on the register, and stays so until its details change', async () => {
  await call('PATCH', `/api/personnel/${dan.id}`, { sia_licences: [{ licence_type: 'Door Supervision', licence_no: '1234567890123456', expiry: '2030-01-31' }], dbs_certificate_no: '001234567890', dbs_certificate_type: 'ENHANCED', dbs_checked_now: true }, adminT);
  assert.equal((await call('POST', `/api/personnel/${dan.id}/sia-licences/1/verify`, {}, dispT)).status, 403);
  const v = await call('POST', `/api/personnel/${dan.id}/sia-licences/1/verify`, {}, adminT);
  assert.equal(v.status, 200);
  assert.ok(v.body.verified_at);
  await call('PATCH', `/api/personnel/${dan.id}`, { sia_licences: [{ licence_type: 'Door Supervision', licence_no: '1234567890123456', expiry: '2030-01-31' }] }, adminT);
  assert.ok(dan.sia_licences[0].verified_at, 'a re-save of the same licence keeps it');
  await call('PATCH', `/api/personnel/${dan.id}`, { sia_licences: [{ licence_type: 'Door Supervision', licence_no: '1234567890123456', expiry: '2031-01-31' }] }, adminT);
  assert.equal(dan.sia_licences[0].verified_at, null, 'a new expiry needs checking again');
  await call('POST', `/api/personnel/${dan.id}/sia-licences/1/verify`, {}, adminT);
});

test('scanning the ID card: employed, role, SIA and DBS verified, the photo — and nothing more', async () => {
  dan.rank = 'Security Officer';
  assert.equal((await call('GET', `/api/personnel/${dan.id}/id-card`, undefined, dispT)).status, 403);
  const card = (await call('GET', `/api/personnel/${dan.id}/id-card`, undefined, adminT)).body;
  const token = card.verify_url.split('#')[1];
  assert.ok(card.verify_url.startsWith('https://comms.echeloncic.com/verify.html#'));
  assert.ok(token.length >= 24, 'a long random code, not the staff number');
  assert.equal((await call('GET', `/api/personnel/${dan.id}/id-card`, undefined, adminT)).body.verify_url, card.verify_url, 'the same card until re-issued');

  const r = await call('GET', `/api/public/verify/${token}`); // no login
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.valid, true);
  assert.equal(r.body.name, 'Dan Whitfield');
  assert.equal(r.body.employed, true);
  assert.equal(r.body.role, 'Security Officer');
  assert.equal(r.body.employee_no, dan.employee_no);
  assert.deepEqual(r.body.sia.map((l) => [l.type, l.verified, l.expired]), [['Door Supervision', true, false]]);
  assert.equal(r.body.dbs.verified, true);
  assert.equal(r.body.dbs.level, 'ENHANCED');
  const all = JSON.stringify(r.body);
  for (const secret of ['1234567890123456', '001234567890', dan.contact_phone, dan.contact_email].filter(Boolean)) assert.ok(!all.includes(secret), `does not show ${secret}`);
  const photo = await call('GET', r.body.photo_url, undefined, undefined, true);
  assert.equal(photo.status, 200);

  assert.equal((await call('GET', '/api/public/verify/made-up-code-that-is-long-enough')).status, 404);
  assert.equal((await call('GET', `/api/public/verify/${dan.employee_no}`)).status, 404, 'the staff number is not the code');

  await call('PATCH', `/api/personnel/${dan.id}`, { employment_status: 'TERMINATED' }, adminT);
  assert.equal((await call('GET', `/api/public/verify/${token}`)).body.employed, false, 'a leaver shows as not employed');
  await call('PATCH', `/api/personnel/${dan.id}`, { employment_status: 'ACTIVE' }, adminT);

  const re = (await call('POST', `/api/personnel/${dan.id}/id-card/reissue`, {}, adminT)).body;
  assert.notEqual(re.verify_url, card.verify_url);
  assert.equal((await call('GET', `/api/public/verify/${token}`)).status, 404, 'the lost card no longer works');
  assert.equal((await call('GET', `/api/public/verify/${re.verify_url.split('#')[1]}`)).status, 200);
});
