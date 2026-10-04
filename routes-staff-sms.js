/**
 * Text staff — an admin sends one SMS to everyone in chosen roles (e.g. all
 * controllers: a toolbox talk link, a procedure change).
 *
 * Who gets it: each login in those roles whose staff record has a usable
 * mobile number and has not opted out of SMS. A preview lists everyone,
 * including who will be missed and why, before anything is sent. Every
 * message is written to the contact log (dial_log) like any other SMS, and
 * goes through sms.js — a dry run unless SMS_LIVE=on.
 *
 * Registrar pattern — server.js passes in what this needs.
 */
'use strict';

module.exports = function registerStaffSms({ route, httpError, ADMIN, db, logEvent, sms, notifyLog, flushNow = () => {} }) {
  const ROLES = ['DISPATCHER', 'SUPERVISOR', 'SYSTEM_ADMIN', 'FIELD_USER'];
  const rolesFrom = (raw) => {
    const list = (Array.isArray(raw) ? raw : String(raw || '').split(',')).map((r) => String(r).trim()).filter((r) => ROLES.includes(r));
    if (!list.length) throw httpError(400, 'choose who to text');
    return [...new Set(list)];
  };
  function recipients(roles) {
    const seen = new Set();
    return db.users.filter((u) => roles.includes(u.role) && u.active !== false).map((u) => {
      const p = u.personnel_id ? db.personnel.find((x) => x.id === u.personnel_id) : null;
      const to = p ? sms.normalizeNumber(p.contact_phone) : null;
      let status = 'ok';
      if (!p) status = 'no staff record linked to this login';
      else if (p.employment_status === 'TERMINATED') status = 'not employed';
      else if (!to) status = 'no mobile number';
      else if (p.sms_opt_out) status = 'opted out of SMS';
      else if (seen.has(to)) status = 'same number as someone above';
      if (status === 'ok') seen.add(to);
      return { user_id: u.id, name: p ? p.name : u.display_name, role: u.role, personnel_id: p ? p.id : null, to: status === 'ok' ? to : null, status };
    });
  }
  const mask = (n) => (n ? `${n.slice(0, -4).replace(/\d/g, '•')}${n.slice(-4)}` : null);
  route('GET', '/api/admin/sms-broadcast/preview', ADMIN, ({ query }) => {
    const list = recipients(rolesFrom(query.get('roles')));
    return { live: process.env.SMS_LIVE === 'on', recipients: list.map((r) => ({ ...r, to: mask(r.to) })), sending_to: list.filter((r) => r.status === 'ok').length };
  });
  route('POST', '/api/admin/sms-broadcast', ADMIN, async ({ body, user }) => {
    const roles = rolesFrom(body.roles);
    const text = String(body.body || '').trim();
    if (!text) throw httpError(400, 'write the message');
    if (text.length > 600) throw httpError(400, 'keep it under 600 characters (about four texts)');
    const list = recipients(roles).filter((r) => r.status === 'ok');
    if (!list.length) throw httpError(400, 'nobody in those roles has a mobile number on their staff record');
    const results = [];
    for (const r of list) {
      const res = await sms.send({ to: r.to, body: text, label: r.name });
      notifyLog({ channel: 'SMS', personnel_id: r.personnel_id, to_number: r.to, body: text, provider: res.dryRun ? 'none' : 'twilio', provider_ref: res.sid || null,
        outcome: res.ok ? (res.dryRun ? 'ATTEMPTED' : 'QUEUED') : 'FAILED', error_code: res.ok ? null : (res.error || 'send failed') });
      results.push({ name: r.name, ok: Boolean(res.ok), dry_run: Boolean(res.dryRun), error: res.ok ? null : res.error || 'failed' });
    }
    logEvent('sms.broadcast', `${user.display_name} TEXTED ${results.filter((x) => x.ok).length} STAFF (${roles.join(', ')})`, {});
    flushNow();
    return { sent: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length, dry_run: results.some((x) => x.dry_run), results };
  });
};
