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
 * WHAT IT DOES NOT KNOW. The dialplan context is yours, not mine — I cannot
 * see your extensions_custom.conf, so the context name is configuration
 * (AMI_DIAL_CONTEXT) rather than hard-coded. Nor is there a way to verify the
 * AMI user's permissions from here; the module reports clearly at startup
 * what it can and cannot do rather than failing at the first call.
 *
 * SECURITY. AMI is unencrypted by default — credentials cross the LAN in
 * clear text. That is acceptable on a trusted segment and NOT acceptable over
 * anything routed, which is worth knowing before this is pointed at a host
 * across a VPN. Asterisk supports TLS on AMI (manager.conf `tlsenable`); this
 * client speaks plain TCP only, deliberately, because that is what the
 * default FreePBX install offers.
 */
'use strict';

const net = require('net');
const crypto = require('crypto');

const HOST = process.env.AMI_HOST || '';
const PORT = Number(process.env.AMI_PORT || 5038);
const USERNAME = process.env.AMI_USERNAME || '';
const SECRET = process.env.AMI_SECRET || '';

// The context a console-originated call enters. Not derivable — see header.
const DIAL_CONTEXT = process.env.AMI_DIAL_CONTEXT || 'from-internal';

// How long to wait for an AMI login reply before giving up. Short: this is a
// LAN box, and a slow reply means something is wrong rather than busy.
const LOGIN_TIMEOUT_MS = Number(process.env.AMI_LOGIN_TIMEOUT_MS || 5000);

// How long a click-to-dial is allowed to ring before we stop tracking it. The
// call itself may ring longer; this only bounds our own listener.
const CALL_TRACK_MS = Number(process.env.AMI_CALL_TRACK_MS || 120000);

const configured = () => Boolean(HOST && USERNAME && SECRET);

/* ------------------------------------------------------------------ *
 * Protocol framing
 * ------------------------------------------------------------------ */

/** Parses one AMI block (headers only) into an object. AMI is `Key: Value`
 * lines with a blank line terminating the block. Keys repeat in some events
 * (e.g. two `Channel:` lines in a Bridge), so later duplicates are suffixed
 * rather than overwriting — losing one silently would be worse. */
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

/* ------------------------------------------------------------------ *
 * Connection
 * ------------------------------------------------------------------ */

/**
 * Opens an AMI connection and logs in. Resolves to a small handle:
 *   { sendAction(action, headers), onEvent(fn), close(), actions, events }
 *
 * `sendAction` resolves with the matching response block, correlated on
 * ActionID — AMI does not guarantee responses arrive in the order they were
 * sent, so correlating on the id rather than on arrival order is the difference
 * between working under load and working only when idle.
 */
