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
 * V1 scope, on purpose: the client-facing site report omits the incident
 * list. routes-forms.js's canRead() is "control roles, or the filer, or a
 * named grant" — extending that to "or a client who owns the site" is a
 * real change to a security-critical invariant and deserves its own
 * careful pass, not a bolt-on here. Jobs/visits/response-time numbers carry
 * no personnel names and are safe to ship now; incidents are a follow-up.
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

// ASSIGNMENT_INSTRUCTIONS and SITE_MAP are versioned (see the upload route);
// CONTRACT and SITE_DOCUMENT keep their original, independent-upload
// behaviour unchanged.
const DOC_TYPES = ['CONTRACT', 'SITE_DOCUMENT', 'ASSIGNMENT_INSTRUCTIONS', 'SITE_MAP'];
const VERSIONED_DOC_TYPES = ['ASSIGNMENT_INSTRUCTIONS', 'SITE_MAP'];
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
  isControlRole, assertPassdownAccess,
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
    const label = versioned ? `${body.type === 'SITE_MAP' ? 'SITE MAP' : 'ASSIGNMENT INSTRUCTIONS'} "${title}" v${version}` : (body.type === 'CONTRACT' ? 'CONTRACT' : 'DOCUMENT');
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
  route('GET', '/api/client/sites/:id/report', CLIENT_OR_ADMIN, ({ params, query, user }) => {
    const client = requireClient(user, query);
    const site = ownedSite(client, params.id);
    const { from, to, inRange } = parseRange(query);
    const jobs = db.jobs.filter((j) => j.site_id === site.id && inRange(j.created_at));
    const visits = db.site_visits.filter((v) => v.site_id === site.id && inRange(v.scheduled_for));
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
    };
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
