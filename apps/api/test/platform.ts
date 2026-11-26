/**
 * What the API's tests may assume about the host's filesystem, and how they make the same check on each platform.
 * The API runs in Linux containers in production; Windows is a development platform. A check whose subject does not
 * exist on Windows says so where it is made, rather than passing or failing for the wrong reason. See
 * `docs/testing.md`, "Platform-specific filesystem semantics".
 */
import { lstat, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect } from 'vitest';

export const isWindows = process.platform === 'win32';

/**
 * A link from `path` to the directory `target`. POSIX: a symbolic link. Windows: a junction, which any account may
 * create (a symbolic link needs Developer Mode or elevation) and which `lstat` reports as a symbolic link, exactly as
 * the code under test detects links. The created link is checked to be one.
 */
export async function linkDirectory(target: string, path: string): Promise<void> {
  await symlink(target, path, isWindows ? 'junction' : 'dir');
  expect((await lstat(path)).isSymbolicLink(), `${path} is a link`).toBe(true);
}

/**
 * Whether a link to a regular file can be refused on this platform. POSIX opens files with O_NOFOLLOW; Node has no
 * such flag on Windows (`constants.O_NOFOLLOW` is undefined), and file symbolic links need Developer Mode there.
 */
export const fileLinksRefusable = !isWindows;

/**
 * Points the process's temporary directory at `directory` until the returned function is called. `os.tmpdir()` reads
 * TMPDIR on POSIX and TEMP, then TMP, on Windows: all three are set, so whatever the code under test creates there
 * lands in `directory` on either platform. The redirection is checked to have taken effect.
 */
export function redirectTemporaryDirectory(directory: string): () => void {
  const names = ['TMPDIR', 'TEMP', 'TMP'] as const;
  const saved = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) process.env[name] = directory;
  expect(tmpdir()).toBe(directory);
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

/**
 * POSIX: the file's permission bits are exactly `mode`. Windows has no permission bits (Node reports 0o666, or 0o444
 * for a read-only file) and access is governed by ACLs inherited from the directory, so only what the mode can say
 * there is checked: a regular, writable file.
 */
export async function expectFileMode(path: string, mode: number): Promise<void> {
  const info = await stat(path);
  expect(info.isFile(), `${path} is a regular file`).toBe(true);
  if (isWindows) expect(info.mode & 0o200, `${path} is writable`).toBe(0o200);
  else expect(info.mode & 0o777, `${path} mode`).toBe(mode);
}
