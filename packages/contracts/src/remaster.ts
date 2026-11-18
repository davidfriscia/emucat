import { z } from 'zod';
import { emulatorTypeSchema } from './emulator.js';
import { registrationStateSchema } from './registration.js';
import { sha256HexSchema, timestampSchema } from './version.js';
import { versionKindSchema } from './versions.js';

/**
 * Master and snapshot lifecycle (decision 0048): a version's title and description, promoting a snapshot to
 * master, and replacing a VM's whole history with a new master made from a local copy. Administrators only, like
 * everything that knows about versions (decision 0039).
 */

const safeSizeSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

// The version graph.

/**
 * What a remaster keeps and removes, by lineage alone: the chosen version and everything descending from it are
 * kept, everything else goes. Creation times play no part. `null` when the version is not among the nodes, or the
 * nodes do not form one tree (a parent missing, a cycle, several roots).
 */
export function remasterPlan(
  nodes: readonly { id: string; parentVersionId: string | null }[],
  versionId: string,
): { retained: string[]; removed: string[] } | null {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (!byId.has(versionId) || byId.size !== nodes.length) return null;
  const roots = nodes.filter((node) => node.parentVersionId === null);
  if (roots.length !== 1) return null;
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentVersionId === null) continue;
    if (!byId.has(node.parentVersionId)) return null;
    children.set(node.parentVersionId, [...(children.get(node.parentVersionId) ?? []), node.id]);
  }
  // Every node must be reachable from the root, or there is a cycle.
  const reachable = new Set<string>();
  const stack = [roots[0]?.id as string];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (reachable.has(id)) return null;
    reachable.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  if (reachable.size !== nodes.length) return null;
  const retained = new Set<string>();
  const pending = [versionId];
  while (pending.length > 0) {
    const id = pending.pop() as string;
    retained.add(id);
    pending.push(...(children.get(id) ?? []));
  }
  return {
    retained: nodes.filter((node) => retained.has(node.id)).map((node) => node.id),
    removed: nodes.filter((node) => !retained.has(node.id)).map((node) => node.id),
  };
}

// Refusals.

export const REMASTER_REFUSALS = [
  'version_is_master',
  'version_deleted',
  'version_history_stale',
  'version_history_inconsistent',
  'archive_integrity_invalid',
  'remaster_in_progress',
  'operation_in_progress',
  'version_in_use',
  'source_lineage_conflict',
  'agent_offline',
  'agent_cannot_remaster',
  'local_source_missing',
  'source_not_exportable',
  'vm_running',
  'repository_unavailable',
  'confirmation_mismatch',
] as const;
export const remasterRefusalSchema = z.enum(REMASTER_REFUSALS);
export type RemasterRefusal = z.infer<typeof remasterRefusalSchema>;

export const REMASTER_REFUSAL_TEXT: Record<RemasterRefusal, string> = {
  version_is_master: 'This version is already the master.',
  version_deleted: 'This version has been deleted, or is being deleted.',
  version_history_stale:
    'The version history changed since this page showed it. Look at the new history, and confirm again.',
  version_history_inconsistent:
    'This VM’s version history is not a single tree with one master, so nothing can be promoted safely.',
  archive_integrity_invalid:
    'A version that would be kept has no valid archive size or SHA-256, so it could not be verified later.',
  remaster_in_progress: 'This VM is being remastered. Wait for that to finish.',
  operation_in_progress:
    'A snapshot, registration, import or other operation of this VM, or of this agent, is in progress. Wait for it to finish.',
  version_in_use:
    'A restore, a session, a remote session, a verification or a removal is using a version that would be removed. Wait for it to finish.',
  source_lineage_conflict:
    'An agent holds a copy of a version that would be removed. Confirm that it may be kept as it is: it will need a restore before its next snapshot.',
  agent_offline: 'This agent is offline.',
  agent_cannot_remaster:
    'This agent cannot export this VM: update it, or configure the emulator on it.',
  local_source_missing:
    'This agent holds no local copy of this VM, or VirtualBox there does not list the linked machine.',
  source_not_exportable:
    'The local copy is not in a state that can be exported: it must be idle (a VirtualBox machine powered off, and readable).',
  vm_running: 'This VM is running on this agent, or may be. Stop it first.',
  repository_unavailable:
    'This VM’s repository is disabled, or this agent may not use it, so a new master cannot be stored there.',
  confirmation_mismatch: 'The name typed does not match this VM’s name exactly.',
};

