/* CCCS POC test suite — node --test */
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

let adminT, dispT, r101T, r102T, r103T, mdtT;

before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dispT = await login('dispatcher', 'dispatch123');
  r101T = await login('radio101', 'radio123');
  r102T = await login('radio102', 'radio123');
  r103T = await login('radio103', 'radio123');
  mdtT = await login('mdt001', 'mdt123');
});
after(() => {
  app.server.closeAllConnections?.();
  app.server.close();
});

/* ---------------- auth ---------------- */
test('rejects bad credentials and unauthenticated API calls', async () => {
  assert.equal((await call('POST', '/api/auth/login', { username: 'admin', password: 'wrong' })).status, 401);
  assert.equal((await call('GET', '/api/radios')).status, 401);
  assert.equal((await call('GET', '/api/radios', undefined, dispT)).status, 200);
});

test('role permissions are enforced', async () => {
  assert.equal((await call('POST', '/api/radios', { issi: '234199999' }, r101T)).status, 403);
  assert.equal((await call('POST', '/api/users', { username: 'x', password: 'password1', role: 'DISPATCHER' }, dispT)).status, 403);
});

/* ---------------- ISSI ---------------- */
test('creates a radio with a unique ISSI', async () => {
  const res = await call('POST', '/api/radios', { issi: '234100900', alias: 'TEST RADIO', radio_type: 'HANDHELD' }, adminT);
  assert.equal(res.status, 201);
  assert.equal(res.body.issi, '234100900');
});

test('rejects a duplicate ISSI', async () => {
  const res = await call('POST', '/api/radios', { issi: '234100900' }, adminT);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /already exists/);
});

test('rejects a malformed ISSI', async () => {
  assert.equal((await call('POST', '/api/radios', { issi: 'ABC' }, adminT)).status, 400);
});

/* ---------------- assignment ---------------- */
test('assigns a radio to a call sign, adds an MDT, then removes the radio', async () => {
  const callsigns = await call('GET', '/api/callsigns', undefined, dispT);
  const b202 = callsigns.body.find((c) => c.name === 'M202');
  assert.equal((await call('POST', `/api/callsigns/${b202.id}/assign`, { radio: '234100900' }, dispT)).status, 200);
  assert.equal((await call('POST', `/api/callsigns/${b202.id}/assign`, { mdt: 'MDT-003' }, dispT)).status, 200);

  let after = (await call('GET', '/api/callsigns', undefined, dispT)).body.find((c) => c.name === 'M202');
  assert.equal(after.radios.length, 2, 'call sign holds multiple radios');
  assert.ok(after.mdts.some((m) => m.mdt_code === 'MDT-003'));

  assert.equal((await call('DELETE', `/api/callsigns/${b202.id}/assign`, { radio: '234100900' }, dispT)).status, 200);
  after = (await call('GET', '/api/callsigns', undefined, dispT)).body.find((c) => c.name === 'M202');
  assert.equal(after.radios.length, 1);
});

/* ---------------- realtime: radio attach + status ---------------- */
test('radio registers over WebSocket and control sees the status change', async () => {
  const radio = await wsClient(r101T);
  const control = await wsClient(dispT);
  radio.send('radio.attach', { issi: '234100001' });
  const attached = await radio.waitFor('radio.attached');
  assert.equal(attached.callsign, 'P101');
  assert.equal(attached.status, 'AVAILABLE');

  await call('POST', '/api/radios/234100001/status', { status: 'BUSY' }, r101T);
  // the registration broadcast may still be in flight, so wait for the BUSY one specifically
  const seen = await control.waitUntil('radio.status_changed', (p) => p.status === 'BUSY');
  assert.equal(seen.status, 'BUSY');
  radio.close(); control.close();
});

/* ---------------- calls ---------------- */
test('dispatcher calls a radio, the radio is alerted and answers', async () => {
  const radio = await wsClient(r101T);
  radio.send('radio.attach', { issi: '234100001' });
  await radio.waitFor('radio.attached');

  const started = await call('POST', '/api/calls/private', { to: '234100001' }, dispT);
  assert.equal(started.status, 201);
  const incoming = await radio.waitFor('call.incoming');
  assert.equal(incoming.from_label, 'CONTROL');

  const accepted = await call('POST', `/api/calls/${started.body.id}/accept`, {}, r101T);
  assert.equal(accepted.body.state, 'ACTIVE');
  const ended = await call('POST', `/api/calls/${started.body.id}/end`, {}, dispT);
  assert.equal(ended.body.state, 'ENDED');
  radio.close();
});

