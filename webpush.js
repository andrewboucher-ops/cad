/**
 * Web Push, hand-rolled against RFC 8291 (message encryption) and RFC 8292
 * (VAPID), using only Node's built-in `crypto` — same reasoning as msauth.js:
 * this stays zero-dependency rather than pulling in the `web-push` package.
 *
 * This is what lets an iPhone with the console added to its home screen (or
 * any browser with it installed as a PWA) get a real notification — emergency,
 * incoming call, job dispatch — while the app isn't open. No App Store, no
 * APNs account: Apple's WebKit team implemented the same open Push API Chrome
 * and Firefox use, so this one implementation reaches every platform.
 */
'use strict';

const crypto = require('crypto');
const https = require('https');
const { URL } = require('url');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (str) => Buffer.from(str, 'base64url');

let state = null; // { publicKey, privateKey, publicRaw, subject }

function generateKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { publicJwk: publicKey.export({ format: 'jwk' }), privateJwk: privateKey.export({ format: 'jwk' }) };
}

function keysFromJwk(publicJwk, privateJwk) {
  const publicKey = crypto.createPublicKey({ key: publicJwk, format: 'jwk' });
  const privateKey = crypto.createPrivateKey({ key: privateJwk, format: 'jwk' });
  const publicRaw = Buffer.concat([Buffer.from([0x04]), fromB64u(publicJwk.x), fromB64u(publicJwk.y)]);
  return { publicKey, privateKey, publicRaw };
}

/** Loads the VAPID keypair from durable storage, generating one on first run.
 * A subscription is only valid for the key it was created against, so this
 * must not change under a browser that already subscribed. */
function init(store, subject) {
  let saved = null;
  try {
    const raw = store.getMeta && store.getMeta('vapid_keys');
    if (raw) saved = JSON.parse(raw);
  } catch { /* corrupt or missing — fall through and regenerate */ }

  let publicJwk, privateJwk;
  if (saved && saved.publicJwk && saved.privateJwk) {
    ({ publicJwk, privateJwk } = saved);
  } else {
    ({ publicJwk, privateJwk } = generateKeys());
    try { store.setMeta && store.setMeta('vapid_keys', JSON.stringify({ publicJwk, privateJwk })); } catch { /* in-memory mode */ }
    console.log('[webpush] generated a new VAPID keypair');
  }
  const { publicKey, privateKey, publicRaw } = keysFromJwk(publicJwk, privateJwk);
  state = { publicKey, privateKey, publicRaw, subject: subject || 'mailto:admin@example.com' };
  return state;
}

function getPublicKeyBase64Url() {
  if (!state) throw new Error('webpush.init() was not called');
  return b64u(state.publicRaw);
}

/** RFC 8292 — proves to the push service which server this is, without an account. */
function vapidAuthorization(audience) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64u(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: state.subject }));
  const signingInput = `${header}.${payload}`;
  // ieee-p1363 gives the raw r||s pair a JWS needs, not crypto.sign's default DER SEQUENCE.
  const sig = crypto.sign('sha256', Buffer.from(signingInput), { key: state.privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${signingInput}.${b64u(sig)}, k=${b64u(state.publicRaw)}`;
}

/** RFC 8291 — encrypts one message for one subscriber. Single-record aes128gcm,
 * no padding beyond the mandatory delimiter: these are short JSON payloads,
 * not a case where traffic analysis of the length is a real concern. */
function encrypt(plaintext, p256dhB64u, authB64u) {
  const uaPublic = fromB64u(p256dhB64u);
  const authSecret = fromB64u(authB64u);

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey(); // uncompressed point, 65 bytes
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  const salt = crypto.randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));

  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const padded = Buffer.concat([plaintext, Buffer.from([0x02])]); // last-record delimiter, RFC 8188 §2
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1 + asPublic.length);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16); // record size — only needs to exceed this message's length
  header.writeUInt8(asPublic.length, 20);
  asPublic.copy(header, 21);

  return Buffer.concat([header, ciphertext]);
}

/** Sends one notification. Resolves (never rejects on a push-service error)
 * with { ok, status, expired } — `expired` means the subscription is dead
 * (404/410) and the caller should stop using it. */
function sendNotification(subscription, payloadObj, opts = {}) {
  return new Promise((resolve, reject) => {
    if (!state) return reject(new Error('webpush.init() was not called'));
    const { endpoint, keys } = subscription;
    if (!endpoint || !keys || !keys.p256dh || !keys.auth) return reject(new Error('invalid push subscription'));

    let body;
    try { body = encrypt(Buffer.from(JSON.stringify(payloadObj)), keys.p256dh, keys.auth); }
    catch (e) { return reject(e); }

    const endpointUrl = new URL(endpoint);
    const req = https.request({
      method: 'POST',
      hostname: endpointUrl.hostname,
      port: endpointUrl.port || 443,
      path: endpointUrl.pathname + endpointUrl.search,
      headers: {
        'content-type': 'application/octet-stream',
        'content-encoding': 'aes128gcm',
        'content-length': body.length,
        ttl: String(opts.ttl || 86400),
        urgency: opts.urgency || 'normal',
        authorization: vapidAuthorization(`${endpointUrl.protocol}//${endpointUrl.host}`),
      },
    }, (res) => {
      res.resume(); // drain, we don't need the body
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        expired: res.statusCode === 404 || res.statusCode === 410,
      }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { init, getPublicKeyBase64Url, sendNotification };
