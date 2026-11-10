/* deploy/watchdog.js and deploy/offsite-copy.js against a fake CCCS, fake
 * Microsoft 365 and fake Twilio on localhost — node --test */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const WATCHDOG = path.join(__dirname, '..', 'deploy', 'watchdog.js');
const OFFSITE = path.join(__dirname, '..', 'deploy', 'offsite-copy.js');
const BACKUP = path.join(__dirname, '..', 'deploy', 'backup.sh');
let srv, base, T;
const fake = { cccsUp: true, mails: [], texts: [], pings: [], drive: new Map(), uploadSessions: 0, twilioFails: false };

before(async () => {
  T = fs.mkdtempSync(path.join(os.tmpdir(), 'cccs-watchdog-'));
  srv = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks); const u = new URL(req.url, base);
      const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (u.pathname === '/control.html' || u.pathname === '/api/auth/microsoft/status') return fake.cccsUp ? json(200, { enabled: true }) : json(503, {});
      if (u.pathname.endsWith('/oauth2/v2.0/token')) return json(200, { access_token: 'tok', expires_in: 3600 });
      if (u.pathname.startsWith('/ping')) { fake.pings.push(u.pathname); return json(200, {}); }
      if (/\/Messages\.json$/.test(u.pathname)) {
        if (fake.twilioFails) return json(401, { message: 'Authentication Error - account not active' });
        fake.texts.push(Object.fromEntries(new URLSearchParams(body.toString()))); return json(201, { sid: 'SM1' });
      }
      if (u.pathname.endsWith('/sendMail')) { fake.mails.push(JSON.parse(body)); res.writeHead(202); return res.end(); }
      let m;
      if ((m = /\/drive\/root:\/(.+)\/([^/]+):\/createUploadSession$/.exec(decodeURIComponent(u.pathname)))) {
        fake.uploadSessions++;
        const id = `item${fake.uploadSessions}`;
        fake.drive.set(id, { id, name: m[2], folder: m[1], data: Buffer.alloc(0), size: 0 });
        return json(200, { uploadUrl: `${base}/upload/${id}` });
      }
      if ((m = /^\/upload\/(.+)$/.exec(u.pathname))) {
        const it = fake.drive.get(m[1]); const [, s, , total] = /bytes (\d+)-(\d+)\/(\d+)/.exec(req.headers['content-range']);
        assert.equal(Number(s), it.data.length, 'chunks arrive in order');
        it.data = Buffer.concat([it.data, body]); it.size = it.data.length;
        return it.size < Number(total) ? json(202, { nextExpectedRanges: [`${it.size}-`] }) : json(201, { id: it.id, name: it.name, size: it.size });
      }
      if (/\/drive\/root:\/.+:\/children$/.test(decodeURIComponent(u.pathname))) return json(200, { value: [...fake.drive.values()].map(({ id, name, size }) => ({ id, name, size })) });
      if ((m = /\/drive\/items\/(.+)$/.exec(u.pathname)) && req.method === 'DELETE') { fake.drive.delete(decodeURIComponent(m[1])); res.writeHead(204); return res.end(); }
      json(404, { error: { message: `no fake for ${req.method} ${u.pathname}` } });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv.close(); fs.rmSync(T, { recursive: true, force: true }); });

const msEnv = () => ({ MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', MS_GRAPH_SENDER: 'noreply@example.com', GRAPH_BASE: `${base}/v1.0`, LOGIN_BASE: base });
// Async (not spawnSync): the fake services run in this process.
const runNode = (script, args, env) => new Promise((resolve) => {
  const p = spawn(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, ENV_FILE: path.join(T, 'none.env'), NODE_NO_WARNINGS: '1', ...env } });
  let stdout = '', stderr = ''; p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
  p.on('close', (status) => resolve({ status, stdout, stderr }));
});

