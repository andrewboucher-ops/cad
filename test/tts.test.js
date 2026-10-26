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
