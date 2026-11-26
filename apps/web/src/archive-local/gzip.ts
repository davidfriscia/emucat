import { u16, u32 } from './bytes';
import { LocalArchiveError } from './errors';
import { inflateBounded } from './inflate';
import type { Operation } from './operation';

/**
 * GZIP (RFC 1952), one member, decompressed whole with the bounded inflater. The size the trailer records is checked
 * against the limit before anything is decompressed, and decompression still stops at that size whatever the stream
 * contains; the result must then match the trailer's size and CRC-32. Multi-member files (rare) fail that check.
 */

export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 18 && bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 8;
}

export interface GzipHeader {
  /** The original file name the header records, if any. */
  name: string | null;
  modifiedAt: string | null;
  bodyStart: number;
  /** The trailer's size, modulo 2^32. */
  size: number;
  crc32: number;
}

export function readGzipHeader(bytes: Uint8Array): GzipHeader {
  if (!isGzip(bytes)) throw new LocalArchiveError('malformed');
  const flags = bytes[3] ?? 0;
  if (flags & 0xe0) throw new LocalArchiveError('malformed');
  let at = 10;
  if (flags & 0x04) {
    at += 2 + u16(bytes, at);
  }
  let name: string | null = null;
  const zeroTerminated = () => {
    const end = bytes.indexOf(0, at);
    if (end === -1) throw new LocalArchiveError('malformed');
    const text = new TextDecoder('latin1').decode(bytes.subarray(at, end));
    at = end + 1;
    return text;
  };
  if (flags & 0x08) name = zeroTerminated();
  if (flags & 0x10) zeroTerminated();
  if (flags & 0x02) at += 2;
  if (at + 8 > bytes.length) throw new LocalArchiveError('truncated');
  const mtime = u32(bytes, 4);
  return {
    name,
    modifiedAt: mtime > 0 ? new Date(mtime * 1000).toISOString() : null,
    bodyStart: at,
    size: u32(bytes, bytes.length - 4),
    crc32: u32(bytes, bytes.length - 8),
  };
}

export async function gunzipBounded(
  bytes: Uint8Array,
  maxBytes: number,
  operation: Operation,
): Promise<{ header: GzipHeader; data: Uint8Array }> {
  const header = readGzipHeader(bytes);
  // The trailer holds the size modulo 2^32: anything this large is beyond every browser limit anyway.
  if (header.size > maxBytes) throw new LocalArchiveError('archive_too_large');
  const body = bytes.subarray(header.bodyStart, bytes.length - 8);
  const result = await inflateBounded(body, {
    wanted: header.size,
    maxOutput: header.size,
    whole: true,
    operation,
  });
  if (result.crc32 !== header.crc32) throw new LocalArchiveError('integrity_failed');
  return { header, data: result.data };
}
