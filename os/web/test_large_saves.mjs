import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {open as fileOpen,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {openUserStore,USER_DB_VERSION,USER_FORMAT} from './user-store.js';
import {BLOCK_SIZE} from './storage-common.js';
import {ZipOutput,crc32} from './zip-output.js';
import {combineCrc,zeroCrc,repeatCrc} from './fixtures/zip-crc.mjs';
const name = () => 'large-user-' + crypto.randomUUID();
const request = r => new Promise((resolve,reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const source = data => ({size:data.length,read:async (at,n) => data.subarray(at,at + n)});
async function raw(database,action) { const db = await request(indexedDB.open(database)); try { return await action(db); } finally { db.close(); } }
// The IDBFS layout of earlier test builds (format 2, schema 21).
async function oldLayout(database) {
  const r = indexedDB.open(database,21); r.onupgradeneeded = () => r.result.createObjectStore('FILE_DATA');
  const db = await request(r), tx = db.transaction('FILE_DATA','readwrite'), store = tx.objectStore('FILE_DATA');
  for (const [path,data] of [['format.json',JSON.stringify({format:2,minReader:2,minWriter:2})],['savegame/slot001/save.dat','old save'],['port/saves.txt','old records']]) {
    store.put({mode:0o100600,timestamp:new Date(12345),contents:new TextEncoder().encode(data)},database + '/' + path);
  }
  await new Promise((resolve,reject) => { tx.oncomplete = resolve; tx.onabort = reject; }); db.close();
}
test('CRC combination supports lengths beyond uint32 and matches incremental CRC',() => {
  const a = Uint8Array.from({length:1200},(_,i) => i % 251), b = a.subarray(0,731);
  assert.equal(combineCrc(crc32(a),crc32(b),b.length),crc32(b,crc32(a)));
  for (const n of [0,1,2,13,255,4097,1000000]) assert.equal(zeroCrc(n),crc32(new Uint8Array(n)));
  assert.equal(zeroCrc(2 ** 32),combineCrc(zeroCrc(2 ** 31),zeroCrc(2 ** 31),2 ** 31));
  const repeated = new Uint8Array(a.length * 7); for (let n = 0; n < 7; n++) repeated.set(a,n * a.length);
  assert.equal(repeatCrc(crc32(a),a.length,7),crc32(repeated));
});
test('user blocks publish atomically, COW truncation never resurrects data, reopen is lazy',async () => {
  const database = name(), s = await openUserStore({name:database});
  const original = Uint8Array.from({length:BLOCK_SIZE * 2 + 41},(_,i) => i % 251), j = await s.begin();
  const node = await s.putFile(j,'savegame/slot001/save.dat',source(original));
  assert.equal(await s.resolve('savegame/slot001'),undefined);
  await s.commit(j); const old = await s.node(node.id);
  const j2 = await s.begin(), content = await s.content(old.content,j2);
  await s.truncate(content,17); await s.seal(content,BLOCK_SIZE + 5);
  await s.stage(j2,{...old,content,size:BLOCK_SIZE + 5});
  assert.deepEqual(await s.read(old.content,0,25),original.subarray(0,25));
  await s.commit(j2); const changed = await s.node(node.id);
  const data = await s.read(changed.content,0,changed.size);
  assert.deepEqual(data.subarray(0,17),original.subarray(0,17)); assert.ok(data.subarray(17).every(n => n === 0));
  await s.close(); const reopened = await openUserStore({name:database});
  assert.deepEqual(await reopened.node(node.id),changed);
  await reopened.close();
});
test('failed activation leaves the entire previous namespace and records intact',async () => {
  const s = await openUserStore({name:name()}), job = await s.begin();
  const save = await s.putFile(job,'savegame/slot001/save.dat',source(Uint8Array.of(1,2,3)));
  await s.commit(job); const before = await s.state();
  const bad = await s.begin();
  await s.stage(bad,{...save,size:100,content:'missing'});
  await s.putFile(bad,'port/saves.txt',source(Uint8Array.of(99)));
  await assert.rejects(s.commit(bad),/Unverified/);
  assert.deepEqual(await s.state(),before); assert.equal((await s.node(save.id)).size,3);
  const port = await s.resolve('port'); assert.equal(await s.lookup(port.id,'saves.txt'),undefined);
  await s.discard(bad); await s.collect(); assert.deepEqual(await s.read(save.content,0,3),Uint8Array.of(1,2,3)); await s.close();
});
test('page shutdown aborts an active publication; the previous checkpoint also survives GC',async () => {
  const database = name(), s = await openUserStore({name:database}), first = await s.begin();
  await s.putFile(first,'port/test',source(Uint8Array.of(1))); await s.commit(first);
  const second = await s.begin(); await s.putFile(second,'port/test',source(Uint8Array.of(2))); await s.commit(second);
  await s.collect(); await s.restorePrevious();
  const parent = await s.resolve('port'), old = await s.lookup(parent.id,'test'); assert.deepEqual(await s.read(old.content,0,1),Uint8Array.of(1));
  const interrupted = await s.begin(); await s.putFile(interrupted,'port/test',source(Uint8Array.of(99)));
  const original = IDBObjectStore.prototype.put; let fired = false, closing;
  IDBObjectStore.prototype.put = function(value,key) {
    const r = original.call(this,value,key);
    if (!fired && this.name === 'state' && key === 'active') { fired = true; r.addEventListener('success',() => { closing = s.close(); }); }
    return r;
  };
  try { await assert.rejects(s.commit(interrupted)); await closing; assert.ok(fired); } finally { IDBObjectStore.prototype.put = original; }
  const reopened = await openUserStore({name:database}), port = await reopened.resolve('port'), node = await reopened.lookup(port.id,'test');
  assert.deepEqual(await reopened.read(node.content,0,1),Uint8Array.of(1)); await reopened.close();
});
test('earlier IDBFS user databases are refused without upgrading or changing their rows',async () => {
  const database = name(); await oldLayout(database);
  await assert.rejects(openUserStore({name:database}),/Unknown user database layout/);
  await raw(database,async db => { assert.equal(db.version,21); assert.equal(await request(db.transaction('FILE_DATA').objectStore('FILE_DATA').count()),3); });
});
test('future user formats fail closed',async () => {
  const database = name(); await (await openUserStore({name:database})).close();
  await raw(database,async db => {
    assert.equal(db.version,USER_DB_VERSION);
    const tx = db.transaction('state','readwrite'); tx.objectStore('state').put({format:4,minReader:4,minWriter:4},'format');
    await new Promise(resolve => { tx.oncomplete = resolve; });
  });
  await assert.rejects(openUserStore({name:database}),/Unsupported/);
});
test('paged tree supports 1000 slots, stable inode directory rename and abandoned staging GC',async () => {
  const s = await openUserStore({name:name()}), job = await s.begin();
  const header = new Uint8Array(4096); header.set(new TextEncoder().encode('FALLOUT SAVE FILE'));
  for (let i = 1; i <= 1000; i++) await s.putFile(job,'savegame/slot' + String(i).padStart(3,'0') + '/save.dat',source(header));
  await s.commit(job);
  const root = await s.resolve('savegame'); let slots = 0;
  for await (const slot of s.children(root.id)) { slots++; assert.equal((await s.lookup(slot.id,'save.dat')).size,4096); }
  assert.equal(slots,1000);
  const first = await s.lookup(root.id,'slot001'), next = await s.begin();
  await s.stage(next,{...first,name:'slot1001'}); await s.commit(next);
  assert.equal(await s.lookup(root.id,'slot001'),undefined); assert.equal((await s.lookup(root.id,'slot1001')).id,first.id);
  const discard = await s.begin(); await s.putFile(discard,'port/orphan',source(Uint8Array.of(254)));
  await s.discard(discard); await s.collect();
  assert.equal((await s.counts()).contents,1001); // One immutable content ID per file; identical chunks are shared.
  assert.equal((await s.counts()).chunks,2);
  await s.close();
});
async function diskSink(path,{sparse = false} = {}) {
  const file = await fileOpen(path,'w+'); let position = 0;
  return {get position() { return position; },async write(data) {
    if (!(sparse && data.length === BLOCK_SIZE && data === zeros)) await file.write(data,0,data.length,position);
    position += data.length;
  },async read(at,n) { const data = new Uint8Array(n); const {bytesRead} = await file.read(data,0,n,at); assert.equal(bytesRead,n); return data; },
  async close() { await file.truncate(position); await file.close(); }};
}
const zeros = new Uint8Array(BLOCK_SIZE);
test('real ZIP64 exceeds 4 GiB with a disk-spooled central directory and Python reads both sides of the boundary',async () => {
  const directory = await mkdtemp(join(tmpdir(),'fallout-zip64-'));
  try {
    const path = join(directory,'large.zip'), output = await diskSink(path,{sparse:true}), central = await diskSink(join(directory,'directory'));
    const writer = new ZipOutput(output,central), size = 2 ** 32 + BLOCK_SIZE;
    await writer.add('large.bin',{size,read:async () => zeros},{crc:zeroCrc(size)});
    const tail = Uint8Array.of(17,23,42); await writer.add('SAVEGAME/SLOT1000/save.dat',source(tail)); await writer.close();
    assert.ok(output.position > 2 ** 32);
    const result = execFileSync('python3',['-c',
      'import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1]) as z:\n a=z.getinfo("large.bin"); assert a.file_size>2**32; assert a.CRC==int(sys.argv[2]); f=z.open(a); f.seek(2**32-8); assert f.read(24)==bytes(24); assert z.read("SAVEGAME/SLOT1000/save.dat")==bytes([17,23,42]); print("ZIP64 OK")',path,String(zeroCrc(size))],{encoding:'utf8',timeout:60000});
    assert.match(result,/ZIP64 OK/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
test('70000 entries use ZIP64 counts, import with Python, and writer retains no per-entry collection',async () => {
  const directory = await mkdtemp(join(tmpdir(),'fallout-many-'));
  try {
    const path = join(directory,'many.zip'), output = await diskSink(path), central = await diskSink(join(directory,'directory'));
    const writer = new ZipOutput(output,central), data = Uint8Array.of(7), input = source(data), crc = crc32(data);
    for (let i = 0; i < 70000; i++) await writer.add('slot' + i + '/save.dat',input,{crc});
    await writer.close(); assert.equal(writer.count,70000); assert.ok(!Object.values(writer).some(v => v instanceof Map || Array.isArray(v)));
    assert.match(execFileSync('python3',['-c','import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1]) as z:\n assert len(z.infolist())==70000; assert z.read("slot69999/save.dat")==bytes([7]); print("counts OK")',path],{encoding:'utf8'}),/counts OK/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
