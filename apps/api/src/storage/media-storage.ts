import { randomUUID } from 'node:crypto';
import { type ReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';

export class InvalidStorageKeyError extends Error {
  override readonly name = 'InvalidStorageKeyError';
}

/** Where staged files live, under the storage root. Nothing in here is ever served. */
export const MEDIA_STAGING_KEY = 'media/staging';

/** Files of a media item. Keys are relative to the storage root and come from `vm_media`. */
export interface MediaStorage {
  /** Opens a file for reading, or returns `null` if it does not exist. */
  open(key: string): Promise<{ stream: ReadStream; sizeBytes: number } | null>;
  /** Removes a file. Removing one that is already gone succeeds, so a retry can always finish. */
  remove(key: string): Promise<void>;
  /** A new, unique path in the staging directory, which exists by the time this returns. */
  stagingPath(suffix: string): Promise<string>;
  /**
   * Makes a staged file durable and moves it to its key, atomically. Whoever opens a key sees the whole
   * file or none of it. Keys are made from new UUIDs, so this never replaces anything.
   */
  publish(stagedPath: string, key: string): Promise<void>;
}

/**
 * A Windows drive prefix: `C:`, which also covers `C:/x`, `C:\x` and the drive-relative `C:x`. Checked
 * explicitly because `node:path` only knows the host's own rules, and on Linux `C:/x` is relative.
 */
const DRIVE_PREFIX = /^[A-Za-z]:/;

/**
 * Resolves a key to a path, refusing anything that could reach outside the storage root. A key is the
 * same on every platform: a relative path of forward-slash separated segments. So it may not start with
 * `/` (Unix absolute, and `//server` UNC) or a drive letter, nor contain a backslash (Windows separators,
 * `\\server` UNC), NUL, or an empty, `.` or `..` segment.
 */
export function resolveStorageKey(root: string, key: string): string {
  if (
    key.length === 0 ||
    key.includes('\0') ||
    key.includes('\\') ||
    key.startsWith('/') ||
    DRIVE_PREFIX.test(key) ||
    posix.isAbsolute(key) ||
    win32.isAbsolute(key)
  ) {
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
    async stagingPath(suffix) {
      const directory = resolveStorageKey(root, MEDIA_STAGING_KEY);
      await mkdir(directory, { recursive: true });
      return join(directory, `${randomUUID()}${suffix}`);
    },
    async publish(stagedPath, key) {
      const target = resolveStorageKey(root, key);
      await mkdir(dirname(target), { recursive: true });
      const handle = await open(stagedPath, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(stagedPath, target);
    },
  };
}

/** The directories published media live in, under the storage root. */
export const MEDIA_FILE_DIRECTORIES = [
  'media/originals',
  'media/full',
  'media/thumbnails',
] as const;

/** Removes what a crash left in staging. Anything younger may belong to an upload in progress. */
export async function cleanStaging(root: string, olderThanMs: number): Promise<number> {
  const directory = resolveStorageKey(root, MEDIA_STAGING_KEY);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isMissingFile(error)) return 0;
    throw error;
  }
  let removed = 0;
  for (const name of names) {
    const path = join(directory, name);
    const info = await stat(path).catch(() => null);
    if (info && Date.now() - info.mtimeMs > olderThanMs) {
      await rm(path, { force: true, recursive: true });
      removed += 1;
    }
  }
  return removed;
}

/** Every published file's key. Used to report orphans, which a crash after publishing can leave. */
export async function listMediaKeys(root: string): Promise<string[]> {
  const keys: string[] = [];
  for (const directory of MEDIA_FILE_DIRECTORIES) {
    const base = resolveStorageKey(root, directory);
    let names: string[];
    try {
      names = await readdir(base, { recursive: true });
    } catch (error) {
      if (isMissingFile(error)) continue;
      throw error;
    }
    for (const name of names) {
      const info = await stat(join(base, name)).catch(() => null);
      if (info?.isFile()) keys.push(`${directory}/${name.split(sep).join('/')}`);
    }
  }
  return keys;
}

/** A key for a new file: never derived from anything an agent sent. */
export function newMediaKey(
  directory: (typeof MEDIA_FILE_DIRECTORIES)[number],
  mediaId: string,
  extension: string,
): string {
  return `${directory}/${mediaId.slice(0, 2)}/${mediaId}.${extension}`;
}
