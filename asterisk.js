/**
 * Asterisk Manager Interface (AMI) client for FreePBX click-to-dial.
 *
 * Raw TCP via Node's built-in `net` — same zero-dependency reasoning as
 * msauth.js, webpush.js and sms.js. AMI is a line-oriented text protocol:
 * actions go out as `Key: value` blocks terminated by a blank line, and
 * responses/events come back the same way. No framing library needed.
 *
 * WHY THIS EXISTS AT ALL. A `tel:` link gives the browser no callback — an
 * operator who clicked and reached voicemail is indistinguishable in the log
 * from one whose call was answered for ten minutes. Originating the call
 * instead means Asterisk tells us the disposition, so dial_log gets a real
 * outcome (ANSWERED / NO_ANSWER / BUSY) and a duration, the same way Twilio
 * gives SMS its delivery state. That is the whole point of this module.
 *
 * THE CALL SHAPE. Originate rings Local/<operator ext>@<context>/n. When the
 * operator answers, the other half of that Local channel (the `;1` half,
 * whose name comes back in OriginateResponse) continues into
 * <context>,<officer number>,1 — i.e. FreePBX's own outbound routes place the
 * officer leg, exactly as if the operator had dialled it from the handset.
 * Every Dial() that half makes is reported as a DialEnd on that channel, and
 * its Hangup is the end of the call. That one channel name is the whole
 * correlation story; see createCallTracker().
 *
 * `/n` IS LOAD-BEARING. Without it Asterisk optimises the Local channel pair
 * out of the call once both legs are bridged, and the `;1` half hangs up
 * seconds into a conversation — which this module would read as the call
 * ending, recording every answered call with a near-zero duration.
 *
 * AMI PERMISSIONS NEEDED (manager.conf): write=originate (or call) to place
 * the call — verified present for `control-dial` on 2026-09-29 via
 * ListCommands — and read=call to RECEIVE the DialEnd/Hangup events. Without
 * read=call the call still connects, but no outcome ever arrives and the row
 * honestly stays ATTEMPTED.
 *
 * SECURITY. AMI is unencrypted by default — credentials cross the LAN in
 * clear text. Acceptable on a trusted segment, NOT over anything routed.
 * Every value interpolated into an AMI header is validated against a strict
 * pattern first: a CR/LF in a personnel phone number would otherwise let
 * whoever edits that record append arbitrary AMI actions to ours.
 */
'use strict';

const net = require('net');
const crypto = require('crypto');

const HOST = process.env.AMI_HOST || '';
const PORT = Number(process.env.AMI_PORT || 5038);
const USERNAME = process.env.AMI_USERNAME || '';
const SECRET = process.env.AMI_SECRET || '';

// The context both legs enter. `from-internal` is FreePBX's standard
// internal context and the one confirmed live on this estate's PBX for
// reaching an extension (commit a86d2da). It also carries the outbound
// routes, so the officer's number leaves through the same trunk selection a
// desk phone would get.
const DIAL_CONTEXT = process.env.AMI_DIAL_CONTEXT || 'from-internal';

// Prepended to the officer's number before it enters the dialplan — for an
// outbound route that expects e.g. a 9 for an outside line. Empty by default:
// FreePBX's UK routes normally match the national 0-format number directly.
const OUTBOUND_PREFIX = process.env.AMI_OUTBOUND_PREFIX || '';

// Personnel records hold UK numbers either as 07… or +447…; an outbound route
// that matches 0XXXXXXXXXX will not match +44. Converting is the right
// default for a UK trunk; set AMI_KEEP_E164=on if your routes want E.164.
const KEEP_E164 = process.env.AMI_KEEP_E164 === 'on';

const LOGIN_TIMEOUT_MS = Number(process.env.AMI_LOGIN_TIMEOUT_MS || 5000);
const ACTION_TIMEOUT_MS = Number(process.env.AMI_ACTION_TIMEOUT_MS || 10000);

// How long the operator's own phone rings before Asterisk gives up on it.
const OPERATOR_RING_S = Number(process.env.AMI_OPERATOR_RING_S || 30);

// Tracking limits. Before an answer, a call that has produced no terminal
// event in this long is abandoned as ATTEMPTED — honest, never guessed.
// After an answer, the cap is much longer because conversations are long;
// hitting it records ANSWERED with an unknown (null) duration.
const RING_TRACK_MS = Number(process.env.AMI_RING_TRACK_MS || 180000);
const CALL_MAX_MS = Number(process.env.AMI_CALL_MAX_MS || 4 * 3600 * 1000);

const configured = () => Boolean(HOST && USERNAME && SECRET);

