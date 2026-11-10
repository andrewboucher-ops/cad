#!/usr/bin/env node
/* cccs-watchdog: runs every 2 minutes (cccs-watchdog.timer, installed by
 * deploy/install-watchdog.sh) beside CCCS, and texts and emails when:
 *   - CCCS stops answering (two checks in a row, so a restart or a deploy
 *     doesn't page anyone), and again when it is back;
 *   - the nightly backup hasn't run for over a day, or failed;
 *   - the backup didn't get copied off this server;
 *   - the disk is nearly full.
 * A problem that carries on is repeated every few hours, not every 2 minutes.
 *
 * It sends by text (Twilio) AND email (Microsoft 365), using the accounts
 * already in cccs.env, so one of them failing doesn't silence it.
 *
 * Something on this server can't tell you this server, its power or the
 * broadband is down. For that, set WATCHDOG_PING_URL to a free
 * Healthchecks.io check: this pings it every run while CCCS is healthy, and
 * Healthchecks.io emails/texts you itself when the pings stop.
 *
 * Settings (environment or /etc/cccs/cccs.env):
 *   ALERT_EMAIL             who gets alert emails (comma-separated)
 *   ALERT_SMS               who gets alert texts (07… or +44…, comma-separated)
 *   WATCHDOG_PING_URL       optional external heartbeat (Healthchecks.io)
 *   WATCHDOG_FAILS          failed checks in a row before "down"   (2)
 *   WATCHDOG_REPEAT_HOURS   repeat a continuing problem every      (6)
 *   WATCHDOG_BACKUP_MAX_HOURS  newest backup older than this = late (27)
 *   WATCHDOG_DISK_MIN_PCT   free space below this = alert          (10)
 *
 *   cccs-watchdog           one check (what the timer runs)
 *   cccs-watchdog --test    send a test text and email now, and say how each went
 *   cccs-watchdog --status  print what it last saw
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ENV_FILE = process.env.ENV_FILE || '/etc/cccs/cccs.env';
const fileEnv = {};
try {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) fileEnv[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* environment only */ }
const cfg = (k, d = '') => String(process.env[k] || fileEnv[k] || d).trim();
const num = (k, d) => { const n = Number(cfg(k, String(d))); return Number.isFinite(n) && n > 0 ? n : d; };
const list = (k) => cfg(k).split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

