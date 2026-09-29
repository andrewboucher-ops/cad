/**
 * SMS via Twilio, hand-rolled against the REST API using only Node's built-in
 * `fetch` — same reasoning as msauth.js and webpush.js: this stays
 * zero-dependency rather than pulling in the `twilio` npm package.
 *
 * This is what makes the control room's click-to-SMS button real. A `tel:`
 * link can only ever record that an operator *pressed* dial — the browser
 * gives no callback when a call connects, is answered, or lasts ten seconds.
 * SMS is different: Twilio returns a message SID immediately and then calls
 * back with the delivery outcome, so the audit trail can carry a genuine
 * two-stage record (queued -> delivered/undelivered/failed) rather than an
 * attempt dressed up as a result. See the note on `recordStatusCallback`.
 *
 * SAFETY. Defaults to LOGGING ONLY. Nothing is sent until SMS_LIVE is
 * explicitly on, because this is wired into a dispatch console that real
 * officers carry — an accidental send is a real text to a real phone, and a
 * misconfigured one during bring-up could go to a stranger. With SMS_LIVE
 * off, send() logs exactly what it *would* have sent and returns a
 * synthesised SID-shaped result, so the whole call path, the audit trail and
 * the UI can all be exercised end to end without a single message leaving the
 * building. That is the mode to develop against.
 */
'use strict';

const crypto = require('crypto');

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || '';
const MESSAGING_SERVICE_SID = process.env.TWILIO_MESSAGING_SERVICE_SID || '';

// Deliberately its own flag rather than inferring "configured therefore live".
// Credentials present is not consent to send; an operator must opt in.
const LIVE = process.env.SMS_LIVE === 'on';

// Where Twilio should POST delivery status. Must be the *public* URL of this
// server, because Twilio's signature is computed over the URL it called — a
// reverse proxy that rewrites the host or path will make every callback fail
// validation, which is the single most common reason a delivery callback
// silently stops arriving.
const STATUS_CALLBACK_URL = process.env.SMS_STATUS_CALLBACK_URL || '';

const API_BASE = 'https://api.twilio.com/2010-04-01';

const configured = () => Boolean(ACCOUNT_SID && AUTH_TOKEN && (FROM_NUMBER || MESSAGING_SERVICE_SID));

/** E.164 or nothing. Twilio will happily accept a local-format number and
 * interpret it against the account's own country, which is how a UK console
 * ends up texting a US number that happens to share the digits after the
 * leading zero. Requiring an explicit country code removes the guess.
 */
function normalizeNumber(raw) {
  const s = String(raw || '').trim().replace(/[\s()\-]/g, '');
  if (!s) return null;
  if (s.startsWith('+')) return /^\+\d{7,15}$/.test(s) ? s : null;
  // A bare UK mobile (07...) is the one local form worth accepting, because
  // it is what control actually has in front of them on the personnel record.
  if (/^0\d{9,10}$/.test(s)) return `+44${s.slice(1)}`;
  return null;
}

/**
 * Validates a Twilio request signature. Twilio signs `url + sorted(form params
 * concatenated as key+value)` with HMAC-SHA1 over the account auth token.
 *
 * The usual mistake is signing the raw request body instead. That happens to
 * look like it works during naive testing and then fails for every request
 * carrying a parameter Twilio sorts differently — i.e. most of them. This
 * reconstructs from the *parsed* params in the order Twilio sorted them.
 *
 * @param {string} signature   value of the X-Twilio-Signature header
 * @param {string} url         the exact URL Twilio called, including query
 * @param {object} params      parsed form parameters from the request body
 * @returns {boolean}
 */
