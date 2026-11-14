/**
 * Patient report forms (PRF) — first-aid / event-medical care records.
 *
 * Who can do what
 *   FIELD_USER, SUPERVISOR, SYSTEM_ADMIN  write PRFs (their own).
 *   SUPERVISOR, SYSTEM_ADMIN              read every PRF and the PRF audit trail.
 *   DISPATCHER, MDT_USER                  no access. Control doesn't need clinical
 *                                         detail to dispatch, and a vehicle
 *                                         terminal is a shared device, so a care
 *                                         record must be written under a personal
 *                                         login.
 *
 * Records
 *   A PRF is a DRAFT until its author finalises it. Finalising runs the same
 *   completeness rules the form shows (public/prf/rules.js), stamps a SHA-256 of
 *   the content, and locks it: a finalised PRF is never edited, only added to
 *   with signed, timestamped addenda.
 *
 * Audit
 *   PRF activity goes to its own trail, `prf_audit`, not the general event log.
 *   The event log is capped, pruned by the retention sweep and broadcast to every
 *   connected console; a clinical audit trail can be none of those. Each row
 *   carries the hash of the row before it, so editing, inserting or deleting a
 *   row anywhere breaks the chain from that point (GET /api/prf-audit/verify).
 *   Deleting the newest rows leaves a shorter chain that still verifies, so
 *   record the head hash somewhere this server can't rewrite.
 *
 *   Every view of a finalised PRF is logged, as is any view by someone other
 *   than the author. Draft edits record which fields changed, never their values,
 *   and are coalesced to one row per PRF per DRAFT_EDIT_WINDOW_MS so autosave
 *   doesn't flood the trail; a crash can lose at most that window of
 *   "fields changed" metadata on a draft. Finalising flushes it first.
 *
 *   The general event log gets a one-line, patient-free note (PRF reference and
 *   action only) so control can see that a PRF exists for a job.
 */
'use strict';

const crypto = require('crypto');
const { blocking } = require('./public/prf/rules.js');
const { complaintLabel } = require('./complaint-list.js');

// CAD chief complaint codes (complaint-list.js) to the PRF's own list.
const CAD_CHIEF = {
  cardiac: 'Chest pain', breathing: 'Asthma / breathing difficulty', unresponsive: 'Altered consciousness',
  bleeding_severe: 'Wound / bleeding', bleeding_minor: 'Wound / bleeding', anaphylaxis: 'Allergic reaction', allergic_mild: 'Allergic reaction',
  seizure: 'Seizure', major_trauma: 'Fall', fracture: 'Limb injury', sprain_strain: 'Limb injury', head_injury: 'Head injury',
  abdo_pain: 'Abdominal pain', diabetic: 'Diabetic problem', intoxication: 'Intoxication', faint_dizzy: 'Collapse / faint',
};
// A first aid report's outcome to the PRF's disposition.
const FIRST_AID_OUTCOME = {
  'Returned to activity': 'Treated and released', 'Went home': 'Treated and released', 'Referred to GP / pharmacy': 'Treated and released',
  'Taken to hospital': 'Transported', 'Refused treatment': 'Refused care',
};
function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return {};
  return parts.length === 1 ? { first: parts[0] } : { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}
/** Adds values only where the PRF has none yet. */
function fillBlanks(data, more) {
  for (const [k, v] of Object.entries(more)) if (v != null && v !== '' && (data[k] == null || data[k] === '')) data[k] = v;
  return data;
}

const WRITE_ROLES = ['FIELD_USER', 'SUPERVISOR', 'SYSTEM_ADMIN'];
const READ_ALL_ROLES = ['SUPERVISOR', 'SYSTEM_ADMIN'];
const GENESIS = '0'.repeat(64);
const DRAFT_EDIT_WINDOW_MS = Number(process.env.PRF_DRAFT_EDIT_WINDOW_MS || 10 * 60 * 1000);
const MAX_FIELD = 8000;
const PRF_TIMEZONE = process.env.PRF_TIMEZONE || 'Europe/London';
// Retention (NHS Records Management Code of Practice, general health records):
// adults 8 years from the incident; children until their 25th birthday, or 26th
// if they were 17 when treated. Nothing is deleted automatically: a PRF past its
// date shows in PRF admin, where a supervisor disposes of it or holds it.
const RETAIN_ADULT_YEARS = Number(process.env.RETAIN_PRF_ADULT_YEARS || 8);
const RETAIN_CHILD_UNTIL_AGE = Number(process.env.RETAIN_PRF_CHILD_UNTIL_AGE || 25);
// Echelon's medicines policy: no controlled drugs are carried. Set
// PRF_CONTROLLED_DRUGS=on only if that policy changes.
const CONTROLLED_ON = String(process.env.PRF_CONTROLLED_DRUGS || '').toLowerCase() === 'on';
const MAX_VITAL_SETS = 50;

