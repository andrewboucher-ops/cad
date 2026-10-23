/* Outlook rota calendar sync — node --test
 *
 * Graph is never reached: a small in-memory fake stands in for the token
 * endpoint, the mailbox's calendars, events (with the extended-property
 * filter the sync looks events up by) and calendarView. The first half
 * drives rota-calendar.js directly; the second boots the real server with
 * Graph env vars set and globalThis.fetch patched, to prove a shift made
 * or deleted through the API reaches the calendar via broadcast(), and that
 * a Graph outage never fails the rota request itself. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { createRotaCalendar, shiftToEvent, londonDateTime, startOfLondonDay, SHIFT_ID_PROP, HASH_PROP } = require('../rota-calendar.js');

function fakeGraph() {
  const g = { calendars: [{ id: 'cal-default', name: 'Calendar' }], events: [], calls: [], fail: null, seq: 0 };
  const json = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  g.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    g.calls.push(`${method} ${decodeURIComponent(u.pathname)}`);
    if (u.hostname === 'login.microsoftonline.com') return json(200, { access_token: 'tok', expires_in: 3600 });
    if (g.fail) { const r = g.fail(method, u); if (r) return json(r, { error: { message: 'simulated' } }); }
    const body = init.body ? JSON.parse(init.body) : null;
    const path = decodeURIComponent(u.pathname).replace(/^\/v1\.0\/users\/[^/]+/, '');
    const withProps = (e) => ({ id: e.id, subject: e.subject, singleValueExtendedProperties: e.singleValueExtendedProperties });
    if (path === '/calendars' && method === 'GET') return json(200, { value: g.calendars });
    if (path === '/calendars' && method === 'POST') { const c = { id: `cal-${++g.seq}`, name: body.name }; g.calendars.push(c); return json(201, c); }
    let m = path.match(/^\/calendars\/([^/]+)\/events$/);
    if (m && method === 'POST') { const e = { ...body, id: `ev-${++g.seq}`, calendarId: m[1] }; g.events.push(e); return json(201, e); }
    if (m && method === 'GET') {
      const want = u.searchParams.get('$filter').match(/ep\/value eq '([^']*)'/)[1];
      return json(200, { value: g.events.filter((e) => e.calendarId === m[1] && e.singleValueExtendedProperties.some((p) => p.id === SHIFT_ID_PROP && p.value === want)).map(withProps) });
    }
    m = path.match(/^\/calendars\/([^/]+)\/calendarView$/);
    if (m) {
      const from = Date.parse(u.searchParams.get('startDateTime')), to = Date.parse(u.searchParams.get('endDateTime'));
      // Event times are London wall-clock; close enough for a fake to read them as UTC ±1h.
      const t = (d) => Date.parse(`${d.dateTime}Z`);
      return json(200, { value: g.events.filter((e) => e.calendarId === m[1] && t(e.end) > from - 3600000 && t(e.start) < to + 3600000).map(withProps) });
    }
    m = path.match(/^\/events\/([^/]+)$/);
    if (m) {
      const i = g.events.findIndex((e) => e.id === m[1]);
      if (i < 0) return json(404, { error: { message: 'not found' } });
      if (method === 'PATCH') { g.events[i] = { ...g.events[i], ...body }; return json(200, g.events[i]); }
      if (method === 'DELETE') { g.events.splice(i, 1); return new Response(null, { status: 204 }); }
    }
    return json(400, { error: { message: `fake graph: unhandled ${method} ${path}` } });
  };
  g.rota = () => g.events.filter((e) => e.calendarId === (g.calendars.find((c) => c.name === 'Echelon Rota') || {}).id);
  g.shiftIdOf = (e) => (e.singleValueExtendedProperties.find((p) => p.id === SHIFT_ID_PROP) || {}).value;
  return g;
}

const ENV = { MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's' };
const quietLog = () => { const l = { lines: [], log: (m) => l.lines.push(m), warn: (m) => l.lines.push(m) }; return l; };
const hoursFromNow = (h) => new Date(Date.now() + h * 3600000).toISOString();

function fixture() {
  return {
    shift_types: [{ id: 1, name: 'Static Guard' }, { id: 2, name: 'Mobile Patrol' }],
    sites: [{ id: 10, name: 'Meridian Business Park' }, { id: 11, name: 'Ashcroft <House> & Co' }],
    personnel: [{ id: 100, name: 'Dan Whitfield' }, { id: 101, name: 'Ellie Marsh' }],
    shifts: [
      { id: 1, shift_type_id: 1, site_id: 10, starts_at: hoursFromNow(2), ends_at: hoursFromNow(10), required_headcount: 1, status: 'PUBLISHED', notes: '' },
      { id: 2, shift_type_id: 2, site_id: 11, starts_at: hoursFromNow(30), ends_at: hoursFromNow(38), required_headcount: 2, status: 'PUBLISHED', notes: '' },
    ],
    shift_assignments: [
      { id: 1, shift_id: 1, personnel_id: 100, status: 'ASSIGNED' },
      { id: 2, shift_id: 2, personnel_id: 101, status: 'CONFIRMED' },
      { id: 3, shift_id: 2, personnel_id: 100, status: 'REMOVED' },
    ],
  };
}

test('mapping: subject, London times either side of the clocks going back, location, body', () => {
  const db = fixture();
  // 26 Oct 2026 is a Monday after the clocks go back (25 Oct): GMT.
  Object.assign(db.shifts[0], { starts_at: '2026-10-24T18:00:00.000Z', ends_at: '2026-10-26T06:00:00.000Z' });
  const ev = shiftToEvent(db, db.shifts[0], { baseUrl: 'https://comms.example.test/' });
  assert.equal(ev.subject, 'Static Guard – Meridian Business Park – Dan Whitfield');
  assert.deepEqual(ev.start, { dateTime: '2026-10-24T19:00:00', timeZone: 'Europe/London' }); // BST
  assert.deepEqual(ev.end, { dateTime: '2026-10-26T06:00:00', timeZone: 'Europe/London' }); // GMT
  assert.equal(ev.location.displayName, 'Meridian Business Park');
  assert.equal(ev.showAs, 'free');
  assert.equal(ev.isReminderOn, false);
  assert.deepEqual(ev.attendees, []);
  assert.match(ev.body.content, /Shift:<\/b> #1 \(PUBLISHED\)/);
  assert.match(ev.body.content, /href="https:\/\/comms\.example\.test\/rota\.html"/);
});

test('mapping: unassigned and partly-filled shifts say so; names are HTML-escaped in the body', () => {
  const db = fixture();
  assert.equal(shiftToEvent(db, db.shifts[1]).subject, 'Mobile Patrol – Ashcroft <House> & Co – Ellie Marsh + 1 UNASSIGNED');
  assert.match(shiftToEvent(db, db.shifts[1]).body.content, /Ashcroft &lt;House&gt; &amp; Co/);
  db.shift_assignments = [];
  assert.equal(shiftToEvent(db, db.shifts[0]).subject, 'Static Guard – Meridian Business Park – UNASSIGNED');
  assert.equal(shiftToEvent(db, db.shifts[1]).subject, 'Mobile Patrol – Ashcroft <House> & Co – 2 × UNASSIGNED');
  assert.equal(shiftToEvent(db, { ...db.shifts[0], site_id: null, shift_type_id: null }).subject, 'Shift – No site – UNASSIGNED');
});

test('London day boundaries in summer and winter', () => {
  assert.equal(startOfLondonDay(new Date('2026-07-01T12:00:00Z')).toISOString(), '2026-06-30T23:00:00.000Z');
  assert.equal(startOfLondonDay(new Date('2026-12-01T12:00:00Z')).toISOString(), '2026-12-01T00:00:00.000Z');
  assert.equal(londonDateTime('2026-03-29T01:30:00Z'), '2026-03-29T02:30:00');
});

test('without Graph env vars every entry point is a silent no-op', async () => {
  const g = fakeGraph(); const log = quietLog();
  const cal = createRotaCalendar({ env: {}, fetch: g.fetch, log });
  assert.equal(cal.enabled, false);
  cal.queue(fixture(), 1);
  await cal.flush();
  assert.deepEqual(await cal.reconcile(fixture()), { created: 0, updated: 0, unchanged: 0, deleted: 0, skipped: 0, failed: 0, enabled: false });
  assert.equal(g.calls.length, 0);
  assert.equal(log.lines.length, 0);
});

test('upsert: creates the calendar and one event, updates in place, skips unchanged, deletes on cancel', async () => {
  const g = fakeGraph(); const db = fixture();
  const cal = createRotaCalendar({ env: ENV, fetch: g.fetch, log: quietLog() });
  assert.equal(cal.owner, 'andrew.boucher@echeloncic.com');
  assert.equal(await cal.syncShift(db, 1), 'created');
  assert.ok(g.calendars.some((c) => c.name === 'Echelon Rota'), 'calendar created');
  assert.ok(g.calls.some((c) => c.includes('/users/andrew.boucher@echeloncic.com/calendars')));
  assert.equal(g.rota().length, 1);
  assert.deepEqual(g.rota()[0].attendees, []);
  assert.ok(g.rota()[0].singleValueExtendedProperties.some((p) => p.id === HASH_PROP));

  assert.equal(await cal.syncShift(db, 1), 'unchanged');
  db.shift_assignments[0].personnel_id = 101; // reassigned
  assert.equal(await cal.syncShift(db, 1), 'updated');
  assert.equal(g.rota().length, 1);
  assert.match(g.rota()[0].subject, /– Ellie Marsh$/);

  db.shifts[0].status = 'CANCELLED';
  assert.equal(await cal.syncShift(db, 1), 'deleted');
  assert.equal(g.rota().length, 0);
  assert.equal(await cal.syncShift(db, 1), 'skipped');
});

test('upsert: finds an existing calendar by name, and a deleted shift removes its event', async () => {
  const g = fakeGraph(); g.calendars.push({ id: 'cal-existing', name: 'echelon rota' });
  const db = fixture();
  const cal = createRotaCalendar({ env: ENV, fetch: g.fetch, log: quietLog() });
  await cal.syncShift(db, 2);
  assert.equal(g.calendars.length, 2);
  assert.equal(g.events[0].calendarId, 'cal-existing');
  db.shifts = db.shifts.filter((s) => s.id !== 2);
  assert.equal(await cal.syncShift(db, 2), 'deleted');
  assert.equal(g.events.length, 0);
});

test('drafts get no event, and a live edit to a long-finished shift is not added', async () => {
  const g = fakeGraph(); const db = fixture();
  db.shifts[0].status = 'DRAFT';
  Object.assign(db.shifts[1], { starts_at: hoursFromNow(-80), ends_at: hoursFromNow(-72) });
  const cal = createRotaCalendar({ env: ENV, fetch: g.fetch, log: quietLog() });
  assert.equal(await cal.syncShift(db, 1), 'skipped');
  assert.equal(await cal.syncShift(db, 2), 'skipped');
  assert.equal(g.events.length, 0);
});

test('queue coalesces repeated changes to one shift and never throws on a Graph failure', async () => {
  const g = fakeGraph(); const db = fixture(); const log = quietLog();
  const cal = createRotaCalendar({ env: ENV, fetch: g.fetch, log, debounceMs: 60000 });
  cal.queue(db, 1); cal.queue(db, 1); cal.queue(db, '1');
  await cal.flush();
  assert.equal(g.calls.filter((c) => c.startsWith('POST') && c.endsWith('/events')).length, 1);

  g.fail = (method) => (method === 'PATCH' ? 500 : null);
  db.shifts[0].notes = 'gate code changed';
  cal.queue(db, 1);
  await cal.flush();
  assert.ok(log.lines.some((l) => /sync of shift 1 failed: Graph 500/.test(l)));
});

test('a missing permission is logged once, then the sync backs off', async () => {
  const g = fakeGraph(); const db = fixture(); const log = quietLog();
  g.fail = () => 403;
  const cal = createRotaCalendar({ env: ENV, fetch: g.fetch, log });
  cal.queue(db, 1); cal.queue(db, 2);
  await cal.flush();
  cal.queue(db, 1);
  await cal.flush();
  const warnings = log.lines.filter((l) => /Calendars\.ReadWrite/.test(l));
  assert.equal(warnings.length, 1);
  assert.equal(g.calls.filter((c) => !c.includes('oauth2')).length, 1, 'no further Graph calls while backing off');
});

test('reconcile backfills today → +14 days, repairs drift and duplicates, removes orphans, leaves manual events alone', async () => {
  const g = fakeGraph(); const db = fixture();
  db.shifts.push({ id: 3, shift_type_id: 1, site_id: 10, starts_at: hoursFromNow(24 * 20), ends_at: hoursFromNow(24 * 20 + 8), required_headcount: 1, status: 'PUBLISHED' });
  const cal = createRotaCalendar({ env: ENV, fetch: g.fetch, log: quietLog() });

  let r = await cal.reconcile(db);
  assert.equal(r.created, 2, 'shifts 1 and 2; shift 3 is beyond the window');
  assert.deepEqual(g.rota().map(g.shiftIdOf).sort(), ['1', '2']);

  // A manual event, a duplicate of shift 1, an event for a shift since
  // deleted without a broadcast, and an edit made straight in Outlook.
  const calId = g.rota()[0].calendarId;
  const near = { start: { dateTime: londonDateTime(hoursFromNow(3)) }, end: { dateTime: londonDateTime(hoursFromNow(4)) } };
  g.events.push({ id: 'manual', calendarId: calId, subject: 'Dentist', ...near, singleValueExtendedProperties: [] });
  g.events.push({ id: 'dupe', calendarId: calId, subject: 'x', ...near, singleValueExtendedProperties: [{ id: SHIFT_ID_PROP, value: '1' }] });
  g.events.push({ id: 'orphan', calendarId: calId, subject: 'x', ...near, singleValueExtendedProperties: [{ id: SHIFT_ID_PROP, value: '999' }] });
  const ev2 = g.rota().find((e) => g.shiftIdOf(e) === '2');
  ev2.subject = 'edited by hand';
  ev2.singleValueExtendedProperties = ev2.singleValueExtendedProperties.map((p) => (p.id === HASH_PROP ? { ...p, value: 'stale' } : p));

  r = await cal.reconcile(db);
  assert.equal(r.failed, 0);
  assert.equal(r.deleted, 1, 'the orphan');
  assert.ok(!g.events.some((e) => e.id === 'orphan'));
  assert.ok(g.events.some((e) => e.id === 'manual'), 'events without a CCCS shift id are never touched');
  assert.equal(g.rota().filter((e) => g.shiftIdOf(e) === '1').length, 1, 'duplicate removed');
  assert.match(g.rota().find((e) => g.shiftIdOf(e) === '2').subject, /^Mobile Patrol – /);

  r = await cal.reconcile(db);
  assert.equal(r.unchanged, 2);
  assert.equal(r.created + r.updated + r.deleted, 0);
  assert.equal(cal.status().last_reconcile.unchanged, 2);
});

/* ---- Through the real server ---- */
process.env.PORT = '4091';
process.env.AUTH_SECRET = 'rota-calendar-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';
Object.assign(process.env, ENV, { ROTA_CALENDAR_OWNER: 'rota@example.test' });

