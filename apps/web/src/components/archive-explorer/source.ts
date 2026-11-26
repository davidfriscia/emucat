import type {
  ArchiveEntry,
  ArchiveEntryDetails,
  ArchivePreviewKind,
  ArchiveView,
  VmIdentity,
} from '@emucat/contracts';
import {
  downloadArchiveFile,
  fetchArchiveEntry,
  fetchArchivePreview,
  type ArchivePreviewBytes,
} from '../../api';
import type { LocalArchiveClient } from '../../archive-local/client';
import type { LocalDetails, LocalImageRead } from '../../archive-local/engine';
import { LocalArchiveError } from '../../archive-local/errors';
import type { LocalArchiveFormat, LocalEntry } from '../../archive-local/model';

/**
 * Where a file's bytes come from (decision 0058). Archive Explorer shows two kinds of file with the same panel and
 * the same viewers:
 *
 * - `remote`: a file of the version's archive, read by the server over its repository connection (decision 0056).
 * - `nested`: a file inside an archive that is itself inside the version's archive, read in the browser's archive
 *   worker from bytes it already holds. Nothing about it is ever sent back to the server.
 *
 * Both produce the server's own shapes (`ArchiveEntryDetails`, `ArchivePreviewBytes`), so the viewers need not know
 * which one they show; what differs, and must not be confused, is what an integrity result means. `integrityScope`
 * says it.
 */

/** One segment of a file's location, for the breadcrumb: a directory or an archive, and how to reveal it. */
export interface Crumb {
  label: string;
  kind: 'archive' | 'directory' | 'file' | 'root';
  /** The tree row it stands for, or `null` for the root. */
  rowKey: string | null;
}

/** The archive a nested file is in, for its information panel. */
export interface NestedContainer {
  archiveId: string;
  name: string;
  format: LocalArchiveFormat;
  depth: number;
  payloadBytes: number;
  checksummed: boolean;
  /** Each archive from the outermost nested one to this one, as the breadcrumb names them. */
  chain: string[];
  /** Their ids, outermost first: what must stay in memory while this file is shown. */
  archiveIds: string[];
}

export interface FileSource {
  /** Unique within the dialog: a file panel is mounted once per key. */
  key: string;
  name: string;
  /** The path to show, across archive boundaries: `utilities.zip › docs › a.txt`. */
  displayPath: string;
  location: Crumb[];
  origin: 'remote' | 'nested';
  /**
   * `server`: checked by the server against the archive's CRC-32 and, where known, the EmuCat manifest's SHA-256.
   * `nested-crc`: checked in the browser against the CRC-32 the nested archive records, which detects damage but
   * proves nothing about who made it. `nested-none`: the nested format records no checksum (TAR).
   */
  integrityScope: 'server' | 'nested-crc' | 'nested-none';
  /** What the listing said, shown while the details load or when the entry cannot be read. */
  listing: ArchiveEntry;
  /** Why the entry cannot be read at all (nested entries only), or `null`. */
  problem: string | null;
  container: NestedContainer | null;
  /** When the file is itself an archive the tree can open: the row to expand. */
  archiveRowKey: string | null;
  details(signal: AbortSignal): Promise<ArchiveEntryDetails>;
  preview(
    kind: Exclude<ArchivePreviewKind, 'hex'>,
    signal: AbortSignal,
  ): Promise<ArchivePreviewBytes>;
  hex(offset: number, signal: AbortSignal): Promise<ArchivePreviewBytes>;
  download(options: {
    signal: AbortSignal;
    onProgress?: (received: number, total: number) => void;
  }): Promise<Blob>;
}

