/* Check calls, alerts and PC updates for control room PCs off the VPN,
 * relayed through CCCS to the check call host (routes-checkcalls.js) — node --test */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.PORT = '4047';
process.env.AUTH_SECRET = 'checkcalls-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';
process.env.WORKSTATION_SECRET = 'pc-secret';
process.env.CHECKCALL_HOST_SECRET = 'host-secret';
process.env.WORKSTATION_RELEASE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cccs-release-'));

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;

async function req(method, p, { body, pc, host, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (body !== undefined && !raw) h['content-type'] = 'application/json';
  if (pc) h['x-workstation-secret'] = pc === true ? 'pc-secret' : pc;
  if (host) h['x-checkcall-host-secret'] = host === true ? 'host-secret' : host;
  const res = await fetch(BASE + p, { method, headers: h, body: raw || (body === undefined ? undefined : JSON.stringify(body)) }).catch((e) => { throw e.cause || e; });
  const buf = Buffer.from(await res.arrayBuffer());
  let parsed = null; try { parsed = JSON.parse(buf.toString()); } catch { parsed = buf; }
  return { status: res.status, body: parsed, headers: res.headers };
}
const pcBody = (extra = {}) => ({ workstation: 'HOME-PC', user: 'kayleigh', ...extra });
const sync = (body) => req('POST', '/api/integrations/checkcall-host/sync', { host: true, body });

before(async () => { app.start(); await new Promise((r) => setTimeout(r, 200)); });
after(() => { app.server.closeAllConnections?.(); app.server.close(); fs.rmSync(process.env.WORKSTATION_RELEASE_DIR, { recursive: true, force: true }); });

test('PCs and the host each need their own secret', async () => {
  assert.equal((await req('GET', '/api/integrations/workstation/checkcalls')).status, 401);
  assert.equal((await req('GET', '/api/integrations/workstation/checkcalls', { pc: 'wrong' })).status, 401);
  assert.equal((await req('POST', '/api/integrations/checkcall-host/sync', { pc: true, body: {} })).status, 401, 'the PC secret cannot act as the host');
  assert.equal((await req('PUT', '/api/integrations/checkcall-host/release', { pc: true, raw: 'x' })).status, 401, 'nor publish an installer');
  const r = await req('GET', '/api/integrations/workstation/checkcalls', { pc: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.host_stale, true, 'nothing heard from the host yet');
});

test('a PC off the VPN programmes and stops check calls, and the host applies them', async () => {
  await sync({ schedules: [{ active: true, extension: '901', number: '01472000001', set_by: 'andy', owner: 'CONTROL-01' }], alerts: [] });

  assert.equal((await req('PUT', '/api/integrations/workstation/checkcalls/PJSIP-1', { pc: true, body: pcBody({ number: '07700900123' }) })).status, 400);
  assert.equal((await req('PUT', '/api/integrations/workstation/checkcalls/906', { pc: true, body: pcBody({ number: '09001234567' }) })).status, 403, 'premium rate refused');
  assert.equal((await req('PUT', '/api/integrations/workstation/checkcalls/906', { pc: true, body: pcBody({ number: '0044123456789' }) })).status, 403, 'international refused');

  const save = await req('PUT', '/api/integrations/workstation/checkcalls/906', { pc: true, body: pcBody({ number: '+44 7700 900123' }) });
  assert.equal(save.status, 202, JSON.stringify(save.body));
  const stop = await req('POST', '/api/integrations/workstation/checkcalls/901/stop', { pc: true, body: pcBody() });
  assert.equal(stop.status, 202);

  const seen = (await req('GET', '/api/integrations/workstation/checkcalls', { pc: true })).body;
  assert.equal(seen.host_stale, false);
  const s906 = seen.schedules.find((s) => s.extension === '906');
  assert.deepEqual([s906.active, s906.number, s906.set_by, s906.owner, s906.pending], [true, '07700900123', 'kayleigh', 'HOME-PC', true],
    'the PC sees its own change straight away, number normalised');
  assert.equal(seen.schedules.find((s) => s.extension === '901').active, false);

  // The host collects both, in order, and reports them applied.
  const first = (await sync({ schedules: [{ active: true, extension: '901', number: '01472000001' }], alerts: [] })).body;
  assert.deepEqual(first.pending.map((c) => [c.kind, c.extension]), [['save', '906'], ['stop', '901']]);
  assert.equal(first.release_wanted, false, 'the host has nothing published');

  // Until it does, a fresh push from the host does not undo what the PC sees.
  let view = (await req('GET', '/api/integrations/workstation/checkcalls', { pc: true })).body;
  assert.equal(view.schedules.find((s) => s.extension === '901').active, false);

  const applied = (await sync({
    results: first.pending.map((c) => ({ id: c.id, ok: true })),
    schedules: [{ active: false, extension: '901', number: '01472000001' }, { active: true, extension: '906', number: '07700900123', set_by: 'kayleigh' }],
    alerts: [],
  })).body;
  assert.deepEqual(applied.pending, [], 'nothing applied twice');
  view = (await req('GET', '/api/integrations/workstation/checkcalls', { pc: true })).body;
  assert.equal(view.schedules.find((s) => s.extension === '906').pending, undefined, 'now straight from the share');
  const cmd = (await req('GET', `/api/integrations/workstation/commands/${save.body.command_id}`, { pc: true })).body;
  assert.equal(cmd.status, 'APPLIED');
});

test('the first acknowledgement on the share wins, and a PC off the VPN is told who has it', async () => {
  const alert = { id: 'checkcall-906-2026101221', title: 'Check Call Not Answered - Escalate', message: 'Escalate', raised_at: '2026-10-12 21:20:00' };
  await sync({ schedules: [], alerts: [alert] });
  assert.equal((await req('POST', '/api/integrations/workstation/alerts/nope/ack', { pc: true, body: pcBody() })).status, 404);
  assert.equal((await req('POST', '/api/integrations/workstation/alerts/..%2Fx/ack', { pc: true, body: pcBody() })).status, 400);

  const mine = (await req('POST', `/api/integrations/workstation/alerts/${alert.id}/ack`, { pc: true, body: pcBody() })).body;
  assert.equal(mine.confirmed, false, 'provisional until the host applies it');
  assert.equal(mine.ack.user, 'kayleigh');
  const second = (await req('POST', `/api/integrations/workstation/alerts/${alert.id}/ack`, { pc: true, body: pcBody({ workstation: 'LAPTOP-2', user: 'ben' }) })).body;
  assert.equal(second.ack.user, 'kayleigh', 'a second PC off the VPN is told the first has it');
  assert.equal(second.command_id, mine.command_id);
  const shown = (await req('GET', '/api/integrations/workstation/alerts', { pc: true })).body.alerts[0];
  assert.equal(shown.ack.user, 'kayleigh', 'and other PCs stop showing it');

  // But a desk on the VPN wrote to the share first: the host says so.
  const winner = { user: 'andy', machine: 'CONTROL-01', at: '2026-10-12 21:20:03' };
  const p = (await sync({ schedules: [], alerts: [alert] })).body.pending;
  assert.deepEqual(p.map((c) => c.kind), ['ack']);
  await sync({ results: [{ id: p[0].id, ok: true, result: { ack: winner } }], schedules: [], alerts: [{ ...alert, ack: winner }] });
  const cmd = (await req('GET', `/api/integrations/workstation/commands/${mine.command_id}`, { pc: true })).body;
  assert.equal(cmd.status, 'APPLIED');
  assert.deepEqual(cmd.result.ack, winner, 'the PC learns it was not first');
  const again = (await req('POST', `/api/integrations/workstation/alerts/${alert.id}/ack`, { pc: true, body: pcBody() })).body;
  assert.deepEqual([again.confirmed, again.ack.user], [true, 'andy']);
});

test('audit entries from a PC off the VPN are passed to the host to file', async () => {
  assert.equal((await req('POST', '/api/integrations/workstation/audit', { pc: true, body: pcBody({ line: 'not json' }) })).status, 400);
  assert.equal((await req('POST', '/api/integrations/workstation/audit', { pc: true, body: pcBody({ line: '{"type":"x"}' }) })).status, 400, 'needs a timestamp');
  const line = JSON.stringify({ ts: '2026-10-12 21:20:05', type: 'alert_ack', user: 'kayleigh', machine: 'HOME-PC' });
  assert.equal((await req('POST', '/api/integrations/workstation/audit', { pc: true, body: pcBody({ lines: [line, line] }) })).status, 202);
  const p = (await sync({ schedules: [], alerts: [] })).body.pending;
  assert.deepEqual(p.map((c) => [c.kind, c.line]), [['audit', line], ['audit', line]]);
  await sync({ results: p.map((c) => ({ id: c.id, ok: true })), schedules: [], alerts: [] });
});

test('the host publishes the PC installer here, and PCs off the VPN download it', async () => {
  assert.equal((await req('GET', '/api/integrations/workstation/release', { pc: true })).status, 404, 'nothing yet');
  const exe = crypto.randomBytes(12 * 1024 * 1024); // bigger than the JSON body limit
  const sha = crypto.createHash('sha256').update(exe).digest('hex').toUpperCase();
  assert.equal((await sync({ schedules: [], alerts: [], release: { version: '3.6', file: 'EchelonControlRoom-Setup-3.6.exe', sha256: sha } })).body.release_wanted, true);

  const put = (headers, raw = exe) => req('PUT', '/api/integrations/checkcall-host/release', { host: true, raw, headers });
  const good = { 'x-release-version': '3.6', 'x-release-file': 'EchelonControlRoom-Setup-3.6.exe', 'x-release-sha256': sha };
  assert.equal((await put({ ...good, 'x-release-file': '../evil.exe' })).status, 400);
  const bad = await put({ ...good, 'x-release-sha256': 'A'.repeat(64) });
  assert.equal(bad.status, 400, 'a corrupted upload is refused');
  assert.equal((await req('GET', '/api/integrations/workstation/release', { pc: true })).status, 404, 'and never offered to PCs');
  assert.deepEqual(fs.readdirSync(process.env.WORKSTATION_RELEASE_DIR), [], 'nor left on disk');

  const ok = await put(good);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const m = (await req('GET', '/api/integrations/workstation/release', { pc: true })).body;
  assert.deepEqual([m.version, m.sha256, m.size], ['3.6', sha, exe.length]);
  assert.equal((await req('GET', '/api/integrations/workstation/release/file')).status, 401);
  const dl = await req('GET', '/api/integrations/workstation/release/file', { pc: true });
  assert.equal(dl.status, 200);
  assert.ok(Buffer.compare(dl.body, exe) === 0, 'the same bytes come back');
  assert.equal((await sync({ schedules: [], alerts: [], release: { sha256: sha } })).body.release_wanted, false);

  // The next build replaces it.
  const exe2 = Buffer.from('build 3.7');
  const sha2 = crypto.createHash('sha256').update(exe2).digest('hex');
  assert.equal((await put({ 'x-release-version': '3.7', 'x-release-file': 'EchelonControlRoom-Setup-3.7.exe', 'x-release-sha256': sha2 }, exe2)).status, 200);
  assert.deepEqual(fs.readdirSync(process.env.WORKSTATION_RELEASE_DIR).sort(), ['EchelonControlRoom-Setup-3.7.exe', 'release.json']);
});
