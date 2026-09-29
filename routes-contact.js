/**
 * Contact routes — click-to-dial and click-to-SMS, plus the Twilio
 * delivery-status webhook.
 *
 * Exported as a REGISTRAR, not as routes that run on require. server.js calls
 * it with the pieces it needs:
 *
 *   require('./routes-contact.js')({
 *     route, httpError, CONTROL, ADMIN, db, nextId, findPersonnel, logEvent,
 *     DIAL_RINGS_OPERATOR_FIRST, sms, ami, flushNow,
 *   });
 *
 * Why pass them in rather than require server.js: `route` and `httpError` are
 * module-local there, and a require back into server.js from a file it is
 * itself loading resolves to a partially-built exports object. That is a real
 * CommonJS cycle, and it fails at the first request rather than at startup —
 * the same trap as logEvent -> broadcast -> isControlRole. Passing them in
 * sidesteps it entirely.
 *
 * WHY DIAL AND SMS ARE DIFFERENT, in two lines:
 *   dial — two paths. With FreePBX configured (asterisk.js), the call is
 *          originated over the PBX and the row's outcome and duration are
 *          filled from the PBX's own events — never from anything the
 *          browser says. Without it, the console falls back to a tel: link,
 *          which reports NOTHING, so outcome stays ATTEMPTED forever. Only a
 *          PBX event may ever write ANSWERED/NO_ANSWER/BUSY on a DIAL row.
 *   sms  — Twilio returns a SID synchronously and then calls back with the
 *          delivery outcome, so one row carries the attempt AND the result.
 *          That asymmetry is a property of the two mechanisms, not an
 *          inconsistency to be tidied away.
 */
'use strict';

