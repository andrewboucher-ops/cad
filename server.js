/**
 * CCCS — Critical Communications, Dispatch & Control-Room System (POC)
 * Zero-dependency Node.js backend: REST API + WebSocket signalling.
 *
 * THIS IS A SIMULATION / PROOF OF CONCEPT.
 * It is NOT suitable for safety-critical or operational use and does not
 * connect to Airwave, TETRA, or any real telecommunications infrastructure.
 */
'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN_TTL_MS = Number(process.env.TOKEN_TTL_MS || 8 * 60 * 60 * 1000);
// Vehicle terminals stay signed in for the shift (or longer) — crew sign in
// and out of the vehicle separately, without touching this session at all.
const MDT_TOKEN_TTL_MS = Number(process.env.MDT_TOKEN_TTL_MS || 24 * 60 * 60 * 1000);
const DIAL_RINGS_OPERATOR_FIRST = process.env.DIAL_RINGS_OPERATOR_FIRST !== 'off';

const SIMULATION = process.env.SIMULATION !== 'off';

const MS_TENANT_ID = process.env.MS_TENANT_ID || '';
const MS_CLIENT_ID = process.env.MS_CLIENT_ID || '';
const MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET || '';
const MS_REDIRECT_URI = process.env.MS_REDIRECT_URI || '';
const MS_ENABLED = Boolean(MS_TENANT_ID && MS_CLIENT_ID && MS_CLIENT_SECRET && MS_REDIRECT_URI);
const { verifyMicrosoftIdToken } = require('./msauth.js');
const webpush = require('./webpush.js');
const sms = require('./sms.js');
const ami = require('./asterisk.js');
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@echeloncic.com';

let SECRET = process.env.AUTH_SECRET;
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[cccs] AUTH_SECRET not set — generated an ephemeral one. Sessions drop on restart.');
}

/* ------------------------------------------------------------------ *
 * Crypto helpers
 * ------------------------------------------------------------------ */
const b64u = (b) => Buffer.from(b).toString('base64url');

function hashPassword(plain, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(plain, salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(plain, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const cand = crypto.scryptSync(plain, salt, 32);
  const known = Buffer.from(hash, 'hex');
  return cand.length === known.length && crypto.timingSafeEqual(cand, known);
}
function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

/* ------------------------------------------------------------------ *
 * In-memory store (mirrors the documented PostgreSQL schema 1:1)
 * ------------------------------------------------------------------ */
const db = {
  users: [], mdts: [], callsigns: [], vehicles: [], personnel: [], sites: [],
  jobs: [], job_assignments: [], messages: [], call_requests: [],
  locations: [], emergency_events: [], audit_logs: [],
  push_subscriptions: [], patrol_schedules: [], site_visits: [], shifts: [], shift_assignments: [], shift_types: [], shift_applications: [], assets: [],
  shift_vehicle_allocations: [], shift_asset_allocations: [], stock_movements: [],
  passdown_logs: [], fuel_logs: [], asset_checkouts: [], maintenance_logs: [], beats: [],
  dial_log: [],
  form_definitions: [], form_submissions: [], form_grants: [],
  clients: [], documents: [], client_requests: [],
  branches: [],
  training_courses: [], training_records: [],
  leave_requests: [],
  ui_settings: [],
  stock_locations: [], asset_events: [], stocktakes: [], rentals: [],
  agreements: [], invoices: [],
};
const seq = {};
const nextId = (t) => (seq[t] = (seq[t] || 0) + 1);
const JOB_STATES = ['CREATED', 'DISPATCHED', 'ACKNOWLEDGED', 'EN_ROUTE', 'ON_SCENE', 'TRANSPORTING', 'COMPLETED', 'CANCELLED'];
// First time a job reaches each of these, stamp it — this is what "time
// en route" / "time on scene" is computed from client-side, with no separate
// tracking mechanism to keep in sync.
const JOB_STATUS_TS_FIELD = { DISPATCHED: 'dispatched_at', ACKNOWLEDGED: 'acknowledged_at', EN_ROUTE: 'en_route_at', ON_SCENE: 'on_scene_at', TRANSPORTING: 'transporting_at', COMPLETED: 'completed_at', CANCELLED: 'cancelled_at' };
function stampJobStatus(j, status) {
  const field = JOB_STATUS_TS_FIELD[status];
  if (field && !j[field]) j[field] = new Date().toISOString();
}

/* Scheduled site visits — a persistent, recurring patrol model distinct from
 * one-off jobs. No TRANSPORTING (nobody's being carried anywhere) but a
 * MISSED terminal state a job doesn't need: a job always starts from a human
 * deciding to create one, but a visit can be silently generated by the
 * schedule tick and then never picked up. */
const SITE_VISIT_STATES = ['SCHEDULED', 'DISPATCHED', 'ACKNOWLEDGED', 'EN_ROUTE', 'ON_SCENE', 'COMPLETED', 'CANCELLED', 'MISSED'];
// A shift is the slot (site, type, time window, how many people it needs);
// who's actually on it lives in shift_assignments. FILLED is deliberately
// not a status here — it's derived (assigned count vs required_headcount)
// the same way personnel.compliance/leave_balance are, never stored, so
// there's nothing to fall out of sync with the assignments underneath it.
const SHIFT_STATES = ['DRAFT', 'PUBLISHED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
const SHIFT_ASSIGNMENT_STATES = ['ASSIGNED', 'CONFIRMED', 'DECLINED', 'REMOVED'];
const ATTENDANCE_STATES = ['ATTENDED', 'NO_SHOW', 'LATE'];
const SITE_VISIT_STATUS_TS_FIELD = { DISPATCHED: 'dispatched_at', ACKNOWLEDGED: 'acknowledged_at', EN_ROUTE: 'en_route_at', ON_SCENE: 'on_scene_at', COMPLETED: 'completed_at', CANCELLED: 'cancelled_at', MISSED: 'missed_at' };
function stampVisitStatus(v, status) {
  const field = SITE_VISIT_STATUS_TS_FIELD[status];
  if (field && !v[field]) v[field] = new Date().toISOString();
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const ON_SCENE_RADIUS_M = 100;
const EN_ROUTE_DELTA_M = 25;
/** Called from an MDT's location report. Advances a job's status without
 * anyone touching a button: ACKNOWLEDGED -> EN_ROUTE the first time the
 * reported distance to the job meaningfully decreases (actual movement
 * toward it, not GPS jitter), and either of those -> ON_SCENE once within
 * arrival radius. Deliberately does not touch TRANSPORTING/COMPLETED — those
 * stay a human decision. `assignment.last_distance_m` is the only state this
 * needs, and it's meaningless once the job is no longer being tracked, so it
 * is simply left stale rather than cleaned up.
 *
 * Originally MDT-only: a driving patrol's vehicle terminal was the one
 * thing that already reported GPS on every move. checkAutoProgressForPerson
 * below extends the same idea to a foot officer once FOOT_TRACKING is on. */
function checkAutoJobProgress(mdt, lat, lon) {
  const jobId = mdt.job_id;
  if (!jobId) return;
  const j = db.jobs.find((x) => x.id === jobId);
  if (!j || j.lat == null || ['ON_SCENE', 'TRANSPORTING', 'COMPLETED', 'CANCELLED'].includes(j.status)) return;
  const a = db.job_assignments.find((x) => x.job_id === j.id && x.mdt_id === mdt.id);
  if (!a) return;
  const dist = haversineMeters(lat, lon, j.lat, j.lon);
  let newStatus = null;
  if (['ACKNOWLEDGED', 'EN_ROUTE'].includes(j.status) && dist < ON_SCENE_RADIUS_M) newStatus = 'ON_SCENE';
  else if (j.status === 'ACKNOWLEDGED' && a.last_distance_m != null && dist < a.last_distance_m - EN_ROUTE_DELTA_M) newStatus = 'EN_ROUTE';
  a.last_distance_m = dist;
  if (!newStatus) return;
  j.status = newStatus; stampJobStatus(j, newStatus); j.updated_at = new Date().toISOString();
  broadcast('job.status_changed', publicJob(j));
  logEvent('job.status_changed', `JOB ${j.reference} → ${newStatus} (auto)`, { job_id: j.id });
}
/** The foot-officer half of the same idea: whichever of their own active
 * job or patrol visit they're assigned to, advanced by proximity exactly
 * like an MDT's job. A visit's "site" stands in for a job's own lat/lon,
 * and last_distance_m lives on the visit itself rather than a separate
 * assignment row, since a visit has no job_assignments equivalent. Only
 * ever called once FOOT_TRACKING is on and the report passed the route's
 * own "is this your own record" check — this has no auth of its own. */
function checkAutoProgressForPerson(personnelId, lat, lon) {
  const a = db.job_assignments.find((x) => x.personnel_id === personnelId);
  if (a) {
    const j = db.jobs.find((x) => x.id === a.job_id);
    if (j && j.lat != null && !['ON_SCENE', 'TRANSPORTING', 'COMPLETED', 'CANCELLED'].includes(j.status)) {
      const dist = haversineMeters(lat, lon, j.lat, j.lon);
      let newStatus = null;
      if (['ACKNOWLEDGED', 'EN_ROUTE'].includes(j.status) && dist < ON_SCENE_RADIUS_M) newStatus = 'ON_SCENE';
      else if (j.status === 'ACKNOWLEDGED' && a.last_distance_m != null && dist < a.last_distance_m - EN_ROUTE_DELTA_M) newStatus = 'EN_ROUTE';
      a.last_distance_m = dist;
      if (newStatus) {
        j.status = newStatus; stampJobStatus(j, newStatus); j.updated_at = new Date().toISOString();
        broadcast('job.status_changed', publicJob(j));
        logEvent('job.status_changed', `JOB ${j.reference} → ${newStatus} (auto)`, { job_id: j.id });
      }
    }
  }
  const v = db.site_visits.find((x) => x.personnel_id === personnelId || (x.additional_personnel || []).includes(personnelId));
  if (v) {
    const site = db.sites.find((s) => s.id === v.site_id);
    if (site && site.lat != null && !['ON_SCENE', 'COMPLETED', 'CANCELLED', 'MISSED'].includes(v.status)) {
      const dist = haversineMeters(lat, lon, site.lat, site.lon);
      let newStatus = null;
      if (['ACKNOWLEDGED', 'EN_ROUTE'].includes(v.status) && dist < ON_SCENE_RADIUS_M) newStatus = 'ON_SCENE';
      else if (v.status === 'ACKNOWLEDGED' && v.last_distance_m != null && dist < v.last_distance_m - EN_ROUTE_DELTA_M) newStatus = 'EN_ROUTE';
      v.last_distance_m = dist;
      if (newStatus) {
        v.status = newStatus; stampVisitStatus(v, newStatus); v.updated_at = new Date().toISOString();
        broadcast('site_visit.status_changed', publicSiteVisit(v));
        logEvent('site_visit.status_changed', `VISIT ${v.reference} → ${newStatus} (auto)`, { site_visit_id: v.id });
      }
    }
  }
}
const PRIORITIES = ['RED', 'AMBER', 'GREEN', 'ROUTINE'];
// CLIENT is external — a customer's own login, not staff. It is a valid role
// (for user creation/validation) but deliberately NOT part of ALL below: ALL
// gates most of the API, and a new role landing in it by default would hand
// an outside party every site, every person, every form submission. CLIENT
// only ever gets what routes-client.js explicitly grants. FINANCE is
// internal staff but just as deliberately excluded from ALL for the same
// reason — it exists to read pay/bill/cost figures, not to touch dispatch,
// and routes-finance.js is the only place that role ever appears.
const ROLES = ['SYSTEM_ADMIN', 'DISPATCHER', 'SUPERVISOR', 'FIELD_USER', 'MDT_USER', 'CLIENT', 'FINANCE'];

const { createStore } = require('./store.js');
const store = createStore(db, seq);
webpush.init(store, VAPID_SUBJECT);

/** Fire-and-forget push to a set of users' subscribed devices. Never throws —
 * a push failing must not break the REST call or WS broadcast it rides along
 * with. A 404/410 means the browser dropped the subscription; stop using it. */
function pushToUsers(userIds, payload) {
  if (!userIds.length) return;
  const subs = db.push_subscriptions.filter((s) => userIds.includes(s.user_id));
  for (const s of subs) {
    webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload)
      .then((r) => { if (r.expired) db.push_subscriptions = db.push_subscriptions.filter((x) => x.id !== s.id); })
      .catch((e) => console.warn('[webpush] send failed:', e.message));
  }
}
function pushToRoles(roles, payload) {
  pushToUsers(db.users.filter((u) => roles.includes(u.role)).map((u) => u.id), payload);
}

const findCallsign = (v) =>
  db.callsigns.find((c) => c.id === Number(v) || c.name === String(v).toUpperCase()) || null;
const findMdt = (v) =>
  db.mdts.find((m) => m.id === Number(v) || m.mdt_code === String(v).toUpperCase()) || null;
const findPersonnel = (v) =>
  db.personnel.find((p) => p.id === Number(v) || (p.employee_no && p.employee_no === String(v))) || null;

function logEvent(type, summary, data = {}) {
  const ev = { id: nextId('audit_logs'), type, summary, data, at: new Date().toISOString() };
  db.audit_logs.push(ev);
  if (db.audit_logs.length > 5000) db.audit_logs.shift();
  broadcast('event.logged', ev);
  return ev;
}

/* ------------------------------------------------------------------ *
 * Seed / demo data
 * ------------------------------------------------------------------ */
/**
 * Load seed.json if the operator has provided one, so a new deployment starts
 * with real call signs and sites rather than demo data. Runs on first boot only:
 * once the database has content this is never consulted, so it cannot overwrite
 * anything live.
 */
function seedFromFile(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const byName = { vehicles: new Map(), callsigns: new Map(), personnel: new Map(), mdts: new Map() };

  for (const st of raw.sites || []) {
    db.sites.push({ id: nextId('sites'), name: st.name, address: st.address || '', lat: st.lat ?? null, lon: st.lon ?? null, keyholder: st.keyholder || '', contract: 'ACTIVE', checklist: [] });
  }
  for (const v of raw.vehicles || []) {
    const rec = { id: nextId('vehicles'), registration: v.registration, type: v.type || 'Vehicle', make: v.make || '', model: v.model || '', service_due_at: v.service_due_at || null, insurance_due_at: v.insurance_due_at || null, mileage: v.mileage || null, condition: v.condition || '', assigned_personnel_id: null, status: 'ACTIVE', notes: '' };
    db.vehicles.push(rec); byName.vehicles.set(v.registration, rec);
  }
  for (const cs of raw.callsigns || []) {
    const name = String(cs.name).toUpperCase();
    const rec = { id: nextId('callsigns'), name, description: cs.description || '', active: true };
    db.callsigns.push(rec); byName.callsigns.set(name, rec);
    const vehicle = cs.vehicle ? byName.vehicles.get(cs.vehicle) : null;

    // A seed entry can still just be a bare name (older seed.json files),
    // or a full object once an operator wants to fill in the rest --
    // never require re-authoring an existing seed file just for this.
    for (const person of cs.personnel || []) {
      const p = typeof person === 'string' ? { name: person } : person;
      const rec2 = {
        id: nextId('personnel'), employee_no: p.employee_no || null, name: p.name, rank: p.rank || '',
        contact_phone: p.contact_phone || '', contact_email: p.contact_email || '',
        employment_status: p.employment_status || 'ACTIVE', callsign_id: rec.id,
        user_id: null, vehicle_id: vehicle ? vehicle.id : null,
        welfare_interval_s: null, welfare_due_at: null, welfare_warned: false, welfare_note: '',
        notes: p.notes || '',
      };
      db.personnel.push(rec2);
      if (p.name) byName.personnel.set(p.name, rec2);
    }
    for (const m of cs.mdts || []) {
      const mdt = { id: nextId('mdts'), mdt_code: String(m.code).toUpperCase(), serial: m.serial || m.code, callsign_id: rec.id, vehicle_id: vehicle ? vehicle.id : null, status: 'OFFLINE', duty_status: 'AVAILABLE', job_id: null, battery: 100, network: 'LTE', operator: null, lat: null, lon: null, connected: false, crew: [], emergency: false };
      db.mdts.push(mdt); byName.mdts.set(mdt.mdt_code, mdt);
    }
  }

  for (const u of raw.users || []) {
    const username = String(u.username).toLowerCase();
    if (!u.password || u.password === 'CHANGE-ME') {
      throw new Error(`user ${username} in the seed file still has the placeholder password — set a real one`);
    }
    if (String(u.password).length < 8) throw new Error(`password for ${username} is too short`);
    if (!ROLES.includes(u.role)) throw new Error(`unknown role ${u.role} for ${username}`);
    const person = u.personnel ? byName.personnel.get(String(u.personnel)) : null;
    const mdt = u.mdt ? byName.mdts.get(String(u.mdt).toUpperCase()) : null;
    const user = {
      id: nextId('users'), username, password_hash: hashPassword(String(u.password)),
      role: u.role, display_name: u.display_name || username,
      personnel_id: person ? person.id : null, mdt_id: mdt ? mdt.id : null,
      email: u.email ? String(u.email).toLowerCase() : null,
      created_at: new Date().toISOString(),
    };
    db.users.push(user);
    if (person) person.user_id = user.id;
  }

  logEvent('system.seeded', `Loaded ${db.callsigns.length} call signs, ${db.personnel.length} personnel and ${db.sites.length} sites from ${path.basename(file)}`);
}

function seed() {
  const seedFile = process.env.SEED_FILE || path.join(__dirname, 'seed.json');
  if (fs.existsSync(seedFile)) {
    console.log(`[cccs] seeding from ${seedFile}`);
    return seedFromFile(seedFile);
  }
  console.warn('[cccs] no seed.json found — loading demo data. Copy seed.example.json to seed.json for your own call signs.');
  const mkUser = (username, password, role, extra = {}) => {
    const u = { id: nextId('users'), username, password_hash: hashPassword(password), role, display_name: extra.display_name || username, personnel_id: null, mdt_id: null, created_at: new Date().toISOString(), ...extra };
    db.users.push(u); return u;
  };
  const mkVehicle = (reg, type) => { const v = { id: nextId('vehicles'), registration: reg, type, make: '', model: '', service_due_at: null, insurance_due_at: null, mileage: null, condition: '', assigned_personnel_id: null, status: 'ACTIVE', notes: '' }; db.vehicles.push(v); return v; };
  const mkCallsign = (name, desc) => { const c = { id: nextId('callsigns'), name, description: desc, active: true }; db.callsigns.push(c); return c; };
  const mkPerson = (name, rank, callsign_id, vehicle_id = null) => {
    const p = {
      id: nextId('personnel'), employee_no: null, name, rank, contact_phone: '', contact_email: '',
      employment_status: 'ACTIVE', callsign_id, user_id: null, vehicle_id,
      welfare_interval_s: null, welfare_due_at: null, welfare_warned: false, welfare_note: '', notes: '',
    };
    db.personnel.push(p); return p;
  };
  const mkMdt = (code, serial, callsign_id, vehicle_id) => {
    const m = { id: nextId('mdts'), mdt_code: code, serial, callsign_id, vehicle_id, status: 'OFFLINE', duty_status: 'AVAILABLE', job_id: null, battery: 80 + Math.floor(Math.random() * 20), network: 'LTE', operator: null, lat: null, lon: null, connected: false, crew: [], emergency: false };
    db.mdts.push(m); return m;
  };

  const mkSite = (name, address, lat, lon, keyholder) => {
    const st = { id: nextId('sites'), name, address, lat, lon, keyholder, contract: 'ACTIVE', checklist: [] };
    db.sites.push(st); return st;
  };

  mkSite('Meridian Business Park', 'Unit 4, Meridian Way', 51.5290, -0.0870, 'J. Whitlock 07700 900412');
  mkSite('Carlton Retail Centre', '18 Carlton Road', 51.4930, -0.1620, 'Duty manager 07700 900188');
  mkSite('Northgate Distribution', 'Northgate Industrial Estate', 51.5510, -0.1050, 'Site office 07700 900233');
  mkSite('Ashcroft House', '112 Ashcroft Lane', 51.4820, -0.0940, 'Facilities 07700 900571');

  const v1 = mkVehicle('VAN-101', 'Patrol van');
  const v2 = mkVehicle('VAN-102', 'Patrol van');
  const v3 = mkVehicle('VAN-103', 'Patrol van');
  const v4 = mkVehicle('CAR-201', 'Response car');

  const p101 = mkCallsign('P101', 'Mobile patrol, north');
  const p102 = mkCallsign('P102', 'Mobile patrol, north');
  const p103 = mkCallsign('P103', 'Mobile patrol, south');
  const p104 = mkCallsign('P104', 'Static guard, Meridian');
  const m201 = mkCallsign('M201', 'Alarm response');
  const m202 = mkCallsign('M202', 'Alarm response');
  mkCallsign('CONTROL', 'Control room');
  mkCallsign('SUPERVISOR', 'Duty supervisor');

  const dan = mkPerson('Dan Whitfield', 'Patrol officer', p101.id, v1.id);
  mkPerson('Sam Oduya', 'Patrol officer', p101.id);
  const ellie = mkPerson('Ellie Marsh', 'Patrol officer', p102.id, v2.id);
  const ryan = mkPerson('Ryan Cole', 'Response officer', p103.id, v3.id);
  mkPerson('Jo Vance', 'Static guard', p104.id);

  const m1 = mkMdt('MDT-001', 'SN-MDT-0001', p101.id, v1.id);
  mkMdt('MDT-002', 'SN-MDT-0002', p102.id, v2.id);
  mkMdt('MDT-003', 'SN-MDT-0003', p103.id, v3.id);

  mkUser('admin', 'admin123', 'SYSTEM_ADMIN', { display_name: 'System Admin' });
  mkUser('dispatcher', 'dispatch123', 'DISPATCHER', { display_name: 'Controller Hale' });
  mkUser('supervisor', 'super123', 'SUPERVISOR', { display_name: 'Supervisor Reid' });
  const uDan = mkUser('dwhitfield', 'field123', 'FIELD_USER', { display_name: 'Dan Whitfield', personnel_id: dan.id });
  const uEllie = mkUser('emarsh', 'field123', 'FIELD_USER', { display_name: 'Ellie Marsh', personnel_id: ellie.id });
  const uRyan = mkUser('rcole', 'field123', 'FIELD_USER', { display_name: 'Ryan Cole', personnel_id: ryan.id });
  dan.user_id = uDan.id; ellie.user_id = uEllie.id; ryan.user_id = uRyan.id;
  mkUser('mdt001', 'mdt123', 'MDT_USER', { display_name: 'MDT-001 Operator', mdt_id: m1.id });

  logEvent('system.seeded', 'Demo data loaded');
}

/* ------------------------------------------------------------------ *
 * WebSocket server (RFC 6455, hand-rolled — no dependencies)
 * ------------------------------------------------------------------ */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const sockets = new Set();

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}
function encodeFrame(data, opcode = 0x1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}

class Conn {
  constructor(socket, user) {
    this.socket = socket; this.user = user;
    this.id = crypto.randomUUID();
    this.mdtId = null;
    this.buf = Buffer.alloc(0); this.alive = true;
    this.awaitingPong = false;
    sockets.add(this);
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.close());
    socket.on('error', () => this.close());
  }
  send(type, payload) {
    if (!this.alive) return;
    try { this.socket.write(encodeFrame(JSON.stringify({ type, payload, ts: Date.now() }))); }
    catch { this.close(); }
  }
  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) === 0x80;
      let len = b1 & 0x7f, offset = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); offset = 10; }
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < offset + maskLen + len) return;
      const mask = masked ? this.buf.subarray(offset, offset + 4) : null;
      const data = Buffer.from(this.buf.subarray(offset + maskLen, offset + maskLen + len));
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      this.buf = this.buf.subarray(offset + maskLen + len);
      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this.socket.write(encodeFrame(data.toString(), 0xa)); continue; }
      if (opcode === 0xa) { this.awaitingPong = false; continue; }
      if (opcode === 0x1) {
        try { handleWsMessage(this, JSON.parse(data.toString())); }
        catch (e) { this.send('error', { message: String(e.message || e) }); }
      }
    }
  }
  close() {
    if (!this.alive) return;
    this.alive = false; sockets.delete(this);
    try { this.socket.destroy(); } catch {}
    if (this.mdtId && !Array.from(sockets).some((c) => c.mdtId === this.mdtId)) {
      const m = db.mdts.find((x) => x.id === this.mdtId);
      if (m) { m.connected = false; m.status = 'OFFLINE'; broadcast('mdt.status_changed', publicMdt(m)); }
    }
  }
}

/* A dead TCP peer (laptop slept, network changed, cable pulled) often gives
 * neither a close nor an error event — the OS just goes quiet. Left alone,
 * that connection lingers in `sockets` forever: still "connected" for
 * presence, still counted as a PTT listener, so a control operator can hear
 * their own voice come back from a ghost session that's actually gone.
 * A plain WS ping/pong (opcode 0x9/0xa) catches this in one round trip —
 * browsers answer server-sent pings at the protocol level with no JS needed
 * on the client, so this is purely a server-side addition. */
const HEARTBEAT_MS = 30000;
setInterval(() => {
  for (const c of sockets) {
    if (!c.alive) continue;
    if (c.awaitingPong) { c.close(); continue; }
    c.awaitingPong = true;
    try { c.socket.write(encodeFrame('', 0x9)); } catch { c.close(); }
  }
}, HEARTBEAT_MS).unref?.();

function broadcast(type, payload, opts = {}) {
  const targeted = Boolean(opts.mdtIds || opts.personnelIds || opts.siteIds || opts.controlOnly);
  for (const c of sockets) {
    // CLIENT is an external trust boundary, not just another internal role:
    // it never gets the "untargeted reaches everyone" default and never gets
    // the control-role bypass below. It receives ONLY a broadcast explicitly
    // scoped with siteIds that includes one of its own sites — opt-in, not
    // opt-out, same reasoning as the RESTRICTED-forms default-deny.
    if (c.user.role === 'CLIENT') {
      if (opts.siteIds) {
        const client = db.clients.find((cl) => cl.id === c.user.client_id);
        if (client && opts.siteIds.some((id) => client.site_ids.includes(id))) c.send(type, payload);
      }
      continue;
    }
    let deliver = !targeted;
    if (targeted) {
      if (opts.mdtIds && c.mdtId && opts.mdtIds.includes(c.mdtId)) deliver = true;
      if (opts.personnelIds && c.user.personnel_id && opts.personnelIds.includes(c.user.personnel_id)) deliver = true;
      if (opts.includeControl !== false && isControlRole(c.user.role)) deliver = true;
    }
    if (deliver) c.send(type, payload);
  }
}
const isControlRole = (role) => ['DISPATCHER', 'SUPERVISOR', 'SYSTEM_ADMIN'].includes(role);

/* Multi-branch — a staff-visibility split, not a tenancy wall. DISPATCHER
 * and SYSTEM_ADMIN always see everything, every branch, no exceptions:
 * company-wide oversight and cross-branch dispatch stay with them. A
 * SUPERVISOR, FIELD_USER, MDT_USER or FINANCE sees only their own branch's
 * personnel/vehicles/assets/sites (and the jobs/visits/shifts at those
 * sites) — for reporting and day-to-day work, not as a security boundary
 * the way CLIENT is. A record with no branch_id is shared/unassigned and
 * visible to everyone regardless of role: multi-branch is opt-in per
 * record, so an install that never sets branch_id anywhere sees no
 * behaviour change. */
const BRANCH_SCOPED_ROLES = ['SUPERVISOR', 'FIELD_USER', 'MDT_USER', 'FINANCE'];
const branchFilterActive = (user) => BRANCH_SCOPED_ROLES.includes(user.role) && Boolean(user.branch_id);
const visibleToUser = (record, user) => !branchFilterActive(user) || record.branch_id == null || record.branch_id === user.branch_id;
/** A finer-grained option layered on top of branch scoping: a SUPERVISOR
 * (or FINANCE user) restricted to an explicit list of sites rather than
 * their whole branch — set via `users.site_ids`, independent of branch_id
 * and checked first. An empty array is a real, deliberate "no sites yet",
 * not the same as leaving site_ids unset (which falls back to the branch
 * rule below, or to no restriction at all). */
const siteFilterActive = (user) => BRANCH_SCOPED_ROLES.includes(user.role) && Array.isArray(user.site_ids);
/** Same rule, for a job/visit/shift whose own "branch" is really its
 * site's. No site_id (an ad-hoc emergency job, say) reads as shared, same
 * as a site with no branch_id — there's nothing to scope it to, for either
 * the site-list or the branch form of this check. */
function siteVisibleTo(siteId, user) {
  if (!siteId) return true;
  if (siteFilterActive(user)) return user.site_ids.includes(siteId);
  if (!branchFilterActive(user)) return true;
  const site = db.sites.find((s) => s.id === siteId);
  return !site || site.branch_id == null || site.branch_id === user.branch_id;
}
/** Normalizes a branch_id write: null clears it (shared/unassigned), any
 * other value must reference a real branch. */
function normalizedBranchId(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const id = Number(raw);
  if (!db.branches.some((b) => b.id === id)) throw httpError(400, 'branch_id must reference an existing branch');
  return id;
}
/** Normalizes a site_ids write: null/undefined clears it (falls back to
 * branch-level scoping, or none); an array — even empty — sets it. */
function normalizedSiteIds(raw) {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) throw httpError(400, 'site_ids must be an array or null');
  const ids = raw.map((x) => Number(x));
  for (const id of ids) if (!db.sites.some((s) => s.id === id)) throw httpError(400, 'site_ids must reference existing sites');
  return ids;
}

/* ------------------------------------------------------------------ *
 * Domain logic
 * ------------------------------------------------------------------ */
/** Carries PII (contact_phone/email) unlike the other public* shapers'
 * source rows, which is why this one exists at all — vehicles/sites are
 * returned as raw rows elsewhere because they hold nothing sensitive,
 * personnel no longer can be. welfare_note is kept (control needs to see
 * it), but nothing here is ever handed to a role that isn't control or
 * this exact person -- callers gate that themselves. */
/* SIA licence and DBS Update Service status are both, today, checked by a
 * human against the regulator's own site — neither the SIA nor the DBS
 * publishes an API for this (SIA confirmed it in an FOI response, 24 Aug
 * 2026: no API for single or bulk checks, not even for the paid third-party
 * "SIA Verify"/"SIA Checker" services; the DBS Update Service is a
 * consent-based per-person web check with no automation route either). So
 * these fields record what an admin found when they last actually checked,
 * not a live status — compliance() below just turns "did anyone remember to
 * recheck this" into a visible flag, the same idea as a missed patrol visit
 * or an overdue vehicle service. */
const SIA_EXPIRY_WARN_DAYS = 30;
const DBS_RECHECK_DUE_DAYS = 365; // DBS sets no fixed frequency; a year is a common risk-based default, not a legal requirement
/** A person can hold more than one SIA licence (Door Supervision and CCTV
 * are both common). sia_licences is the canonical list; the original
 * single sia_licence_no/sia_licence_expiry fields are kept on the record
 * for backward compatibility (nothing deletes them) and, for a person who
 * predates this and has never been re-saved with a licences array, are
 * synthesised into one here rather than needing a one-off migration pass. */
function siaLicencesOf(p) {
  if (Array.isArray(p.sia_licences)) return p.sia_licences;
  return p.sia_licence_no ? [{ id: 1, licence_type: 'Door Supervision', licence_no: p.sia_licence_no, expiry: p.sia_licence_expiry || null }] : [];
}
function personnelCompliance(p) {
  const now = Date.now();
  // Worst case across every licence held: one expired licence matters more
  // than another being fine.
  let sia = 'unset';
  for (const l of siaLicencesOf(p)) {
    if (!l.expiry) continue;
    const expiry = Date.parse(l.expiry);
    const state = expiry < now ? 'expired' : expiry - now < SIA_EXPIRY_WARN_DAYS * 86400000 ? 'expiring' : 'ok';
    if (state === 'expired') { sia = 'expired'; break; }
    if (state === 'expiring' && sia !== 'expired') sia = 'expiring';
    else if (state === 'ok' && sia === 'unset') sia = 'ok';
  }
  let dbs = 'unset';
  if (p.dbs_last_checked_at) {
    dbs = (now - Date.parse(p.dbs_last_checked_at)) > DBS_RECHECK_DUE_DAYS * 86400000 ? 'overdue' : 'ok';
  }
  return { sia, dbs };
}

const TRAINING_EXPIRY_WARN_DAYS = 30;
/** Same "make the gap visible" idea as SIA/DBS, but for a variable admin-
 * defined set of courses rather than two fixed checks: for every active
 * course, the status of this person's most recent record against it.
 * 'never' (no record at all) is distinct from 'overdue' (had one, it
 * lapsed) because they call for different action — chase an induction
 * that's never happened once, versus a refresher that's due. A course
 * with no validity_months doesn't expire — a one-time induction stays
 * 'ok' forever once done, there is nothing to renew. */
