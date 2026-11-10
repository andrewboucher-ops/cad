/**
 * Admin: user accounts, welcome links, and officer app sign-in links for
 * subcontractors.
 *
 * Moved out of server.js unchanged. Registrar pattern: server.js passes in
 * what this needs, at the same point in route order as before.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

module.exports = function registerUsers({ route, httpError, ALL, ADMIN, db, nextId, logEvent, ROLES, EMAIL_RE, PUBLIC_BASE_URL, assertPassword, closeUserSockets, escHtml, hashPassword, mailer, normalizedBranchId, normalizedSiteIds, publicUser, sign, sms, writeNotifyLog }) {

  // Admin: users
  function normalizeEmail(raw, { forId } = {}) {
    if (raw === undefined) return undefined;
    if (raw === null || raw === '') return null;
    const email = String(raw).toLowerCase().trim();
    if (!EMAIL_RE.test(email)) throw httpError(400, 'not a valid email address');
    if (db.users.some((u) => u.id !== forId && u.email === email)) throw httpError(409, 'that email is already linked to another account');
    return email;
  }

  route('GET', '/api/users', ADMIN, () => db.users.map(publicUser));
  route('POST', '/api/users', ADMIN, ({ body, user }) => {
    const username = String(body.username || '').toLowerCase().trim();
    if (!username || !body.password) throw httpError(400, 'username and password required');
    assertPassword(body.password, username);
    if (!ROLES.includes(body.role)) throw httpError(400, 'invalid role');
    if (db.users.some((u) => u.username === username)) throw httpError(409, 'username taken');
    const email = normalizeEmail(body.email) ?? null;
    const personnelId = body.personnel_id || null;
    if (personnelId && db.personnel.some((p) => p.id === personnelId && p.user_id)) throw httpError(409, 'that personnel record already has a login');
    const clientId = body.client_id || null;
    if (clientId && !db.clients.some((c) => c.id === clientId)) throw httpError(400, 'client_id must reference an existing client');
    const u = { id: nextId('users'), username, password_hash: hashPassword(String(body.password)), role: body.role, display_name: body.display_name || username, personnel_id: personnelId, mdt_id: body.mdt_id || null, client_id: clientId, branch_id: normalizedBranchId(body.branch_id), site_ids: normalizedSiteIds(body.site_ids), email, created_at: new Date().toISOString() };
    db.users.push(u);
    if (personnelId) { const p = db.personnel.find((x) => x.id === personnelId); if (p) p.user_id = u.id; }
    logEvent('user.created', `USER ${username} CREATED (${u.role}) BY ${user.username}`, { user_id: u.id, by: user.id });
    return { __status: 201, __body: { id: u.id, username: u.username, role: u.role } };
  });
  route('PATCH', '/api/users/:id', ADMIN, ({ params, body, user }) => {
    const u = db.users.find((x) => x.id === Number(params.id));
    if (!u) throw httpError(404, 'user not found');
    const roleBefore = u.role;
    if ('email' in body) u.email = normalizeEmail(body.email, { forId: u.id });
    if ('display_name' in body) u.display_name = String(body.display_name || '').trim() || u.username;
    if ('role' in body) {
      if (!ROLES.includes(body.role)) throw httpError(400, 'invalid role');
      u.role = body.role;
    }
    if ('personnel_id' in body) {
      const nextPersonnelId = body.personnel_id || null;
      if (nextPersonnelId && db.personnel.some((p) => p.id === nextPersonnelId && p.user_id && p.user_id !== u.id)) {
        throw httpError(409, 'that personnel record already has a login');
      }
      if (u.personnel_id && u.personnel_id !== nextPersonnelId) {
        const prev = db.personnel.find((p) => p.id === u.personnel_id);
        if (prev && prev.user_id === u.id) prev.user_id = null;
      }
      if (nextPersonnelId) { const p = db.personnel.find((x) => x.id === nextPersonnelId); if (p) p.user_id = u.id; }
      u.personnel_id = nextPersonnelId;
    }
    if ('mdt_id' in body) u.mdt_id = body.mdt_id || null;
    if ('client_id' in body) {
      const nextClientId = body.client_id || null;
      if (nextClientId && !db.clients.some((c) => c.id === nextClientId)) throw httpError(400, 'client_id must reference an existing client');
      u.client_id = nextClientId;
    }
    if ('branch_id' in body) u.branch_id = normalizedBranchId(body.branch_id);
    if ('site_ids' in body) u.site_ids = normalizedSiteIds(body.site_ids);
    if ('password' in body && body.password) {
      assertPassword(body.password, u.username);
      u.password_hash = hashPassword(String(body.password));
      u.password_set_at = Date.now();
    }
    // A new role or password takes effect on open screens now, not at their next reconnect.
    if (u.role !== roleBefore || body.password) closeUserSockets(u.id);
    // Who changed an account, and any change of role, is what an access review asks.
    const what = [u.role !== roleBefore ? `ROLE ${roleBefore} → ${u.role}` : '', body.password ? 'PASSWORD RESET' : ''].filter(Boolean).join(', ');
    logEvent('user.updated', `USER ${u.username} UPDATED BY ${user.username}${what ? ` (${what})` : ''}`, { user_id: u.id, by: user.id, role_before: roleBefore, role: u.role });
    return publicUser(u);
  });
  route('DELETE', '/api/users/:id', ADMIN, ({ params, user }) => {
    const u = db.users.find((x) => x.id === Number(params.id));
    if (!u) throw httpError(404, 'user not found');
    if (u.id === user.id) throw httpError(400, 'cannot delete the account you are signed in as');
    if (u.personnel_id) { const p = db.personnel.find((x) => x.id === u.personnel_id); if (p && p.user_id === u.id) p.user_id = null; }
    db.users = db.users.filter((x) => x.id !== u.id);
    closeUserSockets(u.id);
    logEvent('user.deleted', `USER ${u.username} DELETED BY ${user.username}`, { user_id: u.id, by: user.id });
    return { ok: true };
  });
  /** Staff sign in with Microsoft 365, not a password — there's nothing to
   * "reset" for them the way there is for a CLIENT login (see
   * POST /api/clients/:id/send-password-link), just an explanation of how
   * SSO works and which email it's matched against. Sends by whichever of
   * email/SMS it can: `u.email` for email (the same field SSO matching
   * already uses), the linked personnel record's contact_phone for SMS
   * (respecting sms_opt_out, same as every other SMS in this codebase) —
   * refuses outright only if neither is reachable at all. */
  route('POST', '/api/users/:id/send-welcome-link', ADMIN, async ({ params }) => {
    const u = db.users.find((x) => x.id === Number(params.id));
    if (!u) throw httpError(404, 'user not found');
    const person = u.personnel_id ? db.personnel.find((p) => p.id === u.personnel_id) : null;
    const email = u.email || (person && person.contact_email) || null;
    const phone = person && !person.sms_opt_out ? sms.normalizeNumber(person.contact_phone) : null;
    if (!email && !phone) throw httpError(400, 'this account has no email or phone number on file to send to');
    const first = (u.display_name || u.username).split(/\s+/)[0];
    const loginUrl = `${PUBLIC_BASE_URL}/index.html`;
    const sent = { email: false, sms: false };
    if (email) {
      const NAVY = '#0c1624', AMBER = '#f2a93c';
      const html = `<!doctype html><html><body style="margin:0;padding:0;background:#e2e5ea;font-family:Arial,Helvetica,sans-serif;color:#111827">
        <div style="max-width:560px;margin:0 auto">
          <div style="background:${NAVY};padding:30px 32px 26px">
            <img src="cid:echelon-wordmark" height="24" alt="Echelon" style="display:block;margin:0 0 22px;border:0">
            <p style="margin:0 0 10px;color:${AMBER};font-size:11px;font-weight:bold;letter-spacing:.14em;text-transform:uppercase">Your account</p>
            <h1 style="margin:0 0 10px;color:#ffffff;font-size:21px;line-height:1.3">You're set up on CCCS, ${escHtml(first)}.</h1>
            <p style="margin:0;color:#9fb0c3;font-size:14px;line-height:1.5">Sign in with your work Microsoft 365 account — there's no separate password to remember.</p>
          </div>
          <div style="background:#ffffff;padding:28px 32px">
            <ol style="margin:0 0 20px;padding-left:20px;font-size:14px;line-height:1.8">
              <li>Go to <a href="${loginUrl}">${PUBLIC_BASE_URL.replace(/^https?:\/\//, '')}</a></li>
              <li>Choose <strong>Sign in with Microsoft</strong></li>
              <li>Sign in with your work account${email ? ` (${escHtml(email)})` : ''}</li>
            </ol>
            <div style="text-align:center">
              <a href="${loginUrl}" style="display:inline-block;background:${NAVY};color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:6px;font-size:14px;font-weight:bold">Sign in &rarr;</a>
            </div>
          </div>
          <div style="background:${NAVY};padding:18px 32px">
            <p style="margin:0;color:#475569;font-size:10.5px;line-height:1.6">Sent automatically by CCCS &mdash; comms.echeloncic.com</p>
          </div>
        </div>
      </body></html>`;
      const logoFile = path.join(__dirname, 'public', 'assets', 'echelon-wordmark.png');
      const attachments = fs.existsSync(logoFile)
        ? [{ name: 'echelon-wordmark.png', contentType: 'image/png', content: fs.readFileSync(logoFile), contentId: 'echelon-wordmark', isInline: true }]
        : [];
      const r = await mailer.send(email, 'Your Echelon CCCS account', html, { attachments });
      writeNotifyLog({ channel: 'EMAIL', personnel_id: person ? person.id : null, to_email: email, body: 'Welcome link sent', provider: r.ok ? 'graph' : 'none', outcome: r.ok ? 'QUEUED' : 'FAILED', error_code: r.ok ? null : r.error });
      sent.email = Boolean(r.ok);
    }
    if (phone) {
      const body = `Hi ${first}, your CCCS account is ready. Go to ${PUBLIC_BASE_URL.replace(/^https?:\/\//, '')} and choose "Sign in with Microsoft" using your work account. — Echelon`;
      const r = await sms.send({ to: phone, body, label: u.display_name });
      writeNotifyLog({ channel: 'SMS', personnel_id: person ? person.id : null, to_number: phone, body, provider: r.dryRun ? 'none' : 'twilio', provider_ref: r.sid || null, outcome: r.ok ? (r.dryRun ? 'ATTEMPTED' : 'QUEUED') : 'FAILED', error_code: r.ok ? null : (r.error || 'send failed') });
      sent.sms = Boolean(r.ok);
    }
    logEvent('user.welcome_link_sent', `WELCOME LINK SENT TO ${u.username} (email: ${sent.email ? 'yes' : 'no'}, sms: ${sent.sms ? 'yes' : 'no'})`, { user_id: u.id });
    return sent;
  });

  /** Officer app sign-in for a subcontractor with no personnel file. They
   * have no work Microsoft account, so this makes a FIELD_USER login with a
   * password they choose from a one-time link (the same set-password flow as
   * the client portal), sent by SMS to their phone and by email if one is on
   * file. Calling it again sends a fresh link to the same login. The link is
   * also returned so control can pass it on by hand when SMS isn't set up. */
  route('POST', '/api/subcontractors/:id/login', ADMIN, async ({ params, body, user }) => {
    const p = db.personnel.find((x) => x.id === Number(params.id));
    if (!p || !p.external_sub) throw httpError(404, 'subcontractor not found');
    if (body && 'contact_phone' in body && body.contact_phone) p.contact_phone = String(body.contact_phone).trim().slice(0, 40);
    if (body && 'contact_email' in body && body.contact_email) p.contact_email = String(body.contact_email).trim().slice(0, 160);
    let u = p.user_id ? db.users.find((x) => x.id === p.user_id) : null;
    let created = false;
    if (!u) {
      const base = p.name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '') || 'subcontractor';
      let username = base, n = 1;
      while (db.users.some((x) => x.username === username)) username = `${base}${++n}`;
      u = {
        id: nextId('users'), username, password_hash: hashPassword(crypto.randomBytes(24).toString('hex')),
        role: 'FIELD_USER', display_name: p.name, personnel_id: p.id, mdt_id: null, client_id: null,
        branch_id: p.branch_id || null, site_ids: null, email: null, created_at: new Date().toISOString(),
      };
      db.users.push(u);
      p.user_id = u.id;
      created = true;
      logEvent('user.created', `USER ${username} CREATED (FIELD_USER, SUBCONTRACTOR ${p.name}) BY ${user.username}`, { user_id: u.id, by: user.id, personnel_id: p.id });
    }
    if (u.role !== 'FIELD_USER') throw httpError(409, `${p.name}'s login is not an officer login`);
    const iat = Date.now();
    const token = sign({ purpose: 'set_password', user_id: u.id, iat, exp: iat + 72 * 3600000 });
    const link = `${PUBLIC_BASE_URL}/set-password.html?for=officer&u=${encodeURIComponent(u.username)}&token=${encodeURIComponent(token)}`;
    const first = p.name.split(/\s+/)[0];
    const sent = { sms: false, email: false };
    const phone = !p.sms_opt_out ? sms.normalizeNumber(p.contact_phone) : null;
    // Why no text went, in words control can act on.
    let smsProblem = !p.contact_phone ? 'there is no phone number on their record'
      : p.sms_opt_out ? 'they have opted out of texts'
      : !phone ? `the phone number "${p.contact_phone}" isn't a UK mobile (07…) or +country number`
      : null;
    if (phone) {
      const text = `Hi ${first}, Echelon has set you up on the officer app. Your username is ${u.username}. Choose a password here (link works for 3 days): ${link}`;
      const r = await sms.send({ to: phone, body: text, label: p.name });
      writeNotifyLog({ channel: 'SMS', personnel_id: p.id, to_number: phone, body: 'Officer app sign-in link', provider: r.dryRun ? 'none' : 'twilio', provider_ref: r.sid || null, outcome: r.ok ? (r.dryRun ? 'ATTEMPTED' : 'QUEUED') : 'FAILED', error_code: r.ok ? null : (r.error || 'send failed') });
      sent.sms = Boolean(r.ok && !r.dryRun);
      if (r.dryRun) smsProblem = 'texting is in test mode on this server (SMS_LIVE is not on), so nothing actually goes out';
      else if (!r.ok) smsProblem = `the text failed: ${r.error || 'send failed'}`;
    }
    if (p.contact_email && !p.email_opt_out) {
      const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#111827">
        <p>Hi ${escHtml(first)},</p>
        <p>Echelon has set you up on the CCCS officer app for your shifts with us.</p>
        <p>Your username is <strong>${escHtml(u.username)}</strong>. Choose a password using the link below (it works for 3 days), then sign in at ${escHtml(PUBLIC_BASE_URL.replace(/^https?:\/\//, ''))}.</p>
        <p><a href="${link}">Choose your password</a></p>
      </body></html>`;
      // Backgrounded like the client portal's link: Graph mail can be slow.
      Promise.resolve(mailer.send(p.contact_email, 'Your Echelon officer app sign-in', html))
        .then((r) => writeNotifyLog({ channel: 'EMAIL', personnel_id: p.id, to_email: p.contact_email, body: 'Officer app sign-in link', provider: r && r.ok ? 'graph' : 'none', outcome: r && r.ok ? 'QUEUED' : 'FAILED', error_code: r && r.ok ? null : (r && r.error) || 'send failed' }))
        .catch((e) => writeNotifyLog({ channel: 'EMAIL', personnel_id: p.id, to_email: p.contact_email, body: 'Officer app sign-in link', provider: 'none', outcome: 'FAILED', error_code: e.message }));
      sent.email = true;
    }
    logEvent('user.signin_link_sent', `OFFICER APP SIGN-IN LINK FOR SUBCONTRACTOR ${p.name} (${u.username}) BY ${user.username} (sms: ${sent.sms ? 'yes' : 'no'}, email: ${sent.email ? 'yes' : 'no'})`, { user_id: u.id, personnel_id: p.id });
    return { username: u.username, created, link, sms: sent.sms, email: sent.email, sms_problem: sent.sms ? null : smsProblem, email_problem: sent.email ? null : (!p.contact_email ? 'there is no email address on their record' : 'they have opted out of email') };
  });
};
