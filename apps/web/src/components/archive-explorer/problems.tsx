import { ARCHIVE_INSPECTION_ERROR_TEXT } from '@emucat/contracts';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { ApiRequestError } from '../../api';
import { LocalArchiveError } from '../../archive-local/errors';
import { IconButton, ICON_SIZE } from '../ui/IconButton';

/**
 * What a failure means, in words (assessment R6): every code the archive routes return has a sentence in the
 * contracts, so a message never depends on the server's wording; an unknown code falls back to the server's message.
 */
export function problemText(error: unknown, fallback = 'The archive could not be read.'): string {
  if (error instanceof ApiRequestError) {
    if (error.code === 'unauthenticated') return 'Your session has ended. Sign in again.';
    if (error.code === 'forbidden') return 'Only administrators can look inside archives.';
    return ARCHIVE_INSPECTION_ERROR_TEXT[error.code] ?? error.message;
  }
  // Browser-local archive failures (decision 0058) carry their own words, never a library's.
  if (error instanceof LocalArchiveError) return error.message;
  if (error instanceof DOMException && error.name === 'AbortError')
    return 'The operation was cancelled.';
  return error instanceof Error && error.message ? error.message : fallback;
}

export function PreviewProblem({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="alert alert-warning small mb-2 d-flex align-items-start gap-2" role="alert">
      <TriangleAlert size={ICON_SIZE} aria-hidden="true" className="flex-shrink-0 mt-1" />
      <span className="flex-grow-1">{problemText(error)}</span>
      {onRetry ? <IconButton icon={RefreshCw} label="Try again" onClick={onRetry} /> : null}
    </div>
  );
}
