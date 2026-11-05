import { type ReadStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export class InvalidStorageKeyError extends Error {
  override readonly name = 'InvalidStorageKeyError';
}

/** Files of a media item. Keys are relative to the storage root and come from `vm_media`. */
export interface MediaStorage {
  /** Opens a file for reading, or returns `null` if it does not exist. */
  open(key: string): Promise<{ stream: ReadStream; sizeBytes: number } | null>;
  /** Removes a file. Removing one that is already gone succeeds, so a retry can always finish. */
  remove(key: string): Promise<void>;
}

/** Resolves a key to a path, refusing anything that could reach outside the storage root. */
export function resolveStorageKey(root: string, key: string): string {
  if (key.length === 0 || key.includes('\0') || key.includes('\\') || isAbsolute(key)) {
    throw new InvalidStorageKeyError('Storage key is not a relative path');
  }
  if (key.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')) {
    throw new InvalidStorageKeyError('Storage key has an unsafe path segment');
  }
  const base = resolve(root);
  const path = resolve(base, key);
  const fromBase = relative(base, path);
  if (fromBase.length === 0 || fromBase.startsWith(`..${sep}`) || isAbsolute(fromBase)) {
    throw new InvalidStorageKeyError('Storage key is outside the storage root');
  }
  return path;
}

function isMissingFile(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export function fileMediaStorage(root: string): MediaStorage {
  return {
    async open(key) {
      const path = resolveStorageKey(root, key);
      try {
        const handle = await open(path, 'r');
        const stats = await handle.stat();
        if (!stats.isFile()) {
          await handle.close();
          return null;
        }
        // The stream owns the handle from here on, and closes it when it ends or fails.
        return { stream: handle.createReadStream(), sizeBytes: stats.size };
      } catch (error) {
        if (isMissingFile(error)) return null;
        throw error;
      }
    },
    async remove(key) {
      await rm(resolveStorageKey(root, key), { force: true });
    },
  };
}
