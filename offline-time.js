/**
 * When a write was really made, for one that waited on a phone with no
 * signal (public/app.js's outbox) and reached CCCS later.
 *
 * The officer app stamps each queued write with the time the officer
 * pressed the button and sends it as `x-cccs-occurred-at` when it replays.
 * Clock-in, clock-out and breaks use it so a clock-out made at 06:00 in a
 * dead spot is recorded at 06:00, not at 06:40 when the phone found signal.
 *
 * It is the phone's word, so it is bounded:
 *   - never later than now (the server's clock);
 *   - never earlier than `floor` (e.g. you can't clock out before you
 *     clocked in);
 *   - ignored if it is under a minute old (nothing was really queued) or
 *     more than OFFLINE_MAX_AGE_HOURS old (default 48: a phone that sat in
 *     a locker for days is better recorded as now and fixed by hand).
 * Callers decide what needs approval: a backdated clock-in adds hours, so
 * routes-timeclock.js holds it for control to approve.
 */
'use strict';

const OFFLINE_MAX_AGE_MS = Number(process.env.OFFLINE_MAX_AGE_HOURS || 48) * 3600000;
const HEADER = 'x-cccs-occurred-at';

function occurredAt(req, floor) {
  const raw = req && req.headers && req.headers[HEADER];
  if (!raw) return null;
  const t = Date.parse(String(raw));
  if (!Number.isFinite(t)) return null;
  const now = Date.now();
  if (now - t < 60000 || now - t > OFFLINE_MAX_AGE_MS) return null;
  const floorMs = floor ? Date.parse(floor) : NaN;
  const at = Number.isFinite(floorMs) ? Math.max(t, floorMs) : t;
  return new Date(Math.min(at, now)).toISOString();
}
/** True when the write came from the officer app's offline queue at all,
 * whatever its age — a replay can't stop to ask the officer for a reason. */
const isReplay = (req) => Boolean(req && req.headers && req.headers[HEADER]);

module.exports = { occurredAt, isReplay, HEADER };
