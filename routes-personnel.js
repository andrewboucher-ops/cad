/**
 * Personnel records (add, edit, onboarding, delete, emergency contact), the
 * compliance overview, quick subcontractors, and call signs.
 *
 * staffId is set up later in server.js, so it comes in through `late`,
 * whose getter is only read when a request arrives.
 *
 * Moved out of server.js unchanged. Registrar pattern: server.js passes in
 * what this needs, at the same point in route order as before.
 */
'use strict';

module.exports = function registerPersonnel({ route, httpError, ALL, CONTROL, ADMIN, db, nextId, logEvent, broadcast, isControlRole, visibleToUser, normalizedBranchId, findCallsign, findMdt, publicMdt, publicPersonnel, personnelCompliance, siaLicencesOf, cleanBankDetails, cleanEmergencyContact, cleanPayroll, COMPLIANCE_SEVERITY, EMPLOYMENT_TYPES, DEFAULT_PAYROLL, late }) {
  route('GET', '/api/personnel', ALL, ({ user }) => {
    // A subcontractor signed in to the officer app sees themselves, not our
    // whole staff list with phone numbers: they work for another company.
    const me = user.personnel_id ? db.personnel.find((p) => p.id === user.personnel_id) : null;
    if (me && me.external_sub) return [publicPersonnel(me, user)];
    return db.personnel.filter((p) => visibleToUser(p, user)).map((p) => publicPersonnel(p, user));
  });
  /** One screen listing everyone with an expired, expiring or overdue SIA/
   * DBS/RTW check — the same personnelCompliance() flag already shown
   * inline on the personnel list, just gathered into one place instead of
   * needing to open each record to notice it. Worst-first so the most
   * urgent cases are at the top, not buried alphabetically. */
  route('GET', '/api/compliance', ADMIN, () => {
    const rows = [];
    for (const p of db.personnel) {
      if (p.employment_status === 'TERMINATED' || p.employment_type === 'SUBCONTRACTOR') continue;
      const c = personnelCompliance(p);
      const issues = Object.entries(c).filter(([, state]) => COMPLIANCE_SEVERITY[state]);
      if (!issues.length) continue;
      rows.push({
        personnel_id: p.id, name: p.name, rank: p.rank,
        worst: Math.max(...issues.map(([, state]) => COMPLIANCE_SEVERITY[state])),
        issues: issues.map(([axis, state]) => ({ axis, state })),
      });
    }
    rows.sort((a, b) => b.worst - a.worst || a.name.localeCompare(b.name));
    return rows;
  });
  route('POST', '/api/personnel', ADMIN, ({ body, user }) => {
    const name = String(body.name || '').trim();
    if (!name) throw httpError(400, 'name required');
    const employeeNo = body.employee_no ? String(body.employee_no).trim() : null;
    if (employeeNo && db.personnel.some((p) => p.employee_no === employeeNo)) throw httpError(409, 'employee number already in use');
    const cs = body.callsign_id ? findCallsign(body.callsign_id) : null;
    const veh = body.vehicle_id ? db.vehicles.find((v) => v.id === Number(body.vehicle_id)) : null;
    const employmentType = EMPLOYMENT_TYPES.includes(body.employment_type) ? body.employment_type : 'EMPLOYED';
    if (body.start_date && isNaN(Date.parse(body.start_date))) throw httpError(400, 'invalid start_date');
    const p = {
      id: nextId('personnel'), employee_no: employeeNo, name, rank: body.rank || '',
      contact_phone: body.contact_phone || '', contact_email: body.contact_email || '',
      sms_opt_out: body.sms_opt_out === true, email_opt_out: body.email_opt_out === true,
      employment_status: ['ACTIVE', 'LEAVE', 'TERMINATED'].includes(body.employment_status) ? body.employment_status : 'ACTIVE',
      employment_type: employmentType,
      annual_leave_allowance_days: employmentType === 'EMPLOYED' && body.annual_leave_allowance_days ? Number(body.annual_leave_allowance_days) : null,
      // Sensible defaults, not whatever the base POST was sent — SIA/DBS/
      // bank_details/payroll could never be set at creation either, only via
      // the follow-up PATCH. hourly_rate stays null until an admin sets it.
      payroll: employmentType === 'EMPLOYED' ? { ...DEFAULT_PAYROLL } : null,
      // Defaults to today, not null: the onboarding checklist needs an anchor
      // to measure "how long has this person been waiting on paperwork" from,
      // and a record with no explicit date almost always means they start now.
      start_date: body.start_date ? String(body.start_date).slice(0, 10) : new Date().toISOString().slice(0, 10),
      onboarding_completed_at: null, onboarding_completed_by: null,
      callsign_id: cs ? cs.id : null, user_id: null, vehicle_id: veh ? veh.id : null,
      welfare_interval_s: null, welfare_due_at: null, welfare_warned: false, welfare_note: null,
      notes: body.notes || '', branch_id: normalizedBranchId(body.branch_id),
      lat: null, lon: null, location_at: null,
    };
    late.staffId.assignNumber(p); // left blank → the next staff number (routes-staff-id.js)
    db.personnel.push(p);
    logEvent('personnel.created', `PERSONNEL ${name} ADDED`, { personnel_id: p.id });
    return { __status: 201, __body: publicPersonnel(p, user) };
  });
  /** A subcontractor put on a shift with only what control needs on the night
   * (name, company, SIA licence if known, phone) — no personnel file, staff
   * number, onboarding checklist or BS 7858 screening, all of which belong to
   * our own staff. It is still a personnel row underneath, so the shift
   * assignment, clock times, timesheet, invoice and incident log all work
   * exactly as for anyone else; payroll and leave already skip SUBCONTRACTOR.
   * An expired SIA licence still blocks rostering (assertDeployable), same as
   * for staff. "Give them a full personnel file" later is PATCH
   * /api/personnel/:id { external_sub: false }. */
  route('POST', '/api/subcontractors', ADMIN, ({ body, user }) => {
    const name = String(body.name || '').trim().slice(0, 120);
    if (!name) throw httpError(400, 'name required');
    const company = String(body.company || '').trim().slice(0, 120);
    const licenceNo = String(body.sia_licence_no || '').replace(/[\s-]/g, '').slice(0, 40);
    const expiry = body.sia_licence_expiry ? String(body.sia_licence_expiry).slice(0, 10) : null;
    if (expiry && isNaN(Date.parse(expiry))) throw httpError(400, 'invalid SIA licence expiry');
    const licenceType = String(body.sia_licence_type || '').trim().slice(0, 80) || 'Door Supervision';
    const p = {
      id: nextId('personnel'), employee_no: null, name, rank: '',
      contact_phone: String(body.contact_phone || '').trim().slice(0, 40), contact_email: String(body.contact_email || '').trim().slice(0, 160),
      sms_opt_out: false, email_opt_out: false,
      employment_status: 'ACTIVE', employment_type: 'SUBCONTRACTOR',
      external_sub: true, company,
      annual_leave_allowance_days: null, payroll: null,
      sia_licences: licenceNo ? [{ id: 1, licence_type: licenceType, licence_no: licenceNo, expiry }] : [],
      start_date: new Date().toISOString().slice(0, 10),
      onboarding_completed_at: null, onboarding_completed_by: null,
      callsign_id: null, user_id: null, vehicle_id: null,
      welfare_interval_s: null, welfare_due_at: null, welfare_warned: false, welfare_note: null,
      notes: String(body.notes || '').slice(0, 2000), branch_id: normalizedBranchId(body.branch_id),
      lat: null, lon: null, location_at: null,
      created_by: user.id, created_at: new Date().toISOString(),
    };
    db.personnel.push(p);
    logEvent('personnel.subcontractor_added', `SUBCONTRACTOR ${name}${company ? ` (${company})` : ''} ADDED BY ${user.username} — NO PERSONNEL FILE`, { personnel_id: p.id });
    return { __status: 201, __body: publicPersonnel(p, user) };
  });
  route('PATCH', '/api/personnel/:id', ADMIN, ({ params, body, user }) => {
    const p = db.personnel.find((x) => x.id === Number(params.id)); if (!p) throw httpError(404, 'personnel not found');
    if ('name' in body) { const name = String(body.name || '').trim(); if (!name) throw httpError(400, 'name required'); p.name = name; }
    if ('employee_no' in body) {
      const employeeNo = body.employee_no ? String(body.employee_no).trim() : null;
      if (employeeNo && db.personnel.some((x) => x.id !== p.id && x.employee_no === employeeNo)) throw httpError(409, 'employee number already in use');
      // Blank means "no change": a staff number, once given, is on their ID
      // card and payroll — the admin form's save sends the field blank on a
      // new record straight after the number was assigned.
      if (employeeNo) p.employee_no = employeeNo;
    }
    if ('rank' in body) p.rank = body.rank || '';
    if ('contact_phone' in body) p.contact_phone = body.contact_phone || '';
    if ('contact_email' in body) p.contact_email = body.contact_email || '';
    if ('sms_opt_out' in body) p.sms_opt_out = body.sms_opt_out === true;
    if ('email_opt_out' in body) p.email_opt_out = body.email_opt_out === true;
    if ('employment_status' in body) {
      if (!['ACTIVE', 'LEAVE', 'TERMINATED'].includes(body.employment_status)) throw httpError(400, 'invalid employment_status');
      // The leaver retention clock (routes-gdpr.js) runs from this date.
      if (body.employment_status === 'TERMINATED' && p.employment_status !== 'TERMINATED') p.terminated_at = new Date().toISOString();
      if (body.employment_status !== 'TERMINATED') p.terminated_at = null;
      p.employment_status = body.employment_status;
    }
    if ('start_date' in body) {
      if (body.start_date && isNaN(Date.parse(body.start_date))) throw httpError(400, 'invalid start_date');
      p.start_date = body.start_date ? String(body.start_date).slice(0, 10) : null;
    }
    if ('callsign_id' in body) { const cs = body.callsign_id ? findCallsign(body.callsign_id) : null; p.callsign_id = cs ? cs.id : null; }
    if ('vehicle_id' in body) { const veh = body.vehicle_id ? db.vehicles.find((v) => v.id === Number(body.vehicle_id)) : null; p.vehicle_id = veh ? veh.id : null; }
    if ('branch_id' in body) p.branch_id = normalizedBranchId(body.branch_id);
    // Line management: stable and HR-owned, the fallback when no duty
    // supervisor is rostered (see routes-contact.js supervisorFor). Refused
    // rather than silently dropped when it points nowhere, because a console
    // "call supervisor" button resolving to nobody is worth knowing about now,
    // not at 03:00.
    if ('supervisor_id' in body) {
      if (body.supervisor_id === null || body.supervisor_id === '') p.supervisor_id = null;
      else {
        const sup = db.personnel.find((x) => x.id === Number(body.supervisor_id));
        if (!sup) throw httpError(400, 'line manager not found');
        if (sup.id === p.id) throw httpError(400, 'a person cannot be their own line manager');
        p.supervisor_id = sup.id;
      }
    }
    if ('sia_licence_no' in body) p.sia_licence_no = body.sia_licence_no ? String(body.sia_licence_no).trim() : null;
    if ('sia_licence_expiry' in body) {
      if (body.sia_licence_expiry && isNaN(Date.parse(body.sia_licence_expiry))) throw httpError(400, 'invalid sia_licence_expiry');
      p.sia_licence_expiry = body.sia_licence_expiry || null;
    }
    if ('dbs_certificate_no' in body) p.dbs_certificate_no = body.dbs_certificate_no ? String(body.dbs_certificate_no).trim() : null;
    if ('dbs_certificate_type' in body) {
      if (body.dbs_certificate_type && !['STANDARD', 'ENHANCED'].includes(body.dbs_certificate_type)) throw httpError(400, 'invalid dbs_certificate_type');
      p.dbs_certificate_type = body.dbs_certificate_type || null;
    }
    if ('dbs_update_service_id' in body) p.dbs_update_service_id = body.dbs_update_service_id ? String(body.dbs_update_service_id).trim() : null;
    // Set explicitly, not auto-stamped by touching the other DBS fields — the
    // whole point is recording WHEN a human actually performed the manual
    // Update Service check, which does not happen just because someone typed
    // in a certificate number.
    if ('dbs_checked_now' in body && body.dbs_checked_now) p.dbs_last_checked_at = new Date().toISOString();
    if ('rtw_check_type' in body) {
      if (body.rtw_check_type && !['MANUAL', 'ONLINE'].includes(body.rtw_check_type)) throw httpError(400, 'invalid rtw_check_type');
      p.rtw_check_type = body.rtw_check_type || null;
    }
    if ('rtw_reference' in body) p.rtw_reference = body.rtw_reference ? String(body.rtw_reference).trim() : null;
    if ('rtw_expiry' in body) p.rtw_expiry = body.rtw_expiry || null;
    // Same reasoning as dbs_checked_now — a deliberate "I checked this" stamp,
    // not inferred from merely having typed a reference in.
    if ('rtw_checked_now' in body && body.rtw_checked_now) p.rtw_last_checked_at = new Date().toISOString();
    // Several SIA licences are normal — Door Supervision and CCTV together is
    // the common case this was added for. The old single sia_licence_no/
    // sia_licence_expiry fields are left exactly as they were (untouched,
    // never cleared by this) — siaLicencesOf() only falls back to them for a
    // record that has never been saved with a licences array at all.
    if ('sia_licences' in body) {
      if (!Array.isArray(body.sia_licences)) throw httpError(400, 'sia_licences must be an array');
      if (body.sia_licences.length > 8) throw httpError(400, 'too many SIA licences');
      p.sia_licences = body.sia_licences.map((l, i) => {
        const licence_type = String((l && l.licence_type) || '').trim().slice(0, 80);
        if (!licence_type) throw httpError(400, `licence ${i + 1}: type required`);
        const licence_no = String((l && l.licence_no) || '').trim().slice(0, 40);
        if (!licence_no) throw httpError(400, `licence ${i + 1}: licence number required`);
        const expiry = l && l.expiry ? String(l.expiry).slice(0, 10) : null;
        if (expiry && isNaN(Date.parse(expiry))) throw httpError(400, `licence ${i + 1}: invalid expiry date`);
        // "Verified on the SIA register" (routes-staff-id.js) stays with the
        // same licence across a re-save; a changed number or expiry needs
        // checking again.
        const was = siaLicencesOf(p).find((x) => x.licence_no === licence_no && x.licence_type === licence_type && (x.expiry || null) === expiry);
        return { id: i + 1, licence_type, licence_no, expiry, verified_at: (was && was.verified_at) || null, verified_by: (was && was.verified_by) || null };
      });
    }
    // Next of kin — self-editable too, via PATCH /api/personnel/:id/emergency-
    // contact below; this admin route can set it as well (e.g. HR entering it
    // from a paper form on the person's behalf).
    if ('emergency_contact' in body) p.emergency_contact = cleanEmergencyContact(body.emergency_contact);
    // Payroll destination — admin-only to set, deliberately with no self-
    // service write path: a staff member changing their own bank details
    // unsupervised is exactly the fraud pattern (a compromised account
    // redirecting its own pay) a real HR process checks before acting on.
    if ('bank_details' in body) p.bank_details = cleanBankDetails(body.bank_details);
    // Needed to run the welfare check-call (the PBX IVR asks for it to confirm
    // it's really reaching the right person) — same fraud-prevention reasoning
    // as bank_details above: no self-service write path, admin-set only.
    if ('date_of_birth' in body) {
      if (body.date_of_birth && isNaN(Date.parse(body.date_of_birth))) throw httpError(400, 'invalid date_of_birth');
      p.date_of_birth = body.date_of_birth ? String(body.date_of_birth).slice(0, 10) : null;
    }
    if ('notes' in body) p.notes = body.notes || '';
    if ('company' in body) p.company = String(body.company || '').trim().slice(0, 120);
    // Giving a quick-added subcontractor a full personnel file: from here on
    // they are on the onboarding checklist, screening and staff numbering like
    // anyone else. One way only — a file, once started, is not hidden again.
    if (body.external_sub === false && p.external_sub) {
      p.external_sub = false;
      late.staffId.assignNumber(p);
      logEvent('personnel.subcontractor_promoted', `SUBCONTRACTOR ${p.name} GIVEN A FULL PERSONNEL FILE BY ${user.username}`, { personnel_id: p.id });
    }
    // Both fields are validated against the FULL intended result before either
    // is written — a request that sets both at once (e.g. SUBCONTRACTOR + an
    // allowance) must be rejected without mutating employment_type first and
    // leaving the record in a state the request itself never asked for.
    if ('employment_type' in body && !EMPLOYMENT_TYPES.includes(body.employment_type)) throw httpError(400, 'invalid employment_type');
    if ('annual_leave_allowance_days' in body && body.annual_leave_allowance_days !== null
      && (!Number.isFinite(Number(body.annual_leave_allowance_days)) || Number(body.annual_leave_allowance_days) < 0)) {
      throw httpError(400, 'annual_leave_allowance_days must be a non-negative number, or null');
    }
    const nextEmploymentType = 'employment_type' in body ? body.employment_type : (p.employment_type || 'EMPLOYED');
    if ('annual_leave_allowance_days' in body && nextEmploymentType !== 'EMPLOYED' && body.annual_leave_allowance_days != null) {
      throw httpError(400, 'only an employed person can have a leave allowance');
    }
    if ('employment_type' in body) {
      p.employment_type = body.employment_type;
      // Leave entitlement is an EMPLOYED concept — a subcontractor invoices
      // for their own time and was never accruing it, so switching someone
      // to SUBCONTRACTOR clears any allowance on file rather than leaving a
      // stale number that no longer means anything.
      if (body.employment_type !== 'EMPLOYED' && !('annual_leave_allowance_days' in body)) p.annual_leave_allowance_days = null;
      // Same reasoning, same pattern, for payroll: a subcontractor invoices
      // for their own time and was never in a payroll run in the first place.
      if (body.employment_type !== 'EMPLOYED' && !('payroll' in body)) p.payroll = null;
    }
    if ('annual_leave_allowance_days' in body) {
      p.annual_leave_allowance_days = body.annual_leave_allowance_days == null ? null : Number(body.annual_leave_allowance_days);
    }
    // Payroll setup — tax code, NI category, pension, pay rate/basis. Only
    // ever lands via this PATCH, never the base POST (same as SIA/DBS/bank
    // details — "POST only accepts the base fields" below). Validated as a
    // whole against the FULL intended employment_type, same ordering
    // discipline as annual_leave_allowance_days just above.
    if ('payroll' in body) {
      if (nextEmploymentType !== 'EMPLOYED' && body.payroll) throw httpError(400, 'only an employed person can have payroll settings');
      p.payroll = nextEmploymentType === 'EMPLOYED' ? cleanPayroll(body.payroll, p.payroll) : null;
    }
    logEvent('personnel.updated', `PERSONNEL ${p.name} UPDATED`, { personnel_id: p.id });
    return publicPersonnel(p, user);
  });
  /** Marking onboarding complete by hand is for the real exceptions the fixed
   * checklist can't anticipate (a control-room-only role with no SIA licence
   * requirement, a TUPE transfer whose paperwork lives with a previous
   * employer) — it overrides onboardingStatusForPerson()'s own computation
   * regardless of what's still outstanding, which is exactly the point, so
   * it's logged with who and, optionally, why. Reopening clears the override;
   * it does not undo anything the checklist items themselves represent. */
  route('POST', '/api/personnel/:id/onboarding-complete', ADMIN, ({ params, body, user }) => {
    const p = db.personnel.find((x) => x.id === Number(params.id)); if (!p) throw httpError(404, 'personnel not found');
    if (p.onboarding_completed_at) throw httpError(409, 'already marked complete');
    p.onboarding_completed_at = new Date().toISOString();
    p.onboarding_completed_by = user.display_name;
    const note = String((body && body.note) || '').trim().slice(0, 300);
    logEvent('personnel.onboarding_completed', `ONBOARDING MARKED COMPLETE FOR ${p.name} BY ${user.display_name}${note ? ` — ${note}` : ''}`, { personnel_id: p.id });
    return publicPersonnel(p, user);
  });
  route('DELETE', '/api/personnel/:id/onboarding-complete', ADMIN, ({ params, user }) => {
    const p = db.personnel.find((x) => x.id === Number(params.id)); if (!p) throw httpError(404, 'personnel not found');
    if (!p.onboarding_completed_at) throw httpError(409, 'not marked complete');
    p.onboarding_completed_at = null; p.onboarding_completed_by = null;
    logEvent('personnel.onboarding_reopened', `ONBOARDING REOPENED FOR ${p.name} BY ${user.display_name}`, { personnel_id: p.id });
    return publicPersonnel(p, user);
  });
  route('DELETE', '/api/personnel/:id', ADMIN, ({ params }) => {
    const p = db.personnel.find((x) => x.id === Number(params.id)); if (!p) throw httpError(404, 'personnel not found');
    if (p.user_id) throw httpError(409, 'an account is still linked to this person — unlink it from the account first');
    if (db.job_assignments.some((a) => a.personnel_id === p.id && db.jobs.some((j) => j.id === a.job_id && !['COMPLETED', 'CANCELLED'].includes(j.status)))) {
      throw httpError(409, 'this person is assigned to an open job — stand them down first');
    }
    if (db.site_visits.some((v) => (v.personnel_id === p.id || (v.additional_personnel || []).includes(p.id)) && !['COMPLETED', 'CANCELLED', 'MISSED'].includes(v.status))) {
      throw httpError(409, 'this person is assigned to an open site visit — stand them down first');
    }
    if (db.shift_assignments.some((a) => a.personnel_id === p.id && ['ASSIGNED', 'CONFIRMED'].includes(a.status)
      && db.shifts.some((s) => s.id === a.shift_id && ['DRAFT', 'PUBLISHED', 'IN_PROGRESS'].includes(s.status)))) {
      throw httpError(409, 'this person has an upcoming or active shift — cancel it first');
    }
    db.personnel = db.personnel.filter((x) => x.id !== p.id);
    logEvent('personnel.deleted', `PERSONNEL ${p.name} DELETED`, { personnel_id: p.id });
    return { ok: true };
  });
  /** A person keeping their own next-of-kin details current is routine
   * self-service, unlike SIA/DBS/bank details above — nothing compliance- or
   * payroll-critical hangs off it, and staff are the ones most likely to
   * actually know when it's gone stale. Gated on isControlRole + personnel_id
   * match, not `role === 'FIELD_USER'` — a role-name check here is exactly
   * the bug test/access-review.test.js caught before (a role-named check let
   * a shared MDT_USER terminal login act on any officer's own-record route;
   * the fix was always comparing personnel_id, which has no meaning for a
   * shared terminal login in the first place). */
  route('PATCH', '/api/personnel/:id/emergency-contact', ALL, ({ params, body, user }) => {
    const p = db.personnel.find((x) => x.id === Number(params.id)); if (!p) throw httpError(404, 'personnel not found');
    if (!isControlRole(user.role) && user.personnel_id !== p.id) throw httpError(403, 'not your record');
    p.emergency_contact = cleanEmergencyContact(body);
    logEvent('personnel.emergency_contact_updated', `${p.name} UPDATED THEIR EMERGENCY CONTACT`, { personnel_id: p.id });
    return publicPersonnel(p, user);
  });

  // Call signs
  route('GET', '/api/callsigns', ALL, () => db.callsigns.map((c) => ({
    ...c,
    mdts: db.mdts.filter((m) => m.callsign_id === c.id).map((m) => ({ id: m.id, mdt_code: m.mdt_code, status: m.status })),
    personnel: db.personnel.filter((p) => p.callsign_id === c.id).map((p) => ({ id: p.id, name: p.name })),
    vehicles: [...new Set(db.mdts.filter((m) => m.callsign_id === c.id && m.vehicle_id).map((m) => (db.vehicles.find((v) => v.id === m.vehicle_id) || {}).registration))],
  })));
  route('POST', '/api/callsigns', CONTROL, ({ body }) => {
    const name = String(body.name || '').toUpperCase().trim();
    if (!name) throw httpError(400, 'name required');
    if (db.callsigns.some((c) => c.name === name)) throw httpError(409, 'call sign already exists');
    const c = { id: nextId('callsigns'), name, description: body.description || '', active: true };
    db.callsigns.push(c);
    broadcast('callsign.created', c);
    logEvent('callsign.created', `CALL SIGN ${name} CREATED`);
    return { __status: 201, __body: c };
  });
  route('POST', '/api/callsigns/:id/assign', CONTROL, ({ params, body }) => {
    const cs = findCallsign(params.id); if (!cs) throw httpError(404, 'call sign not found');
    if (body.mdt) {
      const m = findMdt(body.mdt); if (!m) throw httpError(404, 'MDT not found');
      m.callsign_id = cs.id;
      broadcast('mdt.assigned', publicMdt(m));
      logEvent('assignment.mdt', `${m.mdt_code} → ${cs.name}`, { mdt_id: m.id, callsign_id: cs.id });
    }
    return { ok: true };
  });
  route('DELETE', '/api/callsigns/:id/assign', CONTROL, ({ params, body }) => {
    const cs = findCallsign(params.id); if (!cs) throw httpError(404, 'call sign not found');
    if (body.mdt) {
      const m = findMdt(body.mdt); if (!m) throw httpError(404, 'MDT not found');
      m.callsign_id = null;
      broadcast('mdt.assigned', publicMdt(m));
      logEvent('assignment.mdt_removed', `${m.mdt_code} REMOVED FROM ${cs.name}`);
    }
    return { ok: true };
  });
};
