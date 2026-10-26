// Bounded ZIP/ZIP64 structural validation (APPNOTE 6.3.10). libarchive decodes
// payloads sequentially; its streamable mode intentionally ignores the central
// directory. Validate it separately, one record at a time, against a disk
// catalog of the decoded local records. No allocation follows directory size.
import {checkCancelled} from './storage-common.js';
import {crc32} from './zip-output.js';
import {pathInZip,ImportError} from './zip-import.js';
const bad = message => { throw new ImportError('invalid_zip',message); };
const MAX32 = 0xffffffff;
const number64 = (view,at) => { const n = Number(view.getBigUint64(at,true)); if (!Number.isSafeInteger(n)) bad('ZIP64 number exceeds safe integer range'); return n; };
async function read(file,offset,n) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + n > file.size || n > 256 * 1024) bad('ZIP metadata read is outside the file');
  return new Uint8Array(await file.slice(offset,offset + n).arrayBuffer());
}
function decodePath(rawName,flags,extraBytes) {
  let path;
  try { path = new TextDecoder(flags & 0x800 ? 'utf-8' : 'ibm866',{fatal:true}).decode(rawName); } catch { bad('Invalid ZIP filename encoding'); }
  for (let at = 0; at < extraBytes.length;) {
    if (at + 4 > extraBytes.length) bad('Truncated ZIP extra field');
    const extra = new DataView(extraBytes.buffer,extraBytes.byteOffset + at), id = extra.getUint16(0,true), length = extra.getUint16(2,true);
    if (at + 4 + length > extraBytes.length) bad('Truncated ZIP extra field');
    if (id === 0x7075 && length >= 5 && extra.getUint8(4) === 1 && extra.getUint32(5,true) === crc32(rawName)) {
      try { path = new TextDecoder('utf-8',{fatal:true}).decode(extraBytes.subarray(at + 9,at + 4 + length)); } catch { bad('Invalid Unicode ZIP path'); }
    }
    at += 4 + length;
  }
  return pathInZip(path);
}
export async function zipLocalHeader(file,offset,readBytes = (at,n) => read(file,at,n)) {
  const fixed = await readBytes(offset,30), view = new DataView(fixed.buffer,fixed.byteOffset,fixed.byteLength);
  if (view.getUint32(0,true) !== 0x04034b50) bad('Invalid ZIP local record');
  const flags = view.getUint16(6,true), method = view.getUint16(8,true), nameSize = view.getUint16(26,true), extraSize = view.getUint16(28,true);
  if (flags & (1 | 0x40 | 0x2000) || ![0,8].includes(method)) bad('Unsupported or encrypted ZIP local record');
  const variable = await readBytes(offset + 30,nameSize + extraSize);
  return decodePath(variable.subarray(0,nameSize),flags,variable.subarray(nameSize));
}
export async function zipDirectory(file) {
  const tailOffset = Math.max(0,file.size - 65557), tail = await read(file,tailOffset,file.size - tailOffset), v = new DataView(tail.buffer);
  let end = -1;
  for (let at = tail.length - 22; at >= 0; at--) if (v.getUint32(at,true) === 0x06054b50 && at + 22 + v.getUint16(at + 20,true) === tail.length) { end = at; break; }
  if (end < 0) bad('Missing ZIP end record');
  if (v.getUint16(end + 4,true) || v.getUint16(end + 6,true) || v.getUint16(end + 8,true) !== v.getUint16(end + 10,true)) bad('Split ZIP is not supported');
  let count = v.getUint16(end + 10,true), size = v.getUint32(end + 12,true), offset = v.getUint32(end + 16,true), boundary = tailOffset + end;
  if (count === 0xffff || size === MAX32 || offset === MAX32) {
    const locator = new DataView((await read(file,boundary - 20,20)).buffer);
    if (locator.getUint32(0,true) !== 0x07064b50 || locator.getUint32(4,true) || locator.getUint32(16,true) !== 1) bad('Invalid ZIP64 locator');
    const position = number64(locator,8), record = new DataView((await read(file,position,56)).buffer);
    if (record.getUint32(0,true) !== 0x06064b50 || record.getUint32(16,true) || record.getUint32(20,true) || number64(record,24) !== number64(record,32) || position + 12 + number64(record,4) !== boundary - 20) bad('Invalid ZIP64 end record');
    count = number64(record,32); size = number64(record,40); offset = number64(record,48); boundary = position;
  }
  if (!count || count > 2_000_000 || offset + size !== boundary || size < count * 46) bad('Invalid ZIP central directory bounds');
  return {count,size,offset};
}
export async function verifyDirectory(file,plan,catalog,{signal,localCount,localEnd} = {}) {
  if (localCount !== plan.count || localEnd !== plan.offset) bad('ZIP local directory is incomplete or has extra entries');
  let position = plan.offset;
  for (let i = 0; i < plan.count; i++) {
    checkCancelled(signal);
    const fixed = await read(file,position,46), v = new DataView(fixed.buffer);
    if (v.getUint32(0,true) !== 0x02014b50) bad('Invalid ZIP central entry');
    const flags = v.getUint16(8,true), method = v.getUint16(10,true), nameSize = v.getUint16(28,true), extraSize = v.getUint16(30,true), commentSize = v.getUint16(32,true);
    if (flags & (1 | 0x40 | 0x2000) || ![0,8].includes(method) || v.getUint16(34,true)) bad('Unsupported or encrypted ZIP entry');
    const variable = await read(file,position + 46,nameSize + extraSize), rawName = variable.subarray(0,nameSize);
    const path = decodePath(rawName,flags,variable.subarray(nameSize));
    let size = v.getUint32(24,true), compressed = v.getUint32(20,true), offset = v.getUint32(42,true), zip64 = false;
    for (let at = nameSize; at < variable.length;) {
      if (at + 4 > variable.length) bad('Truncated ZIP extra field');
      const extra = new DataView(variable.buffer,variable.byteOffset + at), id = extra.getUint16(0,true), length = extra.getUint16(2,true);
      if (at + 4 + length > variable.length) bad('Truncated ZIP extra field');
      if (id === 1) {
        if (zip64) bad('Duplicate ZIP64 extra field'); zip64 = true;
        let n = 4;
        for (const key of ['size','compressed','offset']) {
          const value = key === 'size' ? size : key === 'compressed' ? compressed : offset;
          if (value !== MAX32) continue;
          if (n + 8 > length + 4) bad('Truncated ZIP64 size');
          const parsed = number64(extra,n); n += 8;
          if (key === 'size') size = parsed; else if (key === 'compressed') compressed = parsed; else offset = parsed;
        }
      }
      at += 4 + length;
    }
    if ([size,compressed,offset].includes(MAX32) && !zip64) bad('Missing ZIP64 sizes');
    const type = (v.getUint32(38,true) >>> 16) & 0o170000, directory = path.endsWith('/');
    if (![0,0o040000,0o100000].includes(type) || (type === 0o040000 && !directory) || offset >= plan.offset || offset + 30 + nameSize + compressed > plan.offset || (directory && size)) bad('Invalid ZIP entry layout/type');
    await catalog.verify({path,size,crc:v.getUint32(16,true),directory,offset});
    position += 46 + nameSize + extraSize + commentSize;
    if (position > plan.offset + plan.size) bad('ZIP directory entry exceeds bounds');
  }
  if (position !== plan.offset + plan.size) bad('ZIP central directory size mismatch');
}
