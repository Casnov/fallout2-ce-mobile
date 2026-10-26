import {openUserStore} from './user-store.js';
import {BLOCK_SIZE} from './storage-common.js';

// An internal suspension, caught only at the Emscripten syscall boundary. It
// must be raised before a synchronous VFS operation changes observable state.
class WaitIO { constructor(promise) { this.userIO = true; this.promise = promise; } }
export async function lazyUserFilesystem(module,options = {}) {
  const FS = module.FS;
  let store = await openUserStore(options);
  const cache = new Map(), dirty = new Map(), nodes = new Map(), lookups = new Map(), directories = new Map();
  const CACHE_LIMIT = 16 * 1024 ** 2, NODE_LIMIT = 2048;
  let bytes = 0, root, job, jobPromise, closed = false, suspended = false, hits = 0, loads = 0;
  const errno = code => { throw new FS.ErrnoError(code); };
  const key = (parent,name) => parent.user.id + '/' + name.normalize('NFC').toLowerCase();
  const touch = (node,updateTime = true) => { if (updateTime) node.user.time = node.user.ctime = Date.now(); dirty.set(node.user.id,node); directories.delete(node.parent?.user?.id); };
  const getJob = async () => job ||= await (jobPromise ||= store.begin());
  function prepareJob() { if (!job) throw new WaitIO(getJob()); }
  const content = async node => {
    if (!node.user.mutable) { node.user.content = await store.content(node.user.content,await getJob()); node.user.mutable = true; }
    return node.user.content;
  };
  async function flush(entry) {
    if (!entry.dirty) return;
    // Only the file's own bytes: sealing then keeps this block as written,
    // instead of storing a padded block and rewriting it.
    const length = Math.min(BLOCK_SIZE,entry.node.user.size - entry.index * BLOCK_SIZE);
    if (length > 0) await store.write(await content(entry.node),entry.index,entry.data.subarray(0,length));
    entry.dirty = false;
  }
  async function evict() {
    while (bytes + BLOCK_SIZE > CACHE_LIMIT && cache.size) {
      const [id,entry] = cache.entries().next().value;
      await flush(entry); cache.delete(id); bytes -= entry.data.length;
    }
  }
  async function load(node,index) {
    const id = node.user.id + ':' + index;
    if (cache.has(id)) return;
    await evict();
    const at = index * BLOCK_SIZE, length = Math.min(BLOCK_SIZE,Math.max(0,node.user.size - at));
    const data = new Uint8Array(BLOCK_SIZE);
    if (length && node.user.content) data.set(await store.read(node.user.content,at,length));
    cache.set(id,{node,index,data,dirty:false}); bytes += data.length; loads++;
  }
  function block(node,index) {
    const id = node.user.id + ':' + index, entry = cache.get(id);
    if (!entry) throw new WaitIO(load(node,index));
    cache.delete(id); cache.set(id,entry); hits++; return entry;
  }
  function prune() {
    if (nodes.size <= NODE_LIMIT) return;
    const pinned = new Set([root]);
    for (const stream of FS.streams) if (stream?.node.user) for (let node = stream.node; node?.user && !pinned.has(node); node = node.parent) pinned.add(node);
    for (const node of dirty.values()) for (let at = node; at?.user && !pinned.has(at); at = at.parent) pinned.add(at);
    // Never evict a parent whose children are still cached.
    const parents = new Set([...nodes.values()].map(node => node.parent));
    for (const [id,node] of nodes) {
      if (nodes.size <= NODE_LIMIT) break;
      if (pinned.has(node) || parents.has(node)) continue;
      for (const [key,entry] of cache) if (entry.node === node) { cache.delete(key); bytes -= entry.data.length; }
      FS.destroyNode(node); nodes.delete(id); lookups.delete(key(node.parent,node.name)); directories.delete(id);
    }
    // Negative lookups are hints, not an ever growing namespace mirror.
    if (lookups.size > NODE_LIMIT * 2) lookups.clear();
  }
  function make(parent,value) {
    const existing = nodes.get(value.id); if (existing) return existing;
    const node = FS.createNode(parent,value.name,value.mode,0);
    node.user = {...value}; node.node_ops = nodeOps; node.stream_ops = streamOps;
    node.timestamp = value.time; nodes.set(value.id,node);
    return node;
  }
  function lookup(parent,name) {
    const id = key(parent,name);
    if (!lookups.has(id)) throw new WaitIO((async () => {
      const value = await store.lookup(parent.user.id,name);
      lookups.set(id,value ? make(parent,value) : null);
    })());
    return lookups.get(id) || errno(44); // ENOENT
  }
  async function list(node) {
    const result = new Map();
    for await (const value of store.children(node.user.id)) {
      const updated = dirty.get(value.id)?.user;
      if (updated && (updated.deleted || updated.parent !== node.user.id)) continue;
      result.set(value.id,updated || value);
    }
    for (const child of dirty.values()) if (!child.user.deleted && child.user.parent === node.user.id) result.set(child.user.id,child.user);
    return [...result.values()].sort((a,b) => a.name.localeCompare(b.name));
  }
  async function* childEntries(node) {
    // A bounded directory stream for libc readdir. Only the current native
    // operation's changed nodes live in RAM; the durable tree stays in IDB.
    const emitted = new Set();
    for await (const value of store.children(node.user.id)) {
      const updated = dirty.get(value.id)?.user;
      if (updated) { emitted.add(value.id); if (updated.deleted || updated.parent !== node.user.id) continue; }
      yield updated || value;
    }
    for (const child of dirty.values()) if (!emitted.has(child.user.id) && !child.user.deleted && child.user.parent === node.user.id) yield child.user;
  }
  function changeSize(node,size) {
    if (!Number.isSafeInteger(size) || size < 0) errno(28);
    prepareJob();
    if (!node.user.truncated || node.user.truncated.size !== size) {
      throw new WaitIO((async () => {
        for (const entry of cache.values()) if (entry.node === node) await flush(entry);
        await store.truncate(await content(node),size);
        for (const [id,entry] of cache) if (entry.node === node) { cache.delete(id); bytes -= entry.data.length; }
        node.user.truncated = {size};
      })());
    }
    delete node.user.truncated; node.user.size = size; touch(node);
  }
  const nodeOps = {
    getattr(node) {
      const u = node.user, date = new Date(u.time);
      return {dev:0x5533,ino:node.id,mode:u.mode,nlink:1,uid:0,gid:0,rdev:0,size:u.size,
        atime:new Date(u.atime ?? u.time),mtime:date,ctime:new Date(u.ctime ?? u.time),blksize:BLOCK_SIZE,blocks:Math.ceil(u.size / 512)};
    },
    setattr(node,attr) {
      if (attr.size !== undefined && attr.size !== node.user.size) changeSize(node,attr.size);
      if (attr.mode !== undefined) node.mode = node.user.mode = attr.mode;
      if (attr.timestamp !== undefined) node.user.time = attr.timestamp;
      if (attr.mtime != null) node.user.time = +attr.mtime;
      if (attr.atime != null) node.user.atime = +attr.atime;
      if (attr.ctime != null) node.user.ctime = +attr.ctime;
      touch(node,false);
    },
    lookup,
    mknod(parent,name,mode) {
      prepareJob();
      if (!FS.isDir(mode) && !FS.isFile(mode)) errno(63);
      const node = make(parent,{id:crypto.randomUUID(),parent:parent.user.id,name,mode,size:0,time:Date.now()});
      lookups.set(key(parent,name),node); touch(node); return node;
    },
    rename(node,parent,name) {
      prepareJob();
      let target;
      try { target = FS.lookupNode(parent,name); } catch (error) { if (error.errno !== 44) throw error; }
      if (target && FS.isDir(target.mode)) {
        if (!directories.has(target.user.id)) throw new WaitIO(list(target).then(rows => directories.set(target.user.id,rows)));
        if (directories.get(target.user.id).length) errno(55);
      }
      if (target) { target.user.deleted = true; touch(target); }
      lookups.set(key(node.parent,node.name),null); directories.delete(node.parent.user.id);
      node.user.parent = parent.user.id; node.user.name = name;
      lookups.set(key(parent,name),node); touch(node,false); directories.delete(parent.user.id);
      // FS.rename owns node.parent/name and the name-table update.
    },
    unlink(parent,name) { prepareJob(); const node = FS.lookupNode(parent,name); node.user.deleted = true; touch(node); lookups.set(key(parent,name),null); },
    rmdir(parent,name) {
      const node = FS.lookupNode(parent,name);
      if (!directories.has(node.user.id)) throw new WaitIO(list(node).then(rows => directories.set(node.user.id,rows)));
      if (directories.get(node.user.id).length) errno(55);
      nodeOps.unlink(parent,name);
    },
    readdir(node) {
      if (!directories.has(node.user.id)) throw new WaitIO(list(node).then(rows => directories.set(node.user.id,rows)));
      return ['.','..',...directories.get(node.user.id).map(row => row.name)];
    },
  };
  const streamOps = {
    llseek(stream,offset,whence) {
      const size = stream.node.user.size;
      const position = whence === 1 ? stream.position + offset : whence === 2 ? size + offset : offset;
      if (!Number.isSafeInteger(position) || position < 0) errno(28);
      return position;
    },
    read(stream,target,offset,length,position) {
      const node = stream.node, count = Math.min(length,Math.max(0,node.user.size - position));
      // Preflight all required blocks before copying anything. Native fd_read
      // invokes this one block at a time; JS settings reads are bounded too.
      const entries = [];
      for (let at = position; at < position + count; at = (Math.floor(at / BLOCK_SIZE) + 1) * BLOCK_SIZE) entries.push(block(node,Math.floor(at / BLOCK_SIZE)));
      let done = 0;
      for (const entry of entries) {
        const skip = (position + done) % BLOCK_SIZE, n = Math.min(count - done,BLOCK_SIZE - skip);
        target.set(entry.data.subarray(skip,skip + n),offset + done); done += n;
      }
      return done;
    },
    write(stream,source,offset,length,position) {
      prepareJob(); const node = stream.node, entries = [];
      for (let at = position; at < position + length; at = (Math.floor(at / BLOCK_SIZE) + 1) * BLOCK_SIZE) entries.push(block(node,Math.floor(at / BLOCK_SIZE)));
      let done = 0;
      for (const entry of entries) {
        const skip = (position + done) % BLOCK_SIZE, n = Math.min(length - done,BLOCK_SIZE - skip);
        entry.data.set(source.subarray(offset + done,offset + done + n),skip); entry.dirty = true; done += n;
      }
      node.user.size = Math.max(node.user.size,position + done); touch(node); return done;
    },
    fsync() { return 0; }, // Whole-operation checkpoint owns publication.
    mmap() { errno(43); },
  };
  const rootValue = await store.node('root');
  const type = {mount() { root = make(null,rootValue); root.parent = root; return root; }};
  async function run(action) {
    if (closed || suspended) throw new Error('User filesystem is unavailable during save exchange');
    for (;;) { try { return action(); } catch (error) { if (!error.userIO) throw error; await error.promise; } }
  }
  async function flushDirty() { for (const entry of cache.values()) await flush(entry); }
  const backend = {
    type,run,get store() { return store; },get closed() { return closed; },get suspended() { return suspended; },prune,childEntries,
    stats:() => ({cacheBytes:bytes,cachedBlocks:cache.size,cachedNodes:nodes.size,dirtyNodes:dirty.size,loads,hits}),
    async prepareSettings() { await flushDirty(); await getJob(); },
    async restore() {
      if (job) await store.discard(job); job = null; jobPromise = null;
      for (const node of nodes.values()) if (node !== root) FS.destroyNode(node);
      nodes.clear(); nodes.set(root.user.id,root); root.user = await store.node('root');
      cache.clear(); bytes = 0; dirty.clear(); lookups.clear(); directories.clear();
    },
    async suspend() {
      if (closed || suspended || job || jobPromise || dirty.size) throw new Error('User filesystem is not ready for save exchange');
      // No cached inode may survive a library replacement. Open descriptors
      // would still point at the old tree, so refuse the handoff if any exist.
      if (FS.streams.some(stream => stream?.node.user)) throw new Error('A user file is still open');
      suspended = true;
      await store.close();
    },
    async resume() {
      if (closed || !suspended) throw new Error('User filesystem is not paused');
      const next = await openUserStore(options);
      store = next;
      try { await backend.restore(); suspended = false; }
      catch (error) { await next.close(); throw error; }
    },
    async checkpoint() {
      if (!dirty.size) return;
      await getJob(); await flushDirty();
      for (const node of dirty.values()) {
        const {mutable,truncated,...value} = node.user;
        if (!value.deleted && FS.isFile(value.mode)) {
          if (!value.content) value.content = await content(node);
          const info = await store.seal(value.content,value.size); value.crc = info.crc;
        }
        await store.stage(job,value);
      }
      await store.commit(job); job = null; jobPromise = null;
      for (const node of dirty.values()) { delete node.user.mutable; if (node.user.deleted) { nodes.delete(node.user.id); FS.destroyNode(node); } }
      dirty.clear(); directories.clear(); prune();
      await store.collect({limit:32}).catch(error => console.warn('User garbage cleanup deferred',error));
    },
    async close() { if (!closed) { closed = true; cache.clear(); bytes = 0; lookups.clear(); directories.clear(); await store.close(); } },
  };
  module.UserIO.backend = backend;
  return backend;
}
