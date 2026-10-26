import 'fake-indexeddb/auto';
import {IDBObjectStore} from 'fake-indexeddb';
import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareGameZip,importGameZip,planArchive,importErrorInfo,ZIP_LIMITS} from './zip-import.js';
import {openResourceStore,BLOCK_SIZE} from './resource-store.js';
import {WRITE_BATCH_BYTES,WRITE_BATCH_BLOCKS} from './storage-common.js';
const {ZipWriter,Uint8ArrayWriter,Uint8ArrayReader} = globalThis.zip;
const bytes = value => new TextEncoder().encode(value);
const base = [['master.dat',bytes('synthetic master payload')],['critter.dat',bytes('synthetic critter payload')]];
const request = input => new Promise((resolve,reject) => { input.onsuccess = () => resolve(input.result); input.onerror = () => reject(input.error); });
const txDone = tx => new Promise((resolve,reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
async function raw(name,callback) {
  const db = await request(indexedDB.open(name));
  try { return await callback(db); } finally { db.close(); }
}
async function snapshot(name) {
  return raw(name,async db => {
    const tx = db.transaction(['state','generations','refs','chunks']);
    return Promise.all(['state','generations','refs','chunks'].map(name => request(tx.objectStore(name).getAll())));
  });
}
function fixture() {
  const name = 'zip-stage5-' + crypto.randomUUID();
  return {name,storeFactory:() => openResourceStore({name}),estimate:async () => ({})};
}
async function archive(files = base,options = {}) {
  const writer = new ZipWriter(new Uint8ArrayWriter(),{useWebWorkers:false,...options});
  for (const [name,data] of files) await writer.add(name,new Uint8ArrayReader(data),{level:0,...options});
  return new Blob([await writer.close()]);
}
// Test-only ZIP byte editing: production uses the pinned zip.js parser.
function headers(data,signature) {
  const view = new DataView(data.buffer,data.byteOffset,data.byteLength), positions = [];
  for (let i = 0; i + 4 <= data.length; i++) if (view.getUint32(i,true) === signature) positions.push(i);
  return {view,positions};
}
async function mutate(blob,callback) {
  const data = new Uint8Array(await blob.arrayBuffer()); callback(data); return new Blob([data]);
}
async function expectOld(opts,old) {
  const store = await opts.storeFactory();
  try {
    const active = await store.active(); assert.equal(active.run,old.run);
    assert.deepEqual(await store.read(active,active.files[0],0,base[0][1].length),base[0][1]);
  } finally { await store.close(); }
}

test('inspection/disposal changes no existing resource rows, replacement compares sizes without claiming content equality',async () => {
  const opts = fixture(), original = await importGameZip(await archive([...base,['old.txt',bytes('old')]]),opts);
  const before = await snapshot(opts.name);
  const plan = await prepareGameZip(await archive([...base,['new.txt',bytes('new')]]),opts);
  assert.equal(plan.summary.replaces,original.run);
  assert.deepEqual(plan.summary.changes,{added:1,replaced:0,sameSize:2,removed:1});
  assert.deepEqual(await snapshot(opts.name),before);
  await plan.dispose(); await assert.rejects(plan.install(),error => importErrorInfo(error).code === 'stale_plan');
  assert.deepEqual(await snapshot(opts.name),before);
});

test('atomic replacement, bounded batches across small files, deduplication and user data isolation',async () => {
  const opts = fixture(), original = await importGameZip(await archive([...base,['old.txt',bytes('old')]]),opts);
  const userName = opts.name + '-user', open = indexedDB.open(userName,1);
  open.onupgradeneeded = () => open.result.createObjectStore('FILE_DATA');
  const user = await request(open), tx = user.transaction('FILE_DATA','readwrite'), durable = txDone(tx);
  const saved = {contents:bytes('existing save and settings'),mode:33188};
  tx.objectStore('FILE_DATA').put(saved,'/savegame/SLOT01/SAVE.DAT'); await durable;
  const files = [...base,['large.dat',new Uint8Array(BLOCK_SIZE * 5 + 13).fill(73)],
    ...Array.from({length:130},(_,i) => ['data/text/' + i + '.msg',bytes('line ' + i)]),
    ['SAVEGAME/SLOT99/SAVE.DAT',bytes('archive save must not be installed')],['ce.dat',bytes('old engine patch')]];
  const nextZip = await archive(files), next = await importGameZip(nextZip,opts), stats = next.measurements.stage5;
  assert.notEqual(next.run,original.run);
  assert.equal(next.files.some(file => file.path === 'old.txt' || /savegame|ce\.dat/i.test(file.path)),false);
  assert.ok(stats.transactions < next.measurements.blocks / 10);
  assert.ok(stats.maxBufferedBytes <= WRITE_BATCH_BYTES); assert.ok(stats.maxBufferedBlocks <= WRITE_BATCH_BLOCKS);
  assert.ok(stats.reusedBytes >= base.reduce((n,[,data]) => n + data.length,0));
  assert.deepEqual(await request(user.transaction('FILE_DATA').objectStore('FILE_DATA').get('/savegame/SLOT01/SAVE.DAT')),saved);
  const identical = await importGameZip(nextZip,opts);
  assert.equal(identical.measurements.stage5.newBytes,0);
  assert.equal(identical.measurements.stage5.reusedBytes,identical.measurements.bytes);
  user.close();
});

test('same-length changed payload is installed, not silently reused based on file size',async () => {
  const opts = fixture(), zip = await archive(); await importGameZip(zip,opts);
  const changed = base[0][1].slice(); changed[0] ^= 1;
  const next = await importGameZip(await archive([['master.dat',changed],base[1]]),opts);
  const store = await opts.storeFactory();
  try { assert.deepEqual(await store.read(next,next.files[0],0,changed.length),changed); }
  finally { await store.close(); }
});

test('CRC, truncation, local filename mismatch, invalid UTF-8, declared size and overlapping offsets fail without replacement',async () => {
  const opts = fixture(), zip = await archive(), original = await importGameZip(zip,opts);
  const cases = [
    await mutate(zip,data => {
      const {view,positions:[at]} = headers(data,0x04034b50);
      data[at + 30 + view.getUint16(at + 26,true) + view.getUint16(at + 28,true)] ^= 1;
    }),
    zip.slice(0,zip.size - 25),
    await mutate(zip,data => { const {positions:[at]} = headers(data,0x04034b50); data[at + 30] ^= 1; }),
    await mutate(zip,data => {
      const {view,positions:[at]} = headers(data,0x02014b50);
      view.setUint16(at + 8,view.getUint16(at + 8,true) | 0x800,true); data[at + 46] = 0xff;
    }),
    await mutate(zip,data => { const {view,positions:[at]} = headers(data,0x02014b50); view.setUint32(at + 24,1,true); }),
    await mutate(zip,data => { const {view,positions:[a,b]} = headers(data,0x02014b50); view.setUint32(b + 42,view.getUint32(a + 42,true),true); }),
  ];
  for (const damaged of cases) {
    await assert.rejects(importGameZip(damaged,opts)); await expectOld(opts,original);
  }
});

test('real ZIP64/Deflate, UTF-8 and CP866 names use the same permanent import path',async () => {
  for (const cp866 of [false,true]) {
    const opts = fixture(), text = 'ТЕСТ', table = {'Т':0x92,'Е':0x85,'С':0x91};
    const options = cp866 ? {useUnicodeFileNames:false,encodeText:(input,type) => type === 'filename'
      ? Uint8Array.from(input,character => table[character] ?? character.charCodeAt(0)) : undefined} : {};
    const zip = await archive([...base,['data/' + text + '.msg',bytes('translation')]],{...options,zip64:true,level:6});
    const installed = await importGameZip(zip,opts);
    assert.ok(installed.files.some(file => file.path === 'data/ТЕСТ.msg'));
  }
});

test('unsafe paths, file/directory conflicts, aliases, unsupported types and limits fail preflight',() => {
  const entry = (filename,extra = {}) => ({filename,uncompressedSize:1,compressionMethod:0,externalFileAttributes:0,...extra});
  const basic = base.map(([path]) => entry(path));
  const cases = [
    ['../escape'],['/absolute'],['C:\\escape'],['a//b'],['a/./b'],['a/../b'],['x\u0000y'],['MASTER.DAT'],
    ['foo'],['foo/bar'],['data/e\u0301.msg','data/é.msg'],['data/' + 'я'.repeat(125)],
  ];
  for (const paths of cases) {
    const items = paths.map(path => entry(path));
    if (paths[0] === 'foo') items.push(entry('foo/bar'));
    if (paths[0] === 'foo/bar') items.push(entry('foo'));
    assert.throws(() => planArchive([...basic,...items]));
  }
  for (const item of [entry('bad',{encrypted:true}),entry('bad',{compressionMethod:12}),
    entry('bad',{externalFileAttributes:0o120777 << 16}),entry('bad',{externalFileAttributes:0o020666 << 16}),
    entry('bad',{uncompressedSize:ZIP_LIMITS.bytes + 1}),entry('bad',{uncompressedSize:NaN}),
    entry('directory/',{directory:true})]) assert.throws(() => planArchive([...basic,item]));
  assert.throws(() => planArchive([entry('master.dat',{uncompressedSize:0}),basic[1]]));
  assert.throws(() => planArchive(['a/master.dat','a/critter.dat','b/master.dat','b/critter.dat'].map(path => entry(path))));
  assert.equal(planArchive([...basic,entry('nested/master.dat'),entry('nested/critter.dat')]).length,4);
});

test('quota estimate rejects before staging; cancellation before start and after a real committed batch preserves old game',async () => {
  const opts = fixture(), zip = await archive(), original = await importGameZip(zip,opts), before = await snapshot(opts.name);
  await assert.rejects(prepareGameZip(zip,{...opts,estimate:async () => ({quota:100,usage:99})}),
    error => importErrorInfo(error).code === 'no_space');
  assert.deepEqual(await snapshot(opts.name),before);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(prepareGameZip(zip,{...opts,signal:aborted.signal}),error => error.name === 'AbortError');
  const controller = new AbortController(), larger = await archive([...base,['big.dat',new Uint8Array(BLOCK_SIZE * 6).fill(72)]]);
  let writes = 0;
  const storeFactory = async () => {
    const store = await opts.storeFactory(), write = store.writeBlocks;
    store.writeBlocks = async (...args) => { const result = await write(...args); writes++; controller.abort(); return result; };
    return store;
  };
  await assert.rejects(importGameZip(larger,{...opts,storeFactory,signal:controller.signal}),error => error.name === 'AbortError');
  assert.equal(writes,1); await expectOld(opts,original);
});

test('real batch transaction rolls back synchronous quota and asynchronous abort errors',async () => {
  for (const failure of ['quota','abort']) {
    const opts = fixture(), original = await importGameZip(await archive(),opts), put = IDBObjectStore.prototype.put;
    let injected = false, references = 0;
    IDBObjectStore.prototype.put = function(...args) {
      if (!injected && this.name === 'refs' && args[0].run !== original.run && ++references === 6) {
        injected = true;
        if (failure === 'quota') throw new DOMException('Synthetic quota exhaustion','QuotaExceededError');
        const output = put.apply(this,args); this.transaction.abort(); return output;
      }
      return put.apply(this,args);
    };
    try {
      await assert.rejects(importGameZip(await archive([...base,['new.dat',new Uint8Array(BLOCK_SIZE * 6).fill(91)]]),opts),
        error => failure !== 'quota' || error.name === 'QuotaExceededError');
    } finally { IDBObjectStore.prototype.put = put; }
    assert.equal(injected,true); await expectOld(opts,original);
  }
});

test('abandoned persisted staging is collected on reopen, prior installation remains readable',async () => {
  const opts = fixture(), original = await importGameZip(await archive(),opts), store = await opts.storeFactory();
  const abandoned = await store.begin(); await store.block(abandoned,'master.dat',0,bytes('partial copy'));
  await store.close(); await expectOld(opts,original);
  const rows = await snapshot(opts.name); assert.equal(rows[1].some(row => row.run === abandoned),false);
});

test('stale review and exclusive game lease reject before writing a replacement',async () => {
  const opts = fixture(), zip = await archive(), original = await importGameZip(zip,opts);
  const plan = await prepareGameZip(zip,opts);
  const other = await importGameZip(zip,opts);
  await assert.rejects(plan.install(),error => importErrorInfo(error).code === 'stale_plan');
  const next = await prepareGameZip(zip,opts), owner = await opts.storeFactory();
  try { await assert.rejects(next.install(),error => importErrorInfo(error).code === 'busy'); }
  finally { await owner.close(); }
  assert.notEqual(other.run,original.run); await expectOld(opts,other);
});

test('commit barrier ignores late cancellation; post-commit cleanup failure reports success and valid game',async () => {
  const opts = fixture(), controller = new AbortController();
  const storeFactory = async () => {
    const store = await opts.storeFactory(); store.collect = async () => { throw new Error('Synthetic housekeeping error'); }; return store;
  };
  const active = await importGameZip(await archive(),{...opts,storeFactory,signal:controller.signal,progress:value => {
    if (value.phase === 'commit') controller.abort();
  }});
  assert.equal(active.importResult.cleanupPending,true);
  await expectOld(opts,active);
});

test('synthetic bad-CRC fixture cannot activate and preserves the previous installation',async () => {
  const {readFile} = await import('node:fs/promises');
  const opts = fixture(), old = await importGameZip(await archive(),opts);
  const damaged = new Blob([await readFile(new URL('./fixtures/invalid-crc.zip',import.meta.url))]);
  const plan = await prepareGameZip(damaged,opts);
  assert.equal(plan.summary.files,2);
  await assert.rejects(plan.install(),error => importErrorInfo(error).code === 'invalid_zip');
  await expectOld(opts,old);
});

test('oversized central directory is rejected before allocating its buffer',async () => {
  const size = ZIP_LIMITS.metadataBytes + 1, data = new Uint8Array(size + 22), view = new DataView(data.buffer);
  view.setUint32(size,0x06054b50,true); view.setUint16(size + 8,2,true); view.setUint16(size + 10,2,true);
  view.setUint32(size + 12,size,true); view.setUint32(size + 16,0,true);
  await assert.rejects(prepareGameZip(new Blob([data]),fixture()),error => importErrorInfo(error).code === 'limit');
});

test('retryable collection failure does not block reading a validated active installation',async () => {
  const opts = fixture(), active = await importGameZip(await archive(),opts), store = await opts.storeFactory();
  await store.begin(); // Model a generation abandoned by a terminated worker.
  store.collect = async () => { throw new DOMException('Synthetic cleanup failure','QuotaExceededError'); };
  await store.recover(); assert.match(store.cleanupError,/cleanup failure/);
  assert.equal((await store.active()).run,active.run);
  assert.deepEqual(await store.read(active,active.files[0],0,base[0][1].length),base[0][1]);
  await store.close(); await expectOld(opts,active);
});
