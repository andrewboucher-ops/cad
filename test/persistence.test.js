/* Persistence completeness — node --test
 *
 * store.js's TABLES is a hand-maintained whitelist: load()/flushNow() only
 * ever look at what's named there, so a new db collection that forgets to
 * be added to it doesn't error, it just silently never survives a
 * restart — exactly what happened to clients/documents/client_requests/
 * branches/training_courses/training_records when they first landed. Every
 * other test in this suite runs with PERSISTENCE=off, so none of them
 * would ever have caught it. This file exists so the next new collection
 * can't repeat that quietly. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const store = require('../store.js');

test('every collection on db is in store.js\'s TABLES — nothing new can silently skip persistence', () => {
  process.env.PORT = '4020';
  process.env.AUTH_SECRET = 'persistence-test-secret';
  process.env.SIMULATION = 'off';
  process.env.PERSISTENCE = 'off';
  const app = require('../server.js');
  const dbKeys = Object.keys(app.db);
  const missing = dbKeys.filter((k) => !store.TABLES.includes(k));
  assert.deepEqual(missing, [], `these db collections are not in store.js's TABLES and will not survive a restart: ${missing.join(', ')}`);
});

test('a record in a previously-broken collection (branches) actually survives a real restart', async () => {
  const file = path.join(os.tmpdir(), `cccs-persistence-test-${Date.now()}.db`);
  try {
    process.env.PORT = '4021';
    process.env.AUTH_SECRET = 'persistence-roundtrip-secret';
    process.env.SIMULATION = 'off';
    process.env.PERSISTENCE = 'on';
    process.env.DATA_FILE = file;

    delete require.cache[require.resolve('../server.js')];
    let app = require('../server.js');
    app.start();
    await new Promise((r) => setTimeout(r, 200));

    const login = async (u, p) => (await fetch(`http://127.0.0.1:4021/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }),
    }).then((r) => r.json())).token;
    const adminT = await login('admin', 'admin123');
    const created = await fetch('http://127.0.0.1:4021/api/branches', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminT}` }, body: JSON.stringify({ name: 'Persistence Test Branch' }),
    }).then((r) => r.json());
    assert.ok(created.id, JSON.stringify(created));

    app.store.flushNow();
    app.server.closeAllConnections?.();
    await new Promise((resolve) => app.server.close(resolve));

    // Simulate a real process restart: force server.js to be re-evaluated
    // from scratch rather than reusing the cached module (and its
    // already-populated in-memory db) from the first require above.
    delete require.cache[require.resolve('../server.js')];
    app = require('../server.js');
    app.start();
    await new Promise((r) => setTimeout(r, 200));

    const adminT2 = await login('admin', 'admin123');
    const branches = await fetch('http://127.0.0.1:4021/api/branches', { headers: { authorization: `Bearer ${adminT2}` } }).then((r) => r.json());
    assert.ok(branches.some((b) => b.name === 'Persistence Test Branch'), 'the branch created before the restart is still there after it');

    app.server.closeAllConnections?.();
    await new Promise((resolve) => app.server.close(resolve));
  } finally {
    delete process.env.DATA_FILE;
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(file + suffix); } catch {} }
  }
});
