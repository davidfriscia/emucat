import { startsWith } from './bytes';
import { isGzip } from './gzip';
import type { LocalArchiveFormat } from './model';
import { looksLikeTar } from './tar';
import { isSpannedZip, isZip } from './zip';

/**
 * What an archive is (decision 0058). A name only says what a file may be, so that the tree can offer to open it; the
 * format is confirmed from the bytes, and then by the parser, before anything inside is shown. A name never makes a
 * file be read as an archive, and a file is never downloaded just to find out.
 */

const NAME_FORMATS: [RegExp, LocalArchiveFormat][] = [
  [/\.(tar\.gz|tgz)$/iu, 'tar.gz'],
  [/\.(zip|jar)$/iu, 'zip'],
  [/\.tar$/iu, 'tar'],
  [/\.ova$/iu, 'ova'],
  [/\.gz$/iu, 'gzip'],
];

/** Formats recognized by name or signature and not opened by the browser, with the name a person knows them by. */
const UNSUPPORTED_NAMES: [RegExp, string][] = [
  [/\.7z$/iu, '7z'],
  [/\.rar$/iu, 'RAR'],
  [/\.(tar\.bz2|tbz2?|bz2)$/iu, 'BZIP2'],
  [/\.(tar\.xz|txz|xz)$/iu, 'XZ'],
  [/\.(tar\.zst|zst)$/iu, 'Zstandard'],
  [/\.cab$/iu, 'CAB'],
  [/\.arj$/iu, 'ARJ'],
  [/\.(lzh|lha)$/iu, 'LHA'],
  [/\.(arc|zoo|sit|sitx|hqx|ace|pak)$/iu, 'legacy archive'],
  [/\.z$/u, 'compress (.Z)'],
];

/**
 * Disk and media images are files here, never archives, whatever their bytes look like: what is inside them is a
 * guest filesystem, which Archive Explorer does not explore.
 */
const DISK_IMAGES =
  /\.(iso|img|ima|imz|vfd|flp|dsk|hdd|hdf|hdi|hds|raw|bin|cue|mdf|mds|nrg|ccd|chd|vhd|vhdx|vdi|vmdk|qcow|qcow2|qed|86f|td0|imd|d88|fdi)$/iu;

export function isDiskImageName(name: string): boolean {
  return DISK_IMAGES.test(name);
}

export function archiveFormatFromName(name: string): LocalArchiveFormat | null {
  for (const [pattern, format] of NAME_FORMATS) if (pattern.test(name)) return format;
  return null;
}

export function unsupportedArchiveFromName(name: string): string | null {
  for (const [pattern, label] of UNSUPPORTED_NAMES) if (pattern.test(name)) return label;
  return null;
}

/** The format from the first bytes, without the name: what the parser will be asked to read. */
export function sniffArchive(head: Uint8Array): LocalArchiveFormat | 'zip-spanned' | null {
  if (isZip(head)) return 'zip';
  if (isSpannedZip(head)) return 'zip-spanned';
  if (isGzip(head)) return 'gzip';
  if (looksLikeTar(head)) return 'tar';
  return null;
}

export function sniffUnsupportedArchive(head: Uint8Array): string | null {
  if (startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z';
  if (startsWith(head, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return 'RAR';
  if (startsWith(head, [0x42, 0x5a, 0x68])) return 'BZIP2';
  if (startsWith(head, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return 'XZ';
  if (startsWith(head, [0x28, 0xb5, 0x2f, 0xfd])) return 'Zstandard';
  if (startsWith(head, [0x4d, 0x53, 0x43, 0x46])) return 'CAB';
  if (startsWith(head, [0x60, 0xea])) return 'ARJ';
  if (head.length >= 7 && head[2] === 0x2d && head[3] === 0x6c && head[6] === 0x2d) return 'LHA';
  return null;
}
