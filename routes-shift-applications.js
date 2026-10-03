/**
 * Shift applications — a field officer applies for a published,
 * understaffed shift; control shortlists, approves (which creates the
 * real assignment) or rejects it (with a reason). Self-service, mirroring
 * routes-leave.js's shape closely: append-only history via
 * reviewed_by/reviewed_at, a required reason on rejection, and the
 * requester can only ever withdraw their own still-open application.
 *
 * "Invite or directly assign" — the brief's other staffing path — is
 * already POST /api/shifts/:id/assignments from Increment 1. This file is
 * only the self-service apply path, not a second way to assign someone;
 * control staffs a shift directly through that existing route instead of
 * applying to their own vacancy.
 *
 * Registrar pattern, like routes-leave.js.
 */
'use strict';

const APPLICATION_STATUSES = ['APPLIED', 'SHORTLISTED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'EXPIRED'];
const OPEN_APPLICATION_STATUSES = ['APPLIED', 'SHORTLISTED'];

module.exports = function registerShiftApplicationRoutes({
  route, httpError, ALL, CONTROL, db, nextId, logEvent, broadcast,
  findShift, assignedPersonnelIds, publicShift, siteVisibleTo, isControlRole, notifyShiftEvent, buildShiftIndex,
}) {
  for (const t of ['shift_applications']) if (!Array.isArray(db[t])) db[t] = [];

  const findApplication = (id) => db.shift_applications.find((x) => x.id === Number(id)) || null;
  const publicApplication = (a) => {
    const p = db.personnel.find((x) => x.id === a.personnel_id);
    const s = db.shifts.find((x) => x.id === a.shift_id);
    const type = s && s.shift_type_id ? db.shift_types.find((t) => t.id === s.shift_type_id) : null;
    const site = s && s.site_id ? db.sites.find((x) => x.id === s.site_id) : null;
    return {
      ...a, personnel_name: p ? p.name : null,
      shift_starts_at: s ? s.starts_at : null, shift_ends_at: s ? s.ends_at : null,
      shift_type_name: type ? type.name : null, site_name: site ? site.name : null,
    };
  };

  route('GET', '/api/shifts/available', ALL, ({ user }) => {
    const now = Date.now();
    // Cheap filters (status/date/site, all plain shift fields) run before
    // publicShift() so it only ever builds the full response — assignments,
    // allocations, coverage — for shifts that already survived them, instead
    // of paying that cost for every shift in the system up front.
    const idx = buildShiftIndex();
    return db.shifts
      .filter((s) => s.status === 'PUBLISHED' && Date.parse(s.starts_at) > now && siteVisibleTo(s.site_id, user))
      .map((s) => publicShift(s, idx))
      .filter((s) => s.coverage_gap > 0)
      .filter((s) => {
        if (!user.personnel_id) return true;
        const alreadyAssigned = s.assignments.some((a) => a.personnel_id === user.personnel_id && ['ASSIGNED', 'CONFIRMED'].includes(a.status));
        const alreadyApplied = db.shift_applications.some((x) => x.shift_id === s.id && x.personnel_id === user.personnel_id && OPEN_APPLICATION_STATUSES.includes(x.status));
        return !alreadyAssigned && !alreadyApplied;
      })
      .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  });

  route('GET', '/api/shift-applications', ALL, ({ query, user }) => {
    let rows = db.shift_applications;
    if (user.role === 'FIELD_USER') rows = rows.filter((a) => a.personnel_id === user.personnel_id);
    else if (!CONTROL.includes(user.role)) throw httpError(403, 'insufficient role');
    else rows = rows.filter((a) => { const s = db.shifts.find((x) => x.id === a.shift_id); return !s || siteVisibleTo(s.site_id, user); });
    if (query.get('status')) rows = rows.filter((a) => a.status === query.get('status').toUpperCase());
    if (query.get('shift_id')) rows = rows.filter((a) => a.shift_id === Number(query.get('shift_id')));
    return rows.slice().sort((a, b) => (a.applied_at < b.applied_at ? 1 : -1)).map(publicApplication);
  });

  route('POST', '/api/shift-applications', ALL, ({ body, user }) => {
    if (user.role !== 'FIELD_USER' || !user.personnel_id) throw httpError(403, 'only a field officer applies for a shift, on their own behalf');
    const s = findShift(body.shift);
    if (s.status !== 'PUBLISHED') throw httpError(400, 'this shift is not open for applications');
    if (Date.parse(s.starts_at) <= Date.now()) throw httpError(400, 'this shift has already started');
    if (assignedPersonnelIds(s.id).length >= s.required_headcount) throw httpError(400, 'this shift is already fully staffed');
    if (assignedPersonnelIds(s.id).includes(user.personnel_id)) throw httpError(409, 'you are already on this shift');
    if (db.shift_applications.some((x) => x.shift_id === s.id && x.personnel_id === user.personnel_id && OPEN_APPLICATION_STATUSES.includes(x.status))) {
      throw httpError(409, 'you have already applied for this shift');
    }
    const a = {
      id: nextId('shift_applications'), shift_id: s.id, personnel_id: user.personnel_id, status: 'APPLIED',
      rejection_reason: null, applied_at: new Date().toISOString(), reviewed_by: null, reviewed_at: null, updated_at: new Date().toISOString(),
    };
    db.shift_applications.push(a);
    const p = db.personnel.find((x) => x.id === user.personnel_id);
    broadcast('shift_application.created', publicApplication(a), { controlOnly: true });
    logEvent('shift_application.created', `${p ? p.name : 'OFFICER'} APPLIED FOR SHIFT ${s.id}`, { shift_id: s.id, shift_application_id: a.id, personnel_id: user.personnel_id });
    return { __status: 201, __body: publicApplication(a) };
  });

  route('PATCH', '/api/shift-applications/:id', ALL, ({ params, body, user }) => {
    const a = findApplication(params.id); if (!a) throw httpError(404, 'application not found');
    const isOwn = user.role === 'FIELD_USER' && user.personnel_id === a.personnel_id;
    // Deciding someone else's application assigns them to the shift — that's
    // shift editing, admin-only now; withdrawing your own stays self-service.
    const isControl = user.role === 'SYSTEM_ADMIN';
    if (!isOwn && !isControl) throw httpError(403, 'insufficient role');
    const shiftForScope = db.shifts.find((x) => x.id === a.shift_id);
    // Still bound by the same visibility a shift list would give them —
    // 404, not 403, the same "don't confirm it exists" reasoning used
    // elsewhere for a record outside a caller's own scope.
    if (isControl && !isOwn && shiftForScope && !siteVisibleTo(shiftForScope.site_id, user)) throw httpError(404, 'application not found');

    if ('status' in body) {
      const status = String(body.status || '').toUpperCase();
      if (!APPLICATION_STATUSES.includes(status)) throw httpError(400, 'invalid status');
      if (isOwn) {
        if (status !== 'WITHDRAWN') throw httpError(403, 'you can only withdraw your own application');
        if (!OPEN_APPLICATION_STATUSES.includes(a.status)) throw httpError(409, `cannot withdraw a ${a.status.toLowerCase()} application`);
      } else {
        if (!OPEN_APPLICATION_STATUSES.includes(a.status)) throw httpError(409, `this application is already ${a.status.toLowerCase()}`);
        if (!['SHORTLISTED', 'APPROVED', 'REJECTED'].includes(status)) throw httpError(400, 'control can only shortlist, approve or reject');
        if (status === 'REJECTED' && !body.rejection_reason) throw httpError(400, 'rejection_reason required when rejecting');
      }
      if (status === 'APPROVED') {
        const s = findShift(a.shift_id);
        if (assignedPersonnelIds(s.id).length >= s.required_headcount) throw httpError(409, 'this shift is already fully staffed');
        if (assignedPersonnelIds(s.id).includes(a.personnel_id)) throw httpError(409, 'already assigned to this shift');
        db.shift_assignments.push({
          id: nextId('shift_assignments'), shift_id: s.id, personnel_id: a.personnel_id, role_on_shift: '',
          is_duty_supervisor: false, status: 'ASSIGNED', confirmed_at: null, attendance: null, clocked_in_at: null, clocked_out_at: null,
          created_by: user.id, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        });
        broadcast('shift.updated', publicShift(s), s.status === 'DRAFT' ? { controlOnly: true } : { personnelIds: [a.personnel_id] });
        if (s.status !== 'DRAFT') notifyShiftEvent('ASSIGNED', s, [a.personnel_id]);
        // Approving this one may fill the shift — anyone else still
        // waiting on a now-impossible outcome is told so, not left to
        // silently find out the shift they applied to has gone.
        if (assignedPersonnelIds(s.id).length >= s.required_headcount) {
          for (const other of db.shift_applications) {
            if (other.id !== a.id && other.shift_id === s.id && OPEN_APPLICATION_STATUSES.includes(other.status)) {
              other.status = 'EXPIRED'; other.updated_at = new Date().toISOString();
              broadcast('shift_application.updated', publicApplication(other), { controlOnly: true });
            }
          }
        }
      }
      a.status = status;
      if (isControl && ['APPROVED', 'REJECTED'].includes(status)) { a.reviewed_by = user.display_name; a.reviewed_at = new Date().toISOString(); }
      if (status === 'REJECTED' && body.rejection_reason) a.rejection_reason = String(body.rejection_reason).trim().slice(0, 1000);
      if (status === 'REJECTED') {
        const s = db.shifts.find((x) => x.id === a.shift_id);
        if (s) notifyShiftEvent('REJECTED', s, [a.personnel_id]);
      }
    }
    a.updated_at = new Date().toISOString();
    broadcast('shift_application.updated', publicApplication(a), { controlOnly: true });
    logEvent('shift_application.updated', `SHIFT APPLICATION ${a.id} → ${a.status}`, { shift_application_id: a.id, personnel_id: a.personnel_id });
    return publicApplication(a);
  });

  /** Called from server.js's own shift routes, which own the
   * cancel/delete lifecycle — a pending application has no reason to
   * keep waiting on a shift that no longer exists or will never run. */
  function expireApplicationsForShift(shiftId) {
    for (const a of db.shift_applications) {
      if (a.shift_id === shiftId && OPEN_APPLICATION_STATUSES.includes(a.status)) {
        a.status = 'EXPIRED'; a.updated_at = new Date().toISOString();
        broadcast('shift_application.updated', publicApplication(a), { controlOnly: true });
      }
    }
  }
  return { expireApplicationsForShift };
};
