// ZIP Store / ZIP64, APPNOTE 6.3.10. Contents AND the central directory are
// streamed to separate sinks. Store with a known CRC avoids data descriptors,
// including the Store+descriptor combination rejected by Android's reader.
// There is deliberately no ZIP parser here; imports use a maintained decoder.
import {BLOCK_SIZE, checkCancelled} from './storage-common.js';

const MAX32 = 0xffffffff, MAX16 = 0xffff, utf8 = new TextEncoder();
const table = Uint32Array.from({length:256},(_,n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(bytes, crc = 0) {
  crc ^= MAX32;
  for (const value of bytes) crc = table[(crc ^ value) & 255] ^ (crc >>> 8);
  return (crc ^ MAX32) >>> 0;
}
function integer(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('ZIP size/offset is not a safe integer');
  return value;
}
function buffer(size) {
  const data = new Uint8Array(size), view = new DataView(data.buffer);
  return {data,u16:(at,n) => view.setUint16(at,n,true),u32:(at,n) => view.setUint32(at,n,true),
    u64:(at,n) => view.setBigUint64(at,BigInt(integer(n)),true)};
}
function dateFields(date) {
  const d = new Date(date || Date.UTC(1980,0,1));
  if (!Number.isFinite(+d)) throw new Error('Invalid ZIP date');
  const year = Math.min(2107,Math.max(1980,d.getFullYear()));
  return [(d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >>> 1),
    ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()];
}
export async function checksum(source,{signal,progress = () => {}} = {}) {
  let crc = 0;
  integer(source.size);
  for (let offset = 0; offset < source.size;) {
    checkCancelled(signal);
    const bytes = await source.read(offset,Math.min(BLOCK_SIZE,source.size - offset));
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > Math.min(BLOCK_SIZE,source.size - offset)) throw new Error('Short ZIP source read');
    offset += bytes.length; crc = crc32(bytes,crc); progress(offset);
  }
  return crc;
}

export class ZipOutput {
  // sinks: write(Uint8Array), position, close(); directory also read(offset,n).
  constructor(output,directory,{signal,progress = () => {}} = {}) {
    this.output = output; this.directory = directory; this.signal = signal;
    this.progress = progress; this.count = 0; this.closed = false; this.failed = false;
    this.yieldAt = performance.now();
  }
  async pause() {
    if (performance.now() - this.yieldAt < 32) return;
    // OPFS SyncAccessHandle and a synthetic source can otherwise keep resolving
    // microtasks forever: the worker would never receive its Cancel message.
    await new Promise(resolve => setTimeout(resolve,0)); this.yieldAt = performance.now();
    checkCancelled(this.signal);
  }
  async add(name,source,{crc,date} = {}) {
    if (this.closed || this.failed) throw new Error('ZIP writer is no longer writable');
    try {
      checkCancelled(this.signal);
      await this.pause();
      const path = utf8.encode(name);
      if (!path.length || path.length > MAX16 || name.includes('\0') || name.endsWith('/')) throw new Error('Invalid ZIP output path');
      const size = integer(source.size), offset = integer(this.output.position);
      crc ??= await checksum(source,{signal:this.signal});
      if (!Number.isInteger(crc) || crc < 0 || crc > MAX32) throw new Error('Invalid ZIP CRC');
      const large = size >= MAX32, far = offset >= MAX32, [time,day] = dateFields(date);
      const local = buffer(30 + path.length + (large ? 20 : 0));
      local.u32(0,0x04034b50); local.u16(4,large ? 45 : 20); local.u16(6,0x800);
      local.u16(10,time); local.u16(12,day); local.u32(14,crc);
      local.u32(18,large ? MAX32 : size); local.u32(22,large ? MAX32 : size);
      local.u16(26,path.length); local.u16(28,large ? 20 : 0); local.data.set(path,30);
      if (large) { const at = 30 + path.length; local.u16(at,1); local.u16(at + 2,16); local.u64(at + 4,size); local.u64(at + 12,size); }
      await this.output.write(local.data);
      for (let at = 0; at < size;) {
        checkCancelled(this.signal);
        const wanted = Math.min(BLOCK_SIZE,size - at), bytes = await source.read(at,wanted);
        if (!(bytes instanceof Uint8Array) || bytes.length !== wanted) throw new Error('Short ZIP source read');
        await this.output.write(bytes); at += wanted; this.progress({files:this.count,bytes:this.output.position}); await this.pause();
      }
      const extra = (large ? 16 : 0) + (far ? 8 : 0), central = buffer(46 + path.length + (extra ? extra + 4 : 0));
      central.u32(0,0x02014b50); central.u16(4,0x033f); central.u16(6,large || far ? 45 : 20);
      central.u16(8,0x800); central.u16(12,time); central.u16(14,day); central.u32(16,crc);
      central.u32(20,large ? MAX32 : size); central.u32(24,large ? MAX32 : size);
      central.u16(28,path.length); central.u16(30,extra ? extra + 4 : 0);
      central.u32(38,0o100644 << 16); central.u32(42,far ? MAX32 : offset); central.data.set(path,46);
      if (extra) {
        let at = 46 + path.length; central.u16(at,1); central.u16(at + 2,extra); at += 4;
        if (large) { central.u64(at,size); central.u64(at + 8,size); at += 16; }
        if (far) central.u64(at,offset);
      }
      await this.directory.write(central.data); this.count++;
    } catch (error) { this.failed = true; throw error; }
  }
  async close() {
    if (this.closed || this.failed) throw new Error('ZIP writer is no longer writable');
    this.closed = true;
    try {
      checkCancelled(this.signal);
      const start = integer(this.output.position), length = integer(this.directory.position);
      for (let offset = 0; offset < length; offset += BLOCK_SIZE) {
        checkCancelled(this.signal);
        await this.output.write(await this.directory.read(offset,Math.min(BLOCK_SIZE,length - offset)));
        await this.pause();
      }
      if (this.count >= MAX16 || start >= MAX32 || length >= MAX32) {
        const position = this.output.position, end = buffer(56), locator = buffer(20);
        end.u32(0,0x06064b50); end.u64(4,44); end.u16(12,45); end.u16(14,45);
        end.u64(24,this.count); end.u64(32,this.count); end.u64(40,length); end.u64(48,start);
        locator.u32(0,0x07064b50); locator.u64(8,position); locator.u32(16,1);
        await this.output.write(end.data); await this.output.write(locator.data);
      }
      const end = buffer(22); end.u32(0,0x06054b50);
      end.u16(8,Math.min(MAX16,this.count)); end.u16(10,Math.min(MAX16,this.count));
      end.u32(12,Math.min(MAX32,length)); end.u32(16,Math.min(MAX32,start));
      await this.output.write(end.data); await this.output.close(); await this.directory.close();
      return {bytes:this.output.position,files:this.count};
    } catch (error) { this.failed = true; throw error; }
  }
}
