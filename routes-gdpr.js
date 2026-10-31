/**
 * UK GDPR: the rest of the retention schedule, and subject access.
 *
 * server.js's RETENTION already ages out tracking, messages, the audit log,
 * jobs and handovers. This adds the people records it didn't cover, each
 * with a default chosen from the rule that sets the floor, and each
 * overridable in cccs.env (0 = keep for ever):
 *
 *   RETAIN_APPLICANTS_DAYS     183   unsuccessful or withdrawn applicants,
 *                                    from the decision (ICO: about 6 months,
 *                                    long enough to answer a discrimination
 *                                    claim). Their CV, licence scans and
 *                                    answers go with them.
 *   RETAIN_LEAVERS_DAYS       2555   a leaver's personal details, from the
 *                                    day they were marked TERMINATED.
 *                                    BS 7858 keeps the screening file for
 *                                    the employment plus 7 years. After
 *                                    that the record is anonymised, not
 *                                    deleted, so shifts, invoices and
 *                                    payslips that point at it still add up.
 *   RETAIN_TIMESHEETS_DAYS    2190   shifts and clock-in/out, from the end of
 *                                    the shift (HMRC pay records 3 years;
 *                                    6 years covers a contract claim).
 *   RETAIN_FORMS_DAYS         2190   form submissions (incident reports,
 *                                    checks) and their photos: 6 years for a
 *                                    personal injury or contract claim.
 *   RETAIN_CLIENT_REQUESTS_DAYS 730  closed client portal requests.
 *   RETAIN_EMERGENCIES_DAYS    730   resolved emergency activations and
 *                                    call-me requests, same as jobs.
 *
 * Subject access (Article 15): an admin downloads everything CCCS holds
 * about one person as one JSON file, to send within the month. Files they
 * uploaded or that were uploaded about them are listed (name, type, date)
 * and can be downloaded from their record; secrets (password and PIN
 * hashes, tokens) are never included.
 *
 * Registrar pattern, like routes-forms.js and routes-client.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const days = (name, dflt) => {
  const v = process.env[name];
  return v === undefined || v === '' ? dflt : Number(v);
};
const RETENTION_PEOPLE = {
  applicants: days('RETAIN_APPLICANTS_DAYS', 183),
  leavers: days('RETAIN_LEAVERS_DAYS', 2555),
  timesheets: days('RETAIN_TIMESHEETS_DAYS', 2190),
  forms: days('RETAIN_FORMS_DAYS', 2190),
  client_requests: days('RETAIN_CLIENT_REQUESTS_DAYS', 730),
  emergencies: days('RETAIN_EMERGENCIES_DAYS', 730),
};

// Never in an export: these prove identity or open something.
const SECRET_KEYS = new Set(['password_hash', 'welfare_pin_hash', 'welfare_checkcall_token', 'token', 'ical_token', 'calendar_token', 'access_token', 'refresh_token', 'secret']);

module.exports = function registerGdpr({ route, httpError, ADMIN, db, logEvent, UPLOADS_DIR, store, flushNow = () => {} }) {
  const cutoff = (n) => (n > 0 ? Date.now() - n * 86400000 : null);
  const older = (iso, before) => before !== null && iso && Date.parse(iso) < before;
  const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };

  /** Runs inside server.js's nightly retentionSweep(); returns counts. */
  function sweep() {
    const removed = {};
    const now = new Date().toISOString();

    // Leavers marked before terminated_at existed start their clock today.
    for (const p of db.personnel) {
      if (p.employment_status === 'TERMINATED' && !p.terminated_at) p.terminated_at = now;
    }

    let before = cutoff(RETENTION_PEOPLE.applicants);
    const goneApplicants = db.applicants.filter((a) => ['REJECTED', 'WITHDRAWN'].includes(a.status) && older(a.updated_at || a.applied_at, before));
    for (const a of goneApplicants) rmDir(path.join(UPLOADS_DIR, 'applicants', String(a.id)));
    db.applicants = db.applicants.filter((a) => !goneApplicants.includes(a));
    removed.applicants = goneApplicants.length;

    before = cutoff(RETENTION_PEOPLE.leavers);
    removed.leavers_anonymised = 0;
    for (const p of db.personnel) {
      if (p.employment_status !== 'TERMINATED' || p.anonymised_at || !older(p.terminated_at, before)) continue;
      anonymise(p);
      removed.leavers_anonymised++;
    }

    before = cutoff(RETENTION_PEOPLE.timesheets);
    const goneShifts = new Set(db.shifts.filter((s) => older(s.ends_at, before)).map((s) => s.id));
    const assignmentsBefore = db.shift_assignments.length;
    db.shift_assignments = db.shift_assignments.filter((a) => !goneShifts.has(a.shift_id));
    db.shifts = db.shifts.filter((s) => !goneShifts.has(s.id));
    removed.shifts = goneShifts.size;
    removed.shift_assignments = assignmentsBefore - db.shift_assignments.length;

    before = cutoff(RETENTION_PEOPLE.forms);
    const goneForms = db.form_submissions.filter((s) => s.status !== 'OPEN' && older(s.submitted_at, before));
    for (const s of goneForms) rmDir(path.join(UPLOADS_DIR, 'forms', String(s.id)));
    db.form_submissions = db.form_submissions.filter((s) => !goneForms.includes(s));
    removed.form_submissions = goneForms.length;

    before = cutoff(RETENTION_PEOPLE.client_requests);
    const reqBefore = db.client_requests.length;
    db.client_requests = db.client_requests.filter((r) => !(r.status === 'CLOSED' && older(r.resolved_at || r.updated_at || r.created_at, before)));
    removed.client_requests = reqBefore - db.client_requests.length;

    before = cutoff(RETENTION_PEOPLE.emergencies);
    const emBefore = db.emergency_events.length, crBefore = db.call_requests.length;
    db.emergency_events = db.emergency_events.filter((e) => !(e.state === 'RESOLVED' && older(e.resolved_at || e.activated_at, before)));
    db.call_requests = db.call_requests.filter((r) => !(r.state !== 'PENDING' && older(r.answered_at || r.cancelled_at || r.requested_at, before)));
    removed.emergency_events = emBefore - db.emergency_events.length;
    removed.call_requests = crBefore - db.call_requests.length;
    return removed;
  }

  /** What's left of a leaver: an id, an employee number and a placeholder
   * name, so rotas, invoices and payslips that point at them still work. */
  function anonymise(p) {
    const label = `Former employee ${p.employee_no || `#${p.id}`}`;
    for (const k of ['contact_phone', 'contact_email', 'notes', 'welfare_note', 'date_of_birth', 'emergency_contact', 'bank_details', 'address', 'postcode',
      'ni_number', 'dbs_certificate_no', 'dbs_certificate_type', 'dbs_update_service_id', 'dbs_last_checked_at', 'rtw_check_type', 'rtw_reference', 'rtw_expiry',
      'rtw_last_checked_at', 'sia_licence_no', 'sia_licence_expiry', 'sia_licences', 'application', 'screening', 'payroll', 'welfare_pin_hash', 'lat', 'lon', 'location_at']) {
      if (k in p) p[k] = Array.isArray(p[k]) ? [] : null;
    }
    if (p.id_photo && p.id_photo.file) { try { fs.unlinkSync(path.join(UPLOADS_DIR, 'staff-photos', p.id_photo.file)); } catch {} }
    p.id_photo = null;
    rmDir(path.join(UPLOADS_DIR, 'personnel', String(p.id)));
    p.files = [];
    db.locations = db.locations.filter((l) => l.personnel_id !== p.id);
    p.name = label;
    p.anonymised_at = new Date().toISOString();
    logEvent('retention.leaver_anonymised', `LEAVER RECORD #${p.id} ANONYMISED AFTER THE RETENTION PERIOD`, { personnel_id: p.id });
  }

  const scrub = (v) => {
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !SECRET_KEYS.has(k)).map(([k, x]) => [k, scrub(x)]));
    return v;
  };
  /** True if any field naming a person (…personnel_id, …user_id, crew and
   * additional_personnel lists, a PERSONNEL form subject) points at them. */
  function mentions(row, pid, uid) {
    if (!row || typeof row !== 'object') return false;
    for (const [k, v] of Object.entries(row)) {
      if (/(^|_)personnel_id$/.test(k) && v === pid) return true;
      if (uid && /(^|_)user_id$/.test(k) && v === uid) return true;
      if ((k === 'additional_personnel' || k === 'personnel_ids' || k === 'crew_personnel_ids') && Array.isArray(v) && v.includes(pid)) return true;
    }
    return row.subject_type === 'PERSONNEL' && Number(row.subject_id) === pid;
  }

  route('GET', '/api/personnel/:id/subject-access-export', ADMIN, ({ params, user }) => {
    const p = db.personnel.find((x) => x.id === Number(params.id));
    if (!p) throw httpError(404, 'personnel not found');
    const account = db.users.find((u) => u.id === p.user_id || u.personnel_id === p.id) || null;
    const uid = account ? account.id : null;
    const held = {};
    for (const [name, rows] of Object.entries(db)) {
      if (!Array.isArray(rows) || name === 'personnel' || name === 'users' || name === 'audit_logs') continue;
      const hits = rows.filter((r) => mentions(r, p.id, uid));
      if (hits.length) held[name] = scrub(hits);
    }
    const applicant = db.applicants.find((a) => a.hired_personnel_id === p.id);
    if (applicant && !held.applicants) held.applicants = scrub([applicant]);
    const auditFilter = (e) => e.data && (e.data.personnel_id === p.id || (uid && e.data.user_id === uid));
    const audit = store && store.queryAudit
      ? store.queryAudit({ personnelId: p.id, userId: uid, limit: 5000 })
      : db.audit_logs.filter(auditFilter);
    logEvent('gdpr.subject_access_export', `SUBJECT ACCESS EXPORT FOR PERSONNEL #${p.id} BY ${user.username}`, { personnel_id: p.id, by: user.id });
    flushNow();
    const body = {
      exported_at: new Date().toISOString(),
      exported_by: user.username,
      controller: 'Echelon CIC',
      note: 'Everything CCCS holds about this person. Files are listed under files; download them from the person\'s record. '
        + 'Before sending, remove anything that identifies a third party (for example another officer named in a report) unless they agree or it is reasonable to include it.',
      person: scrub(p),
      account: account ? scrub({ ...account }) : null,
      files: [
        ...(p.files || []).map((f) => ({ where: 'personnel file', name: f.filename, kind: f.kind, added_at: f.added_at })),
        ...(p.id_photo ? [{ where: 'ID card photo', name: p.id_photo.file, added_at: p.id_photo.uploaded_at }] : []),
      ],
      records: held,
      audit_log: scrub(audit),
    };
    const safeName = String(p.name).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || `personnel-${p.id}`;
    return {
      __body: JSON.stringify(body, null, 2),
      __headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="subject-access-${safeName}-${body.exported_at.slice(0, 10)}.json"` },
    };
  });

  route('GET', '/api/retention/people', ADMIN, () => ({ policy_days: RETENTION_PEOPLE }));

  return { sweep, anonymise, RETENTION_PEOPLE };
};
