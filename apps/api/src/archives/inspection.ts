import {
  ARCHIVE_INSPECTION_ERROR_TEXT,
  archiveFormatFor,
  type ArchiveEntry,
  type ArchiveListingQuery,
  type ArchiveListingResponse,
  type ArchiveSummary,
  type ArchiveView,
  type VmIdentity,
} from '@emucat/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { NOT_DELETED } from '../cleanup/version-deletions.js';
import { ApiError } from '../errors.js';
import { repositoryRecord } from '../registration/repositories.js';
import {
  RepositoryAccessError,
  type RepositoryAccess,
  type RepositorySession,
} from '../repository-access/ssh.js';
import {
  ArchiveCheckError,
  DEFAULT_ARCHIVE_LIMITS,
  MANIFEST_ENTRY_NAME,
  inspectZip,
  type ArchiveLimits,
} from './manifest.js';
import { readTar, TarFormatError } from './tar.js';
import { dosTimestamp, isDirectoryName, ZipFormatError, type ZipEntry } from './zip.js';

/**
 * View Archive Contents (decision 0055): a version's archive, listed from its structure over the server's own
 * repository connection. Only a ZIP's central directory and manifest, or an OVA's TAR headers, are ever read:
 * nothing is downloaded whole, decompressed or extracted, and nothing in the repository changes. The same checks a
 * restore makes are made first, so a listing never shows paths a restore would refuse.
 *
 * Parsed listings are kept in a small cache, so that browsing a large archive's directories reads it once.
 */

interface IndexedEntry extends ArchiveEntry {
  parent: string;
}

interface ViewIndex {
  all: IndexedEntry[];
  children: Map<string, IndexedEntry[]>;
}

interface Inspected {
  summary: ArchiveSummary;
  views: Partial<Record<ArchiveView, ViewIndex>>;
  entryCount: number;
  loadedAt: number;
}

export interface InspectionOptions {
  limits: ArchiveLimits;
  cacheSize: number;
  /** A cached listing is read again after this long. */
  cacheTtlMs: number;
  /** Archives listed at once; further requests wait for the same listing or are refused. */
  maxConcurrent: number;
}

export const DEFAULT_INSPECTION_OPTIONS: InspectionOptions = {
  limits: DEFAULT_ARCHIVE_LIMITS,
  cacheSize: 8,
  cacheTtlMs: 10 * 60 * 1000,
  maxConcurrent: 2,
};

const problem = (status: number, code: string) =>
  new ApiError(status, code, ARCHIVE_INSPECTION_ERROR_TEXT[code] ?? code);

const parentOf = (path: string) => {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
};
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

function byDirectoryThenName(a: IndexedEntry, b: IndexedEntry): number {
  if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
  return (
    a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true }) ||
    (a.name < b.name ? -1 : 1)
  );
}

function index(entries: IndexedEntry[]): ViewIndex {
  const children = new Map<string, IndexedEntry[]>([['', []]]);
  const directories = new Map<string, IndexedEntry>();
  for (const entry of entries) {
    if (entry.type === 'directory') {
      directories.set(entry.path, entry);
      if (!children.has(entry.path)) children.set(entry.path, []);
    }
  }
  // An archive may leave a parent directory implicit; it is listed all the same.
  const all = [...entries];
  for (const entry of entries) {
    let parent = entry.parent;
    while (parent !== '' && !directories.has(parent)) {
      const implicit: IndexedEntry = {
        name: nameOf(parent),
        path: parent,
        parent: parentOf(parent),
        type: 'directory',
        sizeBytes: null,
        compressedSizeBytes: null,
        method: null,
        sha256: null,
        modifiedAt: null,
        childCount: 0,
      };
      directories.set(parent, implicit);
      children.set(parent, []);
      all.push(implicit);
      parent = implicit.parent;
    }
  }
  for (const entry of all) children.get(entry.parent)?.push(entry);
  for (const [path, list] of children) {
    list.sort(byDirectoryThenName);
    const directory = directories.get(path);
    if (directory) directory.childCount = list.length;
  }
  all.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { all, children };
}

function zipMethod(entry: ZipEntry): ArchiveEntry['method'] {
  return entry.method === 0 ? 'stored' : entry.method === 8 ? 'deflated' : 'other';
}

/** Reads through one SFTP connection, in the blocks a directory read asks for. */
function readerSource(reader: Awaited<ReturnType<RepositorySession['openReader']>>) {
  return {
    sizeBytes: reader.sizeBytes,
    read: (offset: number, length: number) => reader.read(offset, length),
  };
}

export class ArchiveInspection {
  private readonly cache = new Map<string, Inspected>();
  private readonly loading = new Map<string, Promise<Inspected>>();

  constructor(
    private readonly pool: Pool,
    private readonly access: RepositoryAccess,
    private readonly log: FastifyBaseLogger,
    private readonly options: InspectionOptions = DEFAULT_INSPECTION_OPTIONS,
    private readonly now: () => number = Date.now,
  ) {}

  async summary(vm: VmIdentity, versionId: string): Promise<ArchiveSummary> {
    return (await this.inspected(vm, versionId)).summary;
  }

