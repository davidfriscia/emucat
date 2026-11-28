/**
 * Random-access sources for archive tests (decision 0056): an in-memory buffer that counts what is read, and a
 * sparse "virtual" file made of real byte segments and runs of zeros, which lets a test build a genuine ZIP64 archive
 * with entries beyond 4 GiB, and entries larger than 4 GiB, without allocating gigabytes.
 */
import { createHash } from 'node:crypto';
import { constants, crc32, deflateRawSync } from 'node:zlib';
import type { ExtractSource } from '../src/archives/extract.js';
import { sha256 } from './zip-builder.js';

export interface CountingSource extends ExtractSource {
  bytesRead: number;
  reads: Array<[offset: number, length: number]>;
  /** Called before each read; may throw or wait. */
  beforeRead?: (offset: number, length: number, signal?: AbortSignal) => Promise<void> | void;
}

/** Real bytes, a run of zeros, or one block repeated `count` times. */
export type Segment = Buffer | { zeros: number } | { repeat: Buffer; count: number };

const segmentLength = (segment: Segment) =>
  Buffer.isBuffer(segment)
    ? segment.length
    : 'zeros' in segment
      ? segment.zeros
      : segment.repeat.length * segment.count;

/** `length` bytes of a segment from `from`, which must lie within it. */
function segmentBytes(segment: Segment, from: number, length: number): Buffer {
  if (Buffer.isBuffer(segment)) return segment.subarray(from, from + length);
  if ('zeros' in segment) return Buffer.alloc(length);
  const out = Buffer.alloc(length);
  const block = segment.repeat;
  for (let done = 0; done < length;) {
    const within = (from + done) % block.length;
    done += block.copy(out, done, within, Math.min(block.length, within + length - done));
  }
  return out;
}

const materialize = (segment: Segment) => segmentBytes(segment, 0, segmentLength(segment));

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
        if (!Buffer.isBuffer(segment) && 'zeros' in segment) continue;
        const from = Math.max(offset, start);
        const to = Math.min(end, stop);
        segmentBytes(segment, from - start, to - from).copy(out, from - offset);
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

// --- ZIP64 layouts as the agent writes them (decision 0061) ----------------------------------------------------

const MAX_U32 = 0xffffffff;
/** The source size from which the agent sets `large_file` (agent/src/packaging.rs, ZIP64_ENTRY_THRESHOLD). */
export const AGENT_ZIP64_THRESHOLD = 0xf000_0000;
const MIB = 1024 * 1024;
/** One MiB of zeros as a non-final deflate block, which can be repeated to make any multiple of it. */
const DEFLATED_ZERO_MIB = deflateRawSync(Buffer.alloc(MIB), {
  finishFlush: constants.Z_SYNC_FLUSH,
});
const DEFLATE_END = Buffer.from([0x03, 0x00]);

const zeroCrcs = new Map<number, number>();
const zeroHashes = new Map<number, string>();
/** `zerosCrc`, computed once per length. */
function cachedZerosCrc(length: number): number {
  let crc = zeroCrcs.get(length);
  if (crc === undefined) zeroCrcs.set(length, (crc = zerosCrc(length)));
  return crc;
}

/** SHA-256 of `length` zero bytes, computed once per length. */
export function zerosSha256(length: number): string {
  let digest = zeroHashes.get(length);
  if (digest === undefined) {
    const hash = createHash('sha256');
    const block = Buffer.alloc(16 * MIB);
    for (let done = 0; done < length; done += block.length) {
      hash.update(block.subarray(0, Math.min(block.length, length - done)));
    }
    zeroHashes.set(length, (digest = hash.digest('hex')));
  }
  return digest;
}

export interface Zip64Fields {
  uncompressed: boolean;
  compressed: boolean;
  offset: boolean;
}

