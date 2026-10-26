import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mountGame} from '../filesystem.js';
import {openUserStore,USER_DATABASE} from '../user-store.js';
import {userSettingText} from '../user-report.js';
import {slotName} from '../save-format.js';
const create = createRequire(import.meta.url)(process.argv[2]), encode = text => new TextEncoder().encode(text);
const data = new Map([['master.dat',Uint8Array.of(1)],['critter.dat',Uint8Array.of(2)],['fallout2.cfg',encode('[system]\nmaster_patches=data\n')],['data/config/game.cfg',encode('original mod settings')]]);
const source = {kind:'local',entries:[...data].map(([path,bytes]) => ({path,size:bytes.length})),read:async (file,at,n) => data.get(file.path).subarray(at,at + n)};
globalThis.fetch = async () => ({ok:true,arrayBuffer:async () => new ArrayBuffer(1)});
async function snapshot() {
  const s = await openUserStore(); const result = new Map();
  for await (const {path,node} of s.walk()) result.set(path,new TextDecoder().decode(await s.read(node.content,0,node.size)));
  await s.close(); return result;
}
async function launch(mode,{fault,before} = {}) {
  let finish; const exit = new Promise(resolve => { finish = resolve; });
  const m = await create({noInitialRun:true,onExit:finish,midWrite:async () => {
    assert.ok((await userSettingText('savegame/SLOT01/SAVE.DAT')).endsWith('A'),'uncommitted native write remains invisible');
  }});
  await mountGame(m,source); await before?.(m);
  let restore;
  if (fault) {
    const original = IDBObjectStore.prototype.put; let fired = false;
    IDBObjectStore.prototype.put = function(value,key) {
      if (!fired && this.name === 'nodes' && value.name?.toLowerCase() === 'save.dat') {
        fired = true;
        if (fault === 'quota') throw new DOMException('quota','QuotaExceededError');
        const pending = original.call(this,value,key); pending.onsuccess = () => this.transaction.abort(); return pending;
      }
      return original.call(this,value,key);
    };
    restore = () => { IDBObjectStore.prototype.put = original; assert.ok(fired); };
  }
  let timer;
  try {
    m.callMain([mode]);
    assert.equal(await Promise.race([exit,new Promise((_,reject) => { timer = setTimeout(() => reject(new Error('native operation timeout: ' + mode)),60000); })]),0,mode);
    if (mode.startsWith('mass')) {
      const stats = m.webUserFiles.status(); assert.ok(stats.cacheBytes <= 16 * 1024 ** 2); assert.ok(stats.cachedNodes <= 2048);
    }
    return m;
  } finally { clearTimeout(timer); restore?.(); await m.webUserFiles.close(); }
}
const deletion = indexedDB.deleteDatabase(USER_DATABASE); await new Promise((r,j) => { deletion.onsuccess = r; deletion.onerror = j; });
await launch('seed'); await launch('verify');
const legacyRows = await snapshot();
await new Promise((r,j) => { const d = indexedDB.deleteDatabase(USER_DATABASE); d.onsuccess = r; d.onerror = j; });
const legacyOpen = indexedDB.open(USER_DATABASE,21); legacyOpen.onupgradeneeded = () => legacyOpen.result.createObjectStore('FILE_DATA');
const legacyDb = await new Promise((r,j) => { legacyOpen.onsuccess = () => r(legacyOpen.result); legacyOpen.onerror = j; });
const legacyTx = legacyDb.transaction('FILE_DATA','readwrite');
for (const [path,text] of legacyRows) legacyTx.objectStore('FILE_DATA').put({mode:0o100600,timestamp:new Date(12345),
  contents:encode(path === 'format.json' ? JSON.stringify({format:2,minReader:2,minWriter:2}) : text)},USER_DATABASE + '/' + path);
