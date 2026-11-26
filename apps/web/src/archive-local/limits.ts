/**
 * The browser's own limits for archives opened inside an archive (decision 0058). They bound what one tab may hold or
 * decompress for Archive Explorer, independently of the server's limits, which still apply to everything the server
 * sends. Each value is an upper bound enforced on actual bytes, never only on what an archive declares.
 *
 * The retained-cache budget bounds what Archive Explorer keeps between operations (payloads and an estimate of their
 * indexes). It is not a bound on the tab's memory: an operation in progress also holds its own transient buffers
 * (see docs/archive-explorer.md, "Browser memory").
 */
export interface LocalArchiveLimits {
  /** Bytes of one nested archive: a top-level one downloaded, or one decompressed from inside another. */
  maxArchiveBytes: number;
  /** Archives within archives, the first one opened from the outer master or snapshot being depth 1. */
  maxDepth: number;
  /** Payloads and estimated index weight kept in memory, least recently used out first. */
  cacheBytes: number;
  /** Entries of one nested archive. */
  maxEntries: number;
  /** Archives being downloaded or indexed at once; a few more may wait. */
  maxConcurrentOpens: number;
  maxQueuedOpens: number;
  textBytes: number;
  hexBytes: number;
  /** How far into a deflated entry a hex window may start: everything before it has to be decompressed. */
  maxSeekBytes: number;
  imageBytes: number;
  imagePixels: number;
  pdfBytes: number;
  /** One file of a nested archive saved by the browser. */
  downloadBytes: number;
  /** One path, in UTF-8 bytes. */
  maxPathBytes: number;
  /** Indexing one archive, or reading one entry, in milliseconds. */
  operationTimeoutMs: number;
}

const MiB = 1024 * 1024;

export const DEFAULT_LOCAL_LIMITS: Readonly<LocalArchiveLimits> = Object.freeze({
  maxArchiveBytes: 64 * MiB,
  maxDepth: 5,
  cacheBytes: 128 * MiB,
  maxEntries: 20_000,
  maxConcurrentOpens: 2,
  maxQueuedOpens: 4,
  textBytes: 256 * 1024,
  hexBytes: 64 * 1024,
  maxSeekBytes: 16 * MiB,
  imageBytes: 20 * MiB,
  imagePixels: 16_777_216,
  pdfBytes: 25 * MiB,
  downloadBytes: 100 * MiB,
  maxPathBytes: 4096,
  operationTimeoutMs: 60_000,
});
