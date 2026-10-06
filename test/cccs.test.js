/* CCCS test suite — node --test */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const crypto = require('node:crypto');

process.env.PORT = process.env.TEST_PORT || '4011';
process.env.AUTH_SECRET = 'test-secret-not-for-production';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';   // tests run against a clean in-memory state
process.env.WELFARE_TICK_MS = '200';
process.env.WELFARE_WARN_S = '2';
process.env.PATROL_SCHEDULE_TICK_MS = '3600000'; // tests drive this by calling app.patrolScheduleTick() directly
process.env.VISIT_MISSED_GRACE_MIN = '120';

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;

/* ---- helpers ---- */
async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;

/* Minimal RFC6455 client so tests exercise the real socket path. */
const m_use = (m) => { m._used = true; };

function wsClient(token) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(Number(process.env.PORT), '127.0.0.1', () => {
      sock.write(
        `GET /ws?token=${encodeURIComponent(token)} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    let handshaken = false, buf = Buffer.alloc(0);
    const listeners = [];
    const client = {
      messages: [],
      send(type, payload) {
        const data = Buffer.from(JSON.stringify({ type, payload }));
        const mask = crypto.randomBytes(4);
        let header;
        if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
        else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0xfe; header.writeUInt16BE(data.length, 2); }
        const masked = Buffer.from(data);
        for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
        sock.write(Buffer.concat([header, mask, masked]));
      },
      waitFor(type, timeout = 4000) {
        const hit = client.messages.find((m) => m.type === type && !m._used);
        if (hit) { m_use(hit); return Promise.resolve(hit.payload); }
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), timeout);
          listeners.push({ type, res: (p) => { clearTimeout(timer); res(p); } });
        });
      },
      async waitUntil(type, pred, timeout = 4000) {
        const deadline = Date.now() + timeout;
        for (;;) {
          const p = await client.waitFor(type, Math.max(50, deadline - Date.now()));
          if (pred(p)) return p;
          if (Date.now() > deadline) throw new Error(`timeout waiting for matching ${type}`);
        }
      },
      close: () => sock.destroy(),
    };
    sock.on('error', reject);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshaken) {
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) return;
        const head = buf.subarray(0, end).toString();
        if (!head.includes('101')) return reject(new Error('handshake failed: ' + head.split('\r\n')[0]));
        buf = buf.subarray(end + 4);
        handshaken = true;
        resolve(client);
      }
      for (;;) {
        if (buf.length < 2) return;
        let len = buf[1] & 0x7f, offset = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); offset = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
        if (buf.length < offset + len) return;
        const payload = buf.subarray(offset, offset + len).toString();
        buf = buf.subarray(offset + len);
        let msg; try { msg = JSON.parse(payload); } catch { continue; }
        client.messages.push(msg);
        for (let i = listeners.length - 1; i >= 0; i--) {
          if (listeners[i].type === msg.type) { m_use(msg); listeners[i].res(msg.payload); listeners.splice(i, 1); break; }
        }
      }
    });
  });
}

let adminT, dispT, danT, ellieT, ryanT, mdtT;
let danId, ellieId, ryanId, mdt1Id;
const mails = [];

before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dispT = await login('dispatcher', 'dispatch123');
  danT = await login('dwhitfield', 'field123');
  ellieT = await login('emarsh', 'field123');
  ryanT = await login('rcole', 'field123');
  mdtT = await login('mdt001', 'mdt123');

  const personnel = (await call('GET', '/api/personnel', undefined, dispT)).body;
  danId = personnel.find((p) => p.name === 'Dan Whitfield').id;
  ellieId = personnel.find((p) => p.name === 'Ellie Marsh').id;
  ryanId = personnel.find((p) => p.name === 'Ryan Cole').id;
  mdt1Id = (await call('GET', '/api/mdts', undefined, dispT)).body.find((m) => m.mdt_code === 'MDT-001').id;
  app.mailer.send = async (to, subject, html, opts = {}) => { mails.push({ to, subject, html, attachments: opts.attachments || [] }); return { ok: true }; };
});
after(() => {
  app.server.closeAllConnections?.();
  app.server.close();
});

/* ---------------- auth ---------------- */
test('rejects bad credentials and unauthenticated API calls', async () => {
  assert.equal((await call('POST', '/api/auth/login', { username: 'admin', password: 'wrong' })).status, 401);
  assert.equal((await call('GET', '/api/mdts')).status, 401);
  assert.equal((await call('GET', '/api/mdts', undefined, dispT)).status, 200);
});

test('role permissions are enforced', async () => {
  assert.equal((await call('POST', '/api/mdts', { mdt_code: 'MDT-999' }, danT)).status, 403);
  assert.equal((await call('POST', '/api/users', { username: 'x', password: 'password1', role: 'DISPATCHER' }, dispT)).status, 403);
});

test('a "set your password" link signs in with the new password, rejects a bad/expired token, and cannot be reused', async () => {
  const created = await call('POST', '/api/users', { username: 'set-pw-test', password: 'temporary1', role: 'FIELD_USER' }, adminT);
  const userId = created.body.id;

  assert.equal((await call('POST', '/api/auth/set-password', { token: 'not-a-real-token', password: 'brandnew1' })).status, 400);
  assert.equal((await call('POST', '/api/auth/set-password', { token: app.sign({ purpose: 'something_else', user_id: userId, iat: Date.now(), exp: Date.now() + 100000 }), password: 'brandnew1' })).status, 400, 'wrong purpose is refused, not just any signed token');
  assert.equal((await call('POST', '/api/auth/set-password', { token: app.sign({ purpose: 'set_password', user_id: userId, iat: Date.now(), exp: Date.now() - 1000 }), password: 'brandnew1' })).status, 400, 'expired');

  const goodToken = app.sign({ purpose: 'set_password', user_id: userId, iat: Date.now(), exp: Date.now() + 48 * 3600000 });
  assert.equal((await call('POST', '/api/auth/set-password', { token: goodToken, password: 'short' })).status, 400, 'too short');
  const set = await call('POST', '/api/auth/set-password', { token: goodToken, password: 'brandnew1' });
  assert.equal(set.status, 200, JSON.stringify(set.body));

  assert.equal((await call('POST', '/api/auth/login', { username: 'set-pw-test', password: 'temporary1' })).status, 401, 'the old password no longer works');
  assert.equal((await call('POST', '/api/auth/login', { username: 'set-pw-test', password: 'brandnew1' })).status, 200, 'the new one does');

  assert.equal((await call('POST', '/api/auth/set-password', { token: goodToken, password: 'anothernew1' })).status, 400, 'the same link cannot be used a second time');

  await call('DELETE', `/api/users/${userId}`, undefined, adminT);
});

test('a welcome link explains Microsoft SSO by whichever of email/SMS is on file', async () => {
  const noContact = await call('POST', '/api/users', { username: 'welcome-none', password: 'password1', role: 'DISPATCHER' }, adminT);
  assert.equal((await call('POST', `/api/users/${noContact.body.id}/send-welcome-link`, {}, adminT)).status, 400, 'nothing to send to');
  assert.equal((await call('POST', `/api/users/${noContact.body.id}/send-welcome-link`, {}, dispT)).status, 403, 'admin only');

  const before = mails.length;
  const emailOnly = await call('POST', '/api/users', { username: 'welcome-email', password: 'password1', role: 'DISPATCHER', email: 'welcome-email@example.test' }, adminT);
  const r1 = await call('POST', `/api/users/${emailOnly.body.id}/send-welcome-link`, {}, adminT);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.body.email, true);
  assert.equal(r1.body.sms, false, 'no personnel link, so no phone to text');
  assert.equal(mails.length, before + 1);
  assert.equal(mails[mails.length - 1].to, 'welcome-email@example.test');

  // Dan is personnel-linked with a contact_phone — both channels should fire.
  const danUser = (await call('GET', '/api/users', undefined, adminT)).body.find((u) => u.username === 'dwhitfield');
  await call('PATCH', `/api/users/${danUser.id}`, { email: 'dan.welcome@example.test' }, adminT);
  await call('PATCH', `/api/personnel/${danId}`, { contact_phone: '07700900555' }, adminT);
  const r2 = await call('POST', `/api/users/${danUser.id}/send-welcome-link`, {}, adminT);
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal(r2.body.email, true);
  assert.equal(r2.body.sms, true);

  await call('DELETE', `/api/users/${noContact.body.id}`, undefined, adminT);
  await call('DELETE', `/api/users/${emailOnly.body.id}`, undefined, adminT);
});

/* ---------------- MDTs ---------------- */
test('creates an MDT with a unique code', async () => {
  const res = await call('POST', '/api/mdts', { mdt_code: 'MDT-900', serial: 'SN-900' }, adminT);
  assert.equal(res.status, 201);
  assert.equal(res.body.mdt_code, 'MDT-900');
});

test('rejects a duplicate MDT code', async () => {
  const res = await call('POST', '/api/mdts', { mdt_code: 'MDT-900' }, adminT);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /already exists/);
});

test('rejects an MDT with no code', async () => {
  assert.equal((await call('POST', '/api/mdts', {}, adminT)).status, 400);
});

/* ---------------- assignment ---------------- */
test('assigns an MDT to a call sign, then removes it', async () => {
  const callsigns = await call('GET', '/api/callsigns', undefined, dispT);
  const m202 = callsigns.body.find((c) => c.name === 'M202');
  assert.equal((await call('POST', `/api/callsigns/${m202.id}/assign`, { mdt: 'MDT-900' }, dispT)).status, 200);

  let after = (await call('GET', '/api/callsigns', undefined, dispT)).body.find((c) => c.name === 'M202');
  assert.ok(after.mdts.some((m) => m.mdt_code === 'MDT-900'));

  assert.equal((await call('DELETE', `/api/callsigns/${m202.id}/assign`, { mdt: 'MDT-900' }, dispT)).status, 200);
  after = (await call('GET', '/api/callsigns', undefined, dispT)).body.find((c) => c.name === 'M202');
  assert.ok(!after.mdts.some((m) => m.mdt_code === 'MDT-900'));
});

/* ---------------- realtime: MDT attach + duty status ---------------- */
test('MDT registers over WebSocket and control sees the duty status change', async () => {
  const mdt = await wsClient(mdtT);
  const control = await wsClient(dispT);
  mdt.send('mdt.attach', { mdt_code: 'MDT-001' });
  const attached = await mdt.waitFor('mdt.attached');
  assert.equal(attached.mdt_code, 'MDT-001');
  assert.equal(attached.connected, true);

  await call('POST', `/api/mdts/${mdt1Id}/duty-status`, { status: 'BUSY' }, mdtT);
  const seen = await control.waitUntil('mdt.status_changed', (p) => p.duty_status === 'BUSY');
  assert.equal(seen.duty_status, 'BUSY');
  mdt.close(); control.close();
});

test('crew can sign in and out of a vehicle terminal, capped at three', async () => {
  await call('POST', `/api/mdts/${mdt1Id}/crew`, { name: 'Temp Crew A' }, mdtT);
  const second = await call('POST', `/api/mdts/${mdt1Id}/crew`, { name: 'Temp Crew B' }, mdtT);
  assert.equal(second.status, 201);
  assert.equal(second.body.crew.length, 2);

  await call('POST', `/api/mdts/${mdt1Id}/crew`, { name: 'Temp Crew C' }, mdtT);
  assert.equal((await call('POST', `/api/mdts/${mdt1Id}/crew`, { name: 'Temp Crew D' }, mdtT)).status, 409);

  const crewId = second.body.crew[1].id;
  const after = await call('DELETE', `/api/mdts/${mdt1Id}/crew/${crewId}`, undefined, mdtT);
  assert.equal(after.body.crew.length, 2);
});

test('an MDT terminal cannot act for a different terminal', async () => {
  const other = (await call('GET', '/api/mdts', undefined, dispT)).body.find((m) => m.mdt_code === 'MDT-002');
  assert.equal((await call('POST', `/api/mdts/${other.id}/duty-status`, { status: 'BUSY' }, mdtT)).status, 403);
});

/* ---------------- jobs ---------------- */
test('job is created, dispatched to a call sign, received by personnel and MDT, and acknowledged', async () => {
  const officer = await wsClient(danT), mdt = await wsClient(mdtT), control = await wsClient(dispT);
  mdt.send('mdt.attach', { mdt_code: 'MDT-001' }); await mdt.waitFor('mdt.attached');

  const job = await call('POST', '/api/jobs', {
    incident_type: 'Alarm activation', priority: 'RED', location: '123 Example Street',
    description: 'Zone 3 activation', caller: 'Monitoring centre',
  }, dispT);
  assert.equal(job.status, 201);
  assert.equal(job.body.status, 'CREATED');

  const dispatched = await call('POST', `/api/jobs/${job.body.id}/assign`, { resources: ['P101'] }, dispT);
  assert.equal(dispatched.body.status, 'DISPATCHED');
  assert.ok(dispatched.body.resources.some((r) => r.personnel === 'Dan Whitfield'));
  assert.ok(dispatched.body.resources.some((r) => r.mdt === 'MDT-001'));

  const onOfficer = await officer.waitFor('job.assigned_to_you');
  assert.equal(onOfficer.reference, job.body.reference);
  const onMdt = await mdt.waitFor('job.assigned_to_you');
  assert.equal(onMdt.priority, 'RED');

  const acked = await call('POST', `/api/jobs/${job.body.id}/ack`, {}, danT);
  assert.equal(acked.body.status, 'ACKNOWLEDGED');
  const ackSeen = await control.waitFor('job.acknowledged');
  assert.equal(ackSeen.by, 'Dan Whitfield');

  const enroute = await call('PATCH', `/api/jobs/${job.body.id}`, { status: 'EN_ROUTE' }, danT);
  assert.equal(enroute.body.status, 'EN_ROUTE');
  assert.equal((await call('PATCH', `/api/jobs/${job.body.id}`, { status: 'NONSENSE' }, dispT)).status, 400);

  officer.close(); mdt.close(); control.close();
});

test('a field user cannot change the status of a job they were not given', async () => {
  const job = await call('POST', '/api/jobs', { priority: 'GREEN', location: 'Elsewhere' }, dispT);
  await call('POST', `/api/jobs/${job.body.id}/assign`, { resources: ['P103'] }, dispT);
  assert.equal((await call('PATCH', `/api/jobs/${job.body.id}`, { status: 'ON_SCENE' }, danT)).status, 403);
});

test('a job checklist item can be completed with notes, and a photo attached', async () => {
  const job = await call('POST', '/api/jobs', {
    priority: 'AMBER', location: 'Carlton Retail Centre', incident_type: 'Patrol visit',
  }, dispT);
  assert.ok(job.body.checklist.length > 0, 'a default checklist is instantiated');
  await call('POST', `/api/jobs/${job.body.id}/assign`, { resources: ['P101'] }, dispT);

  const item = job.body.checklist[0];
  const updated = await call('PATCH', `/api/jobs/${job.body.id}/checklist/${item.id}`, { status: 'COMPLETE', notes: 'All clear' }, danT);
  assert.equal(updated.status, 200);
  const savedItem = updated.body.checklist.find((x) => x.id === item.id);
  assert.equal(savedItem.status, 'COMPLETE');
  assert.equal(savedItem.notes, 'All clear');
  assert.ok(savedItem.completed_at);

  const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const media = await call('POST', `/api/jobs/${job.body.id}/media`, { mimetype: 'image/png', data: tinyPngBase64, checklist_item_id: item.id }, danT);
  assert.equal(media.status, 201);
  assert.equal(media.body.checklist_item_id, item.id);

  assert.equal((await call('PATCH', `/api/jobs/${job.body.id}/checklist/${item.id}`, { status: 'COMPLETE' }, ellieT)).status, 403,
    'a field user not assigned to the job cannot touch its checklist');
});

test('completing a job generates a resolution report', async () => {
  const job = await call('POST', '/api/jobs', { priority: 'GREEN', location: 'Ashcroft House' }, dispT);
  await call('POST', `/api/jobs/${job.body.id}/assign`, { resources: ['P101'] }, dispT);
  const done = await call('PATCH', `/api/jobs/${job.body.id}`, { status: 'COMPLETED' }, dispT);
  assert.equal(done.body.status, 'COMPLETED');
  assert.ok(done.body.resolution_report_html.includes(job.body.reference));
});

test('a resource can be stood down from a job', async () => {
  const job = await call('POST', '/api/jobs', { priority: 'GREEN', location: 'Northgate Distribution' }, dispT);
  await call('POST', `/api/jobs/${job.body.id}/assign`, { resources: ['P101'] }, dispT);
  const stood = await call('POST', `/api/jobs/${job.body.id}/stand-down`, { personnel: danId }, dispT);
  assert.equal(stood.status, 200);
  assert.ok(!stood.body.resources.some((r) => r.personnel === 'Dan Whitfield'));
  assert.ok(stood.body.resources.some((r) => r.mdt === 'MDT-001'), 'the MDT is untouched');
});

/* ---------------- GuardM8 integration ---------------- */
test('GuardM8 can push a job with a shared secret, and retries are idempotent', async () => {
  process.env.GUARDM8_SECRET = 'test-guardm8-secret';
  const bad = await fetch(BASE + '/api/integrations/guardm8/jobs', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ location: 'Somewhere', external_ref: 'g-1' }),
  });
  assert.equal(bad.status, 401);

  const good = await fetch(BASE + '/api/integrations/guardm8/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-guardm8-secret': 'test-guardm8-secret' },
    body: JSON.stringify({ location: 'Somewhere', priority: 'HIGH', external_ref: 'g-1' }),
  });
  const goodBody = await good.json();
  assert.equal(good.status, 201);
  assert.equal(goodBody.priority, 'AMBER');

  const retry = await fetch(BASE + '/api/integrations/guardm8/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-guardm8-secret': 'test-guardm8-secret' },
    body: JSON.stringify({ location: 'Somewhere', priority: 'HIGH', external_ref: 'g-1' }),
  });
  const retryBody = await retry.json();
  assert.equal(retry.status, 200);
  assert.equal(retryBody.id, goodBody.id, 'the same external_ref does not create a second job');
});

/* ---------------- AURA integration ---------------- */
test('AURA can push a job with a shared secret, and retries are idempotent', async () => {
  process.env.AURA_SECRET = 'test-aura-secret';
  const bad = await fetch(BASE + '/api/integrations/aura/jobs', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ location: 'Somewhere', external_ref: 'a-1' }),
  });
  assert.equal(bad.status, 401);

  const good = await fetch(BASE + '/api/integrations/aura/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aura-secret': 'test-aura-secret' },
    body: JSON.stringify({ location: 'Somewhere', priority: 'CRITICAL', external_ref: 'a-1' }),
  });
  const goodBody = await good.json();
  assert.equal(good.status, 201);
  assert.equal(goodBody.priority, 'RED');
  assert.equal(goodBody.caller, 'AURA');

  const retry = await fetch(BASE + '/api/integrations/aura/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aura-secret': 'test-aura-secret' },
    body: JSON.stringify({ location: 'Somewhere', priority: 'CRITICAL', external_ref: 'a-1' }),
  });
  const retryBody = await retry.json();
  assert.equal(retry.status, 200);
  assert.equal(retryBody.id, goodBody.id, 'the same external_ref does not create a second job');
});
test('GuardM8 and AURA using the same external_ref never collide with each other\'s job', async () => {
  process.env.GUARDM8_SECRET = 'test-guardm8-secret';
  process.env.AURA_SECRET = 'test-aura-secret';
  const fromGuardM8 = await fetch(BASE + '/api/integrations/guardm8/jobs', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-guardm8-secret': 'test-guardm8-secret' },
    body: JSON.stringify({ location: 'Dual Site', external_ref: 'shared-ref-1' }),
  });
  const fromAura = await fetch(BASE + '/api/integrations/aura/jobs', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-aura-secret': 'test-aura-secret' },
    body: JSON.stringify({ location: 'Dual Site', external_ref: 'shared-ref-1' }),
  });
  assert.equal(fromGuardM8.status, 201);
  assert.equal(fromAura.status, 201);
  const guardm8Body = await fromGuardM8.json(), auraBody = await fromAura.json();
  assert.notEqual(guardm8Body.id, auraBody.id, 'different sources with the same external_ref still get separate jobs');
});

/* ---------------- emergency ---------------- */
test('a field user raises an emergency, control is alerted and can acknowledge and reset it', async () => {
  const officer = await wsClient(danT), control = await wsClient(dispT);

  const ev = await call('POST', '/api/emergency', {}, danT);
  assert.equal(ev.status, 201);
  const alert = await control.waitFor('emergency.activated');
  assert.equal(alert.callsign, 'P101');
  assert.equal(alert.state, 'ACTIVE');
  assert.equal(alert.personnel_id, danId);

  const acked = await call('POST', `/api/emergency/${ev.body.id}/ack`, {}, dispT);
  assert.equal(acked.body.state, 'ACKNOWLEDGED');
  const resolved = await call('POST', `/api/emergency/${ev.body.id}/resolve`, {}, dispT);
  assert.equal(resolved.body.state, 'RESOLVED');
  officer.close(); control.close();
});

test('a field user cannot acknowledge their own emergency', async () => {
  const ev = await call('POST', '/api/emergency', {}, danT);
  assert.equal((await call('POST', `/api/emergency/${ev.body.id}/ack`, {}, danT)).status, 403);
  await call('POST', `/api/emergency/${ev.body.id}/resolve`, {}, dispT);
});

test('an emergency auto-creates a backup job', async () => {
  const ev = await call('POST', '/api/emergency', {}, ellieT);
  const job = (await call('GET', '/api/jobs', undefined, dispT)).body.find((j) => j.id === ev.body.job_id);
  assert.ok(job, 'a job was created for the emergency');
  assert.equal(job.priority, 'RED');
  await call('POST', `/api/emergency/${ev.body.id}/ack`, {}, dispT);
  await call('POST', `/api/emergency/${ev.body.id}/resolve`, {}, dispT);
});

/* ---------------- messaging + audit ---------------- */
test('control messages a field user and the event is written to the audit log', async () => {
  const officer = await wsClient(danT);
  await call('POST', '/api/messages', { to_personnel: danId, body: 'RVP at the junction' }, dispT);
  const msg = await officer.waitFor('message.received');
  assert.equal(msg.body, 'RVP at the junction');
  const events = await call('GET', '/api/events?type=message', undefined, dispT);
  assert.ok(events.body.some((e) => e.summary.includes('RVP at the junction')));
  officer.close();
});

test('websocket upgrade is refused without a valid token', async () => {
  await assert.rejects(wsClient('not-a-real-token'), /handshake failed/);
});

/* ---------------- lone worker welfare ---------------- */
test('welfare timer starts, warns, and can be checked in', async () => {
  const started = await call('POST', `/api/personnel/${danId}/welfare`, { interval_s: 30, note: 'Internal check, Meridian' }, danT);
  assert.equal(started.status, 200);
  assert.ok(started.body.welfare_due_at);

  const checked = await call('POST', `/api/personnel/${danId}/welfare/check`, {}, danT);
  assert.equal(checked.status, 200);
  await call('DELETE', `/api/personnel/${danId}/welfare`, {}, danT);
});

test('an overdue welfare timer raises an alarm at control with the last known position', async () => {
  const control = await wsClient(dispT);
  await call('POST', `/api/personnel/${ellieId}/welfare`, { interval_s: 30, note: 'Roof check' }, ellieT);
  const p = app.db.personnel.find((x) => x.id === ellieId);
  p.welfare_due_at = new Date(Date.now() - 1000).toISOString();

  const alarm = await control.waitFor('welfare.overdue', 5000);
  assert.equal(alarm.callsign, 'P102');
  assert.equal(alarm.kind, 'WELFARE');
  assert.equal(alarm.note, 'Roof check');

  const acked = await call('POST', `/api/emergency/${alarm.id}/ack`, {}, dispT);
  assert.equal(acked.body.state, 'ACKNOWLEDGED');
  await call('POST', `/api/emergency/${alarm.id}/resolve`, {}, dispT);
  control.close();
});

test('welfare timers reject silly intervals and cannot be set for someone else', async () => {
  assert.equal((await call('POST', `/api/personnel/${danId}/welfare`, { interval_s: 5 }, danT)).status, 400);
  assert.equal((await call('POST', `/api/personnel/${danId}/welfare`, { interval_s: 99999 }, danT)).status, 400);
  assert.equal((await call('POST', `/api/personnel/${ellieId}/welfare`, { interval_s: 300 }, danT)).status, 403);
  assert.equal((await call('POST', `/api/personnel/${ryanId}/welfare/check`, {}, danT)).status, 403);
});

test('checking in clears an alarm that has already been raised', async () => {
  const control = await wsClient(dispT);
  await call('POST', `/api/personnel/${ryanId}/welfare`, { interval_s: 60 }, ryanT);
  const p = app.db.personnel.find((x) => x.id === ryanId);
  p.welfare_due_at = new Date(Date.now() - 1000).toISOString();
  const alarm = await control.waitFor('welfare.overdue', 5000);

  await call('POST', `/api/personnel/${ryanId}/welfare`, { interval_s: 300 }, ryanT);
  await call('POST', `/api/personnel/${ryanId}/welfare/check`, {}, ryanT);
  const cleared = app.db.emergency_events.find((e) => e.id === alarm.id);
  assert.equal(cleared.state, 'RESOLVED');
  await call('DELETE', `/api/personnel/${ryanId}/welfare`, {}, ryanT);
  control.close();
});

/* ---------------- sites ---------------- */
test('jobs can be raised against a contracted site and inherit its details', async () => {
  const sites = await call('GET', '/api/sites', undefined, dispT);
  assert.ok(sites.body.length >= 4);
  const meridian = sites.body.find((x) => x.name === 'Meridian Business Park');

  const job = await call('POST', '/api/jobs', { priority: 'AMBER', incident_type: 'Alarm activation', site: meridian.id }, dispT);
  assert.equal(job.status, 201);
  assert.equal(job.body.site_id, meridian.id);
  assert.equal(job.body.keyholder, meridian.keyholder);
  assert.equal(job.body.lat, meridian.lat, 'job inherits the site position');

  assert.equal((await call('POST', '/api/jobs', { priority: 'AMBER' }, dispT)).status, 400);
  assert.equal((await call('POST', '/api/sites', { name: 'Meridian Business Park' }, dispT)).status, 409);
});

test('a site carries code/postcode/timezone/risk level/access instructions, and the control-room flag', async () => {
  const bad = await call('POST', '/api/sites', { name: 'Bad Risk Site', risk_level: 'EXTREME' }, dispT);
  assert.equal(bad.status, 400, 'risk_level must be one of the known values');

  const created = await call('POST', '/api/sites', {
    name: 'Northgate HQ', code: 'NHQ', postcode: 'NG1 1AA', timezone: 'Europe/London',
    risk_level: 'HIGH', access_instructions: 'Ring bell twice, ask for duty manager', is_control_room: true,
  }, dispT);
  assert.equal(created.status, 201);
  assert.equal(created.body.code, 'NHQ');
  assert.equal(created.body.postcode, 'NG1 1AA');
  assert.equal(created.body.risk_level, 'HIGH');
  assert.equal(created.body.is_control_room, true);

  const updated = await call('PATCH', `/api/sites/${created.body.id}`, { risk_level: null, timezone: 'Europe/Dublin' }, adminT);
  assert.equal(updated.body.risk_level, null, 'can be cleared back to unset');
  assert.equal(updated.body.timezone, 'Europe/Dublin');
  assert.equal((await call('PATCH', `/api/sites/${created.body.id}`, { risk_level: 'EXTREME' }, adminT)).status, 400);
  await call('DELETE', `/api/sites/${created.body.id}`, undefined, adminT);
});

/* ---------------- patrol schedules and site visits ---------------- */
test('a patrol schedule is created and the tick turns a due occurrence into a scheduled visit', async () => {
  const sites = await call('GET', '/api/sites', undefined, dispT);
  const carlton = sites.body.find((x) => x.name === 'Carlton Retail Centre');

  const sched = await call('POST', '/api/patrol-schedules', { site_id: carlton.id, label: 'Hourly check', interval_hours: 1 }, dispT);
  assert.equal(sched.status, 201);
  assert.equal(sched.body.site_name, 'Carlton Retail Centre');
  assert.equal((await call('POST', '/api/patrol-schedules', { site_id: carlton.id, label: 'No cadence' }, dispT)).status, 400);

  app.patrolScheduleTick();
  const visits = (await call('GET', '/api/site-visits', undefined, dispT)).body.filter((v) => v.schedule_id === sched.body.id);
  assert.equal(visits.length, 1, 'one visit created for the due schedule');
  assert.equal(visits[0].status, 'SCHEDULED');
  assert.ok(visits[0].checklist.length > 0, 'checklist instantiated from the site template');

  app.patrolScheduleTick();
  const stillOne = (await call('GET', '/api/site-visits', undefined, dispT)).body.filter((v) => v.schedule_id === sched.body.id);
  assert.equal(stillOne.length, 1, 'a second tick does not create a duplicate while one is still open');
});

test('a site visit is assigned, acknowledged, walked through checklist and photo, and completed with a report', async () => {
  const sites = await call('GET', '/api/sites', undefined, dispT);
  const northgate = sites.body.find((x) => x.name === 'Northgate Distribution');

  const created = await call('POST', '/api/site-visits', { site_id: northgate.id }, dispT);
  assert.equal(created.status, 201);
  const visitId = created.body.id;

  const assigned = await call('POST', `/api/site-visits/${visitId}/assign`, { personnel: danId }, dispT);
  assert.equal(assigned.body.status, 'DISPATCHED');
  assert.ok(assigned.body.resources.some((r) => r.personnel === 'Dan Whitfield' && r.primary));
  assert.equal((await call('POST', `/api/site-visits/${visitId}/assign`, { personnel: danId }, dispT)).status, 409, 'cannot double-assign the same person');

  const acked = await call('POST', `/api/site-visits/${visitId}/ack`, {}, danT);
  assert.equal(acked.status, 200);
  assert.equal(acked.body.status, 'ACKNOWLEDGED');
  assert.equal((await call('POST', `/api/site-visits/${visitId}/ack`, {}, ellieT)).status, 403, 'not assigned to this visit');

  const item = acked.body.checklist[0];
  const checked = await call('PATCH', `/api/site-visits/${visitId}/checklist/${item.id}`, { status: 'COMPLETE', notes: 'Clear' }, danT);
  assert.equal(checked.body.checklist.find((x) => x.id === item.id).status, 'COMPLETE');

  const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const media = await call('POST', `/api/site-visits/${visitId}/media`, { mimetype: 'image/png', data: tinyPngBase64 }, danT);
  assert.equal(media.status, 201);

  const enroute = await call('PATCH', `/api/site-visits/${visitId}`, { status: 'EN_ROUTE' }, danT);
  assert.equal(enroute.body.status, 'EN_ROUTE');
  const completed = await call('PATCH', `/api/site-visits/${visitId}`, { status: 'COMPLETED' }, danT);
  assert.equal(completed.body.status, 'COMPLETED');
  assert.ok(completed.body.report_html.includes(completed.body.reference));

  const report = await fetch(BASE + `/api/site-visits/${visitId}/report`, { headers: { authorization: `Bearer ${dispT}` } });
  assert.equal(report.status, 200);
  assert.ok((await report.text()).includes(completed.body.reference));
});

test('a person can be stood down from a site visit', async () => {
  const sites = await call('GET', '/api/sites', undefined, dispT);
  const meridian = sites.body.find((x) => x.name === 'Meridian Business Park');
  const visit = await call('POST', '/api/site-visits', { site_id: meridian.id }, dispT);
  await call('POST', `/api/site-visits/${visit.body.id}/assign`, { personnel: ellieId }, dispT);

  const stood = await call('POST', `/api/site-visits/${visit.body.id}/stand-down`, { personnel: ellieId }, dispT);
  assert.equal(stood.status, 200);
  assert.equal(stood.body.resources.length, 0);
  assert.equal(stood.body.status, 'SCHEDULED', 'reverts to scheduled once nobody is assigned');
  assert.equal((await call('POST', `/api/site-visits/${visit.body.id}/stand-down`, { personnel: ellieId }, dispT)).status, 404);
});

test('a site with an open patrol schedule cannot be deleted', async () => {
  const sites = await call('GET', '/api/sites', undefined, dispT);
  const carlton = sites.body.find((x) => x.name === 'Carlton Retail Centre');
  assert.equal((await call('DELETE', `/api/sites/${carlton.id}`, undefined, adminT)).status, 409);
});

test('a scheduled visit nobody dispatches in time is marked missed', async () => {
  const sites = await call('GET', '/api/sites', undefined, dispT);
  const ashcroft = sites.body.find((x) => x.name === 'Ashcroft House');
  const visit = await call('POST', '/api/site-visits', { site_id: ashcroft.id, scheduled_for: new Date(Date.now() - 3 * 3600000).toISOString() }, dispT);

  app.patrolScheduleTick();
  const after = (await call('GET', '/api/site-visits', undefined, dispT)).body.find((v) => v.id === visit.body.id);
  assert.equal(after.status, 'MISSED');
  assert.ok(after.missed_at);
});

/* ---------------- HR rota: personnel CRUD ---------------- */
test('personnel can be created, updated and deleted, with a unique employee number', async () => {
  const created = await call('POST', '/api/personnel', { name: 'Robin Vance', rank: 'Officer' }, adminT);
  assert.equal(created.status, 201);
  assert.equal(created.body.employment_status, 'ACTIVE');
  assert.equal((await call('POST', '/api/personnel', { name: 'No name' }, dispT)).status, 403, 'only admin creates personnel');

  const patched = await call('PATCH', `/api/personnel/${created.body.id}`, { contact_phone: '07700900321', employment_status: 'LEAVE' }, adminT);
  assert.equal(patched.body.contact_phone, '07700900321');
  assert.equal(patched.body.employment_status, 'LEAVE');
  assert.equal((await call('PATCH', `/api/personnel/${created.body.id}`, { employment_status: 'NONSENSE' }, adminT)).status, 400);

  const a = await call('POST', '/api/personnel', { name: 'Dup A', employee_no: 'EMP-100' }, adminT);
  assert.equal(a.status, 201);
  assert.equal((await call('POST', '/api/personnel', { name: 'Dup B', employee_no: 'EMP-100' }, adminT)).status, 409);

  const del = await call('DELETE', `/api/personnel/${created.body.id}`, undefined, adminT);
  assert.equal(del.status, 200);
  assert.equal((await call('DELETE', `/api/personnel/${a.body.id}`, undefined, adminT)).status, 200);
});

/* ---------------- SIA / DBS compliance tracking ---------------- */
test('SIA licence and DBS check fields compute a compliance flag, and are validated', async () => {
  const p = await call('POST', '/api/personnel', { name: 'Compliance Test' }, adminT);
  assert.deepEqual(p.body.compliance, { sia: 'unset', dbs: 'unset' }, 'no data recorded yet');

  const badExpiry = await call('PATCH', `/api/personnel/${p.body.id}`, { sia_licence_expiry: 'not-a-date' }, adminT);
  assert.equal(badExpiry.status, 400);
  const badType = await call('PATCH', `/api/personnel/${p.body.id}`, { dbs_certificate_type: 'NONSENSE' }, adminT);
  assert.equal(badType.status, 400);

  const expired = await call('PATCH', `/api/personnel/${p.body.id}`, { sia_licence_no: 'SIA-1', sia_licence_expiry: new Date(Date.now() - 86400000).toISOString() }, adminT);
  assert.equal(expired.body.compliance.sia, 'expired');

  const expiring = await call('PATCH', `/api/personnel/${p.body.id}`, { sia_licence_expiry: new Date(Date.now() + 10 * 86400000).toISOString() }, adminT);
  assert.equal(expiring.body.compliance.sia, 'expiring');

  const ok = await call('PATCH', `/api/personnel/${p.body.id}`, { sia_licence_expiry: new Date(Date.now() + 200 * 86400000).toISOString() }, adminT);
  assert.equal(ok.body.compliance.sia, 'ok');

  const withCert = await call('PATCH', `/api/personnel/${p.body.id}`, { dbs_certificate_no: 'DBS-1', dbs_certificate_type: 'ENHANCED' }, adminT);
  assert.equal(withCert.body.compliance.dbs, 'unset', 'recording a certificate number is not the same as performing the check');

  const checked = await call('PATCH', `/api/personnel/${p.body.id}`, { dbs_checked_now: true }, adminT);
  assert.equal(checked.body.compliance.dbs, 'ok');
  assert.ok(checked.body.dbs_last_checked_at);

  await call('DELETE', `/api/personnel/${p.body.id}`, undefined, adminT);
});

test('a person can hold multiple SIA licences, worst compliance wins, and legacy single-licence records still work', async () => {
  const p = await call('POST', '/api/personnel', { name: 'Multi Licence Test' }, adminT);
  const bad = await call('PATCH', `/api/personnel/${p.body.id}`, { sia_licences: 'not an array' }, adminT);
  assert.equal(bad.status, 400);
  const missingType = await call('PATCH', `/api/personnel/${p.body.id}`, { sia_licences: [{ licence_no: '123' }] }, adminT);
  assert.equal(missingType.status, 400);

  const set = await call('PATCH', `/api/personnel/${p.body.id}`, {
    sia_licences: [
      { licence_type: 'Door Supervision', licence_no: 'DS-1', expiry: new Date(Date.now() + 200 * 86400000).toISOString().slice(0, 10) },
      { licence_type: 'CCTV (Public Space Surveillance)', licence_no: 'CCTV-1', expiry: new Date(Date.now() - 86400000).toISOString().slice(0, 10) },
    ],
  }, adminT);
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.sia_licences.length, 2);
  assert.equal(set.body.compliance.sia, 'expired', 'one expired licence makes the overall flag expired, even with another fine');

  const fixed = await call('PATCH', `/api/personnel/${p.body.id}`, {
    sia_licences: [{ licence_type: 'Door Supervision', licence_no: 'DS-1', expiry: new Date(Date.now() + 200 * 86400000).toISOString().slice(0, 10) }],
  }, adminT);
  assert.equal(fixed.body.compliance.sia, 'ok');

  // A record that predates this feature (only the old singleton fields,
  // never saved with a licences array) still reports a sensible array and
  // compliance via the fallback, with no migration needed.
  const legacy = await call('POST', '/api/personnel', { name: 'Legacy Licence Test' }, adminT);
  await call('PATCH', `/api/personnel/${legacy.body.id}`, { sia_licence_no: 'OLD-1', sia_licence_expiry: new Date(Date.now() + 100 * 86400000).toISOString() }, adminT);
  const legacyGet = (await call('GET', '/api/personnel', undefined, adminT)).body.find((x) => x.id === legacy.body.id);
  assert.equal(legacyGet.sia_licences.length, 1);
  assert.equal(legacyGet.sia_licences[0].licence_no, 'OLD-1');
  assert.equal(legacyGet.compliance.sia, 'ok');

  await call('DELETE', `/api/personnel/${p.body.id}`, undefined, adminT);
  await call('DELETE', `/api/personnel/${legacy.body.id}`, undefined, adminT);
});

test('emergency contact and bank details: self-service for one, admin-only for the other, and neither leaks to a colleague', async () => {
  const p = await call('POST', '/api/personnel', { name: 'Privacy Test Officer' }, adminT);
  const u = await call('POST', '/api/users', { username: 'privacy-test', password: 'test12345', role: 'FIELD_USER', personnel_id: p.body.id }, adminT);
  const myT = await login('privacy-test', 'test12345');

  assert.equal((await call('PATCH', `/api/personnel/${p.body.id}/emergency-contact`, { name: 'Jo Bloggs', relationship: 'Partner', phone: '07700900000' }, danT)).status, 403, 'not their own record');
  const mine = await call('PATCH', `/api/personnel/${p.body.id}/emergency-contact`, { name: 'Jo Bloggs', relationship: 'Partner', phone: '07700900000' }, myT);
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal(mine.body.emergency_contact.name, 'Jo Bloggs');

  assert.equal((await call('PATCH', `/api/personnel/${p.body.id}/emergency-contact`, { name: 'X' }, dispT)).status, 200, 'control can set it too');

  assert.equal((await call('PATCH', `/api/personnel/${p.body.id}`, { bank_details: { account_name: 'Jo Bloggs', sort_code: '12-34-56', account_number: '12345678' } }, myT)).status, 403, 'bank details are admin-only, not self-service');
  const bank = await call('PATCH', `/api/personnel/${p.body.id}`, { bank_details: { account_name: 'Jo Bloggs', sort_code: '12-34-56', account_number: '12345678' } }, adminT);
  assert.equal(bank.status, 200, JSON.stringify(bank.body));
  assert.equal(bank.body.bank_details.sort_code, '12-34-56');
  assert.equal((await call('PATCH', `/api/personnel/${p.body.id}`, { bank_details: { sort_code: 'not-a-sort-code' } }, adminT)).status, 400);

  // Self and admin both see it on a GET /api/personnel list fetch...
  const mySelfView = (await call('GET', '/api/personnel', undefined, myT)).body.find((x) => x.id === p.body.id);
  assert.ok(mySelfView.emergency_contact, 'I can see my own emergency contact');
  assert.ok(mySelfView.bank_details, 'I can see my own bank details');
  const adminView = (await call('GET', '/api/personnel', undefined, adminT)).body.find((x) => x.id === p.body.id);
  assert.ok(adminView.bank_details, 'admin sees it too');
  // ...but a colleague looking at the same list does not.
  const colleagueView = (await call('GET', '/api/personnel', undefined, danT)).body.find((x) => x.id === p.body.id);
  assert.equal(colleagueView.emergency_contact, undefined, 'a colleague never sees it');
  assert.equal(colleagueView.bank_details, undefined, 'a colleague never sees it');

  await call('DELETE', `/api/users/${u.body.id}`, undefined, adminT);
  await call('DELETE', `/api/personnel/${p.body.id}`, undefined, adminT);
});

test('personnel cannot be deleted while assigned to an open job or site visit, or linked to a login', async () => {
  const p = await call('POST', '/api/personnel', { name: 'Temp Officer' }, adminT);
  const job = await call('POST', '/api/jobs', { priority: 'GREEN', location: 'Test site' }, dispT);
  await call('POST', `/api/jobs/${job.body.id}/assign`, { resources: [p.body.id] }, dispT);
  assert.equal((await call('DELETE', `/api/personnel/${p.body.id}`, undefined, adminT)).status, 409);
  await call('POST', `/api/jobs/${job.body.id}/stand-down`, { personnel: p.body.id }, dispT);
  assert.equal((await call('DELETE', `/api/personnel/${p.body.id}`, undefined, adminT)).status, 200);
});

test('linking a user to a personnel record updates has_login both ways, and unlinking clears it', async () => {
  const p = await call('POST', '/api/personnel', { name: 'Link Test' }, adminT);
  assert.equal(p.body.has_login, false);

  const u = await call('POST', '/api/users', { username: 'linktest', password: 'realpassword1', role: 'FIELD_USER', personnel_id: p.body.id }, adminT);
  assert.equal(u.status, 201);
  let refreshed = (await call('GET', '/api/personnel', undefined, adminT)).body.find((x) => x.id === p.body.id);
  assert.equal(refreshed.has_login, true);

  assert.equal((await call('POST', '/api/users', { username: 'linktest2', password: 'realpassword1', role: 'FIELD_USER', personnel_id: p.body.id }, adminT)).status, 409,
    'a second account cannot claim the same personnel record');

  await call('PATCH', `/api/users/${u.body.id}`, { personnel_id: null }, adminT);
  refreshed = (await call('GET', '/api/personnel', undefined, adminT)).body.find((x) => x.id === p.body.id);
  assert.equal(refreshed.has_login, false);
  await call('DELETE', `/api/personnel/${p.body.id}`, undefined, adminT);
});

/* ---------------- HR rota: shift types ---------------- */
test('shift types are admin-extensible, and retiring one hides it from the default list without touching shifts already using it', async () => {
  const listed = await call('GET', '/api/shift-types', undefined, dispT);
  assert.ok(listed.body.some((t) => t.key === 'CONTROL_ROOM'), 'the seeded defaults are present');
  assert.equal((await call('GET', '/api/shift-types?all=1', undefined, adminT)).status, 200);
  assert.equal((await call('GET', '/api/shift-types?all=1', undefined, dispT)).body.length, listed.body.length, 'all=1 is ignored for a non-admin');

  assert.equal((await call('POST', '/api/shift-types', { name: 'Night Patrol' }, dispT)).status, 403, 'only admin creates shift types');
  const created = await call('POST', '/api/shift-types', { name: 'Night Patrol' }, adminT);
  assert.equal(created.status, 201);
  assert.equal(created.body.key, 'NIGHT_PATROL', 'a key is derived from the name when none is given');
  assert.equal((await call('POST', '/api/shift-types', { name: 'Another', key: 'NIGHT_PATROL' }, adminT)).status, 409, 'key must be unique');

  const start = new Date(Date.now() + 3600000).toISOString();
  const end = new Date(Date.now() + 9 * 3600000).toISOString();
  const shift = await call('POST', '/api/shifts', { personnel: danId, shift_type_id: created.body.id, starts_at: start, ends_at: end }, adminT);
  assert.equal(shift.body.shift_type_name, 'Night Patrol');

  const retired = await call('PATCH', `/api/shift-types/${created.body.id}`, { active: false }, adminT);
  assert.equal(retired.body.active, false);
  assert.ok(!(await call('GET', '/api/shift-types', undefined, dispT)).body.some((t) => t.id === created.body.id), 'retired type is hidden from the default list');
  const stillThere = await call('GET', `/api/shifts?personnel_id=${danId}`, undefined, dispT);
  assert.equal(stillThere.body.find((s) => s.id === shift.body.id).shift_type_name, 'Night Patrol', 'the shift already using it is unaffected');
  await call('DELETE', `/api/shifts/${shift.body.id}`, undefined, adminT);
});

/* ---------------- HR rota: shifts ---------------- */
const patrolTypeId = () => app.db.shift_types.find((t) => t.key === 'MOBILE_PATROL').id;

test('a shift is created with an initial assignment, and only that officer or control can clock in and out', async () => {
  const start = new Date(Date.now() + 3600000).toISOString();
  const end = new Date(Date.now() + 9 * 3600000).toISOString();
  assert.equal((await call('POST', '/api/shifts', { personnel: danId, shift_type_id: patrolTypeId(), starts_at: start, ends_at: end }, dispT)).status, 403, 'creating a shift is admin-only — a dispatcher is read-only on the rota');
  const shift = await call('POST', '/api/shifts', { personnel: danId, shift_type_id: patrolTypeId(), starts_at: start, ends_at: end }, adminT);
  assert.equal(shift.status, 201);
  assert.equal(shift.body.status, 'PUBLISHED');
  assert.equal(shift.body.assignments.length, 1);
  assert.equal(shift.body.assignments[0].personnel_name, 'Dan Whitfield');
  const assignmentId = shift.body.assignments[0].id;

  assert.equal((await call('POST', `/api/shift-assignments/${assignmentId}/clock-in`, {}, ellieT)).status, 403);
  assert.equal((await call('POST', `/api/shift-assignments/${assignmentId}/clock-in`, {}, danT)).status, 428, 'away from the rostered start, a reason is needed');
  const in1 = await call('POST', `/api/shift-assignments/${assignmentId}/clock-in`, { reason: 'test' }, danT);
  assert.equal(in1.body.status, 'IN_PROGRESS', 'clocking in moves the whole shift into progress');
  assert.ok(in1.body.assignments[0].clocked_in_at);

  const out1 = await call('POST', `/api/shift-assignments/${assignmentId}/clock-out`, { reason: 'test' }, danT);
  assert.ok(out1.body.assignments[0].clocked_out_at);
  assert.equal(out1.body.assignments[0].attendance, 'ATTENDED');
  assert.equal((await call('POST', `/api/shift-assignments/${assignmentId}/clock-out`, {}, danT)).status, 409, 'cannot clock out twice');
});

test('shifts reject a bad time range and can be filtered by personnel', async () => {
  const start = new Date(Date.now() + 3600000).toISOString();
  const bad = await call('POST', '/api/shifts', { personnel: ryanId, shift_type_id: patrolTypeId(), starts_at: start, ends_at: start }, adminT);
  assert.equal(bad.status, 400);

  const end = new Date(Date.now() + 8 * 3600000).toISOString();
  await call('POST', '/api/shifts', { personnel: ryanId, shift_type_id: patrolTypeId(), starts_at: start, ends_at: end }, adminT);
  const mine = await call('GET', `/api/shifts?personnel_id=${ryanId}`, undefined, dispT);
  assert.ok(mine.body.every((s) => s.assignments.some((a) => a.personnel_id === ryanId)));
  assert.ok(mine.body.every((s) => s.my && s.my.personnel_id === ryanId), 'the "my" convenience field points at the queried person');
  assert.ok(mine.body.length >= 1);
});

test('editing, staffing and deleting a shift is admin-only — a dispatcher is read-only on the rota', async () => {
  const start = new Date(Date.now() + 3600000).toISOString();
  const end = new Date(Date.now() + 5 * 3600000).toISOString();
  const shift = await call('POST', '/api/shifts', { personnel: ellieId, shift_type_id: patrolTypeId(), required_headcount: 2, starts_at: start, ends_at: end }, adminT);

  assert.equal((await call('PATCH', `/api/shifts/${shift.body.id}`, { notes: 'Cover for Dan' }, dispT)).status, 403, 'a dispatcher cannot edit a shift');
  const edited = await call('PATCH', `/api/shifts/${shift.body.id}`, { notes: 'Cover for Dan', status: 'PUBLISHED' }, adminT);
  assert.equal(edited.body.notes, 'Cover for Dan');
  assert.equal(edited.body.status, 'PUBLISHED');
  assert.equal(edited.body.coverage_gap, 1, 'one seat still open against a headcount of 2');

  assert.equal((await call('POST', `/api/shifts/${shift.body.id}/assignments`, { personnel: danId }, dispT)).status, 403, 'a dispatcher cannot add someone to a shift');
  const added = await call('POST', `/api/shifts/${shift.body.id}/assignments`, { personnel: danId }, adminT);
  assert.equal(added.status, 201);
  assert.equal(added.body.assignments.length, 2);
  assert.equal(added.body.coverage_gap, 0);
  assert.equal((await call('POST', `/api/shifts/${shift.body.id}/assignments`, { personnel: danId }, adminT)).status, 409, 'already on this shift');

  const danAssignmentId = added.body.assignments.find((a) => a.personnel_id === danId).id;
  assert.equal((await call('PATCH', `/api/shift-assignments/${danAssignmentId}`, { is_duty_supervisor: true }, dispT)).status, 403, 'a dispatcher cannot make someone duty supervisor');
  assert.equal((await call('PATCH', `/api/shift-assignments/${danAssignmentId}`, { is_duty_supervisor: true }, adminT)).body.assignments.find((a) => a.id === danAssignmentId).is_duty_supervisor, true);
  assert.equal((await call('PATCH', `/api/shift-assignments/${danAssignmentId}`, { status: 'REMOVED' }, dispT)).status, 403, 'a dispatcher cannot remove someone from a shift');

  assert.equal((await call('DELETE', `/api/shifts/${shift.body.id}`, undefined, dispT)).status, 403, 'delete is admin-only');
  assert.equal((await call('DELETE', `/api/shifts/${shift.body.id}`, undefined, adminT)).status, 200);
});

test('a shift created as DRAFT is invisible to its own assignee until published', async () => {
  const start = new Date(Date.now() + 3600000).toISOString();
  const end = new Date(Date.now() + 5 * 3600000).toISOString();
  assert.equal((await call('POST', '/api/shifts', { personnel: danId, shift_type_id: patrolTypeId(), starts_at: start, ends_at: end, status: 'IN_PROGRESS' }, adminT)).status, 400, 'a new shift can only be DRAFT or PUBLISHED');

  const draft = await call('POST', '/api/shifts', { personnel: danId, shift_type_id: patrolTypeId(), starts_at: start, ends_at: end, status: 'DRAFT' }, adminT);
  assert.equal(draft.status, 201);
  assert.equal(draft.body.status, 'DRAFT');

  const danSees = await call('GET', `/api/shifts?personnel_id=${danId}`, undefined, danT);
  assert.ok(!danSees.body.some((s) => s.id === draft.body.id), 'a draft never reaches the officer it names, even by their own filtered fetch');
  const controlSees = await call('GET', `/api/shifts?personnel_id=${danId}`, undefined, dispT);
  assert.ok(controlSees.body.some((s) => s.id === draft.body.id), 'control sees it fine, read-only');

  const published = await call('PATCH', `/api/shifts/${draft.body.id}`, { status: 'PUBLISHED' }, adminT);
  assert.equal(published.body.status, 'PUBLISHED');
  const danSeesNow = await call('GET', `/api/shifts?personnel_id=${danId}`, undefined, danT);
  assert.ok(danSeesNow.body.some((s) => s.id === draft.body.id), 'visible the moment it is published');

  await call('DELETE', `/api/shifts/${draft.body.id}`, undefined, adminT);
});

/* ---------------- asset tracking ---------------- */
test('a vehicle can be created, updated and deleted, with a unique registration', async () => {
  const created = await call('POST', '/api/vehicles', { registration: 'test-500', type: 'Van' }, adminT);
  assert.equal(created.status, 201);
  assert.equal(created.body.registration, 'TEST-500', 'registration is normalised to upper case');
  assert.equal((await call('POST', '/api/vehicles', { registration: 'TEST-501' }, dispT)).status, 403, 'only admin creates vehicles');
  assert.equal((await call('POST', '/api/vehicles', { registration: 'TEST-500' }, adminT)).status, 409);

  const patched = await call('PATCH', `/api/vehicles/${created.body.id}`, { mileage: 4200, status: 'OFF_ROAD' }, adminT);
  assert.equal(patched.body.mileage, 4200);
  assert.equal(patched.body.status, 'OFF_ROAD');
  assert.equal((await call('PATCH', `/api/vehicles/${created.body.id}`, { status: 'NONSENSE' }, adminT)).status, 400);

  assert.equal((await call('DELETE', `/api/vehicles/${created.body.id}`, undefined, adminT)).status, 200);
});

test('a vehicle carries a home-base site and MOT/tax due dates', async () => {
  const sites = await call('GET', '/api/sites', undefined, dispT);
  const meridian = sites.body.find((x) => x.name === 'Meridian Business Park');
  const created = await call('POST', '/api/vehicles', {
    registration: 'test-502', site_id: meridian.id, mot_due_at: '2026-12-01', tax_due_at: '2026-11-01',
  }, adminT);
  assert.equal(created.status, 201);
  assert.equal(created.body.site_id, meridian.id);
  assert.equal(created.body.site_name, 'Meridian Business Park');
  assert.equal(created.body.mot_due_at, '2026-12-01');

  const updated = await call('PATCH', `/api/vehicles/${created.body.id}`, { site_id: null, tax_due_at: null }, adminT);
  assert.equal(updated.body.site_id, null);
  assert.equal(updated.body.tax_due_at, null);
  await call('DELETE', `/api/vehicles/${created.body.id}`, undefined, adminT);
});

test('a vehicle cannot be deleted while an MDT or person is still linked to it', async () => {
  const mdts = await call('GET', '/api/mdts', undefined, dispT);
  const mdt001 = mdts.body.find((m) => m.mdt_code === 'MDT-001');
  const vehicles = await call('GET', '/api/vehicles', undefined, dispT);
  const linkedVehicle = vehicles.body.find((v) => v.registration === mdt001.vehicle);
  assert.ok(linkedVehicle, 'MDT-001 has a linked vehicle in the demo fleet');
  assert.equal((await call('DELETE', `/api/vehicles/${linkedVehicle.id}`, undefined, adminT)).status, 409);
});

test('an asset can be created, assigned to personnel, and has a unique tag', async () => {
  const created = await call('POST', '/api/assets', { category: 'DEVICE', description: 'Body camera', tag: 'BC-100' }, adminT);
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'IN_STORE');
  assert.equal((await call('POST', '/api/assets', { category: 'DEVICE', description: 'Dup', tag: 'BC-100' }, adminT)).status, 409);
  assert.equal((await call('POST', '/api/assets', { category: 'NOT_REAL', description: 'x' }, adminT)).status, 400);

  const assigned = await call('PATCH', `/api/assets/${created.body.id}`, { assigned_to: danId, status: 'IN_USE' }, adminT);
  assert.equal(assigned.body.assigned_to, danId);
  assert.equal(assigned.body.assigned_to_name, 'Dan Whitfield');
  assert.equal(assigned.body.status, 'IN_USE');

  const checked = await call('PATCH', `/api/assets/${created.body.id}`, { check_now: true }, adminT);
  assert.ok(checked.body.last_checked_at);

  const list = await call('GET', `/api/assets?assigned_to=${danId}`, undefined, dispT);
  assert.ok(list.body.some((a) => a.id === created.body.id));

  assert.equal((await call('DELETE', `/api/assets/${created.body.id}`, undefined, adminT)).status, 200);
});

/* ---------------- passdown logs ---------------- */
test('control can read and write a site passdown log; an unassigned officer cannot', async () => {
  const sites = await call('GET', '/api/sites', undefined, dispT);
  const carlton = sites.body.find((x) => x.name === 'Carlton Retail Centre');

  assert.equal((await call('GET', `/api/passdown-logs?site_id=${carlton.id}`, undefined, dispT)).status, 200);
  const created = await call('POST', '/api/passdown-logs', { site_id: carlton.id, body: 'Side gate padlock swapped, spare key with keyholder.' }, dispT);
  assert.equal(created.status, 201);
  assert.equal(created.body.author_name, 'Controller Hale');
  assert.equal(created.body.site_name, 'Carlton Retail Centre');

  const list = await call('GET', `/api/passdown-logs?site_id=${carlton.id}`, undefined, dispT);
  assert.ok(list.body.some((l) => l.id === created.body.id));

  assert.equal((await call('GET', `/api/passdown-logs?site_id=${carlton.id}`, undefined, ryanT)).status, 403, 'ryan has never been posted to Carlton');
  assert.equal((await call('POST', '/api/passdown-logs', { site_id: carlton.id, body: 'x' }, ryanT)).status, 403);

  assert.equal((await call('GET', '/api/passdown-logs', undefined, dispT)).status, 400, 'site_id is required');
  assert.equal((await call('POST', '/api/passdown-logs', { site_id: 999999, body: 'x' }, dispT)).status, 400);
  assert.equal((await call('POST', '/api/passdown-logs', { site_id: carlton.id, body: '   ' }, dispT)).status, 400);
});

test('a field officer gains passdown access to a site once they have a shift or visit there', async () => {
  const sites = await call('GET', '/api/sites', undefined, dispT);
  const meridian = sites.body.find((x) => x.name === 'Meridian Business Park');
  assert.equal((await call('GET', `/api/passdown-logs?site_id=${meridian.id}`, undefined, ryanT)).status, 403);

  const start = new Date(Date.now() + 3600000).toISOString();
  const end = new Date(Date.now() + 9 * 3600000).toISOString();
  await call('POST', '/api/shifts', { personnel: ryanId, site_id: meridian.id, shift_type_id: patrolTypeId(), starts_at: start, ends_at: end }, adminT);

  const posted = await call('POST', '/api/passdown-logs', { site_id: meridian.id, body: 'Fire panel silenced after false trigger in zone 2.' }, ryanT);
  assert.equal(posted.status, 201);
  assert.equal(posted.body.author_name, 'Ryan Cole');
  assert.equal(posted.body.author_personnel_id, ryanId);

  const list = await call('GET', `/api/passdown-logs?site_id=${meridian.id}`, undefined, ryanT);
  assert.ok(list.body.some((l) => l.id === posted.body.id));

  assert.equal((await call('DELETE', `/api/passdown-logs/${posted.body.id}`, undefined, dispT)).status, 403, 'delete is admin-only');
  assert.equal((await call('DELETE', `/api/passdown-logs/${posted.body.id}`, undefined, adminT)).status, 200);
});

test('an officer posted to a site can see its current assignment instructions and maps, but nothing else there', async () => {
  const PDF = Buffer.from('%PDF-1.4 not a real pdf, just needs the header').toString('base64');
  const sites = await call('GET', '/api/sites', undefined, dispT);
  const carlton = sites.body.find((x) => x.name === 'Carlton Retail Centre');
  assert.equal((await call('GET', `/api/sites/${carlton.id}/documents`, undefined, ellieT)).status, 403, 'not posted here yet');

  await call('POST', `/api/sites/${carlton.id}/documents`, { type: 'CONTRACT', mimetype: 'application/pdf', data: PDF }, adminT);
  const instr = await call('POST', `/api/sites/${carlton.id}/documents`, { type: 'ASSIGNMENT_INSTRUCTIONS', title: 'General', mimetype: 'application/pdf', data: PDF }, adminT);
  await call('POST', `/api/sites/${carlton.id}/documents`, { type: 'ASSIGNMENT_INSTRUCTIONS', title: 'General', mimetype: 'application/pdf', data: PDF }, adminT); // v2, archives v1

  const start = new Date(Date.now() + 3600000).toISOString();
  const end = new Date(Date.now() + 9 * 3600000).toISOString();
  await call('POST', '/api/shifts', { personnel: ellieId, site_id: carlton.id, shift_type_id: patrolTypeId(), starts_at: start, ends_at: end }, adminT);

  const docs = await call('GET', `/api/sites/${carlton.id}/documents`, undefined, ellieT);
  assert.equal(docs.status, 200);
  assert.ok(!docs.body.some((d) => d.type === 'CONTRACT'), 'an officer never sees contracts');
  assert.ok(!docs.body.some((d) => d.id === instr.body.id), 'the archived v1 is not shown, only the current version');
  assert.equal(docs.body.filter((d) => d.type === 'ASSIGNMENT_INSTRUCTIONS').length, 1);

  // Raw fetch, not the call() helper above — the response body is the PDF's
  // actual bytes, not JSON, and this needs the response headers too.
  const file = await fetch(`${BASE}/api/documents/${docs.body[0].id}/file`, { headers: { authorization: `Bearer ${ellieT}` } });
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition'), /^inline;/, 'opens in-browser, not forced to download');
  assert.equal((await call('GET', `/api/documents/${instr.body.id}/file`, undefined, ellieT)).status, 404, 'the archived version is not reachable directly either');

  const otherSite = sites.body.find((x) => x.name !== 'Carlton Retail Centre');
  assert.equal((await call('GET', `/api/sites/${otherSite.id}/documents`, undefined, ellieT)).status, 403, 'not posted at the other site');
});

/* ---------------- fuel logs ---------------- */
test('a fuel log is created against a vehicle, updates its mileage, and can take a receipt photo', async () => {
  const vehicles = await call('GET', '/api/vehicles', undefined, dispT);
  const mdt001 = (await call('GET', '/api/mdts', undefined, dispT)).body.find((m) => m.mdt_code === 'MDT-001');
  const vehicle = vehicles.body.find((v) => v.registration === mdt001.vehicle);
  assert.ok(vehicle, 'MDT-001 has a linked vehicle in the demo fleet');

  const created = await call('POST', `/api/vehicles/${vehicle.id}/fuel-logs`, { litres: 42.5, odometer: 55000, cost: 68.2 }, danT);
  assert.equal(created.status, 201);
  assert.equal(created.body.litres, 42.5);
  assert.equal(created.body.driver_name, 'Dan Whitfield');
  assert.equal(created.body.vehicle_registration, vehicle.registration);

  const patchedVehicle = (await call('GET', '/api/vehicles', undefined, dispT)).body.find((v) => v.id === vehicle.id);
  assert.equal(patchedVehicle.mileage, 55000, 'logging an odometer reading updates the vehicle mileage');

  assert.equal((await call('POST', `/api/vehicles/${vehicle.id}/fuel-logs`, { litres: 0 }, dispT)).status, 400, 'litres must be positive');

  const receipt = await call('POST', `/api/fuel-logs/${created.body.id}/receipt`, { mimetype: 'image/jpeg', data: Buffer.from('fake-jpeg').toString('base64') }, danT);
  assert.equal(receipt.status, 201);
  assert.ok(receipt.body.receipt.url.includes(`/api/fuel-logs/${created.body.id}/receipt/`));
  const photo = await fetch(`${BASE}${receipt.body.receipt.url}`, { headers: { authorization: `Bearer ${danT}` } });
  assert.equal(photo.status, 200);

  const list = await call('GET', `/api/vehicles/${vehicle.id}/fuel-logs`, undefined, dispT);
  assert.ok(list.body.some((f) => f.id === created.body.id));

  assert.equal((await call('DELETE', `/api/fuel-logs/${created.body.id}`, undefined, dispT)).status, 403, 'delete is admin-only');
  assert.equal((await call('DELETE', `/api/fuel-logs/${created.body.id}`, undefined, adminT)).status, 200);
});

/* ---------------- vehicle maintenance logs ---------------- */
test('a maintenance log is created against a vehicle and updates its service due date and mileage', async () => {
  const vehicles = await call('GET', '/api/vehicles', undefined, dispT);
  const vehicle = vehicles.body.find((v) => v.registration === 'VAN-101');
  assert.ok(vehicle, 'VAN-101 is in the demo fleet');

  assert.equal((await call('POST', `/api/vehicles/${vehicle.id}/maintenance-logs`, { description: 'Oil change' }, danT)).status, 403, 'logging maintenance is control-only');

  const nextDue = new Date(Date.now() + 90 * 86400000).toISOString();
  const created = await call('POST', `/api/vehicles/${vehicle.id}/maintenance-logs`, {
    description: 'Oil change and brake check', cost: 145.5, odometer: 61000, next_due_at: nextDue,
  }, dispT);
  assert.equal(created.status, 201);
  assert.equal(created.body.description, 'Oil change and brake check');
  assert.equal(created.body.vehicle_registration, 'VAN-101');

  const patchedVehicle = (await call('GET', '/api/vehicles', undefined, dispT)).body.find((v) => v.id === vehicle.id);
  assert.equal(patchedVehicle.mileage, 61000, 'logging an odometer reading updates the vehicle mileage');
  assert.equal(patchedVehicle.service_due_at, created.body.next_due_at, 'next_due_at updates the vehicle service_due_at');

  assert.equal((await call('POST', `/api/vehicles/${vehicle.id}/maintenance-logs`, { description: '' }, dispT)).status, 400, 'description is required');

  const list = await call('GET', `/api/vehicles/${vehicle.id}/maintenance-logs`, undefined, danT);
  assert.ok(list.body.some((m) => m.id === created.body.id));

  assert.equal((await call('DELETE', `/api/maintenance-logs/${created.body.id}`, undefined, dispT)).status, 403, 'delete is admin-only');
  assert.equal((await call('DELETE', `/api/maintenance-logs/${created.body.id}`, undefined, adminT)).status, 200);
});

/* ---------------- asset checkout/return ---------------- */
test('an asset can be checked out and returned, audit-trailed, and a field user can only act on their own checkout', async () => {
  const asset = await call('POST', '/api/assets', { category: 'KEY', description: 'Master key — Meridian' }, adminT);

  assert.equal((await call('POST', `/api/assets/${asset.body.id}/checkout`, {}, dispT)).status, 400, 'control must specify who');
  const out = await call('POST', `/api/assets/${asset.body.id}/checkout`, { personnel_id: danId }, dispT);
  assert.equal(out.status, 201);
  assert.equal(out.body.assigned_to, danId);
  assert.equal(out.body.status, 'IN_USE');

  assert.equal((await call('POST', `/api/assets/${asset.body.id}/checkout`, { personnel_id: ellieId }, dispT)).status, 409, 'already checked out');

  assert.equal((await call('POST', `/api/assets/${asset.body.id}/return`, {}, ellieT)).status, 403, 'not ellie\'s checkout');
  const back = await call('POST', `/api/assets/${asset.body.id}/return`, {}, danT);
  assert.equal(back.status, 200);
  assert.equal(back.body.assigned_to, null);
  assert.equal(back.body.status, 'IN_STORE');
  assert.ok(back.body.last_checked_at);

  assert.equal((await call('POST', `/api/assets/${asset.body.id}/return`, {}, dispT)).status, 409, 'not currently checked out');

  const history = await call('GET', `/api/assets/${asset.body.id}/checkouts`, undefined, dispT);
  assert.equal(history.body.length, 1);
  assert.equal(history.body[0].personnel_name, 'Dan Whitfield');
  assert.ok(history.body[0].returned_at);

  const self = await call('POST', `/api/assets/${asset.body.id}/checkout`, {}, ellieT);
  assert.equal(self.status, 201, 'a field user can check an asset out to themselves with no personnel_id');
  assert.equal(self.body.assigned_to, ellieId);

  await call('DELETE', `/api/assets/${asset.body.id}`, undefined, adminT).catch(() => {});
});

/* ---------------- beats ---------------- */
test('a beat is created against a site, referenced by a patrol schedule and the visit it generates', async () => {
  const sites = await call('GET', '/api/sites', undefined, dispT);
  const meridian = sites.body.find((x) => x.name === 'Meridian Business Park');

  const beat = await call('POST', '/api/beats', { site_id: meridian.id, name: 'Perimeter sweep', description: 'Fence line and gates' }, dispT);
  assert.equal(beat.status, 201);
  assert.equal(beat.body.site_name, 'Meridian Business Park');

  const waypointed = await call('PATCH', `/api/beats/${beat.body.id}`, { waypoints: [{ title: 'Gate 1', instructions: 'Check padlock' }, { title: '' }] }, dispT);
  assert.equal(waypointed.body.waypoints.length, 1, 'a waypoint with no title is dropped');

  const otherSite = sites.body.find((x) => x.name === 'Carlton Retail Centre');
  const schedule = await call('POST', '/api/patrol-schedules', { site_id: meridian.id, beat_id: beat.body.id, label: 'Perimeter check', interval_hours: 4 }, dispT);
  assert.equal(schedule.status, 201);
  assert.equal(schedule.body.beat_name, 'Perimeter sweep');
  assert.equal((await call('POST', '/api/patrol-schedules', { site_id: otherSite.id, beat_id: beat.body.id, label: 'Wrong site', interval_hours: 4 }, dispT)).status, 400, 'beat must belong to the schedule\'s site');

  const visit = await call('POST', '/api/site-visits', { site_id: meridian.id, beat_id: beat.body.id }, dispT);
  assert.equal(visit.status, 201);
  assert.equal(visit.body.beat_name, 'Perimeter sweep');

  assert.equal((await call('DELETE', `/api/beats/${beat.body.id}`, undefined, adminT)).status, 409, 'beat has patrol schedules');
  await call('DELETE', `/api/patrol-schedules/${schedule.body.id}`, undefined, adminT);
  assert.equal((await call('DELETE', `/api/beats/${beat.body.id}`, undefined, adminT)).status, 409, 'beat has an open site visit');
  await call('PATCH', `/api/site-visits/${visit.body.id}`, { status: 'CANCELLED' }, dispT);
  assert.equal((await call('DELETE', `/api/beats/${beat.body.id}`, undefined, adminT)).status, 200);
});

/* ---------------- guard tour checkpoint scanning ---------------- */
test('a checkpoint scan is recorded against the matching waypoint, and only for the assigned officer or control', async () => {
  const sites = await call('GET', '/api/sites', undefined, dispT);
  const meridian = sites.body.find((x) => x.name === 'Meridian Business Park');
  const beat = await call('POST', '/api/beats', { site_id: meridian.id, name: 'Scan test beat' }, dispT);
  await call('PATCH', `/api/beats/${beat.body.id}`, { waypoints: [{ title: 'Gate 1' }, { title: 'Loading bay' }] }, dispT);
  const gate1 = (await call('GET', `/api/beats?site_id=${meridian.id}`, undefined, dispT)).body.find((b) => b.id === beat.body.id).waypoints.find((w) => w.title === 'Gate 1');

  const visit = await call('POST', '/api/site-visits', { site_id: meridian.id, beat_id: beat.body.id }, dispT);
  assert.deepEqual(visit.body.waypoints.map((w) => w.title).sort(), ['Gate 1', 'Loading bay']);
  assert.equal(visit.body.checkpoint_scans.length, 0);

  assert.equal((await call('POST', `/api/site-visits/${visit.body.id}/checkpoint-scan`, { waypoint_id: gate1.id }, ryanT)).status, 403, 'not assigned to this visit');

  await call('POST', `/api/site-visits/${visit.body.id}/assign`, { personnel: danId }, dispT);
  assert.equal((await call('POST', `/api/site-visits/${visit.body.id}/checkpoint-scan`, { waypoint_id: 'not-a-real-waypoint' }, danT)).status, 404);

  const scanned = await call('POST', `/api/site-visits/${visit.body.id}/checkpoint-scan`, { waypoint_id: gate1.id, lat: 53.6, lon: -0.22 }, danT);
  assert.equal(scanned.status, 201);
  assert.equal(scanned.body.checkpoint_scans.length, 1);
  assert.equal(scanned.body.checkpoint_scans[0].waypoint_title, 'Gate 1');
  assert.equal(scanned.body.checkpoint_scans[0].scanned_by, danId);

  const list = await call('GET', '/api/site-visits', undefined, dispT);
  const fresh = list.body.find((v) => v.id === visit.body.id);
  assert.equal(fresh.checkpoint_scans.length, 1);

  await call('PATCH', `/api/site-visits/${visit.body.id}`, { status: 'CANCELLED' }, dispT);
  await call('DELETE', `/api/beats/${beat.body.id}`, undefined, adminT);
});

/* ---------------- UI preferences ---------------- */
test('a login response includes default ui_prefs, and PATCH /api/me/preferences updates only your own account', async () => {
  const login = await call('POST', '/api/auth/login', { username: 'dwhitfield', password: 'field123' });
  assert.equal(login.body.user.ui_prefs.theme, 'harbour');
  assert.equal(login.body.user.ui_prefs.mode, 'system');
  assert.equal(login.body.user.ui_prefs.sound, true);

  const updated = await call('PATCH', '/api/me/preferences', { theme: 'cosmic', mode: 'dark', glow: true, sound: false }, danT);
  assert.equal(updated.status, 200);
  assert.equal(updated.body.ui_prefs.theme, 'cosmic');
  assert.equal(updated.body.ui_prefs.mode, 'dark');
  assert.equal(updated.body.ui_prefs.glow, true);
  assert.equal(updated.body.ui_prefs.sound, false);
  assert.equal(updated.body.ui_prefs.panels, 'translucent', 'fields not sent keep their previous value');

  assert.equal((await call('PATCH', '/api/me/preferences', { theme: 'not-a-real-theme' }, danT)).status, 400, 'an invalid value is rejected, not silently swapped for the default');

  const dispPrefs = await call('PATCH', '/api/me/preferences', { theme: 'graphite' }, dispT);
  assert.equal(dispPrefs.body.ui_prefs.theme, 'graphite');
  const danAgain = await call('POST', '/api/auth/login', { username: 'dwhitfield', password: 'field123' });
  assert.equal(danAgain.body.user.ui_prefs.theme, 'cosmic', "one account's preference change does not touch another's");

  await call('PATCH', '/api/me/preferences', { theme: 'harbour', mode: 'system', glow: false, sound: true }, danT);
});

/* ---------------- offline replay safety ---------------- */
test('a replayed write returns the first result instead of applying twice', async () => {
  const key = 'offline-replay-test-1';
  const send = () => fetch(BASE + '/api/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${danT}`, 'idempotency-key': key },
    body: JSON.stringify({ to_control: true, body: 'On scene, gate secure' }),
  });

  const first = await send();
  const firstBody = await first.json();
  assert.equal(first.status, 201);

  const second = await send();
  const secondBody = await second.json();
  assert.equal(second.headers.get('idempotent-replay'), 'true');
  assert.equal(secondBody.id, firstBody.id, 'the same message id comes back');

  const stored = app.db.messages.filter((m) => m.body === 'On scene, gate secure');
  assert.equal(stored.length, 1, 'only one message was actually stored');
});

