// Browser filesystem: game files read in bounded blocks through a range reader.
//
// The backend owns the game's files (local storage or the development server); a file
// of the game is a MEMFS node with its size whose bytes come in blocks, read
// when the engine reads them and kept in a small cache. A read whose blocks
// aren't cached waits for them through Asyncify (fd_read is async), the
// engine doesn't notice.
//
// GameFS.createFile(path, size, reader): reader(offset, length) is a promise
// of a Uint8Array of those bytes.
// GameFS.stats(): cache and read counters.

addToLibrary({
  $GameFS__deps: ['$FS', '$MEMFS'],
  $GameFS__postset: 'Module["GameFS"] = GameFS;',
  $GameFS: {
    blockSize: 256 * 1024,
    cacheLimit: 64 * 1024 * 1024,
    cacheBytes: 0,
    // Cached blocks, least recently used first: key -> {node, index, data}.
    cache: new Map(),
    counters: { reads: 0, waits: 0, blocksLoaded: 0, bytesLoaded: 0, waitMs: 0 },
    nextId: 1,

    createFile(path, size, reader) {
      const node = FS.mknod(path, 0o100444 | 0o200, 0);
      node.lazy = { id: GameFS.nextId++, size, reader };
      node.usedBytes = size;
      node.contents = null;
      node.stream_ops = GameFS.streamOps;
      node.node_ops = GameFS.nodeOps;
      return node;
    },

    key(node, index) {
      return node.lazy.id + ':' + index;
    },

    // Block indices of [position, position + length) not in the cache.
    missing(node, position, length) {
      const size = node.lazy.size;
      const end = Math.min(size, position + length);
      const result = [];
      for (let index = Math.floor(position / GameFS.blockSize); index * GameFS.blockSize < end; index++) {
        if (!GameFS.cache.has(GameFS.key(node, index))) {
          result.push(index);
        }
      }
      return result;
    },

    load: async function (node, indices) {
      const started = performance.now();
      GameFS.counters.waits++;
      const lazy = node.lazy;
      const blocks = await Promise.all(indices.map(async (index) => {
        const offset = index * GameFS.blockSize;
        const length = Math.min(GameFS.blockSize, lazy.size - offset);
        const data = await lazy.reader(offset, length);
        if (!(data instanceof Uint8Array) || data.length !== length) {
          throw new FS.ErrnoError({{{ cDefs.EIO }}});
        }
        return data;
      }));
      // The file may have been replaced meanwhile.
      if (node.lazy !== lazy) {
        throw new FS.ErrnoError({{{ cDefs.EIO }}});
      }
      indices.forEach((index, i) => GameFS.put(node, index, blocks[i]));
      GameFS.counters.waitMs += performance.now() - started;
    },

    put(node, index, data) {
      const key = GameFS.key(node, index);
      const previous = GameFS.cache.get(key);
      if (previous) GameFS.cacheBytes -= previous.data.length;
      GameFS.cache.delete(key);
      GameFS.cache.set(key, { node, index, data });
      GameFS.cacheBytes += data.length;
      GameFS.counters.blocksLoaded++;
      GameFS.counters.bytesLoaded += data.length;
      for (const [oldKey, entry] of GameFS.cache) {
        if (GameFS.cacheBytes <= GameFS.cacheLimit || oldKey === key) {
          break;
        }
        GameFS.cache.delete(oldKey);
        GameFS.cacheBytes -= entry.data.length;
      }
    },

    get(node, index) {
      const key = GameFS.key(node, index);
      const entry = GameFS.cache.get(key);
      if (entry === undefined) {
        return null;
      }
      // Most recently used last.
      GameFS.cache.delete(key);
      GameFS.cache.set(key, entry);
      return entry.data;
    },

    // The file stops being lazy: an empty ordinary MEMFS file.
    materialize(node) {
      for (const [key, entry] of GameFS.cache) {
        if (entry.node === node) {
          GameFS.cache.delete(key);
          GameFS.cacheBytes -= entry.data.length;
        }
      }
      node.lazy = null;
      node.contents = null;
      node.usedBytes = 0;
      node.stream_ops = MEMFS.ops_table.file.stream;
      node.node_ops = MEMFS.ops_table.file.node;
    },

    stats() {
      return Object.assign({ cacheBytes: GameFS.cacheBytes, cachedBlocks: GameFS.cache.size }, GameFS.counters);
    },

    nodeOps: {
      getattr(node) {
        return MEMFS.node_ops.getattr(node);
      },
      setattr(node, attr) {
        if (attr.size !== undefined && node.lazy) {
          if (attr.size !== 0) {
            throw new FS.ErrnoError({{{ cDefs.EIO }}});
          }
          GameFS.materialize(node);
        }
        const size = attr.size;
        delete attr.size;
        MEMFS.node_ops.setattr(node, attr);
        if (size !== undefined) {
          attr.size = size;
        }
      },
    },

    streamOps: {
      llseek(stream, offset, whence) {
        return MEMFS.stream_ops.llseek(stream, offset, whence);
      },
      read(stream, buffer, offset, length, position) {
        const node = stream.node;
        if (!node.lazy) {
          return MEMFS.stream_ops.read(stream, buffer, offset, length, position);
        }
        const size = node.lazy.size;
        if (position >= size) {
          return 0;
        }
        const count = Math.min(size - position, length);
        let done = 0;
        while (done < count) {
          const at = position + done;
          const index = Math.floor(at / GameFS.blockSize);
          const block = GameFS.get(node, index);
          if (block === null) {
            console.error('GameFS: a read without its block', node.name, at);
            throw new FS.ErrnoError({{{ cDefs.EIO }}});
          }
          const from = at - index * GameFS.blockSize;
          const take = Math.min(count - done, block.length - from);
          if (take <= 0) throw new FS.ErrnoError({{{ cDefs.EIO }}});
          buffer.set(block.subarray(from, from + take), offset + done);
          done += take;
        }
        GameFS.counters.reads++;
        return count;
      },
      write(stream, buffer, offset, length, position, canOwn) {
        if (stream.node.lazy) {
          console.error('GameFS: a write into a game file', stream.node.name);
          throw new FS.ErrnoError({{{ cDefs.EACCES }}});
        }
        return MEMFS.stream_ops.write(stream, buffer, offset, length, position, canOwn);
      },
      mmap() {
        throw new FS.ErrnoError({{{ cDefs.ENODEV }}});
      },
    },
  },

  // The engine's reads: a lazy file's missing blocks are waited for.
  fd_read__deps: ['$doReadv', '$GameFS', '$SYSCALLS'],
  fd_read__async: true,
  fd_read: (fd, iov, iovcnt, pnum) => {
    const finish = (stream) => {
      const num = doReadv(stream, iov, iovcnt);
      {{{ makeSetValue('pnum', 0, 'num', SIZE_TYPE) }}};
      return 0;
    };
    const errno = (e) => {
      if (typeof FS == 'undefined' || !(e.name === 'ErrnoError')) throw e;
      return e.errno;
    };

    // Waking up after a wait: the result is the wait's.
    if (Asyncify.state !== Asyncify.State.Normal) {
      return Asyncify.handleSleep(() => {});
    }

    try {
      const stream = SYSCALLS.getStreamFromFD(fd);
      const node = stream.node;
      if (node.lazy) {
        let length = 0;
        for (let i = 0; i < iovcnt; i++) {
          length += {{{ makeGetValue('iov', `i * ${C_STRUCTS.iovec.__size__} + ${C_STRUCTS.iovec.iov_len}`, '*') }}};
        }
        const missing = GameFS.missing(node, stream.position, length);
        if (missing.length !== 0) {
          return Asyncify.handleAsync(async () => {
            let total = 0;
            try {
              // A single fread can be larger than the cache. Copy each block
              // into the caller's WASM buffer before loading/evicting the next
              // one, rather than fetching the entire read into JS at once.
              for (let i = 0; i < iovcnt; i++) {
                const pointer = {{{ makeGetValue('iov', `i * ${C_STRUCTS.iovec.__size__} + ${C_STRUCTS.iovec.iov_base}`, '*') }}};
                const length = {{{ makeGetValue('iov', `i * ${C_STRUCTS.iovec.__size__} + ${C_STRUCTS.iovec.iov_len}`, '*') }}};
                let copied = 0;
                while (copied < length && stream.position < node.lazy.size) {
                  const index = Math.floor(stream.position / GameFS.blockSize);
                  if (!GameFS.cache.has(GameFS.key(node,index))) await GameFS.load(node,[index]);
                  const count = Math.min(length - copied,
                    GameFS.blockSize - stream.position % GameFS.blockSize,
                    node.lazy.size - stream.position);
                  const read = GameFS.streamOps.read(stream,HEAPU8,pointer + copied,count,stream.position);
                  stream.position += read; copied += read; total += read;
                }
              }
              {{{ makeSetValue('pnum', 0, 'total', SIZE_TYPE) }}};
              return 0;
            } catch (e) {
              // Preserve a valid partial read; never substitute zero-filled
              // bytes for a missing, damaged or unavailable local block.
              if (total) { {{{ makeSetValue('pnum', 0, 'total', SIZE_TYPE) }}}; return 0; }
              if (e && e.name === 'ErrnoError') return e.errno;
              console.error('GameFS: reading', node.name, e);
              return {{{ cDefs.EIO }}};
            }
          });
        }
      }
      return finish(stream);
    } catch (e) {
      return errno(e);
    }
  },
});