function trainingStatusForPerson(personnelId) {
  const now = Date.now();
  return db.training_courses.filter((c) => c.active).map((c) => {
    const records = db.training_records.filter((r) => r.personnel_id === personnelId && r.course_id === c.id);
    const latest = records.sort((a, b) => (a.completed_at < b.completed_at ? 1 : -1))[0] || null;
    let status = 'never', expires_at = null;
    if (latest) {
      if (c.validity_months) {
        expires_at = new Date(Date.parse(latest.completed_at));
        expires_at.setMonth(expires_at.getMonth() + c.validity_months);
        expires_at = expires_at.toISOString();
        const expiry = Date.parse(expires_at);
        status = expiry < now ? 'overdue' : expiry - now < TRAINING_EXPIRY_WARN_DAYS * 86400000 ? 'expiring' : 'ok';
      } else status = 'ok';
    }
    return { course_id: c.id, course_name: c.name, status, completed_at: latest ? latest.completed_at : null, expires_at };
  });
}
// A subcontractor invoices for their own time under their own arrangement —
// they were never accruing a UK-style statutory holiday entitlement through
// this business, so leave management only ever applies to EMPLOYED.
const EMPLOYMENT_TYPES = ['EMPLOYED', 'SUBCONTRACTOR'];
// UK statutory minimum for a full-time worker (5.6 weeks), used only when a
// person has no allowance of their own set — a starting default, not a
// promise it's right for every contract; admin.html lets it be overridden
// per person.
const DEFAULT_ANNUAL_LEAVE_DAYS = 28;
/** The leave year is the calendar year, a deliberate default like
 * DBS_RECHECK_DUE_DAYS's risk-based year above — not a legal requirement,
 * just the simplest thing that needed picking. Change LEAVE_YEAR_START_MONTH
 * (0 = January) if the business runs its leave year on a different cycle. */
const LEAVE_YEAR_START_MONTH = 0;
function leaveYearRange(now = new Date()) {
  const y = now.getMonth() < LEAVE_YEAR_START_MONTH ? now.getFullYear() - 1 : now.getFullYear();
  return { start: new Date(y, LEAVE_YEAR_START_MONTH, 1), end: new Date(y + 1, LEAVE_YEAR_START_MONTH, 1) };
}
/** null for a SUBCONTRACTOR — there is no allowance to report, not a zero
 * one. Only APPROVED annual leave starting within the current leave year
 * counts against it: PENDING hasn't been decided yet, REJECTED/CANCELLED
 * never happened, and sick/unpaid/other leave is deliberately not annual
 * leave and doesn't touch this number. */
function leaveBalanceForPerson(p) {
  if ((p.employment_type || 'EMPLOYED') !== 'EMPLOYED') return null;
  const { start, end } = leaveYearRange();
  const allowance = p.annual_leave_allowance_days || DEFAULT_ANNUAL_LEAVE_DAYS;
  const taken = db.leave_requests
    .filter((r) => r.personnel_id === p.id && r.type === 'ANNUAL' && r.status === 'APPROVED')
    .filter((r) => { const d = Date.parse(r.start_date); return d >= start.getTime() && d < end.getTime(); })
    .reduce((sum, r) => sum + r.days, 0);
  return { allowance, taken, remaining: Math.round((allowance - taken) * 10) / 10 };
}
function cleanEmergencyContact(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim().slice(0, 120);
  const relationship = String(raw.relationship || '').trim().slice(0, 60);
  const phone = String(raw.phone || '').trim().slice(0, 30);
  const email = String(raw.email || '').trim().slice(0, 160);
  if (!name && !relationship && !phone && !email) return null;
  return { name, relationship, phone, email };
}
function cleanBankDetails(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const account_name = String(raw.account_name || '').trim().slice(0, 120);
  const bank_name = String(raw.bank_name || '').trim().slice(0, 120);
  let sort_code = String(raw.sort_code || '').trim().replace(/\s/g, '');
  if (sort_code && !/^\d{2}-?\d{2}-?\d{2}$/.test(sort_code)) throw httpError(400, 'sort code should be 6 digits, e.g. 12-34-56');
  let account_number = String(raw.account_number || '').trim().replace(/\s/g, '');
  if (account_number && !/^\d{6,10}$/.test(account_number)) throw httpError(400, 'account number should be 8 digits');
  if (!account_name && !bank_name && !sort_code && !account_number) return null;
  return { account_name, bank_name, sort_code, account_number };
}
/** `user` is optional and new: every existing call site that doesn't pass
 * it (chiefly broadcasts, which go to many recipients at once and can't
 * sensibly be redacted for one viewer) simply never gets emergency_contact
 * or bank_details in the payload — stricter than before adding them, never
 * laxer, so nothing already relying on the old (always-called-with-no-
 * user) shape changes behaviour. Only a direct, per-viewer read — today
 * just GET /api/personnel — passes `user`, and only then does a control
 * role or the person themself see their own emergency contact or bank
 * details; colleagues never do. */
function publicPersonnel(p, user) {
  const cs = db.callsigns.find((c) => c.id === p.callsign_id);
  const veh = db.vehicles.find((v) => v.id === p.vehicle_id);
  const canSeeSensitive = user && (isControlRole(user.role) || user.personnel_id === p.id);
  return {
    id: p.id, employee_no: p.employee_no, name: p.name, rank: p.rank,
    contact_phone: p.contact_phone || '', contact_email: p.contact_email || '',
    sms_opt_out: p.sms_opt_out === true, email_opt_out: p.email_opt_out === true,
    employment_status: p.employment_status || 'ACTIVE',
    callsign: cs ? cs.name : null, callsign_id: p.callsign_id,
    vehicle: veh ? veh.registration : null, vehicle_id: p.vehicle_id,
    has_login: Boolean(p.user_id), supervisor_id: p.supervisor_id || null,
    welfare_interval_s: p.welfare_interval_s || null, welfare_due_at: p.welfare_due_at || null,
    welfare_note: p.welfare_note || null,
    sia_licence_no: p.sia_licence_no || null, sia_licence_expiry: p.sia_licence_expiry || null,
    sia_licences: siaLicencesOf(p),
    dbs_certificate_no: p.dbs_certificate_no || null, dbs_certificate_type: p.dbs_certificate_type || null,
    dbs_update_service_id: p.dbs_update_service_id || null, dbs_last_checked_at: p.dbs_last_checked_at || null,
    compliance: personnelCompliance(p),
    notes: p.notes || '', branch_id: p.branch_id || null,
    lat: p.lat ?? null, lon: p.lon ?? null, location_at: p.location_at || null,
    training: trainingStatusForPerson(p.id),
    employment_type: p.employment_type || 'EMPLOYED',
    annual_leave_allowance_days: p.annual_leave_allowance_days ?? null,
    leave_balance: leaveBalanceForPerson(p),
    ...(canSeeSensitive ? { emergency_contact: p.emergency_contact || null, bank_details: p.bank_details || null } : {}),
  };
}
function publicMdt(m) {
  const cs = db.callsigns.find((c) => c.id === m.callsign_id);
  const veh = db.vehicles.find((v) => v.id === m.vehicle_id);
  return { id: m.id, mdt_code: m.mdt_code, serial: m.serial, callsign: cs ? cs.name : null, callsign_id: m.callsign_id, vehicle: veh ? veh.registration : null, status: m.status, duty_status: m.duty_status || 'AVAILABLE', job_id: m.job_id, battery: m.battery, network: m.network, operator: m.operator, connected: m.connected, lat: m.lat, lon: m.lon, crew: m.crew || [], emergency: m.emergency || false };
}
function publicJob(j) {
  const assigns = db.job_assignments.filter((a) => a.job_id === j.id);
  return {
    ...j,
    resources: assigns.map((a) => {
      const p = a.personnel_id ? db.personnel.find((x) => x.id === a.personnel_id) : null;
      const m = a.mdt_id ? db.mdts.find((x) => x.id === a.mdt_id) : null;
      const cs = db.callsigns.find((c) => c.id === a.callsign_id);
      return { assignment_id: a.id, callsign: cs ? cs.name : null, personnel: p ? p.name : null, mdt: m ? m.mdt_code : null, acknowledged: a.acknowledged, acknowledged_at: a.acknowledged_at };
    }),
  };
}
function publicBeat(b) {
  const site = db.sites.find((x) => x.id === b.site_id);
  return { ...b, site_name: site ? site.name : null };
}
function publicPatrolSchedule(s) {
  const site = db.sites.find((x) => x.id === s.site_id);
  const beat = s.beat_id ? db.beats.find((x) => x.id === s.beat_id) : null;
  return { ...s, site_name: site ? site.name : null, beat_name: beat ? beat.name : null };
}
function publicSiteVisit(v) {
  const site = db.sites.find((x) => x.id === v.site_id);
  const beat = v.beat_id ? db.beats.find((x) => x.id === v.beat_id) : null;
  const primary = v.personnel_id ? db.personnel.find((x) => x.id === v.personnel_id) : null;
  const additional = (v.additional_personnel || []).map((id) => db.personnel.find((x) => x.id === id)).filter(Boolean);
  return {
    ...v,
    site_name: site ? site.name : null, site_address: site ? site.address : null,
    beat_name: beat ? beat.name : null, waypoints: beat ? beat.waypoints : [],
    checkpoint_scans: v.checkpoint_scans || [],
    lat: site ? site.lat : null, lon: site ? site.lon : null,
    resources: [
      ...(primary ? [{ personnel_id: primary.id, personnel: primary.name, primary: true }] : []),
      ...additional.map((p) => ({ personnel_id: p.id, personnel: p.name, primary: false })),
    ],
  };
}
/** Warn, don't block: a shift against approved leave is very likely a
 * mistake, but occasionally isn't (leave gets cancelled after cover was
 * already arranged, an emergency needs whoever's actually available), so
 * this only ever surfaces as a flag on the shift for rota.html to show,
 * never a rejection from the create/update route itself. */
function onApprovedLeave(personnelId, isoTimestamp, approvedLeave) {
  const day = isoTimestamp.slice(0, 10);
  const rows = approvedLeave || db.leave_requests.filter((r) => r.status === 'APPROVED');
  return rows.some((r) => r.personnel_id === personnelId && r.start_date <= day && day <= r.end_date);
}
function publicShiftType(t) { return { ...t }; }
/** Building a shift list ran publicShift() once per shift, and each call
 * independently re-scanned every assignment/allocation/leave-request in the
 * whole system looking for its own rows — O(shifts × collection sizes). A
 * list route builds this once instead: every lookup publicShift() needs
 * becomes a grouped Map, so N shifts cost one O(collection sizes) pass plus
 * O(1) lookups per shift, not N full re-scans. Passing no index at all
 * (every other call site — create/patch, which only ever handles the one
 * shift it just touched) keeps today's behaviour exactly: same per-call
 * cost as before, just without the complexity of grouping for a list of one. */
function buildShiftIndex() {
  const groupBy = (arr, key) => {
    const m = new Map();
    for (const x of arr) { if (!m.has(x[key])) m.set(x[key], []); m.get(x[key]).push(x); }
    return m;
  };
  const byId = (arr) => new Map(arr.map((x) => [x.id, x]));
  return {
    assignmentsByShift: groupBy(db.shift_assignments, 'shift_id'),
    vehicleAllocsByShift: groupBy(db.shift_vehicle_allocations, 'shift_id'),
    assetAllocsByShift: groupBy(db.shift_asset_allocations, 'shift_id'),
    approvedLeave: db.leave_requests.filter((r) => r.status === 'APPROVED'),
    sitesById: byId(db.sites), typesById: byId(db.shift_types),
    personnelById: byId(db.personnel), callsignsById: byId(db.callsigns),
    vehiclesById: byId(db.vehicles), assetsById: byId(db.assets),
  };
}
/** One person's involvement in a shift. on_leave_conflict is checked per
 * assignment, not per shift, since a shift can now carry several people and
 * only some of them might have approved leave over it — same "warn, don't
 * block" flag as before, just scoped to whoever it's actually about. */
function publicAssignment(a, shift, idx) {
  const p = idx ? idx.personnelById.get(a.personnel_id) : db.personnel.find((x) => x.id === a.personnel_id);
  const callsign = p ? (idx ? idx.callsignsById.get(p.callsign_id) : db.callsigns.find((c) => c.id === p.callsign_id)) : null;
  return {
    ...a, personnel_name: p ? p.name : null,
    personnel_callsign: callsign ? callsign.name || null : null,
    on_leave_conflict: onApprovedLeave(a.personnel_id, shift.starts_at, idx && idx.approvedLeave),
  };
}
function publicVehicleAllocation(a, idx) {
  const v = idx ? idx.vehiclesById.get(a.vehicle_id) : db.vehicles.find((x) => x.id === a.vehicle_id);
  const driver = a.driver_personnel_id ? (idx ? idx.personnelById.get(a.driver_personnel_id) : db.personnel.find((x) => x.id === a.driver_personnel_id)) : null;
  return { ...a, vehicle_registration: v ? v.registration : null, driver_name: driver ? driver.name : null };
}
function publicAssetAllocation(a, idx) {
  const asset = idx ? idx.assetsById.get(a.asset_id) : db.assets.find((x) => x.id === a.asset_id);
  return { ...a, asset_description: asset ? asset.description : null, asset_tag: asset ? asset.tag : null };
}
function publicShift(s, idx) {
  const site = s.site_id ? (idx ? idx.sitesById.get(s.site_id) : db.sites.find((x) => x.id === s.site_id)) : null;
  const type = s.shift_type_id ? (idx ? idx.typesById.get(s.shift_type_id) : db.shift_types.find((x) => x.id === s.shift_type_id)) : null;
  const rawAssignments = idx ? (idx.assignmentsByShift.get(s.id) || []) : db.shift_assignments.filter((a) => a.shift_id === s.id);
  const assignments = rawAssignments.filter((a) => a.status !== 'REMOVED').map((a) => publicAssignment(a, s, idx));
  const activeCount = assignments.filter((a) => ['ASSIGNED', 'CONFIRMED'].includes(a.status)).length;
  const rawVehicleAllocs = idx ? (idx.vehicleAllocsByShift.get(s.id) || []) : db.shift_vehicle_allocations.filter((x) => x.shift_id === s.id);
  const rawAssetAllocs = idx ? (idx.assetAllocsByShift.get(s.id) || []) : db.shift_asset_allocations.filter((x) => x.shift_id === s.id);
  return {
    ...s, site_name: site ? site.name : null,
    shift_type_name: type ? type.name : null, shift_type_key: type ? type.key : null, shift_type_color: type ? type.color : null,
    assignments,
    assigned_count: activeCount,
    coverage_gap: Math.max(0, s.required_headcount - activeCount),
    over_staffed: activeCount > s.required_headcount,
    vehicle_allocations: rawVehicleAllocs.map((a) => publicVehicleAllocation(a, idx)),
    asset_allocations: rawAssetAllocs.map((a) => publicAssetAllocation(a, idx)),
  };
}
function publicVehicle(v) {
  const p = v.assigned_personnel_id ? db.personnel.find((x) => x.id === v.assigned_personnel_id) : null;
  const site = v.site_id ? db.sites.find((x) => x.id === v.site_id) : null;
  return { ...v, assigned_personnel_name: p ? p.name : null, site_name: site ? site.name : null };
}
/** A stock-tracked asset's current level is never stored on the asset
 * itself — it's the resulting_balance of its most recent stock_movements
 * row, the same "derive, don't cache" shape as leave_balance/compliance.
 * An asset with no movements yet reads as zero, not unset. */
function stockLevel(assetId, movementsByAsset) {
  const movements = movementsByAsset ? (movementsByAsset.get(assetId) || []) : db.stock_movements.filter((m) => m.asset_id === assetId);
  return movements.length ? movements[movements.length - 1].resulting_balance : 0;
}
function recordStockMovement(assetId, delta, reason, note, shiftId, user) {
  const m = {
    id: nextId('stock_movements'), asset_id: assetId, delta, reason, note: note || '',
    shift_id: shiftId || null, resulting_balance: stockLevel(assetId) + delta,
    recorded_by: user.display_name, recorded_at: new Date().toISOString(),
  };
  db.stock_movements.push(m);
  return m;
}
function publicAsset(a, movementsByAsset) {
  const p = a.assigned_to ? db.personnel.find((x) => x.id === a.assigned_to) : null;
  const site = a.site_id ? db.sites.find((x) => x.id === a.site_id) : null;
  const parent = a.parent_asset_id ? db.assets.find((x) => x.id === a.parent_asset_id) : null;
  return {
    ...a, assigned_to_name: p ? p.name : null, site_name: site ? site.name : null,
    parent_asset_description: parent ? parent.description : null,
    stock_level: a.is_stock_tracked ? stockLevel(a.id, movementsByAsset) : null,
  };
}
function publicPassdownLog(l) {
  const site = db.sites.find((x) => x.id === l.site_id);
  return { ...l, site_name: site ? site.name : null };
}
function publicFuelLog(f) {
  const v = db.vehicles.find((x) => x.id === f.vehicle_id);
  const p = f.personnel_id ? db.personnel.find((x) => x.id === f.personnel_id) : null;
  return { ...f, vehicle_registration: v ? v.registration : null, driver_name: p ? p.name : null };
}
function publicMaintenanceLog(m) {
  const v = db.vehicles.find((x) => x.id === m.vehicle_id);
  return { ...m, vehicle_registration: v ? v.registration : null };
}
function publicAssetCheckout(c) {
  const p = db.personnel.find((x) => x.id === c.personnel_id);
  const byUser = db.users.find((x) => x.id === c.checked_out_by);
  const retUser = c.returned_by ? db.users.find((x) => x.id === c.returned_by) : null;
  return { ...c, personnel_name: p ? p.name : null, checked_out_by_name: byUser ? byUser.display_name : null, returned_by_name: retUser ? retUser.display_name : null };
}
const callsignOf = (r) => { const c = db.callsigns.find((x) => x.id === r.callsign_id); return c ? c.name : (r.mdt_code || r.name); };

/* ------------------------------------------------------------------ *
 * WebSocket message handling
 * ------------------------------------------------------------------ */
function handleWsMessage(conn, msg) {
  const { type, payload = {} } = msg;
  switch (type) {
    case 'ping': return conn.send('pong', {});
    case 'mdt.attach': {
      const mdt = findMdt(payload.mdt_code || payload.mdt_id);
      if (!mdt) return conn.send('error', { message: 'unknown MDT' });
      if (conn.user.role === 'MDT_USER' && conn.user.mdt_id !== mdt.id)
        return conn.send('error', { message: 'not authorised for this MDT' });
      conn.mdtId = mdt.id; mdt.connected = true; mdt.status = 'ONLINE';
      mdt.operator = conn.user.display_name;
      broadcast('mdt.status_changed', publicMdt(mdt));
      logEvent('mdt.connected', `${mdt.mdt_code} CONNECTED`, { mdt_id: mdt.id });
      return conn.send('mdt.attached', publicMdt(mdt));
    }
    default: return conn.send('error', { message: `unknown message ${type}` });
  }
}

/* ------------------------------------------------------------------ *
 * HTTP plumbing
 * ------------------------------------------------------------------ */
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

const routes = [];
const route = (method, pattern, roles, handler) => {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, regex, keys, roles, handler });
};

/* Replay protection. An MDT that went offline mid-shift resends its queued
 * writes on reconnect, and may resend the same one twice if the reply was lost.
 * Keyed replies are cached briefly so a repeat is answered, not re-applied. */
const idempotency = new Map();
const IDEMPOTENCY_TTL_MS = Number(process.env.IDEMPOTENCY_TTL_MS || 30 * 60 * 1000);

function idempotencyGet(key) {
  const hit = idempotency.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > IDEMPOTENCY_TTL_MS) { idempotency.delete(key); return null; }
  return hit;
}
function idempotencyPut(key, status, body) {
  idempotency.set(key, { at: Date.now(), status, body });
  if (idempotency.size > 5000) idempotency.delete(idempotency.keys().next().value);
}

const rate = new Map();
function rateLimit(ip) {
  const now = Date.now();
  const win = rate.get(ip) || { start: now, count: 0 };
  if (now - win.start > 60000) { win.start = now; win.count = 0; }
  win.count++; rate.set(ip, win);
  return win.count <= 600;
}

function authFrom(req, url) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token');
  const payload = verifyToken(token);
  if (!payload) return null;
  return db.users.find((u) => u.id === payload.sub) || null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.apk': 'application/vnd.android.package-archive',
};

/* Paths that accept an x-www-form-urlencoded body. Only Twilio's status
 * webhook needs one — Twilio cannot send JSON — and every other route stays
 * JSON-only: a form body is what a cross-site HTML <form> can POST without a
 * CORS preflight, so accepting it everywhere would widen what another origin
 * can make a signed-in browser send. */
const FORM_BODY_PATHS = new Set(['/api/sms/status']);

const requestHandler = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const send = (status, body, headers = {}) => {
    const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(payload);
  };

  if (url.pathname.startsWith('/api/')) {
    const ip = req.socket.remoteAddress || 'unknown';
    if (!rateLimit(ip)) return send(429, { error: 'rate limit exceeded' });
    let body = {};
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
      const chunks = [];
      let size = 0;
      // 1MB is plenty for every route except on-scene photo uploads (base64
      // JSON, ~33% larger than the source file) — raised to accommodate a
      // real phone photo rather than adding a second, route-specific limit.
      // The public application and further-information pages carry a CV and
      // licence photos in one request, so they get a little more room.
      const maxBody = url.pathname === '/api/public/applications' || url.pathname.startsWith('/api/public/info-request/') ? 2.5e7 : 9e6;
      for await (const c of req) { size += c.length; if (size > maxBody) { return send(413, { error: 'payload too large' }); } chunks.push(c); }
      const raw = Buffer.concat(chunks).toString();
      const ctype = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (raw && ctype === 'application/x-www-form-urlencoded' && FORM_BODY_PATHS.has(url.pathname)) {
        body = Object.fromEntries(new URLSearchParams(raw));
      } else if (raw) { try { body = JSON.parse(raw); } catch { return send(400, { error: 'invalid JSON body' }); } }
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.regex.exec(url.pathname);
      if (!m) continue;
      const params = {}; r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      let user = null;
      if (r.roles) {
        user = authFrom(req, url);
        if (!user) return send(401, { error: 'authentication required' });
        if (r.roles.length && !r.roles.includes(user.role)) return send(403, { error: 'insufficient role' });
      }
      const idemKey = req.headers['idempotency-key'];
      if (idemKey && user) {
        const cached = idempotencyGet(`${user.id}:${idemKey}`);
        if (cached) return send(cached.status, cached.body, { 'idempotent-replay': 'true' });
      }
      try {
        const out = await r.handler({ params, body, query: url.searchParams, user, req });
        // A handler that returns __stream (a large file read off disk) is
        // piped straight through rather than buffered into memory first —
        // the one exception to this dispatcher's otherwise fully-buffered
        // response model. Never cached by idempotency-key for the same
        // reason nothing else about a GET is: there is no write to replay.
        if (out && out.__stream) {
          res.writeHead(out.__status || 200, { 'cache-control': 'no-store', ...(out.__headers || {}) });
          out.__stream.on('error', () => { if (!res.writableEnded) res.end(); });
          return out.__stream.pipe(res);
        }
        const status = out && out.__status ? out.__status : 200;
        const payload = out && out.__body !== undefined ? out.__body : out;
        const extraHeaders = (out && out.__headers) || {};
        if (idemKey && user) idempotencyPut(`${user.id}:${idemKey}`, status, payload);
        return send(status, payload, extraHeaders);
      } catch (e) {
        if (!e.status) console.error('[cccs]', e);
        return send(e.status || 500, { error: e.message || 'internal error' });
      }
    }
    return send(404, { error: 'no such endpoint' });
  }

  // static files
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(__dirname, 'public', path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(path.join(__dirname, 'public'))) return send(403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(404, 'Not found', { 'content-type': 'text/plain' });
    send(200, data, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  });
};

const server = http.createServer(requestHandler);

// Direct HTTPS/WSS listener for clients that reach this host over IPv6
// (bypassing the IPv4-only edge proxy — see the certbot setup this was
// provisioned alongside). Only created when a certificate actually exists,
// so a fresh checkout without one still runs fine on plain HTTP behind the
// edge exactly as before.
const TLS_CERT_DIR = process.env.TLS_CERT_DIR || `/etc/letsencrypt/live/${process.env.TLS_DOMAIN || 'comms.echeloncic.com'}`;
let httpsServer = null;
try {
  const tlsOptions = {
    cert: fs.readFileSync(path.join(TLS_CERT_DIR, 'fullchain.pem')),
    key: fs.readFileSync(path.join(TLS_CERT_DIR, 'privkey.pem')),
  };
  httpsServer = https.createServer(tlsOptions, requestHandler);
  // Handshake failures never reach the request handler, so without this an
  // old client (e.g. Android 4.4 handsets) that can't negotiate just looks
  // like nothing happened server-side.
  httpsServer.on('tlsClientError', (err, sock) => console.warn(`[cccs] TLS handshake failed from ${sock && sock.remoteAddress}: ${err.message}`));
} catch {
  // No certificate on disk — direct HTTPS stays off, edge-proxied HTTP is unaffected.
}

function handleUpgrade(req, socket) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') return socket.destroy();
  const user = authFrom(req, url);
  const key = req.headers['sec-websocket-key'];
  if (!user || !key) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${wsAccept(key)}`, '\r\n'].join('\r\n'));
  socket.setNoDelay(true);
  const conn = new Conn(socket, user);
  conn.send('hello', { user: { id: user.id, username: user.username, role: user.role, display_name: user.display_name, personnel_id: user.personnel_id, mdt_id: user.mdt_id, client_id: user.client_id || null, branch_id: user.branch_id || null, ui_prefs: normalizeUiPrefs(user.ui_prefs) } });
}
server.on('upgrade', handleUpgrade);
httpsServer?.on('upgrade', handleUpgrade);

/* ------------------------------------------------------------------ *
 * REST API
 * ------------------------------------------------------------------ */
// The five internal/staff roles — everything gated ALL today predates CLIENT
// and FINANCE and was written assuming "any authenticated user" meant "any
// employee with dispatch access". Not ROLES, deliberately: see the comment
// on ROLES above — CLIENT and FINANCE both stay out of ALL on purpose.
const ALL = ['SYSTEM_ADMIN', 'DISPATCHER', 'SUPERVISOR', 'FIELD_USER', 'MDT_USER'];
const CONTROL = ['DISPATCHER', 'SUPERVISOR', 'SYSTEM_ADMIN'];
const ADMIN = ['SYSTEM_ADMIN'];
const CLIENT = ['CLIENT'];
const FINANCE = ['FINANCE'];

/* Per-operator UI preferences (theme, mode, surface, sound) — stored on the
 * user row so they follow a login to any terminal, not per-browser
 * localStorage. Lazily defaulted: an existing user row with no ui_prefs at
 * all reads as DEFAULT_UI_PREFS rather than needing a migration. */
const THEMES = ['cosmic', 'midnight', 'harbour', 'rosewood', 'terminal', 'graphite'];
const UI_MODES = ['system', 'dark', 'light'];
const BLOOMS = ['violet', 'blue', 'teal', 'rose', 'none'];
const PANEL_STYLES = ['translucent', 'solid'];
const CORNER_STYLES = ['sharp', 'soft', 'round'];
const PRIORITY_RAMPS = ['standard', 'cbf'];
const DEFAULT_UI_PREFS = {
  theme: 'harbour', mode: 'system', bloom: 'teal', panels: 'translucent', corners: 'soft',
  glow: false, priority_ramp: 'standard', sound: true, reduce_motion: false,
};
function normalizeUiPrefs(p) {
  p = p || {};
  return {
    theme: THEMES.includes(p.theme) ? p.theme : DEFAULT_UI_PREFS.theme,
    mode: UI_MODES.includes(p.mode) ? p.mode : DEFAULT_UI_PREFS.mode,
    bloom: BLOOMS.includes(p.bloom) ? p.bloom : DEFAULT_UI_PREFS.bloom,
    panels: PANEL_STYLES.includes(p.panels) ? p.panels : DEFAULT_UI_PREFS.panels,
    corners: CORNER_STYLES.includes(p.corners) ? p.corners : DEFAULT_UI_PREFS.corners,
    glow: Boolean(p.glow),
    priority_ramp: PRIORITY_RAMPS.includes(p.priority_ramp) ? p.priority_ramp : DEFAULT_UI_PREFS.priority_ramp,
    sound: p.sound !== false,
    reduce_motion: Boolean(p.reduce_motion),
  };
}
const publicUser = (u) => ({ id: u.id, username: u.username, role: u.role, display_name: u.display_name, personnel_id: u.personnel_id, mdt_id: u.mdt_id, client_id: u.client_id || null, branch_id: u.branch_id || null, site_ids: Array.isArray(u.site_ids) ? u.site_ids : null, email: u.email || null, ui_prefs: normalizeUiPrefs(u.ui_prefs) });

route('POST', '/api/auth/login', null, ({ body }) => {
  const user = db.users.find((u) => u.username === String(body.username || '').toLowerCase());
  if (!user || !verifyPassword(String(body.password || ''), user.password_hash)) {
    logEvent('auth.failed', `Failed login for ${body.username}`);
    throw httpError(401, 'invalid credentials');
  }
  const ttl = user.role === 'MDT_USER' ? MDT_TOKEN_TTL_MS : TOKEN_TTL_MS;
  const token = sign({ sub: user.id, role: user.role, exp: Date.now() + ttl });
  logEvent('auth.login', `${user.username} signed in (${user.role})`, { user_id: user.id });
  return { token, user: publicUser(user) };
});
route('PATCH', '/api/me/preferences', ALL, ({ body, user }) => {
  const u = db.users.find((x) => x.id === user.id); if (!u) throw httpError(404, 'account not found');
  const next = normalizeUiPrefs(u.ui_prefs);
  if ('theme' in body) { if (!THEMES.includes(body.theme)) throw httpError(400, 'invalid theme'); next.theme = body.theme; }
  if ('mode' in body) { if (!UI_MODES.includes(body.mode)) throw httpError(400, 'invalid mode'); next.mode = body.mode; }
  if ('bloom' in body) { if (!BLOOMS.includes(body.bloom)) throw httpError(400, 'invalid bloom'); next.bloom = body.bloom; }
  if ('panels' in body) { if (!PANEL_STYLES.includes(body.panels)) throw httpError(400, 'invalid panels'); next.panels = body.panels; }
  if ('corners' in body) { if (!CORNER_STYLES.includes(body.corners)) throw httpError(400, 'invalid corners'); next.corners = body.corners; }
  if ('priority_ramp' in body) { if (!PRIORITY_RAMPS.includes(body.priority_ramp)) throw httpError(400, 'invalid priority_ramp'); next.priority_ramp = body.priority_ramp; }
  if ('glow' in body) next.glow = Boolean(body.glow);
  if ('sound' in body) next.sound = Boolean(body.sound);
  if ('reduce_motion' in body) next.reduce_motion = Boolean(body.reduce_motion);
  u.ui_prefs = next;
  return publicUser(u);
});

/* ---- Microsoft Entra ID (Azure AD) single sign-on --------------------
 * Alongside local username/password, never replacing it. A Microsoft sign-in
 * only succeeds if its email/UPN matches an existing CCCS account's `email`
 * field — SSO never creates an account, it only unlocks one an admin already
 * set up, so role and personnel/MDT bindings stay under admin control. */
const ssoState = new Map();   // csrf nonce -> created-at, cleared on use
const ssoExchange = new Map(); // one-time code -> { token, user, created }
const SSO_TTL_MS = 5 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - SSO_TTL_MS;
  for (const [k, at] of ssoState) if (at < cutoff) ssoState.delete(k);
  for (const [k, v] of ssoExchange) if (v.created < cutoff) ssoExchange.delete(k);
}, 60 * 1000).unref?.();

route('GET', '/api/auth/microsoft/status', null, () => ({ enabled: MS_ENABLED }));

route('GET', '/api/auth/microsoft/login', null, () => {
  if (!MS_ENABLED) throw httpError(404, 'Microsoft sign-in is not configured');
  const state = crypto.randomBytes(16).toString('hex');
  ssoState.set(state, Date.now());
  const params = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    response_type: 'code',
    redirect_uri: MS_REDIRECT_URI,
    response_mode: 'query',
    scope: 'openid profile email',
    state,
  });
  return { __status: 302, __headers: { location: `https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/authorize?${params}` }, __body: '' };
});

route('GET', '/api/auth/microsoft/callback', null, async ({ query }) => {
  if (!MS_ENABLED) throw httpError(404, 'Microsoft sign-in is not configured');
  const oauthError = query.get('error');
  if (oauthError) throw httpError(400, query.get('error_description') || oauthError);

  const state = query.get('state');
  if (!state || !ssoState.delete(state)) throw httpError(400, 'that sign-in attempt expired — try again');

  const code = query.get('code');
  if (!code) throw httpError(400, 'missing authorization code');

  const tokenRes = await fetch(`https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: MS_CLIENT_ID, client_secret: MS_CLIENT_SECRET,
      code, redirect_uri: MS_REDIRECT_URI, grant_type: 'authorization_code',
    }),
  });
  const tokenBody = await tokenRes.json();
  if (!tokenRes.ok) {
    console.error('[cccs] microsoft token exchange failed', tokenBody);
    throw httpError(502, 'Microsoft sign-in failed — see server logs');
  }

  let claims;
  try {
    claims = await verifyMicrosoftIdToken(tokenBody.id_token, { tenantId: MS_TENANT_ID, clientId: MS_CLIENT_ID });
  } catch (e) {
    console.error('[cccs] microsoft id_token rejected:', e.message);
    throw httpError(401, 'Microsoft sign-in could not be verified');
  }

  const email = String(claims.email || claims.preferred_username || '').toLowerCase();
  const localUser = email ? db.users.find((u) => u.email && u.email.toLowerCase() === email) : null;
  if (!localUser) {
    logEvent('auth.sso_denied', `Microsoft sign-in for ${email || '(no email claim)'} has no matching CCCS account`);
    const msg = encodeURIComponent('No CCCS account is linked to that Microsoft account. Ask an admin to set its email address.');
    return { __status: 302, __headers: { location: `/index.html?sso_error=${msg}` }, __body: '' };
  }

  const token = sign({ sub: localUser.id, role: localUser.role, exp: Date.now() + TOKEN_TTL_MS });
  const oneTime = crypto.randomBytes(16).toString('hex');
  ssoExchange.set(oneTime, { token, user: publicUser(localUser), created: Date.now() });
  logEvent('auth.login', `${localUser.username} signed in via Microsoft (${localUser.role})`, { user_id: localUser.id });
  return { __status: 302, __headers: { location: `/index.html?sso=${oneTime}` }, __body: '' };
});