test('different idempotency keys are treated as separate writes', async () => {
  const post = (key) => fetch(BASE + '/api/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${danT}`, 'idempotency-key': key },
    body: JSON.stringify({ to_control: true, body: 'Patrol complete' }),
  });
  await post('key-a');
  await post('key-b');
  assert.equal(app.db.messages.filter((m) => m.body === 'Patrol complete').length, 2);
});

test('one officer cannot replay another officer\'s idempotency key', async () => {
  const key = 'shared-key-attempt';
  await fetch(BASE + '/api/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${danT}`, 'idempotency-key': key },
    body: JSON.stringify({ to_control: true, body: 'From Dan' }),
  });
  const other = await fetch(BASE + '/api/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ellieT}`, 'idempotency-key': key },
    body: JSON.stringify({ to_control: true, body: 'From Ellie' }),
  });
  const body = await other.json();
  assert.equal(other.headers.get('idempotent-replay'), null);
  assert.equal(body.from_label, 'P102', 'keys are scoped per user');
});

test('a queued job acknowledgement replayed after reconnect acknowledges exactly once', async () => {
  const job = await call('POST', '/api/jobs', { priority: 'RED', location: 'Northgate Distribution' }, dispT);
  await call('POST', `/api/jobs/${job.body.id}/assign`, { resources: ['P101'] }, dispT);

  const key = 'queued-ack-1';
  const ack = () => fetch(BASE + `/api/jobs/${job.body.id}/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${danT}`, 'idempotency-key': key },
    body: '{}',
  });
  await ack();
  await ack();

  const assignments = app.db.job_assignments.filter((a) => a.job_id === job.body.id && a.acknowledged);
  assert.equal(assignments.length, 1);
  assert.equal((await call('GET', `/api/jobs?status=ACKNOWLEDGED`, undefined, dispT)).body.some((j) => j.id === job.body.id), true);
});

