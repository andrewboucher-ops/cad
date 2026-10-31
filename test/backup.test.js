/* deploy/backup.sh against a throwaway data folder — node --test
 *
 * The nightly backup must carry the uploads as well as the database, be
 * encrypted when a key exists, open with that key, and keep only the
 * newest BACKUP_KEEP archives. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'deploy', 'backup.sh');

function setup() {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'cccs-backup-'));
  const data = path.join(T, 'data'); fs.mkdirSync(path.join(data, 'uploads', 'applicants', '7'), { recursive: true });
  fs.mkdirSync(path.join(data, 'workstation-release'));
  fs.writeFileSync(path.join(data, 'uploads', 'applicants', '7', 'cv.pdf'), '%PDF-1.4 test');
  fs.writeFileSync(path.join(data, 'workstation-release', 'setup.exe'), 'big installer');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(data, 'cccs.db'));
  db.exec("CREATE TABLE t(x); INSERT INTO t VALUES ('kept');"); db.close();
  const env = { ...process.env, ENV_FILE: path.join(T, 'none.env'), DATA_FILE: path.join(data, 'cccs.db'), BACKUP_DIR: path.join(T, 'backups'), BACKUP_KEEP: '2', BACKUP_KEY_FILE: path.join(T, 'backup.key'), BACKUP_RCLONE_REMOTE: '' };
  return { T, env };
}
const run = (env) => spawnSync('bash', [SCRIPT], { env, encoding: 'utf8' });

test('an encrypted archive holds the database and uploads, not the installer, and opens with the key', () => {
  const { T, env } = setup();
  try {
    fs.writeFileSync(env.BACKUP_KEY_FILE, 'test-passphrase\n');
    const r = run(env);
    assert.strictEqual(r.status, 0, r.stderr);
    const [file] = fs.readdirSync(env.BACKUP_DIR).filter((f) => f.endsWith('.tar.gz.enc'));
    assert.ok(file, 'an .enc archive was written');
    assert.ok(!fs.readFileSync(path.join(env.BACKUP_DIR, file)).includes('%PDF'), 'contents are not readable without the key');
    const out = path.join(T, 'restore'); fs.mkdirSync(out);
    execFileSync('bash', ['-c', `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:"${env.BACKUP_KEY_FILE}" -in "${path.join(env.BACKUP_DIR, file)}" | tar -xzf - -C "${out}"`]);
    assert.strictEqual(fs.readFileSync(path.join(out, 'uploads', 'applicants', '7', 'cv.pdf'), 'utf8'), '%PDF-1.4 test');
    assert.ok(!fs.existsSync(path.join(out, 'workstation-release')));
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(out, 'cccs.db'));
    assert.strictEqual(db.prepare('SELECT x FROM t').get().x, 'kept'); db.close();
    assert.match(r.stderr, /only on this server/);
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
});

test('without a key it still backs up, says so loudly, and keeps only the newest BACKUP_KEEP', () => {
  const { T, env } = setup();
  try {
    for (let i = 0; i < 3; i++) {
      const r = run(env);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.match(r.stderr, /NOT encrypted/);
      execFileSync('sleep', ['1.1']); // archives are named by the second
    }
    assert.strictEqual(fs.readdirSync(env.BACKUP_DIR).filter((f) => f.startsWith('cccs-')).length, 2);
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
});