const PORT = cfg('PORT', '4000');
const CCCS_URL = cfg('WATCHDOG_URL', `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');
const STATE_FILE = cfg('WATCHDOG_STATE', '/var/lib/cccs-watchdog/state.json');
const DEPLOY_LOCK = cfg('WATCHDOG_DEPLOY_LOCK', '/run/cccs-autodeploy.lock');
const DATA_FILE = cfg('DATA_FILE', '/var/lib/cccs/cccs.db');
const BACKUP_DIR = cfg('BACKUP_DIR', '/var/backups/cccs');
const FAILS = num('WATCHDOG_FAILS', 2);
const REPEAT_MS = num('WATCHDOG_REPEAT_HOURS', 6) * 3600e3;
const BACKUP_MAX_MS = num('WATCHDOG_BACKUP_MAX_HOURS', 27) * 3600e3;
const DISK_MIN_PCT = num('WATCHDOG_DISK_MIN_PCT', 10);
const PING_URL = cfg('WATCHDOG_PING_URL');
const GRAPH = cfg('GRAPH_BASE', 'https://graph.microsoft.com/v1.0').replace(/\/+$/, '');
const LOGIN = cfg('LOGIN_BASE', 'https://login.microsoftonline.com').replace(/\/+$/, '');
const TWILIO = cfg('TWILIO_BASE', 'https://api.twilio.com/2010-04-01').replace(/\/+$/, '');
const HOST = cfg('WATCHDOG_NAME', 'CCCS');

const timed = (ms) => { const c = new AbortController(); setTimeout(() => c.abort(), ms).unref(); return c.signal; };

// ---------- sending ----------
function ukNumber(raw) {
  const s = String(raw || '').replace(/[\s()-]/g, '');
  if (/^\+\d{7,15}$/.test(s)) return s;
  if (/^0\d{9,10}$/.test(s)) return `+44${s.slice(1)}`;
  return null;
}
async function sendSms(text) {
  const to = list('ALERT_SMS');
  if (!to.length) return [];
  const sid = cfg('TWILIO_ACCOUNT_SID'), tok = cfg('TWILIO_AUTH_TOKEN');
  if (!sid || !tok) return [{ via: 'text', ok: false, error: 'Twilio is not set up in cccs.env' }];
  const from = cfg('SMS_SENDER_ID') || cfg('TWILIO_FROM_NUMBER');
  const svc = cfg('TWILIO_MESSAGING_SERVICE_SID');
  const out = [];
  for (const raw of to) {
    const dest = ukNumber(raw);
    if (!dest) { out.push({ via: `text ${raw}`, ok: false, error: 'not a usable number' }); continue; }
    const form = new URLSearchParams({ To: dest, Body: text.slice(0, 1500) });
    if (from) form.set('From', from); else if (svc) form.set('MessagingServiceSid', svc);
    try {
      const res = await fetch(`${TWILIO}/Accounts/${sid}/Messages.json`, {
        method: 'POST', body: form, signal: timed(15000),
        headers: { authorization: `Basic ${Buffer.from(`${sid}:${tok}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      });
      const data = await res.json().catch(() => ({}));
      out.push(res.ok ? { via: `text ${dest}`, ok: true } : { via: `text ${dest}`, ok: false, error: data.message || `Twilio ${res.status}` });
    } catch (e) { out.push({ via: `text ${dest}`, ok: false, error: e.message }); }
  }
  return out;
}
async function sendEmail(subject, text) {
  const to = list('ALERT_EMAIL');
  if (!to.length) return [];
  const tenant = cfg('MS_TENANT_ID'), client = cfg('MS_CLIENT_ID'), secret = cfg('MS_CLIENT_SECRET'), sender = cfg('MS_GRAPH_SENDER');
  if (!tenant || !client || !secret || !sender) return [{ via: 'email', ok: false, error: 'Microsoft 365 mail is not set up in cccs.env (MS_GRAPH_SENDER)' }];
  try {
    const t = await fetch(`${LOGIN}/${tenant}/oauth2/v2.0/token`, {
      method: 'POST', signal: timed(15000), headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: client, client_secret: secret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
    });
    const td = await t.json().catch(() => ({}));
    if (!t.ok) return [{ via: 'email', ok: false, error: td.error_description || `sign-in ${t.status}` }];
    const res = await fetch(`${GRAPH}/users/${encodeURIComponent(sender)}/sendMail`, {
      method: 'POST', signal: timed(15000), headers: { authorization: `Bearer ${td.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { subject, importance: 'high', body: { contentType: 'Text', content: text }, toRecipients: to.map((address) => ({ emailAddress: { address } })) } }),
    });
    return [res.ok ? { via: `email ${to.join(', ')}`, ok: true } : { via: 'email', ok: false, error: `Microsoft ${res.status} ${(await res.text()).slice(0, 200)}` }];
  } catch (e) { return [{ via: 'email', ok: false, error: e.message }]; }
}
async function alert(subject, body) {
  const results = [...(await sendSms(`${subject}. ${body}`)), ...(await sendEmail(subject, `${body}\n\n— cccs-watchdog on ${require('os').hostname()}, ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}`))];
  if (!results.length) console.warn(`[watchdog] ALERT not sent anywhere — set ALERT_EMAIL and/or ALERT_SMS in cccs.env: ${subject}: ${body}`);
  for (const r of results) console.log(`[watchdog] ${r.ok ? 'sent' : 'FAILED to send'} by ${r.via}${r.ok ? '' : `: ${r.error}`} — ${subject}`);
  return results;
}

// ---------- checks ----------
async function cccsAnswers() {
  try {
    for (const p of ['/control.html', '/api/auth/microsoft/status']) {
      const res = await fetch(CCCS_URL + p, { signal: timed(10000), redirect: 'manual' });
      if (res.status !== 200) return `${p} answered ${res.status}`;
      await res.arrayBuffer();
    }
    return null;
  } catch (e) { return e.name === 'AbortError' ? 'no answer within 10 seconds' : (e.cause && e.cause.code) || e.message; }
}
function deploying() {
  // deploy/autodeploy.sh holds this lock for the whole of a deploy.
  if (!fs.existsSync(DEPLOY_LOCK)) return false;
  const r = spawnSync('flock', ['-n', DEPLOY_LOCK, 'true']);
  return r.status === 1;
}
function backupProblems(now) {
  const out = {};
  let files = [];
  try { files = fs.readdirSync(BACKUP_DIR).filter((f) => /^cccs-\d{8}-\d{6}\.tar\.gz(\.enc)?$/.test(f)); } catch { /* none */ }
  const newest = files.map((f) => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
  let last = null;
  try { last = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, 'last-backup.json'), 'utf8')); } catch { /* older backup.sh */ }
  if (!newest) out.backup_late = 'No backup archives found on the server at all. Run: systemctl start cccs-backup';
  else if (now - newest.t > BACKUP_MAX_MS) out.backup_late = `The newest backup is ${Math.round((now - newest.t) / 3600e3)} hours old (${newest.f}).${last && !last.ok ? ' The last attempt failed.' : ''} Check: journalctl -u cccs-backup -n 30`;
  if (last && last.ok === false && last.exit_code !== 2 && !out.backup_late) out.backup_late = `Last night's backup failed (exit ${last.exit_code}). Check: journalctl -u cccs-backup -n 30`;
  if (last && last.offsite === 'failed') out.backup_offsite = `The backup was made but NOT copied off the server: ${last.offsite_error || 'unknown error'}`;
  else if (last && last.offsite === 'none') out.backup_onsite_only = 'Backups are only on the CCCS server itself. Set BACKUP_ONEDRIVE_USER in cccs.env (see deploy/proxmox.md §4).';
  return out;
}
function diskProblem() {
  try {
    const s = fs.statfsSync(path.dirname(DATA_FILE));
    const pct = (s.bavail / s.blocks) * 100;
    if (pct < DISK_MIN_PCT) return `Only ${pct.toFixed(1)}% disk left (${Math.round((s.bavail * s.bsize) / 1048576)} MB). CCCS stops saving when it is full.`;
  } catch { /* not measurable */ }
  return null;
}
async function ping(suffix = '') {
  if (!PING_URL) return;
  try { await fetch(PING_URL.replace(/\/+$/, '') + suffix, { signal: timed(10000) }); } catch (e) { console.warn(`[watchdog] heartbeat ping failed: ${e.message}`); }
}