/** Every error a remaster request can answer with, besides `version_not_found` and the usual ones. */
export const REMASTER_ERROR_CODES = [
  ...REMASTER_REFUSALS,
  'version_not_found',
  'request_id_reused',
] as const;

// Previews.

/** A version as a remaster preview names it: by its ID, its label and its title, never only by a date. */
export const remasterVersionSchema = z.object({
  id: z.uuid(),
  kind: versionKindSchema,
  parentVersionId: z.uuid().nullable(),
  snapshotName: z.string().nullable(),
  title: z.string().nullable(),
  createdAt: timestampSchema,
  archiveSizeBytes: safeSizeSchema,
});
export type RemasterVersion = z.infer<typeof remasterVersionSchema>;

/**
 * A copy that comes from a version that would be removed. It is kept exactly as it is: it can still run, be
 * restored over or removed, but no snapshot can name a removed version as its parent, so it needs a restore (or,
 * for VirtualBox, an import and relink) before its next snapshot.
 */
export const remasterLineageConflictSchema = z.object({
  agentId: z.uuid(),
  agentName: z.string(),
  versionId: z.uuid(),
  versionLabel: z.string(),
});
export type RemasterLineageConflict = z.infer<typeof remasterLineageConflictSchema>;

export const REMASTER_KINDS = ['snapshot', 'local_copy'] as const;
export const remasterKindSchema = z.enum(REMASTER_KINDS);
export type RemasterKind = z.infer<typeof remasterKindSchema>;

export const remasterPreviewSchema = z.object({
  kind: remasterKindSchema,
  emulatorType: emulatorTypeSchema,
  vmName: z.string(),
  /** The version history this preview describes. A request must name it, or is refused as stale. */
  revision: sha256HexSchema,
  currentMaster: remasterVersionSchema,
  /** The snapshot that would become the master. `null` for a remaster from a local copy. */
  promoted: remasterVersionSchema.nullable(),
  /** Kept, oldest first: the promoted snapshot and its descendants. Empty for a local copy: all is replaced. */
  retained: z.array(remasterVersionSchema),
  /** Removed, archives included, oldest first. Always includes the current master. */
  removed: z.array(remasterVersionSchema),
  removedBytes: safeSizeSchema,
  /** The local copy that would be exported. `null` for a promotion. */
  source: z
    .object({
      agentId: z.uuid(),
      agentName: z.string(),
      online: z.boolean(),
      /** The directory's name, or the VirtualBox machine's name. */
      sourceName: z.string(),
      machineUuid: z.string().nullable(),
      /** The version the copy was last known to come from, when known. */
      localSourceVersionId: z.uuid().nullable(),
      contentStatus: z.enum(['unverified', 'verified', 'modified']).nullable(),
    })
    .nullable(),
  lineageConflicts: z.array(remasterLineageConflictSchema),
  /** Whether an online agent can delete the obsolete archives now. If not, cleanup waits for one. */
  cleanupAvailable: z.boolean(),
  /** Why the remaster cannot be confirmed now, or `null`. The server decides again when asked. */
  refusal: z.object({ code: remasterRefusalSchema, message: z.string() }).nullable(),
});
export type RemasterPreview = z.infer<typeof remasterPreviewSchema>;

export const localRemasterPreviewQuerySchema = z.strictObject({ agentId: z.uuid() });

// Requests.

export const promoteSnapshotRequestSchema = z.strictObject({
  /** Chosen by the browser, so that a repeated click promotes once. */
  requestId: z.uuid(),
  /** The preview's revision: a history changed since is refused, never remastered. */
  expectedRevision: sha256HexSchema,
  /** Required when the preview listed lineage conflicts. */
  acknowledgeLineageConflicts: z.boolean().optional(),
});
export type PromoteSnapshotRequest = z.infer<typeof promoteSnapshotRequestSchema>;

