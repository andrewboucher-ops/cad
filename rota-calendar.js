/**
 * One-way sync of the rota into a dedicated Outlook calendar ("Echelon Rota"
 * by default) in one Microsoft 365 mailbox, so the whole day's shifts sit
 * beside the owner's own calendar without cluttering it. Hand-rolled against
 * Microsoft Graph with Node's built-in `fetch`, same reasoning as sms.js and
 * msauth.js: no SDK, no dependency.
 *
 * ONE EVENT PER SHIFT, keyed by the shift id in a single-value extended
 * property, so every write is an idempotent upsert: create, edit, reassign
 * and clock-in all reduce to "make the event match the shift as it is now",
 * and delete/cancel/back-to-draft all reduce to "remove it if it's there".
 * A second property holds a hash of what was last written, so an edit that
 * changes nothing visible (a clock-in, say) costs one read, not a write.
 *
 * NEVER EMAILS ANYONE. No attendees, ever, so Graph has nobody to send an
 * invite or cancellation to; showAs free and no reminder so the rota never
 * makes the owner look busy or pings their phone.
 *
 * NEVER BLOCKS THE ROTA. queue() is synchronous, never throws and returns
 * at once; the Graph calls happen afterwards, one at a time, and a failure
 * is logged and left for the nightly reconcile to repair. Without the Graph
 * env vars every entry point is a silent no-op.
 *
 * Reads the raw collections (shifts, shift_assignments, personnel, sites,
 * shift_types) rather than server.js's publicShift(), so the standalone
 * backfill script (deploy/rota-calendar-sync.js) can run against the
 * database file without starting the server.
 */
'use strict';

const crypto = require('crypto');

const GRAPH = 'https://graph.microsoft.com/v1.0';
// A fixed, made-up GUID namespacing CCCS's properties. Never change it:
// every event already written is found again by it.
const PROP_NS = '{6f1d3c2a-9b47-4e0e-a3c5-2d8e7f41b0c9}';
const SHIFT_ID_PROP = `String ${PROP_NS} Name CccsShiftId`;
const HASH_PROP = `String ${PROP_NS} Name CccsSyncHash`;

// Only shifts staff have been told about. A DRAFT isn't announced yet and a
// CANCELLED one isn't happening, so both have no event.
const SYNCED_STATES = ['PUBLISHED', 'IN_PROGRESS', 'COMPLETED'];
const ACTIVE_ASSIGNMENT = ['ASSIGNED', 'CONFIRMED'];
// A live edit to a shift that finished more than this long ago (a timesheet
// correction) isn't worth putting back on the calendar.
const PAST_CUTOFF_MS = 24 * 3600000;
const AUTH_BACKOFF_MS = 15 * 60000;

