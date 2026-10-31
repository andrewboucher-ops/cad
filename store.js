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
  // Admin's choice of which roles see which menu section (ui-sections.js).
  'ui_settings',
  // Stock & asset management (routes-inventory.js).
  'stock_locations', 'stock_subcategories', 'asset_events', 'stocktakes',
  // Medical gas cylinders and their history (routes-cylinders.js).
  'gas_cylinders', 'cylinder_events',
  // Medication and the controlled drugs register (routes-medication.js) —
  // a CD register is a legal record; entries are never edited or deleted.
  'medicines', 'med_movements',
  // Asset hire to clients (routes-rentals.js) — signed agreements, keep.
  'rentals',
  // Quotes/contracts (signed by clients) and the invoices made from them.
  'agreements', 'invoices',
  // Payroll runs and the payslips they produce — an issued payslip is a
  // legal record, same evidentiary weight as a filed form submission.
  'payroll_runs', 'payslips',
  // Enhanced-rate days: what staff are paid (payroll_rate_days) and what
  // clients are charged (client_rate_days) on bank holidays, Christmas or a
  // one-off override — admins' edits must survive a restart.
  'payroll_rate_days', 'client_rate_days',
  // Check call changes queued by control room PCs off the VPN until the
  // check call host applies them (routes-checkcalls.js). A queued stop must
  // survive a restart, or the calls carry on.
  'checkcall_commands',
  // Live BroadNet radio handset state (GPS/status), mirrored onto the
  // control-room map — losing this on restart just means a brief gap until
  // the next terminal webhook arrives, but it's cheap to keep and avoids an
  // empty map on every deploy.
  'broadnet_terminals',
  // Key management chain-of-custody (routes-keys.js) — physical seal
  // codes, who has which safe/wallet, and the key register. Losing this
  // on restart loses who has what keys right now, not just history.
  'safes', 'safe_checkouts', 'key_wallets', 'keys', 'key_events',
  // SIA ACS complaints log (routes-complaints.js): never deleted by hand.
  'complaints',
];

/** Rows we deliberately cap so the file cannot grow without bound. */
const CAPS = {
  call_requests: 2000, locations: 20000, audit_logs: 20000, messages: 5000,
  // Contact attempts grow with every shift and are the kind of thing a review
  // reaches for months later, so the cap is far higher than the audit-log one
  // and is a safety valve rather than a retention policy. Set a real retention
  // window for it alongside RETAIN_AUDIT_DAYS if you need one.
  dial_log: 50000,
  checkcall_commands: 5000,
};

function createStore(db, seq, opts = {}) {
  const file = opts.file || process.env.DATA_FILE || path.join(__dirname, 'data', 'cccs.db');
  const enabled = DatabaseSync && process.env.PERSISTENCE !== 'off';

  if (!enabled) {
    if (!DatabaseSync) console.warn('[store] node:sqlite unavailable — running in memory only, state is lost on restart');
    return { load: () => false, flushNow: () => {}, close: () => {}, enabled: false, file: null, getMeta: () => null, setMeta: () => {},
      appendAudit: () => {}, queryAudit: null, pruneAudit: () => 0 };
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
    -- The audit trail, one row per event, written as it happens. The
    -- audit_logs collection is only the recent window the UI keeps in
    -- memory; this table is the record, kept for RETAIN_AUDIT_DAYS.
    CREATE TABLE IF NOT EXISTS audit_events (
      id      INTEGER PRIMARY KEY,
      type    TEXT NOT NULL,
      summary TEXT NOT NULL,
      data    TEXT NOT NULL,
      at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_events_at ON audit_events(at);
  `);

  const put = sql.prepare('INSERT INTO collections(name,payload,updated_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at');
  const get = sql.prepare('SELECT payload FROM collections WHERE name = ?');
  const putCounter = sql.prepare('INSERT INTO counters(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value');
  const allCounters = sql.prepare('SELECT name, value FROM counters');
  const putMeta = sql.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const getMetaStmt = sql.prepare('SELECT value FROM meta WHERE key = ?');
  const putAudit = sql.prepare('INSERT OR IGNORE INTO audit_events(id,type,summary,data,at) VALUES(?,?,?,?,?)');
  const pruneAuditStmt = sql.prepare('DELETE FROM audit_events WHERE at < ?');

  /** Written straight away rather than on the flush timer: an audit row is
   * the thing that must not be lost in a crash. */
  let loaded = false;
  function appendAudit(ev) {
    // Before load() the id counter isn't restored yet, so an id could collide.
    if (!loaded) return;
    putAudit.run(ev.id, ev.type, ev.summary, JSON.stringify(ev.data || {}), ev.at);
  }
  /** Search the whole trail, newest last, the same shape logEvent() makes. */
  function queryAudit({ type, q, since, until, personnelId, userId, limit = 200 } = {}) {
    const where = []; const args = [];
    // Subject access: every row about one person, by the ids logEvent() stamps.
    if (personnelId || userId) {
      const who = [];
      if (personnelId) { who.push("json_extract(data, '$.personnel_id') = ?"); args.push(Number(personnelId)); }
      if (userId) { who.push("json_extract(data, '$.user_id') = ?"); args.push(Number(userId)); }
      where.push(`(${who.join(' OR ')})`);
    }
    if (type) { where.push("type LIKE ? ESCAPE '\\'"); args.push(type.replace(/[%_\\]/g, (c) => '\\' + c) + '%'); }
    if (q) { where.push("summary LIKE ? ESCAPE '\\'"); args.push('%' + q.replace(/[%_\\]/g, (c) => '\\' + c) + '%'); }
    if (since) { where.push('at >= ?'); args.push(since); }
    if (until) { where.push('at <= ?'); args.push(until); }
    const n = Math.max(1, Math.min(Number(limit) || 200, 5000));
    const rows = sql.prepare(`SELECT id, type, summary, data, at FROM audit_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${n}`).all(...args);
    return rows.reverse().map((r) => ({ id: r.id, type: r.type, summary: r.summary, data: JSON.parse(r.data), at: r.at }));
  }
  function pruneAudit(cutoffIso) { return Number(pruneAuditStmt.run(cutoffIso).changes || 0); }

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
    loaded = true;
    // One-off: carry the recent window held before audit_events existed
    // into it, so the trail doesn't start empty on the first upgrade.
    if (Array.isArray(db.audit_logs) && db.audit_logs.length && !getMetaStmt.get('audit_events_backfilled')) {
      for (const ev of db.audit_logs) if (ev && ev.id != null && ev.at) appendAudit(ev);
      putMeta.run('audit_events_backfilled', new Date().toISOString());
    }

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

  return { load, flushNow, close, enabled: true, file, getMeta, setMeta, appendAudit, queryAudit, pruneAudit };
}

module.exports = { createStore, TABLES, CAPS };
