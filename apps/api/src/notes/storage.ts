import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { join, relative, resolve, sep, isAbsolute } from 'node:path';
import {
  EMULATOR_TYPES,
  VM_NOTES_MAX_BYTES,
  isValidVmName,
  notesFileName,
  type VmIdentity,
  type VmNotes,
} from '@emucat/contracts';

/**
 * Per-VM Markdown notes on the server's filesystem (decision 0053):
 *
 *     <root>/<emulator>/<vm name>/<vm name> - notes.md
 *
 * The file is the only copy of the notes. Every path is derived here from a VM identity that the caller has already
 * looked up in the catalog, in its registered spelling, and that is validated again here: nothing from a request
 * ever becomes a path. Links are refused at every level, and files are opened without following one, so a link
 * planted under the root cannot make this read or write anywhere else.
 *
 * Writes go to a new temporary file in the same directory, which is synced and then renamed over the notes file:
 * a reader sees the old notes or the new ones, never a mixture. Concurrent saves are serialized per VM in this
 * process (there is one API process) and each must name the version it replaces, as an entity tag: a save based on
 * notes that changed since is refused, never merged or silently overwritten.
 */

export class NotesError extends Error {
  override readonly name = 'NotesError';
  constructor(
    readonly kind: 'conflict' | 'unsafe' | 'unavailable' | 'too_large',
    message: string,
  ) {
    super(message);
  }
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
/** A temporary file is named after the notes file, hidden, with a random part. */
const TEMPORARY_SUFFIX = '.tmp';
/** Older than this, a temporary file is what a crash left, not a save in progress. */
const STALE_TEMPORARY_MS = 60 * 60 * 1000;

export function notesEtag(bytes: Uint8Array | string): string {
  return `"${createHash('sha256').update(bytes).digest('hex')}"`;
}

const EMPTY_ETAG = notesEtag('');

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isLink(error: unknown): boolean {
  // O_NOFOLLOW on a link fails with ELOOP on Linux and macOS (EMLINK on FreeBSD).
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ELOOP' || code === 'EMLINK';
}

/** The relative segments of a VM's notes, or a refusal. Only catalog identities can produce one. */
export function notesSegments(vm: VmIdentity): [string, string, string] {
  if (!(EMULATOR_TYPES as readonly string[]).includes(vm.emulatorType)) {
    throw new NotesError('unsafe', 'Not an emulator type');
  }
  // The VM name rules already exclude separators, `..`, a leading dot, control characters and Windows device
  // names. Checked again here, so that this module is safe whoever calls it.
  if (!isValidVmName(vm.vmName) || vm.vmName.includes('/') || vm.vmName.includes('\\')) {
    throw new NotesError('unsafe', 'Not a valid VM name');
  }
  return [vm.emulatorType, vm.vmName, notesFileName(vm.vmName)];
}

export class NotesStorage {
  private readonly root: string;
  /** One save, or one removal, at a time per VM. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(root: string) {
    this.root = resolve(root);
  }

  private async locked<T>(vm: VmIdentity, work: () => Promise<T>): Promise<T> {
    const key = `${vm.emulatorType}/${vm.vmName.toLowerCase()}`;
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.locks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }

  /** Refuses a link or a non-directory where a directory must be. `false` when it does not exist. */
  private async checkDirectory(path: string): Promise<boolean> {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new NotesError('unsafe', 'A notes directory is a link or not a directory');
      }
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  /** The real root, which must be a directory and not a link. */
  private async realRoot(create: boolean): Promise<string | null> {
    if (!(await this.checkDirectory(this.root))) {
      if (!create) return null;
      await mkdir(this.root, { recursive: true, mode: 0o750 });
      await this.checkDirectory(this.root);
    }
    return realpath(this.root);
  }

  /** Whether a real path is inside the real root. */
  private inside(realRootPath: string, path: string): boolean {
    const fromRoot = relative(realRootPath, path);
    return (
      fromRoot.length > 0 &&
      !fromRoot.startsWith(`..${sep}`) &&
      fromRoot !== '..' &&
      !isAbsolute(fromRoot)
    );
  }

