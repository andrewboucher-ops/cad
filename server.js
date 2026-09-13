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
const SIMULATION = process.env.SIMULATION !== 'off';

const MS_TENANT_ID = process.env.MS_TENANT_ID || '';
const MS_CLIENT_ID = process.env.MS_CLIENT_ID || '';
const MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET || '';
const MS_REDIRECT_URI = process.env.MS_REDIRECT_URI || '';
const MS_ENABLED = Boolean(MS_TENANT_ID && MS_CLIENT_ID && MS_CLIENT_SECRET && MS_REDIRECT_URI);
const { verifyMicrosoftIdToken } = require('./msauth.js');
const webpush = require('./webpush.js');
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
  users: [], radios: [], mdts: [], callsigns: [], vehicles: [], personnel: [], sites: [],
  talkgroups: [], talkgroup_members: [], jobs: [], job_assignments: [],
  communications: [], communication_participants: [], messages: [], call_requests: [],
  locations: [], radio_status_history: [], emergency_events: [], audit_logs: [],
  push_subscriptions: [],
};
const seq = {};
const nextId = (t) => (seq[t] = (seq[t] || 0) + 1);

const RADIO_STATUSES = ['OFFLINE', 'AVAILABLE', 'BUSY', 'ON_TASK', 'EN_ROUTE', 'ON_SCENE', 'EMERGENCY', 'OUT_OF_SERVICE'];
const JOB_STATES = ['CREATED', 'DISPATCHED', 'ACKNOWLEDGED', 'EN_ROUTE', 'ON_SCENE', 'TRANSPORTING', 'COMPLETED', 'CANCELLED'];
// First time a job reaches each of these, stamp it — this is what "time
// en route" / "time on scene" is computed from client-side, with no separate
// tracking mechanism to keep in sync.
const JOB_STATUS_TS_FIELD = { DISPATCHED: 'dispatched_at', ACKNOWLEDGED: 'acknowledged_at', EN_ROUTE: 'en_route_at', ON_SCENE: 'on_scene_at', TRANSPORTING: 'transporting_at', COMPLETED: 'completed_at', CANCELLED: 'cancelled_at' };
function stampJobStatus(j, status) {
  const field = JOB_STATUS_TS_FIELD[status];
  if (field && !j[field]) j[field] = new Date().toISOString();
}
const PRIORITIES = ['RED', 'AMBER', 'GREEN', 'ROUTINE'];
const ROLES = ['SYSTEM_ADMIN', 'DISPATCHER', 'SUPERVISOR', 'RADIO_USER', 'MDT_USER'];

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

const findRadio = (idOrIssi) =>
  db.radios.find((r) => r.id === Number(idOrIssi) || r.issi === String(idOrIssi)) || null;
const findCallsign = (v) =>
  db.callsigns.find((c) => c.id === Number(v) || c.name === String(v).toUpperCase()) || null;
const findTalkgroup = (v) =>
  db.talkgroups.find((t) => t.id === Number(v) || t.name === String(v).toUpperCase()) || null;
const findMdt = (v) =>
  db.mdts.find((m) => m.id === Number(v) || m.mdt_code === String(v).toUpperCase()) || null;

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
  const byName = { vehicles: new Map(), talkgroups: new Map(), callsigns: new Map(), radios: new Map(), mdts: new Map() };

  for (const st of raw.sites || []) {
    db.sites.push({ id: nextId('sites'), name: st.name, address: st.address || '', lat: st.lat ?? null, lon: st.lon ?? null, keyholder: st.keyholder || '', contract: 'ACTIVE' });
  }
  for (const v of raw.vehicles || []) {
    const rec = { id: nextId('vehicles'), registration: v.registration, type: v.type || 'Vehicle' };
    db.vehicles.push(rec); byName.vehicles.set(v.registration, rec);
  }
  for (const t of raw.talkgroups || []) {
    const rec = { id: nextId('talkgroups'), name: String(t.name).toUpperCase(), description: t.description || '', floor_holder_radio_id: null, floor_console_user_id: null, floor_since: null };
    db.talkgroups.push(rec); byName.talkgroups.set(rec.name, rec);
  }
  for (const cs of raw.callsigns || []) {
    const name = String(cs.name).toUpperCase();
    const rec = { id: nextId('callsigns'), name, description: cs.description || '', active: true };
    db.callsigns.push(rec); byName.callsigns.set(name, rec);
    const vehicle = cs.vehicle ? byName.vehicles.get(cs.vehicle) : null;

    for (const person of cs.personnel || []) {
      db.personnel.push({ id: nextId('personnel'), name: person, rank: '', callsign_id: rec.id });
    }
    for (const r of cs.radios || []) {
      const issi = String(r.issi);
      if (db.radios.some((x) => x.issi === issi)) throw new Error(`duplicate ISSI ${issi} in seed file`);
      const tg = r.talkgroup ? byName.talkgroups.get(String(r.talkgroup).toUpperCase()) : null;
      const radio = {
        id: nextId('radios'), issi, alias: r.alias || `${name} RADIO`,
        radio_type: String(r.type || 'HANDHELD').toUpperCase(), status: 'OFFLINE',
        callsign_id: rec.id, vehicle_id: vehicle ? vehicle.id : null,
        talkgroup_id: tg ? tg.id : null, job_id: null, assigned_user_id: null,
        battery: 100, signal: 'UNKNOWN', lat: r.lat ?? 51.5074, lon: r.lon ?? -0.1278,
        speed: 0, heading: 0, last_seen: null, emergency: false, connected: false, sim_target: null,
        pbx_extension: r.pbx_extension || null,
        welfare_interval_s: null, welfare_due_at: null, welfare_warned: false,
      };
      db.radios.push(radio); byName.radios.set(issi, radio);
      if (tg) db.talkgroup_members.push({ id: nextId('talkgroup_members'), talkgroup_id: tg.id, radio_id: radio.id });
    }
    for (const m of cs.mdts || []) {
      const mdt = { id: nextId('mdts'), mdt_code: String(m.code).toUpperCase(), serial: m.serial || m.code, callsign_id: rec.id, vehicle_id: vehicle ? vehicle.id : null, status: 'OFFLINE', duty_status: 'AVAILABLE', job_id: null, battery: 100, network: 'LTE', operator: null, lat: null, lon: null, connected: false, crew: [] };
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
    const radio = u.radio ? byName.radios.get(String(u.radio)) : null;
    const mdt = u.mdt ? byName.mdts.get(String(u.mdt).toUpperCase()) : null;
    db.users.push({
      id: nextId('users'), username, password_hash: hashPassword(String(u.password)),
      role: u.role, display_name: u.display_name || username,
      radio_id: radio ? radio.id : null, mdt_id: mdt ? mdt.id : null,
      email: u.email ? String(u.email).toLowerCase() : null,
      created_at: new Date().toISOString(),
    });
  }

  logEvent('system.seeded', `Loaded ${db.callsigns.length} call signs, ${db.radios.length} radios and ${db.sites.length} sites from ${path.basename(file)}`);
}

