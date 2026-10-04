/**
 * Client portal — a customer's own login, scoped to the sites they're
 * contracted for. This is the first genuinely external-facing role in
 * CCCS: everything up to now has been staff. Two invariants matter more
 * here than anywhere else in the codebase:
 *
 *   1. A CLIENT user sees ONLY the sites listed on their client record.
 *      Every route below re-checks that against the caller's own client,
 *      never trusts a client_id or site_id the request happened to supply.
 *      A site that isn't theirs is a 404, not a 403 — same reasoning as
 *      routes-forms.js: don't confirm to an outside party that something
 *      exists which they can't see.
 *   2. CLIENT is deliberately NOT in server.js's ALL — see the comment on
 *      ROLES there. Nothing here, or anywhere, should widen that.
 *
 * Incident visibility, deliberately NOT via routes-forms.js's canRead().
 * canRead() answers "which staff may read this" (control roles, the filer,
 * a named grant) — extending it to "or a client who owns the site" would
 * change a security-critical invariant for every staff caller too, for a
 * question canRead() was never asked. A client instead sees only a report an
 * admin has explicitly released: routes-forms.js's client_share gate is a
 * separate, opt-in, per-report decision with its own redacted copy (never
 * raw values, never submitted_by, never a photo or signature) — see
 * forms.clientVisibleSubmissions() there. Jobs/visits/response-time numbers
 * carry no personnel names and were always safe to ship without this.
 *
 * Real-time push for the client dashboard is also a follow-up: broadcast()
 * in server.js only delivers to a CLIENT socket when a call explicitly
 * passes siteIds, and nothing does yet, so client.html polls instead of
 * subscribing. Safe by construction either way — the gap is UX, not access.
 *
 * Registrar pattern, like routes-forms.js and routes-contact.js — server.js
 * passes in what this needs rather than requiring server.js back.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ASSIGNMENT_INSTRUCTIONS, SITE_MAP and INDUCTION are versioned (see the
// upload route); CONTRACT and SITE_DOCUMENT keep their original,
// independent-upload behaviour unchanged.
const DOC_TYPES = ['CONTRACT', 'SITE_DOCUMENT', 'ASSIGNMENT_INSTRUCTIONS', 'SITE_MAP', 'INDUCTION'];
const VERSIONED_DOC_TYPES = ['ASSIGNMENT_INSTRUCTIONS', 'SITE_MAP', 'INDUCTION'];
const DOC_MAX_BYTES = 15e6;

// Magic bytes, not the declared mimetype — same reasoning as routes-forms.js:
// these files are served back to someone else's browser.
const DOC_SIGNATURES = {
  'application/pdf': (b) => b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46,
  'image/png': (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
};
const DOC_EXT = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg' };

const CLIENT_REQUEST_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'CLOSED'];

module.exports = function registerClientRoutes({
  route, httpError, ALL, CONTROL, ADMIN, CLIENT, db, nextId, logEvent, broadcast, pushToRoles, UPLOADS_DIR, MIME,
  isControlRole, assertPassdownAccess, sendEmail, publicBaseUrl, sign, hashPassword, forms,
}) {
  for (const t of ['clients', 'documents', 'client_requests']) if (!Array.isArray(db[t])) db[t] = [];

  const CONTROL_OR_CLIENT = CONTROL.concat(CLIENT);
  const documentsDir = (siteId) => path.join(UPLOADS_DIR, 'documents', String(siteId));
  const clientOf = (user) => db.clients.find((c) => c.id === user.client_id) || null;
  /** Throws 404 (not 403) so a client can never learn a site id exists by
   * probing it — the site is simply not there, as far as they can tell. */
  function ownedSite(client, siteId) {
    if (!client || !client.site_ids.includes(Number(siteId))) throw httpError(404, 'site not found');
    return db.sites.find((s) => s.id === Number(siteId));
  }
  /** The client whose portal this request is about. For a CLIENT login,
   * always their own client. For a SYSTEM_ADMIN viewing a portal ("view as
   * client"), the client named by ?as_client= — they then get exactly the
   * client's own projection through the same routes, never more, and only
   * on the read routes below (CLIENT_OR_ADMIN); nothing writes as a client. */
  function requireClient(user, query) {
    if (user.role === 'SYSTEM_ADMIN') {
      const client = db.clients.find((c) => c.id === Number(query && query.get('as_client')));
      if (!client) throw httpError(404, 'client not found — choose a client to view');
      return client;
    }
    const client = clientOf(user);
    if (!client) throw httpError(403, 'this login is not linked to a client account');
    return client;
  }
  const CLIENT_OR_ADMIN = CLIENT.concat(ADMIN);
  function parseRange(query) {
    const to = query.get('to') ? new Date(query.get('to')) : new Date();
    const from = query.get('from') ? new Date(query.get('from')) : new Date(to.getTime() - 30 * 86400000);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) throw httpError(400, 'invalid from/to date');
    return { from, to, inRange: (iso) => { const t = Date.parse(iso); return !isNaN(t) && t >= from.getTime() && t <= to.getTime(); } };
  }

  /* -------------------------------------------------------------- *
   * Client-safe projections — no personnel names, no keyholder, no
   * internal notes. What a customer sees about their own site.
   * -------------------------------------------------------------- */
  const clientSite = (s) => ({ id: s.id, name: s.name, address: s.address });
  const clientJob = (j) => {
    const site = db.sites.find((s) => s.id === j.site_id);
    return {
      id: j.id, reference: j.reference, priority: j.priority, status: j.status, incident_type: j.incident_type,
      site_id: j.site_id, site_name: site ? site.name : null,
      created_at: j.created_at, dispatched_at: j.dispatched_at, on_scene_at: j.on_scene_at, completed_at: j.completed_at,
    };
  };
  const clientVisit = (v) => {
    const site = db.sites.find((s) => s.id === v.site_id);
    return {
      id: v.id, reference: v.reference, status: v.status, site_id: v.site_id, site_name: site ? site.name : null,
      scheduled_for: v.scheduled_for, dispatched_at: v.dispatched_at, on_scene_at: v.on_scene_at, completed_at: v.completed_at,
    };
  };
  /** No personnel names — same conservative default as clientJob/clientVisit
   * above. A client sees that a post is covered and by how it's going
   * (gap or not), not who specifically is standing it. */
  const clientShift = (s) => {
    const site = db.sites.find((x) => x.id === s.site_id);
    const type = s.shift_type_id ? db.shift_types.find((t) => t.id === s.shift_type_id) : null;
    const as = db.shift_assignments.filter((a) => a.shift_id === s.id && a.status !== 'REMOVED' && !a.time_rejected);
    const activeCount = as.filter((a) => ['ASSIGNED', 'CONFIRMED'].includes(a.status)).length;
    // Attendance as times and counts only — when officers arrived and left,
    // how many are there now — and the patrols on the shift. No names.
    const ins = as.map((a) => a.clocked_in_at).filter(Boolean).sort(), outs = as.map((a) => a.clocked_out_at).filter(Boolean).sort();
    const onNow = as.filter((a) => a.clocked_in_at && !a.clocked_out_at).length;
    const patrols = (db.site_visits || []).filter((v) => v.shift_id === s.id);
    const now = Date.now();
    const state = onNow ? 'ON_SITE' : ins.length ? 'COMPLETED'
      : now < Date.parse(s.starts_at) ? (activeCount >= (s.required_headcount || 1) ? 'BOOKED' : 'NOT_YET_COVERED')
      : now > Date.parse(s.ends_at) ? 'NOT_ATTENDED' : 'DUE';
    return {
      id: s.id, site_id: s.site_id, site_name: site ? site.name : null,
      shift_type_name: type ? type.name : null,
      starts_at: s.starts_at, ends_at: s.ends_at, status: s.status,
      required_headcount: s.required_headcount || 0, assigned_count: activeCount,
      coverage_gap: Math.max(0, (s.required_headcount || 0) - activeCount),
      ad_hoc: Boolean(s.ad_hoc || (s.detail && s.detail.adhoc)), state, officers_on_site: onNow,
      arrived_at: ins[0] || null, left_at: !onNow && outs.length ? outs[outs.length - 1] : null,
      patrol_every_min: s.patrol ? s.patrol.every_min : null,
      patrols: { total: patrols.length, completed: patrols.filter((v) => v.status === 'COMPLETED').length, missed: patrols.filter((v) => v.status === 'MISSED').length },
    };
  };
  const publicDocument = (d) => ({
    id: d.id, site_id: d.site_id, type: d.type, title: d.title || null,
    version: d.version || 1, is_current: d.is_current !== false,
    filename: d.filename, mimetype: d.mimetype, uploaded_by: d.uploaded_by, uploaded_at: d.uploaded_at,
  });

  /* -------------------------------------------------------------- *
   * Client organisations — admin manages who a client account can see
   * -------------------------------------------------------------- */
  route('POST', '/api/clients', ADMIN, ({ body }) => {
    const name = String(body.name || '').trim();
    if (!name) throw httpError(400, 'name required');
    const siteIds = Array.isArray(body.site_ids) ? body.site_ids.map(Number).filter((id) => db.sites.some((s) => s.id === id)) : [];
    const c = { id: nextId('clients'), name, contact_email: body.contact_email || '', billing_email: String(body.billing_email || '').trim(), billing_address: String(body.billing_address || '').trim().slice(0, 500), site_ids: siteIds, created_at: new Date().toISOString() };
    db.clients.push(c);
    logEvent('client.created', `CLIENT ${name} ADDED`);
    return { __status: 201, __body: c };
  });
  route('GET', '/api/clients', CONTROL, () => db.clients);
  route('PATCH', '/api/clients/:id', ADMIN, ({ params, body }) => {
    const c = db.clients.find((x) => x.id === Number(params.id));
    if (!c) throw httpError(404, 'client not found');
    if ('name' in body) {
      const name = String(body.name || '').trim();
      if (!name) throw httpError(400, 'name required');
      c.name = name;
    }
    if ('contact_email' in body) c.contact_email = body.contact_email || '';
    // Invoices go to the billing email if set, else the contact email.
    if ('billing_email' in body) c.billing_email = String(body.billing_email || '').trim();
    if ('billing_address' in body) c.billing_address = String(body.billing_address || '').trim().slice(0, 500);
    if ('site_ids' in body) {
      if (!Array.isArray(body.site_ids)) throw httpError(400, 'site_ids must be an array');
      c.site_ids = body.site_ids.map(Number).filter((id) => db.sites.some((s) => s.id === id));
    }
    logEvent('client.updated', `CLIENT ${c.name} UPDATED`, { client_id: c.id });
    return c;
  });
  route('DELETE', '/api/clients/:id', ADMIN, ({ params }) => {
    const c = db.clients.find((x) => x.id === Number(params.id));
    if (!c) throw httpError(404, 'client not found');
    if (db.users.some((u) => u.client_id === c.id)) throw httpError(409, 'client has a linked login — remove or reassign it first');
    db.clients = db.clients.filter((x) => x.id !== c.id);
    logEvent('client.deleted', `CLIENT ${c.name} DELETED`);
    return { ok: true };
  });

  const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /** Same brand language as the printed marketing material (dark navy band,
   * amber accent, numbered feature rows, tracked uppercase labels) rather
   * than the plainer resolution-report email style — this one goes to a
   * client's inbox as their first impression of the portal, not an
   * operational record. The logo is the existing white-on-transparent
   * wordmark (public/assets/echelon-wordmark.png) — it's invisible on a
   * light background (that's why the resolution-report email's copy of it
   * barely shows), so it only ever sits on the dark band here. */
  const NAVY = '#0c1624', AMBER = '#f2a93c', LINE = '#e2e5ea', MUTED = '#6b7280';
  function buildWelcomeEmailHtml(client) {
    const loginUrl = `${publicBaseUrl}/index.html`;
    const features = [
      ['Jobs & patrol visits', 'See activity at your sites as it happens — dispatches, patrol visits, and when each one is resolved.'],
      ['Service reports', 'A clear record of what happened on site and when, for every job and visit.'],
      ['Quotes & contracts', 'Review and sign quotes and contracts online.'],
      ['Invoices', 'View and keep track of invoices raised to your account.'],
      ['Equipment on hire', 'See what equipment you currently have on hire from us.'],
      ['Documents', 'Site maps, assignment instructions and other paperwork for your sites, in one place.'],
      ['Raise a request', 'Send us a request directly and track its progress.'],
    ];
    return `<!doctype html><html><body style="margin:0;padding:0;background:${LINE};font-family:Arial,Helvetica,sans-serif;color:#111827">
      <div style="max-width:640px;margin:0 auto">
        <div style="background:${NAVY};padding:30px 32px 26px">
          <img src="cid:echelon-wordmark" height="24" alt="Echelon" style="display:block;margin:0 0 22px;border:0">
          <p style="margin:0 0 10px;color:${AMBER};font-size:11px;font-weight:bold;letter-spacing:.14em;text-transform:uppercase">Client portal &middot; Welcome</p>
          <h1 style="margin:0 0 10px;color:#ffffff;font-size:23px;line-height:1.3">Your account is <span style="color:${AMBER}">ready</span>, ${escHtml(client.name)}.</h1>
          <p style="margin:0;color:#9fb0c3;font-size:14px;line-height:1.5">You now have online access to your account with Echelon.</p>
        </div>
        <div style="background:#ffffff;padding:28px 32px">
          <p style="margin:0 0 16px;color:${MUTED};font-size:11px;font-weight:bold;letter-spacing:.1em;text-transform:uppercase">What you can do</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            ${features.map(([label, desc], i) => `<tr>
              <td style="padding:10px 12px 10px 0;border-bottom:1px solid ${LINE};width:30px;vertical-align:top;color:${AMBER};font-weight:bold;font-size:13px">${String(i + 1).padStart(2, '0')}</td>
              <td style="padding:10px 0;border-bottom:1px solid ${LINE};vertical-align:top">
                <strong style="color:#111827">${escHtml(label)}</strong><br>
                <span style="color:${MUTED};font-size:13px">${escHtml(desc)}</span>
              </td>
            </tr>`).join('')}
          </table>
          <table style="width:100%;border-collapse:collapse;margin-top:22px"><tr><td style="background:#fdf3e0;border-left:3px solid ${AMBER};padding:14px 16px;font-size:13px;color:#57534e">
            Questions about your account? Reply to this email or call <strong>01472 352462</strong> — we're happy to help.
          </td></tr></table>
        </div>
        <div style="background:${AMBER};padding:24px 32px">
          <table style="width:100%;border-collapse:collapse"><tr>
            <td style="vertical-align:middle">
              <p style="margin:0 0 2px;font-size:17px;font-weight:bold;color:${NAVY}">Ready when you are.</p>
              <p style="margin:0;font-size:13px;color:#3a2e14">Sign in to see jobs, reports, invoices and more.</p>
            </td>
            <td align="right" style="vertical-align:middle;white-space:nowrap">
              <a href="${loginUrl}" style="display:inline-block;background:${NAVY};color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:6px;font-size:13px;font-weight:bold">Sign in &rarr;</a>
            </td>
          </tr></table>
        </div>
        <div style="background:${NAVY};padding:20px 32px">
          <p style="margin:0 0 6px;color:#64748b;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase">Inspections &middot; Monitoring &middot; Keyholding &middot; Response</p>
          <p style="margin:0;color:#475569;font-size:10.5px;line-height:1.6">
            Echelon Command Information Centre Ltd &middot; Company No. 13765107<br>
            Regent House, Brookenby Business Park, Binbrook, Market Rasen LN8 6HF<br>
            Sent automatically by CCCS &mdash; comms.echeloncic.com
          </p>
        </div>
      </div>
    </body></html>`;
  }
  route('POST', '/api/clients/:id/welcome-email', ADMIN, async ({ params }) => {
    const c = db.clients.find((x) => x.id === Number(params.id));
    if (!c) throw httpError(404, 'client not found');
    if (!c.contact_email) throw httpError(400, 'client has no contact email set');
    const logoFile = path.join(__dirname, 'public', 'assets', 'echelon-wordmark.png');
    const attachments = fs.existsSync(logoFile)
      ? [{ name: 'echelon-wordmark.png', contentType: 'image/png', content: fs.readFileSync(logoFile), contentId: 'echelon-wordmark', isInline: true }]
      : [];
    const result = await sendEmail(c.contact_email, 'Welcome to your Echelon client portal', buildWelcomeEmailHtml(c), { attachments });
    if (!result || result.ok === false) throw httpError(502, (result && result.error) || 'email send failed');
    logEvent('client.welcome_email_sent', `WELCOME EMAIL SENT TO ${c.name}`, { client_id: c.id });
    return { ok: true };
  });

  /** Same shell as the welcome email, a narrower job: get them to a working
   * password, nothing else. Shares the house style (navy/amber) rather than
   * the welcome email's own full layout — this one has one job, so it's a
   * single CTA, not a feature list. */
  function buildPasswordLinkEmailHtml(client, link) {
    return `<!doctype html><html><body style="margin:0;padding:0;background:${LINE};font-family:Arial,Helvetica,sans-serif;color:#111827">
      <div style="max-width:560px;margin:0 auto">
        <div style="background:${NAVY};padding:30px 32px 26px">
          <img src="cid:echelon-wordmark" height="24" alt="Echelon" style="display:block;margin:0 0 22px;border:0">
          <p style="margin:0 0 10px;color:${AMBER};font-size:11px;font-weight:bold;letter-spacing:.14em;text-transform:uppercase">Client portal</p>
          <h1 style="margin:0 0 10px;color:#ffffff;font-size:21px;line-height:1.3">Set your password, ${escHtml(client.name)}.</h1>
          <p style="margin:0;color:#9fb0c3;font-size:14px;line-height:1.5">Choose a password for your Echelon client portal account.</p>
        </div>
        <div style="background:#ffffff;padding:28px 32px;text-align:center">
          <a href="${link}" style="display:inline-block;background:${NAVY};color:#ffffff;text-decoration:none;padding:13px 26px;border-radius:6px;font-size:14px;font-weight:bold">Set your password &rarr;</a>
          <p style="margin:20px 0 0;color:${MUTED};font-size:12.5px">This link works once and expires in 48 hours. If you didn't ask for this, you can ignore it — no changes will be made.</p>
        </div>
        <div style="background:${NAVY};padding:18px 32px">
          <p style="margin:0;color:#475569;font-size:10.5px;line-height:1.6">
            Echelon Command Information Centre Ltd &middot; Company No. 13765107<br>
            Sent automatically by CCCS &mdash; comms.echeloncic.com
          </p>
        </div>
      </div>
    </body></html>`;
  }
  /** Creates the client's login if one doesn't exist yet (a random, never-
   * communicated password that the link below immediately supersedes — this
   * button is the whole onboarding step, not a second one after someone
   * remembers to create the login by hand first), then emails a one-time,
   * 48-hour set-password link built from the same sign()/verifyToken()
   * mechanism sessions already use (POST /api/auth/set-password, server.js).
   * The account itself never carries a password anyone actually knows until
   * the client sets it; nothing here or in the email contains it. */
  route('POST', '/api/clients/:id/send-password-link', ADMIN, async ({ params }) => {
    const c = db.clients.find((x) => x.id === Number(params.id));
    if (!c) throw httpError(404, 'client not found');
    if (!c.contact_email) throw httpError(400, 'client has no contact email set');
    let u = db.users.find((x) => x.client_id === c.id);
    if (!u) {
      const base = (String(c.contact_email).split('@')[0] || c.name).toLowerCase().replace(/[^a-z0-9.]/g, '') || 'client';
      let username = base, n = 1;
      while (db.users.some((x) => x.username === username)) username = `${base}${++n}`;
      u = {
        id: nextId('users'), username, password_hash: hashPassword(crypto.randomBytes(24).toString('hex')),
        role: 'CLIENT', display_name: c.name, personnel_id: null, mdt_id: null, client_id: c.id,
        branch_id: null, site_ids: null, email: c.contact_email, created_at: new Date().toISOString(),
      };
      db.users.push(u);
      logEvent('client.login_created', `LOGIN CREATED FOR CLIENT ${c.name} (${username})`, { client_id: c.id, user_id: u.id });
    }
    const iat = Date.now();
    const token = sign({ purpose: 'set_password', user_id: u.id, iat, exp: iat + 48 * 3600000 });
    const link = `${publicBaseUrl}/set-password.html?token=${encodeURIComponent(token)}`;
    const logoFile = path.join(__dirname, 'public', 'assets', 'echelon-wordmark.png');
    const attachments = fs.existsSync(logoFile)
      ? [{ name: 'echelon-wordmark.png', contentType: 'image/png', content: fs.readFileSync(logoFile), contentId: 'echelon-wordmark', isInline: true }]
      : [];
    const result = await sendEmail(c.contact_email, 'Set your password for the Echelon client portal', buildPasswordLinkEmailHtml(c, link), { attachments });
    if (!result || result.ok === false) throw httpError(502, (result && result.error) || 'email send failed');
    logEvent('client.password_link_sent', `PASSWORD LINK SENT TO ${c.name} (${u.username})`, { client_id: c.id, user_id: u.id });
    return { ok: true, username: u.username };
  });

  /* -------------------------------------------------------------- *
   * Site documents — contracts and site-specific paperwork. Admin
   * uploads; control and the owning client can list/download.
   * -------------------------------------------------------------- */
  route('POST', '/api/sites/:id/documents', ADMIN, ({ params, body, user }) => {
    const site = db.sites.find((s) => s.id === Number(params.id));
    if (!site) throw httpError(404, 'site not found');
    if (!DOC_TYPES.includes(body.type)) throw httpError(400, `type must be one of ${DOC_TYPES.join(', ')}`);
    const versioned = VERSIONED_DOC_TYPES.includes(body.type);
    const title = String(body.title || '').trim();
    if (versioned && !title) throw httpError(400, 'title required for assignment instructions and site maps');
    const ext = DOC_EXT[body.mimetype];
    if (!ext) throw httpError(400, 'mimetype must be application/pdf, image/png or image/jpeg');
    if (!body.data) throw httpError(400, 'data (base64) required');
    const bytes = Buffer.from(body.data, 'base64');
    if (bytes.length > DOC_MAX_BYTES) throw httpError(413, 'document too large');
    if (!DOC_SIGNATURES[body.mimetype](bytes)) throw httpError(400, 'file content does not match the declared mimetype');

    // A new upload under the same site+type+title supersedes the last
    // current one rather than sitting alongside it — the archive is kept
    // (never deleted), just no longer the version that surfaces by default.
    let version = 1;
    if (versioned) {
      const previous = db.documents.find((x) => x.site_id === site.id && x.type === body.type && x.is_current !== false
        && (x.title || '').trim().toLowerCase() === title.toLowerCase());
      if (previous) { previous.is_current = false; version = (previous.version || 1) + 1; }
    }

    const dir = documentsDir(site.id);
    fs.mkdirSync(dir, { recursive: true });
    const storedName = `${crypto.randomUUID()}${ext}`;
    fs.writeFileSync(path.join(dir, storedName), bytes);
    const d = {
      id: nextId('documents'), site_id: site.id, type: body.type, title: versioned ? title : '',
      version, is_current: true,
      filename: String(body.filename || 'document').trim().slice(0, 200) || 'document',
      stored_name: storedName, mimetype: body.mimetype,
      uploaded_by: user.display_name, uploaded_at: new Date().toISOString(),
    };
    db.documents.push(d);
    const versionedLabel = { SITE_MAP: 'SITE MAP', INDUCTION: 'INDUCTION' }[body.type] || 'ASSIGNMENT INSTRUCTIONS';
    const label = versioned ? `${versionedLabel} "${title}" v${version}` : (body.type === 'CONTRACT' ? 'CONTRACT' : 'DOCUMENT');
    logEvent('site.document_uploaded', `${label} UPLOADED FOR ${site.name}`, { site_id: site.id, document_id: d.id });
    return { __status: 201, __body: publicDocument(d) };
  });
  route('GET', '/api/sites/:id/documents', ALL, ({ params, query, user }) => {
    const site = db.sites.find((s) => s.id === Number(params.id));
    if (!site) throw httpError(404, 'site not found');
    let rows = db.documents.filter((d) => d.site_id === site.id);
    if (!isControlRole(user.role)) {
      // Staff without a control role only ever see the current assignment
      // instructions/maps for a site they're actually posted to — never a
      // contract, never an archived version — the same "have you been
      // posted here" check routes-client.js's passdown logs already use.
      assertPassdownAccess(site.id, user);
      rows = rows.filter((d) => VERSIONED_DOC_TYPES.includes(d.type) && d.is_current !== false);
    } else {
      if (query.get('type')) rows = rows.filter((d) => d.type === query.get('type'));
      if (query.get('current') === '1') rows = rows.filter((d) => d.is_current !== false);
    }
    return rows.map(publicDocument);
  });
  route('GET', '/api/documents/:id/file', ALL, ({ params, user }) => {
    const d = db.documents.find((x) => x.id === Number(params.id));
    if (!d) throw httpError(404, 'document not found');
    if (!isControlRole(user.role)) {
      // 404, not 403 — same "don't confirm it exists" reasoning ownedSite()
      // below already uses for a client probing a site id that isn't theirs.
      if (!VERSIONED_DOC_TYPES.includes(d.type) || d.is_current === false) throw httpError(404, 'document not found');
      assertPassdownAccess(d.site_id, user);
    }
    const file = path.join(documentsDir(d.site_id), d.stored_name);
    if (!fs.existsSync(file)) throw httpError(404, 'document file missing');
    const inline = VERSIONED_DOC_TYPES.includes(d.type);
    return {
      __stream: fs.createReadStream(file),
      __headers: {
        'content-type': d.mimetype, 'cache-control': 'private, max-age=604800',
        'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${d.filename.replace(/"/g, '')}"`,
      },
    };
  });
  route('DELETE', '/api/documents/:id', ADMIN, ({ params }) => {
    const d = db.documents.find((x) => x.id === Number(params.id));
    if (!d) throw httpError(404, 'document not found');
    const file = path.join(documentsDir(d.site_id), d.stored_name);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    db.documents = db.documents.filter((x) => x.id !== d.id);
    logEvent('site.document_deleted', `DOCUMENT DELETED (${d.filename})`, { site_id: d.site_id, document_id: d.id });
    return { ok: true };
  });

  /* -------------------------------------------------------------- *
   * Client requests — a two-way channel. A client raises one against
   * one of their own sites; control acknowledges and closes it.
   * -------------------------------------------------------------- */
  route('POST', '/api/client-requests', CLIENT, ({ body, user }) => {
    const client = requireClient(user);
    const siteId = Number(body.site_id);
    if (!client.site_ids.includes(siteId)) throw httpError(400, 'site_id must be one of your sites');
    const subject = String(body.subject || '').trim();
    if (!subject) throw httpError(400, 'subject required');
    const r = {
      id: nextId('client_requests'), client_id: client.id, site_id: siteId, subject,
      body: String(body.body || '').trim().slice(0, 4000), status: 'OPEN',
      created_at: new Date().toISOString(), resolved_at: null, resolution_notes: '', raised_by: user.display_name,
    };
    db.client_requests.push(r);
    logEvent('client_request.raised', `CLIENT REQUEST FROM ${client.name} — ${subject}`, { client_request_id: r.id, site_id: siteId });
    pushToRoles(CONTROL, { title: 'Client request', body: `${client.name}: ${subject}`, url: '/admin.html', tag: 'cccs-client-request' });
    return { __status: 201, __body: r };
  });
  route('GET', '/api/client-requests', CONTROL_OR_CLIENT, ({ user }) => {
    if (CONTROL.includes(user.role)) return db.client_requests.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    if (user.role === 'CLIENT') {
      const client = requireClient(user);
      return db.client_requests.filter((r) => r.client_id === client.id).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    }
    throw httpError(403, 'insufficient role');
  });
  route('PATCH', '/api/client-requests/:id', CONTROL, ({ params, body }) => {
    const r = db.client_requests.find((x) => x.id === Number(params.id));
    if (!r) throw httpError(404, 'client request not found');
    if ('status' in body) {
      if (!CLIENT_REQUEST_STATUSES.includes(body.status)) throw httpError(400, 'invalid status');
      r.status = body.status;
      if (body.status === 'CLOSED') r.resolved_at = new Date().toISOString();
    }
    if ('resolution_notes' in body) r.resolution_notes = String(body.resolution_notes || '').trim().slice(0, 4000);
    logEvent('client_request.updated', `CLIENT REQUEST ${r.id} → ${r.status}`, { client_request_id: r.id });
    return r;
  });

  /* -------------------------------------------------------------- *
   * The portal itself — everything a CLIENT can call, all scoped to
   * client.site_ids and re-checked on every call, never trusted from
   * the request.
   * -------------------------------------------------------------- */
  route('GET', '/api/client/me', CLIENT_OR_ADMIN, ({ user, query }) => {
    const client = requireClient(user, query);
    // Opening a portal as an admin is logged; the portal page calls this once on load.
    if (user.role === 'SYSTEM_ADMIN') logEvent('client.portal_viewed', `${user.username} VIEWED THE CLIENT PORTAL OF ${client.name}`, { client_id: client.id });
    return { id: client.id, name: client.name, sites: db.sites.filter((s) => client.site_ids.includes(s.id)).map(clientSite) };
  });
  route('GET', '/api/client/jobs', CLIENT_OR_ADMIN, ({ user, query }) => {
    const client = requireClient(user, query);
    const siteId = query.get('site_id') ? Number(query.get('site_id')) : null;
    if (siteId) ownedSite(client, siteId);
    return db.jobs.filter((j) => client.site_ids.includes(j.site_id) && (!siteId || j.site_id === siteId))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 100).map(clientJob);
  });
  route('GET', '/api/client/site-visits', CLIENT_OR_ADMIN, ({ user, query }) => {
    const client = requireClient(user, query);
    const siteId = query.get('site_id') ? Number(query.get('site_id')) : null;
    if (siteId) ownedSite(client, siteId);
    return db.site_visits.filter((v) => client.site_ids.includes(v.site_id) && (!siteId || v.site_id === siteId))
      .sort((a, b) => (a.scheduled_for < b.scheduled_for ? 1 : -1)).slice(0, 100).map(clientVisit);
  });
  /** Rota coverage for a client's own site(s) — published/in-progress/
   * completed only, same as every staff-facing rota view already hides a
   * DRAFT shift from anyone it isn't ready for yet. Defaults to "from
   * yesterday" so what's currently on site still shows, not just what's
   * still to come. */
  route('GET', '/api/client/shifts', CLIENT_OR_ADMIN, ({ user, query }) => {
    const client = requireClient(user, query);
    const siteId = query.get('site_id') ? Number(query.get('site_id')) : null;
    if (siteId) ownedSite(client, siteId);
    const from = query.get('from') ? Date.parse(query.get('from')) : Date.now() - 86400000;
    const to = query.get('to') ? Date.parse(query.get('to')) : Infinity;
    return db.shifts.filter((s) => !['DRAFT', 'CANCELLED'].includes(s.status) && client.site_ids.includes(s.site_id) && (!siteId || s.site_id === siteId) && Date.parse(s.ends_at) >= from && Date.parse(s.starts_at) <= to)
      .sort((a, b) => (a.starts_at < b.starts_at ? -1 : 1)).slice(0, 100).map(clientShift);
  });
  route('GET', '/api/client/sites/:id/report', CLIENT_OR_ADMIN, ({ params, query, user }) => {
    const client = requireClient(user, query);
    const site = ownedSite(client, params.id);
    const { from, to, inRange } = parseRange(query);
    const jobs = db.jobs.filter((j) => j.site_id === site.id && inRange(j.created_at));
    const visits = db.site_visits.filter((v) => v.site_id === site.id && inRange(v.scheduled_for));
    const incidents = forms.clientVisibleSubmissions([site.id]).filter((s) => inRange(s.occurred_at));
    const responseMinutes = jobs.filter((j) => j.on_scene_at).map((j) => (Date.parse(j.on_scene_at) - Date.parse(j.created_at)) / 60000);
    const avgResponseMinutes = responseMinutes.length ? Math.round((responseMinutes.reduce((a, b) => a + b, 0) / responseMinutes.length) * 10) / 10 : null;
    return {
      site: clientSite(site), from: from.toISOString(), to: to.toISOString(),
      jobs: {
        total: jobs.length, completed: jobs.filter((j) => j.status === 'COMPLETED').length, cancelled: jobs.filter((j) => j.status === 'CANCELLED').length,
        avg_response_minutes: avgResponseMinutes, sla_minutes: site.response_sla_minutes || null,
        within_sla: site.response_sla_minutes ? responseMinutes.filter((m) => m <= site.response_sla_minutes).length : null,
      },
      visits: {
        total: visits.length, completed: visits.filter((v) => v.status === 'COMPLETED').length,
        missed: visits.filter((v) => v.status === 'MISSED').length, cancelled: visits.filter((v) => v.status === 'CANCELLED').length,
      },
      incidents: { total: incidents.length },
    };
  });
  /** The redacted reports an admin has explicitly released for this site —
   * see routes-forms.js's client_share gate and clientVisibleSubmissions().
   * Never raw values, never who filed it: only what an admin typed into the
   * share request. */
  route('GET', '/api/client/sites/:id/incidents', CLIENT_OR_ADMIN, ({ params, query, user }) => {
    const client = requireClient(user, query);
    const site = ownedSite(client, params.id);
    return forms.clientVisibleSubmissions([site.id]);
  });
  route('GET', '/api/client/documents', CLIENT_OR_ADMIN, ({ user, query }) => {
    const client = requireClient(user, query);
    const siteId = query.get('site_id') ? Number(query.get('site_id')) : null;
    if (siteId) ownedSite(client, siteId);
    // Assignment instructions and site maps are internal operational
    // documents — a client sees contracts and site paperwork about their
    // own site, never the patrol route or access details staff work from.
    return db.documents.filter((d) => client.site_ids.includes(d.site_id) && (!siteId || d.site_id === siteId) && !VERSIONED_DOC_TYPES.includes(d.type)).map(publicDocument);
  });
  route('GET', '/api/client/documents/:id/file', CLIENT_OR_ADMIN, ({ params, user, query }) => {
    const client = requireClient(user, query);
    const d = db.documents.find((x) => x.id === Number(params.id));
    if (!d || !client.site_ids.includes(d.site_id) || VERSIONED_DOC_TYPES.includes(d.type)) throw httpError(404, 'document not found');
    const file = path.join(documentsDir(d.site_id), d.stored_name);
    if (!fs.existsSync(file)) throw httpError(404, 'document file missing');
    return { __stream: fs.createReadStream(file), __headers: { 'content-type': d.mimetype, 'cache-control': 'private, max-age=604800', 'content-disposition': `attachment; filename="${d.filename.replace(/"/g, '')}"` } };
  });
};
