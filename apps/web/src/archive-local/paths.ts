import { utf8Length } from './bytes';

/**
 * Whether a stored name is safe to show inside the tree, and how. A name is shown as a path only when every segment
 * is an ordinary name: no `..`, no absolute path or drive letter, no control characters. Backslashes, which DOS
 * archivers wrote, are read as separators. Anything else is shown whole at the archive's root, marked, and never read.
 */
export function normalizeEntryPath(
  raw: string,
  maxBytes: number,
): { path: string; directory: boolean } | { problem: string } {
  if (raw === '') return { problem: 'has an empty name' };
  if (utf8Length(raw) > maxBytes) return { problem: 'has a path that is too long' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(raw)) return { problem: 'has control characters in its name' };
  let path = raw.replace(/\\/gu, '/');
  if (path.startsWith('/') || /^[A-Za-z]:/u.test(path)) return { problem: 'has an absolute path' };
  while (path.startsWith('./')) path = path.slice(2);
  const directory = path.endsWith('/');
  if (directory) path = path.slice(0, -1);
  if (path === '') return { problem: 'has an empty name' };
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '') return { problem: 'has an empty path segment' };
    if (segment === '..' || segment === '.') return { problem: 'leaves its directory (..)' };
  }
  return { path: segments.join('/'), directory };
}

export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
