/* deploy/migrate-shifts-to-assignments.js against a single-assignment
 * shifts database — node --test
 *
 * Builds a minimal pre-rework database in the store.js layout, runs the
 * real script on it, and checks the parts that matter most: a shift's
 * person, clock times and duty-supervisor flag survive into its new
 * shift_assignments row, the old status maps onto the right pair of new
 * statuses, and a stray role_type is either matched to a real type or kept
 * as readable text rather than silently dropped. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const SCRIPT = path.join(__dirname, '..', 'deploy', 'migrate-shifts-to-assignments.js');

function oldDb(extra = {}) {
  const file = path.join(os.tmpdir(), `cccs-migrate-shifts-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  const d = new DatabaseSync(file);
  d.exec(`CREATE TABLE collections (name TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
          CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
          CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const data = {
    personnel: [{ id: 1, name: 'Dan Whitfield' }, { id: 2, name: 'Ryan Cole' }],
    shifts: [],
    shift_assignments: [],
    shift_types: [],
    ...extra,
  };
  const put = d.prepare('INSERT INTO collections VALUES (?,?,?)');
  for (const [k, v] of Object.entries(data)) put.run(k, JSON.stringify(v), new Date().toISOString());
  d.close();
  return file;
}
const run = (file) => spawnSync(process.execPath, [SCRIPT, '--db', file, '--service-is-stopped'], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
const read = (file, name) => { const d = new DatabaseSync(file); const r = JSON.parse(d.prepare('SELECT payload FROM collections WHERE name=?').get(name).payload); d.close(); return r; };

test('a clocked-in shift becomes an in-progress shift with a confirmed, clocked-in assignment', () => {
  const file = oldDb({ shifts: [{
    id: 1, personnel_id: 1, site_id: null, is_duty_supervisor: false, status: 'CLOCKED_IN',
    starts_at: '2026-01-01T09:00:00.000Z', ends_at: '2026-01-01T17:00:00.000Z',
    clocked_in_at: '2026-01-01T09:02:00.000Z', clocked_out_at: null, role_type: '', notes: '', created_at: '2026-01-01T00:00:00.000Z',
  }] });
  const r = run(file);
  assert.equal(r.status, 0, r.stderr);
  const shift = read(file, 'shifts').find((s) => s.id === 1);
  assert.equal(shift.status, 'IN_PROGRESS');
  assert.equal(shift.personnel_id, undefined, 'the old field is gone, not just unused');
  assert.equal(shift.shift_type_id, read(file, 'shift_types').find((t) => t.key === 'GENERAL').id);
  const a = read(file, 'shift_assignments').find((x) => x.shift_id === 1);
  assert.equal(a.personnel_id, 1);
  assert.equal(a.status, 'CONFIRMED');
  assert.equal(a.clocked_in_at, '2026-01-01T09:02:00.000Z');
  assert.equal(a.clocked_out_at, null);
  assert.match(run(file).stdout, /nothing to change/, 'running again changes nothing');
  fs.unlinkSync(file);
});

test('a clocked-out shift is completed with an attended assignment, and NO_SHOW carries through as attendance', () => {
  const file = oldDb({ shifts: [
    { id: 1, personnel_id: 1, status: 'CLOCKED_OUT', starts_at: '2026-01-01T09:00:00.000Z', ends_at: '2026-01-01T17:00:00.000Z',
      clocked_in_at: '2026-01-01T09:00:00.000Z', clocked_out_at: '2026-01-01T17:05:00.000Z' },
    { id: 2, personnel_id: 2, status: 'NO_SHOW', starts_at: '2026-01-02T09:00:00.000Z', ends_at: '2026-01-02T17:00:00.000Z' },
  ] });
  assert.equal(run(file).status, 0);
  const shifts = read(file, 'shifts');
  const assignments = read(file, 'shift_assignments');
  assert.equal(shifts.find((s) => s.id === 1).status, 'COMPLETED');
  assert.equal(assignments.find((a) => a.shift_id === 1).attendance, 'ATTENDED');
  assert.equal(shifts.find((s) => s.id === 2).status, 'COMPLETED');
  assert.equal(assignments.find((a) => a.shift_id === 2).attendance, 'NO_SHOW');
  fs.unlinkSync(file);
});

test('a duty-supervisor flag and a role_type matching a real shift type both carry across', () => {
  const file = oldDb({
    shift_types: [{ id: 1, key: 'MOBILE_PATROL', name: 'Mobile Patrol', color: '#059669', active: true }],
    shifts: [{ id: 1, personnel_id: 2, is_duty_supervisor: true, status: 'SCHEDULED', role_type: 'mobile patrol',
      starts_at: '2026-01-01T09:00:00.000Z', ends_at: '2026-01-01T17:00:00.000Z' }],
  });
  assert.equal(run(file).status, 0);
  const shift = read(file, 'shifts').find((s) => s.id === 1);
  assert.equal(shift.shift_type_id, 1, 'matched case-insensitively to the existing type, not duplicated');
  assert.equal(shift.status, 'PUBLISHED');
  const a = read(file, 'shift_assignments').find((x) => x.shift_id === 1);
  assert.equal(a.is_duty_supervisor, true);
  assert.equal(a.status, 'ASSIGNED');
  fs.unlinkSync(file);
});

test('a role_type matching no known type is kept in notes rather than guessed, and the shift is typed GENERAL', () => {
  const file = oldDb({ shifts: [{ id: 1, personnel_id: 1, status: 'SCHEDULED', role_type: 'Cover for Dan', notes: 'Bring keys',
    starts_at: '2026-01-01T09:00:00.000Z', ends_at: '2026-01-01T17:00:00.000Z' }] });
  assert.equal(run(file).status, 0);
  const shift = read(file, 'shifts').find((s) => s.id === 1);
  assert.equal(shift.shift_type_id, read(file, 'shift_types').find((t) => t.key === 'GENERAL').id);
  assert.match(shift.notes, /Bring keys/);
  assert.match(shift.notes, /Cover for Dan/);
  fs.unlinkSync(file);
});

test('a cancelled shift keeps its person out of the active roster', () => {
  const file = oldDb({ shifts: [{ id: 1, personnel_id: 1, status: 'CANCELLED',
    starts_at: '2026-01-01T09:00:00.000Z', ends_at: '2026-01-01T17:00:00.000Z' }] });
  assert.equal(run(file).status, 0);
  const shift = read(file, 'shifts').find((s) => s.id === 1);
  assert.equal(shift.status, 'CANCELLED');
  const a = read(file, 'shift_assignments').find((x) => x.shift_id === 1);
  assert.equal(a.status, 'REMOVED', 'removed, not left active, so it never counts toward coverage');
  fs.unlinkSync(file);
});