test('a replayed job creation returns the original job rather than making a second one', async () => {
  const key = 'offline-' + Date.now();
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${dispT}`, 'idempotency-key': key };
  const payload = JSON.stringify({ priority: 'GREEN', location: 'Carlton Retail Centre', incident_type: 'Patrol visit' });

  const first = await fetch(BASE + '/api/jobs', { method: 'POST', headers, body: payload });
  const firstJob = await first.json();
  assert.equal(first.status, 201);

  const replay = await fetch(BASE + '/api/jobs', { method: 'POST', headers, body: payload });
  const replayJob = await replay.json();
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get('idempotent-replay'), 'true');
  assert.equal(replayJob.id, firstJob.id);

  const matching = app.db.jobs.filter((j) => j.reference === firstJob.reference);
  assert.equal(matching.length, 1);
});

test('different idempotency keys create separate jobs', async () => {
  const mk = (key) => fetch(BASE + '/api/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${dispT}`, 'idempotency-key': key },
    body: JSON.stringify({ priority: 'GREEN', location: 'Northgate Distribution' }),
  }).then((r) => r.json());
  const a = await mk('k-a-' + Date.now());
  const b = await mk('k-b-' + Date.now());
  assert.notEqual(a.id, b.id);
});

/* ---------------- callback requests ---------------- */
test('an officer requests a callback and control is alerted', async () => {
  const control = await wsClient(dispT);

  const req = await call('POST', '/api/calls/request', {}, danT);
  assert.equal(req.status, 201);
  assert.equal(req.body.priority, false);
  assert.equal(req.body.state, 'PENDING');

  const seen = await control.waitFor('call.request');
  assert.equal(seen.callsign, 'P101');
  assert.equal(seen.personnel_id, danId);

  await call('POST', `/api/calls/requests/${req.body.id}/clear`, {}, dispT);
  control.close();
});

