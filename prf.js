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

const WRITE_ROLES = ['FIELD_USER', 'SUPERVISOR', 'SYSTEM_ADMIN'];
const READ_ALL_ROLES = ['SUPERVISOR', 'SYSTEM_ADMIN'];
const GENESIS = '0'.repeat(64);
const DRAFT_EDIT_WINDOW_MS = Number(process.env.PRF_DRAFT_EDIT_WINDOW_MS || 10 * 60 * 1000);
const MAX_FIELD = 8000;
const PRF_TIMEZONE = process.env.PRF_TIMEZONE || 'Europe/London';
const MAX_VITAL_SETS = 50;

// Fields a PRF may hold. Anything else in a PUT body is dropped, so the record
// can't become a place to stash arbitrary data.
const FIELDS = [
  // Incident
  'event', 'callReceived', 'callType', 'mpds', 'patientNo', 'patientOf', 'callsign', 'vehicle', 'crew',
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
];
const LIST_FIELDS = ['precautions', 'sceneFindings', 'allergies', 'pmh'];
const VITAL_KEYS = ['time', 'hr', 'rr', 'sys', 'dia', 'spo2', 'o2', 'acvpu', 'gcs', 'temp', 'doneBy'];
const TX_KEYS = ['time', 'kind', 'name', 'dose', 'route', 'doneBy', 'success', 'response', 'complications'];
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
      for (const k of TX_KEYS) if (x && x[k] !== undefined && x[k] !== null && x[k] !== '') row[k] = short(x[k], k === 'complications' ? 2000 : 200);
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

module.exports = function registerPrf({ route, db, nextId, httpError, logEvent, store, assertJobAccess }) {
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
    addenda: (r.addenda || []).length,
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

  route('GET', '/api/prfs', WRITE_ROLES, ({ query, user }) => {
    let list = readsAll(user) && query.get('scope') === 'all' ? db.prfs : db.prfs.filter((r) => r.author_user_id === user.id);
    if (query.get('status')) list = list.filter((r) => r.status === query.get('status').toUpperCase());
    if (query.get('job_id')) list = list.filter((r) => r.job_id === Number(query.get('job_id')));
    return list.slice().sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)).map(summary);
  });

  route('POST', '/api/prfs', WRITE_ROLES, ({ body, user, req }) => {
    let job = null;
    if (body.job_id != null && body.job_id !== '') {
      job = db.jobs.find((x) => x.id === Number(body.job_id));
      if (!job) throw httpError(400, 'job_id must reference an existing job');
      assertJobAccess(job, user);
    }
    const now = new Date().toISOString();
    const data = job ? jobFacts(job) : {};
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
    };
    db.prfs.push(r);
    audit(user, 'created', r.pcr, { job_id: r.job_id }, req);
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
    const next = cleanData(body.data);
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

  return { verifyChain, flushEdits: () => [...pending.keys()].forEach(flushEdits), WRITE_ROLES, READ_ALL_ROLES };
};