route('GET', '/api/auth/microsoft/session', null, ({ query }) => {
  const code = query.get('code');
  const entry = code && ssoExchange.get(code);
  if (!entry) throw httpError(400, 'that sign-in code is invalid or already used');
  ssoExchange.delete(code);
  return { token: entry.token, user: entry.user };
});
route('GET', '/api/me', ALL, ({ user }) => publicUser(user));

// Web Push — lets a phone with the console added to its home screen get
// emergency, call and job alerts while it isn't open. See webpush.js.
route('GET', '/api/push/vapid-public-key', ALL, () => ({ key: webpush.getPublicKeyBase64Url() }));
route('POST', '/api/push/subscribe', ALL, ({ body, user }) => {
  const sub = body.subscription || body;
  const { endpoint, keys } = sub;
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) throw httpError(400, 'invalid push subscription');
  const existing = db.push_subscriptions.find((s) => s.endpoint === endpoint);
  if (existing) { existing.user_id = user.id; existing.p256dh = keys.p256dh; existing.auth = keys.auth; }
  else db.push_subscriptions.push({ id: nextId('push_subscriptions'), user_id: user.id, endpoint, p256dh: keys.p256dh, auth: keys.auth, created_at: new Date().toISOString() });
  return { ok: true };
});
route('DELETE', '/api/push/subscribe', ALL, ({ body, user }) => {
  db.push_subscriptions = db.push_subscriptions.filter((s) => !(s.endpoint === body.endpoint && s.user_id === user.id));
  return { ok: true };
});


// MDTs, vehicles, personnel
route('GET', '/api/mdts', ALL, () => db.mdts.map(publicMdt));

/* Crew sign-in/out is separate from terminal auth: the vehicle terminal stays
 * signed in for the shift (or longer), while personnel come and go from it.
 * This is what tells control who was actually in the car for a given call. */
const MDT_CREW = [...CONTROL, 'MDT_USER'];
route('POST', '/api/mdts/:id/crew', MDT_CREW, ({ params, body, user }) => {
  const m = db.mdts.find((x) => x.id === Number(params.id)); if (!m) throw httpError(404, 'MDT not found');
  if (user.role === 'MDT_USER' && user.mdt_id !== m.id) throw httpError(403, 'not your terminal');
  const name = String(body.name || '').trim();
  if (!name) throw httpError(400, 'crew member name required');
  m.crew = m.crew || [];
  if (m.crew.length >= 3) throw httpError(409, 'this terminal already has 3 crew signed in');
  if (m.crew.some((c) => c.name.toLowerCase() === name.toLowerCase())) throw httpError(409, `${name} is already signed in`);
  const member = { id: nextId('mdt_crew'), name, signed_in_at: new Date().toISOString() };
  m.crew.push(member);
  broadcast('mdt.crew_changed', publicMdt(m));
  logEvent('mdt.crew_signed_in', `${name} SIGNED IN TO ${m.mdt_code}`, { mdt_id: m.id });
  return { __status: 201, __body: publicMdt(m) };
});
route('DELETE', '/api/mdts/:id/crew/:crewId', MDT_CREW, ({ params, user }) => {
  const m = db.mdts.find((x) => x.id === Number(params.id)); if (!m) throw httpError(404, 'MDT not found');
  if (user.role === 'MDT_USER' && user.mdt_id !== m.id) throw httpError(403, 'not your terminal');
  const idx = (m.crew || []).findIndex((c) => c.id === Number(params.crewId));
  if (idx < 0) throw httpError(404, 'crew member not found');
  const [removed] = m.crew.splice(idx, 1);
  broadcast('mdt.crew_changed', publicMdt(m));
  logEvent('mdt.crew_signed_out', `${removed.name} SIGNED OUT OF ${m.mdt_code}`, { mdt_id: m.id });
  return publicMdt(m);
});

/* Manual duty status, independent of job assignment — a vehicle can declare
 * itself busy or out of service even with nothing dispatched to it. Job
 * status (EN_ROUTE etc.) is separate and takes over once a job exists. */
const MDT_DUTY_STATUSES = ['AVAILABLE', 'BUSY', 'MEAL_BREAK', 'OUT_OF_SERVICE'];
route('POST', '/api/mdts/:id/duty-status', MDT_CREW, ({ params, body, user }) => {
  const m = db.mdts.find((x) => x.id === Number(params.id)); if (!m) throw httpError(404, 'MDT not found');
  if (user.role === 'MDT_USER' && user.mdt_id !== m.id) throw httpError(403, 'not your terminal');
  const status = String(body.status || '').toUpperCase();
  if (!MDT_DUTY_STATUSES.includes(status)) throw httpError(400, `invalid status ${status}`);
  m.duty_status = status;
  broadcast('mdt.status_changed', publicMdt(m));
  logEvent('mdt.duty_status', `${m.mdt_code} → ${status}`, { mdt_id: m.id });
  return publicMdt(m);
});

route('POST', '/api/mdts/:id/location', MDT_CREW, ({ params, body, user }) => {
  const m = db.mdts.find((x) => x.id === Number(params.id)); if (!m) throw httpError(404, 'MDT not found');
  if (user.role === 'MDT_USER' && user.mdt_id !== m.id) throw httpError(403, 'not your terminal');
  m.lat = Number(body.lat); m.lon = Number(body.lon);
  // This never wrote to db.locations at all before -- confirmed live during
  // the radio removal, only the (now-deleted) radio location route did.
  // Adding the write here rather than leaving GPS history/retention-sweep
  // silently empty for every terminal going forward.
  db.locations.push({ id: nextId('locations'), mdt_id: m.id, personnel_id: null, lat: m.lat, lon: m.lon, speed: null, heading: null, at: new Date().toISOString() });
  checkAutoJobProgress(m, m.lat, m.lon);
  broadcast('mdt.status_changed', publicMdt(m));
  return publicMdt(m);
});

route('POST', '/api/mdts', ADMIN, ({ body }) => {
  const mdt_code = String(body.mdt_code || '').trim().toUpperCase();
  if (!mdt_code) throw httpError(400, 'mdt_code is required');
  if (db.mdts.some((m) => m.mdt_code === mdt_code)) throw httpError(409, 'MDT code already exists');
  const cs = body.callsign ? findCallsign(body.callsign) : null;
  const m = {
    id: nextId('mdts'), mdt_code, serial: body.serial || mdt_code, callsign_id: cs ? cs.id : null,
    vehicle_id: null, status: 'OFFLINE', duty_status: 'AVAILABLE', job_id: null, battery: 100,
    network: 'LTE', operator: null, lat: null, lon: null, connected: false, crew: [], emergency: false,
  };
  db.mdts.push(m);
  broadcast('mdt.created', publicMdt(m));
  logEvent('mdt.created', `MDT ${mdt_code} CREATED`, { mdt_id: m.id });
  return { __status: 201, __body: publicMdt(m) };
});
route('PATCH', '/api/mdts/:id', ADMIN, ({ params, body }) => {
  const m = db.mdts.find((x) => x.id === Number(params.id));
  if (!m) throw httpError(404, 'MDT not found');
  if ('mdt_code' in body) {
    const mdt_code = String(body.mdt_code || '').trim().toUpperCase();
    if (!mdt_code) throw httpError(400, 'mdt_code is required');
    if (db.mdts.some((x) => x.id !== m.id && x.mdt_code === mdt_code)) throw httpError(409, 'MDT code already exists');
    m.mdt_code = mdt_code;
  }
  if ('serial' in body) m.serial = String(body.serial || '').trim() || m.mdt_code;
  if ('callsign' in body) {
    const cs = body.callsign ? findCallsign(body.callsign) : null;
    m.callsign_id = cs ? cs.id : null;
  }
  broadcast('mdt.status_changed', publicMdt(m));
  logEvent('mdt.updated', `MDT ${m.mdt_code} UPDATED`, { mdt_id: m.id });
  return publicMdt(m);
});
route('DELETE', '/api/mdts/:id', ADMIN, ({ params }) => {
  const m = db.mdts.find((x) => x.id === Number(params.id));
  if (!m) throw httpError(404, 'MDT not found');
  if (m.job_id) throw httpError(409, 'MDT is assigned to an open job — stand it down first');
  if (db.users.some((u) => u.mdt_id === m.id)) throw httpError(409, 'an account is still linked to this MDT — unlink it from the account first');
  db.mdts = db.mdts.filter((x) => x.id !== m.id);
  broadcast('mdt.deleted', { id: m.id, mdt_code: m.mdt_code });
  logEvent('mdt.deleted', `MDT ${m.mdt_code} DELETED`, { mdt_id: m.id });
  return { ok: true };
});
const VEHICLE_STATUSES = ['ACTIVE', 'IN_SERVICE', 'OFF_ROAD'];
route('GET', '/api/vehicles', ALL, ({ user }) => db.vehicles.filter((v) => visibleToUser(v, user)).map(publicVehicle));
route('POST', '/api/vehicles', ADMIN, ({ body }) => {
  const registration = String(body.registration || '').trim().toUpperCase();
  if (!registration) throw httpError(400, 'registration required');
  if (db.vehicles.some((x) => x.registration === registration)) throw httpError(409, 'a vehicle with that registration already exists');
  const p = body.assigned_personnel_id ? db.personnel.find((x) => x.id === Number(body.assigned_personnel_id)) : null;
  const homeSite = body.site_id ? db.sites.find((x) => x.id === Number(body.site_id)) : null;
  const v = {
    id: nextId('vehicles'), registration, type: body.type || 'Vehicle', make: body.make || '', model: body.model || '',
    service_due_at: body.service_due_at || null, insurance_due_at: body.insurance_due_at || null,
    mot_due_at: body.mot_due_at || null, tax_due_at: body.tax_due_at || null,
    site_id: homeSite ? homeSite.id : null,
    mileage: body.mileage != null && body.mileage !== '' ? Number(body.mileage) : null, condition: body.condition || '',
    assigned_personnel_id: p ? p.id : null,
    status: VEHICLE_STATUSES.includes(body.status) ? body.status : 'ACTIVE', notes: body.notes || '',
    branch_id: normalizedBranchId(body.branch_id),
  };
  db.vehicles.push(v);
  logEvent('vehicle.created', `VEHICLE ${registration} ADDED`, { vehicle_id: v.id });
  return { __status: 201, __body: publicVehicle(v) };
});
route('PATCH', '/api/vehicles/:id', ADMIN, ({ params, body }) => {
  const v = db.vehicles.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'vehicle not found');
  if ('registration' in body) {
    const registration = String(body.registration || '').trim().toUpperCase();
    if (!registration) throw httpError(400, 'registration required');
    if (db.vehicles.some((x) => x.id !== v.id && x.registration === registration)) throw httpError(409, 'a vehicle with that registration already exists');
    v.registration = registration;
  }
  if ('type' in body) v.type = body.type || 'Vehicle';
  if ('make' in body) v.make = body.make || '';
  if ('model' in body) v.model = body.model || '';
  if ('service_due_at' in body) v.service_due_at = body.service_due_at || null;
  if ('insurance_due_at' in body) v.insurance_due_at = body.insurance_due_at || null;
  if ('mot_due_at' in body) v.mot_due_at = body.mot_due_at || null;
  if ('deep_clean_at' in body) v.deep_clean_at = body.deep_clean_at || null;
  if ('deep_clean_interval_days' in body) {
    const d = body.deep_clean_interval_days === null || body.deep_clean_interval_days === '' ? null : Number(body.deep_clean_interval_days);
    if (d !== null && (!Number.isInteger(d) || d < 1 || d > 365)) throw httpError(400, 'deep_clean_interval_days must be 1-365');
    v.deep_clean_interval_days = d;
  }
  if ('tax_due_at' in body) v.tax_due_at = body.tax_due_at || null;
  if ('site_id' in body) { const homeSite = body.site_id ? db.sites.find((x) => x.id === Number(body.site_id)) : null; v.site_id = homeSite ? homeSite.id : null; }
  if ('mileage' in body) v.mileage = body.mileage != null && body.mileage !== '' ? Number(body.mileage) : null;
  if ('condition' in body) v.condition = body.condition || '';
  if ('assigned_personnel_id' in body) { const p = body.assigned_personnel_id ? db.personnel.find((x) => x.id === Number(body.assigned_personnel_id)) : null; v.assigned_personnel_id = p ? p.id : null; }
  if ('branch_id' in body) v.branch_id = normalizedBranchId(body.branch_id);
  if ('status' in body) { if (!VEHICLE_STATUSES.includes(body.status)) throw httpError(400, 'invalid status'); v.status = body.status; }
  if ('notes' in body) v.notes = body.notes || '';
  logEvent('vehicle.updated', `VEHICLE ${v.registration} UPDATED`, { vehicle_id: v.id });
  return publicVehicle(v);
});
route('DELETE', '/api/vehicles/:id', ADMIN, ({ params }) => {
  const v = db.vehicles.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'vehicle not found');
  if (db.mdts.some((m) => m.vehicle_id === v.id)) throw httpError(409, 'an MDT is still linked to this vehicle — unlink it first');
  if (db.personnel.some((p) => p.vehicle_id === v.id)) throw httpError(409, 'a person is still linked to this vehicle — unlink them first');
  db.vehicles = db.vehicles.filter((x) => x.id !== v.id);
  logEvent('vehicle.deleted', `VEHICLE ${v.registration} DELETED`, { vehicle_id: v.id });
  return { ok: true };
});

/* Fuel-up records against a vehicle — odometer, litres, cost, an optional
 * receipt photo, and who filled up. Anyone can log one (whoever's driving is
 * the one at the pump); only admin can delete, for correcting a mistake. */
const fuelReceiptDir = (fuelLogId) => path.join(UPLOADS_DIR, 'fuel', String(fuelLogId));
route('GET', '/api/vehicles/:id/fuel-logs', ALL, ({ params }) => {
  const v = db.vehicles.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'vehicle not found');
  return db.fuel_logs.filter((f) => f.vehicle_id === v.id)
    .sort((a, b) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at))
    .map(publicFuelLog);
});
/** One fuel-log shape for both ways in: the fuel route below and the
 * "Vehicle fuel-up" form (applyVehicleReport). */
function createFuelLog(v, user, body, extra = {}) {
  const litres = Number(body.litres);
  if (!litres || litres <= 0) throw httpError(400, 'litres required');
  const odometer = body.odometer != null && body.odometer !== '' ? Number(body.odometer) : null;
  const cost = body.cost != null && body.cost !== '' ? Number(body.cost) : null;
  const driver = user.role === 'FIELD_USER' && user.personnel_id
    ? db.personnel.find((p) => p.id === user.personnel_id)
    : (body.personnel_id ? db.personnel.find((p) => p.id === Number(body.personnel_id)) : null);
  const log = {
    id: nextId('fuel_logs'), vehicle_id: v.id, personnel_id: driver ? driver.id : null,
    odometer, litres, cost: cost != null && !isNaN(cost) ? cost : null,
    fuel_type: body.fuel_type || '', notes: body.notes || '', receipt: null,
    recorded_at: new Date().toISOString(), created_by: user.id, created_at: new Date().toISOString(), ...extra,
  };
  db.fuel_logs.push(log);
  if (odometer != null && !isNaN(odometer)) v.mileage = odometer;
  logEvent('fuel_log.created', `FUEL LOG ADDED FOR ${v.registration} — ${litres}L`, { vehicle_id: v.id, fuel_log_id: log.id });
  return log;
}
route('POST', '/api/vehicles/:id/fuel-logs', ALL, ({ params, body, user }) => {
  const v = db.vehicles.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'vehicle not found');
  return { __status: 201, __body: publicFuelLog(createFuelLog(v, user, body)) };
});

/**
 * What a vehicle form changes on the vehicle itself, by the form's `effect`
 * (see routes-forms.js). Runs after the report is safely stored; the report
 * is the record, this keeps the vehicle's own fields in step with it.
 *
 * Mileage from a form only ever moves FORWARD. An odometer reading lower
 * than the one on file is far more likely a typo than a rolled-back clock,
 * and silently rewinding the mileage would hide service intervals coming
 * due — so it is kept on the report (and the fuel log) but not applied.
 */
function applyVehicleReport(effect, vehicleId, values, user, submission) {
  const v = db.vehicles.find((x) => x.id === Number(vehicleId));
  if (!v) return;
  const forwardMileage = (reading) => {
    const n = Number(reading);
    if (reading == null || reading === '' || !Number.isFinite(n) || n < 0) return;
    if (v.mileage == null || n >= Number(v.mileage)) v.mileage = n;
    else logEvent('vehicle.mileage_not_rewound', `${v.registration}: ${submission.reference} gave ${n} miles, below the ${v.mileage} on file — kept on the report, mileage not changed`, { vehicle_id: v.id, submission_id: submission.id });
  };
  if (effect === 'FUEL_UP') {
    const before = v.mileage;
    createFuelLog(v, user, { litres: values.litres, odometer: null, cost: values.cost, fuel_type: values.fuel_type || '', notes: values.notes || '' },
      { odometer: values.odometer != null ? Number(values.odometer) : null, form_submission_id: submission.id, form_reference: submission.reference });
    v.mileage = before; forwardMileage(values.odometer);
  } else if (effect === 'DEEP_CLEAN') {
    const at = values.cleaned_at && !isNaN(Date.parse(values.cleaned_at)) ? new Date(values.cleaned_at).toISOString() : new Date().toISOString();
    if (!v.deep_clean_at || at > v.deep_clean_at) v.deep_clean_at = at;
    logEvent('vehicle.deep_cleaned', `${v.registration} DEEP CLEANED (${submission.reference})`, { vehicle_id: v.id, submission_id: submission.id });
  } else if (effect === 'INSPECTION') {
    forwardMileage(values.odometer);
  }
}
/**
 * A vehicle report was corrected after filing (routes-forms.js, PATCH
 * /api/form-submissions/:id): bring the vehicle back in line with it.
 *
 * Mileage stays forward-only for new readings, with one exception — when
 * the vehicle's mileage IS the reading being corrected (this report set
 * it), the typo is taken back out: mileage becomes the highest reading on
 * record without it. A correction never lowers mileage another record set.
 * The deep-clean date works the same way.
 */
function reapplyVehicleReport(effect, vehicleId, before, after, user, submission) {
  const v = db.vehicles.find((x) => x.id === Number(vehicleId));
  if (!v) return;
  const num = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
  const oldOdo = num(before.odometer), newOdo = num(after.odometer);
  if ((effect === 'FUEL_UP' || effect === 'INSPECTION') && oldOdo !== newOdo) {
    if (oldOdo != null && Number(v.mileage) === oldOdo) {
      const others = [
        ...db.fuel_logs.filter((f) => f.vehicle_id === v.id && f.form_submission_id !== submission.id).map((f) => num(f.odometer)),
        ...db.form_submissions.filter((s) => s.id !== submission.id && s.subject_type === 'VEHICLE' && s.subject_id === v.id
          && ['FUEL_UP', 'INSPECTION'].includes(s.effect_applied)).map((s) => num(s.values.odometer)),
        newOdo,
      ].filter((x) => x != null);
      const was = v.mileage;
      v.mileage = others.length ? Math.max(...others) : null;
      logEvent('vehicle.mileage_corrected', `${v.registration} MILEAGE ${was} → ${v.mileage ?? 'not recorded'} (${submission.reference} corrected by ${user.display_name})`, { vehicle_id: v.id, submission_id: submission.id });
    } else if (newOdo != null && (v.mileage == null || newOdo > Number(v.mileage))) {
      v.mileage = newOdo;
    }
  }
  if (effect === 'FUEL_UP') {
    const log = db.fuel_logs.find((f) => f.form_submission_id === submission.id);
    if (log) {
      const litres = num(after.litres);
      if (litres && litres > 0) log.litres = litres;
      log.cost = num(after.cost); log.odometer = newOdo;
      log.fuel_type = after.fuel_type || ''; log.notes = after.notes || '';
      log.updated_at = new Date().toISOString();
    }
  }
  if (effect === 'DEEP_CLEAN') {
    const at = (vals, sub) => (vals.cleaned_at && !isNaN(Date.parse(vals.cleaned_at)) ? new Date(vals.cleaned_at).toISOString() : sub.submitted_at);
    const oldAt = at(before, submission), newAt = at(after, submission);
    if (oldAt === newAt) return;
    if (v.deep_clean_at === oldAt) {
      const all = db.form_submissions.filter((s) => s.subject_type === 'VEHICLE' && s.subject_id === v.id && s.effect_applied === 'DEEP_CLEAN')
        .map((s) => (s.id === submission.id ? newAt : at(s.values, s)));
      v.deep_clean_at = all.sort().pop() || newAt;
    } else if (!v.deep_clean_at || newAt > v.deep_clean_at) {
      v.deep_clean_at = newAt;
    }
  }
}
route('POST', '/api/fuel-logs/:id/receipt', ALL, ({ params, body }) => {
  const f = db.fuel_logs.find((x) => x.id === Number(params.id)); if (!f) throw httpError(404, 'fuel log not found');
  const ext = MEDIA_MIME_EXT[body.mimetype];
  if (!ext) throw httpError(400, 'mimetype must be image/jpeg, image/png or image/webp');
  if (!body.data) throw httpError(400, 'data (base64) required');
  const bytes = Buffer.from(body.data, 'base64');
  if (bytes.length > 8e6) throw httpError(413, 'photo too large');
  const dir = fuelReceiptDir(f.id);
  fs.mkdirSync(dir, { recursive: true });
  const mediaId = crypto.randomUUID();
  const filename = `${mediaId}${ext}`;
  fs.writeFileSync(path.join(dir, filename), bytes);
  f.receipt = { id: mediaId, url: `/api/fuel-logs/${f.id}/receipt/${mediaId}`, filename };
  logEvent('fuel_log.receipt_added', `RECEIPT ADDED TO FUEL LOG ${f.id}`, { fuel_log_id: f.id, vehicle_id: f.vehicle_id });
  return { __status: 201, __body: publicFuelLog(f) };
});
route('GET', '/api/fuel-logs/:id/receipt/:mediaId', ALL, ({ params }) => {
  const f = db.fuel_logs.find((x) => x.id === Number(params.id)); if (!f) throw httpError(404, 'fuel log not found');
  if (!f.receipt || f.receipt.id !== params.mediaId) throw httpError(404, 'receipt not found');
  const file = path.join(fuelReceiptDir(f.id), f.receipt.filename);
  if (!fs.existsSync(file)) throw httpError(404, 'receipt file missing');
  return { __body: fs.readFileSync(file), __headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'private, max-age=86400' } };
});
route('DELETE', '/api/fuel-logs/:id', ADMIN, ({ params }) => {
  const f = db.fuel_logs.find((x) => x.id === Number(params.id)); if (!f) throw httpError(404, 'fuel log not found');
  db.fuel_logs = db.fuel_logs.filter((x) => x.id !== f.id);
  logEvent('fuel_log.deleted', 'FUEL LOG DELETED', { fuel_log_id: f.id, vehicle_id: f.vehicle_id });
  return { ok: true };
});

/* Vehicle maintenance history — a record of what was done, and when it's due
 * again. Logging one with next_due_at also updates the vehicle's own
 * service_due_at, the same "the record updates the summary field" pattern
 * fuel logs use for mileage. Control-only to log (coordinating a garage
 * visit isn't something an officer does), same read access as everything
 * else vehicle-related. */
route('GET', '/api/vehicles/:id/maintenance-logs', ALL, ({ params }) => {
  const v = db.vehicles.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'vehicle not found');
  return db.maintenance_logs.filter((m) => m.vehicle_id === v.id)
    .sort((a, b) => Date.parse(b.performed_at) - Date.parse(a.performed_at))
    .map(publicMaintenanceLog);
});
route('POST', '/api/vehicles/:id/maintenance-logs', CONTROL, ({ params, body, user }) => {
  const v = db.vehicles.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'vehicle not found');
  const description = String(body.description || '').trim();
  if (!description) throw httpError(400, 'description required');
  const cost = body.cost != null && body.cost !== '' ? Number(body.cost) : null;
  const odometer = body.odometer != null && body.odometer !== '' ? Number(body.odometer) : null;
  const performedAt = body.performed_at ? new Date(body.performed_at) : new Date();
  if (isNaN(performedAt)) throw httpError(400, 'invalid performed_at');
  const nextDueAt = body.next_due_at ? new Date(body.next_due_at) : null;
  if (body.next_due_at && isNaN(nextDueAt)) throw httpError(400, 'invalid next_due_at');
  const log = {
    id: nextId('maintenance_logs'), vehicle_id: v.id, description,
    cost: cost != null && !isNaN(cost) ? cost : null, odometer: odometer != null && !isNaN(odometer) ? odometer : null,
    performed_at: performedAt.toISOString(), next_due_at: nextDueAt ? nextDueAt.toISOString() : null,
    notes: body.notes || '', created_by: user.id, created_at: new Date().toISOString(),
  };
  db.maintenance_logs.push(log);
  if (odometer != null && !isNaN(odometer)) v.mileage = odometer;
  if (nextDueAt) v.service_due_at = nextDueAt.toISOString();
  logEvent('maintenance_log.created', `MAINTENANCE LOGGED FOR ${v.registration}: ${description}`, { vehicle_id: v.id, maintenance_log_id: log.id });
  return { __status: 201, __body: publicMaintenanceLog(log) };
});
route('DELETE', '/api/maintenance-logs/:id', ADMIN, ({ params }) => {
  const m = db.maintenance_logs.find((x) => x.id === Number(params.id)); if (!m) throw httpError(404, 'maintenance log not found');
  db.maintenance_logs = db.maintenance_logs.filter((x) => x.id !== m.id);
  logEvent('maintenance_log.deleted', 'MAINTENANCE LOG DELETED', { maintenance_log_id: m.id, vehicle_id: m.vehicle_id });
  return { ok: true };
});

const ASSET_CATEGORIES = ['EQUIPMENT', 'UNIFORM', 'KEY', 'DEVICE', 'RADIO', 'BODY_CAMERA', 'PPE', 'FIRST_AID', 'IT', 'CONSUMABLE', 'OTHER'];
const ASSET_STATUSES = ['IN_USE', 'IN_STORE', 'IN_REPAIR', 'ON_HIRE', 'LOST', 'RETIRED'];
const ASSET_CONDITIONS = ['NEW', 'GOOD', 'FAIR', 'POOR', 'DAMAGED'];
/** The asset-register and stock-catalogue details (routes-inventory.js):
 * shared by create and edit, each field optional and validated. */
function applyAssetExtras(a, body) {
  const str = (k, max = 120) => { if (k in body) a[k] = String(body[k] ?? '').trim().slice(0, max); };
  const num = (k) => {
    if (!(k in body)) return;
    if (body[k] === null || body[k] === '') { a[k] = null; return; }
    const n = Number(body[k]);
    if (!Number.isFinite(n) || n < 0) throw httpError(400, `${k.replace(/_/g, ' ')} must be a number of 0 or more`);
    a[k] = n;
  };
  const date = (k) => {
    if (!(k in body)) return;
    if (!body[k]) { a[k] = null; return; }
    if (!/^\d{4}-\d{2}-\d{2}/.test(String(body[k])) || isNaN(Date.parse(body[k]))) throw httpError(400, `${k.replace(/_/g, ' ')} must be a date`);
    a[k] = String(body[k]).slice(0, 10);
  };
  ['make', 'model', 'supplier', 'unit', 'size', 'check_type'].forEach((k) => str(k));
  if ('sku' in body) {
    const sku = String(body.sku || '').trim().slice(0, 60) || null;
    if (sku && db.assets.some((x) => x.id !== a.id && x.sku === sku)) throw httpError(409, 'another item already uses that code');
    a.sku = sku;
  }
  ['purchase_cost', 'unit_cost', 'reorder_qty', 'check_interval_days', 'pat_interval_days'].forEach(num);
  ['warranty_expires_at', 'next_check_due_at', 'pat_next_due_at', 'pat_last_at'].forEach(date);
  if ('pat_required' in body) a.pat_required = body.pat_required === true;
  // PAT testing and inspections are for assets (one tagged item), never for
  // counted stock.
  if (a.is_stock_tracked && (a.pat_required || a.check_interval_days || a.next_check_due_at || a.pat_next_due_at)) {
    throw httpError(400, 'PAT tests and inspections belong on assets, not stock items — add it as an asset instead');
  }
  if ('condition' in body) {
    if (body.condition && !ASSET_CONDITIONS.includes(body.condition)) throw httpError(400, `condition must be one of ${ASSET_CONDITIONS.join(', ')}`);
    a.condition = body.condition || null;
  }
  if ('vehicle_id' in body) {
    const v = body.vehicle_id ? db.vehicles.find((x) => x.id === Number(body.vehicle_id)) : null;
    if (body.vehicle_id && !v) throw httpError(400, 'vehicle not found');
    a.vehicle_id = v ? v.id : null;
  }
  if ('location_id' in body) {
    const loc = body.location_id ? (db.stock_locations || []).find((l) => l.id === Number(body.location_id)) : null;
    if (body.location_id && !loc) throw httpError(400, 'store location not found');
    a.location_id = loc ? loc.id : null;
  }
}
route('GET', '/api/assets', ALL, ({ query, user }) => {
  let rows = db.assets.filter((a) => visibleToUser(a, user)).map((a) => publicAsset(a));
  if (query.get('assigned_to')) rows = rows.filter((a) => a.assigned_to === Number(query.get('assigned_to')));
  if (query.get('category')) rows = rows.filter((a) => a.category === query.get('category').toUpperCase());
  return rows;
});
route('POST', '/api/assets', ADMIN, ({ body, user }) => {
  const description = String(body.description || '').trim();
  if (!description) throw httpError(400, 'description required');
  if (!ASSET_CATEGORIES.includes(body.category)) throw httpError(400, 'invalid category');
  const tag = body.tag ? String(body.tag).trim() : null;
  if (tag && db.assets.some((x) => x.tag === tag)) throw httpError(409, 'an asset with that tag already exists');
  const p = body.assigned_to ? db.personnel.find((x) => x.id === Number(body.assigned_to)) : null;
  const site = body.site_id ? db.sites.find((x) => x.id === Number(body.site_id)) : null;
  const parent = body.parent_asset_id ? db.assets.find((x) => x.id === Number(body.parent_asset_id)) : null;
  const isStockTracked = body.is_stock_tracked === true;
  const a = {
    id: nextId('assets'), tag, category: body.category, description, serial_no: body.serial_no || '',
    assigned_to: p ? p.id : null, site_id: site ? site.id : null,
    status: ASSET_STATUSES.includes(body.status) ? body.status : 'IN_STORE',
    purchase_date: body.purchase_date || null, last_checked_at: null, notes: body.notes || '',
    branch_id: normalizedBranchId(body.branch_id),
    is_stock_tracked: isStockTracked,
    low_stock_threshold: isStockTracked && body.low_stock_threshold != null && body.low_stock_threshold !== '' ? Number(body.low_stock_threshold) : null,
    expiry_date: isStockTracked ? (body.expiry_date || null) : null,
    parent_asset_id: parent ? parent.id : null,
  };
  applyAssetExtras(a, body);
  if (!a.is_stock_tracked) inventory.firstDueDates(a);
  db.assets.push(a);
  if (isStockTracked && body.initial_quantity != null && body.initial_quantity !== '' && Number(body.initial_quantity) > 0) {
    recordStockMovement(a.id, Number(body.initial_quantity), 'RESTOCK', 'Initial stock on creation', null, user);
  }
  logEvent('asset.created', `ASSET ${tag || description} ADDED`, { asset_id: a.id });
  return { __status: 201, __body: publicAsset(a) };
});
route('PATCH', '/api/assets/:id', ADMIN, ({ params, body }) => {
  const a = db.assets.find((x) => x.id === Number(params.id)); if (!a) throw httpError(404, 'asset not found');
  if ('tag' in body) {
    const tag = body.tag ? String(body.tag).trim() : null;
    if (tag && db.assets.some((x) => x.id !== a.id && x.tag === tag)) throw httpError(409, 'an asset with that tag already exists');
    a.tag = tag;
  }
  if ('category' in body) { if (!ASSET_CATEGORIES.includes(body.category)) throw httpError(400, 'invalid category'); a.category = body.category; }
  if ('description' in body) { const description = String(body.description || '').trim(); if (!description) throw httpError(400, 'description required'); a.description = description; }
  if ('serial_no' in body) a.serial_no = body.serial_no || '';
  if ('assigned_to' in body) { const p = body.assigned_to ? db.personnel.find((x) => x.id === Number(body.assigned_to)) : null; a.assigned_to = p ? p.id : null; }
  if ('site_id' in body) { const site = body.site_id ? db.sites.find((x) => x.id === Number(body.site_id)) : null; a.site_id = site ? site.id : null; }
  if ('status' in body) { if (!ASSET_STATUSES.includes(body.status)) throw httpError(400, 'invalid status'); a.status = body.status; }
  if ('purchase_date' in body) a.purchase_date = body.purchase_date || null;
  if ('notes' in body) a.notes = body.notes || '';
  if ('branch_id' in body) a.branch_id = normalizedBranchId(body.branch_id);
  if ('is_stock_tracked' in body) {
    a.is_stock_tracked = Boolean(body.is_stock_tracked);
    if (!a.is_stock_tracked) { a.low_stock_threshold = null; a.expiry_date = null; }
  }
  if ('low_stock_threshold' in body) {
    if (!a.is_stock_tracked && body.low_stock_threshold != null) throw httpError(400, 'only a stock-tracked asset can have a threshold');
    a.low_stock_threshold = body.low_stock_threshold != null && body.low_stock_threshold !== '' ? Number(body.low_stock_threshold) : null;
  }
  if ('expiry_date' in body) {
    if (!a.is_stock_tracked && body.expiry_date != null) throw httpError(400, 'only a stock-tracked asset can have an expiry date');
    a.expiry_date = body.expiry_date || null;
  }
  if ('parent_asset_id' in body) {
    const parent = body.parent_asset_id ? db.assets.find((x) => x.id === Number(body.parent_asset_id)) : null;
    if (parent && parent.id === a.id) throw httpError(400, 'an asset cannot be its own parent');
    a.parent_asset_id = parent ? parent.id : null;
  }
  applyAssetExtras(a, body);
  if (body.check_now) a.last_checked_at = new Date().toISOString();
  logEvent('asset.updated', `ASSET ${a.tag || a.description} UPDATED`, { asset_id: a.id });
  return publicAsset(a);
});
route('DELETE', '/api/assets/:id', ADMIN, ({ params }) => {
  const a = db.assets.find((x) => x.id === Number(params.id)); if (!a) throw httpError(404, 'asset not found');
  db.assets = db.assets.filter((x) => x.id !== a.id);
  logEvent('asset.deleted', `ASSET ${a.tag || a.description} DELETED`, { asset_id: a.id });
  return { ok: true };
});

