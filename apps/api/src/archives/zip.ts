import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { promisify } from 'node:util';
import { crc32, createInflateRaw, deflateRawSync, inflateRaw } from 'node:zlib';

const inflateRawAsync = promisify(inflateRaw);

/**
 * The parts of ZIP the server needs (decision 0055): reading a central directory and one small entry through
 * random-access reads, so that an archive in the repository can be listed without downloading it; and writing a copy
 * of a local ZIP with every entry's compressed bytes kept and the manifest replaced, for a clone. ZIP64 is read and
 * written where needed. Nothing here allocates more than the limits it is given, whatever the archive claims.
 */

export interface RandomAccess {
  readonly sizeBytes: number;
  read(offset: number, length: number): Promise<Buffer>;
}

export class ZipFormatError extends Error {
  override readonly name = 'ZipFormatError';

  constructor(
    readonly kind: 'malformed' | 'limit',
    message: string,
  ) {
    super(message);
  }
}

const malformed = (message: string) => new ZipFormatError('malformed', message);

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const EXTRA_ZIP64 = 0x0001;
const MAX_U32 = 0xffffffff;
const MAX_U16 = 0xffff;
const HOST_UNIX = 3;

export interface ZipEntry {
  name: string;
  /** The name's bytes exactly as stored. */
  rawName: Buffer;
  versionMadeBy: number;
  versionNeeded: number;
  flags: number;
  method: number;
  dosTime: number;
  dosDate: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  internalAttributes: number;
  externalAttributes: number;
  localHeaderOffset: number;
  /** The central extra field, without its ZIP64 records. */
  extra: Buffer;
  comment: Buffer;
  /** Whether the central record carried a ZIP64 extra field (one record or more). */
  zip64: boolean;
}

export function isDirectoryName(entry: Pick<ZipEntry, 'name'>): boolean {
  return entry.name.endsWith('/');
}

/** The Unix file mode, when the archive was made somewhere that has one. */
export function unixMode(
  entry: Pick<ZipEntry, 'versionMadeBy' | 'externalAttributes'>,
): number | null {
  return entry.versionMadeBy >> 8 === HOST_UNIX ? entry.externalAttributes >>> 16 : null;
}