  /**
   * The VM's directory, checked at every level: the root, the emulator's directory and the VM's, each a real
   * directory and none a link, ending inside the root. Created when `create` is set.
   */
  private async vmDirectory(vm: VmIdentity, create: boolean): Promise<string | null> {
    const [emulator, vmName] = notesSegments(vm);
    const realRootPath = await this.realRoot(create);
    if (realRootPath === null) return null;
    let current = realRootPath;
    for (const segment of [emulator, vmName]) {
      current = join(current, segment);
      if (!(await this.checkDirectory(current))) {
        if (!create) return null;
        try {
          await mkdir(current, { mode: 0o750 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        await this.checkDirectory(current);
      }
    }
    const real = await realpath(current);
    if (!this.inside(realRootPath, real)) {
      throw new NotesError('unsafe', 'The notes directory is outside the notes root');
    }
    return real;
  }

  /** The VM's notes. A missing file is an empty document. */
  async read(vm: VmIdentity): Promise<VmNotes> {
    try {
      return await this.readUnlocked(vm);
    } catch (error) {
      throw this.translate(error);
    }
  }

  private async readUnlocked(vm: VmIdentity): Promise<VmNotes> {
    const directory = await this.vmDirectory(vm, false);
    const empty: VmNotes = {
      markdown: '',
      exists: false,
      etag: EMPTY_ETAG,
      updatedAt: null,
      sizeBytes: 0,
    };
    if (directory === null) return empty;
    const path = join(directory, notesSegments(vm)[2]);
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | NOFOLLOW);
    } catch (error) {
      if (isMissing(error)) return empty;
      if (isLink(error)) throw new NotesError('unsafe', 'The notes file is a link');
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new NotesError('unsafe', 'The notes file is not a regular file');
      if (info.size > VM_NOTES_MAX_BYTES * 4) {
        throw new NotesError('too_large', 'The notes file is larger than notes may be');
      }
      const bytes = await handle.readFile();
      return {
        markdown: new TextDecoder('utf-8', { fatal: false }).decode(bytes),
        exists: true,
        etag: notesEtag(bytes),
        updatedAt: info.mtime.toISOString(),
        sizeBytes: bytes.length,
      };
    } finally {
      await handle.close();
    }
  }

  /**
   * Replaces the VM's notes with `markdown`, if they are still what `ifMatch` names. An empty document removes the
   * file, and the VM's directory when nothing else is in it.
   */
  async write(vm: VmIdentity, markdown: string, ifMatch: string): Promise<VmNotes> {
    const bytes = new TextEncoder().encode(markdown);
    if (bytes.length > VM_NOTES_MAX_BYTES) {
      throw new NotesError('too_large', `Notes are limited to ${VM_NOTES_MAX_BYTES} bytes`);
    }
    try {
      return await this.locked(vm, async () => {
        const current = await this.readUnlocked(vm);
        if (current.etag !== ifMatch) {
          throw new NotesError('conflict', 'The notes changed since they were loaded');
        }
        if (bytes.length === 0) return this.removeUnlocked(vm);
        if (current.etag === notesEtag(bytes)) return current;
        const directory = await this.vmDirectory(vm, true);
        if (directory === null) throw new NotesError('unavailable', 'No notes directory');
        const name = notesSegments(vm)[2];
        await this.removeStaleTemporaries(directory, name);
        const temporary = join(directory, `.${name}.${randomUUID()}${TEMPORARY_SUFFIX}`);
        const handle = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
          0o640,
        );
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } catch (error) {
          await handle.close();
          await unlink(temporary).catch(() => undefined);
          throw error;
        }
        await handle.close();
        const target = join(directory, name);
        try {
          // A link at the target is replaced by the rename itself, never followed; refusing it is clearer.
          const existing = await lstat(target).catch((error: unknown) => {
            if (isMissing(error)) return null;
            throw error;
          });
          if (existing && !existing.isFile()) {
            throw new NotesError('unsafe', 'The notes file is a link or not a regular file');
          }
          await rename(temporary, target);
        } catch (error) {
          await unlink(temporary).catch(() => undefined);
          throw error;
        }
        await this.syncDirectory(directory);
        return this.readUnlocked(vm);
      });
    } catch (error) {
      throw this.translate(error);
    }
  }

  /** Removes the VM's notes, if they are still what `ifMatch` names. */
  async clear(vm: VmIdentity, ifMatch: string): Promise<VmNotes> {
    return this.write(vm, '', ifMatch);
  }

  /**
   * Removes a VM's notes whatever they are, with its directory. For the VM deletion lifecycle: notes belong to the
   * VM's identity, and go with it. Nothing else calls this.
   */
  async deleteForVm(vm: VmIdentity): Promise<void> {
    try {
      await this.locked(vm, async () => {
        await this.removeUnlocked(vm);
      });
    } catch (error) {
      throw this.translate(error);
    }
  }

  private async removeUnlocked(vm: VmIdentity): Promise<VmNotes> {
    const directory = await this.vmDirectory(vm, false);
    if (directory !== null) {
      const name = notesSegments(vm)[2];
      const target = join(directory, name);
      const existing = await lstat(target).catch((error: unknown) => {
        if (isMissing(error)) return null;
        throw error;
      });
      if (existing && !existing.isFile()) {
        throw new NotesError('unsafe', 'The notes file is a link or not a regular file');
      }
      if (existing) await unlink(target);
      await this.removeStaleTemporaries(directory, name, 0);
      // Only empty directories, never recursively: anything else someone put there stays.
      await rmdir(directory).catch(() => undefined);
      await rmdir(join(directory, '..')).catch(() => undefined);
      await this.syncDirectory(join(directory, '..')).catch(() => undefined);
    }
    return { markdown: '', exists: false, etag: EMPTY_ETAG, updatedAt: null, sizeBytes: 0 };
  }

  /** Temporary files a crash left behind, which are this module's alone by their names. */
  private async removeStaleTemporaries(
    directory: string,
    name: string,
    olderThanMs = STALE_TEMPORARY_MS,
  ): Promise<void> {
    const prefix = `.${name}.`;
    const entries = await readdir(directory).catch(() => [] as string[]);
    for (const entry of entries) {
      if (!entry.startsWith(prefix) || !entry.endsWith(TEMPORARY_SUFFIX)) continue;
      const path = join(directory, entry);
      const info = await lstat(path).catch(() => null);
      if (info?.isFile() && Date.now() - info.mtimeMs >= olderThanMs) {
        await unlink(path).catch(() => undefined);
      }
    }
  }

  /** Makes a rename durable where the platform allows syncing a directory. */
  private async syncDirectory(directory: string): Promise<void> {
    if (process.platform === 'win32') return;
    const handle = await open(directory, constants.O_RDONLY).catch(() => null);
    if (!handle) return;
    try {
      await handle.sync();
    } catch {
      // Some filesystems cannot sync a directory; the rename is still atomic.
    } finally {
      await handle.close();
    }
  }

  private translate(error: unknown): Error {
    if (error instanceof NotesError) return error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS' || code === 'ENOSPC') {
      return new NotesError(
        'unavailable',
        'The notes directory cannot be written. Check that it exists and belongs to the API’s account.',
      );
    }
    if (isLink(error)) return new NotesError('unsafe', 'A notes path is a link');
    return error instanceof Error ? error : new Error(String(error));
  }
}