/* Checkout/return as a dedicated, audit-trailed path alongside the blunter
 * PATCH assigned_to/status (kept for admin corrections). A FIELD_USER can
 * only check an asset out to themselves and only return their own
 * checkout — control/admin can act on anyone's. */
route('GET', '/api/assets/:id/checkouts', ALL, ({ params }) => {
  const a = db.assets.find((x) => x.id === Number(params.id)); if (!a) throw httpError(404, 'asset not found');
  return db.asset_checkouts.filter((c) => c.asset_id === a.id)
    .sort((x, y) => Date.parse(y.checked_out_at) - Date.parse(x.checked_out_at))
    .map(publicAssetCheckout);
});
route('POST', '/api/assets/:id/checkout', ALL, ({ params, body, user }) => {
  const a = db.assets.find((x) => x.id === Number(params.id)); if (!a) throw httpError(404, 'asset not found');
  if (db.asset_checkouts.some((c) => c.asset_id === a.id && !c.returned_at)) throw httpError(409, 'asset is already checked out — return it first');
  let personnelId;
  if (user.role === 'FIELD_USER') {
    if (!user.personnel_id) throw httpError(400, 'no personnel record linked to your account');
    personnelId = user.personnel_id;
  } else {
    const p = body.personnel_id ? db.personnel.find((x) => x.id === Number(body.personnel_id)) : null;
    if (!p) throw httpError(400, 'personnel_id required');
    personnelId = p.id;
  }
  const co = {
    id: nextId('asset_checkouts'), asset_id: a.id, personnel_id: personnelId,
    checked_out_at: new Date().toISOString(), checked_out_by: user.id,
    returned_at: null, returned_by: null, notes: body.notes || '',
    expected_return_at: body.expected_return_at && !isNaN(Date.parse(body.expected_return_at)) ? new Date(body.expected_return_at).toISOString() : null,
    condition_out: ASSET_CONDITIONS.includes(body.condition) ? body.condition : (a.condition || null),
  };
  if (['LOST', 'RETIRED', 'IN_REPAIR', 'ON_HIRE'].includes(a.status)) throw httpError(409, `this asset is ${a.status.replace('_', ' ').toLowerCase()} — it cannot be issued`);
  db.asset_checkouts.push(co);
  a.assigned_to = personnelId; a.status = 'IN_USE';
  const p = db.personnel.find((x) => x.id === personnelId);
  logEvent('asset.checked_out', `ASSET ${a.tag || a.description} CHECKED OUT TO ${p ? p.name : personnelId}`, { asset_id: a.id, checkout_id: co.id });
  return { __status: 201, __body: publicAsset(a) };
});
route('POST', '/api/assets/:id/return', ALL, ({ params, body, user }) => {
  const a = db.assets.find((x) => x.id === Number(params.id)); if (!a) throw httpError(404, 'asset not found');
  const co = db.asset_checkouts.find((c) => c.asset_id === a.id && !c.returned_at);
  if (!co) throw httpError(409, 'asset is not currently checked out');
  if (!isControlRole(user.role) && user.personnel_id !== co.personnel_id) throw httpError(403, 'not your checkout');
  co.returned_at = new Date().toISOString(); co.returned_by = user.id;
  if (body && ASSET_CONDITIONS.includes(body.condition)) { co.condition_in = body.condition; a.condition = body.condition; }
  if (body && body.notes) co.return_notes = String(body.notes).slice(0, 500);
  a.assigned_to = null; a.status = body && body.condition === 'DAMAGED' ? 'IN_REPAIR' : 'IN_STORE'; a.last_checked_at = new Date().toISOString();
  logEvent('asset.returned', `ASSET ${a.tag || a.description} RETURNED`, { asset_id: a.id, checkout_id: co.id });
  return publicAsset(a);
});
route('GET', '/api/personnel', ALL, ({ user }) => db.personnel.filter((p) => visibleToUser(p, user)).map((p) => publicPersonnel(p, user)));
route('POST', '/api/personnel', ADMIN, ({ body, user }) => {
  const name = String(body.name || '').trim();
  if (!name) throw httpError(400, 'name required');
  const employeeNo = body.employee_no ? String(body.employee_no).trim() : null;
  if (employeeNo && db.personnel.some((p) => p.employee_no === employeeNo)) throw httpError(409, 'employee number already in use');
  const cs = body.callsign_id ? findCallsign(body.callsign_id) : null;
  const veh = body.vehicle_id ? db.vehicles.find((v) => v.id === Number(body.vehicle_id)) : null;
  const employmentType = EMPLOYMENT_TYPES.includes(body.employment_type) ? body.employment_type : 'EMPLOYED';
  const p = {
    id: nextId('personnel'), employee_no: employeeNo, name, rank: body.rank || '',
    contact_phone: body.contact_phone || '', contact_email: body.contact_email || '',
    sms_opt_out: body.sms_opt_out === true, email_opt_out: body.email_opt_out === true,
    employment_status: ['ACTIVE', 'LEAVE', 'TERMINATED'].includes(body.employment_status) ? body.employment_status : 'ACTIVE',
    employment_type: employmentType,
    annual_leave_allowance_days: employmentType === 'EMPLOYED' && body.annual_leave_allowance_days ? Number(body.annual_leave_allowance_days) : null,
    callsign_id: cs ? cs.id : null, user_id: null, vehicle_id: veh ? veh.id : null,
    welfare_interval_s: null, welfare_due_at: null, welfare_warned: false, welfare_note: null,
    notes: body.notes || '', branch_id: normalizedBranchId(body.branch_id),
    lat: null, lon: null, location_at: null,
  };
  db.personnel.push(p);
  logEvent('personnel.created', `PERSONNEL ${name} ADDED`, { personnel_id: p.id });
  return { __status: 201, __body: publicPersonnel(p, user) };
});
route('PATCH', '/api/personnel/:id', ADMIN, ({ params, body, user }) => {
  const p = db.personnel.find((x) => x.id === Number(params.id)); if (!p) throw httpError(404, 'personnel not found');
  if ('name' in body) { const name = String(body.name || '').trim(); if (!name) throw httpError(400, 'name required'); p.name = name; }
  if ('employee_no' in body) {
    const employeeNo = body.employee_no ? String(body.employee_no).trim() : null;
    if (employeeNo && db.personnel.some((x) => x.id !== p.id && x.employee_no === employeeNo)) throw httpError(409, 'employee number already in use');
    p.employee_no = employeeNo;
  }
  if ('rank' in body) p.rank = body.rank || '';
  if ('contact_phone' in body) p.contact_phone = body.contact_phone || '';
  if ('contact_email' in body) p.contact_email = body.contact_email || '';
  if ('sms_opt_out' in body) p.sms_opt_out = body.sms_opt_out === true;
  if ('email_opt_out' in body) p.email_opt_out = body.email_opt_out === true;
  if ('employment_status' in body) {
    if (!['ACTIVE', 'LEAVE', 'TERMINATED'].includes(body.employment_status)) throw httpError(400, 'invalid employment_status');
    p.employment_status = body.employment_status;
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
      return { id: i + 1, licence_type, licence_no, expiry };
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
  if ('notes' in body) p.notes = body.notes || '';
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
  }
  if ('annual_leave_allowance_days' in body) {
    p.annual_leave_allowance_days = body.annual_leave_allowance_days == null ? null : Number(body.annual_leave_allowance_days);
  }
  logEvent('personnel.updated', `PERSONNEL ${p.name} UPDATED`, { personnel_id: p.id });
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


// Jobs
route('GET', '/api/jobs', ALL, ({ query, user }) => {
  let jobs = db.jobs.filter((j) => siteVisibleTo(j.site_id, user)).map(publicJob);
  if (query.get('status')) jobs = jobs.filter((j) => j.status === query.get('status').toUpperCase());
  return jobs;
});
/* On-scene checklist — every job gets one, instantiated from the site's own
 * template if it has one configured, else this fixed default. A site with
 * no template yet (most GuardM8 sites, until someone sets one up in admin)
 * still gets a sane checklist rather than none at all. Each instantiated
 * item carries its own completion state; the site's template itself never
 * does — that's what makes it reusable across jobs. */
const DEFAULT_CHECKLIST_TEMPLATE = [
  { title: 'Call control room on arrival', instructions: 'Contact the site’s control room to confirm your arrival on site.' },
  { title: 'Entrance check', instructions: 'Check the site entry point for signs of unauthorised entry.' },
  { title: 'Perimeter check', instructions: 'Complete a perimeter check of the site for any signs of damage or forced entry.' },
  { title: 'Risks on site', instructions: 'Note any risks or hazards observed on site.' },
  { title: 'Report', instructions: 'Provide a detailed report of the site attendance.' },
  { title: 'Before departing', instructions: 'Contact the site’s control room to obtain permission to depart.' },
  { title: 'Departure', instructions: 'Ensure the site is secure on departure.' },
];
function instantiateChecklist(site) {
  const template = site && site.checklist && site.checklist.length ? site.checklist : DEFAULT_CHECKLIST_TEMPLATE;
  return template.map((item) => ({
    id: crypto.randomUUID(), title: item.title, instructions: item.instructions || '',
    status: 'PENDING', notes: '', completed_by: null, completed_at: null,
  }));
}

route('POST', '/api/jobs', CONTROL, ({ body, user }) => {
  const priority = String(body.priority || 'GREEN').toUpperCase();
  if (!PRIORITIES.includes(priority)) throw httpError(400, 'invalid priority');
  const site = body.site ? db.sites.find((x) => x.id === Number(body.site) || x.name === String(body.site)) : null;
  if (!body.location && !site) throw httpError(400, 'location or site required');
  const j = {
    id: nextId('jobs'), reference: `INC-${new Date().getFullYear()}-${String(nextId('jobref') + 124).padStart(5, '0')}`,
    incident_type: body.incident_type || 'UNSPECIFIED', priority,
    location: body.location || `${site.name}, ${site.address}`,
    site_id: site ? site.id : null, keyholder: site ? site.keyholder : (body.keyholder || ''),
    lat: Number(body.lat || (site && site.lat) || 53.6152 + (Math.random() - 0.5) * 0.05),
    lon: Number(body.lon || (site && site.lon) || -0.2210 + (Math.random() - 0.5) * 0.05),
    description: body.description || '', caller: body.caller || '', required_resources: Number(body.required_resources || 1),
    what3words: String(body.what3words || '').replace(/^\/+/, '').trim(),
    notes: body.notes || '', status: 'CREATED', created_by: user.id, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    checklist: instantiateChecklist(site), media: [],
  };
  db.jobs.push(j);
  broadcast('job.created', publicJob(j));
  logEvent('job.created', `JOB ${j.reference} CREATED (${priority})`, { job_id: j.id });
  return { __status: 201, __body: publicJob(j) };
});

/* ---- GuardM8 integration ----------------------------------------------
 * GuardM8 (Echelon's separate guarding/alarm-receiving product) pushes an
 * alarm straight in as a dispatchable job, the same shape a call taker
 * would create by hand. Authenticated with a shared secret rather than a
 * user session — GuardM8 is a system, not a CCCS operator — same pattern
 * as the PBX inbound route below. external_ref lets GuardM8 retry a send
 * (e.g. after a network blip) without creating a duplicate job: resending
 * the same external_ref returns the job already created for it instead of
 * making a second one. */
const GUARDM8_PRIORITY_MAP = {
  RED: 'RED', CRITICAL: 'RED', P1: 'RED',
  AMBER: 'AMBER', HIGH: 'AMBER', P2: 'AMBER',
  GREEN: 'GREEN', MEDIUM: 'GREEN', P3: 'GREEN',
  ROUTINE: 'ROUTINE', LOW: 'ROUTINE', P4: 'ROUTINE',
};
route('POST', '/api/integrations/guardm8/jobs', null, ({ body, req }) => {
  const secret = process.env.GUARDM8_SECRET;
  if (!secret || req.headers['x-guardm8-secret'] !== secret) throw httpError(401, 'bad GuardM8 secret');

  const externalRef = body.external_ref !== undefined && body.external_ref !== null ? String(body.external_ref) : null;
  if (externalRef) {
    const existing = db.jobs.find((x) => x.external_ref === externalRef);
    if (existing) return { __status: 200, __body: publicJob(existing) };
  }

  const priority = GUARDM8_PRIORITY_MAP[String(body.priority || 'GREEN').toUpperCase()] || 'GREEN';
  const site = body.site ? db.sites.find((x) => x.id === Number(body.site) || x.name === String(body.site)) : null;
  if (!body.location && !site) throw httpError(400, 'location or site required');

  const j = {
    id: nextId('jobs'), reference: `INC-${new Date().getFullYear()}-${String(nextId('jobref') + 124).padStart(5, '0')}`,
    incident_type: body.incident_type || 'ALARM', priority,
    location: body.location || `${site.name}, ${site.address}`,
    site_id: site ? site.id : null, keyholder: site ? site.keyholder : (body.keyholder || ''),
    lat: body.lat != null ? Number(body.lat) : (site && site.lat != null ? site.lat : null),
    lon: body.lon != null ? Number(body.lon) : (site && site.lon != null ? site.lon : null),
    description: body.description || '', caller: body.caller || 'GuardM8', required_resources: Number(body.required_resources || 1),
    what3words: String(body.what3words || '').replace(/^\/+/, '').trim(),
    notes: body.notes || '', status: 'CREATED', created_by: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    external_source: 'guardm8', external_ref: externalRef,
    checklist: instantiateChecklist(site), media: [],
  };
  db.jobs.push(j);
  broadcast('job.created', publicJob(j));
  pushToRoles(CONTROL, { title: 'New job — GuardM8', body: `${j.reference} · ${j.incident_type} · ${j.location}`, url: '/control.html', tag: 'cccs-job' });
  logEvent('job.created', `JOB ${j.reference} CREATED (${priority}) — via GuardM8`, { job_id: j.id, external_ref: externalRef });
  return { __status: 201, __body: publicJob(j) };
});

route('POST', '/api/jobs/:id/assign', CONTROL, ({ params, body }) => {
  const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
  const targets = body.resources || body.to || [];
  if (!targets.length) throw httpError(400, 'resources required');
  const personnelIds = [], mdtIds = [];
  for (const t of targets) {
    // Call sign only by exact name here, not by numeric id — a bare id is
    // ambiguous between "callsign id" and "personnel id" (independent
    // sequences that both start at 1), and every real caller (control.html's
    // pick-a-callsign buttons, GuardM8) already sends the name, never the id.
    const cs = db.callsigns.find((c) => c.name === String(t).toUpperCase());
    const people = cs ? db.personnel.filter((p) => p.callsign_id === cs.id) : [findPersonnel(t)].filter(Boolean);
    const mdts = cs ? db.mdts.filter((m) => m.callsign_id === cs.id) : [findMdt(t)].filter(Boolean);
    if (!people.length && !mdts.length) throw httpError(404, `unknown resource ${t}`);
    for (const p of people) {
      if (db.job_assignments.some((a) => a.job_id === j.id && a.personnel_id === p.id)) continue;
      db.job_assignments.push({ id: nextId('job_assignments'), job_id: j.id, personnel_id: p.id, mdt_id: null, callsign_id: p.callsign_id, acknowledged: false, acknowledged_at: null, at: new Date().toISOString() });
      personnelIds.push(p.id);
    }
    for (const m of mdts) {
      if (db.job_assignments.some((a) => a.job_id === j.id && a.mdt_id === m.id)) continue;
      db.job_assignments.push({ id: nextId('job_assignments'), job_id: j.id, personnel_id: null, mdt_id: m.id, callsign_id: m.callsign_id, acknowledged: false, acknowledged_at: null, at: new Date().toISOString() });
      m.job_id = j.id; mdtIds.push(m.id);
    }
  }
  j.status = 'DISPATCHED'; j.updated_at = new Date().toISOString();
  stampJobStatus(j, 'DISPATCHED');
  const payload = publicJob(j);
  broadcast('job.dispatched', payload);
  broadcast('job.assigned_to_you', payload, { personnelIds, mdtIds });
  pushToUsers(db.users.filter((u) => (u.personnel_id && personnelIds.includes(u.personnel_id)) || (u.mdt_id && mdtIds.includes(u.mdt_id))).map((u) => u.id),
    { title: `Job ${j.reference}`, body: `${j.priority} — ${j.location}`, url: '/officer.html', tag: 'cccs-job' });
  logEvent('job.dispatched', `JOB ${j.reference} DISPATCHED → ${payload.resources.map((r) => r.callsign || r.personnel || r.mdt).join(', ')}`, { job_id: j.id });
  return payload;
});
route('POST', '/api/jobs/:id/ack', ALL, ({ params, user, body }) => {
  const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
  let assignment;
  if (user.role === 'FIELD_USER') assignment = db.job_assignments.find((a) => a.job_id === j.id && a.personnel_id === user.personnel_id);
  else if (user.role === 'MDT_USER') assignment = db.job_assignments.find((a) => a.job_id === j.id && a.mdt_id === user.mdt_id);
  else {
    const p = body.personnel ? findPersonnel(body.personnel) : null; const m = body.mdt ? findMdt(body.mdt) : null;
    assignment = db.job_assignments.find((a) => a.job_id === j.id && ((p && a.personnel_id === p.id) || (m && a.mdt_id === m.id)));
  }
  if (!assignment) throw httpError(404, 'no assignment for this resource');
  assignment.acknowledged = true; assignment.acknowledged_at = new Date().toISOString();
  if (j.status === 'DISPATCHED') { j.status = 'ACKNOWLEDGED'; j.updated_at = assignment.acknowledged_at; }
  stampJobStatus(j, 'ACKNOWLEDGED');
  const ackMdt = assignment.mdt_id ? db.mdts.find((m) => m.id === assignment.mdt_id) : null;
  // Baseline for checkAutoJobProgress's "distance is decreasing" check —
  // without this the first location report after ack has nothing to
  // compare against and can never detect movement toward the job.
  if (j.lat != null && ackMdt && ackMdt.lat != null) assignment.last_distance_m = haversineMeters(ackMdt.lat, ackMdt.lon, j.lat, j.lon);
  const who = assignment.personnel_id ? (db.personnel.find((p) => p.id === assignment.personnel_id) || {}).name : (db.mdts.find((m) => m.id === assignment.mdt_id) || {}).mdt_code;
  broadcast('job.acknowledged', { job: publicJob(j), by: who });
  logEvent('job.acknowledged', `${who} ACKNOWLEDGED JOB ${j.reference}`, { job_id: j.id });
  return publicJob(j);
});
/* ---- Resolution report ---------------------------------------------- *
 * Built the moment a job completes and kept on the job itself (so it shows
 * up in job history in the control room and the incidents log without
 * needing email to have worked), then emailed out to the site's own
 * contact and RESOLUTION_REPORT_CC via Microsoft Graph, app-only — inert
 * until MS_TENANT_ID/MS_CLIENT_ID/MS_CLIENT_SECRET/MS_GRAPH_SENDER are all
 * set, same gating pattern as the AURA integration above. */
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/* Email clients don't send an Authorization header for embedded images, and
 * most either block external image loading by default or strip data: URIs
 * outright — so the report's images are referenced as cid: and attached
 * inline, the one embedding method that actually renders reliably across
 * real mail clients. buildResolutionReportHtml() always returns the cid:
 * form; it's the email body verbatim, not something a browser can render
 * standalone, which is fine since job history in the app renders its own
 * view straight from job.checklist/job.media (with authenticated URLs)
 * rather than reusing this HTML. */
/** Generic across jobs and site visits — both are "a reference, a place, a
 * timeline of stages, a checklist, some photos", just with different stage
 * vocabularies (a visit has no TRANSPORTING) and detail fields (a job has a
 * priority; a visit doesn't). Callers build their own timeline/extraRows,
 * this only knows how to lay them out. */
function buildResolutionReportHtml({ reference, kindLabel, locationLabel, siteId, description, notes, timeline, checklist, media, extraRows = [] }) {
  const site = siteId ? db.sites.find((s) => s.id === siteId) : null;
  const fmt = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London' }) : '—');
  const checklistRows = (checklist || []).map((item) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e5ea;vertical-align:top">
        <strong>${escHtml(item.title)}</strong><br><span style="color:#6b7280;font-size:13px">${escHtml(item.instructions)}</span>
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e5ea;vertical-align:top;white-space:nowrap">
        ${item.status === 'COMPLETE' ? '✅ Complete' : '⬜ Not completed'}<br>
        <span style="color:#6b7280;font-size:12px">${item.completed_at ? fmt(item.completed_at) : ''}</span>
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e5ea;vertical-align:top">${escHtml(item.notes || '—')}</td>
    </tr>`).join('');
  const photos = (media || []).map((m) => `
    <div style="display:inline-block;margin:6px;text-align:center">
      <img src="cid:media-${m.id}" style="width:180px;height:135px;object-fit:cover;border-radius:6px;border:1px solid #e2e5ea">
      <div style="font-size:11px;color:#6b7280;margin-top:4px">${fmt(m.taken_at)}</div>
    </div>`).join('');
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827">
    <div style="max-width:640px;margin:0 auto;padding:24px 20px">
      <img src="cid:echelon-wordmark" style="height:34px;margin-bottom:20px">
      <h1 style="font-size:20px;margin:0 0 4px">Resolution report — ${escHtml(reference)}</h1>
      <p style="color:#6b7280;margin:0 0 20px">${escHtml(kindLabel)} · ${escHtml(locationLabel)}</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;font-size:14px">
        ${extraRows.map(([label, value]) => `<tr><td style="padding:4px 0;color:#6b7280;width:140px">${escHtml(label)}</td><td>${escHtml(value)}</td></tr>`).join('')}
        <tr><td style="padding:4px 0;color:#6b7280">Site</td><td>${escHtml(site ? site.name : '—')}</td></tr>
        <tr><td style="padding:4px 0;color:#6b7280">Description</td><td>${escHtml(description || '—')}</td></tr>
        <tr><td style="padding:4px 0;color:#6b7280">Notes</td><td>${escHtml(notes || '—')}</td></tr>
      </table>
      <h2 style="font-size:15px;margin:0 0 8px">Timeline</h2>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;font-size:13px">
        ${timeline.map(([label, t]) => `<tr><td style="padding:3px 0;color:#6b7280;width:140px">${label}</td><td>${fmt(t)}</td></tr>`).join('')}
      </table>
      <h2 style="font-size:15px;margin:0 0 8px">Checklist</h2>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
        ${checklistRows || '<tr><td style="padding:8px 12px;color:#6b7280">No checklist on this.</td></tr>'}
      </table>
      ${photos ? `<h2 style="font-size:15px;margin:0 0 8px">Photos</h2><div>${photos}</div>` : ''}
      <p style="color:#9ca3af;font-size:11px;margin-top:32px">Sent automatically by CCCS — comms.echeloncic.com</p>
    </div>
  </body></html>`;
}
const MS_GRAPH_SENDER = process.env.MS_GRAPH_SENDER || '';
const RESOLUTION_REPORT_CC = process.env.RESOLUTION_REPORT_CC || '';
const GRAPH_MAIL_ENABLED = Boolean(MS_TENANT_ID && MS_CLIENT_ID && MS_CLIENT_SECRET && MS_GRAPH_SENDER);
let graphTokenCache = { token: null, exp: 0 };
async function getGraphAppToken() {
  if (graphTokenCache.token && Date.now() < graphTokenCache.exp - 30000) return graphTokenCache.token;
  const res = await fetch(`https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: MS_CLIENT_ID, client_secret: MS_CLIENT_SECRET, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'graph token request failed');
  graphTokenCache = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}
async function sendResolutionReportEmail({ reference, siteId, media, mediaDir: mDir, logType, logIdKey, logId }, html) {
  if (!GRAPH_MAIL_ENABLED) { console.warn(`[cccs] resolution report for ${reference} not emailed — Graph mail not configured`); return; }
  const site = siteId ? db.sites.find((s) => s.id === siteId) : null;
  const recipients = [site && site.contact_email, RESOLUTION_REPORT_CC].filter(Boolean);
  if (!recipients.length) { console.warn(`[cccs] resolution report for ${reference} not emailed — no recipient configured`); return; }
  try {
    const attachments = [{
      '@odata.type': '#microsoft.graph.fileAttachment', name: 'echelon-wordmark.png', contentId: 'echelon-wordmark', isInline: true,
      contentType: 'image/png', contentBytes: fs.readFileSync(path.join(__dirname, 'public', 'assets', 'echelon-wordmark.png')).toString('base64'),
    }];
    for (const m of media || []) {
      const file = path.join(mDir, path.basename(m.url));
      if (!fs.existsSync(file)) continue;
      attachments.push({
        '@odata.type': '#microsoft.graph.fileAttachment', name: path.basename(file), contentId: `media-${m.id}`, isInline: true,
        contentType: MIME[path.extname(file)] || 'application/octet-stream', contentBytes: fs.readFileSync(file).toString('base64'),
      });
    }
    const token = await getGraphAppToken();
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MS_GRAPH_SENDER)}/sendMail`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { subject: `Resolution report — ${reference}`, body: { contentType: 'HTML', content: html }, toRecipients: recipients.map((address) => ({ emailAddress: { address } })), attachments } }),
    });
    if (!res.ok) console.warn(`[cccs] resolution report email failed for ${reference}:`, res.status, await res.text());
    else logEvent(logType, `RESOLUTION REPORT EMAILED FOR ${reference}`, { [logIdKey]: logId, to: recipients });
  } catch (e) { console.warn(`[cccs] resolution report email failed for ${reference}:`, e.message); }
}