// Fields a PRF may hold. Anything else in a PUT body is dropped, so the record
// can't become a place to stash arbitrary data.
const FIELDS = [
  // Incident
  'event', 'callReceived', 'ageApprox', 'callType', 'mpds', 'mpdsCode', 'mpdsText', 'patientNo', 'patientOf', 'callsign', 'vehicle', 'crew',
  'address', 'address2', 'roomLocation', 'municipality', 'incidentPostcode', 'locationType', 'sceneNotes',
  'destination', 'destinationType', 'destinationReason', 'responseMode', 'transportMode', 'transportPriority',
  'dispatch', 'enRoute', 'scene', 'contact', 'depart', 'arrive', 'transfer', 'available',
  // Patient ID
  'first', 'last', 'dob', 'sex', 'health', 'weight', 'home', 'postal', 'contactName', 'contactRel', 'contactPhone', 'gp',
  // Primary
  'primaryTime', 'catHaem', 'airway', 'breathing', 'circulation', 'loc', 'chief', 'onset', 'priority', 'statement',
  // History
  'pqrsP', 'pqrsQ', 'pqrsR', 'pqrsS', 'pqrsT', 'events', 'intake', 'allergyNotes', 'meds', 'medsStatus', 'history', 'social', 'alerts',
  // Vital signs: scores
  'pain', 'glucose', 'gcsE', 'gcsV', 'gcsM', 'fast',
  // Assess / Tx, Outcomes, Care Plan, Review
  'assessment', 'disposition', 'receiver', 'handover', 'capacity', 'consent', 'refusal', 'safeguarding', 'safeguardingDetails',
  'impression', 'narrative', 'concerns', 'monitoring', 'unableToSign',
  'riddor', 'consentBy', 'mcaImpairment', 'mcaUnderstand', 'mcaRetain', 'mcaWeigh', 'mcaCommunicate', 'bestInterests',
];
// The *Neg lists are pertinent negatives: asked about and absent.
const LIST_FIELDS = ['precautions', 'sceneFindings', 'sceneFindingsNeg', 'allergies', 'allergiesNeg', 'pmh', 'pmhNeg'];
// MPDS determinant list. It is Priority Dispatch copyright, so it is never in
// the code: an admin loads Echelon's licensed list, and it is kept in the
// database (ui_settings 'prf_mpds') and only served to signed-in PRF users.
const MPDS_MAX = 5000;
const MPDS_LINE = /(?:^|[^0-9A-Za-z])(\d{1,2})\s*[-\s.]?\s*(Ω|Ω|Omega|[OoAaBbCcDdEe])\s*[-\s.]?\s*(\d{1,2})([A-Z])?(?![0-9A-Za-z])/;
function normMpds(code) {
  const m = MPDS_LINE.exec(' ' + String(code || '').trim());
  if (!m || +m[1] < 1 || +m[1] > 40) return null;
  const lvl = /^(Ω|Ω|omega|o)$/i.test(m[2]) ? 'Ω' : m[2].toUpperCase();
  return `${m[1].padStart(2, '0')}-${lvl}-${m[3].padStart(2, '0')}${m[4] || ''}`;
}
/** Lines of "code, descriptor" (CSV, tab-separated or pasted text) to [[code, descriptor]]. */
function parseMpds(text) {
  const out = new Map();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = MPDS_LINE.exec(' ' + raw);
    if (!m) continue;
    const code = normMpds(m[0]);
    if (!code) continue;
    const desc = (' ' + raw).slice(m.index + m[0].length).replace(/^[\s,;:\t|"'·–—-]+/, '').replace(/["'\s,;]+$/, '').replace(/""/g, '"').trim().slice(0, 240);
    out.set(code, desc);
    if (out.size >= MPDS_MAX) break;
  }
  // Card order: by protocol, then most to least urgent (E, D, C, B, A, Ω), then number.
  const rank = (c) => [+c.slice(0, 2), 'EDCBAΩ'.indexOf(c[3]), parseInt(c.slice(5), 10), c.slice(7)];
  return [...out.entries()].sort((a, b) => {
    const x = rank(a[0]), y = rank(b[0]);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || x[3].localeCompare(y[3]);
  });
}
const VITAL_KEYS = ['time', 'hr', 'rr', 'sys', 'dia', 'spo2', 'o2', 'acvpu', 'gcs', 'temp', 'doneBy'];
const TX_KEYS = ['time', 'kind', 'name', 'dose', 'route', 'doneBy', 'success', 'response', 'complications', 'error'];
const ENTRY_ID = /^[A-Za-z0-9_-]{1,24}$/;
const INJURY_TYPES = ['Wound', 'Bruise', 'Burn', 'Deformity', 'Pain', 'Swelling', 'Other'];
const MAX_SIGNATURE = 200000; // a signature PNG as a data URL; well above a real one
const SIG_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;

function canonical(value) {
  // Stable JSON (sorted keys) so the same content always hashes the same.
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function rowHash(r) {
  return sha256(JSON.stringify([r.prev_hash, r.at, r.user_id, r.username, r.role, r.action, r.pcr, r.detail, r.ip]));
}

const short = (x, n = 200) => String(x).slice(0, n);
function cleanData(input) {
  const out = {};
  const src = input && typeof input === 'object' ? input : {};
  for (const k of FIELDS) {
    if (src[k] === undefined || src[k] === null) continue;
    out[k] = String(src[k]).slice(0, MAX_FIELD);
  }
  for (const k of LIST_FIELDS) if (Array.isArray(src[k])) out[k] = src[k].slice(0, 60).map((x) => short(x, 120));
  if (Array.isArray(src.vitals)) {
    out.vitals = src.vitals.slice(0, MAX_VITAL_SETS).map((v) => {
      const row = {};
      for (const k of VITAL_KEYS) if (v && v[k] !== undefined && v[k] !== null && v[k] !== '') row[k] = short(v[k], 60);
      return row;
    });
  }
  // Symptoms: { name: 'yes' | 'no' } — 'no' is a pertinent negative (asked, absent).
  if (src.symptoms && typeof src.symptoms === 'object') {
    out.symptoms = {};
    for (const [k, x] of Object.entries(src.symptoms).slice(0, 150)) if (x === 'yes' || x === 'no') out.symptoms[short(k, 80)] = x;
  }
  // Examination by body system: { system: { status, note } }.
  if (src.exam && typeof src.exam === 'object') {
    out.exam = {};
    for (const [k, x] of Object.entries(src.exam).slice(0, 30)) {
      if (!x || typeof x !== 'object') continue;
      const e = {};
      if (x.status) e.status = short(x.status, 40);
      if (x.note) e.note = short(x.note, 2000);
      if (e.status || e.note) out.exam[short(k, 60)] = e;
    }
  }
  if (Array.isArray(src.txLog)) {
    out.txLog = src.txLog.slice(0, 100).map((x) => {
      const row = {};
      if (x && ENTRY_ID.test(String(x.id || ''))) row.id = String(x.id);
      for (const k of TX_KEYS) if (x && x[k] !== undefined && x[k] !== null && x[k] !== '') row[k] = short(x[k], k === 'complications' ? 2000 : 200);
      // x.stock (what was taken out of stock) is set only by the server: see keepStock().
      return row;
    });
  }
  if (Array.isArray(src.injuries)) {
    out.injuries = src.injuries.slice(0, 60).filter((x) => x && Number.isFinite(+x.x) && Number.isFinite(+x.y)).map((x) => ({
      view: x.view === 'back' ? 'back' : 'front',
      x: Math.max(0, Math.min(100, Math.round(+x.x * 10) / 10)),
      y: Math.max(0, Math.min(100, Math.round(+x.y * 10) / 10)),
      type: INJURY_TYPES.includes(x.type) ? x.type : 'Other',
      ...(x.note ? { note: short(x.note, 500) } : {}),
    }));
  }
  if (src.signatures && typeof src.signatures === 'object') {
    out.signatures = {};
    for (const who of ['clinician', 'patient']) {
      const g = src.signatures[who];
      if (!g || typeof g.data !== 'string' || g.data.length > MAX_SIGNATURE || !SIG_RE.test(g.data)) continue;
      out.signatures[who] = { data: g.data, name: short(g.name || '', 120), role: short(g.role || '', 60), at: short(g.at || '', 40) };
    }
  }
  return out;
}

function changedKeys(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...keys].filter((k) => canonical(before[k]) !== canonical(after[k])).sort();
}

/** A draft save can't invent, change or drop a stock deduction: those are
 * the server's record of what left stock. Copy each one from the saved
 * version, and put back any entry that carried one if the client left it out
 * (it can be marked "entered in error" instead, which keeps the record). */
function keepStock(before, next) {
  const had = (before.txLog || []).filter((x) => x && x.stock && x.id);
  if (!had.length) return next;
  const log = next.txLog || [];
  for (const old of had) {
    const row = log.find((x) => x.id === old.id);
    if (row) row.stock = old.stock;
    else log.push(old);
  }
  next.txLog = log;
  return next;
}

const addYears = (d, n) => { const x = new Date(d); x.setUTCFullYear(x.getUTCFullYear() + n); return x; };
/** When a PRF may be disposed of. An unknown age counts as a child's record. */
function retainUntil(r) {
  const d = r.data || {};
  const at = Date.parse(d.callReceived || '') ? new Date(d.callReceived) : new Date(r.created_at);
  let age = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d.dob || '')) {
    const b = new Date(d.dob + 'T00:00:00Z');
    age = at.getUTCFullYear() - b.getUTCFullYear();
    if (at < new Date(Date.UTC(at.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()))) age--;
    if (age < 18) return addYears(b, RETAIN_CHILD_UNTIL_AGE + (age === 17 ? 1 : 0));
  } else if (d.ageApprox !== undefined && d.ageApprox !== '' && Number.isFinite(Number(d.ageApprox))) {
    age = Number(d.ageApprox);
    if (age < 18) return addYears(at, Math.max(0, RETAIN_CHILD_UNTIL_AGE - age) + (age >= 17 ? 1 : 0));
  }
  if (age === null) return addYears(at, RETAIN_CHILD_UNTIL_AGE);
  return addYears(at, RETAIN_ADULT_YEARS);
}