export const localRemasterRequestSchema = z.strictObject({
  agentId: z.uuid(),
  requestId: z.uuid(),
  expectedRevision: sha256HexSchema,
  /** The VM's catalog name, typed again, exactly. */
  confirmVmName: z.string().min(1).max(64),
  acknowledgeLineageConflicts: z.boolean().optional(),
});
export type LocalRemasterRequest = z.infer<typeof localRemasterRequestSchema>;

// Operations.

/** `exporting` until a new master from a local copy is committed; `cleaning` while obsolete archives remain. */
export const REMASTER_STATES = ['exporting', 'cleaning', 'completed', 'failed'] as const;
export const remasterStateSchema = z.enum(REMASTER_STATES);
export type RemasterState = z.infer<typeof remasterStateSchema>;

/** What an administrator is shown: the step the remaster is at, from its own state and its registration's. */
export const REMASTER_PHASES = [
  'exporting',
  'uploading',
  'verifying',
  'committing',
  'cleaning',
  'completed',
  'failed',
] as const;
export const remasterPhaseSchema = z.enum(REMASTER_PHASES);
export type RemasterPhase = z.infer<typeof remasterPhaseSchema>;

export const REMASTER_PHASE_LABELS: Record<RemasterPhase, string> = {
  exporting: 'Exporting',
  uploading: 'Uploading',
  verifying: 'Verifying',
  committing: 'Committing new master',
  cleaning: 'Cleaning obsolete archives',
  completed: 'Completed',
  failed: 'Failed',
};

/** The step a remaster is at. A remaster is complete only once every obsolete archive is gone. */
export function remasterPhase(
  state: RemasterState,
  registrationState: z.infer<typeof registrationStateSchema> | null,
): RemasterPhase {
  if (state !== 'exporting') return state;
  switch (registrationState) {
    case 'uploading':
      return 'uploading';
    case 'verifying':
      return 'verifying';
    case 'committing':
    case 'cleaning_local':
      return 'committing';
    default:
      return 'exporting';
  }
}

export const remasterCleanupItemSchema = z.object({
  versionId: z.uuid(),
  label: z.string(),
  state: z.enum(['deleting', 'deleted']),
  archiveOutcome: z.enum(['deleted', 'already_absent']).nullable(),
  attempts: z.number().int().nonnegative(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type RemasterCleanupItem = z.infer<typeof remasterCleanupItemSchema>;

export const remasterOperationSchema = z.object({
  id: z.uuid(),
  kind: remasterKindSchema,
  emulatorType: emulatorTypeSchema,
  vmName: z.string(),
  state: remasterStateSchema,
  phase: remasterPhaseSchema,
  previousMasterVersionId: z.uuid(),
  newMasterVersionId: z.uuid().nullable(),
  agentId: z.uuid().nullable(),
  agentName: z.string().nullable(),
  registrationOperationId: z.uuid().nullable(),
  progress: z.object({
    doneBytes: safeSizeSchema.nullable(),
    totalBytes: safeSizeSchema.nullable(),
  }),
  retainedCount: z.number().int().nonnegative(),
  removedCount: z.number().int().nonnegative(),
  removedBytes: safeSizeSchema,
  /** The deletion manifest, and how far it has got. `complete` only once every archive is confirmed gone. */
  cleanup: z.object({
    total: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative(),
    complete: z.boolean(),
    items: z.array(remasterCleanupItemSchema),
  }),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  requestedByDisplayName: z.string().nullable(),
  createdAt: timestampSchema,
  committedAt: timestampSchema.nullable(),
  finishedAt: timestampSchema.nullable(),
});
export type RemasterOperation = z.infer<typeof remasterOperationSchema>;

export const remasterListResponseSchema = z.object({ remasters: z.array(remasterOperationSchema) });
export type RemasterListResponse = z.infer<typeof remasterListResponseSchema>;

export const remasterPathParamsSchema = z.strictObject({ remasterId: z.uuid() });