// Generic Graph sendMail, for anything that just needs "send this person an
// email" rather than the resolution report's attachment/CC assembly above.
// Never throws — a notification that can't be delivered shouldn't fail the
// request that triggered it; callers get a result object to log/audit with.
// opts.attachments: [{ name, contentType, content: Buffer }] — e.g. a PDF.
async function sendGraphEmail(to, subject, html, opts = {}) {
  if (!GRAPH_MAIL_ENABLED) return { ok: false, error: 'graph mail not configured' };
  if (!to) return { ok: false, error: 'no recipient' };
  try {
    const token = await getGraphAppToken();
    // contentId/isInline are optional passthroughs for a cid: reference in
    // the HTML (an inline logo, say) — omitted entirely for a plain
    // attachment, same as before this existed.
    const attachments = (opts.attachments || []).map((f) => ({
      '@odata.type': '#microsoft.graph.fileAttachment', name: f.name, contentType: f.contentType || 'application/octet-stream',
      contentBytes: Buffer.from(f.content).toString('base64'),
      ...(f.contentId ? { contentId: f.contentId, isInline: Boolean(f.isInline) } : {}),
    }));
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MS_GRAPH_SENDER)}/sendMail`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { subject, body: { contentType: 'HTML', content: html }, toRecipients: [{ emailAddress: { address: to } }], ...(attachments.length ? { attachments } : {}) } }),
    });
    if (!res.ok) return { ok: false, error: `${res.status} ${await res.text()}` };
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://comms.echeloncic.com').replace(/\/+$/, '');

// Shift SMS/email notifications — one place for "tell this person what just
// happened to their shift", reused by every broadcast() call site that
// already decides who's allowed to know. Fully synchronous, matching the
// rest of the system's click-to-SMS: no queue, no retry, just a best-effort
// send plus an audit row so a failed send is visible, not silent.
const SHIFT_NOTIFY_EVENTS = {
  ASSIGNED: { label: 'ASSIGNED', subject: (s) => `New shift: ${shiftTitle(s)}` },
  CHANGED: { label: 'UPDATED', subject: (s) => `Shift updated: ${shiftTitle(s)}` },
  CANCELLED: { label: 'CANCELLED', subject: (s) => `Shift cancelled: ${shiftTitle(s)}` },
  REMOVED: { label: 'REMOVED', subject: (s) => `Removed from shift: ${shiftTitle(s)}` },
  REJECTED: { label: 'REJECTED', subject: (s) => `Shift application not successful: ${shiftTitle(s)}` },
};
function shiftTitle(s) {
  const type = s.shift_type_id ? db.shift_types.find((t) => t.id === s.shift_type_id) : null;
  const site = s.site_id ? db.sites.find((x) => x.id === s.site_id) : null;
  return `${type ? type.name : 'Shift'}${site ? ` at ${site.name}` : ''}`;
}
function shiftWhen(s) {
  const fmt = (iso) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/London' });
  return `${fmt(s.starts_at)} – ${fmt(s.ends_at)}`;
}
function writeNotifyLog({ channel, personnel_id, to_number, to_email, body, outcome, error_code, provider, provider_ref, shift_id }) {
  db.dial_log.push({
    id: nextId('dial_log'), channel, personnel_id,
    to_number: to_number || null, from_number: null, actor_user_id: null, actor_name: 'system',
    job_id: null, site_visit_id: null, shift_id: shift_id || null,
    body: to_email ? `${to_email}: ${body}` : body,
    provider: provider || 'none', provider_ref: provider_ref || null,
    outcome, error_code: error_code || null, duration_s: null,
    attempted_at: new Date().toISOString(), settled_at: null,
  });
}
async function notifyPersonnelAboutShift(personnelId, eventKey, s) {
  const p = db.personnel.find((x) => x.id === personnelId);
  if (!p) return;
  const ev = SHIFT_NOTIFY_EVENTS[eventKey];
  const link = `${PUBLIC_BASE_URL}/officer.html`;
  const text = `${ev.subject(s)}\n${shiftWhen(s)}\nView: ${link}`;
  if (!p.sms_opt_out) {
    const to = sms.normalizeNumber(p.contact_phone);
    if (to) {
      const result = await sms.send({ to, body: text, label: p.name });
      writeNotifyLog({
        channel: 'SMS', personnel_id: p.id, to_number: to, body: text, shift_id: s.id,
        provider: result.dryRun ? 'none' : 'twilio', provider_ref: result.sid || null,
        outcome: result.ok ? (result.dryRun ? 'ATTEMPTED' : 'QUEUED') : 'FAILED', error_code: result.ok ? null : (result.error || 'send failed'),
      });
    }
  }
  if (!p.email_opt_out && p.contact_email) {
    const html = `<p>${ev.subject(s)}</p><p>${shiftWhen(s)}</p><p><a href="${link}">View your shifts</a></p>`;
    const result = await sendGraphEmail(p.contact_email, ev.subject(s), html);
    writeNotifyLog({
      channel: 'EMAIL', personnel_id: p.id, to_email: p.contact_email, body: ev.subject(s), shift_id: s.id,
      provider: result.ok ? 'graph' : 'none', outcome: result.ok ? 'QUEUED' : 'FAILED', error_code: result.ok ? null : result.error,
    });
  }
}
function notifyShiftEvent(eventKey, s, personnelIds) {
  for (const pid of personnelIds || []) notifyPersonnelAboutShift(pid, eventKey, s).catch((e) => console.warn('[cccs] shift notify failed:', e.message));
}

route('PATCH', '/api/jobs/:id', ALL, ({ params, body, user }) => {
  const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
  if (body.status) {
    const s = String(body.status).toUpperCase();
    if (!JOB_STATES.includes(s)) throw httpError(400, 'invalid job status');
    assertJobAccess(j, user);
    j.status = s;
    stampJobStatus(j, s);
    if (['COMPLETED', 'CANCELLED'].includes(s)) {
      for (const a of db.job_assignments.filter((x) => x.job_id === j.id)) {
        if (a.mdt_id) { const m = db.mdts.find((x) => x.id === a.mdt_id); if (m) m.job_id = null; }
      }
    }
    if (s === 'COMPLETED') {
      j.resolution_report_html = buildResolutionReportHtml({
        reference: j.reference, kindLabel: j.incident_type, locationLabel: j.location, siteId: j.site_id,
        description: j.description, notes: j.notes, extraRows: [['Priority', j.priority]],
        timeline: [
          ['Job created', j.created_at], ['Dispatched', j.dispatched_at], ['Acknowledged', j.acknowledged_at],
          ['En route', j.en_route_at], ['On scene', j.on_scene_at], ['Completed', j.completed_at],
        ].filter(([, t]) => t),
        checklist: j.checklist, media: j.media,
      });
      sendResolutionReportEmail({
        reference: j.reference, siteId: j.site_id, media: j.media, mediaDir: mediaDir(j.id),
        logType: 'job.report_emailed', logIdKey: 'job_id', logId: j.id,
      }, j.resolution_report_html);
      logEvent('job.report_generated', `RESOLUTION REPORT GENERATED FOR ${j.reference}`, { job_id: j.id });
    }
  }
  if (body.notes !== undefined) j.notes = body.notes;
  // Incident details — mainly for a job auto-created from an emergency,
  // which starts with placeholders (raw coordinates, no description) and
  // gets filled in as the officer actually reports what's going on.
  const DETAIL_FIELDS = { incident_type: 120, location: 200, description: 2000, caller: 200 };
  if (Object.keys(DETAIL_FIELDS).some((f) => body[f] !== undefined)) {
    if (!isControlRole(user.role)) throw httpError(403, 'only control can edit incident details');
    for (const [f, max] of Object.entries(DETAIL_FIELDS)) if (body[f] !== undefined) j[f] = String(body[f]).slice(0, max);
    if (body.what3words !== undefined) j.what3words = String(body.what3words).replace(/^\/+/, '').trim();
  }
  j.updated_at = new Date().toISOString();
  broadcast('job.status_changed', publicJob(j));
  logEvent('job.status_changed', `JOB ${j.reference} → ${j.status}`, { job_id: j.id });
  return publicJob(j);
});
/** Only the assigned personnel/MDT (or control) may touch a job's checklist —
 * same "is this mine" check used by the general job PATCH above, pulled out
 * since both the checklist and media routes need it. */
function assertJobAccess(j, user) {
  if (isControlRole(user.role)) return;
  const mine = db.job_assignments.some((a) => a.job_id === j.id && (
    (user.role === 'FIELD_USER' && user.personnel_id && a.personnel_id === user.personnel_id) ||
    (user.role === 'MDT_USER' && user.mdt_id && a.mdt_id === user.mdt_id)));
  if (!mine) throw httpError(403, 'job not assigned to you');
}
route('PATCH', '/api/jobs/:id/checklist/:itemId', ALL, ({ params, body, user }) => {
  const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
  assertJobAccess(j, user);
  const item = (j.checklist || []).find((x) => x.id === params.itemId); if (!item) throw httpError(404, 'checklist item not found');
  if (body.status) {
    const s = String(body.status).toUpperCase();
    if (!['PENDING', 'COMPLETE'].includes(s)) throw httpError(400, 'invalid checklist status');
    item.status = s;
    if (s === 'COMPLETE') { item.completed_at = new Date().toISOString(); item.completed_by = user.display_name; }
    else { item.completed_at = null; item.completed_by = null; }
  }
  if (body.notes !== undefined) item.notes = String(body.notes).slice(0, 2000);
  j.updated_at = new Date().toISOString();
  broadcast('job.status_changed', publicJob(j));
  logEvent('job.checklist_updated', `${item.status === 'COMPLETE' ? 'COMPLETED' : 'UPDATED'} "${item.title}" on JOB ${j.reference}`, { job_id: j.id });
  return publicJob(j);
});

// Same writable directory the SQLite store uses (see store.js) — the
// service's systemd unit runs with ProtectSystem=strict, which makes
// everything else, /opt/cccs/public included, read-only at runtime.
const UPLOADS_DIR = path.join(path.dirname(process.env.DATA_FILE || path.join(__dirname, 'data', 'cccs.db')), 'uploads');
const mediaDir = (jobId) => path.join(UPLOADS_DIR, String(jobId));
// Site visits get their own id space (nextId('site_visits') is independent of
// nextId('jobs')), so a job and a visit can share a numeric id — keep them in
// separate subtrees rather than risk one's photos landing in the other's folder.
const visitMediaDir = (visitId) => path.join(UPLOADS_DIR, 'visits', String(visitId));
const MEDIA_MIME_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
route('POST', '/api/jobs/:id/media', ALL, ({ params, body, user }) => {
  const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
  assertJobAccess(j, user);
  const ext = MEDIA_MIME_EXT[body.mimetype];
  if (!ext) throw httpError(400, 'mimetype must be image/jpeg, image/png or image/webp');
  if (!body.data) throw httpError(400, 'data (base64) required');
  if (body.checklist_item_id && !(j.checklist || []).some((x) => x.id === body.checklist_item_id)) throw httpError(404, 'checklist item not found');
  const bytes = Buffer.from(body.data, 'base64');
  if (bytes.length > 8e6) throw httpError(413, 'photo too large');
  const dir = mediaDir(j.id);
  fs.mkdirSync(dir, { recursive: true });
  const mediaId = crypto.randomUUID();
  const filename = `${mediaId}${ext}`;
  fs.writeFileSync(path.join(dir, filename), bytes);
  const media = {
    id: mediaId, url: `/api/jobs/${j.id}/media/${mediaId}`, filename, caption: String(body.caption || '').slice(0, 200),
    checklist_item_id: body.checklist_item_id || null, taken_by: user.display_name, taken_at: new Date().toISOString(),
  };
  j.media = j.media || [];
  j.media.push(media);
  j.updated_at = new Date().toISOString();
  broadcast('job.status_changed', publicJob(j));
  logEvent('job.media_added', `PHOTO ADDED TO JOB ${j.reference}`, { job_id: j.id });
  return { __status: 201, __body: media };
});
route('GET', '/api/jobs/:id/media/:mediaId', ALL, ({ params, user }) => {
  const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
  assertJobAccess(j, user);
  const m = (j.media || []).find((x) => x.id === params.mediaId); if (!m) throw httpError(404, 'photo not found');
  const file = path.join(mediaDir(j.id), m.filename);
  if (!fs.existsSync(file)) throw httpError(404, 'photo file missing');
  return { __body: fs.readFileSync(file), __headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'private, max-age=86400' } };
});

route('POST', '/api/jobs/:id/stand-down', CONTROL, ({ params, body }) => {
  const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
  const p = body.personnel ? findPersonnel(body.personnel) : null;
  const m = body.mdt ? findMdt(body.mdt) : null;
  if (!p && !m) throw httpError(400, 'personnel or mdt required');
  const a = db.job_assignments.find((x) => x.job_id === j.id && ((p && x.personnel_id === p.id) || (m && x.mdt_id === m.id)));
  if (!a) throw httpError(404, 'that resource is not assigned to this job');
  db.job_assignments = db.job_assignments.filter((x) => x.id !== a.id);
  const who = p ? p.name : m.mdt_code;
  if (m) { m.job_id = null; broadcast('mdt.status_changed', publicMdt(m)); }
  j.updated_at = new Date().toISOString();
  const payload = publicJob(j);
  broadcast('job.status_changed', payload);
  broadcast('job.stood_down', payload, { personnelIds: p ? [p.id] : [], mdtIds: m ? [m.id] : [] });
  logEvent('job.stood_down', `${who} STOOD DOWN FROM JOB ${j.reference}`, { job_id: j.id });
  return payload;
});

// Emergency
/** An emergency needs backup dispatched to it, which means it needs a job —
 * otherwise a supervisor's only way to send other units is to freehand a new
 * job and hope the location matches. Created with no resources assigned:
 * the officer/crew already in trouble aren't who you'd "dispatch" to their
 * own emergency, so this is deliberately backup-only. Location starts as raw
 * coordinates and incident_type/description/caller start as placeholders —
 * there's no reverse geocoding here — and get filled in via the job's own
 * edit fields as details actually come in over the air. */
function createEmergencyJob(ev) {
  const j = {
    id: nextId('jobs'), reference: `INC-${new Date().getFullYear()}-${String(nextId('jobref') + 124).padStart(5, '0')}`,
    incident_type: ev.kind === 'WELFARE' ? 'WELFARE ALARM' : 'OFFICER EMERGENCY', priority: 'RED',
    location: ev.lat != null ? `${ev.lat.toFixed(5)}, ${ev.lon.toFixed(5)} (add details as received)` : 'Location unknown — add details as received',
    site_id: null, keyholder: '', lat: ev.lat, lon: ev.lon,
    description: '', caller: ev.callsign, required_resources: 2, what3words: '',
    notes: '', status: 'CREATED', created_by: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    emergency_id: ev.id, checklist: [], media: [],
  };
  db.jobs.push(j);
  ev.job_id = j.id;
  broadcast('job.created', publicJob(j));
  logEvent('job.created', `JOB ${j.reference} CREATED (RED) — ${j.incident_type} ${ev.callsign}`, { job_id: j.id, emergency_id: ev.id });
  return j;
}

/* ---- Minimal MQTT 3.1.1 publisher ---------------------------------------
 * Publish-only (QoS 0, clean session) — CCCS never subscribes to anything,
 * so there's no need for the parts of MQTT that make a full client
 * complicated (PUBACK/PUBREC/PUBREL/PUBCOMP flows, subscription state,
 * reconnect logic). One TCP connection per publish: CONNECT, wait for
 * CONNACK, PUBLISH, DISCONNECT, close — same hand-rolled-over-node:net
 * approach already used for the WebSocket signalling server elsewhere in
 * this file, rather than pulling in an MQTT client package for a handful
 * of packet types. */
function mqttEncodeString(str) {
  const buf = Buffer.from(str, 'utf8');
  const len = Buffer.alloc(2); len.writeUInt16BE(buf.length);
  return Buffer.concat([len, buf]);
}
function mqttEncodeRemainingLength(n) {
  const bytes = [];
  do {
    let b = n % 128; n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    bytes.push(b);
  } while (n > 0);
  return Buffer.from(bytes);
}
function mqttConnectPacket({ clientId, username, password, keepAlive = 30 }) {
  let flags = 0x02; // clean session
  if (username) flags |= 0x80;
  if (password) flags |= 0x40;
  const keepAliveBuf = Buffer.alloc(2); keepAliveBuf.writeUInt16BE(keepAlive);
  const parts = [mqttEncodeString('MQTT'), Buffer.from([4]), Buffer.from([flags]), keepAliveBuf, mqttEncodeString(clientId)];
  if (username) parts.push(mqttEncodeString(username));
  if (password) parts.push(mqttEncodeString(password));
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([0x10]), mqttEncodeRemainingLength(body.length), body]);
}
function mqttPublishPacket({ topic, payload }) {
  const body = Buffer.concat([mqttEncodeString(topic), Buffer.from(payload, 'utf8')]); // QoS 0: no packet identifier
  return Buffer.concat([Buffer.from([0x30]), mqttEncodeRemainingLength(body.length), body]);
}
const MQTT_DISCONNECT_PACKET = Buffer.from([0xe0, 0x00]);

const MQTT_PING_PACKET = Buffer.from([0xc0, 0x00]);

/* A persistent connection, not one-shot per event — AURA's source config
 * has a "warn if silent for 300s (big alarm + siren)" watchdog on by
 * default, so a client that only ever appears for a few hundred ms per
 * rare emergency reads to it as a dead/flapping source, not a healthy
 * idle one. This holds one connection open for the process lifetime,
 * reconnecting on drop, and a periodic heartbeat message on the same
 * topic keeps AURA's watchdog satisfied between real events. */
const mqttState = { socket: null, connected: false, buf: Buffer.alloc(0) };
function mqttStart({ host, port, username, password, clientId, keepAlive = 60 }) {
  if (mqttState.socket) return;
  const socket = net.connect({ host, port });
  mqttState.socket = socket;
  mqttState.buf = Buffer.alloc(0);
  let pingTimer = null;
  socket.on('connect', () => socket.write(mqttConnectPacket({ clientId, username, password, keepAlive })));
  socket.on('data', (chunk) => {
    mqttState.buf = Buffer.concat([mqttState.buf, chunk]);
    // Only CONNACK (once) and PINGRESP are ever expected back — never
    // SUBSCRIBEd to anything, so no PUBLISH can arrive from the broker.
    while (mqttState.buf.length >= 2) {
      const packetType = mqttState.buf[0] & 0xf0;
      if (packetType === 0x20 && !mqttState.connected) {
        const returnCode = mqttState.buf[3];
        mqttState.buf = mqttState.buf.subarray(4);
        if (returnCode !== 0) { console.warn(`[cccs] MQTT broker rejected connection (return code ${returnCode})`); socket.destroy(); return; }
        mqttState.connected = true;
        pingTimer = setInterval(() => { if (mqttState.socket) mqttState.socket.write(MQTT_PING_PACKET); }, keepAlive * 1000 * 0.8).unref?.();
      } else if (packetType === 0xd0) {
        mqttState.buf = mqttState.buf.subarray(2); // PINGRESP, nothing to do
      } else {
        mqttState.buf = Buffer.alloc(0); // unexpected — drop rather than get stuck re-parsing garbage
      }
    }
  });
  const reconnect = () => {
    if (pingTimer) clearInterval(pingTimer);
    mqttState.socket = null; mqttState.connected = false;
    setTimeout(() => mqttStart({ host, port, username, password, clientId, keepAlive }), 10000).unref?.();
  };
  socket.on('error', (e) => { console.warn('[cccs] MQTT connection error:', e.message); reconnect(); });
  socket.on('close', reconnect);
}
function mqttPublishNow(topic, payload) {
  if (!mqttState.connected || !mqttState.socket) return false;
  mqttState.socket.write(mqttPublishPacket({ topic, payload }));
  return true;
}

/* ---- SIA-format encoding -------------------------------------------------
 * Confirmed with the AURA side: the arc/rx/cccs provider parses raw SIA-
 * format signals, not JSON — every JSON attempt landed as an unparsed
 * signal with no account attached. An initial attempt at the full SIA
 * DC-09-2007 wire packet (CRC/length/"SIA-DCS" framing) still didn't
 * parse; what actually works was confirmed by example — a genuine
 * "Automatic (periodic) test" event relayed through the same MQTT bridge
 * from another receiver came through as exactly:
 *   S016[#7000|Nri0/RP0000]
 * i.e. this relay's own lighter framing (S + 3-digit sequence) around the
 * SIA data block, not the full DC-09 packet. Matched here exactly rather
 * than guessed. */
let siaSeq = 0;
function buildSia({ acct, data }) {
  siaSeq = (siaSeq % 999) + 1;
  return `S${String(siaSeq).padStart(3, '0')}[#${acct}|${data}]`;
}

/* ---- AURA alarm forwarding ---------------------------------------------
 * AURA is Echelon's alarm receiving centre platform — an emergency button
 * press is exactly what an ARC exists to see, so it's forwarded the moment
 * one is raised, over MQTT rather than AURA's REST alarm intake (its
 * endpoint wasn't reachable when that was tried — see git history).
 * Fire-and-forget: a slow or failed publish must never block or fail the
 * emergency flow itself, since that's the one thing here that must never
 * silently not work. */
const MQTT_HOST = process.env.MQTT_HOST || '';
const MQTT_PORT = Number(process.env.MQTT_PORT || 1883);
const MQTT_USERNAME = process.env.MQTT_USERNAME || '';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || '';
const MQTT_TOPIC = process.env.MQTT_TOPIC || 'arc/rx/cccs';
const AURA_ACCT = process.env.AURA_ACCT || '8581'; // Echelon Control Centre
const MQTT_HEARTBEAT_S = Number(process.env.MQTT_HEARTBEAT_S || 60); // cadence of the SIA "automatic test" event below — an operator-visible signal, not the connection keep-alive (see MQTT_ACK_* just below)
// Separate from the SIA periodic test above: GuardM8 also wants a plain
// connection keep-alive on its own topic, independent of anything
// operator-visible. Content doesn't matter to GuardM8 for this one (their
// own words) -- a timestamp, just so it's not literally empty.
const MQTT_ACK_TOPIC = process.env.MQTT_ACK_TOPIC || 'guardm8/ack/cccs';
const MQTT_ACK_INTERVAL_S = Number(process.env.MQTT_ACK_INTERVAL_S || 180);
// JSON over this topic was confirmed not to parse at all (see above) — hold
// publishing behind this flag until a real SIA DC-09 send has been checked
// against AURA at least once, same reasoning as before: a wrong guess here
// creates a stale alarm card in a live queue, not a silent failure.
const MQTT_AURA_PUBLISH_ENABLED = process.env.MQTT_AURA_PUBLISH_ENABLED === '1';
if (MQTT_HOST) {
  mqttStart({ host: MQTT_HOST, port: MQTT_PORT, username: MQTT_USERNAME || undefined, password: MQTT_PASSWORD || undefined, clientId: 'cccs' });
  if (MQTT_AURA_PUBLISH_ENABLED) {
    setInterval(() => {
      mqttPublishNow(MQTT_TOPIC, buildSia({ acct: AURA_ACCT, data: 'Nri0/RP0000' })); // RP = SIA "automatic test report" — the standard periodic test/heartbeat code, not a real alarm. Matches the confirmed-working example exactly.
    }, MQTT_HEARTBEAT_S * 1000).unref?.();
    setInterval(() => {
      mqttPublishNow(MQTT_ACK_TOPIC, new Date().toISOString());
    }, MQTT_ACK_INTERVAL_S * 1000).unref?.();
  }
}
// SIA's zone field is numeric-only (4 digits in every confirmed example) —
// a callsign like "P101" doesn't fit as-is, so use its digits: "P101" -> 0101.
// Falls back to 0000 for a callsign with no digits at all.
function zoneFromCallsign(callsign) {
  const digits = String(callsign || '').replace(/\D/g, '');
  return (digits || '0').slice(-4).padStart(4, '0');
}
function forwardEmergencyToAura(ev) {
  if (!MQTT_HOST || !MQTT_AURA_PUBLISH_ENABLED) return;
  const zone = zoneFromCallsign(ev.callsign);
  const packet = buildSia({ acct: AURA_ACCT, data: `Nri0/PA${zone}` }); // PA = SIA panic alarm
  if (!mqttPublishNow(MQTT_TOPIC, packet)) console.warn(`[cccs] AURA MQTT publish skipped for emergency ${ev.id} — not connected to broker`);
}

route('POST', '/api/emergency', ALL, ({ body, user }) => {
  const person = user.role === 'FIELD_USER' ? db.personnel.find((p) => p.id === user.personnel_id) : (body.personnel ? findPersonnel(body.personnel) : null);
  const mdt = user.role === 'MDT_USER' ? db.mdts.find((m) => m.id === user.mdt_id) : (body.mdt ? findMdt(body.mdt) : null);
  if (!person && !mdt) throw httpError(404, 'personnel or mdt not found');
  const open = db.emergency_events.find((e) => ((person && e.personnel_id === person.id) || (mdt && e.mdt_id === mdt.id)) && e.state !== 'RESOLVED');
  if (open) return open;
  // The device takes a fresh GPS fix the instant the button is pressed and
  // sends it here — trust that over whatever lat/lon happens to be on file,
  // since an idle terminal's stored position can be stale (or, before it's
  // ever reported one, still whatever it was seeded with).
  const who = person || mdt;
  if (body.lat != null && body.lon != null) { who.lat = Number(body.lat); who.lon = Number(body.lon); }
  if (mdt) { mdt.emergency = true; broadcast('mdt.status_changed', publicMdt(mdt)); }
  const callsign = person ? callsignOf(person) : callsignOf(mdt);
  const ev = {
    id: nextId('emergency_events'), kind: 'EMERGENCY', personnel_id: person ? person.id : null, mdt_id: mdt ? mdt.id : null,
    mdt_code: mdt ? mdt.mdt_code : null, callsign,
    lat: who.lat, lon: who.lon, state: 'ACTIVE', activated_at: new Date().toISOString(),
    acknowledged_at: null, acknowledged_by: null, resolved_at: null, resolved_by: null, job_id: null,
  };
  db.emergency_events.push(ev);
  createEmergencyJob(ev);
  broadcast('emergency.activated', ev);
  pushToRoles(CONTROL, { title: 'EMERGENCY', body: `${ev.callsign}`, url: '/control.html', tag: 'cccs-emergency' });
  forwardEmergencyToAura(ev);
  store.flushNow();
  logEvent('emergency.activated', `!!! EMERGENCY — ${ev.callsign}`, { emergency_id: ev.id, personnel_id: ev.personnel_id, mdt_id: ev.mdt_id });
  return { __status: 201, __body: ev };
});
route('GET', '/api/emergency', ALL, () => db.emergency_events.slice(-100));
route('POST', '/api/emergency/:id/ack', CONTROL, ({ params, user }) => {
  const ev = db.emergency_events.find((e) => e.id === Number(params.id)); if (!ev) throw httpError(404, 'emergency not found');
  ev.state = 'ACKNOWLEDGED'; ev.acknowledged_at = new Date().toISOString(); ev.acknowledged_by = user.display_name;
  broadcast('emergency.acknowledged', ev);
  logEvent('emergency.acknowledged', `EMERGENCY ${ev.callsign} ACKNOWLEDGED BY ${user.display_name}`, { emergency_id: ev.id });
  return ev;
});
route('POST', '/api/emergency/:id/resolve', CONTROL, ({ params, user }) => {
  const ev = db.emergency_events.find((e) => e.id === Number(params.id)); if (!ev) throw httpError(404, 'emergency not found');
  ev.state = 'RESOLVED'; ev.resolved_at = new Date().toISOString(); ev.resolved_by = user.display_name;
  const mdt = db.mdts.find((m) => m.id === ev.mdt_id);
  if (mdt) { mdt.emergency = false; broadcast('mdt.status_changed', publicMdt(mdt)); }
  broadcast('emergency.resolved', ev);
  logEvent('emergency.resolved', `EMERGENCY ${ev.callsign} RESOLVED BY ${user.display_name}`, { emergency_id: ev.id });
  return ev;
});

// Messaging
route('GET', '/api/messages', ALL, ({ user, query }) => {
  const mine = db.messages.filter((m) => {
    if (isControlRole(user.role)) return true;
    if (user.role === 'FIELD_USER') return m.to_personnel_id === user.personnel_id || m.from_personnel_id === user.personnel_id;
    if (user.role === 'MDT_USER') return m.to_mdt_id === user.mdt_id || m.from_mdt_id === user.mdt_id;
    return false;
  });
  const lim = Number(query.get('limit') || 100);
  return mine.slice(-lim);
});
route('POST', '/api/messages', ALL, ({ body, user }) => {
  const toPerson = body.to_personnel ? findPersonnel(body.to_personnel) : null;
  const toMdt = body.to_mdt ? findMdt(body.to_mdt) : null;
  if (!toPerson && !toMdt && !body.to_control) throw httpError(400, 'recipient required');
  const fromPerson = user.role === 'FIELD_USER' ? db.personnel.find((p) => p.id === user.personnel_id) : null;
  const fromMdt = user.role === 'MDT_USER' ? db.mdts.find((m) => m.id === user.mdt_id) : null;
  const msg = {
    id: nextId('messages'), body: String(body.body || '').slice(0, 1000),
    from_label: fromPerson ? callsignOf(fromPerson) : fromMdt ? fromMdt.mdt_code : 'CONTROL',
    from_personnel_id: fromPerson ? fromPerson.id : null, from_mdt_id: fromMdt ? fromMdt.id : null,
    to_personnel_id: toPerson ? toPerson.id : null, to_mdt_id: toMdt ? toMdt.id : null,
    to_label: toPerson ? callsignOf(toPerson) : toMdt ? toMdt.mdt_code : 'CONTROL',
    state: 'DELIVERED', sent_at: new Date().toISOString(), read_at: null,
  };
  if (!msg.body) throw httpError(400, 'message body required');
  db.messages.push(msg);
  broadcast('message.received', msg, { personnelIds: toPerson ? [toPerson.id] : undefined, mdtIds: toMdt ? [toMdt.id] : undefined });
  logEvent('message.sent', `${msg.from_label} ✉ ${msg.to_label}: ${msg.body.slice(0, 60)}`, { message_id: msg.id });
  return { __status: 201, __body: msg };
});
route('POST', '/api/messages/:id/read', ALL, ({ params, user }) => {
  const m = db.messages.find((x) => x.id === Number(params.id)); if (!m) throw httpError(404, 'message not found');
  // A read receipt is the recipient's own signal — anyone else marking it
  // read would show a false "seen" against a message they never got.
  const isRecipient = (user.role === 'FIELD_USER' && m.to_personnel_id === user.personnel_id)
    || (user.role === 'MDT_USER' && m.to_mdt_id === user.mdt_id)
    || (isControlRole(user.role) && m.to_personnel_id == null && m.to_mdt_id == null);
  if (!isRecipient) throw httpError(403, 'not your message to mark read');
  m.state = 'READ'; m.read_at = new Date().toISOString();
  broadcast('message.read', m);
  return m;
});

// Events / audit
route('GET', '/api/events', ALL, ({ query }) => {
  let ev = db.audit_logs.slice();
  const type = query.get('type'); const q = query.get('q'); const since = query.get('since');
  if (type) ev = ev.filter((e) => e.type.startsWith(type));
  if (q) ev = ev.filter((e) => e.summary.toLowerCase().includes(q.toLowerCase()));
  if (since) ev = ev.filter((e) => e.at >= since);
  return ev.slice(-Number(query.get('limit') || 200));
});
route('GET', '/api/state', ALL, ({ user }) => ({
  // mdts, emergencies and events are deliberately never branch-filtered:
  // an MDT isn't itself a named resource multi-branch was asked to scope,
  // and hiding an emergency or an audit-log entry from any signed-in
  // internal role would be a safety/oversight regression, not a feature.
  mdts: db.mdts.map(publicMdt),
  jobs: db.jobs.filter((j) => siteVisibleTo(j.site_id, user)).map(publicJob),
  personnel: db.personnel.filter((p) => visibleToUser(p, user)).map(publicPersonnel),
  sites: db.sites.filter((s) => siteVisibleTo(s.id, user)),
  site_visits: db.site_visits.filter((v) => siteVisibleTo(v.site_id, user)).map(publicSiteVisit),
  emergencies: db.emergency_events.filter((e) => e.state !== 'RESOLVED'),
  events: db.audit_logs.slice(-80), server_time: new Date().toISOString(),
}));
/* ------------------------------------------------------------------ *
 * Data retention
 *
 * This system tracks employees' locations continuously and records their
 * welfare check-ins. Under UK GDPR that is personal data about staff, held on
 * a legitimate-interest basis, and keeping it forever is not defensible —
 * "we never got round to deleting it" is not a retention policy.
 *
 * Defaults below are deliberately short. Lengthen them if you have a reason you
 * could state to an officer who asked, and write that reason down. See
 * docs/PRIVACY.md.
 * ------------------------------------------------------------------ */
const RETENTION = {
  // Minute-by-minute vehicle tracking. Short: its operational value expires
  // within days, its intrusiveness does not.
  locations: Number(process.env.RETAIN_LOCATIONS_DAYS || 31),
  // Who was where on which job — the audit trail you would need for a client
  // dispute or an insurance claim.
  audit: Number(process.env.RETAIN_AUDIT_DAYS || 365),
  // Message records.
  messages: Number(process.env.RETAIN_MESSAGES_DAYS || 180),
  // Closed jobs.
  jobs: Number(process.env.RETAIN_JOBS_DAYS || 730),
  // Shift-handover notes — kept alongside the audit trail's horizon since
  // they carry the same "what happened at this site" evidentiary value.
  passdown: Number(process.env.RETAIN_PASSDOWN_DAYS || 365),
};

function pruneOlderThan(table, days, field) {
  if (!days || days <= 0) return 0;
  const cutoff = Date.now() - days * 86400000;
  const before = db[table].length;
  db[table] = db[table].filter((row) => {
    const at = Date.parse(row[field] || row.at || row.recorded_at || 0);
    return !at || at >= cutoff;
  });
  return before - db[table].length;
}

function retentionSweep() {
  const removed = {
    locations: pruneOlderThan('locations', RETENTION.locations, 'at'),
    audit_logs: pruneOlderThan('audit_logs', RETENTION.audit, 'at'),
    messages: pruneOlderThan('messages', RETENTION.messages, 'sent_at'),
    passdown_logs: pruneOlderThan('passdown_logs', RETENTION.passdown, 'created_at'),
  };

  // Jobs are only removed once they are finished — an open job is
  // operational data, not history, however old it is.
  const jobCutoff = Date.now() - RETENTION.jobs * 86400000;
  const keptJobs = db.jobs.filter((j) => !['COMPLETED', 'CANCELLED'].includes(j.status) || Date.parse(j.updated_at) >= jobCutoff);
  removed.jobs = db.jobs.length - keptJobs.length;
  const goneJobIds = new Set(db.jobs.filter((j) => !keptJobs.includes(j)).map((j) => j.id));
  db.jobs = keptJobs;
  db.job_assignments = db.job_assignments.filter((a) => !goneJobIds.has(a.job_id));

  // Same rule as jobs: a finished visit is history once it's old enough, an
  // open or missed one stays — coverage gaps should stay visible, not age out.
  const visitCutoff = Date.now() - RETENTION.jobs * 86400000;
  const keptVisits = db.site_visits.filter((v) => !['COMPLETED', 'CANCELLED', 'MISSED'].includes(v.status) || Date.parse(v.updated_at) >= visitCutoff);
  removed.site_visits = db.site_visits.length - keptVisits.length;
  db.site_visits = keptVisits;

  const total = Object.values(removed).reduce((a, b) => a + b, 0);
  if (total) {
    const detail = Object.entries(removed).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ');
    logEvent('retention.swept', `RETENTION SWEEP REMOVED ${total} RECORDS (${detail})`, removed);
    store.flushNow();
  }
  return removed;
}

route('GET', '/api/retention', CONTROL, () => ({
  policy_days: RETENTION,
  counts: Object.fromEntries(['locations', 'audit_logs', 'messages', 'jobs', 'site_visits']
    .map((t) => [t, db[t].length])),
  note: 'Location history is the most intrusive data here and is kept for the shortest time.',
}));
route('POST', '/api/retention/sweep', ADMIN, ({ user }) => {
  const removed = retentionSweep();
  logEvent('retention.manual', `MANUAL RETENTION SWEEP BY ${user.username}`);
  return removed;
});

/* Erasure request: remove one person's movement history without touching the
   operational record of jobs, which the business needs to keep. */
route('POST', '/api/personnel/:id/erase-location-history', ADMIN, ({ params, user }) => {
  const p = findPersonnel(params.id); if (!p) throw httpError(404, 'personnel not found');
  const before = db.locations.length;
  db.locations = db.locations.filter((l) => l.personnel_id !== p.id);
  const removed = before - db.locations.length;
  // The last-known dot on the map is itself a piece of that movement
  // history — an "erased" officer who still shows a position would not be
  // erased at all, just quiet about the history behind it.
  p.lat = null; p.lon = null; p.location_at = null;
  logEvent('retention.erasure', `LOCATION HISTORY ERASED FOR ${callsignOf(p)} (${removed} points) BY ${user.username}`, { personnel_id: p.id, removed });
  store.flushNow();
  return { personnel: p.name, removed };
});

