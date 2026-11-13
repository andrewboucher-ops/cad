/**
 * Text staff about open shifts — the "Text staff" button on the rota.
 *
 * Control picks which open shifts to advertise (published, still in the
 * future, short of headcount — exactly what an officer sees under Open
 * shifts in the officer app), previews who will get it, and sends. Each
 * officer gets one text listing only the shifts they could actually see and
 * apply for (branch / site restrictions apply), with a link straight to the
 * Rota screen of the officer app where they claim one. Claiming still goes
 * through the normal application → approval flow; this only tells people.
 *
 * Who gets it: field officer logins whose staff record is employed, has a
 * usable mobile and has not opted out of SMS, and who are not already on
 * (or have not already applied for) every listed shift. Every text goes
 * through sms.js — a dry run unless SMS_LIVE=on — and into the contact log.
 *
 * Registrar pattern — server.js passes in what this needs.
 */
'use strict';

const MAX_LISTED = 4;        // shifts written out in one text; the rest are "+N more"
const MAX_BODY = 600;        // about four SMS segments
const RESEND_WARN_MS = 2 * 60 * 60 * 1000;

module.exports = function registerOpenShiftSms({
  route, httpError, CONTROL, ADMIN, db, logEvent, sms, notifyLog, siteVisibleTo, assignedPersonnelIds,
  pushToRoles = () => {}, publicBaseUrl, controlPhone = process.env.CONTROL_PHONE || '01472 352462', flushNow = () => {},
}) {
  const OPEN_APP = ['APPLIED', 'SHORTLISTED'];
  const link = `${publicBaseUrl}/officer.html#rota`;

  const openShifts = () => {
    const now = Date.now();
    return db.shifts.filter((s) => s.status === 'PUBLISHED' && Date.parse(s.starts_at) > now
      && assignedPersonnelIds(s.id).length < (s.required_headcount || 1))
      .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  };

  const fmt = (iso, opts) => new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London', ...opts });
  /** "Sat 14 Nov 18:00–06:00 Meridian Point (Static guard)" */
  function describe(s) {
    const site = s.site_id ? db.sites.find((x) => x.id === s.site_id) : null;
    const type = s.shift_type_id ? db.shift_types.find((t) => t.id === s.shift_type_id) : null;
    const day = fmt(s.starts_at, { weekday: 'short', day: 'numeric', month: 'short' });
    const t = (iso) => fmt(iso, { hour: '2-digit', minute: '2-digit', hour12: false });
    const where = site ? site.name : (s.location || 'site tbc');
    return `${day} ${t(s.starts_at)}-${t(s.ends_at)} ${where}${type ? ` (${type.name})` : ''}`;
  }
  const summary = (s) => {
    const short = (s.required_headcount || 1) - assignedPersonnelIds(s.id).length;
    return { id: s.id, description: describe(s), starts_at: s.starts_at, ends_at: s.ends_at, places: short };
  };

  function messageFor(shifts, headline) {
    const head = headline ? headline(shifts.length) : shifts.length === 1 ? 'ECHELON: a shift is open to claim:' : `ECHELON: ${shifts.length} shifts are open to claim:`;
    const listed = shifts.slice(0, MAX_LISTED).map((s) => `- ${describe(s)}`);
    const more = shifts.length > MAX_LISTED ? [`+${shifts.length - MAX_LISTED} more`] : [];
    const tail = [`Claim in the officer app: ${link}`, `Don't reply to this text - call control on ${controlPhone}.`];
    let lines = [head, ...listed, ...more, ...tail];
    // Trim shift lines (never the link) until it fits.
    while (lines.join('\n').length > MAX_BODY && listed.length > 1) {
      listed.pop();
      lines = [head, ...listed, `+${shifts.length - listed.length} more`, ...tail];
    }
    return lines.join('\n').slice(0, MAX_BODY);
  }

  function chosenShifts(raw) {
    const open = openShifts();
    if (raw == null || raw === '') return open;
    const ids = new Set((Array.isArray(raw) ? raw : String(raw).split(',')).map(Number).filter(Boolean));
    const chosen = open.filter((s) => ids.has(s.id));
    if (!chosen.length) throw httpError(400, 'none of those shifts are open any more');
    return chosen;
  }

  /** One row per field officer: what they'd be sent, or why they're skipped. */
  function recipients(shifts) {
    const seen = new Set();
    return db.users.filter((u) => u.role === 'FIELD_USER' && u.active !== false).map((u) => {
      const p = u.personnel_id ? db.personnel.find((x) => x.id === u.personnel_id) : null;
      const to = p ? sms.normalizeNumber(p.contact_phone) : null;
      const theirs = p ? shifts.filter((s) => siteVisibleTo(s.site_id, u)
        && !assignedPersonnelIds(s.id).includes(p.id)
        && !(db.shift_applications || []).some((a) => a.shift_id === s.id && a.personnel_id === p.id && OPEN_APP.includes(a.status))) : [];
      let status = 'ok';
      if (!p) status = 'no staff record linked to this login';
      else if (p.employment_status === 'TERMINATED') status = 'not employed';
      else if (!to) status = 'no mobile number';
      else if (p.sms_opt_out) status = 'opted out of SMS';
      else if (!theirs.length) status = 'already on or applied for these shifts, or not their sites';
      else if (seen.has(to)) status = 'same number as someone above';
      if (status === 'ok') seen.add(to);
      return { user_id: u.id, personnel_id: p ? p.id : null, name: p ? p.name : u.display_name, to: status === 'ok' ? to : null, status, shifts: theirs };
    });
  }
  const mask = (n) => (n ? `${n.slice(0, -4).replace(/\d/g, '•')}${n.slice(-4)}` : null);

  route('GET', '/api/shifts/available/notify/preview', CONTROL, ({ query }) => {
    const open = openShifts();
    const shifts = open.length ? chosenShifts(query.get('shifts')) : [];
    const list = recipients(shifts);
    // Last send comes from the audit trail (already persisted), not a table of its own.
    const last = [...db.audit_logs].reverse().find((e) => e.type === 'sms.open_shifts') || null;
    return {
      live: process.env.SMS_LIVE === 'on',
      open_shifts: open.map(summary),
      selected: shifts.map((s) => s.id),
      sample_message: shifts.length ? messageFor(shifts) : null,
      recipients: list.map((r) => ({ name: r.name, to: mask(r.to), status: r.status, shift_count: r.shifts.length })),
      sending_to: list.filter((r) => r.status === 'ok').length,
      last_sent: last ? { at: last.at, by: last.data.sent_by, sent: last.data.sent, recent: Date.now() - Date.parse(last.at) < RESEND_WARN_MS } : null,
    };
  });

  route('POST', '/api/shifts/available/notify', CONTROL, async ({ body, user }) => {
    if (!openShifts().length) throw httpError(400, 'there are no open shifts to advertise');
    const shifts = chosenShifts(body.shifts);
    const list = recipients(shifts).filter((r) => r.status === 'ok');
    if (!list.length) throw httpError(400, 'nobody can be texted about these shifts — check mobile numbers on staff records');
    const results = [];
    for (const r of list) {
      const text = messageFor(r.shifts);
      const res = await sms.send({ to: r.to, body: text, label: r.name });
      notifyLog({ channel: 'SMS', personnel_id: r.personnel_id, to_number: r.to, body: text, provider: res.dryRun ? 'none' : 'twilio', provider_ref: res.sid || null,
        outcome: res.ok ? (res.dryRun ? 'ATTEMPTED' : 'QUEUED') : 'FAILED', error_code: res.ok ? null : (res.error || 'send failed') });
      results.push({ name: r.name, ok: Boolean(res.ok), dry_run: Boolean(res.dryRun), error: res.ok ? null : res.error || 'failed' });
    }
    const sent = results.filter((x) => x.ok).length;
    logEvent('sms.open_shifts', `${user.display_name} TEXTED ${sent} STAFF ABOUT ${shifts.length} OPEN SHIFT${shifts.length === 1 ? '' : 'S'}`, { shift_ids: shifts.map((s) => s.id), sent_by: user.display_name, sent });
    flushNow();
    return { sent, failed: results.length - sent, dry_run: results.some((x) => x.dry_run), results };
  });

  /* ---------------------------------------------------------------------
   * Automatic escalation of unfilled shifts.
   *
   * A published shift still short of headcount when it is `staff_hours`
   * (default 48) from its start gets one automatic text to every officer
   * who could claim it — the same text and the same recipient rules as the
   * button above. At `alert_hours` (default 24) the managers are alerted:
   * a push to admins and a text to the numbers in `alert_to`.
   *
   * Each step happens once per shift. The marks live on the shift
   * (shift.unfilled_escalation) and are tied to its start time, so a moved
   * shift starts again; a shift that fills clears them, so if someone drops
   * out later it is chased again. Texts wait for daytime: staff 08:00–20:00,
   * managers 07:00–22:00 (UK time). If control already texted a shift by hand
   * in the last 12 hours, the automatic staff text is skipped for it.
   * Settings: db.ui_settings row key 'unfilled_shifts' (Rota → Automatic
   * chasing). UNFILLED_SHIFT_ESCALATION=off switches it off server-wide.
   * ------------------------------------------------------------------- */
  const DEFAULTS = { enabled: true, staff_hours: 48, alert_hours: 24, alert_to: '' };
  const MANUAL_RECENT_MS = 12 * 60 * 60 * 1000;
  const STAFF_HOURS_UK = [8, 20];
  const ALERT_HOURS_UK = [7, 22];
  const settingsRow = () => (db.ui_settings || []).find((x) => x.key === 'unfilled_shifts');
  const escalationSettings = () => ({ ...DEFAULTS, ...((settingsRow() || {}).settings || {}) });
  const ukHour = (d) => Number(new Date(d).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false })) % 24;
  const inHours = (d, [from, to]) => { const h = ukHour(d); return h >= from && h < to; };
  const alertNumbers = (raw) => [...new Set(String(raw || '').split(/[,;\n]+/).map((n) => n.trim()).filter(Boolean).map((n) => sms.normalizeNumber(n)).filter(Boolean))];

  {
    route('GET', '/api/shifts/escalation/settings', CONTROL, () => ({
      ...escalationSettings(), server_off: process.env.UNFILLED_SHIFT_ESCALATION === 'off', live: process.env.SMS_LIVE === 'on',
      staff_window: STAFF_HOURS_UK, alert_window: ALERT_HOURS_UK,
    }));
    route('PUT', '/api/shifts/escalation/settings', ADMIN, ({ body, user }) => {
      const cur = escalationSettings();
      const next = { ...cur };
      if ('enabled' in body) next.enabled = Boolean(body.enabled);
      for (const k of ['staff_hours', 'alert_hours']) {
        if (k in body) {
          const n = Number(body[k]);
          if (!Number.isFinite(n) || n < 1 || n > 168) throw httpError(400, `${k.replace('_', ' ')} must be between 1 and 168`);
          next[k] = Math.round(n);
        }
      }
      if (next.alert_hours > next.staff_hours) throw httpError(400, 'the manager alert must come after (closer to the shift than) the staff text');
      if ('alert_to' in body) {
        const raw = String(body.alert_to || '').trim();
        const bad = raw.split(/[,;\n]+/).map((n) => n.trim()).filter(Boolean).filter((n) => !sms.normalizeNumber(n));
        if (bad.length) throw httpError(400, `not a mobile number: ${bad.join(', ')}`);
        next.alert_to = raw;
      }
      if (!Array.isArray(db.ui_settings)) db.ui_settings = [];
      let r = settingsRow(); if (!r) { r = { key: 'unfilled_shifts', settings: {} }; db.ui_settings.push(r); }
      r.settings = next;
      logEvent('shift.escalation_settings', `${user.display_name} CHANGED AUTOMATIC CHASING OF UNFILLED SHIFTS`, { ...next, alert_to: next.alert_to ? 'set' : '' });
      flushNow();
      return { ...next, server_off: process.env.UNFILLED_SHIFT_ESCALATION === 'off', live: process.env.SMS_LIVE === 'on', staff_window: STAFF_HOURS_UK, alert_window: ALERT_HOURS_UK };
    });
  }

  let ticking = false;
  /** One pass. `now` is injectable for tests. Returns what it did. */
  async function escalationTick(now = Date.now()) {
    const out = { staff_texted: 0, staff_shifts: [], alerted_shifts: [], alerts_sent: 0 };
    if (process.env.UNFILLED_SHIFT_ESCALATION === 'off' || ticking) return out;
    const cfg = escalationSettings();
    if (!cfg.enabled) return out;
    ticking = true;
    try {
      // Filled (or cancelled/started) shifts lose their marks so a later gap is chased again.
      for (const s of db.shifts) {
        if (!s.unfilled_escalation) continue;
        const stillOpen = s.status === 'PUBLISHED' && Date.parse(s.starts_at) > now && assignedPersonnelIds(s.id).length < (s.required_headcount || 1);
        if (!stillOpen || s.unfilled_escalation.starts_at !== s.starts_at) s.unfilled_escalation = null;
      }
      const open = db.shifts.filter((s) => s.status === 'PUBLISHED' && Date.parse(s.starts_at) > now
        && assignedPersonnelIds(s.id).length < (s.required_headcount || 1))
        .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
      const hoursTo = (s) => (Date.parse(s.starts_at) - now) / 3600000;
      const mark = (s) => (s.unfilled_escalation ||= { starts_at: s.starts_at });

      // 1. Staff text at staff_hours.
      const dueStaff = open.filter((s) => hoursTo(s) <= cfg.staff_hours && !(s.unfilled_escalation && s.unfilled_escalation.staff_at));
      if (dueStaff.length && inHours(now, STAFF_HOURS_UK)) {
        const manual = db.audit_logs.filter((e) => e.type === 'sms.open_shifts' && now - Date.parse(e.at) < MANUAL_RECENT_MS)
          .flatMap((e) => (e.data && e.data.shift_ids) || []);
        const already = dueStaff.filter((s) => manual.includes(s.id));
        for (const s of already) Object.assign(mark(s), { staff_at: new Date(now).toISOString(), staff_by: 'manual text' });
        const toText = dueStaff.filter((s) => !manual.includes(s.id));
        if (toText.length) {
          const list = recipients(toText).filter((r) => r.status === 'ok');
          const headline = (n) => (n === 1 ? 'ECHELON: a shift coming up still needs cover:' : `ECHELON: ${n} shifts coming up still need cover:`);
          let sent = 0;
          for (const r of list) {
            const text = messageFor(r.shifts, headline);
            const res = await sms.send({ to: r.to, body: text, label: r.name });
            notifyLog({ channel: 'SMS', personnel_id: r.personnel_id, to_number: r.to, body: text, provider: res.dryRun ? 'none' : 'twilio', provider_ref: res.sid || null,
              outcome: res.ok ? (res.dryRun ? 'ATTEMPTED' : 'QUEUED') : 'FAILED', error_code: res.ok ? null : (res.error || 'send failed') });
            if (res.ok) sent++;
          }
          for (const s of toText) Object.assign(mark(s), { staff_at: new Date(now).toISOString(), staff_by: 'automatic', staff_sent: sent });
          logEvent('sms.open_shifts_auto', `AUTOMATIC: TEXTED ${sent} STAFF ABOUT ${toText.length} UNFILLED SHIFT${toText.length === 1 ? '' : 'S'}`, { shift_ids: toText.map((s) => s.id), sent, recipients: list.length });
          out.staff_texted = sent; out.staff_shifts = toText.map((s) => s.id);
        }
      }

      // 2. Manager alert at alert_hours.
      const dueAlert = open.filter((s) => hoursTo(s) <= cfg.alert_hours && !(s.unfilled_escalation && s.unfilled_escalation.alert_at));
      if (dueAlert.length && inHours(now, ALERT_HOURS_UK)) {
        const lines = dueAlert.slice(0, MAX_LISTED).map((s) => {
          const short = (s.required_headcount || 1) - assignedPersonnelIds(s.id).length;
          return `- ${describe(s)}: ${short} short`;
        });
        if (dueAlert.length > MAX_LISTED) lines.push(`+${dueAlert.length - MAX_LISTED} more`);
        const head = dueAlert.length === 1 ? `CCCS: a shift starts within ${cfg.alert_hours}h and is still short:` : `CCCS: ${dueAlert.length} shifts start within ${cfg.alert_hours}h and are still short:`;
        const text = [head, ...lines, `Rota: ${publicBaseUrl}/rota.html`].join('\n').slice(0, MAX_BODY);
        pushToRoles(['SYSTEM_ADMIN'], { title: 'Unfilled shifts', body: `${dueAlert.length} shift${dueAlert.length === 1 ? '' : 's'} within ${cfg.alert_hours}h still short`, url: '/rota.html', tag: 'cccs-unfilled-shifts' });
        let sent = 0;
        for (const to of alertNumbers(cfg.alert_to)) {
          const res = await sms.send({ to, body: text, label: 'Unfilled shift alert' });
          notifyLog({ channel: 'SMS', personnel_id: null, to_number: to, body: text, provider: res.dryRun ? 'none' : 'twilio', provider_ref: res.sid || null,
            outcome: res.ok ? (res.dryRun ? 'ATTEMPTED' : 'QUEUED') : 'FAILED', error_code: res.ok ? null : (res.error || 'send failed') });
          if (res.ok) sent++;
        }
        for (const s of dueAlert) Object.assign(mark(s), { alert_at: new Date(now).toISOString(), alert_sent: sent });
        logEvent('shift.unfilled_alert', `UNFILLED SHIFTS — ${dueAlert.length} WITHIN ${cfg.alert_hours}H STILL SHORT${sent ? `, TEXTED ${sent} MANAGER NUMBER${sent === 1 ? '' : 'S'}` : ''}`, { shift_ids: dueAlert.map((s) => s.id), sent });
        out.alerted_shifts = dueAlert.map((s) => s.id); out.alerts_sent = sent;
      }
      flushNow();
    } finally { ticking = false; }
    return out;
  }

  return { messageFor, openShifts, escalationTick, escalationSettings };
};
