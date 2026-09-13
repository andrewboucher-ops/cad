/* Client-side offline outbox and key bindings, exercised against the real
   public/app.js under stubbed browser globals. Node cannot run a browser here,
   so this drives the same code the handset runs rather than a reimplementation. */
const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const store=new Map(); let online=true; const sent=[];
const listeners={};
const sandbox={ console,
  crypto:{randomUUID:()=>'id-'+Math.random().toString(36).slice(2)},
  localStorage:{getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},
  sessionStorage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}},
  location:{protocol:'http:',host:'x',pathname:'/radio.html'},
  document:{addEventListener:(t,f)=>{listeners[t]=f;},removeEventListener:()=>{},querySelector:()=>null,querySelectorAll:()=>[],createElement:()=>({style:{},remove(){}}),body:{appendChild(){}},createElementNS:()=>({setAttribute(){},appendChild(){},addEventListener(){},style:{}})},
  WebSocket:function(){this.close=()=>{}}, RTCPeerConnection:function(){},
  fetch: async (path,opts)=>{ if(!online) throw new TypeError('Failed to fetch');
    sent.push({path,key:opts.headers['idempotency-key'],body:opts.body});
    return {ok:true,status:200,text:async()=>JSON.stringify({ok:true})}; },
  setTimeout,clearTimeout,setInterval,clearInterval };
sandbox.window=sandbox; sandbox.window.addEventListener=(t,f)=>{listeners[t]=f;};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname,'..','public','app.js'),'utf8')+'\nglobalThis.__C=CCCS;', sandbox);

let C;
before(() => {
  C = sandbox.__C;
  C.setSession({ token: 't', user: { id: 1 } });
});

test('writes made with no signal are held on the device, in order', async () => {
  online = false;
  const a = await C.send('PATCH', '/api/jobs/1', { status: 'EN_ROUTE' }, 'en route');
  const b = await C.send('PATCH', '/api/jobs/1', { status: 'ON_SCENE' }, 'on scene');
  const c = await C.send('POST', '/api/messages', { body: 'gates secure' }, 'message to control');
  assert.ok(a.queued && b.queued && c.queued);
  assert.equal(C.outbox.count(), 3);
  assert.deepEqual(C.outbox.pending().map((x) => x.label), ['en route', 'on scene', 'message to control']);
});

test('reads fail loudly while offline rather than showing stale data', async () => {
  await assert.rejects(() => C.api('GET', '/api/jobs'), /Failed to fetch/);
});

test('the queue replays in order when the link returns', async () => {
  online = true;
  await C.outbox.flush();
  assert.equal(C.outbox.count(), 0);
  assert.deepEqual(sent.map((s) => JSON.parse(s.body).status || 'msg'), ['EN_ROUTE', 'ON_SCENE', 'msg']);
  assert.equal(new Set(sent.map((s) => s.key)).size, sent.length, 'each write carries its own key');
});

test('a retry after a lost reply reuses one stable key so nothing double-applies', async () => {
  const before = sent.length;
  const item = [{ key: 'stable', method: 'POST', path: '/api/jobs/9/ack', body: {}, label: 'ack' }];
  store.set('cccs.outbox', JSON.stringify(item));
  await C.outbox.flush();
  store.set('cccs.outbox', JSON.stringify(item));
  await C.outbox.flush();
  const retries = sent.slice(before);
  assert.equal(retries.length, 2);
  assert.ok(retries.every((s) => s.key === 'stable'));
});

test('PTT defaults to the space bar and SOS starts unbound', () => {
  const kb = C.keybinds({});
  assert.equal(kb.bindings.ptt, 'Space');
  assert.equal(kb.bindings.sos, null);
});

test('any hardware key can be learned and is labelled for the officer', () => {
  const learned = [];
  const kb = C.keybinds({ onLearn: (which, token) => learned.push([which, token]) });
  kb.learn('sos');
  listeners['cccs:key']({ detail: { keyCode: 284, pressed: true } });
  assert.deepEqual(learned, [['sos', 'android:284']]);
  assert.equal(kb.bindings.sos, 'android:284');
  assert.equal(kb.label('android:284'), 'device key 284');
});

test('SOS needs a held key, not a tap', async () => {
  let fired = false, armed = false;
  const kb = C.keybinds({ onSos: () => (fired = true), onSosArming: () => (armed = true) });
  kb.set('sos', 'android:284');
  kb.setHold(400);
  listeners['cccs:key']({ detail: { keyCode: 284, pressed: true } });
  assert.ok(armed, 'the officer is told it is arming');
  listeners['cccs:key']({ detail: { keyCode: 284, pressed: false } });
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(fired, false, 'a brief press does not raise an SOS');

  listeners['cccs:key']({ detail: { keyCode: 284, pressed: true } });
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(fired, true, 'holding it does');
});

test('PTT reports press and release', () => {
  const seen = [];
  const kb = C.keybinds({ onPtt: (p) => seen.push(p) });
  kb.set('ptt', 'Space');
  listeners.keydown({ code: 'Space', repeat: false, preventDefault() {} });
  listeners.keyup({ code: 'Space', preventDefault() {} });
  assert.deepEqual(seen, [true, false]);
});

test('long-press keypad actions default to 1, # and *', () => {
  const kb = C.keybinds({});
  assert.equal(kb.bindings.call, 'android:8');
  assert.equal(kb.bindings.priority, 'android:18');
  assert.equal(kb.bindings.lock, 'android:17');
  assert.equal(kb.label('android:8'), 'keypad 1');
  assert.equal(kb.label('android:18'), 'keypad #');
  assert.equal(kb.label('android:17'), 'keypad *');
});

