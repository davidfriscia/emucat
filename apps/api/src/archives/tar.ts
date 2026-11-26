import type { RandomAccess } from './zip.js';
import { entryPathProblem } from './manifest.js';

/**
 * The structure of an OVA (a POSIX TAR, decision 0045), read header by header through random access, so that a
 * listing never reads a disk image. Only what an agent's restore accepts is accepted: regular files in one flat
 * directory, ustar or GNU headers with valid checksums, PAX headers only for long names and sizes, the OVF
 * descriptor first and only once. Anything else is refused rather than skipped. The end of the archive is decided
 * as the agent decides it (see `readTar`).
 */

const BLOCK = 512;

export interface TarEntry {
  name: string;
  sizeBytes: number;
  /** Where the entry's data starts. */
  dataOffset: number;
  modifiedAt: string | null;
}

export class TarFormatError extends Error {
  override readonly name = 'TarFormatError';

  constructor(
    readonly kind: 'malformed' | 'limit',
    message: string,
  ) {
    super(message);
  }
}

const malformed = (message: string) => new TarFormatError('malformed', message);

function field(block: Buffer, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? length : end).toString('utf8');
}

function octal(block: Buffer, offset: number, length: number): number {
  const slice = block.subarray(offset, offset + length);
  if ((slice[0] ?? 0) & 0x80) {
    // GNU base-256: big-endian, positive only.
    let value = 0;
    for (let index = 1; index < slice.length; index += 1) {
      value = value * 256 + (slice[index] ?? 0);
      if (!Number.isSafeInteger(value)) throw malformed('A size in the archive is too large');
    }
    return value;
  }
  const text = slice
    .toString('latin1')
    .replace(/[\0 ]+$/u, '')
    .trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/u.test(text)) throw malformed('A TAR header has an invalid number');
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw malformed('A size in the archive is too large');
  return value;
}

/** POSIX sums the header's bytes unsigned; some historical tars summed them signed. The agent accepts both. */
function checksumOk(block: Buffer): boolean {
  const stored = octal(block, 148, 8);
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    const byte = index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
    unsigned += byte;
    signed += byte >= 0x80 ? byte - 0x100 : byte;
  }
  return stored === unsigned || stored === signed;
}

function parsePax(data: Buffer): Map<string, string> {
  const values = new Map<string, string>();
  let position = 0;
  while (position < data.length) {
    const space = data.indexOf(0x20, position);
    if (space === -1) throw malformed('A PAX header cannot be read');
    const length = Number.parseInt(data.subarray(position, space).toString('latin1'), 10);
    if (
      !Number.isSafeInteger(length) ||
      length <= space - position ||
      position + length > data.length
    ) {
      throw malformed('A PAX header cannot be read');
    }
    const record = data.subarray(space + 1, position + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals <= 0) throw malformed('A PAX header cannot be read');
    values.set(record.slice(0, equals), record.slice(equals + 1));
    position += length;
  }
  return values;
}

const isZero = (block: Buffer) => block.every((byte) => byte === 0);

export interface TarLimits {
  maxEntries: number;
}

/**
 * Reads an OVA's entries, header by header. The termination policy is the agent's (decision 0049, M6.1.1), so that
 * an archive an agent imports is one the server can list and clone:
 *
 * - The archive ends at a zero block, normally two. If a second block follows the first, it must be zeros too.
 * - Or it ends exactly where the last entry's padding ends, with no end marker at all, as VirtualBox writes some
 *   exports. Every entry has then been read whole, so nothing is missing.
 *
 * Anything else is refused: a cut inside a header, a file's data or its padding; an extended header with no entry
 * after it; a partial block; a header with a wrong checksum. Every boundary is decided exactly, never by the
 * file's size alone, and no declared size may reach past the end of the file.
 */
