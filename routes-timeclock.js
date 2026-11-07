/**
 * Timeclock — clocking in and out outside the rota, and the approvals that
 * go with it.
 *
 * REASONS. An officer clocking in or out more than TOLERANCE minutes
 * (default 5, TIMECLOCK_TOLERANCE_MIN) either side of their rostered start
 * or finish is asked why. The answer is kept on the assignment as an
 * "exception" waiting for control or an admin to approve or reject:
 *   EARLY_IN   clocked in early     — reject: paid/billed from the rostered start
 *   LATE_OUT   clocked out late     — reject: paid/billed to the rostered finish
 *   LATE_IN    clocked in late      — recorded (the hours are what they are)
 *   EARLY_OUT  clocked out early    — recorded
 *   UNSCHEDULED clocked in with no shift (an ad-hoc shift) — reject: no hours
 * When control clocks someone in or out on their behalf, any exception is
 * approved there and then — control is the approver.
 *
 * AD-HOC SHIFTS. Clocking in with nothing rostered creates a one-person
 * shift at the chosen site, starting now (the same on-site check applies).
 * Its finish is set when they clock out.
 *
 * Invoices (routes-invoices.js) leave out hours that were rejected and flag
 * any still waiting for approval.
 *
 * Registrar pattern — server.js passes in what this needs.
 */
'use strict';

const TOLERANCE_MIN = Number(process.env.TIMECLOCK_TOLERANCE_MIN || 5);
const KIND = {
  EARLY_IN: 'Clocked in early', LATE_IN: 'Clocked in late', EARLY_OUT: 'Clocked out early', LATE_OUT: 'Clocked out late', UNSCHEDULED: 'Clocked in with no shift',
  OFFLINE_IN: 'Clocked in with no signal', OFFLINE_OUT: 'Clocked out with no signal',
};

