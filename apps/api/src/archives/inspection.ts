import {
  ARCHIVE_INSPECTION_ERROR_TEXT,
  archiveFormatFor,
  type ArchiveEntry,
  type ArchiveListingQuery,
  type ArchiveListingResponse,
  type ArchiveSummary,
  type ArchiveView,
  type EmulatorType,
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
import type { EntryLocator, ExtractSource } from './extract.js';
import { ArchiveCheckError, MANIFEST_ENTRY_NAME, inspectZip } from './manifest.js';
import { DEFAULT_ARCHIVE_POLICY, type ArchivePolicy } from './policy.js';
import { readTar, TarFormatError } from './tar.js';
import { dosTimestamp, isDirectoryName, ZipFormatError, type ZipEntry } from './zip.js';

/**
 * View Archive Contents (decision 0055) and Archive Explorer (decision 0056): a version's archive, indexed from its
 * structure over the server's own repository connection. Only a ZIP's central directory and manifest, or an OVA's
 * TAR headers, are read to build the index: nothing is downloaded whole, nothing is written to disk, and nothing in
 * the repository changes. The same checks a restore makes are made first, so the index never holds paths a restore
 * would refuse.
 *
 * Each index keeps, for every file, a compact locator (where its bytes are and how they are stored), so that one
 * file can later be read without reading anything else. Locators never leave the server.
 *
 * Identity. Every request reads the version's row again, scoped by emulator, VM and version, before anything cached
 * is used, whether the index is cached, being built for another request, or built for this one. A cached index is
 * used only while the row still names the same repository, key, size and SHA-256; before any file is read, the
 * object's size and modification time in the repository are compared with those seen when the index was built.
 *
 * Cache. At most `cache.maxIndexes` indexes, each for `cache.ttlMs`, least recently used first out, and within an
 * estimated byte budget: an index whose estimate exceeds the budget alone is used for its request and not kept.
 *
 * Cancellation. Requests for the same version share one load. Each requester can give up on its own; the load stops
 * only when every requester has, or at its deadline.
 */

interface IndexedEntry extends ArchiveEntry {
  parent: string;
  /** Where a file's bytes are. `null` for directories. */
  locator: EntryLocator | null;
  /** The SHA-256 a complete read must match: the manifest's, for ZIP files. */
  verifySha256: string | null;
}

interface ViewIndex {
  /** Sorted by path, in code-unit order, for lookup by binary search. */
  all: IndexedEntry[];
  children: Map<string, IndexedEntry[]>;
}

/** What makes two looks at a version the same archive. */
export interface ArchiveIdentity {
  versionId: string;
  emulatorType: EmulatorType;
  vmName: string;
  repositoryId: string;
  archiveKey: string;
  sizeBytes: number;
  sha256: string;
}

interface VersionRecord extends ArchiveIdentity {
  row: RowDataPacket;
}

interface Inspected {
  identity: ArchiveIdentity;
  /** The object's modification time in the repository when the index was built, if the server said. */
  remoteModifiedAt: number | null;
  summary: ArchiveSummary;
  views: Partial<Record<ArchiveView, ViewIndex>>;
  entryCount: number;
  loadedAt: number;
  /** An estimate of the index's size in memory. Not a measurement. */
  weightBytes: number;
}

/** One file of an archive, resolved through an authorized index. */
export interface ResolvedEntry {
  identity: ArchiveIdentity;
  remoteModifiedAt: number | null;
  view: ArchiveView;
  entry: ArchiveEntry;
  locator: EntryLocator;
  verifySha256: string | null;
  manifestSha256: string | null;
}

const problem = (status: number, code: string) =>
  new ApiError(status, code, ARCHIVE_INSPECTION_ERROR_TEXT[code] ?? code);

export const cancelledError = () => problem(408, 'request_cancelled');

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

const byPath = (a: IndexedEntry, b: IndexedEntry) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

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
        locator: null,
        verifySha256: null,
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
  all.sort(byPath);
  return { all, children };
}

