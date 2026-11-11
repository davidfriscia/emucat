import { z } from 'zod';
import { emulatorTypeSchema } from './emulator.js';
import { sha256HexSchema, timestampSchema } from './version.js';
import { vmNameSchema } from './vm-name.js';

/**
 * Restoring creates a local copy of an immutable master on one agent. The archive travels directly from
 * the repository to the agent, and the agent derives where it goes from its own configuration. See
 * decision 0021.
 */
export const RESTORE_STATES = [
  'queued',
  'validating',
  'downloading',
  'verifying',
  'extracting',
  'publishing_local',
  'committing',
  'succeeded',
  'failed',
  'cancelled',
  'partial_success',
] as const;
export const restoreStateSchema = z.enum(RESTORE_STATES);
export type RestoreState = z.infer<typeof restoreStateSchema>;

export const RESTORE_TERMINAL_STATES: readonly RestoreState[] = [
  'succeeded',
  'failed',
  'cancelled',
  'partial_success',
];

export function isRestoreTerminal(state: RestoreState): boolean {
  return RESTORE_TERMINAL_STATES.includes(state);
}

/** Once a VM may already be in place, a cancellation cannot be honoured any more. */
export function isRestoreCancellable(state: RestoreState): boolean {
  return (
    state === 'queued' ||
    state === 'validating' ||
    state === 'downloading' ||
    state === 'verifying' ||
    state === 'extracting'
  );
}

/** Every failure that has a code. Unknown codes from a newer agent are still shown, with their text. */
export const RESTORE_ERROR_CODES = [
  // From the archive. Nothing was published.
  'restore_integrity_failed',
  'restore_manifest_invalid',
  'restore_unsafe_archive',
  'restore_limit_exceeded',
  // From the agent's disk. Nothing was published.
  'restore_destination_exists',
  'restore_destination_unsafe',
  'restore_ambiguous_directory',
  'restore_emulator_not_configured',
  'restore_insufficient_space',
  'restore_staging_failed',
  // Replacing a persistent copy. The current copy was kept.
  'local_copy_modified',
  'local_copy_unverified',
  'local_copy_changed',
  'local_copy_missing',
  'restore_replacement_failed',
  // From the repository.
  'repository_not_configured',
  'repository_unreachable',
  'ssh_authentication_failed',
  'host_key_unknown',
  'host_key_changed',
  'repository_permission_denied',
  'upload_interrupted',
  'remote_object_missing',
  'hash_mismatch',
  'repository_error',
  // From the workflow.
  'cancelled',
  'restore_cancel_too_late',
  'agent_restarted',
  'agent_busy',
  'agent_revoked',
  'agent_lost_operation',
  'invalid_request',
  'invalid_result',
  'internal_error',
] as const;
export type RestoreErrorCode = (typeof RESTORE_ERROR_CODES)[number];

const RECOVERY: Partial<Record<string, string>> = {
  restore_integrity_failed:
    'The local VM directory was not changed. Check the repository’s disk: the archive does not match what was verified when it was registered.',
  restore_manifest_invalid:
    'The local VM directory was not changed. The archive’s manifest is not one EmuCat can trust, so check the repository’s copy.',
  restore_unsafe_archive:
    'The local VM directory was not changed. The archive holds something that cannot be extracted safely, and was refused.',
  restore_limit_exceeded:
    'The local VM directory was not changed. The archive is larger than this agent’s configured limits allow.',
  restore_destination_exists:
    'A directory with this name already exists in the emulator’s base path, and is never overwritten. Move it away yourself if you want to restore here.',
  restore_destination_unsafe:
    'The emulator’s base path or the directory being published is a link, or was replaced during the restore. Nothing was published. Check the base path.',
  restore_ambiguous_directory:
    'The agent stopped during publication and cannot tell what a directory is, so it left everything alone. Look at the directory named in the message, and remove it by hand if it is not needed.',
  restore_emulator_not_configured:
    'Configure this emulator’s base path on the agent, and restart the agent.',
  restore_insufficient_space:
    'Free up space on the staging or destination disk, or lower the cache’s size limit, and try again.',
  restore_staging_failed: 'Check the agent’s staging directory, and try again.',
  local_copy_modified:
    'The local copy differs from the version it was restored from, so it was kept. Snapshot it first, or confirm that its changes may be discarded.',
  local_copy_unverified:
    'The agent cannot prove which version the local copy comes from, so its changes cannot be ruled out. It was kept. Verify it, or confirm that its changes may be discarded.',
  local_copy_changed:
    'The local copy is no longer the one the page showed. It was kept. Reload, and try again.',
  local_copy_missing: 'There is no local copy to replace any more. Reload, and restore normally.',
  restore_replacement_failed:
    'The new version could not be put in place, and the previous local copy was put back unchanged. Check the agent’s log, and try again.',
  repository_not_configured:
    'Add this repository’s UUID to the agent’s configuration, and restart the agent.',
  repository_unreachable: 'Check that the SSH server is running and reachable, and try again.',
  ssh_authentication_failed: 'Install the agent’s public key on the SSH server.',
  host_key_unknown:
    'Check the server’s fingerprint out of band, then add it to the agent’s configuration.',
  host_key_changed:
    'Find out why the server’s key changed before trusting it. If the server was reinstalled, update the fingerprint in the agent’s configuration.',
  repository_permission_denied: 'Give the SSH account read access to the remote root.',
  upload_interrupted:
    'The transfer was interrupted. Nothing was published. It is safe to try again.',
  remote_object_missing:
    'The archive is missing from the repository. Nothing was published. Check the repository.',
  hash_mismatch:
    'The download did not match what was verified at registration. Nothing was published. Check the repository’s disk.',
  repository_error: 'Nothing was published. Check the agent’s log, and try again.',
  cancelled: 'Nothing was published.',
  restore_cancel_too_late:
    'The VM had already been published when the cancellation arrived, so the local copy exists and is verified. Remove it by hand if it is not wanted.',
  agent_restarted:
    'The agent restarted before publishing. Nothing was published. It is safe to try again.',
  agent_busy: 'Wait for the agent’s other operation to finish.',
  agent_revoked: 'Pair the agent again to use it.',
  agent_lost_operation:
    'The agent no longer knows about this operation, for example because its state directory was removed. Check whether the directory exists, and try again.',
  invalid_request: 'Update the agent and the server to the same version.',
  invalid_result: 'Update the agent and the server to the same version.',
};

