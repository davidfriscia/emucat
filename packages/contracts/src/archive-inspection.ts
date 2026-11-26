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

/**
 * Archive Explorer (decision 0056): one file of a listed archive, named by its view and its canonical path exactly as
 * a listing returned it. The server resolves it in its own index of the archive; offsets, sizes and compression are
 * never taken from a request.
 */
export const archiveEntryQuerySchema = z.object({
  view: archiveViewSchema.default('logical'),
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine((path) => !path.startsWith('/') && !path.split('/').includes('..'), 'Invalid path'),
});
export type ArchiveEntryQuery = z.infer<typeof archiveEntryQuerySchema>;

export const ARCHIVE_PREVIEW_KINDS = ['text', 'hex', 'image', 'pdf'] as const;
export const archivePreviewKindSchema = z.enum(ARCHIVE_PREVIEW_KINDS);
export type ArchivePreviewKind = z.infer<typeof archivePreviewKindSchema>;

export const archivePreviewQuerySchema = archiveEntryQuerySchema.extend({
  kind: archivePreviewKindSchema,
  /** Hex only: the first byte shown. */
  offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
});
export type ArchivePreviewQuery = z.infer<typeof archivePreviewQuerySchema>;

/** What a file appears to be, from its first bytes (and, only where a format has no signature, its name). */
export const ARCHIVE_CONTENT_KINDS = ['text', 'markdown', 'image', 'pdf', 'binary'] as const;
export type ArchiveContentKind = (typeof ARCHIVE_CONTENT_KINDS)[number];

/** The ways a file can be shown. `rendered` is Markdown rendered as inert HTML. */
export const ARCHIVE_PREVIEW_MODES = ['text', 'rendered', 'image', 'pdf', 'hex'] as const;
export type ArchivePreviewMode = (typeof ARCHIVE_PREVIEW_MODES)[number];

export const archiveEntryDetailsSchema = z.object({
  view: archiveViewSchema,
  entry: archiveEntrySchema,
  /** How the bytes are stored in the archive. A TAR entry is always stored. */
  compression: z.enum(['stored', 'deflated']),
  /** A ZIP entry's recorded CRC-32, as eight hex digits. */
  crc32: z
    .string()
    .regex(/^[0-9a-f]{8}$/)
    .nullable(),
  /** The SHA-256 the EmuCat manifest records for this file, when there is one (ZIP archives). */
  manifestSha256: sha256HexSchema.nullable(),
  detected: z.object({
    kind: z.enum(ARCHIVE_CONTENT_KINDS),
    /** A short name of the format, such as `png`, `pdf` or `text`. */
    format: z.string(),
    /** A syntax highlighting language, for text. */
    language: z.string().nullable(),
    /** For text: the encoding detected from the first bytes, and how sure that is. */
    encoding: z
      .object({ name: z.string(), confidence: z.enum(['bom', 'valid', 'heuristic']) })
      .nullable(),
  }),
  /** The modes that can be shown, best first. Empty when nothing can (for example a file too large). */
  modes: z.array(z.enum(ARCHIVE_PREVIEW_MODES)),
  /** Why a mode that the format would allow is not offered, keyed by mode. */
  unavailable: z.record(z.string(), z.string()),
  hex: z.object({
    /** Whether any offset can be shown. A deflated entry can only be read up to `maxOffset`. */
    seekable: z.boolean(),
    maxOffset: sizeSchema,
    windowBytes: sizeSchema,
  }),
  download: z.object({ allowed: z.boolean(), maxBytes: sizeSchema }),
  limits: z.object({
    textBytes: sizeSchema,
    imageBytes: sizeSchema,
    pdfBytes: sizeSchema,
    imagePixels: sizeSchema,
  }),
});
export type ArchiveEntryDetails = z.infer<typeof archiveEntryDetailsSchema>;

/**
 * Response headers of a preview, whose body is the bytes themselves. `integrity` says what was proven: `verified`
 * (the whole entry, CRC-32 and, where the manifest has one, SHA-256), `complete` (the whole entry; the format has no
 * checksum, as in TAR) or `partial` (a part only: its structure was checked, no checksum covers a part).
 */
export const ARCHIVE_PREVIEW_HEADERS = {
  offset: 'x-emucat-preview-offset',
  length: 'x-emucat-preview-length',
  total: 'x-emucat-entry-size',
  truncated: 'x-emucat-preview-truncated',
  integrity: 'x-emucat-preview-integrity',
  format: 'x-emucat-image-format',
  width: 'x-emucat-image-width',
  height: 'x-emucat-image-height',
  converted: 'x-emucat-image-converted',
} as const;

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
  version_not_found: 'This version no longer exists.',
  inspection_busy: 'The server is reading other archives. Try again in a moment.',
  archive_view_unavailable: 'This archive has no such view. An OVA has only its stored entries.',
  archive_path_not_found: 'There is no such directory in the archive.',
  archive_timeout: 'Reading the archive took too long, so the server stopped. Try again.',
  request_cancelled: 'The request was cancelled.',
  repository_unreachable: 'The repository server cannot be reached from the EmuCat server.',
  repository_permission_denied: 'The server’s SSH account may not read this archive.',
  ssh_authentication_failed: 'The repository server refused the EmuCat server’s SSH key.',
  host_key_unknown: 'The repository server’s host key is not trusted by the EmuCat server.',
  host_key_changed: 'The repository server’s host key has changed. The server refused to connect.',
  upload_interrupted: 'The connection to the repository was interrupted. Try again.',
  repository_error: 'The repository server refused the request.',
  // Archive Explorer (decision 0056).
  entry_not_found: 'The archive has no such file.',
  entry_not_file: 'This is a directory: open it to see what it holds.',
  entry_unsupported: 'This entry cannot be read: it is encrypted, a link or a special file.',
  unsupported_compression: 'This entry uses a compression method the server does not read.',
  preview_unavailable: 'This file cannot be shown this way.',
  preview_too_large: 'This file is larger than the server previews this way.',
  preview_offset_unsupported:
    'This entry is compressed, so the server can only show its beginning.',
  download_too_large: 'This file is larger than the server downloads one file at a time.',
  archive_changed:
    'The archive in the repository changed since it was listed. Close and open the explorer again.',
  integrity_failed:
    'The file does not match its recorded checksum. The archive may be damaged: verify this version.',
  preview_busy: 'The server is already preparing as many previews as it allows. Try again shortly.',
  download_busy: 'The server is already sending as many files as it allows. Try again shortly.',
  image_invalid: 'The image is damaged or is not what its contents first suggested.',
  image_too_large: 'The image has more pixels than the server previews.',
  resource_limit: 'The server stopped: this would take more memory or time than it allows.',
};