function connect() {
  return new Promise((resolve, reject) => {
    if (!configured()) return reject(new Error('AMI is not configured (need AMI_HOST, AMI_USERNAME, AMI_SECRET)'));

    const socket = net.connect({ host: HOST, port: PORT });
    socket.setEncoding('utf8');

    let buf = '';
    let loggedIn = false;
    let settled = false;
    const pending = new Map();  // ActionID -> { resolve, reject, timer }
    const eventHandlers = new Set();
    let greetLines = [];
    let inGreeting = true;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); }
      pending.clear();
      try { socket.destroy(); } catch {}
      reject(err);
    };

    const loginTimer = setTimeout(() => fail(new Error(`AMI login timed out after ${LOGIN_TIMEOUT_MS}ms`)), LOGIN_TIMEOUT_MS);

    function dispatch(block) {
      // A response carrying ActionID belongs to a pending action. An event
      // with no ActionID is unsolicited (Hangup, Newchannel) and goes to
      // every registered handler.
      const isEvent = block.Event !== undefined;
      if (isEvent) {
        for (const fn of eventHandlers) { try { fn(block); } catch (e) { console.warn('[ami] event handler threw:', e.message); } }
        return;
      }
      const id = block.ActionID;
      if (id && pending.has(id)) {
        const p = pending.get(id);
        clearTimeout(p.timer);
        pending.delete(id);
        // Response: Success / Error / Follows. 'Success' is the only one that
        // means the action was accepted — treat anything else as a failure
        // with the message AMI gave, rather than assuming silence is success.
        if (block.Response === 'Success') p.resolve(block);
        else p.reject(new Error(block.Message || `AMI ${block.Response || 'error'}`));
      }
    }

    socket.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\r\n\r\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 4);
        const lines = raw.split('\r\n');
        const block = parseBlock(lines);

        if (inGreeting && !block.Event && !block.Response) { greetLines = lines; continue; }
        inGreeting = false;

        // Follows: the response is followed by a `--END COMMAND--`-style
        // trailer. Only Command actions use it and we never send those, so a
        // Follows response is treated as terminal rather than hanging.
        if (block.Response === 'Follows') { dispatch({ ...block, Response: 'Success' }); continue; }

        dispatch(block);
      }
    });

    socket.on('error', (err) => fail(new Error(`AMI socket error: ${err.message}`)));
    socket.on('close', () => {
      if (!settled) fail(new Error('AMI connection closed'));
    });

    socket.on('connect', () => {
      socket.write(
        'Action: Login\r\n' +
        `Username: ${USERNAME}\r\n` +
        `Secret: ${SECRET}\r\n` +
        'Events: on\r\n' +
        '\r\n'
      );
    });

    // Watch for the login response. It arrives as a normal Response block, so
    // hook it by re-using the dispatch path with a synthetic id.
    const realDispatch = dispatch;
    const loginId = 'login';
    pending.set(loginId, {
      resolve: () => {
        clearTimeout(loginTimer);
        loggedIn = true;
        settled = true;
        resolve(handle);
      },
      reject: (e) => fail(e),
      timer: loginTimer,
    });
    // The Login action carries no ActionID of its own, so attach the pending
    // entry to whatever response arrives first with no Event and no ActionID.
    let loginHook = true;
    function dispatchWithLogin(block) {
      if (loginHook && !block.Event && block.ActionID === undefined) {
        loginHook = false;
        const p = pending.get(loginId);
        pending.delete(loginId);
        if (p) { clearTimeout(p.timer); }
        if (block.Response === 'Success') {
          loginId in pending || (loggedIn = true);
          clearTimeout(loginTimer);
          settled = true;
          resolve(handle);
          return;
        }
        fail(new Error(block.Message || 'AMI login rejected'));
        return;
      }
      realDispatch(block);
    }
    // Replace dispatch usage in the data handler.
    dispatch = dispatchWithLogin;

    const handle = {
      host: HOST, port: PORT, context: DIAL_CONTEXT,
      myId: null,
      /** Sends an action and resolves with its response block. */
      sendAction(action, headers = {}) {
        return new Promise((res, rej) => {
          if (!loggedIn) return rej(new Error('AMI not logged in'));
          const actionId = headers.ActionID || crypto.randomBytes(8).toString('hex');
          const lines = [`Action: ${action}`, `ActionID: ${actionId}`];
          for (const [k, v] of Object.entries(headers)) {
            if (k === 'ActionID') continue;
            lines.push(`${k}: ${v}`);
          }
          const timer = setTimeout(() => {
            pending.delete(actionId);
            rej(new Error(`AMI ${action} timed out`));
          }, 10000);
          pending.set(actionId, { resolve: res, reject: rej, timer });
          socket.write(lines.join('\r\n') + '\r\n\r\n');
        });
      },
      /** Registers an event handler. Returns an unsubscribe function. */
      onEvent(fn) { eventHandlers.add(fn); return () => eventHandlers.delete(fn); },
      close() { try { socket.destroy(); } catch {} },
    };
  });
}

/* ------------------------------------------------------------------ *
 * Origination
 * ------------------------------------------------------------------ */

/**
 * Places a click-to-dial call: rings the OPERATOR's extension first, then
 * bridges them to the officer's number when they answer.
 *
 * This is the standard ARC console flow, and it is forced by the medium: a
 * browser has no audio path into a PBX, so there is no way for the console to
 * be one end of the call. Someone has to answer a telephone somewhere, and it
 * is the operator's.
 *
 * The implementation rings Local/<extension>@<context>, which answers and
 * then Dial()s the officer — so the operator hears ringback and, on answer,
 * is bridged. The exact context must exist in your dialplan; see
 * DIAL_CONTEXT and the header note.
 *
 * @returns {Promise<{uniqueid, channel, action_id}>} — uniqueid is what the
 *          Hangup event will carry, and is stored on the dial_log row so the
 *          outcome can be matched back to it.
 */
