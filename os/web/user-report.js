import {USER_DATABASE,USER_DB_VERSION} from './user-store.js';
import {BLOCK_SIZE,digest} from './storage-common.js';
const request = r => new Promise((resolve,reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
async function open(name) {
  const r = indexedDB.open(name); let absent = false;
  r.onupgradeneeded = () => { absent = true; r.transaction.abort(); };
  try { return await request(r); } catch (error) { if (!absent) throw error; return null; }
}
const get = (db,store,key) => request(db.transaction(store).objectStore(store).get(key));
const lookup = (db,parent,name) => request(db.transaction('nodes').objectStore('nodes').index('parent').get([parent,name.toLowerCase()]));
async function resolve(db,path) {
  let node = await get(db,'nodes','root');
  for (const name of path.split('/').filter(Boolean)) { if (!node) return; node = await lookup(db,node.id,name); }
  return node;
}
async function children(db,parent,action) {
  await new Promise((resolve,reject) => {
    const r = db.transaction('nodes').objectStore('nodes').index('parent').openCursor(IDBKeyRange.bound([parent],[parent,[]]));
    r.onerror = () => reject(r.error);
    r.onsuccess = () => { const c = r.result; if (!c) { resolve(); return; } action(c.value); c.continue(); };
  });
}
// Read only: report/font queries never create, migrate, or reset the DB and
// may run while a reviewed import owns the writer lease.
export async function userSettingText(path,{name = USER_DATABASE} = {}) {
  const db = await open(name); if (!db) return '';
  try {
    if (db.version === USER_DB_VERSION && db.objectStoreNames.contains('nodes')) {
      const format = await get(db,'state','format'); if (format?.format !== 3) return '';
      const node = await resolve(db,path); if (!node) return '';
      if (node.size > 2 * 1024 ** 2) throw new Error('Unexpectedly large settings file');
      const bytes = new Uint8Array(node.size);
      for (let at = 0; at < bytes.length; at += BLOCK_SIZE) {
        const ref = await get(db,'refs',[node.content,at / BLOCK_SIZE]), chunk = ref && await get(db,'chunks',ref.hash);
        if (!chunk || chunk.length !== ref.size || await digest(chunk) !== ref.hash) throw new Error('Corrupt settings block');
        bytes.set(chunk,at);
      }
      return new TextDecoder('windows-1251').decode(bytes);
    }
    if (db.version === 21 && db.objectStoreNames.contains('FILE_DATA')) {
      let contents;
      await new Promise((resolve,reject) => {
        const r = db.transaction('FILE_DATA').objectStore('FILE_DATA').openCursor();
        r.onerror = () => reject(r.error); r.onsuccess = () => {
          const c = r.result; if (!c) { resolve(); return; }
          if (String(c.key).toLowerCase() === (name + '/' + path).toLowerCase()) { contents = c.value.contents; resolve(); } else c.continue();
        };
      });
      return contents ? new TextDecoder('windows-1251').decode(contents) : '';
    }
    return '';
  } finally { db.close(); }
}
export async function userStorageReport({name = USER_DATABASE} = {}) {
  let db;
  try {
    db = await open(name);
    const summary = {format:null,saveSlots:0,settingsFiles:0,records:false}; if (!db) return summary;
    if (db.version === USER_DB_VERSION && db.objectStoreNames.contains('nodes')) {
      const format = await get(db,'state','format');
      if (!format) return {...summary,migration:true};
      if (format.format !== 3 || format.minReader !== 3) throw new Error('Unsupported user format');
      summary.format = 3;
      const savegame = await resolve(db,'savegame'), settings = await resolve(db,'settings'), slots = [];
      if (savegame) await children(db,savegame.id,node => { if (/^slot\d+$/i.test(node.name)) slots.push(node.id); });
      for (const id of slots) if (await lookup(db,id,'save.dat')) summary.saveSlots++;
      async function count(parent) {
        const dirs = []; await children(db,parent,node => { if ((node.mode & 0o170000) === 0o040000) dirs.push(node.id); else if (/\.(cfg|ini)$/i.test(node.name)) summary.settingsFiles++; });
        for (const id of dirs) await count(id);
      }
      if (settings) await count(settings.id);
      summary.records = !!await resolve(db,'port/saves.txt'); return summary;
    }
    if (db.version !== 21 || !db.objectStoreNames.contains('FILE_DATA')) throw new Error('Unsupported user database');
    const marker = await get(db,'FILE_DATA',name + '/format.json');
    if (marker?.contents) summary.format = JSON.parse(new TextDecoder().decode(marker.contents)).format;
    await new Promise((resolve,reject) => {
      const r = db.transaction('FILE_DATA').objectStore('FILE_DATA').openKeyCursor();
      r.onerror = () => reject(r.error); r.onsuccess = () => {
        const c = r.result; if (!c) { resolve(); return; }
        const key = String(c.key).slice(name.length).toLowerCase();
        if (/^\/savegame\/slot\d+\/save.dat$/.test(key)) summary.saveSlots++;
        if (/^\/settings\/.*\.(cfg|ini)$/.test(key)) summary.settingsFiles++;
        if (key === '/port/saves.txt') summary.records = true;
        c.continue();
      };
    });
    return summary;
  } catch (error) { return {error:String(error?.message || error)}; }
  finally { db?.close(); }
}
