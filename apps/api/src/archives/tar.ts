import type { RandomAccess } from './zip.js';
import { entryPathProblem } from './manifest.js';

/**
 * The structure of an OVA (a POSIX TAR, decision 0045), read header by header through random access, so that a
 * listing never reads a disk image. Only what an agent's restore accepts is accepted: regular files in one flat
 * directory, ustar or GNU headers with valid checksums, PAX headers only for long names and sizes, the OVF
 * descriptor first and only once. Anything else is refused rather than skipped.
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

function checksumOk(block: Buffer): boolean {
  const stored = octal(block, 148, 8);
  let unsigned = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    unsigned += index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
  }
  return stored === unsigned;
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

export async function readTar(
  source: RandomAccess,
  limits: TarLimits = { maxEntries: 10_000 },
): Promise<TarEntry[]> {
  if (source.sizeBytes < BLOCK * 2) throw malformed('The file is too small to be an OVA');
  const entries: TarEntry[] = [];
  const names = new Set<string>();
  let offset = 0;
  let pax: Map<string, string> | null = null;
  let longName: string | null = null;
  let ended = false;
  while (offset + BLOCK <= source.sizeBytes) {
    const block = await source.read(offset, BLOCK);
    if (isZero(block)) {
      ended = true;
      break;
    }
    if (!checksumOk(block)) throw malformed('A TAR header has an invalid checksum');
    const type = String.fromCharCode(block[156] ?? 0);
    let size = octal(block, 124, 12);
    const dataOffset = offset + BLOCK;
    const next = dataOffset + Math.ceil(size / BLOCK) * BLOCK;
    if (next > source.sizeBytes) throw malformed('An entry runs past the end of the archive');

    if (type === 'x' || type === 'L') {
      if (size > 1024 * 1024) throw malformed('An extended header is unreasonably large');
      const data = await source.read(dataOffset, size);
      if (type === 'x') pax = parsePax(data);
      else longName = field(data, 0, data.length);
      offset = next;
      continue;
    }
    if (type !== '0' && type !== '\0') {
      throw malformed(
        type === '5' ? 'An OVA holds no directories' : 'An OVA holds only regular files',
      );
    }
    const prefix = block.subarray(257, 263).toString('latin1').startsWith('ustar')
      ? field(block, 345, 155)
      : '';
    let name = longName ?? (prefix ? `${prefix}/${field(block, 0, 100)}` : field(block, 0, 100));
    if (pax?.has('path')) name = pax.get('path') as string;
    if (pax?.has('size')) {
      size = Number(pax.get('size'));
      if (!Number.isSafeInteger(size) || size < 0) throw malformed('A PAX size is invalid');
    }
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
    offset = dataOffset + Math.ceil(size / BLOCK) * BLOCK;
  }
  if (!ended) throw malformed('The archive has no end marker');
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