function verifySignature(signature, url, params = {}) {
  if (!AUTH_TOKEN) return false;
  if (!signature || typeof signature !== 'string') return false;

  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);

  const expected = crypto.createHmac('sha1', AUTH_TOKEN).update(Buffer.from(data, 'utf8')).digest('base64');

  // Constant-time compare, and length-checked first because timingSafeEqual
  // throws on a length mismatch rather than returning false.
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Sends one SMS. Never throws for a transport or API error — resolves with
 * { ok, sid, status, error } so a failed text cannot break the REST call or
 * audit write it rides along with. (Same contract as webpush.sendNotification,
 * for the same reason.)
 *
 * @param {object} args
 * @param {string} args.to      destination number (any format; normalised here)
 * @param {string} args.body    message text
 * @param {string} [args.label] free-text tag for the log line, e.g. 'P102'
 */
async function send({ to, body, label } = {}) {
  const dest = normalizeNumber(to);
  if (!dest) return { ok: false, error: `unusable destination number: ${to}`, dryRun: !LIVE };
  const text = String(body || '').trim();
  if (!text) return { ok: false, error: 'empty message body', dryRun: !LIVE };
  // Twilio rejects a body over 1600 characters with error 21617. Catch it here
  // so the operator gets a clear message instead of a failed send.
  if (text.length > 1600) return { ok: false, error: `message too long (${text.length}/1600)`, dryRun: !LIVE };

  if (!LIVE) {
    const fakeSid = `SM${crypto.randomBytes(16).toString('hex')}`;
    console.log(`[sms] DRY RUN (SMS_LIVE is not on) — would send to ${dest}${label ? ` (${label})` : ''}: ${text}`);
    return { ok: true, sid: fakeSid, status: 'dry-run', dryRun: true };
  }

  if (!configured()) {
    return { ok: false, error: 'Twilio is not configured (need TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID)' };
  }

  const form = new URLSearchParams();
  form.set('To', dest);
  form.set('Body', text);
  // A Messaging Service is preferable where one exists: it carries the
  // sender pool and the opt-out handling, so replies route correctly.
  if (MESSAGING_SERVICE_SID) form.set('MessagingServiceSid', MESSAGING_SERVICE_SID);
  else form.set('From', FROM_NUMBER);
  if (STATUS_CALLBACK_URL) form.set('StatusCallback', STATUS_CALLBACK_URL);

  try {
    const res = await fetch(`${API_BASE}/Accounts/${ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });
    const out = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = (out && (out.message || out.error_message)) || `${res.status} ${res.statusText}`;
      console.warn(`[sms] send failed (${res.status}):`, msg);
      return { ok: false, error: msg, httpStatus: res.status };
    }
    return { ok: true, sid: out.sid, status: out.status || 'queued' };
  } catch (e) {
    console.warn('[sms] send threw:', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Extracts the delivery outcome from a Twilio status callback. This is the
 * whole reason SMS can carry an honest audit trail where click-to-dial cannot:
 * `delivered` means the handset acknowledged it, and `undelivered`/`failed`
 * carry an error code worth surfacing to whoever is trying to reach the
 * officer.
 *
 * Twilio sends status callbacks as application/x-www-form-urlencoded — this
 * expects the parsed body, not JSON. It also sends several statuses for one
 * message (queued, sent, delivered), so callers should treat this as an
 * update to an existing log row keyed on `sid`, not as a new event.
 *
 * @param {object} params parsed form body from the callback request
 */
function parseStatusCallback(params = {}) {
  const sid = params.MessageSid || params.SmsSid || null;
  const status = params.MessageStatus || params.SmsStatus || null;
  const errorCode = params.ErrorCode ? String(params.ErrorCode) : null;
  return {
    sid,
    status,
    errorCode,
    // Sorted worst-first so a caller can log one honest line: a message that
    // reached 'delivered' and then arrived at an undelivered webhook is a
    // retry, and reporting the older success would be the wrong story.
    failed: ['failed', 'undelivered'].includes(String(status || '').toLowerCase()),
    to: params.To || null,
    from: params.From || null,
  };
}

/** True once a message has reached a terminal state and needs no more updates. */
const isTerminalStatus = (status) => ['delivered', 'undelivered', 'failed'].includes(String(status || '').toLowerCase());

module.exports = {
  send, verifySignature, parseStatusCallback, isTerminalStatus, normalizeNumber,
  configured, live: LIVE, STATUS_CALLBACK_URL,
};
