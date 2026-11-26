import { Inflate } from 'fflate';
import { crc32 } from './bytes';
import { LocalArchiveError } from './errors';
import type { Operation } from './operation';

/**
 * Raw deflate, decompressed in small slices with a hard bound on what it produces (decision 0058). Input is pushed
 * 4 KiB at a time, so one push can produce at most a few MiB whatever the data is (deflate expands at most about
 * 1032:1), and output is copied into a buffer sized for what is wanted, never grown. Decompression stops as soon as
 * enough was produced, or fails as soon as the stream produces more than it may.
 */

const SLICE = 4096;

export interface InflateOptions {
  /** Bytes wanted. Decompression stops once this many were produced. */
  wanted: number;
  /**
   * What the stream may produce in all, when it is decompressed to its end: more is an error. For an entry read
   * whole, its declared size, which must itself be within the limits.
   */
  maxOutput: number;
  /** Whether the whole stream is wanted (its end must be reached and its size be exactly `maxOutput`). */
  whole: boolean;
  operation: Operation;
}

export interface InflateResult {
  data: Uint8Array;
  /** Whether the stream ended. */
  ended: boolean;
  /** CRC-32 of `data`, when the stream was read whole. */
  crc32: number | null;
}

export async function inflateBounded(
  input: Uint8Array,
  options: InflateOptions,
): Promise<InflateResult> {
  const { wanted, maxOutput, whole, operation } = options;
  const capacity = Math.min(wanted, maxOutput);
  const output = new Uint8Array(capacity);
  let produced = 0;
  let total = 0;
  let ended = false;
  let failure: LocalArchiveError | null = null;
  let crc = 0;
  const inflater = new Inflate((chunk, final) => {
    total += chunk.length;
    if (total > maxOutput && whole) {
      failure ??= new LocalArchiveError('decompression_limit');
      return;
    }
    const room = capacity - produced;
    if (room > 0) {
      const part = chunk.length <= room ? chunk : chunk.subarray(0, room);
      output.set(part, produced);
      if (whole) crc = crc32(part, crc);
      produced += part.length;
    }
    if (final) ended = true;
  });
  try {
    for (let at = 0; at < input.length && !ended; at += SLICE) {
      const end = Math.min(input.length, at + SLICE);
      operation.check();
      inflater.push(input.subarray(at, end), end === input.length);
      if (failure) throw failure;
      if (!whole && produced >= capacity) break;
      if ((at / SLICE) % 64 === 63) await operation.checkpoint();
    }
  } catch (error) {
    if (error instanceof LocalArchiveError) throw error;
    // fflate's code 0 is an unexpected end of the stream.
    throw new LocalArchiveError(
      (error as { code?: number }).code === 0 ? 'truncated' : 'malformed',
    );
  }
  if (failure) throw failure;
  if (whole) {
    if (!ended) throw new LocalArchiveError('truncated');
    if (total !== maxOutput) throw new LocalArchiveError('integrity_failed');
  }
  return { data: output.subarray(0, produced), ended, crc32: whole ? crc : null };
}
