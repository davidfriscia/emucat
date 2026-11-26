import { LocalArchiveError } from './errors';
import type { LocalEntry } from './model';
import { baseName, normalizeEntryPath } from './paths';

/**
 * TAR (and OVA, a TAR), read header by header from bytes already in memory (decision 0058). How an archive may end is
 * the policy the agent and the server share (decision 0057), so that the three readers agree:
 *
 * - at a zero block, normally two; if a second block follows the first, it must be zeros too;
 * - or exactly where the last entry's padding ends, with no end marker, after at least one entry and with no PAX or
 *   GNU long-name header pending.
 *
 * Refused as malformed or truncated: a cut inside a header, a file's data or its padding; a declared size reaching
 * past the end; an extended header with nothing after it; a non-zero block after the first zero block; a header whose
 * checksum (unsigned or signed) is wrong.
 *
 * Unlike an OVA in a repository, a TAR found inside an archive may hold directories, links and devices: directories
 * are listed, links and special files are listed and never read, and nothing is followed.
 */

const BLOCK = 512;

export interface TarLocator {
  dataOffset: number;
  size: number;
}

export interface TarListing {
  entries: LocalEntry[];
  locators: TarLocator[];
}

const malformed = () => new LocalArchiveError('malformed');
const truncated = () => new LocalArchiveError('truncated');

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');

function field(block: Uint8Array, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return utf8.decode(slice.subarray(0, end === -1 ? length : end));
}

function octal(block: Uint8Array, offset: number, length: number): number {
  const slice = block.subarray(offset, offset + length);
  if ((slice[0] ?? 0) & 0x80) {
    let value = 0;
    for (let index = 1; index < slice.length; index += 1) {
      value = value * 256 + (slice[index] ?? 0);
      if (!Number.isSafeInteger(value)) throw malformed();
    }
    return value;
  }
  const text = latin1
    .decode(slice)
    .replace(/[\0 ]+$/u, '')
    .trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/u.test(text)) throw malformed();
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw malformed();
  return value;
}

function checksumOk(block: Uint8Array): boolean {
  let stored: number;
  try {
    stored = octal(block, 148, 8);
  } catch {
    return false;
  }
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    const byte = index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
    unsigned += byte;
    signed += byte >= 0x80 ? byte - 0x100 : byte;
  }
  return stored === unsigned || stored === signed;
}

function parsePax(data: Uint8Array): Map<string, string> {
  const values = new Map<string, string>();
  let position = 0;
  while (position < data.length) {
    const space = data.indexOf(0x20, position);
    if (space === -1) throw malformed();
    const length = Number.parseInt(latin1.decode(data.subarray(position, space)), 10);
    if (
      !Number.isSafeInteger(length) ||
      length <= space - position ||
      position + length > data.length
    ) {
      throw malformed();
    }
    const record = utf8.decode(data.subarray(space + 1, position + length - 1));
    const equals = record.indexOf('=');
    if (equals <= 0) throw malformed();
    values.set(record.slice(0, equals), record.slice(equals + 1));
    position += length;
  }
  return values;
}

const isZero = (block: Uint8Array) => block.every((byte) => byte === 0);

/** A TAR header at the start: a valid checksum and a plausible type, ustar magic or not. */
export function looksLikeTar(bytes: Uint8Array): boolean {
  if (bytes.length < BLOCK) return false;
  const block = bytes.subarray(0, BLOCK);
  if (isZero(block)) return false;
  return checksumOk(block);
}

