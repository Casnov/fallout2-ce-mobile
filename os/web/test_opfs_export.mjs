import test from 'node:test';
import assert from 'node:assert/strict';
import {temporaryExport,collectExports} from './opfs-export.js';
function directory({failTruncate = false,quota = Infinity} = {}) {
  const files = new Map(), open = new Set(); let next = 0;
  return {files,open,
    async *entries() { for (const [name,file] of files) yield [name,file]; },
    async getFileHandle(name) {
      if (!files.has(name)) files.set(name,new Uint8Array());
      return {
        async getFile() { return new Blob([files.get(name)]); },
        async createSyncAccessHandle() {
          const id = ++next; open.add(id); let closed = false;
          return {
            truncate() { if (failTruncate) throw new Error('truncate failed'); files.set(name,new Uint8Array()); },
            write(bytes,{at}) {
              if (closed) throw new Error('closed'); if (at + bytes.length > quota) throw new DOMException('quota','QuotaExceededError');
              const old = files.get(name), data = new Uint8Array(Math.max(old.length,at + bytes.length)); data.set(old); data.set(bytes,at); files.set(name,data); return bytes.length;
            },
            read(target,{at}) { const data = files.get(name).subarray(at,at + target.length); target.set(data); return data.length; },
            flush() {}, close() { closed = true; open.delete(id); },
          };
        },
      };
    },
    async removeEntry(name) { files.delete(name); },
  };
}
test('OPFS completion closes both handles and keeps the completed ZIP; TTL ignores recent and unrelated files',async () => {
  const dir = directory(), now = Date.now();
  dir.files.set((now - 8 * 86400000) + '-abcdef.zip',new Uint8Array());
  dir.files.set(now + '-abcdef.zip',new Uint8Array()); dir.files.set('player-saves.zip',new Uint8Array());
  const temporary = await temporaryExport({directory:dir,now});
  await temporary.output.write(Uint8Array.of(1,2,3)); await temporary.directory.write(Uint8Array.of(4));
  const file = await temporary.file(); assert.deepEqual(new Uint8Array(await file.arrayBuffer()),Uint8Array.of(1,2,3));
  assert.equal(dir.open.size,0); assert.equal(dir.files.has((now - 8 * 86400000) + '-abcdef.zip'),false);
  assert.ok(dir.files.has(now + '-abcdef.zip')); assert.ok(dir.files.has('player-saves.zip'));
  assert.ok(dir.files.has(temporary.id + '.zip')); assert.equal(dir.files.has(temporary.id + '.directory'),false);
});
test('OPFS truncate failure closes the just-opened handle; quota/cancel cleanup removes incomplete files',async () => {
  const broken = directory({failTruncate:true});
  await assert.rejects(temporaryExport({directory:broken}),/truncate failed/); assert.equal(broken.open.size,0); assert.equal(broken.files.size,0);
  const small = directory({quota:2}), temporary = await temporaryExport({directory:small});
  await assert.rejects(temporary.output.write(Uint8Array.of(1,2,3)),e => e.name === 'QuotaExceededError');
  await temporary.discard(); assert.equal(small.open.size,0); assert.equal(small.files.size,0);
});
