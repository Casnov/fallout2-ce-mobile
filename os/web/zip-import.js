import './vendor/zipjs/zip.min.js';
import {BLOCK_SIZE, blockWriter, blockBatch, checkCancelled} from './storage-common.js';
import {openResourceStore} from './resource-store.js';
import {originalFile,describeGame,decodeConfig} from './game-config.js';
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
function archivePlan(entries,previous = null) {
  const files = zipFiles(entries);
  // Same rule as Android: a unique complete game at the shallowest level.
  // Set membership avoids a quadratic scan on an adversarial directory.
  const keys = new Set(files.map(file => file.key));
  const roots = files.filter(file => file.key === 'master.dat' || file.key.endsWith('/master.dat'))
    .filter(file => keys.has(file.key.slice(0,-10) + 'critter.dat'))
    .map(file => ({path:file.path.slice(0,-10),key:file.key.slice(0,-10),depth:file.path.split('/').length - 1}));
  let modsOnly = false;
  if (!roots.length) {
    if (files.some(file => /(^|\/)(master|critter)\.dat$/.test(file.key))) invalid('missing_game','Incomplete original DAT pair');
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
  const root = shallow[0], selected = [];
  for (const file of files) {
    if (!file.key.startsWith(root.key)) continue;
    const path = file.path.split('/').slice(root.depth).join('/');
    if (skipGameFile(path)) continue;
    if (encoder.encode(path).length > ZIP_LIMITS.pathBytes || path.split('/').length > ZIP_LIMITS.depth) {
      invalid('limit','Game path exceeds the engine limit: ' + path);
    }
    selected.push({...file,path});
  }
  if (selected.some(file => ['master.dat','critter.dat'].includes(file.path.toLowerCase()) && !file.size)) {
    invalid('missing_game','Required game DAT is empty');
  }
  if (!selected.length) invalid('missing_game','No game files selected');
  const keysSelected = new Set(selected.map(file => file.path.toLowerCase()));
  const kept = modsOnly ? previous.files.filter(file => (originalFile(file.path) || file.path.toLowerCase() === 'fallout2.cfg') && !keysSelected.has(file.path.toLowerCase())) : [];
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
export async function prepareGameZip(file,{signal,storeFactory = openResourceStore,
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
    const plan = archivePlan(archive.entries,previous);
    const config = plan.files.find(file => file.path.toLowerCase() === 'fallout2.cfg');
    let configText = config ? decodeConfig(await readZipFile(config,1024 ** 2,signal)) : '';
    if (!config && plan.modsOnly) {
      const oldConfig = previous.files.find(file => file.path.toLowerCase() === 'fallout2.cfg');
      if (oldConfig) {
        const source = await storeFactory();
        try { configText = decodeConfig(await source.read(previous,oldConfig,0,Math.min(oldConfig.size,1024 ** 2))); }
        finally { await source.close(); }
      }
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
export const importProbeZip = importGameZip;
export function importErrorInfo(error) {
  let code = error instanceof ImportError ? error.code : 'io';
  if (error?.name === 'AbortError') code = 'cancelled';
  else if (error?.name === 'StalePlanError') code = 'stale_plan';
  else if (error?.name === 'QuotaExceededError') code = 'no_space';
  else if (String(error?.message).includes('Close the other') || String(error?.message).includes('Close older') || String(error?.message).includes('open in another window')) code = 'busy';
  else if (Object.entries(globalThis.zip).some(([key,value]) => key.startsWith('ERR_') && typeof value === 'string'
      && String(error?.message).startsWith(value))) code = 'invalid_zip';
  return {code,message:String(error?.message || error)};
}
export async function checkProbeReads(storeFactory = openResourceStore) {
  const started = performance.now(), store = await storeFactory();
  try {
    const manifest = await store.active();
    if (!manifest) throw new Error('No completed local installation');
    const openMs = performance.now() - started;
    const files = [...manifest.files].filter(file => file.size).sort((a,b) => b.size-a.size).slice(0,3);
    const times = [];
    let bytes = 0;
    for (let index = 0; index < 24; index++) {
      const file = files[index % files.length], count = Math.min(BLOCK_SIZE,file.size);
      const offset = Math.floor((file.size - count) * ((index * 7 % 23) / 22)), now = performance.now();
      await store.read(manifest,file,offset,count);
      times.push(performance.now() - now); bytes += count;
    }
    times.sort((a,b) => a-b);
    return {run:manifest.run,openMs,reads:times.length,bytes,medianMs:times[Math.floor(times.length / 2)],maxMs:times.at(-1),verified:true};
  } finally { await store.close(); }
}