/** `YYYY-MM-DDTHH:MM:SS`, as the entry records it, with no zone (ZIP times have none). */
export function dosTimestamp(entry: Pick<ZipEntry, 'dosTime' | 'dosDate'>): string | null {
  const year = 1980 + (entry.dosDate >> 9);
  const month = (entry.dosDate >> 5) & 0x0f;
  const day = entry.dosDate & 0x1f;
  if (month < 1 || month > 12 || day < 1) return null;
  const hours = entry.dosTime >> 11;
  const minutes = (entry.dosTime >> 5) & 0x3f;
  const seconds = (entry.dosTime & 0x1f) * 2;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function u64(buffer: Buffer, at: number): number {
  const value = buffer.readBigUInt64LE(at);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw malformed('A size or offset is too large');
  return Number(value);
}

/** Splits an extra field into its records, refusing one that runs past the end. */
function extraRecords(extra: Buffer): { id: number; data: Buffer }[] {
  const records: { id: number; data: Buffer }[] = [];
  let at = 0;
  while (at + 4 <= extra.length) {
    const id = extra.readUInt16LE(at);
    const length = extra.readUInt16LE(at + 2);
    if (at + 4 + length > extra.length) throw malformed('An extra field is truncated');
    records.push({ id, data: extra.subarray(at + 4, at + 4 + length) });
    at += 4 + length;
  }
  return records;
}

function withoutZip64(extra: Buffer): Buffer {
  return Buffer.concat(
    extraRecords(extra)
      .filter((record) => record.id !== EXTRA_ZIP64)
      .map((record) => {
        const header = Buffer.alloc(4);
        header.writeUInt16LE(record.id, 0);
        header.writeUInt16LE(record.data.length, 2);
        return Buffer.concat([header, record.data]);
      }),
  );
}

/**
 * The real uncompressed size, compressed size and local header offset of a central record: its fixed fields, in
 * that order, and the data of every ZIP64 extended-information record (0x0001) it carries, in order.
 *
 * In each record, a 64-bit value follows for each fixed field that is 0xFFFFFFFF, in the order above (APPNOTE
 * 4.5.3), so every record must hold one for each such field. A record may hold more, as some writers add the disk
 * number; that is ignored, as before.
 *
 * A central record may carry several ZIP64 records. The agent's zip 7.3 writes two for every entry that needs ZIP64
 * (decision 0061, F-4): first one whose sizes are the placeholder 0xFFFFFFFF, then one with the real values. So, for
 * each field, a record giving 0xFFFFFFFF yields to one giving anything else, as the agent's own reader and the zip
 * crate's do. Two records giving two different values other than 0xFFFFFFFF contradict each other: readers disagree
 * on which is meant, so the archive is refused. When every record gives 0xFFFFFFFF, that is the value: a real one,
 * such as a file of 4,294,967,295 bytes, still passes, and a placeholder never resolved is then refused by the checks
 * that follow (the data's bounds, the manifest's sizes, the size and CRC read back).
 */
function resolveZip64(
  fixed: [number, number, number],
  records: Buffer[],
): [number, number, number] {
  const wanted = fixed.filter((value) => value === MAX_U32).length;
  if (wanted === 0) return fixed;
  if (records.length === 0) throw malformed('An entry needs ZIP64 and has no ZIP64 field');
  for (const data of records) {
    if (data.length < 8 * wanted) throw malformed('A ZIP64 field is truncated');
  }
  let position = 0;
  return fixed.map((value) => {
    if (value !== MAX_U32) return value;
    let resolved = MAX_U32;
    for (const data of records) {
      const candidate = u64(data, position);
      if (candidate === MAX_U32 || candidate === resolved) continue;
      if (resolved !== MAX_U32) throw malformed('An entry’s ZIP64 records contradict each other');
      resolved = candidate;
    }
    position += 8;
    return resolved;
  }) as [number, number, number];
}

export interface DirectoryLimits {
  maxEntries: number;
  maxDirectoryBytes: number;
}

export interface CentralDirectory {
  entries: ZipEntry[];
  /** Where the central directory starts: nothing an entry's data may reach. */
  directoryOffset: number;
}

/** Reads and checks the end records and the central directory, and nothing else. */
export async function readCentralDirectory(
  source: RandomAccess,
  limits: DirectoryLimits,
): Promise<CentralDirectory> {
  const size = source.sizeBytes;
  if (size < 22) throw malformed('Too short to be a ZIP');
  const tailLength = Math.min(size, 22 + MAX_U16 + 20);
  const tailStart = size - tailLength;
  const tail = await source.read(tailStart, tailLength);
  let eocd = -1;
  for (let at = tail.length - 22; at >= 0; at--) {
    if (
      tail.readUInt32LE(at) === SIG_EOCD &&
      at + 22 + tail.readUInt16LE(at + 20) === tail.length
    ) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw malformed('No end of central directory record');
  if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0) {
    throw malformed('Multi-disk archives are not supported');
  }
  let count: number = tail.readUInt16LE(eocd + 10);
  let directorySize: number = tail.readUInt32LE(eocd + 12);
  let directoryOffset: number = tail.readUInt32LE(eocd + 16);
  const eocdOffset = tailStart + eocd;
  let directoryEnd = eocdOffset;

  const locator = eocd - 20;
  if (locator >= 0 && tail.readUInt32LE(locator) === SIG_LOCATOR64) {
    const recordOffset = u64(tail, locator + 8);
    if (recordOffset + 56 > tailStart + locator) throw malformed('The ZIP64 locator is wrong');
    const record = await source.read(recordOffset, 56);
    if (record.length < 56 || record.readUInt32LE(0) !== SIG_EOCD64) {
      throw malformed('No ZIP64 end of central directory record');
    }
    count = u64(record, 32);
    directorySize = u64(record, 40);
    directoryOffset = u64(record, 48);
    directoryEnd = recordOffset;
  } else if (count === MAX_U16 || directorySize === MAX_U32 || directoryOffset === MAX_U32) {
    throw malformed('A ZIP64 archive without its ZIP64 records');
  }

  if (count > limits.maxEntries) {
    throw new ZipFormatError(
      'limit',
      `The archive has ${count} entries, and the limit is ${limits.maxEntries}`,
    );
  }
  if (directorySize > limits.maxDirectoryBytes) {
    throw new ZipFormatError('limit', 'The archive’s central directory is too large');
  }
  if (directoryOffset + directorySize > directoryEnd) {
    throw malformed('The central directory overlaps the end records');
  }
  const directory = await source.read(directoryOffset, directorySize);
  if (directory.length !== directorySize) throw malformed('The central directory is truncated');

  const entries: ZipEntry[] = [];
  let at = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > directory.length || directory.readUInt32LE(at) !== SIG_CENTRAL) {
      throw malformed('A central directory record is damaged');
    }
    const nameLength = directory.readUInt16LE(at + 28);
    const extraLength = directory.readUInt16LE(at + 30);
    const commentLength = directory.readUInt16LE(at + 32);
    const end = at + 46 + nameLength + extraLength + commentLength;
    if (end > directory.length) throw malformed('A central directory record is truncated');
    if (directory.readUInt16LE(at + 34) !== 0)
      throw malformed('Multi-disk archives are not supported');
    const rawName = Buffer.from(directory.subarray(at + 46, at + 46 + nameLength));
    const rawExtra = directory.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(rawName);

    const zip64Records = extraRecords(rawExtra)
      .filter((record) => record.id === EXTRA_ZIP64)
      .map((record) => record.data);
    const [uncompressedSize, compressedSize, localHeaderOffset] = resolveZip64(
      [
        directory.readUInt32LE(at + 24),
        directory.readUInt32LE(at + 20),
        directory.readUInt32LE(at + 42),
      ],
      zip64Records,
    );
    if (localHeaderOffset + 30 + compressedSize > directoryOffset) {
      throw malformed('An entry’s data overlaps the central directory');
    }
    entries.push({
      name,
      rawName,
      versionMadeBy: directory.readUInt16LE(at + 4),
      versionNeeded: directory.readUInt16LE(at + 6),
      flags: directory.readUInt16LE(at + 8),
      method: directory.readUInt16LE(at + 10),
      dosTime: directory.readUInt16LE(at + 12),
      dosDate: directory.readUInt16LE(at + 14),
      crc32: directory.readUInt32LE(at + 16),
      compressedSize,
      uncompressedSize,
      internalAttributes: directory.readUInt16LE(at + 36),
      externalAttributes: directory.readUInt32LE(at + 38),
      localHeaderOffset,
      extra: withoutZip64(rawExtra),
      comment: Buffer.from(directory.subarray(end - commentLength, end)),
      zip64: zip64Records.length > 0,
    });
    at = end;
  }
  return { entries, directoryOffset };
}