/** What an administrator can do about a failure. */
export function restoreRecovery(code: string): string | null {
  return RECOVERY[code] ?? null;
}

const safeSizeSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const errorCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/)
  .max(64);
const errorMessageSchema = z.string().max(1024);
const localPathSchema = z.string().min(1).max(1024);

// The protocol.

/**
 * A command, holding immutable identities and no path or address. The agent recomputes the archive key,
 * derives the destination from its own configuration, and refuses a request with any other field.
 */
export const restoreRequestPayloadSchema = z.strictObject({
  operationId: z.uuid(),
  emulatorType: emulatorTypeSchema,
  vmName: vmNameSchema,
  repositoryId: z.uuid(),
  versionId: z.uuid(),
  archiveKey: z.string().min(1).max(512),
  archiveSizeBytes: safeSizeSchema.positive(),
  archiveSha256: sha256HexSchema,
  /** What the registration verified, when it is known. The agent compares it with what it reads. */
  manifestSha256: sha256HexSchema.nullable(),
  /** For checking disk space before downloading. Never a limit, and never trusted as one. */
  expectedUncompressedBytes: safeSizeSchema.nullable(),
  /**
   * Restore into this Remote Snapshot working copy, under the agent's own workspaces directory, rather
   * than under the emulator's base path. The persistent local copy is never touched. See decision 0038.
   */
  workspaceId: z.uuid().optional(),
  /**
   * What the working copy is for, recorded with it so that the agent can refuse to run or snapshot it in
   * another way. Absent for Milestone 7 working copies, which are `manual`. See decision 0040.
   */
  workspacePurpose: z.enum(['remote_volatile', 'remote_snapshot']).optional(),
  /**
   * Replace the persistent local copy, which must exist. The agent checks that it is the copy of
   * `expectedVersionId` and, unless `discardLocalChanges`, that it is unchanged, before anything else;
   * the old copy is kept until the new one is in place. Never combined with `workspaceId`.
   */
  replace: z
    .strictObject({
      expectedVersionId: z.uuid().nullable(),
      discardLocalChanges: z.boolean(),
    })
    .optional(),
});
export type RestoreRequestPayload = z.infer<typeof restoreRequestPayloadSchema>;

export const restoreCancelPayloadSchema = z.strictObject({ operationId: z.uuid() });
export type RestoreCancelPayload = z.infer<typeof restoreCancelPayloadSchema>;

export const RESTORE_ACK_OUTCOMES = ['closed', 'rejected'] as const;
export const restoreAckPayloadSchema = z.strictObject({
  operationId: z.uuid(),
  /**
   * `closed`: the server has recorded everything, and the agent can forget this operation.
   * `rejected`: the server does not recognize it. An agent never deletes a local VM because of this.
   */
  outcome: z.enum(RESTORE_ACK_OUTCOMES),
});
export type RestoreAckPayload = z.infer<typeof restoreAckPayloadSchema>;

export const RESTORE_SYNC_PHASES = ['running', 'publishing', 'published', 'reported'] as const;
export const LOCAL_COPY_REPORTS = ['unverified', 'modified', 'absent'] as const;
export const RESTORE_LOCAL_COPIES_MAX = 256;

