/**
 * Configurable forms — structured paperwork filed against a job, a patrol
 * visit, a site, a person or a vehicle: trespass advisals, parking
 * citations, vehicle inspections, patient care / first-aid reports and
 * safeguarding reports, each with hand-signature capture where the paper
 * version would need one.
 *
 * Exported as a REGISTRAR, like routes-contact.js: server.js passes in what
 * these routes need rather than this file requiring server.js back across
 * its logEvent -> broadcast -> isControlRole cycle, which would resolve to a
 * half-built exports object and fail at the first event, not at startup.
 *
 * THE ONE HARD RULE. A RESTRICTED submission (safeguarding, and by default
 * patient care) is filtered on the SERVER, in projection, before anything is
 * serialised. A report that reaches a browser and is merely not rendered has
 * already leaked. So:
 *   - every route that returns a submission, or a file from one, goes through
 *     canRead(); there is no second read path to forget;
 *   - an unreadable submission is a 404, not a 403, so its existence is not
 *     confirmed either;
 *   - nothing about a RESTRICTED submission's content, subject or form type
 *     goes into logEvent(): the event log is broadcast to EVERY connected
 *     socket, officers included, and is kept for a year;
 *   - push notifications to the people allowed to read one carry no content,
 *     because a push payload transits Google's or Apple's servers.
 *
 * WHO CAN READ WHAT.
 *   STANDARD   — control roles, and whoever submitted it.
 *   RESTRICTED — whoever submitted it, and users named in a grant for that
 *                form. Nobody else: not dispatchers, not supervisors, and not
 *                SYSTEM_ADMIN by virtue of the role. An admin can grant
 *                themselves access, and that grant is itself logged, which is
 *                the point: access to a safeguarding report is always a
 *                recorded decision about a named person, never a side effect
 *                of having a senior role.
 *
 * VISIBILITY IS SNAPSHOTTED AT SUBMISSION, and the effective visibility is
 * the stricter of that snapshot and the form's current setting. Relaxing a
 * form from RESTRICTED to STANDARD therefore never exposes reports filed
 * while it was restricted; tightening one does protect reports filed before.
 *
 * SUBMISSIONS ARE IMMUTABLE. A filed report is a record; there is no edit
 * route. The field list is snapshotted onto the submission too, so a report
 * still renders exactly as it was filled in after its form is redesigned.
 *
 * REVIEW. An admin actions a submission (APPROVED / REJECTED / NOTED, with
 * feedback): it leaves the open queue and every default list, and the
 * person who filed it is told. "Removed" means out of the queue, NOT deleted
 * — a filed report can be evidence, and it stays retrievable with
 * ?status=ACTIONED. An admin can then DELETE an actioned report outright
 * (never an open one — it must have been reviewed first); its files go with
 * it and a content-free tombstone stays in the event log, so the audit
 * trail still shows that a report existed and who removed it.
 * Actioning is a read like any other: a RESTRICTED report
 * can only be actioned by an admin who is a named reader, so the review
 * workflow cannot become a back door round the rule above.
 *
 * VEHICLE EFFECTS. A form filed against a vehicle can also change the
 * vehicle (server.js applyVehicleReport): FUEL_UP adds a fuel log and moves
 * the mileage on, DEEP_CLEAN sets the last deep-clean date, INSPECTION
 * moves the mileage on from its odometer reading. The effect reads named
 * fields, so a form with an effect must keep them (checkEffectShape) —
 * otherwise renaming a field in Admin → Forms would silently stop the
 * vehicle being updated.
 *
 * EMAIL ON SUBMISSION. An admin can list addresses to email whenever a form
 * is filed. A STANDARD form's email carries its answers and a link. A
 * RESTRICTED form's email carries a link and nothing else — not the form's
 * name, not the subject, not the filer — for the same reason the push
 * notification doesn't: the content stays where only its named readers can
 * open it. Fire-and-forget; the outcome is kept on the submission.
 *
 * THE PUBLIC APPLICATION FORM. A definition whose subject is APPLICATION is
 * the job application form on the public site (apply.html). It is filled in
 * WITHOUT a login, so it is held to a narrower shape: it is the form's only
 * subject, it must ask for full_name and email (an applicant record needs
 * both), and it may not have photo fields (anonymous image uploads are
 * storage abuse waiting to happen; a CV is handled separately). Its answers
 * are stored on the applicant record (routes-applicants.js), never in
 * form_submissions, so they inherit the applicant's control-only, branch-
 * scoped access rather than this file's rules. It is never offered to
 * officers as a report.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VISIBILITIES = ['STANDARD', 'RESTRICTED'];
const SUBJECT_TYPES = ['JOB', 'SITE_VISIT', 'SITE', 'PERSONNEL', 'VEHICLE', 'APPLICATION'];
const REVIEW_OUTCOMES = ['APPROVED', 'REJECTED', 'NOTED'];
const EFFECTS = ['FUEL_UP', 'DEEP_CLEAN', 'INSPECTION'];
/** The fields each effect reads: [id, type, required]. */
const EFFECT_FIELDS = {
  FUEL_UP: [['litres', 'number', true], ['odometer', 'number', false]],
  DEEP_CLEAN: [['cleaned_at', 'datetime', false]],
  INSPECTION: [['odometer', 'number', false]],
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIELD_TYPES = ['text', 'textarea', 'number', 'select', 'checkbox', 'date', 'datetime', 'signature', 'photo'];
const MAX_FIELDS = 60;
const MAX_FILES = 10;
const SIGNATURE_MAX_BYTES = 500e3;
const PHOTO_MAX_BYTES = 8e6;

// Magic bytes, checked rather than trusting the declared mimetype: these
// files are served back to other people's browsers.
const IMAGE_SIGNATURES = {
  'image/png': (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
};
const IMAGE_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

/**
 * The forms the business asked for, installed once on a database that has
 * none. Patient care is RESTRICTED by default as well as safeguarding: it
 * holds health information, which is special-category data under UK GDPR,
 * and a default should err towards the stricter handling. An admin can relax
 * it; relaxing is a logged decision, tightening later would be too late for
 * whatever had already been read.
 */
const DEFAULT_FORMS = [
  {
    key: 'trespass-advisal', name: 'Trespass advisal', visibility: 'STANDARD', subject_types: ['JOB', 'SITE_VISIT', 'SITE'],
    description: 'A person has been advised they are trespassing and asked to leave.',
    fields: [
      { id: 'person_name', label: 'Name of person advised', type: 'text' },
      { id: 'person_description', label: 'Description', type: 'textarea', required: true },
      { id: 'advised_at', label: 'Advised at', type: 'datetime', required: true },
      { id: 'left_site', label: 'Person left the site', type: 'checkbox' },
      { id: 'police_informed', label: 'Police informed', type: 'checkbox' },
      { id: 'police_ref', label: 'Police reference', type: 'text' },
      { id: 'narrative', label: 'What happened', type: 'textarea', required: true },
      { id: 'photo', label: 'Photo', type: 'photo' },
      { id: 'officer_signature', label: 'Officer signature', type: 'signature', required: true },
    ],
  },
  {
    key: 'parking-citation', name: 'Parking citation', visibility: 'STANDARD', subject_types: ['JOB', 'SITE_VISIT', 'SITE'],
    description: 'A vehicle parked in breach of site rules.',
    fields: [
      { id: 'registration', label: 'Registration', type: 'text', required: true },
      { id: 'make_model', label: 'Make / model / colour', type: 'text' },
      { id: 'location', label: 'Where on site', type: 'text', required: true },
      { id: 'contravention', label: 'Contravention', type: 'select', required: true, options: ['No permit displayed', 'Disabled bay without badge', 'Fire lane / access route', 'Outside marked bay', 'Overstay', 'Other'] },
      { id: 'observed_at', label: 'Observed at', type: 'datetime', required: true },
      { id: 'notice_affixed', label: 'Notice affixed to vehicle', type: 'checkbox' },
      { id: 'photo', label: 'Photo of vehicle', type: 'photo', required: true },
      { id: 'notes', label: 'Notes', type: 'textarea' },
      { id: 'officer_signature', label: 'Officer signature', type: 'signature', required: true },
    ],
  },
  {
    key: 'vehicle-inspection', name: 'Vehicle inspection', visibility: 'STANDARD', subject_types: ['VEHICLE'],
    description: 'Pre-shift walk-round check of a fleet vehicle.',
    fields: [
      { id: 'odometer', label: 'Odometer (miles)', type: 'number', required: true },
      { id: 'fuel_level', label: 'Fuel level', type: 'select', required: true, options: ['Full', '3/4', '1/2', '1/4', 'Reserve'] },
      { id: 'tyres_ok', label: 'Tyres and wheels OK', type: 'checkbox' },
      { id: 'lights_ok', label: 'Lights and indicators OK', type: 'checkbox' },
      { id: 'bodywork_ok', label: 'No new bodywork damage', type: 'checkbox' },
      { id: 'fluids_ok', label: 'Fluid levels OK', type: 'checkbox' },
      { id: 'kit_ok', label: 'First-aid kit, extinguisher and torch present', type: 'checkbox' },
      { id: 'defects', label: 'Defects found', type: 'textarea' },
      { id: 'photo', label: 'Photo of any damage', type: 'photo' },
      { id: 'driver_signature', label: 'Driver signature', type: 'signature', required: true },
    ],
  },
  {
    key: 'patient-care', name: 'Patient care / first aid report', visibility: 'RESTRICTED', subject_types: ['JOB', 'SITE_VISIT', 'SITE', 'PERSONNEL'],
    description: 'First aid given to anyone on site. Holds health information: restricted by default.',
    fields: [
      { id: 'casualty_name', label: 'Casualty name', type: 'text' },
      { id: 'casualty_age', label: 'Approximate age', type: 'number' },
      { id: 'occurred_at', label: 'Time of incident', type: 'datetime', required: true },
      { id: 'presenting_complaint', label: 'What happened / presenting complaint', type: 'textarea', required: true },
      { id: 'treatment', label: 'Treatment given', type: 'textarea', required: true },
      { id: 'ambulance_called', label: 'Ambulance called', type: 'checkbox' },
      { id: 'outcome', label: 'Outcome', type: 'select', required: true, options: ['Returned to activity', 'Went home', 'Referred to GP / pharmacy', 'Taken to hospital', 'Refused treatment', 'Other'] },
      { id: 'consent_given', label: 'Casualty consented to treatment', type: 'checkbox' },
      { id: 'first_aider_signature', label: 'First aider signature', type: 'signature', required: true },
      { id: 'casualty_signature', label: 'Casualty signature (if able)', type: 'signature' },
    ],
  },
  {
    key: 'safeguarding', name: 'Safeguarding report', visibility: 'RESTRICTED', subject_types: ['JOB', 'SITE_VISIT', 'SITE', 'PERSONNEL'],
    description: 'A concern about the safety or welfare of a child or adult at risk. Visible only to you and the named safeguarding leads.',
    fields: [
      { id: 'concern_about', label: 'Who the concern is about', type: 'textarea', required: true },
      { id: 'at_risk_group', label: 'Concern relates to', type: 'select', required: true, options: ['Child (under 18)', 'Adult at risk', 'Not sure'] },
      { id: 'observed_at', label: 'When', type: 'datetime', required: true },
      { id: 'what_happened', label: 'What you saw or were told — in their words where possible', type: 'textarea', required: true },
      { id: 'immediate_danger', label: 'Someone was in immediate danger', type: 'checkbox' },
      { id: 'action_taken', label: 'Action taken (including any 999 call)', type: 'textarea', required: true },
      { id: 'officer_signature', label: 'Officer signature', type: 'signature', required: true },
    ],
  },
];

/** Vehicle forms added after the first release, installed once each on any
 * database that lacks their key (a retired one still counts as present). */
const DEFAULT_VEHICLE_FORMS = [
  {
    key: 'vehicle-fuel-up', name: 'Vehicle fuel-up', visibility: 'STANDARD', subject_types: ['VEHICLE'], effect: 'FUEL_UP',
    description: 'Record a fill-up. Updates the vehicle\'s fuel log and mileage.',
    fields: [
      { id: 'odometer', label: 'Odometer (miles)', type: 'number', required: true },
      { id: 'litres', label: 'Litres', type: 'number', required: true },
      { id: 'cost', label: 'Cost (£)', type: 'number' },
      { id: 'fuel_type', label: 'Fuel', type: 'select', options: ['Diesel', 'Unleaded petrol', 'Super unleaded', 'AdBlue', 'Electric charge'] },
      { id: 'receipt', label: 'Receipt photo', type: 'photo' },
      { id: 'notes', label: 'Notes', type: 'textarea' },
      { id: 'driver_signature', label: 'Driver signature', type: 'signature', required: true },
    ],
  },
  {
    key: 'vehicle-deep-clean', name: 'Vehicle deep clean', visibility: 'STANDARD', subject_types: ['VEHICLE'], effect: 'DEEP_CLEAN',
    description: 'Record a full interior and exterior clean. Updates the vehicle\'s deep-clean date.',
    fields: [
      { id: 'cleaned_at', label: 'Cleaned at', type: 'datetime', required: true },
      { id: 'interior', label: 'Interior cleaned and sanitised (seats, controls, door handles)', type: 'checkbox', required: true },
      { id: 'exterior', label: 'Exterior washed', type: 'checkbox' },
      { id: 'kit_checked', label: 'Kit cleaned and restocked (first aid, PPE, torch)', type: 'checkbox' },
      { id: 'issues', label: 'Damage or issues found', type: 'textarea' },
      { id: 'photo', label: 'Photo', type: 'photo' },
      { id: 'cleaner_signature', label: 'Signature', type: 'signature', required: true },
    ],
  },
];

/** Other forms added after the first release, installed the same way. The
 * incident report is what the mobile home screen's "Incident report" button
 * opens: a general write-up of something that happened, separate from the
 * dispatched job (which may not exist — the officer found it on patrol). */
const DEFAULT_EXTRA_FORMS = [
  {
    key: 'incident-report', name: 'Incident report', visibility: 'STANDARD', subject_types: ['JOB', 'SITE_VISIT', 'SITE'],
    description: 'Anything that happened on duty that needs writing up.',
    fields: [
      { id: 'occurred_at', label: 'When it happened', type: 'datetime', required: true },
      { id: 'incident_type', label: 'Type', type: 'select', required: true, options: ['Theft', 'Criminal damage', 'Anti-social behaviour', 'Trespass', 'Assault', 'Suspicious activity', 'Fire or alarm', 'Medical', 'Health and safety', 'Other'] },
      { id: 'location', label: 'Exact location', type: 'text' },
      { id: 'description', label: 'What happened', type: 'textarea', required: true },
      { id: 'persons_involved', label: 'People involved (descriptions, names if known)', type: 'textarea' },
      { id: 'police_attended', label: 'Police attended or were called', type: 'checkbox' },
      { id: 'police_reference', label: 'Police reference', type: 'text' },
      { id: 'photo', label: 'Photo', type: 'photo' },
      { id: 'officer_signature', label: 'Officer signature', type: 'signature', required: true },
    ],
  },
  {
    // RESTRICTED by default, same reasoning as patient-care/safeguarding
    // above: this can carry a named third party's injury details and is
    // the record an SIA licence review or a claim would turn on — a
    // default should err towards the stricter handling. An admin can
    // relax it in Admin -> Forms; relaxing is a logged decision.
    key: 'use-of-force', name: 'Use of force report', visibility: 'RESTRICTED', subject_types: ['JOB', 'SITE_VISIT', 'SITE', 'PERSONNEL'],
    description: 'Any physical force used on duty, including restraint — required whenever force is used, whether or not anyone was hurt.',
    fields: [
      { id: 'occurred_at', label: 'Time force was used', type: 'datetime', required: true },
      { id: 'subject_name', label: 'Name of the person force was used against (if known)', type: 'text' },
      { id: 'subject_description', label: 'Description (if not known by name)', type: 'textarea' },
      { id: 'reason', label: 'Reason force was necessary', type: 'select', required: true, options: ['Self-defence', 'Defence of another person', 'Prevention of a crime', 'Effecting a lawful arrest or detention', 'Preventing escape', 'Other'] },
      { id: 'force_type', label: 'Type of force used', type: 'select', required: true, options: ['Verbal commands / de-escalation only', 'Physical restraint or control', 'Handcuffs or limb restraints applied', 'Strike or parry', 'Use of an issued defensive item', 'Other'] },
      { id: 'force_duration', label: 'Approximate duration force was applied', type: 'text' },
      { id: 'narrative', label: 'What happened, in sequence — what was said, what was done, and why', type: 'textarea', required: true },
      { id: 'subject_injured', label: 'The subject was injured', type: 'checkbox' },
      { id: 'subject_injury_details', label: 'Details of the subject\'s injury', type: 'textarea' },
      { id: 'officer_injured', label: 'The officer was injured', type: 'checkbox' },
      { id: 'officer_injury_details', label: 'Details of the officer\'s injury', type: 'textarea' },
      { id: 'medical_attention', label: 'Medical attention was given or requested', type: 'checkbox' },
      { id: 'arrested_detained', label: 'Subject was arrested or detained', type: 'checkbox' },
      { id: 'police_informed', label: 'Police informed', type: 'checkbox' },
      { id: 'police_reference', label: 'Police reference', type: 'text' },
      { id: 'witnesses', label: 'Witnesses (names and contact details if available)', type: 'textarea' },
      { id: 'cctv_bwv_ref', label: 'CCTV / body-worn video reference', type: 'text' },
      { id: 'supervisor_notified', label: 'A supervisor was notified at the time', type: 'checkbox' },
      { id: 'photo', label: 'Photo (e.g. scene — never an injury photo without the subject\'s consent)', type: 'photo' },
      { id: 'officer_signature', label: 'Officer signature', type: 'signature', required: true },
    ],
  },
];

/** The public job application form, installed once if no APPLICATION form
 * exists (also on a database that already has the other forms). Fully
 * editable afterwards in Admin → Forms, except that it must keep asking for
 * full_name and email. */
const DEFAULT_APPLICATION_FORM = {
  key: 'job-application', name: 'Job application', visibility: 'STANDARD', subject_types: ['APPLICATION'],
  description: 'Apply to work with us. We will be in touch about the next steps.',
  fields: [
    { id: 'full_name', label: 'Full name', type: 'text', required: true },
    { id: 'email', label: 'Email address', type: 'text', required: true },
    { id: 'phone', label: 'Phone number', type: 'text', required: true },
    { id: 'postcode', label: 'Home postcode', type: 'text', required: true },
    { id: 'role_applied_for', label: 'Role you are applying for', type: 'select', required: true, options: ['Security officer', 'Mobile patrol officer', 'Response officer', 'Control room operator', 'Other'] },
    { id: 'sia_licence', label: 'SIA licence number (if you have one)', type: 'text' },
    { id: 'right_to_work', label: 'I have the right to work in the UK', type: 'checkbox', required: true },
    { id: 'driving_licence', label: 'I hold a full UK driving licence', type: 'checkbox' },
    { id: 'availability', label: 'When can you work?', type: 'textarea' },
    { id: 'experience', label: 'Relevant experience', type: 'textarea' },
    { id: 'consent', label: 'I agree to my details being used to process this application', type: 'checkbox', required: true },
  ],
};

module.exports = function registerFormRoutes({
  route, httpError, ALL, ADMIN, db, nextId, logEvent, broadcast, isControlRole,
  assertJobAccess, assertVisitAccess, pushToUsers, UPLOADS_DIR, MIME, flushNow = () => {},
  applyVehicleReport = () => {}, reapplyVehicleReport = () => {}, sendEmail = null, publicBaseUrl = '',
  vehicleKit = null, assetEvent = () => {},
}) {
  for (const t of ['form_definitions', 'form_submissions', 'form_grants']) if (!Array.isArray(db[t])) db[t] = [];

  const formFilesDir = (submissionId) => path.join(UPLOADS_DIR, 'forms', String(submissionId));

  /* ---------------------------------------------------------------- *
   * Visibility — the only place read access is decided
   * ---------------------------------------------------------------- */

  const findDefinition = (id) => db.form_definitions.find((d) => d.id === Number(id)) || null;
  const hasGrant = (definitionId, userId) => db.form_grants.some((g) => g.definition_id === definitionId && g.user_id === userId);

  /** Stricter of the snapshot taken at submission and the form's current
   * setting — see the header for why relaxing a form never loosens the past. */
  function effectiveVisibility(sub) {
    const def = findDefinition(sub.definition_id);
    return sub.visibility === 'RESTRICTED' || (def && def.visibility === 'RESTRICTED') ? 'RESTRICTED' : 'STANDARD';
  }

  function canRead(sub, user) {
    if (sub.submitted_by_user_id === user.id) return true;
    if (effectiveVisibility(sub) === 'RESTRICTED') return hasGrant(sub.definition_id, user.id);
    return isControlRole(user.role);
  }

  /** Looks up a submission for a read. Unreadable is indistinguishable from
   * missing: a 403 would confirm a safeguarding report exists for this id. */
  function readableSubmission(id, user) {
    const sub = db.form_submissions.find((s) => s.id === Number(id));
    if (!sub || !canRead(sub, user)) throw httpError(404, 'form submission not found');
    return sub;
  }

  /** The shape a submission leaves the server in. Only ever called on a
   * submission canRead() has already passed. */
  function publicSubmission(sub) {
    const values = {};
    for (const f of sub.fields) {
      const v = sub.values[f.id];
      if (v && typeof v === 'object' && v.file_id) {
        values[f.id] = { ...v, url: `/api/form-submissions/${sub.id}/files/${v.file_id}` };
      } else values[f.id] = v === undefined ? null : v;
    }
    return {
      id: sub.id, reference: sub.reference,
      definition_id: sub.definition_id, definition_key: sub.definition_key,
      definition_name: sub.definition_name, definition_version: sub.definition_version,
      visibility: effectiveVisibility(sub),
      subject_type: sub.subject_type, subject_id: sub.subject_id, subject_label: sub.subject_label,
      fields: sub.fields, values,
      submitted_by: sub.submitted_by_name, submitted_by_user_id: sub.submitted_by_user_id,
      submitted_at: sub.submitted_at,
      status: sub.status || 'OPEN', outcome: sub.outcome || null, feedback: sub.feedback || null,
      actioned_by: sub.actioned_by || null, actioned_at: sub.actioned_at || null,
      amendments: sub.amendments || [],
      kit_check: sub.kit_check || null,
    };
  }

  /** A list entry: enough to show a row, no field values. Still only built
   * for submissions canRead() passed — a list is a read like any other. */
  const submissionSummary = (sub) => ({
    id: sub.id, reference: sub.reference, definition_id: sub.definition_id, definition_name: sub.definition_name,
    visibility: effectiveVisibility(sub), subject_type: sub.subject_type, subject_id: sub.subject_id,
    subject_label: sub.subject_label, submitted_by: sub.submitted_by_name, submitted_at: sub.submitted_at,
    status: sub.status || 'OPEN', outcome: sub.outcome || null,
  });

  function publicDefinition(d, user) {
    const out = {
      id: d.id, key: d.key, name: d.name, description: d.description, version: d.version,
      visibility: d.visibility, subject_types: d.subject_types, fields: d.fields, active: d.active,
      effect: d.effect || null,
    };
    if (user.role === 'SYSTEM_ADMIN') {
      out.notify_emails = d.notify_emails || [];
      out.grants = db.form_grants.filter((g) => g.definition_id === d.id).map((g) => {
        const u = db.users.find((x) => x.id === g.user_id);
        return { id: g.id, user_id: g.user_id, username: u ? u.username : null, display_name: u ? u.display_name : '(deleted user)', granted_by: g.granted_by, granted_at: g.granted_at };
      });
    }
    return out;
  }

  /* ---------------------------------------------------------------- *
   * Definition validation
   * ---------------------------------------------------------------- */

  function cleanFields(raw) {
    if (!Array.isArray(raw) || !raw.length) throw httpError(400, 'a form needs at least one field');
    if (raw.length > MAX_FIELDS) throw httpError(400, `a form can have at most ${MAX_FIELDS} fields`);
    const seen = new Set();
    return raw.map((f, i) => {
      const id = String(f.id || '').trim();
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(id)) throw httpError(400, `field ${i + 1}: id must be lower-case letters, digits and _`);
      if (seen.has(id)) throw httpError(400, `field id ${id} is used twice`);
      seen.add(id);
      const type = String(f.type || '');
      if (!FIELD_TYPES.includes(type)) throw httpError(400, `field ${id}: type must be one of ${FIELD_TYPES.join(', ')}`);
      const label = String(f.label || '').trim().slice(0, 120);
      if (!label) throw httpError(400, `field ${id}: label required`);
      const out = { id, label, type, required: Boolean(f.required) };
      if (f.help) out.help = String(f.help).slice(0, 300);
      if (type === 'select') {
        const options = Array.isArray(f.options) ? f.options.map((o) => String(o).trim().slice(0, 120)).filter(Boolean) : [];
        if (options.length < 2) throw httpError(400, `field ${id}: a select needs at least two options`);
        out.options = [...new Set(options)];
      }
      return out;
    });
  }

  function cleanSubjectTypes(raw) {
    const list = Array.isArray(raw) ? raw.map((s) => String(s).toUpperCase()) : [];
    if (!list.length) throw httpError(400, 'subject_types required');
    for (const s of list) if (!SUBJECT_TYPES.includes(s)) throw httpError(400, `subject type ${s} must be one of ${SUBJECT_TYPES.join(', ')}`);
    if (list.includes('APPLICATION') && new Set(list).size > 1) throw httpError(400, 'the public application form cannot also be filed against anything else');
    return [...new Set(list)];
  }
  const isApplicationForm = (d) => d.subject_types.includes('APPLICATION');
  /** See the header: the narrower shape a login-free form is held to. */
  function checkApplicationShape(subjectTypes, fields) {
    if (!subjectTypes.includes('APPLICATION')) return;
    for (const id of ['full_name', 'email']) {
      const f = fields.find((x) => x.id === id);
      if (!f || f.type !== 'text' || !f.required) throw httpError(400, `the application form must keep a required text field with id "${id}"`);
    }
    if (fields.some((f) => f.type === 'photo')) throw httpError(400, 'the application form cannot have photo fields — it is filled in without a login');
  }
  function cleanEffect(raw, subjectTypes) {
    if (raw === undefined || raw === null || raw === '') return null;
    const e = String(raw).toUpperCase();
    if (!EFFECTS.includes(e)) throw httpError(400, `effect must be one of ${EFFECTS.join(', ')}`);
    if (!subjectTypes.includes('VEHICLE')) throw httpError(400, 'a vehicle effect needs the form to be filed against vehicles');
    return e;
  }
  /** See the header: an effect reads named fields, so the form must keep them. */
  function checkEffectShape(effect, fields) {
    if (!effect) return;
    for (const [id, type, required] of EFFECT_FIELDS[effect]) {
      const f = fields.find((x) => x.id === id);
      if (!f || f.type !== type || (required && !f.required)) {
        throw httpError(400, `a ${effect.replace('_', ' ').toLowerCase()} form must keep a${required ? ' required' : ''} ${type} field with id "${id}"`);
      }
    }
  }
  function cleanNotifyEmails(raw) {
    const list = (Array.isArray(raw) ? raw : String(raw || '').split(/[,;\s]+/)).map((e) => String(e).trim().toLowerCase()).filter(Boolean);
    for (const e of list) if (!EMAIL_RE.test(e)) throw httpError(400, `not a valid email address: ${e}`);
    if (list.length > 10) throw httpError(400, 'at most 10 notification addresses');
    return [...new Set(list)];
  }

  function installDefaults() {
    if (db.form_definitions.length) return 0;
    const now = new Date().toISOString();
    for (const f of DEFAULT_FORMS) {
      db.form_definitions.push({
        id: nextId('form_definitions'), key: f.key, name: f.name, description: f.description, version: 1,
        visibility: f.visibility, subject_types: f.subject_types, fields: cleanFields(f.fields), active: true,
        created_by: null, created_at: now, updated_at: now,
      });
    }
    return DEFAULT_FORMS.length;
  }

  /** Separate from installDefaults() because live databases already have
   * forms: adds the application form once, if there is no APPLICATION form
   * at all (an admin retiring it is respected — retired still counts). */
  function ensureApplicationForm() {
    if (db.form_definitions.some(isApplicationForm)) return false;
    const f = DEFAULT_APPLICATION_FORM, now = new Date().toISOString();
    db.form_definitions.push({
      id: nextId('form_definitions'), key: db.form_definitions.some((d) => d.key === f.key) ? `${f.key}-${Date.now()}` : f.key,
      name: f.name, description: f.description, version: 1, visibility: 'STANDARD', subject_types: f.subject_types,
      fields: cleanFields(f.fields), active: true, created_by: null, created_at: now, updated_at: now,
    });
    return true;
  }
  /** Adds any vehicle form whose key is missing, and gives the original
   * vehicle inspection its INSPECTION effect once (only if it was never
   * set — an admin clearing it is respected). */
  function ensureVehicleForms() {
    let added = 0;
    const now = new Date().toISOString();
    for (const f of [...DEFAULT_VEHICLE_FORMS, ...DEFAULT_EXTRA_FORMS]) {
      if (db.form_definitions.some((d) => d.key === f.key)) continue;
      db.form_definitions.push({
        id: nextId('form_definitions'), key: f.key, name: f.name, description: f.description, version: 1,
        visibility: f.visibility, subject_types: f.subject_types, fields: cleanFields(f.fields), active: true,
        effect: f.effect || null, notify_emails: [], created_by: null, created_at: now, updated_at: now,
      });
      added++;
    }
    const inspection = db.form_definitions.find((d) => d.key === 'vehicle-inspection');
    if (inspection && !('effect' in inspection) && inspection.fields.some((x) => x.id === 'odometer' && x.type === 'number')) inspection.effect = 'INSPECTION';
    return added;
  }

  /** What the public page renders; null when applications are closed. */
  const activeApplicationForm = () => db.form_definitions.find((d) => d.active && isApplicationForm(d)) || null;

  /* ---------------------------------------------------------------- *
   * Subject resolution
   * ---------------------------------------------------------------- */

  /** Finds the thing a form is filed against, checks the submitter may file
   * against it, and returns a label snapshotted onto the submission (so the
   * report still says "INC-2026-00131" after the job is swept by retention).
   * An officer may file against a job or visit only if assigned to it —
   * the same rule as that job's own checklist. Sites, people and vehicles
   * are reference data every officer can already see. */
  function resolveSubject(type, id, user) {
    const n = Number(id);
    switch (type) {
      case 'JOB': {
        const j = db.jobs.find((x) => x.id === n); if (!j) throw httpError(404, 'job not found');
        assertJobAccess(j, user); return j.reference;
      }
      case 'SITE_VISIT': {
        const v = db.site_visits.find((x) => x.id === n); if (!v) throw httpError(404, 'site visit not found');
        assertVisitAccess(v, user); return v.reference;
      }
      case 'SITE': {
        const s = db.sites.find((x) => x.id === n); if (!s) throw httpError(404, 'site not found');
        return s.name;
      }
      case 'PERSONNEL': {
        const p = db.personnel.find((x) => x.id === n); if (!p) throw httpError(404, 'person not found');
        return p.name;
      }
      case 'VEHICLE': {
        const v = db.vehicles.find((x) => x.id === n); if (!v) throw httpError(404, 'vehicle not found');
        return v.registration;
      }
      default: throw httpError(400, 'unknown subject type');
    }
  }

  /* ---------------------------------------------------------------- *
   * Value validation
   * ---------------------------------------------------------------- */

  function decodeImage(raw, allowed, maxBytes, what) {
    const mimetype = String(raw.mimetype || '');
    if (!allowed.includes(mimetype)) throw httpError(400, `${what} must be ${allowed.join(' or ')}`);
    const b64 = String(raw.data || '').replace(/^data:[^,]*,/, '');
    if (!b64) throw httpError(400, `${what}: image data required`);
    const bytes = Buffer.from(b64, 'base64');
    if (bytes.length > maxBytes) throw httpError(413, `${what} too large`);
    if (!IMAGE_SIGNATURES[mimetype](bytes)) throw httpError(400, `${what} is not a valid ${mimetype} image`);
    return { mimetype, bytes };
  }

  /** Validates every submitted value against the snapshotted field list and
   * returns { values, files } without writing anything — files hit disk only
   * once the whole submission is known to be valid. Keys the form does not
   * define are refused, so nothing can be stashed outside the schema. */
  function validateValues(fields, raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, 'values must be an object');
    const known = new Set(fields.map((f) => f.id));
    for (const k of Object.keys(raw)) if (!known.has(k)) throw httpError(400, `unknown field ${k}`);
    const values = {}, files = [];
    for (const f of fields) {
      const v = raw[f.id];
      const empty = v === undefined || v === null || v === '' || (f.type === 'checkbox' && v !== true);
      if (empty) {
        if (f.required) throw httpError(400, `${f.label} is required`);
        values[f.id] = f.type === 'checkbox' ? false : null;
        continue;
      }
      switch (f.type) {
        case 'text': values[f.id] = String(v).slice(0, 500); break;
        case 'textarea': values[f.id] = String(v).slice(0, 5000); break;
        case 'number': {
          const n = Number(v);
          if (!Number.isFinite(n)) throw httpError(400, `${f.label} must be a number`);
          values[f.id] = n; break;
        }
        case 'select':
          if (!f.options.includes(String(v))) throw httpError(400, `${f.label}: not one of the options`);
          values[f.id] = String(v); break;
        case 'checkbox':
          if (typeof v !== 'boolean') throw httpError(400, `${f.label} must be true or false`);
          values[f.id] = v; break;
        case 'date':
          if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || isNaN(Date.parse(v))) throw httpError(400, `${f.label} must be a date (YYYY-MM-DD)`);
          values[f.id] = String(v); break;
        case 'datetime':
          if (isNaN(Date.parse(v))) throw httpError(400, `${f.label} must be a date and time`);
          values[f.id] = new Date(v).toISOString(); break;
        case 'signature': {
          // A signature image alone proves little; the name it was given
          // under and the moment it was captured are recorded with it.
          const signer = String(v.signer_name || '').trim().slice(0, 120);
          if (!signer) throw httpError(400, `${f.label}: the signer's name is required`);
          const img = decodeImage(v, ['image/png'], SIGNATURE_MAX_BYTES, f.label);
          const file_id = crypto.randomUUID();
          files.push({ file_id, field_id: f.id, ...img });
          values[f.id] = { file_id, signer_name: signer, signed_at: new Date().toISOString() };
          break;
        }
        case 'photo': {
          const img = decodeImage(v, Object.keys(IMAGE_SIGNATURES), PHOTO_MAX_BYTES, f.label);
          const file_id = crypto.randomUUID();
          files.push({ file_id, field_id: f.id, ...img });
          values[f.id] = { file_id, caption: String(v.caption || '').slice(0, 200) };
          break;
        }
        default: throw httpError(500, `unhandled field type ${f.type}`);
      }
    }
    if (files.length > MAX_FILES) throw httpError(400, `at most ${MAX_FILES} images per form`);
    return { values, files };
  }

  /* ---------------------------------------------------------------- *
   * Routes — definitions
   * ---------------------------------------------------------------- */

  // Every role needs the definitions to fill one in; the field layout is not
  // sensitive. Grants are shown to admins only.
  route('GET', '/api/form-definitions', ALL, ({ user, query }) => {
    const all = user.role === 'SYSTEM_ADMIN' && query.get('all') === '1';
    // The public application form is not a report anyone files from inside.
    return db.form_definitions.filter((d) => (all || d.active) && (user.role === 'SYSTEM_ADMIN' || !isApplicationForm(d)))
      .map((d) => publicDefinition(d, user));
  });

  route('POST', '/api/form-definitions', ADMIN, ({ body, user }) => {
    const name = String(body.name || '').trim().slice(0, 120);
    if (!name) throw httpError(400, 'name required');
    const key = String(body.key || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    if (!key) throw httpError(400, 'key required');
    if (db.form_definitions.some((d) => d.key === key)) throw httpError(409, 'a form with that key already exists');
    const visibility = String(body.visibility || 'STANDARD').toUpperCase();
    if (!VISIBILITIES.includes(visibility)) throw httpError(400, 'visibility must be STANDARD or RESTRICTED');
    const now = new Date().toISOString();
    const d = {
      id: nextId('form_definitions'), key, name, description: String(body.description || '').slice(0, 500), version: 1,
      visibility, subject_types: cleanSubjectTypes(body.subject_types), fields: cleanFields(body.fields), active: true,
      created_by: user.id, created_at: now, updated_at: now,
    };
    checkApplicationShape(d.subject_types, d.fields);
    d.effect = cleanEffect(body.effect, d.subject_types);
    checkEffectShape(d.effect, d.fields);
    d.notify_emails = cleanNotifyEmails(body.notify_emails);
    if (isApplicationForm(d) && db.form_definitions.some((x) => x.active && isApplicationForm(x))) throw httpError(409, 'there is already an active application form — edit it, or retire it first');
    db.form_definitions.push(d);
    logEvent('form.definition_created', `FORM "${name}" CREATED (${visibility}) BY ${user.username}`, { definition_id: d.id });
    return { __status: 201, __body: publicDefinition(d, user) };
  });

  route('PATCH', '/api/form-definitions/:id', ADMIN, ({ params, body, user }) => {
    const d = findDefinition(params.id); if (!d) throw httpError(404, 'form not found');
    // Validate the resulting shape before changing anything.
    const nextSubjects = 'subject_types' in body ? cleanSubjectTypes(body.subject_types) : d.subject_types;
    const nextFields = 'fields' in body ? cleanFields(body.fields) : d.fields;
    checkApplicationShape(nextSubjects, nextFields);
    const nextEffect = 'effect' in body ? cleanEffect(body.effect, nextSubjects) : (d.effect && nextSubjects.includes('VEHICLE') ? d.effect : null);
    checkEffectShape(nextEffect, nextFields);
    const nextNotify = 'notify_emails' in body ? cleanNotifyEmails(body.notify_emails) : null;
    if (body.active && !d.active && nextSubjects.includes('APPLICATION') && db.form_definitions.some((x) => x.id !== d.id && x.active && isApplicationForm(x))) {
      throw httpError(409, 'another application form is already active — retire it first');
    }
    const changes = [];
    if ('name' in body) { const n = String(body.name || '').trim().slice(0, 120); if (!n) throw httpError(400, 'name required'); d.name = n; changes.push('name'); }
    if ('description' in body) { d.description = String(body.description || '').slice(0, 500); changes.push('description'); }
    if ('subject_types' in body) { d.subject_types = cleanSubjectTypes(body.subject_types); changes.push('subjects'); }
    if ('active' in body) { d.active = Boolean(body.active); changes.push(d.active ? 'reactivated' : 'retired'); }
    if ('fields' in body) {
      // A new version, not an edit in place: every existing submission keeps
      // the field list it was filled against (snapshotted on it).
      d.fields = cleanFields(body.fields); d.version += 1; changes.push(`fields (now v${d.version})`);
    }
    if ('visibility' in body) {
      const v = String(body.visibility || '').toUpperCase();
      if (!VISIBILITIES.includes(v)) throw httpError(400, 'visibility must be STANDARD or RESTRICTED');
      if (v !== d.visibility) changes.push(`visibility ${d.visibility} → ${v}${v === 'STANDARD' ? ' (reports already filed stay RESTRICTED)' : ''}`);
      d.visibility = v;
    }
    if ((d.effect || null) !== nextEffect) { changes.push(`effect ${d.effect || 'none'} → ${nextEffect || 'none'}`); d.effect = nextEffect; }
    if (nextNotify) {
      const before = JSON.stringify(d.notify_emails || []);
      if (before !== JSON.stringify(nextNotify)) changes.push(`email on submission: ${nextNotify.length ? nextNotify.length + ' address(es)' : 'off'}`);
      d.notify_emails = nextNotify;
    }
    d.updated_at = new Date().toISOString();
    logEvent('form.definition_updated', `FORM "${d.name}" UPDATED BY ${user.username}: ${changes.join(', ') || 'no changes'}`, { definition_id: d.id });
    flushNow();
    return publicDefinition(d, user);
  });

  // Grants: the named people who may read a RESTRICTED form's reports.
  route('POST', '/api/form-definitions/:id/grants', ADMIN, ({ params, body, user }) => {
    const d = findDefinition(params.id); if (!d) throw httpError(404, 'form not found');
    const target = db.users.find((u) => u.id === Number(body.user_id) || u.username === String(body.username || '').toLowerCase());
    if (!target) throw httpError(404, 'user not found');
    if (hasGrant(d.id, target.id)) throw httpError(409, `${target.username} already has access`);
    const g = { id: nextId('form_grants'), definition_id: d.id, user_id: target.id, granted_by: user.username, granted_at: new Date().toISOString() };
    db.form_grants.push(g);
    logEvent('form.grant_added', `${user.username} GRANTED ${target.username} ACCESS TO "${d.name}" REPORTS`, { definition_id: d.id, user_id: target.id });
    flushNow();
    return { __status: 201, __body: publicDefinition(d, user) };
  });

  route('DELETE', '/api/form-definitions/:id/grants/:grantId', ADMIN, ({ params, user }) => {
    const d = findDefinition(params.id); if (!d) throw httpError(404, 'form not found');
    const g = db.form_grants.find((x) => x.id === Number(params.grantId) && x.definition_id === d.id);
    if (!g) throw httpError(404, 'grant not found');
    db.form_grants = db.form_grants.filter((x) => x.id !== g.id);
    const target = db.users.find((u) => u.id === g.user_id);
    logEvent('form.grant_removed', `${user.username} REVOKED ${target ? target.username : 'user ' + g.user_id}'S ACCESS TO "${d.name}" REPORTS`, { definition_id: d.id, user_id: g.user_id });
    flushNow();
    return publicDefinition(d, user);
  });

  /* ---------------------------------------------------------------- *
   * Routes — submissions
   * ---------------------------------------------------------------- */

  route('POST', '/api/form-submissions', ALL, ({ body, user }) => {
    const d = findDefinition(body.definition_id);
    if (!d || !d.active) throw httpError(404, 'form not found');
    const subjectType = String(body.subject_type || '').toUpperCase();
    if (isApplicationForm(d)) throw httpError(400, 'applications are made on the public application page');
    if (!d.subject_types.includes(subjectType)) throw httpError(400, `"${d.name}" cannot be filed against a ${subjectType || 'missing subject'}`);
    const subjectLabel = resolveSubject(subjectType, body.subject_id, user);
    const { values, files } = validateValues(d.fields, body.values);
    // A vehicle report can also say, item by item, whether the kit kept on
    // that vehicle is there (First aid bag 01: present / missing). Only the
    // vehicle's own kit, checked on the server — not whatever was sent.
    let kitCheck = null;
    if (subjectType === 'VEHICLE' && Array.isArray(body.kit_check) && vehicleKit) {
      const kit = vehicleKit(Number(body.subject_id));
      kitCheck = body.kit_check.map((k) => {
        const a = kit.assets.find((x) => x.id === Number(k.asset_id));
        if (!a) throw httpError(400, `asset #${k.asset_id} is not kept on this vehicle`);
        if (typeof k.present !== 'boolean') throw httpError(400, `${a.tag || a.description}: say whether it is present`);
        return { asset_id: a.id, tag: a.tag || null, description: a.description, present: k.present, note: String(k.note || '').slice(0, 300) };
      });
    }

    const id = nextId('form_submissions');
    const now = new Date();
    const sub = {
      id, reference: `FORM-${now.getFullYear()}-${String(id).padStart(5, '0')}`,
      definition_id: d.id, definition_key: d.key, definition_name: d.name, definition_version: d.version,
      fields: d.fields, visibility: d.visibility,
      subject_type: subjectType, subject_id: Number(body.subject_id), subject_label: subjectLabel,
      values, files: files.map(({ file_id, field_id, mimetype }) => ({ file_id, field_id, mimetype, filename: `${file_id}${IMAGE_EXT[mimetype]}` })),
      submitted_by_user_id: user.id, submitted_by_name: user.display_name, submitted_by_personnel_id: user.personnel_id || null,
      submitted_at: now.toISOString(),
      status: 'OPEN', outcome: null, feedback: null, actioned_by: null, actioned_at: null,
      kit_check: kitCheck,
    };
    if (files.length) {
      const dir = formFilesDir(id);
      fs.mkdirSync(dir, { recursive: true });
      for (const f of files) fs.writeFileSync(path.join(dir, `${f.file_id}${IMAGE_EXT[f.mimetype]}`), f.bytes);
    }
    db.form_submissions.push(sub);

    if (sub.visibility === 'RESTRICTED') {
      // Nothing identifying: not the form type, not the subject, not the
      // submitter. The reference alone proves, in the audit trail, that a
      // restricted report was filed and when.
      logEvent('form.submitted_restricted', `RESTRICTED REPORT ${sub.reference} FILED`, { submission_id: sub.id });
      const readers = db.form_grants.filter((g) => g.definition_id === d.id).map((g) => g.user_id);
      pushToUsers(readers, { title: 'Restricted report filed', body: `${sub.reference} needs review`, url: `/forms.html?id=${sub.id}`, tag: 'cccs-restricted' });
    } else {
      logEvent('form.submitted', `${d.name.toUpperCase()} ${sub.reference} FILED BY ${user.display_name} — ${subjectType.replace('_', ' ')} ${subjectLabel}`, { submission_id: sub.id, subject_type: subjectType, subject_id: sub.subject_id });
      // Control-only (targeted with an empty officer list); officers see
      // their own via the list route.
      broadcast('form.submitted', submissionSummary(sub), { personnelIds: [] });
    }
    if (d.effect && subjectType === 'VEHICLE') {
      try { applyVehicleReport(d.effect, sub.subject_id, values, user, sub); sub.effect_applied = d.effect; }
      catch (e) { console.warn(`[forms] ${d.effect} effect for ${sub.reference} failed:`, e.message); sub.effect_error = e.message; }
    }
    for (const k of kitCheck || []) {
      if (!k.present) assetEvent({ asset_id: k.asset_id, type: 'MISSING_ON_CHECK', at: sub.submitted_at, by: user.display_name, note: k.note, detail: `not found on ${subjectLabel} during ${sub.reference}` });
    }
    const missing = (kitCheck || []).filter((k) => !k.present);
    if (missing.length) logEvent('vehicle.kit_missing', `${subjectLabel}: ${missing.map((k) => k.tag || k.description).join(', ')} NOT PRESENT (${sub.reference})`, { submission_id: sub.id });
    notifyByEmail(d, sub);
    // A filed report is evidence; don't wait for the next write-through.
    flushNow();
    return { __status: 201, __body: publicSubmission(sub) };
  });

  route('GET', '/api/form-submissions', ALL, ({ user, query }) => {
    const subjectType = query.get('subject_type'), subjectId = query.get('subject_id'), defId = query.get('definition_id');
    const limit = Math.min(Number(query.get('limit') || 100), 500);
    // ?status=OPEN|ACTIONED|ALL. Default ALL keeps every existing caller
    // (job/visit detail, an officer's own list) unchanged; the review queue
    // asks for OPEN.
    const status = String(query.get('status') || 'ALL').toUpperCase();
    return db.form_submissions
      .filter((s) => canRead(s, user))
      .filter((s) => status === 'ALL' || (s.status || 'OPEN') === status)
      .filter((s) => (!subjectType || s.subject_type === subjectType.toUpperCase())
        && (!subjectId || s.subject_id === Number(subjectId))
        && (!defId || s.definition_id === Number(defId)))
      .sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : -1))
      .slice(0, limit)
      .map(submissionSummary);
  });

  route('GET', '/api/form-submissions/:id', ALL, ({ params, user }) => {
    const sub = readableSubmission(params.id, user);
    return { ...publicSubmission(sub), editable: canEdit(sub, user) };
  });

  route('GET', '/api/form-submissions/:id/files/:fileId', ALL, ({ params, user }) => {
    const sub = readableSubmission(params.id, user);
    const f = sub.files.find((x) => x.file_id === params.fileId);
    if (!f) throw httpError(404, 'file not found');
    const file = path.join(formFilesDir(sub.id), f.filename);
    if (!fs.existsSync(file)) throw httpError(404, 'file missing');
    // no-store for RESTRICTED: a shared or kiosk browser must not keep a
    // cached copy of a safeguarding signature or casualty photo.
    const cache = effectiveVisibility(sub) === 'RESTRICTED' ? 'no-store' : 'private, max-age=86400';
    return { __body: fs.readFileSync(file), __headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': cache } };
  });

  /** See the header. Restricted: a link and nothing else. */
  function notifyByEmail(d, sub) {
    const to = d.notify_emails || [];
    if (!to.length || !sendEmail) return;
    const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const link = `${publicBaseUrl}/forms.html?id=${sub.id}`;
    const restricted = sub.visibility === 'RESTRICTED';
    let subject, html;
    if (restricted) {
      subject = `Restricted report filed — ${sub.reference}`;
      html = `<p>A restricted report, <strong>${esc(sub.reference)}</strong>, has been filed in CCCS.</p>
        <p><a href="${esc(link)}">Open it in CCCS</a> — only its named readers can see it.</p>`;
    } else {
      const fmt = (iso) => new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London' });
      const val = (f) => {
        const v = sub.values[f.id];
        if (v === null || v === undefined || v === '') return '—';
        if (f.type === 'checkbox') return v ? 'Yes' : 'No';
        if (f.type === 'datetime') return fmt(v);
        if (f.type === 'signature') return `Signed by ${v.signer_name}`;
        if (f.type === 'photo') return 'Photo — view in CCCS';
        return String(v);
      };
      subject = `${sub.definition_name} ${sub.reference} — ${sub.subject_label}`;
      html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#111827;max-width:640px">
        <h2 style="font-size:17px;margin:0 0 4px">${esc(sub.definition_name)} — ${esc(sub.reference)}</h2>
        <p style="color:#6b7280;margin:0 0 14px">${esc(sub.subject_type.replace('_', ' ').toLowerCase())} ${esc(sub.subject_label)} · filed by ${esc(sub.submitted_by_name)} · ${esc(fmt(sub.submitted_at))}</p>
        <table style="border-collapse:collapse;width:100%;font-size:14px">${sub.fields.map((f) => `<tr><td style="padding:5px 10px 5px 0;color:#6b7280;vertical-align:top;width:40%">${esc(f.label)}</td><td style="padding:5px 0;white-space:pre-wrap">${esc(val(f))}</td></tr>`).join('')}</table>
        <p style="margin-top:16px"><a href="${esc(link)}">Open the report in CCCS</a></p></div>`;
    }
    sub.notifications = to.map((addr) => ({ to: addr, ok: null }));
    Promise.all(to.map((addr) => Promise.resolve(sendEmail(addr, subject, html)).catch((e) => ({ ok: false, error: e.message }))))
      .then((results) => {
        sub.notifications = to.map((addr, i) => ({ to: addr, ok: Boolean(results[i] && results[i].ok), error: results[i] && !results[i].ok ? results[i].error : null, at: new Date().toISOString() }));
        const sent = sub.notifications.filter((n) => n.ok).length;
        logEvent('form.notified', `${restricted ? 'RESTRICTED REPORT' : sub.definition_name.toUpperCase()} ${sub.reference} EMAILED TO ${sent}/${to.length} ADDRESS(ES)`, { submission_id: sub.id });
        flushNow();
      });
  }

  /**
   * Admin review: records an outcome and feedback, takes the submission out
   * of the open queue, and tells the person who filed it. Goes through
   * readableSubmission() like every other read, so a RESTRICTED report can
   * only be actioned by an admin who is a named reader of it.
   *
   * How the filer is told, and why it differs by visibility:
   *   STANDARD   — an in-app message carrying the feedback (control can
   *                already read the report, and the message log is theirs).
   *   RESTRICTED — no message: messages are readable by every control role
   *                and summarised into the event log. The feedback is stored
   *                on the report, which only its readers can open.
   *   both       — a push notification with no content, only "reviewed".
   */
  route('POST', '/api/form-submissions/:id/action', ADMIN, ({ params, body, user }) => {
    const sub = readableSubmission(params.id, user);
    if ((sub.status || 'OPEN') !== 'OPEN') throw httpError(409, `already actioned (${sub.outcome}) by ${sub.actioned_by}`);
    const outcome = String(body.outcome || '').toUpperCase();
    if (!REVIEW_OUTCOMES.includes(outcome)) throw httpError(400, `outcome must be one of ${REVIEW_OUTCOMES.join(', ')}`);
    const feedback = String(body.feedback || '').trim().slice(0, 2000);
    if (!feedback && outcome !== 'NOTED') throw httpError(400, 'feedback is required when approving or rejecting');
    Object.assign(sub, { status: 'ACTIONED', outcome, feedback: feedback || null, actioned_by: user.display_name, actioned_by_user_id: user.id, actioned_at: new Date().toISOString() });
    const restricted = effectiveVisibility(sub) === 'RESTRICTED';

    if (!restricted && sub.submitted_by_personnel_id) {
      const msg = {
        id: nextId('messages'),
        body: `Your report ${sub.reference} (${sub.definition_name}) was ${outcome.toLowerCase()} by ${user.display_name}${feedback ? `: ${feedback}` : '.'}`.slice(0, 1000),
        from_label: 'CONTROL', from_personnel_id: null, from_mdt_id: null,
        to_personnel_id: sub.submitted_by_personnel_id, to_mdt_id: null, to_label: sub.submitted_by_name,
        state: 'DELIVERED', sent_at: new Date().toISOString(), read_at: null,
      };
      if (Array.isArray(db.messages)) db.messages.push(msg);
      broadcast('message.received', msg, { personnelIds: [sub.submitted_by_personnel_id] });
    }
    if (sub.submitted_by_user_id && sub.submitted_by_user_id !== user.id) {
      pushToUsers([sub.submitted_by_user_id], { title: 'Report reviewed', body: `${sub.reference} has been reviewed — open it to see the outcome`, url: `/forms.html?id=${sub.id}`, tag: 'cccs-report-reviewed' });
    }
    logEvent(restricted ? 'form.reviewed_restricted' : 'form.actioned',
      restricted ? `RESTRICTED REPORT ${sub.reference} REVIEWED` : `${sub.definition_name.toUpperCase()} ${sub.reference} ${outcome} BY ${user.display_name}`,
      { submission_id: sub.id });
    flushNow();
    return publicSubmission(sub);
  });

  /**
   * Correcting a vehicle report after it was filed — a mistyped odometer
   * reading, litres, the wrong clean date, a check ticked by mistake.
   *
   * Vehicle reports only: they describe a vehicle, are corrected in the
   * normal course of running a fleet, and drive its mileage, fuel log and
   * deep-clean date, which a correction must put right. Incident, patient
   * care and safeguarding reports are statements, and stay as filed.
   *
   * Who: an admin at any time; whoever filed it, while it is still OPEN
   * and within EDIT_WINDOW_HOURS of filing. A reason is required. Nothing
   * is overwritten silently — each edit is kept on the report (who, when,
   * why, every field's old and new value) and shown with it. Photos and
   * signatures cannot be changed: a new signature would be a new statement.
   */
  const EDIT_WINDOW_MS = Number(process.env.FORM_EDIT_WINDOW_HOURS || 24) * 3600000;
  const EDITABLE_TYPES = new Set(['text', 'textarea', 'number', 'select', 'checkbox', 'date', 'datetime']);
  function canEdit(sub, user) {
    if (sub.subject_type !== 'VEHICLE') return false;
    if (user.role === 'SYSTEM_ADMIN') return true;
    return sub.submitted_by_user_id === user.id && (sub.status || 'OPEN') === 'OPEN' && Date.now() - Date.parse(sub.submitted_at) < EDIT_WINDOW_MS;
  }
  route('PATCH', '/api/form-submissions/:id', ALL, ({ params, body, user }) => {
    const sub = readableSubmission(params.id, user);
    if (sub.subject_type !== 'VEHICLE') throw httpError(400, 'only vehicle reports can be edited — other reports stay as filed');
    if (!canEdit(sub, user)) throw httpError(403, 'you can edit your own vehicle report only while it is open and for 24 hours after filing — ask an admin');
    const reason = String((body && body.reason) || '').trim().slice(0, 300);
    if (!reason) throw httpError(400, 'say why you are changing it');
    const raw = body && body.values;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, 'values must be an object');
    const editable = sub.fields.filter((f) => EDITABLE_TYPES.has(f.type));
    for (const k of Object.keys(raw)) {
      const f = sub.fields.find((x) => x.id === k);
      if (!f) throw httpError(400, `unknown field ${k}`);
      if (!EDITABLE_TYPES.has(f.type)) throw httpError(400, `${f.label} cannot be changed after filing`);
    }
    const merged = {};
    for (const f of editable) merged[f.id] = Object.hasOwn(raw, f.id) ? raw[f.id] : sub.values[f.id];
    const { values } = validateValues(editable, merged);
    const changes = editable.filter((f) => JSON.stringify(values[f.id] ?? null) !== JSON.stringify(sub.values[f.id] ?? null))
      .map((f) => ({ field: f.id, label: f.label, from: sub.values[f.id] ?? null, to: values[f.id] ?? null }));
    if (!changes.length) throw httpError(400, 'nothing was changed');
    const before = { ...sub.values };
    sub.values = { ...sub.values, ...values };
    if (!Array.isArray(sub.amendments)) sub.amendments = [];
    sub.amendments.push({ at: new Date().toISOString(), by: user.display_name, by_user_id: user.id, reason, changes });
    if (sub.effect_applied) {
      try { reapplyVehicleReport(sub.effect_applied, sub.subject_id, before, sub.values, user, sub); }
      catch (e) { console.warn(`[forms] re-applying ${sub.effect_applied} for ${sub.reference} failed:`, e.message); sub.effect_error = e.message; }
    }
    const restricted = effectiveVisibility(sub) === 'RESTRICTED';
    logEvent('form.amended', restricted ? `RESTRICTED REPORT ${sub.reference} EDITED`
      : `${sub.definition_name.toUpperCase()} ${sub.reference} EDITED BY ${user.display_name}: ${changes.map((c) => c.label).join(', ')} — ${reason}`, { submission_id: sub.id });
    flushNow();
    return { ...publicSubmission(sub), editable: canEdit(sub, user) };
  });
  /** Permanent removal of a report that has already been reviewed. Goes
   * through readableSubmission() like every other read, so a RESTRICTED one
   * needs the admin to be a named reader. A reason is required and kept in
   * the tombstone — "who deleted evidence, and why" is exactly what an audit
   * will ask. */
  route('DELETE', '/api/form-submissions/:id', ADMIN, ({ params, body, user }) => {
    const sub = readableSubmission(params.id, user);
    if ((sub.status || 'OPEN') !== 'ACTIONED') throw httpError(409, 'review a report before deleting it');
    const reason = String((body && body.reason) || '').trim().slice(0, 300);
    if (!reason) throw httpError(400, 'a reason for deleting is required');
    db.form_submissions = db.form_submissions.filter((x) => x.id !== sub.id);
    try { fs.rmSync(formFilesDir(sub.id), { recursive: true, force: true }); } catch (e) { console.warn(`[forms] could not remove files for ${sub.reference}:`, e.message); }
    const restricted = effectiveVisibility(sub) === 'RESTRICTED';
    logEvent('form.deleted', `${restricted ? 'RESTRICTED REPORT' : sub.definition_name.toUpperCase()} ${sub.reference} DELETED BY ${user.display_name}${restricted ? '' : ` — ${reason}`}`,
      { reference: sub.reference, definition_id: sub.definition_id, deleted_by: user.id, ...(restricted ? {} : { reason }) });
    flushNow();
    return { ok: true, reference: sub.reference };
  });

  return { installDefaults, ensureApplicationForm, ensureVehicleForms, activeApplicationForm, validateValues, IMAGE_EXT, canRead, effectiveVisibility };
};

module.exports.DEFAULT_FORMS = DEFAULT_FORMS;
