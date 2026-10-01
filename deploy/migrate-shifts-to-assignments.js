#!/usr/bin/env node
/**
 * One-off migration: single-assignment shifts (shift.personnel_id inline) →
 * the shift-as-slot + shift_assignments shape the rota-rework code expects.
 *
 *   node deploy/migrate-shifts-to-assignments.js --dry-run
 *   node deploy/migrate-shifts-to-assignments.js
 *   node deploy/migrate-shifts-to-assignments.js --db /path/to.db
 *
 * WHY IT EXISTS. The old code kept exactly one person on a shift via
 * shift.personnel_id, plus is_duty_supervisor/status/clocked_in_at/
 * clocked_out_at on the shift itself. The new code lets a shift carry
 * several people (required_headcount), so all of that per-person state
 * moves to its own shift_assignments row, and the shift keeps only what's
 * true of the slot as a whole (site, time window, headcount, shift type).
 *
 * Unlike migrate-radio-users.js, the new code can boot against old-shaped
 * shift rows without crashing — a shift with no shift_type_id or
 * shift_assignments just renders as unfilled — so this is safe to run
 * either before or after the new code's first boot. It finds-or-creates
 * the six default shift types itself, matched by key, so it never
 * duplicates ones the new code already seeded on boot.
 *
 * OLD STATUS → NEW SHAPE, most specific first:
 *   CLOCKED_IN  → shift.status IN_PROGRESS, assignment.clocked_in_at set
 *   CLOCKED_OUT → shift.status COMPLETED,   assignment clocked in+out, attendance ATTENDED
 *   NO_SHOW     → shift.status COMPLETED,   assignment.attendance NO_SHOW
 *   CANCELLED   → shift.status CANCELLED,   assignment.status REMOVED
 *   CONFIRMED   → shift.status PUBLISHED,   assignment.status CONFIRMED
 *   SCHEDULED   → shift.status PUBLISHED,   assignment.status ASSIGNED
 * The old free-text role_type is matched against a shift type's name
 * (case-insensitive); no match keeps the text in the shift's notes instead
 * of guessing, and the shift is typed GENERAL.
 *
 * Idempotent: a shift that already has a shift_assignments row is left
 * untouched, so running this twice changes nothing. Zero dependencies.
 */
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { console.error('node:sqlite is required (Node 22+)'); process.exit(2); }

process.on('uncaughtException', (e) => { console.error(`STOPPED: ${e.message}\nNothing was written.`); process.exit(1); });

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const dbPath = args.includes('--db') ? args[args.indexOf('--db') + 1] : (process.env.DATA_FILE || '/var/lib/cccs/cccs.db');
const service = args.includes('--service') ? args[args.indexOf('--service') + 1] : 'cccs';

if (!fs.existsSync(dbPath)) { console.error(`no database at ${dbPath}`); process.exit(2); }

if (!DRY && !args.includes('--service-is-stopped')) {
  let active = false;
  try { active = execFileSync('systemctl', ['is-active', service], { encoding: 'utf8' }).trim() === 'active'; } catch {}
  if (active) { console.error(`STOPPED: service ${service} is running. Stop it first (systemctl stop ${service}).`); process.exit(1); }
}

const sql = new DatabaseSync(dbPath);
const read = (name) => { const r = sql.prepare('SELECT payload FROM collections WHERE name = ?').get(name); return r ? JSON.parse(r.payload) : []; };
const counters = Object.fromEntries(sql.prepare('SELECT name, value FROM counters').all().map((r) => [r.name, r.value]));

const shifts = read('shifts');
const shiftAssignments = read('shift_assignments');
const shiftTypes = read('shift_types');
const personnel = read('personnel');

const changes = [];
const note = (s) => changes.push(s);
const pname = (id) => (personnel.find((p) => p.id === id) || {}).name || `#${id}`;

let nextTypeId = Math.max(counters.shift_types || 0, ...shiftTypes.map((t) => t.id), 0);
let nextAssignmentId = Math.max(counters.shift_assignments || 0, ...shiftAssignments.map((a) => a.id), 0);

/* ---- 1. shift types — find-or-create the six defaults by key ---- */
const DEFAULT_TYPES = [
  ['CONTROL_ROOM', 'Control Room', '#2563eb'], ['MOBILE_PATROL', 'Mobile Patrol', '#059669'],
  ['ALARM_RESPONSE', 'Alarm Response', '#dc2626'], ['EVENT', 'Event', '#7c3aed'],
  ['STATIC_GUARD', 'Static Guard', '#d97706'], ['GENERAL', 'General', '#6b7280'],
];
for (const [key, name, color] of DEFAULT_TYPES) {
  if (shiftTypes.some((t) => t.key === key)) continue;
  shiftTypes.push({ id: ++nextTypeId, key, name, color, active: true, created_at: new Date().toISOString() });
  note(`shift type ${key} did not exist — created`);
}
const typeByName = (name) => shiftTypes.find((t) => t.name.toLowerCase() === String(name || '').trim().toLowerCase());
const generalType = shiftTypes.find((t) => t.key === 'GENERAL');

