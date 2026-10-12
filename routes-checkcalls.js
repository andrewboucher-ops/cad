/**
 * Control room check calls and PC updates for PCs off the VPN.
 *
 * The check call host (a container on the office network) holds the check call
 * schedules, the escalation alerts and the latest PC installer on its Samba
 * share, and only the office network and the VPN can reach that share. A PC
 * off the VPN comes here instead, and CCCS relays between it and the host:
 *
 *   - the host's sync service pushes what is on the share (schedules, alerts
 *     and their acknowledgements, the published release) every few seconds,
 *     and collects the changes PCs have queued here, which it then applies to
 *     the share itself. The share stays the one place the runner reads, so
 *     nothing about how calls are placed changes.
 *   - PCs read that picture, queue a change (start or stop an extension's
 *     check calls, acknowledge an alert, an audit entry) and download the
 *     installer.
 *
 * Two secrets: PCs use WORKSTATION_SECRET, the same as clock-in and the dial
 * relay, and can only do the narrow things above. The host uses its own
 * CHECKCALL_HOST_SECRET, because it can replace the whole picture and the
 * installer every PC runs as SYSTEM. Without either set its routes refuse.
 *
 * Registrar pattern — server.js passes in what this needs.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EXT_RE = /^\d{2,6}$/;
const ALERT_ID_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const RELEASE_FILE_RE = /^[A-Za-z0-9_.-]{1,100}\.exe$/;
const RELEASE_MAX_BYTES = 1.5e9;
// Same rule as the dial relay: these numbers are dialled every hour from the
// phone system, so an internet route must not be able to point them at
// premium rate or abroad.
const NUMBER_ALLOW_DEFAULT = '^(?!118)(0(?!9|70|87[1-3])\\d{9,10}|\\d{2,6})$';
// The host syncs every few seconds; this long without one and PCs are told
// what they see may be out of date.
const HOST_STALE_MS = 2 * 60 * 1000;

module.exports = function registerCheckCalls({ route, httpError, db, nextId, logEvent, assertWorkstationSecret, RELEASE_DIR, flushNow = () => {} }) {
  if (!db.checkcall_commands) db.checkcall_commands = [];

  // What the host last reported. In memory only: the host re-sends all of it
  // every few seconds, and the share is the record, not this.
  const mirror = { synced_at: null, schedules: [], alerts: [] };

  function assertHostSecret(req) {
    const secret = process.env.CHECKCALL_HOST_SECRET;
    const given = Buffer.from(String(req.headers['x-checkcall-host-secret'] || ''));
    if (!secret || given.length !== Buffer.byteLength(secret) || !crypto.timingSafeEqual(given, Buffer.from(secret))) {
      throw httpError(401, 'bad check call host secret');
    }
  }

  const who = (body) => ({
    workstation: String(body.workstation || '').slice(0, 64) || 'unknown',
    user: String(body.user || '').slice(0, 64) || 'unknown',
  });
  const pending = () => db.checkcall_commands.filter((c) => c.status === 'PENDING');

  function queue(kind, fields, body) {
    const cmd = { id: nextId('checkcall_commands'), kind, ...fields, ...who(body), at: new Date().toISOString(), status: 'PENDING' };
    db.checkcall_commands.push(cmd);
    flushNow();
    return cmd;
  }

  function normaliseNumber(raw) {
    let n = String(raw || '').replace(/[^0-9+*#]/g, '');
    n = n.replace(/^\+44/, '0').replace(/^\+/, '00');
    if (!new RegExp(process.env.DIAL_ALLOW || NUMBER_ALLOW_DEFAULT).test(n)) {
      throw httpError(403, 'that number cannot be programmed from outside the office network');
    }
    return n;
  }

  /* The host's picture, with changes PCs have queued but the host has not
   * applied yet laid over it, so a PC sees its own change straight away and
   * nobody sees it flicker back until the host catches up. */
  function schedulesView() {
    const byExt = new Map(mirror.schedules.map((s) => [String(s.extension), { ...s }]));
    for (const c of pending()) {
      if (c.kind === 'save') {
        byExt.set(c.extension, { ...(byExt.get(c.extension) || {}), active: true, extension: c.extension, number: c.number,
          owner: c.workstation, set_by: c.user, set_at: c.at, pending: true });
      } else if (c.kind === 'stop' && byExt.has(c.extension)) {
        byExt.set(c.extension, { ...byExt.get(c.extension), active: false, pending: true });
      }
    }
    return [...byExt.values()];
  }

  function alertsView() {
    return mirror.alerts.map((a) => {
      if (a.ack) return a;
      const first = pending().find((c) => c.kind === 'ack' && c.alert_id === a.id);
      return first ? { ...a, ack: { user: first.user, machine: first.workstation, at: first.at }, ack_pending: true } : a;
    });
  }

  const snapshot = () => ({
    synced_at: mirror.synced_at,
    host_stale: !mirror.synced_at || Date.now() - Date.parse(mirror.synced_at) > HOST_STALE_MS,
  });

  /* ---- PCs ------------------------------------------------------------ */

  route('GET', '/api/integrations/workstation/checkcalls', null, ({ req }) => {
    assertWorkstationSecret(req);
    return { ...snapshot(), schedules: schedulesView() };
  });

  route('PUT', '/api/integrations/workstation/checkcalls/:ext', null, ({ params, body, req }) => {
    assertWorkstationSecret(req);
    if (!EXT_RE.test(params.ext)) throw httpError(400, 'extension must be 2-6 digits');
    const number = normaliseNumber(body.number);
    const cmd = queue('save', { extension: params.ext, number }, body);
    logEvent('checkcall.queued', `CHECK CALLS FOR EXT ${params.ext} TO ${number} SET BY ${cmd.user} AT ${cmd.workstation} (OFF VPN)`,
      { extension: params.ext, number, workstation: cmd.workstation, user: cmd.user, command_id: cmd.id });
    return { __status: 202, __body: { ...snapshot(), command_id: cmd.id, status: cmd.status } };
  });

  route('POST', '/api/integrations/workstation/checkcalls/:ext/stop', null, ({ params, body, req }) => {
    assertWorkstationSecret(req);
    if (!EXT_RE.test(params.ext)) throw httpError(400, 'extension must be 2-6 digits');
    const cmd = queue('stop', { extension: params.ext }, body);
    logEvent('checkcall.queued', `CHECK CALLS FOR EXT ${params.ext} STOPPED BY ${cmd.user} AT ${cmd.workstation} (OFF VPN)`,
      { extension: params.ext, workstation: cmd.workstation, user: cmd.user, command_id: cmd.id });
    return { __status: 202, __body: { ...snapshot(), command_id: cmd.id, status: cmd.status } };
  });

  route('GET', '/api/integrations/workstation/alerts', null, ({ req }) => {
    assertWorkstationSecret(req);
    return { ...snapshot(), alerts: alertsView() };
  });

  /* The share decides who acknowledged first, because PCs on the VPN write
   * there directly. The answer here is provisional until the host has applied
   * it: the PC polls the command until it is APPLIED, and the result names
   * whoever really got there first. */
  route('POST', '/api/integrations/workstation/alerts/:id/ack', null, ({ params, body, req }) => {
    assertWorkstationSecret(req);
    if (!ALERT_ID_RE.test(params.id)) throw httpError(400, 'bad alert id');
    const known = mirror.alerts.find((a) => a.id === params.id);
    if (!known) throw httpError(404, 'no such alert');
    if (known.ack) return { ack: known.ack, confirmed: true, command_id: null };
    const earlier = pending().find((c) => c.kind === 'ack' && c.alert_id === params.id);
    if (earlier) return { ack: { user: earlier.user, machine: earlier.workstation, at: earlier.at }, confirmed: false, command_id: earlier.id };
    const cmd = queue('ack', { alert_id: params.id }, body);
    logEvent('checkcall.alert_ack', `CHECK CALL ALERT ${params.id} ACKNOWLEDGED BY ${cmd.user} AT ${cmd.workstation} (OFF VPN)`,
      { alert_id: params.id, workstation: cmd.workstation, user: cmd.user, command_id: cmd.id });
    return { ack: { user: cmd.user, machine: cmd.workstation, at: cmd.at }, confirmed: false, command_id: cmd.id };
  });

  // Lets a PC see whether the host has applied what it queued, and the result.
  route('GET', '/api/integrations/workstation/commands/:id', null, ({ params, req }) => {
    assertWorkstationSecret(req);
    const c = db.checkcall_commands.find((x) => x.id === Number(params.id));
    if (!c) throw httpError(404, 'no such command');
    return { id: c.id, kind: c.kind, status: c.status, result: c.result || null, error: c.error || null };
  });

  // Audit entries from a PC that cannot reach the share. The host drops each
  // into the audit inbox exactly as a PC on the VPN would.
  route('POST', '/api/integrations/workstation/audit', null, ({ body, req }) => {
    assertWorkstationSecret(req);
    const lines = (Array.isArray(body.lines) ? body.lines : [body.line]).filter(Boolean).map(String);
    if (!lines.length) throw httpError(400, 'line required');
    if (lines.length > 200) throw httpError(400, 'too many lines at once');
    for (const line of lines) {
      if (line.length > 8000) throw httpError(400, 'audit line too long');
      let obj; try { obj = JSON.parse(line); } catch { throw httpError(400, 'audit line is not JSON'); }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !obj.ts || !obj.type) throw httpError(400, 'audit line needs ts and type');
    }
    for (const line of lines) queue('audit', { line }, body);
    return { __status: 202, __body: { queued: lines.length } };
  });

  /* ---- PC installer ------------------------------------------------------ */

  const manifestFile = () => path.join(RELEASE_DIR, 'release.json');
  function readManifest() {
    try { return JSON.parse(fs.readFileSync(manifestFile(), 'utf8')); } catch { return null; }
  }

  route('GET', '/api/integrations/workstation/release', null, ({ req }) => {
    assertWorkstationSecret(req);
    const m = readManifest();
    if (!m) throw httpError(404, 'no release published here yet');
    return { version: m.version, file: m.file, sha256: m.sha256, size: m.size };
  });

  route('GET', '/api/integrations/workstation/release/file', null, ({ req }) => {
    assertWorkstationSecret(req);
    const m = readManifest();
    const file = m && path.join(RELEASE_DIR, m.file);
    if (!m || !fs.existsSync(file)) throw httpError(404, 'no release published here yet');
    return {
      __stream: fs.createReadStream(file),
      __headers: { 'content-type': 'application/octet-stream', 'content-length': String(fs.statSync(file).size),
        'content-disposition': `attachment; filename="${m.file}"` },
    };
  });

  /* ---- The check call host ------------------------------------------------ */

  /* One round trip: the host reports what it applied since last time and what
   * is on the share now, and gets back what is still waiting for it. */
  route('POST', '/api/integrations/checkcall-host/sync', null, ({ body, req }) => {
    assertHostSecret(req);
    const now = new Date().toISOString();
    for (const r of Array.isArray(body.results) ? body.results : []) {
      const c = db.checkcall_commands.find((x) => x.id === Number(r.id));
      if (!c || c.status !== 'PENDING') continue;
      c.status = r.ok ? 'APPLIED' : 'FAILED';
      c.applied_at = now;
      if (r.result) c.result = r.result;
      if (r.error) c.error = String(r.error).slice(0, 500);
      if (c.kind === 'audit') delete c.line; // filed on the host now; no need to keep a second copy
    }
    if (Array.isArray(body.schedules)) mirror.schedules = body.schedules.filter((s) => s && EXT_RE.test(String(s.extension)));
    if (Array.isArray(body.alerts)) mirror.alerts = body.alerts.filter((a) => a && ALERT_ID_RE.test(String(a.id)));
    mirror.synced_at = now;
    flushNow();

    const m = readManifest();
    const hostRelease = body.release && body.release.sha256 ? String(body.release.sha256).toUpperCase() : null;
    return {
      pending: pending().map((c) => ({ ...c })),
      release_wanted: !!hostRelease && (!m || String(m.sha256).toUpperCase() !== hostRelease),
    };
  });

  /* The host uploads the installer it has published, streamed straight to
   * disk (it is a few hundred MB). It only replaces the live one once the
   * SHA-256 matches, so a cut-off upload never reaches a PC. */
  route('PUT', '/api/integrations/checkcall-host/release', null, async ({ req }) => {
    assertHostSecret(req);
    const version = String(req.headers['x-release-version'] || '');
    const file = String(req.headers['x-release-file'] || '');
    const sha256 = String(req.headers['x-release-sha256'] || '').toUpperCase();
    if (!/^\d+(\.\d+){1,3}$/.test(version)) throw httpError(400, 'x-release-version must be like 3.6');
    if (!RELEASE_FILE_RE.test(file)) throw httpError(400, 'x-release-file must be a plain .exe name');
    if (!/^[0-9A-F]{64}$/.test(sha256)) throw httpError(400, 'x-release-sha256 must be a SHA-256 in hex');

    fs.mkdirSync(RELEASE_DIR, { recursive: true });
    const tmp = path.join(RELEASE_DIR, `.upload-${crypto.randomBytes(6).toString('hex')}`);
    const hash = crypto.createHash('sha256');
    let size = 0;
    try {
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(tmp);
        out.on('error', reject);
        req.on('error', reject);
        req.on('data', (chunk) => {
          size += chunk.length;
          if (size > RELEASE_MAX_BYTES) { req.destroy(); return reject(httpError(413, 'release too large')); }
          hash.update(chunk);
          if (!out.write(chunk)) { req.pause(); out.once('drain', () => req.resume()); }
        });
        req.on('end', () => out.end(resolve));
      });
      const got = hash.digest('hex').toUpperCase();
      if (got !== sha256) throw httpError(400, `upload did not match its SHA-256 (got ${got})`);
      const old = readManifest();
      fs.renameSync(tmp, path.join(RELEASE_DIR, file));
      const manifest = { version, file, sha256, size, published_at: new Date().toISOString() };
      fs.writeFileSync(manifestFile() + '.tmp', JSON.stringify(manifest, null, 2));
      fs.renameSync(manifestFile() + '.tmp', manifestFile());
      if (old && old.file !== file) fs.rmSync(path.join(RELEASE_DIR, old.file), { force: true });
      logEvent('workstation.release', `PC BUILD ${version} AVAILABLE TO PCS OFF THE VPN`, { version, file, sha256, size });
      return { version, file, sha256, size };
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  return { mirror };
};
