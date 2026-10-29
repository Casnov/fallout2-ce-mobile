import 'fake-indexeddb/auto';
import {IDBObjectStore} from 'fake-indexeddb';
import test from 'node:test';
import assert from 'node:assert/strict';
import {openResourceStore} from './resource-store.js';
import {importGameZip,prepareGameZip,importErrorInfo} from './zip-import.js';
import {openUserStore} from './user-store.js';
import {fixGameConfig,mergePlayerSettings,configValue} from './game-config.js';
const enc = new TextEncoder();
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
// A bystander user library: resource imports never open it.
async function users(opts,rows = []) {
  const store = await openUserStore({name:opts.userName});
  try {
    const job = await store.begin();
    for (const [path,data] of rows) await store.putFile(job,path,{size:data.length,read:async (at,n) => data.subarray(at,at + n)});
    await store.commit(job);
  } finally { await store.close(); }
}
async function userRows(opts) {
  const store = await openUserStore({name:opts.userName}), files = [];
  try {
    for await (const {path,node} of store.walk()) files.push([path,node.content,await store.read(node.content,0,node.size)]);
    return files;
  } finally { await store.close(); }
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

test('a master.dat folder replaces a master.dat file and the other way',async () => {
  // Fallout 2 replaced by Fallout: Nevada 1.00 (master.dat a folder), then back.
  const opts = fixture();
  await importGameZip(await zip(base),opts);
  const nevada = await importGameZip(await zip([['Fallout_Nevada/master.dat/art/intrface/mainmenu.frm',enc.encode('art')],['Fallout_Nevada/critter.dat',enc.encode('critter')],['Fallout_Nevada/fallout2.cfg',enc.encode('[system]\nmaster_dat=master.dat\n')]]),opts);
  assert.equal(nevada.files.some(file => file.path === 'master.dat'),false);
  assert.ok(nevada.files.some(file => file.path === 'master.dat/art/intrface/mainmenu.frm'));
  const back = await importGameZip(await zip(base),opts);
  assert.ok(back.files.some(file => file.path === 'master.dat'));
  assert.equal(back.files.some(file => file.path.startsWith('master.dat/')),false);
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

test('the new game keeps its own screen settings: CE takes them from its f2_res.ini',() => {
  const merged = mergePlayerSettings('[system]\nmaster_dat=master.dat\n[ui]\nauto_quick_save=0\n',
    '[system]\nf2_res_dat=f2_res.dat\n[screen]\nresolution_x=1066\n[ui]\nauto_quick_save=1\niface_bar_side_art=2\ndisplay_bonus_damage=1\n');
  assert.equal(configValue(merged,'screen','resolution_x'),null);
  assert.equal(configValue(merged,'system','f2_res_dat'),null);
  assert.equal(configValue(merged,'ui','iface_bar_side_art'),null);
  assert.equal(configValue(merged,'ui','auto_quick_save'),'1');
  assert.equal(configValue(merged,'ui','display_bonus_damage'),'1');
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