function wdEnv(dir) {
  const backups = path.join(dir, 'backups'); fs.mkdirSync(backups, { recursive: true });
  return {
    ...msEnv(), WATCHDOG_URL: base, WATCHDOG_STATE: path.join(dir, 'state.json'), WATCHDOG_DEPLOY_LOCK: path.join(dir, 'nolock'),
    DATA_FILE: path.join(dir, 'cccs.db'), BACKUP_DIR: backups, ALERT_EMAIL: 'andy@example.com', ALERT_SMS: '07700900123',
    TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'x', TWILIO_FROM_NUMBER: '+447700900000', TWILIO_BASE: base,
    WATCHDOG_PING_URL: `${base}/ping/abc`,
  };
}
const freshBackup = (env, offsite = 'onedrive') => {
  fs.writeFileSync(path.join(env.BACKUP_DIR, 'cccs-20261110-023000.tar.gz.enc'), 'x');
  fs.writeFileSync(path.join(env.BACKUP_DIR, 'last-backup.json'), JSON.stringify({ ok: true, exit_code: 0, offsite }));
};
const reset = () => { fake.mails = []; fake.texts = []; fake.pings = []; fake.cccsUp = true; fake.twilioFails = false; };

test('down after two failed checks (not one), texts and emails once, then says when it is back', async () => {
  reset(); const dir = fs.mkdtempSync(path.join(T, 'a-')); const env = wdEnv(dir); freshBackup(env);
  assert.equal((await runNode(WATCHDOG, [], env)).status, 0);
  assert.equal(fake.mails.length + fake.texts.length, 0, 'healthy: nothing sent');
  assert.deepEqual(fake.pings, ['/ping/abc']);
  fake.cccsUp = false;
  await runNode(WATCHDOG, [], env);
  assert.equal(fake.mails.length + fake.texts.length, 0, 'one blip is not an outage');
  await runNode(WATCHDOG, [], env);
  assert.equal(fake.texts.length, 1); assert.equal(fake.mails.length, 1);
  assert.match(fake.texts[0].Body, /CCCS IS DOWN/); assert.equal(fake.texts[0].To, '+447700900123');
  assert.match(fake.mails[0].message.subject, /CCCS IS DOWN/);
  assert.equal(fake.pings.at(-1), '/ping/abc/fail');
  await runNode(WATCHDOG, [], env);
  assert.equal(fake.texts.length, 1, 'not repeated every 2 minutes');
  fake.cccsUp = true;
  await runNode(WATCHDOG, [], env);
  assert.equal(fake.texts.length, 2); assert.match(fake.texts[1].Body, /back up/);
  assert.equal(fake.pings.at(-1), '/ping/abc');
});

test('an email still goes when Twilio refuses (the account is inactive)', async () => {
  reset(); fake.twilioFails = true; const dir = fs.mkdtempSync(path.join(T, 'b-')); const env = wdEnv(dir); freshBackup(env);
  const r = await runNode(WATCHDOG, ['--test'], env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fake.mails.length, 1);
  assert.match(r.stdout, /FAILED to send by text.*not active/);
});

test('backup late, not copied off, or only on this server are each reported', async () => {
  reset(); const dir = fs.mkdtempSync(path.join(T, 'c-')); const env = wdEnv(dir);
  await runNode(WATCHDOG, [], env);
  assert.match(fake.mails.map((m) => m.message.body.content).join('\n'), /No backup archives/);
  reset(); const d1 = fs.mkdtempSync(path.join(T, 'c2-')); const e1 = wdEnv(d1);
  const f = path.join(e1.BACKUP_DIR, 'cccs-20261101-023000.tar.gz.enc'); fs.writeFileSync(f, 'x');
  const old = (Date.now() - 50 * 3600e3) / 1000; fs.utimesSync(f, old, old);
  fs.writeFileSync(path.join(e1.BACKUP_DIR, 'last-backup.json'), JSON.stringify({ ok: false, exit_code: 2, offsite: 'failed', offsite_error: '403 Access denied' }));
  await runNode(WATCHDOG, [], e1);
  const subjects = fake.mails.map((m) => m.message.subject);
  assert.ok(subjects.some((s) => /backup problem/.test(s)), subjects.join());
  assert.ok(subjects.some((s) => /not copied off/.test(s)), subjects.join());
  reset(); const d2 = fs.mkdtempSync(path.join(T, 'd-')); const e2 = wdEnv(d2); freshBackup(e2, 'none');
  await runNode(WATCHDOG, [], e2);
  assert.deepEqual(fake.mails.map((m) => m.message.subject), ['CCCS backups are only on the server']);
});

