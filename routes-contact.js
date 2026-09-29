/**
 * Contact routes — click-to-dial and click-to-SMS from the control room,
 * plus the Twilio delivery-status webhook.
 *
 * Kept in its own file rather than added to server.js's 2,180-line route
 * section: this is new surface, and it reads better isolated. server.js
 * requires it after its own routes are registered, so the `route()` calls
 * below land on the same table.
 *
 * WHY DIAL AND SMS ARE DIFFERENT, in two lines:
 *   dial  — the browser gives NO callback. All that can honestly be recorded
 *           is that an operator pressed the button. dial_log.outcome stays
 *           ATTEMPTED, and nothing here ever writes ANSWERED — that column
 *           is filled by the FreePBX module once a real call is originated.
 *   sms   — Twilio returns a SID synchronously and then calls back with the
 *           delivery outcome, so one row carries both the attempt and the
 *           result. That asymmetry is a property of the two mechanisms, not
 *           an inconsistency to be tidied away.
 */
'use strict';

const sms = require('./sms.js');

/* ------------------------------------------------------------------ *
 * Extension resolution
 *
 * An extension is per-SESSION, not per-user: an operator works a different
 * desk on a different shift, and pinning them to the extension they used
 * last Tuesday would ring an empty desk. So the control room prompts once on
 * entry and the answer is held for that session. users.extension is only a
 * remembered default to pre-fill that prompt, never an authority.
 * ------------------------------------------------------------------ */

/** Who should be phoned for a given officer: the on-duty supervisor if one is
 * rostered, else their line manager. Returns { person, source } so the log
 * can record WHICH it was — a call that silently went to a sleeping line
 * manager instead of the duty supervisor is exactly what an incident review
 * needs to be able to see. */
function supervisorFor(personnelId) {
  const person = db.personnel.find((p) => p.id === Number(personnelId));
  if (!person) return null;

  const dutyShift = db.shifts.find((s) => s.is_duty_supervisor
    && ['SCHEDULED', 'CONFIRMED', 'CLOCKED_IN'].includes(s.status)
    && Date.parse(s.starts_at) <= Date.now() && Date.parse(s.ends_at) >= Date.now());
  if (dutyShift) {
    const onDuty = db.personnel.find((p) => p.id === dutyShift.personnel_id);
    if (onDuty && onDuty.contact_phone) return { person: onDuty, source: 'DUTY_SUPERVISOR', shift_id: dutyShift.id };
  }

  const line = person.supervisor_id ? db.personnel.find((p) => p.id === person.supervisor_id) : null;
  if (line && line.contact_phone) return { person: line, source: 'LINE_MANAGER', shift_id: null };

  return { person: null, source: null, shift_id: null };
}

/** Detail the control room needs when an officer is selected: their number,
 * their supervisor's number, and which kind of supervisor it is. */
