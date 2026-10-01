/**
 * Durable storage.
 *
 * The working set stays in memory — every read is a plain array operation, which
 * is what keeps the dispatch logic simple. Changes are written through to SQLite
 * on a short interval, and the whole state is restored on boot.
 *
 * Why SQLite and not PostgreSQL: a commercial security operation runs one control
 * room, a modest headcount and a few hundred writes a minute. SQLite in WAL mode
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
  'users', 'mdts', 'callsigns', 'vehicles', 'personnel', 'sites',
  'jobs', 'job_assignments', 'messages', 'call_requests',
  'locations', 'emergency_events', 'audit_logs',
  'push_subscriptions', 'patrol_schedules', 'site_visits', 'shifts', 'shift_assignments', 'shift_types', 'shift_applications', 'assets', 'passdown_logs', 'fuel_logs',
  'shift_vehicle_allocations', 'shift_asset_allocations', 'stock_movements',
  'asset_checkouts', 'maintenance_logs', 'beats',
  // Contact attempts (click-to-dial / click-to-SMS). Persisted rather than
  // kept in memory because this is an audit surface: it records who contacted
  // whom, from where, and with what outcome. Losing it on restart would leave
  // a gap exactly where an incident review would look.
  'dial_log',
  // Filed paperwork is evidence, and form_grants records who may read the
  // restricted kind — neither can be allowed to vanish on a restart.
  'form_definitions', 'form_submissions', 'form_grants',
  // Client portal, multi-branch and training all followed this same
  // whole-collection pattern but were missed from this list when they
  // landed — each would otherwise lose every real record on the next
  // restart, not just in a crash window, since load()/flushNow() only
  // ever look at what's named here.
  'clients', 'documents', 'client_requests',
  'branches',
  'training_courses', 'training_records',
  'applicants',
  'leave_requests',
];

/** Rows we deliberately cap so the file cannot grow without bound. */
const CAPS = {
  call_requests: 2000, locations: 20000, audit_logs: 20000, messages: 5000,
  // Contact attempts grow with every shift and are the kind of thing a review
  // reaches for months later, so the cap is far higher than the audit-log one
  // and is a safety valve rather than a retention policy. Set a real retention
  // window for it alongside RETAIN_AUDIT_DAYS if you need one.
  dial_log: 50000,
};

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
      for (const m of db.mdts) { m.connected = false; m.status = 'OFFLINE'; }
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
