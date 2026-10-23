#!/usr/bin/env node
/**
 * Backfills and repairs the Outlook rota calendar from the live database,
 * without touching the running server: every shift from the start of today
 * (London) to --days ahead gets its event created or corrected, and CCCS
 * events in that window whose shift is gone, cancelled or in draft are
 * removed. The server already does this itself shortly after every start
 * and each night at 02:00 — this is for running it by hand.
 *
 *   node deploy/rota-calendar-sync.js              # today → +14 days
 *   node deploy/rota-calendar-sync.js --days 28
 *   node deploy/rota-calendar-sync.js --db /path   # default: $DATA_FILE or /var/lib/cccs/cccs.db
 *
 * Needs the same env vars as the server (MS_TENANT_ID, MS_CLIENT_ID,
 * MS_CLIENT_SECRET, optional ROTA_*); normally run through
 * deploy/rota-calendar-sync.sh, which loads them from /etc/cccs/cccs.env.
 * Opens the database read-only, so it is safe while the service runs.
 */
'use strict';

const path = require('path');
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { console.error('node:sqlite is required (Node 22+)'); process.exit(2); }
const { createRotaCalendar } = require(path.join(__dirname, '..', 'rota-calendar.js'));

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const file = arg('--db') || process.env.DATA_FILE || '/var/lib/cccs/cccs.db';
const days = arg('--days') != null ? Number(arg('--days')) : 14;
if (!Number.isInteger(days) || days < 0 || days > 90) { console.error('--days must be a whole number from 0 to 90'); process.exit(2); }

const cal = createRotaCalendar();
if (!cal.enabled) { console.error('Rota calendar sync is not configured: set MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET (see .env.example).'); process.exit(1); }

const sql = new DatabaseSync(file, { readOnly: true });
const get = sql.prepare('SELECT payload FROM collections WHERE name = ?');
const db = {};
for (const name of ['shifts', 'shift_assignments', 'personnel', 'sites', 'shift_types']) {
  const row = get.get(name);
  db[name] = row ? JSON.parse(row.payload) : [];
}
sql.close();

console.log(`Syncing ${db.shifts.length} shift(s) on file to "${cal.calendarName}" in ${cal.owner}, today → +${days} days…`);
cal.reconcile(db, { days }).then((r) => {
  console.log(`Done: ${r.created} created, ${r.updated} updated, ${r.unchanged} unchanged, ${r.deleted} removed, ${r.failed} failed.`);
  process.exit(r.failed ? 1 : 0);
});