/* ---- 2. shifts → shift + shift_assignment ---- */
let migrated = 0, skipped = 0, bare = 0;
for (const s of shifts) {
  if (shiftAssignments.some((a) => a.shift_id === s.id)) { skipped++; continue; }
  if (s.personnel_id == null) {
    bare++;
    if (!s.shift_type_id) { s.shift_type_id = generalType.id; note(`shift #${s.id}: no personnel_id and no type — set GENERAL`); }
    continue;
  }
  const oldStatus = s.status;
  let shiftStatus, assignmentStatus, attendance = null;
  switch (oldStatus) {
    case 'CLOCKED_IN': shiftStatus = 'IN_PROGRESS'; assignmentStatus = 'CONFIRMED'; break;
    case 'CLOCKED_OUT': shiftStatus = 'COMPLETED'; assignmentStatus = 'CONFIRMED'; attendance = 'ATTENDED'; break;
    case 'NO_SHOW': shiftStatus = 'COMPLETED'; assignmentStatus = 'CONFIRMED'; attendance = 'NO_SHOW'; break;
    case 'CANCELLED': shiftStatus = 'CANCELLED'; assignmentStatus = 'REMOVED'; break;
    case 'CONFIRMED': shiftStatus = 'PUBLISHED'; assignmentStatus = 'CONFIRMED'; break;
    case 'SCHEDULED': default: shiftStatus = 'PUBLISHED'; assignmentStatus = 'ASSIGNED'; break;
  }
  let leftoverNote = '';
  let type = s.role_type ? typeByName(s.role_type) : null;
  if (s.role_type && !type) leftoverNote = s.role_type;
  if (!type) type = generalType;

  const a = {
    id: ++nextAssignmentId, shift_id: s.id, personnel_id: s.personnel_id,
    role_on_shift: '', is_duty_supervisor: Boolean(s.is_duty_supervisor), status: assignmentStatus,
    confirmed_at: assignmentStatus === 'CONFIRMED' ? (s.created_at || new Date().toISOString()) : null,
    attendance, clocked_in_at: s.clocked_in_at || null, clocked_out_at: s.clocked_out_at || null,
    created_by: s.created_by ?? null, created_at: s.created_at || new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  shiftAssignments.push(a);

  s.shift_type_id = type.id;
  s.status = shiftStatus;
  s.required_headcount = s.required_headcount || 1;
  s.break_minutes = s.break_minutes || 0;
  s.pay_rate = s.pay_rate ?? null;
  s.bill_rate = s.bill_rate ?? null;
  s.uniform_ppe = s.uniform_ppe || '';
  s.briefing = s.briefing || '';
  s.detail = s.detail || {};
  s.template_id = s.template_id || null;
  if (leftoverNote) s.notes = s.notes ? `${s.notes} (${leftoverNote})` : leftoverNote;
  delete s.personnel_id; delete s.role_type; delete s.is_duty_supervisor; delete s.clocked_in_at; delete s.clocked_out_at;

  note(`shift #${s.id}: ${pname(a.personnel_id)} → shift_assignment #${a.id} (${oldStatus} → shift ${shiftStatus} / assignment ${assignmentStatus}${leftoverNote ? `, role_type "${leftoverNote}" kept in notes` : ''}, type ${type.key})`);
  migrated++;
}

console.log(`${DRY ? 'DRY RUN — nothing written' : 'MIGRATING'}: ${dbPath}`);
console.log(changes.length ? changes.map((c) => '  • ' + c).join('\n') : '  • nothing to change (already migrated?)');
console.log(`${migrated} shift(s) migrated, ${skipped} already migrated, ${bare} had no personnel_id.`);

if (!DRY && changes.length) {
  const put = sql.prepare('INSERT INTO collections(name,payload,updated_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at');
  const now = new Date().toISOString();
  sql.exec('BEGIN');
  try {
    for (const [name, rows] of Object.entries({ shifts, shift_assignments: shiftAssignments, shift_types: shiftTypes })) put.run(name, JSON.stringify(rows), now);
    sql.prepare('INSERT INTO counters(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run('shift_types', nextTypeId);
    sql.prepare('INSERT INTO counters(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run('shift_assignments', nextAssignmentId);
    sql.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('migrated_shifts_to_assignments_at', now);
    sql.exec('COMMIT');
  } catch (e) { sql.exec('ROLLBACK'); throw e; }
  console.log(`Done. ${changes.length} change(s) written in one transaction.`);
}
sql.close();