export function readTar(
  bytes: Uint8Array,
  limits: { maxEntries: number; maxPathBytes: number },
): TarListing {
  const size = bytes.length;
  if (size < BLOCK) throw truncated();
  const entries: LocalEntry[] = [];
  const locators: TarLocator[] = [];
  let offset = 0;
  let pax: Map<string, string> | null = null;
  let longName: string | null = null;
  let longLink = false;
  const pending = () => pax !== null || longName !== null || longLink;
  for (;;) {
    if (offset === size && entries.length > 0) {
      if (pending()) throw truncated();
      break;
    }
    if (offset + BLOCK > size) throw truncated();
    const block = bytes.subarray(offset, offset + BLOCK);
    if (isZero(block)) {
      if (
        offset + 2 * BLOCK <= size &&
        !isZero(bytes.subarray(offset + BLOCK, offset + 2 * BLOCK))
      ) {
        throw malformed();
      }
      if (pending()) throw truncated();
      break;
    }
    if (!checksumOk(block)) throw malformed();
    const type = String.fromCharCode(block[156] ?? 0);
    const regular = type === '0' || type === '\0' || type === '7';
    let entrySize = octal(block, 124, 12);
    if (regular && pax?.has('size')) {
      const declared = pax.get('size') as string;
      entrySize = /^\d+$/u.test(declared) ? Number(declared) : Number.NaN;
      if (!Number.isSafeInteger(entrySize)) throw malformed();
    }
    // Links, directories and devices carry no data (POSIX); any other type's data follows its header.
    const dataSize = ['1', '2', '3', '4', '5', '6'].includes(type) ? 0 : entrySize;
    const dataOffset = offset + BLOCK;
    const next = dataOffset + Math.ceil(dataSize / BLOCK) * BLOCK;
    if (!Number.isSafeInteger(next)) throw malformed();
    if (dataOffset + dataSize > size) throw truncated();
    if (next > size) throw truncated();

    if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
      if (dataSize > 1024 * 1024) throw malformed();
      const data = bytes.subarray(dataOffset, dataOffset + dataSize);
      if (type === 'x') pax = parsePax(data);
      else if (type === 'L') longName = field(data, 0, data.length);
      else if (type === 'K') longLink = true;
      else {
        const global = parsePax(data);
        if (global.has('path') || global.has('size')) throw malformed();
      }
      offset = next;
      continue;
    }
    const prefix =
      latin1.decode(block.subarray(257, 263)) === 'ustar\0' ? field(block, 345, 155) : '';
    let raw = longName ?? (prefix ? `${prefix}/${field(block, 0, 100)}` : field(block, 0, 100));
    if (pax?.has('path')) raw = pax.get('path') as string;
    pax = null;
    longName = null;
    longLink = false;

    let kind: LocalEntry['type'] = 'file';
    let problem: string | null = null;
    if (type === '5') kind = 'directory';
    else if (type === '1' || type === '2') {
      kind = 'link';
      problem = type === '1' ? 'Not read: a hard link.' : 'Not read: a symbolic link.';
    } else if (!regular) {
      kind = 'special';
      problem = 'Not read: a special file (device, FIFO or unknown type).';
    }
    const normalized = normalizeEntryPath(raw, limits.maxPathBytes);
    let path: string;
    if ('problem' in normalized) {
      path = raw;
      problem = `Not read: the entry ${normalized.problem}.`;
    } else {
      path = normalized.path;
      if (normalized.directory && kind === 'file') {
        if (dataSize !== 0) problem ??= 'Not read: a directory that holds data.';
        else kind = 'directory';
      }
    }
    const mtime = octal(block, 136, 12);
    entries.push({
      index: entries.length,
      path,
      name: 'path' in normalized ? baseName(path) : path,
      type: kind,
      sizeBytes: dataSize,
      compressedSizeBytes: null,
      method: 'stored',
      crc32: null,
      modifiedAt: mtime > 0 ? new Date(mtime * 1000).toISOString() : null,
      unsafePath: !('path' in normalized),
      problem,
      archive: null,
      unsupportedArchive: null,
    });
    locators.push({ dataOffset, size: dataSize });
    if (entries.length > limits.maxEntries) throw new LocalArchiveError('too_many_entries');
    offset = next;
  }
  return { entries, locators };
}