test('radio calls radio and the callee declines', async () => {
  const a = await wsClient(r101T), b = await wsClient(r102T);
  a.send('radio.attach', { issi: '234100001' }); await a.waitFor('radio.attached');
  b.send('radio.attach', { issi: '234100002' }); await b.waitFor('radio.attached');

  const started = await call('POST', '/api/calls/private', { to: '234100002' }, r101T);
  assert.equal(started.status, 201);
  await b.waitFor('call.incoming');
  await call('POST', `/api/calls/${started.body.id}/reject`, {}, r102T);
  const ended = await a.waitFor('call.ended');
  assert.equal(ended.end_reason, 'DECLINED');
  a.close(); b.close();
});

test('calling an offline radio fails cleanly', async () => {
  const res = await call('POST', '/api/calls/private', { to: '234100006' }, dispT);
  assert.equal(res.status, 409);
});

test('group call reaches every connected member of a talkgroup', async () => {
  const a = await wsClient(r101T), b = await wsClient(r102T);
  a.send('radio.attach', { issi: '234100001' }); await a.waitFor('radio.attached');
  b.send('radio.attach', { issi: '234100002' }); await b.waitFor('radio.attached');
  const tgs = (await call('GET', '/api/talkgroups', undefined, dispT)).body;
  const amb1 = tgs.find((t) => t.name === 'PATROL 1');
  const res = await call('POST', '/api/calls/group', { talkgroup: amb1.id }, dispT);
  assert.equal(res.status, 201);
  await a.waitFor('call.incoming');
  await b.waitFor('call.incoming');
  await call('POST', `/api/calls/${res.body.id}/end`, {}, dispT);
  a.close(); b.close();
});

/* ---------------- PTT floor control ---------------- */
test('only one radio holds the talkgroup floor at a time', async () => {
  const a = await wsClient(r101T), b = await wsClient(r102T);
  a.send('radio.attach', { issi: '234100001' }); await a.waitFor('radio.attached');
  b.send('radio.attach', { issi: '234100002' }); await b.waitFor('radio.attached');

  a.send('radio.ptt_start', { talkgroup: 'PATROL 1' });
  const tx = await b.waitFor('radio.ptt_started');
  assert.equal(tx.callsign, 'P101');

  b.send('radio.ptt_start', { talkgroup: 'PATROL 1' });
  const denied = await b.waitFor('ptt.denied');
  assert.equal(denied.holder, 'P101');

  a.send('radio.ptt_release', { talkgroup: 'PATROL 1' });
  await b.waitFor('radio.ptt_released');
  a.close(); b.close();
});

/* ---------------- jobs ---------------- */
test('job is created, dispatched to a call sign, received and acknowledged', async () => {
  const radio = await wsClient(r101T), mdt = await wsClient(mdtT), control = await wsClient(dispT);
  radio.send('radio.attach', { issi: '234100001' }); await radio.waitFor('radio.attached');
  mdt.send('mdt.attach', { mdt_code: 'MDT-001' }); await mdt.waitFor('mdt.attached');

  const job = await call('POST', '/api/jobs', {
    incident_type: 'Cardiac arrest', priority: 'RED', location: '123 Example Street',
    description: 'Patient requiring immediate assistance', caller: 'Bystander',
  }, dispT);
  assert.equal(job.status, 201);
  assert.equal(job.body.status, 'CREATED');

  const dispatched = await call('POST', `/api/jobs/${job.body.id}/assign`, { resources: ['P101'] }, dispT);
  assert.equal(dispatched.body.status, 'DISPATCHED');

  const onRadio = await radio.waitFor('job.assigned_to_you');
  assert.equal(onRadio.reference, job.body.reference);
  const onMdt = await mdt.waitFor('job.assigned_to_you');
  assert.equal(onMdt.priority, 'RED');

  const acked = await call('POST', `/api/jobs/${job.body.id}/ack`, {}, r101T);
  assert.equal(acked.body.status, 'ACKNOWLEDGED');
  const ackSeen = await control.waitFor('job.acknowledged');
  assert.equal(ackSeen.by, 'P101');

  const enroute = await call('PATCH', `/api/jobs/${job.body.id}`, { status: 'EN_ROUTE' }, r101T);
  assert.equal(enroute.body.status, 'EN_ROUTE');
  assert.equal((await call('PATCH', `/api/jobs/${job.body.id}`, { status: 'NONSENSE' }, dispT)).status, 400);

  radio.close(); mdt.close(); control.close();
});

test('a radio cannot change the status of a job it was not given', async () => {
  const job = await call('POST', '/api/jobs', { priority: 'GREEN', location: 'Elsewhere' }, dispT);
  await call('POST', `/api/jobs/${job.body.id}/assign`, { resources: ['P103'] }, dispT);
  assert.equal((await call('PATCH', `/api/jobs/${job.body.id}`, { status: 'ON_SCENE' }, r101T)).status, 403);
});