function contactDetail(personnelId) {
  const person = db.personnel.find((p) => p.id === Number(personnelId));
  if (!person) return null;
  const sup = supervisorFor(person.id);
  return {
    personnel_id: person.id,
    name: person.name,
    callsign: (db.callsigns.find((c) => c.id === person.callsign_id) || {}).name || null,
    phone: person.contact_phone || null,
    phone_valid: Boolean(sms.normalizeNumber(person.contact_phone)),
    supervisor: sup && sup.person ? {
      personnel_id: sup.person.id,
      name: sup.person.name,
      phone: sup.person.contact_phone || null,
      phone_valid: Boolean(sms.normalizeNumber(sup.person.contact_phone)),
      source: sup.source,        // DUTY_SUPERVISOR | LINE_MANAGER — the log shows which
    } : null,
  };
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

// The contact detail the Detail panel shows when a person is selected.
route('GET', '/api/personnel/:id/contact', CONTROL, ({ params }) => {
  const detail = contactDetail(params.id);
  if (!detail) throw httpError(404, 'personnel not found');
  return detail;
});

// The extension an operator is working from this session — pre-fills the
// prompt on entering the control room.
route('GET', '/api/me/extension', CONTROL, ({ user }) => {
  const u = db.users.find((x) => x.id === user.id);
  return { default_extension: (u && u.extension) || '', rings_operator_first: DIAL_RINGS_OPERATOR_FIRST };
});

// Records the extension for this session and, optionally, remembers it as the
// account's default for next time.
route('POST', '/api/me/extension', CONTROL, ({ body, user }) => {
  const extension = String(body.extension || '').trim();
  if (extension && !/^\d{2,6}$/.test(extension)) throw httpError(400, 'extension must be 2-6 digits');
  const u = db.users.find((x) => x.id === user.id);
  if (body.remember && u) {
    u.extension = extension;
    logEvent('user.extension_set', `${u.username} set their default extension to ${extension || '(cleared)'}`, { user_id: u.id });
  }
  return { extension, remembered: Boolean(body.remember) };
});

/**
 * Click-to-dial.
 *
 * Records the attempt, and NO MORE. A tel: link performs the dial itself and
 * reports nothing back, so there is no outcome to record — an operator who
 * clicked and reached voicemail looks identical here to one whose call was
 * answered for ten minutes. That is why dial_log.outcome is ATTEMPTED and
 * every field describing a result stays NULL.
 *
 * When FreePBX origination is wired in, this is the route that will call it:
 * it already receives the extension to ring first, so the flow becomes
 * originate(extension) -> bridge to the officer, and the PBX's own call id
 * and disposition fill outcome/duration_s in the same row.
 */
route('POST', '/api/contact/dial', CONTROL, ({ body, user }) => {
  const person = findPersonnel(body.personnel);
  if (!person) throw httpError(404, 'personnel not found');
  const target = body.supervisor ? supervisorFor(person.id) : null;
  const toPerson = body.supervisor ? (target && target.person) : person;
  if (!toPerson) throw httpError(400, 'no supervisor is rostered and none is set as line manager');

  const number = String(toPerson.contact_phone || '').trim();
  if (!number) throw httpError(400, `${toPerson.name} has no contact number on record`);

  const extension = String(body.extension || '').trim();
  if (DIAL_RINGS_OPERATOR_FIRST && !extension) {
    throw httpError(400, 'set the extension you are working from before dialling');
  }

  const row = {
    id: nextId('dial_log'),
    channel: 'DIAL',
    personnel_id: toPerson.id,
    to_number: number,
    from_number: extension || null,
    actor_user_id: user.id,
    actor_name: user.display_name,
    job_id: body.job_id ? Number(body.job_id) : null,
    site_visit_id: body.site_visit_id ? Number(body.site_visit_id) : null,
    body: null,
    provider: 'none',
    provider_ref: null,
    // Never anything but ATTEMPTED from here. See the header note.
    outcome: 'ATTEMPTED',
    error_code: null,
    duration_s: null,
    attempted_at: new Date().toISOString(),
    settled_at: null,
  };
  db.dial_log.push(row);

  const via = body.supervisor
    ? ` via ${toPerson.name}${target && target.source === 'LINE_MANAGER' ? ' (line manager — no duty supervisor rostered)' : ' (duty supervisor)'}`
    : '';
  logEvent('contact.dial', `DIAL ${toPerson.name}${via} — ${number}${extension ? ` from ext ${extension}` : ''}`, {
    dial_log_id: row.id, personnel_id: toPerson.id, job_id: row.job_id,
  });

  return { __status: 201, __body: { ...row, dial_uri: `tel:${number}` } };
});

/**
 * Click-to-SMS. Sends via Twilio and records BOTH the attempt and, once the
 * status webhook fires, the real delivery outcome on the same row.
 */
route('POST', '/api/contact/sms', CONTROL, async ({ body, user }) => {
  const person = findPersonnel(body.personnel);
  if (!person) throw httpError(404, 'personnel not found');
  const targetSup = body.supervisor ? supervisorFor(person.id) : null;
  const toPerson = body.supervisor ? (targetSup && targetSup.person) : person;
  if (!toPerson) throw httpError(400, 'no supervisor is rostered and none is set as line manager');

  const text = String(body.body || '').trim();
  if (!text) throw httpError(400, 'message text required');

  const result = await sms.send({ to: toPerson.contact_phone, body: text, label: toPerson.name });

  const row = {
    id: nextId('dial_log'),
    channel: 'SMS',
    personnel_id: toPerson.id,
    to_number: sms.normalizeNumber(toPerson.contact_phone) || String(toPerson.contact_phone || ''),
    from_number: null,
    actor_user_id: user.id,
    actor_name: user.display_name,
    job_id: body.job_id ? Number(body.job_id) : null,
    site_visit_id: body.site_visit_id ? Number(body.site_visit_id) : null,
    body: text,
    provider: result.dryRun ? 'none' : 'twilio',
    provider_ref: result.sid || null,
    // 'QUEUED' is honest only once Twilio has actually accepted it. In dry-run
    // the message did not exist, so it must not be logged as though it did.
    outcome: result.ok ? (result.dryRun ? 'ATTEMPTED' : 'QUEUED') : 'FAILED',
    error_code: result.ok ? null : (result.error || 'send failed'),
    duration_s: null,
    attempted_at: new Date().toISOString(),
    settled_at: null,
  };
  db.dial_log.push(row);

  logEvent('contact.sms', result.ok
    ? `SMS to ${toPerson.name} ${result.dryRun ? '(dry run — SMS_LIVE is off, nothing sent)' : `(queued, ${result.sid})`}`
    : `SMS to ${toPerson.name} FAILED — ${result.error}`,
    { dial_log_id: row.id, personnel_id: toPerson.id, job_id: row.job_id, sid: result.sid || null });

  if (!result.ok) return { __status: 502, __body: { error: result.error, dial_log_id: row.id } };
  return { __status: 201, __body: { ...row, dry_run: Boolean(result.dryRun) } };
});

/** Per-person contact history, newest first. */
route('GET', '/api/personnel/:id/contact-log', CONTROL, ({ params, query }) => {
  const limit = Math.min(Number(query.get('limit') || 50), 200);
  return db.dial_log
    .filter((d) => d.personnel_id === Number(params.id))
    .sort((a, b) => Date.parse(b.attempted_at) - Date.parse(a.attempted_at))
    .slice(0, limit);
});

/**
 * Twilio delivery-status webhook.
 *
 * The ONLY unauthenticated route in the system — Twilio calls it, and it
 * carries no session token. Its sole protection is the request signature, so
 * validation is mandatory and fails closed: an unsigned or badly-signed
 * request is rejected outright rather than logged leniently. Without that,
 * anyone who learned the URL could forge 'delivered' records into what is
 * meant to be an audit trail.
 *
 * Registered with `null` roles, which is what makes the router skip
 * authFrom() and hand the raw request through. Signature validation is done
 * here instead of in the router so the rule stays next to the code it protects.
 */
route('POST', '/api/sms/status', null, ({ body, req }) => {
  // Reconstruct the URL Twilio signed. Behind a proxy that rewrites host or
  // path this must match what Twilio actually called, or every callback fails
  // — which is why SMS_STATUS_CALLBACK_URL is configurable rather than derived.
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const url = `${proto}://${host}${req.url}`;

  const signature = req.headers['x-twilio-signature'];
  if (!sms.verifySignature(signature, url, body || {})) {
    console.warn('[sms] rejected a status callback with an invalid signature');
    throw httpError(403, 'invalid signature');
  }

  const update = sms.parseStatusCallback(body || {});
  if (!update.sid) throw httpError(400, 'no MessageSid in callback');

  // Keyed on the SID, so queued -> sent -> delivered UPDATE one row rather
  // than appending three. Twilio sends several statuses per message.
  const row = db.dial_log.find((d) => d.provider === 'twilio' && d.provider_ref === update.sid);
  if (!row) {
    // Not an error Twilio should retry: a callback for a message this server
    // never recorded (a restart, or a send from elsewhere on the account).
    console.warn(`[sms] status callback for unknown message ${update.sid} (${update.status})`);
    return { ok: true, matched: false };
  }

  const status = String(update.status || '').toUpperCase();
  if (['QUEUED', 'SENT', 'DELIVERED', 'UNDELIVERED', 'FAILED'].includes(status)) row.outcome = status;
  if (update.errorCode) row.error_code = update.errorCode;
  if (sms.isTerminalStatus(update.status)) row.settled_at = new Date().toISOString();

  logEvent('contact.sms_status', `SMS to ${row.to_number} → ${status}${update.errorCode ? ` (error ${update.errorCode})` : ''}`, {
    dial_log_id: row.id, sid: update.sid,
  });

  return { ok: true, matched: true };
});
