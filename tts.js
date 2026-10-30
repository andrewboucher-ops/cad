/**
 * Spoken prompts for phone calls, from the self-hosted VoiceStudio TTS
 * server (OpenAI-style POST /v1/audio/speech, on the LAN).
 *
 * The server returns 24 kHz WAV; the PBX wants 8 kHz mono 16-bit PCM, so
 * every clip is resampled once, here in JS (toPbxWav below). It used to go
 * through ffmpeg, which install.sh never installed — without it every clip
 * fails and the officer hears only the PBX's beep. Clips are cached on disk under a hash
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

/** Reads a WAV (PCM 8/16/24/32-bit or float, any rate, any channels) and
 * returns it as 8 kHz mono 16-bit PCM WAV — what Asterisk plays as .wav. */
function toPbxWav(buf, outRate = 8000) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('TTS server did not send a WAV');
  let fmt = null, data = null;
  for (let o = 12; o + 8 <= buf.length;) {
    const id = buf.toString('ascii', o, o + 4);
    let size = buf.readUInt32LE(o + 4);
    if (id === 'data' && (size === 0 || size === 0xffffffff || o + 8 + size > buf.length)) size = buf.length - o - 8; // streamed WAVs leave the size unset
    if (id === 'fmt ') {
      let format = buf.readUInt16LE(o + 8);
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(o + 32); // WAVE_FORMAT_EXTENSIBLE: the real format is the sub-format GUID's first two bytes
      fmt = { format, channels: buf.readUInt16LE(o + 10), rate: buf.readUInt32LE(o + 12), bits: buf.readUInt16LE(o + 22) };
    } else if (id === 'data') { data = buf.subarray(o + 8, o + 8 + size); break; }
    o += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('TTS WAV has no audio');
  const { format, channels, rate, bits } = fmt;
  const bytes = bits / 8, frame = bytes * channels;
  if (!channels || !rate || ![1, 3].includes(format) || (format === 3 ? bits !== 32 && bits !== 64 : ![8, 16, 24, 32].includes(bits))) throw new Error(`TTS WAV format not supported (format ${format}, ${bits}-bit)`);
  const read = format === 3
    ? (o) => (bits === 32 ? data.readFloatLE(o) : data.readDoubleLE(o))
    : bits === 8 ? (o) => (data[o] - 128) / 128
      : bits === 16 ? (o) => data.readInt16LE(o) / 32768
        : bits === 24 ? (o) => data.readIntLE(o, 3) / 8388608
          : (o) => data.readInt32LE(o) / 2147483648;
  const n = Math.floor(data.length / frame);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) { let v = 0; for (let c = 0; c < channels; c++) v += read(i * frame + c * bytes); mono[i] = v / channels; }
  // Windowed-sinc low-pass + resample, cut off just under the new Nyquist.
  const ratio = rate / outRate, cutoff = Math.min(1, 1 / ratio) * 0.95, half = 16;
  const reach = Math.ceil(half * Math.max(1, ratio));
  const outN = Math.floor(n / ratio);
  const pcm = Buffer.alloc(outN * 2);
  for (let j = 0; j < outN; j++) {
    const t = j * ratio, centre = Math.floor(t);
    let acc = 0, norm = 0;
    for (let k = centre - reach + 1; k <= centre + reach; k++) {
      if (k < 0 || k >= n) continue;
      const x = (k - t) * cutoff;
      if (Math.abs(x) >= half) continue;
      const w = (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * (0.5 + 0.5 * Math.cos(Math.PI * x / half));
      acc += mono[k] * w; norm += w;
    }
    const v = norm ? acc / norm : 0;
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), j * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii'); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii'); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(outRate, 24); head.writeUInt32LE(outRate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii'); head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

function createTts({
  url = process.env.TTS_URL || 'http://192.168.7.201:3900/v1/audio/speech',
  apiKey = (process.env.TTS_API_KEY || '').trim(), // a pasted key often brings a stray space or CR
  model = process.env.TTS_MODEL || 'tts-1',
  voice = process.env.TTS_VOICE || 'expr-voice-2-f',
  speed = Number(process.env.TTS_SPEED || 1.4),
  dir = process.env.TTS_DIR || path.join(path.dirname(process.env.DATA_FILE || path.join(__dirname, 'data', 'cccs.db')), 'tts'),
  timeoutMs = 45000, // one clip took 14 s on live — leave room
  retries = 3,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  fetchImpl = (...a) => fetch(...a),
  // (input wav path, output wav path) → Promise. Swappable for tests.
  convert = async (src, out) => fs.writeFileSync(out, toPbxWav(fs.readFileSync(src))),
} = {}) {
  const inFlight = new Map();
  // One request at a time: the server rate-limits (429) when several clips
  // are asked for at once, as at start-up.
  let queue = Promise.resolve();
  const inTurn = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };
  async function speak(text) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: text, voice, speed, response_format: 'wav' }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      if ((res.status !== 429 && res.status < 500) || attempt >= retries) throw new Error(`TTS server answered ${res.status}`);
      const after = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : 2000 * 2 ** attempt);
    }
  }
  const keyOf = (text) => crypto.createHash('sha256').update(JSON.stringify({ text, model, voice, speed })).digest('hex').slice(0, 24);

  /** Path to the cached clip of `text`, or null if it hasn't been made yet. */
  function cached(text) {
    const file = path.join(dir, `${keyOf(text)}.wav`);
    return fs.existsSync(file) ? file : null;
  }

  /** Path to an 8 kHz WAV of `text`, made (and cached) if it isn't already. */
  async function clip(text) {
    if (!apiKey) throw new Error('TTS is not configured (TTS_API_KEY)');
    const file = path.join(dir, `${keyOf(text)}.wav`);
    if (fs.existsSync(file)) return file;
    if (inFlight.has(file)) return inFlight.get(file);
    const job = (async () => {
      fs.mkdirSync(dir, { recursive: true });
      const raw = await inTurn(() => speak(text));
      const tmpIn = `${file}.${process.pid}.src.wav`, tmpOut = `${file}.${process.pid}.tmp.wav`;
      fs.writeFileSync(tmpIn, raw);
      try { await convert(tmpIn, tmpOut); fs.renameSync(tmpOut, file); }
      finally { fs.rmSync(tmpIn, { force: true }); fs.rmSync(tmpOut, { force: true }); }
      return file;
    })();
    inFlight.set(file, job);
    try { return await job; } finally { inFlight.delete(file); }
  }

  return { configured: () => Boolean(apiKey), clip, cached, dir };
}

module.exports = { createTts, toPbxWav };
