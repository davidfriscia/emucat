import { z } from 'zod';
import { emulatorTypeSchema } from './emulator.js';
import { sha256HexSchema, timestampSchema } from './version.js';
import { vmNameSchema } from './vm-name.js';

/**
 * Storage cleanup: removing one agent's persistent local copy of a VM, and permanently deleting a leaf
 * snapshot from the repository. Both are administrative, explicit and durable. See decision 0041.
 */

const safeSizeSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const errorCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/)
  .max(64);
const errorMessageSchema = z.string().max(1024);
const localPathSchema = z.string().min(1).max(1024);

// Removing a persistent local copy.

export const LOCAL_REMOVAL_STATES = ['requested', 'succeeded', 'failed'] as const;
export const localRemovalStateSchema = z.enum(LOCAL_REMOVAL_STATES);
export type LocalRemovalState = z.infer<typeof localRemovalStateSchema>;

export function isLocalRemovalTerminal(state: LocalRemovalState): boolean {
  return state !== 'requested';
}

/** Every failure that has a code. Unknown codes from a newer agent are still shown, with their text. */
export const LOCAL_REMOVAL_ERROR_CODES = [
  // The local copy was kept.
  'vm_running',
  'operation_in_progress',
  'agent_busy',
  'local_copy_missing',
  'local_copy_changed',
  'local_copy_modified',
  'local_copy_unverified',
  'local_copy_unsynced_media',
  'local_copy_in_use',
  'local_copy_unsafe',
  'restore_emulator_not_configured',
  'agent_restarted',
  // From the workflow.
  'agent_revoked',
  'agent_lost_operation',
  'invalid_request',
  'invalid_result',
  'internal_error',
] as const;
export type LocalRemovalErrorCode = (typeof LOCAL_REMOVAL_ERROR_CODES)[number];

const REMOVAL_RECOVERY: Partial<Record<string, string>> = {
  vm_running:
    'The VM is running on this agent, or may be. Stop it, or dismiss its session, then try again. Nothing was removed.',
  operation_in_progress:
    'Something else is working on this VM on that agent. Wait for it to finish. Nothing was removed.',
  agent_busy:
    'The agent is busy with another operation. Wait for it to finish. Nothing was removed.',
  local_copy_missing:
    'There is no local copy of this VM on that agent any more. Reload the page. Nothing was removed.',
  local_copy_changed:
    'The local copy is no longer the one the page showed. Reload, and try again. Nothing was removed.',
  local_copy_modified:
    'The local copy differs from its version. Snapshot it first, or confirm that its changes may be discarded. Nothing was removed.',
  local_copy_unverified:
    'The agent cannot prove which version the local copy comes from, so changes cannot be ruled out. Verify it, or confirm that its changes may be discarded. Nothing was removed.',
  local_copy_unsynced_media:
    'Screenshots in the local copy have not reached the server yet, and would be lost. Wait for them to synchronize, or confirm that local changes may be discarded. Nothing was removed.',
  local_copy_in_use:
    'A file of the local copy is open in another program, so it could not be moved aside. Close it, and try again. Nothing was removed.',
  local_copy_unsafe:
    'The local copy or the base path is a link, a junction or not a plain directory, so it was left alone. Check that computer.',
  restore_emulator_not_configured:
    'This emulator is not configured on the agent any more, so it cannot find the local copy.',
  agent_restarted:
    'The agent restarted before it moved the local copy aside. Nothing was removed. It is safe to try again.',
  agent_revoked: 'The agent was revoked before this finished.',
  agent_lost_operation:
    'The agent no longer knows about this operation, for example because its state directory was removed. Check that computer: the local copy may still be there.',
  invalid_request: 'Update the agent and the server to the same version.',
  invalid_result: 'Update the agent and the server to the same version.',
};

/** What an administrator can do about a refused or failed removal. */
export function localRemovalRecovery(code: string): string | null {
  return REMOVAL_RECOVERY[code] ?? null;
}

/**
 * The command. It names an identity and what the administrator saw, never a path: the agent finds the
 * directory itself, under the base path it is configured with.
 */
export const localCopyRemovePayloadSchema = z.strictObject({
  operationId: z.uuid(),
  emulatorType: emulatorTypeSchema,
  vmName: vmNameSchema,
  /** The version the page showed as installed. A copy recorded as another is never removed. */
  expectedVersionId: z.uuid().nullable(),
  /** The administrator acknowledged that changes in no version, screenshots included, are lost. */
  discardLocalChanges: z.boolean(),
});
export type LocalCopyRemovePayload = z.infer<typeof localCopyRemovePayloadSchema>;

