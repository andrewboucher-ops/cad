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
const { Doc, A4 } = require('./pdf.js');
const { appendTrail, verifyTrail } = require('./record-trail.js');

const VISIBILITIES = ['STANDARD', 'RESTRICTED'];
const SUBJECT_TYPES = ['JOB', 'SITE_VISIT', 'SITE', 'PERSONNEL', 'VEHICLE', 'APPLICATION'];
const SUBJECT_LABEL = { JOB: 'Job', SITE_VISIT: 'Patrol visit', SITE: 'Site', PERSONNEL: 'Person', VEHICLE: 'Vehicle' };
const REVIEW_OUTCOMES = ['APPROVED', 'REJECTED', 'NOTED'];
// A report that needs more than a single review action: a manager (any
// ADMIN — the review "pool", same bar as /action already uses, not a
// named assignee) claims it, investigates, assesses risk, and either
// closes it (the existing /action route, now also reachable from these
// states) or sends it back to the officer for correction. Generic across
// every form type, not hardcoded to incident/safeguarding/use-of-force —
// those just happen to be the ones anyone uses it on.
const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH'];
const RISK_MATRIX = {
  LOW: { LOW: 'LOW', MEDIUM: 'LOW', HIGH: 'MEDIUM' },
  MEDIUM: { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' },
  HIGH: { LOW: 'MEDIUM', MEDIUM: 'HIGH', HIGH: 'HIGH' },
};
const CLOSEABLE_STATUSES = ['OPEN', 'UNDER_INVESTIGATION', 'RETURNED_FOR_CORRECTION'];
function blankInvestigation() {
  return {
    started_by: null, started_by_user_id: null, started_at: null,
    investigator: null, investigator_user_id: null, assigned_at: null,
    findings: '', witnesses: '', evidence_reviewed: '', root_cause: '', contributing_factors: '', recommendations: '', lessons_learned: '',
    actions: [], external_notifications: [], sign_offs: [],
  };
}
/* Who else may need to be told, and the decision recorded either way —
 * "we considered it and it wasn't needed, because..." is as much a part of the
 * record as a reference number. The hints are reminders for the page, not
 * legal advice; check the regulator's current guidance. */
const NOTIFY_BODIES = {
  CQC: 'CQC (statutory notification)',
  SIA: 'SIA',
  ICO: 'ICO (personal data breach)',
  HSE_RIDDOR: 'HSE (RIDDOR)',
  POLICE: 'Police',
  SAFEGUARDING: 'Local authority safeguarding team',
  CLIENT: 'Client',
  INSURER: 'Insurer',
  PERSON_AFFECTED: 'Person affected (duty of candour / being open)',
  OTHER: 'Other',
};
const NOTIFY_DECISIONS = ['NOTIFIED', 'NOT_REQUIRED'];
const ACTION_STATUSES = ['OPEN', 'DONE', 'CANCELLED'];
const INVESTIGATION_LABELS = {
  findings: 'Findings', witnesses: 'Witnesses', evidence_reviewed: 'Evidence reviewed', root_cause: 'Root cause',
  contributing_factors: 'Contributing factors', recommendations: 'Recommendations', lessons_learned: 'Lessons learned',
};
function blankRiskAssessment() {
  return { likelihood: null, severity: null, risk_rating: null, control_measures: '', review_date: null, assessed_by: null, assessed_at: null };
}
const EFFECTS = ['FUEL_UP', 'DEEP_CLEAN', 'INSPECTION'];
/** The fields each effect reads: [id, type, required]. */
const EFFECT_FIELDS = {
  FUEL_UP: [['litres', 'number', true], ['odometer', 'number', false]],
  DEEP_CLEAN: [['cleaned_at', 'datetime', false]],
  INSPECTION: [['odometer', 'number', false]],
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
// A HIGH/CRITICAL report pushes once on filing (see the POST route below).
// If nobody has actioned it within this long, it pushes exactly once more —
// the same "still not dealt with" shape as routes-attendance.js's
// LATE_ALERT_MS, not a repeating siren. The control room's own attention
// strip already shows it continuously the whole time it's open; this
// reminder is for whoever stepped away from the screen or missed the first
// push.
const SEVERITY_REMIND_MS = 15 * 60000;
const FIELD_TYPES = ['text', 'textarea', 'number', 'select', 'checkbox', 'date', 'datetime', 'signature', 'photo', 'severity'];
const MAX_FIELDS = 60;
const MAX_FILES = 10;
const SIGNATURE_MAX_BYTES = 500e3;
const PHOTO_MAX_BYTES = 8e6;
// A report filed against one of these resolves to a real site, so it's the
// only subject shape a redacted copy can be released to that site's client
// portal — a VEHICLE report is a fleet matter and a PERSONNEL report is
// about a specific staff member, neither of which is "about a client's site"
// no matter how it's redacted.
const CLIENT_SHAREABLE_SUBJECT_TYPES = ['JOB', 'SITE_VISIT', 'SITE'];

// Magic bytes, checked rather than trusting the declared mimetype: these
// files are served back to other people's browsers.
const IMAGE_SIGNATURES = {
  'image/png': (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
};
const IMAGE_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

/*
 * The three statement forms — safeguarding, use of force and incident —
 * checked against what UK law and the regulators expect such a record to
 * show (see docs/FORMS-COMPLIANCE.md for the reasoning, field by field).
 * In short:
 *   - Safeguarding: the Care Act 2014 s42 and its statutory guidance, and
 *     Working Together to Safeguard Children 2023 — the type of concern,
 *     the person's own words and wishes ("Making Safeguarding Personal"),
 *     who was told and when, whether a referral was made, and — because
 *     this is special-category data under UK GDPR — a recorded decision on
 *     sharing, with the reason when it was shared without consent (DPA 2018
 *     Schedule 8 para 4 / Schedule 1 para 18 allow that to protect someone).
 *   - Use of force: the officer must be able to show the force was
 *     necessary, proportionate and reasonable in the circumstances as they
 *     honestly believed them (common law; Criminal Law Act 1967 s3; CJIA
 *     2008 s76) — so the threat seen, what was tried first, why less would
 *     not have worked, the restraint position (prone restraint carries a
 *     positional-asphyxia risk), aftercare, and for a citizen's arrest the
 *     grounds and hand-over (PACE s24A). SIA licence numbers of everyone
 *     involved, since the SIA can review a licence on it.
 *   - Incident: RIDDOR 2013, the 72-hour ICO personal-data-breach clock
 *     (UK GDPR Art 33), CQC Registration Regulation 18 notifications where
 *     a CQC-regulated service was being provided, and evidence handling
 *     (CCTV / body-worn video preserved before it overwrites).
 * All three end with a statement-of-truth tick, the shape a statement
 * needs to be relied on later.
 *
 * required_if: { field, equals: true } or { field, in: [options] } — the
 * field is shown, and required, only when the named checkbox is ticked or
 * the named select has one of those answers. alert: a STANDARD form's
 * ticked checkbox pushes control at once, the way HIGH severity does.
 * past_only: a datetime that cannot be in the future.
 */
const STATEMENT_TRUE = { id: 'statement_true', label: 'This is a true and accurate account, written as soon as I reasonably could', type: 'checkbox', required: true, help: 'This report may be used as evidence, or by the SIA, CQC, police or a court.' };

const SAFEGUARDING_FIELDS = [
  { id: 'concern_about', label: 'Who the concern is about (name, approximate age, description)', type: 'textarea', required: true },
  { id: 'at_risk_group', label: 'Concern relates to', type: 'select', required: true, options: ['Child (under 18)', 'Adult at risk', 'Not sure'] },
  { id: 'concern_type', label: 'Type of concern', type: 'select', required: true, help: 'The categories in the Care Act 2014 guidance and Working Together to Safeguard Children. Pick the closest; the safeguarding lead can change it.',
    options: ['Physical abuse', 'Sexual abuse or exploitation', 'Emotional or psychological abuse', 'Financial or material abuse', 'Neglect or acts of omission', 'Self-neglect', 'Domestic abuse', 'Modern slavery or trafficking', 'Criminal exploitation or county lines', 'Discriminatory abuse', 'Organisational abuse', 'Radicalisation (Prevent)', 'Not sure'] },
  { id: 'observed_at', label: 'When', type: 'datetime', required: true, past_only: true },
  { id: 'location', label: 'Where it happened, or where the person is now', type: 'text', required: true },
  { id: 'what_happened', label: 'What you saw or were told — in their words where possible', type: 'textarea', required: true, help: 'Record facts, not opinions. Never promise to keep a disclosure secret: explain it may need to be shared to keep them safe.' },
  { id: 'persons_views', label: 'What the person said they want to happen (if they could say)', type: 'textarea', help: 'Record their wishes even if you have to act anyway.' },
  { id: 'alleged_harm_by', label: 'Who is alleged to have caused the harm (if known)', type: 'textarea' },
  { id: 'alleged_is_staff', label: 'The concern is about one of our staff, or someone else in a position of trust', type: 'checkbox', help: 'Do not discuss it with them. The safeguarding lead must consider telling the LADO (for children) or the local authority.' },
  { id: 'others_at_risk', label: 'Other children or adults may also be at risk', type: 'checkbox' },
  { id: 'immediate_danger', label: 'Someone was in immediate danger', type: 'checkbox' },
  { id: 'emergency_services', label: 'Police or ambulance (999) were called', type: 'checkbox' },
  { id: 'emergency_reference', label: 'Police or ambulance reference, or the time you called', type: 'text', required_if: { field: 'emergency_services', equals: true } },
  { id: 'action_taken', label: 'Action taken (including any 999 call)', type: 'textarea', required: true },
  { id: 'dsl_informed', label: 'Safeguarding lead you told (name and time)', type: 'text', required: true, help: 'Tell the safeguarding lead the same shift. If you cannot reach them and someone is at risk, call 999 or the local authority yourself.' },
  { id: 'referral_status', label: 'Referral to the local authority (adult social care, children\'s services or MASH)', type: 'select', required: true, options: ['Made by me', 'Left for the safeguarding lead to decide', 'Not needed', 'Not sure'] },
  { id: 'referral_reference', label: 'Referral reference, or who you spoke to and when', type: 'text', required_if: { field: 'referral_status', in: ['Made by me'] } },
  { id: 'consent_to_share', label: 'Did the person agree to this being shared?', type: 'select', required: true,
    options: ['Yes they agreed', 'They refused but sharing is needed to protect them or others', 'Not asked because asking would increase the risk', 'Not asked because of their age or capacity or an emergency', 'Not shared outside Echelon'] },
  { id: 'sharing_reason', label: 'Why sharing without their agreement was necessary', type: 'textarea', help: 'Data protection law allows sharing without consent to protect a child or adult at risk. Record the reason.',
    required_if: { field: 'consent_to_share', in: ['They refused but sharing is needed to protect them or others', 'Not asked because asking would increase the risk', 'Not asked because of their age or capacity or an emergency'] } },
  STATEMENT_TRUE,
  { id: 'officer_signature', label: 'Officer signature', type: 'signature', required: true },
];

const INCIDENT_FIELDS = [
  { id: 'occurred_at', label: 'When it happened', type: 'datetime', required: true, past_only: true },
  { id: 'severity', label: 'Severity', type: 'severity', required: true, help: 'HIGH or CRITICAL alerts control immediately.' },
  { id: 'incident_type', label: 'Type', type: 'select', required: true,
    options: ['Theft', 'Criminal damage', 'Anti-social behaviour', 'Trespass', 'Assault', 'Violence or threats to staff', 'Suspicious activity', 'Fire or alarm', 'Medical', 'Injury or accident', 'Near miss', 'Health and safety', 'Data breach or lost information', 'Lost or found property', 'Safeguarding concern', 'Use of force', 'Other'] },
  { id: 'location', label: 'Exact location', type: 'text', required: true },
  { id: 'description', label: 'What happened', type: 'textarea', required: true },
  { id: 'persons_involved', label: 'People involved (descriptions, names if known)', type: 'textarea', help: 'Only what is needed. A description is often enough.' },
  { id: 'immediate_action', label: 'What you did straight away', type: 'textarea', required: true },
  { id: 'anyone_injured', label: 'Someone was injured', type: 'checkbox' },
  { id: 'injury_details', label: 'Who was hurt (staff, client or public), the injury, and any first aid or hospital visit', type: 'textarea', help: 'Also file a Patient care / first aid report for any first aid given.', required_if: { field: 'anyone_injured', equals: true } },
  { id: 'riddor_possible', label: 'This may be reportable under RIDDOR', type: 'checkbox', alert: true,
    help: 'A death, a specified injury (e.g. fracture, amputation, loss of sight), a worker off or on light duties for more than 7 days, a member of the public taken straight to hospital, or a dangerous occurrence. A manager decides and reports to HSE.' },
  { id: 'data_breach', label: 'Personal information may have been lost, stolen, seen by the wrong person or sent to the wrong place', type: 'checkbox', alert: true, help: 'Tell control now. If it puts people at risk, the ICO must be told within 72 hours.' },
  { id: 'data_breach_details', label: 'What information, whose, and what has been done to contain it', type: 'textarea', required_if: { field: 'data_breach', equals: true } },
  { id: 'cqc_notifiable', label: 'This happened during a CQC-regulated service (e.g. medical cover or patient transport) and involves a death, serious injury, abuse or police involvement', type: 'checkbox', alert: true, help: 'The registered manager must notify CQC without delay, and the duty of candour may apply.' },
  { id: 'safeguarding_concern', label: 'A child or adult at risk may be involved', type: 'checkbox', help: 'File a Safeguarding report too, and keep the detail of the concern in that report rather than here.' },
  { id: 'force_used', label: 'Force or restraint was used', type: 'checkbox', help: 'File a Use of force report too.' },
  { id: 'police_attended', label: 'Police attended or were called', type: 'checkbox' },
  { id: 'police_reference', label: 'Police reference', type: 'text', required_if: { field: 'police_attended', equals: true } },
  { id: 'witnesses', label: 'Witnesses (names and contact details if available)', type: 'textarea' },
  { id: 'cctv_bwv_ref', label: 'CCTV / body-worn video reference', type: 'text' },
  { id: 'footage_preserved', label: 'Footage has been saved, or the site asked to keep it', type: 'checkbox', help: 'CCTV often overwrites within 30 days.' },
  { id: 'client_informed', label: 'The client has been told', type: 'checkbox' },
  { id: 'photo', label: 'Photo', type: 'photo', help: 'Avoid faces and injuries unless they are needed and the person agrees.' },
  { id: 'officer_sia_licence', label: 'Your SIA licence number (if licensed)', type: 'text' },
  STATEMENT_TRUE,
  { id: 'officer_signature', label: 'Officer signature', type: 'signature', required: true },
];

const USE_OF_FORCE_FIELDS = [
  { id: 'occurred_at', label: 'Time force was used', type: 'datetime', required: true, past_only: true },
  { id: 'severity', label: 'Severity', type: 'severity', required: true, help: 'HIGH or CRITICAL alerts control immediately.' },
  { id: 'location', label: 'Exact location', type: 'text', required: true },
  { id: 'officer_sia_licence', label: 'Your SIA licence number', type: 'text', required: true },
  { id: 'subject_name', label: 'Name of the person force was used against (if known)', type: 'text' },
  { id: 'subject_description', label: 'Description (if not known by name)', type: 'textarea' },
  { id: 'subject_vulnerability', label: 'The person appeared to be', type: 'select', help: 'If they may be a child or an adult at risk, file a Safeguarding report too.',
    options: ['No obvious vulnerability', 'Under 18', 'Intoxicated (drink or drugs)', 'In mental health crisis', 'Unwell or injured', 'Pregnant', 'Disabled or with a learning disability', 'Not sure'] },
  { id: 'threat', label: 'What the person was doing that made you consider force (the threat you saw)', type: 'textarea', required: true },
  { id: 'de_escalation', label: 'What you tried first (talking, warnings, giving space, backing off)', type: 'textarea', required: true, help: 'If there was no time to try anything, say why.' },
  { id: 'reason', label: 'Reason force was necessary', type: 'select', required: true, options: ['Self-defence', 'Defence of another person', 'Prevention of a crime', 'Effecting a lawful arrest or detention', 'Preventing escape', 'Protecting property', 'Other'] },
  { id: 'force_type', label: 'Type of force used', type: 'select', required: true, options: ['Verbal commands / de-escalation only', 'Guiding or escorting hold', 'Physical restraint or control', 'Handcuffs or limb restraints applied', 'Strike or parry', 'Use of an issued defensive item', 'Other'] },
  { id: 'restraint_position', label: 'Position the person was held in', type: 'select', help: 'Face-down restraint risks positional asphyxia: keep it as short as possible and watch their breathing.',
    options: ['Not held', 'Standing', 'Seated', 'Kneeling', 'On their side', 'On their back', 'Face down (prone)'] },
  { id: 'prone_details', label: 'How long they were face down, and how their breathing was watched', type: 'textarea', required_if: { field: 'restraint_position', in: ['Face down (prone)'] } },
  { id: 'force_duration', label: 'Approximate duration force was applied', type: 'text' },
  { id: 'why_proportionate', label: 'Why the force was necessary and proportionate, and why less would not have worked', type: 'textarea', required: true,
    help: 'The law allows only force that is reasonable in the circumstances as you honestly believed them to be.' },
  { id: 'narrative', label: 'What happened, in sequence — what was said, what was done, and why', type: 'textarea', required: true },
  { id: 'other_staff', label: 'Other staff involved (names and SIA licence numbers)', type: 'textarea' },
  { id: 'subject_injured', label: 'The subject was injured', type: 'checkbox' },
  { id: 'subject_injury_details', label: 'Details of the subject\'s injury', type: 'textarea', required_if: { field: 'subject_injured', equals: true } },
  { id: 'officer_injured', label: 'The officer was injured', type: 'checkbox', help: 'Also file an Incident report: the injury may be reportable under RIDDOR.' },
  { id: 'officer_injury_details', label: 'Details of the officer\'s injury', type: 'textarea', required_if: { field: 'officer_injured', equals: true } },
  { id: 'medical_attention', label: 'Medical attention was given or requested', type: 'checkbox' },
  { id: 'aftercare', label: 'Aftercare: how the person was checked and looked after once force stopped', type: 'textarea', required: true },
  { id: 'arrested_detained', label: 'Subject was arrested or detained', type: 'checkbox' },
  { id: 'arrest_grounds', label: 'Grounds for the arrest, what you told them, and when and to whom they were handed over', type: 'textarea', required_if: { field: 'arrested_detained', equals: true },
    help: 'A citizen\'s arrest needs reasonable grounds that they committed an indictable offence, and the person must be handed to police as soon as possible.' },
  { id: 'police_informed', label: 'Police informed', type: 'checkbox' },
  { id: 'police_reference', label: 'Police reference', type: 'text', required_if: { field: 'police_informed', equals: true } },
  { id: 'witnesses', label: 'Witnesses (names and contact details if available)', type: 'textarea' },
  { id: 'bwv_recorded', label: 'Body-worn video was recording', type: 'checkbox' },
  { id: 'cctv_bwv_ref', label: 'CCTV / body-worn video reference', type: 'text' },
  { id: 'supervisor_notified', label: 'A supervisor was notified at the time', type: 'checkbox' },
  { id: 'supervisor_name', label: 'Supervisor\'s name and the time you told them', type: 'text', required_if: { field: 'supervisor_notified', equals: true } },
  { id: 'photo', label: 'Photo (e.g. scene — never an injury photo without the subject\'s consent)', type: 'photo' },
  STATEMENT_TRUE,
  { id: 'officer_signature', label: 'Officer signature', type: 'signature', required: true },
];

/** The keys ensureStatementCompliance() upgrades, and to what. */
const STATEMENT_FORM_FIELDS = { safeguarding: SAFEGUARDING_FIELDS, 'incident-report': INCIDENT_FIELDS, 'use-of-force': USE_OF_FORCE_FIELDS };
const STATEMENT_COMPLIANCE_VERSION = 1;

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
    fields: SAFEGUARDING_FIELDS,
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
    fields: INCIDENT_FIELDS,
  },
  {
    // RESTRICTED by default, same reasoning as patient-care/safeguarding
    // above: this can carry a named third party's injury details and is
    // the record an SIA licence review or a claim would turn on — a
    // default should err towards the stricter handling. An admin can
    // relax it in Admin -> Forms; relaxing is a logged decision.
    key: 'use-of-force', name: 'Use of force report', visibility: 'RESTRICTED', subject_types: ['JOB', 'SITE_VISIT', 'SITE', 'PERSONNEL'],
    description: 'Any physical force used on duty, including restraint — required whenever force is used, whether or not anyone was hurt.',
    fields: USE_OF_FORCE_FIELDS,
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
  assertJobAccess, assertVisitAccess, pushToUsers, pushToRoles = () => {}, CONTROL = [],
  UPLOADS_DIR, MIME, flushNow = () => {},
  applyVehicleReport = () => {}, reapplyVehicleReport = () => {}, sendEmail = null, publicBaseUrl = '',
  vehicleKit = null, assetEvent = () => {}, queryAudit = null,
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

  /* ---- The record's own audit trail (record-trail.js) ----------------
   * Every view, change and decision is one entry on the report, kept as long
   * as the report, with field-by-field before and after where something was
   * edited. Its hash also goes into the global trail (trail_hash), never its
   * content: the global trail is readable by every control role, and a
   * RESTRICTED report's content is not theirs to read. */
  function track(sub, user, action, summary, extra = {}) {
    return appendTrail(sub, { action, summary, by: user ? user.display_name : 'CCCS', by_user_id: user ? user.id : null, ...extra });
  }
  const restrictedLabel = (sub) => (effectiveVisibility(sub) === 'RESTRICTED' ? `RESTRICTED REPORT ${sub.reference}` : `${sub.definition_name.toUpperCase()} ${sub.reference}`);
  /** Track + one global row for it, in one call — for the investigation
   * actions, whose global row says what happened and to which report, and
   * for a RESTRICTED report nothing more. */
  function trackAndLog(sub, user, action, summary, extra = {}) {
    const entry = track(sub, user, action, summary, extra);
    const restricted = effectiveVisibility(sub) === 'RESTRICTED';
    logEvent(`investigation.${action}`, `${restrictedLabel(sub)}: ${restricted ? action.replace(/_/g, ' ').toUpperCase() : summary.toUpperCase()} — ${user.display_name}`, { submission_id: sub.id, user_id: user.id, trail_hash: entry.hash });
    return entry;
  }
  /** Views. Not every refresh: the same person opening the same report again
   * within ACCESS_REPEAT_MS is one access, not ten. Kept out of the live
   * event feed (a record, not news). */
  const ACCESS_REPEAT_MS = 10 * 60000;
  function noteAccess(sub, user, action, summary) {
    const now = Date.now();
    const trail = sub.audit_trail || [];
    // An export is always its own entry: a copy has left CCCS.
    for (let i = trail.length - 1; action !== 'exported' && i >= 0 && now - Date.parse(trail[i].at) < ACCESS_REPEAT_MS; i--) {
      if (trail[i].action === action && trail[i].by_user_id === user.id) return;
    }
    const entry = track(sub, user, action, summary);
    logEvent('form.accessed', `${restrictedLabel(sub)} ${action === 'exported' ? 'EXPORTED' : 'OPENED'} BY ${user.username || user.display_name}`,
      { submission_id: sub.id, user_id: user.id, trail_hash: entry.hash }, { broadcast: false });
  }
  /** Working an investigation: any ADMIN in the review pool, or the person
   * it has been assigned to (who may be a supervisor). Always on top of
   * canRead(), so a RESTRICTED report still needs a grant. */
  function canInvestigate(sub, user) {
    if (!canRead(sub, user)) return false;
    if (user.role === 'SYSTEM_ADMIN') return true;
    return Boolean(sub.investigation && sub.investigation.investigator_user_id === user.id && isControlRole(user.role));
  }
  /** Who opened a report and when is itself personal data about staff:
   * shown to admins and the assigned investigator, not to every reader. */
  const canSeeTrail = (sub, user) => canInvestigate(sub, user);
  /** An investigation may be about the officer who filed the report, or a
   * colleague: its working notes are for the people running it. Everyone
   * else who can read the report sees that one exists and who leads it. */
  function forViewer(sub, user) {
    const out = publicSubmission(sub);
    if (out.investigation && !canInvestigate(sub, user)) {
      out.investigation = { started_at: out.investigation.started_at, investigator: out.investigation.investigator || null, restricted_to_investigators: true };
      out.risk_assessment = null;
    }
    return out;
  }

  /** The value of a submission's own severity field, if its form has one —
   * a convenience top-level copy so list/summary views (and the control
   * room's attention strip) can show it without digging into fields/values. */
  function severityOf(sub) {
    const f = sub.fields.find((x) => x.type === 'severity');
    return f ? sub.values[f.id] || null : null;
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
      visibility: effectiveVisibility(sub), severity: severityOf(sub),
      subject_type: sub.subject_type, subject_id: sub.subject_id, subject_label: sub.subject_label,
      fields: sub.fields, values, geo: sub.geo || null,
      submitted_by: sub.submitted_by_name, submitted_by_user_id: sub.submitted_by_user_id,
      submitted_at: sub.submitted_at,
      status: sub.status || 'OPEN', outcome: sub.outcome || null, feedback: sub.feedback || null,
      actioned_by: sub.actioned_by || null, actioned_at: sub.actioned_at || null,
      amendments: sub.amendments || [],
      investigation: sub.investigation || null, risk_assessment: sub.risk_assessment || null,
      correction_requests: sub.correction_requests || [],
      kit_check: sub.kit_check || null,
      client_shareable: CLIENT_SHAREABLE_SUBJECT_TYPES.includes(sub.subject_type),
      client_share: sub.client_share || null,
      evidence_links: sub.evidence_links || [],
    };
  }

  /** A list entry: enough to show a row, no field values. Still only built
   * for submissions canRead() passed — a list is a read like any other. */
  const submissionSummary = (sub) => ({
    id: sub.id, reference: sub.reference, definition_id: sub.definition_id, definition_name: sub.definition_name,
    visibility: effectiveVisibility(sub), severity: severityOf(sub), subject_type: sub.subject_type, subject_id: sub.subject_id,
    subject_label: sub.subject_label, submitted_by: sub.submitted_by_name, submitted_at: sub.submitted_at,
    status: sub.status || 'OPEN', outcome: sub.outcome || null,
    under_investigation: Boolean(sub.investigation && sub.investigation.started_at),
    investigator: (sub.investigation && sub.investigation.investigator) || null,
    open_actions: sub.investigation ? (sub.investigation.actions || []).filter((a) => a.status === 'OPEN').length : 0,
    risk_rating: (sub.risk_assessment && sub.risk_assessment.risk_rating) || null,
  });

  /* ---- Search ---------------------------------------------------------- */
  const fold = (t) => String(t).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  function searchTerms(q) {
    return fold(q || '').split(/\s+/).map((t) => t.trim()).filter(Boolean).slice(0, 8);
  }
  /** Text answers on a report, as [label, text] pairs. Photos and
   * signatures (file objects) and tick boxes carry no searchable words. */
  function textAnswers(sub) {
    const out = [];
    for (const f of sub.fields || []) {
      const v = (sub.values || {})[f.id];
      if (v == null || typeof v === 'boolean' || (typeof v === 'object' && !Array.isArray(v))) continue;
      const text = Array.isArray(v) ? v.filter((x) => typeof x === 'string' || typeof x === 'number').join(', ') : String(v);
      if (text.trim()) out.push([f.label || f.id, text]);
    }
    return out;
  }
  /** null when some search word is missing from the report; otherwise where
   * the first answer that matched is, with a short snippet around it, so a
   * list row can show why it came up ("People involved: …John Smith…"). */
  function searchHit(sub, terms) {
    const head = [
      ['Reference', sub.reference], ['Report', sub.definition_name], ['About', sub.subject_label],
      ['Filed by', sub.submitted_by_name], ['Feedback', sub.feedback],
    ].filter(([, t]) => t);
    const answers = textAnswers(sub);
    const all = [...head, ...answers].map(([label, text]) => [label, String(text), fold(text)]);
    if (!terms.every((t) => all.some(([, , f]) => f.includes(t)))) return null;
    // Prefer an answer (that's where names live) over the header fields.
    const pick = all.slice(head.length).find(([, , f]) => terms.some((t) => f.includes(t))) || all.find(([, , f]) => terms.some((t) => f.includes(t)));
    if (!pick) return { match: null };
    const [label, text, f] = pick;
    const t = terms.find((x) => f.includes(x));
    const at = f.indexOf(t);
    // fold() can change length for accented text; clamp to be safe.
    const start = Math.max(0, Math.min(text.length, at - 40)), end = Math.min(text.length, at + t.length + 60);
    const snippet = `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
    return { match: { label, text: snippet } };
  }

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
    const cleaned = raw.map((f, i) => {
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
      if (type === 'checkbox' && f.alert) out.alert = true;
      if (type === 'datetime' && f.past_only) out.past_only = true;
      if (f.required_if && typeof f.required_if === 'object') out.required_if = f.required_if;
      return out;
    });
    // A condition must point at another checkbox or select on the same form.
    // One whose controlling field has since been removed or retyped is
    // dropped rather than refused: the admin editor has no way to edit a
    // condition, so refusing would leave the form unsaveable.
    for (const f of cleaned) {
      if (!f.required_if) continue;
      const c = f.required_if, ctl = cleaned.find((x) => x.id === String(c.field || '') && x.id !== f.id);
      if (ctl && ctl.type === 'checkbox') f.required_if = { field: ctl.id, equals: true };
      else if (ctl && ctl.type === 'select' && Array.isArray(c.in)) {
        const opts = c.in.map(String).filter((o) => ctl.options.includes(o));
        if (opts.length) f.required_if = { field: ctl.id, in: [...new Set(opts)] }; else delete f.required_if;
      } else delete f.required_if;
      if (f.required_if) f.required = false;
    }
    return cleaned;
  }

  /** Whether a required_if condition is met by the (validated) values. */
  function conditionMet(cond, values) {
    const v = values[cond.field];
    return cond.equals === true ? v === true : Array.isArray(cond.in) && cond.in.includes(v);
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
        ...(STATEMENT_FORM_FIELDS[f.key] ? { compliance_version: STATEMENT_COMPLIANCE_VERSION } : {}),
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
        ...(STATEMENT_FORM_FIELDS[f.key] ? { compliance_version: STATEMENT_COMPLIANCE_VERSION } : {}),
      });
      added++;
    }
    const inspection = db.form_definitions.find((d) => d.key === 'vehicle-inspection');
    if (inspection && !('effect' in inspection) && inspection.fields.some((x) => x.id === 'odometer' && x.type === 'number')) inspection.effect = 'INSPECTION';
    return added;
  }

  /** Adds the severity field to the two default incident-type forms if they
   * exist and don't have it yet. Same additive-and-idempotent shape as
   * ensureVehicleForms() above, for a database whose incident-report/
   * use-of-force forms were installed before severity existed. Bumps the
   * form's version like any other field change (PATCH /api/form-definitions
   * already does this for an admin's own edits) — reports already filed keep
   * the field list they were filled against. An admin's own edits to these
   * forms since are respected: this only ever adds the one field, once. */
  function ensureIncidentSeverity() {
    const SEVERITY_FIELD = { id: 'severity', label: 'Severity', type: 'severity', required: true, help: 'HIGH or CRITICAL alerts control immediately.' };
    let changed = 0;
    for (const key of ['incident-report', 'use-of-force']) {
      const d = db.form_definitions.find((x) => x.key === key);
      if (!d || d.fields.some((f) => f.type === 'severity')) continue;
      d.fields = [d.fields[0], SEVERITY_FIELD, ...d.fields.slice(1)];
      d.version += 1;
      changed++;
    }
    return changed;
  }

  /** Brings an existing database's safeguarding, incident and use-of-force
   * forms up to the field lists above, once each (marked with
   * compliance_version, so an admin's edits afterwards are never undone).
   * The default fields come first in their default order — an existing one
   * keeps any extra select options and a required tick the admin added —
   * and any field the admin added themselves is kept, just before the
   * statement of truth. Bumps the version, so reports already filed keep
   * the field list they were filled against. */
  function ensureStatementCompliance() {
    let changed = 0;
    for (const [key, defaults] of Object.entries(STATEMENT_FORM_FIELDS)) {
      const d = db.form_definitions.find((x) => x.key === key);
      if (!d || (d.compliance_version || 0) >= STATEMENT_COMPLIANCE_VERSION) continue;
      const merged = defaults.map((df) => {
        const old = d.fields.find((x) => x.id === df.id);
        if (!old || old.type !== df.type) return { ...df };
        const f = { ...df, required: Boolean(df.required || (old.required && !df.required_if)) };
        if (df.type === 'select') f.options = [...new Set([...df.options, ...(old.options || [])])];
        return f;
      });
      const extras = d.fields.filter((x) => !defaults.some((df) => df.id === x.id));
      const at = merged.findIndex((f) => f.id === 'statement_true');
      merged.splice(at, 0, ...extras);
      d.fields = cleanFields(merged);
      d.compliance_version = STATEMENT_COMPLIANCE_VERSION;
      d.version += 1;
      d.updated_at = new Date().toISOString();
      changed++;
    }
    return changed;
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
    const values = {}, files = [], conditional = [];
    for (const f of fields) {
      const v = raw[f.id];
      const empty = v === undefined || v === null || v === '' || (f.type === 'checkbox' && v !== true);
      if (empty) {
        if (f.required) throw httpError(400, `${f.label} is required`);
        if (f.required_if) conditional.push(f);
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
        case 'severity':
          if (!SEVERITIES.includes(String(v))) throw httpError(400, `${f.label} must be one of ${SEVERITIES.join(', ')}`);
          values[f.id] = String(v); break;
        case 'checkbox':
          if (typeof v !== 'boolean') throw httpError(400, `${f.label} must be true or false`);
          values[f.id] = v; break;
        case 'date':
          if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || isNaN(Date.parse(v))) throw httpError(400, `${f.label} must be a date (YYYY-MM-DD)`);
          values[f.id] = String(v); break;
        case 'datetime':
          if (isNaN(Date.parse(v))) throw httpError(400, `${f.label} must be a date and time`);
          // Ten minutes' grace for a phone whose clock runs fast. A queued
          // offline report is sent later, never earlier, so it still passes.
          if (f.past_only && Date.parse(v) > Date.now() + 10 * 60000) throw httpError(400, `${f.label} cannot be in the future`);
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
    // Checked after every value is known, since the controlling field can
    // come after the field it controls.
    for (const f of conditional) if (conditionMet(f.required_if, values)) throw httpError(400, `${f.label} is required`);
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
    // Best-effort proof of presence: the device's own geolocation at the
    // moment of filing, not a field anyone fills in. Silently absent when the
    // browser didn't provide one (denied, unsupported, or indoors with no
    // fix) — a report is never blocked on it.
    let geo = null;
    if (body.geo && typeof body.geo === 'object') {
      const lat = Number(body.geo.lat), lon = Number(body.geo.lon);
      if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        const acc = Number(body.geo.accuracy);
        geo = { lat, lon, accuracy: Number.isFinite(acc) ? Math.round(acc) : null };
      }
    }
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
      submitted_at: now.toISOString(), geo,
      status: 'OPEN', outcome: null, feedback: null, actioned_by: null, actioned_at: null,
      kit_check: kitCheck, client_share: null,
    };
    if (files.length) {
      const dir = formFilesDir(id);
      fs.mkdirSync(dir, { recursive: true });
      for (const f of files) fs.writeFileSync(path.join(dir, `${f.file_id}${IMAGE_EXT[f.mimetype]}`), f.bytes);
    }
    db.form_submissions.push(sub);
    const filedEntry = appendTrail(sub, { action: 'filed', summary: 'Report filed', by: user.display_name, by_user_id: user.id });

    if (sub.visibility === 'RESTRICTED') {
      // Nothing identifying: not the form type, not the subject, not the
      // submitter. The reference alone proves, in the audit trail, that a
      // restricted report was filed and when.
      logEvent('form.submitted_restricted', `RESTRICTED REPORT ${sub.reference} FILED`, { submission_id: sub.id, trail_hash: filedEntry.hash });
      const readers = db.form_grants.filter((g) => g.definition_id === d.id).map((g) => g.user_id);
      pushToUsers(readers, { title: 'Restricted report filed', body: `${sub.reference} needs review`, url: `/forms.html?id=${sub.id}`, tag: 'cccs-restricted' });
    } else {
      logEvent('form.submitted', `${d.name.toUpperCase()} ${sub.reference} FILED BY ${user.display_name} — ${subjectType.replace('_', ' ')} ${subjectLabel}`, { submission_id: sub.id, subject_type: subjectType, subject_id: sub.subject_id, trail_hash: filedEntry.hash });
      // Control-only (targeted with an empty officer list); officers see
      // their own via the list route.
      broadcast('form.submitted', submissionSummary(sub), { personnelIds: [] });
      // A HIGH/CRITICAL severity answer is itself the signal to escalate —
      // same push channel the dashboard's other alerts use, on top of (not
      // instead of) the ordinary broadcast above, so control sees it land on
      // the board too, not only in a notification.
      const severity = severityOf(sub);
      if (severity === 'HIGH' || severity === 'CRITICAL') {
        pushToRoles(CONTROL, { title: `${severity} severity — ${sub.reference}`, body: `${d.name}: ${subjectLabel}`, url: `/forms.html?id=${sub.id}`, tag: 'cccs-incident-severity' });
      }
      // A ticked alert box (possible RIDDOR, personal-data breach, CQC
      // notification) starts a legal clock, so control hears at once —
      // whatever severity the officer chose.
      const alerts = sub.fields.filter((f) => f.type === 'checkbox' && f.alert && values[f.id] === true);
      if (alerts.length) {
        sub.alerts = alerts.map((f) => f.id);
        logEvent('form.alert', `${sub.reference} FLAGGED: ${alerts.map((f) => f.label.toUpperCase()).join('; ')}`, { submission_id: sub.id, alerts: sub.alerts });
        pushToRoles(CONTROL, { title: `Needs a manager now — ${sub.reference}`, body: alerts.map((f) => f.label).join('; ').slice(0, 180), url: `/forms.html?id=${sub.id}`, tag: 'cccs-form-alert' });
      }
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
    // ?q= searches everything a reader can already see on the report: its
    // reference, form, what it's about, who filed it, and every typed answer
    // (so a name written in "people involved" or a use-of-force subject's
    // description is findable). Every word must appear somewhere. Only runs
    // after canRead(), so it can never surface a report the reader couldn't
    // open anyway. Investigation notes are not searched: their readers are
    // narrower than the report's.
    const terms = searchTerms(query.get('q'));
    if (terms.length) {
      return db.form_submissions
        .filter((s) => canRead(s, user))
        .filter((s) => status === 'ALL' || (s.status || 'OPEN') === status
          || (status === 'INVESTIGATING' && ['UNDER_INVESTIGATION', 'RETURNED_FOR_CORRECTION'].includes(s.status)))
        .filter((s) => (!subjectType || s.subject_type === subjectType.toUpperCase())
          && (!subjectId || s.subject_id === Number(subjectId))
          && (!defId || s.definition_id === Number(defId)))
        .map((s) => ({ s, hit: searchHit(s, terms) }))
        .filter((x) => x.hit)
        .sort((a, b) => (a.s.submitted_at < b.s.submitted_at ? 1 : -1))
        .slice(0, limit)
        .map((x) => ({ ...submissionSummary(x.s), match: x.hit.match }));
    }
    return db.form_submissions
      .filter((s) => canRead(s, user))
      .filter((s) => status === 'ALL' || (s.status || 'OPEN') === status
        || (status === 'INVESTIGATING' && ['UNDER_INVESTIGATION', 'RETURNED_FOR_CORRECTION'].includes(s.status)))
      .filter((s) => (!subjectType || s.subject_type === subjectType.toUpperCase())
        && (!subjectId || s.subject_id === Number(subjectId))
        && (!defId || s.definition_id === Number(defId)))
      .sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : -1))
      .slice(0, limit)
      .map(submissionSummary);
  });

  route('GET', '/api/form-submissions/:id', ALL, ({ params, user }) => {
    const sub = readableSubmission(params.id, user);
    noteAccess(sub, user, 'viewed', 'Opened the report');
    return { ...forViewer(sub, user), editable: canEdit(sub, user), can_investigate: canInvestigate(sub, user), can_see_trail: canSeeTrail(sub, user) };
  });

  route('GET', '/api/form-submissions/:id/files/:fileId', ALL, ({ params, user }) => {
    const sub = readableSubmission(params.id, user);
    const f = sub.files.find((x) => x.file_id === params.fileId);
    if (!f) throw httpError(404, 'file not found');
    noteAccess(sub, user, 'viewed_file', 'Opened a photo or signature');
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
    if (!CLOSEABLE_STATUSES.includes(sub.status || 'OPEN')) throw httpError(409, `already actioned (${sub.outcome}) by ${sub.actioned_by}`);
    const outcome = String(body.outcome || '').toUpperCase();
    if (!REVIEW_OUTCOMES.includes(outcome)) throw httpError(400, `outcome must be one of ${REVIEW_OUTCOMES.join(', ')}`);
    const feedback = String(body.feedback || '').trim().slice(0, 2000);
    if (!feedback && outcome !== 'NOTED') throw httpError(400, 'feedback is required when approving or rejecting');
    // Closing an investigation is a sign-off: it must say what was found and
    // why it happened, and nothing it set in motion can be left hanging.
    const inv = sub.investigation && sub.investigation.started_at ? sub.investigation : null;
    if (inv) {
      if (!inv.findings || !inv.root_cause) throw httpError(409, 'record the findings and the root cause before signing off the investigation');
      const open = (inv.actions || []).filter((a) => a.status === 'OPEN');
      if (open.length) throw httpError(409, `${open.length} action${open.length === 1 ? ' is' : 's are'} still open — mark ${open.length === 1 ? 'it' : 'them'} done, or cancel with a reason, before signing off`);
      if (!feedback) throw httpError(400, 'write a closing summary to sign off the investigation');
    }
    Object.assign(sub, { status: 'ACTIONED', outcome, feedback: feedback || null, actioned_by: user.display_name, actioned_by_user_id: user.id, actioned_at: new Date().toISOString() });
    if (inv) {
      if (!Array.isArray(inv.sign_offs)) inv.sign_offs = [];
      inv.sign_offs.push({ by: user.display_name, by_user_id: user.id, at: sub.actioned_at, outcome, statement: feedback,
        independent: !inv.investigator_user_id || inv.investigator_user_id !== user.id });
    }
    const closeEntry = track(sub, user, inv ? 'signed_off' : 'actioned', `${inv ? 'Investigation signed off' : 'Reviewed'}: ${outcome.toLowerCase()}`, { details: { outcome, feedback: feedback || null } });
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
      { submission_id: sub.id, trail_hash: closeEntry.hash });
    flushNow();
    return publicSubmission(sub);
  });

  /** Pushes to whoever can already read this submission — the same
   * grant-holders for a RESTRICTED report, or every ADMIN for a STANDARD
   * one — rather than a named assignee, matching "a pool, not a person". */
  function notifyReviewPool(sub, title, body) {
    if (effectiveVisibility(sub) === 'RESTRICTED') {
      const readers = db.form_grants.filter((g) => g.definition_id === sub.definition_id).map((g) => g.user_id);
      pushToUsers(readers, { title, body, url: `/forms.html?id=${sub.id}`, tag: 'cccs-investigation' });
    } else {
      pushToRoles(ADMIN, { title, body, url: `/forms.html?id=${sub.id}`, tag: 'cccs-investigation' });
    }
  }

  /* ---- Investigations ------------------------------------------------
   * OPEN → UNDER_INVESTIGATION (start) ⇄ RETURNED_FOR_CORRECTION → ACTIONED
   * (/action, which for an investigated report is the sign-off), and back to
   * UNDER_INVESTIGATION if it is reopened. Any ADMIN in the review pool can
   * start one and name an investigator; the investigator (who may be a
   * supervisor) then works it alongside the admins. Every change is in the
   * report's own trail with before and after. */
  const investigable = (sub) => ['UNDER_INVESTIGATION', 'RETURNED_FOR_CORRECTION'].includes(sub.status);
  function workableInvestigation(params, user) {
    const sub = readableSubmission(params.id, user);
    if (!canInvestigate(sub, user)) throw httpError(403, 'only an admin or the assigned investigator can work on this investigation');
    if (!investigable(sub)) throw httpError(409, sub.status === 'ACTIONED' ? 'this investigation is signed off — reopen it to make changes' : 'start an investigation first');
    if (!sub.investigation) sub.investigation = blankInvestigation();
    for (const [k, v] of Object.entries(blankInvestigation())) if (!(k in sub.investigation)) sub.investigation[k] = v;
    return sub;
  }
  /** An investigator has to be someone who could read the report anyway:
   * a control-room user, and for a RESTRICTED report one named on a grant. */
  function eligibleInvestigators(sub) {
    return db.users.filter((u) => u.active !== false && !u.deleted_at && isControlRole(u.role) && canRead(sub, u))
      .map((u) => ({ id: u.id, display_name: u.display_name, role: u.role }));
  }
  function assignInvestigator(sub, investigatorId, user) {
    const target = eligibleInvestigators(sub).find((u) => u.id === Number(investigatorId));
    if (!target) throw httpError(400, 'that person cannot be the investigator — they must be a control-room user who can already read this report');
    const was = sub.investigation.investigator;
    Object.assign(sub.investigation, { investigator: target.display_name, investigator_user_id: target.id, assigned_at: new Date().toISOString() });
    if (target.id !== user.id) pushToUsers([target.id], { title: 'Investigation assigned to you', body: `${sub.reference} — open it in Reports`, url: `/forms.html?id=${sub.id}`, tag: 'cccs-investigation' });
    return { target, was };
  }

  /** Claims a report for investigation — any ADMIN who can already read it.
   * The investigator defaults to whoever starts it, or can be named now
   * (investigator_user_id) or later (/investigation/assign). */
  route('POST', '/api/form-submissions/:id/investigation/start', ADMIN, ({ params, body, user }) => {
    const sub = readableSubmission(params.id, user);
    if ((sub.status || 'OPEN') !== 'OPEN') throw httpError(409, `cannot start an investigation from status ${sub.status}`);
    sub.status = 'UNDER_INVESTIGATION';
    sub.investigation = { ...blankInvestigation(), started_by: user.display_name, started_by_user_id: user.id, started_at: new Date().toISOString(),
      investigator: user.display_name, investigator_user_id: user.id, assigned_at: new Date().toISOString() };
    if (body && body.investigator_user_id && Number(body.investigator_user_id) !== user.id) assignInvestigator(sub, body.investigator_user_id, user);
    if (!sub.risk_assessment) sub.risk_assessment = blankRiskAssessment();
    const entry = track(sub, user, 'investigation_started', `Investigation started; investigator ${sub.investigation.investigator}`);
    logEvent('form.investigation_started', `${user.display_name} STARTED INVESTIGATING ${effectiveVisibility(sub) === 'RESTRICTED' ? 'A RESTRICTED REPORT' : sub.reference}`, { submission_id: sub.id, trail_hash: entry.hash });
    flushNow();
    return publicSubmission(sub);
  });

  route('GET', '/api/form-submissions/:id/investigators', ADMIN, ({ params, user }) => eligibleInvestigators(readableSubmission(params.id, user)));

  route('POST', '/api/form-submissions/:id/investigation/assign', ADMIN, ({ params, body, user }) => {
    const sub = workableInvestigation(params, user);
    const { target, was } = assignInvestigator(sub, body && body.user_id, user);
    trackAndLog(sub, user, 'assigned', `Investigator ${was ? `changed from ${was} to` : 'set to'} ${target.display_name}`, { changes: [{ field: 'investigator', label: 'Investigator', from: was || null, to: target.display_name }] });
    flushNow();
    return publicSubmission(sub);
  });

  const INVESTIGATION_FIELDS = Object.keys(INVESTIGATION_LABELS);
  route('PATCH', '/api/form-submissions/:id/investigation', CONTROL, ({ params, body, user }) => {
    const sub = workableInvestigation(params, user);
    const changes = [];
    for (const f of INVESTIGATION_FIELDS) {
      if (!(f in body)) continue;
      const next = String(body[f] ?? '').trim().slice(0, 4000);
      const prev = sub.investigation[f] || '';
      if (next === prev) continue;
      changes.push({ field: f, label: INVESTIGATION_LABELS[f], from: prev || null, to: next || null });
      sub.investigation[f] = next;
    }
    if (changes.length) {
      trackAndLog(sub, user, 'updated', `Updated ${changes.map((c) => c.label.toLowerCase()).join(', ')}`, { changes });
      flushNow();
    }
    return publicSubmission(sub);
  });

  route('PATCH', '/api/form-submissions/:id/risk-assessment', CONTROL, ({ params, body, user }) => {
    const sub = workableInvestigation(params, user);
    if (!sub.risk_assessment) sub.risk_assessment = blankRiskAssessment();
    const ra = sub.risk_assessment;
    const before = { ...ra };
    if ('likelihood' in body) { const v = String(body.likelihood || '').toUpperCase(); if (v && !RISK_LEVELS.includes(v)) throw httpError(400, `likelihood must be one of ${RISK_LEVELS.join(', ')}`); ra.likelihood = v || null; }
    if ('severity' in body) { const v = String(body.severity || '').toUpperCase(); if (v && !RISK_LEVELS.includes(v)) throw httpError(400, `severity must be one of ${RISK_LEVELS.join(', ')}`); ra.severity = v || null; }
    if ('control_measures' in body) ra.control_measures = String(body.control_measures || '').trim().slice(0, 4000);
    if ('review_date' in body) { if (body.review_date && isNaN(Date.parse(body.review_date))) throw httpError(400, 'review_date must be a date'); ra.review_date = body.review_date ? String(body.review_date).slice(0, 10) : null; }
    ra.risk_rating = ra.likelihood && ra.severity ? RISK_MATRIX[ra.likelihood][ra.severity] : null;
    const RA_LABELS = { likelihood: 'Likelihood', severity: 'Severity', risk_rating: 'Risk rating', control_measures: 'Control measures', review_date: 'Review date' };
    const changes = Object.keys(RA_LABELS).filter((k) => (before[k] || null) !== (ra[k] || null)).map((k) => ({ field: `risk.${k}`, label: RA_LABELS[k], from: before[k] || null, to: ra[k] || null }));
    if (changes.length) {
      if (ra.risk_rating) { ra.assessed_by = user.display_name; ra.assessed_at = new Date().toISOString(); }
      trackAndLog(sub, user, 'risk_assessed', `Risk assessment updated${ra.risk_rating ? ` (rating ${ra.risk_rating})` : ''}`, { changes });
      flushNow();
    }
    return publicSubmission(sub);
  });

  /* Actions: what the investigation says must happen (retrain an officer,
   * change an assignment instruction, fix a lock), who owns it and by when.
   * An investigation cannot be signed off while one is still OPEN; one that
   * won't happen is CANCELLED with a reason, never deleted. */
  function cleanDue(v) {
    if (v === undefined || v === null || v === '') return null;
    if (isNaN(Date.parse(v))) throw httpError(400, 'due_date must be a date');
    return String(v).slice(0, 10);
  }
  route('POST', '/api/form-submissions/:id/investigation/actions', CONTROL, ({ params, body, user }) => {
    const sub = workableInvestigation(params, user);
    const description = String((body && body.description) || '').trim().slice(0, 1000);
    if (!description) throw httpError(400, 'describe the action');
    const actions = sub.investigation.actions;
    const action = {
      id: `A${actions.length + 1}`, description, owner: String(body.owner || '').trim().slice(0, 120) || null,
      due_date: cleanDue(body.due_date), status: 'OPEN',
      created_by: user.display_name, created_by_user_id: user.id, created_at: new Date().toISOString(),
      closed_by: null, closed_at: null, note: null,
    };
    actions.push(action);
    trackAndLog(sub, user, 'action_added', `Action ${action.id} added: ${description.slice(0, 120)}`, { changes: [{ field: `action.${action.id}`, label: `Action ${action.id}`, from: null, to: description }] });
    flushNow();
    return publicSubmission(sub);
  });
  route('PATCH', '/api/form-submissions/:id/investigation/actions/:actionId', CONTROL, ({ params, body, user }) => {
    const sub = workableInvestigation(params, user);
    const action = sub.investigation.actions.find((a) => a.id === params.actionId);
    if (!action) throw httpError(404, 'action not found');
    const before = { ...action };
    if ('description' in body) { const d = String(body.description || '').trim().slice(0, 1000); if (!d) throw httpError(400, 'an action needs a description'); action.description = d; }
    if ('owner' in body) action.owner = String(body.owner || '').trim().slice(0, 120) || null;
    if ('due_date' in body) action.due_date = cleanDue(body.due_date);
    if ('status' in body) {
      const st = String(body.status || '').toUpperCase();
      if (!ACTION_STATUSES.includes(st)) throw httpError(400, `status must be one of ${ACTION_STATUSES.join(', ')}`);
      const note = String(body.note || '').trim().slice(0, 1000);
      if (st === 'CANCELLED' && !note) throw httpError(400, 'say why the action is being cancelled');
      if (st !== action.status) {
        action.status = st;
        action.note = note || action.note;
        action.closed_by = st === 'OPEN' ? null : user.display_name;
        action.closed_at = st === 'OPEN' ? null : new Date().toISOString();
      }
    }
    const LABELS = { description: 'Description', owner: 'Owner', due_date: 'Due', status: 'Status', note: 'Note' };
    const changes = Object.keys(LABELS).filter((k) => (before[k] || null) !== (action[k] || null)).map((k) => ({ field: `action.${action.id}.${k}`, label: `Action ${action.id} ${LABELS[k].toLowerCase()}`, from: before[k] || null, to: action[k] || null }));
    if (changes.length) {
      trackAndLog(sub, user, 'action_updated', `Action ${action.id} ${before.status !== action.status ? `marked ${action.status.toLowerCase()}` : 'updated'}`, { changes });
      flushNow();
    }
    return publicSubmission(sub);
  });

  /* External notifications: who outside the business was told, when, and
   * their reference — or a recorded decision that it wasn't needed, and why.
   * Append-only: a mistake is corrected by recording another entry. */
  route('POST', '/api/form-submissions/:id/investigation/notifications', CONTROL, ({ params, body, user }) => {
    const sub = workableInvestigation(params, user);
    const bodyKey = String((body && body.body) || '').toUpperCase();
    if (!NOTIFY_BODIES[bodyKey]) throw httpError(400, `body must be one of ${Object.keys(NOTIFY_BODIES).join(', ')}`);
    const decision = String(body.decision || 'NOTIFIED').toUpperCase();
    if (!NOTIFY_DECISIONS.includes(decision)) throw httpError(400, `decision must be one of ${NOTIFY_DECISIONS.join(', ')}`);
    const notes = String(body.notes || '').trim().slice(0, 1000);
    if (decision === 'NOT_REQUIRED' && !notes) throw httpError(400, 'say why it does not need to be notified');
    let notifiedAt = null;
    if (decision === 'NOTIFIED') {
      if (!body.notified_at || isNaN(Date.parse(body.notified_at))) throw httpError(400, 'when were they told? (notified_at)');
      notifiedAt = new Date(body.notified_at).toISOString();
    }
    const list = sub.investigation.external_notifications;
    const entry = {
      id: `N${list.length + 1}`, body: bodyKey, label: bodyKey === 'OTHER' && body.label ? String(body.label).trim().slice(0, 120) : NOTIFY_BODIES[bodyKey],
      decision, notified_at: notifiedAt, reference: String(body.reference || '').trim().slice(0, 200) || null, notes: notes || null,
      recorded_by: user.display_name, recorded_by_user_id: user.id, recorded_at: new Date().toISOString(),
    };
    list.push(entry);
    trackAndLog(sub, user, 'notification_recorded', decision === 'NOTIFIED' ? `${entry.label} notified${entry.reference ? ` (ref ${entry.reference})` : ''}` : `${entry.label}: recorded as not required`, { details: entry });
    flushNow();
    return publicSubmission(sub);
  });

  /** New evidence after sign-off: back under investigation, with a reason.
   * The earlier sign-off stays in sign_offs and in the trail. */
  route('POST', '/api/form-submissions/:id/investigation/reopen', ADMIN, ({ params, body, user }) => {
    const sub = readableSubmission(params.id, user);
    if (sub.status !== 'ACTIONED' || !(sub.investigation && sub.investigation.started_at)) throw httpError(409, 'only a signed-off investigation can be reopened');
    const reason = String((body && body.reason) || '').trim().slice(0, 1000);
    if (!reason) throw httpError(400, 'say why it is being reopened');
    sub.status = 'UNDER_INVESTIGATION';
    trackAndLog(sub, user, 'reopened', `Investigation reopened: ${reason}`, { details: { reason, previous_outcome: sub.outcome } });
    flushNow();
    return publicSubmission(sub);
  });

  /** The report's full trail, a check of its hash chain, and how many of
   * its entries are anchored in the global trail (the rest are older than
   * RETAIN_AUDIT_DAYS, or predate this feature). */
  route('GET', '/api/form-submissions/:id/audit-trail', CONTROL, ({ params, user }) => {
    const sub = readableSubmission(params.id, user);
    if (!canSeeTrail(sub, user)) throw httpError(403, 'only an admin or the assigned investigator can see who has opened this report');
    const trail = sub.audit_trail || [];
    const check = verifyTrail(trail);
    let anchored = null;
    if (queryAudit) {
      const hashes = new Set(queryAudit({ submissionId: sub.id, limit: 5000 }).map((e) => e.data && e.data.trail_hash).filter(Boolean));
      anchored = trail.filter((e) => hashes.has(e.hash)).length;
    }
    return { reference: sub.reference, integrity: { ...check, anchored_in_global_trail: anchored }, entries: trail };
  });

  route('GET', '/api/form-submissions/:id/investigation-report', CONTROL, ({ params, user }) => {
    const sub = readableSubmission(params.id, user);
    if (!canSeeTrail(sub, user)) throw httpError(403, 'only an admin or the assigned investigator can export the investigation report');
    if (!(sub.investigation && sub.investigation.started_at)) throw httpError(409, 'no investigation has been started on this report');
    noteAccess(sub, user, 'exported', 'Exported the investigation report');
    flushNow();
    return {
      __body: submissionPdf(sub, { investigation: true }),
      __headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${sub.reference}-investigation.pdf"`, 'cache-control': 'no-store' },
    };
  });

  /** Sends it back to whoever filed it, with a reason, and opens an edit
   * window on the original report — see canEdit()/the PATCH route below.
   * Every round of this is kept (correction_requests), not just the last. */
  route('POST', '/api/form-submissions/:id/return-for-correction', ADMIN, ({ params, body, user }) => {
    const sub = readableSubmission(params.id, user);
    if (sub.status !== 'UNDER_INVESTIGATION') throw httpError(409, 'only a report under investigation can be returned for correction');
    const reason = String(body.reason || '').trim().slice(0, 1000);
    if (!reason) throw httpError(400, 'say what needs correcting or adding');
    sub.status = 'RETURNED_FOR_CORRECTION';
    if (!Array.isArray(sub.correction_requests)) sub.correction_requests = [];
    sub.correction_requests.push({ at: new Date().toISOString(), by: user.display_name, by_user_id: user.id, reason });
    const returnEntry = track(sub, user, 'returned_for_correction', 'Returned to the officer for correction', { details: { reason } });
    const restricted = effectiveVisibility(sub) === 'RESTRICTED';
    if (sub.submitted_by_personnel_id && !restricted) {
      const msg = {
        id: nextId('messages'),
        body: `${sub.reference} (${sub.definition_name}) was returned to you for correction by ${user.display_name}: ${reason}`.slice(0, 1000),
        from_label: 'CONTROL', from_personnel_id: null, from_mdt_id: null,
        to_personnel_id: sub.submitted_by_personnel_id, to_mdt_id: null, to_label: sub.submitted_by_name,
        state: 'DELIVERED', sent_at: new Date().toISOString(), read_at: null,
      };
      if (Array.isArray(db.messages)) db.messages.push(msg);
      broadcast('message.received', msg, { personnelIds: [sub.submitted_by_personnel_id] });
    }
    if (sub.submitted_by_user_id) {
      pushToUsers([sub.submitted_by_user_id], { title: 'Report returned for correction', body: `${sub.reference} needs more information — open it to see what's needed`, url: `/forms.html?id=${sub.id}`, tag: 'cccs-returned' });
    }
    logEvent(restricted ? 'form.returned_restricted' : 'form.returned', restricted ? `RESTRICTED REPORT ${sub.reference} RETURNED FOR CORRECTION` : `${sub.definition_name.toUpperCase()} ${sub.reference} RETURNED FOR CORRECTION BY ${user.display_name}: ${reason}`, { submission_id: sub.id, trail_hash: returnEntry.hash });
    flushNow();
    return publicSubmission(sub);
  });

  /**
   * Sharing a redacted copy with the client whose site the report is about.
   * Deliberately separate from RESTRICTED/STANDARD, which governs STAFF
   * read access: a RESTRICTED report can be shared too, once an admin has
   * reviewed it and written a copy fit for an outsider to read — sharing is
   * an admin decision about disclosure, not a side effect of visibility.
   *
   * There is no automatic redaction. A name can appear anywhere in a free
   * narrative, not just in a field called "name", so the only values that
   * ever leave for a client are the ones an admin typed into this request —
   * never sub.values itself. Signatures and photos are never included in a
   * shared copy at all (a signature IS a name; a photo may show a face) —
   * stripped here regardless of what the request sends, not merely by
   * instruction to the admin UI.
   *
   * Gated to ADMIN, the same bar as actioning a report and deleting an
   * actioned one — the highest in this file, because this is the one action
   * that sends a report's content outside the business.
   */
  function cleanSharedValues(fields, raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, 'values must be an object');
    const known = new Set(fields.map((f) => f.id));
    for (const k of Object.keys(raw)) if (!known.has(k)) throw httpError(400, `unknown field ${k}`);
    const values = {};
    for (const f of fields) {
      if (f.type === 'signature' || f.type === 'photo') continue; // never shared, whatever is sent
      const v = raw[f.id];
      if (v === undefined || v === null || v === '') continue; // omitted = left out of the shared copy
      switch (f.type) {
        case 'text': values[f.id] = String(v).trim().slice(0, 500); break;
        case 'textarea': values[f.id] = String(v).trim().slice(0, 5000); break;
        case 'number': { const n = Number(v); if (!Number.isFinite(n)) throw httpError(400, `${f.label} must be a number`); values[f.id] = n; break; }
        case 'select': if (!f.options.includes(String(v))) throw httpError(400, `${f.label}: not one of the options`); values[f.id] = String(v); break;
        case 'severity': if (!SEVERITIES.includes(String(v))) throw httpError(400, `${f.label} must be one of ${SEVERITIES.join(', ')}`); values[f.id] = String(v); break;
        case 'checkbox': values[f.id] = Boolean(v); break;
        case 'date': values[f.id] = String(v).slice(0, 10); break;
        case 'datetime': if (isNaN(Date.parse(v))) throw httpError(400, `${f.label} must be a date and time`); values[f.id] = new Date(v).toISOString(); break;
        default: break;
      }
    }
    return values;
  }
  route('POST', '/api/form-submissions/:id/share', ADMIN, ({ params, body, user }) => {
    const sub = readableSubmission(params.id, user);
    if (!CLIENT_SHAREABLE_SUBJECT_TYPES.includes(sub.subject_type)) throw httpError(400, `a report about a ${sub.subject_type.toLowerCase()} cannot be shared with a client`);
    const values = cleanSharedValues(sub.fields, (body && body.values) || {});
    const subjectLabel = String((body && body.subject_label) || '').trim().slice(0, 200) || sub.subject_label;
    sub.client_share = { values, subject_label: subjectLabel, shared_by: user.display_name, shared_by_user_id: user.id, shared_at: new Date().toISOString() };
    const shareEntry = track(sub, user, 'shared_with_client', 'Redacted copy shared with the client', { details: { subject_label: subjectLabel, fields: Object.keys(values) } });
    logEvent('form.shared_with_client', `${sub.reference} SHARED WITH CLIENT BY ${user.username} (redacted copy)`, { submission_id: sub.id, trail_hash: shareEntry.hash });
    flushNow();
    return publicSubmission(sub);
  });
  route('DELETE', '/api/form-submissions/:id/share', ADMIN, ({ params, user }) => {
    const sub = readableSubmission(params.id, user);
    if (!sub.client_share) throw httpError(409, 'not currently shared with a client');
    sub.client_share = null;
    const unshareEntry = track(sub, user, 'unshared_with_client', 'Client copy withdrawn');
    logEvent('form.unshared_with_client', `${sub.reference} UNSHARED FROM CLIENT BY ${user.username}`, { submission_id: sub.id, trail_hash: unshareEntry.hash });
    flushNow();
    return publicSubmission(sub);
  });

  /** Brand-styled single-report PDF — same navy/amber language and logo
   * treatment as the invoice and contract PDFs (routes-invoices.js,
   * routes-agreements.js), for printing or attaching a report to an email,
   * a claim or a police reference. A photo is embedded only when it's a
   * JPEG — pdf.js's Doc only embeds JPEG (DCTDecode); a PNG photo (none of
   * the defaults produce one, but a custom form could) is noted instead of
   * silently dropped. */
  const FORM_NAVY = [0.047, 0.086, 0.141], FORM_AMBER = [0.949, 0.663, 0.235], FORM_WHITE = [1, 1, 1];
  const fmtLong = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
  function submissionPdf(sub, { investigation = false } = {}) {
    const grey = [0.35, 0.38, 0.42];
    const doc = new Doc({ footer: `Echelon — report ${sub.reference}` });
    const bandH = 100;
    doc.rect(0, A4.h - bandH, A4.w, bandH, { fill: FORM_NAVY, stroke: null });
    const logoFile = path.join(__dirname, 'public', 'assets', 'echelon-wordmark-navy.jpg');
    if (fs.existsSync(logoFile)) { doc.y = A4.h - 30; doc.image(fs.readFileSync(logoFile), { maxH: 20, maxW: 170, x: doc.margin }); }
    else doc.text('ECHELON', doc.margin, A4.h - 40, { size: 17, bold: true, color: FORM_WHITE });
    const label = effectiveVisibility(sub) === 'RESTRICTED' ? 'RESTRICTED REPORT' : 'FIELD REPORT';
    const rightEdge = A4.w - doc.margin;
    doc.text(label, rightEdge - doc.textWidth(label, 10, true), A4.h - 36, { size: 10, bold: true, color: FORM_AMBER });
    doc.text(sub.reference, rightEdge - doc.textWidth(sub.reference, 14, true), A4.h - 54, { size: 14, bold: true, color: FORM_WHITE });
    doc.y = A4.h - bandH - 26;

    doc.heading(sub.definition_name, 13);
    const severity = severityOf(sub);
    doc.pairs([
      [SUBJECT_LABEL[sub.subject_type] || sub.subject_type, sub.subject_label],
      ['Filed by', sub.submitted_by_name],
      ['Filed at', fmtLong(sub.submitted_at)],
      ...(severity ? [['Severity', severity]] : []),
      ...(sub.geo ? [['Location', `${sub.geo.lat.toFixed(5)}, ${sub.geo.lon.toFixed(5)}${sub.geo.accuracy ? ` (±${sub.geo.accuracy}m)` : ''}`]] : []),
      ['Status', sub.status === 'ACTIONED' ? `${sub.outcome} — by ${sub.actioned_by}, ${fmtLong(sub.actioned_at)}` : 'Open — not yet reviewed'],
    ], { labelWidth: 110 });
    doc.rule();

    const valStr = (f) => {
      const v = sub.values[f.id];
      if (v === null || v === undefined || v === '') return '—';
      if (f.type === 'checkbox') return v ? 'Yes' : 'No';
      if (f.type === 'datetime') return fmtLong(v);
      if (f.type === 'signature') return `Signed by ${v.signer_name} — ${fmtLong(v.signed_at)}`;
      if (f.type === 'photo') return 'Photo on file — see below, or view in CCCS';
      return String(v);
    };
    doc.pairs(sub.fields.filter((f) => f.type !== 'signature' && f.type !== 'photo').map((f) => [f.label, valStr(f)]), { labelWidth: 220 });

    for (const f of sub.fields.filter((x) => x.type === 'photo')) {
      const v = sub.values[f.id];
      const fileRec = v && sub.files.find((x) => x.file_id === v.file_id);
      if (!fileRec) continue;
      doc.heading(f.label, 10);
      if (fileRec.mimetype === 'image/jpeg') {
        try {
          const filePath = path.join(formFilesDir(sub.id), fileRec.filename);
          doc.image(fs.readFileSync(filePath), { maxW: 260, maxH: 200, x: doc.margin });
          continue;
        } catch (e) { console.warn(`[forms] could not embed photo for ${sub.reference}:`, e.message); }
      }
      doc.para('Photo on file — not embedded in this PDF; view it in CCCS.', { size: 9, color: grey });
    }
    if (sub.feedback) { doc.heading(investigation ? 'Closing summary' : 'Review feedback', 11); doc.para(sub.feedback, { size: 9.5 }); }
    if (investigation) investigationPdfSections(doc, sub);
    return doc.toBuffer();
  }
  /** The investigation itself, then the report's full trail and the result
   * of checking it — what an inspector, the SIA, an insurer or a tribunal
   * would ask to see. */
  function investigationPdfSections(doc, sub) {
    const grey = [0.35, 0.38, 0.42];
    const inv = sub.investigation;
    const ra = sub.risk_assessment || {};
    doc.newPage();
    doc.heading('Investigation', 13);
    doc.pairs([
      ['Started', `${fmtLong(inv.started_at)} by ${inv.started_by}`],
      ['Investigator', inv.investigator ? `${inv.investigator}${inv.assigned_at ? ` (from ${fmtLong(inv.assigned_at)})` : ''}` : '—'],
      ['Status', sub.status === 'ACTIONED' ? `Signed off — ${sub.outcome} by ${sub.actioned_by}, ${fmtLong(sub.actioned_at)}` : sub.status === 'RETURNED_FOR_CORRECTION' ? 'Returned to the officer for correction' : 'Under investigation'],
    ], { labelWidth: 130 });
    doc.pairs(Object.entries(INVESTIGATION_LABELS).map(([k, label]) => [label, inv[k] || '—']), { labelWidth: 130 });
    doc.heading('Risk assessment', 11);
    doc.pairs([
      ['Likelihood', ra.likelihood || '—'], ['Severity', ra.severity || '—'], ['Risk rating', ra.risk_rating || '—'],
      ['Control measures', ra.control_measures || '—'], ['Review date', ra.review_date || '—'],
      ...(ra.assessed_by ? [['Assessed', `${ra.assessed_by}, ${fmtLong(ra.assessed_at)}`]] : []),
    ], { labelWidth: 130 });
    doc.heading('Actions', 11);
    if ((inv.actions || []).length) {
      doc.table([{ title: 'Ref', width: 0.07 }, { title: 'Action', width: 0.41 }, { title: 'Owner', width: 0.16 }, { title: 'Due', width: 0.12 }, { title: 'Status', width: 0.24 }],
        inv.actions.map((a) => [a.id, a.description, a.owner || '—', a.due_date || '—',
          a.status === 'OPEN' ? 'Open' : `${a.status === 'DONE' ? 'Done' : 'Cancelled'} ${fmtLong(a.closed_at)}${a.note ? ` — ${a.note}` : ''}`]));
    } else doc.para('No actions recorded.', { size: 9.5, color: grey });
    doc.heading('External notifications', 11);
    if ((inv.external_notifications || []).length) {
      doc.table([{ title: 'Who', width: 0.26 }, { title: 'Decision', width: 0.18 }, { title: 'When / reference', width: 0.26 }, { title: 'Notes', width: 0.30 }],
        inv.external_notifications.map((n) => [n.label, n.decision === 'NOTIFIED' ? 'Notified' : 'Not required',
          n.decision === 'NOTIFIED' ? `${fmtLong(n.notified_at)}${n.reference ? ` · ${n.reference}` : ''}` : '—', `${n.notes || ''} (recorded by ${n.recorded_by})`]));
    } else doc.para('No notification decisions recorded.', { size: 9.5, color: grey });
    if ((sub.correction_requests || []).length) {
      doc.heading('Returned for correction', 11);
      for (const c of sub.correction_requests) doc.para(`${fmtLong(c.at)} — ${c.by}: ${c.reason}`, { size: 9.5 });
    }
    if ((inv.sign_offs || []).length) {
      doc.heading('Sign-off', 11);
      for (const so of inv.sign_offs) doc.para(`${fmtLong(so.at)} — ${so.by} (${so.outcome}${so.independent ? '' : ', who was also the investigator'}): ${so.statement}`, { size: 9.5 });
    }
    const trail = sub.audit_trail || [];
    const check = verifyTrail(trail);
    doc.newPage();
    doc.heading('Audit trail', 13);
    doc.para(check.ok
      ? `${trail.length} entries. Integrity check passed: every entry links to the one before it and matches its fingerprint (SHA-256). Last fingerprint ${check.head_hash || '—'}.`
      : `Integrity check FAILED at entry ${check.broken_at}: ${check.reason}.`, { size: 9, color: check.ok ? grey : [0.7, 0.1, 0.1] });
    const changeText = (e) => (e.changes || []).map((c) => `${c.label}: ${c.from == null || c.from === '' ? '(blank)' : String(c.from).slice(0, 300)} → ${c.to == null || c.to === '' ? '(blank)' : String(c.to).slice(0, 300)}`).join('\n');
    doc.table([{ title: '#', width: 0.05 }, { title: 'When', width: 0.18 }, { title: 'Who', width: 0.17 }, { title: 'What', width: 0.60 }],
      trail.map((e) => [String(e.seq), fmtLong(e.at), e.by || '—', [e.summary, changeText(e)].filter(Boolean).join('\n')]));
    doc.para(`Exported ${fmtLong(new Date().toISOString())}. This export is itself recorded in the trail.`, { size: 8.5, color: grey });
  }
  route('GET', '/api/form-submissions/:id/pdf', ALL, ({ params, user }) => {
    const sub = readableSubmission(params.id, user);
    noteAccess(sub, user, 'exported', 'Downloaded the report PDF');
    return {
      __body: submissionPdf(sub),
      __headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${sub.reference}.pdf"`, 'cache-control': effectiveVisibility(sub) === 'RESTRICTED' ? 'no-store' : 'private, max-age=0' },
    };
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
  /** Two different reasons a report is editable: a vehicle report, self-
   * service, within a short window — or ANY report a manager has
   * explicitly returned for correction, no time limit (the manager asked,
   * so there's no "too late" for answering them), open to the original
   * officer (or SYSTEM_ADMIN) regardless of form type. */
  function canEdit(sub, user) {
    if (sub.status === 'RETURNED_FOR_CORRECTION') {
      return user.role === 'SYSTEM_ADMIN' || sub.submitted_by_user_id === user.id;
    }
    if (sub.subject_type !== 'VEHICLE') return false;
    if (user.role === 'SYSTEM_ADMIN') return true;
    return sub.submitted_by_user_id === user.id && (sub.status || 'OPEN') === 'OPEN' && Date.now() - Date.parse(sub.submitted_at) < EDIT_WINDOW_MS;
  }
  route('PATCH', '/api/form-submissions/:id', ALL, ({ params, body, user }) => {
    const sub = readableSubmission(params.id, user);
    const returning = sub.status === 'RETURNED_FOR_CORRECTION';
    if (sub.subject_type !== 'VEHICLE' && !returning) throw httpError(400, 'only vehicle reports can be edited — other reports stay as filed unless a manager returns them for correction');
    if (!canEdit(sub, user)) throw httpError(403, returning ? 'only the officer who filed this (or an admin) can make the correction' : 'you can edit your own vehicle report only while it is open and for 24 hours after filing — ask an admin');
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
    const amendEntry = track(sub, user, returning ? 'corrected' : 'amended', `${returning ? 'Correction made' : 'Report edited'}: ${reason}`, { changes });
    if (sub.effect_applied) {
      try { reapplyVehicleReport(sub.effect_applied, sub.subject_id, before, sub.values, user, sub); }
      catch (e) { console.warn(`[forms] re-applying ${sub.effect_applied} for ${sub.reference} failed:`, e.message); sub.effect_error = e.message; }
    }
    const restricted = effectiveVisibility(sub) === 'RESTRICTED';
    if (returning) {
      // Ball back in the reviewing manager's court — same pool that
      // returned it, not necessarily the same individual.
      sub.status = 'UNDER_INVESTIGATION';
      notifyReviewPool(sub, 'Correction received', `${sub.reference} was corrected and is ready to review again`);
      logEvent(restricted ? 'form.correction_submitted_restricted' : 'form.correction_submitted',
        restricted ? `RESTRICTED REPORT ${sub.reference} CORRECTED BY ${user.display_name}` : `${sub.definition_name.toUpperCase()} ${sub.reference} CORRECTED BY ${user.display_name}: ${changes.map((c) => c.label).join(', ')} — ${reason}`,
        { submission_id: sub.id, trail_hash: amendEntry.hash });
    } else {
      logEvent('form.amended', restricted ? `RESTRICTED REPORT ${sub.reference} EDITED`
        : `${sub.definition_name.toUpperCase()} ${sub.reference} EDITED BY ${user.display_name}: ${changes.map((c) => c.label).join(', ')} — ${reason}`, { submission_id: sub.id, trail_hash: amendEntry.hash });
    }
    flushNow();
    return { ...forViewer(sub, user), editable: canEdit(sub, user) };
  });
  /** Permanent removal of a report that has already been reviewed. Goes
   * through readableSubmission() like every other read, so a RESTRICTED one
   * needs the admin to be a named reader. A reason is required and kept in
   * the tombstone — "who deleted evidence, and why" is exactly what an audit
   * will ask. */
  route('DELETE', '/api/form-submissions/:id', ADMIN, ({ params, body, user }) => {
    const sub = readableSubmission(params.id, user);
    if ((sub.status || 'OPEN') !== 'ACTIONED') throw httpError(409, 'review a report before deleting it');
    // An investigated report is the record of what the business found and
    // did about an incident; it is kept for the retention period and removed
    // by the retention sweep, not by hand.
    if (sub.investigation && sub.investigation.started_at) throw httpError(409, 'an investigated report cannot be deleted by hand — it is kept for the retention period');
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

  /** The redacted, staff-released reports a client may see for their own
   * site(s) — routes-client.js's own read path into this file, per the
   * header comment there: extending canRead() itself to clients would widen
   * a security-critical invariant for every staff caller too, so client
   * visibility is this entirely separate, admin-opt-in gate instead. Never
   * reads sub.values, sub.submitted_by_name or sub.files — only what an
   * admin explicitly wrote into client_share. */
  function clientVisibleSubmissions(siteIds) {
    const wanted = new Set(siteIds);
    const out = [];
    for (const sub of db.form_submissions) {
      if (!sub.client_share) continue;
      let siteId = null;
      if (sub.subject_type === 'SITE') siteId = sub.subject_id;
      else if (sub.subject_type === 'JOB') { const j = db.jobs.find((x) => x.id === sub.subject_id); siteId = j ? j.site_id : null; }
      else if (sub.subject_type === 'SITE_VISIT') { const v = db.site_visits.find((x) => x.id === sub.subject_id); siteId = v ? v.site_id : null; }
      if (!siteId || !wanted.has(siteId)) continue;
      const share = sub.client_share;
      out.push({
        id: sub.id, reference: sub.reference, definition_name: sub.definition_name,
        site_id: siteId, subject_label: share.subject_label,
        occurred_at: sub.submitted_at, shared_at: share.shared_at,
        fields: sub.fields.filter((f) => f.type !== 'signature' && f.type !== 'photo' && share.values[f.id] !== undefined),
        values: share.values,
      });
    }
    return out.sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1));
  }

  /**
   * A HIGH/CRITICAL report still OPEN SEVERITY_REMIND_MS after filing pushes
   * once more — `severity_reminded_at` makes it one-shot, same shape as
   * routes-attendance.js's `late_alert_at`. RESTRICTED stays RESTRICTED: the
   * reminder goes out content-free, to that form's named readers only, never
   * to CONTROL at large — exactly the same split the original filing push
   * already makes. Actioning a report (or it simply no longer qualifying)
   * just means this never finds it again; nothing to cancel.
   */
  function severityEscalationTick(now = Date.now()) {
    let changed = false;
    for (const sub of db.form_submissions) {
      if ((sub.status || 'OPEN') !== 'OPEN') continue;
      if (sub.severity_reminded_at) continue;
      const severity = severityOf(sub);
      if (severity !== 'HIGH' && severity !== 'CRITICAL') continue;
      if (now - Date.parse(sub.submitted_at) < SEVERITY_REMIND_MS) continue;
      sub.severity_reminded_at = new Date(now).toISOString();
      changed = true;
      const mins = Math.round(SEVERITY_REMIND_MS / 60000);
      if (effectiveVisibility(sub) === 'RESTRICTED') {
        const readers = db.form_grants.filter((g) => g.definition_id === sub.definition_id).map((g) => g.user_id);
        pushToUsers(readers, { title: 'Still awaiting review', body: `${sub.reference} was filed ${mins} min ago and is still open`, url: `/forms.html?id=${sub.id}`, tag: 'cccs-restricted' });
        logEvent('form.severity_reminder_restricted', `RESTRICTED REPORT ${sub.reference} STILL UNREVIEWED ${mins} MIN AFTER FILING`, { submission_id: sub.id });
      } else {
        pushToRoles(CONTROL, { title: `Still open — ${severity} severity`, body: `${sub.reference} (${sub.definition_name}) has not been reviewed`, url: `/forms.html?id=${sub.id}`, tag: 'cccs-incident-severity' });
        logEvent('form.severity_reminder', `${sub.definition_name.toUpperCase()} ${sub.reference} (${severity}) STILL OPEN ${mins} MIN AFTER FILING`, { submission_id: sub.id });
      }
    }
    if (changed) flushNow();
  }
  const severityTimer = setInterval(() => { try { severityEscalationTick(); } catch (e) { console.warn('[forms] severity escalation tick failed:', e.message); } }, 60000);
  if (severityTimer.unref) severityTimer.unref();

  /* ---- DEMS evidence links ---------------------------------------------
   * An incident during a shift is often written up on a report form with no
   * separate job, and the body-worn footage of it is filed in a DEMS case.
   * DEMS can look the report up by its FORM- reference and record the link,
   * which shows on the report like it does on a job. RESTRICTED reports are
   * never offered: DEMS has no grant to read them. */
  const demsForm = (ref) => {
    const r = String(ref || '').trim().toUpperCase();
    const sub = db.form_submissions.find((s) => String(s.reference).toUpperCase() === r);
    return sub && effectiveVisibility(sub) !== 'RESTRICTED' ? sub : null;
  };
  function demsFormSummary(sub) {
    return {
      reference: sub.reference, kind: 'form', incident_type: sub.definition_name, priority: severityOf(sub),
      status: sub.status || 'OPEN', location: sub.subject_label || null,
      site: sub.subject_type === 'SITE' ? sub.subject_label : null,
      created_at: sub.submitted_at, completed_at: sub.actioned_at || null,
      resources: [{ callsign: null, personnel: sub.submitted_by_name, employee_no: null }],
      evidence_links: sub.evidence_links || [],
    };
  }
  function linkDemsEvidence(sub, { caseRef, caseUrl, by, linked }) {
    sub.evidence_links = (sub.evidence_links || []).filter((l) => l.case_ref !== caseRef);
    if (linked) sub.evidence_links.push({ case_ref: caseRef, case_url: caseUrl, linked_by: by, linked_at: new Date().toISOString() });
    const entry = appendTrail(sub, {
      action: linked ? 'evidence_linked' : 'evidence_unlinked',
      summary: `${linked ? 'Linked to' : 'Unlinked from'} DEMS case ${caseRef}${by ? ' by ' + by : ''}`, by: by || 'DEMS', by_user_id: null,
    });
    logEvent(linked ? 'form.evidence_linked' : 'form.evidence_unlinked',
      `${sub.definition_name.toUpperCase()} ${sub.reference} ${linked ? 'LINKED TO' : 'UNLINKED FROM'} DEMS CASE ${caseRef}${by ? ' BY ' + by : ''}`,
      { submission_id: sub.id, case_ref: caseRef, trail_hash: entry.hash });
    flushNow();
    return demsFormSummary(sub);
  }

  return {
    demsForm, demsFormSummary, linkDemsEvidence,
    installDefaults, ensureApplicationForm, ensureVehicleForms, ensureIncidentSeverity, ensureStatementCompliance, activeApplicationForm,
    validateValues, IMAGE_EXT, canRead, effectiveVisibility, clientVisibleSubmissions, severityEscalationTick,
  };
};

module.exports.DEFAULT_FORMS = DEFAULT_FORMS;