/**
 * Sent after each welcome. What this agent could restore, what it has in its journals, and what it can
 * say about local copies it restored: a difference proves a change, and no difference proves nothing,
 * which is why there is no "verified" here.
 */
export const restoreSyncPayloadSchema = z.object({
  operations: z
    .array(z.object({ operationId: z.uuid(), phase: z.enum(RESTORE_SYNC_PHASES) }))
    .max(256),
  capabilities: z.object({
    emulators: z
      .array(z.object({ emulatorType: emulatorTypeSchema, basePath: localPathSchema }))
      .max(2),
    repositoryIds: z.array(z.uuid()).max(64),
    cacheMaxBytes: safeSizeSchema,
    cacheUsedBytes: safeSizeSchema,
    /** Whether the agent can replace a persistent copy safely (decision 0040). Older agents do not say. */
    replaceLocal: z.boolean().optional(),
  }),
  localCopies: z
    .array(
      z.object({
        emulatorType: emulatorTypeSchema,
        vmName: vmNameSchema,
        versionId: z.uuid(),
        status: z.enum(LOCAL_COPY_REPORTS),
      }),
    )
    .max(RESTORE_LOCAL_COPIES_MAX),
  /** The working copies this agent holds, for any purpose. Older agents do not say. */
  workspaces: z.array(z.uuid()).max(256).optional(),
});
export type RestoreSyncPayload = z.infer<typeof restoreSyncPayloadSchema>;

export const RESTORE_STAGES = [
  'validating',
  'downloading',
  'verifying',
  'extracting',
  'publishing_local',
] as const;

/** Only real measurements: without a known total there is no total. */
export const restoreProgressPayloadSchema = z.object({
  operationId: z.uuid(),
  stage: z.enum(RESTORE_STAGES),
  doneBytes: safeSizeSchema.nullable(),
  totalBytes: safeSizeSchema.nullable(),
  /** Known once the agent has looked in its cache. */
  cacheHit: z.boolean().nullable(),
});
export type RestoreProgressPayload = z.infer<typeof restoreProgressPayloadSchema>;

/** A report of what the agent verified and where it put it. It authorizes nothing by itself. */
export const restoreResultPayloadSchema = z.object({
  operationId: z.uuid(),
  versionId: z.uuid(),
  archiveSizeBytes: safeSizeSchema.positive(),
  archiveSha256: sha256HexSchema,
  manifestVersion: z.number().int().positive(),
  manifestSha256: sha256HexSchema,
  fileCount: safeSizeSchema,
  totalUncompressedBytes: safeSizeSchema,
  localDirectory: localPathSchema,
  cache: z.object({
    hit: z.boolean(),
    downloadedBytes: safeSizeSchema,
    archiveCached: z.boolean(),
    totalBytes: safeSizeSchema,
  }),
});
export type RestoreResultPayload = z.infer<typeof restoreResultPayloadSchema>;

export const restoreErrorPayloadSchema = z.object({
  operationId: z.uuid(),
  code: errorCodeSchema,
  message: errorMessageSchema,
});
export type RestoreErrorPayload = z.infer<typeof restoreErrorPayloadSchema>;

// What an administrator asks for, and sees.

/**
 * Replacing an existing persistent copy: always explicit, since a request without this object never
 * touches a copy. `expectedVersionId` is the version the page showed as installed, so that a stale page
 * cannot replace a copy it did not show. `discardLocalChanges` acknowledges that changes in no version are
 * lost, and is required when the copy is known to differ. The administrator confirms with an explicit
 * button; the VM's name is not typed again.
 */
export const restoreReplaceSchema = z.strictObject({
  expectedVersionId: z.uuid().nullable(),
  discardLocalChanges: z.boolean(),
});
export type RestoreReplace = z.infer<typeof restoreReplaceSchema>;

/** It can name a VM, one of its versions and an agent. It can never say where anything goes. */
export const createRestoreRequestSchema = z.strictObject({
  agentId: z.uuid(),
  emulatorType: emulatorTypeSchema,
  vmName: vmNameSchema,
  versionId: z.uuid(),
  /** Required when the agent already holds a persistent copy, refused when it does not. */
  replace: restoreReplaceSchema.optional(),
});
export type CreateRestoreRequest = z.infer<typeof createRestoreRequestSchema>;

