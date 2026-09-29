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

/* ---------------- HR rota: shifts ---------------- */
test('a shift is created, and only the assigned officer or control can clock in and out', async () => {
  const start = new Date(Date.now() + 3600000).toISOString();
  const end = new Date(Date.now() + 9 * 3600000).toISOString();
  const shift = await call('POST', '/api/shifts', { personnel: danId, starts_at: start, ends_at: end, role_type: 'Patrol' }, dispT);
  assert.equal(shift.status, 201);
  assert.equal(shift.body.status, 'SCHEDULED');
  assert.equal(shift.body.personnel_name, 'Dan Whitfield');

  assert.equal((await call('POST', `/api/shifts/${shift.body.id}/clock-in`, {}, ellieT)).status, 403);
  const in1 = await call('POST', `/api/shifts/${shift.body.id}/clock-in`, {}, danT);
  assert.equal(in1.body.status, 'CLOCKED_IN');
  assert.ok(in1.body.clocked_in_at);

  const out1 = await call('POST', `/api/shifts/${shift.body.id}/clock-out`, {}, danT);
  assert.equal(out1.body.status, 'CLOCKED_OUT');
  assert.ok(out1.body.clocked_out_at);
  assert.equal((await call('POST', `/api/shifts/${shift.body.id}/clock-out`, {}, danT)).status, 409, 'cannot clock out twice');
});

test('shifts reject a bad time range and can be filtered by personnel', async () => {
  const start = new Date(Date.now() + 3600000).toISOString();
  const bad = await call('POST', '/api/shifts', { personnel: ryanId, starts_at: start, ends_at: start }, dispT);
  assert.equal(bad.status, 400);

  const end = new Date(Date.now() + 8 * 3600000).toISOString();
  await call('POST', '/api/shifts', { personnel: ryanId, starts_at: start, ends_at: end }, dispT);
  const mine = await call('GET', `/api/shifts?personnel_id=${ryanId}`, undefined, dispT);
  assert.ok(mine.body.every((s) => s.personnel_id === ryanId));
  assert.ok(mine.body.length >= 1);
});

test('a shift can be edited and deleted by control', async () => {
  const start = new Date(Date.now() + 3600000).toISOString();
  const end = new Date(Date.now() + 5 * 3600000).toISOString();
  const shift = await call('POST', '/api/shifts', { personnel: ellieId, starts_at: start, ends_at: end }, dispT);
  const edited = await call('PATCH', `/api/shifts/${shift.body.id}`, { notes: 'Cover for Dan', status: 'CONFIRMED' }, dispT);
  assert.equal(edited.body.notes, 'Cover for Dan');
  assert.equal(edited.body.status, 'CONFIRMED');
  assert.equal((await call('DELETE', `/api/shifts/${shift.body.id}`, undefined, dispT)).status, 403, 'delete is admin-only');
  assert.equal((await call('DELETE', `/api/shifts/${shift.body.id}`, undefined, adminT)).status, 200);
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
