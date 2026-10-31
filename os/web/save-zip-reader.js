import {BLOCK_SIZE,checkCancelled} from './storage-common.js';
import {pathInZip,ImportError} from './zip-import.js';
import {zipDirectory,verifyDirectory,zipLocalHeader} from './zip-directory.js';
import {crc32} from './zip-output.js';

// Pulls one decoded chunk at a time. Unlike zip.js ZipReaderStream this does
// not spool input into a Blob or build the entire central directory in RAM.
export async function* readSaveArchive(file,{signal,moduleFactory,catalog,onComparer} = {}) {
  if (!(file instanceof Blob) || !Number.isSafeInteger(file.size) || !file.size) throw new ImportError('invalid_zip','Choose a nonempty ZIP');
  let offset = 0, opened = false, pointer;
  const inputCache = [];
  if (!catalog) throw new Error('A disk ZIP catalog is required');
  const directory = await zipDirectory(file);
  const createArchive = moduleFactory || (await import('./fallout2-archive.js')).default;
  const module = await createArchive({input:async capacity => {
    checkCancelled(signal);
    const data = new Uint8Array(await file.slice(offset,offset + capacity).arrayBuffer());
    inputCache.push({at:offset,data}); if (inputCache.length > 2) inputCache.shift();
    offset += data.length; return data;
  }});
  const headerBytes = async (at,n) => {
    for (const item of inputCache) if (at >= item.at && at + n <= item.at + item.data.length) return item.data.subarray(at - item.at,at - item.at + n);
    return new Uint8Array(await file.slice(at,at + n).arrayBuffer());
  };
  const call = (name,...args) => module.ccall(name,'number',args.map(() => 'number'),args,{async:true});
  onComparer?.((made,now) => ({level:module.ccall('save_compare','number',['string','string'],[made,now]),
    changes:module.UTF8ToString(module._save_changes()).trim().split('\n').filter(Boolean).map(line => line.split('\t'))}));
  const failure = () => module.inputError || new ImportError('invalid_zip',module.UTF8ToString(module._zip_error()) || 'ZIP decoding failed');
  try {
    if (await call('zip_open') !== 0) throw failure(); opened = true;
    pointer = module._malloc(BLOCK_SIZE);
    if (!pointer) throw new Error('Archive decoder allocation failed');
    let count = 0;
    for (;;) {
      checkCancelled(signal); const next = await call('zip_next');
      if (next === 0) break; if (next < 0) throw failure();
      const path = await zipLocalHeader(file,module._zip_position(),headerBytes);
      if (++count > 2_000_000 || new TextEncoder().encode(path).length > 240 || path.split('/').length > 32) throw new ImportError('limit','Save archive metadata exceeds engine limits');
      if (module._zip_encrypted() || module._zip_link() || ![0o100000,0o040000].includes(module._zip_type())) throw new ImportError('unsupported_zip','Only regular unencrypted ZIP files and directories are supported');
      const size = module._zip_size();
      if (size !== -1 && (!Number.isSafeInteger(size) || size < 0)) throw new ImportError('invalid_zip','Invalid ZIP entry size');
      const localOffset = module._zip_position(), isDirectory = module._zip_type() === 0o040000;
      let consumed = false, finished = false;
      const chunks = async function* () {
        if (consumed) throw new Error('ZIP entry was already consumed'); consumed = true; let bytes = 0, crc = 0;
        for (;;) {
          checkCancelled(signal); const n = await call('zip_read',pointer,BLOCK_SIZE);
          if (n < 0) throw failure(); if (!n) break;
          bytes += n;
          if (!Number.isSafeInteger(bytes) || (size >= 0 && bytes > size)) throw new ImportError('invalid_zip','ZIP entry size mismatch');
          const chunk = module.HEAPU8.slice(pointer,pointer + n); crc = crc32(chunk,crc); yield chunk;
        }
        if (size >= 0 && size !== bytes) throw new ImportError('invalid_zip','ZIP entry size mismatch');
        try { await catalog.remember({path,size:bytes,crc,directory:isDirectory,offset:localOffset}); }
        catch (error) { if (error.name === 'ConstraintError') throw new ImportError('invalid_path','Duplicate ZIP filename'); throw error; }
        finished = true;
      };
      yield {path,size,directory:isDirectory,chunks};
      // Even ignored entries are fully read to verify their CRC. next_header's
      // fast skip would silently bypass that check for Store files.
      if (!consumed) for await (const _chunk of chunks()) { /* bounded discard */ }
      if (!finished) throw new ImportError('invalid_zip','ZIP entry was not fully verified');
    }
    await verifyDirectory(file,directory,catalog,{signal,localCount:count,localEnd:module._zip_consumed()});
  } finally { if (pointer) module._free(pointer); if (opened) module._zip_close(); }
}
