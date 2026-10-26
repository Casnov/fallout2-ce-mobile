// Historical format-2 acceptance transcript. Current executable acceptance is
// user-saves-v3.mjs; legacy data is seeded directly by migration tests.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mountGame} from '../filesystem.js';
import {USER_ROOT} from '../working-files.js';
import {userStorageReport} from '../user-report.js';
const create = createRequire(import.meta.url)(process.argv[2]);
const request = pending => new Promise((resolve,reject) => {
  pending.onsuccess = () => resolve(pending.result); pending.onerror = () => reject(pending.error);
});
const encoder = new TextEncoder();
const data = new Map([
  ['master.dat',Uint8Array.of(1)], ['critter.dat',Uint8Array.of(2)],
  ['fallout2.cfg',encoder.encode('[system]\nmaster_patches=data\n')],
  ['data/config/game.cfg',encoder.encode('original mod settings')],
]);
const source = {kind:'local',entries:[...data].map(([path,bytes]) => ({path,size:bytes.length})),
  read:async (file,offset,length) => data.get(file.path).slice(offset,offset + length)};
globalThis.fetch = async () => ({ok:true,arrayBuffer:async () => new ArrayBuffer(1)});
async function reset() { await request(indexedDB.deleteDatabase(USER_ROOT)); }
async function remote() {
  const db = await request(indexedDB.open(USER_ROOT,21));
  try {
    const tx = db.transaction('FILE_DATA'), store = tx.objectStore('FILE_DATA');
    const [keys,values] = await Promise.all([request(store.getAllKeys()),request(store.getAll())]);
    return new Map(keys.map((key,index) => [key,values[index]]));
  } finally { db.close(); }
}
const text = (snapshot,path) => new TextDecoder().decode(snapshot.get(USER_ROOT + '/' + path)?.contents);
function inject(kind) {
  const original = IDBObjectStore.prototype.put;
  let fired = false;
  IDBObjectStore.prototype.put = function(value,key) {
    if (!fired && this.name === 'FILE_DATA' && this.transaction.db.name === USER_ROOT
        && (kind === 'delete' || (kind === 'settings'
          ? String(key).endsWith('/settings/fallout2.cfg') : String(key).endsWith('/savegame/SLOT01/SAVE.DAT')))) {
      fired = true;
      if (kind === 'quota' || kind === 'delete' || kind === 'settings') throw new DOMException('simulated quota','QuotaExceededError');
      if (kind === 'constraint') return this.add(value,key); // Real asynchronous request error.
      const pending = original.call(this,value,key);
      pending.addEventListener('success',() => this.transaction.abort());
      return pending;
    }
    return original.call(this,value,key);
  };
  return () => { IDBObjectStore.prototype.put = original; assert.ok(fired,'failure point was exercised'); };
}
async function launch(mode, fault = null, before = null) {
  let finish, openedFiles;
  const exited = new Promise(resolve => { finish = resolve; });
  const module = await create({noInitialRun:true,onExit:finish,webOpenFiles:mode => { openedFiles = mode; },midWrite:async () => {
    const snapshot = await remote();
    assert.ok(text(snapshot,'savegame/SLOT01/SAVE.DAT').endsWith('A'));
    assert.equal([...snapshot.keys()].some(key => key.includes('/.ce-write-')),false);
  }});
  await mountGame(module,source);
  await before?.(module);
  const restore = fault ? inject(fault) : null;
  try {
    module.callMain([mode]);
    let timer;
    const status = await Promise.race([exited,new Promise((_,reject) => {
      timer = setTimeout(() => reject(Error('User save operation timed out')),10000);
    })]).finally(() => clearTimeout(timer));
    assert.equal(status,0,mode + ': native catalog/bridge check');
    if (mode === 'openfiles') assert.equal(openedFiles,'saves_export');
    return module;
  } finally { restore?.(); }
}

await reset();
assert.equal((await userStorageReport()).saveSlots,0);
await launch('seed');
let snapshot = await remote();
assert.equal(JSON.parse(text(snapshot,'format.json')).format,2);
assert.match(text(snapshot,'port/saves.txt'),/test-RPU/);
assert.match(text(snapshot,'settings/fallout2.cfg'),/brightness=1.25/);
assert.equal(snapshot.has('/game/master.dat'),false);
assert.deepEqual(await userStorageReport(),{format:2,saveSlots:1,settingsFiles:2,records:true});
await launch('verify');
await launch('quick');
snapshot = await remote();
assert.ok(snapshot.has(USER_ROOT + '/savegame/SLOT04/SAVE.DAT'));
assert.ok(snapshot.has(USER_ROOT + '/savegame/SLOT05/SAVE.DAT'));
await launch('overwrite');
assert.ok(text(await remote(),'savegame/SLOT01/SAVE.DAT').endsWith('D'));
console.log('Native SaveCatalog: manual/quick overwrite, records, settings and new VM restore passed');

