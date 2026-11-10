import { z } from 'zod';
import { vmSessionSchema } from './execution.js';
import { registrationOperationSchema } from './registration.js';
import { restoreOperationSchema } from './restore.js';
import { vmWorkspaceSchema, type WorkspacePurpose, type WorkspaceState } from './versions.js';

/**
 * A remote session as the interface follows it: the working copy, and the three operations that carry it,
 * so that one request shows its whole progress. See decision 0040.
 */
export const remoteSessionSchema = vmWorkspaceSchema.extend({
  /** The restore that obtained, verified and extracted the version. */
  restore: restoreOperationSchema.nullable(),
  /** The emulator's session. */
  session: vmSessionSchema.nullable(),
  /** The current publication attempt of a Remote Snapshot. */
  snapshot: registrationOperationSchema.nullable(),
  /** What an administrator can do about where it stands, in words. */
  recovery: z.string().nullable(),
});
export type RemoteSession = z.infer<typeof remoteSessionSchema>;

export const remoteSessionListResponseSchema = z.object({
  workspaces: z.array(remoteSessionSchema),
});
export type RemoteSessionListResponse = z.infer<typeof remoteSessionListResponseSchema>;

/** The steps of a remote session, in order, for a progress display. */
export const REMOTE_SESSION_STEPS = ['prepare', 'run', 'publish', 'cleanup'] as const;
export type RemoteSessionStep = (typeof REMOTE_SESSION_STEPS)[number];

/** Which step a remote session is on, or `done`. */
export function remoteSessionStep(
  purpose: WorkspacePurpose,
  state: WorkspaceState,
): RemoteSessionStep | 'done' {
  switch (state) {
    case 'preparing':
      return 'prepare';
    case 'ready':
    case 'running':
    case 'held':
      return 'run';
    case 'publishing':
    case 'publish_failed':
      return purpose === 'remote_snapshot' ? 'publish' : 'cleanup';
    case 'discarding':
      return 'cleanup';
    default:
      return 'done';
  }
}

const WORKSPACE_RECOVERY: Partial<Record<string, string>> = {
  held: 'The session ended without the agent accounting for the emulator. Check that it no longer runs on that computer, then resume.',
  publish_failed:
    'The temporary copy is kept, and nothing was published. Retry the publication, or abandon the snapshot.',
};

export function remoteSessionRecovery(state: WorkspaceState): string | null {
  return WORKSPACE_RECOVERY[state] ?? null;
}
