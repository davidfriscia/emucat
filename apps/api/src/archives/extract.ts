import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { crc32, createInflateRaw } from 'node:zlib';

/**
 * Selective extraction of one archive entry over random access (decision 0056). Only the entry's local header (ZIP)
 * and its own bytes are read, in bounded chunks; nothing is written anywhere. Compressed data is inflated by zlib's
 * streaming inflater, which runs on the thread pool, never all at once on the event loop.
 *
 * A locator is built by the server from a central directory or TAR headers it has already validated; it never comes
 * from a request. Everything it says is still checked again against the bytes it points at before they are used, so
 * that a replaced or damaged object cannot make the server read or return something else.
 */

export interface ExtractSource {
  readonly sizeBytes: number;
  read(offset: number, length: number, signal?: AbortSignal): Promise<Buffer>;
}

export interface ZipLocator {
  format: 'zip';
  /** The central directory's name, as stored (directories end with `/`). */
  name: string;
  localHeaderOffset: number;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  crc32: number;
  flags: number;
  /** Where the central directory starts: no entry's data may reach past it. */
  limit: number;
}

export interface TarLocator {
  format: 'tar';
  dataOffset: number;
  sizeBytes: number;
}

export type EntryLocator = ZipLocator | TarLocator;

export type ExtractErrorKind =
  'malformed' | 'unsupported_compression' | 'encrypted' | 'integrity' | 'seek_unsupported';

export class ExtractError extends Error {
  override readonly name = 'ExtractError';

  constructor(
    readonly kind: ExtractErrorKind,
    message: string,
  ) {
    super(message);
  }
}

const malformed = (message: string) => new ExtractError('malformed', message);

const SIG_LOCAL = 0x04034b50;
const MAX_U32 = 0xffffffff;
/** Deflate cannot expand data by more than about 1032:1; a claim beyond that is a lie or a bomb. */
const MAX_DEFLATE_RATIO = 1032;
/** One read from the repository. With the SFTP window, at most this much is held per extraction. */
export const EXTRACT_CHUNK_BYTES = 1024 * 1024;

export function entrySize(locator: EntryLocator): number {
  return locator.format === 'zip' ? locator.uncompressedSize : locator.sizeBytes;
}

export function compressionOf(locator: EntryLocator): 'stored' | 'deflated' {
  return locator.format === 'zip' && locator.method === 8 ? 'deflated' : 'stored';
}

/** Whether any byte offset can be read directly, without decompressing what comes before it. */
export function seekable(locator: EntryLocator): boolean {
  return compressionOf(locator) === 'stored';
}

/** Checks a locator's own claims, before anything is read for it. */
function checkLocator(source: ExtractSource, locator: EntryLocator): void {
  if (locator.format === 'tar') {
    if (
      !Number.isSafeInteger(locator.dataOffset) ||
      !Number.isSafeInteger(locator.sizeBytes) ||
      locator.dataOffset < 0 ||
      locator.sizeBytes < 0 ||
      locator.dataOffset + locator.sizeBytes > source.sizeBytes
    ) {
      throw malformed('The entry runs past the end of the archive');
    }
    return;
  }
  if ((locator.flags & (0x0001 | 0x0020 | 0x0040)) !== 0) {
    throw new ExtractError('encrypted', 'The entry is encrypted');
  }
  if (locator.method !== 0 && locator.method !== 8) {
    throw new ExtractError('unsupported_compression', 'The entry uses an unsupported compression');
  }
  for (const value of [
    locator.localHeaderOffset,
    locator.compressedSize,
    locator.uncompressedSize,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) throw malformed('The entry has invalid sizes');
  }
  if (locator.limit > source.sizeBytes)
    throw malformed('The archive is shorter than its directory');
  if (locator.method === 0 && locator.compressedSize !== locator.uncompressedSize) {
    throw malformed('A stored entry has two different sizes');
  }
  if (
    locator.method === 8 &&
    locator.uncompressedSize > locator.compressedSize * MAX_DEFLATE_RATIO + 4096
  ) {
    throw malformed('The entry claims more than deflate can produce from its data');
  }
}

/**
 * Where a ZIP entry's data starts, from its local header, which must name the same file with the same method, and,
 * where it records them, the same CRC and sizes as the central directory. The data must end before the directory.
 */