function find(view: ViewIndex, path: string): IndexedEntry | null {
  let low = 0;
  let high = view.all.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const candidate = view.all[middle] as IndexedEntry;
    if (candidate.path === path) return candidate;
    if (candidate.path < path) low = middle + 1;
    else high = middle - 1;
  }
  return null;
}

/**
 * Bytes an index is estimated to hold: a fixed cost per entry (the object, its locator, its places in the arrays and
 * the directory map) and two bytes per character of its strings. Deliberately generous; V8's real layout varies.
 */
export const ENTRY_WEIGHT_BYTES = 320;
function weightOf(views: Partial<Record<ArchiveView, ViewIndex>>): number {
  let total = 4096;
  for (const view of Object.values(views)) {
    if (!view) continue;
    for (const entry of view.all) {
      total +=
        ENTRY_WEIGHT_BYTES +
        2 * (entry.name.length + entry.path.length) +
        (entry.modifiedAt ? 2 * entry.modifiedAt.length : 0) +
        (entry.sha256 ? 128 : 0);
    }
  }
  return total;
}

function zipMethod(entry: ZipEntry): ArchiveEntry['method'] {
  return entry.method === 0 ? 'stored' : entry.method === 8 ? 'deflated' : 'other';
}

function sameArchive(a: ArchiveIdentity, b: ArchiveIdentity): boolean {
  return (
    a.versionId === b.versionId &&
    a.emulatorType === b.emulatorType &&
    a.vmName.toLowerCase() === b.vmName.toLowerCase() &&
    a.repositoryId === b.repositoryId &&
    a.archiveKey === b.archiveKey &&
    a.sizeBytes === b.sizeBytes &&
    a.sha256 === b.sha256
  );
}

/** Repository failures as the API reports them, with the stable codes of `ARCHIVE_INSPECTION_ERROR_TEXT`. */
export function repositoryProblem(error: unknown): unknown {
  if (error instanceof ApiError) return error;
  if (error instanceof RepositoryAccessError) {
    if (error.code === 'remote_object_missing') return problem(404, 'remote_object_missing');
    if (error.code === 'server_repository_unavailable') {
      return problem(503, 'server_repository_unavailable');
    }
    if (error.code === 'cancelled') return cancelledError();
    return new ApiError(502, error.code, `${error.message}.`);
  }
  return error;
}

/**
 * One load shared by every request that asks for the same version while it runs. Each requester joins with its own
 * signal and may leave on its own; the work is aborted only when the last one has left.
 */
class SharedLoad<T> {
  readonly controller = new AbortController();
  private waiters = 0;
  readonly promise: Promise<T>;

  constructor(
    readonly identity: ArchiveIdentity,
    work: (signal: AbortSignal) => Promise<T>,
  ) {
    this.promise = work(this.controller.signal);
    // Nobody may be waiting when it fails: that is not an unhandled rejection.
    this.promise.catch(() => undefined);
  }

  get activeWaiters(): number {
    return this.waiters;
  }

  join(signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(cancelledError());
    this.waiters += 1;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const settle = () => {
        if (settled) return false;
        settled = true;
        this.waiters -= 1;
        signal?.removeEventListener('abort', onAbort);
        return true;
      };
      const onAbort = () => {
        if (!settle()) return;
        if (this.waiters === 0) this.controller.abort(cancelledError());
        reject(cancelledError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.promise.then(
        (value) => settle() && resolve(value),
        (error: unknown) => settle() && reject(error),
      );
    });
  }
}

export interface CacheStats {
  indexes: number;
  estimatedBytes: number;
  loading: number;
  /** Requests waiting on those loads. */
  waiting: number;
}

export class ArchiveInspection {
  private readonly cache = new Map<string, Inspected>();
  private readonly loading = new Map<string, SharedLoad<Inspected>>();
  private cachedBytes = 0;

