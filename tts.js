/**
 * Spoken prompts for phone calls, from the self-hosted VoiceStudio TTS
 * server (OpenAI-style POST /v1/audio/speech, on the LAN).
 *
 * The server returns 24 kHz WAV; the PBX wants 8 kHz mono 16-bit PCM, so
 * every clip goes through ffmpeg once. Clips are cached on disk under a hash
 * of their text and voice settings — the API is only called when the
 * wording (or, for a personal line, the name) changes. The cache sits next
 * to the database so a deploy doesn't wipe it.
 *
 * Off (configured() false) until TTS_API_KEY is set.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function createTts({
  url = process.env.TTS_URL || 'http://192.168.7.201:3900/v1/audio/speech',
  apiKey = process.env.TTS_API_KEY || '',
  model = process.env.TTS_MODEL || 'tts-1',
  voice = process.env.TTS_VOICE || 'expr-voice-2-f',
  speed = Number(process.env.TTS_SPEED || 1.4),
  dir = process.env.TTS_DIR || path.join(path.dirname(process.env.DATA_FILE || path.join(__dirname, 'data', 'cccs.db')), 'tts'),
  ffmpeg = process.env.TTS_FFMPEG || 'ffmpeg',
  timeoutMs = 15000,
  fetchImpl = (...a) => fetch(...a),
  // (input wav path, output wav path) → Promise. Swappable for tests.
  convert = (src, out) => new Promise((resolve, reject) => {
    execFile(ffmpeg, ['-y', '-loglevel', 'error', '-i', src, '-ar', '8000', '-ac', '1', '-acodec', 'pcm_s16le', out], { timeout: 30000 },
      (err, _o, stderr) => (err ? reject(new Error(`ffmpeg: ${String(stderr || err.message).trim().slice(0, 200)}`)) : resolve()));
  }),
} = {}) {
  const inFlight = new Map();
  const keyOf = (text) => crypto.createHash('sha256').update(JSON.stringify({ text, model, voice, speed })).digest('hex').slice(0, 24);

  /** Path to an 8 kHz WAV of `text`, made (and cached) if it isn't already. */
  async function clip(text) {
    if (!apiKey) throw new Error('TTS is not configured (TTS_API_KEY)');
    const file = path.join(dir, `${keyOf(text)}.wav`);
    if (fs.existsSync(file)) return file;
    if (inFlight.has(file)) return inFlight.get(file);
    const job = (async () => {
      fs.mkdirSync(dir, { recursive: true });
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: text, voice, speed, response_format: 'wav' }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`TTS server answered ${res.status}`);
      const raw = Buffer.from(await res.arrayBuffer());
      const tmpIn = `${file}.${process.pid}.src.wav`, tmpOut = `${file}.${process.pid}.tmp.wav`;
      fs.writeFileSync(tmpIn, raw);
      try { await convert(tmpIn, tmpOut); fs.renameSync(tmpOut, file); }
      finally { fs.rmSync(tmpIn, { force: true }); fs.rmSync(tmpOut, { force: true }); }
      return file;
    })();
    inFlight.set(file, job);
    try { return await job; } finally { inFlight.delete(file); }
  }

  return { configured: () => Boolean(apiKey), clip, dir };
}

module.exports = { createTts };