async function zipDataOffset(
  source: ExtractSource,
  locator: ZipLocator,
  signal?: AbortSignal,
): Promise<number> {
  const expectedName = Buffer.from(locator.name, 'utf8');
  const header = await source.read(locator.localHeaderOffset, 30 + expectedName.length, signal);
  if (header.length < 30 || header.readUInt32LE(0) !== SIG_LOCAL) {
    throw malformed('The entry’s local header is damaged');
  }
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  if (nameLength !== expectedName.length || !header.subarray(30).equals(expectedName)) {
    throw malformed('The entry’s local header names another file');
  }
  if (header.readUInt16LE(8) !== locator.method) {
    throw malformed('The entry’s local header has another compression method');
  }
  const localFlags = header.readUInt16LE(6);
  if ((localFlags & (0x0001 | 0x0020 | 0x0040)) !== 0) {
    throw new ExtractError('encrypted', 'The entry is encrypted');
  }
  if ((localFlags & 0x0008) === 0) {
    // Without a data descriptor, the local header carries the real values (or ZIP64 markers).
    const localCrc = header.readUInt32LE(14);
    const localCompressed = header.readUInt32LE(18);
    const localUncompressed = header.readUInt32LE(22);
    if (localCrc >>> 0 !== locator.crc32 >>> 0) {
      throw malformed('The entry’s local header has another CRC');
    }
    if (localCompressed !== MAX_U32 && localCompressed !== locator.compressedSize) {
      throw malformed('The entry’s local header has another compressed size');
    }
    if (localUncompressed !== MAX_U32 && localUncompressed !== locator.uncompressedSize) {
      throw malformed('The entry’s local header has another size');
    }
  }
  const dataOffset = locator.localHeaderOffset + 30 + nameLength + extraLength;
  if (dataOffset + locator.compressedSize > locator.limit) {
    throw malformed('The entry’s data overlaps the central directory');
  }
  return dataOffset;
}

async function* rawChunks(
  source: ExtractSource,
  start: number,
  end: number,
  signal: AbortSignal | undefined,
  chunkBytes: number,
): AsyncGenerator<Buffer> {
  let position = start;
  while (position < end) {
    if (signal?.aborted) throw signal.reason ?? new Error('Cancelled');
    const length = Math.min(chunkBytes, end - position);
    const piece = await source.read(position, length, signal);
    if (piece.length !== length) throw malformed('The archive ended inside the entry');
    position += length;
    yield piece;
  }
}

export interface ReadOptions {
  /** The first byte of the entry wanted. */
  start?: number;
  signal?: AbortSignal;
  /** For a deflated entry: how far into the entry a start may be, since everything before it is inflated. */
  maxSeekBytes?: number;
  chunkBytes?: number;
}

/**
 * The entry's bytes from `start` to its end, in order, as they are read. Stops reading as soon as the consumer stops.
 * Never yields more than the entry's recorded size, whatever the data inflates to.
 */
export async function* entryChunks(
  source: ExtractSource,
  locator: EntryLocator,
  options: ReadOptions = {},
): AsyncGenerator<Buffer> {
  const { signal, chunkBytes = EXTRACT_CHUNK_BYTES } = options;
  const start = options.start ?? 0;
  checkLocator(source, locator);
  const size = entrySize(locator);
  if (!Number.isSafeInteger(start) || start < 0 || start > size) {
    throw new ExtractError('seek_unsupported', 'The offset is outside the entry');
  }
  const dataOffset =
    locator.format === 'tar' ? locator.dataOffset : await zipDataOffset(source, locator, signal);

  if (locator.format === 'tar' || locator.method === 0) {
    yield* rawChunks(source, dataOffset + start, dataOffset + size, signal, chunkBytes);
    return;
  }

  if (start > (options.maxSeekBytes ?? 0)) {
    throw new ExtractError(
      'seek_unsupported',
      'This entry is deflated: reaching that offset would mean decompressing everything before it',
    );
  }
  const inflater = createInflateRaw({ chunkSize: 64 * 1024 });
  const input = Readable.from(
    rawChunks(source, dataOffset, dataOffset + locator.compressedSize, signal, chunkBytes),
    { objectMode: false, highWaterMark: chunkBytes },
  );
  input.once('error', (error) => inflater.destroy(error));
  input.pipe(inflater);
  let produced = 0;
  try {
    for await (const chunk of inflater) {
      const piece = chunk as Buffer;
      const from = produced;
      produced += piece.length;
      if (produced > size) throw malformed('The entry inflates to more than its recorded size');
      if (produced <= start) continue;
      yield from >= start ? piece : piece.subarray(start - from);
    }
  } catch (error) {
    if (error instanceof ExtractError) throw error;
    if (signal?.aborted) throw signal.reason ?? error;
    if ((error as { code?: string }).code?.startsWith('Z_')) {
      throw malformed('The entry cannot be decompressed');
    }
    throw error;
  } finally {
    input.unpipe(inflater);
    input.destroy();
    inflater.destroy();
  }
  if (produced !== size) throw malformed('The entry inflates to less than its recorded size');
}

