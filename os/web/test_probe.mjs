import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {openProbeStore, BLOCK_SIZE, blockWriter} from './probe-store.js';
import {planArchive, importProbeZip, checkProbeReads} from './probe-import.js';
const {ZipWriter, Uint8ArrayWriter, Uint8ArrayReader} = globalThis.zip;
const dbName = () => 'check-' + crypto.randomUUID();
async function archive({badPath = null, data = new Uint8Array(BLOCK_SIZE * 3 + 17).fill(53), zip64 = false} = {}) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), {useWebWorkers:false,zip64});
  await writer.add(badPath || 'F2/master.dat',new Uint8ArrayReader(data),{level:0,zip64});
  await writer.add('F2/critter.dat',new Uint8ArrayReader(Uint8Array.of(8,6,7,5,3,0,9)),{level:6,zip64});
  await writer.add('F2/data/SAVEGAME/SLOT01/SAVE.DAT',new Uint8ArrayReader(Uint8Array.of(9)),{level:0});
  await writer.add('F2/ce.dat',new Uint8ArrayReader(Uint8Array.of(9)),{level:0});
  return {blob:new Blob([await writer.close()]),data};
}
const options = name => ({storeFactory:() => openProbeStore(name),estimate:async () => ({quota:10 * 1024 ** 3,usage:0})});

test('real ZIP64 + Store/Deflate streams into bounded blocks; reopen and cross-block read verify hashes', async () => {
  const name = dbName(), {blob,data} = await archive({zip64:true});
  const manifest = await importProbeZip(blob,options(name));
  assert.deepEqual(manifest.files.map(f=>f.path), ['master.dat','critter.dat']);
  assert.ok(manifest.measurements.maxChunk <= BLOCK_SIZE);
  const store = await openProbeStore(name), opened = await store.active();
  assert.equal(opened.run,manifest.run);
  await store.recover();
  assert.equal((await store.active()).run,manifest.run);
  const file = opened.files[0];
  assert.deepEqual(await store.read(opened,file,BLOCK_SIZE - 11,31),data.slice(BLOCK_SIZE - 11,BLOCK_SIZE + 20));
  assert.deepEqual(await store.read(opened,file,file.size - 17,17),data.slice(-17));
  await assert.rejects(store.read(opened,file,0,file.size + 1),/Invalid local read/);
  store.close();
  const read = await checkProbeReads(() => openProbeStore(name));
  assert.equal(read.verified,true); assert.equal(read.reads,24);
});

test('corrupt CRC never activates partial data and preserves previous completed files', async () => {
  const name=dbName(),{blob}=await archive();
  const first=await importProbeZip(blob,options(name));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // Locate the stored synthetic master payload; mutation leaves ZIP metadata intact.
  const start = bytes.findIndex((v,i) => v===53 && bytes[i+1]===53 && bytes[i+2]===53 && bytes[i+3]===53);
  assert.ok(start > 0); bytes[start + 7] ^= 1;
  await assert.rejects(importProbeZip(new Blob([bytes]),options(name)));
  const store=await openProbeStore(name);
  assert.equal((await store.active()).run,first.run);
  assert.equal((await store.read(first,first.files[0],0,1))[0],53);
  store.close();
});

test('cancel, quota and process interruption leave incomplete generations inactive', async () => {
  const {blob}=await archive();
  for (const failure of ['cancel','quota']) {
    const name=dbName(),controller=new AbortController();
    const opts={...options(name),signal:controller.signal};
    if (failure==='cancel') {
      opts.storeFactory=async () => {
        const store=await openProbeStore(name),put=store.block;
        store.block=async (...args) => { await put(...args); controller.abort(); };
        return store;
      };
    } else opts.storeFactory=async () => {
      const store=await openProbeStore(name);
      store.block=async () => { throw new DOMException('full','QuotaExceededError'); };
      return store;
    };
    await assert.rejects(importProbeZip(blob,opts));
    const store=await openProbeStore(name);
    assert.equal(await store.active(),undefined); store.close();
  }
  const name=dbName(),store=await openProbeStore(name),run=await store.begin();
  await store.block(run,'master.dat',0,Uint8Array.of(1)); store.close();
  const reopened=await openProbeStore(name); await reopened.recover();
  assert.equal(await reopened.active(),undefined);
  await assert.rejects(reopened.read({run},{path:'master.dat',size:1},0,1),/Missing or damaged/);
  reopened.close();
});

test('missing/corrupt block fails closed; empty and short writes are handled explicitly', async () => {
  const name=dbName(),store=await openProbeStore(name),run=await store.begin();
  const writer=blockWriter(store,run,'file',3);
  const sink=writer.stream.getWriter(); await sink.write(Uint8Array.of(1,2));
  await assert.rejects(sink.close(),/size mismatch/);
  const manifest=await store.activate(run,[{path:'file',size:3}],{});
  await assert.rejects(store.read(manifest,manifest.files[0],0,3),/Missing or damaged/);
  await store.block(run,'file',0,Uint8Array.of(1,2,3));
  const raw=await new Promise((resolve,reject)=>{const r=indexedDB.open(name);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  await new Promise((resolve,reject)=>{const tx=raw.transaction('blocks','readwrite');const s=tx.objectStore('blocks');const r=s.get([run,'file',0]);r.onsuccess=()=>{const b=r.result;b.data[0]^=1;s.put(b);};tx.oncomplete=resolve;tx.onabort=reject;});
  raw.close();
  await assert.rejects(store.read(manifest,manifest.files[0],0,3),/Missing or damaged/);
  await store.clear(); assert.equal(await store.active(),undefined); store.close();
});

test('archive plan rejects traversal, case aliases, ambiguous roots, encryption and unsupported methods', () => {
  const entry = filename => ({filename,uncompressedSize:1,compressionMethod:0,externalFileAttributes:0});
  const base=[entry('master.dat'),entry('critter.dat')];
  for (const extra of [entry('../escape'),entry('/absolute'),entry('C:\\escape'),entry('MASTER.DAT'),
    {...entry('secret'),encrypted:true},{...entry('bzip'),compressionMethod:12},
    {...entry('link'),externalFileAttributes:0o120777 << 16}]) {
    assert.throws(()=>planArchive([...base,extra]));
  }
  assert.throws(()=>planArchive([entry('one/master.dat'),entry('one/critter.dat'),
    entry('another/master.dat'),entry('another/critter.dat')]));
});

test('vendored ZIP fallback works without native compression streams or CDN assets', async () => {
  const {blob}=await archive();
  globalThis.zip.configure({useCompressionStream:false});
  try {
    const name=dbName();
    const manifest=await importProbeZip(blob,options(name));
    assert.equal(manifest.files.length,2);
    assert.equal((await checkProbeReads(() => openProbeStore(name))).verified,true);
  } finally { globalThis.zip.configure({useCompressionStream:true}); }
});
