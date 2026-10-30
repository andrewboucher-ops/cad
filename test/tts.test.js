/* Phone prompts from the VoiceStudio TTS server, cached on disk (tts.js) — node --test */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTts } = require('../tts.js');

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cccs-tts-'));
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, opts, body: JSON.parse(opts.body) }); return new Response(Buffer.from('RIFF-24k')); };
  const convert = async (src, out) => fs.writeFileSync(out, Buffer.concat([Buffer.from('8k:'), fs.readFileSync(src)]));
  return { dir, calls, tts: createTts({ apiKey: 'k', dir, fetchImpl, convert }) };
}

test('tts: asks the server with the Echelon voice, converts, and only calls again when the text changes', async () => {
  const { calls, tts } = rig();
  const a = await tts.clip('Thank you. Stay safe.');
  assert.equal(fs.readFileSync(a, 'utf8'), '8k:RIFF-24k', 'the converted clip is what is kept');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.headers.authorization, 'Bearer k');
  assert.deepEqual(calls[0].body, { model: 'tts-1', input: 'Thank you. Stay safe.', voice: 'expr-voice-2-f', speed: 1.4, response_format: 'wav' });
  assert.equal(await tts.clip('Thank you. Stay safe.'), a);
  assert.equal(calls.length, 1, 'cached — no second request for the same words');
  await Promise.all([tts.clip('Hello Dan'), tts.clip('Hello Dan')]);
  assert.equal(calls.length, 2, 'new words — one request, even asked for twice at once');
});

test('tts: off without a key, and a server error leaves nothing half-written in the cache', async () => {
  assert.equal(createTts({ apiKey: '' }).configured(), false);
  await assert.rejects(createTts({ apiKey: '' }).clip('x'), /not configured/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cccs-tts-'));
  const tts = createTts({ apiKey: 'k', dir, fetchImpl: async () => new Response('no', { status: 401 }), convert: async () => {} });
  await assert.rejects(tts.clip('x'), /401/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('tts: cached() says whether a clip is ready without making it', async () => {
  const { calls, tts } = rig();
  assert.equal(tts.cached('Hello Dan'), null);
  assert.equal(calls.length, 0, 'asking does not call the server');
  const f = await tts.clip('Hello Dan');
  assert.equal(tts.cached('Hello Dan'), f);
});

test('tts: one request at a time, and a 429 is waited out and retried', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cccs-tts-'));
  let live = 0, peak = 0, n = 0;
  const waits = [];
  const fetchImpl = async () => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
    n++;
    return n === 1 ? new Response('slow down', { status: 429, headers: { 'retry-after': '3' } }) : new Response(Buffer.from('RIFF'));
  };
  const tts = createTts({ apiKey: 'k', dir, fetchImpl, convert: async (src, out) => fs.copyFileSync(src, out), sleep: async (ms) => { waits.push(ms); } });
  await Promise.all(['one', 'two', 'three'].map((t) => tts.clip(t)));
  assert.equal(peak, 1, 'never more than one request in flight');
  assert.deepEqual(waits, [3000], 'Retry-After honoured');
  assert.equal(n, 4, 'three clips, one retried');
  const gaveUp = createTts({ apiKey: 'k', dir, fetchImpl: async () => new Response('no', { status: 429 }), convert: async () => {}, sleep: async () => {} });
  await assert.rejects(gaveUp.clip('four'), /429/);
});

test('tts: a 24 kHz WAV becomes 8 kHz mono 16-bit PCM for the PBX, with no ffmpeg', () => {
  const { toPbxWav } = require('../tts.js');
  const wavOf = ({ rate, channels, bits, format = 1, samples }) => {
    const bytes = bits / 8, data = Buffer.alloc(samples.length * channels * bytes);
    samples.forEach((v, i) => { for (let c = 0; c < channels; c++) {
      const o = (i * channels + c) * bytes;
      if (format === 3) data.writeFloatLE(v, o); else data.writeInt16LE(Math.round(v * 32767), o);
    } });
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
    h.writeUInt16LE(format, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * bytes, 28);
    h.writeUInt16LE(channels * bytes, 32); h.writeUInt16LE(bits, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
    return Buffer.concat([h, data]);
  };
  const tone = Array.from({ length: 24000 }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 440 * i / 24000)); // 1 s of 440 Hz
  for (const src of [wavOf({ rate: 24000, channels: 1, bits: 16, samples: tone }), wavOf({ rate: 24000, channels: 2, bits: 32, format: 3, samples: tone })]) {
    const out = toPbxWav(src);
    assert.equal(out.toString('ascii', 0, 4), 'RIFF');
    assert.equal(out.readUInt16LE(20), 1, 'PCM');
    assert.equal(out.readUInt16LE(22), 1, 'mono');
    assert.equal(out.readUInt32LE(24), 8000);
    assert.equal(out.readUInt16LE(34), 16);
    const n = out.readUInt32LE(40) / 2;
    assert.equal(n, 8000, 'still one second long');
    let peak = 0; for (let i = 100; i < n - 100; i++) peak = Math.max(peak, Math.abs(out.readInt16LE(44 + i * 2)) / 32767);
    assert.ok(peak > 0.45 && peak < 0.55, `the tone survives at the same level (peak ${peak})`);
  }
  assert.throws(() => toPbxWav(Buffer.from('not audio')), /not send a WAV/);
});
