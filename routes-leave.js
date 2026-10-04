/**
 * Leave management — annual/sick/unpaid/other leave requests, with a
 * running annual-leave balance, for EMPLOYED personnel only. A
 * SUBCONTRACTOR invoices for their own time under their own arrangement —
 * they were never accruing a UK-style statutory entitlement through this
 * business, so every route here refuses to create or approve a request
 * against one, the same way routes-client.js refuses a site that isn't
 * the caller's: the check is repeated at each entry point rather than
 * trusted from one place.
 *
 * Self-service, mirroring the applicant-tracking and client-request
 * pipelines already in this codebase: a FIELD_USER requests their own,
 * a control role approves/rejects, and only the requester (while still
 * PENDING) or control can touch it after that. Only APPROVED annual leave
 * counts against the balance — sick/unpaid/other are logged the same way
 * but deliberately never touch it, since they aren't annual leave. See
 * leaveBalanceForPerson()/leaveYearRange() in server.js for the balance
 * math and the deliberate calendar-year default.
 *
 * The rota shows, but never blocks on, an approved-leave conflict —
 * publicShift()'s on_leave_conflict flag, set in server.js next to
 * publicShift itself since that's where shifts already live.
 *
 * Registrar pattern, like routes-forms.js and routes-client.js.
 */
'use strict';

const LEAVE_TYPES = ['ANNUAL', 'SICK', 'UNPAID', 'OTHER'];
const LEAVE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'];

module.exports = function registerLeaveRoutes({
  route, httpError, ALL, CONTROL, db, nextId, logEvent, broadcast, visibleToUser, findPersonnel,
}) {
  for (const t of ['leave_requests']) if (!Array.isArray(db[t])) db[t] = [];

  const findRequest = (id) => db.leave_requests.find((r) => r.id === Number(id)) || null;
  const publicRequest = (r) => {
    const p = db.personnel.find((x) => x.id === r.personnel_id);
    return { ...r, personnel_name: p ? p.name : null };
  };
  /** Inclusive whole-day count — the simplest defensible default given a
   * 24/7 rostered operation has no single "normal working week" to measure
   * against. Callers may override with an explicit `days` in the body
   * (e.g. a half-day), which is why this is only ever a fallback. */
  function inclusiveDayCount(startDate, endDate) {
    return Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86400000) + 1;
  }

  route('GET', '/api/leave-requests', ALL, ({ query, user }) => {
    let rows = db.leave_requests;
    if (user.role === 'FIELD_USER') rows = rows.filter((r) => r.personnel_id === user.personnel_id);
    else if (!CONTROL.includes(user.role)) throw httpError(403, 'insufficient role');
    else rows = rows.filter((r) => { const p = db.personnel.find((x) => x.id === r.personnel_id); return !p || visibleToUser(p, user); });
    if (query.get('status')) rows = rows.filter((r) => r.status === query.get('status').toUpperCase());
    if (query.get('personnel_id')) rows = rows.filter((r) => r.personnel_id === Number(query.get('personnel_id')));
    return rows.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map(publicRequest);
  });

  route('POST', '/api/leave-requests', ALL, ({ body, user }) => {
    if (!CONTROL.includes(user.role) && user.role !== 'FIELD_USER') throw httpError(403, 'insufficient role');
    // A FIELD_USER is always forced to their own record — body.personnel
    // naming someone else must never be honoured for that role, unchanged.
    // officer.html's self-service "Request leave" never sends `personnel`
    // at all, though, and any control role (DISPATCHER, SUPERVISOR,
    // SYSTEM_ADMIN) can be rostered and use that same button — they were
    // getting "personnel required" for their own request because only
    // FIELD_USER fell back to self. Omitting `personnel` now means "me"
    // for any role; an explicit id (admin.html's own "New leave request",
    // asking on someone else's behalf) still goes through findPersonnel.
    const self = () => db.personnel.find((x) => x.id === user.personnel_id);
    const p = user.role === 'FIELD_USER' ? self() : (body.personnel != null ? findPersonnel(body.personnel) : self());
    if (!p) throw httpError(400, (user.role !== 'FIELD_USER' && body.personnel != null) ? 'personnel required' : 'this login has no personnel record');
    if ((p.employment_type || 'EMPLOYED') !== 'EMPLOYED') throw httpError(400, `${p.name} is a subcontractor — leave management does not apply`);
    const type = String(body.type || '').toUpperCase();
    if (!LEAVE_TYPES.includes(type)) throw httpError(400, `type must be one of ${LEAVE_TYPES.join(', ')}`);
    const startDate = String(body.start_date || '').slice(0, 10);
    const endDate = String(body.end_date || startDate).slice(0, 10);
    if (isNaN(Date.parse(startDate))) throw httpError(400, 'invalid start_date');
    if (isNaN(Date.parse(endDate))) throw httpError(400, 'invalid end_date');
    if (endDate < startDate) throw httpError(400, 'end_date must not be before start_date');
    const days = body.days != null && body.days !== '' ? Number(body.days) : inclusiveDayCount(startDate, endDate);
    if (!Number.isFinite(days) || days <= 0) throw httpError(400, 'days must be a positive number');
    const r = {
      id: nextId('leave_requests'), personnel_id: p.id, type, start_date: startDate, end_date: endDate, days,
      note: String(body.note || '').trim().slice(0, 1000), status: 'PENDING',
      reviewed_by: null, reviewed_at: null, rejection_reason: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), created_by: user.id,
    };
    db.leave_requests.push(r);
    broadcast('leave_request.created', publicRequest(r), { controlOnly: true });
    logEvent('leave_request.created', `${p.name} REQUESTED ${type} LEAVE ${startDate}${endDate !== startDate ? ` → ${endDate}` : ''} (${days}d)`, { leave_request_id: r.id, personnel_id: p.id });
    return { __status: 201, __body: publicRequest(r) };
  });

  route('PATCH', '/api/leave-requests/:id', ALL, ({ params, body, user }) => {
    const r = findRequest(params.id); if (!r) throw httpError(404, 'leave request not found');
    const isOwnPending = user.role === 'FIELD_USER' && user.personnel_id === r.personnel_id && r.status === 'PENDING';
    const isControl = CONTROL.includes(user.role);
    if (!isOwnPending && !isControl) throw httpError(403, 'insufficient role');

    if ('status' in body) {
      const status = String(body.status || '').toUpperCase();
      if (!LEAVE_STATUSES.includes(status)) throw httpError(400, 'invalid status');
      if (isOwnPending && status !== 'CANCELLED') throw httpError(403, 'you can only cancel your own pending request — an approval decision is control\'s to make');
      if (['APPROVED', 'REJECTED'].includes(status) && !isControl) throw httpError(403, 'insufficient role');
      if (status === 'REJECTED' && !body.rejection_reason && !r.rejection_reason) throw httpError(400, 'rejection_reason required when rejecting');
      if (status === 'REJECTED' && body.rejection_reason) r.rejection_reason = String(body.rejection_reason).trim().slice(0, 1000);
      r.status = status;
      if (isControl && ['APPROVED', 'REJECTED'].includes(status)) { r.reviewed_by = user.display_name; r.reviewed_at = new Date().toISOString(); }
    }
    if ('note' in body && isControl) r.note = String(body.note || '').trim().slice(0, 1000);
    r.updated_at = new Date().toISOString();
    broadcast('leave_request.updated', publicRequest(r), { controlOnly: true });
    logEvent('leave_request.updated', `LEAVE REQUEST ${r.id} → ${r.status}`, { leave_request_id: r.id, personnel_id: r.personnel_id });
    return publicRequest(r);
  });
};