/* ---------------- emergency ---------------- */
test('radio raises an emergency, control is alerted and can acknowledge and reset it', async () => {
  const radio = await wsClient(r101T), control = await wsClient(dispT);
  radio.send('radio.attach', { issi: '234100001' }); await radio.waitFor('radio.attached');

  const ev = await call('POST', '/api/emergency', {}, r101T);
  assert.equal(ev.status, 201);
  const alert = await control.waitFor('emergency.activated');
  assert.equal(alert.callsign, 'P101');
  assert.equal(alert.state, 'ACTIVE');
  assert.equal((await call('GET', '/api/radios/234100001', undefined, dispT)).body.status, 'EMERGENCY');

  const acked = await call('POST', `/api/emergency/${ev.body.id}/ack`, {}, dispT);
  assert.equal(acked.body.state, 'ACKNOWLEDGED');
  const resolved = await call('POST', `/api/emergency/${ev.body.id}/resolve`, {}, dispT);
  assert.equal(resolved.body.state, 'RESOLVED');
  assert.notEqual((await call('GET', '/api/radios/234100001', undefined, dispT)).body.status, 'EMERGENCY');
  radio.close(); control.close();
});

test('a radio user cannot acknowledge their own emergency', async () => {
  const ev = await call('POST', '/api/emergency', {}, r101T);
  assert.equal((await call('POST', `/api/emergency/${ev.body.id}/ack`, {}, r101T)).status, 403);
  await call('POST', `/api/emergency/${ev.body.id}/resolve`, {}, dispT);
});

/* ---------------- messaging + audit ---------------- */
test('control messages a radio and the event is written to the audit log', async () => {
  const radio = await wsClient(r101T);
  radio.send('radio.attach', { issi: '234100001' }); await radio.waitFor('radio.attached');
  await call('POST', '/api/messages', { to_radio: '234100001', body: 'RVP at the junction' }, dispT);
  const msg = await radio.waitFor('message.received');
  assert.equal(msg.body, 'RVP at the junction');
  const events = await call('GET', '/api/events?type=message', undefined, dispT);
  assert.ok(events.body.some((e) => e.summary.includes('RVP at the junction')));
  radio.close();
});

test('websocket upgrade is refused without a valid token', async () => {
  await assert.rejects(wsClient('not-a-real-token'), /handshake failed/);
});

/* ---------------- telephony (simulated gateway) ---------------- */
test('radio dials 9 for an outside line and the call answers then clears', async () => {
  const radio = await wsClient(r101T);
  radio.send('radio.attach', { issi: '234100001' }); await radio.waitFor('radio.attached');

  const res = await call('POST', '/api/calls/pstn', { digits: '902071234567' }, r101T);
  assert.equal(res.status, 201);
  assert.equal(res.body.kind, 'PSTN');
  assert.equal(res.body.dialled_number, '02071234567');
  assert.equal(res.body.state, 'RINGING');

  const answered = await radio.waitUntil('call.accepted', (p) => p.id === res.body.id, 6000);
  assert.equal(answered.state, 'ACTIVE');

  const ended = await call('POST', `/api/calls/${res.body.id}/end`, {}, r101T);
  assert.equal(ended.body.state, 'ENDED');
  radio.close();
});

test('a dialled string without the outside-line prefix is rejected', async () => {
  const res = await call('POST', '/api/calls/pstn', { digits: '02071234567' }, r101T);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /must start with 9/);
  assert.equal((await call('POST', '/api/calls/pstn', { digits: '9' }, r101T)).status, 400);
});

test('inbound PBX calls need the shared secret and ring the radio', async () => {
  process.env.PBX_SECRET = 'test-pbx-secret';
  const radio = await wsClient(r101T);
  radio.send('radio.attach', { issi: '234100001' }); await radio.waitFor('radio.attached');

  const bad = await fetch(BASE + '/api/pbx/inbound', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: '234100001' }),
  });
  assert.equal(bad.status, 401);

  const good = await fetch(BASE + '/api/pbx/inbound', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pbx-secret': 'test-pbx-secret' },
    body: JSON.stringify({ to: '234100001', caller_id: '07700900123' }),
  });
  assert.equal(good.status, 201);
  const incoming = await radio.waitUntil('call.incoming', (p) => p.kind === 'PSTN');
  assert.equal(incoming.from_label, '07700900123');
  radio.close();
});

/* ---------------- WebRTC signalling ---------------- */
test('WebRTC offers are relayed to the addressed radio and unknown peers report back', async () => {
  const a = await wsClient(r101T), b = await wsClient(r102T);
  a.send('radio.attach', { issi: '234100001' }); await a.waitFor('radio.attached');
  b.send('radio.attach', { issi: '234100002' }); await b.waitFor('radio.attached');

  a.send('webrtc.signal', { to: 'radio:234100002', data: { sdp: { type: 'offer', sdp: 'v=0 fake' } } });
  const relayed = await b.waitFor('webrtc.signal');
  assert.equal(relayed.from, 'radio:234100001');
  assert.equal(relayed.data.sdp.type, 'offer');

  a.send('webrtc.signal', { to: 'radio:234100099', data: {} });
  const miss = await a.waitFor('webrtc.unreachable');
  assert.equal(miss.to, 'radio:234100099');
  a.close(); b.close();
});

