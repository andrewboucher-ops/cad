/**
 * Patrols on shifts — "a patrol every hour, scanning these checkpoints, for
 * as long as the shift runs" — and what the client sees of shifts and
 * patrols at their sites.
 *
 * A shift can carry shift.patrol = { every_min, beat_id, set_at }. The beat
 * (Admin → Beats) is the patrol route; its waypoints are the checkpoints,
 * each with a QR code and/or NFC tag. While the shift runs, every
 * every_min minutes from its start (the first one an interval in), a patrol
 * visit is created and given to the officers clocked in on that shift; they
 * get a push, open it in the phone app and scan each checkpoint, then
 * complete it. A patrol not completed within its interval is MISSED and
 * control is alerted. If nobody is clocked in when a patrol falls due, it
 * is recorded as missed at the end of its window — the gap is the point.
 * Only patrols due after the setting was made are created, so adding it to
 * a shift already running does not invent misses for the past.
 *
 * Client portal: the shifts at their sites (times, whether covered, when
 * officers arrived and left) and every patrol with its checkpoint scan
 * times. No staff names — the same rule as routes-client.js.
 *
 * Registrar pattern — server.js passes in what this needs.
 */
'use strict';

module.exports = function registerShiftPatrols({
  route, httpError, CONTROL, CLIENT, ADMIN, db, logEvent, broadcast, pushToUsers, pushToRoles, findShift, siteVisibleTo = () => true,
  createPatrolVisit, publicSiteVisit, publicShift, flushNow = () => {},
}) {
  const OPEN = ['SCHEDULED', 'DISPATCHED', 'ACKNOWLEDGED', 'EN_ROUTE', 'ON_SCENE'];
  const hhmm = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });

  // Admin only, like the rest of shift editing (PATCH /api/shifts/:id).
  route('PUT', '/api/shifts/:id/patrol', ADMIN, ({ params, body, user }) => {
    const s = findShift(params.id);
    if (!siteVisibleTo(s.site_id, user)) throw httpError(404, 'shift not found');
    if (body.every_min == null || body.every_min === '' || Number(body.every_min) === 0) {
      s.patrol = null;
    } else {
      if (!s.site_id) throw httpError(400, 'a shift needs a site for patrols');
      const every = Number(body.every_min);
      if (!Number.isInteger(every) || every < 15 || every > 720) throw httpError(400, 'patrol interval must be 15 minutes to 12 hours');
      let beatId = null;
      if (body.beat_id) {
        const beat = db.beats.find((b) => b.id === Number(body.beat_id));
        if (!beat || beat.site_id !== s.site_id) throw httpError(400, 'that patrol route is not at this site');
        beatId = beat.id;
      }
      s.patrol = { every_min: every, beat_id: beatId, set_at: s.patrol && s.patrol.every_min === every && s.patrol.beat_id === beatId ? s.patrol.set_at : new Date().toISOString(), set_by: user.display_name };
    }
    // Keep the plain "patrol every N minutes" note on the shift in step —
    // the officer app's shift details show it.
    s.detail = { ...(s.detail || {}), patrol_interval_min: s.patrol ? s.patrol.every_min : null };
    logEvent('shift.patrol_set', s.patrol ? `PATROL EVERY ${s.patrol.every_min} MIN SET ON SHIFT ${s.id}` : `PATROLS REMOVED FROM SHIFT ${s.id}`, { shift_id: s.id });
    flushNow();
    return publicShift(s);
  });

  /** Due times for a shift: start + k × every, k ≥ 1, before the end. */
  function dueTimes(s) {
    const out = [], every = s.patrol.every_min * 60000, start = Date.parse(s.starts_at), end = Date.parse(s.ends_at);
    for (let k = 1; start + k * every < end && k < 500; k++) out.push({ seq: k, at: start + k * every });
    return out;
  }
  function tick(now = Date.now()) {
    let changed = false;
    for (const s of db.shifts) {
      if (!s.patrol || !s.patrol.every_min || !['PUBLISHED', 'IN_PROGRESS', 'COMPLETED'].includes(s.status)) continue;
      if (Date.parse(s.starts_at) > now || Date.parse(s.ends_at) + s.patrol.every_min * 60000 < now - 86400000) continue;
      const window = s.patrol.every_min * 60000;
      const on = db.shift_assignments.filter((a) => a.shift_id === s.id && a.status !== 'REMOVED' && a.clocked_in_at && !a.clocked_out_at).map((a) => a.personnel_id);
      for (const d of dueTimes(s)) {
        if (d.at > now || d.at < Date.parse(s.patrol.set_at)) continue;
        if (db.site_visits.some((v) => v.shift_id === s.id && v.patrol_seq === d.seq)) continue;
        // Created once it falls due — given to whoever is clocked in then.
        const v = createPatrolVisit({ shift: s, seq: d.seq, dueAt: new Date(d.at), personnelIds: now - d.at < window ? on : [] });
        changed = true;
        if (v.personnel_id) {
          const users = db.users.filter((u) => on.includes(u.personnel_id)).map((u) => u.id);
          const site = db.sites.find((x) => x.id === s.site_id);
          const beat = v.beat_id ? db.beats.find((b) => b.id === v.beat_id) : null;
          pushToUsers(users, { title: 'Patrol due', body: `${site ? site.name : 'Patrol'} — ${beat ? `${(beat.waypoints || []).length} checkpoints to scan` : 'patrol now'}, by ${hhmm(d.at + window)}`, url: '/officer.html#visit', tag: `cccs-patrol-${v.id}` });
        }
      }
    }
    // Shift patrols not completed within their interval are missed.
    for (const v of db.site_visits) {
      if (!v.shift_id || !OPEN.includes(v.status)) continue;
      const s = db.shifts.find((x) => x.id === v.shift_id);
      const window = (s && s.patrol ? s.patrol.every_min : 60) * 60000;
      if (now < Date.parse(v.scheduled_for) + window) continue;
      v.status = 'MISSED'; v.missed_at = new Date(now).toISOString(); v.updated_at = v.missed_at;
      changed = true;
      const site = db.sites.find((x) => x.id === v.site_id);
      const scanned = new Set((v.checkpoint_scans || []).map((c) => c.waypoint_id)).size;
      broadcast('site_visit.missed', publicSiteVisit(v));
      logEvent('site_visit.missed', `PATROL ${v.reference} AT ${site ? site.name.toUpperCase() : 'SITE'} (DUE ${hhmm(v.scheduled_for)}) MISSED${scanned ? ` — ${scanned} CHECKPOINT(S) SCANNED` : ''}`, { site_visit_id: v.id, shift_id: v.shift_id });
      pushToRoles(CONTROL, { title: 'Patrol missed', body: `${site ? site.name : ''} — due ${hhmm(v.scheduled_for)}`, url: '/control.html', tag: `cccs-patrol-missed-${v.id}` });
    }
    if (changed) flushNow();
  }
  const timer = setInterval(() => { try { tick(); } catch (e) { console.warn('[patrols] tick failed:', e.message); } }, 60000);
  if (timer.unref) timer.unref();

  /* ---- client portal ---- */
  const CLIENT_OR_ADMIN = [...CLIENT, ...ADMIN];
  function clientSite(user, query) {
    let c;
    if (user.role === 'SYSTEM_ADMIN') c = db.clients.find((x) => x.id === Number(query.get('as_client')));
    else c = db.clients.find((x) => x.id === user.client_id);
    if (!c) throw httpError(403, 'no client is linked to this login');
    const siteId = Number(query.get('site_id'));
    if (!c.site_ids.includes(siteId)) throw httpError(404, 'site not found');
    const to = query.get('to') ? Date.parse(query.get('to')) : Date.now() + 7 * 86400000;
    const from = query.get('from') ? Date.parse(query.get('from')) : Date.now() - 7 * 86400000;
    if (!Number.isFinite(from) || !Number.isFinite(to)) throw httpError(400, 'invalid dates');
    return { siteId, from, to };
  }
  function clientPatrol(v) {
    const beat = v.beat_id ? db.beats.find((b) => b.id === v.beat_id) : null;
    const scans = v.checkpoint_scans || [];
    return {
      id: v.id, reference: v.reference, status: v.status, scheduled_for: v.scheduled_for, completed_at: v.completed_at || null, shift_id: v.shift_id || null,
      route: beat ? beat.name : null,
      checkpoints: (beat ? beat.waypoints || [] : []).map((w) => { const sc = scans.filter((x) => x.waypoint_id === w.id); return { title: w.title, scanned_at: sc.length ? sc[0].scanned_at : null }; }),
    };
  }
  route('GET', '/api/client/patrols', CLIENT_OR_ADMIN, ({ user, query }) => {
    const { siteId, from, to } = clientSite(user, query);
    return db.site_visits.filter((v) => v.site_id === siteId && Date.parse(v.scheduled_for) >= from && Date.parse(v.scheduled_for) <= to && v.status !== 'CANCELLED')
      .sort((a, b) => b.scheduled_for.localeCompare(a.scheduled_for)).slice(0, 300).map(clientPatrol);
  });
  // The shifts themselves are GET /api/client/shifts in routes-client.js.

  return { tick };
};