export const restoreOperationSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  agentName: z.string(),
  agentOnline: z.boolean(),
  repositoryId: z.uuid(),
  repositoryName: z.string(),
  emulatorType: emulatorTypeSchema,
  vmName: z.string(),
  versionId: z.uuid(),
  /** Set when this restore prepares a Remote Snapshot working copy. */
  workspaceId: z.uuid().nullable(),
  /** Whether this restore replaced an existing persistent copy, and which version that copy was. */
  replacement: z
    .object({
      replacedVersionId: z.uuid().nullable(),
      discardLocalChanges: z.boolean(),
    })
    .nullable(),
  state: restoreStateSchema,
  archive: z.object({ sizeBytes: safeSizeSchema, sha256: sha256HexSchema }),
  progress: z.object({
    doneBytes: safeSizeSchema.nullable(),
    totalBytes: safeSizeSchema.nullable(),
  }),
  /** Filled in once the agent has reported what it verified. The server has not read the archive. */
  verified: z
    .object({
      manifestVersion: z.number().int(),
      manifestSha256: sha256HexSchema,
      fileCount: safeSizeSchema,
      totalUncompressedBytes: safeSizeSchema,
      verifiedBy: z.literal('agent'),
    })
    .nullable(),
  localDirectory: z.string().nullable(),
  cache: z.object({
    hit: z.boolean().nullable(),
    downloadedBytes: safeSizeSchema.nullable(),
    archiveCached: z.boolean().nullable(),
    totalBytes: safeSizeSchema.nullable(),
  }),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  recovery: z.string().nullable(),
  cancelRequested: z.boolean(),
  requestedByDisplayName: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  finishedAt: timestampSchema.nullable(),
});
export type RestoreOperation = z.infer<typeof restoreOperationSchema>;

export const restoreListResponseSchema = z.object({ operations: z.array(restoreOperationSchema) });
export type RestoreListResponse = z.infer<typeof restoreListResponseSchema>;

export const restorePathParamsSchema = z.object({ operationId: z.uuid() });
export const restoreListQuerySchema = z.object({
  agentId: z.uuid().optional(),
  emulatorType: emulatorTypeSchema.optional(),
  vmName: vmNameSchema.optional(),
});

export const RESTORE_INELIGIBLE_REASONS = [
  'agent_revoked',
  'agent_offline',
  'agent_cannot_restore',
  'emulator_not_configured',
  'repository_not_authorized',
  'repository_not_configured',
  'local_copy_exists',
  /** Replacing needs a persistent copy to replace. */
  'no_local_copy',
  'vm_running',
  'operation_in_progress',
] as const;
export type RestoreIneligibleReason = (typeof RESTORE_INELIGIBLE_REASONS)[number];

export const LOCAL_AVAILABILITIES = ['none', 'absent', 'present'] as const;

/** What one agent could do, and what it holds. Only an authenticated administrator ever sees this. */
export const restoreAgentOptionSchema = z.object({
  agentId: z.uuid(),
  agentName: z.string(),
  online: z.boolean(),
  eligible: z.boolean(),
  ineligibleReason: z.enum(RESTORE_INELIGIBLE_REASONS).nullable(),
  /** The directory this agent says it would use. It decides that itself, from its configuration. */
  destination: z.string().nullable(),
  local: z.object({
    availability: z.enum(LOCAL_AVAILABILITIES),
    contentStatus: z.enum(['unverified', 'verified', 'modified']).nullable(),
    sourceVersionId: z.uuid().nullable(),
    lastVerifiedAt: timestampSchema.nullable(),
  }),
  /**
   * Whether the persistent copy can be replaced now, when there is one. Replacing needs the same as a
   * restore, and a VM that is not running.
   */
  replace: z.object({
    eligible: z.boolean(),
    reason: z.enum(RESTORE_INELIGIBLE_REASONS).nullable(),
  }),
  cacheUsedBytes: safeSizeSchema.nullable(),
  cacheMaxBytes: safeSizeSchema.nullable(),
});
export type RestoreAgentOption = z.infer<typeof restoreAgentOptionSchema>;

export const restorableVersionSchema = z.object({
  versionId: z.uuid(),
  repositoryId: z.uuid(),
  repositoryName: z.string(),
  repositoryEnabled: z.boolean(),
  archiveSizeBytes: safeSizeSchema,
  archiveSha256: sha256HexSchema,
  createdAt: timestampSchema,
  manifestSha256: sha256HexSchema.nullable(),
  fileCount: safeSizeSchema.nullable(),
  totalUncompressedBytes: safeSizeSchema.nullable(),
});
export type RestorableVersion = z.infer<typeof restorableVersionSchema>;

export const restoreOptionsResponseSchema = z.object({
  master: restorableVersionSchema.nullable(),
  /** Every version, the master included, oldest first. Any of them can be restored. */
  versions: z.array(
    restorableVersionSchema.extend({
      kind: z.enum(['master', 'snapshot']),
      parentVersionId: z.uuid().nullable(),
      snapshotName: z.string().nullable(),
    }),
  ),
  agents: z.array(restoreAgentOptionSchema),
});
export type RestoreOptionsResponse = z.infer<typeof restoreOptionsResponseSchema>;
