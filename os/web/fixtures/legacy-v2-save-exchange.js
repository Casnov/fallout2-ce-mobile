// Historical format-2 interchange fixture. Only regression tests import this
// module; production uses save-streams.js and never ships its old RAM limits.
import {openResourceStore} from '../resource-store.js';
import {USER_ROOT} from '../working-files.js';
import {openGameArchive,readZipFile,ImportError,pathInZip} from '../zip-import.js';
import {checkCancelled} from '../storage-common.js';
import {configValue,decodeConfig} from '../game-config.js';
export const SAVE_LIMITS = Object.freeze({bytes:128 * 1024 ** 2,fileBytes:32 * 1024 ** 2,files:20000,slots:1000});
const encoder = new TextEncoder(), decoder = new TextDecoder();
const fail = (code,message) => { throw new ImportError(code,message); };
const request = input => new Promise((resolve,reject) => { input.onsuccess = () => resolve(input.result); input.onerror = () => reject(input.error); });
const done = tx => new Promise((resolve,reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error || new Error('Save transaction aborted')); tx.onerror = () => {}; });
export function slotNumber(name) {
  const match = /^slot(\d+)$/i.exec(name), number = Number(match?.[1]);
  return number >= 1 && number <= SAVE_LIMITS.slots && name.toLowerCase() === slotName(number).toLowerCase() ? number : null;
}
export const slotName = number => 'SLOT' + String(number).padStart(2,'0');
export function saveIdentity(data) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of data.subarray(0,4096)) hash = BigInt.asUintN(64,(hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(16).padStart(16,'0') + '-' + data.length;
}
export function parseRecords(text) {
  const records = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const [slot,id,created,order,composition = '',quick] = line.split('\t'), number = slotNumber(slot);
    if (!number || !/^[a-f0-9]{16}-\d+$/.test(id || '')) continue;
    const integer = value => /^\d{1,19}$/.test(value || '') && BigInt(value) <= 9223372036854775807n ? value : '0';
    records.set(number,{id,created:integer(created),order:integer(order),composition:composition === '*' ? '' : composition,quick:quick === 'quick'});
  }
  return records;
}
const recordText = records => '# Fallout 2 CE: saves and composition; compatible with src/save_records.h\n'
  + [...records].sort(([a],[b]) => a-b).map(([slot,r]) => `${slotName(slot)}\t${r.id}\t${r.created}\t${r.order}\t${r.composition}\t${r.quick ? 'quick' : ''}\n`).join('');
