// Historical format-2 adapter, retained as a migration reference, not shipped.
// The IDBFS disk layout, with whole-operation atomic checkpoints. In
// Emscripten/Asyncify, fd_sync invokes mount.type.syncfs even for an unfinished
// SaveCatalog transaction. Deliberately expose only mount here; the owner calls
// checkpoint explicitly after the entire slot/catalog/records operation.
export function userFilesystem(FS) {
  const base = FS.filesystems.IDBFS;
  if (!base) throw new Error('Persistent user filesystem is not available');
  let root, baseline = new Map(), serial = 0, closed = false, writing = null;
  const versions = new WeakMap();
  const mark = node => versions.set(node,++serial);
  function attach(node) {
    mark(node);
    const original = node.node_ops;
    node.node_ops = {...original};
    if (original.mknod) node.node_ops.mknod = (parent,...args) => {
      const child = original.mknod(parent,...args); attach(child); mark(parent); return child;
    };
    for (const op of ['setattr','unlink','rmdir','rename','symlink']) {
      if (!original[op]) continue;
      node.node_ops[op] = (...args) => {
        const result = original[op](...args);
        mark(args[0]);
        if (op === 'rename') mark(args[1]);
        return result;
      };
    }
    if (node.stream_ops) {
      const stream = node.stream_ops;
      node.stream_ops = {...stream};
      for (const op of ['write','allocate','msync']) if (stream[op]) {
        node.stream_ops[op] = (...args) => { const result = stream[op](...args); mark(args[0].node); return result; };
      }
    }
  }
  const type = {mount(mount) { root = base.mount(mount); attach(root); return root; }};
  function inventory() {
    const entries = new Map();
    function walk(path) {
      for (const name of FS.readdir(path)) {
        if (name === '.' || name === '..') continue;
        const file = path + '/' + name, node = FS.lookupPath(file,{follow:false}).node;
        const stat = FS.lstat(file);
        if (!FS.isDir(stat.mode) && !FS.isFile(stat.mode)) throw new Error('Unsupported user file: ' + file);
        entries.set(file,{node,version:versions.get(node),mode:stat.mode,time:stat.mtime.getTime()});
        if (FS.isDir(stat.mode)) walk(file);
      }
    }
    walk(root.mount.mountpoint);
    return entries;
  }
  const getDB = () => new Promise((resolve,reject) => base.getDB(root.mount.mountpoint,(error,db) => {
    if (closed) {
      db?.close(); delete base.dbs[root.mount.mountpoint];
      reject(new Error('User filesystem is closed')); return;
    }
    error ? reject(error) : resolve(db);
  }));
  return {
    type,
    get closed() { return closed; },
    close() {
      closed = true;
      try { writing?.abort(); } catch { /* Already completed or aborted. */ }
      const name = root.mount.mountpoint;
      base.dbs[name]?.close(); delete base.dbs[name];
    },
    async restore() {
      if (closed) throw new Error('User filesystem is closed');
      await new Promise((resolve,reject) => base.syncfs(root.mount,true,error => error ? reject(error) : resolve()));
      if (closed) {
        base.dbs[root.mount.mountpoint]?.close(); delete base.dbs[root.mount.mountpoint];
        throw new Error('User filesystem is closed');
      }
      baseline = inventory();
    },
    async checkpoint() {
      if (closed) throw new Error('User filesystem is closed');
      const entries = inventory(), changed = [], removed = [];
      for (const [path,value] of entries) {
        const before = baseline.get(path);
        // Inode identity and revisions catch equal-millisecond writes/renames;
        // a timestamp-only diff silently loses rapid config/quick-save writes.
        if (!before || before.node !== value.node || before.version !== value.version
            || before.mode !== value.mode || before.time !== value.time) changed.push(path);
      }
      for (const path of baseline.keys()) if (!entries.has(path)) removed.push(path);
      if (!changed.length && !removed.length) return;
      const db = await getDB();
      if (closed) throw new Error('User filesystem is closed');
      await new Promise((resolve,reject) => {
        let tx, failure;
        try { tx = db.transaction([base.DB_STORE_NAME],'readwrite',{durability:'strict'}); }
        catch (error) { reject(error); return; }
        const store = tx.objectStore(base.DB_STORE_NAME);
        writing = tx;
        const abort = error => {
          failure ||= error || new Error('User storage write aborted');
          try { tx.abort(); } catch { /* The original abort owns completion. */ }
        };
        tx.onabort = () => { writing = null; reject(failure || tx.error || new Error('User storage write aborted')); };
        tx.onerror = event => { event.preventDefault(); abort(event.target.error); };
        tx.oncomplete = () => { writing = null; baseline = entries; resolve(); };
        try {
          // Clone one changed file at a time, not all saves into a JS snapshot.
          // The engine is paused at the explicit Asyncify checkpoint.
          for (const path of changed.sort()) {
            const item = entries.get(path), entry = {timestamp:new Date(item.time),mode:item.mode};
            if (FS.isFile(item.mode)) entry.contents = FS.readFile(path);
            const pending = store.put(entry,path);
            pending.onerror = event => { event.preventDefault(); abort(pending.error); };
          }
          for (const path of removed.sort().reverse()) {
            const pending = store.delete(path);
            pending.onerror = event => { event.preventDefault(); abort(pending.error); };
          }
        } catch (error) { abort(error); }
      });
    },
  };
}
