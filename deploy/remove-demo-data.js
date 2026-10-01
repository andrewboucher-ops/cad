#!/usr/bin/env node
/**
 * Removes the built-in DEMO data (the sample sites, officers, vehicles, call
 * signs, MDTs and logins server.js seed() creates when there is no
 * seed.json) from a live CCCS database, and everything hanging off them —
 * their shifts, jobs, visits, messages, fuel logs, test reports and so on.
 *
 *   node deploy/remove-demo-data.js --dry-run      # list what would go (default if run by hand)
 *   node deploy/remove-demo-data.js --apply        # do it (service must be stopped)
 *   node deploy/remove-demo-data.js --db /path     # default: $DATA_FILE or /var/lib/cccs/cccs.db
 * Normally run through deploy/remove-demo-data.sh, which previews, asks,
 * stops the service, backs up, applies and restarts.
 *
 * WHAT COUNTS AS DEMO — an exact match on what seed() writes, never a guess:
 * a site needs its demo name AND address, a person their demo name AND rank,
 * a vehicle its registration AND type, an MDT its serial, a login its
 * username AND display name (or a login linked to a demo person — that is
 * how the renamed radio accounts are caught). Anything you created yourself
 * cannot match.
 *
 * WHAT IS NEVER REMOVED:
 *   - any SYSTEM_ADMIN login (you would be locked out). If the demo 'admin'
 *     still has the demo password admin123 that is reported loudly instead;
 *   - a demo call sign or vehicle still used by one of YOUR people or MDTs;
 *   - the audit log: it is the record of what happened, demo or not;
 *   - form definitions (the forms themselves), clients, branches, courses.
 * Records of yours that merely point at something removed are kept and the
 * pointer cleared (a client loses the demo site from its list, an asset is
 * un-assigned from a demo officer).
 *
 * Idempotent: a second run finds nothing. Zero dependencies.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { console.error('node:sqlite is required (Node 22+)'); process.exit(2); }
process.on('uncaughtException', (e) => { console.error(`STOPPED: ${e.message}\nNothing was written.`); process.exit(1); });

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const dbPath = args.includes('--db') ? args[args.indexOf('--db') + 1] : (process.env.DATA_FILE || '/var/lib/cccs/cccs.db');
const service = args.includes('--service') ? args[args.indexOf('--service') + 1] : 'cccs';
const uploadsDir = args.includes('--uploads') ? args[args.indexOf('--uploads') + 1] : (process.env.UPLOADS_DIR || path.join(path.dirname(dbPath), 'uploads'));
if (!fs.existsSync(dbPath)) { console.error(`no database at ${dbPath}`); process.exit(2); }

// The running service holds everything in memory and writes it back every
// second — changes made under it would simply be overwritten.
if (APPLY && !args.includes('--service-is-stopped')) {
  let active = false;
  try { active = execFileSync('systemctl', ['is-active', service], { encoding: 'utf8' }).trim() === 'active'; } catch {}
  if (active) throw new Error(`service ${service} is running. Stop it first (systemctl stop ${service}).`);
}

/* ---- exactly what seed() creates ---- */
const DEMO = {
  sites: [['Meridian Business Park', 'Unit 4, Meridian Way'], ['Carlton Retail Centre', '18 Carlton Road'], ['Northgate Distribution', 'Northgate Industrial Estate'], ['Ashcroft House', '112 Ashcroft Lane']],
  vehicles: [['VAN-101', 'Patrol van'], ['VAN-102', 'Patrol van'], ['VAN-103', 'Patrol van'], ['CAR-201', 'Response car']],
  callsigns: [['P101', 'Mobile patrol, north'], ['P102', 'Mobile patrol, north'], ['P103', 'Mobile patrol, south'], ['P104', 'Static guard, Meridian'], ['M201', 'Alarm response'], ['M202', 'Alarm response'], ['CONTROL', 'Control room'], ['SUPERVISOR', 'Duty supervisor']],
  personnel: [['Dan Whitfield', 'Patrol officer'], ['Sam Oduya', 'Patrol officer'], ['Ellie Marsh', 'Patrol officer'], ['Ryan Cole', 'Response officer'], ['Jo Vance', 'Static guard']],
  mdts: ['SN-MDT-0001', 'SN-MDT-0002', 'SN-MDT-0003'],
  users: [['dispatcher', 'Controller Hale'], ['supervisor', 'Supervisor Reid'], ['dwhitfield', 'Dan Whitfield'], ['emarsh', 'Ellie Marsh'], ['rcole', 'Ryan Cole'], ['mdt001', 'MDT-001 Operator']],
};

const sql = new DatabaseSync(dbPath);
const names = sql.prepare('SELECT name FROM collections').all().map((r) => r.name);
const data = {};
for (const n of names) { try { data[n] = JSON.parse(sql.prepare('SELECT payload FROM collections WHERE name = ?').get(n).payload); } catch { data[n] = null; } }
const col = (n) => (Array.isArray(data[n]) ? data[n] : []);

