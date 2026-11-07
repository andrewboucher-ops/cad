/* Phone agent — node --test. Speech, AI and CCCS are faked; the AudioSocket
 * protocol and dialplan hooks are exercised over real sockets. */
const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { createAgent, frame, T_UUID, T_AUDIO, T_HANGUP } = require('../voice-agent/agent.js');

const quiet = { info() {}, warn() {}, error() {} };

function harness(script, cccsOverrides = {}) {
  let sttHandlers = null;
  const calls = { jobs: [], messages: [], sites: [], llm: [] };
  const stt = { open(h) { sttHandlers = h; return { send() {}, close() {} }; } };
  const tts = { async speak(text, onChunk) { onChunk(Buffer.alloc(640, 1)); } };
  const llm = { async reply(req) { calls.llm.push(JSON.parse(JSON.stringify(req.messages))); const next = script.shift(); if (next instanceof Error) throw next; return next; } };
  const cccs = {
    findSites: async (q) => { calls.sites.push(q); return [{ id: 7, name: 'Meridian Point', address: 'Cleethorpes' }]; },
    createJob: async (p) => { calls.jobs.push(p); return { id: 1, reference: 'INC-2026-00125', priority: p.priority }; },
    leaveMessage: async (p) => { calls.messages.push(p); return { id: 1 }; },
    ...cccsOverrides,
  };
  const agent = createAgent({ stt, tts, llm, cccs, log: quiet, config: { silenceMs: 60000 } });
  return { agent, calls, say: (text) => sttHandlers.onTranscript({ text, isFinal: true, endOfTurn: true }), ready: () => Boolean(sttHandlers) };
}

async function startCall(agent, caller = '07700900123') {
  await agent.listen({ httpPort: 0, audioPort: 0, host: '127.0.0.1' });
  const hp = agent.httpServer.address().port, ap = agent.audioServer.address().port;
  const id = await (await fetch(`http://127.0.0.1:${hp}/start?caller=${caller}`)).text();
  const sock = net.connect(ap, '127.0.0.1');
  await new Promise((r) => sock.on('connect', r));
  const got = { audio: 0, hangup: false };
  let buf = Buffer.alloc(0);
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 3) {
      const len = buf.readUInt16BE(1); if (buf.length < 3 + len) break;
      if (buf[0] === T_AUDIO) got.audio += len; if (buf[0] === T_HANGUP) got.hangup = true;
      buf = buf.subarray(3 + len);
    }
  });
  const ended = new Promise((r) => sock.on('close', r));
  sock.write(frame(T_UUID, Buffer.from(id.replace(/-/g, ''), 'hex')));
  sock.write(frame(T_AUDIO, Buffer.alloc(320)));
  const next = async () => (await fetch(`http://127.0.0.1:${hp}/next/${id}`)).text();
  return { id, sock, got, ended, next };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timed out'); await wait(10); } }
const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });
const textBlock = (text) => ({ type: 'text', text });

test('an alarm call raises a job in CCCS, then hangs up cleanly', async () => {
  const h = harness([
    { content: [textBlock('Let me find that site.'), tool('t1', 'find_site', { query: 'Meridian Point' })] },
    { content: [textBlock("I've raised that now."), tool('t2', 'create_job', { site_id: 7, incident_type: 'Alarm activation', priority: 'AMBER', description: 'Alarm sounding, caller outside', caller_name: 'Mark', callback_number: '07700900123' })] },
    { content: [textBlock('Someone will be in touch. Goodbye.'), tool('t3', 'end_call', {})] },
  ]);
  const c = await startCall(h.agent);
  await until(h.ready);
  h.say('the alarm is going off at Meridian Point');
  await c.ended;
  assert.equal(h.calls.jobs.length, 1);
  assert.equal(h.calls.jobs[0].site_id, 7);
  assert.equal(h.calls.jobs[0].call_id, c.id);
  assert.match(h.calls.jobs[0].transcript, /Caller: the alarm is going off/);
  assert.ok(c.got.audio > 0, 'the greeting and replies were played');
  assert.ok(c.got.hangup);
  assert.equal(await c.next(), 'HANGUP');
  assert.equal(h.calls.messages.length, 0, 'no fallback message when a job was raised');
  h.agent.close();
});

test('a transfer request tells the dialplan to ring on-call', async () => {
  const h = harness([{ content: [textBlock('Putting you through now.'), tool('t1', 'transfer_to_on_call', { reason: 'caller asked for a person' })] }]);
  const c = await startCall(h.agent);
  await until(h.ready);
  h.say('can I speak to someone please');
  await c.ended;
  assert.equal(await c.next(), 'TRANSFER');
  h.agent.close();
});

test('if the AI fails the caller is put through rather than dropped', async () => {
  const h = harness([new Error('AI error 529: overloaded')]);
  const c = await startCall(h.agent);
  await until(h.ready);
  h.say('hello?');
  await c.ended;
  assert.equal(await c.next(), 'TRANSFER');
  h.agent.close();
});

test('a caller hanging up mid-call still leaves a message for control', async () => {
  const h = harness([{ content: [textBlock('Can I take your name?')] }]);
  const c = await startCall(h.agent);
  await until(h.ready);
  h.say('I want a quote for CCTV at my shop');
  await until(() => h.calls.llm.length === 1);
  await wait(50);
  c.sock.end(frame(T_HANGUP));
  await until(() => h.calls.messages.length === 1);
  assert.match(h.calls.messages[0].message, /quote for CCTV/);
  assert.equal(h.calls.messages[0].caller_number, '07700900123');
  h.agent.close();
});

test('only one job is raised per call even if the AI asks twice', async () => {
  const job = { site_id: 7, incident_type: 'Alarm', priority: 'AMBER', description: 'x', caller_name: 'A', callback_number: '1' };
  const h = harness([
    { content: [tool('t1', 'create_job', job), tool('t2', 'create_job', job)] },
    { content: [textBlock('Done, goodbye.'), tool('t3', 'end_call', {})] },
  ]);
  const c = await startCall(h.agent);
  await until(h.ready);
  h.say('alarm');
  await c.ended;
  assert.equal(h.calls.jobs.length, 1);
  h.agent.close();
});

test('CCCS being down is reported to the AI, not thrown at the caller', async () => {
  const h = harness([
    { content: [tool('t1', 'create_job', { location: 'x', incident_type: 'Alarm', priority: 'AMBER', description: 'x', caller_name: 'A', callback_number: '1' })] },
    { content: [textBlock("I'll put you through."), tool('t2', 'transfer_to_on_call', { reason: 'system down' })] },
  ], { createJob: async () => { throw new Error('connect ECONNREFUSED'); } });
  const c = await startCall(h.agent);
  await until(h.ready);
  h.say('alarm going off');
  await c.ended;
  const toolResult = h.calls.llm[1].at(-1).content[0];
  assert.match(toolResult.content, /did not respond/);
  assert.equal(await c.next(), 'TRANSFER');
  h.agent.close();
});

test('an unknown call id is refused', async () => {
  const h = harness([]);
  await h.agent.listen({ httpPort: 0, audioPort: 0, host: '127.0.0.1' });
  const sock = net.connect(h.agent.audioServer.address().port, '127.0.0.1');
  await new Promise((r) => sock.on('connect', r));
  const closed = new Promise((r) => sock.on('close', r));
  sock.resume();
  sock.write(frame(T_UUID, Buffer.alloc(16, 0xab)));
  await closed;
  h.agent.close();
});
