import {temporaryExport} from './opfs-export.js';
import {ZipOutput,zeroCrc,crc32,repeatCrc} from './zip-output.js';
import {BLOCK_SIZE,checkCancelled} from './storage-common.js';
let controller;
const directory = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('fallout2-isolated-zip-probe-v1',{create:true});
self.onmessage = async ({data}) => {
  if (data.type === 'cancel') { controller?.abort(); return; }
  if (controller) return;
  controller = new AbortController(); let temp;
  try {
    if (data.type === 'clear') {
      const dir = await directory(); for await (const [name] of dir.entries()) await dir.removeEntry(name);
      self.postMessage({type:'cleared'}); return;
    }
    if (data.type === 'check') {
      const file = data.file, tail = new DataView(await file.slice(-22).arrayBuffer());
      const first = new DataView(await file.slice(0,30).arrayBuffer());
      const valid = first.byteLength === 30 && first.getUint32(0,true) === 0x04034b50 && tail.byteLength === 22 && tail.getUint32(0,true) === 0x06054b50;
      self.postMessage({type:'checked',size:file.size,zipStructure:valid,over4GiB:file.size > 2 ** 32,
        matchesExpected:file.size === data.expectedBytes}); return;
    }
    const size = 2 ** 32 + 16 * 1024 ** 2, count = data.type === 'many' ? 70000 : 1;
    const space = await navigator.storage.estimate();
    if (count === 1 && space.quota - space.usage < size * 1.1) throw new DOMException('Для тестового ZIP недостаточно места в хранилище сайта','QuotaExceededError');
    temp = await temporaryExport({directory:await directory()});
    let last = 0;
    const writer = new ZipOutput(temp.output,temp.directory,{signal:controller.signal,progress:value => {
      if (performance.now() - last > 200) { last = performance.now(); self.postMessage({type:'progress',...value,total:count === 1 ? size : count}); }
    }});
    const zeros = new Uint8Array(BLOCK_SIZE), started = performance.now();
    if (count === 1) {
      // Random data repeated outside Deflate's 32KiB window. Store output is
      // really >4GiB; zero pages or a tiny compressed ZIP cannot mask the
      // browser's RAM/file handoff behaviour. CRC combination avoids a 4GiB
      // prepass or another 4GiB temporary raw file on the borrowed phone.
      for (let at = 0; at < zeros.length; at += 65536) crypto.getRandomValues(zeros.subarray(at,at + 65536));
      await writer.add('probe-over-4GiB.bin',{size,read:async (_at,n) => zeros.subarray(0,n)},
        {crc:repeatCrc(crc32(zeros),BLOCK_SIZE,size / BLOCK_SIZE)});
    }
    else for (let slot = 0; slot < count; slot++) {
      checkCancelled(controller.signal);
      await writer.add('SAVEGAME/SLOT' + String(Math.floor(slot / 70) + 1).padStart(3,'0') + '/probe-' + slot + '.bin',{size:1,read:async () => zeros.subarray(0,1)},{crc:zeroCrc(1)});
      if (slot % 128 === 0) self.postMessage({type:'progress',files:slot,bytes:temp.output.position,total:count});
    }
    const result = await writer.close(), file = await temp.file();
    self.postMessage({type:'ready',file,result:{...result,ms:performance.now() - started,mode:count === 1 ? 'over4GiB-random-blocks' : 'many',blockSize:BLOCK_SIZE,method:'Store'}});
  } catch (error) {
    await temp?.discard().catch(() => {});
    self.postMessage({type:'error',name:error.name,message:error.message});
  } finally { controller = null; }
};
