/* Client-side offline outbox, exercised against the real public/app.js under
   stubbed browser globals. Node cannot run a browser here, so this drives the
   same code the officer terminal and MDT run rather than a reimplementation. */
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
  location:{protocol:'http:',host:'x',pathname:'/officer.html'},
  document:{addEventListener:(t,f)=>{listeners[t]=f;},removeEventListener:()=>{},querySelector:()=>null,querySelectorAll:()=>[],createElement:()=>({style:{},remove(){}}),body:{appendChild(){}},createElementNS:()=>({setAttribute(){},appendChild(){},addEventListener(){},style:{}})},
  WebSocket:function(){this.close=()=>{}},
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
