import { z } from 'zod';
import { emulatorTypeSchema } from './emulator.js';
import { sha256HexSchema, timestampSchema } from './version.js';
import { vmNameSchema } from './vm-name.js';

/**
 * Copy keeps the local VM. Transfer removes it, only after a verified master is committed and every
 * local check has passed again. See decision 0015. Snapshot archives a registered VM again, as a new
 * immutable version whose parent is the version its local files came from. See decision 0037.
 */
export const REGISTRATION_MODES = ['copy', 'transfer', 'snapshot'] as const;
export const registrationModeSchema = z.enum(REGISTRATION_MODES);
export type RegistrationMode = z.infer<typeof registrationModeSchema>;

/** What a registration of an unregistered VM can be. Snapshots have their own request. */
export const MASTER_REGISTRATION_MODES = ['copy', 'transfer'] as const;

export const REGISTRATION_STATES = [
  'queued',
  'validating',
  'archiving',
  'uploading',
  'verifying',
  'committing',
  'cleaning_local',
  'succeeded',
  'failed',
  'cancelled',
  'partial_success',
] as const;
export const registrationStateSchema = z.enum(REGISTRATION_STATES);
export type RegistrationState = z.infer<typeof registrationStateSchema>;

export const REGISTRATION_TERMINAL_STATES: readonly RegistrationState[] = [
  'succeeded',
  'failed',
  'cancelled',
  'partial_success',
];

export function isRegistrationTerminal(state: RegistrationState): boolean {
  return REGISTRATION_TERMINAL_STATES.includes(state);
}

/** Whether the master exists. From here on, the operation cannot be cancelled or undone. */
export function isRegistrationCommitted(state: RegistrationState): boolean {
  return state === 'cleaning_local' || state === 'succeeded' || state === 'partial_success';
}

export const LOCAL_COPY_STATUSES = ['preserved', 'removed', 'cleanup_failed', 'unknown'] as const;
export const localCopyStatusSchema = z.enum(LOCAL_COPY_STATUSES);
export type LocalCopyStatus = z.infer<typeof localCopyStatusSchema>;

/** Every failure that has a code. Unknown codes from a newer agent are still shown, with their text. */
export const REGISTRATION_ERROR_CODES = [
  // From the agent's disk.
  'source_missing',
  'source_invalid',
  'source_unsafe',
  'source_changed',
  'source_in_use',
  'source_unreadable',
  'insufficient_staging_space',
  'staging_failed',
  'transfer_blocked_media',
  'transfer_blocked_running',
  'vm_running',
  // From the repository.
  'repository_not_configured',
  'repository_unreachable',
  'ssh_authentication_failed',
  'host_key_unknown',
  'host_key_changed',
  'repository_permission_denied',
  'insufficient_remote_space',
  'upload_interrupted',
  'remote_object_missing',
  'archive_exists',
  'publication_unsupported',
  'hash_mismatch',
  'repository_error',
  // From the workflow.
  'cancelled',
  'agent_restarted',
  'agent_busy',
  'agent_revoked',
  'agent_lost_operation',
  'invalid_request',
  'invalid_result',
  'duplicate_registration',
  'repository_not_authorized',
  'internal_error',
  // From snapshots.
  'snapshot_parent_mismatch',
  'snapshot_parent_unknown',
  'snapshot_lineage_unverified',
  'workspace_unavailable',
  // From local cleanup, after the master exists.
  'cleanup_identity_mismatch',
  'cleanup_content_changed',
  'cleanup_unsafe',
  'cleanup_in_use',
  'cleanup_incomplete',
  'cleanup_unreadable',
] as const;
export type RegistrationErrorCode = (typeof REGISTRATION_ERROR_CODES)[number];