const pick = (rows, test) => new Set(rows.filter(test).map((r) => r.id));
const sites = pick(col('sites'), (s) => DEMO.sites.some(([n, a]) => s.name === n && s.address === a));
const personnel = pick(col('personnel'), (p) => DEMO.personnel.some(([n, r]) => p.name === n && p.rank === r));
const mdts = pick(col('mdts'), (m) => DEMO.mdts.includes(m.serial));
let vehicles = pick(col('vehicles'), (v) => DEMO.vehicles.some(([r, t]) => v.registration === r && v.type === t));
let callsigns = pick(col('callsigns'), (c) => DEMO.callsigns.some(([n, d]) => c.name === n && c.description === d));
const users = pick(col('users'), (u) => u.role !== 'SYSTEM_ADMIN'
  && (DEMO.users.some(([n, d]) => (u.username === n || u.previous_username === n) && u.display_name === d) || (u.personnel_id && personnel.has(u.personnel_id))));

// An admin linked to a demo person keeps that person (and so their login works).
const keptBecause = [];
for (const u of col('users')) if (u.role === 'SYSTEM_ADMIN' && u.personnel_id && personnel.has(u.personnel_id)) { personnel.delete(u.personnel_id); keptBecause.push(`person #${u.personnel_id} — linked to admin login ${u.username}`); }
// A demo call sign or vehicle still used by something of yours stays.
for (const p of col('personnel').filter((x) => !personnel.has(x.id))) {
  if (callsigns.delete(p.callsign_id)) keptBecause.push(`call sign #${p.callsign_id} — used by ${p.name}`);
  if (vehicles.delete(p.vehicle_id)) keptBecause.push(`vehicle #${p.vehicle_id} — used by ${p.name}`);
}
for (const m of col('mdts').filter((x) => !mdts.has(x.id))) {
  if (callsigns.delete(m.callsign_id)) keptBecause.push(`call sign #${m.callsign_id} — used by MDT ${m.mdt_code}`);
  if (vehicles.delete(m.vehicle_id)) keptBecause.push(`vehicle #${m.vehicle_id} — used by MDT ${m.mdt_code}`);
}

/* ---- what hangs off them ---- */
const shifts = pick(col('shifts'), (s) => sites.has(s.site_id));
const visits = pick(col('site_visits'), (v) => sites.has(v.site_id) || (personnel.has(v.personnel_id) && !(v.additional_personnel || []).some((id) => !personnel.has(id))));
// A job goes if it was at a demo site, or every resource on it was demo.
const jobs = pick(col('jobs'), (j) => {
  if (sites.has(j.site_id)) return true;
  const a = col('job_assignments').filter((x) => x.job_id === j.id);
  return a.length > 0 && a.every((x) => (x.personnel_id ? personnel.has(x.personnel_id) : mdts.has(x.mdt_id)));
});
const subjectGone = (s) => ({ SITE: sites, VEHICLE: vehicles, PERSONNEL: personnel, JOB: jobs, SITE_VISIT: visits }[s.subject_type] || new Set()).has(s.subject_id);
const submissions = pick(col('form_submissions'), (s) => subjectGone(s) || users.has(s.submitted_by_user_id) || personnel.has(s.submitted_by_personnel_id));

const any = (set, ...vals) => vals.some((v) => v != null && set.has(v));
const RULES = {
  sites: (r) => sites.has(r.id), personnel: (r) => personnel.has(r.id), vehicles: (r) => vehicles.has(r.id),
  callsigns: (r) => callsigns.has(r.id), mdts: (r) => mdts.has(r.id), users: (r) => users.has(r.id),
  shifts: (r) => shifts.has(r.id), site_visits: (r) => visits.has(r.id), jobs: (r) => jobs.has(r.id),
  form_submissions: (r) => submissions.has(r.id),
  beats: (r) => sites.has(r.site_id), patrol_schedules: (r) => sites.has(r.site_id), passdown_logs: (r) => sites.has(r.site_id),
  documents: (r) => sites.has(r.site_id),
  shift_assignments: (r) => shifts.has(r.shift_id) || personnel.has(r.personnel_id),
  shift_applications: (r) => shifts.has(r.shift_id) || personnel.has(r.personnel_id),
  shift_vehicle_allocations: (r) => shifts.has(r.shift_id) || vehicles.has(r.vehicle_id),
  shift_asset_allocations: (r) => shifts.has(r.shift_id),
  job_assignments: (r) => jobs.has(r.job_id) || personnel.has(r.personnel_id) || mdts.has(r.mdt_id),
  locations: (r) => any(personnel, r.personnel_id) || any(mdts, r.mdt_id),
  messages: (r) => any(personnel, r.to_personnel_id, r.from_personnel_id) || any(mdts, r.to_mdt_id, r.from_mdt_id),
  emergency_events: (r) => any(personnel, r.personnel_id) || any(mdts, r.mdt_id),
  call_requests: (r) => any(mdts, r.mdt_id) || any(personnel, r.personnel_id),
  dial_log: (r) => any(personnel, r.personnel_id),
  fuel_logs: (r) => vehicles.has(r.vehicle_id), maintenance_logs: (r) => vehicles.has(r.vehicle_id),
  training_records: (r) => personnel.has(r.personnel_id), leave_requests: (r) => personnel.has(r.personnel_id),
  push_subscriptions: (r) => users.has(r.user_id), form_grants: (r) => users.has(r.user_id),
};
// Your records that only POINT at something removed: keep them, clear the pointer.
const CLEAR = [
  ['personnel', 'vehicle_id', vehicles], ['personnel', 'callsign_id', callsigns], ['personnel', 'supervisor_id', personnel], ['personnel', 'user_id', users],
  ['mdts', 'vehicle_id', vehicles], ['mdts', 'callsign_id', callsigns],
  ['vehicles', 'assigned_personnel_id', personnel], ['assets', 'assigned_to', personnel],
  ['users', 'personnel_id', personnel], ['users', 'mdt_id', mdts],
  ['fuel_logs', 'personnel_id', personnel],
];

