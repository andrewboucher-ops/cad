/**
 * Sites under contract, passdown logs, beats, patrol schedules, site visits
 * (patrols), guard tour checkpoint scans and the patrol scheduling tick.
 *
 * Moved out of server.js unchanged. Registrar pattern: server.js passes in
 * what this needs, at the same point in route order as before.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

module.exports = function registerSites({ route, httpError, ALL, CONTROL, ADMIN, db, nextId, logEvent, broadcast, pushToRoles, pushToUsers, findPersonnel, isControlRole, siteVisibleTo, normalizedBranchId, MIME, MEDIA_MIME_EXT, SITE_VISIT_STATES, mediaDir, visitMediaDir, instantiateChecklist, stampVisitStatus, buildResolutionReportHtml, sendResolutionReportEmail, publicBeat, publicPassdownLog, publicPatrolSchedule, publicSiteVisit }) {
  /* Sites under contract — what alarm response jobs are attached to. */
  const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  route('GET', '/api/sites', ALL, ({ user }) => db.sites.filter((s) => siteVisibleTo(s.id, user)));
  route('POST', '/api/sites', CONTROL, ({ body }) => {
    const name = String(body.name || '').trim();
    if (!name) throw httpError(400, 'name required');
    if (db.sites.some((x) => x.name.toLowerCase() === name.toLowerCase())) throw httpError(409, 'site already exists');
    if (body.risk_level && !RISK_LEVELS.includes(body.risk_level)) throw httpError(400, `risk_level must be one of ${RISK_LEVELS.join(', ')}`);
    const site = {
      id: nextId('sites'), name, address: body.address || '', lat: Number(body.lat) || null, lon: Number(body.lon) || null,
      keyholder: body.keyholder || '', contact_email: body.contact_email || '', accounts_email: String(body.accounts_email || '').trim(), contract: 'ACTIVE', checklist: [],
      response_sla_minutes: body.response_sla_minutes ? Number(body.response_sla_minutes) : null,
      geofence_m: body.geofence_m === undefined || body.geofence_m === null || body.geofence_m === '' ? null : Math.min(Math.max(Number(body.geofence_m) || 0, 0), 5000),
      branch_id: normalizedBranchId(body.branch_id),
      code: String(body.code || '').trim(), postcode: String(body.postcode || '').trim(),
      // The stable key AURA's callout webhook carries as incidentInformation[].predefinedLocationId
      // — maps an inbound callout straight to this site without guessing from address text.
      aura_location_id: String(body.aura_location_id || '').trim(),
      // Not validated against the IANA database — a typo here shows up as a
      // visibly wrong time on the rota rather than failing closed, which is
      // the safer failure mode for a field with no live-consequence default.
      timezone: String(body.timezone || '').trim() || 'Europe/London',
      risk_level: body.risk_level || null, access_instructions: body.access_instructions || '',
      // Informational, not enforced to exactly one — see README.md.
      is_control_room: body.is_control_room === true,
    };
    db.sites.push(site);
    logEvent('site.created', `SITE ${name} ADDED`);
    return { __status: 201, __body: site };
  });
  route('PATCH', '/api/sites/:id', ADMIN, ({ params, body }) => {
    const site = db.sites.find((x) => x.id === Number(params.id));
    if (!site) throw httpError(404, 'site not found');
    if ('name' in body) {
      const name = String(body.name || '').trim();
      if (!name) throw httpError(400, 'name required');
      if (db.sites.some((x) => x.id !== site.id && x.name.toLowerCase() === name.toLowerCase())) throw httpError(409, 'site already exists');
      site.name = name;
    }
    if ('address' in body) site.address = body.address || '';
    if ('branch_id' in body) site.branch_id = normalizedBranchId(body.branch_id);
    if ('lat' in body) site.lat = body.lat === null || body.lat === '' ? null : Number(body.lat);
    if ('lon' in body) site.lon = body.lon === null || body.lon === '' ? null : Number(body.lon);
    if ('keyholder' in body) site.keyholder = body.keyholder || '';
    if ('contact_email' in body) site.contact_email = body.contact_email || '';
    if ('accounts_email' in body) site.accounts_email = String(body.accounts_email || '').trim();
    if ('response_sla_minutes' in body) {
      if (body.response_sla_minutes !== null && (!Number.isFinite(Number(body.response_sla_minutes)) || Number(body.response_sla_minutes) <= 0)) {
        throw httpError(400, 'response_sla_minutes must be a positive number of minutes, or null');
      }
      site.response_sla_minutes = body.response_sla_minutes === null ? null : Number(body.response_sla_minutes);
    }
    if ('code' in body) site.code = String(body.code || '').trim();
    if ('geofence_m' in body) {
      if (body.geofence_m !== null && body.geofence_m !== '' && (!Number.isFinite(Number(body.geofence_m)) || Number(body.geofence_m) < 0 || Number(body.geofence_m) > 5000)) throw httpError(400, 'geofence must be 0–5000 metres (0 = off)');
      site.geofence_m = body.geofence_m === null || body.geofence_m === '' ? null : Number(body.geofence_m);
    }
    if ('postcode' in body) site.postcode = String(body.postcode || '').trim();
    if ('aura_location_id' in body) site.aura_location_id = String(body.aura_location_id || '').trim();
    if ('timezone' in body) site.timezone = String(body.timezone || '').trim() || 'Europe/London';
    if ('risk_level' in body) {
      if (body.risk_level && !RISK_LEVELS.includes(body.risk_level)) throw httpError(400, `risk_level must be one of ${RISK_LEVELS.join(', ')}`);
      site.risk_level = body.risk_level || null;
    }
    if ('access_instructions' in body) site.access_instructions = body.access_instructions || '';
    if ('is_control_room' in body) site.is_control_room = Boolean(body.is_control_room);
    if ('checklist' in body) {
      if (!Array.isArray(body.checklist)) throw httpError(400, 'checklist must be an array');
      site.checklist = body.checklist.map((item) => ({
        id: item.id || crypto.randomUUID(), title: String(item.title || '').trim(), instructions: String(item.instructions || '').trim(),
      })).filter((item) => item.title);
    }
    logEvent('site.updated', `SITE ${site.name} UPDATED`, { site_id: site.id });
    return site;
  });
  route('DELETE', '/api/sites/:id', ADMIN, ({ params }) => {
    const site = db.sites.find((x) => x.id === Number(params.id));
    if (!site) throw httpError(404, 'site not found');
    if (db.jobs.some((j) => j.site_id === site.id && !['COMPLETED', 'CANCELLED'].includes(j.status))) {
      throw httpError(409, 'site has an open job — resolve or cancel it first');
    }
    if (db.patrol_schedules.some((s) => s.site_id === site.id)) {
      throw httpError(409, 'site has patrol schedules — delete them first');
    }
    if (db.beats.some((b) => b.site_id === site.id)) {
      throw httpError(409, 'site has beats — delete them first');
    }
    if (db.site_visits.some((v) => v.site_id === site.id && !['COMPLETED', 'CANCELLED', 'MISSED'].includes(v.status))) {
      throw httpError(409, 'site has an open site visit — resolve or cancel it first');
    }
    db.sites = db.sites.filter((x) => x.id !== site.id);
    logEvent('site.deleted', `SITE ${site.name} DELETED`, { site_id: site.id });
    return { ok: true };
  });

  /* Passdown logs — per-site shift-handover notes. Control can read/write any
   * site's log; a FIELD_USER can read/write a site's log only if they've
   * actually been assigned there (a current or past shift or site visit) — the
   * same "were you ever posted here" test either row type already answers, so
   * no separate roster is needed. Entries are an append-only log, like the
   * audit trail: no edit route, a DELETE for control to correct a mistake. */
  function assertPassdownAccess(siteId, user) {
    if (isControlRole(user.role)) {
      // DISPATCHER/SYSTEM_ADMIN are never branch/site-scoped (see
      // BRANCH_SCOPED_ROLES), so this only actually constrains a scoped
      // SUPERVISOR — the same "don't confirm it exists" 404 the rest of
      // this file uses for an out-of-scope record.
      if (!siteVisibleTo(siteId, user)) throw httpError(404, 'site not found');
      return;
    }
    if (user.role === 'FIELD_USER' && user.personnel_id) {
      const hasShift = db.shifts.some((s) => s.site_id === siteId
        && db.shift_assignments.some((a) => a.shift_id === s.id && a.personnel_id === user.personnel_id && a.status !== 'REMOVED'));
      const hasVisit = db.site_visits.some((v) => v.site_id === siteId
        && (v.personnel_id === user.personnel_id || (v.additional_personnel || []).includes(user.personnel_id)));
      if (hasShift || hasVisit) return;
    }
    throw httpError(403, 'not assigned to this site');
  }
  route('GET', '/api/passdown-logs', ALL, ({ query, user }) => {
    const siteId = Number(query.get('site_id'));
    if (!siteId) throw httpError(400, 'site_id required');
    if (!db.sites.some((s) => s.id === siteId)) throw httpError(404, 'site not found');
    assertPassdownAccess(siteId, user);
    return db.passdown_logs.filter((l) => l.site_id === siteId)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .map(publicPassdownLog);
  });
  route('POST', '/api/passdown-logs', ALL, ({ body, user }) => {
    const site = db.sites.find((s) => s.id === Number(body.site_id));
    if (!site) throw httpError(400, 'site_id must reference an existing site');
    assertPassdownAccess(site.id, user);
    const text = String(body.body || '').trim();
    if (!text) throw httpError(400, 'body required');
    const author = user.role === 'FIELD_USER' && user.personnel_id ? db.personnel.find((p) => p.id === user.personnel_id) : null;
    const log = {
      id: nextId('passdown_logs'), site_id: site.id, body: text.slice(0, 4000),
      author_personnel_id: author ? author.id : null, author_name: author ? author.name : user.display_name,
      created_at: new Date().toISOString(),
    };
    db.passdown_logs.push(log);
    broadcast('passdown_log.created', publicPassdownLog(log));
    logEvent('passdown_log.created', `PASSDOWN NOTE ADDED FOR ${site.name} BY ${log.author_name}`, { site_id: site.id, passdown_log_id: log.id });
    return { __status: 201, __body: publicPassdownLog(log) };
  });
  route('DELETE', '/api/passdown-logs/:id', ADMIN, ({ params }) => {
    const l = db.passdown_logs.find((x) => x.id === Number(params.id)); if (!l) throw httpError(404, 'passdown log not found');
    db.passdown_logs = db.passdown_logs.filter((x) => x.id !== l.id);
    logEvent('passdown_log.deleted', 'PASSDOWN NOTE DELETED', { passdown_log_id: l.id, site_id: l.site_id });
    return { ok: true };
  });

  /* Beats — a named patrol route within a site (e.g. "Perimeter", "Car park
   * sweep"), for sites where one checklist doesn't describe the work. Purely
   * optional: a patrol schedule or a manually created visit can reference one,
   * but neither requires it — a site with no beats behaves exactly as before. */
  route('GET', '/api/beats', ALL, ({ query }) => {
    let rows = db.beats.map(publicBeat);
    if (query.get('site_id')) rows = rows.filter((b) => b.site_id === Number(query.get('site_id')));
    return rows;
  });
  route('POST', '/api/beats', CONTROL, ({ body }) => {
    const site = db.sites.find((s) => s.id === Number(body.site_id));
    if (!site) throw httpError(400, 'site_id must reference an existing site');
    const name = String(body.name || '').trim();
    if (!name) throw httpError(400, 'name required');
    const beat = { id: nextId('beats'), site_id: site.id, name, description: body.description || '', waypoints: [], active: body.active !== false };
    db.beats.push(beat);
    logEvent('beat.created', `BEAT "${name}" CREATED FOR ${site.name}`, { beat_id: beat.id });
    return { __status: 201, __body: publicBeat(beat) };
  });
  route('PATCH', '/api/beats/:id', CONTROL, ({ params, body }) => {
    const b = db.beats.find((x) => x.id === Number(params.id)); if (!b) throw httpError(404, 'beat not found');
    if ('name' in body) { const name = String(body.name || '').trim(); if (!name) throw httpError(400, 'name required'); b.name = name; }
    if ('description' in body) b.description = body.description || '';
    if ('active' in body) b.active = Boolean(body.active);
    if ('waypoints' in body) {
      if (!Array.isArray(body.waypoints)) throw httpError(400, 'waypoints must be an array');
      b.waypoints = body.waypoints.map((w) => ({
        id: w.id || crypto.randomUUID(), title: String(w.title || '').trim(), instructions: String(w.instructions || '').trim(),
      })).filter((w) => w.title);
    }
    logEvent('beat.updated', `BEAT "${b.name}" UPDATED`, { beat_id: b.id });
    return publicBeat(b);
  });
  route('DELETE', '/api/beats/:id', ADMIN, ({ params }) => {
    const b = db.beats.find((x) => x.id === Number(params.id)); if (!b) throw httpError(404, 'beat not found');
    if (db.patrol_schedules.some((s) => s.beat_id === b.id)) throw httpError(409, 'beat has patrol schedules — reassign or delete them first');
    if (db.site_visits.some((v) => v.beat_id === b.id && !['COMPLETED', 'CANCELLED', 'MISSED'].includes(v.status))) {
      throw httpError(409, 'beat has an open site visit — resolve or cancel it first');
    }
    db.beats = db.beats.filter((x) => x.id !== b.id);
    logEvent('beat.deleted', `BEAT "${b.name}" DELETED`, { beat_id: b.id });
    return { ok: true };
  });

  /* ------------------------------------------------------------------ *
   * Patrol schedules and site visits
   *
   * A scheduled, recurring alternative to one-off jobs: a patrol_schedules
   * row describes a recurrence ("every Tuesday/Thursday at 22:00" or "every
   * 4 hours"); patrolScheduleTick() below turns a due occurrence into a
   * site_visits row, which then walks the same DISPATCHED -> ACKNOWLEDGED ->
   * EN_ROUTE -> ON_SCENE -> COMPLETED lifecycle as a job, reusing the same
   * checklist/photo/resolution-report machinery. Deliberately simpler than
   * job_assignments: a visit carries its assignee(s) directly (personnel_id +
   * additional_personnel[]) rather than through a join table, since a visit
   * is never assigned to an MDT — it's foot-patrol work.
   * ------------------------------------------------------------------ */
  route('GET', '/api/patrol-schedules', ALL, ({ query }) => {
    let rows = db.patrol_schedules.map(publicPatrolSchedule);
    if (query.get('site_id')) rows = rows.filter((s) => s.site_id === Number(query.get('site_id')));
    return rows;
  });
  function resolveBeatId(rawBeatId, siteId) {
    if (!rawBeatId) return null;
    const beat = db.beats.find((b) => b.id === Number(rawBeatId));
    if (!beat) throw httpError(400, 'beat_id must reference an existing beat');
    if (beat.site_id !== siteId) throw httpError(400, 'beat does not belong to this site');
    return beat.id;
  }
  route('POST', '/api/patrol-schedules', CONTROL, ({ body }) => {
    const site = db.sites.find((s) => s.id === Number(body.site_id));
    if (!site) throw httpError(400, 'site_id must reference an existing site');
    const label = String(body.label || '').trim();
    if (!label) throw httpError(400, 'label required');
    const daysOfWeek = Array.isArray(body.days_of_week) ? body.days_of_week.map(Number).filter((d) => d >= 0 && d <= 6) : null;
    const intervalHours = body.interval_hours != null && body.interval_hours !== '' ? Number(body.interval_hours) : null;
    if (!(daysOfWeek && daysOfWeek.length) && !intervalHours) throw httpError(400, 'either days_of_week (with time_of_day) or interval_hours is required');
    const schedule = {
      id: nextId('patrol_schedules'), site_id: site.id, beat_id: resolveBeatId(body.beat_id, site.id), label,
      days_of_week: daysOfWeek && daysOfWeek.length ? daysOfWeek : null,
      time_of_day: body.time_of_day || null,
      interval_hours: intervalHours || null,
      duration_expected_min: Number(body.duration_expected_min) || 30,
      active: body.active !== false,
    };
    db.patrol_schedules.push(schedule);
    logEvent('patrol_schedule.created', `PATROL SCHEDULE "${label}" CREATED FOR ${site.name}`, { patrol_schedule_id: schedule.id });
    return { __status: 201, __body: publicPatrolSchedule(schedule) };
  });
  route('PATCH', '/api/patrol-schedules/:id', CONTROL, ({ params, body }) => {
    const s = db.patrol_schedules.find((x) => x.id === Number(params.id)); if (!s) throw httpError(404, 'patrol schedule not found');
    if ('label' in body) { const label = String(body.label || '').trim(); if (!label) throw httpError(400, 'label required'); s.label = label; }
    if ('days_of_week' in body) s.days_of_week = Array.isArray(body.days_of_week) && body.days_of_week.length ? body.days_of_week.map(Number) : null;
    if ('time_of_day' in body) s.time_of_day = body.time_of_day || null;
    if ('interval_hours' in body) s.interval_hours = body.interval_hours != null && body.interval_hours !== '' ? Number(body.interval_hours) : null;
    if ('duration_expected_min' in body) s.duration_expected_min = Number(body.duration_expected_min) || 30;
    if ('active' in body) s.active = Boolean(body.active);
    if ('beat_id' in body) s.beat_id = resolveBeatId(body.beat_id, s.site_id);
    logEvent('patrol_schedule.updated', `PATROL SCHEDULE "${s.label}" UPDATED`, { patrol_schedule_id: s.id });
    return publicPatrolSchedule(s);
  });
  route('DELETE', '/api/patrol-schedules/:id', ADMIN, ({ params }) => {
    const s = db.patrol_schedules.find((x) => x.id === Number(params.id)); if (!s) throw httpError(404, 'patrol schedule not found');
    db.patrol_schedules = db.patrol_schedules.filter((x) => x.id !== s.id);
    logEvent('patrol_schedule.deleted', `PATROL SCHEDULE "${s.label}" DELETED`, { patrol_schedule_id: s.id });
    return { ok: true };
  });

  function nextVisitReference() {
    return `VISIT-${new Date().getFullYear()}-${String(nextId('visitref') + 40).padStart(5, '0')}`;
  }
  route('GET', '/api/site-visits', ALL, ({ query, user }) => {
    let rows = db.site_visits.filter((v) => siteVisibleTo(v.site_id, user)).map(publicSiteVisit);
    if (query.get('status')) rows = rows.filter((v) => v.status === query.get('status').toUpperCase());
    if (query.get('site_id')) rows = rows.filter((v) => v.site_id === Number(query.get('site_id')));
    return rows;
  });
  route('POST', '/api/site-visits', CONTROL, ({ body, user }) => {
    const site = db.sites.find((s) => s.id === Number(body.site_id));
    if (!site) throw httpError(400, 'site_id must reference an existing site');
    const v = {
      id: nextId('site_visits'), reference: nextVisitReference(), site_id: site.id, schedule_id: null, beat_id: resolveBeatId(body.beat_id, site.id),
      personnel_id: null, additional_personnel: [], status: 'SCHEDULED',
      scheduled_for: body.scheduled_for || new Date().toISOString(),
      dispatched_at: null, acknowledged_at: null, en_route_at: null, on_scene_at: null, completed_at: null, cancelled_at: null, missed_at: null,
      notes: body.notes || '', checklist: instantiateChecklist(site), media: [], report_html: null,
      checkpoint_scans: [],
      created_by: user.id, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    db.site_visits.push(v);
    broadcast('site_visit.created', publicSiteVisit(v));
    logEvent('site_visit.created', `VISIT ${v.reference} CREATED FOR ${site.name}`, { site_visit_id: v.id });
    return { __status: 201, __body: publicSiteVisit(v) };
  });

  /* One-off visits for a client at an address that isn't one of their
   * sites — e.g. AURA passing on a patrol at their own customer's premises.
   * Control types the address; this makes (or reuses) a one-off site under
   * that client, so the visit runs like any other (officer app, checklist,
   * photos, report), the report goes to the client's contact email and
   * shows in their portal. Not billed in CCCS (Andy invoices these in
   * Xero himself, 2026-11-10); client_ref holds the client's own job
   * reference to match them up. One-off sites are flagged one_off so lists
   * can keep them apart from sites under contract. */
  route('POST', '/api/site-visits/one-off', CONTROL, ({ body, user }) => {
    const client = (db.clients || []).find((c) => c.id === Number(body.client_id));
    if (!client) throw httpError(400, 'choose the client this visit is for');
    const address = String(body.address || '').trim().slice(0, 300);
    if (!address) throw httpError(400, 'type the address of the site');
    const postcode = String(body.postcode || '').trim().toUpperCase().slice(0, 12);
    const customer = String(body.customer_name || '').trim().slice(0, 120);
    const when = body.scheduled_for ? new Date(body.scheduled_for) : new Date();
    if (Number.isNaN(when.getTime())) throw httpError(400, 'the visit time is not a valid date and time');
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    let site = db.sites.find((s) => s.one_off && s.client_id === client.id && norm(s.address) === norm(address) && norm(s.postcode) === norm(postcode));
    if (!site) {
      const first = customer || address.split(/[,\n]/)[0].trim();
      let name = `${client.name} — ${first}${postcode ? ` (${postcode})` : ''}`.slice(0, 160), n = 2;
      while (db.sites.some((x) => x.name.toLowerCase() === name.toLowerCase())) name = `${client.name} — ${first} ${n++}`;
      site = {
        id: nextId('sites'), name, address, lat: Number(body.lat) || null, lon: Number(body.lon) || null,
        keyholder: '', contact_email: client.contact_email || '', accounts_email: '', contract: 'ONE_OFF', checklist: [],
        response_sla_minutes: null, geofence_m: null, branch_id: null, code: '', postcode, aura_location_id: '', timezone: 'Europe/London',
        risk_level: null, access_instructions: String(body.access_instructions || '').trim().slice(0, 2000), is_control_room: false,
        one_off: true, client_id: client.id, end_customer: customer, created_at: new Date().toISOString(), created_by: user.display_name,
      };
      db.sites.push(site);
      logEvent('site.created', `ONE-OFF SITE ${site.name} ADDED FOR ${client.name}`, { site_id: site.id });
    } else if (body.access_instructions) site.access_instructions = String(body.access_instructions).trim().slice(0, 2000);
    client.site_ids = client.site_ids || [];
    if (!client.site_ids.includes(site.id)) client.site_ids.push(site.id);
    const v = {
      id: nextId('site_visits'), reference: nextVisitReference(), site_id: site.id, schedule_id: null, beat_id: null,
      personnel_id: null, additional_personnel: [], status: 'SCHEDULED', scheduled_for: when.toISOString(),
      dispatched_at: null, acknowledged_at: null, en_route_at: null, on_scene_at: null, completed_at: null, cancelled_at: null, missed_at: null,
      notes: String(body.notes || '').slice(0, 2000), checklist: instantiateChecklist(site), media: [], report_html: null, checkpoint_scans: [],
      one_off: true, client_id: client.id, client_ref: String(body.client_ref || '').trim().slice(0, 60),
      created_by: user.id, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    db.site_visits.push(v);
    broadcast('site_visit.created', publicSiteVisit(v));
    logEvent('site_visit.created', `ONE-OFF VISIT ${v.reference} FOR ${client.name} AT ${address}${v.client_ref ? ` (REF ${v.client_ref})` : ''}`, { site_visit_id: v.id });
    const warnings = [];
    if (!client.contact_email) warnings.push(`${client.name} has no contact email, so the visit report will go to the control room inbox to forward`);
    return { __status: 201, __body: { ...publicSiteVisit(v), warnings } };
  });
  route('POST', '/api/site-visits/:id/assign', CONTROL, ({ params, body }) => {
    const v = db.site_visits.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'site visit not found');
    const p = findPersonnel(body.personnel); if (!p) throw httpError(400, 'personnel required');
    if (v.personnel_id === p.id || (v.additional_personnel || []).includes(p.id)) throw httpError(409, `${p.name} is already assigned to this visit`);
    if (!v.personnel_id) v.personnel_id = p.id;
    else { v.additional_personnel = v.additional_personnel || []; v.additional_personnel.push(p.id); }
    if (v.status === 'SCHEDULED') v.status = 'DISPATCHED';
    stampVisitStatus(v, 'DISPATCHED');
    v.updated_at = new Date().toISOString();
    const site = db.sites.find((s) => s.id === v.site_id);
    const payload = publicSiteVisit(v);
    broadcast('site_visit.dispatched', payload);
    broadcast('site_visit.assigned_to_you', payload, { personnelIds: [p.id] });
    pushToUsers(db.users.filter((u) => u.personnel_id === p.id).map((u) => u.id),
      { title: `Patrol visit ${v.reference}`, body: site ? site.name : 'Site visit', url: '/officer.html', tag: 'cccs-visit' });
    logEvent('site_visit.dispatched', `VISIT ${v.reference} DISPATCHED → ${p.name}`, { site_visit_id: v.id });
    return payload;
  });
  function assertVisitAccess(v, user) {
    if (isControlRole(user.role)) return;
    const mine = user.role === 'FIELD_USER' && user.personnel_id
      && (v.personnel_id === user.personnel_id || (v.additional_personnel || []).includes(user.personnel_id));
    if (!mine) throw httpError(403, 'visit not assigned to you');
  }
  route('POST', '/api/site-visits/:id/ack', ALL, ({ params, user }) => {
    const v = db.site_visits.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'site visit not found');
    assertVisitAccess(v, user);
    if (v.status === 'DISPATCHED') v.status = 'ACKNOWLEDGED';
    stampVisitStatus(v, 'ACKNOWLEDGED');
    v.updated_at = new Date().toISOString();
    const who = user.role === 'FIELD_USER' ? (db.personnel.find((p) => p.id === user.personnel_id) || {}).name : user.display_name;
    broadcast('site_visit.acknowledged', { visit: publicSiteVisit(v), by: who });
    logEvent('site_visit.acknowledged', `${who} ACKNOWLEDGED VISIT ${v.reference}`, { site_visit_id: v.id });
    return publicSiteVisit(v);
  });
  const SITE_VISIT_TS_FIELDS = ['dispatched_at', 'acknowledged_at', 'en_route_at', 'on_scene_at', 'completed_at'];
  route('PATCH', '/api/site-visits/:id', ALL, ({ params, body, user }) => {
    const v = db.site_visits.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'site visit not found');
    // Control can set the actual stepper times directly — for a patrol
    // confirmed done by radio or in person, rather than through the officer
    // app's own checkpoint scans, there is otherwise no way to record when
    // it really happened instead of defaulting every stage to "now" the
    // moment status flips to COMPLETED. Applied before the status block
    // below so stampVisitStatus's "only if not already set" guard respects
    // whatever was explicitly given here.
    const settingTimes = isControlRole(user.role) && SITE_VISIT_TS_FIELDS.some((f) => f in body);
    if (settingTimes) {
      for (const f of SITE_VISIT_TS_FIELDS) {
        if (!(f in body)) continue;
        if (body[f] !== null && !Number.isFinite(Date.parse(body[f]))) throw httpError(400, `invalid ${f}`);
        v[f] = body[f] ? new Date(body[f]).toISOString() : null;
      }
    }
    if (body.status) {
      const s = String(body.status).toUpperCase();
      if (!SITE_VISIT_STATES.includes(s)) throw httpError(400, 'invalid visit status');
      assertVisitAccess(v, user);
      v.status = s;
      stampVisitStatus(v, s);
      if (s === 'COMPLETED') {
        const site = db.sites.find((x) => x.id === v.site_id);
        const beat = v.beat_id ? db.beats.find((x) => x.id === v.beat_id) : null;
        const waypoints = beat ? beat.waypoints || [] : [];
        const scannedIds = new Set((v.checkpoint_scans || []).map((sc) => sc.waypoint_id));
        v.report_html = buildResolutionReportHtml({
          reference: v.reference, kindLabel: 'Patrol visit', locationLabel: site ? site.name : 'Site visit', siteId: v.site_id,
          description: '', notes: v.notes,
          timeline: [
            ['Scheduled', v.scheduled_for], ['Dispatched', v.dispatched_at], ['Acknowledged', v.acknowledged_at],
            ['En route', v.en_route_at], ['On scene', v.on_scene_at], ['Completed', v.completed_at],
          ].filter(([, t]) => t),
          checklist: v.checklist, media: v.media,
          extraRows: (v.one_off ? [['Address', [site && site.address, site && site.postcode].filter(Boolean).join(' ')], ...(v.client_ref ? [['Your reference', v.client_ref]] : [])] : []).concat(waypoints.length ? [['Checkpoints', `${waypoints.filter((w) => scannedIds.has(w.id)).length} / ${waypoints.length} scanned` + (waypoints.some((w) => !scannedIds.has(w.id)) ? ` (missing: ${waypoints.filter((w) => !scannedIds.has(w.id)).map((w) => w.title).join(', ')})` : '')]] : []),
        });
        // An hourly shift patrol would mean a dozen emails a shift — those are
        // in the client portal (routes-shift-patrols.js) instead.
        if (!v.shift_id) sendResolutionReportEmail({
          reference: v.reference, siteId: v.site_id, media: v.media, mediaDir: visitMediaDir(v.id),
          logType: 'site_visit.report_emailed', logIdKey: 'site_visit_id', logId: v.id,
        }, v.report_html);
        logEvent('site_visit.report_generated', `RESOLUTION REPORT GENERATED FOR ${v.reference}`, { site_visit_id: v.id });
      }
    }
    if (body.notes !== undefined) v.notes = String(body.notes).slice(0, 2000);
    v.updated_at = new Date().toISOString();
    broadcast('site_visit.status_changed', publicSiteVisit(v));
    if (settingTimes) {
      logEvent('site_visit.times_corrected', `VISIT ${v.reference} TIMES SET BY ${user.display_name} (not via the officer app)`, { site_visit_id: v.id, corrected_by: user.id });
    }
    logEvent('site_visit.status_changed', `VISIT ${v.reference} → ${v.status}`, { site_visit_id: v.id });
    return publicSiteVisit(v);
  });
  route('PATCH', '/api/site-visits/:id/checklist/:itemId', ALL, ({ params, body, user }) => {
    const v = db.site_visits.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'site visit not found');
    assertVisitAccess(v, user);
    const item = (v.checklist || []).find((x) => x.id === params.itemId); if (!item) throw httpError(404, 'checklist item not found');
    if (body.status) {
      const s = String(body.status).toUpperCase();
      if (!['PENDING', 'COMPLETE'].includes(s)) throw httpError(400, 'invalid checklist status');
      item.status = s;
      if (s === 'COMPLETE') { item.completed_at = new Date().toISOString(); item.completed_by = user.display_name; }
      else { item.completed_at = null; item.completed_by = null; }
    }
    if (body.notes !== undefined) item.notes = String(body.notes).slice(0, 2000);
    v.updated_at = new Date().toISOString();
    broadcast('site_visit.status_changed', publicSiteVisit(v));
    logEvent('site_visit.checklist_updated', `${item.status === 'COMPLETE' ? 'COMPLETED' : 'UPDATED'} "${item.title}" on VISIT ${v.reference}`, { site_visit_id: v.id });
    return publicSiteVisit(v);
  });
  route('POST', '/api/site-visits/:id/media', ALL, ({ params, body, user }) => {
    const v = db.site_visits.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'site visit not found');
    assertVisitAccess(v, user);
    const ext = MEDIA_MIME_EXT[body.mimetype];
    if (!ext) throw httpError(400, 'mimetype must be image/jpeg, image/png or image/webp');
    if (!body.data) throw httpError(400, 'data (base64) required');
    if (body.checklist_item_id && !(v.checklist || []).some((x) => x.id === body.checklist_item_id)) throw httpError(404, 'checklist item not found');
    const bytes = Buffer.from(body.data, 'base64');
    if (bytes.length > 8e6) throw httpError(413, 'photo too large');
    const dir = visitMediaDir(v.id);
    fs.mkdirSync(dir, { recursive: true });
    const mediaId = crypto.randomUUID();
    const filename = `${mediaId}${ext}`;
    fs.writeFileSync(path.join(dir, filename), bytes);
    const media = {
      id: mediaId, url: `/api/site-visits/${v.id}/media/${mediaId}`, filename, caption: String(body.caption || '').slice(0, 200),
      checklist_item_id: body.checklist_item_id || null, taken_by: user.display_name, taken_at: new Date().toISOString(),
    };
    v.media = v.media || [];
    v.media.push(media);
    v.updated_at = new Date().toISOString();
    broadcast('site_visit.status_changed', publicSiteVisit(v));
    logEvent('site_visit.media_added', `PHOTO ADDED TO VISIT ${v.reference}`, { site_visit_id: v.id });
    return { __status: 201, __body: media };
  });
  route('GET', '/api/site-visits/:id/media/:mediaId', ALL, ({ params, user }) => {
    const v = db.site_visits.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'site visit not found');
    assertVisitAccess(v, user);
    const m = (v.media || []).find((x) => x.id === params.mediaId); if (!m) throw httpError(404, 'photo not found');
    const file = path.join(visitMediaDir(v.id), m.filename);
    if (!fs.existsSync(file)) throw httpError(404, 'photo file missing');
    return { __body: fs.readFileSync(file), __headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'private, max-age=86400' } };
  });
  route('GET', '/api/site-visits/:id/report', CONTROL, ({ params }) => {
    const v = db.site_visits.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'site visit not found');
    if (!v.report_html) throw httpError(404, 'no report yet — the visit has not been completed');
    return { __body: v.report_html, __headers: { 'content-type': 'text/html; charset=utf-8' } };
  });
  route('POST', '/api/site-visits/:id/stand-down', CONTROL, ({ params, body }) => {
    const v = db.site_visits.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'site visit not found');
    const p = findPersonnel(body.personnel); if (!p) throw httpError(400, 'personnel required');
    let removed = false;
    if (v.personnel_id === p.id) { v.personnel_id = (v.additional_personnel || []).shift() || null; removed = true; }
    else if ((v.additional_personnel || []).includes(p.id)) { v.additional_personnel = v.additional_personnel.filter((id) => id !== p.id); removed = true; }
    if (!removed) throw httpError(404, 'that person is not assigned to this visit');
    if (!v.personnel_id && !(v.additional_personnel || []).length && v.status === 'DISPATCHED') v.status = 'SCHEDULED';
    v.updated_at = new Date().toISOString();
    const payload = publicSiteVisit(v);
    broadcast('site_visit.status_changed', payload);
    broadcast('site_visit.stood_down', payload, { personnelIds: [p.id] });
    logEvent('site_visit.stood_down', `${p.name} STOOD DOWN FROM VISIT ${v.reference}`, { site_visit_id: v.id });
    return payload;
  });

  /* Guard tour checkpoint scanning — a beat's waypoints (see the Beats
   * section above) double as checkpoints: each one gets a QR code (just its
   * own id, printed/posted at the physical location — see admin.html's Beats
   * tab), and scanning it here is what proves an officer actually reached
   * that point rather than just clicking through a list from the break room.
   * Re-scanning the same waypoint is allowed — a real tour sometimes revisits
   * a point, and the log is a timeline, not a checklist that needs undoing. */
  route('POST', '/api/site-visits/:id/checkpoint-scan', ALL, ({ params, body, user }) => {
    const v = db.site_visits.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'site visit not found');
    assertVisitAccess(v, user);
    if (['COMPLETED', 'CANCELLED', 'MISSED'].includes(v.status)) throw httpError(409, 'visit is already closed');
    if (!v.beat_id) throw httpError(400, 'this visit has no beat — nothing to scan against');
    const beat = db.beats.find((b) => b.id === v.beat_id);
    const waypoint = beat && (beat.waypoints || []).find((w) => w.id === body.waypoint_id);
    if (!waypoint) throw httpError(404, 'waypoint not found on this visit\'s beat');
    const scan = {
      id: crypto.randomUUID(), waypoint_id: waypoint.id, waypoint_title: waypoint.title,
      scanned_at: new Date().toISOString(), scanned_by: user.role === 'FIELD_USER' ? user.personnel_id : null,
      lat: body.lat != null ? Number(body.lat) : null, lon: body.lon != null ? Number(body.lon) : null,
    };
    v.checkpoint_scans = v.checkpoint_scans || [];
    v.checkpoint_scans.push(scan);
    v.updated_at = new Date().toISOString();
    const payload = publicSiteVisit(v);
    broadcast('site_visit.status_changed', payload);
    const who = user.role === 'FIELD_USER' ? (db.personnel.find((p) => p.id === user.personnel_id) || {}).name : user.display_name;
    logEvent('site_visit.checkpoint_scanned', `${who} SCANNED "${waypoint.title}" ON VISIT ${v.reference}`, { site_visit_id: v.id, waypoint_id: waypoint.id });
    return { __status: 201, __body: payload };
  });

  /* ---- Patrol scheduling tick ------------------------------------------
   * Turns a due patrol_schedules occurrence into a SCHEDULED site_visits row,
   * and flags a SCHEDULED visit nobody ever dispatched, well past its window,
   * as MISSED — a silent gap in patrol coverage is exactly what this exists
   * to surface, not something to let quietly age out. */
  const PATROL_SCHEDULE_TICK_MS = Number(process.env.PATROL_SCHEDULE_TICK_MS || 60000);
  const VISIT_MISSED_GRACE_MIN = Number(process.env.VISIT_MISSED_GRACE_MIN || 120);
  const OPEN_VISIT_STATES = ['SCHEDULED', 'DISPATCHED', 'ACKNOWLEDGED', 'EN_ROUTE', 'ON_SCENE'];
  function createSiteVisitFromSchedule(schedule, scheduledFor) {
    const site = db.sites.find((s) => s.id === schedule.site_id);
    if (!site) return null;
    const v = {
      id: nextId('site_visits'), reference: nextVisitReference(), site_id: site.id, schedule_id: schedule.id, beat_id: schedule.beat_id || null,
      personnel_id: null, additional_personnel: [], status: 'SCHEDULED',
      scheduled_for: scheduledFor.toISOString(),
      dispatched_at: null, acknowledged_at: null, en_route_at: null, on_scene_at: null, completed_at: null, cancelled_at: null, missed_at: null,
      notes: '', checklist: instantiateChecklist(site), media: [], report_html: null,
      checkpoint_scans: [],
      created_by: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    db.site_visits.push(v);
    broadcast('site_visit.created', publicSiteVisit(v));
    logEvent('site_visit.created', `VISIT ${v.reference} SCHEDULED FOR ${site.name} (${schedule.label})`, { site_visit_id: v.id, patrol_schedule_id: schedule.id });
    return v;
  }
  /** A patrol on a shift (routes-shift-patrols.js). The officers are already
   * on site and clocked in, so it starts ON_SCENE: scan, then complete. */
  function createPatrolVisit({ shift, seq, dueAt, personnelIds }) {
    const site = db.sites.find((s) => s.id === shift.site_id);
    const now = new Date().toISOString();
    const on = personnelIds && personnelIds.length;
    const v = {
      id: nextId('site_visits'), reference: nextVisitReference(), site_id: site ? site.id : shift.site_id, schedule_id: null, beat_id: shift.patrol.beat_id || null,
      shift_id: shift.id, patrol_seq: seq,
      personnel_id: on ? personnelIds[0] : null, additional_personnel: on ? personnelIds.slice(1) : [], status: on ? 'ON_SCENE' : 'SCHEDULED',
      scheduled_for: dueAt.toISOString(),
      dispatched_at: on ? now : null, acknowledged_at: on ? now : null, en_route_at: null, on_scene_at: on ? now : null, completed_at: null, cancelled_at: null, missed_at: null,
      notes: '', checklist: [], media: [], report_html: null, checkpoint_scans: [],
      created_by: null, created_at: now, updated_at: now,
    };
    db.site_visits.push(v);
    broadcast('site_visit.created', publicSiteVisit(v));
    logEvent('site_visit.created', `PATROL ${v.reference} DUE ${dueAt.toISOString()} AT ${site ? site.name : 'SITE'} (SHIFT ${shift.id}, NO. ${seq})`, { site_visit_id: v.id, shift_id: shift.id });
    return v;
  }
  function patrolScheduleTick() {
    const now = new Date();
    for (const schedule of db.patrol_schedules) {
      if (!schedule.active) continue;
      const existingForSchedule = db.site_visits.filter((v) => v.schedule_id === schedule.id);
      const hasOpen = existingForSchedule.some((v) => OPEN_VISIT_STATES.includes(v.status));

      if (schedule.interval_hours) {
        if (hasOpen) continue;
        const last = existingForSchedule.slice().sort((a, b) => Date.parse(b.scheduled_for) - Date.parse(a.scheduled_for))[0];
        const dueAt = last ? Date.parse(last.scheduled_for) + schedule.interval_hours * 3600000 : now.getTime();
        if (now.getTime() >= dueAt) createSiteVisitFromSchedule(schedule, now);
      } else if (schedule.days_of_week && schedule.time_of_day) {
        const todayIdx = now.getDay();
        if (!schedule.days_of_week.includes(todayIdx)) continue;
        const [hh, mm] = schedule.time_of_day.split(':').map(Number);
        const dueToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
        if (now < dueToday) continue;
        const alreadyToday = existingForSchedule.some((v) => {
          const d = new Date(v.scheduled_for);
          return d.getFullYear() === dueToday.getFullYear() && d.getMonth() === dueToday.getMonth() && d.getDate() === dueToday.getDate();
        });
        if (!alreadyToday) createSiteVisitFromSchedule(schedule, dueToday);
      }
    }

    const graceMs = VISIT_MISSED_GRACE_MIN * 60000;
    for (const v of db.site_visits) {
      if (v.status !== 'SCHEDULED') continue;
      if (now.getTime() - Date.parse(v.scheduled_for) < graceMs) continue;
      v.status = 'MISSED';
      stampVisitStatus(v, 'MISSED');
      v.updated_at = new Date().toISOString();
      broadcast('site_visit.missed', publicSiteVisit(v));
      logEvent('site_visit.missed', `VISIT ${v.reference} MISSED — NEVER DISPATCHED`, { site_visit_id: v.id });
      pushToRoles(CONTROL, { title: 'Missed patrol visit', body: v.reference, url: '/control.html', tag: 'cccs-visit-missed' });
    }
  }

  return { PATROL_SCHEDULE_TICK_MS, assertPassdownAccess, assertVisitAccess, createPatrolVisit, patrolScheduleTick };
};
