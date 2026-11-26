import { ARCHIVE_INSPECTION_ERROR_TEXT } from '@emucat/contracts';
import { ApiRequestError } from '../../api';

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
  return error instanceof Error && error.message ? error.message : fallback;
}

export function PreviewProblem({ error }: { error: unknown }) {
  return (
    <div className="alert alert-warning small mb-2" role="alert">
      {problemText(error)}
    </div>
  );
}