test('a second press escalates to priority rather than queueing twice', async () => {
  const first = await call('POST', '/api/calls/request', { personnel: ellieId }, dispT);
  const second = await call('POST', '/api/calls/request', { personnel: ellieId, priority: true }, dispT);

  assert.equal(second.body.id, first.body.id, 'the same request is escalated');
  assert.equal(second.body.priority, true);
  const pending = app.db.call_requests.filter((r) => r.personnel_id === ellieId && r.state === 'PENDING');
  assert.equal(pending.length, 1);

  await call('POST', `/api/calls/requests/${first.body.id}/clear`, {}, dispT);
});

test('an officer can cancel their own request but not someone else\'s', async () => {
  const mine = await call('POST', '/api/calls/request', {}, danT);
  const theirs = await call('POST', '/api/calls/request', { personnel: ellieId }, dispT);

  assert.equal((await call('POST', `/api/calls/requests/${theirs.body.id}/clear`, {}, danT)).status, 403);

  const cancelled = await call('POST', `/api/calls/requests/${mine.body.id}/clear`, {}, danT);
  assert.equal(cancelled.body.state, 'CANCELLED');

  const pending = await call('GET', '/api/calls/requests', undefined, dispT);
  assert.ok(!pending.body.some((r) => r.id === mine.body.id));
  await call('POST', `/api/calls/requests/${theirs.body.id}/clear`, {}, dispT);
});

