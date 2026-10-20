/* Weekly client activity email (server.js) — node --test.
 * Mirrors the conventions the existing monthly Kayleigh-report tests use
 * (test/cccs.test.js): mail genuinely fails in this test environment (no
 * MS_TENANT_ID), so sends are asserted via their returned {ok:false,
 * error} shape and the dial_log entry they still leave, not via a mocked
 * inbox. Content is asserted by calling the exported pure functions
 * directly (weeklyShiftsForClient, weeklySharedReportsForClient,
 * buildWeeklyClientReportHtml, weekBounds), same as the existing
 * monthly-report tests call buildMonthlyOpsReportHtml directly. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4053';
process.env.AUTH_SECRET = 'weekly-report-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
async function call(method, path, body, token) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;

/** The next Monday at/after `afterMs`, as a UTC date-only instant — found
 * by search rather than hand-picked, so the fixture can't be wrong. */
function findMonday(afterMs) {
  let d = new Date(afterMs);
  while (d.getUTCDay() !== 1) d = new Date(d.getTime() + 86400000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function lastSundayOfOctober(year) {
  for (let day = 31; day >= 25; day--) {
    const d = new Date(Date.UTC(year, 9, day));
    if (d.getUTCDay() === 0) return d.getTime();
  }
  throw new Error('no Sunday found');
}

let adminT, dan, site, client, shiftType;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dan = app.db.personnel.find((p) => p.name === 'Dan Whitfield');
  shiftType = app.db.shift_types[0];
  site = (await call('POST', '/api/sites', { name: 'Riverside Depot', address: '1 River Rd' }, adminT)).body;
  client = (await call('POST', '/api/clients', { name: 'Meridian Estates', contact_email: 'ops@meridian.example', site_ids: [site.id] }, adminT)).body;
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

async function makeShift(startsAtMs, endsAtMs) {
  return (await call('POST', '/api/shifts', { site_id: site.id, shift_type_id: shiftType.id, starts_at: new Date(startsAtMs).toISOString(), ends_at: new Date(endsAtMs).toISOString() }, adminT)).body;
}
async function assignAndClock(shiftId, clockInMs, clockOutMs) {
  await call('POST', `/api/shifts/${shiftId}/assignments`, { personnel: dan.id }, adminT);
  const a = app.db.shift_assignments.find((x) => x.shift_id === shiftId && x.personnel_id === dan.id);
  a.clocked_in_at = new Date(clockInMs).toISOString();
  a.clocked_out_at = new Date(clockOutMs).toISOString();
  a.status = 'CONFIRMED';
  return a;
}

test('weekBounds resolves to the most recently completed Monday-Sunday week, from any day', async () => {
  const mondayUtc = findMonday(Date.UTC(2027, 0, 1));
  const midWeek = mondayUtc + 3 * 86400000 + 12 * 3600000; // the Thursday of that week, noon
  const { weekStartUtc, weekEndUtc, weekKey } = app.weekBounds(midWeek);
  assert.equal(weekEndUtc, mondayUtc, 'resolves to the most recent Monday even when called mid-week');
  assert.equal(weekEndUtc - weekStartUtc, 7 * 86400000, 'a plain week (no clock change) is exactly 7×24h');
  assert.match(weekKey, /^\d{4}-\d{2}-\d{2}$/);
});

test('weekBounds stays exactly 7 London calendar days across a UK clock-change week', async () => {
  const changeoverSunday = lastSundayOfOctober(2026);
  const followingMonday = changeoverSunday + 86400000; // already a Monday — don't search past it
  const { weekStartUtc, weekEndUtc } = app.weekBounds(followingMonday);
  // The week containing the clock change has an extra real hour (clocks
  // go back), so its UTC span is 7 days + 1 hour, not a flat 7×24h — if
  // this were naive "now minus 7×86400000ms" arithmetic it would always
  // be a flat 7 days regardless, which is exactly the bug this guards
  // against (see the comment above LONDON_FMT in server.js).
  const span = weekEndUtc - weekStartUtc;
  assert.equal(span, 7 * 86400000 + 3600000, 'the clock-change week is 7 London days, which is 1 hour more than 7×24h in UTC');
});

test('weeklyClientReportTick only fires in the Monday 00:00 London hour, and only once per week', async () => {
  const row = { key: 'weekly_client_reports', settings: {} };
  app.db.ui_settings = app.db.ui_settings.filter((x) => x.key !== 'weekly_client_reports');
  app.db.ui_settings.push(row);
  const mondayUtc = findMonday(Date.UTC(2027, 1, 1));

  app.weeklyClientReportTick(mondayUtc + 12 * 3600000); // Monday noon — not the midnight hour
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(row.settings.last_sent_week, undefined, 'not in the 00:00 hour — the week is not marked sent');

  // No shift/report data exists for this particular week, so the batch
  // itself has nothing to email anyone about — the thing under test here
  // is the fire-guard and idempotency marker, not delivery, so assert on
  // the marker rather than dial_log (which only grows when a client
  // actually has content to send, per sendWeeklyClientReport's own skip).
  app.weeklyClientReportTick(mondayUtc + 10 * 60000); // Monday 00:10 — inside the hour
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(row.settings.last_sent_week, 'the week is now marked sent');
  const sentWeek = row.settings.last_sent_week;

  app.weeklyClientReportTick(mondayUtc + 40 * 60000); // same Monday, later in the hour
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(row.settings.last_sent_week, sentWeek, 'already sent this week — marker unchanged, not re-run');
});

test('a client with the toggle off, or no sites, is not sent to', async () => {
  await call('PATCH', `/api/clients/${client.id}`, { weekly_report_enabled: false }, adminT);
  const { weekStartUtc, weekEndUtc } = app.weekBounds(Date.now());
  let r = await app.sendWeeklyClientReports(weekStartUtc, weekEndUtc, { test: true, onlyClientId: client.id });
  assert.equal(r.sent + r.failed + r.skipped, 0, 'toggled off — not attempted at all');
  await call('PATCH', `/api/clients/${client.id}`, { weekly_report_enabled: true }, adminT);

  const noSiteClient = (await call('POST', '/api/clients', { name: 'No Sites Ltd', contact_email: 'x@example.com' }, adminT)).body;
  r = await app.sendWeeklyClientReports(weekStartUtc, weekEndUtc, { test: true, onlyClientId: noSiteClient.id });
  assert.equal(r.sent + r.failed + r.skipped, 0, 'no sites — not attempted at all');
});

test('a client with nothing in the window is skipped silently on a real (non-test) run', async () => {
  const { weekStartUtc, weekEndUtc } = app.weekBounds(findMonday(Date.UTC(2027, 2, 1)) + 10 * 60000);
  const r = await app.sendWeeklyClientReports(weekStartUtc, weekEndUtc, { onlyClientId: client.id });
  assert.equal(r.skipped, 1);
  assert.equal(r.sent + r.failed, 0);
});

test('a shift inside the window appears in the report, and one outside it does not', async () => {
  const mondayUtc = findMonday(Date.UTC(2027, 3, 1));
  const inWeek = await makeShift(mondayUtc + 9 * 3600000, mondayUtc + 17 * 3600000);
  await assignAndClock(inWeek.id, mondayUtc + 9 * 3600000, mondayUtc + 17 * 3600000);
  const beforeWeek = await makeShift(mondayUtc - 2 * 86400000 + 9 * 3600000, mondayUtc - 2 * 86400000 + 17 * 3600000);
  await assignAndClock(beforeWeek.id, mondayUtc - 2 * 86400000 + 9 * 3600000, mondayUtc - 2 * 86400000 + 17 * 3600000);

  const { weekStartUtc, weekEndUtc } = app.weekBounds(mondayUtc + 7 * 86400000 + 600000);
  const rows = app.weeklyShiftsForClient(client, weekStartUtc, weekEndUtc);
  assert.equal(rows.length, 1, 'only the in-window shift is included');
  assert.equal(rows[0].person, 'Dan Whitfield');
  assert.equal(rows[0].hoursLabel, '8.00 h');
  const html = app.buildWeeklyClientReportHtml(client, rows, [], weekStartUtc);
  assert.match(html, /8\.00 h/);
  assert.match(html, /Dan Whitfield/);
});

test('only a report an admin has explicitly shared with the client appears — this never bypasses client_share', async () => {
  const def = (await call('POST', '/api/form-definitions', { name: 'Site visit note', subject_types: ['SITE'], fields: [{ id: 'note', label: 'Note', type: 'text' }] }, adminT)).body;
  const mondayUtc = findMonday(Date.UTC(2027, 4, 1));
  const weekMid = mondayUtc + 3 * 86400000 + 12 * 3600000;

  const shared = (await call('POST', '/api/form-submissions', { definition_id: def.id, subject_type: 'SITE', subject_id: site.id, values: { note: 'All quiet' } }, adminT)).body;
  app.db.form_submissions.find((s) => s.id === shared.id).submitted_at = new Date(weekMid).toISOString();
  await call('POST', `/api/form-submissions/${shared.id}/share`, { values: { note: 'All quiet' } }, adminT);

  const unshared = (await call('POST', '/api/form-submissions', { definition_id: def.id, subject_type: 'SITE', subject_id: site.id, values: { note: 'Confidential detail' } }, adminT)).body;
  app.db.form_submissions.find((s) => s.id === unshared.id).submitted_at = new Date(weekMid).toISOString();
  // deliberately never shared

  const { weekStartUtc, weekEndUtc } = app.weekBounds(mondayUtc + 7 * 86400000 + 600000);
  const reports = app.weeklySharedReportsForClient(client, weekStartUtc, weekEndUtc);
  assert.equal(reports.length, 1, 'only the explicitly shared report appears');
  assert.equal(reports[0].id, shared.id);
  const html = app.buildWeeklyClientReportHtml(client, [], reports, weekStartUtc);
  assert.doesNotMatch(html, /Confidential detail/, 'the unshared report\'s content never reaches the email');
});

test('the manual test-send route is admin-gated', async () => {
  const dispT = await login('dispatcher', 'dispatch123');
  assert.equal((await call('POST', '/api/ops/weekly-client-report/send-test', { client_id: client.id }, dispT)).status, 403);
  const r = await call('POST', '/api/ops/weekly-client-report/send-test', { client_id: client.id }, adminT);
  assert.equal(r.status, 200);
  assert.ok('sent' in r.body && 'failed' in r.body);
});
