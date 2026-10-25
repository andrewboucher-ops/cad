/* Admin → Users "Last login" — node --test. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';

const app = require('../server.js');

test('accounts that signed in before last_login_at was stamped get it back from the audit log', () => {
  const { db } = app;
  const blank = { id: 90001, username: 'sso-before-fix', role: 'DISPATCHER' };
  const stamped = { id: 90002, username: 'already-stamped', role: 'DISPATCHER', last_login_at: '2026-10-20T09:00:00.000Z' };
  const never = { id: 90003, username: 'never-signed-in', role: 'DISPATCHER' };
  db.users.push(blank, stamped, never);
  db.audit_logs.push(
    { id: 990001, type: 'auth.login', summary: 'sso-before-fix signed in via Microsoft', data: { user_id: 90001 }, at: '2026-10-14T08:00:00.000Z' },
    { id: 990002, type: 'auth.login', summary: 'sso-before-fix signed in via Microsoft', data: { user_id: 90001 }, at: '2026-10-22T07:30:00.000Z' },
    { id: 990003, type: 'auth.login', summary: 'already-stamped signed in', data: { user_id: 90002 }, at: '2026-10-01T09:00:00.000Z' },
    { id: 990004, type: 'auth.failed', summary: 'Failed login for never-signed-in', data: { user_id: 90003 }, at: '2026-10-23T09:00:00.000Z' },
  );

  assert.equal(app.backfillLastLogins(), 1);
  assert.equal(blank.last_login_at, '2026-10-22T07:30:00.000Z', 'the newest sign-in wins');
  assert.equal(stamped.last_login_at, '2026-10-20T09:00:00.000Z', 'a real stamp is never moved');
  assert.ok(!never.last_login_at, 'a failed attempt is not a login');
  assert.equal(app.backfillLastLogins(), 0, 'running it again changes nothing');
});
