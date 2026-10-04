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
};

module.exports = function registerTimeclock({
  route, httpError, CONTROL, db, nextId, logEvent, broadcast, attendance, publicShift, findAssignment, findShift,
  isControlRole, siteVisibleTo = () => true, flushNow = () => {},
}) {
  const crypto = require('crypto');
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
  function check(a, s, body, user, direction) {
    if (s.ad_hoc) return;
    const reason = String((body && body.reason) || '').trim().slice(0, 300);
    const now = Date.now();
    const target = Date.parse(direction === 'IN' ? s.starts_at : s.ends_at);
    const diff = minutes(now - target);
    if (Math.abs(diff) <= TOLERANCE_MIN) return;
    const kind = direction === 'IN' ? (diff < 0 ? 'EARLY_IN' : 'LATE_IN') : (diff < 0 ? 'EARLY_OUT' : 'LATE_OUT');
    if (!reason && !onBehalf(a, user)) {
      throw needReason(`You're ${direction === 'IN' ? 'clocking in' : 'clocking out'} ${span(Math.abs(diff))} ${diff < 0 ? 'before' : 'after'} the rostered ${direction === 'IN' ? 'start' : 'finish'} (${new Date(target).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })})`);
    }
    // Recorded once the clock action itself has gone through (see record()).
    return { kind, mins: Math.abs(diff), reason };
  }
  function record(a, pending, user) { if (pending) addException(a, pending.kind, pending.mins, pending.reason, user); }

  /* ---- ad-hoc clock-in ---- */
  function adHocType() {
    let t = db.shift_types.find((x) => x.key === 'AD_HOC');
    if (!t) { t = { id: nextId('shift_types'), key: 'AD_HOC', name: 'Ad hoc', color: '#64748b', active: false, created_at: new Date().toISOString() }; db.shift_types.push(t); }
    return t;
  }
  const openFor = (pid) => db.shift_assignments.find((x) => x.personnel_id === pid && x.clocked_in_at && !x.clocked_out_at && x.status !== 'REMOVED');
  /** Also behind POST /api/shifts/adhoc (server.js), the same thing. */
  function clockInAdHoc(body, user) {
    const pid = isControlRole(user.role) && body.personnel_id ? Number(body.personnel_id) : user.personnel_id;
    const person = db.personnel.find((p) => p.id === pid);
    if (!person) throw httpError(400, isControlRole(user.role) ? 'choose who to clock in' : 'this login is not linked to a member of staff');
    if (openFor(pid)) throw httpError(409, `${person.name} is already clocked in`);
    const site = db.sites.find((x) => x.id === Number(body.site_id));
    if (!site || !siteVisibleTo(site.id, user)) throw httpError(400, 'choose the site you are working at');
    const reason = String(body.reason || '').trim().slice(0, 300);
    const now = new Date();
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
  route('POST', '/api/timeclock/clock-in', ['FIELD_USER', ...CONTROL], ({ body, user }) => clockInAdHoc(body, user));

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
    return db.shift_assignments.filter((a) => a.clocked_in_at && Date.parse(a.clocked_in_at) >= t0 && Date.parse(a.clocked_in_at) < t1 && (!pid || a.personnel_id === pid))
      .map(row).filter((r) => r && (!r.site_id || siteVisibleTo(r.site_id, user))).sort((x, y) => x.clocked_in_at.localeCompare(y.clocked_in_at));
  });
  /** Officer's own: the sites they can clock in at with no shift. */
  route('GET', '/api/timeclock/sites', ['FIELD_USER', ...CONTROL], ({ user }) => db.sites.filter((s) => s.active !== false && siteVisibleTo(s.id, user)).map((s) => ({ id: s.id, name: s.name })));

  return { check, record, clockInAdHoc, KIND };
};
