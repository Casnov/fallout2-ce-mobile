import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import './zip-import.js';
import {openResourceStore} from './resource-store.js';

test('worker review/token/replace/cancel protocol preserves the committed installation on failure',async () => {
  const output = [], priorSelf = globalThis.self;
  globalThis.self = {postMessage:message => output.push(structuredClone(message))};
  try {
    await import('./probe-worker.js');
    const send = async data => { output.length = 0; await self.onmessage({data}); return output.at(-1); };
    const {ZipWriter,Uint8ArrayWriter,Uint8ArrayReader} = globalThis.zip;
    const writer = new ZipWriter(new Uint8ArrayWriter(),{useWebWorkers:false});
    for (const name of ['master.dat','critter.dat']) await writer.add(name,new Uint8ArrayReader(Uint8Array.of(12,34)),{level:0});
    const file = new Blob([await writer.close()]);
    const review = await send({type:'inspect',file});
    assert.equal(review.action,'inspect'); assert.equal(review.active,null); assert.ok(review.plan.token);
    const stale = await send({type:'install',token:'wrong'});
    assert.equal(stale.type,'error'); assert.equal(stale.code,'stale_plan'); assert.equal(stale.active,null);
    const recheck = await send({type:'inspect',file});
    const installed = await send({type:'install',token:recheck.plan.token});
    assert.equal(installed.type,'result'); assert.ok(installed.active.run); assert.equal(installed.plan,null);
    assert.ok(output.some(message => message.value?.phase === 'commit' && !message.value.cancelAllowed));
    const old = installed.active.run;
    output.length = 0;
    const inspecting = self.onmessage({data:{type:'inspect',file}});
    await self.onmessage({data:{type:'cancel'}}); await inspecting;
    assert.equal(output.at(-1).code,'cancelled'); assert.equal(output.at(-1).active.run,old);
    const damaged = new Blob([await readFile(new URL('./checks/invalid-crc.zip',import.meta.url))]);
    const badPlan = await send({type:'inspect',file:damaged});
    const failed = await send({type:'install',token:badPlan.plan.token});
    assert.equal(failed.type,'error'); assert.equal(failed.code,'invalid_zip'); assert.equal(failed.active.run,old);
    await send({type:'inspect',file});
    const discarded = await send({type:'discard'});
    assert.equal(discarded.plan,null); assert.equal(discarded.active.run,old);
    const read = await send({type:'read'}); assert.equal(read.read.verified,true); assert.equal(read.active.run,old);
    const holder = await openResourceStore();
    try {
      const busy = await send({type:'inspect',file}); assert.equal(busy.code,'busy');
    } finally { await holder.close(); }
    const store = await openResourceStore(); await store.clear(); await store.close();
  } finally { globalThis.self = priorSelf; }
});
