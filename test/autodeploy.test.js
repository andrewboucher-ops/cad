/* deploy/autodeploy.sh against a throwaway "GitHub" (a bare repo) and a
 * stand-in deploy/update.sh — new commits deploy once, a failed version is
 * not retried until something newer arrives, unpushed server commits and a
 * pause file are left alone — node --test */
'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'deploy', 'autodeploy.sh');
let T, ORIGIN, WORK, SRC, APP, DATA, env;
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
// The stand-in deploy: records each run and writes VERSION.json like the
// real one; fails when the commit carries a FAIL file.
const FAKE_UPDATE = `#!/usr/bin/env bash
set -e
SRC="$(cd "$(dirname "$0")/.." && pwd)"
echo "$(git -C "$SRC" rev-parse HEAD)" >> "$RUNS_FILE"
[ -f "$SRC/FAIL" ] && { echo "tests failed"; exit 1; }
printf '{"commit":"%s"}' "$(git -C "$SRC" rev-parse HEAD)" > "$APP_DIR/VERSION.json"
`;
const commit = (msg, files = {}) => {
  for (const [f, c] of Object.entries(files)) {
    if (c === null) fs.rmSync(path.join(WORK, f), { force: true }); else fs.writeFileSync(path.join(WORK, f), c);
  }
  git(WORK, 'add', '-A'); git(WORK, 'commit', '-q', '-m', msg); git(WORK, 'push', '-q', 'origin', 'main');
  return git(WORK, 'rev-parse', 'HEAD');
};
const run = () => spawnSync('bash', [SCRIPT], { env, encoding: 'utf8' });
const runs = () => (fs.existsSync(env.RUNS_FILE) ? fs.readFileSync(env.RUNS_FILE, 'utf8').trim().split('\n').filter(Boolean) : []);
const status = () => JSON.parse(fs.readFileSync(path.join(DATA, 'deploy-status.json'), 'utf8'));

before(() => {
  T = fs.mkdtempSync(path.join(os.tmpdir(), 'autodeploy-'));
  ORIGIN = path.join(T, 'origin.git'); WORK = path.join(T, 'work'); SRC = path.join(T, 'src'); APP = path.join(T, 'app'); DATA = path.join(T, 'data');
  for (const d of [APP, DATA]) fs.mkdirSync(d);
  git(T, 'init', '-q', '--bare', '-b', 'main', ORIGIN);
  git(T, 'clone', '-q', ORIGIN, WORK);
  git(WORK, 'checkout', '-q', '-b', 'main');
  fs.mkdirSync(path.join(WORK, 'deploy'));
  fs.writeFileSync(path.join(WORK, 'deploy', 'update.sh'), FAKE_UPDATE);
  fs.copyFileSync(SCRIPT, path.join(WORK, 'deploy', 'autodeploy.sh'));
  commit('first', { 'a.txt': '1' });
  git(T, 'clone', '-q', ORIGIN, SRC);
  fs.writeFileSync(path.join(T, 'cccs.env'), `DATA_FILE=${path.join(DATA, 'cccs.db')}\n`);
  env = {
    PATH: process.env.PATH, HOME: process.env.HOME || T, SRC_DIR: SRC, APP_DIR: APP, ENV_FILE: path.join(T, 'cccs.env'),
    PAUSE_FILE: path.join(T, 'autodeploy.off'), LOG: path.join(T, 'autodeploy.log'), STATE_DIR: path.join(T, 'state'),
    LOCK_FILE: path.join(T, 'lock'), RUNS_FILE: path.join(T, 'runs'), SERVICE: 'cccs-test-none',
  };
});

test('the first check deploys what is checked out when nothing is recorded as live; then nothing to do', () => {
  assert.equal(run().status, 0);
  assert.equal(runs().length, 1);
  assert.equal(status().result, 'ok');
  assert.equal(run().status, 0);
  assert.equal(runs().length, 1, 'already live — no second deploy');
});

test('a new commit on GitHub is pulled and deployed once', () => {
  const sha = commit('second', { 'a.txt': '2' });
  assert.equal(run().status, 0);
  assert.equal(git(SRC, 'rev-parse', 'HEAD'), sha);
  assert.equal(runs().at(-1), sha);
  assert.equal(status().result, 'ok');
  assert.match(status().subject, /second/);
  run();
  assert.equal(runs().length, 2);
});

test('a version that fails to deploy is reported and not retried until something newer arrives', () => {
  const bad = commit('broken', { FAIL: 'x' });
  assert.equal(run().status, 1);
  assert.equal(status().result, 'failed');
  assert.match(status().log_tail, /tests failed/);
  const n = runs().length;
  run(); run();
  assert.equal(runs().length, n, 'not retried every few minutes');
  assert.equal(runs().at(-1), bad);
  const fixed = commit('fixed', { FAIL: null });
  assert.equal(run().status, 0);
  assert.equal(runs().at(-1), fixed);
  assert.equal(status().result, 'ok');
});

test('a pause file stops it, and commits made on the server but not pushed are left alone', () => {
  const sha = commit('while paused', { 'a.txt': '3' });
  fs.writeFileSync(env.PAUSE_FILE, '');
  const n = runs().length;
  run();
  assert.equal(runs().length, n);
  fs.rmSync(env.PAUSE_FILE);
  run();
  assert.equal(runs().at(-1), sha);

  fs.writeFileSync(path.join(SRC, 'local.txt'), 'x');
  git(SRC, 'add', '-A'); git(SRC, 'commit', '-q', '-m', 'made on the server');
  const m = runs().length;
  run();
  assert.equal(runs().length, m, 'unpushed server commits are never auto-deployed');
});