  async list(
    vm: VmIdentity,
    versionId: string,
    query: ArchiveListingQuery,
  ): Promise<ArchiveListingResponse> {
    const inspected = await this.inspected(vm, versionId);
    const view = inspected.views[query.view];
    if (!view) {
      throw new ApiError(
        409,
        'archive_view_unavailable',
        query.view === 'logical'
          ? 'An OVA has no EmuCat manifest, so it has only the physical view.'
          : 'This view is not available.',
      );
    }
    let entries: IndexedEntry[];
    let path = '';
    if (query.q) {
      const needle = query.q.toLowerCase();
      entries = view.all.filter((entry) => entry.path.toLowerCase().includes(needle));
    } else {
      path = query.path.replace(/^\/+|\/+$/gu, '');
      const found = view.children.get(path);
      if (!found)
        throw new ApiError(
          404,
          'archive_path_not_found',
          'There is no such directory in the archive.',
        );
      entries = found;
    }
    const page = entries.slice(query.offset, query.offset + query.limit);
    const next = query.offset + page.length;
    return {
      view: query.view,
      path,
      q: query.q ?? null,
      entries: page.map(({ parent, ...entry }) => (void parent, entry)),
      total: entries.length,
      nextOffset: next < entries.length ? next : null,
    };
  }

  private async inspected(vm: VmIdentity, versionId: string): Promise<Inspected> {
    const cached = this.cache.get(versionId);
    if (cached && this.now() - cached.loadedAt < this.options.cacheTtlMs) {
      if (
        cached.summary.vm.emulatorType !== vm.emulatorType ||
        cached.summary.vm.vmName.toLowerCase() !== vm.vmName.toLowerCase()
      ) {
        throw new ApiError(404, 'version_not_found', 'Version not found');
      }
      // Most recently used last.
      this.cache.delete(versionId);
      this.cache.set(versionId, cached);
      return cached;
    }
    const pending = this.loading.get(versionId);
    if (pending) return pending;
    if (this.loading.size >= this.options.maxConcurrent) {
      throw new ApiError(
        503,
        'inspection_busy',
        'The server is listing other archives. Try again shortly.',
      );
    }
    const loading = this.load(vm, versionId).finally(() => this.loading.delete(versionId));
    this.loading.set(versionId, loading);
    const result = await loading;
    this.cache.set(versionId, result);
    while (this.cache.size > this.options.cacheSize) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
    return result;
  }

