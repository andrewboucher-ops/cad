/* asterisk.js against a scripted fake AMI server — node --test
 *
 * No PBX is reachable from CI, so this drives the real module over a real
 * TCP socket against a server that speaks the AMI wire format: the greeting
 * with its single CRLF, ActionID-correlated replies, and the event sequences
 * a FreePBX box emits for each call outcome. The scenario is chosen by the
 * number dialled. What this cannot prove — that the context exists on the
 * real box and that `control-dial` has read=call — only a real call can. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');

const received = [];          // every action block the fake server saw
let server, mode = 'ok';

function block(obj) { return Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n'; }

/* Event scripts, keyed by the Exten (officer number as dialled). Each step is
 * [delayMs, event]. CH is the ;1 half named in OriginateResponse. */
const CH = 'Local/201@from-internal-00000001;1';
const OP = 'Local/201@from-internal-00000001;2';
const SCRIPTS = {
  '07700900001': (id) => [ // answered after trunk failover, talked ~1s
    [5, { Event: 'DialEnd', Channel: OP, DestChannel: 'PJSIP/201-0001', DialStatus: 'ANSWER' }], // operator leg: must be ignored
    [5, { Event: 'OriginateResponse', ActionID: id, Response: 'Success', Channel: CH, Reason: '4', Uniqueid: '1.1' }],
    [5, { Event: 'DialEnd', Channel: CH, DestChannel: 'PJSIP/trunkA-0002', DialStatus: 'CHANUNAVAIL' }],
    [5, { Event: 'DialEnd', Channel: CH, DestChannel: 'PJSIP/trunkB-0003', DialStatus: 'ANSWER' }],
    [1100, { Event: 'Hangup', Channel: CH, Cause: '16' }],
  ],
  '07700900002': (id) => [ // operator never picked up their own phone
    [5, { Event: 'OriginateResponse', ActionID: id, Response: 'Failure', Channel: 'Local/201@from-internal', Reason: '3' }],
  ],
  '07700900003': (id) => [ // officer busy
    [5, { Event: 'OriginateResponse', ActionID: id, Response: 'Success', Channel: CH, Reason: '4' }],
    [5, { Event: 'DialEnd', Channel: CH, DestChannel: 'PJSIP/trunkA-0004', DialStatus: 'BUSY' }],
    [5, { Event: 'Hangup', Channel: CH, Cause: '17' }],
  ],
  '07700900004': (id) => [ // number matched no outbound route: no Dial at all
    [5, { Event: 'OriginateResponse', ActionID: id, Response: 'Success', Channel: CH, Reason: '4' }],
    [5, { Event: 'Hangup', Channel: CH, Cause: '1' }],
  ],
  '07700900005': (id) => [ // officer answered, then the AMI link dropped mid-call
    [5, { Event: 'OriginateResponse', ActionID: id, Response: 'Success', Channel: CH, Reason: '4' }],
    [5, { Event: 'DialEnd', Channel: CH, DestChannel: 'PJSIP/trunkA-0005', DialStatus: 'ANSWER' }],
    [20, 'DROP'],
  ],
  '07700900006': (id) => [ // an unrelated call's events arrive first and must not settle ours
    [5, { Event: 'Hangup', Channel: 'PJSIP/999-0099', Cause: '16' }],
    [5, { Event: 'OriginateResponse', ActionID: 'someone-else', Response: 'Failure', Reason: '5' }],
    [5, { Event: 'OriginateResponse', ActionID: id, Response: 'Success', Channel: CH, Reason: '4' }],
    [5, { Event: 'DialEnd', Channel: CH, DestChannel: 'PJSIP/trunkA-0006', DialStatus: 'NOANSWER' }],
    [5, { Event: 'Hangup', Channel: CH, Cause: '19' }],
  ],
};

before(async () => {
  server = net.createServer((s) => {
    s.write('Asterisk Call Manager/9.0.0\r\n');
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n\r\n')) !== -1) {
        const lines = buf.slice(0, i).split('\r\n'); buf = buf.slice(i + 4);
        const h = {};
        for (const l of lines) h[l.slice(0, l.indexOf(':'))] = l.slice(l.indexOf(':') + 1).trim();
        h.__raw = lines;
        received.push(h);
        const reply = (o) => s.write(block({ ...o, ActionID: h.ActionID }));
        if (h.Action === 'Login') {
          if (mode === 'badpw') reply({ Response: 'Error', Message: 'Authentication failed' });
          else { reply({ Response: 'Success', Message: 'Authentication accepted' }); s.write(block({ Event: 'FullyBooted', Status: 'Fully Booted' })); }
        } else if (h.Action === 'Ping') {
          if (mode === 'drop-on-ping') s.destroy(); else reply({ Response: 'Success', Ping: 'Pong' });
        } else if (h.Action === 'ListCommands') {
          reply({ Response: 'Success', Originate: 'Originate a call.  (Priv: originate,all)' });
        } else if (h.Action === 'Originate') {
          if (mode === 'no-originate') { reply({ Response: 'Error', Message: 'Permission denied' }); continue; }
          reply({ Response: 'Success', Message: 'Originate successfully queued' });
          const script = SCRIPTS[h.Exten];
          let t = 0;
          for (const [delay, ev] of script ? script(h.ActionID) : []) {
            t += delay;
            setTimeout(() => { if (ev === 'DROP') s.destroy(); else if (!s.destroyed) s.write(block(ev)); }, t);
          }
        } else if (h.Action === 'Logoff') {
          reply({ Response: 'Goodbye', Message: 'Thanks for all the fish.' }); s.end();
        }
      }
    });
    s.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.AMI_HOST = '127.0.0.1';
  process.env.AMI_PORT = String(server.address().port);
  process.env.AMI_USERNAME = 'control-dial';
  process.env.AMI_SECRET = 'test-secret';
});
after(() => server.close());

