// Worker-only temporary export files. Never builds a Blob from byte arrays.
// getFile returns a disk-backed File; a successful click means handed to the
// browser, not that the user has finished saving a second copy in Files.
export const EXPORT_DIRECTORY = 'fallout2-export-v1';
export async function exportDirectory() {
  if (!globalThis.navigator?.storage?.getDirectory) throw new Error('OPFS is unavailable; use a browser with local file storage');
  return (await navigator.storage.getDirectory()).getDirectoryHandle(EXPORT_DIRECTORY,{create:true});
}
export async function temporaryExport({directory,now = Date.now()} = {}) {
  directory ||= await exportDirectory();
  await collectExports({directory,now});
  const id = now + '-' + crypto.randomUUID(), names = [id + '.zip',id + '.directory'];
  const handles = [], sinks = [];
  try {
    for (const name of names) {
      const handle = await directory.getFileHandle(name,{create:true}); handles.push(handle);
      if (!handle.createSyncAccessHandle) throw new Error('Worker OPFS file access is unavailable');
      const access = await handle.createSyncAccessHandle();
      try { access.truncate(0); } catch (error) { access.close(); throw error; }
      let position = 0, closed = false;
      sinks.push({get position() { return position; },
        async write(bytes) {
          if (closed) throw new Error('Export file is closed');
          const count = access.write(bytes,{at:position});
          if (count !== bytes.length) throw new Error('Export file write was incomplete');
          position += count;
        },
        async read(offset,length) {
          const bytes = new Uint8Array(length);
          if (access.read(bytes,{at:offset}) !== length) throw new Error('Export directory read was incomplete');
          return bytes;
        },
        async close() { if (!closed) { try { access.flush(); } finally { access.close(); closed = true; } } },
      });
    }
    return {output:sinks[0],directory:sinks[1],id,
      async file() { await sinks[0].close(); await sinks[1].close(); await directory.removeEntry(names[1]); return handles[0].getFile(); },
      async discard() { for (const sink of sinks) await sink.close().catch(() => {}); for (const name of names) await directory.removeEntry(name).catch(() => {}); },
    };
  } catch (error) {
    for (const sink of sinks) await sink.close().catch(() => {});
    for (const name of names) await directory.removeEntry(name).catch(() => {});
    throw error;
  }
}
// Explicit cleanup, never pagehide: a download/share may still be reading the
// File after our page closes. Call only while holding the application's lease.
export async function collectExports({directory,now = Date.now(),age = 7 * 86400000} = {}) {
  directory ||= await exportDirectory();
  for await (const [name] of directory.entries()) {
    const match = /^(\d+)-[a-f0-9-]+\.(zip|directory)$/.exec(name);
    if (match && Number(match[1]) < now - age) await directory.removeEntry(name);
  }
}