for (const failure of ['quota','constraint','abort']) {
  await reset(); await launch('seed');
  await launch('failure',failure);
  snapshot = await remote();
  assert.ok(text(snapshot,'savegame/SLOT01/SAVE.DAT').endsWith('A'));
  assert.match(text(snapshot,'port/saves.txt'),/test-RPU/);
  assert.match(text(snapshot,'settings/ddraw.ini'),/value=retry/);
  await launch('verify');
}
console.log('Atomic IDB transaction: quota, async request error, interrupted write and later retry passed');

for (const failure of ['writer-failure','records-failure']) {
  await reset(); await launch('seed'); await launch(failure); await launch('verify');
}
await reset(); await launch('seed'); await launch('delete-failure','delete'); await launch('verify');
await launch('delete');
assert.equal((await remote()).has(USER_ROOT + '/savegame/SLOT01/SAVE.DAT'),false);
await reset(); await launch('seed'); await launch('move');
snapshot = await remote();
assert.equal(snapshot.has(USER_ROOT + '/savegame/SLOT01/SAVE.DAT'),false);
assert.ok(snapshot.has(USER_ROOT + '/savegame/SLOT02/SAVE.DAT'));
console.log('Native writer/record errors, failed deletion, successful deletion and slot move passed');

await reset(); await launch('seed'); await launch('quick');
await launch('range-failure','delete');
snapshot = await remote();
assert.ok(text(snapshot,'savegame/SLOT04/SAVE.DAT').endsWith('B'));
assert.ok(text(snapshot,'savegame/SLOT05/SAVE.DAT').endsWith('C'));
assert.match(text(snapshot,'settings/fallout2.cfg'),/brightness=1.25/);
await launch('range');
snapshot = await remote();
assert.ok(text(snapshot,'savegame/SLOT04/SAVE.DAT').endsWith('C'));
assert.equal(snapshot.has(USER_ROOT + '/savegame/SLOT05/SAVE.DAT'),false);
assert.match(text(snapshot,'settings/fallout2.cfg'),/auto_quick_save=1/);
console.log('Quick-range moves and configuration checkpoint commit/rollback together');

for (const duringTransaction of [false,true]) {
  await reset(); await launch('seed');
  const closing = await launch('verify');
  closing.FS.writeFile(USER_ROOT + '/savegame/SLOT01/SAVE.DAT','never acknowledged');
  const original = IDBObjectStore.prototype.put;
  let used = false;
  if (duringTransaction) IDBObjectStore.prototype.put = function(value,key) {
    const pending = original.call(this,value,key);
    if (!used && this.name === 'FILE_DATA' && String(key).endsWith('/savegame/SLOT01/SAVE.DAT')) {
      used = true; pending.addEventListener('success',() => closing.webUserFiles.close());
    }
    return pending;
  };
  try {
    const pending = closing.webUserFiles.commit();
    if (!duringTransaction) closing.webUserFiles.close();
    await assert.rejects(pending);
    await assert.rejects(closing.webUserFiles.commit(),/Reopen the game/);
  } finally { IDBObjectStore.prototype.put = original; }
  if (duringTransaction) assert.ok(used);
  assert.ok(text(await remote(),'savegame/SLOT01/SAVE.DAT').endsWith('A'));
  await launch('verify');
}
console.log('Page shutdown before/inside a transaction cannot leave a stale writer');

await reset(); await launch('seed');
const settingsModule = await launch('verify');
settingsModule.FS.writeFile('/game/fallout2.cfg','[system]\nmaster_patches=data\n[preferences]\nbrightness=1.5\n');
const restoreSettingsFault = inject('settings');
await assert.rejects(settingsModule.webUserFiles.commit(),error => error.name === 'QuotaExceededError');
restoreSettingsFault();
assert.match(settingsModule.FS.readFile('/game/fallout2.cfg',{encoding:'utf8'}),/brightness=1.25/);
settingsModule.FS.writeFile('/game/fallout2.cfg','[system]\nmaster_patches=data\n[preferences]\nbrightness=1.5\n');
settingsModule.onUserWriteSuccess = () => { throw new Error('simulated UI observer failure'); };
await settingsModule.webUserFiles.commit();
assert.match(text(await remote(),'settings/fallout2.cfg'),/brightness=1.5/);
settingsModule.FS.filesystems.IDBFS.quit();
const restoredSettings = await launch('noop');
assert.match(restoredSettings.FS.readFile('/game/fallout2.cfg',{encoding:'utf8'}),/brightness=1.5/);
console.log('Settings failure rollback, retry, observer isolation and durable report passed');

