import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {openResourceStore, localFiles, BLOCK_SIZE} from '../resource-store.js';
import {mountGame} from '../filesystem.js';
const create = createRequire(import.meta.url)(process.argv[2]);
const database = 'runtime-' + crypto.randomUUID();
const entries = [
  ['master.dat',new Uint8Array(BLOCK_SIZE * 3 + 17).map((_,i) => i % 251)],
  ['critter.dat',Uint8Array.of(1)],
  ['fallout2.cfg',new TextEncoder().encode('[system]\nmaster_patches=data\ncritter_patches=data\n')],
  ['data/config/game.cfg',new TextEncoder().encode('base settings')],
  ['data/maps/start.map',Uint8Array.of(8)],
  ['data/proto/items/test.pro',Uint8Array.of(9)],
];
const store = await openResourceStore({name:database}), run = await store.begin();
for (const [path,data] of entries) for (let offset = 0; offset < data.length; offset += BLOCK_SIZE) {
  await store.block(run,path,offset / BLOCK_SIZE,data.subarray(offset,offset + BLOCK_SIZE));
}
await store.activate(run,entries.map(([path,data]) => ({path,size:data.length})));
await store.close();
// Only engine-owned ce.dat is fetched. Game files below use the actual resource DB.
globalThis.fetch = async url => {
  assert.ok(String(url).endsWith('/ce.dat'));
  return {ok:true,arrayBuffer:async () => Uint8Array.of(1,2).buffer};
};
async function launch(mode) {
  const source = await localFiles({name:database});
  let finish;
  const exited = new Promise(resolve => { finish = resolve; });
  const module = await create({noInitialRun:true,onExit:finish});
  module.GameFS.cacheLimit = BLOCK_SIZE * 2;
  await mountGame(module,source);
  if (mode === 'bad') source.read = async () => { throw new Error('simulated missing block'); };
  module.callMain(mode ? [mode] : []);
  let timer;
  const status = await Promise.race([exited,new Promise((_,reject) => {
    timer = setTimeout(() => reject(Error('WASM filesystem did not finish')),5000);
  })]).finally(() => clearTimeout(timer));
  assert.equal(status,0);
  assert.ok(module.GameFS.stats().cacheBytes <= BLOCK_SIZE * 2);
  if (!mode) {
    assert.equal(module.FS.readFile('/game/data/maps/automap.db',{encoding:'utf8'}),'mXp');
    await module.webUserFiles.run(() => module.FS.mkdirTree('/game/data/SAVEGAME/SLOT01'));
    await module.webUserFiles.writeFile('/game/data/SAVEGAME/SLOT01/SAVE.DAT',new TextEncoder().encode('save'));
    module.FS.writeFile('/game/fallout2.cfg','[system]\nmaster_patches=data\n');
    // Exercise the same explicit whole-operation checkpoint used by the game.
    await module.webUserFiles.sync();
    for (const [path,data] of entries) {
      const file = source.entries.find(file => file.path === path);
      assert.deepEqual(await source.read(file,0,Math.min(data.length,16)),data.slice(0,16));
    }
  }
  if (mode === 'reopen') {
    assert.equal(module.FS.readFile('/game/fallout2.cfg',{encoding:'utf8'}),'[system]\nmaster_patches=data\ncritter_patches=data\n');
    assert.equal(module.FS.analyzePath('/game/data/maps/automap.db').exists,false);
  }
  await module.webUserFiles.close();
  await source.close();
}
await launch('');
await launch('reopen');
await launch('bad');
console.log('Actual WASM: bounded reads, EIO, case folding, writable overlay and lazy user restore passed');