/* ---------------- data retention ---------------- */
test('the retention sweep removes old location history but keeps recent fixes', async () => {
  const mdt = app.db.mdts.find((m) => m.mdt_code === 'MDT-001');
  const old = new Date(Date.now() - 90 * 86400000).toISOString();
  const recent = new Date(Date.now() - 2 * 86400000).toISOString();
  app.db.locations.push({ id: 900001, mdt_id: mdt.id, personnel_id: null, lat: 51.5, lon: -0.1, at: old });
  app.db.locations.push({ id: 900002, mdt_id: mdt.id, personnel_id: null, lat: 51.5, lon: -0.1, at: recent });

  app.retentionSweep();

  assert.ok(!app.db.locations.some((l) => l.id === 900001), 'a 90-day-old fix is gone');
  assert.ok(app.db.locations.some((l) => l.id === 900002), 'a 2-day-old fix is kept');
});

test('the retention sweep also covers dial_log, which carries actual message text, not just metadata like `messages`', async () => {
  const old = new Date(Date.now() - 200 * 86400000).toISOString();
  const recent = new Date(Date.now() - 2 * 86400000).toISOString();
  app.db.dial_log.push({ id: 900030, channel: 'SMS', personnel_id: ellieId, to_number: '+447700900000', body: 'old reminder', outcome: 'SENT', attempted_at: old, settled_at: null });
  app.db.dial_log.push({ id: 900031, channel: 'SMS', personnel_id: ellieId, to_number: '+447700900000', body: 'recent reminder', outcome: 'SENT', attempted_at: recent, settled_at: null });

  app.retentionSweep();

  assert.ok(!app.db.dial_log.some((d) => d.id === 900030), 'a 200-day-old contact attempt is gone — past the 180-day default');
  assert.ok(app.db.dial_log.some((d) => d.id === 900031), 'a 2-day-old one is kept');
});

