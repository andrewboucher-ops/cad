/**
 * A record's own audit trail: every view, change and decision on one report
 * or investigation, kept on the record itself so it lasts exactly as long
 * as the record does (the global audit trail is pruned after
 * RETAIN_AUDIT_DAYS; a report and its investigation are kept for years).
 *
 * Append-only, and hash-chained the same way as store.js's audit_events:
 * each entry carries the SHA-256 of the entry before it plus its own
 * content, so an edited or removed entry shows up in verifyTrail(). Each
 * entry's hash is also written into the global trail by the caller (as
 * trail_hash on its logEvent row), which anchors the record's trail to a
 * second, independent chain.
 *
 * Nothing in CCCS edits or removes an entry; there is no route for it.
 */
'use strict';

const crypto = require('crypto');

const GENESIS = '0'.repeat(64);

function entryHash(prev, entry) {
  const { hash, ...rest } = entry;
  return crypto.createHash('sha256').update(`${prev}\n${JSON.stringify(rest)}`).digest('hex');
}

/** Adds one entry to rec.audit_trail and returns it. */
function appendTrail(rec, fields) {
  if (!Array.isArray(rec.audit_trail)) rec.audit_trail = [];
  const last = rec.audit_trail[rec.audit_trail.length - 1];
  const entry = { seq: last ? last.seq + 1 : 1, at: new Date().toISOString(), ...fields, prev_hash: last ? last.hash : GENESIS };
  entry.hash = entryHash(entry.prev_hash, entry);
  rec.audit_trail.push(entry);
  return entry;
}

/** { ok, entries } or { ok: false, broken_at: seq, reason }. */
function verifyTrail(trail) {
  let prev = GENESIS;
  for (const e of trail || []) {
    if (e.prev_hash !== prev) return { ok: false, entries: (trail || []).length, broken_at: e.seq, reason: 'an entry before this one was removed or changed' };
    if (entryHash(e.prev_hash, e) !== e.hash) return { ok: false, entries: (trail || []).length, broken_at: e.seq, reason: 'this entry was changed after it was written' };
    prev = e.hash;
  }
  return { ok: true, entries: (trail || []).length, head_hash: prev === GENESIS ? null : prev };
}

module.exports = { appendTrail, verifyTrail };