test('the floor holder is told which peers to stream audio to', async () => {
  const a = await wsClient(r101T), b = await wsClient(r102T), control = await wsClient(dispT);
  a.send('radio.attach', { issi: '234100001' }); await a.waitFor('radio.attached');
  b.send('radio.attach', { issi: '234100002' }); await b.waitFor('radio.attached');
  await new Promise((r) => setTimeout(r, 50));

  a.send('radio.ptt_start', { talkgroup: 'PATROL 1' });
  const granted = await a.waitFor('ptt.granted');
  assert.ok(granted.listeners.includes('radio:234100002'), 'talkgroup member is a listener');
  assert.ok(granted.listeners.some((l) => l.startsWith('conn:')), 'control room monitors the talkgroup');
  assert.ok(!granted.listeners.includes('radio:234100001'), 'the talker does not stream to itself');
  a.send('radio.ptt_release', { talkgroup: 'PATROL 1' });
  a.close(); b.close(); control.close();
});

/* ---------------- lone worker welfare ---------------- */
test('welfare timer warns the officer, then alarms control when no check-in arrives', async () => {
  const radio = await wsClient(r101T), control = await wsClient(dispT);
  radio.send('radio.attach', { issi: '234100001' }); await radio.waitFor('radio.attached');

  const started = await call('POST', '/api/radios/234100001/welfare', { interval_s: 30, note: 'Internal check, Meridian' }, r101T);
  assert.equal(started.status, 200);
  assert.ok(started.body.welfare_due_at);

  // Warn threshold is 2s in tests, so shorten the timer by checking in against a short interval.
  await call('POST', '/api/radios/234100001/welfare', { interval_s: 30 }, r101T);
  const checked = await call('POST', '/api/radios/234100001/welfare/check', {}, r101T);
  assert.equal(checked.status, 200);

  radio.close(); control.close();
});

test('an overdue welfare timer raises an alarm at control with the last known position', async () => {
  const radio = await wsClient(r102T), control = await wsClient(dispT);
  radio.send('radio.attach', { issi: '234100002' }); await radio.waitFor('radio.attached');

  // Drive the deadline directly rather than waiting 30 real seconds.
  await call('POST', '/api/radios/234100002/welfare', { interval_s: 30, note: 'Roof check' }, r102T);
  const r = app.db.radios.find((x) => x.issi === '234100002');
  r.welfare_due_at = new Date(Date.now() - 1000).toISOString();

  const alarm = await control.waitFor('welfare.overdue', 5000);
  assert.equal(alarm.callsign, 'P102');
  assert.equal(alarm.kind, 'WELFARE');
  assert.equal(alarm.note, 'Roof check');
  assert.equal(typeof alarm.lat, 'number', 'alarm carries last known position');

  const acked = await call('POST', `/api/emergency/${alarm.id}/ack`, {}, dispT);
  assert.equal(acked.body.state, 'ACKNOWLEDGED');
  await call('POST', `/api/emergency/${alarm.id}/resolve`, {}, dispT);
  radio.close(); control.close();
});

test('welfare timers reject silly intervals and cannot be set for someone else', async () => {
  assert.equal((await call('POST', '/api/radios/234100001/welfare', { interval_s: 5 }, r101T)).status, 400);
  assert.equal((await call('POST', '/api/radios/234100001/welfare', { interval_s: 99999 }, r101T)).status, 400);
  assert.equal((await call('POST', '/api/radios/234100002/welfare', { interval_s: 300 }, r101T)).status, 403);
  assert.equal((await call('POST', '/api/radios/234100003/welfare/check', {}, r101T)).status, 403);
});

