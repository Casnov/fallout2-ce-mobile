// Shared bounded streaming primitives, independent of either database format.
export const BLOCK_SIZE = 256 * 1024;
export const MAX_READ = 2 * 1024 * 1024;
export const WRITE_BATCH_BYTES = 1024 * 1024;
export const WRITE_BATCH_BLOCKS = 64;
// The storage is held by another tab or window of the app (its writer lease,
// or an older connection blocking an upgrade).
export function busyError(message) {
  return Object.assign(new Error(message),{name:'StorageBusyError'});
}
export function checkCancelled(signal) {
  if (signal?.aborted) throw new DOMException('Cancelled','AbortError');
}
export async function digest(data) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)),
    x => x.toString(16).padStart(2, '0')).join('');
}
export function blockWriter(store, run, path, expectedSize, signal, onwrite = () => {}) {
  let pending = new Uint8Array(BLOCK_SIZE), used = 0, index = 0, bytes = 0, maxChunk = 0;
  const flush = async () => {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (used) { await store.block(run, path, index++, pending.subarray(0, used)); used = 0; }
  };
  return {
    stream:new WritableStream({
      async write(chunk) {
        if (bytes + chunk.length > expectedSize) throw new Error('ZIP entry exceeds declared size');
        maxChunk = Math.max(maxChunk, chunk.length);
        for (let start = 0; start < chunk.length;) {
          if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
          const count = Math.min(chunk.length - start, BLOCK_SIZE - used);
          pending.set(chunk.subarray(start, start + count), used);
          used += count; start += count; bytes += count;
          if (used === BLOCK_SIZE) await flush();
        }
        onwrite(bytes);
      },
      async close() {
        if (bytes !== expectedSize) throw new Error('ZIP entry size mismatch');
        await flush(); pending = null;
      },
      abort() { pending = null; },
    }, {highWaterMark:1}),
    stats:() => ({bytes, blocks:index, maxChunk}),
  };
}

// Blocks from small files share a bounded batch too. No generation can be
// activated until the owner flushes after every ZIP entry has passed CRC.
export function blockBatch(store, run, signal) {
  let pending = [], bytes = 0;
  const totals = {transactions:0,hashMs:0,writeMs:0,newBytes:0,reusedBytes:0,maxBufferedBytes:0,maxBufferedBlocks:0};
  async function flush() {
    checkCancelled(signal);
    if (!pending.length) return;
    const batch = pending; pending = []; bytes = 0;
    const result = await store.writeBlocks(run,batch,{signal});
    for (const key of ['transactions','hashMs','writeMs','newBytes','reusedBytes']) totals[key] += result[key] || 0;
  }
  return {
    async block(_run,path,index,data) {
      checkCancelled(signal);
      if (bytes + data.length > WRITE_BATCH_BYTES || pending.length === WRITE_BATCH_BLOCKS) await flush();
      pending.push({path,index,data:data.slice()}); bytes += data.length;
      totals.maxBufferedBytes = Math.max(totals.maxBufferedBytes,bytes);
      totals.maxBufferedBlocks = Math.max(totals.maxBufferedBlocks,pending.length);
      if (bytes === WRITE_BATCH_BYTES || pending.length === WRITE_BATCH_BLOCKS) await flush();
    },
    flush,
    discard() { pending = []; bytes = 0; },
    stats:() => ({...totals}),
  };
}