/* Foot-officer live location — see docs/PRIVACY.md and README's Live
 * tracking section for the full reasoning. Off by default (FOOT_TRACKING
 * env var): continuous personal location tracking is a
 * materially different privacy position from the single GPS fix an
 * emergency already takes, and needs its own legitimate interest
 * assessment before a deployment turns it on — this route refuses outright
 * until that flag is set, rather than silently accepting reports nobody
 * asked for. A FIELD_USER can only ever report their own position: there
 * is no legitimate reason for anyone else to phone in someone else's GPS
 * fix, unlike an MDT's console-operable terminal. */
route('POST', '/api/personnel/:id/location', ['FIELD_USER'], ({ params, body, user }) => {
  if (process.env.FOOT_TRACKING !== 'on') throw httpError(403, 'foot officer tracking is not enabled on this deployment');
  const p = db.personnel.find((x) => x.id === Number(params.id)); if (!p) throw httpError(404, 'personnel not found');
  if (user.personnel_id !== p.id) throw httpError(403, 'you can only report your own position');
  const lat = Number(body.lat), lon = Number(body.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw httpError(400, 'lat and lon required');
  p.lat = lat; p.lon = lon; p.location_at = new Date().toISOString();
  db.locations.push({ id: nextId('locations'), mdt_id: null, personnel_id: p.id, lat, lon, speed: null, heading: null, at: p.location_at });
  checkAutoProgressForPerson(p.id, lat, lon);
  broadcast('personnel.location', publicPersonnel(p), { controlOnly: true });
  return { ok: true };
});

/* ------------------------------------------------------------------ *
 * Call requests
 *
 * An officer who cannot talk — or who does not want to tie up the channel —
 * asks control to call them. Routine and priority are separate queues at the
 * console: a priority request is the officer saying "something is happening",
 * one step below pressing SOS, and it should be answered in seconds.
 * ------------------------------------------------------------------ */
route('POST', '/api/calls/request', ALL, ({ body, user }) => {
  const person = user.role === 'FIELD_USER'
    ? db.personnel.find((p) => p.id === user.personnel_id)
    : findPersonnel(body.personnel);
  if (!person) throw httpError(404, 'personnel not found');

  const priority = body.priority === true || String(body.priority).toUpperCase() === 'PRIORITY';
  const open = db.call_requests.find((r) => r.personnel_id === person.id && r.state === 'PENDING');
  if (open) {
    // A second press escalates rather than stacking another row.
    if (priority && !open.priority) {
      open.priority = true; open.escalated_at = new Date().toISOString();
      broadcast('call.request', open);
      logEvent('call.request_escalated', `${callsignOf(person)} ESCALATED CALL REQUEST TO PRIORITY`, { request_id: open.id });
      store.flushNow();
    }
    return open;
  }

  const req = {
    id: nextId('call_requests'), personnel_id: person.id,
    callsign: callsignOf(person), priority, note: String(body.note || '').slice(0, 200) || null,
    state: 'PENDING',
    requested_at: new Date().toISOString(), answered_at: null, answered_by: null, cancelled_at: null,
  };
  db.call_requests.push(req);
  broadcast('call.request', req);
  logEvent('call.requested', `${req.callsign} REQUESTS ${priority ? 'PRIORITY ' : ''}CALL`, { request_id: req.id, personnel_id: person.id });
  if (priority) store.flushNow();
  return { __status: 201, __body: req };
});

route('GET', '/api/calls/requests', ALL, ({ query }) => {
  const state = (query.get('state') || 'PENDING').toUpperCase();
  return state === 'ALL' ? db.call_requests.slice(-200) : db.call_requests.filter((r) => r.state === state);
});

route('POST', '/api/calls/requests/:id/clear', ALL, ({ params, user }) => {
  const req = db.call_requests.find((r) => r.id === Number(params.id));
  if (!req) throw httpError(404, 'request not found');
  if (!isControlRole(user.role) && user.personnel_id !== req.personnel_id) throw httpError(403, 'not your request');
  if (req.state !== 'PENDING') return req;
  const byOfficer = user.role === 'FIELD_USER';
  req.state = byOfficer ? 'CANCELLED' : 'ANSWERED';
  req[byOfficer ? 'cancelled_at' : 'answered_at'] = new Date().toISOString();
  if (!byOfficer) req.answered_by = user.display_name;
  broadcast('call.request_cleared', req);
  logEvent('call.request_cleared', `CALL REQUEST FROM ${req.callsign} ${req.state} ${byOfficer ? '' : 'BY ' + user.display_name}`.trim(), { request_id: req.id });
  return req;
});

/* ------------------------------------------------------------------ *
 * Lone worker welfare timers
 *
 * An officer sets a timer before entering a site. If they do not check in
 * before it expires, control is alerted with their last known position. This
 * is the feature that carries the most weight in a commercial security
 * operation — it is what your lone-worker policy and your insurer will ask
 * about, and it must fail loudly rather than silently.
 * ------------------------------------------------------------------ */
const WELFARE_TICK_MS = Number(process.env.WELFARE_TICK_MS || 5000);
const WELFARE_WARN_S = Number(process.env.WELFARE_WARN_S || 60);

// `user` is the acting login, not the subject `person` — the same person
// for a FIELD_USER managing their own timer, but a different one whenever
// control (or, now correctly gated, nobody else) acts on someone else's.
// Recorded on every welfare action for the same reason emergency ack/resolve
// already name their actor: "who checked this person in" is exactly the
// question you need answered the one time it turns out to matter.
function startWelfare(person, intervalS, note, user) {
  if (!Number.isFinite(intervalS) || intervalS < 30 || intervalS > 8 * 3600) {
    throw httpError(400, 'welfare interval must be between 30 seconds and 8 hours');
  }
  person.welfare_interval_s = Math.round(intervalS);
  person.welfare_due_at = new Date(Date.now() + person.welfare_interval_s * 1000).toISOString();
  person.welfare_warned = false;
  person.welfare_note = note || null;
  const payload = { personnel: publicPersonnel(person), note: person.welfare_note };
  broadcast('welfare.started', payload);
  logEvent('welfare.started', `${callsignOf(person)} WELFARE TIMER ${person.welfare_interval_s}s${note ? ' — ' + note : ''} (started by ${user.display_name})`, { personnel_id: person.id, started_by: user.id });
  return person;
}

function checkInWelfare(person, user) {
  if (!person.welfare_due_at) throw httpError(409, 'no welfare timer running');
  person.welfare_due_at = new Date(Date.now() + person.welfare_interval_s * 1000).toISOString();
  person.welfare_warned = false;
  // Clear any overdue alarm this person had raised.
  for (const ev of db.emergency_events) {
    if (ev.personnel_id === person.id && ev.kind === 'WELFARE' && ev.state !== 'RESOLVED') {
      ev.state = 'RESOLVED'; ev.resolved_at = new Date().toISOString(); ev.resolved_by = user.display_name;
      broadcast('emergency.resolved', ev);
    }
  }
  broadcast('welfare.checked_in', publicPersonnel(person));
  logEvent('welfare.checked_in', `${callsignOf(person)} CHECKED IN (by ${user.display_name})`, { personnel_id: person.id, checked_in_by: user.id });
  return person;
}

function stopWelfare(person, reason = 'cancelled', user) {
  person.welfare_interval_s = null; person.welfare_due_at = null; person.welfare_warned = false; person.welfare_note = null;
  broadcast('welfare.stopped', publicPersonnel(person));
  logEvent('welfare.stopped', `${callsignOf(person)} WELFARE TIMER ${reason.toUpperCase()} (by ${user.display_name})`, { personnel_id: person.id, stopped_by: user.id });
  return person;
}

function welfareTick() {
  const now = Date.now();
  for (const person of db.personnel) {
    if (!person.welfare_due_at) continue;
    const due = Date.parse(person.welfare_due_at);
    if (now >= due) {
      person.welfare_due_at = null; person.welfare_interval_s = null;
      const ev = {
        id: nextId('emergency_events'), kind: 'WELFARE', personnel_id: person.id,
        callsign: callsignOf(person), lat: null, lon: null, state: 'ACTIVE',
        note: person.welfare_note || null,
        activated_at: new Date().toISOString(), acknowledged_at: null, acknowledged_by: null, resolved_at: null, resolved_by: null,
      };
      db.emergency_events.push(ev);
      createEmergencyJob(ev);
      broadcast('welfare.overdue', ev);
      broadcast('emergency.activated', ev);
      pushToRoles(CONTROL, { title: 'Welfare alarm', body: `${ev.callsign} — no check-in`, url: '/control.html', tag: 'cccs-emergency' });
      logEvent('welfare.overdue', `!!! WELFARE OVERDUE — ${ev.callsign} NO CHECK-IN`, { emergency_id: ev.id, personnel_id: person.id });
      store.flushNow();
    } else if (!person.welfare_warned && due - now <= WELFARE_WARN_S * 1000) {
      person.welfare_warned = true;
      broadcast('welfare.due_soon', { personnel: publicPersonnel(person), seconds_left: Math.round((due - now) / 1000) }, { personnelIds: [person.id] });
    }
  }
}

route('POST', '/api/personnel/:id/welfare', ALL, ({ params, body, user }) => {
  const p = findPersonnel(params.id); if (!p) throw httpError(404, 'personnel not found');
  if (!isControlRole(user.role) && user.personnel_id !== p.id) throw httpError(403, 'not you');
  return publicPersonnel(startWelfare(p, Number(body.interval_s), body.note, user), user);
});
route('POST', '/api/personnel/:id/welfare/check', ALL, ({ params, user }) => {
  const p = findPersonnel(params.id); if (!p) throw httpError(404, 'personnel not found');
  if (!isControlRole(user.role) && user.personnel_id !== p.id) throw httpError(403, 'not you');
  return publicPersonnel(checkInWelfare(p, user), user);
});
route('DELETE', '/api/personnel/:id/welfare', ALL, ({ params, user }) => {
  const p = findPersonnel(params.id); if (!p) throw httpError(404, 'personnel not found');
  if (!isControlRole(user.role) && user.personnel_id !== p.id) throw httpError(403, 'not you');
  if (!p.welfare_due_at) throw httpError(409, 'no welfare timer running');
  return publicPersonnel(stopWelfare(p, user.role === 'FIELD_USER' ? 'cancelled by officer' : 'cancelled by control', user), user);
});

/* Sites under contract — what alarm response jobs are attached to. */
const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
route('GET', '/api/sites', ALL, ({ user }) => db.sites.filter((s) => siteVisibleTo(s.id, user)));
route('POST', '/api/sites', CONTROL, ({ body }) => {
  const name = String(body.name || '').trim();
  if (!name) throw httpError(400, 'name required');
  if (db.sites.some((x) => x.name.toLowerCase() === name.toLowerCase())) throw httpError(409, 'site already exists');
  if (body.risk_level && !RISK_LEVELS.includes(body.risk_level)) throw httpError(400, `risk_level must be one of ${RISK_LEVELS.join(', ')}`);
  const site = {
    id: nextId('sites'), name, address: body.address || '', lat: Number(body.lat) || null, lon: Number(body.lon) || null,
    keyholder: body.keyholder || '', contact_email: body.contact_email || '', contract: 'ACTIVE', checklist: [],
    response_sla_minutes: body.response_sla_minutes ? Number(body.response_sla_minutes) : null,
    geofence_m: body.geofence_m === undefined || body.geofence_m === null || body.geofence_m === '' ? null : Math.min(Math.max(Number(body.geofence_m) || 0, 0), 5000),
    branch_id: normalizedBranchId(body.branch_id),
    code: String(body.code || '').trim(), postcode: String(body.postcode || '').trim(),
    // Not validated against the IANA database — a typo here shows up as a
    // visibly wrong time on the rota rather than failing closed, which is
    // the safer failure mode for a field with no live-consequence default.
    timezone: String(body.timezone || '').trim() || 'Europe/London',
    risk_level: body.risk_level || null, access_instructions: body.access_instructions || '',
    // Informational, not enforced to exactly one — see README.md.
    is_control_room: body.is_control_room === true,
  };
  db.sites.push(site);
  logEvent('site.created', `SITE ${name} ADDED`);
  return { __status: 201, __body: site };
});
route('PATCH', '/api/sites/:id', ADMIN, ({ params, body }) => {
  const site = db.sites.find((x) => x.id === Number(params.id));
  if (!site) throw httpError(404, 'site not found');
  if ('name' in body) {
    const name = String(body.name || '').trim();
    if (!name) throw httpError(400, 'name required');
    if (db.sites.some((x) => x.id !== site.id && x.name.toLowerCase() === name.toLowerCase())) throw httpError(409, 'site already exists');
    site.name = name;
  }
  if ('address' in body) site.address = body.address || '';
  if ('branch_id' in body) site.branch_id = normalizedBranchId(body.branch_id);
  if ('lat' in body) site.lat = body.lat === null || body.lat === '' ? null : Number(body.lat);
  if ('lon' in body) site.lon = body.lon === null || body.lon === '' ? null : Number(body.lon);
  if ('keyholder' in body) site.keyholder = body.keyholder || '';
  if ('contact_email' in body) site.contact_email = body.contact_email || '';
  if ('response_sla_minutes' in body) {
    if (body.response_sla_minutes !== null && (!Number.isFinite(Number(body.response_sla_minutes)) || Number(body.response_sla_minutes) <= 0)) {
      throw httpError(400, 'response_sla_minutes must be a positive number of minutes, or null');
    }
    site.response_sla_minutes = body.response_sla_minutes === null ? null : Number(body.response_sla_minutes);
  }
  if ('code' in body) site.code = String(body.code || '').trim();
  if ('geofence_m' in body) {
    if (body.geofence_m !== null && body.geofence_m !== '' && (!Number.isFinite(Number(body.geofence_m)) || Number(body.geofence_m) < 0 || Number(body.geofence_m) > 5000)) throw httpError(400, 'geofence must be 0–5000 metres (0 = off)');
    site.geofence_m = body.geofence_m === null || body.geofence_m === '' ? null : Number(body.geofence_m);
  }
  if ('postcode' in body) site.postcode = String(body.postcode || '').trim();
  if ('timezone' in body) site.timezone = String(body.timezone || '').trim() || 'Europe/London';
  if ('risk_level' in body) {
    if (body.risk_level && !RISK_LEVELS.includes(body.risk_level)) throw httpError(400, `risk_level must be one of ${RISK_LEVELS.join(', ')}`);
    site.risk_level = body.risk_level || null;
  }
  if ('access_instructions' in body) site.access_instructions = body.access_instructions || '';
  if ('is_control_room' in body) site.is_control_room = Boolean(body.is_control_room);
  if ('checklist' in body) {
    if (!Array.isArray(body.checklist)) throw httpError(400, 'checklist must be an array');
    site.checklist = body.checklist.map((item) => ({
      id: item.id || crypto.randomUUID(), title: String(item.title || '').trim(), instructions: String(item.instructions || '').trim(),
    })).filter((item) => item.title);
  }
  logEvent('site.updated', `SITE ${site.name} UPDATED`, { site_id: site.id });
  return site;
});
route('DELETE', '/api/sites/:id', ADMIN, ({ params }) => {
  const site = db.sites.find((x) => x.id === Number(params.id));
  if (!site) throw httpError(404, 'site not found');
  if (db.jobs.some((j) => j.site_id === site.id && !['COMPLETED', 'CANCELLED'].includes(j.status))) {
    throw httpError(409, 'site has an open job — resolve or cancel it first');
  }
  if (db.patrol_schedules.some((s) => s.site_id === site.id)) {
    throw httpError(409, 'site has patrol schedules — delete them first');
  }
  if (db.beats.some((b) => b.site_id === site.id)) {
    throw httpError(409, 'site has beats — delete them first');
  }
  if (db.site_visits.some((v) => v.site_id === site.id && !['COMPLETED', 'CANCELLED', 'MISSED'].includes(v.status))) {
    throw httpError(409, 'site has an open site visit — resolve or cancel it first');
  }
  db.sites = db.sites.filter((x) => x.id !== site.id);
  logEvent('site.deleted', `SITE ${site.name} DELETED`, { site_id: site.id });
  return { ok: true };
});

/* Passdown logs — per-site shift-handover notes. Control can read/write any
 * site's log; a FIELD_USER can read/write a site's log only if they've
 * actually been assigned there (a current or past shift or site visit) — the
 * same "were you ever posted here" test either row type already answers, so
 * no separate roster is needed. Entries are an append-only log, like the
 * audit trail: no edit route, a DELETE for control to correct a mistake. */
function assertPassdownAccess(siteId, user) {
  if (isControlRole(user.role)) {
    // DISPATCHER/SYSTEM_ADMIN are never branch/site-scoped (see
    // BRANCH_SCOPED_ROLES), so this only actually constrains a scoped
    // SUPERVISOR — the same "don't confirm it exists" 404 the rest of
    // this file uses for an out-of-scope record.
    if (!siteVisibleTo(siteId, user)) throw httpError(404, 'site not found');
    return;
  }
  if (user.role === 'FIELD_USER' && user.personnel_id) {
    const hasShift = db.shifts.some((s) => s.site_id === siteId
      && db.shift_assignments.some((a) => a.shift_id === s.id && a.personnel_id === user.personnel_id && a.status !== 'REMOVED'));
    const hasVisit = db.site_visits.some((v) => v.site_id === siteId
      && (v.personnel_id === user.personnel_id || (v.additional_personnel || []).includes(user.personnel_id)));
    if (hasShift || hasVisit) return;
  }
  throw httpError(403, 'not assigned to this site');
}
route('GET', '/api/passdown-logs', ALL, ({ query, user }) => {
  const siteId = Number(query.get('site_id'));
  if (!siteId) throw httpError(400, 'site_id required');
  if (!db.sites.some((s) => s.id === siteId)) throw httpError(404, 'site not found');
  assertPassdownAccess(siteId, user);
  return db.passdown_logs.filter((l) => l.site_id === siteId)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .map(publicPassdownLog);
});
route('POST', '/api/passdown-logs', ALL, ({ body, user }) => {
  const site = db.sites.find((s) => s.id === Number(body.site_id));
  if (!site) throw httpError(400, 'site_id must reference an existing site');
  assertPassdownAccess(site.id, user);
  const text = String(body.body || '').trim();
  if (!text) throw httpError(400, 'body required');
  const author = user.role === 'FIELD_USER' && user.personnel_id ? db.personnel.find((p) => p.id === user.personnel_id) : null;
  const log = {
    id: nextId('passdown_logs'), site_id: site.id, body: text.slice(0, 4000),
    author_personnel_id: author ? author.id : null, author_name: author ? author.name : user.display_name,
    created_at: new Date().toISOString(),
  };
  db.passdown_logs.push(log);
  broadcast('passdown_log.created', publicPassdownLog(log));
  logEvent('passdown_log.created', `PASSDOWN NOTE ADDED FOR ${site.name} BY ${log.author_name}`, { site_id: site.id, passdown_log_id: log.id });
  return { __status: 201, __body: publicPassdownLog(log) };
});
route('DELETE', '/api/passdown-logs/:id', ADMIN, ({ params }) => {
  const l = db.passdown_logs.find((x) => x.id === Number(params.id)); if (!l) throw httpError(404, 'passdown log not found');
  db.passdown_logs = db.passdown_logs.filter((x) => x.id !== l.id);
  logEvent('passdown_log.deleted', 'PASSDOWN NOTE DELETED', { passdown_log_id: l.id, site_id: l.site_id });
  return { ok: true };
});

/* Beats — a named patrol route within a site (e.g. "Perimeter", "Car park
 * sweep"), for sites where one checklist doesn't describe the work. Purely
 * optional: a patrol schedule or a manually created visit can reference one,
 * but neither requires it — a site with no beats behaves exactly as before. */
route('GET', '/api/beats', ALL, ({ query }) => {
  let rows = db.beats.map(publicBeat);
  if (query.get('site_id')) rows = rows.filter((b) => b.site_id === Number(query.get('site_id')));
  return rows;
});
route('POST', '/api/beats', CONTROL, ({ body }) => {
  const site = db.sites.find((s) => s.id === Number(body.site_id));
  if (!site) throw httpError(400, 'site_id must reference an existing site');
  const name = String(body.name || '').trim();
  if (!name) throw httpError(400, 'name required');
  const beat = { id: nextId('beats'), site_id: site.id, name, description: body.description || '', waypoints: [], active: body.active !== false };
  db.beats.push(beat);
  logEvent('beat.created', `BEAT "${name}" CREATED FOR ${site.name}`, { beat_id: beat.id });
  return { __status: 201, __body: publicBeat(beat) };
});
route('PATCH', '/api/beats/:id', CONTROL, ({ params, body }) => {
  const b = db.beats.find((x) => x.id === Number(params.id)); if (!b) throw httpError(404, 'beat not found');
  if ('name' in body) { const name = String(body.name || '').trim(); if (!name) throw httpError(400, 'name required'); b.name = name; }
  if ('description' in body) b.description = body.description || '';
  if ('active' in body) b.active = Boolean(body.active);
  if ('waypoints' in body) {
    if (!Array.isArray(body.waypoints)) throw httpError(400, 'waypoints must be an array');
    b.waypoints = body.waypoints.map((w) => ({
      id: w.id || crypto.randomUUID(), title: String(w.title || '').trim(), instructions: String(w.instructions || '').trim(),
    })).filter((w) => w.title);
  }
  logEvent('beat.updated', `BEAT "${b.name}" UPDATED`, { beat_id: b.id });
  return publicBeat(b);
});
route('DELETE', '/api/beats/:id', ADMIN, ({ params }) => {
  const b = db.beats.find((x) => x.id === Number(params.id)); if (!b) throw httpError(404, 'beat not found');
  if (db.patrol_schedules.some((s) => s.beat_id === b.id)) throw httpError(409, 'beat has patrol schedules — reassign or delete them first');
  if (db.site_visits.some((v) => v.beat_id === b.id && !['COMPLETED', 'CANCELLED', 'MISSED'].includes(v.status))) {
    throw httpError(409, 'beat has an open site visit — resolve or cancel it first');
  }
  db.beats = db.beats.filter((x) => x.id !== b.id);
  logEvent('beat.deleted', `BEAT "${b.name}" DELETED`, { beat_id: b.id });
  return { ok: true };
});

/* ------------------------------------------------------------------ *
 * Patrol schedules and site visits
 *
 * A scheduled, recurring alternative to one-off jobs: a patrol_schedules
 * row describes a recurrence ("every Tuesday/Thursday at 22:00" or "every
 * 4 hours"); patrolScheduleTick() below turns a due occurrence into a
 * site_visits row, which then walks the same DISPATCHED -> ACKNOWLEDGED ->
 * EN_ROUTE -> ON_SCENE -> COMPLETED lifecycle as a job, reusing the same
 * checklist/photo/resolution-report machinery. Deliberately simpler than
 * job_assignments: a visit carries its assignee(s) directly (personnel_id +
 * additional_personnel[]) rather than through a join table, since a visit
 * is never assigned to an MDT — it's foot-patrol work.
 * ------------------------------------------------------------------ */
route('GET', '/api/patrol-schedules', ALL, ({ query }) => {
  let rows = db.patrol_schedules.map(publicPatrolSchedule);
  if (query.get('site_id')) rows = rows.filter((s) => s.site_id === Number(query.get('site_id')));
  return rows;
});
function resolveBeatId(rawBeatId, siteId) {
  if (!rawBeatId) return null;
  const beat = db.beats.find((b) => b.id === Number(rawBeatId));
  if (!beat) throw httpError(400, 'beat_id must reference an existing beat');
  if (beat.site_id !== siteId) throw httpError(400, 'beat does not belong to this site');
  return beat.id;
}
route('POST', '/api/patrol-schedules', CONTROL, ({ body }) => {
  const site = db.sites.find((s) => s.id === Number(body.site_id));
  if (!site) throw httpError(400, 'site_id must reference an existing site');
  const label = String(body.label || '').trim();
  if (!label) throw httpError(400, 'label required');
  const daysOfWeek = Array.isArray(body.days_of_week) ? body.days_of_week.map(Number).filter((d) => d >= 0 && d <= 6) : null;
  const intervalHours = body.interval_hours != null && body.interval_hours !== '' ? Number(body.interval_hours) : null;
  if (!(daysOfWeek && daysOfWeek.length) && !intervalHours) throw httpError(400, 'either days_of_week (with time_of_day) or interval_hours is required');
  const schedule = {
    id: nextId('patrol_schedules'), site_id: site.id, beat_id: resolveBeatId(body.beat_id, site.id), label,
    days_of_week: daysOfWeek && daysOfWeek.length ? daysOfWeek : null,
    time_of_day: body.time_of_day || null,
    interval_hours: intervalHours || null,
    duration_expected_min: Number(body.duration_expected_min) || 30,
    active: body.active !== false,
  };
  db.patrol_schedules.push(schedule);
  logEvent('patrol_schedule.created', `PATROL SCHEDULE "${label}" CREATED FOR ${site.name}`, { patrol_schedule_id: schedule.id });
  return { __status: 201, __body: publicPatrolSchedule(schedule) };
});
route('PATCH', '/api/patrol-schedules/:id', CONTROL, ({ params, body }) => {
  const s = db.patrol_schedules.find((x) => x.id === Number(params.id)); if (!s) throw httpError(404, 'patrol schedule not found');
  if ('label' in body) { const label = String(body.label || '').trim(); if (!label) throw httpError(400, 'label required'); s.label = label; }
  if ('days_of_week' in body) s.days_of_week = Array.isArray(body.days_of_week) && body.days_of_week.length ? body.days_of_week.map(Number) : null;
  if ('time_of_day' in body) s.time_of_day = body.time_of_day || null;
  if ('interval_hours' in body) s.interval_hours = body.interval_hours != null && body.interval_hours !== '' ? Number(body.interval_hours) : null;
  if ('duration_expected_min' in body) s.duration_expected_min = Number(body.duration_expected_min) || 30;
  if ('active' in body) s.active = Boolean(body.active);
  if ('beat_id' in body) s.beat_id = resolveBeatId(body.beat_id, s.site_id);
  logEvent('patrol_schedule.updated', `PATROL SCHEDULE "${s.label}" UPDATED`, { patrol_schedule_id: s.id });
  return publicPatrolSchedule(s);
});
route('DELETE', '/api/patrol-schedules/:id', ADMIN, ({ params }) => {
  const s = db.patrol_schedules.find((x) => x.id === Number(params.id)); if (!s) throw httpError(404, 'patrol schedule not found');
  db.patrol_schedules = db.patrol_schedules.filter((x) => x.id !== s.id);
  logEvent('patrol_schedule.deleted', `PATROL SCHEDULE "${s.label}" DELETED`, { patrol_schedule_id: s.id });
  return { ok: true };
});

function nextVisitReference() {
  return `VISIT-${new Date().getFullYear()}-${String(nextId('visitref') + 40).padStart(5, '0')}`;
}
route('GET', '/api/site-visits', ALL, ({ query, user }) => {
  let rows = db.site_visits.filter((v) => siteVisibleTo(v.site_id, user)).map(publicSiteVisit);
  if (query.get('status')) rows = rows.filter((v) => v.status === query.get('status').toUpperCase());
  if (query.get('site_id')) rows = rows.filter((v) => v.site_id === Number(query.get('site_id')));
  return rows;
});
route('POST', '/api/site-visits', CONTROL, ({ body, user }) => {
  const site = db.sites.find((s) => s.id === Number(body.site_id));
  if (!site) throw httpError(400, 'site_id must reference an existing site');
  const v = {
    id: nextId('site_visits'), reference: nextVisitReference(), site_id: site.id, schedule_id: null, beat_id: resolveBeatId(body.beat_id, site.id),
    personnel_id: null, additional_personnel: [], status: 'SCHEDULED',
    scheduled_for: body.scheduled_for || new Date().toISOString(),
    dispatched_at: null, acknowledged_at: null, en_route_at: null, on_scene_at: null, completed_at: null, cancelled_at: null, missed_at: null,
    notes: body.notes || '', checklist: instantiateChecklist(site), media: [], report_html: null,
    checkpoint_scans: [],
    created_by: user.id, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  db.site_visits.push(v);
  broadcast('site_visit.created', publicSiteVisit(v));
  logEvent('site_visit.created', `VISIT ${v.reference} CREATED FOR ${site.name}`, { site_visit_id: v.id });
  return { __status: 201, __body: publicSiteVisit(v) };
});
route('POST', '/api/site-visits/:id/assign', CONTROL, ({ params, body }) => {
  const v = db.site_visits.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'site visit not found');
  const p = findPersonnel(body.personnel); if (!p) throw httpError(400, 'personnel required');
  if (v.personnel_id === p.id || (v.additional_personnel || []).includes(p.id)) throw httpError(409, `${p.name} is already assigned to this visit`);
  if (!v.personnel_id) v.personnel_id = p.id;
  else { v.additional_personnel = v.additional_personnel || []; v.additional_personnel.push(p.id); }
  if (v.status === 'SCHEDULED') v.status = 'DISPATCHED';
  stampVisitStatus(v, 'DISPATCHED');
  v.updated_at = new Date().toISOString();
  const site = db.sites.find((s) => s.id === v.site_id);
  const payload = publicSiteVisit(v);
  broadcast('site_visit.dispatched', payload);
  broadcast('site_visit.assigned_to_you', payload, { personnelIds: [p.id] });
  pushToUsers(db.users.filter((u) => u.personnel_id === p.id).map((u) => u.id),
    { title: `Patrol visit ${v.reference}`, body: site ? site.name : 'Site visit', url: '/officer.html', tag: 'cccs-visit' });
  logEvent('site_visit.dispatched', `VISIT ${v.reference} DISPATCHED → ${p.name}`, { site_visit_id: v.id });
  return payload;
});
function assertVisitAccess(v, user) {
  if (isControlRole(user.role)) return;
  const mine = user.role === 'FIELD_USER' && user.personnel_id
    && (v.personnel_id === user.personnel_id || (v.additional_personnel || []).includes(user.personnel_id));
  if (!mine) throw httpError(403, 'visit not assigned to you');
}
route('POST', '/api/site-visits/:id/ack', ALL, ({ params, user }) => {
  const v = db.site_visits.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'site visit not found');
  assertVisitAccess(v, user);
  if (v.status === 'DISPATCHED') v.status = 'ACKNOWLEDGED';
  stampVisitStatus(v, 'ACKNOWLEDGED');
  v.updated_at = new Date().toISOString();
  const who = user.role === 'FIELD_USER' ? (db.personnel.find((p) => p.id === user.personnel_id) || {}).name : user.display_name;
  broadcast('site_visit.acknowledged', { visit: publicSiteVisit(v), by: who });
  logEvent('site_visit.acknowledged', `${who} ACKNOWLEDGED VISIT ${v.reference}`, { site_visit_id: v.id });
  return publicSiteVisit(v);
});
route('PATCH', '/api/site-visits/:id', ALL, ({ params, body, user }) => {
  const v = db.site_visits.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'site visit not found');
  if (body.status) {
    const s = String(body.status).toUpperCase();
    if (!SITE_VISIT_STATES.includes(s)) throw httpError(400, 'invalid visit status');
    assertVisitAccess(v, user);
    v.status = s;
    stampVisitStatus(v, s);
    if (s === 'COMPLETED') {
      const site = db.sites.find((x) => x.id === v.site_id);
      const beat = v.beat_id ? db.beats.find((x) => x.id === v.beat_id) : null;
      const waypoints = beat ? beat.waypoints || [] : [];
      const scannedIds = new Set((v.checkpoint_scans || []).map((sc) => sc.waypoint_id));
      v.report_html = buildResolutionReportHtml({
        reference: v.reference, kindLabel: 'Patrol visit', locationLabel: site ? site.name : 'Site visit', siteId: v.site_id,
        description: '', notes: v.notes,
        timeline: [
          ['Scheduled', v.scheduled_for], ['Dispatched', v.dispatched_at], ['Acknowledged', v.acknowledged_at],
          ['En route', v.en_route_at], ['On scene', v.on_scene_at], ['Completed', v.completed_at],
        ].filter(([, t]) => t),
        checklist: v.checklist, media: v.media,
        extraRows: waypoints.length ? [['Checkpoints', `${waypoints.filter((w) => scannedIds.has(w.id)).length} / ${waypoints.length} scanned` + (waypoints.some((w) => !scannedIds.has(w.id)) ? ` (missing: ${waypoints.filter((w) => !scannedIds.has(w.id)).map((w) => w.title).join(', ')})` : '')]] : [],
      });
      sendResolutionReportEmail({
        reference: v.reference, siteId: v.site_id, media: v.media, mediaDir: visitMediaDir(v.id),
        logType: 'site_visit.report_emailed', logIdKey: 'site_visit_id', logId: v.id,
      }, v.report_html);
      logEvent('site_visit.report_generated', `RESOLUTION REPORT GENERATED FOR ${v.reference}`, { site_visit_id: v.id });
    }
  }
  if (body.notes !== undefined) v.notes = String(body.notes).slice(0, 2000);
  v.updated_at = new Date().toISOString();
  broadcast('site_visit.status_changed', publicSiteVisit(v));
  logEvent('site_visit.status_changed', `VISIT ${v.reference} → ${v.status}`, { site_visit_id: v.id });
  return publicSiteVisit(v);
});
route('PATCH', '/api/site-visits/:id/checklist/:itemId', ALL, ({ params, body, user }) => {
  const v = db.site_visits.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'site visit not found');
  assertVisitAccess(v, user);
  const item = (v.checklist || []).find((x) => x.id === params.itemId); if (!item) throw httpError(404, 'checklist item not found');
  if (body.status) {
    const s = String(body.status).toUpperCase();
    if (!['PENDING', 'COMPLETE'].includes(s)) throw httpError(400, 'invalid checklist status');
    item.status = s;
    if (s === 'COMPLETE') { item.completed_at = new Date().toISOString(); item.completed_by = user.display_name; }
    else { item.completed_at = null; item.completed_by = null; }
  }
  if (body.notes !== undefined) item.notes = String(body.notes).slice(0, 2000);
  v.updated_at = new Date().toISOString();
  broadcast('site_visit.status_changed', publicSiteVisit(v));
  logEvent('site_visit.checklist_updated', `${item.status === 'COMPLETE' ? 'COMPLETED' : 'UPDATED'} "${item.title}" on VISIT ${v.reference}`, { site_visit_id: v.id });
  return publicSiteVisit(v);
});
route('POST', '/api/site-visits/:id/media', ALL, ({ params, body, user }) => {
  const v = db.site_visits.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'site visit not found');
  assertVisitAccess(v, user);
  const ext = MEDIA_MIME_EXT[body.mimetype];
  if (!ext) throw httpError(400, 'mimetype must be image/jpeg, image/png or image/webp');
  if (!body.data) throw httpError(400, 'data (base64) required');
  if (body.checklist_item_id && !(v.checklist || []).some((x) => x.id === body.checklist_item_id)) throw httpError(404, 'checklist item not found');
  const bytes = Buffer.from(body.data, 'base64');
  if (bytes.length > 8e6) throw httpError(413, 'photo too large');
  const dir = visitMediaDir(v.id);
  fs.mkdirSync(dir, { recursive: true });
  const mediaId = crypto.randomUUID();
  const filename = `${mediaId}${ext}`;
  fs.writeFileSync(path.join(dir, filename), bytes);
  const media = {
    id: mediaId, url: `/api/site-visits/${v.id}/media/${mediaId}`, filename, caption: String(body.caption || '').slice(0, 200),
    checklist_item_id: body.checklist_item_id || null, taken_by: user.display_name, taken_at: new Date().toISOString(),
  };
  v.media = v.media || [];
  v.media.push(media);
  v.updated_at = new Date().toISOString();
  broadcast('site_visit.status_changed', publicSiteVisit(v));
  logEvent('site_visit.media_added', `PHOTO ADDED TO VISIT ${v.reference}`, { site_visit_id: v.id });
  return { __status: 201, __body: media };
});
route('GET', '/api/site-visits/:id/media/:mediaId', ALL, ({ params, user }) => {
  const v = db.site_visits.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'site visit not found');
  assertVisitAccess(v, user);
  const m = (v.media || []).find((x) => x.id === params.mediaId); if (!m) throw httpError(404, 'photo not found');
  const file = path.join(visitMediaDir(v.id), m.filename);
  if (!fs.existsSync(file)) throw httpError(404, 'photo file missing');
  return { __body: fs.readFileSync(file), __headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'private, max-age=86400' } };
});
route('GET', '/api/site-visits/:id/report', CONTROL, ({ params }) => {
  const v = db.site_visits.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'site visit not found');
  if (!v.report_html) throw httpError(404, 'no report yet — the visit has not been completed');
  return { __body: v.report_html, __headers: { 'content-type': 'text/html; charset=utf-8' } };
});
route('POST', '/api/site-visits/:id/stand-down', CONTROL, ({ params, body }) => {
  const v = db.site_visits.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'site visit not found');
  const p = findPersonnel(body.personnel); if (!p) throw httpError(400, 'personnel required');
  let removed = false;
  if (v.personnel_id === p.id) { v.personnel_id = (v.additional_personnel || []).shift() || null; removed = true; }
  else if ((v.additional_personnel || []).includes(p.id)) { v.additional_personnel = v.additional_personnel.filter((id) => id !== p.id); removed = true; }
  if (!removed) throw httpError(404, 'that person is not assigned to this visit');
  if (!v.personnel_id && !(v.additional_personnel || []).length && v.status === 'DISPATCHED') v.status = 'SCHEDULED';
  v.updated_at = new Date().toISOString();
  const payload = publicSiteVisit(v);
  broadcast('site_visit.status_changed', payload);
  broadcast('site_visit.stood_down', payload, { personnelIds: [p.id] });
  logEvent('site_visit.stood_down', `${p.name} STOOD DOWN FROM VISIT ${v.reference}`, { site_visit_id: v.id });
  return payload;
});