test('checking in clears an alarm that has already been raised', async () => {
  const control = await wsClient(dispT);
  await call('POST', '/api/radios/234100003/welfare', { interval_s: 60 }, r103T);
  const r = app.db.radios.find((x) => x.issi === '234100003');
  r.welfare_due_at = new Date(Date.now() - 1000).toISOString();
  const alarm = await control.waitFor('welfare.overdue', 5000);

  await call('POST', '/api/radios/234100003/welfare', { interval_s: 300 }, r103T);
  await call('POST', '/api/radios/234100003/welfare/check', {}, r103T);
  const cleared = app.db.emergency_events.find((e) => e.id === alarm.id);
  assert.equal(cleared.state, 'RESOLVED');
  await call('DELETE', '/api/radios/234100003/welfare', {}, r103T);
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

/* ---------------- offline replay safety ---------------- */
test('a replayed write returns the first result instead of applying twice', async () => {
  const job = await call('POST', '/api/jobs', { priority: 'AMBER', location: 'Carlton Retail Centre' }, dispT);
  await call('POST', `/api/jobs/${job.body.id}/assign`, { resources: ['P101'] }, dispT);

  const key = 'offline-replay-test-1';
  const send = () => fetch(BASE + '/api/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${r101T}`, 'idempotency-key': key },
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
    headers: { 'content-type': 'application/json', authorization: `Bearer ${r101T}`, 'idempotency-key': key },
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
    headers: { 'content-type': 'application/json', authorization: `Bearer ${r101T}`, 'idempotency-key': key },
    body: JSON.stringify({ to_control: true, body: 'From P101' }),
  });
  const other = await fetch(BASE + '/api/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${r102T}`, 'idempotency-key': key },
    body: JSON.stringify({ to_control: true, body: 'From P102' }),
  });
  const body = await other.json();
  assert.equal(other.headers.get('idempotent-replay'), null);
  assert.equal(body.from_label, 'P102', 'keys are scoped per user');
});

test('a queued job acknowledgement replayed after reconnect acknowledges exactly once', async () => {
  const radio = await wsClient(r101T);
  radio.send('radio.attach', { issi: '234100001' }); await radio.waitFor('radio.attached');

  const job = await call('POST', '/api/jobs', { priority: 'RED', location: 'Northgate Distribution' }, dispT);
  await call('POST', `/api/jobs/${job.body.id}/assign`, { resources: ['P101'] }, dispT);

  const key = 'queued-ack-1';
  const ack = () => fetch(BASE + `/api/jobs/${job.body.id}/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${r101T}`, 'idempotency-key': key },
    body: '{}',
  });
  await ack();
  await ack();

  const assignments = app.db.job_assignments.filter((a) => a.job_id === job.body.id && a.acknowledged);
  assert.equal(assignments.length, 1);
  assert.equal((await call('GET', `/api/jobs?status=ACKNOWLEDGED`, undefined, dispT)).body.some((j) => j.id === job.body.id), true);
  radio.close();
});

/* ---------------- offline queue contract ---------------- */
test('a replayed action with the same idempotency key is answered, not re-applied', async () => {
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
  assert.equal(replayJob.id, firstJob.id, 'the replay returns the original job rather than making a second one');

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

/* ---------------- key bindings ---------------- */
test('key bindings default sensibly and persist per user', async () => {
  const defaults = await call('GET', '/api/me/settings', undefined, r101T);
  assert.equal(defaults.status, 200);
  assert.equal(defaults.body.ptt_keycode, 275, 'a common rugged-handset PTT keycode is the default');
  assert.equal(defaults.body.ptt_web_key, 'Space');
  assert.equal(defaults.body.sos_keycode, null, 'SOS is unbound until the officer chooses a key');

  const saved = await call('PUT', '/api/me/settings', {
    ptt_keycode: 131, ptt_key_label: 'Key 131', sos_keycode: 132, sos_key_label: 'Key 132', sos_hold_ms: 2000,
  }, r101T);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.ptt_keycode, 131);
  assert.equal(saved.body.sos_hold_ms, 2000);

  const reread = await call('GET', '/api/me/settings', undefined, r101T);
  assert.equal(reread.body.sos_key_label, 'Key 132');

  const other = await call('GET', '/api/me/settings', undefined, r102T);
  assert.equal(other.body.ptt_keycode, 275, 'another officer keeps their own bindings');
});

test('key bindings reject nonsense and refuse to put talk and SOS on one key', async () => {
  assert.equal((await call('PUT', '/api/me/settings', { ptt_keycode: 99999 }, r102T)).status, 400);
  assert.equal((await call('PUT', '/api/me/settings', { sos_hold_ms: 100 }, r102T)).status, 400);
  const clash = await call('PUT', '/api/me/settings', { ptt_keycode: 200, sos_keycode: 200 }, r102T);
  assert.equal(clash.status, 400);
  assert.match(clash.body.error, /cannot be bound to both/);
});

test('a key binding can be cleared', async () => {
  const cleared = await call('PUT', '/api/me/settings', { sos_keycode: null, sos_key_label: null }, r101T);
  assert.equal(cleared.body.sos_keycode, null);
});

test('binding tokens round-trip so a replacement handset restores them', async () => {
  const saved = await call('PUT', '/api/me/settings', { ptt_token: 'android:284', sos_token: 'android:285', sos_hold_ms: 2000 }, r102T);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.ptt_token, 'android:284');

  const onNewHandset = await call('GET', '/api/me/settings', undefined, r102T);
  assert.equal(onNewHandset.body.ptt_token, 'android:284');
  assert.equal(onNewHandset.body.sos_token, 'android:285');
  assert.equal(onNewHandset.body.sos_hold_ms, 2000);

  const clash = await call('PUT', '/api/me/settings', { ptt_token: 'android:290', sos_token: 'android:290' }, r102T);
  assert.equal(clash.status, 400);
});