const RECOVERY: Partial<Record<string, string>> = {
  source_missing: 'Run discovery again, and check that the VM is still in its directory.',
  source_invalid: 'Fix what the message describes, and run discovery again.',
  source_unsafe:
    'Links and junctions inside a VM are never followed. Replace them with real files and try again.',
  source_changed: 'Stop the VM, or whatever was changing its files, and try again.',
  source_in_use: 'Stop the VM, and try again.',
  source_unreadable: 'Check the permissions of the VM’s files, and try again.',
  insufficient_staging_space:
    'Free up space on the staging disk, or point storage.staging_dir at a larger one.',
  staging_failed: 'Check the agent’s staging directory, and try again.',
  transfer_blocked_running:
    'The VM was running, or may have been, so the local VM was kept. Stop it, then choose Retry removal.',
  vm_running: 'The VM is running. Stop it before registering it.',
  transfer_blocked_media:
    'Screenshots are not in the archive, and the server could not confirm that it holds all of them, so the local VM was kept. Check the VM’s Media page, and choose Retry removal once it is synchronized. A file that is not a supported image has to be moved out of the screenshots directory first. Copy never removes anything.',
  repository_not_configured:
    'Add this repository’s UUID to the agent’s configuration, and restart the agent.',
  repository_unreachable: 'Check that the SSH server is running and reachable, and try again.',
  ssh_authentication_failed: 'Install the agent’s public key on the SSH server.',
  host_key_unknown:
    'Check the server’s fingerprint out of band, then add it to the agent’s configuration.',
  host_key_changed:
    'Find out why the server’s key changed before trusting it. If the server was reinstalled, update the fingerprint in the agent’s configuration.',
  repository_permission_denied: 'Give the SSH account write access to the remote root.',
  insufficient_remote_space: 'Free up space on the repository, and try again.',
  upload_interrupted: 'Nothing was registered. It is safe to try again.',
  remote_object_missing: 'Nothing was registered. It is safe to try again.',
  archive_exists:
    'An archive already has this key, and archives are never overwritten. Start a new registration.',
  publication_unsupported:
    'The repository must support hard links through hardlink@openssh.com. See the repository guide.',
  hash_mismatch: 'Nothing was registered. Check the repository’s disk, and try again.',
  repository_error: 'Nothing was registered. Check the agent’s log, and try again.',
  cancelled: 'Nothing was registered, and the local VM is unchanged.',
  agent_restarted:
    'Nothing was registered, and the local VM is unchanged. It is safe to try again.',
  agent_busy: 'Wait for the agent’s other registration to finish.',
  agent_revoked: 'Pair the agent again to use it. The local VM is unchanged.',
  agent_lost_operation:
    'The agent no longer knows about this operation, for example because its state directory was removed. It is safe to try again.',
  invalid_request: 'Update the agent and the server to the same version.',
  invalid_result: 'Update the agent and the server to the same version.',
  duplicate_registration: 'This VM is already registered, with a different master.',
  repository_not_authorized: 'Associate this agent with the repository, and try again.',
  snapshot_parent_mismatch:
    'The local copy does not come from the version that was chosen as the parent. Reload the page, and choose the version the local copy came from.',
  snapshot_parent_unknown:
    'Nobody knows which version this local copy came from, so a snapshot could not say what it branches from. Restore a version, or verify the copy, first.',
  snapshot_lineage_unverified:
    'Nothing proves which version this directory came from: its record predates Milestone 7, or the directory was replaced. Nothing was published. If it is unchanged, verify the local copy, which records its lineage, and try again. Otherwise restore the version you want to change, or use Remote Snapshot.',
  workspace_unavailable:
    'The working copy is not on the agent any more. Prepare a new one from the version you want.',
  cleanup_identity_mismatch:
    'The master is registered and safe. The directory is no longer the one that was archived, so it was kept. Decide what to do with it yourself.',
  cleanup_content_changed:
    'The master is registered and safe. The local files differ from it, so they were kept. If you do not need the changes, delete the directory yourself.',
  cleanup_unsafe:
    'The master is registered and safe. A link appeared in the directory, so it was kept. Check it, and delete it yourself if it is not needed.',
  cleanup_in_use:
    'The master is registered and safe. A file is in use, so the directory was kept. Stop the VM and delete the directory yourself.',
  cleanup_incomplete:
    'The master is registered and safe. Deleting stopped partway. What remains can be deleted by hand.',
  cleanup_unreadable:
    'The master is registered and safe. The directory could not be checked, so it was kept.',
};

