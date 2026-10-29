import './vendor/zipjs/zip.min.js';
import {BLOCK_SIZE, blockWriter, blockBatch, checkCancelled} from './storage-common.js';
import {openResourceStore} from './resource-store.js';
import {originalFile,describeGame,decodeConfig,configName,configValue,CONFIG} from './game-config.js';
const {ZipReader, BlobReader, configure} = globalThis.zip;
configure({useWebWorkers:false,chunkSize:BLOCK_SIZE});
export const ZIP_LIMITS = Object.freeze({entries:50000,bytes:10 * 1024 ** 3,
  archiveBytes:12 * 1024 ** 3,metadataBytes:16 * 1024 ** 2,pathBytes:240,depth:32});
const encoder = new TextEncoder();
export class ImportError extends Error {
  constructor(code,message) { super(message); this.name = 'ImportError'; this.code = code; }
}
const invalid = (code,message) => { throw new ImportError(code,message); };

class BoundedBlobReader extends BlobReader {
  async readUint8Array(offset,length) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
        || offset + length > this.size) invalid('invalid_zip','ZIP read is outside the file');
    // zip.js reads the central directory in one buffer. Bound that allocation;
    // entry payloads still use its ordinary chunked readable streams.
    if (length > ZIP_LIMITS.metadataBytes) invalid('limit','ZIP metadata exceeds the memory budget');
    return super.readUint8Array(offset,length);
  }
}
export function pathInZip(name) {
  if (typeof name !== 'string') invalid('invalid_path','Unsafe ZIP path');
  const path = name.replaceAll('\\','/').normalize('NFC');
  const parts = path.replace(/\/$/,'').split('/');
  if (path.length > 1024 || parts.length > 128 || path.includes('\ufffd')
      || parts.some(part => !part || part === '.' || part === '..' || /[\u0000-\u001f\u007f:]/.test(part))) {
    invalid('invalid_path','Unsafe ZIP path');
  }
  return path;
}
function skipGameFile(path) {
  const key = path.toLowerCase(), parts = key.split('/'), name = parts.at(-1);
  return parts.some(part => part.startsWith('.') || part === '__macosx' || part === 'savegame' || part.endsWith('.app'))
    || parts[0] === 'ce.dat' || ['thumbs.db','desktop.ini'].includes(name)
    || /\.(exe|dll|lnk|log|old|tmp|bak)$/i.test(name) || /^scr.*\.(bmp|png)$/i.test(name)
    || (!key.includes('/') && /^ce-(saves|game-composition|game-charset)\.txt$/.test(key))
    || /(^|\/)maps\/.*\.(sav|db)$/.test(key);
}
export function zipFiles(entries) {
  if (!Array.isArray(entries) || entries.length > ZIP_LIMITS.entries) invalid('limit','Too many ZIP entries');
  const seen = new Map(), parents = new Set(), files = [];
  let total = 0;
  for (const entry of entries) {
    const path = pathInZip(entry.filename), key = path.replace(/\/$/,'').toLowerCase();
    if (seen.has(key)) invalid('invalid_path','Duplicate ZIP path: ' + path);
    const type = (entry.externalFileAttributes >>> 16) & 0o170000;
    if (entry.encrypted || ![0,8].includes(entry.compressionMethod)
        || ![0,0o100000,0o040000].includes(type)) invalid('unsupported_zip','Only regular unencrypted ZIP Store/Deflate files are supported');
    if (!entry.directory && (parents.has(key) || path.endsWith('/'))) invalid('invalid_path','ZIP file/directory collision: ' + path);
    const parts = key.split('/');
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0,index).join('/');
      if (seen.get(parent) === 'file') invalid('invalid_path','ZIP file/directory collision: ' + path);
      parents.add(parent);
    }
    seen.set(key,entry.directory ? 'directory' : 'file');
    if (entry.directory) {
      if (entry.uncompressedSize) invalid('invalid_zip','ZIP directory has a payload');
      continue;
    }
    if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) invalid('invalid_zip','Invalid ZIP size');
    if (entry.compressedSize !== undefined && (!Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0)) invalid('invalid_zip','Invalid compressed ZIP size');
    total += entry.uncompressedSize;
    if (total > ZIP_LIMITS.bytes) invalid('limit','ZIP exceeds the 10 GiB unpacked limit');
    files.push({entry,path,key,size:entry.uncompressedSize});
  }
  return files;
}
// The source's folders (lower case, ending with "/"; "" for its top).
function folderKeys(files) {
  const folders = new Set(['']);
  for (const file of files) {
    const parts = file.key.split('/');
    for (let index = 1; index < parts.length; index++) folders.add(parts.slice(0,index).join('/') + '/');
  }
  return folders;
}
// [key]'s folder ("a/b/") in the case [file] has it.
const folderPath = (file,key) => file.path.split('/').slice(0,key.split('/').filter(Boolean).length).join('/') + (key ? '/' : '');
// [key] (lower case) is a file or a folder of the source: master.dat and
// critter.dat may be folders (CE opens both).
const present = (keys,folders,key) => keys.has(key) || folders.has(key + '/');
// The files at [key]: the file, or all in the folder, with their paths from it.
function filesAt(files,key) {
  const file = files.find(item => item.key === key);
  if (file) return [{file,rest:''}];
  return files.filter(item => item.key.startsWith(key + '/')).map(item => ({file:item,rest:item.path.slice(key.length + 1)}));
}
// [value], a config's relative path, from [folder] (lower case): null for a
// full path or one out of the source.
function resolveIn(folder,value) {
  const path = value.trim().replaceAll('\\','/');
  if (!path || path.includes(':') || path.startsWith('/')) return null;
  const parts = folder.split('/').filter(Boolean);
  for (const part of path.split('/')) {
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else if (part && part !== '.') parts.push(part.toLowerCase());
  }
  return parts.join('/');
}
// Same rule as Android: a unique complete game at the shallowest level.
function gameRoot(files,previous) {
  // Set membership avoids a quadratic scan on an adversarial directory.
  const keys = new Set(files.map(file => file.key)), folders = folderKeys(files);
  const roots = [...folders].filter(folder => present(keys,folders,folder + 'master.dat') && present(keys,folders,folder + 'critter.dat'))
    .map(key => ({path:folderPath(files.find(file => file.key.startsWith(key)),key),key,depth:key.split('/').filter(Boolean).length}));
  let modsOnly = false;
  if (!roots.length) {
    if (files.some(file => /(^|\/)(master|critter)\.dat(\/|$)/.test(file.key))) invalid('missing_game','Incomplete original DAT pair');
    const candidates = new Map();
    for (const file of files) {
      let root;
      if (/(^|\/)(fallout2\.cfg|ddraw\.ini|sfall\.dat)$/.test(file.key)) root = file.path.slice(0,file.path.lastIndexOf('/') + 1);
      else {
        const at = ('/' + file.key).indexOf('/mods/');
        if (at >= 0) root = file.path.slice(0,at);
      }
      if (root !== undefined) candidates.set(root.toLowerCase(),{path:root,key:root.toLowerCase(),depth:root.split('/').filter(Boolean).length});
    }
    if (candidates.size && !previous) invalid('base_required','Install the full game before importing mods');
    if (previous) { roots.push(...candidates.values()); modsOnly = true; }
  }
  const depth = Math.min(...roots.map(root => root.depth));
  const shallow = roots.filter(root => root.depth === depth);
  if (!shallow.length) invalid('missing_game','ZIP must contain master.dat and critter.dat together');
  if (shallow.length !== 1) invalid('ambiguous_root','Several complete game folders at the same level');
  return {root:shallow[0],modsOnly};
}
// Folders under [root] whose config (`configName` of their ddraw.ini) names
// master.dat and critter.dat outside them, both in the source (a mod in
// Fallout 2's subfolder: Fallout Et Tu, Fallout 1.5: Resurrection). Each
// gets those files and the music folders its config names outside (as
// Resurrection keeps its own in Fallout 2's sound\music), at the paths
// fixGameConfig gives them; the mod's own files win. As Android's
// GameImport.findLinked.
async function linkedGames(files,root,read) {
  const keys = new Set(files.map(file => file.key)), folders = folderKeys(files), linked = new Map();
  for (const folder of folders) {
    if (folder === root.key || !folder.startsWith(root.key)) continue;
    const ddraw = files.find(file => file.key === folder + 'ddraw.ini');
    const name = configName(ddraw ? await read(ddraw) : ''), config = files.find(file => file.key === folder + name.toLowerCase());
    if (!config) continue;
    const text = await read(config), outside = [], mapped = new Set();
    let dats = true;
    for (const [key,target] of [['master_dat','master.dat'],['critter_dat','critter.dat']]) {
      const value = configValue(text,'system',key), path = value ? resolveIn(folder,value) : null;
      if (!path || path.startsWith(folder) || !present(keys,folders,path)) { dats = false; break; }
      for (const {file,rest} of filesAt(files,path)) { outside.push({file,path:rest ? target + '/' + rest : target}); mapped.add(file.key); }
    }
    if (!dats) continue;
    const own = new Set(files.filter(file => file.key.startsWith(folder)).map(file => file.key.slice(folder.length)));
    for (const [key,target] of [['music_path1','sound/music/'],['music_path2','data/sound/music/']]) {
      const value = configValue(text,'sound',key), path = value ? resolveIn(folder,value) : null;
      if (!path || (path + '/').startsWith(folder)) continue;
      for (const {file,rest} of filesAt(files,path)) {
        if (rest && !mapped.has(file.key) && !own.has((target + rest).toLowerCase())) { outside.push({file,path:target + rest}); mapped.add(file.key); }
      }
    }
    linked.set(folder,{path:folderPath(config,folder),key:folder,depth:folder.split('/').filter(Boolean).length,outside});
  }
  return linked;
}
// [path] with its folders as [folders] (lower case -> as they are) has them;
// the ones it lacks are added as [path] has them. CE finds a file in any
// case, but of folders named the same in another case it sees one
// (compat_resolve_path): "DATA/" next to "data/" would hide files.
function inFolderCase(path,folders) {
  const parts = path.split('/'), name = parts.pop();
  let folder = '';
  for (const part of parts) {
    const key = (folder + part).toLowerCase();
    if (!folders.has(key)) folders.set(key,folder + part);
    folder = folders.get(key) + '/';
  }
  return folder + name;
}
// [options.chosen]: a mod of `linkedGames` ([options.linked]) the player
// chose, else Fallout 2's folder itself (its mods' folders left out).
// [options.previousConfig]: the installed game's config, kept with its
// originals when only mods come.
function archivePlan(entries,previous = null,{linked = new Map(),chosen = null,previousConfig = CONFIG} = {}) {
  const files = zipFiles(entries);
  const found = gameRoot(files,previous), mod = chosen !== null ? linked.get(chosen.toLowerCase()) : null;
  const root = mod || found.root, modsOnly = found.modsOnly, selected = [], selectedKeys = new Set();
  // Folders in one case: the kept originals' (mods only), else the first.
  const folders = new Map();
  if (modsOnly) for (const file of previous.files) if (originalFile(file.path)) inFolderCase(file.path,folders);
  const add = (file,name) => {
    const path = inFolderCase(name,folders);
    if (encoder.encode(path).length > ZIP_LIMITS.pathBytes || path.split('/').length > ZIP_LIMITS.depth) {
      invalid('limit','Game path exceeds the engine limit: ' + path);
    }
    if (!selectedKeys.has(path.toLowerCase())) { selectedKeys.add(path.toLowerCase()); selected.push({...file,path}); }
  };
  for (const file of files) {
    if (!file.key.startsWith(root.key)) continue;
    if (!mod && [...linked.keys()].some(folder => file.key.startsWith(folder))) continue;
    const path = file.path.split('/').slice(root.depth).join('/');
    if (skipGameFile(path)) continue;
    add(file,path);
  }
  for (const {file,path} of mod ? mod.outside : []) add(file,path);
  if (selected.some(file => ['master.dat','critter.dat'].includes(file.path.toLowerCase()) && !file.size)) {
    invalid('missing_game','Required game DAT is empty');
  }
  if (!selected.length) invalid('missing_game','No game files selected');
  const kept = modsOnly ? previous.files.filter(file => (originalFile(file.path) || file.path.toLowerCase() === previousConfig.toLowerCase()) && !selectedKeys.has(file.path.toLowerCase())) : [];
  return {files:selected,kept,modsOnly,root:root.path,ignored:files.length - selected.length,total:selected.reduce((sum,file) => sum + file.size,0)};
}
export const planArchive = entries => archivePlan(entries).files;
function decodeFilename(bytes,encoding,type) {
  if (type !== 'filename') return undefined;
  try { return new TextDecoder(encoding,{fatal:true}).decode(bytes); }
  catch { invalid('invalid_path','Invalid ZIP filename encoding'); }
}
function changes(previous,files) {
  const old = new Map((previous?.files || []).map(file => [file.path.toLowerCase(),file.size]));
  let added = 0, replaced = 0, sameSize = 0;
  for (const file of files) {
    const key = file.path.toLowerCase();
    if (!old.has(key)) added++; else if (old.get(key) === file.size) sameSize++; else replaced++;
    old.delete(key);
  }
  return {added,replaced,sameSize,removed:old.size};
}
const notify = (callback,value) => { try { callback(value); } catch (error) { console.warn('Import progress notice failed',error); } };

