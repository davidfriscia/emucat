/**
 * Why a browser-local archive operation failed, as a stable code the interface turns into words. Messages carry no
 * internal detail: offsets and library errors stay out of what a person reads.
 */
export const LOCAL_ARCHIVE_ERROR_CODES = [
  'archive_too_large',
  'depth_limit',
  'memory_budget',
  'too_many_entries',
  'unsupported_format',
  'unsupported_compression',
  'encrypted',
  'malformed',
  'truncated',
  'multi_volume',
  'integrity_failed',
  'decompression_limit',
  'timeout',
  'cancelled',
  'entry_unreadable',
  'preview_too_large',
  'image_too_large',
  'image_invalid',
  'offset_unsupported',
  'download_too_large',
  'busy',
  'evicted',
  'worker_failed',
] as const;
export type LocalArchiveErrorCode = (typeof LOCAL_ARCHIVE_ERROR_CODES)[number];

export class LocalArchiveError extends Error {
  override readonly name = 'LocalArchiveError';

  constructor(
    readonly code: LocalArchiveErrorCode,
    message: string = LOCAL_ARCHIVE_ERROR_TEXT[code],
  ) {
    super(message);
  }
}

export const LOCAL_ARCHIVE_ERROR_TEXT: Record<LocalArchiveErrorCode, string> = {
  archive_too_large: 'This archive is larger than the browser opens inside another archive.',
  depth_limit: 'This archive is nested deeper than the browser opens archives.',
  memory_budget:
    'The browser’s memory budget for opened archives is full. Collapse other archives, or close and reopen the explorer.',
  too_many_entries: 'This archive has more entries than the browser lists.',
  unsupported_format: 'This archive format cannot be opened in the browser.',
  unsupported_compression: 'This entry uses a compression method the browser does not read.',
  encrypted: 'This entry is encrypted, so it cannot be read.',
  malformed: 'The archive is damaged or is not the format it appears to be.',
  truncated: 'The archive is truncated: it ends before its last entry does.',
  multi_volume: 'This is one part of a multi-volume archive, which cannot be opened on its own.',
  integrity_failed:
    'The file does not match the checksum its archive records. The archive may be damaged.',
  decompression_limit:
    'Decompressing this would produce more data than the browser allows, so it was stopped.',
  timeout: 'Reading this took too long, so the browser stopped.',
  cancelled: 'The operation was cancelled.',
  entry_unreadable: 'This entry cannot be read.',
  preview_too_large: 'This file is larger than the browser previews this way.',
  image_too_large: 'The image has more pixels than the browser previews.',
  image_invalid: 'The image is damaged or is not what its contents first suggested.',
  offset_unsupported: 'This entry is compressed, so only its beginning can be shown.',
  download_too_large: 'This file is larger than the browser saves from inside an archive.',
  busy: 'The browser is already opening as many archives as it allows. Try again shortly.',
  evicted: 'This archive was released to free memory. Expand it again to reload it.',
  worker_failed: 'The archive reader stopped unexpectedly. Try again.',
};

export function isLocalArchiveError(error: unknown): error is LocalArchiveError {
  return error instanceof LocalArchiveError;
}

export const depthLimitError = (maxDepth: number): LocalArchiveError =>
  new LocalArchiveError(
    'depth_limit',
    `Archives inside archives are opened at most ${maxDepth} ${maxDepth === 1 ? 'level' : 'levels'} deep, and this one is deeper.`,
  );
