/* Staying connected and working offline (officer app): session renewal
 * (POST /api/auth/refresh) and writes that waited on a phone with no
 * signal, replayed with the time they were really made
 * (x-cccs-occurred-at, offline-time.js) — node --test */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

process.env.PORT = '4131';
process.env.AUTH_SECRET = 'offline-sync-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';
process.env.SHIFT_REMINDERS = 'off';

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
async function call(method, path, body, token, headers = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, headers: res.headers };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;
const forge = (payload) => { const body = Buffer.from(JSON.stringify(payload)).toString('base64url'); return `${body}.${crypto.createHmac('sha256', process.env.AUTH_SECRET).update(body).digest('base64url')}`; };
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
const near = (iso, target, ms = 5000) => Math.abs(Date.parse(iso) - Date.parse(target)) < ms;

let adminT, dispT, danT, dan;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123'); dispT = await login('dispatcher', 'dispatch123'); danT = await login('dwhitfield', 'field123');
  dan = app.db.personnel.find((p) => p.name === 'Dan Whitfield');
  for (const s of app.db.sites) { s.lat = null; s.lon = null; } // no geofence here
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

async function shiftFor(startOffsetMin, lengthH = 8) {
  for (const a of app.db.shift_assignments) if (a.personnel_id === dan.id && a.clocked_in_at && !a.clocked_out_at) a.clocked_out_at = new Date().toISOString();
  const type = (await call('GET', '/api/shift-types', undefined, dispT)).body[0];
  const st = new Date(Date.now() + startOffsetMin * 60000);
  const s = (await call('POST', '/api/shifts', { shift_type_id: type.id, site_id: app.db.sites[0].id, starts_at: st.toISOString(), ends_at: new Date(st.getTime() + lengthH * 3600e3).toISOString(), personnel: dan.id }, adminT)).body;
  return app.db.shift_assignments.find((x) => x.shift_id === s.id && x.personnel_id === dan.id);
}

/* ---- staying signed in ---- */
test('an open page renews its session before it runs out, as the same user', async () => {
  const r = await call('POST', '/api/auth/refresh', {}, danT);
  assert.equal(r.status, 200);
  assert.ok(r.body.token && r.body.token !== danT);
  assert.equal(r.body.user.username, 'dwhitfield');
  assert.match(r.headers.get('set-cookie') || '', /cccs_session|HttpOnly/i, 'the cookie follows the new token');
  assert.equal((await call('GET', '/api/me/welfare-pin', undefined, r.body.token)).status === 401, false, 'the new token works');
});
test('a session that already expired cannot be renewed — the officer signs in again', async () => {
  const u = app.db.users.find((x) => x.username === 'dwhitfield');
  const expired = forge({ sub: u.id, role: u.role, iat: Date.now() - 9 * 3600e3, auth_at: Date.now() - 9 * 3600e3, exp: Date.now() - 3600e3 });
  assert.equal((await call('POST', '/api/auth/refresh', {}, expired)).status, 401);
  assert.equal((await call('POST', '/api/auth/refresh', {})).status, 401, 'no token at all');
});
test('renewal stops a week after the original sign-in', async () => {
  const u = app.db.users.find((x) => x.username === 'dwhitfield');
  const old = forge({ sub: u.id, role: u.role, iat: Date.now() - 60000, auth_at: Date.now() - 8 * 24 * 3600e3, exp: Date.now() + 3600e3 });
  const r = await call('POST', '/api/auth/refresh', {}, old);
  assert.equal(r.status, 401);
  // ...and a renewed token carries the original sign-in time, not a new one.
  const fresh = (await call('POST', '/api/auth/refresh', {}, danT)).body.token;
  const p = JSON.parse(Buffer.from(fresh.split('.')[0], 'base64url').toString());
  const orig = JSON.parse(Buffer.from(danT.split('.')[0], 'base64url').toString());
  assert.equal(p.auth_at, orig.auth_at);
});

