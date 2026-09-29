#!/usr/bin/env node
/**
 * One-off migration: a pre-pivot (radio-era) CCCS database → the shape the
 * post-pivot code expects. Run it with the service STOPPED, immediately
 * before deploying the new code:
 *
 *   node deploy/migrate-radio-users.js --dry-run           # prints every change
 *   node deploy/migrate-radio-users.js                     # applies them
 *   node deploy/migrate-radio-users.js --db /path/to.db    # default: $DATA_FILE
 *
 * WHY IT EXISTS. The new code knows no RADIO_USER role; an account left on it
 * simply fails to sign in, with no clear error. Each one becomes a FIELD_USER
 * tied to a personnel row, keeping its username and password hash, so the
 * officer signs in exactly as before.
 *
 * WHAT ELSE MOVES, and why each matters:
 *   - a RUNNING WELFARE TIMER on a radio moves to the person. The new code
 *     evaluates timers on personnel only; dropping one here would be a lone
 *     worker nobody is watching. If a running timer cannot be matched to a
 *     person the migration REFUSES to run at all.
 *   - open job assignments, unresolved emergencies, messages and location
 *     fixes keyed by radio_id gain the matching personnel_id, so control
 *     still sees who is on a job or in trouble.
 * Radio-only collections (radios, talkgroups, calls...) are left in the file
 * untouched: the new code never reads them, and keeping them costs nothing if
 * a rollback to the old code is needed.
 *
 * HOW A RADIO BECOMES A PERSON, most specific first:
 *   1. the radio's account display name matches a person on the radio's call
 *      sign (the normal case: 'radio101' is 'Dan Whitfield' on P101);
 *   2. the display name matches exactly one person anywhere;
 *   3. otherwise a personnel row is created from the display name, on the
 *      radio's call sign — never guessed from "first person on the call sign".
 * A radio with no account maps to a person only if its call sign has exactly
 * one person; otherwise its rows keep radio_id alone and are reported.
 *
 * Idempotent: run twice, the second run changes nothing. Zero dependencies.
 */
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { console.error('node:sqlite is required (Node 22+)'); process.exit(2); }

// Any refusal below is a thrown Error: report it plainly, write nothing.
process.on('uncaughtException', (e) => { console.error(`STOPPED: ${e.message}\nNothing was written.`); process.exit(1); });

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const dbPath = args.includes('--db') ? args[args.indexOf('--db') + 1] : (process.env.DATA_FILE || '/var/lib/cccs/cccs.db');
const service = args.includes('--service') ? args[args.indexOf('--service') + 1] : 'cccs';

if (!fs.existsSync(dbPath)) { console.error(`no database at ${dbPath}`); process.exit(2); }

// A running service holds the whole state in memory and writes it back every
// second: a migration under it would be overwritten, and the old code would
// meanwhile meet FIELD_USER accounts it cannot handle. Only a dry run may
// proceed with it running.
if (!DRY && !args.includes('--service-is-stopped')) {
  let active = false;
  try { active = execFileSync('systemctl', ['is-active', service], { encoding: 'utf8' }).trim() === 'active'; } catch {}
  if (active) { console.error(`STOPPED: service ${service} is running. Stop it first (systemctl stop ${service}).`); process.exit(1); }
}

const sql = new DatabaseSync(dbPath);
const read = (name) => { const r = sql.prepare('SELECT payload FROM collections WHERE name = ?').get(name); return r ? JSON.parse(r.payload) : []; };
const counters = Object.fromEntries(sql.prepare('SELECT name, value FROM counters').all().map((r) => [r.name, r.value]));

const users = read('users'), radios = read('radios'), personnel = read('personnel'), callsigns = read('callsigns');
const jobs = read('jobs'), assignments = read('job_assignments'), emergencies = read('emergency_events');
const messages = read('messages'), locations = read('locations');

const changes = [];
const note = (s) => changes.push(s);
const lc = (s) => String(s || '').trim().toLowerCase();
const csName = (id) => (callsigns.find((c) => c.id === id) || {}).name || '(no call sign)';
let nextPersonnelId = Math.max(counters.personnel || 0, ...personnel.map((p) => p.id), 0);

/* ---- 1. accounts --------------------------------------------------- */
const personForRadio = new Map(); // radio id -> personnel id
for (const u of users.filter((x) => x.role === 'RADIO_USER')) {
  const radio = radios.find((r) => r.id === u.radio_id) || null;
  const name = u.display_name || u.username;
  let p = radio ? personnel.find((x) => x.callsign_id === radio.callsign_id && lc(x.name) === lc(name)) : null;
  let how = 'name on call sign';
  if (!p) { const byName = personnel.filter((x) => lc(x.name) === lc(name)); if (byName.length === 1) { p = byName[0]; how = 'name'; } }
  if (!p) {
    p = { id: ++nextPersonnelId, name, rank: '', callsign_id: radio ? radio.callsign_id : null };
    personnel.push(p); how = 'CREATED';
  }
  if (p.user_id && p.user_id !== u.id) throw new Error(`${p.name} is already linked to user ${p.user_id}; resolve by hand before migrating`);
  note(`account ${u.username}: RADIO_USER → FIELD_USER, person #${p.id} ${p.name} (${how}; radio ${radio ? radio.issi + ' / ' + csName(radio.callsign_id) : 'none'})`);
  u.role = 'FIELD_USER'; u.personnel_id = p.id; delete u.radio_id;
  p.user_id = u.id;
  if (radio) personForRadio.set(radio.id, p.id);
}

