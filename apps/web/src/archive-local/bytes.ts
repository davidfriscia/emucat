/** Little-endian readers that never read past their input: a missing byte reads as zero, and callers check lengths. */
export const u16 = (b: Uint8Array, at: number): number => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
export const u32 = (b: Uint8Array, at: number): number =>
  (u16(b, at) | (u16(b, at + 2) << 16)) >>> 0;

/** A 64-bit value, or `null` when it does not fit a safe integer. */
export function u64(b: Uint8Array, at: number): number | null {
  const low = u32(b, at);
  const high = u32(b, at + 4);
  const value = high * 2 ** 32 + low;
  return Number.isSafeInteger(value) ? value : null;
}

export function startsWith(head: Uint8Array, bytes: readonly number[], at = 0): boolean {
  if (head.length < at + bytes.length) return false;
  return bytes.every((byte, index) => head[at + index] === byte);
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (ISO-HDLC, as ZIP and GZIP use it), incrementally: start from 0, pass the previous value back in. */
export function crc32(data: Uint8Array, previous = 0): number {
  let crc = ~previous >>> 0;
  for (let index = 0; index < data.length; index += 1) {
    crc = (CRC_TABLE[(crc ^ (data[index] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  return ~crc >>> 0;
}

export const hex8 = (value: number): string => (value >>> 0).toString(16).padStart(8, '0');

export const utf8Length = (text: string): number => new TextEncoder().encode(text).length;