  private async load(vm: VmIdentity, versionId: string): Promise<Inspected> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT version.id, version.kind, version.vm_name, version.snapshot_name, version.title, version.created_at,
              version.repository_id, version.archive_key, version.archive_sha256, version.archive_size_bytes,
              r.name AS repository_name, vm.display_name, reg.manifest_sha256,
              NOT (${NOT_DELETED('version')}) AS deleted
       FROM vm_versions AS version
       JOIN repositories AS r ON r.id = version.repository_id
       JOIN virtual_machines AS vm ON vm.emulator_type = version.emulator_type AND vm.vm_name = version.vm_name
       LEFT JOIN registration_operations AS reg ON reg.version_id = version.id
       WHERE version.id = ? AND version.emulator_type = ? AND version.vm_name = ?`,
      [versionId, vm.emulatorType, vm.vmName],
    );
    const row = rows[0];
    if (!row) throw new ApiError(404, 'version_not_found', 'Version not found');
    if (Number(row.deleted)) throw problem(409, 'version_deleted');
    if (!this.access.configured) throw problem(503, 'server_repository_unavailable');
    const repository = await repositoryRecord(this.pool, row.repository_id as string);
    if (!repository) throw problem(404, 'remote_object_missing');

    const format = archiveFormatFor(vm.emulatorType);
    const registeredSize = Number(row.archive_size_bytes);
    const archiveKey = row.archive_key as string;
    let session: RepositorySession | null = null;
    try {
      session = await this.access.open(repository.endpoint);
      const reader = await session.openReader(archiveKey);
      try {
        if (reader.sizeBytes !== registeredSize) throw problem(409, 'archive_size_mismatch');
        const base: Omit<ArchiveSummary, 'manifest' | 'physical' | 'views' | 'warnings'> = {
          vm: {
            emulatorType: vm.emulatorType,
            vmName: row.vm_name as string,
            title: (row.display_name as string | null) ?? (row.vm_name as string),
          },
          version: {
            id: row.id as string,
            kind: row.kind as 'master' | 'snapshot',
            snapshotName: (row.snapshot_name as string | null) ?? null,
            title: (row.title as string | null) ?? null,
            createdAt: (row.created_at as Date).toISOString(),
          },
          archive: {
            format,
            fileName: nameOf(archiveKey),
            repositoryName: row.repository_name as string,
            sizeBytes: registeredSize,
            sha256: row.archive_sha256 as string,
          },
          complete: true,
        };
        const result =
          format === 'zip'
            ? await this.loadZip(base, readerSource(reader), vm, row)
            : await this.loadOva(base, readerSource(reader));
        this.log.info({ versionId, entries: result.entryCount }, 'Archive listed');
        return result;
      } finally {
        await reader.close();
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof ArchiveCheckError) {
        throw problem(422, error.kind === 'limit' ? 'archive_too_large' : 'archive_malformed');
      }
      if (error instanceof ZipFormatError || error instanceof TarFormatError) {
        throw problem(422, error.kind === 'limit' ? 'archive_too_large' : 'archive_malformed');
      }
      if (error instanceof RepositoryAccessError) {
        if (error.code === 'remote_object_missing') throw problem(404, 'remote_object_missing');
        throw new ApiError(502, error.code, `${error.message}.`);
      }
      throw error;
    } finally {
      session?.close();
    }
  }

  private async loadZip(
    base: Omit<ArchiveSummary, 'manifest' | 'physical' | 'views' | 'warnings'>,
    source: { sizeBytes: number; read(offset: number, length: number): Promise<Buffer> },
    vm: VmIdentity,
    row: RowDataPacket,
  ): Promise<Inspected> {
    const registeredManifest = (row.manifest_sha256 as string | null) ?? null;
    // The registration's manifest is compared below, so that a mismatch is reported rather than hidden.
    const inspected = await inspectZip(
      source,
      { emulatorType: vm.emulatorType, vmName: row.vm_name as string, manifestSha256: null },
      this.options.limits,
    );
    const warnings: string[] = [];
    const matches =
      registeredManifest === null ? null : registeredManifest === inspected.manifestSha256;
    if (matches === false) {
      warnings.push(
        'The manifest differs from the one this version’s registration verified. Verify this version.',
      );
    }
    const logical: IndexedEntry[] = inspected.manifest.entries.map((entry) => ({
      name: nameOf(entry.path),
      path: entry.path,
      parent: parentOf(entry.path),
      type: entry.type,
      sizeBytes: entry.type === 'file' ? (entry.sizeBytes ?? 0) : null,
      compressedSizeBytes: null,
      method: null,
      sha256: entry.type === 'file' ? (entry.sha256 ?? null) : null,
      modifiedAt: null,
      childCount: entry.type === 'directory' ? 0 : null,
    }));
    let compressed = 0;
    let uncompressed = 0;
    let files = 0;
    let directories = 0;
    const physical: IndexedEntry[] = inspected.entries.map((entry) => {
      const directory = isDirectoryName(entry);
      const path = directory ? entry.name.slice(0, -1) : entry.name;
      compressed += entry.compressedSize;
      uncompressed += entry.uncompressedSize;
      if (directory) directories += 1;
      else files += 1;
      return {
        name: nameOf(path),
        path,
        parent: parentOf(path),
        type: directory ? 'directory' : 'file',
        sizeBytes: directory ? null : entry.uncompressedSize,
        compressedSizeBytes: directory ? null : entry.compressedSize,
        method: directory ? null : zipMethod(entry),
        sha256: null,
        modifiedAt: dosTimestamp(entry),
        childCount: directory ? 0 : null,
      };
    });
    if (!inspected.entries.some((entry) => entry.name === MANIFEST_ENTRY_NAME)) {
      warnings.push('The archive has no manifest entry.');
    }
    return {
      summary: {
        ...base,
        manifest: {
          manifestVersion: inspected.manifest.manifestVersion,
          vmName: inspected.manifest.vmName,
          fileCount: inspected.manifest.fileCount,
          directoryCount: inspected.manifest.entries.filter((entry) => entry.type === 'directory')
            .length,
          totalUncompressedBytes: inspected.manifest.totalUncompressedBytes,
          sha256: inspected.manifestSha256,
          matchesRegistration: matches,
        },
        physical: {
          entryCount: inspected.entries.length,
          fileCount: files,
          directoryCount: directories,
          compressedBytes: compressed,
          uncompressedBytes: uncompressed,
        },
        views: ['logical', 'physical'],
        warnings,
      },
      views: { logical: index(logical), physical: index(physical) },
      entryCount: inspected.entries.length,
      loadedAt: this.now(),
    };
  }

  private async loadOva(
    base: Omit<ArchiveSummary, 'manifest' | 'physical' | 'views' | 'warnings'>,
    source: { sizeBytes: number; read(offset: number, length: number): Promise<Buffer> },
  ): Promise<Inspected> {
    const entries = await readTar(source, {
      maxEntries: Math.min(this.options.limits.maxEntries, 10_000),
    });
    let total = 0;
    const physical: IndexedEntry[] = entries.map((entry) => {
      total += entry.sizeBytes;
      return {
        name: entry.name,
        path: entry.name,
        parent: '',
        type: 'file',
        sizeBytes: entry.sizeBytes,
        compressedSizeBytes: entry.sizeBytes,
        method: 'stored',
        sha256: null,
        modifiedAt: entry.modifiedAt,
        childCount: null,
      };
    });
    return {
      summary: {
        ...base,
        manifest: null,
        physical: {
          entryCount: entries.length,
          fileCount: entries.length,
          directoryCount: 0,
          compressedBytes: total,
          uncompressedBytes: total,
        },
        views: ['physical'],
        warnings: [],
      },
      views: { physical: index(physical) },
      entryCount: entries.length,
      loadedAt: this.now(),
    };
  }
}
