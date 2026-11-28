import { decodeText } from '@emucat/contracts/archive-preview';
import { equalBytes, hex8, u16, u32, u64 } from './bytes';
import { LocalArchiveError } from './errors';
import type { LocalEntry } from './model';
import { baseName, normalizeEntryPath } from './paths';

/**
 * ZIP and ZIP64, read from bytes already in memory (decision 0058): the end records and the central directory, then
 * one entry's local header when that entry is read. The checks are the server's (decision 0056): a single disk, ZIP64
 * records where a field overflows (resolved over all of an entry's ZIP64 records, decision 0061), no entry whose data reaches the central directory, a local header that names the
 * same file with the same method. Unlike an EmuCat archive, an archive found inside one may hold anything, so an
 * entry that cannot be read safely (encrypted, a link, an unknown method, an unsafe name) is listed and marked,
 * not refused with its whole archive.
 */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG = 0x0040;
const FLAG_MASKED = 0x2000;
const FLAG_UTF8 = 0x0800;
const HOST_UNIX = 3;

const METHOD_NAMES: Record<number, string> = {
  1: 'Shrink',
  2: 'Reduce',
  3: 'Reduce',
  4: 'Reduce',
  5: 'Reduce',
  6: 'Implode',
  9: 'Deflate64',
  10: 'PKWARE DCL Implode',
  12: 'BZIP2',
  14: 'LZMA',
  93: 'Zstandard',
  95: 'XZ',
  96: 'JPEG',
  97: 'WavPack',
  98: 'PPMd',
  99: 'AES',
};

const malformed = () => new LocalArchiveError('malformed');

