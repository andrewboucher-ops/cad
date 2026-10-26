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
 *   LIMIT, stated plainly: a web app — installed on the home screen or not —
 *   can only read the phone's position while it is open on screen. Neither
 *   iPhone nor Android lets a web app track location in the background.
 *   So, while the app is closed:
 *     - after 15 min with no position, the officer gets a push notification
 *       ("still on site?") every 30 min; tapping it opens the app, which
 *       reports straight away;
 *     - nobody is clocked out just because nothing arrived;
 *     - when the app next reports and they are OFF site after such a gap,
 *       they may have left at any point since they were last seen on site,
 *       so that is when the 5 minutes count from. If that is already over
 *       5 minutes they are clocked out at once, at the last time they were
 *       seen on site — marked "check the time" for control, who can correct
 *       it (PATCH /times below), and the officer is told by SMS.
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

const crypto = require('crypto');

const DEFAULT_RADIUS = Number(process.env.GEOFENCE_METRES || 250);
const AUTO_OUT_MS = Number(process.env.AUTO_CLOCK_OUT_MIN || 5) * 60000;
const LATE_SMS_MS = 5 * 60000, LATE_ALERT_MS = 15 * 60000;
// A genuine alarm, not another reminder — see the block in tick() below for
// why this escalates all the way to the emergency mechanism rather than
// another push notification.
const NOT_CLOCKED_IN_ALARM_MS = 10 * 60000;
const NUDGE_AFTER_MS = 15 * 60000, NUDGE_EVERY_MS = 30 * 60000;
const REMINDERS_ON = process.env.SHIFT_REMINDERS !== 'off';

// Welfare check-call — off by default, same reasoning as SMS_LIVE/
// MQTT_AURA_PUBLISH_ENABLED: this dials a real phone and can raise a real
// alarm, so it stays inert until an admin deliberately turns it on.
const WELFARE_CHECKCALL_ENABLED = process.env.WELFARE_CHECKCALL_ENABLED === 'on';
const WELFARE_CHECKCALL_INTERVAL_MS = Number(process.env.WELFARE_CHECKCALL_INTERVAL_MIN || 120) * 60000;
// How long to wait for the dialplan to report a result (POST .../result)
// after the call was answered before giving up on it as a failure — covers
// a hung-up-mid-prompt or an AGI that never calls back, not just silence.
const WELFARE_CHECKCALL_RESULT_TIMEOUT_MS = Number(process.env.WELFARE_CHECKCALL_RESULT_TIMEOUT_MIN || 10) * 60000;
// The FreePBX dialplan context the call is dropped into once answered —
// expected to Answer(), ask for date of birth, fetch the expected value
// from GET /api/welfare-checkcall/:token below, compare, and report the
// outcome via POST .../result. Not yet written — see asterisk.js's own
// originateDirect() comment: unverified against a real PBX.
const WELFARE_CHECKCALL_CONTEXT = process.env.WELFARE_CHECKCALL_CONTEXT || 'cccs-welfare-check';