export function remoteSource(options: {
  vm: VmIdentity;
  versionId: string;
  view: ArchiveView;
  entry: ArchiveEntry;
  rowKey: string;
  location: Crumb[];
  archiveRowKey: string | null;
}): FileSource {
  const { vm, versionId, view, entry } = options;
  const identity = { emulatorType: vm.emulatorType, vmName: vm.vmName };
  const file = { view, path: entry.path };
  return {
    key: options.rowKey,
    name: entry.name,
    displayPath: entry.path,
    location: options.location,
    origin: 'remote',
    integrityScope: 'server',
    listing: entry,
    problem: null,
    container: null,
    archiveRowKey: options.archiveRowKey,
    details: (signal) => fetchArchiveEntry(identity, versionId, file, signal),
    preview: (kind, signal) => fetchArchivePreview(identity, versionId, file, kind, { signal }),
    hex: (offset, signal) =>
      fetchArchivePreview(identity, versionId, file, 'hex', { offset, signal }),
    download: ({ signal, onProgress }) =>
      downloadArchiveFile(identity, versionId, file, { signal, onProgress }),
  };
}

/** A listing entry in the server's shape, from a nested archive's entry. */
export function nestedListing(entry: LocalEntry): ArchiveEntry {
  return {
    name: entry.name,
    path: entry.path,
    type: entry.type === 'directory' ? 'directory' : 'file',
    sizeBytes: entry.sizeBytes,
    compressedSizeBytes: entry.compressedSizeBytes,
    method: entry.method,
    sha256: null,
    modifiedAt: entry.modifiedAt,
    childCount: null,
  };
}

function nestedDetails(view: ArchiveView, local: LocalDetails): ArchiveEntryDetails {
  return {
    view,
    entry: nestedListing(local.entry),
    compression: local.compression,
    crc32: local.crc32,
    // The EmuCat manifest describes the outer archive's files only: no inner file has a SHA-256 from it.
    manifestSha256: null,
    detected: local.detected,
    modes: local.modes,
    unavailable: local.unavailable,
    hex: local.hex,
    download: local.download,
    limits: local.limits,
  };
}

/** Draws decoded pixels into a PNG, in memory, for the image viewer. */
async function rgbaToPng(image: NonNullable<LocalImageRead['rgba']>): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d');
  if (!context) throw new LocalArchiveError('image_invalid', 'This browser cannot draw the image.');
  context.putImageData(
    new ImageData(image.data as Uint8ClampedArray<ArrayBuffer>, image.width, image.height),
    0,
    0,
  );
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) throw new LocalArchiveError('image_invalid', 'This browser cannot draw the image.');
  return new Uint8Array(await blob.arrayBuffer());
}

export function nestedSource(options: {
  client: LocalArchiveClient;
  view: ArchiveView;
  container: NestedContainer;
  entry: LocalEntry;
  rowKey: string;
  location: Crumb[];
  archiveRowKey: string | null;
}): FileSource {
  const { client, view, container, entry } = options;
  const id = container.archiveId;
  const index = entry.index;
  return {
    key: options.rowKey,
    name: entry.name,
    displayPath: [
      ...container.chain,
      ...(entry.unsafePath ? [entry.path] : entry.path.split('/')),
    ].join(' › '),
    location: options.location,
    origin: 'nested',
    integrityScope: container.checksummed ? 'nested-crc' : 'nested-none',
    listing: nestedListing(entry),
    problem: entry.problem,
    container,
    archiveRowKey: options.archiveRowKey,
    details: async (signal) => nestedDetails(view, await client.details(id, index, signal)),
    preview: async (kind, signal) => {
      if (kind === 'image') {
        const read = await client.image(id, index, signal);
        const bytes = read.rgba ? await rgbaToPng(read.rgba) : read.bytes;
        return { ...read, bytes, contentType: read.rgba ? 'image/png' : read.contentType };
      }
      const read = await client.read(id, index, kind, 0, signal);
      return { ...read, contentType: 'application/octet-stream', image: null };
    },
    hex: async (offset, signal) => {
      const read = await client.read(id, index, 'hex', offset, signal);
      return { ...read, contentType: 'application/octet-stream', image: null };
    },
    download: async ({ signal, onProgress }) => {
      const { data } = await client.download(id, index, signal);
      onProgress?.(data.length, data.length);
      return new Blob([data as BlobPart], { type: 'application/octet-stream' });
    },
  };
}