const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const odataString = (s) => String(s).replace(/'/g, "''");

/** "2026-10-25T01:30:00.000Z" → "2026-10-25T01:30:00", the wall-clock time
 * in London, which is what Graph wants alongside timeZone: Europe/London. */
function londonDateTime(iso) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

/** Midnight in London on the day `date` falls on, as a Date. */
function startOfLondonDay(date) {
  const [y, m, d] = londonDateTime(date.toISOString()).slice(0, 10).split('-').map(Number);
  // London is UTC or UTC+1, so midnight there is 23:00 or 00:00 UTC; take
  // whichever of the two reads back as midnight on the right day.
  for (const offsetH of [0, 1]) {
    const guess = new Date(Date.UTC(y, m - 1, d) - offsetH * 3600000);
    if (londonDateTime(guess.toISOString()).endsWith('T00:00:00')) return guess;
  }
  return new Date(Date.UTC(y, m - 1, d));
}

/** Who's on the shift, as one line: "Dan Whitfield, Ellie Marsh", with
 * "+ 1 UNASSIGNED" for any unfilled place and plain "UNASSIGNED" for none. */
function officerLine(db, s) {
  const names = (db.shift_assignments || [])
    .filter((a) => a.shift_id === s.id && ACTIVE_ASSIGNMENT.includes(a.status))
    .map((a) => { const p = (db.personnel || []).find((x) => x.id === a.personnel_id); return p ? p.name : 'Unknown officer'; });
  const gap = Math.max(0, (s.required_headcount || 1) - names.length);
  if (!names.length) return gap > 1 ? `${gap} × UNASSIGNED` : 'UNASSIGNED';
  return gap ? `${names.join(', ')} + ${gap} UNASSIGNED` : names.join(', ');
}

function isSyncable(s) { return Boolean(s) && SYNCED_STATES.includes(s.status); }

/** The Graph event body for one shift. Pure: same shift, same output. */
function shiftToEvent(db, s, { baseUrl = 'https://comms.echeloncic.com' } = {}) {
  const type = s.shift_type_id ? (db.shift_types || []).find((t) => t.id === s.shift_type_id) : null;
  const site = s.site_id ? (db.sites || []).find((x) => x.id === s.site_id) : null;
  const role = type ? type.name : 'Shift';
  const siteName = site ? site.name : 'No site';
  const officers = officerLine(db, s);
  const link = `${baseUrl.replace(/\/+$/, '')}/rota.html`;
  const rows = [['Officer', officers], ['Role', role], ['Site', siteName], ['Shift', `#${s.id} (${s.status})`]];
  if (s.notes) rows.push(['Notes', s.notes]);
  const html = `<p>${rows.map(([k, v]) => `<b>${escapeHtml(k)}:</b> ${escapeHtml(v)}`).join('<br>')}</p>`
    + `<p><a href="${escapeHtml(link)}">Open the rota in CCCS</a></p>`
    + '<p style="color:#6b7280;font-size:11px">Copied automatically from the CCCS rota. Edit the shift in CCCS — changes made here are overwritten.</p>';
  return {
    subject: `${role} – ${siteName} – ${officers}`,
    start: { dateTime: londonDateTime(s.starts_at), timeZone: 'Europe/London' },
    end: { dateTime: londonDateTime(s.ends_at), timeZone: 'Europe/London' },
    location: { displayName: siteName },
    body: { contentType: 'HTML', content: html },
    showAs: 'free',
    isReminderOn: false,
    responseRequested: false,
    allowNewTimeProposals: false,
    attendees: [],
  };
}

const eventHash = (ev) => crypto.createHash('sha256').update(JSON.stringify(ev)).digest('hex').slice(0, 32);

function createRotaCalendar(opts = {}) {
  const env = opts.env || process.env;
  const fetchImpl = opts.fetch || ((...a) => fetch(...a));
  const log = opts.log || console;
  const now = opts.now || (() => new Date());
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms).unref?.()));
  const baseUrl = opts.baseUrl || env.PUBLIC_BASE_URL || 'https://comms.echeloncic.com';

  // Its own app registration is recommended (so this app can be limited to
  // the one rota mailbox), falling back to the app CCCS already uses.
  const tenant = env.MS_TENANT_ID || '';
  const clientId = env.ROTA_MS_CLIENT_ID || env.MS_CLIENT_ID || '';
  const clientSecret = env.ROTA_MS_CLIENT_SECRET || env.MS_CLIENT_SECRET || '';
  const owner = (env.ROTA_CALENDAR_OWNER || 'andrew.boucher@echeloncic.com').trim();
  const calendarName = (env.ROTA_CALENDAR_NAME || 'Echelon Rota').trim();
  const enabled = Boolean(tenant && clientId && clientSecret && owner && calendarName);
  const userPath = `${GRAPH}/users/${encodeURIComponent(owner)}`;

  let token = { value: null, exp: 0 };
  let calendarId = null;
  let authFailedUntil = 0;
  let lastReconcile = null;

  async function getToken() {
    if (token.value && Date.now() < token.exp - 30000) return token.value;
    const res = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw graphError(res.status, data.error_description || 'token request failed');
    token = { value: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
    return token.value;
  }

  function graphError(status, message) { const e = new Error(`Graph ${status}: ${message}`); e.status = status; return e; }

  async function graph(method, url, body) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url.startsWith('http') ? url : `${GRAPH}${url}`, {
        method,
        headers: { authorization: `Bearer ${await getToken()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if ((res.status === 429 || res.status === 503) && attempt < 3) {
        await sleep(Math.min(30, Number(res.headers.get('retry-after')) || 2 ** attempt) * 1000);
        continue;
      }
      if (res.status === 204) return null;
      const text = await res.text();
      let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      if (!res.ok) throw graphError(res.status, (data && data.error && data.error.message) || text || res.statusText);
      return data;
    }
  }

  async function getAll(url) {
    const out = [];
    for (let next = url; next;) { const page = await graph('GET', next); out.push(...(page.value || [])); next = page['@odata.nextLink']; }
    return out;
  }

  async function ensureCalendar() {
    if (calendarId) return calendarId;
    const calendars = await getAll(`${userPath}/calendars?$select=id,name&$top=100`);
    const found = calendars.find((c) => (c.name || '').trim().toLowerCase() === calendarName.toLowerCase());
    if (found) calendarId = found.id;
    else {
      calendarId = (await graph('POST', `${userPath}/calendars`, { name: calendarName })).id;
      log.log(`[rota-calendar] created calendar "${calendarName}" in ${owner}`);
    }
    return calendarId;
  }

  const expandProps = `$expand=singleValueExtendedProperties($filter=id eq '${HASH_PROP}' or id eq '${SHIFT_ID_PROP}')`;
  const propOf = (ev, id) => ((ev.singleValueExtendedProperties || []).find((p) => p.id === id) || {}).value;

  async function findEvents(shiftId) {
    const cal = await ensureCalendar();
    const filter = `singleValueExtendedProperties/Any(ep: ep/id eq '${SHIFT_ID_PROP}' and ep/value eq '${odataString(shiftId)}')`;
    return getAll(`${userPath}/calendars/${encodeURIComponent(cal)}/events?$filter=${encodeURIComponent(filter)}&$select=id&${expandProps}`);
  }

  async function deleteEvent(eventId) {
    try { await graph('DELETE', `${userPath}/events/${encodeURIComponent(eventId)}`); }
    catch (e) { if (e.status !== 404) throw e; }
  }

  /** Make the calendar match one shift. `existing` (the shift's events, if
   * the caller already has them) saves a lookup during reconcile. */
  async function syncShift(db, shiftId, existing) {
    const id = Number(shiftId);
    const s = (db.shifts || []).find((x) => x.id === id);
    const events = existing || await findEvents(id);
    // Two events for one shift can only come from a race between the live
    // sync and a backfill; keep the first, drop the rest.
    for (const ev of events.slice(1)) await deleteEvent(ev.id);
    const current = events[0];
    if (!isSyncable(s) || (!current && Date.parse(s.ends_at) < now().getTime() - PAST_CUTOFF_MS)) {
      if (current) { await deleteEvent(current.id); return 'deleted'; }
      return 'skipped';
    }
    const body = shiftToEvent(db, s, { baseUrl });
    const hash = eventHash(body);
    const props = [{ id: SHIFT_ID_PROP, value: String(id) }, { id: HASH_PROP, value: hash }];
    if (current) {
      if (propOf(current, HASH_PROP) === hash) return 'unchanged';
      await graph('PATCH', `${userPath}/events/${encodeURIComponent(current.id)}`, { ...body, singleValueExtendedProperties: props });
      return 'updated';
    }
    const cal = await ensureCalendar();
    await graph('POST', `${userPath}/calendars/${encodeURIComponent(cal)}/events`, { ...body, singleValueExtendedProperties: props });
    return 'created';
  }

  /** A failed permission check would otherwise log on every rota click
   * until an admin grants consent; say it once, then back off a while. */
  function noteFailure(what, e) {
    if (e.status === 401 || e.status === 403) {
      if (Date.now() >= authFailedUntil) log.warn(`[rota-calendar] ${what} failed: ${e.message} — check the app has the Calendars.ReadWrite application permission (admin-consented) and access to ${owner}. Retrying in 15 minutes.`);
      authFailedUntil = Date.now() + AUTH_BACKOFF_MS;
      calendarId = null;
    } else {
      log.warn(`[rota-calendar] ${what} failed: ${e.message}`);
      if (e.status === 404) calendarId = null; // the calendar may have been deleted by hand
    }
  }

  // Live changes: coalesced per shift, run one at a time, after the request
  // that made them has already answered.
  const pending = new Set();
  let timer = null;
  let running = Promise.resolve();
  let dbRef = null;
  const debounceMs = opts.debounceMs != null ? opts.debounceMs : 2000;

  function queue(db, shiftId) {
    if (!enabled) return;
    try {
      dbRef = db;
      pending.add(Number(shiftId));
      if (!timer) { timer = setTimeout(() => { timer = null; flush(); }, debounceMs); timer.unref?.(); }
    } catch (e) { log.warn(`[rota-calendar] queue failed: ${e.message}`); }
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    running = running.then(async () => {
      const ids = [...pending]; pending.clear();
      for (const id of ids) {
        if (Date.now() < authFailedUntil) return;
        try { await syncShift(dbRef, id); } catch (e) { noteFailure(`sync of shift ${id}`, e); }
      }
    }).catch((e) => log.warn(`[rota-calendar] ${e.message}`));
    return running;
  }

  /** Backfill and repair: every shift from the start of today (London) to
   * `days` ahead gets its event created or corrected, and any CCCS event in
   * that window whose shift is gone, cancelled or back in draft is removed.
   * Events in the calendar without a CCCS shift id are left alone. */
  async function reconcile(db, { days = 14 } = {}) {
    const result = { created: 0, updated: 0, unchanged: 0, deleted: 0, skipped: 0, failed: 0 };
    if (!enabled) return { ...result, enabled: false };
    const from = startOfLondonDay(now());
    const to = new Date(from.getTime() + (days + 1) * 86400000);
    const run = async () => {
      const cal = await ensureCalendar();
      const view = await getAll(`${userPath}/calendars/${encodeURIComponent(cal)}/calendarView?startDateTime=${encodeURIComponent(from.toISOString())}&endDateTime=${encodeURIComponent(to.toISOString())}&$select=id&$top=200&${expandProps}`);
      const byShift = new Map();
      for (const ev of view) {
        const sid = propOf(ev, SHIFT_ID_PROP);
        if (!sid) continue;
        if (!byShift.has(Number(sid))) byShift.set(Number(sid), []);
        byShift.get(Number(sid)).push(ev);
      }
      const inWindow = (db.shifts || []).filter((s) => Date.parse(s.ends_at) > from.getTime() && Date.parse(s.starts_at) < to.getTime());
      const ids = new Set([...inWindow.map((s) => s.id), ...byShift.keys()]);
      for (const id of ids) {
        // Not in the view (e.g. a shift moved into the window from later on)
        // means looking it up, not assuming it has no event.
        try { result[await syncShift(db, id, byShift.get(id))]++; }
        catch (e) { result.failed++; noteFailure(`reconcile of shift ${id}`, e); if (e.status === 401 || e.status === 403) break; }
      }
    };
    const job = running.then(run);
    running = job.catch(() => {}); // a failed reconcile mustn't stall live syncs queued behind it
    try { await job; } catch (e) { result.failed++; noteFailure('reconcile', e); }
    lastReconcile = { at: new Date().toISOString(), ...result };
    log.log(`[rota-calendar] reconcile: ${JSON.stringify(result)}`);
    return result;
  }

  return {
    enabled, owner, calendarName, queue, flush, syncShift, reconcile,
    status: () => ({ enabled, owner, calendar_name: calendarName, last_reconcile: lastReconcile }),
  };
}

module.exports = { createRotaCalendar, shiftToEvent, officerLine, londonDateTime, startOfLondonDay, isSyncable, SHIFT_ID_PROP, HASH_PROP };