export async function readTar(
  source: RandomAccess,
  limits: TarLimits = { maxEntries: 10_000 },
): Promise<TarEntry[]> {
  if (source.sizeBytes < BLOCK) throw malformed('The file is too small to be an OVA');
  const entries: TarEntry[] = [];
  const names = new Set<string>();
  let offset = 0;
  let pax: Map<string, string> | null = null;
  let longName: string | null = null;
  const pending = () => pax !== null || longName !== null;
  const readBlock = async (at: number) => {
    const block = await source.read(at, BLOCK);
    if (block.length !== BLOCK) throw malformed('The archive ends in the middle of a header');
    return block;
  };
  for (;;) {
    // No end marker: complete only when the file ends exactly where the previous entry's padding ends.
    if (offset === source.sizeBytes && entries.length > 0) {
      if (pending()) {
        throw malformed(
          'The archive ends after an extended header, before the file it describes: it is truncated',
        );
      }
      break;
    }
    if (offset + BLOCK > source.sizeBytes) {
      throw malformed('The archive ends in the middle of a header: it is truncated');
    }
    const block = await readBlock(offset);
    if (isZero(block)) {
      if (offset + 2 * BLOCK <= source.sizeBytes && !isZero(await readBlock(offset + BLOCK))) {
        throw malformed('The archive has data after an empty header: it is damaged');
      }
      if (pending()) throw malformed('The archive ends inside an extended header');
      break;
    }
    if (!checksumOk(block)) throw malformed('A TAR header has an invalid checksum');
    const type = String.fromCharCode(block[156] ?? 0);
    const regular = type === '0' || type === '\0' || type === '7';
    let size = octal(block, 124, 12);
    if (regular && pax?.has('size')) {
      const declared = pax.get('size') as string;
      size = /^\d+$/u.test(declared) ? Number(declared) : Number.NaN;
      if (!Number.isSafeInteger(size)) throw malformed('A PAX size is invalid');
    }
    const dataOffset = offset + BLOCK;
    const next = dataOffset + Math.ceil(size / BLOCK) * BLOCK;
    if (!Number.isSafeInteger(next)) throw malformed('A size in the archive is too large');
    if (dataOffset + size > source.sizeBytes) {
      throw malformed('The archive ends in the middle of a file: it is truncated');
    }
    if (next > source.sizeBytes) {
      throw malformed('The archive ends in the padding after a file: it is truncated');
    }

    if (type === 'x' || type === 'g' || type === 'L') {
      if (size > 1024 * 1024) throw malformed('An extended header is unreasonably large');
      const data = await source.read(dataOffset, size);
      if (data.length !== size) throw malformed('The archive ends inside an extended header');
      if (type === 'x') pax = parsePax(data);
      else if (type === 'L') longName = field(data, 0, data.length);
      else {
        // Global records apply to every later entry; a path or size there makes no sense in an OVA.
        const global = parsePax(data);
        if (global.has('path') || global.has('size')) {
          throw malformed('The archive has a global PAX header that sets a path or size');
        }
      }
      offset = next;
      continue;
    }
    if (!regular) {
      throw malformed(
        type === '5' ? 'An OVA holds no directories' : 'An OVA holds only regular files',
      );
    }
    // POSIX ustar only: GNU headers ("ustar  ") use those bytes for other things.
    const prefix =
      block.subarray(257, 263).toString('latin1') === 'ustar\0' ? field(block, 345, 155) : '';
    let name = longName ?? (prefix ? `${prefix}/${field(block, 0, 100)}` : field(block, 0, 100));
    if (pax?.has('path')) name = pax.get('path') as string;
    pax = null;
    longName = null;
    if (name.startsWith('./')) name = name.slice(2);
    if (name.includes('/')) throw malformed(`${name} is in a directory, and an OVA is flat`);
    const problem = entryPathProblem(name);
    if (problem) throw malformed(`The entry ${JSON.stringify(name.slice(0, 200))} ${problem}`);
    const folded = name.toLowerCase();
    if (names.has(folded)) throw malformed(`${name} appears twice`);
    names.add(folded);
    const mtime = octal(block, 136, 12);
    entries.push({
      name,
      sizeBytes: size,
      dataOffset,
      modifiedAt: mtime > 0 ? new Date(mtime * 1000).toISOString() : null,
    });
    if (entries.length > limits.maxEntries) {
      throw new TarFormatError('limit', 'The archive has more entries than the server reads');
    }
    offset = next;
  }
  return entries;
}

/** What a clone checks of an OVA beyond its hash: a TAR, flat, with exactly one descriptor and that one first. */
export function checkOvaLayout(entries: TarEntry[]): void {
  const descriptors = entries.filter((entry) => entry.name.toLowerCase().endsWith('.ovf'));
  if (descriptors.length !== 1) {
    throw malformed('An OVA has exactly one OVF descriptor');
  }
  if (entries[0] !== descriptors[0]) {
    throw malformed('The OVF descriptor must be the first file in an OVA');
  }
}