/** Where a ZIP entry's bytes are, kept beside its listing in the worker. */
export interface ZipLocator {
  rawName: Uint8Array;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export interface ZipListing {
  entries: LocalEntry[];
  locators: ZipLocator[];
  directoryOffset: number;
}

function dosTimestamp(time: number, date: number): string | null {
  const year = 1980 + (date >> 9);
  const month = (date >> 5) & 0x0f;
  const day = date & 0x1f;
  if (month < 1 || month > 12 || day < 1) return null;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T${pad(time >> 11)}:${pad((time >> 5) & 0x3f)}:${pad((time & 0x1f) * 2)}`;
}

/** The data of every ZIP64 extended-information record (0x0001) of an extra field, in order. */
function zip64Records(extra: Uint8Array): Uint8Array[] {
  const records: Uint8Array[] = [];
  let at = 0;
  while (at + 4 <= extra.length) {
    const id = u16(extra, at);
    const length = u16(extra, at + 2);
    if (at + 4 + length > extra.length) throw malformed();
    if (id === 0x0001) records.push(extra.subarray(at + 4, at + 4 + length));
    at += 4 + length;
  }
  return records;
}

/**
 * The real uncompressed size, compressed size and local header offset of a central record, resolved over every ZIP64
 * record it carries, as the server does (decision 0061, F-4). Each record holds one 64-bit value per fixed field that
 * is 0xFFFFFFFF, in that order (APPNOTE 4.5.3), so each must be long enough for all of them; bytes beyond are
 * ignored. For each field, a record giving 0xFFFFFFFF yields to one giving anything else (the agent's zip 7.3 writes
 * a placeholder record, then the real one); equal values agree; two different values other than 0xFFFFFFFF
 * contradict each other and refuse the archive. When every record gives 0xFFFFFFFF, that is the value: the bounds,
 * limits and CRC checks that follow refuse it if it is not real. A value above 2^53 − 1 is refused.
 */
function resolveZip64(
  fixed: [number, number, number],
  records: Uint8Array[],
): [number, number, number] {
  const wanted = fixed.filter((value) => value === MAX_U32).length;
  if (wanted === 0) return fixed;
  if (records.length === 0) throw malformed();
  for (const data of records) if (data.length < 8 * wanted) throw malformed();
  let position = 0;
  return fixed.map((value) => {
    if (value !== MAX_U32) return value;
    let resolved = MAX_U32;
    for (const data of records) {
      const candidate = u64(data, position);
      if (candidate === null) throw malformed();
      if (candidate === MAX_U32 || candidate === resolved) continue;
      if (resolved !== MAX_U32) throw malformed();
      resolved = candidate;
    }
    position += 8;
    return resolved;
  }) as [number, number, number];
}

export function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 22 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6))
  );
}

/** A spanned or split archive's first part. */
export function isSpannedZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && u32(bytes, 0) === 0x08074b50;
}

export function readZip(
  bytes: Uint8Array,
  limits: { maxEntries: number; maxPathBytes: number },
): ZipListing {
  const size = bytes.length;
  if (size < 22) throw malformed();
  const tailStart = Math.max(0, size - (22 + MAX_U16 + 20));
  let eocd = -1;
  for (let at = size - 22; at >= tailStart; at -= 1) {
    if (u32(bytes, at) === SIG_EOCD && at + 22 + u16(bytes, at + 20) === size) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw malformed();
  if (u16(bytes, eocd + 4) !== 0 || u16(bytes, eocd + 6) !== 0) {
    throw new LocalArchiveError('multi_volume');
  }
  let count = u16(bytes, eocd + 10);
  let directorySize = u32(bytes, eocd + 12);
  let directoryOffset = u32(bytes, eocd + 16);
  let directoryEnd = eocd;
  const locator = eocd - 20;
  if (locator >= 0 && u32(bytes, locator) === SIG_LOCATOR64) {
    if (u32(bytes, locator + 16) > 1) throw new LocalArchiveError('multi_volume');
    const recordOffset = u64(bytes, locator + 8);
    if (recordOffset === null || recordOffset + 56 > locator) throw malformed();
    if (u32(bytes, recordOffset) !== SIG_EOCD64) throw malformed();
    const count64 = u64(bytes, recordOffset + 32);
    const size64 = u64(bytes, recordOffset + 40);
    const offset64 = u64(bytes, recordOffset + 48);
    if (count64 === null || size64 === null || offset64 === null) throw malformed();
    count = count64;
    directorySize = size64;
    directoryOffset = offset64;
    directoryEnd = recordOffset;
  } else if (count === MAX_U16 || directorySize === MAX_U32 || directoryOffset === MAX_U32) {
    throw malformed();
  }
  if (count > limits.maxEntries) throw new LocalArchiveError('too_many_entries');
  if (directoryOffset + directorySize > directoryEnd) throw malformed();
  const directory = bytes.subarray(directoryOffset, directoryOffset + directorySize);

  const entries: LocalEntry[] = [];
  const locators: ZipLocator[] = [];
  let at = 0;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > directory.length || u32(directory, at) !== SIG_CENTRAL) throw malformed();
    const versionMadeBy = u16(directory, at + 4);
    const flags = u16(directory, at + 8);
    const method = u16(directory, at + 10);
    const nameLength = u16(directory, at + 28);
    const extraLength = u16(directory, at + 30);
    const commentLength = u16(directory, at + 32);
    const end = at + 46 + nameLength + extraLength + commentLength;
    if (end > directory.length) throw malformed();
    if (u16(directory, at + 34) !== 0) throw new LocalArchiveError('multi_volume');
    const rawName = directory.slice(at + 46, at + 46 + nameLength);
    const extra = directory.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
    const [uncompressedSize, compressedSize, localHeaderOffset] = resolveZip64(
      [u32(directory, at + 24), u32(directory, at + 20), u32(directory, at + 42)],
      zip64Records(extra),
    );
    if (localHeaderOffset + 30 + compressedSize > directoryOffset) throw malformed();

    let name: string | null;
    if (flags & FLAG_UTF8) {
      try {
        name = new TextDecoder('utf-8', { fatal: true }).decode(rawName);
      } catch {
        name = null;
      }
    } else {
      // Without the UTF-8 flag, a ZIP name is in code page 437 (APPNOTE, appendix D).
      name = decodeText(rawName, 'cp437');
    }
    const external = u32(directory, at + 38);
    const mode = versionMadeBy >> 8 === HOST_UNIX ? external >>> 16 : null;
    const fileType = mode === null ? 0 : mode & 0o170000;
    let problem: string | null = null;
    let type: LocalEntry['type'] = 'file';
    let path: string;
    const normalized =
      name === null
        ? { problem: 'has a name that is not valid UTF-8' }
        : normalizeEntryPath(name, limits.maxPathBytes);
    if ('problem' in normalized) {
      path = name ?? decodeText(rawName, 'cp437');
      problem = `Not read: the entry ${normalized.problem}.`;
    } else {
      path = normalized.path;
      if (normalized.directory || fileType === 0o040000) type = 'directory';
    }
    if (fileType === 0o120000) {
      type = 'link';
      problem ??= 'Not read: a symbolic link.';
    } else if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) {
      type = 'special';
      problem ??= 'Not read: a special file.';
    } else if ((external & 0x0400) !== 0 && mode === null) {
      type = 'link';
      problem ??= 'Not read: a reparse point.';
    }
    if (type === 'directory' && uncompressedSize !== 0) {
      type = 'file';
      problem ??= 'Not read: a directory that holds data.';
    }
    if (type === 'file' && problem === null) {
      if (flags & (FLAG_ENCRYPTED | FLAG_STRONG | FLAG_MASKED) || method === 99) {
        problem = 'Not read: the entry is encrypted.';
      } else if (method !== 0 && method !== 8) {
        problem = `Not read: it is compressed with ${METHOD_NAMES[method] ?? `method ${method}`}, which the browser does not read.`;
      }
    }
    entries.push({
      index,
      path,
      name: 'path' in normalized ? baseName(path) : path,
      unsafePath: !('path' in normalized),
      type,
      sizeBytes: uncompressedSize,
      compressedSizeBytes: compressedSize,
      method: method === 0 ? 'stored' : method === 8 ? 'deflated' : 'other',
      crc32: hex8(u32(directory, at + 16)),
      modifiedAt: dosTimestamp(u16(directory, at + 12), u16(directory, at + 14)),
      problem,
      archive: null,
      unsupportedArchive: null,
    });
    locators.push({
      rawName,
      method,
      flags,
      crc32: u32(directory, at + 16),
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    at = end;
  }
  return { entries, locators, directoryOffset };
}

/** The entry's compressed bytes, after checking its local header against the central record. */
export function zipEntryData(
  bytes: Uint8Array,
  locator: ZipLocator,
  directoryOffset: number,
): Uint8Array {
  const at = locator.localHeaderOffset;
  if (at + 30 > bytes.length || u32(bytes, at) !== SIG_LOCAL) throw malformed();
  const nameLength = u16(bytes, at + 26);
  const extraLength = u16(bytes, at + 28);
  if (u16(bytes, at + 8) !== locator.method) throw malformed();
  if (!equalBytes(bytes.subarray(at + 30, at + 30 + nameLength), locator.rawName))
    throw malformed();
  const start = at + 30 + nameLength + extraLength;
  const end = start + locator.compressedSize;
  if (end > directoryOffset || end > bytes.length) throw malformed();
  return bytes.subarray(start, end);
}
