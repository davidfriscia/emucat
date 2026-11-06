import type { EmulatorType } from './emulator.js';

/**
 * Splits a VM-relative path into segments, or returns `null` if the path could escape the VM
 * directory. Both separators are accepted because archives can move between operating systems.
 */
export function parseVmRelativePath(path: string): string[] | null {
  if (path.length === 0 || path.includes('\0')) return null;
  const normalized = path.replaceAll('\\', '/');
  // A leading slash is absolute. A colon means a drive letter or an NTFS alternate data stream.
  if (normalized.startsWith('/') || normalized.includes(':')) return null;
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null;
  }
  return segments;
}

const isRootPpm = (segments: readonly string[]): boolean =>
  segments.length === 1 && (segments[0] ?? '').toLowerCase().endsWith('.ppm');

const isInScreenshotsDirectory = (segments: readonly string[]): boolean =>
  segments.length > 1 && segments[0]?.toLowerCase() === 'screenshots';

/**
 * Whether a VM-relative file must be left out of master and snapshot archives. Media are
 * independent of versions, so media locations are always excluded. Matching ignores case so that a
 * media file can never leak into an archive because of how a host spelled the name. Unsafe paths
 * throw rather than returning a verdict: finding one indicates a bug or a hostile archive.
 */
export function isExcludedFromArchive(emulatorType: EmulatorType, path: string): boolean {
  const segments = parseVmRelativePath(path);
  if (!segments) throw new Error('Unsafe VM-relative path');
  return emulatorType === '86box' ? isInScreenshotsDirectory(segments) : isRootPpm(segments);
}

/** File name endings the agent treats as screenshots in an 86Box `screenshots` tree, ignoring case. */
export const SCREENSHOT_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.bmp', '.ppm'] as const;

const hasScreenshotExtension = (name: string): boolean => {
  const lower = name.toLowerCase();
  return SCREENSHOT_EXTENSIONS.some((extension) => lower.endsWith(extension));
};

/**
 * Whether a VM-relative file is a media file the agent should pick up: a supported image anywhere in an
 * 86Box `screenshots` tree, or a `.ppm` file in a QEMU VM's root. Everything else in the `screenshots`
 * tree is still excluded from archives, which is why a transfer treats it as unpreserved.
 */
export function isWatchedMediaPath(emulatorType: EmulatorType, path: string): boolean {
  const segments = parseVmRelativePath(path);
  if (!segments) return false;
  return emulatorType === '86box'
    ? isInScreenshotsDirectory(segments) && hasScreenshotExtension(segments.at(-1) ?? '')
    : isRootPpm(segments);
}