  constructor(
    private readonly pool: Pool,
    private readonly access: RepositoryAccess,
    private readonly log: FastifyBaseLogger,
    private readonly policy: ArchivePolicy = DEFAULT_ARCHIVE_POLICY,
    private readonly now: () => number = Date.now,
  ) {}

  stats(): CacheStats {
    return {
      indexes: this.cache.size,
      estimatedBytes: this.cachedBytes,
      loading: this.loading.size,
      waiting: [...this.loading.values()].reduce((sum, load) => sum + load.activeWaiters, 0),
    };
  }

  async summary(vm: VmIdentity, versionId: string, signal?: AbortSignal): Promise<ArchiveSummary> {
    return (await this.inspected(vm, versionId, signal)).summary;
  }

  async list(
    vm: VmIdentity,
    versionId: string,
    query: ArchiveListingQuery,
    signal?: AbortSignal,
  ): Promise<ArchiveListingResponse> {
    const inspected = await this.inspected(vm, versionId, signal);
    const view = this.view(inspected, query.view);
    let entries: IndexedEntry[];
    let path = '';
    if (query.q) {
      const needle = query.q.toLowerCase();
      entries = view.all.filter((entry) => entry.path.toLowerCase().includes(needle));
    } else {
      path = query.path.replace(/^\/+|\/+$/gu, '');
      const found = view.children.get(path);
      if (!found) throw problem(404, 'archive_path_not_found');
      entries = found;
    }
    const page = entries.slice(query.offset, query.offset + query.limit);
    const next = query.offset + page.length;
    return {
      view: query.view,
      path,
      q: query.q ?? null,
      entries: page.map(publicEntry),
      total: entries.length,
      nextOffset: next < entries.length ? next : null,
    };
  }

  /**
   * One file of a version's archive, through the index, for Archive Explorer. Authorization is the caller's; the
   * version's identity is checked here, every time.
   */
  async entry(
    vm: VmIdentity,
    versionId: string,
    viewName: ArchiveView,
    path: string,
    signal?: AbortSignal,
  ): Promise<ResolvedEntry> {
    const inspected = await this.inspected(vm, versionId, signal);
    const view = this.view(inspected, viewName);
    const found = find(view, path);
    if (!found) throw problem(404, 'entry_not_found');
    if (found.type !== 'file' || !found.locator) throw problem(409, 'entry_not_file');
    return {
      identity: inspected.identity,
      remoteModifiedAt: inspected.remoteModifiedAt,
      view: viewName,
      entry: publicEntry(found),
      locator: found.locator,
      verifySha256: found.verifySha256,
      manifestSha256: inspected.summary.manifest?.sha256 ?? null,
    };
  }

