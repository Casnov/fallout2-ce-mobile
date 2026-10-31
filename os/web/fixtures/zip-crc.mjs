// CRCs of large synthetic ZIP entries (zeros, repeated blocks) without
// reading them, for the multi-GiB ZIP64 tests. Not part of the app.
import {crc32} from '../zip-output.js';

// zlib's GF(2) combination, with safe-integer lengths instead of 32-bit shifts
// on byte counts.
export function combineCrc(first,second,length) {
  integer(length); if (!length) return first >>> 0;
  const times = (matrix,vector) => {
    let sum = 0, at = 0;
    while (vector) { if (vector & 1) sum ^= matrix[at]; vector >>>= 1; at++; }
    return sum >>> 0;
  };
  const square = matrix => Uint32Array.from(matrix,(_,i) => times(matrix,matrix[i]));
  let odd = new Uint32Array(32); odd[0] = 0xedb88320;
  for (let i = 1, row = 1; i < 32; i++, row <<= 1) odd[i] = row;
  let even = square(odd); odd = square(even);
  do {
    even = square(odd); if (length % 2) first = times(even,first); length = Math.floor(length / 2);
    if (!length) break;
    odd = square(even); if (length % 2) first = times(odd,first); length = Math.floor(length / 2);
  } while (length);
  return (first ^ second) >>> 0;
}
export function zeroCrc(length) {
  integer(length); if (!length) return 0;
  let result = 0, power = crc32(Uint8Array.of(0)), size = 1;
  while (length) {
    if (length % 2) result = combineCrc(result,power,size);
    length = Math.floor(length / 2);
    if (length) { power = combineCrc(power,power,size); size *= 2; }
  }
  return result;
}
export function repeatCrc(crc,size,count) {
  integer(size); integer(count); integer(size * count);
  let result = 0;
  while (count) {
    if (count % 2) result = combineCrc(result,crc,size);
    count = Math.floor(count / 2);
    if (count) { crc = combineCrc(crc,crc,size); size *= 2; }
  }
  return result;
}
function integer(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('ZIP size/offset is not a safe integer');
  return value;
}