// Radios without an account: only an unambiguous call sign maps.
for (const r of radios) {
  if (personForRadio.has(r.id)) continue;
  const onCs = personnel.filter((p) => p.callsign_id === r.callsign_id && r.callsign_id != null);
  if (onCs.length === 1) personForRadio.set(r.id, onCs[0].id);
}

// Fill the fields the new personnel shape carries, without touching any that exist.
for (const p of personnel) {
  const defaults = { employee_no: null, contact_phone: '', contact_email: '', employment_status: 'ACTIVE', user_id: null, vehicle_id: null,
    welfare_interval_s: null, welfare_due_at: null, welfare_warned: false, welfare_note: '', notes: '' };
  for (const [k, v] of Object.entries(defaults)) if (!(k in p)) p[k] = v;
}

/* ---- 2. running welfare timers -------------------------------------- */
for (const r of radios.filter((x) => x.welfare_due_at)) {
  const pid = personForRadio.get(r.id);
  if (!pid) throw new Error(`radio ${r.issi} (${csName(r.callsign_id)}) has a RUNNING welfare timer and no person it can be matched to — refusing to migrate, a lone worker would lose their timer. Resolve by hand.`);
  const p = personnel.find((x) => x.id === pid);
  if (p.welfare_due_at) { note(`welfare: ${p.name} already has a timer; radio ${r.issi}'s timer (due ${r.welfare_due_at}) not copied over it`); continue; }
  Object.assign(p, { welfare_interval_s: r.welfare_interval_s, welfare_due_at: r.welfare_due_at, welfare_warned: Boolean(r.welfare_warned), welfare_note: r.welfare_note || '' });
  note(`welfare: RUNNING timer moved from radio ${r.issi} to ${p.name}, due ${r.welfare_due_at}`);
}

/* ---- 3. rows keyed by radio ----------------------------------------- */
const closedJob = new Set(jobs.filter((j) => ['COMPLETED', 'CANCELLED'].includes(j.status)).map((j) => j.id));
const unmapped = new Set();
const mapRow = (row, field, target, label) => {
  if (row[field] == null || row[target] != null) return;
  const pid = personForRadio.get(row[field]);
  if (pid) { row[target] = pid; note(label(row, pid)); } else unmapped.add(`${label(row, null)}`);
};
const pname = (id) => (personnel.find((p) => p.id === id) || {}).name;
for (const a of assignments) {
  if (closedJob.has(a.job_id)) continue;
  mapRow(a, 'radio_id', 'personnel_id', (x, pid) => `open job #${x.job_id}: assignment ${pid ? '→ ' + pname(pid) : 'from radio ' + x.radio_id + ' has no person (left as call sign ' + csName(x.callsign_id) + ')'}`);
}
for (const e of emergencies) {
  if (e.state === 'RESOLVED') continue;
  mapRow(e, 'radio_id', 'personnel_id', (x, pid) => `${x.state} ${x.kind} #${x.id} (${x.callsign}) ${pid ? '→ ' + pname(pid) : 'has no person (still shown by call sign)'}`);
}
let msgs = 0, locs = 0;
for (const m of messages) {
  for (const [from, to] of [['to_radio_id', 'to_personnel_id'], ['from_radio_id', 'from_personnel_id']]) {
    if (m[from] != null && m[to] == null && personForRadio.has(m[from])) { m[to] = personForRadio.get(m[from]); msgs++; }
  }
}
for (const l of locations) if (l.radio_id != null && l.personnel_id == null && personForRadio.has(l.radio_id)) { l.personnel_id = personForRadio.get(l.radio_id); locs++; }
if (msgs) note(`messages: ${msgs} sender/recipient fields mapped from radio to person`);
if (locs) note(`locations: ${locs} fixes mapped from radio to person (so erasure-by-person still finds them)`);

/* ---- report / write -------------------------------------------------- */
const leftover = users.filter((u) => !['SYSTEM_ADMIN', 'DISPATCHER', 'SUPERVISOR', 'FIELD_USER', 'MDT_USER'].includes(u.role));
console.log(`${DRY ? 'DRY RUN — nothing written' : 'MIGRATING'}: ${dbPath}`);
console.log(changes.length ? changes.map((c) => '  • ' + c).join('\n') : '  • nothing to change (already migrated?)');
if (unmapped.size) console.log('  Left as-is (no person to map to):\n' + [...unmapped].map((c) => '    - ' + c).join('\n'));
if (leftover.length) { console.error(`STOPPED: accounts with other unknown roles: ${leftover.map((u) => u.username + '=' + u.role).join(', ')}`); process.exit(1); }

if (!DRY && changes.length) {
  const put = sql.prepare('INSERT INTO collections(name,payload,updated_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at');
  const now = new Date().toISOString();
  sql.exec('BEGIN');
  try {
    for (const [name, rows] of Object.entries({ users, personnel, job_assignments: assignments, emergency_events: emergencies, messages, locations })) put.run(name, JSON.stringify(rows), now);
    sql.prepare('INSERT INTO counters(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run('personnel', nextPersonnelId);
    sql.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('migrated_radio_users_at', now);
    sql.exec('COMMIT');
  } catch (e) { sql.exec('ROLLBACK'); throw e; }
  console.log(`Done. ${changes.length} change(s) written in one transaction.`);
}
sql.close();