/** Where an entry's data starts, from its local header, which must agree with the central record. */
async function localDataOffset(
  source: RandomAccess,
  entry: ZipEntry,
): Promise<{ dataOffset: number; localExtra: Buffer }> {
  const header = await source.read(entry.localHeaderOffset, 30);
  if (header.length !== 30 || header.readUInt32LE(0) !== SIG_LOCAL) {
    throw malformed(`The local header of ${entry.name} is damaged`);
  }
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const rest = await source.read(entry.localHeaderOffset + 30, nameLength + extraLength);
  if (rest.length !== nameLength + extraLength) throw malformed('A local header is truncated');
  if (!rest.subarray(0, nameLength).equals(entry.rawName)) {
    throw malformed(`The local header of ${entry.name} names another file`);
  }
  if (header.readUInt16LE(8) !== entry.method) {
    throw malformed(`The local header of ${entry.name} has another compression method`);
  }
  return {
    dataOffset: entry.localHeaderOffset + 30 + nameLength + extraLength,
    localExtra: Buffer.from(rest.subarray(nameLength)),
  };
}

/**
 * Reads one entry whole, for a small one such as the manifest. Refuses more than `maxBytes`. Decompression runs on
 * zlib's thread pool, not on the event loop (decision 0056), and stops at `maxBytes + 1` whatever the data claims.
 */
