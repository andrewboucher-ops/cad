/**
 * Attendance — clocking in and out, breaks, hours, and the reminders around
 * a rostered shift.
 *
 * GEOFENCE. A site with coordinates has a clock-in radius (site.geofence_m,
 * default GEOFENCE_METRES = 250; 0 switches it off for that site). An
 * officer clocking in must send their position, and must be within the
 * radius (plus a little for GPS accuracy). Control can clock someone in on
 * their behalf — that is logged as a manual override. While clocked in at
 * a geofenced site the phone app reports the officer's position once a
 * minute; only "inside / outside, and since when" is kept, never a track.
 * Outside for 5 minutes in a row (AUTO_CLOCK_OUT_MIN) = clocked out at the
 * moment they left, with an SMS to say so.
 *   LIMIT, stated plainly: a web app can only report position while it is
 *   open. With the phone locked or the app closed nothing arrives, and with
 *   nothing arriving nobody is clocked out — absence of data is never
 *   treated as having left.
 *
 * BREAKS AND HOURS. Start/end break while clocked in; clocking out closes
 * an open break. Hours worked = clocked in to clocked out, minus breaks.
 *
 * REMINDERS (every 30 s; SHIFT_REMINDERS=off disables):
 *   5 min after a rostered shift starts, not clocked in  → SMS to the officer
 *   15 min after, still not clocked in                     → alert to control
 *   at the end of the shift, still clocked in              → SMS: thanks, please clock out
 * Each fires once per assignment. SMS goes through sms.js, so it is a dry
 * run unless SMS_LIVE=on, and respects the person's SMS opt-out.
 *
 * Registrar pattern — server.js passes in what this needs.
 */
'use strict';

const DEFAULT_RADIUS = Number(process.env.GEOFENCE_METRES || 250);
const AUTO_OUT_MS = Number(process.env.AUTO_CLOCK_OUT_MIN || 5) * 60000;
const LATE_SMS_MS = 5 * 60000, LATE_ALERT_MS = 15 * 60000;
const REMINDERS_ON = process.env.SHIFT_REMINDERS !== 'off';