/* ------------------------------------------------------------------ *
 * Protocol framing
 * ------------------------------------------------------------------ */

/** Parses one AMI block into an object. Keys repeat in some events, so later
 * duplicates are suffixed (Key2, Key3) rather than silently overwriting. */
function parseBlock(lines) {
  const out = {};
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (!key) continue;
    if (key in out) {
      let n = 2;
      while (`${key}${n}` in out) n++;
      out[`${key}${n}`] = value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Refuses anything that could break out of an AMI header line. */
function headerSafe(v) {
  return typeof v === 'string' && !/[\r\n]/.test(v);
}

/** The officer's number as the dialplan should see it, or null if it is not
 * something that can safely be dialled. Only digits (and a leading + when
 * E.164 is kept) ever reach the Exten header. */
function toDialString(raw) {
  let n = String(raw || '').replace(/[\s\-().]/g, '');
  if (!/^\+?\d{3,20}$/.test(n)) return null;
  if (!KEEP_E164 && n.startsWith('+44')) n = '0' + n.slice(3);
  if (!KEEP_E164 && n.startsWith('+')) return null; // non-UK E.164 on a national-format trunk: refuse rather than misdial
  return OUTBOUND_PREFIX + n;
}

/* ------------------------------------------------------------------ *
 * Connection
 * ------------------------------------------------------------------ */

/**
 * Opens an AMI connection and logs in. Resolves to a handle:
 *   { sendAction(action, headers), onEvent(fn), onClose(fn), close() }
 *
 * Login carries its own ActionID like every other action, so its reply is
 * correlated through the same single path as everything else. (An earlier
 * version sent Login without one and swapped in a second dispatcher to catch
 * the anonymous reply; it worked, but it read as broken to the next person
 * and cost a session to disprove. One path, no special case.)
 *
 * When the socket drops — before or after login — every in-flight action is
 * rejected immediately and close handlers run, so a caller tracking a live
 * call learns the link is gone instead of waiting out its timers.
 */
function connect() {
  return new Promise((resolve, reject) => {
    if (!configured()) return reject(new Error('AMI is not configured (need AMI_HOST, AMI_USERNAME, AMI_SECRET)'));
    if (!headerSafe(USERNAME) || !headerSafe(SECRET)) return reject(new Error('AMI credentials contain a line break'));

    const socket = net.connect({ host: HOST, port: PORT });
    socket.setEncoding('utf8');

    let buf = '';
    let loggedIn = false;
    let closed = false;
    const pending = new Map();        // ActionID -> { resolve, reject, timer }
    const eventHandlers = new Set();
    const closeHandlers = new Set();

    function write(action, headers) {
      // A caller may supply its own ActionID when it needs to correlate
      // later events (OriginateResponse) with this action.
      const actionId = headers.ActionID || crypto.randomBytes(8).toString('hex');
      if (!headerSafe(String(actionId))) throw new Error('AMI ActionID contains a line break');
      const lines = [`Action: ${action}`, `ActionID: ${actionId}`];
      for (const [k, v] of Object.entries(headers)) {
        if (k === 'ActionID') continue;
        const value = String(v);
        if (!headerSafe(value)) throw new Error(`AMI header ${k} contains a line break`);
        lines.push(`${k}: ${value}`);
      }
      return { actionId, frame: lines.join('\r\n') + '\r\n\r\n' };
    }

    function send(action, headers, timeoutMs) {
      return new Promise((res, rej) => {
        if (closed) return rej(new Error('AMI connection closed'));
        let framed;
        try { framed = write(action, headers); } catch (e) { return rej(e); }
        const timer = setTimeout(() => {
          pending.delete(framed.actionId);
          rej(new Error(`AMI ${action} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(framed.actionId, { resolve: res, reject: rej, timer });
        socket.write(framed.frame);
      });
    }

    function shutdown(err) {
      if (closed) return;
      closed = true;
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); }
      pending.clear();
      for (const fn of closeHandlers) { try { fn(err); } catch (e) { console.warn('[ami] close handler threw:', e.message); } }
      try { socket.destroy(); } catch {}
      if (!loggedIn) reject(err);
    }

    socket.on('data', (chunk) => {
      buf += chunk;
      // The greeting ("Asterisk Call Manager/x.y") ends with a single CRLF,
      // not a blank line, so it arrives glued to the front of the first real
      // block. It has no colon, and parseBlock skips colon-less lines.
      let idx;
      while ((idx = buf.indexOf('\r\n\r\n')) !== -1) {
        const block = parseBlock(buf.slice(0, idx).split('\r\n'));
        buf = buf.slice(idx + 4);
        if (block.Event !== undefined) {
          for (const fn of eventHandlers) { try { fn(block); } catch (e) { console.warn('[ami] event handler threw:', e.message); } }
          continue;
        }
        const p = block.ActionID && pending.get(block.ActionID);
        if (!p) continue;
        clearTimeout(p.timer);
        pending.delete(block.ActionID);
        // 'Success' is the only reply that means the action was accepted.
        // Silence or anything else is a failure carrying AMI's own message.
        if (block.Response === 'Success' || block.Response === 'Goodbye') p.resolve(block);
        else p.reject(new Error(block.Message || `AMI ${block.Response || 'error'}`));
      }
    });
    socket.on('error', (err) => shutdown(new Error(`AMI socket error: ${err.message}`)));
    socket.on('close', () => shutdown(new Error('AMI connection closed')));

    const handle = {
      host: HOST, port: PORT, context: DIAL_CONTEXT,
      sendAction: (action, headers = {}) => (loggedIn ? send(action, headers, ACTION_TIMEOUT_MS) : Promise.reject(new Error('AMI not logged in'))),
      onEvent(fn) { eventHandlers.add(fn); return () => eventHandlers.delete(fn); },
      onClose(fn) { closeHandlers.add(fn); return () => closeHandlers.delete(fn); },
      close() {
        if (closed) return;
        // A polite Logoff; the close event that follows runs shutdown().
        send('Logoff', {}, 1000).catch(() => {}).finally(() => { try { socket.end(); } catch {} });
      },
    };

    socket.on('connect', () => {
      send('Login', { Username: USERNAME, Secret: SECRET, Events: 'on' }, LOGIN_TIMEOUT_MS)
        .then(() => { loggedIn = true; resolve(handle); })
        .catch((e) => shutdown(e));
    });
  });
}

/* ------------------------------------------------------------------ *
 * Outcome tracking
 * ------------------------------------------------------------------ */

// OriginateResponse Reason codes (Asterisk's AST_CONTROL_* numbering) for the
// OPERATOR leg — the officer was never dialled when these arrive.
const ORIGINATE_REASON = { 0: 'FAILED', 1: 'HANGUP', 3: 'NO_ANSWER', 5: 'BUSY', 8: 'CONGESTION' };

/**
 * A pure state machine over AMI events for one originated call. Kept free of
 * sockets and timers so every event sequence can be tested without a PBX.
 *
 * feed(event) returns null while the call is live, or a terminal result:
 *   { outcome, duration_s, cause, leg }
 *
 * outcome uses dial_log's vocabulary: ANSWERED | NO_ANSWER | BUSY | FAILED.
 * `leg` says whose phone the outcome is about: 'OPERATOR' when the operator's
 * own extension never answered (so the officer was never rung), 'OFFICER'
 * otherwise. An incident review needs that distinction: "control never
 * picked up their own phone" and "the officer did not answer" are different
 * failures with different owners.
 *
 * The outcome is decided on the Hangup of the originated `;1` channel, not on
 * the first DialEnd, because a FreePBX outbound route with trunk failover
 * emits a DialEnd per trunk tried (CHANUNAVAIL, then ANSWER on the next).
 * The last DialEnd before hangup is the one that happened.
 */
function createCallTracker(actionId, now = Date.now) {
  let channel = null;       // the ;1 half, known once the operator answers
  let lastStatus = null;    // most recent DialEnd DialStatus on that channel
  let answeredAt = null;

  return {
    get channel() { return channel; },
    get answered() { return answeredAt !== null; },
    feed(ev) {
      if (ev.Event === 'OriginateResponse' && ev.ActionID === actionId) {
        if (ev.Response !== 'Success') {
          const reason = ORIGINATE_REASON[Number(ev.Reason)] || `REASON_${ev.Reason}`;
          const outcome = reason === 'BUSY' ? 'BUSY' : reason === 'NO_ANSWER' ? 'NO_ANSWER' : 'FAILED';
          return { outcome, duration_s: null, cause: `OPERATOR_${reason}`, leg: 'OPERATOR' };
        }
        channel = ev.Channel || null;
        return null;
      }
      if (!channel || ev.Channel !== channel) return null;

      if (ev.Event === 'DialEnd') {
        lastStatus = ev.DialStatus || null;
        if (lastStatus === 'ANSWER' && answeredAt === null) answeredAt = now();
        return null;
      }
      if (ev.Event === 'Hangup') {
        if (answeredAt !== null) {
          return { outcome: 'ANSWERED', duration_s: Math.max(0, Math.round((now() - answeredAt) / 1000)), cause: null, leg: 'OFFICER' };
        }
        const map = { NOANSWER: 'NO_ANSWER', BUSY: 'BUSY' };
        return {
          outcome: map[lastStatus] || 'FAILED',
          duration_s: null,
          // No DialEnd at all means the number never matched an outbound
          // route (or the operator hung up before it was dialled).
          cause: map[lastStatus] ? null : (lastStatus || 'NO_ROUTE'),
          leg: 'OFFICER',
        };
      }
      return null;
    },
    /** What to record if tracking has to stop without a terminal event. */
    abandon(cause) {
      return answeredAt !== null
        ? { outcome: 'ANSWERED', duration_s: null, cause, leg: 'OFFICER' }
        : { outcome: 'ATTEMPTED', duration_s: null, cause, leg: channel ? 'OFFICER' : 'OPERATOR' };
    },
  };
}

/* ------------------------------------------------------------------ *
 * Origination
 * ------------------------------------------------------------------ */

/**
 * Places a click-to-dial call: rings the OPERATOR's extension first, then
 * connects them to the officer when they answer.
 *
 * This is the standard ARC console flow, and it is forced by the medium: a
 * browser has no audio path into a PBX, so someone has to answer a telephone
 * somewhere, and it is the operator's.
 *
 * Opens its own AMI connection for the life of the call and closes it after.
 * A console places a handful of calls an hour; one connection per call means
 * no reconnect logic, no shared state between calls, and a dropped link can
 * only ever affect the call it belonged to.
 *
 * Resolves once Asterisk has ACCEPTED the originate (not once anyone
 * answered) to { action_id, dial_string, result }, where `result` is a
 * Promise of the tracker's terminal outcome. Rejects if the PBX is
 * unreachable, refuses the login, or refuses the Originate — nothing was
 * dialled in any of those cases.
 */
async function originate({ extension, number } = {}) {
  const ext = String(extension || ''); // not trimmed: refuse malformed input rather than repair it
  if (!/^\d{2,6}$/.test(ext)) throw new Error('operator extension must be 2-6 digits');
  const dial = toDialString(number);
  if (!dial) throw new Error(`not a dialable number: ${number}`);

  const handle = await connect();
  const actionId = crypto.randomBytes(8).toString('hex');
  const tracker = createCallTracker(actionId);

  let settle;
  const result = new Promise((res) => { settle = res; });
  let finished = false;
  let ringTimer = null, maxTimer = null;
  const finish = (r) => {
    if (finished) return;
    finished = true;
    clearTimeout(ringTimer); clearTimeout(maxTimer);
    offEvent(); offClose();
    handle.close();
    settle(r);
  };

  // Subscribed BEFORE the Originate is written: on a LAN the
  // OriginateResponse can arrive before sendAction's own reply is processed.
  const offEvent = handle.onEvent((ev) => {
    const r = tracker.feed(ev);
    if (r) return finish(r);
    if (tracker.answered && ringTimer) { clearTimeout(ringTimer); ringTimer = null; }
  });
  const offClose = handle.onClose(() => finish(tracker.abandon('AMI_DISCONNECTED')));
  ringTimer = setTimeout(() => { if (!tracker.answered) finish(tracker.abandon('TRACKING_TIMEOUT')); }, RING_TRACK_MS);
  maxTimer = setTimeout(() => finish(tracker.abandon('TRACKING_TIMEOUT')), CALL_MAX_MS);
  ringTimer.unref?.(); maxTimer.unref?.();

  try {
    await handle.sendAction('Originate', {
      ActionID: actionId,
      Channel: `Local/${ext}@${DIAL_CONTEXT}/n`,
      Context: DIAL_CONTEXT,
      Exten: dial,
      Priority: '1',
      Timeout: String(OPERATOR_RING_S * 1000),
      Async: 'true',
    });
  } catch (e) {
    finish(tracker.abandon('ORIGINATE_REJECTED'));
    throw e;
  }
  return { action_id: actionId, dial_string: dial, result };
}

/** A one-shot connectivity + permission check, for an admin diagnostics
 * route. Reports what it can see rather than assuming: ListCommands only
 * lists the actions this AMI user is permitted, so Originate's presence
 * there is the permission check. */
async function probe() {
  const handle = await connect();
  try {
    const cmds = await handle.sendAction('ListCommands').catch(() => ({}));
    return {
      host: HOST, port: PORT, context: DIAL_CONTEXT,
      logged_in: true,
      can_originate: 'Originate' in cmds,
      // read=call cannot be listed the same way; it shows as outcomes
      // arriving (or never arriving) on the first real call.
    };
  } finally {
    handle.close();
  }
}

module.exports = {
  connect, originate, probe, createCallTracker, toDialString, parseBlock,
  configured, HOST, PORT, DIAL_CONTEXT,
};