async function openUser(name = USER_ROOT,{create = false} = {}) {
  const opening = indexedDB.open(name,21); let absent = false, incompatible = false;
  opening.onupgradeneeded = event => {
    if (event.oldVersion !== 0) { incompatible = true; opening.transaction.abort(); return; }
    if (!create) { absent = true; opening.transaction.abort(); return; }
    opening.result.createObjectStore('FILE_DATA').createIndex('timestamp','timestamp',{unique:false});
  };
  let cancelled = false;
  const db = await new Promise((resolve,reject) => {
    opening.onsuccess = () => { if (cancelled) opening.result.close(); else resolve(opening.result); };
    opening.onerror = () => incompatible ? reject(new ImportError('invalid_save','Unsupported user filesystem version')) : absent ? resolve(null) : reject(opening.error);
    opening.onblocked = () => { cancelled = true; reject(new Error('Close the other game window')); };
  });
  if (db && !db.objectStoreNames.contains('FILE_DATA')) { db.close(); fail('invalid_save','Invalid user filesystem'); }
  return db;
}
async function inventory(db) {
  const rows = new Map(), slots = new Map(), texts = new Map(); let bytes = 0;
  if (!db) return {rows,slots,texts};
  const tx = db.transaction('FILE_DATA'), finished = done(tx), cursor = tx.objectStore('FILE_DATA').openCursor();
  let error;
  cursor.onsuccess = () => {
    try {
      const row = cursor.result;
      if (!row) return;
      const key = String(row.key), data = row.value.contents;
      if (!key.startsWith(USER_ROOT + '/')) fail('invalid_save','Unexpected user filesystem path');
      if (rows.has(key.toLowerCase())) fail('invalid_save','User path collision');
      rows.set(key.toLowerCase(),{key,size:data?.length || 0,mode:row.value.mode});
      if (data) {
        const slot = /^\/savegame\/([^/]+)\/save\.dat$/i.exec(key.slice(USER_ROOT.length));
        if (slot && slotNumber(slot[1])) slots.set(slotNumber(slot[1]),{id:saveIdentity(data),folder:key.slice(0,key.lastIndexOf('/')),header:data.slice(29,91)});
        if (/\/(format\.json|port\/saves\.txt|port\/game-(composition|charset)\.txt|settings\/(fallout2\.cfg|ddraw\.ini))$/i.test(key.slice(USER_ROOT.length))) {
          if (data.length > 1024 ** 2) fail('limit','Unexpectedly large user metadata');
          texts.set(key.slice(USER_ROOT.length).toLowerCase(),data);
        }
        if (/\/savegame\//i.test(key)) bytes += data.length;
      }
      row.continue();
    } catch (failure) { error = failure; tx.abort(); }
  };
  try { await finished; } catch (failure) { throw error || failure; }
  const marker = texts.get('/format.json');
  if (rows.size && !marker) fail('invalid_save','Missing user format marker');
  if (marker) {
    const format = JSON.parse(decoder.decode(marker));
    if (![1,2].includes(format.format) || format.minReader !== format.format || format.minWriter !== format.format) fail('invalid_save','Unsupported user storage format');
  }
  return {rows,slots,texts,bytes};
}
export async function launcherFont({name = USER_ROOT} = {}) {
  const db = await openUser(name);
  try {
    if (!db) return 0;
    const keys = await request(db.transaction('FILE_DATA').objectStore('FILE_DATA').getAllKeys());
    const key = keys.find(key => String(key).toLowerCase() === (USER_ROOT + '/settings/fallout2.cfg').toLowerCase());
    if (!key) return 0;
    const row = await request(db.transaction('FILE_DATA').objectStore('FILE_DATA').get(key));
    return configValue(row?.contents ? decodeConfig(row.contents) : '','touch','font') === '1' ? 1 : 0;
  } finally { db?.close(); }
}
function quickRange(config,ddraw = '') {
  const legacy = key => new RegExp('(?:^|\\n)\\s*' + key + '\\s*=\\s*([0-9]+)','i').exec(ddraw)?.[1];
  const number = (value,fallback) => /^\d+$/.test(value || '') ? Number(value) : fallback;
  const count = Math.max(0,Math.min(10,number(configValue(config,'ui','auto_quick_save') ?? legacy('AutoQuickSave'),0))) * 10;
  const first = Math.max(0,number(configValue(config,'ui','auto_quick_save_page') ?? legacy('AutoQuickSavePage'),1)) * 10 + 1;
  return [first,Math.min(1001,first + count)];
}
async function installedConfigs(owner,active,current) {
  const text = async name => {
    const saved = current.texts.get('/settings/' + name);
    if (saved) return decodeConfig(saved);
    const file = active?.files.find(file => file.path.toLowerCase() === name);
    if (!file) return '';
    if (file.size > 1024 ** 2) fail('limit','Unexpectedly large game configuration');
    return decodeConfig(await owner.read(active,file,0,file.size));
  };
  return Promise.all([text('fallout2.cfg'),text('ddraw.ini')]);
}
function saveFolders(files) {
  const roots = new Map();
  for (const file of files) {
    const match = /^(.*?)(slot\d+)\/save\.dat$/i.exec(file.path);
    if (!match || !slotNumber(match[2])) continue;
    roots.set(match[1].toLowerCase(),match[1]);
  }
  const depth = Math.min(...[...roots.values()].map(root => root.split('/').filter(Boolean).length));
  const shallow = [...roots.values()].filter(root => root.split('/').filter(Boolean).length === depth);
  if (!shallow.length) fail('no_saves','No SLOT folders with SAVE.DAT');
  if (shallow.length !== 1) fail('ambiguous_root','Several save folders at the same depth');
  const root = shallow[0], selected = new Map(); let bytes = 0, count = 0;
  for (const file of files) {
    if (!file.path.toLowerCase().startsWith(root.toLowerCase())) continue;
    const relative = file.path.slice(root.length), slash = relative.indexOf('/'), slot = slotNumber(relative.slice(0,slash));
    if (!slot || slash < 0 || relative.split('/').some(part => part.startsWith('.')) || /(^|\/)ce-meta\.txt$/i.test(relative)) continue;
    if (file.size > SAVE_LIMITS.fileBytes || ++count > SAVE_LIMITS.files || (bytes += file.size) > SAVE_LIMITS.bytes) fail('limit','Save import exceeds its memory budget');
    if (new TextEncoder().encode(relative).length > 240 || relative.split('/').length > 32) fail('limit','Save path exceeds engine limits');
    if (!selected.has(slot)) selected.set(slot,[]);
    selected.get(slot).push({...file,relative:relative.slice(slash + 1)});
  }
  for (const [slot,items] of selected) if (!items.some(file => file.relative.toLowerCase() === 'save.dat')) selected.delete(slot);
  return {root,selected,bytes};
}
export async function prepareSaveZip(file,{signal,storeFactory = openResourceStore,userName = USER_ROOT,progress = () => {},rootHint} = {}) {
  const archive = await openGameArchive(file,{signal}); let owner, db, disposed = false, used = false;
  const dispose = async () => {
    if (disposed) return; disposed = true;
    db?.close(); await owner?.close(); await archive.dispose();
  };
  try {
    owner = await storeFactory();
    const active = await owner.active();
    if (!active) fail('base_required','Install game files before importing saves');
    db = await openUser(userName); const current = await inventory(db);
    const prefix = rootHint === undefined || rootHint === '' ? '' : pathInZip(rootHint).replace(/\/?$/,'/');
    const found = saveFolders(archive.files.filter(file => file.path.toLowerCase().startsWith(prefix.toLowerCase()))), records = parseRecords(decoder.decode(current.texts.get('/port/saves.txt')));
    const parent = found.root.replace(/[^/]+\/$/,''), info = archive.files.find(item => [found.root + 'fallout2-saves.txt',parent + 'fallout2-saves.txt'].some(path => item.path.toLowerCase() === path.toLowerCase()));
    const sourceRecords = info ? parseRecords(decoder.decode(await readZipFile(info,1024 ** 2,signal))) : new Map();
    const ids = new Set([...current.slots.values()].map(slot => slot.id)), occupied = new Set(current.slots.keys());
    for (const path of current.rows.keys()) {
      const match = /^\/savegame\/(slot\d+)(\/|$)/i.exec(path.slice(USER_ROOT.length));
      if (match && slotNumber(match[1])) occupied.add(slotNumber(match[1]));
    }
    const [firstQuick,endQuick] = quickRange(...await installedConfigs(owner,active,current));
    const free = Array.from({length:1000},(_,i) => i + 1).filter(slot => !occupied.has(slot) && !(slot >= firstQuick && slot < endQuick));
    const imported = [], changes = [], unordered = []; let skipped = 0, read = 0, unknown = 0;
    for (const [slot,items] of found.selected) {
      checkCancelled(signal);
      const payloads = [];
      for (const item of items) {
        const contents = await readZipFile(item,SAVE_LIMITS.fileBytes,signal); payloads.push({relative:item.relative,contents});
        read += item.size;
        progress({phase:'extract',bytes:read,total:found.bytes,file:item.path,cancelAllowed:true});
      }
      const save = payloads.find(item => item.relative.toLowerCase() === 'save.dat').contents;
      if (save.length < 131 || decoder.decode(save.subarray(0,17)) !== 'FALLOUT SAVE FILE') fail('invalid_save','Invalid SAVE.DAT header');
      const id = saveIdentity(save);
      if (ids.has(id)) { skipped++; continue; }
      ids.add(id);
      const target = free.shift(); if (!target) fail('slot_limit','No free manual save slots');
      const known = sourceRecords.get(slot), record = known?.id === id ? {...known,quick:false} : {id,created:'0',order:'0',composition:'',quick:false};
      if (record.order === '0') {
        const header = new DataView(save.buffer,save.byteOffset,save.byteLength);
        const day = header.getUint16(91), month = header.getUint16(93), year = header.getUint16(95);
        const seconds = year >= 1990 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= 31
          ? Math.floor(new Date(year,month - 1,day,12).getTime() / 1000) : 0;
        unordered.push({record,seconds,time:header.getUint32(107)});
      }
      if (!record.composition) unknown++;
      records.set(target,record); imported.push(target);
      for (const item of payloads) changes.push({path:'savegame/' + slotName(target) + '/' + item.relative,contents:item.contents});
    }
    unordered.sort((a,b) => a.seconds-b.seconds || a.time-b.time);
    unordered.forEach(({record,seconds},index) => { record.order = String(BigInt(Math.max(seconds,1)) * 1000000n + BigInt(index)); });
    checkCancelled(signal);
    const summary = {token:crypto.randomUUID(),kind:'saves',filename:String(file.name || 'saves.zip'),root:found.root,
      found:found.selected.size,added:imported.length,skipped,unknown,bytes:found.bytes,slots:imported};
    return {summary,active,dispose,async install({signal:writeSignal = signal,progress:notice = () => {}} = {}) {
      if (used || disposed) fail('stale_plan','Choose the save ZIP again'); used = true;
      try {
        checkCancelled(writeSignal);
        if (!imported.length) return {added:0,skipped};
        if (!db) db = await openUser(userName,{create:true});
        checkCancelled(writeSignal);
        // All CRC/header checks finished. One user transaction is the commit barrier.
        try { notice({phase:'commit',cancelAllowed:false}); } catch {}
        const tx = db.transaction('FILE_DATA','readwrite',{durability:'strict'}), finished = done(tx), store = tx.objectStore('FILE_DATA');
        let failure;
        try {
          const now = new Date(), dirs = new Set(['savegame','settings','exports','port']);
          for (const {path} of changes) {
            const parts = path.split('/');
            for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0,i).join('/'));
          }
          const put = (path,row) => { const pending = store.put(row,USER_ROOT + '/' + path); pending.onerror = () => { failure ||= pending.error; try { tx.abort(); } catch {} }; };
          for (const path of dirs) if (!current.rows.has((USER_ROOT + '/' + path).toLowerCase())) put(path,{timestamp:now,mode:16877});
          put('format.json',{timestamp:now,mode:33188,contents:encoder.encode(JSON.stringify({format:2,minReader:2,minWriter:2}))});
          for (const {path,contents} of changes) put(path,{timestamp:now,mode:33188,contents});
          // On disk the engine consumes five fields; quick comes from slot position.
          const text = recordText(records).split('\n').map(line => line.startsWith('#') ? line : line.split('\t').slice(0,5).join('\t')).join('\n');
          put('port/saves.txt',{timestamp:now,mode:33188,contents:encoder.encode(text)});
        } catch (error) { failure = error; try { tx.abort(); } catch {} }
        try { await finished; } catch (error) { throw failure || error; }
        return {added:imported.length,skipped};
      } finally { await dispose().catch(error => console.warn('Save import close failed',error)); }
    }};
  } catch (error) { await dispose().catch(() => {}); throw error; }
}
export async function listSaveSlots({storeFactory = openResourceStore,userName = USER_ROOT} = {}) {
  const owner = await storeFactory(); let db;
  try {
    db = await openUser(userName); const current = await inventory(db);
    const [config] = await installedConfigs(owner,await owner.active(),current);
    const language = configValue(config,'system','language') || 'english';
    const charset = decoder.decode(current.texts.get('/port/game-charset.txt')).trim() || (language === 'russian' ? 'windows-1251' : 'windows-1252');
    let text; try { text = new TextDecoder(charset); } catch { text = decoder; }
    return [...current.slots].sort(([a],[b]) => a-b).map(([number,slot]) => {
      const rows = [...current.rows.values()].filter(row => row.key.toLowerCase().startsWith(slot.folder.toLowerCase() + '/'));
      const title = text.decode(slot.header).split('\0').filter(Boolean).map(part => part.replace(/[\u0000-\u001f\u007f]/g,' ').trim()).filter(Boolean).join(' · ');
      return {number,title,bytes:rows.reduce((sum,row) => sum + row.size,0),tooLarge:rows.some(row => row.size > SAVE_LIMITS.fileBytes)};
    });
  } finally { db?.close(); await owner.close(); }
}
export async function exportSaveZip({signal,storeFactory = openResourceStore,userName = USER_ROOT,progress = () => {},slots} = {}) {
  const owner = await storeFactory(); let db, writer;
  try {
    db = await openUser(userName); const current = await inventory(db);
    if (slots !== undefined) {
      if (!Array.isArray(slots) || slots.some(slot => !Number.isInteger(slot) || slot < 1 || slot > 1000)) fail('invalid_save','Invalid export selection');
      const chosen = new Set(slots);
      for (const slot of current.slots.keys()) if (!chosen.has(slot)) current.slots.delete(slot);
    }
    if (!current.slots.size) fail('no_saves','No saves to export');
    const rows = [...current.rows.values()].filter(row => [...current.slots.values()].some(slot => row.key.toLowerCase().startsWith(slot.folder.toLowerCase() + '/')) && (row.mode & 0o170000) === 0o100000 && !/\/ce-meta\.txt$/i.test(row.key));
    const total = rows.reduce((sum,row) => sum + row.size,0);
    if (total > SAVE_LIMITS.bytes || rows.some(row => row.size > SAVE_LIMITS.fileBytes) || rows.length > SAVE_LIMITS.files) fail('limit','Export exceeds save archive memory budget');
    const {ZipWriter,BlobWriter,Uint8ArrayReader} = globalThis.zip;
    writer = new ZipWriter(new BlobWriter('application/zip'),{useWebWorkers:false,level:0,bufferedWrite:true,dataDescriptor:false});
    let bytes = 0;
    for (const row of rows) {
      checkCancelled(signal);
      const stored = await request(db.transaction('FILE_DATA').objectStore('FILE_DATA').get(row.key));
      const relative = row.key.slice((USER_ROOT + '/savegame/').length);
      await writer.add('SAVEGAME/' + relative,new Uint8ArrayReader(stored.contents),{signal,level:0});
      bytes += row.size; progress({phase:'export',bytes,total,cancelAllowed:true});
    }
    const records = parseRecords(decoder.decode(current.texts.get('/port/saves.txt')));
    const [first,end] = quickRange(...await installedConfigs(owner,await owner.active(),current)), exported = new Map();
    for (const [slot,value] of current.slots) {
      const known = records.get(slot), record = known?.id === value.id ? {...known} : {id:value.id,created:'0',order:'0',composition:''};
      record.quick = slot >= first && slot < end; exported.set(slot,record);
    }
    await writer.add('fallout2-saves.txt',new Uint8ArrayReader(encoder.encode(recordText(exported))),{signal,level:0});
    const blob = await writer.close(); writer = null;
    return {blob,slots:current.slots.size,filename:'Fallout2-saves-' + new Date().toISOString().slice(0,10) + '.zip'};
  } finally { await writer?.close().catch(() => {}); db?.close(); await owner.close(); }
}