export interface LayoutEntry {
  name: string;
  /** The content, or `zeros` bytes of zeros that are never held in memory (a multiple of 1 MiB when deflated). */
  data?: Buffer;
  zeros?: number;
  stored?: boolean;
  /** Zeros placed before this entry's local header, which no entry describes. */
  gapBefore?: number;
  /**
   * How the central record uses ZIP64. By default, as the agent's zip 7.3 does: `large_file` for a source of
   * 3.75 GiB or more, or a local header beyond 4 GiB, then both sizes in ZIP64 (and the offset when it needs it),
   * written as a placeholder record followed by the real one. `fields` says which fixed fields are 0xFFFFFFFF;
   * `records` is `agent` (placeholder, then real), `single` (real only), or the raw data of each record. `false`:
   * no ZIP64 at all.
   */
  zip64?: false | { fields?: Partial<Zip64Fields>; records?: 'agent' | 'single' | Buffer[] };
  /** Other extra fields, kept as they are: for the central record, and for the local header. */
  centralExtra?: Buffer;
  localExtra?: Buffer;
}

export interface VirtualZip extends CountingSource {
  /** The whole archive, for a small one. */
  toBuffer(): Buffer;
}

function extraField(id: number, data: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(id, 0);
  header.writeUInt16LE(data.length, 2);
  return Buffer.concat([header, data]);
}

/** The data of a ZIP64 record holding these values, in order. */
export function zip64Data(...values: Array<number | bigint>): Buffer {
  const data = Buffer.alloc(8 * values.length);
  values.forEach((value, index) => data.writeBigUInt64LE(BigInt(value), 8 * index));
  return data;
}

/**
 * A ZIP whose ZIP64 records are exactly as asked: the agent's (F-4), standard ones, and malformed ones. Entries are
 * written in order, stored or deflated, with no data descriptors, and a ZIP64 end record when the directory needs
 * one. Zeros, stored or deflated, take no memory.
 */