module.exports = function registerAttendance({
  route, httpError, ALL, CONTROL, db, logEvent, broadcast, pushToRoles, sms, notifyLog, publicShift,
  findAssignment, findShift, assertAssignmentAccess, isControlRole, publicBaseUrl = '', flushNow = () => {},
}) {
  /* ---- geofence ---- */
  function distanceM(a, b) {
    const R = 6371000, rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.sqrt(h)));
  }
  function fenceFor(s) {
    const site = s.site_id ? db.sites.find((x) => x.id === s.site_id) : null;
    if (!site || site.lat == null || site.lon == null) return null;
    const radius = site.geofence_m != null ? Number(site.geofence_m) : DEFAULT_RADIUS;
    if (!(radius > 0)) return null;
    return { site, radius, centre: { lat: Number(site.lat), lon: Number(site.lon) } };
  }
  const fix = (body) => {
    const lat = Number(body && body.lat), lon = Number(body && body.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon, accuracy: Number.isFinite(Number(body.accuracy)) ? Math.max(0, Number(body.accuracy)) : null };
  };
  /** Inside, allowing for GPS accuracy up to 150 m. */
  const inside = (fence, f) => {
    const d = distanceM(fence.centre, f);
    return { d, ok: d <= fence.radius + Math.min(f.accuracy || 0, 150) };
  };

  /** Called by the clock-in route before it changes anything. */
  function checkClockIn(a, s, body, user) {
    const fence = fenceFor(s);
    if (!fence) return;
    if (isControlRole(user.role) && user.personnel_id !== a.personnel_id) {
      a.clock_in_override = { by: user.display_name, at: new Date().toISOString() };
      logEvent('shift.clock_in_override', `${user.display_name} CLOCKED IN PERSONNEL #${a.personnel_id} WITHOUT A LOCATION CHECK`, { shift_id: s.id, personnel_id: a.personnel_id });
      return;
    }
    const f = fix(body);
    if (!f) throw httpError(400, `turn on location to clock in — ${fence.site.name} checks you are on site`);
    const { d, ok } = inside(fence, f);
    if (!ok) throw httpError(403, `you are about ${d >= 1000 ? (d / 1000).toFixed(1) + ' km' : d + ' m'} from ${fence.site.name} — you can only clock in on site (within ${fence.radius} m)`);
    a.clock_in_location = { distance_m: d, accuracy: f.accuracy, at: new Date().toISOString() };
    a.outside_since = null;
  }
  /** Called by the clock-out route: an open break ends with the shift. */
  function closeBreaks(a, at) { for (const b of a.breaks || []) if (!b.end) b.end = at; }

  /* ---- hours ---- */
  function worked(a, now = Date.now()) {
    if (!a.clocked_in_at) return { worked_min: 0, break_min: 0 };
    const end = a.clocked_out_at ? Date.parse(a.clocked_out_at) : now;
    const brk = (a.breaks || []).reduce((n, b) => n + Math.max(0, (b.end ? Date.parse(b.end) : end) - Date.parse(b.start)), 0);
    return { worked_min: Math.max(0, Math.round((end - Date.parse(a.clocked_in_at) - brk) / 60000)), break_min: Math.round(brk / 60000) };
  }

  const done = (a, s, type, summary) => {
    a.updated_at = new Date().toISOString();
    const pub = publicShift(s);
    broadcast('shift.updated', pub, { personnelIds: [a.personnel_id] });
    logEvent(type, summary, { shift_id: s.id, personnel_id: a.personnel_id });
    flushNow();
    return pub;
  };
  const nameOf = (a) => { const p = db.personnel.find((x) => x.id === a.personnel_id); return p ? p.name : 'PERSON'; };

  route('POST', '/api/shift-assignments/:id/break-start', ALL, ({ params, user }) => {
    const a = findAssignment(params.id); assertAssignmentAccess(a, user);
    const s = findShift(a.shift_id);
    if (!a.clocked_in_at || a.clocked_out_at) throw httpError(409, 'not clocked in');
    if (!Array.isArray(a.breaks)) a.breaks = [];
    if (a.breaks.some((b) => !b.end)) throw httpError(409, 'already on a break');
    a.breaks.push({ start: new Date().toISOString(), end: null });
    return done(a, s, 'shift.break_started', `${nameOf(a)} STARTED A BREAK`);
  });
  route('POST', '/api/shift-assignments/:id/break-end', ALL, ({ params, user }) => {
    const a = findAssignment(params.id); assertAssignmentAccess(a, user);
    const s = findShift(a.shift_id);
    const b = (a.breaks || []).find((x) => !x.end);
    if (!b) throw httpError(409, 'not on a break');
    b.end = new Date().toISOString();
    return done(a, s, 'shift.break_ended', `${nameOf(a)} ENDED THEIR BREAK`);
  });
  route('GET', '/api/shift-assignments/:id/hours', ALL, ({ params, user }) => {
    const a = findAssignment(params.id); assertAssignmentAccess(a, user);
    return { ...worked(a), on_break: (a.breaks || []).some((b) => !b.end), clocked_in_at: a.clocked_in_at || null, clocked_out_at: a.clocked_out_at || null };
  });

  /** The phone's once-a-minute position while clocked in at a geofenced
   * site. Only inside/outside is kept. */
  route('POST', '/api/shift-assignments/:id/presence', ['FIELD_USER'], ({ params, body, user }) => {
    const a = findAssignment(params.id); assertAssignmentAccess(a, user);
    const s = findShift(a.shift_id);
    const fence = fenceFor(s);
    if (!fence || !a.clocked_in_at || a.clocked_out_at) return { enforced: false };
    const f = fix(body); if (!f) throw httpError(400, 'position required');
    const { d, ok } = inside(fence, f);
    a.last_presence_at = new Date().toISOString();
    a.outside_since = ok ? null : (a.outside_since || a.last_presence_at);
    return { enforced: true, inside: ok, distance_m: d, radius_m: fence.radius, outside_since: a.outside_since, site: fence.site.name };
  });

  /* ---- reminders, alerts and auto clock-out ---- */
  const hhmm = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
  async function text(p, body, shiftId) {
    if (!p || p.sms_opt_out) return;
    const to = sms.normalizeNumber(p.contact_phone);
    if (!to) return;
    const r = await sms.send({ to, body, label: p.name });
    notifyLog({ channel: 'SMS', personnel_id: p.id, to_number: to, body, shift_id: shiftId, provider: r.dryRun ? 'none' : 'twilio', provider_ref: r.sid || null,
      outcome: r.ok ? (r.dryRun ? 'ATTEMPTED' : 'QUEUED') : 'FAILED', error_code: r.ok ? null : (r.error || 'send failed') });
  }
  function tick(now = Date.now()) {
    let changed = false;
    for (const a of db.shift_assignments || []) {
      if (!['ASSIGNED', 'CONFIRMED'].includes(a.status)) continue;
      const s = db.shifts.find((x) => x.id === a.shift_id);
      if (!s || !['PUBLISHED', 'IN_PROGRESS'].includes(s.status)) continue;
      const start = Date.parse(s.starts_at), end = Date.parse(s.ends_at);
      const p = db.personnel.find((x) => x.id === a.personnel_id);
      const site = s.site_id ? db.sites.find((x) => x.id === s.site_id) : null;
      const where = site ? ` at ${site.name}` : '';
      const first = p ? p.name.split(/\s+/)[0] : '';
      // Auto clock-out: outside the geofence for long enough.
      if (a.clocked_in_at && !a.clocked_out_at && a.outside_since && now - Date.parse(a.outside_since) >= AUTO_OUT_MS && fenceFor(s)) {
        a.clocked_out_at = a.outside_since; a.auto_clocked_out = true; a.outside_since = null;
        closeBreaks(a, a.clocked_out_at);
        if (!a.attendance) a.attendance = 'ATTENDED';
        done(a, s, 'shift.auto_clocked_out', `${nameOf(a)} AUTO CLOCKED OUT — LEFT ${site ? site.name.toUpperCase() : 'SITE'} AT ${hhmm(a.clocked_out_at)}`);
        if (REMINDERS_ON) text(p, `Hi ${first}, you've been clocked out of your shift${where} at ${hhmm(a.clocked_out_at)} because you left the site. If that's wrong, contact control.`, s.id).catch(() => {});
        changed = true;
        continue;
      }
      if (!REMINDERS_ON) continue;
      if (!a.clocked_in_at && now >= start + LATE_SMS_MS && now < end && !a.late_sms_at) {
        a.late_sms_at = new Date(now).toISOString(); changed = true;
        text(p, `Hi ${first}, your shift${where} started at ${hhmm(s.starts_at)}. Please clock in on the CCCS app: ${publicBaseUrl}/officer.html`, s.id).catch(() => {});
        logEvent('shift.late_reminder', `${nameOf(a)} NOT CLOCKED IN 5 MIN AFTER START — REMINDER SENT`, { shift_id: s.id, personnel_id: a.personnel_id });
      }
      if (!a.clocked_in_at && now >= start + LATE_ALERT_MS && now < end && !a.late_alert_at) {
        a.late_alert_at = new Date(now).toISOString(); changed = true;
        const alert = { shift_id: s.id, assignment_id: a.id, personnel_id: a.personnel_id, name: nameOf(a), phone: p ? p.contact_phone || null : null, site_name: site ? site.name : null, starts_at: s.starts_at };
        logEvent('shift.not_clocked_in', `${nameOf(a)} HAS NOT CLOCKED IN — SHIFT${site ? ' AT ' + site.name.toUpperCase() : ''} STARTED ${hhmm(s.starts_at)}`, { shift_id: s.id, personnel_id: a.personnel_id });
        broadcast('shift.not_clocked_in', alert, { personnelIds: [] });
        pushToRoles(['DISPATCHER', 'SUPERVISOR', 'SYSTEM_ADMIN'], { title: 'Not clocked in', body: `${nameOf(a)}${where} — started ${hhmm(s.starts_at)}`, url: '/control.html', tag: `cccs-late-${a.id}` });
      }
      if (a.clocked_in_at && !a.clocked_out_at && now >= end && now < end + 2 * 3600000 && !a.end_sms_at) {
        a.end_sms_at = new Date(now).toISOString(); changed = true;
        text(p, `Thanks for today's shift${where}, ${first}. Please remember to clock out on the CCCS app.`, s.id).catch(() => {});
      }
    }
    if (changed) flushNow();
  }
  const timer = setInterval(() => { try { tick(); } catch (e) { console.warn('[attendance] tick failed:', e.message); } }, 30000);
  if (timer.unref) timer.unref();

  return { checkClockIn, closeBreaks, worked, tick, distanceM, fenceFor };
};
