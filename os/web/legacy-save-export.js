// Recovery only, not a second writable backend. If migration cannot finish,
// export the untouched IDBFS rows without requiring a successful migration.
// One legacy file is necessarily cloned whole by IndexedDB's old row layout.
import {openResourceStore} from './resource-store.js';
import {openUserStore,USER_DATABASE} from './user-store.js';
import {temporaryExport} from './opfs-export.js';
import {ZipOutput} from './zip-output.js';
import {slotNumber,saveIdentity,parseRecords,recordText,quickRange} from './save-format.js';
import {decodeConfig} from './game-config.js';
import {checkCancelled} from './storage-common.js';
const request = r => new Promise((resolve,reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const get = (db,key) => request(db.transaction('FILE_DATA').objectStore('FILE_DATA').get(key));
async function* keys(db) {
  let last;
  for (;;) {
    const page = [];
    await new Promise((resolve,reject) => {
      const r = db.transaction('FILE_DATA').objectStore('FILE_DATA').openKeyCursor(last ? IDBKeyRange.lowerBound(last,true) : undefined);
      r.onerror = () => reject(r.error); r.onsuccess = () => { const c = r.result; if (!c || page.length >= 128) { resolve(); return; } page.push(c.key); c.continue(); };
    });
    if (!page.length) return; for (const key of page) { last = key; yield key; }
  }
}
export async function exportLegacySaveZip({signal,userName = USER_DATABASE,storeFactory = openResourceStore,temporary = temporaryExport,progress = () => {}} = {}) {
  // Every old and new production writer owns this historical resource lease.
  const owner = await storeFactory(); let db,recovery,temp,complete = false;
  try {
    db = await request(indexedDB.open(userName));
    if (db.version === 22) {
      db.close(); recovery = await openUserStore({name:userName,recovery:true});
      if (await recovery.state()) throw new Error('New user storage is already active; use normal export');
      await recovery.resetMigration(); db = await request(indexedDB.open(userName));
    }
    if (!db.objectStoreNames.contains('FILE_DATA')) throw new Error('No legacy saves to recover');
    const marker = await get(db,userName + '/format.json');
    const format = marker?.contents && JSON.parse(new TextDecoder().decode(marker.contents));
    if (![1,2].includes(format?.format) || format.minReader !== format.format || format.minWriter !== format.format) throw new Error('Unsupported legacy save format');
    const slots = new Map(); let records = new Map(), cfg = '', ddraw = '';
    for await (const key of keys(db)) {
      checkCancelled(signal);
      const relative = key.slice(userName.length + 1), match = /^savegame\/([^/]+)\/save\.dat$/i.exec(relative), n = match && slotNumber(match[1]);
      if (n) {
        const row = await get(db,key), bytes = row?.contents;
        if (bytes?.length >= 131 && new TextDecoder().decode(bytes.subarray(0,17)) === 'FALLOUT SAVE FILE') slots.set(n,{id:saveIdentity(bytes),folder:key.slice(0,key.lastIndexOf('/')).toLowerCase()});
      } else if (/^(port\/saves\.txt|settings\/(fallout2\.cfg|ddraw\.ini))$/i.test(relative)) {
        const row = await get(db,key); if (row?.contents?.length > 16 * 1024 ** 2) throw new Error('Legacy save metadata is too large');
        if (/saves\.txt$/i.test(relative)) records = parseRecords(new TextDecoder().decode(row.contents));
        else if (/fallout2\.cfg$/i.test(relative)) cfg = decodeConfig(row.contents); else ddraw = decodeConfig(row.contents);
      }
    }
    if (!slots.size) throw new Error('No legacy saves to recover');
    temp = await temporary(); const writer = new ZipOutput(temp.output,temp.directory,{signal}); let bytes = 0;
    for await (const key of keys(db)) {
      const relative = key.slice(userName.length + 1), m = /^savegame\/([^/]+)\/(.+)$/i.exec(relative), n = m && slotNumber(m[1]);
      if (!n || !slots.has(n) || /(^|\/)ce-meta\.txt$/i.test(m[2])) continue;
      checkCancelled(signal); const row = await get(db,key), data = row?.contents;
      if (!data) continue;
      await writer.add('SAVEGAME/' + m[1] + '/' + m[2],{size:data.length,read:async (at,n) => data.subarray(at,at + n)},{date:+row.timestamp});
      bytes += data.length; progress({phase:'export',bytes,total:0,cancelAllowed:true});
    }
    const [first,end] = quickRange(cfg,ddraw), exported = new Map();
    for (const [n,slot] of slots) {
      const known = records.get(n); exported.set(n,{...(known?.id === slot.id ? known : {id:slot.id,created:'0',order:'0',composition:''}),quick:n >= first && n < end});
    }
    const data = new TextEncoder().encode(recordText(exported));
    await writer.add('fallout2-saves.txt',{size:data.length,read:async (at,n) => data.subarray(at,at + n)});
    await writer.close(); const blob = await temp.file(); complete = true;
    return {blob,slots:slots.size,filename:'Fallout2-saves-recovery.zip'};
  } finally { if (!complete) await temp?.discard().catch(() => {}); db?.close(); await recovery?.close(); await owner.close(); }
}