/**
 * The answer, repeated until acknowledged. `removed` means the directory is no longer under the base
 * path, and the agent no longer records a copy. `cleanupPending` means leftovers of it, moved aside, are
 * still being deleted by the agent.
 */
export const localCopyRemoveResultPayloadSchema = z.object({
  operationId: z.uuid(),
  removed: z.boolean(),
  cleanupPending: z.boolean(),
  localDirectory: localPathSchema.nullable(),
  code: errorCodeSchema.nullable(),
  message: errorMessageSchema.nullable(),
});
export type LocalCopyRemoveResultPayload = z.infer<typeof localCopyRemoveResultPayloadSchema>;

export const localCopyRemoveAckPayloadSchema = z.strictObject({
  operationId: z.uuid(),
  /** `closed`: recorded, forget it. `rejected`: not this agent's, or not known. Neither deletes anything. */
  outcome: z.enum(['closed', 'rejected']),
});
export type LocalCopyRemoveAckPayload = z.infer<typeof localCopyRemoveAckPayloadSchema>;

export const LOCAL_REMOVAL_SYNC_PHASES = ['checking', 'moving', 'removing', 'reported'] as const;

export const REMOVAL_INELIGIBLE_REASONS = [
  'agent_revoked',
  'agent_offline',
  'agent_cannot_remove',
  'no_local_copy',
  'vm_running',
  'operation_in_progress',
] as const;
export type RemovalIneligibleReason = (typeof REMOVAL_INELIGIBLE_REASONS)[number];

export const REMOVAL_INELIGIBLE_TEXT: Record<RemovalIneligibleReason, string> = {
  agent_revoked: 'This agent has been revoked.',
  agent_offline: 'This agent is offline.',
  agent_cannot_remove: 'This agent’s version cannot remove local copies. Update it.',
  no_local_copy: 'This agent holds no persistent copy of this VM.',
  vm_running:
    'This VM is running on this agent, or may be. Stop it, or dismiss the session, before removing its copy.',
  operation_in_progress: 'This agent, or this VM, is busy with another operation.',
};

/**
 * What an administrator asks for. `expectedVersionId` is what the page showed, so that a stale page
 * cannot remove a copy it did not show. `discardLocalChanges` is required when the copy is known to
 * differ. Confirmed with an explicit button; nothing is typed.
 */
export const createLocalCopyRemovalRequestSchema = z.strictObject({
  agentId: z.uuid(),
  emulatorType: emulatorTypeSchema,
  vmName: vmNameSchema,
  expectedVersionId: z.uuid().nullable(),
  discardLocalChanges: z.boolean(),
  /** Chosen by the browser, so that a repeated click or a retried request removes once. */
  requestId: z.uuid(),
});
export type CreateLocalCopyRemovalRequest = z.infer<typeof createLocalCopyRemovalRequestSchema>;

export const localCopyRemovalSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  agentName: z.string(),
  agentOnline: z.boolean(),
  emulatorType: emulatorTypeSchema,
  vmName: z.string(),
  expectedVersionId: z.uuid().nullable(),
  discardLocalChanges: z.boolean(),
  state: localRemovalStateSchema,
  /** Removed, and leftovers moved aside are still being deleted by the agent. */
  cleanupPending: z.boolean(),
  /** Where the copy was, as the agent reported it. Administrators only. */
  localDirectory: z.string().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  recovery: z.string().nullable(),
  requestedByDisplayName: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  finishedAt: timestampSchema.nullable(),
});
export type LocalCopyRemoval = z.infer<typeof localCopyRemovalSchema>;

export const localCopyRemovalListResponseSchema = z.object({
  removals: z.array(localCopyRemovalSchema),
});
export type LocalCopyRemovalListResponse = z.infer<typeof localCopyRemovalListResponseSchema>;

export const localCopyRemovalPathParamsSchema = z.strictObject({ operationId: z.uuid() });
export const localCopyRemovalListQuerySchema = z.object({
  agentId: z.uuid().optional(),
  emulatorType: emulatorTypeSchema.optional(),
  vmName: vmNameSchema.optional(),
});

// Deleting a snapshot.

export const VERSION_DELETION_STATES = ['deleting', 'deleted'] as const;
export const versionDeletionStateSchema = z.enum(VERSION_DELETION_STATES);
export type VersionDeletionState = z.infer<typeof versionDeletionStateSchema>;

