/**
 * What a browser-local archive index holds, and what crosses from the worker to the page (decision 0058). An entry is
 * identified by its position in its archive, never by its path: two entries with the same path stay two entries, and
 * nothing is ever looked up by a name that an archive chose.
 */

/** Formats the browser opens. `gzip` is a single compressed file; `tar.gz` is a TAR inside GZIP. */
export const LOCAL_ARCHIVE_FORMATS = ['zip', 'tar', 'ova', 'gzip', 'tar.gz'] as const;
export type LocalArchiveFormat = (typeof LOCAL_ARCHIVE_FORMATS)[number];

export type LocalEntryType = 'file' | 'directory' | 'link' | 'special';

export interface LocalEntry {
  /** Position in the archive: the entry's identity. */
  index: number;
  /** The path to show, with `/`. For an unsafe path, the name as stored, at the root, never resolved. */
  path: string;
  name: string;
  type: LocalEntryType;
  sizeBytes: number;
  compressedSizeBytes: number | null;
  method: 'stored' | 'deflated' | 'other';
  /** A ZIP entry's recorded CRC-32, as eight hex digits. */
  crc32: string | null;
  modifiedAt: string | null;
  /** The stored name was unsafe as a path: it is shown whole at the root and never interpreted or read. */
  unsafePath: boolean;
  /** Why the entry cannot be read, or `null` when it can. */
  problem: string | null;
  /** When the entry looks like an archive the browser can open: by its first bytes, or (compressed) its name. */
  archive: { format: LocalArchiveFormat; by: 'signature' | 'name' } | null;
  /** An archive format recognized and not supported, such as `7z`. */
  unsupportedArchive: string | null;
}

export interface LocalArchiveIndex {
  format: LocalArchiveFormat;
  entries: LocalEntry[];
  /** Things worth knowing that did not stop the listing: unsafe or duplicate paths, links, encrypted entries. */
  warnings: string[];
  /** Whether the archive's own structure carries a checksum per entry (ZIP, GZIP) or none (TAR). */
  checksummed: boolean;
}

/** What one opened archive costs in memory, as accounted by the cache. */
export interface ArchiveCost {
  payloadBytes: number;
  indexBytes: number;
}

export const indexWeight = (entries: readonly LocalEntry[]): number =>
  entries.reduce((sum, entry) => sum + 160 + 2 * (entry.path.length + entry.name.length), 0);
