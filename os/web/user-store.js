// Permanent user data, format 3. One writer owns the DB. Payloads are immutable
// blocks; a strict metadata transaction publishes an entire native operation.
// Node IDs survive directory rename: saving a slot never copies its subtree.
// No full-tree getAll(), no full-library restore, no unbounded generation chain.
import {BLOCK_SIZE,MAX_READ,digest,checkCancelled,busyError} from './storage-common.js';
import {crc32} from './zip-output.js';

export const USER_DATABASE = '/fallout2-ce-mobile-userdata';
export const USER_DB_VERSION = 22;
export const USER_FORMAT = Object.freeze({format:3,minReader:3,minWriter:3});
const STORES = ['state','nodes','staged','jobs','contents','refs','chunks','zipEntries','undo'];
const writers = new WeakMap();
const req = request => new Promise((resolve,reject) => {
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
function transaction(db,names,mode,action) {
  return new Promise((resolve,reject) => {
    let tx, result, failure;
    try { tx = db.transaction(names,mode,mode === 'readwrite' ? {durability:'strict'} : undefined); }
    catch (error) { reject(error); return; }
    const abort = error => { failure ||= error; try { tx.abort(); } catch {} };
    const active = writers.get(db) || new Set(); writers.set(db,active);
    if (mode === 'readwrite') active.add(tx);
    tx.onabort = () => { active.delete(tx); reject(failure || tx.error || new Error('User storage transaction aborted')); };
    tx.onerror = event => { event.preventDefault(); abort(event.target.error); };
    tx.oncomplete = () => { active.delete(tx); resolve(result); };
    try { result = action(tx,abort); } catch (error) { abort(error); }
  });
}
const get = (db,store,key) => req(db.transaction(store).objectStore(store).get(key));
function open(name,version) {
  return new Promise((resolve,reject) => {
    let cancelled = false;
    const request = indexedDB.open(name,version);
    request.onblocked = () => { cancelled = true; reject(busyError('Close the other game windows before updating user storage')); };
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      if (cancelled) { request.transaction.abort(); return; }
      const db = request.result;
      if (version === undefined) return; // Inspect/create an empty database only.
      if (version !== USER_DB_VERSION) { request.transaction.abort(); return; }
      for (const store of STORES) if (!db.objectStoreNames.contains(store)) {
        const value = db.createObjectStore(store);
        if (store === 'nodes') value.createIndex('parent',['parent','key'],{unique:true});
        if (store === 'staged') value.createIndex('parent',['job','parent','key'],{unique:true});
        if (store === 'contents') value.createIndex('refs','refs');
        if (store === 'refs') value.createIndex('hash','hash');
      }
    };
    request.onsuccess = () => { if (cancelled) request.result.close(); else resolve(request.result); };
  });
}
function validateFormat(value) {
  if (value?.format !== 3 || value.minReader !== 3 || value.minWriter !== 3) throw new Error('Unsupported user storage format; existing files were not reset');
}
function canonical(name) {
  if (typeof name !== 'string' || !name || /[\/\\\u0000-\u001f\u007f:]/.test(name) || ['.','..'].includes(name)) throw new Error('Invalid user filename');
  return name.normalize('NFC').toLowerCase();
}
const range = prefix => IDBKeyRange.bound(prefix,[...prefix,[]]);
const PAGE = 128;
const rows = async (db,store,keyRange,{index,after,limit = PAGE,keys = false} = {}) => {
  const values = [];
  await transaction(db,[store],'readonly',tx => {
    let source = tx.objectStore(store); if (index) source = source.index(index);
    const cursor = keys ? source.openKeyCursor(keyRange) : source.openCursor(keyRange);
    cursor.onsuccess = () => {
      const c = cursor.result; if (!c) return;
      if (after !== undefined && indexedDB.cmp(c.key,after) <= 0) { c.continue(); return; }
      values.push({key:c.key,primaryKey:c.primaryKey,value:keys ? undefined : c.value});
      if (values.length < limit) c.continue();
    };
  });
  return values;
};
// Removes the refs in keyRange, a bounded page per transaction, and a chunk
// with its last ref. `last` adds to the transaction that finds no more refs:
// a small file's cleanup is one transaction.
async function deleteRefs(db,keyRange,last = () => {}) {
  for (let done = false; !done;) {
    await transaction(db,['refs','chunks','contents'],'readwrite',tx => {
      const refs = tx.objectStore('refs'), cursor = refs.openCursor(keyRange);
      let removed = 0;
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) { done = true; last(tx); return; }
        const hash = c.value.hash; c.delete();
        const count = refs.index('hash').count(hash);
        count.onsuccess = () => { if (!count.result) tx.objectStore('chunks').delete(hash); };
        if (++removed < PAGE) c.continue();
      };
    });
  }
}