export async function openGameArchive(file,{signal} = {}) {
  if (!(file instanceof Blob) || !Number.isSafeInteger(file.size) || !file.size) invalid('invalid_zip','Choose a nonempty ZIP');
  if (file.size > ZIP_LIMITS.archiveBytes) invalid('limit','ZIP exceeds the archive size limit');
  checkCancelled(signal);
  const reader = new ZipReader(new BoundedBlobReader(file),{strictness:'strict',filenameValidation:'strict',
    checkCrc32:true,checkOverlappingEntry:true,normalizeFilename:pathInZip,
    filenameEncoding:'cp866',decodeText:decodeFilename,useWebWorkers:false});
  let closed = false;
  const dispose = async () => { if (!closed) { closed = true; await reader.close(); } };
  try {
    const entries = []; let metadata = 0;
    for await (const entry of reader.getEntriesGenerator({signal})) {
      checkCancelled(signal);
      if (entries.length >= ZIP_LIMITS.entries) invalid('limit','Too many ZIP entries');
      metadata += 46 + (entry.rawFilename?.length || 0) + (entry.rawExtraField?.length || 0) + (entry.rawComment?.length || 0);
      if (metadata > ZIP_LIMITS.metadataBytes) invalid('limit','ZIP metadata exceeds the memory budget');
      entries.push(entry);
    }
    return {entries,files:zipFiles(entries),dispose};
  } catch (error) { await dispose().catch(() => {}); throw error; }
}
export async function readZipFile(item,max,signal) {
  if (item.size > max) invalid('limit','ZIP file exceeds the memory budget: ' + item.path);
  const data = new Uint8Array(item.size);
  const writer = blockWriter({block:async (_run,_path,index,chunk) => data.set(chunk,index * BLOCK_SIZE)},'',item.path,item.size,signal);
  await item.entry.getData(writer.stream,{signal,checkCrc32:true,checkOverlappingEntry:true,strictness:'strict',checkLocalFilename:true});
  return data;
}
// The game in [archive] (`openGameArchive`) and the files to put in:
// {plan} (`archivePlan`), or {choices} (Fallout 2's root and its mods') for
// Fallout 2 with mods in its subfolders and no [choice]. [readText]: a
// file's text. [previous]: the installed game's manifest, for mods only.
export async function planGameArchive(archive,{previous = null,choice = null,previousConfig = CONFIG,readText}) {
  const found = gameRoot(archive.files,previous);
  const linked = found.modsOnly ? new Map() : await linkedGames(archive.files,found.root,readText);
  if (linked.size && choice === null) return {choices:[found.root.path,...[...linked.values()].map(mod => mod.path).sort()]};
  return {plan:archivePlan(archive.entries,previous,{linked,chosen:choice,previousConfig})};
}
// [choice]: with Fallout 2 and mods in its subfolders (`linkedGames`), the
// root the player chose of the summary's `choices`; without it such an
// archive gives only the choices.
export async function prepareGameZip(file,{signal,choice = null,storeFactory = openResourceStore,
  estimate = () => globalThis.navigator?.storage?.estimate?.()} = {}) {
  const started = performance.now(), archive = await openGameArchive(file,{signal});
  const dispose = archive.dispose;
  let used = false, disposed = false;
  try {
    const store = await storeFactory();
    let previous, space;
    try { previous = await store.active(); space = await estimate(); }
    finally { await store.close(); }
    checkCancelled(signal);
    const readText = async item => decodeConfig(await readZipFile(item,1024 ** 2,signal));
    const readPrevious = async item => {
      const source = await storeFactory();
      try { return decodeConfig(await source.read(previous,item,0,Math.min(item.size,1024 ** 2))); }
      finally { await source.close(); }
    };
    const previousDdraw = previous?.files.find(item => item.path.toLowerCase() === 'ddraw.ini');
    const previousConfig = configName(previousDdraw ? await readPrevious(previousDdraw) : '');
    const {choices,plan} = await planGameArchive(archive,{previous,choice,previousConfig,readText});
    if (choices) {
      return {summary:Object.freeze({token:crypto.randomUUID(),choices}),dispose,
        async install() { invalid('stale_plan','Choose which game to install first'); }};
    }
    const ddraw = plan.files.find(item => item.path.toLowerCase() === 'ddraw.ini');
    const name = plan.modsOnly && !ddraw ? previousConfig : configName(ddraw ? await readText(ddraw) : '');
    const config = plan.files.find(item => item.path.toLowerCase() === name.toLowerCase());
    let configText = config ? await readText(config) : '';
    if (!config && plan.modsOnly) {
      const oldConfig = previous.files.find(item => item.path.toLowerCase() === previousConfig.toLowerCase());
      if (oldConfig) configText = await readPrevious(oldConfig);
    }
    const composition = [...plan.kept,...plan.files.map(({path,size}) => ({path,size}))];
    const description = describeGame(composition,configText);
    const required = Math.ceil(plan.total * 1.1) + 16 * 1024 ** 2;
    const free = Number.isFinite(space?.quota) && Number.isFinite(space?.usage) ? Math.max(0,space.quota - space.usage) : null;
    if (free !== null && free < required) invalid('no_space','Not enough estimated free website storage for safe staging');
    const directoryMs = performance.now() - started, expectedRun = previous?.run || null;
    const summary = Object.freeze({token:crypto.randomUUID(),filename:String(file.name || 'game.zip').slice(0,200),
      root:plan.root,files:composition.length,bytes:composition.reduce((sum,file) => sum + file.size,0),zipBytes:file.size,ignored:plan.ignored,
      mode:plan.modsOnly ? 'mods' : 'full',description,keptFiles:plan.kept.length,archiveSaves:archive.files.filter(file => file.path.toLowerCase().startsWith(plan.root.toLowerCase()) && /(^|\/)savegame\/slot\d+\/save\.dat$/i.test(file.path)).length,
      replaces:expectedRun,changes:changes(previous,composition),space:{free,requiredUpper:required},directoryMs});
    return {summary,dispose:async () => { disposed = true; await dispose(); },
      async install({signal:installSignal = signal,progress = () => {}} = {}) {
        if (used || disposed) invalid('stale_plan','This ZIP plan has expired; choose the archive again');
        used = true;
        let target, run, batch, committed = false;
        const installationStarted = performance.now();
        try {
          checkCancelled(installSignal);
          target = await storeFactory();
          const current = await target.active();
          if ((current?.run || null) !== expectedRun) invalid('stale_plan','Installed game changed after ZIP inspection');
          const actual = await estimate();
          if (Number.isFinite(actual?.quota) && Number.isFinite(actual?.usage) && actual.quota - actual.usage < required) {
            invalid('no_space','Not enough estimated free website storage for safe staging');
          }
          run = await target.begin();
          if (plan.kept.length) await target.inherit(run,current,plan.kept,{signal:installSignal});
          batch = blockBatch(target,run,installSignal);
          let bytes = 0, blocks = 0, maxChunk = 0, lastProgress = 0, nextSample = 128 * 1024 ** 2;
          const samples = [], buckets = {small:{files:0,bytes:0,ms:0},large:{files:0,bytes:0,ms:0}};
          const extractStarted = performance.now();
          for (let index = 0; index < plan.files.length; index++) {
            checkCancelled(installSignal);
            const item = plan.files[index], fileStarted = performance.now();
            const writer = blockWriter(batch,run,item.path,item.size,installSignal,count => {
              const now = performance.now(), handled = bytes + count;
              if (handled >= nextSample) { samples.push({bytes:handled,ms:now - extractStarted}); nextSample += 128 * 1024 ** 2; }
              if (now - lastProgress > 150) {
                notify(progress,{phase:'extract',bytes:handled,total:plan.total,file:item.path,files:plan.files.length,index:index + 1,cancelAllowed:true});
                lastProgress = now;
              }
            });
            await item.entry.getData(writer.stream,{signal:installSignal,checkCrc32:true,checkOverlappingEntry:true,
              strictness:'strict',checkLocalFilename:true});
            const stats = writer.stats();
            bytes += stats.bytes; blocks += stats.blocks; maxChunk = Math.max(maxChunk,stats.maxChunk);
            const bucket = buckets[item.size < 64 * 1024 ? 'small' : 'large'];
            bucket.files++; bucket.bytes += item.size; bucket.ms += performance.now() - fileStarted;
          }
          await batch.flush(); checkCancelled(installSignal);
          const preparedMs = performance.now() - installationStarted, write = batch.stats();
          const measurements = {zipBytes:file.size,bytes:composition.reduce((sum,file) => sum + file.size,0),blocks:blocks + plan.kept.reduce((sum,file) => sum + Math.ceil(file.size / BLOCK_SIZE),0),maxChunk,blockSize:BLOCK_SIZE,
            game:description,mode:summary.mode,keptFiles:plan.kept.length,
            importMs:directoryMs + preparedMs,stage5:{directoryMs,extractMs:performance.now() - extractStarted,...write,buckets,samples}};
          // An explicit commit barrier ends cancellation. Never report a late
          // cancellation/observer/cleanup error as failure after activation.
          notify(progress,{phase:'commit',bytes,total:plan.total,cancelAllowed:false});
          const commitStarted = performance.now();
          const manifest = await target.activate(run,composition,measurements);
          committed = true;
          const activationMs = performance.now() - commitStarted;
          let cleanupPending = false;
          notify(progress,{phase:'cleanup',bytes,total:plan.total,cancelAllowed:false});
          try { await target.collect?.(); } catch { cleanupPending = true; }
          // These finalization timings are session-only, separate from the
          // sealed on-disk manifest and pre-activation extraction measurements.
          manifest.importResult = {activationMs,totalMs:directoryMs + performance.now() - installationStarted,cleanupPending};
          notify(progress,{phase:'complete',bytes,total:plan.total,cancelAllowed:false});
          return manifest;
        } catch (error) {
          batch?.discard();
          if (target && run && !committed) {
            notify(progress,{phase:'cleanup',cancelAllowed:false});
            try { await target.discard(run); await target.collect?.(); } catch { /* recover retries orphan cleanup. */ }
          }
          throw error;
        } finally {
          try { await dispose(); } catch (error) { console.warn('ZIP close failed',error); }
          try { await target?.close(); } catch (error) { console.warn('Resource store close failed',error); }
        }
      },
    };
  } catch (error) { try { await dispose(); } catch {} throw error; }
}
export async function importGameZip(file,options = {}) {
  const plan = await prepareGameZip(file,options);
  return plan.install(options);
}
export function importErrorInfo(error) {
  let code = error instanceof ImportError ? error.code : 'io';
  if (error?.name === 'AbortError') code = 'cancelled';
  else if (error?.name === 'StalePlanError') code = 'stale_plan';
  else if (error?.name === 'QuotaExceededError') code = 'no_space';
  else if (error?.name === 'StorageBusyError') code = 'busy';
  else if (Object.entries(globalThis.zip).some(([key,value]) => key.startsWith('ERR_') && typeof value === 'string'
      && String(error?.message).startsWith(value))) code = 'invalid_zip';
  return {code,message:String(error?.message || error)};
}
