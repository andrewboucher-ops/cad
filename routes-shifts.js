/**
 * HR rota: shift types, shifts (slots), recurring shifts, assignments (who is
 * on a shift and their attendance), ad hoc clock-in and the iCal rota feeds.
 *
 * attendance, timeclock and shiftApplications are registered later in
 * server.js (they need findShift and friends from here), so they come in
 * through `late`, whose getters are only read when a request arrives.
 *
 * Moved out of server.js unchanged. Registrar pattern: server.js passes in
 * what this needs, at the same point in route order as before.
 */
'use strict';

const crypto = require('crypto');

module.exports = function registerShifts({ route, httpError, ALL, CONTROL, ADMIN, sms, shiftTitle, db, nextId, logEvent, broadcast, store, offlineTime, findPersonnel, isControlRole, siteVisibleTo, assertDeployable, buildShiftIndex, notifyShiftEvent, publicShift, publicShiftType, PUBLIC_BASE_URL, SHIFT_STATES, SHIFT_ASSIGNMENT_STATES, ATTENDANCE_STATES, late }) {
  /* ------------------------------------------------------------------ *
   * HR rota — shift types, shifts (slots) and assignments (who's on them)
   * ------------------------------------------------------------------ */
  route('GET', '/api/shift-types', ALL, ({ query, user }) => {
    const showAll = query.get('all') === '1' && user.role === 'SYSTEM_ADMIN';
    return (showAll ? db.shift_types : db.shift_types.filter((t) => t.active)).map(publicShiftType);
  });
  route('POST', '/api/shift-types', ADMIN, ({ body }) => {
    const name = String(body.name || '').trim();
    if (!name) throw httpError(400, 'name required');
    const key = String(body.key || name).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (!key) throw httpError(400, 'key required');
    if (db.shift_types.some((t) => t.key === key)) throw httpError(409, 'a shift type with that key already exists');
    const t = { id: nextId('shift_types'), key, name, color: body.color || '#6b7280', active: true, created_at: new Date().toISOString() };
    db.shift_types.push(t);
    logEvent('shift_type.created', `SHIFT TYPE ${name} ADDED`, { shift_type_id: t.id });
    return { __status: 201, __body: publicShiftType(t) };
  });
  route('PATCH', '/api/shift-types/:id', ADMIN, ({ params, body }) => {
    const t = db.shift_types.find((x) => x.id === Number(params.id)); if (!t) throw httpError(404, 'shift type not found');
    if ('name' in body) { const name = String(body.name || '').trim(); if (!name) throw httpError(400, 'name required'); t.name = name; }
    if ('color' in body) t.color = body.color || '#6b7280';
    if ('active' in body) t.active = Boolean(body.active);
    logEvent('shift_type.updated', `SHIFT TYPE ${t.name} UPDATED`, { shift_type_id: t.id });
    return publicShiftType(t);
  });

  function findShift(id) { const s = db.shifts.find((x) => x.id === Number(id)); if (!s) throw httpError(404, 'shift not found'); return s; }
  function findAssignment(id) { const a = db.shift_assignments.find((x) => x.id === Number(id)); if (!a) throw httpError(404, 'assignment not found'); return a; }
  function assignedPersonnelIds(shiftId) { return db.shift_assignments.filter((a) => a.shift_id === shiftId && a.status !== 'REMOVED').map((a) => a.personnel_id); }
  // The root of a recurring shift's own series is itself; a generated
  // instance's root is recurrence_root_id; a plain one-off shift has none.
  function shiftSeriesRootId(s) { return s.recurrence ? s.id : (s.recurrence_root_id || null); }
  // Every member of s's series due on or after s itself — what "this and
  // every future shift" means for both edit and delete.
  function shiftSeriesFromHere(s) {
    const rootId = shiftSeriesRootId(s);
    if (!rootId) return [s];
    return db.shifts.filter((x) => (x.id === rootId || x.recurrence_root_id === rootId) && Date.parse(x.starts_at) >= Date.parse(s.starts_at));
  }
  // Shift fields it makes sense to carry across a whole series — never the
  // schedule (each instance keeps its own date) or status (DRAFT/PUBLISHED/
  // CANCELLED is inherently per-occurrence).
  const SHIFT_SERIES_FIELDS = ['site_id', 'shift_type_id', 'required_headcount', 'break_minutes', 'pay_rate', 'bill_rate', 'uniform_ppe', 'briefing', 'notes'];

  route('GET', '/api/shifts', ALL, ({ query, user }) => {
    let rows = db.shifts.slice();
    // A draft is "not yet ready to show staff" by definition — only a
    // control role ever sees one, same as a RESTRICTED form submission only
    // being visible to those with a reason to see it.
    if (!isControlRole(user.role)) rows = rows.filter((s) => s.status !== 'DRAFT');
    // Every other list in the system (jobs, site-visits, shift applications)
    // already narrows to a branch/site-scoped caller's own patch; the rota
    // itself had been missed — a scoped SUPERVISOR could otherwise see (and,
    // via the write routes below, touch) every other branch's shifts too.
    rows = rows.filter((s) => siteVisibleTo(s.site_id, user));
    const idx = buildShiftIndex();
    // A signed-in subcontractor sees their own shifts only, not who else we
    // have working where.
    const mePerson = user.personnel_id ? db.personnel.find((p) => p.id === user.personnel_id) : null;
    if (mePerson && mePerson.external_sub) rows = rows.filter((s) => (idx.assignmentsByShift.get(s.id) || []).some((a) => a.status !== 'REMOVED' && a.personnel_id === mePerson.id));
    if (query.get('site_id')) rows = rows.filter((s) => s.site_id === Number(query.get('site_id')));
    if (query.get('shift_type_id')) rows = rows.filter((s) => s.shift_type_id === Number(query.get('shift_type_id')));
    if (query.get('status')) rows = rows.filter((s) => s.status === query.get('status').toUpperCase());
    if (query.get('from')) rows = rows.filter((s) => s.ends_at >= query.get('from'));
    if (query.get('to')) rows = rows.filter((s) => s.starts_at <= query.get('to'));
    const personnelId = query.get('personnel_id') ? Number(query.get('personnel_id')) : null;
    if (personnelId) rows = rows.filter((s) => (idx.assignmentsByShift.get(s.id) || []).some((a) => a.status !== 'REMOVED' && a.personnel_id === personnelId));
    const out = rows.sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at)).map((s) => publicShift(s, idx, user));
    // Convenience for a single-person view (officer.html): that person's own
    // assignment on each shift, so the caller doesn't have to search
    // `assignments` itself for the one row it actually asked about.
    if (personnelId) for (const s of out) s.my = s.assignments.find((a) => a.personnel_id === personnelId) || null;
    return out;
  });
  route('POST', '/api/shifts', ADMIN, ({ body, user }) => {
    const startsAt = body.starts_at ? new Date(body.starts_at) : null;
    const endsAt = body.ends_at ? new Date(body.ends_at) : null;
    if (!startsAt || isNaN(startsAt) || !endsAt || isNaN(endsAt)) throw httpError(400, 'starts_at and ends_at (ISO timestamps) required');
    if (endsAt <= startsAt) throw httpError(400, 'ends_at must be after starts_at');
    const type = db.shift_types.find((x) => x.id === Number(body.shift_type_id));
    if (!type) throw httpError(400, 'shift_type_id required and must exist');
    const site = body.site_id ? db.sites.find((x) => x.id === Number(body.site_id)) : null;
    if (site && !siteVisibleTo(site.id, user)) throw httpError(404, 'site not found');
    const headcount = body.required_headcount != null && body.required_headcount !== '' ? Number(body.required_headcount) : 1;
    if (!Number.isFinite(headcount) || headcount < 1) throw httpError(400, 'required_headcount must be a positive number');
    // Defaults to visible immediately, matching this restructuring's original
    // behaviour. A caller may ask for DRAFT explicitly (building out a week
    // before announcing it); IN_PROGRESS/COMPLETED/CANCELLED make no sense on
    // a shift that doesn't exist yet, so those are refused at creation.
    if ('status' in body && !['DRAFT', 'PUBLISHED'].includes(body.status)) throw httpError(400, 'a new shift must be DRAFT or PUBLISHED');
    const s = {
      id: nextId('shifts'), site_id: site ? site.id : null, shift_type_id: type.id,
      starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(),
      break_minutes: body.break_minutes ? Number(body.break_minutes) : 0,
      required_headcount: headcount,
      status: body.status === 'DRAFT' ? 'DRAFT' : 'PUBLISHED',
      pay_rate: body.pay_rate != null && body.pay_rate !== '' ? Number(body.pay_rate) : null,
      bill_rate: body.bill_rate != null && body.bill_rate !== '' ? Number(body.bill_rate) : null,
      uniform_ppe: body.uniform_ppe || '', briefing: body.briefing || '', notes: body.notes || '',
      detail: body.detail && typeof body.detail === 'object' ? body.detail : {},
      template_id: null, revision: 0,
      created_by: user.id, created_at: new Date().toISOString(),
    };
    db.shifts.push(s);
    // A `personnel` convenience, the same shape the old single-assignment API
    // used — the common case (control fills in one person while creating the
    // shift) shouldn't need a second round trip to /assignments.
    let firstAssignment = null;
    if (body.personnel) {
      const p = findPersonnel(body.personnel);
      if (!p) throw httpError(400, 'personnel not found');
      assertDeployable(p, body, user, 'ROSTERING');
      firstAssignment = {
        id: nextId('shift_assignments'), shift_id: s.id, personnel_id: p.id, role_on_shift: body.role_on_shift || '',
        is_duty_supervisor: body.is_duty_supervisor === true, status: 'ASSIGNED', confirmed_at: null,
        attendance: null, clocked_in_at: null, clocked_out_at: null,
        created_by: user.id, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      db.shift_assignments.push(firstAssignment);
    }
    // A draft is "not ready to show staff" — the assigned officer doesn't
    // find out over the socket either, the same boundary GET /api/shifts
    // enforces on a fetch. The socket payload also reaches DISPATCHER/
    // SUPERVISOR (isControlRole), not just SYSTEM_ADMIN, so it stays
    // unredacted (no user passed) — only the HTTP response below goes to
    // the admin who actually made this request.
    broadcast('shift.created', publicShift(s), s.status === 'DRAFT' ? { controlOnly: true } : { personnelIds: firstAssignment ? [firstAssignment.personnel_id] : [] });
    if (s.status !== 'DRAFT' && firstAssignment) notifyShiftEvent('ASSIGNED', s, [firstAssignment.personnel_id]);
    logEvent('shift.created', `SHIFT CREATED (${type.name}) ${s.starts_at} — ${s.ends_at}${firstAssignment ? ` FOR ${findPersonnel(firstAssignment.personnel_id).name}` : ''}`, { shift_id: s.id });
    return { __status: 201, __body: publicShift(s, undefined, user) };
  });
  route('PATCH', '/api/shifts/:id', ADMIN, ({ params, body, query, user }) => {
    const s = findShift(params.id);
    if (!siteVisibleTo(s.site_id, user)) throw httpError(404, 'shift not found');
    if ('site_id' in body && body.site_id && !siteVisibleTo(Number(body.site_id), user)) throw httpError(404, 'site not found');
    const wasDraft = s.status === 'DRAFT';
    let scheduleChanged = false;
    if ('starts_at' in body) { const d = new Date(body.starts_at); if (isNaN(d)) throw httpError(400, 'invalid starts_at'); if (d.toISOString() !== s.starts_at) scheduleChanged = true; s.starts_at = d.toISOString(); }
    if ('ends_at' in body) { const d = new Date(body.ends_at); if (isNaN(d)) throw httpError(400, 'invalid ends_at'); if (d.toISOString() !== s.ends_at) scheduleChanged = true; s.ends_at = d.toISOString(); }
    if (Date.parse(s.ends_at) <= Date.parse(s.starts_at)) throw httpError(400, 'ends_at must be after starts_at');
    if ('site_id' in body) { const site = body.site_id ? db.sites.find((x) => x.id === Number(body.site_id)) : null; const newId = site ? site.id : null; if (newId !== s.site_id) scheduleChanged = true; s.site_id = newId; }
    if ('shift_type_id' in body) {
      const type = db.shift_types.find((x) => x.id === Number(body.shift_type_id));
      if (!type) throw httpError(400, 'shift_type_id must exist');
      s.shift_type_id = type.id;
    }
    if ('required_headcount' in body) {
      const h = Number(body.required_headcount);
      if (!Number.isFinite(h) || h < 1) throw httpError(400, 'required_headcount must be a positive number');
      s.required_headcount = h;
    }
    if ('break_minutes' in body) s.break_minutes = Number(body.break_minutes) || 0;
    if ('pay_rate' in body) s.pay_rate = body.pay_rate === null || body.pay_rate === '' ? null : Number(body.pay_rate);
    if ('bill_rate' in body) s.bill_rate = body.bill_rate === null || body.bill_rate === '' ? null : Number(body.bill_rate);
    if ('uniform_ppe' in body) s.uniform_ppe = body.uniform_ppe || '';
    if ('briefing' in body) s.briefing = body.briefing || '';
    if ('notes' in body) s.notes = body.notes || '';
    if ('detail' in body) s.detail = body.detail && typeof body.detail === 'object' ? body.detail : {};
    let justCancelled = false;
    if ('status' in body) {
      if (!SHIFT_STATES.includes(body.status)) throw httpError(400, 'invalid shift status');
      justCancelled = body.status === 'CANCELLED' && s.status !== 'CANCELLED';
      s.status = body.status;
      if (body.status === 'CANCELLED') late.shiftApplications.expireApplicationsForShift(s.id);
    }
    s.revision = (s.revision || 0) + 1;
    const pub = publicShift(s, undefined, user);
    // Editing a still-draft shift (e.g. fixing its time before publishing)
    // must not tip off its assignee any sooner than publishing itself would.
    // The socket payload also reaches DISPATCHER/SUPERVISOR (isControlRole),
    // not just SYSTEM_ADMIN, so it's built unredacted (no user) — pub itself,
    // returned below to the admin who made this request, keeps pay_override.
    broadcast('shift.updated', publicShift(s), s.status === 'DRAFT' ? { controlOnly: true } : { personnelIds: assignedPersonnelIds(s.id) });
    if (!wasDraft && s.status !== 'DRAFT') {
      const affected = assignedPersonnelIds(s.id);
      if (justCancelled) notifyShiftEvent('CANCELLED', s, affected);
      else if (scheduleChanged) notifyShiftEvent('CHANGED', s, affected);
    }
    // "This and future shifts" — every other member of the series due on or
    // after this one (never the past) picks up the same non-schedule fields.
    // The root itself is updated too when it isn't `s` directly, so a shift
    // the recurrence tick generates next week inherits the change as well,
    // rather than reverting to whatever the root still had on file.
    let seriesCount = 0;
    if (query.get('scope') === 'series') {
      const rootId = shiftSeriesRootId(s);
      if (rootId) {
        const touched = new Set([s.id]);
        for (const m of shiftSeriesFromHere(s)) {
          if (touched.has(m.id)) continue;
          touched.add(m.id);
          for (const f of SHIFT_SERIES_FIELDS) if (f in body) m[f] = s[f];
          m.revision = (m.revision || 0) + 1;
          broadcast('shift.updated', publicShift(m), m.status === 'DRAFT' ? { controlOnly: true } : { personnelIds: assignedPersonnelIds(m.id) });
          seriesCount++;
        }
        const root = db.shifts.find((x) => x.id === rootId);
        if (root && !touched.has(root.id)) for (const f of SHIFT_SERIES_FIELDS) if (f in body) root[f] = s[f];
      }
    }
    logEvent('shift.updated', `SHIFT ${s.id} UPDATED${seriesCount ? ` (AND ${seriesCount} FUTURE SERIES SHIFT${seriesCount === 1 ? '' : 'S'})` : ''}`, { shift_id: s.id });
    return pub;
  });
  route('DELETE', '/api/shifts/:id', ADMIN, ({ params, query }) => {
    const s = findShift(params.id);
    const scope = query.get('scope') === 'series' ? 'series' : 'one';
    let targets = [s];
    if (scope === 'series') {
      const rootId = shiftSeriesRootId(s);
      if (rootId) {
        targets = shiftSeriesFromHere(s);
        // The root survives this delete (it's earlier than s, so it isn't
        // in targets) — cap its recurrence just before s so the next tick
        // doesn't simply regenerate what was just deleted.
        const root = db.shifts.find((x) => x.id === rootId);
        if (root && !targets.some((t) => t.id === root.id) && root.recurrence) {
          root.recurrence = { ...root.recurrence, until: new Date(Date.parse(s.starts_at) - 1000).toISOString() };
        }
      }
    }
    for (const t of targets) {
      const affected = assignedPersonnelIds(t.id);
      const wasDraft = t.status === 'DRAFT';
      late.shiftApplications.expireApplicationsForShift(t.id);
      db.shifts = db.shifts.filter((x) => x.id !== t.id);
      db.shift_assignments = db.shift_assignments.filter((a) => a.shift_id !== t.id);
      broadcast('shift.deleted', { id: t.id }, { personnelIds: affected });
      if (!wasDraft) notifyShiftEvent('CANCELLED', t, affected);
    }
    logEvent('shift.deleted', `SHIFT ${s.id} DELETED${targets.length > 1 ? ` (AND ${targets.length - 1} FUTURE SERIES SHIFT${targets.length - 1 === 1 ? '' : 'S'})` : ''}`, { shift_id: s.id });
    return { ok: true, deleted: targets.length };
  });

  /* ---- Recurring shifts — "repeat every N days" instead of repeatedly
   * clicking Duplicate week forward. Same shape as shift.patrol in
   * routes-shift-patrols.js: a setting on one shift (the root), a background
   * tick that keeps future instances generated up to a rolling horizon, and
   * nothing invented for the past. The root is the only shift that ever
   * carries `recurrence` — generated instances are plain one-off DRAFT
   * shifts tagged with recurrence_root_id, so turning recurrence off, or
   * deleting the root, just stops future generation; it never retroactively
   * touches what's already been made. ---- */
  const SHIFT_RECURRENCE_HORIZON_MS = 56 * 86400000; // 8 weeks
  route('PUT', '/api/shifts/:id/recurrence', ADMIN, ({ params, body, user }) => {
    const s = findShift(params.id);
    if (!siteVisibleTo(s.site_id, user)) throw httpError(404, 'shift not found');
    if (body.every_days == null || body.every_days === '' || Number(body.every_days) === 0) {
      s.recurrence = null;
      logEvent('shift.recurrence_set', `RECURRENCE REMOVED FROM SHIFT ${s.id}`, { shift_id: s.id });
      return publicShift(s);
    }
    // A shift already generated by another shift's repeat setting cannot
    // become a second, independent root nested inside the first — that
    // produced duplicate future shifts (two overlapping series both
    // generating the same day/site/time) the one time this wasn't caught.
    // Turn repeat off on it to detach it from the series first if that is
    // really what's wanted; otherwise the setting belongs on the original.
    if (s.recurrence_root_id) throw httpError(400, 'this shift already repeats as part of another shift\'s series — change the repeat setting there instead');
    const every = Number(body.every_days);
    if (!Number.isInteger(every) || every < 1 || every > 90) throw httpError(400, 'repeat interval must be 1 to 90 days');
    let until = null;
    if (body.until) { const d = new Date(body.until); if (isNaN(d)) throw httpError(400, 'invalid until date'); until = d.toISOString(); }
    const unchanged = s.recurrence && s.recurrence.every_days === every && s.recurrence.until === until;
    s.recurrence = { every_days: every, until, set_at: unchanged ? s.recurrence.set_at : new Date().toISOString(), set_by: user.display_name };
    logEvent('shift.recurrence_set', `SHIFT ${s.id} SET TO REPEAT EVERY ${every} DAY${every === 1 ? '' : 'S'}${until ? ` UNTIL ${until.slice(0, 10)}` : ''}`, { shift_id: s.id });
    shiftRecurrenceTick(); // top up immediately rather than waiting for the next tick
    return publicShift(s);
  });
  // A week-later shift means the same clock time on a UK wall, not the same
  // number of UTC milliseconds — the two differ by an hour either side of
  // the last-Sunday-in-March/October clock change. Adding fixed ms (what
  // this did originally) generated a run of shifts an hour out from the
  // moment the clocks changed, every week, forever, until someone noticed.
  const LONDON_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  function londonParts(utcMs) {
    const p = Object.fromEntries(LONDON_FMT.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
    return { y: Number(p.year), mo: Number(p.month) - 1, d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), s: Number(p.second) };
  }
  function londonToUtc(y, mo, d, h, mi, s) {
    const guess = Date.UTC(y, mo, d, h, mi, s);
    const asLondon = londonParts(guess);
    const offsetMin = Math.round((Date.UTC(asLondon.y, asLondon.mo, asLondon.d, asLondon.h, asLondon.mi, asLondon.s) - guess) / 60000);
    return guess - offsetMin * 60000;
  }
  function shiftRecurrenceTick(now = Date.now()) {
    let changed = false;
    const horizon = now + SHIFT_RECURRENCE_HORIZON_MS;
    for (const root of db.shifts) {
      if (!root.recurrence || !root.recurrence.every_days) continue;
      const untilMs = root.recurrence.until ? Date.parse(root.recurrence.until) : Infinity;
      const setAtMs = Date.parse(root.recurrence.set_at);
      const startLocal = londonParts(Date.parse(root.starts_at));
      const endLocal = londonParts(Date.parse(root.ends_at));
      // Whole local calendar days between start and end (0 for a day shift,
      // 1 for one running past midnight) — carried forward unchanged so an
      // overnight shift stays overnight on every generated instance too.
      const endDayOffset = Math.round((Date.UTC(endLocal.y, endLocal.mo, endLocal.d) - Date.UTC(startLocal.y, startLocal.mo, startLocal.d)) / 86400000);
      const startDateUtc = Date.UTC(startLocal.y, startLocal.mo, startLocal.d);
      for (let k = 1; k < 500; k++) {
        const d = new Date(startDateUtc + k * root.recurrence.every_days * 86400000);
        const instStart = londonToUtc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), startLocal.h, startLocal.mi, startLocal.s);
        if (instStart > horizon) break;
        if (instStart > untilMs) break;
        if (instStart < setAtMs) continue; // never invent instances for before the setting was made
        if (db.shifts.some((x) => x.recurrence_root_id === root.id && Math.abs(Date.parse(x.starts_at) - instStart) < 60000)) continue;
        const dEnd = new Date(startDateUtc + k * root.recurrence.every_days * 86400000 + endDayOffset * 86400000);
        const instEnd = londonToUtc(dEnd.getUTCFullYear(), dEnd.getUTCMonth(), dEnd.getUTCDate(), endLocal.h, endLocal.mi, endLocal.s);
        const inst = {
          id: nextId('shifts'), site_id: root.site_id, shift_type_id: root.shift_type_id,
          starts_at: new Date(instStart).toISOString(), ends_at: new Date(instEnd).toISOString(),
          break_minutes: root.break_minutes, required_headcount: root.required_headcount, status: 'DRAFT',
          pay_rate: root.pay_rate, bill_rate: root.bill_rate,
          uniform_ppe: root.uniform_ppe, briefing: root.briefing, notes: root.notes,
          detail: { ...(root.detail || {}) }, template_id: null, revision: 0,
          created_by: root.created_by, created_at: new Date(now).toISOString(),
          recurrence_root_id: root.id,
        };
        db.shifts.push(inst);
        changed = true;
        for (const a of db.shift_assignments.filter((x) => x.shift_id === root.id && ['ASSIGNED', 'CONFIRMED'].includes(x.status))) {
          db.shift_assignments.push({
            id: nextId('shift_assignments'), shift_id: inst.id, personnel_id: a.personnel_id, role_on_shift: a.role_on_shift,
            is_duty_supervisor: a.is_duty_supervisor, status: 'ASSIGNED', confirmed_at: null,
            attendance: null, clocked_in_at: null, clocked_out_at: null,
            created_by: a.created_by, created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
          });
        }
        logEvent('shift.recurrence_generated', `SHIFT ${inst.id} GENERATED FROM RECURRING SHIFT ${root.id}`, { shift_id: inst.id, recurrence_root_id: root.id });
      }
    }
    if (changed) store.flushNow();
  }

  /* ---- Assignments: who's on a shift, and their attendance ---- */
  function assertAssignmentAccess(a, user) {
    if (isControlRole(user.role)) return;
    if (user.role === 'FIELD_USER' && user.personnel_id === a.personnel_id) return;
    throw httpError(403, 'not your shift');
  }
  route('POST', '/api/shifts/:id/assignments', ADMIN, ({ params, body, user }) => {
    const s = findShift(params.id);
    if (!siteVisibleTo(s.site_id, user)) throw httpError(404, 'shift not found');
    const p = findPersonnel(body.personnel); if (!p) throw httpError(400, 'personnel required');
    if (db.shift_assignments.some((a) => a.shift_id === s.id && a.personnel_id === p.id && a.status !== 'REMOVED')) {
      throw httpError(409, `${p.name} is already on this shift`);
    }
    assertDeployable(p, body, user, 'ROSTERING');
    const a = {
      id: nextId('shift_assignments'), shift_id: s.id, personnel_id: p.id, role_on_shift: body.role_on_shift || '',
      is_duty_supervisor: body.is_duty_supervisor === true, status: 'ASSIGNED', confirmed_at: null,
      attendance: null, clocked_in_at: null, clocked_out_at: null,
      created_by: user.id, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    db.shift_assignments.push(a);
    s.revision = (s.revision || 0) + 1;
    const pub = publicShift(s);
    broadcast('shift.updated', pub, s.status === 'DRAFT' ? { controlOnly: true } : { personnelIds: [p.id] });
    if (s.status !== 'DRAFT') notifyShiftEvent('ASSIGNED', s, [p.id]);
    logEvent('shift_assignment.created', `${p.name} ADDED TO SHIFT ${s.id}`, { shift_id: s.id, personnel_id: p.id });
    return { __status: 201, __body: pub };
  });
  route('PATCH', '/api/shift-assignments/:id', ALL, ({ params, body, user }) => {
    const a = findAssignment(params.id);
    const s = findShift(a.shift_id);
    const isOwn = user.role === 'FIELD_USER' && user.personnel_id === a.personnel_id;
    // Editing WHO is on a shift, and how, is admin-only now (dispatchers and
    // officers are read-only on the rota) — confirming or declining your own
    // offered shift is a different, self-service action and stays open to
    // the assignee regardless.
    const isAdmin = user.role === 'SYSTEM_ADMIN';
    if (!isOwn && !isAdmin) throw httpError(403, 'not your shift');
    if (!isOwn && isAdmin && !siteVisibleTo(s.site_id, user)) throw httpError(404, 'shift not found');
    let justRemoved = false;
    if ('status' in body) {
      const status = String(body.status || '').toUpperCase();
      if (!SHIFT_ASSIGNMENT_STATES.includes(status)) throw httpError(400, 'invalid status');
      if (isOwn && !['CONFIRMED', 'DECLINED'].includes(status)) throw httpError(403, 'you can only confirm or decline your own assignment');
      if (status === 'REMOVED' && !isAdmin) throw httpError(403, 'insufficient role');
      justRemoved = status === 'REMOVED' && a.status !== 'REMOVED';
      a.status = status;
      if (status === 'CONFIRMED') a.confirmed_at = new Date().toISOString();
    }
    if ('role_on_shift' in body && isAdmin) a.role_on_shift = body.role_on_shift || '';
    if ('is_duty_supervisor' in body && isAdmin) a.is_duty_supervisor = Boolean(body.is_duty_supervisor);
    if ('attendance' in body && isAdmin) {
      if (body.attendance !== null && !ATTENDANCE_STATES.includes(body.attendance)) throw httpError(400, 'invalid attendance');
      a.attendance = body.attendance;
    }
    // A one-off pay rate for this specific person on this specific shift —
    // a late-notice cover shift, say — distinct from a payroll_rate_days
    // entry (routes-payroll.js), which applies to whoever works a given
    // calendar date. An override here always takes precedence over a
    // rate day for this assignment's hours, never stacks with one.
    // bill_client is the admin's own choice whether the client is charged
    // the same uplift, or it stays an internal staffing-cost decision.
    if ('pay_override' in body && isAdmin) {
      if (body.pay_override === null) { a.pay_override = null; }
      else {
        const o = body.pay_override || {};
        const kind = o.kind === 'FLAT' ? 'FLAT' : 'MULTIPLIER';
        let multiplier = null, flat_rate = null;
        if (kind === 'MULTIPLIER') {
          multiplier = Number(o.multiplier);
          if (!Number.isFinite(multiplier) || multiplier <= 1) throw httpError(400, 'multiplier must be a number greater than 1');
        } else {
          flat_rate = Math.round(Number(o.flat_rate) * 100) / 100;
          if (!Number.isFinite(flat_rate) || flat_rate <= 0) throw httpError(400, 'flat_rate must be a positive number');
        }
        const reason = String(o.reason || '').trim().slice(0, 200);
        if (!reason) throw httpError(400, 'a reason is required for a pay override');
        a.pay_override = { kind, multiplier, flat_rate, bill_client: o.bill_client === true, reason, set_by: user.display_name, set_at: new Date().toISOString() };
      }
      logEvent('shift_assignment.pay_override', `${user.username} ${body.pay_override === null ? 'REMOVED' : 'SET'} A PAY OVERRIDE FOR ASSIGNMENT ${a.id}`, { shift_id: s.id, personnel_id: a.personnel_id });
    }
    a.updated_at = new Date().toISOString();
    s.revision = (s.revision || 0) + 1;
    // broadcast() fans the SAME payload out over the socket to every control
    // role (DISPATCHER, SUPERVISOR, SYSTEM_ADMIN — see isControlRole) and to
    // the assignee themselves, not just the admin who made this request — so
    // it must stay unredacted (no user passed). Only the HTTP response below
    // goes to the admin who actually asked, and may safely include pay_override.
    broadcast('shift.updated', publicShift(s), s.status === 'DRAFT' ? { controlOnly: true } : { personnelIds: [a.personnel_id] });
    // An admin-initiated removal is news to the officer; their own
    // confirm/decline is something they just did, so it needs no echo back.
    if (justRemoved && isAdmin && s.status !== 'DRAFT') notifyShiftEvent('REMOVED', s, [a.personnel_id]);
    const p = db.personnel.find((x) => x.id === a.personnel_id);
    logEvent('shift_assignment.updated', `${p ? p.name : 'PERSON'} ON SHIFT ${s.id} UPDATED`, { shift_id: s.id, personnel_id: a.personnel_id });
    return publicShift(s, undefined, user);
  });
  route('POST', '/api/shift-assignments/:id/clock-in', ALL, ({ params, body, user, req }) => {
    const a = findAssignment(params.id);
    assertAssignmentAccess(a, user);
    const s = findShift(a.shift_id);
    if (a.clocked_in_at) return publicShift(s);
    if (a.status === 'REMOVED') throw httpError(409, 'no longer on this shift');
    const who = db.personnel.find((x) => x.id === a.personnel_id);
    if (who) assertDeployable(who, body, user, 'CLOCK-IN');
    // Pressed with no signal and sent later: recorded at the phone's time
    // (offline-time.js), held for control's approval (routes-timeclock.js).
    const at = offlineTime.occurredAt(req);
    // Outside the rostered time needs a reason (routes-timeclock.js), and
    // the on-site check (routes-attendance.js) — each throws if not met.
    const pending = late.timeclock.check(a, s, body || {}, user, 'IN', { at, replay: offlineTime.isReplay(req) });
    late.attendance.checkClockIn(a, s, body || {}, user);
    a.clocked_in_at = at || new Date().toISOString(); a.updated_at = new Date().toISOString();
    late.timeclock.record(a, pending, user);
    late.timeclock.recordOffline(a, 'IN', at, user);
    if (s.status === 'PUBLISHED') { s.status = 'IN_PROGRESS'; }
    const p = db.personnel.find((x) => x.id === a.personnel_id);
    const pub = publicShift(s);
    broadcast('shift.updated', pub, { personnelIds: [a.personnel_id] });
    logEvent('shift.clocked_in', `${p ? p.name : 'PERSON'} CLOCKED IN`, { shift_id: s.id, personnel_id: a.personnel_id });
    return pub;
  });
  route('POST', '/api/shift-assignments/:id/clock-out', ALL, ({ params, body, user, req }) => {
    const a = findAssignment(params.id);
    assertAssignmentAccess(a, user);
    const s = findShift(a.shift_id);
    if (!a.clocked_in_at) throw httpError(409, 'not clocked in');
    if (a.clocked_out_at) throw httpError(409, 'already clocked out');
    // Pressed with no signal and sent later: recorded at the phone's time,
    // never before they clocked in or started their open break.
    const openBreak = (a.breaks || []).find((b) => !b.end);
    const at = offlineTime.occurredAt(req, openBreak && openBreak.start > a.clocked_in_at ? openBreak.start : a.clocked_in_at);
    const pending = late.timeclock.check(a, s, body || {}, user, 'OUT', { at, replay: offlineTime.isReplay(req) });
    a.clocked_out_at = at || new Date().toISOString(); a.updated_at = new Date().toISOString();
    late.attendance.closeBreaks(a, a.clocked_out_at);
    late.attendance.finishAdHoc(a, s);
    late.timeclock.record(a, pending, user);
    late.timeclock.recordOffline(a, 'OUT', at, user);
    if (!a.attendance) a.attendance = 'ATTENDED';
    const p = db.personnel.find((x) => x.id === a.personnel_id);
    const pub = publicShift(s);
    broadcast('shift.updated', pub, { personnelIds: [a.personnel_id] });
    logEvent('shift.clocked_out', `${p ? p.name : 'PERSON'} CLOCKED OUT`, { shift_id: s.id, personnel_id: a.personnel_id });
    return pub;
  });

  /* Ad hoc clock-in — covering work nobody rostered (someone called in sick,
   * a last-minute cover request). Rather than a parallel attendance system,
   * this creates a genuine shift + assignment on the fly (status IN_PROGRESS,
   * detail.adhoc true to flag it apart on the rota) and clocks the caller
   * into it immediately, through the exact same geofence check as a normal
   * clock-in — from here on it IS a normal shift: clock-out, breaks, hours,
   * auto-clock-out-on-leaving-site, all the existing attendance machinery
   * applies untouched. A generous 12h placeholder end time stands in for a
   * real rostered end — the shift is still open until they clock out. */
  // Kept for the officer app's "Not rostered? Clock in anyway" — the same
  // ad-hoc clock-in as POST /api/timeclock/clock-in (a reason, and control
  // approves it; see routes-timeclock.js).
  route('POST', '/api/shifts/adhoc', ['FIELD_USER', ...CONTROL], ({ body, user }) => late.timeclock.clockInAdHoc(body, user));

  /* ---- Personal iCal feed — a long unguessable token stands in for a
   * login, the same trust model as a webhook URL, since a calendar client
   * can't carry a session header. See routes-contact.js's Twilio status
   * callback for the only other route in this codebase registered with
   * `null` roles (the one way to skip authFrom() entirely). ---- */
  function icsEscape(str) { return String(str || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
  function icsDate(iso) { return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }
  function icsVevent({ uid, stamp, startsAt, endsAt, summary, location, description, status, sequence }) {
    return [
      'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${icsDate(stamp)}`,
      `DTSTART:${icsDate(startsAt)}`, `DTEND:${icsDate(endsAt)}`,
      `SUMMARY:${icsEscape(summary)}`,
      location ? `LOCATION:${icsEscape(location)}` : null,
      description ? `DESCRIPTION:${icsEscape(description)}` : null,
      `STATUS:${status}`, `SEQUENCE:${sequence || 0}`,
      'END:VEVENT',
    ].filter(Boolean).join('\r\n');
  }
  function buildIcsFeed(name, vevents) {
    return [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CCCS//Rota//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      `X-WR-CALNAME:${icsEscape(name)}`, 'X-PUBLISHED-TTL:PT1H',
      ...vevents, 'END:VCALENDAR',
    ].join('\r\n');
  }
  function personalVevents(personnelId) {
    const now = new Date().toISOString();
    return db.shift_assignments
      .filter((a) => a.personnel_id === personnelId)
      .map((a) => ({ a, s: db.shifts.find((x) => x.id === a.shift_id) }))
      .filter((x) => x.s && x.s.status !== 'DRAFT')
      .map(({ a, s }) => icsVevent({
        uid: `shift-${s.id}-assignment-${a.id}@cccs.local`, stamp: now, startsAt: s.starts_at, endsAt: s.ends_at,
        summary: shiftTitle(s), location: s.site_id ? (db.sites.find((x) => x.id === s.site_id) || {}).address : null,
        description: s.briefing || s.notes || '',
        status: (s.status === 'CANCELLED' || ['DECLINED', 'REMOVED'].includes(a.status)) ? 'CANCELLED' : 'CONFIRMED',
        sequence: s.revision || 0,
      }));
  }
  function allOpsVevents() {
    const now = new Date().toISOString();
    return db.shifts
      .filter((s) => s.status !== 'DRAFT')
      .map((s) => icsVevent({
        uid: `shift-${s.id}@cccs.local`, stamp: now, startsAt: s.starts_at, endsAt: s.ends_at,
        summary: shiftTitle(s), location: s.site_id ? (db.sites.find((x) => x.id === s.site_id) || {}).address : null,
        description: s.briefing || s.notes || '', status: s.status === 'CANCELLED' ? 'CANCELLED' : 'CONFIRMED', sequence: s.revision || 0,
      }));
  }
  // Two feeds per control-role user: their own shifts (if they personally
  // have any — a duty supervisor still works shifts) and, separately, the
  // whole operation for anyone who wants the oversight view in their own
  // calendar too. Personal is the default; "all" is opt-in. A FIELD_USER
  // only ever gets the personal one — they have no oversight role to see.
  route('GET', '/api/me/ical-feed', ALL, ({ user }) => {
    const u = db.users.find((x) => x.id === user.id);
    const out = {};
    if (u.personnel_id) {
      if (!u.ical_token) u.ical_token = crypto.randomBytes(24).toString('hex');
      out.url = `${PUBLIC_BASE_URL}/api/rota/ical/${u.ical_token}.ics`;
    }
    if (isControlRole(u.role)) {
      if (!u.ical_token_all) u.ical_token_all = crypto.randomBytes(24).toString('hex');
      out.all_url = `${PUBLIC_BASE_URL}/api/rota/ical/${u.ical_token_all}.ics`;
      // No personal shifts at all (most dispatchers/supervisors): fall back
      // to the whole-ops feed as the one offered, same as before this change.
      if (!out.url) out.url = out.all_url;
    }
    if (!out.url) throw httpError(404, 'no shifts to sync — your login is not linked to a staff record');
    return out;
  });
  route('POST', '/api/me/ical-feed/regenerate', ALL, ({ body, user }) => {
    const u = db.users.find((x) => x.id === user.id);
    if (body && body.which === 'all') {
      if (!isControlRole(u.role)) throw httpError(403, 'no whole-rota feed to regenerate');
      u.ical_token_all = crypto.randomBytes(24).toString('hex');
      logEvent('ical_feed.regenerated', `${u.display_name} REGENERATED THEIR WHOLE-ROTA FEED LINK`, { user_id: u.id });
      return { url: `${PUBLIC_BASE_URL}/api/rota/ical/${u.ical_token_all}.ics` };
    }
    u.ical_token = crypto.randomBytes(24).toString('hex');
    logEvent('ical_feed.regenerated', `${u.display_name} REGENERATED THEIR ROTA FEED LINK`, { user_id: u.id });
    return { url: `${PUBLIC_BASE_URL}/api/rota/ical/${u.ical_token}.ics` };
  });
  // Deliberately `null` roles — see the comment above. The token in the URL
  // IS the credential; validation happens here, not in the router.
  route('GET', '/api/rota/ical/:token.ics', null, ({ params }) => {
    const byAll = db.users.find((x) => x.ical_token_all && x.ical_token_all === params.token);
    if (byAll) {
      return {
        __body: buildIcsFeed('CCCS Rota — All sites', allOpsVevents()),
        __headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'inline; filename="rota.ics"', 'cache-control': 'no-store' },
      };
    }
    // An admin-issued link for someone with no CCCS login at all — a shift
    // officer's emergency contact, typically — to see just their shifts,
    // the same feed shape as the officer's own, without ever having a
    // user account or needing one.
    const p = db.personnel.find((x) => x.ical_token && x.ical_token === params.token);
    if (p) {
      return {
        __body: buildIcsFeed(`${p.name} — Rota`, personalVevents(p.id)),
        __headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'inline; filename="rota.ics"', 'cache-control': 'no-store' },
      };
    }
    const u = db.users.find((x) => x.ical_token && x.ical_token === params.token);
    if (!u || !u.personnel_id) throw httpError(404, 'feed not found');
    return {
      __body: buildIcsFeed('My Rota', personalVevents(u.personnel_id)),
      __headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'inline; filename="rota.ics"', 'cache-control': 'no-store' },
    };
  });
  route('POST', '/api/personnel/:id/ical-feed', ADMIN, ({ params }) => {
    const p = findPersonnel(params.id); if (!p) throw httpError(404, 'person not found');
    if (!p.ical_token) p.ical_token = crypto.randomBytes(24).toString('hex');
    return { url: `${PUBLIC_BASE_URL}/api/rota/ical/${p.ical_token}.ics` };
  });
  route('POST', '/api/personnel/:id/ical-feed/regenerate', ADMIN, ({ params, user }) => {
    const p = findPersonnel(params.id); if (!p) throw httpError(404, 'person not found');
    p.ical_token = crypto.randomBytes(24).toString('hex');
    logEvent('ical_feed.regenerated', `${user.display_name} REGENERATED ${p.name}'S SHARED ROTA LINK`, { personnel_id: p.id });
    return { url: `${PUBLIC_BASE_URL}/api/rota/ical/${p.ical_token}.ics` };
  });
  // Texts the shared rota link straight to the emergency contact on file —
  // same send path, dry-run safety and dial_log audit trail as the
  // existing click-to-SMS to an officer themselves (routes-contact.js).
  route('POST', '/api/personnel/:id/ical-feed/sms', ADMIN, async ({ params, user }) => {
    const p = findPersonnel(params.id); if (!p) throw httpError(404, 'person not found');
    const ec = p.emergency_contact || {};
    if (!ec.phone) throw httpError(400, 'no emergency contact phone number on file for this person');
    if (!p.ical_token) p.ical_token = crypto.randomBytes(24).toString('hex');
    const url = `${PUBLIC_BASE_URL}/api/rota/ical/${p.ical_token}.ics`;
    const text = `Hi${ec.name ? ' ' + ec.name.split(/\s+/)[0] : ''}, this link shows ${p.name}'s work shifts in your calendar app and updates itself automatically: ${url}`;
    const result = await sms.send({ to: ec.phone, body: text, label: ec.name || p.name });
    const row = {
      id: nextId('dial_log'), channel: 'SMS', personnel_id: p.id,
      to_number: sms.normalizeNumber(ec.phone) || String(ec.phone || ''),
      from_number: null, actor_user_id: user.id, actor_name: user.display_name,
      job_id: null, site_visit_id: null, body: text,
      provider: result.dryRun ? 'none' : 'twilio', provider_ref: result.sid || null,
      outcome: result.ok ? (result.dryRun ? 'ATTEMPTED' : 'QUEUED') : 'FAILED',
      error_code: result.ok ? null : (result.error || 'send failed'),
      duration_s: null, attempted_at: new Date().toISOString(), settled_at: null,
    };
    db.dial_log.push(row);
    logEvent('ical_feed.sms_sent', result.ok
      ? `${user.display_name} SENT ${p.name}'S ROTA LINK TO THEIR EMERGENCY CONTACT${result.dryRun ? ' (dry run — SMS_LIVE is off, nothing sent)' : ` (queued, ${result.sid})`}`
      : `ROTA LINK SMS TO ${p.name}'S EMERGENCY CONTACT FAILED — ${result.error}`,
      { dial_log_id: row.id, personnel_id: p.id, sid: result.sid || null });
    if (!result.ok) throw httpError(502, result.error || 'send failed');
    return { ok: true, dry_run: Boolean(result.dryRun) };
  });

  return { assertAssignmentAccess, assignedPersonnelIds, findAssignment, findShift, londonParts, londonToUtc, shiftRecurrenceTick };
};