/* Guard tour checkpoint scanning — a beat's waypoints (see the Beats
 * section above) double as checkpoints: each one gets a QR code (just its
 * own id, printed/posted at the physical location — see admin.html's Beats
 * tab), and scanning it here is what proves an officer actually reached
 * that point rather than just clicking through a list from the break room.
 * Re-scanning the same waypoint is allowed — a real tour sometimes revisits
 * a point, and the log is a timeline, not a checklist that needs undoing. */
route('POST', '/api/site-visits/:id/checkpoint-scan', ALL, ({ params, body, user }) => {
  const v = db.site_visits.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'site visit not found');
  assertVisitAccess(v, user);
  if (['COMPLETED', 'CANCELLED', 'MISSED'].includes(v.status)) throw httpError(409, 'visit is already closed');
  if (!v.beat_id) throw httpError(400, 'this visit has no beat — nothing to scan against');
  const beat = db.beats.find((b) => b.id === v.beat_id);
  const waypoint = beat && (beat.waypoints || []).find((w) => w.id === body.waypoint_id);
  if (!waypoint) throw httpError(404, 'waypoint not found on this visit\'s beat');
  const scan = {
    id: crypto.randomUUID(), waypoint_id: waypoint.id, waypoint_title: waypoint.title,
    scanned_at: new Date().toISOString(), scanned_by: user.role === 'FIELD_USER' ? user.personnel_id : null,
    lat: body.lat != null ? Number(body.lat) : null, lon: body.lon != null ? Number(body.lon) : null,
  };
  v.checkpoint_scans = v.checkpoint_scans || [];
  v.checkpoint_scans.push(scan);
  v.updated_at = new Date().toISOString();
  const payload = publicSiteVisit(v);
  broadcast('site_visit.status_changed', payload);
  const who = user.role === 'FIELD_USER' ? (db.personnel.find((p) => p.id === user.personnel_id) || {}).name : user.display_name;
  logEvent('site_visit.checkpoint_scanned', `${who} SCANNED "${waypoint.title}" ON VISIT ${v.reference}`, { site_visit_id: v.id, waypoint_id: waypoint.id });
  return { __status: 201, __body: payload };
});

/* ---- Patrol scheduling tick ------------------------------------------
 * Turns a due patrol_schedules occurrence into a SCHEDULED site_visits row,
 * and flags a SCHEDULED visit nobody ever dispatched, well past its window,
 * as MISSED — a silent gap in patrol coverage is exactly what this exists
 * to surface, not something to let quietly age out. */
const PATROL_SCHEDULE_TICK_MS = Number(process.env.PATROL_SCHEDULE_TICK_MS || 60000);
const VISIT_MISSED_GRACE_MIN = Number(process.env.VISIT_MISSED_GRACE_MIN || 120);
const OPEN_VISIT_STATES = ['SCHEDULED', 'DISPATCHED', 'ACKNOWLEDGED', 'EN_ROUTE', 'ON_SCENE'];
function createSiteVisitFromSchedule(schedule, scheduledFor) {
  const site = db.sites.find((s) => s.id === schedule.site_id);
  if (!site) return null;
  const v = {
    id: nextId('site_visits'), reference: nextVisitReference(), site_id: site.id, schedule_id: schedule.id, beat_id: schedule.beat_id || null,
    personnel_id: null, additional_personnel: [], status: 'SCHEDULED',
    scheduled_for: scheduledFor.toISOString(),
    dispatched_at: null, acknowledged_at: null, en_route_at: null, on_scene_at: null, completed_at: null, cancelled_at: null, missed_at: null,
    notes: '', checklist: instantiateChecklist(site), media: [], report_html: null,
    checkpoint_scans: [],
    created_by: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  db.site_visits.push(v);
  broadcast('site_visit.created', publicSiteVisit(v));
  logEvent('site_visit.created', `VISIT ${v.reference} SCHEDULED FOR ${site.name} (${schedule.label})`, { site_visit_id: v.id, patrol_schedule_id: schedule.id });
  return v;
}
function patrolScheduleTick() {
  const now = new Date();
  for (const schedule of db.patrol_schedules) {
    if (!schedule.active) continue;
    const existingForSchedule = db.site_visits.filter((v) => v.schedule_id === schedule.id);
    const hasOpen = existingForSchedule.some((v) => OPEN_VISIT_STATES.includes(v.status));

    if (schedule.interval_hours) {
      if (hasOpen) continue;
      const last = existingForSchedule.slice().sort((a, b) => Date.parse(b.scheduled_for) - Date.parse(a.scheduled_for))[0];
      const dueAt = last ? Date.parse(last.scheduled_for) + schedule.interval_hours * 3600000 : now.getTime();
      if (now.getTime() >= dueAt) createSiteVisitFromSchedule(schedule, now);
    } else if (schedule.days_of_week && schedule.time_of_day) {
      const todayIdx = now.getDay();
      if (!schedule.days_of_week.includes(todayIdx)) continue;
      const [hh, mm] = schedule.time_of_day.split(':').map(Number);
      const dueToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
      if (now < dueToday) continue;
      const alreadyToday = existingForSchedule.some((v) => {
        const d = new Date(v.scheduled_for);
        return d.getFullYear() === dueToday.getFullYear() && d.getMonth() === dueToday.getMonth() && d.getDate() === dueToday.getDate();
      });
      if (!alreadyToday) createSiteVisitFromSchedule(schedule, dueToday);
    }
  }

  const graceMs = VISIT_MISSED_GRACE_MIN * 60000;
  for (const v of db.site_visits) {
    if (v.status !== 'SCHEDULED') continue;
    if (now.getTime() - Date.parse(v.scheduled_for) < graceMs) continue;
    v.status = 'MISSED';
    stampVisitStatus(v, 'MISSED');
    v.updated_at = new Date().toISOString();
    broadcast('site_visit.missed', publicSiteVisit(v));
    logEvent('site_visit.missed', `VISIT ${v.reference} MISSED — NEVER DISPATCHED`, { site_visit_id: v.id });
    pushToRoles(CONTROL, { title: 'Missed patrol visit', body: v.reference, url: '/control.html', tag: 'cccs-visit-missed' });
  }
}

/* ------------------------------------------------------------------ *
 * HR rota — shift types, shifts (slots) and assignments (who's on them)
 * ------------------------------------------------------------------ */
route('GET', '/api/shift-types', ALL, ({ query, user }) => {
  const showAll = query.get('all') === '1' && user.role === 'SYSTEM_ADMIN';
  return (showAll ? db.shift_types : db.shift_types.filter((t) => t.active)).map(publicShiftType);
});
route('POST', '/api/shift-types', ADMIN, ({ body }) => {
  const name = String(body.name || '').trim();
  if (!name) throw httpError(400, 'name required');
  const key = String(body.key || name).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (!key) throw httpError(400, 'key required');
  if (db.shift_types.some((t) => t.key === key)) throw httpError(409, 'a shift type with that key already exists');
  const t = { id: nextId('shift_types'), key, name, color: body.color || '#6b7280', active: true, created_at: new Date().toISOString() };
  db.shift_types.push(t);
  logEvent('shift_type.created', `SHIFT TYPE ${name} ADDED`, { shift_type_id: t.id });
  return { __status: 201, __body: publicShiftType(t) };
});
route('PATCH', '/api/shift-types/:id', ADMIN, ({ params, body }) => {
  const t = db.shift_types.find((x) => x.id === Number(params.id)); if (!t) throw httpError(404, 'shift type not found');
  if ('name' in body) { const name = String(body.name || '').trim(); if (!name) throw httpError(400, 'name required'); t.name = name; }
  if ('color' in body) t.color = body.color || '#6b7280';
  if ('active' in body) t.active = Boolean(body.active);
  logEvent('shift_type.updated', `SHIFT TYPE ${t.name} UPDATED`, { shift_type_id: t.id });
  return publicShiftType(t);
});

function findShift(id) { const s = db.shifts.find((x) => x.id === Number(id)); if (!s) throw httpError(404, 'shift not found'); return s; }
function findAssignment(id) { const a = db.shift_assignments.find((x) => x.id === Number(id)); if (!a) throw httpError(404, 'assignment not found'); return a; }
function assignedPersonnelIds(shiftId) { return db.shift_assignments.filter((a) => a.shift_id === shiftId && a.status !== 'REMOVED').map((a) => a.personnel_id); }

route('GET', '/api/shifts', ALL, ({ query, user }) => {
  let rows = db.shifts.slice();
  // A draft is "not yet ready to show staff" by definition — only a
  // control role ever sees one, same as a RESTRICTED form submission only
  // being visible to those with a reason to see it.
  if (!isControlRole(user.role)) rows = rows.filter((s) => s.status !== 'DRAFT');
  // Every other list in the system (jobs, site-visits, shift applications)
  // already narrows to a branch/site-scoped caller's own patch; the rota
  // itself had been missed — a scoped SUPERVISOR could otherwise see (and,
  // via the write routes below, touch) every other branch's shifts too.
  rows = rows.filter((s) => siteVisibleTo(s.site_id, user));
  if (query.get('site_id')) rows = rows.filter((s) => s.site_id === Number(query.get('site_id')));
  if (query.get('shift_type_id')) rows = rows.filter((s) => s.shift_type_id === Number(query.get('shift_type_id')));
  if (query.get('status')) rows = rows.filter((s) => s.status === query.get('status').toUpperCase());
  if (query.get('from')) rows = rows.filter((s) => s.ends_at >= query.get('from'));
  if (query.get('to')) rows = rows.filter((s) => s.starts_at <= query.get('to'));
  const idx = buildShiftIndex();
  const personnelId = query.get('personnel_id') ? Number(query.get('personnel_id')) : null;
  if (personnelId) rows = rows.filter((s) => (idx.assignmentsByShift.get(s.id) || []).some((a) => a.status !== 'REMOVED' && a.personnel_id === personnelId));
  const out = rows.sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at)).map((s) => publicShift(s, idx));
  // Convenience for a single-person view (officer.html): that person's own
  // assignment on each shift, so the caller doesn't have to search
  // `assignments` itself for the one row it actually asked about.
  if (personnelId) for (const s of out) s.my = s.assignments.find((a) => a.personnel_id === personnelId) || null;
  return out;
});
route('POST', '/api/shifts', ADMIN, ({ body, user }) => {
  const startsAt = body.starts_at ? new Date(body.starts_at) : null;
  const endsAt = body.ends_at ? new Date(body.ends_at) : null;
  if (!startsAt || isNaN(startsAt) || !endsAt || isNaN(endsAt)) throw httpError(400, 'starts_at and ends_at (ISO timestamps) required');
  if (endsAt <= startsAt) throw httpError(400, 'ends_at must be after starts_at');
  const type = db.shift_types.find((x) => x.id === Number(body.shift_type_id));
  if (!type) throw httpError(400, 'shift_type_id required and must exist');
  const site = body.site_id ? db.sites.find((x) => x.id === Number(body.site_id)) : null;
  if (site && !siteVisibleTo(site.id, user)) throw httpError(404, 'site not found');
  const headcount = body.required_headcount != null && body.required_headcount !== '' ? Number(body.required_headcount) : 1;
  if (!Number.isFinite(headcount) || headcount < 1) throw httpError(400, 'required_headcount must be a positive number');
  // Defaults to visible immediately, matching this restructuring's original
  // behaviour. A caller may ask for DRAFT explicitly (building out a week
  // before announcing it); IN_PROGRESS/COMPLETED/CANCELLED make no sense on
  // a shift that doesn't exist yet, so those are refused at creation.
  if ('status' in body && !['DRAFT', 'PUBLISHED'].includes(body.status)) throw httpError(400, 'a new shift must be DRAFT or PUBLISHED');
  const s = {
    id: nextId('shifts'), site_id: site ? site.id : null, shift_type_id: type.id,
    starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(),
    break_minutes: body.break_minutes ? Number(body.break_minutes) : 0,
    required_headcount: headcount,
    status: body.status === 'DRAFT' ? 'DRAFT' : 'PUBLISHED',
    pay_rate: body.pay_rate != null && body.pay_rate !== '' ? Number(body.pay_rate) : null,
    bill_rate: body.bill_rate != null && body.bill_rate !== '' ? Number(body.bill_rate) : null,
    uniform_ppe: body.uniform_ppe || '', briefing: body.briefing || '', notes: body.notes || '',
    detail: body.detail && typeof body.detail === 'object' ? body.detail : {},
    template_id: null, revision: 0,
    created_by: user.id, created_at: new Date().toISOString(),
  };
  db.shifts.push(s);
  // A `personnel` convenience, the same shape the old single-assignment API
  // used — the common case (control fills in one person while creating the
  // shift) shouldn't need a second round trip to /assignments.
  let firstAssignment = null;
  if (body.personnel) {
    const p = findPersonnel(body.personnel);
    if (!p) throw httpError(400, 'personnel not found');
    firstAssignment = {
      id: nextId('shift_assignments'), shift_id: s.id, personnel_id: p.id, role_on_shift: body.role_on_shift || '',
      is_duty_supervisor: body.is_duty_supervisor === true, status: 'ASSIGNED', confirmed_at: null,
      attendance: null, clocked_in_at: null, clocked_out_at: null,
      created_by: user.id, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    db.shift_assignments.push(firstAssignment);
  }
  const pub = publicShift(s);
  // A draft is "not ready to show staff" — the assigned officer doesn't
  // find out over the socket either, the same boundary GET /api/shifts
  // enforces on a fetch.
  broadcast('shift.created', pub, s.status === 'DRAFT' ? { controlOnly: true } : { personnelIds: firstAssignment ? [firstAssignment.personnel_id] : [] });
  if (s.status !== 'DRAFT' && firstAssignment) notifyShiftEvent('ASSIGNED', s, [firstAssignment.personnel_id]);
  logEvent('shift.created', `SHIFT CREATED (${type.name}) ${s.starts_at} — ${s.ends_at}${firstAssignment ? ` FOR ${findPersonnel(firstAssignment.personnel_id).name}` : ''}`, { shift_id: s.id });
  return { __status: 201, __body: pub };
});
route('PATCH', '/api/shifts/:id', ADMIN, ({ params, body, user }) => {
  const s = findShift(params.id);
  if (!siteVisibleTo(s.site_id, user)) throw httpError(404, 'shift not found');
  if ('site_id' in body && body.site_id && !siteVisibleTo(Number(body.site_id), user)) throw httpError(404, 'site not found');
  const wasDraft = s.status === 'DRAFT';
  let scheduleChanged = false;
  if ('starts_at' in body) { const d = new Date(body.starts_at); if (isNaN(d)) throw httpError(400, 'invalid starts_at'); if (d.toISOString() !== s.starts_at) scheduleChanged = true; s.starts_at = d.toISOString(); }
  if ('ends_at' in body) { const d = new Date(body.ends_at); if (isNaN(d)) throw httpError(400, 'invalid ends_at'); if (d.toISOString() !== s.ends_at) scheduleChanged = true; s.ends_at = d.toISOString(); }
  if (Date.parse(s.ends_at) <= Date.parse(s.starts_at)) throw httpError(400, 'ends_at must be after starts_at');
  if ('site_id' in body) { const site = body.site_id ? db.sites.find((x) => x.id === Number(body.site_id)) : null; const newId = site ? site.id : null; if (newId !== s.site_id) scheduleChanged = true; s.site_id = newId; }
  if ('shift_type_id' in body) {
    const type = db.shift_types.find((x) => x.id === Number(body.shift_type_id));
    if (!type) throw httpError(400, 'shift_type_id must exist');
    s.shift_type_id = type.id;
  }
  if ('required_headcount' in body) {
    const h = Number(body.required_headcount);
    if (!Number.isFinite(h) || h < 1) throw httpError(400, 'required_headcount must be a positive number');
    s.required_headcount = h;
  }
  if ('break_minutes' in body) s.break_minutes = Number(body.break_minutes) || 0;
  if ('pay_rate' in body) s.pay_rate = body.pay_rate === null || body.pay_rate === '' ? null : Number(body.pay_rate);
  if ('bill_rate' in body) s.bill_rate = body.bill_rate === null || body.bill_rate === '' ? null : Number(body.bill_rate);
  if ('uniform_ppe' in body) s.uniform_ppe = body.uniform_ppe || '';
  if ('briefing' in body) s.briefing = body.briefing || '';
  if ('notes' in body) s.notes = body.notes || '';
  if ('detail' in body) s.detail = body.detail && typeof body.detail === 'object' ? body.detail : {};
  let justCancelled = false;
  if ('status' in body) {
    if (!SHIFT_STATES.includes(body.status)) throw httpError(400, 'invalid shift status');
    justCancelled = body.status === 'CANCELLED' && s.status !== 'CANCELLED';
    s.status = body.status;
    if (body.status === 'CANCELLED') shiftApplications.expireApplicationsForShift(s.id);
  }
  s.revision = (s.revision || 0) + 1;
  const pub = publicShift(s);
  // Editing a still-draft shift (e.g. fixing its time before publishing)
  // must not tip off its assignee any sooner than publishing itself would.
  broadcast('shift.updated', pub, s.status === 'DRAFT' ? { controlOnly: true } : { personnelIds: assignedPersonnelIds(s.id) });
  if (!wasDraft && s.status !== 'DRAFT') {
    const affected = assignedPersonnelIds(s.id);
    if (justCancelled) notifyShiftEvent('CANCELLED', s, affected);
    else if (scheduleChanged) notifyShiftEvent('CHANGED', s, affected);
  }
  logEvent('shift.updated', `SHIFT ${s.id} UPDATED`, { shift_id: s.id });
  return pub;
});
route('DELETE', '/api/shifts/:id', ADMIN, ({ params }) => {
  const s = findShift(params.id);
  const affected = assignedPersonnelIds(s.id);
  const wasDraft = s.status === 'DRAFT';
  shiftApplications.expireApplicationsForShift(s.id);
  db.shifts = db.shifts.filter((x) => x.id !== s.id);
  db.shift_assignments = db.shift_assignments.filter((a) => a.shift_id !== s.id);
  broadcast('shift.deleted', { id: s.id }, { personnelIds: affected });
  if (!wasDraft) notifyShiftEvent('CANCELLED', s, affected);
  logEvent('shift.deleted', `SHIFT ${s.id} DELETED`, { shift_id: s.id });
  return { ok: true };
});

/* ---- Assignments: who's on a shift, and their attendance ---- */
function assertAssignmentAccess(a, user) {
  if (isControlRole(user.role)) return;
  if (user.role === 'FIELD_USER' && user.personnel_id === a.personnel_id) return;
  throw httpError(403, 'not your shift');
}
route('POST', '/api/shifts/:id/assignments', ADMIN, ({ params, body, user }) => {
  const s = findShift(params.id);
  if (!siteVisibleTo(s.site_id, user)) throw httpError(404, 'shift not found');
  const p = findPersonnel(body.personnel); if (!p) throw httpError(400, 'personnel required');
  if (db.shift_assignments.some((a) => a.shift_id === s.id && a.personnel_id === p.id && a.status !== 'REMOVED')) {
    throw httpError(409, `${p.name} is already on this shift`);
  }
  const a = {
    id: nextId('shift_assignments'), shift_id: s.id, personnel_id: p.id, role_on_shift: body.role_on_shift || '',
    is_duty_supervisor: body.is_duty_supervisor === true, status: 'ASSIGNED', confirmed_at: null,
    attendance: null, clocked_in_at: null, clocked_out_at: null,
    created_by: user.id, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  db.shift_assignments.push(a);
  s.revision = (s.revision || 0) + 1;
  const pub = publicShift(s);
  broadcast('shift.updated', pub, s.status === 'DRAFT' ? { controlOnly: true } : { personnelIds: [p.id] });
  if (s.status !== 'DRAFT') notifyShiftEvent('ASSIGNED', s, [p.id]);
  logEvent('shift_assignment.created', `${p.name} ADDED TO SHIFT ${s.id}`, { shift_id: s.id, personnel_id: p.id });
  return { __status: 201, __body: pub };
});
route('PATCH', '/api/shift-assignments/:id', ALL, ({ params, body, user }) => {
  const a = findAssignment(params.id);
  const s = findShift(a.shift_id);
  const isOwn = user.role === 'FIELD_USER' && user.personnel_id === a.personnel_id;
  // Editing WHO is on a shift, and how, is admin-only now (dispatchers and
  // officers are read-only on the rota) — confirming or declining your own
  // offered shift is a different, self-service action and stays open to
  // the assignee regardless.
  const isAdmin = user.role === 'SYSTEM_ADMIN';
  if (!isOwn && !isAdmin) throw httpError(403, 'not your shift');
  if (!isOwn && isAdmin && !siteVisibleTo(s.site_id, user)) throw httpError(404, 'shift not found');
  let justRemoved = false;
  if ('status' in body) {
    const status = String(body.status || '').toUpperCase();
    if (!SHIFT_ASSIGNMENT_STATES.includes(status)) throw httpError(400, 'invalid status');
    if (isOwn && !['CONFIRMED', 'DECLINED'].includes(status)) throw httpError(403, 'you can only confirm or decline your own assignment');
    if (status === 'REMOVED' && !isAdmin) throw httpError(403, 'insufficient role');
    justRemoved = status === 'REMOVED' && a.status !== 'REMOVED';
    a.status = status;
    if (status === 'CONFIRMED') a.confirmed_at = new Date().toISOString();
  }
  if ('role_on_shift' in body && isAdmin) a.role_on_shift = body.role_on_shift || '';
  if ('is_duty_supervisor' in body && isAdmin) a.is_duty_supervisor = Boolean(body.is_duty_supervisor);
  if ('attendance' in body && isAdmin) {
    if (body.attendance !== null && !ATTENDANCE_STATES.includes(body.attendance)) throw httpError(400, 'invalid attendance');
    a.attendance = body.attendance;
  }
  a.updated_at = new Date().toISOString();
  s.revision = (s.revision || 0) + 1;
  const pub = publicShift(s);
  broadcast('shift.updated', pub, s.status === 'DRAFT' ? { controlOnly: true } : { personnelIds: [a.personnel_id] });
  // An admin-initiated removal is news to the officer; their own
  // confirm/decline is something they just did, so it needs no echo back.
  if (justRemoved && isAdmin && s.status !== 'DRAFT') notifyShiftEvent('REMOVED', s, [a.personnel_id]);
  const p = db.personnel.find((x) => x.id === a.personnel_id);
  logEvent('shift_assignment.updated', `${p ? p.name : 'PERSON'} ON SHIFT ${s.id} UPDATED`, { shift_id: s.id, personnel_id: a.personnel_id });
  return pub;
});
route('POST', '/api/shift-assignments/:id/clock-in', ALL, ({ params, body, user }) => {
  const a = findAssignment(params.id);
  assertAssignmentAccess(a, user);
  const s = findShift(a.shift_id);
  if (a.clocked_in_at) return publicShift(s);
  if (a.status === 'REMOVED') throw httpError(409, 'no longer on this shift');
  // On-site check (routes-attendance.js): throws if they are not there.
  attendance.checkClockIn(a, s, body || {}, user);
  a.clocked_in_at = new Date().toISOString(); a.updated_at = a.clocked_in_at;
  if (s.status === 'PUBLISHED') { s.status = 'IN_PROGRESS'; }
  const p = db.personnel.find((x) => x.id === a.personnel_id);
  const pub = publicShift(s);
  broadcast('shift.updated', pub, { personnelIds: [a.personnel_id] });
  logEvent('shift.clocked_in', `${p ? p.name : 'PERSON'} CLOCKED IN`, { shift_id: s.id, personnel_id: a.personnel_id });
  return pub;
});
route('POST', '/api/shift-assignments/:id/clock-out', ALL, ({ params, user }) => {
  const a = findAssignment(params.id);
  assertAssignmentAccess(a, user);
  const s = findShift(a.shift_id);
  if (!a.clocked_in_at) throw httpError(409, 'not clocked in');
  if (a.clocked_out_at) throw httpError(409, 'already clocked out');
  a.clocked_out_at = new Date().toISOString(); a.updated_at = a.clocked_out_at;
  attendance.closeBreaks(a, a.clocked_out_at);
  if (!a.attendance) a.attendance = 'ATTENDED';
  const p = db.personnel.find((x) => x.id === a.personnel_id);
  const pub = publicShift(s);
  broadcast('shift.updated', pub, { personnelIds: [a.personnel_id] });
  logEvent('shift.clocked_out', `${p ? p.name : 'PERSON'} CLOCKED OUT`, { shift_id: s.id, personnel_id: a.personnel_id });
  return pub;
});

/* Ad hoc clock-in — covering work nobody rostered (someone called in sick,
 * a last-minute cover request). Rather than a parallel attendance system,
 * this creates a genuine shift + assignment on the fly (status IN_PROGRESS,
 * detail.adhoc true to flag it apart on the rota) and clocks the caller
 * into it immediately, through the exact same geofence check as a normal
 * clock-in — from here on it IS a normal shift: clock-out, breaks, hours,
 * auto-clock-out-on-leaving-site, all the existing attendance machinery
 * applies untouched. A generous 12h placeholder end time stands in for a
 * real rostered end — the shift is still open until they clock out. */
route('POST', '/api/shifts/adhoc', ALL, ({ body, user }) => {
  if (!user.personnel_id) throw httpError(400, 'this login is not linked to a member of staff');
  const siteId = Number(body.site_id);
  const site = siteId ? db.sites.find((x) => x.id === siteId) : null;
  if (!site || !siteVisibleTo(siteId, user)) throw httpError(404, 'site not found');
  const alreadyOn = db.shift_assignments.find((a) => a.personnel_id === user.personnel_id && a.clocked_in_at && !a.clocked_out_at);
  if (alreadyOn) throw httpError(409, 'you are already clocked in on another shift — clock out of that one first');
  const now = new Date();
  const s = {
    id: nextId('shifts'), site_id: siteId, shift_type_id: null,
    starts_at: now.toISOString(), ends_at: new Date(now.getTime() + 12 * 3600000).toISOString(),
    break_minutes: 0, required_headcount: 1, status: 'IN_PROGRESS',
    pay_rate: null, bill_rate: null, uniform_ppe: '', briefing: '',
    notes: 'Ad hoc shift — not pre-rostered.', detail: { adhoc: true }, template_id: null, revision: 1,
    created_by: user.id, created_at: now.toISOString(),
  };
  db.shifts.push(s);
  const a = {
    id: nextId('shift_assignments'), shift_id: s.id, personnel_id: user.personnel_id, role_on_shift: '',
    is_duty_supervisor: false, status: 'CONFIRMED', confirmed_at: now.toISOString(),
    attendance: null, clocked_in_at: null, clocked_out_at: null,
    created_by: user.id, created_at: now.toISOString(), updated_at: now.toISOString(),
  };
  db.shift_assignments.push(a);
  attendance.checkClockIn(a, s, body || {}, user);
  a.clocked_in_at = new Date().toISOString(); a.updated_at = a.clocked_in_at;
  const p = db.personnel.find((x) => x.id === user.personnel_id);
  const pub = publicShift(s);
  pub.my = pub.assignments.find((x) => x.personnel_id === user.personnel_id) || null;
  broadcast('shift.updated', pub, { personnelIds: [user.personnel_id] });
  logEvent('shift.adhoc_created', `${p ? p.name : 'PERSON'} CLOCKED IN AD HOC AT ${site.name.toUpperCase()}`, { shift_id: s.id, personnel_id: user.personnel_id });
  return { __status: 201, __body: pub };
});

/* ---- Personal iCal feed — a long unguessable token stands in for a
 * login, the same trust model as a webhook URL, since a calendar client
 * can't carry a session header. See routes-contact.js's Twilio status
 * callback for the only other route in this codebase registered with
 * `null` roles (the one way to skip authFrom() entirely). ---- */
function icsEscape(str) { return String(str || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function icsDate(iso) { return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }
function icsVevent({ uid, stamp, startsAt, endsAt, summary, location, description, status, sequence }) {
  return [
    'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${icsDate(stamp)}`,
    `DTSTART:${icsDate(startsAt)}`, `DTEND:${icsDate(endsAt)}`,
    `SUMMARY:${icsEscape(summary)}`,
    location ? `LOCATION:${icsEscape(location)}` : null,
    description ? `DESCRIPTION:${icsEscape(description)}` : null,
    `STATUS:${status}`, `SEQUENCE:${sequence || 0}`,
    'END:VEVENT',
  ].filter(Boolean).join('\r\n');
}
function buildIcsFeed(name, vevents) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CCCS//Rota//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(name)}`, 'X-PUBLISHED-TTL:PT1H',
    ...vevents, 'END:VCALENDAR',
  ].join('\r\n');
}
route('GET', '/api/me/ical-feed', ALL, ({ req, user }) => {
  const u = db.users.find((x) => x.id === user.id);
  if (!u.ical_token) { u.ical_token = crypto.randomBytes(24).toString('hex'); }
  return { url: `${PUBLIC_BASE_URL}/api/rota/ical/${u.ical_token}.ics` };
});
route('POST', '/api/me/ical-feed/regenerate', ALL, ({ user }) => {
  const u = db.users.find((x) => x.id === user.id);
  u.ical_token = crypto.randomBytes(24).toString('hex');
  logEvent('ical_feed.regenerated', `${u.display_name} REGENERATED THEIR ROTA FEED LINK`, { user_id: u.id });
  return { url: `${PUBLIC_BASE_URL}/api/rota/ical/${u.ical_token}.ics` };
});
// Deliberately `null` roles — see the comment above. The token in the URL
// IS the credential; validation happens here, not in the router.
route('GET', '/api/rota/ical/:token.ics', null, ({ params }) => {
  const u = db.users.find((x) => x.ical_token && x.ical_token === params.token);
  if (!u) throw httpError(404, 'feed not found');
  const now = new Date().toISOString();
  let vevents = [];
  if (isControlRole(u.role)) {
    // A supervisor's/dispatcher's own feed: the whole operation, not just
    // their own assignments — they don't have shift assignments of their own.
    vevents = db.shifts
      .filter((s) => s.status !== 'DRAFT')
      .map((s) => icsVevent({
        uid: `shift-${s.id}@cccs.local`, stamp: now, startsAt: s.starts_at, endsAt: s.ends_at,
        summary: shiftTitle(s), location: s.site_id ? (db.sites.find((x) => x.id === s.site_id) || {}).address : null,
        description: s.briefing || s.notes || '', status: s.status === 'CANCELLED' ? 'CANCELLED' : 'CONFIRMED', sequence: s.revision || 0,
      }));
  } else if (u.personnel_id) {
    vevents = db.shift_assignments
      .filter((a) => a.personnel_id === u.personnel_id)
      .map((a) => ({ a, s: db.shifts.find((x) => x.id === a.shift_id) }))
      .filter((x) => x.s && x.s.status !== 'DRAFT')
      .map(({ a, s }) => icsVevent({
        uid: `shift-${s.id}-assignment-${a.id}@cccs.local`, stamp: now, startsAt: s.starts_at, endsAt: s.ends_at,
        summary: shiftTitle(s), location: s.site_id ? (db.sites.find((x) => x.id === s.site_id) || {}).address : null,
        description: s.briefing || s.notes || '',
        status: (s.status === 'CANCELLED' || ['DECLINED', 'REMOVED'].includes(a.status)) ? 'CANCELLED' : 'CONFIRMED',
        sequence: s.revision || 0,
      }));
  }
  return {
    __body: buildIcsFeed(isControlRole(u.role) ? 'CCCS Rota — All sites' : 'My Rota', vevents),
    __headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'inline; filename="rota.ics"', 'cache-control': 'no-store' },
  };
});
require('./routes-contact.js')({ route, httpError, CONTROL, ADMIN, db, nextId, findPersonnel, logEvent, DIAL_RINGS_OPERATOR_FIRST, sms, ami, flushNow: () => store.flushNow() });

// Breaks, hours, geofenced clock-in, reminders — see routes-attendance.js.
const attendance = require('./routes-attendance.js')({
  route, httpError, ALL, CONTROL, db, logEvent, broadcast, pushToRoles, pushToUsers, sms, notifyLog: writeNotifyLog, publicShift,
  findAssignment, findShift, assertAssignmentAccess, isControlRole, publicBaseUrl: PUBLIC_BASE_URL, flushNow: () => store.flushNow(),
});


// Stock and asset management — see routes-inventory.js.
const inventory = require('./routes-inventory.js')({
  route, httpError, ALL, CONTROL, ADMIN, db, nextId, logEvent, visibleToUser, isControlRole,
  publicAsset, stockLevel, recordStockMovement, ASSET_STATUSES, flushNow: () => store.flushNow(),
});

// Hiring assets out to clients, with signed PDF agreements — see routes-rentals.js.
require('./routes-rentals.js')({ route, httpError, CONTROL, ADMIN, CLIENT, db, nextId, logEvent, UPLOADS_DIR, publicAsset, flushNow: () => store.flushNow() });

// Quotes and contracts on sites, signed in the client portal — see
// routes-agreements.js. Invoices built from signed contracts and hours
// worked, sent to Xero — see routes-invoices.js and xero.js.
// Emails to clients (quotes, contracts, invoices) go through `mailer`, so
// the tests can catch what would have been sent.
const mailer = { send: (to, subject, html, opts) => sendGraphEmail(to, subject, html, opts) };
const agreements = require('./routes-agreements.js')({
  route, httpError, ADMIN, CLIENT, db, nextId, logEvent, pushToRoles, sendEmail: (...a) => mailer.send(...a),
  UPLOADS_DIR, publicBaseUrl: PUBLIC_BASE_URL, flushNow: () => store.flushNow(),
});
const xero = require('./xero.js')({ db, flushNow: () => store.flushNow(), redirectUri: `${PUBLIC_BASE_URL}/api/xero/callback` });
require('./routes-invoices.js')({
  route, httpError, ADMIN, FINANCE, CLIENT, db, nextId, logEvent, attendance, agreements, xero, sendEmail: (...a) => mailer.send(...a), UPLOADS_DIR, publicBaseUrl: PUBLIC_BASE_URL, flushNow: () => store.flushNow(),
});

// Which roles see which section of the menus — see ui-sections.js.
const sections = require('./ui-sections.js')({ route, httpError, ADMIN, db, logEvent, flushNow: () => store.flushNow() });
require('./routes-mobile.js')({ route, httpError, db, sections, visibleToUser });

// Configurable forms. Registrar pattern — see routes-forms.js for why.
const forms = require('./routes-forms.js')({
  route, httpError, ALL, ADMIN, db, nextId, logEvent, broadcast, isControlRole,
  assertJobAccess, assertVisitAccess, pushToUsers, UPLOADS_DIR, MIME, flushNow: () => store.flushNow(),
  applyVehicleReport, reapplyVehicleReport, sendEmail: (to, subject, html) => sendGraphEmail(to, subject, html), publicBaseUrl: PUBLIC_BASE_URL,
  vehicleKit: (id) => inventory.vehicleKit(id), assetEvent: (e) => db.asset_events.push({ id: nextId('asset_events'), ...e }),
});

// Client portal — see routes-client.js for the trust-boundary invariants.
require('./routes-client.js')({
  route, httpError, ALL, CONTROL, ADMIN, CLIENT, db, nextId, logEvent, broadcast, pushToRoles, UPLOADS_DIR, MIME,
  isControlRole, assertPassdownAccess, sendEmail: (...a) => mailer.send(...a), publicBaseUrl: PUBLIC_BASE_URL,
});

// Finance — a read-only view of cost/billing figures. See routes-finance.js.
require('./routes-finance.js')({
  route, httpError, CONTROL, FINANCE, db, siteVisibleTo, visibleToUser, publicFuelLog, publicMaintenanceLog,
});

// The personnel file (documents, and the application of anyone hired
// through Applicants) — see routes-personnel-files.js.
const personnelFiles = require('./routes-personnel-files.js')({ route, httpError, ADMIN, db, logEvent, UPLOADS_DIR, flushNow: () => store.flushNow() });

// Applicant tracking — see routes-applicants.js for the design.
require('./routes-applicants.js')({
  route, httpError, CONTROL, ADMIN, db, nextId, logEvent, UPLOADS_DIR, MIME, visibleToUser, normalizedBranchId, publicPersonnel,
  forms, pushToRoles, flushNow: () => store.flushNow(),
  sendEmail: (to, subject, html) => sendGraphEmail(to, subject, html),
  personnelFiles, publicBaseUrl: PUBLIC_BASE_URL,
});

// Leave management — see routes-leave.js for the design.
require('./routes-leave.js')({
  route, httpError, ALL, CONTROL, db, nextId, logEvent, broadcast, visibleToUser, findPersonnel,
});

// Shift applications — see routes-shift-applications.js for the design.
const shiftApplications = require('./routes-shift-applications.js')({
  route, httpError, ALL, CONTROL, db, nextId, logEvent, broadcast,
  findShift, assignedPersonnelIds, publicShift, siteVisibleTo, isControlRole, notifyShiftEvent, buildShiftIndex,
});

// Vehicle/asset allocation and the stock ledger — see routes-fleet-stock.js.
require('./routes-fleet-stock.js')({
  route, httpError, ALL, CONTROL, ADMIN, db, nextId, logEvent,
  findShift, publicVehicleAllocation, publicAssetAllocation, publicAsset, stockLevel, recordStockMovement,
});

// Fleet dashboard — see routes-fleet-dashboard.js.
require('./routes-fleet-dashboard.js')({ route, CONTROL, db, forms, visibleToUser, publicVehicle, vehicleKit: (id) => inventory.vehicleKit(id) });

/* Client reporting — proving service to whoever pays for the contract:
 * patrol visit counts, alarm response time against the site's own SLA (if
 * one is set), and incident reports for the period. Incident visibility
 * goes through forms.canRead() like every other read of a submission — a
 * RESTRICTED safeguarding report doesn't become visible just because it's
 * being rolled up into a site total. Defaults to the last 30 days. */
route('GET', '/api/sites/:id/report', CONTROL, ({ params, query, user }) => {
  const site = db.sites.find((x) => x.id === Number(params.id));
  if (!site) throw httpError(404, 'site not found');

  const to = query.get('to') ? new Date(query.get('to')) : new Date();
  const from = query.get('from') ? new Date(query.get('from')) : new Date(to.getTime() - 30 * 86400000);
  if (isNaN(from.getTime()) || isNaN(to.getTime())) throw httpError(400, 'invalid from/to date');
  const inRange = (iso) => { const t = Date.parse(iso); return !isNaN(t) && t >= from.getTime() && t <= to.getTime(); };

  const jobs = db.jobs.filter((j) => j.site_id === site.id && inRange(j.created_at));
  const visits = db.site_visits.filter((v) => v.site_id === site.id && inRange(v.scheduled_for));

  const responseMinutes = jobs.filter((j) => j.on_scene_at).map((j) => (Date.parse(j.on_scene_at) - Date.parse(j.created_at)) / 60000);
  const avgResponseMinutes = responseMinutes.length ? Math.round((responseMinutes.reduce((a, b) => a + b, 0) / responseMinutes.length) * 10) / 10 : null;

  const jobIds = new Set(jobs.map((j) => j.id));
  const visitIds = new Set(visits.map((v) => v.id));
  const incidents = db.form_submissions
    .filter((s) => inRange(s.submitted_at))
    .filter((s) => (s.subject_type === 'SITE' && s.subject_id === site.id)
      || (s.subject_type === 'JOB' && jobIds.has(s.subject_id))
      || (s.subject_type === 'SITE_VISIT' && visitIds.has(s.subject_id)))
    .filter((s) => forms.canRead(s, user))
    .sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : -1))
    .map((s) => ({
      id: s.id, reference: s.reference, definition_name: s.definition_name,
      visibility: forms.effectiveVisibility(s), subject_type: s.subject_type,
      submitted_by: s.submitted_by_name, submitted_at: s.submitted_at,
    }));

  return {
    site: { id: site.id, name: site.name, address: site.address },
    from: from.toISOString(), to: to.toISOString(),
    jobs: {
      total: jobs.length,
      completed: jobs.filter((j) => j.status === 'COMPLETED').length,
      cancelled: jobs.filter((j) => j.status === 'CANCELLED').length,
      avg_response_minutes: avgResponseMinutes,
      sla_minutes: site.response_sla_minutes || null,
      within_sla: site.response_sla_minutes ? responseMinutes.filter((m) => m <= site.response_sla_minutes).length : null,
    },
    visits: {
      total: visits.length,
      completed: visits.filter((v) => v.status === 'COMPLETED').length,
      missed: visits.filter((v) => v.status === 'MISSED').length,
      cancelled: visits.filter((v) => v.status === 'CANCELLED').length,
    },
    incidents,
  };
});

