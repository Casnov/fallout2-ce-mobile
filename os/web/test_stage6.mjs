import 'fake-indexeddb/auto';
import {IDBObjectStore} from 'fake-indexeddb';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {openResourceStore} from './resource-store.js';
import {importGameZip,prepareGameZip,importErrorInfo} from './zip-import.js';
import {prepareSaveZip,exportSaveZip,saveIdentity,slotNumber,parseRecords,launcherFont,listSaveSlots} from './fixtures/legacy-v2-save-exchange.js';
import {USER_ROOT} from './working-files.js';
import {fixGameConfig,mergePlayerSettings,configValue} from './game-config.js';
const enc = new TextEncoder(), dec = new TextDecoder();
const request = r => new Promise((resolve,reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const done = tx => new Promise((resolve,reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
const base = [['master.dat',enc.encode('master')],['critter.dat',enc.encode('critter')],['patch000.dat',enc.encode('patch')],['sound/music/test.acm',enc.encode('music')],['fallout2.cfg',enc.encode('[system]\nlanguage=english\nmaster_dat=C:\\old\\master.dat\nmaster_patches=data\n[ui]\nauto_quick_save=1\nauto_quick_save_page=0\n')]];
const fixture = () => { const name = 'stage6-' + crypto.randomUUID(); return {name,userName:name + '-user',storeFactory:() => openResourceStore({name}),estimate:async () => ({})}; };
async function zip(files) {
  const writer = new globalThis.zip.ZipWriter(new globalThis.zip.Uint8ArrayWriter(),{useWebWorkers:false});
  for (const [path,data] of files) await writer.add(path,new globalThis.zip.Uint8ArrayReader(data),{level:0});
  return new Blob([await writer.close()]);
}
function save(tag = 'test') {
  const data = new Uint8Array(2000); data.set(enc.encode('FALLOUT SAVE FILE')); data.set(enc.encode(tag),61); return data;
}
async function users(opts,rows = []) {
  const opening = indexedDB.open(opts.userName,21);
  opening.onupgradeneeded = () => opening.result.createObjectStore('FILE_DATA').createIndex('timestamp','timestamp');
  const db = await request(opening), tx = db.transaction('FILE_DATA','readwrite'), complete = done(tx), store = tx.objectStore('FILE_DATA');
  for (const path of ['savegame','settings','port','exports']) store.put({mode:16877,timestamp:new Date(0)},USER_ROOT + '/' + path);
  for (const [path,data] of [['format.json',enc.encode('{"format":2,"minReader":2,"minWriter":2}')],...rows]) store.put({mode:33188,timestamp:new Date(0),contents:data},USER_ROOT + '/' + path);
  await complete; db.close();
}
async function userRows(opts) {
  const db = await request(indexedDB.open(opts.userName,21));
  try { const tx = db.transaction('FILE_DATA'), store = tx.objectStore('FILE_DATA'); return await Promise.all([request(store.getAllKeys()),request(store.getAll())]); }
  finally { db.close(); }
}

test('mods-only install inherits original DAT/music and replaces the whole mod set without accumulating stale files',async () => {
  const opts = fixture();
  const first = await importGameZip(await zip([...base,['mods/old.dat',enc.encode('old mod')],['data/scripts/stale.int',enc.encode('stale')]]),opts);
  const plan = await prepareGameZip(await zip([['RPU/mods/rpu.dat',enc.encode('rpu')],['RPU/ddraw.ini',enc.encode('[Misc]\n')]]),opts);
  assert.equal(plan.summary.mode,'mods'); assert.ok(plan.summary.keptFiles >= 5); assert.ok(plan.summary.description.mods.includes('rpu'));
  const next = await plan.install();
  assert.ok(next.files.some(file => file.path === 'master.dat'));
  assert.equal(next.files.some(file => /old\.dat|stale\.int/.test(file.path)),false);
  const store = await opts.storeFactory();
  try {
    assert.deepEqual(await store.read(next,next.files.find(f => f.path === 'master.dat'),0,6),enc.encode('master'));
    assert.deepEqual(await store.read(first,first.files.find(f => f.path === 'master.dat'),0,6),enc.encode('master'));
  } finally { await store.close(); }
  const third = await importGameZip(await zip([['mods/new.dat',enc.encode('updated')]]),opts);
  assert.equal(third.files.some(file => /rpu\.dat|ddraw\.ini/.test(file.path)),false);
});

test('mods require a base and incomplete DAT pairs are never treated as a mod overlay',async () => {
  const opts = fixture();
  await assert.rejects(prepareGameZip(await zip([['mods/rpu.dat',enc.encode('rpu')]]),opts),error => importErrorInfo(error).code === 'base_required');
  await importGameZip(await zip(base),opts);
  await assert.rejects(prepareGameZip(await zip([base[0],['ddraw.ini',enc.encode('')]]),opts));
});

test('failed mod extraction leaves the complete previous resource composition and user saves untouched',async () => {
  const opts = fixture(), old = await importGameZip(await zip([...base,['mods/old.dat',enc.encode('old')]]),opts);
  await users(opts,[['savegame/SLOT01/SAVE.DAT',save('existing')]]); const before = await userRows(opts);
  const valid = await zip([['mods/rpu.dat',new Uint8Array(100).fill(43)]]), bytes = new Uint8Array(await valid.arrayBuffer());
  const payload = bytes.findIndex((v,i) => v === 43 && bytes[i+1] === 43); bytes[payload] ^= 1;
  await assert.rejects(importGameZip(new Blob([bytes]),opts));
  const store = await opts.storeFactory(); assert.equal((await store.active()).run,old.run); await store.close();
  assert.deepEqual(await userRows(opts),before);
});

test('PC config paths are fixed and new game system/language win while player font/brightness survive',() => {
  const template = '[system]\nlanguage=russian\nmaster_dat=C:\\Fallout\\master.dat\nmaster_patches=../../escape\n[sound]\nmusic_path1=D:\\music\n[preferences]\nbrightness=1\n';
  const previous = '[system]\nlanguage=english\nmaster_patches=oldmod\n[preferences]\nbrightness=1.2\n[touch]\nfont=1\n';
  const merged = mergePlayerSettings(template,previous);
  assert.equal(configValue(merged,'system','language'),'russian');
  assert.equal(configValue(merged,'system','master_dat'),'master.dat');
  assert.equal(configValue(merged,'system','master_patches'),'data');
  assert.equal(configValue(merged,'preferences','brightness'),'1.2');
  assert.equal(configValue(merged,'touch','font'),'1');
  assert.equal(configValue(fixGameConfig(template),'sound','music_path1'),'sound/music/');
});

test('save export/import preserves payloads and native records, adds free manual slots, and skips duplicates',async () => {
  const opts = fixture(); await importGameZip(await zip(base),opts);
  const payload = save('roundtrip'), id = saveIdentity(payload);
  await users(opts,[['savegame/SLOT01/SAVE.DAT',payload],['savegame/SLOT01/automap.sav',enc.encode('map')],
    ['port/saves.txt',enc.encode(`SLOT01\t${id}\t123\t123000000\tmods/rpu.dat=0123:L\n`)],
    ['settings/fallout2.cfg',enc.encode('[ui]\nauto_quick_save=1\nauto_quick_save_page=0\n[touch]\nfont=1\n')]]);
  assert.equal(await launcherFont({name:opts.userName}),1);
  const exported = await exportSaveZip(opts); assert.equal(exported.slots,1);
  const destination = fixture(); await importGameZip(await zip(base),destination);
  await users(destination,[['savegame/SLOT11/SAVE.DAT',save('other')],['settings/fallout2.cfg',enc.encode('[ui]\nauto_quick_save=1\nauto_quick_save_page=0\n')]]);
  const before = await userRows(destination), prepared = await prepareSaveZip(exported.blob,destination);
  assert.equal(prepared.summary.added,1); assert.equal(prepared.summary.unknown,0); assert.deepEqual(prepared.summary.slots,[12]);
  assert.deepEqual(await userRows(destination),before);
  await assert.rejects(destination.storeFactory(),/other game/);
  await prepared.install();
  const [keys,rows] = await userRows(destination), row = rows[keys.indexOf(USER_ROOT + '/savegame/SLOT12/SAVE.DAT')];
  assert.deepEqual(row.contents,payload);
  const records = parseRecords(dec.decode(rows[keys.indexOf(USER_ROOT + '/port/saves.txt')].contents));
  assert.equal(records.get(12).composition,'mods/rpu.dat=0123:L'); assert.equal(records.get(12).created,'123');
  const again = await prepareSaveZip(exported.blob,destination); assert.equal(again.summary.added,0); assert.equal(again.summary.skipped,1); await again.install();
  // The checked-in synthetic export is also consumed by Android GameSaves.
  const golden = await prepareSaveZip(new Blob([await readFile(new URL('./fixtures/web-exchange.zip',import.meta.url))]),destination);
  assert.equal(golden.summary.skipped,1); await golden.dispose();
});

test('plain PC saves are imported as unknown, never falsely marked compatible with current RPU',async () => {
  const opts = fixture(); await importGameZip(await zip(base),opts); await users(opts);
  const plan = await prepareSaveZip(await zip([['data/SAVEGAME/SLOT01/SAVE.DAT',save('PC')]]),opts);
  assert.equal(plan.summary.unknown,1); await plan.install();
  const [keys,rows] = await userRows(opts), records = parseRecords(dec.decode(rows[keys.indexOf(USER_ROOT + '/port/saves.txt')].contents));
  assert.equal([...records.values()][0].composition,'');
});

test('bad CRC/header, cancellation and disposed save plans change no existing user data',async () => {
  const opts = fixture(); await importGameZip(await zip(base),opts); await users(opts,[['savegame/SLOT01/SAVE.DAT',save('old')]]);
  const before = await userRows(opts);
  const validZip = await zip([['SLOT01/SAVE.DAT',save('CRC CHECK')]]);
  const damaged = new Uint8Array(await validZip.arrayBuffer());
  const position = damaged.findIndex((byte,index) => byte === 67 && damaged[index + 1] === 82 && damaged[index + 2] === 67);
  assert.ok(position > 0); damaged[position] ^= 1;
  await assert.rejects(prepareSaveZip(new Blob([damaged]),opts));
  assert.deepEqual(await userRows(opts),before);
  const bad = await zip([['SAVEGAME/SLOT02/SAVE.DAT',enc.encode('invalid header')]]);
  await assert.rejects(prepareSaveZip(bad,opts)); assert.deepEqual(await userRows(opts),before);
  const controller = new AbortController();
  await assert.rejects(prepareSaveZip(await zip([['SLOT01/SAVE.DAT',save('new')]]),{...opts,signal:controller.signal,progress:() => controller.abort()}),error => error.name === 'AbortError');
  const plan = await prepareSaveZip(await zip([['SLOT01/SAVE.DAT',save('new')]]),opts);
  await plan.dispose(); await assert.rejects(plan.install()); assert.deepEqual(await userRows(opts),before);
});

test('quota/async transaction abort during save import preserves every old row and records',async () => {
  for (const mode of ['quota','abort']) {
    const opts = fixture(); await importGameZip(await zip(base),opts); await users(opts,[['savegame/SLOT01/SAVE.DAT',save('old')]]);
    const before = await userRows(opts), plan = await prepareSaveZip(await zip([['SLOT01/SAVE.DAT',save('new')],['SLOT01/automap.sav',enc.encode('map')]]),opts);
    const original = IDBObjectStore.prototype.put; let calls = 0;
    IDBObjectStore.prototype.put = function(...args) {
      if (this.name === 'FILE_DATA' && ++calls === 3) {
        if (mode === 'quota') throw new DOMException('Test full','QuotaExceededError');
        const output = original.apply(this,args); this.transaction.abort(); return output;
      }
      return original.apply(this,args);
    };
    try { await assert.rejects(plan.install()); } finally { IDBObjectStore.prototype.put = original; }
    assert.ok(calls >= 3); assert.deepEqual(await userRows(opts),before);
  }
});

test('save directory aliases, ambiguous roots, future user formats and unsafe slots are rejected',async () => {
  assert.equal(slotNumber('SLOT01'),1); assert.equal(slotNumber('slot1000'),1000);
  for (const name of ['slot1','slot001','slot1001','slot-1','SLOT00']) assert.equal(slotNumber(name),null);
  const opts = fixture(); await importGameZip(await zip(base),opts); await users(opts);
  await assert.rejects(prepareSaveZip(await zip([['a/SLOT01/SAVE.DAT',save()],['b/SLOT01/SAVE.DAT',save()]]),opts));
  await users(opts,[['format.json',enc.encode('{"format":9,"minReader":9,"minWriter":9}')]]);
  await assert.rejects(prepareSaveZip(await zip([['SLOT01/SAVE.DAT',save()]]),opts));
});


test('real Android export imports with native identity/order/composition unchanged',async () => {
  const opts = fixture(); await importGameZip(await zip(base),opts); await users(opts);
  const blob = new Blob([await readFile(new URL('./fixtures/android-exchange.zip',import.meta.url))]);
  const plan = await prepareSaveZip(blob,opts); assert.equal(plan.summary.added,1); await plan.install();
  const [keys,rows] = await userRows(opts);
  const records = parseRecords(dec.decode(rows[keys.indexOf(USER_ROOT + '/port/saves.txt')].contents));
  const record = [...records.values()][0];
  assert.equal(record.composition,'mods/rpu.dat=0123:L'); assert.equal(record.order,'123000000');
});


test('selected export and slot list preserve the user-selected scope',async () => {
  const opts = fixture(); await importGameZip(await zip(base),opts);
  await users(opts,[['savegame/SLOT01/SAVE.DAT',save('one')],['savegame/SLOT02/SAVE.DAT',save('two')]]);
  const slots = await listSaveSlots(opts); assert.equal(slots.length,2); assert.ok(slots[0].bytes > 0);
  const exported = await exportSaveZip({...opts,slots:[2]}); assert.equal(exported.slots,1);
  const other = fixture(); await importGameZip(await zip(base),other); await users(other);
  const plan = await prepareSaveZip(exported.blob,other); assert.equal(plan.summary.found,1); await plan.dispose();
});

test('embedded save import stays inside the selected game root',async () => {
  const opts = fixture(); await importGameZip(await zip(base),opts); await users(opts);
  const blob = await zip([['Selected/data/SAVEGAME/SLOT01/SAVE.DAT',save('selected')],['Other/SLOT01/SAVE.DAT',save('other')]]);
  const plan = await prepareSaveZip(blob,{...opts,rootHint:'Selected/'});
  assert.equal(plan.summary.found,1); assert.ok(plan.summary.root.startsWith('Selected/')); await plan.dispose();
});

test('inherited-reference transaction quota failure preserves the complete old installation',async () => {
  const opts = fixture(), old = await importGameZip(await zip(base),opts), add = IDBObjectStore.prototype.add;
  let fired = false;
  IDBObjectStore.prototype.add = function(...args) {
    if (!fired && this.name === 'refs' && args[0].run !== old.run) { fired = true; throw new DOMException('Test quota','QuotaExceededError'); }
    return add.apply(this,args);
  };
  try { await assert.rejects(importGameZip(await zip([['mods/rpu.dat',enc.encode('new')]]),opts),error => error.name === 'QuotaExceededError'); }
  finally { IDBObjectStore.prototype.add = add; }
  assert.ok(fired);
  const store = await opts.storeFactory(); assert.equal((await store.active()).run,old.run); await store.close();
});


test('PC saves without port metadata retain header chronology rather than import time',async () => {
  const opts = fixture(); await importGameZip(await zip(base),opts); await users(opts);
  const early = save('early'), late = save('late');
  for (const [data,year] of [[early,2024],[late,2025]]) {
    const header = new DataView(data.buffer); header.setUint16(91,1); header.setUint16(93,2); header.setUint16(95,year);
  }
  const plan = await prepareSaveZip(await zip([['SLOT01/SAVE.DAT',late],['SLOT02/SAVE.DAT',early]]),opts); await plan.install();
  const [keys,rows] = await userRows(opts), records = parseRecords(dec.decode(rows[keys.indexOf(USER_ROOT + '/port/saves.txt')].contents));
  const values = [...records.values()]; assert.ok(BigInt(values[0].order) > BigInt(values[1].order));
  assert.equal(values[0].created,'0'); assert.equal(values[0].composition,'');
});

test('unknown older user database layouts are rejected without upgrading or clearing their rows',async () => {
  const opts = fixture(); await importGameZip(await zip(base),opts);
  const opening = indexedDB.open(opts.userName,20);
  opening.onupgradeneeded = () => opening.result.createObjectStore('FILE_DATA');
  const old = await request(opening), tx = old.transaction('FILE_DATA','readwrite'), complete = done(tx);
  tx.objectStore('FILE_DATA').put({contents:enc.encode('keep unknown layout')},'legacy'); await complete; old.close();
  await assert.rejects(prepareSaveZip(await zip([['SLOT01/SAVE.DAT',save('new')]]),opts),error => importErrorInfo(error).code === 'invalid_save');
  const preserved = await request(indexedDB.open(opts.userName,20));
  assert.equal(preserved.version,20);
  assert.equal(dec.decode((await request(preserved.transaction('FILE_DATA').objectStore('FILE_DATA').get('legacy'))).contents),'keep unknown layout');
  preserved.close();
});