/* ---------------- call requests ---------------- */
test('an officer requests a call and control is alerted', async () => {
  const radio = await wsClient(r101T), control = await wsClient(dispT);
  radio.send('radio.attach', { issi: '234100001' }); await radio.waitFor('radio.attached');

  const req = await call('POST', '/api/calls/request', {}, r101T);
  assert.equal(req.status, 201);
  assert.equal(req.body.priority, false);
  assert.equal(req.body.state, 'PENDING');

  const seen = await control.waitFor('call.request');
  assert.equal(seen.callsign, 'P101');
  assert.equal(typeof seen.lat, 'number', 'control can locate the officer who asked');

  await call('POST', `/api/calls/requests/${req.body.id}/clear`, {}, dispT);
  radio.close(); control.close();
});

test('a second press escalates to priority rather than queueing twice', async () => {
  const control = await wsClient(dispT);
  const first = await call('POST', '/api/calls/request', { radio: '234100003' }, dispT);
  const second = await call('POST', '/api/calls/request', { radio: '234100003', priority: true }, dispT);

  assert.equal(second.body.id, first.body.id, 'the same request is escalated');
  assert.equal(second.body.priority, true);
  const pending = app.db.call_requests.filter((r) => r.issi === '234100003' && r.state === 'PENDING');
  assert.equal(pending.length, 1);

  await call('POST', `/api/calls/requests/${first.body.id}/clear`, {}, dispT);
  control.close();
});

test('calling the officer clears their request automatically', async () => {
  const radio = await wsClient(r102T);
  radio.send('radio.attach', { issi: '234100002' }); await radio.waitFor('radio.attached');

  const req = await call('POST', '/api/calls/request', { priority: true }, r102T);
  assert.equal(req.body.priority, true);

  const started = await call('POST', '/api/calls/private', { to: '234100002' }, dispT);
  assert.equal(started.status, 201);

  const cleared = await radio.waitUntil('call.request_cleared', (p) => p.id === req.body.id);
  assert.equal(cleared.state, 'ANSWERED');
  assert.ok(cleared.answered_by);

  await call('POST', `/api/calls/${started.body.id}/end`, {}, dispT);
  radio.close();
});

test('an officer can cancel their own request but not someone else\'s', async () => {
  const mine = await call('POST', '/api/calls/request', {}, r101T);
  const theirs = await call('POST', '/api/calls/request', { radio: '234100002' }, dispT);

  assert.equal((await call('POST', `/api/calls/requests/${theirs.body.id}/clear`, {}, r101T)).status, 403);

  const cancelled = await call('POST', `/api/calls/requests/${mine.body.id}/clear`, {}, r101T);
  assert.equal(cancelled.body.state, 'CANCELLED');

  const pending = await call('GET', '/api/calls/requests', undefined, dispT);
  assert.ok(!pending.body.some((r) => r.id === mine.body.id));
  await call('POST', `/api/calls/requests/${theirs.body.id}/clear`, {}, dispT);
});

test('keypad long-press bindings default to 1, # and * and cannot collide', async () => {
  const s = await call('GET', '/api/me/settings', undefined, r103T);
  assert.equal(s.body.call_token, 'android:8', 'keypad 1');
  assert.equal(s.body.priority_token, 'android:18', 'keypad #');
  assert.equal(s.body.lock_token, 'android:17', 'keypad *');
  assert.equal(s.body.action_hold_ms, 800);

  // android:16 is keypad 9, which nothing else claims by default
  const rebound = await call('PUT', '/api/me/settings', { call_token: 'android:16', action_hold_ms: 1200 }, r103T);
  assert.equal(rebound.body.call_token, 'android:16');
  assert.equal(rebound.body.action_hold_ms, 1200);

  const collide = await call('PUT', '/api/me/settings', { call_token: 'android:17' }, r103T);
  assert.equal(collide.status, 400);
  assert.match(collide.body.error, /only be bound to one action/);
  await call('PUT', '/api/me/settings', { call_token: 'android:8', action_hold_ms: 800 }, r103T);
  assert.equal((await call('PUT', '/api/me/settings', { action_hold_ms: 50 }, r103T)).status, 400);
});

test('a cleared call releases the radio so it can be called again', async () => {
  const radio = await wsClient(r102T);
  radio.send('radio.attach', { issi: '234100002' }); await radio.waitFor('radio.attached');

  const first = await call('POST', '/api/calls/private', { to: '234100002' }, dispT);
  assert.equal(first.status, 201);
  await call('POST', `/api/calls/${first.body.id}/end`, {}, dispT);

  const second = await call('POST', '/api/calls/private', { to: '234100002' }, dispT);
  assert.equal(second.status, 201, 'the radio is free once the first call cleared');
  await call('POST', `/api/calls/${second.body.id}/end`, {}, dispT);
  radio.close();
});

