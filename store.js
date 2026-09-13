/**
 * Durable storage.
 *
 * The working set stays in memory — every read is a plain array operation, which
 * is what keeps the dispatch logic simple. Changes are written through to SQLite
 * on a short interval, and the whole state is restored on boot.
 *
 * Why SQLite and not PostgreSQL: a commercial security operation runs one control
 * room, tens of radios and a few hundred writes a minute. SQLite in WAL mode
 * handles that with room to spare, needs no daemon, no connection pooling, no
 * separate backup story — the database is one file you can copy. For a single
 * operator that is worth more than anything Postgres adds. `db/schema.sql` remains
 * the Postgres target if you outgrow this; the seam is this file and nothing else.
 *
 * Durability: writes are flushed every FLUSH_MS. A hard crash loses at most that
 * window — in practice a location fix or two. Anything that must not be lost
 * (emergencies, welfare alarms, audit rows) calls flushNow().
 */
'use strict';

const fs = require('fs');
const path = require('path');

let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); }
catch { DatabaseSync = null; }

const FLUSH_MS = Number(process.env.FLUSH_MS || 1000);

/** Tables held as whole-collection JSON documents. */
const TABLES = [
  'users', 'radios', 'mdts', 'callsigns', 'vehicles', 'personnel', 'sites',
  'talkgroups', 'talkgroup_members', 'jobs', 'job_assignments',
  'communications', 'communication_participants', 'messages', 'call_requests',
  'locations', 'radio_status_history', 'emergency_events', 'audit_logs',
  'push_subscriptions',
];

/** Rows we deliberately cap so the file cannot grow without bound. */
const CAPS = { call_requests: 2000, locations: 20000, audit_logs: 20000, communications: 5000, messages: 5000, radio_status_history: 20000 };

function createStore(db, seq, opts = {}) {
  const file = opts.file || process.env.DATA_FILE || path.join(__dirname, 'data', 'cccs.db');
  const enabled = DatabaseSync && process.env.PERSISTENCE !== 'off';

  if (!enabled) {
    if (!DatabaseSync) console.warn('[store] node:sqlite unavailable — running in memory only, state is lost on restart');
    return { load: () => false, flushNow: () => {}, close: () => {}, enabled: false, file: null, getMeta: () => null, setMeta: () => {} };
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sql = new DatabaseSync(file);
  sql.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS collections (
      name       TEXT PRIMARY KEY,
      payload    TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS counters (
      name  TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const put = sql.prepare('INSERT INTO collections(name,payload,updated_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at');
  const get = sql.prepare('SELECT payload FROM collections WHERE name = ?');
  const putCounter = sql.prepare('INSERT INTO counters(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value');
  const allCounters = sql.prepare('SELECT name, value FROM counters');
  const putMeta = sql.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const getMetaStmt = sql.prepare('SELECT value FROM meta WHERE key = ?');

  const lastWritten = new Map();
  let timer = null;

  function serialise(table) {
    const rows = db[table] || [];
    const cap = CAPS[table];
    return JSON.stringify(cap && rows.length > cap ? rows.slice(-cap) : rows);
  }

  function flushNow() {
    let written = 0;
    const now = new Date().toISOString();
    for (const table of TABLES) {
      const payload = serialise(table);
      if (lastWritten.get(table) === payload) continue;
      put.run(table, payload, now);
      lastWritten.set(table, payload);
      written++;
      const cap = CAPS[table];
      if (cap && db[table] && db[table].length > cap) db[table].splice(0, db[table].length - cap);
    }
    for (const [name, value] of Object.entries(seq)) putCounter.run(name, value);
    if (written) putMeta.run('last_flush', now);
    return written;
  }

  /** @returns true if existing state was restored (so the caller should skip seeding). */
  function load() {
    const stamp = getMetaStmt.get('schema_version');
    if (!stamp) putMeta.run('schema_version', '1');

    let restored = false;
    for (const table of TABLES) {
      const row = get.get(table);
      if (!row) continue;
      try {
        const rows = JSON.parse(row.payload);
        if (Array.isArray(rows)) {
          db[table] = rows;
          lastWritten.set(table, row.payload);
          if (rows.length) restored = true;
        }
      } catch (e) {
        console.warn(`[store] could not read ${table}, starting it empty:`, e.message);
      }
    }
    for (const row of allCounters.all()) seq[row.name] = row.value;

    if (restored) {
      // Devices cannot still be connected across a restart, whatever the file says.
      for (const r of db.radios) { r.connected = false; if (r.status !== 'OUT_OF_SERVICE') r.status = 'OFFLINE'; }
      for (const m of db.mdts) { m.connected = false; m.status = 'OFFLINE'; }
      for (const t of db.talkgroups) { t.floor_holder_radio_id = null; t.floor_console_user_id = null; t.floor_since = null; }
      // Calls cannot survive a restart either; close them out honestly.
      for (const c of db.communications) {
        if (c.state !== 'ENDED') { c.state = 'ENDED'; c.end_reason = 'SERVER_RESTART'; c.ended_at = new Date().toISOString(); }
      }
    }
    return restored;
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      try { flushNow(); } catch (e) { console.error('[store] flush failed:', e.message); }
    }, FLUSH_MS);
    timer.unref?.();
  }

  function close() {
    if (timer) { clearInterval(timer); timer = null; }
    try { flushNow(); } catch {}
    try { sql.close(); } catch {}
  }

  /** Small durable key/value slots for things that aren't a row collection —
   * the VAPID push keypair, for one, which must survive a restart or every
   * push subscription taken out before the restart silently stops working. */
  function getMeta(key) {
    const row = getMetaStmt.get(key);
    return row ? row.value : null;
  }
  function setMeta(key, value) {
    putMeta.run(key, value);
  }

  start();
  process.once('SIGINT', () => { close(); process.exit(0); });
  process.once('SIGTERM', () => { close(); process.exit(0); });

  return { load, flushNow, close, enabled: true, file, getMeta, setMeta };
}

module.exports = { createStore, TABLES, CAPS };
