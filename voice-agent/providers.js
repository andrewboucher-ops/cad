'use strict';
/* The outside services the phone agent talks to. Each is a small object with
 * one or two methods so the agent can be tested with fakes and a provider can
 * be swapped (e.g. a self-hosted speech model later) without touching agent.js.
 *
 *   stt.open({ onTranscript({ text, isFinal, endOfTurn }), onError(e) }) -> { send(pcm), close() }
 *   tts.speak(text, onChunk(pcm)) -> Promise   (8 kHz 16-bit mono PCM)
 *   llm.reply({ system, messages, tools }) -> Claude Messages API response
 *   cccs.findSites(q) / createJob(p) / leaveMessage(p)
 *
 * Speech runs on Deepgram's EU endpoint by default so call audio is processed
 * in the EU. Node 22's built-in WebSocket and fetch only — no dependencies. */

const DG_HOST = process.env.DEEPGRAM_HOST || 'api.eu.deepgram.com';

function deepgramStt() {
  const key = process.env.DEEPGRAM_API_KEY;
  return {
    open({ onTranscript, onError }) {
      const qs = new URLSearchParams({
        model: process.env.STT_MODEL || 'nova-3', language: 'en-GB', encoding: 'linear16', sample_rate: '8000', channels: '1',
        interim_results: 'true', endpointing: process.env.STT_ENDPOINTING_MS || '500', utterance_end_ms: '1200',
        smart_format: 'true', punctuate: 'true',
      });
      const ws = new WebSocket(`wss://${DG_HOST}/v1/listen?${qs}`, ['token', key]);
      ws.binaryType = 'arraybuffer';
      const backlog = [];
      ws.onopen = () => { for (const b of backlog.splice(0)) ws.send(b); };
      ws.onerror = (e) => onError(new Error(`speech-to-text connection failed${e && e.message ? `: ${e.message}` : ''}`));
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
        if (m.type === 'Results') {
          const text = (m.channel && m.channel.alternatives && m.channel.alternatives[0] && m.channel.alternatives[0].transcript) || '';
          onTranscript({ text, isFinal: Boolean(m.is_final), endOfTurn: Boolean(m.speech_final) });
        } else if (m.type === 'UtteranceEnd') {
          onTranscript({ text: '', isFinal: true, endOfTurn: true });
        }
      };
      return {
        send(pcm) {
          if (ws.readyState === 1) ws.send(pcm);
          else if (ws.readyState === 0 && backlog.length < 250) backlog.push(pcm); // ~5 s while connecting
        },
        close() {
          try { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'CloseStream' })); } catch {}
          setTimeout(() => { try { ws.close(); } catch {} }, 500).unref?.();
        },
      };
    },
  };
}

function deepgramTts() {
  const key = process.env.DEEPGRAM_API_KEY;
  return {
    async speak(text, onChunk) {
      const qs = new URLSearchParams({ model: process.env.TTS_VOICE || 'aura-2-pandora-en', encoding: 'linear16', sample_rate: '8000', container: 'none' });
      const res = await fetch(`https://${DG_HOST}/v1/speak?${qs}`, {
        method: 'POST', headers: { authorization: `Token ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok || !res.body) throw new Error(`text-to-speech failed (${res.status})`);
      let carry = null; // keep 16-bit samples whole across chunk boundaries
      for await (const part of res.body) {
        let buf = Buffer.from(part);
        if (carry) { buf = Buffer.concat([carry, buf]); carry = null; }
        if (buf.length % 2) { carry = buf.subarray(buf.length - 1); buf = buf.subarray(0, buf.length - 1); }
        if (buf.length) onChunk(buf);
      }
    },
  };
}

function claudeLlm() {
  const base = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  return {
    async reply({ system, messages, tools }) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), Number(process.env.VOICE_LLM_TIMEOUT_MS || 15000));
      try {
        const res = await fetch(`${base}/v1/messages`, {
          method: 'POST', signal: ctrl.signal,
          headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: process.env.VOICE_MODEL || 'claude-haiku-5-5', max_tokens: 400, system, messages, tools }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`AI error ${res.status}: ${(body.error && body.error.message) || 'unknown'}`);
        return body;
      } finally { clearTimeout(t); }
    },
  };
}

function cccsClient() {
  const base = (process.env.CCCS_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json', 'x-voice-secret': process.env.VOICE_SECRET || '' };
  const go = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `CCCS ${res.status}`);
    return out;
  };
  return {
    findSites: (q) => go('GET', `/api/integrations/voice/sites?q=${encodeURIComponent(q)}`),
    createJob: (p) => go('POST', '/api/integrations/voice/jobs', p),
    leaveMessage: (p) => go('POST', '/api/integrations/voice/messages', p),
  };
}

module.exports = { deepgramStt, deepgramTts, claudeLlm, cccsClient };