test('an open job is never swept away, however old it is', async () => {
  const ancient = new Date(Date.now() - 5 * 365 * 86400000).toISOString();
  const openJob = { id: 900010, reference: 'OLD-OPEN', status: 'DISPATCHED', priority: 'GREEN', location: 'Site', created_at: ancient, updated_at: ancient };
  const closedJob = { id: 900011, reference: 'OLD-CLOSED', status: 'COMPLETED', priority: 'GREEN', location: 'Site', created_at: ancient, updated_at: ancient };
  app.db.jobs.push(openJob, closedJob);

  app.retentionSweep();

  assert.ok(app.db.jobs.some((j) => j.id === 900010), 'still open, so still operational data');
  assert.ok(!app.db.jobs.some((j) => j.id === 900011), 'closed and past retention, so removed');
});

test('retention policy and current counts are visible to control', async () => {
  const res = await call('GET', '/api/retention', undefined, dispT);
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.policy_days.locations, 'number');
  assert.ok(res.body.policy_days.locations <= res.body.policy_days.audit,
    'movement history is kept no longer than the audit trail');
  assert.equal(typeof res.body.counts.locations, 'number');
  assert.equal((await call('GET', '/api/retention', undefined, danT)).status, 403);
});

test('a person\'s movement history can be erased without losing the job record', async () => {
  app.db.locations.push({ id: 900020, mdt_id: null, personnel_id: ellieId, lat: 51.5, lon: -0.1, at: new Date().toISOString() });
  const jobsBefore = app.db.jobs.length;

  const res = await call('POST', `/api/personnel/${ellieId}/erase-location-history`, {}, adminT);
  assert.equal(res.status, 200);
  assert.ok(res.body.removed >= 1);
  assert.ok(!app.db.locations.some((l) => l.personnel_id === ellieId), 'no fixes left for that person');
  assert.equal(app.db.jobs.length, jobsBefore, 'the operational record is untouched');

  const logged = await call('GET', '/api/events?type=retention.erasure', undefined, dispT);
  assert.ok(logged.body.some((e) => /LOCATION HISTORY ERASED/.test(e.summary)), 'the erasure is itself auditable');
  assert.equal((await call('POST', `/api/personnel/${danId}/erase-location-history`, {}, dispT)).status, 403);
});

