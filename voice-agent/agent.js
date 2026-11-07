'use strict';
/**
 * Echelon phone assistant — answers calls the control room ring group could
 * not pick up, takes details, raises a job in CCCS or leaves a message, and
 * hands urgent calls to the on-call phone.
 *
 * How a call flows (see asterisk/extensions_custom.conf):
 *   1. Ring group times out → FreePBX custom destination → our dialplan.
 *   2. Dialplan asks GET /start?caller=… for a call id.
 *   3. Dialplan runs AudioSocket(<id>, host:9092): caller audio streams here
 *      as 8 kHz 16-bit PCM, and audio we write back is played to them.
 *   4. When we hang up the socket, the dialplan asks GET /next/<id> and gets
 *      TRANSFER (ring on-call, number fixed in the dialplan, never chosen
 *      here) or HANGUP.
 *
 * AudioSocket frame: 1 byte type, 2 bytes big-endian length, payload.
 *   0x00 hangup · 0x01 call UUID (16 bytes) · 0x10 audio · 0xff error
 */

const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { systemPrompt, GREETING, TOOLS } = require('./prompt.js');

const FRAME_BYTES = 320;   // 20 ms at 8 kHz, 16-bit mono
const FRAME_MS = 20;
const T_HANGUP = 0x00, T_UUID = 0x01, T_AUDIO = 0x10, T_ERROR = 0xff;