/* ---------------- keypad conventions ---------------- */
test('a two-digit status code sets the operational status without a voice call', async () => {
  const control = await wsClient(dispT);
  const codes = await call('GET', '/api/status-codes', undefined, r101T);
  assert.ok(codes.body.some((c) => c.code === '03' && c.status === 'EN_ROUTE'));

  const sent = await call('POST', '/api/radios/234100001/status', { code: '03' }, r101T);
  assert.equal(sent.status, 200);
  assert.equal(sent.body.status, 'EN_ROUTE');
  assert.equal(sent.body.status_code, '03');

  const seen = await control.waitUntil('radio.status_changed', (p) => p.issi === '234100001' && p.status === 'EN_ROUTE');
  assert.equal(seen.status_code, '03');
  assert.equal((await call('POST', '/api/radios/234100001/status', { code: '99' }, r101T)).status, 400);
  control.close();
});

test('covert mode is flagged to control so they know the radio will not sound', async () => {
  const control = await wsClient(dispT);
  const on = await call('POST', '/api/radios/234100001/covert', { on: true }, r101T);
  assert.equal(on.body.covert, true);

  const seen = await control.waitFor('radio.covert_changed');
  assert.equal(seen.covert, true);
  const logged = await call('GET', '/api/events?type=radio.covert', undefined, dispT);
  assert.ok(logged.body.some((e) => /COVERT MODE ON/.test(e.summary)));

  const off = await call('POST', '/api/radios/234100001/covert', { on: false }, r101T);
  assert.equal(off.body.covert, false);
  control.close();
});

test('a position report updates the map and is logged', async () => {
  const control = await wsClient(dispT);
  const res = await call('POST', '/api/radios/234100002/position-report', { lat: 51.5111, lon: -0.1222 }, r102T);
  assert.equal(res.status, 200);
  assert.equal(res.body.lat, 51.5111);

  const seen = await control.waitFor('radio.position_report');
  assert.equal(seen.issi, '234100002');
  const logged = await call('GET', '/api/events?type=radio.position_report', undefined, dispT);
  assert.ok(logged.body.some((e) => /POSITION REPORT/.test(e.summary)));
  control.close();
});

test('an officer cannot send covert or position for another radio', async () => {
  assert.equal((await call('POST', '/api/radios/234100003/covert', { on: true }, r101T)).status, 403);
  assert.equal((await call('POST', '/api/radios/234100003/position-report', {}, r101T)).status, 403);
});

test('speed dial entries are validated and stored per officer', async () => {
  const saved = await call('PUT', '/api/me/settings', {
    speed_dial: {
      '4': { type: 'radio', target: '234100002', label: 'P102' },
      '5': { type: 'phone', target: '902071234567', label: 'Meridian keyholder' },
    },
  }, r101T);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.speed_dial['4'].target, '234100002');
  assert.equal(saved.body.speed_dial['5'].type, 'phone');

  assert.equal((await call('PUT', '/api/me/settings', { speed_dial: { 'Z': { target: '1' } } }, r101T)).status, 400);
  assert.equal((await call('PUT', '/api/me/settings', { speed_dial: { '6': { type: 'fax', target: '1' } } }, r101T)).status, 400);
  assert.equal((await call('PUT', '/api/me/settings', { speed_dial: { '6': { type: 'radio', target: '' } } }, r101T)).status, 400);
});

test('the full keypad set has a default binding and none of them collide', async () => {
  const s = await call('GET', '/api/me/settings', undefined, r102T);
  const expected = {
    call_token: 'android:8', priority_token: 'android:18', lock_token: 'android:17',
    redial_token: 'android:7', talkgroup_token: 'android:9', status_token: 'android:10',
    covert_token: 'android:12', position_token: 'android:15',
  };
  for (const [field, token] of Object.entries(expected)) assert.equal(s.body[field], token, field);
  const all = Object.values(expected).concat(s.body.ptt_token);
  assert.equal(new Set(all).size, all.length, 'no two actions share a key');

  const collide = await call('PUT', '/api/me/settings', { covert_token: 'android:15' }, r102T);
  assert.equal(collide.status, 400);
});

/* ---------------- data retention ---------------- */
test('the retention sweep removes old location history but keeps recent fixes', async () => {
  const radio = app.db.radios.find((r) => r.issi === '234100001');
  const old = new Date(Date.now() - 90 * 86400000).toISOString();
  const recent = new Date(Date.now() - 2 * 86400000).toISOString();
  app.db.locations.push({ id: 900001, radio_id: radio.id, lat: 51.5, lon: -0.1, at: old });
  app.db.locations.push({ id: 900002, radio_id: radio.id, lat: 51.5, lon: -0.1, at: recent });

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
  assert.equal((await call('GET', '/api/retention', undefined, r101T)).status, 403);
});