export async function readSmallEntry(
  source: RandomAccess,
  entry: ZipEntry,
  maxBytes: number,
): Promise<Buffer> {
  if (entry.uncompressedSize > maxBytes || entry.compressedSize > maxBytes) {
    throw new ZipFormatError('limit', `${entry.name} is too large to read`);
  }
  const { dataOffset } = await localDataOffset(source, entry);
  const compressed = await source.read(dataOffset, entry.compressedSize);
  if (compressed.length !== entry.compressedSize) throw malformed(`${entry.name} is truncated`);
  let data: Buffer;
  if (entry.method === 0) data = compressed;
  else if (entry.method === 8) {
    try {
      data = await inflateRawAsync(compressed, { maxOutputLength: maxBytes + 1 });
    } catch {
      throw malformed(`${entry.name} cannot be decompressed`);
    }
  } else throw malformed(`${entry.name} uses an unsupported compression method`);
  if (data.length !== entry.uncompressedSize || crc32(data) >>> 0 !== entry.crc32 >>> 0) {
    throw malformed(`${entry.name} does not match its size or CRC`);
  }
  return data;
}

/** A local file as a random-access source. */
export async function openLocal(path: string): Promise<RandomAccess & { close(): Promise<void> }> {
  const handle = await open(path, 'r');
  const sizeBytes = (await handle.stat()).size;
  return {
    sizeBytes,
    read: async (offset, length) => {
      const buffer = Buffer.alloc(Math.max(0, Math.min(length, sizeBytes - offset)));
      let done = 0;
      while (done < buffer.length) {
        const { bytesRead } = await handle.read(buffer, done, buffer.length - done, offset + done);
        if (bytesRead === 0) break;
        done += bytesRead;
      }
      return buffer.subarray(0, done);
    },
    close: () => handle.close(),
  };
}

/**
 * Decompresses one entry of a local ZIP and returns its SHA-256, checking its size and CRC on the way. Memory is
 * bounded by the stream buffers, whatever the entry's size.
 */