function seed() {
  const seedFile = process.env.SEED_FILE || path.join(__dirname, 'seed.json');
  if (fs.existsSync(seedFile)) {
    console.log(`[cccs] seeding from ${seedFile}`);
    return seedFromFile(seedFile);
  }
  console.warn('[cccs] no seed.json found — loading demo data. Copy seed.example.json to seed.json for your own call signs.');
  const mkUser = (username, password, role, extra = {}) => {
    const u = { id: nextId('users'), username, password_hash: hashPassword(password), role, display_name: extra.display_name || username, radio_id: null, mdt_id: null, created_at: new Date().toISOString(), ...extra };
    db.users.push(u); return u;
  };
  const mkVehicle = (reg, type) => { const v = { id: nextId('vehicles'), registration: reg, type }; db.vehicles.push(v); return v; };
  const mkCallsign = (name, desc) => { const c = { id: nextId('callsigns'), name, description: desc, active: true }; db.callsigns.push(c); return c; };
  const mkPerson = (name, rank, callsign_id) => { const p = { id: nextId('personnel'), name, rank, callsign_id }; db.personnel.push(p); return p; };
  const mkTalkgroup = (name, desc) => { const t = { id: nextId('talkgroups'), name, description: desc, floor_holder_radio_id: null, floor_since: null }; db.talkgroups.push(t); return t; };

  const LON = { lat: 51.5074, lon: -0.1278 };
  const mkRadio = (issi, alias, type, callsign_id, vehicle_id, tg_id, jitter) => {
    if (db.radios.some((r) => r.issi === issi)) throw new Error('duplicate ISSI in seed');
    const r = {
      id: nextId('radios'), issi, alias, radio_type: type, status: 'OFFLINE',
      callsign_id, vehicle_id, talkgroup_id: tg_id, job_id: null,
      assigned_user_id: null, battery: 70 + Math.floor(Math.random() * 30),
      signal: 'EXCELLENT', lat: LON.lat + jitter[0], lon: LON.lon + jitter[1],
      speed: 0, heading: Math.floor(Math.random() * 360), last_seen: null,
      emergency: false, connected: false, sim_target: null,
      pbx_extension: String(9000 + seq.radios),
      welfare_interval_s: null, welfare_due_at: null, welfare_warned: false,
    };
    db.radios.push(r);
    if (tg_id) db.talkgroup_members.push({ id: nextId('talkgroup_members'), talkgroup_id: tg_id, radio_id: r.id });
    return r;
  };
  const mkMdt = (code, serial, callsign_id, vehicle_id) => {
    const m = { id: nextId('mdts'), mdt_code: code, serial, callsign_id, vehicle_id, status: 'OFFLINE', duty_status: 'AVAILABLE', job_id: null, battery: 80 + Math.floor(Math.random() * 20), network: 'LTE', operator: null, lat: null, lon: null, connected: false, crew: [] };
    db.mdts.push(m); return m;
  };

  const mkSite = (name, address, lat, lon, keyholder) => {
    const st = { id: nextId('sites'), name, address, lat, lon, keyholder, contract: 'ACTIVE' };
    db.sites.push(st); return st;
  };

  const tgPatrol1 = mkTalkgroup('PATROL 1', 'Mobile patrol, north sector');
  const tgPatrol2 = mkTalkgroup('PATROL 2', 'Mobile patrol, south sector');
  mkTalkgroup('SUPERVISORS', 'Duty and area supervisors');
  mkTalkgroup('CONTROL', 'Control room net');
  mkTalkgroup('INCIDENT', 'Incident and alarm response');

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

  mkPerson('Dan Whitfield', 'Patrol officer', p101.id);
  mkPerson('Sam Oduya', 'Patrol officer', p101.id);
  mkPerson('Ellie Marsh', 'Patrol officer', p102.id);
  mkPerson('Ryan Cole', 'Response officer', p103.id);

  const r1 = mkRadio('234100001', 'P101 HANDHELD', 'HANDHELD', p101.id, v1.id, tgPatrol1.id, [0.010, 0.012]);
  const r2 = mkRadio('234100002', 'P102 HANDHELD', 'HANDHELD', p102.id, v2.id, tgPatrol1.id, [-0.014, 0.021]);
  const r3 = mkRadio('234100003', 'P103 VEHICLE', 'VEHICLE', p103.id, v3.id, tgPatrol1.id, [0.019, -0.017]);
  mkRadio('234100004', 'P104 HANDHELD', 'HANDHELD', p104.id, null, tgPatrol1.id, [-0.021, -0.009]);
  mkRadio('234100005', 'M201 VEHICLE', 'VEHICLE', m201.id, v4.id, tgPatrol2.id, [0.027, 0.030]);
  mkRadio('234100006', 'M202 HANDHELD', 'HANDHELD', m202.id, null, tgPatrol2.id, [-0.030, 0.026]);

  const m1 = mkMdt('MDT-001', 'SN-MDT-0001', p101.id, v1.id);
  mkMdt('MDT-002', 'SN-MDT-0002', p102.id, v2.id);
  mkMdt('MDT-003', 'SN-MDT-0003', p103.id, v3.id);

  mkUser('admin', 'admin123', 'SYSTEM_ADMIN', { display_name: 'System Admin' });
  mkUser('dispatcher', 'dispatch123', 'DISPATCHER', { display_name: 'Controller Hale' });
  mkUser('supervisor', 'super123', 'SUPERVISOR', { display_name: 'Supervisor Reid' });
  mkUser('radio101', 'radio123', 'RADIO_USER', { display_name: 'Dan Whitfield', radio_id: r1.id });
  mkUser('radio102', 'radio123', 'RADIO_USER', { display_name: 'Ellie Marsh', radio_id: r2.id });
  mkUser('radio103', 'radio123', 'RADIO_USER', { display_name: 'Ryan Cole', radio_id: r3.id });
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
function encodeFrame(str, opcode = 0x1) {
  const payload = Buffer.from(str);
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
    this.radioId = null; this.mdtId = null;
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
    if (this.radioId && !Array.from(sockets).some((c) => c.radioId === this.radioId)) {
      const r = db.radios.find((x) => x.id === this.radioId);
      if (r) { r.connected = false; setRadioStatus(r, 'OFFLINE', 'link lost'); releaseFloorFor(r); }
    }
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

/* Peer addressing for WebRTC signalling: 'radio:<ISSI>' or 'conn:<uuid>'. */
function peerAddr(conn) {
  if (conn.radioId) {
    const r = db.radios.find((x) => x.id === conn.radioId);
    if (r) return `radio:${r.issi}`;
  }
  return `conn:${conn.id}`;
}
function resolvePeers(addr) {
  if (!addr || typeof addr !== 'string') return [];
  const [kind, value] = addr.split(':');
  if (kind === 'radio') {
    const r = findRadio(value);
    return r ? [...sockets].filter((c) => c.radioId === r.id) : [];
  }
  if (kind === 'conn') return [...sockets].filter((c) => c.id === value);
  return [];
}

function broadcast(type, payload, opts = {}) {
  const targeted = Boolean(opts.radioIds || opts.mdtIds);
  for (const c of sockets) {
    let deliver = !targeted;
    if (targeted) {
      if (opts.radioIds && c.radioId && opts.radioIds.includes(c.radioId)) deliver = true;
      if (opts.mdtIds && c.mdtId && opts.mdtIds.includes(c.mdtId)) deliver = true;
      if (opts.includeControl !== false && isControlRole(c.user.role)) deliver = true;
    }
    if (deliver) c.send(type, payload);
  }
}
const isControlRole = (role) => ['DISPATCHER', 'SUPERVISOR', 'SYSTEM_ADMIN'].includes(role);

/* ------------------------------------------------------------------ *
 * Domain logic
 * ------------------------------------------------------------------ */
function publicRadio(r) {
  const cs = db.callsigns.find((c) => c.id === r.callsign_id);
  const tg = db.talkgroups.find((t) => t.id === r.talkgroup_id);
  const veh = db.vehicles.find((v) => v.id === r.vehicle_id);
  return {
    id: r.id, issi: r.issi, alias: r.alias, radio_type: r.radio_type, status: r.status,
    callsign: cs ? cs.name : null, callsign_id: r.callsign_id,
    talkgroup: tg ? tg.name : null, talkgroup_id: r.talkgroup_id,
    vehicle: veh ? veh.registration : null, job_id: r.job_id,
    battery: r.battery, signal: r.signal, lat: r.lat, lon: r.lon,
    speed: r.speed, heading: r.heading, last_seen: r.last_seen,
    emergency: r.emergency, connected: r.connected, pbx_extension: r.pbx_extension || null,
    welfare_interval_s: r.welfare_interval_s || null, welfare_due_at: r.welfare_due_at || null,
    covert: Boolean(r.covert), status_code: r.status_code || null,
    personnel: db.personnel.filter((p) => p.callsign_id === r.callsign_id).map((p) => p.name),
  };
}
function publicMdt(m) {
  const cs = db.callsigns.find((c) => c.id === m.callsign_id);
  const veh = db.vehicles.find((v) => v.id === m.vehicle_id);
  return { id: m.id, mdt_code: m.mdt_code, serial: m.serial, callsign: cs ? cs.name : null, callsign_id: m.callsign_id, vehicle: veh ? veh.registration : null, status: m.status, duty_status: m.duty_status || 'AVAILABLE', job_id: m.job_id, battery: m.battery, network: m.network, operator: m.operator, connected: m.connected, lat: m.lat, lon: m.lon, crew: m.crew || [] };
}
function publicJob(j) {
  const assigns = db.job_assignments.filter((a) => a.job_id === j.id);
  return {
    ...j,
    resources: assigns.map((a) => {
      const r = a.radio_id ? db.radios.find((x) => x.id === a.radio_id) : null;
      const m = a.mdt_id ? db.mdts.find((x) => x.id === a.mdt_id) : null;
      const cs = db.callsigns.find((c) => c.id === a.callsign_id);
      return { assignment_id: a.id, callsign: cs ? cs.name : null, radio: r ? r.issi : null, mdt: m ? m.mdt_code : null, acknowledged: a.acknowledged, acknowledged_at: a.acknowledged_at };
    }),
  };
}
function publicCall(c) {
  return {
    ...c,
    participants: db.communication_participants.filter((p) => p.communication_id === c.id).map((p) => {
      const r = db.radios.find((x) => x.id === p.radio_id);
      return { radio_id: p.radio_id, issi: r ? r.issi : null, callsign: r ? (db.callsigns.find((cs) => cs.id === r.callsign_id) || {}).name : null, role: p.role, state: p.state };
    }),
  };
}

function setRadioStatus(radio, status, reason = '') {
  if (!RADIO_STATUSES.includes(status)) throw httpError(400, `invalid status ${status}`);
  const prev = radio.status;
  radio.status = status;
  radio.last_seen = new Date().toISOString();
  db.radio_status_history.push({ id: nextId('radio_status_history'), radio_id: radio.id, from_status: prev, to_status: status, at: radio.last_seen, reason });
  broadcast('radio.status_changed', publicRadio(radio));
  logEvent('radio.status_changed', `${callsignOf(radio)} STATUS → ${status}`, { radio_id: radio.id, issi: radio.issi, from: prev, to: status });
}
const callsignOf = (r) => { const c = db.callsigns.find((x) => x.id === r.callsign_id); return c ? c.name : r.issi; };

function releaseFloorFor(radio) {
  for (const tg of db.talkgroups) {
    if (tg.floor_holder_radio_id === radio.id) {
      tg.floor_holder_radio_id = null; tg.floor_since = null;
      broadcast('radio.ptt_released', { talkgroup_id: tg.id, talkgroup: tg.name, radio_id: radio.id, issi: radio.issi, callsign: callsignOf(radio) });
    }
  }
}

function endCall(call, reason) {
  if (call.state === 'ENDED') return call;
  if (call.kind === 'PSTN' && reason !== 'REMOTE_CLEARED') {
    try { gateway.hangup({ callId: call.id }); } catch (e) { console.warn('[pbx] hangup failed', e.message); }
  }
  call.state = 'ENDED'; call.ended_at = new Date().toISOString(); call.end_reason = reason;
  call.duration_s = Math.round((Date.parse(call.ended_at) - Date.parse(call.started_at)) / 1000);
  // Release every leg, or the radio stays "busy" forever and cannot be called again.
  for (const p of db.communication_participants.filter((x) => x.communication_id === call.id)) {
    if (p.state !== 'REJECTED') p.state = 'ENDED';
  }
  const radioIds = db.communication_participants.filter((p) => p.communication_id === call.id).map((p) => p.radio_id).filter(Boolean);
  broadcast('call.ended', publicCall(call), { radioIds });
  logEvent('call.ended', `CALL #${call.id} ENDED (${reason}) ${call.duration_s}s`, { call_id: call.id });
  return call;
}

/* ------------------------------------------------------------------ *
 * WebSocket message handling
 * ------------------------------------------------------------------ */
function handleWsMessage(conn, msg) {
  const { type, payload = {} } = msg;
  switch (type) {
    case 'ping': return conn.send('pong', {});
    case 'radio.attach': {
      const radio = findRadio(payload.issi || payload.radio_id);
      if (!radio) return conn.send('error', { message: 'unknown radio' });
      if (conn.user.role === 'RADIO_USER' && conn.user.radio_id !== radio.id)
        return conn.send('error', { message: 'not authorised for this radio' });
      conn.radioId = radio.id;
      radio.connected = true;
      setRadioStatus(radio, payload.status && RADIO_STATUSES.includes(payload.status) ? payload.status : 'AVAILABLE', 'attached');
      broadcast('radio.connected', publicRadio(radio));
      logEvent('radio.connected', `${callsignOf(radio)} (${radio.issi}) CONNECTED`, { radio_id: radio.id });
      return conn.send('radio.attached', publicRadio(radio));
    }
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
    case 'webrtc.signal': {
      // Opaque relay: SDP offers/answers and ICE candidates pass through untouched.
      const targets = resolvePeers(payload.to);
      if (!targets.length) return conn.send('webrtc.unreachable', { to: payload.to });
      for (const t of targets) t.send('webrtc.signal', { from: peerAddr(conn), data: payload.data });
      return;
    }
    case 'radio.ptt_start': return pttStart(conn, payload);
    case 'radio.ptt_release': return pttRelease(conn, payload);
    default: return conn.send('error', { message: `unknown message ${type}` });
  }
}

function resolveActor(conn, payload) {
  if (conn.radioId) return db.radios.find((r) => r.id === conn.radioId);
  if (isControlRole(conn.user.role)) {
    if (payload.as_radio) return findRadio(payload.as_radio);
    return null; // control operates as CONTROL console
  }
  return null;
}

function pttStart(conn, payload) {
  const tg = findTalkgroup(payload.talkgroup_id || payload.talkgroup);
  if (!tg) return conn.send('error', { message: 'unknown talkgroup' });
  const radio = resolveActor(conn, payload);
  const holderId = tg.floor_holder_radio_id;
  const consoleHold = tg.floor_console_user_id;
  if ((holderId && holderId !== (radio && radio.id)) || (consoleHold && consoleHold !== (!radio ? conn.user.id : null))) {
    const holder = db.radios.find((r) => r.id === holderId);
    return conn.send('ptt.denied', { talkgroup: tg.name, reason: 'CHANNEL BUSY', holder: holder ? callsignOf(holder) : 'CONTROL' });
  }
  if (radio) { tg.floor_holder_radio_id = radio.id; tg.floor_console_user_id = null; }
  else { tg.floor_console_user_id = conn.user.id; tg.floor_holder_radio_id = null; }
  tg.floor_since = new Date().toISOString();
  const who = radio ? callsignOf(radio) : 'CONTROL';
  const ev = { talkgroup_id: tg.id, talkgroup: tg.name, radio_id: radio ? radio.id : null, issi: radio ? radio.issi : null, callsign: who, since: tg.floor_since };
  // The floor holder publishes audio to every listener; listeners only receive.
  const memberIds = db.talkgroup_members.filter((m) => m.talkgroup_id === tg.id).map((m) => m.radio_id);
  const listeners = [...sockets]
    .filter((c) => c !== conn && (isControlRole(c.user.role) || (c.radioId && memberIds.includes(c.radioId))))
    .map(peerAddr);
  conn.send('ptt.granted', { ...ev, listeners: [...new Set(listeners)] });
  broadcast('radio.ptt_started', ev);
  logEvent('radio.ptt_started', `${who} TX → ${tg.name}`, ev);
}

function pttRelease(conn, payload) {
  const tg = findTalkgroup(payload.talkgroup_id || payload.talkgroup);
  if (!tg) return;
  const radio = resolveActor(conn, payload);
  const mine = radio ? tg.floor_holder_radio_id === radio.id : tg.floor_console_user_id === conn.user.id;
  if (!mine) return;
  const who = radio ? callsignOf(radio) : 'CONTROL';
  const duration = tg.floor_since ? Math.round((Date.now() - Date.parse(tg.floor_since)) / 1000) : 0;
  tg.floor_holder_radio_id = null; tg.floor_console_user_id = null; tg.floor_since = null;
  const ev = { talkgroup_id: tg.id, talkgroup: tg.name, radio_id: radio ? radio.id : null, callsign: who, duration_s: duration };
  broadcast('radio.ptt_released', ev);
  logEvent('radio.ptt_released', `${who} RX ← ${tg.name} (${duration}s)`, ev);
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

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
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
      for await (const c of req) { size += c.length; if (size > 1e6) { return send(413, { error: 'payload too large' }); } chunks.push(c); }
      const raw = Buffer.concat(chunks).toString();
      if (raw) { try { body = JSON.parse(raw); } catch { return send(400, { error: 'invalid JSON body' }); } }
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
});

server.on('upgrade', (req, socket) => {
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
  conn.send('hello', { user: { id: user.id, username: user.username, role: user.role, display_name: user.display_name, radio_id: user.radio_id, mdt_id: user.mdt_id } });
});

/* ------------------------------------------------------------------ *
 * REST API
 * ------------------------------------------------------------------ */
const ALL = ROLES;
const CONTROL = ['DISPATCHER', 'SUPERVISOR', 'SYSTEM_ADMIN'];
const ADMIN = ['SYSTEM_ADMIN'];

const publicUser = (u) => ({ id: u.id, username: u.username, role: u.role, display_name: u.display_name, radio_id: u.radio_id, mdt_id: u.mdt_id, email: u.email || null });

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

/* ---- Microsoft Entra ID (Azure AD) single sign-on --------------------
 * Alongside local username/password, never replacing it. A Microsoft sign-in
 * only succeeds if its email/UPN matches an existing CCCS account's `email`
 * field — SSO never creates an account, it only unlocks one an admin already
 * set up, so role and radio/MDT bindings stay under admin control. */
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
const DEFAULT_SETTINGS = {
  // Android keycodes. 275 is the dedicated PTT key on several rugged handsets,
  // but it varies by vendor — the Settings screen lets the officer press their
  // own key and bind whatever it actually sends.
  ptt_keycode: 275,
  ptt_key_label: 'Side key (default)',
  sos_keycode: null,
  sos_key_label: null,
  sos_hold_ms: 1500,
  // Desktop equivalents, used when running the console in a browser.
  ptt_web_key: 'Space',
  sos_web_key: null,
  // Canonical binding tokens as the handset reports them: 'Space' in a browser,
  // 'android:284' on a device. Stored per user so a replacement handset picks up
  // the officer's own bindings at first sign-in.
  ptt_token: 'Space',
  sos_token: null,
  // Long-press keypad actions. Defaults are the Android keycodes for 1, # and *.
  call_token: 'android:8',        // hold 1
  priority_token: 'android:18',   // hold #
  lock_token: 'android:17',       // hold *
  redial_token: 'android:7',      // hold 0
  talkgroup_token: 'android:9',   // hold 2
  status_token: 'android:10',     // hold 3
  covert_token: 'android:12',     // hold 5
  position_token: 'android:15',   // hold 8
  action_hold_ms: 800,
  speed_dial: {},                 // keypad character -> { type, target, label }
};

route('GET', '/api/me/settings', ALL, ({ user }) => ({ ...DEFAULT_SETTINGS, ...(user.settings || {}) }));
route('PUT', '/api/me/settings', ALL, ({ user, body }) => {
  const next = { ...DEFAULT_SETTINGS, ...(user.settings || {}) };
  const num = (v) => (v === null || v === '' ? null : Number(v));

  if ('ptt_keycode' in body) {
    const k = num(body.ptt_keycode);
    if (k !== null && (!Number.isInteger(k) || k < 0 || k > 1000)) throw httpError(400, 'ptt_keycode out of range');
    next.ptt_keycode = k;
  }
  if ('sos_keycode' in body) {
    const k = num(body.sos_keycode);
    if (k !== null && (!Number.isInteger(k) || k < 0 || k > 1000)) throw httpError(400, 'sos_keycode out of range');
    next.sos_keycode = k;
  }
  if (next.ptt_keycode !== null && next.ptt_keycode === next.sos_keycode) {
    throw httpError(400, 'the same key cannot be bound to both talk and SOS');
  }
  if ('sos_hold_ms' in body) {
    const ms = num(body.sos_hold_ms);
    if (!Number.isInteger(ms) || ms < 500 || ms > 10000) throw httpError(400, 'sos_hold_ms must be between 500 and 10000');
    next.sos_hold_ms = ms;
  }
  if ('action_hold_ms' in body) {
    const ms = Number(body.action_hold_ms);
    if (!Number.isInteger(ms) || ms < 300 || ms > 5000) throw httpError(400, 'action_hold_ms must be between 300 and 5000');
    next.action_hold_ms = ms;
  }
  if ('speed_dial' in body) {
    const map = body.speed_dial || {};
    if (typeof map !== 'object' || Array.isArray(map)) throw httpError(400, 'speed_dial must be an object');
    const cleaned = {};
    for (const [ch, entry] of Object.entries(map).slice(0, 12)) {
      if (!/^[0-9*#]$/.test(ch)) throw httpError(400, `speed dial key ${ch} is not a keypad character`);
      if (!entry) continue;
      const type = String(entry.type || 'radio');
      if (!['radio', 'phone'].includes(type)) throw httpError(400, 'speed dial entries must be radio or phone');
      const target = String(entry.target || '').replace(/[^0-9*#+]/g, '');
      if (!target) throw httpError(400, `speed dial ${ch} has no number`);
      cleaned[ch] = { type, target, label: String(entry.label || target).slice(0, 40) };
    }
    next.speed_dial = cleaned;
  }
  for (const field of ['ptt_token', 'sos_token', 'call_token', 'priority_token', 'lock_token',
                       'redial_token', 'talkgroup_token', 'status_token', 'covert_token', 'position_token']) {
    if (field in body) next[field] = body[field] === null ? null : String(body[field]).slice(0, 40);
  }
  const bound = ['ptt_token', 'sos_token', 'call_token', 'priority_token', 'lock_token',
                 'redial_token', 'talkgroup_token', 'status_token', 'covert_token', 'position_token']
    .map((f) => next[f]).filter(Boolean);
  if (new Set(bound).size !== bound.length) {
    throw httpError(400, 'each key can only be bound to one action');
  }
  for (const field of ['ptt_key_label', 'sos_key_label', 'ptt_web_key', 'sos_web_key']) {
    if (field in body) next[field] = body[field] === null ? null : String(body[field]).slice(0, 60);
  }
  user.settings = next;
  store.flushNow();
  logEvent('settings.updated', `${user.username} UPDATED KEY BINDINGS`, { user_id: user.id });
  return next;
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

// Radios
route('GET', '/api/radios', ALL, () => db.radios.map(publicRadio));
route('GET', '/api/radios/:id', ALL, ({ params }) => {
  const r = findRadio(params.id); if (!r) throw httpError(404, 'radio not found');
  return publicRadio(r);
});
route('POST', '/api/radios', ADMIN, ({ body }) => {
  const issi = String(body.issi || '').trim();
  if (!/^\d{6,15}$/.test(issi)) throw httpError(400, 'ISSI must be 6-15 digits');
  if (db.radios.some((r) => r.issi === issi)) throw httpError(409, 'ISSI already exists');
  const type = String(body.radio_type || 'HANDHELD').toUpperCase();
  if (!['HANDHELD', 'VEHICLE', 'FIXED', 'MDT'].includes(type)) throw httpError(400, 'invalid radio_type');
  const cs = body.callsign ? findCallsign(body.callsign) : null;
  const tg = body.talkgroup ? findTalkgroup(body.talkgroup) : null;
  const r = { id: nextId('radios'), issi, alias: body.alias || issi, radio_type: type, status: 'OFFLINE', callsign_id: cs ? cs.id : null, vehicle_id: null, talkgroup_id: tg ? tg.id : null, job_id: null, assigned_user_id: null, battery: 100, signal: 'UNKNOWN', lat: 51.5074, lon: -0.1278, speed: 0, heading: 0, last_seen: null, emergency: false, connected: false, sim_target: null, pbx_extension: body.pbx_extension || null };
  db.radios.push(r);
  if (tg) db.talkgroup_members.push({ id: nextId('talkgroup_members'), talkgroup_id: tg.id, radio_id: r.id });
  broadcast('radio.created', publicRadio(r));
  logEvent('radio.created', `RADIO ${issi} CREATED`, { radio_id: r.id });
  return { __status: 201, __body: publicRadio(r) };
});
route('POST', '/api/radios/:id/status', ALL, ({ params, body, user }) => {
  const r = findRadio(params.id); if (!r) throw httpError(404, 'radio not found');
  if (user.role === 'RADIO_USER' && user.radio_id !== r.id) throw httpError(403, 'not your radio');

  let status = String(body.status || '').toUpperCase();
  let reason = body.reason || `set by ${user.username}`;
  if (body.code !== undefined) {
    const code = String(body.code).padStart(2, '0');
    const entry = STATUS_CODES[code];
    if (!entry) throw httpError(400, `unknown status code ${code}`);
    status = entry.status;
    reason = `status ${code} — ${entry.label}`;
    r.status_code = code;
  }
  setRadioStatus(r, status, reason);
  return publicRadio(r);
});
route('POST', '/api/radios/:id/location', ALL, ({ params, body, user }) => {
  const r = findRadio(params.id); if (!r) throw httpError(404, 'radio not found');
  if (user.role === 'RADIO_USER' && user.radio_id !== r.id) throw httpError(403, 'not your radio');
  Object.assign(r, { lat: Number(body.lat), lon: Number(body.lon), speed: Number(body.speed || 0), heading: Number(body.heading || 0), last_seen: new Date().toISOString() });
  db.locations.push({ id: nextId('locations'), radio_id: r.id, lat: r.lat, lon: r.lon, speed: r.speed, heading: r.heading, at: r.last_seen });
  broadcast('radio.location_changed', publicRadio(r));
  return publicRadio(r);
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
const MDT_DUTY_STATUSES = ['AVAILABLE', 'BUSY', 'OUT_OF_SERVICE'];
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
  broadcast('mdt.status_changed', publicMdt(m));
  return publicMdt(m);
});

route('GET', '/api/vehicles', ALL, () => db.vehicles);
route('GET', '/api/personnel', ALL, () => db.personnel);

// Call signs
route('GET', '/api/callsigns', ALL, () => db.callsigns.map((c) => ({
  ...c,
  radios: db.radios.filter((r) => r.callsign_id === c.id).map((r) => ({ id: r.id, issi: r.issi, status: r.status, type: r.radio_type })),
  mdts: db.mdts.filter((m) => m.callsign_id === c.id).map((m) => ({ id: m.id, mdt_code: m.mdt_code, status: m.status })),
  personnel: db.personnel.filter((p) => p.callsign_id === c.id).map((p) => p.name),
  vehicles: [...new Set(db.radios.filter((r) => r.callsign_id === c.id && r.vehicle_id).map((r) => (db.vehicles.find((v) => v.id === r.vehicle_id) || {}).registration))],
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
  if (body.radio) {
    const r = findRadio(body.radio); if (!r) throw httpError(404, 'radio not found');
    r.callsign_id = cs.id;
    broadcast('radio.assigned', publicRadio(r));
    logEvent('assignment.radio', `RADIO ${r.issi} → ${cs.name}`, { radio_id: r.id, callsign_id: cs.id });
  }
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
  if (body.radio) {
    const r = findRadio(body.radio); if (!r) throw httpError(404, 'radio not found');
    if (r.callsign_id !== cs.id) throw httpError(409, 'radio not assigned to this call sign');
    r.callsign_id = null;
    broadcast('radio.assigned', publicRadio(r));
    logEvent('assignment.radio_removed', `RADIO ${r.issi} REMOVED FROM ${cs.name}`);
  }
  if (body.mdt) {
    const m = findMdt(body.mdt); if (!m) throw httpError(404, 'MDT not found');
    m.callsign_id = null;
    broadcast('mdt.assigned', publicMdt(m));
    logEvent('assignment.mdt_removed', `${m.mdt_code} REMOVED FROM ${cs.name}`);
  }
  return { ok: true };
});

// Talkgroups
route('GET', '/api/talkgroups', ALL, () => db.talkgroups.map((t) => ({
  id: t.id, name: t.name, description: t.description,
  floor_holder: t.floor_holder_radio_id ? callsignOf(db.radios.find((r) => r.id === t.floor_holder_radio_id)) : (t.floor_console_user_id ? 'CONTROL' : null),
  floor_since: t.floor_since,
  members: db.talkgroup_members.filter((m) => m.talkgroup_id === t.id).map((m) => {
    const r = db.radios.find((x) => x.id === m.radio_id);
    return r ? { radio_id: r.id, issi: r.issi, callsign: callsignOf(r), status: r.status, connected: r.connected } : null;
  }).filter(Boolean),
})));
route('POST', '/api/talkgroups', CONTROL, ({ body }) => {
  const name = String(body.name || '').toUpperCase().trim();
  if (!name) throw httpError(400, 'name required');
  if (db.talkgroups.some((t) => t.name === name)) throw httpError(409, 'talkgroup exists');
  const t = { id: nextId('talkgroups'), name, description: body.description || '', floor_holder_radio_id: null, floor_console_user_id: null, floor_since: null };
  db.talkgroups.push(t);
  broadcast('talkgroup.created', t);
  logEvent('talkgroup.created', `TALKGROUP ${name} CREATED`);
  return { __status: 201, __body: t };
});
route('PATCH', '/api/talkgroups/:id', CONTROL, ({ params, body }) => {
  const t = findTalkgroup(params.id); if (!t) throw httpError(404, 'talkgroup not found');
  if (body.name) t.name = String(body.name).toUpperCase();
  if (body.description !== undefined) t.description = body.description;
  broadcast('talkgroup.updated', t);
  logEvent('talkgroup.updated', `TALKGROUP ${t.name} UPDATED`);
  return t;
});
route('POST', '/api/talkgroups/:id/members', ALL, ({ params, body, user }) => {
  const t = findTalkgroup(params.id); if (!t) throw httpError(404, 'talkgroup not found');
  const r = findRadio(body.radio); if (!r) throw httpError(404, 'radio not found');
  if (user.role === 'RADIO_USER' && user.radio_id !== r.id) throw httpError(403, 'not your radio');
  db.talkgroup_members = db.talkgroup_members.filter((m) => !(m.radio_id === r.id && m.talkgroup_id === t.id));
  db.talkgroup_members.push({ id: nextId('talkgroup_members'), talkgroup_id: t.id, radio_id: r.id });
  r.talkgroup_id = t.id;
  broadcast('talkgroup.membership_changed', { talkgroup_id: t.id, radio: publicRadio(r), action: 'added' });
  logEvent('talkgroup.affiliated', `${callsignOf(r)} AFFILIATED → ${t.name}`, { radio_id: r.id, talkgroup_id: t.id });
  return { ok: true };
});
route('DELETE', '/api/talkgroups/:id/members', CONTROL, ({ params, body }) => {
  const t = findTalkgroup(params.id); if (!t) throw httpError(404, 'talkgroup not found');
  const r = findRadio(body.radio); if (!r) throw httpError(404, 'radio not found');
  db.talkgroup_members = db.talkgroup_members.filter((m) => !(m.radio_id === r.id && m.talkgroup_id === t.id));
  if (r.talkgroup_id === t.id) r.talkgroup_id = null;
  broadcast('talkgroup.membership_changed', { talkgroup_id: t.id, radio: publicRadio(r), action: 'removed' });
  logEvent('talkgroup.deaffiliated', `${callsignOf(r)} REMOVED FROM ${t.name}`);
  return { ok: true };
});

// Calls
function startCall(kind, fromLabel, fromRadio, targets, initiatorUser) {
  const call = {
    id: nextId('communications'), kind, state: 'RINGING',
    from_radio_id: fromRadio ? fromRadio.id : null, from_label: fromLabel,
    initiator_user_id: initiatorUser ? initiatorUser.id : null,
    started_at: new Date().toISOString(), ended_at: null, duration_s: null, end_reason: null,
    talkgroup_id: null,
  };
  db.communications.push(call);
  if (fromRadio) db.communication_participants.push({ id: nextId('communication_participants'), communication_id: call.id, radio_id: fromRadio.id, role: 'CALLER', state: 'CONNECTED' });
  for (const t of targets) db.communication_participants.push({ id: nextId('communication_participants'), communication_id: call.id, radio_id: t.id, role: 'CALLEE', state: 'RINGING' });
  const targetIds = targets.map((t) => t.id);
  broadcast('call.incoming', publicCall(call), { radioIds: targetIds });
  pushToUsers(db.users.filter((u) => u.radio_id && targetIds.includes(u.radio_id)).map((u) => u.id),
    { title: 'Incoming call', body: `${fromLabel || 'Control'} is calling`, url: '/radio.html', tag: 'cccs-call' });
  // Calling the officer answers whatever they were asking for.
  for (const t of targets) {
    const pending = db.call_requests.find((r) => r.radio_id === t.id && r.state === 'PENDING');
    if (pending) {
      pending.state = 'ANSWERED'; pending.answered_at = new Date().toISOString();
      pending.answered_by = initiatorUser ? initiatorUser.display_name : 'CONTROL';
      broadcast('call.request_cleared', pending);
    }
  }
  logEvent('call.started', `${fromLabel} → ${targets.map(callsignOf).join(', ')} (${kind})`, { call_id: call.id });
  setTimeout(() => {
    const c = db.communications.find((x) => x.id === call.id);
    if (c && c.state === 'RINGING') endCall(c, 'NO_ANSWER');
  }, 30000).unref?.();
  return call;
}

route('POST', '/api/calls/private', ALL, ({ body, user }) => {
  const to = findRadio(body.to); if (!to) throw httpError(404, 'destination radio not found');
  if (!to.connected) { logEvent('call.failed', `CALL TO ${to.issi} FAILED — OFFLINE`); throw httpError(409, 'destination radio offline'); }
  const busy = db.communication_participants.some((p) => p.radio_id === to.id && ['RINGING', 'CONNECTED'].includes(p.state));
  if (busy) throw httpError(409, 'destination busy');
  let fromRadio = null, fromLabel = 'CONTROL';
  if (user.role === 'RADIO_USER') { fromRadio = db.radios.find((r) => r.id === user.radio_id); fromLabel = callsignOf(fromRadio); }
  else if (body.from) { fromRadio = findRadio(body.from); fromLabel = fromRadio ? callsignOf(fromRadio) : 'CONTROL'; }
  return { __status: 201, __body: publicCall(startCall('PRIVATE', fromLabel, fromRadio, [to], user)) };
});
route('POST', '/api/calls/group', CONTROL, ({ body, user }) => {
  let targets = [];
  if (body.talkgroup) {
    const tg = findTalkgroup(body.talkgroup); if (!tg) throw httpError(404, 'talkgroup not found');
    targets = db.talkgroup_members.filter((m) => m.talkgroup_id === tg.id).map((m) => db.radios.find((r) => r.id === m.radio_id)).filter((r) => r && r.connected);
  } else {
    targets = (body.to || []).map((t) => findRadio(t) || (findCallsign(t) ? db.radios.find((r) => r.callsign_id === findCallsign(t).id) : null)).filter(Boolean);
  }
  if (!targets.length) throw httpError(400, 'no reachable recipients');
  const call = startCall('GROUP', 'CONTROL', null, targets, user);
  if (body.talkgroup) call.talkgroup_id = findTalkgroup(body.talkgroup).id;
  return { __status: 201, __body: publicCall(call) };
});
route('POST', '/api/calls/:id/accept', ALL, ({ params, user, body }) => {
  const call = db.communications.find((c) => c.id === Number(params.id)); if (!call) throw httpError(404, 'call not found');
  const radio = user.role === 'RADIO_USER' ? db.radios.find((r) => r.id === user.radio_id) : findRadio(body.radio);
  if (!radio) throw httpError(400, 'radio required');
  const p = db.communication_participants.find((x) => x.communication_id === call.id && x.radio_id === radio.id);
  if (!p) throw httpError(403, 'not a participant');
  p.state = 'CONNECTED'; call.state = 'ACTIVE'; call.answered_at = new Date().toISOString();
  const radioIds = db.communication_participants.filter((x) => x.communication_id === call.id).map((x) => x.radio_id);
  broadcast('call.accepted', publicCall(call), { radioIds });
  logEvent('call.accepted', `${callsignOf(radio)} ANSWERED CALL #${call.id}`, { call_id: call.id });
  return publicCall(call);
});
route('POST', '/api/calls/:id/reject', ALL, ({ params, user, body }) => {
  const call = db.communications.find((c) => c.id === Number(params.id)); if (!call) throw httpError(404, 'call not found');
  const radio = user.role === 'RADIO_USER' ? db.radios.find((r) => r.id === user.radio_id) : findRadio(body.radio);
  const p = db.communication_participants.find((x) => x.communication_id === call.id && x.radio_id === (radio || {}).id);
  if (!p) throw httpError(403, 'not a participant');
  p.state = 'REJECTED';
  const radioIds = db.communication_participants.filter((x) => x.communication_id === call.id).map((x) => x.radio_id);
  broadcast('call.rejected', { ...publicCall(call), rejected_by: callsignOf(radio) }, { radioIds });
  logEvent('call.rejected', `${callsignOf(radio)} DECLINED CALL #${call.id}`, { call_id: call.id });
  const remaining = db.communication_participants.filter((x) => x.communication_id === call.id && x.role === 'CALLEE' && ['RINGING', 'CONNECTED'].includes(x.state));
  if (!remaining.length) endCall(call, 'DECLINED');
  return publicCall(call);
});
route('POST', '/api/calls/:id/end', ALL, ({ params }) => {
  const call = db.communications.find((c) => c.id === Number(params.id)); if (!call) throw httpError(404, 'call not found');
  return publicCall(endCall(call, 'CLEARED'));
});
route('GET', '/api/calls', ALL, () => db.communications.slice(-100).map(publicCall));

// Jobs
route('GET', '/api/jobs', ALL, ({ query }) => {
  let jobs = db.jobs.map(publicJob);
  if (query.get('status')) jobs = jobs.filter((j) => j.status === query.get('status').toUpperCase());
  return jobs;
});
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
  };
  db.jobs.push(j);
  broadcast('job.created', publicJob(j));
  logEvent('job.created', `JOB ${j.reference} CREATED (${priority})`, { job_id: j.id });
  return { __status: 201, __body: publicJob(j) };
});
route('POST', '/api/jobs/:id/assign', CONTROL, ({ params, body }) => {
  const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
  const targets = body.resources || body.to || [];
  if (!targets.length) throw httpError(400, 'resources required');
  const radioIds = [], mdtIds = [];
  for (const t of targets) {
    const cs = findCallsign(t);
    const radios = cs ? db.radios.filter((r) => r.callsign_id === cs.id) : [findRadio(t)].filter(Boolean);
    const mdts = cs ? db.mdts.filter((m) => m.callsign_id === cs.id) : [findMdt(t)].filter(Boolean);
    if (!radios.length && !mdts.length) throw httpError(404, `unknown resource ${t}`);
    for (const r of radios) {
      if (db.job_assignments.some((a) => a.job_id === j.id && a.radio_id === r.id)) continue;
      db.job_assignments.push({ id: nextId('job_assignments'), job_id: j.id, radio_id: r.id, mdt_id: null, callsign_id: r.callsign_id, acknowledged: false, acknowledged_at: null, at: new Date().toISOString() });
      r.job_id = j.id; radioIds.push(r.id);
      if (['AVAILABLE', 'OFFLINE'].includes(r.status) && r.connected) setRadioStatus(r, 'ON_TASK', 'job assigned');
    }
    for (const m of mdts) {
      if (db.job_assignments.some((a) => a.job_id === j.id && a.mdt_id === m.id)) continue;
      db.job_assignments.push({ id: nextId('job_assignments'), job_id: j.id, radio_id: null, mdt_id: m.id, callsign_id: m.callsign_id, acknowledged: false, acknowledged_at: null, at: new Date().toISOString() });
      m.job_id = j.id; mdtIds.push(m.id);
    }
  }
  j.status = 'DISPATCHED'; j.updated_at = new Date().toISOString();
  stampJobStatus(j, 'DISPATCHED');
  const payload = publicJob(j);
  broadcast('job.dispatched', payload);
  broadcast('job.assigned_to_you', payload, { radioIds, mdtIds });
  pushToUsers(db.users.filter((u) => (u.radio_id && radioIds.includes(u.radio_id)) || (u.mdt_id && mdtIds.includes(u.mdt_id))).map((u) => u.id),
    { title: `Job ${j.reference}`, body: `${j.priority} — ${j.location}`, url: '/radio.html', tag: 'cccs-job' });
  logEvent('job.dispatched', `JOB ${j.reference} DISPATCHED → ${payload.resources.map((r) => r.callsign || r.radio || r.mdt).join(', ')}`, { job_id: j.id });
  return payload;
});
route('POST', '/api/jobs/:id/ack', ALL, ({ params, user, body }) => {
  const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
  let assignment;
  if (user.role === 'RADIO_USER') assignment = db.job_assignments.find((a) => a.job_id === j.id && a.radio_id === user.radio_id);
  else if (user.role === 'MDT_USER') assignment = db.job_assignments.find((a) => a.job_id === j.id && a.mdt_id === user.mdt_id);
  else {
    const r = body.radio ? findRadio(body.radio) : null; const m = body.mdt ? findMdt(body.mdt) : null;
    assignment = db.job_assignments.find((a) => a.job_id === j.id && ((r && a.radio_id === r.id) || (m && a.mdt_id === m.id)));
  }
  if (!assignment) throw httpError(404, 'no assignment for this resource');
  assignment.acknowledged = true; assignment.acknowledged_at = new Date().toISOString();
  if (j.status === 'DISPATCHED') { j.status = 'ACKNOWLEDGED'; j.updated_at = assignment.acknowledged_at; }
  stampJobStatus(j, 'ACKNOWLEDGED');
  const who = assignment.radio_id ? callsignOf(db.radios.find((r) => r.id === assignment.radio_id)) : (db.mdts.find((m) => m.id === assignment.mdt_id) || {}).mdt_code;
  broadcast('job.acknowledged', { job: publicJob(j), by: who });
  logEvent('job.acknowledged', `${who} ACKNOWLEDGED JOB ${j.reference}`, { job_id: j.id });
  return publicJob(j);
});
route('PATCH', '/api/jobs/:id', ALL, ({ params, body, user }) => {
  const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
  if (body.status) {
    const s = String(body.status).toUpperCase();
    if (!JOB_STATES.includes(s)) throw httpError(400, 'invalid job status');
    if (['RADIO_USER', 'MDT_USER'].includes(user.role)) {
      const mine = db.job_assignments.some((a) => a.job_id === j.id && (
        (user.role === 'RADIO_USER' && user.radio_id && a.radio_id === user.radio_id) ||
        (user.role === 'MDT_USER' && user.mdt_id && a.mdt_id === user.mdt_id)));
      if (!mine) throw httpError(403, 'job not assigned to you');
    }
    j.status = s;
    stampJobStatus(j, s);
    if (['COMPLETED', 'CANCELLED'].includes(s)) {
      for (const a of db.job_assignments.filter((x) => x.job_id === j.id)) {
        if (a.radio_id) { const r = db.radios.find((x) => x.id === a.radio_id); if (r) { r.job_id = null; if (r.connected && !r.emergency) setRadioStatus(r, 'AVAILABLE', 'job closed'); } }
        if (a.mdt_id) { const m = db.mdts.find((x) => x.id === a.mdt_id); if (m) m.job_id = null; }
      }
    }
  }
  if (body.notes !== undefined) j.notes = body.notes;
  j.updated_at = new Date().toISOString();
  broadcast('job.status_changed', publicJob(j));
  logEvent('job.status_changed', `JOB ${j.reference} → ${j.status}`, { job_id: j.id });
  return publicJob(j);
});
route('POST', '/api/jobs/:id/stand-down', CONTROL, ({ params, body }) => {
  const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
  const r = body.radio ? findRadio(body.radio) : null;
  const m = body.mdt ? findMdt(body.mdt) : null;
  if (!r && !m) throw httpError(400, 'radio or mdt required');
  const a = db.job_assignments.find((x) => x.job_id === j.id && ((r && x.radio_id === r.id) || (m && x.mdt_id === m.id)));
  if (!a) throw httpError(404, 'that resource is not assigned to this job');
  db.job_assignments = db.job_assignments.filter((x) => x.id !== a.id);
  const who = r ? callsignOf(r) : m.mdt_code;
  if (r) { r.job_id = null; if (r.connected && !r.emergency) setRadioStatus(r, 'AVAILABLE', 'stood down'); }
  if (m) { m.job_id = null; broadcast('mdt.status_changed', publicMdt(m)); }
  j.updated_at = new Date().toISOString();
  const payload = publicJob(j);
  broadcast('job.status_changed', payload);
  broadcast('job.stood_down', payload, { radioIds: r ? [r.id] : [], mdtIds: m ? [m.id] : [] });
  logEvent('job.stood_down', `${who} STOOD DOWN FROM JOB ${j.reference}`, { job_id: j.id });
  return payload;
});

// Emergency
route('POST', '/api/emergency', ALL, ({ body, user }) => {
  const radio = user.role === 'RADIO_USER' ? db.radios.find((r) => r.id === user.radio_id) : findRadio(body.radio);
  if (!radio) throw httpError(404, 'radio not found');
  const open = db.emergency_events.find((e) => e.radio_id === radio.id && e.state !== 'RESOLVED');
  if (open) return open;
  radio.emergency = true;
  setRadioStatus(radio, 'EMERGENCY', 'emergency button');
  const ev = { id: nextId('emergency_events'), kind: 'EMERGENCY', radio_id: radio.id, issi: radio.issi, callsign: callsignOf(radio), lat: radio.lat, lon: radio.lon, state: 'ACTIVE', activated_at: new Date().toISOString(), acknowledged_at: null, acknowledged_by: null, resolved_at: null };
  db.emergency_events.push(ev);
  broadcast('emergency.activated', ev);
  pushToRoles(CONTROL, { title: 'EMERGENCY', body: `${ev.callsign} (${ev.issi})`, url: '/control.html', tag: 'cccs-emergency' });
  store.flushNow();
  logEvent('emergency.activated', `!!! EMERGENCY — ${ev.callsign} (${ev.issi})`, { emergency_id: ev.id, radio_id: radio.id });
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
  ev.state = 'RESOLVED'; ev.resolved_at = new Date().toISOString();
  const radio = db.radios.find((r) => r.id === ev.radio_id);
  if (radio && ev.kind !== 'WELFARE') { radio.emergency = false; setRadioStatus(radio, radio.connected ? 'AVAILABLE' : 'OFFLINE', 'emergency cleared'); }
  broadcast('emergency.resolved', ev);
  logEvent('emergency.resolved', `EMERGENCY ${ev.callsign} RESOLVED BY ${user.display_name}`, { emergency_id: ev.id });
  return ev;
});

// Messaging
route('GET', '/api/messages', ALL, ({ user, query }) => {
  const mine = db.messages.filter((m) => {
    if (isControlRole(user.role)) return true;
    if (user.role === 'RADIO_USER') return m.to_radio_id === user.radio_id || m.from_radio_id === user.radio_id;
    if (user.role === 'MDT_USER') return m.to_mdt_id === user.mdt_id || m.from_mdt_id === user.mdt_id;
    return false;
  });
  const lim = Number(query.get('limit') || 100);
  return mine.slice(-lim);
});
route('POST', '/api/messages', ALL, ({ body, user }) => {
  const toRadio = body.to_radio ? findRadio(body.to_radio) : null;
  const toMdt = body.to_mdt ? findMdt(body.to_mdt) : null;
  if (!toRadio && !toMdt && !body.to_control) throw httpError(400, 'recipient required');
  const fromRadio = user.role === 'RADIO_USER' ? db.radios.find((r) => r.id === user.radio_id) : null;
  const fromMdt = user.role === 'MDT_USER' ? db.mdts.find((m) => m.id === user.mdt_id) : null;
  const msg = {
    id: nextId('messages'), body: String(body.body || '').slice(0, 1000),
    from_label: fromRadio ? callsignOf(fromRadio) : fromMdt ? fromMdt.mdt_code : 'CONTROL',
    from_radio_id: fromRadio ? fromRadio.id : null, from_mdt_id: fromMdt ? fromMdt.id : null,
    to_radio_id: toRadio ? toRadio.id : null, to_mdt_id: toMdt ? toMdt.id : null,
    to_label: toRadio ? callsignOf(toRadio) : toMdt ? toMdt.mdt_code : 'CONTROL',
    state: 'DELIVERED', sent_at: new Date().toISOString(), read_at: null,
  };
  if (!msg.body) throw httpError(400, 'message body required');
  db.messages.push(msg);
  broadcast('message.received', msg, { radioIds: toRadio ? [toRadio.id] : undefined, mdtIds: toMdt ? [toMdt.id] : undefined });
  logEvent('message.sent', `${msg.from_label} ✉ ${msg.to_label}: ${msg.body.slice(0, 60)}`, { message_id: msg.id });
  return { __status: 201, __body: msg };
});
route('POST', '/api/messages/:id/read', ALL, ({ params }) => {
  const m = db.messages.find((x) => x.id === Number(params.id)); if (!m) throw httpError(404, 'message not found');
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
route('GET', '/api/state', ALL, () => ({
  radios: db.radios.map(publicRadio), mdts: db.mdts.map(publicMdt), jobs: db.jobs.map(publicJob),
  talkgroups: db.talkgroups.map((t) => ({ id: t.id, name: t.name })),
  sites: db.sites,
  call_requests: db.call_requests.filter((r) => r.state === 'PENDING'),
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
  // Call and message records (metadata; no audio is recorded by this system).
  communications: Number(process.env.RETAIN_COMMS_DAYS || 180),
  messages: Number(process.env.RETAIN_MESSAGES_DAYS || 180),
  // Status history and closed jobs.
  status_history: Number(process.env.RETAIN_STATUS_DAYS || 365),
  jobs: Number(process.env.RETAIN_JOBS_DAYS || 730),
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
    radio_status_history: pruneOlderThan('radio_status_history', RETENTION.status_history, 'at'),
    messages: pruneOlderThan('messages', RETENTION.messages, 'sent_at'),
  };

  // Calls and jobs are only removed once they are finished — an open job is
  // operational data, not history, however old it is.
  const commsCutoff = Date.now() - RETENTION.communications * 86400000;
  const keptCalls = db.communications.filter((c) => c.state !== 'ENDED' || Date.parse(c.started_at) >= commsCutoff);
  removed.communications = db.communications.length - keptCalls.length;
  const goneIds = new Set(db.communications.filter((c) => !keptCalls.includes(c)).map((c) => c.id));
  db.communications = keptCalls;
  db.communication_participants = db.communication_participants.filter((p) => !goneIds.has(p.communication_id));

  const jobCutoff = Date.now() - RETENTION.jobs * 86400000;
  const keptJobs = db.jobs.filter((j) => !['COMPLETED', 'CANCELLED'].includes(j.status) || Date.parse(j.updated_at) >= jobCutoff);
  removed.jobs = db.jobs.length - keptJobs.length;
  const goneJobIds = new Set(db.jobs.filter((j) => !keptJobs.includes(j)).map((j) => j.id));
  db.jobs = keptJobs;
  db.job_assignments = db.job_assignments.filter((a) => !goneJobIds.has(a.job_id));

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
  counts: Object.fromEntries(['locations', 'audit_logs', 'radio_status_history', 'messages', 'communications', 'jobs']
    .map((t) => [t, db[t].length])),
  note: 'Location history is the most intrusive data here and is kept for the shortest time.',
}));
route('POST', '/api/retention/sweep', ADMIN, ({ user }) => {
  const removed = retentionSweep();
  logEvent('retention.manual', `MANUAL RETENTION SWEEP BY ${user.username}`);
  return removed;
});

/* Erasure request: remove one officer's movement history without touching the
   operational record of jobs, which the business needs to keep. */
route('POST', '/api/radios/:id/erase-location-history', ADMIN, ({ params, user }) => {
  const r = findRadio(params.id); if (!r) throw httpError(404, 'radio not found');
  const before = db.locations.length;
  db.locations = db.locations.filter((l) => l.radio_id !== r.id);
  const removed = before - db.locations.length;
  logEvent('retention.erasure', `LOCATION HISTORY ERASED FOR ${callsignOf(r)} (${removed} points) BY ${user.username}`, { radio_id: r.id, removed });
  store.flushNow();
  return { radio: r.issi, removed };
});

/* ------------------------------------------------------------------ *
 * Status codes
 *
 * Two-digit status messages are the cheapest thing on a radio network: an
 * officer updates control without occupying the channel or typing. The codes
 * below are a sensible default set for security work — change the table to
 * match whatever your control room already says out loud.
 * ------------------------------------------------------------------ */
const STATUS_CODES = {
  '01': { status: 'AVAILABLE', label: 'Available' },
  '02': { status: 'BUSY', label: 'Busy' },
  '03': { status: 'EN_ROUTE', label: 'En route' },
  '04': { status: 'ON_SCENE', label: 'On scene / at site' },
  '05': { status: 'ON_TASK', label: 'On task' },
  '06': { status: 'AVAILABLE', label: 'Site clear, resuming patrol' },
  '07': { status: 'BUSY', label: 'Meal break' },
  '08': { status: 'OUT_OF_SERVICE', label: 'Out of service' },
};
route('GET', '/api/status-codes', ALL, () => Object.entries(STATUS_CODES).map(([code, v]) => ({ code, ...v })));

/* ------------------------------------------------------------------ *
 * Covert mode and position reports
 * ------------------------------------------------------------------ */
route('POST', '/api/radios/:id/covert', ALL, ({ params, body, user }) => {
  const r = findRadio(params.id); if (!r) throw httpError(404, 'radio not found');
  if (user.role === 'RADIO_USER' && user.radio_id !== r.id) throw httpError(403, 'not your radio');
  r.covert = body.on !== false;
  broadcast('radio.covert_changed', publicRadio(r));
  // Control must know: a covert radio will not make a sound when called.
  logEvent('radio.covert', `${callsignOf(r)} COVERT MODE ${r.covert ? 'ON' : 'OFF'}`, { radio_id: r.id });
  store.flushNow();
  return publicRadio(r);
});

route('POST', '/api/radios/:id/position-report', ALL, ({ params, body, user }) => {
  const r = findRadio(params.id); if (!r) throw httpError(404, 'radio not found');
  if (user.role === 'RADIO_USER' && user.radio_id !== r.id) throw httpError(403, 'not your radio');
  if (body.lat !== undefined && body.lon !== undefined) {
    r.lat = Number(body.lat); r.lon = Number(body.lon);
  }
  r.last_seen = new Date().toISOString();
  db.locations.push({ id: nextId('locations'), radio_id: r.id, lat: r.lat, lon: r.lon, speed: r.speed, heading: r.heading, at: r.last_seen });
  const payload = publicRadio(r);
  broadcast('radio.position_report', payload);
  broadcast('radio.location_changed', payload);
  logEvent('radio.position_report', `${callsignOf(r)} POSITION REPORT ${r.lat ? r.lat.toFixed(4) + ', ' + r.lon.toFixed(4) : 'no fix'}`, { radio_id: r.id });
  return payload;
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
  const radio = user.role === 'RADIO_USER'
    ? db.radios.find((r) => r.id === user.radio_id)
    : findRadio(body.radio);
  if (!radio) throw httpError(404, 'radio not found');

  const priority = body.priority === true || String(body.priority).toUpperCase() === 'PRIORITY';
  const open = db.call_requests.find((r) => r.radio_id === radio.id && r.state === 'PENDING');
  if (open) {
    // A second press escalates rather than stacking another row.
    if (priority && !open.priority) {
      open.priority = true; open.escalated_at = new Date().toISOString();
      broadcast('call.request', open);
      logEvent('call.request_escalated', `${callsignOf(radio)} ESCALATED CALL REQUEST TO PRIORITY`, { request_id: open.id });
      store.flushNow();
    }
    return open;
  }

  const req = {
    id: nextId('call_requests'), radio_id: radio.id, issi: radio.issi,
    callsign: callsignOf(radio), priority, note: String(body.note || '').slice(0, 200) || null,
    lat: radio.lat, lon: radio.lon, state: 'PENDING',
    requested_at: new Date().toISOString(), answered_at: null, answered_by: null, cancelled_at: null,
  };
  db.call_requests.push(req);
  broadcast('call.request', req);
  logEvent('call.requested', `${req.callsign} REQUESTS ${priority ? 'PRIORITY ' : ''}CALL`, { request_id: req.id, radio_id: radio.id });
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
  if (user.role === 'RADIO_USER' && user.radio_id !== req.radio_id) throw httpError(403, 'not your request');
  if (req.state !== 'PENDING') return req;
  const byOfficer = user.role === 'RADIO_USER';
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

function startWelfare(radio, intervalS, note) {
  if (!Number.isFinite(intervalS) || intervalS < 30 || intervalS > 8 * 3600) {
    throw httpError(400, 'welfare interval must be between 30 seconds and 8 hours');
  }
  radio.welfare_interval_s = Math.round(intervalS);
  radio.welfare_due_at = new Date(Date.now() + radio.welfare_interval_s * 1000).toISOString();
  radio.welfare_warned = false;
  radio.welfare_note = note || null;
  const payload = { radio: publicRadio(radio), note: radio.welfare_note };
  broadcast('welfare.started', payload);
  logEvent('welfare.started', `${callsignOf(radio)} WELFARE TIMER ${radio.welfare_interval_s}s${note ? ' — ' + note : ''}`, { radio_id: radio.id });
  return radio;
}

function checkInWelfare(radio) {
  if (!radio.welfare_due_at) throw httpError(409, 'no welfare timer running');
  radio.welfare_due_at = new Date(Date.now() + radio.welfare_interval_s * 1000).toISOString();
  radio.welfare_warned = false;
  // Clear any overdue alarm this radio had raised.
  for (const ev of db.emergency_events) {
    if (ev.radio_id === radio.id && ev.kind === 'WELFARE' && ev.state !== 'RESOLVED') {
      ev.state = 'RESOLVED'; ev.resolved_at = new Date().toISOString();
      broadcast('emergency.resolved', ev);
    }
  }
  broadcast('welfare.checked_in', publicRadio(radio));
  logEvent('welfare.checked_in', `${callsignOf(radio)} CHECKED IN`, { radio_id: radio.id });
  return radio;
}

function stopWelfare(radio, reason = 'cancelled') {
  radio.welfare_interval_s = null; radio.welfare_due_at = null; radio.welfare_warned = false; radio.welfare_note = null;
  broadcast('welfare.stopped', publicRadio(radio));
  logEvent('welfare.stopped', `${callsignOf(radio)} WELFARE TIMER ${reason.toUpperCase()}`, { radio_id: radio.id });
  return radio;
}

function welfareTick() {
  const now = Date.now();
  for (const radio of db.radios) {
    if (!radio.welfare_due_at) continue;
    const due = Date.parse(radio.welfare_due_at);
    if (now >= due) {
      radio.welfare_due_at = null; radio.welfare_interval_s = null;
      const ev = {
        id: nextId('emergency_events'), kind: 'WELFARE', radio_id: radio.id, issi: radio.issi,
        callsign: callsignOf(radio), lat: radio.lat, lon: radio.lon, state: 'ACTIVE',
        note: radio.welfare_note || null, last_seen: radio.last_seen,
        activated_at: new Date().toISOString(), acknowledged_at: null, acknowledged_by: null, resolved_at: null,
      };
      db.emergency_events.push(ev);
      broadcast('welfare.overdue', ev);
      broadcast('emergency.activated', ev);
      pushToRoles(CONTROL, { title: 'Welfare alarm', body: `${ev.callsign} (${ev.issi}) — no check-in`, url: '/control.html', tag: 'cccs-emergency' });
      logEvent('welfare.overdue', `!!! WELFARE OVERDUE — ${ev.callsign} (${ev.issi}) NO CHECK-IN`, { emergency_id: ev.id, radio_id: radio.id });
      store.flushNow();
    } else if (!radio.welfare_warned && due - now <= WELFARE_WARN_S * 1000) {
      radio.welfare_warned = true;
      broadcast('welfare.due_soon', { radio: publicRadio(radio), seconds_left: Math.round((due - now) / 1000) }, { radioIds: [radio.id] });
    }
  }
}

route('POST', '/api/radios/:id/welfare', ALL, ({ params, body, user }) => {
  const r = findRadio(params.id); if (!r) throw httpError(404, 'radio not found');
  if (user.role === 'RADIO_USER' && user.radio_id !== r.id) throw httpError(403, 'not your radio');
  return publicRadio(startWelfare(r, Number(body.interval_s), body.note));
});
route('POST', '/api/radios/:id/welfare/check', ALL, ({ params, user }) => {
  const r = findRadio(params.id); if (!r) throw httpError(404, 'radio not found');
  if (user.role === 'RADIO_USER' && user.radio_id !== r.id) throw httpError(403, 'not your radio');
  return publicRadio(checkInWelfare(r));
});
route('DELETE', '/api/radios/:id/welfare', ALL, ({ params, user }) => {
  const r = findRadio(params.id); if (!r) throw httpError(404, 'radio not found');
  if (user.role === 'RADIO_USER' && user.radio_id !== r.id) throw httpError(403, 'not your radio');
  if (!r.welfare_due_at) throw httpError(409, 'no welfare timer running');
  return publicRadio(stopWelfare(r, user.role === 'RADIO_USER' ? 'cancelled by officer' : 'cancelled by control'));
});

/* Sites under contract — what alarm response jobs are attached to. */
route('GET', '/api/sites', ALL, () => db.sites);
route('POST', '/api/sites', CONTROL, ({ body }) => {
  const name = String(body.name || '').trim();
  if (!name) throw httpError(400, 'name required');
  if (db.sites.some((x) => x.name.toLowerCase() === name.toLowerCase())) throw httpError(409, 'site already exists');
  const site = { id: nextId('sites'), name, address: body.address || '', lat: Number(body.lat) || null, lon: Number(body.lon) || null, keyholder: body.keyholder || '', contract: 'ACTIVE' };
  db.sites.push(site);
  logEvent('site.created', `SITE ${name} ADDED`);
  return { __status: 201, __body: site };
});

/* ------------------------------------------------------------------ *
 * Telephony: dial 9 out through the PBX, and inbound DDI to a radio
 * ------------------------------------------------------------------ */
const { createGateway } = require('./pbx.js');
const PSTN_PREFIX = process.env.PSTN_PREFIX || '9';

const gateway = createGateway((event, data) => {
  const call = db.communications.find((c) => c.id === data.callId);
  if (!call) return;
  const radioIds = db.communication_participants
    .filter((p) => p.communication_id === call.id).map((p) => p.radio_id).filter(Boolean);
  if (event === 'answered' && call.state === 'RINGING') {
    call.state = 'ACTIVE'; call.answered_at = new Date().toISOString();
    broadcast('call.accepted', publicCall(call), { radioIds });
    logEvent('call.accepted', `PSTN CALL #${call.id} ANSWERED (${call.dialled_number})`, { call_id: call.id });
  }
  if (event === 'hangup') endCall(call, data.reason || 'REMOTE_CLEARED');
});

route('GET', '/api/config', ALL, () => ({
  iceServers: JSON.parse(process.env.ICE_SERVERS || '[{"urls":"stun:stun.l.google.com:19302"}]'),
  pstn: { prefix: PSTN_PREFIX, driver: gateway.name, media: gateway.mediaCapable },
  audio: process.env.AUDIO !== 'off',
}));

route('POST', '/api/calls/pstn', ALL, async ({ body, user }) => {
  const digits = String(body.digits || '').replace(/[^0-9*#+]/g, '');
  if (!digits.startsWith(PSTN_PREFIX)) throw httpError(400, `outside calls must start with ${PSTN_PREFIX}`);
  const number = digits.slice(PSTN_PREFIX.length);
  if (!number) throw httpError(400, 'no number dialled');

  const radio = user.role === 'RADIO_USER'
    ? db.radios.find((r) => r.id === user.radio_id)
    : (body.from ? findRadio(body.from) : null);
  if (user.role === 'RADIO_USER' && !radio) throw httpError(404, 'radio not found');

  const call = {
    id: nextId('communications'), kind: 'PSTN', state: 'RINGING',
    from_radio_id: radio ? radio.id : null, from_label: radio ? callsignOf(radio) : 'CONTROL',
    initiator_user_id: user.id, dialled_number: number, direction: 'OUTBOUND',
    started_at: new Date().toISOString(), ended_at: null, duration_s: null, end_reason: null, talkgroup_id: null,
  };
  db.communications.push(call);
  if (radio) db.communication_participants.push({ id: nextId('communication_participants'), communication_id: call.id, radio_id: radio.id, role: 'CALLER', state: 'CONNECTED' });

  try {
    const { channelId } = await gateway.dial({ callId: call.id, number, fromLabel: call.from_label, extension: radio ? radio.pbx_extension : null });
    call.channel_id = channelId;
  } catch (e) {
    endCall(call, 'GATEWAY_FAILED');
    throw httpError(502, `PBX rejected the call: ${e.message}`);
  }
  logEvent('call.pstn_dialled', `${call.from_label} → PSTN ${number}`, { call_id: call.id });
  broadcast('call.dialling', publicCall(call), { radioIds: radio ? [radio.id] : undefined });
  return { __status: 201, __body: publicCall(call) };
});

/* Inbound DDI. Called by the PBX dialplan, authenticated with a shared secret. */
route('POST', '/api/pbx/inbound', null, ({ body, req }) => {
  const secret = process.env.PBX_SECRET;
  if (!secret || req.headers['x-pbx-secret'] !== secret) throw httpError(401, 'bad PBX secret');
  const radio = findRadio(body.to);
  if (!radio) throw httpError(404, 'no radio for that destination');
  if (!radio.connected) throw httpError(409, 'radio not on air');
  const call = {
    id: nextId('communications'), kind: 'PSTN', state: 'RINGING',
    from_radio_id: null, from_label: body.caller_id || 'EXTERNAL CALLER',
    initiator_user_id: null, dialled_number: body.caller_id || null, direction: 'INBOUND',
    channel_id: body.channel_id || null,
    started_at: new Date().toISOString(), ended_at: null, duration_s: null, end_reason: null, talkgroup_id: null,
  };
  db.communications.push(call);
  db.communication_participants.push({ id: nextId('communication_participants'), communication_id: call.id, radio_id: radio.id, role: 'CALLEE', state: 'RINGING' });
  broadcast('call.incoming', publicCall(call), { radioIds: [radio.id] });
  logEvent('call.pstn_inbound', `PSTN ${call.from_label} → ${callsignOf(radio)}`, { call_id: call.id });
  return { __status: 201, __body: publicCall(call) };
});

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

route('GET', '/api/users', ADMIN, () => db.users.map((u) => ({ id: u.id, username: u.username, role: u.role, display_name: u.display_name, radio_id: u.radio_id, mdt_id: u.mdt_id, email: u.email || null })));
route('POST', '/api/users', ADMIN, ({ body }) => {
  const username = String(body.username || '').toLowerCase().trim();
  if (!username || !body.password) throw httpError(400, 'username and password required');
  if (String(body.password).length < 8) throw httpError(400, 'password must be at least 8 characters');
  if (!ROLES.includes(body.role)) throw httpError(400, 'invalid role');
  if (db.users.some((u) => u.username === username)) throw httpError(409, 'username taken');
  const email = normalizeEmail(body.email) ?? null;
  const u = { id: nextId('users'), username, password_hash: hashPassword(String(body.password)), role: body.role, display_name: body.display_name || username, radio_id: body.radio_id || null, mdt_id: body.mdt_id || null, email, created_at: new Date().toISOString() };
  db.users.push(u);
  logEvent('user.created', `USER ${username} CREATED (${u.role})`);
  return { __status: 201, __body: { id: u.id, username: u.username, role: u.role } };
});
route('PATCH', '/api/users/:id', ADMIN, ({ params, body }) => {
  const u = db.users.find((x) => x.id === Number(params.id));
  if (!u) throw httpError(404, 'user not found');
  if ('email' in body) u.email = normalizeEmail(body.email, { forId: u.id });
  logEvent('user.updated', `USER ${u.username} UPDATED`, { user_id: u.id });
  return publicUser(u);
});

/* ------------------------------------------------------------------ *
 * GPS simulation
 * ------------------------------------------------------------------ */
function simulationTick() {
  for (const r of db.radios) {
    if (!r.connected) continue;
    const job = r.job_id ? db.jobs.find((j) => j.id === r.job_id) : null;
    let target = r.sim_target;
    if (job && ['DISPATCHED', 'ACKNOWLEDGED', 'EN_ROUTE'].includes(job.status)) target = { lat: job.lat, lon: job.lon };
    if (!target || Math.hypot(target.lat - r.lat, target.lon - r.lon) < 0.0006) {
      target = { lat: 51.5074 + (Math.random() - 0.5) * 0.08, lon: -0.1278 + (Math.random() - 0.5) * 0.10 };
      r.sim_target = target;
    }
    const dLat = target.lat - r.lat, dLon = target.lon - r.lon;
    const dist = Math.hypot(dLat, dLon) || 1;
    const step = Math.min(dist, 0.00035 + Math.random() * 0.0004);
    r.lat += (dLat / dist) * step; r.lon += (dLon / dist) * step;
    r.heading = Math.round(((Math.atan2(dLon, dLat) * 180) / Math.PI + 360) % 360);
    r.speed = Math.round(step * 250000);
    r.last_seen = new Date().toISOString();
    if (Math.random() < 0.05) r.battery = Math.max(5, r.battery - 1);
    const mdt = db.mdts.find((m) => m.callsign_id === r.callsign_id);
    if (mdt) { mdt.lat = r.lat; mdt.lon = r.lon; }
    db.locations.push({ id: nextId('locations'), radio_id: r.id, lat: r.lat, lon: r.lon, speed: r.speed, heading: r.heading, at: r.last_seen });
    if (db.locations.length > 20000) db.locations.shift();
    broadcast('radio.location_changed', publicRadio(r));
  }
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
function start() {
  const restored = store.load();
  if (restored) console.log(`[cccs] state restored from ${store.file}`);
  else { seed(); store.flushNow(); }
  if (SIMULATION) setInterval(simulationTick, 2000).unref?.();
  setInterval(welfareTick, WELFARE_TICK_MS).unref?.();
  if (process.env.RETENTION !== 'off') {
    retentionSweep();
    setInterval(retentionSweep, 6 * 60 * 60 * 1000).unref?.();
  }
  server.listen(PORT, HOST, () => {
    console.log(`\n  CCCS POC — simulation only, not for operational use`);
    console.log(`  Control Room : http://localhost:${PORT}/control.html`);
    console.log(`  Radio        : http://localhost:${PORT}/radio.html`);
    console.log(`  MDT          : http://localhost:${PORT}/mdt.html`);
    console.log(`  Demo logins  : dispatcher/dispatch123 · radio101/radio123 · mdt001/mdt123 · admin/admin123`);
    console.log(`  Storage      : ${store.enabled ? store.file : 'in memory only (PERSISTENCE=off)'}`);
    console.log(`  Microsoft SSO: ${MS_ENABLED ? 'enabled (tenant ' + MS_TENANT_ID + ')' : 'not configured — set MS_TENANT_ID/MS_CLIENT_ID/MS_CLIENT_SECRET/MS_REDIRECT_URI'}\n`);
  });
}

if (require.main === module) start();
module.exports = { server, db, seq, store, start, seed, retentionSweep, RETENTION, hashPassword, verifyPassword, sign, PORT };