const load = () => { delete require.cache[require.resolve('../asterisk.js')]; return require('../asterisk.js'); };

test('logs in with an ActionID and answers a Ping over the same path', async () => {
  mode = 'ok';
  const ami = load();
  const h = await ami.connect();
  const pong = await h.sendAction('Ping');
  assert.equal(pong.Ping, 'Pong');
  const login = received.filter((r) => r.Action === 'Login').pop();
  assert.ok(login.ActionID, 'Login carries an ActionID, so its reply is correlated like any other');
  h.close();
});

test('a rejected login fails fast with the PBX\'s own message', async () => {
  mode = 'badpw';
  const t0 = Date.now();
  await assert.rejects(load().connect(), /Authentication failed/);
  assert.ok(Date.now() - t0 < 1000, 'not a timeout');
});

test('a dropped socket fails in-flight actions at once rather than timing out', async () => {
  mode = 'drop-on-ping';
  const h = await load().connect();
  const t0 = Date.now();
  await assert.rejects(h.sendAction('Ping'), /closed/);
  assert.ok(Date.now() - t0 < 1000);
});

test('probe reports Originate permission from ListCommands', async () => {
  mode = 'ok';
  const p = await load().probe();
  assert.equal(p.logged_in, true);
  assert.equal(p.can_originate, true);
});

test('the Originate rings the operator via a non-optimising Local channel, then the officer in national format', async () => {
  mode = 'ok';
  const placed = await load().originate({ extension: '201', number: '+44 7700 900001' });
  await placed.result;
  const o = received.filter((r) => r.Action === 'Originate').pop();
  assert.equal(o.Channel, 'Local/201@from-internal/n', '/n stops Asterisk optimising the ;1 half away mid-call');
  assert.equal(o.Context, 'from-internal');
  assert.equal(o.Exten, '07700900001', '+44 becomes 0 for a UK outbound route');
  assert.equal(o.Async, 'true');
  assert.equal(o.ActionID, placed.action_id);
  assert.equal(o.Application, undefined, 'Application and Context/Exten are mutually exclusive in Originate');
  assert.equal(o.__raw.filter((l) => l.startsWith('ActionID:')).length, 1, 'exactly one ActionID header');
});

test('answered after trunk failover: ANSWERED with a real duration, operator-leg events ignored', async () => {
  mode = 'ok';
  const r = await (await load().originate({ extension: '201', number: '07700900001' })).result;
  assert.equal(r.outcome, 'ANSWERED');
  assert.equal(r.leg, 'OFFICER');
  assert.ok(r.duration_s >= 1 && r.duration_s <= 2, `duration ${r.duration_s}`);
});

test('the operator not answering their own phone is recorded against the operator leg', async () => {
  mode = 'ok';
  const r = await (await load().originate({ extension: '201', number: '07700900002' })).result;
  assert.deepEqual(r, { outcome: 'NO_ANSWER', duration_s: null, cause: 'OPERATOR_NO_ANSWER', leg: 'OPERATOR' });
});

test('officer busy, and a number with no outbound route, each settle honestly', async () => {
  mode = 'ok';
  const busy = await (await load().originate({ extension: '201', number: '07700900003' })).result;
  assert.equal(busy.outcome, 'BUSY');
  const noroute = await (await load().originate({ extension: '201', number: '07700900004' })).result;
  assert.equal(noroute.outcome, 'FAILED');
  assert.equal(noroute.cause, 'NO_ROUTE');
});

test('other calls\' events on the same AMI stream do not settle this one', async () => {
  mode = 'ok';
  const r = await (await load().originate({ extension: '201', number: '07700900006' })).result;
  assert.equal(r.outcome, 'NO_ANSWER');
  assert.equal(r.leg, 'OFFICER');
});

test('losing the AMI link mid-call keeps the answer but claims no duration', async () => {
  mode = 'ok';
  const r = await (await load().originate({ extension: '201', number: '07700900005' })).result;
  assert.deepEqual(r, { outcome: 'ANSWERED', duration_s: null, cause: 'AMI_DISCONNECTED', leg: 'OFFICER' });
});

test('a refused Originate rejects, so the caller records FAILED rather than ATTEMPTED', async () => {
  mode = 'no-originate';
  await assert.rejects(load().originate({ extension: '201', number: '07700900001' }), /Permission denied/);
  mode = 'ok';
});

test('nothing that could inject AMI headers ever reaches the socket', async () => {
  const ami = load();
  const before = received.length;
  await assert.rejects(ami.originate({ extension: '201', number: '07700900001\r\nAction: Command' }), /not a dialable number/);
  await assert.rejects(ami.originate({ extension: '201\r\n', number: '07700900001' }), /extension/);
  await assert.rejects(ami.originate({ extension: '201', number: '+15551234567' }), /not a dialable number/, 'non-UK E.164 on a national trunk is refused, not misdialled');
  assert.equal(received.length, before, 'no connection was even opened');
});