module.exports = function registerPrf({ route, db, nextId, httpError, logEvent, store, assertJobAccess, stock = null, medication = null, canReadSubmission = () => false }) {
  if (!db.prfs) db.prfs = [];
  if (!db.prf_audit) db.prf_audit = [];

  const ipOf = (req) => (req && req.socket && req.socket.remoteAddress) || null;

  function audit(user, action, pcr, detail, req) {
    const last = db.prf_audit[db.prf_audit.length - 1];
    const row = {
      id: nextId('prf_audit'), at: new Date().toISOString(),
      user_id: user ? user.id : null, username: user ? user.username : 'system', role: user ? user.role : null,
      action, pcr: pcr || null, detail: detail || {}, ip: ipOf(req),
      prev_hash: last ? last.row_hash : GENESIS,
    };
    row.row_hash = rowHash(row);
    db.prf_audit.push(row);
    return row;
  }
  const durable = () => { try { store.flushNow(); } catch (e) { console.error('[prf] flush failed:', e.message); } };

  function verifyChain() {
    let prev = GENESIS;
    for (const r of db.prf_audit) {
      if (r.prev_hash !== prev) return { ok: false, rows: db.prf_audit.length, broken_at: r.id, reason: 'link to previous row does not match' };
      if (rowHash(r) !== r.row_hash) return { ok: false, rows: db.prf_audit.length, broken_at: r.id, reason: 'row content does not match its hash' };
      prev = r.row_hash;
    }
    return { ok: true, rows: db.prf_audit.length, head: prev };
  }

  /* Pending draft edits, coalesced into one audit row per PRF per window. */
  const pending = new Map(); // pcr -> { user, keys:Set, since, req }
  function flushEdits(pcr) {
    const p = pending.get(pcr);
    if (!p) return;
    pending.delete(pcr);
    audit(p.user, 'draft.edited', pcr, { fields: [...p.keys].sort() }, p.req);
  }
  function noteEdits(user, pcr, keys, req) {
    if (!keys.length) return;
    let p = pending.get(pcr);
    if (p && p.user.id !== user.id) { flushEdits(pcr); p = null; }
    if (!p) { p = { user, keys: new Set(), since: Date.now(), req: { socket: { remoteAddress: ipOf(req) } } }; pending.set(pcr, p); }
    keys.forEach((k) => p.keys.add(k));
    if (Date.now() - p.since >= DRAFT_EDIT_WINDOW_MS) flushEdits(pcr);
  }
  const tick = setInterval(() => {
    for (const [pcr, p] of pending) if (Date.now() - p.since >= DRAFT_EDIT_WINDOW_MS) flushEdits(pcr);
  }, Math.max(1000, Math.min(60000, DRAFT_EDIT_WINDOW_MS)));
  tick.unref?.();

  const readsAll = (user) => READ_ALL_ROLES.includes(user.role);
  function findPrf(pcr) {
    const r = db.prfs.find((x) => x.pcr === String(pcr));
    if (!r) throw httpError(404, 'PRF not found');
    return r;
  }
  function assertRead(r, user) {
    if (r.status === 'DISPOSED') throw httpError(410, `${r.pcr} was disposed of on ${String(r.disposed_at).slice(0, 10)} at the end of its retention period`);
    if (r.author_user_id === user.id || readsAll(user)) return;
    throw httpError(403, 'not your PRF');
  }
  function assertAuthorDraft(r, user) {
    if (r.author_user_id !== user.id) throw httpError(403, 'only the author can edit a PRF');
    if (r.status !== 'DRAFT') throw httpError(409, 'PRF is finalised and locked; add an addendum instead');
  }
  function jobRef(r) {
    const j = r.job_id ? db.jobs.find((x) => x.id === r.job_id) : null;
    return j ? j.reference : null;
  }
  const summary = (r) => ({
    pcr: r.pcr, status: r.status, job_id: r.job_id, job_reference: jobRef(r),
    patient: [r.data.first, r.data.last].filter(Boolean).join(' ') || null,
    chief: r.data.chief || null, author_name: r.author_name,
    created_at: r.created_at, updated_at: r.updated_at, finalised_at: r.finalised_at || null,
    addenda: (r.addenda || []).length, source_ref: r.source_ref || null,
  });
  const full = (r) => ({ ...summary(r), author_user_id: r.author_user_id, version: r.version, data: r.data, addenda: r.addenda || [], content_hash: r.content_hash || null, finalised_by: r.finalised_by || null });

  // datetime-local inputs want wall-clock time, not UTC.
  const local = (iso) => (iso ? new Date(iso).toLocaleString('sv-SE', { timeZone: PRF_TIMEZONE }).replace(' ', 'T').slice(0, 16) : undefined);
  /** What CCCS knows about a job, in PRF field terms. Used to prefill a new
   * PRF and to offer later updates (times move on after the PRF is started). */
  function jobFacts(job) {
    const f = { event: job.reference };
    if (job.location) f.address = String(job.location);
    if (job.created_at) f.callReceived = local(job.created_at);
    if (job.dispatched_at || job.created_at) f.dispatch = local(job.dispatched_at || job.created_at);
    if (job.en_route_at) f.enRoute = local(job.en_route_at);
    if (job.on_scene_at) f.scene = local(job.on_scene_at);
    if (job.transporting_at) f.depart = local(job.transporting_at);
    if (job.completed_at) f.available = local(job.completed_at);
    const assigns = db.job_assignments.filter((a) => a.job_id === job.id);
    const callsigns = [...new Set(assigns.map((a) => (db.callsigns.find((c) => c.id === a.callsign_id) || {}).name).filter(Boolean))];
    const crew = [...new Set(assigns.map((a) => (db.personnel.find((p) => p.id === a.personnel_id) || {}).name).filter(Boolean))];
    if (callsigns.length) f.callsign = callsigns.join(', ');
    if (crew.length) f.crew = crew.join(', ');
    return f;
  }

  /** What control recorded about the casualty when the job was flagged
   * medical. Only ever fills blanks: the clinician's own findings win. The
   * caller is not assumed to be the patient. */
  function jobPatient(job) {
    if (!job.is_medical) return {};
    const f = { ...splitName(job.patient_name) };
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(job.patient_dob || ''))) f.dob = job.patient_dob;
    if (job.chief_complaint) f.chief = CAD_CHIEF[job.chief_complaint] || 'Other';
    const notes = [];
    if (job.chief_complaint) notes.push(`Reported to control as: ${complaintLabel(job.chief_complaint) || job.chief_complaint}`);
    if (job.mpds_code) {
      f.mpdsCode = job.mpds_code;
      if (job.mpds_text) f.mpdsText = job.mpds_text;
      notes.push(`MPDS triage: ${job.mpds_code}${job.mpds_text ? ' ' + job.mpds_text : ''}`);
    }
    if (job.caller) notes.push(`Reported by: ${job.caller}`);
    if (notes.length) f.sceneNotes = notes.join('\n');
    if (job.description) f.events = String(job.description).slice(0, 2000);
    return f;
  }

  /** A patient care / first aid report's answers, as a starting point. */
  function firstAidFacts(sub) {
    const v = sub.values || {};
    const f = { ...splitName(v.casualty_name) };
    if (v.casualty_age != null && v.casualty_age !== '') f.ageApprox = String(v.casualty_age);
    if (v.occurred_at) f.onset = local(v.occurred_at);
    if (v.presenting_complaint) f.events = String(v.presenting_complaint).slice(0, 4000);
    if (v.treatment) f.narrative = `First aid given (from ${sub.reference}): ${String(v.treatment).slice(0, 4000)}`;
    if (FIRST_AID_OUTCOME[v.outcome]) f.disposition = FIRST_AID_OUTCOME[v.outcome];
    if (v.outcome === 'Referred to GP / pharmacy') f.monitoring = 'Referred to GP / pharmacy (first aid report).';
    if (v.consent_given === true) f.consent = 'Verbal consent';
    if (v.ambulance_called === true) f.handover = 'Ambulance called (first aid report).';
    return f;
  }

  /** Jobs the user could attach a PRF to: their own assignments, or anything recent for supervisors. */
  route('GET', '/api/prfs/jobs', WRITE_ROLES, ({ user }) => {
    const cutoff = Date.now() - 2 * 86400000;
    return db.jobs
      .filter((j) => Date.parse(j.created_at || j.updated_at || 0) >= cutoff || !['COMPLETED', 'CANCELLED'].includes(j.status))
      .filter((j) => { try { assertJobAccess(j, user); return true; } catch { return false; } })
      .slice(-50).reverse()
      .map((j) => ({ id: j.id, reference: j.reference, incident_type: j.incident_type, location: j.location, status: j.status, created_at: j.created_at }));
  });

  /** People a PRF can be handed to: anyone else who can write PRFs. */
  route('GET', '/api/prfs/colleagues', WRITE_ROLES, ({ user }) => db.users
    .filter((u) => u.id !== user.id && WRITE_ROLES.includes(u.role) && !u.disabled)
    .map((u) => ({ id: u.id, name: u.display_name || u.username, role: u.role })));

  /* ---- Supplies: what a treatment can be taken from ----
   * The medicines and stock-tracked items CCCS holds, with how many are at
   * each location, so the treatment log can offer the real thing and say
   * where it came from. */
  route('GET', '/api/prfs/supplies', WRITE_ROLES, ({ user }) => {
    const locations = (db.stock_locations || []).filter((l) => l.active !== false);
    const locName = new Map(locations.map((l) => [l.id, l]));
    const levels = (rows) => {
      const m = new Map();
      for (const b of rows) if (locName.has(b.location_id) && b.qty > 0) m.set(b.location_id, (m.get(b.location_id) || 0) + b.qty);
      return [...m].map(([location_id, qty]) => ({ location_id, qty: Math.round(qty * 100) / 100 }));
    };
    return {
      enabled: Boolean(stock || medication),
      locations: locations.map((l) => {
        const d = stock ? stock.describeLocation(l) : l;
        return { id: l.id, name: l.name, kind: l.kind || null, in_vehicle: d.in_vehicle || null };
      }),
      controlled_drugs: CONTROLLED_ON,
      medicines: medication ? db.medicines.filter((m) => m.active !== false && (CONTROLLED_ON || !m.controlled)).map((m) => ({ id: m.id, label: medication.label(m), unit: m.unit || '', controlled: Boolean(m.controlled), levels: levels(medication.levels(m.id)) })) : [],
      items: stock ? db.assets.filter((a) => a.is_stock_tracked && a.status !== 'RETIRED').filter((a) => { try { stock.findItem(a.id, user); return true; } catch { return false; } })
        .map((a) => ({ id: a.id, label: stock.label(a), unit: a.unit || '', category: a.category || null, levels: levels(stock.levels(a.id)) })) : [],
    };
  });

  /* ---- MPDS determinant list (licensed; loaded by an admin) ---- */
  const mpdsRow = () => (db.ui_settings || []).find((x) => x.key === 'prf_mpds');
  // Control triage the full code on the job; the PRF shows the card name.
  route('GET', '/api/prfs/mpds', ['DISPATCHER', ...WRITE_ROLES], () => {
    const r = mpdsRow();
    return r ? { version: r.settings.version || '', codes: r.settings.codes || [] } : { version: '', codes: [] };
  });
  /** A job's MPDS code, checked against the loaded list (or just its format if none is loaded). */
  function mpdsFor(code) {
    if (!String(code || '').trim()) return { code: '', text: '' };
    const n = normMpds(code);
    if (!n) throw httpError(400, 'MPDS code should look like 10-D-01');
    const list = ((mpdsRow() || {}).settings || {}).codes || [];
    const hit = list.find(([c]) => c === n);
    if (list.length && !hit) throw httpError(400, `${n} is not on the loaded MPDS list`);
    return { code: n, text: hit ? hit[1] : '' };
  }
  route('GET', '/api/prf-admin/mpds', READ_ALL_ROLES, () => {
    const r = mpdsRow(), x = (r && r.settings) || {};
    return { count: (x.codes || []).length, version: x.version || '', loaded_at: x.loaded_at || null, loaded_by: x.loaded_by || null, sample: (x.codes || []).slice(0, 8) };
  });
  route('POST', '/api/prf-admin/mpds', ['SYSTEM_ADMIN'], ({ body, user, req }) => {
    const codes = parseMpds(body && body.text);
    if (!codes.length) throw httpError(400, 'No MPDS codes found. Each line needs a code such as 10-D-01 and its descriptor.');
    if (!Array.isArray(db.ui_settings)) db.ui_settings = [];
    let r = mpdsRow();
    if (!r) { r = { key: 'prf_mpds', settings: {} }; db.ui_settings.push(r); }
    r.settings = { codes, version: short(body.version || '', 80), loaded_at: new Date().toISOString(), loaded_by: user.username };
    audit(user, 'mpds.loaded', null, { codes: codes.length, version: r.settings.version }, req);
    durable();
    return { count: codes.length, version: r.settings.version, sample: codes.slice(0, 8) };
  });
  route('DELETE', '/api/prf-admin/mpds', ['SYSTEM_ADMIN'], ({ user, req }) => {
    db.ui_settings = (db.ui_settings || []).filter((x) => x.key !== 'prf_mpds');
    audit(user, 'mpds.removed', null, {}, req);
    durable();
    return { ok: true };
  });

  route('GET', '/api/prfs', WRITE_ROLES, ({ query, user }) => {
    let list = (readsAll(user) && query.get('scope') === 'all' ? db.prfs : db.prfs.filter((r) => r.author_user_id === user.id)).filter((r) => r.status !== 'DISPOSED');
    if (query.get('status')) list = list.filter((r) => r.status === query.get('status').toUpperCase());
    if (query.get('job_id')) list = list.filter((r) => r.job_id === Number(query.get('job_id')));
    return list.slice().sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)).map(summary);
  });

  route('POST', '/api/prfs', WRITE_ROLES, ({ body, user, req }) => {
    // Started from a patient care / first aid report: its answers come across,
    // and a second press opens the same PRF rather than starting another.
    let sub = null;
    if (body.from_submission != null && body.from_submission !== '') {
      sub = (db.form_submissions || []).find((x) => x.id === Number(body.from_submission));
      if (!sub || sub.definition_key !== 'patient-care' || !canReadSubmission(sub, user)) throw httpError(404, 'patient care report not found');
      const existing = db.prfs.find((x) => x.source_submission_id === sub.id);
      if (existing) {
        if (existing.author_user_id !== user.id && !READ_ALL_ROLES.includes(user.role)) throw httpError(409, `${existing.pcr} was already started from this report by ${existing.author_name}`);
        return { ...full(existing), existing: true };
      }
    }
    let job = null;
    const jobId = body.job_id != null && body.job_id !== '' ? body.job_id : sub && sub.subject_type === 'JOB' ? sub.subject_id : null;
    if (jobId != null) {
      job = db.jobs.find((x) => x.id === Number(jobId));
      if (!job) throw httpError(400, 'job_id must reference an existing job');
      assertJobAccess(job, user);
    }
    const now = new Date().toISOString();
    const data = job ? jobFacts(job) : {};
    if (sub) fillBlanks(data, firstAidFacts(sub));
    if (job) fillBlanks(data, jobPatient(job));
    if (job) {
      // Patient X of Y: each casualty at a job gets their own PRF.
      const n = db.prfs.filter((x) => x.job_id === job.id).length + 1;
      data.patientNo = String(n);
      data.patientOf = String(n);
    }
    const r = {
      id: nextId('prfs'),
      pcr: `PRF-${new Date().getFullYear()}-${String(nextId('prfref')).padStart(5, '0')}`,
      job_id: job ? job.id : null, status: 'DRAFT', version: 1,
      author_user_id: user.id, author_name: user.display_name || user.username,
      data, addenda: [], created_at: now, updated_at: now,
      source_submission_id: sub ? sub.id : null, source_ref: sub ? sub.reference : null,
    };
    db.prfs.push(r);
    audit(user, 'created', r.pcr, { job_id: r.job_id, ...(sub ? { from: sub.reference } : {}) }, req);
    logEvent('prf.created', `PRF ${r.pcr} started${job ? ' for ' + job.reference : ''} by ${r.author_name}`, { pcr: r.pcr, job_id: r.job_id });
    durable();
    return { __status: 201, __body: full(r) };
  });

  route('GET', '/api/prfs/:pcr', WRITE_ROLES, ({ params, user, req }) => {
    const r = findPrf(params.pcr);
    assertRead(r, user);
    if (r.status === 'FINAL' || r.author_user_id !== user.id) audit(user, 'viewed', r.pcr, { status: r.status }, req);
    return full(r);
  });

  route('PUT', '/api/prfs/:pcr', WRITE_ROLES, ({ params, body, user, req }) => {
    const r = findPrf(params.pcr);
    assertAuthorDraft(r, user);
    if (body.version != null && Number(body.version) !== r.version) throw httpError(409, 'PRF was changed elsewhere; reload it');
    const next = keepStock(r.data || {}, cleanData(body.data));
    const keys = changedKeys(r.data, next);
    if (keys.length) {
      r.data = next;
      r.version++;
      r.updated_at = new Date().toISOString();
      noteEdits(user, r.pcr, keys, req);
    }
    return { version: r.version, updated_at: r.updated_at };
  });

  route('DELETE', '/api/prfs/:pcr', WRITE_ROLES, ({ params, user, req }) => {
    const r = findPrf(params.pcr);
    assertAuthorDraft(r, user);
    flushEdits(r.pcr);
    db.prfs = db.prfs.filter((x) => x !== r);
    audit(user, 'draft.discarded', r.pcr, {}, req);
    logEvent('prf.discarded', `PRF ${r.pcr} draft discarded by ${r.author_name}`, { pcr: r.pcr });
    durable();
    return { ok: true };
  });

  /** The linked job's current facts, so the form can offer to bring times up to date. */
  route('GET', '/api/prfs/:pcr/cad', WRITE_ROLES, ({ params, user }) => {
    const r = findPrf(params.pcr);
    assertRead(r, user);
    const job = r.job_id ? db.jobs.find((x) => x.id === r.job_id) : null;
    if (!job) return { job: null, facts: {} };
    return { job: { id: job.id, reference: job.reference, status: job.status }, facts: jobFacts(job) };
  });

  /** Link a draft to a CCCS job afterwards (e.g. a walk-up casualty that
   * control then logged). Brings the job's times and details in, filling
   * blanks only. */
  route('POST', '/api/prfs/:pcr/link', WRITE_ROLES, ({ params, body, user, req }) => {
    const r = findPrf(params.pcr);
    assertAuthorDraft(r, user);
    const job = db.jobs.find((x) => x.id === Number(body.job_id));
    if (!job) throw httpError(400, 'job_id must reference an existing job');
    assertJobAccess(job, user);
    flushEdits(r.pcr);
    r.job_id = job.id;
    fillBlanks(r.data, { ...jobFacts(job), ...jobPatient(job) });
    r.version++;
    r.updated_at = new Date().toISOString();
    audit(user, 'linked', r.pcr, { job_id: job.id }, req);
    logEvent('prf.linked', `PRF ${r.pcr} linked to ${job.reference}`, { pcr: r.pcr, job_id: job.id });
    durable();
    return full(r);
  });

  /** The PRFs on a job, for the control room's job view: numbers, status and
   * author only. Control can see that a PRF exists without reading it. */
  route('GET', '/api/jobs/:id/prfs', ['DISPATCHER', ...WRITE_ROLES], ({ params, user }) => {
    const job = db.jobs.find((x) => x.id === Number(params.id));
    if (!job) throw httpError(404, 'job not found');
    assertJobAccess(job, user);
    return db.prfs.filter((x) => x.job_id === job.id).map((x) => ({ pcr: x.pcr, status: x.status, author_name: x.author_name, created_at: x.created_at, finalised_at: x.finalised_at || null }));
  });

  /** Hand a draft to another crew member, e.g. when another unit takes over care. */
  route('POST', '/api/prfs/:pcr/transfer', WRITE_ROLES, ({ params, body, user, req }) => {
    const r = findPrf(params.pcr);
    assertAuthorDraft(r, user);
    const to = db.users.find((u) => u.id === Number(body.user_id));
    if (!to || !WRITE_ROLES.includes(to.role) || to.disabled) throw httpError(400, 'user_id must be someone who can write PRFs');
    if (to.id === user.id) throw httpError(400, 'that PRF is already yours');
    flushEdits(r.pcr);
    const from = r.author_name;
    r.author_user_id = to.id;
    r.author_name = to.display_name || to.username;
    r.version++;
    r.updated_at = new Date().toISOString();
    audit(user, 'transferred', r.pcr, { from_user_id: user.id, to_user_id: to.id, to: r.author_name }, req);
    logEvent('prf.transferred', `PRF ${r.pcr} handed from ${from} to ${r.author_name}`, { pcr: r.pcr });
    durable();
    return full(r);
  });

  /** Take a treatment log entry's item out of stock, against this PRF.
   * Medicines go through the medication register (with its witness rule
   * for controlled drugs); consumables through stock "used in treatment".
   * Either way it is the same function the Stock and Medication pages use,
   * so levels, batches and the ledger can't disagree. Once taken, the entry
   * keeps that record; a mistake is corrected on the Stock or Medication
   * page (a return or adjustment), never by silently putting it back. */
  route('POST', '/api/prfs/:pcr/supplies', WRITE_ROLES, ({ params, body, user, req }) => {
    const r = findPrf(params.pcr);
    assertAuthorDraft(r, user);
    const entry = (r.data.txLog || []).find((x) => x.id && x.id === String(body.entry_id || ''));
    if (!entry) throw httpError(404, 'treatment log entry not found; save the PRF and try again');
    if (entry.stock) throw httpError(409, 'that entry has already been taken from stock');
    const kind = body.kind === 'medicine' ? 'medicine' : body.kind === 'stock' ? 'stock' : null;
    if (!kind) throw httpError(400, 'kind must be medicine or stock');
    if ((kind === 'medicine' && !medication) || (kind === 'stock' && !stock)) throw httpError(503, 'stock is not available on this server');
    // Human Medicines Regulations 2012: every medicine given needs a legal authority (PGD, exemption, prescriber…).
    const authority = String(body.authority || '').trim().slice(0, 80);
    if (kind === 'medicine' && !authority) throw httpError(400, 'record the authority for giving this medicine');
    const location = (db.stock_locations || []).find((l) => l.id === Number(body.location_id));
    if (!location) throw httpError(400, 'choose where it came from');
    const patient = [r.data.first, r.data.last].filter(Boolean).join(' ');
    const note = `PRF ${r.pcr}`;
    let item, rows, label, unit, controlled = false;
    if (kind === 'medicine') {
      item = medication.findMed(body.item_id);
      controlled = Boolean(item.controlled);
      if (controlled && !CONTROLLED_ON) throw httpError(403, 'controlled drugs are not carried under the medicines policy, so a PRF cannot record one from stock');
      rows = medication.administer(item, {
        quantity: body.quantity, location_id: location.id, batch_no: body.batch_no || undefined,
        patient_name: patient, patient_ref: r.pcr, dose_given: body.dose || entry.dose, route: entry.route, note, authority,
        witness_username: body.witness_username, witness_password: body.witness_password,
      }, user, { source: 'PRF', prf_pcr: r.pcr });
      label = medication.label(item);
    } else {
      item = stock.findItem(body.item_id, user);
      rows = stock.useInTreatment(item, { quantity: body.quantity, location_id: location.id, batch_no: body.batch_no || undefined, patient_ref: r.pcr, note }, user, { source: 'PRF', prf_pcr: r.pcr });
      label = stock.label(item);
    }
    unit = item.unit || '';
    flushEdits(r.pcr);
    entry.stock = {
      kind, item_id: item.id, item: label, unit, controlled,
      quantity: Math.round(Math.abs(rows.reduce((n, m) => n + (Number(m.delta) || 0), 0)) * 100) / 100,
      location_id: location.id, location: location.name,
      batches: [...new Set(rows.map((m) => m.batch_no).filter(Boolean))],
      movement_ids: rows.map((m) => m.id),
      witness: rows[0] && rows[0].witness_name ? rows[0].witness_name : null,
      authority: kind === 'medicine' ? authority : null,
      by: user.display_name || user.username, at: new Date().toISOString(),
    };
    if (!entry.name) entry.name = label;
    r.version++;
    r.updated_at = entry.stock.at;
    audit(user, 'supply.used', r.pcr, { entry_id: entry.id, kind, item_id: item.id, quantity: entry.stock.quantity, location_id: location.id, movement_ids: entry.stock.movement_ids }, req);
    durable();
    return full(r);
  });

  route('POST', '/api/prfs/:pcr/finalise', WRITE_ROLES, ({ params, body, user, req }) => {
    const r = findPrf(params.pcr);
    assertAuthorDraft(r, user);
    if (body.attest !== true) throw httpError(400, 'the author must confirm the record is accurate (attest: true)');
    const gaps = blocking(r.data);
    if (gaps.length) return { __status: 422, __body: { error: 'PRF is incomplete', missing: gaps } };
    flushEdits(r.pcr);
    const now = new Date().toISOString();
    r.status = 'FINAL';
    r.finalised_at = now;
    r.finalised_by = user.display_name || user.username;
    r.updated_at = now;
    r.content_hash = sha256(canonical(r.data));
    audit(user, 'finalised', r.pcr, { content_hash: r.content_hash }, req);
    logEvent('prf.finalised', `PRF ${r.pcr} finalised by ${r.finalised_by}`, { pcr: r.pcr, job_id: r.job_id });
    durable();
    return full(r);
  });

  route('POST', '/api/prfs/:pcr/addenda', WRITE_ROLES, ({ params, body, user, req }) => {
    const r = findPrf(params.pcr);
    assertRead(r, user);
    if (r.status !== 'FINAL') throw httpError(409, 'addenda are for finalised PRFs; edit the draft instead');
    const text = String(body.text || '').trim();
    if (!text) throw httpError(400, 'text required');
    const a = { id: (r.addenda || []).length + 1, text: text.slice(0, MAX_FIELD), by: user.display_name || user.username, by_user_id: user.id, at: new Date().toISOString() };
    a.hash = sha256(canonical({ pcr: r.pcr, ...a }));
    (r.addenda = r.addenda || []).push(a);
    r.updated_at = a.at;
    audit(user, 'addendum.added', r.pcr, { addendum_id: a.id, hash: a.hash }, req);
    durable();
    return { __status: 201, __body: full(r) };
  });

  route('POST', '/api/prfs/:pcr/printed', WRITE_ROLES, ({ params, user, req }) => {
    const r = findPrf(params.pcr);
    assertRead(r, user);
    audit(user, 'printed', r.pcr, {}, req);
    return { ok: true };
  });

  route('GET', '/api/prf-audit', READ_ALL_ROLES, ({ query }) => {
    let rows = db.prf_audit;
    if (query.get('pcr')) rows = rows.filter((x) => x.pcr === query.get('pcr'));
    const limit = Math.min(Number(query.get('limit')) || 500, 5000);
    return rows.slice(-limit).reverse();
  });
  route('GET', '/api/prf-audit/verify', READ_ALL_ROLES, () => verifyChain());

  /** Everything the PRF admin page needs in one read: every PRF's summary
   * (no clinical content beyond what the list already shows), drafts left
   * open too long, and what PRFs have taken out of stock. */
  const STALE_DRAFT_MS = Number(process.env.PRF_STALE_DRAFT_HOURS || 24) * 3600000;
  route('GET', '/api/prf-admin/overview', READ_ALL_ROLES, () => {
    const now = Date.now();
    const rows = db.prfs.slice().sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)).map((r) => {
      const used = (r.data.txLog || []).filter((x) => x && x.stock);
      const until = r.status === 'DISPOSED' ? null : retainUntil(r).toISOString().slice(0, 10);
      return {
        ...summary(r), dob: (r.data && r.data.dob) || null, stock_entries: used.length, stale: r.status === 'DRAFT' && now - Date.parse(r.updated_at) > STALE_DRAFT_MS,
        retain_until: until, legal_hold: r.legal_hold || null,
        due: Boolean(until && !r.legal_hold && Date.parse(until) <= now),
        disposed_at: r.disposed_at || null, disposed_by: r.disposed_by || null, disposed_reason: r.disposed_reason || null,
      };
    });
    const supplies = [];
    for (const r of db.prfs) for (const x of r.data.txLog || []) if (x && x.stock) {
      supplies.push({ pcr: r.pcr, status: r.status, at: x.stock.at, by: x.stock.by, kind: x.stock.kind, item: x.stock.item, quantity: x.stock.quantity, unit: x.stock.unit, location: x.stock.location, batches: x.stock.batches || [], controlled: Boolean(x.stock.controlled), witness: x.stock.witness || null, in_error: Boolean(x.error) });
    }
    supplies.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const weekAgo = now - 7 * 86400000;
    return {
      summary: {
        drafts: rows.filter((r) => r.status === 'DRAFT').length,
        stale: rows.filter((r) => r.stale).length,
        finalised_7d: rows.filter((r) => r.finalised_at && Date.parse(r.finalised_at) >= weekAgo).length,
        total: rows.length,
        supplies_7d: supplies.filter((x) => Date.parse(x.at) >= weekAgo).length,
        due: rows.filter((r) => r.due).length,
        held: rows.filter((r) => r.legal_hold).length,
      },
      stale_hours: STALE_DRAFT_MS / 3600000,
      retention: { adult_years: RETAIN_ADULT_YEARS, child_until_age: RETAIN_CHILD_UNTIL_AGE },
      controlled_drugs: CONTROLLED_ON,
      prfs: rows,
      supplies,
      authors: [...new Set(rows.map((r) => r.author_name))].sort(),
    };
  });

  /* ---- Retention: legal hold and disposal ---- */
  route('POST', '/api/prf-admin/:pcr/hold', READ_ALL_ROLES, ({ params, body, user, req }) => {
    const r = findPrf(params.pcr);
    if (r.status === 'DISPOSED') throw httpError(409, 'already disposed of');
    if (body.on === false) {
      if (!r.legal_hold) return { ok: true, legal_hold: null };
      r.legal_hold = null;
      audit(user, 'hold.released', r.pcr, {}, req);
    } else {
      const reason = String(body.reason || '').trim().slice(0, 300);
      if (!reason) throw httpError(400, 'say why it is being held (claim, complaint, inquest, safeguarding…)');
      r.legal_hold = { reason, by: user.display_name || user.username, at: new Date().toISOString() };
      audit(user, 'hold.placed', r.pcr, { reason }, req);
    }
    durable();
    return { ok: true, legal_hold: r.legal_hold };
  });

  /** End of retention: the clinical content goes, a stub stays to prove it.
   * Patient names on the medicines ledger for this PRF go too. */
  route('POST', '/api/prf-admin/:pcr/dispose', READ_ALL_ROLES, ({ params, body, user, req }) => {
    const r = findPrf(params.pcr);
    if (r.status === 'DISPOSED') throw httpError(409, 'already disposed of');
    if (r.legal_hold) throw httpError(409, `on legal hold: ${r.legal_hold.reason}`);
    const until = retainUntil(r);
    if (until.getTime() > Date.now()) throw httpError(409, `kept until ${until.toISOString().slice(0, 10)}; it can't be disposed of before then`);
    if (String(body.confirm || '') !== r.pcr) throw httpError(400, 'type the PRF number to confirm');
    const reason = String(body.reason || '').trim().slice(0, 300) || 'retention period ended';
    flushEdits(r.pcr);
    const now = new Date().toISOString();
    r.data = {};
    r.addenda = [];
    r.status = 'DISPOSED';
    r.disposed_at = now;
    r.disposed_by = user.display_name || user.username;
    r.disposed_reason = reason;
    r.updated_at = now;
    let ledger = 0;
    for (const m of db.med_movements || []) if (m.prf_pcr === r.pcr || m.patient_ref === r.pcr) { if (m.patient_name) { m.patient_name = ''; ledger++; } }
    audit(user, 'disposed', r.pcr, { reason, retain_until: until.toISOString().slice(0, 10), ledger_names_cleared: ledger }, req);
    logEvent('prf.disposed', `PRF ${r.pcr} disposed of at the end of its retention period by ${r.disposed_by}`, { pcr: r.pcr });
    durable();
    return { ok: true, pcr: r.pcr, disposed_at: now };
  });

  /** Who the privacy notice names. Public: patients read it without signing in. */
  route('GET', '/api/prf-privacy', null, () => ({
    controller: process.env.PRF_CONTROLLER || 'Echelon Command Information Centre Ltd',
    email: process.env.PRF_PRIVACY_EMAIL || null,
    safeguarding_email: process.env.PRF_SAFEGUARDING_EMAIL || null,
    retention: { adult_years: RETAIN_ADULT_YEARS, child_until_age: RETAIN_CHILD_UNTIL_AGE },
  }));

  return { verifyChain, retainUntil, parseMpds, mpdsFor, flushEdits: () => [...pending.keys()].forEach(flushEdits), WRITE_ROLES, READ_ALL_ROLES };
};