test('no alert while an auto-deploy holds its lock', async (t) => {
  if (spawnSync('flock', ['--version']).status !== 0) return t.skip('no flock here');
  reset(); fake.cccsUp = false; const dir = fs.mkdtempSync(path.join(T, 'e-')); const env = wdEnv(dir); freshBackup(env);
  const lock = path.join(dir, 'deploy.lock'); fs.writeFileSync(lock, ''); env.WATCHDOG_DEPLOY_LOCK = lock;
  const holder = spawn('flock', [lock, 'sleep', '30']); await new Promise((r) => setTimeout(r, 300));
  try { for (let i = 0; i < 3; i++) await runNode(WATCHDOG, [], env); } finally { holder.kill(); }
  assert.equal(fake.texts.length + fake.mails.length, 0);
});

test('offsite copy uploads in chunks, byte for byte, and keeps only BACKUP_REMOTE_KEEP of its own files', async () => {
  fake.drive.clear();
  fake.drive.set('mine-old', { id: 'mine-old', name: 'cccs-20260101-023000.tar.gz.enc', size: 1, data: Buffer.from('x') });
  fake.drive.set('not-mine', { id: 'not-mine', name: 'notes.docx', size: 1, data: Buffer.from('x') });
  const f = path.join(T, 'cccs-20261110-023000.tar.gz.enc');
  const data = Buffer.alloc(700 * 1024 + 5, 7); data[0] = 1; data[data.length - 1] = 9; fs.writeFileSync(f, data);
  const r = await runNode(OFFSITE, [f], { ...msEnv(), BACKUP_ONEDRIVE_USER: 'andy@example.com', BACKUP_REMOTE_KEEP: '1', BACKUP_CHUNK_KB: '320' });
  assert.equal(r.status, 0, r.stderr);
  const up = [...fake.drive.values()].find((i) => i.name === path.basename(f));
  assert.ok(up.data.equals(data), 'uploaded exactly');
  assert.equal(up.folder, 'CCCS backups');
  assert.ok(!fake.drive.has('mine-old'), 'oldest of ours removed');
  assert.ok(fake.drive.has('not-mine'), 'other files left alone');
});

test('offsite copy without a OneDrive user fails loudly', async () => {
  const f = path.join(T, 'x.enc'); fs.writeFileSync(f, 'x');
  const r = await runNode(OFFSITE, [f], msEnv());
  assert.notEqual(r.status, 0); assert.match(r.stderr, /NOT copied off this server: BACKUP_ONEDRIVE_USER/);
});

test('backup.sh records the run for the watchdog, and an offsite failure exits 2 with the reason', async () => {
  const dir = fs.mkdtempSync(path.join(T, 'f-')); const data = path.join(dir, 'data'); fs.mkdirSync(data);
  const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(path.join(data, 'cccs.db')); db.exec('CREATE TABLE t(x)'); db.close();
  const env = { PATH: process.env.PATH, ENV_FILE: path.join(dir, 'none.env'), DATA_FILE: path.join(data, 'cccs.db'), BACKUP_DIR: path.join(dir, 'b'),
    BACKUP_KEY_FILE: path.join(dir, 'none.key'), CCCS_LIB: path.dirname(OFFSITE), BACKUP_ONEDRIVE_USER: 'andy@example.com', ...msEnv(), MS_CLIENT_SECRET: '' };
  const r = await new Promise((resolve) => { const p = spawn('bash', [BACKUP], { env }); let e = ''; p.stderr.on('data', (d) => { e += d; }); p.on('close', (status) => resolve({ status, stderr: e })); });
  assert.equal(r.status, 2, r.stderr);
  const last = JSON.parse(fs.readFileSync(path.join(env.BACKUP_DIR, 'last-backup.json'), 'utf8'));
  assert.equal(last.offsite, 'failed'); assert.match(last.offsite_error, /MS_CLIENT_SECRET/);
  assert.ok(fs.existsSync(last.file), 'the local archive is still kept');
});