export function buildZip64Layout(entries: LayoutEntry[]): VirtualZip {
  const segments: Segment[] = [];
  let position = 0;
  const push = (segment: Segment) => {
    segments.push(segment);
    position += segmentLength(segment);
  };
  const centrals: Buffer[] = [];
  for (const entry of entries) {
    if (entry.gapBefore) push({ zeros: entry.gapBefore });
    const name = Buffer.from(entry.name, 'utf8');
    const method = entry.name.endsWith('/') || entry.stored ? 0 : 8;
    const offset = position;
    let uncompressed: number;
    let crc: number;
    let body: Segment[];
    if (entry.zeros !== undefined) {
      uncompressed = entry.zeros;
      crc = cachedZerosCrc(entry.zeros);
      if (method === 0) body = [{ zeros: entry.zeros }];
      else {
        if (entry.zeros % MIB !== 0) throw new Error('Deflated zeros come in whole MiB');
        body = [{ repeat: DEFLATED_ZERO_MIB, count: entry.zeros / MIB }, DEFLATE_END];
      }
    } else {
      const data = entry.data ?? Buffer.alloc(0);
      uncompressed = data.length;
      crc = crc32(data) >>> 0;
      body = [method === 8 ? deflateRawSync(data) : data];
    }
    const compressed = body.reduce((sum, segment) => sum + segmentLength(segment), 0);

    const large = uncompressed >= AGENT_ZIP64_THRESHOLD || offset >= MAX_U32;
    const options = entry.zip64 === false ? null : (entry.zip64 ?? {});
    const fields: Zip64Fields =
      options === null
        ? { uncompressed: false, compressed: false, offset: false }
        : {
            uncompressed: options.fields?.uncompressed ?? large,
            compressed: options.fields?.compressed ?? large,
            offset: options.fields?.offset ?? offset >= MAX_U32,
          };
    // zip 7.3's first record: the sizes as the placeholder 0xFFFFFFFF, the offset as it is.
    const real: number[] = [];
    const placeholder: number[] = [];
    if (fields.uncompressed) {
      real.push(uncompressed);
      placeholder.push(MAX_U32);
    }
    if (fields.compressed) {
      real.push(compressed);
      placeholder.push(MAX_U32);
    }
    if (fields.offset) {
      real.push(offset);
      placeholder.push(offset);
    }
    let records: Buffer[] = [];
    if (options !== null && Array.isArray(options.records)) records = options.records;
    else if (options !== null && real.length > 0) {
      records =
        options.records === 'single'
          ? [zip64Data(...real)]
          : [zip64Data(...placeholder), zip64Data(...real)];
    }
    const centralExtra = Buffer.concat([
      ...records.map((data) => extraField(0x0001, data)),
      entry.centralExtra ?? Buffer.alloc(0),
    ]);
    const localSizes64 = fields.uncompressed || fields.compressed;
    const localExtra = Buffer.concat([
      localSizes64 ? extraField(0x0001, zip64Data(uncompressed, compressed)) : Buffer.alloc(0),
      entry.localExtra ?? Buffer.alloc(0),
    ]);
    const versionNeeded = records.length > 0 ? 45 : 20;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(versionNeeded, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(localSizes64 ? MAX_U32 : compressed, 18);
    local.writeUInt32LE(localSizes64 ? MAX_U32 : uncompressed, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    push(Buffer.concat([local, name, localExtra]));
    body.forEach(push);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0300 | versionNeeded, 4);
    central.writeUInt16LE(versionNeeded, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(fields.compressed ? MAX_U32 : compressed, 20);
    central.writeUInt32LE(fields.uncompressed ? MAX_U32 : uncompressed, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(centralExtra.length, 30);
    const mode = entry.name.endsWith('/') ? 0o40755 : 0o100644;
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(fields.offset ? MAX_U32 : offset, 42);
    centrals.push(central, name, centralExtra);
  }
  const directoryOffset = position;
  const directory = Buffer.concat(centrals);
  push(directory);
  const needs64 = directoryOffset >= MAX_U32 || entries.length >= 0xffff;
  if (needs64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(entries.length), 24);
    record.writeBigUInt64LE(BigInt(entries.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40);
    record.writeBigUInt64LE(BigInt(directoryOffset), 48);
    const recordOffset = position;
    push(record);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(recordOffset), 8);
    locator.writeUInt32LE(1, 16);
    push(locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(needs64 ? 0xffff : entries.length, 8);
  end.writeUInt16LE(needs64 ? 0xffff : entries.length, 10);
  end.writeUInt32LE(needs64 ? MAX_U32 : directory.length, 12);
  end.writeUInt32LE(needs64 ? MAX_U32 : directoryOffset, 16);
  push(end);

  const source = virtualSource(segments);
  return Object.assign(source, {
    toBuffer: () => {
      if (source.sizeBytes > 64 * MIB) throw new Error('Too large to hold in memory');
      return Buffer.concat(segments.map(materialize));
    },
  });
}

/** An EmuCat VM archive laid out by `buildZip64Layout`: the files as given (no directories), then the manifest. */
export function vmZip64(
  emulatorType: string,
  vmName: string,
  files: LayoutEntry[],
  manifestEntry: Omit<LayoutEntry, 'name' | 'data' | 'zeros'> = {},
) {
  const listed = files
    .map((file) => ({
      path: file.name,
      type: 'file' as const,
      sizeBytes: file.zeros ?? file.data?.length ?? 0,
      sha256:
        file.zeros === undefined ? sha256(file.data ?? Buffer.alloc(0)) : zerosSha256(file.zeros),
    }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const manifest = {
    manifestVersion: 1,
    emulatorType,
    vmName,
    fileCount: listed.length,
    totalUncompressedBytes: listed.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    entries: listed,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const zip = buildZip64Layout([
    ...files,
    { ...manifestEntry, name: '.emucat-manifest.json', data: manifestBytes },
  ]);
  return { zip, manifestBytes, manifestSha256: sha256(manifestBytes) };
}