/** What an administrator can do about a failure. */
export function registrationRecovery(code: string): string | null {
  return RECOVERY[code] ?? null;
}

/** A transfer whose removal was refused for a reason that can pass: the agent kept its journal. */
export const RETRYABLE_CLEANUP_CODES = [
  'transfer_blocked_media',
  'transfer_blocked_running',
] as const;

export function isRetryableCleanup(code: string | null | undefined): boolean {
  return (RETRYABLE_CLEANUP_CODES as readonly string[]).includes(code ?? '');
}

const safeSizeSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const errorCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/)
  .max(64);
const errorMessageSchema = z.string().max(1024);

// The protocol.

/** A command, holding no path and no address. The agent refuses a request with any other field. */
export const registrationRequestPayloadSchema = z
  .strictObject({
    operationId: z.uuid(),
    emulatorType: emulatorTypeSchema,
    vmName: vmNameSchema,
    mode: registrationModeSchema,
    repositoryId: z.uuid(),
    versionId: z.uuid(),
    archiveKey: z.string().min(1).max(512),
    /** A snapshot's parent. The agent refuses one its own local state contradicts. */
    parentVersionId: z.uuid().optional(),
    /** A snapshot of a Remote Snapshot working copy, rather than of the persistent local VM. */
    workspaceId: z.uuid().optional(),
  })
  .refine((request) => (request.mode === 'snapshot') === (request.parentVersionId !== undefined), {
    message: 'A snapshot names its parent, and nothing else does',
    path: ['parentVersionId'],
  })
  .refine((request) => request.workspaceId === undefined || request.mode === 'snapshot', {
    message: 'Only a snapshot reads a working copy',
    path: ['workspaceId'],
  });
export type RegistrationRequestPayload = z.infer<typeof registrationRequestPayloadSchema>;

export const registrationCancelPayloadSchema = z.strictObject({ operationId: z.uuid() });
export type RegistrationCancelPayload = z.infer<typeof registrationCancelPayloadSchema>;

export const REGISTRATION_ACK_OUTCOMES = ['committed', 'rejected', 'closed'] as const;
export const registrationAckPayloadSchema = z.strictObject({
  operationId: z.uuid(),
  outcome: z.enum(REGISTRATION_ACK_OUTCOMES),
  versionId: z.uuid().nullable().optional(),
  /** May the local copy be removed now? The agent also checks this against the mode it was given. */
  removeLocal: z.boolean().optional(),
  /** The published archive is referenced by nothing, and never will be. */
  deletePublished: z.boolean().optional(),
});
export type RegistrationAckPayload = z.infer<typeof registrationAckPayloadSchema>;

export const repositoryHealthRequestPayloadSchema = z.strictObject({
  operationId: z.uuid(),
  repositoryId: z.uuid(),
});
export type RepositoryHealthRequestPayload = z.infer<typeof repositoryHealthRequestPayloadSchema>;

/**
 * An administrator asks to try removing a local VM again, after its removal was blocked by a screenshot
 * that had not been preserved. The agent checks everything again, as it did the first time.
 */
export const registrationRetryCleanupPayloadSchema = z.strictObject({
  operationId: z.uuid(),
  versionId: z.uuid(),
});
export type RegistrationRetryCleanupPayload = z.infer<typeof registrationRetryCleanupPayloadSchema>;

export const REGISTRATION_SYNC_PHASES = [
  'running',
  'publishing',
  'published',
  'cleaning',
  'reported',
  // A transfer's master exists, its removal was blocked by a screenshot, and the agent is keeping what
  // it needs to try again if an administrator asks.
  'media_blocked',
] as const;

/** What an agent has in its journals. Sent after each welcome, and shows that it can register VMs. */
export const registrationSyncPayloadSchema = z.object({
  operations: z
    .array(z.object({ operationId: z.uuid(), phase: z.enum(REGISTRATION_SYNC_PHASES) }))
    .max(256),
  /** Whether this agent can create snapshots. Older agents do not say, and are not asked to. */
  snapshots: z.boolean().optional(),
});
export type RegistrationSyncPayload = z.infer<typeof registrationSyncPayloadSchema>;