const uuidFromBytes = (b) => {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const frame = (type, payload = Buffer.alloc(0)) => {
  const head = Buffer.alloc(3); head[0] = type; head.writeUInt16BE(payload.length, 1);
  return Buffer.concat([head, payload]);
};

/** Paces outgoing audio at real time so Asterisk plays it smoothly, and lets
 * the caller interrupt (barge-in) by clearing whatever has not played yet. */
class Playout {
  constructor(write) { this.write = write; this.buf = Buffer.alloc(0); this.timer = null; this.idle = []; }
  get speaking() { return this.buf.length > 0; }
  push(pcm) { this.buf = Buffer.concat([this.buf, pcm]); this.start(); }
  clear() { this.buf = Buffer.alloc(0); }
  whenIdle() { return this.speaking || this.pendingTts ? new Promise((r) => this.idle.push(r)) : Promise.resolve(); }
  start() {
    if (this.timer) return;
    const t0 = Date.now(); let sent = 0;
    this.timer = setInterval(() => {
      const due = Math.floor((Date.now() - t0) / FRAME_MS) + 2; // keep ~40 ms queued in Asterisk
      while (sent < due && this.buf.length) {
        let chunk = this.buf.subarray(0, FRAME_BYTES); this.buf = this.buf.subarray(chunk.length);
        if (chunk.length < FRAME_BYTES) chunk = Buffer.concat([chunk, Buffer.alloc(FRAME_BYTES - chunk.length)]);
        this.write(frame(T_AUDIO, chunk)); sent++;
      }
      // A gap while speech is still arriving must not turn into a burst later.
      if (!this.buf.length) sent = Math.max(sent, due);
      if (!this.buf.length && !this.pendingTts) this.stop();
    }, FRAME_MS);
  }
  stop() {
    clearInterval(this.timer); this.timer = null;
    for (const r of this.idle.splice(0)) r();
  }
}

function createAgent({ stt, tts, llm, cccs, log = console, config = {} }) {
  const cfg = {
    maxCallMs: 10 * 60 * 1000, silenceMs: 20000, maxTurns: 40, maxToolLoops: 4,
    ...config,
  };
  const sessions = new Map(); // id -> session

  /* ---- HTTP: dialplan hooks ---- */
  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const text = (code, body) => { res.writeHead(code, { 'content-type': 'text/plain' }); res.end(body); };
    if (url.pathname === '/start') {
      const id = crypto.randomUUID();
      sessions.set(id, {
        id, callerNumber: String(url.searchParams.get('caller') || '').replace(/[^\d+]/g, '').slice(0, 20),
        callerName: String(url.searchParams.get('name') || '').slice(0, 60),
        next: 'HANGUP', createdAt: Date.now(), done: false,
      });
      setTimeout(() => sessions.delete(id), cfg.maxCallMs + 5 * 60 * 1000).unref?.();
      return text(200, id);
    }
    const m = /^\/next\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (m) { const s = sessions.get(m[1]); return text(200, s ? s.next : 'HANGUP'); }
    if (url.pathname === '/health') return text(200, 'ok');
    text(404, 'not found');
  });

  /* ---- AudioSocket: the call itself ---- */
  const audioServer = net.createServer((sock) => {
    sock.setNoDelay(true);
    let buf = Buffer.alloc(0), call = null;
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 3) {
        const type = buf[0], len = buf.readUInt16BE(1);
        if (buf.length < 3 + len) break;
        const payload = buf.subarray(3, 3 + len); buf = buf.subarray(3 + len);
        if (type === T_UUID) {
          const id = uuidFromBytes(payload);
          const s = sessions.get(id);
          if (!s) { log.warn(`[voice] unknown call ${id}`); sock.end(frame(T_HANGUP)); return; }
          call = runCall(s, sock);
        } else if (type === T_AUDIO) { if (call) call.audio(payload); }
        else if (type === T_HANGUP || type === T_ERROR) { if (call) call.finish('caller hung up'); }
      }
    });
    sock.on('close', () => { if (call) call.finish('socket closed'); });
    sock.on('error', () => {});
  });

  function runCall(s, sock) {
    const playout = new Playout((b) => { if (!sock.destroyed) sock.write(b); });
    const messages = [];           // Claude conversation
    const transcript = [];         // for the job/message record
    let heard = '', busy = false, queued = '', ended = false, silenceTimer = null, nudges = 0;
    let jobCreated = false, messageLeft = false, turns = 0;
    const outcome = { job: null, message: null };
    log.info(`[voice] call ${s.id} from ${s.callerNumber || 'withheld'}`);

    const say = async (text) => {
      if (!text || ended) return;
      transcript.push(`Assistant: ${text}`);
      playout.pendingTts = true;
      try { await tts.speak(text, (pcm) => { if (!ended) playout.push(pcm); }); }
      catch (e) { log.error(`[voice] ${s.id} TTS: ${e.message}`); }
      finally { playout.pendingTts = false; if (!playout.speaking) playout.stop(); }
    };
    const armSilence = () => {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(async () => {
        if (ended || busy) return;
        nudges += 1;
        if (nudges > 2) { await say("I haven't heard anything, so I'll end the call now. Goodbye."); return hangup('HANGUP'); }
        await say('Are you still there?');
        armSilence();
      }, cfg.silenceMs);
      silenceTimer.unref?.();
    };
    const hangup = async (next) => {
      if (ended) return;
      s.next = next;
      await playout.whenIdle();
      if (!sock.destroyed) sock.end(frame(T_HANGUP));
      finish(`assistant ended (${next})`);
    };

    let listener;
    try {
      listener = stt.open({
        onTranscript: ({ text, isFinal, endOfTurn }) => {
          if (ended) return;
          if (text && playout.speaking) playout.clear(); // caller talked over us
          if (text) { nudges = 0; armSilence(); }
          if (isFinal && text) heard += (heard ? ' ' : '') + text;
          if (endOfTurn && heard.trim()) { const u = heard.trim(); heard = ''; onUtterance(u); }
        },
        onError: (e) => { log.error(`[voice] ${s.id} STT: ${e.message}`); failSafe(); },
      });
    } catch (e) { log.error(`[voice] ${s.id} STT open: ${e.message}`); }

    const maxTimer = setTimeout(async () => {
      await say("I'm sorry, I need to end the call now. I'll pass your details to the team.");
      hangup('HANGUP');
    }, cfg.maxCallMs);
    maxTimer.unref?.();

    async function failSafe() {
      if (ended) return;
      await say("Sorry, I'm having trouble on this line. I'll put you through to the duty officer now.");
      hangup('TRANSFER');
    }

    async function onUtterance(text) {
      if (busy) { queued += (queued ? ' ' : '') + text; return; }
      busy = true;
      transcript.push(`Caller: ${text}`);
      messages.push({ role: 'user', content: text });
      try {
        if (++turns > cfg.maxTurns) { await say("Thanks, I've got everything I need. Someone will be in touch. Goodbye."); return hangup('HANGUP'); }
        await converse();
      } catch (e) {
        log.error(`[voice] ${s.id} AI: ${e.message}`);
        await failSafe();
      } finally {
        busy = false;
        if (queued && !ended) { const q = queued; queued = ''; onUtterance(q); }
      }
    }

    async function converse() {
      const system = systemPrompt({ callerNumber: s.callerNumber });
      for (let loop = 0; loop <= cfg.maxToolLoops; loop++) {
        const res = await llm.reply({ system, messages, tools: TOOLS });
        const content = res.content || [];
        messages.push({ role: 'assistant', content });
        const spoken = content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
        const uses = content.filter((b) => b.type === 'tool_use');
        if (spoken) await say(spoken);
        if (!uses.length) return;
        const results = [];
        let finalAction = null;
        for (const u of uses) {
          const out = await runTool(u.name, u.input || {});
          if (out.action) finalAction = out.action;
          results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out.result) });
        }
        messages.push({ role: 'user', content: results });
        if (finalAction) return hangup(finalAction);
      }
      throw new Error('too many tool steps');
    }

    async function runTool(name, input) {
      const base = { call_id: s.id, caller_number: input.callback_number || s.callerNumber, caller_name: input.caller_name || s.callerName };
      try {
        switch (name) {
          case 'find_site': return { result: await cccs.findSites(String(input.query || '')) };
          case 'create_job': {
            if (jobCreated) return { result: { ok: true, note: 'A job has already been raised for this call.' } };
            const job = await cccs.createJob({ ...base, site_id: input.site_id, location: input.location,
              incident_type: input.incident_type, priority: input.priority, description: input.description,
              transcript: transcript.join('\n') });
            jobCreated = true; outcome.job = job.reference;
            log.info(`[voice] ${s.id} raised ${job.reference} (${job.priority})`);
            return { result: { ok: true, reference: job.reference } };
          }
          case 'take_message': {
            if (messageLeft) return { result: { ok: true, note: 'Message already left.' } };
            await cccs.leaveMessage({ ...base, message: String(input.message || '') });
            messageLeft = true; outcome.message = true;
            return { result: { ok: true } };
          }
          case 'transfer_to_on_call':
            transcript.push(`[Transferred to on-call: ${input.reason || ''}]`);
            return { result: { ok: true }, action: 'TRANSFER' };
          case 'end_call': return { result: { ok: true }, action: 'HANGUP' };
          default: return { result: { error: `unknown tool ${name}` } };
        }
      } catch (e) {
        log.error(`[voice] ${s.id} tool ${name}: ${e.message}`);
        return { result: { error: 'The control room system did not respond. Offer to put the caller through to the duty officer.' } };
      }
    }

    function finish(why) {
      if (ended) return;
      ended = true; s.done = true;
      clearTimeout(silenceTimer); clearTimeout(maxTimer);
      playout.clear(); playout.stop();
      try { listener && listener.close(); } catch {}
      log.info(`[voice] call ${s.id} ended: ${why}${outcome.job ? `, job ${outcome.job}` : ''}`);
      // Safety net: nothing should be lost because the call dropped or the
      // caller hung up before the assistant could file it.
      const said = transcript.some((l) => l.startsWith('Caller:'));
      if (!jobCreated && !messageLeft && s.next !== 'TRANSFER' && said) {
        cccs.leaveMessage({ call_id: s.id, caller_number: s.callerNumber, caller_name: s.callerName,
          message: `Call ended before details were complete. Transcript: ${transcript.join(' | ')}`.slice(0, 900) })
          .catch((e) => log.error(`[voice] ${s.id} fallback message: ${e.message}`));
      }
    }

    // Open with the greeting, then listen.
    say(GREETING).then(armSilence);
    return { audio: (pcm) => { if (listener && !ended) listener.send(pcm); }, finish };
  }

  return {
    httpServer, audioServer, sessions,
    listen({ httpPort = 8091, audioPort = 9092, host = '0.0.0.0' } = {}) {
      return Promise.all([
        new Promise((r) => httpServer.listen(httpPort, host, r)),
        new Promise((r) => audioServer.listen(audioPort, host, r)),
      ]);
    },
    close() { httpServer.close(); audioServer.close(); },
  };
}

module.exports = { createAgent, frame, uuidFromBytes, FRAME_BYTES, T_HANGUP, T_UUID, T_AUDIO };

if (require.main === module) {
  const { deepgramStt, deepgramTts, claudeLlm, cccsClient } = require('./providers.js');
  for (const k of ['ANTHROPIC_API_KEY', 'DEEPGRAM_API_KEY', 'VOICE_SECRET', 'CCCS_URL']) {
    if (!process.env[k]) { console.error(`[voice] ${k} is not set — see voice-agent/.env.example`); process.exit(1); }
  }
  const agent = createAgent({ stt: deepgramStt(), tts: deepgramTts(), llm: claudeLlm(), cccs: cccsClient() });
  const httpPort = Number(process.env.AGENT_HTTP_PORT || 8091), audioPort = Number(process.env.AGENT_AUDIO_PORT || 9092);
  agent.listen({ httpPort, audioPort, host: process.env.AGENT_HOST || '0.0.0.0' })
    .then(() => console.log(`[voice] Echelon phone assistant ready — dialplan hooks :${httpPort}, AudioSocket :${audioPort}`));
}