route('GET', '/api/config', ALL, () => ({
  audio: process.env.AUDIO !== 'off',
  foot_tracking: process.env.FOOT_TRACKING === 'on',
}));

route('GET', '/api/openapi.json', null, () => require('./openapi.json'));

// Admin: users
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function normalizeEmail(raw, { forId } = {}) {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  const email = String(raw).toLowerCase().trim();
  if (!EMAIL_RE.test(email)) throw httpError(400, 'not a valid email address');
  if (db.users.some((u) => u.id !== forId && u.email === email)) throw httpError(409, 'that email is already linked to another account');
  return email;
}

route('GET', '/api/users', ADMIN, () => db.users.map(publicUser));
route('POST', '/api/users', ADMIN, ({ body }) => {
  const username = String(body.username || '').toLowerCase().trim();
  if (!username || !body.password) throw httpError(400, 'username and password required');
  if (String(body.password).length < 8) throw httpError(400, 'password must be at least 8 characters');
  if (!ROLES.includes(body.role)) throw httpError(400, 'invalid role');
  if (db.users.some((u) => u.username === username)) throw httpError(409, 'username taken');
  const email = normalizeEmail(body.email) ?? null;
  const personnelId = body.personnel_id || null;
  if (personnelId && db.personnel.some((p) => p.id === personnelId && p.user_id)) throw httpError(409, 'that personnel record already has a login');
  const clientId = body.client_id || null;
  if (clientId && !db.clients.some((c) => c.id === clientId)) throw httpError(400, 'client_id must reference an existing client');
  const u = { id: nextId('users'), username, password_hash: hashPassword(String(body.password)), role: body.role, display_name: body.display_name || username, personnel_id: personnelId, mdt_id: body.mdt_id || null, client_id: clientId, branch_id: normalizedBranchId(body.branch_id), site_ids: normalizedSiteIds(body.site_ids), email, created_at: new Date().toISOString() };
  db.users.push(u);
  if (personnelId) { const p = db.personnel.find((x) => x.id === personnelId); if (p) p.user_id = u.id; }
  logEvent('user.created', `USER ${username} CREATED (${u.role})`);
  return { __status: 201, __body: { id: u.id, username: u.username, role: u.role } };
});
route('PATCH', '/api/users/:id', ADMIN, ({ params, body }) => {
  const u = db.users.find((x) => x.id === Number(params.id));
  if (!u) throw httpError(404, 'user not found');
  if ('email' in body) u.email = normalizeEmail(body.email, { forId: u.id });
  if ('display_name' in body) u.display_name = String(body.display_name || '').trim() || u.username;
  if ('role' in body) {
    if (!ROLES.includes(body.role)) throw httpError(400, 'invalid role');
    u.role = body.role;
  }
  if ('personnel_id' in body) {
    const nextPersonnelId = body.personnel_id || null;
    if (nextPersonnelId && db.personnel.some((p) => p.id === nextPersonnelId && p.user_id && p.user_id !== u.id)) {
      throw httpError(409, 'that personnel record already has a login');
    }
    if (u.personnel_id && u.personnel_id !== nextPersonnelId) {
      const prev = db.personnel.find((p) => p.id === u.personnel_id);
      if (prev && prev.user_id === u.id) prev.user_id = null;
    }
    if (nextPersonnelId) { const p = db.personnel.find((x) => x.id === nextPersonnelId); if (p) p.user_id = u.id; }
    u.personnel_id = nextPersonnelId;
  }
  if ('mdt_id' in body) u.mdt_id = body.mdt_id || null;
  if ('client_id' in body) {
    const nextClientId = body.client_id || null;
    if (nextClientId && !db.clients.some((c) => c.id === nextClientId)) throw httpError(400, 'client_id must reference an existing client');
    u.client_id = nextClientId;
  }
  if ('branch_id' in body) u.branch_id = normalizedBranchId(body.branch_id);
  if ('site_ids' in body) u.site_ids = normalizedSiteIds(body.site_ids);
  if ('password' in body && body.password) {
    if (String(body.password).length < 8) throw httpError(400, 'password must be at least 8 characters');
    u.password_hash = hashPassword(String(body.password));
  }
  logEvent('user.updated', `USER ${u.username} UPDATED`, { user_id: u.id });
  return publicUser(u);
});
route('DELETE', '/api/users/:id', ADMIN, ({ params, user }) => {
  const u = db.users.find((x) => x.id === Number(params.id));
  if (!u) throw httpError(404, 'user not found');
  if (u.id === user.id) throw httpError(400, 'cannot delete the account you are signed in as');
  if (u.personnel_id) { const p = db.personnel.find((x) => x.id === u.personnel_id); if (p && p.user_id === u.id) p.user_id = null; }
  db.users = db.users.filter((x) => x.id !== u.id);
  logEvent('user.deleted', `USER ${u.username} DELETED`, { user_id: u.id });
  return { ok: true };
});

/* Branches — see the comment on BRANCH_SCOPED_ROLES for what this does and
 * doesn't restrict. Read is open to ALL (a name is not sensitive, and every
 * scoped role needs the list for its own branch's label); only ADMIN
 * manages the branches themselves. */
route('GET', '/api/branches', ALL, () => db.branches);
route('POST', '/api/branches', ADMIN, ({ body }) => {
  const name = String(body.name || '').trim();
  if (!name) throw httpError(400, 'name required');
  if (db.branches.some((b) => b.name.toLowerCase() === name.toLowerCase())) throw httpError(409, 'branch already exists');
  const b = { id: nextId('branches'), name, created_at: new Date().toISOString() };
  db.branches.push(b);
  logEvent('branch.created', `BRANCH ${name} ADDED`);
  return { __status: 201, __body: b };
});
route('PATCH', '/api/branches/:id', ADMIN, ({ params, body }) => {
  const b = db.branches.find((x) => x.id === Number(params.id));
  if (!b) throw httpError(404, 'branch not found');
  if ('name' in body) {
    const name = String(body.name || '').trim();
    if (!name) throw httpError(400, 'name required');
    if (db.branches.some((x) => x.id !== b.id && x.name.toLowerCase() === name.toLowerCase())) throw httpError(409, 'branch already exists');
    b.name = name;
  }
  logEvent('branch.updated', `BRANCH ${b.name} UPDATED`, { branch_id: b.id });
  return b;
});
route('DELETE', '/api/branches/:id', ADMIN, ({ params }) => {
  const b = db.branches.find((x) => x.id === Number(params.id));
  if (!b) throw httpError(404, 'branch not found');
  const inUse = db.sites.some((s) => s.branch_id === b.id) || db.personnel.some((p) => p.branch_id === b.id)
    || db.vehicles.some((v) => v.branch_id === b.id) || db.assets.some((a) => a.branch_id === b.id)
    || db.users.some((u) => u.branch_id === b.id);
  if (inUse) throw httpError(409, 'branch is still in use — reassign its sites, personnel, vehicles, assets and accounts first');
  db.branches = db.branches.filter((x) => x.id !== b.id);
  logEvent('branch.deleted', `BRANCH ${b.name} DELETED`);
  return { ok: true };
});

/* ------------------------------------------------------------------ *
 * Training — a hybrid of the SIA/DBS "record what happened" pattern and
 * actual in-app delivery. A course is either logged externally (a
 * classroom session, a toolbox talk — admin records that it happened) or
 * taken in-app: officer reads `material`, answers a short multiple-choice
 * assessment if the course has one, and a training_records row is created
 * either way. training_records is append-only, like dial_log — the
 * current status is always derived from the most recent one, never
 * mutated in place, so a course's real history survives a retake.
 *
 * No versioning on course edits, unlike form_definitions: a quiz's
 * content changing later doesn't need the audit fidelity a restricted
 * safeguarding report does, so this is a deliberate v1 simplification, not
 * an oversight. A course is retired via `active: false`, never deleted —
 * training_records must always be able to resolve their course_id.
 * ------------------------------------------------------------------ */
function validQuestions(qs) {
  if (!Array.isArray(qs) || !qs.length) return false;
  return qs.every((q) => q && typeof q.text === 'string' && q.text.trim()
    && Array.isArray(q.options) && q.options.length >= 2 && q.options.every((o) => typeof o === 'string' && o.trim())
    && Number.isInteger(q.correct_index) && q.correct_index >= 0 && q.correct_index < q.options.length);
}
const normalizeQuestions = (qs) => qs.map((q) => ({ id: q.id || crypto.randomUUID(), text: String(q.text).trim(), options: q.options.map((o) => String(o).trim()), correct_index: q.correct_index }));
/** Strips answers for anyone who isn't managing the course — an officer
 * about to take the assessment must not receive correct_index in the
 * response, any more than an exam paper comes with the mark scheme
 * stapled to it. */
function publicCourse(c, user) {
  const isAdmin = user.role === 'SYSTEM_ADMIN';
  return {
    id: c.id, name: c.name, category: c.category, description: c.description,
    validity_months: c.validity_months, has_assessment: c.has_assessment,
    pass_mark_pct: c.pass_mark_pct, material: c.material, active: c.active,
    questions: c.has_assessment ? c.questions.map((q) => (isAdmin ? q : { id: q.id, text: q.text, options: q.options })) : [],
  };
}
route('GET', '/api/training-courses', ALL, ({ query, user }) => {
  const showAll = query.get('all') === '1' && user.role === 'SYSTEM_ADMIN';
  return db.training_courses.filter((c) => showAll || c.active).map((c) => publicCourse(c, user));
});
route('POST', '/api/training-courses', ADMIN, ({ body, user }) => {
  const name = String(body.name || '').trim();
  if (!name) throw httpError(400, 'name required');
  const hasAssessment = Boolean(body.has_assessment);
  if (hasAssessment && !validQuestions(body.questions)) {
    throw httpError(400, 'a course with an assessment needs at least one question, each with 2+ options and a valid correct_index');
  }
  const c = {
    id: nextId('training_courses'), name, category: String(body.category || '').trim(),
    description: String(body.description || '').trim(), material: String(body.material || '').trim(),
    validity_months: body.validity_months ? Number(body.validity_months) : null,
    has_assessment: hasAssessment, questions: hasAssessment ? normalizeQuestions(body.questions) : [],
    pass_mark_pct: hasAssessment ? Number(body.pass_mark_pct || 80) : null,
    active: true, created_at: new Date().toISOString(),
  };
  db.training_courses.push(c);
  logEvent('training_course.created', `TRAINING COURSE ${name} ADDED`);
  return { __status: 201, __body: publicCourse(c, user) };
});
route('PATCH', '/api/training-courses/:id', ADMIN, ({ params, body, user }) => {
  const c = db.training_courses.find((x) => x.id === Number(params.id));
  if (!c) throw httpError(404, 'training course not found');
  if ('name' in body) { const name = String(body.name || '').trim(); if (!name) throw httpError(400, 'name required'); c.name = name; }
  if ('category' in body) c.category = String(body.category || '').trim();
  if ('description' in body) c.description = String(body.description || '').trim();
  if ('material' in body) c.material = String(body.material || '').trim();
  if ('validity_months' in body) c.validity_months = body.validity_months ? Number(body.validity_months) : null;
  if ('has_assessment' in body) c.has_assessment = Boolean(body.has_assessment);
  if ('questions' in body || 'has_assessment' in body) {
    if (c.has_assessment) {
      if (!validQuestions(body.questions || c.questions)) throw httpError(400, 'a course with an assessment needs at least one valid question');
      c.questions = normalizeQuestions(body.questions || c.questions);
    } else c.questions = [];
  }
  if ('pass_mark_pct' in body) c.pass_mark_pct = c.has_assessment ? Number(body.pass_mark_pct || 80) : null;
  if ('active' in body) c.active = Boolean(body.active);
  logEvent('training_course.updated', `TRAINING COURSE ${c.name} UPDATED`, { training_course_id: c.id });
  return publicCourse(c, user);
});

/** An officer completing their own course — the in-app half of the hybrid.
 * Scored server-side only: the client never has correct_index to begin
 * with, but this also means a replayed/tampered `passed` claim from the
 * client is simply never consulted. */
route('POST', '/api/training-courses/:id/complete', ALL, ({ params, body, user }) => {
  const c = db.training_courses.find((x) => x.id === Number(params.id) && x.active);
  if (!c) throw httpError(404, 'training course not found');
  if (!user.personnel_id) throw httpError(403, 'this login has no personnel record to record training against');
  const p = db.personnel.find((x) => x.id === user.personnel_id);
  if (!p) throw httpError(403, 'this login has no personnel record to record training against');

  let scorePct = null;
  if (c.has_assessment) {
    const answers = Array.isArray(body.answers) ? body.answers : [];
    if (answers.length !== c.questions.length) throw httpError(400, `expected ${c.questions.length} answers`);
    const correct = c.questions.filter((q, i) => Number(answers[i]) === q.correct_index).length;
    scorePct = Math.round((correct / c.questions.length) * 100);
    if (scorePct < c.pass_mark_pct) throw httpError(400, `score ${scorePct}% is below the ${c.pass_mark_pct}% pass mark — no record created, try again`);
  }
  const r = {
    id: nextId('training_records'), personnel_id: p.id, course_id: c.id, method: 'IN_APP',
    completed_at: new Date().toISOString(), score_pct: scorePct, recorded_by: null,
  };
  db.training_records.push(r);
  logEvent('training.completed', `${p.name} COMPLETED ${c.name}${scorePct != null ? ` (${scorePct}%)` : ''}`, { personnel_id: p.id, training_course_id: c.id });
  return { __status: 201, __body: { ...r, training: trainingStatusForPerson(p.id) } };
});

/** Admin logging a completion that happened outside CCCS — a classroom
 * session, a toolbox talk, a certificate someone brought in. */
route('POST', '/api/personnel/:id/training-records', ADMIN, ({ params, body, user }) => {
  const p = findPersonnel(params.id); if (!p) throw httpError(404, 'personnel not found');
  const c = db.training_courses.find((x) => x.id === Number(body.course_id));
  if (!c) throw httpError(400, 'course_id must reference an existing course');
  const r = {
    id: nextId('training_records'), personnel_id: p.id, course_id: c.id, method: 'LOGGED',
    completed_at: body.completed_at ? new Date(body.completed_at).toISOString() : new Date().toISOString(),
    score_pct: body.score_pct != null && body.score_pct !== '' ? Number(body.score_pct) : null,
    recorded_by: user.display_name,
  };
  if (isNaN(Date.parse(r.completed_at))) throw httpError(400, 'invalid completed_at');
  db.training_records.push(r);
  logEvent('training.logged', `${p.name} — ${c.name} LOGGED BY ${user.username}`, { personnel_id: p.id, training_course_id: c.id });
  return { __status: 201, __body: { ...r, training: trainingStatusForPerson(p.id) } };
});
route('GET', '/api/personnel/:id/training-records', ALL, ({ params, user }) => {
  const p = findPersonnel(params.id); if (!p) throw httpError(404, 'personnel not found');
  if (!isControlRole(user.role) && user.personnel_id !== p.id) throw httpError(403, 'not your training record');
  return db.training_records.filter((r) => r.personnel_id === p.id)
    .sort((a, b) => (a.completed_at < b.completed_at ? 1 : -1))
    .map((r) => ({ ...r, course_name: (db.training_courses.find((c) => c.id === r.course_id) || {}).name || 'Unknown course' }));
});

/* ------------------------------------------------------------------ *
 * GPS simulation
 * ------------------------------------------------------------------ */
function simulationTick() {
  for (const m of db.mdts) {
    if (!m.connected || m.lat == null || m.lon == null) continue;
    const job = m.job_id ? db.jobs.find((j) => j.id === m.job_id) : null;
    let target = m.sim_target;
    if (job && ['DISPATCHED', 'ACKNOWLEDGED', 'EN_ROUTE'].includes(job.status)) target = { lat: job.lat, lon: job.lon };
    if (!target || Math.hypot(target.lat - m.lat, target.lon - m.lon) < 0.0006) {
      target = { lat: 51.5074 + (Math.random() - 0.5) * 0.08, lon: -0.1278 + (Math.random() - 0.5) * 0.10 };
      m.sim_target = target;
    }
    const dLat = target.lat - m.lat, dLon = target.lon - m.lon;
    const dist = Math.hypot(dLat, dLon) || 1;
    const step = Math.min(dist, 0.00035 + Math.random() * 0.0004);
    m.lat += (dLat / dist) * step; m.lon += (dLon / dist) * step;
    if (Math.random() < 0.05) m.battery = Math.max(5, m.battery - 1);
    const at = new Date().toISOString();
    db.locations.push({ id: nextId('locations'), mdt_id: m.id, personnel_id: null, lat: m.lat, lon: m.lon, speed: null, heading: null, at });
    if (db.locations.length > 20000) db.locations.shift();
    broadcast('mdt.status_changed', publicMdt(m));
  }
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
function start() {
  const restored = store.load();
  if (restored) console.log(`[cccs] state restored from ${store.file}`);
  else { seed(); store.flushNow(); }
  // Additive and idempotent: installs the standard forms only on a database
  // that has none, so an existing deployment gets them on first boot of this
  // version and an admin's own edits are never overwritten.
  const installed = forms.installDefaults();
  if (installed) { logEvent('form.defaults_installed', `${installed} STANDARD FORMS INSTALLED`); store.flushNow(); }
  if (forms.ensureApplicationForm()) { logEvent('form.defaults_installed', 'PUBLIC JOB APPLICATION FORM INSTALLED'); store.flushNow(); }
  const vehicleForms = forms.ensureVehicleForms();
  if (vehicleForms) { logEvent('form.defaults_installed', `${vehicleForms} FORM(S) INSTALLED (FUEL-UP / DEEP CLEAN / INCIDENT / USE OF FORCE)`); store.flushNow(); }
  // Same additive-and-idempotent shape as forms.installDefaults() — runs
  // once, only while the table is empty, so an admin's own edits (renaming
  // one, adding a sixth) are never overwritten on a later boot.
  if (db.shift_types.length === 0) {
    const defaults = [
      ['CONTROL_ROOM', 'Control Room', '#2563eb'], ['MOBILE_PATROL', 'Mobile Patrol', '#059669'],
      ['ALARM_RESPONSE', 'Alarm Response', '#dc2626'], ['EVENT', 'Event', '#7c3aed'],
      ['STATIC_GUARD', 'Static Guard', '#d97706'],
      // Not one of the five named kinds — exists so a shift that doesn't fit
      // (and the shift migration's fallback for old free-text role_type) has
      // somewhere to land, not a forced guess at which real type it meant.
      ['GENERAL', 'General', '#6b7280'],
    ];
    for (const [key, name, color] of defaults) db.shift_types.push({ id: nextId('shift_types'), key, name, color, active: true, created_at: new Date().toISOString() });
    logEvent('shift_type.defaults_installed', `${defaults.length} DEFAULT SHIFT TYPES INSTALLED`);
    store.flushNow();
  }
  if (SIMULATION) setInterval(simulationTick, 2000).unref?.();
  setInterval(welfareTick, WELFARE_TICK_MS).unref?.();
  patrolScheduleTick();
  setInterval(patrolScheduleTick, PATROL_SCHEDULE_TICK_MS).unref?.();
  if (process.env.RETENTION !== 'off') {
    retentionSweep();
    setInterval(retentionSweep, 6 * 60 * 60 * 1000).unref?.();
  }
  server.listen(PORT, HOST, () => {
    console.log(`\n  CCCS POC — simulation only, not for operational use`);
    console.log(`  Control Room : http://localhost:${PORT}/control.html`);
    console.log(`  MDT          : http://localhost:${PORT}/mdt.html`);
    console.log(`  Demo logins  : dispatcher/dispatch123 · dwhitfield/field123 · mdt001/mdt123 · admin/admin123`);
    console.log(`  Storage      : ${store.enabled ? store.file : 'in memory only (PERSISTENCE=off)'}`);
    console.log(`  Microsoft SSO: ${MS_ENABLED ? 'enabled (tenant ' + MS_TENANT_ID + ')' : 'not configured — set MS_TENANT_ID/MS_CLIENT_ID/MS_CLIENT_SECRET/MS_REDIRECT_URI'}\n`);
  });
  if (httpsServer) {
    const tlsPort = Number(process.env.TLS_PORT || 443);
    // Never let a problem with this secondary listener (e.g. permission to
    // bind a low port) take down the primary HTTP server the edge depends on.
    httpsServer.on('error', (e) => console.error(`  Direct HTTPS listener failed to start (${e.code || e.message}) — continuing on HTTP only`));
    // '::' not HOST -- HOST defaults to the IPv4-only 0.0.0.0 for the
    // edge-facing HTTP server above; this listener's only job is serving
    // the IPv6 clients that bypass the edge, so it needs the IPv6 wildcard.
    const tlsHost = process.env.TLS_HOST || '::';
    httpsServer.listen(tlsPort, tlsHost, () => console.log(`  Direct HTTPS : https://comms.echeloncic.com:${tlsPort} (IPv6 clients, bypasses the edge)`));
  }
}

if (require.main === module) start();
module.exports = { server, db, seq, store, start, seed, forms, attendance, mailer, retentionSweep, patrolScheduleTick, RETENTION, hashPassword, verifyPassword, sign, PORT };