module.exports = function registerContactRoutes({
  route, httpError, CONTROL, ADMIN, db, nextId, findPersonnel, logEvent,
  DIAL_RINGS_OPERATOR_FIRST, sms, ami, flushNow = () => {},
}) {
  const pbxLive = () => Boolean(ami && ami.configured());

  /* ---------------------------------------------------------------- *
   * Supervisor resolution
   *
   * Prefers the on-duty supervisor, falls back to the line manager, and
   * reports WHICH it was. A call that quietly went to a sleeping line manager
   * instead of the duty supervisor is exactly what an incident review needs to
   * be able to see, so `source` is recorded on the row and in the log line.
   * ---------------------------------------------------------------- */

  function supervisorFor(personnelId) {
    const person = db.personnel.find((p) => p.id === Number(personnelId));
    if (!person) return null;
    const now = Date.now();
    const dutyShift = db.shifts.find((s) => s.is_duty_supervisor
      && ['SCHEDULED', 'CONFIRMED', 'CLOCKED_IN'].includes(s.status)
      && Date.parse(s.starts_at) <= now && Date.parse(s.ends_at) >= now);
    if (dutyShift) {
      const onDuty = db.personnel.find((p) => p.id === dutyShift.personnel_id);
      if (onDuty && onDuty.contact_phone) return { person: onDuty, source: 'DUTY_SUPERVISOR', shift_id: dutyShift.id };
    }
    const line = person.supervisor_id ? db.personnel.find((p) => p.id === person.supervisor_id) : null;
    if (line && line.contact_phone) return { person: line, source: 'LINE_MANAGER', shift_id: null };
    return { person: null, source: null, shift_id: null };
  }

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
        source: sup.source,
      } : null,
    };
  }

  /* ---------------------------------------------------------------- *
   * Routes
   * ---------------------------------------------------------------- */

  // What the Detail panel shows when a person is selected.
  route('GET', '/api/personnel/:id/contact', CONTROL, ({ params }) => {
    const detail = contactDetail(params.id);
    if (!detail) throw httpError(404, 'personnel not found');
    return detail;
  });

  // The extension the operator is working from this session. Pre-fills the
  // prompt on entering the control room. An extension is per-SESSION, not
  // per-user: an operator works a different desk on a different shift, and
  // pinning them to last Tuesday's extension would ring an empty desk.
  // users.extension is only a remembered default.
  route('GET', '/api/me/extension', CONTROL, ({ user }) => {
    const u = db.users.find((x) => x.id === user.id);
    return { default_extension: (u && u.extension) || '', rings_operator_first: DIAL_RINGS_OPERATOR_FIRST };
  });

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
   * With FreePBX configured: rings the operator's extension, connects them to
   * the officer, and settles this row from the PBX's own events — ANSWERED
   * with a duration, NO_ANSWER, BUSY, or FAILED with the cause. The reply is
   * sent as soon as the PBX ACCEPTS the call, with outcome still ATTEMPTED;
   * the outcome lands later as a 'contact.dial_outcome' event, because the
   * call has not happened yet when this request returns.
   *
   * Without FreePBX: records the attempt and returns a tel: URI for the
   * browser to open. That path reports nothing back, so the row stays
   * ATTEMPTED — an operator who reached voicemail and one who talked for ten
   * minutes look identical, and the log must not pretend otherwise.
   */
  route('POST', '/api/contact/dial', CONTROL, async ({ body, user }) => {
    const person = findPersonnel(body.personnel);
    if (!person) throw httpError(404, 'personnel not found');
    const target = body.supervisor ? supervisorFor(person.id) : null;
    const toPerson = body.supervisor ? (target && target.person) : person;
    if (!toPerson) throw httpError(400, 'no supervisor is rostered and none is set as line manager');

    const number = String(toPerson.contact_phone || '').trim();
    if (!number) throw httpError(400, `${toPerson.name} has no contact number on record`);

    const extension = String(body.extension || '').trim();
    if ((DIAL_RINGS_OPERATOR_FIRST || pbxLive()) && !extension) {
      throw httpError(400, 'set the extension you are working from before dialling');
    }
    if (pbxLive() && !/^\d{2,6}$/.test(extension)) throw httpError(400, 'extension must be 2-6 digits');

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
      provider: pbxLive() ? 'freepbx' : 'none',
      provider_ref: null,
      // ATTEMPTED until — and unless — the PBX reports otherwise.
      outcome: 'ATTEMPTED',
      error_code: null,
      duration_s: null,
      // Which of the two supervisor concepts this call actually reached, so
      // an incident review can see a call that went to a line manager
      // because nobody was rostered as duty supervisor.
      supervisor_source: target ? target.source : null,
      attempted_at: new Date().toISOString(),
      settled_at: null,
    };

    const via = body.supervisor
      ? ` via ${toPerson.name}${target && target.source === 'LINE_MANAGER' ? ' (line manager — no duty supervisor rostered)' : ' (duty supervisor)'}`
      : '';
    const summary = `DIAL ${toPerson.name}${via} — ${number}${extension ? ` from ext ${extension}` : ''}`;

    if (!pbxLive()) {
      db.dial_log.push(row);
      logEvent('contact.dial', summary, { dial_log_id: row.id, personnel_id: toPerson.id, job_id: row.job_id });
      return { __status: 201, __body: { ...row, dial_uri: `tel:${number}` } };
    }

    let placed;
    try {
      placed = await ami.originate({ extension, number });
    } catch (e) {
      // The PBX was unreachable, refused the login, refused the Originate, or
      // the number could not be dialled. Nothing rang anywhere; record the
      // attempt as FAILED with the reason rather than dropping it.
      row.outcome = 'FAILED';
      row.error_code = String(e.message || e).slice(0, 200);
      row.settled_at = new Date().toISOString();
      db.dial_log.push(row);
      logEvent('contact.dial', `${summary} — NOT PLACED: ${row.error_code}`, { dial_log_id: row.id, personnel_id: toPerson.id, job_id: row.job_id });
      flushNow();
      return { __status: 502, __body: { error: `the PBX did not place the call: ${row.error_code}`, dial_log_id: row.id } };
    }

    row.provider_ref = placed.action_id;
    db.dial_log.push(row);
    logEvent('contact.dial', `${summary} (via PBX, ringing ext ${extension} first)`, { dial_log_id: row.id, personnel_id: toPerson.id, job_id: row.job_id });

    placed.result.then((r) => {
      // TRACKING_TIMEOUT / AMI_DISCONNECTED before an answer leave the row
      // ATTEMPTED: the PBX never told us what happened, so neither do we.
      row.outcome = r.outcome;
      row.duration_s = r.duration_s;
      row.error_code = r.cause;
      row.settled_at = new Date().toISOString();
      const who = r.leg === 'OPERATOR' ? `operator ext ${extension}` : toPerson.name;
      const detail = r.outcome === 'ANSWERED'
        ? (r.duration_s != null ? `ANSWERED, ${r.duration_s}s` : `ANSWERED, duration unknown (${r.cause})`)
        : `${r.outcome}${r.cause ? ` (${r.cause})` : ''}`;
      logEvent('contact.dial_outcome', `DIAL ${toPerson.name} — ${who}: ${detail}`, {
        dial_log_id: row.id, personnel_id: toPerson.id, outcome: r.outcome, duration_s: r.duration_s, leg: r.leg,
      });
      flushNow();
    }).catch((e) => console.warn('[contact] dial outcome handling failed:', e.message));

    return { __status: 201, __body: { ...row, dial_uri: null } };
  });

  /* Admin diagnostics: can this server reach the PBX, log in, and Originate?
   * The first thing to run after setting AMI_* in the environment. */
  route('GET', '/api/contact/pbx-probe', ADMIN, async () => {
    if (!pbxLive()) return { configured: false };
    try { return { configured: true, ...(await ami.probe()) }; }
    catch (e) { return { configured: true, logged_in: false, error: e.message }; }
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
      // 'QUEUED' is honest only once Twilio has accepted it. In dry-run the
      // message did not exist, so it must not be logged as though it did.
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

  // Per-person contact history, newest first.
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
   * anyone who learned the URL could forge 'delivered' rows into what is meant
   * to be an audit trail.
   *
   * Registered with `null` roles, which is what makes the router skip
   * authFrom() and hand the raw request through. Validation is done here rather
   * than in the router so the rule stays next to the code it protects.
   */
  route('POST', '/api/sms/status', null, ({ body, req }) => {
    // Reconstruct the URL Twilio signed. Behind a proxy that rewrites host or
    // path this must match what Twilio actually called, or every callback
    // fails — which is why SMS_STATUS_CALLBACK_URL is configurable rather
    // than derived.
    // SMS_STATUS_CALLBACK_URL is exactly the URL handed to Twilio as
    // StatusCallback, so it is exactly the URL Twilio signs — use it verbatim
    // when set. Rebuilding from forwarded headers is only a fallback, and is
    // the path that silently fails behind a proxy that rewrites host or path.
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    const url = sms.STATUS_CALLBACK_URL || `${proto}://${host}${req.url}`;

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
};
