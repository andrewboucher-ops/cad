/**
 * External alarm sources: GuardM8 and AURA inbound jobs, and the BroadNet
 * Dispatch bridge (push a job, terminal location webhook).
 *
 * Moved out of server.js unchanged. Registrar pattern: server.js passes in
 * what this needs, at the same point in route order as before.
 */
'use strict';

const crypto = require('crypto');

module.exports = function registerAlarmIntegrations({ route, httpError, CONTROL, db, nextId, logEvent, broadcast, pushToRoles, publicJob, instantiateChecklist, secretMatches, broadnet }) {
  /* ---- External alarm-source integrations --------------------------------
   * GuardM8 (Echelon's separate guarding/alarm-receiving product) and AURA
   * (the separate alarm receiving centre CCCS also pushes emergency-button
   * alerts out to — see cccs-bridge-spec.html) each push an alarm straight
   * in as a dispatchable job, the same shape a call taker would create by hand.
   * Authenticated with a shared secret rather than a user session — neither
   * is a CCCS operator — same pattern as the PBX inbound route below.
   * external_ref lets the source retry a send (e.g. after a network blip)
   * without creating a duplicate job: resending the same external_ref
   * returns the job already created for it instead of making a second one. */
  const EXTERNAL_ALARM_PRIORITY_MAP = {
    RED: 'RED', CRITICAL: 'RED', P1: 'RED',
    AMBER: 'AMBER', HIGH: 'AMBER', P2: 'AMBER',
    GREEN: 'GREEN', MEDIUM: 'GREEN', P3: 'GREEN',
    ROUTINE: 'ROUTINE', LOW: 'ROUTINE', P4: 'ROUTINE',
  };
  /** Shared by every external-alarm source once each has mapped its own wire
   * shape into this one: dedupes on (source, external_ref), then creates a
   * dispatchable job the same shape a call taker would make by hand. */
  function createExternalJob({ source, label, external_ref: externalRef, priority: rawPriority, location, site, incident_type, description, caller, keyholder, lat, lon, what3words, notes, required_resources }) {
    if (externalRef) {
      const existing = db.jobs.find((x) => x.external_ref === externalRef && x.external_source === source);
      if (existing) return { __status: 200, __body: publicJob(existing) };
    }
    const priority = EXTERNAL_ALARM_PRIORITY_MAP[String(rawPriority || 'GREEN').toUpperCase()] || 'GREEN';
    if (!location && !site) throw httpError(400, 'location or site required');

    const j = {
      id: nextId('jobs'), reference: `INC-${new Date().getFullYear()}-${String(nextId('jobref') + 124).padStart(5, '0')}`,
      incident_type: incident_type || 'ALARM', priority,
      location: location || `${site.name}, ${site.address}`,
      site_id: site ? site.id : null, keyholder: site ? site.keyholder : (keyholder || ''),
      lat: lat != null ? Number(lat) : (site && site.lat != null ? site.lat : null),
      lon: lon != null ? Number(lon) : (site && site.lon != null ? site.lon : null),
      description: description || '', caller: caller || label, required_resources: Number(required_resources || 1),
      what3words: String(what3words || '').replace(/^\/+/, '').trim(),
      notes: notes || '', status: 'CREATED', created_by: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      external_source: source, external_ref: externalRef,
      checklist: instantiateChecklist(site), media: [],
    };
    db.jobs.push(j);
    broadcast('job.created', publicJob(j));
    pushToRoles(CONTROL, { title: `New job — ${label}`, body: `${j.reference} · ${j.incident_type} · ${j.location}`, url: '/control.html', tag: 'cccs-job' });
    logEvent('job.created', `JOB ${j.reference} CREATED (${priority}) — via ${label}`, { job_id: j.id, external_ref: externalRef });
    return { __status: 201, __body: publicJob(j) };
  }
  /** Any inbound payload is logged in full before validation, so a shape we
   * don't yet handle (a new message type, a field integration-testing
   * hasn't seen) leaves a full record to read back instead of vanishing as
   * a silent 400 or 401. Remove once an integration is confirmed stable. */
  function logInboundAlarmPayload(source, label, reqBody) {
    logEvent('integration.alarm_payload_received', `${label} INBOUND PAYLOAD`, { source, raw: reqBody });
  }
  function checkAlarmSecret(secretHeader, secretEnv, label, req) {
    const secret = process.env[secretEnv];
    if (!secretMatches(req.headers[secretHeader], secret)) throw httpError(401, `bad ${label} secret`);
  }

  route('POST', '/api/integrations/guardm8/jobs', null, ({ body: b, req }) => {
    checkAlarmSecret('x-guardm8-secret', 'GUARDM8_SECRET', 'GuardM8', req);
    logInboundAlarmPayload('guardm8', 'GuardM8', b);
    const site = b.site ? db.sites.find((x) => x.id === Number(b.site) || x.name === String(b.site)) : null;
    return createExternalJob({
      source: 'guardm8', label: 'GuardM8', external_ref: b.external_ref != null ? String(b.external_ref) : null,
      priority: b.priority, location: b.location, site, incident_type: b.incident_type, description: b.description,
      caller: b.caller, keyholder: b.keyholder, lat: b.lat, lon: b.lon, what3words: b.what3words, notes: b.notes,
      required_resources: b.required_resources,
    });
  });

  /* ---- AURA callouts ------------------------------------------------------
   * AURA's webhook (configured in their portal, not a fixed URL per event)
   * posts every subscribed callout event to this one endpoint, discriminated
   * by body.message (NEW_CALLOUT, CALLOUT_EVENTS_CHANGED, RESPONDER_ARRIVED_
   * ON_SCENE, CALLOUT_CLOSED, ...) rather than GuardM8's flat single-purpose
   * shape. Confirmed against a real captured payload (2026-10-06):
   *   { message, callout: { id, incidentInformation: [{ typeOfEmergency,
   *     incidentcategory, calloutCurrentLocation: { formattedAddress, lat,
   *     lon }, predefinedLocationId, calloutClassification, internalTest },
   *     ... ], ... } }
   * callout.id is the natural idempotency key — the same callout resends on
   * every status change, always with the same id.
   *
   * NEW_CALLOUT / NEW_CALLOUT_FOR_INSTANCE create a job. Every other message
   * is a status update against a callout that (should) already have a job:
   * it is appended to that job's notes and broadcast, rather than silently
   * changing the job's status — an officer already en route should not be
   * stood down just because a webhook said so with nobody at CCCS deciding
   * that. A status update for a callout.id with no matching job is logged
   * (logInboundAlarmPayload already did that) and otherwise ignored. Each
   * message is recorded once per job (external_events_seen) so a resent
   * webhook — AURA's delivery is "at most once" but the same event can still
   * be published more than once on their end — doesn't double a notes line.
   *
   * Severity: confirmed by AURA (2026-10-06) that NEW_CALLOUT carries no
   * urgency field at all — their internal P1–P4 medical triage is never
   * copied onto the webhook. AMBER-for-every-new-callout is therefore the
   * permanent default here, not a placeholder pending more information.
   *
   * Site mapping: incidentInformation[].predefinedLocationId is the stable
   * key AURA's side uses for a Fixed Location — set a site's aura_location_id
   * (Admin → Sites) to the same value to have a callout land straight on
   * that site. Address text (calloutCurrentLocation.formattedAddress) is
   * only ever a fallback for a callout with no predefined location.
   *
   * Classification: calloutClassification.value is REAL or TEST (there is no
   * false-alarm classification). Per AURA (2026-10-06), TEST "should be
   * treated as non-live" until a person verifies it — logged in full, no
   * job put in front of a controller.
   *
   * internalTest — corrected 2026-10-06, having first been built backwards.
   * It does NOT mean "a connectivity test"; it means "stays with your
   * supplier, not dispatched onto AURA's open responder network" (AURA's own
   * wording). Echelon's Control Centre callouts are raised as internal —
   * confirmed directly: "it will work as a live internal callout, not to
   * the AURA network, which is correct — I don't want AURA responders
   * turning up to my jobs." So internalTest: true is Echelon's real, live
   * incident path and DOES create a job; internalTest: false would mean
   * AURA's open network already has a responder on it independently of
   * CCCS — not something this supplier setup is expected to raise, so no
   * job is created for it either (dispatching an Echelon officer on top of
   * an AURA-network responder already en route is the exact double-up the
   * quote above is ruling out) — instead control gets a push so a human
   * notices an unexpected one rather than it only existing in the log. */
  const AURA_NEW_CALLOUT_MESSAGES = ['NEW_CALLOUT', 'NEW_CALLOUT_FOR_INSTANCE'];
  function auraCalloutFields(callout) {
    const info = (callout.incidentInformation || [])[0] || {};
    const loc = info.calloutCurrentLocation || {};
    const lat = loc.latitude != null ? Number(loc.latitude) : null;
    const lon = loc.longitude != null ? Number(loc.longitude) : null;
    // AURA's own written description of the pair spells it incidentCategory;
    // the real payload captured 2026-10-06 had it lower-case — accept either
    // rather than trust one source over the other.
    const category = info.incidentCategory || info.incidentcategory;
    const site = info.predefinedLocationId
      ? db.sites.find((s) => s.aura_location_id && String(s.aura_location_id) === String(info.predefinedLocationId))
      : null;
    const location = site ? null
      : loc.formattedAddress || (info.predefinedLocationId
        ? `AURA site ref ${info.predefinedLocationId} — no site mapped to this ref yet (set aura_location_id on a site)`
        : 'Location unknown — add details as received');
    return {
      site, location,
      external_ref: String(callout.id),
      lat: Number.isFinite(lat) ? lat : null,
      lon: Number.isFinite(lon) ? lon : null,
      incident_type: (info.typeOfEmergency && info.typeOfEmergency.description) || 'ALARM',
      description: [info.responseType && info.responseType.value, category && category.description].filter(Boolean).join(' — '),
    };
  }
  route('POST', '/api/integrations/aura/jobs', null, ({ body: b, req }) => {
    checkAlarmSecret('x-aura-secret', 'AURA_SECRET', 'AURA', req);
    logInboundAlarmPayload('aura', 'AURA', b);
    const callout = b.callout;
    if (!callout || !callout.id) return { __status: 200, __body: { ok: true, note: 'no callout in payload — logged only' } };
    const externalRef = String(callout.id);

    if (AURA_NEW_CALLOUT_MESSAGES.includes(b.message)) {
      // calloutClassification sits inside incidentInformation[0] on a real
      // captured payload (2026-10-06), not on callout itself — checked both
      // places in case AURA's shape varies between callout types.
      const info0 = (callout.incidentInformation || [])[0] || {};
      const classification = info0.calloutClassification || callout.calloutClassification;
      if (classification && classification.value === 'TEST') {
        return { __status: 200, __body: { ok: true, note: 'TEST classification — not yet verified as a live callout, logged only' } };
      }
      // internalTest: false would mean AURA's open network, not Echelon,
      // already has a responder on this one — see the block comment above.
      // Not expected from this supplier setup; surfaced rather than silently
      // dropped, in case it ever is.
      if (!callout.internalTest) {
        pushToRoles(CONTROL, { title: 'Unexpected AURA callout', body: `Callout ${callout.id} arrived as internalTest:false — AURA's open network may already be responding. No job created.`, url: '/control.html', tag: `cccs-aura-${callout.id}` });
        return { __status: 200, __body: { ok: true, note: 'internalTest is false — not Echelon’s own job, flagged to control, no job created' } };
      }
      const fields = auraCalloutFields(callout);
      // AMBER — see the block comment above this route.
      return createExternalJob({ source: 'aura', label: 'AURA', priority: 'AMBER', ...fields });
    }

    const existing = db.jobs.find((x) => x.external_source === 'aura' && x.external_ref === externalRef);
    if (!existing) return { __status: 200, __body: { ok: true, note: 'status update for a callout CCCS has no job for — logged only' } };
    if (!existing.external_events_seen) existing.external_events_seen = [];
    if (existing.external_events_seen.includes(b.message)) {
      return { __status: 200, __body: { ok: true, note: 'duplicate webhook delivery of an already-recorded event — logged only' } };
    }
    existing.external_events_seen.push(b.message);
    const stamp = `[AURA ${b.message || 'update'} — ${new Date().toISOString()}]`;
    existing.notes = existing.notes ? `${existing.notes}\n${stamp}` : stamp;
    existing.updated_at = new Date().toISOString();
    broadcast('job.updated', publicJob(existing));
    logEvent('job.updated', `JOB ${existing.reference} — AURA ${b.message || 'UPDATE'}`, { job_id: existing.id, external_ref: externalRef });
    return { __status: 200, __body: publicJob(existing) };
  });

  /* ---- BroadNet Dispatch bridge --------------------------------------------
   * Outbound: an operator presses "Push to BroadNet" on a job (not automatic —
   * not every job is BroadNet-relevant, and there's no live channel/terminal
   * data yet to auto-route by). MVP targets one configured default channel;
   * per-resource terminal targeting is a follow-up once a real account exists
   * and actual channel/terminal UUIDs are visible in BroadNet's portal.
   *
   * Inbound: one webhook URL (registered in BroadNet's portal) receives three
   * payload shapes discriminated by which top-level key is present, same
   * spirit as AURA's single endpoint discriminated by body.message. BroadNet
   * documents no webhook signature scheme (unlike GoCardless), so the URL
   * itself carries an unguessable token as the only authenticity check. */
  const BROADNET_GRADE = { RED: 1, AMBER: 2, GREEN: 4, ROUTINE: 5 };
  function publicBroadnetTerminal(t) {
    return { network_id: t.network_id, username: t.username, lat: t.lat, lon: t.lon, status: t.status, channel: t.channel, ptt_pressed: t.ptt_pressed, updated_at: t.updated_at };
  }

  route('POST', '/api/jobs/:id/broadnet-push', CONTROL, async ({ params, user }) => {
    const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
    if (j.broadnet_incident_uuid) throw httpError(409, 'already pushed to BroadNet');
    const incident = await broadnet.createIncident({
      description: `${j.reference} — ${j.incident_type}: ${j.description || j.location}`,
      grade: BROADNET_GRADE[j.priority] || 3,
      lat: j.lat, lon: j.lon, label: j.location,
      channelUuid: process.env.BROADNET_DEFAULT_CHANNEL_UUID || undefined,
    });
    j.broadnet_incident_uuid = incident.uuid;
    j.broadnet_pushed_at = new Date().toISOString();
    j.updated_at = j.broadnet_pushed_at;
    broadcast('job.updated', publicJob(j));
    logEvent('job.updated', `JOB ${j.reference} — pushed to BroadNet (${incident.uuid})`, { job_id: j.id, by: user.display_name });
    return publicJob(j);
  });

  route('POST', '/api/integrations/broadnet/webhook/:token', null, ({ params, body: b }) => {
    const broadnetToken = process.env.BROADNET_WEBHOOK_TOKEN;
    const givenToken = Buffer.from(String(params.token || ''));
    if (!broadnetToken || givenToken.length !== Buffer.byteLength(broadnetToken) || !crypto.timingSafeEqual(givenToken, Buffer.from(broadnetToken))) throw httpError(401, 'bad BroadNet webhook token');
    logInboundAlarmPayload('broadnet', 'BroadNet', b);

    if (b.terminal) {
      const t = b.terminal;
      let rec = db.broadnet_terminals.find((x) => x.network_id === t.network_id);
      if (!rec) { rec = { network_id: t.network_id }; db.broadnet_terminals.push(rec); }
      Object.assign(rec, {
        username: t.username, lat: t.latitude != null ? Number(t.latitude) : null, lon: t.longitude != null ? Number(t.longitude) : null,
        status: broadnet.canonicalStatus(t.incident_status), channel: t.channel || null, ptt_pressed: Boolean(t.ptt_pressed),
        updated_at: new Date().toISOString(),
      });
      broadcast('broadnet_terminal.location', publicBroadnetTerminal(rec));
      return { ok: true };
    }

    if (b.incident || b.allocation) {
      const incidentUuid = (b.incident && b.incident.uuid) || (b.allocation && b.allocation.incident_uuid);
      const existing = incidentUuid ? db.jobs.find((x) => x.broadnet_incident_uuid === incidentUuid) : null;
      if (!existing) return { ok: true, note: 'no job matches this BroadNet incident — logged only' };
      const stamp = `[BroadNet ${b.reason || 'update'} — ${new Date().toISOString()}]`;
      existing.notes = existing.notes ? `${existing.notes}\n${stamp}` : stamp;
      existing.updated_at = new Date().toISOString();
      broadcast('job.updated', publicJob(existing));
      logEvent('job.updated', `JOB ${existing.reference} — BroadNet ${b.reason || 'update'}`, { job_id: existing.id, incident_uuid: incidentUuid });
      return publicJob(existing);
    }

    return { ok: true, note: 'unrecognised BroadNet payload shape — logged only' };
  });

  return { publicBroadnetTerminal };
};
