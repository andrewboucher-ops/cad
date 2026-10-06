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

/* Minimal fake IndexedDB — just enough of the API app.js's secure outbox
   actually calls (open/onupgradeneeded, one object store, getAll/put/delete
   as onsuccess/onerror requests) to exercise the real code, not a
   reimplementation of it. One database, persisted in a plain Map so it
   survives across the open() calls each operation makes. */
const idbStores = new Map(); // storeName -> Map(key -> value)
function idbRequest(fn) {
  const req = {};
  queueMicrotask(() => {
    try { req.result = fn(); if (req.onsuccess) req.onsuccess({ target: req }); }
    catch (e) { req.error = e; if (req.onerror) req.onerror({ target: req }); }
  });
  return req;
}
const fakeIndexedDB = {
  open() {
    const req = {};
    queueMicrotask(() => {
      const db = {
        objectStoreNames: { contains: (n) => idbStores.has(n) },
        createObjectStore(n, opts) { idbStores.set(n, { data: new Map(), keyPath: opts && opts.keyPath }); },
        transaction(storeName) {
          const store = idbStores.get(storeName);
          return { objectStore: () => ({
            getAll: () => idbRequest(() => [...store.data.values()]),
            put: (item) => idbRequest(() => { store.data.set(item[store.keyPath], item); }),
            delete: (key) => idbRequest(() => { store.data.delete(key); }),
          }) };
        },
      };
      req.result = db;
      if (!idbStores.size && req.onupgradeneeded) req.onupgradeneeded({ target: req });
      if (req.onsuccess) req.onsuccess({ target: req });
    });
    return req;
  },
};

const sandbox={ console,
  crypto:{randomUUID:()=>'id-'+Math.random().toString(36).slice(2)},
  localStorage:{getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},
  sessionStorage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}},
  indexedDB: fakeIndexedDB,
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

/* ---------------- secure outbox (reports, checkpoint scans) ----------------
   The property actually worth proving here is the identity one: a report or
   checkpoint scan filed offline must never be sent under a different person
   than the one who actually filed it, even once the device is back online —
   that is the entire reason this queue exists rather than reusing the plain
   one above. */
test('a secure write made offline is held, and does not send under a different officer now signed in', async () => {
  C.setSession({ token: 't', user: { id: 1, personnel_id: 101 } });
  online = false;
  const before = sent.length;
  const r = await C.sendSecure('POST', '/api/form-submissions', { values: { note: 'wet floor, reception' } }, 'incident report');
  assert.ok(r.queued);
  assert.equal(await C.secureOutbox.count(), 1);

  online = true;
  // A different officer signs in on this (shared, e.g. an MDT) device
  // before the report could be sent — setSession itself triggers a flush
  // attempt, which must do nothing for an item that is not theirs.
  C.setSession({ token: 't2', user: { id: 2, personnel_id: 202 } });
  await C.secureOutbox.flush();
  assert.equal(sent.length, before, 'nothing was sent — the signed-in officer does not own this item');
  assert.equal(await C.secureOutbox.count(), 1, 'the report is still queued, not lost');
  assert.equal(await C.secureOutbox.mine(), 0, 'not this officer\'s to send');
  assert.ok(await C.secureOutbox.othersWaiting(), 'but something belonging to someone else is waiting on this device');
});
test('the same report sends once the original officer is signed in again', async () => {
  const before = sent.length;
  C.setSession({ token: 't', user: { id: 1, personnel_id: 101 } }); // triggers a flush on its own
  await C.secureOutbox.flush();
  assert.equal(sent.length, before + 1);
  assert.equal(JSON.parse(sent[sent.length - 1].body).values.note, 'wet floor, reception');
  assert.equal(await C.secureOutbox.count(), 0);
  assert.equal(await C.secureOutbox.othersWaiting(), false);
});
test('a secure write made while online is sent immediately, not queued', async () => {
  online = true;
  const r = await C.sendSecure('POST', '/api/site-visits/4/checkpoint-scan', { waypoint_id: 'w1' }, 'checkpoint scan');
  assert.equal(r.queued, undefined);
  assert.equal(await C.secureOutbox.count(), 0);
});
