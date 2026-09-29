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
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VISIBILITIES = ['STANDARD', 'RESTRICTED'];
const SUBJECT_TYPES = ['JOB', 'SITE_VISIT', 'SITE', 'PERSONNEL', 'VEHICLE'];
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

module.exports = function registerFormRoutes({
  route, httpError, ALL, ADMIN, db, nextId, logEvent, broadcast, isControlRole,
  assertJobAccess, assertVisitAccess, pushToUsers, UPLOADS_DIR, MIME, flushNow = () => {},
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
    };
  }

  /** A list entry: enough to show a row, no field values. Still only built
   * for submissions canRead() passed — a list is a read like any other. */
  const submissionSummary = (sub) => ({
    id: sub.id, reference: sub.reference, definition_id: sub.definition_id, definition_name: sub.definition_name,
    visibility: effectiveVisibility(sub), subject_type: sub.subject_type, subject_id: sub.subject_id,
    subject_label: sub.subject_label, submitted_by: sub.submitted_by_name, submitted_at: sub.submitted_at,
  });

  function publicDefinition(d, user) {
    const out = {
      id: d.id, key: d.key, name: d.name, description: d.description, version: d.version,
      visibility: d.visibility, subject_types: d.subject_types, fields: d.fields, active: d.active,
    };
    if (user.role === 'SYSTEM_ADMIN') {
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
    return db.form_definitions.filter((d) => all || d.active).map((d) => publicDefinition(d, user));
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
    db.form_definitions.push(d);
    logEvent('form.definition_created', `FORM "${name}" CREATED (${visibility}) BY ${user.username}`, { definition_id: d.id });
    return { __status: 201, __body: publicDefinition(d, user) };
  });

  route('PATCH', '/api/form-definitions/:id', ADMIN, ({ params, body, user }) => {
    const d = findDefinition(params.id); if (!d) throw httpError(404, 'form not found');
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
    if (!d.subject_types.includes(subjectType)) throw httpError(400, `"${d.name}" cannot be filed against a ${subjectType || 'missing subject'}`);
    const subjectLabel = resolveSubject(subjectType, body.subject_id, user);
    const { values, files } = validateValues(d.fields, body.values);

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
    // A filed report is evidence; don't wait for the next write-through.
    flushNow();
    return { __status: 201, __body: publicSubmission(sub) };
  });

  route('GET', '/api/form-submissions', ALL, ({ user, query }) => {
    const subjectType = query.get('subject_type'), subjectId = query.get('subject_id'), defId = query.get('definition_id');
    const limit = Math.min(Number(query.get('limit') || 100), 500);
    return db.form_submissions
      .filter((s) => canRead(s, user))
      .filter((s) => (!subjectType || s.subject_type === subjectType.toUpperCase())
        && (!subjectId || s.subject_id === Number(subjectId))
        && (!defId || s.definition_id === Number(defId)))
      .sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : -1))
      .slice(0, limit)
      .map(submissionSummary);
  });

  route('GET', '/api/form-submissions/:id', ALL, ({ params, user }) => publicSubmission(readableSubmission(params.id, user)));

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

  return { installDefaults, canRead, effectiveVisibility };
};

module.exports.DEFAULT_FORMS = DEFAULT_FORMS;
