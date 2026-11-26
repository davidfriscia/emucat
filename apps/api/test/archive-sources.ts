/**
 * Random-access sources for archive tests (decision 0056): an in-memory buffer that counts what is read, and a
 * sparse "virtual" file made of real byte segments and runs of zeros, which lets a test build a genuine ZIP64 archive
 * with entries beyond 4 GiB, and entries larger than 4 GiB, without allocating gigabytes.
 */
import { crc32 } from 'node:zlib';
import type { ExtractSource } from '../src/archives/extract.js';

export interface CountingSource extends ExtractSource {
  bytesRead: number;
  reads: Array<[offset: number, length: number]>;
  /** Called before each read; may throw or wait. */
  beforeRead?: (offset: number, length: number, signal?: AbortSignal) => Promise<void> | void;
}

export type Segment = Buffer | { zeros: number };

const segmentLength = (segment: Segment) =>
  Buffer.isBuffer(segment) ? segment.length : segment.zeros;

export function virtualSource(segments: Segment[]): CountingSource {
  const starts: number[] = [];
  let total = 0;
  for (const segment of segments) {
    starts.push(total);
    total += segmentLength(segment);
  }
  const source: CountingSource = {
    sizeBytes: total,
    bytesRead: 0,
    reads: [],
    async read(offset, length, signal) {
      await source.beforeRead?.(offset, length, signal);
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      const end = Math.min(total, offset + length);
      const out = Buffer.alloc(Math.max(0, end - offset));
      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index] as Segment;
        const start = starts[index] as number;
        const stop = start + segmentLength(segment);
        if (stop <= offset || start >= end) continue;
        if (Buffer.isBuffer(segment)) {
          const from = Math.max(offset, start);
          const to = Math.min(end, stop);
          segment.copy(out, from - offset, from - start, to - start);
        }
      }
      source.bytesRead += out.length;
      source.reads.push([offset, out.length]);
      return out;
    },
  };
  return source;
}

export const bufferSource = (data: Buffer) => virtualSource([data]);

/** CRC-32 of `length` zero bytes, without allocating them all at once. */
export function zerosCrc(length: number): number {
  const block = Buffer.alloc(64 * 1024 * 1024);
  let crc = 0;
  let left = length;
  while (left > 0) {
    const take = Math.min(left, block.length);
    crc = crc32(block.subarray(0, take), crc);
    left -= take;
  }
  return crc >>> 0;
}

export interface Zip64Entry {
  name: string;
  /** Stored bytes, or a run of zeros of this size (stored). */
  data: Buffer | { zeros: number; crc: number };
  /** Zeros placed before this entry's local header, to push it past 4 GiB. */
  gapBefore?: number;
}

/**
 * A ZIP64 archive as `zip -fz` writes one: every entry with ZIP64 extra fields (sizes in the local header, sizes and
 * offset in the central record), a ZIP64 end record and locator, and the classic end record full of markers.
 */
export function zip64Archive(entries: Zip64Entry[]): CountingSource {
  const segments: Segment[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const push = (segment: Segment) => {
    segments.push(segment);
    offset += segmentLength(segment);
  };
  for (const entry of entries) {
    if (entry.gapBefore) push({ zeros: entry.gapBefore });
    const name = Buffer.from(entry.name, 'utf8');
    const size = Buffer.isBuffer(entry.data) ? entry.data.length : entry.data.zeros;
    const crc = Buffer.isBuffer(entry.data) ? crc32(entry.data) >>> 0 : entry.data.crc;
    const localExtra = Buffer.alloc(20);
    localExtra.writeUInt16LE(0x0001, 0);
    localExtra.writeUInt16LE(16, 2);
    localExtra.writeBigUInt64LE(BigInt(size), 4);
    localExtra.writeBigUInt64LE(BigInt(size), 12);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(45, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(0xffffffff, 18);
    local.writeUInt32LE(0xffffffff, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    const headerOffset = offset;
    push(Buffer.concat([local, name, localExtra]));
    push(Buffer.isBuffer(entry.data) ? entry.data : { zeros: entry.data.zeros });
    const centralExtra = Buffer.alloc(28);
    centralExtra.writeUInt16LE(0x0001, 0);
    centralExtra.writeUInt16LE(24, 2);
    centralExtra.writeBigUInt64LE(BigInt(size), 4);
    centralExtra.writeBigUInt64LE(BigInt(size), 12);
    centralExtra.writeBigUInt64LE(BigInt(headerOffset), 20);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(45, 4);
    record.writeUInt16LE(45, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt16LE(0x21, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(0xffffffff, 20);
    record.writeUInt32LE(0xffffffff, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(centralExtra.length, 30);
    record.writeUInt32LE(0xffffffff, 42);
    central.push(record, name, centralExtra);
  }
  const directory = Buffer.concat(central);
  const directoryOffset = offset;
  push(directory);
  const end64 = Buffer.alloc(56);
  end64.writeUInt32LE(0x06064b50, 0);
  end64.writeBigUInt64LE(44n, 4);
  end64.writeUInt16LE(45, 12);
  end64.writeUInt16LE(45, 14);
  end64.writeBigUInt64LE(BigInt(entries.length), 24);
  end64.writeBigUInt64LE(BigInt(entries.length), 32);
  end64.writeBigUInt64LE(BigInt(directory.length), 40);
  end64.writeBigUInt64LE(BigInt(directoryOffset), 48);
  const end64Offset = offset;
  push(end64);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(end64Offset), 8);
  locator.writeUInt32LE(1, 16);
  push(locator);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0xffff, 8);
  end.writeUInt16LE(0xffff, 10);
  end.writeUInt32LE(0xffffffff, 12);
  end.writeUInt32LE(0xffffffff, 16);
  push(end);
  return virtualSource(segments);
}