/* ---------------- seeding from an operator file ---------------- */
test('a seed file builds the fleet with linked vehicles and users', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const file = path.join(os.tmpdir(), `seed-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({
    sites: [{ name: 'Test Park', address: '1 Test Way', lat: 51.5, lon: -0.1, keyholder: 'K. Holder' }],
    vehicles: [{ registration: 'VAN-001', type: 'Patrol van' }],
    callsigns: [{
      name: 'p901', vehicle: 'VAN-001', personnel: [{ name: 'Test Officer', rank: 'Officer' }],
      mdts: [{ code: 'mdt-901', serial: 'SN-901' }],
    }],
    users: [{ username: 'SeedUser', password: 'realpassword1', role: 'FIELD_USER', display_name: 'Seeded', personnel: 'Test Officer' }],
  }));

  // Seed into a scratch store so the running fixture is untouched.
  const scratch = require('node:child_process').spawnSync(process.execPath, ['-e', `
    process.env.PERSISTENCE = 'off';
    process.env.SEED_FILE = ${JSON.stringify(file)};
    const a = require(${JSON.stringify(path.join(__dirname, '..', 'server.js'))});
    a.seed();
    const cs = a.db.callsigns[0];
    const person = a.db.personnel[0];
    console.log(JSON.stringify({
      callsign: cs.name,
      personLinkedToCallsign: person.callsign_id === cs.id,
      mdtCode: a.db.mdts[0].mdt_code,
      mdtVehicle: a.db.mdts[0].vehicle_id === a.db.vehicles[0].id,
      username: a.db.users[0].username,
      userPersonnel: a.db.users[0].personnel_id === person.id,
      hashed: a.db.users[0].password_hash.startsWith('scrypt$'),
      personName: person.name,
      site: a.db.sites[0].keyholder,
    }));
  `], { encoding: 'utf8' });

  const out = JSON.parse(scratch.stdout.trim().split('\n').pop());
  assert.equal(out.callsign, 'P901', 'call signs are normalised to upper case');
  assert.ok(out.personLinkedToCallsign);
  assert.equal(out.mdtCode, 'MDT-901');
  assert.ok(out.mdtVehicle, 'the MDT inherits the call sign vehicle');
  assert.equal(out.username, 'seeduser', 'usernames are normalised to lower case');
  assert.ok(out.userPersonnel, 'the officer is bound to their personnel record');
  assert.ok(out.hashed, 'passwords are never stored in the clear');
  assert.equal(out.personName, 'Test Officer');
  assert.equal(out.site, 'K. Holder');
  fs.unlinkSync(file);
});

test('the seed file refuses placeholder and weak passwords and unknown roles', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const run = (doc) => {
    const file = path.join(os.tmpdir(), `bad-seed-${Math.random()}.json`);
    fs.writeFileSync(file, JSON.stringify(doc));
    const r = require('node:child_process').spawnSync(process.execPath, ['-e', `
      process.env.PERSISTENCE = 'off';
      process.env.SEED_FILE = ${JSON.stringify(file)};
      const a = require(${JSON.stringify(path.join(__dirname, '..', 'server.js'))});
      try { a.seed(); console.log('ACCEPTED'); } catch (e) { console.log('REFUSED: ' + e.message); }
    `], { encoding: 'utf8' });
    fs.unlinkSync(file);
    return r.stdout.trim().split('\n').pop();
  };

  assert.match(run({ users: [{ username: 'a', password: 'CHANGE-ME', role: 'DISPATCHER' }] }), /REFUSED.*placeholder/);
  assert.match(run({ users: [{ username: 'a', password: 'short', role: 'DISPATCHER' }] }), /REFUSED.*too short/);
  assert.match(run({ users: [{ username: 'a', password: 'realpassword1', role: 'WIZARD' }] }), /REFUSED.*unknown role/);
});