export async function openUserStore({name = USER_DATABASE,locks = globalThis.navigator?.locks,signal} = {}) {
  // The application also holds its resource lease. This independent lease
  // protects callers (tests, tools) that do not open resources.
  if (!locks?.request) throw new Error('Web Locks are required for safe user storage');
  let release, acquired, lockError;
  const ready = new Promise(resolve => { acquired = resolve; });
  const finished = locks.request(name + ':writer',{ifAvailable:true},async lock => {
    if (!lock) { lockError = busyError('User storage is open in another window'); acquired(); return; }
    await new Promise(resolve => { release = resolve; acquired(); });
  }).catch(error => { lockError = error; acquired(); });
  await ready;
  if (lockError) { await finished; throw lockError; }
  let db, closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    for (const tx of writers.get(db) || []) { try { tx.abort(); } catch {} }
    db?.close(); release?.(); await finished;
  };
  try {
    checkCancelled(signal);
    // Opening without a version inspects an existing DB without changing its
    // schema. A fresh DB may be created empty; it has no confirmed progress.
    // Other layouts (such as earlier test builds' IDBFS rows) are refused and
    // left as they are.
    db = await open(name);
    if (db.version > USER_DB_VERSION) throw new Error('A newer application created this user database');
    if (db.objectStoreNames.length && !db.objectStoreNames.contains('nodes')) throw new Error('Unknown user database layout');
    if (db.version !== USER_DB_VERSION) { db.close(); db = await open(name,USER_DB_VERSION); }
    db.onversionchange = () => { close(); };
    let state = await get(db,'state','format');
    if (state) validateFormat(state);
    const assertOpen = () => { if (closed) throw new Error('User storage is closed'); };
    // A content record and the blocks covering [offset, offset + length)
    // with their payloads, in one transaction: a phone pays a round trip per
    // transaction. Payloads are verified by assemble().
    const fetchBlocks = (content,offset,length) => {
      const out = {info:undefined,blocks:new Map()};
      return transaction(db,['contents','refs','chunks'],'readonly',tx => {
        const info = tx.objectStore('contents').get(content);
        info.onsuccess = () => { out.info = info.result; };
        if (!length) return out;
        const first = Math.floor(offset / BLOCK_SIZE), last = Math.floor((offset + length - 1) / BLOCK_SIZE);
        const refs = tx.objectStore('refs').openCursor(IDBKeyRange.bound([content,first],[content,last]));
        refs.onsuccess = () => {
          const cursor = refs.result; if (!cursor) return;
          const block = {ref:cursor.value,bytes:undefined}, bytes = tx.objectStore('chunks').get(block.ref.hash);
          bytes.onsuccess = () => { block.bytes = bytes.result; };
          out.blocks.set(cursor.key[1],block); cursor.continue();
        };
        return out;
      });
    };
    async function assemble(info,blocks,offset,length) {
      const result = new Uint8Array(length);
      for (let at = 0; at < length;) {
        const absolute = offset + at, index = Math.floor(absolute / BLOCK_SIZE), skip = absolute % BLOCK_SIZE;
        const count = Math.min(length - at,BLOCK_SIZE - skip), block = blocks.get(index);
        if (!block) {
          if (info.base && absolute < (info.inheritSize ?? Infinity)) {
            const size = Math.min(count,(info.inheritSize ?? Infinity) - absolute);
            result.set(await store.read(info.base,absolute,size),at);
          } else if (info.sealed) throw new Error('Missing user block reference');
        } else {
          const {ref,bytes} = block;
          if (!(bytes instanceof Uint8Array) || bytes.length !== ref.size || await digest(bytes) !== ref.hash || (info.sealed && skip + count > bytes.length)) throw new Error('Corrupt user block');
          result.set(bytes.subarray(skip,Math.min(skip + count,bytes.length)),at);
        }
        at += count;
      }
      return result;
    }
    const store = {
      name,close,get closed() { return closed; },
      async state() { assertOpen(); return get(db,'state','active'); },
      async begin(kind = 'native') {
        assertOpen(); const job = crypto.randomUUID(), active = await store.state();
        await transaction(db,['jobs'],'readwrite',tx => tx.objectStore('jobs').add({job,kind,base:active?.revision || 0,created:Date.now()},job));
        return job;
      },
      async job(id) { return get(db,'jobs',id); },
      archiveCatalog(job) {
        return {
          async remember(entry) {
            await transaction(db,['zipEntries'],'readwrite',tx => tx.objectStore('zipEntries').add({...entry,checked:false},[job,entry.path.toLowerCase()]));
          },
          async verify(entry) {
            await transaction(db,['zipEntries'],'readwrite',(tx,abort) => {
              const entries = tx.objectStore('zipEntries'), key = [job,entry.path.toLowerCase()], r = entries.get(key);
              r.onsuccess = () => {
                const old = r.result;
                if (!old || old.checked || old.path !== entry.path || old.size !== entry.size || old.crc !== entry.crc || old.directory !== entry.directory || old.offset !== entry.offset) { abort(new Error('ZIP local/central directory mismatch')); return; }
                entries.put({...old,checked:true},key);
              };
            });
          },
        };
      },
      async updateJob(id,patch) {
        await transaction(db,['jobs'],'readwrite',(tx,abort) => {
          const target = tx.objectStore('jobs'), request = target.get(id);
          request.onsuccess = () => { try { if (!request.result) throw new Error('Missing user staging job'); target.put({...request.result,...patch},id); } catch (error) { abort(error); } };
        });
      },
      async node(id,job) {
        assertOpen();
        if (!job) return get(db,'nodes',id);
        const out = {};
        await transaction(db,['staged','nodes'],'readonly',tx => {
          const pending = tx.objectStore('staged').get([job,id]);
          pending.onsuccess = () => {
            if (pending.result) { out.node = pending.result.deleted ? undefined : pending.result; return; }
            const node = tx.objectStore('nodes').get(id);
            node.onsuccess = () => { out.node = node.result; };
          };
        });
        return out.node;
      },
      async lookup(parent,name,job) {
        // One transaction: a phone pays a round trip per transaction.
        const key = canonical(name), out = {};
        await transaction(db,job ? ['staged','nodes'] : ['nodes'],'readonly',tx => {
          const committed = () => {
            const node = tx.objectStore('nodes').index('parent').get([parent,key]);
            node.onsuccess = () => {
              if (!node.result || !job) { out.node = node.result; return; }
              // The job may have renamed or deleted that node.
              const pending = tx.objectStore('staged').get([job,node.result.id]);
              pending.onsuccess = () => {
                const updated = pending.result || node.result;
                if (!updated.deleted && updated.parent === parent && updated.key === key) out.node = updated;
              };
            };
          };
          if (!job) { committed(); return; }
          const pending = tx.objectStore('staged').index('parent').get([job,parent,key]);
          pending.onsuccess = () => { if (pending.result && !pending.result.deleted) out.node = pending.result; else committed(); };
        });
        return out.node;
      },
      async stage(job,node) { return (await store.stageAll(job,[node]))[0]; },
      async stageAll(job,nodes) {
        assertOpen();
        const values = nodes.map(node => {
          const value = {...node,job,key:node.id === 'root' ? '' : canonical(node.name)};
          // A tombstone owns an inode, not its old name. A replacement created
          // within the same native operation is allowed to use that name.
          if (value.deleted) delete value.key;
          return value;
        });
        await transaction(db,['staged'],'readwrite',tx => {
          for (const value of values) tx.objectStore('staged').put(value,[job,value.id]);
        });
        return values;
      },
      async *children(parent,{job} = {}) {
        // Independent paged cursors, merge by canonical name. At most two pages
        // and one updated-node lookup are resident, even for a huge directory.
        async function* stream(source,prefix) {
          let after;
          for (;;) {
            const page = await rows(db,source,range(prefix),{index:'parent',after});
            for (const row of page) {
              after = row.key;
              // A committed row is current unless the job staged a change.
              const node = source === 'nodes' && job ? await store.node(row.value.id,job) : row.value;
              if (node && !node.deleted && node.parent === parent && node.key === row.value.key) yield node;
            }
            if (page.length < PAGE) return;
          }
        }
        const a = stream('nodes',[parent]), b = job ? stream('staged',[job,parent]) : (async function*(){})();
        let x = await a.next(), y = await b.next();
        while (!x.done || !y.done) {
          if (!y.done && (x.done || y.value.key <= x.value.key)) {
            const value = y.value; y = await b.next();
            if (!x.done && x.value.key === value.key) x = await a.next();
            yield value;
          } else { const value = x.value; x = await a.next(); yield value; }
        }
      },
      async resolve(path,{job,create = false,root = 'root'} = {}) {
        let parent = await store.node(root,job);
        for (const part of path.split('/').filter(Boolean)) {
          let child = await store.lookup(parent.id,part,job);
          if (!child && create) child = await store.stage(job,{id:crypto.randomUUID(),parent:parent.id,name:part,mode:0o40700,size:0,time:Date.now()});
          if (!child) return;
          if ((child.mode & 0o170000) !== 0o040000) throw new Error('User path is not a directory');
          parent = child;
        }
        return parent;
      },
      async *walk(parent = 'root',prefix = '',options = {}) {
        for await (const node of store.children(parent,options)) {
          const path = prefix + node.name;
          if ((node.mode & 0o170000) === 0o040000) yield* store.walk(node.id,path + '/',options);
          else yield {path,node};
        }
      },
      async content(base,job) {
        const id = crypto.randomUUID();
        await transaction(db,['contents'],'readwrite',(tx,abort) => {
          const contents = tx.objectStore('contents');
          const add = original => contents.add({id,job,base,inheritSize:original?.size || 0,refs:0,sealed:false},id);
          if (!base) { add(); return; }
          const original = contents.get(base);
          original.onsuccess = () => { if (original.result?.sealed) add(original.result); else abort(new Error('Invalid inherited user content')); };
        });
        return id;
      },
      async write(content,index,data) {
        assertOpen();
        if (!Number.isSafeInteger(index) || index < 0 || !(data instanceof Uint8Array) || !data.length || data.length > BLOCK_SIZE) throw new Error('Invalid user block');
        // IndexedDB stores a view's whole ArrayBuffer: keep just this block.
        if (data.byteOffset || data.byteLength !== data.buffer.byteLength) data = data.slice();
        const hash = await digest(data);
        await transaction(db,['contents','refs','chunks'],'readwrite',(tx,abort) => {
          const pending = tx.objectStore('contents').get(content);
          pending.onsuccess = () => {
            try {
              if (!pending.result || pending.result.sealed) throw new Error('User content is immutable');
              const old = tx.objectStore('refs').get([content,index]);
              old.onsuccess = () => {
                try {
                  const exists = tx.objectStore('chunks').getKey(hash);
                  exists.onsuccess = () => {
                    try {
                      if (exists.result === undefined) tx.objectStore('chunks').add(data,hash);
                      tx.objectStore('refs').put({hash,size:data.length},[content,index]);
                      if (old.result && old.result.hash !== hash) {
                        const count = tx.objectStore('refs').index('hash').count(old.result.hash);
                        count.onsuccess = () => { if (!count.result) tx.objectStore('chunks').delete(old.result.hash); };
                      }
                    } catch (error) { abort(error); }
                  };
                } catch (error) { abort(error); }
              };
            } catch (error) { abort(error); }
          };
        });
        return hash;
      },
      async read(content,offset,length) {
        assertOpen();
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 0 || length > MAX_READ) throw new Error('Invalid user read');
        const {info,blocks} = await fetchBlocks(content,offset,length);
        if (!info) throw new Error('Missing user content');
        if (info.sealed && offset + length > info.size) throw new Error('Read beyond user content');
        return assemble(info,blocks,offset,length);
      },
      async truncate(content,size) {
        const info = await get(db,'contents',content);
        if (!info || info.sealed || !Number.isSafeInteger(size) || size < 0) throw new Error('Invalid user truncation');
        const fence = Math.min(info.inheritSize ?? Infinity,size);
        const tail = size % BLOCK_SIZE ? await store.read(content,Math.floor(size / BLOCK_SIZE) * BLOCK_SIZE,size % BLOCK_SIZE) : null;
        await deleteRefs(db,IDBKeyRange.bound([content,Math.floor(size / BLOCK_SIZE)],[content,[]]),
          tx => tx.objectStore('contents').put({...info,inheritSize:fence},content));
        if (tail) await store.write(content,Math.floor(size / BLOCK_SIZE),tail);
      },
      async seal(content,size,{signal} = {}) {
        if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid user content size');
        let crc = 0, info;
        // Flatten inherited references, never a chain that grows on every save.
        for (let offset = 0; offset === 0 || offset < size; offset += MAX_READ) {
          checkCancelled(signal);
          const length = Math.min(MAX_READ,size - offset), fetched = await fetchBlocks(content,offset,length);
          if (!info) {
            info = fetched.info;
            if (!info) throw new Error('Invalid user content size');
            if (info.sealed) { if (info.size !== size) throw new Error('User content size changed'); return info; }
          }
          const data = await assemble(info,fetched.blocks,offset,length); crc = crc32(data,crc);
          for (let at = 0; at < length; at += BLOCK_SIZE) {
            const index = (offset + at) / BLOCK_SIZE, count = Math.min(BLOCK_SIZE,length - at);
            if (fetched.blocks.get(index)?.ref.size !== count) await store.write(content,index,data.subarray(at,at + count));
          }
        }
        const sealed = {...info,base:null,inheritSize:undefined,size,crc,sealed:true};
        await transaction(db,['contents'],'readwrite',tx => tx.objectStore('contents').put(sealed,content));
        return sealed;
      },
      async putFile(job,path,source,{signal,time = Date.now(),mode = 0o100600,root = 'root'} = {}) {
        const parts = path.split('/'), name = parts.pop(), parent = await store.resolve(parts.join('/'),{job,create:true,root});
        const old = await store.lookup(parent.id,name,job);
        if (old && (old.mode & 0o170000) !== 0o100000) throw new Error('User file/directory collision');
        const content = await store.content(null,job);
        for (let at = 0; at < source.size; at += BLOCK_SIZE) {
          checkCancelled(signal);
          const length = Math.min(BLOCK_SIZE,source.size - at), data = await source.read(at,length);
          if (!(data instanceof Uint8Array) || data.length !== length) throw new Error('Short user file source read');
          await store.write(content,at / BLOCK_SIZE,data);
        }
        const sealed = await store.seal(content,source.size,{signal});
        return store.stage(job,{id:old?.id || crypto.randomUUID(),parent:parent.id,name,mode,size:source.size,time,content,crc:sealed.crc});
      },
      async putStream(job,path,chunks,{signal,root = 'root',limit = Number.MAX_SAFE_INTEGER} = {}) {
        const parts = path.split('/'), name = parts.pop(), parent = await store.resolve(parts.join('/'),{job,create:true,root});
        if (await store.lookup(parent.id,name,job)) throw new Error('Duplicate file or file/directory collision in ZIP');
        const content = await store.content(null,job), prefix = new Uint8Array(4096);
        let pending = new Uint8Array(BLOCK_SIZE), used = 0, size = 0, index = 0;
        for await (const chunk of chunks) {
          checkCancelled(signal);
          if (size + chunk.length > limit || !Number.isSafeInteger(size + chunk.length)) throw new Error('Archive entry exceeds its metadata/size budget');
          if (size < prefix.length) prefix.set(chunk.subarray(0,Math.min(chunk.length,prefix.length - size)),size);
          size += chunk.length;
          for (let at = 0; at < chunk.length;) {
            const n = Math.min(BLOCK_SIZE - used,chunk.length - at); pending.set(chunk.subarray(at,at + n),used); used += n; at += n;
            if (used === BLOCK_SIZE) { await store.write(content,index++,pending); used = 0; }
          }
        }
        if (used) await store.write(content,index,pending.subarray(0,used)); pending = null;
        const info = await store.seal(content,size,{signal});
        const node = await store.stage(job,{id:crypto.randomUUID(),parent:parent.id,name,mode:0o100600,size,time:Date.now(),content,crc:info.crc});
        return {node,prefix:prefix.subarray(0,Math.min(size,prefix.length))};
      },
      async commit(job,{signal} = {}) {
        assertOpen(); checkCancelled(signal);
        // One metadata transaction. No async awaits in a cursor callback and
        // no payload cloning here. First remove changed old edges, then insert
        // new edges, so a directory exchange cannot violate the unique index.
        await transaction(db,['jobs','nodes','staged','contents','state','undo'],'readwrite',(tx,abort) => {
          const pending = tx.objectStore('jobs').get(job);
          const guard = fn => (...args) => { try { fn(...args); } catch (error) { abort(error); } };
          const onAbort = () => abort(new DOMException('Cancelled','AbortError'));
          signal?.addEventListener('abort',onAbort,{once:true});
          tx.addEventListener('complete',() => signal?.removeEventListener('abort',onAbort));
          tx.addEventListener('abort',() => signal?.removeEventListener('abort',onAbort));
          pending.onsuccess = guard(() => {
            if (!pending.result) throw new Error('Missing user staging job');
            const stateRequest = tx.objectStore('state').get('active');
            stateRequest.onsuccess = guard(() => {
              if ((stateRequest.result?.revision || 0) !== pending.result.base) throw new Error('Stale user staging job');
              const undo = tx.objectStore('undo'), previous = undo.openCursor();
              previous.onsuccess = guard(() => {
                const old = previous.result;
                if (!old) { start(); return; }
                if (old.value.content) {
                  const r = tx.objectStore('contents').get(old.value.content);
                  r.onsuccess = guard(() => {
                    if (!r.result || r.result.refs < 1) throw new Error('Invalid previous user content reference');
                    const saved = tx.objectStore('contents').put({...r.result,refs:r.result.refs - 1},r.result.id);
                    saved.onsuccess = () => { old.delete(); old.continue(); };
                  });
                } else { old.delete(); old.continue(); }
              });
              function start() {
              const first = tx.objectStore('staged').openCursor(range([job]));
              first.onsuccess = guard(() => {
                const cursor = first.result;
                if (cursor) {
                  const old = tx.objectStore('nodes').get(cursor.value.id);
                  old.onsuccess = guard(() => {
                    undo.put(old.result || {id:cursor.value.id,deleted:true},cursor.value.id);
                    // The old content pointer moves from active to undo; its
                    // reference count is unchanged until the next checkpoint.
                    tx.objectStore('nodes').delete(cursor.value.id); cursor.continue();
                  }); return;
                }
                const second = tx.objectStore('staged').openCursor(range([job]));
                second.onsuccess = guard(() => {
                  const cursor = second.result;
                  if (!cursor) {
                    tx.objectStore('state').put(USER_FORMAT,'format');
                    tx.objectStore('state').put(stateRequest.result || null,'previous');
                    tx.objectStore('state').put({revision:pending.result.base + 1,job,completed:Date.now()},'active');
                    tx.objectStore('jobs').delete(job); return;
                  }
                  const {job:_job,deleted,...node} = cursor.value;
                  if (!deleted) {
                    if ((node.mode & 0o170000) === 0o100000) {
                      const content = tx.objectStore('contents').get(node.content);
                      content.onsuccess = guard(() => {
                        if (!content.result?.sealed || content.result.size !== node.size) throw new Error('Unverified user content');
                        tx.objectStore('contents').put({...content.result,refs:content.result.refs + 1},content.result.id);
                        tx.objectStore('nodes').put(node,node.id);
                        cursor.delete(); cursor.continue();
                      });
                      return;
                    } else tx.objectStore('nodes').put(node,node.id);
                  }
                  cursor.delete(); cursor.continue();
                });
              });
              }
            });
          });
        });
        return store.state();
      },
      async discard(job) {
        assertOpen();
        await transaction(db,['staged','jobs','zipEntries'],'readwrite',tx => { tx.objectStore('staged').delete(range([job])); tx.objectStore('zipEntries').delete(range([job])); tx.objectStore('jobs').delete(job); });
      },
      async collect({limit = Infinity} = {}) {
        // Query garbage by reference count. Startup/checkpoint cleanup need not
        // traverse a huge live library. Undo and active jobs pin their contents.
        let removed = 0;
        for (;;) {
          const page = await rows(db,'contents',IDBKeyRange.only(0),{index:'refs'}); if (!page.length) break;
          let progress = false;
          for (const row of page) {
            const item = row.value;
            if (await get(db,'jobs',item.job)) continue;
            // One file may contain many blocks; visit those references in
            // bounded pages and drop a chunk only after its last ref is gone.
            await deleteRefs(db,range([item.id]),tx => tx.objectStore('contents').delete(item.id));
            progress = true; if (++removed >= limit) return removed;
          }
          if (!progress || page.length < PAGE) break;
        }
        return removed;
      },
      // Test instrumentation exposes counts, never the database handle.
      async counts() {
        const out = {}; for (const key of STORES) out[key] = await req(db.transaction(key).objectStore(key).count()); return out;
      },
      async restorePrevious() {
        if (!await get(db,'state','previous')) throw new Error('There is no previous user checkpoint');
        const job = await store.begin('recovery'); let after;
        try {
          for (;;) {
            const page = await rows(db,'undo',undefined,{after}); if (!page.length) break;
            for (const row of page) { after = row.key;
              // Tombstones for newly-created inodes need their current name
              // to satisfy the same validated staging contract as native I/O.
              const node = row.value.deleted ? {...await store.node(row.key),deleted:true} : row.value;
              if (node.id) await store.stage(job,node);
            }
          }
          return await store.commit(job);
        } catch (error) { await store.discard(job); throw error; }
      },
    };
    if (!await store.state()) {
      // A new library: the format marker and the engine's directories are
      // published as the first checkpoint. An interrupted attempt leaves only
      // a staging job, discarded below; the next open starts again.
      const job = await store.begin('init');
      await store.stage(job,{id:'root',parent:'',name:'',key:'',mode:0o40700,size:0,time:Date.now()});
      const data = new TextEncoder().encode(JSON.stringify(USER_FORMAT));
      await store.putFile(job,'format.json',{size:data.length,read:async (at,n) => data.subarray(at,at + n)});
      for (const dir of ['savegame','settings','exports','port']) await store.resolve(dir,{job,create:true});
      await store.commit(job,{signal});
    }
    // Jobs left by a closed prior writer, including an unfinished first one.
    // Metadata cursor only, never payloads or the live tree at startup.
    for (;;) {
      const jobs = await rows(db,'jobs'); if (!jobs.length) break;
      for (const row of jobs) await store.discard(row.key);
    }
    // Visit the garbage index, not the live tree. A cancelled multi-GB import
    // must not require hundreds of reopenings to reclaim its temporary data.
    await store.collect().catch(error => console.warn('User garbage collection deferred',error));
    return store;
  } catch (error) { await close(); throw error; }
}
