/* deploy/migrate-radio-users.js against a radio-era database — node --test
 *
 * Builds a minimal pre-pivot database in the store.js layout (one JSON
 * payload per collection), runs the real script on it, and checks the parts
 * that matter most: accounts keep their password, a running welfare timer is
 * never dropped, and a timer that cannot be matched stops the migration. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const SCRIPT = path.join(__dirname, '..', 'deploy', 'migrate-radio-users.js');

function oldDb(extra = {}) {
  const file = path.join(os.tmpdir(), `cccs-migrate-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  const d = new DatabaseSync(file);
  d.exec(`CREATE TABLE collections (name TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
          CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
          CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const data = {
    users: [
      { id: 1, username: 'dispatcher', role: 'DISPATCHER', password_hash: 'scrypt$a$b' },
      { id: 2, username: 'radio101', role: 'RADIO_USER', display_name: 'Dan Whitfield', radio_id: 1, password_hash: 'scrypt$keep$me' },
    ],
    callsigns: [{ id: 1, name: 'P101' }, { id: 2, name: 'M201' }],
    personnel: [{ id: 1, name: 'Dan Whitfield', rank: 'Patrol officer', callsign_id: 1 }, { id: 2, name: 'Sam Oduya', rank: 'Patrol officer', callsign_id: 1 }],
    radios: [{ id: 1, issi: '234100001', callsign_id: 1 }, { id: 2, issi: '234100005', callsign_id: 2 }],
    jobs: [{ id: 1, status: 'DISPATCHED' }],
    job_assignments: [{ id: 1, job_id: 1, radio_id: 1, callsign_id: 1 }],
    emergency_events: [{ id: 1, kind: 'EMERGENCY', radio_id: 1, callsign: 'P101', state: 'ACTIVE' }],
    ...extra,
  };
  const put = d.prepare('INSERT INTO collections VALUES (?,?,?)');
  for (const [k, v] of Object.entries(data)) put.run(k, JSON.stringify(v), new Date().toISOString());
  d.prepare('INSERT INTO counters VALUES (?,?)').run('personnel', 2);
  d.close();
  return file;
}
const run = (file) => spawnSync(process.execPath, [SCRIPT, '--db', file, '--service-is-stopped'], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
const read = (file, name) => { const d = new DatabaseSync(file); const r = JSON.parse(d.prepare('SELECT payload FROM collections WHERE name=?').get(name).payload); d.close(); return r; };

test('a radio account becomes an officer login on the right person, keeping its password', () => {
  const file = oldDb();
  const r = run(file);
  assert.equal(r.status, 0, r.stderr);
  const u = read(file, 'users').find((x) => x.username === 'radio101');
  assert.equal(u.role, 'FIELD_USER');
  assert.equal(u.personnel_id, 1, 'Dan by name on his call sign, not Sam who shares it');
  assert.equal(u.password_hash, 'scrypt$keep$me', 'the officer signs in with the same password');
  assert.equal(u.radio_id, undefined);
  const dan = read(file, 'personnel').find((p) => p.id === 1);
  assert.equal(dan.user_id, 2);
  assert.equal(dan.employment_status, 'ACTIVE', 'new-shape fields filled in');
  assert.equal(read(file, 'job_assignments')[0].personnel_id, 1, 'open job keeps its officer');
  assert.equal(read(file, 'emergency_events')[0].personnel_id, 1, 'an active emergency keeps its officer');
  assert.match(run(file).stdout, /nothing to change/, 'running again changes nothing');
  fs.unlinkSync(file);
});

test('a running welfare timer moves to the person, never dropped', () => {
  const due = new Date(Date.now() + 600e3).toISOString();
  const file = oldDb({ radios: [{ id: 1, issi: '234100001', callsign_id: 1, welfare_interval_s: 900, welfare_due_at: due, welfare_note: 'Roof check' }] });
  assert.equal(run(file).status, 0);
  const dan = read(file, 'personnel').find((p) => p.id === 1);
  assert.equal(dan.welfare_due_at, due);
  assert.equal(dan.welfare_interval_s, 900);
  assert.equal(dan.welfare_note, 'Roof check');
  fs.unlinkSync(file);
});

test('a running timer that cannot be matched to a person stops the migration, writing nothing', () => {
  const file = oldDb({ radios: [{ id: 1, issi: '234100001', callsign_id: 1 }, { id: 2, issi: '234100005', callsign_id: 2, welfare_interval_s: 600, welfare_due_at: new Date(Date.now() + 60e3).toISOString() }] });
  const r = run(file);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /RUNNING welfare timer.*refusing to migrate/);
  assert.equal(read(file, 'users').find((x) => x.username === 'radio101').role, 'RADIO_USER', 'nothing was written');
  fs.unlinkSync(file);
});

test('it refuses to run while the service is up, unless told it is stopped', () => {
  const file = oldDb();
  // No systemd in CI: a fake systemctl that reports the service active.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fakebin-'));
  fs.writeFileSync(path.join(bin, 'systemctl'), '#!/bin/sh\necho active\n', { mode: 0o755 });
  const r = spawnSync(process.execPath, [SCRIPT, '--db', file], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1', PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is running/);
  assert.equal(read(file, 'users').find((x) => x.username === 'radio101').role, 'RADIO_USER');
  fs.unlinkSync(file); fs.rmSync(bin, { recursive: true });
});
