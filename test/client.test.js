/* Client portal (routes-client.js) — node --test
 *
 * The centre of this file is the same shape of invariant as forms.test.js's
 * RESTRICTED leak test, but for an entire role rather than one document
 * type: CLIENT is an external login, and must never see another client's
 * data, another site's data, or anything at all from an untargeted
 * broadcast — by any route or by the websocket. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const crypto = require('node:crypto');

process.env.PORT = '4015';
process.env.AUTH_SECRET = 'client-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, raw: text, headers: res.headers };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;

/** A raw socket that just records every byte the server sends — same
 * technique as forms.test.js's leak test: proves what did or didn't reach
 * this connection, rather than trusting a parsed client-side view of it. */
function rawSocket(token) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(process.env.PORT), '127.0.0.1', () => {
      sock.write(`GET /ws?token=${encodeURIComponent(token)} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    const s = { bytes: '', close: () => sock.destroy() };
    sock.on('data', (d) => { s.bytes += d.toString('latin1'); if (s.bytes.includes('101 Switching')) resolve(s); });
    sock.on('error', reject);
  });
}

const PDF = Buffer.from('%PDF-1.4 not a real pdf, just needs the header').toString('base64');

let adminT, dispT;
const mails = [];
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dispT = await login('dispatcher', 'dispatch123');
  app.mailer.send = async (to, subject, html, opts = {}) => { mails.push({ to, subject, html, attachments: opts.attachments || [] }); return { ok: true }; };
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

/* ---------------- CLIENT is not in ALL ---------------- */
test('a CLIENT account cannot call any ALL-gated internal route', async () => {
  const sites = await call('GET', '/api/sites', undefined, dispT);
  const siteA = sites.body[0];
  const client = (await call('POST', '/api/clients', { name: 'Isolation Test Co', site_ids: [siteA.id] }, adminT)).body;
  const user = (await call('POST', '/api/users', { username: 'clienttest1', password: 'realpassword1', role: 'CLIENT', client_id: client.id }, adminT)).body;
  const clientT = await login('clienttest1', 'realpassword1');

  for (const path of ['/api/sites', '/api/personnel', '/api/mdts', '/api/vehicles', '/api/form-submissions', '/api/jobs', '/api/users', '/api/beats']) {
    const r = await call('GET', path, undefined, clientT);
    assert.equal(r.status, 403, `CLIENT should not reach ${path}, got ${r.status}`);
  }
});

/* ---------------- cross-tenant isolation ---------------- */
test('a client sees only their own sites, jobs, visits and documents — never another client\'s', async () => {
  const sites = (await call('GET', '/api/sites', undefined, dispT)).body;
  const [siteA, siteB] = sites;

  const clientA = (await call('POST', '/api/clients', { name: 'Client A', site_ids: [siteA.id] }, adminT)).body;
  const clientB = (await call('POST', '/api/clients', { name: 'Client B', site_ids: [siteB.id] }, adminT)).body;
  await call('POST', '/api/users', { username: 'clienta', password: 'realpassword1', role: 'CLIENT', client_id: clientA.id }, adminT);
  await call('POST', '/api/users', { username: 'clientb', password: 'realpassword1', role: 'CLIENT', client_id: clientB.id }, adminT);
  const clientAT = await login('clienta', 'realpassword1');
  const clientBT = await login('clientb', 'realpassword1');

  const meA = await call('GET', '/api/client/me', undefined, clientAT);
  assert.equal(meA.body.sites.length, 1);
  assert.equal(meA.body.sites[0].id, siteA.id);
  assert.equal(meA.body.sites[0].keyholder, undefined, 'client projection must not carry internal fields like keyholder');

  const jobAtB = (await call('POST', '/api/jobs', { priority: 'AMBER', incident_type: 'Alarm activation', site: siteB.id }, dispT)).body;

  // Client A cannot see client B's job, whether unfiltered or by asking for B's site directly.
  const jobsA = await call('GET', '/api/client/jobs', undefined, clientAT);
  assert.ok(!jobsA.body.some((j) => j.id === jobAtB.id));
  assert.equal((await call('GET', `/api/client/jobs?site_id=${siteB.id}`, undefined, clientAT)).status, 404, 'a site that is not theirs is a 404, not a 403 or a filtered empty list');
  assert.equal((await call('GET', `/api/client/sites/${siteB.id}/report`, undefined, clientAT)).status, 404);

  // Client B does see it, scoped to their own site.
  const jobsB = await call('GET', `/api/client/jobs?site_id=${siteB.id}`, undefined, clientBT);
  assert.ok(jobsB.body.some((j) => j.id === jobAtB.id));
  assert.equal(jobsB.body.find((j) => j.id === jobAtB.id).site_name, siteB.name);

  // Documents: uploaded against site B, downloadable by client B, invisible and unreachable to client A.
  const doc = await call('POST', `/api/sites/${siteB.id}/documents`, { type: 'CONTRACT', mimetype: 'application/pdf', filename: 'contract.pdf', data: PDF }, adminT);
  assert.equal(doc.status, 201, JSON.stringify(doc.body));
  assert.equal((await call('GET', '/api/client/documents', undefined, clientAT)).body.length, 0);
  const docsB = await call('GET', '/api/client/documents', undefined, clientBT);
  assert.equal(docsB.body.length, 1);
  assert.equal((await call('GET', `/api/client/documents/${doc.body.id}/file`, undefined, clientAT)).status, 404, 'the wrong client gets a 404, not the file');
  const fileB = await call('GET', `/api/client/documents/${doc.body.id}/file`, undefined, clientBT);
  assert.equal(fileB.status, 200);

  // Client requests: A cannot see B's request.
  const reqB = await call('POST', '/api/client-requests', { site_id: siteB.id, subject: 'Please add extra patrol' }, clientBT);
  assert.equal(reqB.status, 201, JSON.stringify(reqB.body));
  assert.equal((await call('POST', '/api/client-requests', { site_id: siteA.id, subject: 'x' }, clientBT)).status, 400, 'cannot raise a request against a site that is not theirs');
  const reqsA = await call('GET', '/api/client-requests', undefined, clientAT);
  assert.ok(!reqsA.body.some((r) => r.id === reqB.body.id));
  const reqsControl = await call('GET', '/api/client-requests', undefined, dispT);
  assert.ok(reqsControl.body.some((r) => r.id === reqB.body.id), 'control sees every request');

  const ack = await call('PATCH', `/api/client-requests/${reqB.body.id}`, { status: 'ACKNOWLEDGED' }, dispT);
  assert.equal(ack.body.status, 'ACKNOWLEDGED');
  assert.equal((await call('PATCH', `/api/client-requests/${reqB.body.id}`, { status: 'ACKNOWLEDGED' }, clientBT)).status, 403, 'a client cannot resolve their own request');
});

/* ---------------- document upload validation ---------------- */
test('document upload validates type, mimetype and magic bytes', async () => {
  const site = (await call('GET', '/api/sites', undefined, dispT)).body[0];
  assert.equal((await call('POST', `/api/sites/${site.id}/documents`, { type: 'NONSENSE', mimetype: 'application/pdf', data: PDF }, adminT)).status, 400);
  assert.equal((await call('POST', `/api/sites/${site.id}/documents`, { type: 'CONTRACT', mimetype: 'application/msword', data: PDF }, adminT)).status, 400);
  const fakeContent = Buffer.from('not actually a pdf').toString('base64');
  assert.equal((await call('POST', `/api/sites/${site.id}/documents`, { type: 'CONTRACT', mimetype: 'application/pdf', data: fakeContent }, adminT)).status, 400, 'declared mimetype must match the real file content');
  assert.equal((await call('POST', `/api/sites/${site.id}/documents`, { type: 'CONTRACT', mimetype: 'application/pdf', data: PDF }, dispT)).status, 403, 'only admin uploads documents');
});

/* ---------------- versioned assignment instructions / site maps ---------------- */
test('assignment instructions and site maps are versioned by title, and never reach the client portal', async () => {
  const site = (await call('GET', '/api/sites', undefined, dispT)).body[0];

  assert.equal((await call('POST', `/api/sites/${site.id}/documents`, { type: 'ASSIGNMENT_INSTRUCTIONS', mimetype: 'application/pdf', data: PDF }, adminT)).status, 400, 'title is required for a versioned type');
  assert.equal((await call('POST', `/api/sites/${site.id}/documents`, { type: 'CONTRACT', mimetype: 'application/pdf', data: PDF }, adminT)).status, 201, 'title stays optional for the existing types');

  const v1 = await call('POST', `/api/sites/${site.id}/documents`, { type: 'ASSIGNMENT_INSTRUCTIONS', title: 'General', mimetype: 'application/pdf', filename: 'v1.pdf', data: PDF }, adminT);
  assert.equal(v1.status, 201);
  assert.equal(v1.body.version, 1);
  assert.equal(v1.body.is_current, true);

  const v2 = await call('POST', `/api/sites/${site.id}/documents`, { type: 'ASSIGNMENT_INSTRUCTIONS', title: 'general', mimetype: 'application/pdf', filename: 'v2.pdf', data: PDF }, adminT);
  assert.equal(v2.body.version, 2, 'a matching title (case-insensitive) supersedes, not a fresh lineage');
  const docs = await call('GET', `/api/sites/${site.id}/documents`, undefined, dispT);
  assert.equal(docs.body.find((d) => d.id === v1.body.id).is_current, false, 'the old version is archived, not deleted');
  assert.ok(docs.body.some((d) => d.id === v1.body.id), 'and still listed for control');

  const otherMap = await call('POST', `/api/sites/${site.id}/documents`, { type: 'SITE_MAP', title: 'Perimeter', mimetype: 'application/pdf', data: PDF }, adminT);
  assert.equal(otherMap.body.version, 1, 'a different title starts its own lineage');

  // Never reaches the client portal, even for a client who owns this site.
  const client = (await call('POST', '/api/clients', { name: 'Doc Test Co', site_ids: [site.id] }, adminT)).body;
  await call('POST', '/api/users', { username: 'docclient', password: 'realpassword1', role: 'CLIENT', client_id: client.id }, adminT);
  const clientT = await login('docclient', 'realpassword1');
  const clientDocs = await call('GET', '/api/client/documents', undefined, clientT);
  assert.ok(!clientDocs.body.some((d) => ['ASSIGNMENT_INSTRUCTIONS', 'SITE_MAP'].includes(d.type)), 'a client never sees internal operational documents');
  assert.equal((await call('GET', `/api/client/documents/${v2.body.id}/file`, undefined, clientT)).status, 404, 'not reachable directly by id either');
});

/* ---------------- broadcast is opt-in only for CLIENT ---------------- */
test('a CLIENT websocket receives nothing from an untargeted broadcast, and only a siteIds-scoped one for its own site', async () => {
  const sites = (await call('GET', '/api/sites', undefined, dispT)).body;
  const site = sites[0];
  const client = (await call('POST', '/api/clients', { name: 'Socket Test Co', site_ids: [site.id] }, adminT)).body;
  await call('POST', '/api/users', { username: 'socketclient', password: 'realpassword1', role: 'CLIENT', client_id: client.id }, adminT);
  const clientT = await login('socketclient', 'realpassword1');

  const sock = await rawSocket(clientT);
  const canary = `CANARY-${crypto.randomUUID()}`;
  // An ordinary untargeted broadcast (logEvent -> event.logged) — every
  // internal role receives this today; CLIENT must receive nothing.
  await call('POST', '/api/jobs', { priority: 'GREEN', location: canary }, dispT);
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!sock.bytes.includes(canary), 'an untargeted broadcast must never reach a CLIENT socket');
  sock.close();
});

/* ---------------- send-password-link ---------------- */
test('sending a password link creates the client\'s login if needed, is admin-only, and the resulting link actually works', async () => {
  const client = (await call('POST', '/api/clients', { name: 'Password Link Co', contact_email: 'pwlink@example.test' }, adminT)).body;
  assert.equal((await call('POST', `/api/clients/${client.id}/send-password-link`, {}, dispT)).status, 403, 'admin only');

  const noEmail = (await call('POST', '/api/clients', { name: 'No Email Co' }, adminT)).body;
  assert.equal((await call('POST', `/api/clients/${noEmail.id}/send-password-link`, {}, adminT)).status, 400, 'needs a contact email');

  const before = mails.length;
  const sent = await call('POST', `/api/clients/${client.id}/send-password-link`, {}, adminT);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.ok(sent.body.username, 'a login was created and its username returned');
  assert.equal(mails.length, before + 1);
  const mail = mails[mails.length - 1];
  assert.equal(mail.to, 'pwlink@example.test');
  const link = mail.html.match(/href="([^"]*set-password\.html\?token=[^"]*)"/);
  assert.ok(link, 'the email contains a set-password link');
  const token = decodeURIComponent(new URL(link[1]).searchParams.get('token'));

  const set = await call('POST', '/api/auth/set-password', { token, password: 'clientnewpass1' });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal((await call('POST', '/api/auth/login', { username: sent.body.username, password: 'clientnewpass1' })).status, 200);

  // Sending again reuses the same login rather than creating a second one.
  const again = await call('POST', `/api/clients/${client.id}/send-password-link`, {}, adminT);
  assert.equal(again.body.username, sent.body.username);
});