// ---------- main ----------
const TITLES = {
  down: `${HOST} IS DOWN`, backup_late: `${HOST} backup problem`, backup_offsite: `${HOST} backup not copied off the server`,
  backup_onsite_only: `${HOST} backups are only on the server`, disk: `${HOST} disk nearly full`,
};
const CLEARED = {
  down: `${HOST} is back up`, backup_late: `${HOST} backups are running again`, backup_offsite: `${HOST} backups are being copied off the server again`,
  backup_onsite_only: `${HOST} backups are now copied off the server`, disk: `${HOST} disk space is OK again`,
};
// A gentle nag doesn't need repeating every 6 hours.
const REPEAT = { backup_onsite_only: 7 * 24 * 3600e3 };

function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { fails: 0, open: {} }; } }
function saveState(s) { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1)); }

async function check() {
  const now = Date.now();
  const st = loadState(); st.open = st.open || {};
  const problems = {};

  const why = await cccsAnswers();
  if (!why) st.fails = 0;
  else if (deploying()) console.log(`[watchdog] CCCS not answering (${why}) during a deploy — not counted`);
  else { st.fails = (st.fails || 0) + 1; console.warn(`[watchdog] CCCS not answering (${why}), ${st.fails} in a row`); }
  if (st.fails >= FAILS) problems.down = `CCCS has not answered for ${st.fails} checks in a row (${why}). Officers' apps and the control room are affected. On the server: pct enter 140, then systemctl status cccs`;
  else if (why && st.open.down) problems.down = st.open.down.text; // still down, just not counted this time
  Object.assign(problems, backupProblems(now));
  const disk = diskProblem(); if (disk) problems.disk = disk;

  for (const [k, text] of Object.entries(problems)) {
    const o = st.open[k];
    if (!o || now - o.sent >= (REPEAT[k] || REPEAT_MS)) {
      await alert(o ? `${TITLES[k]} (still)` : TITLES[k], text);
      st.open[k] = { since: o ? o.since : now, sent: now, text };
    } else st.open[k].text = text;
  }
  for (const k of Object.keys(st.open)) {
    if (problems[k]) continue;
    const mins = Math.round((now - st.open[k].since) / 60000);
    await alert(CLEARED[k] || `${HOST}: ${k} cleared`, `Cleared after ${mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`}.`);
    delete st.open[k];
  }
  st.last_check = new Date(now).toISOString(); st.last_ok = why ? st.last_ok || null : st.last_check;
  saveState(st);
  await ping(problems.down ? '/fail' : '');
}

(async () => {
  const arg = process.argv[2];
  if (arg === '--test') {
    const r = await alert(`${HOST} watchdog test`, 'This is a test from cccs-watchdog. If you got this, down alerts will reach you here.');
    await ping();
    if (!r.length) { console.log('Nothing to send to: set ALERT_EMAIL and/or ALERT_SMS in /etc/cccs/cccs.env'); process.exit(1); }
    process.exit(r.some((x) => x.ok) ? 0 : 1);
  }
  if (arg === '--status') { console.log(JSON.stringify(loadState(), null, 1)); return; }
  await check();
})().catch((e) => { console.error(`[watchdog] ${e.stack || e.message}`); process.exit(1); });