const report = [];
for (const [name, test] of Object.entries(RULES)) {
  const rows = col(name); const gone = rows.filter(test);
  if (!gone.length) continue;
  report.push([name, gone]);
  data[name] = rows.filter((r) => !test(r));
}
let cleared = 0;
for (const [name, field, set] of CLEAR) for (const r of col(name)) if (r[field] != null && set.has(r[field])) { r[field] = null; cleared++; }
for (const c of col('clients')) if (Array.isArray(c.site_ids) && c.site_ids.some((id) => sites.has(id))) { c.site_ids = c.site_ids.filter((id) => !sites.has(id)); cleared++; }
for (const v of col('site_visits')) if (Array.isArray(v.additional_personnel) && v.additional_personnel.some((id) => personnel.has(id))) { v.additional_personnel = v.additional_personnel.filter((id) => !personnel.has(id)); cleared++; }

/* ---- report ---- */
const label = (name, r) => r.name || r.registration || r.username || r.mdt_code || r.reference || r.title || `#${r.id}`;
const total = report.reduce((n, [, rows]) => n + rows.length, 0);
console.log(`${APPLY ? 'REMOVING' : 'Would remove'} ${total} demo record(s) from ${dbPath}:`);
for (const [name, rows] of report) {
  const shown = ['sites', 'personnel', 'vehicles', 'callsigns', 'mdts', 'users'].includes(name) ? `: ${rows.map((r) => label(name, r)).join(', ')}` : '';
  console.log(`  ${name.padEnd(26)} ${String(rows.length).padStart(5)}${shown}`);
}
if (!total) console.log('  nothing — no demo data found.');
if (cleared) console.log(`  + ${cleared} link(s) on your own records cleared`);
for (const k of keptBecause) console.log(`  kept: ${k}`);
const admin = col('users').find((u) => u.username === 'admin' && u.role === 'SYSTEM_ADMIN');
if (admin && admin.password_hash) {
  try {
    // Same format as server.js hashPassword(): scrypt$<salt>$<hash>.
    const [kind, salt, hash] = String(admin.password_hash).split('$');
    if (kind === 'scrypt' && salt && hash && crypto.scryptSync('admin123', salt, 32).toString('hex') === hash) {
      console.log('\n  !! The "admin" login still has the DEMO password admin123. It is kept (removing it could lock you out),');
      console.log('  !! but change it now: sign in as admin → My settings, or Admin → Accounts.');
    }
  } catch {}
}
console.log('  (the audit log, your forms, clients, branches and courses are not touched)');

if (!APPLY) { console.log('\nDry run — nothing written.'); process.exit(0); }
if (!total && !cleared) process.exit(0);

// Our own copy first, whatever the caller did: a point to go back to.
const backup = `${dbPath}.before-demo-removal-${new Date().toISOString().replace(/[:.]/g, '-')}`;
sql.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
console.log(`\nBackup written: ${backup}`);
const put = sql.prepare('UPDATE collections SET payload = ?, updated_at = ? WHERE name = ?');
const now = new Date().toISOString();
sql.exec('BEGIN');
try {
  for (const n of names) if (Array.isArray(data[n])) put.run(JSON.stringify(data[n]), now, n);
  sql.exec('COMMIT');
} catch (e) { sql.exec('ROLLBACK'); throw e; }
// Photos and signatures on the removed test reports.
for (const s of submissions) { try { fs.rmSync(path.join(uploadsDir, 'forms', String(s)), { recursive: true, force: true }); } catch {} }
console.log('Done.');