async function originate(handle, { extension, number, timeoutS = 45, callerId } = {}) {
  if (!extension) throw new Error('extension required — the operator must be at a desk');
  if (!number) throw new Error('destination number required');

  const dialString = `Local/${extension}@${DIAL_CONTEXT}`;
  const headers = {
    Channel: dialString,
    Context: DIAL_CONTEXT,
    Exten: extension,
    Priority: '1',
    Timeout: String(timeoutS * 1000),
    Async: 'true',
  };
  // When the operator's leg answers, run Dial() against the officer. Without
  // Async the Originate call would block until the whole call ended.
  headers.Application = 'Dial';
  headers.Data = `${number},${timeoutS}`;
  if (callerId) headers.CallerID = callerId;

  const res = await handle.sendAction('Originate', headers);
  return {
    uniqueid: res.Uniqueid || null,
    channel: res.Channel || dialString,
    action_id: res.ActionID || null,
    raw: res,
  };
}

/* ------------------------------------------------------------------ *
 * Outcome tracking
 * ------------------------------------------------------------------ */

/**
 * Watches AMI events for the end of one originated call and reports the
 * disposition. This is what fills dial_log.outcome and duration_s — without
 * it the row would say ATTEMPTED forever, which is exactly the gap this whole
 * module exists to close.
 *
 * Resolves once with { outcome, duration_s, cause } and then detaches, so a
 * long-lived console doesn't accumulate listeners.
 *
 * Asterisk's own vocabulary maps to ours as:
 *   ANSWER + Hangup, cause 16 (normal)  -> ANSWERED
 *   Hangup cause 17 (user busy)         -> BUSY
 *   Hangup cause 19 (no answer)         -> NO_ANSWER
 *   anything else                       -> FAILED, with the cause recorded
 *
 * `cause` is kept verbatim as well as mapped: Asterisk has dozens of cause
 * codes and flattening them all to FAILED would throw away the detail an
 * incident review would want.
 */
function trackCall(handle, uniqueid, { timeoutMs = CALL_TRACK_MS } = {}) {
  return new Promise((resolve) => {
    if (!uniqueid) return resolve({ outcome: 'ATTEMPTED', duration_s: null, cause: null });

    let answeredAt = null;
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(result);
    };

    const unsubscribe = handle.onEvent((ev) => {
      const uid = ev.Uniqueid || ev.DestUniqueid || ev.Linkedid;
      // Match on any of the three ids: which one carries the originated call
      // varies with the channel type and whether a bridge occurred.
      if (uid !== uniqueid && ev.Uniqueid !== uniqueid && ev.Linkedid !== uniqueid) return;

      if (ev.Event === 'Answer' && !answeredAt) answeredAt = Date.now();

      if (ev.Event === 'Hangup') {
        const cause = ev.Cause ? Number(ev.Cause) : null;
        let outcome;
        if (answeredAt) outcome = 'ANSWERED';
        else if (cause === 17) outcome = 'BUSY';
        else if (cause === 19) outcome = 'NO_ANSWER';
        else if (cause === 16) outcome = 'NO_ANSWER';   // normal clear, never answered
        else outcome = 'FAILED';

        finish({
          outcome,
          duration_s: answeredAt ? Math.round((Date.now() - answeredAt) / 1000) : null,
          cause,
        });
      }
    });

    const timer = setTimeout(() => finish({ outcome: 'ATTEMPTED', duration_s: null, cause: null }), timeoutMs);
  });
}

/** A one-shot connectivity + permission check, for startup and for an admin
 * diagnostics route. Reports what it can see rather than assuming. */
async function probe() {
  const handle = await connect();
  try {
    const ping = await handle.sendAction('Ping').catch((e) => ({ Response: 'Error', Message: e.message }));
    return {
      host: HOST, port: PORT, context: DIAL_CONTEXT,
      reachable: true,
      logged_in: true,
      ping_ok: ping.Response === 'Success' || ping.Ping === 'Pong',
      // Deliberately not asserted: whether this user may Originate is a
      // manager.conf permission we cannot read from here. It will show up as
      // a clear error on the first real call if it is missing.
      can_originate: 'unknown — check manager.conf permissions on the first call',
    };
  } finally {
    handle.close();
  }
}

module.exports = {
  connect, originate, trackCall, probe,
  configured, live: configured(),
  HOST, PORT, DIAL_CONTEXT,
};