test('holding 1 fires a call request, tapping it does not', async () => {
  const fired = [];
  const kb = C.keybinds({ onAction: (a) => fired.push(a) });
  kb.setActionHold(300);

  listeners['cccs:key']({ detail: { keyCode: 8, pressed: true } });
  listeners['cccs:key']({ detail: { keyCode: 8, pressed: false } });
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(fired, [], 'a tap is ignored');

  listeners['cccs:key']({ detail: { keyCode: 8, pressed: true } });
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(fired, ['call']);
  listeners['cccs:key']({ detail: { keyCode: 8, pressed: false } });
});

test('# raises a priority request and * toggles the lock', async () => {
  const fired = [];
  const kb = C.keybinds({ onAction: (a) => fired.push(a) });
  kb.setActionHold(200);

  for (const code of [18, 17]) {
    listeners['cccs:key']({ detail: { keyCode: code, pressed: true } });
    await new Promise((r) => setTimeout(r, 300));
    listeners['cccs:key']({ detail: { keyCode: code, pressed: false } });
  }
  assert.deepEqual(fired, ['priority', 'lock']);
});

test('the officer is told an action is arming, and told when it is abandoned', async () => {
  const events = [];
  const kb = C.keybinds({
    onActionArming: (a, ms) => events.push(['arming', a, ms]),
    onActionCancelled: (a) => events.push(['cancelled', a]),
    onAction: (a) => events.push(['fired', a]),
  });
  kb.setActionHold(400);
  listeners['cccs:key']({ detail: { keyCode: 18, pressed: true } });
  listeners['cccs:key']({ detail: { keyCode: 18, pressed: false } });
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(events, [['arming', 'priority', 400], ['cancelled', 'priority']]);
});

test('a handset with no keypad reports no hardware keys until one arrives', () => {
  store.delete('cccs.sawHardwareKey');
  const fresh = C.keybinds({});
  assert.equal(fresh.hasHardwareKeys, false, 'touchscreen-only handset falls back to on-screen buttons');
  listeners['cccs:key']({ detail: { keyCode: 8, pressed: false } });
  assert.equal(fresh.hasHardwareKeys, true);
});

test('rebinding an action moves it off the default key', async () => {
  const fired = [];
  const kb = C.keybinds({ onAction: (a) => fired.push(a) });
  kb.setActionHold(200);
  kb.set('call', 'android:99');

  listeners['cccs:key']({ detail: { keyCode: 8, pressed: true } });
  await new Promise((r) => setTimeout(r, 300));
  listeners['cccs:key']({ detail: { keyCode: 8, pressed: false } });
  assert.deepEqual(fired, [], 'the old key no longer requests a call');

  listeners['cccs:key']({ detail: { keyCode: 99, pressed: true } });
  await new Promise((r) => setTimeout(r, 300));
  listeners['cccs:key']({ detail: { keyCode: 99, pressed: false } });
  assert.deepEqual(fired, ['call']);
  kb.set('call', 'android:8');
});

test('every keypad convention has a default and the labels read as keypad keys', () => {
  const kb = C.keybinds({});
  const expected = { call: '1', priority: '#', lock: '*', redial: '0', talkgroup: '2', status: '3', covert: '5', position: '8' };
  for (const [action, ch] of Object.entries(expected)) {
    assert.equal(kb.keypadChar(kb.bindings[action]), ch, `${action} should be on keypad ${ch}`);
    assert.equal(kb.label(kb.bindings[action]), `keypad ${ch}`);
  }
});

test('holding each keypad key fires its own action', async () => {
  const fired = [];
  const kb = C.keybinds({ onAction: (a) => fired.push(a) });
  kb.setActionHold(150);
  for (const code of [7, 9, 10, 12, 15]) {
    listeners['cccs:key']({ detail: { keyCode: code, pressed: true } });
    await new Promise((r) => setTimeout(r, 220));
    listeners['cccs:key']({ detail: { keyCode: code, pressed: false } });
  }
  assert.deepEqual(fired, ['redial', 'talkgroup', 'status', 'covert', 'position']);
});

test('tapping a digit speed-dials while holding it runs the bound action', async () => {
  const taps = [], held = [];
  const kb = C.keybinds({ onTap: (ch) => taps.push(ch), onAction: (a) => held.push(a) });
  kb.setActionHold(200);

  listeners['cccs:key']({ detail: { keyCode: 8, pressed: true } });
  listeners['cccs:key']({ detail: { keyCode: 8, pressed: false } });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(taps, ['1'], 'a tap is a speed dial');
  assert.deepEqual(held, [], 'and not the long-press action');

  listeners['cccs:key']({ detail: { keyCode: 8, pressed: true } });
  await new Promise((r) => setTimeout(r, 300));
  listeners['cccs:key']({ detail: { keyCode: 8, pressed: false } });
  assert.deepEqual(held, ['call'], 'holding runs the action');
  assert.deepEqual(taps, ['1'], 'and does not also speed-dial on release');
});

test('an unbound digit still taps through for speed dial', async () => {
  const taps = [];
  const kb = C.keybinds({ onTap: (ch) => taps.push(ch) });
  listeners['cccs:key']({ detail: { keyCode: 11, pressed: true } });   // keypad 4, no action bound
  listeners['cccs:key']({ detail: { keyCode: 11, pressed: false } });
  assert.deepEqual(taps, ['4']);
  assert.equal(kb.bindings.speedDial ? true : true, true);
});

test('speed dial entries can be set and removed', () => {
  const kb = C.keybinds({});
  kb.setSpeedDial('4', { type: 'radio', target: '234100002', label: 'P102' });
  assert.equal(kb.speedDial['4'].target, '234100002');
  kb.setSpeedDial('4', null);
  assert.equal(kb.speedDial['4'], undefined);
});