export const REGISTRATION_STAGES = [
  'validating',
  'archiving',
  'uploading',
  'verifying',
  'cleaning_local',
] as const;

export const registrationProgressPayloadSchema = z.object({
  operationId: z.uuid(),
  stage: z.enum(REGISTRATION_STAGES),
  doneBytes: safeSizeSchema.nullable(),
  totalBytes: safeSizeSchema.nullable(),
});
export type RegistrationProgressPayload = z.infer<typeof registrationProgressPayloadSchema>;

/** A report of what the agent verified. It authorizes nothing by itself. */
export const registrationResultPayloadSchema = z.object({
  operationId: z.uuid(),
  versionId: z.uuid(),
  archiveKey: z.string().min(1).max(512),
  archiveSizeBytes: safeSizeSchema.positive(),
  archiveSha256: sha256HexSchema,
  manifestVersion: z.number().int().positive(),
  manifestSha256: sha256HexSchema,
  fileCount: safeSizeSchema,
  totalUncompressedBytes: safeSizeSchema,
});
export type RegistrationResultPayload = z.infer<typeof registrationResultPayloadSchema>;

export const registrationErrorPayloadSchema = z.object({
  operationId: z.uuid(),
  code: errorCodeSchema,
  message: errorMessageSchema,
});
export type RegistrationErrorPayload = z.infer<typeof registrationErrorPayloadSchema>;

export const registrationCleanupPayloadSchema = z.object({
  operationId: z.uuid(),
  versionId: z.uuid(),
  localCopy: z.enum(['preserved', 'removed', 'cleanup_failed']),
  code: errorCodeSchema.nullable(),
  message: errorMessageSchema.nullable(),
});
export type RegistrationCleanupPayload = z.infer<typeof registrationCleanupPayloadSchema>;

// Repositories.

const REMOTE_ROOT = /^\/(?:[^/\\\0]+(?:\/[^/\\\0]+)*\/?)?$/;

export const REPOSITORY_PROVIDERS = ['sftp'] as const;

export const repositoryConfigSchema = z.object({
  host: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9.:_-]+$/, 'Use a host name or address'),
  port: z.number().int().min(1).max(65535),
  username: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/, 'Use letters, digits, ".", "_" and "-"'),
  remoteRoot: z
    .string()
    .min(1)
    .max(255)
    .regex(REMOTE_ROOT, 'Use an absolute path on the server')
    .refine((value) => !value.split('/').includes('..'), 'A remote root cannot contain ".."'),
});
export type RepositoryConfig = z.infer<typeof repositoryConfigSchema>;

/** Connection details and nothing else. A private key never travels through the server. */
export const saveRepositoryRequestSchema = repositoryConfigSchema
  .extend({ name: z.string().trim().min(1).max(128) })
  .strict();
export type SaveRepositoryRequest = z.infer<typeof saveRepositoryRequestSchema>;

export const repositoryHealthResultPayloadSchema = z.object({
  operationId: z.uuid(),
  repositoryId: z.uuid(),
  ok: z.boolean(),
  code: errorCodeSchema.nullable(),
  message: errorMessageSchema.nullable(),
  configuration: repositoryConfigSchema.nullable(),
  hostKeyFingerprint: z.string().max(128).nullable(),
  freeBytes: safeSizeSchema.nullable(),
});
export type RepositoryHealthResultPayload = z.infer<typeof repositoryHealthResultPayloadSchema>;

export const REPOSITORY_STATUSES = ['unchecked', 'healthy', 'failing'] as const;

export const repositoryAgentSchema = z.object({
  agentId: z.uuid(),
  agentName: z.string(),
  online: z.boolean(),
  revoked: z.boolean(),
  checkInProgress: z.boolean(),
  lastCheckedAt: timestampSchema.nullable(),
  lastSuccessAt: timestampSchema.nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  hostKeyFingerprint: z.string().nullable(),
  freeBytes: safeSizeSchema.nullable(),
});
export type RepositoryAgent = z.infer<typeof repositoryAgentSchema>;