export async function hashEntry(
  path: string,
  source: RandomAccess,
  entry: ZipEntry,
  onBytes: (count: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const { dataOffset } = await localDataOffset(source, entry);
  const hash = createHash('sha256');
  let crc = 0;
  let size = 0;
  const consume = (chunk: Buffer) => {
    hash.update(chunk);
    crc = crc32(chunk, crc);
    size += chunk.length;
    if (size > entry.uncompressedSize) throw malformed(`${entry.name} is larger than recorded`);
    onBytes(chunk.length);
  };
  if (entry.compressedSize > 0) {
    const raw = createReadStream(path, {
      start: dataOffset,
      end: dataOffset + entry.compressedSize - 1,
      highWaterMark: 1024 * 1024,
      ...(signal ? { signal } : {}),
    });
    if (entry.method === 0) {
      for await (const chunk of raw) consume(chunk as Buffer);
    } else if (entry.method === 8) {
      const inflater = createInflateRaw();
      raw.pipe(inflater);
      raw.once('error', (error) => inflater.destroy(error));
      try {
        for await (const chunk of inflater) consume(chunk as Buffer);
      } catch (error) {
        if (error instanceof ZipFormatError) throw error;
        if (signal?.aborted) throw error;
        throw malformed(`${entry.name} cannot be decompressed`);
      }
    } else throw malformed(`${entry.name} uses an unsupported compression method`);
  }
  if (size !== entry.uncompressedSize || crc >>> 0 !== entry.crc32 >>> 0) {
    throw malformed(`${entry.name} does not match its recorded size or CRC`);
  }
  return hash.digest('hex');
}

function dosNow(date = new Date()): { time: number; date: number } {
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date:
      ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

function zip64Field(values: number[]): Buffer {
  const field = Buffer.alloc(4 + 8 * values.length);
  field.writeUInt16LE(EXTRA_ZIP64, 0);
  field.writeUInt16LE(8 * values.length, 2);
  values.forEach((value, index) => field.writeBigUInt64LE(BigInt(value), 4 + 8 * index));
  return field;
}

interface Written {
  entry: ZipEntry;
  offset: number;
  zip64: boolean;
}

/**
 * Writes a new ZIP with every entry of `sourcePath` but `skipName`, each with its compressed bytes and CRC exactly as
 * they were (directories too), then `lastName` with `lastData`, deflated. Local headers are written again from the
 * central records, so data descriptors go and sizes are always in the header. The output is created exclusively.
 */
export async function rewriteZip(
  sourcePath: string,
  targetPath: string,
  skipName: string,
  lastName: string,
  lastData: Buffer,
  limits: DirectoryLimits,
  onBytes: (count: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const source = await openLocal(sourcePath);
  const output = await open(targetPath, 'wx', 0o600);
  let position = 0;
  const write = async (buffer: Buffer) => {
    let done = 0;
    while (done < buffer.length) {
      const { bytesWritten } = await output.write(buffer, done, buffer.length - done, position);
      done += bytesWritten;
      position += bytesWritten;
    }
  };
  try {
    const { entries } = await readCentralDirectory(source, limits);
    const written: Written[] = [];
    for (const entry of entries) {
      if (signal?.aborted) throw new Error('Cancelled');
      if (entry.name === skipName) continue;
      const { dataOffset, localExtra } = await localDataOffset(source, entry);
      const zip64 =
        entry.zip64 ||
        extraRecords(localExtra).some((record) => record.id === EXTRA_ZIP64) ||
        entry.compressedSize >= MAX_U32 ||
        entry.uncompressedSize >= MAX_U32;
      const extra = Buffer.concat([
        withoutZip64(localExtra),
        zip64 ? zip64Field([entry.uncompressedSize, entry.compressedSize]) : Buffer.alloc(0),
      ]);
      const header = Buffer.alloc(30);
      header.writeUInt32LE(SIG_LOCAL, 0);
      header.writeUInt16LE(zip64 ? Math.max(entry.versionNeeded, 45) : entry.versionNeeded, 4);
      header.writeUInt16LE(entry.flags & ~0x0008, 6);
      header.writeUInt16LE(entry.method, 8);
      header.writeUInt16LE(entry.dosTime, 10);
      header.writeUInt16LE(entry.dosDate, 12);
      header.writeUInt32LE(entry.crc32 >>> 0, 14);
      header.writeUInt32LE(zip64 ? MAX_U32 : entry.compressedSize, 18);
      header.writeUInt32LE(zip64 ? MAX_U32 : entry.uncompressedSize, 22);
      header.writeUInt16LE(entry.rawName.length, 26);
      header.writeUInt16LE(extra.length, 28);
      written.push({ entry, offset: position, zip64 });
      await write(Buffer.concat([header, entry.rawName, extra]));
      let copied = 0;
      while (copied < entry.compressedSize) {
        const length = Math.min(1024 * 1024, entry.compressedSize - copied);
        const piece = await source.read(dataOffset + copied, length);
        if (piece.length !== length) throw malformed(`${entry.name} is truncated`);
        await write(piece);
        copied += length;
        onBytes(length);
      }
    }

    const { time, date } = dosNow();
    const compressed = deflateRawSync(lastData);
    const name = Buffer.from(lastName, 'utf8');
    const last: ZipEntry = {
      name: lastName,
      rawName: name,
      versionMadeBy: (HOST_UNIX << 8) | 45,
      versionNeeded: 20,
      flags: 0x0800,
      method: 8,
      dosTime: time,
      dosDate: date,
      crc32: crc32(lastData) >>> 0,
      compressedSize: compressed.length,
      uncompressedSize: lastData.length,
      internalAttributes: 0,
      externalAttributes: (0o100644 << 16) >>> 0,
      localHeaderOffset: 0,
      extra: Buffer.alloc(0),
      comment: Buffer.alloc(0),
      zip64: false,
    };
    const header = Buffer.alloc(30);
    header.writeUInt32LE(SIG_LOCAL, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(last.crc32, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(lastData.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    written.push({ entry: last, offset: position, zip64: false });
    await write(Buffer.concat([header, name, compressed]));

    const directoryOffset = position;
    for (const { entry, offset, zip64 } of written) {
      const needs: number[] = [];
      const bigSizes =
        zip64 || entry.uncompressedSize >= MAX_U32 || entry.compressedSize >= MAX_U32;
      if (bigSizes) needs.push(entry.uncompressedSize, entry.compressedSize);
      const bigOffset = offset >= MAX_U32;
      if (bigOffset) needs.push(offset);
      const extra = Buffer.concat([
        entry.extra,
        needs.length > 0 ? zip64Field(needs) : Buffer.alloc(0),
      ]);
      const record = Buffer.alloc(46);
      record.writeUInt32LE(SIG_CENTRAL, 0);
      record.writeUInt16LE(entry.versionMadeBy, 4);
      record.writeUInt16LE(
        needs.length > 0 ? Math.max(entry.versionNeeded, 45) : entry.versionNeeded,
        6,
      );
      record.writeUInt16LE(entry.flags & ~0x0008, 8);
      record.writeUInt16LE(entry.method, 10);
      record.writeUInt16LE(entry.dosTime, 12);
      record.writeUInt16LE(entry.dosDate, 14);
      record.writeUInt32LE(entry.crc32 >>> 0, 16);
      record.writeUInt32LE(bigSizes ? MAX_U32 : entry.compressedSize, 20);
      record.writeUInt32LE(bigSizes ? MAX_U32 : entry.uncompressedSize, 24);
      record.writeUInt16LE(entry.rawName.length, 28);
      record.writeUInt16LE(extra.length, 30);
      record.writeUInt16LE(entry.comment.length, 32);
      record.writeUInt16LE(0, 34);
      record.writeUInt16LE(entry.internalAttributes, 36);
      record.writeUInt32LE(entry.externalAttributes >>> 0, 38);
      record.writeUInt32LE(bigOffset ? MAX_U32 : offset, 42);
      await write(Buffer.concat([record, entry.rawName, extra, entry.comment]));
    }
    const directorySize = position - directoryOffset;
    const count = written.length;
    const needs64 = count >= MAX_U16 || directoryOffset >= MAX_U32 || directorySize >= MAX_U32;
    if (needs64) {
      const record = Buffer.alloc(56);
      record.writeUInt32LE(SIG_EOCD64, 0);
      record.writeBigUInt64LE(44n, 4);
      record.writeUInt16LE(45, 12);
      record.writeUInt16LE(45, 14);
      record.writeBigUInt64LE(BigInt(count), 24);
      record.writeBigUInt64LE(BigInt(count), 32);
      record.writeBigUInt64LE(BigInt(directorySize), 40);
      record.writeBigUInt64LE(BigInt(directoryOffset), 48);
      const recordOffset = position;
      await write(record);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(SIG_LOCATOR64, 0);
      locator.writeBigUInt64LE(BigInt(recordOffset), 8);
      locator.writeUInt32LE(1, 16);
      await write(locator);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(SIG_EOCD, 0);
    end.writeUInt16LE(needs64 ? MAX_U16 : count, 8);
    end.writeUInt16LE(needs64 ? MAX_U16 : count, 10);
    end.writeUInt32LE(needs64 ? MAX_U32 : directorySize, 12);
    end.writeUInt32LE(needs64 ? MAX_U32 : directoryOffset, 16);
    await write(end);
    await output.sync();
  } finally {
    await output.close();
    await source.close();
  }
}
