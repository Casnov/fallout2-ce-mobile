// Native interchange contract: GameSaves.java / save_records.cc. Slot numbers
// here are one-based, on disk SLOT01..SLOT1000. Dates/orders remain int64 strings.
import {configValue} from './game-config.js';
export const slotName = number => 'SLOT' + String(number).padStart(2,'0');
export function slotNumber(name) {
  const m = /^slot(\d+)$/i.exec(name), n = Number(m?.[1]);
  return n >= 1 && n <= 1000 && name.toLowerCase() === slotName(n).toLowerCase() ? n : 0;
}
export function saveIdentity(prefix,size = prefix.length) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of prefix.subarray(0,4096)) hash = BigInt.asUintN(64,(hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(16).padStart(16,'0') + '-' + size;
}
export function parseRecords(text) {
  const records = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const [slot,id,created,order,composition = '',quick] = line.split('\t'), n = slotNumber(slot);
    if (!n || !/^[a-f0-9]{16}-\d+$/.test(id || '')) continue;
    const integer = value => /^\d{1,19}$/.test(value || '') && BigInt(value) <= 9223372036854775807n ? value : '0';
    records.set(n,{id,created:integer(created),order:integer(order),composition:composition === '*' ? '' : composition,quick:quick === 'quick'});
  }
  return records;
}
export const recordText = (records,{exported = true} = {}) => '# Fallout 2 CE: saves and composition; compatible with src/save_records.h\n'
  + [...records].sort(([a],[b]) => a-b).map(([slot,r]) => `${slotName(slot)}\t${r.id}\t${r.created}\t${r.order}\t${r.composition}` + (exported ? `\t${r.quick ? 'quick' : ''}` : '') + '\n').join('');
export function quickRange(config,ddraw = '') {
  const legacy = key => new RegExp('(?:^|\\n)\\s*' + key + '\\s*=\\s*([0-9]+)','i').exec(ddraw)?.[1];
  const number = (value,fallback) => /^\d+$/.test(value || '') ? Number(value) : fallback;
  const count = Math.max(0,Math.min(10,number(configValue(config,'ui','auto_quick_save') ?? legacy('AutoQuickSave'),0))) * 10;
  const first = Math.min(1001,Math.max(0,number(configValue(config,'ui','auto_quick_save_page') ?? legacy('AutoQuickSavePage'),1)) * 10 + 1);
  return [first,Math.min(1001,first + count)];
}