  /**
   * Opens the archive of a resolved entry for reading, checks that it is still the object that was indexed, and runs
   * `work` with it. The connection is always closed afterwards, and closed at once when `signal` aborts.
   */
  async withArchive<T>(
    resolved: ResolvedEntry,
    signal: AbortSignal,
    work: (source: ExtractSource) => Promise<T>,
  ): Promise<T> {
    const { identity } = resolved;
    if (!this.access.configured) throw problem(503, 'server_repository_unavailable');
    const repository = await repositoryRecord(this.pool, identity.repositoryId);
    if (!repository) throw problem(404, 'remote_object_missing');
    let session: RepositorySession | null = null;
    const onAbort = () => session?.close();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal.aborted) throw cancelledError();
      session = await this.access.open(repository.endpoint, signal);
      if (signal.aborted) throw cancelledError();
      const reader = await session.openReader(identity.archiveKey);
      try {
        if (
          reader.sizeBytes !== identity.sizeBytes ||
          (resolved.remoteModifiedAt !== null && reader.modifiedAt !== resolved.remoteModifiedAt)
        ) {
          this.evict(identity.versionId);
          this.log.warn(
            { versionId: identity.versionId },
            'An archive changed in the repository after it was indexed',
          );
          throw problem(409, 'archive_changed');
        }
        return await work({
          sizeBytes: reader.sizeBytes,
          read: (offset, length) => reader.read(offset, length, signal),
        });
      } finally {
        await reader.close();
      }
    } catch (error) {
      // Whatever failed once the request was given up on failed because of that; the signal's reason says why.
      if (signal.aborted) {
        throw signal.reason instanceof ApiError ? signal.reason : cancelledError();
      }
      throw repositoryProblem(error);
    } finally {
      signal.removeEventListener('abort', onAbort);
      session?.close();
    }
  }

  /** Forgets a version's index, for example once its object is known to have changed. */
  evict(versionId: string): void {
    const cached = this.cache.get(versionId);
    if (!cached) return;
    this.cache.delete(versionId);
    this.cachedBytes -= cached.weightBytes;
  }

  private view(inspected: Inspected, name: ArchiveView): ViewIndex {
    const view = inspected.views[name];
    if (!view) {
      throw new ApiError(
        409,
        'archive_view_unavailable',
        name === 'logical'
          ? 'An OVA has no EmuCat manifest, so it has only the physical view.'
          : 'This view is not available.',
      );
    }
    return view;
  }

  /** The version's row, read now: it must exist for this VM and emulator, and not be deleted. */
  private async record(vm: VmIdentity, versionId: string): Promise<VersionRecord> {
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
    return {
      versionId: row.id as string,
      emulatorType: vm.emulatorType,
      vmName: row.vm_name as string,
      repositoryId: row.repository_id as string,
      archiveKey: row.archive_key as string,
      sizeBytes: Number(row.archive_size_bytes),
      sha256: row.archive_sha256 as string,
      row,
    };
  }

  private async inspected(
    vm: VmIdentity,
    versionId: string,
    signal?: AbortSignal,
  ): Promise<Inspected> {
    if (signal?.aborted) throw cancelledError();
    const record = await this.record(vm, versionId);
    // Cancelled while the record was read: start and join nothing. Otherwise a load would start with nobody to
    // wait for it, which nothing could ever abort, and it would read the archive for no one.
    if (signal?.aborted) throw cancelledError();
    const cached = this.cache.get(versionId);
    if (cached) {
      if (
        this.now() - cached.loadedAt < this.policy.cache.ttlMs &&
        sameArchive(cached.identity, record)
      ) {
        // Most recently used last.
        this.cache.delete(versionId);
        this.cache.set(versionId, cached);
        return this.checked(cached, vm, record);
      }
      this.evict(versionId);
    }
    let pending = this.loading.get(versionId);
    if (pending && !sameArchive(pending.identity, record)) {
      // The row changed while another request was loading the old archive: neither may use the other's.
      throw problem(503, 'inspection_busy');
    }
    if (!pending) {
      if (this.loading.size >= this.policy.inspection.maxConcurrent) {
        throw problem(503, 'inspection_busy');
      }
      const load = new SharedLoad(record, (shared) => this.loadWithDeadline(vm, record, shared));
      this.loading.set(versionId, load);
      pending = load;
      void load.promise
        .then(
          (result) => this.admit(result),
          () => undefined,
        )
        .finally(() => {
          if (this.loading.get(versionId) === load) this.loading.delete(versionId);
        });
    }
    return this.checked(await pending.join(signal), vm, record);
  }

  /** The same identity checks on every path, cached, shared or new (assessment R1). */
  private checked(inspected: Inspected, vm: VmIdentity, record: VersionRecord): Inspected {
    if (
      !sameArchive(inspected.identity, record) ||
      inspected.summary.vm.emulatorType !== vm.emulatorType ||
      inspected.summary.vm.vmName.toLowerCase() !== vm.vmName.toLowerCase()
    ) {
      throw new ApiError(404, 'version_not_found', 'Version not found');
    }
    return inspected;
  }

  private admit(result: Inspected): void {
    const { maxIndexes, maxBytes } = this.policy.cache;
    if (maxIndexes === 0 || result.weightBytes > maxBytes) {
      this.log.info(
        { versionId: result.identity.versionId, estimatedBytes: result.weightBytes, maxBytes },
        'Archive index not cached: larger than the cache budget',
      );
      return;
    }
    this.evict(result.identity.versionId);
    this.cache.set(result.identity.versionId, result);
    this.cachedBytes += result.weightBytes;
    while (this.cache.size > maxIndexes || this.cachedBytes > maxBytes) {
      const oldest = this.cache.keys().next().value as string;
      this.evict(oldest);
    }
  }

  private async loadWithDeadline(
    vm: VmIdentity,
    record: VersionRecord,
    shared: AbortSignal,
  ): Promise<Inspected> {
    const deadline = AbortSignal.timeout(this.policy.inspection.timeoutMs);
    const signal = AbortSignal.any([shared, deadline]);
    try {
      return await this.load(vm, record, signal);
    } catch (error) {
      if (deadline.aborted) throw problem(504, 'archive_timeout');
      if (shared.aborted) throw cancelledError();
      throw error;
    }
  }

  private async load(
    vm: VmIdentity,
    record: VersionRecord,
    signal: AbortSignal,
  ): Promise<Inspected> {
    const { row } = record;
    if (!this.access.configured) throw problem(503, 'server_repository_unavailable');
    const repository = await repositoryRecord(this.pool, record.repositoryId);
    if (!repository) throw problem(404, 'remote_object_missing');

    const format = archiveFormatFor(vm.emulatorType);
    let session: RepositorySession | null = null;
    const onAbort = () => session?.close();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      session = await this.access.open(repository.endpoint, signal);
      if (signal.aborted) throw cancelledError();
      const reader = await session.openReader(record.archiveKey);
      try {
        if (reader.sizeBytes !== record.sizeBytes) throw problem(409, 'archive_size_mismatch');
        const base: Omit<ArchiveSummary, 'manifest' | 'physical' | 'views' | 'warnings'> = {
          vm: {
            emulatorType: vm.emulatorType,
            vmName: record.vmName,
            title: (row.display_name as string | null) ?? record.vmName,
          },
          version: {
            id: record.versionId,
            kind: row.kind as 'master' | 'snapshot',
            snapshotName: (row.snapshot_name as string | null) ?? null,
            title: (row.title as string | null) ?? null,
            createdAt: (row.created_at as Date).toISOString(),
          },
          archive: {
            format,
            fileName: nameOf(record.archiveKey),
            repositoryName: row.repository_name as string,
            sizeBytes: record.sizeBytes,
            sha256: record.sha256,
          },
          complete: true,
        };
        const source: ExtractSource = {
          sizeBytes: reader.sizeBytes,
          read: (offset, length) => reader.read(offset, length, signal),
        };
        const built =
          format === 'zip'
            ? await this.loadZip(base, source, vm, row)
            : await this.loadOva(base, source);
        const views = built.views;
        const result: Inspected = {
          ...built,
          identity: {
            versionId: record.versionId,
            emulatorType: record.emulatorType,
            vmName: record.vmName,
            repositoryId: record.repositoryId,
            archiveKey: record.archiveKey,
            sizeBytes: record.sizeBytes,
            sha256: record.sha256,
          },
          remoteModifiedAt: reader.modifiedAt,
          loadedAt: this.now(),
          weightBytes: weightOf(views),
        };
        this.log.info(
          {
            versionId: record.versionId,
            entries: result.entryCount,
            estimatedBytes: result.weightBytes,
          },
          'Archive indexed',
        );
        return result;
      } finally {
        await reader.close();
      }
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof ApiError) throw error;
      if (
        error instanceof ArchiveCheckError ||
        error instanceof ZipFormatError ||
        error instanceof TarFormatError
      ) {
        // The response names only the class of problem; the log keeps the reader's reason, for diagnosis.
        this.log.warn(
          { versionId: record.versionId, format, reason: error.message },
          'Archive refused',
        );
        throw problem(422, error.kind === 'limit' ? 'archive_too_large' : 'archive_malformed');
      }
      throw repositoryProblem(error);
    } finally {
      signal.removeEventListener('abort', onAbort);
      session?.close();
    }
  }

  private async loadZip(
    base: Omit<ArchiveSummary, 'manifest' | 'physical' | 'views' | 'warnings'>,
    source: ExtractSource,
    vm: VmIdentity,
    row: RowDataPacket,
  ): Promise<Pick<Inspected, 'summary' | 'views' | 'entryCount'>> {
    const registeredManifest = (row.manifest_sha256 as string | null) ?? null;
    const { maxEntries, maxDirectoryBytes, maxManifestBytes } = this.policy.inspection;
    // The registration's manifest is compared below, so that a mismatch is reported rather than hidden.
    const inspected = await inspectZip(
      source,
      { emulatorType: vm.emulatorType, vmName: row.vm_name as string, manifestSha256: null },
      { maxEntries, maxDirectoryBytes, maxManifestBytes },
    );
    const warnings: string[] = [];
    const matches =
      registeredManifest === null ? null : registeredManifest === inspected.manifestSha256;
    if (matches === false) {
      warnings.push(
        'The manifest differs from the one this version’s registration verified. Verify this version.',
      );
    }
    const manifestHashes = new Map<string, string>();
    for (const entry of inspected.manifest.entries) {
      if (entry.type === 'file' && entry.sha256) manifestHashes.set(entry.path, entry.sha256);
    }
    // A manifest that is not the registration's is not authoritative, so its hashes are not used to verify.
    const trustHashes = matches !== false;
    let compressed = 0;
    let uncompressed = 0;
    let files = 0;
    let directories = 0;
    const locators = new Map<string, EntryLocator>();
    const physical: IndexedEntry[] = inspected.entries.map((entry) => {
      const directory = isDirectoryName(entry);
      const path = directory ? entry.name.slice(0, -1) : entry.name;
      compressed += entry.compressedSize;
      uncompressed += entry.uncompressedSize;
      if (directory) directories += 1;
      else files += 1;
      const locator: EntryLocator | null = directory
        ? null
        : {
            format: 'zip',
            name: entry.name,
            localHeaderOffset: entry.localHeaderOffset,
            compressedSize: entry.compressedSize,
            uncompressedSize: entry.uncompressedSize,
            method: entry.method,
            crc32: entry.crc32 >>> 0,
            flags: entry.flags,
            limit: inspected.directoryOffset,
          };
      if (locator) locators.set(path, locator);
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
        locator,
        verifySha256: trustHashes ? (manifestHashes.get(path) ?? null) : null,
      };
    });
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
      // inspectZip has proven that every manifest file is a stored file of the same path and size.
      locator: entry.type === 'file' ? (locators.get(entry.path) ?? null) : null,
      verifySha256: entry.type === 'file' && trustHashes ? (entry.sha256 ?? null) : null,
    }));
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
    };
  }

  private async loadOva(
    base: Omit<ArchiveSummary, 'manifest' | 'physical' | 'views' | 'warnings'>,
    source: ExtractSource,
  ): Promise<Pick<Inspected, 'summary' | 'views' | 'entryCount'>> {
    const entries = await readTar(source, {
      maxEntries: Math.min(this.policy.inspection.maxEntries, 10_000),
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
        locator: { format: 'tar', dataOffset: entry.dataOffset, sizeBytes: entry.sizeBytes },
        verifySha256: null,
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
    };
  }
}

function publicEntry(entry: IndexedEntry): ArchiveEntry {
  const { parent, locator, verifySha256, ...rest } = entry;
  void parent;
  void locator;
  void verifySha256;
  return rest;
}