export const repositorySummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  provider: z.enum(REPOSITORY_PROVIDERS),
  host: z.string(),
  port: z.number().int(),
  username: z.string(),
  remoteRoot: z.string(),
  enabled: z.boolean(),
  status: z.enum(REPOSITORY_STATUSES),
  lastSuccessfulCheckAt: timestampSchema.nullable(),
  agents: z.array(repositoryAgentSchema),
  /** Problems found by the most recent checks, as text for an administrator. */
  configurationErrors: z.array(z.string()),
});
export type RepositorySummary = z.infer<typeof repositorySummarySchema>;

export const repositoryListResponseSchema = z.object({
  repositories: z.array(repositorySummarySchema),
});
export type RepositoryListResponse = z.infer<typeof repositoryListResponseSchema>;

export const repositoryPathParamsSchema = z.object({ repositoryId: z.uuid() });
export const repositoryAgentPathParamsSchema = z.object({
  repositoryId: z.uuid(),
  agentId: z.uuid(),
});

// What an administrator asks for, and sees.

/**
 * Names a VM by its identity and a discovery that found it. It can never say where the VM is, or
 * where the repository is. A transfer needs its own explicit confirmation.
 */
export const createRegistrationRequestSchema = z
  .strictObject({
    agentId: z.uuid(),
    repositoryId: z.uuid(),
    emulatorType: emulatorTypeSchema,
    vmName: vmNameSchema,
    mode: z.enum(MASTER_REGISTRATION_MODES),
    discoveryOperationId: z.uuid(),
    confirmDestructive: z.boolean().optional(),
  })
  .refine((request) => request.mode !== 'transfer' || request.confirmDestructive === true, {
    message: 'A transfer deletes the local VM, and has to be confirmed',
    path: ['confirmDestructive'],
  });
export type CreateRegistrationRequest = z.infer<typeof createRegistrationRequestSchema>;

export const registrationOperationSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  agentName: z.string(),
  agentOnline: z.boolean(),
  repositoryId: z.uuid(),
  repositoryName: z.string(),
  emulatorType: emulatorTypeSchema,
  vmName: z.string(),
  mode: registrationModeSchema,
  state: registrationStateSchema,
  versionId: z.uuid(),
  /** A snapshot's parent and name. Both `null` for a master. */
  parentVersionId: z.uuid().nullable(),
  snapshotName: z.string().nullable(),
  /** Set when a snapshot preserves a Remote Snapshot working copy. */
  workspaceId: z.uuid().nullable(),
  archiveKey: z.string(),
  progress: z.object({
    doneBytes: safeSizeSchema.nullable(),
    totalBytes: safeSizeSchema.nullable(),
  }),
  /** Filled in once the agent has reported what it verified. The server has not read the archive. */
  archive: z
    .object({
      sizeBytes: safeSizeSchema,
      sha256: sha256HexSchema,
      manifestVersion: z.number().int(),
      manifestSha256: sha256HexSchema,
      fileCount: safeSizeSchema,
      totalUncompressedBytes: safeSizeSchema,
      verifiedBy: z.literal('agent'),
    })
    .nullable(),
  localCopy: localCopyStatusSchema.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  recovery: z.string().nullable(),
  cancelRequested: z.boolean(),
  requestedByDisplayName: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  committedAt: timestampSchema.nullable(),
  finishedAt: timestampSchema.nullable(),
});
export type RegistrationOperation = z.infer<typeof registrationOperationSchema>;

export const registrationListResponseSchema = z.object({
  operations: z.array(registrationOperationSchema),
});
export type RegistrationListResponse = z.infer<typeof registrationListResponseSchema>;

export const registrationPathParamsSchema = z.object({ operationId: z.uuid() });
export const registrationListQuerySchema = z.object({ agentId: z.uuid().optional() });