/** Why a snapshot cannot be deleted now. The server checks each again under its locks. */
export const SNAPSHOT_DELETE_REFUSALS = [
  'master_cannot_be_deleted',
  'snapshot_has_descendants',
  'snapshot_in_use',
  'snapshot_installed',
  'repository_unavailable',
] as const;
export type SnapshotDeleteRefusal = (typeof SNAPSHOT_DELETE_REFUSALS)[number];

export const SNAPSHOT_DELETE_REFUSAL_TEXT: Record<SnapshotDeleteRefusal, string> = {
  master_cannot_be_deleted: 'The master is the root of every version, and is never deleted.',
  snapshot_has_descendants:
    'Other versions were created from this snapshot. Only a snapshot with no children can be deleted.',
  snapshot_in_use:
    'A restore, a session, a remote session, a verification or a snapshot is using this version. Wait for it to finish.',
  snapshot_installed:
    'An agent holds a persistent copy of this snapshot. Replace or remove that copy first.',
  repository_unavailable:
    'No online agent can reach this snapshot’s repository, so its archive cannot be deleted now.',
};

export const ARCHIVE_DELETE_OUTCOMES = ['deleted', 'absent', 'failed'] as const;

/**
 * Asks an agent to delete one version's archive. The agent derives the key from the VM and version itself
 * and refuses if it differs from `archiveKey`, so this can never name another object. An object of
 * another size is never deleted.
 */
export const archiveDeletePayloadSchema = z.strictObject({
  /** This attempt. A new one is issued for each attempt. */
  operationId: z.uuid(),
  versionId: z.uuid(),
  emulatorType: emulatorTypeSchema,
  vmName: vmNameSchema,
  repositoryId: z.uuid(),
  archiveKey: z.string().min(1).max(512),
  archiveSizeBytes: safeSizeSchema.positive(),
  archiveSha256: sha256HexSchema,
});
export type ArchiveDeletePayload = z.infer<typeof archiveDeletePayloadSchema>;

/** `deleted` and `absent` are only said once the agent has looked and found nothing at the key. */
export const archiveDeleteResultPayloadSchema = z.object({
  operationId: z.uuid(),
  versionId: z.uuid(),
  outcome: z.enum(ARCHIVE_DELETE_OUTCOMES),
  code: errorCodeSchema.nullable(),
  message: errorMessageSchema.nullable(),
});
export type ArchiveDeleteResultPayload = z.infer<typeof archiveDeleteResultPayloadSchema>;

/**
 * The confirmation names the exact immutable version ID, which must be the one in the path: a label can
 * repeat, an ID cannot.
 */
export const deleteSnapshotRequestSchema = z.strictObject({
  versionId: z.uuid(),
  /** Chosen by the browser, so that a repeated click finds the same deletion. */
  requestId: z.uuid(),
});
export type DeleteSnapshotRequest = z.infer<typeof deleteSnapshotRequestSchema>;

export const versionPathParamsSchema = z.strictObject({
  emulatorType: emulatorTypeSchema,
  vmName: vmNameSchema,
  versionId: z.uuid(),
});

export const versionDeletionSchema = z.object({
  versionId: z.uuid(),
  emulatorType: emulatorTypeSchema,
  vmName: z.string(),
  snapshotName: z.string().nullable(),
  parentVersionId: z.uuid().nullable(),
  repositoryName: z.string(),
  archiveSizeBytes: safeSizeSchema,
  archiveSha256: sha256HexSchema,
  versionCreatedAt: timestampSchema,
  state: versionDeletionStateSchema,
  /** `already_absent`: the repository had no archive at that key when first asked. */
  archiveOutcome: z.enum(['deleted', 'already_absent']).nullable(),
  attempts: z.number().int().nonnegative(),
  nextRetryAt: timestampSchema.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  requestedByDisplayName: z.string().nullable(),
  requestedAt: timestampSchema,
  completedAt: timestampSchema.nullable(),
});
export type VersionDeletion = z.infer<typeof versionDeletionSchema>;

export const versionDeletionListResponseSchema = z.object({
  deletions: z.array(versionDeletionSchema),
});
export type VersionDeletionListResponse = z.infer<typeof versionDeletionListResponseSchema>;

/** Whether a version can be deleted now, for the interface. The server decides again when asked. */
export const versionDeletabilitySchema = z.object({
  eligible: z.boolean(),
  reason: z.enum(SNAPSHOT_DELETE_REFUSALS).nullable(),
});
export type VersionDeletability = z.infer<typeof versionDeletabilitySchema>;

/** What every creator of a reference to a deleted, or deleting, version is refused with. */
export const VERSION_DELETED_TEXT =
  'This version has been deleted, or is being deleted, and can no longer be used.';