/** What could be proven about bytes handed out. */
export type IntegrityLevel =
  /** Every byte was read and its CRC-32 (ZIP) and the manifest's SHA-256 (where known) matched. */
  | 'verified'
  /** Every byte was read and its structure checked; the format records no checksum for it (TAR). */
  | 'complete'
  /** Only part was read: its header and structure are consistent, but no checksum covers a part. */
  | 'partial';

/** Checks a whole entry as it goes by: CRC-32 for ZIP, the manifest's SHA-256 when there is one. */
export class EntryVerifier {
  private crc = 0;
  private size = 0;
  private readonly hash;

  constructor(
    private readonly locator: EntryLocator,
    private readonly sha256: string | null,
  ) {
    this.hash = sha256 ? createHash('sha256') : null;
  }

  update(chunk: Buffer): void {
    if (this.locator.format === 'zip') this.crc = crc32(chunk, this.crc);
    this.hash?.update(chunk);
    this.size += chunk.length;
  }

  /** Throws unless everything matched. Says how much was proven. */
  finish(): IntegrityLevel {
    if (this.size !== entrySize(this.locator)) {
      throw new ExtractError('integrity', 'The entry does not have its recorded size');
    }
    if (this.locator.format === 'zip' && this.crc >>> 0 !== this.locator.crc32 >>> 0) {
      throw new ExtractError('integrity', 'The entry does not match its CRC-32');
    }
    if (this.hash && this.hash.digest('hex') !== this.sha256) {
      throw new ExtractError('integrity', 'The entry does not match the manifest’s SHA-256');
    }
    return this.locator.format === 'zip' || this.sha256 ? 'verified' : 'complete';
  }
}

export interface Extracted {
  data: Buffer;
  start: number;
  /** The entry's whole size. */
  totalBytes: number;
  /** Whether `data` ends before the entry does. */
  truncated: boolean;
  integrity: IntegrityLevel;
}

/**
 * Up to `maxBytes` of an entry from `start`, in memory. When that is the whole entry, it is verified before it is
 * returned, and a mismatch is an error rather than data.
 */
export async function readEntry(
  source: ExtractSource,
  locator: EntryLocator,
  maxBytes: number,
  options: ReadOptions & { sha256?: string | null } = {},
): Promise<Extracted> {
  const start = options.start ?? 0;
  const total = entrySize(locator);
  const wanted = Math.max(0, Math.min(maxBytes, total - Math.min(start, total)));
  const whole = start === 0 && wanted === total;
  const verifier = whole ? new EntryVerifier(locator, options.sha256 ?? null) : null;
  const pieces: Buffer[] = [];
  let have = 0;
  if (wanted > 0 || whole) {
    const chunks = entryChunks(source, locator, {
      ...options,
      // A stored prefix needs exactly its own bytes; a deflated one at least a few KiB of input per read.
      chunkBytes: Math.min(
        options.chunkBytes ?? EXTRACT_CHUNK_BYTES,
        Math.max(compressionOf(locator) === 'stored' ? 1 : 16 * 1024, wanted),
      ),
    });
    try {
      for await (const chunk of chunks) {
        const piece = have + chunk.length > wanted ? chunk.subarray(0, wanted - have) : chunk;
        pieces.push(piece);
        verifier?.update(piece);
        have += piece.length;
        if (have >= wanted && !whole) break;
      }
    } finally {
      await chunks.return(undefined);
    }
  }
  const integrity = verifier ? verifier.finish() : 'partial';
  return {
    data: Buffer.concat(pieces, have),
    start,
    totalBytes: total,
    truncated: start + have < total,
    integrity,
  };
}