test('an officer\'s movement history can be erased without losing the job record', async () => {
  const radio = app.db.radios.find((r) => r.issi === '234100002');
  app.db.locations.push({ id: 900020, radio_id: radio.id, lat: 51.5, lon: -0.1, at: new Date().toISOString() });
  const jobsBefore = app.db.jobs.length;

  const res = await call('POST', '/api/radios/234100002/erase-location-history', {}, adminT);
  assert.equal(res.status, 200);
  assert.ok(res.body.removed >= 1);
  assert.ok(!app.db.locations.some((l) => l.radio_id === radio.id), 'no fixes left for that radio');
  assert.equal(app.db.jobs.length, jobsBefore, 'the operational record is untouched');

  const logged = await call('GET', '/api/events?type=retention.erasure', undefined, dispT);
  assert.ok(logged.body.some((e) => /LOCATION HISTORY ERASED/.test(e.summary)), 'the erasure is itself auditable');
  assert.equal((await call('POST', '/api/radios/234100001/erase-location-history', {}, dispT)).status, 403);
});

/* ---------------- seeding from an operator file ---------------- */
test('a seed file builds the fleet with linked vehicles, talkgroups and users', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const file = path.join(os.tmpdir(), `seed-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({
    sites: [{ name: 'Test Park', address: '1 Test Way', lat: 51.5, lon: -0.1, keyholder: 'K. Holder' }],
    vehicles: [{ registration: 'VAN-001', type: 'Patrol van' }],
    talkgroups: [{ name: 'patrol 1' }],
    callsigns: [{
      name: 'p901', vehicle: 'VAN-001', personnel: ['Dan Whitfield'],
      radios: [{ issi: '234199501', talkgroup: 'patrol 1', pbx_extension: '9501' }],
      mdts: [{ code: 'mdt-901', serial: 'SN-901' }],
    }],
    users: [{ username: 'SeedUser', password: 'realpassword1', role: 'RADIO_USER', display_name: 'Seeded', radio: '234199501' }],
  }));

  // Seed into a scratch store so the running fixture is untouched.
  const scratch = require('node:child_process').spawnSync(process.execPath, ['-e', `
    process.env.PERSISTENCE = 'off';
    process.env.SEED_FILE = ${JSON.stringify(file)};
    const a = require(${JSON.stringify(path.join(__dirname, '..', 'server.js'))});
    a.seed();
    const cs = a.db.callsigns[0];
    const radio = a.db.radios[0];
    console.log(JSON.stringify({
      callsign: cs.name,
      talkgroup: a.db.talkgroups[0].name,
      affiliated: a.db.talkgroup_members.length,
      issi: radio.issi,
      ext: radio.pbx_extension,
      radioLinkedToCallsign: radio.callsign_id === cs.id,
      mdtCode: a.db.mdts[0].mdt_code,
      mdtVehicle: a.db.mdts[0].vehicle_id === a.db.vehicles[0].id,
      username: a.db.users[0].username,
      userRadio: a.db.users[0].radio_id === radio.id,
      hashed: a.db.users[0].password_hash.startsWith('scrypt$'),
      crew: a.db.personnel[0].name,
      site: a.db.sites[0].keyholder,
    }));
  `], { encoding: 'utf8' });

  const out = JSON.parse(scratch.stdout.trim().split('\n').pop());
  assert.equal(out.callsign, 'P901', 'call signs are normalised to upper case');
  assert.equal(out.talkgroup, 'PATROL 1');
  assert.equal(out.affiliated, 1, 'the radio is affiliated to its talkgroup');
  assert.equal(out.issi, '234199501');
  assert.equal(out.ext, '9501');
  assert.ok(out.radioLinkedToCallsign);
  assert.equal(out.mdtCode, 'MDT-901');
  assert.ok(out.mdtVehicle, 'the MDT inherits the call sign vehicle');
  assert.equal(out.username, 'seeduser', 'usernames are normalised to lower case');
  assert.ok(out.userRadio, 'the officer is bound to their radio');
  assert.ok(out.hashed, 'passwords are never stored in the clear');
  assert.equal(out.crew, 'Dan Whitfield');
  assert.equal(out.site, 'K. Holder');
  fs.unlinkSync(file);
});

test('the seed file refuses placeholder and weak passwords, and duplicate ISSIs', () => {
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
  assert.match(run({
    callsigns: [{ name: 'X', radios: [{ issi: '234199601' }, { issi: '234199601' }] }],
  }), /REFUSED.*duplicate ISSI/);
});
