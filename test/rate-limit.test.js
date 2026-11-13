/* Who shares a rate-limit bucket — node --test. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createRateLimiter } = require('../rate-limit.js');

function rig(limits = { user: 3, auth: 2, ip: 3 }) {
  let t = 0; const logs = [];
  const rl = createRateLimiter({ limits, now: () => t, log: (m) => logs.push(m) });
  return { rl, logs, tick: (ms) => { t += ms; } };
}
const fill = (rl, req, n) => { for (let i = 0; i < n; i++) rl.check(req); };

test('signed-in users behind one address each get their own allowance', () => {
  const { rl } = rig();
  fill(rl, { pathname: '/api/jobs', ip: '203.0.113.5', userId: 1 }, 3);
  assert.equal(rl.check({ pathname: '/api/jobs', ip: '203.0.113.5', userId: 1 }), false, 'user 1 is over');
  assert.equal(rl.check({ pathname: '/api/jobs', ip: '203.0.113.5', userId: 2 }), true, 'user 2 at the same address is not');
});

test('anonymous traffic filling the address bucket does not block signing in', () => {
  const { rl } = rig();
  fill(rl, { pathname: '/api/public/applications', ip: '203.0.113.5' }, 10);
  assert.equal(rl.check({ pathname: '/api/public/applications', ip: '203.0.113.5' }), false);
  assert.equal(rl.check({ pathname: '/api/auth/microsoft/callback', ip: '203.0.113.5' }), true);
  assert.equal(rl.check({ pathname: '/api/auth/login', ip: '203.0.113.5' }), true);
  assert.equal(rl.bucketFor({ pathname: '/api/auth/microsoft/status', ip: 'x' }).key, 'auth:x', 'the sign-in button check is a sign-in route');
  assert.equal(rl.check({ pathname: '/api/auth/microsoft/login', ip: '203.0.113.5' }), false, 'sign-in still has its own cap');
});

test('a window resets after a minute, and an overflow is logged once with its busiest paths', () => {
  const { rl, logs, tick } = rig();
  fill(rl, { pathname: '/api/units/12/position', ip: '198.51.100.1' }, 6);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /ip:198\.51\.100\.1.*\/api\/units\/:id\/position ×/);
  tick(60000);
  assert.equal(rl.check({ pathname: '/api/units/12/position', ip: '198.51.100.1' }), true);
  rl.stop();
});

test('control room PCs and the check call host have their own bucket, apart from anonymous traffic', () => {
  const { rl } = rig({ user: 3, auth: 2, ip: 3, integration: 4 });
  fill(rl, { pathname: '/api/client/portal', ip: '203.0.113.5' }, 10);
  assert.equal(rl.check({ pathname: '/api/client/portal', ip: '203.0.113.5' }), false, 'general bucket is full');
  assert.equal(rl.check({ pathname: '/api/integrations/workstation/alerts', ip: '203.0.113.5' }), true, 'a PC polling alerts still gets through');
  assert.equal(rl.bucketFor({ pathname: '/api/integrations/checkcall-host/sync', ip: 'x' }).key, 'integration:x');
  assert.equal(rl.bucketFor({ pathname: '/api/integrations/aura/callout', ip: 'x' }).key, 'ip:x', 'other integrations are unchanged');
  fill(rl, { pathname: '/api/integrations/workstation/alerts', ip: '203.0.113.5' }, 4);
  assert.equal(rl.check({ pathname: '/api/integrations/workstation/alerts', ip: '203.0.113.5' }), false, 'and it has a cap of its own');
  rl.stop();
});