// Upgrade the application marker on an actual pre-existing IDBFS layout.
const legacyDb = await request(indexedDB.open(USER_ROOT,21));
await new Promise((resolve,reject) => {
  const tx = legacyDb.transaction('FILE_DATA','readwrite');
  const marker = tx.objectStore('FILE_DATA').get(USER_ROOT + '/format.json');
  marker.onsuccess = () => {
    const entry = marker.result;
    entry.contents = encoder.encode(JSON.stringify({format:1,minReader:1,minWriter:1}));
    tx.objectStore('FILE_DATA').put(entry,USER_ROOT + '/format.json');
  };
  tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
});
legacyDb.close();
await launch('seed');
assert.equal(JSON.parse(text(await remote(),'format.json')).format,2);
const futureDb = await request(indexedDB.open(USER_ROOT,21));
await new Promise(resolve => {
  const tx = futureDb.transaction('FILE_DATA','readwrite');
  tx.objectStore('FILE_DATA').put({timestamp:new Date(),mode:0o100644,
    contents:encoder.encode(JSON.stringify({format:9,minReader:9,minWriter:9}))},USER_ROOT + '/format.json');
  tx.oncomplete = resolve;
});
futureDb.close();
const unsupported = await create({noInitialRun:true});
await assert.rejects(mountGame(unsupported,source),/Unsupported user storage format/);
unsupported.FS.filesystems.IDBFS.quit();
assert.equal(JSON.parse(text(await remote(),'format.json')).format,9);
console.log('User format 1 -> 2 migration and future-format fail-closed passed');

await reset(); await launch('seed');
await launch('recovery',null,async module => {
  const FS = module.FS, root = USER_ROOT + '/savegame';
  FS.mkdir(root + '/.ce-write-0');
  FS.rename(root + '/SLOT01',root + '/.ce-write-0/previous');
  FS.mkdir(root + '/SLOT01'); FS.writeFile(root + '/SLOT01/SAVE.DAT','interrupted');
  // Seed an older in-progress IDBFS snapshot, then let the native catalog recover.
  await module.webUserFiles.sync();
});
await launch('verify');

const module = await launch('verify');
const FS = module.FS, path = USER_ROOT + '/port/same-time.txt';
FS.writeFile(path,'one'); FS.utime(path,123456,123456); await module.webUserFiles.commit();
FS.writeFile(path,'two'); FS.utime(path,123456,123456); await module.webUserFiles.commit();
assert.equal(text(await remote(),'port/same-time.txt'),'two');
assert.equal(source.entries[0].size,1);
console.log('Interrupted legacy catalog recovery and equal-timestamp persistence passed');


// The ZIP was exported by the real Android GameSaves after importing a web ZIP.
module.webUserFiles.close();
await reset();
const {readFile} = await import('node:fs/promises');
const {openResourceStore} = await import('../resource-store.js');
const {prepareSaveZip} = await import('./legacy-v2-save-exchange.js');
const name = 'exchange-runtime-' + crypto.randomUUID();
const storeFactory = () => openResourceStore({name});
const resources = await storeFactory(), run = await resources.begin();
for (const [path,bytes] of data) if (bytes.length) await resources.block(run,path,0,bytes);
await resources.activate(run,source.entries); await resources.close();
const exchange = await prepareSaveZip(new Blob([await readFile(new URL('./android-exchange.zip',import.meta.url))]),{storeFactory});
await exchange.install();
await launch('exchange');
console.log('Android export -> atomic web import -> actual native WASM catalog/identity/composition passed');

await reset();
const beforeMod = await launch('seed');
beforeMod.FS.writeFile('/game/data/config/game.cfg','player mod option');
await beforeMod.webUserFiles.commit(); beforeMod.webUserFiles.close();
data.set('data/config/game.cfg',encoder.encode('new RPU defaults'));
data.set('fallout2.cfg',encoder.encode('[system]\nlanguage=russian\nmaster_patches=data\n[preferences]\nbrightness=1\n'));
source.entries = [...data].map(([path,bytes]) => ({path,size:bytes.length}));
source.importMode = 'mods';
await launch('verify',null,async next => {
  assert.equal(next.FS.readFile('/game/data/config/game.cfg',{encoding:'utf8'}),'new RPU defaults');
  const config = next.FS.readFile('/game/fallout2.cfg',{encoding:'utf8'});
  assert.ok(config.includes('language=russian'));
  assert.ok(config.includes('brightness=1.25'));
});
console.log('Mod config replacement uses new defaults, preserves player settings and source provenance passed');

await launch('openfiles');
console.log('Native web file-manager request and clean runtime shutdown passed');
