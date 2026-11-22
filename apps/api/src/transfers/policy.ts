import { TRANSFER_DEFAULT_CHUNK_BYTES } from '@emucat/contracts';

/**
 * Limits of the server's transfer staging area (decision 0055). Every value comes from the environment, with these
 * defaults; see docs/deployment.md for each variable.
 */
export interface TransferPolicy {
  /** The directory every staged transfer and server-side clone keeps its files in, one subdirectory each. */
  stagingPath: string;
  /** Whether agents may use the HTTPS relay at all. Server-side clones and inspection do not depend on it. */
  relayEnabled: boolean;
  /** The size of every upload chunk but the last, and the largest download range answered at once. */
  chunkBytes: number;
  /** What staged transfers may reserve in all, whatever the disk has free. */
  maxStagingBytes: number;
  /** What must stay free on the staging disk after a new reservation. */
  minFreeBytes: number;
  /** Uploads receiving, downloads staging and clones running, at once. */
  maxConcurrent: number;
  /** An unfinished transfer nobody touched for this long is discarded. */
  inactivityTimeoutSeconds: number;
  /** A finished transfer's files are kept this long after the last use, for a repeated request or resume. */
  retentionSeconds: number;
}

export const DEFAULT_TRANSFER_POLICY: TransferPolicy = {
  stagingPath: 'var/transfers',
  relayEnabled: true,
  chunkBytes: TRANSFER_DEFAULT_CHUNK_BYTES,
  maxStagingBytes: 100 * 1024 * 1024 * 1024,
  minFreeBytes: 2 * 1024 * 1024 * 1024,
  maxConcurrent: 4,
  inactivityTimeoutSeconds: 24 * 3600,
  retentionSeconds: 3600,
};
