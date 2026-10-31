/* The audit trail outlives the in-memory window — node --test
 *
 * logEvent() keeps the last 5,000 events in memory for the live screens.
 * The record itself is store.js's audit_events table: every event written
 * as it happens, searchable, and pruned only by RETAIN_AUDIT_DAYS. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createStore } = require('../store.js');

function tmpFile() { return path.join(os.tmpdir(), `cccs-audit-test-${process.pid}-${Date.now()}.db`); }
function cleanup(file) { for (const f of [file, file + '-wal', file + '-shm']) try { fs.unlinkSync(f); } catch {} }

test('events are kept beyond the in-memory window, searchable, and pruned by date', () => {
  const file = tmpFile();
  try {
    const db = { audit_logs: [] }; const seq = {};
    const store = createStore(db, seq, { file });
    store.load();
    const old = new Date(Date.now() - 400 * 86400000).toISOString();
    for (let i = 1; i <= 6000; i++) store.appendAudit({ id: i, type: i % 2 ? 'auth.login' : 'job.created', summary: `EVENT ${i}`, data: { n: i }, at: i === 1 ? old : new Date().toISOString() });
    assert.strictEqual(store.queryAudit({ q: 'EVENT 1', limit: 5000 }).filter((e) => e.summary === 'EVENT 1').length, 1, 'the first event is still there after 6,000');
    assert.strictEqual(store.queryAudit({ type: 'auth.', limit: 5000 }).length, 3000);
    assert.deepStrictEqual(store.queryAudit({ q: 'event 6000' })[0].data, { n: 6000 });
    assert.strictEqual(store.queryAudit({ q: '100%' }).length, 0, 'LIKE wildcards in a search are literal');
    assert.strictEqual(store.pruneAudit(new Date(Date.now() - 365 * 86400000).toISOString()), 1);
    store.close();
  } finally { cleanup(file); }
});

test('the window held before the table existed is carried into it once', () => {
  const file = tmpFile();
  try {
    const first = createStore({ audit_logs: [] }, {}, { file });
    first.load();
    first.close();
    // Simulate an older database: the collection holds events, the table doesn't yet.
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(file);
    raw.prepare('INSERT INTO collections(name,payload,updated_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload')
      .run('audit_logs', JSON.stringify([{ id: 7, type: 'user.created', summary: 'USER X CREATED', data: {}, at: new Date().toISOString() }]), new Date().toISOString());
    raw.exec("DELETE FROM meta WHERE key = 'audit_events_backfilled'");
    raw.close();
    const db = { audit_logs: [] };
    const second = createStore(db, {}, { file });
    second.load();
    assert.strictEqual(second.queryAudit({ q: 'USER X' }).length, 1);
    second.close();
  } finally { cleanup(file); }
});