module.exports = function registerTimeclock({
  route, httpError, CONTROL, ADMIN = ['SYSTEM_ADMIN'], db, nextId, logEvent, broadcast, attendance, publicShift, findAssignment, findShift,
  isControlRole, siteVisibleTo = () => true, flushNow = () => {}, assertDeployable = () => {},
}) {
  const crypto = require('crypto');
  const { occurredAt } = require('./offline-time.js');
  const minutes = (ms) => Math.round(ms / 60000);
  const nameOf = (pid) => { const p = db.personnel.find((x) => x.id === pid); return p ? p.name : 'PERSON'; };
  const onBehalf = (a, user) => isControlRole(user.role) && user.personnel_id !== a.personnel_id;

  function addException(a, kind, mins, reason, user) {
    if (!Array.isArray(a.exceptions)) a.exceptions = [];
    const auto = onBehalf(a, user);
    const ex = {
      id: crypto.randomUUID(), kind, minutes: mins, reason: reason || (auto ? `by ${user.display_name}` : ''), at: new Date().toISOString(),
      status: auto ? 'APPROVED' : 'PENDING', decided_by: auto ? user.display_name : null, decided_at: auto ? new Date().toISOString() : null,
    };
    a.exceptions.push(ex);
    if (!auto) {
      broadcast('timeclock.pending', { assignment_id: a.id, personnel_id: a.personnel_id, name: nameOf(a.personnel_id), kind, minutes: mins }, { personnelIds: [] });
      logEvent('timeclock.exception', `${nameOf(a.personnel_id)}: ${KIND[kind].toUpperCase()}${mins ? ` (${mins} MIN)` : ''} — NEEDS APPROVAL`, { personnel_id: a.personnel_id });
    }
    return ex;
  }
  const span = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);
  const needReason = (what) => httpError(428, `${what} — please give a reason`);

  /** Called by the clock-in / clock-out routes before they change anything.
   * Throws 428 (with a message saying why) when a reason is needed. */
  function check(a, s, body, user, direction, { at = null, replay = false } = {}) {
    if (s.ad_hoc) return;
    let reason = String((body && body.reason) || '').trim().slice(0, 300);
    const now = at ? Date.parse(at) : Date.now();
    const target = Date.parse(direction === 'IN' ? s.starts_at : s.ends_at);
    const diff = minutes(now - target);
    if (Math.abs(diff) <= TOLERANCE_MIN) return;
    const kind = direction === 'IN' ? (diff < 0 ? 'EARLY_IN' : 'LATE_IN') : (diff < 0 ? 'EARLY_OUT' : 'LATE_OUT');
    // A write replayed from the phone's offline queue can't stop and ask:
    // it goes through, and the exception waits for control like any other.
    if (!reason && replay && !onBehalf(a, user)) reason = 'Sent with no signal — no reason given';
    if (!reason && !onBehalf(a, user)) {
      throw needReason(`You're ${direction === 'IN' ? 'clocking in' : 'clocking out'} ${span(Math.abs(diff))} ${diff < 0 ? 'before' : 'after'} the rostered ${direction === 'IN' ? 'start' : 'finish'} (${new Date(target).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })})`);
    }
    // Recorded once the clock action itself has gone through (see record()).
    return { kind, mins: Math.abs(diff), reason };
  }
  function record(a, pending, user) { if (pending) addException(a, pending.kind, pending.mins, pending.reason, user); }
  /** A clock-in or clock-out made with no signal is recorded at the time
   * on the phone (offline-time.js) and noted here. A clock-in recorded
   * earlier than it reached CCCS adds hours on the phone's word, so it
   * waits for control (rejecting it counts from when it arrived). An
   * earlier clock-out only ever takes hours away: noted, already approved. */
  function recordOffline(a, direction, at, user) {
    if (!at) return;
    const received = new Date().toISOString();
    const mins = minutes(Date.parse(received) - Date.parse(at));
    if (mins < 1) return;
    const kind = direction === 'IN' ? 'OFFLINE_IN' : 'OFFLINE_OUT';
    const hhmm = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
    const reason = `Pressed at ${hhmm(at)} with no signal; reached CCCS at ${hhmm(received)}`;
    if (direction === 'IN' && !onBehalf(a, user)) {
      const ex = addException(a, kind, mins, reason, user);
      ex.received_at = received;
      return ex;
    }
    if (!Array.isArray(a.exceptions)) a.exceptions = [];
    const ex = { id: crypto.randomUUID(), kind, minutes: mins, reason, at: received, received_at: received, status: 'APPROVED', decided_by: 'automatic (takes hours away only)', decided_at: received };
    a.exceptions.push(ex);
    logEvent('timeclock.offline', `${nameOf(a.personnel_id)}: ${KIND[kind].toUpperCase()} — RECORDED AT ${hhmm(at)}, ARRIVED ${mins} MIN LATER`, { personnel_id: a.personnel_id });
    return ex;
  }

  /* ---- ad-hoc clock-in ---- */
  function adHocType() {
    let t = db.shift_types.find((x) => x.key === 'AD_HOC');
    if (!t) { t = { id: nextId('shift_types'), key: 'AD_HOC', name: 'Ad hoc', color: '#64748b', active: false, created_at: new Date().toISOString() }; db.shift_types.push(t); }
    return t;
  }
  const openFor = (pid) => db.shift_assignments.find((x) => x.personnel_id === pid && x.clocked_in_at && !x.clocked_out_at && x.status !== 'REMOVED');
  /** Also behind POST /api/shifts/adhoc (server.js), the same thing. */
  function clockInAdHoc(body, user, { at = null } = {}) {
    const pid = isControlRole(user.role) && body.personnel_id ? Number(body.personnel_id) : user.personnel_id;
    const person = db.personnel.find((p) => p.id === pid);
    if (!person) throw httpError(400, isControlRole(user.role) ? 'choose who to clock in' : 'this login is not linked to a member of staff');
    if (openFor(pid)) throw httpError(409, `${person.name} is already clocked in`);
    assertDeployable(person, body, user, 'AD HOC CLOCK-IN');
    const site = db.sites.find((x) => x.id === Number(body.site_id));
    if (!site || !siteVisibleTo(site.id, user)) throw httpError(400, 'choose the site you are working at');
    const reason = String(body.reason || '').trim().slice(0, 300);
    // Pressed with no signal (offline-time.js): starts when they pressed it.
    // Already waits for control's approval as UNSCHEDULED, so no extra flag.
    const now = at ? new Date(at) : new Date();
    const s = {
      id: nextId('shifts'), site_id: site.id, shift_type_id: adHocType().id, ad_hoc: true, // detail.adhoc: the rota's "AD HOC" badge
      starts_at: now.toISOString(), ends_at: new Date(now.getTime() + 12 * 3600000).toISOString(), // set at clock-out
      break_minutes: 0, required_headcount: 1, status: 'IN_PROGRESS', pay_rate: null, bill_rate: null,
      uniform_ppe: '', briefing: '', notes: reason ? `Ad hoc — ${reason}` : 'Ad hoc shift — not pre-rostered.', detail: { adhoc: true }, template_id: null, revision: 0, created_by: user.id, created_at: now.toISOString(),
    };
    const a = {
      id: nextId('shift_assignments'), shift_id: s.id, personnel_id: pid, role_on_shift: '', is_duty_supervisor: false,
      status: 'CONFIRMED', confirmed_at: now.toISOString(), attendance: null, clocked_in_at: null, clocked_out_at: null,
      created_by: user.id, created_at: now.toISOString(), updated_at: now.toISOString(),
    };
    if (!reason && !onBehalf(a, user)) throw needReason('You have no shift booked now');
    attendance.checkClockIn(a, s, body || {}, user); // on-site check, as for a rostered shift
    a.clocked_in_at = now.toISOString();
    db.shifts.push(s); db.shift_assignments.push(a);
    addException(a, 'UNSCHEDULED', 0, reason, user);
    const pub = publicShift(s);
    pub.my = pub.assignments.find((x) => x.personnel_id === pid) || null;
    broadcast('shift.created', pub, { personnelIds: [pid] });
    logEvent('shift.adhoc_created', `${person.name} CLOCKED IN AD HOC AT ${site.name.toUpperCase()}`, { shift_id: s.id, personnel_id: pid });
    flushNow();
    return { __status: 201, __body: pub };
  }
  route('POST', '/api/timeclock/clock-in', ['FIELD_USER', ...CONTROL], ({ body, user, req }) => clockInAdHoc(body, user, { at: occurredAt(req) }));

  /* ---- approvals ---- */
  function exceptionRows(filter) {
    const rows = [];
    for (const a of db.shift_assignments) {
      for (const ex of a.exceptions || []) {
        if (!filter(ex, a)) continue;
        const s = db.shifts.find((x) => x.id === a.shift_id); if (!s) continue;
        const site = s.site_id ? db.sites.find((x) => x.id === s.site_id) : null;
        rows.push({
          ...ex, label: KIND[ex.kind], assignment_id: a.id, shift_id: s.id, personnel_id: a.personnel_id, name: nameOf(a.personnel_id), site_name: site ? site.name : null,
          ad_hoc: Boolean(s.ad_hoc), starts_at: s.starts_at, ends_at: s.ends_at, clocked_in_at: a.clocked_in_at, clocked_out_at: a.clocked_out_at,
          worked_min: attendance.worked(a).worked_min,
        });
      }
    }
    return rows.sort((x, y) => y.at.localeCompare(x.at));
  }
  route('GET', '/api/timeclock/pending', CONTROL, () => exceptionRows((ex) => ex.status === 'PENDING'));
  route('POST', '/api/timeclock/exceptions/:assignmentId/:exId', CONTROL, ({ params, body, user }) => {
    const a = findAssignment(params.assignmentId);
    const s = findShift(a.shift_id);
    const ex = (a.exceptions || []).find((x) => x.id === params.exId);
    if (!ex) throw httpError(404, 'not found');
    if (ex.status !== 'PENDING') throw httpError(409, `already ${ex.status.toLowerCase()}`);
    const approve = body.decision === 'APPROVE';
    if (!approve && body.decision !== 'REJECT') throw httpError(400, 'approve or reject');
    Object.assign(ex, { status: approve ? 'APPROVED' : 'REJECTED', decided_by: user.display_name, decided_at: new Date().toISOString(), decision_note: String(body.note || '').slice(0, 300) });
    let effect = '';
    if (!approve) {
      const edit = (to) => { (a.time_edits = a.time_edits || []).push({ at: ex.decided_at, by: user.display_name, reason: `${KIND[ex.kind]} not approved`, from: { in: a.clocked_in_at, out: a.clocked_out_at }, to }); };
      if (ex.kind === 'EARLY_IN' && a.clocked_in_at && a.clocked_in_at < s.starts_at) { edit({ in: s.starts_at, out: a.clocked_out_at }); a.clocked_in_at = s.starts_at; effect = ' — counted from the rostered start'; }
      if (ex.kind === 'LATE_OUT' && a.clocked_out_at && a.clocked_out_at > s.ends_at) { edit({ in: a.clocked_in_at, out: s.ends_at }); a.clocked_out_at = s.ends_at; attendance.closeBreaks(a, s.ends_at); effect = ' — counted to the rostered finish'; }
      if (ex.kind === 'UNSCHEDULED') { a.time_rejected = true; effect = ' — no hours counted'; }
      if (ex.kind === 'OFFLINE_IN' && ex.received_at && a.clocked_in_at && a.clocked_in_at < ex.received_at) {
        const to = a.clocked_out_at && a.clocked_out_at < ex.received_at ? a.clocked_out_at : ex.received_at;
        edit({ in: to, out: a.clocked_out_at }); a.clocked_in_at = to;
        for (const b of a.breaks || []) { if (b.start < to) b.start = to; if (b.end && b.end < to) b.end = to; }
        effect = ' — counted from when it reached CCCS';
      }
    }
    a.updated_at = new Date().toISOString();
    broadcast('shift.updated', publicShift(s), { personnelIds: [a.personnel_id] });
    logEvent('timeclock.decided', `${user.display_name} ${approve ? 'APPROVED' : 'REJECTED'} ${KIND[ex.kind].toUpperCase()} FOR ${nameOf(a.personnel_id)}${effect.toUpperCase()}`, { personnel_id: a.personnel_id, shift_id: s.id });
    flushNow();
    return { ...exceptionRows((x) => x.id === ex.id)[0], effect: effect.replace(/^ — /, '') };
  });

  /* ---- the board: who is on now, who is due, and the timesheet ---- */
  const row = (a) => {
    const s = db.shifts.find((x) => x.id === a.shift_id); if (!s) return null;
    const site = s.site_id ? db.sites.find((x) => x.id === s.site_id) : null;
    const w = attendance.worked(a);
    const ex = a.exceptions || [];
    return {
      assignment_id: a.id, shift_id: s.id, personnel_id: a.personnel_id, name: nameOf(a.personnel_id), site_id: s.site_id, site_name: site ? site.name : null,
      ad_hoc: Boolean(s.ad_hoc), starts_at: s.starts_at, ends_at: s.ends_at, clocked_in_at: a.clocked_in_at || null, clocked_out_at: a.clocked_out_at || null,
      on_break: (a.breaks || []).some((b) => !b.end), worked_min: w.worked_min, break_min: w.break_min,
      auto_clocked_out: Boolean(a.auto_clocked_out), needs_review: Boolean(a.clock_out_needs_review), rejected: Boolean(a.time_rejected),
      approval: ex.some((x) => x.status === 'PENDING') ? 'PENDING' : ex.some((x) => x.status === 'REJECTED') ? 'REJECTED' : ex.length ? 'APPROVED' : 'OK',
      exceptions: ex.map((x) => ({ ...x, label: KIND[x.kind] })), edits: (a.time_edits || []).length,
    };
  };
  route('GET', '/api/timeclock/now', CONTROL, ({ user }) => {
    const now = Date.now();
    const visible = (r) => r && (!r.site_id || siteVisibleTo(r.site_id, user));
    const on = db.shift_assignments.filter((a) => a.status !== 'REMOVED' && a.clocked_in_at && !a.clocked_out_at).map(row).filter(visible);
    const due = db.shift_assignments.filter((a) => ['ASSIGNED', 'CONFIRMED'].includes(a.status) && !a.clocked_in_at && a.attendance !== 'NO_SHOW').map((a) => {
      const s = db.shifts.find((x) => x.id === a.shift_id);
      return s && ['PUBLISHED', 'IN_PROGRESS'].includes(s.status) && Date.parse(s.starts_at) - 3600000 <= now && Date.parse(s.ends_at) > now ? row(a) : null;
    }).filter(visible).map((r) => ({ ...r, late_min: Math.max(0, minutes(now - Date.parse(r.starts_at))) }));
    return { on, due, pending: exceptionRows((ex) => ex.status === 'PENDING').length, tolerance_min: TOLERANCE_MIN };
  });
  route('GET', '/api/timeclock/timesheet', CONTROL, ({ query, user }) => {
    const from = String(query.get('from') || ''), to = String(query.get('to') || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw httpError(400, 'from and to dates required');
    const t0 = Date.parse(`${from}T00:00:00Z`), t1 = Date.parse(`${to}T00:00:00Z`) + 86400000;
    const pid = query.get('personnel_id') ? Number(query.get('personnel_id')) : null;
    const clocked = db.shift_assignments.filter((a) => a.clocked_in_at && Date.parse(a.clocked_in_at) >= t0 && Date.parse(a.clocked_in_at) < t1 && (!pid || a.personnel_id === pid));
    // Rostered for a shift in this period, never clocked in at all, and
    // the shift has already ended — invisible everywhere else (not "now"
    // once it's over, no clocked_in_at to anchor a row on here) unless
    // surfaced explicitly. NO_SHOW is excluded: that's already a deliberate
    // "did not attend" record, not a gap waiting to be backfilled.
    const now = Date.now();
    const missed = db.shift_assignments.filter((a) => !a.clocked_in_at && ['ASSIGNED', 'CONFIRMED'].includes(a.status) && a.attendance !== 'NO_SHOW' && (!pid || a.personnel_id === pid))
      .filter((a) => { const s = db.shifts.find((x) => x.id === a.shift_id); return s && Date.parse(s.starts_at) >= t0 && Date.parse(s.starts_at) < t1 && Date.parse(s.ends_at) < now; });
    return [...clocked, ...missed].map(row).filter((r) => r && (!r.site_id || siteVisibleTo(r.site_id, user)))
      .sort((x, y) => (x.clocked_in_at || x.starts_at).localeCompare(y.clocked_in_at || y.starts_at));
  });
  /** Officer's own: the sites they can clock in at with no shift. */
  route('GET', '/api/timeclock/sites', ['FIELD_USER', ...CONTROL], ({ user }) => db.sites.filter((s) => s.active !== false && siteVisibleTo(s.id, user)).map((s) => ({ id: s.id, name: s.name })));

  /* ---- an ad-hoc shift that should have been the rostered one ----
   * Someone clocks in "ad hoc" when they were actually on the rota (user
   * error). The ad-hoc shift has the AD_HOC type, so no contract line bills
   * it. This moves the clock record — times, breaks, the on-site location
   * check and its presence state — onto their rostered assignment at the
   * same site, then deletes the ad-hoc shift. GET shows what would happen;
   * POST does it. Admin only, like deleting a shift. */
  const KEEP_ON_TARGET = new Set(['id', 'shift_id', 'personnel_id', 'role_on_shift', 'is_duty_supervisor', 'status', 'confirmed_at', 'created_by', 'created_at',
    'pay_override', 'exceptions', 'time_edits', 'time_rejected', 'updated_at']);
  function adHocSource(id, user) {
    const a = findAssignment(id);
    const s = findShift(a.shift_id);
    if (!s.ad_hoc) throw httpError(409, 'this is already a rostered shift');
    if (!a.clocked_in_at) throw httpError(409, 'nothing clocked on this ad-hoc shift');
    if (s.site_id && !siteVisibleTo(s.site_id, user)) throw httpError(404, 'not found');
    return { a, s };
  }
  function rotaMatches(a, s) {
    const inAt = Date.parse(a.clocked_in_at), outAt = a.clocked_out_at ? Date.parse(a.clocked_out_at) : Date.now();
    const lo = inAt - 4 * 3600000, hi = outAt + 4 * 3600000;
    return db.shifts.filter((t) => !t.ad_hoc && t.id !== s.id && t.site_id === s.site_id && t.status !== 'CANCELLED'
      && Date.parse(t.starts_at) < hi && Date.parse(t.ends_at) > lo)
      .map((t) => {
        const mine = db.shift_assignments.find((x) => x.shift_id === t.id && x.personnel_id === a.personnel_id && x.status !== 'REMOVED');
        const filled = db.shift_assignments.filter((x) => x.shift_id === t.id && x.status !== 'REMOVED').length;
        const type = db.shift_types.find((x) => x.id === t.shift_type_id);
        const blocked = mine && mine.clocked_in_at ? `${nameOf(a.personnel_id)} already has clock times on this shift` : null;
        return {
          shift_id: t.id, starts_at: t.starts_at, ends_at: t.ends_at, status: t.status, shift_type: type ? type.name : null,
          assigned: Boolean(mine), assignment_id: mine ? mine.id : null, filled, required_headcount: t.required_headcount || 1,
          others: db.shift_assignments.filter((x) => x.shift_id === t.id && x.status !== 'REMOVED' && x.personnel_id !== a.personnel_id).map((x) => nameOf(x.personnel_id)),
          blocked, warning: t.status === 'DRAFT' ? 'this shift is still a draft, so it won\'t be invoiced until it is published' : null,
          distance_min: Math.round(Math.abs(Date.parse(t.starts_at) - inAt) / 60000),
        };
      })
      .sort((x, y) => (y.assigned - x.assigned) || (x.distance_min - y.distance_min));
  }
  route('GET', '/api/timeclock/adhoc/:id/rota-matches', ADMIN, ({ params, user }) => {
    const { a, s } = adHocSource(params.id, user);
    const site = s.site_id ? db.sites.find((x) => x.id === s.site_id) : null;
    const w = attendance.worked(a);
    return {
      assignment_id: a.id, shift_id: s.id, name: nameOf(a.personnel_id), site_name: site ? site.name : null,
      clocked_in_at: a.clocked_in_at, clocked_out_at: a.clocked_out_at || null, worked_min: w.worked_min, break_min: w.break_min,
      location_checked: Boolean(a.clock_in_location), location: a.clock_in_location || null, clock_in_override: a.clock_in_override || null,
      matches: rotaMatches(a, s),
    };
  });
  route('POST', '/api/timeclock/adhoc/:id/move-to-rota', ADMIN, ({ params, body, user }) => {
    const { a, s } = adHocSource(params.id, user);
    const m = rotaMatches(a, s).find((x) => x.shift_id === Number(body && body.shift_id));
    if (!m) throw httpError(400, 'choose a rostered shift at the same site and time');
    if (m.blocked) throw httpError(409, m.blocked);
    const t = findShift(m.shift_id);
    const nowIso = new Date().toISOString();
    let ta = m.assignment_id ? db.shift_assignments.find((x) => x.id === m.assignment_id) : null;
    if (!ta) {
      ta = {
        id: nextId('shift_assignments'), shift_id: t.id, personnel_id: a.personnel_id, role_on_shift: '', is_duty_supervisor: false,
        status: 'CONFIRMED', confirmed_at: nowIso, attendance: null, clocked_in_at: null, clocked_out_at: null, created_by: user.id, created_at: nowIso, updated_at: nowIso,
      };
      db.shift_assignments.push(ta);
    }
    const from = { in: ta.clocked_in_at || null, out: ta.clocked_out_at || null };
    for (const [k, v] of Object.entries(a)) if (!KEEP_ON_TARGET.has(k)) ta[k] = v;
    // "No shift booked" no longer applies, and nor does a rejection of it.
    const carried = (a.exceptions || []).filter((x) => x.kind !== 'UNSCHEDULED');
    if (carried.length) ta.exceptions = [...(ta.exceptions || []), ...carried];
    ta.time_rejected = false;
    const reason = String((body && body.reason) || '').trim().slice(0, 300);
    ta.time_edits = [...(ta.time_edits || []), ...(a.time_edits || []), {
      at: nowIso, by: user.display_name, reason: `Moved from ad-hoc shift #${s.id}${reason ? ` — ${reason}` : ''}`, from, to: { in: ta.clocked_in_at, out: ta.clocked_out_at || null },
    }];
    if (['ASSIGNED'].includes(ta.status)) { ta.status = 'CONFIRMED'; ta.confirmed_at = ta.confirmed_at || nowIso; }
    ta.updated_at = nowIso;
    if (t.status === 'PUBLISHED') t.status = ta.clocked_out_at && Date.parse(t.ends_at) <= Date.now() ? 'COMPLETED' : 'IN_PROGRESS';
    t.revision = (t.revision || 0) + 1;

    db.shift_assignments = db.shift_assignments.filter((x) => x.id !== a.id);
    const left = db.shift_assignments.some((x) => x.shift_id === s.id);
    if (!left) db.shifts = db.shifts.filter((x) => x.id !== s.id);
    broadcast(left ? 'shift.updated' : 'shift.deleted', left ? publicShift(s) : { id: s.id }, { personnelIds: [a.personnel_id] });
    broadcast('shift.updated', publicShift(t), { personnelIds: [a.personnel_id] });
    logEvent('timeclock.adhoc_moved', `${user.display_name} MOVED ${nameOf(a.personnel_id)}'S AD-HOC CLOCK TIMES (SHIFT ${s.id}) ONTO ROSTERED SHIFT ${t.id}${reason ? ` — ${reason.toUpperCase()}` : ''}`,
      { shift_id: t.id, personnel_id: a.personnel_id });
    flushNow();
    return { moved_to: { shift_id: t.id, assignment_id: ta.id }, deleted_shift_id: left ? null : s.id, clocked_in_at: ta.clocked_in_at, clocked_out_at: ta.clocked_out_at || null };
  });

  return { check, record, recordOffline, clockInAdHoc, KIND };
};