module.exports = function registerAttendance({
  route, httpError, ALL, CONTROL, ADMIN = ['SYSTEM_ADMIN'], db, nextId, logEvent, broadcast, pushToRoles, pushToUsers = () => {}, sms, notifyLog, publicShift,
  findAssignment, findShift, assertAssignmentAccess, isControlRole, publicBaseUrl = '', flushNow = () => {},
  createEmergencyJob, forwardEmergencyToAura = () => {}, ami, tts = require('./tts.js').createTts(),
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
    a.outside_since = null; a.last_inside_at = a.clock_in_location.at;
  }
  /** Called by the clock-out route: an open break ends with the shift. */
  function closeBreaks(a, at) { for (const b of a.breaks || []) if (!b.end) b.end = at; }
  /** An ad-hoc shift (routes-timeclock.js) ends when its officer clocks out. */
  function finishAdHoc(a, s) { if (s.ad_hoc && a.clocked_out_at) { s.ends_at = a.clocked_out_at; s.status = 'COMPLETED'; } }

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
    const now = Date.now(), nowIso = new Date(now).toISOString();
    const prev = a.last_presence_at ? Date.parse(a.last_presence_at) : null;
    if (ok) { a.last_inside_at = nowIso; a.outside_since = null; a.outside_unseen = false; }
    else if (!a.outside_since) {
      // First report from outside. If the app had been closed for longer
      // than the auto clock-out time, they could have left at any point
      // since they were last seen on site — so the clock starts from then.
      const gap = prev == null || now - prev >= AUTO_OUT_MS;
      a.outside_since = gap ? (a.last_inside_at || a.clocked_in_at) : nowIso;
      a.outside_unseen = gap && now - Date.parse(a.outside_since) >= AUTO_OUT_MS;
    }
    a.last_presence_at = nowIso; a.presence_nudged_at = null;
    if (!ok && now - Date.parse(a.outside_since) >= AUTO_OUT_MS) {
      autoOut(a, s);
      flushNow();
      return { enforced: true, inside: false, distance_m: d, radius_m: fence.radius, site: fence.site.name, clocked_out: true, clocked_out_at: a.clocked_out_at, needs_review: Boolean(a.clock_out_needs_review) };
    }
    return { enforced: true, inside: ok, distance_m: d, radius_m: fence.radius, outside_since: a.outside_since, site: fence.site.name };
  });

  /** Control corrects clock times — e.g. an automatic clock-out made after
   * the app had been closed, or a forgotten clock-out. Every change is kept
   * on the assignment and in the log, with the reason. */
  route('PATCH', '/api/shift-assignments/:id/times', CONTROL, ({ params, body, user }) => {
    const a = findAssignment(params.id);
    const s = findShift(a.shift_id);
    const reason = String(body.reason || '').trim().slice(0, 300);
    if (!reason) throw httpError(400, 'say why the times are being changed');
    const when = (v, what) => { if (v === null || v === '') return null; const t = Date.parse(v); if (!Number.isFinite(t)) throw httpError(400, `${what} must be a date and time`); return new Date(t).toISOString(); };
    const inAt = 'clocked_in_at' in body ? when(body.clocked_in_at, 'clock-in') : a.clocked_in_at;
    const outAt = 'clocked_out_at' in body ? when(body.clocked_out_at, 'clock-out') : a.clocked_out_at;
    if (!inAt && outAt) throw httpError(400, 'a clock-out needs a clock-in');
    if (inAt && outAt && Date.parse(outAt) <= Date.parse(inAt)) throw httpError(400, 'the clock-out must be after the clock-in');
    if (outAt && Date.parse(outAt) > Date.now() + 60000) throw httpError(400, 'the clock-out can\'t be in the future');
    if (!Array.isArray(a.time_edits)) a.time_edits = [];
    a.time_edits.push({ at: new Date().toISOString(), by: user.display_name, reason, from: { in: a.clocked_in_at || null, out: a.clocked_out_at || null }, to: { in: inAt, out: outAt } });
    a.clocked_in_at = inAt; a.clocked_out_at = outAt;
    if (outAt) { closeBreaks(a, outAt); finishAdHoc(a, s); if (!a.attendance) a.attendance = 'ATTENDED'; a.outside_since = null; }
    a.clock_out_needs_review = false;
    return done(a, s, 'shift.times_corrected', `${user.display_name} CORRECTED THE CLOCK TIMES OF ${nameOf(a)} — ${reason.toUpperCase()}`);
  });

  /* ---- welfare check-call ---- */
  // What the check-call loop last did, for Admin → Updates — so "the calls
  // have stopped" can be answered from the browser, not journalctl.
  const health = { last_tick_at: null, last_tick_error: null, last_call_error: null, last_voice_error: null };
  /** Raises the same real alarm a welfare timer or an officer emergency
   * does — not another reminder — because by this point the call has
   * already failed to confirm the officer is OK, one way or another.
   * Rescheduled from now, not from the original due time, so a slow PBX or
   * a long result-timeout can't fire a second alarm back-to-back for the
   * same gap. */
  function failWelfareCheckcall(a, s, p, site, reason) {
    const where = site ? ` at ${site.name}` : '';
    a.welfare_checkcall_token = null;
    a.welfare_checkcall_sent_at = null;
    a.welfare_checkcall_due_at = new Date(Date.now() + WELFARE_CHECKCALL_INTERVAL_MS).toISOString();
    const ev = {
      id: nextId('emergency_events'), kind: 'WELFARE_CHECKCALL_FAILED', personnel_id: a.personnel_id,
      callsign: p ? p.name : nameOf(a), zone_source: p ? p.employee_no : null, lat: null, lon: null, state: 'ACTIVE',
      note: `Welfare check call failed — ${reason}`,
      activated_at: new Date().toISOString(), acknowledged_at: null, acknowledged_by: null, resolved_at: null, resolved_by: null,
    };
    db.emergency_events.push(ev);
    createEmergencyJob({ ...ev, location_hint: site ? site.name : null });
    broadcast('emergency.activated', ev);
    pushToRoles(['DISPATCHER', 'SUPERVISOR', 'SYSTEM_ADMIN'], { title: 'ALARM — welfare check call failed', body: `${nameOf(a)}${where} — ${reason}`, url: '/control.html', tag: `cccs-welfarecheckcall-${a.id}` });
    logEvent('shift.welfare_checkcall_failed', `!!! WELFARE CHECK CALL FAILED FOR ${nameOf(a)}${where.toUpperCase()} — ${reason.toUpperCase()} — ALARM RAISED`, { shift_id: a.shift_id, personnel_id: a.personnel_id, emergency_id: ev.id });
    forwardEmergencyToAura(ev);
  }
  /** Places the call and leaves the AMI-answered outcome (not the IVR's
   * verdict — see the result webhook below) to settle it fast on NO_ANSWER/
   * BUSY/FAILED rather than waiting out the full result timeout for a call
   * that was never even picked up. */
  function placeWelfareCheckcall(a, s, p, site) {
    const token = crypto.randomBytes(24).toString('hex');
    a.welfare_checkcall_token = token;
    a.welfare_checkcall_sent_at = new Date().toISOString();
    a.welfare_checkcall_tries = 0; a.welfare_checkcall_blank = 0;
    logEvent('shift.welfare_checkcall_sent', `WELFARE CHECK CALL PLACED TO ${nameOf(a)}`, { shift_id: s.id, personnel_id: a.personnel_id });
    Promise.resolve()
      .then(() => ami.originateDirect({ number: p.contact_phone, context: WELFARE_CHECKCALL_CONTEXT, exten: 's', variables: { CCCS_TOKEN: token } }))
      .then((placed) => placed.result)
      .then((r) => {
        // Something else may already have resolved this token (the
        // dialplan's own result webhook, or an earlier timeout) by the
        // time the call outcome lands — only act if it's still pending.
        if (a.welfare_checkcall_token !== token) return;
        // Clocked out while the call was ringing — they're off shift now,
        // not failing to answer a welfare check for a shift they're still
        // on. Drop it quietly rather than raising an alarm for someone who
        // may well be fine and simply left.
        if (a.clocked_out_at) { a.welfare_checkcall_token = null; a.welfare_checkcall_sent_at = null; flushNow(); return; }
        if (r.outcome !== 'ANSWERED') { failWelfareCheckcall(a, s, p, site, `check call ${r.outcome.toLowerCase().replace(/_/g, ' ')}`); flushNow(); }
        // Answered just means someone picked up — the result webhook is
        // what actually confirms it was them, via date of birth.
      })
      .catch((e) => {
        health.last_call_error = { at: new Date().toISOString(), personnel_id: a.personnel_id, message: e.message };
        if (a.welfare_checkcall_token !== token) return;
        if (a.clocked_out_at) { a.welfare_checkcall_token = null; a.welfare_checkcall_sent_at = null; flushNow(); return; }
        failWelfareCheckcall(a, s, p, site, `could not place the check call — ${e.message}`); flushNow();
      });
  }
  function findPendingCheckcall(token) { return (db.shift_assignments || []).find((x) => x.welfare_checkcall_token === token); }
  // Token-authenticated, no login — the same trust model already used for
  // the ical feed (routes above): the caller here is the PBX dialplan
  // itself, over the LAN, not a browser. GET hands over what the IVR needs
  // to run the check (date of birth, compared locally by the dialplan — it
  // never comes back to CCCS, only the final CONFIRMED/MISMATCH verdict
  // does); POST reports that verdict once the call (and however many
  // retries the dialplan allows) is done. Both 404 alike on an unknown or
  // already-resolved token, deliberately not distinguishing "wrong token"
  // from "already handled" to anyone probing it.
  route('GET', '/api/welfare-checkcall/:token', null, ({ params }) => {
    const a = findPendingCheckcall(params.token); if (!a) throw httpError(404, 'check call not found or already resolved');
    const p = db.personnel.find((x) => x.id === a.personnel_id);
    if (!p || !p.date_of_birth) throw httpError(404, 'check call not found or already resolved');
    return { first_name: p.name.split(/\s+/)[0], date_of_birth: p.date_of_birth };
  });
  route('POST', '/api/welfare-checkcall/:token/result', null, ({ params, body }) => {
    const a = findPendingCheckcall(params.token); if (!a) throw httpError(404, 'check call not found or already resolved');
    const s = findShift(a.shift_id);
    const p = db.personnel.find((x) => x.id === a.personnel_id);
    const site = s && s.site_id ? db.sites.find((x) => x.id === s.site_id) : null;
    // Clocked out since the call went out — off shift now, nothing to
    // alarm about even on a MISMATCH; just clear the stale pending state.
    if (a.clocked_out_at) {
      a.welfare_checkcall_token = null; a.welfare_checkcall_sent_at = null;
      flushNow();
      return { ok: true };
    }
    const outcome = String(body.outcome || '').toUpperCase();
    if (outcome === 'CONFIRMED') {
      a.welfare_checkcall_token = null;
      a.welfare_checkcall_sent_at = null;
      a.welfare_checkcall_due_at = new Date(Date.now() + WELFARE_CHECKCALL_INTERVAL_MS).toISOString();
      logEvent('shift.welfare_checkcall_confirmed', `${nameOf(a)} CONFIRMED WELFARE ON THE CHECK CALL`, { shift_id: a.shift_id, personnel_id: a.personnel_id });
      flushNow();
      return { ok: true };
    }
    const reason = outcome === 'MISMATCH' ? 'entered date of birth did not match'
      : outcome === 'NO_ENTRY' ? 'no date of birth entered'
      : `unexpected check call result (${outcome || 'none given'})`;
    failWelfareCheckcall(a, s, p, site, reason);
    flushNow();
    return { ok: true };
  });

  /** The PBX menu's one call: it reads the 8 digits the officer keyed
   * (DDMMYYYY) and posts them here; CCCS compares, so the date of birth
   * never leaves CCCS and the dialplan needs no JSON. Answers in plain text
   * for the dialplan to branch on: CONFIRMED, RETRY (wrong or nothing
   * entered, tries left) or FAILED (alarm raised). Unknown or resolved
   * token → 404, same as GET above. */
  const WELFARE_CHECKCALL_TRIES = 3;
  route('POST', '/api/welfare-checkcall/:token/verify', null, ({ params, body, query }) => {
    const text = (t, status = 200) => ({ __status: status, __body: t, __headers: { 'content-type': 'text/plain' } });
    const a = findPendingCheckcall(params.token); if (!a) return text('NOT_FOUND', 404);
    const s = findShift(a.shift_id);
    const p = db.personnel.find((x) => x.id === a.personnel_id);
    const site = s && s.site_id ? db.sites.find((x) => x.id === s.site_id) : null;
    if (a.clocked_out_at) { a.welfare_checkcall_token = null; a.welfare_checkcall_sent_at = null; flushNow(); return text('CONFIRMED'); }
    const digits = String((body && body.digits) || query.get('digits') || '').replace(/\D/g, '');
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String((p && p.date_of_birth) || ''));
    if (m && digits === `${m[3]}${m[2]}${m[1]}`) {
      a.welfare_checkcall_token = null; a.welfare_checkcall_sent_at = null; a.welfare_checkcall_tries = 0;
      a.welfare_checkcall_due_at = new Date(Date.now() + WELFARE_CHECKCALL_INTERVAL_MS).toISOString();
      logEvent('shift.welfare_checkcall_confirmed', `${nameOf(a)} CONFIRMED WELFARE ON THE CHECK CALL`, { shift_id: a.shift_id, personnel_id: a.personnel_id });
      flushNow();
      return text('CONFIRMED');
    }
    a.welfare_checkcall_tries = (a.welfare_checkcall_tries || 0) + 1;
    if (!digits) a.welfare_checkcall_blank = (a.welfare_checkcall_blank || 0) + 1;
    if (a.welfare_checkcall_tries < WELFARE_CHECKCALL_TRIES) { flushNow(); return text('RETRY'); }
    const blank = a.welfare_checkcall_blank === a.welfare_checkcall_tries;
    a.welfare_checkcall_tries = 0; a.welfare_checkcall_blank = 0;
    failWelfareCheckcall(a, s, p, site, blank ? 'no date of birth entered' : `entered date of birth did not match (${WELFARE_CHECKCALL_TRIES} tries)`);
    flushNow();
    return text('FAILED');
  });

  /** What the PBX menu says (deploy/pbx-welfare-checkcall.conf plays these
   * by URL), voiced by the VoiceStudio TTS server — see tts.js. Only the
   * opening line is personal; the rest are the same for everyone, so they
   * are made once and cached. */
  const WELFARE_PROMPTS = {
    intro: (first) => `Echelon control welfare check${first ? ` for ${first}` : ''}. Please enter your date of birth as eight digits: day, month, year.`,
    retry: () => 'That didn\'t match. Please try again.',
    thanks: () => 'Thank you. Stay safe.',
    fail: () => 'We could not confirm your welfare. The control room has been alerted and will call you.',
  };
  const wav = (file) => { health.last_voice_error = null; return { __body: require('fs').readFileSync(file), __headers: { 'content-type': 'audio/wav', 'cache-control': 'public, max-age=86400' } }; };
  const noAudio = (e) => { health.last_voice_error = { at: new Date().toISOString(), message: e.message }; console.warn('[attendance] welfare prompt:', e.message); return { __status: 503, __body: 'no audio', __headers: { 'content-type': 'text/plain' } }; };
  // Token-only like the routes above: the PBX fetches these mid-call.
  route('GET', '/api/welfare-checkcall/:token/intro.wav', null, async ({ params }) => {
    const a = findPendingCheckcall(params.token); if (!a) throw httpError(404, 'check call not found or already resolved');
    const p = db.personnel.find((x) => x.id === a.personnel_id);
    const first = p ? p.name.split(/\s+/)[0] : '';
    // Making a clip takes the TTS server ~15 s — too long to leave someone
    // listening to silence. The name line is made ahead (warmWelfareIntro,
    // when the check is scheduled); if it still isn't ready, the line
    // without the name (made at start-up) plays instead.
    const mine = tts.cached(WELFARE_PROMPTS.intro(first));
    if (mine) return wav(mine);
    warmWelfareIntro(p);
    try { return wav(await tts.clip(WELFARE_PROMPTS.intro(''))); } catch (e) { return noAudio(e); }
  });
  // The fixed lines carry nothing personal, so no token: one URL each,
  // which the PBX's own media cache can keep.
  route('GET', '/api/welfare-checkcall-prompts/:name', null, async ({ params }) => {
    const name = String(params.name).replace(/\.wav$/, '');
    if (!['intro', 'retry', 'thanks', 'fail'].includes(name)) throw httpError(404, 'no such prompt');
    try { return wav(await tts.clip(WELFARE_PROMPTS[name](''))); } catch (e) { return noAudio(e); }
  });
  function warmWelfareIntro(p) {
    if (!tts.configured() || !p) return;
    tts.clip(WELFARE_PROMPTS.intro(p.name.split(/\s+/)[0])).then(() => { health.last_voice_error = null; }, (e) => { health.last_voice_error = { at: new Date().toISOString(), message: e.message }; });
  }
  if (WELFARE_CHECKCALL_ENABLED && tts.configured()) {
    // Make the fixed lines now, so the first call of the day isn't waiting on them.
    (async () => { for (const k of Object.keys(WELFARE_PROMPTS)) await tts.clip(WELFARE_PROMPTS[k]('')).then(() => { health.last_voice_error = null; }, (e) => { health.last_voice_error = { at: new Date().toISOString(), message: e.message }; console.warn('[attendance] could not make welfare prompt', k, '—', e.message); }); })();
    // …and the name lines for anyone already clocked in when CCCS starts.
    for (const a of db.shift_assignments || []) if (a.clocked_in_at && !a.clocked_out_at) warmWelfareIntro(db.personnel.find((x) => x.id === a.personnel_id));
  }

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
  /** Clocks someone out because they left site. After the app was closed
   * the time is only "last seen on site", so control is asked to check it. */
  function autoOut(a, s) {
    const p = db.personnel.find((x) => x.id === a.personnel_id);
    const site = s.site_id ? db.sites.find((x) => x.id === s.site_id) : null;
    const where = site ? ` at ${site.name}` : '';
    const first = p ? p.name.split(/\s+/)[0] : '';
    const unseen = Boolean(a.outside_unseen);
    a.clocked_out_at = a.outside_since; a.auto_clocked_out = true; a.outside_since = null; a.outside_unseen = false;
    if (unseen) a.clock_out_needs_review = true;
    closeBreaks(a, a.clocked_out_at);
    finishAdHoc(a, s);
    if (!a.attendance) a.attendance = 'ATTENDED';
    done(a, s, 'shift.auto_clocked_out', unseen
      ? `${nameOf(a)} AUTO CLOCKED OUT — FOUND OFF SITE WHEN THE APP REOPENED; CLOCK-OUT SET TO ${hhmm(a.clocked_out_at)}, LAST SEEN ON SITE — CHECK THE TIME`
      : `${nameOf(a)} AUTO CLOCKED OUT — LEFT ${site ? site.name.toUpperCase() : 'SITE'} AT ${hhmm(a.clocked_out_at)}`);
    if (unseen) pushToRoles(['DISPATCHER', 'SUPERVISOR', 'SYSTEM_ADMIN'], { title: 'Check a clock-out time', body: `${nameOf(a)}${where} — clocked out at ${hhmm(a.clocked_out_at)} (last seen on site)`, url: '/rota.html', tag: `cccs-autoout-${a.id}` });
    if (REMINDERS_ON) {
      text(p, unseen
        ? `Hi ${first}, you've been clocked out of your shift${where} at ${hhmm(a.clocked_out_at)}, the last time your phone showed you on site. If you worked later, contact control to correct it.`
        : `Hi ${first}, you've been clocked out of your shift${where} at ${hhmm(a.clocked_out_at)} because you left the site. If that's wrong, contact control.`, s.id).catch(() => {});
    }
  }
  function tick(now = Date.now()) {
    let changed = false;
    for (const a of db.shift_assignments || []) {
      // One bad record must not stop the loop for everyone after it — the
      // welfare calls below run last, so they were the first to go.
      try {
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
        autoOut(a, s);
        changed = true;
        continue;
      }
      // App closed (no position for a while) while clocked in at a geofenced
      // site, during the shift: ask them to open it so it can report.
      if (a.clocked_in_at && !a.clocked_out_at && now < end && fenceFor(s)) {
        const last = Math.max(Date.parse(a.last_presence_at || 0) || 0, Date.parse(a.clocked_in_at));
        if (now - last >= NUDGE_AFTER_MS && (!a.presence_nudged_at || now - Date.parse(a.presence_nudged_at) >= NUDGE_EVERY_MS)) {
          a.presence_nudged_at = new Date(now).toISOString();
          const users = (db.users || []).filter((u) => u.personnel_id === a.personnel_id).map((u) => u.id);
          pushToUsers(users, { title: 'Still on site?', body: `Tap to open CCCS so your phone can confirm you're at ${site ? site.name : 'your site'}. Keep the app open on your shift if you can.`, url: '/officer.html', tag: `cccs-presence-${a.id}` });
        }
      }
      if (!REMINDERS_ON) continue;
      if (!a.clocked_in_at && now >= start + LATE_SMS_MS && now < end && !a.late_sms_at) {
        a.late_sms_at = new Date(now).toISOString(); changed = true;
        text(p, `Hi ${first}, your shift${where} started at ${hhmm(s.starts_at)}. Please clock in on the CCCS app: ${publicBaseUrl}/officer.html`, s.id).catch(() => {});
        logEvent('shift.late_reminder', `${nameOf(a)} NOT CLOCKED IN 5 MIN AFTER START — REMINDER SENT`, { shift_id: s.id, personnel_id: a.personnel_id });
      }
      // A real alarm, not another notification: the same emergency_events +
      // RED job + siren mechanism a welfare timer or an officer emergency
      // uses, one-shot like the reminders above, and — same as an officer
      // emergency — forwarded out to GuardM8/AURA (forwardEmergencyToAura;
      // a no-op today unless MQTT_AURA_PUBLISH_ENABLED=1). The identifying
      // label inside CCCS is deliberately the person's actual name
      // (callsign: p.name), not callsignOf(p) — control needs to recognise
      // who this is about at a glance, not decode a radio callsign. The
      // outbound SIA zone is a separate, strictly 4-digit field a name
      // can't go in, so zone_source carries their employee number instead
      // (falls back to the same 0000 zoneFromCallsign already uses when
      // there's nothing numeric to extract).
      if (!a.clocked_in_at && now >= start + NOT_CLOCKED_IN_ALARM_MS && now < end && !a.not_clocked_in_alarm_at) {
        a.not_clocked_in_alarm_at = new Date(now).toISOString(); changed = true;
        const ev = {
          id: nextId('emergency_events'), kind: 'NOT_CLOCKED_IN', personnel_id: a.personnel_id,
          callsign: p ? p.name : nameOf(a), zone_source: p ? p.employee_no : null, lat: null, lon: null, state: 'ACTIVE',
          note: `Not clocked in — shift${where} was due to start ${hhmm(s.starts_at)}`,
          activated_at: new Date(now).toISOString(), acknowledged_at: null, acknowledged_by: null, resolved_at: null, resolved_by: null,
        };
        db.emergency_events.push(ev);
        createEmergencyJob({ ...ev, location_hint: site ? site.name : null });
        broadcast('emergency.activated', ev);
        pushToRoles(['DISPATCHER', 'SUPERVISOR', 'SYSTEM_ADMIN'], { title: 'ALARM — not clocked in', body: `${nameOf(a)}${where} has not clocked in`, url: '/control.html', tag: `cccs-notclockedin-${a.id}` });
        logEvent('shift.not_clocked_in_alarm', `!!! ${nameOf(a)} NOT CLOCKED IN — ALARM RAISED${site ? ' AT ' + site.name.toUpperCase() : ''}`, { shift_id: s.id, personnel_id: a.personnel_id, emergency_id: ev.id });
        forwardEmergencyToAura(ev);
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
      // Welfare check-call: while clocked in, ring every
      // WELFARE_CHECKCALL_INTERVAL_MS and have the IVR confirm their date
      // of birth. Needs a phone number and a date of birth on file — no
      // silent partial check with only one of the two.
      if (WELFARE_CHECKCALL_ENABLED && a.clocked_in_at && !a.clocked_out_at && p && p.date_of_birth && p.contact_phone) {
        if (!a.welfare_checkcall_due_at) {
          a.welfare_checkcall_due_at = new Date(Date.parse(a.clocked_in_at) + WELFARE_CHECKCALL_INTERVAL_MS).toISOString();
          warmWelfareIntro(p);
          changed = true;
        } else if (a.welfare_checkcall_token) {
          // Waiting on the dialplan's result webhook (or the AMI-answered
          // outcome, handled as it lands — see placeWelfareCheckcall). If
          // neither ever arrives, this is the backstop.
          if (now - Date.parse(a.welfare_checkcall_sent_at) >= WELFARE_CHECKCALL_RESULT_TIMEOUT_MS) {
            failWelfareCheckcall(a, s, p, site, `no result from the check call within ${Math.round(WELFARE_CHECKCALL_RESULT_TIMEOUT_MS / 60000)} min`);
            changed = true;
          }
        } else if (now >= Date.parse(a.welfare_checkcall_due_at)) {
          placeWelfareCheckcall(a, s, p, site);
          changed = true;
        }
      }
      } catch (e) {
        health.last_tick_error = { at: new Date(now).toISOString(), assignment_id: a.id, message: e.message };
        console.warn(`[attendance] tick failed for assignment ${a.id}:`, e.message);
      }
    }
    health.last_tick_at = new Date(now).toISOString();
    if (changed) flushNow();
  }

  /** Admin → Updates: is the check-call loop running, can it reach the PBX,
   * and for everyone clocked in, when is their next call or why isn't one
   * coming. Read-only, apart from the PBX login the probe makes. */
  route('GET', '/api/admin/welfare-checkcall', ADMIN, async () => {
    let pbx;
    if (!ami.configured()) pbx = { configured: false };
    else {
      try { pbx = { configured: true, ...(await Promise.race([ami.probe(), new Promise((_, rej) => setTimeout(() => rej(new Error('no answer from the PBX in 8 s')), 8000).unref?.())])) }; }
      catch (e) { pbx = { configured: true, logged_in: false, error: e.message }; }
    }
    const now = Date.now();
    const clocked_in = (db.shift_assignments || []).filter((a) => a.clocked_in_at && !a.clocked_out_at).map((a) => {
      const s = db.shifts.find((x) => x.id === a.shift_id);
      const p = db.personnel.find((x) => x.id === a.personnel_id);
      const why = !WELFARE_CHECKCALL_ENABLED ? 'check calls are switched off'
        : !REMINDERS_ON ? 'SHIFT_REMINDERS=off stops the check calls too'
        : !['ASSIGNED', 'CONFIRMED'].includes(a.status) ? `assignment is ${a.status}`
        : !s || !['PUBLISHED', 'IN_PROGRESS'].includes(s.status) ? `shift is ${s ? s.status : 'missing'}`
        : !p ? 'no staff record'
        : !p.contact_phone ? 'no phone number on their staff record'
        : !p.date_of_birth ? 'no date of birth on their staff record'
        : a.welfare_checkcall_token ? 'call in progress — waiting for the result'
        : null;
      return {
        assignment_id: a.id, name: p ? p.name : nameOf(a), site: s && s.site_id ? (db.sites.find((x) => x.id === s.site_id) || {}).name || null : null,
        clocked_in_at: a.clocked_in_at, next_call_at: a.welfare_checkcall_due_at || null, call_sent_at: a.welfare_checkcall_sent_at || null,
        overdue: Boolean(!why && a.welfare_checkcall_due_at && now - Date.parse(a.welfare_checkcall_due_at) > 120000),
        not_calling: why,
      };
    });
    const recent = (db.audit_logs || []).filter((e) => /^shift\.welfare_checkcall/.test(e.type)).slice(-20).reverse()
      .map((e) => ({ at: e.at, type: e.type, summary: e.summary }));
    return {
      enabled: WELFARE_CHECKCALL_ENABLED, reminders_on: REMINDERS_ON, interval_min: WELFARE_CHECKCALL_INTERVAL_MS / 60000,
      context: WELFARE_CHECKCALL_CONTEXT, voice_configured: tts.configured(), ...health, pbx, clocked_in, recent,
    };
  });
  const timer = setInterval(() => { try { tick(); } catch (e) { console.warn('[attendance] tick failed:', e.message); } }, 30000);
  if (timer.unref) timer.unref();

  return { checkClockIn, closeBreaks, finishAdHoc, worked, tick, distanceM, fenceFor };
};
