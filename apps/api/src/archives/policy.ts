/**
 * The resource policy of archive inspection and Archive Explorer (decision 0056). Every operation is bounded here,
 * independently of the container's memory limit: a listing by its entry count, directory and manifest size, time and
 * concurrency; the cache of listings by count, age and an estimated byte budget; a preview by its bytes, pixels,
 * time and concurrency; a single-file download by its size, time and concurrency.
 *
 * The defaults are sized for the API container's default 1 GiB limit, with transfers, clones and screenshot
 * processing running beside them. The worst case of the preview path is two image conversions at once, each holding
 * its input (20 MiB) and its decoded pixels (16.7 megapixels × 4 bytes ≈ 64 MiB) and its PNG: about 200 MiB in all.
 */
export interface ArchivePolicy {
  /** Listing (index construction). */
  inspection: {
    maxEntries: number;
    maxDirectoryBytes: number;
    maxManifestBytes: number;
    maxConcurrent: number;
    timeoutMs: number;
  };
  cache: {
    maxIndexes: number;
    ttlMs: number;
    /** An estimate of the listings' weight in memory, not a measurement of the process. */
    maxBytes: number;
  };
  preview: {
    textBytes: number;
    hexBytes: number;
    imageBytes: number;
    imagePixels: number;
    pdfBytes: number;
    /** How far into a deflated entry a hex preview may start: everything before it has to be inflated. */
    maxSeekBytes: number;
    maxConcurrent: number;
    timeoutMs: number;
  };
  download: {
    maxBytes: number;
    maxConcurrent: number;
    timeoutMs: number;
  };
}

const MiB = 1024 * 1024;

export const DEFAULT_ARCHIVE_POLICY: ArchivePolicy = {
  inspection: {
    maxEntries: 200_000,
    maxDirectoryBytes: 64 * MiB,
    maxManifestBytes: 64 * MiB,
    maxConcurrent: 2,
    timeoutMs: 120_000,
  },
  cache: { maxIndexes: 8, ttlMs: 600_000, maxBytes: 64 * MiB },
  preview: {
    textBytes: 256 * 1024,
    hexBytes: 64 * 1024,
    imageBytes: 20 * MiB,
    imagePixels: 16_777_216,
    pdfBytes: 25 * MiB,
    maxSeekBytes: 16 * MiB,
    maxConcurrent: 2,
    timeoutMs: 60_000,
  },
  download: { maxBytes: 100 * MiB, maxConcurrent: 2, timeoutMs: 1_800_000 },
};