const graph = fakeGraph();
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => (/microsoft(online)?\.com/.test(String(url)) ? graph.fetch(String(url), init) : realFetch(url, init));

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
async function call(method, path, body, token) {
  const res = await realFetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
let adminT, typeId, siteId, danId;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = (await call('POST', '/api/auth/login', { username: 'admin', password: 'admin123' })).body.token;
  typeId = app.db.shift_types.find((t) => t.key === 'STATIC_GUARD').id;
  siteId = app.db.sites[0].id;
  danId = app.db.users.find((u) => u.username === 'dwhitfield').personnel_id;
});
after(() => { globalThis.fetch = realFetch; app.server.closeAllConnections?.(); app.server.close(); });

test('server: creating, reassigning and deleting a shift through the API keeps the calendar in step', async () => {
  const created = await call('POST', '/api/shifts', { shift_type_id: typeId, site_id: siteId, starts_at: hoursFromNow(5), ends_at: hoursFromNow(13), personnel: danId }, adminT);
  assert.equal(created.status, 201);
  await app.rotaCalendar.flush();
  const mine = () => graph.rota().filter((e) => graph.shiftIdOf(e) === String(created.body.id));
  assert.equal(mine().length, 1);
  assert.match(mine()[0].subject, new RegExp(`^Static Guard – ${app.db.sites[0].name} – ${app.db.personnel.find((p) => p.id === danId).name}$`));
  assert.ok(graph.calls.some((c) => c.includes('rota@example.test')));

  const a = app.db.shift_assignments.find((x) => x.shift_id === created.body.id);
  assert.equal((await call('PATCH', `/api/shift-assignments/${a.id}`, { status: 'REMOVED' }, adminT)).status, 200);
  await app.rotaCalendar.flush();
  assert.match(mine()[0].subject, /– UNASSIGNED$/);

  assert.equal((await call('DELETE', `/api/shifts/${created.body.id}`, undefined, adminT)).status, 200);
  await app.rotaCalendar.flush();
  assert.equal(mine().length, 0);
});

test('server: a Graph outage never fails the rota action', async () => {
  graph.fail = () => 500;
  const created = await call('POST', '/api/shifts', { shift_type_id: typeId, site_id: siteId, starts_at: hoursFromNow(50), ends_at: hoursFromNow(58) }, adminT);
  assert.equal(created.status, 201);
  await app.rotaCalendar.flush();
  graph.fail = null;
  const r = await call('POST', '/api/rota-calendar/reconcile', { days: 3 }, adminT);
  assert.equal(r.status, 200);
  assert.equal(r.body.failed, 0);
  assert.ok(graph.rota().some((e) => graph.shiftIdOf(e) === String(created.body.id)), 'the nightly reconcile repairs what the outage missed');
  assert.equal((await call('GET', '/api/rota-calendar', undefined, adminT)).body.owner, 'rota@example.test');
});
