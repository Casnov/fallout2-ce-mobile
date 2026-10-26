// Legacy stage-2 format, retained for migration fixtures only. Production uses resource-store.js.
import {BLOCK_SIZE, MAX_READ, digest} from './storage-common.js';
export {BLOCK_SIZE, MAX_READ, digest, blockWriter} from './storage-common.js';
export const PROBE_DB = 'fallout2-device-check-v1';
const result = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const completed = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onabort = () => reject(transaction.error || new Error('Storage transaction aborted'));
  transaction.onerror = () => {}; // onabort owns the final failure.
});
export async function openProbeStore(name = PROBE_DB) {
  const request = indexedDB.open(name, 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('meta');
    const blocks = request.result.createObjectStore('blocks', {keyPath:['run','path','index']});
    blocks.createIndex('run', 'run');
  };
  const db = await result(request);
  db.onversionchange = () => db.close();
  const put = async (store, value, key) => {
    const tx = db.transaction(store, 'readwrite'), done = completed(tx);
    tx.objectStore(store).put(value, key);
    await done;
  };
  const get = async (store, key) => {
    const tx = db.transaction(store), done = completed(tx);
    const [value] = await Promise.all([result(tx.objectStore(store).get(key)), done]);
    return value;
  };
  return {
    close:() => db.close(),
    active:() => get('meta', 'active'),
    async recover() {
      const tx = db.transaction('meta'), done = completed(tx);
      const [runs] = await Promise.all([result(tx.objectStore('meta').getAll()),done]);
      for (const item of runs) if (item?.state === 'writing') await this.discard(item.run);
    },
    async begin() {
      const run = crypto.randomUUID();
      await put('meta', {run, state:'writing', created:Date.now()}, 'run:' + run);
      return run;
    },
    async block(run, path, index, data) {
      if (!data.length || data.length > BLOCK_SIZE) throw new Error('Invalid storage block');
      const copy = data.slice();
      await put('blocks', {run, path, index, data:copy, hash:await digest(copy)});
    },
    async activate(run, files, measurements) {
      const manifest = {schema:1, run, state:'complete', files, measurements, completed:Date.now()};
      const tx = db.transaction('meta', 'readwrite'), done = completed(tx);
      tx.objectStore('meta').put(manifest, 'run:' + run);
      tx.objectStore('meta').put(manifest, 'active');
      await done;
      return manifest;
    },
    async discard(run) {
      const tx = db.transaction(['meta','blocks'], 'readwrite'), done = completed(tx);
      tx.objectStore('meta').delete('run:' + run);
      const cursor = tx.objectStore('blocks').index('run').openKeyCursor(IDBKeyRange.only(run));
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (item) { tx.objectStore('blocks').delete(item.primaryKey); item.continue(); }
      };
      await done;
    },
    async clear() {
      const tx = db.transaction(['meta','blocks'], 'readwrite'), done = completed(tx);
      tx.objectStore('meta').clear(); tx.objectStore('blocks').clear();
      await done;
    },
    async read(manifest, file, offset, length) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
        || length > MAX_READ || offset + length > file.size) throw new Error('Invalid local read range');
      const output = new Uint8Array(length);
      if (!length) return output;
      const tx = db.transaction('blocks'), done = completed(tx), pending = [];
      const first = Math.floor(offset / BLOCK_SIZE), last = Math.floor((offset + length - 1) / BLOCK_SIZE);
      for (let i = first; i <= last; i++) pending.push(result(tx.objectStore('blocks').get([manifest.run,file.path,i])));
      const [blocks] = await Promise.all([Promise.all(pending), done]);
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const expected = Math.min(BLOCK_SIZE, file.size - (first + i) * BLOCK_SIZE);
        if (!block || block.data.length !== expected || await digest(block.data) !== block.hash) {
          throw new Error('Missing or damaged local block: ' + file.path);
        }
        const start = Math.max(offset, (first + i) * BLOCK_SIZE);
        const end = Math.min(offset + length, (first + i + 1) * BLOCK_SIZE);
        output.set(block.data.subarray(start - (first + i) * BLOCK_SIZE, end - (first + i) * BLOCK_SIZE), start - offset);
      }
      return output;
    },
  };
}