await new Promise((r,j) => { legacyTx.oncomplete = r; legacyTx.onabort = j; }); legacyDb.close();
await launch('verify');
console.log('format3 actual legacy progress migration opens in native catalog without game reimport OK');
await launch('quick'); await launch('overwrite');
assert.ok((await snapshot()).get('savegame/SLOT01/SAVE.DAT')?.endsWith('D'));
console.log('format3 native manual/quick, overwrite, settings, reopen OK');
for (const kind of ['quota','abort']) {
  await launch('seed'); await launch('failure',{fault:kind}); await launch('verify');
  console.log('format3 native rollback on ' + kind + ' OK');
}
await launch('writer-failure'); await launch('records-failure'); await launch('move');
console.log('format3 native failed writer, records rollback, directory move OK');
await launch('seed');
await launch('recovery',{before:async m => {
  const root = USER_DATABASE + '/savegame', u = m.webUserFiles;
  await u.run(() => m.FS.mkdir(root + '/.ce-write-0'));
  await u.run(() => m.FS.rename(root + '/SLOT01',root + '/.ce-write-0/previous'));
  await u.run(() => m.FS.mkdir(root + '/SLOT01'));
  await u.writeFile(root + '/SLOT01/SAVE.DAT',encode('interrupted'));
  await u.commit();
}});
await launch('verify');
console.log('format3 native legacy journal recovery OK');
await launch('noop',{before:async m => {
  const path = USER_DATABASE + '/port/equal-time.txt';
  for (const value of ['one','two']) {
    await m.webUserFiles.writeFile(path,encode(value));
    await m.webUserFiles.run(() => m.FS.utime(path,123456,123456)); await m.webUserFiles.commit();
    assert.equal(+(await m.webUserFiles.run(() => m.FS.stat(path))).mtime,123456);
  }
}});
assert.equal((await snapshot()).get('port/equal-time.txt'),'two');
console.log('format3 exact file times and equal-timestamp modifications persist OK');
await launch('noop',{before:async m => {
  m.FS.writeFile('/game/data/config/game.cfg','player mod configuration'); await m.webUserFiles.commit();
}});
await launch('noop',{before:async m => { assert.equal(m.FS.readFile('/game/data/config/game.cfg',{encoding:'utf8'}),'player mod configuration'); }});
data.set('data/config/game.cfg',encode('updated mod defaults')); source.importMode = 'mods';
await launch('noop',{before:async m => {
  assert.equal(m.FS.readFile('/game/data/config/game.cfg',{encoding:'utf8'}),'updated mod defaults');
  assert.match(m.FS.readFile('/game/fallout2.cfg',{encoding:'utf8'}),/brightness=1.25/); await m.webUserFiles.commit();
}});
console.log('format3 mod configuration provenance and player preferences merge OK');
await launch('handoff',{before:async m => {
  let calls=0;
  m.webExchangeSaves=async mode=>{
    const u=m.webUserFiles;
    await u.commit();await u.suspend();
    assert.equal(u.status().suspended,true);
    await assert.rejects(u.run(()=>m.FS.stat(USER_DATABASE+'/savegame')),/unavailable/);
    const other=await openUserStore();
    try {
      if(mode==='saves_import') {
        const bytes=encode('Z'.repeat(1024));bytes.set(encode('FALLOUT SAVE FILE'));
        const staged=await other.begin();
        await other.putFile(staged,'savegame/SLOT01/SAVE.DAT',{size:bytes.length,read:async(at,n)=>bytes.subarray(at,at+n)});
        await other.commit(staged);
      } else assert.equal(mode,'saves_export');
    } finally {await other.close();}
    // An unavailable writer must leave the C++ stack suspended, then allow
    // retry without recreating the engine or reading cached old inodes.
    if(!calls++) {
      const holder=await openUserStore();
      try {await assert.rejects(u.resume(),/another window/);assert.equal(u.status().suspended,true);}
      finally {await holder.close();}
    }
    await u.resume();assert.equal(u.status().suspended,false);
  };
}});
assert.ok((await snapshot()).get('savegame/SLOT02/SAVE.DAT')?.endsWith('B'));
console.log('real WASM export/import handoff: same native stack, writer contention retry, fresh cached content, subsequent save OK');
await new Promise((r,j) => { const d = indexedDB.deleteDatabase(USER_DATABASE); d.onsuccess = r; d.onerror = j; });
const store = await openUserStore(), job = await store.begin(), parent = await store.resolve('savegame');
const first = new Uint8Array(256 * 1024); first.set(encode('FALLOUT SAVE FILE'));
const large = await store.putFile(job,'savegame/' + slotName(1) + '/SAVE.DAT',{
  size:64 * 1024 ** 2,read:async (at,n) => at === 0 ? first.subarray(0,n) : new Uint8Array(n),
});
for (let n = 2; n <= 1000; n++) {
  const folder = await store.resolve('savegame/' + slotName(n),{job,create:true});
  await store.stage(job,{...large,id:crypto.randomUUID(),parent:folder.id});
}
await store.commit(job); await store.close();
await launch('mass'); await launch('mass-write'); await launch('mass-check');
console.log('format3 actual WASM: 1000 slots / 62.5 GiB logical payload, bounded metadata+16MiB block cache, COW seek write and reopen OK');
