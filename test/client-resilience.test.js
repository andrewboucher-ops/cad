/* Officer app staying usable through bad signal and server restarts —
   public/app.js's queue under stubbed browser globals (same approach as
   client-offline.test.js): what is kept, what is retried, what is shown
   as refused, and that a replay says when it was really made. */
const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const store = new Map(); const sent = [];
let respond = () => ({ status: 200, body: { ok: true } }); // or 'offline'
const sandbox = { console,
  crypto: { randomUUID: () => 'id-' + Math.random().toString(36).slice(2) },
  localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k), key: (i) => [...store.keys()][i], get length() { return store.size; } },
  sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  indexedDB: { open() { const r = {}; queueMicrotask(() => { r.error = new Error('no idb'); r.onerror && r.onerror(); }); return r; } },
  location: { protocol: 'http:', host: 'x', pathname: '/officer.html' },
  document: { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] },
  WebSocket: function () { this.close = () => {}; },
  atob: (b) => Buffer.from(b, 'base64').toString('binary'),
  fetch: async (p, opts) => {
    const r = respond(p, opts);
    if (r === 'offline') throw new TypeError('Failed to fetch');
    sent.push({ path: p, headers: opts.headers, body: opts.body });
    return { ok: r.status < 400, status: r.status, statusText: '', text: async () => JSON.stringify(r.body) };
  },
  setTimeout, clearTimeout, setInterval, clearInterval };
sandbox.window = sandbox; sandbox.window.addEventListener = () => {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8') + '\nglobalThis.__C=CCCS;', sandbox);

let C;
before(() => { C = sandbox.__C; C.setSession({ token: 't', user: { id: 1, personnel_id: 101 } }); });

test('a write made while CCCS is restarting (502) is kept and sent later, not lost', async () => {
  respond = () => ({ status: 502, body: { error: 'bad gateway' } });
  const r = await C.send('POST', '/api/shift-assignments/7/clock-out', {}, 'clock out');
  assert.ok(r.queued);
  await C.outbox.flush();
  assert.equal(C.outbox.count(), 1, 'still waiting after another 502');
  respond = () => ({ status: 200, body: { ok: true } });
  await C.outbox.flush();
  assert.equal(C.outbox.count(), 0);
});
test('a replayed write says when it was really pressed', async () => {
  respond = () => 'offline';
  await C.send('POST', '/api/shift-assignments/8/clock-out', {}, 'clock out');
  const queuedAt = C.outbox.pending()[0].at;
  respond = () => ({ status: 200, body: { ok: true } });
  const before = sent.length;
  await C.outbox.flush();
  const replay = sent.slice(before).find((x) => x.path.endsWith('/8/clock-out'));
  assert.equal(replay.headers['x-cccs-occurred-at'], queuedAt);
});
test('a signed-out session (401) keeps the queue intact and tells the page', async () => {
  let told = 0; C.onSessionExpired(() => told++);
  respond = () => 'offline';
  await C.send('PATCH', '/api/jobs/1', { status: 'ON_SCENE' }, 'on scene');
  respond = () => ({ status: 401, body: { error: 'authentication required' } });
  await C.outbox.flush();
  assert.equal(C.outbox.count(), 1, 'kept until signed in again');
  assert.equal(told, 1);
  C.setSession({ token: 't3', user: { id: 1, personnel_id: 101 } });
  respond = () => ({ status: 200, body: { ok: true } });
  await C.outbox.flush();
  assert.equal(C.outbox.count(), 0);
});
test('a write the server turns down is kept in a list the officer can see, with the reason', async () => {
  respond = () => 'offline';
  await C.send('POST', '/api/shift-assignments/9/clock-out', {}, 'clock out');
  respond = () => ({ status: 409, body: { error: 'already clocked out' } });
  await C.outbox.flush();
  assert.equal(C.outbox.count(), 0, 'not retried forever');
  const f = C.outbox.failed();
  assert.equal(f.length, 1);
  assert.equal(f[0].label, 'clock out');
  assert.equal(f[0].error, 'already clocked out');
  C.outbox.dismissFailed();
  assert.equal(C.outbox.failed().length, 0);
});
test('a write the server refuses straight away is not queued — the officer sees the error', async () => {
  respond = () => ({ status: 403, body: { error: 'not your shift' } });
  await assert.rejects(() => C.send('POST', '/api/shift-assignments/10/clock-out', {}, 'clock out'), /not your shift/);
  assert.equal(C.outbox.count(), 0);
});
test('saved copies fall back only when the server can\'t be reached, and go at sign-out', async () => {
  respond = () => ({ status: 200, body: [{ id: 1 }] });
  assert.equal((await C.readThrough('shifts', '/api/shifts')).savedAt, null);
  respond = () => 'offline';
  const r = await C.readThrough('shifts', '/api/shifts');
  assert.ok(r.savedAt);
  assert.deepEqual(JSON.parse(JSON.stringify(r.data)), [{ id: 1 }]);
  respond = () => ({ status: 403, body: { error: 'no' } });
  await assert.rejects(() => C.readThrough('shifts', '/api/shifts'), /no/);
  respond = () => ({ status: 200, body: { ok: true } });
  C.clearSession();
  assert.equal(C.snapshot.load('shifts'), null);
});
test('renewing the session swaps in the new token', async () => {
  C.setSession({ token: 'old', user: { id: 1, personnel_id: 101 } });
  respond = (p) => (p === '/api/auth/refresh' ? { status: 200, body: { token: 'new', user: { id: 1, personnel_id: 101 } } } : { status: 200, body: {} });
  assert.equal(await C.refreshSession({ force: true }), true);
  assert.equal(C.getSession().token, 'new');
  respond = (p) => (p === '/api/auth/refresh' ? 'offline' : { status: 200, body: {} });
  assert.equal(await C.refreshSession({ force: true }), null, 'unreachable is not the same as signed out');
  assert.equal(C.getSession().token, 'new');
});