/* ---- clock actions made with no signal ---- */
test('a clock-out pressed with no signal is recorded when it was pressed, with no reason asked for', async () => {
  const a = await shiftFor(-120, 8); // started 2 h ago, ends in 6 h
  assert.equal((await call('POST', `/api/shift-assignments/${a.id}/clock-in`, { reason: 'late bus' }, danT)).status, 200);
  a.clocked_in_at = ago(110);
  const pressed = ago(30);
  const r = await call('POST', `/api/shift-assignments/${a.id}/clock-out`, {}, danT, { 'x-cccs-occurred-at': pressed, 'idempotency-key': 'out-1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(near(a.clocked_out_at, pressed), 'timed when pressed, not when it arrived');
  const early = a.exceptions.find((x) => x.kind === 'EARLY_OUT');
  assert.ok(early && early.status === 'PENDING' && /no signal/i.test(early.reason), 'the early finish still goes to control, noted as sent with no signal');
  const off = a.exceptions.find((x) => x.kind === 'OFFLINE_OUT');
  assert.ok(off && off.status === 'APPROVED' && off.minutes >= 29, 'noted; an earlier clock-out only takes hours away');
});
test('a clock-in pressed with no signal is backdated only with control\'s approval — rejecting it counts from arrival', async () => {
  const a = await shiftFor(-60, 8);
  const pressed = ago(45);
  const r = await call('POST', `/api/shift-assignments/${a.id}/clock-in`, {}, danT, { 'x-cccs-occurred-at': pressed });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(near(a.clocked_in_at, pressed));
  const off = a.exceptions.find((x) => x.kind === 'OFFLINE_IN');
  assert.equal(off.status, 'PENDING');
  assert.ok((await call('GET', '/api/timeclock/pending', undefined, dispT)).body.some((x) => x.id === off.id && x.label === 'Clocked in with no signal'));
  const d = await call('POST', `/api/timeclock/exceptions/${a.id}/${off.id}`, { decision: 'REJECT' }, dispT);
  assert.equal(d.status, 200);
  assert.ok(near(a.clocked_in_at, off.received_at, 1000), 'counted from when it reached CCCS');
});
test('the phone\'s time is bounded: never in the future, never before clock-in, ignored when days old', async () => {
  const a = await shiftFor(-60, 8);
  await call('POST', `/api/shift-assignments/${a.id}/clock-in`, { reason: 'x' }, danT);
  const inAt = a.clocked_in_at;
  // Break pressed "before" clock-in: floored to clock-in.
  await call('POST', `/api/shift-assignments/${a.id}/break-start`, {}, danT, { 'x-cccs-occurred-at': ago(500) });
  assert.ok(Date.parse(a.breaks[0].start) >= Date.parse(inAt) - 1, 'not before clock-in');
  // Break end in the future: just now.
  await call('POST', `/api/shift-assignments/${a.id}/break-end`, {}, danT, { 'x-cccs-occurred-at': new Date(Date.now() + 3600e3).toISOString() });
  assert.ok(Date.parse(a.breaks[0].end) <= Date.now());
  // Three days old: treated as now.
  a.clocked_in_at = ago(600);
  await call('POST', `/api/shift-assignments/${a.id}/clock-out`, { reason: 'x' }, danT, { 'x-cccs-occurred-at': ago(3 * 24 * 60) });
  assert.ok(near(a.clocked_out_at, new Date().toISOString()));
});
test('a timed break pressed with no signal keeps its real length', async () => {
  const a = await shiftFor(-60, 8);
  await call('POST', `/api/shift-assignments/${a.id}/clock-in`, { reason: 'x' }, danT);
  a.clocked_in_at = ago(55);
  await call('POST', `/api/shift-assignments/${a.id}/break-start`, {}, danT, { 'x-cccs-occurred-at': ago(40) });
  await call('POST', `/api/shift-assignments/${a.id}/break-end`, {}, danT, { 'x-cccs-occurred-at': ago(10) });
  const mins = (Date.parse(a.breaks[0].end) - Date.parse(a.breaks[0].start)) / 60000;
  assert.ok(Math.abs(mins - 30) < 1, `30 min break, got ${mins}`);
});
test('without the header nothing changes: an early clock-out still asks for a reason', async () => {
  const a = await shiftFor(-60, 8);
  await call('POST', `/api/shift-assignments/${a.id}/clock-in`, { reason: 'x' }, danT);
  assert.equal((await call('POST', `/api/shift-assignments/${a.id}/clock-out`, {}, danT)).status, 428);
});
