import { z } from 'zod';
import { emulatorTypeSchema } from './emulator.js';
import { sha256HexSchema, timestampSchema, vmVersionKindSchema } from './version.js';

/**
 * Looking inside a version's archive without downloading or restoring it (decision 0055). The server reads the
 * archive's structure over its own repository connection: a ZIP's central directory and manifest, or an OVA's tar
 * headers. Nothing is extracted.
 *
 * Two views. `logical`: the VM's files as the version restores them, from the archive's manifest, with each file's
 * size and SHA-256. Every EmuCat version, snapshots included, is a complete standalone archive (decision 0014), so a
 * snapshot's logical view is the whole VM and never a difference from its parent. `physical`: the entries actually
 * stored in the archive file, with their compressed sizes and methods, the manifest itself included.
 */

export const ARCHIVE_VIEWS = ['logical', 'physical'] as const;
export const archiveViewSchema = z.enum(ARCHIVE_VIEWS);
export type ArchiveView = z.infer<typeof archiveViewSchema>;

const sizeSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const archiveSummarySchema = z.object({
  vm: z.object({ emulatorType: emulatorTypeSchema, vmName: z.string(), title: z.string() }),
  version: z.object({
    id: z.uuid(),
    kind: vmVersionKindSchema,
    snapshotName: z.string().nullable(),
    title: z.string().nullable(),
    createdAt: timestampSchema,
  }),
  archive: z.object({
    format: z.enum(['zip', 'ova']),
    /** The object's name in the repository: the version UUID and the format's extension. */
    fileName: z.string(),
    repositoryName: z.string(),
    /** As registered, and checked against the object's size in the repository. */
    sizeBytes: sizeSchema,
    sha256: sha256HexSchema,
  }),
  /** Always true: every version is a complete archive, never a delta. Said explicitly for the interface. */
  complete: z.literal(true),
  /** A ZIP's EmuCat manifest. `null` for an OVA, which has none of EmuCat's. */
  manifest: z
    .object({
      manifestVersion: z.number().int(),
      vmName: z.string(),
      fileCount: sizeSchema,
      directoryCount: sizeSchema,
      totalUncompressedBytes: sizeSchema,
      sha256: sha256HexSchema,
      /** Whether it is the manifest this version's registration verified, when that is known. */
      matchesRegistration: z.boolean().nullable(),
    })
    .nullable(),
  physical: z.object({
    entryCount: sizeSchema,
    fileCount: sizeSchema,
    directoryCount: sizeSchema,
    compressedBytes: sizeSchema,
    uncompressedBytes: sizeSchema,
  }),
  views: z.array(archiveViewSchema),
  /** Things worth knowing that did not stop the listing. */
  warnings: z.array(z.string()),
});
export type ArchiveSummary = z.infer<typeof archiveSummarySchema>;

export const archiveEntrySchema = z.object({
  /** The last path segment. */
  name: z.string(),
  /** The full archive-relative path, with `/`. */
  path: z.string(),
  type: z.enum(['file', 'directory']),
  sizeBytes: sizeSchema.nullable(),
  /** Physical view only. */
  compressedSizeBytes: sizeSchema.nullable(),
  method: z.enum(['stored', 'deflated', 'other']).nullable(),
  /** Logical view only: the SHA-256 the manifest records. */
  sha256: sha256HexSchema.nullable(),
  /** Physical view only, as the archive records it (ZIP times have no zone). */
  modifiedAt: z.string().nullable(),
  /** Directories: how many entries are directly inside. */
  childCount: sizeSchema.nullable(),
});
export type ArchiveEntry = z.infer<typeof archiveEntrySchema>;

export const ARCHIVE_LISTING_MAX_LIMIT = 1000;

export const archiveListingQuerySchema = z.object({
  view: archiveViewSchema.default('logical'),
  /** A directory's path, `''` for the root. Ignored when `q` is given. */
  path: z.string().max(4096).default(''),
  /** Case-insensitive substring of the full path: a flat list of matches, anywhere. */
  q: z.string().trim().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(ARCHIVE_LISTING_MAX_LIMIT).default(500),
});
export type ArchiveListingQuery = z.infer<typeof archiveListingQuerySchema>;

export const archiveListingResponseSchema = z.object({
  view: archiveViewSchema,
  path: z.string(),
  q: z.string().nullable(),
  entries: z.array(archiveEntrySchema),
  total: sizeSchema,
  nextOffset: sizeSchema.nullable(),
});
export type ArchiveListingResponse = z.infer<typeof archiveListingResponseSchema>;

/** Why an archive could not be listed. The listing never changes anything, so each is safe to try again. */
export const ARCHIVE_INSPECTION_ERROR_TEXT: Record<string, string> = {
  server_repository_unavailable:
    'The server has no connection of its own to this repository. Set one up (see the deployment guide), then test it on the Repositories page.',
  archive_malformed: 'The archive is damaged or is not what EmuCat stores, so it was not listed.',
  archive_too_large:
    'The archive has more entries, or a larger directory, than the server lists. It was not changed.',
  remote_object_missing: 'The archive is not in the repository.',
  archive_size_mismatch:
    'The archive in the repository does not have the size that was registered. Verify this version.',
  version_deleted: 'This version is deleted or being deleted.',
};
